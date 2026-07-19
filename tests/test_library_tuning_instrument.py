"""Instrument-aware tuning in the library (the KwasimodoZAZA bass report).

A song's BASS chart is often tuned differently from its guitar chart, but the
library indexed exactly one guitar-first tuning per song — so a bass player
filtering "Drop D" got songs whose GUITAR is in Drop D, and playlists built
that way were wrong.

These tests round-trip through the real extractors, the real scanner
derivation, the real SQLite schema/migration, and the real HTTP surface. The
only thing stubbed is metadata EXTRACTION in the scan tests (the production
process pool can't reach an in-process mock) — never the code under test.

Real-library notes, all confirmed against actual pack contents:

* Bass arrangements usually store SIX-element offset arrays even when the
  chart is a 4-string part — slots 4-5 are PADDING (no bass chart in the
  corpus references string index 4 or 5). So bass offsets are truncated to 4
  before naming or grouping. The feedpak spec has no string-count field, so 4
  is a documented default, not a read value.
* AC/DC "Girls Got Rhythm" stores [5,5,5,5,4,4] — every string up a fourth,
  which no bassist plays. That is BAD DATA, and it must never be NAMED, or the
  library sends a player to retune to a tuning that does not exist.
* Covet "Shibuya" (custom guitar tuning, dead-standard bass) is the headline
  regression: the tester's bug in a single song.
"""

import importlib
import json
import sys

import pytest
import yaml
from fastapi.testclient import TestClient

import sloppak as sloppak_mod
from scan_worker import _extract_meta_for_file
from tunings import (
    PERSPECTIVES, bass_offsets_are_plausible, bass_tuning_key, bass_tuning_name,
    chart_is_playable_in, normalize_bass_offsets, perspective_tuning_key,
    tuning_name,
)


# ── Fixtures ─────────────────────────────────────────────────────────────────

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
    """A directory-form pack whose manifest carries per-arrangement tunings."""
    d = root / name
    d.mkdir(parents=True)
    (d / "manifest.yaml").write_text(yaml.safe_dump({
        "title": name, "artist": "A", "duration": 100,
        "arrangements": arrangements, "stems": [],
    }), encoding="utf-8")
    return d


def _put(server_mod, *, filename, title, tuning_name_="E Standard",
         tuning_sort_key=0, tuning_offsets="0 0 0 0 0 0",
         bass_tuning_name="", bass_tuning_sort_key=0, bass_tuning_offsets="",
         bass_tuning_key=""):
    server_mod.meta_db.put(filename, 1.0, 1, {
        "title": title, "artist": "A", "album": "A - LP", "year": "2010",
        "duration": 200.0, "tuning": tuning_name_, "arrangements": [],
        "has_lyrics": False, "format": "sloppak", "stem_ids": [],
        "tuning_name": tuning_name_,
        "tuning_sort_key": tuning_sort_key,
        "tuning_offsets": tuning_offsets,
        "bass_tuning_name": bass_tuning_name,
        "bass_tuning_sort_key": bass_tuning_sort_key,
        "bass_tuning_offsets": bass_tuning_offsets,
        "bass_tuning_key": bass_tuning_key,
    })


# ── 1. Extraction: sloppak ───────────────────────────────────────────────────

def test_sloppak_extract_indexes_both_tunings_when_they_differ(tmp_path):
    """The reported case: guitar down a step, bass in standard. BOTH must be
    indexed — previously only the guitar tuning survived."""
    d = _pack(tmp_path, "differ.sloppak", [
        {"name": "Lead", "tuning": [-2, 0, 0, -1, -2, 0]},
        {"name": "Bass", "tuning": [0, 0, 0, 0, 0, 0]},
    ])
    meta = sloppak_mod.extract_meta(d)
    assert meta["tuning_offsets"] == [-2, 0, 0, -1, -2, 0]
    assert meta["bass_tuning_offsets"] == [0, 0, 0, 0, 0, 0]


def test_sloppak_extract_leaves_bass_absent_without_bass_arrangement(tmp_path):
    """No bass chart → None, NOT a copy of the guitar tuning. The library
    falls back explicitly, so 'no bass part' stays distinguishable."""
    d = _pack(tmp_path, "nobass.sloppak", [
        {"name": "Lead", "tuning": [-2, -2, -2, -2, -2, -2]},
        {"name": "Rhythm", "tuning": [-2, -2, -2, -2, -2, -2]},
    ])
    meta = sloppak_mod.extract_meta(d)
    assert meta["tuning_offsets"] == [-2, -2, -2, -2, -2, -2]
    assert meta["bass_tuning_offsets"] is None


