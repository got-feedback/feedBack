"""Sloppak — open song format loader.

A `.sloppak` is an open, hand-editable song package. It exists in two
interchangeable forms:

1. **Zip archive** — a `.sloppak` file containing a `manifest.yaml`,
   arrangement JSONs, stem OGGs, optional cover/lyrics. Distribution form.
2. **Directory** — a directory whose name ends in `.sloppak/` containing the
   same files. Authoring form.

See the format spec in the project's sloppak plan for the full layout.
"""

from __future__ import annotations

import logging
import math
import os
import shutil
import threading
import zipfile
from dataclasses import dataclass, field
from pathlib import Path

log = logging.getLogger("feedBack.lib.sloppak")

# The feedpak format version this build targets / writes (manifest
# `feedpak_version`, a semver string per spec §4). Readers tolerate any version
# (additive/MINOR compatibility); writers stamp this.
FEEDPAK_VERSION = "1.2.0"

# Package suffixes. The format is byte-identical regardless of suffix; `.feedpak`
# is the current write extension, `.sloppak` the legacy one we still read.
FEEDPAK_EXT = ".feedpak"
SLOPPAK_EXT = ".sloppak"
SONG_EXTS = (FEEDPAK_EXT, SLOPPAK_EXT)  # accepted on read/discovery

# ── The full mix ──────────────────────────────────────────────────────────────
#
# Spec §5.3 RESERVES the stem id `full` for the song's complete mixdown: the
# whole song in one file, as heard before source separation. It is a stem — it
# lives in `stems` like every other audio file in a pack — but it is a *mixdown,
# not a layer*. A reader that sums stems must never include it in the sum: it
# already contains every instrument, so summing it doubles the whole song and
# muting `guitar` still leaves guitar audible inside it.
#
# Keeping it matters because separation is lossy: re-summing guitar+bass+drums+
# vocals does NOT reproduce the file they came from. The mixdown is the only
# faithful rendering of the song a pack can carry, so we play it whenever every
# stem sits at unity and nothing is muted.
FULL_MIX_STEM_ID = "full"

import yaml

from jsonc import load_json
from safepath import safe_join
from song import (
    Song,
    Beat,
    Section,
    Arrangement,
    arrangement_from_wire,
    _finite_float,
    sanitize_tempos,
)
import drums as drums_mod
import notation as notation_mod


def find_full_mix(stems: list[dict]) -> dict | None:
    """The RESERVED `full` stem (spec §5.3) — the pack's complete mixdown — or None.

    Answers "what is this pack's master audio", which is what fingerprinting
    wants. For playback use partition_stems() instead: a pack whose *only* stem
    is `full` has no mixdown to play *separately from* its stems, and this
    function still returns it.
    """
    return next(
        (s for s in stems if str(s.get("id", "")) == FULL_MIX_STEM_ID), None
    )


def stem_default_on(raw) -> bool:
    """Whether a manifest stem entry plays by default.

    Absent means on. A string is honoured so a hand-written manifest can say
    `default: off`. Extracted so the WS `ready` payload and the REST song-info
    payload cannot drift: the stems plugin now preloads from REST and then has
    to agree with what the WS says a moment later, or it would rebuild the whole
    graph for nothing.
    """
    if isinstance(raw, str):
        return raw.lower() not in ("off", "false", "0", "no")
    return bool(raw)


def partition_stems(stems: list[dict]) -> tuple[dict | None, list[dict]]:
    """Split stem descriptors into (mixdown, instrument_stems) for PLAYBACK.

    The mixdown is lifted OUT of the stem list because every consumer of `stems`
    treats that list as layers to sum or to show as mixer channels, and `full` is
    neither (spec §5.3). Leaving it in is precisely the bug that made the packer
    invent `original_audio` in the first place: a listed full mix plays on top of
    the stems.

    A pack whose only stem is `full` is a single-mix pack, not a separated one:
    there are no instruments to be pristine *against*, so `full` stays the sole
    playable stem and no mixdown is surfaced. That keeps the freshly-converted
    single-stem pack — much the most common shape — behaving exactly as before.

    EVERY entry with the reserved id is removed, not just the one we surface. A
    malformed pack that lists `full` twice would otherwise leave a copy of the
    whole song behind in the stem list, to be summed with the instruments — the
    precise failure this function exists to prevent, reintroduced by a duplicate.
    """
    if len(stems) < 2:
        return None, stems
    full = find_full_mix(stems)
    if full is None:
        return None, stems
    return full, [s for s in stems if str(s.get("id", "")) != FULL_MIX_STEM_ID]


def _legacy_full_mix(manifest: dict, source_dir: Path) -> str | None:
    """Full mix from the DEPRECATED `original_audio:` manifest key, or None.

    Before feedpak 1.15.0 reserved `full`, §5.3 said the mixdown was "commonly
    replaced" by the per-instrument stems on splitting — so it had nowhere to
    live, and this repo invented a top-level key pointing at a parallel
    `original/` directory (#583) to hold it. That key was never in the spec, and
    #933 removed our dependence on it: the mixdown is a stem.

    We still READ it, because every pack written before the spec caught up
    carries `original_audio: original/full.ogg` and would otherwise lose its full
    mix. We never write it. Delete this once those packs are migrated (#945);
    `tools/migrate_full_mix_stem.py` is the migration.

    NOTE the string literal below. tools/check_spec_conformance.py AST-scans for
    `manifest.get("<literal>")` to prove every manifest key core reads is one the
    spec declares. Hoisting "original_audio" into a named constant would hide
    this read from that scan — the gate would conclude core no longer touches the
    key, and the grandfather entry that documents this debt would go stale. The
    literal is what keeps the deprecation honest and visible to CI. Leave it.

    Same permissive, path-traversal-guarded posture as the optional side-files: a
    missing / escaping / unreadable file leaves the pack without a full mix (the
    player falls back to the separated stems) rather than aborting the load.
    Returns the manifest-relative string, so callers build its URL exactly as
    they build a stem's.
    """
    rel_raw = manifest.get("original_audio")
    if not isinstance(rel_raw, str) or not rel_raw.strip():
        return None
    rel = rel_raw.strip()
    try:
        target = (source_dir / rel).resolve()
        target.relative_to(source_dir.resolve())
    except ValueError:
        log.warning("sloppak: original_audio path %r escapes source_dir — skipped", rel)
        return None
    except OSError as e:
        log.warning("sloppak: original_audio path resolution failed (%s) — skipped", e)
        return None
    if not target.is_file():
        return None
    log.info(
        "sloppak: pack uses the deprecated `original_audio:` key (%r) — the full mix "
        "is a stem (id `full`, feedpak spec §5.3). Re-pack with "
        "tools/migrate_full_mix_stem.py; support for this key will be removed.",
        rel,
    )
    return rel


