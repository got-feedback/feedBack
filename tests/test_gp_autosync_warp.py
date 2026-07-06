"""Tests for the librosa-free piecewise time-warp helpers in lib/gp_autosync.py
(bar_start_times / build_warp_anchors / warp_time / warp_song_times /
gp_has_expandable_repeats) plus refine_sync's pure fallbacks.

Fixture-free, matching tests/test_gp_audio_sync.py: every test drives a pure
helper with hand-built inputs (in-memory GPIF zips, synthetic sync points,
hand-rolled Song objects). The librosa-backed sweep inside refine_sync needs
real audio and is covered by manual validation in the PR.
"""

import io
import zipfile
import xml.etree.ElementTree as ET

import pytest

import gp_autosync as ga
from gp8_audio_sync import GpSyncData, SyncPoint
from song import (
    Anchor,
    Arrangement,
    Beat,
    Chord,
    HandShape,
    Note,
    Phrase,
    PhraseLevel,
    Section,
    Song,
)


# ── helpers ───────────────────────────────────────────────────────────────────

def _gpif_zip(gpif_xml: str) -> bytes:
    """Build an in-memory .gp container holding the given score.gpif."""
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as zf:
        zf.writestr("Content/score.gpif", gpif_xml)
    return buf.getvalue()


def _gpif(tempo_autos: list[tuple[int, float]], bar_sigs: list[str]) -> str:
    autos = "".join(
        f"<Automation><Type>Tempo</Type><Bar>{bar}</Bar>"
        f"<Value>{bpm} 2</Value></Automation>"
        for bar, bpm in tempo_autos
    )
    bars = "".join(f"<MasterBar><Time>{sig}</Time></MasterBar>" for sig in bar_sigs)
    return (
        "<GPIF><MasterTrack><Automations>"
        f"{autos}</Automations></MasterTrack>"
        f"<MasterBars>{bars}</MasterBars></GPIF>"
    )


def _sp(bar, t, mod=120.0, orig=120.0):
    return SyncPoint(bar=bar, time_secs=t, modified_tempo=mod, original_tempo=orig)


# ── bar_start_times ───────────────────────────────────────────────────────────

def test_bar_start_times_constant_tempo(tmp_path):
    # 120 BPM, 4/4 → every bar is exactly 2s
    gp = tmp_path / "song.gp"
    gp.write_bytes(_gpif_zip(_gpif([(0, 120.0)], ["4/4"] * 4)))
    assert ga.bar_start_times(str(gp)) == pytest.approx([0.0, 2.0, 4.0, 6.0])


def test_bar_start_times_tempo_change_and_meter(tmp_path):
    # Bar 0-1 at 120 (4/4 → 2s each), bar 2 switches to 60 in 3/4 (3s)
    gp = tmp_path / "song.gp"
    gp.write_bytes(
        _gpif_zip(_gpif([(0, 120.0), (2, 60.0)], ["4/4", "4/4", "3/4", "3/4"]))
    )
    assert ga.bar_start_times(str(gp)) == pytest.approx([0.0, 2.0, 4.0, 7.0])


# ── build_warp_anchors ────────────────────────────────────────────────────────

def test_build_warp_anchors_maps_bars_to_score_time():
    bar_starts = [0.0, 2.0, 4.0, 6.0]
    points = [_sp(0, 1.0), _sp(2, 5.4)]
    assert ga.build_warp_anchors(points, bar_starts) == [(0.0, 1.0), (4.0, 5.4)]


def test_build_warp_anchors_drops_nonmonotonic_and_out_of_range():
    bar_starts = [0.0, 2.0, 4.0, 6.0]
    points = [
        _sp(0, 1.0),
        _sp(1, 0.5),   # audio time goes backwards — dropped
        _sp(2, 5.4),
        _sp(99, 9.9),  # bar out of range — dropped
    ]
    assert ga.build_warp_anchors(points, bar_starts) == [(0.0, 1.0), (4.0, 5.4)]


