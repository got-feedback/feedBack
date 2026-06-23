"""Tests for plugins/minigames/routes.py — run submission, leaderboard
ordering/limits, profile get/reset, and registry endpoints.

Follows the same importlib fixture pattern as test_highway_3d_routes.py so
the routes module is loaded fresh per test session without importing the
full server stack.
"""

import importlib
import importlib.util
import json
import sys
import time
from pathlib import Path

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient


# ── Fixture ───────────────────────────────────────────────────────────────────

@pytest.fixture()
def setup_routes(tmp_path):
    """Load plugins/minigames/routes.py via importlib, wire it to a fresh
    FastAPI app backed by tmp_path, and return (client, routes_module)."""
    routes_path = (
        Path(__file__).parent.parent / "plugins" / "minigames" / "routes.py"
    )
    spec = importlib.util.spec_from_file_location(
        "minigames_routes_test_module", routes_path
    )
    routes = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(routes)

    app = FastAPI()
    context = {"config_dir": str(tmp_path)}
    routes.setup(app, context)

    client = TestClient(app, raise_server_exceptions=True)
    try:
        yield client, routes
    finally:
        client.close()
        sys.modules.pop("minigames_routes_test_module", None)


# ── Helpers ───────────────────────────────────────────────────────────────────

def _submit(client, game_id="test-game", score=100, duration_ms=5000,
            modifiers=None, meta=None):
    payload = {
        "game_id": game_id,
        "score": score,
        "duration_ms": duration_ms,
        "modifiers": modifiers or {},
        "meta": meta or {},
    }
    return client.post("/api/plugins/minigames/runs", json=payload)


# ── Run submission ────────────────────────────────────────────────────────────

def test_submit_run_returns_ok_and_run_id(setup_routes):
    client, _ = setup_routes
    r = _submit(client, score=200)
    assert r.status_code == 200
    body = r.json()
    assert body["ok"] is True
    assert isinstance(body["run_id"], int)
    assert body["run_id"] >= 1


def test_submit_run_awards_xp(setup_routes):
    client, routes = setup_routes
    r = _submit(client, score=100)
    assert r.status_code == 200
    body = r.json()
    expected_xp = routes.xp_for_run(100)
    assert body["xp_gained"] == expected_xp
    assert body["profile"]["xp"] == expected_xp


def test_submit_run_zero_score_awards_zero_xp(setup_routes):
    client, _ = setup_routes
    r = _submit(client, score=0)
    assert r.status_code == 200
    body = r.json()
    assert body["xp_gained"] == 0
    assert body["profile"]["xp"] == 0


def test_submit_run_negative_score_rejected(setup_routes):
    client, _ = setup_routes
    r = client.post(
        "/api/plugins/minigames/runs",
        json={"game_id": "g", "score": -1, "duration_ms": 0},
    )
    assert r.status_code == 422


def test_submit_multiple_runs_accumulates_xp(setup_routes):
    client, routes = setup_routes
    _submit(client, score=100)
    _submit(client, score=400)
    r = client.get("/api/plugins/minigames/profile")
    assert r.status_code == 200
    profile = r.json()
    expected = routes.xp_for_run(100) + routes.xp_for_run(400)
    assert profile["xp"] == expected


def test_submit_run_increments_totals(setup_routes):
    client, _ = setup_routes
    _submit(client, game_id="alpha", score=50)
    _submit(client, game_id="alpha", score=150)
    r = client.get("/api/plugins/minigames/profile")
    assert r.status_code == 200
    totals = r.json()["totals"]
    assert totals["runs"] == 2
    assert totals["score"] == 200
    per = totals["per_game"]["alpha"]
    assert per["runs"] == 2
    assert per["best_score"] == 150
    assert per["total_score"] == 200


def test_submit_run_cross_game_totals_isolated(setup_routes):
    client, _ = setup_routes
    _submit(client, game_id="game-a", score=10)
    _submit(client, game_id="game-b", score=20)
    r = client.get("/api/plugins/minigames/profile")
    totals = r.json()["totals"]["per_game"]
    assert totals["game-a"]["runs"] == 1
    assert totals["game-b"]["runs"] == 1


