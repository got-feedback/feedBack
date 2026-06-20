"""Tests for lib/gp2rs.py tempo/tick math helpers + playback-schedule walker.

The math helpers are fixture-free: hand-constructed `TempoEvent` lists and
integer tick / string inputs. The playback-schedule tests use
`SimpleNamespace` mocks shaped like `guitarpro.MeasureHeader` / `Song` —
the schedule walker only reads a small set of attributes, so we don't need
real .gp files on disk.

See issue #46 (tempo math) and the GP repeat-expansion PR for the schedule
walker.
"""

import xml.etree.ElementTree as ET
from types import SimpleNamespace
from unittest import mock

import guitarpro
import pytest

from gp2rs import (
    GP_TICKS_PER_QUARTER,
    TempoEvent,
    _build_playback_schedule,
    _compute_tuning,
    _extract_year,
    _gp_string_to_rs,
    _is_bass_track,
    _standard_tuning_for,
    _tempo_at_tick,
    _tick_to_seconds,
    convert_drum_track,
    convert_piano_track,
    convert_track,
)


def _fake_track(string_midis, instrument=24):
    """Lightweight Track stand-in for the bass-detection / tuning helpers.

    `string_midis` is GP-order (high → low). The real Track is a heavy
    dataclass; the helpers only read `.strings[].number/.value` and
    `.channel.instrument`, so SimpleNamespace is enough.
    """
    strings = [SimpleNamespace(number=i + 1, value=v)
               for i, v in enumerate(string_midis)]
    channel = SimpleNamespace(instrument=instrument)
    return SimpleNamespace(strings=strings, channel=channel)


def _minimal_converter_song(numerator=4, denominator=4, tempo_changes=None):
    """Fake song shape sufficient for converter-level XML tests."""
    strings = [
        SimpleNamespace(number=1, value=64),
        SimpleNamespace(number=2, value=59),
        SimpleNamespace(number=3, value=55),
        SimpleNamespace(number=4, value=50),
        SimpleNamespace(number=5, value=45),
        SimpleNamespace(number=6, value=40),
    ]
    beats = [SimpleNamespace(start=0, notes=[], effect=None)]
    for tick, tempo in tempo_changes or []:
        beats.append(SimpleNamespace(
            start=tick,
            notes=[],
            effect=SimpleNamespace(
                mixTableChange=SimpleNamespace(
                    tempo=SimpleNamespace(value=tempo),
                ),
            ),
        ))
    measure = SimpleNamespace(
        voices=[SimpleNamespace(beats=beats)],
    )
    header = SimpleNamespace(
        start=0,
        number=1,
        timeSignature=SimpleNamespace(
            numerator=numerator,
            denominator=SimpleNamespace(value=denominator),
        ),
        isRepeatOpen=False,
        repeatClose=-1,
        repeatAlternative=0,
        direction=None,
        fromDirection=None,
        marker=None,
    )
    track = SimpleNamespace(
        name="Guitar",
        strings=strings,
        channel=SimpleNamespace(instrument=24),
        measures=[measure],
        isPercussionTrack=False,
    )
    return SimpleNamespace(
        title="Test Song",
        artist="Test Artist",
        album="",
        copyright="",
        subtitle="",
        tempo=120,
        measureHeaders=[header],
        tracks=[track],
    )


def _converter_ebeats(converter, numerator, denominator, tempo_changes=None):
    song = _minimal_converter_song(
        numerator=numerator,
        denominator=denominator,
        tempo_changes=tempo_changes,
    )
    root = ET.fromstring(converter(song, 0))
    ebeats = root.find("ebeats")
    assert ebeats is not None, "Converter output missing <ebeats> node"
    return ebeats


def _assert_ebeats(converter, numerator, denominator, expected_times, tempo_changes=None):
    ebeats = _converter_ebeats(converter, numerator, denominator, tempo_changes)

    assert [ebeat.get("time") for ebeat in ebeats] == expected_times
    assert [ebeat.get("measure") for ebeat in ebeats] == [
        "1",
        *["-1"] * (len(expected_times) - 1),
    ]


@pytest.mark.parametrize("converter", [
    convert_track,
    convert_piano_track,
    convert_drum_track,
])
def test_converter_ebeats_use_time_signature_denominator_for_6_8(converter):
    _assert_ebeats(converter, 6, 8, [
        "0.000",
        "0.250",
        "0.500",
        "0.750",
        "1.000",
        "1.250",
    ])


@pytest.mark.parametrize("converter", [
    convert_track,
    convert_piano_track,
    convert_drum_track,
])
def test_converter_ebeats_preserve_quarter_note_spacing_for_4_4(converter):
    _assert_ebeats(converter, 4, 4, [
        "0.000",
        "0.500",
        "1.000",
        "1.500",
    ])


@pytest.mark.parametrize("converter", [
    convert_track,
    convert_piano_track,
    convert_drum_track,
])
@pytest.mark.parametrize(("numerator", "denominator", "expected_times"), [
    pytest.param(12, 8, [
        "0.000",
        "0.250",
        "0.500",
        "0.750",
        "1.000",
        "1.250",
        "1.500",
        "1.750",
        "2.000",
        "2.250",
        "2.500",
        "2.750",
    ], id="12_8"),
    pytest.param(3, 8, [
        "0.000",
        "0.250",
        "0.500",
    ], id="3_8"),
    pytest.param(2, 2, [
        "0.000",
        "1.000",
    ], id="2_2"),
    pytest.param(5, 16, [
        "0.000",
        "0.125",
        "0.250",
        "0.375",
        "0.500",
    ], id="5_16"),
])
def test_converter_ebeats_scale_by_denominator_for_other_meters(
    converter,
    numerator,
    denominator,
    expected_times,
):
    _assert_ebeats(converter, numerator, denominator, expected_times)


@pytest.mark.parametrize("converter", [
    convert_track,
    convert_piano_track,
    convert_drum_track,
])
def test_converter_ebeats_apply_internal_tempo_changes_in_6_8(converter):
    _assert_ebeats(
        converter,
        6,
        8,
        [
            "0.000",
            "0.250",
            "0.500",
            "1.000",
            "1.500",
            "2.000",
        ],
        tempo_changes=[
            (GP_TICKS_PER_QUARTER, 60),
        ],
    )


# ── _tick_to_seconds ─────────────────────────────────────────────────────────

def test_tick_to_seconds_at_zero():
    # Tick 0 is always time 0 regardless of tempo.
    tempo_map = [TempoEvent(tick=0, tempo=120.0)]
    assert _tick_to_seconds(0, tempo_map) == 0.0


def test_tick_to_seconds_constant_tempo():
    # At 120 BPM with 960 ticks/quarter, one quarter = 0.5s, so 1920 ticks = 1.0s.
    tempo_map = [TempoEvent(tick=0, tempo=120.0)]
    assert _tick_to_seconds(GP_TICKS_PER_QUARTER, tempo_map) == pytest.approx(0.5)
    assert _tick_to_seconds(2 * GP_TICKS_PER_QUARTER, tempo_map) == pytest.approx(1.0)
    assert _tick_to_seconds(4 * GP_TICKS_PER_QUARTER, tempo_map) == pytest.approx(2.0)