def test_build_warp_anchors_drops_implausible_slopes():
    # 2s score bars. A DTW fold (or a run of monotonicity-clamped refine
    # points) can produce a near-flat audio segment — slope far below the
    # 0.2x plausibility floor — which would crush every bar in the span.
    bar_starts = [float(2 * b) for b in range(11)]
    points = [
        _sp(0, 1.0),
        _sp(4, 9.0),    # slope 1.0 — kept
        _sp(8, 9.1),    # slope 0.0125 over 8s of score — dropped
        _sp(10, 21.0),  # slope 1.0 vs the last KEPT anchor — kept
    ]
    assert ga.build_warp_anchors(points, bar_starts) == [
        (0.0, 1.0), (8.0, 9.0), (20.0, 21.0)
    ]


def test_build_warp_anchors_requires_two_points():
    assert ga.build_warp_anchors([_sp(0, 1.0)], [0.0, 2.0]) == []
    assert ga.build_warp_anchors([], [0.0, 2.0]) == []


# ── warp_time ─────────────────────────────────────────────────────────────────

def test_warp_time_interpolates_between_anchors():
    anchors = [(0.0, 1.0), (10.0, 21.0)]  # slope 2, offset 1
    assert ga.warp_time(0.0, anchors) == pytest.approx(1.0)
    assert ga.warp_time(5.0, anchors) == pytest.approx(11.0)
    assert ga.warp_time(10.0, anchors) == pytest.approx(21.0)


def test_warp_time_piecewise_segments():
    # First half plays at authored speed, second half at half speed
    anchors = [(0.0, 0.0), (10.0, 10.0), (20.0, 30.0)]
    assert ga.warp_time(5.0, anchors) == pytest.approx(5.0)
    assert ga.warp_time(15.0, anchors) == pytest.approx(20.0)


def test_warp_time_extrapolates_with_edge_slopes():
    anchors = [(10.0, 20.0), (20.0, 40.0)]  # slope 2
    assert ga.warp_time(5.0, anchors) == pytest.approx(10.0)   # before first
    assert ga.warp_time(25.0, anchors) == pytest.approx(50.0)  # after last


def test_warp_time_preserves_order():
    anchors = [(0.0, 0.5), (4.0, 4.1), (8.0, 9.3), (12.0, 12.9)]
    times = [i * 0.37 for i in range(40)]
    warped = [ga.warp_time(t, anchors) for t in times]
    assert warped == sorted(warped)


# ── warp_song_times ───────────────────────────────────────────────────────────

def _shifted_double(t):
    return 2.0 * t + 1.0


def test_warp_song_times_covers_all_time_fields():
    song = Song(
        song_length=100.0,
        beats=[Beat(time=0.0, measure=1), Beat(time=1.0, measure=-1)],
        sections=[Section(name="verse", number=1, start_time=10.0)],
        arrangements=[
            Arrangement(
                name="Lead",
                notes=[Note(time=2.0, string=0, fret=3, sustain=1.0)],
                chords=[
                    Chord(
                        time=4.0,
                        chord_id=0,
                        notes=[Note(time=4.0, string=1, fret=2, sustain=0.5)],
                    )
                ],
                anchors=[Anchor(time=6.0, fret=3)],
                hand_shapes=[HandShape(chord_id=0, start_time=4.0, end_time=5.0)],
                phrases=[
                    Phrase(
                        start_time=0.0,
                        end_time=8.0,
                        max_difficulty=0,
                        levels=[
                            PhraseLevel(
                                difficulty=0,
                                notes=[Note(time=3.0, string=0, fret=0, sustain=2.0)],
                            )
                        ],
                    )
                ],
                tones={"base": "clean", "changes": [{"t": 7.0, "name": "lead"}]},
                tempos=[{"time": 0.0, "bpm": 120.0}],
            )
        ],
    )

    ga.warp_song_times(song, _shifted_double)

    assert song.song_length == pytest.approx(201.0)
    assert [b.time for b in song.beats] == pytest.approx([1.0, 3.0])
    assert song.sections[0].start_time == pytest.approx(21.0)

    arr = song.arrangements[0]
    n = arr.notes[0]
    assert n.time == pytest.approx(5.0)
    assert n.sustain == pytest.approx(2.0)  # (2+1)*2+1 - 5
    ch = arr.chords[0]
    assert ch.time == pytest.approx(9.0)
    assert ch.notes[0].time == pytest.approx(9.0)
    assert ch.notes[0].sustain == pytest.approx(1.0)
    assert arr.anchors[0].time == pytest.approx(13.0)
    hs = arr.hand_shapes[0]
    assert (hs.start_time, hs.end_time) == (pytest.approx(9.0), pytest.approx(11.0))
    ph = arr.phrases[0]
    assert (ph.start_time, ph.end_time) == (pytest.approx(1.0), pytest.approx(17.0))
    assert ph.levels[0].notes[0].time == pytest.approx(7.0)
    assert ph.levels[0].notes[0].sustain == pytest.approx(4.0)
    assert arr.tones["changes"][0]["t"] == pytest.approx(15.0)
    assert arr.tempos[0]["time"] == pytest.approx(1.0)


