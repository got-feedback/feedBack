"""Career mode — venue progression driven by per-song stars.

Stars come straight from ``song_stats`` (meta.db): per song, the best
accuracy across arrangements crosses 0/1/2/3 of the thresholds in
``venues.json`` (data-driven so tuning never touches code). Cumulative
stars unlock venue tiers (bar → club → arena).

Venue packs (crowd-loop videos rendered offline in UE) are heavyweight and
never ship with the app: ``venues.json`` points at a release asset per
venue, downloaded on demand into ``CONFIG_DIR/plugin_uploads/career/venues/
<id>/`` on a background thread (constitution: nothing heavy inline on the
request path), sha256-verified, then served back with the same
FileResponse/no-cache recipe as highway_3d's custom-video route.

Endpoints (all under /api/plugins/career/):
  GET    /state                       stars + per-venue unlock/install/download status
  POST   /packs/{venue_id}/download   start background pack download (409 if running)
  DELETE /packs/{venue_id}            remove an installed pack
  GET    /venues/{venue_id}/{filename} serve pack files (manifest.json, loops, stingers)
"""

import hashlib
import json
import logging
import re
import shutil
import tempfile
import threading
import urllib.request
import zipfile
from pathlib import Path

from fastapi import HTTPException
from fastapi.responses import FileResponse

PLUGIN_ID = "career"
VENUE_ID_RE = re.compile(r"^[a-z0-9_-]{1,40}$")
PACK_FILENAME_RE = re.compile(r"^[a-z0-9_-]{1,64}\.(mp4|webm|json)$")
REQUIRED_LOOPS = ("bored", "neutral", "engaged", "ecstatic")
DOWNLOAD_CHUNK = 1024 * 256

_lock = threading.Lock()
_state = {
    "content": None,        # parsed venues.json
    "venues_dir": None,     # CONFIG_DIR/plugin_uploads/career/venues
    "meta_db": None,        # MetadataDB (song_stats reads are lock-free / WAL)
    "log": logging.getLogger("feedBack.plugin.career"),
    "downloads": {},        # venue_id -> {status, bytes_done, bytes_total, error}
}


def _venue(venue_id):
    for v in _state["content"]["venues"]:
        if v["id"] == venue_id:
            return v
    return None


def _venue_dir(venue_id) -> Path:
    return _state["venues_dir"] / venue_id


def _installed(venue_id):
    return (_venue_dir(venue_id) / "manifest.json").is_file()


def _stars():
    """(total, per-song dict, detail rows). Accuracy is a 0..1 fraction."""
    db = _state["meta_db"]
    if db is None:
        return 0, {}, []
    thresholds = _state["content"]["star_accuracy_thresholds"]
    # Existing-song filter: a scan hides (not deletes) stats of songs removed
    # from the library, so orphaned rows must not keep counting toward stars.
    rows = db.conn.execute(
        "SELECT s.filename, MAX(s.best_accuracy), "
        "       COALESCE(MAX(sg.title), ''), COALESCE(MAX(sg.artist), '') "
        "FROM song_stats s JOIN songs sg ON sg.filename = s.filename "
        "GROUP BY s.filename"
    ).fetchall()
    per_song = {}
    detail = []
    for filename, acc, title, artist in rows:
        acc = acc or 0.0
        stars = sum(1 for t in thresholds if acc >= t)
        if stars:
            per_song[filename] = stars
        next_at = next((t for t in thresholds if acc < t), None)
        detail.append({
            "filename": filename,
            "title": title or filename,
            "artist": artist,
            "stars": stars,
            "best_accuracy": round(acc, 4),
            "next_star_at": next_at,
        })
    # closest-to-next-star first (a practice worklist), maxed songs last
    detail.sort(key=lambda r: (r["next_star_at"] is None,
                               (r["next_star_at"] or 1.0) - r["best_accuracy"]))
    return sum(per_song.values()), per_song, detail


def _validate_pack_dir(pack_dir: Path):
    """Raise ValueError unless pack_dir holds a complete venue pack."""
    manifest_path = pack_dir / "manifest.json"
    if not manifest_path.is_file():
        raise ValueError("pack has no manifest.json")
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    loops = manifest.get("loops") or {}
    for state in REQUIRED_LOOPS:
        name = loops.get(state)
        if not name or not PACK_FILENAME_RE.match(name):
            raise ValueError(f"manifest is missing the '{state}' loop")
        if not (pack_dir / name).is_file():
            raise ValueError(f"loop file '{name}' missing from pack")
    for name in (manifest.get("stingers") or {}).values():
        if name and (not PACK_FILENAME_RE.match(name) or not (pack_dir / name).is_file()):
            raise ValueError(f"stinger file '{name}' invalid or missing")


