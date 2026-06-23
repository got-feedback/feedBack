#!/usr/bin/env python3
"""Lift legacy piano/keys sloppaks into the Sloppak Notation Format.

Usage:
    python scripts/lift_keys_notation.py path/to/dlc-dir [--dry-run] [-v]

One-time converter for existing **directory-form** sloppaks whose keys
arrangements carry notes in the guitar wire encoding (``midi = s*24 + f``,
the Clone Hero / GP-import legacy form). For every arrangement whose name
looks like keys (``keys|piano|keyboard|synth``, word-boundary,
case-insensitive) and that does not already have a ``notation:`` manifest
sub-key, it:

1. decodes the wire notes (including chord notes) to absolute MIDI,
2. derives measures from the song-level ``beats`` array downbeats
   (``measure >= 0`` entries), with per-measure tempo from downbeat spacing
   (assuming the manifest's time signature, default 4/4; emitted only on a
   change of more than 1 BPM),
3. derives durations from the wire sustain when > 0, else the gap to the
   next onset in the same hand — quantized to the nearest plain or
   single-dotted ``{1,2,4,8,16,32}`` at the local tempo, floored at a 32nd,
4. splits hands heuristically: simultaneous onsets (within 10 ms) are
   grouped; a group spanning more than 12 semitones is split at its largest
   internal interval gap (low side → ``lh``); otherwise the whole group goes
   by mean pitch vs middle C (≥ 60 → ``rh``). Output is single-staff when
   everything lands on one side,
5. validates the payload via ``notation.validate_notation`` and writes
   ``notation_<id>.json``, then rewrites ``manifest.yaml`` adding the
   per-arrangement ``notation:`` sub-key.

Idempotent: arrangements that already carry ``notation:`` are skipped, and
an existing ``notation_<id>.json`` without a manifest key is left untouched
(skipped with a warning) rather than overwritten.

``--dry-run`` prints what would change without writing anything.

**Formatting caveat:** the manifest is round-tripped through PyYAML
(``safe_load`` + ``safe_dump(sort_keys=False)``). Key order is preserved,
but YAML comments and custom formatting are lost. The script warns when the
manifest it is about to rewrite contains comment lines.

Zip-form ``.sloppak`` files are skipped (unpack to directory form first).
"""

from __future__ import annotations

import argparse
import json
import logging
import re
import sys
from pathlib import Path

# Make `lib/` importable regardless of CWD.
_HERE = Path(__file__).resolve().parent
_ROOT = _HERE.parent
sys.path.insert(0, str(_ROOT / "lib"))

import yaml  # noqa: E402

import notation as notation_mod  # noqa: E402, F401  (re-exported for tests)

# The wire→notation heuristic core lives in ``lib/notation_lift.py`` so it can
# be reused in-process (e.g. by the Arrangement Editor's notation save path)
# rather than being copy-pasted out of this one-time CLI. Re-exported here so
# the historic ``from scripts.lift_keys_notation import build_notation`` (and
# friends) import paths keep working.
from notation_lift import (  # noqa: E402
    HAND_SPLIT_SPAN_SEMITONES,
    KEYS_NAME_RE,
    MIDDLE_C,
    SIMULTANEITY_WINDOW_S,
    build_notation,
    decode_wire_notes,
    downbeat_times,
    group_simultaneous,
    measure_tempos,
    quantize_duration,
    split_hands,
)

log = logging.getLogger("feedBack.scripts.lift_keys_notation")

_SAFE_ID_RE = re.compile(r"[A-Za-z0-9_-]+")


# ── Sloppak walking ───────────────────────────────────────────────────────────

def _parse_time_signature(raw: object) -> tuple[int, int]:
    """Manifest ``time_signature`` as ``(num, den)``; default 4/4."""
    if isinstance(raw, str) and "/" in raw:
        try:
            num, den = (int(x) for x in raw.split("/", 1))
            if num > 0 and den > 0:
                return (num, den)
        except ValueError:
            pass
    if isinstance(raw, (list, tuple)) and len(raw) == 2:
        try:
            num, den = int(raw[0]), int(raw[1])
            if num > 0 and den > 0:
                return (num, den)
        except (TypeError, ValueError):
            pass
    return (4, 4)


