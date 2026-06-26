"""arrangement XML parser and song data models."""

from dataclasses import dataclass, field
from pathlib import Path
import bisect
import json
import logging
import math
import xml.etree.ElementTree as ET

log = logging.getLogger("feedBack.lib.song")


@dataclass
class Note:
    time: float
    string: int
    fret: int
    sustain: float = 0.0
    slide_to: int = -1
    slide_unpitch_to: int = -1
    bend: float = 0.0
    # Bend shape (§6.2.1, feedpak 1.4.0). `bend` stays the peak magnitude;
    # `bend_intent` is the gesture (0 up, 1 release, 2 pre-bend,
    # 3 pre-bend-release, 4 round-trip) and `bend_values` is the optional
    # time-stamped curve [{t: seconds-from-onset, v: semitones}], authoritative
    # when present. Both default-omitted on the wire; older readers ignore them.
    bend_intent: int = 0
    bend_values: list | None = None
    hammer_on: bool = False
    pull_off: bool = False
    harmonic: bool = False
    harmonic_pinch: bool = False
    palm_mute: bool = False
    mute: bool = False
    vibrato: bool = False
    tremolo: bool = False
    accent: bool = False
    link_next: bool = False
    tap: bool = False
    fret_hand_mute: bool = False
    pluck: bool = False
    slap: bool = False
    right_hand: int = -1
    pick_direction: int = -1
    # Teaching marks (§6.2.2, feedpak 1.5.0) — display/teaching only; a grader
    # MUST NEVER use these to judge whether a note was played correctly.
    # `fret_finger` is the fret-hand finger (-1 unset, 0 thumb, 1..4
    # index/middle/ring/pinky — same convention as a chord template's fingers);
    # `strum_group` is a strum/rake key (>= -1, default -1; notes sharing a value
    # >= 0 are one gesture, with `pick_direction` giving its direction);
    # `scale_degree` is the note's pitch class as a chromatic offset 0..11 above
    # the active key's tonic (default -1, MAY be derived from keys.json). All
    # three default-omitted on the wire; older readers ignore them.
    fret_finger: int = -1
    strum_group: int = -1
    scale_degree: int = -1
    ignore: bool = False


@dataclass
class ChordTemplate:
    name: str
    fingers: list[int]
    frets: list[int]
    display_name: str = ""
    arpeggio: bool = False
    # Harmony annotation (§6.6) — key-independent voicing type, e.g. "open",
    # "triad", "shell", "drop2", "barre". Display/teaching only, never grading.
    voicing: str = ""
    # Harmony annotation (§6.6) — the CAGED shape the fingering derives from,
    # one of "C"/"A"/"G"/"E"/"D" ("" = unset). Display/teaching only, never grading.
    caged: str = ""
    # Harmony annotation (§6.6) — chromatic semitone offsets 0..11 above the
    # chord root marking the quality-defining tones (e.g. dom7 -> [4, 10]).
    # snake_case attr; rides the wire as camelCase "guideTones" (like
    # display_name -> "displayName"). Display/teaching only, never grading.
    guide_tones: list = field(default_factory=list)


@dataclass
class Chord:
    time: float
    chord_id: int
    notes: list[Note] = field(default_factory=list)
    high_density: bool = False
    # Harmony annotation (§6.3.1) — key-dependent harmonic function on the chord
    # INSTANCE: {rn: str, q: str, deg: int 0..11}. All three keys required when
    # present (see _validate_fn). Display/teaching only, never grading.
    fn: dict | None = None


@dataclass
class Anchor:
    time: float
    fret: int
    width: int = 4


@dataclass
class Beat:
    time: float
    measure: int  # -1 for non-downbeat


@dataclass
class Section:
    name: str
    number: int
    start_time: float


@dataclass
class HandShape:
    chord_id: int
    start_time: float
    end_time: float
    # EOF / some custom song emit `arpeggio` on `<handShape>` (RS14+).
    arpeggio: bool = False


@dataclass
class PhraseLevel:
    """One difficulty tier's worth of note/chord/anchor/hand-shape data for a
    single phrase iteration. the arrangement XML stores these as `<level
    difficulty="N">` blocks that repeat for every difficulty tier the chart
    author wrote; feedBack used to collapse them to the phrase's
    maxDifficulty and throw the rest away. Keeping them around lets the
    highway render a "master difficulty" slider that picks a per-phrase
    difficulty tier at render time (feedBack#48)."""

    difficulty: int
    notes: list[Note] = field(default_factory=list)
    chords: list[Chord] = field(default_factory=list)
    anchors: list[Anchor] = field(default_factory=list)
    hand_shapes: list[HandShape] = field(default_factory=list)


@dataclass
class Phrase:
    """One phrase iteration with every difficulty tier the source chart
    provided, scoped to the iteration's time range. `max_difficulty` is the
    phrase's authored cap — `levels` may contain entries at or below that
    cap (zero-indexed). The full-chart flat arrangement.notes/chords list
    is built from max-difficulty levels and is unchanged by this addition;
    phrases are additive metadata for the difficulty-slider consumer."""

    start_time: float
    end_time: float
    max_difficulty: int
    levels: list[PhraseLevel] = field(default_factory=list)


@dataclass
class Arrangement:
    name: str
    tuning: list[int] = field(default_factory=lambda: [0] * 6)
    capo: int = 0
    notes: list[Note] = field(default_factory=list)
    chords: list[Chord] = field(default_factory=list)
    anchors: list[Anchor] = field(default_factory=list)
    hand_shapes: list[HandShape] = field(default_factory=list)
    chord_templates: list[ChordTemplate] = field(default_factory=list)
    # None for single-level sources (GP converter, old sloppaks) — frontends
    # should treat a missing `phrases` as "no per-phrase difficulty data
    # available, disable the slider". Populated from arrangement XML when
    # multiple `<level>` tiers exist.
    phrases: list[Phrase] | None = None
    # Tone data lifted from the source archive by the sloppak converter and
    # carried inline in the arrangement JSON. None for archive/loose playback
    # (the highway reads those tones from the XML directly) and for old
    # sloppaks predating tone support. Shape:
    #   {"base": str, "changes": [{"t": float, "name": str}],
    #    "definitions": [<raw RS tone object>]}
    # `base`/`changes` drive the highway tone-change markers; `definitions`
    # feed the Tones plugin gear panel.
    tones: dict | None = None
    # arrangement XML <arrangementProperties> flags for smart naming (feedBack feat/arrangement).
    # Populated from the XML; default False/0 for sloppak / GP-imported sources.
    path_lead: bool = False
    path_rhythm: bool = False
    path_bass: bool = False
    bonus_arr: bool = False
    represent: int = 0
    # RS2014 custom song pitch-shift field (cents). Commonly -1200.0 (one octave
    # down) for extended-range bass arrangements. 0.0 when absent or zero.
    cent_offset: float = 0.0
    # Per-chart tempo override (§6.10): [{time, bpm}]. None when the chart
    # follows the song-level tempo; when present a Reader uses it for this
    # chart and ignores the song-level tempo.
    tempos: list | None = None


@dataclass
class Song:
    title: str = ""
    artist: str = ""
    album: str = ""
    year: int = 0
    song_length: float = 0.0
    offset: float = 0.0
    beats: list[Beat] = field(default_factory=list)
    sections: list[Section] = field(default_factory=list)
    arrangements: list[Arrangement] = field(default_factory=list)
    audio_path: str = ""
    # Optional lyrics, one entry per syllable: {"t": float, "d": float, "w": str}
    lyrics: list[dict] = field(default_factory=list)
    # Provenance of the lyrics, when present. One of "xml" | "notechart" | "whisperx" |
    # "user" — surfaces in the highway WS payload so the UI can render a badge
    # (e.g. "auto-transcribed — may be inaccurate" for whisperx). The sloppak
    # loader (lib/sloppak.py) defaults missing manifest keys to "xml" at load
    # time so legacy sloppaks aren't mis-badged; the dataclass default of ""
    # only persists for sources that build a Song without populating it (e.g.
    # in-test stubs, the WS path before lyrics have been emitted).
    lyrics_source: str = ""


# ── Wire format serialization (shared between highway_ws and sloppak loader) ──
#
# These helpers produce/consume the same JSON shape the highway WebSocket streams
# to the client. They are the authoritative definition of the `.sloppak`
# arrangement file format — see `arrangements/*.json` inside a sloppak.

