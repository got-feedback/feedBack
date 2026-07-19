"""The three-valued tuning PERSPECTIVE, and "playable without retuning".

Two behaviours that extend the bass tuning fix (see
test_library_tuning_instrument.py):

1. `active_instrument_profile` has three values (guitar-lead / guitar-rhythm /
   bass), so the tuning perspective must too. Lead and rhythm charts can be
   tuned differently, which is the identical bug a bassist hit, inside guitar.

2. Exact tuning match answers "which tuning is this labelled". A player
   actually wants "will this cost me a retune". Both are offered; exact stays
   the default.

Everything round-trips through the real extractor, the real scanner
derivation, the real schema and the real HTTP surface.
"""

import importlib
import sys

import pytest
import yaml
from fastapi.testclient import TestClient

from scan_worker import _extract_meta_for_file
from tunings import (
    PERSPECTIVES, bass_tuning_key, chart_is_playable_in, perspective_tuning_key,
)


@pytest.fixture()
def server_mod(tmp_path, monkeypatch):
    monkeypatch.setenv("CONFIG_DIR", str(tmp_path))
    sys.modules.pop("server", None)
    mod = importlib.import_module("server")
    yield mod
    conn = getattr(getattr(mod, "meta_db", None), "conn", None)
    if conn is not None:
        getattr(sys.modules.get("server"), "_join_background_db_threads", lambda: None)()
        conn.close()


@pytest.fixture()
def client(server_mod):
    c = TestClient(server_mod.app)
    try:
        yield c
    finally:
        c.close()


def _pack(root, name, arrangements):
    d = root / name
    d.mkdir(parents=True)
    (d / "manifest.yaml").write_text(yaml.safe_dump({
        "title": name, "artist": "A", "duration": 100,
        "arrangements": arrangements, "stems": [],
    }), encoding="utf-8")
    return d


def _files(client, **kw):
    return {s["filename"] for s in client.get("/api/library", params=kw).json()["songs"]}


# ── 1. The same bug WITHIN guitar: lead vs rhythm ────────────────────────────

def test_rhythm_chart_tuning_is_indexed_separately(tmp_path):
    """A song whose LEAD is in E standard but whose RHYTHM is in Drop D must
    index both — through the real extractor + scanner derivation."""
    d = _pack(tmp_path, "split.sloppak", [
        {"name": "Lead", "tuning": [0, 0, 0, 0, 0, 0]},
        {"name": "Rhythm", "tuning": [-2, 0, 0, 0, 0, 0]},
    ])
    meta = _extract_meta_for_file(d)
    assert meta["tuning_name"] == "E Standard"        # song-level = guitar-first
    assert meta["rhythm_tuning_name"] == "Drop D"     # the rhythm chart's own
    assert meta["rhythm_tuning_offsets"] == "-2 0 0 0 0 0"
    assert meta["rhythm_tuning_low_pitch"] == 38      # low D


def test_rhythm_offsets_are_not_truncated(tmp_path):
    """Only BASS truncates (its arrays are padded). A 7-string guitar array is
    real data — cutting it to 6 would invent a tuning the chart doesn't have."""
    d = _pack(tmp_path, "seven.sloppak", [
        {"name": "Rhythm", "tuning": [-2, -2, -2, -2, -2, -2, -2]},
    ])
    meta = _extract_meta_for_file(d)
    assert meta["rhythm_tuning_offsets"] == "-2 -2 -2 -2 -2 -2 -2"


def test_no_rhythm_arrangement_leaves_the_columns_empty(tmp_path):
    d = _pack(tmp_path, "leadonly.sloppak", [{"name": "Lead", "tuning": [0] * 6}])
    meta = _extract_meta_for_file(d)
    assert meta["rhythm_tuning_name"] == ""
    assert meta["rhythm_tuning_key"] == ""


def _put(server_mod, fn, **kw):
    base = dict(title=fn, artist="A", album="LP", year="2010", duration=200.0,
                tuning="E Standard", arrangements=[], has_lyrics=False,
                format="sloppak", stem_ids=[], tuning_name="E Standard",
                tuning_sort_key=0, tuning_offsets="0 0 0 0 0 0",
                tuning_low_pitch=40)
    base.update(kw)
    server_mod.meta_db.put(fn, 1.0, 1, base)


@pytest.fixture()
def rhythm_seeded(server_mod):
    """Both songs are E Standard by LEAD. One has a Drop D rhythm chart; the
    other has no rhythm chart at all (so it falls back + is marked inferred)."""
    _put(server_mod, "rdiffer.sloppak",
         rhythm_tuning_name="Drop D", rhythm_tuning_sort_key=-2,
         rhythm_tuning_offsets="-2 0 0 0 0 0",
         rhythm_tuning_key=perspective_tuning_key(
             [-2, 0, 0, 0, 0, 0], PERSPECTIVES["guitar-rhythm"]),
         rhythm_tuning_low_pitch=38)
    _put(server_mod, "rnone.sloppak")