def test_sloppak_extract_bass_wins_over_guitar_first_ordering(tmp_path):
    """The bass entry is listed FIRST in the manifest; the song tuning must
    still be the guitar's while the bass column takes the bass entry — the two
    selections are independent, not 'first wins'."""
    d = _pack(tmp_path, "order.sloppak", [
        {"name": "Bass", "tuning": [-4, -4, -4, -4, -4, -4]},
        {"name": "Lead", "tuning": [0, 0, 0, 0, 0, 0]},
    ])
    meta = sloppak_mod.extract_meta(d)
    assert meta["tuning_offsets"] == [0, 0, 0, 0, 0, 0]
    assert meta["bass_tuning_offsets"] == [-4, -4, -4, -4, -4, -4]


def test_sloppak_extract_ignores_bass_arrangement_without_a_tuning(tmp_path):
    """A bass chart that authors no tuning gives us nothing to index; the
    column stays empty rather than defaulting to a wrong all-zeros."""
    d = _pack(tmp_path, "untuned.sloppak", [
        {"name": "Lead", "tuning": [-2, -2, -2, -2, -2, -2]},
        {"name": "Bass"},
    ])
    assert sloppak_mod.extract_meta(d)["bass_tuning_offsets"] is None


def test_sloppak_extract_falls_back_to_an_alt_bass_chart(tmp_path):
    """Only a "Bass 2" chart exists. Using it beats reporting the guitar
    tuning as the player's bass tuning."""
    d = _pack(tmp_path, "altbass.sloppak", [
        {"name": "Lead", "tuning": [0, 0, 0, 0, 0, 0]},
        {"name": "Bass 2", "tuning": [-2, 0, 0, 0, 0, 0]},
    ])
    assert sloppak_mod.extract_meta(d)["bass_tuning_offsets"] == [-2, 0, 0, 0, 0, 0]


# ── 2. Scanner derivation (name / sort key / offsets string) ─────────────────

def test_scan_worker_derives_bass_columns_like_the_guitar_ones(tmp_path):
    """Guitar columns keep all six strings; bass columns are TRUNCATED to the
    bass's four (the stored tail is padding — see tunings.normalize_bass_offsets)."""
    d = _pack(tmp_path, "derive.sloppak", [
        {"name": "Lead", "tuning": [-2, -2, -2, -2, -2, -2]},
        {"name": "Bass", "tuning": [0, 0, 0, 0, 0, 0]},
    ])
    meta = _extract_meta_for_file(d)
    assert meta["tuning_name"] == "D Standard"
    assert meta["tuning_sort_key"] == -12
    assert meta["tuning_offsets"] == "-2 -2 -2 -2 -2 -2"
    assert meta["bass_tuning_name"] == "E Standard"
    assert meta["bass_tuning_sort_key"] == 0
    assert meta["bass_tuning_offsets"] == "0 0 0 0"
    # Canonical key = absolute open pitches of a 4-string bass in standard.
    assert meta["bass_tuning_key"] == "bass:28:33:38:43"


def test_bass_padding_is_truncated_before_naming_and_grouping(tmp_path):
    """The padded tail must never reach the namer or the group key: a bass
    stored six-wide and the same tuning stored four-wide must produce
    IDENTICAL indexed columns."""
    six = _extract_meta_for_file(_pack(tmp_path, "six.sloppak", [
        {"name": "Bass", "tuning": [-2, 0, 0, 0, 0, 0]}]))
    four = _extract_meta_for_file(_pack(tmp_path, "four.sloppak", [
        {"name": "Bass", "tuning": [-2, 0, 0, 0]}]))
    for col in ("bass_tuning_name", "bass_tuning_offsets",
                "bass_tuning_sort_key", "bass_tuning_key"):
        assert six[col] == four[col], col
    assert six["bass_tuning_name"] == "Drop D"


def test_scan_worker_bass_columns_empty_without_a_bass_arrangement(tmp_path):
    """Empty string, never None: '' is the indexed 'we looked, no bass chart'
    state, while NULL means 'never extracted' and triggers a re-scan."""
    d = _pack(tmp_path, "nobass2.sloppak", [{"name": "Lead", "tuning": [0] * 6}])
    meta = _extract_meta_for_file(d)
    assert meta["bass_tuning_name"] == ""
    assert meta["bass_tuning_sort_key"] == 0
    assert meta["bass_tuning_offsets"] == ""


