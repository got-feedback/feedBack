#!/usr/bin/env python3
"""Migrate packs off the deprecated `original_audio:` key — the full mix is a stem.

Before feedpak 1.15.0 reserved the stem id `full`, spec §5.3 said the mixdown was
"commonly replaced" by the per-instrument stems when a pack was split — so after
separation it had nowhere to live. This repo worked around that by inventing a
top-level `original_audio:` manifest key pointing at a parallel `original/`
directory (#583). The key was never in the spec, and #933 removed core's
dependence on it: the mixdown is a stem, and its id is `full`.

This rewrites a pack into the shape the spec now defines:

    original/full.ogg                  ->  stems/full.ogg          (entry moved)
    original_audio: original/full.ogg  ->  stems: [{id: full, file: stems/full.ogg,
                                                    default: 'off'}, ...]

`default: 'off'` is what makes the retained mixdown safe: a reader that honours
`default` (normative since feedpak 1.0.0) will not play it on open, so it never
doubles the mix even in a reader that predates the reserved id.

Nothing else in the pack is touched — every other key, file and stem is preserved
verbatim, and `feedpak_version` is stamped to the version the result conforms to.

The rewrite is atomic per pack: a new archive is built beside the original and
renamed over it only on success, so an interrupted run leaves every pack either
fully migrated or untouched — never truncated.

Idempotent: a pack that already carries a `full` stem and no `original_audio:` is
reported as `skip` and left alone, so a partial run can simply be re-run.

Usage:
    python tools/migrate_full_mix_stem.py --dry-run /path/to/packs   # report only
    python tools/migrate_full_mix_stem.py /path/to/packs             # migrate
    python tools/migrate_full_mix_stem.py --verify /path/to/packs    # check results

Exit status is 0 only when every pack ended up in the migrated shape (or was
already there).
"""
from __future__ import annotations

import argparse
import os
import shutil
import sys
import tempfile
import threading
import time
import zipfile
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path

import yaml

# The version this migration brings a pack up to: the one that reserved `full`.
TARGET_FEEDPAK_VERSION = "1.15.0"
FULL_MIX_STEM_ID = "full"
LEGACY_KEY = "original_audio"
# Where the mixdown lands. §2.1's conventional layout — readers resolve through
# the manifest and never care about the path, but a pack that says `stems/` and
# means it is the one a human can read.
CANONICAL_FULL_MIX_PATH = "stems/full.ogg"

PACK_EXTS = (".feedpak", ".sloppak")


class Skip(Exception):
    """Pack needs no migration."""


def is_safe_relpath(rel: str) -> bool:
    """True when `rel` is a manifest path the spec allows (§2.2 rule 2).

    POSIX-style relative: forward slashes, no leading `/`, no `..` segments, no
    empty segments, no colon (which excludes drive letters and NTFS alternate
    data streams), no backslashes.

    This is a TRUST BOUNDARY, not a tidiness check. Core's loader refuses a
    full-mix path that escapes the pack and reports the pack as having no full
    mix — the audio is inert. A migration that moved such an entry into
    `stems/full.ogg` would take content the reader deliberately rejected and
    hand it back as a valid, playable stem. So a pack like this is reported, not
    migrated.
    """
    if not rel or rel.startswith("/") or "\\" in rel or ":" in rel:
        return False
    parts = rel.split("/")
    return all(p and p != ".." for p in parts)


