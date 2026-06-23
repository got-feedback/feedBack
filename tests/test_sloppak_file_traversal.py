"""Endpoint tests for path-traversal rejection on the sloppak file route.

`GET /api/sloppak/{filename:path}/file/{rel_path:path}` serves files from
inside a sloppak bundle. Both params are attacker-controlled `:path`
segments, so the handler must (1) contain `filename` under DLC_DIR,
(2) only serve actual `.sloppak` bundles, and (3) contain `rel_path`
inside the resolved sloppak. These tests pin that contract so future
refactors of `resolve_source_dir`/routing can't reintroduce the
arbitrary-file-read class of bug (feedBack#638).
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
    # The sloppak source-dir cache is module-level and survives the
    # server re-import; clear it so a prior test's filename key can't
    # shadow this test's temp DLC_DIR.
    server.sloppak_mod._source_cache.clear()
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


def _make_sloppak(dlc, name="song.sloppak"):
    """Create a minimal directory-form sloppak with one served file."""
    pak = dlc / name
    (pak / "stems").mkdir(parents=True)
    (pak / "stems" / "full.ogg").write_bytes(b"OggS-fake")
    return pak


def test_filename_dotdot_traversal_is_403(dlc_client):
    tc, _server, _dlc = dlc_client
    # `filename` escapes DLC_DIR — must 403 before any filesystem read,
    # never serve /etc/passwd (the original report).
    r = tc.get("/api/sloppak/..%2F..%2F..%2F..%2Fetc/file/passwd")
    assert r.status_code == 403, r.text


def test_rel_path_dotdot_traversal_is_403(dlc_client):
    """A real sloppak is present, but `rel_path` escapes it — 403."""
    tc, _server, dlc = dlc_client
    _make_sloppak(dlc)
    # Drop a secret as a sibling of the sloppak inside DLC_DIR.
    (dlc / "secret.txt").write_text("top secret")
    r = tc.get("/api/sloppak/song.sloppak/file/..%2Fsecret.txt")
    assert r.status_code == 403, r.text


def test_contained_non_sloppak_is_404(dlc_client):
    """A contained-but-non-sloppak `filename` (plain dir) must not turn
    the endpoint into read-any-file-under-DLC_DIR — the is_sloppak gate
    rejects it with 404."""
    tc, _server, dlc = dlc_client
    plain = dlc / "Artist"
    plain.mkdir()
    (plain / "notes.txt").write_text("not a sloppak")
    r = tc.get("/api/sloppak/Artist/file/notes.txt")
    assert r.status_code == 404, r.text


def test_dot_filename_is_404(dlc_client):
    """`filename=.` resolves to DLC_DIR itself; the is_sloppak gate
    blocks it rather than serving arbitrary DLC files."""
    tc, _server, dlc = dlc_client
    (dlc / "config.json").write_text("{}")
    r = tc.get("/api/sloppak/./file/config.json")
    assert r.status_code == 404, r.text


def test_missing_sloppak_is_404(dlc_client):
    """A safe-but-missing sloppak path produces 404, not 403 — guards
    against over-rejecting legitimate filenames."""
    tc, _server, _dlc = dlc_client
    r = tc.get("/api/sloppak/missing.sloppak/file/stems/full.ogg")
    assert r.status_code == 404, r.text


def test_legitimate_file_is_served(dlc_client):
    """A real file inside a real sloppak serves with 200 + bytes."""
    tc, _server, dlc = dlc_client
    _make_sloppak(dlc)
    r = tc.get("/api/sloppak/song.sloppak/file/stems/full.ogg")
    assert r.status_code == 200, r.text
    assert r.content == b"OggS-fake"