def test_implausible_bass_tuning_is_never_named(tmp_path):
    """Real library data, and it is BAD DATA: AC/DC "Girls Got Rhythm" stores
    a bass tuning of [5,5,5,5,4,4] — every string up a perfect fourth, which
    no bassist plays (roughly double string tension), on a song whose guitar
    chart is dead standard.

    Truncation alone would leave [5,5,5,5] = "all strings up a 4th", which the
    namer WOULD happily name. Naming it would send a player off to retune to a
    tuning that does not exist, so the plausibility guard must refuse: bassists
    tune down, essentially never up."""
    d = _pack(tmp_path, "weird.sloppak", [
        {"name": "Lead", "tuning": [0, 0, 0, 0, 0, 0]},
        {"name": "Bass", "tuning": [5, 5, 5, 5, 4, 4]},
    ])
    meta = _extract_meta_for_file(d)
    assert meta["bass_tuning_name"] == "Custom Tuning"
    assert meta["bass_tuning_offsets"] == "5 5 5 5"
    assert meta["bass_tuning_sort_key"] == 20


@pytest.mark.parametrize("offsets", [
    [5, 5, 5, 5], [5, 5, 5, 5, 4, 4], [2, 2, 2, 2], [12, 12, 12, 12],
])
def test_up_tuned_bass_offsets_are_refused_by_the_guard(offsets):
    """Anything above +1 semitone is data we do not trust. Note the namer
    ALONE would name several of these ([2,2,2,2] -> "F# Standard"), which is
    exactly the retune-to-nowhere the guard exists to prevent."""
    norm = normalize_bass_offsets(offsets)
    assert bass_offsets_are_plausible(norm) is False
    assert bass_tuning_name(norm) == "Custom Tuning"


@pytest.mark.parametrize("offsets,expected", [
    ([0, 0, 0, 0], "E Standard"),        # standard
    ([-1, -1, -1, -1], "Eb Standard"),   # down a semitone
    ([-2, 0, 0, 0], "Drop D"),           # drop
    ([1, 1, 1, 1], "F Standard"),        # +1 is the plausible ceiling, still named
])
def test_plausible_bass_tunings_are_still_named(offsets, expected):
    """The guard must not over-fire: real down-tunings, standard, and the +1
    ceiling all keep their names."""
    assert bass_tuning_name(offsets) == expected


# ── 3. Storage round-trip + the pre-migration re-extract marker ──────────────

def test_put_get_round_trips_the_bass_columns(server_mod):
    _put(server_mod, filename="rt.sloppak", title="RT",
         tuning_name_="D Standard", tuning_sort_key=-12,
         tuning_offsets="-2 -2 -2 -2 -2 -2",
         bass_tuning_name="E Standard", bass_tuning_offsets="0 0 0 0 0 0")
    got = server_mod.meta_db.get("rt.sloppak", 1.0, 1)
    assert got["tuning_name"] == "D Standard"
    assert got["bass_tuning_name"] == "E Standard"
    assert got["bass_tuning_offsets"] == "0 0 0 0 0 0"


def test_put_never_writes_null_bass_columns(server_mod):
    """A freshly-scanned row is by definition extracted, so even a song with
    no bass chart stores '' — otherwise it would look pre-migration forever
    and the scanner would re-extract it on every single pass."""
    _put(server_mod, filename="fresh.sloppak", title="Fresh")
    row = server_mod.meta_db.conn.execute(
        "SELECT bass_tuning_name FROM songs WHERE filename = 'fresh.sloppak'").fetchone()
    assert row[0] == ""
    assert server_mod.meta_db.get("fresh.sloppak", 1.0, 1)["bass_tuning_name"] == ""


def test_pre_migration_row_reads_back_as_null(server_mod):
    """A row written before the columns existed (simulated with raw SQL that
    omits them) reads back None — the marker the scanner keys its re-extract
    on. If this ever became '' the backfill would silently never run."""
    server_mod.meta_db.conn.execute(
        "INSERT INTO songs (filename, mtime, size, title, artist, album, year, "
        "duration, tuning, arrangements, has_lyrics, format, stem_count, "
        "stem_ids, tuning_name, tuning_sort_key, tuning_offsets) "
        "VALUES ('old.sloppak', 1.0, 1, 'Old', 'A', 'A - LP', '2010', 200.0, "
        "'E Standard', '[]', 0, 'sloppak', 0, '[]', 'E Standard', 0, '0 0 0 0 0 0')")
    server_mod.meta_db.conn.commit()
    got = server_mod.meta_db.get("old.sloppak", 1.0, 1)
    assert got["bass_tuning_name"] is None
    # Same for the canonical key: coalescing this to '' would make the
    # scanner's re-extract check unfireable and strand the backfill.
    assert got["bass_tuning_key"] is None