def _load_song_beats(pak: Path, manifest: dict) -> list[dict]:
    """Song-level beats: ``song_timeline.json`` when present, else the first
    arrangement JSON that carries a non-empty ``beats`` array (the loader's
    legacy convention)."""
    st_rel = manifest.get("song_timeline")
    if isinstance(st_rel, str) and st_rel:
        st_path = _safe_child(pak, st_rel)
        if st_path is not None and st_path.is_file():
            try:
                data = json.loads(st_path.read_text(encoding="utf-8"))
                # An empty beats list is not an authoritative timeline — fall
                # through to the arrangement JSONs rather than ending up with
                # zero downbeats and skipping the whole sloppak.
                if isinstance(data, dict) and isinstance(data.get("beats"), list) \
                        and data["beats"]:
                    return data["beats"]
            except (OSError, ValueError) as e:
                log.warning("%s: unreadable song_timeline (%s)", pak.name, e)

    for entry in manifest.get("arrangements") or []:
        if not isinstance(entry, dict):
            continue
        rel = entry.get("file")
        if not isinstance(rel, str) or not rel:
            continue
        arr_path = _safe_child(pak, rel)
        if arr_path is None or not arr_path.is_file():
            continue
        try:
            data = json.loads(arr_path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            continue
        if isinstance(data, dict):
            beats_raw = data.get("beats")
            # Only a non-empty list is a usable timeline. A malformed `beats`
            # (dict/string/empty) must not short-circuit the fallback — later
            # arrangements may carry valid beats.
            if isinstance(beats_raw, list) and beats_raw:
                return beats_raw
    return []


def _safe_child(pak: Path, rel: str) -> Path | None:
    """Resolve ``rel`` inside ``pak``; None when it escapes (traversal guard)."""
    try:
        p = (pak / rel).resolve()
        p.relative_to(pak.resolve())
    except (ValueError, OSError):
        return None
    return p


def lift_sloppak(pak: Path, *, dry_run: bool = False) -> list[str]:
    """Lift every candidate keys arrangement in one directory-form sloppak.

    Returns a list of human-readable change descriptions (empty = nothing to
    do). Writes ``notation_<id>.json`` files and rewrites ``manifest.yaml``
    unless ``dry_run``.
    """
    manifest_path = pak / "manifest.yaml"
    try:
        manifest_text = manifest_path.read_text(encoding="utf-8")
        manifest = yaml.safe_load(manifest_text)
    except (OSError, yaml.YAMLError) as e:
        log.warning("%s: unreadable manifest (%s) — skipped", pak.name, e)
        return []
    if not isinstance(manifest, dict):
        log.warning("%s: manifest is not a mapping — skipped", pak.name)
        return []

    arrangements = manifest.get("arrangements")
    if not isinstance(arrangements, list):
        return []

    ts = _parse_time_signature(manifest.get("time_signature"))
    beats: list[dict] | None = None  # lazy — only loaded when a candidate hits

    changes: list[str] = []
    manifest_dirty = False
    written_notation_paths: list[Path] = []

    for entry in arrangements:
        if not isinstance(entry, dict):
            continue
        arr_id = entry.get("id")
        name = str(entry.get("name") or arr_id or "")
        if not KEYS_NAME_RE.search(name):
            continue
        if entry.get("notation"):
            log.info("%s/%s: already has notation — skipped (idempotent)",
                     pak.name, arr_id)
            continue
        if not isinstance(arr_id, str) or not _SAFE_ID_RE.fullmatch(arr_id):
            log.warning("%s: arrangement %r has no safe id — skipped", pak.name, name)
            continue
        rel = entry.get("file")
        if not isinstance(rel, str) or not rel:
            log.info("%s/%s: no arrangement file (nothing to lift) — skipped",
                     pak.name, arr_id)
            continue
        arr_path = _safe_child(pak, rel)
        if arr_path is None or not arr_path.is_file():
            log.warning("%s/%s: arrangement file %r missing/unsafe — skipped",
                        pak.name, arr_id, rel)
            continue

        nt_name = f"notation_{arr_id}.json"
        nt_path = pak / nt_name
        if nt_path.exists():
            log.warning("%s/%s: %s exists but manifest lacks the notation key — "
                        "refusing to overwrite, skipped", pak.name, arr_id, nt_name)
            continue

        try:
            arr_data = json.loads(arr_path.read_text(encoding="utf-8"))
        except (OSError, ValueError) as e:
            log.warning("%s/%s: unreadable arrangement JSON (%s) — skipped",
                        pak.name, arr_id, e)
            continue
        if not isinstance(arr_data, dict):
            continue

        wire_notes = decode_wire_notes(arr_data)
        if beats is None:
            beats = _load_song_beats(pak, manifest)
        payload = build_notation(wire_notes, beats, ts=ts)
        if payload is None:
            log.info("%s/%s: no notes or no downbeats — nothing to lift",
                     pak.name, arr_id)
            continue

        n_measures = len(payload["measures"])
        staff_ids = [s["id"] for s in payload["staves"]]
        desc = (f"{pak.name}/{arr_id}: write {nt_name} "
                f"({n_measures} measures, staves {'+'.join(staff_ids)}, "
                f"{len(wire_notes)} wire notes) + manifest notation key")
        changes.append(desc)
        if dry_run:
            log.info("DRY-RUN would: %s", desc)
            continue

        # Write atomically: temp file then rename so a mid-write failure
        # leaves no partial sidecar that would block idempotent reruns.
        nt_tmp = nt_path.with_suffix(".lift-tmp")
        try:
            nt_tmp.write_text(json.dumps(payload, separators=(",", ":")),
                              encoding="utf-8")
            nt_tmp.replace(nt_path)
        except OSError:
            nt_tmp.unlink(missing_ok=True)
            raise
        written_notation_paths.append(nt_path)
        entry["notation"] = nt_name
        manifest_dirty = True
        log.info("%s", desc)

    if manifest_dirty and not dry_run:
        if any(line.lstrip().startswith("#") for line in manifest_text.splitlines()):
            log.warning("%s: manifest.yaml contains comments — the PyYAML "
                        "rewrite preserves key order but drops comments",
                        pak.name)
        # Atomic manifest replace (temp + rename in the same directory); a
        # failure rolls back this run's notation files so the sloppak never
        # ends up with orphan sidecars the manifest doesn't reference.
        tmp_path = manifest_path.with_name(manifest_path.name + ".lift-tmp")
        try:
            tmp_path.write_text(
                yaml.safe_dump(manifest, sort_keys=False, allow_unicode=True),
                encoding="utf-8",
            )
            tmp_path.replace(manifest_path)
        except OSError as e:
            tmp_path.unlink(missing_ok=True)
            for p in written_notation_paths:
                p.unlink(missing_ok=True)
            log.error("%s: manifest rewrite failed (%s) — rolled back %d "
                      "notation file(s)", pak.name, e, len(written_notation_paths))
            raise

    return changes


def find_sloppak_dirs(dlc_dir: Path) -> list[Path]:
    """Directory-form sloppaks under ``dlc_dir`` (recursive). Zip-form
    ``.sloppak`` files are reported and skipped."""
    dirs: list[Path] = []
    for p in sorted(dlc_dir.rglob("*.sloppak")):
        if p.is_dir():
            if (p / "manifest.yaml").is_file():
                dirs.append(p)
            else:
                log.warning("%s: directory has no manifest.yaml — skipped", p.name)
        else:
            log.info("%s: zip-form sloppak — skipped (unpack to directory form "
                     "first)", p.name)
    return dirs


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description="Lift legacy piano/keys sloppaks (guitar wire encoding) "
                    "into per-arrangement notation_<id>.json files.")
    parser.add_argument("dlc_dir", type=Path,
                        help="DLC directory containing directory-form .sloppak folders")
    parser.add_argument("--dry-run", action="store_true",
                        help="print what would change without writing anything")
    parser.add_argument("-v", "--verbose", action="store_true",
                        help="debug logging")
    args = parser.parse_args(argv)

    logging.basicConfig(
        level=logging.DEBUG if args.verbose else logging.INFO,
        format="%(levelname)s %(message)s",
    )

    if not args.dlc_dir.is_dir():
        log.error("not a directory: %s", args.dlc_dir)
        return 2

    total_changes = 0
    paks = find_sloppak_dirs(args.dlc_dir)
    log.info("scanning %d directory-form sloppak(s) under %s", len(paks), args.dlc_dir)
    for pak in paks:
        total_changes += len(lift_sloppak(pak, dry_run=args.dry_run))

    verb = "would lift" if args.dry_run else "lifted"
    log.info("done: %s %d arrangement(s)", verb, total_changes)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
