"""Guitar Pro → Sloppak Notation Format importer (GPIF: .gpx GP6 / .gp GP7-8).

Builds the per-arrangement ``notation_<id>.json`` payload documented in
``docs/sloppak-spec.md`` §5.3 from a parsed GPIF score, so piano/keys tracks
imported from Guitar Pro carry real engraving data (measures → staves →
voices → beats → notes with absolute MIDI pitch) instead of only the
``midi = string*24 + fret`` guitar wire encoding.

Voice → staff routing (salvaged from the superseded PR #703 ``stf`` wire-field
approach): the GP author's voice position within a bar decides the hand —
voice position 0 lands on the ``rh`` staff (treble, ``G2``), voice positions
≥ 1 land on the ``lh`` staff (bass, ``F4``). A forced-LH track (the merged
``Piano LH`` partner of an LH/RH pair, or a standalone track whose name ends
in ``LH``) routes every voice to ``lh``. This preserves authored hand
crossings instead of inferring hands from pitch.

Timing reuses the same machinery as ``gp2rs_gpx.convert_file`` — the
bar-indexed tempo map, per-beat rhythm durations (dots + tuplets; see
``_beat_secs`` for the one deliberate double-dot divergence), and
``_note_midi`` — so the
notation beats line up with the RS-XML notes the highway plays (see
feedBack#618 for the longer-term goal of sharing the note-building walk
itself, and feedBack#261 for the time-signature-denominator pitfalls the
``beat_groups`` emission here exists to avoid re-introducing).

Where this plugs in: ``gp2rs_gpx.convert_file`` calls
``convert_track_to_notation`` for every keys track and writes the payload as
an ``<xml-stem>.notation.json`` sidecar next to the arrangement XML.  The
sloppak *assembly* step (which assigns arrangement ids and writes
``manifest.yaml`` — today that lives in the editor plugin's create-mode save)
then renames the sidecar into place via ``attach_notation_to_sloppak``.

Analogous to ``gp2rs.convert_drum_track_to_drumtab`` for the drum tab format.
"""

from __future__ import annotations

import json
import logging
import re
import xml.etree.ElementTree as ET
from pathlib import Path

import notation as notation_mod

log = logging.getLogger("feedBack.lib.gp2notation")


# GPX NoteValue string → notation duration denominator (sloppak-spec §5.3:
# 1=whole … 32=thirty-second). 64th/128th are below the schema floor; those
# beats are DROPPED with a warning (v1 non-features doctrine: drop, never
# approximate) — clamping the written value to 32 while time advances by the
# true 64th/128th span would emit self-contradictory notation (overlapping
# written durations).
_NOTE_VALUE_DEN: dict[str, int] = {
    "Whole": 1, "Half": 2, "Quarter": 4, "Eighth": 8,
    "16th": 16, "32nd": 32,
}

_SUB_FLOOR_NOTE_VALUES = frozenset({"64th", "128th"})

_STAFF_DEFS: dict[str, dict] = {
    "rh": {"id": "rh", "clef": "G2", "label": "Right Hand"},
    "lh": {"id": "lh", "clef": "F4", "label": "Left Hand"},
}

# Track names that force every voice onto the lh staff (e.g. the "Piano LH"
# half of an LH/RH pair imported standalone).
_LH_NAME_RE = re.compile(r"\blh\b\s*$", re.IGNORECASE)


def _children(root: ET.Element, tag: str) -> list[ET.Element]:
    """Children of ``root/<tag>``, or ``[]`` — explicit None check (an empty
    Element is falsy, so ``find(...) or []`` would mis-handle it and trips
    ElementTree's truth-value DeprecationWarning)."""
    el = root.find(tag)
    return list(el) if el is not None else []


