"""
lib/gp8_audio_sync.py — Extract embedded audio and sync data from GP8 (.gp) files.

Guitar Pro 8 can embed a backing track (OGG audio) into a .gp file alongside
sync points that map bar positions to exact audio timestamps. This module
extracts both, giving FeedBack:

  1. A real backing track audio file (OGG) — no MIDI synthesis needed
  2. A precise audio_offset (seconds) from the FramePadding value
  3. A bar-indexed tempo map derived from sync point ModifiedTempo values,
     which is more accurate than the tab's authored tempo automations for
     files that have been manually synced to audio

Public API:
    has_embedded_audio(gp_path)        -> bool
    extract_audio(gp_path, output_dir) -> str | None   (path to .ogg file)
    extract_sync(gp_path)              -> GpSyncData | None

GpSyncData fields:
    audio_offset    float   seconds to add to all RS note times (negative
                            means audio starts before bar 1)
    sync_points     list[SyncPoint]  bar-indexed audio timestamps
    audio_asset_id  str     filename stem of the OGG in Content/Assets/

SyncPoint fields:
    bar             int     0-based bar index in the score
    time_secs       float   position in the audio file (seconds from start)
    modified_tempo  float   actual BPM at this point in the recording
    original_tempo  float   tab's authored BPM at this bar

Usage in convert_file():
    sync = extract_sync(gp_path)
    if sync:
        audio_path = extract_audio(gp_path, output_dir)
        xml = convert_file(..., audio_offset=sync.audio_offset)
    else:
        # fall back to gp2midi for GP3-5, or MIDI-less for GPX without audio
        pass
"""

import logging
import xml.etree.ElementTree as ET
import zipfile
import io
from dataclasses import dataclass, field
from pathlib import Path

_log = logging.getLogger("feedBack.lib.gp8_audio_sync")

# GP8 embeds the backing track under Content/Assets/ as OGG *or* one of
# several other formats (MP3 is common — e.g. tracks rendered straight
# from a DAW). Earlier code only matched .ogg, so an MP3-backed file would
# report has_embedded_audio() True (via meta.json) yet extract nothing.
# Match any of these and transcode to OGG on extraction when needed.
_AUDIO_ASSET_EXTS = ('.ogg', '.mp3', '.m4a', '.aac', '.wav', '.flac', '.opus', '.wma')


def _parse_gpif(data: bytes):
    """Parse GPIF XML bytes with defusedxml when available, stdlib otherwise.

    Centralised so every caller hardens parsing the same way (no divergent
    inline try/except blocks).
    """
    try:
        import defusedxml.ElementTree as _safe_ET
        return _safe_ET.fromstring(data)
    except ImportError:
        _log.warning(
            'gp8_audio_sync: defusedxml not installed; parsing with stdlib '
            'xml.etree (install defusedxml for hardened parsing)'
        )
        return ET.fromstring(data)


def _asset_path_from_registry(root, asset_id: str) -> str | None:
    """The ZIP path an ``<Asset id=...>`` declares, or None.

    GPIF shape::

        <Assets>
          <Asset id="0">
            <EmbeddedFilePath>Content/Assets/&lt;hash&gt;.mp3</EmbeddedFilePath>

    Separators are normalised (a writer may emit backslashes) and the
    result is returned as-is for the caller to verify against the
    archive — this function never decides that a path exists.
    """
    if root is None or not asset_id:
        return None
    try:
        for asset in root.iter('Asset'):
            if (asset.get('id') or '').strip() != asset_id:
                continue
            node = asset.find('EmbeddedFilePath')
            path = (node.text or '').strip() if node is not None else ''
            if not path:
                return None
            return path.replace('\\', '/').lstrip('./')
    except Exception:
        # A malformed registry is not fatal — the caller has two more
        # resolution steps behind this one.
        return None
    return None


