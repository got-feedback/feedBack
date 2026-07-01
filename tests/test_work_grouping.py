"""Tests for the multi-chart grouping engine (P5a): several charts (feedpak rows)
of the same WORK collapse to one representative card via a materialized
work_display read-model + a `group=1` `WHERE is_group_representative=1` predicate.
Counting works (not charts), auto-pick, chart_group_pref, split, and keyset
paging under grouping all stay correct."""

import importlib
import sys

import pytest
from fastapi.testclient import TestClient


@pytest.fixture()
def server(tmp_path, monkeypatch, isolate_logging):
    monkeypatch.setenv("CONFIG_DIR", str(tmp_path))
    monkeypatch.setenv("FEEDBACK_SKIP_STARTUP_TASKS", "1")
    sys.modules.pop("server", None)
    srv = importlib.import_module("server")
    try:
        yield srv
    finally:
        conn = getattr(getattr(srv, "meta_db", None), "conn", None)
        if conn is not None:
            conn.close()
        sys.modules.pop("server", None)


@pytest.fixture()
def client(server):
    return TestClient(server.app)


def _put(server, fn, title, artist, arrangements=1, mtime=0.0):
    arr = [{"name": "Lead", "index": i} for i in range(arrangements)]
    server.meta_db.put(fn, mtime, 0, {"title": title, "artist": artist, "arrangements": arr})


def _grouped(client, **params):
    params["group"] = 1
    return client.get("/api/library", params=params).json()


# ── Baseline: ungrouped shows every chart ────────────────────────────────────

def test_ungrouped_shows_all_charts(client, server):
    _put(server, "a.archive", "Song", "Artist")
    _put(server, "b.archive", "Song", "Artist")
    body = client.get("/api/library").json()
    assert body["total"] == 2
    assert {s["filename"] for s in body["songs"]} == {"a.archive", "b.archive"}
    # ungrouped rows carry no chart_count (only the grouped path attaches it)
    assert "chart_count" not in body["songs"][0]


# ── Grouping collapses a work to one representative ───────────────────────────

def test_grouping_collapses_to_one_representative(client, server):
    _put(server, "a.archive", "Song", "Artist", arrangements=1)
    _put(server, "b.archive", "Song", "Artist", arrangements=2)
    body = _grouped(client)
    assert body["total"] == 1
    assert len(body["songs"]) == 1
    rep = body["songs"][0]
    assert rep["filename"] == "b.archive"     # most arrangements wins auto-pick
    assert rep["chart_count"] == 2


def test_autopick_plays_tiebreak(client, server):
    _put(server, "a.archive", "S", "A", arrangements=1)
    _put(server, "b.archive", "S", "A", arrangements=1)
    server.meta_db.record_session("a.archive", 0, score=100, accuracy=0.5)  # a has a play
    assert _grouped(client)["songs"][0]["filename"] == "a.archive"


def test_autopick_filename_tiebreak(client, server):
    _put(server, "b.archive", "S", "A")
    _put(server, "a.archive", "S", "A")
    # equal arrangements + plays + mtime → lowest filename
    assert _grouped(client)["songs"][0]["filename"] == "a.archive"


# ── chart_group_pref override ────────────────────────────────────────────────

def test_preferred_overrides_autopick(client, server):
    _put(server, "a.archive", "S", "A", arrangements=2)   # would auto-win
    _put(server, "b.archive", "S", "A", arrangements=1)
    wk = server.meta_db.work_key_for("b.archive")
    server.meta_db.set_chart_preferred(wk, "b.archive")
    assert _grouped(client)["songs"][0]["filename"] == "b.archive"


def test_set_preferred_incremental_reflip(client, server):
    _put(server, "a.archive", "S", "A", arrangements=2)
    _put(server, "b.archive", "S", "A", arrangements=1)
    assert _grouped(client)["songs"][0]["filename"] == "a.archive"   # builds read-model
    wk = server.meta_db.work_key_for("a.archive")
    server.meta_db.set_chart_preferred(wk, "b.archive")             # incremental re-flip
    body = _grouped(client)
    assert body["songs"][0]["filename"] == "b.archive"
    assert body["songs"][0]["chart_count"] == 2                     # group_size unchanged


