"""Tests for lib/gp2rs_gpx.py — the Guitar Pro 6 (.gpx) import path.

Fixture-free: every test exercises a pure helper with hand-built inputs
(ElementTree fragments, tuning lists, crafted container headers). The binary
BCFZ/BCFS round-trip needs a real .gpx and is covered by manual validation in
the PR; here we pin the input-validation guards and the conversion helpers
that are easy to drive without a fixture.
"""

import json
import struct
import xml.etree.ElementTree as ET

import pytest

import gp2rs_gpx
from gp2rs_gpx import convert_file

from gp2rs_gpx import (
    _decompress_bcfz,
    _parse_bcfs,
    _safe_filename_stem,
    _note_is_tie,
    _note_has_vibrato,
    _beat_has_tremolo,
    _note_midi,
    _gpx_percussion_midis,
    _gpx_tuning,
    _gp6_element_variation_to_midi,
    _GPX_MAX_DECOMPRESSED,
    _find_piano_pairs,
    convert_vocal_track_to_pitch_sidecar,
    _vocals_xml_to_lyrics,
    attach_vocal_sidecars_to_sloppak,
    lyrics_sidecar_path,
    vocal_pitch_sidecar_path,
    _collect_tone_events,
    _inject_tones,
    _resolve_pending_slides,
    _gpx_bend_shape,
    _gpif_left_fingering,
)
from gp2rs import RsNote


# ── _safe_filename_stem ─────────────────────────────────────────────────────

@pytest.mark.parametrize("name, expected", [
    ("Lead Guitar", "Lead_Guitar"),
    ("AC/DC", "AC_DC"),
    (r"..\..\evil", "evil"),
    ("../../etc/passwd", "etc_passwd"),
    ("C:\\Windows\\x", "C_Windows_x"),
    ("", "track"),
    ("...", "track"),
    ("Bass (5)", "Bass_5"),
])
def test_safe_filename_stem(name, expected):
    out = _safe_filename_stem(name)
    assert out == expected
    # Never contains a path separator or traversal segment.
    assert "/" not in out and "\\" not in out
    assert ".." not in out


# ── _gpx_bend_shape (bn / bt / bnv, §6.2.1) ─────────────────────────────────

def _bend_props(**vals):
    """Build a GPIF property map {name: <Property> element} for the given
    bend Float values, e.g. _bend_props(BendOriginValue=0, BendMiddleValue=100)."""
    tp = {}
    for name, num in vals.items():
        tp[name] = ET.fromstring(
            f'<Property name="{name}"><Float>{num}</Float></Property>')
    return tp


def test_gpx_bend_shape_round_trip_curve():
    """origin/middle/destination value+offset → 3-point bnv; value/divisor=semis."""
    tp = _bend_props(
        BendOriginValue=0, BendOriginOffset=0,
        BendMiddleValue=100, BendMiddleOffset1=50,   # 100/50 = 2 semitones
        BendDestinationValue=0, BendDestinationOffset=100,
    )
    peak, intent, curve = _gpx_bend_shape(tp, divisor=50.0, sustain=1.0)
    assert peak == 2.0
    assert intent == 4   # round-trip (up then back down)
    assert curve == [
        {"t": 0.0, "v": 0.0}, {"t": 0.5, "v": 2.0}, {"t": 1.0, "v": 0.0}]


def test_gpx_bend_shape_falls_back_to_even_spacing_without_offsets():
    tp = _bend_props(BendOriginValue=0, BendDestinationValue=100)  # no offsets
    peak, intent, curve = _gpx_bend_shape(tp, divisor=50.0, sustain=1.0)
    assert peak == 2.0
    assert intent == 0   # plain up
    # origin defaults to 0%, destination to 100%.
    assert curve == [{"t": 0.0, "v": 0.0}, {"t": 1.0, "v": 2.0}]


def test_gpx_bend_shape_no_props_and_zero_length():
    assert _gpx_bend_shape({}, divisor=50.0, sustain=1.0) == (0.0, 0, None)
    # Peak + intent still derived for a zero-length note, but no curve.
    peak, intent, curve = _gpx_bend_shape(
        _bend_props(BendOriginValue=0, BendDestinationValue=100),
        divisor=50.0, sustain=0.0)
    assert peak == 2.0 and intent == 0 and curve is None


# ── _decompress_bcfz / _parse_bcfs input guards ─────────────────────────────

def test_decompress_bcfz_rejects_bad_magic():
    with pytest.raises(ValueError):
        _decompress_bcfz(b"XXXX" + b"\x00" * 8)


def test_decompress_bcfz_rejects_oversized_declared_size():
    # 4 bytes after the magic are read verbatim as a little-endian uint32 = the
    # declared decompressed size. Declare > cap -> ValueError before allocating.
    blob = b"BCFZ" + struct.pack("<I", _GPX_MAX_DECOMPRESSED + 1)
    with pytest.raises(ValueError):
        _decompress_bcfz(blob)


def test_parse_bcfs_rejects_bad_magic():
    with pytest.raises(ValueError):
        _parse_bcfs(b"NOPE" + b"\x00" * 16)


# ── _parse_bcfs container round-trip (GP6 .gpx partial final-sector) ─────────

def _build_bcfs(entries, short_by=0):
    """Assemble a minimal in-memory BCFS container for _parse_bcfs.

    ``entries`` is ``[(name: bytes, payload: bytes, data_sector: int), ...]``.
    The directory entry for entry *i* is written to sector ``i + 1``; each
    entry's payload goes in the sector index it names. ``short_by`` truncates
    the final buffer by N bytes to emulate a real .gpx's partial trailing
    sector (the BCFZ-declared decompressed size isn't 0x1000-aligned). Layout
    mirrors the reader: a 4-byte ``BCFS`` header, then 0x1000-byte sectors,
    with every value read at ``HDR + sector * 0x1000``.
    """
    SECTOR = 0x1000
    HDR = 4
    max_sector = max([e[2] for e in entries] + [len(entries)])
    buf = bytearray(b"BCFS" + b"\x00" * ((max_sector + 1) * SECTOR))

    def put_u32(off, val):
        struct.pack_into("<I", buf, HDR + off, val)

    for i, (name, payload, data_sector) in enumerate(entries):
        dir_off = (i + 1) * SECTOR                 # directory entry -> sector i+1
        put_u32(dir_off + 0x00, 2)                 # entry type: file
        nm = name[:127]
        buf[HDR + dir_off + 0x04: HDR + dir_off + 0x04 + len(nm)] = nm
        put_u32(dir_off + 0x8C, len(payload))      # declared file size
        put_u32(dir_off + 0x94, data_sector)       # first data-sector pointer
        put_u32(dir_off + 0x94 + 4, 0)             # chain terminator
        dpos = HDR + data_sector * SECTOR
        buf[dpos: dpos + len(payload)] = payload
    if short_by:
        del buf[len(buf) - short_by:]
    return bytes(buf)


def test_parse_bcfs_reads_short_final_sector():
    """The regression: a real .gpx ends a byte short of a full 0x1000 sector,
    so its last (small) container file lands in a partial trailing sector. The
    reader must clamp that read, not reject the whole container — rejecting it
    is what made every GP6 .gpx fail to import with 'sector pointer out of
    range'."""
    bcfs = _build_bcfs([(b"score.gpif", b"hello", 2)], short_by=1)
    assert (len(bcfs) - 4) % 0x1000 == 0x1000 - 1   # final sector is 1 short
    assert _parse_bcfs(bcfs)["score.gpif"] == b"hello"


def test_parse_bcfs_full_sector_round_trip():
    """A sector-aligned container round-trips unchanged (baseline)."""
    assert _parse_bcfs(_build_bcfs([(b"misc.xml", b"<x/>", 2)]))["misc.xml"] == b"<x/>"


def test_parse_bcfs_multi_file_short_final_sector():
    """Real-world shape: score.gpif plus small config files, the last one in
    the partial trailing sector."""
    out = _parse_bcfs(_build_bcfs([
        (b"score.gpif", b"<GPIF/>", 3),
        (b"LayoutConfiguration", b"AB", 4),
    ], short_by=1))
    assert out["score.gpif"] == b"<GPIF/>"
    assert out["LayoutConfiguration"] == b"AB"


def test_parse_bcfs_rejects_sector_starting_past_end():
    """A sector pointer whose *start* is beyond the container is genuinely
    malformed and must still raise — the clamp tolerates a partial final
    sector, not arbitrary out-of-range pointers."""
    bcfs = bytearray(_build_bcfs([(b"x", b"y", 2)]))
    struct.pack_into("<I", bcfs, 4 + 0x1000 + 0x94, 9999)  # absurd data-sector ptr
    with pytest.raises(ValueError, match="out of range"):
        _parse_bcfs(bytes(bcfs))


# ── _note_is_tie ────────────────────────────────────────────────────────────

