"""Tests for the v0.3.0 audio/instrument settings fields (P17)."""

import importlib
import json
import sys

import pytest
from fastapi.testclient import TestClient


@pytest.fixture()
def env(tmp_path, monkeypatch, isolate_logging):
    monkeypatch.setenv("CONFIG_DIR", str(tmp_path))
    monkeypatch.setenv("FEEDBACK_SKIP_STARTUP_TASKS", "1")
    sys.modules.pop("server", None)
    srv = importlib.import_module("server")
    try:
        yield srv, tmp_path
    finally:
        conn = getattr(getattr(srv, "meta_db", None), "conn", None)
        if conn is not None:
            getattr(__import__("sys").modules.get("server"), "_join_background_db_threads", lambda: None)()
            conn.close()
        sys.modules.pop("server", None)


def _cfg(tmp_path):
    return json.loads((tmp_path / "config.json").read_text())


def test_instrument_fields_persist(env):
    srv, tmp = env
    c = TestClient(srv.app)
    # "Drop A" is the 5-string bass drop tuning (its low string is B, not E, so
    # "Drop D" is a 4-string tuning — now correctly rejected per-profile).
    r = c.post("/api/settings", json={"instrument": "bass", "string_count": 5,
                                      "tuning": "Drop A", "reference_pitch": 442})
    assert r.status_code == 200
    cfg = _cfg(tmp)
    assert cfg["instrument"] == "bass" and cfg["string_count"] == 5
    assert cfg["tuning"] == "Drop A" and cfg["reference_pitch"] == 442.0
    # Reflected back through GET.
    got = c.get("/api/settings").json()
    assert got["instrument"] == "bass" and got["reference_pitch"] == 442.0


def test_reference_pitch_clamped(env):
    srv, tmp = env
    c = TestClient(srv.app)
    c.post("/api/settings", json={"reference_pitch": 999})
    assert _cfg(tmp)["reference_pitch"] == 450.0
    c.post("/api/settings", json={"reference_pitch": 400})
    assert _cfg(tmp)["reference_pitch"] == 430.0


@pytest.mark.parametrize("body", [
    {"instrument": "drums"},
    {"string_count": 3},
    {"string_count": 9},
    {"reference_pitch": "x"},
    {"string_count": 4.9},   # non-integral must be rejected, not truncated to 4
    {"tuning": ["x"]},
    {"tuning": [99]},
])
def test_invalid_values_rejected(env, body):
    srv, _ = env
    c = TestClient(srv.app)
    r = c.post("/api/settings", json=body)
    assert r.status_code == 200 and "error" in r.json()


def test_reference_pitch_rejects_non_finite(env):
    # NaN/Infinity must be rejected, not silently clamped to 430/450. Sent as a
    # raw body since httpx's json= serializer can't emit non-finite numbers.
    srv, _ = env
    c = TestClient(srv.app)
    for raw in ('{"reference_pitch": NaN}', '{"reference_pitch": Infinity}', '{"reference_pitch": "inf"}'):
        r = c.post("/api/settings", content=raw, headers={"Content-Type": "application/json"})
        assert "error" in r.json(), raw


def test_tuning_accepts_offsets_list(env):
    srv, tmp = env
    c = TestClient(srv.app)
    r = c.post("/api/settings", json={"tuning": [-2, 0, 0, 0, 0, 0]})
    assert r.status_code == 200 and "error" not in r.json()
    assert _cfg(tmp)["tuning"] == [-2, 0, 0, 0, 0, 0]


def test_partial_post_does_not_clobber(env):
    srv, tmp = env
    c = TestClient(srv.app)
    c.post("/api/settings", json={"instrument": "guitar", "string_count": 7})
    c.post("/api/settings", json={"reference_pitch": 441})  # unrelated key
    cfg = _cfg(tmp)
    assert cfg["instrument"] == "guitar" and cfg["string_count"] == 7 and cfg["reference_pitch"] == 441.0
