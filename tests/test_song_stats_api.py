"""Tests for the song-stats endpoints + XP/streak side-effects (P14)."""

import importlib
import sys

import pytest
from fastapi.testclient import TestClient


@pytest.fixture()
def server(tmp_path, monkeypatch, isolate_logging):
    monkeypatch.setenv("CONFIG_DIR", str(tmp_path))
    monkeypatch.setenv("SLOPSMITH_SKIP_STARTUP_TASKS", "1")
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


def test_scored_session_persists_and_increments_plays(client):
    r = client.post("/api/stats", json={"filename": "song.archive", "arrangement": 0,
                                        "score": 400, "accuracy": 0.6, "lastPlayPosition": 30.0})
    assert r.status_code == 200
    row = r.json()["stats"]
    assert row["plays"] == 1 and row["best_score"] == 400 and row["best_accuracy"] == pytest.approx(0.6)
    # A better replay raises best_* but plays keeps incrementing.
    r2 = client.post("/api/stats", json={"filename": "song.archive", "score": 800, "accuracy": 0.9})
    row2 = r2.json()["stats"]
    assert row2["plays"] == 2
    assert row2["best_score"] == 800 and row2["best_accuracy"] == pytest.approx(0.9)
    assert row2["last_score"] == 800
    # A worse replay: best preserved, last replaced, plays still up.
    r3 = client.post("/api/stats", json={"filename": "song.archive", "score": 100, "accuracy": 0.3})
    row3 = r3.json()["stats"]
    assert row3["plays"] == 3
    assert row3["best_score"] == 800 and row3["best_accuracy"] == pytest.approx(0.9)
    assert row3["last_score"] == 100


def test_scored_session_awards_xp_and_streak(client, server):
    assert server.meta_db.get_xp() == 0
    from xp import xp_for_run
    r = client.post("/api/stats", json={"filename": "s.archive", "score": 900, "accuracy": 0.95})
    prog = r.json()["progress"]
    assert prog is not None
    assert prog["xp"] == xp_for_run(900)
    assert prog["current_streak"] == 1   # streak bumped today


def test_position_only_touch_does_not_increment_plays(client):
    r = client.post("/api/stats", json={"filename": "x.archive", "lastPlayPosition": 42.0})
    assert r.status_code == 200
    row = r.json()["stats"]
    assert row["plays"] == 0 and row["last_position"] == 42.0
    # A resume touch awards no XP but DOES count as playing today (streak).
    prog = r.json()["progress"]
    assert prog is not None and prog["current_streak"] == 1 and prog["xp"] == 0
    # A later scored session counts as the first play.
    r2 = client.post("/api/stats", json={"filename": "x.archive", "score": 100, "accuracy": 0.5})
    assert r2.json()["stats"]["plays"] == 1
    # The earlier resume position is preserved through the scored upsert? The
    # scored session omitted last_position, so it should keep 42.0.
    assert r2.json()["stats"]["last_position"] == 42.0


def test_stats_requires_filename(client):
    assert client.post("/api/stats", json={"score": 1, "accuracy": 1}).status_code == 400


def test_stats_requires_score_or_position(client):
    assert client.post("/api/stats", json={"filename": "a.archive"}).status_code == 400


def test_get_song_stats_aggregates_arrangements(client):
    client.post("/api/stats", json={"filename": "multi.archive", "arrangement": 0, "score": 300, "accuracy": 0.5})
    client.post("/api/stats", json={"filename": "multi.archive", "arrangement": 1, "score": 700, "accuracy": 0.8})
    body = client.get("/api/stats/multi.archive").json()
    assert body["plays"] == 2
    assert body["best_score"] == 700 and body["best_accuracy"] == pytest.approx(0.8)
    assert len(body["arrangements"]) == 2


def test_recent_orders_by_last_played(client, server):
    for fn in ("first.archive", "second.archive"):
        server.meta_db.put(fn, 0, 0, {})
    client.post("/api/stats", json={"filename": "first.archive", "score": 100, "accuracy": 0.5})
    client.post("/api/stats", json={"filename": "second.archive", "score": 200, "accuracy": 0.6})
    recent = client.get("/api/stats/recent?limit=10").json()
    names = [r["filename"] for r in recent]
    # Most-recent first; both present.
    assert names[0] == "second.archive"
    assert "first.archive" in names
    # Rows carry metadata fields for the dashboard.
    assert "art_url" in recent[0] and "title" in recent[0]