def test_warp_song_times_clamps_negative_sustain():
    # A non-monotonic warp callable must not produce negative sustains
    song = Song(arrangements=[
        Arrangement(name="Lead",
                    notes=[Note(time=1.0, string=0, fret=0, sustain=1.0)])
    ])
    ga.warp_song_times(song, lambda t: 5.0 - t)  # decreasing map
    assert song.arrangements[0].notes[0].sustain == 0.0


# ── gp_has_expandable_repeats ─────────────────────────────────────────────────

def test_gpif_files_never_expand_repeats(tmp_path):
    # GPIF conversion is single-pass as-written, so .gp/.gpx are always False
    gp = tmp_path / "song.gp"
    gp.write_bytes(_gpif_zip(_gpif([(0, 120.0)], ["4/4"])))
    assert ga.gp_has_expandable_repeats(str(gp)) is False


def test_gp345_unparseable_returns_false(tmp_path):
    bad = tmp_path / "song.gp5"
    bad.write_bytes(b"not a real gp5 file")
    assert ga.gp_has_expandable_repeats(str(bad)) is False


def test_gp345_repeats_detected(tmp_path):
    guitarpro = pytest.importorskip("guitarpro")
    song = guitarpro.models.Song()
    track = guitarpro.models.Track(song)
    song.tracks = [track]
    # Bar 2 of 3 opens a repeat
    for _ in range(2):
        header = guitarpro.models.MeasureHeader()
        song.addMeasureHeader(header)
    song.measureHeaders[1].isRepeatOpen = True
    for header in song.measureHeaders:
        track.measures.append(guitarpro.models.Measure(track, header))
    path = tmp_path / "repeat.gp5"
    guitarpro.write(song, str(path))
    assert ga.gp_has_expandable_repeats(str(path)) is True


def test_gp345_plain_song_no_repeats(tmp_path):
    guitarpro = pytest.importorskip("guitarpro")
    song = guitarpro.models.Song()
    track = guitarpro.models.Track(song)
    song.tracks = [track]
    for _ in range(2):
        header = guitarpro.models.MeasureHeader()
        song.addMeasureHeader(header)
    for header in song.measureHeaders:
        track.measures.append(guitarpro.models.Measure(track, header))
    path = tmp_path / "plain.gp5"
    guitarpro.write(song, str(path))
    assert ga.gp_has_expandable_repeats(str(path)) is False


# ── refine_sync pure fallbacks ────────────────────────────────────────────────

def test_refine_sync_empty_points_returns_input():
    sync = GpSyncData(audio_offset=0.0, audio_asset_id="", sync_points=[])
    assert ga.refine_sync(sync, "/nonexistent.ogg") is sync


def test_refine_sync_single_point_returns_input():
    # One point → fewer than 2 warp anchors → unchanged, no audio load
    sync = GpSyncData(audio_offset=-1.0, audio_asset_id="",
                      sync_points=[_sp(0, 1.0)])
    assert ga.refine_sync(sync, "/nonexistent.ogg") is sync
