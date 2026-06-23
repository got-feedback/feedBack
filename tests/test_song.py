"""Tests for lib/song.py wire-format serialization (pure, no fixtures)."""

import json

import pytest

from song import (
    Anchor,
    Arrangement,
    Chord,
    ChordTemplate,
    HandShape,
    Note,
    Phrase,
    PhraseLevel,
    arrangement_from_wire,
    arrangement_string_count,
    arrangement_to_wire,
    chord_from_wire,
    chord_template_to_wire,
    chord_to_wire,
    sanitize_tempos,
    compute_smart_names,
    base_open_string_midis,
    key_to_tonic_pc,
    note_from_wire,
    note_to_wire,
    note_pitch_midi,
    phrase_from_wire,
    phrase_to_wire,
    scale_degree_for_pitch,
)


# ── Note round-trip ──────────────────────────────────────────────────────────

def test_note_minimal_round_trip():
    n = Note(time=1.0, string=2, fret=5)
    assert note_from_wire(note_to_wire(n)) == n


def test_note_with_every_technique_round_trip():
    n = Note(
        time=0.5, string=0, fret=3,
        sustain=0.25,
        slide_to=7,
        slide_unpitch_to=9,
        bend=1.0,
        hammer_on=True, pull_off=True,
        harmonic=True, harmonic_pinch=True,
        palm_mute=True, mute=True,
        vibrato=True,
        tremolo=True, accent=True,
        tap=True,
    )
    assert note_from_wire(note_to_wire(n)) == n


def test_note_link_next_round_trips_through_wire():
    """link_next survives the wire under key `ln`.

    Originally omitted because the highway derived chord linking from
    proximity rather than the linkNext attribute. The editor now needs
    round-trip fidelity so an authored linkNext on a sloppak survives
    save → reload; `ln` is additive metadata the renderer is free to
    ignore.
    """
    n = Note(time=0.0, string=0, fret=0, link_next=True)
    wire = note_to_wire(n)
    assert wire["ln"] is True
    assert note_from_wire(wire).link_next is True


def test_note_new_techniques_round_trip():
    """fret_hand_mute, pluck, slap, right_hand, pick_direction, ignore.

    Pin the public wire keys (`fhm`, `plk`, `slp`, `rh`, `pkd`, `ig`)
    explicitly — a coordinated rename in both encoder and decoder would
    still pass a pure round-trip check, but break sloppak readers in
    other languages that key off the literal strings.
    """
    n = Note(
        time=0.0, string=0, fret=0,
        fret_hand_mute=True, pluck=True, slap=True,
        right_hand=2, pick_direction=1, ignore=True,
        link_next=True,
    )
    wire = note_to_wire(n)
    assert wire["ln"] is True
    assert wire["fhm"] is True
    assert wire["plk"] is True
    assert wire["slp"] is True
    assert wire["rh"] == 2
    assert wire["pkd"] == 1
    assert wire["ig"] is True
    assert note_from_wire(wire) == n


def test_note_new_techniques_omitted_when_default():
    """New technique keys (ln/fhm/plk/slp/rh/pkd/ig) are default-omitted.

    The highway streams notes thousands of times per song; always emitting
    seven extra boolean/int keys per note would inflate the WebSocket
    payload for the common case where these techniques are unset.
    `note_from_wire` decodes missing keys to their dataclass defaults
    (False / -1), so the round-trip is lossless.
    """
    wire = note_to_wire(Note(time=0.0, string=0, fret=0))
    for omitted in ("ln", "fhm", "plk", "slp", "rh", "pkd", "ig"):
        assert omitted not in wire, f"{omitted!r} should be default-omitted"
    decoded = note_from_wire(wire)
    assert decoded.link_next is False
    assert decoded.fret_hand_mute is False
    assert decoded.pluck is False
    assert decoded.slap is False
    assert decoded.right_hand == -1
    assert decoded.pick_direction == -1
    assert decoded.ignore is False


def test_note_from_wire_tolerates_malformed_optional_ints():
    """`rh`/`pkd` survive null / empty / non-numeric wire values."""
    for bad in (None, "", "  ", "x", "inf"):
        n = note_from_wire({"t": 0.0, "s": 0, "f": 0, "rh": bad, "pkd": bad})
        assert n.right_hand == -1
        assert n.pick_direction == -1


def test_int_optional_falls_back_on_overflow():
    """`inf` / `1e309` raise OverflowError on int(float(v)); fall back too."""
    from xml.etree import ElementTree as ET
    from song import _int_optional
    el = ET.fromstring('<n a="inf" b="1e309" c="-inf"/>')
    assert _int_optional(el, "a", default=-1) == -1
    assert _int_optional(el, "b", default=-1) == -1
    assert _int_optional(el, "c", default=-1) == -1


def test_parse_note_falls_back_to_default_on_malformed_numeric_attrs():
    """Malformed numeric XML attributes degrade gracefully.

    Third-party arrangement XML occasionally emits empty / non-numeric
    values for fields like `rightHand`. `_int_optional` (used for
    optional metadata fields like `rightHand` and `pickDirection`)
    falls back to the caller's default instead of raising, so a
    malformed `<note>` no longer aborts the surrounding arrangement
    parse. Required readers still go through `_int` and fail fast.
    """
    from xml.etree import ElementTree as ET
    from song import _parse_note
    bad = ET.fromstring(
        '<note time="0.0" string="0" fret="0" rightHand="" pickDirection="x"/>'
    )
    n = _parse_note(bad)
    assert n.right_hand == -1
    assert n.pick_direction == -1


def test_note_time_rounded_to_three_decimals():
    n = Note(time=1.23456789, string=0, fret=0)
    assert note_to_wire(n)["t"] == 1.235


def test_note_bend_zero_serializes_as_integer_zero():
    # note_to_wire uses `round(bend, 1) if bend else 0` — the else branch returns int 0.
    # from_wire then float()s it back. Pin this quirk so a refactor doesn't surprise callers.
    wire = note_to_wire(Note(time=0.0, string=0, fret=0, bend=0.0))
    assert wire["bn"] == 0
    assert isinstance(wire["bn"], int)


def test_note_bend_nonzero_rounded_to_one_decimal():
    n = Note(time=0.0, string=0, fret=0, bend=1.75)
    assert note_to_wire(n)["bn"] == 1.8


# ── Bend shape (bt / bnv, §6.2.1) ────────────────────────────────────────────

def test_note_bend_shape_round_trip():
    """A note with bend intent + a time-stamped curve survives the wire."""
    n = Note(
        time=0.5, string=0, fret=7, sustain=1.0,
        bend=2.0,
        bend_intent=4,  # round-trip
        bend_values=[
            {"t": 0.0, "v": 0.0},
            {"t": 0.25, "v": 2.0},
            {"t": 0.5, "v": 0.0},
        ],
    )
    wire = note_to_wire(n)
    assert wire["bt"] == 4
    assert wire["bnv"] == [
        {"t": 0.0, "v": 0.0},
        {"t": 0.25, "v": 2.0},
        {"t": 0.5, "v": 0.0},
    ]
    assert note_from_wire(wire) == n


