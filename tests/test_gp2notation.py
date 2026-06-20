"""Tests for lib/gp2notation.py — Guitar Pro → Sloppak Notation importer.

Fixture-free in the gp2rs_gpx style: every test drives the importer with a
hand-built GPIF ElementTree (and, for the convert_file wiring tests, a
monkeypatched ``_load_gpif``). Covers measure/beat/note emission, the
PR #703 voice→staff routing, tuplets, ties, dots, rests, beat_groups for
compound meters, tempo/ts change-only emission, the Piano LH/RH merge path,
and the sidecar + manifest attachment helpers.
"""

import json
import xml.etree.ElementTree as ET

import pytest
import yaml

import gp2notation
import gp2rs_gpx
from gp2notation import (
    attach_notation_to_sloppak,
    beat_groups_for,
    convert_track_to_notation,
    notation_sidecar_path,
    write_notation_sidecar,
)


# ── beat_groups_for ──────────────────────────────────────────────────────────

@pytest.mark.parametrize("num, den, expected", [
    (4, 4, None),          # simple meters: omitted
    (3, 4, None),
    (2, 4, None),
    (6, 8, [3, 3]),        # compound
    (9, 8, [3, 3, 3]),
    (12, 8, [3, 3, 3, 3]),
    (5, 8, [2, 3]),        # common irregular defaults
    (7, 8, [2, 2, 3]),
    (3, 8, None),          # single dotted beat — unambiguous
    (4, 8, None),
    (11, 8, None),         # uncommon irregular — renderer default
])
def test_beat_groups_for(num, den, expected):
    assert beat_groups_for(num, den) == expected


def test_beat_groups_sum_equals_numerator():
    # Spec invariant: the sum must equal the time-signature numerator.
    for num in range(2, 16):
        groups = beat_groups_for(num, 8)
        if groups is not None:
            assert sum(groups) == num


# ── Fixture builders ─────────────────────────────────────────────────────────

def _gpif(tracks_xml, masterbars_xml, bars_xml, voices_xml, beats_xml,
          notes_xml, rhythms_xml, extra=""):
    return ET.fromstring(f"""
<GPIF>
  <Score><Title>T</Title><Artist>A</Artist></Score>
  {extra}
  <Tracks>{tracks_xml}</Tracks>
  <MasterBars>{masterbars_xml}</MasterBars>
  <Bars>{bars_xml}</Bars>
  <Voices>{voices_xml}</Voices>
  <Beats>{beats_xml}</Beats>
  <Notes>{notes_xml}</Notes>
  <Rhythms>{rhythms_xml}</Rhythms>
</GPIF>""")


def _note_sf(nid, string, fret, tied=False):
    tie = '<Tie destination="true"/>' if tied else ""
    return (f'<Note id="{nid}">{tie}'
            f'<Property name="String"><String>{string}</String></Property>'
            f'<Property name="Fret"><Fret>{fret}</Fret></Property></Note>')


def _note_tone(nid, step, octave):
    return (f'<Note id="{nid}">'
            f'<Property name="Tone"><Step>{step}</Step></Property>'
            f'<Property name="Octave"><Number>{octave}</Number></Property></Note>')


# ── Voice → staff routing (PR #703 salvage) ──────────────────────────────────

def _two_voice_piano_root():
    """One 4/4 bar; voice 0 = E4 quarter (rh), voice 1 = C3 quarter (lh)."""
    return _gpif(
        tracks_xml='<Track id="0"><Name>Piano</Name>'
                   '<Property name="Tuning"><Pitches>40</Pitches></Property></Track>',
        masterbars_xml='<MasterBar><Time>4/4</Time><Bars>0</Bars></MasterBar>',
        bars_xml='<Bar id="0"><Voices>0 1</Voices></Bar>',
        voices_xml='<Voice id="0"><Beats>b0</Beats></Voice>'
                   '<Voice id="1"><Beats>b1</Beats></Voice>',
        beats_xml='<Beat id="b0"><Rhythm ref="r4"/><Notes>n0</Notes></Beat>'
                  '<Beat id="b1"><Rhythm ref="r4"/><Notes>n1</Notes></Beat>',
        notes_xml=_note_sf("n0", 0, 24) + _note_sf("n1", 0, 8),  # midi 64, 48
        rhythms_xml='<Rhythm id="r4"><NoteValue>Quarter</NoteValue></Rhythm>',
    )