# ── Format detection ──────────────────────────────────────────────────────────

def is_sloppak(path: Path) -> bool:
    """True if path looks like a song package (zip file or directory).

    Accepts both the current `.feedpak` suffix and the legacy `.sloppak` one —
    same on-disk format, either form.
    """
    return path.name.lower().endswith(SONG_EXTS)


# ── Source resolution (zip unpack cache + directory passthrough) ──────────────

# Maps sloppak filename (relative to DLC_DIR) → (source_dir, mtime, size).
# For directory-form sloppaks, source_dir is the original path and we only
# track it so serving can locate it by filename.
# For zipped sloppaks, source_dir is a cache dir under the unpack root.
_source_cache: dict[str, tuple[Path, float, int]] = {}
_source_lock = threading.Lock()

# Full-archive unpacks (zip form) are expensive — they write every stem to
# disk. Cap how many run at once so a burst (e.g. many plays queued, or a stray
# caller looping the library) can't saturate disk/CPU, and serialize per-file so
# two callers never rmtree + re-extract the same dest simultaneously (which
# would corrupt the half-written dir the other is reading).
_UNPACK_MAX_CONCURRENCY = 2
_unpack_semaphore = threading.BoundedSemaphore(_UNPACK_MAX_CONCURRENCY)
_unpack_locks: dict[str, threading.Lock] = {}
_unpack_locks_guard = threading.Lock()

# Destinations with an unpack in flight right now. Eviction MUST skip these: two
# unpacks run concurrently, so one finishing could otherwise rmtree the other's
# half-written directory and leave that resolver caching an incomplete song.
_unpacking: set[Path] = set()
_unpacking_guard = threading.Lock()

# Cap the unpack cache. Stems are already-compressed audio, so an unpacked song
# is ~1.1x its zip — the cache is effectively a second, DECOMPRESSED copy of
# every song it holds, and it used to grow without any bound at all. A tester
# reached 60 GB from a 1800-song library: their whole library, unpacked, because
# one caller looped the library calling load_song(). Nothing ever deleted any of
# it — not even when the song itself was deleted.
#
# Default 4 GB ≈ 130 average songs of recency, which is far more than the "the
# song I'm playing, and the last few I played" that this cache actually exists
# to serve. Override with FEEDBACK_SLOPPAK_CACHE_MAX_MB (0 disables eviction).
def _unpack_cache_cap_bytes() -> int:
    raw = os.environ.get("FEEDBACK_SLOPPAK_CACHE_MAX_MB", "").strip()
    try:
        mb = int(raw) if raw else 4096
    except ValueError:
        mb = 4096
    return max(0, mb) * 1024 * 1024


def _dir_size(path: Path) -> int:
    total = 0
    for f in path.rglob("*"):
        try:
            if f.is_file():
                total += f.stat().st_size
        except OSError:
            continue
    return total


def _touch(path: Path) -> None:
    """Bump mtime so the LRU sweep below treats this song as recently used.

    Reading files out of an unpacked dir doesn't change the DIRECTORY's mtime,
    so without this the song you are actively playing looks as stale as one you
    unpacked days ago — and a burst of unpacks could evict it mid-song.
    """
    try:
        os.utime(path, None)
    except OSError:
        pass


def _evict_unpack_cache(root: Path, keep: Path | None = None) -> None:
    """Bound the unpack cache: drop least-recently-used songs until under the cap.

    `keep` is never evicted — it's the song the caller just resolved, i.e. almost
    certainly the one about to be played.

    Evicting a directory MUST also drop its `_source_cache` entry. Otherwise
    get_cached_source_dir() keeps handing out a path that no longer exists and
    the media route 404s on every stem instead of re-unpacking (it only falls
    back to resolve_source_dir when the cache returns None).
    """
    cap = _unpack_cache_cap_bytes()
    if cap <= 0:
        return
    try:
        entries = []
        total = 0
        for d in root.iterdir():
            if not d.is_dir():
                continue
            try:
                size = _dir_size(d)
                mtime = d.stat().st_mtime
            except OSError:
                continue
            entries.append((mtime, size, d))
            total += size
        if total <= cap:
            return

        keep_resolved = keep.resolve() if keep else None
        entries.sort(key=lambda e: e[0])          # oldest first
        for _mtime, size, d in entries:
            if total <= cap:
                break
            try:
                if keep_resolved and d.resolve() == keep_resolved:
                    continue
            except OSError:
                continue
            # Check-and-delete under ONE hold of the guard. Releasing between the
            # two would let a resolver mark this dest in-flight and start writing
            # into it in the gap, and we'd rmtree a song mid-unpack. A resolver
            # that blocks here simply proceeds afterwards — _unpack_zip recreates
            # the directory anyway.
            with _unpacking_guard:
                if d in _unpacking:
                    continue                      # another thread is writing this
                shutil.rmtree(d, ignore_errors=True)
            if d.exists():
                continue                          # couldn't remove — don't claim the bytes back
            total -= size
            with _source_lock:
                for fn, (cached_dir, _m, _s) in list(_source_cache.items()):
                    if cached_dir == d:
                        _source_cache.pop(fn, None)
            log.info("sloppak: evicted %s from the unpack cache (%.0f MB)",
                     d.name, size / 1e6)
    except OSError:
        log.warning("sloppak: unpack-cache eviction failed", exc_info=True)


def _unpack_lock_for(filename: str) -> threading.Lock:
    """Return a stable per-file lock so concurrent unpacks of the same sloppak
    serialize instead of racing on the same destination dir."""
    with _unpack_locks_guard:
        lk = _unpack_locks.get(filename)
        if lk is None:
            lk = threading.Lock()
            _unpack_locks[filename] = lk
        return lk


def _unpack_zip(zip_path: Path, dest: Path) -> None:
    """Extract a sloppak zip archive into dest, replacing any previous contents.

    Members whose names escape ``dest`` via ``..`` segments, absolute paths, or
    Windows-style separators are skipped with a warning so a crafted sloppak
    can't write outside the unpack cache (zip-slip).
    """
    if dest.exists():
        shutil.rmtree(dest, ignore_errors=True)
    dest.mkdir(parents=True, exist_ok=True)
    dest_resolved = dest.resolve()
    with zipfile.ZipFile(str(zip_path), "r") as zf:
        for member in zf.infolist():
            target = safe_join(dest_resolved, member.filename)
            if target is None:
                log.warning("sloppak: rejected unsafe zip member %r", member.filename)
                continue
            # A contained-but-degenerate name (e.g. "." or "subdir/..") would
            # resolve back to the unpack root itself; opening that path for
            # write is meaningless and would mask a real bug, so skip it.
            if target == dest_resolved:
                log.warning("sloppak: rejected zip member resolving to unpack root %r", member.filename)
                continue
            try:
                if member.is_dir():
                    target.mkdir(parents=True, exist_ok=True)
                    continue
                target.parent.mkdir(parents=True, exist_ok=True)
                with zf.open(member) as src, open(target, "wb") as dst:
                    shutil.copyfileobj(src, dst)
            except (OSError, zipfile.BadZipFile, RuntimeError, NotImplementedError) as e:
                log.warning("sloppak: failed to extract zip member %r: %s", member.filename, e)
                continue


