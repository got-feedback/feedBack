"""FeedBack — FastAPI backend serving highway viewer + library."""

import asyncio
import bisect
import hashlib
import json
import logging
import math
import os
import secrets
import sys
import tempfile
import shutil
from pathlib import Path
from typing import Any, ClassVar

from logging_setup import configure_logging
from env_compat import getenv_compat
configure_logging()

log = logging.getLogger("feedBack.server")

from fastapi import Body, FastAPI, WebSocket, WebSocketDisconnect, UploadFile, File, HTTPException, Query
from fastapi.concurrency import run_in_threadpool
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse, JSONResponse, RedirectResponse, Response, StreamingResponse

from safepath import safe_join
from song import (
    anchor_to_wire,
    arrangement_string_count,
    base_open_string_midis,
    compute_smart_names,
    chord_template_to_wire,
    chord_to_wire,
    hand_shape_to_wire,
    key_to_tonic_pc,
    load_song,
    note_to_wire,
    phrase_to_wire,
    pitch_from_base,
    scale_degree_for_pitch,
)
from audio import find_wem_files, convert_wem
from tunings import tuning_name, DEFAULT_TUNINGS, DEFAULT_REFERENCE_PITCH, apply_reference_pitch
import sloppak as sloppak_mod
import drums as drums_mod
import notation as notation_mod
import loosefolder as loosefolder_mod
# Metadata extraction lives in a side-effect-free module so ProcessPool
# scan workers can import + unpickle _scan_one without re-running this
# module's import-time side effects (see lib/scan_worker.py).
from scan_worker import _extract_meta_for_file, _relpath, _scan_one

import concurrent.futures
import contextlib
import contextvars
import inspect
import ipaddress
import multiprocessing
import re
import sqlite3
import threading
import time
import uuid
import warnings
import xml.etree.ElementTree as ET

import structlog
from fastapi import Request

app = FastAPI(title="FeedBack")

# Plugins that maintain session stores can register a cleanup callback here.
# The demo-mode janitor calls every registered hook once per hour so stale
# sessions are swept without the core needing to know plugin internals.
_DEMO_JANITOR_HOOKS: list = []
_DEMO_JANITOR_HOOKS_LOCK = threading.Lock()
_DEMO_JANITOR_STARTED = False
_DEMO_JANITOR_STOP = threading.Event()
_DEMO_JANITOR_THREAD: threading.Thread | None = None


def register_demo_janitor_hook(fn) -> None:
    """Register a zero-argument callable to be invoked hourly by the demo
    janitor.  Plugins call this from their ``setup(app, context)`` when they
    want to participate in session cleanup under demo mode.

    The callable must accept no required arguments.  Async (coroutine)
    functions are rejected: the janitor runs in a plain thread and cannot
    await coroutines.
    """
    if not callable(fn):
        raise TypeError(
            f"register_demo_janitor_hook expects a callable, got {type(fn).__name__!r}"
        )
    # Reject coroutine functions — check both the callable itself and its
    # __call__ method so objects with an async __call__ (e.g. class instances,
    # functools.partial wrappers around async functions) are also caught.
    _call = getattr(fn, "__call__", None)
    if inspect.iscoroutinefunction(fn) or (
        _call is not None and inspect.iscoroutinefunction(_call)
    ):
        raise TypeError(
            "register_demo_janitor_hook does not accept async functions; "
            "the janitor runs in a plain thread and cannot await coroutines"
        )
    # Validate that the callable accepts zero required arguments so it won't
    # crash at sweep time (hourly, far from the registration site).
    try:
        sig = inspect.signature(fn)
    except ValueError:
        # inspect.signature() raises ValueError for built-in C callables whose
        # signature cannot be determined.  Accept them as-is; if they fail at
        # runtime the janitor will catch and log the exception.
        pass
    else:
        required = [
            p for p in sig.parameters.values()
            if p.default is inspect.Parameter.empty
            and p.kind not in (
                inspect.Parameter.VAR_POSITIONAL,
                inspect.Parameter.VAR_KEYWORD,
            )
        ]
        if required:
            raise TypeError(
                f"register_demo_janitor_hook expects a zero-argument callable; "
                f"{fn!r} has {len(required)} required parameter(s): "
                + ", ".join(p.name for p in required)
            )
    with _DEMO_JANITOR_HOOKS_LOCK:
        _DEMO_JANITOR_HOOKS.append(fn)


def _run_janitor_hook(hook) -> None:
    """Run a single janitor hook inline, swallowing and logging any exception.

    If the hook returns an awaitable (e.g. a coroutine slipped through the
    async-function guard), the coroutine is closed immediately to avoid
    ``RuntimeWarning: coroutine was never awaited`` noise, and a warning is
    emitted so the plugin author knows to fix their hook.
    """
    try:
        result = hook()
    except Exception:
        log.exception("janitor hook %r raised", hook)
        return
    if inspect.iscoroutine(result):
        # A coroutine slipped through the async-function guard (e.g. via a
        # wrapper/partial).  Close it to suppress "coroutine never awaited",
        # then warn so the plugin author knows to fix their hook.
        try:
            result.close()
        except Exception:
            log.exception("error closing coroutine from janitor hook %r", hook)
        warnings.warn(
            f"janitor hook {hook!r} returned a coroutine; "
            "hooks must be plain synchronous callables — "
            "register_demo_janitor_hook does not accept async functions",
            RuntimeWarning,
            stacklevel=1,
        )
    elif inspect.isawaitable(result):
        # Future/Task: no .close() method; just warn and leave it alone.
        warnings.warn(
            f"janitor hook {hook!r} returned an awaitable (Future/Task); "
            "hooks must be plain synchronous callables",
            RuntimeWarning,
            stacklevel=1,
        )


_DEMO_BLOCKED: list[tuple[str, re.Pattern]] = [
    ("POST",   re.compile(r"^/api/settings$")),
    ("POST",   re.compile(r"^/api/settings/import$")),
    ("POST",   re.compile(r"^/api/settings/reset$")),
    ("POST",   re.compile(r"^/api/rescan$")),
    ("POST",   re.compile(r"^/api/rescan/full$")),
    ("POST",   re.compile(r"^/api/songs/upload$")),
    ("DELETE", re.compile(r"^/api/song/.+$")),
    ("POST",   re.compile(r"^/api/favorites/toggle$")),
    ("POST",   re.compile(r"^/api/loops$")),
    ("DELETE", re.compile(r"^/api/loops/[^/]+$")),
    ("POST",   re.compile(r"^/api/audio-effects/mappings$")),
    ("DELETE", re.compile(r"^/api/audio-effects/mappings/[^/]+$")),
    ("POST",   re.compile(r"^/api/audio-effects/mappings/[^/]+/activate$")),
    ("DELETE", re.compile(r"^/api/audio-effects/active-mapping$")),
    ("POST",   re.compile(r"^/api/song/.*/meta$")),
    ("POST",   re.compile(r"^/api/song/.*/art/upload$")),
    ("GET",    re.compile(r"^/api/plugins/updates$")),
    ("POST",   re.compile(r"^/api/plugins/[^/]+/update$")),
    ("POST",   re.compile(r"^/api/plugins/editor/save$")),
    ("POST",   re.compile(r"^/api/plugins/editor/build$")),
    ("POST",   re.compile(r"^/api/plugins/editor/upload-art$")),
    ("POST",   re.compile(r"^/api/plugins/editor/upload-audio$")),
    ("POST",   re.compile(r"^/api/plugins/editor/youtube-audio$")),
    ("POST",   re.compile(r"^/api/plugins/editor/import-gp$")),
    ("POST",   re.compile(r"^/api/plugins/editor/import-midi$")),
    ("POST",   re.compile(r"^/api/plugins/lyrics_karaoke/align$")),
    ("POST",   re.compile(r"^/api/plugins/lyrics_karaoke/generate-pitch$")),
    ("POST",   re.compile(r"^/api/plugins/lyrics_karaoke/save-lyrics$")),
    ("POST",   re.compile(r"^/api/plugins/lyrics_sync/align$")),
    ("POST",   re.compile(r"^/api/plugins/lyrics_sync/save$")),
    ("POST",   re.compile(r"^/api/plugins/studio/sessions/[^/]+/extract-drums$")),
    ("POST",   re.compile(r"^/api/diagnostics/export$")),
    ("GET",    re.compile(r"^/api/diagnostics/preview$")),
    ("GET",    re.compile(r"^/api/diagnostics/hardware$")),
    # Bundled core plugin — video background upload/delete
    ("POST",   re.compile(r"^/api/plugins/highway_3d/files$")),
    ("DELETE", re.compile(r"^/api/plugins/highway_3d/files$")),
    # fee[dB]ack v0.3.0 write endpoints — demo mode is read-only, so block the
    # new profile / XP / stats / playlists / saved mutators too.
    ("POST",   re.compile(r"^/api/profile$")),
    ("POST",   re.compile(r"^/api/profile/avatar$")),
    ("POST",   re.compile(r"^/api/xp/award$")),
    ("POST",   re.compile(r"^/api/stats$")),
    ("POST",   re.compile(r"^/api/playlists$")),
    ("PATCH",  re.compile(r"^/api/playlists/[^/]+$")),
    ("DELETE", re.compile(r"^/api/playlists/[^/]+$")),
    ("POST",   re.compile(r"^/api/playlists/[^/]+/songs$")),
    ("DELETE", re.compile(r"^/api/playlists/[^/]+/songs/.+$")),
    ("POST",   re.compile(r"^/api/playlists/[^/]+/reorder$")),
    ("POST",   re.compile(r"^/api/playlists/[^/]+/cover$")),
    ("DELETE", re.compile(r"^/api/playlists/[^/]+/cover$")),
    ("POST",   re.compile(r"^/api/saved/toggle$")),
    # Progression (spec 010) write endpoints — demo mode stays read-only.
    ("POST",   re.compile(r"^/api/progression/paths$")),
    ("POST",   re.compile(r"^/api/progression/onboarding$")),
    ("POST",   re.compile(r"^/api/progression/events$")),
    ("POST",   re.compile(r"^/api/shop/buy$")),
    ("POST",   re.compile(r"^/api/shop/equip$")),
]


@app.middleware("http")
async def _demo_mode_guard(request: Request, call_next):
    if getenv_compat("FEEDBACK_DEMO_MODE") or getenv_compat("FEEDBACK_DEMO_MODE") == "1":
        path = request.url.path
        for method, pattern in _DEMO_BLOCKED:
            if request.method == method and pattern.match(path):
                return JSONResponse({"error": "demo mode: read-only"}, status_code=403)
        response = await call_next(request)
        if request.method == "GET" and path == "/" and "feedBack_demo_session" not in request.cookies:
            forwarded_proto = (request.headers.get("x-forwarded-proto") or "").split(",")[0].strip()
            is_secure = request.url.scheme == "https" or forwarded_proto.lower() == "https"
            response.set_cookie(
                "feedBack_demo_session", str(uuid.uuid4()),
                max_age=86400, httponly=True, samesite="lax",
                secure=is_secure,
            )
        return response
    return await call_next(request)

from asgi_correlation_id import CorrelationIdMiddleware

# validator=None accepts any non-empty inbound X-Request-ID value, including
# opaque proxy-generated hex strings, not just RFC-4122 UUIDs.
app.add_middleware(CorrelationIdMiddleware, validator=None)

STATIC_DIR = Path(__file__).parent / "static"
try:
    STATIC_DIR.mkdir(exist_ok=True)
except OSError:
    pass  # Read-only in packaged installs

# Distinguish "env not set / empty" from "explicitly set". Path("") collapses
# to Path(".") so we can't recover that signal after the cast — capture the
# raw env-var string up front and let _get_dlc_dir() consult both. This way
# `DLC_DIR=.` remains a valid opt-in for cwd while `DLC_DIR=""` (or unset)
# falls through to the config.json fallback.
_DLC_DIR_ENV = os.environ.get("DLC_DIR", "").strip()
DLC_DIR = Path(_DLC_DIR_ENV) if _DLC_DIR_ENV else Path("")
CONFIG_DIR = Path(os.environ.get("CONFIG_DIR", str(Path.home() / ".local" / "share" / "feedback")))

# Writable cache directories (use CONFIG_DIR, not STATIC_DIR which may be read-only)
ART_CACHE_DIR = CONFIG_DIR / "art_cache"
AUDIO_CACHE_DIR = CONFIG_DIR / "audio_cache"
SLOPPAK_CACHE_DIR = CONFIG_DIR / "sloppak_cache"


def _env_flag(name: str) -> bool:
    """Parse a conventional boolean env flag (honours legacy SLOPSMITH_* alias)."""
    return (getenv_compat(name, "") or "").strip().lower() in {"1", "true", "yes", "on"}


# Canonical Tuning-filter grouping key (feedBack#867). tuning_name collapses
# every non-standard tuning to "Custom Tuning"; for those rows we key on the
# raw offsets so distinct customs stay distinct, while named tunings keep
# grouping by name (stable across the offsets-column migration). Used by both
# the tuning-names listing and the filter WHERE so the contract matches.
def _tuning_group_key_sql(alias: str) -> str:
    """The tuning grouping key (name for named tunings, raw offsets for
    customs) against an explicit table alias — the grouped filter law (§7.1)
    evaluates chart-intrinsic predicates inside a member subquery, where bare
    column names would resolve against the wrong scope."""
    return (f"CASE WHEN {alias}.tuning_name = 'Custom Tuning' AND COALESCE({alias}.tuning_offsets, '') != '' "
            f"THEN {alias}.tuning_offsets ELSE {alias}.tuning_name END")


_TUNING_GROUP_KEY_SQL = _tuning_group_key_sql("songs")


# ── SQLite metadata cache ─────────────────────────────────────────────────────

def _ensure_smart_names(arrangements: list[dict]) -> list[dict]:
    """Fill in missing ``smart_name`` fields and sort arrangements by smart order.

    Applied to every library query result so the client always receives
    arrangements in priority order:
      Lead → Alt. Lead [1,2,…] → Bonus Lead [1,2,…]
      → Rhythm → Alt. Rhythm → Bonus Rhythm
      → Bass → Alt. Bass → Bonus Bass → other

    Rows scanned before the smart-naming feature was introduced don't carry a
    ``smart_name`` key.  The background scanner automatically rescans those rows
    to populate the field from authoritative manifest JSON path flags.

    In the meantime this function provides a best-effort on-the-fly computation.
    However, when multiple arrangements share the same name (e.g. two "Combo"
    tracks in a archive that bundles all path flags as zero), name-based inference
    cannot distinguish Lead from Rhythm — so we emit ``smart_name: null`` and
    let the UI fall back to the legacy name until the background rescan corrects
    the row.  Arrangements that already have the field are never modified.
    """
    if not arrangements:
        return arrangements

    # Fill in missing smart_name values.
    if not all("smart_name" in a for a in arrangements):
        # Detect duplicate raw names across ALL arrangements (not just the
        # missing subset).  A duplicate anywhere means the name-based fallback
        # may assign the same smart type a scanned row already owns — emit
        # None for the missing entries and let the legacy name show through
        # until the background rescan corrects them.
        # Coerce to str so a malformed cached row with a list/dict name
        # doesn't blow up the set() conversion (and every query that hits it).
        all_names = [
            a.get("name", "") if isinstance(a.get("name"), str) else str(a.get("name", ""))
            for a in arrangements
        ]
        has_duplicates = len(all_names) != len(set(all_names))
        if has_duplicates:
            for a in arrangements:
                if "smart_name" not in a:
                    a["smart_name"] = None
        else:
            # No duplicates — name-based fallback is safe.
            from song import Arrangement as _ArrCls
            arr_objs = [
                _ArrCls(
                    name=a.get("name", ""),
                    path_lead=a.get("_path_lead", False),
                    path_rhythm=a.get("_path_rhythm", False),
                    path_bass=a.get("_path_bass", False),
                    bonus_arr=a.get("_bonus_arr", False),
                    represent=a.get("_represent", 0),
                )
                for a in arrangements
            ]
            smart = compute_smart_names(arr_objs)
            for a, sn in zip(arrangements, smart):
                if "smart_name" not in a:
                    a["smart_name"] = sn

    # Always sort by smart priority order so the client receives a consistent
    # list regardless of how the DB row was originally stored.
    # _arr_smart_sort_key is defined later in this module but resolved at
    # call-time, so the forward reference is safe.
    arrangements.sort(key=_arr_smart_sort_key)
    return arrangements


def _sqlite_file_integrity_ok(path: Path) -> bool:
    """True if `path` is a SQLite database that opens and passes
    `PRAGMA quick_check`. Used to gate a DB restore so a truncated or
    corrupt snapshot can never overwrite the live library DB."""
    try:
        with open(path, "rb") as f:
            if f.read(16) != b"SQLite format 3\x00":   # cheap header gate, no full read
                return False
    except OSError:
        return False
    conn = None
    try:
        conn = sqlite3.connect(str(path))
        row = conn.execute("PRAGMA quick_check").fetchone()
        return bool(row) and row[0] == "ok"
    except sqlite3.Error:
        return False
    finally:
        if conn is not None:
            conn.close()
        # quick_check on a non-WAL file makes no sidecars, but a malformed
        # file can; sweep them so a probe never litters config_dir.
        for suffix in ("-wal", "-shm"):
            try:
                path.with_name(path.name + suffix).unlink()
            except FileNotFoundError:
                pass


def _apply_pending_db_restore(config_dir: Path) -> None:
    """Swap in a library DB restored from a settings bundle, if one is
    staged. A settings import writes the restored snapshot to
    `web_library.db.restore` rather than over the live DB (the running
    server holds the old file open, and a stale `-wal`/`-shm` could be
    replayed onto a fresh main file → corruption). The swap happens here,
    at startup, BEFORE the connection opens: delete the old DB and its WAL
    sidecars, then rename the staged snapshot into place. The snapshot is a
    fully-checkpointed single file (SQLite online-backup API), so it needs
    no sidecars of its own. Idempotent and a no-op when nothing is staged.

    The staged file is re-validated here before anything is destroyed: a
    restore that fails its integrity check is discarded and the live DB is
    left untouched, so a bad bundle can never brick startup or lose data."""
    pending = config_dir / "web_library.db.restore"
    if not pending.exists():
        return
    if not _sqlite_file_integrity_ok(pending):
        log.error("pending library DB restore failed its integrity check; "
                  "discarding it and keeping the existing database")
        try:
            pending.unlink()
        except FileNotFoundError:
            pass
        return
    for suffix in ("", "-wal", "-shm"):
        try:
            (config_dir / f"web_library.db{suffix}").unlink()
        except FileNotFoundError:
            pass
    os.replace(pending, config_dir / "web_library.db")
    log.info("applied pending library DB restore from settings import")


# ── Keyset (cursor) pagination for the library grid (feedBack#636 item 3) ─────
# Forward-only, O(page) deep paging that doesn't grow with OFFSET. Only simple
# single-column sorts can keyset cleanly (the compound tuning/year sorts fall
# back to OFFSET). Every sort gets a unique `filename` tiebreak so the order is
# TOTAL — which also fixes a latent OFFSET skip/dupe across equal-key rows.
# (column, collate-clause, primary-direction) — tiebreak is always `filename` ASC.
_KEYSET_SORTS = {
    "artist": ("artist", "COLLATE NOCASE", "ASC"),
    "artist-desc": ("artist", "COLLATE NOCASE", "DESC"),
    "title": ("title", "COLLATE NOCASE", "ASC"),
    "title-desc": ("title", "COLLATE NOCASE", "DESC"),
    "recent": ("mtime", "", "DESC"),
}
# Index into a query_page row tuple for each keyset column (see the SELECT in
# query_page: filename, title, artist, ... mtime at 9).
_KEYSET_ROW_IDX = {"artist": 2, "title": 1, "mtime": 9}


def _encode_cursor(values: list) -> str:
    import base64
    return base64.urlsafe_b64encode(json.dumps(values).encode("utf-8")).decode("ascii")


def _decode_cursor(cursor: str):
    """Decode an opaque keyset cursor to [sort_value, filename], or None if it's
    malformed (a bad cursor degrades to the first page, never 500s)."""
    import base64
    try:
        out = json.loads(base64.urlsafe_b64decode(cursor.encode("ascii")).decode("utf-8"))
    except (ValueError, TypeError):
        return None
    return out if isinstance(out, list) and len(out) == 2 else None


def _effective_keyset_sort(sort: str, direction: str) -> str:
    """Fold the legacy `dir=desc` toggle into the canonical keyset sort key, so
    the seek/cursor direction matches the ORDER BY that same toggle produces
    (without this, `sort=artist&dir=desc` would seek with `>` against a DESC
    order → gaps/dupes)."""
    if direction == "desc" and sort in ("artist", "title"):
        return sort + "-desc"
    return sort


def _keyset_seek(col: str, collate: str, primary_dir: str, cv, fn: str):
    """(sql, params) for 'rows strictly after (cv, fn)' in the total order
    `<col> <primary_dir>, filename ASC`, matching SQLite's NULL placement
    (NULLs sort first in ASC, last in DESC) so keyset is exactly OFFSET-
    equivalent even for NULL sort keys."""
    ce = f"{col} {collate}".strip()
    if primary_dir == "ASC":   # NULLs first
        if cv is None:
            return (f"(({col} IS NULL AND filename > ?) OR {col} IS NOT NULL)", [fn])
        return (f"({col} IS NOT NULL AND ({ce} > ? OR ({ce} = ? AND filename > ?)))",
                [cv, cv, fn])
    # DESC — NULLs last
    if cv is None:
        return (f"({col} IS NULL AND filename > ?)", [fn])
    return (f"({col} IS NULL OR ({col} IS NOT NULL AND "
            f"({ce} < ? OR ({ce} = ? AND filename > ?))))", [cv, cv, fn])


def next_library_cursor(sort: str, last_song: dict | None) -> str | None:
    """The cursor for the last row of a page, so the next request resumes after
    it. None when the sort can't keyset or the page was empty."""
    if sort not in _KEYSET_SORTS or not last_song:
        return None
    col = _KEYSET_SORTS[sort][0]
    key = "mtime" if col == "mtime" else col
    if key not in last_song or "filename" not in last_song:
        return None
    return _encode_cursor([last_song[key], last_song["filename"]])


# Song-level "mastered" threshold — best accuracy across a song's arrangements
# at/above this counts as in your repertoire. One number shared by the green
# accuracy badge, the Repertoire meter, the mastery filter/sort, and the P3
# growth-edge recommender (matches the frontend MASTERY_ACCURACY).
MASTERY_ACCURACY = 0.9


class MetadataDB:
    def __init__(self):
        CONFIG_DIR.mkdir(parents=True, exist_ok=True)
        _apply_pending_db_restore(CONFIG_DIR)
        self.db_path = str(CONFIG_DIR / "web_library.db")
        self.conn = sqlite3.connect(self.db_path, check_same_thread=False)
        self.conn.execute("PRAGMA journal_mode=WAL")
        self.conn.execute("""
            CREATE TABLE IF NOT EXISTS songs (
                filename TEXT PRIMARY KEY,
                mtime REAL,
                size INTEGER,
                title TEXT,
                artist TEXT,
                album TEXT,
                year TEXT,
                duration REAL,
                tuning TEXT,
                arrangements TEXT,
                has_lyrics INTEGER DEFAULT 0,
                format TEXT DEFAULT 'archive',
                stem_count INTEGER DEFAULT 0,
                stem_ids TEXT DEFAULT '[]',
                tuning_name TEXT DEFAULT '',
                tuning_sort_key INTEGER DEFAULT 0,
                tuning_offsets TEXT DEFAULT ''
            )
        """)
        # Idempotent migrations for installs that predate each column.
        for ddl in (
            "ALTER TABLE songs ADD COLUMN format TEXT DEFAULT 'archive'",
            "ALTER TABLE songs ADD COLUMN stem_count INTEGER DEFAULT 0",
            # feedBack#129: per-stem filter needs the id list, not just count.
            "ALTER TABLE songs ADD COLUMN stem_ids TEXT DEFAULT '[]'",
            # feedBack#69 + #22: denormalized canonical tuning name + numeric
            # sort key (sum of offsets). The existing `tuning` text column
            # stays — these are caches, repopulated on rescan.
            "ALTER TABLE songs ADD COLUMN tuning_name TEXT DEFAULT ''",
            "ALTER TABLE songs ADD COLUMN tuning_sort_key INTEGER DEFAULT 0",
            # feedBack#867: raw per-string offsets (space-joined ints) so the
            # v3 client can render target notes and the Tuning filter can keep
            # distinct custom tunings distinct (tuning_name collapses them all
            # to "Custom Tuning"). Cache; repopulated on rescan.
            "ALTER TABLE songs ADD COLUMN tuning_offsets TEXT DEFAULT ''",
        ):
            try:
                self.conn.execute(ddl)
            except sqlite3.OperationalError:
                pass
        self.conn.execute("CREATE INDEX IF NOT EXISTS idx_songs_artist ON songs(artist COLLATE NOCASE)")
        self.conn.execute("CREATE INDEX IF NOT EXISTS idx_songs_title ON songs(title COLLATE NOCASE)")
        # Composite (sort col, filename) indexes cover the grid's ORDER BY +
        # its unique filename tiebreak — for both the OFFSET scan and keyset
        # seek (feedBack#636 item 3). idx_songs_artist/title above stay for the
        # distinct-artist / letter-bar aggregates.
        self.conn.execute("CREATE INDEX IF NOT EXISTS idx_songs_artist_fn ON songs(artist COLLATE NOCASE, filename)")
        self.conn.execute("CREATE INDEX IF NOT EXISTS idx_songs_title_fn ON songs(title COLLATE NOCASE, filename)")
        self.conn.execute("CREATE INDEX IF NOT EXISTS idx_songs_mtime_fn ON songs(mtime, filename)")
        self.conn.execute("CREATE INDEX IF NOT EXISTS idx_songs_tuning_name ON songs(tuning_name COLLATE NOCASE)")
        self.conn.execute("CREATE INDEX IF NOT EXISTS idx_songs_tuning_sort_key ON songs(tuning_sort_key)")
        self.conn.execute("CREATE INDEX IF NOT EXISTS idx_songs_year ON songs(year)")
        self.conn.execute("CREATE TABLE IF NOT EXISTS favorites (filename TEXT PRIMARY KEY)")
        # Personal, per-song metadata that must NEVER travel in the shared
        # feedpak file: a light 1–5 user-difficulty (planning only — distinct
        # from the authored 1–10 difficulty bands) + freeform notes. Likes are
        # NOT here — they stay the existing `favorites` heart (Christian's call).
        # A SEPARATE table (not `songs` columns) so a rescan's
        # `INSERT OR REPLACE INTO songs` can't wipe it; keyed by the same on-disk
        # filename as every other personal table. Additive + idempotent.
        self.conn.execute("""
            CREATE TABLE IF NOT EXISTS song_user_meta (
                filename TEXT PRIMARY KEY,
                user_difficulty INTEGER,   -- 1..5, NULL = unset
                notes TEXT,
                updated_at TEXT
            )
        """)
        # Free-form personal practice tags ("warm-ups", "riffs to nail") — an
        # intent practice-set primitive (Play-all-over-a-tag comes later). Tags
        # are normalized lowercase on write so "Rock"/"rock" don't split. Peer
        # of song_user_meta; same never-clobber rationale.
        self.conn.execute("""
            CREATE TABLE IF NOT EXISTS song_tags (
                filename TEXT NOT NULL,
                tag TEXT NOT NULL,
                created_at TEXT,
                PRIMARY KEY (filename, tag)
            )
        """)
        self.conn.execute("CREATE INDEX IF NOT EXISTS idx_song_tags_tag ON song_tags(tag COLLATE NOCASE)")
        # Artist-name aliases (P4): "ACDC" → "AC/DC", "the beatles" → "The Beatles".
        # A CANONICALIZATION OVERRIDE applied AT DISPLAY only — the scanner-derived
        # `songs.artist` and the feedpak files are never rewritten (a rescan can't
        # fight the user; one alias row fixes every matching song at once). Keyed by
        # the raw artist string (COLLATE NOCASE so case variants collapse), so it is
        # NOT filename-keyed → never touched by delete_missing/delete_song (an alias
        # outlives the songs that motivated it, ready for re-import). mb_artist_id is
        # reserved for a future confident MusicBrainz match (unused now).
        self.conn.execute("""
            CREATE TABLE IF NOT EXISTS artist_alias (
                raw_name TEXT PRIMARY KEY COLLATE NOCASE,
                canonical_name TEXT NOT NULL,
                mb_artist_id TEXT,
                updated_at TEXT
            )
        """)
        # ── Multi-chart grouping (P5a) ───────────────────────────────────────
        # A "work" is a song that may be charted by several feedpaks; each chart
        # stays its own `songs` row (unchanged), but they GROUP under a shared
        # work_key = normalize(artist+title). Two sparse, never-purged-on-rescan
        # override tables + one MATERIALIZED read-model so the grid can group
        # server-side without a query-time GROUP BY (which would kill the keyset
        # seek / A–Z / virtualization — see query_page).
        #
        # chart_group_pref: your chosen "keeper" chart per work (sparse; unset ⇒
        # auto-pick). Keyed by work_key, NOT filename, so it survives a chart's
        # rescan; an orphaned preferred (file gone) degrades to auto-pick.
        self.conn.execute("""
            CREATE TABLE IF NOT EXISTS chart_group_pref (
                work_key TEXT PRIMARY KEY,
                preferred_filename TEXT NOT NULL,
                updated_at TEXT
            )
        """)
        # chart_group_split: "these aren't the same song" escape hatch — a chart
        # gets its own unique split_key so it stands alone as a singleton work.
        # Filename-keyed → purged with the song on delete_song.
        self.conn.execute("""
            CREATE TABLE IF NOT EXISTS chart_group_split (
                filename TEXT PRIMARY KEY,
                split_key TEXT NOT NULL,
                updated_at TEXT
            )
        """)
        # work_display: the MATERIALIZED representative-filter read-model, rebuilt
        # from songs + the two override tables. One row per song:
        #   effective_work_key    = split_key if split else work_key
        #   is_group_representative = 1 for the keeper (pref or auto-pick) of a work
        #   group_size            = the ⚑ N charts in the work
        # Grouping-ON is then just `WHERE is_group_representative = 1` (keyset-safe).
        # A derived cache: filename-keyed, rebuilt on demand (dirty flag) — safe to
        # drop/rebuild, so it's purged on delete and re-materialized after a scan.
        self.conn.execute("""
            CREATE TABLE IF NOT EXISTS work_display (
                filename TEXT PRIMARY KEY,
                work_key TEXT NOT NULL,
                effective_work_key TEXT NOT NULL,
                is_group_representative INTEGER NOT NULL DEFAULT 1,
                group_size INTEGER NOT NULL DEFAULT 1
            )
        """)
        self.conn.execute("CREATE INDEX IF NOT EXISTS idx_work_display_rep ON work_display(is_group_representative)")
        self.conn.execute("CREATE INDEX IF NOT EXISTS idx_work_display_eff ON work_display(effective_work_key)")
        self.conn.execute("CREATE INDEX IF NOT EXISTS idx_work_display_wk ON work_display(work_key)")
        self.conn.execute("""
            CREATE TABLE IF NOT EXISTS loops (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                filename TEXT NOT NULL,
                name TEXT NOT NULL,
                start_time REAL NOT NULL,
                end_time REAL NOT NULL,
                created_at TEXT DEFAULT (datetime('now'))
            )
        """)
        # fee[dB]ack v0.3.0 — single-user player profile (id=1), streak, and the
        # unified XP store. Peers of favorites/loops; additive + idempotent.
        # `player_hash` is a future-leaderboard identity label (SHA-256 of the
        # first display name + a once-generated salt), never an auth credential.
        self.conn.execute("""
            CREATE TABLE IF NOT EXISTS profile (
                id INTEGER PRIMARY KEY CHECK (id = 1),
                display_name TEXT,
                avatar_path TEXT,
                player_hash TEXT,
                player_salt TEXT,
                onboarded INTEGER NOT NULL DEFAULT 0,
                created_at TEXT
            )
        """)
        self.conn.execute("""
            CREATE TABLE IF NOT EXISTS profile_progress (
                id INTEGER PRIMARY KEY CHECK (id = 1),
                current_streak INTEGER NOT NULL DEFAULT 0,
                best_streak INTEGER NOT NULL DEFAULT 0,
                last_active_date TEXT          -- YYYY-MM-DD (local)
            )
        """)
        # Unified XP store: the single source of truth the profile badge reads.
        # Song-play, minigames, and tutorials all feed THIS via award_xp() — no
        # second XP curve (lib/xp.py owns the math).
        self.conn.execute("""
            CREATE TABLE IF NOT EXISTS xp_profile (
                id INTEGER PRIMARY KEY CHECK (id = 1),
                xp INTEGER NOT NULL DEFAULT 0,
                total_awards INTEGER NOT NULL DEFAULT 0,
                minigames_seeded INTEGER NOT NULL DEFAULT 0,
                updated_at TEXT
            )
        """)
        # Per-source XP ledger: the unified `xp` total above is a single number,
        # but a source (minigames, tutorials, song-play, …) needs to know its own
        # contribution so it can be reset/reversed independently (a minigames
        # profile-reset must subtract only its share, not song-play XP).
        self.conn.execute("""
            CREATE TABLE IF NOT EXISTS xp_sources (
                source TEXT PRIMARY KEY,
                xp INTEGER NOT NULL DEFAULT 0
            )
        """)
        # Per-song/arrangement practice stats (best score + accuracy, plays,
        # last position for Continue-Playing). Fed by the highway note-detection
        # scorer via POST /api/stats. Additive + idempotent; a 0.2.9 build
        # tolerates it and the new build opens an old db without it.
        self.conn.execute("""
            CREATE TABLE IF NOT EXISTS song_stats (
                filename TEXT NOT NULL,
                arrangement INTEGER NOT NULL DEFAULT 0,
                plays INTEGER NOT NULL DEFAULT 0,
                best_score INTEGER NOT NULL DEFAULT 0,
                best_accuracy REAL NOT NULL DEFAULT 0,
                last_score INTEGER NOT NULL DEFAULT 0,
                last_accuracy REAL NOT NULL DEFAULT 0,
                last_position REAL NOT NULL DEFAULT 0,
                last_played_at TEXT,
                updated_at TEXT,
                PRIMARY KEY (filename, arrangement)
            )
        """)
        self.conn.execute("CREATE INDEX IF NOT EXISTS idx_song_stats_recent ON song_stats(last_played_at DESC)")
        # Playlists + the reserved "Saved for Later" system playlist. Additive.
        self.conn.execute("""
            CREATE TABLE IF NOT EXISTS playlists (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                name TEXT NOT NULL,
                system_key TEXT,            -- 'saved_for_later' for reserved playlists, else NULL
                created_at TEXT,
                updated_at TEXT
            )
        """)
        self.conn.execute("""
            CREATE TABLE IF NOT EXISTS playlist_songs (
                playlist_id INTEGER NOT NULL,
                filename TEXT NOT NULL,
                position INTEGER NOT NULL DEFAULT 0,
                PRIMARY KEY (playlist_id, filename)
            )
        """)
        self.conn.execute("CREATE UNIQUE INDEX IF NOT EXISTS idx_playlists_system_key ON playlists(system_key) WHERE system_key IS NOT NULL")
        # Smart collections (feedBack#636 item 2): a playlist row whose `rules`
        # JSON is non-NULL is a smart/dynamic collection — its membership is the
        # LIVE result of those library filter params, not a stored song list.
        # It surfaces as a registered library provider (the v3 source picker),
        # so it inherits the whole Songs UI. Additive, idempotent migration.
        try:
            self.conn.execute("ALTER TABLE playlists ADD COLUMN rules TEXT")
        except sqlite3.OperationalError:
            pass
        # Curated album (P6, metadata-design §7.2): a playlists row with
        # kind='album' is a hand-picked, ORDERED practice set of works with a
        # chosen chart per slot — the repeatable gameplay loop. Reuses the
        # playlist machinery wholesale (membership/order/cover/queue); the whole
        # schema delta is this `kind` discriminator plus two per-slot columns:
        # `arrangement` = the pinned arrangement NAME (names survive rescans;
        # the client resolves name→index at play), `work_key` = stamped at
        # add-time so a slot whose pinned chart is later deleted can self-heal
        # to the work's CURRENT preferred at read (never rewritten). Additive,
        # idempotent — same pattern as `rules` above.
        for _ddl in ("ALTER TABLE playlists ADD COLUMN kind TEXT",
                     "ALTER TABLE playlist_songs ADD COLUMN arrangement TEXT",
                     "ALTER TABLE playlist_songs ADD COLUMN work_key TEXT"):
            try:
                self.conn.execute(_ddl)
            except sqlite3.OperationalError:
                pass
        # Wishlist / "wanted" (feedBack#636 item 4): a persisted, actionable
        # list of songs the user does NOT own yet — the *arr "Wanted/Monitored"
        # analogue. Unlike playlists (which reference owned local songs by
        # filename), a wanted entry has no local file, so it lives in its own
        # table keyed by descriptive identity. Producers (the find_more plugin's
        # ownership-diff, or a manual add) POST here; the consuming UI reads it.
        # Additive + idempotent.
        self.conn.execute("""
            CREATE TABLE IF NOT EXISTS wanted (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                artist TEXT NOT NULL DEFAULT '',
                title TEXT NOT NULL DEFAULT '',
                source TEXT NOT NULL DEFAULT '',      -- e.g. 'find_more', 'manual'
                source_ref TEXT NOT NULL DEFAULT '',  -- opaque id/url within that source
                note TEXT NOT NULL DEFAULT '',
                created_at TEXT
            )
        """)
        # Identity = (artist, title, source, source_ref), case-insensitive on
        # the human fields, so re-running an ownership-diff doesn't duplicate.
        self.conn.execute(
            "CREATE UNIQUE INDEX IF NOT EXISTS idx_wanted_identity "
            "ON wanted(artist COLLATE NOCASE, title COLLATE NOCASE, source, source_ref)"
        )
        # Progression (spec 010): instrument paths, challenges, quests, the
        # Decibels wallet, and the cosmetics shop. Targets/titles live in the
        # bundled content (data/progression/); these tables hold only player
        # state (counters, completion timestamps, spend, ownership) so content
        # edits update live displays without migrations. Additive + idempotent.
        self.conn.execute("""
            CREATE TABLE IF NOT EXISTS progression_state (
                id INTEGER PRIMARY KEY CHECK (id = 1),
                calibration_status TEXT NOT NULL DEFAULT 'pending',  -- pending|completed|skipped
                calibration_completed_at TEXT,
                created_at TEXT
            )
        """)
        self.conn.execute("""
            CREATE TABLE IF NOT EXISTS player_paths (
                path_id TEXT PRIMARY KEY,          -- 'guitar' | 'bass' | 'drums' | future
                level INTEGER NOT NULL DEFAULT 0,
                selected_at TEXT
            )
        """)
        self.conn.execute("""
            CREATE TABLE IF NOT EXISTS challenge_progress (
                challenge_id TEXT PRIMARY KEY,     -- namespaced 'guitar.l1.clean-run'
                path_id TEXT NOT NULL,
                level INTEGER NOT NULL,            -- the level whose set this belongs to
                count INTEGER NOT NULL DEFAULT 0,
                progress_detail TEXT,              -- JSON, e.g. {"seen": [...]} for distinct goals
                completed_at TEXT
            )
        """)
        self.conn.execute("""
            CREATE TABLE IF NOT EXISTS quest_state (
                period_type TEXT NOT NULL,         -- 'daily' | 'weekly'
                period_key TEXT NOT NULL,          -- '2026-06-12' | '2026-W24'
                quest_id TEXT NOT NULL,
                count INTEGER NOT NULL DEFAULT 0,
                reward_db INTEGER NOT NULL DEFAULT 0,  -- snapshot at instantiation
                progress_detail TEXT,
                completed_at TEXT,
                PRIMARY KEY (period_type, period_key, quest_id)
            )
        """)
        # Spend is tracked separately from xp_profile.xp on purpose: the xp
        # total stays the monotonic lifetime-earned stat (db_earned goals,
        # xp_sources reset semantics) and balance = MAX(0, xp - spent).
        self.conn.execute("""
            CREATE TABLE IF NOT EXISTS wallet (
                id INTEGER PRIMARY KEY CHECK (id = 1),
                spent INTEGER NOT NULL DEFAULT 0
            )
        """)
        self.conn.execute("""
            CREATE TABLE IF NOT EXISTS shop_owned (
                item_id TEXT PRIMARY KEY,
                cost_paid INTEGER NOT NULL DEFAULT 0,
                acquired_at TEXT
            )
        """)
        self.conn.execute("""
            CREATE TABLE IF NOT EXISTS shop_equipped (
                slot TEXT PRIMARY KEY,             -- 'theme' | 'avatar_frame'
                item_id TEXT
            )
        """)
        # Ensure the singleton rows exist so reads never special-case "no row".
        self.conn.execute("INSERT OR IGNORE INTO profile (id, onboarded, created_at) VALUES (1, 0, datetime('now'))")
        self.conn.execute("INSERT OR IGNORE INTO profile_progress (id) VALUES (1)")
        self.conn.execute("INSERT OR IGNORE INTO xp_profile (id, xp, total_awards, updated_at) VALUES (1, 0, 0, datetime('now'))")
        self.conn.execute("INSERT OR IGNORE INTO progression_state (id, created_at) VALUES (1, datetime('now'))")
        self.conn.execute("INSERT OR IGNORE INTO wallet (id) VALUES (1)")
        self.conn.commit()
        self._lock = threading.Lock()
        # work_display (P5a) is a derived cache; True forces a (re)build on the
        # first grouped query and after any songs churn (put / delete / rescan).
        self._work_display_dirty = True
        # One-time repair of pre-fix rows written under URL-encoded filenames
        # (idempotent: a no-op once every row is canonical).
        self._migrate_decode_stat_filenames()

    def _song_exists(self, filename: str) -> bool:
        return self.conn.execute(
            "SELECT 1 FROM songs WHERE filename = ?", (filename,)).fetchone() is not None

    def _canonical_song_filename(self, filename: str) -> str:
        """Map a (possibly URL-encoded) filename to the `songs` library key.

        The recorder relays encodeURIComponent'd names ('/'→'%2F', ' '→'%20'),
        but `songs` keys on the decoded on-disk path. Decoding is LIBRARY-AWARE so
        a real filename that legitimately contains literal %XX is never corrupted:
        prefer the form that already exists in `songs`, and decode only when the
        decoded form resolves to a real song. When NEITHER form is in the library
        (e.g. a play recorded before the library scan finishes) keep the stored
        name unchanged — the next-startup migration canonicalizes it once the song
        is scanned, rather than risk corrupting a real %XX name now."""
        if not isinstance(filename, str):
            return filename
        if self._song_exists(filename):
            return filename                      # already a real library key (may contain %)
        from urllib.parse import unquote
        decoded = unquote(filename)
        if decoded != filename and self._song_exists(decoded):
            return decoded                       # encoded → real library key
        return filename                          # neither in library: leave as-is (heals on migrate)

    def _migrate_decode_stat_filenames(self):
        """Rewrite URL-encoded song_stats.filename rows to the decoded
        library-path key (the form `songs` uses). Pre-fix, the recorder stored
        encodeURIComponent'd names, so every recorded best was invisible to the
        reads that filter on `filename IN (SELECT filename FROM songs)`. Merge on
        collision — two encoded rows decoding to the same name, or an encoded row
        meeting an already-decoded one — with the same best=max / plays=sum /
        last-wins semantics as song_score.merge_stats, so the (filename,
        arrangement) primary key is never violated.

        Library-aware via the shared _canonical_song_filename rule: only decode a
        row when the decoded form is a real song, so a correctly-stored name
        containing literal %XX is never rewritten, and dead-song/orphan rows
        (neither form in the library) are left exactly as-is."""
        cols = self._STATS_COLS
        with self._lock:
            rows = [dict(zip(cols, r)) for r in self.conn.execute(
                "SELECT " + ", ".join(cols) + " FROM song_stats").fetchall()]
            canon = self._canonical_song_filename
            if all(canon(r["filename"]) == r["filename"] for r in rows):
                return  # every row already canonical (or an untouchable orphan)
            merged: dict = {}
            for r in rows:
                key = (canon(r["filename"]), int(r["arrangement"]))
                cur = merged.get(key)
                if cur is None:
                    merged[key] = dict(r, filename=key[0], arrangement=key[1])
                    continue
                # Most-recently-updated row wins the "last_*"/position fields.
                def _stamp(x):
                    return str(x.get("updated_at") or x.get("last_played_at") or "")
                newer = r if _stamp(r) >= _stamp(cur) else cur
                merged[key] = {
                    "filename": key[0], "arrangement": key[1],
                    "plays": (cur["plays"] or 0) + (r["plays"] or 0),
                    "best_score": max(cur["best_score"] or 0, r["best_score"] or 0),
                    "best_accuracy": max(cur["best_accuracy"] or 0.0, r["best_accuracy"] or 0.0),
                    "last_score": newer["last_score"], "last_accuracy": newer["last_accuracy"],
                    "last_position": newer["last_position"],
                    "last_played_at": newer["last_played_at"], "updated_at": newer["updated_at"],
                }
            # Atomic swap: clear and reinsert the canonicalized set in one txn.
            try:
                self.conn.execute("DELETE FROM song_stats")
                self.conn.executemany(
                    "INSERT INTO song_stats (" + ", ".join(cols) + ") VALUES ("
                    + ", ".join("?" * len(cols)) + ")",
                    [tuple(m[c] for c in cols) for m in merged.values()],
                )
                self.conn.commit()
            except Exception:
                self.conn.rollback()
                raise

    def is_favorite(self, filename: str) -> bool:
        return self.conn.execute("SELECT 1 FROM favorites WHERE filename = ?", (filename,)).fetchone() is not None

    def toggle_favorite(self, filename: str) -> bool:
        """Toggle favorite status. Returns new state."""
        with self._lock:
            if self.is_favorite(filename):
                self.conn.execute("DELETE FROM favorites WHERE filename = ?", (filename,))
                self.conn.commit()
                return False
            else:
                self.conn.execute("INSERT OR IGNORE INTO favorites VALUES (?)", (filename,))
                self.conn.commit()
                return True

    # ── Personal per-song metadata: user-difficulty / notes / tags ───────────
    # All keyed by the on-disk `songs` filename and kept OUT of the shared
    # feedpak file. Likes are the `favorites` heart, deliberately NOT duplicated
    # here. Reads are lock-free (WAL); writes take self._lock like the rest.
    def get_song_user_meta(self, filename: str) -> dict:
        """{'user_difficulty', 'notes', 'tags'} for one song (tags sorted)."""
        row = self.conn.execute(
            "SELECT user_difficulty, notes FROM song_user_meta WHERE filename = ?",
            (filename,)).fetchone()
        tags = [r[0] for r in self.conn.execute(
            "SELECT tag FROM song_tags WHERE filename = ? ORDER BY tag COLLATE NOCASE",
            (filename,)).fetchall()]
        return {
            "user_difficulty": (row[0] if row else None),
            "notes": ((row[1] if row else None) or ""),
            "tags": tags,
        }

    def set_song_user_meta(self, filename: str, *,
                           user_difficulty="__keep__", notes="__keep__") -> dict:
        """Partial upsert of the personal fields. Pass a value to set it, None to
        clear it, or leave it out (sentinel `__keep__`) to preserve the current
        one. When nothing personal remains the row is dropped so an
        unset-everything leaves no empty shell. Returns the merged meta."""
        with self._lock:
            cur = self.conn.execute(
                "SELECT user_difficulty, notes FROM song_user_meta WHERE filename = ?",
                (filename,)).fetchone()
            cur_diff = cur[0] if cur else None
            cur_notes = cur[1] if cur else None
            new_diff = cur_diff if user_difficulty == "__keep__" else user_difficulty
            new_notes = cur_notes if notes == "__keep__" else notes
            if new_diff is None and not (new_notes or "").strip():
                self.conn.execute("DELETE FROM song_user_meta WHERE filename = ?", (filename,))
            else:
                self.conn.execute(
                    "INSERT INTO song_user_meta (filename, user_difficulty, notes, updated_at) "
                    "VALUES (?, ?, ?, datetime('now')) "
                    "ON CONFLICT(filename) DO UPDATE SET "
                    "user_difficulty = excluded.user_difficulty, "
                    "notes = excluded.notes, updated_at = excluded.updated_at",
                    (filename, new_diff, (new_notes or None)))
            self.conn.commit()
        return self.get_song_user_meta(filename)

    def set_song_tags(self, filename: str, tags) -> list:
        """Replace ALL of a song's tags with the given set (each normalized;
        blanks + case-dupes dropped). Full-replace so the whole personal-meta
        blob edits as a unit. Returns the stored tag list (sorted, like reads)."""
        norm: list = []
        seen: set = set()
        for t in (tags or []):
            nt = _normalize_tag(t)
            if nt and nt not in seen:
                seen.add(nt)
                norm.append(nt)
        # Bound the number of tags so one PUT can't write unbounded rows.
        # Per-tag length is already capped in _normalize_tag; cap the count too.
        norm = norm[:50]
        with self._lock:
            self.conn.execute("DELETE FROM song_tags WHERE filename = ?", (filename,))
            if norm:
                self.conn.executemany(
                    "INSERT OR IGNORE INTO song_tags (filename, tag, created_at) "
                    "VALUES (?, ?, datetime('now'))",
                    [(filename, t) for t in norm])
            self.conn.commit()
        return self.get_song_user_meta(filename)["tags"]

    def all_tags(self) -> list:
        """[{tag, count}] over songs that still exist, most-used first — powers
        the tag filter UI. Excludes tags whose only songs were deleted."""
        rows = self.conn.execute(
            "SELECT tag, COUNT(*) c FROM song_tags "
            "WHERE filename IN (SELECT filename FROM songs) "
            "GROUP BY tag ORDER BY c DESC, tag COLLATE NOCASE").fetchall()
        return [{"tag": r[0], "count": r[1]} for r in rows]

    def user_meta_map(self, filenames) -> dict:
        """Batch {filename: user_difficulty} for a page of rows (set values
        only). Lets query_page embed difficulty without an N+1."""
        fns = list(filenames)
        if not fns:
            return {}
        ph = ",".join("?" * len(fns))
        rows = self.conn.execute(
            f"SELECT filename, user_difficulty FROM song_user_meta "
            f"WHERE filename IN ({ph}) AND user_difficulty IS NOT NULL", fns).fetchall()
        return {r[0]: r[1] for r in rows}

    def tags_map(self, filenames) -> dict:
        """Batch {filename: [tags]} for a page of rows."""
        fns = list(filenames)
        if not fns:
            return {}
        ph = ",".join("?" * len(fns))
        rows = self.conn.execute(
            f"SELECT filename, tag FROM song_tags WHERE filename IN ({ph}) "
            f"ORDER BY tag COLLATE NOCASE", fns).fetchall()
        out: dict = {}
        for fn, tag in rows:
            out.setdefault(fn, []).append(tag)
        return out

    def purge_song_user_data(self, filename: str) -> None:
        """Drop all personal rows for a deleted song. Called by delete_song
        INSIDE the caller's `meta_db._lock` — must not re-acquire the lock."""
        self.conn.execute("DELETE FROM song_user_meta WHERE filename = ?", (filename,))
        self.conn.execute("DELETE FROM song_tags WHERE filename = ?", (filename,))

    def batch_user_meta(self, filenames, *, set_difficulty="__keep__",
                        add_tags=None, remove_tags=None) -> int:
        """Apply personal-meta edits across MANY songs in one transaction —
        the bulk-edit primitive behind the batch bar. Additive by design so a
        bulk action never silently clobbers per-song data the user can't see:

        - `set_difficulty`: an int 1–5 sets it on every song; `None` clears it
          on every song; the `__keep__` sentinel leaves each song's own value
          untouched (mixed-state "leave unchanged"). Notes are preserved; a row
          that ends up difficulty-less AND notes-less is dropped (no empty shell,
          matching set_song_user_meta).
        - `add_tags` / `remove_tags`: tag sets ADDED to / REMOVED from each song
          (never a full-replace — bulk must not wipe a song's other tags). A tag
          in both add and remove resolves to add (explicit set wins).

        Returns the count of songs touched. Caller normalizes tags is NOT
        assumed — we normalize here so the endpoint and the DB agree."""
        add = []
        seen: set = set()
        for t in (add_tags or []):
            nt = _normalize_tag(t)
            if nt and nt not in seen:
                seen.add(nt)
                add.append(nt)
        rem = {nt for nt in (_normalize_tag(t) for t in (remove_tags or [])) if nt}
        rem -= set(add)  # add wins a conflict
        fns = list(dict.fromkeys(filenames or []))  # dedupe, keep order
        if not fns:
            return 0
        with self._lock:
            for fn in fns:
                if set_difficulty != "__keep__":
                    cur = self.conn.execute(
                        "SELECT notes FROM song_user_meta WHERE filename = ?",
                        (fn,)).fetchone()
                    cur_notes = cur[0] if cur else None
                    if set_difficulty is None and not (cur_notes or "").strip():
                        self.conn.execute(
                            "DELETE FROM song_user_meta WHERE filename = ?", (fn,))
                    else:
                        self.conn.execute(
                            "INSERT INTO song_user_meta (filename, user_difficulty, notes, updated_at) "
                            "VALUES (?, ?, ?, datetime('now')) "
                            "ON CONFLICT(filename) DO UPDATE SET "
                            "user_difficulty = excluded.user_difficulty, "
                            "updated_at = excluded.updated_at",
                            (fn, set_difficulty, cur_notes))
                if rem:
                    ph = ",".join("?" * len(rem))
                    self.conn.execute(
                        f"DELETE FROM song_tags WHERE filename = ? AND tag IN ({ph})",
                        [fn, *rem])
                if add:
                    self.conn.executemany(
                        "INSERT OR IGNORE INTO song_tags (filename, tag, created_at) "
                        "VALUES (?, ?, datetime('now'))",
                        [(fn, t) for t in add])
            self.conn.commit()
        return len(fns)

    # ── Player profile (fee[dB]ack v0.3.0) ─────────────────────────────────
    def get_profile(self) -> dict:
        row = self.conn.execute(
            "SELECT display_name, avatar_path, player_hash, onboarded FROM profile WHERE id = 1"
        ).fetchone()
        if not row:
            return {"display_name": None, "avatar_url": None, "player_hash": None, "onboarded": False}
        return {
            "display_name": row[0],
            "avatar_url": row[1],
            "player_hash": row[2],
            "onboarded": bool(row[3]),
        }

    def set_profile(self, display_name: str, avatar_url: str | None) -> dict:
        """Set/update the display name (+ avatar). Computes player_hash ONCE
        from the first name + a stored random salt; it stays stable across
        later name changes. Marks onboarded=1."""
        with self._lock:
            cur = self.conn.execute(
                "SELECT player_hash, player_salt FROM profile WHERE id = 1"
            ).fetchone()
            player_hash = cur[0] if cur else None
            salt = cur[1] if cur else None
            if not player_hash:
                salt = secrets.token_hex(16)
                player_hash = hashlib.sha256((display_name + salt).encode("utf-8")).hexdigest()
            self.conn.execute(
                "UPDATE profile SET display_name = ?, "
                "avatar_path = COALESCE(?, avatar_path), "
                "player_hash = ?, player_salt = ?, onboarded = 1 WHERE id = 1",
                (display_name, avatar_url, player_hash, salt),
            )
            self.conn.commit()
        return self.get_profile()

    # ── Unified XP store ────────────────────────────────────────────────────
    def get_xp(self) -> int:
        row = self.conn.execute("SELECT xp FROM xp_profile WHERE id = 1").fetchone()
        return int(row[0]) if row else 0

    def award_xp(self, amount: int, source: str | None = None) -> int:
        """Add XP to the unified store; returns the new total. `amount` may be
        NEGATIVE — used internally to REVERSE a failed award (the total and the
        per-source bucket both clamp at 0). `source` (when given) is tracked in
        the xp_sources ledger so it can be reset independently.

        Service boundary: the plugin hook (context["award_xp"]) passes this
        straight through, so coerce defensively — bad input (bool, NaN/Inf,
        non-integral, out-of-int64-range) must neither raise NOR mutate state.
        _as_int rejects bool/non-integral; bad → no-op (0)."""
        try:
            amount = _as_int(amount)
        except (TypeError, ValueError, OverflowError):
            amount = 0
        amount = max(-10_000_000, min(amount, 10_000_000))
        with self._lock:
            # MAX(0, …) clamps the result so a reversal can't drive XP negative.
            self.conn.execute(
                "UPDATE xp_profile SET xp = MAX(0, xp + ?), "
                "total_awards = total_awards + ?, updated_at = datetime('now') WHERE id = 1",
                (amount, 1 if amount > 0 else 0),
            )
            if source:
                self.conn.execute(
                    "INSERT INTO xp_sources (source, xp) VALUES (?, MAX(0, ?)) "
                    "ON CONFLICT(source) DO UPDATE SET xp = MAX(0, xp + ?)",
                    (source, amount, amount),
                )
            self.conn.commit()
            row = self.conn.execute("SELECT xp FROM xp_profile WHERE id = 1").fetchone()
        return int(row[0]) if row else 0

    def reset_source_xp(self, source: str) -> dict:
        """Subtract a single source's tracked contribution from the unified
        total and zero its bucket (e.g. a minigames profile-reset removes only
        minigames XP, leaving song-play/tutorials XP intact). Returns progress."""
        with self._lock:
            row = self.conn.execute("SELECT xp FROM xp_sources WHERE source = ?", (source,)).fetchone()
            amt = int(row[0]) if row and row[0] else 0
            if amt:
                self.conn.execute(
                    "UPDATE xp_profile SET xp = MAX(0, xp - ?), updated_at = datetime('now') WHERE id = 1",
                    (amt,),
                )
            self.conn.execute("UPDATE xp_sources SET xp = 0 WHERE source = ?", (source,))
            self.conn.commit()
        return self.get_progress()

    def seed_xp_once(self, amount: int, marker: str = "minigames") -> bool:
        """One-time seed of the unified store from a pre-unification source
        (e.g. the minigames plugin's profile.json), so existing earned XP is
        preserved. No-ops if already seeded or the store already has XP.
        Returns True if it seeded."""
        # Same no-raise / no-silent-mutate contract as award_xp(): this is a
        # plugin-facing service (context["seed_xp"]). _as_int rejects bool /
        # non-integral; bad input becomes a 0 (no-op) seed rather than raising.
        try:
            amount = _as_int(amount)
        except (TypeError, ValueError, OverflowError):
            amount = 0
        amount = max(0, min(amount, 10_000_000))
        if marker != "minigames":
            return False
        with self._lock:
            row = self.conn.execute(
                "SELECT xp, minigames_seeded FROM xp_profile WHERE id = 1"
            ).fetchone()
            xp_now, seeded = (row[0], row[1]) if row else (0, 0)
            if seeded or xp_now > 0 or amount <= 0:
                if not seeded:
                    self.conn.execute("UPDATE xp_profile SET minigames_seeded = 1 WHERE id = 1")
                    self.conn.commit()
                return False
            self.conn.execute(
                "UPDATE xp_profile SET xp = ?, minigames_seeded = 1, updated_at = datetime('now') WHERE id = 1",
                (amount,),
            )
            # Record the seeded amount in the source ledger too, so a later
            # minigames reset subtracts the migrated XP rather than orphaning it.
            self.conn.execute(
                "INSERT INTO xp_sources (source, xp) VALUES (?, ?) "
                "ON CONFLICT(source) DO UPDATE SET xp = xp + ?",
                (marker, amount, amount),
            )
            self.conn.commit()
        return True

    # ── Streak ──────────────────────────────────────────────────────────────
    def record_active_day(self, today: str) -> dict:
        """Mark `today` (YYYY-MM-DD, local) as an active day. Any session on a
        calendar day keeps the streak: yesterday→+1, today→unchanged, gap or
        first-ever→reset to 1. Updates best_streak."""
        from datetime import date, timedelta
        with self._lock:
            row = self.conn.execute(
                "SELECT current_streak, best_streak, last_active_date FROM profile_progress WHERE id = 1"
            ).fetchone()
            cur, best, last = (row[0], row[1], row[2]) if row else (0, 0, None)
            if last != today:
                try:
                    yesterday = (date.fromisoformat(today) - timedelta(days=1)).isoformat()
                except ValueError:
                    yesterday = None
                cur = cur + 1 if (last and last == yesterday) else 1
                best = max(best or 0, cur)
                self.conn.execute(
                    "UPDATE profile_progress SET current_streak = ?, best_streak = ?, last_active_date = ? WHERE id = 1",
                    (cur, best, today),
                )
                self.conn.commit()
                last = today
        return {"current_streak": cur, "best_streak": best, "last_active_date": last}

    def get_progress(self) -> dict:
        """The full profile-badge payload: XP/level (lib/xp) + streak."""
        from xp import progress as _xp_progress
        p = self.conn.execute(
            "SELECT current_streak, best_streak, last_active_date FROM profile_progress WHERE id = 1"
        ).fetchone()
        cur, best, last = (p[0], p[1], p[2]) if p else (0, 0, None)
        out = _xp_progress(self.get_xp())
        out.update({"current_streak": cur, "best_streak": best, "last_active_date": last})
        return out

    # ── Progression (spec 010): paths, challenges, quests, wallet, shop ────
    # Lock discipline: self._lock is NOT reentrant and award_xp() takes it, so
    # record_progression_event() applies state inside the lock but awards quest
    # dB (and re-enters for quest_completed goals) only after releasing it.

    def get_progression_state(self) -> dict:
        row = self.conn.execute(
            "SELECT calibration_status, calibration_completed_at FROM progression_state WHERE id = 1"
        ).fetchone()
        status = row[0] if row else "pending"
        return {"calibration_status": status, "calibration_completed_at": row[1] if row else None}

    def skip_calibration(self) -> dict:
        """pending → skipped (no-op once completed/skipped). Either way the
        player holds onboarding rank 1 afterwards."""
        with self._lock:
            self.conn.execute(
                "UPDATE progression_state SET calibration_status = 'skipped' "
                "WHERE id = 1 AND calibration_status = 'pending'"
            )
            self.conn.commit()
        return self.get_progression_state()

    def get_player_paths(self) -> dict:
        """{path_id: level} for every selected path."""
        rows = self.conn.execute("SELECT path_id, level FROM player_paths").fetchall()
        return {r[0]: int(r[1]) for r in rows}

    def add_player_paths(self, path_ids) -> dict:
        """Select paths (idempotent; re-adding never resets a level)."""
        with self._lock:
            for pid in path_ids:
                self.conn.execute(
                    "INSERT OR IGNORE INTO player_paths (path_id, level, selected_at) "
                    "VALUES (?, 0, datetime('now'))",
                    (pid,),
                )
            self.conn.commit()
        return self.get_player_paths()

    def get_challenge_state(self) -> dict:
        """{challenge_id: {count, completed, detail}} for every touched challenge."""
        rows = self.conn.execute(
            "SELECT challenge_id, count, progress_detail, completed_at FROM challenge_progress"
        ).fetchall()
        out = {}
        for cid, count, detail, completed_at in rows:
            try:
                parsed = json.loads(detail) if detail else None
            except (ValueError, TypeError):
                parsed = None
            out[cid] = {
                "count": int(count or 0),
                "completed": completed_at is not None,
                "completed_at": completed_at,
                "detail": parsed,
            }
        return out

    def ensure_quest_period(self, content, now) -> None:
        """Lazily instantiate the current daily/weekly quest rows (deterministic
        per period key; rewards snapshot so live quests survive content edits)."""
        import progression as progression_mod
        keys = progression_mod.period_keys(now)
        with self._lock:
            for period_type in ("daily", "weekly"):
                cfg = (content.get("quests") or {}).get(period_type) or {}
                pool = cfg.get("pool") or {}
                count = int(cfg.get("count") or 0)
                if not pool or count < 1:
                    continue
                key = keys[period_type]
                exists = self.conn.execute(
                    "SELECT 1 FROM quest_state WHERE period_type = ? AND period_key = ? LIMIT 1",
                    (period_type, key),
                ).fetchone()
                if exists:
                    continue
                for qid in progression_mod.select_quests(pool.keys(), period_type, key, count):
                    self.conn.execute(
                        "INSERT OR IGNORE INTO quest_state "
                        "(period_type, period_key, quest_id, reward_db) VALUES (?, ?, ?, ?)",
                        (period_type, key, qid, int(pool[qid].get("reward_db") or 0)),
                    )
            self.conn.commit()

    def get_quest_rows(self, period_keys_map: dict) -> list:
        """Current-period quest instances as snapshot/API rows."""
        out = []
        for period_type, key in period_keys_map.items():
            rows = self.conn.execute(
                "SELECT quest_id, count, reward_db, progress_detail, completed_at "
                "FROM quest_state WHERE period_type = ? AND period_key = ? ORDER BY quest_id",
                (period_type, key),
            ).fetchall()
            for qid, count, reward, detail, completed_at in rows:
                try:
                    parsed = json.loads(detail) if detail else None
                except (ValueError, TypeError):
                    parsed = None
                out.append({
                    "period_type": period_type,
                    "period_key": key,
                    "quest_id": qid,
                    "count": int(count or 0),
                    "reward_db": int(reward or 0),
                    "detail": parsed,
                    "completed": completed_at is not None,
                    "completed_at": completed_at,
                })
        return out

    def get_wallet(self) -> dict:
        """{balance, lifetime_db, spent} — see the wallet table comment for
        why spend never mutates xp_profile.xp."""
        import progression as progression_mod
        row = self.conn.execute("SELECT spent FROM wallet WHERE id = 1").fetchone()
        spent = int(row[0]) if row and row[0] else 0
        lifetime = self.get_xp()
        return {
            "balance": progression_mod.wallet_balance(lifetime, spent),
            "lifetime_db": lifetime,
            "spent": spent,
        }

    def buy_shop_item(self, item: dict) -> tuple:
        """Atomic purchase: balance check + spend + ownership in one
        transaction. Returns ("ok"|"owned"|"insufficient", wallet)."""
        with self._lock:
            owned = self.conn.execute(
                "SELECT 1 FROM shop_owned WHERE item_id = ?", (item["id"],)
            ).fetchone()
            if owned:
                status = "owned"
            else:
                xp_row = self.conn.execute("SELECT xp FROM xp_profile WHERE id = 1").fetchone()
                spent_row = self.conn.execute("SELECT spent FROM wallet WHERE id = 1").fetchone()
                balance = max(0, int(xp_row[0] if xp_row else 0) - int(spent_row[0] if spent_row else 0))
                cost = int(item.get("cost") or 0)
                if cost < 0:
                    status = "invalid"
                elif balance < cost:
                    status = "insufficient"
                else:
                    self.conn.execute(
                        "UPDATE wallet SET spent = spent + ? WHERE id = 1", (cost,)
                    )
                    self.conn.execute(
                        "INSERT INTO shop_owned (item_id, cost_paid, acquired_at) "
                        "VALUES (?, ?, datetime('now'))",
                        (item["id"], cost),
                    )
                    self.conn.commit()
                    status = "ok"
        return status, self.get_wallet()

    def get_owned_items(self) -> dict:
        rows = self.conn.execute(
            "SELECT item_id, cost_paid, acquired_at FROM shop_owned"
        ).fetchall()
        return {r[0]: {"cost_paid": int(r[1] or 0), "acquired_at": r[2]} for r in rows}

    def get_equipped(self) -> dict:
        rows = self.conn.execute("SELECT slot, item_id FROM shop_equipped").fetchall()
        return {r[0]: r[1] for r in rows if r[1]}

    def equip_item(self, slot: str, item_id) -> dict:
        """Equip an owned item into a slot (item_id=None unequips)."""
        with self._lock:
            if item_id is None:
                self.conn.execute("DELETE FROM shop_equipped WHERE slot = ?", (slot,))
            else:
                self.conn.execute(
                    "INSERT INTO shop_equipped (slot, item_id) VALUES (?, ?) "
                    "ON CONFLICT(slot) DO UPDATE SET item_id = excluded.item_id",
                    (slot, item_id),
                )
            self.conn.commit()
        return self.get_equipped()

    def progression_snapshot(self, content, now) -> dict:
        """The plain-dict state view lib/progression.evaluate_event reads."""
        import progression as progression_mod
        keys = progression_mod.period_keys(now)
        streak_row = self.conn.execute(
            "SELECT current_streak FROM profile_progress WHERE id = 1"
        ).fetchone()
        return {
            "calibration_status": self.get_progression_state()["calibration_status"],
            "paths": self.get_player_paths(),
            "challenges": self.get_challenge_state(),
            "quests": self.get_quest_rows(keys),
            "streak": int(streak_row[0]) if streak_row and streak_row[0] else 0,
            "xp_total": self.get_xp(),
        }

    def record_progression_event(self, event_type: str, payload, content,
                                 now=None, _depth: int = 0) -> dict:
        """The single progression choke point: evaluate one event, persist the
        deltas, award quest dB, and re-enter once for quest_completed goals.
        Returns a toast-ready summary."""
        import progression as progression_mod
        from datetime import datetime as _dt
        now = now or _dt.now()
        self.ensure_quest_period(content, now)
        snapshot = self.progression_snapshot(content, now)
        outcome = progression_mod.evaluate_event(
            {"type": event_type, "payload": payload or {}}, content, snapshot
        )
        keys = progression_mod.period_keys(now)
        challenge_index = content.get("challenge_index") or {}
        quest_pools = content.get("quests") or {}

        summary = {
            "challenges_completed": [],
            "quests_completed": [],
            "level_ups": list(outcome["level_ups"]),
            "calibration_completed": bool(outcome["calibration_completed"]),
        }
        with self._lock:
            for ch in outcome["challenges"]:
                detail = json.dumps(ch["detail"]) if ch.get("detail") else None
                self.conn.execute(
                    "INSERT INTO challenge_progress "
                    "(challenge_id, path_id, level, count, progress_detail, completed_at) "
                    "VALUES (?, ?, ?, ?, ?, CASE WHEN ? THEN datetime('now') END) "
                    "ON CONFLICT(challenge_id) DO UPDATE SET "
                    "count = excluded.count, progress_detail = excluded.progress_detail, "
                    "completed_at = COALESCE(challenge_progress.completed_at, excluded.completed_at)",
                    (ch["challenge_id"], ch["path_id"], ch["level"], ch["count"],
                     detail, 1 if ch["completed"] else 0),
                )
                if ch["completed"]:
                    info = challenge_index.get(ch["challenge_id"]) or {}
                    title = (info.get("challenge") or {}).get("title") or ch["challenge_id"]
                    summary["challenges_completed"].append(
                        {"id": ch["challenge_id"], "title": title, "path_id": ch["path_id"]}
                    )
            for lu in outcome["level_ups"]:
                # Guard on the old level so a stale evaluation can't double-bump.
                self.conn.execute(
                    "UPDATE player_paths SET level = ? WHERE path_id = ? AND level = ?",
                    (lu["new_level"], lu["path_id"], lu["new_level"] - 1),
                )
            # Only quests whose row actually TRANSITIONED to completed in this
            # call get rewarded/re-entered. The pure outcome was computed from
            # a pre-lock snapshot, so a concurrent event may have completed the
            # same quest first — its guarded UPDATE (completed_at IS NULL)
            # then touches 0 rows here, and paying it again would double-award
            # Decibels and double-advance quest_completed challenges.
            newly_completed_quests = []
            for q in outcome["quests"]:
                detail = json.dumps(q["detail"]) if q.get("detail") else None
                cur = self.conn.execute(
                    "UPDATE quest_state SET count = ?, progress_detail = ?, "
                    "completed_at = COALESCE(completed_at, CASE WHEN ? THEN datetime('now') END) "
                    "WHERE period_type = ? AND period_key = ? AND quest_id = ? AND completed_at IS NULL",
                    (q["count"], detail, 1 if q["completed"] else 0,
                     q["period_type"], keys.get(q["period_type"], ""), q["quest_id"]),
                )
                if q["completed"] and cur.rowcount > 0:
                    newly_completed_quests.append(q)
            if outcome["calibration_completed"]:
                self.conn.execute(
                    "UPDATE progression_state SET calibration_status = 'completed', "
                    "calibration_completed_at = datetime('now') "
                    "WHERE id = 1 AND calibration_status != 'completed'"
                )
            self.conn.commit()

        # Quest awards + bounded re-entry, outside the lock (award_xp locks).
        for q in newly_completed_quests:
            pool = (quest_pools.get(q["period_type"]) or {}).get("pool") or {}
            qdef = pool.get(q["quest_id"]) or {}
            summary["quests_completed"].append({
                "id": q["quest_id"],
                "title": qdef.get("title") or q["quest_id"],
                "period_type": q["period_type"],
                "reward_db": q["reward_db"],
            })
            if q["reward_db"]:
                self.award_xp(q["reward_db"], "quests")
            if _depth < 1:
                sub = self.record_progression_event(
                    "quest_completed",
                    {"period_type": q["period_type"], "quest_id": q["quest_id"]},
                    content, now=now, _depth=_depth + 1,
                )
                summary["challenges_completed"].extend(sub["challenges_completed"])
                summary["quests_completed"].extend(sub["quests_completed"])
                summary["level_ups"].extend(sub["level_ups"])

        summary["mastery_rank"] = progression_mod.mastery_rank(
            self.get_progression_state()["calibration_status"], self.get_player_paths()
        )
        return summary

    # ── Per-song practice stats ───────────────────────────────────────────---
    _STATS_COLS = (
        "filename", "arrangement", "plays", "best_score", "best_accuracy",
        "last_score", "last_accuracy", "last_position", "last_played_at", "updated_at",
    )

    def _stats_row(self, filename: str, arrangement: int) -> dict | None:
        r = self.conn.execute(
            "SELECT " + ", ".join(self._STATS_COLS) +
            " FROM song_stats WHERE filename = ? AND arrangement = ?",
            (filename, int(arrangement)),
        ).fetchone()
        return dict(zip(self._STATS_COLS, r)) if r else None

    # Constant SQL fragment restricting stats reads to songs that still exist.
    # Unconditional: a genuinely empty (but scanned) library must still hide
    # stale stats/playlist ghosts. We rely on `songs` NEVER being transiently
    # empty mid-scan — /api/rescan/full bumps mtime to force a full re-scan
    # rather than DELETEing rows — so the only times `songs` is empty are a
    # fresh install (no stats anyway) or a truly empty library (ghosts should be
    # hidden). Race-free orphan handling: dead-song stats are hidden here, never
    # deleted on scan (see delete_missing).
    _EXISTING_SONG_FILTER = " AND filename IN (SELECT filename FROM songs) "

    def _existing_song_filter(self) -> str:
        return self._EXISTING_SONG_FILTER

    # ── Artist-name canonicalization (P4) ─────────────────────────────────────
    # "Apply at display": resolve songs.artist through the artist_alias override
    # for the deduped dropdown/tree (query_artists) — else keep the raw name. The
    # correlated PK-lookup subquery is fine for the offset-paged catalog; the grid
    # FILTER instead expands a canonical name to its raw variants (index-friendly,
    # keyset-safe), and the grid DISPLAY re-labels rows in Python via alias_map().
    _EFFECTIVE_ARTIST_SQL = (
        "COALESCE((SELECT aa.canonical_name FROM artist_alias aa "
        "WHERE aa.raw_name = songs.artist COLLATE NOCASE), songs.artist)"
    )

    def alias_map(self) -> dict:
        """{raw_name_lower: canonical_name} for every alias — one read to re-label
        a page of grid rows without an N+1. Lowercased keys so the lookup matches
        the raw artist case-insensitively (the table is COLLATE NOCASE)."""
        return {r[0].lower(): r[1] for r in self.conn.execute(
            "SELECT raw_name, canonical_name FROM artist_alias").fetchall()}

    def effective_artist(self, raw: str, amap: dict | None = None) -> str:
        """Canonical display name for a raw artist (alias override else itself)."""
        if raw is None:
            return raw
        amap = self.alias_map() if amap is None else amap
        return amap.get(raw.lower(), raw)

    def _single_hop_canonical(self, name: str) -> str | None:
        """The stored canonical for a raw name (a SINGLE hop), or None if `name`
        is not itself an alias key. Case-insensitive (the table is COLLATE NOCASE)
        — the shared primitive the chain-flatteners reuse."""
        if not name:
            return None
        row = self.conn.execute(
            "SELECT canonical_name FROM artist_alias WHERE raw_name = ? COLLATE NOCASE",
            (name,)).fetchone()
        return row[0] if row else None

    def _terminal_canonical(self, name: str) -> str:
        """Follow the alias chain from `name` to its TERMINAL canonical — the first
        name that is not itself an alias key — so transitive chains (raw → mid →
        … → terminal) collapse to one hop. A visited-set breaks cycles: if we come
        back to a name already seen we return the last name reached rather than
        looping. Reuses the single-hop primitive."""
        seen: set = set()
        cur = name
        while True:
            key = (cur or "").lower()
            if key in seen:
                return cur           # cycle — stop, return where we are
            seen.add(key)
            nxt = self._single_hop_canonical(cur)
            if nxt is None or (nxt or "").lower() == key:
                return cur           # not an alias key (or self) → terminal
            cur = nxt

    def _raw_variants_for(self, canonical: str) -> list:
        """Every raw artist string that should match a filter on `canonical`: the
        canonical name itself plus all raw names aliased to it (case-insensitive).
        Lets the artist filter be `artist IN (...)` — uses the artist index and is
        keyset-safe, instead of a per-row COALESCE subquery."""
        rows = self.conn.execute(
            "SELECT raw_name FROM artist_alias WHERE canonical_name = ? COLLATE NOCASE",
            (canonical,)).fetchall()
        seen, out = set(), []
        for name in [canonical, *[r[0] for r in rows]]:
            k = (name or "").lower()
            if name and k not in seen:
                seen.add(k)
                out.append(name)
        return out

    def list_artist_aliases(self) -> list:
        """All alias rows (raw → canonical), canonical then raw, for the Tidy-up
        'current merges' list."""
        rows = self.conn.execute(
            "SELECT raw_name, canonical_name, mb_artist_id FROM artist_alias "
            "ORDER BY canonical_name COLLATE NOCASE, raw_name COLLATE NOCASE").fetchall()
        return [{"raw_name": r[0], "canonical_name": r[1], "mb_artist_id": r[2]} for r in rows]

    def _set_artist_alias_locked(self, raw_name: str, canonical_name: str,
                                 mb_artist_id: str | None = None) -> dict:
        """Core upsert — assumes self._lock is HELD and does NOT commit (so the
        single set and the batch merge can share one transaction). Flattens chains
        and guards cycles:

        * A self-alias (raw == canonical) DROPs any existing row (the UI un-merge).
        * Otherwise `canonical` is resolved to its TERMINAL canonical, so setting a
          new hop onto an existing chain collapses to one hop rather than growing a
          two-hop chain that grouping/filtering would then split.
        * Cycle guard: if that terminal IS `raw`, storing would loop the chain back
          on itself — we no-op and report it so the caller can surface a failure.
        * Forward-flatten: any existing rows whose canonical == `raw` are re-pointed
          to the new terminal, so previously-merged variants follow `raw` onward.

        Returns a result dict {ok, raw_name, canonical_name, ...}."""
        raw = (raw_name or "").strip()
        canon = (canonical_name or "").strip()
        if not raw or not canon:
            raise ValueError("raw_name and canonical_name are required")
        if raw.lower() == canon.lower():
            self.conn.execute("DELETE FROM artist_alias WHERE raw_name = ? COLLATE NOCASE", (raw,))
            return {"ok": True, "raw_name": raw, "canonical_name": raw, "unmerged": True}
        terminal = self._terminal_canonical(canon)
        if (terminal or "").lower() == raw.lower():
            # raw → … → raw would be a cycle; refuse rather than corrupt the chain.
            return {"ok": False, "reason": "cycle", "raw_name": raw,
                    "canonical_name": canon, "terminal": terminal}
        self.conn.execute(
            "INSERT INTO artist_alias (raw_name, canonical_name, mb_artist_id, updated_at) "
            "VALUES (?, ?, ?, datetime('now')) "
            "ON CONFLICT(raw_name) DO UPDATE SET "
            "canonical_name = excluded.canonical_name, "
            "mb_artist_id = excluded.mb_artist_id, updated_at = excluded.updated_at",
            (raw, terminal, mb_artist_id))
        # Re-point any variants that were previously merged INTO raw onto the new
        # terminal (raw itself now aliases onward, so it can't stay a canonical).
        self.conn.execute(
            "UPDATE artist_alias SET canonical_name = ?, updated_at = datetime('now') "
            "WHERE canonical_name = ? COLLATE NOCASE AND raw_name != ? COLLATE NOCASE",
            (terminal, raw, terminal))
        return {"ok": True, "raw_name": raw, "canonical_name": terminal}

    def set_artist_alias(self, raw_name: str, canonical_name: str,
                         mb_artist_id: str | None = None) -> dict:
        """Upsert one raw→canonical override (chain-flattened, cycle-guarded — see
        _set_artist_alias_locked). Returns the result dict."""
        with self._lock:
            result = self._set_artist_alias_locked(raw_name, canonical_name, mb_artist_id)
            self.conn.commit()
        return result

    def remove_artist_alias(self, raw_name: str) -> None:
        with self._lock:
            self.conn.execute("DELETE FROM artist_alias WHERE raw_name = ? COLLATE NOCASE", (raw_name,))
            self.conn.commit()

    def merge_artists(self, raw_names, canonical_name: str) -> int:
        """Point several raw artist names at one canonical (the Tidy-up merge).
        Skips the canonical's own self-alias. Returns the count of aliases written.
        ATOMIC: the whole batch runs under one lock and one commit, so a mid-batch
        cycle rejection can't leave a half-applied merge."""
        canon = (canonical_name or "").strip()
        if not canon:
            raise ValueError("canonical_name is required")
        n = 0
        with self._lock:
            for raw in (raw_names or []):
                r = (raw or "").strip()
                if r and r.lower() != canon.lower():
                    result = self._set_artist_alias_locked(r, canon)
                    if result.get("ok"):
                        n += 1
            self.conn.commit()
        return n

    def raw_artists(self, limit: int = 2000) -> list:
        """Distinct RAW artist names in the library with song counts + their
        current canonical (for the Tidy-up picker — you merge raw variants). Raw,
        not effective, so both 'ACDC' and 'AC/DC' show as separate mergeable rows."""
        limit = max(1, min(10000, int(limit)))
        amap = self.alias_map()
        rows = self.conn.execute(
            "SELECT artist, COUNT(*) c FROM songs WHERE artist IS NOT NULL AND artist != '' "
            "GROUP BY artist COLLATE NOCASE ORDER BY c DESC, artist COLLATE NOCASE LIMIT ?",
            (limit,)).fetchall()
        return [{"name": r[0], "count": r[1],
                 "canonical": amap.get((r[0] or "").lower(), r[0])} for r in rows]

    def record_session(self, filename: str, arrangement: int, *, score: int,
                       accuracy: float, last_position=None) -> dict:
        """Record a scored play: plays += 1, best_* = max, last_* = new."""
        from song_score import merge_stats
        with self._lock:
            existing = self._stats_row(filename, int(arrangement))
            merged = merge_stats(existing, {
                "score": score, "accuracy": accuracy, "last_position": last_position,
            })
            self.conn.execute(
                """INSERT INTO song_stats
                       (filename, arrangement, plays, best_score, best_accuracy,
                        last_score, last_accuracy, last_position, last_played_at, updated_at)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?,
                           strftime('%Y-%m-%d %H:%M:%f','now'), strftime('%Y-%m-%d %H:%M:%f','now'))
                   ON CONFLICT(filename, arrangement) DO UPDATE SET
                       plays = excluded.plays,
                       best_score = excluded.best_score,
                       best_accuracy = excluded.best_accuracy,
                       last_score = excluded.last_score,
                       last_accuracy = excluded.last_accuracy,
                       last_position = excluded.last_position,
                       last_played_at = excluded.last_played_at,
                       updated_at = excluded.updated_at""",
                (filename, int(arrangement), merged["plays"], merged["best_score"],
                 merged["best_accuracy"], merged["last_score"], merged["last_accuracy"],
                 merged["last_position"]),
            )
            self.conn.commit()
        return self._stats_row(filename, int(arrangement))

    def touch_position(self, filename: str, arrangement: int, last_position: float) -> dict:
        """Persist just the resume position (no plays/score change), so
        Continue-Playing works for non-scored plays. Also stamps
        last_played_at — both /api/stats/recent and /api/session/continue
        filter/order on it, so a position-only touch must set it or the song
        never surfaces as 'recent' / 'continue playing'."""
        with self._lock:
            self.conn.execute(
                """INSERT INTO song_stats (filename, arrangement, last_position,
                                           last_played_at, updated_at)
                   VALUES (?, ?, ?, strftime('%Y-%m-%d %H:%M:%f','now'),
                           strftime('%Y-%m-%d %H:%M:%f','now'))
                   ON CONFLICT(filename, arrangement) DO UPDATE SET
                       last_position = excluded.last_position,
                       last_played_at = excluded.last_played_at,
                       updated_at = excluded.updated_at""",
                (filename, int(arrangement), float(last_position)),
            )
            self.conn.commit()
        return self._stats_row(filename, int(arrangement))

    def get_song_stats(self, filename: str) -> dict:
        """Best/last/plays across all arrangements of a song, plus per-arrangement rows."""
        rows = self.conn.execute(
            "SELECT " + ", ".join(self._STATS_COLS) +
            " FROM song_stats WHERE filename = ? ORDER BY arrangement",
            (filename,),
        ).fetchall()
        arr = [dict(zip(self._STATS_COLS, r)) for r in rows]
        best_acc = max((a["best_accuracy"] for a in arr), default=0.0)
        best_score = max((a["best_score"] for a in arr), default=0)
        plays = sum(a["plays"] for a in arr)
        return {
            "filename": filename,
            "best_accuracy": best_acc,
            "best_score": best_score,
            "plays": plays,
            "arrangements": arr,
        }

    def recent_stats(self, limit: int = 12) -> list[dict]:
        """Recently-played rows (most recent first) for 'Jump back in'."""
        limit = max(1, min(100, int(limit)))
        rows = self.conn.execute(
            "SELECT " + ", ".join(self._STATS_COLS) +
            " FROM song_stats WHERE last_played_at IS NOT NULL " +
            self._existing_song_filter() +
            "ORDER BY last_played_at DESC LIMIT ?",
            (limit,),
        ).fetchall()
        return [dict(zip(self._STATS_COLS, r)) for r in rows]

    def best_accuracy_map(self) -> dict:
        """{filename: best_accuracy} across all arrangements, for batch-badging
        the library grid in one request. Includes every SCORED song (plays > 0)
        — even a genuine 0% best — but excludes resume-only rows (plays == 0,
        which carry a default best_accuracy of 0 and shouldn't badge)."""
        rows = self.conn.execute(
            "SELECT filename, MAX(best_accuracy), SUM(plays) FROM song_stats "
            "WHERE 1=1 " + self._existing_song_filter() +   # skip dead songs (race-free)
            "GROUP BY filename"
        ).fetchall()
        return {r[0]: r[1] for r in rows if r[2] and r[2] > 0}

    def top_stats(self, limit: int = 5) -> list[dict]:
        """Top scored songs (best score first) for the profile 'Your best
        scores' panel. Aggregated per-song across arrangements (best score,
        best accuracy, total plays), only SCORED songs (plays > 0), dead songs
        skipped. Mirrors best_accuracy_map's grouping; enriched with metadata
        by the /api/stats/top route."""
        limit = max(1, min(50, int(limit)))
        rows = self.conn.execute(
            "SELECT filename, MAX(best_score), MAX(best_accuracy), SUM(plays) "
            "FROM song_stats WHERE 1=1 " + self._existing_song_filter() +   # skip dead songs
            "GROUP BY filename HAVING SUM(plays) > 0 "
            "ORDER BY MAX(best_score) DESC, MAX(best_accuracy) DESC LIMIT ?",
            (limit,),
        ).fetchall()
        return [
            {"filename": r[0], "best_score": r[1], "best_accuracy": r[2], "plays": r[3]}
            for r in rows
        ]

    # ── FUTURE ENHANCEMENT (revisit once the feedpak difficulty spec is locked) ──
    # The library-metadata design (§8) calls for user-difficulty to be
    # PER-ARRANGEMENT ("easy on bass ≠ easy on lead") and SEEDED FROM the authored/
    # derived difficulty so it's never blank. Neither ships here on purpose:
    #   • personal difficulty is currently per-FILENAME (P1's song_user_meta);
    #     per-arrangement is a P1-schema + Details-drawer (P2) re-scope; and
    #   • there is NO authored/derived difficulty field on `songs` yet — that waits
    #     on the feedpak difficulty spec (the #37-family FEP), which is unmerged.
    # So this recommender ships the growth-edge PAYOFF now and degrades gracefully
    # (an unrated song is treated as mid). When the feedpak difficulty field lands,
    # revisit: (1) seed unset user-difficulty from authored instead of assuming mid,
    # and (2) score per (filename, arrangement) rather than per song.
    @staticmethod
    def _growth_edge_score(best_accuracy: float, user_difficulty) -> float:
        """The 'practice next' score = difficulty-appropriateness × proximity to
        mastery. Peaks where a song is BOTH at a productive challenge level (the
        mid difficulty band) AND close to — but not yet at — mastery (the
        goal-gradient push). An UNSET personal difficulty is treated as mid, so
        the recommender still works before anything is rated (it degrades to
        closest-to-mastery-first) — see P3 notes: authored/derived difficulty
        seeding waits on the feedpak difficulty spec.

        diff_weight: 3 → 1.0, 2/4 → 0.8, 1/5 → 0.6 (extremes deprioritized, never
        zeroed — you grow on the challenging middle, not the trivially easy or the
        frustratingly hard). Never writes anything."""
        d = user_difficulty if user_difficulty is not None else 3
        weight = 1.0 - abs(d - 3) * 0.2
        return weight * (best_accuracy or 0.0)

    def growth_edge_suggestions(self, limit: int = 8) -> list[dict]:
        """Attempted-but-not-yet-mastered songs ranked by the growth-edge score —
        the 'Keep practicing' recommender that replaces recency-only ordering.
        Song-level (best accuracy across arrangements, like the badge); the
        suggested `arrangement` is the one you're closest to mastering, so the
        shelf opens the version worth pushing. Read-only."""
        limit = max(1, min(24, int(limit)))
        rows = self.conn.execute(
            "SELECT filename, arrangement, best_accuracy, plays, last_played_at "
            "FROM song_stats WHERE 1=1 " + self._existing_song_filter()
        ).fetchall()
        # Aggregate per song: best accuracy + the arrangement that owns it, total
        # plays, most-recent play (used as a stable tiebreak).
        agg: dict = {}
        for fn, arr, acc, plays, lp in rows:
            a = agg.get(fn)
            if a is None:
                a = agg[fn] = {"acc": None, "arr": 0, "plays": 0, "lp": None}
            a["plays"] += (plays or 0)
            if acc is not None and (a["acc"] is None or acc > a["acc"]):
                a["acc"] = acc
                a["arr"] = arr
            if lp and (not a["lp"] or lp > a["lp"]):
                a["lp"] = lp
        cands = [(fn, a) for fn, a in agg.items()
                 if a["plays"] > 0 and a["acc"] is not None and a["acc"] < MASTERY_ACCURACY]
        if not cands:
            return []
        diffs = self.user_meta_map([fn for fn, _ in cands])   # {filename: 1..5}
        out = []
        for fn, a in cands:
            d = diffs.get(fn)
            out.append({
                "filename": fn,
                "best_accuracy": a["acc"],
                "arrangement": a["arr"],
                "last_played_at": a["lp"],
                "user_difficulty": d,
                "growth_score": round(self._growth_edge_score(a["acc"], d), 6),
            })
        out.sort(key=lambda r: (r["growth_score"], r["last_played_at"] or "", r["filename"]), reverse=True)
        return out[:limit]

    # ── Playlists ─────────────────────────────────────────────────────────--
    SAVED_KEY = "saved_for_later"

    def _playlist_count(self, pid: int) -> int:
        # Count only songs that still exist (mirrors the stats read-filter — dead
        # songs are hidden, not deleted on scan), passing through when the songs
        # table is empty. Single statement → no probe-then-read race.
        return self.conn.execute(
            "SELECT COUNT(*) FROM playlist_songs ps WHERE ps.playlist_id = ? "
            "AND EXISTS (SELECT 1 FROM songs s WHERE s.filename = ps.filename)",
            (pid,),
        ).fetchone()[0]

    def arrangement_count(self, filename: str):
        """Number of arrangements for a song, or None if the song isn't in the
        library (so callers can skip validation when it can't be checked)."""
        row = self.conn.execute("SELECT arrangements FROM songs WHERE filename = ?", (filename,)).fetchone()
        if not row or not row[0]:
            return None
        try:
            arr = json.loads(row[0])
        except (ValueError, TypeError):
            return None
        return len(arr) if isinstance(arr, list) else None

    def arrangement_entry(self, filename: str, index: int):
        """One arrangement's metadata dict for a library song, or None when
        the song/index is unknown (progression then falls back to guitar)."""
        row = self.conn.execute("SELECT arrangements FROM songs WHERE filename = ?", (filename,)).fetchone()
        if not row or not row[0]:
            return None
        try:
            arr = json.loads(row[0])
        except (ValueError, TypeError):
            return None
        if isinstance(arr, list) and 0 <= index < len(arr) and isinstance(arr[index], dict):
            return arr[index]
        return None

    def list_playlists(self) -> list[dict]:
        from urllib.parse import quote
        rows = self.conn.execute(
            "SELECT id, name, system_key, created_at, updated_at, kind FROM playlists "
            "WHERE rules IS NULL "          # smart collections live in the source picker, not here
            "ORDER BY (system_key IS NULL), name COLLATE NOCASE"
        ).fetchall()
        out = []
        for r in rows:
            pid = r[0]
            # First few still-present songs (in order) → art URLs, for a
            # content-dependent playlist cover (single art / 2x2 mosaic). The
            # JOIN drops dead songs, matching get_playlist's visibility.
            arts = self.conn.execute(
                "SELECT ps.filename FROM playlist_songs ps "
                "JOIN songs s ON s.filename = ps.filename "
                "WHERE ps.playlist_id = ? ORDER BY ps.position LIMIT 4",
                (pid,),
            ).fetchall()
            out.append({
                "id": pid, "name": r[1], "system_key": r[2],
                "created_at": r[3], "updated_at": r[4], "kind": r[5],
                "count": self._playlist_count(pid),
                "art_urls": [f"/api/song/{quote(a[0])}/art" for a in arts],
            })
        return out

    def create_playlist(self, name: str, system_key: str | None = None,
                        kind: str | None = None) -> dict:
        with self._lock:
            cur = self.conn.execute(
                "INSERT INTO playlists (name, system_key, kind, created_at, updated_at) "
                "VALUES (?, ?, ?, datetime('now'), datetime('now'))",
                (name, system_key, kind),
            )
            self.conn.commit()
            pid = cur.lastrowid
        return self.get_playlist(pid)

    def saved_playlist_id(self) -> int:
        """Id of the reserved Saved-for-Later playlist, created on first use.
        Tolerates a create race: two concurrent first-use toggles can both see
        no row and try to insert; the unique system_key index makes the loser
        raise IntegrityError, so catch it and re-read the winner's row rather
        than 500."""
        row = self.conn.execute(
            "SELECT id FROM playlists WHERE system_key = ?", (self.SAVED_KEY,)
        ).fetchone()
        if row:
            return row[0]
        try:
            return self.create_playlist("Saved for Later", self.SAVED_KEY)["id"]
        except sqlite3.IntegrityError:
            row = self.conn.execute(
                "SELECT id FROM playlists WHERE system_key = ?", (self.SAVED_KEY,)
            ).fetchone()
            if row:
                return row[0]
            raise

    def rename_playlist(self, pid: int, name: str) -> bool:
        with self._lock:
            cur = self.conn.execute(
                "UPDATE playlists SET name = ?, updated_at = datetime('now') WHERE id = ?",
                (name, pid),
            )
            self.conn.commit()
            return cur.rowcount > 0

    def delete_playlist(self, pid: int) -> bool:
        """Delete a user playlist (system playlists are protected — caller checks)."""
        with self._lock:
            self.conn.execute("DELETE FROM playlist_songs WHERE playlist_id = ?", (pid,))
            cur = self.conn.execute("DELETE FROM playlists WHERE id = ?", (pid,))
            self.conn.commit()
            return cur.rowcount > 0

    # ── Smart collections (feedBack#636 item 2) ───────────────────────────
    @staticmethod
    def _collection_row(r) -> dict:
        rules = {}
        if r[3]:
            try:
                parsed = json.loads(r[3])
                if isinstance(parsed, dict):
                    rules = parsed
            except (ValueError, TypeError):
                rules = {}
        return {"id": r[0], "name": r[1], "system_key": r[2], "rules": rules,
                "created_at": r[4], "updated_at": r[5]}

    def is_collection(self, pid: int) -> bool:
        row = self.conn.execute(
            "SELECT rules IS NOT NULL FROM playlists WHERE id = ?", (pid,)
        ).fetchone()
        return bool(row and row[0])

    def list_collections(self) -> list[dict]:
        rows = self.conn.execute(
            "SELECT id, name, system_key, rules, created_at, updated_at FROM playlists "
            "WHERE rules IS NOT NULL ORDER BY name COLLATE NOCASE"
        ).fetchall()
        return [self._collection_row(r) for r in rows]

    def get_collection(self, pid: int) -> dict | None:
        r = self.conn.execute(
            "SELECT id, name, system_key, rules, created_at, updated_at FROM playlists "
            "WHERE id = ? AND rules IS NOT NULL", (pid,)
        ).fetchone()
        return self._collection_row(r) if r else None

    def create_collection(self, name: str, rules: dict) -> dict:
        with self._lock:
            cur = self.conn.execute(
                "INSERT INTO playlists (name, system_key, rules, created_at, updated_at) "
                "VALUES (?, NULL, ?, datetime('now'), datetime('now'))",
                (name, json.dumps(rules or {})),
            )
            self.conn.commit()
            pid = cur.lastrowid
        return self.get_collection(pid)

    def update_collection(self, pid: int, name: str | None = None,
                          rules: dict | None = None) -> dict | None:
        if not self.is_collection(pid):
            return None
        with self._lock:
            if name is not None:
                self.conn.execute("UPDATE playlists SET name = ? WHERE id = ?", (name, pid))
            if rules is not None:
                self.conn.execute("UPDATE playlists SET rules = ? WHERE id = ?",
                                  (json.dumps(rules or {}), pid))
            self.conn.execute("UPDATE playlists SET updated_at = datetime('now') WHERE id = ?", (pid,))
            self.conn.commit()
        return self.get_collection(pid)

    def get_playlist(self, pid: int) -> dict | None:
        # A path-param int outside SQLite's 64-bit range raises OverflowError at
        # bind time (→ 500). Treat it as a miss; every mutating playlist handler
        # gates on this first, so the guard covers them too.
        if not isinstance(pid, int) or not (-(2**63) <= pid < 2**63):
            return None
        # `rules IS NULL` excludes smart collections (#636 item 2): they share
        # the playlists table but their membership is rules-based, so every
        # manual-playlist mutation (add/remove/reorder/cover) that gates on
        # get_playlist uniformly 404s on a collection id — collections are
        # managed only through /api/collections.
        head = self.conn.execute(
            "SELECT id, name, system_key, created_at, updated_at, kind FROM playlists "
            "WHERE id = ? AND rules IS NULL", (pid,)
        ).fetchone()
        if not head:
            return None
        is_album = head[5] == "album"
        # Mixes hide dead songs (race-free; not deleted on scan). An ALBUM keeps
        # every slot: a slot whose pinned chart was deleted self-heals to the
        # work's current preferred at READ (§7.2 orphan-at-play — never a
        # membership rewrite), and reports `missing` when the whole work is gone
        # so the practice set keeps its denominator visible.
        dead_filter = "" if is_album else "AND s.filename IS NOT NULL"
        rows = self.conn.execute(
            f"""SELECT ps.filename, ps.position, s.title, s.artist, s.tuning_name,
                       ps.arrangement, ps.work_key, s.arrangements,
                       (s.filename IS NULL) AS dead
               FROM playlist_songs ps LEFT JOIN songs s ON s.filename = ps.filename
               WHERE ps.playlist_id = ? {dead_filter}
               ORDER BY ps.position, ps.filename""",
            (pid,),
        ).fetchall()
        from urllib.parse import quote
        songs = []
        for r in rows:
            entry = {
                "filename": r[0], "position": r[1],
                "title": r[2] or r[0], "artist": r[3] or "", "tuning_name": r[4] or "",
                "art_url": f"/api/song/{quote(r[0])}/art",
            }
            if is_album:
                entry["arrangement"] = r[5]
                entry["work_key"] = r[6]
                try:
                    entry["arrangements"] = _ensure_smart_names(json.loads(r[7]) if r[7] else [])
                except Exception:
                    entry["arrangements"] = []
                if r[8]:
                    entry.update(self._resolve_album_orphan(r[6]))
            songs.append(entry)
        return {
            "id": head[0], "name": head[1], "system_key": head[2],
            "created_at": head[3], "updated_at": head[4], "songs": songs,
            **({"kind": head[5]} if head[5] else {}),
        }

    def _resolve_album_orphan(self, work_key: str | None) -> dict:
        """A deleted album slot resolves to its work's CURRENT preferred/auto
        pick at read (§7.2): the slot plays `resolved_filename` today, and if
        the pinned file reappears (rescan) it simply resolves back to itself —
        no rewrite in either direction. A work with no charts left reports
        `missing` (the row stays, dimmed, so the set's denominator is honest)."""
        if work_key:
            self._ensure_work_display()
            row = self.conn.execute(
                "SELECT wd.filename, s.title, s.artist, s.tuning_name, s.arrangements "
                "FROM work_display wd JOIN songs s ON s.filename = wd.filename "
                "WHERE wd.effective_work_key = ? AND wd.is_group_representative = 1",
                (work_key,)).fetchone()
            if row:
                from urllib.parse import quote
                try:
                    arrs = _ensure_smart_names(json.loads(row[4]) if row[4] else [])
                except Exception:
                    arrs = []
                return {"resolved_filename": row[0], "title": row[1] or row[0],
                        "artist": row[2] or "", "tuning_name": row[3] or "",
                        "arrangements": arrs,
                        "art_url": f"/api/song/{quote(row[0])}/art",
                        "resolved_from_orphan": True}
        return {"missing": True}

    def add_playlist_song(self, pid: int, filename: str):
        with self._lock:
            # Re-check existence INSIDE the lock: the handler's earlier 404 check
            # is a separate step, so a concurrent delete_playlist could land
            # between them and leave an orphan playlist_songs row. Returning None
            # lets the handler answer 404 instead of inserting an orphan.
            row = self.conn.execute("SELECT kind FROM playlists WHERE id = ?", (pid,)).fetchone()
            if not row:
                return None
            # Album slots stamp the work identity at ADD time (§7.2 "resolved to
            # preferred once at add, pinned thereafter") — it's what lets a
            # later-deleted chart's slot self-heal to the work's current keeper.
            wk = self.work_key_for(filename) if row[0] == "album" else None
            nxt = self.conn.execute(
                "SELECT COALESCE(MAX(position), -1) + 1 FROM playlist_songs WHERE playlist_id = ?", (pid,)
            ).fetchone()[0]
            cur = self.conn.execute(
                "INSERT OR IGNORE INTO playlist_songs (playlist_id, filename, position, work_key) "
                "VALUES (?, ?, ?, ?)",
                (pid, filename, nxt, wk),
            )
            self.conn.execute("UPDATE playlists SET updated_at = datetime('now') WHERE id = ?", (pid,))
            self.conn.commit()
            return cur.rowcount > 0

    _SLOT_KEEP = object()   # sentinel: "leave the arrangement pin unchanged"

    def update_playlist_slot(self, pid: int, filename: str,
                             new_filename: str | None = None,
                             arrangement=_SLOT_KEEP):
        """Edit ONE album slot in place (§7.2): pin/clear its arrangement (a
        NAME — names survive rescans; None clears back to full-song) and/or swap
        the slot's chart for another chart of the SAME work, keeping position +
        pin — the per-slot pick is deliberately independent of the work's
        global preferred. Returns the slot's (possibly new) filename, or None
        when the slot doesn't exist, the swap target isn't a chart of the
        slot's work, or it's already in the playlist."""
        with self._lock:
            row = self.conn.execute(
                "SELECT position, work_key FROM playlist_songs "
                "WHERE playlist_id = ? AND filename = ?", (pid, filename)).fetchone()
            if not row:
                return None
            out_fn = filename
            if new_filename and new_filename != filename:
                # Same-work guard: the stored stamp wins (works even when the
                # pinned file is gone); fall back to computing from the row.
                wk_slot = row[1] or self.work_key_for(filename)
                if not wk_slot or self.work_key_for(new_filename) != wk_slot:
                    return None
                if self.conn.execute(
                        "SELECT 1 FROM playlist_songs WHERE playlist_id = ? AND filename = ?",
                        (pid, new_filename)).fetchone():
                    return None
                self.conn.execute(
                    "UPDATE playlist_songs SET filename = ?, work_key = ? "
                    "WHERE playlist_id = ? AND filename = ?",
                    (new_filename, wk_slot, pid, filename))
                out_fn = new_filename
            if arrangement is not self._SLOT_KEEP:
                self.conn.execute(
                    "UPDATE playlist_songs SET arrangement = ? "
                    "WHERE playlist_id = ? AND filename = ?",
                    (arrangement, pid, out_fn))
            self.conn.execute("UPDATE playlists SET updated_at = datetime('now') WHERE id = ?", (pid,))
            self.conn.commit()
        return out_fn

    def remove_playlist_song(self, pid: int, filename: str) -> bool:
        with self._lock:
            cur = self.conn.execute(
                "DELETE FROM playlist_songs WHERE playlist_id = ? AND filename = ?", (pid, filename)
            )
            self.conn.execute("UPDATE playlists SET updated_at = datetime('now') WHERE id = ?", (pid,))
            self.conn.commit()
            return cur.rowcount > 0

    def reorder_playlist(self, pid: int, ordered_filenames: list[str]) -> bool:
        with self._lock:
            for pos, fn in enumerate(ordered_filenames):
                self.conn.execute(
                    "UPDATE playlist_songs SET position = ? WHERE playlist_id = ? AND filename = ?",
                    (pos, pid, fn),
                )
            self.conn.execute("UPDATE playlists SET updated_at = datetime('now') WHERE id = ?", (pid,))
            self.conn.commit()
        return True

    def toggle_saved(self, filename: str) -> bool:
        """Add/remove a song on the Saved-for-Later playlist. Returns new state.
        The presence check and the add/remove run under one lock so two
        concurrent toggles of the same song can't both take the add path (or
        both remove) and leave an inconsistent saved state."""
        pid = self.saved_playlist_id()
        with self._lock:
            present = self.conn.execute(
                "SELECT 1 FROM playlist_songs WHERE playlist_id = ? AND filename = ?", (pid, filename)
            ).fetchone() is not None
            if present:
                self.conn.execute(
                    "DELETE FROM playlist_songs WHERE playlist_id = ? AND filename = ?", (pid, filename))
                new_state = False
            else:
                nxt = self.conn.execute(
                    "SELECT COALESCE(MAX(position), -1) + 1 FROM playlist_songs WHERE playlist_id = ?", (pid,)
                ).fetchone()[0]
                self.conn.execute(
                    "INSERT OR IGNORE INTO playlist_songs (playlist_id, filename, position) VALUES (?, ?, ?)",
                    (pid, filename, nxt))
                new_state = True
            self.conn.execute("UPDATE playlists SET updated_at = datetime('now') WHERE id = ?", (pid,))
            self.conn.commit()
        return new_state

    # ── Wishlist / "wanted" (feedBack#636 item 4) ─────────────────────────
    _WANTED_COLS = ("id", "artist", "title", "source", "source_ref", "note", "created_at")

    def add_wanted(self, artist: str, title: str, source: str = "manual",
                   source_ref: str = "", note: str = "") -> dict:
        """Add a not-owned song to the wishlist (or return the existing row if
        an entry with the same identity is already wanted — idempotent, so a
        re-run of an ownership-diff doesn't duplicate). Returns the row."""
        artist = (artist or "").strip()
        title = (title or "").strip()
        source = (source or "manual").strip() or "manual"
        source_ref = (source_ref or "").strip()
        note = (note or "").strip()
        with self._lock:
            self.conn.execute(
                "INSERT OR IGNORE INTO wanted (artist, title, source, source_ref, note, created_at) "
                "VALUES (?, ?, ?, ?, ?, datetime('now'))",
                (artist, title, source, source_ref, note),
            )
            row = self.conn.execute(
                "SELECT " + ", ".join(self._WANTED_COLS) + " FROM wanted "
                "WHERE artist = ? COLLATE NOCASE AND title = ? COLLATE NOCASE "
                "AND source = ? AND source_ref = ?",
                (artist, title, source, source_ref),
            ).fetchone()
            self.conn.commit()
        return dict(zip(self._WANTED_COLS, row)) if row else {}

    def list_wanted(self) -> list[dict]:
        """All wishlist entries, newest first."""
        rows = self.conn.execute(
            "SELECT " + ", ".join(self._WANTED_COLS) + " FROM wanted "
            "ORDER BY created_at DESC, id DESC"
        ).fetchall()
        return [dict(zip(self._WANTED_COLS, r)) for r in rows]

    def remove_wanted(self, wanted_id: int) -> bool:
        """Drop a wishlist entry by id. Returns True if a row was removed."""
        with self._lock:
            cur = self.conn.execute("DELETE FROM wanted WHERE id = ?", (wanted_id,))
            self.conn.commit()
            return cur.rowcount > 0

    def count_wanted(self) -> int:
        return self.conn.execute("SELECT COUNT(*) FROM wanted").fetchone()[0]

    def continue_session(self) -> dict | None:
        """Most-recently-played song (from song_stats) + metadata, for the
        Continue-Playing card. Null when nothing has been played."""
        row = self.conn.execute(
            "SELECT filename, arrangement, last_position FROM song_stats "
            "WHERE last_played_at IS NOT NULL " +
            self._existing_song_filter() +   # skip dead songs (race-free)
            "ORDER BY last_played_at DESC LIMIT 1"
        ).fetchone()
        if not row:
            return None
        filename, arrangement, last_position = row
        meta = self.conn.execute(
            "SELECT title, artist, tuning_name, duration FROM songs WHERE filename = ?", (filename,)
        ).fetchone()
        title, artist, tuning_name, duration = meta if meta else (None, None, None, None)
        from urllib.parse import quote
        return {
            "filename": filename, "arrangement": arrangement,
            "title": title or filename, "artist": artist or "",
            "tuning_name": tuning_name or "", "duration": duration or 0,
            "last_position": last_position,
            "art_url": f"/api/song/{quote(filename)}/art",
        }

    def favorite_set(self) -> set[str]:
        return {r[0] for r in self.conn.execute("SELECT filename FROM favorites").fetchall()}

    def get(self, filename: str, mtime: float, size: int) -> dict | None:
        cache_key = str(filename)
        with self._lock:
            row = self.conn.execute(
                "SELECT mtime, size, title, artist, album, year, duration, tuning, arrangements, has_lyrics, "
                "format, stem_count, stem_ids, tuning_name, tuning_sort_key, tuning_offsets "
                "FROM songs WHERE filename = ?", (cache_key,)
            ).fetchone()
        if row and row[0] == mtime and row[1] == size and row[2]:
            return {
                "title": row[2], "artist": row[3], "album": row[4],
                "year": row[5], "duration": row[6], "tuning": row[7],
                "arrangements": json.loads(row[8]) if row[8] else [],
                "has_lyrics": bool(row[9]),
                "format": row[10] or "archive",
                "stem_count": int(row[11] or 0),
                "stem_ids": json.loads(row[12]) if row[12] else [],
                "tuning_name": row[13] or "",
                "tuning_sort_key": int(row[14] or 0),
                "tuning_offsets": row[15] or "",
            }
        return None

    def put(self, filename: str, mtime: float, size: int, meta: dict):
        with self._lock:
            self.conn.execute(
                "INSERT OR REPLACE INTO songs "
                "(filename, mtime, size, title, artist, album, year, duration, tuning, arrangements, "
                "has_lyrics, format, stem_count, stem_ids, tuning_name, tuning_sort_key, tuning_offsets) "
                "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                (filename, mtime, size, meta.get("title", ""), meta.get("artist", ""),
                 meta.get("album", ""), meta.get("year", ""), meta.get("duration", 0),
                 meta.get("tuning", ""), json.dumps(meta.get("arrangements", [])),
                 1 if meta.get("has_lyrics") else 0,
                 meta.get("format", "archive"),
                 int(meta.get("stem_count", 0) or 0),
                 json.dumps(meta.get("stem_ids", []) or []),
                 meta.get("tuning_name", "") or "",
                 int(meta.get("tuning_sort_key", 0) or 0),
                 meta.get("tuning_offsets", "") or ""),
            )
            self.conn.commit()
            # A song's identity may have changed → the grouping read-model is stale.
            self._work_display_dirty = True

    def count(self) -> int:
        return self.conn.execute("SELECT COUNT(*) FROM songs WHERE title != ''").fetchone()[0]

    def delete_missing(self, current_filenames: set[str]):
        """Remove `songs` rows for files no longer on disk.

        Deliberately does NOT purge song_stats / playlist_songs here: a scan is a
        point-in-time snapshot, so a song that briefly disappears mid-scan (e.g.
        a directory-form .sloppak being overwritten via rmtree-then-extract, or a
        delete+reupload) and returns under the same filename would otherwise lose
        its stats/playlist membership permanently. Instead, stats are purged on
        the EXPLICIT delete path (DELETE /api/song) and dead-song rows are
        filtered at read time (recent_stats / continue_session /
        best_accuracy_map gate on the song still existing)."""
        with self._lock:
            db_files = {r[0] for r in self.conn.execute("SELECT filename FROM songs").fetchall()}
            stale = db_files - current_filenames
            if stale:
                self.conn.executemany("DELETE FROM songs WHERE filename = ?", [(f,) for f in stale])
                self.conn.commit()
                self._work_display_dirty = True   # membership changed → regroup
            return len(stale)

    def _estd_set(self) -> set[str]:
        """Get set of filenames that have a retuned variant (_EStd_ or _DropD_) in the DB."""
        rows = self.conn.execute(
            "SELECT filename FROM songs WHERE filename LIKE '%\\_EStd\\_%' ESCAPE '\\' "
            "OR filename LIKE '%\\_DropD\\_%' ESCAPE '\\'"
        ).fetchall()
        originals = set()
        for (fname,) in rows:
            originals.add(fname.replace("_EStd_", "_").replace("_DropD_", "_"))
        return originals

    # Manifest-allowed filter values. Whitelisted before binding so a
    # malformed query string can't push arbitrary text through to SQL —
    # parameters are bound, but capping the input space is still cheap
    # defense-in-depth (see feedBack#129).
    _ALLOWED_ARRANGEMENT_NAMES = {"Lead", "Rhythm", "Bass", "Combo"}
    # Per-smart-type list of (sql_op, sql_param) pairs appended to the SQL
    # name-fallback branch (key-absent smart_name). Covers legacy raw names
    # and load_song()'s synthesised display names that map to each smart type.
    _SMART_NULL_FALLBACK_EXTRAS: dict[str, tuple[tuple[str, str], ...]] = {
        "Lead": (("=", "Combo"), ("LIKE", "Alt. Combo%"), ("LIKE", "Bonus Combo%")),
        "Bass": (("=", "Bass 2"),),
    }
    # Stem ids match the bare strings sloppak manifests use today —
    # `full`, `guitar`, `bass`, `drums`, `vocals`, `piano`, `other`. The
    # frontend filter UI omits `full` (it's the always-on fallback mix
    # and would match every sloppak), but the server-side whitelist
    # keeps it so a hand-rolled API client can still ask for it.
    _ALLOWED_STEM_IDS = {"full", "guitar", "bass", "drums", "vocals", "piano", "other"}

    @classmethod
    def _smart_null_extras(cls, arr_type: str) -> tuple[str, list[str]]:
        """Return (sql_fragment, bound_params) for the extra raw-name terms to
        OR into the key-absent NULL-smart_name fallback branch for arr_type.
        Empty when no extras are defined."""
        terms = cls._SMART_NULL_FALLBACK_EXTRAS.get(arr_type, ())
        fragment = "".join(
            f" OR json_extract(value, '$.name') {op} ?" for op, _ in terms
        )
        return fragment, [val for _, val in terms]

    def _build_where(self, q: str = "", favorites_only: bool = False,
                     format_filter: str = "",
                     artist_filter: str = "",
                     album_filter: str = "",
                     arrangements_has: list[str] | None = None,
                     arrangements_lacks: list[str] | None = None,
                     stems_has: list[str] | None = None,
                     stems_lacks: list[str] | None = None,
                     has_lyrics: int | None = None,
                     tunings: list[str] | None = None,
                     mastery: list[str] | None = None,
                     tags_has: list[str] | None = None,
                     user_difficulty_in: list[str] | None = None,
                     naming_mode: str = "legacy",
                     include_intrinsic: bool = True) -> tuple[str, list]:
        """Shared WHERE-clause builder for query_page / query_artists /
        query_stats. Returns (where_sql, params). Leading 'WHERE' is
        included so callers paste it directly. See feedBack#129/#69.

        Clauses are two classes (the §7.1 filter law): work-identity +
        practice-state predicates live here; CHART-INTRINSIC predicates
        (format / arrangements / stems / lyrics / tuning) are built by
        `_build_intrinsic_where` and appended when `include_intrinsic`.
        Grouped queries pass include_intrinsic=False and re-apply the
        intrinsic set as a match-if-ANY-member subquery instead.
        """
        where = "WHERE title != ''"
        params: list = []
        if favorites_only:
            where += " AND filename IN (SELECT filename FROM favorites)"
        if artist_filter:
            # The dropdown/tree list CANONICAL names (query_artists), so a filter
            # value is canonical — expand it to every raw variant aliased to it so
            # picking "AC/DC" returns songs tagged "ACDC" too. `artist IN (...)`
            # keeps the artist index (keyset-safe), unlike a per-row COALESCE.
            variants = self._raw_variants_for(artist_filter)
            ph = ",".join(["?"] * len(variants))
            where += f" AND artist COLLATE NOCASE IN ({ph})"
            params += variants
        if album_filter:
            where += " AND album = ? COLLATE NOCASE"
            params.append(album_filter)
        # Mastery bands = best accuracy across a song's arrangements (song_stats,
        # a separate table -> correlated subquery). mastered >= 0.9, in_progress =
        # attempted but < 0.9, not_started = no score. OR within the selected set.
        if mastery:
            _msub = "(SELECT MAX(best_accuracy) FROM song_stats s WHERE s.filename = songs.filename)"
            _bands = {
                "mastered": f"{_msub} >= 0.9",
                "in_progress": f"({_msub} IS NOT NULL AND {_msub} < 0.9)",
                "not_started": f"{_msub} IS NULL",
            }
            _sel = [_bands[b] for b in mastery if b in _bands]
            if _sel:
                where += " AND (" + " OR ".join(_sel) + ")"
        # Personal practice tags (song_tags) — any-of. EXISTS-style IN keeps it a
        # predicate on `songs` (keyset-safe, no row multiplication). Normalized to
        # match how tags are stored.
        _tags = [t for t in (_normalize_tag(x) for x in (tags_has or [])) if t]
        if _tags:
            ph = ",".join(["?"] * len(_tags))
            where += (" AND filename IN (SELECT filename FROM song_tags "
                      f"WHERE tag IN ({ph}))")
            params += _tags
        # Personal user-difficulty (song_user_meta) — any-of over the 1..5 set.
        _diffs = []
        for d in (user_difficulty_in or []):
            try:
                di = int(d)
            except (TypeError, ValueError):
                continue
            if 1 <= di <= 5:
                _diffs.append(di)
        if _diffs:
            ph = ",".join(["?"] * len(_diffs))
            where += (" AND filename IN (SELECT filename FROM song_user_meta "
                      f"WHERE user_difficulty IN ({ph}))")
            params += _diffs
        if q:
            where += " AND (title LIKE ? COLLATE NOCASE OR artist LIKE ? COLLATE NOCASE OR album LIKE ? COLLATE NOCASE)"
            params += [f"%{q}%"] * 3
        if include_intrinsic:
            ifrag, iparams = self._build_intrinsic_where(
                "songs", format_filter=format_filter,
                arrangements_has=arrangements_has, arrangements_lacks=arrangements_lacks,
                stems_has=stems_has, stems_lacks=stems_lacks,
                has_lyrics=has_lyrics, tunings=tunings, naming_mode=naming_mode)
            where += ifrag
            params += iparams
        return where, params

    def _build_intrinsic_where(self, alias: str, format_filter: str = "",
                               arrangements_has: list[str] | None = None,
                               arrangements_lacks: list[str] | None = None,
                               stems_has: list[str] | None = None,
                               stems_lacks: list[str] | None = None,
                               has_lyrics: int | None = None,
                               tunings: list[str] | None = None,
                               naming_mode: str = "legacy") -> tuple[str, list]:
        """CHART-INTRINSIC predicates (format / arrangements / stems / lyrics /
        tuning) as ' AND …' fragments against an explicit table alias. Flat
        queries apply them to `songs` directly; grouped queries evaluate them
        against each work member `m` inside an EXISTS (§7.1 filter law — a
        work matches when ANY of its charts does, so a song you own in Drop D
        isn't hidden because your preferred chart is E Standard)."""
        where = ""
        params: list = []
        if format_filter:
            where += f" AND {alias}.format = ?"
            params.append(format_filter)
        # arrangements_has / arrangements_lacks: OR within axis (any-of).
        # Uses JSON1's json_each which yields one row per arrangement, then
        # matches the relevant field. The whole subquery is wrapped in EXISTS
        # so we don't multiply rows in the outer SELECT.
        #
        # Smart mode: each requested type (Lead/Rhythm/Bass) matches against
        # smart_name when present. "Lead" matches smart_name in
        # ('Lead', 'Alt. Lead', 'Alt. Lead N', 'Bonus Lead', 'Bonus Lead N').
        # Falls back to matching `name` for older rows without smart_name.
        # Legacy mode: matches `name` directly (original behaviour).
        arr_has = [a for a in (arrangements_has or []) if a in self._ALLOWED_ARRANGEMENT_NAMES]
        if arr_has and naming_mode == "smart":
            # Smart mode subsumes "Combo" into "Lead" — normalize here so a
            # hand-rolled API client matches the client-side behaviour and
            # the SQL doesn't need a "Combo" smart-type branch.
            arr_has = list(dict.fromkeys("Lead" if a == "Combo" else a for a in arr_has))
        if arr_has:
            if naming_mode == "smart":
                clauses = []
                for arr_type in arr_has:
                    # Extra raw-name fragments matched only in the key-absent
                    # NULL-smart_name fallback branch — they cover the legacy
                    # display names that map to this smart type:
                    #   Lead: "Combo" (combined guitar) + Alt./Bonus Combo
                    #   Bass: "Bass 2" (load_song synthesises for real_bass_22)
                    extra_null, extra_null_params = self._smart_null_extras(arr_type)
                    # json_type() returns NULL when the key is absent and the
                    # string 'null' when the key exists with explicit JSON null
                    # (set by the scanner for ambiguous duplicate-name rows).
                    # Name-fallback only applies to key-absent rows so an
                    # explicit null suppresses the fallback and lets the
                    # background rescan resolve the ambiguity authoritatively.
                    clauses.append(
                        "(json_extract(value, '$.smart_name') IS NOT NULL AND ("
                        f"json_extract(value, '$.smart_name') = ? OR "
                        f"json_extract(value, '$.smart_name') LIKE ? OR "
                        f"json_extract(value, '$.smart_name') LIKE ?"
                        ")) OR ("
                        "json_type(value, '$.smart_name') IS NULL AND ("
                        "json_extract(value, '$.name') = ? OR "
                        "json_extract(value, '$.name') LIKE ? OR "
                        f"json_extract(value, '$.name') LIKE ?{extra_null}))"
                    )
                    params += [
                        arr_type,
                        f"Alt. {arr_type}%",
                        f"Bonus {arr_type}%",
                        arr_type,
                        f"Alt. {arr_type}%",
                        f"Bonus {arr_type}%",
                    ] + extra_null_params
                where += (
                    f" AND EXISTS (SELECT 1 FROM json_each({alias}.arrangements) WHERE "
                    + " OR ".join(f"({c})" for c in clauses)
                    + ")"
                )
            else:
                placeholders = ",".join(["?"] * len(arr_has))
                where += (f" AND EXISTS (SELECT 1 FROM json_each({alias}.arrangements) "
                          f"WHERE json_extract(value, '$.name') IN ({placeholders}))")
                params += arr_has
        arr_lacks = [a for a in (arrangements_lacks or []) if a in self._ALLOWED_ARRANGEMENT_NAMES]
        if arr_lacks and naming_mode == "smart":
            arr_lacks = list(dict.fromkeys("Lead" if a == "Combo" else a for a in arr_lacks))
        if arr_lacks:
            if naming_mode == "smart":
                clauses = []
                for arr_type in arr_lacks:
                    extra_null, extra_null_params = self._smart_null_extras(arr_type)
                    # See "has" branch above for the json_type rationale.
                    # Extra branch (vs `has`): an explicit smart_name=null
                    # arrangement is ambiguous; we don't know whether it's
                    # `arr_type` or not. Be conservative and treat it as
                    # potentially matching, so `arrangements_lacks` excludes
                    # the parent row instead of falsely claiming it lacks
                    # `arr_type`. The background rescan resolves the ambiguity.
                    clauses.append(
                        "(json_extract(value, '$.smart_name') IS NOT NULL AND ("
                        f"json_extract(value, '$.smart_name') = ? OR "
                        f"json_extract(value, '$.smart_name') LIKE ? OR "
                        f"json_extract(value, '$.smart_name') LIKE ?"
                        ")) OR ("
                        "json_type(value, '$.smart_name') = 'null'"
                        ") OR ("
                        "json_type(value, '$.smart_name') IS NULL AND ("
                        "json_extract(value, '$.name') = ? OR "
                        "json_extract(value, '$.name') LIKE ? OR "
                        f"json_extract(value, '$.name') LIKE ?{extra_null}))"
                    )
                    params += [
                        arr_type,
                        f"Alt. {arr_type}%",
                        f"Bonus {arr_type}%",
                        arr_type,
                        f"Alt. {arr_type}%",
                        f"Bonus {arr_type}%",
                    ] + extra_null_params
                where += (
                    f" AND NOT EXISTS (SELECT 1 FROM json_each({alias}.arrangements) WHERE "
                    + " OR ".join(f"({c})" for c in clauses)
                    + ")"
                )
            else:
                placeholders = ",".join(["?"] * len(arr_lacks))
                where += (f" AND NOT EXISTS (SELECT 1 FROM json_each({alias}.arrangements) "
                          f"WHERE json_extract(value, '$.name') IN ({placeholders}))")
                params += arr_lacks
        stems_h = [s for s in (stems_has or []) if s in self._ALLOWED_STEM_IDS]
        if stems_h:
            placeholders = ",".join(["?"] * len(stems_h))
            where += (f" AND EXISTS (SELECT 1 FROM json_each({alias}.stem_ids) "
                      f"WHERE value IN ({placeholders}))")
            params += stems_h
        stems_l = [s for s in (stems_lacks or []) if s in self._ALLOWED_STEM_IDS]
        if stems_l:
            placeholders = ",".join(["?"] * len(stems_l))
            where += (f" AND NOT EXISTS (SELECT 1 FROM json_each({alias}.stem_ids) "
                      f"WHERE value IN ({placeholders}))")
            params += stems_l
        if has_lyrics in (0, 1):
            where += f" AND {alias}.has_lyrics = ?"
            params.append(has_lyrics)
        if tunings:
            # Keep the input cap conservative (32) so a hostile caller
            # can't blow out the parameter list. Real tuning sets in the
            # wild number in the low double digits.
            tn = [t for t in tunings if isinstance(t, str) and t][:32]
            if tn:
                placeholders = ",".join(["?"] * len(tn))
                # Match the same grouping key tuning_names() returns so a single
                # "Custom Tuning" pill selects exactly its offset set while named
                # tunings still match by name.
                where += (f" AND {_tuning_group_key_sql(alias)} "
                          f"COLLATE NOCASE IN ({placeholders})")
                params += tn
        return where, params

    # Under group=1, chart-intrinsic filters match if ANY member of the work
    # matches (§7.1 filter law). A pure predicate on the representative scan —
    # no GROUP BY, no row multiplication — so the keyset cursor stays valid.
    def _grouped_member_match(self, intrinsic_frag: str, intrinsic_params: list) -> tuple[str, list]:
        if not intrinsic_frag:
            return "", []
        return ((" AND EXISTS (SELECT 1 FROM songs m JOIN work_display mw ON mw.filename = m.filename "
                 "WHERE mw.effective_work_key = (SELECT w0.effective_work_key FROM work_display w0 "
                 "WHERE w0.filename = songs.filename)" + intrinsic_frag + ")"),
                list(intrinsic_params))

    # ── Multi-chart grouping engine (P5a) ────────────────────────────────────
    @staticmethod
    def _norm_token(s, fold_the=False):
        """Fold a name to a comparison token: strip diacritics + punctuation +
        whitespace, lowercase, optionally drop a leading 'the ' (artist names)."""
        import re
        import unicodedata
        raw = str(s or "")
        s = unicodedata.normalize("NFKD", raw)
        s = "".join(c for c in s if not unicodedata.combining(c)).lower()
        if fold_the:
            s = re.sub(r"^the\s+", "", s)
        folded = re.sub(r"[^a-z0-9]+", "", s)
        if folded:
            return folded
        # All-non-Latin titles (CJK/Cyrillic/Greek/Arabic) fold to "" above,
        # which would collapse every such song into one bogus work. Fall back to
        # the raw text lowercased with whitespace collapsed so distinct titles
        # keep distinct keys. Latin names always hit the `folded` branch, so
        # their behavior is unchanged.
        return re.sub(r"\s+", " ", raw.strip().lower())

    @classmethod
    def _work_key(cls, artist, title) -> str:
        """Identity of a musical WORK = normalize(artist)+'|'+normalize(title).
        Recording-MBID identity is a later enrichment upgrade (§3); this text key
        groups the common 'same song, several charts' case now."""
        return cls._norm_token(artist, fold_the=True) + "|" + cls._norm_token(title)

    def _alias_map_if_exists(self) -> dict:
        """{raw_artist_lower: canonical} from P4's artist_alias when that table is
        present, so work_key groups across artist aliases (ACDC/AC/DC) once P4 is
        merged; {} (→ raw artist) when it isn't. Forward-compatible, no hard P4 dep."""
        try:
            rows = self.conn.execute("SELECT raw_name, canonical_name FROM artist_alias").fetchall()
        except Exception:
            return {}
        return {r[0].lower(): r[1] for r in rows}

    @staticmethod
    def _pick_representative(members: list, prefs: dict) -> str:
        """The keeper chart of a group: the user's chart_group_pref when its file
        is present, else auto-pick = MOST-PLAYED (history-sticky, §7.1: real
        practice wins — a newer/'more complete' import must not silently take
        the pick from the chart your reps accrued on, and a one-off try of an
        alternate can't out-rank a practiced incumbent) → most-complete
        (arrangements) → newest → filename. An all-unplayed group therefore
        still picks by completeness. `members` = dicts {fn, wk, arr, plays, mtime}."""
        if members:
            pref = prefs.get(members[0]["wk"])
            if pref and any(m["fn"] == pref for m in members):
                return pref
        best = min(members, key=lambda m: (-m["plays"], -m["arr"], -m["mtime"], m["fn"]))
        return best["fn"]

    def _load_work_members(self):
        """Read songs + overrides → ({effective_work_key: [member dicts]}, prefs)."""
        amap = self._alias_map_if_exists()
        splits = dict(self.conn.execute(
            "SELECT filename, split_key FROM chart_group_split").fetchall())
        prefs = dict(self.conn.execute(
            "SELECT work_key, preferred_filename FROM chart_group_pref").fetchall())
        plays = dict(self.conn.execute(
            "SELECT filename, SUM(plays) FROM song_stats GROUP BY filename").fetchall())
        groups: dict = {}
        for fn, artist, title, arr_json, mtime in self.conn.execute(
                "SELECT filename, artist, title, arrangements, mtime FROM songs WHERE title != ''"):
            wk = self._work_key(amap.get((artist or "").lower(), artist), title)
            eff = splits.get(fn) or wk
            try:
                arr = len(json.loads(arr_json)) if arr_json else 0
            except Exception:
                arr = 0
            groups.setdefault(eff, []).append(
                {"fn": fn, "wk": wk, "arr": arr, "plays": int(plays.get(fn) or 0), "mtime": mtime or 0})
        return groups, prefs

    def rebuild_work_display(self) -> None:
        """Full re-materialization of work_display from songs + the override
        tables. O(n) — cheap enough to run lazily after any songs churn."""
        with self._lock:
            groups, prefs = self._load_work_members()
            out = []
            for eff, members in groups.items():
                rep = self._pick_representative(members, prefs)
                n = len(members)
                for m in members:
                    out.append((m["fn"], m["wk"], eff, 1 if m["fn"] == rep else 0, n))
            self.conn.execute("DELETE FROM work_display")
            if out:
                self.conn.executemany(
                    "INSERT INTO work_display (filename, work_key, effective_work_key, "
                    "is_group_representative, group_size) VALUES (?, ?, ?, ?, ?)", out)
            self.conn.commit()
            self._work_display_dirty = False

    def _ensure_work_display(self) -> None:
        """(Re)build the read-model when a change marked it dirty (or it's never
        been built). Called at the top of every grouped query."""
        if getattr(self, "_work_display_dirty", True):
            self.rebuild_work_display()

    def work_key_for(self, filename: str):
        """work_key of a song (from its current artist+title), or None if absent."""
        row = self.conn.execute(
            "SELECT artist, title FROM songs WHERE filename = ?", (filename,)).fetchone()
        if not row:
            return None
        amap = self._alias_map_if_exists()
        return self._work_key(amap.get((row[0] or "").lower(), row[0]), row[1])

    def set_chart_preferred(self, work_key: str, filename: str) -> None:
        """Pick the keeper chart of a work. Incremental: re-flips
        is_group_representative within the work's (non-split) group only —
        group_size is unchanged — so no full rebuild."""
        with self._lock:
            self.conn.execute(
                "INSERT INTO chart_group_pref (work_key, preferred_filename, updated_at) "
                "VALUES (?, ?, datetime('now')) "
                "ON CONFLICT(work_key) DO UPDATE SET "
                "preferred_filename = excluded.preferred_filename, updated_at = excluded.updated_at",
                (work_key, filename))
            if not self._work_display_dirty:
                members = [r[0] for r in self.conn.execute(
                    "SELECT filename FROM work_display WHERE effective_work_key = ?",
                    (work_key,)).fetchall()]
                if filename in members:
                    self.conn.execute(
                        "UPDATE work_display SET is_group_representative = "
                        "CASE WHEN filename = ? THEN 1 ELSE 0 END "
                        "WHERE effective_work_key = ?", (filename, work_key))
                else:
                    # pref target isn't a current member (orphan/split) — reconcile
                    # on the next lazy rebuild rather than leave it half-applied.
                    self._work_display_dirty = True
            self.conn.commit()

    def clear_chart_preferred(self, work_key: str) -> None:
        """Reset a work to auto-pick; lazy full rebuild."""
        with self._lock:
            self.conn.execute("DELETE FROM chart_group_pref WHERE work_key = ?", (work_key,))
            self._work_display_dirty = True
            self.conn.commit()

    def split_chart(self, filename: str) -> None:
        """'These aren't the same' — give a chart a unique split_key so it stands
        alone as a singleton work. Lazy full rebuild (the old group's membership +
        sizes shift)."""
        wk = self.work_key_for(filename) or filename
        with self._lock:
            self.conn.execute(
                "INSERT INTO chart_group_split (filename, split_key, updated_at) "
                "VALUES (?, ?, datetime('now')) "
                "ON CONFLICT(filename) DO UPDATE SET "
                "split_key = excluded.split_key, updated_at = excluded.updated_at",
                (filename, f"{wk}#split#{filename}"))
            self._work_display_dirty = True
            self.conn.commit()

    def unsplit_chart(self, filename: str) -> None:
        """Undo a split — the chart rejoins its work. Lazy full rebuild."""
        with self._lock:
            self.conn.execute("DELETE FROM chart_group_split WHERE filename = ?", (filename,))
            self._work_display_dirty = True
            self.conn.commit()

    def work_charts(self, work_key: str) -> dict:
        """Every chart in a work (P5b) — the Charts drawer's data. Members are the
        work's CURRENT (non-split) group: work_display rows whose effective_work_key
        matches. Each carries its effective title/artist, arrangements, tuning,
        format, best accuracy, and the representative/preferred flags so the drawer
        can label 'Preferred — your pick' vs 'Preferred (auto)'."""
        self._ensure_work_display()
        amap = self._alias_map_if_exists()
        pref_row = self.conn.execute(
            "SELECT preferred_filename FROM chart_group_pref WHERE work_key = ?", (work_key,)).fetchone()
        pref_fn = pref_row[0] if pref_row else None
        rows = self.conn.execute(
            "SELECT wd.filename, wd.is_group_representative, s.title, s.artist, s.album, s.year, "
            "s.arrangements, s.tuning_name, s.tuning, s.format, "
            "(SELECT MAX(best_accuracy) FROM song_stats st WHERE st.filename = wd.filename AND st.plays > 0) "
            "FROM work_display wd JOIN songs s ON s.filename = wd.filename "
            "WHERE wd.effective_work_key = ? "
            "ORDER BY wd.is_group_representative DESC, s.title COLLATE NOCASE, s.filename",
            (work_key,)).fetchall()
        charts = []
        for fn, is_rep, title, artist, album, year, arr_json, tuning_name, tuning, fmt, best in rows:
            try:
                arrangements = _ensure_smart_names(json.loads(arr_json) if arr_json else [])
            except Exception:
                arrangements = []
            charts.append({
                "filename": fn,
                "title": title or fn,
                "artist": amap.get((artist or "").lower(), artist) or "",
                "album": album or "", "year": year or "",
                "arrangements": arrangements,
                "tuning_name": tuning_name or "", "tuning": tuning or "",
                "format": fmt or "archive",
                "best_accuracy": best,
                "is_representative": bool(is_rep),
                "is_preferred": (fn == pref_fn),
            })
        return {
            "work_key": work_key,
            "count": len(charts),
            "preferred_filename": pref_fn,
            # Whether the keeper is your explicit pick or the auto-pick — drives the
            # drawer's "Preferred — your pick" vs "Preferred (auto)" label.
            "preferred_source": "user" if pref_fn else "auto",
            "charts": charts,
        }

    def chart_work(self, filename: str) -> dict:
        """The work a chart belongs to (P5d): its EFFECTIVE work_key (a split
        chart resolves to its own singleton key) + how many charts share it.
        Lets an opener resolve group membership for rows that didn't come from
        a grouped query — the tree view's rows ride the ungrouped artists
        endpoint, so they carry no chart_count/work_key annotation."""
        key = self._canonical_song_filename(filename)
        self._ensure_work_display()
        row = self.conn.execute(
            "SELECT effective_work_key, group_size FROM work_display WHERE filename = ?",
            (key,)).fetchone()
        if not row:
            return {"filename": key, "work_key": None, "chart_count": 0, "is_split": False}
        split = self.conn.execute(
            "SELECT 1 FROM chart_group_split WHERE filename = ?", (key,)).fetchone()
        return {"filename": key, "work_key": row[0], "chart_count": row[1],
                "is_split": bool(split)}

    # Predicate that narrows a query to one representative chart per work — the
    # keyset-safe grouping filter (see query_page / query_stats).
    _GROUP_REP_PREDICATE = " AND filename IN (SELECT filename FROM work_display WHERE is_group_representative = 1)"

    def query_page(self, q: str = "", page: int = 0, size: int = 24,
                   sort: str = "artist", direction: str = "asc",
                   favorites_only: bool = False,
                   format_filter: str = "",
                   artist_filter: str = "",
                   album_filter: str = "",
                   arrangements_has: list[str] | None = None,
                   arrangements_lacks: list[str] | None = None,
                   stems_has: list[str] | None = None,
                   stems_lacks: list[str] | None = None,
                   has_lyrics: int | None = None,
                   tunings: list[str] | None = None,
                   mastery: list[str] | None = None,
                   tags_has: list[str] | None = None,
                   user_difficulty_in: list[str] | None = None,
                   after: str | None = None,
                   group: bool = False,
                   naming_mode: str = "legacy") -> tuple[list[dict], int]:
        """Server-side paginated search. Returns (songs, total_count).

        `after` is an opaque keyset cursor (the last row of the previous page).
        When supplied and the sort can keyset, the page is fetched with a
        WHERE-seek instead of OFFSET — O(page), independent of depth. Unknown
        sorts / bad cursors fall back to OFFSET, so it's always safe.

        `group` collapses a work's charts to one card (P5a): it adds a single
        `WHERE is_group_representative = 1` predicate over the materialized
        work_display, so the total counts WORKS not charts and the keyset seek /
        sort / A–Z all stay correct over the representative subset. Each grouped
        row carries `chart_count` (the ⚑ N).

        Filter law under grouping (P5e, §7.1): work-identity (artist/album/q)
        + practice-state (favorites/mastery/tags/difficulty) predicates stay on
        the representative row (identity ≈ the work; practice-state anchors on
        the preferred chart), while CHART-INTRINSIC predicates (format/
        arrangements/stems/lyrics/tuning) match if ANY member of the work does
        — and when the representative itself doesn't match, the row carries a
        `display_chart` override so the card can show/play the matching one."""
        where, params = self._build_where(
            q=q, favorites_only=favorites_only, format_filter=format_filter,
            artist_filter=artist_filter, album_filter=album_filter,
            arrangements_has=arrangements_has, arrangements_lacks=arrangements_lacks,
            stems_has=stems_has, stems_lacks=stems_lacks,
            has_lyrics=has_lyrics, tunings=tunings, mastery=mastery,
            tags_has=tags_has, user_difficulty_in=user_difficulty_in,
            naming_mode=naming_mode, include_intrinsic=not group,
        )
        ifrag, iparams = "", []
        if group:
            self._ensure_work_display()
            ifrag, iparams = self._build_intrinsic_where(
                "m", format_filter=format_filter,
                arrangements_has=arrangements_has, arrangements_lacks=arrangements_lacks,
                stems_has=stems_has, stems_lacks=stems_lacks,
                has_lyrics=has_lyrics, tunings=tunings, naming_mode=naming_mode)
            mfrag, mparams = self._grouped_member_match(ifrag, iparams)
            where += mfrag
            params += mparams
            where += self._GROUP_REP_PREDICATE

        sort_map = {
            "artist": "artist COLLATE NOCASE", "artist-desc": "artist COLLATE NOCASE DESC",
            "title": "title COLLATE NOCASE", "title-desc": "title COLLATE NOCASE DESC",
            "recent": "mtime DESC",
            # Tuning sort uses musical distance from E Standard
            # (feedBack#22 — was alphabetical). `tuning_sort_key` is
            # the sum of per-string offsets, so |sort_key| is the
            # magnitude of the down/up-tune. ABS ascending puts E
            # Standard (0) first, then ±2 (Drop D, F Standard), then
            # ±6 (Eb Standard, F# Standard), and so on. Within a
            # magnitude tier we break ties by signed key ASC so the
            # negative (down-tuned) variant comes before the positive
            # (up-tuned) one — Eb Standard before F Standard, matching
            # how the app groups its tuning list. Final tiebreak by
            # name keeps the order fully deterministic.
            #
            # Leading term pushes pre-migration / unscanned rows to
            # the bottom — without it ABS(0) collides with E
            # Standard's 0 and unindexed rows would sort first.
            # COALESCE on every column the clause references guards
            # against NULL values — SQLite's literal-constant ADD
            # COLUMN does backfill on most versions, but raw SQL
            # inserts that bypass `put()`, edge-case migration paths,
            # or future code that writes None could still leave NULLs
            # behind, and a NULL `tuning_name` in `(tuning_name = '')`
            # evaluates to NULL itself (which sorts ahead of 0 in
            # ASC), defeating the push-to-bottom intent.
            "tuning": (
                "(COALESCE(tuning_name, '') = '') ASC, "
                "ABS(COALESCE(tuning_sort_key, 0)), "
                "COALESCE(tuning_sort_key, 0) ASC, "
                "COALESCE(tuning_name, '') COLLATE NOCASE"
            ),
            # Year sort (feedBack#128). Empty-year rows pushed to the
            # bottom for both directions; otherwise CAST so '2010' >
            # '2005' rather than alphabetic.
            "year": "(year = '') ASC, CAST(year AS INTEGER) ASC",
            "year-desc": "(year = '') ASC, CAST(year AS INTEGER) DESC",
            # Mastery = best accuracy across a song's arrangements, from the
            # separate song_stats table (so via a correlated subquery — this sort
            # drops to OFFSET paging, like tuning/year). Unscored ("not started")
            # songs push to the BOTTOM in both directions (the IS NULL term);
            # ascending is "needs practice first" (weakest measured first),
            # descending is "most mastered first".
            "mastery": (
                "((SELECT MAX(best_accuracy) FROM song_stats s WHERE s.filename = songs.filename) IS NULL) ASC, "
                "(SELECT MAX(best_accuracy) FROM song_stats s WHERE s.filename = songs.filename) ASC"
            ),
            "mastery-desc": (
                "((SELECT MAX(best_accuracy) FROM song_stats s WHERE s.filename = songs.filename) IS NULL) ASC, "
                "(SELECT MAX(best_accuracy) FROM song_stats s WHERE s.filename = songs.filename) DESC"
            ),
        }
        if group and sort in ("mastery", "mastery-desc"):
            # Sort law (§7.1): mastery aggregates MAX across the WHOLE group —
            # a song surfaces on any chart you've touched, even when the
            # preferred chart is unplayed. Mastery never keysets (OFFSET
            # paging), so the aggregate can't disturb a cursor. The recency
            # ("Recently Added") aggregate is deliberately NOT applied: mtime
            # IS a keyset sort, so its aggregate would need materializing into
            # work_display to stay cursor-safe — deferred until wanted (the
            # auto-pick's `newest` factor already surfaces new charts of
            # unplayed works; played works stay put by the sticky rule).
            _gm = ("(SELECT MAX(st.best_accuracy) FROM song_stats st "
                   "JOIN work_display sw ON sw.filename = st.filename "
                   "WHERE sw.effective_work_key = (SELECT w1.effective_work_key "
                   "FROM work_display w1 WHERE w1.filename = songs.filename))")
            sort_map["mastery"] = f"({_gm} IS NULL) ASC, {_gm} ASC"
            sort_map["mastery-desc"] = f"({_gm} IS NULL) ASC, {_gm} DESC"
        order = sort_map.get(sort, "artist COLLATE NOCASE")
        # Legacy `dir=desc` toggle: only safe to append on simple sort
        # clauses that don't already encode a direction. Compound /
        # multi-term entries above (tuning, year, year-desc) bake their
        # ASC/DESC into the clause, so a global ` DESC` append would
        # produce invalid SQL like `CAST(year AS INTEGER) ASC DESC`.
        # Skip the append in that case — clients flipping direction on
        # those sorts use the explicit `-desc` sort key instead.
        if direction == "desc" and " ASC" not in order and " DESC" not in order:
            order += " DESC"
        # Unique, deterministic tiebreak → a TOTAL order. Without it, rows with
        # an equal sort key can reshuffle between OFFSET pages (skip/dupe); it's
        # also what makes keyset seeking correct.
        order += ", filename"

        # Grouped reads filter through the materialized work_display (the
        # `is_group_representative=1` predicate). rebuild_work_display does
        # DELETE→INSERT→commit under self._lock, so a lock-free reader on
        # another thread (shared conn, check_same_thread=False) could land its
        # SELECT in the mid-rebuild window and see 0 rows. Hold self._lock
        # across the representative COUNT+SELECT so it can't overlap a rebuild.
        # _ensure_work_display already rebuilt above under its own lock (and
        # self._lock is NOT reentrant), so we must NOT nest it here. Ungrouped
        # reads stay lock-free (WAL) via nullcontext.
        read_guard = self._lock if group else contextlib.nullcontext()
        with read_guard:
            total = self.conn.execute(f"SELECT COUNT(*) FROM songs {where}", params).fetchone()[0]

            cols = ("SELECT filename, title, artist, album, year, duration, tuning, "
                    "arrangements, has_lyrics, mtime, format, stem_count, stem_ids, "
                    "tuning_name, tuning_offsets FROM songs ")
            cursor = _decode_cursor(after) if after else None
            eff_sort = _effective_keyset_sort(sort, direction)
            if cursor and eff_sort in _KEYSET_SORTS:
                # Keyset seek: rows strictly after the cursor in the total order
                # `<col> <dir>, filename ASC` (NULL-aware, so == OFFSET exactly).
                col, collate, primary_dir = _KEYSET_SORTS[eff_sort]
                seek, seek_params = _keyset_seek(col, collate, primary_dir, cursor[0], cursor[1])
                seek_where = where + (" AND " if where else " WHERE ") + seek
                rows = self.conn.execute(
                    f"{cols}{seek_where} ORDER BY {order} LIMIT ?",
                    params + seek_params + [size],
                ).fetchall()
            else:
                rows = self.conn.execute(
                    f"{cols}{where} ORDER BY {order} LIMIT ? OFFSET ?",
                    params + [size, page * size],
                ).fetchall()

        estd = self._estd_set()
        favs = self.favorite_set()
        songs = []
        for r in rows:
            songs.append({
                "filename": r[0], "title": r[1], "artist": r[2], "album": r[3],
                "year": r[4], "duration": r[5], "tuning": r[6],
                "arrangements": _ensure_smart_names(json.loads(r[7]) if r[7] else []),
                "has_lyrics": bool(r[8]), "mtime": r[9],
                "format": r[10] or "archive",
                "stem_count": int(r[11] or 0),
                "stem_ids": json.loads(r[12]) if r[12] else [],
                "tuning_name": r[13] or "",
                "tuning_offsets": r[14] or "",
                "has_estd": r[0] in estd, "favorite": r[0] in favs,
            })
        # Personal layer (difficulty + tags) rides along like `favorite`, so a
        # card can badge it without a second request. Notes stay OUT of the list
        # payload (they can be long) — fetch per-song via /user-meta. Batched to
        # avoid an N+1 over the page.
        fns = [s["filename"] for s in songs]
        udm = self.user_meta_map(fns)
        tgm = self.tags_map(fns)
        # Canonical artist at display (P4): re-label the card's artist through the
        # alias override so "ACDC" reads as "AC/DC". Display-only — the row's sort
        # position (raw artist) is untouched, so a card can show a canonical name
        # that differs from its A–Z bucket for cross-letter aliases; the full
        # sort/rail reindex under aliases is the P5a materialization pass.
        amap = self.alias_map()
        for s in songs:
            s["user_difficulty"] = udm.get(s["filename"])
            s["tags"] = tgm.get(s["filename"], [])
            if amap:
                s["artist"] = amap.get((s.get("artist") or "").lower(), s.get("artist"))
        # Grouped rows carry the ⚑ N (chart_count) + the work_key from the
        # materialized read-model, so the card can render the "N charts" chip and
        # address the Charts drawer (GET /api/work/{work_key}/charts) without a
        # second request — plus `is_split` (P5e) so the ⋮ menu can offer the
        # "Rejoin other versions" undo on a split-out chart.
        if group and fns:
            ph = ",".join("?" * len(fns))
            wd = {r[0]: (r[1], r[2], r[3]) for r in self.conn.execute(
                "SELECT filename, group_size, work_key, effective_work_key "
                f"FROM work_display WHERE filename IN ({ph})", fns).fetchall()}
            splits = {r[0] for r in self.conn.execute(
                f"SELECT filename FROM chart_group_split WHERE filename IN ({ph})", fns).fetchall()}
            eff_by_fn = {}
            for s in songs:
                gs, wk, eff = wd.get(s["filename"], (1, None, None))
                s["chart_count"] = gs
                s["work_key"] = wk
                s["is_split"] = s["filename"] in splits
                if eff:
                    eff_by_fn[s["filename"]] = eff
            if ifrag:
                self._attach_display_charts(songs, eff_by_fn, ifrag, iparams)
        return songs, total

    def _attach_display_charts(self, songs: list[dict], eff_by_fn: dict,
                               intrinsic_frag: str, intrinsic_params: list) -> None:
        """§7.1: when chart-intrinsic filters admit a work through a member the
        REPRESENTATIVE doesn't itself satisfy, the card 'switches its displayed
        chart to a matching one'. The row (sort keys, cursor identity, the
        mastery/favorite anchor) stays the representative's — only the
        display/play facts ride along under `display_chart`, so keyset paging
        and the practice-state anchor are untouched. `intrinsic_frag`/`params`
        are the member-aliased ('m') predicates already built by the caller."""
        keys = sorted(set(eff_by_fn.values()))
        if not keys:
            return
        ph = ",".join("?" * len(keys))
        rows = self.conn.execute(
            "SELECT mw.effective_work_key, m.filename, m.title, m.duration, m.tuning, "
            "m.arrangements, m.has_lyrics, m.mtime, m.format, m.stem_count, m.stem_ids, "
            "m.tuning_name, m.tuning_offsets "
            "FROM songs m JOIN work_display mw ON mw.filename = m.filename "
            f"WHERE mw.effective_work_key IN ({ph}){intrinsic_frag} "
            "ORDER BY mw.is_group_representative DESC, m.mtime DESC, m.filename",
            keys + list(intrinsic_params)).fetchall()
        best: dict = {}
        for r in rows:
            best.setdefault(r[0], r)   # rep-first, then newest — one match per work
        for s in songs:
            m = best.get(eff_by_fn.get(s["filename"]))
            if not m or m[1] == s["filename"]:
                continue   # the representative itself matches (or nothing does)
            s["display_chart"] = {
                "filename": m[1], "title": m[2] or m[1], "duration": m[3],
                "tuning": m[4],
                "arrangements": _ensure_smart_names(json.loads(m[5]) if m[5] else []),
                "has_lyrics": bool(m[6]), "mtime": m[7],
                "format": m[8] or "archive",
                "stem_count": int(m[9] or 0),
                "stem_ids": json.loads(m[10]) if m[10] else [],
                "tuning_name": m[11] or "", "tuning_offsets": m[12] or "",
            }

    def query_artists(self, letter: str = "", q: str = "",
                      favorites_only: bool = False,
                      page: int = 0, size: int = 50,
                      format_filter: str = "",
                      artist_filter: str = "",
                      album_filter: str = "",
                      arrangements_has: list[str] | None = None,
                      arrangements_lacks: list[str] | None = None,
                      stems_has: list[str] | None = None,
                      stems_lacks: list[str] | None = None,
                      has_lyrics: int | None = None,
                      tunings: list[str] | None = None,
                      naming_mode: str = "legacy") -> tuple[list[dict], int]:
        """Get artists grouped by letter with their albums and songs. Returns (artists, total_artists)."""
        where, params = self._build_where(
            q=q, favorites_only=favorites_only, format_filter=format_filter,
            artist_filter=artist_filter, album_filter=album_filter,
            arrangements_has=arrangements_has, arrangements_lacks=arrangements_lacks,
            stems_has=stems_has, stems_lacks=stems_lacks,
            has_lyrics=has_lyrics, tunings=tunings, naming_mode=naming_mode,
        )
        # Canonicalize artists at display when aliases exist (P4): dedupe / group /
        # letter / order on the EFFECTIVE artist so "ACDC" + "AC/DC" list as one
        # entry. With no aliases, `art_expr` stays the plain (indexed) `artist`
        # column, so the common case pays zero subquery cost.
        has_aliases = self.conn.execute("SELECT 1 FROM artist_alias LIMIT 1").fetchone() is not None
        art_expr = self._EFFECTIVE_ARTIST_SQL if has_aliases else "artist"

        if letter == "#":
            where += f" AND ({art_expr}) NOT GLOB '[A-Za-z]*'"
        elif letter:
            where += f" AND UPPER(SUBSTR(({art_expr}), 1, 1)) = ?"
            params.append(letter.upper())

        # Get paginated distinct (effective) artists
        total_artists = self.conn.execute(
            f"SELECT COUNT(DISTINCT ({art_expr}) COLLATE NOCASE) FROM songs {where}", params
        ).fetchone()[0]

        artist_rows = self.conn.execute(
            f"SELECT DISTINCT ({art_expr}) COLLATE NOCASE as a FROM songs {where} ORDER BY a LIMIT ? OFFSET ?",
            params + [size, page * size]
        ).fetchall()
        artist_names = [r[0] for r in artist_rows]

        if not artist_names:
            return [], total_artists

        # Fetch songs for these (effective) artists only
        placeholders = ",".join(["?"] * len(artist_names))
        song_where = f"{where} AND ({art_expr}) COLLATE NOCASE IN ({placeholders})"
        song_params = params + artist_names

        rows = self.conn.execute(
            f"SELECT filename, title, ({art_expr}) as artist, album, year, duration, tuning, arrangements, has_lyrics, "
            f"format, stem_count, stem_ids, tuning_name "
            f"FROM songs {song_where} ORDER BY ({art_expr}) COLLATE NOCASE, album COLLATE NOCASE, title COLLATE NOCASE",
            song_params
        ).fetchall()

        # Group into artist -> album -> songs
        from collections import OrderedDict
        estd = self._estd_set()
        favs = self.favorite_set()
        artists = OrderedDict()
        for r in rows:
            artist = r[2] or "Unknown Artist"
            album = r[3] or "Unknown Album"
            akey = artist.lower()
            if akey not in artists:
                artists[akey] = {"name": artist, "albums": OrderedDict()}
            bkey = album.lower()
            if bkey not in artists[akey]["albums"]:
                artists[akey]["albums"][bkey] = {"name": album, "songs": []}
            artists[akey]["albums"][bkey]["songs"].append({
                "filename": r[0], "title": r[1], "artist": r[2], "album": r[3],
                "year": r[4], "duration": r[5], "tuning": r[6],
                "arrangements": _ensure_smart_names(json.loads(r[7]) if r[7] else []),
                "has_lyrics": bool(r[8]),
                "format": r[9] or "archive",
                "stem_count": int(r[10] or 0),
                "stem_ids": json.loads(r[11]) if r[11] else [],
                "tuning_name": r[12] or "",
                "has_estd": r[0] in estd,
                "favorite": r[0] in favs,
            })

        # Pick most common name variant per artist/album
        result = []
        for akey, aval in artists.items():
            albums = []
            for bkey, bval in aval["albums"].items():
                albums.append({"name": bval["name"], "songs": bval["songs"]})
            result.append({"name": aval["name"], "album_count": len(albums),
                           "song_count": sum(len(a["songs"]) for a in albums), "albums": albums})
        return result, total_artists

    def query_stats(self, favorites_only: bool = False,
                    q: str = "", format_filter: str = "",
                    artist_filter: str = "",
                    album_filter: str = "",
                    arrangements_has: list[str] | None = None,
                    arrangements_lacks: list[str] | None = None,
                    stems_has: list[str] | None = None,
                    stems_lacks: list[str] | None = None,
                    has_lyrics: int | None = None,
                    tunings: list[str] | None = None,
                    sort: str = "artist",
                    want_sort_letters: bool = False,
                    group: bool = False,
                    naming_mode: str = "legacy") -> dict:
        """Aggregate stats for the letter bar. Accepts the same filter
        params as query_page so the letter counts stay synchronized
        with the grid when filters are active.

        `group` (P5a) restricts every count to one representative chart per work
        (the same predicate query_page uses), so `total_songs` and the jump-rail
        `sort_letters` count WORKS not charts and stay in lockstep with the
        grouped grid.

        `sort` selects the column the v3 jump rail's `sort_letters`
        breakdown keys on (artist for artist sorts, title for title
        sorts) so the rail's present-letters match the grid's actual
        order; other sorts fall back to artist (the rail is hidden for
        them client-side anyway). The legacy `letters` field is always
        the artist breakdown, unchanged, for the dashboard + classic tree.

        `sort_letters` is computed (and the key included) ONLY when
        `want_sort_letters` is set — the jump rail opts in, while the
        dashboard / v2 tree read only `letters` and skip the extra
        per-letter aggregate scan."""
        where, params = self._build_where(
            q=q, favorites_only=favorites_only, format_filter=format_filter,
            artist_filter=artist_filter, album_filter=album_filter,
            arrangements_has=arrangements_has, arrangements_lacks=arrangements_lacks,
            stems_has=stems_has, stems_lacks=stems_lacks,
            has_lyrics=has_lyrics, tunings=tunings, naming_mode=naming_mode,
            include_intrinsic=not group,
        )
        if group:
            # Same filter law as query_page (§7.1): chart-intrinsic predicates
            # match-if-ANY-member, applied identically here so the letter-bar
            # counts stay in lockstep with the grouped grid.
            self._ensure_work_display()
            ifrag, iparams = self._build_intrinsic_where(
                "m", format_filter=format_filter,
                arrangements_has=arrangements_has, arrangements_lacks=arrangements_lacks,
                stems_has=stems_has, stems_lacks=stems_lacks,
                has_lyrics=has_lyrics, tunings=tunings, naming_mode=naming_mode)
            mfrag, mparams = self._grouped_member_match(ifrag, iparams)
            where += mfrag
            params += mparams
            where += self._GROUP_REP_PREDICATE
        # Grouped stat counts filter through work_display (same
        # is_group_representative=1 predicate as query_page); hold self._lock
        # across these representative SELECTs so they can't observe a
        # mid-rebuild empty table (see query_page for the full rationale).
        # _ensure_work_display already rebuilt above under its own lock, so we
        # do NOT nest it here (self._lock is non-reentrant). Ungrouped reads
        # stay lock-free (WAL) via nullcontext.
        read_guard = self._lock if group else contextlib.nullcontext()
        with read_guard:
            total = self.conn.execute(f"SELECT COUNT(*) FROM songs {where}", params).fetchone()[0]
            # NOCASE collation here mirrors `query_artists` and the per-
            # letter `COUNT(DISTINCT artist COLLATE NOCASE)` below — without
            # it, an artist stored under two different casings would inflate
            # `total_artists` against the letter-bar breakdown the UI
            # renders next to it.
            artist_count = self.conn.execute(
                f"SELECT COUNT(DISTINCT artist COLLATE NOCASE) FROM songs {where}", params
            ).fetchone()[0]
            rows = self.conn.execute(
                f"SELECT UPPER(SUBSTR(artist, 1, 1)) as letter, COUNT(DISTINCT artist COLLATE NOCASE) "
                f"FROM songs {where} GROUP BY letter", params
            ).fetchall()
        letters = {}
        for letter, count in rows:
            count = int(count or 0)
            if count <= 0:
                continue
            key = str(letter or "")
            if key.isascii() and key.isalpha():
                letters[key] = letters.get(key, 0) + count
            else:
                letters["#"] = letters.get("#", 0) + count
        result = {"total_songs": total, "total_artists": artist_count, "letters": letters}
        # Active-sort letter buckets for the v3 jump rail. Counts SONGS (the
        # grid's unit, unlike `letters` which counts distinct artists) per
        # first-letter bucket of the column the active sort keys on, so a tap
        # on a present letter always finds a card. Non-A–Z first chars bucket
        # under '#'. Only artist/title sorts are alphabetical; anything else
        # keys on artist here but the client hides the rail for it. Computed
        # only when the caller opts in, so non-rail callers skip the scan.
        if want_sort_letters:
            sort_col = "title" if sort in ("title", "title-desc") else "artist"
            # Same representative-SELECT lock guard as the counts above.
            with read_guard:
                sort_rows = self.conn.execute(
                    f"SELECT UPPER(SUBSTR(COALESCE({sort_col}, ''), 1, 1)) AS letter, COUNT(*) "
                    f"FROM songs {where} GROUP BY letter", params
                ).fetchall()
            sort_letters: dict[str, int] = {}
            for letter, count in sort_rows:
                count = int(count or 0)
                if count <= 0:
                    continue
                key = str(letter or "")
                bucket = key if (key.isascii() and key.isalpha()) else "#"
                sort_letters[bucket] = sort_letters.get(bucket, 0) + count
            result["sort_letters"] = sort_letters
        return result


class AudioEffectsMappingDB:
    """Core-owned public song/tone -> provider mapping index.

    Providers own the preset/chain rows addressed by provider_ref. Core owns
    the cross-provider routing index and the active mapping per song/tone.
    """

    def __init__(self):
        CONFIG_DIR.mkdir(parents=True, exist_ok=True)
        self.db_path = str(CONFIG_DIR / "audio_effects.db")
        self.conn = sqlite3.connect(self.db_path, check_same_thread=False)
        self.conn.execute("PRAGMA journal_mode=WAL")
        self.conn.execute("PRAGMA foreign_keys=ON")
        self.conn.execute("""
            CREATE TABLE IF NOT EXISTS audio_effect_mappings (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                song_key TEXT NOT NULL,
                filename TEXT NOT NULL DEFAULT '',
                tone_key TEXT NOT NULL,
                provider_id TEXT NOT NULL,
                provider_ref TEXT NOT NULL,
                label TEXT NOT NULL DEFAULT '',
                source TEXT NOT NULL DEFAULT 'manual',
                metadata_json TEXT NOT NULL DEFAULT '{}',
                created_at TEXT NOT NULL DEFAULT (datetime('now')),
                updated_at TEXT NOT NULL DEFAULT (datetime('now')),
                UNIQUE(song_key, tone_key, provider_id)
            )
        """)
        self.conn.execute("""
            CREATE TABLE IF NOT EXISTS audio_effect_active_mappings (
                song_key TEXT NOT NULL,
                tone_key TEXT NOT NULL,
                mapping_id INTEGER NOT NULL,
                updated_at TEXT NOT NULL DEFAULT (datetime('now')),
                PRIMARY KEY (song_key, tone_key),
                FOREIGN KEY (mapping_id) REFERENCES audio_effect_mappings(id) ON DELETE CASCADE
            )
        """)
        self.conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_audio_effect_mappings_provider "
            "ON audio_effect_mappings(provider_id)"
        )
        self.conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_audio_effect_mappings_filename "
            "ON audio_effect_mappings(filename)"
        )
        self.conn.commit()
        self._lock = threading.Lock()

    @staticmethod
    def _text(value, *, field: str, limit: int, allow_empty: bool = False) -> str:
        if value is None:
            text = ""
        elif not isinstance(value, str):
            raise ValueError(f"{field} must be a string")
        else:
            text = value.strip()
        if not text and not allow_empty:
            raise ValueError(f"{field} is required")
        if len(text) > limit:
            raise ValueError(f"{field} is too long")
        return text

    @staticmethod
    def _mapping_id(value) -> int | None:
        # Bind only values SQLite can store as an INTEGER; an out-of-range id is a
        # clean miss (404), not a 500 at bind time.
        if isinstance(value, int) and not isinstance(value, bool) and -(2 ** 63) <= value < 2 ** 63:
            return value
        return None

    @staticmethod
    def _field(data: dict, *keys):
        # Select the first present snake/camel alias by key, not by truthiness, so a
        # falsey non-string value (false/0) still reaches _text() and is rejected
        # instead of being silently swallowed by an `or` chain.
        for key in keys:
            if key in data:
                return data[key]
        return None

    @staticmethod
    def _metadata(value) -> str:
        if value is None:
            return "{}"
        if not isinstance(value, dict):
            raise ValueError("metadata must be an object")
        encoded = json.dumps(value, ensure_ascii=True, sort_keys=True)
        if len(encoded) > 8192:
            raise ValueError("metadata is too large")
        return encoded

    @staticmethod
    def _row(row) -> dict | None:
        if row is None:
            return None
        metadata = {}
        try:
            metadata = json.loads(row[8]) if row[8] else {}
        except Exception:
            metadata = {}
        return {
            "id": int(row[0]),
            "song_key": row[1],
            "filename": row[2] or "",
            "tone_key": row[3],
            "provider_id": row[4],
            "provider_ref": row[5],
            "label": row[6] or "",
            "source": row[7] or "manual",
            "metadata": metadata if isinstance(metadata, dict) else {},
            "created_at": row[9] or "",
            "updated_at": row[10] or "",
            "active": bool(row[11]),
        }

    def _select_sql(self) -> str:
        return """
            SELECT m.id, m.song_key, m.filename, m.tone_key, m.provider_id,
                   m.provider_ref, m.label, m.source, m.metadata_json,
                   m.created_at, m.updated_at,
                   CASE WHEN a.mapping_id IS NULL THEN 0 ELSE 1 END AS active
            FROM audio_effect_mappings m
            LEFT JOIN audio_effect_active_mappings a
              ON a.song_key = m.song_key AND a.tone_key = m.tone_key AND a.mapping_id = m.id
        """

    def list(self, *, song_key: str = "", filename: str = "", tone_key: str = "", provider_id: str = "") -> list[dict]:
        clauses: list[str] = []
        params: list[str] = []
        song_key = self._text(song_key, field="song_key", limit=240, allow_empty=True)
        filename = self._text(filename, field="filename", limit=500, allow_empty=True)
        tone_key = self._text(tone_key, field="tone_key", limit=160, allow_empty=True)
        provider_id = self._text(provider_id, field="provider_id", limit=96, allow_empty=True)
        if song_key and filename:
            clauses.append("(m.song_key = ? OR m.filename = ?)")
            params.extend([song_key, filename])
        elif song_key:
            clauses.append("m.song_key = ?")
            params.append(song_key)
        elif filename:
            clauses.append("(m.song_key = ? OR m.filename = ?)")
            params.extend([filename, filename])
        if tone_key:
            clauses.append("m.tone_key = ?")
            params.append(tone_key)
        if provider_id:
            clauses.append("m.provider_id = ?")
            params.append(provider_id)
        sql = self._select_sql()
        if clauses:
            sql += " WHERE " + " AND ".join(clauses)
        sql += " ORDER BY m.song_key COLLATE NOCASE, m.tone_key COLLATE NOCASE, m.provider_id COLLATE NOCASE"
        with self._lock:
            rows = self.conn.execute(sql, params).fetchall()
        return [self._row(row) for row in rows]

    def get(self, mapping_id: int) -> dict | None:
        mapping_id = self._mapping_id(mapping_id)
        if mapping_id is None:
            return None
        with self._lock:
            row = self.conn.execute(self._select_sql() + " WHERE m.id = ?", (mapping_id,)).fetchone()
        return self._row(row)

    def upsert(self, data: dict) -> dict:
        if not isinstance(data, dict):
            raise ValueError("mapping body must be an object")
        filename = self._text(data.get("filename", ""), field="filename", limit=500, allow_empty=True)
        song_key_raw = self._field(data, "song_key", "songKey")
        if song_key_raw is None or song_key_raw == "":
            song_key_raw = filename
        song_key = self._text(song_key_raw, field="song_key", limit=240)
        tone_key = self._text(self._field(data, "tone_key", "toneKey"), field="tone_key", limit=160, allow_empty=True)
        provider_id = self._text(self._field(data, "provider_id", "providerId"), field="provider_id", limit=96)
        provider_ref = self._text(self._field(data, "provider_ref", "providerRef"), field="provider_ref", limit=240)
        label = self._text(data.get("label", ""), field="label", limit=160, allow_empty=True)
        source = self._text(data.get("source", "manual"), field="source", limit=40, allow_empty=True) or "manual"
        metadata_json = self._metadata(data.get("metadata", {}))
        with self._lock:
            self.conn.execute(
                """
                INSERT INTO audio_effect_mappings
                    (song_key, filename, tone_key, provider_id, provider_ref, label, source, metadata_json, updated_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
                ON CONFLICT(song_key, tone_key, provider_id) DO UPDATE SET
                    -- Only overwrite filename when a non-empty one was supplied; an
                    -- omitted/empty filename must preserve the stored value (it's an
                    -- alternate lookup key for list(..., filename=...)).
                    filename=CASE WHEN excluded.filename <> '' THEN excluded.filename ELSE audio_effect_mappings.filename END,
                    provider_ref=excluded.provider_ref,
                    label=excluded.label,
                    source=excluded.source,
                    metadata_json=excluded.metadata_json,
                    updated_at=datetime('now')
                """,
                (song_key, filename, tone_key, provider_id, provider_ref, label, source, metadata_json),
            )
            row = self.conn.execute(
                "SELECT id FROM audio_effect_mappings WHERE song_key = ? AND tone_key = ? AND provider_id = ?",
                (song_key, tone_key, provider_id),
            ).fetchone()
            if row is None:
                raise ValueError("failed to create audio-effects mapping")
            mapping_id = int(row[0])
            if data.get("active") is True:
                self.conn.execute(
                    """
                    INSERT INTO audio_effect_active_mappings (song_key, tone_key, mapping_id, updated_at)
                    VALUES (?, ?, ?, datetime('now'))
                    ON CONFLICT(song_key, tone_key) DO UPDATE SET
                        mapping_id=excluded.mapping_id,
                        updated_at=datetime('now')
                    """,
                    (song_key, tone_key, mapping_id),
                )
            self.conn.commit()
        return self.get(mapping_id)

    def delete(self, mapping_id: int, *, provider_id: str = "") -> bool:
        mapping_id = self._mapping_id(mapping_id)
        if mapping_id is None:
            return False
        provider_id = self._text(provider_id, field="provider_id", limit=96, allow_empty=True)
        with self._lock:
            if provider_id:
                cur = self.conn.execute(
                    "DELETE FROM audio_effect_mappings WHERE id = ? AND provider_id = ?",
                    (mapping_id, provider_id),
                )
            else:
                cur = self.conn.execute("DELETE FROM audio_effect_mappings WHERE id = ?", (mapping_id,))
            self.conn.commit()
            return cur.rowcount > 0

    def activate(self, mapping_id: int, *, provider_id: str = "") -> dict | None:
        mapping_id = self._mapping_id(mapping_id)
        if mapping_id is None:
            return None
        provider_id = self._text(provider_id, field="provider_id", limit=96, allow_empty=True)
        with self._lock:
            row = self.conn.execute(
                self._select_sql() + " WHERE m.id = ?",
                (mapping_id,),
            ).fetchone()
            mapping = self._row(row)
            if not mapping or (provider_id and mapping["provider_id"] != provider_id):
                return None
            self.conn.execute(
                """
                INSERT INTO audio_effect_active_mappings (song_key, tone_key, mapping_id, updated_at)
                VALUES (?, ?, ?, datetime('now'))
                ON CONFLICT(song_key, tone_key) DO UPDATE SET
                    mapping_id=excluded.mapping_id,
                    updated_at=datetime('now')
                """,
                (mapping["song_key"], mapping["tone_key"], mapping_id),
            )
            self.conn.commit()
            selected = self.conn.execute(self._select_sql() + " WHERE m.id = ?", (mapping_id,)).fetchone()
        return self._row(selected)

    def clear_active(self, *, song_key: str, tone_key: str) -> bool:
        song_key = self._text(song_key, field="song_key", limit=240)
        tone_key = self._text(tone_key, field="tone_key", limit=160, allow_empty=True)
        with self._lock:
            cur = self.conn.execute(
                "DELETE FROM audio_effect_active_mappings WHERE song_key = ? AND tone_key = ?",
                (song_key, tone_key),
            )
            self.conn.commit()
            return cur.rowcount > 0


meta_db = MetadataDB()
audio_effect_mappings = AudioEffectsMappingDB()


class LocalLibraryProvider:
    id = "local"
    label = "My Library"
    kind = "local"
    capabilities = (
        "library.read",
        "art.read",
        "song.play",
        "favorite.write",
        "metadata.write",
    )

    def __init__(self, db: MetadataDB):
        self._db = db

    def query_page(self, **kwargs) -> tuple[list[dict], int]:
        return self._db.query_page(**kwargs)

    def query_artists(self, **kwargs) -> tuple[list[dict], int]:
        return self._db.query_artists(**kwargs)

    def query_stats(self, **kwargs) -> dict:
        return self._db.query_stats(**kwargs)

    def tuning_names(self) -> dict:
        # Group custom tunings on their raw offsets so distinct ones stay
        # distinct (tuning_name collapses them all to "Custom Tuning"); named
        # tunings keep grouping by name (stable across the rescan boundary, no
        # offsets/name split). `key` is the value the client sends back as the
        # filter selector — equal to the name for named tunings, the offsets
        # string for customs; offsets also feed the client's custom-pill label.
        with self._db._lock:
            rows = self._db.conn.execute(
                f"SELECT tuning_name, {_TUNING_GROUP_KEY_SQL} AS gkey, "
                "MIN(tuning_sort_key), COUNT(*), MIN(tuning_offsets) "
                "FROM songs WHERE title != '' AND COALESCE(tuning_name, '') != '' "
                "GROUP BY gkey COLLATE NOCASE "
                "ORDER BY ABS(COALESCE(MIN(tuning_sort_key), 0)), "
                "COALESCE(MIN(tuning_sort_key), 0) ASC, "
                "tuning_name COLLATE NOCASE"
            ).fetchall()
        return {
            "tunings": [
                {"name": name, "key": gkey, "offsets": offs or "",
                 "sort_key": int(sk or 0), "count": count}
                for name, gkey, sk, count, offs in rows
            ],
        }

    async def get_art(self, song_id: str):
        return await get_song_art(song_id)


class LibraryProviderRegistry:
    # Methods required per declared capability — only validated when the
    # provider advertises the corresponding capability so action-only providers
    # (e.g. art.read + song.sync without library.read) don't need to implement
    # unused stubs.
    _CAPABILITY_METHODS: ClassVar[dict[str, tuple[str, ...]]] = {
        "library.read": ("query_page", "query_artists", "query_stats", "tuning_names"),
        "art.read": ("get_art",),
        "song.sync": ("sync_song",),
    }
    _ID_RE: ClassVar[re.Pattern[str]] = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$")

    def __init__(self):
        self._providers: dict[str, object] = {}
        # Capabilities inferred at registration for legacy providers that omit
        # the `capabilities` field.  Merged with provider_capabilities() so that
        # runtime capability checks see the complete effective capability set.
        self._inferred_caps: dict[str, set[str]] = {}
        self._owner_plugin_ids: dict[str, str] = {}
        self._lock = threading.RLock()

    def register(self, provider: object, *, replace: bool = False, owner_plugin_id: str | None = None) -> object:
        provider_id = self.provider_id(provider)
        if not self._ID_RE.match(provider_id):
            raise ValueError(
                "library provider id must start with an alphanumeric character "
                "and contain only letters, digits, _, ., :, or -"
            )
        if not self.provider_label(provider):
            raise ValueError("library provider label must be a non-empty string")
        # Use declared-only caps during validation — never include stale inferred
        # caps from a previous provider registered under the same id (replace=True).
        caps = self._declared_capabilities(provider)
        # Backward compatibility: providers that predate explicit capability
        # declarations may omit `capabilities` entirely. If the browse methods
        # are all present, infer `library.read` so they still work unchanged.
        # If capabilities are absent but the browse surface is also absent,
        # raise a clear error rather than letting the provider register and
        # then fail on every API call with a late 501.
        inferred: set[str] = set()
        if not caps:
            browse_methods = self._CAPABILITY_METHODS["library.read"]
            if all(callable(self.provider_method(provider, m)) for m in browse_methods):
                # Legacy provider without explicit capabilities — infer library.read
                # from the presence of all browse methods.  Store in _inferred_caps
                # so that runtime capability checks see the full effective set.
                inferred = {"library.read"}
                caps = inferred
            else:
                raise TypeError(
                    f"library provider {provider_id!r} must declare at least one capability "
                    f"(or implement the {browse_methods!r} browse methods for backward compatibility)"
                )
        for cap, methods in self._CAPABILITY_METHODS.items():
            if cap not in caps:
                continue
            for method_name in methods:
                if not callable(self.provider_method(provider, method_name)):
                    raise TypeError(f"library provider {provider_id!r} declares {cap!r} but is missing callable {method_name}()")
        with self._lock:
            if provider_id == "local" and provider_id in self._providers and self._providers[provider_id] is not provider:
                raise ValueError("the local library provider cannot be replaced")
            if provider_id in self._providers and not replace:
                raise ValueError(f"library provider {provider_id!r} is already registered")
            self._providers[provider_id] = provider
            # owner_plugin_id is attribution that flows into the browser
            # capability participant id. The scoped register_library_provider
            # wrappers force it to the trusted loading plugin id, so the spoof
            # vector is closed there. Here we only normalize: trim and require a
            # non-empty string. We deliberately do NOT apply the provider-id
            # grammar (_ID_RE) — plugin ids aren't constrained to it at load
            # time, so that would silently drop attribution for valid plugins.
            owner = owner_plugin_id.strip() if isinstance(owner_plugin_id, str) else ""
            owner = owner or None
            if owner:
                self._owner_plugin_ids[provider_id] = owner
            else:
                self._owner_plugin_ids.pop(provider_id, None)
            if inferred:
                self._inferred_caps[provider_id] = inferred
            else:
                self._inferred_caps.pop(provider_id, None)
        return provider

    def unregister(self, provider_id: str) -> bool:
        if provider_id == "local":
            raise ValueError("the local library provider cannot be unregistered")
        with self._lock:
            self._inferred_caps.pop(provider_id, None)
            self._owner_plugin_ids.pop(provider_id, None)
            return self._providers.pop(provider_id, None) is not None

    def get(self, provider_id: str = "local") -> object | None:
        with self._lock:
            return self._providers.get(provider_id or "local")

    def list(self) -> list[dict]:
        with self._lock:
            providers = list(self._providers.values())
        return [self.describe(provider) for provider in providers]

    def describe(self, provider: object) -> dict:
        provider_id = self.provider_id(provider)
        with self._lock:
            owner_plugin_id = self._owner_plugin_ids.get(provider_id)
        return {
            "id": provider_id,
            "label": self.provider_label(provider),
            "kind": self.provider_field(provider, "kind", "local" if provider_id == "local" else "remote"),
            "capabilities": sorted(self.provider_capabilities(provider)),
            "owner_plugin_id": owner_plugin_id,
            "default": provider_id == "local",
        }

    def provider_field(self, provider: object, name: str, default=None):
        if isinstance(provider, dict):
            return provider.get(name, default)
        return getattr(provider, name, default)

    def provider_id(self, provider: object) -> str:
        provider_id = self.provider_field(provider, "id", "")
        if not isinstance(provider_id, str) or not provider_id:
            raise ValueError("library provider id must be a non-empty string")
        return provider_id

    def provider_label(self, provider: object) -> str:
        label = self.provider_field(provider, "label", self.provider_field(provider, "name", ""))
        if not isinstance(label, str):
            return ""
        return label.strip()

    def _declared_capabilities(self, provider: object) -> set[str]:
        """Return only the capabilities explicitly declared on the provider object."""
        raw = self.provider_field(provider, "capabilities", ())
        if raw is None:
            raw = ()
        if isinstance(raw, str):
            raw = (raw,) if raw else ()
        return {str(cap) for cap in raw if cap}

    def provider_capabilities(self, provider: object) -> set[str]:
        # Guard against a common plugin authoring mistake: passing a single string
        # instead of a list/tuple. Iterating a string produces individual characters,
        # none of which would match a valid capability name.
        declared = self._declared_capabilities(provider)
        # Merge with any capabilities inferred at registration time for legacy
        # providers that omit the `capabilities` field but implement browse methods.
        provider_id = self.provider_id(provider)
        with self._lock:
            inferred = self._inferred_caps.get(provider_id, set())
        return declared | inferred

    def provider_method(self, provider: object, name: str):
        if isinstance(provider, dict):
            return provider.get(name)
        return getattr(provider, name, None)


library_providers = LibraryProviderRegistry()
_local_library_provider = LocalLibraryProvider(meta_db)
library_providers.register(_local_library_provider)


# Keys `_library_filter_args` (and a smart collection's stored `rules`) accept.
_LIBRARY_FILTER_PARAM_KEYS = frozenset((
    "q", "favorites", "format", "artist", "album",
    "arrangements_has", "arrangements_lacks", "stems_has", "stems_lacks",
    "has_lyrics", "tunings",
))
# Rules mirror the raw /api/library query params (so the provider can feed them
# straight through `_library_filter_args`, and the frontend can build a rule from
# the same query string it already constructs). Multi-value filters are CSV
# strings; `favorites` is 0/1; the rest are plain strings.
_RULE_CSV_KEYS = frozenset((
    "tunings", "arrangements_has", "arrangements_lacks", "stems_has", "stems_lacks",
))
_RULE_STR_KEYS = frozenset(("q", "format", "artist", "album", "has_lyrics", "sort"))


def _sanitize_collection_rules(raw) -> dict:
    """Normalize rules to the raw query-param format, keeping only known keys. A
    list for a multi-value filter is joined to CSV; `favorites` becomes 0/1.
    Unknown keys are dropped so a rule survives a filter-vocab change rather than
    500-ing. Applied at API ingress AND when a provider loads a persisted row, so
    a hand-edited / imported bad value (e.g. an int where a string is expected,
    or a list for `sort`) can never crash a query."""
    if not isinstance(raw, dict):
        return {}
    out: dict = {}
    for k, v in raw.items():
        if k in _RULE_CSV_KEYS:
            if isinstance(v, list):
                vals = [str(x) for x in v if isinstance(x, (str, int)) and not isinstance(x, bool)]
            elif isinstance(v, str):
                vals = [s for s in (p.strip() for p in v.split(",")) if s]
            else:
                continue
            if vals:
                out[k] = ",".join(vals)
        elif k == "favorites":
            if v:
                out[k] = 1
        elif k in _RULE_STR_KEYS:
            if isinstance(v, (str, int)) and not isinstance(v, bool):
                s = str(v).strip()
                if s:
                    out[k] = s
    return out


class SmartCollectionProvider:
    """A saved library filter, surfaced as a source (#636 item 2). Browse/stats
    delegate to the local DB with the collection's stored `rules` applied — so
    selecting it in the v3 source picker shows exactly that filtered slice with
    the whole Songs UI (paging, stats, A–Z rail, art) for free. P1: the rules
    ARE the query (live in-collection search is a P2 nicety). The matched songs
    are local rows, so `kind="local"` keeps the client's play/art paths on the
    local (not remote-sync) branch and art delegates straight through."""
    kind = "local"
    capabilities = ("library.read", "art.read")

    def __init__(self, collection: dict, local: "LocalLibraryProvider"):
        self._local = local
        self.update(collection)

    def update(self, collection: dict) -> None:
        self.id = f"collection:{collection['id']}"
        self.collection_id = collection["id"]
        self.label = collection.get("name") or "Collection"
        # Re-sanitize on load: persisted JSON may predate the current vocab or
        # have been hand-edited; never let a bad value reach a query.
        self._rules = _sanitize_collection_rules(collection.get("rules") or {})

    def _filter_kwargs(self) -> dict:
        return _library_filter_args(**{k: v for k, v in self._rules.items()
                                       if k in _LIBRARY_FILTER_PARAM_KEYS})

    def _sort(self, fallback: str) -> str:
        # A collection may pin its own sort (e.g. "recently added"); query_page
        # falls back safely for an unknown value, so no validation needed here.
        return self._rules.get("sort") or fallback

    def query_page(self, *, page=0, size=24, sort="artist", direction="asc",
                   naming_mode="legacy", **_ignore):
        return self._local._db.query_page(
            page=page, size=size, sort=self._sort(sort), direction=direction,
            naming_mode=naming_mode, **self._filter_kwargs())

    def query_artists(self, *, letter="", page=0, size=50, naming_mode="legacy", **_ignore):
        return self._local._db.query_artists(
            letter=letter, page=page, size=size, naming_mode=naming_mode,
            **self._filter_kwargs())

    def query_stats(self, *, sort="artist", want_sort_letters=False,
                    naming_mode="legacy", **_ignore):
        return self._local._db.query_stats(
            sort=self._sort(sort), want_sort_letters=want_sort_letters,
            naming_mode=naming_mode, **self._filter_kwargs())

    def tuning_names(self):
        return self._local.tuning_names()

    async def get_art(self, song_id: str):
        return await self._local.get_art(song_id)


def _sync_collection_provider(collection: dict) -> None:
    """Register (or replace) the provider for one collection."""
    library_providers.register(
        SmartCollectionProvider(collection, _local_library_provider), replace=True)


def _unregister_collection_provider(pid: int) -> None:
    library_providers.unregister(f"collection:{pid}")


# Boot scan: surface every saved collection as a source.
for _c in meta_db.list_collections():
    _sync_collection_provider(_c)


def register_library_provider(provider: object, *, replace: bool = False, owner_plugin_id: str | None = None) -> object:
    return library_providers.register(provider, replace=replace, owner_plugin_id=owner_plugin_id)


def unregister_library_provider(provider_id: str) -> bool:
    return library_providers.unregister(provider_id)


class TuningProviderRegistry:
    """Registry for plugins that contribute custom tunings to the core tuning.read capability."""

    _ID_RE: ClassVar[re.Pattern[str]] = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$")

    def __init__(self) -> None:
        self._providers: dict[str, callable] = {}
        self._lock = threading.Lock()

    def register(self, provider_id: str, get_tunings: callable) -> None:
        if not self._ID_RE.match(provider_id):
            raise ValueError(f"tuning provider id {provider_id!r} contains invalid characters")
        if not callable(get_tunings):
            raise TypeError("get_tunings must be callable")
        with self._lock:
            self._providers[provider_id] = get_tunings

    def unregister(self, provider_id: str) -> None:
        with self._lock:
            self._providers.pop(provider_id, None)

    def get_merged(self, reference_pitch: float = DEFAULT_REFERENCE_PITCH) -> dict:
        """DEFAULT_TUNINGS scaled to reference_pitch, merged with all provider contributions."""
        result: dict[str, dict[str, list[float]]] = apply_reference_pitch(DEFAULT_TUNINGS, reference_pitch)
        scale = reference_pitch / DEFAULT_REFERENCE_PITCH
        with self._lock:
            providers = list(self._providers.items())
        for provider_id, get_tunings in providers:
            try:
                extra = get_tunings() or {}
                for instrument, names in extra.items():
                    if instrument not in result:
                        result[instrument] = {}
                    for name, freqs in names.items():
                        result[instrument][name] = [round(f * scale, 4) for f in freqs]
            except Exception:
                logger.exception("tuning provider %r raised during get_merged()", provider_id)
        return result


tuning_providers = TuningProviderRegistry()


def register_tuning_provider(provider_id: str, get_tunings: callable) -> None:
    tuning_providers.register(provider_id, get_tunings)


def unregister_tuning_provider(provider_id: str) -> None:
    tuning_providers.unregister(provider_id)


def _get_library_provider(provider: str = "local") -> object:
    library_provider = library_providers.get(provider or "local")
    if library_provider is None:
        raise HTTPException(status_code=404, detail=f"Unknown library provider: {provider}")
    return library_provider


def _require_library_provider_capability(provider: object, capability: str) -> None:
    if capability in library_providers.provider_capabilities(provider):
        return
    provider_id = library_providers.provider_id(provider)
    raise HTTPException(
        status_code=501,
        detail=f"Library provider {provider_id!r} does not declare capability {capability!r}",
    )


_OPTIONAL_NEW_PROVIDER_KWARGS = ("naming_mode", "sort", "want_sort_letters", "after")


def _filter_provider_kwargs(method: object, kwargs: dict) -> dict:
    """Drop kwargs that the method's signature does not declare.

    Provides backward-compat for third-party library providers whose
    query_page/query_artists/query_stats methods were written before
    naming_mode was added — calling them with the extra kwarg would
    raise TypeError and return a 500 to the client.

    When ``inspect.signature`` cannot introspect the method (rare: C
    extensions / built-ins / exotic callables), fall back to stripping
    only the kwargs we know were added later — older providers won't
    accept them, anything else stays so the call still works.
    """
    try:
        sig = inspect.signature(method)  # type: ignore[arg-type]
        for p in sig.parameters.values():
            if p.kind == inspect.Parameter.VAR_KEYWORD:
                return kwargs  # method accepts **kwargs, pass everything
        return {k: v for k, v in kwargs.items() if k in sig.parameters}
    except (ValueError, TypeError):
        return {k: v for k, v in kwargs.items() if k not in _OPTIONAL_NEW_PROVIDER_KWARGS}


def _call_library_provider(provider: object, method_name: str, **kwargs) -> Any:
    method = library_providers.provider_method(provider, method_name)
    if not callable(method):
        provider_id = library_providers.provider_id(provider)
        raise HTTPException(
            status_code=501,
            detail=f"Library provider {provider_id!r} does not support {method_name}",
        )
    try:
        return method(**_filter_provider_kwargs(method, kwargs))
    except HTTPException:
        raise
    except Exception as exc:
        provider_id = library_providers.provider_id(provider)
        # A provider with an explicit kind="local" is treated as local even if
        # its id is not "local" (e.g. a kind="local" plugin variant). Otherwise
        # fall back to provider_id comparison so providers that omit `kind` are
        # still wrapped correctly — the safe default for unknown providers is to
        # surface an offline message rather than leaking raw exceptions.
        provider_kind = str(library_providers.provider_field(provider, "kind", "") or "")
        if provider_kind:
            is_remote = provider_kind not in ("", "local")
        else:
            is_remote = provider_id != "local"
        if is_remote:
            detail = f"This source appears to be offline ({provider_id})."
            message = str(exc).strip()
            if message:
                detail = f"{detail} {message}"
            raise HTTPException(status_code=503, detail=detail) from exc
        raise


def _is_async_callable(obj: object) -> bool:
    """Return True if obj is an async function or a callable object with an async __call__.

    ``inspect.iscoroutinefunction`` only recognises bare coroutine functions; it returns
    False for class instances whose ``__call__`` method is defined as ``async def``.
    Checking both handles the common plugin pattern of wrapping an async method in a
    callable object.
    """
    if inspect.iscoroutinefunction(obj):
        return True
    _call = getattr(obj, "__call__", None)
    return _call is not None and inspect.iscoroutinefunction(_call)


async def _call_library_provider_async(provider: object, method_name: str, **kwargs) -> Any:
    method = library_providers.provider_method(provider, method_name)
    if _is_async_callable(method):
        # Async provider method — call directly on the event loop.
        try:
            return await method(**_filter_provider_kwargs(method, kwargs))
        except HTTPException:
            raise
        except Exception as exc:
            provider_id = library_providers.provider_id(provider)
            provider_kind = str(library_providers.provider_field(provider, "kind", "") or "")
            if provider_kind:
                is_remote = provider_kind not in ("", "local")
            else:
                is_remote = provider_id != "local"
            if is_remote:
                detail = f"This source appears to be offline ({provider_id})."
                message = str(exc).strip()
                if message:
                    detail = f"{detail} {message}"
                raise HTTPException(status_code=503, detail=detail) from exc
            raise
    # Synchronous provider method — run in a threadpool so the event loop stays free.
    return await run_in_threadpool(_call_library_provider, provider, method_name, **kwargs)


def _safe_art_redirect_url(url: str) -> str | None:
    """Return the URL if it is safe to redirect to (http/https only), else None."""
    from urllib.parse import urlparse
    if not url or not isinstance(url, str):
        return None
    try:
        parsed = urlparse(url)
        if parsed.scheme.lower() not in ("http", "https"):
            return None
        if not parsed.hostname:
            return None
        return url
    except Exception:
        return None


def _library_art_response(result: Any) -> Response:
    if result is None:
        raise HTTPException(status_code=404, detail="Library provider returned no art")
    if isinstance(result, Response):
        return result
    if isinstance(result, (bytes, bytearray, memoryview)):
        return Response(content=bytes(result), media_type="image/png")
    if isinstance(result, str):
        safe_url = _safe_art_redirect_url(result)
        if safe_url is not None:
            return RedirectResponse(safe_url)
        # If the string looks like a URL (contains a scheme separator) but
        # didn't pass the http/https check, refuse it rather than treating
        # it as a filesystem path — a provider returning ftp:// or file://
        # should get a 400, not a 500 from FileResponse failing on a URL.
        if "://" in result:
            raise HTTPException(
                status_code=400,
                detail="Library provider returned an unsupported URL scheme for art",
            )
        if not Path(result).is_file():
            raise HTTPException(status_code=404, detail="Library provider returned an unreadable art path")
        return FileResponse(result)
    if isinstance(result, Path):
        if not result.is_file():
            raise HTTPException(status_code=404, detail="Library provider returned an unreadable art path")
        return FileResponse(str(result))
    if isinstance(result, dict):
        url = result.get("url") or result.get("art_url") or result.get("artUrl")
        if isinstance(url, str) and url:
            safe_url = _safe_art_redirect_url(url)
            if safe_url is None:
                raise HTTPException(status_code=400, detail="Library provider returned an unsafe art URL")
            return RedirectResponse(safe_url)
        path = result.get("path") or result.get("file")
        if isinstance(path, (str, Path)):
            media_type = result.get("media_type") or result.get("content_type")
            if not Path(path).is_file():
                raise HTTPException(status_code=404, detail="Library provider returned an unreadable art path")
            return FileResponse(str(path), media_type=media_type)
        content = result.get("content") or result.get("bytes")
        if isinstance(content, (bytes, bytearray, memoryview)):
            media_type = result.get("media_type") or result.get("content_type") or "image/png"
            return Response(content=bytes(content), media_type=media_type)
    raise HTTPException(status_code=500, detail="Library provider returned unsupported art data")


def _get_dlc_dir(cfg: dict | None = None) -> Path | None:
    # Only consider DLC_DIR if the env var was non-empty. `Path("")` collapses
    # to `.` and reports `.is_dir() == True`, which would silently shadow the
    # config.json fallback. Checking the raw env string preserves
    # `DLC_DIR=.` as a valid opt-in for cwd while keeping unset/empty out.
    if _DLC_DIR_ENV and DLC_DIR.is_dir():
        return DLC_DIR
    if cfg is None:
        config_file = CONFIG_DIR / "config.json"
        if config_file.exists():
            try:
                cfg = json.loads(config_file.read_text(encoding="utf-8"))
            except Exception:
                pass
    if isinstance(cfg, dict):
        raw = str(cfg.get("dlc_dir", "")).strip()
        if raw:
            p = Path(raw)
            if p.is_dir():
                return p
    return None


# ── Background metadata scan ──────────────────────────────────────────────────

def _resolve_dlc_path(dlc: Path, filename: str) -> Path | None:
    """Resolve `filename` under DLC_DIR and refuse anything that escapes.

    `filename` arrives from `:path` route params and can contain `..`
    segments. The Sloppak and archive paths happen to fail safely later
    because their loaders raise on missing/invalid files, but loose-
    folder format detection (`is_loose_song`) globs and parses XML on
    disk first, which lets a crafted path trigger filesystem reads
    outside DLC_DIR before any guard fires. Centralise the containment
    check so every filename-bound handler validates before touching the
    filesystem.

    Returns the validated resolved Path, or None if the path is empty
    or escapes the DLC root.
    """
    return safe_join(dlc, filename)


_SMART_TYPE_BASE: dict[str, int] = {"Lead": 0, "Rhythm": 10, "Bass": 20}


def _arr_smart_sort_key(entry: dict) -> tuple[int, int]:
    """Sort key for arrangement entries ordered by smart naming priority.

    Order: Lead → Alt. Lead [1,2,…] → Bonus Lead [1,2,…]
           → Rhythm → Alt. Rhythm → Bonus Rhythm
           → Bass → Alt. Bass → Bonus Bass → other (stable fallback)
    """
    sn = entry.get("smart_name")
    if not sn:
        return (99, 0)
    for label, base in _SMART_TYPE_BASE.items():
        if sn == label:
            return (base, 0)
        alt_prefix = f"Alt. {label}"
        if sn == alt_prefix:
            return (base + 1, 0)
        if sn.startswith(alt_prefix + " "):
            suffix = sn[len(alt_prefix) + 1:]
            return (base + 1, int(suffix) if suffix.isdigit() else 0)
        bonus_prefix = f"Bonus {label}"
        if sn == bonus_prefix:
            return (base + 2, 0)
        if sn.startswith(bonus_prefix + " "):
            suffix = sn[len(bonus_prefix) + 1:]
            return (base + 2, int(suffix) if suffix.isdigit() else 0)
    return (99, 0)


def _pick_smart_arrangement(
    arrangements: list,
    smart_names: list,
    pref: str,
) -> int:
    """Return the best arrangement index for `pref` using smart-name priority.

    Priority order:
    1. Exact match  — smart_name == pref  (e.g. "Lead")
    2. Alt. variants — "Alt. Lead", "Alt. Lead 1", ...
    3. Bonus variants — "Bonus Lead", "Bonus Lead 1", ...
    4. First arrangement in smart sort order (Lead > Rhythm > Bass > ...)

    Returns -1 when `pref` is empty / "Auto" or `arrangements` is empty
    (caller falls through to the existing most-notes fallback).
    """
    pref = (pref or "").strip()
    if not pref or pref.lower() == "auto" or not arrangements:
        return -1

    sorted_pairs = sorted(
        enumerate(smart_names),
        key=lambda x: _arr_smart_sort_key({"smart_name": x[1]}),
    )

    alt_prefix = f"Alt. {pref}"
    bonus_prefix = f"Bonus {pref}"

    for i, sn in sorted_pairs:
        if sn == pref:
            return i

    for i, sn in sorted_pairs:
        if sn and (sn == alt_prefix or sn.startswith(alt_prefix + " ")):
            return i

    for i, sn in sorted_pairs:
        if sn and (sn == bonus_prefix or sn.startswith(bonus_prefix + " ")):
            return i

    if sorted_pairs:
        return sorted_pairs[0][0]
    return 0


def _sanitized_song_offset(song) -> float:
    """Return song.offset coerced to a finite float, or 0.0.

    Malformed loose-folder XMLs can put `NaN`/`Infinity` into <offset>;
    Python's `float()` happily accepts those, but Starlette's JSON
    encoder then emits the literal `NaN` token which is invalid JSON
    and breaks the frontend's song_info parsing.
    """
    try:
        v = float(getattr(song, "offset", 0.0))
    except (TypeError, ValueError):
        return 0.0
    return v if math.isfinite(v) else 0.0


def _sanitize_authors(manifest: dict | None) -> list[dict]:
    """Extract a display-safe contributor list from a feedpak manifest.

    The feedpak spec (§5.4) defines an OPTIONAL top-level `authors` list of
    objects `{name (required), role?, email?, url?}`. We surface only `name`
    and `role` to the highway — contact fields (email/url) are intentionally
    dropped from the on-screen credits. Malformed entries (non-dict, missing /
    blank name) are skipped; absent / non-list `authors` yields `[]`.
    """
    if not isinstance(manifest, dict):
        return []
    raw = manifest.get("authors")
    if not isinstance(raw, list):
        return []
    out: list[dict] = []
    for entry in raw:
        if not isinstance(entry, dict):
            continue
        name = entry.get("name")
        if not isinstance(name, str) or not name.strip():
            continue
        role = entry.get("role")
        out.append({
            "name": name.strip(),
            "role": role.strip() if isinstance(role, str) and role.strip() else None,
        })
    return out


def _stat_for_cache(f: Path) -> tuple[float, int]:
    """Return (mtime, size) for cache freshness checks.

    For loose-folder directories the directory's own mtime does not
    change when inner files (audio.wem / *.xml / manifest.json) are
    edited in place, so we aggregate over the contents. archives and
    sloppak files (zip form) use their own stat directly. Sloppak
    *directories* are aggregated too: the editor and the library Edit
    button rewrite their `manifest.yaml` / `arrangements/*.json` in
    place, which does NOT bump the directory's own mtime/size — so
    keying the cache on the bare directory stat would make metadata
    edits invisible to a rescan.
    """
    # Aggregate inner stats for loose folders. We detect "loose-shape"
    # purely by file presence (xml + wem + optional manifest.json) so
    # this stays O(stat) on the hot path — `/api/song/{filename}` and
    # the background scan call this on every check, and we avoid
    # calling `is_loose_song` here because that would parse XML on
    # every cache lookup.
    if f.is_dir():
        # Skip symlinks pointing outside the song folder — without this
        # an attacker-crafted custom song could keep a stale cache hot by
        # bumping the mtime of an unrelated file via a symlink.
        root = f.resolve()
        def _in_folder(p: Path) -> bool:
            try:
                p.resolve().relative_to(root)
            except (OSError, ValueError):
                return False
            return True
        xmls = [p for p in f.glob("*.xml") if _in_folder(p)]
        wems = [p for p in f.glob("*.wem") if _in_folder(p)]
        inner: list[Path] = []
        if xmls and wems:
            inner = xmls + wems + [p for p in f.glob("manifest.json") if _in_folder(p)]
        else:
            # Sloppak directory: aggregate over the files that an in-place
            # metadata/arrangement edit actually touches. Stems (ogg) are
            # deliberately excluded — they don't change on a metadata edit and
            # stat-ing them on every cache lookup would be wasteful; a stem
            # add/remove rewrites manifest.yaml, which IS covered here.
            man = [
                p for p in (f / "manifest.yaml", f / "manifest.yml")
                if p.exists() and _in_folder(p)
            ]
            if man:
                inner = man
                inner += [p for p in f.glob("arrangements/*.json") if _in_folder(p)]
                inner += [p for p in f.glob("drum_tab.json") if _in_folder(p)]
        if inner:
            # Tolerate files vanishing between glob() and stat() —
            # otherwise a concurrent edit/move in DLC_DIR can let an
            # OSError bubble out of _background_scan(), killing the
            # scan thread while `_scan_status["running"]` stays true.
            stats = []
            for p in inner:
                try:
                    stats.append(p.stat())
                except OSError:
                    continue
            if stats:
                return max(s.st_mtime for s in stats), sum(s.st_size for s in stats)
    st = f.stat()
    return st.st_mtime, st.st_size


_SCAN_STATUS_INIT = {"running": False, "stage": "idle", "total": 0, "done": 0, "current": "", "error": None, "is_first_scan": False}
_scan_status = dict(_SCAN_STATUS_INIT)

_STARTUP_STATUS_INIT = {
    "running": True,
    "phase": "booting",
    "message": "Starting FeedBack server...",
    "current_plugin": "",
    "loaded": 0,
    "total": 0,
    "error": None,
}
_startup_status = dict(_STARTUP_STATUS_INIT)
_startup_status_lock = threading.Lock()

_startup_sse_subscribers: set[asyncio.Queue] = set()
# threading.Lock (not asyncio.Lock) — also acquired from background threads
# in _notify_startup_sse; held only for set mutations (microseconds).
_startup_sse_lock = threading.Lock()
_event_loop: asyncio.AbstractEventLoop | None = None

_SSE_POLL_INTERVAL = 2.0    # seconds: idle wait between disconnect checks
_SSE_KA_INTERVAL = 15.0     # seconds: interval between SSE keepalive data events


def _set_startup_status(**updates):
    global _startup_status
    with _startup_status_lock:
        next_status = dict(_startup_status)
        next_status.update(updates)
        _startup_status = next_status
        snapshot = dict(next_status)
    _notify_startup_sse(snapshot)


def _put_latest(q: asyncio.Queue, snapshot: dict) -> None:
    """Coalescing put: drain any stale snapshot then put the newest one.

    Because the queue is bounded to maxsize=1 and this function runs on the
    event loop, consecutive rapid updates replace the queued snapshot with
    the latest state rather than growing an unbounded backlog.
    """
    while not q.empty():
        try:
            q.get_nowait()
        except asyncio.QueueEmpty:
            break
    try:
        q.put_nowait(snapshot)
    except asyncio.QueueFull:
        pass  # shouldn't happen after draining, but be defensive


def _notify_startup_sse(snapshot: dict) -> None:
    loop = _event_loop
    if loop is None or loop.is_closed():
        return
    with _startup_sse_lock:
        for q in _startup_sse_subscribers:
            try:
                loop.call_soon_threadsafe(_put_latest, q, snapshot)
            except RuntimeError:
                # Loop is closing (shutdown race); all remaining subscribers are
                # on the same loop and equally unreachable — break is correct.
                break


def _get_startup_status():
    with _startup_status_lock:
        return dict(_startup_status)


def _make_scan_executor():
    """Build the executor for the background metadata scan.

    A `spawn` ProcessPoolExecutor in production. `spawn` (not the platform
    default) is mandatory: _background_scan runs on a non-main daemon
    thread, and forking a multithreaded process from a non-main thread can
    deadlock on locks held by other threads at fork time (the default on
    Linux). `spawn` boots a clean interpreter that imports only scan_worker
    (+ its pure lib deps) to unpickle the worker — never this module — so
    workers don't re-run server.py's import-time side effects (reopening
    SQLite, attaching a second RotatingFileHandler, re-registering routes).

    Tests monkeypatch this to a ThreadPoolExecutor so the scan runs
    in-process and metadata extraction can be mocked.
    """
    mp_ctx = multiprocessing.get_context("spawn")
    # Default to one worker per core so CPU-bound metadata parsing uses the
    # whole machine (the point of moving to processes).
    # FEEDBACK_MAX_SCAN_WORKERS (set by the Desktop launcher to cap memory
    # usage on low-RAM machines — e.g. 8 GB M2 MacBook Air) takes priority;
    # SCAN_MAX_WORKERS is a legacy override for Docker/bare installs.
    # A malformed override falls back to the core count rather than crashing.
    try:
        max_workers = int(
            getenv_compat("FEEDBACK_MAX_SCAN_WORKERS")
            or os.environ.get("SCAN_MAX_WORKERS")
            or (os.cpu_count() or 1)
        )
    except ValueError:
        max_workers = os.cpu_count() or 1
    # ProcessPoolExecutor raises ValueError on Windows when max_workers > 61
    # (the WaitForMultipleObjects handle limit), so clamp there — otherwise
    # a high-core Windows host can't construct the pool and the scan never
    # starts.
    if sys.platform == "win32":
        max_workers = min(max_workers, 61)
    return concurrent.futures.ProcessPoolExecutor(
        max_workers=max(1, max_workers), mp_context=mp_ctx,
    )


_BUILTIN_DIAGNOSTIC_SUBDIR = "diagnostics-builtin"
_BUILTIN_DIAGNOSTIC_SOURCES: list[tuple[str, str]] = [
    (
        "feedBack-diagnostic-basic-guitar.sloppak",
        "docs/diagnostics/feedBack-diagnostic-basic-guitar.sloppak",
    ),
]


def _feedBack_server_root() -> Path:
    """Directory containing server.py (repo root in dev; resources/feedBack when bundled)."""
    return Path(__file__).resolve().parent


def _builtin_diagnostic_filename() -> str:
    """Library filename (DLC-relative POSIX path) of the calibration sloppak —
    the onboarding challenge target (spec 010)."""
    return f"{_BUILTIN_DIAGNOSTIC_SUBDIR}/{_BUILTIN_DIAGNOSTIC_SOURCES[0][0]}"


# Progression content (spec 010): bundled JSON under data/progression/ (paths,
# quest pools, shop catalog). Loaded lazily-once; invalid entries are logged
# warnings, never fatal. FEEDBACK_PROGRESSION_DATA overrides the root (tests).
_progression_content: dict | None = None
_progression_content_lock = threading.Lock()


def _get_progression_content() -> dict:
    global _progression_content
    if _progression_content is None:
        with _progression_content_lock:
            if _progression_content is None:
                import progression as progression_mod
                root = getenv_compat("FEEDBACK_PROGRESSION_DATA") or (
                    _feedBack_server_root() / "data" / "progression"
                )
                content, warnings = progression_mod.load_content(root)
                for warning in warnings:
                    log.warning("progression content: %s", warning)
                _progression_content = content
    return _progression_content


def _seed_builtin_diagnostic_sloppaks(dlc: Path | None = None) -> None:
    """Copy bundled diagnostic sloppaks into DLC before library scan.

    Creates ``DLC_DIR/diagnostics-builtin/`` and copies each bundled sloppak
    when the destination is missing or older than the repo/bundle source.
    Never deletes user files or touches manually copied paths (e.g.
    ``diagnostics-test/``). Logs and continues on missing source or copy errors.
    """
    try:
        if dlc is None:
            dlc = _get_dlc_dir()
        if dlc is None:
            log.debug("Builtin diagnostic seed: no DLC folder configured, skipping")
            return

        root = _feedBack_server_root()
        dest_dir = dlc / _BUILTIN_DIAGNOSTIC_SUBDIR
        # Refuse a symlinked seed directory: mkdir(exist_ok=True) would accept
        # it and copies would land at the link target, outside the DLC tree.
        # The per-file is_symlink() guard below cannot catch this.
        if dest_dir.is_symlink():
            log.warning(
                "Builtin diagnostic seed: %s is a symlink, skipping all seeding",
                _BUILTIN_DIAGNOSTIC_SUBDIR,
            )
            return
        dest_dir.mkdir(parents=True, exist_ok=True)

        for dest_name, rel_source in _BUILTIN_DIAGNOSTIC_SOURCES:
            source = root / rel_source
            dest = dest_dir / dest_name

            if not source.is_file():
                log.warning(
                    "Builtin diagnostic seed: source missing, skipping %s (%s)",
                    dest_name,
                    source,
                )
                continue

            # Refuse to seed through a symlink. is_file()/stat()/copy2 all
            # follow links, so a symlink planted at the destination would let
            # the copy redirect outside diagnostics-builtin/ and overwrite an
            # arbitrary file the server user can write. Skip and warn; never
            # touch the link or its target.
            if dest.is_symlink():
                log.warning(
                    "Builtin diagnostic seed: destination is a symlink, skipping %s/%s",
                    _BUILTIN_DIAGNOSTIC_SUBDIR,
                    dest_name,
                )
                continue

            if dest.is_file():
                try:
                    if source.stat().st_mtime <= dest.stat().st_mtime:
                        log.info(
                            "Builtin diagnostic seed: already present %s/%s",
                            _BUILTIN_DIAGNOSTIC_SUBDIR,
                            dest_name,
                        )
                        continue
                    action = "updated"
                except OSError as exc:
                    log.warning(
                        "Builtin diagnostic seed: cannot compare %s and %s: %s",
                        source,
                        dest,
                        exc,
                    )
                    continue
            else:
                action = "seeded"

            try:
                shutil.copy2(source, dest)
                log.info(
                    "Builtin diagnostic seed: %s %s -> %s/%s",
                    action,
                    source.name,
                    _BUILTIN_DIAGNOSTIC_SUBDIR,
                    dest_name,
                )
            except OSError as exc:
                log.warning(
                    "Builtin diagnostic seed: failed to copy %s -> %s: %s",
                    source,
                    dest,
                    exc,
                )
    except Exception:
        log.warning("Builtin diagnostic seed: unexpected error", exc_info=True)


def _background_scan():
    """Scan the library and cache song metadata on startup. Uses a process pool to bypass the GIL for CPU-bound metadata parsing.

    Never sets `_scan_status["running"] = False` — ownership of that flag
    lives in `_scan_runner` so a `_kick_scan()` racing this function's
    terminal write cannot observe a stale False and start a second runner.
    """
    global _scan_status
    _scan_status = {**_SCAN_STATUS_INIT, "running": True, "stage": "listing"}

    # Load config once so both the DLC-dir lookup and the platform filter
    # read from the same snapshot, avoiding a redundant parse of config.json.
    _cfg = _load_config(CONFIG_DIR / "config.json") or _default_settings()
    dlc = _get_dlc_dir(_cfg)
    if not dlc:
        _scan_status = {**_SCAN_STATUS_INIT, "running": True, "stage": "idle", "error": "DLC folder not configured"}
        log.warning("Scan: no DLC folder configured")
        return

    _seed_builtin_diagnostic_sloppaks(dlc)

    # Listing can fail on macOS without Full Disk Access, or on Docker if the
    # path isn't shared. Report the failure explicitly rather than silently
    # appearing to scan nothing.
    try:
        # Generated-content sloppaks that the highway WS must resolve by path
        # but that are NOT library songs. Two conventions share this carve-out:
        #   - tutorials-builtin/  — lesson drills seeded by the tutorials plugin
        #     (see plugins/tutorials/routes.py::_seed_builtin_packs).
        #   - minigames-builtin/  — exercise charts generated on demand by
        #     minigame plugins (e.g. Chord Sprint writes alternating-chord
        #     drills here). Cached/reused per exercise, never browsed.
        # Both are kept out of the scan; _resolve_dlc_path still loads them by
        # path for playback.
        def _is_excluded_from_library(p: Path) -> bool:
            return "tutorials-builtin" in p.parts or "minigames-builtin" in p.parts
        # Sloppaks: match both file (zip) and directory form, across both the
        # `.feedpak` and legacy `.sloppak` suffixes.
        _cands = sorted(p for ext in sloppak_mod.SONG_EXTS for p in dlc.rglob(f"*{ext}"))
        sloppaks = [f for f in _cands
                    if sloppak_mod.is_sloppak(f)
                    and not _is_excluded_from_library(f)]

        # Loose song folders: any directory containing a non-preview *.wem + *.xml.
        # Skip directories that are actually sloppak bundles — those are
        # already in `sloppaks`; the dispatcher's sloppak-first precedence
        # would route them to the sloppak path anyway, but adding them
        # here would inflate the scan queue and over-count the total.
        loose_songs = []
        seen_loose = set()
        sloppak_dirs = {p for p in sloppaks if p.is_dir()}
        for wem in sorted(dlc.rglob("*.wem")):
            if "preview" in wem.stem.lower():
                continue
            if _is_excluded_from_library(wem):
                continue
            d = wem.parent
            if d in sloppak_dirs or d.name.lower().endswith(sloppak_mod.SONG_EXTS):
                continue
            if d not in seen_loose and loosefolder_mod.is_loose_song(d):
                loose_songs.append(d)
                seen_loose.add(d)
    except PermissionError as e:
        msg = (f"Permission denied reading {dlc}. "
               "On macOS: grant Full Disk Access to the app in System Settings → Privacy & Security. "
               "With Docker: share this path in Docker Desktop → Settings → Resources → File Sharing.")
        log.error("Scan failed: %s (%s)", msg, e)
        _scan_status = {**_SCAN_STATUS_INIT, "running": True, "stage": "error", "error": msg}
        return
    except OSError as e:
        log.error("Scan failed listing %s: %s", dlc, e)
        _scan_status = {**_SCAN_STATUS_INIT, "running": True, "stage": "error", "error": f"Unable to list {dlc}: {e}"}
        return

    all_songs = sloppaks + loose_songs
    log.info("Scan: listed %d sloppaks and %d loose folders in %s",
             len(sloppaks), len(loose_songs), dlc)

    current_files = {_relpath(f, dlc) for f in all_songs}

    # Clean up stale DB entries
    stale = meta_db.delete_missing(current_files)
    if stale:
        log.info("Removed %d stale DB entries", stale)

    # Figure out which need scanning
    to_scan = []
    for f in all_songs:
        # Skip entries that vanish or become unreadable between listing
        # and stat. Without this, one concurrent move/delete in DLC_DIR
        # would crash the scan thread and leave `_scan_status["running"]`
        # stuck true with no path to recover.
        try:
            mtime, size = _stat_for_cache(f)
        except OSError as e:
            log.debug("scan: skipping %s (%s)", f, e)
            continue
        cache_key = _relpath(f, dlc)
        try:
            cached = meta_db.get(cache_key, mtime, size)
        except Exception as e:
            # Keep scanning even if a single metadata lookup fails.
            # The file will be re-scanned and cache repaired by put().
            log.warning("scan cache lookup failed for %s: %s", cache_key, e)
            cached = None
        if not cached:
            to_scan.append((f, mtime, size, dlc))
        elif cached.get("arrangements") and any(
            "smart_name" not in a for a in cached["arrangements"]
        ):
            # Row was scanned before smart naming was introduced — force a
            # rescan so the DB picks up authoritative path flags from the
            # manifest JSON and stores correct smart_name values. Don't
            # re-queue rows where smart_name is explicitly null: the writer
            # only emits that when compute_smart_names truly can't classify
            # the arrangement (e.g. a name outside the recognised set with
            # zero path flags), so rescanning would produce the same null
            # forever and never converge.
            to_scan.append((f, mtime, size, dlc))

    if not to_scan:
        _scan_status = {**_SCAN_STATUS_INIT, "running": True, "stage": "complete"}
        log.info("Scan: nothing new to scan (%d songs, all cached)", len(all_songs))
        return

    # Refine: all discovered songs need scanning → treat as first-time import
    # (covers moved DLC folder / fully-stale DB as well as a genuinely empty DB).
    is_first_scan = bool(all_songs) and len(to_scan) == len(all_songs)
    _scan_status = {**_SCAN_STATUS_INIT, "running": True, "stage": "scanning", "total": len(to_scan),
                    "is_first_scan": is_first_scan}
    log.info("Library: %d sloppaks + %d loose folders, %d cached, %d to scan",
             len(sloppaks), len(loose_songs), len(all_songs) - len(to_scan), len(to_scan))

    with _make_scan_executor() as executor:
        futures = {executor.submit(_scan_one, item): item[0].name for item in to_scan}
        for future in concurrent.futures.as_completed(futures):
            fname = futures[future]
            try:
                name, mtime, size, meta = future.result()
                meta_db.put(name, mtime, size, meta)
            except Exception as e:
                log.warning("scan failed for %s: %s", fname, e)
            _scan_status["done"] += 1
            _scan_status["current"] = fname

    log.info("Scan complete: %d songs cached", len(to_scan))
    _scan_status = {**_SCAN_STATUS_INIT, "running": True, "stage": "complete"}


_scan_kick_lock = threading.Lock()
_scan_rescan_pending = False


def _kick_scan() -> bool:
    """Request a library rescan, single-flight + coalescing.

    Returns True if a new scan thread was started, False if one was already
    running. In the latter case a follow-up pass is queued and runs as soon
    as the current scan finishes so files landing mid-scan (e.g. an upload
    that finalizes after the scan has already listed DLC_DIR) are not lost
    until the next periodic pass. Multiple late-arriving requests coalesce
    into a single follow-up.
    """
    global _scan_rescan_pending
    with _scan_kick_lock:
        if _scan_status["running"]:
            _scan_rescan_pending = True
            return False
        # Mark running synchronously so a parallel _kick_scan() observes it
        # before the worker thread has a chance to reassign _scan_status.
        _scan_status["running"] = True
    threading.Thread(target=_scan_runner, daemon=True).start()
    return True


def _scan_runner():
    """Run _background_scan, then re-run if requests arrived mid-scan."""
    global _scan_rescan_pending
    while True:
        try:
            _background_scan()
        except Exception:
            log.exception("background scan failed unexpectedly")

        with _scan_kick_lock:
            if not _scan_rescan_pending:
                _scan_status["running"] = False
                return
            _scan_rescan_pending = False
            _scan_status["running"] = True


# ── Register plugin API endpoints (lightweight, before app starts) ───────────
from plugins import load_plugins, register_plugin_api
register_plugin_api(app)

# Plugin loading deferred to startup event (see below) to avoid blocking
# server startup when many plugins are installed.


@app.on_event("startup")
async def startup_events():
    # Safety net: re-apply the structlog pipeline in case the server was
    # started directly via `uvicorn server:app` (without main.py).  When
    # running via `python main.py`, configure_logging() was already called
    # before uvicorn.run(..., log_config=None), so uvicorn never calls its
    # own dictConfig() and this call is effectively a no-op.  When running
    # the uvicorn CLI directly, uvicorn applies LOGGING_CONFIG before the
    # ASGI startup hook fires, overwriting the uvicorn* handlers; this call
    # restores them for all messages after "Waiting for application startup".
    configure_logging()

    loop = asyncio.get_running_loop()
    global _event_loop
    _event_loop = loop

    # Test/CI escape hatch: tests that import the FastAPI app via TestClient
    # don't need plugin loading or the background library scan, and those
    # paths touch the user filesystem in ways that aren't safe under
    # parallel test runs. Drive startup straight to a terminal "complete"
    # phase so any frontend startup waiter that observes the lifespan also
    # unblocks cleanly (the SSE/poll client treats only `complete` and
    # `error` as terminal when `running` becomes false).
    if _env_flag("FEEDBACK_SKIP_STARTUP_TASKS"):
        log.info("[startup] Skipping plugin load and background scan")
        # Tests pop `server` from sys.modules across runs, but the `plugins`
        # module is not reloaded — so LOADED_PLUGINS can carry stale entries
        # from a previous test's startup, which `/api/plugins` would then
        # expose despite this branch reporting zero loaded plugins. Normal
        # startup clears it inside load_plugins; do the same here under the
        # same lock so this skip path matches that invariant.
        from plugins import LOADED_PLUGINS, PENDING_PLUGINS, PLUGINS_LOCK
        with PLUGINS_LOCK:
            LOADED_PLUGINS.clear()
            PENDING_PLUGINS.clear()
        _set_startup_status(
            running=False,
            phase="complete",
            message="Startup tasks skipped (FEEDBACK_SKIP_STARTUP_TASKS).",
            error=None,
            current_plugin="",
            loaded=0,
            total=0,
        )
        return

    _set_startup_status(
        running=True,
        phase="starting",
        message="Core server ready. Starting plugin loader...",
        error=None,
    )

    plugin_context = {
        "config_dir": CONFIG_DIR,
        "get_dlc_dir": _get_dlc_dir,
        # Pass the DLC-root resolver (not its result) so loose-folder
        # metadata keeps its dlc-relative artist/album inference while the
        # lookup stays lazy — archive/sloppak extraction never reads config.
        # Plugins still call this with just a path.
        "extract_meta": lambda p: _extract_meta_for_file(p, _get_dlc_dir),
        "meta_db": meta_db,
        "get_scan_status": lambda: dict(_scan_status),
        "get_art_cache_dir": lambda: ART_CACHE_DIR,
        "library_providers": library_providers,
        "register_library_provider": register_library_provider,
        "unregister_library_provider": unregister_library_provider,
        "register_tuning_provider": register_tuning_provider,
        "unregister_tuning_provider": unregister_tuning_provider,
        "get_sloppak_cache_dir": lambda: SLOPPAK_CACHE_DIR,
        "register_demo_janitor_hook": register_demo_janitor_hook,
        # Unified XP service (fee[dB]ack v0.3.0). Plugins that award XP
        # (minigames, tutorials, …) should feed the single core store via these
        # instead of keeping a private XP curve. `award_xp` returns the new
        # progress payload; `seed_xp` is a one-time migration of pre-unification
        # XP from a plugin's own store.
        "award_xp": lambda amount, source=None: (meta_db.award_xp(amount, source), meta_db.get_progress())[1],
        "get_xp_progress": lambda: meta_db.get_progress(),
        "seed_xp": lambda amount, marker="minigames": meta_db.seed_xp_once(amount, marker),
        # Reset one source's contribution to the unified total (e.g. a minigames
        # profile-reset). Returns the new progress payload.
        "reset_xp": lambda source: meta_db.reset_source_xp(source),
        # Progression engine (spec 010): the backend twin of the frontend
        # `progression` capability's record-event command. Backend plugin code
        # is trusted, so no type whitelist here (the HTTP intake enforces one);
        # returns the toast-ready summary {challenges_completed,
        # quests_completed, level_ups, calibration_completed, mastery_rank}.
        "record_progression_event": lambda event_type, payload=None: meta_db.record_progression_event(
            event_type, payload, _get_progression_content()
        ),
    }

    # Load plugins asynchronously so HTTP routes and the desktop window can
    # come up immediately while heavy plugin imports/install steps continue.
    _sync_mode = getenv_compat("FEEDBACK_SYNC_STARTUP", "").lower() in {"1", "true", "yes", "on"}

    def _load_plugins_background():
        try:
            # Track all active plugin errors so that a `clear_error=True`
            # event from a fallback recovery correctly restores any *other*
            # plugin's still-unresolved failure rather than wiping the error
            # field entirely.
            #
            # Using a single "last error" pointer was insufficient: if plugin A
            # fails, then plugin B fails and later recovers, the recovery would
            # overwrite the pointer with B's id — and then B's `error=None`
            # clears the status to null even though A is still broken.
            #
            # With a dict (keyed by plugin_id, insertion-ordered) we can
            # remove B's entry on recovery and restore the most recent remaining
            # failure from A, giving an accurate picture of startup health.
            _active_errors: dict[str, str] = {}  # plugin_id -> error text

            def _on_progress(event: dict):
                total = int(event.get("total") or 0)
                loaded = int(event.get("loaded") or 0)
                plugin_id = event.get("plugin_id") or ""
                message = event.get("message") or "Loading plugins..."
                phase = event.get("phase") or "plugins-loading"
                update: dict = dict(
                    running=True,
                    phase=phase,
                    message=message,
                    current_plugin=plugin_id,
                    loaded=loaded,
                    total=total,
                )
                # Forward the error field only when the event explicitly
                # carries it.  Two cases:
                # - Non-null string: record this plugin's failure and display it.
                # - Explicit null (clear_error=True in _emit_progress):
                #   remove this plugin's failure entry, then restore the most
                #   recently recorded still-active failure (if any) so
                #   unresolved failures from other plugins remain visible.
                #   An unscoped clear (no plugin_id) removes the unscoped
                #   sentinel and applies the same restore logic.
                # Events that omit the key entirely leave the status unchanged,
                # preserving any earlier plugin error across the many
                # non-error progress events that follow normal setup steps.
                if "error" in event:
                    err_val = event["error"]
                    if err_val is not None:
                        # Pop then re-insert so the key moves to the end of
                        # insertion order even when this plugin already has an
                        # entry.  A plugin can emit more than one error during a
                        # single load (requirements + routes), and dict.update()
                        # on an existing key does NOT move it to the end, so
                        # remaining[-1] could return a stale earlier message
                        # after another plugin clears its own error.
                        _active_errors.pop(plugin_id, None)
                        _active_errors[plugin_id] = err_val
                        update["error"] = err_val
                    else:
                        # Clear this plugin's error entry (fallback recovery or
                        # unscoped clear), then surface the most recently added
                        # remaining failure, or None if all have been resolved.
                        _active_errors.pop(plugin_id, None)
                        remaining = list(_active_errors.values())
                        update["error"] = remaining[-1] if remaining else None
                _set_startup_status(**update)

            def _route_setup_on_main(fn):
                """Schedule plugin route registration on the event-loop thread.

                FastAPI/Starlette router mutation is not thread-safe, so the
                actual setup() call is normally marshalled back onto the event
                loop via call_soon_threadsafe.  The background thread blocks
                until the registration completes, raises, or a 60 s timeout
                elapses.

                In synchronous startup mode (_sync_mode=True) this function is
                called directly from the event-loop thread, so marshalling via
                call_soon_threadsafe + fut.result() would deadlock (the loop
                cannot drain the queued callback while it is blocked here).
                In that case fn() is invoked inline instead.

                On timeout (async mode only), startup continues normally.  Any
                exception that eventually arrives is logged via a done-callback
                so it is never silently dropped.
                """
                if _sync_mode:
                    # Already on the event-loop thread — call directly.
                    fn()
                    return

                fut: concurrent.futures.Future = concurrent.futures.Future()
                # _state_lock makes the "check _cancelled + set _started"
                # transition in _do() atomic with the "read _started + set
                # _cancelled" transition in the timeout handler.  Without this
                # lock the two threads can interleave:
                #
                #   Thread A (_do):   passes check-1, yields to event loop
                #   Thread B (timeout): reads _started=False → _mid_flight=False
                #   Thread A (_do):   sets _started, passes check-2 → calls fn()
                #   Thread B (timeout): sets _cancelled (too late)
                #   Result: fn() runs AND fallback loads — concurrent mutation.
                #
                # With the lock, either _do() commits to running fn() before
                # the timeout can set _cancelled (in which case _mid_flight=True
                # and the fallback is skipped), or the timeout wins (sets
                # _cancelled=True and reads _started=False → _mid_flight=False,
                # then _do() sees _cancelled inside the lock and bails out).
                _state_lock = threading.Lock()
                _cancelled = threading.Event()
                _started = threading.Event()

                def _do():
                    with _state_lock:
                        if _cancelled.is_set():
                            # Timeout already fired before we started; bail
                            # to prevent a race with any fallback that may
                            # have been activated by load_plugins().
                            if not fut.done():
                                fut.set_result(None)
                            return
                        _started.set()
                    # Past the lock — committed to running fn().
                    try:
                        fn()
                        fut.set_result(None)
                    except Exception as exc:
                        fut.set_exception(exc)

                loop.call_soon_threadsafe(_do)
                try:
                    fut.result(timeout=60)
                except concurrent.futures.TimeoutError as _te:
                    _pid = getattr(fn, "_plugin_id", "unknown")
                    # Read _started and set _cancelled atomically so _do()
                    # can't slip through the lock and start fn() between the
                    # two operations.
                    with _state_lock:
                        _mid_flight = _started.is_set()
                        _cancelled.set()
                    if _mid_flight:
                        log.warning(
                            "route registration for %r timed out after 60 s and "
                            "setup() was already mid-flight; any routes registered "
                            "before the timeout cannot be removed. The user-copy "
                            "fallback will NOT be activated to prevent concurrent "
                            "router mutation (Python threads cannot be interrupted "
                            "mid-execution). Restart the server to recover.",
                            _pid,
                        )
                        # Signal to load_plugins() that fallback is unsafe
                        # for this plugin — the original setup() is still
                        # running and may add more routes concurrently.
                        _te.setup_mid_flight = True
                    else:
                        log.warning(
                            "route registration for %r timed out after 60 s; "
                            "setup() had not started yet, so it has been cancelled "
                            "and the user-copy fallback (if any) can proceed safely.",
                            _pid,
                        )
                    # Prevent the still-queued _do() from executing if it
                    # hasn't started yet — avoids races with any fallback.
                    # Note: _cancelled was already set inside _state_lock above.

                    def _log_deferred(f: concurrent.futures.Future):
                        try:
                            exc = f.exception()
                        except concurrent.futures.CancelledError:
                            return
                        if exc is not None:
                            log.error("deferred route registration for %r raised: %s", _pid, exc)

                    fut.add_done_callback(_log_deferred)
                    raise  # propagate to load_plugins() so it emits plugin-error and skips "Loaded routes"

            _set_startup_status(
                running=True,
                phase="plugins-loading",
                message="Loading plugins...",
                current_plugin="",
                loaded=0,
                total=0,
                error=None,
            )
            load_plugins(app, plugin_context, progress_cb=_on_progress,
                         route_setup_fn=_route_setup_on_main)
            # Self-heal a freshly recreated container: its filesystem reset to
            # the image-baked sheet (in-tree plugins only), but a mounted
            # FEEDBACK_PLUGINS_DIR may carry user-installed plugins whose
            # classes aren't in it. Run in its OWN daemon thread so the startup
            # status can flip to "complete" immediately rather than waiting on
            # the (up to 120s) Tailwind subprocess. No-op when there are no user
            # plugins or no Tailwind engine (e.g. desktop/native).
            def _startup_tailwind_rebuild():
                try:
                    import tailwind_rebuild
                    if tailwind_rebuild.user_plugin_count() > 0:
                        tailwind_rebuild.rebuild("startup-scan")
                except Exception:
                    log.warning("startup tailwind rebuild failed", exc_info=True)

            # Skip entirely in sync-startup mode (used by tests): no background
            # thread AND no slow inline subprocess. The startup self-heal only
            # matters for a real async startup of a recreated container.
            if not _sync_mode:
                threading.Thread(target=_startup_tailwind_rebuild, daemon=True).start()
            status = _get_startup_status()
            _set_startup_status(
                running=False,
                phase="complete",
                message="Startup complete",
                current_plugin="",
                loaded=status.get("loaded", 0),
                total=max(status.get("total", 0), status.get("loaded", 0)),
                error=status.get("error"),
            )
        except Exception as e:
            _set_startup_status(
                running=False,
                phase="error",
                message="Plugin startup failed",
                error=str(e),
            )
            log.exception("plugin startup failed")

    if _sync_mode:
        # Caller requested synchronous startup (e.g. test environment).
        # Run the loader inline so startup is complete before the server's
        # startup handler returns — no polling or timing workarounds needed.
        _load_plugins_background()
    else:
        threading.Thread(target=_load_plugins_background, daemon=True).start()

    global _DEMO_JANITOR_STARTED, _DEMO_JANITOR_THREAD
    if getenv_compat("FEEDBACK_DEMO_MODE") or getenv_compat("FEEDBACK_DEMO_MODE") == "1" and not _DEMO_JANITOR_STARTED:
        _DEMO_JANITOR_STARTED = True
        _DEMO_JANITOR_STOP.clear()
        def _janitor():
            while not _DEMO_JANITOR_STOP.wait(timeout=3600):
                with _DEMO_JANITOR_HOOKS_LOCK:
                    hooks = list(_DEMO_JANITOR_HOOKS)
                for hook in hooks:
                    _run_janitor_hook(hook)
        _DEMO_JANITOR_THREAD = threading.Thread(target=_janitor, daemon=True, name="demo-janitor")
        _DEMO_JANITOR_THREAD.start()

    # Start background metadata scan
    startup_scan()


@app.on_event("shutdown")
def shutdown_events():
    """Stop the demo-mode janitor thread (if running) on server shutdown."""
    global _DEMO_JANITOR_STARTED, _DEMO_JANITOR_THREAD, _event_loop
    _event_loop = None  # prevent stale loop reference after shutdown
    if _DEMO_JANITOR_STARTED:
        _DEMO_JANITOR_STOP.set()
        thread = _DEMO_JANITOR_THREAD
        if thread is not None:
            thread.join(timeout=5)
            if thread.is_alive():
                import warnings
                warnings.warn(
                    "demo-janitor thread did not stop within 5 s; "
                    "a registered hook may be blocking",
                    RuntimeWarning,
                    stacklevel=1,
                )
                # Leave _DEMO_JANITOR_STARTED True so a new janitor is not
                # spawned by a subsequent startup while the old one is alive.
                return
            _DEMO_JANITOR_THREAD = None
        _DEMO_JANITOR_STARTED = False
        with _DEMO_JANITOR_HOOKS_LOCK:
            _DEMO_JANITOR_HOOKS.clear()


def startup_scan():
    """Start background metadata scan and periodic rescan on server start."""
    _kick_scan()
    # Periodic rescan every 5 minutes
    rescan_thread = threading.Thread(target=_periodic_rescan, daemon=True)
    rescan_thread.start()


def _periodic_rescan():
    """Check for new files every 5 minutes."""
    time.sleep(300)  # Wait 5 minutes after startup
    while True:
        # _kick_scan() is a no-op (returns False, queues a pending pass) when
        # a scan is already running, so racing against the active scan is
        # safe — no second runner is spawned.
        _kick_scan()
        time.sleep(300)


def _safe_http_url(raw):
    """Return `raw` stripped + trailing-slash-stripped if it parses as an
    http(s) URL with a non-empty host; else None.

    Used to validate operator-supplied `APP_SOURCE_URL` / `APP_LICENSE_URL`
    env vars before they reach `<a href>` in the UI. A bare prefix check
    like `startswith(("http://","https://"))` accepts malformed inputs
    such as `"https://"` (no host) or `"https:///foo"` (empty host) that
    still produce broken hrefs — and, when used as a base for the default
    `license_url`, garbage like `"https:///blob/main/LICENSE"`.
    """
    from urllib.parse import urlsplit
    if not raw:
        return None
    s = raw.strip().rstrip("/")
    if not s:
        return None
    try:
        parsed = urlsplit(s)
    except ValueError:
        return None
    if parsed.scheme.lower() not in ("http", "https"):
        return None
    # `netloc` includes any `user:pass@` and `:port` — strings like
    # "http://:80/path" have non-empty netloc (":80") but no real
    # hostname. Validate `hostname` so only URLs with an actual host
    # are accepted.
    if not parsed.hostname:
        return None
    return s


@app.get("/api/version")
def get_version():
    env_version = os.environ.get("APP_VERSION", "").strip()
    if env_version:
        version = env_version
    else:
        version_file = Path(__file__).parent / "VERSION"
        version = "unknown"
        if version_file.exists():
            try:
                version = version_file.read_text().strip()
            except (OSError, UnicodeDecodeError):
                pass
    default_source_url = "https://github.com/got-feedback/feedBack"
    # APP_SOURCE_URL / APP_LICENSE_URL flow straight into <a href> in the UI,
    # so validate with urllib.parse rather than a bare prefix check — a prefix
    # check accepts malformed values like "https://" (no host) which produce
    # broken hrefs (and a constructed license_url like "https:///blob/main/LICENSE").
    # _safe_http_url requires scheme in {http,https} AND a non-empty hostname
    # (not just netloc — that would still accept port-only authorities like
    # "http://:80/path"); fall back to the safe default otherwise.
    source_url = _safe_http_url(os.environ.get("APP_SOURCE_URL")) or default_source_url
    # APP_LICENSE_URL: explicit override for the LICENSE link. The default
    # constructed value (source_url + "/blob/main/LICENSE") is GitHub-
    # specific and assumes the repo's default branch is `main`; non-GitHub
    # hosts (GitLab, Gitea, self-hosted) need an explicit value.
    license_url = _safe_http_url(os.environ.get("APP_LICENSE_URL")) or (source_url + "/blob/main/LICENSE")
    return {
        "version": version,
        "source_url": source_url,
        "license_url": license_url,
    }


@app.get("/api/scan-status")
def scan_status():
    return _scan_status


@app.get("/api/startup-status")
def startup_status():
    return _get_startup_status()


@app.get("/api/startup-status/stream")
async def startup_status_stream(request: Request):
    queue: asyncio.Queue[dict] = asyncio.Queue(maxsize=1)
    # Register before putting the initial snapshot.  asyncio cooperative
    # scheduling guarantees _put_latest cannot run between add() and the
    # put() below: put() on an empty maxsize-1 queue never yields (CPython
    # fast path), so no event-loop iteration fires in between.  Registering
    # first ensures a terminal status fired just after connect is never missed.
    with _startup_sse_lock:
        _startup_sse_subscribers.add(queue)
    await queue.put(_get_startup_status())

    async def _gen():
        since_ka = 0.0
        try:
            while True:
                try:
                    data = await asyncio.wait_for(queue.get(), timeout=_SSE_POLL_INTERVAL)
                except asyncio.TimeoutError:
                    if await request.is_disconnected():
                        break
                    since_ka += _SSE_POLL_INTERVAL
                    if since_ka >= _SSE_KA_INTERVAL:
                        yield 'data: {"type":"keepalive"}\n\n'
                        since_ka = 0.0
                    continue
                yield f"data: {json.dumps(data)}\n\n"
                if not data.get("running", True):
                    break
                since_ka = 0.0  # reset keepalive timer — a real event just went out
                # Check after each delivered message so that rapid-fire updates
                # don't prevent disconnect detection (the timeout path above only
                # fires when the queue is idle for the full _SSE_POLL_INTERVAL).
                if await request.is_disconnected():
                    break
        finally:
            with _startup_sse_lock:
                _startup_sse_subscribers.discard(queue)

    return StreamingResponse(
        _gen(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


@app.post("/api/rescan")
def trigger_rescan():
    """Manually trigger a library rescan."""
    if not _kick_scan():
        return {"message": "Scan already in progress"}
    return {"message": "Rescan started"}


@app.post("/api/rescan/full")
def trigger_full_rescan():
    """Clear cache and rescan everything."""
    if _scan_status["running"]:
        return {"message": "Scan already in progress"}
    with meta_db._lock:
        # Force every file to re-scan by invalidating the mtime cache (get()
        # keys on mtime equality) WITHOUT emptying `songs` — keeping the rows
        # means the table is never transiently empty mid-scan, so the
        # existing-song stats/playlist read-filter stays correct throughout.
        # delete_missing() prunes anything genuinely gone at the end.
        meta_db.conn.execute("UPDATE songs SET mtime = -1")
        meta_db.conn.commit()
    if not _kick_scan():
        return {"message": "Scan already in progress"}
    return {"message": "Full rescan started"}


# ── Song upload ───────────────────────────────────────────────────────────────

_ALLOWED_SONG_EXTS = set(sloppak_mod.SONG_EXTS)
_MAX_UPLOAD_BYTES = 1024 * 1024 * 1024  # 1 GB — covers sloppaks bundled with stems
# Per-request batch cap. Lets a user drop a whole album of sloppaks at once
# without giving a hostile client a 1000-file DoS surface via Starlette's
# default max_files=1000. The pre-parse Content-Length guard is sized as
# _MAX_UPLOAD_FILES * _MAX_UPLOAD_BYTES + slack.
_MAX_UPLOAD_FILES = 50
# Multipart Content-Length includes boundary markers + per-part headers, so a
# file sitting right at _MAX_UPLOAD_BYTES would be rejected by an equality cap
# on Content-Length. Add a generous slack for the multipart envelope; the real
# file-size cap is enforced by the streaming check in _save_uploaded_song().
_MULTIPART_OVERHEAD_SLACK = 1024 * 1024  # 1 MiB
# Serializes the mutating step of upload (os.replace into DLC_DIR) with
# delete_song so the two endpoints can't interleave on the same path —
# e.g. an upload finishing right after a concurrent delete shouldn't
# resurrect a song the user just removed, and a delete arriving mid-
# overwrite shouldn't strand a half-written file. threading.Lock (not
# asyncio.Lock) because delete_song is sync (runs in the threadpool);
# upload acquires it inside ``run_in_threadpool`` for the same reason.
_song_io_lock = threading.Lock()


def _commit_uploaded_song(tmp_path: Path, dest: Path, overwrite: bool, base: str):
    """Atomically move a validated temp upload into ``dest`` under ``_song_io_lock``.

    Returns ``None`` on success or an error result dict matching the upload
    endpoint's contract. Holds the lock across the directory re-check and
    the final ``os.replace`` so a concurrent delete or upload can't slip
    between them. Always cleans up the temp file on the error paths.
    """
    with _song_io_lock:
        if dest.exists():
            if not overwrite:
                # Lost the race against a concurrent upload of the same name.
                try:
                    tmp_path.unlink()
                except OSError:
                    pass
                return {"status": "exists", "filename": base,
                        "error": "A file with this name already exists"}
            # Re-check directory state under the lock — the pre-check
            # may have raced an unrelated mkdir, and a sloppak directory
            # has to be removed before os.replace() can write over it.
            if dest.is_dir():
                if not sloppak_mod.is_sloppak(dest):
                    try:
                        tmp_path.unlink()
                    except OSError:
                        pass
                    return {"status": "exists", "filename": base,
                            "error": "A directory with this name exists and is not "
                                     "a sloppak — refusing to overwrite"}
                shutil.rmtree(str(dest))
        os.replace(str(tmp_path), str(dest))
    return None


def _invalidate_song_caches(cache_key: str) -> None:
    """Drop filename-keyed derived caches when a song at ``cache_key`` is
    replaced or removed. Sloppak's ``_source_cache`` and loose-folder audio
    IDs self-invalidate via stat checks; the caches purged here do not."""
    # In-memory archive extraction cache (filename → tmp dir + Song).
    with _extract_cache_lock:
        stale = _extract_cache.pop(cache_key, None)
    if stale:
        shutil.rmtree(stale[0], ignore_errors=True)

    # Art cache — match the safe_name mapping used by get_song_art /
    # upload_song_art_b64 exactly so we hit the same on-disk file.
    safe_name = cache_key.replace("/", "_").replace(" ", "_")
    art_file = ART_CACHE_DIR / f"{safe_name}.png"
    try:
        art_file.unlink()
    except FileNotFoundError:
        pass
    except OSError:
        log.debug("failed to evict art cache for %s", cache_key, exc_info=True)

    # archive audio cache — audio_id is `Path(filename).stem.replace(" ", "_")`
    # without any stat digest, so a same-named replacement would serve the
    # previous file's converted audio. Loose-folder ids include a wem stat
    # digest and self-heal; sloppak streams stems directly and uses no
    # audio_id at all — both safely no-op here.
    audio_id = Path(cache_key).stem.replace(" ", "_")
    for d in (AUDIO_CACHE_DIR, STATIC_DIR):
        for ext in (".mp3", ".ogg", ".wav"):
            f = d / f"audio_{audio_id}{ext}"
            try:
                f.unlink()
            except FileNotFoundError:
                pass
            except OSError:
                log.debug("failed to evict audio cache file %s", f, exc_info=True)


@app.post("/api/songs/upload")
async def upload_song(request: Request):
    """Upload one or more .sloppak files into the configured DLC folder.

    Multipart body with one or more ``file`` fields (up to ``_MAX_UPLOAD_FILES``
    per request). Query string:
      ``overwrite=1`` — replace existing files with the same name.

    Response shape (always HTTP 200 once we've gotten past request-level guards
    like DLC-not-configured / payload-too-large):
      ``{"results": [{"filename": "...", "status": "ok" | "exists" | "error",
                       "error"?: "...", "size"?: N, "format"?: "sloppak"}, ...]}``
    Per-file conflicts surface as ``status: "exists"`` so a batch upload can
    surface ALL conflicts at once instead of bailing on the first one. The
    client re-POSTs just the conflicting files with ``overwrite=1`` if the
    user opts in.

    The DLC directory is resolved via ``_get_dlc_dir()`` which honours the
    ``DLC_DIR`` env var first and falls back to ``dlc_dir`` in
    ``config.json`` — so uploads land in whichever folder the rest of the
    app already considers the library root, regardless of which mechanism
    configured it.
    """
    dlc = _get_dlc_dir()
    if dlc is None:
        return JSONResponse(
            {"error": "DLC folder is not configured. Set DLC_DIR or configure it in Settings."},
            status_code=503,
        )
    if not os.access(str(dlc), os.W_OK):
        return JSONResponse(
            {"error": f"DLC folder {dlc} is not writable by the server process."},
            status_code=500,
        )

    # Pre-parse Content-Length guard — fail fast before reading any body.
    # Multipart Content-Length is file bytes + boundary + per-part headers, so
    # we can't use _MAX_UPLOAD_BYTES as an exact cap here (a file right at the
    # advertised max would be rejected before _save_uploaded_song() can apply
    # the real per-file byte cap). For batch uploads we allow up to
    # _MAX_UPLOAD_FILES files at _MAX_UPLOAD_BYTES each; the parser still
    # enforces per-part size via max_part_size and per-batch count via
    # max_files. The streaming check inside _save_uploaded_song() is the
    # authoritative per-file size cap.
    max_total = _MAX_UPLOAD_FILES * _MAX_UPLOAD_BYTES + _MULTIPART_OVERHEAD_SLACK
    cl = request.headers.get("content-length")
    if cl is not None:
        try:
            cl_int = int(cl)
        except ValueError:
            return JSONResponse({"error": "Invalid Content-Length header"}, status_code=400)
        if cl_int < 0:
            return JSONResponse({"error": "Invalid Content-Length header"}, status_code=400)
        if cl_int > max_total:
            return JSONResponse(
                {"error": f"Batch upload exceeds {_MAX_UPLOAD_FILES} files × "
                          f"{_MAX_UPLOAD_BYTES // (1024 * 1024)} MB limit"},
                status_code=413,
            )

    overwrite = request.query_params.get("overwrite") == "1"
    # Tighten the parser to the handler's contract: up to _MAX_UPLOAD_FILES
    # file parts, no text parts (overwrite comes from query params).
    # Starlette's defaults of max_files=1000 / max_fields=1000 would
    # otherwise let a client force the parser to spool far more parts than
    # the endpoint is willing to process.
    form = await request.form(
        max_files=_MAX_UPLOAD_FILES,
        max_fields=0,
        max_part_size=_MAX_UPLOAD_BYTES,
    )
    try:
        from starlette.datastructures import UploadFile as _StarletteUploadFile
        # form.getlist("file") returns all parts named "file" in submission
        # order. Filter to file parts only — Starlette would yield strings
        # for text parts, but we've capped max_fields=0 so any non-file part
        # is already a parser error before reaching here.
        uploads = [u for u in form.getlist("file") if isinstance(u, _StarletteUploadFile)]
        if not uploads:
            return JSONResponse(
                {"error": "Expected one or more files in multipart field 'file'"},
                status_code=400,
            )

        results = []
        any_saved = False
        for upload in uploads:
            try:
                result = await _save_uploaded_song(upload, dlc, overwrite)
                results.append(result)
                if result.get("status") == "ok":
                    any_saved = True
            except Exception as e:
                # Per-file failure must not abort the batch — record and
                # continue so the client gets a complete report.
                log.exception("upload failed for %r", getattr(upload, "filename", "?"))
                results.append({
                    "filename": Path(getattr(upload, "filename", "") or "").name or "?",
                    "status": "error",
                    "error": f"Upload failed: {e}",
                })
            finally:
                try:
                    await upload.close()
                except Exception:
                    log.debug("failed to close upload file handle", exc_info=True)

        if any_saved:
            _kick_scan()
        return {"results": results}
    finally:
        try:
            await form.close()
        except Exception:
            log.debug("failed to close form", exc_info=True)


async def _save_uploaded_song(upload: UploadFile, dlc: Path, overwrite: bool) -> dict:
    """Save one upload into ``dlc``. Returns a per-file result dict (never
    a JSONResponse) so batch uploads can aggregate.

    Shape:
      ok:     ``{"status": "ok", "filename": base, "size": N, "format": "sloppak"}``
      exists: ``{"status": "exists", "filename": base, "error": "..."}``
      error:  ``{"status": "error", "filename": base, "error": "..."}``
    """
    # Strip any path components a client may have included in the filename —
    # only the basename lands in the DLC root. Path traversal would otherwise
    # let a crafted upload escape the library directory.
    raw_name = upload.filename or ""
    base = Path(raw_name).name
    if not base or base in (".", "..") or "/" in base or "\\" in base:
        return {"status": "error", "filename": raw_name or "?", "error": "Invalid filename"}
    suffix = Path(base).suffix.lower()
    if suffix not in _ALLOWED_SONG_EXTS:
        return {"status": "error", "filename": base,
                "error": "Only .feedpak files are accepted"}

    dest = dlc / base
    if dest.exists():
        if not overwrite:
            return {"status": "exists", "filename": base,
                    "error": "A file with this name already exists"}
        # overwrite=1 must handle directory-form sloppaks (the scanner and
        # delete path both treat them as song entries). os.replace() can't
        # clobber a non-empty directory, so without the rmtree below the
        # whole upload would write to a temp file and then surface a late
        # 500 at the os.replace() call. Refuse other directories so an
        # unrelated folder isn't blown away by a same-named upload.
        if dest.is_dir() and not sloppak_mod.is_sloppak(dest):
            return {"status": "exists", "filename": base,
                    "error": "A directory with this name exists and is not a sloppak — "
                             "refusing to overwrite"}

    # Temp file in the DLC dir itself so os.replace is atomic (same filesystem).
    # Dot-prefix keeps it out of the rglob("*.sloppak") scan glob.
    fd, tmp_name = await run_in_threadpool(
        tempfile.mkstemp, dir=str(dlc), prefix=".upload-", suffix=".part"
    )
    tmp_path = Path(tmp_name)
    bytes_read = 0
    head = b""
    error_result: dict | None = None
    try:
        try:
            tmpf = await run_in_threadpool(os.fdopen, fd, "wb")
        except BaseException:
            try:
                await run_in_threadpool(os.close, fd)
            except OSError:
                pass
            raise
        try:
            while True:
                chunk = await upload.read(1024 * 1024)
                if not chunk:
                    break
                bytes_read += len(chunk)
                if bytes_read > _MAX_UPLOAD_BYTES:
                    error_result = {
                        "status": "error", "filename": base,
                        "error": f"Upload exceeds {_MAX_UPLOAD_BYTES // (1024 * 1024)} MB cap",
                    }
                    break
                if len(head) < 4:
                    head += chunk[: 4 - len(head)]
                await run_in_threadpool(tmpf.write, chunk)
        finally:
            await run_in_threadpool(tmpf.close)

        if error_result is None:
            if bytes_read == 0:
                error_result = {"status": "error", "filename": base,
                                "error": "Empty upload — file is 0 bytes"}
            elif suffix in _ALLOWED_SONG_EXTS:
                if head[:2] != b"PK":
                    error_result = {"status": "error", "filename": base,
                                    "error": "Not a valid feedpak file (expected zip archive)"}
                else:
                    # ZIP magic alone admits any renamed zip — verify the sloppak
                    # loader can actually parse a manifest.yaml inside. Without
                    # this, /api/songs/upload returns "ok" for files the rest of
                    # the backend would refuse to scan or load.
                    try:
                        await run_in_threadpool(sloppak_mod.load_manifest, tmp_path)
                    except Exception as e:
                        error_result = {"status": "error", "filename": base,
                                        "error": f"Not a valid sloppak file: {e}"}

        if error_result is not None:
            try:
                await run_in_threadpool(tmp_path.unlink)
            except OSError:
                pass
            return error_result

        # Single sync helper so the lock is held for the whole commit —
        # ``async with _upload_lock`` would have released between every
        # ``run_in_threadpool`` and let a concurrent delete or upload slip
        # in between the dir check and the final ``os.replace``.
        commit_result = await run_in_threadpool(
            _commit_uploaded_song, tmp_path, dest, overwrite, base
        )
        if commit_result is not None:
            return commit_result
    except BaseException:
        try:
            await run_in_threadpool(tmp_path.unlink)
        except OSError:
            pass
        raise

    # Even on a fresh (non-overwrite) upload, evict any stale entries left
    # over from a previous delete+re-upload of the same name.
    await run_in_threadpool(_invalidate_song_caches, base)

    log.info("Uploaded %s (%d bytes) to %s", base, bytes_read, dlc)
    return {"status": "ok", "filename": base, "size": bytes_read,
            "format": suffix.lstrip(".")}


@app.delete("/api/song/{filename:path}")
def delete_song(filename: str):
    """Remove a song from the DLC folder and clear its cache entries.

    Works for both formats: ``.sloppak`` files OR directories, and
    loose-folder songs (the directory containing the chart). The path is
    resolved through ``_resolve_dlc_path`` so URL-encoded ``..`` segments
    cannot escape the library root.
    """
    dlc = _get_dlc_dir()
    if dlc is None:
        return JSONResponse({"error": "DLC folder not configured"}, status_code=503)
    resolved = _resolve_dlc_path(dlc, filename)
    if resolved is None:
        return JSONResponse({"error": "forbidden"}, status_code=403)
    if not resolved.exists():
        return JSONResponse({"error": "File not found"}, status_code=404)
    if resolved == dlc.resolve():
        return JSONResponse({"error": "Refusing to delete the DLC root"}, status_code=400)

    # Only delete actual song entries. Without this, DELETE /api/song/ArtistName
    # would recursively wipe a whole artist subfolder — far broader than the
    # UI's per-song contract. Sloppak detection wins over loose because a
    # sloppak dir can also contain WEM/XML (matches the scanner's precedence).
    is_sloppak = sloppak_mod.is_sloppak(resolved)
    is_loose = (
        resolved.is_dir()
        and not is_sloppak
        and loosefolder_mod.is_loose_song(resolved)
    )
    if not (is_sloppak or is_loose):
        return JSONResponse(
            {"error": "Not a song entry — only sloppaks "
                      "or loose-folder songs can be deleted"},
            status_code=400,
        )

    # Hold ``_song_io_lock`` across the filesystem removal AND the DB/cache
    # eviction. Without it, an upload of the same filename could ``os.replace``
    # a new file into place between our removal and DB delete, leaving the
    # new generation stranded with no library row; or the reverse, where
    # delete runs between an upload's directory check and its replace and
    # the upload then resurrects the song we just removed.
    with _song_io_lock:
        try:
            if resolved.is_dir():
                shutil.rmtree(resolved)
            else:
                resolved.unlink()
        except OSError as e:
            log.error("Failed to delete %s: %s", resolved, e)
            return JSONResponse({"error": f"Delete failed: {e}"}, status_code=500)

        # Canonicalise the cache key the same way update_song_meta does so we
        # hit the row the scanner indexed under.
        try:
            cache_key = resolved.relative_to(dlc.resolve()).as_posix()
        except ValueError:
            cache_key = filename
        with meta_db._lock:
            meta_db.conn.execute("DELETE FROM songs WHERE filename = ?", (cache_key,))
            meta_db.conn.execute("DELETE FROM favorites WHERE filename = ?", (cache_key,))
            meta_db.conn.execute("DELETE FROM loops WHERE filename = ?", (cache_key,))
            # Purge the v3 filename-keyed state too, so the deleted song stops
            # surfacing in stats / recent / continue / playlists immediately.
            meta_db.conn.execute("DELETE FROM song_stats WHERE filename = ?", (cache_key,))
            meta_db.conn.execute("DELETE FROM playlist_songs WHERE filename = ?", (cache_key,))
            # Personal difficulty / notes / tags for this song (we hold the
            # lock, so purge is lock-free).
            meta_db.purge_song_user_data(cache_key)
            # Multi-chart grouping (P5a): drop this chart's split + read-model rows,
            # and any preferred-chart pointer that named it (the work re-auto-picks).
            # work_key-keyed prefs for OTHER charts survive. Mark the read-model
            # dirty so the affected work regroups on the next grouped query.
            meta_db.conn.execute("DELETE FROM chart_group_split WHERE filename = ?", (cache_key,))
            meta_db.conn.execute("DELETE FROM work_display WHERE filename = ?", (cache_key,))
            meta_db.conn.execute("DELETE FROM chart_group_pref WHERE preferred_filename = ?", (cache_key,))
            meta_db._work_display_dirty = True
            meta_db.conn.commit()

        _invalidate_song_caches(cache_key)

    log.info("Deleted song %s", cache_key)
    # If a scan was mid-flight when we removed the row, it may already have
    # listed (and not yet processed) the file and will call ``meta_db.put()``
    # for it after our DB delete — reinserting a ghost row. Coalesce a
    # follow-up pass via ``_kick_scan`` so the next scan's ``delete_missing()``
    # purges that entry. Cheap no-op when no scan is running.
    if _scan_status["running"]:
        _kick_scan()
    return {"ok": True, "filename": cache_key}


# ── Library API ───────────────────────────────────────────────────────────────

def _split_csv(raw: str) -> list[str]:
    """Parse a comma-separated query-string list. Empty / whitespace-only
    entries are dropped so `arrangements_has=` (no value) and
    `arrangements_has=,` both mean 'no filter'."""
    if not raw:
        return []
    return [s.strip() for s in raw.split(",") if s.strip()]


def _normalize_tag(tag) -> str:
    """Canonical form for a personal practice tag: trimmed, lowercased,
    internal whitespace collapsed, length-capped. Lowercasing is what keeps
    "Rock"/"rock" from splitting into two tags. Non-strings → ''."""
    if not isinstance(tag, str):
        return ""
    return " ".join(tag.strip().lower().split())[:60]


def _parse_has_lyrics(raw: str) -> int | None:
    """Tri-state parse for has_lyrics. `1` → require, `0` → exclude,
    anything else (including empty) → no filter."""
    if raw == "1":
        return 1
    if raw == "0":
        return 0
    return None


def _library_filter_args(q: str = "", favorites: int = 0, format: str = "",
                         artist: str = "", album: str = "",
                         arrangements_has: str = "", arrangements_lacks: str = "",
                         stems_has: str = "", stems_lacks: str = "",
                         has_lyrics: str = "", tunings: str = "") -> dict:
    fmt = format if format in ("archive", "sloppak", "loose") else ""
    return {
        "q": q,
        "favorites_only": bool(favorites),
        "format_filter": fmt,
        "artist_filter": (artist or "").strip(),
        "album_filter": (album or "").strip(),
        "arrangements_has": _split_csv(arrangements_has),
        "arrangements_lacks": _split_csv(arrangements_lacks),
        "stems_has": _split_csv(stems_has),
        "stems_lacks": _split_csv(stems_lacks),
        "has_lyrics": _parse_has_lyrics(has_lyrics),
        "tunings": _split_csv(tunings),
    }


@app.get("/api/library/providers")
def list_library_providers():
    """List registered library providers."""
    return {"providers": library_providers.list()}


@app.get("/api/library/providers/{provider_id}/songs/{song_id:path}/art")
async def get_library_provider_song_art(provider_id: str, song_id: str):
    """Return album art for a song owned by a library provider."""
    library_provider = _get_library_provider(provider_id)
    _require_library_provider_capability(library_provider, "art.read")
    result = await _call_library_provider_async(library_provider, "get_art", song_id=song_id)
    return _library_art_response(result)


@app.post("/api/library/providers/{provider_id}/songs/{song_id:path}/sync")
async def sync_library_provider_song(provider_id: str, song_id: str):
    """Ask a provider to sync a remote song into the local library/cache."""
    library_provider = _get_library_provider(provider_id)
    _require_library_provider_capability(library_provider, "song.sync")
    result = await _call_library_provider_async(library_provider, "sync_song", song_id=song_id)
    if result is None:
        return {"ok": True}
    if isinstance(result, dict):
        return result
    return {"ok": True, "result": result}


@app.get("/api/library")
async def list_library(q: str = "", page: int = 0, size: int = 24, sort: str = "artist",
                       dir: str = "asc", favorites: int = 0, format: str = "",
                       artist: str = "", album: str = "",
                       arrangements_has: str = "", arrangements_lacks: str = "",
                       stems_has: str = "", stems_lacks: str = "",
                       has_lyrics: str = "", tunings: str = "", provider: str = "local",
                       mastery: str = "", tags: str = "", user_difficulty: str = "",
                       after: str = "", group: int = 0, naming_mode: str = "legacy"):
    """Paginated library search through the selected library provider.

    `after` is an opaque keyset cursor (feedBack#636 item 3): pass back the
    `next_cursor` from the previous response to fetch the next page with a
    WHERE-seek instead of OFFSET. Providers that don't support it ignore it and
    page by OFFSET, so the client can always fall back."""
    size = min(size, 100)
    library_provider = _get_library_provider(provider)
    _require_library_provider_capability(library_provider, "library.read")
    # Only the true local provider keysets: it's the one whose effective sort is
    # exactly the request `sort`. A smart collection may pin its own sort and
    # remote providers don't keyset — both must page by OFFSET, so never hand
    # them a cursor (a mismatched one would mis-seek).
    is_local = getattr(library_provider, "id", "") == "local"
    songs, total = await _call_library_provider_async(
        library_provider,
        "query_page",
        page=page,
        size=size,
        sort=sort,
        direction=dir,
        after=((after or None) if is_local else None),
        group=bool(group),
        naming_mode=naming_mode,
        mastery=_split_csv(mastery),
        tags_has=_split_csv(tags),
        user_difficulty_in=_split_csv(user_difficulty),
        **_library_filter_args(
            q=q, favorites=favorites, format=format,
            artist=artist, album=album,
            arrangements_has=arrangements_has, arrangements_lacks=arrangements_lacks,
            stems_has=stems_has, stems_lacks=stems_lacks,
            has_lyrics=has_lyrics, tunings=tunings,
        ),
    )
    # The cursor to resume after this page (effective sort folds in dir=desc).
    next_cursor = (next_library_cursor(_effective_keyset_sort(sort, dir), songs[-1])
                   if (is_local and songs) else None)
    return {"songs": songs, "total": total, "page": page, "size": size,
            "next_cursor": next_cursor}


# ── Multi-chart work grouping API (P5b) ──────────────────────────────────────
# Read + manage the charts of a work (the P5d Charts drawer consumes this). The
# grouping engine lives in MetadataDB (P5a); these are its HTTP surface. Local
# library only. NOTE: a scoped "work changed" repaint broadcast for OTHER open
# views is deferred to P5d — there's no server-side library event bus today, and
# the drawer updates itself from these responses.

@app.get("/api/work/{work_key:path}/charts")
def api_get_work_charts(work_key: str):
    """All charts in a work + which is the keeper (your pick vs auto-pick)."""
    return meta_db.work_charts(work_key)


@app.put("/api/work/{work_key:path}/preferred")
def api_set_work_preferred(work_key: str, data: dict):
    """Set the keeper chart of a work: body {filename}. The filename must be a
    current member of the work. Returns the refreshed chart list."""
    fn = (data.get("filename") or "").strip()
    if not fn:
        return JSONResponse({"error": "filename is required"}, 400)
    members = {c["filename"] for c in meta_db.work_charts(work_key)["charts"]}
    if fn not in members:
        return JSONResponse({"error": "filename is not a chart of this work"}, 400)
    meta_db.set_chart_preferred(work_key, fn)
    return meta_db.work_charts(work_key)


@app.delete("/api/work/{work_key:path}/preferred")
def api_reset_work_preferred(work_key: str):
    """Reset a work to auto-pick (drop the explicit preferred)."""
    meta_db.clear_chart_preferred(work_key)
    return meta_db.work_charts(work_key)


@app.post("/api/chart/{filename:path}/split")
def api_split_chart(filename: str):
    """'These aren't the same song' — split this chart out as its own singleton
    work. Under /api/chart (NOT /api/song) so the DELETE /api/song/{path}
    catch-all can't shadow it."""
    key = meta_db._canonical_song_filename(filename)
    meta_db.split_chart(key)
    return {"ok": True, "filename": key}


@app.post("/api/chart/{filename:path}/unsplit")
def api_unsplit_chart(filename: str):
    """Undo a split — rejoin the chart to its work."""
    key = meta_db._canonical_song_filename(filename)
    meta_db.unsplit_chart(key)
    return {"ok": True, "filename": key}


@app.get("/api/chart/{filename:path}/work")
def api_get_chart_work(filename: str):
    """Resolve a chart's work membership: {work_key, chart_count}. For openers
    on rows that came from an ungrouped query (the tree view) — grouped grid
    rows already carry both fields inline."""
    return meta_db.chart_work(filename)


@app.get("/api/library/artists")
async def list_artists(letter: str = "", q: str = "", favorites: int = 0, page: int = 0,
                       size: int = 50, format: str = "",
                       artist: str = "", album: str = "",
                       arrangements_has: str = "", arrangements_lacks: str = "",
                       stems_has: str = "", stems_lacks: str = "",
                       has_lyrics: str = "", tunings: str = "", provider: str = "local",
                       naming_mode: str = "legacy"):
    """Get artists grouped by letter with albums and songs (for tree view)."""
    size = min(size, 100)
    library_provider = _get_library_provider(provider)
    _require_library_provider_capability(library_provider, "library.read")
    artists, total = await _call_library_provider_async(
        library_provider,
        "query_artists",
        letter=letter,
        page=page,
        size=size,
        naming_mode=naming_mode,
        **_library_filter_args(
            q=q, favorites=favorites, format=format,
            artist=artist, album=album,
            arrangements_has=arrangements_has, arrangements_lacks=arrangements_lacks,
            stems_has=stems_has, stems_lacks=stems_lacks,
            has_lyrics=has_lyrics, tunings=tunings,
        ),
    )
    return {"artists": artists, "total_artists": total, "page": page, "size": size}


@app.get("/api/library/stats")
async def library_stats(favorites: int = 0, q: str = "", format: str = "",
                        artist: str = "", album: str = "",
                        arrangements_has: str = "", arrangements_lacks: str = "",
                        stems_has: str = "", stems_lacks: str = "",
                        has_lyrics: str = "", tunings: str = "", provider: str = "local",
                        sort: str = "artist", sort_letters: int = 0,
                        group: int = 0, naming_mode: str = "legacy"):
    """Aggregate stats for the UI. Accepts the same filter params as
    /api/library so the letter bar mirrors the active grid filter set.
    `sort` selects the column the jump rail's `sort_letters` keys on;
    `sort_letters=1` opts into that breakdown (the rail), so non-rail
    callers skip the extra per-letter aggregate. `group=1` counts works not
    charts (mirrors the grouped grid)."""
    library_provider = _get_library_provider(provider)
    _require_library_provider_capability(library_provider, "library.read")
    return await _call_library_provider_async(
        library_provider,
        "query_stats",
        naming_mode=naming_mode,
        sort=sort,
        want_sort_letters=bool(sort_letters),
        group=bool(group),
        **_library_filter_args(
            q=q, favorites=favorites, format=format,
            artist=artist, album=album,
            arrangements_has=arrangements_has, arrangements_lacks=arrangements_lacks,
            stems_has=stems_has, stems_lacks=stems_lacks,
            has_lyrics=has_lyrics, tunings=tunings,
        ),
    )


@app.get("/api/library/tuning-names")
async def list_tuning_names(provider: str = "local"):
    """Distinct tuning names present in the library, with per-tuning
    counts. Powers the tuning multi-select. Sorted by `tuning_sort_key`
    so names appear in the same musical order the sort uses
    (feedBack#22) — E Standard first, then nearest neighbors."""
    library_provider = _get_library_provider(provider)
    _require_library_provider_capability(library_provider, "library.read")
    return await _call_library_provider_async(library_provider, "tuning_names")


@app.post("/api/favorites/toggle")
def toggle_favorite(data: dict):
    """Toggle a song's favorite status."""
    filename = data.get("filename", "")
    if not filename:
        return {"error": "No filename"}
    new_state = meta_db.toggle_favorite(filename)
    return {"favorite": new_state}


# ── Personal per-song metadata (difficulty / notes / tags) ───────────────────
# The local, never-shared layer. Distinct from POST /api/song/{f}/meta, which
# writes catalog fields (title/artist/album/year) BACK INTO the feedpak file;
# these endpoints are DB-only and never touch the file. Likes stay the heart
# (POST /api/favorites/toggle).

@app.get("/api/song/{filename:path}/user-meta")
def get_song_user_meta(filename: str):
    """Read {user_difficulty, notes, tags} for one song."""
    return meta_db.get_song_user_meta(meta_db._canonical_song_filename(filename))


@app.put("/api/song/{filename:path}/user-meta")
def put_song_user_meta(filename: str, data: dict):
    """Partial update. Send any of: `user_difficulty` (int 1–5, or null/"" to
    clear), `notes` (string, or null to clear), `tags` (a full-replace array of
    strings). Omitted keys are preserved. Returns the merged meta.

    Tag removal is a full-replace `tags` array (send the new set) rather than a
    granular DELETE sub-route, because `DELETE /api/song/{filename:path}` already
    owns every DELETE under /api/song and would shadow it."""
    key = meta_db._canonical_song_filename(filename)
    kwargs: dict = {}
    if "user_difficulty" in data:
        v = data["user_difficulty"]
        if v is None or v == "":
            kwargs["user_difficulty"] = None
        else:
            # Reject bools (int subclass) and non-integral floats so 2.5 / true
            # can't silently truncate into a valid band.
            if isinstance(v, bool) or (isinstance(v, float) and not v.is_integer()):
                return JSONResponse({"error": "user_difficulty must be an integer 1–5 or null"}, 400)
            try:
                iv = int(v)
            except (TypeError, ValueError):
                return JSONResponse({"error": "user_difficulty must be an integer 1–5 or null"}, 400)
            if not (1 <= iv <= 5):
                return JSONResponse({"error": "user_difficulty must be 1–5 or null"}, 400)
            kwargs["user_difficulty"] = iv
    if "notes" in data:
        n = data["notes"]
        if n is None:
            kwargs["notes"] = None
        elif isinstance(n, str):
            kwargs["notes"] = n.strip()[:4000]
        else:
            return JSONResponse({"error": "notes must be a string or null"}, 400)
    tags = data.get("tags", "__absent__")
    if tags != "__absent__" and not isinstance(tags, list):
        return JSONResponse({"error": "tags must be an array of strings"}, 400)
    if not kwargs and tags == "__absent__":
        return JSONResponse({"error": "No fields to update"}, 400)
    if kwargs:
        meta_db.set_song_user_meta(key, **kwargs)
    if tags != "__absent__":
        meta_db.set_song_tags(key, tags)
    return meta_db.get_song_user_meta(key)


@app.post("/api/songs/user-meta/batch")
def batch_song_user_meta(data: dict):
    """Bulk personal-meta edit over a selection — one request instead of N×2
    per-song round-trips (the batch bar's apply-to-all). DB-only; never touches
    files. Body:
      {"filenames": [...],            # required, non-empty
       "set_difficulty": 1-5 | null,  # optional: set on all / clear on all
       "add_tags": [...],             # optional: add to all (never full-replace)
       "remove_tags": [...]}          # optional: remove from all
    Omit `set_difficulty` entirely to leave each song's difficulty as-is
    (mixed-state "leave unchanged"). Returns {"updated": N, "tags": [...]} so the
    caller can refresh the tag-filter list without a second call."""
    fns = data.get("filenames")
    if not isinstance(fns, list) or not fns:
        return JSONResponse({"error": "filenames must be a non-empty array"}, 400)
    if not all(isinstance(f, str) and f for f in fns):
        return JSONResponse({"error": "filenames must be non-empty strings"}, 400)

    kwargs: dict = {}
    if "set_difficulty" in data:
        v = data["set_difficulty"]
        if v is None or v == "":
            kwargs["set_difficulty"] = None
        else:
            if isinstance(v, bool) or (isinstance(v, float) and not v.is_integer()):
                return JSONResponse({"error": "set_difficulty must be an integer 1–5 or null"}, 400)
            try:
                iv = int(v)
            except (TypeError, ValueError):
                return JSONResponse({"error": "set_difficulty must be an integer 1–5 or null"}, 400)
            if not (1 <= iv <= 5):
                return JSONResponse({"error": "set_difficulty must be 1–5 or null"}, 400)
            kwargs["set_difficulty"] = iv

    add_tags = data.get("add_tags")
    remove_tags = data.get("remove_tags")
    for name, val in (("add_tags", add_tags), ("remove_tags", remove_tags)):
        if val is not None and not isinstance(val, list):
            return JSONResponse({"error": f"{name} must be an array of strings"}, 400)
    if "set_difficulty" not in data and not add_tags and not remove_tags:
        return JSONResponse({"error": "Nothing to apply"}, 400)

    keys = [meta_db._canonical_song_filename(f) for f in fns]
    n = meta_db.batch_user_meta(keys, add_tags=add_tags, remove_tags=remove_tags, **kwargs)
    return {"updated": n, "tags": meta_db.all_tags()}


@app.get("/api/tags")
def list_tags():
    """All personal tags in use (over still-present songs), most-used first —
    powers the tag filter UI."""
    return {"tags": meta_db.all_tags()}


# ── Artist aliases / Tidy-up (P4) ────────────────────────────────────────────
# Canonicalize messy artist tags at DISPLAY ("ACDC" → "AC/DC") without touching
# the feedpak files or the scanner-derived songs.artist. All DB-only.

@app.get("/api/artist-aliases")
def list_artist_aliases():
    """Existing raw→canonical overrides (the Tidy-up 'current merges' list)."""
    return {"aliases": meta_db.list_artist_aliases()}


@app.get("/api/artists/raw")
def list_raw_artists(limit: int = 2000):
    """Distinct RAW artist names + song counts + current canonical — the Tidy-up
    picker (you merge raw variants into one canonical)."""
    return {"artists": meta_db.raw_artists(limit)}


@app.post("/api/artist-aliases")
def set_artist_alias(data: dict):
    """Upsert one override: {raw_name, canonical_name, mb_artist_id?}. A self-alias
    (raw == canonical) clears the row instead (un-merge)."""
    raw = (data.get("raw_name") or "").strip()
    canon = (data.get("canonical_name") or "").strip()
    if not raw or not canon:
        return JSONResponse({"error": "raw_name and canonical_name are required"}, 400)
    result = meta_db.set_artist_alias(raw, canon, (data.get("mb_artist_id") or None))
    if not result.get("ok"):
        # Would form a cycle (raw → … → raw) — refuse rather than corrupt the chain.
        return JSONResponse(
            {"error": "alias would create a cycle", "raw_name": raw, "canonical_name": canon},
            409)
    return {"ok": True, "raw_name": raw, "canonical_name": result.get("canonical_name", canon)}


@app.post("/api/artist-aliases/merge")
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
    n = meta_db.merge_artists(raws, canon)
    return {"merged": n, "canonical_name": canon}


@app.delete("/api/artist-aliases/{raw_name:path}")
def delete_artist_alias(raw_name: str):
    """Remove one override so that raw artist stands on its own again."""
    meta_db.remove_artist_alias(raw_name)
    return {"ok": True}


# ── Player profile / unified XP / streak (fee[dB]ack v0.3.0) ──────────────────

def _list_bundled_avatars() -> list[str]:
    """Bundled default avatar filenames under static/v3/avatars/."""
    d = STATIC_DIR / "v3" / "avatars"
    if not d.is_dir():
        return []
    exts = {".svg", ".png", ".webp"}
    return sorted(
        p.name for p in d.iterdir()
        if p.is_file() and p.suffix.lower() in exts and not p.name.startswith(".")
    )


@app.get("/api/profile")
def api_get_profile():
    profile = meta_db.get_profile()
    # Equipped cosmetics ride along (resolved to their payloads) so the theme
    # and avatar frame apply at boot without an extra request. Never let a
    # cosmetics/content problem break the profile read.
    cosmetics = {}
    try:
        shop = _get_progression_content()["shop"]
        for slot, item_id in meta_db.get_equipped().items():
            item = shop.get(item_id)
            if item:
                cosmetics[slot] = {"item_id": item_id, "payload": item["payload"]}
    except Exception:
        log.warning("profile cosmetics enrich failed", exc_info=True)
    profile["cosmetics"] = cosmetics
    return profile


def _clean_str(value) -> str:
    """Trim a request field to a string; non-strings (or missing) → ''.
    Lets the raw-`dict` POST handlers treat wrong-typed JSON (an int/list/etc.
    where a string was expected) as "empty" and answer 400, instead of raising
    AttributeError/TypeError → 500 on a later .strip()/`in`."""
    return value.strip() if isinstance(value, str) else ""


def _as_int(value) -> int:
    """Coerce a JSON value to an int, REJECTING bool and non-integral numbers
    so e.g. 1.9 / True don't silently truncate to 1. Accepts ints, integral
    floats (1.0), and integer-shaped strings ("5"); raises ValueError otherwise."""
    if isinstance(value, bool):
        raise ValueError("bool is not an integer")
    if isinstance(value, int):
        return value
    if isinstance(value, float):
        if not math.isfinite(value) or not value.is_integer():
            raise ValueError("non-integral float")
        return int(value)
    if isinstance(value, str):
        return int(value)   # int("5") ok; int("1.9")/"nan"/"inf" raise ValueError
    raise ValueError("not an integer")


@app.post("/api/profile")
def api_set_profile(data: dict):
    """Set/update the player profile. Body: {display_name, avatar:{type,value}}.
    avatar.type is 'default' (value = bundled filename) or 'upload' (value =
    the /api/profile/avatar/<name> URL returned by the upload endpoint); omit
    avatar to keep the existing one (name-only edit)."""
    name = _clean_str(data.get("display_name"))
    if not (1 <= len(name) <= 32):
        return JSONResponse({"error": "Display name must be 1–32 characters."}, status_code=400)
    avatar = data.get("avatar")
    if avatar is None:
        avatar = {}            # omitted → keep the current avatar (name-only edit)
    elif not isinstance(avatar, dict):
        return JSONResponse({"error": "avatar must be an object."}, status_code=400)
    atype = avatar.get("type")
    aval = _clean_str(avatar.get("value"))
    avatar_url = None
    if atype == "default":
        if aval not in _list_bundled_avatars():
            return JSONResponse({"error": "Unknown default avatar."}, status_code=400)
        avatar_url = f"/static/v3/avatars/{aval}"
    elif atype == "upload":
        from safepath import safe_join
        fname = aval.rsplit("/", 1)[-1] if aval.startswith("/api/profile/avatar/") else ""
        target = safe_join(CONFIG_DIR / "avatars", fname) if fname else None
        if target is None or not target.is_file():
            return JSONResponse({"error": "Uploaded avatar not found."}, status_code=400)
        avatar_url = f"/api/profile/avatar/{fname}"
    elif atype:
        return JSONResponse({"error": "Unknown avatar type."}, status_code=400)
    # atype None/missing → keep the current avatar (name-only edit).
    return meta_db.set_profile(name, avatar_url)


@app.get("/api/profile/avatars")
def api_list_avatars():
    return [{"name": n, "url": f"/static/v3/avatars/{n}"} for n in _list_bundled_avatars()]


@app.post("/api/profile/avatar")
def api_upload_avatar(data: dict):
    """Upload a custom avatar as base64 (mirrors the album-art upload pattern).
    Re-encodes to a ≤512px PNG under CONFIG_DIR/avatars/."""
    import base64
    import io
    b64 = data.get("image", "")
    if not isinstance(b64, str) or not b64:
        return JSONResponse({"error": "No image data"}, status_code=400)
    if "," in b64:
        b64 = b64.split(",", 1)[1]
    try:
        raw = base64.b64decode(b64)
    except Exception:
        return JSONResponse({"error": "Invalid base64"}, status_code=400)
    if len(raw) > 6 * 1024 * 1024:
        return JSONResponse({"error": "Image too large (max 6 MB)."}, status_code=400)
    avatars_dir = CONFIG_DIR / "avatars"
    avatars_dir.mkdir(parents=True, exist_ok=True)
    try:
        from PIL import Image
        img = Image.open(io.BytesIO(raw)).convert("RGB")
        img.thumbnail((512, 512))
        fname = f"upload-{secrets.token_hex(4)}.png"  # token busts caches on change
        img.save(str(avatars_dir / fname), "PNG")
    except Exception as e:
        return JSONResponse({"error": f"Invalid image: {e}"}, status_code=400)
    return {"url": f"/api/profile/avatar/{fname}"}


@app.get("/api/profile/avatar/{name}")
def api_get_avatar(name: str):
    from safepath import safe_join
    target = safe_join(CONFIG_DIR / "avatars", name)
    if target is None or not target.is_file():
        return JSONResponse({"error": "not found"}, status_code=404)
    return FileResponse(str(target), media_type="image/png")


@app.get("/api/profile/progress")
def api_profile_progress():
    """One call for the whole profile badge: {level, xp, xp_in_level,
    xp_to_next, current_streak, best_streak, last_active_date}."""
    return meta_db.get_progress()


@app.post("/api/xp/award")
def api_award_xp(data: dict):
    """Award XP into the unified store. Body: {source, amount}. Returns the
    new progress payload. The single XP authority — song-play, minigames, and
    tutorials all feed this (no second curve)."""
    try:
        amount = _as_int(data.get("amount", 0))   # rejects bool / non-integral / inf
    except (TypeError, ValueError, OverflowError):
        return JSONResponse({"error": "amount must be an integer"}, status_code=400)
    # Upper-bound it: an unbounded value overflows SQLite's 64-bit INTEGER on
    # bind (→ 500) and no real run awards anywhere near this.
    if not (0 <= amount <= 10_000_000):
        return JSONResponse({"error": "amount must be between 0 and 10,000,000"}, status_code=400)
    meta_db.award_xp(amount)
    return meta_db.get_progress()


# ── Progression (spec 010): mastery rank, challenges, quests, shop ───────────

def _goal_ui_progress(goal: dict, state: dict, streak: int, xp_total: int) -> tuple:
    """(count, target) for a challenge/quest progress bar. Count goals show
    n/target; threshold goals show how far the live stat is along the line."""
    import progression as progression_mod
    gtype = goal.get("type")
    if gtype in progression_mod.COUNT_GOAL_TYPES:
        target = int(goal.get("target") or 1)
        count = target if state.get("completed") else min(int(state.get("count") or 0), target)
        return count, target
    if gtype == "streak_reached":
        target = int(goal.get("days") or 1)
        return (target if state.get("completed") else min(streak, target)), target
    if gtype == "db_earned":
        target = int(goal.get("amount") or 1)
        return (target if state.get("completed") else min(xp_total, target)), target
    return 0, 1


def _progression_overview() -> dict:
    """The full GET /api/progression payload (also the capability `inspect`
    result): rank, onboarding, per-path challenge checklists, quests, wallet."""
    import progression as progression_mod
    from datetime import datetime as _dt
    content = _get_progression_content()
    now = _dt.now()
    meta_db.ensure_quest_period(content, now)

    state = meta_db.get_progression_state()
    player_paths = meta_db.get_player_paths()
    challenge_state = meta_db.get_challenge_state()
    wallet = meta_db.get_wallet()
    streak_progress = meta_db.get_progress()
    streak = int(streak_progress.get("current_streak") or 0)
    xp_total = wallet["lifetime_db"]
    keys = progression_mod.period_keys(now)

    def _path_order(pid):
        pdef = content["paths"].get(pid) or {}
        return (pdef.get("order") or 0, pid)

    paths_payload = []
    for pid in sorted(player_paths, key=_path_order):
        pdef = content["paths"].get(pid)
        level = player_paths[pid]
        if not pdef:
            # Path selected under older content that no longer ships: keep its
            # rank contribution visible rather than silently dropping it.
            paths_payload.append({"id": pid, "name": pid, "icon": "", "level": level,
                                  "max_level": level, "next": None})
            continue
        next_block = None
        active = progression_mod.active_challenges(content, pid, level)
        if active:
            level_def = next(e for e in pdef["levels"] if e["level"] == level + 1)
            challenges = []
            completed_count = 0
            for ch in active:
                st = challenge_state.get(ch["id"]) or {}
                count, target = _goal_ui_progress(ch["goal"], st, streak, xp_total)
                if st.get("completed"):
                    completed_count += 1
                challenges.append({
                    "id": ch["id"],
                    "title": ch["title"],
                    "description": ch["description"],
                    "count": count,
                    "target": target,
                    "completed": bool(st.get("completed")),
                    "completed_at": st.get("completed_at"),
                })
            next_block = {
                "level": level + 1,
                "required": level_def["required"],
                "completed": completed_count,
                "challenges": challenges,
            }
        paths_payload.append({
            "id": pid,
            "name": pdef["name"],
            "icon": pdef["icon"],
            "level": level,
            "max_level": progression_mod.path_max_level(content, pid),
            "next": next_block,
        })

    available = [
        {"id": pid, "name": pdef["name"], "icon": pdef["icon"]}
        for pid, pdef in sorted(content["paths"].items(), key=lambda kv: (kv[1].get("order") or 0, kv[0]))
        if pid not in player_paths
    ]

    quest_rows = meta_db.get_quest_rows(keys)
    quests_payload = {}
    for period_type in ("daily", "weekly"):
        pool = content["quests"][period_type]["pool"]
        quests = []
        for row in quest_rows:
            if row["period_type"] != period_type:
                continue
            qdef = pool.get(row["quest_id"])
            if not qdef:
                continue  # removed from the pool mid-period: hide, keep the row
            count, target = _goal_ui_progress(qdef["goal"], row, streak, xp_total)
            quests.append({
                "id": row["quest_id"],
                "title": qdef["title"],
                "description": qdef["description"],
                "reward_db": row["reward_db"],
                "count": count,
                "target": target,
                "completed": row["completed"],
                "completed_at": row["completed_at"],
            })
        quests_payload[period_type] = {
            "period_key": keys[period_type],
            "resets_at": progression_mod.period_resets_at(period_type, now).isoformat(),
            "quests": quests,
        }

    return {
        "mastery_rank": progression_mod.mastery_rank(state["calibration_status"], player_paths),
        "onboarding": {
            "calibration_status": state["calibration_status"],
            "calibration_completed_at": state["calibration_completed_at"],
            "diagnostic_filename": _builtin_diagnostic_filename(),
        },
        "paths": paths_payload,
        "available_paths": available,
        "quests": quests_payload,
        "wallet": wallet,
    }


@app.get("/api/progression")
def api_progression():
    return _progression_overview()


@app.post("/api/progression/paths")
def api_progression_add_paths(data: dict):
    """Select instrument paths. Body: {add: [path_id, ...]}. Idempotent;
    removal is unsupported (Mastery Rank never decreases)."""
    add = data.get("add")
    if not isinstance(add, list) or not add:
        return JSONResponse({"error": "add must be a non-empty list of path ids"}, status_code=400)
    content = _get_progression_content()
    for pid in add:
        if not isinstance(pid, str) or pid not in content["paths"]:
            return JSONResponse({"error": f"unknown path: {pid!r}"}, status_code=400)
    meta_db.add_player_paths(add)
    return _progression_overview()


@app.post("/api/progression/onboarding")
def api_progression_onboarding(data: dict):
    """Onboarding calibration choice. Body: {action: "skip"} — completing the
    calibration needs no endpoint, it flows through the normal /api/stats path."""
    if _clean_str(data.get("action")) != "skip":
        return JSONResponse({"error": "action must be 'skip'"}, status_code=400)
    # Spec invariant: onboarding requires picking at least one instrument path
    # before finishing, so skipping straight to rank 1 with no paths would
    # leave a rank that can never grow. Only enforced when the content bundle
    # actually defines paths — broken/empty content must never brick onboarding.
    if _get_progression_content()["paths"] and not meta_db.get_player_paths():
        return JSONResponse(
            {"error": "select at least one instrument path before skipping calibration"},
            status_code=400,
        )
    meta_db.skip_calibration()
    return _progression_overview()


# Externally postable progression events. song_completed is deliberately NOT
# here: it is server-derived inside /api/stats so the scored-session authority
# stays in one place.
_PROGRESSION_EVENT_TYPES = {"minigame_run"}


@app.post("/api/progression/events")
def api_progression_events(data: dict):
    """Generic progression-event intake for plugins (capability `record-event`).
    Body: {type, payload}. Whitelisted types, scalar payload values only."""
    etype = _clean_str(data.get("type"))
    if etype not in _PROGRESSION_EVENT_TYPES:
        return JSONResponse(
            {"error": f"event type must be one of {sorted(_PROGRESSION_EVENT_TYPES)}"},
            status_code=400,
        )
    payload = data.get("payload")
    if payload is None:
        payload = {}
    if not isinstance(payload, dict) or len(payload) > 16:
        return JSONResponse({"error": "payload must be a small object"}, status_code=400)
    clean = {}
    for key, value in payload.items():
        if not isinstance(key, str) or len(key) > 64:
            return JSONResponse({"error": "payload keys must be short strings"}, status_code=400)
        if value is None:
            continue
        if isinstance(value, bool) or (
            not isinstance(value, (int, float, str))
        ) or (isinstance(value, float) and not math.isfinite(value)) or (
            isinstance(value, str) and len(value) > 256
        ):
            return JSONResponse({"error": "payload values must be short strings or finite numbers"}, status_code=400)
        clean[key] = value
    summary = meta_db.record_progression_event(etype, clean, _get_progression_content())
    return {"ok": True, "progression": summary}


@app.get("/api/shop")
def api_shop():
    content = _get_progression_content()
    owned = meta_db.get_owned_items()
    equipped = meta_db.get_equipped()
    items = [
        {**item, "owned": iid in owned, "equipped": equipped.get(item["slot"]) == iid}
        for iid, item in sorted(content["shop"].items())
    ]
    return {"items": items, "wallet": meta_db.get_wallet()}


@app.post("/api/shop/buy")
def api_shop_buy(data: dict):
    """Spend Decibels on a cosmetic. Atomic: balance check + spend + ownership
    in one transaction. Decibels are earned by playing only — never purchasable."""
    item_id = _clean_str(data.get("item_id"))
    item = _get_progression_content()["shop"].get(item_id)
    if not item:
        return JSONResponse({"error": f"unknown item: {item_id!r}"}, status_code=400)
    status, wallet = meta_db.buy_shop_item(item)
    if status == "owned":
        return JSONResponse({"error": "already owned", "wallet": wallet}, status_code=409)
    if status == "insufficient":
        return JSONResponse({"error": "insufficient balance", "wallet": wallet}, status_code=402)
    return {"ok": True, "item_id": item_id, "wallet": wallet}


@app.post("/api/shop/equip")
def api_shop_equip(data: dict):
    """Equip an owned cosmetic into its slot. Body: {slot, item_id|null}
    (null unequips, restoring the default look)."""
    import progression as progression_mod
    slot = _clean_str(data.get("slot"))
    if slot not in progression_mod.SHOP_SLOTS:
        return JSONResponse({"error": f"slot must be one of {sorted(progression_mod.SHOP_SLOTS)}"}, status_code=400)
    item_id = data.get("item_id")
    if item_id is not None:
        item_id = _clean_str(item_id)
        item = _get_progression_content()["shop"].get(item_id)
        if not item or item["slot"] != slot:
            return JSONResponse({"error": f"unknown item for slot {slot}: {item_id!r}"}, status_code=400)
        if item_id not in meta_db.get_owned_items():
            return JSONResponse({"error": "item not owned"}, status_code=403)
    return {"ok": True, "equipped": meta_db.equip_item(slot, item_id)}


# ── Per-song practice stats (fee[dB]ack v0.3.0) ───────────────────────────────

@app.post("/api/stats")
def api_record_stats(data: dict):
    """Record a play. With `score`+`accuracy` → a scored session (plays += 1,
    best_* = max, last_* = new) plus unified-XP + streak side-effects. With
    only `lastPlayPosition`/`last_position` → a lightweight resume-position
    touch (no plays change) so Continue-Playing works for non-scored plays."""
    filename = _clean_str(data.get("filename"))
    if not filename:
        return JSONResponse({"error": "filename required"}, status_code=400)
    # The recorder hands us URL-encoded filenames; canonicalize to the library
    # key so stored rows line up with `songs` (and so the arrangement-count bound
    # below resolves the real song). See MetadataDB._canonical_song_filename.
    filename = meta_db._canonical_song_filename(filename)
    arr_raw = data.get("arrangement", 0)
    if arr_raw is None:
        arrangement = 0
    else:
        try:
            arrangement = _as_int(arr_raw)   # rejects bool / non-integral (1.9) / inf
        except (TypeError, ValueError, OverflowError):
            return JSONResponse({"error": "arrangement must be a non-negative integer"}, status_code=400)
    # Reject (don't silently coerce to 0) so a malformed/out-of-range index
    # can't corrupt arrangement 0's stats; also keeps it bindable to INTEGER.
    if not (0 <= arrangement < 2**63):
        return JSONResponse({"error": "arrangement must be a non-negative integer"}, status_code=400)
    # Bound against the song's real arrangement count when it's a known library
    # song, so a bad index can't create fake arrangement buckets that poison the
    # per-song aggregate / Continue. Skipped when the song isn't in the library
    # yet (count unknown — dead-song reads are filtered anyway).
    _acount = meta_db.arrangement_count(filename)
    if _acount and arrangement >= _acount:
        return JSONResponse({"error": "arrangement out of range for this song"}, status_code=400)
    score = data.get("score")
    accuracy = data.get("accuracy")
    last_pos = data.get("lastPlayPosition", data.get("last_position"))
    if isinstance(last_pos, bool):   # float(False)=0.0 would otherwise store a bogus position
        return JSONResponse({"error": "lastPlayPosition must be a finite number"}, status_code=400)

    # A scored session needs BOTH score and accuracy. Exactly one provided is
    # ambiguous — don't silently fall through to the position-only branch.
    if (score is None) != (accuracy is None):
        return JSONResponse({"error": "score and accuracy must be provided together"}, status_code=400)

    if score is not None and accuracy is not None:
        # Reject booleans explicitly — float(True) would otherwise record a play.
        if isinstance(score, bool) or isinstance(accuracy, bool):
            return JSONResponse({"error": "score/accuracy must be finite numbers"}, status_code=400)
        # Reject NaN/Inf too: round(inf) raises OverflowError (→ 500), and a
        # stored Inf/NaN later breaks JSON serialization of /api/stats reads.
        try:
            score = float(score)
            accuracy = float(accuracy)
            if not (math.isfinite(score) and math.isfinite(accuracy)):
                raise ValueError("non-finite")
            score = int(round(score))
        except (TypeError, ValueError, OverflowError):
            return JSONResponse({"error": "score/accuracy must be finite numbers"}, status_code=400)
        # A huge-but-finite score passes isfinite() yet overflows SQLite's
        # 64-bit INTEGER on bind (→ 500). Bound it to the int64 range.
        if not (0 <= score < 2**63):
            return JSONResponse({"error": "score out of range"}, status_code=400)
        # accuracy is a 0..1 fraction (the recorder's contract); reject
        # out-of-range values so they don't surface as >100% / negative in
        # /api/stats/best and the badge UI.
        if not (0 <= accuracy <= 1):
            return JSONResponse({"error": "accuracy must be between 0 and 1"}, status_code=400)
        # Validate the optional resume position in this branch too (the
        # position-only branch below already rejects non-finite).
        if last_pos is not None:
            try:
                last_pos = float(last_pos)
                if not math.isfinite(last_pos):
                    raise ValueError("non-finite")
            except (TypeError, ValueError, OverflowError):
                return JSONResponse({"error": "lastPlayPosition must be a finite number"}, status_code=400)
        row = meta_db.record_session(filename, arrangement, score=score,
                                     accuracy=accuracy, last_position=last_pos)
        # Unified XP + streak side-effects — never let these drop the stat write.
        progress = None
        try:
            from xp import xp_for_run
            from datetime import date
            meta_db.award_xp(xp_for_run(score))
            meta_db.record_active_day(date.today().isoformat())
            progress = meta_db.get_progress()
        except Exception:
            log.warning("stats side-effects (xp/streak) failed", exc_info=True)
        # Progression engine (spec 010) — same never-drop-the-stat-write
        # contract. Scored sessions are the server-derived `song_completed`
        # authority (scored == note detection by construction); instrument is
        # resolved from library arrangement metadata, after the XP award so
        # db_earned goals see this run's Decibels.
        progression_summary = None
        try:
            import progression as progression_mod
            instrument = progression_mod.instrument_for_arrangement(
                meta_db.arrangement_entry(filename, arrangement)
            )
            progression_summary = meta_db.record_progression_event(
                "song_completed",
                {
                    "filename": filename,
                    "instrument": instrument,
                    "accuracy": accuracy,
                    "score": score,
                    "is_diagnostic": filename == _builtin_diagnostic_filename(),
                },
                _get_progression_content(),
            )
        except Exception:
            log.warning("stats side-effects (progression) failed", exc_info=True)
        return {"stats": row, "progress": progress, "progression": progression_summary}

    # Position-only touch.
    if last_pos is None:
        return JSONResponse(
            {"error": "provide score+accuracy (scored) or lastPlayPosition (resume)"},
            status_code=400,
        )
    try:
        pos = float(last_pos)
        if not math.isfinite(pos):
            raise ValueError("non-finite")
        row = meta_db.touch_position(filename, arrangement, pos)
    except (TypeError, ValueError, OverflowError):
        return JSONResponse({"error": "lastPlayPosition must be a finite number"}, status_code=400)
    # A resume session still counts as playing today: advance the streak (no XP —
    # that's scoring-only) so a non-scored practice day keeps the streak alive,
    # consistent with these sessions also surfacing in recent / continue.
    progress = None
    try:
        from datetime import date
        meta_db.record_active_day(date.today().isoformat())
        progress = meta_db.get_progress()
    except Exception:
        log.warning("stats side-effects (streak) failed", exc_info=True)
    return {"stats": row, "progress": progress}


@app.get("/api/stats/recent")
def api_recent_stats(limit: int = 12):
    """Recently-played rows joined to song metadata for 'Jump back in'."""
    from urllib.parse import quote
    out = []
    for r in meta_db.recent_stats(limit):
        meta = meta_db.conn.execute(
            "SELECT title, artist, tuning_name FROM songs WHERE filename = ?",
            (r["filename"],),
        ).fetchone()
        title, artist, tuning_name = meta if meta else (None, None, None)
        out.append({
            **r,
            "title": title or r["filename"],
            "artist": artist or "",
            "tuning_name": tuning_name or "",
            "art_url": f"/api/song/{quote(r['filename'])}/art",
        })
    return out


@app.get("/api/stats/best")
def api_stats_best():
    """{filename: best_accuracy} for all songs with a recorded best — one call
    to badge the library grid (defined before the {filename} catch-all)."""
    return meta_db.best_accuracy_map()


@app.get("/api/stats/top")
def api_top_stats(limit: int = 5):
    """Top scored songs (best first), joined to song metadata, for the profile
    'Your best scores' panel (defined before the {filename} catch-all)."""
    from urllib.parse import quote
    out = []
    for r in meta_db.top_stats(limit):
        meta = meta_db.conn.execute(
            "SELECT title, artist, tuning_name FROM songs WHERE filename = ?",
            (r["filename"],),
        ).fetchone()
        title, artist, tuning_name = meta if meta else (None, None, None)
        out.append({
            **r,
            "title": title or r["filename"],
            "artist": artist or "",
            "tuning_name": tuning_name or "",
            "art_url": f"/api/song/{quote(r['filename'])}/art",
        })
    return out


@app.get("/api/library/practice-suggestions")
def api_practice_suggestions(limit: int = 8):
    """Growth-edge 'practice next' shelf (P3): attempted-but-not-mastered songs
    ranked by difficulty-appropriateness × mastery-proximity, joined to song
    metadata. Replaces the recency-only 'Keep practicing' shelf ordering. Local
    library only — reads local practice stats."""
    from urllib.parse import quote
    out = []
    for r in meta_db.growth_edge_suggestions(limit):
        meta = meta_db.conn.execute(
            "SELECT title, artist, tuning_name FROM songs WHERE filename = ?",
            (r["filename"],),
        ).fetchone()
        title, artist, tuning_name = meta if meta else (None, None, None)
        out.append({
            **r,
            "title": title or r["filename"],
            "artist": artist or "",
            "tuning_name": tuning_name or "",
            "art_url": f"/api/song/{quote(r['filename'])}/art",
        })
    return out


@app.get("/api/stats/{filename:path}")
def api_song_stats(filename: str):
    return meta_db.get_song_stats(filename)


# ── Playlists / Saved for Later / Continue-Playing (fee[dB]ack v0.3.0) ────────

def _playlist_cover_path(pid) -> Path | None:
    """Filesystem path of a playlist's optional custom cover image (PNG),
    stored under CONFIG_DIR. Returns None for a non-integer id."""
    try:
        pid = int(pid)
    except (TypeError, ValueError):
        return None
    return CONFIG_DIR / "playlist_covers" / f"{pid}.png"


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


@app.get("/api/playlists")
def api_list_playlists():
    lists = meta_db.list_playlists()
    for pl in lists:
        pl["cover_url"] = _playlist_cover_url(pl["id"])
    return lists


@app.post("/api/playlists")
def api_create_playlist(data: dict):
    name = _clean_str(data.get("name"))
    if not (1 <= len(name) <= 100):
        return JSONResponse({"error": "Playlist name must be 1–100 characters."}, status_code=400)
    # kind='album' = a curated album (§7.2): hand-picked works, a chosen chart
    # per slot, played front-to-back on the queue. Absent/None = a regular mix.
    kind = _clean_str(data.get("kind")) or None
    if kind not in (None, "album"):
        return JSONResponse({"error": "kind must be 'album' or omitted"}, status_code=400)
    return meta_db.create_playlist(name, kind=kind)


@app.get("/api/playlists/{pid}")
def api_get_playlist(pid: int):
    pl = meta_db.get_playlist(pid)
    if pl is None:
        return JSONResponse({"error": "not found"}, status_code=404)
    pl["cover_url"] = _playlist_cover_url(pid)
    return pl


@app.patch("/api/playlists/{pid}")
def api_rename_playlist(pid: int, data: dict):
    pl = meta_db.get_playlist(pid)
    if pl is None:
        return JSONResponse({"error": "not found"}, status_code=404)
    if pl["system_key"]:
        return JSONResponse({"error": "System playlists cannot be renamed."}, status_code=400)
    name = _clean_str(data.get("name"))
    if not (1 <= len(name) <= 100):
        return JSONResponse({"error": "Playlist name must be 1–100 characters."}, status_code=400)
    meta_db.rename_playlist(pid, name)
    return meta_db.get_playlist(pid)


@app.delete("/api/playlists/{pid}")
def api_delete_playlist(pid: int):
    pl = meta_db.get_playlist(pid)
    if pl is None:
        return JSONResponse({"error": "not found"}, status_code=404)
    if pl["system_key"]:
        return JSONResponse({"error": "System playlists cannot be deleted."}, status_code=400)
    if not meta_db.delete_playlist(pid):   # vanished under us (concurrent delete)
        return JSONResponse({"error": "not found"}, status_code=404)
    cover = _playlist_cover_path(pid)       # drop any custom cover with the playlist
    if cover and cover.exists():
        try:
            cover.unlink()
        except OSError:
            pass
    return {"ok": True}


@app.post("/api/playlists/{pid}/songs")
def api_add_playlist_song(pid: int, data: dict):
    if meta_db.get_playlist(pid) is None:
        return JSONResponse({"error": "not found"}, status_code=404)
    filename = _clean_str(data.get("filename"))
    if not filename:
        return JSONResponse({"error": "filename required"}, status_code=400)
    if meta_db.add_playlist_song(pid, filename) is None:   # playlist vanished under us
        return JSONResponse({"error": "not found"}, status_code=404)
    pl = meta_db.get_playlist(pid)
    return pl if pl is not None else JSONResponse({"error": "not found"}, status_code=404)


@app.patch("/api/playlists/{pid}/songs/{filename:path}")
def api_update_playlist_slot(pid: int, filename: str, data: dict):
    """Edit one curated-album slot: {"arrangement": name|null} pins/clears the
    slot's arrangement; {"chart_filename": fn} swaps the slot to another chart
    of the same work (position + pin kept). Albums only — a mix has no slots."""
    pl = meta_db.get_playlist(pid)
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
    if meta_db.update_playlist_slot(pid, filename, **kwargs) is None:
        return JSONResponse(
            {"error": "no such slot, or the chart isn't a version of this song"},
            status_code=400)
    return meta_db.get_playlist(pid)


@app.delete("/api/playlists/{pid}/songs/{filename:path}")
def api_remove_playlist_song(pid: int, filename: str):
    if meta_db.get_playlist(pid) is None:
        return JSONResponse({"error": "not found"}, status_code=404)
    meta_db.remove_playlist_song(pid, filename)
    pl = meta_db.get_playlist(pid)
    return pl if pl is not None else JSONResponse({"error": "not found"}, status_code=404)


@app.post("/api/playlists/{pid}/reorder")
def api_reorder_playlist(pid: int, data: dict):
    pl = meta_db.get_playlist(pid)
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
    meta_db.reorder_playlist(pid, order)
    return meta_db.get_playlist(pid)


@app.post("/api/playlists/{pid}/cover")
async def api_set_playlist_cover(pid: int, data: dict):
    """Set a playlist's custom cover from a base64 / data-URL image (PNG/JPG).
    Overrides the content-dependent (song-art) cover. Stored as a small PNG
    thumbnail under CONFIG_DIR/playlist_covers/."""
    if meta_db.get_playlist(pid) is None:
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


@app.get("/api/playlists/{pid}/cover")
def api_get_playlist_cover(pid: int):
    cover = _playlist_cover_path(pid)
    if not cover or not cover.exists():
        return JSONResponse({"error": "not found"}, status_code=404)
    # no-cache (revalidate) like song art, so a replaced cover is never served
    # stale — pairs with the mtime-ns cache-bust token on the URL.
    return FileResponse(str(cover), media_type="image/png", headers=_ART_CACHE_HEADERS)


@app.delete("/api/playlists/{pid}/cover")
def api_delete_playlist_cover(pid: int):
    cover = _playlist_cover_path(pid)
    if cover and cover.exists():
        try:
            cover.unlink()
        except OSError:
            pass
    return {"ok": True}


# ── Smart collections API (feedBack#636 item 2) ───────────────────────────────
# (rule schema + `_sanitize_collection_rules` are defined with the provider.)

@app.get("/api/collections")
def api_list_collections():
    """Smart/dynamic collections (saved live library filters)."""
    return {"collections": meta_db.list_collections()}


@app.post("/api/collections")
def api_create_collection(data: dict):
    """Create a collection from a name + a set of library filter rules. It
    immediately appears as a source in the library provider picker."""
    if not isinstance(data, dict):
        return JSONResponse({"error": "body must be an object"}, status_code=400)
    name = _clean_str(data.get("name"))
    if not name:
        return JSONResponse({"error": "name required"}, status_code=400)
    col = meta_db.create_collection(name, _sanitize_collection_rules(data.get("rules")))
    _sync_collection_provider(col)
    return {"ok": True, "collection": col}


@app.put("/api/collections/{pid}")
def api_update_collection(pid: int, data: dict):
    """Rename a collection and/or replace its rules."""
    if not isinstance(data, dict):
        return JSONResponse({"error": "body must be an object"}, status_code=400)
    name = _clean_str(data.get("name")) or None
    rules = _sanitize_collection_rules(data["rules"]) if "rules" in data else None
    col = meta_db.update_collection(pid, name=name, rules=rules)
    if col is None:
        return JSONResponse({"error": "collection not found"}, status_code=404)
    _sync_collection_provider(col)
    return {"ok": True, "collection": col}


@app.delete("/api/collections/{pid}")
def api_delete_collection(pid: int):
    """Delete a collection and unregister its provider."""
    if not meta_db.is_collection(pid):
        return JSONResponse({"error": "collection not found"}, status_code=404)
    meta_db.delete_playlist(pid)
    _unregister_collection_provider(pid)
    return {"ok": True}


@app.post("/api/saved/toggle")
def api_toggle_saved(data: dict):
    """Add/remove a song on the reserved Saved-for-Later playlist."""
    filename = _clean_str(data.get("filename"))
    if not filename:
        return JSONResponse({"error": "filename required"}, status_code=400)
    return {"saved": meta_db.toggle_saved(filename)}


@app.get("/api/session/continue")
def api_session_continue():
    """The Continue-Playing card's song (most recent play) or null."""
    return meta_db.continue_session()


# ── Wishlist / "wanted" API (feedBack#636 item 4) ─────────────────────────────

@app.get("/api/wanted")
def api_list_wanted():
    """The wishlist — songs the user wants but doesn't own yet (newest first)."""
    return {"wanted": meta_db.list_wanted()}


@app.post("/api/wanted")
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
    row = meta_db.add_wanted(
        artist=artist, title=title,
        source=_clean_str(data.get("source")) or "manual",
        source_ref=_clean_str(data.get("source_ref")),
        note=_clean_str(data.get("note")),
    )
    return {"ok": True, "wanted": row}


@app.delete("/api/wanted/{wanted_id}")
def api_remove_wanted(wanted_id: int):
    """Remove a wishlist entry by id."""
    return {"ok": meta_db.remove_wanted(wanted_id)}


# ── Loops API ────────────────────────────────────────────────────────────────

@app.get("/api/loops")
def list_loops(filename: str):
    rows = meta_db.conn.execute(
        "SELECT id, name, start_time, end_time FROM loops WHERE filename = ? ORDER BY start_time",
        (filename,)
    ).fetchall()
    return [{"id": r[0], "name": r[1], "start": r[2], "end": r[3]} for r in rows]


@app.post("/api/loops")
def save_loop(data: dict):
    filename = data.get("filename", "")
    name = data.get("name", "").strip()
    start = data.get("start")
    end = data.get("end")
    if not filename or start is None or end is None:
        return {"error": "Missing fields"}
    if not name:
        count = meta_db.conn.execute(
            "SELECT COUNT(*) FROM loops WHERE filename = ?", (filename,)
        ).fetchone()[0]
        name = f"Loop {count + 1}"
    with meta_db._lock:
        meta_db.conn.execute(
            "INSERT INTO loops (filename, name, start_time, end_time) VALUES (?, ?, ?, ?)",
            (filename, name, float(start), float(end))
        )
        meta_db.conn.commit()
    return {"ok": True, "name": name}


@app.delete("/api/loops/{loop_id}")
def delete_loop(loop_id: int):
    with meta_db._lock:
        meta_db.conn.execute("DELETE FROM loops WHERE id = ?", (loop_id,))
        meta_db.conn.commit()
    return {"ok": True}


# ── Audio Effects Mapping API ───────────────────────────────────────────────

def _audio_effects_error(exc: Exception):
    return JSONResponse({"error": str(exc)}, status_code=400)


@app.get("/api/audio-effects/mappings")
def list_audio_effect_mappings(
    song_key: str = Query(""),
    filename: str = Query(""),
    tone_key: str = Query(""),
    provider_id: str = Query(""),
):
    try:
        return {
            "mappings": audio_effect_mappings.list(
                song_key=song_key,
                filename=filename,
                tone_key=tone_key,
                provider_id=provider_id,
            )
        }
    except ValueError as exc:
        return _audio_effects_error(exc)


@app.post("/api/audio-effects/mappings")
def upsert_audio_effect_mapping(data: dict = Body(...)):
    try:
        mapping = audio_effect_mappings.upsert(data)
    except ValueError as exc:
        return _audio_effects_error(exc)
    return {"ok": True, "mapping": mapping}


@app.delete("/api/audio-effects/mappings/{mapping_id}")
def delete_audio_effect_mapping(mapping_id: int, provider_id: str = Query("")):
    try:
        deleted = audio_effect_mappings.delete(mapping_id, provider_id=provider_id)
    except ValueError as exc:
        return _audio_effects_error(exc)
    if not deleted:
        return JSONResponse({"error": "mapping not found"}, status_code=404)
    return {"ok": True}


@app.post("/api/audio-effects/mappings/{mapping_id}/activate")
def activate_audio_effect_mapping(mapping_id: int, data: dict = Body(default_factory=dict)):
    try:
        provider_id = data.get("provider_id") if "provider_id" in data else data.get("providerId")
        mapping = audio_effect_mappings.activate(mapping_id, provider_id="" if provider_id is None else provider_id)
    except ValueError as exc:
        return _audio_effects_error(exc)
    if not mapping:
        return JSONResponse({"error": "mapping not found"}, status_code=404)
    return {"ok": True, "mapping": mapping}


@app.delete("/api/audio-effects/active-mapping")
def clear_audio_effect_active_mapping(song_key: str = Query(...), tone_key: str = Query("")):
    try:
        cleared = audio_effect_mappings.clear_active(song_key=song_key, tone_key=tone_key)
    except ValueError as exc:
        return _audio_effects_error(exc)
    return {"ok": True, "cleared": cleared}


# ── Settings API ──────────────────────────────────────────────────────────────

# Serializes the read-modify-write in save_settings(). See the note there.
_settings_lock = threading.Lock()


def _default_settings():
    """Fallback settings returned when config.json is missing or
    unreadable. Also used to seed a fresh cfg on first-run POSTs so a
    single-key write (e.g. the difficulty slider) can't silently wipe
    defaults that subsequent GETs would have exposed."""
    # Same `_DLC_DIR_ENV` truthy check as `_get_dlc_dir`: an empty env
    # var collapses to `Path(".")` whose `.is_dir()` is True, so without
    # the explicit guard we'd surface `"."` to /api/settings — and any
    # partial-update POST would then persist that into config.json,
    # silently undoing the env-var fix on the next load.
    return {
        "dlc_dir": str(DLC_DIR) if (_DLC_DIR_ENV and DLC_DIR.is_dir()) else "",
        # fee[dB]ack v0.3.0 gameplay settings (tabbed settings page). Each
        # defaults to its neutral / off value so existing users see no
        # behaviour change until they opt in. countdown_before_song is wired
        # into the song-start path; miss_penalty / fail_behavior are persisted
        # but not yet consumed by scoring (stub rows on the Gameplay tab).
        "countdown_before_song": False,
        "miss_penalty": "none",
        "fail_behavior": "continue",
        # Achievements epic: opt-in to publishing earned Feats (name + Feat id
        # only) to the hosted wall. Default OFF — nothing leaves the device
        # until the user opts in. Read by the bundled achievements plugin to
        # gate its wall-sync enqueue.
        "achievements_enabled": False,
        # Amp-sim opt-in (issue feedBack-desktop#46). Whether the desktop app may
        # auto-load an in-app amp-sim / tone chain (NAM / IR / VST) for input
        # monitoring. Default OFF — "own-rig first": players monitoring through
        # their own external amp/rig never get a processed monitor (and never the
        # idle distorted buzz) until they opt in. Set during onboarding (desktop
        # only) and from the desktop Audio settings toggle; read by the desktop
        # renderer to gate its saved-chain restore. Inert on the pure-web build,
        # which has no native amp sims.
        "use_amp_sims": False,
    }


def _load_config(config_file):
    """Read and parse config.json. Returns the parsed dict, or None if
    the file is missing, unreadable, invalid JSON, or parses to a
    non-dict (e.g. the file contains `[]` or `42`). Callers treat None
    as "fall back to defaults". Shared between GET and POST so both
    handle bad files the same way."""
    if not config_file.exists():
        return None
    try:
        # Explicit UTF-8: save_settings()/import write config.json as
        # UTF-8 bytes, so the read must not depend on the platform's
        # default text encoding (cp1252 on Windows would mojibake or
        # UnicodeDecodeError on a non-ASCII DLC path).
        parsed = json.loads(config_file.read_text(encoding="utf-8"))
    except Exception:
        return None
    return parsed if isinstance(parsed, dict) else None


@app.get("/api/tunings")
def get_tunings():
    cfg = _load_config(CONFIG_DIR / "config.json") or {}
    ref = cfg.get("reference_pitch", DEFAULT_REFERENCE_PITCH)
    try:
        ref = float(ref)
        if not (430.0 <= ref <= 450.0):
            ref = DEFAULT_REFERENCE_PITCH
    except (TypeError, ValueError):
        ref = DEFAULT_REFERENCE_PITCH
    return {"referencePitch": ref, "tunings": tuning_providers.get_merged(ref)}


@app.get("/api/settings")
def get_settings():
    cfg = _load_config(CONFIG_DIR / "config.json")
    return cfg if cfg is not None else _default_settings()


@app.post("/api/settings")
def save_settings(data: dict):
    # Partial-update: merge only keys present in the request body so
    # single-key POSTs (like the difficulty slider's oninput) don't
    # clobber unrelated settings on disk.
    #
    # Validation runs FIRST, outside _settings_lock. The dlc_dir branch
    # stats the folder and counts sloppak files, which can be slow on a
    # large or networked DLC dir — holding the lock across it would block
    # every other settings writer (dropdown/slider autosaves, imports).
    # So validation only resolves `updates` (the keys to merge); the
    # short read-merge-write critical section at the end takes the lock.
    config_file = CONFIG_DIR / "config.json"
    updates: dict = {}
    messages: list[str] = []

    if "dlc_dir" in data:
        dlc_path = data["dlc_dir"]
        # null / missing is no-op (preserve on-disk value). Only an
        # explicit empty string means "clear". Non-string values are
        # rejected so Path(...) can't be surprised by non-str JSON.
        if dlc_path is None:
            pass
        elif not isinstance(dlc_path, str):
            return {"error": "dlc_dir must be a string path or empty"}
        elif dlc_path == "":
            updates["dlc_dir"] = ""
        else:
            if Path(dlc_path).is_dir():
                updates["dlc_dir"] = dlc_path
                count = sum(1 for f in Path(dlc_path).iterdir()
                            if f.suffix.lower() in sloppak_mod.SONG_EXTS)
                messages.append(f"DLC folder: {count} song files found")
            else:
                return {"error": f"DLC directory not found: {dlc_path}"}

    # Both of these are consumed downstream as strings (e.g.
    # demucs_server_url.rstrip('/')), so reject non-string shapes
    # here. Matches the dlc_dir pattern above:
    # null is no-op, empty string clears, non-string is a structured
    # error that preserves the on-disk value.
    for key in ("default_arrangement", "demucs_server_url"):
        if key in data:
            raw = data[key]
            if raw is None:
                pass
            elif not isinstance(raw, str):
                return {"error": f"{key} must be a string or empty"}
            else:
                updates[key] = raw
    if "master_difficulty" in data:
        # Coerce defensively — public endpoint, so `null`, `""`, or a
        # non-numeric string shouldn't 500 the request. float() accepts
        # both integer and float-shaped strings; anything else returns
        # a structured error like the dlc_dir branch above.
        raw = data["master_difficulty"]
        # Reject bool explicitly: Python makes bool a subclass of int, so
        # True/False would otherwise coerce to 1/0 and persist as a valid
        # difficulty. Caller almost certainly means "bad input".
        if isinstance(raw, bool):
            return {"error": "master_difficulty must be a number between 0 and 100"}
        try:
            updates["master_difficulty"] = max(0, min(100, int(float(raw))))
        except (TypeError, ValueError, OverflowError):
            # OverflowError covers int(float("inf")) / int(float("1e309"))
            # which Python raises distinctly from ValueError.
            return {"error": "master_difficulty must be a number between 0 and 100"}

    if "av_offset_ms" in data:
        # Audio-output pipeline latency compensation. Positive values
        # mean audio is running ahead of visuals; the highway adds
        # this to its render clock to catch the visuals up. Clamped
        # to ±1000 ms to mirror the client-side slider — a direct
        # POST shouldn't be able to persist `1e9`. Same defensive
        # coercion shape as master_difficulty above (reject bool,
        # cover OverflowError, structured 4xx-style return on bad
        # input rather than 500).
        raw = data["av_offset_ms"]
        if isinstance(raw, bool):
            return {"error": "av_offset_ms must be a number between -1000 and 1000"}
        try:
            updates["av_offset_ms"] = max(-1000.0, min(1000.0, float(raw)))
        except (TypeError, ValueError, OverflowError):
            return {"error": "av_offset_ms must be a number between -1000 and 1000"}

    # fee[dB]ack v0.3.0 gameplay settings (tabbed settings page). null is a
    # no-op per the merge contract; bad shapes return a structured error
    # rather than 500. countdown_before_song is consumed by the song-start
    # count-in; miss_penalty / fail_behavior are persisted-only stubs.
    if "countdown_before_song" in data:
        raw = data["countdown_before_song"]
        if raw is not None:
            if not isinstance(raw, bool):
                return {"error": "countdown_before_song must be a boolean"}
            updates["countdown_before_song"] = raw
    if "achievements_enabled" in data:
        raw = data["achievements_enabled"]
        if raw is not None:
            if not isinstance(raw, bool):
                return {"error": "achievements_enabled must be a boolean"}
            updates["achievements_enabled"] = raw
    if "use_amp_sims" in data:
        raw = data["use_amp_sims"]
        if raw is not None:
            if not isinstance(raw, bool):
                return {"error": "use_amp_sims must be a boolean"}
            updates["use_amp_sims"] = raw
    if "miss_penalty" in data:
        raw = data["miss_penalty"]
        if raw is not None:
            if not isinstance(raw, str) or raw not in ("none", "low", "medium", "high"):
                return {"error": "miss_penalty must be one of none, low, medium, high"}
            updates["miss_penalty"] = raw
    if "fail_behavior" in data:
        raw = data["fail_behavior"]
        if raw is not None:
            if not isinstance(raw, str) or raw not in ("continue", "restart", "stop"):
                return {"error": "fail_behavior must be one of continue, restart, stop"}
            updates["fail_behavior"] = raw

    # fee[dB]ack v0.3.0 — tuner reference pitch + instrument selection.
    # These drive the topbar tuner/instrument badges and (when installed) the
    # note_detect scoring tuning tables. null is a no-op per the merge contract.
    if "reference_pitch" in data:
        raw = data["reference_pitch"]
        if raw is not None:
            if isinstance(raw, bool):
                return {"error": "reference_pitch must be a number between 430 and 450"}
            try:
                rp = float(raw)
            except (TypeError, ValueError, OverflowError):
                return {"error": "reference_pitch must be a number between 430 and 450"}
            # Reject non-finite rather than letting min/max silently clamp
            # NaN/Inf (and "nan"/"inf") to 430/450.
            if not math.isfinite(rp):
                return {"error": "reference_pitch must be a number between 430 and 450"}
            updates["reference_pitch"] = max(430.0, min(450.0, rp))
    if "instrument" in data:
        raw = data["instrument"]
        if raw is not None:
            if not isinstance(raw, str) or raw not in ("guitar", "bass"):
                return {"error": "instrument must be 'guitar' or 'bass'"}
            updates["instrument"] = raw
    if "string_count" in data:
        raw = data["string_count"]
        if raw is not None:
            try:
                sc = _as_int(raw)   # rejects bool / non-integral (4.9) / inf
            except (TypeError, ValueError, OverflowError):
                return {"error": "string_count must be an integer 4–8"}
            if sc < 4 or sc > 8:
                return {"error": "string_count must be an integer 4–8"}
            updates["string_count"] = sc
    if "tuning" in data:
        raw = data["tuning"]
        # Accept a tuning NAME (string ≤64) or a list of up to 8 semitone
        # offsets (ints −12..12). null is a no-op.
        if raw is not None:
            if isinstance(raw, str):
                if len(raw) > 64:
                    return {"error": "tuning name too long"}
                updates["tuning"] = raw
            elif isinstance(raw, list):
                if len(raw) > 8 or any(isinstance(o, bool) or not isinstance(o, int) or o < -12 or o > 12 for o in raw):
                    return {"error": "tuning offsets must be ≤8 integers between -12 and 12"}
                updates["tuning"] = raw
            else:
                return {"error": "tuning must be a name (string) or a list of semitone offsets"}

    CONFIG_DIR.mkdir(parents=True, exist_ok=True)
    # Critical section — the read-merge-write must be atomic. FastAPI runs
    # sync handlers in a threadpool, so two concurrent partial POSTs (e.g.
    # the two Settings dropdowns auto-saving back-to-back) could each read
    # the pre-write file and the second write would silently drop the
    # first's key. /api/settings/import shares _settings_lock for the same
    # reason. The seed-from-_default_settings() guards a missing/unreadable
    # /non-dict config.json so the merge can't TypeError and 500 the
    # endpoint. The write is atomic temp+rename so a concurrent reader
    # (export, get_settings, the _get_dlc_dir fallback) never sees a torn
    # file.
    with _settings_lock:
        cfg = _load_config(config_file)
        if cfg is None:
            cfg = _default_settings()
        cfg.update(updates)
        _atomic_write_file(config_file, json.dumps(cfg, indent=2).encode("utf-8"))
    return {"message": ". ".join(messages) if messages else "Settings saved"}


# Keys a client "Reset {category}" action may clear. Resetting removes the key
# from config.json so the next GET falls back to the _default_settings() value
# (or the frontend's own default when the key is then absent). Restricting to a
# known set means a malformed or hostile body can't wipe unrelated config.
_RESETTABLE_SETTINGS_KEYS = frozenset({
    "default_arrangement", "demucs_server_url", "master_difficulty",
    "av_offset_ms", "countdown_before_song", "miss_penalty", "fail_behavior",
    "reference_pitch", "instrument", "string_count", "tuning",
    "achievements_enabled", "use_amp_sims",
})


@app.post("/api/settings/reset")
def reset_settings(data: dict):
    """Clear the given settings keys back to their defaults — backs the
    per-category "Reset" buttons on the tabbed settings page. Unknown keys are
    ignored (not an error) so a newer client asking to reset a key an older
    server doesn't recognise degrades gracefully. Shares _settings_lock with
    save_settings()/import for the same read-merge-write atomicity reason."""
    raw_keys = data.get("keys")
    if not isinstance(raw_keys, list):
        return {"error": "keys must be a list of setting names"}
    keys = [k for k in raw_keys if isinstance(k, str) and k in _RESETTABLE_SETTINGS_KEYS]
    config_file = CONFIG_DIR / "config.json"
    with _settings_lock:
        cfg = _load_config(config_file)
        if cfg is None:
            # Nothing persisted yet — already at defaults.
            return {"message": "Settings reset", "reset": []}
        removed = [k for k in keys if k in cfg]
        for k in removed:
            del cfg[k]
        _atomic_write_file(config_file, json.dumps(cfg, indent=2).encode("utf-8"))
    return {"message": "Settings reset", "reset": removed}


# ── Settings export/import (feedBack#113) ───────────────────────────────────

# Bumped only when the bundle JSON shape changes incompatibly. Importer
# refuses anything but this exact value — version mismatches are warned
# but not blocked, schema mismatches ARE blocked.
SETTINGS_BUNDLE_SCHEMA = 1


def _running_version() -> str:
    """Same lookup chain `/api/version` uses, factored out so the export
    bundle records what shipped this file. Kept as a helper so future
    changes (e.g. baked-in version) only have to touch one site."""
    env_version = os.environ.get("APP_VERSION", "").strip()
    if env_version:
        return env_version
    version_file = Path(__file__).parent / "VERSION"
    if version_file.exists():
        try:
            return version_file.read_text().strip()
        except (OSError, UnicodeDecodeError):
            pass
    return "unknown"


def _validate_server_config_types(cfg: dict) -> str | None:
    """Type-and-range gate for the server_config block of an import
    bundle, mirroring the per-key checks in `POST /api/settings`. The
    importer writes config.json verbatim, so without this gate a
    hand-edited bundle could persist a non-string `demucs_server_url`
    (which downstream code calls `.rstrip('/')` on and crashes) or an
    out-of-range `master_difficulty` (which bypasses the slider's
    clamp). Returns None on success, an error string on the first
    violation. Filesystem-existence checks (e.g. dlc_dir is_dir) are
    NOT performed here — restoring a bundle on a different machine
    legitimately may reference paths that don't exist locally yet,
    and the `POST /api/settings` interactive endpoint is the right
    place for that ergonomic check, not the bulk-restore path.
    Unknown keys are passed through so future settings (and per-plugin
    keys that may be added later) round-trip without code changes
    here."""
    if "dlc_dir" in cfg:
        v = cfg["dlc_dir"]
        if v is not None and not isinstance(v, str):
            return "server_config.dlc_dir must be a string"
    for key in ("default_arrangement", "demucs_server_url"):
        if key in cfg:
            v = cfg[key]
            if v is not None and not isinstance(v, str):
                return f"server_config.{key} must be a string"
    if "master_difficulty" in cfg:
        v = cfg["master_difficulty"]
        # bool is an int subclass — reject explicitly so True/False
        # don't quietly persist as 1/0 difficulty values.
        if isinstance(v, bool) or not isinstance(v, (int, float)):
            return "server_config.master_difficulty must be a number between 0 and 100"
        if not (0 <= v <= 100):
            return "server_config.master_difficulty must be between 0 and 100"
    if "av_offset_ms" in cfg:
        v = cfg["av_offset_ms"]
        if isinstance(v, bool) or not isinstance(v, (int, float)):
            return "server_config.av_offset_ms must be a number between -1000 and 1000"
        if not (-1000 <= v <= 1000):
            return "server_config.av_offset_ms must be between -1000 and 1000"
    # fee[dB]ack v0.3.0 tuner/instrument keys — keep in sync with POST /api/settings.
    if "reference_pitch" in cfg:
        v = cfg["reference_pitch"]
        if v is not None and (isinstance(v, bool) or not isinstance(v, (int, float)) or not (430 <= v <= 450)):
            return "server_config.reference_pitch must be a number between 430 and 450"
    if "instrument" in cfg:
        v = cfg["instrument"]
        if v is not None and v not in ("guitar", "bass"):
            return "server_config.instrument must be 'guitar' or 'bass'"
    if "string_count" in cfg:
        v = cfg["string_count"]
        if v is not None and (isinstance(v, bool) or not isinstance(v, int) or not (4 <= v <= 8)):
            return "server_config.string_count must be an integer between 4 and 8"
    if "tuning" in cfg:
        v = cfg["tuning"]
        if v is not None:
            if isinstance(v, str):
                if len(v) > 64:
                    return "server_config.tuning name too long"
            elif isinstance(v, list):
                if len(v) > 8 or any(isinstance(o, bool) or not isinstance(o, int) or o < -12 or o > 12 for o in v):
                    return "server_config.tuning offsets must be ≤8 integers between -12 and 12"
            else:
                return "server_config.tuning must be a name (string) or a list of semitone offsets"
    return None


class _UndeclaredFile(ValueError):
    """Raised when a relpath would otherwise be safe but isn't covered by
    the plugin's manifest allowlist. Distinct from the generic
    `ValueError` so the import handler can warn-and-skip this case
    without resorting to message-string matching (which would silently
    change behavior on a future error-text refactor)."""


def _matches_allowlist(relpath: str, allowed: list[str]) -> bool:
    """Return True if `relpath` is covered by an entry in the manifest's
    `_export_paths`. Entries ending in `/` are directory rules
    (strict prefix-match); other entries are exact-file rules. Both
    `relpath` and `allowed` are POSIX strings already normalized
    through `_normalize_export_paths` on the loader side. Caller is
    expected to pass an already-normalized relpath — `_validate_relpath`
    enforces this so a bundle can't satisfy a prefix rule with a
    string that later normalizes to a different target."""
    for allow in allowed:
        if allow.endswith("/"):
            # Strict prefix match only. We deliberately reject
            # `relpath == prefix.rstrip("/")` — a directory entry
            # never authorizes writing AT the directory itself, and
            # accepting that would let phase 2 try to `os.replace()`
            # over an existing directory and crash mid-apply.
            if relpath.startswith(allow):
                return True
        elif relpath == allow:
            return True
    return False


def _validate_relpath(relpath: str, allowed: list[str], config_dir: Path) -> Path:
    """Resolve `relpath` to an absolute path under `config_dir`, raising
    on anything that smells like path-traversal, an absolute path, or
    a manifest-undeclared file. Layered defenses:

      1. String-level: reject backslash, drive letter, absolute, and
         any `.` / `..` segment in the *raw* input — BEFORE any
         normalization. Critically, this catches the
         `allowed_dir/../config.json` shape: the raw string starts
         with `allowed_dir/`, so a naive prefix-match would accept
         it; if we then normalized first, the `..` would collapse
         away and the segment guard would have nothing to reject. By
         refusing pre-normalization any input containing a `.` or
         `..` segment, we make it impossible for a normalize-then-
         resolve pass to "launder" a hostile prefix into a different
         target.
      2. Allowlist match against the now-known-clean relpath.
         Allowlist-miss raises `_UndeclaredFile` (a `ValueError`
         subclass) so the caller can distinguish "manifest changed
         between export and import" from "this looks like an attack"
         without string-matching the error message.
      3. Realpath check: after resolving under config_dir, the target
         must still live inside config_dir. This catches symlinks-
         under-config_dir attacks where someone planted a symlink
         pointing out and tried to import a file "under" it.
      4. Symlink rejection: even when a symlink (or symlinked
         directory component) resolves to a path that *still* lives
         inside config_dir, importing through it would let an
         allowlisted relpath redirect the write to a different
         in-config file — bypassing the manifest's intent. We probe
         every path component from `config_dir` down to the target
         using `lstat`, refusing if any link is set on the chain.
         This matches the documented "symlinks are never followed on
         import" guarantee.

    Returns the resolved absolute path (caller writes there in phase 2).
    """
    if not isinstance(relpath, str) or not relpath or relpath != relpath.strip():
        raise ValueError(f"illegal relpath: {relpath!r}")
    # Reject backslashes outright — manifest entries are POSIX, and
    # accepting `foo\bar` here on a platform whose Path treats `\` as
    # a separator would let a hostile bundle smuggle traversal past
    # the part-by-part check below.
    if "\\" in relpath:
        raise ValueError(f"relpath uses non-POSIX separator: {relpath!r}")
    # Absolute / drive-letter check before splitting.
    if relpath.startswith("/") or (len(relpath) >= 2 and relpath[1] == ":"):
        raise ValueError(f"relpath must be relative: {relpath!r}")
    raw_parts = relpath.split("/")
    # Empty parts catch `foo//bar` and a trailing `/`. `.` / `..` catch
    # both leading and embedded forms (`./x`, `a/./b`, `allow/../escape`).
    if any(part in ("", ".", "..") for part in raw_parts):
        raise ValueError(f"relpath contains illegal segment: {relpath!r}")
    # Defense-in-depth: any leading `.` segment (e.g. dotfile-disguised
    # paths like `.git/config`) is also rejected — config_dir isn't a
    # place plugins should be writing dotfiles, and accepting them here
    # would let one plugin claim a global filename like `.npmrc`.
    if raw_parts[0].startswith("."):
        raise ValueError(f"relpath starts with dotfile segment: {relpath!r}")

    if not _matches_allowlist(relpath, allowed):
        raise _UndeclaredFile(
            f"relpath not declared in plugin manifest: {relpath!r}"
        )

    target = (config_dir / relpath).resolve()
    config_root = config_dir.resolve()
    # `target == config_root` would mean the relpath resolved to the
    # config dir itself, which can't be a file write target — reject.
    if target == config_root:
        raise ValueError(f"relpath resolves to config_dir itself: {relpath!r}")
    if config_root not in target.parents:
        raise ValueError(f"relpath escapes config_dir: {relpath!r}")

    # Walk every component from config_dir down to (but not including)
    # the target file, refusing if any is a symlink. The target itself
    # is checked too — a symlinked file inside config_dir could still
    # redirect the write to another in-config file, defeating the
    # manifest's allowlist intent. `lstat` is the right primitive: it
    # reports the link itself rather than the link's destination, so a
    # broken or self-referential symlink won't slip through. Missing
    # intermediate dirs are fine — `_atomic_write_file` mkdirs them
    # under config_dir, and a path that doesn't exist yet trivially
    # isn't a symlink.
    probe = config_dir
    for part in relpath.split("/"):
        probe = probe / part
        try:
            st = os.lstat(probe)
        except FileNotFoundError:
            # Component doesn't exist yet → can't be a symlink. Any
            # remaining components also don't exist, so we're done.
            break
        import stat as _stat
        if _stat.S_ISLNK(st.st_mode):
            raise ValueError(
                f"relpath traverses or targets a symlink: {relpath!r}"
            )
    return target


def _encode_file(abs_path: Path) -> dict:
    """Encode a single file for the export bundle. JSON files that parse
    cleanly use the `json` encoding so the bundle stays diff-friendly;
    everything else (sqlite, NAM models, IRs, binary blobs) falls back
    to base64. Symlinks are skipped at the caller — we never reach this
    helper for them."""
    import base64
    raw = abs_path.read_bytes()
    if abs_path.suffix.lower() == ".json":
        try:
            return {"encoding": "json", "data": json.loads(raw.decode("utf-8"))}
        except (UnicodeDecodeError, json.JSONDecodeError):
            # Fall through to base64 — file claimed `.json` but isn't
            # valid JSON; preserve bytes verbatim rather than refusing.
            pass
    return {"encoding": "base64", "data": base64.b64encode(raw).decode("ascii")}


def _decode_entry(entry: dict) -> bytes:
    """Inverse of `_encode_file`. Raises ValueError on malformed entries
    so phase 1 of the importer can refuse the whole bundle without
    having written anything."""
    import base64
    if not isinstance(entry, dict):
        raise ValueError(f"file entry must be an object, got {type(entry).__name__}")
    encoding = entry.get("encoding")
    data = entry.get("data")
    if encoding == "base64":
        if not isinstance(data, str):
            raise ValueError("base64 entry: 'data' must be a string")
        try:
            return base64.b64decode(data, validate=True)
        except Exception as e:
            raise ValueError(f"base64 entry: invalid payload ({e})")
    if encoding == "json":
        # We re-serialize the parsed value with stable formatting. Round
        # trips with the original byte stream aren't guaranteed (key
        # order, whitespace), but the file's *meaning* is preserved.
        try:
            return json.dumps(data, indent=2).encode("utf-8")
        except (TypeError, ValueError) as e:
            raise ValueError(f"json entry: cannot re-serialize ({e})")
    raise ValueError(f"unknown encoding: {encoding!r}")


def _walk_export_paths(allowed: list[str], config_dir: Path) -> dict:
    """Expand a plugin's `_export_paths` against disk and return a
    `{relpath: encoded_entry}` dict. Missing files are silently skipped
    (intentional — manifests can list optional files). Symlinks are
    skipped with no entry. Directories are walked recursively; their
    contained files surface as POSIX-joined relpaths.

    Symlink policy is "skipped and never followed" at every depth:
    `os.walk(..., followlinks=False)` ensures we don't *recurse* into
    symlinked subdirectories, but we additionally drop any symlinked
    entry from `dirnames` (so its name isn't even reported to the
    caller, even though the walker wouldn't descend) and skip files
    whose path is itself a symlink. Without those extra filters, a
    planted symlink directory under an allowed prefix could leak data
    from outside `config_dir` into the export bundle.
    """
    out: dict[str, dict] = {}
    for entry in allowed:
        is_dir = entry.endswith("/")
        rel = entry.rstrip("/")
        abs_target = config_dir / rel
        if abs_target.is_symlink():
            continue
        if is_dir:
            if not abs_target.is_dir():
                continue
            collected: list[Path] = []
            for dirpath, dirnames, filenames in os.walk(
                str(abs_target), followlinks=False
            ):
                # Strip symlinked subdirs from `dirnames` in-place so
                # the walker neither yields their names nor descends.
                dirnames[:] = [
                    d for d in dirnames
                    if not os.path.islink(os.path.join(dirpath, d))
                ]
                for fname in filenames:
                    full = os.path.join(dirpath, fname)
                    if os.path.islink(full) or not os.path.isfile(full):
                        continue
                    collected.append(Path(full))
            # Sort for deterministic bundle output (test fixtures and
            # diffs both rely on stable ordering).
            for child in sorted(collected):
                # POSIX-joined relpath relative to config_dir keeps the
                # bundle cross-platform — Windows-authored bundles can
                # be applied on Linux and vice versa.
                child_rel = child.relative_to(config_dir).as_posix()
                out[child_rel] = _encode_file(child)
        else:
            if not abs_target.is_file():
                continue
            out[rel] = _encode_file(abs_target)
    return out


def _atomic_write_file(target: Path, payload: bytes):
    """Write `payload` to `target` via a uniquely-named sibling temp file
    + os.replace. `os.replace` is atomic on both POSIX and Win32 —
    readers see either the old file or the new one, never a half-written
    state.

    The temp name is generated by `tempfile.mkstemp` so two concurrent
    imports (or two workers sharing the same config volume) can't race
    on the same `<target>.tmp.import` path and clobber each other's
    in-flight writes. On any failure between mkstemp and the successful
    `os.replace`, we remove the temp file so a failed import doesn't
    leave `.tmp.import` litter under config_dir."""
    target.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp_name = tempfile.mkstemp(
        dir=str(target.parent),
        prefix=target.name + ".",
        suffix=".tmp.import",
    )
    tmp = Path(tmp_name)
    # Hand fd to os.fdopen inside its own try, so a failure to wrap
    # the descriptor (rare — typically EMFILE / ENOMEM) doesn't leak
    # the raw fd. On Windows an open fd would also keep the temp file
    # locked and undeletable. Once `with` enters, the fdopen'd file
    # owns close responsibility.
    try:
        f = os.fdopen(fd, "wb")
    except Exception:
        os.close(fd)
        try:
            tmp.unlink()
        except OSError:
            pass
        raise
    try:
        with f:
            f.write(payload)
        os.replace(tmp, target)
    except Exception:
        try:
            tmp.unlink()
        except OSError:
            pass
        raise


# Core (non-plugin) server-side state that the settings bundle backs up
# alongside config.json. The library DB is the only state a rescan can't
# rebuild (scores, favorites, playlists, play history); the art dirs hold
# custom playlist covers + the user avatar. `web_library.db` is handled
# specially (consistent snapshot on export, staged restore on import) — the
# art dirs are walked like plugin export paths. NOTE: custom uploaded
# *song* art currently lands in `art_cache/` commingled with the derived
# (rebuildable) cache, so it is intentionally NOT bundled here to avoid
# bloating the backup with regenerable thumbnails — splitting custom song
# art into its own dir is a tracked follow-up (got-feedback/feedBack#636).
_CORE_LIBRARY_DB = "web_library.db"
_CORE_EXPORT_ART_DIRS = ("playlist_covers/", "avatars/")
_CORE_IMPORT_ALLOWED = (_CORE_LIBRARY_DB,) + _CORE_EXPORT_ART_DIRS


def _snapshot_library_db() -> dict | None:
    """A consistent, fully-checkpointed single-file copy of the live library
    DB, base64-encoded for the bundle. Uses the SQLite online-backup API so
    it is safe to call while the server is serving requests; the live write
    lock is held for the copy so no write lands mid-snapshot. Returns None if
    the DB or backup is unavailable (export proceeds without it)."""
    import base64
    fd, tmp = tempfile.mkstemp(dir=str(CONFIG_DIR), prefix="._dbsnap.", suffix=".db")
    os.close(fd)
    try:
        dst = sqlite3.connect(tmp)
        try:
            with meta_db._lock:
                meta_db.conn.backup(dst)
        finally:
            dst.close()
        raw = Path(tmp).read_bytes()
    except (sqlite3.Error, OSError):
        log.warning("library DB snapshot for settings export failed", exc_info=True)
        return None
    finally:
        for suffix in ("", "-wal", "-shm"):
            try:
                Path(tmp + suffix).unlink()
            except FileNotFoundError:
                pass
    return {"encoding": "base64", "data": base64.b64encode(raw).decode("ascii")}


def _sqlite_payload_integrity_ok(payload: bytes) -> bool:
    """Validate decoded DB bytes by materializing them to a temp file and
    running the same integrity probe used at restore time — so a corrupt or
    truncated snapshot is refused at import, before it's ever staged."""
    fd, tmp = tempfile.mkstemp(dir=str(CONFIG_DIR), prefix="._dbcheck.", suffix=".db")
    try:
        with os.fdopen(fd, "wb") as f:
            f.write(payload)
        return _sqlite_file_integrity_ok(Path(tmp))
    except OSError:
        return False
    finally:
        try:
            Path(tmp).unlink()
        except FileNotFoundError:
            pass


def _core_server_files() -> dict | None:
    """`{relpath: encoded_entry}` for core server-side state in the bundle:
    a snapshot of the library DB plus any custom playlist covers / avatar.
    Returns None if the DB snapshot could not be produced — the caller must
    treat that as a hard export failure rather than silently shipping a
    backup that's missing the irreplaceable library state."""
    snap = _snapshot_library_db()
    if snap is None:
        return None
    out: dict[str, dict] = dict(_walk_export_paths(list(_CORE_EXPORT_ART_DIRS), CONFIG_DIR))
    out[_CORE_LIBRARY_DB] = snap
    return out


@app.get("/api/settings/export")
def export_settings():
    """Build a settings bundle covering server config + opted-in plugin
    server-side files. Frontend layers in `local_storage` before
    triggering the download. See feedBack#113."""
    import datetime
    from plugins import LOADED_PLUGINS, PLUGINS_LOCK

    config_file = CONFIG_DIR / "config.json"
    server_config = _load_config(config_file)
    if server_config is None:
        server_config = _default_settings()

    # Snapshot the library DB + custom art FIRST: if the irreplaceable state
    # can't be captured, abort with an error rather than hand back a bundle
    # that looks like a backup but silently omits it.
    core_files = _core_server_files()
    if core_files is None:
        return JSONResponse(
            {"ok": False, "error": "could not snapshot the library database; "
                                   "export aborted to avoid an incomplete backup"},
            status_code=500,
        )

    plugin_blocks: dict[str, dict] = {}
    with PLUGINS_LOCK:
        plugins_snapshot = list(LOADED_PLUGINS)
    for p in plugins_snapshot:
        allowed = p.get("_export_paths") or []
        plugin_blocks[p["id"]] = {"files": _walk_export_paths(allowed, CONFIG_DIR)}

    # Capture the timestamp once so the bundle's `exported_at` and the
    # download filename's date prefix can't disagree if the request
    # crosses midnight UTC between the two formats.
    now = datetime.datetime.now(datetime.timezone.utc)
    bundle = {
        "schema": SETTINGS_BUNDLE_SCHEMA,
        "exported_at": now.strftime("%Y-%m-%dT%H:%M:%SZ"),
        "feedBack_version": _running_version(),
        "server_config": server_config,
        "plugin_server_configs": plugin_blocks,
        "core_server_files": core_files,
    }
    filename = f"feedBack-settings-{now.strftime('%Y-%m-%d')}.json"
    return JSONResponse(
        bundle,
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


@app.post("/api/settings/import")
def import_settings(bundle: dict):
    """Apply a previously exported settings bundle. Validates the entire
    bundle in phase 1 (no disk writes); only on full success does
    phase 2 commit each file via temp+rename. The frontend reads
    `local_storage` itself — server ignores it. See feedBack#113."""
    from plugins import LOADED_PLUGINS, PLUGINS_LOCK

    if not isinstance(bundle, dict):
        return JSONResponse({"ok": False, "error": "bundle must be a JSON object"}, status_code=400)

    # ── Phase 1: validate everything before touching disk ────────────
    schema = bundle.get("schema")
    if schema != SETTINGS_BUNDLE_SCHEMA:
        return JSONResponse(
            {
                "ok": False,
                "error": f"unsupported schema {schema!r}; this server speaks schema {SETTINGS_BUNDLE_SCHEMA}",
            },
            status_code=400,
        )

    server_config = bundle.get("server_config")
    if not isinstance(server_config, dict):
        return JSONResponse(
            {"ok": False, "error": "server_config must be an object"},
            status_code=400,
        )
    cfg_err = _validate_server_config_types(server_config)
    if cfg_err is not None:
        return JSONResponse(
            {"ok": False, "error": cfg_err},
            status_code=400,
        )

    plugin_blocks = bundle.get("plugin_server_configs") or {}
    if not isinstance(plugin_blocks, dict):
        return JSONResponse(
            {"ok": False, "error": "plugin_server_configs must be an object"},
            status_code=400,
        )

    warnings: list[str] = []
    bundle_version = bundle.get("feedBack_version")
    running = _running_version()
    if bundle_version and bundle_version != running:
        warnings.append(
            f"version mismatch: bundle {bundle_version!r} vs running {running!r}; importing anyway"
        )

    with PLUGINS_LOCK:
        by_id = {p["id"]: p for p in LOADED_PLUGINS}

    # Stage every (display_relpath, target_abs_path, payload) tuple before
    # writing. The relpath is what we surface in the `partial` field on a
    # mid-apply failure — absolute paths would leak the deployment's
    # config_dir layout, while the relpath is the same identifier the
    # bundle itself used and is portable across machines.
    staged: list[tuple[str, Path, bytes]] = []
    applied_plugins: list[str] = []
    for plugin_id, block in plugin_blocks.items():
        if not isinstance(plugin_id, str) or not plugin_id:
            return JSONResponse(
                {"ok": False, "error": f"invalid plugin id key: {plugin_id!r}"},
                status_code=400,
            )
        plugin = by_id.get(plugin_id)
        if plugin is None:
            warnings.append(f"plugin {plugin_id!r} not loaded; skipping its files")
            continue
        if not isinstance(block, dict):
            return JSONResponse(
                {"ok": False, "error": f"plugin {plugin_id!r}: block must be an object"},
                status_code=400,
            )
        files = block.get("files") or {}
        if not isinstance(files, dict):
            return JSONResponse(
                {"ok": False, "error": f"plugin {plugin_id!r}: files must be an object"},
                status_code=400,
            )
        allowed = plugin.get("_export_paths") or []
        skipped_for_plugin: list[str] = []
        applied_for_plugin = False
        for relpath, file_entry in files.items():
            try:
                target = _validate_relpath(relpath, allowed, CONFIG_DIR)
            except _UndeclaredFile:
                # Manifest-allowlist miss is a normal outcome of a
                # plugin update between export and import — warn-and-
                # skip so the rest of the bundle still applies.
                skipped_for_plugin.append(relpath)
                continue
            except ValueError as e:
                # Path-traversal / absolute-path / illegal-segment /
                # backslash / dotfile errors are hard failures: we
                # never want to apply a bundle that contains those,
                # even partially. Caught AFTER `_UndeclaredFile`
                # because that's a `ValueError` subclass — Python
                # would otherwise route it through this branch.
                return JSONResponse(
                    {
                        "ok": False,
                        "error": f"plugin {plugin_id!r}, file {relpath!r}: {e}",
                    },
                    status_code=400,
                )
            try:
                payload = _decode_entry(file_entry)
            except ValueError as e:
                return JSONResponse(
                    {
                        "ok": False,
                        "error": f"plugin {plugin_id!r}, file {relpath!r}: {e}",
                    },
                    status_code=400,
                )
            # Display key prefixes the plugin id so a partial-failure
            # report is unambiguous when two plugins happen to declare
            # files with the same relpath.
            display = f"{plugin_id}/{relpath}"
            staged.append((display, target, payload))
            applied_for_plugin = True
        if skipped_for_plugin:
            warnings.append(
                f"plugin {plugin_id!r}: skipped {len(skipped_for_plugin)} file(s) "
                f"no longer declared in manifest: {skipped_for_plugin}"
            )
        if applied_for_plugin:
            applied_plugins.append(plugin_id)

    # ── Core server-side files (library DB + custom art) ─────────────
    core_blocks = bundle.get("core_server_files") or {}
    if not isinstance(core_blocks, dict):
        return JSONResponse(
            {"ok": False, "error": "core_server_files must be an object"},
            status_code=400,
        )
    db_restore_staged = False
    applied_core: list[str] = []
    for relpath, file_entry in core_blocks.items():
        if not isinstance(relpath, str) or not relpath:
            return JSONResponse(
                {"ok": False, "error": f"core_server_files: invalid relpath key {relpath!r}"},
                status_code=400,
            )
        if relpath == _CORE_LIBRARY_DB:
            # Stage the DB beside the live one; the swap happens at next
            # startup (_apply_pending_db_restore), so we never overwrite a DB
            # the server holds open or strand a stale WAL against a fresh file.
            target = CONFIG_DIR / (_CORE_LIBRARY_DB + ".restore")
            db_restore_staged = True
        else:
            try:
                target = _validate_relpath(relpath, list(_CORE_IMPORT_ALLOWED), CONFIG_DIR)
            except _UndeclaredFile:
                warnings.append(f"core_server_files: skipped undeclared path {relpath!r}")
                continue
            except ValueError as e:
                return JSONResponse(
                    {"ok": False, "error": f"core_server_files, file {relpath!r}: {e}"},
                    status_code=400,
                )
        try:
            payload = _decode_entry(file_entry)
        except ValueError as e:
            return JSONResponse(
                {"ok": False, "error": f"core_server_files, file {relpath!r}: {e}"},
                status_code=400,
            )
        # Guard the DB payload: a truncated/corrupt file staged as the restore
        # would fail to open at startup and brick the app (after the live DB
        # is already gone). Reject anything that doesn't open + pass
        # quick_check before it's ever staged.
        if relpath == _CORE_LIBRARY_DB and not _sqlite_payload_integrity_ok(payload):
            return JSONResponse(
                {"ok": False, "error": "core_server_files: web_library.db is not a valid SQLite database"},
                status_code=400,
            )
        staged.append((f"core/{relpath}", target, payload))
        applied_core.append(relpath)
    if db_restore_staged:
        warnings.append(
            "library database restored; restart FeedBack to load it "
            "(scores, favorites, playlists, and play history)"
        )

    # ── Phase 2: commit ──────────────────────────────────────────────
    written: list[str] = []
    try:
        for display, target, payload in staged:
            _atomic_write_file(target, payload)
            written.append(display)
        # Server config last so a write failure on a plugin file
        # doesn't leave config.json mismatched against the (untouched)
        # plugin state. Full-replace: caller is responsible for the
        # whole dict — this is restore semantics, not partial-update.
        CONFIG_DIR.mkdir(parents=True, exist_ok=True)
        # Share _settings_lock with save_settings() so a full-replace
        # import and a concurrent partial-update POST can't interleave
        # on config.json and drop each other's write.
        with _settings_lock:
            _atomic_write_file(
                CONFIG_DIR / "config.json",
                json.dumps(server_config, indent=2).encode("utf-8"),
            )
    except OSError as e:
        # Phase-1 validation should have caught all foreseeable
        # failures; an OSError here means disk-level trouble (ENOSPC,
        # permission). We can't roll back already-replaced files
        # because we didn't snapshot them — surface what got written
        # (as relpaths, not absolute server paths) so the user knows
        # the state is partial without leaking deployment layout.
        # Disarm a staged DB restore THIS request wrote: a partial import must
        # NOT silently swap the library DB on the next restart. Gate on the
        # write actually having happened (display key in `written`) so we don't
        # delete a valid restore staged by a prior, not-yet-applied import.
        if f"core/{_CORE_LIBRARY_DB}" in written:
            try:
                (CONFIG_DIR / (_CORE_LIBRARY_DB + ".restore")).unlink()
            except FileNotFoundError:
                pass
        return JSONResponse(
            {
                "ok": False,
                "error": f"write failed mid-apply: {e}",
                "partial": written,
            },
            status_code=500,
        )

    return {
        "ok": True,
        "warnings": warnings,
        "applied": {
            "server_config": True,
            "plugins": applied_plugins,
            "core_files": applied_core,
        },
        "restart_required": db_restore_staged,
    }


# ── Diagnostic bundle export (feedBack#166) ──────────────────────────
#
# One-click "Export Diagnostics" in Settings produces a redacted zip
# combining server logs, system info, hardware (CPU/GPU/RAM), plugin
# inventory, and the browser-side console transcript + hardware probe.
# The bundle format is specified in docs/diagnostics-bundle-spec.md.

from fastapi import Body

from diagnostics_bundle import build_bundle as _diag_build, preview_bundle as _diag_preview
from diagnostics_hardware import collect as _diag_hardware


def _diag_log_file() -> Path | None:
    raw = os.environ.get("LOG_FILE", "").strip()
    if not raw:
        return None
    return Path(raw)


def _diag_plugins_roots() -> list[Path]:
    """Return all plugin root directories for orphan scanning.

    Includes both the built-in ``plugins/`` directory and
    ``FEEDBACK_PLUGINS_DIR`` when set, so user-installed plugins and
    orphans in the external dir are reflected in the bundle.
    """
    roots: list[Path] = []
    user_dir = getenv_compat("FEEDBACK_PLUGINS_DIR", "").strip()
    if user_dir:
        p = Path(user_dir)
        if p.is_dir():
            roots.append(p)
    builtin = Path(__file__).parent / "plugins"
    if builtin not in roots:
        roots.append(builtin)
    return roots


def _diag_coerce_bool(v, *, default: bool = True) -> bool:
    """Coerce a request-side value to bool, accepting both JSON booleans and
    string representations.

    - Falsy strings: ``"false"``, ``"0"``, ``"no"``, ``""`` → ``False``
    - ``None`` → *default*
    - Everything else (including ``"true"``, ``"1"``) → ``True``
    """
    if v is None:
        return default
    if isinstance(v, bool):
        return v
    if isinstance(v, str):
        return v.strip().lower() not in ("false", "0", "no", "")
    return bool(v)


def _diag_normalize_include(include: dict | None) -> dict:
    """Coerce request-side flags to the booleans build_bundle expects.
    Missing keys default to True so a bare {} request still produces
    the full bundle.

    Accepts both JSON booleans (``true``/``false``) and string
    representations so callers that serialize flags as strings behave
    consistently with the preview endpoint:
    - Falsy strings: ``"false"``, ``"0"``, ``"no"``, ``""`` → ``False``
    - Everything else (including ``"true"``, ``"1"``, ``"yes"``) → ``True``
    """
    keys = ("system", "hardware", "logs", "console", "plugins")
    if not isinstance(include, dict):
        return {k: True for k in keys}

    return {k: _diag_coerce_bool(include.get(k), default=True) for k in keys}


# Server-side caps on client-supplied payload sections.  diagnostics.js
# enforces a 500-entry / ~250 KB ring buffer on the browser side; these
# bounds give generous headroom while still preventing a crafted POST from
# forcing the server to allocate arbitrarily large in-memory bundles.
_DIAG_MAX_CONSOLE_ENTRIES = 1000          # hard cap: truncate silently
_DIAG_MAX_CONSOLE_BYTES = 2 * 1024 * 1024  # 2 MB hard cap on total console list
_DIAG_MAX_CLIENT_PAYLOAD_BYTES = 2 * 1024 * 1024   # 2 MB per dict section
_DIAG_MAX_CONTRIBUTIONS_BYTES = 4 * 1024 * 1024    # 4 MB aggregate cap for contributions


def _diag_cap_console(v) -> list | None:
    """Return *v* if it is a list, truncated to _DIAG_MAX_CONSOLE_ENTRIES entries
    and _DIAG_MAX_CONSOLE_BYTES total.  Entries are accumulated until either cap
    is reached; no partial-entry splitting occurs."""
    if not isinstance(v, list):
        return None
    result = v[:_DIAG_MAX_CONSOLE_ENTRIES]
    # Also enforce a byte cap — the count cap alone does not bound memory when
    # entries contain arbitrarily large strings.
    try:
        out = []
        total = 0
        for entry in result:
            encoded = json.dumps(entry, separators=(",", ":")).encode("utf-8", errors="replace")
            if total + len(encoded) > _DIAG_MAX_CONSOLE_BYTES:
                break
            out.append(entry)
            total += len(encoded)
        return out
    except (TypeError, ValueError):
        return None


def _diag_cap_dict(v) -> dict | None:
    """Return *v* if it is a dict whose JSON serialisation fits within
    _DIAG_MAX_CLIENT_PAYLOAD_BYTES, otherwise return None."""
    if not isinstance(v, dict):
        return None
    try:
        encoded = json.dumps(v, separators=(",", ":")).encode("utf-8", errors="replace")
    except (TypeError, ValueError) as e:
        log.warning("diagnostics client payload is not JSON-serialisable, dropping: %s", e)
        return None
    if len(encoded) > _DIAG_MAX_CLIENT_PAYLOAD_BYTES:
        return None
    return v


def _diag_cap_contributions(v, known_ids=None) -> dict | None:
    """Apply per-plugin and aggregate size caps on client_contributions.

    Unlike _diag_cap_dict(), which drops the whole dict when any plugin
    exceeds the limit, this function caps each plugin independently so
    one noisy plugin does not silence every other plugin's contribution.

    Parameters
    ----------
    v:
        The raw contributions dict from the POST payload.
    known_ids:
        When provided, contributions from plugins not in this set are
        skipped *before* serialisation, preventing a malicious caller
        from forcing the server to JSON-encode hundreds of near-limit
        payloads that ``build_bundle()`` would later discard anyway.
        ``None`` means "accept all plugin ids" (used in tests / preview).
    """
    if not isinstance(v, dict):
        return None
    result = {}
    total_bytes = 0
    for pid, contribution in v.items():
        if not isinstance(pid, str):
            continue
        # Filter unknown plugin ids early — before serialising — so a
        # crafted request cannot force large allocations for plugins that
        # build_bundle() would drop.
        if known_ids is not None and pid not in known_ids:
            continue
        try:
            encoded = json.dumps(contribution, separators=(",", ":")).encode("utf-8", errors="replace")
        except (TypeError, ValueError) as e:
            log.warning(
                "client_contributions[%r] is not JSON-serialisable, dropping: %s", pid, e
            )
            continue
        if len(encoded) > _DIAG_MAX_CLIENT_PAYLOAD_BYTES:
            log.warning(
                "client_contributions[%r] exceeds %d bytes, dropping",
                pid, _DIAG_MAX_CLIENT_PAYLOAD_BYTES,
            )
            continue
        if total_bytes + len(encoded) > _DIAG_MAX_CONTRIBUTIONS_BYTES:
            log.warning(
                "client_contributions aggregate size limit (%d bytes) reached, "
                "dropping remaining entries",
                _DIAG_MAX_CONTRIBUTIONS_BYTES,
            )
            break
        result[pid] = contribution
        total_bytes += len(encoded)
    return result or None


@app.post("/api/diagnostics/export")
def export_diagnostics(payload: dict = Body(default_factory=dict)):
    """Build a diagnostic bundle and stream it back as a zip download.

    The browser layers in `client_console`, `client_hardware`,
    `client_ua`, and `local_storage` before posting; the server adds
    server logs, hardware, plugin inventory, and packages everything
    into a single zip.

    Errors during plugin diagnostics callables are caught and logged
    to the bundle's manifest `notes` rather than failing the export.
    """
    from plugins import LOADED_PLUGINS, PLUGINS_LOCK

    redact = _diag_coerce_bool(payload.get("redact", True), default=True)
    include = _diag_normalize_include(payload.get("include"))
    client_console = _diag_cap_console(payload.get("client_console"))
    client_hardware = _diag_cap_dict(payload.get("client_hardware"))
    client_ua = _diag_cap_dict(payload.get("client_ua"))
    local_storage = _diag_cap_dict(payload.get("local_storage"))
    # Fetch the plugin list first so we can filter contributions to known
    # plugin ids before serialising — prevents a crafted request from
    # forcing large allocations for plugins build_bundle() would drop.
    with PLUGINS_LOCK:
        plugins_snapshot = list(LOADED_PLUGINS)
    known_ids = {p.get("id") for p in plugins_snapshot if isinstance(p.get("id"), str)}
    client_contributions = _diag_cap_contributions(
        payload.get("client_contributions"), known_ids=known_ids
    )

    zip_bytes, filename, _manifest = _diag_build(
        feedBack_version=_running_version(),
        config_dir=CONFIG_DIR,
        dlc_dir=_get_dlc_dir(),
        log_file=_diag_log_file(),
        loaded_plugins=plugins_snapshot,
        include=include,
        redact=redact,
        client_console=client_console,
        client_hardware=client_hardware,
        client_ua=client_ua,
        local_storage=local_storage,
        client_contributions=client_contributions,
        log=log,
        plugins_root=_diag_plugins_roots(),
    )
    return Response(
        content=zip_bytes,
        media_type="application/zip",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


@app.get("/api/diagnostics/preview")
def preview_diagnostics(
    redact: bool = True,
    system: bool = True,
    hardware: bool = True,
    logs: bool = True,
    console: bool = True,
    plugins: bool = True,
):
    """Return what `/api/diagnostics/export` would produce, minus the
    actual file contents — file tree, sizes, schemas, redaction counts.
    Lets the Settings UI show the user what's about to be sent."""
    from plugins import LOADED_PLUGINS, PLUGINS_LOCK

    include = {
        "system": system,
        "hardware": hardware,
        "logs": logs,
        "console": console,
        "plugins": plugins,
    }
    with PLUGINS_LOCK:
        plugins_snapshot = list(LOADED_PLUGINS)
    return _diag_preview(
        feedBack_version=_running_version(),
        config_dir=CONFIG_DIR,
        dlc_dir=_get_dlc_dir(),
        log_file=_diag_log_file(),
        loaded_plugins=plugins_snapshot,
        include=include,
        redact=redact,
        log=log,
        plugins_root=_diag_plugins_roots(),
    )


@app.get("/api/diagnostics/hardware")
def diagnostics_hardware():
    """Backend hardware probe (cross-platform). Reusable independently
    of the bundle export — handy for "what's my GPU" plugin queries."""
    return _diag_hardware()


# ── Plugin-provided routes are registered at startup via plugins/__init__.py ─
# (CustomsForge, Ultimate Guitar, etc. are loaded from plugins/ directory)



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


@app.get("/api/song/{filename:path}/art")
async def get_song_art(filename: str, request: Request = None):
    """Serve album art for a song.

    Dispatches by format and returns the appropriate media type:
      - Sloppak: serves `cover.jpg` (or manifest-declared cover) read directly
        from the package (the single cover member for zip-form sloppaks — no
        full unpack) as JPEG/PNG/WebP.
      - Loose folder: serves the discovered art file directly as
        JPEG/PNG/WebP.
    """
    dlc = _get_dlc_dir()
    if not dlc:
        return JSONResponse({"error": "not configured"}, 404)

    song_path = _resolve_dlc_path(dlc, filename)
    if song_path is None:
        return JSONResponse({"error": "forbidden"}, 403)
    if not song_path.exists():
        return JSONResponse({"error": "not found"}, 404)

    # Sloppak path: read the cover (manifest-declared or default) straight from
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
        if art is None:
            return JSONResponse({"error": "no art"}, 404)
        data, mt = art
        etag = f'"{hashlib.sha1(data).hexdigest()}"'
        headers, not_modified = _art_conditional(etag, request)
        if not_modified:
            return Response(status_code=304, headers=headers)
        return Response(content=data, media_type=mt, headers=headers)

    # Loose folder path: serve art file directly.
    # song_path is already validated against DLC_DIR by _resolve_dlc_path.
    if loosefolder_mod.is_loose_song(song_path):
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
        return JSONResponse({"error": "no art"}, 404)

    # Custom art uploaded via /art/upload is cached as PNG under ART_CACHE_DIR;
    # serve it if present (works for any song the user pinned art to).
    art_cache = ART_CACHE_DIR
    safe_name = filename.replace("/", "_").replace(" ", "_")
    cached = art_cache / f"{safe_name}.png"
    if cached.exists():
        return _file_art_response(cached, "image/png", request)

    return JSONResponse({"error": "no art"}, 404)


@app.post("/api/song/{filename:path}/meta")
def update_song_meta(filename: str, data: dict):
    """Update song metadata, persisting it back into the underlying file.

    The library scanner re-derives title/artist/album/year from the file
    (archive manifest Attributes / sloppak manifest.yaml) on every full rescan,
    so a DB-only edit reverts. We write the edit into the file first, then
    refresh the cache row (including mtime/size) to match. Loose-folder and
    unwritable songs fall back to a DB-only update (which still survives an
    incremental rescan via the mtime/size cache hit).
    """
    # Canonicalise to the same key get_song_info uses so an update via
    # one URL form (e.g. with `..` segments) lands on the row that
    # later reads will see.
    dlc = _get_dlc_dir()
    cache_key = filename
    resolved = None
    if dlc:
        resolved = _resolve_dlc_path(dlc, filename)
        if resolved is None:
            return JSONResponse({"error": "forbidden"}, 403)
        try:
            cache_key = resolved.relative_to(dlc.resolve()).as_posix()
        except ValueError:
            pass

    fields = {k: data[k] for k in ("title", "artist", "album", "year") if k in data}
    if not fields:
        return {"error": "No fields to update"}
    # Normalise the year value so the DB and file stay in sync.  The file
    # writer (songmeta) coerces empty/non-numeric years to 0, which the
    # scanner reads back as "".  Store "" in the DB instead of a raw
    # non-numeric string so that if the mtime/size are updated (making the
    # row cache-fresh) the DB still matches what the scanner would derive.
    if "year" in fields:
        try:
            _yr_int = int(fields["year"])
        except (TypeError, ValueError):
            _yr_int = 0
        fields = {**fields, "year": str(_yr_int) if _yr_int else ""}

    # Persist into the file so the edit survives a full rescan.
    # Hold _song_io_lock across the existence check and file write so a
    # concurrent delete cannot remove the file between our check and the
    # repack's atomic replace, and so a concurrent upload cannot be clobbered
    # by our atomic rename. archive repack is slow — the lock is held longer
    # than a simple upload/delete, but correctness requires serialisation.
    persisted = False
    with _song_io_lock:
        if resolved is not None and resolved.exists():
            try:
                import songmeta
                persisted = songmeta.write_song_metadata(resolved, fields)
            except Exception:
                log.warning("metadata file write failed for %s", cache_key, exc_info=True)

        with meta_db._lock:
            updates = [f"{field} = ?" for field in fields]
            params = list(fields.values())
            if persisted:
                # The file changed — re-stat so an incremental rescan sees a
                # consistent cache row instead of re-reading the (now matching)
                # file.
                try:
                    mtime, size = _stat_for_cache(resolved)
                    updates += ["mtime = ?", "size = ?"]
                    params += [mtime, size]
                except OSError:
                    pass
            params.append(cache_key)
            meta_db.conn.execute(
                f"UPDATE songs SET {', '.join(updates)} WHERE filename = ?", params
            )
            meta_db.conn.commit()

    if persisted:
        _invalidate_song_caches(cache_key)
        # Coalesce a follow-up scan so a mid-flight scan's stale meta_db.put()
        # for this file can't win: if a scan is running _kick_scan() queues a
        # pending pass; if not it starts a fresh one. Unconditional to avoid a
        # race where the scan finishes between our DB commit and a guarded check.
        _kick_scan()
    return {"ok": True, "persisted": persisted}


@app.post("/api/song/{filename:path}/art/upload")
async def upload_song_art_b64(filename: str, data: dict):
    """Upload custom album art as base64 PNG/JPG."""
    import base64
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

    art_cache = ART_CACHE_DIR
    art_cache.mkdir(parents=True, exist_ok=True)
    safe_name = filename.replace("/", "_").replace(" ", "_")
    cached = art_cache / f"{safe_name}.png"

    # Convert to PNG if needed
    try:
        from PIL import Image
        import io
        img = Image.open(io.BytesIO(img_data)).convert("RGB")
        img.save(str(cached), "PNG")
    except Exception as e:
        return {"error": f"Invalid image: {e}"}

    return {"ok": True}


@app.get("/api/song/{filename:path}")
async def get_song_info(filename: str):
    """Return song metadata, from cache or by extracting it from the song source."""
    import asyncio
    dlc = _get_dlc_dir()
    if not dlc:
        return JSONResponse({"error": "DLC folder not configured"}, 404)

    song_path = _resolve_dlc_path(dlc, filename)
    if song_path is None:
        return JSONResponse({"error": "forbidden"}, 403)
    if not song_path.exists():
        return JSONResponse({"error": "File not found"}, 404)

    # Canonicalise the cache key against the resolved path so two URL
    # forms of the same physical file (e.g. `Artist/song.sloppak` vs
    # `Artist/../Artist/song.sloppak`) converge on a single row instead
    # of fragmenting / shadowing each other in meta_db.
    try:
        cache_key = song_path.relative_to(dlc.resolve()).as_posix()
    except ValueError:
        cache_key = filename

    mtime, size = _stat_for_cache(song_path)
    cached = meta_db.get(cache_key, mtime, size)
    if cached:
        return cached

    # Extract in thread pool
    def _extract():
        meta = _extract_meta_for_file(song_path, dlc)
        meta_db.put(cache_key, mtime, size, meta)
        return meta

    meta = await asyncio.get_event_loop().run_in_executor(None, _extract)
    return meta


# ── Highway WebSocket ─────────────────────────────────────────────────────────

# Filename-keyed extraction cache, retained so _invalidate_song_caches() has a
# stable handle to purge on song replace/delete. Open formats (sloppak/loose)
# self-invalidate via stat checks and never populate this, so it stays empty in
# practice.
_extract_cache = {}  # filename -> (tmp_dir, song, timestamp)
_extract_cache_lock = threading.Lock()


@app.get("/api/sloppak/{filename:path}/file/{rel_path:path}")
def serve_sloppak_file(filename: str, rel_path: str):
    """Serve a file from inside a sloppak (stems, cover, etc.)."""
    dlc = _get_dlc_dir()
    if not dlc:
        return JSONResponse({"error": "not configured"}, 404)
    # `filename` is an attacker-controlled `:path` param. Contain it under
    # DLC_DIR before it reaches the resolver, which does a bare
    # `dlc_root / filename`. Without this, `../../../etc` escapes the root
    # and the rel_path guard below validates `target` against the already-
    # escaped `src`, which trivially passes — yielding arbitrary file reads
    # (e.g. /api/sloppak/../../../../etc/file/passwd). Mirrors the guard
    # `get_song_art` applies to the same filename param.
    resolved = _resolve_dlc_path(dlc, filename)
    if resolved is None:
        return JSONResponse({"error": "forbidden"}, 403)
    # Confine the endpoint to actual sloppak bundles. Without this, a
    # contained-but-non-sloppak `filename` (e.g. `.` → DLC_DIR itself, or
    # any plain subdirectory) would make `resolve_source_dir` hand back a
    # directory and turn this into a read-any-file-under-DLC_DIR endpoint.
    # Mirrors get_song_art's `is_sloppak` dispatch.
    if not sloppak_mod.is_sloppak(resolved):
        return JSONResponse({"error": "not found"}, 404)
    # Canonicalise the cache key against the resolved path so equivalent
    # URL forms of the same sloppak (e.g. `A/../B/x.sloppak` vs
    # `B/x.sloppak`) converge on one `_source_cache` entry instead of
    # fragmenting / re-unpacking — mirrors get_song_info's keying.
    try:
        filename = resolved.relative_to(dlc.resolve()).as_posix()
    except ValueError:
        # safe_join already proved containment, so this is unreachable in
        # practice; fail closed rather than fall back to the raw param.
        return JSONResponse({"error": "forbidden"}, 403)
    src = sloppak_mod.get_cached_source_dir(filename)
    if src is None:
        try:
            src = sloppak_mod.resolve_source_dir(filename, dlc, SLOPPAK_CACHE_DIR)
        except Exception:
            return JSONResponse({"error": "not found"}, 404)
    # Prevent path traversal within the sloppak.
    target = (src / rel_path).resolve()
    try:
        target.relative_to(src.resolve())
    except ValueError:
        return JSONResponse({"error": "forbidden"}, 403)
    if not target.exists() or not target.is_file():
        return JSONResponse({"error": "not found"}, 404)
    ext = target.suffix.lower()
    mt = {
        ".ogg": "audio/ogg", ".opus": "audio/ogg", ".oga": "audio/ogg",
        ".mp3": "audio/mpeg", ".wav": "audio/wav", ".flac": "audio/flac",
        ".m4a": "audio/mp4",
        ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
        ".png": "image/png", ".webp": "image/webp",
        ".json": "application/json",
    }.get(ext)
    return FileResponse(str(target), media_type=mt) if mt else FileResponse(str(target))


@app.websocket("/ws/highway/{filename:path}")
async def highway_ws(websocket: WebSocket, filename: str, arrangement: int = -1, naming_mode: str = "legacy"):
    """Stream song data for the highway renderer over WebSocket."""
    await websocket.accept()
    structlog.contextvars.bind_contextvars(ws_conn_id=uuid.uuid4().hex[:8])

    dlc = _get_dlc_dir()
    if not dlc:
        await websocket.send_json({"error": "DLC folder not configured"})
        await websocket.close()
        return

    song_path = _resolve_dlc_path(dlc, filename)
    if song_path is None:
        await websocket.send_json({"error": "forbidden"})
        await websocket.close()
        return
    if not song_path.exists():
        await websocket.send_json({"error": "File not found"})
        await websocket.close()
        return

    is_slop = sloppak_mod.is_sloppak(song_path)
    # Sloppak wins precedence: `_extract_meta_for_file()` and the
    # background scanner both treat a `.sloppak` directory as sloppak
    # even if it happens to contain WEM/XML. Gate is_loose on that
    # so the loose-only branches (audio_id, offset, audio conversion)
    # don't fire for sloppak bundles.
    is_loose = (not is_slop) and loosefolder_mod.is_loose_song(song_path)
    tmp = None
    owns_tmp = False
    loaded_slop = None  # LoadedSloppak when is_slop
    _keepalive_active = True

    async def _send_keepalives():
        while _keepalive_active:
            try:
                await asyncio.sleep(3)
                if _keepalive_active:
                    await websocket.send_json({"type": "loading", "stage": "Loading..."})
            except Exception:
                break

    try:
        await websocket.send_json({"type": "loading", "stage": "Extracting..."})
        keepalive_task = asyncio.create_task(_send_keepalives())

        try:
            loop = asyncio.get_running_loop()
            _ctx = contextvars.copy_context()
            if is_slop:
                SLOPPAK_CACHE_DIR.mkdir(parents=True, exist_ok=True)
                loaded_slop = await loop.run_in_executor(
                    None,
                    lambda: _ctx.run(sloppak_mod.load_song, filename, dlc, SLOPPAK_CACHE_DIR),
                )
                song = loaded_slop.song
                tmp = str(loaded_slop.source_dir)
                owns_tmp = False
            elif is_loose:
                # Loose folders need no extraction — load_song reads the
                # arrangement XMLs directly from the flat directory.
                # song_path is already DLC-containment-validated by
                # _resolve_dlc_path, so audio conversion below can use
                # it directly.
                song = await loop.run_in_executor(None, lambda: load_song(str(song_path)))
                tmp = str(song_path)
                owns_tmp = False
            else:
                # Only open formats (.sloppak bundles and loose folders) are
                # servable. There is no fallback container extraction path.
                raise ValueError("Unsupported song format")
        finally:
            _keepalive_active = False
            keepalive_task.cancel()

        if not song.arrangements:
            await websocket.send_json({"error": "No arrangements found"})
            await websocket.close()
            return

        # Smart names are needed for smart-mode arrangement selection.
        smart_names = compute_smart_names(song.arrangements)

        # Pick arrangement: explicit request > user preference > most notes
        best = -1
        if 0 <= arrangement < len(song.arrangements):
            best = arrangement
        else:
            # Read the user's config once: their selected instrument (route the chart
            # to the matching part) and their default-arrangement preference.
            pref = ""
            sel_instrument = ""
            config_file = CONFIG_DIR / "config.json"
            if config_file.exists():
                try:
                    _cfg = json.loads(config_file.read_text(encoding="utf-8"))
                    pref = _cfg.get("default_arrangement", "")
                    sel_instrument = (_cfg.get("instrument", "") or "")
                except Exception:
                    pass
            # Instrument routing: load the part that matches the selected instrument so
            # "your instrument" and "the chart you play" line up. The default ordering
            # is Lead/guitar-first, so without this a bass player gets handed a guitar
            # chart (and any tune-check then compares a 4-string bass against a 6-string
            # part). Currently routes bass -> a Bass arrangement; guitar — and any
            # unknown/future instrument (drums, keys) — falls through to the
            # preference/most-notes logic below, which already lands on a guitar part.
            # Drums/keys get their own match when those arrangement types + selector
            # entries land. Only applies when no explicit arrangement was requested, so
            # a manual arrangement switch is always respected.
            if sel_instrument.lower() == "bass":
                # Candidate bass parts, preferring the structured pathBass flag; the
                # normalized smart name (itself pathBass-derived) and raw name are
                # fallbacks for sources without the flag.
                bass_idxs = [
                    i
                    for i, a in enumerate(song.arrangements)
                    if getattr(a, "path_bass", False)
                    or (smart_names[i] or "").lower().startswith("bass")
                    or "bass" in (getattr(a, "name", "") or "").lower()
                ]
                if bass_idxs:
                    # Among the bass parts: (1) honor the saved default-arrangement
                    # preference if it names one of them (so a bass player who prefers
                    # "Bass 2"/"Alt. Bass" keeps it), (2) else the canonical main "Bass",
                    # (3) else the first bass part in order.
                    pref_bass = -1
                    if pref:
                        for i in bass_idxs:
                            nm = (smart_names[i] if naming_mode == "smart" and i < len(smart_names)
                                  else getattr(song.arrangements[i], "name", ""))
                            if nm == pref:
                                pref_bass = i
                                break
                    if pref_bass >= 0:
                        best = pref_bass
                    else:
                        best = next(
                            (i for i in bass_idxs
                             if (smart_names[i] if i < len(smart_names) else "") == "Bass"),
                            bass_idxs[0],
                        )
            # User's default arrangement preference (only when instrument routing did not
            # already resolve a part — i.e. guitar, or a bass player with no bass part).
            if best < 0 and pref:
                if naming_mode == "smart":
                    best = _pick_smart_arrangement(song.arrangements, smart_names, pref)
                else:
                    for i, a in enumerate(song.arrangements):
                        if a.name == pref:
                            best = i
                            break
        if best < 0:
            # Fallback: most notes
            best = 0
            best_count = 0
            for i, a in enumerate(song.arrangements):
                c = len(a.notes) + sum(len(ch.notes) for ch in a.chords)
                if c > best_count:
                    best_count = c
                    best = i
        arr = song.arrangements[best]

        # Resolve the manifest arrangement id for notation lookup (Option B loader).
        # Use the parallel arrangement_ids list (indexed by compacted position,
        # i.e. song.arrangements index) so skipped manifest entries can't shift
        # the index and serve the wrong arrangement's notation.
        _notation_arr_id: str | None = None
        if is_slop and loaded_slop is not None:
            _ids = loaded_slop.arrangement_ids
            if best < len(_ids):
                _notation_arr_id = _ids[best]

        # Convert audio with unique filename (check cache first)
        audio_url = None
        audio_error: str | None = None  # Surfaced in song_info when audio_url is None
        stems_payload: list[dict] = []
        # URL of the single full-mix audio (sloppak `original_audio:`), when the
        # pack ships one. The stems plugin uses this to play the untouched mix
        # while every stem slider is at unity; None otherwise (separate stems
        # only, loose folder, or archive).
        original_audio_url: str | None = None
        if is_loose:
            # Loose folder filenames are relative paths (artist/album/song).
            # Hash the *canonical* dlc-relative path (so two URL spellings
            # of the same physical folder share a cache key) PLUS the
            # source WEM's mtime+size so:
            #  - different songs with the same leaf folder name can't
            #    collide (a `/`→`__` escape would collapse `a/b__c` and
            #    `a__b/c`);
            #  - editing audio.wem in place invalidates the cached
            #    converted file (without this, in-place custom song iteration
            #    keeps serving the stale mp3/ogg from the cache).
            try:
                canonical = song_path.relative_to(dlc.resolve()).as_posix()
            except ValueError:
                canonical = filename
            wem_for_id = loosefolder_mod.find_audio(song_path)
            try:
                wem_stat = wem_for_id.stat() if wem_for_id else None
            except OSError:
                wem_stat = None
            stamp = f"{wem_stat.st_mtime_ns}-{wem_stat.st_size}" if wem_stat else ""
            digest = hashlib.sha256(
                (canonical + "|" + stamp).encode("utf-8")
            ).hexdigest()[:12]
            leaf = Path(canonical.rstrip("/\\")).stem.replace(" ", "_")[:40] or "song"
            audio_id = f"{leaf}_{digest}"
        else:
            audio_id = Path(filename).stem.replace(" ", "_")

        if is_slop:
            # Stems are served via the sloppak file endpoint; the first stem
            # (or explicit default) is the core <audio> source. The stems
            # plugin replaces it with a mixed graph when active.
            from urllib.parse import quote
            q_fn = quote(filename, safe="")
            for s in loaded_slop.stems:
                url = f"/api/sloppak/{q_fn}/file/{quote(s['file'])}"
                stems_payload.append({"id": s["id"], "url": url, "default": s["default"]})
            # Full-mix URL (served by the same /api/sloppak/.../file/ endpoint).
            if loaded_slop is not None and loaded_slop.original_audio:
                original_audio_url = (
                    f"/api/sloppak/{q_fn}/file/{quote(loaded_slop.original_audio)}"
                )
            if stems_payload:
                # Stems present: keep the core <audio> pointed at stem[0]. This
                # URL is only ever heard in the degraded path (stems plugin
                # refuses takeover / decode fails); the full-mix↔stems switch is
                # driven client-side by `original_audio_url`, not `audio_url`.
                audio_url = stems_payload[0]["url"]
            elif original_audio_url:
                # Stem-less full-mix pack: nothing to separate, so play the full
                # mix natively through the core <audio>. The stems plugin's
                # onSongReady returns early on an empty stems list (no graph).
                audio_url = original_audio_url
            else:
                audio_error = "This sloppak has no playable stems."
        else:
            AUDIO_CACHE_DIR.mkdir(parents=True, exist_ok=True)
            # Check if audio already cached (writable cache dir or legacy static dir)
            for ext in [".mp3", ".ogg", ".wav"]:
                for cache_dir in [AUDIO_CACHE_DIR, STATIC_DIR]:
                    cached_audio = cache_dir / f"audio_{audio_id}{ext}"
                    if cached_audio.exists() and cached_audio.stat().st_size > 1000:
                        audio_url = f"/audio/audio_{audio_id}{ext}"
                        break
                if audio_url:
                    break

        def _evict_audio_cache():
            # Keep AUDIO_CACHE_DIR bounded so a library full of loose
            # folders / many archives doesn't fill disk. LRU on st_atime
            # so songs the user keeps replaying stay warm. Best-effort:
            # log at debug so permission / disk errors are diagnosable
            # without aborting the request.
            try:
                audio_files = [f for f in AUDIO_CACHE_DIR.iterdir()
                               if f.name.startswith("audio_") and f.suffix in (".mp3", ".ogg", ".wav")]
                if len(audio_files) > 100:
                    audio_files.sort(key=lambda f: f.stat().st_atime)
                    for f in audio_files[:len(audio_files) - 100]:
                        f.unlink(missing_ok=True)
            except Exception:
                log.debug("audio cache eviction failed for %s", AUDIO_CACHE_DIR, exc_info=True)

        if not audio_url and is_loose:
            await websocket.send_json({"type": "loading", "stage": "Converting audio..."})
            wem_path = loosefolder_mod.find_audio(song_path)
            if wem_path:
                # Re-resolve to defeat a symlinked audio.wem that points
                # outside the song folder — without this, a crafted
                # custom song could turn convert_wem into an arbitrary-file
                # decode/read primitive.
                wem_resolved = wem_path.resolve()
                try:
                    wem_resolved.relative_to(song_path)
                except ValueError:
                    audio_error = "Audio file escapes the loose folder."
                    wem_resolved = None
                if wem_resolved is not None:
                    # Convert into a unique temp basename and then
                    # atomically rename onto the final cache name.
                    # Two clients requesting the same song concurrently
                    # would otherwise race writing the same file and
                    # one could serve a partial mp3/wav.
                    tmp_suffix = uuid.uuid4().hex[:8]
                    tmp_base = AUDIO_CACHE_DIR / f"audio_{audio_id}.{tmp_suffix}"
                    try:
                        produced = convert_wem(str(wem_resolved), str(tmp_base))
                        ext = Path(produced).suffix
                        final_path = AUDIO_CACHE_DIR / f"audio_{audio_id}{ext}"
                        os.replace(produced, final_path)
                        audio_url = f"/audio/audio_{audio_id}{ext}"
                    except Exception as e:
                        log.exception("loose-folder audio conversion failed for %s", audio_id)
                        audio_error = f"Audio conversion failed: {e}"
                        # Best-effort cleanup of partial temp artifacts.
                        for stale in AUDIO_CACHE_DIR.glob(f"audio_{audio_id}.{tmp_suffix}.*"):
                            stale.unlink(missing_ok=True)
            else:
                audio_error = "No audio file found in loose folder."
            _evict_audio_cache()

        if not audio_url and not is_slop and not is_loose:
            await websocket.send_json({"type": "loading", "stage": "Converting audio..."})
            wem_files = find_wem_files(tmp)
            if not wem_files:
                audio_error = "No WEM audio files were found inside this archive."
            else:
                try:
                    audio_path = convert_wem(wem_files[0], os.path.join(tmp, "audio"))
                    ext = Path(audio_path).suffix
                    audio_dest = AUDIO_CACHE_DIR / f"audio_{audio_id}{ext}"
                    shutil.copy2(audio_path, audio_dest)
                    audio_url = f"/audio/audio_{audio_id}{ext}"
                except Exception as e:
                    log.exception("audio conversion failed for %s", audio_id)
                    audio_error = f"Audio conversion failed: {e}"

            _evict_audio_cache()

        # Send song metadata
        arr_list = [
            {
                "index": i,
                "name": a.name,
                "smart_name": smart_names[i],
                "notes": len(a.notes) + sum(len(c.notes) for c in a.chords),
            }
            for i, a in enumerate(song.arrangements)
        ]
        arr_list.sort(key=_arr_smart_sort_key)
        await websocket.send_json({
            "type": "song_info",
            "title": song.title,
            "artist": song.artist,
            "duration": song.song_length,
            "arrangement": arr.name,
            "arrangement_smart_name": smart_names[best],
            "arrangement_index": best,
            # Echo the resolved naming mode so highway.js doesn't have to
            # re-read localStorage (which can be unavailable / disagree with
            # app.js's in-memory cache when storage writes fail).
            "naming_mode": "smart" if naming_mode == "smart" else "legacy",
            "arrangements": arr_list,
            "audio_url": audio_url,
            "audio_error": audio_error,
            "tuning": arr.tuning,
            # Number of strings on the active arrangement
            # (feedBack-plugin-3dhighway#7). arrangement XML / archive sources
            # always emit `tuning` as length 6 with zero-padding for
            # unused string slots, so `len(arr.tuning)` is unreliable
            # there; sloppak / GP-imported sources may instead carry
            # a trimmed list. arrangement_string_count() combines a
            # notes-derived lower bound, a name-based fallback (4 for
            # "bass" arrangements), and the tuning length (when it
            # disagrees with the RS-XML padded 6) into a single
            # reliable signal. Plugins should size string-indexed UI
            # / geometry against THIS rather than assuming 6 or
            # using `tuning.length` directly.
            "stringCount": arrangement_string_count(arr),
            "capo": arr.capo,
            "centOffset": arr.cent_offset,
            # Sanitize song.offset before send_json: a malformed loose
            # chart can produce NaN via `float("nan")`, which Starlette
            # would serialise as the literal `NaN` token (invalid JSON)
            # and break the frontend's song_info parsing.
            "offset": _sanitized_song_offset(song) if is_loose else 0.0,
            "format": "sloppak" if is_slop else ("loose" if is_loose else "archive"),
            # Feedpak contributor credits (manifest `authors:`, spec §5.4) —
            # name + role only, shown on the highway when a song is loaded.
            # Only sloppak/feedpak packs carry a manifest; loose/archive
            # sources get []. The frontend uses a non-empty list as the gate
            # for the credits overlay, so minigames / synthetic highway uses
            # (no manifest) never trigger it.
            "authors": _sanitize_authors(loaded_slop.manifest) if (is_slop and loaded_slop is not None) else [],
            "stems": stems_payload,
            # Full-mix audio (sloppak `original_audio:`) served alongside the
            # separate `stems`. The stems plugin plays this single file while
            # every stem slider is at unity and switches to the separate stems
            # the moment one drops below 100%. None when the pack ships stems
            # only. `has_*` flags mirror the has_drum_tab/has_keys convention so
            # a client can branch without re-deriving from the URLs.
            "original_audio_url": original_audio_url,
            "has_original_audio": bool(original_audio_url),
            "has_stems": bool(stems_payload),
            # Surface a drum_tab presence flag so the visualization picker
            # can auto-activate the drums plugin even when the chosen
            # arrangement isn't named "Drums" (drum_tab.json lives next
            # to the manifest, not inside the arrangements list).
            "has_drum_tab": bool(
                is_slop and loaded_slop is not None and loaded_slop.drum_tab is not None
            ),
            "has_notation": bool(
                is_slop
                and loaded_slop is not None
                and loaded_slop.notation_by_id is not None
                and _notation_arr_id is not None
                and _notation_arr_id in loaded_slop.notation_by_id
            ),
            # Song-level key/scale track presence (keys.json, spec §7.7) so a
            # consumer can light up a key/scale display without parsing the pack.
            "has_keys": bool(
                is_slop and loaded_slop is not None and loaded_slop.keys is not None
            ),
        })

        # Send drum_tab when the sloppak ships one (manifest `drum_tab:` key,
        # see lib/sloppak.py). The drums plugin subscribes to `drum_tab` for
        # the kit legend and `drum_hits` for the timed hit stream. Chunked
        # 500-per-frame like notes so a long song stays well under WS frame
        # limits. Legacy drum sloppaks (drums encoded as guitar notes) skip
        # this branch and fall through to the regular `notes` stream — the
        # client-side drums plugin keeps a fallback decoder for them.
        if is_slop and loaded_slop is not None and loaded_slop.drum_tab is not None:
            dt = loaded_slop.drum_tab
            kit = drums_mod.normalise_kit(dt.get("kit"))
            hits_wire = drums_mod.hits_to_wire(dt.get("hits") or [])
            _dt_name = dt.get("name")
            _dt_name = _dt_name if isinstance(_dt_name, str) and _dt_name else "Drums"
            try:
                await websocket.send_json({
                    "type": "drum_tab",
                    "version": int(dt.get("version", drums_mod.SCHEMA_VERSION)),
                    "name": _dt_name,
                    "kit": kit,
                    "total": len(hits_wire),
                })
                for i in range(0, len(hits_wire), 500):
                    await websocket.send_json({
                        "type": "drum_hits",
                        "data": hits_wire[i:i + 500],
                        "total": len(hits_wire),
                    })
            except WebSocketDisconnect:
                return

        # Send beats
        beats = [{"time": b.time, "measure": b.measure} for b in song.beats]
        await websocket.send_json({"type": "beats", "data": beats})

        # Send sections
        sections = [{"name": s.name, "time": s.start_time} for s in song.sections]
        await websocket.send_json({"type": "sections", "data": sections})

        # Send the song-level key/scale track (keys.json, spec §7.7) when the
        # sloppak ships one. Consumers read it from the WS rather than the file,
        # like drum_tab/beats/sections. The loader already sanitized the events
        # (finite t, non-empty string key, sorted), so this is a direct send.
        if is_slop and loaded_slop is not None and loaded_slop.keys is not None:
            await websocket.send_json({
                "type": "keys",
                "version": int(loaded_slop.keys.get("version", 1)),
                "data": loaded_slop.keys.get("events") or [],
            })

        # Song-level tempo + time-signature maps (song_timeline, feedpak 1.2.0),
        # plus the per-chart tempo override (§6.10): the active arrangement's own
        # `tempos` wins over the song-level map for this chart. Both are
        # pre-sanitized by the loader / arrangement_from_wire, so they stream
        # directly. Consumers read these rather than the file.
        _song_tempos = loaded_slop.tempos if (is_slop and loaded_slop is not None) else None
        _tempos_out = getattr(arr, "tempos", None) or _song_tempos
        if _tempos_out:
            await websocket.send_json({"type": "tempos", "data": _tempos_out})
        _time_sigs = (loaded_slop.time_signatures
                      if (is_slop and loaded_slop is not None) else None)
        if _time_sigs:
            await websocket.send_json({"type": "time_signatures", "data": _time_sigs})

        # Send notation data when the sloppak ships it for the active arrangement.
        # Slots after sections (cursor sync depends on beats, which precede sections)
        # and before anchors — per docs/sloppak-spec.md §5.3.
        if (
            is_slop
            and loaded_slop is not None
            and loaded_slop.notation_by_id is not None
            and _notation_arr_id is not None
            and _notation_arr_id in loaded_slop.notation_by_id
        ):
            nt = loaded_slop.notation_by_id[_notation_arr_id]
            measures_wire = notation_mod.measures_to_wire(nt.get("measures") or [])
            try:
                await websocket.send_json({
                    "type": "notation_info",
                    "version": int(nt.get("version", notation_mod.SCHEMA_VERSION)),
                    "instrument": str(nt.get("instrument", "")),
                    "staves": nt.get("staves") or [],
                    "total": len(measures_wire),
                })
                _NOTATION_CHUNK = 32
                for i in range(0, len(measures_wire), _NOTATION_CHUNK):
                    await websocket.send_json({
                        "type": "notation_measures",
                        "data": measures_wire[i:i + _NOTATION_CHUNK],
                        "total": len(measures_wire),
                    })
            except WebSocketDisconnect:
                return

        # Send anchors
        anchors = [anchor_to_wire(a) for a in arr.anchors]
        await websocket.send_json({"type": "anchors", "data": anchors})

        # Send chord templates. Include `fingers` alongside `name` /
        # `frets` so plugin overlays consuming highway.getChordTemplates()
        # can render full chord boxes (chord-style fingering
        # diagrams), not just chord names. Each fingering entry is
        # per-string: -1 = unused, 0 = open string, n > 0 = finger
        # number. RS XML sources populate real values; GP imports
        # currently emit all -1 (no finger data available pre-import).
        templates = [chord_template_to_wire(ct) for ct in arr.chord_templates]
        await websocket.send_json({"type": "chord_templates", "data": templates})

        # Send lyrics if available
        import xml.etree.ElementTree as ET
        lyrics = []
        lyrics_source = ""
        # Loose folders are flat — only inspect direct children so a
        # nested backup/export directory inside the song folder can't
        # override the active arrangement's lyrics / tone. archives are
        # unpacked into nested tmp dirs, so they keep recursive rglob.
        # Sloppak skips XML lookups entirely below but the json loop
        # is unconditional, so define both walkers up front.
        _xml_walk = Path(tmp).glob if is_loose else Path(tmp).rglob
        _json_walk = Path(tmp).glob if is_loose else Path(tmp).rglob
        if is_slop:
            lyrics = list(song.lyrics or [])
            lyrics_source = getattr(song, "lyrics_source", "") or ""
        else:
            for xml_path in sorted(_xml_walk("*.xml")):
                try:
                    root = ET.parse(xml_path).getroot()
                    if root.tag == "vocals":
                        # An empty <vocals/> shell would otherwise
                        # short-circuit later XML files, so only stop
                        # scanning when the XML actually produced lyric
                        # tokens — a meaningful XML further down the
                        # walk must still be reachable.
                        candidate = [
                            {
                                "t": round(float(v.get("time", "0")), 3),
                                "d": round(float(v.get("length", "0")), 3),
                                "w": v.get("lyric", ""),
                            }
                            for v in root.findall("vocal")
                        ]
                        if candidate:
                            lyrics = candidate
                            lyrics_source = "xml"
                            break
                except Exception:
                    pass
        if lyrics:
            payload = {"type": "lyrics", "data": lyrics}
            if lyrics_source:
                payload["source"] = lyrics_source
            await websocket.send_json(payload)

        # Send tone changes. archive and loose folders carry tone data in
        # arrangement XMLs; a sloppak ships it inline in its arrangement JSON
        # (Arrangement.tones, populated by the converter), so read it straight
        # off `arr` rather than walking for XML that doesn't exist.
        if is_slop:
            # `sloppak_tone_changes` builds the (base, sorted changes) pair
            # from `Arrangement.tones`, skipping non-string names and
            # non-finite/non-numeric times — unit-tested in test_tones.py.
            from tones import sloppak_tone_changes
            base_name, tone_changes = sloppak_tone_changes(getattr(arr, "tones", None))
            # Send when there's a base tone OR timed changes — a single-tone
            # arrangement has a base but no switches, and the highway should
            # still be able to show the initial tone.
            if tone_changes or base_name:
                await websocket.send_json({
                    "type": "tone_changes",
                    "base": base_name,
                    "data": tone_changes,
                })
        else:
            xml_paths = sorted(_xml_walk("*.xml"))

            # Build tone ID→name map from the manifest JSON for the selected
            # arrangement. Match on the entry's `ArrangementName` field, not a
            # filename-stem substring — "Lead" is a substring of "Bonus Lead",
            # so the old substring test could build the map from the wrong
            # arrangement. Record the matched JSON stem so the XML below can
            # be paired exactly (RS names the JSON and XML with the same stem).
            arr_tone_names = {}  # the SELECTED arrangement's own Tone_A..D only
            matched_stem = None
            # Strip + lowercase both sides when matching ArrangementName,
            # mirroring lib/tones.py — a manifest with padded whitespace
            # must not fall through to an unrelated arrangement.
            arr_name_lower = arr.name.strip().lower() if arr else ""

            def _manifest_entries(path):
                """Parsed `Entries` dict for a manifest JSON, or {} if the
                file isn't a well-formed manifest (non-dict top level /
                Entries, unparseable JSON)."""
                try:
                    # JSON is UTF-8; decode strictly so malformed bytes fail
                    # cleanly (caught below) rather than silently corrupting
                    # arrangement / tone names.
                    jdata = json.loads(path.read_text(encoding="utf-8"))
                except Exception:
                    return {}
                entries = jdata.get("Entries") if isinstance(jdata, dict) else None
                return entries if isinstance(entries, dict) else {}

            def _tone_names(attrs):
                """{idx: name} from an entry's Tone_A..Tone_D — string values
                only, so a malformed manifest can't emit a non-string name."""
                m = {}
                for idx, key in enumerate(("Tone_A", "Tone_B", "Tone_C", "Tone_D")):
                    val = attrs.get(key)
                    if isinstance(val, str) and val:
                        m[idx] = val
                return m

            for jf in sorted(_json_walk("*.json")):
                for entry in _manifest_entries(jf).values():
                    if not isinstance(entry, dict):
                        continue
                    attrs = entry.get("Attributes")
                    if not isinstance(attrs, dict):
                        continue
                    ename = attrs.get("ArrangementName")
                    if not isinstance(ename, str) or ename.strip().lower() != arr_name_lower:
                        continue
                    # Only the SELECTED arrangement's own Tone_A..D — never
                    # borrowed from another manifest. An unrelated map would
                    # mislabel `N/A` tone-change markers; `Tone {id}` is the
                    # correct fallback (matching lib/tones.py).
                    arr_tone_names = _tone_names(attrs)
                    matched_stem = jf.stem.lower()
                    break
                if matched_stem is not None:
                    break

            # Parse XMLs. Prefer the XML paired with the matched manifest
            # (identical stem). When no manifest matched (loose/custom song), fall
            # back to a name-token match — but rank by how few *extra* stem
            # tokens a candidate carries, mirroring lib/tones.py: {"lead"} is
            # a subset of both `song_lead` and `song_bonus_lead`, so a plain
            # subset test still ties. A unique fewest-extra match wins; an
            # exact tie among token candidates is treated as ambiguous —
            # `_token_ambiguous` then suppresses the rank-2 best-effort
            # fallback, so no arrangement's tone timeline is guessed at
            # (matching lib/tones.py, which attaches nothing on a tie).
            # Shared tokenizer with lib/tones.py so archive playback and
            # archive→sloppak conversion select arrangement XMLs identically.
            from tones import tokens as _name_tokens
            _arr_tokens = _name_tokens(arr.name) if arr else set()
            _token_pick = None
            _token_ambiguous = False
            if _arr_tokens and matched_stem is None:
                _cands = []
                for xp in xml_paths:
                    stem_tokens = _name_tokens(xp.stem)
                    if _arr_tokens <= stem_tokens:
                        _cands.append((len(stem_tokens - _arr_tokens), xp))
                if _cands:
                    _best = min(extra for extra, _ in _cands)
                    _tied = [xp for extra, xp in _cands if extra == _best]
                    if len(_tied) == 1:
                        _token_pick = _tied[0]
                    else:
                        _token_ambiguous = True

            def _xml_rank(xp):
                if matched_stem and xp.stem.lower() == matched_stem:
                    return 0
                if _token_pick is not None and xp == _token_pick:
                    return 1
                return 2
            sorted_xml = sorted(xml_paths, key=lambda xp: (_xml_rank(xp), xp.name))
            # When the arrangement was positively identified (manifest stem
            # pair or a unique token match), tone data must come only from
            # that XML — a rank-2 fallback XML belongs to another
            # arrangement. A token tie is likewise suppressed (guessing among
            # equally-named XMLs would be wrong). Only a genuine no-match
            # case (loose/custom song with no usable manifest and no name overlap)
            # keeps the long-standing rank-2 best-effort source.
            _suppress_fallback = (
                matched_stem is not None or _token_pick is not None or _token_ambiguous
            )
            sent_tones = False
            tone_base = ""  # <tonebase> of the preferred arrangement XML
            for xml_path in sorted_xml:
                try:
                    root = ET.parse(xml_path).getroot()
                    if root.tag != "song":
                        continue
                    if _suppress_fallback and _xml_rank(xml_path) == 2:
                        # Don't read tones from an unrelated arrangement's XML.
                        continue
                    # Capture the base tone from the first XML the loop
                    # accepts. The skip above already excluded untrusted
                    # rank-2 XMLs whenever a match was confirmed; in the
                    # genuine no-match case rank-2 IS the best-effort source,
                    # so its <tonebase> is equally valid for a base-only song.
                    if not tone_base:
                        _tb = root.find("tonebase")
                        if _tb is not None and _tb.text:
                            # Strip whitespace from pretty-printed XML so the
                            # base name matches the sloppak path, which also
                            # strips it.
                            tone_base = _tb.text.strip()
                    tones_el = root.find("tones")
                    if tones_el is not None:
                        # Accumulate into a per-XML list — if this file
                        # raises partway through, its partial changes are
                        # discarded rather than bleeding into the next
                        # candidate XML.
                        xml_tone_changes = []
                        for t in tones_el.findall("tone"):
                            tc_time = t.get("time")
                            tc_name = t.get("name", "")
                            tc_id = t.get("id", "")
                            # Resolve "N/A" or empty names via the selected
                            # arrangement's own tone map; `Tone {id}` when it
                            # has none (never another arrangement's names).
                            if (not tc_name or tc_name == "N/A") and tc_id:
                                try:
                                    tc_name = arr_tone_names.get(int(tc_id), f"Tone {tc_id}")
                                except (TypeError, ValueError):
                                    pass
                            if tc_time and tc_name:
                                # Skip a single malformed/non-finite marker
                                # rather than letting it raise — the outer
                                # `except` would otherwise swallow the whole
                                # XML and drop every tone change. NaN/inf
                                # would also produce client-unparseable JSON.
                                try:
                                    tc_t = float(tc_time)
                                except (TypeError, ValueError):
                                    continue
                                if not math.isfinite(tc_t):
                                    continue
                                xml_tone_changes.append({
                                    "t": round(tc_t, 3),
                                    "name": tc_name,
                                })
                        if xml_tone_changes:
                            tonebase = root.find("tonebase")
                            base_name = tonebase.text.strip() if tonebase is not None and tonebase.text else ""
                            # If base name not in XML, use the selected
                            # arrangement's own Tone_A.
                            if not base_name:
                                base_name = arr_tone_names.get(0, "")
                            await websocket.send_json({
                                "type": "tone_changes",
                                "base": base_name,
                                "data": sorted(xml_tone_changes, key=lambda x: x["t"]),
                            })
                            sent_tones = True
                            break
                except (ET.ParseError, OSError) as e:
                    # Only swallow unreadable/malformed XML — skip to the next
                    # candidate. A blanket `except` here would also eat a
                    # `WebSocketDisconnect` from `send_json`; let that bubble
                    # to the handler's outer disconnect handler.
                    log.debug(
                        "highway: skipping unreadable arrangement XML %s: %s",
                        xml_path.name, e,
                    )
                    continue
            # Base-only fallback: a single-tone arrangement has a <tonebase>
            # but no <tones> markers — still surface the initial tone so the
            # highway can show it (parity with the sloppak path above).
            # `tone_base` is the <tonebase> of whichever XML the loop
            # accepted: the confirmed-match XML, or — in the genuine no-match
            # case — the best-effort rank-2 XML. `arr_tone_names` holds the
            # selected arrangement's own Tone_A..D. An ambiguous arrangement
            # (token tie) accepts no XML and has no manifest map, so it
            # correctly sends nothing rather than a guessed tone.
            if not sent_tones:
                base_name = tone_base
                if not base_name:
                    base_name = arr_tone_names.get(0, "")
                if base_name:
                    await websocket.send_json({
                        "type": "tone_changes",
                        "base": base_name,
                        "data": [],
                    })

        # Teaching mark sd (§6.2.2): derive each note's scale degree from the
        # active key (keys.json §7.7) + its sounding pitch (tuning[string] +
        # fret), only when the author didn't author one. Display/teaching only —
        # NEVER feeds grading. Notes whose string/fret has no tuning entry, or
        # that have no active key, or whose key name is unparseable, stay unset.
        _key_events = (
            (loaded_slop.keys.get("events") or [])
            if (is_slop and loaded_slop is not None and loaded_slop.keys is not None)
            else []
        )
        _key_times = [e["t"] for e in _key_events]
        _key_tonics = [key_to_tonic_pc(e.get("key")) for e in _key_events]
        _tuning = arr.tuning or []
        # Hoist the open-string base out of the per-note loop: arr.tuning holds
        # per-string OFFSETS from standard, so the sounding pitch is
        # base[string] + offset + capo + fret (matches the tuner / open-string
        # labels). arrangement_string_count is O(notes), so compute once here.
        _base = base_open_string_midis(
            arrangement_string_count(arr), "bass" in (arr.name or "").lower())
        _capo = int(getattr(arr, "capo", 0) or 0)

        def _fill_scale_degree(wire: dict, n, t: float) -> None:
            # Author-provided sd wins — note_to_wire already emitted it.
            if "sd" in wire or not _key_times:
                return
            idx = bisect.bisect_right(_key_times, t) - 1
            if idx < 0:
                return
            tonic = _key_tonics[idx]
            if tonic is None:
                return
            midi = pitch_from_base(_base, _capo, _tuning, n.string, n.fret)
            if midi is None:
                return
            wire["sd"] = scale_degree_for_pitch(midi, tonic)

        # Send notes in chunks
        notes = []
        for n in arr.notes:
            w = note_to_wire(n)
            _fill_scale_degree(w, n, n.time)
            notes.append(w)
        # Send in chunks of 500
        for i in range(0, len(notes), 500):
            await websocket.send_json({
                "type": "notes",
                "data": notes[i:i+500],
                "total": len(notes),
            })

        # Send chords
        chords = []
        for c in arr.chords:
            cw = chord_to_wire(c)
            for cn, cnw in zip(c.notes, cw.get("notes", [])):
                _fill_scale_degree(cnw, cn, c.time)
            chords.append(cw)
        for i in range(0, len(chords), 500):
            await websocket.send_json({
                "type": "chords",
                "data": chords[i:i+500],
                "total": len(chords),
            })

        hand_shapes_out = [hand_shape_to_wire(h) for h in arr.hand_shapes]
        for i in range(0, len(hand_shapes_out), 500):
            await websocket.send_json({
                "type": "handshapes",
                "data": hand_shapes_out[i:i+500],
                "total": len(hand_shapes_out),
            })

        # Per-phrase difficulty data for the master-difficulty slider
        # (feedBack#48). Only sent when the source chart had multiple
        # `<level>` tiers — single-level charts (GP converter, older
        # sloppaks without phrase data) produce arr.phrases=None, and the
        # frontend treats the missing message as "slider disabled".
        # Consumers that don't know about this message type ignore it.
        #
        # Chunked at phrase granularity (20 phrases per frame) because
        # each phrase nests per-level note/chord lists — a single frame
        # could otherwise exceed proxy/WS size limits on large songs.
        # Chunk boundary is per-phrase (not per-level) so the frontend
        # reassembles whole phrase ladders.
        if arr.phrases:
            total = len(arr.phrases)
            for i in range(0, total, 20):
                await websocket.send_json({
                    "type": "phrases",
                    "data": [phrase_to_wire(p) for p in arr.phrases[i:i + 20]],
                    "total": total,
                })

        await websocket.send_json({"type": "ready"})

        # Keep connection alive for control messages
        try:
            while True:
                msg = await websocket.receive_text()
                data = json.loads(msg)
                if data.get("action") == "change_arrangement":
                    pass
        except WebSocketDisconnect:
            pass

    except Exception as e:
        log.exception("highway_ws unhandled error for %s", filename)
        try:
            await websocket.send_json({"error": str(e)})
            await websocket.close()
        except Exception:
            pass

    finally:
        pass  # Don't clean up — cached for arrangement switching


# ── Audio serving ─────────────────────────────────────────────────────────────


@app.get("/api/audio-local-path")
def audio_local_path(url: str, request: Request):
    """Return absolute local filesystem path for an /audio/… URL (Electron desktop only).

    Accepts ``/audio/<path>`` where ``<path>`` may include subdirectory segments —
    no scheme, no host, no query string, no fragment.  The resolved path must stay
    inside AUDIO_CACHE_DIR or STATIC_DIR; ``..`` traversal, backslashes, and
    absolute ``filename`` values are rejected.

    This endpoint returns a raw filesystem path and is intended exclusively for
    the Electron desktop process (which runs on loopback). Requests from non-
    loopback clients are rejected with 403.
    """
    # Loopback-only — only the local Electron process should call this
    client_host = request.client.host if request.client else None
    try:
        is_loopback = bool(client_host and ipaddress.ip_address(client_host).is_loopback)
    except ValueError:
        is_loopback = client_host == "localhost"
    if not is_loopback:
        return JSONResponse({"error": "forbidden"}, status_code=403)
    # Accept only simple /audio/<filename> — no scheme, no host, no query/fragment
    if not re.fullmatch(r"/audio/[^?#]+", url):
        return JSONResponse({"error": "invalid url"}, status_code=400)
    filename = url[len("/audio/"):]
    # Reject traversal, absolute paths, and backslash separators
    if ".." in filename.split("/") or filename.startswith("/") or "\\" in filename:
        return JSONResponse({"error": "invalid url"}, status_code=400)
    for d in [AUDIO_CACHE_DIR, STATIC_DIR]:
        candidate = (d / filename).resolve()
        # Ensure resolved path is inside the allowed directory
        try:
            candidate.relative_to(d.resolve())
        except ValueError:
            continue
        if candidate.is_file():
            return JSONResponse({"path": str(candidate)})
    return JSONResponse({"error": "not found"}, status_code=404)


@app.get("/audio/{filename:path}")
def serve_audio(filename: str):
    """Serve audio files from the writable audio cache directory."""
    # Reject traversal attempts and absolute-path components
    if ".." in filename.split("/") or filename.startswith("/") or "\\" in filename:
        return JSONResponse({"error": "not found"}, status_code=404)
    for d in [AUDIO_CACHE_DIR, STATIC_DIR]:
        candidate = (d / filename).resolve()
        try:
            candidate.relative_to(d.resolve())
        except ValueError:
            continue
        if candidate.is_file():
            return FileResponse(str(candidate))
    return JSONResponse({"error": "not found"}, status_code=404)


app.mount("/static", StaticFiles(directory=str(STATIC_DIR)), name="static")


@app.get("/")
def index():
    # fee[dB]ack v0.3.0: the v3 shell is now the DEFAULT at `/`. The classic v2
    # UI remains fully available as a fallback — opt back in with
    # FEEDBACK_UI=v2 (or =legacy), or hit the dedicated /v2 route below (which
    # serves it regardless of the env var).
    if getenv_compat("FEEDBACK_UI") or getenv_compat("FEEDBACK_UI") in ("v2", "legacy"):
        return FileResponse(str(STATIC_DIR / "index.html"))
    return FileResponse(str(STATIC_DIR / "v3" / "index.html"))


@app.get("/v3")
def index_v3():
    # Always serve the v0.3.0 shell, independent of the env var (kept for
    # explicit/back-compat links even though `/` now defaults to v3).
    return FileResponse(str(STATIC_DIR / "v3" / "index.html"))


@app.get("/v2")
def index_v2():
    # Always serve the classic v2 UI, independent of the env var, so the
    # fallback is reachable without flipping FEEDBACK_UI.
    return FileResponse(str(STATIC_DIR / "index.html"))
