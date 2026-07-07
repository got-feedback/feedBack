"""Tests for `convert_drum_track_to_drumtab()` — the GP→drum_tab.json bridge.

The function is hard to fixture against a real .gp file (we'd need to ship a
test .gp with grace notes, ghost notes, hi-hat variants, and stamping), so we
mock `_build_tempo_map` / `_build_playback_schedule` and feed a synthetic
song object shaped like the bits of `guitarpro.Song` the converter actually
reads. The piece-mapping, velocity passthrough, ghost / flam / choke
extraction, and kit-legend building are all visible from this level.
"""

from __future__ import annotations

from types import SimpleNamespace

import guitarpro
import pytest

import gp2rs


# ── Test fakes ────────────────────────────────────────────────────────────────

# Use the real guitarpro.NoteType enum — the converter compares against
# `guitarpro.NoteType.rest` by identity, so substituting our own sentinel
# would mean `note.type == guitarpro.NoteType.rest` is always False and the
# rest-skip branch never gets tested.
_NT_NORMAL = guitarpro.NoteType.normal
_NT_REST = guitarpro.NoteType.rest


def _fake_effect(*, ghost=False, grace=False, staccato=False):
    """Minimal NoteEffect mock — converter only reads three booleans."""
    return SimpleNamespace(
        ghostNote=ghost,
        isGrace=grace,
        staccato=staccato,
    )


def _fake_note(*, string_idx: int, value: int = 0, velocity: int = 95,
               effect=None, ntype=None):
    """One drum note. `string_idx` selects the track string whose tuning
    value pins the MIDI piece; `value` adds to it (drums normally use 0)."""
    if effect is None:
        effect = _fake_effect()
    if ntype is None:
        ntype = _NT_NORMAL
    return SimpleNamespace(
        string=string_idx,
        value=value,
        velocity=velocity,
        effect=effect,
        type=ntype,
    )


def _fake_track(string_midis: list[int], beats: list[tuple[float, list]]):
    """Build a track with one measure, one voice, multiple beats.

    `string_midis` is GP-order (each entry pins one drum string to a MIDI
    note — that's how percussion tracks encode pieces).

    `beats` is [(beat_start_tick, [note, ...]), ...]. Tick values are
    treated as raw numbers by the patched `_tick_to_seconds` (identity
    scaling), so the tests pass plain floats here.
    """
    strings = [SimpleNamespace(number=i + 1, value=v)
               for i, v in enumerate(string_midis)]
    voice_beats = [
        SimpleNamespace(start=tick, notes=notes) for tick, notes in beats
    ]
    voice = SimpleNamespace(beats=voice_beats)
    measure = SimpleNamespace(voices=[voice])
    return SimpleNamespace(strings=strings, measures=[measure])


def _setup(monkeypatch):
    """Patch out the tempo / schedule heavy lifters so tests run without a
    real .gp file. Schedule yields one entry pointing at measure 0; tempo
    map is irrelevant because we also patch _tick_to_seconds to identity."""
    monkeypatch.setattr(gp2rs, "_build_tempo_map", lambda song: [])
    monkeypatch.setattr(
        gp2rs,
        "_build_playback_schedule",
        lambda song, tempo_map, expand_repeats: [
            gp2rs.PlaybackEntry(
                mh_index=0,
                pass_index=0,
                output_start_secs=0.0,
                mh_authored_start_secs=0.0,
                duration_secs=2.0,
            )
        ],
    )
    # Treat tick as "ticks at 1 tick/second" — pure identity scaling keeps
    # the assertion math obvious. Real conversion math is exercised by
    # test_gp2rs.py; here we only care about the drum-tab extraction.
    monkeypatch.setattr(gp2rs, "_tick_to_seconds", lambda tick, tempo_map: float(tick))


# ── Tests ─────────────────────────────────────────────────────────────────────

def test_basic_kick_snare_pattern(monkeypatch):
    """A simple kick/snare/HH-closed pattern round-trips with correct piece-
    ids and velocity preserved verbatim."""
    _setup(monkeypatch)
    # Strings 1-3 pin kick (36), snare (38), hh_closed (42).
    track = _fake_track(
        string_midis=[36, 38, 42],
        beats=[
            (0,    [_fake_note(string_idx=1, velocity=110)]),                 # kick
            (1.0,  [_fake_note(string_idx=2, velocity=92),                    # snare
                    _fake_note(string_idx=3, velocity=70)]),                  # hh_closed
        ],
    )
    song = SimpleNamespace(tracks=[track])

    out = gp2rs.convert_drum_track_to_drumtab(song, 0)
    assert out["version"] == 1
    assert out["name"] == "Drums"
    hits = out["hits"]
    assert [(h["t"], h["p"], h["v"]) for h in hits] == [
        (0.0, "kick", 110),
        (1.0, "snare", 92),
        (1.0, "hh_closed", 70),
    ]
    # Kit legend names every piece-id we emitted, deduplicated.
    assert {k["id"] for k in out["kit"]} == {"kick", "snare", "hh_closed"}