def test_tick_to_seconds_tempo_change_accumulates():
    # 4 quarter notes at 120 BPM = 2.0s, then 4 at 60 BPM = 4.0s. Total 6.0s.
    tempo_map = [
        TempoEvent(tick=0, tempo=120.0),
        TempoEvent(tick=4 * GP_TICKS_PER_QUARTER, tempo=60.0),
    ]
    # At the tempo-change boundary, time is 2.0 (4 beats at 120).
    assert _tick_to_seconds(4 * GP_TICKS_PER_QUARTER, tempo_map) == pytest.approx(2.0)
    # 4 more beats at 60 BPM = 4.0s. Total 6.0.
    assert _tick_to_seconds(8 * GP_TICKS_PER_QUARTER, tempo_map) == pytest.approx(6.0)


def test_tick_to_seconds_extrapolates_past_last_event():
    # Ticks past the last tempo event use that last event's tempo.
    tempo_map = [
        TempoEvent(tick=0, tempo=120.0),
        TempoEvent(tick=1000, tempo=240.0),
    ]
    # First 1000 ticks at 120 BPM = 1000/960 * 0.5 = 0.5208...s
    # Next 1000 ticks at 240 BPM = 1000/960 * 0.25 = 0.2604...s
    expected = (1000 / GP_TICKS_PER_QUARTER) * (60.0 / 120.0) + \
               (1000 / GP_TICKS_PER_QUARTER) * (60.0 / 240.0)
    assert _tick_to_seconds(2000, tempo_map) == pytest.approx(expected)


# ── _tempo_at_tick ───────────────────────────────────────────────────────────

def test_tempo_at_tick_before_first_event_returns_first_tempo():
    tempo_map = [TempoEvent(tick=100, tempo=120.0)]
    # Tick 0 is before the "first" event (which is at 100). Function starts
    # result at tempo_map[0].tempo and only updates when event.tick <= tick.
    assert _tempo_at_tick(0, tempo_map) == 120.0


def test_tempo_at_tick_at_exact_event():
    tempo_map = [
        TempoEvent(tick=0, tempo=120.0),
        TempoEvent(tick=500, tempo=200.0),
    ]
    assert _tempo_at_tick(500, tempo_map) == 200.0


def test_tempo_at_tick_between_events():
    tempo_map = [
        TempoEvent(tick=0, tempo=120.0),
        TempoEvent(tick=1000, tempo=200.0),
    ]
    assert _tempo_at_tick(500, tempo_map) == 120.0


def test_tempo_at_tick_past_last_event():
    tempo_map = [
        TempoEvent(tick=0, tempo=120.0),
        TempoEvent(tick=100, tempo=60.0),
        TempoEvent(tick=500, tempo=180.0),
    ]
    assert _tempo_at_tick(999999, tempo_map) == 180.0


def test_tempo_at_tick_single_event_map():
    tempo_map = [TempoEvent(tick=0, tempo=90.0)]
    assert _tempo_at_tick(0, tempo_map) == 90.0
    assert _tempo_at_tick(100000, tempo_map) == 90.0


# ── _gp_string_to_rs ─────────────────────────────────────────────────────────
# GP string numbering: 1 = highest pitch, N = lowest
# RS string numbering: 0 = lowest pitch (low E on a guitar)
# Transform: rs_index = num_strings - gp_string

@pytest.mark.parametrize("gp_string,num_strings,rs_index", [
    # 6-string guitar: GP 1 (high e) -> RS 5, GP 6 (low E) -> RS 0
    (1, 6, 5),
    (2, 6, 4),
    (3, 6, 3),
    (4, 6, 2),
    (5, 6, 1),
    (6, 6, 0),
    # 4-string bass: GP 1 (G) -> RS 3, GP 4 (E) -> RS 0
    (1, 4, 3),
    (2, 4, 2),
    (3, 4, 1),
    (4, 4, 0),
    # 7-string guitar: GP 1 (high e) -> RS 6, GP 7 (low B) -> RS 0
    (1, 7, 6),
    (7, 7, 0),
])
def test_gp_string_to_rs(gp_string, num_strings, rs_index):
    assert _gp_string_to_rs(gp_string, num_strings) == rs_index


# ── _extract_year ────────────────────────────────────────────────────────────

@pytest.mark.parametrize("copyright_text, expected", [
    ("1998 Goat Head Music, WB Music Corp, USA", "1998"),
    ("Copyright 2024 Some Label", "2024"),
    ("Released in 1972 by ABC Records", "1972"),
    ("No year present anywhere", ""),
    ("", ""),
    (None, ""),
    # 4-digit numbers outside the [1800-2099] window aren't years.
    ("Catalog 4521", ""),
])
def test_extract_year(copyright_text, expected):
    song = SimpleNamespace(copyright=copyright_text, subtitle=None)
    assert _extract_year(song) == expected


def test_extract_year_falls_back_to_subtitle():
    song = SimpleNamespace(copyright=None, subtitle="From the 2010 album")
    assert _extract_year(song) == "2010"


# ── _is_bass_track ───────────────────────────────────────────────────────────

@pytest.mark.parametrize("instrument, expected", [
    # GM Bass family is 32-39 inclusive. Lock the boundaries so an
    # off-by-one in the program check (e.g. `32 < instrument < 39`
    # vs `32 <= instrument <= 39`) doesn't silently regress.
    (32, True),   # Acoustic Bass — lower edge of bass family
    (33, True),   # Electric Bass (finger)
    (39, True),   # Synth Bass 2 — upper edge of bass family
    (31, False),  # Guitar Harmonics — just below bass family
    (40, False),  # Violin — just above bass family
])
def test_is_bass_track_gm_program_boundaries(instrument, expected):
    # Top string is high (MIDI 64 = E4) so non-bass programs can't
    # accidentally pass through the pitch fallback.
    track = _fake_track([64, 59, 55, 50], instrument=instrument)
    assert _is_bass_track(track) is expected


def test_is_bass_track_pitch_fallback_for_4_string_bass():
    # Standard 4-string bass G2 D2 A1 E1 with the program mis-set to
    # piano (0) — common GP file authoring artefact.
    track = _fake_track([43, 38, 33, 28], instrument=0)
    assert _is_bass_track(track) is True


def test_is_bass_track_detects_5_string_bass():
    # 5-string bass with B0 added below E1, program mis-set to acoustic guitar.
    track = _fake_track([43, 38, 33, 28, 23], instrument=24)
    assert _is_bass_track(track) is True


def test_is_bass_track_rejects_standard_guitar():
    # E4 B3 G3 D3 A2 E2 — top string > MIDI 48, no bass program.
    track = _fake_track([64, 59, 55, 50, 45, 40], instrument=24)
    assert _is_bass_track(track) is False


