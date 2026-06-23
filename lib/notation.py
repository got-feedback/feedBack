"""Notation format vocabulary and wire helpers.

The canonical notation payload for a sloppak arrangement is a per-arrangement
``notation_<id>.json`` file referenced from the arrangement entry in
``manifest.yaml`` via the ``notation:`` sub-key (see
``docs/sloppak-spec.md`` §5).

This module is the source of truth for:

- the closed vocabulary of valid clef identifiers and note durations,
- a permissive validator used by both the sloppak loader and importers,
- wire helpers that normalise measure data for WS streaming.

The schema is intentionally extensible: unknown fields round-trip through
the loader so a newer sloppak can still render on an older client that just
doesn't have visuals for the new field. Validation is strict only on the
required top-level shape (``version``, ``staves``, ``measures`` types).

Analogous to ``lib/drums.py`` for the drum tab format.
"""

from __future__ import annotations

import logging
import math

log = logging.getLogger("feedBack.lib.notation")


# ── Vocabulary ────────────────────────────────────────────────────────────────

# Current ``version`` written by importers. Readers MUST accept any version
# they recognise; an unknown version is logged at DEBUG and passed through
# (forward-compat per sloppak-spec Principle IV).
SCHEMA_VERSION: int = 1

# Closed set of alphaTab clef identifiers.
# G2      — treble clef (standard guitar, violin, flute, …)
# F4      — bass clef (piano left hand, bass, cello, …)
# C3      — alto clef (viola)
# C4      — tenor clef (cello upper register, trombone)
# neutral — unpitched / percussion staff
CLEFS: set[str] = {"G2", "F4", "C3", "C4", "neutral"}

# Valid note duration denominators (integer powers of 2, up to 32nd note).
# 1=whole, 2=half, 4=quarter, 8=eighth, 16=sixteenth, 32=thirty-second.
DURATIONS: set[int] = {1, 2, 4, 8, 16, 32}

# Typed grace-note vocabulary (beat field ``grace``).
# "a" — acciaccatura: slashed grace, steals time from the PREVIOUS note
#       (MusicXML <grace slash="yes">).
# "p" — appoggiatura: unslashed grace, steals time from the FOLLOWING note
#       (MusicXML <grace>).
GRACE_TYPES: set[str] = {"a", "p"}

# Forced stem directions (note field ``stem``). Omit to let the renderer
# decide (MusicXML <stem>).
STEM_DIRECTIONS: set[str] = {"up", "down"}

# Dynamics vocabulary (beat field ``dyn``).
DYNAMICS: set[str] = {"ppp", "pp", "p", "mp", "mf", "f", "ff", "fff"}


# ── Schema validation ─────────────────────────────────────────────────────────

def validate_notation(data: object) -> tuple[bool, str]:
    """Light schema check for a parsed ``notation_<id>.json`` payload.

    Returns ``(ok, reason)``.  Permissive: unknown top-level fields pass
    through unchanged.  Strict only on the required top-level shape:

    - ``data`` must be a JSON object (dict).
    - ``data["version"]`` must be an int when present.  A missing ``version``
      key is accepted as ``SCHEMA_VERSION``.  An unknown version value is
      logged at DEBUG level and still accepted — forward-compat.
    - ``data["staves"]`` must be a list.
    - ``data["measures"]`` must be a list.
    """
    if not isinstance(data, dict):
        return False, "notation payload must be a JSON object"

    # version — optional, must be int when present (bool subclasses int, reject)
    ver = data.get("version", SCHEMA_VERSION)
    if isinstance(ver, bool) or not isinstance(ver, int):
        return False, "notation.version must be an integer"
    if ver != SCHEMA_VERSION:
        log.debug("notation: unknown schema version %r — passing through", ver)

    # staves — required list
    if "staves" not in data:
        return False, "notation.staves is required"
    if not isinstance(data["staves"], list):
        return False, "notation.staves must be a list"

    # measures — required list
    if "measures" not in data:
        return False, "notation.measures is required"
    if not isinstance(data["measures"], list):
        return False, "notation.measures must be a list"

    return True, ""


# ── Wire helpers ──────────────────────────────────────────────────────────────

def _finite_float_wire(v: object, fallback: float = 0.0) -> float:
    """Return ``float(v)`` if finite, else ``fallback``.

    Prevents NaN/Infinity from reaching the WS JSON encoder where they would
    produce non-standard tokens that break browser ``JSON.parse`` calls.
    """
    try:
        f = float(v)  # type: ignore[arg-type]
    except (TypeError, ValueError):
        return fallback
    return f if math.isfinite(f) else fallback


