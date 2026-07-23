"""The library scanner: the background scan, its process pool, and the kick/runner
plumbing that serialises passes.

Carved VERBATIM out of server.py (R3b) except the seam reads. Everything shared is read
LATE off appstate — the same contract every module in lib/routers/ uses, and it is not
cosmetic: tests monkeypatch CONFIG_DIR and swap meta_db, so a value captured at import
time would pin the wrong one for the life of the process.

    CONFIG_DIR        -> appstate.config_dir
    meta_db           -> appstate.meta_db
    _default_settings -> appstate.default_settings()
    _stat_for_cache   -> appstate.stat_for_cache()
    _feedBack_server_root() -> appstate.server_root      <- see below

━━━ THE SCAN STATUS IS REBOUND, NOT MUTATED ━━━

`_background_scan` does `global _scan_status; _scan_status = {**INIT, ...}` at every stage
transition. It REPLACES the dict; it does not update it in place. So nothing may hold the
dict by value — a reference captured once goes permanently stale at the first stage change,
and would report "listing" forever while the scan ran to completion.

That is why this module exports `status()`, a getter, and why appstate publishes
`scan_status` as a CALLABLE rather than a dict. appstate.py already says so in a comment;
this is the code that makes it true.

━━━ AND WHY THE SERVER ROOT IS READ, NEVER DERIVED ━━━

`_background_scan` seeds the builtin content, which needs the directory holding server.py.
`Path(__file__).resolve().parent` is correct in server.py and silently WRONG here (it
yields lib/, which has no docs/ or data/) — and it fails by finding nothing rather than by
raising, so the seeds would just quietly never run. server.py publishes the root once, as
appstate.server_root. Read it; never re-derive it.
"""
import concurrent.futures
import logging
import multiprocessing
import os
import sys
import threading
from pathlib import Path

import appstate
import builtin_content
import enrichment
import loosefolder as loosefolder_mod
import sloppak as sloppak_mod
from appconfig import _load_config
from dlc_paths import _get_dlc_dir
from env_compat import getenv_compat
from scan_worker import _relpath, _scan_one

log = logging.getLogger("feedBack.scan")

import json


# ── Directory-signature fast path ─────────────────────────────────────────────
#
# A startup scan globs the whole library twice (*.feedpak, *.wem) and stats every
# file to detect what changed. On a 50k-song library that lives on a slow mount
# (an NTFS-3G FUSE volume here) it is ~100k filesystem round trips every launch —
# the "big drive churns on every startup" report.
#
# But adds / removes / renames of songs all bump the mtime of the DIRECTORY that
# holds them (verified on the target NTFS-3G mount), and so does the addition of
# a subdirectory (a new entry in its parent). So after a scan we record every
# library directory and its mtime; on the next scan we re-stat ONLY those
# directories (a handful, vs 100k file ops). If none changed, the file set is
# unchanged and the whole listing/stat pass is skipped.
#
# The one thing this cannot see is a file edited IN PLACE under the same name —
# that bumps the file's mtime but not its directory's. That is rare for a song
# library (you add and remove packs, you don't rewrite them under the same name),
# and the manual Refresh forces a full scan (force=True) for exactly that case.
def _dir_signature_file() -> Path:
    return appstate.config_dir / "scan_dir_signature.json"


def _load_dir_signature() -> dict | None:
    try:
        data = json.loads(_dir_signature_file().read_text(encoding="utf-8"))
        if isinstance(data, dict) and isinstance(data.get("dirs"), dict):
            return data
    except (OSError, ValueError):
        pass
    return None


def _save_dir_signature(dlc: Path, dirs: dict[str, int]) -> None:
    # Keyed by the DLC path so switching libraries never matches a stale
    # signature. Best-effort: a failed write just means the next scan is a full
    # one, never a wrong one.
    try:
        _dir_signature_file().write_text(
            json.dumps({"dlc": str(dlc), "dirs": dirs}), encoding="utf-8")
    except OSError as e:
        log.debug("scan: could not persist dir signature: %s", e)


def _library_dirs(all_songs, dlc: Path) -> set[str]:
    """Every directory whose mtime reflects an add/remove of a library song:
    each song's containing directory and all of its ancestors up to the DLC
    root (the root itself always included, as "."). Derived from the already-
    listed songs — no extra filesystem walk. The builtin carve-outs
    (tutorials-builtin / minigames-builtin) are absent because the caller
    already excluded them from `all_songs`, so a minigame writing a drill there
    never invalidates the fast path.

    Directory-form songs (loose-song folders, directory sloppak bundles) also
    record their OWN directory: a file added/removed/replaced INSIDE the folder
    bumps that folder's mtime but not its parent's, so tracking only the parent
    would miss an in-place change to such a song. File-form sloppaks (a single
    .feedpak zip) aren't dirs, so they add nothing here — the flat file library
    stays at a handful of dir stats."""
    rels = {"."}
    for f in all_songs:
        rel = Path(_relpath(f, dlc))
        if f.is_dir():
            rels.add(rel.as_posix())
        parent = rel.parent
        rels.add(parent.as_posix())
        for anc in parent.parents:
            rels.add(anc.as_posix())
    return rels


