"""Player progression engine: instrument paths, challenges, quests, wallet.

Pure evaluation logic for the progression system (spec 010). The only IO in
this module is ``load_content()`` reading the bundled JSON content files under
``data/progression/`` — everything else is deterministic functions over plain
dicts so the whole engine is unit-testable without a database.

Vocabulary
----------
content    The validated bundle of path/quest/shop definitions (see
           ``load_content``). Definitions are data: adding a path, level,
           challenge, quest or shop item is a JSON edit, never a code change.
snapshot   The caller-built view of current player state fed to
           ``evaluate_event``::

               {
                 "calibration_status": "pending" | "completed" | "skipped",
                 "paths": {path_id: level, ...},          # selected paths only
                 "challenges": {challenge_id: {"count", "completed", "detail"}},
                 "quests": [{"period_type", "quest_id", "count", "completed",
                             "reward_db", "detail"}, ...],  # current periods only
                 "streak": int,                            # current day streak
                 "xp_total": int,                          # lifetime dB earned
               }
event      ``{"type": <goal event type>, "payload": {...}}`` — the single
           choke point unit. ``song_completed`` payloads carry
           ``{filename, instrument, accuracy, score, is_diagnostic}``;
           ``minigame_run`` payloads carry ``{game_id, score}``;
           ``quest_completed`` payloads carry ``{period_type, quest_id}``.

Flat-importable (``from progression import ...``) per constitution
Principle V. Covered by tests/test_progression.py.
"""

from __future__ import annotations

import json
import random
import re
from datetime import date, datetime, timedelta
from pathlib import Path

__all__ = [
    "COUNT_GOAL_TYPES",
    "GOAL_TYPES",
    "SHOP_SLOTS",
    "THRESHOLD_GOAL_TYPES",
    "active_challenges",
    "evaluate_event",
    "goal_matches_event",
    "instrument_for_arrangement",
    "load_content",
    "mastery_rank",
    "path_max_level",
    "period_keys",
    "period_resets_at",
    "select_quests",
    "threshold_goal_met",
    "wallet_balance",
]

# Count goals increment per matching event; threshold goals complete the
# moment a snapshot value crosses the line (checked on every event).
COUNT_GOAL_TYPES = frozenset(
    {"song_completed", "songs_played_total", "minigame_run", "quest_completed"}
)
THRESHOLD_GOAL_TYPES = frozenset({"streak_reached", "db_earned"})
GOAL_TYPES = COUNT_GOAL_TYPES | THRESHOLD_GOAL_TYPES

SHOP_SLOTS = frozenset({"theme", "avatar_frame"})

CALIBRATION_ACCURACY = 0.9999  # >= this counts as the 100% calibration run


# ---------------------------------------------------------------------------
# Content loading / validation
# ---------------------------------------------------------------------------


def _valid_goal(goal, warnings: list, where: str) -> bool:
    """Validate one goal dict, appending human-readable warnings."""
    if not isinstance(goal, dict):
        warnings.append(f"{where}: goal is not an object")
        return False
    gtype = goal.get("type")
    if gtype not in GOAL_TYPES:
        warnings.append(f"{where}: unknown goal type {gtype!r}")
        return False
    if gtype in COUNT_GOAL_TYPES:
        target = goal.get("target")
        if not isinstance(target, int) or isinstance(target, bool) or target < 1:
            warnings.append(f"{where}: goal target must be a positive integer")
            return False
    elif gtype == "streak_reached":
        days = goal.get("days")
        if not isinstance(days, int) or isinstance(days, bool) or days < 1:
            warnings.append(f"{where}: streak_reached needs positive integer 'days'")
            return False
    elif gtype == "db_earned":
        amount = goal.get("amount")
        if not isinstance(amount, int) or isinstance(amount, bool) or amount < 1:
            warnings.append(f"{where}: db_earned needs positive integer 'amount'")
            return False
    for frac_key in ("min_accuracy",):
        if frac_key in goal:
            v = goal[frac_key]
            if not isinstance(v, (int, float)) or isinstance(v, bool) or not (0 < v <= 1):
                warnings.append(f"{where}: {frac_key} must be a fraction in (0, 1]")
                return False
    return True