def note_to_wire(n: Note) -> dict:
    # The pre-existing technique keys (ho/po/hm/hp/pm/mt/vb/tr/ac/tp) keep
    # being emitted unconditionally to preserve the legacy wire-format
    # contract — older consumers may assume those keys exist. The new
    # techniques (ln/fhm/plk/slp/rh/pkd/ig) are introduced default-omitted
    # so the highway's per-note WebSocket payload doesn't inflate for the
    # common case where they're unset. `note_from_wire` decodes missing
    # keys to their dataclass defaults, matching the sloppak spec
    # ("Omit fields equal to their default …").
    out = {
        "t": round(n.time, 3), "s": n.string, "f": n.fret,
        "sus": round(n.sustain, 3),
        "sl": n.slide_to, "slu": n.slide_unpitch_to,
        "bn": round(n.bend, 1) if n.bend else 0,
        "ho": n.hammer_on, "po": n.pull_off,
        "hm": n.harmonic, "hp": n.harmonic_pinch,
        "pm": n.palm_mute, "mt": n.mute,
        "vb": n.vibrato,
        "tr": n.tremolo, "ac": n.accent, "tp": n.tap,
    }
    if n.link_next:
        out["ln"] = True
    if n.fret_hand_mute:
        out["fhm"] = True
    if n.pluck:
        out["plk"] = True
    if n.slap:
        out["slp"] = True
    if n.right_hand != -1:
        out["rh"] = n.right_hand
    if n.pick_direction != -1:
        out["pkd"] = n.pick_direction
    if n.ignore:
        out["ig"] = True
    # Bend shape (§6.2.1) — default-omitted: `bt` only when non-zero, `bnv`
    # only when a curve is present. Mirrors the spec's "omit fields equal to
    # their default" so a plain bend stays a single `bn` scalar on the wire.
    if n.bend_intent:
        out["bt"] = int(n.bend_intent)
    if n.bend_values:
        out["bnv"] = [
            {"t": round(p["t"], 3), "v": round(p["v"], 1)}
            for p in n.bend_values
        ]
    # Teaching marks (§6.2.2) — default-omitted, mirroring rh/pkd above.
    if n.fret_finger != -1:
        out["fg"] = n.fret_finger
    if n.strum_group != -1:
        out["ch"] = n.strum_group
    if n.scale_degree != -1:
        out["sd"] = n.scale_degree
    return out


def chord_note_to_wire(cn: Note) -> dict:
    # Chord notes omit their own time (the chord carries it).
    d = note_to_wire(cn)
    d.pop("t", None)
    return d


def chord_to_wire(c: Chord) -> dict:
    out = {
        "t": round(c.time, 3),
        "id": c.chord_id,
        "hd": c.high_density,
        "notes": [chord_note_to_wire(cn) for cn in c.notes],
    }
    # Harmony function (§6.3.1) — default-omitted, mirroring bend `bnv`. Re-validate
    # on emit (not just decode) so a directly-constructed Chord can't put a partial
    # or out-of-range fn on the wire, which would fail the schema's required-keys rule.
    fn = _validate_fn(c.fn)
    if fn:
        out["fn"] = fn
    return out


def anchor_to_wire(a: Anchor) -> dict:
    return {"time": a.time, "fret": a.fret, "width": a.width}


def hand_shape_to_wire(h: HandShape) -> dict:
    return {
        "chord_id": h.chord_id,
        "start_time": h.start_time,
        "end_time": h.end_time,
        "arp": h.arpeggio,
    }


def chord_template_to_wire(ct: ChordTemplate) -> dict:
    out = {
        "name": ct.name,
        # ChordTemplate.display_name defaults to "" on the dataclass, but
        # the spec defaults displayName to name. Fall back here so
        # templates that don't set display_name still serialize with a
        # usable label (matches `ct.get("displayName", name)` on the
        # parsing side, both XML and wire).
        "displayName": ct.display_name or ct.name,
        "arp": ct.arpeggio,
        "fingers": list(ct.fingers),
        "frets": list(ct.frets),
    }
    # Harmony voicing (§6.6) — default-omitted, only when non-empty.
    if ct.voicing:
        out["voicing"] = ct.voicing
    # CAGED shape + guide tones (§6.6) — default-omitted, mirroring voicing.
    # Sanitize on EMIT too (not just on decode): a directly-constructed template
    # must not be able to write a non-enum `caged` or an out-of-range `guideTone`
    # to the wire (the spec constrains caged to C/A/G/E/D and guideTones to 0..11).
    _caged = _sanitize_caged(ct.caged)
    if _caged:
        out["caged"] = _caged
    _guide_tones = _sanitize_guide_tones(ct.guide_tones)
    if _guide_tones:
        out["guideTones"] = _guide_tones
    return out


# §6.6 CAGED shape enum — the only values accepted off the wire.
_CAGED_SHAPES = ("C", "A", "G", "E", "D")


def _sanitize_caged(val) -> str:
    """A wire `caged` is kept only when it is one of the CAGED shape letters;
    anything else (None, int, list, unknown string) falls back to ""."""
    return val if isinstance(val, str) and val in _CAGED_SHAPES else ""


def _sanitize_guide_tones(val) -> list:
    """A wire `guideTones` is kept only as the int entries in 0..11; non-list
    input, non-ints (bool is an int subclass — rejected), and out-of-range
    values are dropped so a malformed value can't round-trip."""
    if not isinstance(val, list):
        return []
    return [v for v in val
            if isinstance(v, int) and not isinstance(v, bool) and 0 <= v <= 11]


def _wire_int_optional(v, default=-1):
    """Parse optional wire ints; fall back to default on null/blank/invalid."""
    if v is None:
        return default
    if isinstance(v, str) and not v.strip():
        return default
    try:
        return int(v)
    except (ValueError, TypeError, OverflowError):
        try:
            return int(float(v))
        except (ValueError, TypeError, OverflowError):
            return default


def _sanitize_bend_curve(raw):
    """Clean a time-stamped bend curve (``[{t, v}]``, §6.2.1): keep entries with
    a finite, non-bool numeric ``t`` and ``v``, coerced to float and sorted by
    ``t``. Non-list / absent / all-invalid input -> ``None`` so an empty curve
    round-trips as *omitted*, never ``[]``. ``t`` is seconds from the note
    onset; ``v`` is semitones (same scale as the scalar ``bn`` peak)."""
    if not isinstance(raw, list):
        return None
    out: list[dict] = []
    for p in raw:
        if not isinstance(p, dict):
            continue
        t = p.get("t")
        v = p.get("v")
        if (not isinstance(t, (int, float)) or isinstance(t, bool)
                or not math.isfinite(t)):
            continue
        if (not isinstance(v, (int, float)) or isinstance(v, bool)
                or not math.isfinite(v)):
            continue
        out.append({"t": float(t), "v": float(v)})
    if not out:
        return None
    out.sort(key=lambda e: e["t"])
    return out


# Natural-note letter -> pitch class (0 = C). Used to parse a keys.json key
# name's tonic for scale-degree derivation (§6.2.2 / §7.7).
_KEY_LETTER_PC = {"C": 0, "D": 2, "E": 4, "F": 5, "G": 7, "A": 9, "B": 11}


def key_to_tonic_pc(key) -> int | None:
    """Parse a keys.json key name (§7.7) to its tonic pitch class 0..11.

    Reads only the leading note letter plus optional accidentals — e.g. ``"E"``,
    ``"Em"``, ``"A#m"``, ``"Bb"``, ``"F#"`` -> 4, 4, 10, 10, 6. The mode/quality
    suffix (``m``/``maj``/``min``/scale name) is irrelevant to the tonic and is
    ignored. Returns ``None`` for anything not starting with a valid note letter,
    so callers can leave ``sd`` unset rather than guess. Used only for teaching
    marks; never for grading."""
    if not isinstance(key, str):
        return None
    s = key.strip()
    if not s:
        return None
    pc = _KEY_LETTER_PC.get(s[0].upper())
    if pc is None:
        return None
    # Consume any run of accidentals directly after the letter (``#``/``b``/
    # unicode ♯/♭); stop at the first non-accidental (start of the mode suffix).
    for ch in s[1:]:
        if ch in ("#", "♯"):
            pc += 1
        elif ch in ("b", "♭"):
            pc -= 1
        else:
            break
    return pc % 12


def scale_degree_for_pitch(midi_pitch: int, tonic_pc: int) -> int:
    """Chromatic scale degree 0..11 of ``midi_pitch`` above tonic ``tonic_pc``
    (§6.2.2): the pitch class distance in semitones, 0 = tonic, 7 = fifth.
    Display/teaching only — MUST NEVER feed a grader."""
    return (int(midi_pitch) - int(tonic_pc)) % 12


