"""
lib/gp_autosync.py — Automatic score-to-audio alignment for Guitar Pro files.

Aligns a Guitar Pro tab to an audio file using chroma-based Dynamic Time
Warping (DTW), producing a GpSyncData object compatible with gp8_audio_sync.
This allows any GP file (GP3-GP8) to be precisely aligned to a matching
audio recording without manual sync point placement.

The approach:
1. Synthesise a chroma feature matrix from the tab's note pitches and timing
2. Extract a chroma feature matrix from the audio file using librosa
3. Align them with DTW to find the optimal bar-to-timestamp mapping
4. Return a GpSyncData with sync points sampled at bar boundaries

Dependencies: librosa, numpy, soundfile (all present when lyrics-karaoke
plugin is installed; graceful ImportError otherwise with clear message).

Public API:
    is_available()                          -> bool
    auto_sync(gp_path, audio_path, ...)    -> GpSyncData
    refine_sync(sync, audio_path, ...)     -> GpSyncData
    estimate_audio_offset(gp_path,
                          audio_path)      -> float
    bar_start_times(gp_path)               -> list[float]
    gp_has_expandable_repeats(gp_path)     -> bool
    build_warp_anchors(sync_points,
                       bar_starts)         -> list[tuple[float, float]]
    warp_time(t, anchors)                  -> float
    warp_song_times(song, warp)            -> None

The warp helpers (bar_start_times / build_warp_anchors / warp_time /
warp_song_times) are librosa-free: they turn a GpSyncData produced by
auto_sync (or extracted from a GP8 file) into a piecewise-linear
score-time -> audio-time mapping and apply it to a lib.song.Song, so
converted charts follow the recording's actual tempo drift instead of a
single scalar offset.
"""

from __future__ import annotations

import logging
import xml.etree.ElementTree as ET
import zipfile
import io
from pathlib import Path

_log = logging.getLogger("feedBack.lib.gp_autosync")

# ── Dependency check ──────────────────────────────────────────────────────────

def is_available() -> bool:
    """Return True if librosa and numpy are importable.

    auto_sync() requires librosa. When the lyrics-karaoke plugin is installed
    librosa is already present. Without it, auto_sync raises ImportError with
    a clear installation message rather than crashing at import time.
    """
    try:
        import librosa  # noqa: F401
        import numpy    # noqa: F401
        return True
    except ImportError:
        return False

# ── Re-use GpSyncData from gp8_audio_sync ────────────────────────────────────

from gp8_audio_sync import GpSyncData, SyncPoint

def _parse_gpif_bytes(data: bytes) -> 'ET.Element':
    """Parse GPIF XML bytes using defusedxml when available, stdlib otherwise.

    defusedxml prevents XML attacks (XXE, billion laughs) from maliciously
    crafted GP files. Falls back to stdlib with a warning if not installed.
    """
    try:
        import defusedxml.ElementTree as _dxml
        return _dxml.fromstring(data)
    except ImportError:
        _log.warning(
            'gp_autosync: defusedxml not installed; '
            'parsing GPIF with stdlib xml.etree (install defusedxml for hardened parsing)'
        )
        return ET.fromstring(data)


class _Gp345FileError(ValueError):
    """Raised by _load_gpif when the file is a GP3/GP4/GP5 binary (not GPIF XML).
    Caught by auto_sync() to route to the PyGuitarPro-based chroma path."""
    pass

# ── Internal constants ────────────────────────────────────────────────────────

# Sample rate for chroma analysis. 22050 Hz matches the lyrics-karaoke plugin
# and is standard for librosa. Audio is resampled on load; the GP file's
# original sample rate is irrelevant here.
_SR = 22050

# Hop length for DTW-level chroma. Larger hop = fewer frames = faster DTW
# but coarser resolution. At hop=4096, sr=22050: ~186ms per frame, which
# gives bar-level accuracy (a 4/4 bar at 80 BPM is 3000ms = ~16 frames).
# Memory: (song_frames)^2 * 8 bytes. A 10-minute song at hop=4096 gives
# ~3200 frames -> ~82MB. Acceptable on any modern system.
_HOP_DTW = 4096

# Diatonic step -> semitone offset (for Tone+Octave encoded notes in GPX)
_STEP_TO_SEMI = [0, 2, 4, 5, 7, 9, 11]  # C D E F G A B

# Note value string -> quarter-note duration multiplier
_NOTE_VALUE_QN = {
    'Whole': 4.0, 'Half': 2.0, 'Quarter': 1.0, 'Eighth': 0.5,
    '16th': 0.25, '32nd': 0.125, '64th': 0.0625, '128th': 0.03125,
}

# Minimum number of sync points to sample from the DTW path.
# More points = better accuracy across tempo changes.
_MIN_SYNC_POINTS = 8

# Skip tracks matching these name keywords — they don't contribute
# musically meaningful chroma (drums have no pitch, vocals drift in Hz).
_SKIP_TRACK_KEYWORDS = frozenset({
    'vocal', 'voice', 'vox', 'sing', 'drum', 'percussion', 'perc',
    'click', 'metronome',
})

# ── GPIF loading (mirrors gp2rs_gpx._load_gpif) ──────────────────────────────

def _load_gpif(gp_path: str) -> ET.Element:
    """Load score.gpif from a .gpx (GP6) or .gp (GP7/GP8) file."""
    with open(gp_path, 'rb') as fh:
        raw = fh.read()

    if raw[:2] == b'PK':  # GP7/GP8: ZIP container
        with zipfile.ZipFile(io.BytesIO(raw)) as zf:
            if 'Content/score.gpif' not in zf.namelist():
                raise ValueError("Content/score.gpif not found in GP7/GP8 container")
            return _parse_gpif_bytes(zf.read('Content/score.gpif'))

    if raw[:4] == b'BCFZ':  # GP6: BCFZ compressed
        from gp2rs_gpx import _decompress_bcfz, _parse_bcfs
        bcfs = _decompress_bcfz(raw)
        fs = _parse_bcfs(bcfs)
        return _parse_gpif_bytes(fs['score.gpif'])

    if raw[:4] == b'BCFS':  # GP6: raw BCFS
        from gp2rs_gpx import _parse_bcfs
        fs = _parse_bcfs(raw)
        return _parse_gpif_bytes(fs['score.gpif'])

    # GP3/GP4/GP5: proprietary binary format — not GPIF XML.
    # Raise a specific error so auto_sync() can route to the PyGuitarPro path.
    raise _Gp345FileError(f"GP3/GP4/GP5 binary format (magic: {raw[:4]!r})")

# ── Tempo extraction ──────────────────────────────────────────────────────────

def _children(parent: ET.Element, tag: str) -> list:
    """Return the children of ``parent/<tag>``, or ``[]`` when it's absent.

    Avoids the ``parent.find(tag) or []`` idiom — testing an Element's truth
    value is deprecated (an empty element is currently falsy but becomes
    truthy in future Python), and would silently skip an empty container.
    """
    el = parent.find(tag)
    return list(el) if el is not None else []


def _get_initial_tempo(root: ET.Element) -> float:
    """Return the first tempo value from MasterTrack automations."""
    mt = root.find('MasterTrack')
    if mt is not None:
        for auto in mt.findall('.//Automations/*'):
            if auto.findtext('Type') == 'Tempo':
                raw = (auto.findtext('Value') or '').strip()
                try:
                    return float(raw.split()[0])
                except (ValueError, IndexError):
                    pass
    return 120.0

def _get_tempo_map(root: ET.Element) -> list[tuple[int, float]]:
    """Return [(bar_index, bpm), ...] sorted by bar_index."""
    events: list[tuple[int, float]] = []
    mt = root.find('MasterTrack')
    if mt is not None:
        for auto in mt.findall('.//Automations/*'):
            if auto.findtext('Type') == 'Tempo':
                try:
                    bar = int(auto.findtext('Bar') or 0)
                    raw = (auto.findtext('Value') or '').strip()
                    bpm = float(raw.split()[0])
                    events.append((bar, bpm))
                except (ValueError, IndexError):
                    pass
    events.sort(key=lambda e: e[0])
    if not events:
        events = [(0, 120.0)]
    return events

