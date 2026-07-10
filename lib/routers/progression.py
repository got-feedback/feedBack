"""Progression (spec 010) — mastery rank, challenges, quests, onboarding paths.

Extracted verbatim from ``server.py`` (R3); edits: ``@app`` -> ``@router``,
``meta_db`` -> ``appstate.meta_db``, ``_clean_str`` from ``reqfields``, and the
two shared server accessors read through the seam:
``_get_progression_content()`` -> ``appstate.get_progression_content()`` and
``_builtin_diagnostic_filename()`` -> ``appstate.builtin_diagnostic_filename()``.
The exclusive helpers (_goal_ui_progress, _progression_overview) + the
_PROGRESSION_EVENT_TYPES whitelist move with it.
"""

import math

from fastapi import APIRouter
from fastapi.responses import JSONResponse

import appstate
from reqfields import _clean_str

router = APIRouter()


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
    content = appstate.get_progression_content()
    now = _dt.now()
    appstate.meta_db.ensure_quest_period(content, now)

    state = appstate.meta_db.get_progression_state()
    player_paths = appstate.meta_db.get_player_paths()
    challenge_state = appstate.meta_db.get_challenge_state()
    wallet = appstate.meta_db.get_wallet()
    streak_progress = appstate.meta_db.get_progress()
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

    quest_rows = appstate.meta_db.get_quest_rows(keys)
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
            "diagnostic_filename": appstate.builtin_diagnostic_filename(),
        },
        "paths": paths_payload,
        "available_paths": available,
        "quests": quests_payload,
        "wallet": wallet,
    }


@router.get("/api/progression")
def api_progression():
    return _progression_overview()


@router.post("/api/progression/paths")
def api_progression_add_paths(data: dict):
    """Select instrument paths. Body: {add: [path_id, ...]}. Idempotent;
    removal is unsupported (Mastery Rank never decreases)."""
    add = data.get("add")
    if not isinstance(add, list) or not add:
        return JSONResponse({"error": "add must be a non-empty list of path ids"}, status_code=400)
    content = appstate.get_progression_content()
    for pid in add:
        if not isinstance(pid, str) or pid not in content["paths"]:
            return JSONResponse({"error": f"unknown path: {pid!r}"}, status_code=400)
    appstate.meta_db.add_player_paths(add)
    return _progression_overview()


@router.post("/api/progression/onboarding")
def api_progression_onboarding(data: dict):
    """Onboarding calibration choice. Body: {action: "skip"} — completing the
    calibration needs no endpoint, it flows through the normal /api/stats path."""
    if _clean_str(data.get("action")) != "skip":
        return JSONResponse({"error": "action must be 'skip'"}, status_code=400)
    # Spec invariant: onboarding requires picking at least one instrument path
    # before finishing, so skipping straight to rank 1 with no paths would
    # leave a rank that can never grow. Only enforced when the content bundle
    # actually defines paths — broken/empty content must never brick onboarding.
    if appstate.get_progression_content()["paths"] and not appstate.meta_db.get_player_paths():
        return JSONResponse(
            {"error": "select at least one instrument path before skipping calibration"},
            status_code=400,
        )
    appstate.meta_db.skip_calibration()
    return _progression_overview()


# Externally postable progression events. song_completed is deliberately NOT
# here: it is server-derived inside /api/stats so the scored-session authority
# stays in one place.
_PROGRESSION_EVENT_TYPES = {"minigame_run"}


@router.post("/api/progression/events")
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
    summary = appstate.meta_db.record_progression_event(etype, clean, appstate.get_progression_content())
    return {"ok": True, "progression": summary}