# Open-string base MIDI per string count, index 0 = lowest string. Mirrors
# app.js `_TUNING_BASE_MIDI` / highway_3d `_baseOpenStringMidis` so a derived
# scale degree agrees with the tuner + open-string labels. `arr.tuning` carries
# per-string OFFSETS from standard (not absolute pitch), so the sounding open
# pitch is `base + offset (+ capo)` — see `note_pitch_midi`.
_TUNING_BASE_MIDI = {
    4: [28, 33, 38, 43],
    5: [23, 28, 33, 38, 43],
    6: [40, 45, 50, 55, 59, 64],
    7: [35, 40, 45, 50, 55, 59, 64],
    8: [30, 35, 40, 45, 50, 55, 59, 64],
}


def base_open_string_midis(string_count: int, is_bass: bool) -> list[int]:
    """Standard open-string base MIDI list for an arrangement, index 0 = lowest.

    Mirrors app.js `_tuningOffsetsToFreqs`: a 4/5-string *bass* uses its own low
    base, while a 4/5-string non-bass (a guitar voicing) borrows the low strings
    of the 6-string base; 6/7/8 use their own. Unknown counts fall back to the
    6-string base."""
    n = int(string_count)
    if n in (4, 5):
        return _TUNING_BASE_MIDI[n] if is_bass else _TUNING_BASE_MIDI[6]
    return _TUNING_BASE_MIDI.get(n, _TUNING_BASE_MIDI[6])


def pitch_from_base(base: list[int], capo: int, tuning: list[int],
                    string: int, fret: int) -> int | None:
    """Absolute sounding MIDI for one string+fret, given a precomputed open-string
    ``base`` (from :func:`base_open_string_midis`) and the arrangement's tuning
    OFFSETS + capo. None when ``string`` has no tuning entry. Single source of the
    pitch formula so the per-note hot path can hoist ``base`` out of the loop."""
    if not (0 <= string < len(tuning)) or not base:
        return None
    root = base[string] if string < len(base) else base[-1]
    return root + int(tuning[string]) + int(capo) + int(fret)


def note_pitch_midi(arr: "Arrangement", note: "Note") -> int | None:
    """Absolute sounding MIDI pitch of ``note`` on arrangement ``arr``, or None
    when its string index has no tuning entry.

    Pitch = standard base for the string + the arrangement's per-string tuning
    OFFSET + capo + fret, matching the client's open-string/tuner math. Used to
    derive the ``sd`` teaching mark (§6.2.2); display only, never grading.
    O(notes) via ``arrangement_string_count`` — for a whole arrangement, hoist
    the base with :func:`base_open_string_midis` and call :func:`pitch_from_base`
    per note instead."""
    is_bass = "bass" in (arr.name or "").lower()
    base = base_open_string_midis(arrangement_string_count(arr), is_bass)
    return pitch_from_base(base, int(getattr(arr, "capo", 0) or 0),
                           arr.tuning or [], note.string, note.fret)


def note_from_wire(d: dict, time: float | None = None) -> Note:
    return Note(
        time=float(d.get("t", time if time is not None else 0.0)),
        string=int(d.get("s", 0)),
        fret=int(d.get("f", 0)),
        sustain=float(d.get("sus", 0.0)),
        slide_to=int(d.get("sl", -1)),
        slide_unpitch_to=int(d.get("slu", -1)),
        bend=float(d.get("bn", 0.0)),
        bend_intent=_wire_int_optional(d.get("bt"), 0),
        bend_values=_sanitize_bend_curve(d.get("bnv")),
        hammer_on=bool(d.get("ho", False)),
        pull_off=bool(d.get("po", False)),
        harmonic=bool(d.get("hm", False)),
        harmonic_pinch=bool(d.get("hp", False)),
        palm_mute=bool(d.get("pm", False)),
        mute=bool(d.get("mt", False)),
        vibrato=bool(d.get("vb", d.get("vibrato", False))),
        tremolo=bool(d.get("tr", False)),
        accent=bool(d.get("ac", False)),
        tap=bool(d.get("tp", False)),
        link_next=bool(d.get("ln", False)),
        fret_hand_mute=bool(d.get("fhm", False)),
        pluck=bool(d.get("plk", False)),
        slap=bool(d.get("slp", False)),
        # Optional integer metadata — graceful-fallback decode, matching
        # the XML side's `_int_optional`.
        right_hand=_wire_int_optional(d.get("rh"), -1),
        pick_direction=_wire_int_optional(d.get("pkd"), -1),
        # Teaching marks (§6.2.2) — display only, never used for grading.
        fret_finger=_wire_int_optional(d.get("fg"), -1),
        strum_group=_wire_int_optional(d.get("ch"), -1),
        scale_degree=_wire_int_optional(d.get("sd"), -1),
        ignore=bool(d.get("ig", False)),
    )


def _validate_fn(raw) -> dict | None:
    """Validate an optional chord harmony function (§6.3.1).

    Returns a clean ``{"rn", "q", "deg"}`` dict only when ``raw`` is an object
    with a non-empty ``rn`` string, a non-empty ``q`` string, and an int ``deg``
    in 0..11. Any malformed / missing-key / out-of-range input -> ``None`` so a
    partial fn (which would fail the schema's required-keys rule) never rides the
    wire. Display/teaching only — MUST NEVER feed a grader. Mirrors the
    drop-to-default tolerance of `_sanitize_bend_curve`."""
    if not isinstance(raw, dict):
        return None
    rn = raw.get("rn")
    q = raw.get("q")
    deg = raw.get("deg")
    if not isinstance(rn, str) or not rn.strip():
        return None
    if not isinstance(q, str) or not q.strip():
        return None
    # bool is an int subclass — reject it so `deg=True` can't pass as 1.
    if not isinstance(deg, int) or isinstance(deg, bool) or not (0 <= deg <= 11):
        return None
    return {"rn": rn.strip(), "q": q.strip(), "deg": deg}


def chord_from_wire(d: dict) -> Chord:
    t = float(d.get("t", 0.0))
    return Chord(
        time=t,
        chord_id=int(d.get("id", 0)),
        high_density=bool(d.get("hd", False)),
        notes=[note_from_wire(cn, time=t) for cn in d.get("notes", [])],
        fn=_validate_fn(d.get("fn")),
    )


def phrase_level_to_wire(pl: PhraseLevel) -> dict:
    return {
        "difficulty": pl.difficulty,
        "notes": [note_to_wire(n) for n in pl.notes],
        "chords": [chord_to_wire(c) for c in pl.chords],
        "anchors": [anchor_to_wire(a) for a in pl.anchors],
        "handshapes": [hand_shape_to_wire(h) for h in pl.hand_shapes],
    }


def phrase_to_wire(p: Phrase) -> dict:
    return {
        "start_time": round(p.start_time, 3),
        "end_time": round(p.end_time, 3),
        "max_difficulty": p.max_difficulty,
        "levels": [phrase_level_to_wire(lv) for lv in p.levels],
    }


def phrase_level_from_wire(d: dict) -> PhraseLevel:
    return PhraseLevel(
        difficulty=int(d.get("difficulty", 0)),
        notes=[note_from_wire(n) for n in d.get("notes", [])],
        chords=[chord_from_wire(c) for c in d.get("chords", [])],
        anchors=[
            Anchor(time=float(a.get("time", 0)), fret=int(a.get("fret", 0)),
                   width=int(a.get("width", 4)))
            for a in d.get("anchors", [])
        ],
        hand_shapes=[
            HandShape(chord_id=int(h.get("chord_id", 0)),
                      start_time=float(h.get("start_time", 0)),
                      end_time=float(h.get("end_time", 0)),
                      arpeggio=bool(h.get("arp", False)))
            for h in d.get("handshapes", [])
        ],
    )


def phrase_from_wire(d: dict) -> Phrase:
    return Phrase(
        start_time=float(d.get("start_time", 0.0)),
        end_time=float(d.get("end_time", 0.0)),
        max_difficulty=int(d.get("max_difficulty", 0)),
        levels=[phrase_level_from_wire(lv) for lv in d.get("levels", [])],
    )