# ── Score chroma synthesis ────────────────────────────────────────────────────

def _synthesise_score_chroma(
    root: ET.Element,
    n_frames: int,
    sr: int,
    hop: int,
) -> 'np.ndarray':
    """
    Build a (12, n_frames) chroma matrix from all pitched tracks in the GPIF.

    Each note contributes energy to its pitch class (MIDI % 12) across the
    frames that span its duration. Tracks are filtered to exclude drums and
    vocals, which don't contribute pitched chroma.

    Handles three GPX note encodings:
    - String+Fret with string pitches (guitar/bass)
    - Tone+Octave (piano/melodic in GPX)
    - Element+Variation (drums — skipped)
    """
    import numpy as np

    tempo_map = _get_tempo_map(root)

    masterbars = _children(root, 'MasterBars')
    raw_tracks = _children(root, 'Tracks')
    bars_by_id = {b.get('id'): b for b in _children(root, 'Bars')}
    voices_dict = {v.get('id'): v for v in _children(root, 'Voices')}
    beats_dict = {b.get('id'): b for b in _children(root, 'Beats')}
    notes_dict = {n.get('id'): n for n in _children(root, 'Notes')}
    rhythms_dict = {r.get('id'): r for r in _children(root, 'Rhythms')}

    chroma = np.zeros((12, n_frames), dtype=np.float32)

    for raw_idx, track_el in enumerate(raw_tracks):
        name = (track_el.findtext('Name') or '').strip().lower()
        if any(kw in name for kw in _SKIP_TRACK_KEYWORDS):
            continue

        # Skip drum tracks (GeneralMidi table=Percussion or channel 9)
        gm = track_el.find('GeneralMidi')
        if gm is not None:
            if gm.get('table') == 'Percussion':
                continue
            try:
                if int(gm.findtext('PrimaryChannel') or 0) == 9:
                    continue
            except (ValueError, TypeError):
                pass
        inst_set = track_el.find('InstrumentSet')
        if inst_set is not None:
            if (inst_set.findtext('Type') or '').lower() == 'drumkit':
                continue

        # Get string pitches. GPIF Tuning/Pitches is stored high→low
        # (index 0 = highest string) — the same ordering gp2rs_gpx._note_midi
        # and _gpx_tuning rely on.
        string_pitches: list[int] = []
        for prop in track_el.findall('.//Property'):
            if prop.get('name') == 'Tuning':
                pe = prop.find('Pitches')
                if pe is not None and pe.text:
                    try:
                        string_pitches = [int(p) for p in pe.text.split()]
                    except ValueError:
                        pass

        # Walk the bar/voice/beat/note graph for this track
        tempo_iter2 = iter(tempo_map)
        next_tb, next_bpm = next(tempo_iter2, (999999, tempo_map[0][1]))
        ct = tempo_map[0][1]
        t_cur = 0.0

        for mb_idx, mb in enumerate(masterbars):
            while mb_idx >= next_tb:
                ct = next_bpm
                next_tb, next_bpm = next(tempo_iter2, (999999, ct))

            ts = mb.findtext('Time', '4/4')
            try:
                n_b, d_b = [int(x) for x in ts.split('/')]
            except ValueError:
                n_b, d_b = 4, 4
            bar_dur = n_b * (4.0 / d_b) * (60.0 / ct)

            bar_ids = mb.findtext('Bars', '').split()
            bid = bar_ids[raw_idx] if raw_idx < len(bar_ids) else '-1'

            if bid != '-1' and bid:
                bar = bars_by_id.get(bid)
                if bar is not None:
                    for vid in bar.findtext('Voices', '').split():
                        if vid == '-1':
                            continue
                        voice = voices_dict.get(vid)
                        if voice is None:
                            continue
                        vt = t_cur
                        for beat_id in voice.findtext('Beats', '').split():
                            beat = beats_dict.get(beat_id)
                            if beat is None:
                                continue
                            rref = beat.find('Rhythm')
                            dur_qn = 0.25
                            if rref is not None:
                                r = rhythms_dict.get(rref.get('ref', ''))
                                if r is not None:
                                    nv = r.findtext('NoteValue', 'Quarter')
                                    dur_qn = _NOTE_VALUE_QN.get(nv, 0.25)
                                    if r.find('AugmentationDot') is not None:
                                        dur_qn *= 1.5
                            dur = dur_qn * (60.0 / ct)

                            for nid in beat.findtext('Notes', '').strip().split():
                                note_el = notes_dict.get(nid)
                                if note_el is None:
                                    continue
                                props = {
                                    p.get('name'): p
                                    for p in note_el.findall('.//Property')
                                }
                                midi: int | None = None

                                # Skip drums (Element+Variation encoding)
                                if 'Element' in props:
                                    continue

                                # String+Fret (guitar/bass)
                                if 'String' in props and 'Fret' in props and string_pitches:
                                    try:
                                        str_idx = int(
                                            props['String'].findtext('String') or 0
                                        )
                                        fret = int(
                                            props['Fret'].findtext('Fret') or 0
                                        )
                                        # GP6 String index 0 = highest string,
                                        # and string_pitches is high→low (index
                                        # 0 = highest), so index directly — no
                                        # reverse (matches gp2rs_gpx._note_midi).
                                        if 0 <= str_idx < len(string_pitches):
                                            midi = string_pitches[str_idx] + fret
                                    except (ValueError, TypeError):
                                        pass

                                # Tone+Octave (piano/melodic)
                                elif 'Tone' in props and 'Octave' in props:
                                    try:
                                        step = int(
                                            props['Tone'].findtext('Step') or 0
                                        )
                                        octave = int(
                                            props['Octave'].findtext('Number') or 4
                                        )
                                        midi = (octave + 1) * 12 + _STEP_TO_SEMI[step % 7]
                                    except (ValueError, TypeError, IndexError):
                                        pass

                                if midi is not None:
                                    chroma_bin = midi % 12
                                    f0 = max(0, min(int(vt * sr / hop), n_frames - 1))
                                    f1 = max(0, min(int((vt + dur) * sr / hop), n_frames))
                                    if f1 > f0:
                                        chroma[chroma_bin, f0:f1] += 1.0

                            vt += dur

            t_cur += bar_dur

    return chroma

_GP345_TICKS_PER_QUARTER = 960
# PyGuitarPro absolute ticks start at quarterTime (measure 1 begins at tick
# 960, not 0). All tick math in this module runs on a 0-based axis (cumulative
# measure starts), so raw beat.start values must be shifted by this origin —
# mixing the two axes applied every mid-song tempo change a quarter note late
# and skewed the synthesised chroma against the bar timeline.
_GP345_TICK_ORIGIN = 960


def _gp345_tempo_events(song) -> list[tuple[int, float]]:
    """Sorted, tick-deduplicated ``[(tick, bpm)]`` tempo events for a GP3/4/5 song.

    Seeds with the song's initial tempo at tick 0, then appends every
    ``mixTableChange`` tempo. Ticks are normalised to the 0-based axis
    (raw ``beat.start`` minus ``_GP345_TICK_ORIGIN``). Shared by chroma
    synthesis and bar-time computation so both use one identical tempo
    model (mirrors ``gp2rs._build_tempo_map``).
    """
    events: list[tuple[int, float]] = [(0, float(song.tempo))]
    for track in song.tracks:
        for measure in track.measures:
            for voice in measure.voices:
                for beat in voice.beats:
                    if beat.effect and beat.effect.mixTableChange:
                        mtc = beat.effect.mixTableChange
                        if mtc.tempo and mtc.tempo.value > 0:
                            events.append((
                                max(0, beat.start - _GP345_TICK_ORIGIN),
                                float(mtc.tempo.value),
                            ))
    events.sort(key=lambda e: e[0])
    seen_ticks: set[int] = set()
    unique: list[tuple[int, float]] = []
    for tick, bpm in events:
        if tick not in seen_ticks:
            seen_ticks.add(tick)
            unique.append((tick, bpm))
    return unique


