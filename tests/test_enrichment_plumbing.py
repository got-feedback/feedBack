"""Tests for the metadata-enrichment plumbing (P7): the song_enrichment cache
table + identity hashing + the queue/lifecycle around the (for now) no-op
matcher. The text matcher itself is the next slice; these tests pin the
contracts it will inherit: rename-survivable idempotent hashing, manual rows
never auto-reset, never purged on rescan, purged on explicit delete."""

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
            getattr(__import__("sys").modules.get("server"), "_join_background_db_threads", lambda: None)()
            conn.close()
        sys.modules.pop("server", None)


@pytest.fixture()
def client(server):
    return TestClient(server.app)


def _put(server, fn, title="Song", artist="Artist", album="", duration=100):
    server.meta_db.put(fn, 0, 0, {
        "title": title, "artist": artist, "album": album, "duration": duration,
        "arrangements": [{"name": "Lead", "index": 0}],
    })


# ── identity hash ─────────────────────────────────────────────────────────────

def test_hash_is_rename_survivable_and_normalized(server):
    h = server.meta_db.enrichment_content_hash
    # keyed on metadata, not the filename → a renamed pack keeps its hash
    assert h("Artist", "Song", "Album", 100) == h("Artist", "Song", "Album", 100)
    # case + whitespace folded; duration rounded to whole seconds
    assert h(" artist ", "SONG", "album", 100.4) == h("Artist", "Song", "Album", 100)
    # a real identity change means a different hash
    assert h("Artist", "Song", "Album", 100) != h("Artist", "Other", "Album", 100)
    assert h("Artist", "Song", "Album", None) == h("Artist", "Song", "Album", 0)


# ── queue selection ───────────────────────────────────────────────────────────

def test_pending_covers_new_unscanned_and_changed(server):
    _put(server, "a.archive")
    assert [r["filename"] for r in server.meta_db.enrichment_pending()] == ["a.archive"]
    # stubbed → still unscanned → still pending (the matcher hasn't run)
    server._background_enrich()
    assert [r["filename"] for r in server.meta_db.enrichment_pending()] == ["a.archive"]
    # a matched row with the CURRENT hash is settled…
    h = server.meta_db.enrichment_content_hash("Artist", "Song", "", 100)
    with server.meta_db._lock:
        server.meta_db.conn.execute(
            "UPDATE song_enrichment SET match_state = 'matched', content_hash = ? "
            "WHERE filename = 'a.archive'", (h,))
        server.meta_db.conn.commit()
    assert server.meta_db.enrichment_pending() == []
    # …until the song's identity changes, which re-queues it
    _put(server, "a.archive", title="Song (Remastered)")
    assert [r["filename"] for r in server.meta_db.enrichment_pending()] == ["a.archive"]


def test_hash_change_resets_matched_but_never_manual(server):
    _put(server, "a.archive")
    _put(server, "b.archive", title="Other")
    server._background_enrich()
    with server.meta_db._lock:
        server.meta_db.conn.execute(
            "UPDATE song_enrichment SET match_state = 'matched' WHERE filename = 'a.archive'")
        server.meta_db.conn.execute(
            "UPDATE song_enrichment SET match_state = 'manual' WHERE filename = 'b.archive'")
        server.meta_db.conn.commit()
    # identity edits…
    _put(server, "a.archive", title="Song v2")
    _put(server, "b.archive", title="Other v2")
    server._background_enrich()
    a = server.meta_db.get_enrichment("a.archive")
    b = server.meta_db.get_enrichment("b.archive")
    # …drop a stale MATCH back to unscanned with the fresh hash
    assert a["match_state"] == "unscanned"
    assert a["content_hash"] == server.meta_db.enrichment_content_hash("Artist", "Song v2", "", 100)
    # …but a MANUAL pin survives untouched (state AND hash)
    assert b["match_state"] == "manual"
    assert b["content_hash"] == server.meta_db.enrichment_content_hash("Artist", "Other", "", 100)


def test_failed_rows_not_requeued_by_pending(server):
    _put(server, "a.archive")
    server._background_enrich()
    with server.meta_db._lock:
        server.meta_db.conn.execute(
            "UPDATE song_enrichment SET match_state = 'failed' WHERE filename = 'a.archive'")
        server.meta_db.conn.commit()
    # backoff/retry policy belongs to the matcher slice, not the queue walk
    assert server.meta_db.enrichment_pending() == []