def test_note_is_tie_destination():
    el = ET.fromstring('<Note><Tie destination="true"/></Note>')
    assert _note_is_tie(el) is True


def test_note_is_tie_origin_only_is_not_tie():
    el = ET.fromstring('<Note><Tie origin="true"/></Note>')
    assert _note_is_tie(el) is False


def test_note_is_tie_absent():
    assert _note_is_tie(ET.fromstring("<Note/>")) is False


# ── _gp6_element_variation_to_midi ──────────────────────────────────────────

def test_element_variation_out_of_range_is_none():
    assert _gp6_element_variation_to_midi(9999, 0) is None
    assert _gp6_element_variation_to_midi(-1, 0) is None


def test_element_variation_known_pieces():
    # Element 0 = kick (GM 35), element 1 = snare (GM 38). Pin exact values so a
    # mis-edit of the _GP6_EV / _ART_TO_MIDI tables is caught.
    assert _gp6_element_variation_to_midi(0, 0) == 35
    assert _gp6_element_variation_to_midi(1, 0) == 38


# ── _gpx_tuning ─────────────────────────────────────────────────────────────
# GPX string pitches are high->low (index 0 = highest string).

_INSTRUMENT_SET = """
<Track>
  <InstrumentSet><Type>drumKit</Type><Elements>
    <Element><Name>Snare</Name><Articulations>
      <Articulation><OutputMidiNumber>38</OutputMidiNumber></Articulation>
      <Articulation><OutputMidiNumber>37</OutputMidiNumber></Articulation>
    </Articulations></Element>
    <Element><Name>Kick</Name><Articulations>
      <Articulation><OutputMidiNumber>36</OutputMidiNumber></Articulation>
    </Articulations></Element>
  </Elements></InstrumentSet>
</Track>
"""


def test_percussion_midis_flattens_articulations_in_order():
    track_el = ET.fromstring(_INSTRUMENT_SET)
    # Flattened across Elements in document order: snare hit, snare side, kick.
    assert _gpx_percussion_midis(track_el) == [38, 37, 36]


def test_percussion_midis_empty_without_instrument_set():
    assert _gpx_percussion_midis(ET.fromstring("<Track/>")) == []


def test_note_midi_decodes_percussion_articulation_index():
    perc = [38, 37, 36]
    # GP8 drum note: the piece is a direct <InstrumentArticulation> child
    # indexing into the InstrumentSet articulation list (NOT a Property).
    note = ET.fromstring(
        '<Note><Properties>'
        '<Property name="ConcertPitch"><Pitch><Step>C</Step><Octave>-1</Octave></Pitch></Property>'
        '</Properties><InstrumentArticulation>2</InstrumentArticulation></Note>'
    )
    assert _note_midi(note, [], perc) == 36          # index 2 → kick
    # Out-of-range index → None (skipped), not a crash.
    bad = ET.fromstring('<Note><InstrumentArticulation>99</InstrumentArticulation></Note>')
    assert _note_midi(bad, [], perc) is None
    # A -1 sentinel (unparseable OutputMidiNumber) → None, not an invalid note.
    note2 = ET.fromstring('<Note><InstrumentArticulation>1</InstrumentArticulation></Note>')
    assert _note_midi(note2, [], [38, -1, 36]) is None


def test_tuning_6string_guitar_standard_is_zero():
    # E B G D A E (MIDI 64 59 55 50 45 40)
    assert _gpx_tuning({"string_pitches": [64, 59, 55, 50, 45, 40]}) == [0, 0, 0, 0, 0, 0]


def test_tuning_6string_guitar_eb_is_minus_one():
    assert _gpx_tuning({"string_pitches": [63, 58, 54, 49, 44, 39]}) == [-1, -1, -1, -1, -1, -1]


def test_tuning_4string_bass_standard_is_zero():
    # G D A E (high->low): 43 38 33 28
    assert _gpx_tuning({"string_pitches": [43, 38, 33, 28]}) == [0, 0, 0, 0]


def test_tuning_5string_low_b_standard_is_zero():
    # low-B 5-string, high->low: G D A E B = 43 38 33 28 23
    assert _gpx_tuning({"string_pitches": [43, 38, 33, 28, 23]}) == [0, 0, 0, 0, 0]


def test_tuning_5string_high_c_standard_is_zero():
    # high-C 5-string, high->low: C G D A E = 48 43 38 33 28.
    # Regression guard: previously forced the low-B reference and produced
    # non-zero offsets for a standard-tuned high-C bass.
    assert _gpx_tuning({"string_pitches": [48, 43, 38, 33, 28]}) == [0, 0, 0, 0, 0]


def test_tuning_empty_pitches_defaults_six_zero():
    assert _gpx_tuning({"string_pitches": []}) == [0, 0, 0, 0, 0, 0]


def test_tuning_6string_guitar_ascending_is_zero():
    # GP8/.gp lists tuning pitches low->high (the opposite of GP6 .gpx). The
    # offsets must still be all-zero for E-standard — `_gpx_tuning` is order-
    # agnostic so a GP8 import isn't mirrored.
    assert _gpx_tuning({"string_pitches": [40, 45, 50, 55, 59, 64]}) == [0, 0, 0, 0, 0, 0]


def test_tuning_4string_bass_ascending_is_zero():
    assert _gpx_tuning({"string_pitches": [28, 33, 38, 43]}) == [0, 0, 0, 0]


# ── _find_piano_pairs ───────────────────────────────────────────────────────

def test_find_piano_pairs_returns_rh_to_lh_map():
    # "Piano RH"/"Piano LH" share a stem -> map {rh: lh} (LH merges into RH at
    # import time), LH consumed.
    tracks = [{"name": "Piano RH"}, {"name": "Piano LH"}, {"name": "Lead Guitar"}]
    names = {0: "Keys", 1: "Keys 2", 2: "Lead"}
    filtered, merge_map = _find_piano_pairs([0, 1, 2], tracks, names)
    assert merge_map == {0: 1}
    assert filtered == [0, 2]  # LH (1) removed, order otherwise preserved


def test_find_piano_pairs_no_lh_no_merge():
    # An RH with no matching LH stem is left untouched.
    tracks = [{"name": "Piano RH"}, {"name": "Synth Pad"}]
    names = {0: "Keys", 1: "Keys 2"}
    filtered, merge_map = _find_piano_pairs([0, 1], tracks, names)
    assert merge_map == {}
    assert filtered == [0, 1]


def test_find_piano_pairs_ignores_non_keys_tracks():
    # "rh"/"lh" word boundaries on guitar tracks must not trigger a merge:
    # only piano/keys/keyboard-named (or names[]=Keys*) tracks are considered.
    tracks = [{"name": "Rhythm Guitar RH"}, {"name": "Lead Guitar LH"}]
    names = {0: "Rhythm", 1: "Lead"}
    filtered, merge_map = _find_piano_pairs([0, 1], tracks, names)
    assert merge_map == {}
    assert filtered == [0, 1]


# ── convert_vocal_track_to_pitch_sidecar ────────────────────────────────────
# Drives the per-syllable pitch extraction with a one-bar / one-beat GPX tree
# (String+Fret note encoding) — no real .gpx needed.

def _vocal_sidecar_args(*, with_lyric: bool):
    """Build the minimal ET fragments for a single quarter-note vocal beat at
    middle C (string_pitches[0]=60, String 0 + Fret 0). Returns a dict of
    keyword args (expanded with **) for convert_vocal_track_to_pitch_sidecar."""
    lyric = "<Lyrics><Line>la</Line></Lyrics>" if with_lyric else ""
    beat = ET.fromstring(
        f'<Beat><Rhythm ref="r0"/>{lyric}<Notes>0</Notes></Beat>'
    )
    note = ET.fromstring(
        '<Note>'
        '<Property name="String"><String>0</String></Property>'
        '<Property name="Fret"><Fret>0</Fret></Property>'
        '</Note>'
    )
    masterbar = ET.fromstring('<MasterBar><Time>4/4</Time><Bars>0</Bars></MasterBar>')
    return dict(
        root=ET.fromstring('<GPIF/>'),                  # no MasterTrack -> 120 BPM
        track={'string_pitches': [60]},
        raw_idx=0,
        masterbars=[masterbar],
        bars_by_id={'0': ET.fromstring('<Bar><Voices>0</Voices></Bar>')},
        voices_dict={'0': ET.fromstring('<Voice><Beats>0</Beats></Voice>')},
        beats_dict={'0': beat},
        notes_dict={'0': note},
        rhythms_dict={'r0': ET.fromstring('<Rhythm><NoteValue>Quarter</NoteValue></Rhythm>')},
    )


def test_vocal_pitch_sidecar_emits_lyric_note():
    out = convert_vocal_track_to_pitch_sidecar(**_vocal_sidecar_args(with_lyric=True))
    # Quarter note (1.0 qn) at 120 BPM = 1.0 * 60/120 = 0.5 s; pitch = 60.
    assert out == {"version": 1, "notes": [{"t": 0.0, "d": 0.5, "midi": 60}]}