def test_rhythm_filter_excludes_a_lead_only_tuning_match(client, rhythm_seeded):
    """THE WITHIN-GUITAR BUG. Filtering rhythm "E Standard" must not return
    rdiffer — that is its LEAD tuning; its rhythm chart is in Drop D."""
    assert _files(client, tunings="E Standard") == {"rdiffer.sloppak", "rnone.sloppak"}
    # rnone has no rhythm chart, so it falls back to its lead tuning and stays.
    assert _files(client, tunings="E Standard", instrument="guitar-rhythm") == {
        "rnone.sloppak"}
    assert _files(client, tunings="Drop D", instrument="guitar-rhythm") == {
        "rdiffer.sloppak"}
    # …and Drop D finds nothing from the lead perspective.
    assert _files(client, tunings="Drop D") == set()


def test_rhythm_perspective_marks_inferred_rows(client, rhythm_seeded):
    rows = {s["filename"]: s for s in client.get(
        "/api/library", params={"instrument": "guitar-rhythm"}).json()["songs"]}
    assert rows["rdiffer.sloppak"]["tuning_inferred"] is False
    assert rows["rnone.sloppak"]["tuning_inferred"] is True
    assert rows["rdiffer.sloppak"]["tuning_perspective"] == "guitar-rhythm"


def test_rhythm_facet_reports_inferred_portion(client, rhythm_seeded):
    rows = {t["name"]: t for t in client.get(
        "/api/library/tuning-names",
        params={"instrument": "guitar-rhythm"}).json()["tunings"]}
    assert rows["Drop D"]["count"] == 1 and rows["Drop D"]["inferred_count"] == 0
    assert rows["E Standard"]["count"] == 1 and rows["E Standard"]["inferred_count"] == 1


def test_facet_row_selects_exactly_what_it_counted_for_rhythm(client, rhythm_seeded):
    """The invariant that must hold for EVERY perspective."""
    for row in client.get("/api/library/tuning-names",
                          params={"instrument": "guitar-rhythm"}).json()["tunings"]:
        got = _files(client, tunings=row["key"], instrument="guitar-rhythm")
        assert len(got) == row["count"], row["key"]


def test_guitar_lead_is_byte_identical_to_the_legacy_default(client, rhythm_seeded):
    """The majority path must not regress: the default payload gains no keys,
    and the legacy two-valued vocabulary still resolves to it."""
    default = client.get("/api/library").json()
    explicit = client.get("/api/library", params={"instrument": "guitar-lead"}).json()
    legacy = client.get("/api/library", params={"instrument": "guitar"}).json()
    assert default == explicit == legacy
    row = default["songs"][0]
    assert "tuning_inferred" not in row and "tuning_perspective" not in row


def test_unknown_perspective_falls_back_to_lead(client, rhythm_seeded):
    """An unrecognised value must never silently change filter semantics."""
    assert client.get("/api/library", params={"instrument": "kazoo"}).json() == \
        client.get("/api/library").json()


def test_tuning_sort_respects_the_rhythm_perspective(client, rhythm_seeded):
    """Sort is musical distance from standard. rdiffer is 0 away by lead but
    -2 by rhythm, so the perspective changes its position."""
    def order(**kw):
        return [s["filename"] for s in client.get(
            "/api/library", params={"sort": "tuning", **kw}).json()["songs"]]
    assert order()[0] == "rdiffer.sloppak"                            # tie → filename
    assert order(instrument="guitar-rhythm")[0] == "rnone.sloppak"    # 0 beats -2


# ── 2. "Playable without retuning" ───────────────────────────────────────────

@pytest.mark.parametrize("your_low,chart_low,expected", [
    (23, 28, True),     # 5-string bass (low B) plays a 4-string standard chart
    (23, 26, True),     # …and a drop-D chart: the low D is fretted on the B string
    (28, 26, False),    # 4-string standard CANNOT reach a drop-D chart's low D
    (28, 28, True),     # identical tuning
    (40, 38, False),    # guitar standard vs a drop-D chart
    (38, 40, True),     # a drop-D guitar covers a standard chart
    (None, 28, False),  # unknown chart pitch is never claimed playable
    (28, None, False),
])
def test_playability_rule(your_low, chart_low, expected):
    """The core comparison as a property: your lowest open string vs the
    chart's lowest required pitch. Unknown => not playable (conservative)."""
    assert chart_is_playable_in(chart_low, your_low) is expected


