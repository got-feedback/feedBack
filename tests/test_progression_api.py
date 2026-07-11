"""Tests for the progression + shop endpoints (spec 010) and the
/api/stats → progression event wiring."""

import importlib
import json
import sys

import builtin_content
import pytest
from fastapi.testclient import TestClient


def _write_fixture_content(root):
    """Small deterministic content bundle (single-quest pools so rotation is
    fixed regardless of date)."""
    (root / "paths").mkdir(parents=True)
    (root / "paths" / "guitar.json").write_text(json.dumps({
        "id": "guitar", "name": "Guitar", "icon": "guitar", "order": 1,
        "levels": [
            {"level": 1, "required": 1, "challenges": [
                {"id": "guitar.l1.c1", "title": "Clean Run",
                 "description": "80%+ accuracy on a guitar song.",
                 "goal": {"type": "song_completed", "instrument": "guitar",
                          "min_accuracy": 0.8, "target": 1}},
            ]},
            {"level": 2, "required": 1, "challenges": [
                {"id": "guitar.l2.c1", "title": "Daily Pair",
                 "description": "Complete 2 daily quests.",
                 "goal": {"type": "quest_completed", "period": "daily", "target": 2}},
            ]},
        ],
    }))
    (root / "paths" / "bass.json").write_text(json.dumps({
        "id": "bass", "name": "Bass", "icon": "bass", "order": 2,
        "levels": [
            {"level": 1, "required": 1, "challenges": [
                {"id": "bass.l1.c1", "title": "First Groove",
                 "description": "Finish a bass song.",
                 "goal": {"type": "song_completed", "instrument": "bass", "target": 1}},
            ]},
        ],
    }))
    (root / "quests.json").write_text(json.dumps({
        "daily": {"count": 1, "pool": [
            {"id": "d.one", "title": "Quick Set", "description": "Finish a song.",
             "reward_db": 50, "goal": {"type": "song_completed", "target": 1}},
        ]},
        "weekly": {"count": 1, "pool": [
            {"id": "w.mini", "title": "Arcade Pair", "description": "2 rounds.",
             "reward_db": 100, "goal": {"type": "minigame_run", "target": 2}},
        ]},
    }))
    (root / "shop.json").write_text(json.dumps({
        "items": [
            {"id": "theme.test", "slot": "theme", "name": "Test Theme",
             "description": "", "cost": 100, "payload": {"colors": {"bg": "#000000"}}},
            {"id": "frame.test", "slot": "avatar_frame", "name": "Test Frame",
             "description": "", "cost": 50, "payload": {"frame_style": "box-shadow: 0 0 0 1px red"}},
        ],
    }))


@pytest.fixture()
def server(tmp_path, monkeypatch, isolate_logging):
    content_dir = tmp_path / "progression-content"
    _write_fixture_content(content_dir)
    monkeypatch.setenv("CONFIG_DIR", str(tmp_path / "config"))
    monkeypatch.setenv("FEEDBACK_PROGRESSION_DATA", str(content_dir))
    monkeypatch.setenv("FEEDBACK_SKIP_STARTUP_TASKS", "1")
    sys.modules.pop("server", None)
    srv = importlib.import_module("server")
    try:
        yield srv
    finally:
        conn = getattr(getattr(srv, "meta_db", None), "conn", None)
        if conn is not None:
            getattr(__import__("sys").modules.get("server"), "_join_background_db_threads", lambda: None)()
            conn.close()
        sys.modules.pop("server", None)


@pytest.fixture()
def client(server):
    return TestClient(server.app)


def _scored_play(client, filename="song.archive", accuracy=0.9, score=900, arrangement=0):
    return client.post("/api/stats", json={
        "filename": filename, "arrangement": arrangement,
        "score": score, "accuracy": accuracy,
    })


# ── Overview / onboarding ─────────────────────────────────────────────────────

def test_fresh_overview(client):
    r = client.get("/api/progression")
    assert r.status_code == 200
    data = r.json()
    assert data["mastery_rank"] == 0
    assert data["onboarding"]["calibration_status"] == "pending"
    assert data["onboarding"]["diagnostic_filename"].startswith("diagnostics-builtin/")
    assert data["paths"] == []
    assert [p["id"] for p in data["available_paths"]] == ["guitar", "bass"]
    # Current quest periods are lazily instantiated on read.
    assert [q["id"] for q in data["quests"]["daily"]["quests"]] == ["d.one"]
    assert [q["id"] for q in data["quests"]["weekly"]["quests"]] == ["w.mini"]
    assert data["quests"]["daily"]["resets_at"] > data["quests"]["daily"]["period_key"]
    assert data["wallet"] == {"balance": 0, "lifetime_db": 0, "spent": 0}