def plan_manifest(manifest: dict) -> tuple[dict, str]:
    """Return (new_manifest, relpath_of_audio_to_move); "" = no file needs moving.

    Raises Skip when the pack needs no migration. Pure — no I/O — so the part
    with the decisions in it is testable without building archives.
    """
    raw_stems = manifest.get("stems")
    stems: list = raw_stems if isinstance(raw_stems, list) else []
    has_full_stem = any(
        isinstance(s, dict) and str(s.get("id", "")) == FULL_MIX_STEM_ID for s in stems
    )
    legacy_rel = manifest.get(LEGACY_KEY)
    legacy_rel = legacy_rel.strip() if isinstance(legacy_rel, str) else ""

    if not legacy_rel:
        # Nothing invented to undo: either the pack already keeps its mixdown as
        # the `full` stem, or it never carried one.
        raise Skip("already migrated" if has_full_stem else "no original_audio key")

    if has_full_stem:
        # The mixdown is already a stem and the dead key merely lingers beside it.
        # Drop the key; move nothing. But do NOT trust its `default`: a mixdown
        # left enabled beside instrument stems is the double-audio hazard this
        # migration exists to remove, and a reader that honours `default` would
        # play the whole song on top of the stems on open. Force it off — unless
        # `full` is the only stem, in which case it IS the audio.
        others = [
            s
            for s in stems
            if isinstance(s, dict) and str(s.get("id", "")) != FULL_MIX_STEM_ID
        ]
        new_stems = []
        for s in stems:
            if isinstance(s, dict) and str(s.get("id", "")) == FULL_MIX_STEM_ID and others:
                s = {**s, "default": "off"}
            new_stems.append(s)
        to_move = ""
    else:
        # `default` decides whether a reader plays this on open, and that is the
        # whole safety margin: alongside per-instrument stems the mixdown must be
        # OFF (a reader that sums the list would otherwise double the song), but
        # when it is the pack's only stem it IS the audio and must be ON.
        entry = {
            "id": FULL_MIX_STEM_ID,
            "file": CANONICAL_FULL_MIX_PATH,
            "default": "off" if stems else "on",
        }
        # First in the list, matching the spec's §5.3 example.
        new_stems = [entry, *stems]
        # If the key already pointed at the canonical path, only the manifest is wrong.
        to_move = "" if legacy_rel == CANONICAL_FULL_MIX_PATH else legacy_rel

    out: dict = {}
    for k, v in manifest.items():
        if k == LEGACY_KEY:
            continue  # the invented key disappears
        out[k] = new_stems if k == "stems" else v
    out.setdefault("stems", new_stems)  # a pack that had no stems list gets one
    out["feedpak_version"] = TARGET_FEEDPAK_VERSION
    return out, to_move


def migrate_zip(path: Path, dry_run: bool) -> str:
    """Rewrite one zipped pack in place. Returns a one-word status."""
    with zipfile.ZipFile(path) as zf:
        try:
            raw = zf.read("manifest.yaml")
        except KeyError:
            return "no-manifest"
        manifest = yaml.safe_load(raw) or {}
        try:
            new_manifest, old_rel = plan_manifest(manifest)
        except Skip:
            return "skip"
        names = set(zf.namelist())
        if old_rel:
            if not is_safe_relpath(old_rel):
                # Core refuses this path and plays no full mix for the pack. Do
                # not launder it into a valid stem — see is_safe_relpath().
                return "unsafe-path"
            if old_rel not in names:
                # The key points at audio that isn't in the archive. Core already
                # treats that as "no full mix"; migrating would fabricate a stem
                # entry for a file that does not exist and break every reader.
                return "missing-audio"
            if CANONICAL_FULL_MIX_PATH in names:
                return "target-occupied"
        else:
            # Manifest-only rewrite (a stale key beside a mixdown that is already
            # a stem, or a key that already pointed at the canonical path). Check
            # the file the resulting `full` stem will actually NAME — not the
            # canonical path, which an already-migrated pack is free not to use:
            # §2.2 says readers resolve through the manifest, so a valid pack may
            # keep its mixdown anywhere.
            full_file = next(
                (
                    s.get("file")
                    for s in new_manifest.get("stems", [])
                    if isinstance(s, dict) and str(s.get("id", "")) == FULL_MIX_STEM_ID
                ),
                None,
            )
            if full_file not in names:
                return "missing-audio"
        if dry_run:
            return "would-migrate"

        # Build the replacement beside the original, on the same filesystem, so
        # the final rename is atomic and an interrupted run can't truncate a pack.
        tmp_fd, tmp_name = tempfile.mkstemp(
            dir=str(path.parent), prefix=f".{path.name}.", suffix=".tmp"
        )
        os.close(tmp_fd)
        tmp_path = Path(tmp_name)
        try:
            with zipfile.ZipFile(tmp_path, "w", zipfile.ZIP_DEFLATED) as out:
                for item in zf.infolist():
                    if item.filename == "manifest.yaml":
                        out.writestr(
                            item,
                            yaml.safe_dump(
                                new_manifest, sort_keys=False, allow_unicode=True
                            ),
                        )
                        continue
                    data = zf.read(item.filename)
                    if old_rel and item.filename == old_rel:
                        # Same bytes, same compression, new name: the mixdown moves
                        # from original/ into stems/ where the format says audio goes.
                        moved = zipfile.ZipInfo(
                            CANONICAL_FULL_MIX_PATH, date_time=item.date_time
                        )
                        moved.compress_type = item.compress_type
                        moved.external_attr = item.external_attr
                        out.writestr(moved, data)
                        continue
                    out.writestr(item, data)
        except BaseException:
            tmp_path.unlink(missing_ok=True)
            raise
    shutil.copystat(path, tmp_path)
    os.replace(tmp_path, path)  # atomic
    return "migrated"


