"""Album-art routes: serve / cover-search / candidates / upload / url / remove
(/api/song/{filename}/art*, /api/art/{filename}/override).

Extracted verbatim from server.py (R3). Only the decorators (@app -> @router) and
the seam reads change: meta_db -> appstate.meta_db, ART_CACHE_DIR ->
appstate.art_cache_dir, and the three shared art helpers that stay in server.py
(they are also used by the song/delete routes) -> appstate.<callable>
(_song_pack_art_exists, _art_override_paths, _art_safe_name). The CAA / release
search transport lives in lib/enrichment.py and is reached as enrichment.X.
"""

import asyncio
import hashlib
import ipaddress
from pathlib import Path

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import FileResponse, JSONResponse, Response

import appstate
import enrichment
import loosefolder as loosefolder_mod
import sloppak as sloppak_mod
from dlc_paths import _get_dlc_dir, _resolve_dlc_path

import logging
log = logging.getLogger("feedBack.server")
router = APIRouter()

def _if_none_match_hits(header: str | None, etag: str) -> bool:
    """True if an If-None-Match header matches `etag` (weak comparison).

    Handles the `*` wildcard and comma-separated lists, and ignores a weak
    `W/` prefix on either side — the standard semantics for a conditional GET.
    """
    if not header:
        return False
    bare = etag.removeprefix("W/")
    for tok in header.split(","):
        t = tok.strip()
        if t == "*" or t.removeprefix("W/") == bare:
            return True
    return False


# Album art is served with a strong validator (an ETag on the sloppak byte
# path; FileResponse's own ETag/Last-Modified on the file paths) and revalidated
# with `no-cache`. That keeps re-scroll cheap — a conditional GET returns a
# bodyless 304 — without ever serving a stale cover. A long `immutable` max-age
# was rejected: the frontend's `?v=<mtime>` buster is only second-resolution, so
# a same-second cover rewrite would keep the URL and pin the old bytes for the
# cache lifetime. Validation cost is negligible for a localhost backend.
_ART_CACHE_HEADERS = {"Cache-Control": "no-cache"}


def _art_etag(path: Path) -> str | None:
    """Strong validator for an art file: nanosecond mtime + size (so a
    same-second rewrite still changes it). None if the file can't be stat'd."""
    try:
        st = path.stat()
        return f'"{st.st_mtime_ns}-{st.st_size}"'
    except OSError:
        return None


def _art_conditional(etag: str | None, request: Request | None):
    """Return (headers, not_modified) for an art response. `not_modified` is
    True when the client's If-None-Match already matches `etag` → caller should
    return a bodyless 304. Starlette's FileResponse emits an ETag but does NOT
    itself evaluate If-None-Match, so every art path routes through here to get
    real conditional handling."""
    headers = dict(_ART_CACHE_HEADERS)
    if etag:
        headers["ETag"] = etag
    inm = request.headers.get("if-none-match") if request is not None else None
    return headers, bool(etag) and _if_none_match_hits(inm, etag)


def _file_art_response(path: Path, media_type: str, request: Request | None):
    """FileResponse for an on-disk art file, with no-cache + ETag and a bodyless
    304 when the client's validator still matches."""
    headers, not_modified = _art_conditional(_art_etag(path), request)
    if not_modified:
        return Response(status_code=304, headers=headers)
    return FileResponse(str(path), media_type=media_type, headers=headers)