def test_top_orders_by_best_score_and_enriches(client, server):
    # The profile "Your best scores" panel: top songs by best score, descending,
    # joined to metadata. A worse-scored and a resume-only song must rank below /
    # be excluded respectively.
    server.meta_db.put("low.archive", 0, 0, {"title": "Low", "artist": "A"})
    server.meta_db.put("high.archive", 0, 0, {"title": "High", "artist": "B"})
    server.meta_db.put("resume.archive", 0, 0, {"title": "Resume"})
    client.post("/api/stats", json={"filename": "low.archive", "score": 100, "accuracy": 0.5})
    client.post("/api/stats", json={"filename": "high.archive", "score": 900, "accuracy": 0.95})
    client.post("/api/stats", json={"filename": "resume.archive", "lastPlayPosition": 12.0})  # plays==0
    top = client.get("/api/stats/top").json()
    names = [r["filename"] for r in top]
    assert names[:2] == ["high.archive", "low.archive"]   # best score first
    assert "resume.archive" not in names                  # unscored excluded
    assert top[0]["title"] == "High" and "art_url" in top[0]
    assert top[0]["best_score"] == 900 and top[0]["best_accuracy"] == pytest.approx(0.95)


def test_top_aggregates_arrangements_and_respects_limit(client, server):
    # Per-song aggregation (best across arrangements) + the limit param.
    server.meta_db.put("multi.archive", 0, 0, {"title": "Multi",
                                               "arrangements": [{"name": "Lead"}, {"name": "Bass"}]})
    server.meta_db.put("solo.archive", 0, 0, {"title": "Solo"})
    client.post("/api/stats", json={"filename": "multi.archive", "arrangement": 0, "score": 200, "accuracy": 0.6})
    client.post("/api/stats", json={"filename": "multi.archive", "arrangement": 1, "score": 800, "accuracy": 0.9})
    client.post("/api/stats", json={"filename": "solo.archive", "score": 500, "accuracy": 0.7})
    top = client.get("/api/stats/top").json()
    multi = next(r for r in top if r["filename"] == "multi.archive")
    assert multi["best_score"] == 800   # best arrangement, not summed/duplicated
    assert [r["filename"] for r in top].count("multi.archive") == 1
    # limit caps the list.
    assert len(client.get("/api/stats/top?limit=1").json()) == 1


# ── Codex-preflight regressions (bad-input hardening + resume touch) ──────────

def test_stats_rejects_non_finite_score_accuracy(client):
    # Inf/NaN must be a 400, not a 500 (round(inf) → OverflowError) and must
    # never be persisted (a stored non-finite breaks later JSON serialization).
    # Numeric strings:
    for bad in ({"score": "inf", "accuracy": 0.5}, {"score": 100, "accuracy": "NaN"}):
        r = client.post("/api/stats", json={"filename": "nf.archive", **bad})
        assert r.status_code == 400, bad
    # Raw JSON Infinity/NaN literals — Python's json parser accepts these, so a
    # client really can send them (httpx's json= serializer cannot, hence the
    # raw body).
    import json as _json
    for raw in (_json.dumps({"filename": "nf.archive", "score": float("inf"), "accuracy": 0.5}),
                _json.dumps({"filename": "nf.archive", "score": 100, "accuracy": float("nan")})):
        r = client.post("/api/stats", content=raw, headers={"Content-Type": "application/json"})
        assert r.status_code == 400, raw
    # The bad writes left no row behind.
    assert client.get("/api/stats/nf.archive").json()["plays"] == 0


def test_stats_rejects_non_finite_position(client):
    r = client.post("/api/stats", json={"filename": "p.archive", "lastPlayPosition": "inf"})
    assert r.status_code == 400


def test_stats_bad_typed_fields_are_400_not_500(client):
    # Wrong-typed JSON for string fields must validate to 400, not raise.
    assert client.post("/api/stats", json={"filename": 123, "score": 1, "accuracy": 0.5}).status_code == 400
    assert client.post("/api/stats", json={"filename": ["x"]}).status_code == 400


def test_position_touch_surfaces_in_recent_and_continue(client, server):
    # A non-scored resume touch must stamp last_played_at so it shows up in
    # both 'Jump back in' (recent) and Continue-Playing.
    server.meta_db.put("resume.archive", 0, 0, {})
    r = client.post("/api/stats", json={"filename": "resume.archive", "arrangement": 2,
                                        "lastPlayPosition": 42.0})
    assert r.status_code == 200
    recent = client.get("/api/stats/recent?limit=10").json()
    assert "resume.archive" in [x["filename"] for x in recent]
    cont = client.get("/api/session/continue").json()
    assert cont and cont["filename"] == "resume.archive"
    assert cont["arrangement"] == 2 and cont["last_position"] == pytest.approx(42.0)