def _gp345_tick_to_secs(tempo_events: list[tuple[int, float]], tick: int) -> float:
    """Convert an absolute tick to seconds via per-segment tempo integration."""
    secs = 0.0
    prev_tick = 0
    prev_bpm = tempo_events[0][1]
    for ev_tick, ev_bpm in tempo_events:
        if ev_tick >= tick:
            break
        secs += (ev_tick - prev_tick) / _GP345_TICKS_PER_QUARTER * (60.0 / prev_bpm)
        prev_tick = ev_tick
        prev_bpm = ev_bpm
    secs += (tick - prev_tick) / _GP345_TICKS_PER_QUARTER * (60.0 / prev_bpm)
    return secs


def _synthesise_score_chroma_gp345(
    gp_path: str,
    n_frames: int,
    sr: int,
    hop: int,
    _song=None,
) -> 'np.ndarray':
    """
    Build a (12, n_frames) chroma matrix from a GP3/GP4/GP5 file.

    Mirrors _synthesise_score_chroma() but reads note data via PyGuitarPro
    instead of parsing GPIF XML, since GP3-5 files use a proprietary binary
    format rather than the GPIF XML used by GP6-8.

    Uses the same tick-to-seconds conversion as gp2rs._tick_to_seconds() so
    timing is consistent with the RS XML that convert_file() produces.
    """
    import numpy as np
    import guitarpro

    song = _song if _song is not None else guitarpro.parse(gp_path)

    tempo_events = _gp345_tempo_events(song)

    def tick_to_secs(tick: int) -> float:
        return _gp345_tick_to_secs(tempo_events, tick)

    def duration_to_secs(duration, tempo_bpm: float) -> float:
        beats = 4.0 / duration.value
        if duration.isDotted:
            beats *= 1.5
        if duration.tuplet.enters > 0 and duration.tuplet.times > 0:
            beats *= duration.tuplet.times / duration.tuplet.enters
        return beats * (60.0 / tempo_bpm)

    def tempo_at_tick(tick: int) -> float:
        result = tempo_events[0][1]
        for ev_tick, ev_bpm in tempo_events:
            if ev_tick > tick:
                break
            result = ev_bpm
        return result

    chroma = np.zeros((12, n_frames), dtype=np.float32)

    for track in song.tracks:
        # Skip drums and vocals
        name_l = (track.name or '').lower()
        if any(kw in name_l for kw in _SKIP_TRACK_KEYWORDS):
            continue
        if track.isPercussionTrack:
            continue

        n_str = len(track.strings)
        if n_str == 0:
            continue

        for _, measure in zip(song.measureHeaders, track.measures, strict=False):
            for voice in measure.voices:
                for beat in voice.beats:
                    if not beat.notes:
                        continue
                    beat_tick = max(0, beat.start - _GP345_TICK_ORIGIN)
                    beat_secs = tick_to_secs(beat_tick)
                    cur_tempo = tempo_at_tick(beat_tick)
                    dur_secs = duration_to_secs(beat.duration, cur_tempo)

                    for note in beat.notes:
                        if note.type == guitarpro.NoteType.rest:
                            continue
                        if note.type == guitarpro.NoteType.tie:
                            continue

                        # GP string is 1-based (1 = highest string)
                        gp_str = note.string  # 1-based
                        if 1 <= gp_str <= n_str:
                            # track.strings is 0-based; string 1 = index 0 = highest
                            base_midi = track.strings[gp_str - 1].value
                            midi = base_midi + note.value
                            chroma_bin = midi % 12
                            f0 = max(0, min(int(beat_secs * sr / hop), n_frames - 1))
                            f1 = max(0, min(int((beat_secs + dur_secs) * sr / hop), n_frames))
                            if f1 > f0:
                                chroma[chroma_bin, f0:f1] += 1.0

    return chroma

def _safe_normalise(chroma: 'np.ndarray', eps: float = 1e-8) -> 'np.ndarray':
    """L2-normalise columns; fill zero-energy columns with uniform distribution.

    Zero-energy columns (rests, silent sections) would produce NaN under
    cosine distance. Filling them with 1/12 makes them equidistant from all
    chroma bins — they contribute nothing to the alignment cost.
    """
    import numpy as np
    norms = np.linalg.norm(chroma, axis=0, keepdims=True)
    zero_cols = (norms < eps).squeeze()
    result = chroma / np.maximum(norms, eps)
    result[:, zero_cols] = 1.0 / 12.0
    return result

# ── DTW alignment ─────────────────────────────────────────────────────────────

def _dtw_align(
    chroma_score: 'np.ndarray',
    chroma_audio: 'np.ndarray',
    sr: int,
    hop: int,
) -> 'np.ndarray':
    """Run DTW and return a (N, 2) warping path in forward order.

    librosa.sequence.dtw returns the path in reverse order (end→start);
    we reverse it so index 0 = [score_frame=0, audio_frame=0].

    Returns wp where wp[i] = [score_frame_index, audio_frame_index].
    """
    import librosa
    cs = _safe_normalise(chroma_score)
    ca = _safe_normalise(chroma_audio)
    _D, wp = librosa.sequence.dtw(cs, ca, metric='cosine')
    return wp[::-1]  # reverse to forward order

# ── Sync point extraction from DTW path ──────────────────────────────────────

def _gpif_bar_starts(root: ET.Element) -> list[float]:
    """Score-time (seconds) at the start of each masterbar in a GPIF score.

    Integrates bar durations from the bar-resolution tempo map and each
    masterbar's time signature — the same time model _synthesise_score_chroma
    uses, so bar times land where the bars sit in the synthesised chroma.
    """
    tempo_map = _get_tempo_map(root)
    masterbars = _children(root, 'MasterBars')
    tempo_iter = iter(tempo_map)
    next_tb, next_bpm = next(tempo_iter, (999999, tempo_map[0][1]))
    ct = tempo_map[0][1]
    t_cur = 0.0
    bar_starts: list[float] = []
    for mb_idx, mb in enumerate(masterbars):
        while mb_idx >= next_tb:
            ct = next_bpm
            next_tb, next_bpm = next(tempo_iter, (999999, ct))
        bar_starts.append(t_cur)
        ts = mb.findtext('Time', '4/4')
        try:
            n_b, d_b = [int(x) for x in ts.split('/')]
        except ValueError:
            n_b, d_b = 4, 4
        t_cur += n_b * (4.0 / d_b) * (60.0 / ct)
    return bar_starts


def _gp345_measure_start_ticks(song) -> list[int]:
    """Cumulative start tick of each measure in a PyGuitarPro song."""
    starts: list[int] = []
    cum = 0
    for mh in song.measureHeaders:
        starts.append(cum)
        ts = mh.timeSignature
        cum += int(ts.numerator * (4.0 / ts.denominator.value) * _GP345_TICKS_PER_QUARTER)
    return starts