def test_note_bend_shape_omitted_when_default():
    """`bt`/`bnv` are default-omitted; absence decodes to 0 / None (not 0-present
    / not [])."""
    wire = note_to_wire(Note(time=0.0, string=0, fret=0, bend=1.0))
    assert "bt" not in wire
    assert "bnv" not in wire
    decoded = note_from_wire(wire)
    assert decoded.bend_intent == 0
    assert decoded.bend_values is None


# ── Teaching marks (§6.2.2) ──────────────────────────────────────────────────

def test_note_teaching_marks_round_trip():
    """fg/ch/sd survive the wire under their literal keys.

    Pin the public wire keys explicitly (cross-language sloppak readers key
    off the literal strings), like the rh/pkd test above.
    """
    n = Note(
        time=0.0, string=0, fret=0,
        fret_finger=2, strum_group=5, scale_degree=7,
    )
    wire = note_to_wire(n)
    assert wire["fg"] == 2
    assert wire["ch"] == 5
    assert wire["sd"] == 7
    assert note_from_wire(wire) == n


def test_note_teaching_marks_omitted_when_default():
    """fg/ch/sd are default-omitted (-1) and decode back to -1."""
    wire = note_to_wire(Note(time=0.0, string=0, fret=0))
    for omitted in ("fg", "ch", "sd"):
        assert omitted not in wire, f"{omitted!r} should be default-omitted"
    decoded = note_from_wire(wire)
    assert decoded.fret_finger == -1
    assert decoded.strum_group == -1
    assert decoded.scale_degree == -1


def test_note_teaching_marks_tolerate_malformed_optional_ints():
    """fg/ch/sd survive null / empty / non-numeric wire values."""
    for bad in (None, "", "  ", "x", "inf"):
        n = note_from_wire({"t": 0.0, "s": 0, "f": 0,
                            "fg": bad, "ch": bad, "sd": bad})
        assert n.fret_finger == -1
        assert n.strum_group == -1
        assert n.scale_degree == -1


# ── Scale-degree derivation helpers (§6.2.2 / §7.7) ──────────────────────────

@pytest.mark.parametrize("key,pc", [
    ("C", 0), ("c", 0),
    ("E", 4), ("Em", 4), ("E minor", 4),
    ("G", 7), ("G major", 7), ("Gmaj", 7),
    ("A#m", 10), ("Bb", 10),       # enharmonic — same pitch class
    ("F#", 6), ("F#m", 6),
    ("Cb", 11), ("B#", 0),         # accidentals wrap mod 12
])
def test_key_to_tonic_pc_parses_key_names(key, pc):
    assert key_to_tonic_pc(key) == pc


@pytest.mark.parametrize("bad", [None, "", "  ", "H", "xyz", "7", 5])
def test_key_to_tonic_pc_rejects_unparseable(bad):
    assert key_to_tonic_pc(bad) is None


def test_scale_degree_for_pitch_standard_tuning_key_of_e():
    """Tonic E (pc 4), standard tuning: low-E open -> tonic, A-string fret 2 -> fifth."""
    tonic = key_to_tonic_pc("E")
    assert tonic == 4
    low_e_open = 40           # E2
    a_string_fret2 = 45 + 2   # A2 + 2 = B2
    assert scale_degree_for_pitch(low_e_open, tonic) == 0    # tonic
    assert scale_degree_for_pitch(a_string_fret2, tonic) == 7  # perfect fifth
    assert scale_degree_for_pitch(40 + 3, tonic) == 3        # G2 -> minor third


def test_note_pitch_midi_standard_tuning_offsets():
    """`arr.tuning` holds OFFSETS from standard (0 = standard), padded to 6 on
    RS-XML; pitch = base + offset + capo + fret. Standard guitar: low-E open ->
    40 (E2), A-string fret 2 -> 47 (B2)."""
    arr = Arrangement(name="Lead", tuning=[0, 0, 0, 0, 0, 0])
    assert note_pitch_midi(arr, Note(time=0, string=0, fret=0)) == 40   # low E open
    assert note_pitch_midi(arr, Note(time=0, string=1, fret=2)) == 47   # A + 2 = B
    # Drop-D (low string offset -2): low-E string open sounds D2 = 38.
    drop_d = Arrangement(name="Lead", tuning=[-2, 0, 0, 0, 0, 0])
    assert note_pitch_midi(drop_d, Note(time=0, string=0, fret=0)) == 38
    # Capo 2 raises every sounding pitch by 2 semitones.
    capo2 = Arrangement(name="Lead", tuning=[0, 0, 0, 0, 0, 0], capo=2)
    assert note_pitch_midi(capo2, Note(time=0, string=0, fret=0)) == 42


def test_note_pitch_midi_bass_uses_bass_base():
    """A 4-string arrangement named 'Bass' uses the bass base (low E1 = 28),
    not the guitar base (40)."""
    bass = Arrangement(name="Bass", tuning=[0, 0, 0, 0])
    assert note_pitch_midi(bass, Note(time=0, string=0, fret=0)) == 28


def test_note_pitch_midi_out_of_range_string_is_none():
    arr = Arrangement(name="Lead", tuning=[0, 0, 0, 0, 0, 0])
    assert note_pitch_midi(arr, Note(time=0, string=9, fret=0)) is None


def test_base_open_string_midis_bass_vs_guitar():
    assert base_open_string_midis(6, False)[0] == 40   # guitar low E
    assert base_open_string_midis(4, True)[0] == 28    # bass low E
    assert base_open_string_midis(4, False)[0] == 40   # 4-string guitar voicing


def test_note_bend_values_rounded_on_wire():
    """`bnv` rounds `t` to 3 and `v` to 1, matching the scalar `bn` precision."""
    n = Note(
        time=0.0, string=0, fret=0, bend=1.0, bend_intent=1,
        bend_values=[{"t": 0.123456, "v": 1.749}],
    )
    assert note_to_wire(n)["bnv"] == [{"t": 0.123, "v": 1.7}]


