"""Artist aliases / Tidy-up (P4) — canonicalize messy artist tags at DISPLAY
("ACDC" -> "AC/DC") without touching feedpak files or the scanner-derived
songs.artist. All DB-only.

Extracted verbatim from ``server.py`` (R3); only the decorator receiver
(``@app`` -> ``@router``) and the singleton read (``meta_db`` ->
``appstate.meta_db``) changed. The read stays a module attribute so a re-imported
``server`` re-publishes a fresh DB into the seam — see ``appstate.py``.
"""

from fastapi import APIRouter
from fastapi.responses import JSONResponse

import appstate

router = APIRouter()


@router.get("/api/artist-aliases")
def list_artist_aliases():
    """Existing raw→canonical overrides (the Tidy-up 'current merges' list)."""
    return {"aliases": appstate.meta_db.list_artist_aliases()}


@router.get("/api/artists/raw")
def list_raw_artists(limit: int = 2000):
    """Distinct RAW artist names + song counts + current canonical — the Tidy-up
    picker (you merge raw variants into one canonical)."""
    return {"artists": appstate.meta_db.raw_artists(limit)}


@router.post("/api/artist-aliases")
def set_artist_alias(data: dict):
    """Upsert one override: {raw_name, canonical_name, mb_artist_id?}. A self-alias
    (raw == canonical) clears the row instead (un-merge)."""
    raw = (data.get("raw_name") or "").strip()
    canon = (data.get("canonical_name") or "").strip()
    if not raw or not canon:
        return JSONResponse({"error": "raw_name and canonical_name are required"}, 400)
    result = appstate.meta_db.set_artist_alias(raw, canon, (data.get("mb_artist_id") or None))
    if not result.get("ok"):
        # Would form a cycle (raw → … → raw) — refuse rather than corrupt the chain.
        return JSONResponse(
            {"error": "alias would create a cycle", "raw_name": raw, "canonical_name": canon},
            409)
    return {"ok": True, "raw_name": raw, "canonical_name": result.get("canonical_name", canon)}


@router.post("/api/artist-aliases/merge")
def merge_artist_aliases(data: dict):
    """Merge several raw artist variants into one canonical:
    {raw_names: [...], canonical_name}. The canonical's own self-alias is skipped.
    Returns {merged: N}."""
    canon = (data.get("canonical_name") or "").strip()
    raws = data.get("raw_names")
    if not canon:
        return JSONResponse({"error": "canonical_name is required"}, 400)
    if not isinstance(raws, list) or not raws:
        return JSONResponse({"error": "raw_names must be a non-empty array"}, 400)
    n = appstate.meta_db.merge_artists(raws, canon)
    return {"merged": n, "canonical_name": canon}


@router.delete("/api/artist-aliases/{raw_name:path}")
def delete_artist_alias(raw_name: str):
    """Remove one override so that raw artist stands on its own again."""
    appstate.meta_db.remove_artist_alias(raw_name)
    return {"ok": True}