@pytest.fixture()
def pitched(server_mod):
    _put(server_mod, "std.sloppak", tuning_low_pitch=40)
    _put(server_mod, "dropd.sloppak", tuning="Drop D", tuning_name="Drop D",
         tuning_offsets="-2 0 0 0 0 0", tuning_sort_key=-2, tuning_low_pitch=38)
    _put(server_mod, "dropc.sloppak", tuning="Drop C", tuning_name="Drop C",
         tuning_offsets="-4 -2 -2 -2 -2 -2", tuning_sort_key=-14, tuning_low_pitch=36)


def _playable(client, offsets, instrument="guitar", sc=6, **kw):
    return {s["filename"] for s in client.get("/api/library", params={
        "tuning_match": "playable", "playable_offsets": offsets,
        "playable_instrument": instrument, "playable_string_count": str(sc), **kw,
    }).json()["songs"]}


def test_playable_from_standard_excludes_lower_tuned_charts(client, pitched):
    """In E standard you can play the standard chart, but the drop-D and
    drop-C charts need a retune — exactly what the tester wants surfaced."""
    assert _playable(client, "0,0,0,0,0,0") == {"std.sloppak"}


def test_playable_from_drop_c_covers_everything_above_it(client, pitched):
    """Tuned DOWN to drop C, every higher-tuned chart is reachable by fretting
    — the dominant real case this feature exists for."""
    assert _playable(client, "-4,-2,-2,-2,-2,-2") == {
        "std.sloppak", "dropd.sloppak", "dropc.sloppak"}


def test_playable_is_a_mode_not_a_replacement_for_exact(client, pitched):
    """Exact match still works untouched, and returns something DIFFERENT from
    playable — they answer different questions."""
    exact = {s["filename"] for s in client.get(
        "/api/library", params={"tunings": "Drop D"}).json()["songs"]}
    assert exact == {"dropd.sloppak"}
    assert _playable(client, "-2,0,0,0,0,0") == {"std.sloppak", "dropd.sloppak"}


def test_playable_excludes_rows_with_no_indexed_pitch(client, server_mod, pitched):
    """Conservative by construction: a chart whose low pitch we could not
    compute is EXCLUDED, never assumed playable. Wrongly claiming playability
    costs a mid-practice retune — the failure this feature prevents."""
    _put(server_mod, "unknown.sloppak", tuning_low_pitch=None)
    assert "unknown.sloppak" not in _playable(client, "-4,-2,-2,-2,-2,-2")
    # …but it is still reachable normally, so it isn't lost from the library.
    assert any(s["filename"] == "unknown.sloppak"
               for s in client.get("/api/library").json()["songs"])


def test_malformed_playable_tuning_applies_no_filter(client, pitched):
    """A tuning we cannot resolve must not silently claim everything is
    playable OR that nothing is — it applies no filter at all."""
    everything = {s["filename"] for s in client.get("/api/library").json()["songs"]}
    assert _playable(client, "not,a,tuning") == everything
    assert _playable(client, "") == everything
    # A string count that disagrees with the offsets is equally unusable.
    assert _playable(client, "0,0,0,0", instrument="guitar", sc=6) == everything


def test_playable_respects_the_bass_perspective(client, server_mod):
    """A 5-string bass (low B) can play a 4-string standard bass chart. The
    comparison must run on the BASS tuning — this song's GUITAR chart is tuned
    far lower, so reading the wrong column would flip the answer."""
    _put(server_mod, "bassy.sloppak",
         tuning="Custom Tuning", tuning_name="Custom Tuning",
         tuning_offsets="-4 -2 -2 -1 -2 0", tuning_sort_key=-11,
         tuning_low_pitch=36,
         bass_tuning_name="E Standard", bass_tuning_sort_key=0,
         bass_tuning_offsets="0 0 0 0",
         bass_tuning_key=bass_tuning_key([0, 0, 0, 0]),
         bass_tuning_low_pitch=28)
    # 5-string bass low B (23) <= the chart low E (28) → playable.
    got = {s["filename"] for s in client.get("/api/library", params={
        "tuning_match": "playable", "playable_offsets": "0,0,0,0,0",
        "playable_instrument": "bass", "playable_string_count": "5",
        "instrument": "bass"}).json()["songs"]}
    assert got == {"bassy.sloppak"}
    # A 4-string bass tuned UP a semitone (low F, 29) cannot reach the low E.
    got_up = {s["filename"] for s in client.get("/api/library", params={
        "tuning_match": "playable", "playable_offsets": "1,1,1,1",
        "playable_instrument": "bass", "playable_string_count": "4",
        "instrument": "bass"}).json()["songs"]}
    assert got_up == set()


def test_playable_and_stats_agree(client, pitched):
    """The count surface must apply the same predicate as the grid."""
    body = client.get("/api/library/stats", params={
        "tuning_match": "playable", "playable_offsets": "0,0,0,0,0,0",
        "playable_instrument": "guitar", "playable_string_count": "6"}).json()
    assert body["total_songs"] == 1
