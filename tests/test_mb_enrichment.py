"""Server-level tests for the P8 MusicBrainz matcher + Match-Review flow.

The HTTP transport is a fake installed over `server._mb_http_get` — the ONE
seam enrichment uses to reach the network — so nothing here ever opens a
socket. The offline default is itself under test: without explicitly
enabling the network flag, a pass must skip matching entirely (pytest can
never hit MusicBrainz, whatever a test triggers).
"""

import importlib
import sys

import pytest
from fastapi.testclient import TestClient


@pytest.fixture()
def server(tmp_path, monkeypatch, isolate_logging):
    monkeypatch.setenv("CONFIG_DIR", str(tmp_path / "config"))
    dlc = tmp_path / "dlc"
    dlc.mkdir()
    monkeypatch.setenv("DLC_DIR", str(dlc))
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


class FakeMB:
    """Canned MusicBrainz: records every call, serves per-path responses."""

    def __init__(self):
        self.calls = []
        self.search_response = {"recordings": []}
        self.recording_lookups = {}   # mbid → recording doc
        self.isrc_lookups = {}        # isrc → {"recordings": [...]}
        self.raise_transport = False

    def __call__(self, path, params):
        if self.raise_transport:
            raise self._srv.EnrichTransportError("fake network down")
        self.calls.append((path, dict(params)))
        if path == "recording":
            return self.search_response
        if path.startswith("recording/"):
            return self.recording_lookups.get(path.split("/", 1)[1])
        if path.startswith("isrc/"):
            return self.isrc_lookups.get(path.split("/", 1)[1])
        raise AssertionError(f"unexpected MB path {path!r}")

    @property
    def search_calls(self):
        return [c for c in self.calls if c[0] == "recording"]


@pytest.fixture()
def mb(server, monkeypatch):
    """Install the fake transport AND enable the network flag (the test env
    disables it by default — see test_offline_default_skips_matching)."""
    fake = FakeMB()
    fake._srv = server
    monkeypatch.setattr(server, "_mb_http_get", fake)
    monkeypatch.setattr(server, "_enrich_network_enabled", lambda: True)
    return fake


def _put(server, fn, title="Thunderstruck (v2)", artist="ACDC", album="",
         duration=292, year="1990"):
    server.meta_db.put(fn, 0, 0, {
        "title": title, "artist": artist, "album": album, "year": year,
        "duration": duration, "arrangements": [{"name": "Lead", "index": 0}],
    })


def mb_doc(rid="rec-1", title="Thunderstruck", artist="AC/DC", artist_id="art-1",
           album="The Razors Edge", date="1990-09-24", length_ms=292000, score=100):
    return {
        "id": rid, "score": score, "title": title, "length": length_ms,
        "isrcs": ["AUAP09000045"],
        "artist-credit": [{"name": artist, "artist": {
            "id": artist_id, "name": artist, "sort-name": artist}}],
        "releases": [{"id": "rel-1", "title": album, "status": "Official",
                      "date": date, "release-group": {"primary-type": "Album"}}],
        "tags": [{"name": "hard rock", "count": 7}],
    }


# ── offline safety (the pytest-never-hits-network contract) ──────────────────

def test_offline_default_skips_matching(server, monkeypatch):
    """Under the test env (FEEDBACK_SKIP_STARTUP_TASKS) a pass stamps hashes
    but never matches — even with a transport installed."""
    fake = FakeMB()
    fake._srv = server
    monkeypatch.setattr(server, "_mb_http_get", fake)
    _put(server, "a.sloppak")
    server._background_enrich()
    assert fake.calls == []
    assert server.meta_db.get_enrichment("a.sloppak")["match_state"] == "unscanned"


def test_real_transport_refuses_when_offline(server):
    """_mb_http_get itself raises (before any socket) when the network is
    disabled — defence in depth under pytest."""
    with pytest.raises(server.EnrichTransportError):
        server._mb_http_get("recording", {"query": "x"})


def test_transport_error_pauses_pass_without_burning_attempts(server, mb):
    _put(server, "a.sloppak")
    _put(server, "b.sloppak", title="Other Song")
    mb.raise_transport = True
    server._background_enrich()
    for fn in ("a.sloppak", "b.sloppak"):
        row = server.meta_db.get_enrichment(fn)
        assert row["match_state"] == "unscanned"
        assert row["attempts"] == 0
    # Network comes back → the next kick matches both.
    mb.raise_transport = False
    mb.search_response = {"recordings": [mb_doc()]}
    server._background_enrich()
    assert server.meta_db.get_enrichment("a.sloppak")["match_state"] == "matched"


