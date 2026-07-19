"""Lift legacy guitar-wire keys notes into the Sloppak Notation Format.

The reusable heuristic core shared by the one-time
``scripts/lift_keys_notation.py`` converter and any in-process caller (e.g.
the Arrangement Editor's notation save path). It takes decoded wire notes
plus the song-level ``beats`` array and infers measures, written durations,
and a right/left-hand split, producing a validated ``notation`` payload.

The heuristics (see ``build_notation`` and friends):

1. **Wire decode** — ``decode_wire_notes`` unpacks ``midi = s*24 + f`` (the
   Clone Hero / GP-import legacy encoding, sloppak-spec §5.3 legacy fallback),
   including chord notes, to ``[{"t", "midi", "sus"}, ...]`` sorted by time.
2. **Measures / tempo** — ``downbeat_times`` reads the song-level downbeats
   (``measure >= 0`` entries); ``measure_tempos`` derives a per-measure BPM
   from their spacing at the given time signature.
3. **Durations** — wire sustain when > 0, else the gap to the next onset in
   the same hand, quantized to the nearest plain or single-dotted
   ``{1,2,4,8,16,32}`` at the local tempo, floored at a 32nd
   (``quantize_duration``).
4. **Hand split** — ``split_hands`` groups simultaneous onsets (within 10 ms);
   a group spanning more than 12 semitones is split at its largest internal
   interval gap (low side → ``lh``); otherwise the whole group goes by mean
   pitch vs middle C (≥ 60 → ``rh``). Output is single-staff when everything
   lands on one side.

``build_notation`` assembles these into the schema payload, splitting notes
that cross a barline into tied continuations, and validates via
``notation.validate_notation`` before returning (raising on an invalid build
so a caller never persists a payload the loader would drop). Returns ``None``
when there is nothing to lift (no notes or no downbeats).
"""

from __future__ import annotations

from bisect import bisect_right
import re

import notation as notation_mod

# Arrangement names that identify a piano-family arrangement.
KEYS_NAME_RE = re.compile(r"\b(keys|piano|keyboard|synth)\b", re.IGNORECASE)

# Onsets within this window are treated as one simultaneous group/beat.
SIMULTANEITY_WINDOW_S = 0.010

# A simultaneous group spanning more than this is split between two hands.
HAND_SPLIT_SPAN_SEMITONES = 12

MIDDLE_C = 60


# ── Wire decoding ─────────────────────────────────────────────────────────────

def decode_wire_notes(arr_data: dict) -> list[dict]:
    """Decode an arrangement JSON's notes + chord notes to
    ``[{"t": float, "midi": int, "sus": float, "hand": str|None}, ...]``
    sorted by time.

    Keys content packs absolute MIDI as ``midi = s*24 + f`` (sloppak-spec
    §5.3 legacy fallback). Sustain is the ``sus`` field (``l`` accepted as a
    legacy alias). ``hand`` is the authored per-note hand assignment
    (``'lh'``/``'rh'`` — e.g. from a MusicXML grand-staff import via the
    editor); a strict enum decode, anything else reads as ``None``
    (unassigned) so junk can never steer the hand split. Entries with
    malformed fields are skipped.
    """
    out: list[dict] = []

    def _push(t, s, f, sus, hand):
        try:
            t = float(t)
            midi = int(s) * 24 + int(f)
            sus = float(sus or 0.0)
        except (TypeError, ValueError):
            return
        if 0 <= midi <= 127:
            out.append({
                "t": t, "midi": midi, "sus": max(0.0, sus),
                "hand": hand if hand in ("lh", "rh") else None,
            })

    for n in arr_data.get("notes") or []:
        if isinstance(n, dict):
            _push(n.get("t"), n.get("s"), n.get("f"), n.get("sus", n.get("l")),
                  n.get("hand"))
    for ch in arr_data.get("chords") or []:
        if not isinstance(ch, dict):
            continue
        ch_t = ch.get("t")
        for cn in ch.get("notes") or []:
            if isinstance(cn, dict):
                # Chord notes carry no own time — they sound at the chord's t.
                _push(cn.get("t", ch_t), cn.get("s"), cn.get("f"),
                      cn.get("sus", cn.get("l")), cn.get("hand"))

    out.sort(key=lambda n: (n["t"], n["midi"]))
    return out