def test_is_bass_track_rejects_7_string_detuned_guitar():
    # 7-string drop A: top still high (D4=62), low extends to A1 (33).
    track = _fake_track([62, 57, 53, 48, 43, 38, 33], instrument=29)
    assert _is_bass_track(track) is False


def test_is_bass_track_handles_empty_strings():
    track = _fake_track([], instrument=24)
    assert _is_bass_track(track) is False


# ── _standard_tuning_for ────────────────────────────────────────────────────

@pytest.mark.parametrize("num, is_bass, expected", [
    (6, False, [64, 59, 55, 50, 45, 40]),
    (7, False, [64, 59, 55, 50, 45, 40, 35]),
    (8, False, [64, 59, 55, 50, 45, 40, 35, 30]),
    (4, True,  [43, 38, 33, 28]),
    (5, True,  [43, 38, 33, 28, 23]),
    (6, True,  [48, 43, 38, 33, 28, 23]),
])
def test_standard_tuning_for(num, is_bass, expected):
    assert _standard_tuning_for(num, is_bass) == expected


def test_standard_tuning_for_pads_beyond_8_string_guitar():
    # Pathological 9-string falls back to descending fourths.
    out = _standard_tuning_for(9, is_bass=False)
    assert len(out) == 9
    assert out[:8] == [64, 59, 55, 50, 45, 40, 35, 30]
    # Next entry extends down by a fourth (5 semitones).
    assert out[8] == 30 - 5


# ── _compute_tuning ─────────────────────────────────────────────────────────

def test_compute_tuning_standard_6_string_guitar_returns_zeros():
    track = _fake_track([64, 59, 55, 50, 45, 40], instrument=24)
    assert _compute_tuning(track) == [0, 0, 0, 0, 0, 0]


def test_compute_tuning_eb_standard_guitar_returns_minus_one_per_string():
    track = _fake_track([63, 58, 54, 49, 44, 39], instrument=24)
    assert _compute_tuning(track) == [-1, -1, -1, -1, -1, -1]


def test_compute_tuning_7_string_preserves_length():
    track = _fake_track([64, 59, 55, 50, 45, 40, 35], instrument=24)
    assert _compute_tuning(track) == [0, 0, 0, 0, 0, 0, 0]


def test_compute_tuning_5_string_low_b_bass_returns_zeros():
    # Low-B 5-string standard: G2 D2 A1 E1 B0 (MIDI 43 38 33 28 23).
    track = _fake_track([43, 38, 33, 28, 23], instrument=33)
    assert _compute_tuning(track) == [0, 0, 0, 0, 0]


def test_compute_tuning_5_string_high_c_bass_returns_zeros():
    # High-C 5-string standard: C3 G2 D2 A1 E1 (MIDI 48 43 38 33 28).
    # Previously this miscomputed as +5 on every string because the
    # function always picked the low-B reference.
    track = _fake_track([48, 43, 38, 33, 28], instrument=33)
    assert _compute_tuning(track) == [0, 0, 0, 0, 0]


def test_standard_tuning_for_5_string_bass_picks_high_c_when_top_is_c():
    # Explicit hint: top string at MIDI 48 → high-C variant.
    assert _standard_tuning_for(5, is_bass=True, top_midi=48) == [48, 43, 38, 33, 28]


def test_standard_tuning_for_5_string_bass_defaults_to_low_b():
    # Without a hint, fall back to the more common low-B layout.
    assert _standard_tuning_for(5, is_bass=True) == [43, 38, 33, 28, 23]


def test_compute_tuning_6_string_bass_routes_to_bass_table():
    track = _fake_track([48, 43, 38, 33, 28, 23], instrument=33)
    assert _compute_tuning(track) == [0, 0, 0, 0, 0, 0]


def test_compute_tuning_drop_d_guitar():
    # Drop D: low E2 (40) → D2 (38), other strings unchanged. RS tuning
    # is stored low→high, so index 0 is the lowest string.
    track = _fake_track([64, 59, 55, 50, 45, 38], instrument=24)
    assert _compute_tuning(track) == [-2, 0, 0, 0, 0, 0]


# ── _build_playback_schedule ─────────────────────────────────────────────────
# Mocks `guitarpro.MeasureHeader` and `guitarpro.Song` with `SimpleNamespace`.
# The schedule walker reads only:
#   - song.measureHeaders[i].start, .timeSignature.numerator/.denominator.value,
#     .isRepeatOpen, .repeatClose, .repeatAlternative, .direction, .fromDirection
# That's all the fixture surface we need to construct.

def _make_song(headers):
    return SimpleNamespace(measureHeaders=headers)


def _make_header(
    start_quarters: float,
    numerator: int = 4,
    denominator: int = 4,
    *,
    is_repeat_open: bool = False,
    repeat_close: int = -1,
    repeat_alt: int = 0,
    direction_name: str | None = None,
    from_direction_name: str | None = None,
):
    """Build a mock MeasureHeader. ``start_quarters`` is in quarter-notes
    from the song start; converted to ticks internally."""
    return SimpleNamespace(
        start=round(start_quarters * GP_TICKS_PER_QUARTER),
        number=0,  # unused by schedule walker; converters set it from mh.number
        timeSignature=SimpleNamespace(
            numerator=numerator,
            denominator=SimpleNamespace(value=denominator),
        ),
        isRepeatOpen=is_repeat_open,
        repeatClose=repeat_close,
        repeatAlternative=repeat_alt,
        direction=SimpleNamespace(name=direction_name) if direction_name else None,
        fromDirection=SimpleNamespace(name=from_direction_name) if from_direction_name else None,
        marker=None,
    )


def _ids(schedule):
    """Compact `(mh_index, pass_index)` summary for assertions."""
    return [(e.mh_index, e.pass_index) for e in schedule]


# Standard tempo map: 120 BPM constant → one 4/4 measure = 2.0 s.
_TM_120 = [TempoEvent(tick=0, tempo=120.0)]


def test_schedule_no_repeats_no_directions():
    # 4 plain measures → 4 entries, pass=0 each, output times monotonic at 2 s/measure.
    headers = [_make_header(i * 4) for i in range(4)]
    schedule = _build_playback_schedule(_make_song(headers), _TM_120)
    assert _ids(schedule) == [(0, 0), (1, 0), (2, 0), (3, 0)]
    assert [round(e.output_start_secs, 3) for e in schedule] == [0.0, 2.0, 4.0, 6.0]


def test_schedule_simple_repeat():
    # ||: A | B :||x2 → 4 entries: A0 B0 A1 B1
    headers = [
        _make_header(0, is_repeat_open=True),   # A
        _make_header(4, repeat_close=1),         # B (x2: 1 additional rep)
    ]
    schedule = _build_playback_schedule(_make_song(headers), _TM_120)
    assert _ids(schedule) == [(0, 0), (1, 0), (0, 1), (1, 1)]
    assert [round(e.output_start_secs, 3) for e in schedule] == [0.0, 2.0, 4.0, 6.0]


