"""Chart-level endpoints — split/unsplit a chart from its work, resolve work
membership, and the context-menu "Get info" file inspector.

Extracted verbatim from ``server.py`` (R3); edits: ``@app`` -> ``@router``,
``meta_db`` -> ``appstate.meta_db``. DLC path resolution comes from
``dlc_paths``; sloppak/loose detection from the shared lib modules.
"""

from fastapi import APIRouter, HTTPException

import appstate
from dlc_paths import _get_dlc_dir, _resolve_dlc_path
import sloppak as sloppak_mod
import loosefolder as loosefolder_mod

router = APIRouter()


@router.post("/api/chart/{filename:path}/split")
def api_split_chart(filename: str):
    """'These aren't the same song' — split this chart out as its own singleton
    work. Under /api/chart (NOT /api/song) so the DELETE /api/song/{path}
    catch-all can't shadow it."""
    key = appstate.meta_db._canonical_song_filename(filename)
    appstate.meta_db.split_chart(key)
    return {"ok": True, "filename": key}


@router.post("/api/chart/{filename:path}/unsplit")
def api_unsplit_chart(filename: str):
    """Undo a split — rejoin the chart to its work."""
    key = appstate.meta_db._canonical_song_filename(filename)
    appstate.meta_db.unsplit_chart(key)
    return {"ok": True, "filename": key}


@router.get("/api/chart/{filename:path}/work")
def api_get_chart_work(filename: str):
    """Resolve a chart's work membership: {work_key, chart_count}. For openers
    on rows that came from an ungrouped query (the tree view) — grouped grid
    rows already carry both fields inline."""
    return appstate.meta_db.chart_work(filename)


@router.get("/api/chart/{filename:path}/fileinfo")
def api_chart_fileinfo(filename: str):
    """The context menu's "Get info": where the file lives + what the pack
    contains. Under /api/chart — the GET /api/song/{path} catch-all would
    swallow a /api/song/…/fileinfo suffix. Read-only; demo-mode blocks it
    because it exposes filesystem paths."""
    dlc = _get_dlc_dir()
    if not dlc:
        raise HTTPException(status_code=404, detail="not configured")
    p = _resolve_dlc_path(dlc, filename)
    if p is None:
        raise HTTPException(status_code=403, detail="forbidden")
    if not p.exists():
        raise HTTPException(status_code=404, detail="not found")
    # Restrict to actual charts — sloppak or loose song. Without this the route
    # would stat ANY file the user happens to keep under DLC_DIR (e.g. notes),
    # leaking its path/size; the app only recognises these two song formats.
    is_pak = sloppak_mod.is_sloppak(p)
    is_loose = loosefolder_mod.is_loose_song(p)
    if not (is_pak or is_loose):
        raise HTTPException(status_code=404, detail="not a chart")
    st = p.stat()
    info = {
        "filename": filename,
        "path": str(p),
        "folder": str(p.parent),
        "format": "sloppak" if is_pak else "loose",
        # Directory-form songs report the tree's total (covers loose folders
        # and dir-form paks); zip-form paks report the archive size. Symlinked
        # entries are skipped so a link inside the folder can't pull in — or
        # leak the size of — a file outside it.
        "size": (st.st_size if p.is_file()
                 else sum(f.stat().st_size for f in p.rglob("*")
                          if f.is_file() and not f.is_symlink())),
        "mtime": st.st_mtime,
    }
    if is_pak:
        try:
            m = sloppak_mod.load_manifest(p) or {}
        except Exception:
            m = {}
        arrs = [str(a.get("name", a.get("id", ""))) for a in (m.get("arrangements") or [])
                if isinstance(a, dict)]
        stems = [str(s.get("id", "")) for s in (m.get("stems") or []) if isinstance(s, dict)]
        try:
            has_cover = sloppak_mod.read_cover_bytes(p, m) is not None
        except Exception:
            has_cover = False
        # The optional identity/catalog keys, listed only when present — the
        # Get-info panel's "what this pack carries vs what's missing" readout.
        identity = {k: m.get(k) for k in
                    ("mbid", "isrc", "genres", "track", "disc", "album_artist",
                     "feedpak_version", "language")
                    if m.get(k) not in (None, "", [])}
        info["manifest"] = {
            "title": str(m.get("title", "")), "artist": str(m.get("artist", "")),
            "album": str(m.get("album", "")), "year": str(m.get("year", "") or ""),
            "arrangements": arrs, "stems": stems,
            "has_cover": has_cover, "has_lyrics": bool(m.get("lyrics")),
            "authors": [a.get("name", "") if isinstance(a, dict) else str(a)
                        for a in (m.get("authors") or [])],
            "identity": identity,
        }
    # The enrichment verdict, so Get info can say "Matched (auto, 96%)" /
    # "Pinned by you" / "Not matched" alongside the file facts.
    row = appstate.meta_db.get_enrichment(filename)
    if row:
        info["match"] = {k: row.get(k) for k in
                         ("match_state", "match_source", "match_score",
                          "canon_artist", "canon_title", "canon_album", "canon_year")}
    return info