def test_vocal_pitch_sidecar_skips_beat_without_lyric():
    out = convert_vocal_track_to_pitch_sidecar(**_vocal_sidecar_args(with_lyric=False))
    assert out == {"version": 1, "notes": []}


def test_vocal_pitch_sidecar_require_lyric_false_emits_melody():
    # Lyric-less vocal track: with the gate relaxed the authored pitch still
    # ships (there are no lyric tokens to stay aligned with).
    out = convert_vocal_track_to_pitch_sidecar(
        **_vocal_sidecar_args(with_lyric=False), require_lyric=False)
    assert out == {"version": 1, "notes": [{"t": 0.0, "d": 0.5, "midi": 60}]}


# ── _vocals_xml_to_lyrics ───────────────────────────────────────────────────

def test_vocals_xml_to_lyrics_shape_and_suffixes():
    xml = (
        '<vocals count="4">'
        '<vocal time="0.000" note="60" length="0.500" lyric="Hel-"/>'
        '<vocal time="0.500" note="62" length="0.500" lyric="lo"/>'
        '<vocal time="1.000" note="64" length="0.250" lyric="sing+"/>'
        '<vocal time="1.250" note="64" length="0.250" lyric="ing"/>'
        '</vocals>'
    )
    out = _vocals_xml_to_lyrics(xml)
    assert out == [
        # "-" means the same join in both conventions — passed through.
        {"t": 0.0, "d": 0.5, "w": "Hel-"},
        {"t": 0.5, "d": 0.5, "w": "lo"},
        # XML "+" is a JOIN; feedpak "+" is a LINE END — joins become "-".
        {"t": 1.0, "d": 0.25, "w": "sing-"},
        {"t": 1.25, "d": 0.25, "w": "ing"},
    ]


def test_vocals_xml_to_lyrics_skips_bare_joiners_and_bad_xml():
    xml = (
        '<vocals count="2">'
        '<vocal time="0.000" note="0" length="0.500" lyric="+"/>'
        '<vocal time="0.500" note="60" length="0.500" lyric="la"/>'
        '</vocals>'
    )
    assert _vocals_xml_to_lyrics(xml) == [{"t": 0.5, "d": 0.5, "w": "la"}]
    assert _vocals_xml_to_lyrics("not xml <<<") == []


# ── convert_file end-to-end: vocal karaoke sidecars ─────────────────────────
# A vocal track must emit `<stem>.lyrics.json` + `<stem>.vocal_pitch.json`
# next to the vocals XML; non-vocal tracks must not; a lyric-less vocal track
# emits the pitch sidecar only.

_GPIF_VOCAL = """
<GPIF>
  <Score><Title>T</Title><Artist>A</Artist></Score>
  <Tracks>
    <Track id="0"><Name>Vocals</Name>
      <Property name="Tuning"><Pitches>60</Pitches></Property></Track>
  </Tracks>
  <MasterBars><MasterBar><Time>4/4</Time><Bars>0</Bars></MasterBar></MasterBars>
  <Bars><Bar id="0"><Voices>0</Voices></Bar></Bars>
  <Voices><Voice id="0"><Beats>0 1</Beats></Voice></Voices>
  <Beats>
    <Beat id="0"><Rhythm ref="r0"/><Lyrics><Line>Hel-</Line></Lyrics><Notes>0</Notes></Beat>
    <Beat id="1"><Rhythm ref="r0"/><Lyrics><Line>lo</Line></Lyrics><Notes>1</Notes></Beat>
  </Beats>
  <Notes>
    <Note id="0">
      <Property name="String"><String>0</String></Property>
      <Property name="Fret"><Fret>0</Fret></Property></Note>
    <Note id="1">
      <Property name="String"><String>0</String></Property>
      <Property name="Fret"><Fret>2</Fret></Property></Note>
  </Notes>
  <Rhythms><Rhythm id="r0"><NoteValue>Quarter</NoteValue></Rhythm></Rhythms>
</GPIF>
"""

# Same melody, no <Lyrics> anywhere.
_GPIF_VOCAL_NO_LYRICS = _GPIF_VOCAL.replace(
    "<Lyrics><Line>Hel-</Line></Lyrics>", "").replace(
    "<Lyrics><Line>lo</Line></Lyrics>", "")


def test_convert_file_vocal_track_emits_both_sidecars(tmp_path, monkeypatch):
    monkeypatch.setattr(gp2rs_gpx, "_load_gpif",
                        lambda _p: ET.fromstring(_GPIF_VOCAL))
    out_files = convert_file("dummy.gpx", str(tmp_path), track_indices=[0])
    assert len(out_files) == 1
    assert ET.parse(out_files[0]).getroot().tag == "vocals"

    # lyrics.json sidecar: flat [{t, d, w}] (spec §7.1), timings from the XML.
    lyr = json.loads(lyrics_sidecar_path(out_files[0]).read_text(encoding="utf-8"))
    assert lyr == [
        {"t": 0.0, "d": 0.5, "w": "Hel-"},
        {"t": 0.5, "d": 0.5, "w": "lo"},
    ]

    # vocal_pitch.json sidecar: {version, notes:[{t, d, midi}]} (spec §7.2),
    # lyric-aligned (one note per syllable) at the authored pitches.
    pitch = json.loads(vocal_pitch_sidecar_path(out_files[0]).read_text(encoding="utf-8"))
    assert pitch == {"version": 1, "notes": [
        {"t": 0.0, "d": 0.5, "midi": 60},
        {"t": 0.5, "d": 0.5, "midi": 62},
    ]}


def test_convert_file_no_vocal_track_no_sidecars(tmp_path, monkeypatch):
    monkeypatch.setattr(gp2rs_gpx, "_load_gpif",
                        lambda _p: ET.fromstring(_GPIF_GUITAR_ASCENDING))
    convert_file("dummy.gp", str(tmp_path),
                 track_indices=[0], arrangement_names={0: "Lead"})
    assert not list(tmp_path.glob("*.lyrics.json"))
    assert not list(tmp_path.glob("*.vocal_pitch.json"))


def test_convert_file_lyricless_vocal_track_pitch_sidecar_only(tmp_path, monkeypatch):
    monkeypatch.setattr(gp2rs_gpx, "_load_gpif",
                        lambda _p: ET.fromstring(_GPIF_VOCAL_NO_LYRICS))
    out_files = convert_file("dummy.gpx", str(tmp_path), track_indices=[0])
    assert len(out_files) == 1
    # No lyric text anywhere -> no lyrics.json; the authored melody still
    # ships as vocal_pitch.json (lyric gate relaxed for lyric-less tracks).
    assert not lyrics_sidecar_path(out_files[0]).exists()
    pitch = json.loads(vocal_pitch_sidecar_path(out_files[0]).read_text(encoding="utf-8"))
    assert pitch == {"version": 1, "notes": [
        {"t": 0.0, "d": 0.5, "midi": 60},
        {"t": 0.5, "d": 0.5, "midi": 62},
    ]}


# ── attach_vocal_sidecars_to_sloppak ────────────────────────────────────────

_LYRICS_PAYLOAD = [{"t": 0.0, "d": 0.5, "w": "Hel-"}, {"t": 0.5, "d": 0.5, "w": "lo"}]
_PITCH_PAYLOAD = {"version": 1, "notes": [{"t": 0.0, "d": 0.5, "midi": 60}]}


def _make_pak(tmp_path, manifest: dict):
    import yaml
    pak = tmp_path / "pak"
    pak.mkdir()
    (pak / "manifest.yaml").write_text(
        yaml.safe_dump(manifest, sort_keys=False), encoding="utf-8")
    return pak


def test_attach_vocal_sidecars_writes_files_and_manifest(tmp_path):
    import yaml
    pak = _make_pak(tmp_path, {"title": "T", "arrangements": []})
    written = attach_vocal_sidecars_to_sloppak(
        pak, lyrics=_LYRICS_PAYLOAD, vocal_pitch=_PITCH_PAYLOAD)
    assert written == [pak / "lyrics.json", pak / "vocal_pitch.json"]
    assert json.loads((pak / "lyrics.json").read_text(encoding="utf-8")) == _LYRICS_PAYLOAD
    assert json.loads((pak / "vocal_pitch.json").read_text(encoding="utf-8")) == _PITCH_PAYLOAD
    manifest = yaml.safe_load((pak / "manifest.yaml").read_text(encoding="utf-8"))
    assert manifest["lyrics"] == "lyrics.json"
    assert manifest["lyrics_source"] == "authored"      # GP tab = authored chart
    assert manifest["vocal_pitch"] == "vocal_pitch.json"
    # No automated-engine provenance for authored payloads (spec §7.1.1/§7.2.1).
    assert "lyric_transcription" not in manifest
    assert "pitch_extraction" not in manifest
    assert "feedpak_version" in manifest