def arrangement_string_count(arr: Arrangement) -> int:
    """Derive the active arrangement's string count.

    Used by the server to emit ``stringCount`` in the song_info
    WebSocket payload (feedBack-plugin-3dhighway#7).

    The arrangement XML schema always emits 6 ``<tuning>`` slots regardless
    of instrument (bass charts populate `string0`–`string3` and pad
    `string4`/`string5` with zeros), so ``len(arr.tuning)`` is not
    a reliable signal. Two independent signals get combined:

    1. **Notes-derived lower bound.** The highest string index
       referenced anywhere in notes + chord-notes, +1. A GP-imported
       7-string guitar with notes on strings 0..6 reports 7 here.
       But this is a LOWER BOUND only — a 6-string lead chart that
       never plays string 5 reports 5, undercounting by 1.

    2. **Name-based fallback.** Arrangements named "Bass" (case-
       insensitive substring match) default to 4; everything else
       defaults to 6. This catches the partial-string-usage case
       where notes don't span all the instrument's strings.

    A third signal — ``len(arr.tuning)`` when it isn't the arrangement XML
    padded value of 6 — folds in for sloppak / GP-imported sources
    where the tuning array is explicitly trimmed (4 for bass, 5 for
    5-string bass, 7 for 7-string guitar, etc.). arrangement XML / archive
    sources always emit length 6 regardless of instrument, so we
    deliberately ignore that exact value to avoid mis-classifying
    bass arrangements as guitar. ``< 6`` and ``> 6`` are both
    trustworthy signals.

    The result is ``max(notes_count, name_based, tuning_count)``
    where ``tuning_count`` is ``len(arr.tuning)`` when ``!= 6``,
    else 0. Worked examples:

    * arrangement XML 4-string bass, full usage (tuning len 6, notes 0..3) →
      max(4, 4, 0) = 4
    * arrangement XML 4-string bass, sparse usage (tuning len 6, notes 0..2) →
      max(3, 4, 0) = 4
    * arrangement XML 6-string lead, full usage (tuning len 6, notes 0..5) →
      max(6, 6, 0) = 6
    * arrangement XML 6-string lead, sparse usage (tuning len 6, notes 0..4) →
      max(5, 6, 0) = 6
    * Sloppak 5-string bass, sparse usage (tuning len 5, notes 0..3) →
      max(4, 4, 5) = 5
    * GP 7-string guitar (tuning len 7, notes 0..6) → max(7, 6, 7) = 7
    * GP 5-string bass (tuning len 5, notes 0..4) → max(5, 4, 5) = 5
    * Empty arrangement named "Bass" (tuning len 6) →
      max(0, 4, 0) = 4
    * Empty arrangement named "Lead" (tuning len 6) →
      max(0, 6, 0) = 6

    Topkoa's issue argues plugins shouldn't do arrangement-name
    matching; server-side fallback IS the right place for it
    because it gives plugins a single reliable ``stringCount`` to
    consume.
    """
    max_s = -1
    for n in arr.notes:
        if n.string > max_s:
            max_s = n.string
    for ch in arr.chords:
        for cn in ch.notes:
            if cn.string > max_s:
                max_s = cn.string
    notes_count = max_s + 1 if max_s >= 0 else 0
    name_based = 4 if "bass" in arr.name.lower() else 6
    # Tuning-length signal — only trustworthy when NOT the arrangement XML
    # padded value of 6. Length 4/5 indicates explicit bass / 5-string
    # bass; length 7/8 indicates an extended-range guitar from GP.
    tuning_len = len(arr.tuning)
    tuning_count = tuning_len if tuning_len != 6 else 0
    return max(notes_count, name_based, tuning_count)


def compute_smart_names(arrangements: list[Arrangement]) -> list[str | None]:
    """Compute smart display names for arrangements based on arrangement XML path flags.

    Returns a list parallel to `arrangements`. Each entry is a descriptive
    name like "Lead", "Alt. Lead", "Bonus Rhythm", "Bass", or None for
    non-instrument arrangements (Vocals, ShowLights) and unrecognised
    names whose path flags are all zero.

    Path-type resolution (first match wins):
    1. XML <arrangementProperties> flags (path_lead / path_rhythm / path_bass)
    2. Name-based fallback when ALL three flags are zero — keeps sloppak /
       GP-imported sources and custom song with unset flags working by mapping
       "Lead" / "Rhythm" / "Bass" / "Combo" → the matching path. Anything
       outside that set (Vocals, ShowLights, …) → None.

    Naming rules per path type (Lead / Rhythm / Bass):
    - Main group (bonusArr=False):
        represent=1 → "Lead" (or "Rhythm" / "Bass") — the canonical
            arrangement. If no entry has represent=1 (custom song with all-zero
            flags), the first by represent-ascending order is promoted.
        remaining (n_alts == 1) → "Alt. Lead"
        remaining (n_alts >= 2) → "Alt. Lead 1", "Alt. Lead 2", ...
          (sorted by represent ascending)
    - Bonus group (bonusArr=True), sorted by represent ascending:
        single → "Bonus Lead"
        multiple → "Bonus Lead 1", "Bonus Lead 2", ...
    """
    result: list[str | None] = [None] * len(arrangements)

    # Name-to-(path_attr, bonus_override) fallback used when all XML path
    # flags are zero. "Combo" is a guitar arrangement (lead + rhythm combined)
    # — treat as Lead. load_song() also synthesises display names like
    # "Bonus Lead" / "Bass 2" when manifest data is missing, so we recognise
    # those too and force the bonus flag for "Bonus *". `None` for the
    # override means "leave the dataclass's bonus_arr alone".
    _NAME_FALLBACK: dict[str, tuple[str, bool | None]] = {
        "lead": ("path_lead", None),
        "rhythm": ("path_rhythm", None),
        "bass": ("path_bass", None),
        "bass 2": ("path_bass", None),
        "combo": ("path_lead", None),
        "bonus lead": ("path_lead", True),
        "bonus rhythm": ("path_rhythm", True),
        "bonus bass": ("path_bass", True),
        "alt. lead": ("path_lead", False),
        "alt. rhythm": ("path_rhythm", False),
        "alt. bass": ("path_bass", False),
    }

    def _resolve(a: Arrangement) -> tuple[str | None, bool]:
        """Return (path_attr, bonus_arr) for an arrangement, applying the
        name-based fallback when XML flags are all zero. Defensive against
        non-string names from hand-edited archives / sloppak JSON."""
        if a.path_lead:
            return "path_lead", bool(a.bonus_arr)
        if a.path_rhythm:
            return "path_rhythm", bool(a.bonus_arr)
        if a.path_bass:
            return "path_bass", bool(a.bonus_arr)
        name = a.name if isinstance(a.name, str) else ""
        entry = _NAME_FALLBACK.get(name.strip().lower())
        if entry is None:
            return None, bool(a.bonus_arr)
        path_attr, bonus_override = entry
        return path_attr, bool(a.bonus_arr) if bonus_override is None else bonus_override

    _resolved = [_resolve(a) for a in arrangements]

    for path_attr, label in (
        ("path_lead", "Lead"),
        ("path_rhythm", "Rhythm"),
        ("path_bass", "Bass"),
    ):
        type_arrs = [
            (i, arrangements[i]) for i, (pa, _bonus) in enumerate(_resolved)
            if pa == path_attr
        ]
        if not type_arrs:
            continue

        # Main group (bonusArr=False):
        #   represent=1 → standard arrangement ("Lead")
        #   represent=0 (or any value != 1) → alternate arrangement ("Alt. Lead")
        #
        # If no arrangement has represent=1 (e.g. custom song defaults or all-zero
        # flags with name fallback), fall back to treating the first by
        # represent-ascending order as the standard so there is always a "Lead".
        main_pairs = [(i, a) for i, a in type_arrs if not _resolved[i][1]]
        standard = [(i, a) for i, a in main_pairs if a.represent == 1]
        alts = sorted(
            [(i, a) for i, a in main_pairs if a.represent != 1],
            key=lambda x: x[1].represent,
        )
        if not standard and alts:
            standard = [alts[0]]
            alts = alts[1:]
        # Guard: if somehow multiple represent=1 exist, promote only the first.
        if len(standard) > 1:
            extra = sorted(standard[1:], key=lambda x: x[1].represent)
            alts = sorted(extra + alts, key=lambda x: x[1].represent)
            standard = standard[:1]

        for i, _ in standard:
            result[i] = label

        n_alts = len(alts)
        for j, (i, _) in enumerate(alts):
            if n_alts == 1:
                result[i] = f"Alt. {label}"
            else:
                result[i] = f"Alt. {label} {j + 1}"

        # Bonus group (bonusArr=True): sorted by represent ascending.
        bonus_arrs = sorted(
            [(i, a) for i, a in type_arrs if _resolved[i][1]],
            key=lambda x: x[1].represent,
        )
        n_bonus = len(bonus_arrs)
        for j, (i, _) in enumerate(bonus_arrs):
            if n_bonus == 1:
                result[i] = f"Bonus {label}"
            else:
                result[i] = f"Bonus {label} {j + 1}"

    return result


