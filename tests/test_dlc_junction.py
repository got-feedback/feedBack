"""Unit tests for ``server._resolve_dlc_path`` — the DLC-library containment
guard.

It must (1) allow a library mounted through a directory JUNCTION/symlink (the
shared-library-across-installs / desktop-app case that a ``.resolve()``-based
check wrongly rejected, breaking album art + song load), while (2) still
rejecting ``..`` traversal and absolute paths — the only escapes a ``:path``
filename can express. ``safe_join`` stays strict on purpose (zip-slip guard),
so the contrast is pinned here too.
"""

import importlib
import os
import sys

import pytest


@pytest.fixture()
def server(tmp_path, monkeypatch):
    (tmp_path / "cfg").mkdir()
    monkeypatch.setenv("CONFIG_DIR", str(tmp_path / "cfg"))
    monkeypatch.setenv("FEEDBACK_SKIP_STARTUP_TASKS", "1")
    sys.modules.pop("server", None)
    srv = importlib.import_module("server")
    try:
        yield srv
    finally:
        conn = getattr(getattr(srv, "meta_db", None), "conn", None)
        if conn is not None:
            getattr(sys.modules.get("server"), "_join_background_db_threads", lambda: None)()
            conn.close()
        sys.modules.pop("server", None)


def _dlc(tmp_path):
    d = tmp_path / "dlc"
    d.mkdir()
    return d


# ── still-rejected escapes (the security contract) ────────────────────────────

def test_dotdot_traversal_rejected(server, tmp_path):
    dlc = _dlc(tmp_path)
    assert server._resolve_dlc_path(dlc, "../../etc/passwd") is None
    # a Windows-style backslash traversal is normalised + rejected identically
    assert server._resolve_dlc_path(dlc, "..\\..\\secret") is None
    assert server._resolve_dlc_path(dlc, "a/../../b") is None


def test_absolute_path_rejected(server, tmp_path):
    dlc = _dlc(tmp_path)
    assert server._resolve_dlc_path(dlc, "/etc/passwd") is None
    assert server._resolve_dlc_path(dlc, "C:/Windows/system32/x") is None


def test_empty_and_nul_rejected(server, tmp_path):
    dlc = _dlc(tmp_path)
    assert server._resolve_dlc_path(dlc, "") is None
    assert server._resolve_dlc_path(dlc, "a\x00b") is None


# ── allowed: legitimate in-library paths ──────────────────────────────────────

def test_safe_relative_allowed(server, tmp_path):
    dlc = _dlc(tmp_path)
    p = server._resolve_dlc_path(dlc, "CDLC/City Pop/song.feedpak")
    assert p is not None
    assert p.is_relative_to(dlc.resolve())


def test_junction_subfolder_allowed(server, tmp_path):
    """A library mounted through a directory junction/symlink must resolve —
    the case that broke album art for Christian's shared city-pop library."""
    dlc = _dlc(tmp_path)
    real = tmp_path / "real_library"
    real.mkdir()
    (real / "song.feedpak").write_bytes(b"pack")
    link = dlc / "CDLC"
    try:
        os.symlink(real, link, target_is_directory=True)
    except (OSError, NotImplementedError):
        pytest.skip("symlink/junction creation not permitted on this host")

    p = server._resolve_dlc_path(dlc, "CDLC/song.feedpak")
    assert p is not None, "a junctioned library subfolder was wrongly rejected"
    assert p.exists(), "the resolved path should reach the file through the junction"
    # Contrast: safe_join stays strict (it .resolve()s and follows the junction
    # to its real target outside the root), which is correct for its zip-slip
    # callers but is exactly why _resolve_dlc_path can't reuse it here.
    assert server.safe_join(dlc, "CDLC/song.feedpak") is None
