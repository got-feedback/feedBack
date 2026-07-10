"""Tests for instrument->chart arrangement routing in the highway WS.

When no explicit arrangement is requested, the WS picks the arrangement matching
the player's selected instrument (config.json `instrument`) so a bass player gets
the Bass part instead of the default Lead/guitar chart. An explicit arrangement
request always wins.
"""

from __future__ import annotations

import importlib
import json
import sys

import pytest
import yaml
from fastapi.testclient import TestClient


def _arr(notes):
    return {
        "notes": notes,
        "chords": [],
        "anchors": [],
        "handshapes": [],
        "templates": [],
        "beats": [{"time": 0.0, "measure": 1}],
        "sections": [{"name": "intro", "number": 1, "time": 0.0}],
    }


def _write_multi_arr_sloppak(dlc_root):
    """A song with a Lead (guitar) and a Bass arrangement, Lead first (index 0)."""
    pak = dlc_root / "multi.sloppak"
    pak.mkdir()
    (pak / "arrangements").mkdir()
    (pak / "arrangements" / "lead.json").write_text(json.dumps(_arr([])))
    (pak / "arrangements" / "bass.json").write_text(json.dumps(_arr([])))
    manifest = {
        "title": "Multi",
        "artist": "Tester",
        "album": "",
        "year": 2026,
        "duration": 10.0,
        "arrangements": [
            {"id": "lead", "name": "Lead", "file": "arrangements/lead.json"},
            {"id": "bass", "name": "Bass", "file": "arrangements/bass.json"},
        ],
        "stems": [],
    }
    (pak / "manifest.yaml").write_text(yaml.safe_dump(manifest, sort_keys=False))
    return pak


def _write_sloppak(dlc_root, name, arrangements):
    """Write a .sloppak whose arrangements are (id, display-name) pairs, in order."""
    pak = dlc_root / f"{name}.sloppak"
    pak.mkdir()
    (pak / "arrangements").mkdir()
    manifest_arrs = []
    for arr_id, arr_name in arrangements:
        (pak / "arrangements" / f"{arr_id}.json").write_text(json.dumps(_arr([])))
        manifest_arrs.append(
            {"id": arr_id, "name": arr_name, "file": f"arrangements/{arr_id}.json"}
        )
    manifest = {
        "title": name,
        "artist": "Tester",
        "album": "",
        "year": 2026,
        "duration": 10.0,
        "arrangements": manifest_arrs,
        "stems": [],
    }
    (pak / "manifest.yaml").write_text(yaml.safe_dump(manifest, sort_keys=False))
    return pak


@pytest.fixture()
def make_client(tmp_path, monkeypatch):
    def _make(instrument=None, default_arrangement=None):
        cfg = tmp_path / "config"
        cfg.mkdir(exist_ok=True)
        conf = {}
        if instrument is not None:
            conf["instrument"] = instrument
        if default_arrangement is not None:
            conf["default_arrangement"] = default_arrangement
        if conf:
            (cfg / "config.json").write_text(json.dumps(conf), encoding="utf-8")
        monkeypatch.setenv("CONFIG_DIR", str(cfg))
        monkeypatch.setenv("DLC_DIR", str(tmp_path / "dlc"))
        monkeypatch.setenv("FEEDBACK_SYNC_STARTUP", "1")
        sys.modules.pop("server", None)
        server = importlib.import_module("server")
        monkeypatch.setattr(server, "load_plugins", lambda *a, **kw: None)
        monkeypatch.setattr(server, "startup_scan", lambda: None)
        monkeypatch.setattr(server, "SLOPPAK_CACHE_DIR", tmp_path / "cache")
        # ws_highway reads the cache dir through the appstate seam now.
        import appstate as _appstate
        monkeypatch.setattr(_appstate, "sloppak_cache_dir", tmp_path / "cache")
        return server

    (tmp_path / "dlc").mkdir()
    yield _make
    server = sys.modules.get("server")
    conn = getattr(getattr(server, "meta_db", None), "conn", None)
    if conn is not None:
        getattr(__import__("sys").modules.get("server"), "_join_background_db_threads", lambda: None)()
        conn.close()


