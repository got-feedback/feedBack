"""Tests for lib/midi_import.py — convert_midi_tempo_map.

The note converters always computed a tempo-aware tick→seconds map internally
(to bake note times) and then threw it away — and never read time_signature
meta at all — so every MIDI import landed with no bars, no measures, and an
implied 4/4 regardless of the file. convert_midi_tempo_map extracts the grid:
tempos, time signatures (song-timeline shape), and a full beat grid on the
editor's row shape (numbered downbeats with a `den` hint, `-1` sub-beats).

Every test drives the REAL function against a real .mid built in-memory with
mido and saved to tmp_path — no stubs, adversarial inputs included (type-2
scoping, mid-bar signatures, duplicate meta ticks, empty files, long files
for rounding drift).

Run: pytest tests/test_midi_tempo_map.py -v
"""

import mido
import pytest

from midi_import import _TEMPO_MAP_MAX_BARS, convert_midi_tempo_map


# ── helpers ───────────────────────────────────────────────────────────────────

def _save(mid: mido.MidiFile, tmp_path, name: str = "t.mid") -> str:
    p = tmp_path / name
    mid.save(str(p))
    return str(p)


def _note_pair(track, pitch=60, at=0, dur=240):
    track.append(mido.Message("note_on", note=pitch, velocity=90, time=at))
    track.append(mido.Message("note_off", note=pitch, velocity=0, time=dur))


def _downbeats(result):
    return [b for b in result["beats"] if b["measure"] > 0]


def _subbeats(result):
    return [b for b in result["beats"] if b["measure"] == -1]


# ── the plain case ────────────────────────────────────────────────────────────

def test_default_grid_is_120_bpm_four_four(tmp_path):
    mid = mido.MidiFile(ticks_per_beat=480)
    tr = mido.MidiTrack(); mid.tracks.append(tr)
    _note_pair(tr, at=0, dur=480 * 8)          # two 4/4 bars of content
    res = convert_midi_tempo_map(_save(mid, tmp_path))
    assert res["tempos"] == [{"time": 0.0, "bpm": 120.0}]
    assert res["time_signatures"] == [{"time": 0.0, "ts": [4, 4]}]
    dbs = _downbeats(res)
    assert [d["measure"] for d in dbs] == [1, 2]
    assert [d["time"] for d in dbs] == [0.0, 2.0]      # 4 beats at 0.5 s
    assert all(d["den"] == 4 for d in dbs)
    # 3 interior beats per full bar at 0.5 s spacing.
    assert [b["time"] for b in _subbeats(res)][:3] == [0.5, 1.0, 1.5]


# ── tempo handling ────────────────────────────────────────────────────────────

def test_tempo_change_bends_the_grid(tmp_path):
    mid = mido.MidiFile(ticks_per_beat=480)
    meta = mido.MidiTrack(); mid.tracks.append(meta)
    meta.append(mido.MetaMessage("set_tempo", tempo=500000, time=0))       # 120
    meta.append(mido.MetaMessage("set_tempo", tempo=250000, time=480 * 4)) # 240 at bar 2
    notes = mido.MidiTrack(); mid.tracks.append(notes)
    _note_pair(notes, at=0, dur=480 * 8)
    res = convert_midi_tempo_map(_save(mid, tmp_path))
    assert [t["bpm"] for t in res["tempos"]] == [120.0, 240.0]
    dbs = _downbeats(res)
    # Bar 1 spans 2.0 s at 120; bar 2 starts at 2.0 and its beats halve.
    assert dbs[0]["time"] == 0.0 and dbs[1]["time"] == 2.0
    bar2_subs = [b["time"] for b in _subbeats(res) if b["time"] > 2.0]
    assert bar2_subs[:3] == [2.25, 2.5, 2.75]

def test_rounding_does_not_accumulate_over_a_long_file(tmp_path):
    # 500 bars at 120 BPM: beat times must stay exactly on the 0.5 s lattice
    # (absolute-tick computation — never beat N derived from beat N-1).
    mid = mido.MidiFile(ticks_per_beat=480)
    tr = mido.MidiTrack(); mid.tracks.append(tr)
    _note_pair(tr, at=0, dur=480 * 4 * 500)
    res = convert_midi_tempo_map(_save(mid, tmp_path))
    dbs = _downbeats(res)
    assert len(dbs) == 500
    assert dbs[-1]["time"] == pytest.approx((500 - 1) * 2.0, abs=0.0005)
    assert dbs[250]["time"] == pytest.approx(250 * 2.0, abs=0.0005)


# ── time signatures (the previously-unread meta) ─────────────────────────────

