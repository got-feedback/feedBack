"""Builtin content seeding: the calibration/diagnostic sloppaks and the starter library.

Carved VERBATIM out of server.py (R3b) — with ONE deliberate signature change, and it is
the whole reason this module is safe.

━━━ WHY THE ROOT IS A PARAMETER ━━━

server.py had `_feedBack_server_root()` = `Path(__file__).resolve().parent`. That is
correct *in server.py*: the repo root in dev, resources/feedBack when bundled — the tree
that actually holds docs/ and data/.

Move that body here unchanged and it keeps working, silently, and returns `lib/`. There is
no docs/diagnostics under lib/, so every seed would quietly find nothing and log "source
missing" — a verbatim move whose meaning changed because `__file__` did. Nothing would
fail; the starter library would just never appear.

So this module CANNOT compute a root: it takes `server_root` as a parameter, and server.py
— the only place that legitimately knows where it lives — passes it in. The trap is now
structurally impossible rather than merely avoided. (_copy_builtin_packs already took the
root this way; the two seed helpers now do too.)

Everything else is byte-identical. `log` is this module's own logger under the same
`feedBack.` hierarchy, and CONFIG_DIR is read late as `appstate.config_dir` — see appstate.py
for why those reads must be late-bound (tests monkeypatch it).
"""
import logging
import os
import secrets
import shutil
import stat
import tempfile
from pathlib import Path

import appstate
from dlc_paths import _get_dlc_dir

log = logging.getLogger("feedBack.builtin_content")


BUILTIN_DIAGNOSTIC_SUBDIR = "diagnostics-builtin"


BUILTIN_DIAGNOSTIC_SOURCES: list[tuple[str, str]] = [
    (
        "feedBack-diagnostic-basic-guitar.sloppak",
        "docs/diagnostics/feedBack-diagnostic-basic-guitar.sloppak",
    ),
]


def builtin_diagnostic_filename() -> str:
    """Library filename (DLC-relative POSIX path) of the calibration sloppak —
    the onboarding challenge target (spec 010)."""
    return f"{BUILTIN_DIAGNOSTIC_SUBDIR}/{BUILTIN_DIAGNOSTIC_SOURCES[0][0]}"


def _copy_builtin_packs(
    root: Path,
    dest_dir: Path,
    sources: list[tuple[str, str]],
    label: str,
    update_existing: bool = True,
) -> int:
    """Symlink-safe, mtime-aware copy of bundled packs into ``dest_dir``.

    ``sources`` is a list of ``(dest_name, rel_source)`` pairs; each source is
    resolved under ``root`` (the repo root in dev, ``resources/feedBack`` when
    bundled). A pack is copied when its destination is missing. Never deletes
    user files; refuses to follow a symlinked seed directory or destination and
    refuses to clobber a non-regular destination (any would let a copy escape
    ``dest_dir`` or destroy user data). Logs and continues on error. ``label``
    prefixes every log line.

    ``update_existing`` controls what happens when a *regular* destination file
    already exists: when True (diagnostic seed) a bundle copy newer than the
    destination refreshes it; when False (one-time starter content) an existing
    file is always left as-is so the user's copy is never overwritten.

    Returns the number of ``sources`` that are present at their destination
    afterwards (freshly seeded, refreshed, or already current) — so callers can
    tell whether every pack made it. A skip (missing source, symlink/non-regular
    refusal, copy error) does not count.
    """
    # Refuse a symlinked seed directory: mkdir(exist_ok=True) would accept it
    # and copies would land at the link target, outside the DLC tree. The
    # per-file symlink guard below cannot catch this.
    if dest_dir.is_symlink():
        log.warning("%s: %s is a symlink, skipping all seeding", label, dest_dir.name)
        return 0
    dest_dir.mkdir(parents=True, exist_ok=True)

    # Pin the seed directory by an O_NOFOLLOW fd so a symlink swapped in for
    # dest_dir *after* the check above cannot redirect the per-file stat /
    # temp-create / replace outside the DLC tree (parent-directory TOCTOU).
    # os.replace accepts dir_fd on POSIX even though it isn't listed in
    # os.supports_dir_fd, so gate on os.rename (the reliable proxy); platforms
    # without dir_fd/O_NOFOLLOW (e.g. Windows) fall back to path-based ops.
    dir_fd = None
    if (
        hasattr(os, "O_NOFOLLOW")
        and hasattr(os, "O_DIRECTORY")
        and os.open in os.supports_dir_fd
        and os.rename in os.supports_dir_fd
    ):
        try:
            dir_fd = os.open(dest_dir, os.O_RDONLY | os.O_NOFOLLOW | os.O_DIRECTORY)
        except OSError as exc:
            log.warning("%s: cannot open seed dir %s: %s", label, dest_dir, exc)
            return 0

    try:
        present = 0
        for dest_name, rel_source in sources:
            source = root / rel_source
            if not source.is_file():
                log.warning("%s: source missing, skipping %s (%s)", label, dest_name, source)
                continue

            # lstat the destination without following symlinks. Pinned by dir_fd
            # this resolves within the real seed dir, immune to a parent swap.
            try:
                if dir_fd is not None:
                    dstat = os.lstat(dest_name, dir_fd=dir_fd)
                else:
                    dstat = os.lstat(dest_dir / dest_name)
                dest_exists = True
                dest_islink = stat.S_ISLNK(dstat.st_mode)
            except FileNotFoundError:
                dest_exists = False
                dest_islink = False
            except OSError as exc:
                log.warning("%s: cannot stat %s: %s", label, dest_name, exc)
                continue

            # Refuse to seed through a symlink at the destination name.
            if dest_islink:
                log.warning("%s: destination is a symlink, skipping %s", label, dest_name)
                continue

            # A non-regular destination (directory, fifo, …) the user placed
            # there: never clobber it, and never count it as present — otherwise
            # a one-time seed would mark itself done without a real pack on disk.
            if dest_exists and not stat.S_ISREG(dstat.st_mode):
                log.warning("%s: destination is not a regular file, skipping %s", label, dest_name)
                continue

            if dest_exists:
                # A regular file is already there. One-time seeds (starter
                # content) must never overwrite the user's copy; refreshing
                # seeds (diagnostics) replace it only when the bundle is newer.
                if not update_existing:
                    log.info("%s: already present %s", label, dest_name)
                    present += 1
                    continue
                try:
                    src_mtime = source.stat().st_mtime
                except OSError as exc:
                    log.warning("%s: cannot stat source %s: %s", label, source, exc)
                    continue
                if src_mtime <= dstat.st_mtime:
                    log.info("%s: already present %s", label, dest_name)
                    present += 1
                    continue
                action = "updated"
            else:
                action = "seeded"

            if _write_builtin_pack(source, dest_dir, dest_name, dir_fd):
                present += 1
                log.info("%s: %s %s -> %s", label, action, source.name, dest_name)
            else:
                log.warning("%s: failed to copy %s -> %s/%s", label, source, dest_dir.name, dest_name)

        return present
    finally:
        if dir_fd is not None:
            os.close(dir_fd)


