"""Tests for P5e: the grouped filter law (chart-intrinsic filters match ANY
member of a work + the display_chart switch), the group-aggregate mastery
sort, the history-sticky auto-pick, and the split annotations."""

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


def _put(server, fn, title, artist, arrangements=1, tuning="E Standard",
         mtime=0, lyrics=False):
    arr = [{"name": "Lead", "index": i} for i in range(arrangements)]
    server.meta_db.put(fn, mtime, 0, {
        "title": title, "artist": artist, "arrangements": arr,
        "tuning_name": tuning, "has_lyrics": lyrics,
    })


def _page(client, **params):
    return client.get("/api/library", params={"group": 1, **params}).json()


# ── chart-intrinsic filters: match if ANY member matches ─────────────────────

def test_intrinsic_filter_matches_any_member(client, server):
    _put(server, "a.archive", "Song", "Artist", arrangements=2, tuning="E Standard")
    _put(server, "b.archive", "Song", "Artist", arrangements=1, tuning="Drop D")
    body = _page(client, tunings="Drop D")
    # the work qualifies through member b even though the representative (a,
    # most arrangements) is E Standard…
    assert body["total"] == 1
    row = body["songs"][0]
    # …and the ROW stays the representative (sort/cursor identity) while the
    # card's display/play facts switch to the matching member.
    assert row["filename"] == "a.archive"
    assert row["display_chart"]["filename"] == "b.archive"
    assert row["display_chart"]["tuning_name"] == "Drop D"


def test_no_display_chart_when_rep_matches(client, server):
    _put(server, "a.archive", "Song", "Artist", arrangements=2, tuning="Drop D")
    _put(server, "b.archive", "Song", "Artist", arrangements=1, tuning="Drop D")
    row = _page(client, tunings="Drop D")["songs"][0]
    assert row["filename"] == "a.archive"
    assert "display_chart" not in row


def test_intrinsic_filter_ungrouped_unchanged(client, server):
    _put(server, "a.archive", "Song", "Artist", arrangements=2, tuning="E Standard")
    _put(server, "b.archive", "Song", "Artist", arrangements=1, tuning="Drop D")
    body = client.get("/api/library", params={"tunings": "Drop D"}).json()
    assert body["total"] == 1
    assert body["songs"][0]["filename"] == "b.archive"
    assert "display_chart" not in body["songs"][0]


def test_lyrics_filter_matches_any_member(client, server):
    _put(server, "a.archive", "Song", "Artist", arrangements=2, lyrics=False)
    _put(server, "b.archive", "Song", "Artist", arrangements=1, lyrics=True)
    body = _page(client, has_lyrics=1)
    assert body["total"] == 1
    assert body["songs"][0]["display_chart"]["filename"] == "b.archive"


def test_stats_count_matches_page_under_filter(client, server):
    _put(server, "a.archive", "Song", "Artist", arrangements=2, tuning="E Standard")
    _put(server, "b.archive", "Song", "Artist", arrangements=1, tuning="Drop D")
    _put(server, "c.archive", "Other", "Artist", tuning="E Standard")   # no Drop D chart
    page = _page(client, tunings="Drop D")
    stats = client.get("/api/library/stats",
                       params={"group": 1, "tunings": "Drop D"}).json()
    assert page["total"] == 1
    assert stats["total_songs"] == page["total"]


# ── work-identity + practice-state stay on the representative ────────────────

def test_practice_state_anchors_on_preferred(client, server):
    _put(server, "a.archive", "Song", "Artist", arrangements=2)   # unplayed
    _put(server, "b.archive", "Song", "Artist", arrangements=1)
    server.meta_db.record_session("b.archive", 0, score=950, accuracy=0.95)
    # pin the unplayed chart as YOUR pick (without a pin the played chart is
    # the sticky auto-rep, so the anchor would legitimately read mastered)
    wk = server.meta_db.work_key_for("a.archive")
    server.meta_db.set_chart_preferred(wk, "a.archive")
    # mastered band reads the PREFERRED chart (unplayed) — the work is not
    # "mastered" just because an alternate chart is (§7.1 practice-state law)
    assert _page(client, mastery="mastered")["total"] == 0
    # …but the flat view still finds the mastered chart itself
    flat = client.get("/api/library", params={"mastery": "mastered"}).json()
    assert [s["filename"] for s in flat["songs"]] == ["b.archive"]


# ── mastery sort aggregates MAX across the group ─────────────────────────────