def test_schedule_with_volta():
    # ||: A | B :|1.| C |2.| D ||  — C plays pass 0 only, D plays pass 1 only.
    # Volta C: repeatAlternative bit 0 set; close-of-pass-0 is at C itself
    # (repeatClose=1 because the bracket repeats once total, so 2 passes).
    headers = [
        _make_header(0, is_repeat_open=True),         # A
        _make_header(4),                                # B
        _make_header(8, repeat_alt=0b01),               # C (1st ending)
        _make_header(12, repeat_alt=0b10, repeat_close=1),  # D (2nd ending, closes)
    ]
    schedule = _build_playback_schedule(_make_song(headers), _TM_120)
    # Pass 0: A B C (skip D). Pass 1: A B D (skip C).
    assert _ids(schedule) == [
        (0, 0), (1, 0), (2, 0),
        (0, 1), (1, 1), (3, 1),
    ]


def test_schedule_sequential_groups():
    # ||: A :||x2 | B | ||: C :||x3  → 2xA, B, 3xC
    headers = [
        _make_header(0, is_repeat_open=True, repeat_close=1),  # A (x2)
        _make_header(4),                                          # B
        _make_header(8, is_repeat_open=True, repeat_close=2),  # C (x3)
    ]
    schedule = _build_playback_schedule(_make_song(headers), _TM_120)
    assert _ids(schedule) == [
        (0, 0), (0, 1),       # 2xA
        (1, 0),                # B
        (2, 0), (2, 1), (2, 2),  # 3xC
    ]


def test_schedule_da_capo_al_fine():
    # A | B(Fine) | C | D(D.C. al Fine) → A B C D A B (stop at Fine on pass 2)
    headers = [
        _make_header(0),                                            # A
        _make_header(4, direction_name="Fine"),                     # B
        _make_header(8),                                            # C
        _make_header(12, from_direction_name="Da Capo al Fine"),    # D
    ]
    schedule = _build_playback_schedule(_make_song(headers), _TM_120)
    assert _ids(schedule) == [(0, 0), (1, 0), (2, 0), (3, 0), (0, 0), (1, 0)]


def test_schedule_dal_segno_al_coda():
    # A | B(Segno) | C(To Coda) | D | E(D.S. al Coda) | F(Coda) | G
    # → A B C D E B C F G  (jump to Segno, replay until Da Coda redirect, jump to Coda)
    headers = [
        _make_header(0),                                            # A
        _make_header(4, direction_name="Segno"),                    # B
        _make_header(8, from_direction_name="Da Coda"),             # C (To Coda)
        _make_header(12),                                           # D
        _make_header(16, from_direction_name="Da Segno al Coda"),   # E
        _make_header(20, direction_name="Coda"),                    # F
        _make_header(24),                                           # G
    ]
    schedule = _build_playback_schedule(_make_song(headers), _TM_120)
    # First pass: A B C D E → at E, jump back to Segno (B). Now jumped_back=True,
    # stop_at="coda". Replay from B: B is fine (no Da Coda). C has Da Coda →
    # redirect to F. Then G plays. Final: A B C D E B F G.
    assert _ids(schedule) == [(0, 0), (1, 0), (2, 0), (3, 0), (4, 0), (1, 0), (5, 0), (6, 0)]


def test_schedule_da_capo_inside_repeat_block_fires_immediately():
    # ||: A | B(D.C. al Fine) :||x2 | C(Fine) | D
    # A D.C. authored *inside* a repeat block must still fire the first time
    # we reach the measure carrying it — without the repeat completing the
    # remaining passes. This is the regression the inline repeat sub-loop
    # used to miss: it would silently complete the bracket and the D.C.
    # never triggered.
    headers = [
        _make_header(0, is_repeat_open=True),                                # A
        _make_header(4, repeat_close=1, from_direction_name="Da Capo al Fine"),  # B
        _make_header(8, direction_name="Fine"),                              # C
        _make_header(12),                                                    # D
    ]
    schedule = _build_playback_schedule(_make_song(headers), _TM_120)
    # First pass through the bracket plays A B once; the D.C. fires at the
    # end of B before the second pass; the jumped-back walk plays A B C and
    # stops at Fine.
    assert _ids(schedule) == [(0, 0), (1, 0), (0, 0), (1, 0), (2, 0)]


def test_schedule_da_capo_suppresses_inner_repeats():
    # ||: A :||x2 | B(D.C.) → first pass plays the bracket (A A B), then D.C.
    # jumps back to measure 0 and replays inner repeat *once* (A B).
    headers = [
        _make_header(0, is_repeat_open=True, repeat_close=1),       # A (x2)
        _make_header(4, from_direction_name="Da Capo"),              # B
    ]
    schedule = _build_playback_schedule(_make_song(headers), _TM_120)
    # Pass 1: A A B (repeat honored). After D.C.: jumped_back=True → A B.
    assert _ids(schedule) == [(0, 0), (0, 1), (1, 0), (0, 0), (1, 0)]


def test_schedule_expand_disabled():
    # Same shape as simple_repeat but expand_repeats=False → 2 entries.
    headers = [
        _make_header(0, is_repeat_open=True),
        _make_header(4, repeat_close=1),
    ]
    schedule = _build_playback_schedule(
        _make_song(headers), _TM_120, expand_repeats=False,
    )
    assert _ids(schedule) == [(0, 0), (1, 0)]


def _warning_messages(mock_log) -> list[str]:
    """Format every `log.warning(fmt, *args)` call into its rendered message.

    We patch the module-level logger rather than using pytest's caplog because
    slopsmith's conftest installs a structlog processor chain that intercepts
    logging records before caplog can see them — fine in production, but it
    leaves caplog silent in CI even though the warning is emitted.
    """
    out = []
    for call in mock_log.warning.call_args_list:
        fmt, *args = call.args
        try:
            out.append(fmt % tuple(args))
        except TypeError:
            out.append(str(fmt))
    return out


def test_schedule_orphan_open_warns():
    # Open without matching close → log warning, walk linearly.
    headers = [
        _make_header(0, is_repeat_open=True),
        _make_header(4),
        _make_header(8),
    ]
    with mock.patch("gp2rs.log") as mock_log:
        schedule = _build_playback_schedule(_make_song(headers), _TM_120)
    assert _ids(schedule) == [(0, 0), (1, 0), (2, 0)]
    assert any("no matching close" in m for m in _warning_messages(mock_log))


def test_schedule_unresolved_dal_segno_warns():
    # Da Segno with no Segno target → warn, advance linearly past the jump.
    headers = [
        _make_header(0),
        _make_header(4, from_direction_name="Da Segno"),
        _make_header(8),
    ]
    with mock.patch("gp2rs.log") as mock_log:
        schedule = _build_playback_schedule(_make_song(headers), _TM_120)
    assert _ids(schedule) == [(0, 0), (1, 0), (2, 0)]
    assert any("no matching target" in m for m in _warning_messages(mock_log))


