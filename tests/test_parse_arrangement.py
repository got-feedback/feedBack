"""Tests for lib/song.py parse_arrangement — XML → Arrangement.

Covers the per-phrase difficulty ladder logic added in feedBack#48
(Phrase / PhraseLevel extraction, None-sentinel semantics, the
fallback paths for missing or unusable phrase metadata) and the
<arrangementProperties> flag parsing for smart naming.
"""

import math

from song import parse_arrangement


def _write_xml(tmp_path, xml: str) -> str:
    """Write an XML snippet to a temp file and return its path."""
    p = tmp_path / "arr.xml"
    p.write_text(xml, encoding="utf-8")
    return str(p)


_TUNING_AND_TEMPLATES = (
    '<tuning string0="0" string1="0" string2="0" string3="0" string4="0" string5="0"/>'
    "<chordTemplates/>"
)


def test_hand_shape_parses_arpeggio_attribute(tmp_path):
    xml = (
        "<song>"
        + _TUNING_AND_TEMPLATES
        + '<levels count="1">'
        + '<level difficulty="0">'
        + '<notes count="0"/>'
        + '<chords count="0"/>'
        + '<anchors count="0"/>'
        + '<handShapes count="1">'
        + '<handShape chordId="2" startTime="1.0" endTime="2.0" arpeggio="1"/>'
        + "</handShapes>"
        + "</level>"
        + "</levels>"
        + "</song>"
    )
    arr = parse_arrangement(_write_xml(tmp_path, xml))
    assert len(arr.hand_shapes) == 1
    assert arr.hand_shapes[0].chord_id == 2
    assert arr.hand_shapes[0].arpeggio is True


def test_chord_template_parses_display_name_arpeggio_marker(tmp_path):
    xml = (
        "<song>"
        + '<tuning string0="0" string1="0" string2="0" string3="0" string4="0" string5="0"/>'
        + '<chordTemplates count="1">'
        + '<chordTemplate chordName="Amin" displayName="Amin-arp" '
        + 'finger1="1" finger2="2" fret1="5" fret2="7"/>'
        + "</chordTemplates>"
        + '<levels count="1">'
        + '<level difficulty="0">'
        + '<notes count="0"/>'
        + '<chords count="0"/>'
        + '<anchors count="0"/>'
        + '<handShapes count="0"/>'
        + "</level>"
        + "</levels>"
        + "</song>"
    )
    arr = parse_arrangement(_write_xml(tmp_path, xml))
    assert len(arr.chord_templates) == 1
    assert arr.chord_templates[0].name == "Amin"
    assert arr.chord_templates[0].display_name == "Amin-arp"
    assert arr.chord_templates[0].arpeggio is True


def test_chord_template_parses_explicit_arpeggio_attribute(tmp_path):
    xml = (
        "<song>"
        + '<tuning string0="0" string1="0" string2="0" string3="0" string4="0" string5="0"/>'
        + '<chordTemplates count="1">'
        + '<chordTemplate chordName="Amin" displayName="Amin" arpeggio="true" '
        + 'finger1="1" finger2="2" fret1="5" fret2="7"/>'
        + "</chordTemplates>"
        + '<levels count="1">'
        + '<level difficulty="0">'
        + '<notes count="0"/>'
        + '<chords count="0"/>'
        + '<anchors count="0"/>'
        + '<handShapes count="0"/>'
        + "</level>"
        + "</levels>"
        + "</song>"
    )
    arr = parse_arrangement(_write_xml(tmp_path, xml))
    assert len(arr.chord_templates) == 1
    assert arr.chord_templates[0].name == "Amin"
    assert arr.chord_templates[0].display_name == "Amin"
    assert arr.chord_templates[0].arpeggio is True


def test_parse_note_parses_vibrato_attribute(tmp_path):
    xml = (
        "<song>"
        + _TUNING_AND_TEMPLATES
        + '<levels count="1">'
        + '<level difficulty="0">'
        + '<notes count="1">'
        + '<note time="1.0" string="0" fret="5" sustain="0.5" vibrato="1"/>'
        + "</notes>"
        + '<chords count="0"/>'
        + '<anchors count="0"/>'
        + '<handShapes count="0"/>'
        + "</level>"
        + "</levels>"
        + "</song>"
    )
    arr = parse_arrangement(_write_xml(tmp_path, xml))
    assert len(arr.notes) == 1
    assert arr.notes[0].vibrato is True