def _load_json(path: Path, warnings: list):
    try:
        with open(path, "r", encoding="utf-8") as fh:
            return json.load(fh)
    except (OSError, ValueError) as exc:
        warnings.append(f"{path.name}: unreadable content file ({exc})")
        return None


def _load_path_file(path: Path, seen_challenge_ids: set, warnings: list):
    raw = _load_json(path, warnings)
    if not isinstance(raw, dict):
        if raw is not None:
            warnings.append(f"{path.name}: path file is not an object")
        return None
    pid = raw.get("id")
    if not isinstance(pid, str) or not pid:
        warnings.append(f"{path.name}: missing path id")
        return None
    levels_raw = raw.get("levels")
    if not isinstance(levels_raw, list) or not levels_raw:
        warnings.append(f"{path.name}: path {pid!r} has no levels")
        return None

    levels = []
    expected = 1
    for entry in levels_raw:
        where = f"{path.name}:{pid}"
        if not isinstance(entry, dict):
            warnings.append(f"{where}: level entry is not an object")
            continue
        lvl = entry.get("level")
        if not isinstance(lvl, int) or isinstance(lvl, bool) or lvl < 1:
            warnings.append(f"{where}: level number must be a positive integer")
            continue
        if lvl != expected:
            warnings.append(
                f"{where}: level numbering gap (expected {expected}, got {lvl})"
            )
        expected = lvl + 1
        challenges = []
        for ch in entry.get("challenges") or []:
            cid = isinstance(ch, dict) and ch.get("id")
            cwhere = f"{where} L{lvl} challenge {cid or '?'}"
            if not isinstance(cid, str) or not cid:
                warnings.append(f"{cwhere}: missing challenge id")
                continue
            if cid in seen_challenge_ids:
                warnings.append(f"{cwhere}: duplicate challenge id")
                continue
            if not _valid_goal(ch.get("goal"), warnings, cwhere):
                continue
            seen_challenge_ids.add(cid)
            challenges.append(
                {
                    "id": cid,
                    "title": str(ch.get("title") or cid),
                    "description": str(ch.get("description") or ""),
                    "goal": ch["goal"],
                }
            )
        required = entry.get("required")
        if not isinstance(required, int) or isinstance(required, bool) or required < 1:
            warnings.append(f"{where} L{lvl}: 'required' must be a positive integer")
            continue
        if not challenges:
            warnings.append(f"{where} L{lvl}: no valid challenges, level skipped")
            continue
        if required > len(challenges):
            warnings.append(
                f"{where} L{lvl}: required {required} > {len(challenges)} challenges; clamped"
            )
            required = len(challenges)
        levels.append({"level": lvl, "required": required, "challenges": challenges})

    if not levels:
        warnings.append(f"{path.name}: path {pid!r} has no valid levels")
        return None
    return {
        "id": pid,
        "name": str(raw.get("name") or pid),
        "icon": str(raw.get("icon") or ""),
        "order": raw.get("order") if isinstance(raw.get("order"), int) else 0,
        "levels": levels,
    }


def _load_quest_pool(raw, period_type: str, warnings: list):
    if not isinstance(raw, dict):
        warnings.append(f"quests.json: missing {period_type!r} section")
        return {"count": 0, "pool": {}}
    count = raw.get("count")
    if not isinstance(count, int) or isinstance(count, bool) or count < 1:
        warnings.append(f"quests.json: {period_type} count must be a positive integer")
        count = 0
    pool = {}
    for q in raw.get("pool") or []:
        qid = isinstance(q, dict) and q.get("id")
        where = f"quests.json {period_type} quest {qid or '?'}"
        if not isinstance(qid, str) or not qid:
            warnings.append(f"{where}: missing quest id")
            continue
        if qid in pool:
            warnings.append(f"{where}: duplicate quest id")
            continue
        reward = q.get("reward_db")
        if not isinstance(reward, int) or isinstance(reward, bool) or reward < 0:
            warnings.append(f"{where}: reward_db must be a non-negative integer")
            continue
        if not _valid_goal(q.get("goal"), warnings, where):
            continue
        pool[qid] = {
            "id": qid,
            "title": str(q.get("title") or qid),
            "description": str(q.get("description") or ""),
            "reward_db": reward,
            "goal": q["goal"],
        }
    return {"count": count, "pool": pool}


