"""Song routes: upload / delete / metadata (user-meta, overrides, catalog meta
write-back), gap-fill proposals, and the per-song info payload.

Extracted verbatim from server.py (R3) except @app->@router and the seam reads:
meta_db->appstate.meta_db, and the scan/ingest helpers that stay in server.py
(the scan lifecycle owns them) -> appstate.<callable>: kick_scan,
invalidate_song_caches, stat_for_cache, scan_status() (a getter — the underlying
dict is reassigned), plus art_override_paths. The gap-fill MBID/ISRC regexes live
in lib/enrichment.py and are reached as enrichment.X.
"""

import os
import shutil
import tempfile
import threading
from pathlib import Path

from fastapi import APIRouter, Request, UploadFile
from fastapi.responses import JSONResponse
from starlette.concurrency import run_in_threadpool

import appstate
import enrichment
import loosefolder as loosefolder_mod
import sloppak as sloppak_mod
from dlc_paths import _get_dlc_dir, _resolve_dlc_path
from scan_worker import _extract_meta_for_file

import logging
log = logging.getLogger("feedBack.server")
router = APIRouter()

_ALLOWED_SONG_EXTS = set(sloppak_mod.SONG_EXTS)

_MAX_UPLOAD_BYTES = 1024 * 1024 * 1024  # 1 GB — covers sloppaks bundled with stems


# Per-request batch cap. Lets a user drop a whole album of sloppaks at once
# without giving a hostile client a 1000-file DoS surface via Starlette's
# default max_files=1000. The pre-parse Content-Length guard is sized as
# _MAX_UPLOAD_FILES * _MAX_UPLOAD_BYTES + slack.
_MAX_UPLOAD_FILES = 50


# Serializes the mutating step of upload (os.replace into DLC_DIR) with
# delete_song so the two endpoints can't interleave on the same path —
# e.g. an upload finishing right after a concurrent delete shouldn't
# resurrect a song the user just removed, and a delete arriving mid-
# overwrite shouldn't strand a half-written file. threading.Lock (not
# asyncio.Lock) because delete_song is sync (runs in the threadpool);
# upload acquires it inside ``run_in_threadpool`` for the same reason.
_song_io_lock = threading.Lock()


def _commit_uploaded_song(tmp_path: Path, dest: Path, overwrite: bool, base: str):
    """Atomically move a validated temp upload into ``dest`` under ``_song_io_lock``.

    Returns ``None`` on success or an error result dict matching the upload
    endpoint's contract. Holds the lock across the directory re-check and
    the final ``os.replace`` so a concurrent delete or upload can't slip
    between them. Always cleans up the temp file on the error paths.
    """
    with _song_io_lock:
        if dest.exists():
            if not overwrite:
                # Lost the race against a concurrent upload of the same name.
                try:
                    tmp_path.unlink()
                except OSError:
                    pass
                return {"status": "exists", "filename": base,
                        "error": "A file with this name already exists"}
            # Re-check directory state under the lock — the pre-check
            # may have raced an unrelated mkdir, and a sloppak directory
            # has to be removed before os.replace() can write over it.
            if dest.is_dir():
                if not sloppak_mod.is_sloppak(dest):
                    try:
                        tmp_path.unlink()
                    except OSError:
                        pass
                    return {"status": "exists", "filename": base,
                            "error": "A directory with this name exists and is not "
                                     "a sloppak — refusing to overwrite"}
                shutil.rmtree(str(dest))
        os.replace(str(tmp_path), str(dest))
    return None


