"""Convert Guitar Pro files (.gp5/.gp4/.gp3) to arrangement XML."""

import logging
import re
import xml.etree.ElementTree as ET
from xml.dom import minidom
from dataclasses import dataclass, field
from pathlib import Path

import guitarpro

log = logging.getLogger("slopsmith.lib.gp2rs")

_YEAR_RE = re.compile(r"\b(1[89]\d{2}|20\d{2})\b")


def _extract_year(song: guitarpro.Song) -> str:
    """Pull a 4-digit year out of GP metadata.

    GP files have no dedicated year field; the year usually appears inside the
    copyright string (e.g. "1998 Goat Head Music, WB Music Corp, USA"). the converter
    requires <albumYear> to parse as Int32, so we extract just the digits and
    fall back to empty (which the converter treats as no year) when nothing matches.
    """
    for field_val in (getattr(song, "copyright", None), getattr(song, "subtitle", None)):
        if not field_val:
            continue
        m = _YEAR_RE.search(str(field_val))
        if m:
            return m.group(1)
    return ""

# Standard tuning MIDI values, GP string order (1 = highest, high → low).
# Guitar: E4 B3 G3 D3 A2 E2 [B1 F#1] — extends to 7/8 strings by adding low B/F#.
# Bass:   C3 G2 D2 A1 E1 B0 — 6-string bass high→low. A 4-string bass is the
#         middle four (G2 D2 A1 E1); a 5-string adds either the high C (full
#         table including index 0) or the low B (slice ending at index 5).
# We keep the tables at the maximum we support; _standard_tuning_for slices
# to the actual string count.
STANDARD_TUNING_GUITAR = [64, 59, 55, 50, 45, 40, 35, 30]
STANDARD_TUNING_BASS = [48, 43, 38, 33, 28, 23]

GP_TICKS_PER_QUARTER = 960


@dataclass
class TempoEvent:
    tick: int
    tempo: float  # BPM


@dataclass
class RsNote:
    time: float
    string: int
    fret: int
    sustain: float = 0.0
    bend: float = 0.0
    slide_to: int = -1
    slide_unpitch_to: int = -1
    hammer_on: bool = False
    pull_off: bool = False
    harmonic: bool = False
    harmonic_pinch: bool = False
    palm_mute: bool = False
    mute: bool = False
    vibrato: bool = False
    accent: bool = False
    tremolo: bool = False
    tap: bool = False
    link_next: bool = False
    staff: int = -1  # Piano staff: -1=absent, 0=LH/bass clef, 1=RH/treble clef


@dataclass
class RsChord:
    time: float
    template_idx: int
    notes: list[RsNote] = field(default_factory=list)


@dataclass
class RsAnchor:
    time: float
    fret: int
    width: int = 4


@dataclass
class RsBeat:
    time: float
    measure: int  # -1 for non-downbeats


@dataclass
class RsSection:
    name: str
    time: float
    number: int = 1


@dataclass
class ChordTemplate:
    name: str
    frets: list[int]  # per string, -1 = unused
    fingers: list[int]  # per string, -1 = unused


@dataclass
class PlaybackEntry:
    """One scheduled play of one source measure.

    The converter walks the GP playback graph (repeat brackets, voltas,
    D.S./D.C./Coda/Fine) and emits a ``PlaybackEntry`` for every source
    measure in its played order. ``mh_index`` indexes back into
    ``song.measureHeaders`` and ``track.measures``; ``pass_index`` is 0
    for the first time through, 1 for the second, etc. inside a repeat
    block (0 elsewhere). The two ``*_secs`` fields together let consumers
    shift each authored event into post-expansion (output) time:

        output_time = (authored_secs - mh_authored_start_secs)
                      + output_start_secs + audio_offset

    ``duration_secs`` is the same value the schedule used when stepping
    ``output_start_secs`` forward, so consumers (e.g. ``song_length``
    derivation) can compute ``output_end = output_start_secs +
    duration_secs`` without redoing the time-signature math the schedule
    deliberately avoids for irregular / pickup measures.
    """
    mh_index: int
    pass_index: int
    output_start_secs: float
    mh_authored_start_secs: float
    duration_secs: float


def _build_tempo_map(song: guitarpro.Song) -> list[TempoEvent]:
    """Build a list of (tick, tempo) events from the song."""
    events = [TempoEvent(tick=0, tempo=float(song.tempo))]

    for track in song.tracks:
        for measure in track.measures:
            for voice in measure.voices:
                for beat in voice.beats:
                    if beat.effect and beat.effect.mixTableChange:
                        mtc = beat.effect.mixTableChange
                        if mtc.tempo and mtc.tempo.value > 0:
                            events.append(TempoEvent(
                                tick=beat.start, tempo=float(mtc.tempo.value)
                            ))

    events.sort(key=lambda e: e.tick)
    # Deduplicate by tick
    seen = set()
    unique = []
    for e in events:
        if e.tick not in seen:
            seen.add(e.tick)
            unique.append(e)
    return unique


def _tick_to_seconds(tick: int, tempo_map: list[TempoEvent]) -> float:
    """Convert a GP tick position to seconds using the tempo map."""
    seconds = 0.0
    prev_tick = 0
    prev_tempo = tempo_map[0].tempo

    for event in tempo_map:
        if event.tick >= tick:
            break
        # Accumulate time from prev_tick to event.tick at prev_tempo
        dt = (event.tick - prev_tick) / GP_TICKS_PER_QUARTER * (60.0 / prev_tempo)
        seconds += dt
        prev_tick = event.tick
        prev_tempo = event.tempo

    # Remaining ticks from last tempo event to target tick
    dt = (tick - prev_tick) / GP_TICKS_PER_QUARTER * (60.0 / prev_tempo)
    seconds += dt
    return seconds


def _duration_to_seconds(duration: guitarpro.Duration, tempo: float) -> float:
    """Convert a GP Duration to seconds at a given tempo."""
    # duration.value: 1=whole, 2=half, 4=quarter, 8=eighth, etc.
    beats = 4.0 / duration.value
    if duration.isDotted:
        beats *= 1.5
    if duration.tuplet.enters > 0 and duration.tuplet.times > 0:
        beats *= duration.tuplet.times / duration.tuplet.enters
    return beats * (60.0 / tempo)


def _tempo_at_tick(tick: int, tempo_map: list[TempoEvent]) -> float:
    """Get the tempo at a given tick."""
    result = tempo_map[0].tempo
    for event in tempo_map:
        if event.tick > tick:
            break
        result = event.tempo
    return result


def _measure_duration_secs(
    mh: guitarpro.MeasureHeader, tempo_map: list[TempoEvent]
) -> float:
    """Duration of one measure in seconds at its authored tempo curve.

    Uses the same source-tick tempo map as :func:`_tick_to_seconds` so a
    tempo change *inside* a measure is integrated correctly.
    """
    ts = mh.timeSignature
    # numerator beats, each beat is (4 / denominator.value) quarter notes.
    quarter_notes = ts.numerator * (4.0 / ts.denominator.value)
    end_tick = mh.start + int(round(quarter_notes * GP_TICKS_PER_QUARTER))
    return _tick_to_seconds(end_tick, tempo_map) - _tick_to_seconds(mh.start, tempo_map)


def _measure_beat_tick(mh: guitarpro.MeasureHeader, beat_index: int) -> int:
    """Return the authored tick for a time-signature beat subdivision."""
    ts = mh.timeSignature
    quarter_notes = beat_index * (4.0 / ts.denominator.value)
    return mh.start + int(round(quarter_notes * GP_TICKS_PER_QUARTER))


# Names that may appear in MeasureHeader.fromDirection (jump *sources*).
_DA_CAPO_NAMES = frozenset({
    "Da Capo", "Da Capo al Coda", "Da Capo al Double Coda", "Da Capo al Fine",
})
_DA_SEGNO_SEGNO_NAMES = frozenset({
    "Da Segno Segno", "Da Segno Segno al Coda",
    "Da Segno Segno al Double Coda", "Da Segno Segno al Fine",
})
_DA_SEGNO_NAMES = frozenset({
    "Da Segno", "Da Segno al Coda", "Da Segno al Double Coda", "Da Segno al Fine",
})
_DA_CODA_NAMES = frozenset({"Da Coda", "Da Double Coda"})


_JUMP_BACK_NAMES = _DA_CAPO_NAMES | _DA_SEGNO_NAMES | _DA_SEGNO_SEGNO_NAMES