def _load_shop(raw, warnings: list):
    items = {}
    if not isinstance(raw, dict):
        return items
    for item in raw.get("items") or []:
        iid = isinstance(item, dict) and item.get("id")
        where = f"shop.json item {iid or '?'}"
        if not isinstance(iid, str) or not iid:
            warnings.append(f"{where}: missing item id")
            continue
        if iid in items:
            warnings.append(f"{where}: duplicate item id")
            continue
        slot = item.get("slot")
        if slot not in SHOP_SLOTS:
            warnings.append(f"{where}: unknown slot {slot!r}")
            continue
        cost = item.get("cost")
        if not isinstance(cost, int) or isinstance(cost, bool) or cost < 0:
            warnings.append(f"{where}: cost must be a non-negative integer")
            continue
        payload = item.get("payload")
        if not isinstance(payload, dict):
            warnings.append(f"{where}: payload must be an object")
            continue
        items[iid] = {
            "id": iid,
            "slot": slot,
            "name": str(item.get("name") or iid),
            "description": str(item.get("description") or ""),
            "cost": cost,
            "payload": payload,
        }
    return items


def load_content(root) -> tuple[dict, list]:
    """Load and validate the progression content bundle under ``root``.

    Returns ``(content, warnings)``. Invalid entries are skipped with a
    warning — bad content must never be fatal. ``content``::

        {
          "paths": {path_id: path},          # sorted by (order, id) when listed
          "challenge_index": {challenge_id: {"path_id", "level", "challenge"}},
          "quests": {"daily": {"count", "pool": {qid: quest}}, "weekly": {...}},
          "shop": {item_id: item},
        }
    """
    root = Path(root)
    warnings: list = []
    paths: dict = {}
    challenge_index: dict = {}
    seen_challenge_ids: set = set()

    paths_dir = root / "paths"
    if paths_dir.is_dir():
        for path_file in sorted(paths_dir.glob("*.json")):
            loaded = _load_path_file(path_file, seen_challenge_ids, warnings)
            if loaded is None:
                continue
            if loaded["id"] in paths:
                warnings.append(f"{path_file.name}: duplicate path id {loaded['id']!r}")
                continue
            paths[loaded["id"]] = loaded
            for level in loaded["levels"]:
                for ch in level["challenges"]:
                    challenge_index[ch["id"]] = {
                        "path_id": loaded["id"],
                        "level": level["level"],
                        "challenge": ch,
                    }
    else:
        warnings.append(f"missing content directory {paths_dir}")

    quests_raw = _load_json(root / "quests.json", warnings) or {}
    quests = {
        "daily": _load_quest_pool(quests_raw.get("daily"), "daily", warnings),
        "weekly": _load_quest_pool(quests_raw.get("weekly"), "weekly", warnings),
    }

    shop = _load_shop(_load_json(root / "shop.json", warnings) or {}, warnings)

    content = {
        "paths": paths,
        "challenge_index": challenge_index,
        "quests": quests,
        "shop": shop,
    }
    return content, warnings


# ---------------------------------------------------------------------------
# Instrument attribution
# ---------------------------------------------------------------------------