def test_attach_vocal_sidecars_never_clobbers(tmp_path):
    import yaml
    pak = _make_pak(tmp_path, {
        "title": "T",
        "lyrics": "existing_lyrics.json",
        "lyrics_source": "user",
    })
    written = attach_vocal_sidecars_to_sloppak(
        pak, lyrics=_LYRICS_PAYLOAD, vocal_pitch=_PITCH_PAYLOAD)
    # lyrics already claimed by the manifest -> skipped entirely; pitch is new.
    assert written == [pak / "vocal_pitch.json"]
    assert not (pak / "lyrics.json").exists()
    manifest = yaml.safe_load((pak / "manifest.yaml").read_text(encoding="utf-8"))
    assert manifest["lyrics"] == "existing_lyrics.json"
    assert manifest["lyrics_source"] == "user"


def test_attach_vocal_sidecars_rejects_bad_payloads(tmp_path):
    pak = _make_pak(tmp_path, {"title": "T"})
    with pytest.raises(ValueError):
        attach_vocal_sidecars_to_sloppak(pak, lyrics=[{"t": 0.0}])   # missing d/w
    with pytest.raises(ValueError):
        attach_vocal_sidecars_to_sloppak(pak, vocal_pitch={"version": 1})  # no notes
    with pytest.raises(ValueError):
        attach_vocal_sidecars_to_sloppak(
            pak, lyrics=_LYRICS_PAYLOAD, lyrics_source="whisperx")  # not spec enum


# ── _collect_tone_events ────────────────────────────────────────────────────

def _tone_args(banks, tempo_map=((0, 120.0),)):
    """One 4/4 bar with one quarter-note beat per entry in `banks`; a None entry
    means a beat with no <Bank>. Returns positional args for _collect_tone_events.
    With the default 120 BPM map a quarter note is 0.5 s."""
    beat_ids = " ".join(str(i) for i in range(len(banks)))
    beats_dict = {}
    for i, b in enumerate(banks):
        bank_el = f"<Bank>{b}</Bank>" if b is not None else ""
        beats_dict[str(i)] = ET.fromstring(f'<Beat><Rhythm ref="r0"/>{bank_el}</Beat>')
    return (
        0,                                                                   # raw_idx
        [ET.fromstring('<MasterBar><Time>4/4</Time><Bars>0</Bars></MasterBar>')],
        {"0": ET.fromstring("<Bar><Voices>0</Voices></Bar>")},
        {"0": ET.fromstring(f"<Voice><Beats>{beat_ids}</Beats></Voice>")},
        beats_dict,
        {"r0": ET.fromstring("<Rhythm><NoteValue>Quarter</NoteValue></Rhythm>")},
        [tuple(t) for t in tempo_map],                                       # tempo_map
        0.0,                                                                 # audio_offset
    )


def test_collect_tone_events_emits_per_bank():
    events = _collect_tone_events(*_tone_args(["Clean", "Dist"]))
    assert events == [(0.0, "Clean"), (0.5, "Dist")]


def test_collect_tone_events_dedupes_consecutive_identical():
    # Consecutive identical banks collapse to a single transition.
    events = _collect_tone_events(*_tone_args(["Clean", "Clean", "Dist"]))
    assert events == [(0.0, "Clean"), (1.0, "Dist")]


def test_collect_tone_events_empty_when_no_banks():
    assert _collect_tone_events(*_tone_args([None, None])) == []


def test_collect_tone_events_honors_base_tempo_bpm():
    # No bar-0 tempo event -> the base tempo_bpm seeds the timeline (matching
    # convert_file). At 60 BPM a quarter note is 1.0 s, so the second bank
    # change lands at 1.0 s (not 0.5 s as it would at the hardcoded 120).
    events = _collect_tone_events(*_tone_args(["Clean", "Dist"], tempo_map=[]),
                                  tempo_bpm=60.0)
    assert events == [(0.0, "Clean"), (1.0, "Dist")]


# ── _inject_tones ───────────────────────────────────────────────────────────

def test_inject_tones_adds_tonebase_and_tones():
    out = _inject_tones("<song><arrangement>Lead</arrangement></song>",
                        [(0.0, "Clean"), (4.5, "Dist")])
    root = ET.fromstring(out)
    assert root.findtext("tonebase") == "Clean"          # base = first tone
    tones = root.find("tones")
    assert tones.get("count") == "2"
    tone_els = tones.findall("tone")
    assert [t.get("name") for t in tone_els] == ["Clean", "Dist"]
    assert [t.get("id") for t in tone_els] == ["0", "1"]
    assert [t.get("time") for t in tone_els] == ["0.000", "4.500"]


def test_inject_tones_does_not_bloat_whitespace():
    # Re-pretty-printing an already-indented arrangement must not stack blank
    # lines (regression guard for the double-pretty-print whitespace explosion).
    pretty = "<song>\n  <arrangement>Lead</arrangement>\n  <notes count=\"0\"/>\n</song>\n"
    out = _inject_tones(pretty, [(0.0, "Clean"), (4.5, "Dist")])
    assert not any(line.strip() == "" for line in out.splitlines())


def test_inject_tones_noop_without_events():
    xml = "<song><arrangement>Lead</arrangement></song>"
    assert _inject_tones(xml, []) == xml


def test_inject_tones_preserves_existing_tonebase():
    out = _inject_tones("<song><tonebase>Existing</tonebase></song>",
                        [(0.0, "Clean")])
    root = ET.fromstring(out)
    bases = root.findall("tonebase")
    assert len(bases) == 1 and bases[0].text == "Existing"


def test_inject_tones_fills_empty_tonebase():
    # An empty/whitespace <tonebase> gets populated with the first tone name.
    out = _inject_tones("<song><tonebase>  </tonebase></song>", [(0.0, "Clean")])
    root = ET.fromstring(out)
    bases = root.findall("tonebase")
    assert len(bases) == 1 and bases[0].text == "Clean"


# ── convert_file end-to-end: Piano LH/RH merge ──────────────────────────────
# Drives the real converter with a hand-built GPIF tree (via monkeypatched
# _load_gpif) to cover the in-converter merge + rename that the helper tests
# can't reach. Two keys tracks (Piano RH / Piano LH), one quarter-note each.

_GPIF_PIANO = """
<GPIF>
  <Score><Title>T</Title><Artist>A</Artist></Score>
  <Tracks>
    <Track id="0"><Name>Piano RH</Name>
      <Property name="Tuning"><Pitches>72</Pitches></Property></Track>
    <Track id="1"><Name>Piano LH</Name>
      <Property name="Tuning"><Pitches>48</Pitches></Property></Track>
  </Tracks>
  <MasterBars>
    <MasterBar><Time>4/4</Time><Bars>0 1</Bars></MasterBar>
  </MasterBars>
  <Bars>
    <Bar id="0"><Voices>0</Voices></Bar>
    <Bar id="1"><Voices>1</Voices></Bar>
  </Bars>
  <Voices>
    <Voice id="0"><Beats>0</Beats></Voice>
    <Voice id="1"><Beats>1</Beats></Voice>
  </Voices>
  <Beats>
    <Beat id="0"><Rhythm ref="r0"/><Notes>0</Notes></Beat>
    <Beat id="1"><Rhythm ref="r0"/><Notes>1</Notes></Beat>
  </Beats>
  <Notes>
    <Note id="0">
      <Property name="String"><String>0</String></Property>
      <Property name="Fret"><Fret>0</Fret></Property></Note>
    <Note id="1">
      <Property name="String"><String>0</String></Property>
      <Property name="Fret"><Fret>0</Fret></Property></Note>
  </Notes>
  <Rhythms><Rhythm id="r0"><NoteValue>Quarter</NoteValue></Rhythm></Rhythms>
</GPIF>
"""


def test_convert_file_merges_piano_lh_into_rh(tmp_path, monkeypatch):
    monkeypatch.setattr(gp2rs_gpx, "_load_gpif", lambda _p: ET.fromstring(_GPIF_PIANO))
    out_files = convert_file(
        "dummy.gpx", str(tmp_path),
        track_indices=[0, 1],
        arrangement_names={0: "Keys", 1: "Keys 2"},
    )
    # (1) LH is consumed by the merge -> a single combined arrangement file.
    assert len(out_files) == 1

    root = ET.parse(out_files[0]).getroot()
    # (2) "Keys 2" collapses to the standard "Keys" name (not "Piano"), so the
    # piano-highway auto-select (arr_name.startswith("keys")) still matches.
    assert root.findtext("arrangement") == "Keys"

    # (3) both hands' notes are present. Keys encoding packs MIDI as
    # string=midi//24, fret=midi%24: RH pitch 72 -> string 3, LH pitch 48 ->
    # string 2. Collect every emitted note (single <note> + chord <chordNote>).
    strings = {
        n.get("string")
        for n in root.iter()
        if n.tag in ("note", "chordNote")
    }
    assert "3" in strings   # RH (midi 72)
    assert "2" in strings   # LH (midi 48) merged in