def _safe_id(filename: str) -> str:
    """Turn a filename into a filesystem-safe cache key (no path separators)."""
    return filename.replace("/", "__").replace("\\", "__").replace(" ", "_")


def resolve_source_dir(
    filename: str,
    dlc_root: Path,
    unpack_cache_root: Path,
) -> Path:
    """Return the on-disk directory containing a sloppak's files.

    - Directory-form: returns the sloppak dir itself (no copy).
    - Zip-form:       unpacks to ``unpack_cache_root/{id}/`` on first use,
                      re-unpacks if mtime/size changed, then returns that dir.

    Caches the resolution so subsequent calls are ~free.

    NOTE: this writes the WHOLE pack — every stem — to disk. Only call it for a
    song you are about to play. To read a *part* of a song (an arrangement, the
    lyrics, a tone blob), use read_member_bytes(): unpacking a pack to read a few
    KB of JSON is ~45x write amplification, and doing it in a loop over the
    library fills the disk with a decompressed copy of every song.
    """
    path = dlc_root / filename
    stat = path.stat()
    mtime, size = stat.st_mtime, stat.st_size
    guarded: Path | None = None   # a dir WE unpacked, shielded from eviction

    with _source_lock:
        cached = _source_cache.get(filename)
        if cached:
            cached_dir, cached_mtime, cached_size = cached
            if (
                cached_mtime == mtime
                and cached_size == size
                and cached_dir.exists()
            ):
                # Mark it recently-used before returning — see _touch().
                if cached_dir != path:
                    _touch(cached_dir)
                return cached_dir

    try:
        if path.is_dir():
            resolved = path
        else:
            # Zip form — unpack to the cache. Serialize per-file (so concurrent
            # callers don't rmtree + re-extract the same dest at once) and cap
            # global unpack concurrency (so a burst can't saturate disk/CPU).
            dest = unpack_cache_root / _safe_id(filename)
            with _unpack_lock_for(filename):
                # Re-check the cache inside the per-file lock — a prior holder may
                # have just finished unpacking this exact (mtime, size).
                with _source_lock:
                    cached = _source_cache.get(filename)
                if (
                    cached
                    and cached[1] == mtime
                    and cached[2] == size
                    and cached[0].exists()
                ):
                    resolved = cached[0]
                else:
                    # Shield `dest` from eviction from the moment we start writing
                    # until it is safely in _source_cache. `keep` only shields it
                    # from OUR OWN sweep — a concurrent resolver sweeping with a
                    # different `keep` would delete it, and we would then cache and
                    # return a path that no longer exists. The `finally` below
                    # releases it on EVERY exit, including a failed unpack: leaving
                    # a dest marked in-flight would make it un-evictable forever.
                    with _unpacking_guard:
                        _unpacking.add(dest)
                    guarded = dest
                    with _unpack_semaphore:
                        _unpack_zip(path, dest)
                    resolved = dest
                    # The only moment this cache grows. Sweep here rather than on a
                    # timer so it can never drift far past the cap.
                    _evict_unpack_cache(unpack_cache_root, keep=dest)

        with _source_lock:
            _source_cache[filename] = (resolved, mtime, size)
        return resolved
    finally:
        if guarded is not None:
            with _unpacking_guard:
                _unpacking.discard(guarded)


def get_cached_source_dir(filename: str) -> Path | None:
    """Return the cached source dir for a sloppak if one is known AND still there.

    The existence check is load-bearing: callers (media.py) only fall back to
    resolve_source_dir() when this returns None, so handing back a path that has
    been evicted — or that the user deleted by hand to reclaim disk — would 404
    every stem for the rest of the process instead of re-unpacking.
    """
    with _source_lock:
        cached = _source_cache.get(filename)
        if not cached:
            return None
        src = cached[0]
        if not src.is_dir():
            _source_cache.pop(filename, None)
            return None
        _touch(src)
        return src


# ── Manifest + song loading ───────────────────────────────────────────────────

def _read_manifest(source_dir: Path) -> dict:
    mf = source_dir / "manifest.yaml"
    if not mf.exists():
        mf = source_dir / "manifest.yml"
    if not mf.exists():
        raise FileNotFoundError(f"manifest.yaml not found in {source_dir}")
    with mf.open("r", encoding="utf-8") as fh:
        data = yaml.safe_load(fh)
    if not isinstance(data, dict):
        raise ValueError("manifest.yaml must contain a mapping at the top level")
    return data


def _read_manifest_from_zip(zip_path: Path) -> dict:
    """Read just manifest.yaml from a zipped sloppak without unpacking stems."""
    with zipfile.ZipFile(str(zip_path), "r") as zf:
        for name in ("manifest.yaml", "manifest.yml"):
            try:
                with zf.open(name) as fh:
                    data = yaml.safe_load(fh.read().decode("utf-8"))
                    if isinstance(data, dict):
                        return data
            except KeyError:
                continue
    raise FileNotFoundError(f"manifest.yaml not found in zip {zip_path}")


def load_manifest(path: Path) -> dict:
    """Return the parsed manifest dict for a sloppak (dir or zip)."""
    if path.is_dir():
        return _read_manifest(path)
    return _read_manifest_from_zip(path)


_ZIP_ROOT = Path("/_root").resolve()


def _zip_member_key(name: str) -> str | None:
    """Canonical lookup key for a zip member name, or None if it escapes the root.

    Collapses './', 'a/../b' and backslash separators — the same normalization
    _unpack_zip()/safe_join() apply when extracting. Both the name the caller asks
    for AND the names the archive actually stores must go through this, or a pack
    that stores './arrangements/lead.json' unpacks fine but reads back as missing.
    """
    safe = safe_join(_ZIP_ROOT, name or "")
    # None → escapes the root; == root → a degenerate name like "." or "a/..".
    if safe is None or safe == _ZIP_ROOT:
        return None
    return safe.relative_to(_ZIP_ROOT).as_posix()