def test_voice_zero_routes_rh_voice_one_routes_lh():
    payload = convert_track_to_notation(_two_voice_piano_root(), 0, [40])
    assert [s["id"] for s in payload["staves"]] == ["rh", "lh"]
    assert payload["staves"][0]["clef"] == "G2"
    assert payload["staves"][1]["clef"] == "F4"

    m = payload["measures"][0]
    rh_beats = m["staves"]["rh"]["voices"][0]["beats"]
    lh_beats = m["staves"]["lh"]["voices"][0]["beats"]
    assert rh_beats[0]["notes"] == [{"midi": 64}]
    assert lh_beats[0]["notes"] == [{"midi": 48}]


def test_forced_lh_track_name_routes_everything_lh():
    root = _two_voice_piano_root()
    payload = convert_track_to_notation(root, 0, [40], track_name="Piano LH")
    assert [s["id"] for s in payload["staves"]] == ["lh"]
    m = payload["measures"][0]
    assert "rh" not in m["staves"]
    # Both voices land on lh, as separate voice entries.
    voices = m["staves"]["lh"]["voices"]
    assert [v["v"] for v in voices] == [1, 2]


def test_single_voice_track_emits_single_staff():
    root = _gpif(
        tracks_xml='<Track id="0"><Name>Synth</Name></Track>',
        masterbars_xml='<MasterBar><Time>4/4</Time><Bars>0</Bars></MasterBar>',
        bars_xml='<Bar id="0"><Voices>0</Voices></Bar>',
        voices_xml='<Voice id="0"><Beats>b0</Beats></Voice>',
        beats_xml='<Beat id="b0"><Rhythm ref="r4"/><Notes>n0</Notes></Beat>',
        notes_xml=_note_tone("n0", 0, 4),  # C4 = 60
        rhythms_xml='<Rhythm id="r4"><NoteValue>Quarter</NoteValue></Rhythm>',
    )
    payload = convert_track_to_notation(root, 0, [])
    assert [s["id"] for s in payload["staves"]] == ["rh"]


# ── Pitch extraction ─────────────────────────────────────────────────────────

def test_tone_octave_encoding_yields_absolute_midi():
    root = _gpif(
        tracks_xml='<Track id="0"><Name>Piano</Name></Track>',
        masterbars_xml='<MasterBar><Time>4/4</Time><Bars>0</Bars></MasterBar>',
        bars_xml='<Bar id="0"><Voices>0</Voices></Bar>',
        voices_xml='<Voice id="0"><Beats>b0 b1</Beats></Voice>',
        beats_xml='<Beat id="b0"><Rhythm ref="r4"/><Notes>n0</Notes></Beat>'
                  '<Beat id="b1"><Rhythm ref="r4"/><Notes>n1</Notes></Beat>',
        notes_xml=_note_tone("n0", 0, 4) + _note_tone("n1", 5, 3),  # C4=60, A3=57
        rhythms_xml='<Rhythm id="r4"><NoteValue>Quarter</NoteValue></Rhythm>',
    )
    payload = convert_track_to_notation(root, 0, [])
    beats = payload["measures"][0]["staves"]["rh"]["voices"][0]["beats"]
    assert beats[0]["notes"] == [{"midi": 60}]
    assert beats[1]["notes"] == [{"midi": 57}]


