"""Tests for lib/gp8_audio_sync.py and lib/gp_autosync.py — the GP8 embedded
audio / score-to-audio auto-sync helpers.

Fixture-free: every test drives a pure helper with hand-built inputs
(in-memory ZIP containers, ElementTree fragments, synthetic warping paths,
crafted tempo-event lists). The librosa-backed chroma/DTW stages need real
audio and are covered by manual validation in the PR; here we pin the timing
math, asset resolution, and sync-point extraction that are easy to drive
without a fixture.
"""

import io
import zipfile
import xml.etree.ElementTree as ET

import numpy as np
import pytest

import gp8_audio_sync as g8
from gp8_audio_sync import (
    GpSyncData,
    SyncPoint,
    build_tempo_map_from_sync,
    _parse_gpif,
    _resolve_audio_asset,
)
import gp_autosync as ga
from gp_autosync import (
    _gp345_tick_to_secs,
    _gp345_tempo_events,
    _get_tempo_map,
    _get_initial_tempo,
    _tempo_at_bar,
    _safe_normalise,
    _extract_sync_points,
)


# ── helpers ───────────────────────────────────────────────────────────────────

def _gpif_bytes(asset_id: str = "abc-123", registry=None) -> bytes:
    """`registry` maps Asset id -> EmbeddedFilePath, mirroring real GP8 files."""
    root = ET.Element("GPIF")
    bt = ET.SubElement(root, "BackingTrack")
    ET.SubElement(bt, "AssetId").text = asset_id
    if registry:
        assets = ET.SubElement(root, "Assets")
        for aid, path in registry.items():
            a = ET.SubElement(assets, "Asset")
            a.set("id", aid)
            ET.SubElement(a, "EmbeddedFilePath").text = path
    return ET.tostring(root)


def _make_gp_zip(asset_id="abc-123", ogg_stems=("abc-123",),
                 asset_ext=".ogg", registry=None) -> zipfile.ZipFile:
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as zf:
        zf.writestr("Content/score.gpif", _gpif_bytes(asset_id, registry))
        for stem in ogg_stems:
            zf.writestr(f"Content/Assets/{stem}{asset_ext}", b"fake-audio")
    buf.seek(0)
    return zipfile.ZipFile(buf)


def _fake_gpif_root(n_bars: int, tempo: float = 120.0, time_sig="4/4") -> ET.Element:
    root = ET.Element("GPIF")
    mt = ET.SubElement(root, "MasterTrack")
    autos = ET.SubElement(mt, "Automations")
    auto = ET.SubElement(autos, "Automation")
    ET.SubElement(auto, "Type").text = "Tempo"
    ET.SubElement(auto, "Bar").text = "0"
    ET.SubElement(auto, "Value").text = str(tempo)
    mbs = ET.SubElement(root, "MasterBars")
    for _ in range(n_bars):
        mb = ET.SubElement(mbs, "MasterBar")
        ET.SubElement(mb, "Time").text = time_sig
    return root


# ── GpSyncData.time_at_bar / tempo_at_bar ───────────────────────────────────────

def test_time_at_bar_interpolates_linearly_between_points():
    sp = [
        SyncPoint(bar=0, time_secs=0.0, modified_tempo=120, original_tempo=120),
        SyncPoint(bar=10, time_secs=20.0, modified_tempo=120, original_tempo=120),
    ]
    d = GpSyncData(audio_offset=0.0, audio_asset_id="", sync_points=sp)
    assert d.time_at_bar(0) == pytest.approx(0.0)
    assert d.time_at_bar(10) == pytest.approx(20.0)
    assert d.time_at_bar(5) == pytest.approx(10.0)   # exact halfway, any meter
    assert d.time_at_bar(2) == pytest.approx(4.0)


def test_time_at_bar_interpolation_is_time_signature_agnostic():
    # 3/4 material: linear interp between sync points must not assume 4 beats.
    sp = [
        SyncPoint(bar=0, time_secs=0.0, modified_tempo=90, original_tempo=90),
        SyncPoint(bar=4, time_secs=8.0, modified_tempo=90, original_tempo=90),
    ]
    d = GpSyncData(audio_offset=0.0, audio_asset_id="", sync_points=sp)
    assert d.time_at_bar(1) == pytest.approx(2.0)
    assert d.time_at_bar(3) == pytest.approx(6.0)


def test_time_at_bar_extrapolates_past_last_point_by_tempo():
    sp = [SyncPoint(bar=0, time_secs=0.0, modified_tempo=120, original_tempo=120)]
    d = GpSyncData(audio_offset=0.0, audio_asset_id="", sync_points=sp)
    # 4 beats/bar at 120 BPM = 2.0 s/bar.
    assert d.time_at_bar(3) == pytest.approx(6.0)
    # 3/4 (beats_per_bar=3) at 120 BPM = 1.5 s/bar.
    assert d.time_at_bar(2, beats_per_bar=3.0) == pytest.approx(3.0)