# ── Hand split ────────────────────────────────────────────────────────────────

def group_simultaneous(notes: list[dict]) -> list[list[dict]]:
    """Group time-sorted notes whose onsets fall within 10 ms of the group start."""
    groups: list[list[dict]] = []
    for n in notes:
        if groups and n["t"] - groups[-1][0]["t"] <= SIMULTANEITY_WINDOW_S:
            groups[-1].append(n)
        else:
            groups.append([n])
    return groups


def split_hands(notes: list[dict]) -> dict[str, list[dict]]:
    """Assign every note to ``rh`` or ``lh``.

    An AUTHORED per-note ``hand`` ('lh'/'rh' — a MusicXML grand-staff import
    or a hand edit in the editor) always wins: those notes go straight to
    their hand and are REMOVED from the group before any heuristic math runs,
    so one explicit assignment can never skew its chordmates' guesses (e.g.
    an authored LH melody note above middle C must not drag the group mean
    down and flip the remaining notes).

    The remaining unassigned notes take the heuristic, per simultaneous
    group: a span > 12 semitones splits at the largest internal interval gap
    (low side → lh); otherwise the whole group goes by mean pitch vs middle C
    (≥ 60 → rh).
    """
    hands: dict[str, list[dict]] = {"rh": [], "lh": []}
    for full_group in group_simultaneous(notes):
        # Authored hands first — explicit notes leave the group entirely.
        group = []
        for n in full_group:
            if n.get("hand") in ("lh", "rh"):
                hands[n["hand"]].append(n)
            else:
                group.append(n)
        if not group:
            continue
        pitches = sorted(n["midi"] for n in group)
        span = pitches[-1] - pitches[0]
        if len(pitches) > 1 and span > HAND_SPLIT_SPAN_SEMITONES:
            # Prefer middle C as the split boundary when notes straddle it —
            # this correctly handles bass+treble chords from piano imports where
            # the largest-gap heuristic picks the wrong split point (e.g.
            # [G2, E3, C4]: largest gap is G2→E3 but the real split is E3|C4).
            # BUT only when both resulting hands are themselves playable: a bass
            # note under a treble voicing that merely dips below C4 (e.g.
            # [E2, B3, D4, G4]) would otherwise land E2+B3 in one hand — a
            # 19-semitone span that re-violates HAND_SPLIT_SPAN_SEMITONES. When
            # the middle-C split produces an unplayable hand, fall back to the
            # largest internal gap (which correctly isolates E2 there).
            threshold = None
            if pitches[0] < MIDDLE_C <= pitches[-1]:
                _lh = [p for p in pitches if p < MIDDLE_C]
                _rh = [p for p in pitches if p >= MIDDLE_C]
                if (_lh[-1] - _lh[0] <= HAND_SPLIT_SPAN_SEMITONES
                        and _rh[-1] - _rh[0] <= HAND_SPLIT_SPAN_SEMITONES):
                    threshold = MIDDLE_C - 1  # lh: midi < MIDDLE_C
            if threshold is None:
                gaps = [pitches[i + 1] - pitches[i] for i in range(len(pitches) - 1)]
                split_after = gaps.index(max(gaps))
                threshold = pitches[split_after]
            for n in group:
                hands["lh" if n["midi"] <= threshold else "rh"].append(n)
        else:
            mean = sum(pitches) / len(pitches)
            hand = "rh" if mean >= MIDDLE_C else "lh"
            hands[hand].extend(group)
    return {h: ns for h, ns in hands.items() if ns}