def test_string_fret_encoding_is_concert_pitch():
    # string_pitches[0] = 48 (C3), fret 12 → midi 60 — absolute, no tuning offset.
    root = _gpif(
        tracks_xml='<Track id="0"><Name>Keys</Name>'
                   '<Property name="Tuning"><Pitches>48</Pitches></Property></Track>',
        masterbars_xml='<MasterBar><Time>4/4</Time><Bars>0</Bars></MasterBar>',
        bars_xml='<Bar id="0"><Voices>0</Voices></Bar>',
        voices_xml='<Voice id="0"><Beats>b0</Beats></Voice>',
        beats_xml='<Beat id="b0"><Rhythm ref="r4"/><Notes>n0</Notes></Beat>',
        notes_xml=_note_sf("n0", 0, 12),
        rhythms_xml='<Rhythm id="r4"><NoteValue>Quarter</NoteValue></Rhythm>',
    )
    payload = convert_track_to_notation(root, 0, [48])
    beats = payload["measures"][0]["staves"]["rh"]["voices"][0]["beats"]
    assert beats[0]["notes"] == [{"midi": 60}]


# ── Durations, dots, tuplets, rests, ties, timing ────────────────────────────

def test_durations_dots_tuplets_rests_and_times():
    # 120 BPM 4/4: dotted-eighth (0.375s) + 16th (0.125s) + triplet-eighth
    # rest (1/3 s) + quarter — times accumulate via _beat_secs.
    root = _gpif(
        tracks_xml='<Track id="0"><Name>Piano</Name></Track>',
        masterbars_xml='<MasterBar><Time>4/4</Time><Bars>0</Bars></MasterBar>',
        bars_xml='<Bar id="0"><Voices>0</Voices></Bar>',
        voices_xml='<Voice id="0"><Beats>b0 b1 b2 b3</Beats></Voice>',
        beats_xml='<Beat id="b0"><Rhythm ref="rde"/><Notes>n0</Notes></Beat>'
                  '<Beat id="b1"><Rhythm ref="r16"/><Notes>n1</Notes></Beat>'
                  '<Beat id="b2"><Rhythm ref="rt8"/></Beat>'
                  '<Beat id="b3"><Rhythm ref="r4"/><Notes>n2</Notes></Beat>',
        notes_xml=_note_tone("n0", 0, 4) + _note_tone("n1", 1, 4) + _note_tone("n2", 2, 4),
        rhythms_xml=(
            '<Rhythm id="rde"><NoteValue>Eighth</NoteValue><AugmentationDot count="1"/></Rhythm>'
            '<Rhythm id="r16"><NoteValue>16th</NoteValue></Rhythm>'
            '<Rhythm id="rt8"><NoteValue>Eighth</NoteValue><PrimaryTuplet num="3" den="2"/></Rhythm>'
            '<Rhythm id="r4"><NoteValue>Quarter</NoteValue></Rhythm>'
        ),
        extra='<MasterTrack><Automations><Automation><Type>Tempo</Type>'
              '<Bar>0</Bar><Value>120 2</Value></Automation></Automations></MasterTrack>',
    )
    payload = convert_track_to_notation(root, 0, [])
    beats = payload["measures"][0]["staves"]["rh"]["voices"][0]["beats"]

    assert beats[0] == {"t": 0.0, "dur": 8, "dot": 1, "notes": [{"midi": 60}]}
    assert beats[1] == {"t": 0.375, "dur": 16, "notes": [{"midi": 62}]}
    assert beats[2] == {"t": 0.5, "dur": 8, "tu": [3, 2], "rest": True}
    # Triplet eighth at 120 BPM = (0.25 s × 2/3) ≈ 0.1667 s → next beat 0.667.
    assert beats[3]["t"] == pytest.approx(0.667, abs=0.001)
    assert beats[3]["dur"] == 4