# ── convert_file end-to-end: GP8 ascending-tuning string order ──────────────
# GP8/.gp lists tuning low->high, so GPIF String index 0 = low E. A low-E note
# must land on RS string 0 (RS string 0 = lowest), not be mirrored to high-e.

_GPIF_GUITAR_ASCENDING = """
<GPIF>
  <Score><Title>T</Title><Artist>A</Artist></Score>
  <Tracks>
    <Track id="0"><Name>Lead Guitar</Name>
      <Property name="Tuning"><Pitches>40 45 50 55 59 64</Pitches></Property></Track>
  </Tracks>
  <MasterBars>
    <MasterBar><Time>4/4</Time><Bars>0</Bars></MasterBar>
  </MasterBars>
  <Bars>
    <Bar id="0"><Voices>0</Voices></Bar>
  </Bars>
  <Voices>
    <Voice id="0"><Beats>0 1</Beats></Voice>
  </Voices>
  <Beats>
    <Beat id="0"><Rhythm ref="r0"/><Notes>0</Notes></Beat>
    <Beat id="1"><Rhythm ref="r0"/><Notes>1</Notes></Beat>
  </Beats>
  <Notes>
    <Note id="0">
      <Property name="String"><String>0</String></Property>
      <Property name="Fret"><Fret>0</Fret></Property></Note>
    <Note id="1">
      <Property name="String"><String>5</String></Property>
      <Property name="Fret"><Fret>0</Fret></Property></Note>
  </Notes>
  <Rhythms><Rhythm id="r0"><NoteValue>Quarter</NoteValue></Rhythm></Rhythms>
</GPIF>
"""


_GPIF_BASS_NEUTRAL_NAME = """
<GPIF>
  <Score><Title>T</Title><Artist>A</Artist></Score>
  <Tracks>
    <Track id="0"><Name>Track 1</Name>
      <Property name="Tuning"><Pitches>28 33 38 43</Pitches></Property></Track>
  </Tracks>
  <MasterBars><MasterBar><Time>4/4</Time><Bars>0</Bars></MasterBar></MasterBars>
  <Bars><Bar id="0"><Voices>0</Voices></Bar></Bars>
  <Voices><Voice id="0"><Beats>0</Beats></Voice></Voices>
  <Beats><Beat id="0"><Rhythm ref="r0"/><Notes>0</Notes></Beat></Beats>
  <Notes>
    <Note id="0">
      <Property name="String"><String>0</String></Property>
      <Property name="Fret"><Fret>0</Fret></Property></Note>
  </Notes>
  <Rhythms><Rhythm id="r0"><NoteValue>Quarter</NoteValue></Rhythm></Rhythms>
</GPIF>
"""


def test_convert_file_bass_named_bass_not_lead(tmp_path, monkeypatch):
    # A bass track (top string <= C3/48) with a neutral name must become a
    # "Bass" arrangement, not the "Lead" default — otherwise it imports as
    # guitar. Pitch-based detection so 5/6-string basses are covered too.
    monkeypatch.setattr(gp2rs_gpx, "_load_gpif",
                        lambda _p: ET.fromstring(_GPIF_BASS_NEUTRAL_NAME))
    out_files = convert_file("dummy.gp", str(tmp_path), track_indices=[0])
    root = ET.parse(out_files[0]).getroot()
    assert root.findtext("arrangement") == "Bass"


def test_convert_file_gp8_ascending_tuning_not_mirrored(tmp_path, monkeypatch):
    monkeypatch.setattr(gp2rs_gpx, "_load_gpif", lambda _p: ET.fromstring(_GPIF_GUITAR_ASCENDING))
    out_files = convert_file(
        "dummy.gp", str(tmp_path),
        track_indices=[0], arrangement_names={0: "Lead"},
    )
    root = ET.parse(out_files[0]).getroot()
    # Tuning is E-standard -> all-zero offsets with string0 = low E.
    tun = root.find("tuning")
    assert [int(tun.get(f"string{i}")) for i in range(6)] == [0, 0, 0, 0, 0, 0]
    # GPIF String 0 (open low E) -> RS string 0; String 5 (open high e) -> 5.
    placed = {(int(n.get("string")), int(n.get("fret")))
              for n in root.iter() if n.tag == "note"}
    assert (0, 0) in placed   # low-E open note on RS string 0 (was 5 before fix)
    assert (5, 0) in placed   # high-e open note on RS string 5


# Beat 0 carries a beat-level <Tremolo>; beat 1 does not. End-to-end proof that
# the picked beat's note serializes tremolo="1" and the other stays "0".
_GPIF_GUITAR_TREMOLO = """
<GPIF>
  <Score><Title>T</Title><Artist>A</Artist></Score>
  <Tracks>
    <Track id="0"><Name>Lead Guitar</Name>
      <Property name="Tuning"><Pitches>40 45 50 55 59 64</Pitches></Property></Track>
  </Tracks>
  <MasterBars>
    <MasterBar><Time>4/4</Time><Bars>0</Bars></MasterBar>
  </MasterBars>
  <Bars>
    <Bar id="0"><Voices>0</Voices></Bar>
  </Bars>
  <Voices>
    <Voice id="0"><Beats>0 1</Beats></Voice>
  </Voices>
  <Beats>
    <Beat id="0"><Rhythm ref="r0"/><Tremolo>1/8</Tremolo><Notes>0</Notes></Beat>
    <Beat id="1"><Rhythm ref="r0"/><Notes>1</Notes></Beat>
  </Beats>
  <Notes>
    <Note id="0">
      <Property name="String"><String>0</String></Property>
      <Property name="Fret"><Fret>0</Fret></Property></Note>
    <Note id="1">
      <Property name="String"><String>5</String></Property>
      <Property name="Fret"><Fret>0</Fret></Property></Note>
  </Notes>
  <Rhythms><Rhythm id="r0"><NoteValue>Quarter</NoteValue></Rhythm></Rhythms>
</GPIF>
"""


def test_convert_file_gp8_tremolo_beat_flags_note(tmp_path, monkeypatch):
    monkeypatch.setattr(gp2rs_gpx, "_load_gpif", lambda _p: ET.fromstring(_GPIF_GUITAR_TREMOLO))
    out_files = convert_file(
        "dummy.gp", str(tmp_path),
        track_indices=[0], arrangement_names={0: "Lead"},
    )
    root = ET.parse(out_files[0]).getroot()
    tremolo_by_string = {int(n.get("string")): n.get("tremolo")
                         for n in root.iter() if n.tag == "note"}
    # Beat 0 note (RS string 0) was tremolo-picked; beat 1 note (string 5) wasn't.
    assert tremolo_by_string[0] == "1"
    assert tremolo_by_string[5] == "0"


def test_vocal_pitch_sidecar_sorts_multi_voice_by_time():
    # Two voices in one bar. Voice 0 (traversed first) emits its lyric note at
    # t=0.5 (a no-lyric quarter precedes it); voice 1 (traversed second) emits
    # at t=0.0. Output must be chronological regardless of traversal order.
    def _beat(nid, *, lyric):
        ly = "<Lyrics><Line>la</Line></Lyrics>" if lyric else ""
        return ET.fromstring(f'<Beat><Rhythm ref="r0"/>{ly}<Notes>{nid}</Notes></Beat>')

    def _note():
        return ET.fromstring(
            '<Note><Property name="String"><String>0</String></Property>'
            '<Property name="Fret"><Fret>0</Fret></Property></Note>'
        )

    out = convert_vocal_track_to_pitch_sidecar(
        root=ET.fromstring('<GPIF/>'),
        track={'string_pitches': [60]},
        raw_idx=0,
        masterbars=[ET.fromstring('<MasterBar><Time>4/4</Time><Bars>0</Bars></MasterBar>')],
        bars_by_id={'0': ET.fromstring('<Bar><Voices>0 1</Voices></Bar>')},
        voices_dict={
            '0': ET.fromstring('<Voice><Beats>0 1</Beats></Voice>'),  # rest, then lyric@0.5
            '1': ET.fromstring('<Voice><Beats>2</Beats></Voice>'),    # lyric@0.0
        },
        beats_dict={
            '0': _beat('0', lyric=False),
            '1': _beat('1', lyric=True),
            '2': _beat('2', lyric=True),
        },
        notes_dict={'0': _note(), '1': _note(), '2': _note()},
        rhythms_dict={'r0': ET.fromstring('<Rhythm><NoteValue>Quarter</NoteValue></Rhythm>')},
    )
    times = [n['t'] for n in out['notes']]
    assert times == sorted(times)        # chronological
    assert times == [0.0, 0.5]