def _build_playback_schedule(
    song: guitarpro.Song,
    tempo_map: list[TempoEvent],
    expand_repeats: bool = True,
) -> list[PlaybackEntry]:
    """Walk the GP playback graph and emit one :class:`PlaybackEntry` per played measure.

    Honors three nested kinds of non-linear playback when ``expand_repeats``
    is true:

    1. **D.S. / D.C. / Coda / Fine** (``MeasureHeader.fromDirection`` and
       ``.direction``) — outermost; can teleport the cursor to a Segno,
       Coda, or song start, and arm an "al Fine" / "al Coda" stop or
       redirect that fires on the next pass. Checked after every emitted
       measure, including measures inside a repeat bracket.
    2. **Repeat brackets** (``isRepeatOpen`` / ``repeatClose`` with the
       ``repeatAlternative`` volta bitmask) — when an open is encountered
       the walker remembers (open, close, passes) and, after each emitted
       measure inside the block, decides whether to loop back to the open
       for the next pass.
    3. **Linear walk** — fall-through; emit one entry per measure.

    Conventionally, repeat brackets in a section that has been *jumped
    back to* via D.S./D.C. play **once** ("second time, don't repeat").
    We implement that by gating layer 2 on ``not jumped_back``.

    Malformed inputs (orphan opens, unresolved D.S. targets, etc.) emit
    a warning and fall through to a linear walk for the affected section.

    Setting ``expand_repeats=False`` produces a one-entry-per-measure
    schedule with monotonically accumulating ``output_start_secs`` — i.e.
    the same chart the converter produced before this feature existed.
    """
    headers = list(song.measureHeaders)
    if not headers:
        return []

    # Pre-compute authored start for every header. Prefer the next
    # header's start as this header's end: a final 3/4 measure in a 4/4
    # piece, an anacrusis at the front, or any partial / mid-song
    # time-signature change all carry their *real* duration in the tick
    # delta between adjacent headers. Time-signature arithmetic is only
    # used as a fall-back for the very last measure (which has no
    # successor to diff against).
    authored_starts = [_tick_to_seconds(mh.start, tempo_map) for mh in headers]
    durations: list[float] = []
    for idx, mh in enumerate(headers):
        if idx + 1 < len(headers):
            durations.append(authored_starts[idx + 1] - authored_starts[idx])
        else:
            durations.append(_measure_duration_secs(mh, tempo_map))

    # Pre-scan direction targets (Segno / Coda / Fine markers). First
    # occurrence wins; later duplicates only get a warning.
    targets: dict[str, int] = {}
    for i, mh in enumerate(headers):
        if mh.direction:
            nm = mh.direction.name
            if nm in targets:
                log.warning(
                    "gp2rs: duplicate direction target %r at measure %d "
                    "(first occurrence at %d will be used)",
                    nm, i, targets[nm],
                )
            else:
                targets[nm] = i

    schedule: list[PlaybackEntry] = []
    output_t = 0.0

    def emit(idx: int, pass_index: int) -> None:
        nonlocal output_t
        schedule.append(PlaybackEntry(
            mh_index=idx,
            pass_index=pass_index,
            output_start_secs=output_t,
            mh_authored_start_secs=authored_starts[idx],
            duration_secs=durations[idx],
        ))
        output_t += durations[idx]

    if not expand_repeats:
        for i in range(len(headers)):
            emit(i, 0)
        return schedule

    def find_repeat_close(start: int) -> int | None:
        """Index of the first measure ≥ start whose ``repeatClose`` is set.

        pyguitarpro encodes ``repeatClose == -1`` for "no close marker" and
        ``repeatClose == N`` (with ``N >= 0``) for a closing marker that
        replays the bracket ``N`` additional times. We accept any non-
        negative value as a close so a file authored with ``repeatClose
        == 0`` (a "decorative" close that doesn't actually loop) doesn't
        get mis-treated as an orphan open.
        """
        for j in range(start, len(headers)):
            if headers[j].repeatClose >= 0:
                return j
        return None

    # Walker state. Repeats and directions interleave: a D.C./D.S. inside
    # a repeat block must fire as soon as its measure is emitted, so we
    # process repeats as a single-loop "loop back at end of pass" rather
    # than a nested sub-loop. This makes every emitted measure flow
    # through the same direction/jump checks below.
    jumped_back = False             # True after the first D.S./D.C./D.S.S. fires
    stop_at: str | None = None      # None | "fine" | "coda" | "double_coda"
    in_repeat = False
    repeat_open = -1
    repeat_close = -1
    total_passes = 1
    pass_idx = 0

    def end_of_pass(curr_i: int) -> tuple[int, bool]:
        """Compute the next index after the current pass through the repeat
        block ends. Returns ``(next_i, still_in_repeat)``."""
        nonlocal pass_idx, in_repeat
        # Did we just emit / skip past the close measure?
        if not in_repeat or curr_i <= repeat_close:
            return curr_i, in_repeat
        pass_idx += 1
        if pass_idx >= total_passes:
            in_repeat = False
            return repeat_close + 1, False
        return repeat_open, True

    i = 0
    while i < len(headers):
        mh = headers[i]

        # --- (1) Detect entry into a new repeat block ---
        if not in_repeat and mh.isRepeatOpen and not jumped_back:
            j = find_repeat_close(i)
            if j is None:
                log.warning(
                    "gp2rs: repeat-open at measure %d has no matching close; "
                    "playing the rest of the song linearly",
                    i,
                )
            else:
                in_repeat = True
                repeat_open = i
                repeat_close = j
                total_passes = max(1, headers[j].repeatClose + 1)
                pass_idx = 0

        # --- (2) Volta skip ---
        if in_repeat:
            ra = mh.repeatAlternative
            if ra and not (ra & (1 << pass_idx)):
                i += 1
                i, _ = end_of_pass(i)
                continue

        # --- (3) "al Coda" / "al Double Coda" redirect (before emit) ---
        if stop_at in ("coda", "double_coda") and mh.fromDirection \
                and mh.fromDirection.name in _DA_CODA_NAMES:
            want = "Double Coda" if mh.fromDirection.name == "Da Double Coda" \
                else "Coda"
            target = targets.get(want)
            if target is None:
                log.warning(
                    "gp2rs: %s redirect at measure %d but no %s target found",
                    mh.fromDirection.name, i, want,
                )
                stop_at = None
            else:
                stop_at = None
                in_repeat = False
                i = target
                continue

        # --- (4) Emit the measure ---
        emit(i, pass_idx if in_repeat else 0)

        # --- (5) Fine stop ---
        if stop_at == "fine" and mh.direction and mh.direction.name == "Fine":
            return schedule

        # --- (6) D.S./D.C./D.S.S. jump (fires once, ever) ---
        if not jumped_back and mh.fromDirection \
                and mh.fromDirection.name in _JUMP_BACK_NAMES:
            name = mh.fromDirection.name
            if name in _DA_CAPO_NAMES:
                target_idx: int | None = 0
            elif name in _DA_SEGNO_SEGNO_NAMES:
                target_idx = targets.get("Segno Segno")
            else:
                target_idx = targets.get("Segno")
            if target_idx is None:
                log.warning(
                    "gp2rs: %s at measure %d has no matching target; "
                    "continuing linearly",
                    name, i,
                )
            else:
                if "al Fine" in name:
                    stop_at = "fine"
                elif "al Double Coda" in name:
                    stop_at = "double_coda"
                elif "al Coda" in name:
                    stop_at = "coda"
                jumped_back = True
                in_repeat = False  # leave any current repeat block
                i = target_idx
                continue

        # --- (7) Advance, looping back on repeat-pass end ---
        i += 1
        i, _ = end_of_pass(i)

    return schedule


def _gp_string_to_rs(gp_string: int, num_strings: int) -> int:
    """Convert GP string number (1=high) to RS string index (0=low)."""
    return num_strings - gp_string


def _is_bass_track(track: guitarpro.Track) -> bool:
    """Detect whether a GP track is a bass.

    Trusts a GM MIDI program in the Bass family (32-39) when present, but
    does not trust an explicit *non-bass* program: GP files frequently ship
    bass tracks with mis-set channels (acoustic-guitar 24, piano 0, etc.),
    so we always fall back to the highest string's pitch when the program
    isn't in the bass range. Bass tops out around C3 (MIDI 48 on a 6-string
    bass); guitar's highest string is E4 (MIDI 64) or D4 (MIDI 62) even for
    detuned 7/8-string charts, so a `max ≤ 48` cut cleanly separates them.
    """
    if hasattr(track, "channel") and track.channel:
        instrument = getattr(track.channel, "instrument", -1)
        if 32 <= instrument <= 39:
            return True
    if not track.strings:
        return False
    return max(s.value for s in track.strings) <= 48


