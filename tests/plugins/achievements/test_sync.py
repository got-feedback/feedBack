"""Wall-sync drain worker — dead-letter state machine (never drop)."""

import json
import sqlite3

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

import engine
import routes as ach_routes


# ── Pure decision table ──────────────────────────────────────────────────────

@pytest.mark.parametrize("status,expected", [
    (200, "ack"), (201, "ack"),
    (None, "retry"),        # network error
    (429, "retry"),         # backoff
    (500, "retry"), (503, "retry"),  # transient server-side
    (400, "dead"), (404, "dead"), (422, "dead"),  # client 4xx → dead-letter
])
def test_drain_decision(status, expected):
    assert engine.drain_decision(status) == expected


# ── Worker over a seeded queue ───────────────────────────────────────────────

class _FakeMetaDB:
    def get_profile(self):
        return {"display_name": "Ada", "player_hash": "deadbeefcafe"}


@pytest.fixture
def opted_in_client(tmp_path):
    (tmp_path / "config.json").write_text(json.dumps({"achievements_enabled": True}))
    app = FastAPI()
    ach_routes.setup(app, {"config_dir": str(tmp_path), "meta_db": _FakeMetaDB()})
    c = TestClient(app)
    c._tmp = tmp_path
    return c


def _queue(tmp_path):
    db = sqlite3.connect(str(tmp_path / "achievements" / "achievements.db"))
    try:
        return [(i, k, s) for (i, k, s) in db.execute("SELECT id, kind, state FROM sync_queue")]
    finally:
        db.close()


def test_ack_deletes_row(opted_in_client):
    opted_in_client.post("/api/plugins/achievements/activity", json={"notes": 100000})
    assert len(_queue(opted_in_client._tmp)) == 1
    ach_routes._drain_once(post_fn=lambda kind, payload: 200)
    assert _queue(opted_in_client._tmp) == []  # acked → gone


def test_network_error_keeps_pending(opted_in_client):
    opted_in_client.post("/api/plugins/achievements/activity", json={"notes": 100000})
    ach_routes._drain_once(post_fn=lambda kind, payload: None)
    rows = _queue(opted_in_client._tmp)
    assert len(rows) == 1 and rows[0][2] == "pending"  # retained for retry


def test_4xx_dead_letters_but_retains(opted_in_client):
    opted_in_client.post("/api/plugins/achievements/activity", json={"notes": 100000})
    ach_routes._drain_once(post_fn=lambda kind, payload: 400)
    rows = _queue(opted_in_client._tmp)
    assert len(rows) == 1 and rows[0][2] == "dead_letter"  # diagnosable, not dropped


def test_drain_sends_exact_four_field_payload(opted_in_client):
    opted_in_client.post("/api/plugins/achievements/activity", json={"notes": 100000})
    captured = {}

    def fake_post(kind, payload):
        captured["kind"] = kind
        captured["payload"] = payload
        return 200

    ach_routes._drain_once(post_fn=fake_post)
    assert captured["kind"] == "unlock"
    assert set(captured["payload"].keys()) == set(engine.WALL_PAYLOAD_KEYS)