def test_notes_by_id_prefers_tablature_on_duplicate_ids():
    # Malformed pool: same id twice — a real String/Fret note then a
    # degenerate articulation-only twin. The TAB note must win so the
    # referencing track's notes don't vanish.
    from gp2rs_gpx import _notes_by_id
    root = ET.fromstring(
        "<GPIF><Notes>"
        "<Note id=\"0\"><Properties>"
        "<Property name=\"String\"><String>1</String></Property>"
        "<Property name=\"Fret\"><Fret>3</Fret></Property>"
        "</Properties></Note>"
        "<Note id=\"0\"><Properties>"
        "<Property name=\"ConcertPitch\"><Pitch><Step>C</Step><Octave>-1</Octave></Pitch></Property>"
        "</Properties><InstrumentArticulation>8</InstrumentArticulation></Note>"
        "</Notes></GPIF>"
    )
    nd = _notes_by_id(root)
    names = {p.get("name") for p in nd["0"].findall(".//Property")}
    assert "String" in names and "Fret" in names


def test_gpx_bend_scale_autodetects():
    from gp2rs_gpx import _gpx_bend_scale
    small = ET.fromstring('<GPIF><Note><Properties>'
        '<Property name="BendDestinationValue"><Float>100</Float></Property>'
        '</Properties></Note></GPIF>')
    big = ET.fromstring('<GPIF><Note><Properties>'
        '<Property name="BendDestinationValue"><Float>7500</Float></Property>'
        '</Properties></Note></GPIF>')
    assert _gpx_bend_scale(small) == 50.0
    assert _gpx_bend_scale(big) == 2500.0


# ── _resolve_pending_slides (grace-slide sustain fix) ───────────────────────

def test_resolve_grace_slide_zero_sustain_gets_gap_sustain():
    # A grace note imported as a shift-slide is short, so its sustain was
    # zeroed by the >0.2s rule. The highway won't draw a slide trail for a
    # sus<=0 note, so the resolver stretches it to span the gap to its target
    # — making the slide renderable. A grace ornament's target IS re-struck,
    # so link_next is NOT set (the main note keeps its gem); only the gap
    # sustain + slide_to are applied.
    grace = RsNote(time=80.0, string=4, fret=5, sustain=0.0)
    target = RsNote(time=80.125, string=4, fret=4, sustain=1.0)
    _resolve_pending_slides([grace, target], [], [(grace, 4, 1, True)])  # is_grace
    assert grace.slide_to == 4
    assert grace.link_next is False                 # main note's gem stays visible
    assert grace.sustain == pytest.approx(0.125)   # spans gap → renderable
    assert target.sustain == pytest.approx(1.0)     # untouched
    assert target.slide_to == -1


def test_resolve_normal_slide_sets_link_next_and_keeps_sustain():
    # A normal (non-grace) shift-slide suppresses its target gem via link_next
    # and must NOT have its authored sustain stretched.
    a = RsNote(time=0.0, string=0, fret=1, sustain=1.0)
    b = RsNote(time=1.0, string=0, fret=3, sustain=1.0)
    _resolve_pending_slides([a, b], [], [(a, 0, 2, False)])  # 2 = legato/shift
    assert a.slide_to == 3
    assert a.link_next is True
    assert a.sustain == pytest.approx(1.0)


def test_resolve_three_tuple_back_compat_defaults_to_normal():
    # A legacy 3-tuple (no is_grace) is treated as a normal slide (link_next set).
    a = RsNote(time=0.0, string=0, fret=1, sustain=1.0)
    b = RsNote(time=1.0, string=0, fret=3, sustain=1.0)
    _resolve_pending_slides([a, b], [], [(a, 0, 2)])
    assert a.slide_to == 3
    assert a.link_next is True


def test_resolve_unpitched_slide_out_flags():
    down = RsNote(time=0.0, string=0, fret=7, sustain=1.0)
    up = RsNote(time=1.0, string=0, fret=7, sustain=1.0)
    _resolve_pending_slides([down, up], [], [(down, 0, 4), (up, 0, 8)])
    assert down.slide_unpitch_to == 2    # max(1, 7-5)
    assert up.slide_unpitch_to == 12     # 7+5
    assert down.sustain == pytest.approx(1.0)


def test_resolve_grace_slide_without_target_is_noop():
    # No following note on the string → no slide, no sustain stretch, no crash.
    grace = RsNote(time=80.0, string=4, fret=5, sustain=0.0)
    _resolve_pending_slides([grace], [], [(grace, 4, 1)])
    assert grace.slide_to == -1
    assert grace.sustain == 0.0


def test_resolve_grace_slide_same_fret_target_no_slide():
    # Slide to an identical fret isn't a slide; leave the note alone.
    grace = RsNote(time=80.0, string=4, fret=5, sustain=0.0)
    target = RsNote(time=80.125, string=4, fret=5, sustain=1.0)
    _resolve_pending_slides([grace, target], [], [(grace, 4, 1)])
    assert grace.slide_to == -1
    assert grace.sustain == 0.0


# ── _note_has_vibrato (GP7/GP8 note vibrato import) ─────────────────────────

def test_note_vibrato_direct_element():
    # GP7/GP8 encodes note vibrato as a direct <Vibrato> child of <Note>,
    # NOT a <Property> — the regression this fixes.
    for strength in ("Slight", "Wide"):
        n = ET.fromstring(f'<Note id="1"><Vibrato>{strength}</Vibrato>'
                          '<Properties></Properties></Note>')
        tp = {p.get('name'): p for p in n.findall('.//Property')}
        assert _note_has_vibrato(n, tp) is True


def test_note_vibrato_property_form_also_detected():
    # Defensive: a <Property name="Vibrato"> form is still recognised.
    n = ET.fromstring('<Note id="1"><Properties>'
                      '<Property name="Vibrato"><Enable/></Property>'
                      '</Properties></Note>')
    tp = {p.get('name'): p for p in n.findall('.//Property')}
    assert _note_has_vibrato(n, tp) is True


def test_note_vibrato_absent_is_false():
    n = ET.fromstring('<Note id="1"><Properties>'
                      '<Property name="PalmMuted"><Enable/></Property>'
                      '</Properties></Note>')
    tp = {p.get('name'): p for p in n.findall('.//Property')}
    assert _note_has_vibrato(n, tp) is False


def test_note_vibrato_ignores_whammy_trembar_property():
    # VibratoWTremBar is a beat-level whammy property, handled separately; it
    # must NOT be read as note vibrato by this note-level helper.
    n = ET.fromstring('<Note id="1"><Properties>'
                      '<Property name="VibratoWTremBar"><Strength>Slight</Strength></Property>'
                      '</Properties></Note>')
    tp = {p.get('name'): p for p in n.findall('.//Property')}
    assert _note_has_vibrato(n, tp) is False


# ── _beat_has_tremolo (GP6/7/8 tremolo-picking import) ──────────────────────

def test_beat_tremolo_direct_element():
    # GPIF encodes tremolo picking as a direct <Tremolo>rate</Tremolo> child of
    # <Beat> — the regression this fixes (GPX never read it). Rate-agnostic.
    for rate in ("1/8", "1/16", "1/32"):
        b = ET.fromstring(f'<Beat id="1"><Rhythm ref="1"/>'
                          f'<Tremolo>{rate}</Tremolo></Beat>')
        assert _beat_has_tremolo(b) is True


def test_beat_tremolo_absent_is_false():
    b = ET.fromstring('<Beat id="1"><Rhythm ref="1"/><Notes>1</Notes></Beat>')
    assert _beat_has_tremolo(b) is False


def test_beat_tremolo_is_direct_child_only():
    # Matched as a direct child (not `.//`), so a <Tremolo> buried deeper must
    # NOT trigger — guards against a false positive from unrelated nested markup.
    b = ET.fromstring('<Beat id="1"><Properties>'
                      '<Property name="X"><Tremolo>1/8</Tremolo></Property>'
                      '</Properties></Beat>')
    assert _beat_has_tremolo(b) is False


def test_beat_tremolo_independent_of_whammy_trembar():
    # VibratoWTremBar is the separate whammy-bar effect; a beat carrying only
    # that (no <Tremolo>) is not tremolo picking.
    b = ET.fromstring('<Beat id="1"><Properties>'
                      '<Property name="VibratoWTremBar"><Strength>Slight</Strength></Property>'
                      '</Properties></Beat>')
    assert _beat_has_tremolo(b) is False


# ── _gpif_left_fingering (GP7/GP8 per-note fret-hand finger -> fg) ───────────
# GPIF stores a single note's fret-hand finger as a direct <LeftFingering>
# child of <Note> (NOT a <Property>), with classical p-i-m-a-c letter codes —
# verified against real GP8 exports (Open / I / M observed). Maps to the same
# RS finger integers as the chord-diagram path (§6.2.2). Teaching mark only.

@pytest.mark.parametrize("code, expected", [
    ("Open", -1), ("P", 0), ("I", 1), ("M", 2), ("A", 3), ("C", 4),
    ("i", 1), ("m", 2),                # case-insensitive
    ("index", 1), ("ring", 3),         # word forms also accepted
])
def test_gpif_left_fingering_letter_codes(code, expected):
    n = ET.fromstring(f'<Note id="1"><LeftFingering>{code}</LeftFingering>'
                      '<Properties></Properties></Note>')
    assert _gpif_left_fingering(n) == expected