# ── text tiers ────────────────────────────────────────────────────────────────

def test_high_confidence_auto_matches_and_settles(server, mb):
    _put(server, "a.sloppak")
    mb.search_response = {"recordings": [mb_doc()]}
    server._background_enrich()
    row = server.meta_db.get_enrichment("a.sloppak")
    assert row["match_state"] == "matched"
    assert row["match_source"] == "text"
    assert row["match_score"] >= 0.95
    assert row["mb_recording_id"] == "rec-1"
    assert row["canon_artist"] == "AC/DC"
    assert row["canon_title"] == "Thunderstruck"
    assert row["canon_album"] == "The Razors Edge"
    assert row["canon_year"] == "1990"
    assert row["genres"] == ["hard rock"]
    # Settled: another pass makes NO further network calls…
    n = len(mb.calls)
    server._background_enrich()
    assert len(mb.calls) == n
    # …until the identity changes, which re-matches.
    _put(server, "a.sloppak", title="Back in Black")
    mb.search_response = {"recordings": [mb_doc(rid="rec-2", title="Back in Black",
                                                album="Back in Black", date="1980-07-25")]}
    server._background_enrich()
    row = server.meta_db.get_enrichment("a.sloppak")
    assert row["mb_recording_id"] == "rec-2"


def test_medium_confidence_goes_to_review_not_canonical(server, mb):
    # Partial artist agreement → medium confidence.
    _put(server, "a.sloppak", artist="AC/DC ft Nobody")
    mb.search_response = {"recordings": [mb_doc()]}
    server._background_enrich()
    row = server.meta_db.get_enrichment("a.sloppak")
    assert row["match_state"] == "review"
    assert row["match_source"] == "text"
    # Review before auto-canonicalize: NO canonical values written yet.
    assert row["canon_artist"] is None
    assert row["mb_recording_id"] is None
    assert row["candidates"] and row["candidates"][0]["recording_id"] == "rec-1"
    # A review row is settled while its identity is unchanged — no re-query.
    n = len(mb.calls)
    server._background_enrich()
    assert len(mb.calls) == n


def test_low_confidence_fails_with_backoff(server, mb):
    _put(server, "a.sloppak")
    mb.search_response = {"recordings": [mb_doc(rid="rec-x", title="Sunrise",
                                                artist="Norah Jones")]}
    server._background_enrich()
    row = server.meta_db.get_enrichment("a.sloppak")
    assert row["match_state"] == "failed"
    assert row["attempts"] == 1
    assert row["last_attempt_at"] is not None
    # Immediately after, the backoff hasn't elapsed → no retry, no network.
    n = len(mb.calls)
    server._background_enrich()
    assert len(mb.calls) == n
    assert server.meta_db.get_enrichment("a.sloppak")["attempts"] == 1
    # Rewind the clock two hours → eligible again, attempts increments.
    with server.meta_db._lock:
        server.meta_db.conn.execute(
            "UPDATE song_enrichment SET last_attempt_at = last_attempt_at - 7200")
        server.meta_db.conn.commit()
    server._background_enrich()
    assert len(mb.calls) == n + 1
    assert server.meta_db.get_enrichment("a.sloppak")["attempts"] == 2


def test_no_results_fails(server, mb):
    _put(server, "a.sloppak")
    mb.search_response = {"recordings": []}
    server._background_enrich()
    assert server.meta_db.get_enrichment("a.sloppak")["match_state"] == "failed"


# ── the content-hash match cache ──────────────────────────────────────────────

def test_cache_hit_copies_match_without_network(server, mb):
    _put(server, "a.sloppak")
    _put(server, "b.sloppak")   # identical identity → same content_hash
    mb.search_response = {"recordings": [mb_doc()]}
    server._background_enrich()
    assert len(mb.search_calls) == 1          # ONE search covered both charts
    a = server.meta_db.get_enrichment("a.sloppak")
    b = server.meta_db.get_enrichment("b.sloppak")
    assert a["match_state"] == b["match_state"] == "matched"
    assert {a["match_source"], b["match_source"]} == {"text", "cache"}
    assert a["mb_recording_id"] == b["mb_recording_id"] == "rec-1"


# ── exact keys from the manifest (tier 0 / tier 1) ────────────────────────────

def _write_sloppak_manifest(server, name, extra_yaml=""):
    d = server.DLC_DIR / name
    d.mkdir(parents=True)
    (d / "manifest.yaml").write_text(
        "title: Thunderstruck\nartist: AC/DC\nduration: 292\n"
        "arrangements: []\nstems: []\n" + extra_yaml,
        encoding="utf-8")