@router.post("/api/songs/upload")
async def upload_song(request: Request):
    """Upload one or more .sloppak files into the configured DLC folder.

    Multipart body with one or more ``file`` fields (up to ``_MAX_UPLOAD_FILES``
    per request). Query string:
      ``overwrite=1`` — replace existing files with the same name.

    Response shape (always HTTP 200 once we've gotten past request-level guards
    like DLC-not-configured / payload-too-large):
      ``{"results": [{"filename": "...", "status": "ok" | "exists" | "error",
                       "error"?: "...", "size"?: N, "format"?: "sloppak"}, ...]}``
    Per-file conflicts surface as ``status: "exists"`` so a batch upload can
    surface ALL conflicts at once instead of bailing on the first one. The
    client re-POSTs just the conflicting files with ``overwrite=1`` if the
    user opts in.

    The DLC directory is resolved via ``_get_dlc_dir()`` which honours the
    ``DLC_DIR`` env var first and falls back to ``dlc_dir`` in
    ``config.json`` — so uploads land in whichever folder the rest of the
    app already considers the library root, regardless of which mechanism
    configured it.
    """
    dlc = _get_dlc_dir()
    if dlc is None:
        return JSONResponse(
            {"error": "DLC folder is not configured. Set DLC_DIR or configure it in Settings."},
            status_code=503,
        )
    if not os.access(str(dlc), os.W_OK):
        return JSONResponse(
            {"error": f"DLC folder {dlc} is not writable by the server process."},
            status_code=500,
        )

    # Pre-parse Content-Length guard — fail fast before reading any body.
    # Multipart Content-Length is file bytes + boundary + per-part headers, so
    # we can't use _MAX_UPLOAD_BYTES as an exact cap here (a file right at the
    # advertised max would be rejected before _save_uploaded_song() can apply
    # the real per-file byte cap). For batch uploads we allow up to
    # _MAX_UPLOAD_FILES files at _MAX_UPLOAD_BYTES each; the parser still
    # enforces per-part size via max_part_size and per-batch count via
    # max_files. The streaming check inside _save_uploaded_song() is the
    # authoritative per-file size cap.
    max_total = _MAX_UPLOAD_FILES * _MAX_UPLOAD_BYTES + enrichment._MULTIPART_OVERHEAD_SLACK
    cl = request.headers.get("content-length")
    if cl is not None:
        try:
            cl_int = int(cl)
        except ValueError:
            return JSONResponse({"error": "Invalid Content-Length header"}, status_code=400)
        if cl_int < 0:
            return JSONResponse({"error": "Invalid Content-Length header"}, status_code=400)
        if cl_int > max_total:
            return JSONResponse(
                {"error": f"Batch upload exceeds {_MAX_UPLOAD_FILES} files × "
                          f"{_MAX_UPLOAD_BYTES // (1024 * 1024)} MB limit"},
                status_code=413,
            )

    overwrite = request.query_params.get("overwrite") == "1"
    # Tighten the parser to the handler's contract: up to _MAX_UPLOAD_FILES
    # file parts, no text parts (overwrite comes from query params).
    # Starlette's defaults of max_files=1000 / max_fields=1000 would
    # otherwise let a client force the parser to spool far more parts than
    # the endpoint is willing to process.
    form = await request.form(
        max_files=_MAX_UPLOAD_FILES,
        max_fields=0,
        max_part_size=_MAX_UPLOAD_BYTES,
    )
    try:
        from starlette.datastructures import UploadFile as _StarletteUploadFile
        # form.getlist("file") returns all parts named "file" in submission
        # order. Filter to file parts only — Starlette would yield strings
        # for text parts, but we've capped max_fields=0 so any non-file part
        # is already a parser error before reaching here.
        uploads = [u for u in form.getlist("file") if isinstance(u, _StarletteUploadFile)]
        if not uploads:
            return JSONResponse(
                {"error": "Expected one or more files in multipart field 'file'"},
                status_code=400,
            )

        results = []
        any_saved = False
        for upload in uploads:
            try:
                result = await _save_uploaded_song(upload, dlc, overwrite)
                results.append(result)
                if result.get("status") == "ok":
                    any_saved = True
            except Exception as e:
                # Per-file failure must not abort the batch — record and
                # continue so the client gets a complete report.
                log.exception("upload failed for %r", getattr(upload, "filename", "?"))
                results.append({
                    "filename": Path(getattr(upload, "filename", "") or "").name or "?",
                    "status": "error",
                    "error": f"Upload failed: {e}",
                })
            finally:
                try:
                    await upload.close()
                except Exception:
                    log.debug("failed to close upload file handle", exc_info=True)

        if any_saved:
            appstate.kick_scan()
        return {"results": results}
    finally:
        try:
            await form.close()
        except Exception:
            log.debug("failed to close form", exc_info=True)