def test_a_row_missing_only_the_canonical_key_still_re_extracts(server_mod):
    """A row scanned by an EARLIER build of this feature has bass_tuning_name
    but no bass_tuning_key. It must still be re-queued, or its custom tunings
    would group on the old serialization-dependent key forever."""
    _put(server_mod, filename="halfway.sloppak", title="Halfway",
         bass_tuning_name="Drop D", bass_tuning_offsets="-2 0 0 0")
    server_mod.meta_db.conn.execute(
        "UPDATE songs SET bass_tuning_key = NULL WHERE filename = 'halfway.sloppak'")
    server_mod.meta_db.conn.commit()
    cached = server_mod.meta_db.get("halfway.sloppak", 1.0, 1)
    assert cached["bass_tuning_name"] == "Drop D"
    assert cached["bass_tuning_key"] is None   # → the scanner re-queues it


# ── 4. The migration actually backfills (the highest-risk gap) ───────────────

@pytest.fixture()
def scan_server(tmp_path, monkeypatch, isolate_logging, reset_scan_state):
    """Server with the background scan forced in-process (see
    test_feedpak_extension.py::scan_server — the production spawn pool can't
    reach an in-process mock)."""
    import concurrent.futures
    monkeypatch.setenv("CONFIG_DIR", str(tmp_path))
    monkeypatch.delenv("DLC_DIR", raising=False)
    sys.modules.pop("server", None)
    mod = importlib.import_module("server")
    import scan as scan_mod
    monkeypatch.setattr(
        scan_mod, "_make_scan_executor",
        lambda: concurrent.futures.ThreadPoolExecutor(max_workers=4),
    )
    yield mod
    conn = getattr(getattr(mod, "meta_db", None), "conn", None)
    if conn is not None:
        getattr(sys.modules.get("server"), "_join_background_db_threads", lambda: None)()
        conn.close()


def test_existing_library_backfills_bass_tuning_on_next_scan(tmp_path, scan_server):
    """END TO END for every CURRENT user: a settled library whose rows predate
    the bass columns must re-extract on the next scan.

    Both guards are exercised together — the row-level "bass column is NULL →
    re-queue" AND the tree-signature fast path, which on an unchanged library
    would otherwise skip the listing pass entirely and strand the backfill.
    Then a second scan must NOT re-extract (the backfill converges, it doesn't
    re-scan the whole library every launch).
    """
    import unittest.mock as mock

    dlc = tmp_path / "dlc"
    dlc.mkdir()
    (dlc / "song.feedpak").write_bytes(b"")
    # json.dumps, not %s: a Windows path interpolated raw produces invalid JSON
    # escapes (\U, \d), the config silently fails to parse, and the scan then
    # reports "no DLC folder configured" and extracts nothing.
    (tmp_path / "config.json").write_text(
        json.dumps({"dlc_dir": str(dlc)}), encoding="utf-8")

    scan = importlib.import_module("scan")
    seen: list[str] = []

    def mock_extract(f, dlc_dir):
        seen.append(f.name)
        return {"title": f.name, "artist": "A", "album": "",
                "bass_tuning_name": "Drop D", "bass_tuning_sort_key": -2,
                "bass_tuning_offsets": "-2 0 0 0 0 0"}

    with mock.patch("scan_worker._extract_meta_for_file", new=mock_extract):
        scan.background_scan()
        assert "song.feedpak" in seen

        # Simulate the pre-migration state: the row exists and is otherwise
        # fresh (mtime/size match), but its bass columns were never extracted.
        scan.appstate.meta_db.conn.execute(
            "UPDATE songs SET bass_tuning_name = NULL, bass_tuning_sort_key = NULL, "
            "bass_tuning_offsets = NULL")
        scan.appstate.meta_db.conn.commit()

        seen.clear()
        scan.background_scan()
        assert "song.feedpak" in seen, (
            "a row with NULL bass columns must re-extract — otherwise no "
            "existing library ever gets the bass tuning")

        row = scan.appstate.meta_db.conn.execute(
            "SELECT bass_tuning_name, bass_tuning_offsets FROM songs "
            "WHERE filename = 'song.feedpak'").fetchone()
        assert row == ("Drop D", "-2 0 0 0 0 0")

        # Converged: the fast path is back and nothing re-extracts.
        seen.clear()
        scan.background_scan()
        assert seen == []


# ── 5. The facet endpoint ────────────────────────────────────────────────────

