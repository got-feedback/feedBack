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
from tunings import (
    DEFAULT_PERSPECTIVE, PERSPECTIVES, ROLE_PERSPECTIVES, normalize_offsets,
    perspective_low_pitch, perspective_tuning_key, perspective_tuning_name,
    tuning_name,
)
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


def _apply_role_tunings(meta: dict) -> None:
    """Derive each ROLE perspective's tuning columns from the raw offsets the
    extractor emitted (currently bass + rhythm; guitar-lead reads the
    song-level columns the scanner has always written).

    The domain rules live in `tunings` (see the PERSPECTIVES table and the
    block above it for the evidence behind each):

    1. NORMALIZE FIRST. Stored bass arrays are commonly six elements whose
       last two slots are padding, so bass truncates to four strings before
       anything looks at them — padding must never reach the namer or the
       grouping key. Guitar does NOT truncate (a 7-string array is real).
    2. Refuse to name data the perspective distrusts (bass up-tuning), so the
       library can't send a player off to a tuning nobody plays.
    3. Group on CANONICAL PITCHES, not the raw offsets string — the same
       physical tuning serialized two ways must be ONE facet entry.

    A song with no arrangement in that role gets EMPTY strings / 0, not NULL:
    '' is the indexed "we looked, there is no such chart" state the library's
    fallback keys on, while NULL means "never extracted" and re-scans.
    """
    for persp in ROLE_PERSPECTIVES:
        raw = meta.pop(f"{persp.role}_tuning_offsets", None)
        offsets = normalize_offsets(raw, persp)
        if offsets is None:
            meta[persp.column("name")] = ""
            meta[persp.column("sort_key")] = 0
            meta[persp.column("offsets")] = ""
            meta[persp.column("key")] = ""
            meta[persp.column("low_pitch")] = None
            continue
        meta[persp.column("name")] = perspective_tuning_name(offsets, persp)
        meta[persp.column("sort_key")] = sum(offsets)
        # The NORMALIZED offsets are what we store: padding is not data, and a
        # client rendering target notes must not print phantom strings.
        meta[persp.column("offsets")] = " ".join(str(o) for o in offsets)
        meta[persp.column("key")] = perspective_tuning_key(offsets, persp)
        meta[persp.column("low_pitch")] = perspective_low_pitch(offsets, persp)


def _apply_song_low_pitch(meta: dict, offsets: list[int]) -> None:
    """Lowest open-string pitch of the SONG-level (guitar-lead) tuning, for
    the "playable without retuning" comparison. Indexed here, on the existing
    manifest-only pass — never by reopening chart JSON."""
    persp = PERSPECTIVES[DEFAULT_PERSPECTIVE]
    norm = normalize_offsets(offsets, persp)
    meta["tuning_low_pitch"] = (
        perspective_low_pitch(norm, persp) if norm is not None else None)


def _extract_meta_sloppak(path: Path) -> dict:
    """Extract metadata for a sloppak (file or directory)."""
    meta = sloppak_mod.extract_meta(path)
    offsets = meta.pop("tuning_offsets", None) or [0] * 6
    name = tuning_name(offsets)
    meta["tuning"] = name
    meta["tuning_name"] = name
    meta["tuning_sort_key"] = sum(offsets)
    meta["tuning_offsets"] = " ".join(str(o) for o in offsets)
    _apply_song_low_pitch(meta, offsets)
    _apply_role_tunings(meta)
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
    _apply_song_low_pitch(meta, offsets)
    _apply_role_tunings(meta)
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
