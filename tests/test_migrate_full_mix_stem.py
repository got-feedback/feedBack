"""tools/migrate_full_mix_stem.py — packs off the deprecated `original_audio:` key.

The migration moves real audio inside tens of thousands of archives, so the
interesting cases are the ones where it must NOT act: a pack it would corrupt, a
pack it has already done, a pack whose mixdown isn't where the key claims.
"""

from __future__ import annotations

import importlib.util
import zipfile
from pathlib import Path

import pytest
import yaml

_SPEC = importlib.util.spec_from_file_location(
    "migrate_full_mix_stem",
    Path(__file__).resolve().parent.parent / "tools" / "migrate_full_mix_stem.py",
)
mig = importlib.util.module_from_spec(_SPEC)
_SPEC.loader.exec_module(mig)


def _manifest(**extra) -> dict:
    m = {
        "feedpak_version": "1.13.0",
        "title": "T",
        "artist": "A",
        "duration": 1.0,
        "arrangements": [{"id": "lead", "file": "arrangements/lead.json"}],
        "stems": [
            {"id": "guitar", "file": "stems/guitar.ogg", "default": "on"},
            {"id": "drums", "file": "stems/drums.ogg", "default": "on"},
        ],
        "original_audio": "original/full.ogg",
    }
    m.update(extra)
    return m


def _write_pack(path: Path, manifest: dict, files: dict[str, bytes] | None = None) -> Path:
    files = files or {
        "original/full.ogg": b"MIXDOWN",
        "stems/guitar.ogg": b"g",
        "stems/drums.ogg": b"d",
        "arrangements/lead.json": b"{}",
    }
    with zipfile.ZipFile(path, "w", zipfile.ZIP_DEFLATED) as zf:
        zf.writestr("manifest.yaml", yaml.safe_dump(manifest, sort_keys=False))
        for name, data in files.items():
            zf.writestr(name, data)
    return path


def _read(path: Path) -> tuple[dict, set[str]]:
    with zipfile.ZipFile(path) as zf:
        return yaml.safe_load(zf.read("manifest.yaml")), set(zf.namelist())


# ── plan_manifest: the decisions, without the archives ──────────────────────

def test_plan_adds_the_full_stem_and_drops_the_key():
    new, move = mig.plan_manifest(_manifest())
    assert move == "original/full.ogg"
    assert "original_audio" not in new
    assert new["stems"][0] == {
        "id": "full",
        "file": "stems/full.ogg",
        "default": "off",
    }
    # The separated stems survive, in order, untouched.
    assert [s["id"] for s in new["stems"]] == ["full", "guitar", "drums"]
    assert new["feedpak_version"] == "1.15.0"


def test_plan_marks_the_retained_mixdown_default_off():
    """The one line that keeps a pre-1.15.0 reader from doubling the song: a
    reader that sums every stem still won't play `full` on open if it honours
    `default`, which has been normative since 1.0.0."""
    new, _ = mig.plan_manifest(_manifest())
    assert new["stems"][0]["default"] == "off"


def test_plan_marks_a_sole_mixdown_default_on():
    """With no separated stems the mixdown IS the audio — off would mute the pack."""
    new, _ = mig.plan_manifest(_manifest(stems=[]))
    assert new["stems"] == [{"id": "full", "file": "stems/full.ogg", "default": "on"}]


def test_plan_preserves_unknown_keys_verbatim():
    """Spec §3: a writer that re-emits a pack SHOULD preserve unknown keys."""
    new, _ = mig.plan_manifest(_manifest(source_tool="ExampleTool v1.2.3", rigs="rigs.json"))
    assert new["source_tool"] == "ExampleTool v1.2.3"
    assert new["rigs"] == "rigs.json"


def test_plan_skips_an_already_migrated_pack():
    m = _manifest(
        stems=[{"id": "full", "file": "stems/full.ogg", "default": "off"}],
    )
    del m["original_audio"]
    with pytest.raises(mig.Skip):
        mig.plan_manifest(m)