def _standard_tuning_for(num: int, is_bass: bool, top_midi: int | None = None) -> list[int]:
    """Return a high→low standard tuning of length `num` for the given role.

    5-string bass has two common standards: high-C (`C G D A E`, top MIDI
    48) and low-B (`G D A E B`, top MIDI 43). When `top_midi` is provided
    and `num == 5`, pick whichever standard the actual top string is
    closer to — the midpoint between MIDI 43 and 48 is 45.5, so
    `top_midi >= 46` selects the high-C variant. With no hint we default
    to the more common low-B layout.
    """
    if is_bass:
        if num == 5 and top_midi is not None and top_midi >= 46:
            # High-C 5-string: drop the lowest string from the 6-string table.
            return STANDARD_TUNING_BASS[:5]
        if num <= 5:
            # 4-string and low-B 5-string: skip the high C from the 6-string table.
            return STANDARD_TUNING_BASS[1:1 + num]
        if num <= len(STANDARD_TUNING_BASS):
            return STANDARD_TUNING_BASS[:num]
        # >6-string bass is pathological but theoretically possible —
        # pad with descending fourths so the returned list always has
        # `num` entries (otherwise `_compute_tuning` silently leaves
        # offsets at 0 for the missing slots).
        extra = [STANDARD_TUNING_BASS[-1] - 5 * (i + 1)
                 for i in range(num - len(STANDARD_TUNING_BASS))]
        return STANDARD_TUNING_BASS + extra
    # Guitar extends downward (low B/F#) — slice from the top.
    if num <= len(STANDARD_TUNING_GUITAR):
        return STANDARD_TUNING_GUITAR[:num]
    # Pathological GP files with >8 strings: pad by continuing in fourths.
    extra = [STANDARD_TUNING_GUITAR[-1] - 5 * (i + 1)
             for i in range(num - len(STANDARD_TUNING_GUITAR))]
    return STANDARD_TUNING_GUITAR + extra


def _compute_tuning(track: guitarpro.Track) -> list[int]:
    """Compute RS tuning offsets (semitones from standard) from GP string MIDI values."""
    num = len(track.strings)
    # Top GP string is `number == 1`; fall back to None when strings is
    # empty so `_standard_tuning_for` uses the default low-B 5-string layout.
    top_midi = next((s.value for s in track.strings if s.number == 1), None)
    standard = _standard_tuning_for(num, _is_bass_track(track), top_midi=top_midi)

    # GP strings are ordered high to low (string 1 = highest).
    # RS tuning is ordered low to high (index 0 = lowest).
    offsets = [0] * num
    for gp_str in track.strings:
        idx = gp_str.number - 1
        if idx < 0 or idx >= len(standard):
            continue  # defensive; shouldn't happen now that standard tracks num
        rs_idx = _gp_string_to_rs(gp_str.number, num)
        offsets[rs_idx] = gp_str.value - standard[idx]
    return offsets


