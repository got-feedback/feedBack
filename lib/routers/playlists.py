"""Playlists + custom playlist covers (fee[dB]ack v0.3.0).

Extracted verbatim from ``server.py`` (R3). Edits: ``@app`` -> ``@router``,
``meta_db`` -> ``appstate.meta_db``, ``CONFIG_DIR`` -> ``appstate.config_dir``
(both read at call time through the seam), and ``_clean_str`` now imports from
``reqfields``. See ``appstate.py``.
"""

from pathlib import Path

from fastapi import APIRouter
from fastapi.responses import FileResponse, JSONResponse

import appstate
from reqfields import _clean_str

router = APIRouter()

# Cache policy for the custom-cover file response: revalidate every time so a
# replaced cover is never served stale (pairs with the mtime-ns URL token).
_ART_CACHE_HEADERS = {"Cache-Control": "no-cache"}


def _playlist_cover_path(pid) -> Path | None:
    """Filesystem path of a playlist's optional custom cover image (PNG),
    stored under CONFIG_DIR. Returns None for a non-integer id."""
    try:
        pid = int(pid)
    except (TypeError, ValueError):
        return None
    return appstate.config_dir / "playlist_covers" / f"{pid}.png"


def _playlist_cover_url(pid) -> str | None:
    cover = _playlist_cover_path(pid)
    if not cover or not cover.exists():
        return None
    try:
        # Nanosecond mtime so a same-second replace/remove/re-upload still
        # changes the cache-bust token (int seconds could collide → stale image).
        mt = cover.stat().st_mtime_ns
    except OSError:
        mt = 0
    return f"/api/playlists/{pid}/cover?v={mt}"


@router.get("/api/playlists")
def api_list_playlists():
    lists = appstate.meta_db.list_playlists()
    for pl in lists:
        pl["cover_url"] = _playlist_cover_url(pl["id"])
    return lists


@router.post("/api/playlists")
def api_create_playlist(data: dict):
    name = _clean_str(data.get("name"))
    if not (1 <= len(name) <= 100):
        return JSONResponse({"error": "Playlist name must be 1–100 characters."}, status_code=400)
    # kind='album' = a curated album (§7.2): hand-picked works, a chosen chart
    # per slot, played front-to-back on the queue. Absent/None = a regular mix.
    kind = _clean_str(data.get("kind")) or None
    if kind not in (None, "album"):
        return JSONResponse({"error": "kind must be 'album' or omitted"}, status_code=400)
    return appstate.meta_db.create_playlist(name, kind=kind)


@router.get("/api/playlists/{pid}")
def api_get_playlist(pid: int):
    pl = appstate.meta_db.get_playlist(pid)
    if pl is None:
        return JSONResponse({"error": "not found"}, status_code=404)
    pl["cover_url"] = _playlist_cover_url(pid)
    return pl


@router.patch("/api/playlists/{pid}")
def api_rename_playlist(pid: int, data: dict):
    pl = appstate.meta_db.get_playlist(pid)
    if pl is None:
        return JSONResponse({"error": "not found"}, status_code=404)
    if pl["system_key"]:
        return JSONResponse({"error": "System playlists cannot be renamed."}, status_code=400)
    name = _clean_str(data.get("name"))
    if not (1 <= len(name) <= 100):
        return JSONResponse({"error": "Playlist name must be 1–100 characters."}, status_code=400)
    appstate.meta_db.rename_playlist(pid, name)
    return appstate.meta_db.get_playlist(pid)


@router.delete("/api/playlists/{pid}")
def api_delete_playlist(pid: int):
    pl = appstate.meta_db.get_playlist(pid)
    if pl is None:
        return JSONResponse({"error": "not found"}, status_code=404)
    if pl["system_key"]:
        return JSONResponse({"error": "System playlists cannot be deleted."}, status_code=400)
    if not appstate.meta_db.delete_playlist(pid):   # vanished under us (concurrent delete)
        return JSONResponse({"error": "not found"}, status_code=404)
    cover = _playlist_cover_path(pid)       # drop any custom cover with the playlist
    if cover and cover.exists():
        try:
            cover.unlink()
        except OSError:
            pass
    return {"ok": True}


@router.post("/api/playlists/{pid}/songs")
def api_add_playlist_song(pid: int, data: dict):
    if appstate.meta_db.get_playlist(pid) is None:
        return JSONResponse({"error": "not found"}, status_code=404)
    filename = _clean_str(data.get("filename"))
    if not filename:
        return JSONResponse({"error": "filename required"}, status_code=400)
    if appstate.meta_db.add_playlist_song(pid, filename) is None:   # playlist vanished under us
        return JSONResponse({"error": "not found"}, status_code=404)
    pl = appstate.meta_db.get_playlist(pid)
    return pl if pl is not None else JSONResponse({"error": "not found"}, status_code=404)