def test_gpif_left_fingering_absent_or_unknown_is_unset():
    # No <LeftFingering> child, or an unrecognised value -> -1 (never fabricate).
    assert _gpif_left_fingering(ET.fromstring('<Note id="1"/>')) == -1
    assert _gpif_left_fingering(
        ET.fromstring('<Note id="1"><LeftFingering>Z</LeftFingering></Note>')) == -1
    assert _gpif_left_fingering(
        ET.fromstring('<Note id="1"><LeftFingering></LeftFingering></Note>')) == -1


# ── convert_file: GP8 chord-diagram name + fingering extraction (E3) ─────────
# GP7/GP8 GPIF carries authored chord diagrams under a track's
# Property[@name="DiagramCollection"]. Each Item gives the chord name and a
# <Diagram> with per-string fret + finger. A played voicing matching that
# fret pattern must import with the diagram's name + fingers; a chart without
# a DiagramCollection must import with blank name + all-(-1) fingers.

def _gpif_chord_diagram(diagram_block: str) -> str:
    # A two-note chord (low E fret 3 + A fret 2) on a low->high tuned guitar.
    return f"""
<GPIF>
  <Score><Title>T</Title><Artist>A</Artist></Score>
  <Tracks>
    <Track id="0"><Name>Lead Guitar</Name>
      <Property name="Tuning"><Pitches>40 45 50 55 59 64</Pitches></Property>
      {diagram_block}
    </Track>
  </Tracks>
  <MasterBars><MasterBar><Time>4/4</Time><Bars>0</Bars></MasterBar></MasterBars>
  <Bars><Bar id="0"><Voices>0</Voices></Bar></Bars>
  <Voices><Voice id="0"><Beats>0</Beats></Voice></Voices>
  <Beats><Beat id="0"><Rhythm ref="r0"/><Notes>0 1</Notes></Beat></Beats>
  <Notes>
    <Note id="0">
      <Property name="String"><String>0</String></Property>
      <Property name="Fret"><Fret>3</Fret></Property></Note>
    <Note id="1">
      <Property name="String"><String>1</String></Property>
      <Property name="Fret"><Fret>2</Fret></Property></Note>
  </Notes>
  <Rhythms><Rhythm id="r0"><NoteValue>Quarter</NoteValue></Rhythm></Rhythms>
</GPIF>
"""


_DIAGRAM_BLOCK = """
<Property name="DiagramCollection"><Items>
  <Item id="1" name="G5">
    <Diagram stringCount="6" fretCount="5" baseFret="0">
      <Fret string="0" fret="3"/>
      <Fret string="1" fret="2"/>
      <Fingering>
        <Position finger="Middle" fret="3" string="0"/>
        <Position finger="Index" fret="2" string="1"/>
      </Fingering>
    </Diagram>
  </Item>
</Items></Property>
"""


def _convert_first_chord_template(monkeypatch, tmp_path, gpif):
    monkeypatch.setattr(gp2rs_gpx, "_load_gpif", lambda _p: ET.fromstring(gpif))
    out_files = convert_file(
        "dummy.gp", str(tmp_path),
        track_indices=[0], arrangement_names={0: "Lead"},
    )
    root = ET.parse(out_files[0]).getroot()
    cts = root.findall(".//chordTemplates/chordTemplate")
    assert len(cts) == 1
    return cts[0]


def test_convert_file_gp8_chord_diagram_enriches_template(tmp_path, monkeypatch):
    ct = _convert_first_chord_template(
        monkeypatch, tmp_path, _gpif_chord_diagram(_DIAGRAM_BLOCK))
    # Diagram name + per-string fingering land on the matching voicing.
    assert ct.get("chordName") == "G5"
    # RS string 0 = low E (fret 3, Middle=2), string 1 = A (fret 2, Index=1).
    assert ct.get("fret0") == "3" and ct.get("finger0") == "2"
    assert ct.get("fret1") == "2" and ct.get("finger1") == "1"
    # Unplayed strings stay -1 for both fret and finger.
    assert [ct.get(f"finger{i}") for i in range(2, 6)] == ["-1"] * 4


def test_convert_file_gp8_no_diagram_leaves_template_blank(tmp_path, monkeypatch):
    # Same chart, no DiagramCollection -> identical import to before E3.
    ct = _convert_first_chord_template(
        monkeypatch, tmp_path, _gpif_chord_diagram(""))
    assert ct.get("chordName") == ""
    assert [ct.get(f"finger{i}") for i in range(6)] == ["-1"] * 6
    # Fret pattern itself is unchanged (the join key still works).
    assert ct.get("fret0") == "3" and ct.get("fret1") == "2"


# ── GP import correctness fixes (tester-reported) ───────────────────────────

# Two guitar tracks, Rhythm listed BEFORE Lead. The importer used to name
# arrangements purely by appearance order (first guitar -> "Lead"), which
# swapped the roles for any file that lists Rhythm first.
_GPIF_RHYTHM_BEFORE_LEAD = """
<GPIF>
  <Score><Title>T</Title><Artist>A</Artist></Score>
  <Tracks>
    <Track id="0"><Name>Rhythm Guitar</Name>
      <Property name="Tuning"><Pitches>40 45 50 55 59 64</Pitches></Property></Track>
    <Track id="1"><Name>Lead Guitar</Name>
      <Property name="Tuning"><Pitches>40 45 50 55 59 64</Pitches></Property></Track>
  </Tracks>
  <MasterBars><MasterBar><Time>4/4</Time><Bars>0 1</Bars></MasterBar></MasterBars>
  <Bars>
    <Bar id="0"><Voices>0</Voices></Bar>
    <Bar id="1"><Voices>1</Voices></Bar>
  </Bars>
  <Voices>
    <Voice id="0"><Beats>0</Beats></Voice>
    <Voice id="1"><Beats>1</Beats></Voice>
  </Voices>
  <Beats>
    <Beat id="0"><Rhythm ref="r0"/><Notes>0</Notes></Beat>
    <Beat id="1"><Rhythm ref="r0"/><Notes>1</Notes></Beat>
  </Beats>
  <Notes>
    <Note id="0"><Property name="String"><String>0</String></Property><Property name="Fret"><Fret>0</Fret></Property></Note>
    <Note id="1"><Property name="String"><String>0</String></Property><Property name="Fret"><Fret>0</Fret></Property></Note>
  </Notes>
  <Rhythms><Rhythm id="r0"><NoteValue>Quarter</NoteValue></Rhythm></Rhythms>
</GPIF>
"""


def test_convert_file_guitar_roles_follow_gp_name_not_order(tmp_path, monkeypatch):
    # Editor path: track_indices but no arrangement_names → convert_file's
    # fallback naming. The Rhythm track (listed first) must stay "Rhythm" and
    # the Lead track "Lead" — not be swapped by appearance order.
    monkeypatch.setattr(gp2rs_gpx, "_load_gpif",
                        lambda _p: ET.fromstring(_GPIF_RHYTHM_BEFORE_LEAD))
    out_files = convert_file("dummy.gp", str(tmp_path), track_indices=[0, 1])
    names = [ET.parse(f).getroot().findtext("arrangement") for f in out_files]
    assert names == ["Rhythm", "Lead"]


def _gpif_bass(pitches: str) -> str:
    return f"""
<GPIF>
  <Score><Title>T</Title><Artist>A</Artist></Score>
  <Tracks>
    <Track id="0"><Name>Bass</Name>
      <Property name="Tuning"><Pitches>{pitches}</Pitches></Property></Track>
  </Tracks>
  <MasterBars><MasterBar><Time>4/4</Time><Bars>0</Bars></MasterBar></MasterBars>
  <Bars><Bar id="0"><Voices>0</Voices></Bar></Bars>
  <Voices><Voice id="0"><Beats>0</Beats></Voice></Voices>
  <Beats><Beat id="0"><Rhythm ref="r0"/><Notes>0</Notes></Beat></Beats>
  <Notes>
    <Note id="0"><Property name="String"><String>0</String></Property>
      <Property name="Fret"><Fret>0</Fret></Property></Note>
  </Notes>
  <Rhythms><Rhythm id="r0"><NoteValue>Quarter</NoteValue></Rhythm></Rhythms>
</GPIF>
"""


