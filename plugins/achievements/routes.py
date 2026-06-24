"""Achievements & Feats of Power — local engine (offline).

State lives under ``<config_dir>/achievements/``:
  - ``achievements.db``  SQLite — unlocks, activity counters, derived ledger,
                         and the (PR3) wall sync queue.

Two surfaces, one engine, kept structurally apart (the **integration law**):
  * **Feats of Power** — activity/volume. The engine OWNS raw activity counters
    (`counters`), evaluates Feat thresholds, and records Feat unlocks. Feats are
    the only thing that ever syncs to the public wall.
  * **Achievements** — demonstrated competency. The engine RECORDS unlocks the
    source reports (`report-unlock`); it never re-derives them from activity.
    A baseline catalogue ships here and is driven by the built-in progression
    system; richer items are contributed by source plugins at runtime.

Endpoints (all under /api/plugins/achievements/):
  POST /activity        bump activity counters, eval Feats, return newly-unlocked
  POST /report-unlock   idempotent upsert of a competency/feat unlock
  POST /report-criterion record a (criterion_id, token) pair → distinct count
  GET  /catalog         baseline competency defs + earned state
  GET  /earned          all earned items (id, cls, category, tier, at)
  GET  /feats           earned Feats (for the profile trophy shelf)
  POST /remove-me       wipe synced state (full wall-removal lands in PR2/PR3)

Pure threshold/criterion math lives in the sibling ``engine.py`` (P-V testable);
this module is the SQLite + HTTP shell.
"""

import hashlib
import json
import logging
import os
import sqlite3
import threading
import time
from pathlib import Path

from pydantic import BaseModel, Field

_lock = threading.Lock()
_state = {
    "db_path": None,
    "dir": None,            # plugin directory (for catalog JSON)
    "config_dir": None,     # CONFIG_DIR (for reading the opt-in setting)
    "meta_db": None,        # MetadataDB (for the profile identity: name + hash)
    "log": logging.getLogger("feedBack.plugin.achievements"),
    "engine": None,         # sibling engine.py module (pure helpers)
    "feat_defs": [],        # parsed feats.json -> list of feat defs
    "baseline": {},         # parsed achievements.json
}


# ── SQLite ──────────────────────────────────────────────────────────────────

def _conn():
    conn = sqlite3.connect(_state["db_path"], timeout=5)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    return conn


def _init_db():
    conn = _conn()
    try:
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS unlocks (
                achievement_id TEXT PRIMARY KEY,
                cls            TEXT NOT NULL,          -- 'competency' | 'feat'
                disp_category  TEXT,                   -- global/guitar/bass/...
                source_id      TEXT,
                tier           INTEGER NOT NULL DEFAULT 0,
                unlocked_at    TEXT,
                synced         INTEGER NOT NULL DEFAULT 0
            )
            """
        )
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS counters (
                key   TEXT PRIMARY KEY,
                value INTEGER NOT NULL DEFAULT 0
            )
            """
        )
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS comp_ledger (
                criterion_id TEXT NOT NULL,
                token        TEXT NOT NULL,
                PRIMARY KEY (criterion_id, token)
            )
            """
        )
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS sync_queue (
                id      INTEGER PRIMARY KEY AUTOINCREMENT,
                kind    TEXT NOT NULL,                 -- 'unlock' | 'remove'
                payload TEXT NOT NULL,
                state   TEXT NOT NULL DEFAULT 'pending' -- 'pending' | 'dead_letter'
            )
            """
        )
        conn.commit()
    finally:
        conn.close()


def _now_iso():
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())


def _opted_in():
    """True only when the user has opted in (core setting ``achievements_enabled``).

    Read straight from CONFIG_DIR/config.json — the single source of truth the
    /api/settings endpoint persists. Default OFF on any read failure: nothing
    leaves the device unless explicitly enabled.
    """
    try:
        cfg_path = Path(_state["config_dir"]) / "config.json"
        cfg = json.loads(cfg_path.read_text(encoding="utf-8"))
        return bool(cfg.get("achievements_enabled") is True)
    except (OSError, ValueError, TypeError):
        return False