def test_note_bend_values_sanitized_from_wire():
    """Malformed `bnv` entries are dropped; bad/empty -> None; result sorted by t."""
    # NaN / non-dict / non-numeric entries dropped, remaining sorted by t.
    n = note_from_wire({
        "t": 0.0, "s": 0, "f": 0, "bn": 2.0,
        "bnv": [
            {"t": 0.5, "v": 2.0},
            {"t": 0.0, "v": 0.0},
            {"t": "x", "v": 1.0},     # non-numeric t -> dropped
            {"t": 0.25, "v": float("nan")},  # non-finite v -> dropped
            "garbage",                # non-dict -> dropped
        ],
    })
    assert n.bend_values == [{"t": 0.0, "v": 0.0}, {"t": 0.5, "v": 2.0}]
    # Empty / non-list / all-invalid collapse to None (never []).
    for bad in (None, [], "nope", [{"t": "a", "v": "b"}], [42]):
        assert note_from_wire(
            {"t": 0.0, "s": 0, "f": 0, "bnv": bad}).bend_values is None


def test_chord_note_carries_bend_shape():
    """Chord member notes inherit bt/bnv through chord_note_to_wire/chord_from_wire."""
    c = Chord(
        time=2.0, chord_id=0,
        notes=[Note(
            time=2.0, string=1, fret=5, bend=1.0, bend_intent=2,
            bend_values=[{"t": 0.0, "v": 1.0}, {"t": 0.3, "v": 0.0}],
        )],
    )
    decoded = chord_from_wire(chord_to_wire(c))
    cn = decoded.notes[0]
    assert cn.bend_intent == 2
    assert cn.bend_values == [{"t": 0.0, "v": 1.0}, {"t": 0.3, "v": 0.0}]


# ── Chord round-trip ─────────────────────────────────────────────────────────

def test_chord_with_multiple_notes_round_trip():
    c = Chord(
        time=2.0,
        chord_id=5,
        high_density=False,
        notes=[
            Note(time=2.0, string=0, fret=3),
            Note(time=2.0, string=1, fret=5),
            Note(time=2.0, string=2, fret=5),
        ],
    )
    assert chord_from_wire(chord_to_wire(c)) == c


def test_chord_high_density_round_trip():
    c = Chord(
        time=1.5, chord_id=2, high_density=True,
        notes=[Note(time=1.5, string=0, fret=0)],
    )
    assert chord_from_wire(chord_to_wire(c)) == c


def test_chord_notes_inherit_chord_time_on_deserialization():
    """chord_note_to_wire strips each note's time; chord_from_wire replays the chord time.

    So notes constructed with mismatched times are normalized by the round-trip.
    """
    c = Chord(
        time=3.0, chord_id=0,
        notes=[
            Note(time=99.0, string=0, fret=0),  # will be normalized to 3.0
            Note(time=42.5, string=1, fret=1),  # will be normalized to 3.0
        ],
    )
    result = chord_from_wire(chord_to_wire(c))
    assert all(n.time == 3.0 for n in result.notes)


# ── Harmony annotations: chord fn (§6.3.1) + template voicing (§6.6) ──────────

def test_chord_fn_round_trip():
    """A well-formed fn {rn, q, deg} survives the wire under its literal key."""
    c = Chord(
        time=2.0, chord_id=0,
        notes=[Note(time=2.0, string=0, fret=2)],
        fn={"rn": "ii7", "q": "m7", "deg": 2},
    )
    wire = chord_to_wire(c)
    assert wire["fn"] == {"rn": "ii7", "q": "m7", "deg": 2}
    assert chord_from_wire(wire) == c


def test_chord_fn_omitted_when_none():
    """fn defaults to None and produces no `fn` key on the wire."""
    wire = chord_to_wire(Chord(time=0.0, chord_id=0,
                               notes=[Note(time=0.0, string=0, fret=0)]))
    assert "fn" not in wire
    assert chord_from_wire(wire).fn is None


@pytest.mark.parametrize("bad", [
    None,                                   # absent / null
    "ii7",                                  # not an object
    {},                                     # empty
    {"rn": "ii7", "q": "m7"},               # missing deg
    {"rn": "ii7", "deg": 2},                # missing q
    {"q": "m7", "deg": 2},                  # missing rn
    {"rn": "", "q": "m7", "deg": 2},        # blank rn
    {"rn": "ii7", "q": "  ", "deg": 2},     # blank q
    {"rn": "ii7", "q": "m7", "deg": 15},    # deg out of range (high)
    {"rn": "ii7", "q": "m7", "deg": -1},    # deg out of range (low)
    {"rn": "ii7", "q": "m7", "deg": "2"},   # deg not an int
    {"rn": "ii7", "q": "m7", "deg": True},  # deg is a bool, not a real int
    {"rn": 7, "q": "m7", "deg": 2},         # rn not a str
])
def test_chord_fn_malformed_drops_to_none(bad):
    """Any malformed / partial / out-of-range fn decodes to None (never partial)."""
    c = chord_from_wire({"t": 1.0, "id": 0, "notes": [], "fn": bad})
    assert c.fn is None


@pytest.mark.parametrize("bad_fn", [
    {"rn": "ii7"},                          # missing q + deg
    {"rn": "ii7", "q": "m7", "deg": 15},    # deg out of range
    {"rn": "", "q": "m7", "deg": 2},        # blank rn
])
def test_chord_to_wire_drops_invalid_fn_on_emit(bad_fn):
    """A directly-constructed Chord with a partial/out-of-range fn never rides the wire."""
    wire = chord_to_wire(Chord(time=1.0, chord_id=0, notes=[], fn=bad_fn))
    assert "fn" not in wire


def test_chord_fn_strips_whitespace_on_decode():
    c = chord_from_wire({"t": 1.0, "id": 0, "notes": [],
                         "fn": {"rn": " V7 ", "q": " 7 ", "deg": 7}})
    assert c.fn == {"rn": "V7", "q": "7", "deg": 7}


def test_template_voicing_round_trip():
    """A non-empty voicing survives the template wire + arrangement round-trip."""
    ct = ChordTemplate(name="Am", display_name="Am", fingers=[-1, 0, 2, 2, 1, 0],
                       frets=[-1, 0, 2, 2, 1, 0], voicing="open")
    assert chord_template_to_wire(ct)["voicing"] == "open"
    arr = Arrangement(name="Rhythm", chord_templates=[ct])
    assert arrangement_from_wire(arrangement_to_wire(arr)).chord_templates[0] == ct


def test_template_voicing_omitted_when_default():
    """An empty voicing (the default) produces no `voicing` key."""
    ct = ChordTemplate(name="Am", fingers=[-1] * 6, frets=[-1] * 6)
    assert "voicing" not in chord_template_to_wire(ct)
    arr = arrangement_from_wire(arrangement_to_wire(
        Arrangement(name="Rhythm", chord_templates=[ct])))
    assert arr.chord_templates[0].voicing == ""


@pytest.mark.parametrize("bad", [None, 7, ["open"], {"v": "open"}])
def test_template_voicing_tolerates_malformed(bad):
    """A non-string voicing on the wire falls back to the empty default."""
    arr = arrangement_from_wire({
        "name": "Rhythm",
        "templates": [{"name": "Am", "fingers": [-1] * 6, "frets": [-1] * 6,
                       "voicing": bad}],
    })
    assert arr.chord_templates[0].voicing == ""