def convert_track(
    song: guitarpro.Song,
    track_index: int,
    audio_offset: float = 0.0,
    arrangement_name: str = "",
    force_standard_tuning: bool = False,
    *,
    expand_repeats: bool = True,
) -> str:
    """Convert a GP track to arrangement XML string.

    Args:
        song: Parsed Guitar Pro song
        track_index: Which track to convert (0-based)
        audio_offset: Seconds to add to all times (for sync with audio)
        arrangement_name: "Lead", "Rhythm", "Bass", etc.
        force_standard_tuning: If True, set tuning to E standard (frets unchanged)
        expand_repeats: When true (default), replay repeated bars and follow
            D.S./D.C./Coda/Fine jumps so the chart matches an audio file that
            plays the song as performed. When false, every measure is emitted
            once in authored order — equivalent to the pre-expansion behavior.

    Returns:
        XML string of the chart arrangement
    """
    track = song.tracks[track_index]
    num_strings = len(track.strings)
    is_bass = _is_bass_track(track)
    tempo_map = _build_tempo_map(song)
    schedule = _build_playback_schedule(song, tempo_map, expand_repeats)
    headers = song.measureHeaders
    if force_standard_tuning:
        tuning = [0] * num_strings
    else:
        tuning = _compute_tuning(track)

    if not arrangement_name:
        name = track.name.strip()
        low = name.lower()
        if is_bass or "bass" in low:
            arrangement_name = "Bass"
        elif "rhythm" in low or "rhy" in low:
            arrangement_name = "Rhythm"
        else:
            arrangement_name = "Lead"

    # ── Collect beats (ebeats) ────────────────────────────────────────────
    # Iterate the schedule rather than song.measureHeaders directly so each
    # replayed pass of a repeat block emits its own downbeats / subdivisions
    # at the correct *output* time.
    beats = []
    for entry in schedule:
        mh = headers[entry.mh_index]
        beats.append(RsBeat(
            time=entry.output_start_secs + audio_offset,
            measure=mh.number,
        ))
        # Subdivisions within the measure — same authored offsets, shifted
        # into output time by the entry's output_start.
        num_beats_in_measure = mh.timeSignature.numerator
        for b in range(1, num_beats_in_measure):
            sub_tick = _measure_beat_tick(mh, b)
            sub_offset_in_measure = _tick_to_seconds(sub_tick, tempo_map) \
                - entry.mh_authored_start_secs
            beats.append(RsBeat(
                time=entry.output_start_secs + sub_offset_in_measure + audio_offset,
                measure=-1,
            ))
    beats.sort(key=lambda b: b.time)

    # ── Collect sections from markers ─────────────────────────────────────
    # One marker per scheduled appearance: a "verse" marker inside a ×2
    # repeat block emits "verse #1" on pass 0 and "verse #2" on pass 1.
    sections = []
    section_counts: dict[str, int] = {}
    for entry in schedule:
        mh = headers[entry.mh_index]
        if mh.marker and mh.marker.title:
            name = mh.marker.title.strip().lower().replace(" ", "")
            section_counts[name] = section_counts.get(name, 0) + 1
            sections.append(RsSection(
                name=name,
                time=entry.output_start_secs + audio_offset,
                number=section_counts[name],
            ))

    if not sections:
        # Default: one section for the whole song
        sections.append(RsSection(name="default", time=audio_offset, number=1))

    # ── Collect notes and chords ──────────────────────────────────────────
    rs_notes = []
    rs_chords = []
    chord_templates: list[ChordTemplate] = []
    chord_template_map: dict[tuple, int] = {}  # fret tuple → index
    last_note_per_string: dict[int, RsNote] = {}  # for tie sustain extension
    pending_slides: list = []  # (RsNote, rs_string, kind) — resolved post-loop
    _prev_mh_index: int = -1  # sentinel: no previous entry

    for entry in schedule:
        # Clear the tie-tracking state on backward jumps in the playback
        # schedule (repeat loopbacks, D.S., D.C.).  A tie at the start of
        # a repeated section must not extend the last note from the previous
        # pass through that section.  Forward skips (volta alternatives,
        # al-Coda redirects) are *not* cleared because consecutive schedule
        # entries that jump forward are still adjacent in the output audio,
        # so a tie crossing such a boundary is semantically valid.
        if _prev_mh_index != -1 and entry.mh_index <= _prev_mh_index:
            last_note_per_string.clear()
        _prev_mh_index = entry.mh_index
        measure = track.measures[entry.mh_index]
        for voice in measure.voices:
            for beat in voice.beats:
                if not beat.notes:
                    continue

                authored_beat_secs = _tick_to_seconds(beat.start, tempo_map)
                t = (authored_beat_secs - entry.mh_authored_start_secs) \
                    + entry.output_start_secs + audio_offset
                tempo = _tempo_at_tick(beat.start, tempo_map)
                dur = _duration_to_seconds(beat.duration, tempo)

                beat_notes = []
                for note in beat.notes:
                    if note.type == guitarpro.NoteType.rest:
                        continue

                    rs_str = _gp_string_to_rs(note.string, num_strings)

                    if note.type == guitarpro.NoteType.tie:
                        prev = last_note_per_string.get(rs_str)
                        if prev is not None and prev.time < t:
                            prev.sustain = max(prev.sustain, (t + dur) - prev.time)
                        continue

                    fret = note.value
                    if note.type == guitarpro.NoteType.dead:
                        fret = max(fret, 0)

                    rn = RsNote(
                        time=t,
                        string=rs_str,
                        fret=fret,
                        sustain=dur if dur > 0.2 else 0.0,
                        mute=note.type == guitarpro.NoteType.dead,
                    )

                    # Techniques
                    eff = note.effect
                    if eff.bend and eff.bend.points:
                        # pyguitarpro bend point values are in quarter-tones
                        # (maxValue 12 = 3 whole tones = 6 semitones), so
                        # semitones = value / 2. The old /100.0 made every bend
                        # round to 0 (a whole-tone bend is value 4 -> 0.04).
                        max_bend = max(p.value for p in eff.bend.points)
                        rn.bend = round(max_bend / 2.0, 1)

                    if eff.hammer:
                        # HO vs PO from pitch direction off the prior note on the
                        # string (descending = pull-off). last_note_per_string is
                        # still the previous note here (updated after append).
                        _prevn = last_note_per_string.get(rs_str)
                        if _prevn is not None and _prevn.fret > fret:
                            rn.pull_off = True
                        else:
                            rn.hammer_on = True

                    if eff.slides:
                        for slide in eff.slides:
                            if slide in (
                                guitarpro.SlideType.shiftSlideTo,
                                guitarpro.SlideType.legatoSlideTo,
                            ):
                                # Pitched slide to the next note on this string;
                                # slide_to (the target fret) is filled in by the
                                # post-pass below once all notes are known.
                                rn.link_next = True
                                pending_slides.append((rn, rs_str, "pitched"))
                            elif slide == guitarpro.SlideType.outDownwards:
                                pending_slides.append((rn, rs_str, "down"))
                            elif slide == guitarpro.SlideType.outUpwards:
                                pending_slides.append((rn, rs_str, "up"))

                    if getattr(eff, "letRing", False):
                        rn.link_next = True

                    if eff.harmonic:
                        if isinstance(eff.harmonic, guitarpro.PinchHarmonic):
                            rn.harmonic_pinch = True
                        else:
                            rn.harmonic = True

                    if eff.palmMute:
                        rn.palm_mute = True
                    if eff.accentuatedNote or eff.heavyAccentuatedNote:
                        rn.accent = True
                    if eff.ghostNote:
                        rn.mute = True
                    if getattr(eff, "vibrato", False):
                        rn.vibrato = True
                    if eff.tremoloPicking:
                        rn.tremolo = True

                    # Whammy / tremolo bar (beat-level dive/raise). RS has no
                    # whammy attribute, so approximate the pitch movement as an
                    # unpitched slide: a dive slides down, a raise slides up, by
                    # the peak amount (value->semitones, same /2 scale as bends,
                    # capped at ±12). Don't clobber a real slide on the note.
                    # Skip when the note already has a slide: a real slide's
                    # slide_to is still -1 here (filled by the post-pass below),
                    # so guarding only on rn.slide_to would let a note carry both
                    # a whammy slide_unpitch_to AND a slide_to (conflicting).
                    _tb = getattr(beat.effect, "tremoloBar", None)
                    if (_tb and _tb.points and not eff.slides
                            and rn.slide_to < 0 and rn.slide_unpitch_to < 0):
                        _peak = max(_tb.points, key=lambda p: abs(p.value)).value
                        if _peak:
                            _semis = max(-12, min(12, round(_peak / 2.0)))
                            if _semis:
                                rn.slide_unpitch_to = max(0, rn.fret + _semis)

                    # Grace note (lead-in / flam). GP stores it as an effect on
                    # the MAIN note, so the beat loop never emits it. Emit it as
                    # a separate short note just before the main one, carrying
                    # its transition into the main note (slide / hammer-pull /
                    # bend). Same string as the main note.
                    _gr = getattr(eff, "grace", None)
                    if _gr is not None:
                        _glead = (4.0 / max(getattr(_gr, "duration", 32) or 32, 1)) \
                            * (60.0 / tempo)
                        if dur > 0:
                            _glead = min(_glead, dur * 0.5)
                        _gnote = RsNote(
                            time=max(0.0, t - _glead),
                            string=rs_str,
                            fret=max(0, getattr(_gr, "fret", 0)),
                            sustain=0.0,
                            mute=bool(getattr(_gr, "isDead", False)),
                        )
                        _gt = _gr.transition
                        if _gt == guitarpro.GraceEffectTransition.slide:
                            _gnote.slide_to = rn.fret
                            # NB: do NOT set link_next here. link_next tells the
                            # highway to suppress the target note's gem (so a
                            # normal slide visually connects), but a grace note
                            # is an ornament before the principal note — the main
                            # note IS re-struck and must keep its gem. Setting it
                            # hid the main note and made the grace look unrendered.
                            # The grace note is zero-sustain, but the highway only
                            # draws a slide trail when sus > 0 — so the slide would
                            # be invisible. Sustain it across the lead-in gap
                            # (grace at t-_glead, main at t) so the slide renders
                            # from the grace into the still-visible main note.
                            if _glead > 0:
                                _gnote.sustain = _glead
                        elif _gt == guitarpro.GraceEffectTransition.bend:
                            _gnote.bend = 1.0
                        elif _gt == guitarpro.GraceEffectTransition.hammer:
                            # hammer-on / pull-off from the grace into the main
                            if rn.fret >= _gnote.fret:
                                rn.hammer_on = True
                            else:
                                rn.pull_off = True
                        rs_notes.append(_gnote)

                    beat_notes.append(rn)
                    existing = last_note_per_string.get(rs_str)
                    if existing is None or rn.time >= existing.time:
                        last_note_per_string[rs_str] = rn

                if not beat_notes:
                    continue

                if len(beat_notes) == 1:
                    rs_notes.append(beat_notes[0])
                else:
                    # Chord: create/reuse a chord template. Size the
                    # voicing to the highest string actually used (with
                    # a floor of 6 to keep RS schema slots populated)
                    # — on a 7/8-string track, a plain 6-string voicing
                    # should not inflate every chord template to length
                    # 7/8 with trailing `-1`s that round-trip back as
                    # spurious wide templates.
                    used = max((n.string for n in beat_notes
                                if 0 <= n.string < num_strings), default=-1)
                    width = max(6, used + 1)
                    frets = [-1] * width
                    for n in beat_notes:
                        if 0 <= n.string < width:
                            frets[n.string] = n.fret
                    fret_key = tuple(frets)

                    if fret_key not in chord_template_map:
                        # Try to get chord name from GP
                        chord_name = ""
                        if beat.effect and beat.effect.chord:
                            chord_name = beat.effect.chord.name or ""
                        idx = len(chord_templates)
                        chord_templates.append(ChordTemplate(
                            name=chord_name,
                            frets=list(frets),
                            fingers=[-1] * width,
                        ))
                        chord_template_map[fret_key] = idx

                    rs_chords.append(RsChord(
                        time=t,
                        template_idx=chord_template_map[fret_key],
                        notes=beat_notes,
                    ))

    rs_notes.sort(key=lambda n: n.time)
    rs_chords.sort(key=lambda c: c.time)

    # Resolve slide targets now that every note on each string is known. A
    # pitched slide takes its target fret from the NEXT note on the same
    # string; out-slides are unpitched (approximate ±5 frets).
    if pending_slides:
        _by_string: dict = {}
        for _n in rs_notes:
            _by_string.setdefault(_n.string, []).append(_n)
        for _c in rs_chords:
            for _n in _c.notes:
                _by_string.setdefault(_n.string, []).append(_n)
        for _lst in _by_string.values():
            _lst.sort(key=lambda n: n.time)
        for _rn, _sstr, _kind in pending_slides:
            if _kind == "pitched":
                _seq = _by_string.get(_sstr, [])
                _nxt = next((x for x in _seq if x.time > _rn.time), None)
                if _nxt is not None and _nxt.fret != _rn.fret:
                    _rn.slide_to = _nxt.fret
            elif _kind == "down":
                _rn.slide_unpitch_to = max(1, _rn.fret - 5)
            elif _kind == "up":
                _rn.slide_unpitch_to = _rn.fret + 5

    # ── Compute anchors ───────────────────────────────────────────────────
    # Exclude open strings (fret 0) — they span the full highway and
    # shouldn't cause the fret range to shift
    anchors = []
    all_timed_frets = [(n.time, n.fret) for n in rs_notes if n.fret > 0]
    for c in rs_chords:
        for cn in c.notes:
            if cn.fret > 0:
                all_timed_frets.append((cn.time, cn.fret))
    all_timed_frets.sort()

    # Always start with an anchor at the beginning
    first_fret = all_timed_frets[0][1] if all_timed_frets else 1
    anchors.append(RsAnchor(time=audio_offset, fret=max(1, first_fret - 1), width=4))

    for t, fret in all_timed_frets:
        anchor_lo = anchors[-1].fret
        anchor_hi = anchor_lo + anchors[-1].width
        if fret < anchor_lo or fret > anchor_hi:
            new_fret = max(1, fret - 1)
            if new_fret != anchors[-1].fret:
                anchors.append(RsAnchor(time=t, fret=new_fret, width=4))

    # ── Compute song length ───────────────────────────────────────────────
    # End of the final scheduled measure in *output* time. After expansion
    # this can be substantially longer than `_tick_to_seconds(last_mh.start
    # + measure_len)` would yield on the authored timeline.
    if schedule:
        last_entry = schedule[-1]
        song_length = (
            last_entry.output_start_secs
            + last_entry.duration_secs
            + audio_offset
        )
    else:
        song_length = audio_offset

    # ── Build XML ─────────────────────────────────────────────────────────
    return _build_xml(
        title=song.title or "Untitled",
        artist=song.artist or "Unknown",
        album=song.album or "",
        year=_extract_year(song),
        arrangement=arrangement_name,
        tuning=tuning,
        num_strings=num_strings,
        song_length=song_length,
        audio_offset=audio_offset,
        beats=beats,
        sections=sections,
        notes=rs_notes,
        chords=rs_chords,
        chord_templates=chord_templates,
        anchors=anchors,
        tempo=song.tempo,
    )