def _finite_float(value, default: float = 0.0) -> float:
    """Coerce ``value`` to a finite float, falling back to ``default``.

    Malformed custom song can put ``NaN``/``Infinity`` into float fields like RS2014
    ``<centOffset>``; ``float()`` accepts those, but they serialize to the
    invalid JSON tokens ``NaN``/``Infinity`` (both over the highway WebSocket
    and into sloppak ``.json`` files), which breaks downstream parsing.
    """
    try:
        v = float(value)
    except (TypeError, ValueError):
        return default
    return v if math.isfinite(v) else default


def sanitize_tempos(events) -> list[dict]:
    """Clean a tempo-event list (``[{time, bpm}]``): keep entries with a finite
    non-bool ``time`` and a finite ``bpm > 0``, coerced to float and sorted by
    time. Non-list / all-invalid input -> ``[]``. Shared by the per-chart
    arrangement ``tempos`` (§6.10) and the song-level ``song_timeline.tempos``."""
    out: list[dict] = []
    if isinstance(events, list):
        for ev in events:
            if not isinstance(ev, dict):
                continue
            t = ev.get("time")
            bpm = ev.get("bpm")
            if (not isinstance(t, (int, float)) or isinstance(t, bool)
                    or not math.isfinite(t)):
                continue
            if (not isinstance(bpm, (int, float)) or isinstance(bpm, bool)
                    or not math.isfinite(bpm) or bpm <= 0):
                continue
            out.append({"time": float(t), "bpm": float(bpm)})
        out.sort(key=lambda e: e["time"])
    return out


def arrangement_to_wire(arr: Arrangement) -> dict:
    """Serialize an Arrangement into a JSON-ready dict matching the wire format."""
    out = {
        "name": arr.name,
        "tuning": list(arr.tuning),
        "capo": arr.capo,
        "centOffset": arr.cent_offset,
        "notes": [note_to_wire(n) for n in arr.notes],
        "chords": [chord_to_wire(c) for c in arr.chords],
        "anchors": [anchor_to_wire(a) for a in arr.anchors],
        "handshapes": [hand_shape_to_wire(h) for h in arr.hand_shapes],
        "templates": [chord_template_to_wire(ct) for ct in arr.chord_templates],
    }
    # phrases is additive — only include the key when the source had
    # multi-level data. Treat an empty list the same as None ("slider
    # disabled"): emitting `"phrases": []` would otherwise signal
    # "slider enabled but with no ladder" to consumers. Sloppak readers
    # / old consumers that don't know about phrases just continue to
    # see the flat-merge arrangement.
    if arr.phrases:
        out["phrases"] = [phrase_to_wire(p) for p in arr.phrases]
    # `tones` is additive — only emitted when the source carried tone data
    # (sloppaks converted from a archive). Absent on archive/loose-derived
    # Arrangements and old sloppaks; readers treat a missing key as
    # "no tones".
    if arr.tones:
        out["tones"] = arr.tones
    # Per-chart tempo override (§6.10) — additive; omit when the chart follows
    # the song-level tempo (empty/None).
    if arr.tempos:
        out["tempos"] = list(arr.tempos)
    return out


def arrangement_from_wire(d: dict) -> Arrangement:
    """Parse a wire-format arrangement dict back into an Arrangement dataclass."""
    return Arrangement(
        name=d.get("name", ""),
        tuning=list(d.get("tuning", [0] * 6)),
        capo=int(d.get("capo", 0)),
        cent_offset=_finite_float(d.get("centOffset", 0.0)),
        tempos=(sanitize_tempos(d.get("tempos")) or None),
        notes=[note_from_wire(n) for n in d.get("notes", [])],
        chords=[chord_from_wire(c) for c in d.get("chords", [])],
        anchors=[
            Anchor(time=float(a.get("time", 0)), fret=int(a.get("fret", 0)),
                   width=int(a.get("width", 4)))
            for a in d.get("anchors", [])
        ],
        hand_shapes=[
            HandShape(chord_id=int(h.get("chord_id", 0)),
                      start_time=float(h.get("start_time", 0)),
                      end_time=float(h.get("end_time", 0)),
                      arpeggio=bool(h.get("arp", False)))
            for h in d.get("handshapes", [])
        ],
        chord_templates=[
            ChordTemplate(name=ct.get("name", ""),
                          display_name=ct.get("displayName", ct.get("name", "")),
                          arpeggio=bool(ct.get("arp", False)),
                          fingers=list(ct.get("fingers", [-1] * 6)),
                          frets=list(ct.get("frets", [-1] * 6)),
                          voicing=(ct.get("voicing")
                                   if isinstance(ct.get("voicing"), str) else ""),
                          caged=_sanitize_caged(ct.get("caged")),
                          guide_tones=_sanitize_guide_tones(ct.get("guideTones")))
            for ct in d.get("templates", [])
        ],
        # `phrases` is optional — absent on single-level sources / older
        # sloppaks. Preserve None (rather than []) to preserve the
        # "slider disabled" signal downstream; an explicit empty list on
        # the wire is treated the same as absent.
        phrases=(
            [phrase_from_wire(p) for p in d["phrases"]]
            if d.get("phrases") else None
        ),
        # `tones` is an opaque block written by the converter. An empty dict
        # normalizes to None ("no tones") — symmetric with
        # `arrangement_to_wire`, which only emits the key when `arr.tones` is
        # truthy, and consistent with how `phrases` treats an empty value.
        # Absent on older sloppaks.
        tones=(d["tones"] if isinstance(d.get("tones"), dict) and d["tones"] else None),
    )


def _float(elem, attr, default=0.0):
    v = elem.get(attr)
    return float(v) if v is not None else default


def _int(elem, attr, default=0):
    v = elem.get(attr)
    if v is None:
        return default
    try:
        return int(v)
    except ValueError:
        return int(float(v))


def _int_optional(elem, attr, default=-1):
    """Graceful-fallback integer reader for *optional* XML attributes.

    Use for fields that are merely metadata hints (right-hand fingering,
    pick direction, etc.) where a malformed value from a third-party
    arrangement XML emitter shouldn't abort the whole arrangement parse.

    Required-field readers (`string`, `fret`, `chordId`, …) keep using
    `_int` so a corrupted required attribute still fails fast at parse
    time rather than silently defaulting to a wrong index.
    """
    v = elem.get(attr)
    if v is None or (isinstance(v, str) and not v.strip()):
        return default
    try:
        return int(v)
    except (ValueError, TypeError, OverflowError):
        try:
            return int(float(v))
        except (ValueError, TypeError, OverflowError):
            return default


_FALSE_LITERALS = frozenset({"", "0", "false", "False", "FALSE"})


def _bool(elem, attr):
    v = elem.get(attr)
    return v is not None and v not in _FALSE_LITERALS


def _hand_shape_arpeggio_flag(elem) -> bool:
    """charts / EOF may mark arpeggio on ``<handShape>`` (various casings)."""
    for attr in ("arpeggio", "Arpeggio", "arp", "Arp"):
        if _bool(elem, attr):
            return True
    return False


def _chord_template_arpeggio_flag(elem) -> bool:
    """charts commonly tag arpeggio templates in ``displayName`` via ``-arp``."""
    for attr in ("arpeggio", "Arpeggio", "arp", "Arp"):
        if _bool(elem, attr):
            return True
    display_name = elem.get("displayName", "")
    if isinstance(display_name, str):
        lowered = display_name.lower()
        if "-arp" in lowered or "arpeggio" in lowered:
            return True
    return False


def _chord_high_density(elem: ET.Element) -> bool:
    """RS14 uses ``highDensity`` on ``<chord>``; some converters vary casing."""
    for attr in ("highDensity", "highdensity", "HighDensity"):
        if _bool(elem, attr):
            return True
    return False


def _parse_bend_values(n):
    """Read a `bendValues` JSON attribute (GP import emits it; §6.2.1) and
    sanitize it into a [{t,v}] curve, or None when absent/malformed."""
    raw = n.get("bendValues")
    if not raw:
        return None
    try:
        return _sanitize_bend_curve(json.loads(raw))
    except (ValueError, TypeError):
        return None