@router.get("/api/song/{filename:path}/art")
async def get_song_art(filename: str, request: Request = None, source: str = ""):
    """Serve album art for a song, walking the R3 override chain:

      1. USER OVERRIDE (upload / URL-fetch, {safe_name}.gif|.png in the art
         cache) — art the user explicitly pinned outranks everything, pack
         art included. GIF is allowed HERE only: an animated cover is a
         local-only bonus; packs stay jpg/png/webp and nothing ever writes
         art into a pack file.
      2. PACK ART — sloppak cover (single member read, no full unpack) or
         the loose folder's discovered image.
      3. COVER ART ARCHIVE cache — fetched by the enrichment art worker for
         matched songs that lack pack art, keyed by release MBID.

    `?source=pack` narrows the chain to step 2 only (no override, no CAA):
    the cover picker's "Pack original" tile must show the pack's own art
    even while a user override is what the plain route serves. 404 when the
    song ships no art of its own.
    """
    dlc = _get_dlc_dir()
    if not dlc:
        return JSONResponse({"error": "not configured"}, 404)

    song_path = _resolve_dlc_path(dlc, filename)
    if song_path is None:
        return JSONResponse({"error": "forbidden"}, 403)
    if not song_path.exists():
        return JSONResponse({"error": "not found"}, 404)

    pack_only = source == "pack"

    # 1. User override — GIF first (it wins over a stale PNG override).
    if not pack_only:
        for cached in appstate.art_override_paths(filename):
            mt = "image/gif" if cached.suffix == ".gif" else "image/png"
            return _file_art_response(cached, mt, request)

    # 2a. Sloppak: read the cover (manifest-declared or default) straight from
    # the package. For a zip-form sloppak this opens just the cover member —
    # NOT the whole archive — so the library grid never triggers a full unpack
    # of stems just to paint a thumbnail.
    if sloppak_mod.is_sloppak(song_path):
        # Read the cover (cheap — single member, no full unpack) and validate by
        # its CONTENT. A stat-based ETag would be wrong for directory-form
        # sloppaks: editing cover.jpg in place changes the file's mtime, not the
        # directory's, so a dir-stat ETag could emit a stale 304. Content hashing
        # is correct for both dir- and zip-form. Raw byte Response lacks
        # FileResponse's validators, so we attach the ETag + honor If-None-Match.
        try:
            art = await asyncio.to_thread(sloppak_mod.read_cover_bytes, song_path)
        except Exception:
            art = None
        if art is not None:
            data, mt = art
            etag = f'"{hashlib.sha1(data).hexdigest()}"'
            headers, not_modified = _art_conditional(etag, request)
            if not_modified:
                return Response(status_code=304, headers=headers)
            return Response(content=data, media_type=mt, headers=headers)

    # 2b. Loose folder: serve the discovered art file directly.
    # song_path is already validated against DLC_DIR by _resolve_dlc_path.
    elif loosefolder_mod.is_loose_song(song_path):
        art_path = loosefolder_mod.find_art(song_path)
        if art_path:
            # Re-resolve in case the matched file is a symlink — a crafted
            # custom song could put `album_art.jpg` as a symlink to anywhere on
            # disk. Insist the final target stays inside the song folder.
            art_resolved = art_path.resolve()
            try:
                art_resolved.relative_to(song_path)
            except ValueError:
                return JSONResponse({"error": "forbidden"}, 403)
            if art_resolved.is_file():
                mt = {
                    ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
                    ".png": "image/png", ".webp": "image/webp",
                }.get(art_resolved.suffix.lower(), "image/jpeg")
                return _file_art_response(art_resolved, mt, request)

    # 3. Cover Art Archive cache (the enrichment art worker's fetch).
    if not pack_only:
        row = appstate.meta_db.get_enrichment(filename)
        if row and row.get("art_state") == "caa" and row.get("art_cache_path"):
            caa = Path(row["art_cache_path"])
            if caa.is_file():
                return _file_art_response(caa, "image/jpeg", request)

    return JSONResponse({"error": "no art"}, 404)


# ── Cover picker (PR-C): candidate assembly ───────────────────────────────────
# Enumerated ON OPEN, never at scan time (charrette §8), and NO image bytes
# are fetched here — Cover Art Archive release INDEX jsons only (1-3 throttled
# calls on a cache miss); the tiles' thumbnails load straight from the archive
# in the client. Applying a pick never grows a new write path: the client
# POSTs the chosen thumb URL to the EXISTING …/art/url route (the override
# lane — never evicted, survives a re-match), "Pack original" DELETEs the
# override, uploads keep the existing upload route.
_ART_PICKER_MAX_CAA = 12


@router.get("/api/song/{filename:path}/art/cover-search")
def api_art_cover_search(filename: str, q: str = ""):
    """Search Cover Art Archive (via MusicBrainz release-groups) for album covers
    — powers the Change-cover picker's search box, so a cover can be found even
    for a song with no metadata match (the unmatched city-pop pile, where
    /art/candidates is empty). `q` defaults to the song's own artist + album/
    title (romaji fallback applied). Read-only; the picker renders the thumbs and
    applies a pick through the existing /art/url route."""
    query = (q or "").strip()
    if not query:
        pack = appstate.meta_db.pack_fields(appstate.meta_db._canonical_song_filename(filename))
        query = " ".join(x for x in (pack.get("artist"), pack.get("album") or pack.get("title")) if x).strip()
    if not query:
        return {"query": "", "covers": []}
    try:
        return {"query": query, "covers": enrichment._mb_search_release_groups(query, limit=8)}
    except enrichment.EnrichTransportError:
        return {"query": query, "covers": [], "error": "unavailable"}


