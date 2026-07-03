"""Persist user-edited song metadata back into the underlying song file.

The library scanner (`lib/scan_worker.py`) re-derives title/artist/album/year
from the file on every full rescan — from the sloppak ``manifest.yaml``
top-level keys. A DB-only edit therefore reverts the moment a full rescan
re-reads the file. Writing the edit into the file makes the file the single
source of truth, so the change survives both incremental and full rescans.

``fields`` is a partial dict of any of ``title``/``artist``/``album``/``year``;
only the keys present are overwritten, so an edit of just the title can't blank
out the artist.

Only feedBack's own song-package format (zip- or directory-form, ``.feedpak``
or the legacy ``.sloppak`` suffix) is writable. Unknown / unsupported shapes
return False and the caller keeps the DB-only update.
"""
from __future__ import annotations

import shutil
import zipfile
from pathlib import Path

import yaml


def _coerce_year(value):
    """Convert *value* to an int year, or 0 for empty/invalid (clear intent).

    The scanner reads ``SongYear`` as ``str(manifest.get("year", "") or "")``
    for sloppaks — so 0 round-trips back to an empty string, which is the
    correct DB representation of "no year". Callers must gate on
    ``"year" in fields`` before calling this; they must NOT gate on the return
    value being non-None/non-zero (that would silently drop a year-clear edit,
    which is the bug this function fixes).
    """
    try:
        return int(value)
    except (TypeError, ValueError):
        return 0  # empty string / non-numeric → clear the year


def _apply_to_sloppak_manifest(manifest: dict, fields: dict) -> bool:
    """Update a parsed sloppak manifest in place. Returns True if changed."""
    dirty = False
    for key in ("title", "artist", "album"):
        if fields.get(key) is not None:
            manifest[key] = str(fields[key])
            dirty = True
    if "year" in fields:
        manifest["year"] = _coerce_year(fields["year"])
        dirty = True
    # `genres` is the feedpak list field (spec 1.12.0). Accepts a list/tuple
    # (stringified item-wise) or a single name (wrapped); None leaves the
    # existing value alone, mirroring the string fields above. Sent by the
    # overwrite lane (R4b) — the manual Edit Metadata path never includes it.
    if fields.get("genres") is not None:
        raw = fields["genres"]
        manifest["genres"] = ([str(g) for g in raw]
                              if isinstance(raw, (list, tuple)) else [str(raw)])
        dirty = True
    # Opportunistically declare the format version (spec §4) when we're already
    # rewriting because a metadata field was supplied. Gated on `dirty` (i.e. a
    # field was given) so this never forces a *standalone* rewrite with no fields
    # passed, and `not in` so an existing (possibly higher) version is preserved,
    # never downgraded. NB `dirty` here means "a field was supplied" — a
    # supplied-but-identical value already triggers a rewrite (pre-existing).
    if dirty and "feedpak_version" not in manifest:
        from sloppak import FEEDPAK_VERSION
        manifest["feedpak_version"] = FEEDPAK_VERSION
    return dirty


def _rewrite_zip_manifest(zip_path: Path, dumped: str) -> bool:
    """Rewrite manifest.yaml inside a zip-form sloppak, preserving every other
    entry (and its original compression). Backup + temp + atomic replace."""
    zip_path = Path(zip_path)
    backup = zip_path.with_name(zip_path.name + ".bak")
    if not backup.exists():
        shutil.copy2(zip_path, backup)
    out_tmp = zip_path.with_name(zip_path.name + ".tmp")
    with zipfile.ZipFile(str(zip_path), "r") as zin:
        names = zin.namelist()
        manifest_name = "manifest.yaml"
        for cand in ("manifest.yaml", "manifest.yml"):
            if cand in names:
                manifest_name = cand
                break
        with zipfile.ZipFile(str(out_tmp), "w", zipfile.ZIP_DEFLATED) as zout:
            for item in zin.infolist():
                if item.filename in ("manifest.yaml", "manifest.yml"):
                    continue
                # Passing the original ZipInfo preserves each entry's
                # compress_type — important for already-compressed ogg stems.
                zout.writestr(item, zin.read(item.filename))
            zout.writestr(manifest_name, dumped)
    out_tmp.replace(zip_path)
    return True