def test_double_dot_written_dots_agree_with_times():
    # 120 BPM: double-dotted quarter = 0.5 × 1.75 = 0.875 s. The written
    # ``dot: 2`` must agree with the emitted absolute times (_beat_secs
    # deliberately diverges from gp2rs_gpx._beat_dur_secs's single-dot
    # approximation here — see the _beat_secs docstring).
    root = _gpif(
        tracks_xml='<Track id="0"><Name>Piano</Name></Track>',
        masterbars_xml='<MasterBar><Time>4/4</Time><Bars>0</Bars></MasterBar>',
        bars_xml='<Bar id="0"><Voices>0</Voices></Bar>',
        voices_xml='<Voice id="0"><Beats>b0 b1</Beats></Voice>',
        beats_xml='<Beat id="b0"><Rhythm ref="rdd"/><Notes>n0</Notes></Beat>'
                  '<Beat id="b1"><Rhythm ref="r8"/><Notes>n1</Notes></Beat>',
        notes_xml=_note_tone("n0", 0, 4) + _note_tone("n1", 1, 4),
        rhythms_xml=(
            '<Rhythm id="rdd"><NoteValue>Quarter</NoteValue>'
            '<AugmentationDot count="2"/></Rhythm>'
            '<Rhythm id="r8"><NoteValue>Eighth</NoteValue></Rhythm>'
        ),
        extra='<MasterTrack><Automations><Automation><Type>Tempo</Type>'
              '<Bar>0</Bar><Value>120 2</Value></Automation></Automations></MasterTrack>',
    )
    payload = convert_track_to_notation(root, 0, [])
    beats = payload["measures"][0]["staves"]["rh"]["voices"][0]["beats"]
    assert beats[0] == {"t": 0.0, "dur": 4, "dot": 2, "notes": [{"midi": 60}]}
    assert beats[1]["t"] == pytest.approx(0.875)


def test_tied_note_kept_with_tied_flag():
    root = _gpif(
        tracks_xml='<Track id="0"><Name>Piano</Name></Track>',
        masterbars_xml='<MasterBar><Time>4/4</Time><Bars>0</Bars></MasterBar>',
        bars_xml='<Bar id="0"><Voices>0</Voices></Bar>',
        voices_xml='<Voice id="0"><Beats>b0 b1</Beats></Voice>',
        beats_xml='<Beat id="b0"><Rhythm ref="r2"/><Notes>n0</Notes></Beat>'
                  '<Beat id="b1"><Rhythm ref="r2"/><Notes>n1</Notes></Beat>',
        notes_xml=(
            _note_tone("n0", 0, 4)
            + ('<Note id="n1"><Tie destination="true"/>'
               '<Property name="Tone"><Step>0</Step></Property>'
               '<Property name="Octave"><Number>4</Number></Property></Note>')
        ),
        rhythms_xml='<Rhythm id="r2"><NoteValue>Half</NoteValue></Rhythm>',
    )
    payload = convert_track_to_notation(root, 0, [])
    beats = payload["measures"][0]["staves"]["rh"]["voices"][0]["beats"]
    # Unlike the RS-XML walk (tie destinations dropped, sustain extended),
    # notation keeps the continuation beat with a tied note.
    assert len(beats) == 2
    assert beats[0]["notes"] == [{"midi": 60}]
    assert beats[1]["notes"] == [{"midi": 60, "tied": True}]


def test_sub_32nd_beats_dropped_with_aligned_timing():
    """64th/128th beats are dropped (schema floor, v1 non-feature) — never
    clamped into self-contradictory written durations — and the dropped span
    still advances time so following beats stay aligned with the RS XML."""
    root = _gpif(
        tracks_xml='<Track id="0"><Name>Piano</Name></Track>',
        masterbars_xml='<MasterBar><Time>4/4</Time><Bars>0</Bars></MasterBar>',
        bars_xml='<Bar id="0"><Voices>0</Voices></Bar>',
        voices_xml='<Voice id="0"><Beats>b0 b1</Beats></Voice>',
        beats_xml='<Beat id="b0"><Rhythm ref="r64"/><Notes>n0</Notes></Beat>'
                  '<Beat id="b1"><Rhythm ref="r4"/><Notes>n1</Notes></Beat>',
        notes_xml=_note_tone("n0", 0, 4) + _note_tone("n1", 4, 4),
        rhythms_xml='<Rhythm id="r64"><NoteValue>64th</NoteValue></Rhythm>'
                    '<Rhythm id="r4"><NoteValue>Quarter</NoteValue></Rhythm>',
    )
    payload = convert_track_to_notation(root, 0, [])
    beats = payload["measures"][0]["staves"]["rh"]["voices"][0]["beats"]
    # The 64th is gone; the quarter that followed it starts one true 64th
    # (0.03125s at 120 BPM, rounded to 0.031) after the bar start.
    assert len(beats) == 1
    assert beats[0]["dur"] == 4
    assert beats[0]["t"] == 0.031