def measure_to_wire(measure: object) -> dict:
    """Normalise one measure dict for WS streaming.

    - Returns a shallow copy of the measure; the input is not mutated.
    - The measure-level ``t`` (start time) and ``tempo`` fields are guarded
      against NaN/Infinity — non-finite values fall back to 0.0 so the
      highway WS frame always carries valid JSON.
    - Beat times (``beats[].t`` inside each voice of each staff) are rounded
      to 3 decimal places and carry the same finite guard, matching the
      precision used by ``drums.hit_to_wire``.
    - Fields equal to their default value are NOT stripped here — that is the
      file author's responsibility.  The wire helper is pass-through with time
      normalisation only.
    - Malformed input (non-dict) returns an empty dict so callers can skip it.
    """
    if not isinstance(measure, dict):
        return {}

    # Shallow-copy the top level so callers can't mutate our data.
    out = dict(measure)

    # Guard measure-level numeric fields against NaN/Infinity.
    # ``t`` — measure start time in seconds; ``tempo`` — BPM at this measure.
    for _field in ("t", "tempo"):
        if _field in out and isinstance(out[_field], (int, float)) and not isinstance(out[_field], bool):
            out[_field] = _finite_float_wire(out[_field])

    # Deep-round beat times inside staves → voices → beats → t.
    # We copy each level we touch to avoid mutating the source.
    staves_raw = out.get("staves")
    if isinstance(staves_raw, dict):
        staves_out: dict = {}
        for staff_id, staff_data in staves_raw.items():
            if not isinstance(staff_data, dict):
                staves_out[staff_id] = staff_data
                continue
            staff_out = dict(staff_data)
            voices_raw = staff_out.get("voices")
            if isinstance(voices_raw, list):
                voices_out = []
                for voice in voices_raw:
                    if not isinstance(voice, dict):
                        voices_out.append(voice)
                        continue
                    voice_out = dict(voice)
                    beats_raw = voice_out.get("beats")
                    if isinstance(beats_raw, list):
                        beats_out = []
                        for beat in beats_raw:
                            if not isinstance(beat, dict):
                                beats_out.append(beat)
                                continue
                            beat_out = dict(beat)
                            t = beat_out.get("t")
                            if isinstance(t, (int, float)) and not isinstance(t, bool):
                                # Guard against NaN/Infinity: json.loads accepts
                                # them but they serialize to invalid JSON tokens
                                # over the highway WS, breaking clients.
                                beat_out["t"] = round(_finite_float_wire(t), 3)
                            beats_out.append(beat_out)
                        voice_out["beats"] = beats_out
                    voices_out.append(voice_out)
                staff_out["voices"] = voices_out
            staves_out[staff_id] = staff_out
        out["staves"] = staves_out

    return out


def measures_to_wire(measures: list[dict]) -> list[dict]:
    """Vectorised ``measure_to_wire``.

    Drops entries that round-trip as empty dicts (i.e. malformed non-dict
    entries).  Preserves source order — does NOT sort by time.
    """
    out: list[dict] = []
    for m in measures:
        w = measure_to_wire(m)
        if w:
            out.append(w)
    return out


# ── Notation → flat notes (for editors / falling-note renderers) ──────────────

def _beat_written_seconds(beat: dict, qn: float) -> float:
    """Written duration of one beat in seconds at quarter-note length ``qn``,
    honouring dots (``n`` dots → ``2 − 1/2ⁿ`` × base) and tuplets (``tu`` =
    ``[actual, normal]`` → scale by ``normal/actual``, e.g. a ``[3, 2]`` triplet
    sounds ⅔ as long)."""
    dur = beat.get("dur") or 4
    dot = beat.get("dot") or 0
    dot_mult = (2.0 - 0.5 ** dot) if isinstance(dot, int) and dot > 0 else 1.0
    tu_mult = 1.0
    tu = beat.get("tu")
    if isinstance(tu, (list, tuple)) and len(tu) == 2:
        try:
            actual, normal = float(tu[0]), float(tu[1])
            if actual > 0 and normal > 0:
                tu_mult = normal / actual
        except (TypeError, ValueError):
            pass
    try:
        return qn * (4.0 / float(dur)) * dot_mult * tu_mult
    except (TypeError, ValueError, ZeroDivisionError):
        return qn