def test_template_caged_round_trip():
    """A valid CAGED shape survives the template wire + arrangement round-trip."""
    ct = ChordTemplate(name="Am", display_name="Am", fingers=[-1, 0, 2, 2, 1, 0],
                       frets=[-1, 0, 2, 2, 1, 0], caged="E")
    assert chord_template_to_wire(ct)["caged"] == "E"
    arr = Arrangement(name="Rhythm", chord_templates=[ct])
    assert arrangement_from_wire(arrangement_to_wire(arr)).chord_templates[0] == ct


def test_template_caged_omitted_when_default():
    """An empty caged (the default) produces no `caged` key."""
    ct = ChordTemplate(name="Am", fingers=[-1] * 6, frets=[-1] * 6)
    assert "caged" not in chord_template_to_wire(ct)
    arr = arrangement_from_wire(arrangement_to_wire(
        Arrangement(name="Rhythm", chord_templates=[ct])))
    assert arr.chord_templates[0].caged == ""


@pytest.mark.parametrize("bad", [None, 7, "X", "e", "", ["E"], {"c": "E"}])
def test_template_caged_tolerates_malformed(bad):
    """A non-enum caged on the wire falls back to the empty default."""
    arr = arrangement_from_wire({
        "name": "Rhythm",
        "templates": [{"name": "Am", "fingers": [-1] * 6, "frets": [-1] * 6,
                       "caged": bad}],
    })
    assert arr.chord_templates[0].caged == ""


def test_template_caged_guide_tones_sanitized_on_emit():
    """A directly-constructed template can't write an invalid caged / out-of-range
    guideTone to the wire — the emitter sanitizes, not just the decoder."""
    ct = ChordTemplate(name="Am", fingers=[-1] * 6, frets=[-1] * 6,
                       caged="X", guide_tones=[3, 99, -1, "x", True])
    wire = chord_template_to_wire(ct)
    assert "caged" not in wire            # non-enum dropped, not emitted
    assert wire["guideTones"] == [3]      # only the valid in-range int survives
    # A wholly-invalid guideTones list omits the key entirely.
    ct2 = ChordTemplate(name="Am", fingers=[-1] * 6, frets=[-1] * 6,
                        guide_tones=[42, "nope"])
    assert "guideTones" not in chord_template_to_wire(ct2)


def test_template_guide_tones_round_trip():
    """A non-empty guideTones list survives the template wire + round-trip."""
    ct = ChordTemplate(name="G7", display_name="G7", fingers=[3, 2, 0, 0, 0, 1],
                       frets=[3, 2, 0, 0, 0, 1], guide_tones=[4, 10])
    assert chord_template_to_wire(ct)["guideTones"] == [4, 10]
    arr = Arrangement(name="Rhythm", chord_templates=[ct])
    assert arrangement_from_wire(arrangement_to_wire(arr)).chord_templates[0] == ct


def test_template_guide_tones_omitted_when_default():
    """An empty guide_tones (the default) produces no `guideTones` key."""
    ct = ChordTemplate(name="Am", fingers=[-1] * 6, frets=[-1] * 6)
    assert "guideTones" not in chord_template_to_wire(ct)
    arr = arrangement_from_wire(arrangement_to_wire(
        Arrangement(name="Rhythm", chord_templates=[ct])))
    assert arr.chord_templates[0].guide_tones == []


@pytest.mark.parametrize("raw,expected", [
    (None, []),
    (12, []),
    ("4,10", []),
    ([12], []),
    ([-1], []),
    ([True, 3], [3]),          # bool is an int subclass — rejected
    ([4, "x", 10, 11], [4, 10, 11]),
    ([0, 11], [0, 11]),        # boundary values kept
])
def test_template_guide_tones_tolerates_malformed(raw, expected):
    """Non-int / out-of-range guideTones entries are dropped off the wire."""
    arr = arrangement_from_wire({
        "name": "Rhythm",
        "templates": [{"name": "Am", "fingers": [-1] * 6, "frets": [-1] * 6,
                       "guideTones": raw}],
    })
    assert arr.chord_templates[0].guide_tones == expected


# ── Arrangement round-trip ───────────────────────────────────────────────────

def test_arrangement_empty_round_trip():
    arr = Arrangement(name="Lead")
    assert arrangement_from_wire(arrangement_to_wire(arr)) == arr


def test_arrangement_full_round_trip():
    arr = Arrangement(
        name="Rhythm",
        tuning=[-2, 0, 0, 0, 0, 0],
        capo=2,
        notes=[
            Note(time=1.0, string=0, fret=3, palm_mute=True),
            Note(time=1.5, string=1, fret=5, hammer_on=True),
        ],
        chords=[
            Chord(
                time=2.0, chord_id=1, high_density=True,
                notes=[
                    Note(time=2.0, string=0, fret=0),
                    Note(time=2.0, string=1, fret=2),
                ],
            ),
        ],
        anchors=[
            Anchor(time=0.0, fret=1, width=4),
            Anchor(time=10.0, fret=7, width=5),
        ],
        hand_shapes=[
            HandShape(chord_id=1, start_time=2.0, end_time=2.5),
        ],
        chord_templates=[
            # Spec defaults displayName to name on the wire, so the round-trip
            # surfaces an explicit display_name="Em" on the deserialised side
            # even when none was set on the source dataclass. Make it explicit
            # here so the strict-equality assertion captures the contract.
            ChordTemplate(
                name="Em",
                display_name="Em",
                fingers=[-1, -1, 2, 3, -1, -1],
                frets=[0, 2, 2, 0, 0, 0],
            ),
        ],
    )
    assert arrangement_from_wire(arrangement_to_wire(arr)) == arr


def test_arrangement_default_tuning_is_six_zeros():
    arr = Arrangement(name="Bass")
    assert arr.tuning == [0, 0, 0, 0, 0, 0]


def test_arrangement_from_wire_missing_fields_use_defaults():
    # Minimal wire dict — every list field defaults to empty, capo to 0,
    # tuning to six zeros.
    arr = arrangement_from_wire({"name": "Lead"})
    assert arr.name == "Lead"
    assert arr.tuning == [0, 0, 0, 0, 0, 0]
    assert arr.capo == 0
    assert arr.notes == []
    assert arr.chords == []
    assert arr.anchors == []
    assert arr.hand_shapes == []
    assert arr.chord_templates == []
    # phrases is the "slider disabled" sentinel — absent key → None, NOT [].
    assert arr.phrases is None


# ── Phrase / master-difficulty round-trip (feedBack#48) ─────────────────────

def test_phrase_empty_round_trip():
    p = Phrase(start_time=0.0, end_time=10.0, max_difficulty=0, levels=[])
    assert phrase_from_wire(phrase_to_wire(p)) == p