def _song(levels_xml: str, phrases_xml: str = "", iters_xml: str = "") -> str:
    return (
        "<song>"
        + _TUNING_AND_TEMPLATES
        + levels_xml
        + phrases_xml
        + iters_xml
        + "</song>"
    )


def _level(diff: int, notes: list[tuple[float, int, int]]) -> str:
    note_elems = "".join(
        f'<note time="{t}" string="{s}" fret="{f}" sustain="0"/>'
        for (t, s, f) in notes
    )
    return (
        f'<level difficulty="{diff}">'
        f'<notes count="{len(notes)}">{note_elems}</notes>'
        '<chords count="0"/>'
        '<anchors count="0"/>'
        '<handShapes count="0"/>'
        "</level>"
    )


# ── Happy path: multi-level XML with phrases ─────────────────────────────────

def test_parse_multi_level_populates_phrase_ladder(tmp_path):
    # Two phrases, three difficulty tiers. Phrase 0 has max_diff=1 so
    # only tiers 0 and 1 are in its ladder; phrase 1 has max_diff=2 so
    # all three tiers are in its ladder. Flat merge = max-mastery per
    # phrase window.
    xml = _song(
        '<levels count="3">'
        + _level(0, [(1.0, 0, 5)])
        + _level(1, [(1.0, 0, 5), (2.0, 1, 3)])
        + _level(2, [(1.0, 0, 5), (2.0, 1, 3), (3.0, 2, 7)])
        + "</levels>",
        '<phrases>'
        '<phrase maxDifficulty="1" name="a"/>'
        '<phrase maxDifficulty="2" name="b"/>'
        "</phrases>",
        '<phraseIterations>'
        '<phraseIteration time="0" phraseId="0"/>'
        '<phraseIteration time="1.5" phraseId="1"/>'
        "</phraseIterations>",
    )
    arr = parse_arrangement(_write_xml(tmp_path, xml))

    assert arr.phrases is not None
    assert len(arr.phrases) == 2

    p0, p1 = arr.phrases
    assert p0.max_difficulty == 1
    assert [lv.difficulty for lv in p0.levels] == [0, 1]
    assert p1.max_difficulty == 2
    assert [lv.difficulty for lv in p1.levels] == [0, 1, 2]

    # Per-level clipping works: phrase 0 window is [0.0, 1.5),
    # so tier 1 has only the t=1.0 note (t=2.0 is outside).
    p0_lv1 = next(lv for lv in p0.levels if lv.difficulty == 1)
    assert [n.time for n in p0_lv1.notes] == [1.0]

    # Phrase 1 tier 2 window [1.5, ∞) picks up t=2.0 and t=3.0.
    p1_lv2 = next(lv for lv in p1.levels if lv.difficulty == 2)
    assert [n.time for n in p1_lv2.notes] == [2.0, 3.0]

    # Flat max-mastery merge still produces the full chart for
    # existing consumers (phrase 0 @ tier 1 = [1.0], phrase 1 @ tier 2
    # = [2.0, 3.0]).
    assert [(n.time, n.fret) for n in arr.notes] == [(1.0, 5), (2.0, 3), (3.0, 7)]


# ── Single-level XML: no phrase metadata needed ──────────────────────────────

def test_parse_single_level_disables_slider(tmp_path):
    # Single-level charts (e.g. GP-converted) skip the phrase branch
    # entirely — phrases stays None so the frontend knows to disable
    # the slider, and the flat lists get the one level directly.
    xml = _song(
        '<levels count="1">' + _level(0, [(1.0, 0, 5), (2.0, 1, 3)]) + "</levels>",
    )
    arr = parse_arrangement(_write_xml(tmp_path, xml))

    assert arr.phrases is None
    assert [(n.time, n.fret) for n in arr.notes] == [(1.0, 5), (2.0, 3)]