def _identity():
    """(display_name, player_hash) from the profile, or (None, None).

    Reused as the wall identity (server.py's documented player_hash). Sync is
    skipped entirely when either is missing.
    """
    db = _state["meta_db"]
    if db is None or not hasattr(db, "get_profile"):
        return None, None
    try:
        prof = db.get_profile() or {}
        return (prof.get("display_name") or None), (prof.get("player_hash") or None)
    except Exception:  # noqa: BLE001 — identity is best-effort; never break a request
        return None, None


def _enqueue_feat_sync(conn, feat_id, unlocked_at):
    """Enqueue a wall-sync POST for a Feat unlock — opt-in gated, identity gated.

    Builds the outbound payload through the SINGLE code-gated serializer
    (engine.build_wall_payload, exactly four fields). Competency unlocks never
    reach this path (integration law + data-minimization contract). The drain
    worker (PR3) POSTs the queued rows; here we only persist intent.
    """
    if not _opted_in():
        return False
    display_name, player_hash = _identity()
    if not display_name or not player_hash:
        return False
    payload = _state["engine"].build_wall_payload(display_name, player_hash, feat_id, unlocked_at)
    conn.execute(
        "INSERT INTO sync_queue(kind, payload, state) VALUES ('unlock', ?, 'pending')",
        (json.dumps(payload),),
    )
    return True


# ── Wall sync — background drain worker (dead-letter, never drop) ─────────────
# Idle unless a wall URL is configured. POSTs pending rows to the hosted
# feedback-achievements service; the decision state machine
# (engine.drain_decision) is pure + tested. A row leaves the queue only on a
# server ack (or a user opt-out wiping it) — never silently dropped.

_WALL_URL = (os.environ.get("FEEDBACK_ACHIEVEMENTS_WALL_URL")
             or os.environ.get("SLOPSMITH_ACHIEVEMENTS_WALL_URL") or "").rstrip("/")
_WALL_TOKEN = os.environ.get("FEEDBACK_ACHIEVEMENTS_CLIENT_TOKEN", "fb-wall-v1")
_DRAIN_INTERVAL_S = int(os.environ.get("FEEDBACK_ACHIEVEMENTS_DRAIN_INTERVAL", "30"))
_drain_started = False


def _post_to_wall(kind, payload):
    """POST one queued item; return the HTTP status code, or None on a network
    error. Mirrors the lib/lyrics_transcribe outbound pattern (explicit timeout,
    no raise on non-2xx — the caller's state machine decides)."""
    import requests  # local import: only needed when a wall is configured

    path = "/api/unlock" if kind == "unlock" else "/api/remove"
    try:
        resp = requests.post(
            _WALL_URL + path, json=payload,
            headers={"X-Client-Token": _WALL_TOKEN, "Content-Type": "application/json"},
            timeout=10,
        )
        return resp.status_code
    except requests.RequestException:
        return None


def _drain_once(post_fn=None):
    """Process all pending queue rows once. ``post_fn(kind, payload) -> status``
    is injectable for tests; defaults to the real wall POST."""
    post_fn = post_fn or _post_to_wall
    engine = _state["engine"]
    with _lock:
        conn = _conn()
        try:
            rows = conn.execute(
                "SELECT id, kind, payload FROM sync_queue WHERE state='pending'").fetchall()
        finally:
            conn.close()
    for row in rows:
        try:
            payload = json.loads(row["payload"]) if row["payload"] else {}
        except ValueError:
            payload = {}
        status = post_fn(row["kind"], payload)
        action = engine.drain_decision(status)
        with _lock:
            conn = _conn()
            try:
                if action == "ack":
                    conn.execute("DELETE FROM sync_queue WHERE id=?", (row["id"],))
                elif action == "dead":
                    conn.execute("UPDATE sync_queue SET state='dead_letter' WHERE id=?", (row["id"],))
                # 'retry' → leave it pending for the next pass
                conn.commit()
            finally:
                conn.close()


def _drain_loop():
    while True:
        try:
            _drain_once()
        except Exception as e:  # noqa: BLE001 — a worker crash must not kill the thread
            _state["log"].warning("achievements wall drain error: %s", e)
        time.sleep(_DRAIN_INTERVAL_S)


def _maybe_start_drain():
    global _drain_started
    if _drain_started or not _WALL_URL:
        return
    _drain_started = True
    threading.Thread(target=_drain_loop, name="ach-wall-drain", daemon=True).start()
    _state["log"].info("achievements wall drain worker started → %s", _WALL_URL)