def _write_builtin_pack(
    source: Path,
    dest_dir: Path,
    dest_name: str,
    dir_fd: int | None,
) -> bool:
    """Atomically write ``source`` to ``dest_name`` inside ``dest_dir``.

    Writes to a temp file then ``os.replace()``s onto the final name so a
    symlink raced in at the destination is overwritten (rename semantics), not
    followed, and a crash never leaves a half-written pack. When ``dir_fd`` is
    given, every step is anchored to that fd (O_NOFOLLOW temp create + dir_fd
    replace), closing the parent-directory TOCTOU; otherwise falls back to
    path-based temp+replace. Returns True on success. Never raises.
    """
    # Unique per-attempt name (O_EXCL create) so a crash that orphans a temp
    # can't permanently block later seeds via an EEXIST collision.
    tmp_name = f".seed-{dest_name}.{os.getpid()}.{secrets.token_hex(4)}.tmp"
    try:
        src_stat = source.stat()
    except OSError as exc:
        log.debug("builtin pack: cannot stat source %s: %s", source, exc)
        return False
    if dir_fd is not None:
        tmp_fd = None
        try:
            tmp_fd = os.open(
                tmp_name,
                os.O_CREAT | os.O_EXCL | os.O_WRONLY | os.O_NOFOLLOW,
                0o644,
                dir_fd=dir_fd,
            )
            with open(source, "rb") as sf, os.fdopen(tmp_fd, "wb") as tf:
                tmp_fd = None  # fdopen now owns the descriptor
                shutil.copyfileobj(sf, tf)
            os.replace(tmp_name, dest_name, src_dir_fd=dir_fd, dst_dir_fd=dir_fd)
            # Preserve the bundle mtime (copyfileobj doesn't) so the mtime-based
            # refresh check matches the shutil.copy2 fallback path. Best-effort.
            try:
                os.utime(
                    dest_name,
                    ns=(src_stat.st_atime_ns, src_stat.st_mtime_ns),
                    dir_fd=dir_fd,
                    follow_symlinks=False,
                )
            except OSError as exc:
                log.debug("builtin pack: could not set mtime on %s: %s", dest_name, exc)
            return True
        except OSError as exc:
            log.debug("builtin pack write (dir_fd) failed for %s: %s", dest_name, exc)
            if tmp_fd is not None:
                try:
                    os.close(tmp_fd)
                except OSError:
                    pass
            try:
                os.unlink(tmp_name, dir_fd=dir_fd)
            except OSError:
                pass
            return False

    tmp = None
    try:
        fd, tmp = tempfile.mkstemp(dir=dest_dir, prefix=".seed-", suffix=".tmp")
        os.close(fd)
        shutil.copy2(source, tmp)
        os.replace(tmp, dest_dir / dest_name)
        tmp = None
        return True
    except OSError as exc:
        log.debug("builtin pack write failed for %s: %s", dest_name, exc)
        return False
    finally:
        if tmp is not None:
            try:
                os.unlink(tmp)
            except OSError:
                pass


