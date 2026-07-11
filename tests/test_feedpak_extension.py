"""Coverage for the `.sloppak → .feedpak` dual-suffix support (PR #553).

The package format is byte-identical regardless of suffix: `.feedpak` is the
current write extension, `.sloppak` the legacy one we still read. These tests
pin the four behaviours the PR widened so a future refactor can't silently drop
back-compat for `.sloppak` libraries or stop accepting the new `.feedpak`:

1. ``sloppak.is_sloppak`` / ``SONG_EXTS`` — suffix detection (unit).
2. ``_background_scan`` discovery glob — finds both suffixes (DLC scan).
3. ``POST /api/songs/upload`` gate — accepts both, rejects others (endpoint).
4. ``save_settings`` DLC count — counts both suffixes (settings handler).
"""

from __future__ import annotations

import importlib
from routers import settings as settings_router
import io
import sys
import zipfile
from pathlib import Path

import pytest
import yaml

import sloppak as sloppak_mod
from sloppak import FEEDPAK_EXT, SLOPPAK_EXT, SONG_EXTS


# ── helpers ──────────────────────────────────────────────────────────────────

def _feedpak_zip_bytes(manifest: dict | None = None) -> bytes:
    """A minimal valid package zip: a `manifest.yaml` that parses to a dict.

    The upload gate verifies more than ZIP magic — it runs
    ``sloppak.load_manifest`` to reject any renamed zip without a parseable
    top-level manifest mapping, so the bytes must contain a real one.
    """
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as zf:
        zf.writestr("manifest.yaml",
                    yaml.safe_dump(manifest or {"title": "T", "artist": "A"}))
    return buf.getvalue()


# ── 1. is_sloppak / SONG_EXTS (unit) ─────────────────────────────────────────

def test_song_exts_are_both_suffixes_lowercase():
    assert FEEDPAK_EXT == ".feedpak"
    assert SLOPPAK_EXT == ".sloppak"
    # `.feedpak` first — it is the write/discovery-preferred extension; both
    # entries must be lowercase because is_sloppak relies on `.lower()` + a
    # tuple-suffix match.
    assert SONG_EXTS == (FEEDPAK_EXT, SLOPPAK_EXT)
    assert all(e == e.lower() for e in SONG_EXTS)


@pytest.mark.parametrize("name", [
    "song.feedpak",          # current write suffix
    "song.sloppak",          # legacy suffix, still read
    "My Song_p.feedpak",     # editor create-mode names land as *_p.feedpak
    "dir-form.feedpak",      # directory-form bundle (suffix-only check)
    "dir-form.sloppak",
    "SONG.FEEDPAK",          # case-insensitive
    "Song.SlopPak",
])
def test_is_sloppak_accepts_both_suffixes(name):
    assert sloppak_mod.is_sloppak(Path("/dlc") / name) is True


@pytest.mark.parametrize("name", [
    "song.zip",              # a renamed zip is not a package by suffix
    "song.txt",
    "song.feedpak.bak",
    "feedpak",               # bare word, no dot-suffix
    "noext",
])
def test_is_sloppak_rejects_other_suffixes(name):
    assert sloppak_mod.is_sloppak(Path("/dlc") / name) is False


# ── 2. _background_scan discovery glob (DLC scan) ────────────────────────────

@pytest.fixture()
def scan_server(tmp_path, monkeypatch, isolate_logging):
    """Fresh server import with the background scan forced in-process.

    Mirrors tests/test_settings_api.py::scan_module — the production scan uses
    a ``spawn`` ProcessPoolExecutor whose workers an in-process mock can't
    reach, so swap in a ThreadPoolExecutor and mock metadata extraction.
    """
    import concurrent.futures
    monkeypatch.setenv("CONFIG_DIR", str(tmp_path))
    monkeypatch.delenv("DLC_DIR", raising=False)
    sys.modules.pop("server", None)
    mod = importlib.import_module("server")
    monkeypatch.setattr(
        mod, "_make_scan_executor",
        lambda: concurrent.futures.ThreadPoolExecutor(max_workers=4),
    )
    yield mod
    conn = getattr(getattr(mod, "meta_db", None), "conn", None)
    if conn is not None:
        getattr(__import__("sys").modules.get("server"), "_join_background_db_threads", lambda: None)()
        conn.close()


def test_background_scan_discovers_both_suffixes(tmp_path, scan_server):
    """The discovery glob unions over SONG_EXTS, so a `.feedpak` and a
    legacy `.sloppak` in the DLC folder are both handed to extraction."""
    import unittest.mock as mock

    dlc = tmp_path / "dlc"
    dlc.mkdir()
    # Empty stubs are enough — is_sloppak keys on suffix and extraction is mocked.
    (dlc / "new.feedpak").write_bytes(b"")
    (dlc / "legacy.sloppak").write_bytes(b"")
    (dlc / "ignore.zip").write_bytes(b"")  # not a package — must be skipped
    (tmp_path / "config.json").write_text('{"dlc_dir": "%s"}' % dlc)

    seen: list[str] = []

    def mock_extract(f, dlc_dir):
        seen.append(f.name)
        return {"title": f.name, "artist": "", "album": ""}

    with mock.patch("scan_worker._extract_meta_for_file", new=mock_extract):
        scan_server._background_scan()

    assert "new.feedpak" in seen
    assert "legacy.sloppak" in seen
    assert "ignore.zip" not in seen