def test_time_signature_changes_shape_the_bars(tmp_path):
    mid = mido.MidiFile(ticks_per_beat=480)
    meta = mido.MidiTrack(); mid.tracks.append(meta)
    meta.append(mido.MetaMessage("time_signature", numerator=4, denominator=4, time=0))
    meta.append(mido.MetaMessage("time_signature", numerator=3, denominator=4, time=480 * 4))
    notes = mido.MidiTrack(); mid.tracks.append(notes)
    _note_pair(notes, at=0, dur=480 * 10)      # 4/4 bar + two 3/4 bars
    res = convert_midi_tempo_map(_save(mid, tmp_path))
    assert [s["ts"] for s in res["time_signatures"]] == [[4, 4], [3, 4]]
    dbs = _downbeats(res)
    assert [d["time"] for d in dbs] == [0.0, 2.0, 3.5]   # 3/4 bars are 1.5 s
    # Bar 2 has exactly two interior beats.
    bar2 = [b for b in res["beats"] if 2.0 < b["time"] < 3.5]
    assert [b["measure"] for b in bar2] == [-1, -1]

def test_six_eight_uses_eighth_note_rows(tmp_path):
    mid = mido.MidiFile(ticks_per_beat=480)
    meta = mido.MidiTrack(); mid.tracks.append(meta)
    meta.append(mido.MetaMessage("time_signature", numerator=6, denominator=8, time=0))
    notes = mido.MidiTrack(); mid.tracks.append(notes)
    _note_pair(notes, at=0, dur=480 * 3)       # one full 6/8 bar
    res = convert_midi_tempo_map(_save(mid, tmp_path))
    dbs = _downbeats(res)
    assert dbs[0]["den"] == 8
    bar1 = [b["time"] for b in res["beats"] if b["time"] < 1.5]
    # Six eighth-note rows at 120 BPM (quarter = 0.5 s ⇒ eighth = 0.25 s).
    assert bar1 == [0.0, 0.25, 0.5, 0.75, 1.0, 1.25]

def test_mid_bar_signature_applies_at_the_next_boundary(tmp_path):
    mid = mido.MidiFile(ticks_per_beat=480)
    meta = mido.MidiTrack(); mid.tracks.append(meta)
    # Ill-formed: 3/4 lands halfway through bar 1.
    meta.append(mido.MetaMessage("time_signature", numerator=3, denominator=4, time=480 * 2))
    notes = mido.MidiTrack(); mid.tracks.append(notes)
    _note_pair(notes, at=0, dur=480 * 8)
    res = convert_midi_tempo_map(_save(mid, tmp_path))
    dbs = _downbeats(res)
    # Bar 1 stays 4/4 (2.0 s); bar 2 onward is 3/4.
    assert dbs[0]["time"] == 0.0 and dbs[0]["den"] == 4
    # Bar 2 is the 3/4 bar, but its denominator is still 4 (3 quarter notes).
    assert dbs[1]["time"] == 2.0 and dbs[1]["den"] == 4
    assert dbs[2]["time"] - dbs[1]["time"] == pytest.approx(1.5, abs=0.002)

def test_duplicate_signature_ticks_last_wins(tmp_path):
    mid = mido.MidiFile(ticks_per_beat=480)
    meta = mido.MidiTrack(); mid.tracks.append(meta)
    meta.append(mido.MetaMessage("time_signature", numerator=4, denominator=4, time=0))
    meta.append(mido.MetaMessage("time_signature", numerator=7, denominator=8, time=0))
    notes = mido.MidiTrack(); mid.tracks.append(notes)
    _note_pair(notes, at=0, dur=480 * 4)
    res = convert_midi_tempo_map(_save(mid, tmp_path))
    assert res["time_signatures"][-1]["ts"] == [7, 8]
    assert _downbeats(res)[0]["den"] == 8


# ── SMF type scoping (adversarial) ───────────────────────────────────────────

def test_type2_reads_meta_from_the_chosen_track_only(tmp_path):
    mid = mido.MidiFile(ticks_per_beat=480, type=2)
    bogus = mido.MidiTrack(); mid.tracks.append(bogus)
    bogus.append(mido.MetaMessage("set_tempo", tempo=100000, time=0))       # 600 BPM
    bogus.append(mido.MetaMessage("time_signature", numerator=7, denominator=8, time=0))
    _note_pair(bogus, at=0, dur=480)
    real = mido.MidiTrack(); mid.tracks.append(real)
    real.append(mido.MetaMessage("set_tempo", tempo=500000, time=0))        # 120 BPM
    _note_pair(real, at=0, dur=480 * 4)
    res = convert_midi_tempo_map(_save(mid, tmp_path), track_index=1)
    # The bogus track's 600 BPM / 7-8 never leak into track 1's grid.
    assert [t["bpm"] for t in res["tempos"]] == [120.0]
    assert res["time_signatures"] == [{"time": 0.0, "ts": [4, 4]}]
    assert _downbeats(res)[0]["den"] == 4


# ── degenerate inputs ────────────────────────────────────────────────────────

def test_empty_file_yields_empty_beats_but_valid_shape(tmp_path):
    mid = mido.MidiFile(ticks_per_beat=480)
    mid.tracks.append(mido.MidiTrack())
    res = convert_midi_tempo_map(_save(mid, tmp_path))
    assert res["beats"] == []
    assert res["tempos"] == [{"time": 0.0, "bpm": 120.0}]
    assert res["time_signatures"] == [{"time": 0.0, "ts": [4, 4]}]