@router.get("/api/song/{filename:path}/art/candidates")
def get_song_art_candidates(filename: str):
    """Everything the cover picker can offer for one song, without fetching a
    single image: the current cover (with its provenance), the pack original
    when the song ships art, and CAA candidates for the matched/manual
    release plus any distinct releases among the stored review candidates.
    Sync route on purpose (the CAA index fetch sleeps in the shared
    throttle — FastAPI runs `def` routes in the threadpool). One response,
    `pending` always False — the client shows a spinner for the request's own
    latency; offline / CAA-down just means an empty caa tail (the instant
    tiles keep working), never an error."""
    from urllib.parse import quote
    dlc = _get_dlc_dir()
    song_path = _resolve_dlc_path(dlc, filename) if dlc else None
    if song_path is None or not song_path.exists():
        raise HTTPException(status_code=404, detail="unknown song")

    row = appstate.meta_db.get_enrichment(filename) or {}
    has_pack = appstate.song_pack_art_exists(filename)
    art_url = f"/api/song/{quote(filename)}/art"

    # What the plain art route would serve right now — the serve chain's
    # order (override > pack > CAA cache) restated as provenance.
    if appstate.art_override_paths(filename):
        provenance = "yours"
    elif has_pack:
        provenance = "pack"
    elif row.get("art_state") == "caa" and row.get("art_cache_path"):
        provenance = "matched"
    else:
        provenance = "none"

    candidates: list[dict] = [{
        "id": "current", "kind": "current", "label": "Current",
        "thumb_url": art_url, "provenance": provenance,
    }]
    if has_pack:
        candidates.append({
            "id": "pack", "kind": "pack", "label": "Pack original",
            "thumb_url": art_url + "?source=pack", "provenance": "pack",
        })

    # Releases worth asking the archive about: the matched/manual release
    # first (it seeds the best candidates), then any distinct release among
    # the stored review candidates (a review row has no mb_release_id of its
    # own — its releases live in the candidates JSON).
    # Only spend the shared CAA rate budget on rows whose match warrants it:
    # a matched/manual release seeds the best candidates, and a review row's
    # stored candidates are still live proposals. A failed/rejected (or
    # unscanned) row has no accepted match — asking would burn the budget and
    # surface releases already rejected as non-matches. The Current + Pack
    # tiles above serve regardless, so those songs still get a picker.
    rids: list[str] = []
    if row.get("match_state") in ("matched", "manual", "review"):
        if row.get("match_state") in ("matched", "manual") and row.get("mb_release_id"):
            rids.append(str(row["mb_release_id"]))
        for cand in (row.get("candidates") or []):
            rid = str(cand.get("release_id") or "") if isinstance(cand, dict) else ""
            if rid and rid not in rids:
                rids.append(rid)

    caa_entries: list[dict] = []
    for rid in rids:
        if len(caa_entries) >= _ART_PICKER_MAX_CAA:
            break
        try:
            imgs = enrichment._caa_index_cached(rid)
        except enrichment.EnrichTransportError:
            # Offline / archive down — stop asking (each further miss would
            # only burn a timeout). The instant tiles still serve; a later
            # picker-open retries naturally (failures are never cached).
            break
        # Front covers first, approved before pending, otherwise index order
        # (the picker grammar is a RANKED list — §7/§9).
        def _rank(img):
            types = img.get("types") or []
            is_front = bool(img.get("front")) or "Front" in types
            return (not is_front, not bool(img.get("approved")))
        for img in sorted((i for i in imgs if isinstance(i, dict)), key=_rank):
            if len(caa_entries) >= _ART_PICKER_MAX_CAA:
                break
            thumbs = img.get("thumbnails") or {}
            if not isinstance(thumbs, dict):
                continue
            thumb = (thumbs.get("500") or thumbs.get("large")
                     or thumbs.get("250") or thumbs.get("small"))
            if not thumb:
                continue
            types = [str(t) for t in (img.get("types") or []) if isinstance(t, str)]
            caa_entries.append({
                "id": f"caa-{rid}-{img.get('id', '')}",
                "kind": "caa",
                "label": ", ".join(types) or "Cover",
                "thumb_url": str(thumb),
                "provenance": "matched",
                "types": types,
                "approved": bool(img.get("approved")),
                "release_id": rid,
            })

    return {"candidates": candidates + caa_entries, "pending": False}