def test_time_at_bar_empty_returns_zero():
    d = GpSyncData(audio_offset=0.0, audio_asset_id="", sync_points=[])
    assert d.time_at_bar(5) == 0.0


def test_tempo_at_bar_holds_last_segment():
    sp = [
        SyncPoint(bar=0, time_secs=0.0, modified_tempo=100, original_tempo=100),
        SyncPoint(bar=8, time_secs=10.0, modified_tempo=140, original_tempo=120),
    ]
    d = GpSyncData(audio_offset=0.0, audio_asset_id="", sync_points=sp)
    assert d.tempo_at_bar(0) == 100
    assert d.tempo_at_bar(7) == 100
    assert d.tempo_at_bar(8) == 140
    assert d.tempo_at_bar(20) == 140


def test_build_tempo_map_from_sync():
    sp = [
        SyncPoint(bar=0, time_secs=0.0, modified_tempo=120, original_tempo=120),
        SyncPoint(bar=4, time_secs=8.0, modified_tempo=130, original_tempo=120),
    ]
    d = GpSyncData(audio_offset=0.0, audio_asset_id="", sync_points=sp)
    assert build_tempo_map_from_sync(d) == [(0, 120.0), (4, 130.0)]
    empty = GpSyncData(audio_offset=0.0, audio_asset_id="", sync_points=[])
    assert build_tempo_map_from_sync(empty) == [(0, 120.0)]


# ── _parse_gpif / _resolve_audio_asset ────────────────────────────────────────────

def test_parse_gpif_reads_backing_track():
    root = _parse_gpif(_gpif_bytes("xyz"))
    assert root.find("BackingTrack/AssetId").text == "xyz"


def test_resolve_audio_asset_matches_declared_id():
    with _make_gp_zip(asset_id="match", ogg_stems=("other", "match")) as zf:
        stem, path = _resolve_audio_asset(zf)
        assert stem == "match"
        assert path == "Content/Assets/match.ogg"


def test_resolve_audio_asset_falls_back_to_first_when_unmatched():
    with _make_gp_zip(asset_id="missing", ogg_stems=("only",)) as zf:
        stem, path = _resolve_audio_asset(zf)
        assert stem == "only"
        assert path == "Content/Assets/only.ogg"


def test_resolve_audio_asset_matches_mp3():
    # GP8 commonly embeds the backing track as MP3, not OGG — the resolver
    # must match it (regression guard for the OGG-only bug).
    with _make_gp_zip(asset_id="trk", ogg_stems=("trk",), asset_ext=".mp3") as zf:
        stem, path = _resolve_audio_asset(zf)
        assert stem == "trk"
        assert path == "Content/Assets/trk.mp3"


def test_resolve_audio_asset_prefers_ogg_when_multiple_formats():
    # If the same backing track is present as both OGG and MP3, prefer the
    # OGG (lossless copy, no transcode) regardless of ZIP order.
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as zf:
        zf.writestr("Content/score.gpif", _gpif_bytes("trk"))
        zf.writestr("Content/Assets/trk.mp3", b"fake-audio")  # first in order
        zf.writestr("Content/Assets/trk.ogg", b"fake-audio")
    buf.seek(0)
    with zipfile.ZipFile(buf) as zf:
        stem, path = _resolve_audio_asset(zf)
        assert path == "Content/Assets/trk.ogg"


def test_resolve_audio_asset_none_when_no_audio():
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as zf:
        zf.writestr("Content/score.gpif", _gpif_bytes())
    buf.seek(0)
    with zipfile.ZipFile(buf) as zf:
        stem, path = _resolve_audio_asset(zf)
        assert stem == "" and path is None


# ── gp_autosync timing helpers ──────────────────────────────────────────────────

def test_gp345_tick_to_secs_constant_tempo():
    te = [(0, 120.0)]  # 120 BPM, 960 ticks/quarter -> 1 quarter = 0.5 s
    assert _gp345_tick_to_secs(te, 960) == pytest.approx(0.5)
    assert _gp345_tick_to_secs(te, 1920) == pytest.approx(1.0)
    assert _gp345_tick_to_secs(te, 0) == pytest.approx(0.0)


def test_gp345_tick_to_secs_handles_mid_stream_tempo_change():
    # 120 BPM for the first quarter (0.5 s), then 60 BPM (1.0 s/quarter).
    te = [(0, 120.0), (960, 60.0)]
    assert _gp345_tick_to_secs(te, 1920) == pytest.approx(1.5)


def test_get_tempo_map_and_initial_tempo():
    root = _fake_gpif_root(n_bars=2, tempo=144.0)
    assert _get_initial_tempo(root) == pytest.approx(144.0)
    assert _get_tempo_map(root) == [(0, 144.0)]