def test_schedule_note_time_shifts_under_repeat():
    # ||: A :||x2 with 4/4 at 120 BPM → measure A is 2 s long. First-pass A
    # starts at 0 s; second-pass A starts at 2 s.
    headers = [_make_header(0, is_repeat_open=True, repeat_close=1)]
    schedule = _build_playback_schedule(_make_song(headers), _TM_120)
    assert len(schedule) == 2
    assert schedule[0].output_start_secs == pytest.approx(0.0)
    assert schedule[1].output_start_secs == pytest.approx(2.0)
    # mh_authored_start_secs is the same for both (same source measure).
    assert schedule[0].mh_authored_start_secs == schedule[1].mh_authored_start_secs


def test_schedule_song_length_reflects_expansion():
    # ||: A | B :||x2 → expanded length is 4 measures x 2 s = 8 s, not 4 s.
    headers = [
        _make_header(0, is_repeat_open=True),
        _make_header(4, repeat_close=1),
    ]
    schedule = _build_playback_schedule(_make_song(headers), _TM_120)
    last = schedule[-1]
    last_mh = headers[last.mh_index]
    # Output end = last entry start + last measure duration.
    measure_secs = (last_mh.timeSignature.numerator
                    * (4.0 / last_mh.timeSignature.denominator.value)
                    * GP_TICKS_PER_QUARTER) \
                   / GP_TICKS_PER_QUARTER * (60.0 / 120.0)
    expanded_end = last.output_start_secs + measure_secs
    assert expanded_end == pytest.approx(8.0)


def test_schedule_empty_song():
    # No headers → empty schedule. Should not crash.
    schedule = _build_playback_schedule(_make_song([]), _TM_120)
    assert schedule == []


def test_schedule_irregular_measure_lengths():
    # A 3-quarter pickup followed by two 4-quarter measures, then ||: D :||x2.
    # The pickup is intentionally shorter than its 4/4 time signature would
    # suggest — that's how GP encodes an anacrusis. The schedule must use the
    # tick delta to the next measure as the duration, not the time signature.
    headers = [
        _make_header(0, numerator=4),   # A — 3 quarters long (starts at 0, next at 3)
        _make_header(3, numerator=4),   # B
        _make_header(7, numerator=4),   # C
        _make_header(11, numerator=4, is_repeat_open=True, repeat_close=1),  # D x2
    ]
    schedule = _build_playback_schedule(_make_song(headers), _TM_120)
    # 120 BPM: 1 quarter = 0.5 s. Output starts:
    #   A: 0.0, B: 1.5 (3 q), C: 3.5 (4 q), D pass 0: 5.5 (4 q), D pass 1: 7.5
    out = [round(e.output_start_secs, 3) for e in schedule]
    assert out == [0.0, 1.5, 3.5, 5.5, 7.5]


# ── convert_track: tied-note (NoteType.tie) handling ─────────────────────────
# Tied notes in GP are displayed with brackets, e.g. (0). They should extend
# the sustain of the previous note on the same string, not emit a second note.

def _ct_note_effect():
    return SimpleNamespace(
        bend=None,
        hammer=False,
        slides=[],
        harmonic=None,
        palmMute=False,
        accentuatedNote=False,
        heavyAccentuatedNote=False,
        ghostNote=False,
        vibrato=False,
        tremoloPicking=False,
    )


def _ct_beat(tick, dur_value, notes):
    return SimpleNamespace(
        start=tick,
        duration=SimpleNamespace(
            value=dur_value,
            isDotted=False,
            tuplet=SimpleNamespace(enters=1, times=1),
        ),
        notes=notes,
        effect=SimpleNamespace(mixTableChange=None, chord=None),
    )


def _ct_note(note_type, gp_string, fret):
    return SimpleNamespace(
        type=note_type,
        string=gp_string,
        value=fret,
        effect=_ct_note_effect(),
    )


def _ct_song(beats, string_values=None):
    """One-measure mock song for convert_track, standard 6-string guitar at 120 BPM.

    `string_values` overrides the tuning/string count (e.g. a 7-string track)."""
    voice = SimpleNamespace(beats=beats)
    measure = SimpleNamespace(voices=[voice])
    strings = [SimpleNamespace(number=i + 1, value=v)
               for i, v in enumerate(string_values or [64, 59, 55, 50, 45, 40])]
    track = SimpleNamespace(
        strings=strings,
        channel=SimpleNamespace(instrument=24),
        measures=[measure],
        name="Guitar",
    )
    mh = SimpleNamespace(
        start=0,
        number=1,
        timeSignature=SimpleNamespace(
            numerator=4,
            denominator=SimpleNamespace(value=4),
        ),
        isRepeatOpen=False,
        repeatClose=-1,
        repeatAlternative=0,
        direction=None,
        fromDirection=None,
        marker=None,
    )
    return SimpleNamespace(
        title="Test",
        artist="Test",
        album="Test",
        copyright=None,
        subtitle=None,
        tempo=120,
        tracks=[track],
        measureHeaders=[mh],
    )


def test_tied_note_extends_sustain_not_duplicate():
    """NoteType.tie should extend the previous note's sustain, not emit a new note."""
    # quarter note at 120 BPM = 0.5 s; two tied quarters → 1.0 s total sustain
    note1 = _ct_note(guitarpro.NoteType.normal, gp_string=1, fret=5)
    note2 = _ct_note(guitarpro.NoteType.tie, gp_string=1, fret=5)
    beat1 = _ct_beat(tick=0, dur_value=4, notes=[note1])
    beat2 = _ct_beat(tick=GP_TICKS_PER_QUARTER, dur_value=4, notes=[note2])

    xml_str = convert_track(_ct_song([beat1, beat2]), track_index=0)
    root = ET.fromstring(xml_str)  # noqa: S314
    notes = root.findall(".//notes/note")

    assert len(notes) == 1, f"tie must not emit a second note; got {len(notes)}"
    sustain = float(notes[0].get("sustain"))
    assert sustain == pytest.approx(1.0, abs=0.01)
    assert notes[0].get("fret") == "5"


def test_tied_note_without_predecessor_is_silently_dropped():
    """A tie with no previous note on that string is silently skipped."""
    note = _ct_note(guitarpro.NoteType.tie, gp_string=1, fret=0)
    beat = _ct_beat(tick=0, dur_value=4, notes=[note])

    xml_str = convert_track(_ct_song([beat]), track_index=0)
    root = ET.fromstring(xml_str)  # noqa: S314
    notes = root.findall(".//notes/note")
    assert len(notes) == 0


