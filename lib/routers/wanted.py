"""Wishlist / "wanted" API (feedBack#636) — songs the user wants but doesn't own.

Extracted verbatim from ``server.py`` (R3); edits: ``@app`` -> ``@router``,
``meta_db`` -> ``appstate.meta_db``, ``_clean_str`` from ``reqfields``.
"""

from fastapi import APIRouter
from fastapi.responses import JSONResponse

import appstate
from reqfields import _clean_str

router = APIRouter()


@router.get("/api/wanted")
def api_list_wanted():
    """The wishlist — songs the user wants but doesn't own yet (newest first)."""
    return {"wanted": appstate.meta_db.list_wanted()}


@router.post("/api/wanted")
def api_add_wanted(data: dict):
    """Add a not-owned song to the wishlist. `artist`/`title` are required (at
    least one non-empty); `source`/`source_ref`/`note` are optional. Idempotent
    on identity so producers (find_more ownership-diff, manual add) can re-post."""
    if not isinstance(data, dict):
        return JSONResponse({"error": "body must be an object"}, status_code=400)
    artist = _clean_str(data.get("artist"))
    title = _clean_str(data.get("title"))
    if not artist and not title:
        return JSONResponse({"error": "artist or title required"}, status_code=400)
    row = appstate.meta_db.add_wanted(
        artist=artist, title=title,
        source=_clean_str(data.get("source")) or "manual",
        source_ref=_clean_str(data.get("source_ref")),
        note=_clean_str(data.get("note")),
    )
    return {"ok": True, "wanted": row}


@router.delete("/api/wanted/{wanted_id}")
def api_remove_wanted(wanted_id: int):
    """Remove a wishlist entry by id."""
    return {"ok": appstate.meta_db.remove_wanted(wanted_id)}