def test_get_tempo_map_defaults_when_absent():
    assert _get_tempo_map(ET.Element("GPIF")) == [(0, 120.0)]


def test_tempo_at_bar_uses_last_event_at_or_before():
    tmap = [(0, 100.0), (4, 150.0)]
    assert _tempo_at_bar(tmap, 0) == 100.0
    assert _tempo_at_bar(tmap, 3) == 100.0
    assert _tempo_at_bar(tmap, 4) == 150.0
    assert _tempo_at_bar(tmap, 9) == 150.0


def test_safe_normalise_unit_columns_and_no_nan_on_zero():
    m = np.array([[3.0, 0.0], [4.0, 0.0]], dtype=np.float32)
    out = _safe_normalise(m)
    assert out[:, 0] == pytest.approx([0.6, 0.8])   # 3-4-5 triangle -> unit norm
    assert np.all(np.isfinite(out))                  # zero column -> no NaN
    # zero-energy column is filled with 1/12 (equidistant from all bins)
    assert out[:, 1] == pytest.approx([1.0 / 12.0, 1.0 / 12.0])


# ── _extract_sync_points (synthetic DTW path) ────────────────────────────────────

def _identity_setup(n_bars=4, tempo=120.0, sr=22050, hop=4096):
    root = _fake_gpif_root(n_bars=n_bars, tempo=tempo)
    n = 64
    wp = np.array([[i, i] for i in range(n)])          # identity warp path
    times = np.arange(n) * hop / sr
    return root, wp, times, sr, hop


def test_extract_sync_points_identity_path_maps_bars_to_their_score_time():
    root, wp, times, sr, hop = _identity_setup(n_bars=4, tempo=120.0)
    pts = _extract_sync_points(wp, root, times, times, sr, hop, n_sync_points=4)
    bars = [p.bar for p in pts]
    assert bars == [0, 1, 2, 3]
    # 4/4 @ 120 BPM -> 2.0 s/bar; identity path -> audio time == score bar start.
    for p in pts:
        assert p.time_secs == pytest.approx(p.bar * 2.0, abs=hop / sr)
    # modified tempo is derived from the score/audio segment ratio and clamped;
    # frame quantisation keeps it near (not exactly) the authored 120 BPM.
    for p in pts:
        assert 20.0 <= p.modified_tempo <= 300.0
        assert p.modified_tempo == pytest.approx(120.0, abs=15.0)


def test_extract_sync_points_fills_trailing_modified_tempo():
    # Regression: the final sync point must not keep the original-tempo
    # placeholder — it carries the last computed segment tempo forward.
    root, wp, times, sr, hop = _identity_setup(n_bars=4, tempo=120.0)
    pts = _extract_sync_points(wp, root, times, times, sr, hop, n_sync_points=4)
    assert pts[-1].modified_tempo == pts[-2].modified_tempo


def test_extract_sync_points_uses_bar_starts_override():
    root, wp, times, sr, hop = _identity_setup(n_bars=4, tempo=120.0)
    # Override every bar to sit at score-time 0 -> all map to audio frame 0.
    override = [0.0, 0.0, 0.0, 0.0]
    pts = _extract_sync_points(
        wp, root, times, times, sr, hop, n_sync_points=4,
        bar_starts_override=override,
    )
    assert all(p.time_secs == pytest.approx(0.0, abs=hop / sr) for p in pts)


def test_extract_sync_points_handles_zero_sync_points_without_crashing():
    # n_sync_points is public; 0 must not raise ZeroDivisionError on the stride.
    root, wp, times, sr, hop = _identity_setup(n_bars=4, tempo=120.0)
    pts = _extract_sync_points(wp, root, times, times, sr, hop, n_sync_points=0)
    assert len(pts) >= 1


def test_extract_sync_points_empty_when_no_bars():
    root = ET.Element("GPIF")  # no MasterBars
    _, wp, times, sr, hop = _identity_setup()
    assert _extract_sync_points(wp, root, times, times, sr, hop, 4) == []


# ── AssetId is a key into <Assets>, not a filename stem ──────────────────────
# Real GP8 files name embedded audio by hash while AssetId is a small
# integer, so the stem match never hit: every such file warned and fell
# through to "first audio asset". Silently correct with ONE asset; with two,
# a backing track declaring id 1 resolved to asset 0 — the wrong recording.

_REAL_SHAPE = {"0": "Content/Assets/1312f2aa-10ee-5f35-a4d5-e999eee1d9d0.mp3"}


def test_asset_id_resolves_through_the_registry_not_the_stem():
    zf = _make_gp_zip(
        asset_id="0",
        ogg_stems=("1312f2aa-10ee-5f35-a4d5-e999eee1d9d0",),
        asset_ext=".mp3",
        registry=_REAL_SHAPE,
    )
    stem, path = _resolve_audio_asset(zf)
    assert path == "Content/Assets/1312f2aa-10ee-5f35-a4d5-e999eee1d9d0.mp3"
    assert stem == "1312f2aa-10ee-5f35-a4d5-e999eee1d9d0"


