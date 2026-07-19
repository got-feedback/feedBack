"""Tests for lib/notation_lift.py — the reusable wire → notation heuristics.

These cover the extracted core directly (independent of the
scripts/lift_keys_notation.py CLI glue): wire decode, simultaneity grouping,
hand split, downbeat/tempo derivation, duration quantization, and full
``build_notation`` assembly including anacrusis and tie-across-barline.
"""

from __future__ import annotations

import pytest

import notation
import notation_lift as nl


# ── Helpers ──────────────────────────────────────────────────────────────────

def _wire(t: float, midi: int, sus: float = 0.0) -> dict:
    """Guitar-wire keys note: midi packed as s*24 + f."""
    return {"t": t, "s": midi // 24, "f": midi % 24, "sus": sus}


def _beats_4_4(n_measures: int, bpm: float = 120.0) -> list[dict]:
    """Song-level downbeats for ``n_measures`` bars of 4/4 at a steady tempo."""
    secs_per_measure = (4 * 4.0 / 4) * 60.0 / bpm  # 4 quarter notes
    return [{"time": round(i * secs_per_measure, 6), "measure": i}
            for i in range(n_measures)]


# ── Wire decoding ────────────────────────────────────────────────────────────

def test_decode_wire_notes_unpacks_midi_and_sorts():
    arr = {"notes": [_wire(1.0, 67, 0.5), _wire(0.0, 60)]}
    out = nl.decode_wire_notes(arr)
    assert [n["midi"] for n in out] == [60, 67]
    assert out[0] == {"t": 0.0, "midi": 60, "sus": 0.0, "hand": None}
    assert out[1]["sus"] == 0.5


def test_decode_wire_notes_includes_chord_notes_at_chord_time():
    # Chord notes carry no own time → they sound at the chord's t.
    chord_note = lambda midi: {"s": midi // 24, "f": midi % 24}
    arr = {"chords": [{"t": 2.0, "notes": [chord_note(60), chord_note(64)]}]}
    out = nl.decode_wire_notes(arr)
    assert {n["midi"] for n in out} == {60, 64}
    assert all(n["t"] == 2.0 for n in out)


def test_decode_wire_notes_skips_malformed_and_out_of_range():
    arr = {"notes": [{"t": "x", "s": 2, "f": 5}, {"t": 0.0, "s": 99, "f": 0}]}
    assert nl.decode_wire_notes(arr) == []


def test_decode_wire_notes_accepts_legacy_l_sustain_alias():
    out = nl.decode_wire_notes({"notes": [{"t": 0.0, "s": 2, "f": 12, "l": 0.75}]})
    assert out[0]["sus"] == 0.75


# ── Simultaneity grouping ────────────────────────────────────────────────────

def test_group_simultaneous_buckets_within_window():
    notes = [{"t": 0.0, "midi": 60}, {"t": 0.005, "midi": 64},
             {"t": 0.5, "midi": 67}]
    groups = nl.group_simultaneous(notes)
    assert [len(g) for g in groups] == [2, 1]


# ── Hand split ───────────────────────────────────────────────────────────────

def test_split_hands_wide_span_splits_at_largest_gap_low_to_lh():
    # 36 (C2) ... 72 (C5): span 36 > 12 → split at the largest internal gap.
    notes = [{"t": 0.0, "midi": 36, "sus": 0}, {"t": 0.0, "midi": 72, "sus": 0}]
    hands = nl.split_hands(notes)
    assert hands["lh"][0]["midi"] == 36
    assert hands["rh"][0]["midi"] == 72


def test_split_hands_narrow_group_goes_by_mean_vs_middle_c():
    low = nl.split_hands([{"t": 0.0, "midi": 48, "sus": 0},
                          {"t": 0.0, "midi": 52, "sus": 0}])
    assert "lh" in low and "rh" not in low  # mean 50 < 60
    high = nl.split_hands([{"t": 0.0, "midi": 64, "sus": 0},
                           {"t": 0.0, "midi": 67, "sus": 0}])
    assert "rh" in high and "lh" not in high  # mean ~65.5 ≥ 60


def test_split_hands_straddling_middle_c_splits_at_middle_c():
    # [G2, E3, C4] = [43, 52, 60]: largest gap is G2→E3 (9) but the musically
    # correct split is E3|C4. Middle-C boundary → lh=[G2,E3], rh=[C4].
    notes = [{"t": 0.0, "midi": m, "sus": 0} for m in (43, 52, 60)]
    hands = nl.split_hands(notes)
    assert sorted(n["midi"] for n in hands["lh"]) == [43, 52]
    assert [n["midi"] for n in hands["rh"]] == [60]


def test_split_hands_middle_c_split_falls_back_when_it_makes_unplayable_hand():
    # Em7-shape RH voicing over a low bass note: [E2, B3, D4, G4] = [40,59,62,67].
    # A hard middle-C split would put E2+B3 in the LH — a 19-semitone span that
    # re-violates the 12-semitone threshold. Must fall back to the largest gap,
    # isolating E2 in the LH and keeping the treble voicing in the RH.
    notes = [{"t": 0.0, "midi": m, "sus": 0} for m in (40, 59, 62, 67)]
    hands = nl.split_hands(notes)
    assert [n["midi"] for n in hands["lh"]] == [40]
    assert sorted(n["midi"] for n in hands["rh"]) == [59, 62, 67]


def test_split_hands_authored_hand_always_wins():
    # An authored 'lh' melody note ABOVE middle C (a crossing-hands texture):
    # the heuristic alone would call midi 65 rh; the authored hand wins.
    notes = [{"t": 0.0, "midi": 65, "sus": 0, "hand": "lh"}]
    hands = nl.split_hands(notes)
    assert [n["midi"] for n in hands["lh"]] == [65]
    assert "rh" not in hands


def test_split_hands_explicit_notes_leave_the_group_before_heuristic_math():
    # Group [C3(authored rh!), C4, E4]: without removal, C3=48 drags the mean
    # to (48+60+64)/3 ≈ 57.3 < 60 → the WHOLE group would flip lh. With the
    # authored note removed first, the remaining [C4, E4] mean 62 ≥ 60 → rh.
    notes = [
        {"t": 0.0, "midi": 48, "sus": 0, "hand": "rh"},
        {"t": 0.0, "midi": 60, "sus": 0},
        {"t": 0.0, "midi": 64, "sus": 0},
    ]
    hands = nl.split_hands(notes)
    assert sorted(n["midi"] for n in hands["rh"]) == [48, 60, 64]
    assert "lh" not in hands


def test_split_hands_all_explicit_group_skips_heuristic_entirely():
    notes = [
        {"t": 0.0, "midi": 40, "sus": 0, "hand": "rh"},   # deliberately "wrong"
        {"t": 0.0, "midi": 72, "sus": 0, "hand": "lh"},   # crossing hands
    ]
    hands = nl.split_hands(notes)
    assert [n["midi"] for n in hands["rh"]] == [40]
    assert [n["midi"] for n in hands["lh"]] == [72]


def test_split_hands_junk_hand_values_fall_to_the_heuristic():
    for junk in ("LH", "left", "", True, 3, None):
        hands = nl.split_hands([{"t": 0.0, "midi": 72, "sus": 0, "hand": junk}])
        assert [n["midi"] for n in hands.get("rh", [])] == [72], repr(junk)


def test_decode_wire_notes_carries_hand_with_strict_enum():
    arr = {"notes": [
        {"t": 0.0, "s": 2, "f": 0, "sus": 0.5, "hand": "lh"},
        {"t": 0.5, "s": 2, "f": 12, "sus": 0.5, "hand": "LH"},   # junk case
        {"t": 1.0, "s": 2, "f": 14, "sus": 0.5},
    ], "chords": [
        {"t": 1.5, "notes": [{"s": 3, "f": 0, "sus": 0.5, "hand": "rh"}]},
    ]}
    decoded = nl.decode_wire_notes(arr)
    assert [n["hand"] for n in decoded] == ["lh", None, None, "rh"]


# ── Timing ───────────────────────────────────────────────────────────────────

def test_downbeat_times_filters_non_downbeats_and_sorts():
    beats = [{"time": 2.0, "measure": 1}, {"time": 0.5, "measure": -1},
             {"time": 0.0, "measure": 0}]
    assert nl.downbeat_times(beats) == [0.0, 2.0]


def test_measure_tempos_from_spacing_and_inherits_last():
    # 2.0 s per 4/4 bar → 120 BPM; last bar inherits previous.
    assert nl.measure_tempos([0.0, 2.0, 4.0], (4, 4)) == pytest.approx([120, 120, 120])
    assert nl.measure_tempos([0.0], (4, 4)) == [120.0]


def test_quantize_duration_floors_at_32nd_and_picks_dotted():
    qn = 60.0 / 120.0  # 0.5 s
    assert nl.quantize_duration(qn, 120.0) == (4, 0)          # quarter
    assert nl.quantize_duration(qn * 1.5, 120.0) == (4, 1)    # dotted quarter
    assert nl.quantize_duration(0.0001, 120.0) == (32, 0)     # floor


# ── Full assembly ────────────────────────────────────────────────────────────

def test_build_notation_returns_none_without_notes_or_downbeats():
    assert nl.build_notation([], _beats_4_4(1)) is None
    assert nl.build_notation(nl.decode_wire_notes({"notes": [_wire(0, 60)]}), []) is None


def test_build_notation_valid_payload_and_staves():
    notes = nl.decode_wire_notes({"notes": [
        _wire(0.0, 60, 0.5), _wire(0.0, 48, 0.5),  # both hands, beat 1
        _wire(0.5, 64, 0.5),
    ]})
    payload = nl.build_notation(notes, _beats_4_4(1), instrument="piano")
    ok, reason = notation.validate_notation(payload)
    assert ok, reason
    assert payload["instrument"] == "piano"
    assert {s["id"] for s in payload["staves"]} == {"rh", "lh"}
    assert payload["measures"][0]["ts"] == [4, 4]


def test_build_notation_marks_pickup_for_anacrusis():
    # An onset before the first downbeat (downbeat at t=0.5) → pickup measure.
    beats = [{"time": 0.5, "measure": 0}, {"time": 2.5, "measure": 1}]
    notes = nl.decode_wire_notes({"notes": [_wire(0.0, 67), _wire(0.5, 72)]})
    payload = nl.build_notation(notes, beats)
    assert payload["measures"][0].get("pickup") is True


def test_build_notation_ties_note_across_barline():
    # A whole-bar sustain that starts mid-bar must split into tied continuations.
    beats = _beats_4_4(2, bpm=120.0)  # 2 s per bar
    notes = nl.decode_wire_notes({"notes": [_wire(1.0, 48, sus=2.0)]})  # spans bar 1→2
    payload = nl.build_notation(notes, beats)
    ok, reason = notation.validate_notation(payload)
    assert ok, reason
    # The continuation in measure 2 must be tied (midi 48 → lh).
    m2 = payload["measures"][1]["staves"]["lh"]["voices"][0]["beats"]
    assert any(n.get("tied") for b in m2 for n in b["notes"])