# ── No phrase metadata at all → best-level fallback ──────────────────────────

def test_parse_multi_level_without_phrase_metadata_falls_back(tmp_path):
    # Multiple levels but neither <phrases> nor <phraseIterations>.
    # The best-level fallback picks the highest-count level.
    xml = _song(
        '<levels count="2">'
        + _level(0, [(1.0, 0, 5)])
        + _level(1, [(1.0, 0, 5), (2.0, 1, 3), (3.0, 2, 7)])
        + "</levels>",
    )
    arr = parse_arrangement(_write_xml(tmp_path, xml))

    assert arr.phrases is None
    assert [(n.time, n.fret) for n in arr.notes] == [(1.0, 5), (2.0, 3), (3.0, 7)]


# ── Empty phraseIterations → revert sentinel, run best-level fallback ────────

def test_parse_empty_phrase_iterations_reverts_to_best_level(tmp_path):
    # <phraseIterations> present but empty. The phrase branch enters,
    # produces no phrases, then the revert runs the best-level fallback
    # inline so we don't ship an empty arrangement with the slider
    # enabled against no ladder.
    xml = _song(
        '<levels count="2">'
        + _level(0, [(1.0, 0, 5)])
        + _level(1, [(1.0, 0, 5), (2.0, 1, 3)])
        + "</levels>",
        '<phrases><phrase maxDifficulty="1" name="a"/></phrases>',
        "<phraseIterations/>",
    )
    arr = parse_arrangement(_write_xml(tmp_path, xml))

    assert arr.phrases is None
    assert [(n.time, n.fret) for n in arr.notes] == [(1.0, 5), (2.0, 3)]


# ── max_diff below every authored level → skip iteration, still ship valid ──

def test_parse_skips_phrase_iteration_when_no_level_reaches_max_diff(tmp_path):
    # Phrase 0 declares max_diff=0, but only levels 1 and 2 are authored.
    # That iteration has nothing valid to contribute — skip it so the
    # slider doesn't enable against an empty ladder. Phrase 1 still
    # produces a valid ladder, so phrases is non-None and the flat
    # merge comes from phrase 1 only.
    xml = _song(
        '<levels count="2">'
        + _level(1, [(2.0, 0, 5)])
        + _level(2, [(2.0, 0, 5), (3.0, 1, 3)])
        + "</levels>",
        '<phrases>'
        '<phrase maxDifficulty="0" name="unreachable"/>'
        '<phrase maxDifficulty="2" name="ok"/>'
        "</phrases>",
        '<phraseIterations>'
        '<phraseIteration time="0" phraseId="0"/>'
        '<phraseIteration time="1.5" phraseId="1"/>'
        "</phraseIterations>",
    )
    arr = parse_arrangement(_write_xml(tmp_path, xml))

    assert arr.phrases is not None
    assert len(arr.phrases) == 1
    assert arr.phrases[0].max_difficulty == 2
    assert arr.phrases[0].start_time == 1.5

    # Flat merge only picks up phrase 1's contribution — phrase 0 was
    # skipped, so the t=0–1.5 window produces nothing.
    assert [(n.time, n.fret) for n in arr.notes] == [(2.0, 5), (3.0, 3)]


# ── Last phrase has finite end_time (not Infinity) ──────────────────────────

def test_parse_last_phrase_end_time_is_finite(tmp_path):
    # The last phrase iteration has no "next" start time to use as its
    # end, so parse_arrangement derives one from the last real event
    # across all levels. Must be finite: this value ends up in
    # Phrase.end_time on the WebSocket wire, and JSON has no Infinity
    # literal — JS JSON.parse would reject it.
    xml = _song(
        '<levels count="2">'
        + _level(0, [(1.0, 0, 5)])
        + _level(1, [(1.0, 0, 5), (2.0, 1, 3)])
        + "</levels>",
        '<phrases>'
        '<phrase maxDifficulty="1" name="a"/>'
        '<phrase maxDifficulty="1" name="b"/>'
        "</phrases>",
        '<phraseIterations>'
        '<phraseIteration time="0" phraseId="0"/>'
        '<phraseIteration time="1.5" phraseId="1"/>'
        "</phraseIterations>",
    )
    arr = parse_arrangement(_write_xml(tmp_path, xml))

    assert arr.phrases is not None
    last = arr.phrases[-1]
    assert math.isfinite(last.end_time)
    # And it should be past the last real event (t=2.0) so the slice
    # window includes it.
    assert last.end_time > 2.0