def _resolve_audio_asset(zf, root=None) -> tuple[str, str | None]:
    """Resolve the embedded backing-track audio asset inside a .gp ZIP.

    ``BackingTrack/AssetId`` is a key into the GPIF's ``<Assets>``
    registry — ``<Asset id="0"><EmbeddedFilePath>`` names the exact path
    inside the ZIP — NOT a filename stem. Resolution order:

    1. the registry entry for the declared id (authoritative);
    2. a filename-stem match (files whose stem IS the id);
    3. the archive's first audio asset.

    Step 2 was previously the only lookup, which mattered because GP8
    names embedded files by hash while ids are small integers, so the
    stem match essentially never hit: every such file logged a warning
    and fell through to step 3. That was silently correct only because a
    file almost always carries exactly ONE audio asset — with two, a
    backing track declaring id 1 resolved to asset 0, i.e. the wrong
    recording.

    Returns ``(asset_stem, audio_zip_path)``, or ``('', None)`` when the
    archive has no audio asset. Shared by ``extract_sync`` and
    ``extract_audio`` so the matching logic can't drift between them.
    """
    audio_files = [
        n for n in zf.namelist()
        if n.startswith('Content/Assets/')
        and n.lower().endswith(_AUDIO_ASSET_EXTS)
    ]
    if not audio_files:
        return '', None

    # When the SAME backing track is present in several formats (same
    # AssetId stem), prefer the OGG: it's copied out losslessly while any
    # other format must be transcoded, so this preserves both quality and
    # the pre-MP3-support behaviour. This only applies to genuine same-stem
    # duplicates — the unmatched fallback below keeps ZIP order so an
    # unrelated later OGG can't displace the archive's first asset.
    def _prefer_ogg(candidates):
        return next(
            (n for n in candidates if n.lower().endswith('.ogg')),
            candidates[0],
        )

    declared = ''
    if root is None:
        try:
            root = _parse_gpif(zf.read('Content/score.gpif'))
        except Exception:
            root = None
    if root is not None:
        bt = root.find('BackingTrack')
        if bt is not None:
            aid = bt.find('AssetId')
            declared = (aid.text or '').strip() if aid is not None else ''

    if declared:
        # 1. The <Assets> registry is authoritative: it maps the id to the
        #    embedded path directly. Membership in the archive is verified
        #    rather than trusted — the path comes out of the file, and a
        #    stale/edited entry must fall through, not resolve to nothing.
        registry_path = _asset_path_from_registry(root, declared)
        if registry_path:
            # Matched on STEM, not the whole path, so a format variant of the
            # same recording can win (see _prefer_ogg) — but constrained to the
            # directory the registry actually named. Without that constraint an
            # unrelated file that merely shares the stem could stand in for the
            # declared asset, which is the failure the registry lookup exists
            # to prevent.
            declared_path = Path(registry_path)
            same_stem = [
                n for n in audio_files
                if Path(n).stem == declared_path.stem
                and Path(n).parent == declared_path.parent
            ]
            if same_stem:
                return declared_path.stem, _prefer_ogg(same_stem)
            _log.warning(
                'gp8_audio_sync: AssetId %r maps to %r, which is not an audio '
                'asset in the archive; falling back',
                declared, registry_path,
            )
        # 2. Legacy shape: files whose stem IS the declared id.
        matched = [n for n in audio_files if Path(n).stem == declared]
        if matched:
            return declared, _prefer_ogg(matched)
        _log.warning(
            'gp8_audio_sync: declared AssetId %r not found; falling back to first audio asset',
            declared,
        )
    # Fallback: the archive's first audio asset (ZIP order), unchanged from
    # the original OGG-only behaviour.
    return Path(audio_files[0]).stem, audio_files[0]

# GP8 uses 44100 Hz internally for FrameOffset values regardless of the
# OGG file's own sample rate. The embedded OGG is typically 48000 Hz
# (the preferred rate) and should be passed through as-is —
# do NOT resample it. The 44100 constant is only used here to convert
# FrameOffset integers to seconds for timing math; it never touches audio.
# Verified: 44100 gives <10ms sync error; 48000 gives ~530ms error.
_GP8_FRAME_RATE = 44100


