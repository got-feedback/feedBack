"""End-to-end test for the sloppak loader recognising a `keys:` manifest key
(keys.json — the song-level, instrument-independent key/scale track, spec §7.7)
and surfacing the sanitized payload on the LoadedSloppak."""

from __future__ import annotations

import json
from pathlib import Path

import yaml

import sloppak as sloppak_mod


def _write_dir_sloppak(root: Path, manifest_extras: dict, keys_payload) -> Path:
    """Minimal directory-form sloppak; writes keys.json when a payload is given.

    Unique filename per test (tmp_path leaf) so the module-level
    resolve_source_dir cache isn't poisoned across tests."""
    pak = root / f"{root.name}.sloppak"
    pak.mkdir()
    arr_dir = pak / "arrangements"
    arr_dir.mkdir()
    arr = {
        "name": "Lead", "tuning": [0, 0, 0, 0, 0, 0], "capo": 0,
        "notes": [], "chords": [], "anchors": [], "handshapes": [],
        "templates": [], "beats": [], "sections": [],
    }
    (arr_dir / "lead.json").write_text(json.dumps(arr))

    manifest = {
        "title": "Test", "artist": "Tester", "album": "", "year": 2026,
        "duration": 10.0,
        "arrangements": [{"id": "lead", "name": "Lead", "file": "arrangements/lead.json"}],
        "stems": [{"id": "full", "file": "stems/full.ogg", "default": True}],
    }
    manifest.update(manifest_extras)
    (pak / "manifest.yaml").write_text(yaml.safe_dump(manifest, sort_keys=False))

    if keys_payload is not None:
        (pak / "keys.json").write_text(json.dumps(keys_payload))
    return pak


def _load(pak_path: Path, tmp_path: Path):
    dlc_root = pak_path.parent
    cache = tmp_path / "cache"
    cache.mkdir()
    return sloppak_mod.load_song(pak_path.name, dlc_root, cache)


# ── Happy path ───────────────────────────────────────────────────────────────

def test_load_song_attaches_keys_when_manifest_opts_in(tmp_path: Path):
    payload = {
        "version": 1,
        "events": [
            {"t": 0.0, "key": "Em", "scale": "natural_minor"},
            {"t": 2.0, "key": "G", "scale": "major"},
        ],
    }
    pak = _write_dir_sloppak(tmp_path, {"keys": "keys.json"}, payload)
    loaded = _load(pak, tmp_path)
    assert loaded.keys is not None
    assert loaded.keys["version"] == 1
    evs = loaded.keys["events"]
    assert len(evs) == 2
    assert evs[0] == {"t": 0.0, "key": "Em", "scale": "natural_minor"}
    assert evs[1] == {"t": 2.0, "key": "G", "scale": "major"}


# ── Absent / permissive ──────────────────────────────────────────────────────

def test_load_song_keys_absent_when_manifest_silent(tmp_path: Path):
    pak = _write_dir_sloppak(tmp_path, {}, None)
    assert _load(pak, tmp_path).keys is None


def test_load_song_keys_absent_when_file_missing(tmp_path: Path):
    pak = _write_dir_sloppak(tmp_path, {"keys": "nope.json"}, None)
    assert _load(pak, tmp_path).keys is None


def test_load_song_keys_absent_when_invalid_json(tmp_path: Path):
    pak = _write_dir_sloppak(tmp_path, {"keys": "keys.json"}, None)
    (pak / "keys.json").write_text("not json {{{")
    assert _load(pak, tmp_path).keys is None


def test_load_song_keys_ignored_when_events_not_a_list(tmp_path: Path):
    pak = _write_dir_sloppak(tmp_path, {"keys": "keys.json"},
                             {"version": 1, "events": "nope"})
    assert _load(pak, tmp_path).keys is None


# ── Sanitization ─────────────────────────────────────────────────────────────

def test_load_song_keys_sanitizes_and_sorts(tmp_path: Path):
    payload = {
        "version": 1,
        "events": [
            {"t": 2.0, "key": "G"},                       # no scale -> omitted
            {"t": 0.0, "key": "Em", "scale": "major"},    # out of order
            {"t": 1.0},                                   # no key -> dropped
            {"foo": "bar"},                               # not an event -> dropped
            {"t": 3.0, "key": ""},                        # empty key -> dropped
            {"t": "bad", "key": "X"},                     # non-numeric t -> dropped
            "garbage",                                    # non-dict -> dropped
        ],
    }
    pak = _write_dir_sloppak(tmp_path, {"keys": "keys.json"}, payload)
    evs = _load(pak, tmp_path).keys["events"]
    assert evs == [
        {"t": 0.0, "key": "Em", "scale": "major"},
        {"t": 2.0, "key": "G"},  # scale absent, not null
    ]


def test_load_song_keys_nonint_version_does_not_abort_load(tmp_path: Path):
    # json.loads accepts NaN; a float/NaN version must not raise int(NaN) and
    # abort the load of an OPTIONAL side-file — it falls back to version 1.
    payload = {"version": float("nan"), "events": [{"t": 0.0, "key": "C"}]}
    pak = _write_dir_sloppak(tmp_path, {"keys": "keys.json"}, payload)
    loaded = _load(pak, tmp_path)
    assert loaded.keys is not None
    assert loaded.keys["version"] == 1
    assert loaded.keys["events"] == [{"t": 0.0, "key": "C"}]