def _parse_note(n) -> Note:
    return Note(
        time=_float(n, "time"),
        string=_int(n, "string"),
        fret=_int(n, "fret"),
        sustain=_float(n, "sustain"),
        slide_to=_int(n, "slideTo", -1),
        slide_unpitch_to=_int(n, "slideUnpitchTo", -1),
        bend=_float(n, "bend"),
        bend_intent=_int(n, "bendIntent", 0),
        bend_values=_parse_bend_values(n),
        hammer_on=_bool(n, "hammerOn"),
        pull_off=_bool(n, "pullOff"),
        harmonic=_bool(n, "harmonic"),
        harmonic_pinch=_bool(n, "harmonicPinch"),
        palm_mute=_bool(n, "palmMute"),
        mute=_bool(n, "mute"),
        vibrato=_bool(n, "vibrato"),
        tremolo=_bool(n, "tremolo"),
        accent=_bool(n, "accent"),
        link_next=_bool(n, "linkNext"),
        tap=_bool(n, "tap"),
        fret_hand_mute=_bool(n, "fretHandMute"),
        pluck=_bool(n, "pluck"),
        slap=_bool(n, "slap"),
        right_hand=_int_optional(n, "rightHand", -1),
        pick_direction=_int_optional(n, "pickDirection", -1),
        # Teaching mark (§6.2.2): GP import writes `fretFinger`; strum_group /
        # scale_degree are authored downstream (editor / derived), not in chart
        # XML, so they have no attribute to read here.
        fret_finger=_int_optional(n, "fretFinger", -1),
        ignore=_bool(n, "ignore"),
    )