def test_phrase_times_rounded_to_three_decimals():
    # Pin the rounding behaviour for start_time / end_time so accidental
    # precision changes (which would shift frontend event timing or break
    # sloppak round-trips) are caught by the suite.
    p = Phrase(start_time=1.234567, end_time=9.876543, max_difficulty=0, levels=[])
    wire = phrase_to_wire(p)
    assert wire["start_time"] == 1.235
    assert wire["end_time"] == 9.877


def test_phrase_with_multiple_levels_round_trip():
    p = Phrase(
        start_time=4.5, end_time=12.25, max_difficulty=2,
        levels=[
            PhraseLevel(
                difficulty=0,
                notes=[Note(time=5.0, string=0, fret=3)],
                chords=[],
                anchors=[Anchor(time=5.0, fret=3, width=4)],
                hand_shapes=[],
            ),
            PhraseLevel(
                difficulty=1,
                notes=[
                    Note(time=5.0, string=0, fret=3),
                    Note(time=6.5, string=1, fret=5, palm_mute=True),
                ],
                chords=[],
                anchors=[Anchor(time=5.0, fret=3, width=4)],
                hand_shapes=[],
            ),
            PhraseLevel(
                difficulty=2,
                notes=[
                    Note(time=5.0, string=0, fret=3),
                    Note(time=6.5, string=1, fret=5, palm_mute=True),
                ],
                chords=[
                    Chord(
                        time=8.0, chord_id=1,
                        notes=[
                            Note(time=8.0, string=0, fret=0),
                            Note(time=8.0, string=1, fret=2),
                        ],
                    ),
                ],
                anchors=[Anchor(time=5.0, fret=3, width=4)],
                hand_shapes=[HandShape(chord_id=1, start_time=8.0, end_time=8.5)],
            ),
        ],
    )
    assert phrase_from_wire(phrase_to_wire(p)) == p


def test_arrangement_with_phrases_round_trip():
    arr = Arrangement(
        name="Lead",
        phrases=[
            Phrase(
                start_time=0.0, end_time=8.0, max_difficulty=1,
                levels=[
                    PhraseLevel(difficulty=0, notes=[Note(time=1.0, string=0, fret=0)]),
                    PhraseLevel(difficulty=1, notes=[
                        Note(time=1.0, string=0, fret=0),
                        Note(time=2.0, string=0, fret=2),
                    ]),
                ],
            ),
        ],
    )
    assert arrangement_from_wire(arrangement_to_wire(arr)) == arr


def test_arrangement_wire_omits_phrases_when_none():
    # Slider-disabled sentinel: arrangements without phrase data must NOT
    # emit a "phrases" key. Frontends distinguish by presence, not value.
    arr = Arrangement(name="Bass")
    wire = arrangement_to_wire(arr)
    assert "phrases" not in wire


def test_arrangement_wire_emits_phrases_when_set():
    arr = Arrangement(
        name="Lead",
        phrases=[Phrase(start_time=0.0, end_time=4.0, max_difficulty=0, levels=[])],
    )
    wire = arrangement_to_wire(arr)
    assert "phrases" in wire
    assert wire["phrases"] == [{
        "start_time": 0.0, "end_time": 4.0,
        "max_difficulty": 0, "levels": [],
    }]


def test_arrangement_wire_omits_phrases_when_empty_list():
    # An empty list means "no phrase data" just like None — emitting
    # `"phrases": []` would signal slider-enabled-but-no-ladder, which
    # is an invalid state for consumers. Normalize at the wire boundary.
    arr = Arrangement(name="Rhythm", phrases=[])
    wire = arrangement_to_wire(arr)
    assert "phrases" not in wire


def test_arrangement_from_wire_empty_phrases_list_becomes_none():
    # Symmetric: an explicit `"phrases": []` on the wire must deserialize
    # to the None sentinel so the slider-disabled signal is preserved.
    arr = arrangement_from_wire({"name": "X", "phrases": []})
    assert arr.phrases is None


def test_phrase_wire_is_json_safe():
    p = Phrase(
        start_time=1.234, end_time=5.678, max_difficulty=1,
        levels=[
            PhraseLevel(
                difficulty=1,
                notes=[Note(time=2.0, string=0, fret=5, sustain=0.5, tap=True)],
                chords=[
                    Chord(time=3.0, chord_id=2, high_density=True,
                          notes=[Note(time=3.0, string=0, fret=0)]),
                ],
                anchors=[Anchor(time=2.0, fret=5, width=4)],
                hand_shapes=[HandShape(chord_id=2, start_time=3.0, end_time=3.5)],
            ),
        ],
    )
    wire = phrase_to_wire(p)
    # allow_nan=False rejects Infinity/NaN — which JS JSON.parse
    # also rejects. Keeps the wire strictly browser-compatible.
    assert json.loads(json.dumps(wire, allow_nan=False)) == wire


# ── tones wire round-trip ─────────────────────────────────────────────────────

def test_arrangement_tones_round_trip():
    tones = {
        "base": "Clean",
        "changes": [{"t": 12.5, "name": "Drive"}],
        "definitions": [{"Name": "Clean", "Key": "Tone_A", "GearList": {}}],
    }
    arr = Arrangement(name="Lead", tones=tones)
    wire = arrangement_to_wire(arr)
    assert wire["tones"] == tones
    assert arrangement_from_wire(wire).tones == tones


def test_arrangement_without_tones_omits_wire_key():
    wire = arrangement_to_wire(Arrangement(name="Lead"))
    assert "tones" not in wire
    assert arrangement_from_wire(wire).tones is None


def test_arrangement_from_wire_ignores_non_dict_tones():
    # A malformed `tones` value must not crash the loader.
    assert arrangement_from_wire({"name": "Lead", "tones": []}).tones is None


def test_arrangement_tones_wire_is_json_safe():
    # `definitions` is copied verbatim from the archive manifest — the wire
    # output must still be strict JSON (allow_nan=False, as the browser's
    # JSON.parse requires).
    arr = Arrangement(name="Lead", tones={
        "base": "Clean",
        "changes": [{"t": 12.5, "name": "Drive"}],
        "definitions": [{
            "Name": "Clean", "Key": "Tone_A",
            "GearList": {"Amp": {"Type": "Amp_Twin",
                                 "KnobValues": {"Gain": 45.5}}},
        }],
    })
    wire = arrangement_to_wire(arr)
    assert json.loads(json.dumps(wire, allow_nan=False)) == wire


def test_arrangement_from_wire_empty_tones_dict_becomes_none():
    # An empty `{}` normalizes to None, symmetric with arrangement_to_wire
    # only emitting the key when arr.tones is truthy.
    assert arrangement_from_wire({"name": "Lead", "tones": {}}).tones is None