# ── song_end covers anchors / hand shapes / sustains past the last note ────

def test_parse_last_phrase_end_time_covers_non_note_events(tmp_path):
    # The last event in the chart isn't always a note or chord — an
    # anchor, a hand shape's end_time, or a note's sustain extending
    # past its start can all push the real song end past the last
    # note/chord start. song_end must cover every event type so the
    # final phrase window doesn't slice them out.
    xml = (
        "<song>"
        + _TUNING_AND_TEMPLATES
        + '<levels count="1">'
        + '<level difficulty="0">'
        # Notes stop at t=2.0 (but with a long sustain out to t=10.0)
        + '<notes count="1"><note time="2.0" string="0" fret="5" sustain="8.0"/></notes>'
        + '<chords count="0"/>'
        # Anchor way past the last note start
        + '<anchors count="1"><anchor time="20.0" fret="3" width="4"/></anchors>'
        # Hand shape ending even later
        + '<handShapes count="1"><handShape chordId="0" startTime="5.0" endTime="25.0"/></handShapes>'
        + "</level>"
        + "</levels>"
        + '<phrases><phrase maxDifficulty="0" name="a"/></phrases>'
        '<phraseIterations><phraseIteration time="0" phraseId="0"/></phraseIterations>'
        + "</song>"
    )
    # Need ≥2 levels to enter the phrase branch, so prepend a second
    # level. Its contents don't matter for what this test checks —
    # song_end is computed across all levels, and the anchor / hand
    # shape on the original level 0 are what push the bound past the
    # note starts.
    xml = xml.replace(
        '<levels count="1">',
        '<levels count="2">' + _level(1, [(2.0, 0, 5)]),
    )
    arr = parse_arrangement(_write_xml(tmp_path, xml))

    assert arr.phrases is not None
    last = arr.phrases[-1]
    # Must cover the hand-shape end (t=25.0), which is past every note
    # and chord start time.
    assert last.end_time > 25.0


# ── Trailing-silence phrase iteration past the last event ───────────────────

def test_parse_trailing_phrase_iteration_past_last_event(tmp_path):
    # Some charts place a silent phrase marker well past the last
    # authored note/chord. If song_end were derived from events only,
    # the last phrase would get end_time < start_time — invalid window,
    # empty slice. Bound song_end by iteration start times too.
    xml = _song(
        '<levels count="2">'
        + _level(0, [(1.0, 0, 5)])
        + _level(1, [(1.0, 0, 5)])
        + "</levels>",
        '<phrases>'
        '<phrase maxDifficulty="1" name="a"/>'
        '<phrase maxDifficulty="1" name="silence"/>'
        "</phrases>",
        '<phraseIterations>'
        '<phraseIteration time="0" phraseId="0"/>'
        '<phraseIteration time="100.0" phraseId="1"/>'
        "</phraseIterations>",
    )
    arr = parse_arrangement(_write_xml(tmp_path, xml))

    assert arr.phrases is not None
    last = arr.phrases[-1]
    assert last.start_time == 100.0
    assert last.end_time >= last.start_time
    assert math.isfinite(last.end_time)


# ── All phrase iterations reference out-of-range phraseIds → fallback ───────