async def _save_uploaded_song(upload: UploadFile, dlc: Path, overwrite: bool) -> dict:
    """Save one upload into ``dlc``. Returns a per-file result dict (never
    a JSONResponse) so batch uploads can aggregate.

    Shape:
      ok:     ``{"status": "ok", "filename": base, "size": N, "format": "sloppak"}``
      exists: ``{"status": "exists", "filename": base, "error": "..."}``
      error:  ``{"status": "error", "filename": base, "error": "..."}``
    """
    # Strip any path components a client may have included in the filename —
    # only the basename lands in the DLC root. Path traversal would otherwise
    # let a crafted upload escape the library directory.
    raw_name = upload.filename or ""
    base = Path(raw_name).name
    if not base or base in (".", "..") or "/" in base or "\\" in base:
        return {"status": "error", "filename": raw_name or "?", "error": "Invalid filename"}
    suffix = Path(base).suffix.lower()
    if suffix not in _ALLOWED_SONG_EXTS:
        return {"status": "error", "filename": base,
                "error": "Only .feedpak files are accepted"}

    dest = dlc / base
    if dest.exists():
        if not overwrite:
            return {"status": "exists", "filename": base,
                    "error": "A file with this name already exists"}
        # overwrite=1 must handle directory-form sloppaks (the scanner and
        # delete path both treat them as song entries). os.replace() can't
        # clobber a non-empty directory, so without the rmtree below the
        # whole upload would write to a temp file and then surface a late
        # 500 at the os.replace() call. Refuse other directories so an
        # unrelated folder isn't blown away by a same-named upload.
        if dest.is_dir() and not sloppak_mod.is_sloppak(dest):
            return {"status": "exists", "filename": base,
                    "error": "A directory with this name exists and is not a sloppak — "
                             "refusing to overwrite"}

    # Temp file in the DLC dir itself so os.replace is atomic (same filesystem).
    # Dot-prefix keeps it out of the rglob("*.sloppak") scan glob.
    fd, tmp_name = await run_in_threadpool(
        tempfile.mkstemp, dir=str(dlc), prefix=".upload-", suffix=".part"
    )
    tmp_path = Path(tmp_name)
    bytes_read = 0
    head = b""
    error_result: dict | None = None
    try:
        try:
            tmpf = await run_in_threadpool(os.fdopen, fd, "wb")
        except BaseException:
            try:
                await run_in_threadpool(os.close, fd)
            except OSError:
                pass
            raise
        try:
            while True:
                chunk = await upload.read(1024 * 1024)
                if not chunk:
                    break
                bytes_read += len(chunk)
                if bytes_read > _MAX_UPLOAD_BYTES:
                    error_result = {
                        "status": "error", "filename": base,
                        "error": f"Upload exceeds {_MAX_UPLOAD_BYTES // (1024 * 1024)} MB cap",
                    }
                    break
                if len(head) < 4:
                    head += chunk[: 4 - len(head)]
                await run_in_threadpool(tmpf.write, chunk)
        finally:
            await run_in_threadpool(tmpf.close)

        if error_result is None:
            if bytes_read == 0:
                error_result = {"status": "error", "filename": base,
                                "error": "Empty upload — file is 0 bytes"}
            elif suffix in _ALLOWED_SONG_EXTS:
                if head[:2] != b"PK":
                    error_result = {"status": "error", "filename": base,
                                    "error": "Not a valid feedpak file (expected zip archive)"}
                else:
                    # ZIP magic alone admits any renamed zip — verify the sloppak
                    # loader can actually parse a manifest.yaml inside. Without
                    # this, /api/songs/upload returns "ok" for files the rest of
                    # the backend would refuse to scan or load.
                    try:
                        await run_in_threadpool(sloppak_mod.load_manifest, tmp_path)
                    except Exception as e:
                        error_result = {"status": "error", "filename": base,
                                        "error": f"Not a valid sloppak file: {e}"}

        if error_result is not None:
            try:
                await run_in_threadpool(tmp_path.unlink)
            except OSError:
                pass
            return error_result

        # Single sync helper so the lock is held for the whole commit —
        # ``async with _upload_lock`` would have released between every
        # ``run_in_threadpool`` and let a concurrent delete or upload slip
        # in between the dir check and the final ``os.replace``.
        commit_result = await run_in_threadpool(
            _commit_uploaded_song, tmp_path, dest, overwrite, base
        )
        if commit_result is not None:
            return commit_result
    except BaseException:
        try:
            await run_in_threadpool(tmp_path.unlink)
        except OSError:
            pass
        raise

    # Even on a fresh (non-overwrite) upload, evict any stale entries left
    # over from a previous delete+re-upload of the same name.
    await run_in_threadpool(appstate.invalidate_song_caches, base)

    log.info("Uploaded %s (%d bytes) to %s", base, bytes_read, dlc)
    return {"status": "ok", "filename": base, "size": bytes_read,
            "format": suffix.lstrip(".")}