# ── Dataclass defaults ───────────────────────────────────────────────────────

def test_note_defaults():
    n = Note(time=0.0, string=0, fret=0)
    assert n.sustain == 0.0
    assert n.slide_to == -1
    assert n.slide_unpitch_to == -1
    assert n.bend == 0.0
    assert n.hammer_on is False
    assert n.pull_off is False
    assert n.harmonic is False
    assert n.harmonic_pinch is False
    assert n.palm_mute is False
    assert n.mute is False
    assert n.vibrato is False
    assert n.tremolo is False
    assert n.accent is False
    assert n.link_next is False
    assert n.tap is False


def test_anchor_default_width_is_four():
    a = Anchor(time=0.0, fret=1)
    assert a.width == 4


def test_chord_default_high_density_is_false():
    c = Chord(time=0.0, chord_id=0)
    assert c.high_density is False
    assert c.notes == []


# ── JSON-safety (#41) ────────────────────────────────────────────────────────
# The *_to_wire functions are documented as producing "JSON-ready" dicts that
# the highway WebSocket streams to the client. These tests catch things the
# Python-level round-trip tests above don't: non-JSON-native values (Path,
# Decimal, dataclass, set), and tuples (which JSON coerces to lists, failing
# the round-trip equality check).

def test_note_to_wire_is_json_safe():
    n = Note(
        time=0.5, string=0, fret=3,
        sustain=0.25, slide_to=7, slide_unpitch_to=9, bend=1.0,
        hammer_on=True, pull_off=True,
        harmonic=True, harmonic_pinch=True,
        palm_mute=True, mute=True,
        vibrato=True,
        tremolo=True, accent=True, tap=True,
    )
    wire = note_to_wire(n)
    # allow_nan=False rejects Infinity/NaN — which JS JSON.parse
    # also rejects. Keeps the wire strictly browser-compatible.
    assert json.loads(json.dumps(wire, allow_nan=False)) == wire


def test_note_from_wire_accepts_vibrato_flag():
    n = note_from_wire({"t": 1.0, "s": 2, "f": 7, "vb": True})
    assert n.vibrato is True
    legacy = note_from_wire({"t": 1.0, "s": 2, "f": 7, "vibrato": True})
    assert legacy.vibrato is True


def test_chord_to_wire_is_json_safe():
    c = Chord(
        time=2.0, chord_id=5, high_density=True,
        notes=[
            Note(time=2.0, string=0, fret=3, palm_mute=True),
            Note(time=2.0, string=1, fret=5),
            Note(time=2.0, string=2, fret=5),
        ],
    )
    wire = chord_to_wire(c)
    # allow_nan=False rejects Infinity/NaN — which JS JSON.parse
    # also rejects. Keeps the wire strictly browser-compatible.
    assert json.loads(json.dumps(wire, allow_nan=False)) == wire


def test_arrangement_to_wire_is_json_safe():
    # Same shape as test_arrangement_full_round_trip — exercises every nested
    # list / dict / int / str / bool path the wire format emits.
    arr = Arrangement(
        name="Rhythm",
        tuning=[-2, 0, 0, 0, 0, 0],
        capo=2,
        notes=[
            Note(time=1.0, string=0, fret=3, palm_mute=True),
            Note(time=1.5, string=1, fret=5, hammer_on=True),
        ],
        chords=[
            Chord(
                time=2.0, chord_id=1, high_density=True,
                notes=[
                    Note(time=2.0, string=0, fret=0),
                    Note(time=2.0, string=1, fret=2),
                ],
            ),
        ],
        anchors=[
            Anchor(time=0.0, fret=1, width=4),
            Anchor(time=10.0, fret=7, width=5),
        ],
        hand_shapes=[
            HandShape(chord_id=1, start_time=2.0, end_time=2.5),
        ],
        chord_templates=[
            ChordTemplate(
                name="Em",
                fingers=[-1, -1, 2, 3, -1, -1],
                frets=[0, 2, 2, 0, 0, 0],
            ),
        ],
    )
    wire = arrangement_to_wire(arr)
    # allow_nan=False rejects Infinity/NaN — which JS JSON.parse
    # also rejects. Keeps the wire strictly browser-compatible.
    assert json.loads(json.dumps(wire, allow_nan=False)) == wire


# ── Wire-format default-value fallbacks (#44) ────────────────────────────────
# Pin the fallback values embedded in arrangement_from_wire() so future
# refactors can't silently change what a sparse wire dict deserializes to.

def test_anchor_missing_width_defaults_to_four():
    # arrangement_from_wire: `width=int(a.get("width", 4))` at song.py:198
    arr = arrangement_from_wire({
        "name": "Lead",
        "anchors": [{"time": 0.0, "fret": 1}],  # no "width" key
    })
    assert len(arr.anchors) == 1
    assert arr.anchors[0].width == 4


def test_chord_template_missing_fingers_frets_defaults_to_negative_ones():
    # arrangement_from_wire: fingers/frets default to `[-1] * 6` at song.py:209-210
    arr = arrangement_from_wire({
        "name": "Rhythm",
        "templates": [{"name": "Em"}],  # no "fingers" or "frets" keys
    })
    assert len(arr.chord_templates) == 1
    ct = arr.chord_templates[0]
    assert ct.name == "Em"
    assert ct.fingers == [-1, -1, -1, -1, -1, -1]
    assert ct.frets == [-1, -1, -1, -1, -1, -1]


def test_chord_with_empty_notes_list_round_trips():
    # A chord with no notes (unusual but valid input) should survive round-trip.
    c = Chord(time=1.0, chord_id=3, notes=[])
    assert chord_from_wire(chord_to_wire(c)) == c


# ── arrangement_string_count (feedBack-plugin-3dhighway#7) ──────────────────

def test_string_count_4_for_bass_arrangement_with_full_string_usage():
    # 4-string bass: notes reference strings 0..3.
    arr = Arrangement(
        name="Bass",
        notes=[
            Note(time=0.0, string=0, fret=3),
            Note(time=1.0, string=2, fret=5),
            Note(time=2.0, string=3, fret=0),
        ],
    )
    assert arrangement_string_count(arr) == 4


def test_string_count_4_for_bass_with_sparse_string_usage():
    # 4-string bass with notes only on strings 0..2. Notes-derived
    # gives 3, but the name-based fallback bumps it to 4. This is
    # the case codex flagged as broken under the pure notes-derived
    # approach — a real-world bass line that doesn't touch the high
    # G string still has 4 strings on the instrument.
    arr = Arrangement(
        name="Bass",
        notes=[
            Note(time=0.0, string=0, fret=3),
            Note(time=1.0, string=1, fret=5),
            Note(time=2.0, string=2, fret=0),
        ],
    )
    assert arrangement_string_count(arr) == 4


