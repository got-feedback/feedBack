"""Regenerate ``static/tailwind.min.css`` over the full installed-plugin set.

Core's committed (and image-baked) stylesheet is built scanning only the
in-tree plugins. A plugin installed at runtime — into ``FEEDBACK_PLUGINS_DIR``
— ships Tailwind classes the sheet never saw, so it renders unstyled. The
Play CDN's runtime JIT that used to cover this was removed (feedBack#411),
so we rebuild the sheet ourselves with node + the pinned ``tailwindcss``,
scanning the baked-in plugins *and* the user plugins dir.

Best-effort: a logged no-op (returns ``False``) when the toolchain or inputs
are absent — e.g. a native dev run with no node, or a desktop bundle that
already baked a complete sheet — so plugin install / startup never hard-fails
on a missing optional engine.
"""

from __future__ import annotations

import json
import logging
import os
import shutil
import subprocess
import tempfile
import threading
from pathlib import Path

from env_compat import getenv_compat

log = logging.getLogger("feedBack.tailwind")

# Pin matches scripts/build-tailwind.sh and the Dockerfile build stage so every
# sheet — committed, image-baked, and runtime-regenerated — comes from the same
# Tailwind 3.x.
_TAILWIND_VERSION = "3.4.19"

# Serialize rebuilds: concurrent installs (or install racing the startup scan)
# must not run the CLI against the same output file at once.
_lock = threading.Lock()
# Set by a trigger that arrives while a rebuild is already running, so the
# in-flight build re-runs once more to pick up the newer plugin set instead of
# every concurrent trigger stacking its own redundant build.
_rerun = threading.Event()

# lib/ lives at ``<app>/lib``; the app root (static/, tailwind.config.js) is its
# grandparent.
APP_DIR = Path(__file__).resolve().parent.parent


def _user_plugins_dir() -> Path | None:
    raw = (getenv_compat("FEEDBACK_PLUGINS_DIR", "") or "").strip()
    if not raw:
        return None
    p = Path(raw)
    return p if p.is_dir() else None


def user_plugin_count() -> int:
    """Number of installed plugins in the runtime user plugins dir (0 if unset).

    Counts only directories that contain a ``plugin.json`` — so stray caches/tmp
    dirs (which have none) don't trigger rebuilds.
    """
    d = _user_plugins_dir()
    if not d:
        return 0
    return sum(1 for p in d.iterdir() if p.is_dir() and (p / "plugin.json").is_file())


def _tailwind_cmd() -> list[str] | None:
    """Prefer a globally-installed ``tailwindcss`` (offline, no fetch); fall back
    to ``npx`` which resolves/fetches the pinned version on demand."""
    exe = shutil.which("tailwindcss")
    if exe:
        return [exe]
    npx = shutil.which("npx")
    if npx:
        return [npx, "-y", f"tailwindcss@{_TAILWIND_VERSION}"]
    return None


def can_rebuild() -> bool:
    return (
        _tailwind_cmd() is not None
        and (APP_DIR / "tailwind.config.js").is_file()
        and (APP_DIR / "static" / "_tailwind.src.css").is_file()
    )


def _write_runtime_config(tmpdir: Path) -> Path:
    """Wrapper config that reuses the base theme/safelist/exclusions but widens
    ``content`` to absolute paths covering the user plugins dir as well."""
    base_cfg = APP_DIR / "tailwind.config.js"
    # Use forward-slash (POSIX) globs/paths: Tailwind's fast-glob matcher needs
    # forward slashes even on Windows, and node `require()` accepts them too.
    content = [
        (APP_DIR / "static" / "**" / "*.{html,js}").as_posix(),
        (APP_DIR / "plugins" / "**" / "*.{js,html}").as_posix(),
    ]
    user = _user_plugins_dir()
    if user:
        content.append((user / "**" / "*.{js,html}").as_posix())
        # Exclude a user-installed highway_3d too (it ships its own sheet).
        content.append("!" + (user / "highway_3d" / "**").as_posix())
    # highway_3d ships its own sheet via the `styles` capability — keep it out
    # of the core sheet, mirroring tailwind.config.js.
    content.append("!" + (APP_DIR / "plugins" / "highway_3d" / "**").as_posix())
    cfg = tmpdir / "tailwind.runtime.config.js"
    cfg_js = (
        "const base = require({base});\n"
        "base.content = {content};\n"
        "module.exports = base;\n"
    ).format(
        base=json.dumps(base_cfg.as_posix()),
        content=json.dumps(content),
    )
    cfg.write_text(cfg_js)
    return cfg


def _run_build(cmd_prefix: list[str], out: Path, src: Path) -> bool:
    """Run one Tailwind build over the current plugin set. Never raises."""
    with tempfile.TemporaryDirectory() as td:
        cfg = _write_runtime_config(Path(td))
        # Stage the output next to the live sheet so the final swap is an
        # atomic same-filesystem os.replace (a reader never sees a partial).
        staged = out.with_name(f".tailwind.min.css.{os.getpid()}.tmp")
        cmd = cmd_prefix + [
            "-c", str(cfg),
            "-i", str(src),
            "-o", str(staged),
            "--minify",
        ]
        try:
            subprocess.run(
                cmd, check=True, capture_output=True, text=True,
                cwd=str(APP_DIR), timeout=120,
            )
            os.replace(staged, out)
            return True
        except (subprocess.CalledProcessError, subprocess.TimeoutExpired) as e:
            stderr = (getattr(e, "stderr", "") or "")[-500:]
            log.warning("tailwind rebuild failed: %s", stderr)
            return False
        except Exception:
            log.exception("tailwind rebuild errored")
            return False
        finally:
            if staged.exists():
                try:
                    staged.unlink()
                except OSError:
                    pass


def rebuild(reason: str = "") -> bool:
    """Regenerate ``static/tailwind.min.css`` over baked-in + user plugins.

    Returns ``True`` on a successful rebuild, ``False`` on any skip/failure.
    Never raises — callers treat CSS freshness as best-effort. Concurrent
    triggers are coalesced: only one build runs at a time, and triggers that
    arrive mid-build cause a single extra rerun rather than stacking builds.
    """
    tag = f" [{reason}]" if reason else ""
    cmd_prefix = _tailwind_cmd()
    if cmd_prefix is None or not can_rebuild():
        log.info("tailwind rebuild skipped — engine/inputs unavailable%s", tag)
        return False

    out = APP_DIR / "static" / "tailwind.min.css"
    src = APP_DIR / "static" / "_tailwind.src.css"

    # If a rebuild is already running, flag a rerun and return instead of
    # queueing a redundant build behind it.
    if not _lock.acquire(blocking=False):
        _rerun.set()
        log.info("tailwind rebuild already running — coalesced%s", tag)
        return False

    ok = False
    try:
        while True:
            _rerun.clear()
            ok = _run_build(cmd_prefix, out, src)
            # A trigger arrived while we were building — run once more to pick
            # up the newer plugin set, then stop.
            if not _rerun.is_set():
                break
    finally:
        _lock.release()

    if not ok:
        return False

    # Guard the stat so the "never raises" contract holds even if the freshly
    # written sheet is somehow not stat-able (odd FS / external cleanup).
    try:
        size = out.stat().st_size
    except OSError:
        size = -1
    log.info("tailwind rebuilt over installed plugins%s (%d bytes)", tag, size)
    return True