@router.delete("/api/song/{filename:path}")
def delete_song(filename: str):
    """Remove a song from the DLC folder and clear its cache entries.

    Works for both formats: ``.sloppak`` files OR directories, and
    loose-folder songs (the directory containing the chart). The path is
    resolved through ``_resolve_dlc_path`` so URL-encoded ``..`` segments
    cannot escape the library root.
    """
    dlc = _get_dlc_dir()
    if dlc is None:
        return JSONResponse({"error": "DLC folder not configured"}, status_code=503)
    resolved = _resolve_dlc_path(dlc, filename)
    if resolved is None:
        return JSONResponse({"error": "forbidden"}, status_code=403)
    if not resolved.exists():
        return JSONResponse({"error": "File not found"}, status_code=404)
    if resolved == dlc.resolve():
        return JSONResponse({"error": "Refusing to delete the DLC root"}, status_code=400)

    # Only delete actual song entries. Without this, DELETE /api/song/ArtistName
    # would recursively wipe a whole artist subfolder — far broader than the
    # UI's per-song contract. Sloppak detection wins over loose because a
    # sloppak dir can also contain WEM/XML (matches the scanner's precedence).
    is_sloppak = sloppak_mod.is_sloppak(resolved)
    is_loose = (
        resolved.is_dir()
        and not is_sloppak
        and loosefolder_mod.is_loose_song(resolved)
    )
    if not (is_sloppak or is_loose):
        return JSONResponse(
            {"error": "Not a song entry — only sloppaks "
                      "or loose-folder songs can be deleted"},
            status_code=400,
        )

    # Hold ``_song_io_lock`` across the filesystem removal AND the DB/cache
    # eviction. Without it, an upload of the same filename could ``os.replace``
    # a new file into place between our removal and DB delete, leaving the
    # new generation stranded with no library row; or the reverse, where
    # delete runs between an upload's directory check and its replace and
    # the upload then resurrects the song we just removed.
    with _song_io_lock:
        try:
            if resolved.is_dir():
                shutil.rmtree(resolved)
            else:
                resolved.unlink()
        except OSError as e:
            log.error("Failed to delete %s: %s", resolved, e)
            return JSONResponse({"error": f"Delete failed: {e}"}, status_code=500)

        # Canonicalise the cache key the same way update_song_meta does so we
        # hit the row the scanner indexed under.
        try:
            cache_key = resolved.relative_to(dlc.resolve()).as_posix()
        except ValueError:
            cache_key = filename
        with appstate.meta_db._lock:
            appstate.meta_db.conn.execute("DELETE FROM songs WHERE filename = ?", (cache_key,))
            appstate.meta_db.conn.execute("DELETE FROM favorites WHERE filename = ?", (cache_key,))
            appstate.meta_db.conn.execute("DELETE FROM loops WHERE filename = ?", (cache_key,))
            # Purge the v3 filename-keyed state too, so the deleted song stops
            # surfacing in stats / recent / continue / playlists immediately.
            appstate.meta_db.conn.execute("DELETE FROM song_stats WHERE filename = ?", (cache_key,))
            appstate.meta_db.conn.execute("DELETE FROM playlist_songs WHERE filename = ?", (cache_key,))
            # Personal difficulty / notes / tags for this song (we hold the
            # lock, so purge is lock-free).
            appstate.meta_db.purge_song_user_data(cache_key)
            # Multi-chart grouping (P5a): drop this chart's split + read-model rows,
            # and any preferred-chart pointer that named it (the work re-auto-picks).
            # work_key-keyed prefs for OTHER charts survive. Mark the read-model
            # dirty so the affected work regroups on the next grouped query.
            appstate.meta_db.conn.execute("DELETE FROM chart_group_split WHERE filename = ?", (cache_key,))
            appstate.meta_db.conn.execute("DELETE FROM work_display WHERE filename = ?", (cache_key,))
            appstate.meta_db.conn.execute("DELETE FROM chart_group_pref WHERE preferred_filename = ?", (cache_key,))
            appstate.meta_db._work_display_dirty = True
            # Enrichment is never purged on rescan (delete_missing), only here
            # on the explicit per-song delete — the never-clobber contract.
            appstate.meta_db.conn.execute("DELETE FROM song_enrichment WHERE filename = ?", (cache_key,))
            appstate.meta_db.conn.commit()

        # User art overrides go with the song (CAA cache files are keyed by
        # RELEASE and may be shared with other charts — the LRU owns those).
        for _p in appstate.art_override_paths(cache_key):
            try:
                _p.unlink()
            except OSError:
                pass

        appstate.invalidate_song_caches(cache_key)

    log.info("Deleted song %s", cache_key)
    # If a scan was mid-flight when we removed the row, it may already have
    # listed (and not yet processed) the file and will call ``appstate.meta_db.put()``
    # for it after our DB delete — reinserting a ghost row. Coalesce a
    # follow-up pass via ``appstate.kick_scan`` so the next scan's ``delete_missing()``
    # purges that entry. Cheap no-op when no scan is running.
    if appstate.scan_status()["running"]:
        appstate.kick_scan()
    return {"ok": True, "filename": cache_key}


@router.get("/api/song/{filename:path}/user-meta")
def get_song_user_meta(filename: str):
    """Read {user_difficulty, notes, tags} for one song."""
    return appstate.meta_db.get_song_user_meta(appstate.meta_db._canonical_song_filename(filename))