@pytest.fixture()
def facet_seeded(server_mod):
    """Three shapes, matching the real library's distribution:
      differ   — guitar D Standard, bass E Standard   (the bug)
      match    — both Drop D                          (common)
      nobass   — guitar Drop D, no bass chart         (fallback, common)
    """
    _put(server_mod, filename="differ.sloppak", title="Differ",
         tuning_name_="D Standard", tuning_sort_key=-12,
         tuning_offsets="-2 -2 -2 -2 -2 -2",
         bass_tuning_name="E Standard", bass_tuning_sort_key=0,
         bass_tuning_offsets="0 0 0 0 0 0")
    _put(server_mod, filename="match.sloppak", title="Match",
         tuning_name_="Drop D", tuning_sort_key=-2, tuning_offsets="-2 0 0 0 0 0",
         bass_tuning_name="Drop D", bass_tuning_sort_key=-2,
         bass_tuning_offsets="-2 0 0 0 0 0")
    _put(server_mod, filename="nobass.sloppak", title="NoBass",
         tuning_name_="Drop D", tuning_sort_key=-2, tuning_offsets="-2 0 0 0 0 0")


def _facet(client, **kw):
    return {t["name"]: t["count"]
            for t in client.get("/api/library/tuning-names", params=kw).json()["tunings"]}


def test_facet_defaults_to_the_guitar_tuning(client, facet_seeded):
    assert _facet(client) == {"D Standard": 1, "Drop D": 2}


def test_facet_bass_groups_by_bass_tuning_with_guitar_fallback(client, facet_seeded):
    """differ counts under its BASS tuning (E Standard), match under Drop D,
    and nobass — having no bass chart — falls back to its guitar Drop D rather
    than vanishing from the facet."""
    assert _facet(client, instrument="bass") == {"E Standard": 1, "Drop D": 2}


def test_facet_ignores_an_unknown_instrument(client, facet_seeded):
    """An unknown value must not silently change filter semantics."""
    assert _facet(client, instrument="theremin") == _facet(client)


# ── 6. The filter: the actual reported bug ───────────────────────────────────

def _files(client, **kw):
    return {s["filename"] for s in client.get("/api/library", params=kw).json()["songs"]}


def test_bass_filter_excludes_a_song_whose_only_match_is_its_guitar_tuning(
        client, facet_seeded):
    """THE BUG. Filtering bass "D Standard" must NOT return `differ` — its
    D Standard is the GUITAR chart; its bass is in E Standard."""
    assert _files(client, tunings="D Standard") == {"differ.sloppak"}
    assert _files(client, tunings="D Standard", instrument="bass") == set()


def test_bass_filter_returns_songs_by_their_bass_tuning(client, facet_seeded):
    """…and the converse: bass "E Standard" finds `differ`, which the guitar
    filter would never return."""
    assert _files(client, tunings="E Standard") == set()
    assert _files(client, tunings="E Standard", instrument="bass") == {"differ.sloppak"}


def test_bass_filter_keeps_songs_without_a_bass_arrangement_via_fallback(
        client, facet_seeded):
    """The most common shape. `nobass` has no bass chart, so it must still be
    reachable under its guitar tuning instead of disappearing for bass users —
    and the facet's count for that pill must equal what the filter returns."""
    got = _files(client, tunings="Drop D", instrument="bass")
    assert got == {"match.sloppak", "nobass.sloppak"}
    assert _facet(client, instrument="bass")["Drop D"] == len(got)


def test_custom_bass_tunings_stay_distinct_under_their_offsets(client, server_mod):
    """Two unnameable bass tunings both label "Custom Tuning"; the facet keys
    them on raw offsets so selecting one doesn't drag in the other. Uses the
    real [5,5,5,5,4,4] shape from the library."""
    _put(server_mod, filename="c1.sloppak", title="C1",
         bass_tuning_name="Custom Tuning", bass_tuning_sort_key=28,
         bass_tuning_offsets="5 5 5 5 4 4")
    _put(server_mod, filename="c2.sloppak", title="C2",
         bass_tuning_name="Custom Tuning", bass_tuning_sort_key=-7,
         bass_tuning_offsets="-3 -1 -1 -1 -1 0")
    keys = [t["key"] for t in client.get(
        "/api/library/tuning-names", params={"instrument": "bass"}).json()["tunings"]
        if t["name"] == "Custom Tuning"]
    assert sorted(keys) == sorted(["5 5 5 5 4 4", "-3 -1 -1 -1 -1 0"])
    assert _files(client, tunings="5 5 5 5 4 4", instrument="bass") == {"c1.sloppak"}


def test_stats_facet_counts_agree_with_the_bass_filter(client, facet_seeded):
    """The A–Z rail / count surface must apply the same instrument-aware
    predicate as the grid, or the header count contradicts the results."""
    body = client.get("/api/library/stats", params={
        "tunings": "Drop D", "instrument": "bass"}).json()
    assert body["total_songs"] == 2


# ── 7. Sort ──────────────────────────────────────────────────────────────────