def test_string_count_6_for_standard_guitar_with_full_string_usage():
    # Notes spread across all 6 strings.
    arr = Arrangement(
        name="Lead",
        notes=[Note(time=float(i), string=i, fret=0) for i in range(6)],
    )
    assert arrangement_string_count(arr) == 6


def test_string_count_6_for_guitar_with_sparse_string_usage():
    # 6-string lead chart with notes only on strings 0..4 (never
    # touches string 5, the highest-index string in RS indexing).
    # Notes-derived gives 5; name-based fallback (anything-not-bass
    # = 6) bumps to the correct 6.
    arr = Arrangement(
        name="Lead",
        notes=[Note(time=float(i), string=i, fret=0) for i in range(5)],
    )
    assert arrangement_string_count(arr) == 6


def test_string_count_uses_chord_notes_when_higher_than_single_notes():
    # Single notes only touch strings 0–2; the chord touches string 5.
    arr = Arrangement(
        name="Rhythm",
        notes=[Note(time=0.0, string=0, fret=0), Note(time=1.0, string=2, fret=3)],
        chords=[Chord(time=2.0, chord_id=0, notes=[
            Note(time=2.0, string=4, fret=0),
            Note(time=2.0, string=5, fret=0),
        ])],
    )
    assert arrangement_string_count(arr) == 6


def test_string_count_empty_bass_arrangement_returns_4():
    # Empty arrangement named "Bass" — name-based fallback wins.
    arr = Arrangement(name="Bass")
    assert arrangement_string_count(arr) == 4


def test_string_count_empty_non_bass_arrangement_returns_6():
    # Empty non-bass arrangement defaults to the canonical 6.
    arr = Arrangement(name="Lead")
    assert arrangement_string_count(arr) == 6


def test_string_count_7_for_extended_range_guitar():
    # 7-string guitar (GP-imported sources may carry these). Notes
    # span 0..6, so the notes-derived count is 7. The name-based
    # fallback gives 6, but max() picks the higher value — extended-
    # range arrangements are correctly handled WITHOUT having to
    # special-case "7-string" in the name.
    arr = Arrangement(
        name="Lead",
        notes=[Note(time=float(i), string=i, fret=0) for i in range(7)],
    )
    assert arrangement_string_count(arr) == 7


def test_string_count_5_for_extended_range_bass():
    # 5-string bass via GP import — notes span 0..4. Notes-derived
    # gives 5; name-based gives 4; max picks 5. No special-casing
    # for "5-string" in the arrangement name needed.
    arr = Arrangement(
        name="Bass",
        notes=[Note(time=float(i), string=i, fret=0) for i in range(5)],
    )
    assert arrangement_string_count(arr) == 5


def test_string_count_name_match_is_case_insensitive():
    arr_lower = Arrangement(name="bass")
    arr_upper = Arrangement(name="BASS")
    arr_mixed = Arrangement(name="Combo Bass")  # substring match
    assert arrangement_string_count(arr_lower) == 4
    assert arrangement_string_count(arr_upper) == 4
    assert arrangement_string_count(arr_mixed) == 4


def test_string_count_uses_tuning_length_for_sparse_extended_range_bass():
    # A sloppak / GP-imported 5-string bass may encode the
    # instrument range in tuning even if the chart never touches
    # the highest string index. tuning_count (5) wins over
    # notes_count (4) AND name_based (4) — extended-range bass
    # without name-based hints still resolves correctly.
    arr = Arrangement(
        name="Bass",
        tuning=[0, 0, 0, 0, 0],
        notes=[Note(time=float(i), string=i, fret=0) for i in range(4)],
    )
    assert arrangement_string_count(arr) == 5


def test_string_count_uses_tuning_length_for_sparse_7_string_guitar():
    # 7-string GP-imported guitar where the chart only uses
    # strings 0..5 (sparse top-string usage). tuning_count (7) is
    # the only reliable signal; notes_count gives 6 and name_based
    # gives 6.
    arr = Arrangement(
        name="Lead",
        tuning=[0, 0, 0, 0, 0, 0, 0],
        notes=[Note(time=float(i), string=i, fret=0) for i in range(6)],
    )
    assert arrangement_string_count(arr) == 7


def test_string_count_ignores_rs_padded_tuning_for_bass():
    # arrangement XML bass: tuning is padded to length 6 with zeros at
    # indices 4-5. Even though len(tuning) == 6, we MUST NOT use
    # that as a 6-string signal (would mis-classify bass as
    # guitar). arrangement_string_count's `tuning_count = 0 if
    # tuning_len == 6 else tuning_len` rule takes care of this.
    arr = Arrangement(
        name="Bass",
        tuning=[0, -5, -10, -15, 0, 0],  # bass with arrangement XML padding
        notes=[Note(time=float(i), string=i, fret=0) for i in range(4)],
    )
    assert arrangement_string_count(arr) == 4


# ── compute_smart_names ───────────────────────────────────────────────────────

def _sarr(path_lead=False, path_rhythm=False, path_bass=False,
          bonus_arr=False, represent=0, name="Combo") -> Arrangement:
    return Arrangement(
        name=name,
        path_lead=path_lead,
        path_rhythm=path_rhythm,
        path_bass=path_bass,
        bonus_arr=bonus_arr,
        represent=represent,
    )


def test_smart_names_single_lead():
    assert compute_smart_names([_sarr(path_lead=True)]) == ["Lead"]


def test_smart_names_single_rhythm():
    assert compute_smart_names([_sarr(path_rhythm=True)]) == ["Rhythm"]


def test_smart_names_single_bass():
    assert compute_smart_names([_sarr(path_bass=True, name="Bass")]) == ["Bass"]


def test_smart_names_lead_and_alt_lead():
    # represent=1 → standard ("Lead"); represent=0 → alternate ("Alt. Lead")
    arrs = [
        _sarr(path_lead=True, represent=0),   # index 0 → Alt. Lead
        _sarr(path_lead=True, represent=1),   # index 1 → Lead (standard)
    ]
    assert compute_smart_names(arrs) == ["Alt. Lead", "Lead"]


def test_smart_names_three_leads_main():
    # represent=1 → Lead; represent=0 and represent=2 → Alt. Lead 1 / 2
    # Alts are sorted by represent ascending: 0 comes before 2.
    arrs = [
        _sarr(path_lead=True, represent=0),   # index 0 → Alt. Lead 1
        _sarr(path_lead=True, represent=1),   # index 1 → Lead (standard)
        _sarr(path_lead=True, represent=2),   # index 2 → Alt. Lead 2
    ]
    assert compute_smart_names(arrs) == ["Alt. Lead 1", "Lead", "Alt. Lead 2"]


def test_smart_names_single_bonus_lead():
    assert compute_smart_names([_sarr(path_lead=True, bonus_arr=True)]) == ["Bonus Lead"]


