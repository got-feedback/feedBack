"""Career mode — venue progression driven by per-song stars.

Stars come straight from ``song_stats`` (meta.db): per song, the best
accuracy across arrangements crosses 0/1/2/3 of the thresholds in
``venues.json`` (data-driven so tuning never touches code). Cumulative
stars unlock venue tiers (bar → club → arena).

Venue packs (crowd-loop videos rendered offline in UE) may be bundled with
the plugin under ``venue-packs/<id>/`` or downloaded on demand into
``CONFIG_DIR/plugin_uploads/career/venues/<id>/``. Downloaded packs override
bundled packs so release assets can replace a built-in starter venue.

Passports (badge journey per instrument × genre — the identity layer on top
of the same stars): badges are COMPUTED on read from ``song_stats`` × the
library's effective genre, never stored. The only persisted career state is
what cannot be derived — instrument commitment, opened passports, and the
relayed virtuoso drill snapshot — as JSON under ``CONFIG_DIR/career/``
(exported via ``settings.server_files``).

Endpoints (all under /api/plugins/career/):
  GET    /state                       stars + per-venue unlock/install/download status
  POST   /packs/{venue_id}/download   start background pack download (409 if running)
  DELETE /packs/{venue_id}            remove an installed pack
  GET    /venues/{venue_id}/{filename} serve pack files (manifest.json, loops, stingers)
  GET    /passports                   passport walls: badges, stubs, genres, drill status
  POST   /passports/commit            commit to an instrument (the wax seal, Stage 0)
  POST   /passports/open              open a genre passport for an instrument
  POST   /drill-state                 relayed virtuoso.progress snapshot (drill intake)
  POST   /gigs/propose                build a playable setlist for a genre gig
  POST   /gigs                        log a COMPLETED gig (abandoned sets never log)
"""

import hashlib
import json
import logging
import random
import re
import shutil
import tempfile
import threading
import urllib.request
import zipfile
from datetime import datetime, timezone
from pathlib import Path

from fastapi import Body, HTTPException
from fastapi.responses import FileResponse

import sloppak
from dlc_paths import _resolve_dlc_path
from progression import instrument_for_arrangement

PLUGIN_ID = "career"
VENUE_ID_RE = re.compile(r"^[a-z0-9_-]{1,40}$")
PACK_FILENAME_RE = re.compile(r"^[a-z0-9_-]{1,64}\.(mp4|webm|mp3|json)$")
REQUIRED_LOOPS = ("bored", "neutral", "engaged", "ecstatic")
DOWNLOAD_CHUNK = 1024 * 256
# A setlist is a handful of songs; this endpoint unpacks zips, so cap the work an
# arbitrary caller can ask for.
MAX_GIG_SONGS = 32