def test_tuning_sort_respects_the_instrument(client, facet_seeded):
    """Tuning sort is musical distance from E Standard. For a bass player that
    distance must be measured on the BASS tuning: `differ` is the furthest
    song by guitar (D Standard, |−12|) but the nearest by bass (E Standard, 0),
    so it moves from last to first."""
    def order(**kw):
        return [s["filename"] for s in client.get(
            "/api/library", params={"sort": "tuning", **kw}).json()["songs"]]

    guitar = order()
    assert guitar[-1] == "differ.sloppak"
    bass = order(instrument="bass")
    assert bass[0] == "differ.sloppak"


# ── 8. Song payload ──────────────────────────────────────────────────────────

# ── 9. Real-library offset SHAPES ────────────────────────────────────────────
# Measured across the 59-pack test library: bass offset lists are NOT reliably
# 4 or reliably 6 — 41 store six elements, 1 stores four. Two six-element ones
# diverge in the tail (AC/DC "Girls Got Rhythm" [5,5,5,5,4,4]; Intervals
# "Libra" [-2,0,0,0,0,0]). Nothing may crash or mislabel on any of them.

@pytest.mark.parametrize("offsets,expected", [
    ([0, 0, 0, 0], "E Standard"),                 # four-element (the 1 outlier)
    ([0, 0, 0, 0, 0, 0], "E Standard"),           # six-element all-equal (39 of them)
    ([-1, -1, -1, -1], "Eb Standard"),            # four-element, down a semitone
    ([5, 5, 5, 5, 4, 4], "Custom Tuning"),        # AC/DC — divergent tail
    ([-2, 0, 0, 0, 0, 0], "Drop D"),              # Intervals — drop + trailing zeros
    ([0, 0, 0, 0, 0], "Custom Tuning"),           # five: no naming convention → custom
])
def test_real_library_bass_offset_shapes_name_without_crashing(offsets, expected):
    assert tuning_name(offsets) == expected


@pytest.mark.parametrize("offsets", [
    [0, 0, 0, 0], [0, 0, 0, 0, 0, 0], [5, 5, 5, 5, 4, 4], [-2, 0, 0, 0, 0, 0],
])
def test_real_library_bass_offset_shapes_survive_extraction(tmp_path, offsets):
    """Each shape must round-trip the real extractor + scanner derivation,
    landing on the NORMALIZED (truncated, plausibility-checked) columns."""
    norm = normalize_bass_offsets(offsets)
    d = _pack(tmp_path, "shape.sloppak", [
        {"name": "Lead", "tuning": [0, 0, 0, 0, 0, 0]},
        {"name": "Bass", "tuning": offsets},
    ])
    meta = _extract_meta_for_file(d)
    assert meta["bass_tuning_name"] == bass_tuning_name(norm)
    assert meta["bass_tuning_offsets"] == " ".join(str(o) for o in norm)
    assert meta["bass_tuning_sort_key"] == sum(norm)
    assert meta["bass_tuning_key"] == bass_tuning_key(norm)


def test_named_bass_tunings_group_across_serialization_lengths(client, server_mod):
    """The length question does NOT fragment NAMED tunings: a bass stored as
    four elements and one stored as six both name "E Standard", and the facet
    groups by name — so they land in ONE row with a combined count. This is the
    common case (40 of the 42 bass arrangements in the real library)."""
    _put(server_mod, filename="four.sloppak", title="Four",
         bass_tuning_name=tuning_name([0, 0, 0, 0]), bass_tuning_offsets="0 0 0 0")
    _put(server_mod, filename="six.sloppak", title="Six",
         bass_tuning_name=tuning_name([0, 0, 0, 0, 0, 0]),
         bass_tuning_offsets="0 0 0 0 0 0")
    assert _facet(client, instrument="bass") == {"E Standard": 2}
    assert _files(client, tunings="E Standard", instrument="bass") == {
        "four.sloppak", "six.sloppak"}


def test_drop_d_bass_groups_across_serialization_lengths(client, server_mod):
    """Same for the Intervals shape: [-2,0,0,0,0,0] and [-2,0,0,0] both name
    "Drop D", so trailing zeros can't split a named tuning into two rows."""
    _put(server_mod, filename="d6.sloppak", title="D6",
         bass_tuning_name=tuning_name([-2, 0, 0, 0, 0, 0]),
         bass_tuning_sort_key=-2, bass_tuning_offsets="-2 0 0 0 0 0")
    _put(server_mod, filename="d4.sloppak", title="D4",
         bass_tuning_name=tuning_name([-2, 0, 0, 0]),
         bass_tuning_sort_key=-2, bass_tuning_offsets="-2 0 0 0")
    assert _facet(client, instrument="bass") == {"Drop D": 2}