def test_parse_all_phrase_iterations_out_of_range_falls_back(tmp_path):
    # phrase_list has only 1 entry but an iteration references phraseId=5.
    # All iterations get skipped via `continue`, phrases stays empty,
    # revert + best-level fallback kicks in.
    xml = _song(
        '<levels count="2">'
        + _level(0, [(1.0, 0, 5)])
        + _level(1, [(1.0, 0, 5), (2.0, 1, 3)])
        + "</levels>",
        '<phrases><phrase maxDifficulty="1" name="a"/></phrases>',
        '<phraseIterations>'
        '<phraseIteration time="0" phraseId="5"/>'
        "</phraseIterations>",
    )
    arr = parse_arrangement(_write_xml(tmp_path, xml))

    assert arr.phrases is None
    assert [(n.time, n.fret) for n in arr.notes] == [(1.0, 5), (2.0, 3)]


# ── Extended-range tuning + chord templates (7/8-string, 5/6-string bass) ───

def test_parse_arrangement_preserves_7_string_tuning(tmp_path):
    """`string6` on <tuning> must be appended so 7/8-string arrangements
    round-trip through GP → XML → parse correctly."""
    xml = (
        "<song>"
        '<tuning string0="0" string1="0" string2="0" string3="0" '
        'string4="0" string5="0" string6="0"/>'
        "<chordTemplates/>"
        '<levels count="1">'
        + _level(0, [(1.0, 0, 5)])
        + "</levels>"
        "</song>"
    )
    arr = parse_arrangement(_write_xml(tmp_path, xml))
    assert len(arr.tuning) == 7
    assert arr.tuning == [0, 0, 0, 0, 0, 0, 0]


def test_parse_arrangement_preserves_8_string_drop_tuning(tmp_path):
    """8-string with low F# (`string7`) and Drop D on the lowest string."""
    xml = (
        "<song>"
        '<tuning string0="-2" string1="0" string2="0" string3="0" '
        'string4="0" string5="0" string6="0" string7="0"/>'
        "<chordTemplates/>"
        '<levels count="1">'
        + _level(0, [(1.0, 0, 5)])
        + "</levels>"
        "</song>"
    )
    arr = parse_arrangement(_write_xml(tmp_path, xml))
    assert arr.tuning == [-2, 0, 0, 0, 0, 0, 0, 0]


def test_parse_arrangement_extended_chord_template(tmp_path):
    """fret6/finger6 attrs round-trip into the parsed ChordTemplate."""
    xml = (
        "<song>"
        '<tuning string0="0" string1="0" string2="0" string3="0" '
        'string4="0" string5="0" string6="0"/>'
        "<chordTemplates>"
        '<chordTemplate chordName="Em7-ext" '
        'fret0="0" fret1="0" fret2="0" fret3="2" '
        'fret4="2" fret5="0" fret6="0" '
        'finger0="-1" finger1="-1" finger2="-1" finger3="2" '
        'finger4="3" finger5="-1" finger6="-1"/>'
        "</chordTemplates>"
        '<levels count="1">'
        + _level(0, [(1.0, 0, 0)])
        + "</levels>"
        "</song>"
    )
    arr = parse_arrangement(_write_xml(tmp_path, xml))
    assert len(arr.chord_templates) == 1
    ct = arr.chord_templates[0]
    assert ct.name == "Em7-ext"
    assert ct.frets == [0, 0, 0, 2, 2, 0, 0]
    assert ct.fingers == [-1, -1, -1, 2, 3, -1, -1]


def test_parse_arrangement_6_string_template_no_width_inflation(tmp_path):
    """A plain 6-string chord template parses with length-6 frets/fingers
    when no `fret6`/`finger6` is present — no spurious slot expansion."""
    xml = (
        "<song>"
        '<tuning string0="0" string1="0" string2="0" string3="0" '
        'string4="0" string5="0"/>'
        "<chordTemplates>"
        '<chordTemplate chordName="C" '
        'fret0="-1" fret1="3" fret2="2" fret3="0" fret4="1" fret5="0" '
        'finger0="-1" finger1="3" finger2="2" finger3="-1" '
        'finger4="1" finger5="-1"/>'
        "</chordTemplates>"
        '<levels count="1">'
        + _level(0, [(1.0, 0, 0)])
        + "</levels>"
        "</song>"
    )
    arr = parse_arrangement(_write_xml(tmp_path, xml))
    ct = arr.chord_templates[0]
    assert len(ct.frets) == 6
    assert len(ct.fingers) == 6