# ── Measure-level fields ─────────────────────────────────────────────────────

def test_ts_tempo_emitted_only_on_change_and_beat_groups():
    # Bar 1: 4/4 @120. Bar 2: 6/8 (ts change → beat_groups). Bar 3: 6/8 @90.
    root = _gpif(
        tracks_xml='<Track id="0"><Name>Piano</Name></Track>',
        masterbars_xml=(
            '<MasterBar><Time>4/4</Time><Bars>0</Bars></MasterBar>'
            '<MasterBar><Time>6/8</Time><Bars>1</Bars></MasterBar>'
            '<MasterBar><Time>6/8</Time><Bars>2</Bars></MasterBar>'
        ),
        bars_xml='<Bar id="0"><Voices>0</Voices></Bar>'
                 '<Bar id="1"><Voices>0</Voices></Bar>'
                 '<Bar id="2"><Voices>0</Voices></Bar>',
        voices_xml='<Voice id="0"><Beats>b0</Beats></Voice>',
        beats_xml='<Beat id="b0"><Rhythm ref="r4"/><Notes>n0</Notes></Beat>',
        notes_xml=_note_tone("n0", 0, 4),
        rhythms_xml='<Rhythm id="r4"><NoteValue>Quarter</NoteValue></Rhythm>',
        extra='<MasterTrack><Automations>'
              '<Automation><Type>Tempo</Type><Bar>0</Bar><Value>120 2</Value></Automation>'
              '<Automation><Type>Tempo</Type><Bar>2</Bar><Value>90 2</Value></Automation>'
              '</Automations></MasterTrack>',
    )
    payload = convert_track_to_notation(root, 0, [])
    m1, m2, m3 = payload["measures"]

    assert m1["idx"] == 1 and m1["t"] == 0.0
    assert m1["ts"] == [4, 4] and "beat_groups" not in m1
    assert m1["tempo"] == 120.0

    # 4/4 @120 = 2.0s; ts change re-emitted with compound grouping.
    assert m2["idx"] == 2 and m2["t"] == 2.0
    assert m2["ts"] == [6, 8] and m2["beat_groups"] == [3, 3]
    assert "tempo" not in m2

    # 6/8 @120 = 6 * (4/8) * 0.5 = 1.5s; tempo change at bar 3.
    assert m3["t"] == 3.5
    assert "ts" not in m3 and "beat_groups" not in m3
    assert m3["tempo"] == 90.0


def test_key_signature_emitted_on_change():
    root = _gpif(
        tracks_xml='<Track id="0"><Name>Piano</Name></Track>',
        masterbars_xml=(
            '<MasterBar><Key><AccidentalCount>2</AccidentalCount></Key>'
            '<Time>4/4</Time><Bars>0</Bars></MasterBar>'
            '<MasterBar><Key><AccidentalCount>2</AccidentalCount></Key>'
            '<Time>4/4</Time><Bars>0</Bars></MasterBar>'
            '<MasterBar><Key><AccidentalCount>-1</AccidentalCount></Key>'
            '<Time>4/4</Time><Bars>0</Bars></MasterBar>'
        ),
        bars_xml='<Bar id="0"><Voices>0</Voices></Bar>',
        voices_xml='<Voice id="0"><Beats>b0</Beats></Voice>',
        beats_xml='<Beat id="b0"><Rhythm ref="r4"/><Notes>n0</Notes></Beat>',
        notes_xml=_note_tone("n0", 0, 4),
        rhythms_xml='<Rhythm id="r4"><NoteValue>Quarter</NoteValue></Rhythm>',
    )
    payload = convert_track_to_notation(root, 0, [])
    m1, m2, m3 = payload["measures"]
    assert m1["ks"] == 2
    assert "ks" not in m2
    assert m3["ks"] == -1


def test_audio_offset_applied_to_measure_and_beat_times():
    payload = convert_track_to_notation(_two_voice_piano_root(), 0, [40],
                                        audio_offset=1.25)
    m = payload["measures"][0]
    assert m["t"] == 1.25
    assert m["staves"]["rh"]["voices"][0]["beats"][0]["t"] == 1.25


