"""Tests for builtin diagnostic sloppak seeding into DLC."""

from __future__ import annotations

import importlib
import os
import sys
import time

import pytest


@pytest.fixture()
def server_mod(tmp_path, monkeypatch, isolate_logging):
    monkeypatch.setenv("CONFIG_DIR", str(tmp_path))
    monkeypatch.delenv("DLC_DIR", raising=False)
    sys.modules.pop("server", None)
    mod = importlib.import_module("server")
    yield mod


def test_seed_creates_builtin_diagnostic_sloppak(tmp_path, server_mod):
    """First seed copies the bundled sloppak into diagnostics-builtin/."""
    dlc = tmp_path / "dlc"
    dlc.mkdir()
    source = server_mod._feedBack_server_root() / server_mod._BUILTIN_DIAGNOSTIC_SOURCES[0][1]
    if not source.is_file():
        pytest.skip(f"source sloppak not present in checkout: {source}")

    server_mod._seed_builtin_diagnostic_sloppaks(dlc)

    dest = dlc / server_mod._BUILTIN_DIAGNOSTIC_SUBDIR / server_mod._BUILTIN_DIAGNOSTIC_SOURCES[0][0]
    assert dest.is_file()
    assert dest.stat().st_size == source.stat().st_size


def test_seed_is_idempotent_when_destination_exists(tmp_path, server_mod):
    """Second seed leaves an up-to-date destination unchanged."""
    dlc = tmp_path / "dlc"
    dlc.mkdir()
    source = server_mod._feedBack_server_root() / server_mod._BUILTIN_DIAGNOSTIC_SOURCES[0][1]
    if not source.is_file():
        pytest.skip(f"source sloppak not present in checkout: {source}")

    server_mod._seed_builtin_diagnostic_sloppaks(dlc)
    dest = dlc / server_mod._BUILTIN_DIAGNOSTIC_SUBDIR / server_mod._BUILTIN_DIAGNOSTIC_SOURCES[0][0]
    first_mtime = dest.stat().st_mtime_ns
    first_size = dest.stat().st_size

    server_mod._seed_builtin_diagnostic_sloppaks(dlc)

    assert dest.stat().st_mtime_ns == first_mtime
    assert dest.stat().st_size == first_size


def test_seed_skips_when_destination_is_newer(tmp_path, server_mod):
    """An existing newer destination is not overwritten."""
    dlc = tmp_path / "dlc"
    dlc.mkdir()
    source = server_mod._feedBack_server_root() / server_mod._BUILTIN_DIAGNOSTIC_SOURCES[0][1]
    if not source.is_file():
        pytest.skip(f"source sloppak not present in checkout: {source}")
    dest_dir = dlc / server_mod._BUILTIN_DIAGNOSTIC_SUBDIR
    dest_dir.mkdir(parents=True)
    dest_name = server_mod._BUILTIN_DIAGNOSTIC_SOURCES[0][0]
    dest = dest_dir / dest_name
    dest.write_bytes(b"user-owned diagnostic copy")
    future = time.time() + 3600
    os.utime(dest, (future, future))

    server_mod._seed_builtin_diagnostic_sloppaks(dlc)

    assert dest.read_bytes() == b"user-owned diagnostic copy"


def test_seed_refuses_to_follow_symlink_destination(tmp_path, server_mod):
    """A symlink at the destination is skipped, not written through."""
    dlc = tmp_path / "dlc"
    dlc.mkdir()
    source = server_mod._feedBack_server_root() / server_mod._BUILTIN_DIAGNOSTIC_SOURCES[0][1]
    if not source.is_file():
        pytest.skip(f"source sloppak not present in checkout: {source}")

    outside = tmp_path / "outside.txt"
    outside.write_bytes(b"do not overwrite me")
    dest_dir = dlc / server_mod._BUILTIN_DIAGNOSTIC_SUBDIR
    dest_dir.mkdir(parents=True)
    dest = dest_dir / server_mod._BUILTIN_DIAGNOSTIC_SOURCES[0][0]
    dest.symlink_to(outside)

    server_mod._seed_builtin_diagnostic_sloppaks(dlc)

    # The symlink target must be untouched and the link left as-is.
    assert outside.read_bytes() == b"do not overwrite me"
    assert dest.is_symlink()


def test_seed_refuses_symlinked_seed_directory(tmp_path, server_mod):
    """A symlinked diagnostics-builtin directory is skipped entirely."""
    dlc = tmp_path / "dlc"
    dlc.mkdir()
    outside_dir = tmp_path / "outside_dir"
    outside_dir.mkdir()
    (dlc / server_mod._BUILTIN_DIAGNOSTIC_SUBDIR).symlink_to(
        outside_dir, target_is_directory=True
    )

    server_mod._seed_builtin_diagnostic_sloppaks(dlc)

    # Nothing was written through the directory symlink into the link target.
    assert list(outside_dir.iterdir()) == []


def test_seed_missing_source_does_not_crash(tmp_path, server_mod, monkeypatch):
    """Missing bundled source logs and returns without raising."""
    dlc = tmp_path / "dlc"
    dlc.mkdir()
    monkeypatch.setattr(
        server_mod,
        "_BUILTIN_DIAGNOSTIC_SOURCES",
        [("missing.sloppak", "docs/diagnostics/does-not-exist.sloppak")],
    )

    server_mod._seed_builtin_diagnostic_sloppaks(dlc)

    assert not (dlc / server_mod._BUILTIN_DIAGNOSTIC_SUBDIR / "missing.sloppak").exists()
