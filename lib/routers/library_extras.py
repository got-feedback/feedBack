"""Small meta_db-backed library / user-state endpoints — work keeper-chart
prefs, favorites, personal tags, saved-for-later, and continue-playing.

Extracted verbatim from ``server.py`` (R3); edits: ``@app`` -> ``@router``,
``meta_db`` -> ``appstate.meta_db``, ``_clean_str`` from ``reqfields``. All paths
are distinct and non-overlapping, so mounting them together (rather than at each
original scattered site) does not change routing.
"""

from fastapi import APIRouter
from fastapi.responses import JSONResponse

import appstate
from reqfields import _clean_str

router = APIRouter()


@router.get("/api/work/{work_key:path}/charts")
def api_get_work_charts(work_key: str):
    """All charts in a work + which is the keeper (your pick vs auto-pick)."""
    return appstate.meta_db.work_charts(work_key)


@router.put("/api/work/{work_key:path}/preferred")
def api_set_work_preferred(work_key: str, data: dict):
    """Set the keeper chart of a work: body {filename}. The filename must be a
    current member of the work. Returns the refreshed chart list."""
    fn = (data.get("filename") or "").strip()
    if not fn:
        return JSONResponse({"error": "filename is required"}, 400)
    members = {c["filename"] for c in appstate.meta_db.work_charts(work_key)["charts"]}
    if fn not in members:
        return JSONResponse({"error": "filename is not a chart of this work"}, 400)
    appstate.meta_db.set_chart_preferred(work_key, fn)
    return appstate.meta_db.work_charts(work_key)


@router.delete("/api/work/{work_key:path}/preferred")
def api_reset_work_preferred(work_key: str):
    """Reset a work to auto-pick (drop the explicit preferred)."""
    appstate.meta_db.clear_chart_preferred(work_key)
    return appstate.meta_db.work_charts(work_key)


@router.post("/api/favorites/toggle")
def toggle_favorite(data: dict):
    """Toggle a song's favorite status."""
    filename = data.get("filename", "")
    if not filename:
        return {"error": "No filename"}
    new_state = appstate.meta_db.toggle_favorite(filename)
    return {"favorite": new_state}


@router.get("/api/tags")
def list_tags():
    """All personal tags in use (over still-present songs), most-used first —
    powers the tag filter UI."""
    return {"tags": appstate.meta_db.all_tags()}


@router.post("/api/saved/toggle")
def api_toggle_saved(data: dict):
    """Add/remove a song on the reserved Saved-for-Later playlist."""
    filename = _clean_str(data.get("filename"))
    if not filename:
        return JSONResponse({"error": "filename required"}, status_code=400)
    return {"saved": appstate.meta_db.toggle_saved(filename)}


@router.get("/api/session/continue")
def api_session_continue():
    """The Continue-Playing card's song (most recent play) or null."""
    return appstate.meta_db.continue_session()