def _has_unextracted_columns() -> bool:
    """True while any `songs` row still carries NULL in a column added by an
    additive migration — i.e. metadata the current extractor would fill but
    that no existing row has yet (currently `bass_tuning_name`).

    The tree-signature fast path only asks "did the file set change"; on a
    settled library the answer is no forever, so a schema addition would never
    reach extraction. This one-row probe forces the full pass exactly until the
    backfill completes — `put()` writes '' rather than NULL, so it self-clears
    after the rescan instead of disabling the fast path permanently."""
    try:
        from metadata_db import MetadataDB
        cond = " OR ".join(f"{c} IS NULL" for c in MetadataDB._EXTRACTION_MARKER_COLS)
        row = appstate.meta_db.conn.execute(
            f"SELECT 1 FROM songs WHERE {cond} LIMIT 1").fetchone()
    except Exception as e:
        # A probe failure must not take the scan down; falling back to the fast
        # path costs at most a delayed backfill.
        log.debug("scan: unextracted-column probe failed: %s", e)
        return False
    return row is not None


def _record_dir_signature(all_songs, dlc: Path) -> None:
    sig = _stat_dirs(dlc, _library_dirs(all_songs, dlc))
    if sig is not None:   # a dir vanished mid-scan → skip; next scan is full
        _save_dir_signature(dlc, sig)


def _stat_dirs(dlc: Path, rels) -> dict[str, int] | None:
    """{reldir: mtime_ns} for the given library dirs, or None if any is gone or
    unreadable — a vanished recorded dir means the tree changed, so fail to a
    full scan rather than a false match."""
    out: dict[str, int] = {}
    for rel in rels:
        try:
            out[rel] = (dlc if rel == "." else dlc / rel).stat().st_mtime_ns
        except OSError:
            return None
    return out


_SCAN_STATUS_INIT = {"running": False, "stage": "idle", "total": 0, "done": 0, "current": "", "error": None, "is_first_scan": False, "added": 0, "removed": 0}


_scan_status = dict(_SCAN_STATUS_INIT)


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


def background_scan(force: bool = False):
    """Scan the library and cache song metadata on startup. Uses a process pool to bypass the GIL for CPU-bound metadata parsing.

    `force` skips the directory-signature fast path and always does the full
    listing/stat pass — the manual Refresh sets it (see _dir_signature_file).

    Never sets `_scan_status["running"] = False` — ownership of that flag
    lives in `_scan_runner` so a `kick_scan()` racing this function's
    terminal write cannot observe a stale False and start a second runner.
    """
    global _scan_status
    _scan_status = {**_SCAN_STATUS_INIT, "running": True, "stage": "listing"}

    # Load config once so both the DLC-dir lookup and the platform filter
    # read from the same snapshot, avoiding a redundant parse of config.json.
    _cfg = _load_config(appstate.config_dir / "config.json") or appstate.default_settings()
    dlc = _get_dlc_dir(_cfg)
    if not dlc:
        _scan_status = {**_SCAN_STATUS_INIT, "running": True, "stage": "idle", "error": "DLC folder not configured"}
        log.warning("Scan: no DLC folder configured")
        return

    builtin_content.seed_builtin_diagnostic_sloppaks(appstate.server_root, dlc)
    builtin_content.seed_builtin_starter_content(appstate.server_root, dlc)

    # Fast path: if every library directory recorded by the last scan still has
    # the same mtime, nothing was added, removed, or renamed, so the whole
    # glob-and-stat pass below can be skipped (see the signature comment above).
    # `force` (manual Refresh) always does the full pass. Seeding above is
    # idempotent — it only writes when a builtin is missing — so it does not
    # perturb the mtimes on a settled library.
    if not force and not _has_unextracted_columns():
        stored = _load_dir_signature()
        if stored is not None and stored.get("dlc") == str(dlc):
            current = _stat_dirs(dlc, stored["dirs"].keys())
            if current is not None and current == stored["dirs"]:
                _scan_status = {**_SCAN_STATUS_INIT, "running": True, "stage": "complete"}
                log.info("Scan: library tree unchanged (%d dirs) — skipped the full listing/stat pass",
                         len(current))
                return

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
            return "tutorials-builtin" in p.parts or "minigames-builtin" in p.parts or any(part.startswith(".") for part in p.relative_to(dlc).parts)
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

    # Clean up stale DB entries. delete_missing reports both deltas (rows pruned
    # + genuinely-new files) so the scan can surface an added/removed summary.
    _delta = appstate.meta_db.delete_missing(current_files)
    removed, added = _delta["removed"], _delta["added"]
    if removed:
        log.info("Removed %d stale DB entries", removed)

    # Figure out which need scanning
    to_scan = []
    for f in all_songs:
        # Skip entries that vanish or become unreadable between listing
        # and stat. Without this, one concurrent move/delete in DLC_DIR
        # would crash the scan thread and leave `_scan_status["running"]`
        # stuck true with no path to recover.
        try:
            mtime, size = appstate.stat_for_cache(f)
        except OSError as e:
            log.debug("scan: skipping %s (%s)", f, e)
            continue
        cache_key = _relpath(f, dlc)
        try:
            cached = appstate.meta_db.get(cache_key, mtime, size)
        except Exception as e:
            # Keep scanning even if a single metadata lookup fails.
            # The file will be re-scanned and cache repaired by put().
            log.warning("scan cache lookup failed for %s: %s", cache_key, e)
            cached = None
        if not cached:
            to_scan.append((f, mtime, size, dlc))
        elif any(cached.get(c) is None for c in appstate.meta_db._EXTRACTION_MARKER_COLS):
            # Row predates one of the per-perspective tuning columns (NULL
            # from the additive migration), so that perspective's tuning was
            # never extracted for it. Without this
            # re-queue an existing library would keep every bass column empty
            # forever — mtime/size still match, so nothing else would ever
            # bring the row back through extraction. Converges: put() always
            # writes '' (never NULL), so a rescanned row is never re-queued.
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
        # Full pass completed with the DB already up to date — record the tree
        # signature so the next startup can take the fast path.
        _record_dir_signature(all_songs, dlc)
        _scan_status = {**_SCAN_STATUS_INIT, "running": True, "stage": "complete", "added": added, "removed": removed}
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
                appstate.meta_db.put(name, mtime, size, meta)
            except Exception as e:
                log.warning("scan failed for %s: %s", fname, e)
            _scan_status["done"] += 1
            _scan_status["current"] = fname

    # Record the tree signature after a completed full pass so the next startup
    # can skip it when nothing has changed.
    _record_dir_signature(all_songs, dlc)
    log.info("Scan complete: %d songs cached", len(to_scan))
    _scan_status = {**_SCAN_STATUS_INIT, "running": True, "stage": "complete", "added": added, "removed": removed}