def seed_builtin_diagnostic_sloppaks(server_root: Path, dlc: Path | None = None) -> None:
    """Copy bundled diagnostic sloppaks into DLC before library scan.

    Creates ``DLC_DIR/diagnostics-builtin/`` and copies each bundled sloppak
    when the destination is missing or older than the repo/bundle source.
    Never deletes user files or touches manually copied paths (e.g.
    ``diagnostics-test/``). Re-seeds whenever the destination is missing so the
    diagnostic target is always available. Logs and continues on errors.
    """
    try:
        if dlc is None:
            dlc = _get_dlc_dir()
        if dlc is None:
            log.debug("Builtin diagnostic seed: no DLC folder configured, skipping")
            return
        _copy_builtin_packs(
            server_root,
            dlc / BUILTIN_DIAGNOSTIC_SUBDIR,
            BUILTIN_DIAGNOSTIC_SOURCES,
            "Builtin diagnostic seed",
        )
    except Exception:
        log.warning("Builtin diagnostic seed: unexpected error", exc_info=True)


# Starter content: bundled songs copied into ``DLC_DIR/starter/`` exactly ONCE,
# on first run, as a welcome library so a fresh install isn't empty. Unlike the
# diagnostic seed this is one-time — guarded by a marker in CONFIG_DIR — so if
# the user deletes the starter song it stays gone. ``starter/`` is NOT in the
# library scan carve-out (unlike diagnostics-builtin/ / tutorials-builtin/), so
# seeded packs surface as ordinary library songs.
BUILTIN_STARTER_SUBDIR = "starter"


BUILTIN_STARTER_SOURCES: list[tuple[str, str]] = [
    (
        "beethoven-fur_elise.feedpak",
        "content/starter/beethoven-fur_elise.feedpak",
    ),
    (
        "star_spangled_banner.feedpak",
        "content/starter/star_spangled_banner.feedpak",
    ),
    (
        "the_adicts-ode-to-joy_vst_cover.feedpak",
        "content/starter/the_adicts-ode-to-joy_vst_cover.feedpak",
    ),
]


STARTER_SEED_MARKER = ".starter-content-seeded"


def seed_builtin_starter_content(server_root: Path, dlc: Path | None = None) -> None:
    """Copy bundled starter songs into ``DLC_DIR/starter/`` exactly once.

    Guarded by ``CONFIG_DIR/.starter-content-seeded``: the first run with a DLC
    folder configured seeds the packs and writes the marker; subsequent runs are
    no-ops, so a user who deletes the starter song does not get it back on the
    next launch. Symlink-safe; never deletes user files. Logs, never raises.
    """
    try:
        marker = appstate.config_dir / STARTER_SEED_MARKER
        # Already seeded? The marker is a sentinel: any existing path there
        # (regular file, or a symlink/dir a user deliberately planted to opt
        # out) means "done" — lstat so we detect it without following a symlink.
        # Worst case of a planted marker is simply no starter content, never a
        # data write; the O_EXCL|O_NOFOLLOW create below refuses to write
        # *through* a symlink regardless.
        try:
            os.lstat(marker)
            return
        except FileNotFoundError:
            pass
        except OSError as exc:
            log.warning("Starter content seed: cannot stat marker %s: %s", marker, exc)
            return
        if dlc is None:
            dlc = _get_dlc_dir()
        if dlc is None:
            # No DLC yet — leave the marker unwritten so we retry once a
            # library folder is configured.
            log.debug("Starter content seed: no DLC folder configured, skipping")
            return
        present = _copy_builtin_packs(
            server_root,
            dlc / BUILTIN_STARTER_SUBDIR,
            BUILTIN_STARTER_SOURCES,
            "Starter content seed",
            update_existing=False,
        )
        # Only mark seeding complete once every starter pack is actually in
        # place. If a source was missing or a copy failed, leave the marker
        # unwritten so the next launch retries rather than permanently skipping.
        if present < len(BUILTIN_STARTER_SOURCES):
            log.info(
                "Starter content seed: %d/%d packs present, will retry next launch",
                present,
                len(BUILTIN_STARTER_SOURCES),
            )
            return
        # Record completion with an exclusive, no-follow create so a planted or
        # raced symlink at the marker path can't redirect the write outside
        # CONFIG_DIR. O_EXCL fails (EEXIST) on any existing path including a
        # symlink, so we never write through one.
        try:
            appstate.config_dir.mkdir(parents=True, exist_ok=True)
            flags = os.O_CREAT | os.O_EXCL | os.O_WRONLY | getattr(os, "O_NOFOLLOW", 0)
            fd = os.open(marker, flags, 0o644)
            try:
                os.write(fd, b"1\n")
            finally:
                os.close(fd)
        except FileExistsError:
            pass  # already marked (or a non-regular path is squatting) — fine
        except OSError as exc:
            log.warning("Starter content seed: could not write marker %s: %s", marker, exc)
    except Exception:
        log.warning("Starter content seed: unexpected error", exc_info=True)