def _build_xml(
    title, artist, album, year, arrangement, tuning, num_strings,
    song_length, audio_offset, beats, sections, notes, chords,
    chord_templates, anchors, tempo,
) -> str:
    root = ET.Element("song", version="7")

    ET.SubElement(root, "title").text = title
    ET.SubElement(root, "arrangement").text = arrangement
    ET.SubElement(root, "offset").text = f"{audio_offset:.3f}"
    ET.SubElement(root, "songLength").text = f"{song_length:.3f}"
    ET.SubElement(root, "startBeat").text = f"{beats[0].time:.3f}" if beats else "0.000"
    ET.SubElement(root, "averageTempo").text = str(tempo)
    ET.SubElement(root, "artistName").text = artist
    ET.SubElement(root, "albumName").text = album
    ET.SubElement(root, "albumYear").text = year

    # Tuning. RS2014 schema names 6 string slots; we always emit those
    # for compatibility, and emit additional string6+ attributes (up to
    # `len(tuning)-1`) for 7+ string arrangements. Slopsmith parses
    # them; the format ignores them.
    tuning_el = ET.SubElement(root, "tuning")
    for i in range(max(6, len(tuning))):
        tuning_el.set(f"string{i}", str(tuning[i] if i < len(tuning) else 0))
    ET.SubElement(root, "capo").text = "0"

    # Ebeats
    ebeats = ET.SubElement(root, "ebeats", count=str(len(beats)))
    for b in beats:
        ET.SubElement(ebeats, "ebeat", time=f"{b.time:.3f}", measure=str(b.measure))

    # Sections
    sections_el = ET.SubElement(root, "sections", count=str(len(sections)))
    for s in sections:
        ET.SubElement(sections_el, "section",
                      name=s.name, number=str(s.number),
                      startTime=f"{s.time:.3f}")

    # Phrases — one per section
    phrases_el = ET.SubElement(root, "phrases", count=str(len(sections)))
    for i, s in enumerate(sections):
        ET.SubElement(phrases_el, "phrase",
                      disparity="0", ignore="0", maxDifficulty="0",
                      name=s.name, solo="0")

    phrase_iters = ET.SubElement(root, "phraseIterations", count=str(len(sections)))
    for i, s in enumerate(sections):
        ET.SubElement(phrase_iters, "phraseIteration",
                      time=f"{s.time:.3f}", phraseId=str(i))

    # Chord templates. RS schema names fret0..fret5; emit extra slots
    # per-template only when that specific chord actually has 7+ string
    # data, so a single 7-string chord doesn't inflate every other
    # 6-string template with synthetic `-1` slots on round-trip.
    ct_el = ET.SubElement(root, "chordTemplates", count=str(len(chord_templates)))
    for ct in chord_templates:
        width = max(6, len(ct.frets), len(ct.fingers))
        attrs = {"chordName": ct.name}
        for i in range(width):
            attrs[f"fret{i}"] = str(ct.frets[i] if i < len(ct.frets) else -1)
            attrs[f"finger{i}"] = str(ct.fingers[i] if i < len(ct.fingers) else -1)
        ET.SubElement(ct_el, "chordTemplate", **attrs)

    # Single difficulty level with all notes
    levels_el = ET.SubElement(root, "levels", count="1")
    level = ET.SubElement(levels_el, "level", difficulty="0")

    # Notes
    notes_el = ET.SubElement(level, "notes", count=str(len(notes)))
    for n in notes:
        attrs = {
            "time": f"{n.time:.3f}",
            "string": str(n.string),
            "fret": str(n.fret),
            "sustain": f"{n.sustain:.3f}",
            "bend": f"{n.bend:.1f}" if n.bend else "0",
            "hammerOn": "1" if n.hammer_on else "0",
            "pullOff": "1" if n.pull_off else "0",
            "slideTo": str(n.slide_to),
            "slideUnpitchTo": str(n.slide_unpitch_to),
            "harmonic": "1" if n.harmonic else "0",
            "harmonicPinch": "1" if n.harmonic_pinch else "0",
            "palmMute": "1" if n.palm_mute else "0",
            "mute": "1" if n.mute else "0",
            "vibrato": "1" if n.vibrato else "0",
            "tremolo": "1" if n.tremolo else "0",
            "accent": "1" if n.accent else "0",
            "linkNext": "1" if n.link_next else "0",
            "tap": "1" if n.tap else "0",
            "ignore": "0",
        }
        if getattr(n, 'staff', -1) != -1:
            attrs["staff"] = str(n.staff)
        ET.SubElement(notes_el, "note", **attrs)

    # Chords
    chords_el = ET.SubElement(level, "chords", count=str(len(chords)))
    for ch in chords:
        chord_el = ET.SubElement(chords_el, "chord",
                                 time=f"{ch.time:.3f}",
                                 chordId=str(ch.template_idx),
                                 highDensity="0", strum="down")
        for cn in ch.notes:
            ET.SubElement(chord_el, "chordNote",
                          time=f"{cn.time:.3f}",
                          string=str(cn.string),
                          fret=str(cn.fret),
                          sustain=f"{cn.sustain:.3f}",
                          bend=f"{cn.bend:.1f}" if cn.bend else "0",
                          hammerOn="1" if cn.hammer_on else "0",
                          pullOff="1" if cn.pull_off else "0",
                          slideTo=str(cn.slide_to),
                          slideUnpitchTo=str(cn.slide_unpitch_to),
                          harmonic="1" if cn.harmonic else "0",
                          harmonicPinch="1" if cn.harmonic_pinch else "0",
                          palmMute="1" if cn.palm_mute else "0",
                          mute="1" if cn.mute else "0",
                          vibrato="1" if cn.vibrato else "0",
                          tremolo="1" if cn.tremolo else "0",
                          accent="1" if cn.accent else "0",
                          linkNext="1" if cn.link_next else "0",
                          tap="1" if cn.tap else "0", ignore="0")

    # Anchors
    anchors_el = ET.SubElement(level, "anchors", count=str(len(anchors)))
    for a in anchors:
        ET.SubElement(anchors_el, "anchor",
                      time=f"{a.time:.3f}",
                      fret=str(a.fret),
                      width=str(a.width))

    # Hand shapes (empty for now)
    ET.SubElement(level, "handShapes", count="0")

    # Pretty print
    xml_str = ET.tostring(root, encoding="unicode")
    dom = minidom.parseString(xml_str)
    return dom.toprettyxml(indent="  ", encoding=None)


PIANO_INSTRUMENTS = set(range(0, 8))  # MIDI instruments 0-7 = piano family
KEYS_INSTRUMENTS = PIANO_INSTRUMENTS | set(range(16, 24)) | {80, 81, 82, 83}  # + organs + synth leads
KEYS_NAME_KEYWORDS = {"piano", "keys", "keyboard", "synth", "organ", "rhodes", "wurlitzer", "clav", "epiano"}

# GM drum mapping: MIDI note -> drum piece name
GM_DRUM_MAP = {
    35: "Kick", 36: "Kick",
    38: "Snare", 40: "Snare",
    42: "HiHat", 44: "HiHat", 46: "HiHat",
    48: "Tom1", 50: "Tom1",
    45: "Tom2", 47: "Tom2",
    41: "Tom3", 43: "Tom3",
    49: "Crash", 57: "Crash",
    51: "Ride", 59: "Ride",
}
DRUMS_NAME_KEYWORDS = {"drums", "drum", "percussion", "drum kit", "drumkit"}


def is_piano_track(track: guitarpro.Track) -> bool:
    """Detect if a GP track is a piano/keyboard instrument."""
    if track.isPercussionTrack:
        return False
    # Check MIDI instrument
    if hasattr(track, 'channel') and track.channel:
        inst = getattr(track.channel, 'instrument', -1)
        if inst in KEYS_INSTRUMENTS:
            return True
    # Check name
    name_low = track.name.lower()
    if any(kw in name_low for kw in KEYS_NAME_KEYWORDS):
        return True
    return False


def is_drum_track(track: guitarpro.Track) -> bool:
    """Detect if a GP track is a percussion/drum track."""
    if track.isPercussionTrack:
        return True
    # Check MIDI channel 10 (index 9)
    if hasattr(track, 'channel') and track.channel:
        ch = getattr(track.channel, 'channel', -1)
        if ch == 9:  # MIDI channel 10 (0-indexed)
            return True
    # Check name
    name_low = track.name.lower()
    if any(kw in name_low for kw in DRUMS_NAME_KEYWORDS):
        return True
    return False


