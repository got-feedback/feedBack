"""
Folder Library plugin — routes.py

Surfaces the DLC folder structure as a navigable tree and provides in-app
folder management (create / rename / delete) and song moves. Every filesystem
mutation is confined to DLC_DIR and validated against path traversal.
"""

from pathlib import Path
from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse
import shutil
import re
import zipfile


# ── Pure, testable helpers ─────────────────────────────────────────────────

_UNSAFE_NAME_RE = re.compile(r'[\\/:*?"<>|]')


def _safe_name(name: str) -> bool:
    """A single path segment is safe: no separators, no traversal dot-names,
    no surrounding whitespace, no characters illegal across filesystems."""
    if not name or name.strip() != name:
        return False
    if _UNSAFE_NAME_RE.search(name):
        return False
    if name in (".", ".."):
        return False
    return True


def _safe_path(path_str: str) -> bool:
    """A slash-separated path is safe iff every segment is a safe name."""
    if not path_str:
        return False
    return all(_safe_name(p) for p in path_str.split("/"))


def _is_within(root: Path, candidate: Path) -> bool:
    """True iff ``candidate`` resolves to a location inside ``root`` (after
    normalising ``..`` and symlinks). Containment backstop for file moves so a
    crafted filename can't escape DLC_DIR even past the segment validator."""
    try:
        candidate.resolve().relative_to(root.resolve())
        return True
    except (ValueError, OSError):
        return False


def _path_to_dir(root: Path, folder_path: str) -> Path:
    """Resolve a slash-separated folder path relative to ``root``."""
    result = root
    for part in folder_path.split("/"):
        result = result / part
    return result


def _load_is_loose_song():
    """The host's authoritative loose-folder predicate (lib/loosefolder.py),
    imported lazily so the plugin still loads if it's ever unavailable. A
    loose-folder song is a directory carrying audio + an arrangement XML rather
    than a ``.sloppak`` bundle, so the plain suffix check below misses it."""
    try:
        from loosefolder import is_loose_song
        return is_loose_song
    except Exception:
        return None


_IS_LOOSE_SONG = _load_is_loose_song()


def _is_song(p: Path) -> bool:
    """A song carrier is a ``.sloppak`` / ``.feedpak`` file or directory-form
    bundle (extension on the leaf name), or a host-recognised loose-folder song
    directory — so loose-folder charts surface in the tree like any other song
    instead of being walked into as if they were ordinary folders."""
    if p.suffix.lower() in (".sloppak", ".feedpak"):
        return True
    if _IS_LOOSE_SONG is not None and p.is_dir():
        try:
            return bool(_IS_LOOSE_SONG(p))
        except Exception:
            return False
    return False