def read_member_bytes(path: Path, rel: str) -> bytes | None:
    """Return the bytes of ONE file inside a sloppak, or None if it isn't there.

    For a zipped sloppak this opens that single member instead of unpacking the
    archive — the same trick read_cover_bytes() uses to keep the library grid
    from exploding every pack just to show a cover.

    Reach for this whenever you want a *part* of a song (an arrangement's JSON,
    the lyrics, a tone blob) rather than a song you're about to play. The
    alternative, load_song(), calls resolve_source_dir() and writes the WHOLE
    pack — every stem — into the unpack cache. That is a ~45x write amplification
    when all you wanted was a few KB of JSON, and looping the library on it
    unpacks the entire library (got-feedBack/feedBack: a tester hit 60 GB that
    way). Stems are already-compressed audio, so an unpacked song is ~1.1x its
    zip: the cache becomes a second, decompressed copy of everything it touches.
    """
    rel = (rel or "").strip()
    if not rel:
        return None

    if path.is_dir():
        target = safe_join(path.resolve(), rel)
        if target is None or not target.is_file():
            return None
        try:
            return target.read_bytes()
        except OSError:
            return None

    # Zip form — read just that member, no unpack. Zip-slip is rejected before we
    # open anything, and both sides of the comparison are normalized, so a
    # non-canonical-but-valid name ('./arrangements/lead.json') resolves the same
    # way it did when we unpacked first.
    member = _zip_member_key(rel)
    if member is None:
        log.warning("sloppak: rejected unsafe member name %r in %r", rel, path)
        return None
    try:
        with zipfile.ZipFile(str(path), "r") as zf:
            # Match on the NORMALIZED stored name, and take the LAST match — the
            # archive may store './x' or a backslash path (Windows tooling), and
            # if it stores two names that normalize to the same file, _unpack_zip
            # writes them in order so the last one wins. Reading the raw member by
            # exact name would miss the first case and return the wrong bytes in
            # the second. A pack has a handful of members; the scan is free.
            info = None
            for cand in zf.infolist():
                if _zip_member_key(cand.filename) == member:
                    info = cand
            if info is None or info.is_dir():
                return None
            with zf.open(info) as f:
                return f.read()
    except (zipfile.BadZipFile, OSError, RuntimeError) as e:
        log.warning("sloppak: failed to read %r from %s: %s", rel, path.name, e)
        return None


_COVER_MEDIA_TYPES = {
    ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
    ".png": "image/png", ".webp": "image/webp",
}


def _cover_media_type(name: str) -> str:
    return _COVER_MEDIA_TYPES.get(Path(name).suffix.lower(), "image/jpeg")


def read_cover_bytes(
    path: Path, manifest: dict | None = None
) -> tuple[bytes, str] | None:
    """Return ``(image_bytes, media_type)`` for a sloppak's cover, or ``None``.

    Reads ONLY the cover image. For a zipped sloppak this opens the single
    cover member rather than unpacking the whole archive (stems included), so
    serving album art on the library grid never triggers a full extraction —
    the dominant cost behind slow cover loading on scroll.
    """
    try:
        if manifest is None:
            manifest = load_manifest(path)
    except Exception:
        manifest = {}
    cover_rel = str((manifest or {}).get("cover") or "cover.jpg")

    if path.is_dir():
        # Directory form — read the file, guarding against escape.
        cover_path = (path / cover_rel).resolve()
        try:
            cover_path.relative_to(path.resolve())
        except ValueError:
            return None
        if cover_path.is_file():
            try:
                return cover_path.read_bytes(), _cover_media_type(cover_path.name)
            except OSError as e:
                log.warning("sloppak: failed to read cover %r: %s", cover_path, e)
        return None

    # Zip form — read just the cover member, no unpack. Normalize the manifest
    # name the way the filesystem would (collapse './' and 'a/../b', backslash →
    # slash) so a non-canonical-but-valid cover like './cover.jpg' still resolves
    # to the archive member 'cover.jpg' — matching the old unpack-then-resolve
    # behavior — and reject zip-slip escape before opening.
    _zip_root = Path("/_root").resolve()
    safe = safe_join(_zip_root, cover_rel)
    # `safe is None` → escape; `safe == _zip_root` → a degenerate name like "."
    # or "subdir/.." that collapses to the root (member would be "."). Reject
    # both, mirroring _unpack_zip's degenerate-root guard.
    if safe is None or safe == _zip_root:
        log.warning("sloppak: rejected unsafe cover name %r in %r", cover_rel, path)
        return None
    member = safe.relative_to(_zip_root).as_posix()
    try:
        with zipfile.ZipFile(str(path), "r") as zf:
            try:
                data = zf.read(member)
            except KeyError:
                return None
        return data, _cover_media_type(member)
    except (OSError, zipfile.BadZipFile, RuntimeError) as e:
        log.warning("sloppak: failed to read cover from zip %r: %s", path, e)
        return None


def _sanitize_time_signatures(events) -> list[dict]:
    """Clean a time-signature event list (``[{time, ts:[num, den]}]``): keep
    entries with a finite non-bool ``time`` and a ``ts`` of two integers >= 1,
    sorted by time. Non-list / all-invalid input -> ``[]``."""
    out: list[dict] = []
    if isinstance(events, list):
        for ev in events:
            if not isinstance(ev, dict):
                continue
            t = ev.get("time")
            ts = ev.get("ts")
            if (not isinstance(t, (int, float)) or isinstance(t, bool)
                    or not math.isfinite(t)):
                continue
            if not isinstance(ts, list) or len(ts) != 2:
                continue
            if not all(isinstance(x, int) and not isinstance(x, bool) and x >= 1
                       for x in ts):
                continue
            out.append({"time": float(t), "ts": [int(ts[0]), int(ts[1])]})
        out.sort(key=lambda e: e["time"])
    return out