def test_equivalent_custom_bass_tunings_group_into_one_facet_row(client, server_mod):
    """Two CUSTOM bass tunings that are the same physical tuning must be ONE
    facet row, however they were serialized. They group on canonical PITCHES
    (bass_tuning_key), so the offsets string no longer fragments them —
    previously this produced two rows with split counts."""
    key = bass_tuning_key([-3, -1, -1, -1])
    _put(server_mod, filename="c6.sloppak", title="C6",
         bass_tuning_name="Custom Tuning", bass_tuning_sort_key=-6,
         bass_tuning_offsets="-3 -1 -1 -1", bass_tuning_key=key)
    _put(server_mod, filename="c4.sloppak", title="C4",
         bass_tuning_name="Custom Tuning", bass_tuning_sort_key=-6,
         bass_tuning_offsets="-3 -1 -1 -1", bass_tuning_key=key)
    rows = client.get("/api/library/tuning-names",
                      params={"instrument": "bass"}).json()["tunings"]
    customs = [t for t in rows if t["name"] == "Custom Tuning"]
    assert len(customs) == 1 and customs[0]["count"] == 2
    assert _files(client, tunings=customs[0]["key"], instrument="bass") == {
        "c6.sloppak", "c4.sloppak"}


def test_canonical_key_is_pitch_not_serialization(tmp_path):
    """The property that makes the grouping robust: two serializations of one
    tuning yield the same key, and two genuinely different tunings do not."""
    assert bass_tuning_key(normalize_bass_offsets([-2, 0, 0, 0, 0, 0])) == \
        bass_tuning_key(normalize_bass_offsets([-2, 0, 0, 0]))
    assert bass_tuning_key([-2, 0, 0, 0]) != bass_tuning_key([-3, 0, 0, 0])
    # Absolute open pitches of a standard 4-string bass (E1 A1 D2 G2).
    assert bass_tuning_key([0, 0, 0, 0]) == "bass:28:33:38:43"


def test_custom_bass_facet_row_selects_exactly_what_it_counted(client, server_mod):
    """Whatever the grouping rule, the invariant that must NEVER break: every
    facet row's count equals the number of songs its own key returns. This is
    what makes the seam safe to change — a normalization that merged rows but
    not the filter would fail here."""
    _put(server_mod, filename="x6.sloppak", title="X6",
         bass_tuning_name="Custom Tuning", bass_tuning_sort_key=28,
         bass_tuning_offsets="5 5 5 5 4 4")
    _put(server_mod, filename="x4.sloppak", title="X4",
         bass_tuning_name="Custom Tuning", bass_tuning_sort_key=20,
         bass_tuning_offsets="5 5 5 5")
    _put(server_mod, filename="plain.sloppak", title="Plain",
         bass_tuning_name="E Standard", bass_tuning_offsets="0 0 0 0 0 0")
    for row in client.get("/api/library/tuning-names",
                          params={"instrument": "bass"}).json()["tunings"]:
        got = _files(client, tunings=row["key"], instrument="bass")
        assert len(got) == row["count"], (
            f"facet row {row['key']!r} counted {row['count']} but selects {len(got)}")


# ── 10. THE HEADLINE REGRESSION ──────────────────────────────────────────────

def test_covet_shibuya_is_findable_by_a_bassist(tmp_path, server_mod, client):
    """Covet - "Shibuya" (Effloresce): the guitar is in a custom tuning
    [-2,0,0,-1,-2,0] while the bass is dead standard. This is the tester's bug
    in one song — a bassist filtering "E Standard" never saw it, because the
    library only knew the guitar's custom tuning.

    Round-tripped through the REAL extractor and scanner derivation, not
    hand-written columns, so it covers the whole chain."""
    d = _pack(tmp_path, "shibuya.sloppak", [
        {"name": "Lead", "tuning": [-2, 0, 0, -1, -2, 0]},
        {"name": "Bass", "tuning": [0, 0, 0, 0, 0, 0]},
    ])
    meta = _extract_meta_for_file(d)
    server_mod.meta_db.put("shibuya.sloppak", 1.0, 1, {
        **meta, "title": "Shibuya", "artist": "Covet", "album": "Effloresce"})

    # The guitar chart really is a custom tuning…
    assert meta["tuning_name"] == "Custom Tuning"
    # …and the bass chart really is standard.
    assert meta["bass_tuning_name"] == "E Standard"

    # Before the fix a bassist filtering E Standard got nothing.
    assert _files(client, tunings="E Standard") == set()
    assert _files(client, tunings="E Standard", instrument="bass") == {"shibuya.sloppak"}

    # And it appears in the bass facet under E Standard, as a REAL bass chart
    # (not an inferred fallback).
    row = next(t for t in client.get(
        "/api/library/tuning-names", params={"instrument": "bass"}).json()["tunings"]
        if t["name"] == "E Standard")
    assert row["count"] == 1 and row["inferred_count"] == 0