def setup(app, context):
    log = context["log"]
    router = APIRouter(prefix="/api/plugins/folder_library")

    # ── Two-level cache ────────────────────────────────────────────────
    # _meta_cache  — expensive extract_meta() results keyed by abs path
    #                (as_posix() string).  Never cleared; keys are updated
    #                in-place when files are moved so the data stays valid.
    # _cache       — tree structure ("folders" / "root_songs").  Cleared on
    #                every mutation so the next /tree request rebuilds it —
    #                but that rebuild is now fast because _meta_cache is warm.
    _cache      = {}   # "tree" → JSONResponse-ready dict
    _meta_cache = {}   # abs_posix_path → extracted meta (no filename/added)

    def _invalidate():
        """Clear the tree structure cache only.  _meta_cache is preserved."""
        _cache.clear()

    def _dlc_root() -> Path | None:
        try:
            return Path(context["get_dlc_dir"]())
        except Exception:
            return None

    def _scan_root(dlc: Path) -> Path:
        sloppak = dlc / "sloppak"
        return sloppak if sloppak.exists() else dlc

    def _audio_member(p: Path):
        """Best in-pack audio file for hover-preview, as a pack-relative path.

        Prefers a dedicated preview clip, then a full mix, then any stem — so the
        frontend can preview with a single request instead of probing (and 404ing)
        a hardcoded path. Returns None when the pack carries no audio.
        """
        prefer = ("preview.ogg", "stems/full.ogg", "stems/audio.mp3",
                  "stems/audio.ogg", "audio.mp3", "audio.ogg", "full.ogg")
        audio_ext = (".ogg", ".mp3", ".opus", ".m4a", ".oga")
        try:
            if p.is_dir():
                names = ["/".join(f.relative_to(p).parts) for f in p.rglob("*") if f.is_file()]
            else:
                with zipfile.ZipFile(p) as z:
                    names = z.namelist()
        except Exception:
            return None
        nameset = set(names)
        for m in prefer:
            if m in nameset:
                return m
        for n in names:                    # any stem audio
            low = n.lower()
            if low.startswith("stems/") and low.endswith(audio_ext):
                return n
        for n in names:                    # any audio at all
            if n.lower().endswith(audio_ext):
                return n
        return None

    def _meta(p: Path, dlc: Path) -> dict:
        # filename and added are always computed fresh — they change when files move.
        try:
            filename = "/".join(p.relative_to(dlc).parts)
        except ValueError:
            filename = p.name
        added = None
        try:
            added = p.stat().st_mtime
        except Exception:
            pass

        # Return cached extracted metadata if available.
        cache_key = p.as_posix()
        if cache_key in _meta_cache:
            m = dict(_meta_cache[cache_key])   # shallow copy
            m["filename"] = filename
            m["added"]    = added
            return m

        # Cache miss — run the expensive extract.
        m = {"title": None, "artist": None, "album": None, "duration": None,
             "year": None, "tuning": None, "arrangements": [], "stems": [], "lyrics": False,
             "audio_member": _audio_member(p)}
        try:
            raw = context["extract_meta"](p)
            if raw:
                m["title"]    = raw.get("title")    or raw.get("name")
                m["artist"]   = raw.get("artist")   or raw.get("artistName")
                m["album"]    = raw.get("album")     or raw.get("albumName")
                m["duration"] = raw.get("duration")
                m["year"]     = raw.get("year")
                m["tuning"]   = raw.get("tuning")

                # arrangements — objects with a "name" key e.g. [{name:"Lead",...}, ...]
                raw_arr = raw.get("arrangements") or []
                if isinstance(raw_arr, (list, tuple)):
                    m["arrangements"] = [
                        a["name"] if isinstance(a, dict) else str(a)
                        for a in raw_arr
                        if (isinstance(a, dict) and "name" in a) or isinstance(a, str)
                    ]

                # stems — may also be objects with a "name" key, same as arrangements
                raw_stems = raw.get("stems") or []
                for _key in ("stems", "stem_types", "available_stems", "stemTypes"):
                    _v = raw.get(_key)
                    if _v:
                        raw_stems = _v
                        break
                if isinstance(raw_stems, (list, tuple)):
                    m["stems"] = [
                        a["name"] if isinstance(a, dict) else str(a)
                        for a in raw_stems
                        if (isinstance(a, dict) and "name" in a) or isinstance(a, str)
                    ]

                # lyrics — try common key variants
                for _key in ("lyrics", "hasLyrics", "has_lyrics", "lyric", "hasLyric"):
                    _val = raw.get(_key)
                    if _val is not None:
                        if isinstance(_val, str):
                            m["lyrics"] = _val.lower() not in ("", "false", "no", "0")
                        else:
                            m["lyrics"] = bool(_val)
                        break
        except Exception as exc:
            log.debug("meta failed for %s: %s", p.name, exc)
        if not m["title"]:
            m["title"] = p.stem

        _meta_cache[cache_key] = m      # store without filename/added
        result = dict(m)
        result["filename"] = filename
        result["added"]    = added
        return result

    def _scan_dir(path: Path, root: Path, dlc: Path) -> dict:
        """Recursively scan a directory and return a folder node."""
        songs = []
        children = []
        try:
            for entry in sorted(path.iterdir(), key=lambda p: p.name.lower()):
                if entry.name.startswith("."):
                    continue
                if _is_song(entry):
                    songs.append(_meta(entry, dlc))
                elif entry.is_dir():
                    children.append(_scan_dir(entry, root, dlc))
        except PermissionError:
            log.warning("permission denied: %s", path)
        try:
            rel = path.relative_to(root)
            folder_path = "/".join(rel.parts)
        except ValueError:
            folder_path = path.name
        return {
            "name": path.name,
            "path": folder_path,
            "songs": songs,
            "children": children,
        }

    def _apply_tree_filters(tree, arrangements_has="", arrangements_lacks="",
                            stems_has="", stems_lacks="", has_lyrics="", tunings=""):
        """Filter a cached tree dict by arrangement/stem/lyrics/tuning params.
        The cache always holds the full unfiltered tree; this is applied per-request."""
        def _split(s):
            return [x.strip().lower() for x in s.split(",") if x.strip()] if s else []

        arr_has   = _split(arrangements_has)
        arr_lacks = _split(arrangements_lacks)
        st_has    = _split(stems_has)
        st_lacks  = _split(stems_lacks)
        tun_set   = set(_split(tunings))
        lyr       = None if has_lyrics == "" else (has_lyrics == "1")

        if not any([arr_has, arr_lacks, st_has, st_lacks, tun_set, lyr is not None]):
            return tree  # no filters active — return as-is

        def _song_ok(s):
            arrs = [a.lower() for a in (s.get("arrangements") or [])]
            stms = [x.lower() for x in (s.get("stems") or [])]
            if arr_has   and not any(a in arrs for a in arr_has):   return False
            if arr_lacks and     any(a in arrs for a in arr_lacks): return False
            if st_has    and not any(x in stms for x in st_has):    return False
            if st_lacks  and     any(x in stms for x in st_lacks):  return False
            if lyr is not None and bool(s.get("lyrics")) != lyr:    return False
            if tun_set and (s.get("tuning") or "").lower() not in tun_set: return False
            return True

        def _filter_node(node):
            return {
                "name": node["name"],
                "path": node["path"],
                "songs": [s for s in node["songs"] if _song_ok(s)],
                "children": [_filter_node(c) for c in node.get("children", [])],
            }

        return {
            "folders": [_filter_node(f) for f in tree["folders"]],
            "root_songs": [s for s in tree["root_songs"] if _song_ok(s)],
        }

    @router.get("/tree")
    def get_tree(
        arrangements_has:   str = "",
        arrangements_lacks: str = "",
        stems_has:          str = "",
        stems_lacks:        str = "",
        has_lyrics:         str = "",
        tunings:            str = "",
    ):
        if "tree" not in _cache:
            dlc = _dlc_root()
            if not dlc or not dlc.exists():
                return JSONResponse({"folders": [], "root_songs": [],
                                     "error": "DLC directory not found"})
            root = _scan_root(dlc)
            log.info("folder_library: scanning %s", root)
            folders = []
            root_songs = []
            try:
                for entry in sorted(root.iterdir(), key=lambda p: p.name.lower()):
                    if entry.name.startswith("."):
                        continue
                    if _is_song(entry):
                        root_songs.append(_meta(entry, dlc))
                    elif entry.is_dir():
                        folders.append(_scan_dir(entry, root, dlc))
            except PermissionError:
                return JSONResponse({"folders": [], "root_songs": [],
                                     "error": "Permission denied"})
            _cache["tree"] = {"folders": folders, "root_songs": root_songs}

        result = _apply_tree_filters(
            _cache["tree"], arrangements_has, arrangements_lacks,
            stems_has, stems_lacks, has_lyrics, tunings,
        )
        return JSONResponse(result)

    @router.post("/folder/create")
    async def create_folder(request: Request):
        body = await request.json()
        name = (body.get("name") or "").strip()
        parent = (body.get("parent") or "").strip()
        if not _safe_name(name):
            return JSONResponse({"error": "Invalid folder name"}, status_code=400)
        if parent and not _safe_path(parent):
            return JSONResponse({"error": "Invalid parent path"}, status_code=400)
        dlc = _dlc_root()
        if not dlc:
            return JSONResponse({"error": "DLC dir not found"}, status_code=500)
        root = _scan_root(dlc)
        parent_dir = _path_to_dir(root, parent) if parent else root
        if parent and not parent_dir.exists():
            return JSONResponse({"error": "Parent folder not found"}, status_code=404)
        target = parent_dir / name
        if target.exists():
            return JSONResponse({"error": "Folder already exists"}, status_code=400)
        try:
            target.mkdir(parents=False)
            _invalidate()
            return JSONResponse({"ok": True})
        except Exception as e:
            return JSONResponse({"error": str(e)}, status_code=500)

    @router.post("/folder/rename")
    async def rename_folder(request: Request):
        body = await request.json()
        old = (body.get("old") or "").strip()
        new = (body.get("new") or "").strip()
        if not _safe_path(old) or not _safe_name(new):
            return JSONResponse({"error": "Invalid folder name"}, status_code=400)
        dlc = _dlc_root()
        if not dlc:
            return JSONResponse({"error": "DLC dir not found"}, status_code=500)
        root = _scan_root(dlc)
        src = _path_to_dir(root, old)
        dst = src.parent / new  # rename within the same parent
        if not src.exists():
            return JSONResponse({"error": "Folder not found"}, status_code=404)
        if dst.exists():
            return JSONResponse({"error": "Name already taken"}, status_code=400)
        try:
            # Pre-compute meta cache key updates (keys change because the
            # folder path changes — all files under src get a new prefix).
            old_prefix = src.as_posix() + "/"
            new_prefix = dst.as_posix() + "/"
            meta_updates = {
                key: new_prefix + key[len(old_prefix):]
                for key in list(_meta_cache)
                if key.startswith(old_prefix)
            }
            src.rename(dst)
            _invalidate()
            for old_key, new_key in meta_updates.items():
                if old_key in _meta_cache:
                    _meta_cache[new_key] = _meta_cache.pop(old_key)
            return JSONResponse({"ok": True})
        except Exception as e:
            return JSONResponse({"error": str(e)}, status_code=500)

    @router.post("/folder/delete")
    async def delete_folder(request: Request):
        body = await request.json()
        name = (body.get("name") or "").strip()
        if not _safe_path(name):
            return JSONResponse({"error": "Invalid folder path"}, status_code=400)
        dlc = _dlc_root()
        if not dlc:
            return JSONResponse({"error": "DLC dir not found"}, status_code=500)
        root = _scan_root(dlc)
        target = _path_to_dir(root, name)
        if not target.exists():
            return JSONResponse({"error": "Folder not found"}, status_code=404)
        try:
            # Relocate every song (at any depth) up to the scan root BEFORE
            # removing the folder. Colliding filenames are de-duplicated so a
            # name clash never leaves a song behind to be destroyed by rmtree
            # (the folder is advertised as "moves its songs to Unsorted").
            for song_path in sorted(target.rglob("*")):
                if not song_path.exists():
                    continue  # a parent song-dir was already relocated
                if not _is_song(song_path):
                    continue
                old_key = song_path.as_posix()
                dest = root / song_path.name
                if dest.exists():
                    stem, suffix = song_path.stem, song_path.suffix
                    n = 1
                    while dest.exists():
                        dest = root / f"{stem} ({n}){suffix}"
                        n += 1
                song_path.rename(dest)
                if old_key in _meta_cache:
                    _meta_cache[dest.as_posix()] = _meta_cache.pop(old_key)
            shutil.rmtree(target)
            _invalidate()
            return JSONResponse({"ok": True})
        except Exception as e:
            return JSONResponse({"error": str(e)}, status_code=500)

    @router.post("/song/move")
    async def move_song(request: Request):
        body = await request.json()
        filename = (body.get("filename") or "").strip()
        dest_folder = (body.get("folder") or "").strip()
        # Validate the source path like the folder ops, AND confirm it resolves
        # inside DLC_DIR — without this a filename such as "../../etc/passwd"
        # would be renamed (moved) into the served library and become readable.
        if not filename or not _safe_path(filename):
            return JSONResponse({"error": "Invalid filename"}, status_code=400)
        dlc = _dlc_root()
        if not dlc:
            return JSONResponse({"error": "DLC dir not found"}, status_code=500)
        src = dlc / Path(*filename.split("/"))
        if not _is_within(dlc, src):
            return JSONResponse({"error": "Invalid filename"}, status_code=400)
        if not src.exists():
            return JSONResponse({"error": "Song not found"}, status_code=404)
        root = _scan_root(dlc)
        if dest_folder:
            if not _safe_path(dest_folder):
                return JSONResponse({"error": "Invalid folder path"}, status_code=400)
            dst_dir = _path_to_dir(root, dest_folder)
            if not dst_dir.exists():
                return JSONResponse({"error": "Destination folder not found"}, status_code=404)
        else:
            dst_dir = root
        dst = dst_dir / src.name
        if dst.exists():
            return JSONResponse({"error": "File already exists at destination"}, status_code=400)
        try:
            old_key = src.as_posix()
            src.rename(dst)
            if old_key in _meta_cache:
                _meta_cache[dst.as_posix()] = _meta_cache.pop(old_key)
            _invalidate()
            return JSONResponse({"ok": True})
        except Exception as e:
            return JSONResponse({"error": str(e)}, status_code=500)

    app.include_router(router)
    log.info("folder_library routes registered")