@dataclass
class LoadedSloppak:
    """Result of loading a sloppak: the Song object plus stem descriptors."""
    song: Song
    stems: list[dict]           # [{"id": str, "file": str, "default": bool}]
    source_dir: Path
    manifest: dict
    # The pack's declared format version (manifest `feedpak_version`, a semver
    # string per spec §4). None when absent (legacy / pre-versioning packs).
    feedpak_version: str | None = None
    # Parsed `drum_tab.json` payload when the manifest carries a `drum_tab:`
    # key pointing at a readable, schema-valid file. None otherwise (older
    # sloppaks, sloppaks without drums, sloppaks whose drum tab failed to
    # parse). The drums plugin reads this through the highway WS rather than
    # the file directly — see server.py highway_ws for the wire shape.
    drum_tab: dict | None = None
    # Parsed `song_timeline.json` payload when the manifest carries a
    # `song_timeline:` key pointing at a readable, schema-valid file.
    # When present, its beats/sections take priority over any beats/sections
    # embedded in the arrangement JSONs.
    song_timeline: dict | None = None
    # Parsed `keys.json` payload (manifest `keys:` key) — a song-level,
    # instrument-independent key/scale-change track (spec §7.7). None when
    # absent / unreadable / malformed. Streamed over the highway WS as a
    # `keys` message; consumers (renderers, plugins) read it from there.
    keys: dict | None = None
    # Sanitized song-level tempo + time-signature maps from `song_timeline.json`
    # (feedpak 1.2.0). `tempos`: [{time, bpm}]; `time_signatures`: [{time, ts}].
    # None when absent/empty. Streamed over the highway WS (`tempos` /
    # `time_signatures` messages); a per-chart arrangement `tempos` overrides
    # `tempos` for that chart (spec §6.10).
    tempos: list | None = None
    time_signatures: list | None = None
    # Maps arrangement id → validated notation payload.  None when no
    # arrangement passed schema validation; a non-empty dict only when at least
    # one arrangement carried a `notation:` sub-key whose file loaded and passed
    # schema validation.  The dict is never an empty mapping at runtime.
    notation_by_id: dict[str, dict] | None = None
    # Manifest arrangement id for each entry in song.arrangements, in the same
    # order.  None where the manifest entry had no id field.  Parallel to
    # song.arrangements (not to manifest["arrangements"]) — skipped entries are
    # absent so indexing by song.arrangements index is safe.
    arrangement_ids: list[str | None] = field(default_factory=list)
    # Manifest-relative path to the pack's complete mixdown — the whole song in
    # one file, as heard before source separation. This is the RESERVED `full`
    # stem (spec §5.3), lifted out of `stems` above precisely because it is NOT
    # an instrument layer: summing it with the per-instrument stems it was split
    # into would double the entire song. See partition_stems().
    #
    # None when the pack has no mixdown to offer *separately* from its stems —
    # which includes the common single-mix pack, whose only stem IS the mixdown
    # (there is nothing to be pristine against, so it stays in `stems`).
    #
    # Served to the front-end via the highway WS as `full_mix_url`; the stems
    # plugin plays it while every stem slider sits at unity and crosses to the
    # separated stems the moment one drops below 100% — demucs recombination is
    # lossy, so the mixdown is strictly the better audio when nothing is muted.
    full_mix: str | None = None