# ── LH/RH pair merge ─────────────────────────────────────────────────────────

def test_merged_lh_track_lands_on_lh_staff():
    # Track 0 = RH (single voice → rh); raw track 1 = LH partner (forced lh).
    root = _gpif(
        tracks_xml=(
            '<Track id="0"><Name>Piano RH</Name>'
            '<Property name="Tuning"><Pitches>72</Pitches></Property></Track>'
            '<Track id="1"><Name>Piano LH</Name>'
            '<Property name="Tuning"><Pitches>48</Pitches></Property></Track>'
        ),
        masterbars_xml='<MasterBar><Time>4/4</Time><Bars>0 1</Bars></MasterBar>',
        bars_xml='<Bar id="0"><Voices>0</Voices></Bar>'
                 '<Bar id="1"><Voices>1</Voices></Bar>',
        voices_xml='<Voice id="0"><Beats>b0</Beats></Voice>'
                   '<Voice id="1"><Beats>b1</Beats></Voice>',
        beats_xml='<Beat id="b0"><Rhythm ref="r4"/><Notes>n0</Notes></Beat>'
                  '<Beat id="b1"><Rhythm ref="r4"/><Notes>n1</Notes></Beat>',
        notes_xml=_note_sf("n0", 0, 0) + _note_sf("n1", 0, 0),  # midi 72 / 48
        rhythms_xml='<Rhythm id="r4"><NoteValue>Quarter</NoteValue></Rhythm>',
    )
    payload = convert_track_to_notation(
        root, 0, [72],
        track_name="Piano RH", lh_raw_idx=1, lh_string_pitches=[48],
    )
    m = payload["measures"][0]
    assert m["staves"]["rh"]["voices"][0]["beats"][0]["notes"] == [{"midi": 72}]
    assert m["staves"]["lh"]["voices"][0]["beats"][0]["notes"] == [{"midi": 48}]
    assert [s["id"] for s in payload["staves"]] == ["rh", "lh"]


# ── convert_file wiring (sidecar emission) ───────────────────────────────────

_GPIF_KEYS_AND_GUITAR = """
<GPIF>
  <Score><Title>T</Title><Artist>A</Artist></Score>
  <Tracks>
    <Track id="0"><Name>Piano</Name>
      <Property name="Tuning"><Pitches>48</Pitches></Property></Track>
    <Track id="1"><Name>Lead Guitar</Name>
      <Property name="Tuning"><Pitches>64 59 55 50 45 40</Pitches></Property></Track>
  </Tracks>
  <MasterBars>
    <MasterBar><Time>4/4</Time><Bars>0 1</Bars></MasterBar>
  </MasterBars>
  <Bars>
    <Bar id="0"><Voices>0</Voices></Bar>
    <Bar id="1"><Voices>1</Voices></Bar>
  </Bars>
  <Voices>
    <Voice id="0"><Beats>b0</Beats></Voice>
    <Voice id="1"><Beats>b1</Beats></Voice>
  </Voices>
  <Beats>
    <Beat id="b0"><Rhythm ref="r0"/><Notes>n0</Notes></Beat>
    <Beat id="b1"><Rhythm ref="r0"/><Notes>n1</Notes></Beat>
  </Beats>
  <Notes>
    <Note id="n0">
      <Property name="String"><String>0</String></Property>
      <Property name="Fret"><Fret>12</Fret></Property></Note>
    <Note id="n1">
      <Property name="String"><String>0</String></Property>
      <Property name="Fret"><Fret>5</Fret></Property></Note>
  </Notes>
  <Rhythms><Rhythm id="r0"><NoteValue>Quarter</NoteValue></Rhythm></Rhythms>
</GPIF>
"""