def _ct_multivoice_song(voices_beats):
    """Multi-voice variant of _ct_song. `voices_beats` is a list of beat-lists,
    one per voice, all on the same single measure."""
    voices = [SimpleNamespace(beats=beats) for beats in voices_beats]
    measure = SimpleNamespace(voices=voices)
    strings = [SimpleNamespace(number=i + 1, value=v)
               for i, v in enumerate([64, 59, 55, 50, 45, 40])]
    track = SimpleNamespace(
        strings=strings,
        channel=SimpleNamespace(instrument=24),
        measures=[measure],
        name="Guitar",
    )
    mh = SimpleNamespace(
        start=0, number=1,
        timeSignature=SimpleNamespace(numerator=4, denominator=SimpleNamespace(value=4)),
        isRepeatOpen=False, repeatClose=-1, repeatAlternative=0,
        direction=None, fromDirection=None, marker=None,
    )
    return SimpleNamespace(
        title="Test", artist="Test", album="Test",
        copyright=None, subtitle=None, tempo=120,
        tracks=[track],
        measureHeaders=[mh],
    )


def test_tie_does_not_attach_to_overwritten_earlier_voice_note():
    """Voices are processed sequentially. Without an overwrite guard
    (`rn.time >= existing.time` before updating last_note_per_string),
    voice 1's beat-0 note would replace voice 0's beat-2 entry in the dict,
    and voice 1's beat-3 tie would then incorrectly extend voice 1's beat-0
    sustain across voice 0's beat-2 territory.

    All beat.start values stay within a 4/4 single measure (0 – 3×quarter).
    """
    # Voice 0: beat 2 fret 7 (t=1.0, sustain 0.5) — populates dict[string=1] first
    v0_beat2 = _ct_beat(tick=GP_TICKS_PER_QUARTER * 2, dur_value=4,
                        notes=[_ct_note(guitarpro.NoteType.normal, gp_string=1, fret=7)])
    # Voice 1: beat 0 fret 5 (t=0) and tie at beat 3 (t=1.5)
    v1_beat0 = _ct_beat(tick=0, dur_value=4,
                        notes=[_ct_note(guitarpro.NoteType.normal, gp_string=1, fret=5)])
    v1_tie = _ct_beat(tick=GP_TICKS_PER_QUARTER * 3, dur_value=4,
                      notes=[_ct_note(guitarpro.NoteType.tie, gp_string=1, fret=0)])

    xml_str = convert_track(_ct_multivoice_song([[v0_beat2], [v1_beat0, v1_tie]]),
                            track_index=0)
    root = ET.fromstring(xml_str)  # noqa: S314
    notes = root.findall(".//notes/note")

    sustains = {n.get("fret"): float(n.get("sustain")) for n in notes}
    # Voice 1's beat-0 (fret 5) sustain must stay at its own duration (~0.5 s).
    # Without the overwrite guard it would be inflated to ~2.0 s by the tie.
    assert sustains.get("5") == pytest.approx(0.5, abs=0.01), \
        "overwrite guard must keep voice 0's beat-2 as the tracked predecessor; " \
        "voice 1's beat-0 sustain must not balloon to cover the tie's target time"


def test_two_normal_notes_on_same_string_are_both_emitted():
    """Non-tied consecutive notes on the same string each produce a note event."""
    note1 = _ct_note(guitarpro.NoteType.normal, gp_string=1, fret=5)
    note2 = _ct_note(guitarpro.NoteType.normal, gp_string=1, fret=7)
    beat1 = _ct_beat(tick=0, dur_value=4, notes=[note1])
    beat2 = _ct_beat(tick=GP_TICKS_PER_QUARTER, dur_value=4, notes=[note2])

    xml_str = convert_track(_ct_song([beat1, beat2]), track_index=0)
    root = ET.fromstring(xml_str)  # noqa: S314
    notes = root.findall(".//notes/note")

    assert len(notes) == 2
    assert notes[0].get("fret") == "5"
    assert notes[1].get("fret") == "7"


# ── convert_piano_track: tied-note pitch-bucket collision ─────────────────────
# MIDI notes 48 (C3) and 50 (D3) both map to rs_string=2. A chord containing
# both, followed by ties for both, must extend each note individually — not
# share a single rs_string=2 bucket that only tracks whichever was stored last.

def _piano_song(beats):
    """One-measure mock for convert_piano_track with two GP strings at MIDI 48 and 50."""
    voice = SimpleNamespace(beats=beats)
    measure = SimpleNamespace(voices=[voice])
    strings = [
        SimpleNamespace(number=1, value=48),  # C3 — encodes to rs_string=2, rs_fret=0
        SimpleNamespace(number=2, value=50),  # D3 — encodes to rs_string=2, rs_fret=2
    ]
    track = SimpleNamespace(
        strings=strings,
        channel=SimpleNamespace(instrument=0),
        measures=[measure],
        name="Piano",
    )
    mh = SimpleNamespace(
        start=0, number=1,
        timeSignature=SimpleNamespace(numerator=4, denominator=SimpleNamespace(value=4)),
        isRepeatOpen=False, repeatClose=-1, repeatAlternative=0,
        direction=None, fromDirection=None, marker=None,
    )
    return SimpleNamespace(
        title="Test", artist="Test", album="Test",
        copyright=None, subtitle=None, tempo=120,
        tracks=[track],
        measureHeaders=[mh],
    )


def test_piano_tied_chord_both_notes_extended():
    """Two simultaneous piano notes in the same rs_string bucket must each get
    their own sustain extension — not share a single string-keyed slot."""
    # Beat 1: chord of MIDI 48 (gp_str=1) and MIDI 50 (gp_str=2), both 0.5 s
    n_c3 = _ct_note(guitarpro.NoteType.normal, gp_string=1, fret=0)
    n_d3 = _ct_note(guitarpro.NoteType.normal, gp_string=2, fret=0)
    beat1 = _ct_beat(tick=0, dur_value=4, notes=[n_c3, n_d3])

    # Beat 2: ties for both — should extend each note to ~1.0 s
    t_c3 = _ct_note(guitarpro.NoteType.tie, gp_string=1, fret=0)
    t_d3 = _ct_note(guitarpro.NoteType.tie, gp_string=2, fret=0)
    beat2 = _ct_beat(tick=GP_TICKS_PER_QUARTER, dur_value=4, notes=[t_c3, t_d3])

    xml_str = convert_piano_track(_piano_song([beat1, beat2]), track_index=0)
    root = ET.fromstring(xml_str)  # noqa: S314
    chords = root.findall(".//chords/chord")

    assert len(chords) == 1, "tie beat must not emit a second chord"
    chord_notes = chords[0].findall("chordNote")
    assert len(chord_notes) == 2

    for cn in chord_notes:
        sustain = float(cn.get("sustain"))
        assert sustain == pytest.approx(1.0, abs=0.01), (
            f"fret={cn.get('fret')} sustain={sustain:.3f}, expected ~1.0 s"
        )


# ── convert_track: tie must not cross a backward repeat boundary ──────────────
# When the playback schedule loops backwards (repeat loopbacks, D.S., D.C.),
# the tie-tracking state must be cleared so a tie note at the start of a
# repeated section cannot accidentally extend the last note from the previous
# pass.  Forward skips (volta alternatives, al-Coda redirects) are NOT cleared
# because consecutive forward schedule entries are adjacent in the output audio.