def parse_arrangement(xml_path: str) -> Arrangement:
    """Parse a chart arrangement XML file."""
    tree = ET.parse(xml_path)
    root = tree.getroot()

    # Name
    arr_name = ""
    el = root.find("arrangement")
    if el is not None and el.text:
        arr_name = el.text

    # Tuning. RS schema has string0..string5; 7+ string arrangements
    # (7/8-string guitar, or pathological >6-string bass) carry
    # additional string6+ attributes that we preserve when present.
    # 4/5/6-string sources fit within string0..string5 and produce
    # no extra attributes.
    tuning = [0] * 6
    el = root.find("tuning")
    if el is not None:
        for i in range(6):
            tuning[i] = _int(el, f"string{i}")
        i = 6
        while el.get(f"string{i}") is not None:
            tuning.append(_int(el, f"string{i}"))
            i += 1
        # Authoritative string count, written by the GP/RS serializer
        # (gp2rs._build_xml). The schema pads `<tuning>` to 6 slots, which
        # erases the 4-vs-5-vs-6-string distinction for standard tunings;
        # when the real count was recorded, trim the padded tail so
        # arrangement_string_count / the editor see 4 or 5 instead of 6.
        # Absent (archive / legacy sources) → leave the 6-slot tuning as-is.
        sc = el.get("stringCount")
        if sc is not None:
            try:
                n = int(sc)
            except (TypeError, ValueError):
                n = 0
            if 1 <= n <= len(tuning):
                tuning = tuning[:n]

    # Capo
    capo = 0
    el = root.find("capo")
    if el is not None and el.text:
        try:
            capo = int(el.text)
        except ValueError:
            pass

    # CentOffset — RS2014 pitch-shift field (cents). Present in all arrangement XML
    # sources (archive, loose folders, GP-converted XML). Absent in very old
    # files; default 0.0.
    cent_offset = 0.0
    el = root.find("centOffset")
    if el is not None and el.text:
        # _finite_float guards against malformed NaN/Infinity reaching the
        # song_info WebSocket payload (invalid JSON) the same way song.offset
        # is sanitized server-side.
        cent_offset = _finite_float(el.text)

    # Chord templates. RS schema names fret0..fret5 / finger0..finger5;
    # extended-range arrangements emit additional fret6/finger6 (and so on)
    # which we preserve so 7/8-string chord templates round-trip correctly.
    chord_templates = []
    container = root.find("chordTemplates")
    if container is not None:
        for ct in container.findall("chordTemplate"):
            chord_name = ct.get("chordName", "")
            # Spec defaults displayName to name; treat an explicit empty
            # / whitespace-only displayName attribute the same as a
            # missing one so the parsed dataclass always has a usable
            # label (matches the wire emitter's `display_name or name`).
            display_name_attr = ct.get("displayName", "")
            display_name = display_name_attr.strip() or chord_name
            width = 6
            while ct.get(f"fret{width}") is not None or ct.get(f"finger{width}") is not None:
                width += 1
            chord_templates.append(
                ChordTemplate(
                    name=chord_name,
                    display_name=display_name,
                    arpeggio=_chord_template_arpeggio_flag(ct),
                    fingers=[_int(ct, f"finger{i}", -1) for i in range(width)],
                    frets=[_int(ct, f"fret{i}", -1) for i in range(width)],
                )
            )

    # Merge notes per-phrase: each phrase has its own maxDifficulty, and the full
    # chart is built by taking each phrase's notes from its max difficulty level.
    # For single-level XMLs (e.g. from GP converter), skip merging and use the one level directly.
    levels_el = root.find("levels")
    phrases_el = root.find("phrases")
    phrase_iters_el = root.find("phraseIterations")

    all_levels = {}
    if levels_el is not None:
        for level in levels_el.findall("level"):
            all_levels[_int(level, "difficulty")] = level

    notes = []
    chords = []
    anchors = []
    hand_shapes = []

    # Pre-parse each `<level>` once into time-sorted arrays plus a
    # parallel list of times for bisect. The phrase merge below slices
    # these per (phraseIteration × difficulty) pair; doing the XML walk
    # once per level turns that work from
    # O(phrases × levels × level_size) into
    # O(levels × level_size + phrases × levels × log(level_size)).
    # On long songs with deep ladders this is a big win.
    def _parse_level_fully(level):
        lv_notes = []
        container = level.find("notes")
        if container is not None:
            for n in container.findall("note"):
                lv_notes.append(_parse_note(n))
        lv_notes.sort(key=lambda n: n.time)

        lv_chords = []
        container = level.find("chords")
        if container is not None:
            for c in container.findall("chord"):
                t = _float(c, "time")
                chord_note_elems = list(c.findall("chordNote"))
                chord_notes = [_parse_note(cn) for cn in chord_note_elems]
                cid = _int(c, "chordId")
                # Chord-level technique flags — propagated to synthetic notes
                # when there are no <chordNote> children (gallop/repeat strums).
                _ch_pm  = _bool(c, "palmMute")
                _ch_mt  = _bool(c, "mute")
                # fretHandMute at the chord level is the chord-wide form of the
                # per-note fret-hand mute. Keep it on its own field
                # (`fret_hand_mute`, wire key "fhm") instead of folding it into
                # `mute` ("mt"): that preserves wire-format fidelity and matches
                # `_parse_note`, which maps XML fretHandMute -> fret_hand_mute.
                _ch_fhm = _bool(c, "fretHandMute")
                _ch_acc = _bool(c, "accent")
                if not chord_notes and cid < len(chord_templates):
                    ct = chord_templates[cid]
                    for s in range(len(ct.frets)):
                        if ct.frets[s] >= 0:
                            chord_notes.append(Note(
                                time=t, string=s, fret=ct.frets[s],
                                palm_mute=_ch_pm,
                                mute=_ch_mt,
                                fret_hand_mute=_ch_fhm,
                                accent=_ch_acc,
                            ))
                elif chord_notes and (_ch_pm or _ch_mt or _ch_fhm or _ch_acc):
                    # Propagate chord-level flags to chordNote children that
                    # don't set them explicitly. `_parse_note` flattens an
                    # absent attribute and an explicit false literal (`""`,
                    # `"0"`, `"false"`) to the same False, so peek at the raw
                    # XML element via `cn_elem.get(...)` to distinguish them
                    # — an authored `<chordNote palmMute="0">` under a
                    # `<chord palmMute="1">` parent must keep palm_mute=False.
                    for cn, cn_elem in zip(chord_notes, chord_note_elems):
                        if _ch_pm and cn_elem.get("palmMute") is None:
                            cn.palm_mute = True
                        if _ch_mt and cn_elem.get("mute") is None:
                            cn.mute = True
                        if _ch_fhm and cn_elem.get("fretHandMute") is None:
                            cn.fret_hand_mute = True
                        if _ch_acc and cn_elem.get("accent") is None:
                            cn.accent = True
                lv_chords.append(Chord(
                    time=t, chord_id=cid, notes=chord_notes,
                    high_density=_chord_high_density(c),
                ))
        lv_chords.sort(key=lambda c: c.time)

        lv_anchors = []
        container = level.find("anchors")
        if container is not None:
            for a in container.findall("anchor"):
                lv_anchors.append(Anchor(
                    time=_float(a, "time"), fret=_int(a, "fret"),
                    width=_int(a, "width", 4),
                ))
        lv_anchors.sort(key=lambda a: a.time)

        lv_hand_shapes = []
        container = level.find("handShapes")
        if container is not None:
            for hs in container.findall("handShape"):
                lv_hand_shapes.append(HandShape(
                    chord_id=_int(hs, "chordId"),
                    start_time=_float(hs, "startTime"),
                    end_time=_float(hs, "endTime"),
                    arpeggio=_hand_shape_arpeggio_flag(hs),
                ))
        lv_hand_shapes.sort(key=lambda h: h.start_time)

        return {
            "notes": lv_notes,
            "note_times": [n.time for n in lv_notes],
            "chords": lv_chords,
            "chord_times": [c.time for c in lv_chords],
            "anchors": lv_anchors,
            "anchor_times": [a.time for a in lv_anchors],
            "hand_shapes": lv_hand_shapes,
            "hs_times": [h.start_time for h in lv_hand_shapes],
        }

    parsed_levels = {diff: _parse_level_fully(el) for diff, el in all_levels.items()}

    def _extract_level_slice(parsed, t_start, t_end):
        """Return (notes, chords, anchors, hand_shapes) for one pre-parsed level,
        clipped to [t_start, t_end). Uses bisect on the parallel time arrays —
        much cheaper than re-scanning XML when called per phrase-iteration."""
        def _slice(items, times):
            i0 = bisect.bisect_left(times, t_start)
            i1 = bisect.bisect_left(times, t_end)
            return items[i0:i1]
        return (
            _slice(parsed["notes"], parsed["note_times"]),
            _slice(parsed["chords"], parsed["chord_times"]),
            _slice(parsed["anchors"], parsed["anchor_times"]),
            _slice(parsed["hand_shapes"], parsed["hs_times"]),
        )

    def _collect_from_parsed(parsed, t_start, t_end):
        """Append a pre-parsed level's time-clipped slice to the flat
        arrangement lists. Used for the max-mastery merge that preserves
        the pre-feedBack#48 behaviour for existing consumers."""
        lv_notes, lv_chords, lv_anchors, lv_hand_shapes = _extract_level_slice(
            parsed, t_start, t_end
        )
        notes.extend(lv_notes)
        chords.extend(lv_chords)
        anchors.extend(lv_anchors)
        hand_shapes.extend(lv_hand_shapes)

    def _collect_best_level_fallback():
        """Fallback merge when no usable phrase metadata is available: pick
        the level with the most notes+chords and flatten it."""
        best = max(
            parsed_levels.values(),
            key=lambda pl: len(pl["notes"]) + len(pl["chords"]),
        )
        _collect_from_parsed(best, 0.0, float("inf"))

    # Per-phrase difficulty data for the master-difficulty slider
    # (feedBack#48). Only populated when the XML has multiple levels AND
    # phrase data — left as None for single-level sources so the frontend
    # knows to disable the slider.
    phrases: list[Phrase] | None = None

    # If there's only one level, use it directly (no per-phrase merge needed)
    if len(parsed_levels) == 1:
        _collect_from_parsed(next(iter(parsed_levels.values())), 0.0, float("inf"))
    # Merge per-phrase if we have phrase data and multiple levels
    elif phrases_el is not None and phrase_iters_el is not None and parsed_levels:
        phrase_list = phrases_el.findall("phrase")
        iterations = phrase_iters_el.findall("phraseIteration")

        # The last phrase iteration has no "next" to take its end time
        # from, so derive one from the last real event across all parsed
        # levels. Using a finite value here (instead of float('inf'))
        # matters because this ends up in Phrase.end_time on the wire,
        # and JSON has no Infinity literal — JS JSON.parse would reject
        # it. Include all event types (note start + sustain end, chord
        # start, anchor time, hand shape end_time) so the last phrase
        # window covers the whole authored content even when the final
        # event isn't a note/chord start. +1s pad ensures the final
        # event itself falls inside the bisect_left < t_end window.
        last_event = 0.0
        for pl in parsed_levels.values():
            for n in pl["notes"]:
                last_event = max(last_event, n.time + n.sustain)
            if pl["chord_times"]:
                last_event = max(last_event, pl["chord_times"][-1])
            if pl["anchor_times"]:
                last_event = max(last_event, pl["anchor_times"][-1])
            for h in pl["hand_shapes"]:
                last_event = max(last_event, h.end_time)
        # Also bound by the last phrase iteration's start time — some
        # charts place a trailing-silence phrase marker past every
        # authored event. Without this, the last phrase could end up
        # with end_time < start_time (invalid window, empty slice).
        for it in iterations:
            last_event = max(last_event, _float(it, "time"))
        song_end = last_event + 1.0

        phrases = []
        for i, it in enumerate(iterations):
            pid = _int(it, "phraseId")
            if pid >= len(phrase_list):
                continue
            max_diff = _int(phrase_list[pid], "maxDifficulty")
            t_start = _float(it, "time")
            t_end = _float(iterations[i + 1], "time") if i + 1 < len(iterations) else song_end

            # Build a PhraseLevel for every difficulty tier the author
            # wrote at or below this phrase's max — these are what the
            # master-difficulty slider selects between at render time.
            # Tiers above max_diff exist in some XMLs (authoring leftovers)
            # and are skipped to match the reference player's behaviour.
            # Capture the extracted slices so the flat max-mastery merge
            # below can reuse one of them.
            phrase_levels: list[PhraseLevel] = []
            slices_by_diff: dict[int, tuple[list, list, list, list]] = {}
            for diff in sorted(parsed_levels.keys()):
                if diff > max_diff:
                    continue
                slc = _extract_level_slice(parsed_levels[diff], t_start, t_end)
                slices_by_diff[diff] = slc
                lv_notes, lv_chords, lv_anchors, lv_hand_shapes = slc
                phrase_levels.append(PhraseLevel(
                    difficulty=diff,
                    notes=lv_notes,
                    chords=lv_chords,
                    anchors=lv_anchors,
                    hand_shapes=lv_hand_shapes,
                ))

            # If every authored level was above this phrase's max_diff
            # (unusual but possible — e.g., the phrase block declares a
            # max_diff lower than any <level> that was actually written),
            # we have no ladder and no slice to flat-merge. Skip the
            # iteration entirely so the later `if not phrases:` fallback
            # can trigger a best-level merge for the whole arrangement.
            if not phrase_levels:
                continue

            phrases.append(Phrase(
                start_time=t_start,
                end_time=t_end,
                max_difficulty=max_diff,
                levels=phrase_levels,
            ))

            # Populate the flat max-mastery merge for existing consumers
            # (today's highway, sloppak converter's fallback). Reuse the
            # slice we just extracted for max_diff — or the closest tier
            # below it if max_diff itself wasn't authored.
            flat_diff = max_diff if max_diff in slices_by_diff else max(slices_by_diff)
            lv_notes, lv_chords, lv_anchors, lv_hand_shapes = slices_by_diff[flat_diff]
            notes.extend(lv_notes)
            chords.extend(lv_chords)
            anchors.extend(lv_anchors)
            hand_shapes.extend(lv_hand_shapes)

        # If the `<phraseIterations>` element was present but yielded
        # no usable iterations (empty element, or every iteration had
        # an out-of-range phraseId), revert to the "no phrase data"
        # sentinel and run the best-level fallback inline so we don't
        # ship an empty arrangement with the slider incorrectly enabled.
        if not phrases:
            phrases = None
            _collect_best_level_fallback()
    elif parsed_levels:
        _collect_best_level_fallback()

    notes.sort(key=lambda n: n.time)
    chords.sort(key=lambda c: c.time)
    anchors.sort(key=lambda a: a.time)
    hand_shapes.sort(key=lambda h: h.start_time)

    # Parse <arrangementProperties> for smart naming
    path_lead = path_rhythm = path_bass = bonus_arr = False
    represent = 0
    el = root.find("arrangementProperties")
    if el is not None:
        path_lead = _bool(el, "pathLead")
        path_rhythm = _bool(el, "pathRhythm")
        path_bass = _bool(el, "pathBass")
        bonus_arr = _bool(el, "bonusArr")
        represent = _int(el, "represent", 0)

    return Arrangement(
        name=arr_name,
        tuning=tuning,
        capo=capo,
        notes=notes,
        chords=chords,
        anchors=anchors,
        hand_shapes=hand_shapes,
        chord_templates=chord_templates,
        phrases=phrases,
        path_lead=path_lead,
        path_rhythm=path_rhythm,
        path_bass=path_bass,
        bonus_arr=bonus_arr,
        represent=represent,
        cent_offset=cent_offset,
    )


