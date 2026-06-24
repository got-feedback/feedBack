"""Achievements & Feats of Power — pure evaluation helpers.

This module holds the side-effect-free core of the engine so it is unit
testable (constitution P-V): no IO, no SQLite, no clock. `routes.py` owns the
storage/HTTP shell and calls into these functions.

**Integration law (structural):** Feats are evaluated from *activity counters*
only (`evaluate_feats` / `apply_activity`); competency Achievements are recorded
from *competency events* the source reports (`report-unlock`). Nothing here ever
converts an activity count into a competency unlock or vice versa.
"""

from __future__ import annotations

# Counter keys the activity model owns. `*_max` keys take the running maximum;
# everything else is a cumulative running total. Kept here (not in routes) so a
# test can assert the contract without standing up a DB.
MAX_COUNTERS = frozenset({"notes_session_max", "streak_insong_max", "chart_encore_max"})


def tier_index_for(tiers, value):
    """Highest 0-based tier index whose threshold is met by ``value``.

    Returns -1 when no tier is reached. Tiers are assumed ascending; we scan
    all of them rather than short-circuit so an out-of-order catalogue still
    resolves to the largest satisfied tier.
    """
    idx = -1
    for i, threshold in enumerate(tiers or []):
        try:
            if value >= threshold:
                idx = i
        except TypeError:
            continue
    return idx


def feat_counter_value(feat, counters):
    """Activity-counter value backing a Feat definition (0 when absent)."""
    key = feat.get("counter")
    if not key:
        return 0
    try:
        return int(counters.get(key, 0) or 0)
    except (TypeError, ValueError):
        return 0


def evaluate_feats(feat_defs, counters):
    """Map ``feat_id -> highest reached tier index`` for all satisfied Feats.

    A Feat with no tiers, or whose counter hasn't reached tier 0, is omitted.
    Pure: takes the current counters snapshot, returns a plain dict.
    """
    out = {}
    for feat in feat_defs or []:
        fid = feat.get("id")
        if not fid:
            continue
        tiers = feat.get("tiers") or []
        if not tiers:
            continue
        ti = tier_index_for(tiers, feat_counter_value(feat, counters))
        if ti >= 0:
            out[fid] = ti
    return out


def apply_activity(counters, delta):
    """Return a NEW counters dict after folding in one activity ``delta``.

    Cumulative keys add; ``*_max`` keys keep the running maximum. The caller
    (routes.py) is responsible for the only stateful bit — the per-chart play
    count — and passes the post-increment value as ``delta['chart_play_count']``
    so this function stays pure.

    Recognised delta fields (all optional, default 0):
      notes            -> notes_total            (+=)
      song_done        -> songs_done             (+=)
      seconds          -> time_total_seconds     (+=)
      session_notes    -> notes_session_max      (max)
      in_song_streak   -> streak_insong_max      (max)
      chart_play_count -> chart_encore_max       (max)
    """
    out = dict(counters or {})

    def _cur(key):
        try:
            return int(out.get(key, 0) or 0)
        except (TypeError, ValueError):
            return 0

    def _int(v):
        try:
            return int(v or 0)
        except (TypeError, ValueError):
            return 0

    out["notes_total"] = _cur("notes_total") + _int(delta.get("notes"))
    out["songs_done"] = _cur("songs_done") + _int(delta.get("song_done"))
    out["time_total_seconds"] = _cur("time_total_seconds") + _int(delta.get("seconds"))
    out["notes_session_max"] = max(_cur("notes_session_max"), _int(delta.get("session_notes")))
    out["streak_insong_max"] = max(_cur("streak_insong_max"), _int(delta.get("in_song_streak")))
    if delta.get("chart_play_count") is not None:
        out["chart_encore_max"] = max(_cur("chart_encore_max"), _int(delta.get("chart_play_count")))
    return out


def consecutive_run_length(dates):
    """Longest run of consecutive calendar dates in ``dates`` (ISO 'YYYY-MM-DD').

    Used by the `secret_witching` Feat (practise in the 2–5am window on N
    consecutive nights). Pure date arithmetic so it's unit-testable; routes.py
    feeds it the distinct night-dates recorded in `comp_ledger`.
    """
    from datetime import date

    parsed = []
    for d in dates or []:
        try:
            y, m, dd = (int(x) for x in str(d).split("-"))
            parsed.append(date(y, m, dd))
        except (ValueError, TypeError):
            continue
    if not parsed:
        return 0
    parsed = sorted(set(parsed))
    best = run = 1
    for prev, cur in zip(parsed, parsed[1:]):
        if (cur - prev).days == 1:
            run += 1
            best = max(best, run)
        else:
            run = 1
    return best


def diff_unlocks(prev_tiers, new_tiers):
    """Feat ids whose tier advanced (incl. first unlock).

    ``prev_tiers`` / ``new_tiers`` are ``feat_id -> tier_index`` maps as
    returned by :func:`evaluate_feats`. Returns the ids that are newly present
    or moved to a higher tier — i.e. the Feats to record + announce this round.
    """
    out = []
    for fid, tier in (new_tiers or {}).items():
        if tier > prev_tiers.get(fid, -1):
            out.append(fid)
    return out