def _save_art_override(filename: str, img_data: bytes) -> dict:
    """Persist a user art override into the art cache (R3). One override per
    song: GIF input is validated and kept VERBATIM as .gif (animation intact —
    the local-only bonus; it is never written into the pack file), everything
    else is normalized to RGB PNG via PIL. Saving either kind removes the
    other so the serve chain has exactly one user file to find."""
    appstate.art_cache_dir.mkdir(parents=True, exist_ok=True)
    stem = appstate.art_safe_name(filename)
    png_path = appstate.art_cache_dir / f"{stem}.png"
    gif_path = appstate.art_cache_dir / f"{stem}.gif"
    from PIL import Image
    import io as _io
    if img_data[:6] in (b"GIF87a", b"GIF89a"):
        try:
            probe = Image.open(_io.BytesIO(img_data))
            probe.verify()   # decodes headers/frames without keeping the image
            if probe.format != "GIF":
                raise ValueError("not a GIF")
        except Exception as e:
            return {"error": f"Invalid image: {e}"}
        gif_path.write_bytes(img_data)
        png_path.unlink(missing_ok=True)
        return {"ok": True, "kind": "gif"}
    try:
        img = Image.open(_io.BytesIO(img_data)).convert("RGB")
        img.save(str(png_path), "PNG")
    except Exception as e:
        return {"error": f"Invalid image: {e}"}
    gif_path.unlink(missing_ok=True)
    return {"ok": True, "kind": "png"}


@router.post("/api/song/{filename:path}/art/upload")
async def upload_song_art_b64(filename: str, data: dict):
    """Upload a custom cover as base64 (PNG/JPG/WebP → normalized PNG;
    GIF → kept animated, local-only). The override outranks pack art in the
    serve chain; remove it via DELETE …/art/override."""
    import base64
    # Reject art for a filename that doesn't resolve to a real song (mirrors the
    # url route's guard) — no writing stray override files for unknown keys.
    dlc = _get_dlc_dir()
    song_path = _resolve_dlc_path(dlc, filename) if dlc else None
    if song_path is None or not song_path.exists():
        raise HTTPException(status_code=404, detail="unknown song")
    b64 = data.get("image", "")
    if not b64:
        return {"error": "No image data"}
    # Strip data URL prefix if present
    if "," in b64:
        b64 = b64.split(",", 1)[1]
    try:
        img_data = base64.b64decode(b64)
    except Exception:
        return {"error": "Invalid base64"}
    if len(img_data) > _ART_URL_MAX_BYTES:
        raise HTTPException(status_code=400, detail="image larger than 10 MB")
    return _save_art_override(filename, img_data)


# Art-by-URL fetch cap — a cover, not a wallpaper pack.
_ART_URL_MAX_BYTES = 10 * 1024 * 1024


def _url_host_is_internal(url: str) -> bool:
    """True when a user-supplied URL's host resolves to a loopback, private,
    link-local, reserved, multicast or unspecified address — an SSRF target we
    refuse to fetch on the user's behalf (e.g. 169.254.169.254 metadata, LAN
    services). Fails CLOSED: an unresolvable or unparseable host is treated as
    internal. Every resolved address must be public for the URL to pass."""
    from urllib.parse import urlparse
    import socket
    host = urlparse(url).hostname
    if not host:
        return True
    try:
        infos = socket.getaddrinfo(host, None)
    except OSError:
        return True
    if not infos:
        return True
    for info in infos:
        raw = info[4][0].split("%", 1)[0]  # strip any zone id
        try:
            ip = ipaddress.ip_address(raw)
        except ValueError:
            return True
        if (ip.is_private or ip.is_loopback or ip.is_link_local
                or ip.is_reserved or ip.is_multicast or ip.is_unspecified):
            return True
    return False


# Art-by-URL redirect budget. Cover hosts commonly answer with a redirect —
# the Cover Art Archive (whose thumbs the cover picker applies through this
# very route) 307s every image to archive.org — so redirects must work; 5
# hops is generous for any real CDN chain while still bounding the walk.
_ART_URL_MAX_REDIRECTS = 5