def load_song(
    filename: str,
    dlc_root: Path,
    unpack_cache_root: Path,
) -> LoadedSloppak:
    """Fully load a sloppak: resolve its source dir, parse manifest + all
    arrangements + optional lyrics, and return a ready-to-stream Song."""
    source_dir = resolve_source_dir(filename, dlc_root, unpack_cache_root)
    manifest = _read_manifest(source_dir)

    song = Song(
        title=str(manifest.get("title", "")),
        artist=str(manifest.get("artist", "")),
        album=str(manifest.get("album", "")),
        year=int(manifest.get("year", 0) or 0),
        song_length=float(manifest.get("duration", 0.0) or 0.0),
    )

    # Load each arrangement from its JSON file.
    notation_acc: dict[str, dict] = {}
    any_notation = False
    arrangement_ids_acc: list[str | None] = []  # parallel to song.arrangements
    for entry in manifest.get("arrangements", []) or []:
        if not isinstance(entry, dict):
            log.warning("sloppak: non-dict arrangement entry skipped (%r)", type(entry).__name__)
            continue
        rel_raw = entry.get("file")
        rel = rel_raw.strip() if isinstance(rel_raw, str) else ""
        notation_raw = entry.get("notation")
        has_notation_key = isinstance(notation_raw, str) and bool(notation_raw.strip())
        if not rel and not has_notation_key:
            continue
        data = None
        if rel:
            try:
                arr_path = (source_dir / rel).resolve()
                arr_path.relative_to(source_dir.resolve())
            except ValueError:
                log.warning("sloppak: arrangement path %r escapes source_dir — skipped", rel)
                continue
            except OSError as e:
                log.warning("sloppak: arrangement path resolution failed (%s) — skipped", e)
                continue
            if not arr_path.exists():
                continue
            try:
                data = load_json(arr_path)
            except Exception as e:
                log.debug("sloppak: failed to parse arrangement %r: %s", rel, e)
                continue
            arr = arrangement_from_wire(data)
        else:
            arr = arrangement_from_wire({
                "notes": [], "chords": [], "anchors": [],
                "handshapes": [], "templates": [],
            })
        # Manifest-level overrides take precedence over anything embedded in
        # the arrangement JSON (name, tuning, capo, centOffset).
        if entry.get("name"):
            arr.name = str(entry["name"])
        if "tuning" in entry:
            arr.tuning = list(entry["tuning"])
        if "capo" in entry:
            arr.capo = int(entry["capo"])
        if "centOffset" in entry:
            # _finite_float keeps a malformed manifest NaN/Infinity from
            # poisoning the song_info JSON (same guard as the wire path).
            arr.cent_offset = _finite_float(entry["centOffset"])

        # Beats/sections can live on the arrangement itself in the wire format.
        # If the manifest-level arrangement JSON carries them, pull them onto
        # the song object the first time we see them.
        if data is not None:
            if not song.beats:
                for b in data.get("beats", []) or []:
                    song.beats.append(
                        Beat(time=float(b.get("time", 0)), measure=int(b.get("measure", -1)))
                    )
            if not song.sections:
                for s in data.get("sections", []) or []:
                    song.sections.append(
                        Section(
                            name=str(s.get("name", "")),
                            number=int(s.get("number", 0)),
                            start_time=float(s.get("time", s.get("start_time", 0))),
                        )
                    )
        song.arrangements.append(arr)
        arr_id = str(entry.get("id", "")).strip()
        arrangement_ids_acc.append(arr_id or None)

        if not arr_id:
            log.warning("sloppak: arrangement entry has no id — notation skipped")
            continue
        notation_rel = entry.get("notation")
        if not isinstance(notation_rel, str):
            continue
        notation_rel = notation_rel.strip()
        if not notation_rel:
            continue
        try:
            nt_path = (source_dir / notation_rel).resolve()
            nt_path.relative_to(source_dir.resolve())
        except ValueError:
            log.warning("sloppak: notation path %r escapes source_dir — skipped", notation_rel)
            nt_path = None
        except OSError as e:
            log.warning("sloppak: notation path resolution failed (%s) — skipped", e)
            nt_path = None
        raw_nt = None
        if nt_path is not None and nt_path.exists():
            try:
                raw_nt = load_json(nt_path)
            except Exception as e:
                log.warning("sloppak: failed to parse notation %r: %s", notation_rel, e)
        if raw_nt is not None:
            ok, reason = notation_mod.validate_notation(raw_nt)
            if ok:
                if arr_id in notation_acc:
                    log.warning(
                        "sloppak: duplicate arrangement id %r — notation overwritten", arr_id
                    )
                notation_acc[arr_id] = raw_nt
                any_notation = True
            else:
                log.warning("sloppak: notation %r failed validation: %s", notation_rel, reason)
    notation_by_id_data = notation_acc if any_notation else None

    # Optional drum_tab.json — top-level manifest key per sloppak-spec §5.3.
    # The file lives off to the side (its own JSON), and the manifest opts in
    # via `drum_tab: drum_tab.json`. The loader stays permissive: a missing file
    # silently disables drum playback; a malformed or invalid tab disables it
    # with a warning.
    drum_tab_data: dict | None = None
    drum_tab_rel = manifest.get("drum_tab")
    if isinstance(drum_tab_rel, str) and drum_tab_rel:
        # Constrain to source_dir to prevent a crafted manifest from reading
        # files outside the sloppak directory via path traversal (e.g. ../../etc).
        # Wrap both resolve() calls in a broad handler: symlink loops and
        # permission errors on .resolve() should disable drums, not abort load.
        try:
            dt_path = (source_dir / drum_tab_rel).resolve()
            dt_path.relative_to(source_dir.resolve())
        except ValueError:
            log.warning("sloppak: drum_tab path %r escapes source_dir — skipped", drum_tab_rel)
            dt_path = None
        except OSError as e:
            log.warning("sloppak: drum_tab path resolution failed (%s) — skipped", e)
            dt_path = None
        if dt_path is not None and dt_path.exists():
            try:
                raw = load_json(dt_path)
            except Exception as e:
                log.warning("sloppak: failed to parse drum_tab %r: %s", drum_tab_rel, e)
                raw = None
            if raw is not None:
                ok, reason = drums_mod.validate_drum_tab(raw)
                if ok:
                    drum_tab_data = raw
                else:
                    log.warning("sloppak: drum_tab %r failed validation: %s",
                                drum_tab_rel, reason)

    # Drum-only sloppak: every GP track was percussion, so it ships a
    # drum_tab but no pitched arrangements. The highway WS rejects an empty
    # arrangements list with "No arrangements found" *before* it serves the
    # drum_tab, leaving the drums unplayable even in the drum highway.
    # Synthesize a minimal placeholder arrangement so the stream proceeds and
    # the drum_tab reaches the drum highway. It carries no notes (the guitar
    # highway just shows an empty board) and, when the manifest omits a
    # duration, derives a song length from the last drum hit so the timeline
    # isn't zero-length.
    if not song.arrangements and drum_tab_data is not None:
        if song.song_length <= 0:
            # validate_drum_tab() intentionally does NOT type-check individual
            # hits (they're sanitized at WS-stream time), so a hit may carry a
            # non-numeric "t". Skip anything that won't convert rather than let
            # one malformed hit abort the whole load.
            _max_t = 0.0
            for _h in drum_tab_data.get("hits") or []:
                if not isinstance(_h, dict):
                    continue
                try:
                    _max_t = max(_max_t, float(_h.get("t", 0) or 0))
                except (TypeError, ValueError):
                    continue
            if _max_t > 0:
                song.song_length = _max_t + 2.0
        song.arrangements.append(Arrangement(name="Drums"))
        arrangement_ids_acc.append(None)

    # Optional song_timeline.json — top-level manifest key per sloppak-spec §5.3.
    # When present, its beats and sections override whatever the arrangement JSONs
    # already loaded onto the song object — song_timeline is the authoritative
    # source for timeline data in sloppaks that carry it.
    song_timeline_data: dict | None = None
    tempos_data: list | None = None
    time_sigs_data: list | None = None
    song_timeline_rel = manifest.get("song_timeline")
    if isinstance(song_timeline_rel, str) and song_timeline_rel:
        try:
            st_path = (source_dir / song_timeline_rel).resolve()
            st_path.relative_to(source_dir.resolve())
        except ValueError:
            log.warning("sloppak: song_timeline path %r escapes source_dir — skipped", song_timeline_rel)
            st_path = None
        except OSError as e:
            log.warning("sloppak: song_timeline path resolution failed (%s) — skipped", e)
            st_path = None
        if st_path is not None and st_path.exists():
            try:
                raw = load_json(st_path)
            except Exception as e:
                log.warning("sloppak: failed to parse song_timeline %r: %s", song_timeline_rel, e)
                raw = None
            if raw is not None:
                if not isinstance(raw, dict):
                    log.warning("sloppak: song_timeline %r ignored — expected dict, got %s",
                                song_timeline_rel, type(raw).__name__)
                elif not isinstance(raw.get("beats"), list):
                    log.warning("sloppak: song_timeline %r ignored — 'beats' must be a list",
                                song_timeline_rel)
                elif not isinstance(raw.get("sections"), list):
                    log.warning("sloppak: song_timeline %r ignored — 'sections' must be a list",
                                song_timeline_rel)
                else:
                    song.beats = []
                    song.sections = []
                    for b in raw["beats"]:
                        if not isinstance(b, dict):
                            log.warning(
                                "sloppak: song_timeline %r — non-dict beat entry skipped (%r)",
                                song_timeline_rel, type(b).__name__,
                            )
                            continue
                        try:
                            song.beats.append(
                                Beat(
                                    # _finite_float prevents NaN/Infinity from
                                    # slipping through json.loads and poisoning
                                    # the highway WS JSON with invalid tokens.
                                    time=_finite_float(b.get("time", 0)),
                                    measure=int(b.get("measure", -1)),
                                )
                            )
                        except (TypeError, ValueError):
                            log.warning(
                                "sloppak: song_timeline %r — invalid beat entry skipped (%r)",
                                song_timeline_rel, b,
                            )
                            continue
                    for s in raw["sections"]:
                        if not isinstance(s, dict):
                            log.warning(
                                "sloppak: song_timeline %r — non-dict section entry skipped (%r)",
                                song_timeline_rel, type(s).__name__,
                            )
                            continue
                        try:
                            song.sections.append(
                                Section(
                                    name=str(s.get("name", "")),
                                    number=int(s.get("number", 0)),
                                    # Same key fallback as the arrangement-JSON
                                    # section parser: `time` with `start_time`
                                    # as the legacy alias.
                                    # _finite_float: same NaN/Infinity guard as
                                    # beat timestamps above.
                                    start_time=_finite_float(
                                        s.get("time", s.get("start_time", 0))
                                    ),
                                )
                            )
                        except (TypeError, ValueError):
                            log.warning(
                                "sloppak: song_timeline %r — invalid section entry skipped (%r)",
                                song_timeline_rel, s,
                            )
                            continue
                    song_timeline_data = raw
            # tempos / time_signatures (feedpak 1.2.0) are independent of the
            # beats/sections validation above — all are optional — so load them
            # whenever the payload parsed to a dict.
            if isinstance(raw, dict):
                tempos_data = sanitize_tempos(raw.get("tempos")) or None
                time_sigs_data = _sanitize_time_signatures(
                    raw.get("time_signatures")) or None

    # Optional shared lyrics file. Same safety posture as the drum_tab
    # loader above: constrain the manifest-declared path to source_dir
    # (a crafted sloppak with `lyrics: ../../etc/passwd.json` would
    # otherwise read arbitrary files), and ignore the payload unless
    # it's the documented shape — a flat list of syllable dicts.
    # Anything else (a dict at the root, a string, malformed entries)
    # leaves `song.lyrics` empty rather than streaming surprise data
    # downstream through the WS path.
    lyrics_rel = manifest.get("lyrics")
    if isinstance(lyrics_rel, str) and lyrics_rel:
        try:
            lyr_path = (source_dir / lyrics_rel).resolve()
            lyr_path.relative_to(source_dir.resolve())
        except ValueError:
            log.warning("sloppak: lyrics path %r escapes source_dir — skipped", lyrics_rel)
            lyr_path = None
        except OSError as e:
            log.warning("sloppak: lyrics path resolution failed (%s) — skipped", e)
            lyr_path = None
        if lyr_path is not None and lyr_path.exists():
            try:
                raw = load_json(lyr_path)
            except Exception as e:
                log.debug("sloppak: failed to parse lyrics %r: %s", lyrics_rel, e)
                raw = None
            if isinstance(raw, list):
                # Filter to entries that at least look like syllables —
                # presence of all three required keys with the right
                # primitive types. Drops anything weird without poisoning
                # the whole list.
                song.lyrics = [
                    e for e in raw
                    if isinstance(e, dict)
                    and isinstance(e.get("w"), str)
                    and isinstance(e.get("t"), (int, float))
                    and isinstance(e.get("d"), (int, float))
                ]
                if song.lyrics:
                    # Provenance. The feedpak spec (§7.1) vocabulary is
                    # {authored, transcribed, user}; older manifests + the
                    # in-tree readers also use the source-format names
                    # (xml/notechart) and the WhisperX engine name
                    # (whisperx). Accept the union so both spec-compliant
                    # writers (e.g. the stem_splitter plugin emitting
                    # `transcribed`) and legacy packs validate. Validate
                    # against the closed enum so a hand-edited (or otherwise
                    # malformed) manifest can't propagate a YAML dict / list /
                    # arbitrary string into the highway WS `lyrics.source`
                    # field and out to plugin badges. Anything outside the
                    # enum (or the wrong type) falls back to "xml" — the
                    # back-compat default — instead of being stringified and
                    # trusted.
                    # Post-alias values only: `whisperx` is normalised to
                    # `transcribed` before the membership check below, so (like
                    # `sng`) it is intentionally absent from this set.
                    _ALLOWED_LYRICS_SOURCES = {
                        "xml", "notechart", "user",
                        "authored", "transcribed",
                    }
                    # Legacy aliases: older manifests labelled note-chart-derived
                    # lyrics with the source format's name, and the WhisperX
                    # fallback with the engine name — normalise both to the
                    # spec vocabulary the badges now expect.
                    _LYRICS_SOURCE_ALIASES = {"sng": "notechart", "whisperx": "transcribed"}
                    raw_source = manifest.get("lyrics_source")
                    if isinstance(raw_source, str):
                        raw_source = _LYRICS_SOURCE_ALIASES.get(raw_source, raw_source)
                    if isinstance(raw_source, str) and raw_source in _ALLOWED_LYRICS_SOURCES:
                        song.lyrics_source = raw_source
                    else:
                        if raw_source is not None and (
                            not isinstance(raw_source, str)
                            or raw_source not in _ALLOWED_LYRICS_SOURCES
                        ):
                            log.warning(
                                "sloppak: ignoring invalid lyrics_source %r — "
                                "must be one of %s; falling back to 'xml'",
                                raw_source, sorted(_ALLOWED_LYRICS_SOURCES),
                            )
                        song.lyrics_source = "xml"
            elif raw is not None:
                log.warning("sloppak: lyrics %r ignored — expected list, got %s",
                            lyrics_rel, type(raw).__name__)

    # Stem descriptors — normalized for callers. File paths are resolved but
    # returned as ``file`` relative strings so URL construction stays caller-side.
    stems: list[dict] = []
    for s in manifest.get("stems", []) or []:
        if not isinstance(s, dict):
            continue
        sid = str(s.get("id", ""))
        sfile = str(s.get("file", ""))
        if not sid or not sfile:
            continue
        stems.append({
            "id": sid,
            "file": sfile,
            "default": stem_default_on(s.get("default", True)),
        })

    # The complete mixdown is a stem (spec §5.3), but it is not a *layer*: lift
    # it out so that no consumer of `stems` — the mixer, the library's stem
    # chips, the WS payload — sums it with, or lists it beside, the instruments
    # it was separated into. `full_mix_stem` is None for a single-mix pack,
    # whose only stem IS the mixdown and stays in the list.
    full_mix_stem, stems = partition_stems(stems)

    # Optional keys.json — song-level, instrument-independent key/scale track
    # (manifest `keys:` key, spec §7.7). Permissive like the other side-files:
    # missing / unreadable / malformed -> None, never fatal. Stored as a
    # sanitized {version, events:[{t, key, scale?}]} (finite t, non-empty string
    # key, sorted) so the highway WS can stream it without re-validating.
    keys_data: dict | None = None
    keys_rel = manifest.get("keys")
    if isinstance(keys_rel, str) and keys_rel:
        try:
            k_path = (source_dir / keys_rel).resolve()
            k_path.relative_to(source_dir.resolve())
        except ValueError:
            log.warning("sloppak: keys path %r escapes source_dir — skipped", keys_rel)
            k_path = None
        except OSError as e:
            log.warning("sloppak: keys path resolution failed (%s) — skipped", e)
            k_path = None
        if k_path is not None and k_path.exists():
            try:
                raw = load_json(k_path)
            except Exception as e:
                log.warning("sloppak: failed to parse keys %r: %s", keys_rel, e)
                raw = None
            if raw is not None and not isinstance(raw, dict):
                log.warning("sloppak: keys %r ignored — expected dict, got %s",
                            keys_rel, type(raw).__name__)
            elif isinstance(raw, dict):
                if not isinstance(raw.get("events"), list):
                    log.warning("sloppak: keys %r ignored — 'events' must be a list", keys_rel)
                else:
                    clean_events: list[dict] = []
                    for ev in raw["events"]:
                        if not isinstance(ev, dict):
                            continue
                        # Drop events with a missing / non-numeric / non-finite
                        # time rather than silently rewriting them to 0.0 — a
                        # bad `t` makes the whole event meaningless.
                        t = ev.get("t")
                        if (not isinstance(t, (int, float)) or isinstance(t, bool)
                                or not math.isfinite(t)):
                            continue
                        t = float(t)
                        key = ev.get("key")
                        if not isinstance(key, str) or not key:
                            continue
                        entry = {"t": t, "key": key}
                        scale = ev.get("scale")
                        if isinstance(scale, str) and scale:
                            entry["scale"] = scale
                        clean_events.append(entry)
                    clean_events.sort(key=lambda e: e["t"])
                    # int only — a float version (incl. NaN/Inf, which json.loads
                    # accepts) would raise on int(); default rather than abort the
                    # load of an optional side-file.
                    _ver = raw.get("version")
                    keys_data = {
                        "version": _ver if isinstance(_ver, int)
                                   and not isinstance(_ver, bool) else 1,
                        "events": clean_events,
                    }

    _fpv = manifest.get("feedpak_version")
    # The pack's full mix. Normally the RESERVED `full` stem partitioned out
    # above (spec §5.3) — no path work needed, it was validated with the other
    # stems and its URL is built the same way. Only when the pack has no `full`
    # stem do we fall back to the DEPRECATED `original_audio:` key, which is the
    # shape every pack written before feedpak 1.15.0 uses.
    if full_mix_stem is not None:
        full_mix_data: str | None = full_mix_stem["file"]
    elif find_full_mix(stems) is not None:
        # Single-mix pack: its ONE stem is the mixdown, so there is no mixdown to
        # offer *apart from* the stems. Never fall through to the legacy key here
        # — a pack that both carries a `full` stem and names the old key would
        # otherwise surface the mixdown twice (once as the stem the player is
        # already playing, once as a "pristine" track to cross to).
        full_mix_data = None
    else:
        full_mix_data = _legacy_full_mix(manifest, source_dir)

    return LoadedSloppak(
        song=song,
        stems=stems,
        source_dir=source_dir,
        manifest=manifest,
        feedpak_version=_fpv if isinstance(_fpv, str) and _fpv else None,
        drum_tab=drum_tab_data,
        song_timeline=song_timeline_data,
        tempos=tempos_data,
        time_signatures=time_sigs_data,
        keys=keys_data,
        notation_by_id=notation_by_id_data,
        arrangement_ids=arrangement_ids_acc,
        full_mix=full_mix_data,
    )