def test_add_paths_validates_and_is_idempotent(client):
    assert client.post("/api/progression/paths", json={"add": []}).status_code == 400
    assert client.post("/api/progression/paths", json={"add": "guitar"}).status_code == 400
    assert client.post("/api/progression/paths", json={"add": ["keytar"]}).status_code == 400

    r = client.post("/api/progression/paths", json={"add": ["guitar"]})
    assert r.status_code == 200
    paths = r.json()["paths"]
    assert [p["id"] for p in paths] == ["guitar"]
    assert paths[0]["level"] == 0
    assert paths[0]["max_level"] == 2
    assert paths[0]["next"]["level"] == 1
    assert [c["id"] for c in paths[0]["next"]["challenges"]] == ["guitar.l1.c1"]
    assert [p["id"] for p in r.json()["available_paths"]] == ["bass"]

    # Re-adding never resets the level.
    r2 = client.post("/api/progression/paths", json={"add": ["guitar"]})
    assert [p["id"] for p in r2.json()["paths"]] == ["guitar"]


def test_skip_calibration_reaches_rank_one(client):
    # Spec invariant: skipping requires at least one selected path first.
    assert client.post("/api/progression/onboarding", json={"action": "skip"}).status_code == 400
    client.post("/api/progression/paths", json={"add": ["guitar"]})

    r = client.post("/api/progression/onboarding", json={"action": "skip"})
    assert r.status_code == 200
    assert r.json()["mastery_rank"] == 1
    assert r.json()["onboarding"]["calibration_status"] == "skipped"
    # Idempotent; bad action rejected.
    assert client.post("/api/progression/onboarding", json={"action": "skip"}).json()[
        "onboarding"]["calibration_status"] == "skipped"
    assert client.post("/api/progression/onboarding", json={"action": "reset"}).status_code == 400


def test_skip_allowed_when_content_defines_no_paths(client, server, monkeypatch):
    # Robustness carve-out: broken/empty content must never brick onboarding.
    content = {**server._get_progression_content(), "paths": {}}
    monkeypatch.setattr(server, "_progression_content", content)
    assert client.post("/api/progression/onboarding", json={"action": "skip"}).status_code == 200


# ── Scored-play wiring ────────────────────────────────────────────────────────

def test_scored_play_advances_challenge_quest_and_levels(client, server):
    client.post("/api/progression/paths", json={"add": ["guitar"]})
    client.post("/api/progression/onboarding", json={"action": "skip"})

    r = _scored_play(client, accuracy=0.9, score=900)
    assert r.status_code == 200
    summary = r.json()["progression"]
    assert summary is not None
    assert [c["id"] for c in summary["challenges_completed"]] == ["guitar.l1.c1"]
    assert summary["level_ups"] == [{"path_id": "guitar", "new_level": 1}]
    assert [q["id"] for q in summary["quests_completed"]] == ["d.one"]
    assert summary["mastery_rank"] == 2  # skip (1) + guitar level 1

    overview = client.get("/api/progression").json()
    assert overview["mastery_rank"] == 2
    guitar = overview["paths"][0]
    assert guitar["level"] == 1
    # Now working the level-2 set; the d.one completion already counted 1/2
    # via the quest_completed re-entry.
    assert guitar["next"]["level"] == 2
    assert guitar["next"]["challenges"][0]["count"] == 1
    # Quest reward landed in the unified store under source "quests".
    from xp import xp_for_run
    assert overview["wallet"]["lifetime_db"] == xp_for_run(900) + 50
    row = server.meta_db.conn.execute(
        "SELECT xp FROM xp_sources WHERE source = 'quests'").fetchone()
    assert row[0] == 50


def test_low_accuracy_play_does_not_complete_gated_challenge(client):
    client.post("/api/progression/paths", json={"add": ["guitar"]})
    r = _scored_play(client, accuracy=0.5, score=100)
    summary = r.json()["progression"]
    assert summary["challenges_completed"] == []
    assert summary["level_ups"] == []
    # The unfiltered daily quest still advances (and completes at target 1).
    assert [q["id"] for q in summary["quests_completed"]] == ["d.one"]