def test_ghost_note_flag(monkeypatch):
    _setup(monkeypatch)
    track = _fake_track(
        string_midis=[38],
        beats=[(0, [_fake_note(string_idx=1, velocity=40,
                               effect=_fake_effect(ghost=True))])],
    )
    song = SimpleNamespace(tracks=[track])
    hit = gp2rs.convert_drum_track_to_drumtab(song, 0)["hits"][0]
    assert hit["p"] == "snare"
    assert hit.get("g") is True


def test_flam_from_grace_note(monkeypatch):
    """A GP grace note on a drum lane → `f: true`. Drum charts use grace
    almost exclusively to mark flams."""
    _setup(monkeypatch)
    track = _fake_track(
        string_midis=[38],
        beats=[(0, [_fake_note(string_idx=1,
                               effect=_fake_effect(grace=True))])],
    )
    song = SimpleNamespace(tracks=[track])
    hit = gp2rs.convert_drum_track_to_drumtab(song, 0)["hits"][0]
    assert hit.get("f") is True


def test_choke_on_cymbal_only(monkeypatch):
    """Staccato on a cymbal piece becomes a short choke tail. Staccato on a
    drum piece (snare/tom/kick) is ignored — drums can't be choked."""
    _setup(monkeypatch)
    # String 1 → crash_r (57), string 2 → snare (38).
    track = _fake_track(
        string_midis=[57, 38],
        beats=[
            (0,   [_fake_note(string_idx=1, effect=_fake_effect(staccato=True))]),
            (1.0, [_fake_note(string_idx=2, effect=_fake_effect(staccato=True))]),
        ],
    )
    song = SimpleNamespace(tracks=[track])
    hits = gp2rs.convert_drum_track_to_drumtab(song, 0)["hits"]
    assert hits[0]["p"] == "crash_r"
    assert hits[0].get("k") == pytest.approx(0.08)
    assert hits[1]["p"] == "snare"
    assert "k" not in hits[1]


def test_hihat_openness_from_midi_note(monkeypatch):
    """GP encodes closed/open/pedal hi-hat on distinct MIDI notes (42/46/44).
    The drum-tab path must surface them as three distinct piece-ids so hit
    detection in the drums plugin can reject a closed-hat strike on an open-
    hat note."""
    _setup(monkeypatch)
    # Strings pin closed/open/pedal hi-hat.
    track = _fake_track(
        string_midis=[42, 46, 44],
        beats=[
            (0,    [_fake_note(string_idx=1)]),  # closed
            (1.0,  [_fake_note(string_idx=2)]),  # open
            (2.0,  [_fake_note(string_idx=3)]),  # pedal
        ],
    )
    song = SimpleNamespace(tracks=[track])
    pids = [h["p"] for h in gp2rs.convert_drum_track_to_drumtab(song, 0)["hits"]]
    assert pids == ["hh_closed", "hh_open", "hh_pedal"]


def test_rest_notes_dropped(monkeypatch):
    _setup(monkeypatch)
    track = _fake_track(
        string_midis=[36],
        beats=[(0, [_fake_note(string_idx=1, ntype=_NT_REST)])],
    )
    song = SimpleNamespace(tracks=[track])
    assert gp2rs.convert_drum_track_to_drumtab(song, 0)["hits"] == []


def test_unmapped_percussion_silently_skipped(monkeypatch):
    """Cowbell (MIDI 56) isn't in the vocab — must be skipped, not crash."""
    _setup(monkeypatch)
    track = _fake_track(
        string_midis=[56, 36],
        beats=[
            (0,   [_fake_note(string_idx=1)]),   # cowbell — skip
            (1.0, [_fake_note(string_idx=2)]),   # kick — keep
        ],
    )
    song = SimpleNamespace(tracks=[track])
    hits = gp2rs.convert_drum_track_to_drumtab(song, 0)["hits"]
    assert len(hits) == 1
    assert hits[0]["p"] == "kick"