def test_grid_covers_all_notes_and_stops_after_them(tmp_path):
    mid = mido.MidiFile(ticks_per_beat=480)
    tr = mido.MidiTrack(); mid.tracks.append(tr)
    _note_pair(tr, at=480 * 5, dur=480)        # note inside bar 2 only
    res = convert_midi_tempo_map(_save(mid, tmp_path))
    dbs = _downbeats(res)
    assert dbs[0]["time"] == 0.0, "grid starts at zero (SMF convention)"
    assert dbs[-1]["measure"] == 2
    assert all(b["time"] <= 3.0 + 1e-9 for b in res["beats"]), \
        "no beats past the end of musical content"


@pytest.mark.parametrize("division", [0, -1, -25600])
def test_non_positive_division_header_does_not_crash(tmp_path, division):
    # A malformed header reloads with ticks_per_beat == 0; a true SMPTE-division
    # file reloads negative (mido reads the division as a signed short). Either
    # way the tick→seconds closure would divide by a non-positive number —
    # raising ZeroDivisionError (0) or walking off into negative times
    # (negative) — without the header fallback. The grid must still come out on
    # a sane, bounded 4/4 / 120-BPM default.
    mid = mido.MidiFile(ticks_per_beat=division)
    tr = mido.MidiTrack(); mid.tracks.append(tr)
    _note_pair(tr, at=0, dur=480 * 8)
    assert mido.MidiFile(_save(mid, tmp_path)).ticks_per_beat == division  # precondition
    res = convert_midi_tempo_map(_save(mid, tmp_path))
    assert res["tempos"] == [{"time": 0.0, "bpm": 120.0}]
    assert res["time_signatures"] == [{"time": 0.0, "ts": [4, 4]}]
    dbs = _downbeats(res)
    assert [d["measure"] for d in dbs] == [1, 2]
    assert all(isinstance(b["time"], float) and b["time"] >= 0.0
               for b in res["beats"])


def test_first_tempo_after_start_seeds_default_120_at_zero(tmp_path):
    # First (and only) set_tempo lands at bar 2. The head of the song already
    # played at the MIDI default of 120 BPM, so the tempos sidecar must open
    # with a 120-BPM row at time 0 — symmetric with the 4/4 signature default.
    mid = mido.MidiFile(ticks_per_beat=480)
    meta = mido.MidiTrack(); mid.tracks.append(meta)
    meta.append(mido.MetaMessage("set_tempo", tempo=250000, time=480 * 4))   # 240 at bar 2
    notes = mido.MidiTrack(); mid.tracks.append(notes)
    _note_pair(notes, at=0, dur=480 * 8)
    res = convert_midi_tempo_map(_save(mid, tmp_path))
    assert res["tempos"][0] == {"time": 0.0, "bpm": 120.0}
    assert res["tempos"][1] == {"time": 2.0, "bpm": 240.0}
    # The seeded default actually matches the grid the head of the song used.
    assert _downbeats(res)[0]["time"] == 0.0


def test_type0_single_track_carries_tempo_timesig_and_notes(tmp_path):
    # Explicit SMF format 0: one track holds tempo + signature + notes.
    mid = mido.MidiFile(ticks_per_beat=480, type=0)
    tr = mido.MidiTrack(); mid.tracks.append(tr)
    tr.append(mido.MetaMessage("set_tempo", tempo=500000, time=0))            # 120
    tr.append(mido.MetaMessage("time_signature", numerator=3, denominator=4, time=0))
    _note_pair(tr, at=0, dur=480 * 6)          # two 3/4 bars
    res = convert_midi_tempo_map(_save(mid, tmp_path))
    assert mido.MidiFile(_save(mid, tmp_path)).type == 0  # precondition
    assert res["tempos"] == [{"time": 0.0, "bpm": 120.0}]
    assert res["time_signatures"] == [{"time": 0.0, "ts": [3, 4]}]
    dbs = _downbeats(res)
    assert [d["measure"] for d in dbs] == [1, 2]
    assert [d["time"] for d in dbs] == [0.0, 1.5]     # 3/4 bar = 1.5 s at 120
    assert all(d["den"] == 4 for d in dbs)


def test_max_bars_safety_valve_caps_the_walk(tmp_path):
    # A note one bar past the cap must not blow the walk past its ceiling.
    mid = mido.MidiFile(ticks_per_beat=480)
    tr = mido.MidiTrack(); mid.tracks.append(tr)
    _note_pair(tr, at=0, dur=480 * 4 * (_TEMPO_MAP_MAX_BARS + 1))
    res = convert_midi_tempo_map(_save(mid, tmp_path))
    dbs = _downbeats(res)
    assert len(dbs) == _TEMPO_MAP_MAX_BARS
    assert dbs[-1]["measure"] == _TEMPO_MAP_MAX_BARS