def test_submit_run_oversized_modifiers_rejected(setup_routes):
    """modifiers/meta payloads exceeding _MAX_RUN_JSON_BYTES are rejected 400."""
    client, routes = setup_routes
    cap = routes._MAX_RUN_JSON_BYTES
    # Build a dict whose serialised size just exceeds the cap.
    oversized = {"k": "x" * (cap + 1)}
    r = client.post(
        "/api/plugins/minigames/runs",
        json={"game_id": "g", "score": 10, "duration_ms": 0, "modifiers": oversized},
    )
    assert r.status_code == 400


def test_submit_run_within_size_limit_accepted(setup_routes):
    """Payloads well within the cap are accepted normally."""
    client, _ = setup_routes
    r = _submit(client, modifiers={"key": "value"}, meta={"info": "ok"})
    assert r.status_code == 200


# ── Leaderboard ordering and limits ──────────────────────────────────────────

def test_list_runs_ordered_by_score_desc(setup_routes):
    client, _ = setup_routes
    for score in (50, 300, 100, 200):
        _submit(client, game_id="race", score=score)
    r = client.get("/api/plugins/minigames/runs?game_id=race")
    assert r.status_code == 200
    scores = [row["score"] for row in r.json()["runs"]]
    assert scores == sorted(scores, reverse=True)


def test_list_runs_filter_by_game_id(setup_routes):
    client, _ = setup_routes
    _submit(client, game_id="alpha", score=100)
    _submit(client, game_id="beta", score=200)
    r = client.get("/api/plugins/minigames/runs?game_id=alpha")
    assert r.status_code == 200
    runs = r.json()["runs"]
    assert all(row["game_id"] == "alpha" for row in runs)
    assert len(runs) == 1


def test_list_runs_limit_respected(setup_routes):
    client, _ = setup_routes
    for i in range(10):
        _submit(client, game_id="flood", score=i * 10)
    r = client.get("/api/plugins/minigames/runs?game_id=flood&limit=5")
    assert r.status_code == 200
    assert len(r.json()["runs"]) == 5


def test_list_runs_limit_out_of_range_returns_400(setup_routes):
    client, _ = setup_routes
    r = client.get("/api/plugins/minigames/runs?limit=0")
    assert r.status_code == 400
    r = client.get("/api/plugins/minigames/runs?limit=501")
    assert r.status_code == 400


def test_list_runs_invalid_scope_returns_400(setup_routes):
    client, _ = setup_routes
    r = client.get("/api/plugins/minigames/runs?scope=other")
    assert r.status_code == 400


def test_list_runs_empty_returns_empty_list(setup_routes):
    client, _ = setup_routes
    r = client.get("/api/plugins/minigames/runs")
    assert r.status_code == 200
    assert r.json()["runs"] == []


def test_list_runs_run_fields_present(setup_routes):
    client, _ = setup_routes
    _submit(client, game_id="g", score=77, duration_ms=1234,
            modifiers={"x": 1}, meta={"note": "hi"})
    r = client.get("/api/plugins/minigames/runs?game_id=g")
    row = r.json()["runs"][0]
    assert row["game_id"] == "g"
    assert row["score"] == 77
    assert row["duration_ms"] == 1234
    assert row["modifiers"] == {"x": 1}
    assert row["meta"] == {"note": "hi"}
    assert "xp_awarded" in row
    assert "created_at" in row


# ── Profile ───────────────────────────────────────────────────────────────────

def test_get_profile_initial_state(setup_routes):
    client, _ = setup_routes
    r = client.get("/api/plugins/minigames/profile")
    assert r.status_code == 200
    p = r.json()
    assert p["xp"] == 0
    assert p["level"] == 1
    assert p["unlocks"] == []


def test_get_profile_xp_to_next_level_present(setup_routes):
    client, routes = setup_routes
    r = client.get("/api/plugins/minigames/profile")
    assert "xp_to_next_level" in r.json()


def test_get_profile_level_advances_with_xp(setup_routes):
    client, routes = setup_routes
    # Submit enough score to push xp past level-2 threshold (xp >= 100)
    # xp_for_run(score) = floor(sqrt(score) * 10), so score=100 => xp=100 => L2
    _submit(client, score=100)
    r = client.get("/api/plugins/minigames/profile")
    p = r.json()
    assert p["level"] >= 2