@dataclass
class SyncPoint:
    """One GP8 sync point: a bar-to-audio-timestamp mapping."""
    bar: int
    time_secs: float        # position in audio file (seconds from file start)
    modified_tempo: float   # actual recording BPM at this bar
    original_tempo: float   # tab's authored BPM at this bar


@dataclass
class GpSyncData:
    """Sync data extracted from a GP8 file with an embedded backing track."""
    audio_offset: float             # seconds: negative = audio starts before bar 1
    audio_asset_id: str             # OGG filename stem in Content/Assets/
    sync_points: list[SyncPoint] = field(default_factory=list)

    def tempo_at_bar(self, bar: int) -> float:
        """Return the ModifiedTempo for the sync segment containing `bar`.

        Uses the last sync point whose bar index is <= the requested bar,
        which matches GP8's behaviour of holding each tempo until the next
        sync point.
        """
        result = self.sync_points[0].modified_tempo if self.sync_points else 120.0
        for sp in self.sync_points:
            if sp.bar <= bar:
                result = sp.modified_tempo
            else:
                break
        return result

    def time_at_bar(self, bar: int, beats_per_bar: float = 4.0) -> float:
        """Interpolate the audio timestamp (seconds) for any bar index.

        For bars between sync points, interpolates using the ModifiedTempo
        of the preceding sync point — matching GP8's linear interpolation.
        For bars before the first sync point, extrapolates backward.
        """
        if not self.sync_points:
            return 0.0

        # Find the surrounding sync points
        before = self.sync_points[0]
        after = None
        for sp in self.sync_points:
            if sp.bar <= bar:
                before = sp
            else:
                after = sp
                break

        # Between two sync points, interpolate linearly by bar index between
        # the two known audio timestamps. This is exact regardless of the
        # time signature (no beats_per_bar assumption) and matches GP8's
        # straight-line interpolation between sync points.
        if after is not None and after.bar > before.bar:
            frac = (bar - before.bar) / (after.bar - before.bar)
            return before.time_secs + frac * (after.time_secs - before.time_secs)

        # Past the last sync point (or before the first): no second anchor, so
        # extrapolate from `before` using its ModifiedTempo. beats_per_bar
        # defaults to 4.0 — callers should pass the actual time-signature
        # numerator for correct non-4/4 extrapolation here.
        bars_since = bar - before.bar
        seconds_per_bar = beats_per_bar * 60.0 / before.modified_tempo
        return before.time_secs + bars_since * seconds_per_bar


def _open_gp_zip(gp_path: str):
    """Open a .gp ZIP container and return (raw_bytes, ZipFile)."""
    with open(gp_path, 'rb') as fh:
        raw = fh.read()
    if raw[:2] != b'PK':
        raise ValueError(f"{gp_path!r} is not a GP7/GP8 ZIP file (magic: {raw[:4]!r})")
    return raw, zipfile.ZipFile(io.BytesIO(raw))


def has_embedded_audio(gp_path: str) -> bool:
    """Return True if the .gp file has an embedded backing track.

    This is the canonical gate: it returns False for anything that isn't a
    GP7/GP8 ZIP container with embedded audio (including GP3/4/5 files and
    malformed inputs). Callers should check this first — `extract_sync` and
    `extract_audio` return None for both "no embedded audio" and "not a
    GP7/8 container", so they don't distinguish the two on their own.
    """
    try:
        raw, zf = _open_gp_zip(gp_path)
        with zf:
            names = zf.namelist()
            # meta.json has {"hasAudio": true} when audio is embedded
            if 'meta.json' in names:
                import json
                meta = json.loads(zf.read('meta.json'))
                if meta.get('hasAudio'):
                    return True
            # Also check directly for any embedded audio asset (OGG, MP3, …)
            return any(
                n.startswith('Content/Assets/')
                and n.lower().endswith(_AUDIO_ASSET_EXTS)
                for n in names
            )
    except Exception:
        return False