# ── <arrangementProperties> parsing for smart naming ─────────────────────────

_EMPTY_LEVELS = (
    '<levels count="1">'
    '<level difficulty="0">'
    '<notes count="0"/><chords count="0"/>'
    '<anchors count="0"/><handShapes count="0"/>'
    "</level></levels>"
)


def test_arrangement_properties_lead_parsed(tmp_path):
    xml = (
        "<song>"
        + _TUNING_AND_TEMPLATES
        + '<arrangementProperties pathLead="1" pathRhythm="0" pathBass="0"'
        + ' bonusArr="0" represent="3"/>'
        + _EMPTY_LEVELS
        + "</song>"
    )
    arr = parse_arrangement(_write_xml(tmp_path, xml))
    assert arr.path_lead is True
    assert arr.path_rhythm is False
    assert arr.path_bass is False
    assert arr.bonus_arr is False
    assert arr.represent == 3


def test_arrangement_properties_bass_bonus_parsed(tmp_path):
    xml = (
        "<song>"
        + _TUNING_AND_TEMPLATES
        + '<arrangementProperties pathLead="0" pathRhythm="0" pathBass="1"'
        + ' bonusArr="1" represent="7"/>'
        + _EMPTY_LEVELS
        + "</song>"
    )
    arr = parse_arrangement(_write_xml(tmp_path, xml))
    assert arr.path_lead is False
    assert arr.path_bass is True
    assert arr.bonus_arr is True
    assert arr.represent == 7


def test_arrangement_properties_defaults_when_element_missing(tmp_path):
    xml = (
        "<song>"
        + _TUNING_AND_TEMPLATES
        + _EMPTY_LEVELS
        + "</song>"
    )
    arr = parse_arrangement(_write_xml(tmp_path, xml))
    assert arr.path_lead is False
    assert arr.path_rhythm is False
    assert arr.path_bass is False
    assert arr.bonus_arr is False
    assert arr.represent == 0


def test_arrangement_properties_represent_zero_is_default(tmp_path):
    xml = (
        "<song>"
        + _TUNING_AND_TEMPLATES
        + '<arrangementProperties pathLead="1" pathRhythm="0" pathBass="0"'
        + ' bonusArr="0" represent="0"/>'
        + _EMPTY_LEVELS
        + "</song>"
    )
    arr = parse_arrangement(_write_xml(tmp_path, xml))
    assert arr.represent == 0
    assert arr.path_lead is True


def test_chord_level_fret_hand_mute_maps_to_fret_hand_mute(tmp_path):
    """Chord-wide fretHandMute on a template-expanded chord sets
    fret_hand_mute (wire "fhm") on each synthetic note, not mute ("mt") —
    matching _parse_note and preserving wire-format fidelity."""
    xml = (
        "<song>"
        + '<tuning string0="0" string1="0" string2="0" string3="0" string4="0" string5="0"/>'
        + '<chordTemplates count="1">'
        + '<chordTemplate chordName="P5" displayName="P5" fret0="3" fret1="5"/>'
        + "</chordTemplates>"
        + '<levels count="1">'
        + '<level difficulty="0">'
        + '<notes count="0"/>'
        + '<chords count="1">'
        + '<chord time="1.0" chordId="0" fretHandMute="1"/>'
        + "</chords>"
        + '<anchors count="0"/>'
        + '<handShapes count="0"/>'
        + "</level>"
        + "</levels>"
        + "</song>"
    )
    arr = parse_arrangement(_write_xml(tmp_path, xml))
    assert len(arr.chords) == 1
    notes = arr.chords[0].notes
    assert notes  # template expanded into synthetic notes
    assert all(n.fret_hand_mute is True for n in notes)
    assert all(n.mute is False for n in notes)