# ── worker pass ───────────────────────────────────────────────────────────────

def test_enrich_pass_stamps_every_song(server):
    for i in range(5):
        _put(server, f"s{i}.archive", title=f"Song {i}")
    server._background_enrich()
    for i in range(5):
        row = server.meta_db.get_enrichment(f"s{i}.archive")
        assert row is not None
        assert row["match_state"] == "unscanned"
        assert row["content_hash"] == server.meta_db.enrichment_content_hash(
            "Artist", f"Song {i}", "", 100)


# ── lifecycle: rescan survival vs explicit delete ─────────────────────────────

def test_rescan_never_purges_enrichment(server):
    _put(server, "a.archive")
    server._background_enrich()
    server.meta_db.delete_missing(set())          # file vanished from a scan snapshot
    assert server.meta_db.get_enrichment("a.archive") is not None   # row survives
    # …and is invisible in the read-time-filtered counts
    assert server.meta_db.enrichment_state_counts() == {}
    _put(server, "a.archive")                     # the file comes back
    assert server.meta_db.enrichment_state_counts() == {"unscanned": 1}


def test_status_endpoint_counts(client, server):
    _put(server, "a.archive")
    _put(server, "b.archive", title="Other")
    server._background_enrich()
    body = client.get("/api/enrichment/status").json()
    assert body["states"] == {"unscanned": 2}
    assert body["total_songs"] == 2
    assert body["running"] is False
    assert body["processed"] == 2


def test_art_cache_dir_created(server):
    d = server._enrichment_art_dir()
    assert d.is_dir()
    assert d.name == "art_cache"


# ── Refresh Metadata batch: per-tile states, progress, Stop ───────────────────

def test_states_for_returns_only_known_filenames(server):
    _put(server, "a.archive")
    server._background_enrich()
    got = server.meta_db.enrichment_states_for(["a.archive", "nope.archive"])
    assert got == {"a.archive": "unscanned"}          # unknown filename absent
    assert server.meta_db.enrichment_states_for([]) == {}


def test_states_endpoint(client, server):
    _put(server, "a.archive")
    _put(server, "b.archive", title="Other")
    server._background_enrich()
    body = client.post("/api/enrichment/states",
                       json={"filenames": ["a.archive", "zzz.missing"]}).json()
    assert body["states"] == {"a.archive": "unscanned"}
    assert body["running"] is False
    assert body["current"] is None


def test_status_exposes_progress_fields(client, server):
    _put(server, "a.archive")
    server._background_enrich()
    body = client.get("/api/enrichment/status").json()
    for k in ("total", "matched", "current", "cancelling"):
        assert k in body
    assert body["cancelling"] is False


def test_cancel_is_noop_when_idle(client, server):
    body = client.post("/api/enrichment/cancel").json()
    assert body == {"ok": True, "was_running": False}
    # A no-op must not arm the flag (which would then poison the next pass).
    assert server._enrich_cancel.is_set() is False


def test_cancel_flag_halts_matching_loop_between_songs(server, monkeypatch):
    for i in range(4):
        _put(server, f"s{i}.archive", title=f"Song {i}")
    # Force the matcher path on (the test env is offline by default) and stub the
    # per-song matcher so nothing touches the network — it just trips Stop after
    # the first song, exactly as the /cancel route would mid-pass.
    monkeypatch.setattr(server, "_enrich_network_enabled", lambda: True)
    calls = []

    def fake_enrich_one(row, **_kw):
        calls.append(row["filename"])
        server._enrich_cancel.set()

    monkeypatch.setattr(server, "_enrich_one", fake_enrich_one)
    server._enrich_cancel.clear()
    server._background_enrich()
    # The loop checks cancel BEFORE each song, so exactly one is processed before
    # it breaks — not the whole 4-row queue.
    assert calls == ["s0.archive"]
    assert server._enrich_status["total"] == 4
    assert server._enrich_status["matched"] == 1