@router.put("/api/song/{filename:path}/user-meta")
def put_song_user_meta(filename: str, data: dict):
    """Partial update. Send any of: `user_difficulty` (int 1–5, or null/"" to
    clear), `notes` (string, or null to clear), `tags` (a full-replace array of
    strings). Omitted keys are preserved. Returns the merged meta.

    Tag removal is a full-replace `tags` array (send the new set) rather than a
    granular DELETE sub-route, because `DELETE /api/song/{filename:path}` already
    owns every DELETE under /api/song and would shadow it."""
    key = appstate.meta_db._canonical_song_filename(filename)
    kwargs: dict = {}
    if "user_difficulty" in data:
        v = data["user_difficulty"]
        if v is None or v == "":
            kwargs["user_difficulty"] = None
        else:
            # Reject bools (int subclass) and non-integral floats so 2.5 / true
            # can't silently truncate into a valid band.
            if isinstance(v, bool) or (isinstance(v, float) and not v.is_integer()):
                return JSONResponse({"error": "user_difficulty must be an integer 1–5 or null"}, 400)
            try:
                iv = int(v)
            except (TypeError, ValueError):
                return JSONResponse({"error": "user_difficulty must be an integer 1–5 or null"}, 400)
            if not (1 <= iv <= 5):
                return JSONResponse({"error": "user_difficulty must be 1–5 or null"}, 400)
            kwargs["user_difficulty"] = iv
    if "notes" in data:
        n = data["notes"]
        if n is None:
            kwargs["notes"] = None
        elif isinstance(n, str):
            kwargs["notes"] = n.strip()[:4000]
        else:
            return JSONResponse({"error": "notes must be a string or null"}, 400)
    tags = data.get("tags", "__absent__")
    if tags != "__absent__" and not isinstance(tags, list):
        return JSONResponse({"error": "tags must be an array of strings"}, 400)
    if not kwargs and tags == "__absent__":
        return JSONResponse({"error": "No fields to update"}, 400)
    if kwargs:
        appstate.meta_db.set_song_user_meta(key, **kwargs)
    if tags != "__absent__":
        appstate.meta_db.set_song_tags(key, tags)
    return appstate.meta_db.get_song_user_meta(key)


# Catalog fields the Fix-metadata popup may override/lock — the intersection of
# "displayable identity" and "safe to correct locally". Guitar/practice facts
# and personal fields are never overrides.
_OVERRIDE_FIELDS = frozenset({"title", "artist", "album", "year", "genre"})


@router.get("/api/song/{filename:path}/overrides")
def get_song_overrides(filename: str):
    """Per-field metadata overrides + locks for one song (Fix-metadata popup):
    {"overrides": {field: {"value": str|null, "locked": bool}},
     "pack": {field: str}}. `pack` is the stored value each override sits on top
    of — the popup's Details tab renders it as the revert-to-pack reference and
    the Yours/Pack provenance."""
    key = appstate.meta_db._canonical_song_filename(filename)
    return {"overrides": appstate.meta_db.get_song_overrides(key),
            "pack": appstate.meta_db.pack_fields(key)}


@router.put("/api/song/{filename:path}/overrides")
def put_song_overrides(filename: str, data: dict):
    """Set/clear per-field overrides + locks. Body:
    `{"overrides": {field: {"value": str|null, "locked": bool}}}`. Only catalog
    fields (title/artist/album/year/genre) are accepted. A field left with no
    value and unlocked is removed. Returns the merged override map.

    Clearing rides this PUT (send value:null, locked:false) rather than a DELETE
    sub-route, because `DELETE /api/song/{filename:path}` already owns every
    DELETE under /api/song and would shadow it (same reason as tags)."""
    ov = (data or {}).get("overrides")
    if not isinstance(ov, dict) or not ov:
        return JSONResponse({"error": "overrides must be a non-empty object"}, 400)
    bad = sorted(f for f in ov if f not in _OVERRIDE_FIELDS)
    if bad:
        return JSONResponse({"error": "unknown field(s): " + ", ".join(bad)}, 400)
    key = appstate.meta_db._canonical_song_filename(filename)
    for field, spec in ov.items():
        if not isinstance(spec, dict):
            return JSONResponse({"error": f"'{field}' must be an object with value/locked"}, 400)
        kwargs: dict = {}
        if "value" in spec:
            v = spec["value"]
            if v is None:
                kwargs["value"] = None
            elif isinstance(v, (str, int, float)) and not isinstance(v, bool):
                kwargs["value"] = str(v).strip()[:500]
            else:
                return JSONResponse({"error": f"'{field}' value must be a string or null"}, 400)
        if "locked" in spec:
            kwargs["locked"] = bool(spec["locked"])
        if kwargs:
            appstate.meta_db.set_song_override(key, field, **kwargs)
    return {"overrides": appstate.meta_db.get_song_overrides(key)}