def test_plan_skips_a_pack_that_never_had_the_key():
    m = _manifest()
    del m["original_audio"]
    with pytest.raises(mig.Skip):
        mig.plan_manifest(m)


def test_plan_drops_a_stale_key_without_moving_anything():
    """Mixdown already a stem, dead key lingering beside it."""
    new, move = mig.plan_manifest(
        _manifest(stems=[{"id": "full", "file": "stems/full.ogg", "default": "off"}])
    )
    assert move == ""
    assert "original_audio" not in new
    assert [s["id"] for s in new["stems"]] == ["full"]


def test_plan_forces_an_existing_full_stem_off_beside_instrument_stems():
    """Dropping the stale key is not enough if the mixdown it duplicated is left
    ENABLED: a reader that honours `default` would then play the whole song on top
    of the stems on open. The migration must not hand back a pack in the exact
    state it exists to remove."""
    new, move = mig.plan_manifest(
        _manifest(
            stems=[
                {"id": "full", "file": "stems/full.ogg", "default": "on"},
                {"id": "guitar", "file": "stems/guitar.ogg", "default": "on"},
            ]
        )
    )
    assert move == ""
    assert new["stems"][0] == {"id": "full", "file": "stems/full.ogg", "default": "off"}
    assert new["stems"][1]["default"] == "on"  # instruments untouched


def test_plan_leaves_a_sole_full_stem_enabled_when_dropping_a_stale_key():
    """No instruments beside it — the mixdown IS the audio. Forcing it off here
    would mute the pack."""
    new, _ = mig.plan_manifest(
        _manifest(stems=[{"id": "full", "file": "stems/full.ogg", "default": "on"}])
    )
    assert new["stems"] == [{"id": "full", "file": "stems/full.ogg", "default": "on"}]


def test_plan_needs_no_move_when_the_key_already_points_at_the_canonical_path():
    new, move = mig.plan_manifest(_manifest(original_audio="stems/full.ogg"))
    assert move == ""
    assert new["stems"][0]["file"] == "stems/full.ogg"


# ── migrate_zip: the archive rewrite ────────────────────────────────────────

def test_migrate_moves_the_audio_and_rewrites_the_manifest(tmp_path: Path):
    pak = _write_pack(tmp_path / "song.feedpak", _manifest())
    assert mig.migrate_zip(pak, dry_run=False) == "migrated"

    manifest, names = _read(pak)
    assert "original/full.ogg" not in names       # the invented directory is gone
    assert "stems/full.ogg" in names              # audio lives where the format says
    assert "original_audio" not in manifest
    assert manifest["stems"][0]["id"] == "full"
    assert mig.verify_zip(pak) == "ok"


def test_migrate_preserves_the_mixdown_bytes(tmp_path: Path):
    """It is a rename, not a re-encode. Losing a byte here loses the master audio."""
    pak = _write_pack(tmp_path / "song.feedpak", _manifest())
    mig.migrate_zip(pak, dry_run=False)
    with zipfile.ZipFile(pak) as zf:
        assert zf.read("stems/full.ogg") == b"MIXDOWN"
        assert zf.read("stems/guitar.ogg") == b"g"


def test_migrate_is_idempotent(tmp_path: Path):
    pak = _write_pack(tmp_path / "song.feedpak", _manifest())
    assert mig.migrate_zip(pak, dry_run=False) == "migrated"
    before = pak.read_bytes()
    assert mig.migrate_zip(pak, dry_run=False) == "skip"
    assert pak.read_bytes() == before  # a re-run touches nothing


def test_dry_run_changes_nothing(tmp_path: Path):
    pak = _write_pack(tmp_path / "song.feedpak", _manifest())
    before = pak.read_bytes()
    assert mig.migrate_zip(pak, dry_run=True) == "would-migrate"
    assert pak.read_bytes() == before