def write_sloppak_metadata(path: Path, fields: dict) -> bool:
    """Write metadata into a sloppak (directory or zip form). Returns True if
    anything was written."""
    import sloppak as sloppak_mod

    path = Path(path)
    manifest = sloppak_mod.load_manifest(path)
    if not _apply_to_sloppak_manifest(manifest, fields):
        return False
    dumped = yaml.safe_dump(manifest, sort_keys=False, allow_unicode=True)
    if path.is_dir():
        mf = path / "manifest.yaml"
        if not mf.exists() and (path / "manifest.yml").exists():
            mf = path / "manifest.yml"
        # One-time backup + temp + atomic replace, exactly like the zip
        # rewriter and gap_fill_sloppak's dir branch: the FIRST backup is the
        # pristine author original and is never clobbered by a later write —
        # it's what "Revert file to original" (R4b) restores.
        backup = mf.with_name(mf.name + ".bak")
        if mf.exists() and not backup.exists():
            shutil.copy2(mf, backup)
        tmp = mf.with_name(mf.name + ".tmp")
        tmp.write_text(dumped, encoding="utf-8")
        tmp.replace(mf)
        return True
    return _rewrite_zip_manifest(path, dumped)


def gap_fill_sloppak(path: Path, additions: dict) -> bool:
    """Append ABSENT top-level keys to a sloppak manifest (the gap-fill
    contract: user-initiated, adds missing keys only, never replaces
    anything the author set).

    Unlike ``write_sloppak_metadata`` this does NOT re-serialize the
    manifest — because every added key is absent by definition, the new
    lines can simply be appended, so the author's existing bytes (key
    order, comments, formatting) survive verbatim. Directory form gets a
    one-time ``manifest.yaml.bak`` + temp + atomic replace; zip form goes
    through the same backup/temp/replace rewriter the metadata editor
    uses. Returns True if anything was written; raises ``ValueError`` if
    a requested key already exists (callers are expected to have checked
    — this is the last-line never-clobber guard)."""
    import sloppak as sloppak_mod

    path = Path(path)
    if not additions:
        return False
    manifest = sloppak_mod.load_manifest(path) or {}
    clash = sorted(k for k in additions if k in manifest)
    if clash:
        raise ValueError("gap-fill refused: key(s) already present: " + ", ".join(clash))

    if path.is_dir():
        mf = path / "manifest.yaml"
        if not mf.exists() and (path / "manifest.yml").exists():
            mf = path / "manifest.yml"
        original = mf.read_text(encoding="utf-8")
    else:
        with zipfile.ZipFile(str(path), "r") as zin:
            names = zin.namelist()
            manifest_name = "manifest.yaml"
            for cand in ("manifest.yaml", "manifest.yml"):
                if cand in names:
                    manifest_name = cand
                    break
            original = zin.read(manifest_name).decode("utf-8")

    appended = original if original.endswith("\n") or not original else original + "\n"
    appended += yaml.safe_dump(additions, sort_keys=False, allow_unicode=True)

    if path.is_dir():
        backup = mf.with_name(mf.name + ".bak")
        if not backup.exists():
            shutil.copy2(mf, backup)
        tmp = mf.with_name(mf.name + ".tmp")
        tmp.write_text(appended, encoding="utf-8")
        tmp.replace(mf)
        return True
    return _rewrite_zip_manifest(path, appended)


def write_song_metadata(path: Path, fields: dict) -> bool:
    """Persist edited title/artist/album/year into the song's file.

    Dispatches by shape: zip-form song packages (``.feedpak`` / legacy
    ``.sloppak``, per ``sloppak.SONG_EXTS``) and package directories
    (manifest.yaml present). Loose-folder and unknown shapes return False
    (caller keeps the DB-only update). Returns True if the file was modified.
    """
    from sloppak import SONG_EXTS

    path = Path(path)
    suffix = path.suffix.lower()
    if path.is_dir():
        if (path / "manifest.yaml").exists() or (path / "manifest.yml").exists():
            return write_sloppak_metadata(path, fields)
        return False
    if suffix in SONG_EXTS:
        return write_sloppak_metadata(path, fields)
    return False