def list_tracks(gp_path: str) -> list[dict]:
    """List all tracks in a Guitar Pro file with basic info."""
    if Path(gp_path).suffix.lower() in ('.gpx', '.gp'):
        from gp2rs_gpx import list_tracks as _gpx_list_tracks
        return _gpx_list_tracks(gp_path)
    song = guitarpro.parse(gp_path)
    tracks = []
    for i, track in enumerate(song.tracks):
        note_count = 0
        for measure in track.measures:
            for voice in measure.voices:
                for beat in voice.beats:
                    note_count += len(beat.notes)
        instrument = -1
        if hasattr(track, 'channel') and track.channel:
            instrument = getattr(track.channel, 'instrument', -1)
        tracks.append({
            "index": i,
            "name": track.name,
            "strings": len(track.strings),
            "is_percussion": track.isPercussionTrack,
            "is_piano": is_piano_track(track),
            "is_drums": is_drum_track(track),
            "is_bass": _is_bass_track(track),
            "instrument": instrument,
            "notes": note_count,
        })
    return tracks


def auto_select_tracks(gp_path: str) -> tuple[list[int], dict[int, str]]:
    """Auto-select guitar/bass/keys tracks and assign the standard arrangement names.

    Includes piano/keyboard tracks as "Keys" arrangements alongside
    guitar and bass tracks.

    Returns:
        (track_indices, name_map) — indices to include and their arrangement names
    """
    tracks = list_tracks(gp_path)
    guitar_keywords = {"guitar", "gtr", "lead", "rhythm", "rhy", "solo", "clean", "distort", "acoustic", "elec"}
    bass_keywords = {"bass"}
    skip_keywords = {"string", "choir", "brass", "brite", "flute", "violin", "cello", "horn"}

    selected = []
    for t in tracks:
        if t["notes"] == 0:
            continue

        # Drum/percussion tracks → Drums
        if t["is_drums"]:
            selected.append((t["index"], "drums"))
            continue

        # Piano/keyboard tracks → Keys
        if t["is_piano"]:
            selected.append((t["index"], "keys"))
            continue

        name_low = t["name"].lower()

        # Bass detection: trust GM instrument / pitch-based check, which covers
        # 4-, 5- and 6-string basses.
        if t["is_bass"]:
            selected.append((t["index"], "bass"))
            continue

        # Check name for skip keywords
        if any(kw in name_low for kw in skip_keywords):
            continue

        # Check name for guitar/bass keywords
        if any(kw in name_low for kw in bass_keywords):
            selected.append((t["index"], "bass"))
        elif any(kw in name_low for kw in guitar_keywords):
            selected.append((t["index"], "guitar"))
        elif 6 <= t["strings"] <= 8:
            # Generic 6/7/8-string, assume guitar (extended-range).
            selected.append((t["index"], "guitar"))

    if not selected:
        # Fallback: take all non-percussion non-empty tracks
        for t in tracks:
            if not t["is_percussion"] and t["notes"] > 0:
                role = "bass" if t["is_bass"] else "guitar"
                selected.append((t["index"], role))

    # Assign the standard arrangement names: Lead, Rhythm, Combo, Bass, Keys, Drums
    track_indices = []
    name_map = {}
    lead_count = 0
    rhythm_count = 0
    bass_count = 0
    keys_count = 0
    drums_count = 0

    for idx, role in selected:
        track_indices.append(idx)
        if role == "drums":
            drums_count += 1
            name_map[idx] = "Drums" if drums_count == 1 else f"Drums {drums_count}"
        elif role == "keys":
            keys_count += 1
            name_map[idx] = "Keys" if keys_count == 1 else f"Keys {keys_count}"
        elif role == "bass":
            bass_count += 1
            name_map[idx] = "Bass" if bass_count == 1 else f"Bass {bass_count}"
        elif lead_count == 0:
            lead_count += 1
            name_map[idx] = "Lead"
        else:
            rhythm_count += 1
            name_map[idx] = "Rhythm" if rhythm_count == 1 else f"Combo"

    return track_indices, name_map


def convert_piano_track(
    song: guitarpro.Song,
    track_index: int,
    audio_offset: float = 0.0,
    arrangement_name: str = "Keys",
    *,
    expand_repeats: bool = True,
) -> str:
    """Convert a GP piano/keyboard track to arrangement XML using MIDI encoding.

    Encodes MIDI notes into the string+fret format:
        string = midi_note // 24
        fret   = midi_note % 24

    This gives a range of 0-143, covering the full piano range within
    the 6-string x 24-fret structure. The piano highway plugin
    decodes back via: midi = string * 24 + fret.

    Honors GP repeat brackets and D.S./D.C./Coda/Fine jumps when
    ``expand_repeats`` is true — see :func:`_build_playback_schedule`.
    """
    track = song.tracks[track_index]
    tempo_map = _build_tempo_map(song)
    schedule = _build_playback_schedule(song, tempo_map, expand_repeats)
    headers = song.measureHeaders

    # ── Collect beats ────────────────────────────────────────────────
    beats = []
    for entry in schedule:
        mh = headers[entry.mh_index]
        beats.append(RsBeat(
            time=entry.output_start_secs + audio_offset,
            measure=mh.number,
        ))
        num_beats_in_measure = mh.timeSignature.numerator
        for b in range(1, num_beats_in_measure):
            sub_tick = _measure_beat_tick(mh, b)
            sub_offset_in_measure = _tick_to_seconds(sub_tick, tempo_map) \
                - entry.mh_authored_start_secs
            beats.append(RsBeat(
                time=entry.output_start_secs + sub_offset_in_measure + audio_offset,
                measure=-1,
            ))
    beats.sort(key=lambda b: b.time)

    # ── Collect sections from markers ────────────────────────────────
    sections = []
    section_counts: dict[str, int] = {}
    for entry in schedule:
        mh = headers[entry.mh_index]
        if mh.marker and mh.marker.title:
            name = mh.marker.title.strip().lower().replace(" ", "")
            section_counts[name] = section_counts.get(name, 0) + 1
            sections.append(RsSection(
                name=name,
                time=entry.output_start_secs + audio_offset,
                number=section_counts[name],
            ))
    if not sections:
        sections.append(RsSection(name="default", time=audio_offset, number=1))

    # ── Collect notes ────────────────────────────────────────────────
    rs_notes = []
    rs_chords = []
    chord_templates: list[ChordTemplate] = []
    chord_template_map: dict[tuple, int] = {}
    last_note_per_pitch: dict[tuple[int, int], RsNote] = {}  # (rs_string, rs_fret) → note, for tie sustain extension
    _prev_mh_index: int = -1  # sentinel: no previous entry

    for entry in schedule:
        # Clear the tie-tracking state on backward jumps in the playback
        # schedule (repeat loopbacks, D.S., D.C.).  A tie at the start of
        # a repeated section must not extend the last note from the previous
        # pass through that section.  Forward skips (volta alternatives,
        # al-Coda redirects) are *not* cleared because consecutive schedule
        # entries that jump forward are still adjacent in the output audio,
        # so a tie crossing such a boundary is semantically valid.
        if _prev_mh_index != -1 and entry.mh_index <= _prev_mh_index:
            last_note_per_pitch.clear()
        _prev_mh_index = entry.mh_index
        measure = track.measures[entry.mh_index]
        for voice in measure.voices:
            for beat in voice.beats:
                if not beat.notes:
                    continue

                authored_beat_secs = _tick_to_seconds(beat.start, tempo_map)
                t = (authored_beat_secs - entry.mh_authored_start_secs) \
                    + entry.output_start_secs + audio_offset
                tempo = _tempo_at_tick(beat.start, tempo_map)
                dur = _duration_to_seconds(beat.duration, tempo)

                beat_notes = []
                for note in beat.notes:
                    if note.type == guitarpro.NoteType.rest:
                        continue

                    # Get MIDI note value from the GP note
                    # In GP, note.value is the fret, and the string tuning
                    # gives the base MIDI value
                    gp_str_idx = note.string  # 1-based in GP
                    if 1 <= gp_str_idx <= len(track.strings):
                        base_midi = track.strings[gp_str_idx - 1].value
                    else:
                        base_midi = 60  # fallback to middle C
                    midi_note = base_midi + note.value

                    # Encode into the string+fret
                    rs_string = midi_note // 24
                    rs_fret = midi_note % 24

                    if note.type == guitarpro.NoteType.tie:
                        prev = last_note_per_pitch.get((rs_string, rs_fret))
                        if prev is not None and prev.time < t:
                            prev.sustain = max(prev.sustain, (t + dur) - prev.time)
                        continue

                    rn = RsNote(
                        time=t,
                        string=rs_string,
                        fret=rs_fret,
                        sustain=dur if dur > 0.15 else 0.0,
                        mute=note.type == guitarpro.NoteType.dead,
                    )

                    # Accent from velocity
                    eff = note.effect
                    if eff.accentuatedNote or eff.heavyAccentuatedNote:
                        rn.accent = True

                    beat_notes.append(rn)
                    pitch_key = (rs_string, rs_fret)
                    existing = last_note_per_pitch.get(pitch_key)
                    if existing is None or rn.time >= existing.time:
                        last_note_per_pitch[pitch_key] = rn

                if not beat_notes:
                    continue

                if len(beat_notes) == 1:
                    rs_notes.append(beat_notes[0])
                else:
                    # Piano chord: create template from MIDI-encoded positions
                    frets = [-1] * 6
                    for n in beat_notes:
                        if 0 <= n.string < 6:
                            frets[n.string] = n.fret
                    fret_key = tuple(frets)

                    if fret_key not in chord_template_map:
                        chord_name = ""
                        if beat.effect and beat.effect.chord:
                            chord_name = beat.effect.chord.name or ""
                        idx = len(chord_templates)
                        chord_templates.append(ChordTemplate(
                            name=chord_name,
                            frets=list(frets),
                            fingers=[-1] * 6,
                        ))
                        chord_template_map[fret_key] = idx

                    rs_chords.append(RsChord(
                        time=t,
                        template_idx=chord_template_map[fret_key],
                        notes=beat_notes,
                    ))

    rs_notes.sort(key=lambda n: n.time)
    rs_chords.sort(key=lambda c: c.time)

    # ── Anchors (simplified for piano — just cover the range) ────────
    anchors = [RsAnchor(time=audio_offset, fret=1, width=24)]

    # ── Song length ──────────────────────────────────────────────────
    if schedule:
        last_entry = schedule[-1]
        song_length = (
            last_entry.output_start_secs
            + last_entry.duration_secs
            + audio_offset
        )
    else:
        song_length = audio_offset

    # ── Build XML ────────────────────────────────────────────────────
    # Use all-zero tuning (piano has no tuning concept)
    return _build_xml(
        title=song.title or "Untitled",
        artist=song.artist or "Unknown",
        album=song.album or "",
        year=_extract_year(song),
        arrangement=arrangement_name,
        tuning=[0] * 6,
        num_strings=6,
        song_length=song_length,
        audio_offset=audio_offset,
        beats=beats,
        sections=sections,
        notes=rs_notes,
        chords=rs_chords,
        chord_templates=chord_templates,
        anchors=anchors,
        tempo=song.tempo,
    )