def test_clear_preferred_returns_to_autopick(client, server):
    _put(server, "a.archive", "S", "A", arrangements=2)
    _put(server, "b.archive", "S", "A", arrangements=1)
    wk = server.meta_db.work_key_for("a.archive")
    server.meta_db.set_chart_preferred(wk, "b.archive")
    assert _grouped(client)["songs"][0]["filename"] == "b.archive"
    server.meta_db.clear_chart_preferred(wk)
    assert _grouped(client)["songs"][0]["filename"] == "a.archive"  # auto again


# ── Split / un-split ─────────────────────────────────────────────────────────

def test_split_makes_singleton(client, server):
    _put(server, "a.archive", "S", "A")
    _put(server, "b.archive", "S", "A")
    assert _grouped(client)["total"] == 1
    server.meta_db.split_chart("b.archive")
    body = _grouped(client)
    assert body["total"] == 2                                       # two works now
    assert {s["filename"] for s in body["songs"]} == {"a.archive", "b.archive"}
    assert all(s["chart_count"] == 1 for s in body["songs"])


def test_unsplit_rejoins(client, server):
    _put(server, "a.archive", "S", "A")
    _put(server, "b.archive", "S", "A")
    server.meta_db.split_chart("b.archive")
    assert _grouped(client)["total"] == 2
    server.meta_db.unsplit_chart("b.archive")
    assert _grouped(client)["total"] == 1


# ── Stats + A–Z count works, not charts ──────────────────────────────────────

def test_stats_counts_works_not_charts(client, server):
    _put(server, "a.archive", "Song", "Artist")
    _put(server, "b.archive", "Song", "Artist")   # same work as a
    _put(server, "c.archive", "Other", "Artist")
    assert client.get("/api/library/stats").json()["total_songs"] == 3
    assert client.get("/api/library/stats", params={"group": 1}).json()["total_songs"] == 2


def test_sort_letters_counts_works(client, server):
    _put(server, "a.archive", "Song", "Alpha")
    _put(server, "b.archive", "Song", "Alpha")    # same work
    _put(server, "c.archive", "Track", "Beta")
    sl = client.get("/api/library/stats",
                    params={"group": 1, "sort_letters": 1, "sort": "artist"}).json()["sort_letters"]
    assert sl.get("A") == 1 and sl.get("B") == 1


# ── Keyset paging under grouping (the critical integration) ───────────────────

def test_grouped_keyset_pagination(client, server):
    for i in range(5):
        _put(server, f"w{i}_a.archive", f"Song {i}", "Artist")
        _put(server, f"w{i}_b.archive", f"Song {i}", "Artist")   # 2 charts per work
    body = client.get("/api/library", params={"group": 1, "size": 3}).json()
    assert body["total"] == 5 and len(body["songs"]) == 3
    cur = body["next_cursor"]
    assert cur
    body2 = client.get("/api/library", params={"group": 1, "size": 3, "after": cur}).json()
    assert len(body2["songs"]) == 2
    p1 = {s["filename"] for s in body["songs"]}
    p2 = {s["filename"] for s in body2["songs"]}
    assert not (p1 & p2)                                            # no skip / dupe across pages


# ── Freshness: adding a chart regroups; overrides survive reindex ─────────────

def test_new_chart_updates_group_size(client, server):
    _put(server, "a.archive", "S", "A")
    assert _grouped(client)["songs"][0]["chart_count"] == 1
    _put(server, "b.archive", "S", "A")                            # dirties read-model
    body = _grouped(client)
    assert body["total"] == 1 and body["songs"][0]["chart_count"] == 2


def test_preferred_survives_reindex(client, server):
    _put(server, "a.archive", "S", "A", arrangements=2)
    _put(server, "b.archive", "S", "A", arrangements=1)
    wk = server.meta_db.work_key_for("b.archive")
    server.meta_db.set_chart_preferred(wk, "b.archive")
    assert _grouped(client)["songs"][0]["filename"] == "b.archive"
    # A rescan re-indexes both charts (INSERT OR REPLACE INTO songs).
    _put(server, "a.archive", "S", "A", arrangements=2)
    _put(server, "b.archive", "S", "A", arrangements=1)
    assert _grouped(client)["songs"][0]["filename"] == "b.archive"  # pref survived


# ── work_key normalization folds trivial differences ─────────────────────────

def test_work_key_folds_the_and_punctuation(server):
    wk = server.meta_db._work_key
    assert wk("The Beatles", "Hey Jude") == wk("beatles", "hey jude!")
    assert wk("AC/DC", "T.N.T.") == wk("acdc", "tnt")
    assert wk("Metallica", "One") != wk("Metallica", "Two")