def test_stats_requires_score_and_accuracy_together(client):
    # Exactly one of score/accuracy (with or without a position) is ambiguous.
    assert client.post("/api/stats", json={"filename": "x.archive", "score": 100}).status_code == 400
    assert client.post("/api/stats", json={"filename": "x.archive", "accuracy": 0.5,
                                           "lastPlayPosition": 10.0}).status_code == 400


def test_stats_rejects_out_of_range_score(client):
    # A huge but finite score passes isfinite() yet overflows SQLite INTEGER.
    r = client.post("/api/stats", json={"filename": "big.archive", "score": 1e308, "accuracy": 0.5})
    assert r.status_code == 400
    assert client.get("/api/stats/big.archive").json()["plays"] == 0


def test_xp_award_rejects_bool_and_overflow(client):
    assert client.post("/api/xp/award", json={"amount": True}).status_code == 400
    assert client.post("/api/xp/award", json={"amount": 10**30}).status_code == 400
    assert client.post("/api/xp/award", json={"amount": 50}).status_code == 200


def test_reorder_rejects_non_permutation(client, server):
    for fn in ("a.archive", "b.archive"):
        server.meta_db.put(fn, 0, 0, {})
    pid = client.post("/api/playlists", json={"name": "P"}).json()["id"]
    client.post(f"/api/playlists/{pid}/songs", json={"filename": "a.archive"})
    client.post(f"/api/playlists/{pid}/songs", json={"filename": "b.archive"})
    # Extra / missing / duplicate entries are all rejected.
    assert client.post(f"/api/playlists/{pid}/reorder", json={"order": ["a.archive"]}).status_code == 400
    assert client.post(f"/api/playlists/{pid}/reorder",
                       json={"order": ["a.archive", "a.archive"]}).status_code == 400
    assert client.post(f"/api/playlists/{pid}/reorder",
                       json={"order": ["b.archive", "a.archive"]}).status_code == 200


def test_overflow_numeric_inputs_are_not_500(client):
    # JSON 1e309 parses to inf; int(inf) raises OverflowError. None of these
    # may 500 (they should 400, or be clamped).
    import json as _json
    r = client.post("/api/xp/award", content=_json.dumps({"amount": 1e309}),
                    headers={"Content-Type": "application/json"})
    assert r.status_code == 400
    # Huge/inf arrangement is rejected (400), never a 500.
    r2 = client.post("/api/stats", content=_json.dumps({"filename": "o.archive", "arrangement": 1e309,
                                                        "score": 10, "accuracy": 0.5}),
                     headers={"Content-Type": "application/json"})
    assert r2.status_code == 400
    # An out-of-int64-range playlist id is a 404, not a 500.
    assert client.get("/api/playlists/%d" % (10 ** 30)).status_code == 404
    assert client.post("/api/playlists/%d/songs" % (10 ** 30),
                       json={"filename": "x.archive"}).status_code == 404


def test_stats_rejects_non_integral_arrangement(client):
    # 1.9 / true must be rejected, not silently truncated to 1.
    assert client.post("/api/stats", json={"filename": "a.archive", "arrangement": 1.9,
                                           "score": 10, "accuracy": 0.5}).status_code == 400
    assert client.post("/api/stats", json={"filename": "a.archive", "arrangement": True,
                                           "score": 10, "accuracy": 0.5}).status_code == 400


def test_stats_rejects_out_of_range_accuracy(client):
    for acc in (5, -1, 1.5):
        assert client.post("/api/stats", json={"filename": "acc.archive", "score": 10,
                                               "accuracy": acc}).status_code == 400, acc
    assert client.get("/api/stats/acc.archive").json()["plays"] == 0


def test_xp_award_rejects_non_integral_amount(client):
    assert client.post("/api/xp/award", json={"amount": 1.9}).status_code == 400
    assert client.post("/api/xp/award", json={"amount": 5.0}).status_code == 200  # integral float ok


def test_stats_rejects_boolean_numeric_fields(client):
    # JSON booleans must not be coerced via float() into a recorded play / position.
    assert client.post("/api/stats", json={"filename": "b.archive", "score": True, "accuracy": 0.5}).status_code == 400
    assert client.post("/api/stats", json={"filename": "b.archive", "score": 10, "accuracy": False}).status_code == 400
    assert client.post("/api/stats", json={"filename": "b.archive", "lastPlayPosition": False}).status_code == 400
    assert client.get("/api/stats/b.archive").json()["plays"] == 0