# ── Timing ────────────────────────────────────────────────────────────────────

def downbeat_times(beats: list[dict]) -> list[float]:
    """Times of the song-level downbeats (entries with ``measure >= 0``)."""
    out: list[float] = []
    for b in beats or []:
        if not isinstance(b, dict):
            continue
        try:
            measure = int(b.get("measure", -1))
            t = float(b.get("time", 0.0))
        except (TypeError, ValueError):
            continue
        if measure >= 0:
            out.append(t)
    out.sort()
    return out


def measure_tempos(downbeats: list[float], ts: tuple[int, int]) -> list[float]:
    """Per-measure BPM from downbeat spacing at the given time signature.

    BPM is quarter-note based: a measure holds ``num * 4/den`` quarter notes,
    so ``bpm = qn_per_measure * 60 / measure_duration``. The last measure has
    no next downbeat and inherits the previous measure's tempo (120 BPM for
    a single-measure song).
    """
    num, den = ts
    qn_per_measure = num * (4.0 / den)
    tempos: list[float] = []
    for i in range(len(downbeats)):
        if i + 1 < len(downbeats) and downbeats[i + 1] > downbeats[i]:
            dur = downbeats[i + 1] - downbeats[i]
            tempos.append(qn_per_measure * 60.0 / dur)
        else:
            tempos.append(tempos[-1] if tempos else 120.0)
    return tempos


def quantize_duration(dur_secs: float, bpm: float) -> tuple[int, int]:
    """Quantize a duration in seconds to ``(dur, dot)`` at the local tempo.

    Candidates are the plain and single-dotted schema denominators
    ``{1,2,4,8,16,32}``; the closest in absolute seconds wins. Anything at or
    below the 32nd floor returns ``(32, 0)``.
    """
    qn = 60.0 / bpm
    best: tuple[int, int] = (32, 0)
    best_err = float("inf")
    for den in (1, 2, 4, 8, 16, 32):
        for dot in (0, 1):
            cand = qn * (4.0 / den) * (1.5 if dot else 1.0)
            err = abs(dur_secs - cand)
            if err < best_err:
                best_err = err
                best = (den, dot)
    # Floor: never quantize below a plain 32nd.
    if dur_secs <= qn * (4.0 / 32):
        return (32, 0)
    return best


# ── Notation assembly ─────────────────────────────────────────────────────────

_STAFF_DEFS = {
    "rh": {"id": "rh", "clef": "G2", "label": "Right Hand"},
    "lh": {"id": "lh", "clef": "F4", "label": "Left Hand"},
}