def convert_drum_track(
    song: guitarpro.Song,
    track_index: int,
    audio_offset: float = 0.0,
    arrangement_name: str = "Drums",
    *,
    expand_repeats: bool = True,
) -> str:
    """Convert a GP drum/percussion track to arrangement XML using MIDI encoding.

    Encodes MIDI drum note numbers into the string+fret format:
        string = midi_note // 24
        fret   = midi_note % 24

    The drum highway plugin decodes back via: midi = string * 24 + fret
    and maps to the appropriate drum lane (kick, snare, hi-hat, etc.).

    Honors GP repeat brackets and D.S./D.C./Coda/Fine jumps when
    ``expand_repeats`` is true — see :func:`_build_playback_schedule`.
    """
    track = song.tracks[track_index]
    tempo_map = _build_tempo_map(song)
    schedule = _build_playback_schedule(song, tempo_map, expand_repeats)
    headers = song.measureHeaders

    # ── Collect beats ────────────────────────────────────────────────
    beats = []
    for entry in schedule:
        mh = headers[entry.mh_index]
        beats.append(RsBeat(
            time=entry.output_start_secs + audio_offset,
            measure=mh.number,
        ))
        num_beats_in_measure = mh.timeSignature.numerator
        for b in range(1, num_beats_in_measure):
            sub_tick = _measure_beat_tick(mh, b)
            sub_offset_in_measure = _tick_to_seconds(sub_tick, tempo_map) \
                - entry.mh_authored_start_secs
            beats.append(RsBeat(
                time=entry.output_start_secs + sub_offset_in_measure + audio_offset,
                measure=-1,
            ))
    beats.sort(key=lambda b: b.time)

    # ── Collect sections from markers ────────────────────────────────
    sections = []
    section_counts: dict[str, int] = {}
    for entry in schedule:
        mh = headers[entry.mh_index]
        if mh.marker and mh.marker.title:
            name = mh.marker.title.strip().lower().replace(" ", "")
            section_counts[name] = section_counts.get(name, 0) + 1
            sections.append(RsSection(
                name=name,
                time=entry.output_start_secs + audio_offset,
                number=section_counts[name],
            ))
    if not sections:
        sections.append(RsSection(name="default", time=audio_offset, number=1))

    # ── Collect drum notes ───────────────────────────────────────────
    rs_notes = []
    rs_chords = []
    chord_templates: list[ChordTemplate] = []
    chord_template_map: dict[tuple, int] = {}

    for entry in schedule:
        measure = track.measures[entry.mh_index]
        for voice in measure.voices:
            for beat in voice.beats:
                if not beat.notes:
                    continue

                authored_beat_secs = _tick_to_seconds(beat.start, tempo_map)
                t = (authored_beat_secs - entry.mh_authored_start_secs) \
                    + entry.output_start_secs + audio_offset

                beat_notes = []
                for note in beat.notes:
                    if note.type == guitarpro.NoteType.rest:
                        continue

                    # For percussion tracks, the MIDI note comes from the
                    # string tuning value (each "string" = a drum piece).
                    # note.value is the fret (usually 0 for drums).
                    gp_str_idx = note.string  # 1-based
                    if 1 <= gp_str_idx <= len(track.strings):
                        midi_note = track.strings[gp_str_idx - 1].value + note.value
                    else:
                        midi_note = note.value
                    if midi_note not in GM_DRUM_MAP:
                        continue  # Skip unknown percussion sounds

                    # Encode into the string+fret
                    rs_string = midi_note // 24
                    rs_fret = midi_note % 24

                    rn = RsNote(
                        time=t,
                        string=rs_string,
                        fret=rs_fret,
                        sustain=0.0,  # Drums have no sustain
                    )

                    # Accent from velocity/effect
                    eff = note.effect
                    if eff.accentuatedNote or eff.heavyAccentuatedNote:
                        rn.accent = True
                    # Ghost notes: mark as mute (low velocity)
                    if eff.ghostNote:
                        rn.mute = True

                    beat_notes.append(rn)

                if not beat_notes:
                    continue

                if len(beat_notes) == 1:
                    rs_notes.append(beat_notes[0])
                else:
                    # Multiple drum hits at same time → chord
                    frets = [-1] * 6
                    for n in beat_notes:
                        if 0 <= n.string < 6:
                            frets[n.string] = n.fret
                    fret_key = tuple(frets)

                    if fret_key not in chord_template_map:
                        idx = len(chord_templates)
                        chord_templates.append(ChordTemplate(
                            name="",
                            frets=list(frets),
                            fingers=[-1] * 6,
                        ))
                        chord_template_map[fret_key] = idx

                    rs_chords.append(RsChord(
                        time=t,
                        template_idx=chord_template_map[fret_key],
                        notes=beat_notes,
                    ))

    rs_notes.sort(key=lambda n: n.time)
    rs_chords.sort(key=lambda c: c.time)

    # ── Anchors (simplified for drums) ───────────────────────────────
    anchors = [RsAnchor(time=audio_offset, fret=1, width=24)]

    # ── Song length ──────────────────────────────────────────────────
    if schedule:
        last_entry = schedule[-1]
        song_length = (
            last_entry.output_start_secs
            + last_entry.duration_secs
            + audio_offset
        )
    else:
        song_length = audio_offset

    # ── Build XML ────────────────────────────────────────────────────
    return _build_xml(
        title=song.title or "Untitled",
        artist=song.artist or "Unknown",
        album=song.album or "",
        year=_extract_year(song),
        arrangement=arrangement_name,
        tuning=[0] * 6,
        num_strings=6,
        song_length=song_length,
        audio_offset=audio_offset,
        beats=beats,
        sections=sections,
        notes=rs_notes,
        chords=rs_chords,
        chord_templates=chord_templates,
        anchors=anchors,
        tempo=song.tempo,
    )