def _chart_key(chart):
    """Stable per-chart counter key — a sha1 digest of the chart id. NOT the
    builtin hash(), whose str hashing is salted per process (PYTHONHASHSEED), so
    the same chart would land on a different counter after every restart and the
    Encore Feat could never accumulate across sessions."""
    return "chart_plays:" + hashlib.sha1(str(chart).encode("utf-8")).hexdigest()[:16]


def _read_counters(conn):
    # Excludes the per-chart `chart_plays:*` rows: they are bumped + read
    # individually via _bump_counter and would otherwise make this aggregate
    # round-trip O(distinct charts played) on every activity POST.
    return {
        row["key"]: int(row["value"])
        for row in conn.execute("SELECT key, value FROM counters WHERE key NOT LIKE 'chart_plays:%'")
    }


def _write_counters(conn, counters):
    for key, value in counters.items():
        conn.execute(
            "INSERT INTO counters(key, value) VALUES (?, ?) "
            "ON CONFLICT(key) DO UPDATE SET value=excluded.value",
            (key, int(value)),
        )


def _bump_counter(conn, key, delta):
    """Increment a counter and return the new value (used for per-chart plays)."""
    conn.execute(
        "INSERT INTO counters(key, value) VALUES (?, ?) "
        "ON CONFLICT(key) DO UPDATE SET value=value+excluded.value",
        (key, int(delta)),
    )
    row = conn.execute("SELECT value FROM counters WHERE key=?", (key,)).fetchone()
    return int(row["value"]) if row else int(delta)


def _earned_feat_tiers(conn):
    return {
        row["achievement_id"]: int(row["tier"])
        for row in conn.execute("SELECT achievement_id, tier FROM unlocks WHERE cls='feat'")
    }


def _record_unlock(conn, ach_id, cls, disp_category, source_id, tier, at):
    """Idempotent upsert; only advances the tier upward. Returns True if changed."""
    row = conn.execute("SELECT tier FROM unlocks WHERE achievement_id=?", (ach_id,)).fetchone()
    if row is not None and int(row["tier"]) >= int(tier):
        return False
    conn.execute(
        """
        INSERT INTO unlocks(achievement_id, cls, disp_category, source_id, tier, unlocked_at, synced)
        VALUES (?, ?, ?, ?, ?, ?, 0)
        ON CONFLICT(achievement_id) DO UPDATE SET
            tier=excluded.tier,
            cls=excluded.cls,
            disp_category=COALESCE(excluded.disp_category, unlocks.disp_category),
            source_id=COALESCE(excluded.source_id, unlocks.source_id)
        """,
        (ach_id, cls, disp_category, source_id, int(tier), at or _now_iso()),
    )
    return True


# ── Catalog loading ─────────────────────────────────────────────────────────

def _feat_by_id(fid):
    for f in _state["feat_defs"]:
        if f.get("id") == fid:
            return f
    return None


def _load_catalogs():
    base = Path(_state["dir"])
    try:
        feats = json.loads((base / "feats.json").read_text(encoding="utf-8"))
        _state["feat_defs"] = feats.get("feats", []) if isinstance(feats, dict) else []
    except (OSError, ValueError) as e:
        _state["log"].warning("achievements: could not load feats.json: %s", e)
        _state["feat_defs"] = []
    try:
        _state["baseline"] = json.loads((base / "achievements.json").read_text(encoding="utf-8"))
    except (OSError, ValueError) as e:
        _state["log"].warning("achievements: could not load achievements.json: %s", e)
        _state["baseline"] = {}


# ── Request models ──────────────────────────────────────────────────────────

class ActivityIn(BaseModel):
    notes:          int = Field(ge=0, default=0)
    session_notes:  int = Field(ge=0, default=0)
    in_song_streak: int = Field(ge=0, default=0)
    song_done:      int = Field(ge=0, default=0)
    seconds:        int = Field(ge=0, default=0)
    chart:          str | None = None
    night_session:  bool = False
    night_date:     str | None = None     # 'YYYY-MM-DD', frontend supplies (no server clock)