_lock = threading.Lock()
_state = {
    "content": None,        # parsed venues.json
    "plugin_dir": None,     # plugin root; bundled packs live below it
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


def _bundled_venue_dir(venue_id) -> Path:
    return _state["plugin_dir"] / "venue-packs" / venue_id


def _pack_dir(venue_id):
    """Runtime pack location: downloaded override first, bundled fallback."""
    local = _venue_dir(venue_id)
    if (local / "manifest.json").is_file():
        return local
    bundled = _bundled_venue_dir(venue_id)
    if (bundled / "manifest.json").is_file():
        return bundled
    return local


def _installed(venue_id):
    return (_pack_dir(venue_id) / "manifest.json").is_file()


def _bundled(venue_id):
    return (_bundled_venue_dir(venue_id) / "manifest.json").is_file()


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
        stars, next_at = _star_progress(acc, thresholds)
        if stars:
            per_song[filename] = stars
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


# ── Passports ─────────────────────────────────────────────────────────────────

GENRE_MAX_LEN = 64
DRILL_SNAPSHOT_MAX_BYTES = 256 * 1024


def _now_iso():
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def _genre_display(genre):
    return " ".join(str(genre or "").strip().split())


def _genre_key(genre):
    return _genre_display(genre).lower()


def _state_file() -> Path:
    return _state["state_dir"] / "passports-state.json"


def _drill_file() -> Path:
    return _state["state_dir"] / "drill-state.json"


def _load_json(path: Path, default):
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return default


def _save_json(path: Path, obj):
    tmp = path.with_name(path.name + ".tmp")
    tmp.write_text(json.dumps(obj, indent=2), encoding="utf-8")
    tmp.replace(path)


def _career_state():
    st = _load_json(_state_file(), {})
    if not isinstance(st, dict):
        st = {}
    if not isinstance(st.get("instruments"), dict):
        st["instruments"] = {}
    if not isinstance(st.get("passports"), dict):
        st["passports"] = {}
    return st


def _genre_expr(db):
    # Reuse the host's override-aware effective-genre SQL (Fix-metadata popup
    # overrides); plain `genre` on stand-ins that don't implement it.
    fn = getattr(db, "_effective_genre_expr", None)
    return fn() if callable(fn) else "genre"


def _instrument_of(arrangements, arrangement):
    """Progression's arrangement→instrument mapping, via the song_stats
    arrangement index into the song's arrangements JSON."""
    entry = None
    try:
        idx = int(arrangement)
        if isinstance(arrangements, list) and 0 <= idx < len(arrangements):
            entry = arrangements[idx]
    except (TypeError, ValueError):
        entry = None
    return instrument_for_arrangement(entry)


def _played_by_instrument_genre():
    """((instrument, genre_key) → {filename: stub dict},
        (instrument, genre_key) → total played seconds).
    Best accuracy per (instrument, song); seconds sum across every
    arrangement row; the JOIN keeps the same dead-song filter as _stars()."""
    db = _state["meta_db"]
    if db is None:
        return {}, {}
    thresholds = _state["content"]["star_accuracy_thresholds"]
    rows = db.conn.execute(
        "SELECT s.filename, s.arrangement, s.best_accuracy, s.last_played_at, "
        "       s.seconds_total, songs.title, songs.artist, songs.arrangements, "
        f"      {_genre_expr(db)} "
        "FROM song_stats s JOIN songs ON songs.filename = s.filename"
    ).fetchall()
    arrs_cache = {}
    out = {}
    seconds = {}
    for filename, arrangement, acc, played_at, secs, title, artist, arrs_json, genre in rows:
        gkey = _genre_key(genre)
        if not gkey:
            continue
        if filename not in arrs_cache:
            try:
                arrs_cache[filename] = json.loads(arrs_json) if arrs_json else None
            except (TypeError, ValueError):
                arrs_cache[filename] = None
        instrument = _instrument_of(arrs_cache[filename], arrangement)
        key = (instrument, gkey)
        seconds[key] = seconds.get(key, 0.0) + (secs or 0.0)
        acc = acc or 0.0
        stub = out.setdefault(key, {}).get(filename)
        if stub is None:
            out[key][filename] = {
                "filename": filename,
                "title": title or filename,
                "artist": artist or "",
                "best_accuracy": acc,
                "last_played_at": played_at,
            }
        else:
            stub["best_accuracy"] = max(stub["best_accuracy"], acc)
            stub["last_played_at"] = max(stub["last_played_at"] or "", played_at or "") or None
    for stubs in out.values():
        for stub in stubs.values():
            acc = stub["best_accuracy"]
            stub["best_accuracy"] = round(acc, 4)
            stub["stars"], stub["next_star_at"] = _star_progress(acc, thresholds)
    return out, seconds


def _star_progress(acc, thresholds):
    """(stars, next_star_at) — the one place the ascending-thresholds
    assumption lives; _stars() and the passport stubs both use it."""
    stars = sum(1 for t in thresholds if acc >= t)
    next_at = next((t for t in thresholds if acc < t), None)
    return stars, next_at


def _library_genres():
    """Distinct effective genres across the live library (the brochure rack)."""
    db = _state["meta_db"]
    if db is None:
        return []
    rows = db.conn.execute(
        f"SELECT {_genre_expr(db)} AS g, COUNT(*) FROM songs GROUP BY g").fetchall()
    by_key = {}
    for genre, count in rows:
        display = _genre_display(genre)
        key = display.lower()
        if not key:
            continue
        cur = by_key.get(key)
        if cur:  # case-variant duplicates collapse onto the first-seen casing
            cur["songs_in_library"] += count
        else:
            by_key[key] = {"genre_key": key, "genre": display,
                           "songs_in_library": count}
    return sorted(by_key.values(),
                  key=lambda r: (-r["songs_in_library"], r["genre_key"]))


def _genre_family(gkey):
    """First family whose keyword appears in the genre key (substring — MB's
    vocabulary is open: 'metalcore' must hit the 'metal' family without an
    exact alias). List order decides ambiguity: families are checked top to
    bottom, so 'blues rock' lands on whichever of blues/rock is listed first."""
    for fam in _state["passports_content"].get("families") or []:
        if not isinstance(fam, dict):
            continue
        for kw in fam.get("match") or []:
            if isinstance(kw, str) and kw and kw in gkey:
                return fam.get("key")
    return None


def _badge_requirement(gkey, instrument="guitar"):
    cfg = _state["passports_content"]
    req = dict(cfg.get("badge_requirement") or {})
    req.setdefault("songs", 5)
    req.setdefault("min_stars", 2)
    # Exact per-genre override wins; otherwise the genre inherits its FAMILY's
    # requirement — so 'death metal' / 'metalcore' passports carry the metal
    # drill without curating every MB sub-genre by hand.
    genres_cfg = cfg.get("genres") or {}
    override = genres_cfg.get(gkey)
    if not isinstance(override, dict):
        family = _genre_family(gkey)
        override = genres_cfg.get(family) if family else None
    if isinstance(override, dict):
        req.update(override)
    # virtuoso_nodes: {instrument: [node_ids]} — a passport only carries its
    # own instrument's drills. A flat list keeps meaning guitar (back-compat;
    # virtuoso's drill content is guitar-first).
    nodes = req.get("virtuoso_nodes") or []
    if isinstance(nodes, dict):
        nodes = nodes.get(instrument) or []
    elif instrument != "guitar":
        nodes = []
    req["virtuoso_nodes"] = [n for n in nodes if isinstance(n, str)]
    return req


def _drill_by_node():
    doc = _load_json(_drill_file(), {})
    if not isinstance(doc, dict):
        return None, {}, {}
    snapshot = doc.get("snapshot") if isinstance(doc.get("snapshot"), dict) else {}
    by_node = snapshot.get("byNode") if isinstance(snapshot.get("byNode"), dict) else {}
    gold = snapshot.get("goldImprov") if isinstance(snapshot.get("goldImprov"), dict) else {}
    return doc.get("received_at"), by_node, gold


def _merge_drill_nodes(old, new):
    """Gained-only merge of virtuoso byNode snapshots: a completion artifact
    once relayed never un-earns via a stale snapshot (multi-browser races,
    settings import, the once-per-session boot relay). Incoming wins the
    descriptive fields; masteredAt / depth flips / keysCleared only grow."""
    out = dict(old)
    for node_id, incoming in new.items():
        if not isinstance(incoming, dict):
            continue
        cur = out.get(node_id)
        if not isinstance(cur, dict):
            out[node_id] = incoming
            continue
        merged = dict(cur)
        merged.update(incoming)
        merged["masteredAt"] = cur.get("masteredAt") or incoming.get("masteredAt")
        d_old = cur.get("depth") if isinstance(cur.get("depth"), dict) else {}
        d_new = incoming.get("depth") if isinstance(incoming.get("depth"), dict) else {}
        depth = dict(d_new)
        for axis, val in d_old.items():
            if val and not depth.get(axis):
                depth[axis] = val
        if depth:
            merged["depth"] = depth
        keys_old = cur.get("keysCleared") if isinstance(cur.get("keysCleared"), list) else []
        keys_new = incoming.get("keysCleared") if isinstance(incoming.get("keysCleared"), list) else []
        merged["keysCleared"] = keys_old + [k for k in keys_new if k not in keys_old]
        out[node_id] = merged
    return out


def _merge_gold(old, new):
    """Gained-only merge of goldImprov artifacts: a minted style never
    un-mints via a stale relay; the FIRST artifact per style is kept."""
    out = dict(old)
    for style_id, art in (new or {}).items():
        if isinstance(art, dict) and style_id not in out:
            out[style_id] = art
    return out


def _node_cleared(by_node, node_id):
    """A drill counts as cleared on real completion evidence: mastered, any
    depth rung flipped true, or a key cleared (a top-tier clean pass in one
    key — virtuoso's first gained-only artifact, and an achievable Bronze
    bar; the depth rungs additionally require a maxed speed tier)."""
    entry = by_node.get(node_id)
    if not isinstance(entry, dict):
        return False
    depth = entry.get("depth") if isinstance(entry.get("depth"), dict) else {}
    keys = entry.get("keysCleared")
    return (bool(entry.get("masteredAt"))
            or any(bool(v) for v in depth.values())
            or bool(isinstance(keys, list) and keys))


def _passports_view():
    cfg = _state["passports_content"]
    graded = set(cfg.get("graded_instruments") or [])
    st = _career_state()
    all_gigs = st.get("gigs") if isinstance(st.get("gigs"), list) else []
    played, played_seconds = _played_by_instrument_genre()
    received_at, by_node, gold_improv = _drill_by_node()
    instruments = {}
    for inst in cfg.get("instruments") or []:
        committed_at = (st["instruments"].get(inst) or {}).get("committed_at")
        opened = st["passports"].get(inst)
        opened = opened if isinstance(opened, dict) else {}
        passports = []
        for gkey, meta in sorted(opened.items(),
                                 key=lambda kv: ((kv[1] or {}).get("opened_at") or "", kv[0])):
            meta = meta if isinstance(meta, dict) else {}
            req = _badge_requirement(gkey, inst)
            songs = list(played.get((inst, gkey), {}).values())
            for s in songs:
                s["qualifies"] = s["stars"] >= req["min_stars"]
            songs.sort(key=lambda s: (not s["qualifies"], -s["stars"],
                                      s["title"].lower()))
            qualifying = sum(1 for s in songs if s["qualifies"])
            required = req["virtuoso_nodes"]
            cleared = [n for n in required if _node_cleared(by_node, n)]
            is_graded = inst in graded
            if not is_graded:
                # Where the engine can't fairly grade the instrument's job
                # (bass pocket, feel) the passport shows repertoire, never a
                # false badge denial — the doc's shown-not-judged rule.
                badge = "shown_not_judged"
            elif qualifying >= req["songs"] and len(cleared) == len(required):
                # Bronze is earned; GOLD upgrades it when a verified improv
                # artifact exists for this genre's jam style. Virtuoso mints
                # under raw STYLE_PALETTES ids ('punk', 'djent', 'disco', ...),
                # which are mostly NOT family keys — so match in family space:
                # the same keyword bucketing genres get ('punk' and 'punk
                # rock' both bucket to 'rock'), with the exact key as a direct
                # hit. Bronze remains a standalone win; gold never becomes an
                # obligation.
                fam = _genre_family(gkey)
                gold = any(
                    s == gkey or (fam is not None and _genre_family(s) == fam)
                    for s in gold_improv
                )
                badge = "gold" if gold else "earned"
            else:
                badge = "in_progress"
            # Practice invitation: the non-qualifying songs closest to the
            # QUALIFYING bar (the badge ask), nearest first — invitation
            # data, the UI voices it without meters.
            thresholds = _state["content"]["star_accuracy_thresholds"]
            bar = (thresholds[req["min_stars"] - 1]
                   if 0 < req["min_stars"] <= len(thresholds) else None)
            nearest = [] if bar is None else sorted(
                (s for s in songs if not s["qualifies"]),
                key=lambda s: bar - s["best_accuracy"])[:3]
            for s in nearest:
                s["bar_at"] = bar
            passports.append({
                "genre_key": gkey,
                "genre": meta.get("genre") or gkey,
                "opened_at": meta.get("opened_at"),
                "requirement": req,
                "graded": is_graded,
                "songs": songs,
                "qualifying_count": qualifying,
                "nearest": nearest,
                # Honest hours odometer (Stage 5 post-cap): a true fact that
                # only grows — never a target, never a meter.
                "seconds_total": round(played_seconds.get((inst, gkey), 0.0), 1),
                "drills": {"required": required, "cleared": cleared},
                "badge": badge,
            })
        inst_gigs = [g for g in all_gigs if g.get("instrument") == inst]
        for p in passports:
            p["gigs"] = [g for g in inst_gigs if g.get("genre_key") == p["genre_key"]][-20:][::-1]
        instruments[inst] = {"committed_at": committed_at, "passports": passports,
                             "gig_count": len(inst_gigs)}
    return {
        "config": {
            "badge_requirement": cfg.get("badge_requirement") or {},
            "graded_instruments": sorted(graded),
            "instruments": list(cfg.get("instruments") or []),
            # Career-side display names for virtuoso drill node ids.
            "drill_labels": dict(cfg.get("drill_labels") or {}),
        },
        "instruments": instruments,
        "genres": _library_genres(),
        "drill_state": {"received_at": received_at},
    }


def _gig_config():
    cfg = _state["passports_content"].get("gig")
    cfg = cfg if isinstance(cfg, dict) else {}

    def _num(key, default, cast):
        # Tuning data, not code: junk falls back instead of 500ing both gig
        # endpoints, and a legitimate 0 (stakes_songs: 0) is respected.
        val = cfg.get(key)
        if isinstance(val, bool) or not isinstance(val, (int, float)):
            return default
        return cast(val)

    return {
        "min_songs": max(1, _num("min_songs", 3, int)),
        "max_songs": max(1, _num("max_songs", 5, int)),
        "stakes_songs": max(0, _num("stakes_songs", 2, int)),
        "encore_accuracy": _num("encore_accuracy", 0.75, float),
    }


def _current_venue():
    """Highest unlocked venue (the room you can book today)."""
    stars_total, _, _ = _stars()
    best = None
    for v in _state["content"]["venues"]:
        if stars_total >= v["star_threshold"]:
            if best is None or v["star_threshold"] >= best["star_threshold"]:
                best = v
    return best


def _unplayed_genre_songs(gkey, exclude, limit):
    """Library songs of a genre with no stats yet — a young passport's gig
    still gets a full set (playing them is how stubs start).
    ponytail: full stat-less scan + python-side genre match (a few ms at 7k
    songs, single-user); push the match into SQL if propose ever feels slow."""
    db = _state["meta_db"]
    if db is None:
        return []
    rows = db.conn.execute(
        f"SELECT filename, title, artist, {_genre_expr(db)} AS g FROM songs "
        "WHERE filename NOT IN (SELECT filename FROM song_stats)"
    ).fetchall()
    out = []
    for filename, title, artist, genre in rows:
        if _genre_key(genre) != gkey or filename in exclude:
            continue
        out.append({"filename": filename, "title": title or filename,
                    "artist": artist or ""})
        if len(out) >= limit:
            break
    return out


def _validate_pack_dir(pack_dir: Path):
    """Raise ValueError unless pack_dir holds a complete venue pack."""
    manifest_path = pack_dir / "manifest.json"
    if not manifest_path.is_file():
        raise ValueError("pack has no manifest.json")
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    loops = manifest.get("loops") or {}
    for state in REQUIRED_LOOPS:
        name = loops.get(state)
        if not name or not PACK_FILENAME_RE.fullmatch(name):
            raise ValueError(f"manifest is missing the '{state}' loop")
        if not (pack_dir / name).is_file():
            raise ValueError(f"loop file '{name}' missing from pack")
    for name in (manifest.get("stingers") or {}).values():
        if name and (not PACK_FILENAME_RE.fullmatch(name) or not (pack_dir / name).is_file()):
            raise ValueError(f"stinger file '{name}' invalid or missing")
    for name in (manifest.get("intro") or {}).values():
        if name and (not PACK_FILENAME_RE.fullmatch(name) or not (pack_dir / name).is_file()):
            raise ValueError(f"intro file '{name}' invalid or missing")


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
                if name != info.filename or not PACK_FILENAME_RE.fullmatch(name):
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
    _state["plugin_dir"] = plugin_dir
    _state["content"] = json.loads((plugin_dir / "venues.json").read_text(encoding="utf-8"))
    _state["venues_dir"] = (
        Path(context["config_dir"]) / "plugin_uploads" / PLUGIN_ID / "venues")
    _state["venues_dir"].mkdir(parents=True, exist_ok=True)
    _state["passports_content"] = json.loads(
        (plugin_dir / "passports.json").read_text(encoding="utf-8"))
    # Persisted career state (commitment / opened passports / drill snapshot)
    # lives under CONFIG_DIR/career/ — declared in settings.server_files so it
    # rides the settings export/import bundle. Packs stay out (they're media).
    _state["state_dir"] = Path(context["config_dir"]) / PLUGIN_ID
    _state["state_dir"].mkdir(parents=True, exist_ok=True)
    _state["meta_db"] = context.get("meta_db")
    _state["log"] = context.get("log") or _state["log"]
    for v in _state["content"]["venues"]:
        if _bundled(v["id"]):
            _validate_pack_dir(_bundled_venue_dir(v["id"]))

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
                "bundled": _bundled(v["id"]),
                "has_pack": _bundled(v["id"]) or bool(v.get("pack")),
                "download": dl,
            })
        return {
            "stars_total": stars_total,
            "stars_per_song": per_song,
            "star_detail": star_detail,
            "star_accuracy_thresholds": _state["content"]["star_accuracy_thresholds"],
            "venues": venues,
        }

    @app.get(f"/api/plugins/{PLUGIN_ID}/passports")
    def get_passports():
        with _lock:
            return _passports_view()

    @app.post(f"/api/plugins/{PLUGIN_ID}/passports/commit")
    def commit_instrument(body: dict = Body(...)):
        inst = str((body or {}).get("instrument") or "")
        if inst not in (_state["passports_content"].get("instruments") or []):
            raise HTTPException(400, "Unknown instrument.")
        with _lock:
            st = _career_state()
            entry = st["instruments"].setdefault(inst, {})
            # Idempotent: the wax seal is pressed once; re-commits keep the
            # original date (only-gained-never-lost).
            if not entry.get("committed_at"):
                entry["committed_at"] = _now_iso()
                _save_json(_state_file(), st)
        return {"ok": True, "instrument": inst,
                "committed_at": entry["committed_at"]}

    @app.post(f"/api/plugins/{PLUGIN_ID}/passports/open")
    def open_passport(body: dict = Body(...)):
        inst = str((body or {}).get("instrument") or "")
        genre = _genre_display((body or {}).get("genre"))
        gkey = genre.lower()
        if inst not in (_state["passports_content"].get("instruments") or []):
            raise HTTPException(400, "Unknown instrument.")
        if not gkey or len(genre) > GENRE_MAX_LEN:
            raise HTTPException(400, "Provide a genre.")
        with _lock:
            st = _career_state()
            # Opening a passport implies the instrument commitment (permissive
            # server, ceremony ordering is the UI's job).
            st["instruments"].setdefault(inst, {}).setdefault(
                "committed_at", _now_iso())
            genres = st["passports"].setdefault(inst, {})
            if gkey not in genres:
                genres[gkey] = {"genre": genre, "opened_at": _now_iso()}
                _save_json(_state_file(), st)
        return {"ok": True, "instrument": inst, "passport": genres[gkey]}

    @app.post(f"/api/plugins/{PLUGIN_ID}/drill-state")
    def post_drill_state(body: dict = Body(...)):
        # The relayed virtuoso.progress snapshot (career's screen.js listens to
        # the virtuoso:progress bus event and forwards the localStorage doc).
        # Only the fields the badge check reads are kept.
        if not isinstance(body, dict) or not isinstance(body.get("byNode"), dict):
            raise HTTPException(400, "Expected a progress snapshot with byNode.")
        # Bound the INCOMING snapshot before the merge — the gained-only merge
        # drops junk entries, which must not become a size-guard bypass.
        if len(json.dumps(body["byNode"])) > DRILL_SNAPSHOT_MAX_BYTES:
            raise HTTPException(413, "Snapshot too large.")
        gold_in = body.get("goldImprov", {})
        if not isinstance(gold_in, dict):
            # A relay bug must be LOUD, not a silent 200 that drops gold.
            raise HTTPException(400, "goldImprov must be an object keyed by style id.")
        # Keep only plausible artifacts: a dict that names its verifier —
        # an empty {} must not mint an evidence-free gold.
        gold_in = {k: v for k, v in gold_in.items()
                   if isinstance(v, dict) and v.get("verifier")}
        # Same pre-merge bound byNode gets: the gained-only merge dropping
        # junk must not become a size-guard bypass (nor lock-held CPU burn).
        if len(json.dumps(gold_in)) > DRILL_SNAPSHOT_MAX_BYTES:
            raise HTTPException(413, "Snapshot too large.")
        with _lock:
            _, existing, existing_gold = _drill_by_node()
            snapshot = {"mode": body.get("mode"), "xp": body.get("xp"),
                        "byNode": _merge_drill_nodes(existing, body["byNode"]),
                        "goldImprov": _merge_gold(existing_gold, gold_in)}
            if len(json.dumps(snapshot)) > DRILL_SNAPSHOT_MAX_BYTES:
                raise HTTPException(413, "Snapshot too large.")
            _save_json(_drill_file(), {"received_at": _now_iso(),
                                       "snapshot": snapshot})
        return {"ok": True}

    @app.post(f"/api/plugins/{PLUGIN_ID}/gigs/prepare")
    def prepare_gig(body: dict = Body(...)):
        """Unpack every song of the set BEFORE the gig starts.

        A feedpak is a zip: the first play of one pays for its extraction into
        sloppak_cache. Inside a set that cost landed BETWEEN songs — the player
        finished a number and then sat waiting for the next one to unpack, mid-
        gig. A set is a known list up front, so extract it all while the player
        is still looking at the poster.

        Idempotent and cheap on a warm cache: resolve_source_dir() returns the
        already-unpacked dir without rewriting it. Best-effort per song — one
        bad feedpak must not block the set from starting (the play itself will
        surface the error, exactly as it does outside a gig).
        """
        raw = (body or {}).get("songs")
        # A str is iterable: without the list check, "abc" would prepare three
        # one-character "songs". Cap the count too — this endpoint unpacks zips,
        # so an oversized list is real work, and a setlist is a handful of songs.
        if not isinstance(raw, list):
            return {"ok": True, "prepared": 0, "failed": []}
        files = [f for f in raw if isinstance(f, str) and f.strip()][:MAX_GIG_SONGS]
        if not files:
            return {"ok": True, "prepared": 0, "failed": []}

        # .get, not []: a host that doesn't hand us the resolvers (or has no
        # library configured) must degrade to "extract lazily, as before" — this
        # is an optimisation, and it is never allowed to be the thing that stops
        # a gig from starting.
        get_dlc = context.get("get_dlc_dir")
        get_cache = context.get("get_sloppak_cache_dir")
        dlc_root = get_dlc() if callable(get_dlc) else None
        cache_root = get_cache() if callable(get_cache) else None
        if dlc_root is None or cache_root is None:
            return {"ok": False, "prepared": 0, "failed": files, "error": "no library"}

        root = Path(dlc_root)
        prepared, failed = 0, []
        for fn in files:
            # CONTAINMENT FIRST. resolve_source_dir() does a bare
            # `dlc_root / filename` with no guard, so a crafted `../..` would
            # walk straight out of the library. Every other filename-bound
            # handler validates through _resolve_dlc_path; so does this one.
            safe = _resolve_dlc_path(root, fn)
            if safe is None:
                _state["log"].warning("career: gig pre-extract rejected unsafe path %r", fn)
                failed.append(fn)
                continue
            try:
                sloppak.resolve_source_dir(fn, root, Path(cache_root))
                prepared += 1
            except Exception as exc:   # noqa: BLE001 — one bad pak can't sink the set
                _state["log"].warning("career: gig pre-extract failed for %s: %s", fn, exc)
                failed.append(fn)
        return {"ok": True, "prepared": prepared, "failed": failed}

    @app.post(f"/api/plugins/{PLUGIN_ID}/gigs/propose")
    def propose_gig(body: dict = Body(...)):
        inst = str((body or {}).get("instrument") or "")
        genre = _genre_display((body or {}).get("genre"))
        gkey = genre.lower()
        if inst not in (_state["passports_content"].get("instruments") or []):
            raise HTTPException(400, "Unknown instrument.")
        if not gkey or len(genre) > GENRE_MAX_LEN:
            raise HTTPException(400, "Provide a genre.")
        cfg = _gig_config()
        try:
            size = int((body or {}).get("size") or 4)
        except (TypeError, ValueError):
            raise HTTPException(400, "size must be a number.")
        size = max(cfg["min_songs"], min(cfg["max_songs"], size))
        played, _seconds = _played_by_instrument_genre()
        stubs = list(played.get((inst, gkey), {}).values())
        req = _badge_requirement(gkey, inst)
        qualifying = [s for s in stubs if s["stars"] >= req["min_stars"]]
        rest = [s for s in stubs if s["stars"] < req["min_stars"]]
        # The set: mostly songs you own, plus a couple of stakes songs near
        # the bar; a young passport fills from unplayed genre songs so the
        # first gig is how stubs start. random per call = free re-roll.
        random.shuffle(qualifying)
        rest.sort(key=lambda s: -s["best_accuracy"])
        qtaken = max(1, size - cfg["stakes_songs"])
        picks = qualifying[:qtaken]
        for s in rest:
            if len(picks) >= size:
                break
            picks.append(s)
        # Surplus qualifying songs backfill a short set — a mature passport
        # with no near-bar songs left must still fill the bill. Offset by how
        # many QUALIFYING songs were taken, not len(picks): rest's stakes
        # additions would otherwise skip eligible qualifying songs entirely.
        for s in qualifying[qtaken:]:
            if len(picks) >= size:
                break
            picks.append(s)
        if len(picks) < size:
            exclude = {s["filename"] for s in picks}
            picks.extend(_unplayed_genre_songs(gkey, exclude, size - len(picks)))
        if not picks:
            raise HTTPException(404, "No songs of this genre in the library.")
        venue = _current_venue()
        return {
            "instrument": inst,
            "genre": genre,
            "genre_key": gkey,
            "venue_id": venue["id"] if venue else None,
            "venue_name": venue["name"] if venue else "",
            "songs": [{"filename": s["filename"], "title": s.get("title") or s["filename"],
                       "artist": s.get("artist") or ""} for s in picks[:size]],
        }

    @app.post(f"/api/plugins/{PLUGIN_ID}/gigs")
    def log_gig(body: dict = Body(...)):
        # Called by the runner ONLY when the set completed — an abandoned set
        # never logs (no fail state; the gig you finished is the gig you
        # played). Accuracies come from song_stats, freshly written by the
        # set's own plays.
        inst = str((body or {}).get("instrument") or "")
        genre = _genre_display((body or {}).get("genre"))
        gkey = genre.lower()
        venue_id = str((body or {}).get("venue_id") or "")
        songs = (body or {}).get("songs")
        if inst not in (_state["passports_content"].get("instruments") or []):
            raise HTTPException(400, "Unknown instrument.")
        if not gkey or len(genre) > GENRE_MAX_LEN:
            raise HTTPException(400, "Provide a genre.")
        if venue_id and (not VENUE_ID_RE.fullmatch(venue_id) or _venue(venue_id) is None):
            raise HTTPException(400, "Unknown venue.")
        if (not isinstance(songs, list) or not songs or len(songs) > 8
                or not all(isinstance(f, str) and f.strip() for f in songs)):
            raise HTTPException(400, "songs must be 1-8 filenames.")
        db = _state["meta_db"]
        entries = []
        accuracies = []
        for filename in songs:
            title = filename
            accuracy = None
            if db is not None:
                # The NEWEST row is the set's own just-recorded play — a
                # MAX(last_accuracy) across arrangements would happily log a
                # stale higher score from another instrument's old session.
                row = db.conn.execute(
                    "SELECT last_accuracy FROM song_stats WHERE filename = ? "
                    "ORDER BY last_played_at DESC LIMIT 1",
                    (filename,)).fetchone()
                if row and row[0] is not None:
                    accuracy = round(float(row[0]), 4)
                    accuracies.append(accuracy)
                trow = db.conn.execute(
                    "SELECT title FROM songs WHERE filename = ?", (filename,)).fetchone()
                if trow and trow[0]:
                    title = trow[0]
            entries.append({"filename": filename, "title": title, "accuracy": accuracy})
        # Encore needs the WHOLE set scored at the bar — one scored song must
        # not earn an encore for a set that was 4/5 unheard.
        encore = (len(accuracies) == len(songs) and
                  sum(accuracies) / len(accuracies) >= _gig_config()["encore_accuracy"])
        gig = {
            "at": _now_iso(),
            "venue_id": venue_id or None,
            "instrument": inst,
            "genre": genre,
            "genre_key": gkey,
            "songs": entries,
            "encore": encore,
        }
        with _lock:
            st = _career_state()
            if not isinstance(st.get("gigs"), list):
                st["gigs"] = []
            st["gigs"].append(gig)
            # ponytail: hard cap — nothing reads past the last 20 per
            # passport; the state file must not grow (and export) forever.
            st["gigs"] = st["gigs"][-500:]
            _save_json(_state_file(), st)
        return {"ok": True, "gig": gig}

    @app.post(f"/api/plugins/{PLUGIN_ID}/packs/{{venue_id}}/download")
    def start_download(venue_id: str):
        venue = _venue(venue_id) if VENUE_ID_RE.fullmatch(venue_id) else None
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
        if not VENUE_ID_RE.fullmatch(venue_id) or _venue(venue_id) is None:
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
        if not VENUE_ID_RE.fullmatch(venue_id) or not PACK_FILENAME_RE.fullmatch(filename):
            raise HTTPException(404, "Not found.")
        pack_dir = _pack_dir(venue_id)
        path = pack_dir / filename
        # Defense-in-depth beyond the regexes (same recipe as highway_3d):
        # the resolved path must stay inside the selected pack dir.
        try:
            resolved = path.resolve()
            resolved.relative_to(pack_dir.resolve())
        except (OSError, ValueError):
            raise HTTPException(404, "Not found.")
        if not resolved.is_file():
            raise HTTPException(404, "Not found.")
        media = {"mp4": "video/mp4", "webm": "video/webm", "mp3": "audio/mpeg",
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
