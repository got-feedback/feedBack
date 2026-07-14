"""The library root must be resolved ONCE, not on every path check.

`Path.resolve()` lstats every component of a path. `_resolve_dlc_path` and
`safe_join` run once per song / art fetch / scanned row, and both used to
re-resolve their root every single call.

Measured on a real 50,944-song library sitting on an NTFS-3G (FUSE) mount:
~23,500 stat/lstat calls per second, re-walking the same three parent
directories, pinning a core of the server. Every stat crosses into userspace on
FUSE, so the constant re-resolution — not the work itself — was the cost.

These tests pin the fix (root resolved once) AND that caching it did not weaken
containment, which is the thing that matters: `safe_join` is the zip-slip guard.
"""

from pathlib import Path

import pytest

from dlc_paths import _resolve_dlc_path
from safepath import resolved_root, safe_join


@pytest.fixture(autouse=True)
def _clear_cache():
    resolved_root.cache_clear()
    yield
    resolved_root.cache_clear()


def test_dlc_root_is_resolved_once_across_many_lookups(tmp_path):
    """The regression: 500 lookups must not mean 500 root resolutions."""
    (tmp_path / "a.feedpak").write_bytes(b"x")

    for i in range(500):
        assert _resolve_dlc_path(tmp_path, f"song{i}.feedpak") is not None

    info = resolved_root.cache_info()
    assert info.misses == 1, (
        f"the library root must be resolved ONCE, not per call "
        f"(got {info.misses} resolutions for 500 lookups)"
    )
    assert info.hits == 499


def test_safe_join_resolves_its_root_once_too(tmp_path):
    for i in range(200):
        assert safe_join(tmp_path, f"asset{i}.png") is not None
    assert resolved_root.cache_info().misses == 1


def test_a_different_root_is_a_different_cache_entry(tmp_path):
    other = tmp_path / "other"
    other.mkdir()
    _resolve_dlc_path(tmp_path, "a.feedpak")
    _resolve_dlc_path(other, "a.feedpak")
    assert resolved_root.cache_info().misses == 2, "switching library dir must re-resolve"


# ── containment must be unchanged (the part that matters) ───────────────────

@pytest.mark.parametrize("evil", [
    "../etc/passwd",
    "..\\etc\\passwd",
    "a/../../etc/passwd",
    "/etc/passwd",
    "C:/Windows/system.ini",
    "",
])
def test_resolve_dlc_path_still_rejects_escapes(tmp_path, evil):
    assert _resolve_dlc_path(tmp_path, evil) is None


@pytest.mark.parametrize("evil", [
    "../outside.txt",
    "..\\outside.txt",
    "a/../../outside.txt",
    "",
])
def test_safe_join_still_rejects_escapes(tmp_path, evil):
    assert safe_join(tmp_path, evil) is None


def test_safe_join_still_follows_symlinks_out(tmp_path):
    """safe_join's candidate resolution is the zip-slip defence and is NOT cached:
    a symlink pointing outside the root must still be refused."""
    outside = tmp_path.parent / "outside_secret"
    outside.mkdir(exist_ok=True)
    (outside / "secret.txt").write_text("x")

    root = tmp_path / "root"
    root.mkdir()
    (root / "escape").symlink_to(outside)

    assert safe_join(root, "escape/secret.txt") is None, (
        "a symlink escaping the root must still be rejected — caching the ROOT "
        "must not disable resolution of the CANDIDATE"
    )


def test_in_library_paths_still_resolve(tmp_path):
    assert _resolve_dlc_path(tmp_path, "sub/song.feedpak") == tmp_path / "sub" / "song.feedpak"
    assert safe_join(tmp_path, "art/cover.png") == (tmp_path / "art" / "cover.png").resolve()