def test_manifest_mbid_tier0(server, mb):
    mbid = "12345678-abcd-4ef0-9876-0123456789ab"
    _write_sloppak_manifest(server, "a.sloppak", f"mbid: {mbid}\n")
    _put(server, "a.sloppak")
    mb.recording_lookups[mbid] = mb_doc(rid=mbid)
    server._background_enrich()
    row = server.meta_db.get_enrichment("a.sloppak")
    assert row["match_state"] == "matched"
    assert row["match_source"] == "mbid"
    assert row["match_score"] == 1.0
    assert row["mb_recording_id"] == mbid
    assert mb.search_calls == []              # trusted key — no text search


def test_manifest_isrc_tier1(server, mb):
    _write_sloppak_manifest(server, "a.sloppak", "isrc: AUAP09000045\n")
    _put(server, "a.sloppak")
    mb.isrc_lookups["AUAP09000045"] = {"recordings": [mb_doc()]}
    server._background_enrich()
    row = server.meta_db.get_enrichment("a.sloppak")
    assert row["match_state"] == "matched"
    assert row["match_source"] == "isrc"
    assert mb.search_calls == []


def test_bad_manifest_mbid_falls_through_to_text(server, mb):
    mbid = "12345678-abcd-4ef0-9876-0123456789ab"
    _write_sloppak_manifest(server, "a.sloppak", f"mbid: {mbid}\n")
    _put(server, "a.sloppak")
    mb.recording_lookups.clear()              # lookup 404s (typo'd manifest)
    mb.search_response = {"recordings": [mb_doc()]}
    server._background_enrich()
    row = server.meta_db.get_enrichment("a.sloppak")
    assert row["match_state"] == "matched"
    assert row["match_source"] == "text"


# ── manual is sacred ──────────────────────────────────────────────────────────

def test_manual_never_overwritten_by_matcher(server, mb):
    _put(server, "a.sloppak")
    server.meta_db.set_enrichment_manual(
        "a.sloppak", {"recording_id": "user-pick", "title": "Thunderstruck",
                      "artist": "AC/DC"}, source="search")
    mb.search_response = {"recordings": [mb_doc(rid="machine-pick")]}
    server._background_enrich()
    row = server.meta_db.get_enrichment("a.sloppak")
    assert row["match_state"] == "manual"
    assert row["mb_recording_id"] == "user-pick"
    # The writer refuses machine writes onto manual outright.
    ok = server.meta_db.apply_enrichment_match(
        "a.sloppak", row["content_hash"], "matched", source="text", score=1.0,
        cand={"recording_id": "machine-pick", "title": "X"})
    assert ok is False


# ── review routes ─────────────────────────────────────────────────────────────

def _seed_review(server, mb, fn="a.sloppak", title="Thunderstruck (v2)"):
    # Distinct raw titles give distinct content hashes (else the match cache
    # legitimately copies an earlier row instead of running the text tiers).
    _put(server, fn, title=title, artist="AC/DC ft Nobody")
    mb.search_response = {"recordings": [mb_doc()]}
    server._background_enrich()
    assert server.meta_db.get_enrichment(fn)["match_state"] == "review"


def test_review_queue_route(server, mb, client):
    _seed_review(server, mb)
    body = client.get("/api/enrichment/review").json()
    assert body["total_review"] == 1
    assert body["songs"][0]["filename"] == "a.sloppak"
    assert body["songs"][0]["candidates"][0]["recording_id"] == "rec-1"


def test_review_accept_route(server, mb, client):
    _seed_review(server, mb)
    r = client.post("/api/enrichment/review/a.sloppak/accept",
                    json={"recording_id": "rec-1"})
    assert r.status_code == 200
    row = server.meta_db.get_enrichment("a.sloppak")
    assert row["match_state"] == "manual"
    assert row["match_source"] == "review"
    assert row["canon_artist"] == "AC/DC"
    assert client.get("/api/enrichment/review").json()["total_review"] == 0
    # Accepting a candidate that isn't in the stored list → 404.
    _seed_review(server, mb, fn="b.sloppak", title="Thunderstruck (Live)")
    r = client.post("/api/enrichment/review/b.sloppak/accept",
                    json={"recording_id": "nope"})
    assert r.status_code == 404