def convert_drum_track_to_drumtab(
    song: guitarpro.Song,
    track_index: int,
    audio_offset: float = 0.0,
    arrangement_name: str = "Drums",
    *,
    expand_repeats: bool = True,
    out_unmapped: dict[int, dict] | None = None,
) -> dict:
    """Convert a GP drum/percussion track to a `drum_tab.json` dict.

    Returns the payload documented in `docs/sloppak-spec.md` §5.3:

        {"version": 1, "name": str,
         "kit": [{"id": piece, "name": label}, ...],
         "hits": [{"t": float, "p": piece, "v": int, "g"?: bool,
                   "f"?: bool, "k"?: float}, ...]}

    Velocity is preserved verbatim (pyguitarpro uses MIDI 1-127). Ghost notes
    are surfaced as `g: true` (not as a velocity penalty), flams as `f: true`
    via `NoteEffect.isGrace`. Hi-hat openness is derived from the MIDI note
    number (42 closed / 46 open / 44 pedal) since GP stores those on distinct
    drum strings. Unknown percussion sounds (cowbell, tambourine etc.) are
    skipped — round-tripping them would require teaching `lib/drums.py` first.
    Callers can pass an empty dict as ``out_unmapped`` to receive a per-MIDI
    record of every skipped note (``{midi: {"count": int, "times": [...]}}``,
    times capped at 100 samples per note) so they can surface a warning or
    offer a manual mapping UI.

    Honours GP repeat brackets and D.S./D.C./Coda/Fine jumps when
    ``expand_repeats`` is true — same `_build_playback_schedule` machinery
    used by the guitar/bass/keys/legacy-drum-XML converters above.
    """
    # Imported lazily so an environment without lib/drums.py (older worktree
    # checkout) still loads gp2rs successfully.
    import drums as drums_mod

    track = song.tracks[track_index]
    tempo_map = _build_tempo_map(song)
    schedule = _build_playback_schedule(song, tempo_map, expand_repeats)

    hits: list[dict] = []
    pieces_seen: dict[str, str] = {}  # piece-id → display name

    for entry in schedule:
        measure = track.measures[entry.mh_index]
        for voice in measure.voices:
            for beat in voice.beats:
                if not beat.notes:
                    continue

                authored_beat_secs = _tick_to_seconds(beat.start, tempo_map)
                t = (
                    (authored_beat_secs - entry.mh_authored_start_secs)
                    + entry.output_start_secs
                    + audio_offset
                )

                for note in beat.notes:
                    if note.type == guitarpro.NoteType.rest:
                        continue

                    # Percussion tracks: MIDI note is the string's tuning
                    # value (each "string" pins a drum piece) + fret offset.
                    gp_str_idx = note.string
                    if 1 <= gp_str_idx <= len(track.strings):
                        midi_note = track.strings[gp_str_idx - 1].value + note.value
                    else:
                        midi_note = note.value

                    piece = drums_mod.midi_to_piece(midi_note)
                    if piece is None:
                        # Unmapped percussion sound. Record it for the
                        # optional out-parameter so the caller can surface
                        # a "these notes were dropped" warning to the user
                        # (with the option to map them by hand). The
                        # default path is still to skip silently for
                        # backward compatibility with callers that don't
                        # opt in.
                        if out_unmapped is not None:
                            # NB: do NOT shadow the outer `entry` loop
                            # variable from `for entry in schedule:`.
                            unmapped_rec = out_unmapped.setdefault(
                                int(midi_note), {"count": 0, "times": []})
                            unmapped_rec["count"] += 1
                            if len(unmapped_rec["times"]) < 100:
                                unmapped_rec["times"].append(round(t, 3))
                        continue

                    hit: dict = {"t": round(t, 3), "p": piece}

                    # Velocity: GP stores 1-127 MIDI velocity directly; default
                    # is 95 (Velocities.default). Pass through verbatim,
                    # clamping defensively so a corrupt file can't poison the
                    # wire format.
                    vel = int(getattr(note, "velocity", 0) or 0)
                    if 1 <= vel <= 127:
                        hit["v"] = vel

                    eff = note.effect
                    # Ghost — explicit flag on the GP effect. Accent flag is
                    # already reflected in the higher velocity, so we don't
                    # need a separate `ac` field on the hit.
                    if getattr(eff, "ghostNote", False):
                        hit["g"] = True
                    # Flam / grace note — pyguitarpro models grace notes as a
                    # GraceEffect dangling off NoteEffect; `isGrace` is the
                    # convenience boolean. Drum charts use grace almost
                    # exclusively for flams, so map directly.
                    if getattr(eff, "isGrace", False):
                        hit["f"] = True

                    # Cymbal choke — GP doesn't have a first-class field for
                    # it, but staccato on a cymbal piece is the closest
                    # idiomatic encoding. Treat it as a short choke tail
                    # (~80 ms) so the highway can render the fade-out.
                    if (
                        drums_mod.piece_category(piece) == "cymbal"
                        and getattr(eff, "staccato", False)
                    ):
                        hit["k"] = 0.08

                    hits.append(hit)

                    if piece not in pieces_seen:
                        # Title-case piece-id for the kit legend name; user-
                        # facing labels are overridden at the lane-config
                        # level anyway.
                        pieces_seen[piece] = piece.replace("_", " ").title()

    hits.sort(key=lambda h: h["t"])

    # Times for unmapped notes were collected in beat-iteration order;
    # multi-voice measures can produce out-of-order beats, so sort each
    # entry's `times` list chronologically before returning to the caller.
    if out_unmapped is not None:
        for _rec in out_unmapped.values():
            _rec["times"].sort()

    return {
        "version": drums_mod.SCHEMA_VERSION,
        "name": arrangement_name,
        "kit": [{"id": pid, "name": name} for pid, name in pieces_seen.items()],
        "hits": hits,
    }


def convert_file(
    gp_path: str,
    output_dir: str,
    track_indices: list[int] | None = None,
    audio_offset: float = 0.0,
    arrangement_names: dict[int, str] | None = None,
    force_standard_tuning: bool = False,
    *,
    expand_repeats: bool = True,
) -> list[str]:
    """Convert a GP file to arrangement XMLs.

    Args:
        gp_path: Path to .gp5/.gp4/.gp3 file
        output_dir: Directory to write XML files
        track_indices: Which tracks to convert (None = auto-select)
        audio_offset: Seconds to add for audio sync
        arrangement_names: Override arrangement names {track_idx: name}
        force_standard_tuning: Force E standard tuning (frets unchanged)
        expand_repeats: When true (default), the converter walks the GP
            playback graph — replaying repeat brackets, honoring volta
            (1st/2nd-ending) markers, and following D.S./D.C./Coda/Fine
            jumps — so the emitted arrangement matches a linear audio file
            playing the song as performed. Pass false to recover the legacy
            as-written behavior (each measure emitted exactly once).

    Returns:
        List of output XML file paths
    """
    if Path(gp_path).suffix.lower() in ('.gpx', '.gp'):
        from gp2rs_gpx import convert_file as _gpx_convert_file
        return _gpx_convert_file(
            gp_path, output_dir, track_indices, audio_offset,
            arrangement_names, force_standard_tuning,
            expand_repeats=expand_repeats,
        )
    song = guitarpro.parse(gp_path)
    out = Path(output_dir)
    out.mkdir(parents=True, exist_ok=True)

    if track_indices is None:
        # Auto-select: include all tracks that auto_select_tracks would pick
        track_indices, auto_names = auto_select_tracks(gp_path)
        if not arrangement_names:
            arrangement_names = auto_names

    names = arrangement_names or {}
    output_files = []
    # Counts of auto-named guitar/bass arrangements so multiple guitars get
    # distinct RS roles (Lead, Rhythm, Combo, …) instead of all "Lead".
    _role_counts: dict[str, int] = {}

    for idx in track_indices:
        track = song.tracks[idx]
        arr_name = names.get(idx, "")

        # Route drum/percussion tracks through drum converter
        if is_drum_track(track) or (arr_name and arr_name.lower().startswith("drums")):
            xml_str = convert_drum_track(
                song, idx, audio_offset, arr_name or "Drums",
                expand_repeats=expand_repeats,
            )
        # Route piano/keyboard tracks through the MIDI-encoding converter
        elif is_piano_track(track) or (arr_name and arr_name.lower().startswith("keys")):
            xml_str = convert_piano_track(
                song, idx, audio_offset, arr_name or "Keys",
                expand_repeats=expand_repeats,
            )
        else:
            # Assign a distinct RS role when the caller didn't name this
            # guitar/bass track, so multiple guitars don't all default to
            # "Lead" inside convert_track.
            if not arr_name:
                low = track.name.lower()
                if _is_bass_track(track) or "bass" in low:
                    _bc = _role_counts.get("bass", 0)
                    _role_counts["bass"] = _bc + 1
                    arr_name = "Bass" if _bc == 0 else f"Bass {_bc + 1}"
                else:
                    _gc = _role_counts.get("guitar", 0)
                    _role_counts["guitar"] = _gc + 1
                    _roles = ("Lead", "Rhythm", "Combo")
                    arr_name = _roles[_gc] if _gc < len(_roles) else f"Combo {_gc - 1}"
            xml_str = convert_track(
                song, idx, audio_offset, arr_name, force_standard_tuning,
                expand_repeats=expand_repeats,
            )

        safe_name = track.name.strip().replace(" ", "_").replace("/", "_")
        filename = f"{safe_name}_{arr_name or 'arr'}.xml"
        filepath = out / filename
        filepath.write_text(xml_str)
        output_files.append(str(filepath))

    return output_files
