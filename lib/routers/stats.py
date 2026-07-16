"""Gameplay scoring — XP award + per-song practice stats (record / recent / best /
top / per-song). The `/api/stats/{filename:path}` route is registered LAST so its
catch-all doesn't shadow the fixed /recent /best /top paths.

Extracted verbatim from ``server.py`` (R3); edits: ``@app`` -> ``@router``,
``meta_db`` -> ``appstate.meta_db``, ``_get_progression_content()`` /
``_builtin_diagnostic_filename()`` read through the seam.
"""

import logging
import math

from fastapi import APIRouter
from fastapi.responses import JSONResponse

import appstate
from metadata_db import _as_int
from reqfields import _clean_str

log = logging.getLogger("feedBack.server")

router = APIRouter()


@router.post("/api/xp/award")
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
    appstate.meta_db.award_xp(amount)
    return appstate.meta_db.get_progress()


@router.post("/api/stats")
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
    filename = appstate.meta_db._canonical_song_filename(filename)
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
    _acount = appstate.meta_db.arrangement_count(filename)
    if _acount and arrangement >= _acount:
        return JSONResponse({"error": "arrangement out of range for this song"}, status_code=400)
    score = data.get("score")
    accuracy = data.get("accuracy")
    last_pos = data.get("lastPlayPosition", data.get("last_position"))
    if isinstance(last_pos, bool):   # float(False)=0.0 would otherwise store a bogus position
        return JSONResponse({"error": "lastPlayPosition must be a finite number"}, status_code=400)
    # Optional wall-clock play time (career hours odometer). Bounded per POST:
    # the recorder flushes on pause/stop/end, so a single delta beyond 6h is a
    # clock artifact (suspend/sleep), not practice.
    seconds = data.get("seconds")
    if seconds is not None:
        if isinstance(seconds, bool):
            return JSONResponse({"error": "seconds must be a positive number"}, status_code=400)
        try:
            seconds = float(seconds)
            if not math.isfinite(seconds):
                raise ValueError("non-finite")
        except (TypeError, ValueError, OverflowError):
            return JSONResponse({"error": "seconds must be a positive number"}, status_code=400)
        if not (0 < seconds <= 6 * 3600):
            return JSONResponse({"error": "seconds must be between 0 and 21600"}, status_code=400)
    seconds = seconds or 0.0

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
        row = appstate.meta_db.record_session(filename, arrangement, score=score,
                                     accuracy=accuracy, last_position=last_pos,
                                     seconds=seconds)
        # Unified XP + streak side-effects — never let these drop the stat write.
        progress = None
        try:
            from xp import xp_for_run
            from datetime import date
            appstate.meta_db.award_xp(xp_for_run(score))
            appstate.meta_db.record_active_day(date.today().isoformat())
            progress = appstate.meta_db.get_progress()
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
            reg = getattr(appstate, "instrument_registry", None)
            instrument = progression_mod.instrument_for_arrangement(
                appstate.meta_db.arrangement_entry(filename, arrangement),
                registry=reg,
            )
            if instrument is not None:
                progression_summary = appstate.meta_db.record_progression_event(
                    "song_completed",
                    {
                        "filename": filename,
                        "instrument": instrument,
                        "accuracy": accuracy,
                        "score": score,
                        "is_diagnostic": filename == appstate.builtin_diagnostic_filename(),
                    },
                    appstate.get_progression_content(),
                )
        except Exception:
            log.warning("stats side-effects (progression) failed", exc_info=True)
        return {"stats": row, "progress": progress, "progression": progression_summary}

    # Seconds-only accrual: an unscored play that ran to the song's natural
    # end has play time to bank but no resume position to touch (song:ended
    # must not overwrite Continue with the end-of-song offset). Still counts
    # as playing today for the streak below.
    if last_pos is None and seconds:
        row = appstate.meta_db.add_play_seconds(filename, arrangement, seconds)
        progress = None
        try:
            from datetime import date
            appstate.meta_db.record_active_day(date.today().isoformat())
            progress = appstate.meta_db.get_progress()
        except Exception:
            log.warning("stats side-effects (streak) failed", exc_info=True)
        return {"stats": row, "progress": progress}

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
        row = appstate.meta_db.touch_position(filename, arrangement, pos, seconds=seconds)
    except (TypeError, ValueError, OverflowError):
        return JSONResponse({"error": "lastPlayPosition must be a finite number"}, status_code=400)
    # A resume session still counts as playing today: advance the streak (no XP —
    # that's scoring-only) so a non-scored practice day keeps the streak alive,
    # consistent with these sessions also surfacing in recent / continue.
    progress = None
    try:
        from datetime import date
        appstate.meta_db.record_active_day(date.today().isoformat())
        progress = appstate.meta_db.get_progress()
    except Exception:
        log.warning("stats side-effects (streak) failed", exc_info=True)
    return {"stats": row, "progress": progress}


@router.get("/api/stats/recent")
def api_recent_stats(limit: int = 12):
    """Recently-played rows joined to song metadata for 'Jump back in'."""
    from urllib.parse import quote
    out = []
    for r in appstate.meta_db.recent_stats(limit):
        meta = appstate.meta_db.conn.execute(
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


@router.get("/api/stats/best")
def api_stats_best():
    """{filename: best_accuracy} for all songs with a recorded best — one call
    to badge the library grid (defined before the {filename} catch-all)."""
    return appstate.meta_db.best_accuracy_map()


@router.get("/api/stats/top")
def api_top_stats(limit: int = 5):
    """Top scored songs (best first), joined to song metadata, for the profile
    'Your best scores' panel (defined before the {filename} catch-all)."""
    from urllib.parse import quote
    out = []
    for r in appstate.meta_db.top_stats(limit):
        meta = appstate.meta_db.conn.execute(
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


@router.get("/api/stats/{filename:path}")
def api_song_stats(filename: str):
    return appstate.meta_db.get_song_stats(filename)