def test_mastery_sort_aggregates_across_group(client, server):
    _put(server, "a1.archive", "One", "Artist", arrangements=2)
    _put(server, "a2.archive", "One", "Artist", arrangements=1)
    _put(server, "b.archive", "Two", "Artist")                    # singleton work 2
    server.meta_db.record_session("a2.archive", 0, score=950, accuracy=0.95)
    server.meta_db.record_session("b.archive", 0, score=500, accuracy=0.5)
    # pin the UNPLAYED chart as work 1's keeper — the aggregate must still
    # surface the work via its touched member ("a song surfaces on any chart
    # you've touched"), even though the preferred chart has no stats
    wk = server.meta_db.work_key_for("a1.archive")
    server.meta_db.set_chart_preferred(wk, "a1.archive")
    desc = [s["filename"] for s in _page(client, sort="mastery-desc")["songs"]]
    assert desc == ["a1.archive", "b.archive"]                    # 0.95 > 0.5, row = keeper
    asc = [s["filename"] for s in _page(client, sort="mastery")["songs"]]
    assert asc == ["b.archive", "a1.archive"]


# ── history-sticky auto-pick ──────────────────────────────────────────────────

def test_autopick_sticks_with_played_chart(client, server):
    _put(server, "a.archive", "Song", "Artist", arrangements=1, mtime=1)
    server.meta_db.record_session("a.archive", 0, score=500, accuracy=0.5)
    # a newer, more complete chart imports — the pick must NOT silently migrate
    _put(server, "b.archive", "Song", "Artist", arrangements=3, mtime=2)
    assert _page(client)["songs"][0]["filename"] == "a.archive"


def test_autopick_completeness_still_wins_when_unplayed(client, server):
    _put(server, "a.archive", "Song", "Artist", arrangements=1, mtime=1)
    _put(server, "b.archive", "Song", "Artist", arrangements=3, mtime=2)
    assert _page(client)["songs"][0]["filename"] == "b.archive"


def test_autopick_one_off_try_does_not_steal_pick(client, server):
    # incumbent: practiced repeatedly, minimal chart; a one-off try of a more
    # complete alternate must NOT retarget the pick (casual try ≠ adopt)
    _put(server, "a.archive", "Song", "Artist", arrangements=1, mtime=1)
    for _ in range(3):
        server.meta_db.record_session("a.archive", 0, score=500, accuracy=0.5)
    _put(server, "b.archive", "Song", "Artist", arrangements=3, mtime=2)
    server.meta_db.record_session("b.archive", 0, score=500, accuracy=0.5)
    assert _page(client)["songs"][0]["filename"] == "a.archive"


# ── split annotations (the ⋮ "Rejoin other versions" undo) ───────────────────

def test_split_flags_on_rows_and_chart_work(client, server):
    _put(server, "a.archive", "Song", "Artist")
    _put(server, "b.archive", "Song", "Artist")
    client.post("/api/chart/b.archive/split")
    rows = {s["filename"]: s for s in _page(client)["songs"]}
    assert rows["b.archive"]["is_split"] is True
    assert rows["a.archive"]["is_split"] is False
    assert client.get("/api/chart/b.archive/work").json()["is_split"] is True
    assert client.get("/api/chart/a.archive/work").json()["is_split"] is False


# ── keyset paging stays exact under the member-match predicate ────────────────

def test_grouped_keyset_pagination_with_intrinsic_filter(client, server):
    # 5 works; each has an E-Standard rep (2 arrangements) + a Drop-D member,
    # so the Drop-D filter admits every work through a NON-representative chart.
    for i in range(5):
        _put(server, f"w{i}rep.archive", f"Song {i}", f"Artist {i}",
             arrangements=2, tuning="E Standard")
        _put(server, f"w{i}alt.archive", f"Song {i}", f"Artist {i}",
             arrangements=1, tuning="Drop D")
    seen, cursor = [], None
    for _ in range(10):
        # Title sort — the keyset proof needs a sort that still keysets
        # (artist sorts page by OFFSET since the title-secondary change).
        params = {"group": 1, "tunings": "Drop D", "size": 2, "sort": "title"}
        if cursor:
            params["after"] = cursor
        body = client.get("/api/library", params=params).json()
        if not body["songs"]:
            break
        seen += [s["filename"] for s in body["songs"]]
        cursor = body["next_cursor"]
        if not cursor:
            break
    assert seen == [f"w{i}rep.archive" for i in range(5)]   # no skip, no dupe
    assert all(s.startswith("w") and "rep" in s for s in seen)