def test_rematch_requeues_visible_but_skips_manual(server, client):
    _put(server, "a.archive")                       # will be 'matched'
    _put(server, "b.archive", title="Other")        # will be 'failed'
    _put(server, "c.archive", title="Pinned")       # will be 'manual' — untouchable
    server._background_enrich()
    with server.meta_db._lock:
        server.meta_db.conn.execute(
            "UPDATE song_enrichment SET match_state='matched' WHERE filename='a.archive'")
        server.meta_db.conn.execute(
            "UPDATE song_enrichment SET match_state='failed' WHERE filename='b.archive'")
        server.meta_db.conn.execute(
            "UPDATE song_enrichment SET match_state='manual' WHERE filename='c.archive'")
        server.meta_db.conn.commit()
    body = client.post("/api/enrichment/rematch", json={
        "filenames": ["a.archive", "b.archive", "c.archive", "nope.archive"]}).json()
    # A per-view refresh re-runs everything shown EXCEPT the manual pin (and an
    # unknown filename); matched + failed are both re-queued.
    assert set(body["queued"]) == {"a.archive", "b.archive"}
    assert body["count"] == 2
    server._join_background_db_threads()
    assert server.meta_db.get_enrichment("a.archive")["match_state"] == "unscanned"
    assert server.meta_db.get_enrichment("b.archive")["match_state"] == "unscanned"
    assert server.meta_db.get_enrichment("c.archive")["match_state"] == "manual"


# ── filename-derived artist/title fallback (blank-artist packs) ───────────────

def test_filename_artist_title_parse(server):
    f = server._artist_title_from_filename
    assert f("CDLC/0 - City Pop/Tatsuro-Yamashita_Ride-On-Time_v1_p.feedpak") == \
        {"artist": "Tatsuro Yamashita", "title": "Ride On Time"}
    assert f("Anri_Windy-Summer_v1_p.feedpak") == {"artist": "Anri", "title": "Windy Summer"}
    # a trailing "(440Hz)" retune tag is stripped before parsing
    assert f("Cindy_Watashitachi-o-Shinjite-Ite_v1_p (440Hz).feedpak") == \
        {"artist": "Cindy", "title": "Watashitachi o Shinjite Ite"}
    # doesn't fit the convention → no guess
    assert f("nounderscore.feedpak") is None


def test_blank_artist_seeds_match_from_filename(server, monkeypatch):
    server.meta_db.put("Tatsuro-Yamashita_Ride-On-Time_v1_p.feedpak", 0, 0, {
        "title": "Tatsuro-Yamashita_Ride-On-Time_v1_p", "artist": "", "album": "",
        "duration": 240, "arrangements": [{"name": "Bass", "index": 0}]})
    monkeypatch.setattr(server, "_enrich_network_enabled", lambda: True)
    monkeypatch.setattr(server, "_manifest_exact_ids", lambda fn: {})
    seen = {}

    def fake_search(artist, title, limit=8):
        seen["artist"], seen["title"] = artist, title
        return []

    monkeypatch.setattr(server, "_mb_search_recordings", fake_search)
    row = next(r for r in server.meta_db.enrichment_pending()
               if r["filename"].startswith("Tatsuro"))
    server._enrich_one(row)
    # the blank pack artist was replaced by the filename-derived identity for
    # the search (this is exactly what rescues the 'failed' pile)
    assert seen == {"artist": "Tatsuro Yamashita", "title": "Ride On Time"}


def test_present_artist_is_not_overridden_by_filename(server, monkeypatch):
    server.meta_db.put("Weird-Filename_x_y.feedpak", 0, 0, {
        "title": "Real Title", "artist": "Real Artist", "album": "", "duration": 100,
        "arrangements": [{"name": "Lead", "index": 0}]})
    monkeypatch.setattr(server, "_enrich_network_enabled", lambda: True)
    monkeypatch.setattr(server, "_manifest_exact_ids", lambda fn: {})
    seen = {}

    def fake_search(artist, title, limit=8):
        seen["artist"], seen["title"] = artist, title
        return []

    monkeypatch.setattr(server, "_mb_search_recordings", fake_search)
    row = next(r for r in server.meta_db.enrichment_pending()
               if r["filename"].startswith("Weird"))
    server._enrich_one(row)
    # a pack that DOES carry an artist keeps it — the filename is never consulted
    assert seen == {"artist": "Real Artist", "title": "Real Title"}


def test_kick_clears_a_stale_cancel(server):
    # A cancelled-then-rekicked pass must start clean: _kick_enrich clears the
    # flag so the fresh pass isn't aborted the instant it checks.
    server._enrich_cancel.set()
    server._kick_enrich()
    server._join_background_db_threads()
    assert server._enrich_cancel.is_set() is False