def test_diagnostic_at_100_completes_calibration(client, server):
    diag = builtin_content.builtin_diagnostic_filename()
    # A near-miss leaves calibration pending.
    _scored_play(client, filename=diag, accuracy=0.97, score=500)
    assert client.get("/api/progression").json()["onboarding"]["calibration_status"] == "pending"

    _scored_play(client, filename=diag, accuracy=1.0, score=500)
    data = client.get("/api/progression").json()
    assert data["onboarding"]["calibration_status"] == "completed"
    assert data["mastery_rank"] == 1


def test_diagnostic_play_does_not_feed_challenges_or_quests(client, server):
    # The calibration run is a perfect guitar play — it must yield rank 1
    # EXACTLY, advancing neither the guitar path nor the daily song quest.
    client.post("/api/progression/paths", json={"add": ["guitar"]})
    r = _scored_play(client, filename=builtin_content.builtin_diagnostic_filename(),
                     accuracy=1.0, score=500)
    summary = r.json()["progression"]
    assert summary["calibration_completed"] is True
    assert summary["challenges_completed"] == []
    assert summary["level_ups"] == []
    assert summary["quests_completed"] == []
    assert summary["mastery_rank"] == 1

    data = client.get("/api/progression").json()
    assert data["mastery_rank"] == 1
    assert data["paths"][0]["level"] == 0
    assert all(q["count"] == 0 for q in data["quests"]["daily"]["quests"])


def test_pathless_diagnostic_run_still_completes_calibration(client, server):
    """INTENDED (spec FR-007b): the ≥1-path invariant binds the onboarding
    wizard and the explicit skip action, NOT the stats plane. A 100% diagnostic
    run is an earned achievement and must count even before any path is
    selected (e.g. a pre-progression profile playing the diagnostic as a
    hardware test) — yielding a valid pathless rank-1 state."""
    _scored_play(client, filename=builtin_content.builtin_diagnostic_filename(),
                 accuracy=1.0, score=500)
    data = client.get("/api/progression").json()
    assert data["onboarding"]["calibration_status"] == "completed"
    assert data["mastery_rank"] == 1
    assert data["paths"] == []


def test_diagnostic_upgrades_skipped_without_rank_change(client, server):
    client.post("/api/progression/paths", json={"add": ["guitar"]})
    r = client.post("/api/progression/onboarding", json={"action": "skip"})
    assert r.json()["onboarding"]["calibration_status"] == "skipped"
    _scored_play(client, filename=builtin_content.builtin_diagnostic_filename(), accuracy=1.0, score=500)
    data = client.get("/api/progression").json()
    assert data["onboarding"]["calibration_status"] == "completed"
    assert data["mastery_rank"] == 1


def test_progression_failure_never_drops_stat_write(client, server, monkeypatch):
    def _boom(*args, **kwargs):
        raise RuntimeError("engine exploded")
    monkeypatch.setattr(server.meta_db, "record_progression_event", _boom)
    r = _scored_play(client, accuracy=0.9, score=400)
    assert r.status_code == 200
    assert r.json()["stats"]["plays"] == 1
    assert r.json()["progression"] is None
    assert r.json()["progress"] is not None  # XP/streak side-effects intact


# ── Generic event intake ──────────────────────────────────────────────────────

def test_events_endpoint_whitelist(client):
    # song_completed is server-derived: rejected from external intake.
    r = client.post("/api/progression/events",
                    json={"type": "song_completed", "payload": {"accuracy": 1.0}})
    assert r.status_code == 400
    assert client.post("/api/progression/events", json={"type": "nope"}).status_code == 400


def test_events_endpoint_validates_payload(client):
    bad_big = {f"k{i}": i for i in range(17)}
    assert client.post("/api/progression/events",
                       json={"type": "minigame_run", "payload": bad_big}).status_code == 400
    assert client.post("/api/progression/events",
                       json={"type": "minigame_run", "payload": {"meta": {"nested": 1}}}).status_code == 400
    assert client.post("/api/progression/events",
                       json={"type": "minigame_run", "payload": {"x": "y" * 257}}).status_code == 400