def test_smart_names_two_bonus_leads():
    arrs = [
        _sarr(path_lead=True, bonus_arr=True, represent=0),
        _sarr(path_lead=True, bonus_arr=True, represent=1),
    ]
    assert compute_smart_names(arrs) == ["Bonus Lead 1", "Bonus Lead 2"]


def test_smart_names_full_mix():
    # 1 lead + 1 alt lead + 1 bonus lead + 1 rhythm + 1 bass
    # index 0: represent=0 → Alt. Lead
    # index 1: represent=1 → Lead (standard)
    # index 2: bonus_arr → Bonus Lead
    # index 3: represent=0, single rhythm → Rhythm (fallback: no represent=1)
    # index 4: represent=0, single bass   → Bass   (fallback: no represent=1)
    arrs = [
        _sarr(path_lead=True, represent=0),
        _sarr(path_lead=True, represent=1),
        _sarr(path_lead=True, bonus_arr=True, represent=0),
        _sarr(path_rhythm=True, represent=0),
        _sarr(path_bass=True, represent=0, name="Bass"),
    ]
    assert compute_smart_names(arrs) == [
        "Alt. Lead", "Lead", "Bonus Lead", "Rhythm", "Bass"
    ]


def test_smart_names_unknown_name_returns_none():
    # Arrangement without path flags and a name outside the fallback set
    # (Lead / Rhythm / Bass / Combo) → None. Distinct from Vocals/ShowLights,
    # which have their own explicit-skip coverage below.
    assert compute_smart_names([_sarr(name="JustSomethingElse")]) == [None]


def test_smart_names_name_fallback_when_path_flags_zero():
    # custom song often leaves path flags at 0; fall back to arrangement name
    arrs = [_sarr(name="Lead"), _sarr(name="Rhythm"), _sarr(name="Bass")]
    assert compute_smart_names(arrs) == ["Lead", "Rhythm", "Bass"]


def test_smart_names_combo_treated_as_lead():
    # "Combo" is a guitar arrangement — treated as Lead type for smart naming
    arrs = [_sarr(name="Combo")]
    assert compute_smart_names(arrs) == ["Lead"]


def test_smart_names_recognises_display_names_from_load_song():
    # load_song() synthesises display names like "Bonus Lead" / "Bass 2"
    # when manifest JSON is missing. compute_smart_names must classify them
    # via the name fallback (and infer bonus_arr for "Bonus *") so they
    # don't fall through to None and break smart-mode filtering.
    arrs = [
        _sarr(name="Lead"),         # standard main
        _sarr(name="Bonus Lead"),   # bonus → "Bonus Lead"
        _sarr(name="Bass 2"),       # bass-typed → "Bass" (alone in its group)
    ]
    assert compute_smart_names(arrs) == ["Lead", "Bonus Lead", "Bass"]


def test_smart_names_multiple_combos_get_alt_names():
    # 3 Combo tracks with represent=0 → Lead, Alt. Lead 1, Alt. Lead 2
    arrs = [_sarr(name="Combo"), _sarr(name="Combo"), _sarr(name="Combo")]
    assert compute_smart_names(arrs) == ["Lead", "Alt. Lead 1", "Alt. Lead 2"]


def test_smart_names_combo_and_bass_mixed():
    # Real-world custom song: 3 Combo + 1 Bass, all path flags zero
    arrs = [
        _sarr(name="Combo"),
        _sarr(name="Combo"),
        _sarr(name="Combo"),
        _sarr(name="Bass"),
    ]
    names = compute_smart_names(arrs)
    assert names == ["Lead", "Alt. Lead 1", "Alt. Lead 2", "Bass"]


def test_smart_names_path_flags_take_priority_over_name():
    # If path_rhythm is set, an arrangement named "Lead" is still Rhythm
    arrs = [_sarr(name="Lead", path_rhythm=True)]
    assert compute_smart_names(arrs) == ["Rhythm"]


def test_smart_names_represent_ordering():
    # Neither arrangement has represent=1, so the fallback applies:
    # sort alts by represent ascending and promote the first as standard.
    # represent=2 (index 1) < represent=5 (index 0) → index 1 becomes "Lead".
    arrs = [
        _sarr(path_lead=True, represent=5),
        _sarr(path_lead=True, represent=2),
    ]
    names = compute_smart_names(arrs)
    assert names[0] == "Alt. Lead"
    assert names[1] == "Lead"


def test_smart_names_vocals_returns_none():
    # "Vocals" and other non-instrument names return null
    assert compute_smart_names([_sarr(name="Vocals")]) == [None]
    assert compute_smart_names([_sarr(name="ShowLights")]) == [None]


def test_smart_names_arrangement_properties_defaults():
    # Verify new dataclass fields have correct defaults
    arr = Arrangement(name="Lead")
    assert arr.path_lead is False
    assert arr.path_rhythm is False
    assert arr.path_bass is False
    assert arr.bonus_arr is False
    assert arr.represent == 0


# ── tempos (per-chart §6.10 + shared sanitizer) ──────────────────────────────

def test_sanitize_tempos_filters_sorts_and_coerces():
    assert sanitize_tempos([
        {"time": 2.0, "bpm": 90},
        {"time": 0.0, "bpm": 120},
        {"time": 1.0, "bpm": 0},              # bpm <= 0 -> dropped
        {"time": float("nan"), "bpm": 100},   # non-finite time -> dropped
        {"bpm": 100},                         # missing time -> dropped
        {"time": 3.0, "bpm": float("inf")},   # non-finite bpm -> dropped
        "x",                                  # non-dict -> dropped
    ]) == [{"time": 0.0, "bpm": 120.0}, {"time": 2.0, "bpm": 90.0}]
    assert sanitize_tempos(None) == []
    assert sanitize_tempos("nope") == []


def test_arrangement_tempos_round_trip_and_omitted_when_absent():
    arr = arrangement_from_wire({
        "name": "Bass", "tuning": [0, 0, 0, 0, 0, 0], "capo": 0,
        "tempos": [{"time": 0.0, "bpm": 60}, {"time": 2.0, "bpm": 120}],
    })
    assert arr.tempos == [{"time": 0.0, "bpm": 60.0}, {"time": 2.0, "bpm": 120.0}]
    assert arrangement_to_wire(arr)["tempos"] == \
        [{"time": 0.0, "bpm": 60.0}, {"time": 2.0, "bpm": 120.0}]

    # Absent per-chart tempos -> None, and the wire key is OMITTED (not []),
    # so the chart follows the song-level tempo (spec §6.10).
    arr2 = arrangement_from_wire({"name": "Lead", "tuning": [0] * 6, "capo": 0})
    assert arr2.tempos is None
    assert "tempos" not in arrangement_to_wire(arr2)