@pytest.mark.parametrize("pitches,expected", [
    ("28 33 38 43", 4),        # 4-string E-A-D-G
    ("23 28 33 38 43", 5),     # 5-string low-B
])
def test_convert_file_bass_string_count_round_trips(tmp_path, monkeypatch, pitches, expected):
    # The <tuning> element pads to 6 slots (RS2014 schema), which erased the
    # 4-vs-5-string distinction. The serializer now records the real count in
    # `stringCount`; parse_arrangement trims to it so a 5-string bass reports 5
    # (was 4 → it rendered/played on 4 strings).
    from song import parse_arrangement, arrangement_string_count
    monkeypatch.setattr(gp2rs_gpx, "_load_gpif",
                        lambda _p: ET.fromstring(_gpif_bass(pitches)))
    out_files = convert_file("dummy.gp", str(tmp_path), track_indices=[0])
    root = ET.parse(out_files[0]).getroot()
    assert root.find("tuning").get("stringCount") == str(expected)
    arr = parse_arrangement(out_files[0])
    assert len(arr.tuning) == expected
    assert arrangement_string_count(arr) == expected


# A track with one normal note and one tie-DESTINATION note. The tie is folded
# into the previous note's sustain, so it is not a separate RS note; the
# importer's preview count must exclude it (matches the imported result).
_GPIF_WITH_TIE = """
<GPIF>
  <Score><Title>T</Title><Artist>A</Artist></Score>
  <Tracks>
    <Track id="0"><Name>Lead</Name>
      <Property name="Tuning"><Pitches>40 45 50 55 59 64</Pitches></Property></Track>
  </Tracks>
  <MasterBars><MasterBar><Time>4/4</Time><Bars>0</Bars></MasterBar></MasterBars>
  <Bars><Bar id="0"><Voices>0</Voices></Bar></Bars>
  <Voices><Voice id="0"><Beats>0 1</Beats></Voice></Voices>
  <Beats>
    <Beat id="0"><Rhythm ref="r0"/><Notes>0</Notes></Beat>
    <Beat id="1"><Rhythm ref="r0"/><Notes>1</Notes></Beat>
  </Beats>
  <Notes>
    <Note id="0"><Property name="String"><String>0</String></Property><Property name="Fret"><Fret>3</Fret></Property></Note>
    <Note id="1"><Tie destination="true"/><Property name="String"><String>0</String></Property><Property name="Fret"><Fret>3</Fret></Property></Note>
  </Notes>
  <Rhythms><Rhythm id="r0"><NoteValue>Quarter</NoteValue></Rhythm></Rhythms>
</GPIF>
"""


def test_list_tracks_note_count_excludes_tie_continuations(monkeypatch):
    monkeypatch.setattr(gp2rs_gpx, "_load_gpif",
                        lambda _p: ET.fromstring(_GPIF_WITH_TIE))
    tracks = gp2rs_gpx.list_tracks("dummy.gp")
    # 2 raw notes, 1 of them a tie destination → 1 importable note.
    assert tracks[0]["notes"] == 1


# A hinted "Lead Guitar" followed by an UNHINTED guitar: the unhinted one must
# advance to the next canonical role ("Rhythm"), not collide into "Lead 2".
_GPIF_LEAD_THEN_UNHINTED = """
<GPIF>
  <Score><Title>T</Title><Artist>A</Artist></Score>
  <Tracks>
    <Track id="0"><Name>Lead Guitar</Name>
      <Property name="Tuning"><Pitches>40 45 50 55 59 64</Pitches></Property></Track>
    <Track id="1"><Name>Guitar 2</Name>
      <Property name="Tuning"><Pitches>40 45 50 55 59 64</Pitches></Property></Track>
  </Tracks>
  <MasterBars><MasterBar><Time>4/4</Time><Bars>0 1</Bars></MasterBar></MasterBars>
  <Bars>
    <Bar id="0"><Voices>0</Voices></Bar>
    <Bar id="1"><Voices>1</Voices></Bar>
  </Bars>
  <Voices>
    <Voice id="0"><Beats>0</Beats></Voice>
    <Voice id="1"><Beats>1</Beats></Voice>
  </Voices>
  <Beats>
    <Beat id="0"><Rhythm ref="r0"/><Notes>0</Notes></Beat>
    <Beat id="1"><Rhythm ref="r0"/><Notes>1</Notes></Beat>
  </Beats>
  <Notes>
    <Note id="0"><Property name="String"><String>0</String></Property><Property name="Fret"><Fret>0</Fret></Property></Note>
    <Note id="1"><Property name="String"><String>0</String></Property><Property name="Fret"><Fret>0</Fret></Property></Note>
  </Notes>
  <Rhythms><Rhythm id="r0"><NoteValue>Quarter</NoteValue></Rhythm></Rhythms>
</GPIF>
"""


def test_convert_file_unhinted_guitar_takes_next_canonical_role(tmp_path, monkeypatch):
    # Mix of hinted + unhinted guitars spreads across Lead → Rhythm, not Lead/Lead 2.
    monkeypatch.setattr(gp2rs_gpx, "_load_gpif",
                        lambda _p: ET.fromstring(_GPIF_LEAD_THEN_UNHINTED))
    out_files = convert_file("dummy.gp", str(tmp_path), track_indices=[0, 1])
    names = [ET.parse(f).getroot().findtext("arrangement") for f in out_files]
    assert names == ["Lead", "Rhythm"]


def test_auto_select_gpx_unhinted_guitar_takes_next_canonical_role():
    # _auto_select_gpx path (auto-select-all): same spread rule.
    root = ET.fromstring(_GPIF_LEAD_THEN_UNHINTED)
    tracks = gp2rs_gpx._gpif_tracks(root)
    _indices, names = gp2rs_gpx._auto_select_gpx(tracks)
    assert sorted(names.values()) == ["Lead", "Rhythm"]


# Codex scenario: unhinted guitar BEFORE a later hinted "Rhythm Guitar". The
# real rhythm track must still get the canonical "Rhythm" (two-pass reserves
# hinted roles first); the unhinted one takes the leftover canonical role.
_GPIF_UNHINTED_BEFORE_RHYTHM = """
<GPIF>
  <Score><Title>T</Title><Artist>A</Artist></Score>
  <Tracks>
    <Track id="0"><Name>Lead Guitar</Name>
      <Property name="Tuning"><Pitches>40 45 50 55 59 64</Pitches></Property></Track>
    <Track id="1"><Name>Guitar 2</Name>
      <Property name="Tuning"><Pitches>40 45 50 55 59 64</Pitches></Property></Track>
    <Track id="2"><Name>Rhythm Guitar</Name>
      <Property name="Tuning"><Pitches>40 45 50 55 59 64</Pitches></Property></Track>
  </Tracks>
  <MasterBars><MasterBar><Time>4/4</Time><Bars>0 1 2</Bars></MasterBar></MasterBars>
  <Bars>
    <Bar id="0"><Voices>0</Voices></Bar>
    <Bar id="1"><Voices>1</Voices></Bar>
    <Bar id="2"><Voices>2</Voices></Bar>
  </Bars>
  <Voices>
    <Voice id="0"><Beats>0</Beats></Voice>
    <Voice id="1"><Beats>1</Beats></Voice>
    <Voice id="2"><Beats>2</Beats></Voice>
  </Voices>
  <Beats>
    <Beat id="0"><Rhythm ref="r0"/><Notes>0</Notes></Beat>
    <Beat id="1"><Rhythm ref="r0"/><Notes>1</Notes></Beat>
    <Beat id="2"><Rhythm ref="r0"/><Notes>2</Notes></Beat>
  </Beats>
  <Notes>
    <Note id="0"><Property name="String"><String>0</String></Property><Property name="Fret"><Fret>0</Fret></Property></Note>
    <Note id="1"><Property name="String"><String>0</String></Property><Property name="Fret"><Fret>0</Fret></Property></Note>
    <Note id="2"><Property name="String"><String>0</String></Property><Property name="Fret"><Fret>0</Fret></Property></Note>
  </Notes>
  <Rhythms><Rhythm id="r0"><NoteValue>Quarter</NoteValue></Rhythm></Rhythms>
</GPIF>
"""


def test_convert_file_unhinted_does_not_steal_later_rhythm(tmp_path, monkeypatch):
    monkeypatch.setattr(gp2rs_gpx, "_load_gpif",
                        lambda _p: ET.fromstring(_GPIF_UNHINTED_BEFORE_RHYTHM))
    out_files = convert_file("dummy.gp", str(tmp_path), track_indices=[0, 1, 2])
    names = [ET.parse(f).getroot().findtext("arrangement") for f in out_files]
    # Hinted roles reserved first → real Rhythm keeps canonical "Rhythm";
    # the unhinted middle track takes the leftover canonical role.
    assert names[0] == "Lead"
    assert names[2] == "Rhythm"
    assert names[1] == "Combo"
    assert "Rhythm 2" not in names and "Lead 2" not in names


def test_auto_select_gpx_unhinted_does_not_steal_later_rhythm():
    root = ET.fromstring(_GPIF_UNHINTED_BEFORE_RHYTHM)
    tracks = gp2rs_gpx._gpif_tracks(root)
    indices, names = gp2rs_gpx._auto_select_gpx(tracks)
    assert names[indices[0]] == "Lead"
    assert names[indices[2]] == "Rhythm"
    assert names[indices[1]] == "Combo"