def test_stale_quest_completion_does_not_double_award(client, server, monkeypatch):
    """A quest completion computed from a stale snapshot (concurrent event won
    the guarded UPDATE) must not pay its reward or re-enter again."""
    _scored_play(client)  # completes daily d.one (+50 dB)
    xp_before = server.meta_db.get_xp()

    real_snapshot = server.meta_db.progression_snapshot
    def stale_snapshot(content, now):
        snap = real_snapshot(content, now)
        for quest in snap["quests"]:
            if quest["quest_id"] == "d.one":
                quest["completed"] = False
                quest["count"] = 0
        return snap
    monkeypatch.setattr(server.meta_db, "progression_snapshot", stale_snapshot)

    summary = server.meta_db.record_progression_event(
        "song_completed",
        {"filename": "y.archive", "instrument": "guitar", "accuracy": 0.5, "score": 100},
        server._get_progression_content(),
    )
    assert all(q["id"] != "d.one" for q in summary["quests_completed"])
    assert server.meta_db.get_xp() == xp_before  # no double reward


def test_minigame_events_advance_weekly_quest(client):
    r1 = client.post("/api/progression/events",
                     json={"type": "minigame_run", "payload": {"game_id": "g", "score": 10}})
    assert r1.status_code == 200
    assert r1.json()["progression"]["quests_completed"] == []

    r2 = client.post("/api/progression/events",
                     json={"type": "minigame_run", "payload": {"game_id": "g", "score": 10}})
    completed = r2.json()["progression"]["quests_completed"]
    assert [q["id"] for q in completed] == ["w.mini"]
    assert completed[0]["reward_db"] == 100
    assert client.get("/api/progression").json()["wallet"]["lifetime_db"] == 100


# ── Shop ──────────────────────────────────────────────────────────────────────

def test_shop_catalog_and_purchase_flow(client, server):
    catalog = client.get("/api/shop").json()
    assert {i["id"] for i in catalog["items"]} == {"theme.test", "frame.test"}
    assert all(not i["owned"] and not i["equipped"] for i in catalog["items"])

    # Insufficient balance: rejected, nothing mutates.
    r = client.post("/api/shop/buy", json={"item_id": "theme.test"})
    assert r.status_code == 402
    assert r.json()["wallet"]["spent"] == 0

    server.meta_db.award_xp(500)
    r = client.post("/api/shop/buy", json={"item_id": "theme.test"})
    assert r.status_code == 200
    assert r.json()["wallet"] == {"balance": 400, "lifetime_db": 500, "spent": 100}

    # Double-buy → 409; unknown item → 400.
    assert client.post("/api/shop/buy", json={"item_id": "theme.test"}).status_code == 409
    assert client.post("/api/shop/buy", json={"item_id": "theme.nope"}).status_code == 400

    # Spending never touches lifetime XP.
    assert server.meta_db.get_xp() == 500


def test_shop_equip_requires_ownership(client, server):
    assert client.post("/api/shop/equip",
                       json={"slot": "theme", "item_id": "theme.test"}).status_code == 403
    assert client.post("/api/shop/equip",
                       json={"slot": "hat", "item_id": "theme.test"}).status_code == 400
    # Slot/item mismatch is a 400 even when the item exists.
    assert client.post("/api/shop/equip",
                       json={"slot": "avatar_frame", "item_id": "theme.test"}).status_code == 400

    server.meta_db.award_xp(500)
    client.post("/api/shop/buy", json={"item_id": "theme.test"})
    r = client.post("/api/shop/equip", json={"slot": "theme", "item_id": "theme.test"})
    assert r.status_code == 200
    assert r.json()["equipped"] == {"theme": "theme.test"}

    # Equipped cosmetics ride along on /api/profile (resolved payloads).
    profile = client.get("/api/profile").json()
    assert profile["cosmetics"]["theme"]["item_id"] == "theme.test"
    assert profile["cosmetics"]["theme"]["payload"] == {"colors": {"bg": "#000000"}}

    # Unequip restores the default.
    r = client.post("/api/shop/equip", json={"slot": "theme", "item_id": None})
    assert r.json()["equipped"] == {}
    assert client.get("/api/profile").json()["cosmetics"] == {}


def test_wallet_balance_clamps_after_source_reset(client, server):
    server.meta_db.award_xp(200, "minigames")
    client.post("/api/shop/buy", json={"item_id": "frame.test"})   # spend 50
    server.meta_db.reset_source_xp("minigames")                    # lifetime → 0
    wallet = client.get("/api/shop").json()["wallet"]
    assert wallet == {"balance": 0, "lifetime_db": 0, "spent": 50}