@router.patch("/api/playlists/{pid}/songs/{filename:path}")
def api_update_playlist_slot(pid: int, filename: str, data: dict):
    """Edit one curated-album slot: {"arrangement": name|null} pins/clears the
    slot's arrangement; {"chart_filename": fn} swaps the slot to another chart
    of the same work (position + pin kept). Albums only — a mix has no slots."""
    pl = appstate.meta_db.get_playlist(pid)
    if pl is None:
        return JSONResponse({"error": "not found"}, status_code=404)
    if pl.get("kind") != "album":
        return JSONResponse({"error": "Slot editing is for albums."}, status_code=400)
    kwargs = {}
    if "chart_filename" in data:
        new_fn = _clean_str(data.get("chart_filename"))
        if not new_fn:
            return JSONResponse({"error": "chart_filename must be a filename"}, status_code=400)
        kwargs["new_filename"] = new_fn
    if "arrangement" in data:
        arr = data.get("arrangement")
        if arr is not None and not (isinstance(arr, str) and 1 <= len(arr.strip()) <= 100):
            return JSONResponse({"error": "arrangement must be a name or null"}, status_code=400)
        kwargs["arrangement"] = arr.strip() if isinstance(arr, str) else None
    if not kwargs:
        return JSONResponse({"error": "nothing to update"}, status_code=400)
    if appstate.meta_db.update_playlist_slot(pid, filename, **kwargs) is None:
        return JSONResponse(
            {"error": "no such slot, or the chart isn't a version of this song"},
            status_code=400)
    return appstate.meta_db.get_playlist(pid)


@router.delete("/api/playlists/{pid}/songs/{filename:path}")
def api_remove_playlist_song(pid: int, filename: str):
    if appstate.meta_db.get_playlist(pid) is None:
        return JSONResponse({"error": "not found"}, status_code=404)
    appstate.meta_db.remove_playlist_song(pid, filename)
    pl = appstate.meta_db.get_playlist(pid)
    return pl if pl is not None else JSONResponse({"error": "not found"}, status_code=404)


@router.post("/api/playlists/{pid}/reorder")
def api_reorder_playlist(pid: int, data: dict):
    pl = appstate.meta_db.get_playlist(pid)
    if pl is None:
        return JSONResponse({"error": "not found"}, status_code=404)
    order = data.get("order")
    if not isinstance(order, list) or not all(isinstance(f, str) for f in order):
        return JSONResponse({"error": "order must be a list of filenames"}, status_code=400)
    # Require an exact permutation of the playlist's current songs: a list with
    # duplicates, omissions, or extras would otherwise produce duplicate
    # positions / a partial reorder while still returning 200.
    current = [s["filename"] for s in pl["songs"]]
    if len(order) != len(current) or sorted(order) != sorted(current):
        return JSONResponse(
            {"error": "order must be a permutation of the playlist's current songs"},
            status_code=400,
        )
    appstate.meta_db.reorder_playlist(pid, order)
    return appstate.meta_db.get_playlist(pid)


@router.post("/api/playlists/{pid}/cover")
async def api_set_playlist_cover(pid: int, data: dict):
    """Set a playlist's custom cover from a base64 / data-URL image (PNG/JPG).
    Overrides the content-dependent (song-art) cover. Stored as a small PNG
    thumbnail under CONFIG_DIR/playlist_covers/."""
    if appstate.meta_db.get_playlist(pid) is None:
        return JSONResponse({"error": "not found"}, status_code=404)
    import base64
    import io
    b64 = data.get("image", "")
    # Guard the type before the `","` membership test — a non-string image
    # (e.g. {"image": 123} / null) would otherwise raise TypeError → 500.
    # Mirrors the avatar/song-art upload guard.
    if not isinstance(b64, str) or not b64:
        return JSONResponse({"error": "No image data"}, status_code=400)
    if "," in b64:
        b64 = b64.split(",", 1)[1]
    if not b64:
        return JSONResponse({"error": "No image data"}, status_code=400)
    try:
        img_data = base64.b64decode(b64)
    except Exception:
        return JSONResponse({"error": "Invalid base64"}, status_code=400)
    cover = _playlist_cover_path(pid)
    cover.parent.mkdir(parents=True, exist_ok=True)
    try:
        from PIL import Image
        img = Image.open(io.BytesIO(img_data)).convert("RGB")
        img.thumbnail((640, 640))                  # covers stay small
        tmp = cover.with_suffix(".png.tmp")
        img.save(str(tmp), "PNG")
        tmp.replace(cover)
    except Exception as e:
        return JSONResponse({"error": f"Invalid image: {e}"}, status_code=400)
    return {"ok": True, "cover_url": _playlist_cover_url(pid)}


@router.get("/api/playlists/{pid}/cover")
def api_get_playlist_cover(pid: int):
    cover = _playlist_cover_path(pid)
    if not cover or not cover.exists():
        return JSONResponse({"error": "not found"}, status_code=404)
    # no-cache (revalidate) like song art, so a replaced cover is never served
    # stale — pairs with the mtime-ns cache-bust token on the URL.
    return FileResponse(str(cover), media_type="image/png", headers=_ART_CACHE_HEADERS)


@router.delete("/api/playlists/{pid}/cover")
def api_delete_playlist_cover(pid: int):
    cover = _playlist_cover_path(pid)
    if cover and cover.exists():
        try:
            cover.unlink()
        except OSError:
            pass
    return {"ok": True}