def verify_zip(path: Path) -> str:
    """Confirm a pack is in the migrated shape and its mixdown is really there."""
    with zipfile.ZipFile(path) as zf:
        try:
            manifest = yaml.safe_load(zf.read("manifest.yaml")) or {}
        except KeyError:
            return "no-manifest"
        if LEGACY_KEY in manifest:
            return "still-has-key"
        stems = manifest.get("stems") or []
        full = next(
            (
                s
                for s in stems
                if isinstance(s, dict) and str(s.get("id", "")) == FULL_MIX_STEM_ID
            ),
            None,
        )
        if full is None:
            return "no-full-stem"
        if full.get("file") not in set(zf.namelist()):
            return "full-stem-missing-file"
        # A retained mixdown that plays on open would double the mix in any reader
        # that sums the stem list — the whole hazard this migration must not create.
        if len(stems) > 1 and str(full.get("default", "")).lower() in ("true", "on", "yes", "1"):
            return "full-stem-default-on"
    return "ok"


def migrate_pack(path: Path, dry_run: bool) -> str:
    """Dispatch by pack form. ZIP-file packs are rewritten in place; directory
    (authoring) packs are REPORTED, not rewritten.

    A single-file pack is replaced atomically — a fully-built temp archive
    swapped in with one os.replace(), so an interrupted run leaves it either
    fully migrated or untouched. A directory can't be swapped that way (no
    atomic replace of a populated directory), so an in-place rewrite could leave
    an authoring pack half-migrated. Rather than risk that, directory packs are
    surfaced as `dir-form-unsupported` (a problem status, so the run's exit code
    and summary flag them) for the operator to re-pack or migrate as a `.feedpak`.
    """
    if path.is_dir():
        return "dir-form-unsupported"
    return migrate_zip(path, dry_run)


def verify_pack(path: Path) -> str:
    """Verify a pack; directory (authoring) packs are reported, see migrate_pack."""
    if path.is_dir():
        return "dir-form-unsupported"
    return verify_zip(path)