# ── Reset semantics ───────────────────────────────────────────────────────────

def test_reset_clears_profile_and_runs(setup_routes):
    client, _ = setup_routes
    _submit(client, game_id="g", score=500)
    r_reset = client.post("/api/plugins/minigames/profile/reset")
    assert r_reset.status_code == 200
    assert r_reset.json()["ok"] is True

    # Profile should be zeroed.
    r_profile = client.get("/api/plugins/minigames/profile")
    p = r_profile.json()
    assert p["xp"] == 0
    assert p["level"] == 1
    assert p["unlocks"] == []

    # Run history should be empty.
    r_runs = client.get("/api/plugins/minigames/runs")
    assert r_runs.json()["runs"] == []


def test_reset_then_resubmit_works(setup_routes):
    client, _ = setup_routes
    _submit(client, game_id="g", score=100)
    client.post("/api/plugins/minigames/profile/reset")
    _submit(client, game_id="g", score=50)
    # Run history should contain only the post-reset run.
    r_runs = client.get("/api/plugins/minigames/runs")
    assert len(r_runs.json()["runs"]) == 1
    assert r_runs.json()["runs"][0]["score"] == 50


def test_reset_idempotent(setup_routes):
    client, _ = setup_routes
    r1 = client.post("/api/plugins/minigames/profile/reset")
    r2 = client.post("/api/plugins/minigames/profile/reset")
    assert r1.status_code == 200
    assert r2.status_code == 200


# ── Registry ─────────────────────────────────────────────────────────────────

def test_registry_returns_empty_when_no_minigame_plugins(setup_routes):
    client, _ = setup_routes
    r = client.get("/api/plugins/minigames/registry")
    assert r.status_code == 200
    assert r.json()["minigames"] == []


def test_registry_returns_minigame_plugin(tmp_path, monkeypatch):
    """Simulate a plugin directory with a minigame block and verify it shows
    up in the registry.

    Uses FEEDBACK_PLUGINS_DIR so the resolver scans a controlled directory
    rather than the repo's live plugins/ tree.
    """
    plugins_dir = tmp_path / "plugins"
    plugins_dir.mkdir()
    plugin_dir = plugins_dir / "fake-minigame"
    plugin_dir.mkdir()
    (plugin_dir / "plugin.json").write_text(json.dumps({
        "id": "fake-minigame",
        "version": "1.0.0",
        "minigame": {
            "name": "Fake Minigame",
            "description": "A test minigame.",
        },
    }), encoding="utf-8")

    monkeypatch.setenv("FEEDBACK_PLUGINS_DIR", str(plugins_dir))

    # Load a fresh module instance and call setup() so that _resolve_plugin_dirs
    # (defined as a closure inside setup()) picks up the monkeypatched env var.
    # os.environ.get() is called at resolver-invocation time, so the reload is
    # not strictly necessary for the env var itself — but it ensures module-level
    # state (_registry_cache, _state) is clean and that setup() re-defines the
    # resolver closure in the new env context.
    routes_path = (
        Path(__file__).parent.parent / "plugins" / "minigames" / "routes.py"
    )
    spec = importlib.util.spec_from_file_location(
        "minigames_routes_registry_test", routes_path
    )
    routes = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(routes)

    config_dir = tmp_path / "config"
    config_dir.mkdir()
    app = FastAPI()
    routes.setup(app, {"config_dir": str(config_dir)})
    client = TestClient(app, raise_server_exceptions=True)

    try:
        r = client.get("/api/plugins/minigames/registry")
        assert r.status_code == 200
        ids = [g["plugin_id"] for g in r.json()["minigames"]]
        assert "fake-minigame" in ids
    finally:
        client.close()
        sys.modules.pop("minigames_routes_registry_test", None)