# ── 11. Provenance: the fallback must be honest, never silent ────────────────

def test_facet_reports_how_many_rows_are_inferred_from_the_guitar_chart(
        client, facet_seeded):
    """The fallback keeps no-bass-chart songs visible (a third of a real
    library), but the UI must be able to say so. `nobass` has no bass chart and
    rides under the guitar's Drop D; `match` has a real one."""
    rows = {t["name"]: t for t in client.get(
        "/api/library/tuning-names", params={"instrument": "bass"}).json()["tunings"]}
    assert rows["Drop D"]["count"] == 2
    assert rows["Drop D"]["inferred_count"] == 1      # nobass only
    assert rows["E Standard"]["inferred_count"] == 0  # differ has a real bass chart


def test_guitar_facet_reports_no_inferred_rows(client, facet_seeded):
    """Guitar is never a fallback perspective, so nothing is ever inferred."""
    rows = client.get("/api/library/tuning-names").json()["tunings"]
    assert all(t["inferred_count"] == 0 for t in rows)


def test_song_rows_mark_an_inferred_tuning(client, facet_seeded):
    """A bass player's row must be distinguishable: native bass chart vs
    borrowed from the guitar. Without this the card silently presents a guitar
    tuning as the bass tuning — the original bug in a new place."""
    rows = {s["filename"]: s for s in client.get(
        "/api/library", params={"instrument": "bass"}).json()["songs"]}
    assert rows["differ.sloppak"]["tuning_inferred"] is False
    assert rows["nobass.sloppak"]["tuning_inferred"] is True
    assert rows["differ.sloppak"]["tuning_perspective"] == "bass"


def test_guitar_rows_carry_no_bass_perspective_fields(client, facet_seeded):
    """The guitar payload is untouched — no perspective/inferred keys at all."""
    row = client.get("/api/library").json()["songs"][0]
    assert "tuning_inferred" not in row and "tuning_perspective" not in row


def test_arrangements_has_bass_is_the_real_bass_chart_lever(server_mod, client):
    """'Only songs with a real bass chart' is the EXISTING `arrangements_has`
    filter — no new filter, no "confirmed tunings" checkbox. It composes with
    the tuning filter, so a bassist who wants to exclude inferred rows already
    can, and it is already expressible in a saved collection rule."""
    def put_with_arrs(fn, arrs, **kw):
        server_mod.meta_db.put(fn, 1.0, 1, {
            "title": fn, "artist": "A", "album": "A - LP", "year": "2010",
            "duration": 200.0, "tuning": "Drop D", "arrangements": arrs,
            "has_lyrics": False, "format": "sloppak", "stem_ids": [],
            "tuning_name": "Drop D", "tuning_sort_key": -2,
            "tuning_offsets": "-2 0 0 0 0 0", **kw})

    put_with_arrs("withbass.sloppak",
                  [{"index": 0, "name": "Lead"}, {"index": 1, "name": "Bass"}],
                  bass_tuning_name="Drop D", bass_tuning_sort_key=-2,
                  bass_tuning_offsets="-2 0 0 0",
                  bass_tuning_key=bass_tuning_key([-2, 0, 0, 0]))
    put_with_arrs("nobass.sloppak", [{"index": 0, "name": "Lead"}])

    # Both are reachable under the bass Drop D pill (the fallback keeps the
    # no-bass-chart song visible)…
    assert _files(client, tunings="Drop D", instrument="bass") == {
        "withbass.sloppak", "nobass.sloppak"}
    # …and the existing arrangements_has lever narrows to real bass charts.
    assert _files(client, tunings="Drop D", instrument="bass",
                  arrangements_has="Bass") == {"withbass.sloppak"}


def test_song_rows_carry_the_bass_tuning_for_the_client(client, facet_seeded):
    """The card renders the bass tuning client-side, so the row must ship it —
    and ship '' (not the guitar value) when there is no bass chart, so the
    client's fallback stays the client's decision."""
    rows = {s["filename"]: s for s in client.get("/api/library").json()["songs"]}
    assert rows["differ.sloppak"]["tuning_name"] == "D Standard"
    assert rows["differ.sloppak"]["bass_tuning_name"] == "E Standard"
    assert rows["differ.sloppak"]["bass_tuning_offsets"] == "0 0 0 0 0 0"
    assert rows["nobass.sloppak"]["bass_tuning_name"] == ""