def _extract_sync_points(
    wp: 'np.ndarray',
    root: ET.Element,
    audio_times: 'np.ndarray',
    score_times: 'np.ndarray',
    sr: int,
    hop: int,
    n_sync_points: int,
    bar_starts_override: list[float] | None = None,
) -> list[SyncPoint]:
    """
    Sample the DTW warping path at evenly-spaced bar boundaries.

    For each sampled bar, finds the audio frame the DTW path maps it to,
    and computes ModifiedTempo from the ratio of audio duration to score
    duration between adjacent sync points — this captures tempo drift
    between the recording and the tab's authored tempo.
    """
    import numpy as np

    tempo_map = _get_tempo_map(root)
    masterbars = _children(root, 'MasterBars')
    n_bars = len(masterbars)

    if n_bars == 0:
        return []

    # Sample bar indices evenly across the song. Always include bar 0 and the
    # last bar. Guard the public n_sync_points against 0/negative — it's the
    # divisor for the sampling stride, so an unvalidated value would otherwise
    # raise ZeroDivisionError mid-alignment.
    step = max(1, n_bars // max(1, n_sync_points))
    sampled_bars = list(range(0, n_bars, step))
    if (n_bars - 1) not in sampled_bars:
        sampled_bars.append(n_bars - 1)

    # Build bar-start times in score (seconds). Callers that synthesised the
    # score chroma with a finer (e.g. per-tick) tempo model can pass
    # `bar_starts_override` so these bar→score-time lookups match where the
    # bars actually sit in the chroma timeline; otherwise integrate bar
    # durations from the (bar-resolution) tempo map. Mismatched models bias
    # the DTW path lookup when a file has mid-bar tempo changes.
    if bar_starts_override is not None:
        bar_starts_score = list(bar_starts_override)
    else:
        bar_starts_score = _gpif_bar_starts(root)

    # Map each sampled bar to its audio time via the DTW path
    sync_points: list[SyncPoint] = []
    prev_bar: int | None = None
    prev_score_t: float | None = None
    prev_audio_t: float | None = None

    for bar_idx in sampled_bars:
        if bar_idx >= len(bar_starts_score):
            continue
        score_t = bar_starts_score[bar_idx]
        score_frame = min(int(score_t * sr / hop), len(score_times) - 1)

        # Find audio frame(s) the DTW path maps this score frame to
        matches = wp[wp[:, 0] == score_frame, 1]
        if len(matches) == 0:
            # No exact match — find nearest score frame in path
            diffs = np.abs(wp[:, 0] - score_frame)
            nearest_idx = int(np.argmin(diffs))
            matches = wp[nearest_idx:nearest_idx + 1, 1]

        audio_frame = int(np.median(matches))
        audio_t = float(audio_times[min(audio_frame, len(audio_times) - 1)])

        # Compute modified tempo for the PREVIOUS segment and assign it
        # to the previous SyncPoint. modified_bpm represents the tempo of
        # the segment from prev_bar→bar_idx so it belongs to prev_bar's entry.
        if prev_bar is not None and prev_score_t is not None and prev_audio_t is not None:
            score_seg = score_t - prev_score_t
            audio_seg = audio_t - prev_audio_t
            if audio_seg > 0.1 and sync_points:
                orig_prev = _tempo_at_bar(tempo_map, prev_bar)
                modified_bpm = orig_prev * (score_seg / audio_seg)
                modified_bpm = max(20.0, min(300.0, modified_bpm))
                # Assign to the previous SyncPoint (the one for prev_bar)
                sync_points[-1] = SyncPoint(
                    bar=sync_points[-1].bar,
                    time_secs=sync_points[-1].time_secs,
                    modified_tempo=modified_bpm,
                    original_tempo=sync_points[-1].original_tempo,
                )

        orig_bpm = _tempo_at_bar(tempo_map, bar_idx)

        sync_points.append(SyncPoint(
            bar=bar_idx,
            time_secs=audio_t,
            modified_tempo=orig_bpm,  # placeholder; updated by next iteration
            original_tempo=orig_bpm,
        ))

        prev_bar = bar_idx
        prev_score_t = score_t
        prev_audio_t = audio_t

    # The trailing sync point has no following segment, so the loop above
    # never replaced its placeholder modified_tempo (== original_tempo).
    # Carry the last computed segment tempo forward — the best available
    # estimate for the final bar — so callers don't read a stale authored
    # tempo for songs that drift in the final segment.
    if len(sync_points) >= 2:
        sync_points[-1] = SyncPoint(
            bar=sync_points[-1].bar,
            time_secs=sync_points[-1].time_secs,
            modified_tempo=sync_points[-2].modified_tempo,
            original_tempo=sync_points[-1].original_tempo,
        )

    return sync_points

def _tempo_at_bar(tempo_map: list[tuple[int, float]], bar: int) -> float:
    """Return the authored BPM at the given bar from the tempo map."""
    result = tempo_map[0][1]
    for tb, bpm in tempo_map:
        if tb <= bar:
            result = bpm
        else:
            break
    return result

# ── Audio offset estimation ───────────────────────────────────────────────────

# ── Piecewise time warp (librosa-free) ───────────────────────────────────────
#
# auto_sync's per-bar sync points describe where each sampled bar of the tab
# falls in the real recording. Applying only the scalar audio_offset (bar 1)
# assumes the recording holds the authored tempo for the whole song — any
# drift accumulates. These helpers build the full piecewise-linear
# score-time -> audio-time mapping and apply it to a converted Song, so the
# chart follows the recording bar by bar (Songsterr-style sync).

def bar_start_times(gp_path: str) -> list[float]:
    """Score-time (seconds) at the start of every bar of a GP file.

    Uses the same tempo models as auto_sync's chroma synthesis (GPIF
    bar-resolution map for .gp/.gpx, per-tick integration for .gp3/4/5), so
    the returned times share an axis with auto_sync's sync points.

    Raises ValueError if the file cannot be parsed, ImportError if the file
    is GP3/4/5 and PyGuitarPro is not installed.
    """
    try:
        root = _load_gpif(gp_path)
    except _Gp345FileError:
        import guitarpro
        try:
            song = guitarpro.parse(gp_path)
        except Exception as exc:
            raise ValueError(f"Cannot parse GP3/4/5 file {gp_path!r}: {exc}") from exc
        tempo_events = _gp345_tempo_events(song)
        return [
            _gp345_tick_to_secs(tempo_events, tick)
            for tick in _gp345_measure_start_ticks(song)
        ]
    return _gpif_bar_starts(root)


def gp_has_expandable_repeats(gp_path: str) -> bool:
    """True when converting `gp_path` expands repeats into a longer timeline
    than the as-written score auto_sync aligned against.

    gp2rs.convert_file walks the GP3/4/5 playback graph (repeat brackets,
    voltas, D.S./D.C. directions), so a file using any of those produces an
    as-performed timeline that auto_sync's as-written sync points cannot be
    mapped onto. GPIF (.gp/.gpx) conversion is single-pass as-written today,
    so those files always return False — both sides share one bar order.

    Returns False when the file cannot be parsed (callers fall back to
    offset-only sync on parse failure anyway).
    """
    if Path(gp_path).suffix.lower() in ('.gp', '.gpx'):
        return False
    try:
        import guitarpro
        song = guitarpro.parse(gp_path)
    except Exception:
        return False
    for mh in song.measureHeaders:
        if mh.isRepeatOpen or mh.repeatClose >= 0 or mh.repeatAlternative:
            return True
        # Both jump SOURCES (fromDirection: D.C., D.S., Da Coda) and jump
        # TARGETS (direction: Segno, Coda, Fine) count — a plain Da Capo
        # needs no target marker, so checking `direction` alone would miss
        # it while gp2rs's playback walker still expands the jump.
        if (getattr(mh, 'direction', None) is not None
                or getattr(mh, 'fromDirection', None) is not None):
            return True
    return False


def build_warp_anchors(
    sync_points: list[SyncPoint],
    bar_starts: list[float],
) -> list[tuple[float, float]]:
    """Turn sync points into (score_secs, audio_secs) anchor pairs.

    Drops points whose bar index is out of range, points that would break
    strict monotonicity on either axis (DTW can locally fold on noisy audio;
    a non-monotonic anchor would make the warp non-invertible and reorder
    notes), and points whose segment slope implies a physically implausible
    tempo ratio (outside 0.2x-5x authored). Returns [] when fewer than 2
    usable anchors remain — callers should fall back to scalar-offset sync
    in that case.
    """
    anchors: list[tuple[float, float]] = []
    for sp in sorted(sync_points, key=lambda p: p.bar):
        if not 0 <= sp.bar < len(bar_starts):
            continue
        score_t = bar_starts[sp.bar]
        audio_t = float(sp.time_secs)
        if anchors and (score_t <= anchors[-1][0] + 1e-6
                        or audio_t <= anchors[-1][1] + 1e-3):
            continue
        if anchors:
            # Slope sanity gate: a segment whose audio/score tempo ratio is
            # outside [0.2, 5] is not a performance — it's a DTW fold onto a
            # repeated section, an abridged recording, or a run of
            # monotonicity-clamped refine points. Keeping it would crush (or
            # absurdly stretch) every bar in the span, which is far worse
            # than interpolating through from the neighbouring anchors.
            slope = (audio_t - anchors[-1][1]) / (score_t - anchors[-1][0])
            if not 0.2 <= slope <= 5.0:
                continue
        anchors.append((score_t, audio_t))
    return anchors if len(anchors) >= 2 else []


def warp_time(t: float, anchors: list[tuple[float, float]]) -> float:
    """Map a score-time (seconds) to audio-time via piecewise-linear anchors.

    Between anchors: linear interpolation. Outside the anchor range: the
    nearest segment's slope is extended, so a count-in before bar 1 and the
    tail after the last sampled bar keep the local tempo ratio.

    `anchors` must be the >=2-point strictly-monotonic list produced by
    build_warp_anchors.
    """
    lo = 0
    hi = len(anchors) - 1
    if t <= anchors[0][0]:
        seg = (anchors[0], anchors[1])
    elif t >= anchors[hi][0]:
        seg = (anchors[hi - 1], anchors[hi])
    else:
        # Binary search for the segment containing t
        while hi - lo > 1:
            mid = (lo + hi) // 2
            if anchors[mid][0] <= t:
                lo = mid
            else:
                hi = mid
        seg = (anchors[lo], anchors[hi])
    (s0, a0), (s1, a1) = seg
    slope = (a1 - a0) / (s1 - s0)
    return a0 + (t - s0) * slope


def warp_song_times(song, warp) -> None:
    """Apply a monotonic time-mapping callable to every absolute time in a
    lib.song.Song, in place.

    Covers beats, sections, song_length, and per-arrangement notes (onset +
    sustain), chords (incl. chord notes), anchors, hand shapes, per-phrase
    difficulty levels, tone changes, and tempo overrides. Durations (note
    sustain, handshape span) are warped as end-start so they stretch with the
    local tempo ratio; sub-second intra-note envelopes (bend curves, which are
    relative to the note onset) are left untouched.

    Duck-typed: accepts any object with the lib.song.Song surface.

    Identity-safe: parse_arrangement shares the SAME Note/Chord/Anchor/
    HandShape objects between the flat arrangement lists and the
    max-difficulty phrase level, so each object is warped at most once no
    matter how many containers reference it.
    """
    seen: set[int] = set()

    def _once(obj) -> bool:
        key = id(obj)
        if key in seen:
            return False
        seen.add(key)
        return True

    def _warp_notes(notes):
        for n in notes or []:
            if not _once(n):
                continue
            end = warp(n.time + n.sustain)
            n.time = warp(n.time)
            n.sustain = max(0.0, end - n.time)

    def _warp_chords(chords):
        for c in chords or []:
            if not _once(c):
                continue
            c.time = warp(c.time)
            _warp_notes(c.notes)

    def _warp_anchors(anchors):
        for a in anchors or []:
            if _once(a):
                a.time = warp(a.time)

    def _warp_handshapes(shapes):
        for h in shapes or []:
            if not _once(h):
                continue
            start = warp(h.start_time)
            end = warp(h.end_time)
            h.start_time = start
            h.end_time = max(start, end)

    song.song_length = max(0.0, warp(song.song_length))
    for b in song.beats:
        b.time = warp(b.time)
    for s in song.sections:
        s.start_time = warp(s.start_time)
    for arr in song.arrangements:
        _warp_notes(arr.notes)
        _warp_chords(arr.chords)
        _warp_anchors(arr.anchors)
        _warp_handshapes(arr.hand_shapes)
        for ph in arr.phrases or []:
            ph.start_time = warp(ph.start_time)
            ph.end_time = warp(ph.end_time)
            for lvl in ph.levels or []:
                _warp_notes(lvl.notes)
                _warp_chords(lvl.chords)
                _warp_anchors(lvl.anchors)
                _warp_handshapes(lvl.hand_shapes)
        if arr.tones and isinstance(arr.tones, dict):
            for change in arr.tones.get('changes') or []:
                if isinstance(change, dict) and isinstance(change.get('t'), (int, float)):
                    change['t'] = warp(float(change['t']))
        for tempo_ev in arr.tempos or []:
            if isinstance(tempo_ev, dict) and isinstance(tempo_ev.get('time'), (int, float)):
                tempo_ev['time'] = warp(float(tempo_ev['time']))


def _estimate_audio_offset(
    root: ET.Element,
    audio_path: str,
    sr: int = _SR,
    hop: int = _HOP_DTW,
) -> float:
    """
    Estimate the audio_offset (seconds) for a GP file aligned to an audio file.

    The offset is negative when audio starts before bar 1 (e.g. an intro that
    isn't in the tab), positive when the tab starts before the audio.

    This is a lightweight version of auto_sync — it only aligns the first
    minute of audio to keep it fast for the UX preview.
    """
    import librosa
    import numpy as np

    # Load just the first 60 seconds of audio for speed
    y, _ = librosa.load(audio_path, sr=sr, mono=True, duration=60.0)
    chroma_audio = librosa.feature.chroma_cqt(y=y, sr=sr, hop_length=hop)
    n_frames = chroma_audio.shape[1]

    chroma_score = _synthesise_score_chroma(root, n_frames, sr, hop)
    wp = _dtw_align(chroma_score, chroma_audio, sr, hop)

    audio_times = librosa.times_like(chroma_audio, sr=sr, hop_length=hop)

    # The audio time at score frame 0 IS the audio_offset
    # (negative = audio starts before score bar 1)
    matches = wp[wp[:, 0] == 0, 1]
    if len(matches) == 0:
        return 0.0

    audio_frame_at_bar0 = int(np.median(matches))
    audio_t_at_bar0 = float(audio_times[min(audio_frame_at_bar0, len(audio_times) - 1)])

    # audio_offset is negative of the audio time at bar 0
    # (bar 0 of the score is at audio_t_at_bar0 seconds into the file)
    return -audio_t_at_bar0

# ── Main public API ───────────────────────────────────────────────────────────

def _refine_bar1_phase(
    audio_path: str,
    coarse_t: float,
    tempo_bpm: float,
    sr: int = _SR,
    hop: int = 512,
    search_radius: float = 3.0,
    phase_step: float = 0.005,
    onset_tolerance: float = 0.06,
    analysis_duration: float = 120.0,
    y: 'np.ndarray | None' = None,
) -> float:
    """
    Refine a coarse bar-1 estimate using a tempo-phase sweep over onsets.

    The DTW alignment gives a coarse estimate of where bar 1 falls in the
    audio (±1-2s). This function narrows it to ±10ms by finding the beat
    grid phase that maximises onset alignment within the search window.

    Algorithm:
    1. Detect onsets in the first `analysis_duration` seconds of audio
    2. For each candidate phase within [coarse_t - search_radius,
       coarse_t + search_radius], generate a click grid at `tempo_bpm`
    3. Count how many onsets fall within `onset_tolerance` seconds of any
       click — this is the alignment score
    4. The phase with the highest score is bar 1 beat 1

    This handles the common case of a silent or very soft first beat (e.g.
    November Rain's piano attack at t=0) that onset detectors miss. The
    phase sweep is immune to silent beats because it scores based on ALL
    onsets across the song, not just the first.

    Args:
        audio_path:        Path to audio file
        coarse_t:          DTW coarse estimate of bar-1 position (seconds)
        tempo_bpm:         Tab's authored BPM at bar 1
        sr:                Sample rate for analysis (default 22050)
        hop:               Hop length for onset detection (default 512 = 23ms)
        search_radius:     ±seconds around coarse_t to search (default 3.0)
        phase_step:        Phase grid resolution in seconds (default 0.005 = 5ms)
        onset_tolerance:   Max seconds an onset can be from a click to count
                           as aligned (default 0.06 = 60ms)
        analysis_duration: Seconds of audio to load for onset detection.
                           Longer = more onsets = more reliable score.
                           120s (first 2 min) covers enough material.
        y:                 Optional pre-decoded mono audio at `sr` (e.g. the
                           buffer auto_sync already loaded). When given, the
                           on-disk reload is skipped and the buffer is sliced
                           to the first `analysis_duration`s.

    Returns:
        Refined bar-1 time in seconds from the beginning of the audio file.
        Returns coarse_t unchanged if onset detection yields fewer than 8
        onsets (too sparse to score reliably).
    """
    import librosa
    import numpy as np

    beat_period = 60.0 / tempo_bpm
    window_start = max(0.0, coarse_t - search_radius)
    window_end = coarse_t + search_radius

    # Reuse caller-provided audio (already decoded at `sr`) when available,
    # else load the first `analysis_duration`s from disk. Either way only the
    # first `analysis_duration`s are analysed, so slice a passed-in buffer.
    if y is None:
        y, _ = librosa.load(audio_path, sr=sr, mono=True, duration=analysis_duration)
    else:
        y = y[:int(analysis_duration * sr)]
    onset_frames = librosa.onset.onset_detect(
        y=y, sr=sr, hop_length=hop, backtrack=True
    )
    onset_times = librosa.frames_to_time(onset_frames, sr=sr, hop_length=hop)

    if len(onset_times) < 8:
        _log.warning(
            "gp_autosync: only %d onsets detected — phase sweep unreliable, "
            "using coarse DTW estimate %.3fs", len(onset_times), coarse_t,
        )
        return coarse_t

    # Phase sweep
    best_phase = coarse_t
    best_score = -1
    song_end = float(onset_times[-1]) + beat_period

    for phase in np.arange(window_start, window_end, phase_step):
        clicks = np.arange(phase, song_end, beat_period)
        if clicks.size == 0:
            # Phase is at/after the last detected onset (e.g. bar 1 estimated
            # beyond the analysis window) — no grid to score against. Skip so
            # np.min() never reduces an empty array; best_phase stays at the
            # coarse DTW estimate if every phase is empty.
            continue
        score = int(sum(
            1 for t in onset_times
            if float(np.min(np.abs(clicks - t))) < onset_tolerance
        ))
        if score > best_score:
            best_score = score
            best_phase = float(phase)

    _log.info(
        "gp_autosync: phase sweep → bar-1 at %.3fs (score=%d onsets, "
        "coarse was %.3fs, delta=%.3fs)",
        best_phase, best_score, coarse_t, best_phase - coarse_t,
    )
    return best_phase

def auto_sync(
    gp_path: str,
    audio_path: str,
    n_sync_points: int = _MIN_SYNC_POINTS,
    sr: int = _SR,
    hop: int = _HOP_DTW,
    progress_cb=None,
    max_duration: float | None = None,
) -> GpSyncData:
    """
    Automatically align a Guitar Pro file to an audio recording.

    Uses chroma-based Dynamic Time Warping to find the optimal mapping
    between the tab's note sequence and the audio's pitch content.

    Args:
        gp_path:       Path to .gpx or .gp file
        audio_path:    Path to audio file (MP3, OGG, WAV, FLAC, etc.)
        n_sync_points: Approximate *minimum* number of sync points to sample
                       from the DTW path. Bars are sampled at a fixed stride
                       (n_bars // n_sync_points) and bar 0 + the final bar are
                       always included, so the count produced is typically a
                       few more than requested. More = better accuracy across
                       tempo changes; default suits most songs, use 16-32 for
                       significant tempo drift.
        sr:            Sample rate for chroma analysis (default 22050 Hz)
        hop:           Hop length for chroma frames. Larger = faster but
                       coarser. Default 4096 (~186ms/frame at 22050 Hz).
        progress_cb:   Optional callable(stage: str, pct: int) for UI updates.
        max_duration:  Optional cap (seconds) on how much audio to decode.
                       None (default) loads the whole file — a ~9-min song is
                       ~24 MB at 22050 Hz mono. Set this to clamp pathological
                       inputs (e.g. hour-long concert recordings) at the cost
                       of only aligning within the decoded window.

    Returns:
        GpSyncData with audio_offset, audio_asset_id='', and sync_points.

    Raises:
        ImportError: if librosa is not installed
        ValueError:  if the files cannot be parsed
    """
    try:
        import librosa
        import numpy as np
    except ImportError as e:
        raise ImportError(
            "auto_sync requires librosa. Install it with: "
            "pip install librosa  (or install the lyrics-karaoke plugin)"
        ) from e

    def _progress(stage: str, pct: int) -> None:
        if progress_cb is not None:
            try:
                progress_cb(stage, pct)
            except Exception as e:
                _log.debug("progress_cb raised: %s", e)
        _log.debug("auto_sync: %s (%d%%)", stage, pct)

    _progress("Loading Guitar Pro file...", 5)
    try:
        root = _load_gpif(gp_path)
    except _Gp345FileError as _e:
        # GP3/GP4/GP5 — store the error sentinel so chroma synthesis
        # knows to use the PyGuitarPro path instead
        root = _e

    _progress("Loading audio file...", 10)
    y, _ = librosa.load(audio_path, sr=sr, mono=True, duration=max_duration)
    song_duration = len(y) / sr
    _log.info("auto_sync: audio %.1fs, gp=%s", song_duration, Path(gp_path).name)

    _progress("Extracting audio chroma features...", 20)
    chroma_audio = librosa.feature.chroma_cqt(y=y, sr=sr, hop_length=hop)
    n_frames = chroma_audio.shape[1]
    _log.info("auto_sync: audio chroma %s", chroma_audio.shape)

    _progress("Synthesising score chroma from tab...", 40)
    # Route GP3/4/5 through PyGuitarPro; GPX/GP7/GP8 through GPIF XML
    if isinstance(root, _Gp345FileError):
        import guitarpro as _gp_once
        _gp345_cached = _gp_once.parse(gp_path)
        chroma_score = _synthesise_score_chroma_gp345(gp_path, n_frames, sr, hop,
                                                       _song=_gp345_cached)
    else:
        chroma_score = _synthesise_score_chroma(root, n_frames, sr, hop)
    n_pitched = int((chroma_score.sum(axis=0) > 0).sum())
    _log.info(
        "auto_sync: score chroma %s, %d/%d pitched frames",
        chroma_score.shape, n_pitched, n_frames,
    )

    if n_pitched < 10:
        raise ValueError(
            "Score has fewer than 10 pitched frames — cannot align. "
            "Ensure the GP file has guitar, bass, or keys tracks with notes."
        )

    _progress("Running Dynamic Time Warping alignment...", 60)
    audio_times = librosa.times_like(chroma_audio, sr=sr, hop_length=hop)
    score_times = librosa.times_like(chroma_score, sr=sr, hop_length=hop)
    wp = _dtw_align(chroma_score, chroma_audio, sr, hop)
    _log.info("auto_sync: DTW path length %d", len(wp))

    _progress("Extracting coarse sync points from alignment...", 80)
    # For GP3/4/5 build a minimal tempo map from PyGuitarPro song object
    if isinstance(root, _Gp345FileError):
        _gp345x_song = _gp345_cached  # reuse already-parsed song
        # Build a synthetic GPIF-like tempo map for _extract_sync_points
        # by creating a minimal XML root with just the tempo automations
        _fake_root = ET.Element('GPIF')
        _fake_mt = ET.SubElement(_fake_root, 'MasterTrack')
        _fake_autos = ET.SubElement(_fake_mt, 'Automations')
        # Same tempo model the GP3/4/5 chroma synthesis used, so bar times
        # below line up with the chroma timeline.
        _tempo_events_gp345 = _gp345_tempo_events(_gp345x_song)
        # Convert tick events to bar events using actual measure start ticks
        _measure_starts = _gp345_measure_start_ticks(_gp345x_song)

        def _tick_to_bar(tick):
            """Return 0-based bar index for a given tick position."""
            import bisect
            idx = bisect.bisect_right(_measure_starts, tick) - 1
            return max(0, idx)

        for _tick, _bpm in _tempo_events_gp345:
            _bar = _tick_to_bar(_tick)
            _auto_el = ET.SubElement(_fake_autos, 'Automation')
            ET.SubElement(_auto_el, 'Type').text = 'Tempo'
            ET.SubElement(_auto_el, 'Bar').text = str(_bar)
            ET.SubElement(_auto_el, 'Value').text = str(_bpm)
        # Add minimal MasterBars
        _fake_mbs = ET.SubElement(_fake_root, 'MasterBars')
        for _mh in _gp345x_song.measureHeaders:
            _mb_el = ET.SubElement(_fake_mbs, 'MasterBar')
            ET.SubElement(_mb_el, 'Time').text = f"{_mh.timeSignature.numerator}/{_mh.timeSignature.denominator.value}"
        _sync_root = _fake_root
        # Precise per-tick bar-start times (matching the chroma timeline) so
        # _extract_sync_points doesn't re-derive them from the coarse,
        # bar-resolution fake-GPIF tempo map — which would diverge on
        # mid-bar tempo changes and bias the sync points.
        _bar_starts_override = [
            _gp345_tick_to_secs(_tempo_events_gp345, _ms) for _ms in _measure_starts
        ]
    else:
        _sync_root = root
        _bar_starts_override = None

    sync_points_coarse = _extract_sync_points(
        wp, _sync_root, audio_times, score_times, sr, hop, n_sync_points,
        bar_starts_override=_bar_starts_override,
    )

    # Stage 2: refine bar-1 using tempo-phase sweep over onsets.
    # DTW gives a coarse estimate (±1-2s); the phase sweep narrows it to ±10ms
    # by finding the beat grid phase that maximises onset alignment.
    _progress("Refining bar-1 position with onset phase sweep...", 88)
    coarse_bar1 = sync_points_coarse[0].time_secs if sync_points_coarse else 0.0
    if isinstance(root, _Gp345FileError):
        bar1_tempo = float(_gp345_cached.tempo)
    else:
        bar1_tempo = sync_points_coarse[0].original_tempo if sync_points_coarse else _get_initial_tempo(root)

    refined_bar1 = _refine_bar1_phase(
        audio_path=audio_path,
        coarse_t=coarse_bar1,
        tempo_bpm=bar1_tempo,
        sr=sr,  # honour the caller's analysis rate (defaults to _SR)
        hop=512,  # finer hop than DTW for onset detection (~23ms at 22050Hz)
        search_radius=3.0,
        phase_step=0.005,  # 5ms resolution
        onset_tolerance=0.06,
        y=y,  # reuse the audio already decoded above — no second load
    )

    # Compute audio_offset from refined bar-1 position
    # (negative = audio starts before tab bar 1)
    audio_offset = -refined_bar1

    # Adjust all sync points by the delta between coarse and refined bar-1.
    # This preserves the relative DTW alignment across the song while anchoring
    # bar 1 precisely.
    bar1_delta = refined_bar1 - coarse_bar1  # how much bar-1 moved
    sync_points = []
    for sp in sync_points_coarse:
        sync_points.append(SyncPoint(
            bar=sp.bar,
            time_secs=sp.time_secs + bar1_delta,  # shift all points by same delta
            modified_tempo=sp.modified_tempo,
            original_tempo=sp.original_tempo,
        ))

    _progress("Done.", 100)
    _log.info(
        "auto_sync: %d sync points, audio_offset=%.3fs",
        len(sync_points), audio_offset,
    )

    return GpSyncData(
        audio_offset=audio_offset,
        audio_asset_id='',  # external audio, not embedded
        sync_points=sync_points,
    )

def refine_sync(
    sync: GpSyncData,
    audio_path: str,
    bars_per_point: int = 8,
    gp_path: str | None = None,
    sr: int = _SR,
    search_radius: float = 0.35,
    phase_step: float = 0.005,
    onset_tolerance: float = 0.05,
) -> GpSyncData:
    """Refine coarse DTW sync points with a per-bar onset phase sweep.

    auto_sync's mid-song points inherit the DTW frame granularity (~186ms at
    the default hop). This pass re-times a denser grid of bars — every
    `bars_per_point`-th bar plus the first and last — by sweeping a local
    beat grid (±`search_radius`s in `phase_step` steps) against detected
    onsets and keeping the phase that aligns best, narrowing each kept point
    to roughly the phase-step resolution on percussive material.

    Args:
        sync:            Coarse sync data from auto_sync (or a prior refine).
        audio_path:      The same audio file auto_sync aligned against.
        bars_per_point:  Refined-point density; every Nth bar gets a point.
        gp_path:         Optional path to the GP file. When given, exact
                         per-bar score times (bar_start_times) drive the
                         densified grid; without it the grid is limited to
                         a 4/4 approximation built from the points' authored
                         tempos, and accuracy degrades on odd meters.
        sr:              Analysis sample rate.
        search_radius:   ±seconds around each coarse estimate to sweep.
        phase_step:      Sweep resolution in seconds.
        onset_tolerance: Max onset-to-click distance that counts as aligned.

    Returns:
        A new GpSyncData with the refined (and usually denser) points and a
        recomputed audio_offset. Returns `sync` unchanged when it has no
        usable points. Quiet bars (fewer than 4 onsets nearby) keep their
        coarse interpolated time rather than locking onto noise.
    """
    if not sync.sync_points:
        return sync

    pts = sorted(sync.sync_points, key=lambda p: p.bar)

    bar_starts: list[float] | None = None
    if gp_path:
        try:
            bar_starts = bar_start_times(gp_path)
        except Exception as exc:
            _log.warning("refine_sync: bar_start_times(%s) failed (%s) — "
                         "falling back to 4/4 tempo model", gp_path, exc)
    if bar_starts is None:
        # Approximate score bar starts from the points' authored tempos,
        # assuming 4 beats per bar (all GpSyncData carries without the file).
        max_bar = pts[-1].bar
        bar_starts = [0.0]
        ti = 0
        cur_bpm = pts[0].original_tempo or 120.0
        for b in range(1, max_bar + 1):
            while ti + 1 < len(pts) and pts[ti + 1].bar <= b - 1:
                ti += 1
                cur_bpm = pts[ti].original_tempo or cur_bpm
            bar_starts.append(bar_starts[-1] + 4 * 60.0 / max(cur_bpm, 1e-3))

    anchors = build_warp_anchors(pts, bar_starts)
    if len(anchors) < 2:
        _log.warning("refine_sync: fewer than 2 usable anchors — returning "
                     "input unchanged")
        return sync

    # Authored-tempo lookup via the shared bar-map scan (_tempo_at_bar) so
    # boundary semantics can't drift from the rest of the module.
    _orig_map = [(p.bar, p.original_tempo or 120.0) for p in pts]

    def _orig_bpm_at(bar: int) -> float:
        return max(_tempo_at_bar(_orig_map, bar), 1e-3)

    n_bars = len(bar_starts)
    step = max(1, int(bars_per_point))
    targets = sorted(set(range(0, n_bars, step)) | {n_bars - 1})

    # Deferred past the pure early-return paths above so degenerate inputs
    # (no points, <2 anchors) resolve without librosa installed.
    import librosa
    import numpy as np

    y, _ = librosa.load(audio_path, sr=sr, mono=True)
    audio_dur = len(y) / sr
    hop = 512  # ~23ms at 22050Hz — fine enough for onset timing
    onset_frames = librosa.onset.onset_detect(
        y=y, sr=sr, hop_length=hop, backtrack=True
    )
    onset_times = np.asarray(
        librosa.frames_to_time(onset_frames, sr=sr, hop_length=hop)
    )

    refined: list[tuple[int, float]] = []
    for b in targets:
        score_t = bar_starts[b]
        coarse = warp_time(score_t, anchors)
        if coarse > audio_dur + 1.0:
            break  # bar falls past the end of the recording
        # Local beat period in AUDIO time: authored beat period scaled by the
        # local warp slope (recording tempo / authored tempo around this bar).
        slope = warp_time(score_t + 1.0, anchors) - coarse
        slope = min(max(slope, 0.25), 4.0)
        beat_period = (60.0 / _orig_bpm_at(b)) * slope

        # Keep the scoring grid short: beat_period is estimated from the
        # coarse anchors (a few % off), and grid drift grows linearly with
        # distance — 16 beats at 2% error is already ~150ms of skew at the
        # far end, which drags the sweep. 8 beats bounds that to ~beat noise.
        grid_span = 8 * beat_period
        # Clamp the sweep window below half a beat so the neighbouring beat
        # is never a candidate — on periodic material (steady drums) a grid
        # shifted by one whole beat scores identically and the sweep could
        # lock a full beat off. DTW coarse error is ~1 analysis frame, which
        # this window still covers at all but extreme tempos.
        radius = min(search_radius, 0.45 * beat_period)
        w_lo = coarse - radius - onset_tolerance
        w_hi = coarse + radius + grid_span + onset_tolerance
        local = onset_times[(onset_times >= w_lo) & (onset_times <= w_hi)]
        if len(local) < 4:
            refined.append((b, coarse))
            continue

        best_t, best_score, best_dist = coarse, -1, 0.0
        for phase in np.arange(coarse - radius, coarse + radius + 1e-9,
                               phase_step):
            clicks = np.arange(phase, phase + grid_span, beat_period)
            score = int(sum(
                1 for t in local
                if float(np.min(np.abs(clicks - t))) < onset_tolerance
            ))
            dist = abs(float(phase) - coarse)
            # Ties break toward the coarse estimate so a flat score surface
            # (sustained pads, sparse onsets) can't drag the point sideways.
            if score > best_score or (score == best_score and dist < best_dist):
                best_score, best_t, best_dist = score, float(phase), dist

        # A sweep that matched almost nothing found a spurious edge
        # alignment, not the beat grid — this happens when the true phase
        # lies outside the (ambiguity-clamped) window, e.g. fast tempos
        # where the DTW coarse error exceeds half a beat. Keeping the
        # coarse estimate degrades gracefully instead of locking a
        # fraction of a beat off.
        if best_score < 3:
            refined.append((b, coarse))
            continue

        # The onset-count score is flat within ±onset_tolerance of the true
        # phase, so the sweep alone can be off by up to the tolerance. Snap
        # inside that plateau: shift by the median residual between matched
        # onsets and their nearest grid click. Only the first few beats
        # count here — they are nearly insensitive to beat_period error,
        # while far clicks would leak that error into the residuals.
        if best_score > 0:
            clicks = np.arange(best_t, best_t + 4 * beat_period + 1e-9,
                               beat_period)
            residuals = []
            for t in local:
                d = clicks - float(t)
                j = int(np.argmin(np.abs(d)))
                if abs(d[j]) < onset_tolerance:
                    residuals.append(-float(d[j]))  # onset minus click
            if residuals:
                best_t += float(np.median(residuals))
        refined.append((b, best_t))

    if not refined:
        return sync

    # Enforce monotonicity: a point refined earlier than its predecessor
    # would fold the warp. Clamp to a small positive gap.
    mono: list[tuple[int, float]] = []
    prev_t: float | None = None
    for b, t in refined:
        t = max(t, 0.0)
        if prev_t is not None and t <= prev_t + 0.02:
            t = prev_t + 0.02
        mono.append((b, t))
        prev_t = t

    # Recompute per-segment modified tempos from the refined times (same
    # formula _extract_sync_points uses; the last point carries the previous
    # segment's tempo forward).
    new_points: list[SyncPoint] = []
    for i, (b, t) in enumerate(mono):
        obpm = _orig_bpm_at(b)
        if i + 1 < len(mono):
            b2, t2 = mono[i + 1]
            score_seg = bar_starts[b2] - bar_starts[b]
            audio_seg = t2 - t
            mod = obpm * (score_seg / audio_seg) if audio_seg > 1e-3 else obpm
            mod = max(20.0, min(300.0, mod))
        else:
            mod = new_points[-1].modified_tempo if new_points else obpm
        new_points.append(SyncPoint(
            bar=b, time_secs=t, modified_tempo=mod, original_tempo=obpm,
        ))

    _log.info("refine_sync: %d points (was %d), audio_offset=%.3fs",
              len(new_points), len(pts), -new_points[0].time_secs)
    return GpSyncData(
        audio_offset=-new_points[0].time_secs,
        audio_asset_id=sync.audio_asset_id,
        sync_points=new_points,
    )


def estimate_audio_offset(gp_path: str, audio_path: str) -> float:
    """
    Estimate the audio_offset for a GP file aligned to an audio file.

    For GPX/GP7/GP8 files: fast path — analyses only the first 60 seconds.
    For GP3/GP4/GP5 files: slow path — runs the full auto_sync() because
    PyGuitarPro-based chroma synthesis requires the complete file parse.
    Callers should be aware that GP3/4/5 may take 10-30s rather than 1-2s.

    Returns seconds (negative = audio starts before bar 1).
    """
    try:
        import librosa  # noqa: F401
    except ImportError as e:
        raise ImportError("estimate_audio_offset requires librosa") from e

    try:
        root = _load_gpif(gp_path)
    except _Gp345FileError:
        # GP3/4/5: run full auto_sync and return just the offset.
        sync = auto_sync(gp_path, audio_path)
        return sync.audio_offset
    return _estimate_audio_offset(root, audio_path)

if __name__ == '__main__':
    import sys
    import logging as _logging
    _logging.basicConfig(level=_logging.INFO)
    if len(sys.argv) < 3:
        _log.error("Usage: python gp_autosync.py <file.gp[x]> <audio.mp3>")
        sys.exit(1)

    if not is_available():
        _log.error("librosa not installed. pip install librosa")
        sys.exit(1)

    gp_path, audio_path = sys.argv[1], sys.argv[2]
    _log.info("Auto-syncing %s to %s...", Path(gp_path).name, Path(audio_path).name)

    def progress(stage, pct):
        _log.info("  [%3d%%] %s", pct, stage)

    sync = auto_sync(gp_path, audio_path, progress_cb=progress)
    _log.info("Result:")
    _log.info("  audio_offset: %.3fs", sync.audio_offset)
    _log.info("  sync_points:  %d", len(sync.sync_points))
    for sp in sync.sync_points:
        _log.info(
            "    bar=%-4d t=%.3fs  modified_bpm=%.1f  original_bpm=%.1f",
            sp.bar, sp.time_secs, sp.modified_tempo, sp.original_tempo,
        )