def test_registry_deduplicates_by_plugin_id(tmp_path, monkeypatch):
    """Two directories advertising the same plugin_id: only one entry in the
    registry (first-wins / override-takes-precedence)."""
    plugins_dir = tmp_path / "plugins"
    plugins_dir.mkdir()
    for subdir in ("dir-a", "dir-b"):
        d = plugins_dir / subdir
        d.mkdir()
        (d / "plugin.json").write_text(json.dumps({
            "id": "dupe-game",
            "version": "1.0.0",
            "minigame": {"name": subdir},
        }), encoding="utf-8")

    monkeypatch.setenv("FEEDBACK_PLUGINS_DIR", str(plugins_dir))

    routes_path = (
        Path(__file__).parent.parent / "plugins" / "minigames" / "routes.py"
    )
    spec = importlib.util.spec_from_file_location(
        "minigames_routes_dedup_test", routes_path
    )
    routes = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(routes)

    config_dir = tmp_path / "config"
    config_dir.mkdir()
    app = FastAPI()
    routes.setup(app, {"config_dir": str(config_dir)})
    client = TestClient(app, raise_server_exceptions=True)

    try:
        r = client.get("/api/plugins/minigames/registry")
        assert r.status_code == 200
        games = r.json()["minigames"]
        ids = [g["plugin_id"] for g in games]
        assert ids.count("dupe-game") == 1
        # First-wins: resolver sorts children alphabetically so "dir-a" < "dir-b";
        # the surviving entry should carry the "dir-a" name.
        survivor = next(g for g in games if g["plugin_id"] == "dupe-game")
        assert survivor["name"] == "dir-a"
    finally:
        client.close()
        sys.modules.pop("minigames_routes_dedup_test", None)


# ── WAL mode ─────────────────────────────────────────────────────────────────

def test_db_uses_wal_journal_mode(setup_routes):
    """Verify that the SQLite connection is opened in WAL mode."""
    _, routes = setup_routes
    conn = routes._get_conn()
    try:
        row = conn.execute("PRAGMA journal_mode").fetchone()
        assert row[0] == "wal"
    finally:
        conn.close()


# ── Progression hook (spec 010) ───────────────────────────────────────────────

def test_submit_run_reports_progression_event(tmp_path):
    """When core provides record_progression_event, a submitted run reports a
    minigame_run event and the summary rides along in the response."""
    routes_path = (
        Path(__file__).parent.parent / "plugins" / "minigames" / "routes.py"
    )
    spec = importlib.util.spec_from_file_location(
        "minigames_routes_progression_test", routes_path
    )
    routes = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(routes)

    events = []

    def _record(event_type, payload=None):
        events.append((event_type, payload))
        return {"challenges_completed": [], "quests_completed": [],
                "level_ups": [], "calibration_completed": False, "mastery_rank": 0}

    app = FastAPI()
    routes.setup(app, {"config_dir": str(tmp_path),
                       "record_progression_event": _record})
    client = TestClient(app, raise_server_exceptions=True)
    try:
        r = _submit(client, game_id="chord-sprint", score=250)
        assert r.status_code == 200
        assert events == [("minigame_run", {"game_id": "chord-sprint", "score": 250})]
        assert r.json()["progression"]["mastery_rank"] == 0
    finally:
        client.close()
        sys.modules.pop("minigames_routes_progression_test", None)


def test_submit_run_progression_failure_does_not_break_submission(tmp_path):
    """A raising progression hook must not fail the run submission."""
    routes_path = (
        Path(__file__).parent.parent / "plugins" / "minigames" / "routes.py"
    )
    spec = importlib.util.spec_from_file_location(
        "minigames_routes_progression_fail_test", routes_path
    )
    routes = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(routes)

    def _boom(event_type, payload=None):
        raise RuntimeError("engine exploded")

    app = FastAPI()
    routes.setup(app, {"config_dir": str(tmp_path),
                       "record_progression_event": _boom})
    client = TestClient(app, raise_server_exceptions=True)
    try:
        r = _submit(client, score=250)
        assert r.status_code == 200
        assert r.json()["ok"] is True
        assert r.json()["progression"] is None
    finally:
        client.close()
        sys.modules.pop("minigames_routes_progression_fail_test", None)


def test_submit_run_without_progression_hook_is_silent(setup_routes):
    """Standalone mode (no core hook): response carries progression: null."""
    client, _ = setup_routes
    r = _submit(client, score=100)
    assert r.status_code == 200
    assert r.json()["progression"] is None