def notation_to_notes(notation: object) -> list[dict]:
    """Flatten a notation payload to ``[{"t", "midi", "sus"}, ...]`` sorted by
    ``(t, midi)`` — absolute onset seconds, absolute MIDI pitch, and a sounding
    duration in seconds.

    The inverse direction of the lifter: turns the staves/measures/voices/beats
    structure back into a flat note list a piano-roll editor or a falling-note
    highway can consume. Semantics:

    - **Sustain = the beat's written duration** at the local tempo (honouring
      dots and tuplet ``tu`` ratios). This is the note's notated length, so it
      neither stretches a short note across a following gap nor truncates a note
      that rings past a later onset. Exact when the source emits tuplet ``tu``
      (e.g. gp2notation) or quantised durations (the wire-lifter); a source that
      omits ``tu`` for tuplets — the current MusicXML importer — yields the
      printed note length, with onsets still exact (upstream follow-up).
    - **Tempo carries forward** across measures (a measure without a ``tempo``
      field inherits the last seen one; default 120 BPM).
    - **Tied continuations fold** into the originating note's sustain (summing
      written durations across beats/barlines).
    - **Grace** beats and **rests** are skipped (rests also end any held notes).
    """
    if not isinstance(notation, dict):
        return []

    # Pass 1 — gather each voice's beats in order across measures, carrying the
    # written-duration fallback (seconds at that measure's tempo) per beat.
    voice_timelines: dict[tuple, list[dict]] = {}
    last_tempo = 120.0
    for measure in notation.get("measures") or []:
        if not isinstance(measure, dict):
            continue
        tempo = measure.get("tempo")
        if tempo:
            try:
                v = float(tempo)
                if v > 0:
                    last_tempo = v
            except (TypeError, ValueError):
                pass
        qn = 60.0 / last_tempo if last_tempo > 0 else 0.5
        staves = measure.get("staves")
        if not isinstance(staves, dict):
            continue  # permissive: skip a malformed-but-loadable measure
        for staff_id, staff in staves.items():
            if not isinstance(staff, dict):
                continue
            voices = staff.get("voices")
            if not isinstance(voices, list):
                continue
            for vi, voice in enumerate(voices):
                if not isinstance(voice, dict):
                    continue
                voice_id = voice.get("v", vi)
                if not isinstance(voice_id, (int, str)):
                    voice_id = vi  # unhashable/odd id → fall back to position
                tl = voice_timelines.setdefault((staff_id, voice_id), [])
                beats = voice.get("beats")
                if not isinstance(beats, list):
                    continue
                for beat in beats:
                    if not isinstance(beat, dict):
                        continue
                    try:
                        t = float(beat.get("t", 0.0))
                    except (TypeError, ValueError):
                        t = 0.0
                    bn = beat.get("notes")
                    tl.append({
                        "t": t,
                        "written": _beat_written_seconds(beat, qn),
                        "grace": bool(beat.get("grace")),
                        "rest": bool(beat.get("rest")),
                        "notes": bn if isinstance(bn, list) else [],
                    })

    # Pass 2 — per voice, sustain = the beat's written duration; fold tied
    # continuations into the open note for that pitch.
    out: list[dict] = []
    for tl in voice_timelines.values():
        # Tie folding assumes chronological beats; a hand-written file (or a
        # future editor reorder) may not be ordered. Stable sort keeps
        # same-onset (chord) beats in source order.
        tl.sort(key=lambda b: b["t"])
        opens: dict[int, dict] = {}
        for b in tl:
            if b["grace"]:
                continue
            dur_secs = b["written"]
            if b["rest"]:
                opens.clear()
                continue
            present: set[int] = set()
            for n in b["notes"]:
                if not isinstance(n, dict):
                    continue
                try:
                    midi = int(n.get("midi"))
                except (TypeError, ValueError):
                    continue
                if not 0 <= midi <= 127:
                    continue
                present.add(midi)
                if n.get("tied") and midi in opens:
                    opens[midi]["sus"] = round(opens[midi]["sus"] + dur_secs, 4)
                else:
                    note = {"t": round(b["t"], 4), "midi": midi, "sus": round(dur_secs, 4)}
                    out.append(note)
                    opens[midi] = note
            for p in [p for p in opens if p not in present]:
                del opens[p]

    out.sort(key=lambda n: (n["t"], n["midi"]))
    return out