# ── 3. POST /api/songs/upload gate (endpoint) ────────────────────────────────

@pytest.fixture()
def upload_client(tmp_path, monkeypatch):
    """A TestClient with a temp DLC_DIR and startup side-effects stubbed.

    No lifespan is run (the client is not used as a context manager), so the
    background scan / plugin load never fire; the upload handler only needs
    ``_get_dlc_dir`` to resolve, which it does from the DLC_DIR env var.
    """
    from fastapi.testclient import TestClient

    dlc = tmp_path / "dlc"
    dlc.mkdir()
    config = tmp_path / "cfg"
    config.mkdir()
    monkeypatch.setenv("DLC_DIR", str(dlc))
    monkeypatch.setenv("CONFIG_DIR", str(config))
    monkeypatch.setenv("FEEDBACK_SYNC_STARTUP", "1")
    sys.modules.pop("server", None)
    server = importlib.import_module("server")
    server.sloppak_mod._source_cache.clear()
    monkeypatch.setattr(server, "load_plugins", lambda *a, **kw: None)
    monkeypatch.setattr(server, "startup_scan", lambda: None)
    tc = TestClient(server.app, client=("127.0.0.1", 50000))
    try:
        yield tc, dlc
    finally:
        tc.close()
        conn = getattr(getattr(server, "meta_db", None), "conn", None)
        if conn is not None:
            getattr(__import__("sys").modules.get("server"), "_join_background_db_threads", lambda: None)()
            conn.close()


def _upload(tc, name, data):
    return tc.post("/api/songs/upload",
                   files={"file": (name, data, "application/octet-stream")})


def test_upload_accepts_feedpak(upload_client):
    tc, dlc = upload_client
    r = _upload(tc, "new_p.feedpak", _feedpak_zip_bytes())
    assert r.status_code == 200, r.text
    result = r.json()["results"][0]
    assert result["status"] == "ok", result
    assert (dlc / "new_p.feedpak").exists()


def test_upload_still_accepts_legacy_sloppak(upload_client):
    """Back-compat: a `.sloppak` upload keeps working."""
    tc, dlc = upload_client
    r = _upload(tc, "legacy.sloppak", _feedpak_zip_bytes())
    assert r.status_code == 200, r.text
    assert r.json()["results"][0]["status"] == "ok"
    assert (dlc / "legacy.sloppak").exists()


def test_upload_rejects_wrong_suffix(upload_client):
    """A valid zip under a non-package suffix is rejected at the ext gate."""
    tc, dlc = upload_client
    r = _upload(tc, "song.zip", _feedpak_zip_bytes())
    assert r.status_code == 200, r.text
    result = r.json()["results"][0]
    assert result["status"] == "error"
    assert "feedpak" in result["error"].lower()
    assert not (dlc / "song.zip").exists()


def test_upload_rejects_feedpak_that_is_not_a_zip(upload_client):
    """A `.feedpak` whose bytes aren't a ZIP archive fails the magic check
    with the suffix-appropriate message."""
    tc, dlc = upload_client
    r = _upload(tc, "bogus.feedpak", b"this is not a zip archive")
    assert r.status_code == 200, r.text
    result = r.json()["results"][0]
    assert result["status"] == "error"
    assert "feedpak" in result["error"].lower()
    assert not (dlc / "bogus.feedpak").exists()


# ── 4. save_settings DLC count (settings handler) ────────────────────────────

@pytest.fixture()
def settings_server(tmp_path, monkeypatch):
    """Fresh server import with an isolated CONFIG_DIR, startup tasks skipped.

    save_settings is driven directly — it takes the DLC path in its payload, so
    no DLC_DIR env or HTTP layer is needed.
    """
    monkeypatch.setenv("CONFIG_DIR", str(tmp_path))
    monkeypatch.setenv("FEEDBACK_SKIP_STARTUP_TASKS", "1")
    sys.modules.pop("server", None)
    server = importlib.import_module("server")
    try:
        yield server
    finally:
        conn = getattr(getattr(server, "meta_db", None), "conn", None)
        if conn is not None:
            getattr(__import__("sys").modules.get("server"), "_join_background_db_threads", lambda: None)()
            conn.close()


def test_settings_dlc_count_includes_both_suffixes(tmp_path, settings_server):
    dlc = tmp_path / "dlc"
    dlc.mkdir()
    (dlc / "a.feedpak").write_bytes(b"")
    (dlc / "b.sloppak").write_bytes(b"")
    (dlc / "c.FEEDPAK").write_bytes(b"")   # case-insensitive (suffix.lower())
    (dlc / "notes.txt").write_bytes(b"")   # ignored

    result = settings_router.save_settings({"dlc_dir": str(dlc)})

    assert "error" not in result, result
    # save_settings joins its notices into a single ``message`` string.
    assert "3 song files" in result.get("message", ""), result