# ── Fast metadata extractor (scanner path) ────────────────────────────────────

def _tuning_for_meta(arrangements_manifest: list[dict]) -> list[int]:
    """Best-effort guitar-first tuning for the library index."""
    for entry in arrangements_manifest:
        name = str(entry.get("name", "")).lower()
        tun = entry.get("tuning")
        if tun and isinstance(tun, list) and name in ("lead", "rhythm", "combo"):
            return list(tun)
    # Fallback: first arrangement with a tuning
    for entry in arrangements_manifest:
        tun = entry.get("tuning")
        if tun and isinstance(tun, list):
            return list(tun)
    return [0] * 6


def extract_meta(path: Path) -> dict:
    """Fast metadata for the library scanner. Reads only the manifest."""
    manifest = load_manifest(path)
    arr_list = manifest.get("arrangements", []) or []

    arrangements = []
    for i, entry in enumerate(arr_list):
        arrangements.append(
            {
                "index": i,
                "name": str(entry.get("name", entry.get("id", f"Arr{i}"))),
                "notes": 0,  # unknown without loading; fine for the index
            }
        )
    # Sort like archive path: Lead > Combo > Rhythm > Bass
    priority = {"Lead": 0, "Combo": 1, "Rhythm": 2, "Bass": 3}
    arrangements.sort(key=lambda a: priority.get(a["name"], 99))
    for i, a in enumerate(arrangements):
        a["index"] = i

    has_lyrics = bool(manifest.get("lyrics"))
    tuning_offsets = _tuning_for_meta(arr_list)

    stems_list = manifest.get("stems", []) or []
    valid_stems: list[dict] = []
    for s in stems_list:
        if not isinstance(s, dict):
            continue
        sid = s.get("id")
        sfile = s.get("file")
        # Match `load_song()`'s validation: a stem entry needs BOTH a
        # non-empty id AND a non-empty file to be playable. Indexing a
        # half-formed entry would advertise a stem that load_song will
        # later refuse to surface, so the library filter would lie.
        if (
            isinstance(sid, str) and sid
            and isinstance(sfile, str) and sfile
        ):
            valid_stems.append({"id": sid, "file": sfile})
    # Partition exactly as load_song() does, for the same reason the library
    # filter must not lie: `full` is the mixdown, not an instrument (spec §5.3).
    # A separated pack that retains it would otherwise offer the user a "full"
    # stem chip alongside guitar/bass/drums and count it as a seventh stem.
    _full, instrument_stems = partition_stems(valid_stems)
    stem_ids = [s["id"] for s in instrument_stems]
    stem_count = len(stem_ids)

    return {
        "title": str(manifest.get("title", "")),
        "artist": str(manifest.get("artist", "")),
        "album": str(manifest.get("album", "")),
        "year": str(manifest.get("year", "") or ""),
        # Primary genre from the feedpak `genres` list (spec 1.12.0); [0] = primary.
        "genre": (lambda g: str(g[0]) if isinstance(g, list) and g else "")(manifest.get("genres")),
        # Album track order from the feedpak `track`/`disc` fields (spec 1.12.0);
        # None when unauthored (the album view then falls back to title order).
        "track_number": (lambda v: int(v) if str(v if v is not None else "").strip().isdigit() else None)(manifest.get("track")),
        "disc": (lambda v: int(v) if str(v if v is not None else "").strip().isdigit() else None)(manifest.get("disc")),
        "duration": float(manifest.get("duration", 0) or 0),
        "tuning_offsets": tuning_offsets,  # caller maps to a name via tunings.tuning_name
        "arrangements": arrangements,
        "has_lyrics": has_lyrics,
        "stem_count": stem_count,
        # feedBack#129: per-stem filter needs the id list, not just count.
        "stem_ids": stem_ids,
    }