def extract_sync(gp_path: str) -> GpSyncData | None:
    """Extract sync data from a GP8 file.

    Returns None if the file has no embedded audio or no sync points.
    """
    try:
        raw, zf = _open_gp_zip(gp_path)
        with zf:
            if 'Content/score.gpif' not in zf.namelist():
                return None

            root = _parse_gpif(zf.read('Content/score.gpif'))

            # Find the BackingTrack element for FramePadding and asset ID
            bt = root.find('BackingTrack')
            if bt is None:
                return None

            # FramePadding: negative = audio starts before bar 1
            frame_padding = 0
            fp_el = bt.find('FramePadding')
            if fp_el is not None and fp_el.text:
                try:
                    frame_padding = int(fp_el.text.strip())
                except (ValueError, TypeError):
                    pass

            audio_offset = frame_padding / _GP8_FRAME_RATE

            # Resolve the audio asset (AssetId match, first-asset fallback).
            asset_name, ogg_match = _resolve_audio_asset(zf, root)
            ogg_files = [ogg_match] if ogg_match else []

            if not asset_name and not ogg_files:
                return None

            # Extract SyncPoint automations from MasterTrack
            mt = root.find('MasterTrack')
            sync_points: list[SyncPoint] = []

            if mt is not None:
                for auto in mt.findall('.//Automations/*'):
                    if auto.findtext('Type') != 'SyncPoint':
                        continue
                    val = auto.find('Value')
                    if val is None:
                        continue
                    try:
                        bar = int(val.findtext('BarIndex') or 0)
                        # FrameOffset (inside Value) is the audio frame for this
                        # sync point. Default to 0 when absent — do NOT fall back
                        # to the automation's `Position`, which is an in-bar
                        # musical position (1/16384-note units), not a frame
                        # count, and would yield a nonsensical time_secs.
                        frame_offset = 0
                        fo_el = val.find('FrameOffset')
                        if fo_el is not None and fo_el.text:
                            frame_offset = int(fo_el.text.strip())
                        modified_tempo = float(val.findtext('ModifiedTempo') or 120)
                        original_tempo = float(val.findtext('OriginalTempo') or 120)
                        time_secs = frame_offset / _GP8_FRAME_RATE
                        sync_points.append(SyncPoint(
                            bar=bar,
                            time_secs=time_secs,
                            modified_tempo=modified_tempo,
                            original_tempo=original_tempo,
                        ))
                    except (ValueError, TypeError):
                        continue

            sync_points.sort(key=lambda sp: sp.bar)

            if not sync_points and not ogg_files:
                return None

            return GpSyncData(
                audio_offset=audio_offset,
                audio_asset_id=asset_name,
                sync_points=sync_points,
            )

    except Exception as e:
        _log.warning("gp8_audio_sync: failed to extract sync from %r: %s", gp_path, e)
        return None


