"""Data-minimization contract + opt-in gating (binding).

The outbound wall payload must be EXACTLY {display_name, player_hash,
achievement_id, unlocked_at}; competency unlocks must never enqueue; and nothing
enqueues unless the user opted in AND has a profile identity.
"""

import json
import sqlite3
from pathlib import Path

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

import engine
import routes as ach_routes


class _FakeMetaDB:
    def __init__(self, name="Ada", phash="deadbeefcafe"):
        self._p = {"display_name": name, "player_hash": phash}

    def get_profile(self):
        return dict(self._p)


def _make_client(tmp_path, *, opted_in, meta_db=None):
    if opted_in:
        (tmp_path / "config.json").write_text(json.dumps({"achievements_enabled": True}))
    app = FastAPI()
    ach_routes.setup(app, {"config_dir": str(tmp_path), "meta_db": meta_db})
    return TestClient(app)


def _queue_rows(tmp_path):
    db = sqlite3.connect(str(tmp_path / "achievements" / "achievements.db"))
    try:
        return [
            {"kind": k, "payload": p, "state": s}
            for (k, p, s) in db.execute("SELECT kind, payload, state FROM sync_queue")
        ]
    finally:
        db.close()


# ── The pure serializer is the only gate ─────────────────────────────────────

def test_serializer_keyset_is_exactly_four():
    payload = engine.build_wall_payload("Ada", "hash", "notes_total", "2026-06-24T00:00:00Z")
    assert set(payload.keys()) == set(engine.WALL_PAYLOAD_KEYS)
    assert len(payload) == 4  # go red if a fifth field is ever added


# ── End-to-end enqueue gating ────────────────────────────────────────────────

def test_opted_out_never_enqueues(tmp_path):
    client = _make_client(tmp_path, opted_in=False, meta_db=_FakeMetaDB())
    res = client.post("/api/plugins/achievements/activity", json={"notes": 100000}).json()
    assert "notes_total" in [u["id"] for u in res["unlocked"]]  # feat did unlock
    assert _queue_rows(tmp_path) == []                          # but nothing queued


def test_opted_in_enqueues_exactly_one_four_field_payload(tmp_path):
    client = _make_client(tmp_path, opted_in=True, meta_db=_FakeMetaDB())
    client.post("/api/plugins/achievements/activity", json={"notes": 100000})
    rows = [r for r in _queue_rows(tmp_path) if r["kind"] == "unlock"]
    assert len(rows) == 1
    payload = json.loads(rows[0]["payload"])
    assert set(payload.keys()) == set(engine.WALL_PAYLOAD_KEYS)
    assert payload["achievement_id"] == "notes_total"
    assert payload["display_name"] == "Ada"


def test_opted_in_without_identity_does_not_enqueue(tmp_path):
    client = _make_client(tmp_path, opted_in=True, meta_db=None)
    client.post("/api/plugins/achievements/activity", json={"notes": 100000})
    assert [r for r in _queue_rows(tmp_path) if r["kind"] == "unlock"] == []


def test_competency_never_enqueues_even_opted_in(tmp_path):
    client = _make_client(tmp_path, opted_in=True, meta_db=_FakeMetaDB())
    client.post("/api/plugins/achievements/report-unlock", json={
        "id": "ascendant", "kind": "achievement", "category": "global", "tier": 1})
    assert [r for r in _queue_rows(tmp_path) if r["kind"] == "unlock"] == []
