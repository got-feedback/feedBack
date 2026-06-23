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

import json
import logging
import math
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

import yaml

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
    """
    path = dlc_root / filename
    stat = path.stat()
    mtime, size = stat.st_mtime, stat.st_size

    with _source_lock:
        cached = _source_cache.get(filename)
        if cached:
            cached_dir, cached_mtime, cached_size = cached
            if (
                cached_mtime == mtime
                and cached_size == size
                and cached_dir.exists()
            ):
                return cached_dir

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
                with _unpack_semaphore:
                    _unpack_zip(path, dest)
                resolved = dest

    with _source_lock:
        _source_cache[filename] = (resolved, mtime, size)
    return resolved


def get_cached_source_dir(filename: str) -> Path | None:
    """Return the cached source dir for a sloppak if one is known."""
    with _source_lock:
        cached = _source_cache.get(filename)
        return cached[0] if cached else None


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
                data = json.loads(arr_path.read_text(encoding="utf-8"))
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
                raw_nt = json.loads(nt_path.read_text(encoding="utf-8"))
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
                raw = json.loads(dt_path.read_text(encoding="utf-8"))
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
                raw = json.loads(st_path.read_text(encoding="utf-8"))
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
                raw = json.loads(lyr_path.read_text(encoding="utf-8"))
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
                    # Provenance — populated by the converter (xml/notechart),
                    # the WhisperX fallback (whisperx), or hand-edits
                    # (user). Validate against the closed enum so a
                    # hand-edited (or otherwise malformed) manifest can't
                    # propagate a YAML dict / list / arbitrary string
                    # into the highway WS `lyrics.source` field and out
                    # to plugin badges. Anything outside the enum (or
                    # the wrong type) falls back to "xml" — the spec's
                    # back-compat default — instead of being stringified
                    # and trusted.
                    _ALLOWED_LYRICS_SOURCES = {"xml", "notechart", "whisperx", "user"}
                    # Legacy alias: older manifests labelled note-chart-derived
                    # lyrics with the source format's name; normalise it.
                    _LYRICS_SOURCE_ALIASES = {"sng": "notechart"}
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
        default_val = s.get("default", True)
        if isinstance(default_val, str):
            default_on = default_val.lower() not in ("off", "false", "0", "no")
        else:
            default_on = bool(default_val)
        stems.append({"id": sid, "file": sfile, "default": default_on})

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
                raw = json.loads(k_path.read_text(encoding="utf-8"))
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
    stem_ids: list[str] = []
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
            stem_ids.append(sid)
    stem_count = len(stem_ids)

    return {
        "title": str(manifest.get("title", "")),
        "artist": str(manifest.get("artist", "")),
        "album": str(manifest.get("album", "")),
        "year": str(manifest.get("year", "") or ""),
        "duration": float(manifest.get("duration", 0) or 0),
        "tuning_offsets": tuning_offsets,  # caller maps to a name via tunings.tuning_name
        "arrangements": arrangements,
        "has_lyrics": has_lyrics,
        "stem_count": stem_count,
        # feedBack#129: per-stem filter needs the id list, not just count.
        "stem_ids": stem_ids,
    }
