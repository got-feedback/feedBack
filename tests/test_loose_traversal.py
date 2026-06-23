"""Endpoint tests for path-traversal rejection on filename-bound routes.

`_resolve_dlc_path` is a security-critical helper: every `:path` filename
route must reject inputs that resolve outside DLC_DIR. These tests pin
that contract for `/api/song/{filename}` and `/api/song/{filename}/art`.
"""

import importlib
import sys

import pytest
from fastapi.testclient import TestClient


@pytest.fixture()
def dlc_client(tmp_path, monkeypatch):
    """Spin up a TestClient with a temp DLC_DIR; sync startup, no scan."""
    dlc = tmp_path / "dlc"
    dlc.mkdir()
    config = tmp_path / "cfg"
    config.mkdir()
    monkeypatch.setenv("DLC_DIR", str(dlc))
    monkeypatch.setenv("CONFIG_DIR", str(config))
    monkeypatch.setenv("FEEDBACK_SYNC_STARTUP", "1")
    sys.modules.pop("server", None)
    server = importlib.import_module("server")
    monkeypatch.setattr(server, "load_plugins", lambda *a, **kw: None)
    monkeypatch.setattr(server, "startup_scan", lambda: None)
    static_tmp = tmp_path / "static"
    static_tmp.mkdir()
    monkeypatch.setattr(server, "STATIC_DIR", static_tmp)
    tc = TestClient(server.app, client=("127.0.0.1", 50000))
    try:
        yield tc, server, dlc
    finally:
        tc.close()
        meta_db = getattr(server, "meta_db", None)
        conn = getattr(meta_db, "conn", None)
        if conn is not None:
            conn.close()


def test_get_song_info_rejects_dotdot_traversal(dlc_client):
    tc, _server, _dlc = dlc_client
    # `..` segments resolve above DLC_DIR — must 403, never 200/404 from
    # an accidental stat() outside the tree.
    r = tc.get("/api/song/..%2F..%2Fetc%2Fpasswd")
    assert r.status_code == 403, r.text


def test_get_song_art_rejects_dotdot_traversal(dlc_client):
    tc, _server, _dlc = dlc_client
    r = tc.get("/api/song/..%2F..%2Fetc%2Fpasswd/art")
    assert r.status_code == 403, r.text


def test_get_song_info_inside_dlc_is_404_not_403(dlc_client):
    """A safe-but-missing path produces 404, not 403 — guards against
    over-rejecting legitimate filenames."""
    tc, _server, _dlc = dlc_client
    r = tc.get("/api/song/some-song.archive")
    assert r.status_code == 404, r.text