def instrument_for_arrangement(arr_entry, *, registry=None):
    """Map a library arrangement entry to a progression instrument.

    archive/loose entries carry ``type`` (lead/rhythm/bass/combo); sloppaks may
    only carry ``name``. Checks registered instruments first via the registry;
    falls back to hardcoded logic for backward compat. Returns None when the
    arrangement doesn't match any known instrument — callers must gate
    progression events on a non-None instrument so unknown arrangements
    never accrue to the wrong path.
    """
    if not isinstance(arr_entry, dict):
        if registry:
            return None
        return "guitar"
    arr_type = str(arr_entry.get("type") or "").strip().lower()
    name = str(arr_entry.get("name") or "").strip().lower()

    # Registry check — any registered instrument's roles match?
    if registry:
        for inst in registry.get_all():
            for role in inst.get("roles", []):
                if name in role.get("arrangement_names", []):
                    return inst["id"]
                if arr_type in role.get("arrangement_names", []):
                    return inst["id"]
        # Also check flags: build a virtual arr_entry for path flag matching
        for inst in registry.get_all():
            for role in inst.get("roles", []):
                for flag in role.get("arrangement_flags", []):
                    if arr_entry.get(flag):
                        return inst["id"]

    # Hardcoded fallback for known instruments
    if arr_type == "bass":
        return "bass"
    if arr_type == "drums":
        return "drums"
    if arr_type in ("piano", "keys"):
        return "keys"
    # Check name before committing to a guitar type — legacy archive keys
    # arrangements often carry a generic type (lead/rhythm/combo) but have a
    # name like "Keys" or "Piano".  Name overrides the generic type for all
    # well-known non-guitar instruments so that scored keys runs advance the
    # keys path and quests even when the chart XML type was not updated.
    if "bass" in name:
        return "bass"
    if "drum" in name or "percussion" in name:
        return "drums"
    if "vocal" in name:
        return "vocals"
    # Word-boundary match so e.g. "Monkeys Medley" doesn't read as keys.
    if re.search(r"\b(?:keys|piano|keyboard|synth)\b", name):
        return "keys"
    if arr_type in ("lead", "rhythm", "combo"):
        return "guitar"
    if registry:
        return None
    return "guitar"


# ---------------------------------------------------------------------------
# Quest periods
# ---------------------------------------------------------------------------


def period_keys(now: datetime) -> dict:
    """Period keys for ``now`` (local time): daily ``YYYY-MM-DD``, weekly
    ISO-week ``YYYY-Www`` (Monday-started)."""
    iso_year, iso_week, _ = now.date().isocalendar()
    return {
        "daily": now.date().isoformat(),
        "weekly": f"{iso_year}-W{iso_week:02d}",
    }


def period_resets_at(period_type: str, now: datetime) -> datetime:
    """When the current period rolls over: next local midnight (daily) or next
    Monday 00:00 local (weekly)."""
    midnight = datetime.combine(now.date() + timedelta(days=1), datetime.min.time())
    if period_type == "daily":
        return midnight
    if period_type == "weekly":
        days_to_monday = 7 - now.date().weekday()
        return datetime.combine(
            now.date() + timedelta(days=days_to_monday), datetime.min.time()
        )
    raise ValueError(f"unknown period type {period_type!r}")


def select_quests(pool_ids, period_type: str, period_key: str, count: int) -> list:
    """Deterministically pick ``count`` quest ids for a period.

    Same (period_type, period_key, pool) always yields the same selection, so
    quest rotation survives restarts without any persisted scheduler state.
    """
    ordered = sorted(pool_ids)
    if count >= len(ordered):
        return ordered
    rng = random.Random(f"{period_type}:{period_key}")  # noqa: S311 — deterministic, non-cryptographic sampling for quest rotation
    return sorted(rng.sample(ordered, count))


# ---------------------------------------------------------------------------
# Goal evaluation
# ---------------------------------------------------------------------------