def _convert_sng_to_xml(extracted_dir: str):
    """No-op stub.

    Historically this converted proprietary encrypted ``.notechart`` arrangement
    files to XML via an external tool. That path has been removed: feedBack
    reads only its own ``.sloppak`` format and loose-folder/GP/MusicXML-derived
    arrangement XML, and never decodes or decrypts proprietary archives. Kept
    as a no-op so ``load_song`` (which loads plain arrangement XML/JSON from a
    directory) keeps its call site unchanged.
    """
    return None


def load_song(extracted_dir: str) -> Song:
    """Load a song from a directory of arrangement XML/JSON files."""
    # Proprietary note-chart→XML conversion has been removed; this is now a no-op.
    _convert_sng_to_xml(extracted_dir)

    song = Song()
    xml_files = sorted(Path(extracted_dir).rglob("*.xml"))

    # Build manifest lookups: xml_stem (lowercase) -> ArrangementName / path flags.
    # The manifest JSON is the authoritative source for path flags (pathLead /
    # pathRhythm / pathBass / bonusArr / represent) because the XML files bundled
    # in official DLC archives often have all path flags set to "0", while the
    # manifest correctly reflects what the authoring tool wrote.
    def _mprop_int(key: str, props: dict) -> int:
        val = props.get(key, 0)
        try:
            return int(val)
        except (TypeError, ValueError):
            return 0

    _manifest_names: dict[str, str] = {}
    _manifest_path_flags: dict[str, dict] = {}
    for jf in Path(extracted_dir).rglob("*.json"):
        try:
            data = json.loads(jf.read_text())
            entries = data.get("Entries") or {}
            for k, v in entries.items():
                attrs = v.get("Attributes") or {}
                arr_name = attrs.get("ArrangementName", "")
                if arr_name and arr_name not in ("Vocals", "ShowLights", "JVocals"):
                    stem = jf.stem.lower()
                    # Match by JSON filename stem (same as XML stem)
                    _manifest_names[stem] = arr_name
                    props = attrs.get("ArrangementProperties") or {}
                    _manifest_path_flags[stem] = {
                        "path_lead": bool(_mprop_int("pathLead", props)),
                        "path_rhythm": bool(_mprop_int("pathRhythm", props)),
                        "path_bass": bool(_mprop_int("pathBass", props)),
                        "bonus_arr": bool(_mprop_int("bonusArr", props)),
                        "represent": _mprop_int("represent", props),
                    }
        except Exception:
            continue

    metadata_loaded = False
    for xml_path in xml_files:
        try:
            tree = ET.parse(xml_path)
            root = tree.getroot()
        except ET.ParseError:
            continue

        if root.tag != "song":
            continue

        # Skip vocals and showlights
        el = root.find("arrangement")
        if el is not None and el.text:
            low = el.text.lower().strip()
            if low in ("vocals", "showlights", "jvocals"):
                continue

        # Metadata from first valid arrangement
        if not metadata_loaded:
            for tag, attr in [
                ("title", "title"),
                ("artistName", "artist"),
                ("albumName", "album"),
            ]:
                el = root.find(tag)
                if el is not None and el.text:
                    setattr(song, attr, el.text)

            el = root.find("albumYear")
            if el is not None and el.text:
                try:
                    song.year = int(el.text)
                except ValueError:
                    pass

            el = root.find("songLength")
            if el is not None and el.text:
                song.song_length = float(el.text)

            el = root.find("offset")
            if el is not None and el.text:
                song.offset = float(el.text)

            # Beats
            container = root.find("ebeats")
            if container is not None:
                for eb in container.findall("ebeat"):
                    song.beats.append(
                        Beat(time=_float(eb, "time"), measure=_int(eb, "measure", -1))
                    )

            # Sections
            container = root.find("sections")
            if container is not None:
                for s in container.findall("section"):
                    song.sections.append(
                        Section(
                            name=s.get("name", ""),
                            number=_int(s, "number"),
                            start_time=_float(s, "startTime"),
                        )
                    )

            metadata_loaded = True

        # Parse arrangement
        arrangement = parse_arrangement(str(xml_path))

        # Override path flags with manifest values when available. The XML
        # bundled inside official DLC archives often has all flags as "0", while
        # the manifest JSON carries the correct values written by the DLC author.
        manifest_flags = _manifest_path_flags.get(xml_path.stem.lower())
        if manifest_flags:
            arrangement.path_lead = manifest_flags["path_lead"]
            arrangement.path_rhythm = manifest_flags["path_rhythm"]
            arrangement.path_bass = manifest_flags["path_bass"]
            arrangement.bonus_arr = manifest_flags["bonus_arr"]
            arrangement.represent = manifest_flags["represent"]

        # Try to get the correct name from the manifest JSON
        manifest_name = _manifest_names.get(xml_path.stem.lower())
        if manifest_name:
            arrangement.name = manifest_name
        else:
            # Fallback: map internal XML names to display names
            _name_map = {
                "part real_guitar": "Lead",
                "part real_guitar_22": "Rhythm",
                "part real_bass": "Bass",
                "part real_guitar_bonus": "Bonus Lead",
                "part real_bass_22": "Bass 2",
            }
            low = arrangement.name.lower().strip()
            if low in _name_map:
                arrangement.name = _name_map[low]
            elif not arrangement.name or low.startswith("part "):
                # Infer from filename
                fname = xml_path.stem.lower()
                if "lead" in fname:
                    arrangement.name = "Lead"
                elif "rhythm" in fname:
                    arrangement.name = "Rhythm"
                elif "bass" in fname:
                    arrangement.name = "Bass"
                elif "combo" in fname:
                    arrangement.name = "Combo"
                else:
                    arrangement.name = xml_path.stem

        song.arrangements.append(arrangement)

    # Sort: Lead > Combo > Rhythm > Bass > other
    priority = {"lead": 0, "combo": 1, "rhythm": 2, "bass": 3}
    song.arrangements.sort(key=lambda a: priority.get(a.name.lower(), 99))

    # Fallback: read metadata from manifest JSON files (official DLC)
    if not song.title or not song.artist:
        _load_manifest_metadata(song, extracted_dir)

    return song


def _load_manifest_metadata(song: Song, extracted_dir: str):
    """Read song metadata from manifest JSON files (used for official DLC)."""
    d = Path(extracted_dir)
    for jf in d.rglob("*.json"):
        try:
            data = json.loads(jf.read_text())
            # Manifest JSON has: Entries -> {key} -> Attributes
            entries = data.get("Entries") or data.get("entries") or {}
            if entries:
                for key, val in entries.items():
                    attrs = val.get("Attributes") or val.get("attributes") or {}
                    if not song.title and attrs.get("SongName"):
                        song.title = attrs["SongName"]
                    if not song.artist and attrs.get("ArtistName"):
                        song.artist = attrs["ArtistName"]
                    if not song.album and attrs.get("AlbumName"):
                        song.album = attrs["AlbumName"]
                    if not song.year and attrs.get("SongYear"):
                        try:
                            song.year = int(attrs["SongYear"])
                        except (ValueError, TypeError):
                            pass
                    if not song.song_length and attrs.get("SongLength"):
                        try:
                            song.song_length = float(attrs["SongLength"])
                        except (ValueError, TypeError):
                            pass
                    if song.title and song.artist:
                        return
            # Also check flat structure (individual arrangement manifests)
            attrs = data.get("Attributes") or data.get("attributes") or {}
            if attrs:
                if not song.title and attrs.get("SongName"):
                    song.title = attrs["SongName"]
                if not song.artist and attrs.get("ArtistName"):
                    song.artist = attrs["ArtistName"]
                if not song.album and attrs.get("AlbumName"):
                    song.album = attrs["AlbumName"]
                if not song.year and attrs.get("SongYear"):
                    try:
                        song.year = int(attrs["SongYear"])
                    except (ValueError, TypeError):
                        pass
                if not song.song_length and attrs.get("SongLength"):
                    try:
                        song.song_length = float(attrs["SongLength"])
                    except (ValueError, TypeError):
                        pass
                if song.title and song.artist:
                    return
        except Exception:
            continue
