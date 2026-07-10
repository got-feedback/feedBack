"""Tests for feedpak contributor credits on the highway.

Covers the `_sanitize_authors` helper (unit) and the `song_info` WebSocket
frame carrying the manifest `authors` list end-to-end (integration). The
frontend uses a non-empty `authors` list to gate a credits overlay shown when
a song loads, so loose/archive/synthetic plays must surface `[]`.
"""

from __future__ import annotations

import importlib
import json
import sys

import pytest
import yaml
from fastapi.testclient import TestClient

from routers.ws_highway import _sanitize_authors


# ── _sanitize_authors unit tests ────────────────────────────────────────────


@pytest.fixture()
def server_mod(monkeypatch, tmp_path):
    monkeypatch.setenv("CONFIG_DIR", str(tmp_path / "config"))
    monkeypatch.setenv("DLC_DIR", str(tmp_path / "dlc"))
    (tmp_path / "dlc").mkdir()
    sys.modules.pop("server", None)
    mod = importlib.import_module("server")
    yield mod
    conn = getattr(getattr(mod, "meta_db", None), "conn", None)
    if conn is not None:
        getattr(__import__("sys").modules.get("server"), "_join_background_db_threads", lambda: None)()
        conn.close()


def test_sanitize_authors_valid(server_mod):
    out = _sanitize_authors(
        {
            "authors": [
                {"name": "Azure", "role": "charter", "email": "a@b.c", "url": "x"},
                {"name": "Bob Lee", "role": "editor"},
                {"name": "Solo"},
            ]
        }
    )
    # name + role only; email/url dropped; missing role → None.
    assert out == [
        {"name": "Azure", "role": "charter"},
        {"name": "Bob Lee", "role": "editor"},
        {"name": "Solo", "role": None},
    ]


def test_sanitize_authors_skips_malformed(server_mod):
    out = _sanitize_authors(
        {
            "authors": [
                {"name": ""},          # blank name → skipped
                {"name": "   "},       # whitespace name → skipped
                {"role": "mixer"},     # no name → skipped
                "not-a-dict",          # non-dict → skipped
                {"name": "  Kept  ", "role": "  arranger  "},  # trimmed
            ]
        }
    )
    assert out == [{"name": "Kept", "role": "arranger"}]


@pytest.mark.parametrize("manifest", [None, {}, {"authors": None}, {"authors": "x"}, "nope"])
def test_sanitize_authors_absent_or_nonlist(server_mod, manifest):
    assert _sanitize_authors(manifest) == []


# ── song_info WS integration ────────────────────────────────────────────────


def _write_sloppak(dlc_root, *, authors):
    pak = dlc_root / "authortest.sloppak"
    pak.mkdir()
    (pak / "arrangements").mkdir()
    (pak / "arrangements" / "lead.json").write_text(
        json.dumps(
            {
                "notes": [],
                "chords": [],
                "anchors": [],
                "handshapes": [],
                "templates": [],
                "beats": [{"time": 0.0, "measure": 1}],
                "sections": [{"name": "intro", "number": 1, "time": 0.0}],
            }
        )
    )
    manifest = {
        "title": "Author Test",
        "artist": "Tester",
        "album": "",
        "year": 2026,
        "duration": 10.0,
        "arrangements": [{"id": "lead", "name": "Lead", "file": "arrangements/lead.json"}],
        "stems": [],
    }
    if authors is not None:
        manifest["authors"] = authors
    (pak / "manifest.yaml").write_text(yaml.safe_dump(manifest, sort_keys=False))
    return pak


@pytest.fixture()
def make_client(tmp_path, monkeypatch):
    def _make():
        monkeypatch.setenv("CONFIG_DIR", str(tmp_path / "config"))
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


def _song_info(client, path):
    with client.websocket_connect(path) as ws:
        for _ in range(200):
            msg = ws.receive_json()
            if msg.get("error"):
                raise AssertionError(f"WS error frame: {msg}")
            if msg.get("type") == "song_info":
                return msg
            if msg.get("type") == "ready":
                break
    raise AssertionError("no song_info frame received")


def test_song_info_carries_authors(make_client):
    server = make_client()
    _write_sloppak(
        server._get_dlc_dir(),
        authors=[{"name": "Azure", "role": "charter", "email": "a@b.c"}],
    )
    with TestClient(server.app) as client:
        info = _song_info(client, "/ws/highway/authortest.sloppak?arrangement=0")
    assert info["authors"] == [{"name": "Azure", "role": "charter"}]


def test_song_info_authors_empty_when_absent(make_client):
    server = make_client()
    _write_sloppak(server._get_dlc_dir(), authors=None)
    with TestClient(server.app) as client:
        info = _song_info(client, "/ws/highway/authortest.sloppak?arrangement=0")
    assert info["authors"] == []