def goal_matches_event(goal: dict, event: dict) -> bool:
    """Whether a count-based goal is advanced by this event (threshold goals
    never match events — see ``threshold_goal_met``).

    Diagnostic (calibration) plays are deliberately NOT regular songs: they
    only count toward a song goal that explicitly targets them by filename,
    so finishing onboarding at 100% yields exactly Mastery Rank 1 instead of
    also completing the first guitar challenges."""
    gtype = goal.get("type")
    etype = event.get("type")
    payload = event.get("payload") or {}
    if gtype == "songs_played_total":
        return etype == "song_completed" and not payload.get("is_diagnostic")
    if gtype == "song_completed":
        if etype != "song_completed":
            return False
        if payload.get("is_diagnostic") and goal.get("filename") != payload.get("filename"):
            return False
        instrument = goal.get("instrument")
        if instrument and payload.get("instrument") != instrument:
            return False
        if goal.get("filename") and payload.get("filename") != goal["filename"]:
            return False
        min_accuracy = goal.get("min_accuracy")
        if min_accuracy is not None:
            accuracy = payload.get("accuracy")
            if not isinstance(accuracy, (int, float)) or accuracy < min_accuracy:
                return False
        min_score = goal.get("min_score")
        if min_score is not None:
            score = payload.get("score")
            if not isinstance(score, (int, float)) or score < min_score:
                return False
        return True
    if gtype == "minigame_run":
        if etype != "minigame_run":
            return False
        if goal.get("game_id") and payload.get("game_id") != goal["game_id"]:
            return False
        min_score = goal.get("min_score")
        if min_score is not None:
            score = payload.get("score")
            if not isinstance(score, (int, float)) or score < min_score:
                return False
        return True
    if gtype == "quest_completed":
        if etype != "quest_completed":
            return False
        period = goal.get("period")
        if period and payload.get("period_type") != period:
            return False
        return True
    return False


def threshold_goal_met(goal: dict, snapshot: dict) -> bool:
    """Whether a threshold goal is satisfied by current snapshot values."""
    gtype = goal.get("type")
    if gtype == "streak_reached":
        return int(snapshot.get("streak") or 0) >= int(goal.get("days") or 0)
    if gtype == "db_earned":
        return int(snapshot.get("xp_total") or 0) >= int(goal.get("amount") or 0)
    return False


def _advance_counter(goal: dict, event: dict, count: int, detail):
    """Apply one matching event to a count-based goal.

    Returns ``(new_count, new_detail, advanced)``. ``distinct`` song goals
    keep the set of seen filenames in ``detail["seen"]`` so replays of the
    same song don't advance the counter.
    """
    detail = detail if isinstance(detail, dict) else {}
    if goal.get("type") == "song_completed" and goal.get("distinct"):
        filename = (event.get("payload") or {}).get("filename")
        if not filename:
            return count, detail, False
        seen = detail.get("seen")
        seen = list(seen) if isinstance(seen, list) else []
        if filename in seen:
            return count, detail, False
        seen.append(filename)
        return count + 1, {**detail, "seen": seen}, True
    return count + 1, detail, True