def test_migrate_refuses_when_the_mixdown_is_absent(tmp_path: Path):
    """The key points at audio the archive doesn't contain. Fabricating a stem
    entry for a missing file would break every reader — refuse, don't guess."""
    pak = _write_pack(
        tmp_path / "song.feedpak",
        _manifest(),
        files={"stems/guitar.ogg": b"g", "arrangements/lead.json": b"{}"},
    )
    before = pak.read_bytes()
    assert mig.migrate_zip(pak, dry_run=False) == "missing-audio"
    assert pak.read_bytes() == before


def test_migrate_refuses_when_the_target_path_is_taken(tmp_path: Path):
    """A `stems/full.ogg` that is NOT the mixdown already occupies the target.
    Overwriting it would destroy a stem."""
    pak = _write_pack(
        tmp_path / "song.feedpak",
        _manifest(),
        files={
            "original/full.ogg": b"MIXDOWN",
            "stems/full.ogg": b"SOMETHING-ELSE",
            "arrangements/lead.json": b"{}",
        },
    )
    assert mig.migrate_zip(pak, dry_run=False) == "target-occupied"
    with zipfile.ZipFile(pak) as zf:
        assert zf.read("stems/full.ogg") == b"SOMETHING-ELSE"


def test_migrate_drops_a_stale_key_beside_a_non_canonical_full_stem(tmp_path: Path):
    """The mixdown is already a stem, but at a path of the pack's own choosing —
    which is legal (§2.2: readers resolve through the manifest, never by
    filename). Only the dead key needs removing. Demanding `stems/full.ogg` here
    would reject a perfectly valid pack as `missing-audio`."""
    m = _manifest(stems=[{"id": "full", "file": "audio/mixdown.ogg", "default": "off"}])
    pak = _write_pack(
        tmp_path / "song.feedpak",
        m,
        files={"audio/mixdown.ogg": b"MIXDOWN", "arrangements/lead.json": b"{}"},
    )
    assert mig.migrate_zip(pak, dry_run=False) == "migrated"

    manifest, names = _read(pak)
    assert "original_audio" not in manifest
    assert manifest["stems"] == [
        {"id": "full", "file": "audio/mixdown.ogg", "default": "off"}
    ]
    assert "audio/mixdown.ogg" in names  # the audio never moved
    assert mig.verify_zip(pak) == "ok"


# ── verify_zip ──────────────────────────────────────────────────────────────

def test_verify_rejects_a_retained_mixdown_that_plays_on_open(tmp_path: Path):
    """The hazard the migration must never create: `full` alongside instrument
    stems AND default-on means a summing reader plays the whole song twice."""
    m = _manifest(
        stems=[
            {"id": "full", "file": "stems/full.ogg", "default": "on"},
            {"id": "guitar", "file": "stems/guitar.ogg", "default": "on"},
        ]
    )
    del m["original_audio"]
    pak = _write_pack(
        tmp_path / "song.feedpak",
        m,
        files={"stems/full.ogg": b"M", "stems/guitar.ogg": b"g"},
    )
    assert mig.verify_zip(pak) == "full-stem-default-on"


def test_verify_rejects_an_unmigrated_pack(tmp_path: Path):
    pak = _write_pack(tmp_path / "song.feedpak", _manifest())
    assert mig.verify_zip(pak) == "still-has-key"


# ── Unsafe manifest paths must not be laundered into playable audio ─────────

@pytest.mark.parametrize(
    "rel", ["../outside.ogg", "/etc/passwd", "a/../../x.ogg", "C:/x.ogg", "a\\b.ogg"]
)
def test_migrate_refuses_an_unsafe_full_mix_path(tmp_path: Path, rel: str):
    """Core's loader REFUSES a full-mix path that escapes the pack — such a pack
    simply has no full mix, and the audio is inert. Migrating it into
    `stems/full.ogg` would take content the reader deliberately rejected and hand
    it back as a valid, playable stem. Report it; never promote it."""
    pak = _write_pack(
        tmp_path / "song.feedpak",
        _manifest(original_audio=rel),
        files={rel: b"EVIL", "stems/guitar.ogg": b"g"},
    )
    before = pak.read_bytes()
    assert mig.migrate_zip(pak, dry_run=False) == "unsafe-path"
    assert pak.read_bytes() == before