def test_the_second_asset_is_reachable():
    """The actual bug: id 1 used to resolve to asset 0."""
    zf = _make_gp_zip(
        asset_id="1",
        ogg_stems=("first-track", "second-track"),
        registry={
            "0": "Content/Assets/first-track.ogg",
            "1": "Content/Assets/second-track.ogg",
        },
    )
    stem, path = _resolve_audio_asset(zf)
    assert path == "Content/Assets/second-track.ogg", "declared id 1 must win"
    assert stem == "second-track"


def test_registry_entry_pointing_at_a_missing_file_falls_through():
    zf = _make_gp_zip(
        asset_id="0",
        ogg_stems=("real-track",),
        registry={"0": "Content/Assets/deleted-track.ogg"},
    )
    stem, path = _resolve_audio_asset(zf)
    assert path == "Content/Assets/real-track.ogg"


def test_backslash_separators_in_the_registry_are_normalised():
    zf = _make_gp_zip(
        asset_id="0",
        ogg_stems=("winpath",),
        registry={"0": r"Content\Assets\winpath.ogg"},
    )
    _, path = _resolve_audio_asset(zf)
    assert path == "Content/Assets/winpath.ogg"


def test_registry_prefers_ogg_among_same_stem_duplicates():
    """Quality behaviour is preserved: OGG is copied out, others transcoded."""
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as zf:
        zf.writestr("Content/score.gpif", _gpif_bytes(
            "0", {"0": "Content/Assets/dual.mp3"}))
        zf.writestr("Content/Assets/dual.mp3", b"fake")
        zf.writestr("Content/Assets/dual.ogg", b"fake")
    buf.seek(0)
    _, path = _resolve_audio_asset(zipfile.ZipFile(buf))
    assert path.endswith(".ogg")


def test_a_malformed_registry_does_not_break_resolution():
    for reg in ({"0": ""}, {"9": "Content/Assets/other.ogg"}, {}):
        zf = _make_gp_zip(asset_id="0", ogg_stems=("fallback",), registry=reg)
        _, path = _resolve_audio_asset(zf)
        assert path == "Content/Assets/fallback.ogg"


def test_legacy_stem_match_still_works_without_a_registry():
    """Files whose stem IS the id keep resolving — step 2 of the ladder."""
    zf = _make_gp_zip(asset_id="abc-123", ogg_stems=("zzz", "abc-123"))
    stem, path = _resolve_audio_asset(zf)
    assert stem == "abc-123"
    assert path == "Content/Assets/abc-123.ogg"


def test_a_same_stem_file_in_another_directory_cannot_stand_in():
    """The registry names a PATH, not just a name.

    Resolution matches on stem so a format variant of the same recording can
    win, but an unrelated file that merely shares the stem must not satisfy
    the declaration — that substitution is what the registry lookup exists to
    prevent. The declared asset is genuinely absent here, so the right answer
    is the documented fall-through, not the decoy.

    ZIP order matters to this test: `real.ogg` is written FIRST so the
    fall-through target differs from the decoy. Otherwise both the fixed and
    unfixed code return the same file and the test proves nothing.
    """
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as zf:
        zf.writestr("Content/score.gpif", _gpif_bytes(
            "0", {"0": "Content/Audio/track.ogg"}))
        zf.writestr("Content/Assets/real.ogg", b"fake")     # fall-through target
        zf.writestr("Content/Assets/track.ogg", b"decoy")   # shares the stem only
    buf.seek(0)
    _, path = _resolve_audio_asset(zipfile.ZipFile(buf))
    assert path == "Content/Assets/real.ogg", (
        "a same-stem file in a directory the registry never named must not "
        "satisfy the declaration"
    )


def test_the_declared_directory_still_resolves_its_own_format_variants():
    """The directory constraint must not cost us the OGG preference.

    The shallower decoy is written FIRST, so unfixed code (which searches
    every directory) picks it and this test fails.
    """
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as zf:
        zf.writestr("Content/score.gpif", _gpif_bytes(
            "0", {"0": "Content/Assets/nested/take.mp3"}))
        zf.writestr("Content/Assets/take.ogg", b"decoy-one-level-up")
        zf.writestr("Content/Assets/nested/take.mp3", b"declared")
        zf.writestr("Content/Assets/nested/take.ogg", b"same-take-lossless")
    buf.seek(0)
    stem, path = _resolve_audio_asset(zipfile.ZipFile(buf))
    assert path == "Content/Assets/nested/take.ogg", (
        "the OGG variant in the DECLARED directory wins over a shallower decoy"
    )
    assert stem == "take"