@router.post("/api/songs/user-meta/batch")
def batch_song_user_meta(data: dict):
    """Bulk personal-meta edit over a selection — one request instead of N×2
    per-song round-trips (the batch bar's apply-to-all). DB-only; never touches
    files. Body:
      {"filenames": [...],            # required, non-empty
       "set_difficulty": 1-5 | null,  # optional: set on all / clear on all
       "add_tags": [...],             # optional: add to all (never full-replace)
       "remove_tags": [...]}          # optional: remove from all
    Omit `set_difficulty` entirely to leave each song's difficulty as-is
    (mixed-state "leave unchanged"). Returns {"updated": N, "tags": [...]} so the
    caller can refresh the tag-filter list without a second call."""
    fns = data.get("filenames")
    if not isinstance(fns, list) or not fns:
        return JSONResponse({"error": "filenames must be a non-empty array"}, 400)
    if not all(isinstance(f, str) and f for f in fns):
        return JSONResponse({"error": "filenames must be non-empty strings"}, 400)

    kwargs: dict = {}
    if "set_difficulty" in data:
        v = data["set_difficulty"]
        if v is None or v == "":
            kwargs["set_difficulty"] = None
        else:
            if isinstance(v, bool) or (isinstance(v, float) and not v.is_integer()):
                return JSONResponse({"error": "set_difficulty must be an integer 1–5 or null"}, 400)
            try:
                iv = int(v)
            except (TypeError, ValueError):
                return JSONResponse({"error": "set_difficulty must be an integer 1–5 or null"}, 400)
            if not (1 <= iv <= 5):
                return JSONResponse({"error": "set_difficulty must be 1–5 or null"}, 400)
            kwargs["set_difficulty"] = iv

    add_tags = data.get("add_tags")
    remove_tags = data.get("remove_tags")
    for name, val in (("add_tags", add_tags), ("remove_tags", remove_tags)):
        if val is not None and not isinstance(val, list):
            return JSONResponse({"error": f"{name} must be an array of strings"}, 400)
    if "set_difficulty" not in data and not add_tags and not remove_tags:
        return JSONResponse({"error": "Nothing to apply"}, 400)

    keys = [appstate.meta_db._canonical_song_filename(f) for f in fns]
    n = appstate.meta_db.batch_user_meta(keys, add_tags=add_tags, remove_tags=remove_tags, **kwargs)
    return {"updated": n, "tags": appstate.meta_db.all_tags()}


@router.post("/api/song/{filename:path}/meta")
def update_song_meta(filename: str, data: dict):
    """Update song metadata, persisting it back into the underlying file.

    The library scanner re-derives title/artist/album/year from the file
    (archive manifest Attributes / sloppak manifest.yaml) on every full rescan,
    so a DB-only edit reverts. We write the edit into the file first, then
    refresh the cache row (including mtime/size) to match. Loose-folder and
    unwritable songs fall back to a DB-only update (which still survives an
    incremental rescan via the mtime/size cache hit).
    """
    # Canonicalise to the same key get_song_info uses so an update via
    # one URL form (e.g. with `..` segments) lands on the row that
    # later reads will see.
    dlc = _get_dlc_dir()
    cache_key = filename
    resolved = None
    if dlc:
        resolved = _resolve_dlc_path(dlc, filename)
        if resolved is None:
            return JSONResponse({"error": "forbidden"}, 403)
        try:
            cache_key = resolved.relative_to(dlc.resolve()).as_posix()
        except ValueError:
            pass

    fields = {k: data[k] for k in ("title", "artist", "album", "year") if k in data}
    if not fields:
        return {"error": "No fields to update"}
    # Normalise the year value so the DB and file stay in sync.  The file
    # writer (songmeta) coerces empty/non-numeric years to 0, which the
    # scanner reads back as "".  Store "" in the DB instead of a raw
    # non-numeric string so that if the mtime/size are updated (making the
    # row cache-fresh) the DB still matches what the scanner would derive.
    if "year" in fields:
        try:
            _yr_int = int(fields["year"])
        except (TypeError, ValueError):
            _yr_int = 0
        fields = {**fields, "year": str(_yr_int) if _yr_int else ""}

    # Persist into the file so the edit survives a full rescan.
    # Hold _song_io_lock across the existence check and file write so a
    # concurrent delete cannot remove the file between our check and the
    # repack's atomic replace, and so a concurrent upload cannot be clobbered
    # by our atomic rename. archive repack is slow — the lock is held longer
    # than a simple upload/delete, but correctness requires serialisation.
    persisted = False
    with _song_io_lock:
        if resolved is not None and resolved.exists():
            try:
                import songmeta
                persisted = songmeta.write_song_metadata(resolved, fields)
            except Exception:
                log.warning("metadata file write failed for %s", cache_key, exc_info=True)

        with appstate.meta_db._lock:
            updates = [f"{field} = ?" for field in fields]
            params = list(fields.values())
            if persisted:
                # The file changed — re-stat so an incremental rescan sees a
                # consistent cache row instead of re-reading the (now matching)
                # file.
                try:
                    mtime, size = appstate.stat_for_cache(resolved)
                    updates += ["mtime = ?", "size = ?"]
                    params += [mtime, size]
                except OSError:
                    pass
            params.append(cache_key)
            appstate.meta_db.conn.execute(
                f"UPDATE songs SET {', '.join(updates)} WHERE filename = ?", params
            )
            appstate.meta_db.conn.commit()

    if persisted:
        appstate.invalidate_song_caches(cache_key)
        # Coalesce a follow-up scan so a mid-flight scan's stale appstate.meta_db.put()
        # for this file can't win: if a scan is running appstate.kick_scan() queues a
        # pending pass; if not it starts a fresh one. Unconditional to avoid a
        # race where the scan finishes between our DB commit and a guarded check.
        appstate.kick_scan()
    return {"ok": True, "persisted": persisted}