def test_safe_relpath_accepts_ordinary_pack_paths():
    assert mig.is_safe_relpath("stems/full.ogg")
    assert mig.is_safe_relpath("original/full.ogg")
    assert not mig.is_safe_relpath("")
    assert not mig.is_safe_relpath("a//b.ogg")


# ── Damaged packs must not abort the run ────────────────────────────────────

def test_a_corrupt_archive_is_reported_not_fatal(tmp_path: Path, capsys):
    """A real library has damage in it — a truncated download, an archive left
    half-written by an interrupted converter. One of those must not kill a
    50,000-pack run and throw away the summary: the pack is reported, skipped,
    and everything else still migrates."""
    good = _write_pack(tmp_path / "good.feedpak", _manifest())
    bad = tmp_path / "bad.feedpak"
    bad.write_bytes(b"this is not a zip file at all")

    rc = mig.main([str(tmp_path)])
    out = capsys.readouterr().out

    assert rc == 1                       # a problem pack fails the run's exit code
    assert "corrupt-zip" in out
    assert "migrated" in out
    assert mig.verify_zip(good) == "ok"  # the healthy pack still got migrated
    assert bad.read_bytes() == b"this is not a zip file at all"  # untouched


# ── Directory-form (authoring) packs are discovered, not silently skipped ────

def _write_dir_pack(path: Path, manifest: dict, files: dict[str, bytes] | None = None) -> Path:
    """Build a directory-form pack (`song.sloppak/`), the authoring shape."""
    files = files or {
        "original/full.ogg": b"MIXDOWN",
        "stems/guitar.ogg": b"g",
        "stems/drums.ogg": b"d",
        "arrangements/lead.json": b"{}",
    }
    path.mkdir()
    (path / "manifest.yaml").write_text(yaml.safe_dump(manifest, sort_keys=False))
    for name, data in files.items():
        p = path / name
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_bytes(data)
    return path


def test_iter_packs_discovers_directory_form_packs(tmp_path: Path):
    """A `song.sloppak/` directory is a pack; os.walk must yield it whole and
    NOT descend into it (its stems/ are contents, not packs)."""
    d = _write_dir_pack(tmp_path / "song.sloppak", _manifest())
    z = _write_pack(tmp_path / "other.feedpak", _manifest())
    found = set(mig.iter_packs(tmp_path))
    assert d in found and z in found
    # Nothing inside the directory pack was yielded as its own pack.
    assert not any(d in p.parents for p in found)


def test_iter_packs_yields_a_directly_passed_dir_pack(tmp_path: Path):
    d = _write_dir_pack(tmp_path / "song.sloppak", _manifest())
    assert list(mig.iter_packs(d)) == [d]


def test_directory_form_pack_is_reported_not_silently_skipped(tmp_path: Path, capsys):
    """The migrator rewrites single-file packs atomically; a directory can't be
    swapped that way, so it is surfaced as a problem rather than vanishing from
    the run (the silent-skip this guards against) or being rewritten unsafely."""
    d = _write_dir_pack(tmp_path / "song.sloppak", _manifest())
    good = _write_pack(tmp_path / "good.feedpak", _manifest())

    rc = mig.main([str(tmp_path)])
    out = capsys.readouterr().out

    assert rc == 1                              # a reported problem fails the exit code
    assert "dir-form-unsupported" in out
    assert mig.verify_zip(good) == "ok"         # the zip pack still migrated
    # The directory pack is untouched: legacy key intact, mixdown not moved.
    manifest = yaml.safe_load((d / "manifest.yaml").read_text())
    assert manifest.get("original_audio") == "original/full.ogg"
    assert (d / "original" / "full.ogg").read_bytes() == b"MIXDOWN"


def test_verify_reports_directory_form_packs(tmp_path: Path):
    d = _write_dir_pack(tmp_path / "song.sloppak", _manifest())
    assert mig.verify_pack(d) == "dir-form-unsupported"