def beat_groups_for(num: int, den: int) -> list[int] | None:
    """Return the spec ``beat_groups`` list for a time signature, or ``None``.

    Simple meters (denominator < 8, e.g. 2/4, 3/4, 4/4) have unambiguous
    grouping and omit the field. Compound meters built from dotted beats
    group in threes (6/8 → [3, 3]; 9/8 → [3, 3, 3]; 12/8 → [3, 3, 3, 3]);
    the common irregular meters get their conventional default (5/8 → [2, 3];
    7/8 → [2, 2, 3]). Anything else is omitted — the renderer's default
    grouping applies (sloppak-spec §5.3: the field is renderer-agnostic and
    optional).
    """
    if den < 8:
        return None
    if num > 3 and num % 3 == 0:
        return [3] * (num // 3)
    if num == 5:
        return [2, 3]
    if num == 7:
        return [2, 2, 3]
    return None


def _rhythm_fields(beat_el: ET.Element, rhythms_dict: dict) -> tuple[int, int, list[int] | None]:
    """Return ``(dur, dot, tu)`` notation fields for a GPIF beat.

    - ``dur`` — duration denominator from the referenced Rhythm's NoteValue
      (unknown values default to quarter, matching ``_beat_dur_secs``).
    - ``dot`` — augmentation dots from ``<AugmentationDot count="N">``,
      clamped to the schema's 0–2 range. Beat *times* advance via
      ``_beat_secs``, which applies the matching multiplier (×1.5 single,
      ×1.75 double), so the written dots and the emitted times agree.
    - ``tu`` — ``[num, den]`` tuplet from ``<PrimaryTuplet>``, or ``None``.
    """
    dur = 4
    dot = 0
    tu: list[int] | None = None
    rref = beat_el.find("Rhythm")
    if rref is not None:
        rhythm = rhythms_dict.get(rref.get("ref", ""))
        if rhythm is not None:
            nv = rhythm.findtext("NoteValue", "Quarter")
            dur = _NOTE_VALUE_DEN.get(nv, 4)
            dot_el = rhythm.find("AugmentationDot")
            if dot_el is not None:
                try:
                    dot = max(1, min(2, int(dot_el.get("count", 1))))
                except (TypeError, ValueError):
                    dot = 1
            tuplet = rhythm.find("PrimaryTuplet")
            if tuplet is not None:
                try:
                    t_num = int(tuplet.get("num", 1))
                    t_den = int(tuplet.get("den", 1))
                    if t_num > 0 and t_den > 0 and (t_num, t_den) != (1, 1):
                        tu = [t_num, t_den]
                except (TypeError, ValueError):
                    pass
    return dur, dot, tu


def _beat_secs(beat_el: ET.Element, rhythms_dict: dict, tempo_bpm: float) -> float:
    """Duration of a GPIF beat in seconds, honouring the full dot count.

    Mirrors ``gp2rs_gpx._beat_dur_secs`` except for double dots: that helper
    applies ×1.5 for any ``<AugmentationDot>`` regardless of its ``count``
    attribute, which would make a written ``dot: 2`` disagree with the
    emitted absolute beat times (overlapping engraving). Here a single dot
    is ×1.5 and a double dot ×1.75, so the notation walk stays
    self-consistent; for the rare double-dotted keys beat this intentionally
    diverges from the RS-XML walk's single-dot approximation.
    """
    from gp2rs_gpx import _NOTE_VALUE_QN

    dur_qn = 0.25
    rref = beat_el.find("Rhythm")
    if rref is not None:
        rhythm = rhythms_dict.get(rref.get("ref", ""))
        if rhythm is not None:
            nv = rhythm.findtext("NoteValue", "Quarter")
            dur_qn = _NOTE_VALUE_QN.get(nv, 0.25)
            dot_el = rhythm.find("AugmentationDot")
            if dot_el is not None:
                try:
                    count = int(dot_el.get("count", 1))
                except (TypeError, ValueError):
                    count = 1
                dur_qn *= 1.75 if count >= 2 else 1.5
            tuplet = rhythm.find("PrimaryTuplet")
            if tuplet is not None:
                try:
                    num = int(tuplet.get("num", 1))
                    den = int(tuplet.get("den", 1))
                    if num and den:
                        dur_qn *= den / num
                except (TypeError, ValueError):
                    pass
    return dur_qn * (60.0 / tempo_bpm)


def _masterbar_ks(mb: ET.Element) -> int | None:
    """Key signature (semitones from C, −7…+7) from a MasterBar, or None."""
    key_el = mb.find("Key")
    if key_el is None:
        return None
    raw = key_el.findtext("AccidentalCount")
    if raw is None:
        return None
    try:
        ks = int(raw.strip())
    except (TypeError, ValueError):
        return None
    return ks if -7 <= ks <= 7 else None


def _walk_track_beats(
    root: ET.Element,
    raw_idx: int,
    string_pitches: list[int],
    *,
    audio_offset: float,
    force_staff: str | None,
) -> list[dict[str, list[list[dict]]]]:
    """Walk one raw track bar-by-bar and bucket its beats per staff.

    Returns one entry per masterbar: ``{staff_id: [voice_beats, ...]}`` where
    each ``voice_beats`` is the ordered beat list of one GP voice. Timing
    mirrors ``gp2rs_gpx.convert_file`` (bar-indexed tempo map applied at bar
    starts, ``_beat_secs`` per beat) so notation lines up with the RS XML
    (modulo the double-dot fix documented on ``_beat_secs``).
    """
    # Local import keeps lib's flat-import convention and avoids a hard cycle
    # (gp2rs_gpx imports this module lazily from inside convert_file).
    from gp2rs_gpx import (
        _build_tempo_map, _gpif_tempo, _note_is_tie, _note_midi, _notes_by_id,
    )

    masterbars = _children(root, "MasterBars")
    bars_by_id = {b.get("id"): b for b in _children(root, "Bars")}
    voices_dict = {v.get("id"): v for v in _children(root, "Voices")}
    beats_dict = {b.get("id"): b for b in _children(root, "Beats")}
    rhythms_dict = {r.get("id"): r for r in _children(root, "Rhythms")}
    # Same duplicate-id-tolerant note lookup convert_file uses.
    notes_dict = _notes_by_id(root)

    tempo_bpm = _gpif_tempo(root)
    tempo_iter = iter(_build_tempo_map(root))
    next_tempo_bar, next_tempo_bpm = next(tempo_iter, (999999, tempo_bpm))
    cur_tempo = tempo_bpm

    out: list[dict[str, list[list[dict]]]] = []
    current_time = 0.0

    for mb_idx, mb in enumerate(masterbars):
        while mb_idx >= next_tempo_bar:
            cur_tempo = next_tempo_bpm
            next_tempo_bar, next_tempo_bpm = next(tempo_iter, (999999, cur_tempo))

        time_sig = mb.findtext("Time", "4/4")
        try:
            num_b, den_b = [int(x) for x in time_sig.split("/")]
        except ValueError:
            num_b, den_b = 4, 4
        # A malformed-but-parseable signature like "4/0" or "-3/4" would
        # divide by zero / run time backwards below.
        if num_b <= 0 or den_b <= 0:
            log.warning("gp2notation: invalid time signature %r — assuming 4/4", time_sig)
            num_b, den_b = 4, 4
        bar_duration = num_b * (4.0 / den_b) * (60.0 / cur_tempo)

        per_staff: dict[str, list[list[dict]]] = {}
        bar_ids = mb.findtext("Bars", "").split()
        bid = bar_ids[raw_idx] if raw_idx < len(bar_ids) else "-1"
        bar = bars_by_id.get(bid) if bid not in ("-1", "") else None
        if bar is not None:
            for voice_pos, vid in enumerate(bar.findtext("Voices", "").split()):
                if vid == "-1":
                    continue
                voice = voices_dict.get(vid)
                if voice is None:
                    continue

                # PR #703's voice→staff rule: GP voice position 0 = right
                # hand (treble), positions ≥ 1 = left hand (bass); a forced
                # staff (merged/standalone LH track) overrides both.
                staff = force_staff or ("rh" if voice_pos == 0 else "lh")

                voice_beats: list[dict] = []
                voice_time = current_time
                for beat_id in voice.findtext("Beats", "").split():
                    beat_el = beats_dict.get(beat_id)
                    if beat_el is None:
                        continue
                    dur_secs = _beat_secs(beat_el, rhythms_dict, cur_tempo)
                    # Sub-32nd rhythms can't be written in schema v1: drop the
                    # beat (warning) but advance time by its true span so the
                    # rest of the bar stays aligned with the RS-XML walk.
                    rref = beat_el.find("Rhythm")
                    rhythm = rhythms_dict.get(rref.get("ref", "")) if rref is not None else None
                    nv = rhythm.findtext("NoteValue", "Quarter") if rhythm is not None else "Quarter"
                    if nv in _SUB_FLOOR_NOTE_VALUES:
                        log.warning(
                            "gp2notation: dropping %s beat at %.3fs — below the "
                            "schema's 32nd floor (v1 non-feature)",
                            nv, voice_time + audio_offset,
                        )
                        voice_time += dur_secs
                        continue
                    dur, dot, tu = _rhythm_fields(beat_el, rhythms_dict)

                    beat_out: dict = {
                        "t": round(voice_time + audio_offset, 3),
                        "dur": dur,
                    }
                    if dot:
                        beat_out["dot"] = dot
                    if tu:
                        beat_out["tu"] = tu

                    notes_out: list[dict] = []
                    for nid in beat_el.findtext("Notes", "").strip().split():
                        note_el = notes_dict.get(nid)
                        if note_el is None:
                            continue
                        # GP pitch is absolute for piano-family tracks:
                        # String+Fret resolves via the track's string-template
                        # pitches (string_pitches[idx] + fret, concert pitch)
                        # and Tone+Octave is (octave+1)*12 + step semitone —
                        # both yield a real MIDI number, no tuning offset.
                        midi = _note_midi(note_el, string_pitches)
                        if midi is None or not 0 <= midi <= 127:
                            continue
                        note_out: dict = {"midi": midi}
                        # Unlike the RS-XML walk (which drops tie destinations
                        # and extends the origin's sustain), notation keeps
                        # tied continuations as their own beats — engraving
                        # needs the tied notehead.
                        if _note_is_tie(note_el):
                            note_out["tied"] = True
                        notes_out.append(note_out)

                    if notes_out:
                        beat_out["notes"] = notes_out
                    else:
                        # Authored rest, or every note failed pitch extraction.
                        beat_out["rest"] = True
                    voice_beats.append(beat_out)
                    voice_time += dur_secs

                if voice_beats:
                    per_staff.setdefault(staff, []).append(voice_beats)

        out.append(per_staff)
        current_time += bar_duration

    return out


def convert_track_to_notation(
    root: ET.Element,
    raw_idx: int,
    string_pitches: list[int],
    *,
    instrument: str = "piano",
    audio_offset: float = 0.0,
    track_name: str = "",
    lh_raw_idx: int | None = None,
    lh_string_pitches: list[int] | None = None,
) -> dict:
    """Convert one GPIF keys/piano track to a notation payload (spec §5.3).

    Args:
        root: Parsed ``score.gpif`` element (``gp2rs_gpx._load_gpif`` output).
        raw_idx: Raw track index into MasterBar ``Bars`` id lists (the same
            index ``convert_file`` derives via ``filtered_to_raw``).
        string_pitches: The track's string-template tuning (may be empty for
            Tone+Octave-encoded tracks).
        instrument: Self-describing instrument name for the payload.
        audio_offset: Seconds added to every emitted time (audio sync).
        track_name: Used only to detect a standalone forced-LH track
            (name ending in "LH" → every voice routes to the lh staff).
        lh_raw_idx / lh_string_pitches: When a Piano LH/RH pair was merged
            (``gp2rs_gpx._find_piano_pairs``), the LH partner's raw index and
            tuning — its beats are walked separately and forced onto ``lh``.

    Returns the validated notation dict (``version``/``instrument``/
    ``staves``/``measures``). Raises ``ValueError`` if the built payload
    fails ``notation.validate_notation`` (importer bug guard).
    """
    from gp2rs_gpx import _build_tempo_map, _gpif_tempo

    force_staff = "lh" if (track_name and _LH_NAME_RE.search(track_name)) else None
    walked = _walk_track_beats(
        root, raw_idx, string_pitches,
        audio_offset=audio_offset, force_staff=force_staff,
    )
    if lh_raw_idx is not None:
        lh_walked = _walk_track_beats(
            root, lh_raw_idx, lh_string_pitches or [],
            audio_offset=audio_offset, force_staff="lh",
        )
        # Merge the LH partner's voices into each measure's lh staff, after
        # any voices the main track already routed there.
        for main_bar, lh_bar in zip(walked, lh_walked):
            for staff_id, voices in lh_bar.items():
                main_bar.setdefault(staff_id, []).extend(voices)

    masterbars = _children(root, "MasterBars")
    tempo_bpm = _gpif_tempo(root)
    tempo_iter = iter(_build_tempo_map(root))
    next_tempo_bar, next_tempo_bpm = next(tempo_iter, (999999, tempo_bpm))
    cur_tempo = tempo_bpm

    measures: list[dict] = []
    used_staves: set[str] = set()
    current_time = 0.0
    last_ts: tuple[int, int] | None = None
    last_tempo: float | None = None
    last_ks: int | None = None

    for mb_idx, mb in enumerate(masterbars):
        while mb_idx >= next_tempo_bar:
            cur_tempo = next_tempo_bpm
            next_tempo_bar, next_tempo_bpm = next(tempo_iter, (999999, cur_tempo))

        time_sig = mb.findtext("Time", "4/4")
        try:
            num_b, den_b = [int(x) for x in time_sig.split("/")]
        except ValueError:
            num_b, den_b = 4, 4
        if num_b <= 0 or den_b <= 0:
            log.warning("gp2notation: invalid time signature %r — assuming 4/4", time_sig)
            num_b, den_b = 4, 4

        measure: dict = {
            "idx": mb_idx + 1,
            "t": round(current_time + audio_offset, 3),
        }
        if (num_b, den_b) != last_ts:
            measure["ts"] = [num_b, den_b]
            groups = beat_groups_for(num_b, den_b)
            if groups:
                measure["beat_groups"] = groups
            last_ts = (num_b, den_b)
        if cur_tempo != last_tempo:
            measure["tempo"] = cur_tempo
            last_tempo = cur_tempo
        ks = _masterbar_ks(mb)
        if ks is not None and ks != last_ks:
            measure["ks"] = ks
            last_ks = ks

        staves_payload: dict[str, dict] = {}
        for staff_id in ("rh", "lh"):  # stable staff order
            voices = (walked[mb_idx] if mb_idx < len(walked) else {}).get(staff_id)
            if not voices:
                continue
            used_staves.add(staff_id)
            staves_payload[staff_id] = {
                "voices": [
                    {"v": v_num, "beats": beats}
                    for v_num, beats in enumerate(voices, start=1)
                ],
            }
        measure["staves"] = staves_payload
        measures.append(measure)
        current_time += num_b * (4.0 / den_b) * (60.0 / cur_tempo)

    staves = [_STAFF_DEFS[s] for s in ("rh", "lh") if s in used_staves]
    if not staves:
        staves = [_STAFF_DEFS["rh"]]  # empty track — still a valid grand-staff stub

    payload = {
        "version": notation_mod.SCHEMA_VERSION,
        "instrument": instrument,
        "staves": staves,
        "measures": measures,
    }
    ok, reason = notation_mod.validate_notation(payload)
    if not ok:
        raise ValueError(f"gp2notation built an invalid payload: {reason}")
    return payload


# ── Sidecar + manifest wiring ─────────────────────────────────────────────────

def notation_sidecar_path(xml_path: str | Path) -> Path:
    """The notation sidecar written next to a converted arrangement XML.

    ``Foo_Keys.xml`` → ``Foo_Keys.notation.json``. Arrangement ids don't
    exist yet at convert time (they're assigned when the sloppak manifest is
    assembled), so the sidecar pairs with the XML by filename stem; the
    assembly step renames it to ``notation_<id>.json`` via
    ``attach_notation_to_sloppak``.
    """
    p = Path(xml_path)
    return p.with_name(p.stem + ".notation.json")


def write_notation_sidecar(xml_path: str | Path, payload: dict) -> Path:
    """Validate and write the notation sidecar for a converted XML."""
    ok, reason = notation_mod.validate_notation(payload)
    if not ok:
        raise ValueError(f"refusing to write invalid notation sidecar: {reason}")
    side = notation_sidecar_path(xml_path)
    side.write_text(json.dumps(payload, separators=(",", ":")), encoding="utf-8")
    return side


def attach_notation_to_sloppak(sloppak_dir: str | Path, arr_id: str, payload: dict) -> Path:
    """Write ``notation_<arr_id>.json`` into a directory-form sloppak and add
    the ``notation:`` sub-key to that arrangement's manifest entry.

    Raises ``ValueError`` on an invalid payload, an unsafe/unknown
    arrangement id, or a manifest without a matching arrangement entry.
    Note: the manifest is round-tripped through PyYAML (``safe_load`` +
    ``safe_dump(sort_keys=False)``) — key order is preserved but comments
    and custom formatting are lost.
    """
    import yaml

    ok, reason = notation_mod.validate_notation(payload)
    if not ok:
        raise ValueError(f"invalid notation payload: {reason}")
    if not arr_id or not re.fullmatch(r"[A-Za-z0-9_-]+", arr_id):
        raise ValueError(f"unsafe arrangement id for notation filename: {arr_id!r}")

    pak = Path(sloppak_dir)
    manifest_path = pak / "manifest.yaml"
    manifest = yaml.safe_load(manifest_path.read_text(encoding="utf-8"))
    if not isinstance(manifest, dict):
        raise ValueError(f"{manifest_path} is not a mapping")

    entry = next(
        (e for e in (manifest.get("arrangements") or [])
         if isinstance(e, dict) and e.get("id") == arr_id),
        None,
    )
    if entry is None:
        raise ValueError(f"no arrangement with id {arr_id!r} in {manifest_path}")

    filename = f"notation_{arr_id}.json"
    (pak / filename).write_text(
        json.dumps(payload, separators=(",", ":")), encoding="utf-8"
    )
    entry["notation"] = filename
    # Stamp the format version while we're rewriting the manifest (spec §4),
    # without downgrading an existing (possibly higher) declared version.
    from sloppak import FEEDPAK_VERSION
    manifest.setdefault("feedpak_version", FEEDPAK_VERSION)
    manifest_path.write_text(
        yaml.safe_dump(manifest, sort_keys=False, allow_unicode=True),
        encoding="utf-8",
    )
    return pak / filename