# ── Gap-fill: write CONFIRMED missing metadata into the pack (R4a) ────────────
# The agreed write-back contract (spec-alignment §7): opt-in + user-initiated
# (nothing here runs in the background), adds ABSENT keys only (never replaces
# an author-set value — the writer refuses, and existing manifest bytes are
# preserved verbatim by appending), spec'd-keys allowlist, values only from a
# CONFIRMED identity (an auto/exact match or a user pin — review-tier rows are
# not eligible until a human confirms), atomic write + .bak. Single-song only;
# batch write-back stays an open question with the spec chair.
_GAP_FILL_KEYS = ("album", "year", "genres", "mbid", "isrc")


def _gap_fill_manifest_absent(manifest: dict, key: str) -> bool:
    """A key is a GAP only when it's genuinely MISSING from the manifest.

    Gap-fill is append-only: the writer's never-clobber guard raises on ANY
    key already present, and appending a second `album:` line to a manifest
    that already carries `album: ''` would just create a duplicate YAML key.
    So a present-but-empty value (None / '' / [] / year 0) is NOT a gap the
    append-only writer can fill — offering it in the preview would only lead
    to a POST the writer refuses. Present-but-empty keys are therefore left
    to the metadata editor (which re-serializes and can replace in place)."""
    return key not in manifest


def _gap_fill_proposals(cache_key: str, resolved) -> tuple[dict, str]:
    """What gap-fill could add for this song: (proposals, reason). Empty
    proposals explain themselves via reason — 'not-sloppak', 'no-match'
    (nothing confirmed yet), 'review' (a human hasn't confirmed the match),
    or 'nothing-missing'."""
    if resolved is None or not resolved.exists() or not sloppak_mod.is_sloppak(resolved):
        return {}, "not-sloppak"
    row = appstate.meta_db.get_enrichment(cache_key)
    if not row or row.get("match_state") not in ("matched", "manual"):
        state = (row or {}).get("match_state")
        return {}, ("review" if state == "review" else "no-match")
    try:
        manifest = sloppak_mod.load_manifest(resolved) or {}
    except Exception:
        return {}, "not-sloppak"
    # A LOCKED field (Fix-metadata popup) is never gap-filled — the user pinned
    # it away from the matched value, so writing that value to the file would
    # be exactly the clobber the lock exists to prevent. (The lock field name is
    # `genre`; the manifest/gap-fill key is `genres`.)
    locked = appstate.meta_db.locked_fields(cache_key)
    out = {}
    album = (row.get("canon_album") or "").strip()
    if album and "album" not in locked and _gap_fill_manifest_absent(manifest, "album"):
        out["album"] = album
    year = (row.get("canon_year") or "").strip()
    if (year.isdigit() and int(year) and "year" not in locked
            and _gap_fill_manifest_absent(manifest, "year")):
        out["year"] = int(year)
    genres = [str(g) for g in (row.get("genres") or []) if isinstance(g, str) and g.strip()]
    if genres and "genre" not in locked and _gap_fill_manifest_absent(manifest, "genres"):
        out["genres"] = genres
    # Identity keys (feedpak spec 1.14.0) — written in canonical form only.
    mbid = (row.get("mb_recording_id") or "").strip().lower()
    if enrichment._MBID_RE.match(mbid) and _gap_fill_manifest_absent(manifest, "mbid"):
        out["mbid"] = mbid
    isrc = (row.get("isrc") or "").strip().upper().replace("-", "").replace(" ", "")
    if enrichment._ISRC_RE.match(isrc) and _gap_fill_manifest_absent(manifest, "isrc"):
        out["isrc"] = isrc
    return out, ("" if out else "nothing-missing")


