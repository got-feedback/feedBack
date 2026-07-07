"""Tests for `list_drum_tracks` and `convert_drum_track_from_midi`.

Builds synthetic MIDI files in-memory (no fixtures on disk) and exercises
the drum-tab extraction: channel-9 listing, piece resolution, ghost-velocity
flag, flam-window collapse, choke-window note-off, and tempo-aware timing.
"""

from __future__ import annotations

import mido

from midi_import import list_drum_tracks, convert_drum_track_from_midi


def _save(mid: mido.MidiFile, tmp_path, name: str = "drums.mid") -> str:
    p = tmp_path / name
    mid.save(str(p))
    return str(p)


# ── list_drum_tracks ──────────────────────────────────────────────────────────

def test_list_drum_tracks_skips_tracks_without_channel9(tmp_path):
    mid = mido.MidiFile(type=1, ticks_per_beat=480)
    piano = mido.MidiTrack()
    mid.tracks.append(piano)
    piano.append(mido.Message("note_on",  channel=0, note=60, velocity=64, time=0))
    piano.append(mido.Message("note_off", channel=0, note=60, velocity=0, time=480))
    assert list_drum_tracks(_save(mid, tmp_path)) == []


def test_list_drum_tracks_returns_channel9_entry(tmp_path):
    mid = mido.MidiFile(type=1, ticks_per_beat=480)
    track = mido.MidiTrack()
    mid.tracks.append(track)
    track.append(mido.MetaMessage("track_name", name="Drums", time=0))
    track.append(mido.Message("note_on",  channel=9, note=36, velocity=100, time=0))
    track.append(mido.Message("note_off", channel=9, note=36, velocity=0, time=120))
    track.append(mido.Message("note_on",  channel=9, note=38, velocity=92, time=0))
    track.append(mido.Message("note_off", channel=9, note=38, velocity=0, time=120))
    tracks = list_drum_tracks(_save(mid, tmp_path))
    assert len(tracks) == 1
    t = tracks[0]
    assert t["channel"] == 9
    assert t["channel_filter"] == 9
    assert t["is_drums"] is True
    assert t["notes"] == 2
    assert t["name"] == "Drums"


def test_list_drum_tracks_surfaces_format0_mixed_track(tmp_path):
    """A format-0 track containing both piano (ch0) and drum (ch9) events
    must surface once — list_midi_tracks already handles the piano half."""
    mid = mido.MidiFile(type=0, ticks_per_beat=480)
    track = mido.MidiTrack()
    mid.tracks.append(track)
    track.append(mido.Message("note_on",  channel=0, note=60, velocity=64, time=0))
    track.append(mido.Message("note_off", channel=0, note=60, velocity=0, time=480))
    track.append(mido.Message("note_on",  channel=9, note=36, velocity=100, time=0))
    track.append(mido.Message("note_off", channel=9, note=36, velocity=0, time=120))
    drums = list_drum_tracks(_save(mid, tmp_path))
    assert len(drums) == 1
    assert drums[0]["notes"] == 1


# ── convert_drum_track_from_midi ──────────────────────────────────────────────

def test_basic_conversion_piece_and_velocity(tmp_path):
    mid = mido.MidiFile(type=1, ticks_per_beat=480)
    track = mido.MidiTrack()
    mid.tracks.append(track)
    track.append(mido.MetaMessage("set_tempo", tempo=500000, time=0))  # 120 BPM
    track.append(mido.Message("note_on",  channel=9, note=36, velocity=110, time=0))     # kick @ 0s
    track.append(mido.Message("note_off", channel=9, note=36, velocity=0,  time=240))    # 0.25s
    track.append(mido.Message("note_on",  channel=9, note=38, velocity=92,  time=240))   # snare @ 0.5s
    track.append(mido.Message("note_off", channel=9, note=38, velocity=0,  time=240))

    out = convert_drum_track_from_midi(_save(mid, tmp_path), 0)
    assert out["version"] == 1
    hits = out["hits"]
    assert [(h["t"], h["p"], h["v"]) for h in hits] == [
        (0.0, "kick", 110),
        (0.5, "snare", 92),
    ]
    assert {k["id"] for k in out["kit"]} == {"kick", "snare"}


def test_ghost_velocity_flag(tmp_path):
    """Velocity below 40 marks the hit as a ghost note."""
    mid = mido.MidiFile(type=1, ticks_per_beat=480)
    track = mido.MidiTrack()
    mid.tracks.append(track)
    track.append(mido.MetaMessage("set_tempo", tempo=500000, time=0))
    track.append(mido.Message("note_on",  channel=9, note=38, velocity=30, time=0))
    track.append(mido.Message("note_off", channel=9, note=38, velocity=0,  time=120))
    hits = convert_drum_track_from_midi(_save(mid, tmp_path), 0)["hits"]
    assert hits[0].get("g") is True