def _ct_song_repeat(beats_m0, beats_m1):
    """Two-measure mock song where measure 0 is the repeat-open and measure 1
    is the repeat-close (×1 extra repeat → plays twice total).

    120 BPM, 4/4, standard 6-string guitar.
    """
    voice0 = SimpleNamespace(beats=beats_m0)
    voice1 = SimpleNamespace(beats=beats_m1)
    measure0 = SimpleNamespace(voices=[voice0])
    measure1 = SimpleNamespace(voices=[voice1])
    strings = [SimpleNamespace(number=i + 1, value=v)
               for i, v in enumerate([64, 59, 55, 50, 45, 40])]
    track = SimpleNamespace(
        strings=strings,
        channel=SimpleNamespace(instrument=24),
        measures=[measure0, measure1],
        name="Guitar",
    )
    # measure 0: repeat open, tick 0
    mh0 = SimpleNamespace(
        start=0,
        number=1,
        timeSignature=SimpleNamespace(
            numerator=4, denominator=SimpleNamespace(value=4)
        ),
        isRepeatOpen=True,
        repeatClose=-1,       # close is on mh1
        repeatAlternative=0,
        direction=None,
        fromDirection=None,
        marker=None,
    )
    # measure 1: repeat close, plays the bracket one extra time (total ×2)
    mh1 = SimpleNamespace(
        start=4 * GP_TICKS_PER_QUARTER,
        number=2,
        timeSignature=SimpleNamespace(
            numerator=4, denominator=SimpleNamespace(value=4)
        ),
        isRepeatOpen=False,
        repeatClose=1,        # repeat the bracket once more → 2 total passes
        repeatAlternative=0,
        direction=None,
        fromDirection=None,
        marker=None,
    )
    return SimpleNamespace(
        title="Test",
        artist="Test",
        album="Test",
        copyright=None,
        subtitle=None,
        tempo=120,
        tracks=[track],
        measureHeaders=[mh0, mh1],
    )


def test_tie_not_extended_across_repeat_boundary():
    """A tie note at the start of a repeated section must be silently dropped on
    the second pass — not extend the last note from the end of the first pass.

    Schedule after repeat expansion:
      mh=0 pass0 → mh=1 pass0 → mh=0 pass1 → mh=1 pass1

    Measure 0 beat0 is a tie on string 1.  No previous note exists on pass0
    (correctly dropped).  Measure 1 beat0 is a normal note on string 1.

    Without the repeat-boundary clear, on pass1 the tie in mh=0 would
    incorrectly extend measure 1's note from pass0.  With the clear it is
    dropped (still no valid predecessor within this pass).
    """
    # measure 0: tie on string 1 (no predecessor on first pass → should drop)
    tie_beat = _ct_beat(tick=0, dur_value=4,
                        notes=[_ct_note(guitarpro.NoteType.tie, gp_string=1, fret=5)])
    # measure 1: normal note on string 1
    normal_beat = _ct_beat(tick=4 * GP_TICKS_PER_QUARTER, dur_value=4,
                           notes=[_ct_note(guitarpro.NoteType.normal, gp_string=1, fret=5)])

    xml_str = convert_track(_ct_song_repeat([tie_beat], [normal_beat]), track_index=0)
    root = ET.fromstring(xml_str)  # noqa: S314
    notes = root.findall(".//notes/note")

    # Two passes through measure 1 → two normal notes; the ties are both dropped.
    assert len(notes) == 2, (
        f"repeat boundary must not allow tie to extend across passes; got {len(notes)} notes"
    )
    # Each note should have its authored sustain (~0.5 s for a quarter at 120 BPM),
    # not an inflated value caused by an erroneous cross-boundary tie extension.
    for n in notes:
        sustain = float(n.get("sustain"))
        # quarter note at 120 BPM = 0.5 s, which is > 0.2 threshold → sustain=0.5
        assert sustain == pytest.approx(0.5, abs=0.01), (
            f"sustain should be ~0.5 s (one quarter note), got {sustain:.3f}"
        )


# ── convert_track: GP5 chord-diagram fingering extraction (E3) ───────────────
# pyguitarpro exposes the chord-diagram voicing on beat.effect.chord:
# .strings is per-string frets indexed 0 = highest string, .fingerings is the
# parallel Fingering enum list (open=-1, thumb=0, index=1, middle=2, ring=3,
# pinky=4 — already the RS finger integers). A chord beat carrying this data
# must import with per-string fingers; a chord beat without it stays all -1.

def _ct_chord(name, strings, fingerings):
    return SimpleNamespace(
        name=name, strings=list(strings),
        fingerings=list(fingerings), length=len(strings),
    )


def test_chord_diagram_fingers_extracted():
    # Two-note voicing on high e (fret 3) + B (fret 2). chord.strings is
    # indexed 0 = highest string, so strings[0] = high e, strings[1] = B.
    note_e = _ct_note(guitarpro.NoteType.normal, gp_string=1, fret=3)  # high e
    note_b = _ct_note(guitarpro.NoteType.normal, gp_string=2, fret=2)  # B
    beat = _ct_beat(tick=0, dur_value=4, notes=[note_e, note_b])
    beat.effect.chord = _ct_chord(
        "Gtest",
        strings=[3, 2, -1, -1, -1, -1],
        fingerings=[
            guitarpro.Fingering.middle,  # high e -> 2
            guitarpro.Fingering.index,   # B      -> 1
        ],
    )

    xml_str = convert_track(_ct_song([beat]), track_index=0)
    root = ET.fromstring(xml_str)  # noqa: S314
    ct = root.find(".//chordTemplates/chordTemplate")
    assert ct is not None
    assert ct.get("chordName") == "Gtest"
    # _gp_string_to_rs(1, 6) = 5 (high e), _gp_string_to_rs(2, 6) = 4 (B).
    assert ct.get("fret5") == "3" and ct.get("finger5") == "2"
    assert ct.get("fret4") == "2" and ct.get("finger4") == "1"
    assert [ct.get(f"finger{i}") for i in range(0, 4)] == ["-1"] * 4


def test_chord_without_diagram_has_blank_fingers():
    # A plain two-note chord (effect.chord is None) is unchanged: blank name,
    # all-(-1) fingers — no regression for diagram-less charts.
    note_e = _ct_note(guitarpro.NoteType.normal, gp_string=1, fret=3)
    note_b = _ct_note(guitarpro.NoteType.normal, gp_string=2, fret=2)
    beat = _ct_beat(tick=0, dur_value=4, notes=[note_e, note_b])  # chord=None

    xml_str = convert_track(_ct_song([beat]), track_index=0)
    root = ET.fromstring(xml_str)  # noqa: S314
    ct = root.find(".//chordTemplates/chordTemplate")
    assert ct is not None
    assert ct.get("chordName") == ""
    assert [ct.get(f"finger{i}") for i in range(6)] == ["-1"] * 6