def test_review_reject_route_never_retries(server, mb, client):
    _seed_review(server, mb)
    r = client.post("/api/enrichment/review/a.sloppak/reject")
    assert r.status_code == 200
    row = server.meta_db.get_enrichment("a.sloppak")
    assert row["match_state"] == "failed"
    assert row["match_source"] == "rejected"
    # Rejected rows are excluded from the retry backoff forever…
    n = len(mb.calls)
    server._background_enrich()
    assert len(mb.calls) == n
    # …but an identity edit re-queues (the user fixed the metadata).
    _put(server, "a.sloppak", artist="AC/DC")
    server._background_enrich()
    assert server.meta_db.get_enrichment("a.sloppak")["match_state"] == "matched"
    # Rejecting a manual row is refused.
    r = client.post("/api/enrichment/review/a.sloppak/reject")
    assert r.status_code == 200               # matched → rejectable
    client.post("/api/enrichment/review/a.sloppak/pick",
                json={"candidate": {"recording_id": "rec-9", "title": "T"}})
    r = client.post("/api/enrichment/review/a.sloppak/reject")
    assert r.status_code == 404


def test_pick_route_fix_match(server, mb, client):
    _put(server, "a.sloppak")
    r = client.post("/api/enrichment/review/a.sloppak/pick", json={"candidate": {
        "recording_id": "rec-77", "title": "Thunderstruck", "artist": "AC/DC",
        "album": "The Razors Edge", "year": "1990", "genres": ["hard rock"],
        "junk_key": "dropped"}})
    assert r.status_code == 200
    row = server.meta_db.get_enrichment("a.sloppak")
    assert row["match_state"] == "manual"
    assert row["match_source"] == "search"
    assert row["mb_recording_id"] == "rec-77"
    # Malformed candidate → 400; unknown song → 404.
    assert client.post("/api/enrichment/review/a.sloppak/pick",
                       json={"candidate": {"title": "no id"}}).status_code == 400
    assert client.post("/api/enrichment/review/ghost.sloppak/pick",
                       json={"candidate": {"recording_id": "x", "title": "t"}}
                       ).status_code == 404


def test_search_proxy(server, mb, client, monkeypatch):
    _put(server, "a.sloppak")
    mb.search_response = {"recordings": [mb_doc()]}
    assert client.get("/api/enrichment/search").status_code == 400
    body = client.get("/api/enrichment/search",
                      params={"title": "Thunderstruck", "artist": "AC/DC",
                              "filename": "a.sloppak"}).json()
    assert body["candidates"][0]["recording_id"] == "rec-1"
    assert body["candidates"][0]["score"] > 0.9
    # Transport failure surfaces as 503, not a 500.
    def _down(path, params):
        raise server.EnrichTransportError("down")
    monkeypatch.setattr(server, "_mb_http_get", _down)
    r = client.get("/api/enrichment/search", params={"title": "x"})
    assert r.status_code == 503


# ── the match facet on /api/library + /api/library/stats ─────────────────────

def test_match_facet_filters_grid_and_stats(server, mb, client, monkeypatch):
    _put(server, "auto.sloppak")                                  # → matched
    _put(server, "rev.sloppak", title="Revsong", artist="AC/DC ft Nobody")   # → review
    _put(server, "fail.sloppak", title="Failsong", artist="Zzz")  # → failed
    _put(server, "pend.sloppak", title="Pendsong", artist="Yyy")  # stays unscanned

    def _routed(path, params):
        q = params.get("query", "")
        if "thunderstruck" in q:
            return {"recordings": [mb_doc()]}
        if "revsong" in q:
            return {"recordings": [mb_doc(rid="rec-r", title="Revsong")]}
        return {"recordings": []}
    monkeypatch.setattr(server, "_mb_http_get", _routed)
    server._background_enrich()
    # Pendsong got failed by the pass (no results); reset it to unscanned to
    # represent the not-yet-scanned band.
    with server.meta_db._lock:
        server.meta_db.conn.execute(
            "UPDATE song_enrichment SET match_state='unscanned', attempts=0, "
            "last_attempt_at=NULL WHERE filename='pend.sloppak'")
        server.meta_db.conn.commit()

    def names(match):
        return sorted(s["filename"] for s in client.get(
            "/api/library", params={"match": match, "size": 50}).json()["songs"])

    assert names("review") == ["rev.sloppak"]
    assert names("matched") == ["auto.sloppak"]
    assert names("unmatched") == ["fail.sloppak"]
    assert names("pending") == ["pend.sloppak"]
    assert names("review,matched") == ["auto.sloppak", "rev.sloppak"]
    # Stats agree with the grid (the rail's lockstep contract).
    total = client.get("/api/library/stats",
                       params={"match": "review"}).json()["total_songs"]
    assert total == 1
    # Unknown values are ignored → unfiltered.
    assert len(names("bogus")) == 4


def test_status_counts_by_state(server, mb, client):
    _seed_review(server, mb)
    states = client.get("/api/enrichment/status").json()["states"]
    assert states.get("review") == 1