def _arr_index(client, path):
    with client.websocket_connect(path) as ws:
        for _ in range(200):
            msg = ws.receive_json()
            if msg.get("error"):
                raise AssertionError(f"WS error frame: {msg}")
            if msg.get("type") == "song_info":
                return msg["arrangement_index"]
            if msg.get("type") == "ready":
                break
    raise AssertionError("no song_info frame received")


def test_bass_instrument_routes_to_bass_arrangement(make_client):
    server = make_client(instrument="bass")
    _write_multi_arr_sloppak(server._get_dlc_dir())
    with TestClient(server.app) as client:
        # No explicit arrangement → route to Bass (index 1), not the default Lead.
        idx = _arr_index(client, "/ws/highway/multi.sloppak?naming_mode=smart")
    assert idx == 1


def test_guitar_instrument_keeps_default(make_client):
    server = make_client(instrument="guitar")
    _write_multi_arr_sloppak(server._get_dlc_dir())
    with TestClient(server.app) as client:
        idx = _arr_index(client, "/ws/highway/multi.sloppak?naming_mode=smart")
    assert idx == 0  # guitar falls through to the default → Lead


def test_explicit_arrangement_overrides_instrument(make_client):
    server = make_client(instrument="bass")
    _write_multi_arr_sloppak(server._get_dlc_dir())
    with TestClient(server.app) as client:
        # An explicit arrangement request wins even for a bass player.
        idx = _arr_index(client, "/ws/highway/multi.sloppak?arrangement=0")
    assert idx == 0


def test_bass_with_no_bass_part_falls_through_to_guitar(make_client):
    server = make_client(instrument="bass")
    # Lead + Rhythm, no bass part at all.
    _write_sloppak(server._get_dlc_dir(), "gtr", [("lead", "Lead"), ("rhythm", "Rhythm")])
    with TestClient(server.app) as client:
        idx = _arr_index(client, "/ws/highway/gtr.sloppak")
    assert idx == 0  # no bass candidate → existing default (a guitar part)


def test_bass_no_pref_picks_the_primary_bass_not_an_alt(make_client):
    server = make_client(instrument="bass")
    # Lead + two bass parts; the canonical "Bass" should win over "Bass 2".
    _write_sloppak(
        server._get_dlc_dir(), "bb",
        [("lead", "Lead"), ("bass", "Bass"), ("bass2", "Bass 2")],
    )
    with TestClient(server.app) as client:
        idx = _arr_index(client, "/ws/highway/bb.sloppak")
    assert idx == 1  # the primary Bass, not the first-in-order-if-it-were-an-alt


def test_bass_honors_saved_pref_within_the_bass_parts(make_client):
    # A bass player who saved "Bass 2" keeps it — instrument routing must not clobber
    # the preference with the primary Bass.
    server = make_client(instrument="bass", default_arrangement="Bass 2")
    _write_sloppak(
        server._get_dlc_dir(), "bb",
        [("lead", "Lead"), ("bass", "Bass"), ("bass2", "Bass 2")],
    )
    with TestClient(server.app) as client:
        idx = _arr_index(client, "/ws/highway/bb.sloppak")
    assert idx == 2  # the preferred Bass 2, not the primary Bass (index 1)


def test_guitar_still_honors_saved_pref(make_client):
    # Guitar routing unchanged: a saved default_arrangement still applies.
    server = make_client(instrument="guitar", default_arrangement="Rhythm")
    _write_sloppak(
        server._get_dlc_dir(), "gtr2",
        [("lead", "Lead"), ("rhythm", "Rhythm"), ("bass", "Bass")],
    )
    with TestClient(server.app) as client:
        idx = _arr_index(client, "/ws/highway/gtr2.sloppak")
    assert idx == 1  # Rhythm, per preference