def evaluate_event(event: dict, content: dict, snapshot: dict) -> dict:
    """Evaluate one progression event against current state.

    Pure: returns the deltas for the caller to persist, never mutates inputs.
    Output::

        {
          "challenges": [{"challenge_id", "path_id", "level", "count",
                          "target", "detail", "completed"}],
          "quests": [{"period_type", "quest_id", "count", "target",
                      "detail", "completed", "reward_db"}],
          "level_ups": [{"path_id", "new_level"}],
          "calibration_completed": bool,
        }

    Only listed (i.e. changed) challenges/quests appear. Threshold goals
    (streak_reached, db_earned) are re-checked on every event since the
    snapshot values they read can move with any award.
    """
    outcome = {
        "challenges": [],
        "quests": [],
        "level_ups": [],
        "calibration_completed": False,
    }

    payload = event.get("payload") or {}
    if (
        event.get("type") == "song_completed"
        and payload.get("is_diagnostic")
        and isinstance(payload.get("accuracy"), (int, float))
        and payload["accuracy"] >= CALIBRATION_ACCURACY
        and snapshot.get("calibration_status") in ("pending", "skipped", None)
    ):
        outcome["calibration_completed"] = True

    challenge_state = snapshot.get("challenges") or {}
    path_levels = snapshot.get("paths") or {}
    # Completed counts per (path, level) so we can detect level-ups after
    # applying this event's challenge completions.
    completed_now: dict = {}

    for path_id, level in path_levels.items():
        for ch in active_challenges(content, path_id, level):
            goal = ch["goal"]
            state = challenge_state.get(ch["id"]) or {}
            if state.get("completed"):
                completed_now[path_id] = completed_now.get(path_id, 0) + 1
                continue
            count = int(state.get("count") or 0)
            detail = state.get("detail")
            gtype = goal.get("type")
            changed = False
            completed = False
            if gtype in THRESHOLD_GOAL_TYPES:
                if threshold_goal_met(goal, snapshot):
                    changed = completed = True
            elif goal_matches_event(goal, event):
                count, detail, advanced = _advance_counter(goal, event, count, detail)
                if advanced:
                    changed = True
                    completed = count >= int(goal.get("target") or 1)
            if changed:
                target = int(goal.get("target") or 1) if gtype in COUNT_GOAL_TYPES else 1
                outcome["challenges"].append(
                    {
                        "challenge_id": ch["id"],
                        "path_id": path_id,
                        "level": level + 1,
                        "count": count if gtype in COUNT_GOAL_TYPES else target,
                        "target": target,
                        "detail": detail if isinstance(detail, dict) and detail else None,
                        "completed": completed,
                    }
                )
            if completed:
                completed_now[path_id] = completed_now.get(path_id, 0) + 1

    for path_id, level in path_levels.items():
        nxt = _level_entry(content, path_id, level + 1)
        if nxt and completed_now.get(path_id, 0) >= nxt["required"]:
            outcome["level_ups"].append({"path_id": path_id, "new_level": level + 1})

    for quest in snapshot.get("quests") or []:
        if quest.get("completed"):
            continue
        period_type = quest.get("period_type")
        pool = (content.get("quests") or {}).get(period_type, {}).get("pool", {})
        qdef = pool.get(quest.get("quest_id"))
        if not qdef:
            continue
        goal = qdef["goal"]
        count = int(quest.get("count") or 0)
        detail = quest.get("detail")
        gtype = goal.get("type")
        changed = False
        completed = False
        if gtype in THRESHOLD_GOAL_TYPES:
            if threshold_goal_met(goal, snapshot):
                changed = completed = True
        elif goal_matches_event(goal, event):
            count, detail, advanced = _advance_counter(goal, event, count, detail)
            if advanced:
                changed = True
                completed = count >= int(goal.get("target") or 1)
        if changed:
            target = int(goal.get("target") or 1) if gtype in COUNT_GOAL_TYPES else 1
            outcome["quests"].append(
                {
                    "period_type": period_type,
                    "quest_id": quest["quest_id"],
                    "count": count if gtype in COUNT_GOAL_TYPES else target,
                    "target": target,
                    "detail": detail if isinstance(detail, dict) and detail else None,
                    "completed": completed,
                    "reward_db": int(quest.get("reward_db") or 0),
                }
            )

    return outcome


# ---------------------------------------------------------------------------
# Rank / paths / wallet math
# ---------------------------------------------------------------------------


def _level_entry(content: dict, path_id: str, level: int):
    path = (content.get("paths") or {}).get(path_id)
    if not path:
        return None
    for entry in path["levels"]:
        if entry["level"] == level:
            return entry
    return None


def active_challenges(content: dict, path_id: str, level: int) -> list:
    """The challenge set a path at ``level`` is working on (level+1's set).
    Empty at max level or for unknown paths."""
    nxt = _level_entry(content, path_id, level + 1)
    return list(nxt["challenges"]) if nxt else []


def path_max_level(content: dict, path_id: str) -> int:
    path = (content.get("paths") or {}).get(path_id)
    if not path or not path["levels"]:
        return 0
    return max(entry["level"] for entry in path["levels"])


def mastery_rank(calibration_status, path_levels) -> int:
    """Mastery Rank = onboarding rank (1 once calibration is completed or
    skipped) + the sum of all selected path levels."""
    onboarding = 0 if (calibration_status or "pending") == "pending" else 1
    return onboarding + sum(int(v or 0) for v in (path_levels or {}).values())


def wallet_balance(xp_total, spent) -> int:
    """Spendable dB. Clamped at 0: a per-source XP reset can lower lifetime
    earnings below the amount already spent."""
    return max(0, int(xp_total or 0) - int(spent or 0))