def test_convert_file_writes_notation_sidecar_for_keys_only(tmp_path, monkeypatch):
    monkeypatch.setattr(gp2rs_gpx, "_load_gpif",
                        lambda _p: ET.fromstring(_GPIF_KEYS_AND_GUITAR))
    out_files = gp2rs_gpx.convert_file(
        "dummy.gpx", str(tmp_path),
        track_indices=[0, 1],
        arrangement_names={0: "Keys", 1: "Lead"},
    )
    assert len(out_files) == 2

    keys_xml = next(p for p in out_files if "Keys" in p)
    guitar_xml = next(p for p in out_files if "Lead" in p)

    side = notation_sidecar_path(keys_xml)
    assert side.exists()
    assert not notation_sidecar_path(guitar_xml).exists()

    payload = json.loads(side.read_text())
    ok, reason = __import__("notation").validate_notation(payload)
    assert ok, reason
    assert payload["instrument"] == "piano"
    beats = payload["measures"][0]["staves"]["rh"]["voices"][0]["beats"]
    assert beats[0]["notes"] == [{"midi": 60}]  # 48 + fret 12


def test_convert_file_sidecar_failure_does_not_break_conversion(tmp_path, monkeypatch):
    monkeypatch.setattr(gp2rs_gpx, "_load_gpif",
                        lambda _p: ET.fromstring(_GPIF_KEYS_AND_GUITAR))

    def _boom(*_a, **_k):
        raise RuntimeError("notation importer bug")

    monkeypatch.setattr(gp2notation, "convert_track_to_notation", _boom)
    out_files = gp2rs_gpx.convert_file(
        "dummy.gpx", str(tmp_path),
        track_indices=[0], arrangement_names={0: "Keys"},
    )
    # XML conversion is unaffected; only the sidecar is missing.
    assert len(out_files) == 1
    assert not notation_sidecar_path(out_files[0]).exists()


# ── Sidecar / manifest helpers ───────────────────────────────────────────────

VALID_PAYLOAD = {"version": 1, "instrument": "piano", "staves": [], "measures": []}


def test_write_notation_sidecar_rejects_invalid():
    with pytest.raises(ValueError):
        write_notation_sidecar("x.xml", {"version": 1, "staves": []})  # no measures


def test_attach_notation_to_sloppak(tmp_path):
    pak = tmp_path / "song.sloppak"
    pak.mkdir()
    manifest = {
        "title": "Song", "artist": "A",
        "arrangements": [
            {"id": "lead", "name": "Lead", "file": "arrangements/lead.json"},
            {"id": "keys", "name": "Keys", "file": "arrangements/keys.json"},
        ],
        "stems": [{"id": "full", "file": "stems/full.ogg"}],
    }
    (pak / "manifest.yaml").write_text(yaml.safe_dump(manifest, sort_keys=False))

    out = attach_notation_to_sloppak(pak, "keys", VALID_PAYLOAD)
    assert out == pak / "notation_keys.json"
    assert json.loads(out.read_text()) == VALID_PAYLOAD

    rewritten = yaml.safe_load((pak / "manifest.yaml").read_text())
    entries = {e["id"]: e for e in rewritten["arrangements"]}
    assert entries["keys"]["notation"] == "notation_keys.json"
    assert "notation" not in entries["lead"]
    # Original key order preserved (sort_keys=False round-trip); the manifest
    # rewrite also stamps feedpak_version (spec §4), appended at the end.
    assert list(rewritten.keys()) == [
        "title", "artist", "arrangements", "stems", "feedpak_version"]
    from sloppak import FEEDPAK_VERSION
    assert rewritten["feedpak_version"] == FEEDPAK_VERSION


def test_attach_notation_unknown_arrangement_raises(tmp_path):
    pak = tmp_path / "song.sloppak"
    pak.mkdir()
    (pak / "manifest.yaml").write_text(yaml.safe_dump({"arrangements": []}))
    with pytest.raises(ValueError):
        attach_notation_to_sloppak(pak, "keys", VALID_PAYLOAD)


def test_attach_notation_unsafe_id_raises(tmp_path):
    pak = tmp_path / "song.sloppak"
    pak.mkdir()
    (pak / "manifest.yaml").write_text(yaml.safe_dump({"arrangements": []}))
    with pytest.raises(ValueError):
        attach_notation_to_sloppak(pak, "../evil", VALID_PAYLOAD)