def extract_audio(gp_path: str, output_dir: str) -> str | None:
    """Extract the embedded backing-track audio to output_dir as OGG.

    Returns the path to the extracted `.ogg` file, or None if no audio is
    found (or a non-OGG asset couldn't be transcoded). The filename is
    derived from the GP file stem with an `_audio` suffix:
    e.g. my_song.gp -> my_song_audio.ogg.

    GP8 embeds the backing track as OGG or another format (MP3 is common).
    An OGG asset is copied out verbatim; any other format is transcoded to
    OGG via ffmpeg so the editor/web pipeline — which expects OGG stems —
    can use it unchanged.
    """
    try:
        raw, zf = _open_gp_zip(gp_path)
        with zf:
            # Resolve the asset via the same AssetId logic extract_sync uses.
            _asset_name, chosen = _resolve_audio_asset(zf)
            if not chosen:
                return None

            out = Path(output_dir)
            out.mkdir(parents=True, exist_ok=True)

            # Name the output after the GP file, not the UUID asset name.
            stem = Path(gp_path).stem
            out_path = out / f"{stem}_audio.ogg"
            src_ext = Path(chosen).suffix.lower()

            # Already OGG — copy the bytes out verbatim (lossless, fast).
            if src_ext == '.ogg':
                out_path.write_bytes(zf.read(chosen))
                _log.info("gp8_audio_sync: extracted audio to %s", out_path)
                return str(out_path)

            # Non-OGG (e.g. MP3): stage + transcode inside a private temp dir,
            # then atomically move the result into place. A private work dir
            # keeps the function idempotent — a failed run can't clobber or
            # delete a good *_audio.ogg from a previous successful run, and the
            # staged source can't collide with a file the caller already put in
            # output_dir.
            import os
            import shutil
            import tempfile
            work = Path(tempfile.mkdtemp(prefix="gp8_audio_", dir=str(out)))
            try:
                src_path = work / f"src{src_ext or '.bin'}"
                src_path.write_bytes(zf.read(chosen))
                try:
                    from audio import _ffmpeg_cmd, _ffmpeg_wav_to_ogg
                    ffmpeg = _ffmpeg_cmd()
                except Exception:
                    ffmpeg = None
                if not ffmpeg:
                    _log.warning(
                        "gp8_audio_sync: embedded audio is %s but ffmpeg is "
                        "unavailable to transcode it to OGG", src_ext,
                    )
                    return None
                # `_ffmpeg_wav_to_ogg` runs `ffmpeg -i <in> ... <out.ogg>`; the
                # input may be any format ffmpeg can decode despite the name.
                tmp_ogg = work / "out.ogg"
                r = _ffmpeg_wav_to_ogg(ffmpeg, src_path, tmp_ogg)
                if (r.returncode == 0 and tmp_ogg.exists()
                        and tmp_ogg.stat().st_size >= 100):
                    # Atomic move into place — out_path is only ever touched on
                    # success (work dir is under output_dir, so same filesystem).
                    os.replace(tmp_ogg, out_path)
                    _log.info(
                        "gp8_audio_sync: transcoded embedded %s audio to %s",
                        src_ext, out_path,
                    )
                    return str(out_path)
                _log.warning(
                    "gp8_audio_sync: ffmpeg failed to transcode embedded %s "
                    "audio to OGG (rc=%s)", src_ext, r.returncode,
                )
                return None
            finally:
                shutil.rmtree(work, ignore_errors=True)

    except Exception as e:
        _log.warning("gp8_audio_sync: failed to extract audio from %r: %s", gp_path, e)
        return None


def build_tempo_map_from_sync(sync: GpSyncData) -> list[tuple[int, float]]:
    """
    Build a bar-indexed tempo map from GP8 sync points.

    Returns list of (bar_index, bpm) pairs sorted by bar_index, in the same
    format as gp2rs_gpx._build_tempo_map(). This can be passed directly to
    the bar iteration loop in convert_file() for accurate timing.

    For GP8 files with audio sync, ModifiedTempo values are more accurate
    than the tab's authored Tempo automations — they reflect the actual
    recording tempo rather than the transcriber's approximation.
    """
    if not sync.sync_points:
        return [(0, 120.0)]
    return [(sp.bar, sp.modified_tempo) for sp in sync.sync_points]


if __name__ == '__main__':
    import sys
    import logging as _logging
    _logging.basicConfig(level=_logging.INFO)
    path = sys.argv[1] if len(sys.argv) > 1 else None
    if not path:
        _log.error('Usage: python gp8_audio_sync.py <file.gp>')
        sys.exit(1)
    _log.info('has_embedded_audio: %s', has_embedded_audio(path))
    sync = extract_sync(path)
    if sync:
        _log.info('audio_offset:  %.4fs', sync.audio_offset)
        _log.info('audio_asset:   %s', sync.audio_asset_id)
        _log.info('sync_points:   %d', len(sync.sync_points))
        for sp in sync.sync_points:
            _log.info(
                'bar=%-4d t=%.3fs  modified_bpm=%.3f  original_bpm=%.1f',
                sp.bar, sp.time_secs, sp.modified_tempo, sp.original_tempo,
            )
    else:
        _log.info('No sync data found')