def iter_packs(root: Path):
    """Yield every pack under `root`. A pack is a suffix-named ZIP FILE or a
    suffix-named DIRECTORY (the authoring form) — both are discovered so a
    directory-form pack is never silently walked past. A directory pack is
    yielded whole, not descended into: its `stems/` and `arrangements/` are pack
    contents, not packs. (migrate/verify then report directory packs rather than
    rewriting them in place — see migrate_pack.)"""
    if root.is_file():
        yield root
        return
    # A directory whose OWN name is a pack suffix is a single directory-form
    # pack passed directly, not a tree of packs to search.
    if root.name.endswith(PACK_EXTS):
        yield root
        return
    for dirpath, dirnames, filenames in os.walk(root):
        for fn in sorted(filenames):
            if fn.endswith(PACK_EXTS):
                yield Path(dirpath) / fn
        for dn in sorted(dn for dn in dirnames if dn.endswith(PACK_EXTS)):
            yield Path(dirpath) / dn
        # Don't descend INTO a pack directory — its contents aren't packs.
        dirnames[:] = [dn for dn in dirnames if not dn.endswith(PACK_EXTS)]


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("root", type=Path, help="pack, or directory of packs")
    ap.add_argument("--dry-run", action="store_true", help="report, change nothing")
    ap.add_argument("--verify", action="store_true", help="check the migrated shape")
    ap.add_argument("--jobs", type=int, default=8, help="parallel packs (default 8)")
    args = ap.parse_args(argv)

    if not args.root.exists():
        print(f"error: {args.root} does not exist", file=sys.stderr)
        return 2

    packs = list(iter_packs(args.root))
    if not packs:
        print(f"no packs found under {args.root}", file=sys.stderr)
        return 2

    action = verify_pack if args.verify else (lambda p: migrate_pack(p, args.dry_run))

    def work(pack: Path) -> str:
        """Never raise. One unreadable pack must not kill a 50,000-pack run.

        A library this size has damage in it — a truncated download, an archive
        left half-written by an interrupted converter. Letting that propagate
        aborts the whole job partway through and throws away the summary, which
        is exactly when you most need to know what happened. Report it as a
        problem status instead: the pack is untouched, the run continues, and the
        final report names it.
        """
        try:
            return action(pack)
        except zipfile.BadZipFile:
            return "corrupt-zip"
        except OSError as e:
            return f"io-error ({e.__class__.__name__})"
        except Exception as e:  # malformed YAML, unexpected manifest shape, …
            return f"error ({e.__class__.__name__})"
    counts: dict[str, int] = {}
    problems: list[tuple[str, Path]] = []
    # A real run rewrites every archive under `root` — tens of thousands of packs
    # and hundreds of gigabytes. Printing only a final summary means hours of
    # silence, in which a stall and steady progress look identical. Emit a
    # heartbeat instead: rate and ETA come from the packs actually finished, so
    # it stays honest when the disk slows down. stderr, so `> report.txt` keeps
    # the summary clean.
    total = len(packs)
    started = time.monotonic()
    # The heartbeat runs on its OWN CLOCK, in its own thread.
    #
    # Two weaker designs were tried and both go quiet exactly when you need them
    # to speak. Ticking every N packs ties the cadence to how slow a pack is: 500
    # packs is a blink in a --dry-run and many minutes in a real migration, so the
    # run that most needs watching says the least. Ticking on time but only when a
    # pack *finishes* is no better: if every worker is grinding on a huge archive,
    # nothing completes, so nothing prints — and a stall becomes indistinguishable
    # from progress, which is the one thing a progress meter must never allow.
    #
    # A daemon thread on a fixed interval reports regardless. If the count stops
    # advancing between beats, you are looking at a stall, and you can see it.
    HEARTBEAT_SECONDS = 10.0
    done = 0  # only the main loop writes it; the beat thread only reads
    stop_beat = threading.Event()

    def heartbeat() -> None:
        while not stop_beat.wait(HEARTBEAT_SECONDS):
            elapsed = time.monotonic() - started
            rate = done / elapsed if elapsed > 0 else 0.0
            eta = (total - done) / rate if rate > 0 else 0.0
            print(
                f"  {done}/{total} ({100 * done / total:.1f}%)  "
                f"{rate:.1f} packs/s  eta {eta / 60:.0f}m  "
                f"[{len(problems)} problem(s)]",
                file=sys.stderr,
                flush=True,
            )

    print(
        f"{total} pack(s) under {args.root} — "
        f"{'verifying' if args.verify else 'dry run' if args.dry_run else 'migrating'} "
        f"with {max(1, args.jobs)} job(s)",
        file=sys.stderr,
        flush=True,
    )
    beat = threading.Thread(target=heartbeat, daemon=True)
    beat.start()

    # as_completed, not pool.map: map yields in SUBMISSION order, so the counter
    # would stall behind one slow pack while later ones were already done — a
    # progress meter that lies about progress. Count each pack as it finishes.
    try:
        with ThreadPoolExecutor(max_workers=max(1, args.jobs)) as pool:
            futures = {pool.submit(work, p): p for p in packs}
            for fut in as_completed(futures):
                pack = futures[fut]
                status = fut.result()
                counts[status] = counts.get(status, 0) + 1
                if status not in ("migrated", "skip", "would-migrate", "ok"):
                    problems.append((status, pack))
                done += 1
    finally:
        stop_beat.set()
        beat.join(timeout=1)

    print(f"\n{len(packs)} pack(s) under {args.root}")
    for status, n in sorted(counts.items(), key=lambda kv: -kv[1]):
        print(f"  {n:>7}  {status}")
    if problems:
        print(f"\n{len(problems)} pack(s) need a look:", file=sys.stderr)
        for status, pack in problems[:20]:
            print(f"  {status:<22} {pack}", file=sys.stderr)
        if len(problems) > 20:
            print(f"  … and {len(problems) - 20} more", file=sys.stderr)
    return 1 if problems else 0


if __name__ == "__main__":
    raise SystemExit(main())