@router.get("/api/song/{filename:path}/gap-fill")
def get_song_gap_fill(filename: str):
    """Preview what "Write missing info to file" would add — the Details
    drawer renders its confirm list straight from this. Read-only."""
    dlc = _get_dlc_dir()
    cache_key, resolved = filename, None
    if dlc:
        resolved = _resolve_dlc_path(dlc, filename)
        if resolved is None:
            return JSONResponse({"error": "forbidden"}, 403)
        try:
            cache_key = resolved.relative_to(dlc.resolve()).as_posix()
        except ValueError:
            pass
    proposals, reason = _gap_fill_proposals(cache_key, resolved)
    row = appstate.meta_db.get_enrichment(cache_key) or {}
    return {
        "eligible": bool(proposals),
        "reason": reason,
        "match_state": row.get("match_state"),
        "missing": [{"key": k, "value": v} for k, v in proposals.items()],
    }


@router.post("/api/song/{filename:path}/gap-fill")
def post_song_gap_fill(filename: str, data: dict):
    """Write the user-confirmed subset of the preview into the pack file.
    Proposals are recomputed under the io lock, so a key that gained an
    author value between preview and confirm is skipped, never replaced."""
    keys = (data or {}).get("keys")
    if not isinstance(keys, list) or not keys:
        return JSONResponse({"error": "keys must be a non-empty list"}, 400)
    bad = [k for k in keys if k not in _GAP_FILL_KEYS]
    if bad:
        return JSONResponse(
            {"error": "unknown key(s): " + ", ".join(sorted(set(map(str, bad))))}, 400)

    dlc = _get_dlc_dir()
    cache_key, resolved = filename, None
    if dlc:
        resolved = _resolve_dlc_path(dlc, filename)
        if resolved is None:
            return JSONResponse({"error": "forbidden"}, 403)
        try:
            cache_key = resolved.relative_to(dlc.resolve()).as_posix()
        except ValueError:
            pass

    with _song_io_lock:
        proposals, reason = _gap_fill_proposals(cache_key, resolved)
        additions = {k: proposals[k] for k in _GAP_FILL_KEYS if k in keys and k in proposals}
        skipped = sorted(set(keys) - set(additions))
        if not additions:
            return JSONResponse({"error": "nothing to write", "reason": reason,
                                 "skipped": skipped}, 409)
        try:
            import songmeta
            songmeta.gap_fill_sloppak(resolved, additions)
        except Exception:
            log.warning("gap-fill write failed for %s", cache_key, exc_info=True)
            return JSONResponse({"error": "write failed"}, 500)

        # Keep the cache row consistent with what the scanner would now derive
        # (same contract as the metadata editor above): sync the columns the
        # scan reads from the keys we appended, then re-stat so the row stays
        # cache-fresh.
        fields = {}
        if "album" in additions:
            fields["album"] = additions["album"]
        if "year" in additions:
            fields["year"] = str(additions["year"])
        if "genres" in additions:
            fields["genre"] = additions["genres"][0]
        with appstate.meta_db._lock:
            updates = [f"{field} = ?" for field in fields]
            params = list(fields.values())
            try:
                mtime, size = appstate.stat_for_cache(resolved)
                updates += ["mtime = ?", "size = ?"]
                params += [mtime, size]
            except OSError:
                pass
            if updates:
                params.append(cache_key)
                appstate.meta_db.conn.execute(
                    f"UPDATE songs SET {', '.join(updates)} WHERE filename = ?", params)
                appstate.meta_db.conn.commit()

    appstate.invalidate_song_caches(cache_key)
    appstate.kick_scan()
    return {"ok": True, "written": additions, "skipped": skipped}


@router.get("/api/song/{filename:path}")
async def get_song_info(filename: str):
    """Return song metadata, from cache or by extracting it from the song source."""
    import asyncio
    dlc = _get_dlc_dir()
    if not dlc:
        return JSONResponse({"error": "DLC folder not configured"}, 404)

    song_path = _resolve_dlc_path(dlc, filename)
    if song_path is None:
        return JSONResponse({"error": "forbidden"}, 403)
    if not song_path.exists():
        return JSONResponse({"error": "File not found"}, 404)

    # Canonicalise the cache key against the resolved path so two URL
    # forms of the same physical file (e.g. `Artist/song.sloppak` vs
    # `Artist/../Artist/song.sloppak`) converge on a single row instead
    # of fragmenting / shadowing each other in appstate.meta_db.
    try:
        cache_key = song_path.relative_to(dlc.resolve()).as_posix()
    except ValueError:
        cache_key = filename

    mtime, size = appstate.stat_for_cache(song_path)
    cached = appstate.meta_db.get(cache_key, mtime, size)
    if cached:
        return cached

    # Extract in thread pool
    def _extract():
        meta = _extract_meta_for_file(song_path, dlc)
        appstate.meta_db.put(cache_key, mtime, size, meta)
        return meta

    meta = await asyncio.get_event_loop().run_in_executor(None, _extract)
    return meta