def test_award_xp_service_tolerates_bad_amount(client, server):
    # The plugin-facing service must never RAISE on bad input. Unparseable /
    # non-finite values are no-ops; an out-of-range integer is clamped to the
    # cap (not rejected) rather than overflowing the SQLite bind.
    db = server.meta_db
    before = db.get_xp()
    for noop in (float("inf"), float("nan"), "x", None):
        assert db.award_xp(noop) == before  # no-op, no raise
    assert db.award_xp(10 ** 40) == before + 10_000_000  # clamped to the cap, no OverflowError


def test_best_map_includes_scored_zero_excludes_resume_only(client, server):
    # A scored 0% song (plays>0) must appear in /api/stats/best; a resume-only
    # touch (plays==0, default best 0) must not — both are real library songs,
    # so the exclusion is the plays>0 rule, not the existing-song filter.
    for fn in ("zero.archive", "resume.archive"):
        server.meta_db.put(fn, 0, 0, {})
    client.post("/api/stats", json={"filename": "zero.archive", "score": 0, "accuracy": 0.0})
    client.post("/api/stats", json={"filename": "resume.archive", "lastPlayPosition": 12.0})
    best = client.get("/api/stats/best").json()
    assert "zero.archive" in best and best["zero.archive"] == 0.0
    assert "resume.archive" not in best


def test_dead_song_stats_hidden_when_library_populated(client, server):
    # When the songs table is populated, stats for a song that ISN'T in it are
    # hidden from reads (race-free orphan handling) — but a present song shows.
    db = server.meta_db
    db.put("keep.archive", 0, 0, {"title": "Keep"})
    client.post("/api/stats", json={"filename": "keep.archive", "score": 200, "accuracy": 0.8})
    client.post("/api/stats", json={"filename": "ghost.archive", "score": 100, "accuracy": 0.5})  # no songs row
    best = client.get("/api/stats/best").json()
    assert "keep.archive" in best and "ghost.archive" not in best
    recent = [r["filename"] for r in client.get("/api/stats/recent?limit=10").json()]
    assert "keep.archive" in recent and "ghost.archive" not in recent


def test_delete_missing_does_not_destroy_stats(client, server):
    # A scan pruning a song from `songs` must NOT delete its stats (the wipe
    # race): the song is merely hidden while absent, and re-adding it restores
    # its full history. A second song keeps the library non-empty so the
    # existing-song read filter stays active.
    db = server.meta_db
    db.put("s.archive", 0, 0, {"title": "S"})
    db.put("other.archive", 0, 0, {"title": "Other"})
    client.post("/api/stats", json={"filename": "s.archive", "score": 300, "accuracy": 0.9})
    db.delete_missing({"other.archive"})   # s no longer "on disk" → songs row removed (other kept)
    assert "s.archive" not in client.get("/api/stats/best").json()   # hidden, library still populated
    db.put("s.archive", 0, 0, {"title": "S"})   # song comes back under the same name
    best = client.get("/api/stats/best").json()
    assert "s.archive" in best and best["s.archive"] == pytest.approx(0.9)   # stats survived the prune


def test_stats_arrangement_bounded_to_song_arrangements(client, server):
    # For a known library song, an out-of-range arrangement index is rejected
    # (can't create a fake arrangement bucket); index 0 is fine.
    server.meta_db.put("multi.archive", 0, 0, {"arrangements": [{"name": "Lead"}, {"name": "Bass"}]})
    assert client.post("/api/stats", json={"filename": "multi.archive", "arrangement": 5,
                                           "score": 10, "accuracy": 0.5}).status_code == 400
    assert client.post("/api/stats", json={"filename": "multi.archive", "arrangement": 1,
                                           "score": 10, "accuracy": 0.5}).status_code == 200


def test_per_source_xp_reset_only_removes_that_source(client, server):
    # reset_source_xp subtracts ONLY the named source's contribution from the
    # unified total (a minigames reset must not wipe song-play XP).
    db = server.meta_db
    db.award_xp(100, "song-play")
    db.award_xp(60, "minigames")
    assert db.get_xp() == 160
    prog = db.reset_source_xp("minigames")
    assert prog["xp"] == 100                       # only minigames removed
    assert db.reset_source_xp("minigames")["xp"] == 100   # idempotent


def test_award_xp_negative_reversal_clamps_at_zero(server):
    # A negative amount reverses a prior award (used when a minigames run's
    # profile-save fails) and never drives the total below zero.
    db = server.meta_db
    db.award_xp(50, "minigames")
    assert db.award_xp(-50, "minigames") == 0      # exact reversal
    assert db.award_xp(-999, "minigames") == 0     # over-reverse clamps at 0