_scan_kick_lock = threading.Lock()


_scan_rescan_pending = False
# Set by kick_scan(force=True); consumed by _scan_runner for the next pass so a
# manual Refresh bypasses the directory-signature fast path.
_scan_force_next = False


# Handles to the running scan / enrichment worker threads. Both use the shared
# MetadataDB connection, so teardown/shutdown MUST join them before closing that
# connection — a daemon thread mid-query on a closed SQLite conn is a native
# use-after-free that segfaults the process (seen flaky in CI). Set by
# _kick_scan / _kick_enrich; joined by _join_background_db_threads().
_scan_thread: threading.Thread | None = None


def kick_scan(force: bool = False) -> bool:
    """Request a library rescan, single-flight + coalescing.

    `force` skips the directory-signature fast path for the resulting pass (the
    manual Refresh uses it so an in-place same-name edit — the one thing the
    fast path can't see — is always picked up). A forced request that coalesces
    onto a running or queued scan keeps the force intent: the pass is forced if
    ANY pending request asked for it.

    Returns True if a new scan thread was started, False if one was already
    running. In the latter case a follow-up pass is queued and runs as soon
    as the current scan finishes so files landing mid-scan (e.g. an upload
    that finalizes after the scan has already listed DLC_DIR) are not lost
    until the next periodic pass. Multiple late-arriving requests coalesce
    into a single follow-up.
    """
    global _scan_rescan_pending, _scan_thread, _scan_force_next
    with _scan_kick_lock:
        if force:
            _scan_force_next = True
        if _scan_status["running"]:
            _scan_rescan_pending = True
            return False
        # Mark running synchronously so a parallel kick_scan() observes it
        # before the worker thread has a chance to reassign _scan_status.
        _scan_status["running"] = True
    _scan_thread = threading.Thread(target=_scan_runner, daemon=True)
    _scan_thread.start()
    return True


def _scan_runner():
    """Run _background_scan, then re-run if requests arrived mid-scan."""
    global _scan_rescan_pending, _scan_force_next
    while True:
        # Consume the force flag for THIS pass; a forced request queued mid-scan
        # sets it again for the follow-up.
        with _scan_kick_lock:
            forced = _scan_force_next
            _scan_force_next = False
        try:
            background_scan(force=forced)
        except Exception:
            log.exception("background scan failed unexpectedly")

        with _scan_kick_lock:
            if not _scan_rescan_pending:
                _scan_status["running"] = False
                break
            _scan_rescan_pending = False
            _scan_status["running"] = True
    # Enrichment rides scan completion (library-metadata design §6): the scan
    # pool is a side-effect-free, no-network process pool by design, so
    # enrichment is a SEPARATE post-scan pass — non-blocking, the library is
    # usable immediately. The 5-minute periodic rescan re-kicks it, which is
    # the natural low-priority retry hook.
    enrichment._kick_enrich()


def status() -> dict:
    """The live scan status.

    A GETTER, deliberately. `_scan_status` is REBOUND on every stage transition, so a
    caller holding the dict would be reading a snapshot frozen at whatever stage it
    happened to grab — see the module header.
    """
    return _scan_status


def scan_thread():
    """The background scan thread, or None. Read by shutdown to join it."""
    return _scan_thread