def test_chord_level_fret_hand_mute_propagates_to_chord_notes(tmp_path):
    """A <chord fretHandMute="1"> with explicit <chordNote> children sets
    fret_hand_mute on children that don't override it, without touching mute."""
    xml = (
        "<song>"
        + _TUNING_AND_TEMPLATES
        + '<levels count="1">'
        + '<level difficulty="0">'
        + '<notes count="0"/>'
        + '<chords count="1">'
        + '<chord time="1.0" chordId="0" fretHandMute="1">'
        + '<chordNote time="1.0" string="0" fret="3"/>'
        + '<chordNote time="1.0" string="1" fret="5" fretHandMute="0"/>'
        + "</chord>"
        + "</chords>"
        + '<anchors count="0"/>'
        + '<handShapes count="0"/>'
        + "</level>"
        + "</levels>"
        + "</song>"
    )
    arr = parse_arrangement(_write_xml(tmp_path, xml))
    notes = arr.chords[0].notes
    assert len(notes) == 2
    assert notes[0].fret_hand_mute is True   # inherits chord-level flag
    assert notes[1].fret_hand_mute is False  # explicit override preserved
    assert all(n.mute is False for n in notes)


def test_cent_offset_parsed_from_xml(tmp_path):
    xml = (
        "<song>"
        + "<centOffset>-1200.0</centOffset>"
        + _TUNING_AND_TEMPLATES
        + '<levels count="1">'
        + '<level difficulty="0">'
        + '<notes count="0"/><chords count="0"/>'
        + '<anchors count="0"/><handShapes count="0"/>'
        + "</level></levels>"
        + "</song>"
    )
    arr = parse_arrangement(_write_xml(tmp_path, xml))
    assert arr.cent_offset == -1200.0


def test_cent_offset_defaults_to_zero_when_absent(tmp_path):
    xml = (
        "<song>"
        + _TUNING_AND_TEMPLATES
        + '<levels count="1">'
        + '<level difficulty="0">'
        + '<notes count="0"/><chords count="0"/>'
        + '<anchors count="0"/><handShapes count="0"/>'
        + "</level></levels>"
        + "</song>"
    )
    arr = parse_arrangement(_write_xml(tmp_path, xml))
    assert arr.cent_offset == 0.0


def test_cent_offset_round_trips_through_wire_format(tmp_path):
    from song import arrangement_to_wire, arrangement_from_wire

    xml = (
        "<song>"
        + "<centOffset>-1200</centOffset>"
        + _TUNING_AND_TEMPLATES
        + '<levels count="1">'
        + '<level difficulty="0">'
        + '<notes count="0"/><chords count="0"/>'
        + '<anchors count="0"/><handShapes count="0"/>'
        + "</level></levels>"
        + "</song>"
    )
    arr = parse_arrangement(_write_xml(tmp_path, xml))
    wire = arrangement_to_wire(arr)
    assert wire["centOffset"] == -1200.0
    arr2 = arrangement_from_wire(wire)
    assert arr2.cent_offset == -1200.0


def test_cent_offset_non_finite_sanitized_to_zero(tmp_path):
    # Malformed custom song can carry NaN/Infinity, which float() accepts but which
    # serialize to invalid JSON tokens over the song_info WebSocket. Parsing
    # must coerce them to a finite 0.0 so the payload stays valid JSON.
    for bad in ("NaN", "Infinity", "-Infinity", "inf", "nan"):
        xml = (
            "<song>"
            + f"<centOffset>{bad}</centOffset>"
            + _TUNING_AND_TEMPLATES
            + '<levels count="1">'
            + '<level difficulty="0">'
            + '<notes count="0"/><chords count="0"/>'
            + '<anchors count="0"/><handShapes count="0"/>'
            + "</level></levels>"
            + "</song>"
        )
        arr = parse_arrangement(_write_xml(tmp_path, xml))
        assert arr.cent_offset == 0.0, f"{bad!r} should sanitize to 0.0"


def test_cent_offset_non_finite_sanitized_through_wire(tmp_path):
    from song import arrangement_from_wire

    # A wire dict carrying a non-finite centOffset (e.g. from a hand-edited or
    # corrupt sloppak JSON) is coerced to 0.0 on the way back in.
    arr = arrangement_from_wire({"centOffset": float("nan")})
    assert arr.cent_offset == 0.0