def test_unmapped_percussion_reported_via_out_unmapped(monkeypatch):
    """Opting in via out_unmapped records the dropped MIDI notes (count +
    times + velocities) so a caller can surface a warning / mapping UI."""
    _setup(monkeypatch)
    track = _fake_track(
        string_midis=[56, 36, 54],
        beats=[
            (0.0, [_fake_note(string_idx=1, velocity=88)]),  # cowbell — drop
            (1.0, [_fake_note(string_idx=2)]),               # kick — keep
            (1.5, [_fake_note(string_idx=3, velocity=25)]),  # tambourine — drop
            (2.0, [_fake_note(string_idx=1, velocity=44)]),  # cowbell again — drop
        ],
    )
    song = SimpleNamespace(tracks=[track])
    unmapped: dict[int, dict] = {}
    hits = gp2rs.convert_drum_track_to_drumtab(
        song, 0, out_unmapped=unmapped)["hits"]
    # Only the kick survives.
    assert [h["p"] for h in hits] == ["kick"]
    # Both unmapped MIDIs are reported with correct counts.
    assert set(unmapped.keys()) == {56, 54}
    assert unmapped[56]["count"] == 2
    assert unmapped[54]["count"] == 1
    # Times are captured (rounded to 3 dp).
    assert unmapped[56]["times"] == [0.0, 2.0]
    assert unmapped[54]["times"] == [1.5]
    # Velocities ride index-aligned with times — the mapping UI can carry
    # the source dynamics through instead of flattening to a default.
    assert unmapped[56]["velocities"] == [88, 44]
    assert unmapped[54]["velocities"] == [25]


def test_unmapped_velocities_sort_in_lockstep_with_times(monkeypatch):
    """Multi-voice measures can capture times out of order; the final sort
    must reorder velocities WITH their times, not leave them behind."""
    _setup(monkeypatch)
    track = _fake_track(
        string_midis=[56],
        beats=[
            # Deliberately reversed chronology within the measure.
            (2.0, [_fake_note(string_idx=1, velocity=44)]),
            (0.0, [_fake_note(string_idx=1, velocity=88)]),
        ],
    )
    song = SimpleNamespace(tracks=[track])
    unmapped: dict[int, dict] = {}
    gp2rs.convert_drum_track_to_drumtab(song, 0, out_unmapped=unmapped)
    assert unmapped[56]["times"] == [0.0, 2.0]
    assert unmapped[56]["velocities"] == [88, 44], \
        "velocity must follow its time through the sort"


def test_unmapped_out_of_range_velocity_falls_back_to_default(monkeypatch):
    """A corrupt/zero GP velocity records the 100 import default rather
    than poisoning the aligned list."""
    _setup(monkeypatch)
    track = _fake_track(
        string_midis=[56],
        beats=[(0.0, [_fake_note(string_idx=1, velocity=0)])],
    )
    song = SimpleNamespace(tracks=[track])
    unmapped: dict[int, dict] = {}
    gp2rs.convert_drum_track_to_drumtab(song, 0, out_unmapped=unmapped)
    assert unmapped[56]["velocities"] == [100]


def test_zero_velocity_omitted_from_wire(monkeypatch):
    """Velocity outside 1-127 must be dropped from the hit so the wire format
    stays clean. A corrupt GP file shouldn't propagate `v: 0` downstream."""
    _setup(monkeypatch)
    track = _fake_track(
        string_midis=[36],
        beats=[(0, [_fake_note(string_idx=1, velocity=0)])],
    )
    song = SimpleNamespace(tracks=[track])
    hit = gp2rs.convert_drum_track_to_drumtab(song, 0)["hits"][0]
    assert "v" not in hit


def test_hits_sorted_by_time(monkeypatch):
    """Out-of-order beats (from a multi-voice measure) come back sorted."""
    _setup(monkeypatch)
    track = _fake_track(
        string_midis=[36, 38],
        beats=[
            (2.0, [_fake_note(string_idx=1)]),   # later kick
            (0.0, [_fake_note(string_idx=2)]),   # earlier snare
            (1.0, [_fake_note(string_idx=1)]),
        ],
    )
    song = SimpleNamespace(tracks=[track])
    hits = gp2rs.convert_drum_track_to_drumtab(song, 0)["hits"]
    assert [h["t"] for h in hits] == [0.0, 1.0, 2.0]


def test_custom_arrangement_name_used(monkeypatch):
    _setup(monkeypatch)
    track = _fake_track(string_midis=[36], beats=[(0, [_fake_note(string_idx=1)])])
    song = SimpleNamespace(tracks=[track])
    out = gp2rs.convert_drum_track_to_drumtab(song, 0, arrangement_name="Verse Drums")
    assert out["name"] == "Verse Drums"
