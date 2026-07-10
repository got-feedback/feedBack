"""Side-effect-free metadata extraction worker for the library scan.

This module is deliberately kept apart from ``server.py`` so that
``ProcessPoolExecutor`` workers can import and unpickle ``_scan_one``
without dragging in ``server.py``'s import-time side effects
(``configure_logging()``, ``meta_db = MetadataDB(CONFIG_DIR)`` opening/migrating
SQLite, and ``register_plugin_api(app)`` registering routes).

The background scan spawns its pool with the ``spawn`` start method (see
``server._background_scan``), so each worker is a fresh interpreter that
imports only this module plus the pure ``lib`` helpers below — never the
whole server. That avoids two problems flagged in review:

* forking a ``ProcessPoolExecutor`` from the non-main scan thread (the
  default on Linux), which can deadlock on locks held by other threads at
  fork time; and
* re-running ``server.py``'s side effects in every worker on ``spawn``
  platforms (macOS/Windows), which would reopen SQLite per worker and let
  a multi-process ``RotatingFileHandler`` corrupt the log file.

It also means the per-file ``log.debug`` below simply no-ops inside
workers (logging is unconfigured there), which is the desired behaviour —
worker log records never reach the shared log file.
"""

import logging
from pathlib import Path

from song import compute_smart_names
from tunings import tuning_name
import sloppak as sloppak_mod
import loosefolder as loosefolder_mod

log = logging.getLogger("feedBack.scan_worker")


def _relpath(f: Path, dlc: Path) -> str:
    # Store the path relative to the DLC root so sub-folders (e.g.
    # dlc/sloppak/foo.sloppak) resolve back correctly later.
    try:
        return f.relative_to(dlc).as_posix()
    except ValueError:
        return f.name


def _extract_meta_sloppak(path: Path) -> dict:
    """Extract metadata for a sloppak (file or directory)."""
    meta = sloppak_mod.extract_meta(path)
    offsets = meta.pop("tuning_offsets", None) or [0] * 6
    name = tuning_name(offsets)
    meta["tuning"] = name
    meta["tuning_name"] = name
    meta["tuning_sort_key"] = sum(offsets)
    meta["tuning_offsets"] = " ".join(str(o) for o in offsets)
    meta["format"] = "sloppak"
    # `extract_meta` already populates `stem_ids` (feedBack#129);
    # default to empty for older callers / mocks.
    meta.setdefault("stem_ids", [])
    # Compute smart names for sloppak arrangements using name-based fallback
    # (sloppak manifests use display names like "Lead"/"Rhythm"/"Bass" directly).
    arrs = meta.get("arrangements") or []
    if arrs:
        from song import Arrangement as _ArrCls
        _arr_objs = [_ArrCls(name=a.get("name", "")) for a in arrs]
        _smart = compute_smart_names(_arr_objs)
        for a, sn in zip(arrs, _smart):
            a["smart_name"] = sn
    return meta


def _extract_meta_loosefolder(path: Path, dlc_root: Path | None) -> dict:
    """Extract metadata for a loose song folder (raw XMLs + WEM audio).

    `dlc_root` is passed in (rather than resolved here via the server's
    `_get_dlc_dir()`) so this module stays free of server.py state and is
    safe to import in spawned ProcessPool workers.
    """
    # Pass the DLC root so artist/album folder inference operates on the
    # dlc-relative path; otherwise absolute-path parts (e.g. the user's
    # home dir name) would leak into metadata for songs placed shallow
    # inside DLC_DIR.
    meta = loosefolder_mod.extract_meta(path, dlc_root=dlc_root)
    offsets = meta.pop("tuning_offsets", None) or [0] * 6
    name = tuning_name(offsets)
    meta["tuning"] = name
    meta["tuning_name"] = name
    meta["tuning_sort_key"] = sum(offsets)
    meta["tuning_offsets"] = " ".join(str(o) for o in offsets)
    meta["format"] = "loose"
    meta.setdefault("stem_ids", [])
    # The library helper exposes absolute filesystem paths for audio/art
    # so callers inside the server can resolve them. Strip these before
    # the meta enters the API/DB cache — `/api/song/{filename}` returns
    # the dict directly on a cache miss, which would otherwise leak
    # `/home/<user>/...` paths to the frontend.
    meta.pop("audio_path", None)
    meta.pop("art_path", None)
    return meta


def _extract_meta_for_file(path: Path, dlc_root=None) -> dict:
    """Extract metadata — dispatches on shape: sloppak or loose-folder song.

    `dlc_root` is only consulted for loose-folder songs (for dlc-relative
    artist/album inference). It may be a `Path`, `None`, or a zero-arg
    callable returning `Path | None`; the callable is invoked lazily, only
    on the loose-folder branch, so sloppak extraction never triggers a
    (potentially disk-reading) DLC-root lookup. The background scan passes
    the root it already resolved; in-process callers can pass the resolver
    itself (e.g. `_get_dlc_dir`) to keep the lookup lazy.

    FeedBack reads only its own song-package format (`.feedpak` / legacy
    `.sloppak`) and loose-folder XML songs. Encrypted/proprietary archive
    formats are not supported and are silently ignored (empty metadata)
    rather than decrypted.
    """
    # Packages are detected by suffix only (`.feedpak`/`.sloppak`, cheap), so
    # check that first — that way a user's loose folder named `foo.feedpak`
    # still wins the package branch instead of being misclassified.
    if sloppak_mod.is_sloppak(path):
        return _extract_meta_sloppak(path)
    if loosefolder_mod.is_loose_song(path):
        root = dlc_root() if callable(dlc_root) else dlc_root
        return _extract_meta_loosefolder(path, root)
    # Unknown/unsupported shape — return empty metadata. FeedBack never
    # reads encrypted archive formats.
    return {
        "title": "", "artist": "", "album": "", "year": "",
        "duration": 0.0, "tuning": "E Standard",
        "arrangements": [], "has_lyrics": False,
        "stem_ids": [],
        "tuning_name": "E Standard",
        "tuning_sort_key": 0,
        "tuning_offsets": "0 0 0 0 0 0",
    }


def _scan_one(item):
    """Process-pool worker: extract metadata for one library item.

    Top-level (and in this side-effect-free module) so ProcessPoolExecutor
    can pickle it by reference and the spawned worker can import it without
    pulling in server.py. `dlc` travels through the tuple rather than being
    captured from a closure so it survives pickling.
    """
    f, mtime, size, dlc = item
    log.debug("scanning %s", f.name)
    meta = _extract_meta_for_file(f, dlc)
    return _relpath(f, dlc), mtime, size, meta