def test_flam_collapse_within_30ms(tmp_path):
    """Two snare hits 20 ms apart collapse into one flam — the louder
    survives, marked `f: true`."""
    mid = mido.MidiFile(type=1, ticks_per_beat=480)
    track = mido.MidiTrack()
    mid.tracks.append(track)
    track.append(mido.MetaMessage("set_tempo", tempo=500000, time=0))  # 120 BPM, 480 tpqn → 1 tick = 1.0416ms
    # ghost lead-in at t=0 (≈10 ticks ≈ 0.01s would be too small; use 20ms = ~19 ticks),
    # then main hit at t≈20ms after that.
    # 480 tpqn at 120 BPM → 1 tick ≈ 1.0417 ms.  20 ms ≈ 19 ticks.
    track.append(mido.Message("note_on",  channel=9, note=38, velocity=30, time=0))    # ghost
    track.append(mido.Message("note_off", channel=9, note=38, velocity=0,  time=5))
    track.append(mido.Message("note_on",  channel=9, note=38, velocity=110, time=10))  # main, 15 ticks after ghost onset → ~15.6ms (1 tick ≈ 1.04ms at 120BPM/480tpqn)
    track.append(mido.Message("note_off", channel=9, note=38, velocity=0,  time=120))
    out = convert_drum_track_from_midi(_save(mid, tmp_path), 0)["hits"]
    assert len(out) == 1, f"expected flam collapse, got {out}"
    assert out[0]["p"] == "snare"
    assert out[0]["v"] == 110
    assert out[0].get("f") is True


def test_flam_window_does_not_collapse_unrelated_pieces(tmp_path):
    """Snare + kick 10 ms apart must NOT collapse — flams only apply to the
    same piece (drummers don't flam across pieces)."""
    mid = mido.MidiFile(type=1, ticks_per_beat=480)
    track = mido.MidiTrack()
    mid.tracks.append(track)
    track.append(mido.MetaMessage("set_tempo", tempo=500000, time=0))
    track.append(mido.Message("note_on",  channel=9, note=38, velocity=100, time=0))   # snare
    track.append(mido.Message("note_off", channel=9, note=38, velocity=0,  time=5))
    track.append(mido.Message("note_on",  channel=9, note=36, velocity=100, time=5))   # kick
    track.append(mido.Message("note_off", channel=9, note=36, velocity=0,  time=120))
    hits = convert_drum_track_from_midi(_save(mid, tmp_path), 0)["hits"]
    assert {h["p"] for h in hits} == {"snare", "kick"}
    assert all("f" not in h for h in hits)


def test_choke_on_short_cymbal_note(tmp_path):
    """A crash with a note-off arriving 80 ms after note-on is treated as a
    cymbal choke; non-cymbal pieces don't get a `k` field even for short
    durations."""
    mid = mido.MidiFile(type=1, ticks_per_beat=480)
    track = mido.MidiTrack()
    mid.tracks.append(track)
    track.append(mido.MetaMessage("set_tempo", tempo=500000, time=0))  # 120 BPM → 1 tick = 1.0417ms
    # Crash @0, off ~80ms (=76 ticks)
    track.append(mido.Message("note_on",  channel=9, note=49, velocity=120, time=0))
    track.append(mido.Message("note_off", channel=9, note=49, velocity=0,  time=77))
    # Snare @t≈0.1s with a short note-off (must not produce k).
    track.append(mido.Message("note_on",  channel=9, note=38, velocity=100, time=0))
    track.append(mido.Message("note_off", channel=9, note=38, velocity=0,  time=50))
    out = convert_drum_track_from_midi(_save(mid, tmp_path), 0)["hits"]
    crash = next(h for h in out if h["p"] == "crash_l")
    snare = next(h for h in out if h["p"] == "snare")
    assert "k" in crash and 0.0 < crash["k"] <= 0.12
    assert "k" not in snare


def test_choke_window_does_not_fire_for_long_cymbal_sustain(tmp_path):
    """A crash held for 500 ms is a regular open ring, not a choke."""
    mid = mido.MidiFile(type=1, ticks_per_beat=480)
    track = mido.MidiTrack()
    mid.tracks.append(track)
    track.append(mido.MetaMessage("set_tempo", tempo=500000, time=0))
    # 500ms ≈ 480 ticks at 120 BPM
    track.append(mido.Message("note_on",  channel=9, note=49, velocity=120, time=0))
    track.append(mido.Message("note_off", channel=9, note=49, velocity=0,  time=480))
    hit = convert_drum_track_from_midi(_save(mid, tmp_path), 0)["hits"][0]
    assert "k" not in hit


