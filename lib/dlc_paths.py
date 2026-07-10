"""DLC library path resolution — where the song files live, plus safe containment.

Extracted from ``server.py`` (R3). ``_resolve_dlc_path`` is pure and moved
verbatim. ``_get_dlc_dir`` reads the env-derived paths through the ``appstate``
seam (``server.py`` configures ``dlc_dir``/``dlc_dir_env``/``config_dir`` at
import, fresh on every re-import), so this module does no import-time IO and the
pop-and-reimport fixtures keep working. ``server.py`` re-exports both names, so
existing ``server._get_dlc_dir`` / ``server._resolve_dlc_path`` references
(tests, other handlers) resolve unchanged.
"""

import json
import os
from pathlib import Path

import appstate


def _get_dlc_dir(cfg: dict | None = None) -> Path | None:
    # Only consider DLC_DIR if the env var was non-empty. `Path("")` collapses
    # to `.` and reports `.is_dir() == True`, which would silently shadow the
    # config.json fallback. Checking the raw env string preserves
    # `DLC_DIR=.` as a valid opt-in for cwd while keeping unset/empty out.
    if appstate.dlc_dir_env and appstate.dlc_dir.is_dir():
        return appstate.dlc_dir
    if cfg is None:
        config_file = appstate.config_dir / "config.json"
        if config_file.exists():
            try:
                cfg = json.loads(config_file.read_text(encoding="utf-8"))
            except Exception:
                pass
    if isinstance(cfg, dict):
        raw = str(cfg.get("dlc_dir", "")).strip()
        if raw:
            p = Path(raw)
            if p.is_dir():
                return p
    return None


def _resolve_dlc_path(dlc: Path, filename: str) -> Path | None:
    """Resolve `filename` under DLC_DIR and refuse anything that escapes.

    `filename` arrives from `:path` route params and can contain `..`
    segments. The Sloppak and archive paths happen to fail safely later
    because their loaders raise on missing/invalid files, but loose-
    folder format detection (`is_loose_song`) globs and parses XML on
    disk first, which lets a crafted path trigger filesystem reads
    outside DLC_DIR before any guard fires. Centralise the containment
    check so every filename-bound handler validates before touching the
    filesystem.

    Containment here is LEXICAL (normalize `.`/`..` WITHOUT following
    symlinks), not `safe_join`'s `.resolve()`-based check — because users
    commonly mount their song library through a directory JUNCTION/symlink
    (a library shared across app installs; the desktop app's own mounts).
    `.resolve()` follows that junction to its real target, sees it sits
    outside DLC_DIR, and wrongly rejects every song reached through it — the
    scanner's `rglob` indexes those songs, but art/load then 403/404s (broken
    covers, unplayable songs). Lexical normalization still rejects the only
    escapes a `:path` filename can express — `..` traversal and absolute
    paths — which the traversal tests pin. `safe_join` stays strict (it is
    the zip-slip / plugin-asset guard, where following a symlink out IS the
    defense); the loose-folder art handler keeps its own per-file symlink
    re-check for defence-in-depth.

    Returns the validated Path (not necessarily link-resolved), or None if
    the filename is empty, contains a NUL, or escapes the DLC root.
    """
    if not filename:
        return None
    # Backslashes → forward slashes so a Windows-style `..\\x` traversal is
    # rejected identically on POSIX (mirrors safe_join's normalisation).
    safe = filename.replace("\\", "/")
    if "\x00" in safe:
        return None
    # Reject drive-letter / absolute paths in BOTH conventions. A POSIX "/x" is
    # caught by the containment check below (the `/` operator discards `root`),
    # but a Windows drive-absolute "C:/x" is treated as a relative "C:" dir on
    # POSIX and would otherwise slip in as `<root>/C:/x` — so the contract must
    # hold cross-platform (a shared library is reached from either OS).
    from pathlib import PurePosixPath, PureWindowsPath
    if (PurePosixPath(safe).is_absolute()
            or PureWindowsPath(safe).is_absolute()
            or PureWindowsPath(safe).drive):
        return None
    try:
        root = dlc.resolve()
        # normpath collapses `.`/`..`/duplicate separators purely lexically —
        # it never touches the filesystem, so an in-library junction component
        # is preserved (allowed) while `..`/absolute segments still escape and
        # get caught by the containment check below.
        candidate = Path(os.path.normpath(root / safe))
        if not candidate.is_relative_to(root):
            return None
    except (ValueError, OSError):
        return None
    return candidate
