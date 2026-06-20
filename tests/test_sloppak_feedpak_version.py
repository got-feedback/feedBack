"""feedpak_version (spec §4): read on load + opportunistic stamp on a metadata
write. Core has no create-from-scratch path (RS-free repo); the editor plugin's
create-mode save stamping the version is a separate follow-up."""

from __future__ import annotations

import json
from pathlib import Path

import yaml

import sloppak as sloppak_mod
from sloppak import FEEDPAK_VERSION
from songmeta import write_sloppak_metadata


def _write_dir_sloppak(root: Path, manifest_extras: dict) -> Path:
    pak = root / f"{root.name}.sloppak"
    pak.mkdir()
    arr_dir = pak / "arrangements"
    arr_dir.mkdir()
    (arr_dir / "lead.json").write_text(json.dumps({
        "name": "Lead", "tuning": [0, 0, 0, 0, 0, 0], "capo": 0,
        "notes": [], "chords": [], "anchors": [], "handshapes": [],
        "templates": [], "beats": [], "sections": [],
    }))
    manifest = {
        "title": "Test", "artist": "Tester", "album": "", "year": 2026,
        "duration": 10.0,
        "arrangements": [{"id": "lead", "name": "Lead", "file": "arrangements/lead.json"}],
        "stems": [{"id": "full", "file": "stems/full.ogg", "default": True}],
    }
    manifest.update(manifest_extras)
    (pak / "manifest.yaml").write_text(yaml.safe_dump(manifest, sort_keys=False))
    return pak


def _load(pak: Path, tmp_path: Path):
    cache = tmp_path / "cache"
    cache.mkdir()
    return sloppak_mod.load_song(pak.name, pak.parent, cache)


def _manifest(pak: Path) -> dict:
    return yaml.safe_load((pak / "manifest.yaml").read_text(encoding="utf-8"))


# ── read ─────────────────────────────────────────────────────────────────────

def test_feedpak_version_read_from_manifest(tmp_path: Path):
    pak = _write_dir_sloppak(tmp_path, {"feedpak_version": "1.2.0"})
    assert _load(pak, tmp_path).feedpak_version == "1.2.0"


def test_feedpak_version_none_when_absent(tmp_path: Path):
    pak = _write_dir_sloppak(tmp_path, {})
    assert _load(pak, tmp_path).feedpak_version is None


def test_feedpak_version_none_when_not_a_string(tmp_path: Path):
    pak = _write_dir_sloppak(tmp_path, {"feedpak_version": 12})
    assert _load(pak, tmp_path).feedpak_version is None


# ── opportunistic stamp on a metadata write ──────────────────────────────────

def test_metadata_write_stamps_version_when_absent(tmp_path: Path):
    pak = _write_dir_sloppak(tmp_path, {})
    assert "feedpak_version" not in _manifest(pak)
    assert write_sloppak_metadata(pak, {"title": "New"}) is True
    m = _manifest(pak)
    assert m["title"] == "New"
    assert m["feedpak_version"] == FEEDPAK_VERSION


def test_metadata_write_preserves_existing_version(tmp_path: Path):
    pak = _write_dir_sloppak(tmp_path, {"feedpak_version": "9.9.9"})
    write_sloppak_metadata(pak, {"artist": "X"})
    assert _manifest(pak)["feedpak_version"] == "9.9.9"  # not downgraded


def test_metadata_no_change_does_not_add_version(tmp_path: Path):
    # A no-op metadata write must NOT stamp a version (no rewrite happens).
    pak = _write_dir_sloppak(tmp_path, {})
    assert write_sloppak_metadata(pak, {}) is False
    assert "feedpak_version" not in _manifest(pak)