def _fetch_art_url(url: str) -> bytes:
    """The one place art-by-URL touches the network (tests fake this seam).
    User-initiated, so not throttled like the background workers — but the
    same offline guard applies (pytest can never fetch), the host is checked
    against internal/reserved ranges (SSRF), redirects are followed MANUALLY
    with the scheme + internal-host guard re-applied to every hop (so a
    redirect can't smuggle the request to an internal target — a blanket
    no-redirect rule would break every Cover Art Archive pick, which always
    redirects to archive.org), and the size cap is enforced while streaming
    so a huge response never fully downloads.

    Residual, accepted: each hop's host is resolved here and again by
    requests, so a rebinding DNS name is a theoretical TOCTOU. Not closed
    with an IP-pinned connection because (a) this is a single-user, no-auth
    app (constitution §I) and the route is demo-blocked, so there is no
    untrusted submission path, and (b) no other in-tree client (MusicBrainz,
    CAA) pins either — a bespoke pinned+SNI adapter here would be
    inconsistent and disproportionate. The cheap guards above still stop the
    realistic vectors (direct internal URL, redirect-to-internal)."""
    if not enrichment._enrich_network_enabled():
        raise enrichment.EnrichTransportError("art fetch disabled (offline)")
    import requests
    from urllib.parse import urljoin, urlparse
    for _hop in range(_ART_URL_MAX_REDIRECTS + 1):
        # Re-validate EVERY hop, not just the user's original URL: the whole
        # point of handling redirects ourselves is that each target gets the
        # same scheme + SSRF gate before any request is made.
        if urlparse(url).scheme not in ("http", "https"):
            raise ValueError("url must be http(s)")
        if _url_host_is_internal(url):
            raise ValueError("url host is not allowed")
        try:
            with requests.get(url, timeout=15, stream=True, allow_redirects=False,
                              headers={"User-Agent": enrichment._enrich_user_agent()}) as resp:
                if resp.status_code in (301, 302, 303, 307, 308):
                    loc = resp.headers.get("Location") or ""
                    if not loc:
                        raise enrichment.EnrichTransportError(
                            f"HTTP {resp.status_code} without a Location")
                    url = urljoin(url, loc)
                    continue
                if resp.status_code != 200:
                    raise enrichment.EnrichTransportError(f"HTTP {resp.status_code}")
                data = b""
                for chunk in resp.iter_content(65536):
                    data += chunk
                    if len(data) > _ART_URL_MAX_BYTES:
                        raise ValueError("image larger than 10 MB")
                return data
        except requests.RequestException as e:
            raise enrichment.EnrichTransportError(str(e)) from e
    raise enrichment.EnrichTransportError("too many redirects")


@router.post("/api/song/{filename:path}/art/url")
def set_song_art_from_url(filename: str, data: dict):
    """Paste-a-link cover art (the media-server idiom): the server fetches the
    image and stores it as this song's local override — identical result to an
    upload, including the GIF-stays-local rule. http(s) only."""
    url = str((data or {}).get("url") or "").strip()
    from urllib.parse import urlparse
    parsed = urlparse(url)
    if parsed.scheme not in ("http", "https") or not parsed.hostname:
        raise HTTPException(status_code=400, detail="url must be http(s)")
    dlc = _get_dlc_dir()
    song_path = _resolve_dlc_path(dlc, filename) if dlc else None
    if song_path is None or not song_path.exists():
        raise HTTPException(status_code=404, detail="unknown song")
    try:
        img_data = _fetch_art_url(url)
    except enrichment.EnrichTransportError as e:
        return JSONResponse({"error": "could not fetch image", "detail": str(e)},
                            status_code=502)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    return _save_art_override(filename, img_data)


@router.delete("/api/art/{filename:path}/override")
def remove_song_art_override(filename: str):
    """Drop the user art override — the serve chain falls back to pack art,
    then the Cover Art Archive cache. Lives under /api/art (NOT /api/song) so
    the greedy DELETE /api/song/{path} catch-all can't shadow it — the same
    dodge the chart split/unsplit routes use."""
    removed = False
    for p in appstate.art_override_paths(filename):
        try:
            p.unlink()
            removed = True
        except OSError:
            pass
    if removed:
        # The art worker may have settled this row as 'user' (override present,
        # no pack art). Reset it so the next enrichment pass re-evaluates and the
        # CAA fallback resumes — otherwise a removed override strands the row
        # (enrichment_art_pending only re-queues art_state IS NULL) and the song
        # is left with no art at all.
        try:
            appstate.meta_db.set_enrichment_art(filename, None, None)
        except Exception:
            log.exception("art override delete: failed to reset enrichment state")
    return {"ok": True, "removed": removed}