def test_unmapped_drum_note_skipped(tmp_path):
    """Cowbell (MIDI 56) isn't in the vocab — must be skipped."""
    mid = mido.MidiFile(type=1, ticks_per_beat=480)
    track = mido.MidiTrack()
    mid.tracks.append(track)
    track.append(mido.MetaMessage("set_tempo", tempo=500000, time=0))
    track.append(mido.Message("note_on",  channel=9, note=56, velocity=100, time=0))   # cowbell — drop
    track.append(mido.Message("note_off", channel=9, note=56, velocity=0,  time=240))
    track.append(mido.Message("note_on",  channel=9, note=36, velocity=100, time=240))  # kick — keep
    track.append(mido.Message("note_off", channel=9, note=36, velocity=0,  time=120))
    hits = convert_drum_track_from_midi(_save(mid, tmp_path), 0)["hits"]
    assert len(hits) == 1
    assert hits[0]["p"] == "kick"


def test_unmapped_drum_note_reported_via_out_unmapped(tmp_path):
    """Opting in via out_unmapped records the dropped MIDI notes (count +
    times + velocities) so a caller can surface a warning / mapping UI."""
    mid = mido.MidiFile(type=1, ticks_per_beat=480)
    track = mido.MidiTrack()
    mid.tracks.append(track)
    track.append(mido.MetaMessage("set_tempo", tempo=500000, time=0))
    track.append(mido.Message("note_on",  channel=9, note=56, velocity=88,  time=0))    # cowbell — drop
    track.append(mido.Message("note_off", channel=9, note=56, velocity=0,   time=240))
    track.append(mido.Message("note_on",  channel=9, note=36, velocity=100, time=0))    # kick — keep
    track.append(mido.Message("note_off", channel=9, note=36, velocity=0,   time=240))
    track.append(mido.Message("note_on",  channel=9, note=54, velocity=25,  time=0))    # tambourine — drop
    track.append(mido.Message("note_off", channel=9, note=54, velocity=0,   time=240))
    track.append(mido.Message("note_on",  channel=9, note=56, velocity=44,  time=0))    # cowbell again — drop
    track.append(mido.Message("note_off", channel=9, note=56, velocity=0,   time=240))

    unmapped: dict[int, dict] = {}
    hits = convert_drum_track_from_midi(
        _save(mid, tmp_path), 0, out_unmapped=unmapped)["hits"]
    assert [h["p"] for h in hits] == ["kick"]
    assert set(unmapped.keys()) == {56, 54}
    assert unmapped[56]["count"] == 2
    assert unmapped[54]["count"] == 1
    # Each unmapped MIDI carries the times at which it fired (rounded 3 dp).
    assert all(isinstance(t, float) for t in unmapped[56]["times"])
    assert len(unmapped[56]["times"]) == 2
    # Velocities ride index-aligned with times — the mapping UI can carry
    # the source dynamics through instead of flattening to a default.
    assert unmapped[56]["velocities"] == [88, 44]
    assert unmapped[54]["velocities"] == [25]


def test_non_channel9_events_ignored(tmp_path):
    """A note_on on channel 0 with MIDI 36 is NOT a kick — the converter
    must scope to channel 9."""
    mid = mido.MidiFile(type=1, ticks_per_beat=480)
    track = mido.MidiTrack()
    mid.tracks.append(track)
    track.append(mido.MetaMessage("set_tempo", tempo=500000, time=0))
    track.append(mido.Message("note_on",  channel=0, note=36, velocity=100, time=0))
    track.append(mido.Message("note_off", channel=0, note=36, velocity=0,  time=240))
    assert convert_drum_track_from_midi(_save(mid, tmp_path), 0)["hits"] == []


def test_hihat_openness_preserved(tmp_path):
    """Three hi-hat MIDI notes round-trip as three distinct piece-ids — the
    drums plugin's hit detector relies on this to reject closed-hat strikes
    on open-hat notes."""
    mid = mido.MidiFile(type=1, ticks_per_beat=480)
    track = mido.MidiTrack()
    mid.tracks.append(track)
    track.append(mido.MetaMessage("set_tempo", tempo=500000, time=0))
    for offset, midi_n in enumerate((42, 46, 44)):
        track.append(mido.Message("note_on",  channel=9, note=midi_n, velocity=80,
                                  time=480 if offset else 0))
        track.append(mido.Message("note_off", channel=9, note=midi_n, velocity=0, time=120))
    pids = [h["p"] for h in convert_drum_track_from_midi(_save(mid, tmp_path), 0)["hits"]]
    assert pids == ["hh_closed", "hh_open", "hh_pedal"]