def test_chord_diagram_backfills_template_first_strummed_unannotated():
    # The annotated chord must enrich its voicing even when an earlier,
    # unannotated beat of the SAME fret pattern created the template first.
    plain = _ct_beat(
        tick=0, dur_value=4,
        notes=[_ct_note(guitarpro.NoteType.normal, gp_string=1, fret=3),
               _ct_note(guitarpro.NoteType.normal, gp_string=2, fret=2)],
    )  # chord=None, creates the blank template
    annotated = _ct_beat(
        tick=GP_TICKS_PER_QUARTER, dur_value=4,
        notes=[_ct_note(guitarpro.NoteType.normal, gp_string=1, fret=3),
               _ct_note(guitarpro.NoteType.normal, gp_string=2, fret=2)],
    )
    annotated.effect.chord = _ct_chord(
        "Gtest", strings=[3, 2, -1, -1, -1, -1],
        fingerings=[guitarpro.Fingering.middle, guitarpro.Fingering.index],
    )

    xml_str = convert_track(_ct_song([plain, annotated]), track_index=0)
    root = ET.fromstring(xml_str)  # noqa: S314
    cts = root.findall(".//chordTemplates/chordTemplate")
    assert len(cts) == 1, "same voicing must dedup to one template"
    assert cts[0].get("chordName") == "Gtest"
    assert cts[0].get("finger5") == "2" and cts[0].get("finger4") == "1"


def test_chord_diagram_mismatch_not_applied():
    # The attached diagram describes a DIFFERENT voicing (frets 5/5) than the
    # notes actually played (3/2). It must NOT enrich the played template —
    # otherwise a mislabeled chord would name/finger the wrong voicing (and the
    # back-fill would spread it). Name + fingers stay blank.
    note_e = _ct_note(guitarpro.NoteType.normal, gp_string=1, fret=3)
    note_b = _ct_note(guitarpro.NoteType.normal, gp_string=2, fret=2)
    beat = _ct_beat(tick=0, dur_value=4, notes=[note_e, note_b])
    beat.effect.chord = _ct_chord(
        "Wrong", strings=[5, 5, -1, -1, -1, -1],  # != played 3/2
        fingerings=[guitarpro.Fingering.annular, guitarpro.Fingering.annular],
    )

    xml_str = convert_track(_ct_song([beat]), track_index=0)
    root = ET.fromstring(xml_str)  # noqa: S314
    ct = root.find(".//chordTemplates/chordTemplate")
    assert ct is not None
    assert ct.get("chordName") == ""
    assert [ct.get(f"finger{i}") for i in range(6)] == ["-1"] * 6


def test_chord_diagram_name_then_fingers_decoupled():
    # First annotated beat carries a NAME but no fingers (all open); a later beat
    # of the same voicing carries the fingers. Both must land — a name-only first
    # annotation must not block the later fingers (name/fingers back-fill
    # independently).
    def _beat(tick, name, fingerings):
        b = _ct_beat(
            tick=tick, dur_value=4,
            notes=[_ct_note(guitarpro.NoteType.normal, gp_string=1, fret=3),
                   _ct_note(guitarpro.NoteType.normal, gp_string=2, fret=2)],
        )
        b.effect.chord = _ct_chord(name, strings=[3, 2, -1, -1, -1, -1],
                                   fingerings=fingerings)
        return b

    first = _beat(0, "Gtest",
                  [guitarpro.Fingering.open, guitarpro.Fingering.open])
    second = _beat(GP_TICKS_PER_QUARTER, "",
                   [guitarpro.Fingering.middle, guitarpro.Fingering.index])

    xml_str = convert_track(_ct_song([first, second]), track_index=0)
    root = ET.fromstring(xml_str)  # noqa: S314
    cts = root.findall(".//chordTemplates/chordTemplate")
    assert len(cts) == 1
    assert cts[0].get("chordName") == "Gtest"  # from the first (name-only) beat
    # fingers from the second beat — not blocked by the first beat's name
    assert cts[0].get("finger5") == "2" and cts[0].get("finger4") == "1"


def test_chord_diagram_barre_higher_position_matches():
    # A voicing high on the neck: diagram strings hold ABSOLUTE frets (firstFret
    # is display-only), so they match the played absolute frets and the template
    # enriches. Guards against an absolute-vs-relative matching regression.
    notes = [_ct_note(guitarpro.NoteType.normal, gp_string=1, fret=5),
             _ct_note(guitarpro.NoteType.normal, gp_string=2, fret=5),
             _ct_note(guitarpro.NoteType.normal, gp_string=3, fret=6)]
    beat = _ct_beat(tick=0, dur_value=4, notes=notes)
    ch = _ct_chord("A", strings=[5, 5, 6, -1, -1, -1],
                   fingerings=[guitarpro.Fingering.index, guitarpro.Fingering.index,
                               guitarpro.Fingering.middle])
    ch.firstFret = 5  # display base — must not affect matching
    beat.effect.chord = ch

    xml_str = convert_track(_ct_song([beat]), track_index=0)
    root = ET.fromstring(xml_str)  # noqa: S314
    ct = root.find(".//chordTemplates/chordTemplate")
    assert ct is not None
    assert ct.get("chordName") == "A"
    assert ct.get("fret5") == "5" and ct.get("finger5") == "1"
    assert ct.get("fret4") == "5" and ct.get("finger4") == "1"
    assert ct.get("fret3") == "6" and ct.get("finger3") == "2"


def test_chord_diagram_extended_string_outside_played_width_not_applied():
    # 7-string track. Played voicing is on strings 2 & 3 only (width 6 — the
    # high e / rs6 is unused), but the diagram ALSO frets string 1 (the extended
    # rs6). The extra diagram note must make this a MISMATCH, not be silently
    # trimmed to a false match — so the played template stays un-enriched.
    seven = [64, 59, 55, 50, 45, 40, 35]  # low-B 7-string
    note_b = _ct_note(guitarpro.NoteType.normal, gp_string=2, fret=3)  # rs5
    note_g = _ct_note(guitarpro.NoteType.normal, gp_string=3, fret=2)  # rs4
    beat = _ct_beat(tick=0, dur_value=4, notes=[note_b, note_g])
    # diagram index0 = gp_string1 (rs6) frets 5 (NOT played); index1/2 match.
    beat.effect.chord = _ct_chord(
        "Bogus", strings=[5, 3, 2, -1, -1, -1, -1],
        fingerings=[guitarpro.Fingering.index, guitarpro.Fingering.middle,
                    guitarpro.Fingering.index],
    )

    xml_str = convert_track(_ct_song([beat], string_values=seven), track_index=0)
    root = ET.fromstring(xml_str)  # noqa: S314
    ct = root.find(".//chordTemplates/chordTemplate")
    assert ct is not None
    assert ct.get("chordName") == ""
    # played template is width 6 (rs6/high-e unused) -> finger0..finger5
    assert all(ct.get(f"finger{i}") == "-1" for i in range(6))