def build_notation(
    wire_notes: list[dict],
    beats: list[dict],
    ts: tuple[int, int] = (4, 4),
    instrument: str = "piano",
) -> dict | None:
    """Build a notation payload from decoded wire notes + song beats.

    Returns ``None`` when there is nothing to lift (no notes or no downbeats).
    """
    if not wire_notes:
        return None
    downbeats = downbeat_times(beats)
    if not downbeats:
        return None

    tempos = measure_tempos(downbeats, ts)
    hands = split_hands(wire_notes)

    # Anacrusis: onsets before the first downbeat get their own pickup
    # measure (sloppak-spec §5.3 `pickup: true`) starting at the earliest
    # such onset, rather than being clamped into measure 1 with beats that
    # precede the measure's own `t`.
    earliest_onset = min(n["t"] for ns in hands.values() for n in ns)
    measure_starts = list(downbeats)
    has_pickup = earliest_onset < downbeats[0] - 1e-6
    if has_pickup:
        measure_starts.insert(0, earliest_onset)
        tempos.insert(0, tempos[0])

    def _measure_index(t: float) -> int:
        return max(0, min(len(measure_starts) - 1, bisect_right(measure_starts, t + 1e-9) - 1))

    def _measure_end(mi: int) -> float | None:
        return measure_starts[mi + 1] if mi + 1 < len(measure_starts) else None

    # Per-hand: resolve each onset group into one beat with a duration,
    # splitting notes that cross a barline into tied continuations — a beat
    # longer than the space left in its measure is unrepresentable in
    # standard notation (e.g. a half note starting on beat 4 of 4/4).
    beats_by_measure: dict[int, dict[str, list[dict]]] = {}

    def _emit(hand: str, mi: int, t: float, dur_secs: float, midis: list[int], tied: bool) -> None:
        bpm = tempos[mi]
        dur, dot = quantize_duration(dur_secs, bpm)
        beat_out: dict = {"t": round(t, 3), "dur": dur}
        if dot:
            beat_out["dot"] = dot
        beat_out["notes"] = [
            {"midi": m, **({"tied": True} if tied else {})} for m in midis
        ]
        beats_by_measure.setdefault(mi, {}).setdefault(hand, []).append(beat_out)

    for hand, notes in hands.items():
        groups = group_simultaneous(notes)
        for gi, group in enumerate(groups):
            t = group[0]["t"]
            mi = _measure_index(t)
            bpm = tempos[mi]

            # Raw duration: longest wire sustain in the group when any is
            # > 0, else the gap to the next onset group in the same hand
            # (last group falls back to one quarter at the local tempo).
            sus = max(n["sus"] for n in group)
            if sus > 0:
                raw = sus
            elif gi + 1 < len(groups):
                raw = groups[gi + 1][0]["t"] - t
            else:
                raw = 60.0 / bpm
            # Sorted, deduplicated pitches (both hands striking the same key
            # at the same instant collapses to one notehead).
            midis = sorted({n["midi"] for n in group})

            # Walk the span across barlines, emitting a tied continuation in
            # each subsequent measure. Tolerance: half a 32nd at the local
            # tempo, so quantization jitter doesn't split clean durations.
            seg_t, remaining, tied = t, raw, False
            while True:
                seg_mi = _measure_index(seg_t)
                end = _measure_end(seg_mi)
                tol = (60.0 / tempos[seg_mi]) * (4.0 / 32) / 2
                if end is None or seg_t + remaining <= end + tol:
                    _emit(hand, seg_mi, seg_t, remaining, midis, tied)
                    break
                _emit(hand, seg_mi, seg_t, end - seg_t, midis, tied)
                remaining -= end - seg_t
                seg_t = end
                tied = True

    used_staves = [s for s in ("rh", "lh") if s in hands]

    measures: list[dict] = []
    num, den = ts
    last_emitted_tempo: float | None = None
    for mi, start in enumerate(measure_starts):
        measure: dict = {"idx": mi + 1, "t": round(start, 3)}
        if mi == 0:
            measure["ts"] = [num, den]
            if has_pickup:
                measure["pickup"] = True
        bpm = tempos[mi]
        if last_emitted_tempo is None or abs(bpm - last_emitted_tempo) > 1.0:
            measure["tempo"] = round(bpm, 2)
            last_emitted_tempo = bpm
        staves_payload: dict[str, dict] = {}
        for staff_id in used_staves:
            staff_beats = beats_by_measure.get(mi, {}).get(staff_id)
            if staff_beats:
                staff_beats.sort(key=lambda b: b["t"])
                staves_payload[staff_id] = {"voices": [{"v": 1, "beats": staff_beats}]}
        measure["staves"] = staves_payload
        measures.append(measure)

    payload = {
        "version": notation_mod.SCHEMA_VERSION,
        "instrument": instrument,
        "staves": [_STAFF_DEFS[s] for s in used_staves],
        "measures": measures,
    }
    ok, reason = notation_mod.validate_notation(payload)
    if not ok:  # importer bug guard — never write a payload the loader drops
        raise ValueError(f"build_notation produced an invalid payload: {reason}")
    return payload