class UnlockIn(BaseModel):
    id:        str
    kind:      str = "achievement"        # 'achievement' | 'feat'
    category:  str | None = None          # display category (global/guitar/...)
    sourceId:  str | None = None
    tier:      int = Field(ge=0, default=0)
    at:        str | None = None


class CriterionIn(BaseModel):
    criterion_id: str
    token:        str


# ── FastAPI wiring ──────────────────────────────────────────────────────────

def setup(app, context):
    config_dir = context["config_dir"]
    base = Path(config_dir) / "achievements"
    base.mkdir(parents=True, exist_ok=True)
    _state["db_path"] = str(base / "achievements.db")
    _state["dir"] = str(Path(__file__).resolve().parent)
    _state["config_dir"] = str(config_dir)
    _state["meta_db"] = context.get("meta_db")
    _state["log"] = context.get("log") or _state["log"]
    # Pure helpers via the per-plugin sibling loader (constitution P-III), with a
    # plain-import fallback for pytest / standalone use.
    load_sibling = context.get("load_sibling")
    try:
        _state["engine"] = load_sibling("engine") if load_sibling else __import__("engine")
    except Exception:  # noqa: BLE001 — last-ditch, keep the plugin alive
        import importlib.util
        spec = importlib.util.spec_from_file_location(
            "achievements_engine", str(Path(__file__).resolve().parent / "engine.py"))
        mod = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(mod)
        _state["engine"] = mod
    _init_db()
    _load_catalogs()
    log = _state["log"]

    @app.post("/api/plugins/achievements/activity")
    def post_activity(body: ActivityIn):
        engine = _state["engine"]
        with _lock:
            conn = _conn()
            try:
                # Per-chart play count is the only directly-stateful bit; bump it
                # first (stable key) so apply_activity() just takes the new max.
                chart_play_count = None
                if body.song_done and body.chart:
                    chart_play_count = _bump_counter(conn, _chart_key(body.chart), 1)
                # Night-window ledger → consecutive-night run. Computed here but
                # NOT written before the prev snapshot: it is folded into the delta
                # below so prev_tiers reflects the OLD run and new_tiers the new one
                # (the same asymmetry chart_encore relies on). Pre-writing it would
                # make prev already satisfy the Feat, so diff_unlocks would never
                # see the freshly-earned witching unlock.
                witching_run = None
                if body.night_session and body.night_date:
                    conn.execute(
                        "INSERT OR IGNORE INTO comp_ledger(criterion_id, token) VALUES ('witching', ?)",
                        (body.night_date,),
                    )
                    nights = [r["token"] for r in conn.execute(
                        "SELECT token FROM comp_ledger WHERE criterion_id='witching'")]
                    witching_run = engine.consecutive_run_length(nights)

                counters = _read_counters(conn)
                prev_tiers = engine.evaluate_feats(_state["feat_defs"], counters)
                new_counters = engine.apply_activity(counters, {
                    "notes": body.notes,
                    "session_notes": body.session_notes,
                    "in_song_streak": body.in_song_streak,
                    "song_done": body.song_done,
                    "seconds": body.seconds,
                    "chart_play_count": chart_play_count,
                })
                if witching_run is not None:
                    new_counters["witching_nights_run"] = max(
                        int(new_counters.get("witching_nights_run", 0) or 0), witching_run)
                _write_counters(conn, new_counters)
                new_tiers = engine.evaluate_feats(_state["feat_defs"], new_counters)
                fresh = engine.diff_unlocks(prev_tiers, new_tiers)
                unlocked = []
                for fid in fresh:
                    f = _feat_by_id(fid) or {}
                    tier = new_tiers[fid]
                    at = _now_iso()
                    if _record_unlock(conn, fid, "feat", f.get("category"), f.get("sourceId"), tier, at):
                        _enqueue_feat_sync(conn, fid, at)
                        unlocked.append(_feat_payload(fid, f, tier))
                conn.commit()
                return {"ok": True, "unlocked": unlocked, "counters": new_counters}
            finally:
                conn.close()

    @app.post("/api/plugins/achievements/report-unlock")
    def post_report_unlock(body: UnlockIn):
        cls = "feat" if body.kind == "feat" else "competency"
        at = body.at or _now_iso()
        with _lock:
            conn = _conn()
            try:
                changed = _record_unlock(
                    conn, body.id, cls, body.category, body.sourceId, body.tier, at)
                # Only Feats sync; competency never enqueues (integration law +
                # data-minimization contract).
                if changed and cls == "feat":
                    _enqueue_feat_sync(conn, body.id, at)
                conn.commit()
                return {"ok": True, "changed": changed, "id": body.id, "tier": body.tier}
            finally:
                conn.close()

    @app.post("/api/plugins/achievements/report-criterion")
    def post_report_criterion(body: CriterionIn):
        """Record a distinct (criterion_id, token); return the distinct count.

        Lets a baseline subscriber aggregate multi-event criteria (e.g. the set
        of distinct days with a real advance → `steady_hands`) without us
        re-deriving competency from activity. Bookkeeping over events only.
        """
        with _lock:
            conn = _conn()
            try:
                conn.execute(
                    "INSERT OR IGNORE INTO comp_ledger(criterion_id, token) VALUES (?, ?)",
                    (body.criterion_id, body.token),
                )
                row = conn.execute(
                    "SELECT COUNT(*) AS n FROM comp_ledger WHERE criterion_id=?",
                    (body.criterion_id,),
                ).fetchone()
                conn.commit()
                return {"ok": True, "count": int(row["n"]) if row else 0}
            finally:
                conn.close()

    @app.get("/api/plugins/achievements/catalog")
    def get_catalog():
        with _lock:
            conn = _conn()
            try:
                earned = _earned_map(conn)
            finally:
                conn.close()
        return {"baseline": _state["baseline"], "earned": earned}

    @app.get("/api/plugins/achievements/earned")
    def get_earned():
        with _lock:
            conn = _conn()
            try:
                return {"earned": list(_earned_map(conn).values())}
            finally:
                conn.close()

    @app.get("/api/plugins/achievements/feats")
    def get_feats():
        with _lock:
            conn = _conn()
            try:
                rows = conn.execute(
                    "SELECT achievement_id, tier, unlocked_at FROM unlocks WHERE cls='feat'"
                ).fetchall()
            finally:
                conn.close()
        out = []
        for row in rows:
            fid = row["achievement_id"]
            f = _feat_by_id(fid) or {}
            payload = _feat_payload(fid, f, int(row["tier"]))
            payload["unlocked_at"] = row["unlocked_at"]
            out.append(payload)
        return {"feats": out}

    @app.post("/api/plugins/achievements/remove-me")
    def post_remove_me():
        # Local removal works offline: drop the synced flag so nothing re-syncs,
        # and enqueue a wall removal (drained in PR3). The wall identity
        # (player_hash) is resolved server-side at drain time, not stored here.
        _, player_hash = _identity()
        with _lock:
            conn = _conn()
            try:
                conn.execute("UPDATE unlocks SET synced=0 WHERE cls='feat'")
                # Enqueue a wall removal only when we have an identity to key it
                # by; the drain worker (below) POSTs it. Idempotent server-side.
                if player_hash:
                    conn.execute(
                        "INSERT INTO sync_queue(kind, payload, state) VALUES ('remove', ?, 'pending')",
                        (json.dumps({"player_hash": player_hash}),),
                    )
                conn.commit()
                return {"ok": True}
            finally:
                conn.close()

    _maybe_start_drain()
    log.info("achievements engine ready (%d feats, baseline v%s)",
             len(_state["feat_defs"]), str(_state["baseline"].get("version", "?")))


def _feat_payload(fid, feat, tier):
    titles = feat.get("tier_titles") or []
    title = titles[tier] if 0 <= tier < len(titles) else feat.get("title", fid)
    return {
        "id": fid,
        "cls": "feat",
        "tier": tier,
        "title": title,
        "description": feat.get("description", ""),
        "category": feat.get("category", "global"),
        "secret": bool(feat.get("secret", False)),
    }


def _earned_map(conn):
    out = {}
    for row in conn.execute(
        "SELECT achievement_id, cls, disp_category, tier, unlocked_at FROM unlocks"
    ):
        out[row["achievement_id"]] = {
            "id": row["achievement_id"],
            "cls": row["cls"],
            "category": row["disp_category"],
            "tier": int(row["tier"]),
            "unlocked_at": row["unlocked_at"],
        }
    return out