def _download_pack(venue_id, pack, progress):
    """Worker thread: stream → sha256 verify → extract → validate → swap in."""
    log = _state["log"]
    final_dir = _venue_dir(venue_id)
    staging = Path(tempfile.mkdtemp(prefix=f"career-{venue_id}-",
                                    dir=str(_state["venues_dir"])))
    zip_path = staging / "pack.zip"
    try:
        digest = hashlib.sha256()
        req = urllib.request.Request(pack["url"], headers={"User-Agent": "feedBack-career"})
        with urllib.request.urlopen(req, timeout=60) as resp, open(zip_path, "wb") as out:
            total = int(resp.headers.get("Content-Length") or pack.get("bytes") or 0)
            progress["bytes_total"] = total
            while True:
                chunk = resp.read(DOWNLOAD_CHUNK)
                if not chunk:
                    break
                digest.update(chunk)
                out.write(chunk)
                progress["bytes_done"] += len(chunk)
        if digest.hexdigest() != pack["sha256"]:
            raise ValueError("sha256 mismatch — corrupt or tampered download")

        extract_dir = staging / "pack"
        extract_dir.mkdir()
        with zipfile.ZipFile(zip_path) as zf:
            for info in zf.infolist():
                # Zip-slip guard: only flat, whitelisted names get extracted.
                if info.is_dir():
                    continue
                name = Path(info.filename).name
                if name != info.filename or not PACK_FILENAME_RE.match(name):
                    raise ValueError(f"unexpected file in pack: {info.filename!r}")
                with zf.open(info) as src, open(extract_dir / name, "wb") as dst:
                    shutil.copyfileobj(src, dst)
        zip_path.unlink()
        _validate_pack_dir(extract_dir)

        if final_dir.exists():
            shutil.rmtree(final_dir)
        extract_dir.rename(final_dir)
        progress["status"] = "done"
        log.info("career: venue pack '%s' installed", venue_id)
    except Exception as exc:  # noqa: BLE001 — surface any failure to the UI
        progress["status"] = "error"
        progress["error"] = str(exc)
        log.warning("career: venue pack '%s' download failed: %s", venue_id, exc)
    finally:
        shutil.rmtree(staging, ignore_errors=True)


def setup(app, context):
    plugin_dir = Path(__file__).resolve().parent
    _state["content"] = json.loads((plugin_dir / "venues.json").read_text(encoding="utf-8"))
    _state["venues_dir"] = (
        Path(context["config_dir"]) / "plugin_uploads" / PLUGIN_ID / "venues")
    _state["venues_dir"].mkdir(parents=True, exist_ok=True)
    _state["meta_db"] = context.get("meta_db")
    _state["log"] = context.get("log") or _state["log"]

    @app.get(f"/api/plugins/{PLUGIN_ID}/state")
    def get_state():
        stars_total, per_song, star_detail = _stars()
        venues = []
        for v in _state["content"]["venues"]:
            with _lock:
                dl = dict(_state["downloads"].get(v["id"]) or {"status": "idle"})
            venues.append({
                "id": v["id"],
                "name": v["name"],
                "description": v.get("description", ""),
                "star_threshold": v["star_threshold"],
                "unlocked": stars_total >= v["star_threshold"],
                "installed": _installed(v["id"]),
                "has_pack": bool(v.get("pack")),
                "download": dl,
            })
        return {
            "stars_total": stars_total,
            "stars_per_song": per_song,
            "star_detail": star_detail,
            "star_accuracy_thresholds": _state["content"]["star_accuracy_thresholds"],
            "venues": venues,
        }

    @app.post(f"/api/plugins/{PLUGIN_ID}/packs/{{venue_id}}/download")
    def start_download(venue_id: str):
        venue = _venue(venue_id) if VENUE_ID_RE.match(venue_id) else None
        if venue is None:
            raise HTTPException(404, "Unknown venue.")
        pack = venue.get("pack")
        if not pack:
            raise HTTPException(404, "No pack published for this venue yet.")
        stars_total, _, _ = _stars()
        if stars_total < venue["star_threshold"]:
            raise HTTPException(403, "Venue not unlocked yet.")
        with _lock:
            running = _state["downloads"].get(venue_id)
            if running and running["status"] == "running":
                raise HTTPException(409, "Download already running.")
            progress = {"status": "running", "bytes_done": 0,
                        "bytes_total": pack.get("bytes") or 0, "error": None}
            _state["downloads"][venue_id] = progress
        threading.Thread(target=_download_pack, args=(venue_id, pack, progress),
                         name=f"career-pack-{venue_id}", daemon=True).start()
        return {"ok": True}

    @app.delete(f"/api/plugins/{PLUGIN_ID}/packs/{{venue_id}}")
    def delete_pack(venue_id: str):
        if not VENUE_ID_RE.match(venue_id) or _venue(venue_id) is None:
            raise HTTPException(404, "Unknown venue.")
        with _lock:
            running = _state["downloads"].get(venue_id)
            if running and running["status"] == "running":
                raise HTTPException(409, "Download in progress.")
            _state["downloads"].pop(venue_id, None)
        shutil.rmtree(_venue_dir(venue_id), ignore_errors=True)
        return {"ok": True}

    @app.get(f"/api/plugins/{PLUGIN_ID}/venues/{{venue_id}}/{{filename}}")
    async def get_pack_file(venue_id: str, filename: str):
        if not VENUE_ID_RE.match(venue_id) or not PACK_FILENAME_RE.match(filename):
            raise HTTPException(404, "Not found.")
        path = _venue_dir(venue_id) / filename
        # Defense-in-depth beyond the regexes (same recipe as highway_3d):
        # the resolved path must stay inside the venues dir.
        try:
            resolved = path.resolve()
            resolved.relative_to(_state["venues_dir"].resolve())
        except (OSError, ValueError):
            raise HTTPException(404, "Not found.")
        if not resolved.is_file():
            raise HTTPException(404, "Not found.")
        media = {"mp4": "video/mp4", "webm": "video/webm",
                 "json": "application/json"}[resolved.suffix.lstrip(".").lower()]
        return FileResponse(
            resolved,
            media_type=media,
            # Pack files are immutable per version, but a re-download after a
            # pack update overwrites in place — no-cache + ETag revalidation
            # keeps browsers honest for the price of a 304.
            headers={"Cache-Control": "no-cache",
                     "X-Content-Type-Options": "nosniff"},
        )
