"""Tests for the personal per-song metadata layer (P1): user-difficulty,
notes, and tags. This is the LOCAL, never-shared layer — distinct from
/api/song/{f}/meta (which writes catalog fields back into the feedpak file).
Likes stay the existing favorites heart and are not touched here."""

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


def _seed(server, *filenames):
    for fn in filenames:
        server.meta_db.put(fn, 0, 0, {"title": fn.split(".")[0], "artist": "A"})


# ── Read defaults ────────────────────────────────────────────────────────────

def test_defaults_for_untouched_song(client, server):
    _seed(server, "a.archive")
    m = client.get("/api/song/a.archive/user-meta").json()
    assert m == {"user_difficulty": None, "notes": "", "tags": []}


# ── Difficulty + notes write/read ────────────────────────────────────────────

def test_set_difficulty_and_notes(client, server):
    _seed(server, "a.archive")
    r = client.put("/api/song/a.archive/user-meta",
                   json={"user_difficulty": 3, "notes": "  bar chord section  "})
    assert r.status_code == 200
    m = r.json()
    assert m["user_difficulty"] == 3
    assert m["notes"] == "bar chord section"   # trimmed
    # persisted
    assert client.get("/api/song/a.archive/user-meta").json()["user_difficulty"] == 3


def test_partial_update_preserves_other_fields(client, server):
    _seed(server, "a.archive")
    client.put("/api/song/a.archive/user-meta", json={"user_difficulty": 4, "notes": "keep"})
    # update only notes -> difficulty preserved
    client.put("/api/song/a.archive/user-meta", json={"notes": "changed"})
    m = client.get("/api/song/a.archive/user-meta").json()
    assert m["user_difficulty"] == 4 and m["notes"] == "changed"


def test_clear_difficulty_with_null(client, server):
    _seed(server, "a.archive")
    client.put("/api/song/a.archive/user-meta", json={"user_difficulty": 2})
    client.put("/api/song/a.archive/user-meta", json={"user_difficulty": None})
    assert client.get("/api/song/a.archive/user-meta").json()["user_difficulty"] is None


@pytest.mark.parametrize("bad", [0, 6, 99, -1, "x", 2.5])
def test_difficulty_out_of_range_is_400(client, server, bad):
    _seed(server, "a.archive")
    assert client.put("/api/song/a.archive/user-meta",
                      json={"user_difficulty": bad}).status_code == 400


def test_empty_body_is_400(client, server):
    _seed(server, "a.archive")
    assert client.put("/api/song/a.archive/user-meta", json={}).status_code == 400


# ── Tags (full-replace) + normalization ──────────────────────────────────────

def test_tags_replace_and_normalize(client, server):
    _seed(server, "a.archive")
    r = client.put("/api/song/a.archive/user-meta",
                   json={"tags": ["Warm-ups", "  RIFFS ", "warm-ups", ""]})
    # lowercased, whitespace-trimmed, case-dupes + blanks dropped; returned
    # sorted alphabetically (deterministic chip order, matches reads)
    assert r.json()["tags"] == ["riffs", "warm-ups"]
    # replace with a smaller set
    client.put("/api/song/a.archive/user-meta", json={"tags": ["gig"]})
    assert client.get("/api/song/a.archive/user-meta").json()["tags"] == ["gig"]
    # clear
    client.put("/api/song/a.archive/user-meta", json={"tags": []})
    assert client.get("/api/song/a.archive/user-meta").json()["tags"] == []


def test_tags_capped_at_50(client, server):
    _seed(server, "a.archive")
    # Submit 80 distinct tags; only the first 50 normalized-unique are stored.
    many = [f"tag{i}" for i in range(80)]
    r = client.put("/api/song/a.archive/user-meta", json={"tags": many})
    assert r.status_code == 200
    assert len(r.json()["tags"]) == 50
    assert len(client.get("/api/song/a.archive/user-meta").json()["tags"]) == 50


def test_tags_must_be_array(client, server):
    _seed(server, "a.archive")
    assert client.put("/api/song/a.archive/user-meta",
                      json={"tags": "warmups"}).status_code == 400


def test_tags_untouched_when_key_absent(client, server):
    _seed(server, "a.archive")
    client.put("/api/song/a.archive/user-meta", json={"tags": ["keep"]})
    client.put("/api/song/a.archive/user-meta", json={"user_difficulty": 1})
    assert client.get("/api/song/a.archive/user-meta").json()["tags"] == ["keep"]


def test_list_all_tags_with_counts(client, server):
    _seed(server, "a.archive", "b.archive")
    client.put("/api/song/a.archive/user-meta", json={"tags": ["warmups", "riffs"]})
    client.put("/api/song/b.archive/user-meta", json={"tags": ["warmups"]})
    tags = client.get("/api/tags").json()["tags"]
    # most-used first
    assert tags[0] == {"tag": "warmups", "count": 2}
    assert {"tag": "riffs", "count": 1} in tags


# ── Grid embed (query_page) ──────────────────────────────────────────────────

def test_library_row_embeds_difficulty_and_tags_not_notes(client, server):
    _seed(server, "a.archive")
    client.put("/api/song/a.archive/user-meta",
               json={"user_difficulty": 5, "notes": "secret", "tags": ["gig"]})
    row = next(s for s in client.get("/api/library").json()["songs"]
               if s["filename"] == "a.archive")
    assert row["user_difficulty"] == 5
    assert row["tags"] == ["gig"]
    assert "notes" not in row   # notes stay out of the list payload


# ── Read-time filters ────────────────────────────────────────────────────────

def test_filter_by_user_difficulty(client, server):
    _seed(server, "a.archive", "b.archive", "c.archive")
    client.put("/api/song/a.archive/user-meta", json={"user_difficulty": 2})
    client.put("/api/song/b.archive/user-meta", json={"user_difficulty": 4})
    got = {s["filename"] for s in client.get("/api/library?user_difficulty=2").json()["songs"]}
    assert got == {"a.archive"}
    # any-of set
    got2 = {s["filename"] for s in client.get("/api/library?user_difficulty=2,4").json()["songs"]}
    assert got2 == {"a.archive", "b.archive"}


def test_filter_by_tag(client, server):
    _seed(server, "a.archive", "b.archive")
    client.put("/api/song/a.archive/user-meta", json={"tags": ["warmups"]})
    got = {s["filename"] for s in client.get("/api/library?tags=warmups").json()["songs"]}
    assert got == {"a.archive"}
    # case-insensitive match on the query side (normalized)
    got_ci = {s["filename"] for s in client.get("/api/library?tags=WARMUPS").json()["songs"]}
    assert got_ci == {"a.archive"}


def test_filter_total_count_reflects_filter(client, server):
    _seed(server, "a.archive", "b.archive", "c.archive")
    client.put("/api/song/a.archive/user-meta", json={"user_difficulty": 3})
    body = client.get("/api/library?user_difficulty=3").json()
    assert body["total"] == 1


# ── Never-clobber on rescan ──────────────────────────────────────────────────

def test_personal_data_survives_rescan(client, server):
    _seed(server, "a.archive")
    client.put("/api/song/a.archive/user-meta",
               json={"user_difficulty": 3, "notes": "n", "tags": ["t"]})
    # Simulate the scanner re-indexing the song (INSERT OR REPLACE INTO songs).
    server.meta_db.put("a.archive", 1, 1, {"title": "a", "artist": "A"})
    m = client.get("/api/song/a.archive/user-meta").json()
    assert m["user_difficulty"] == 3 and m["notes"] == "n" and m["tags"] == ["t"]


# ── Purge on delete ──────────────────────────────────────────────────────────

def test_purge_removes_all_personal_rows(client, server):
    _seed(server, "a.archive")
    client.put("/api/song/a.archive/user-meta",
               json={"user_difficulty": 3, "notes": "n", "tags": ["x", "y"]})
    # delete_song calls this inside meta_db._lock after removing the file.
    with server.meta_db._lock:
        server.meta_db.purge_song_user_data("a.archive")
        server.meta_db.conn.commit()
    m = client.get("/api/song/a.archive/user-meta").json()
    assert m == {"user_difficulty": None, "notes": "", "tags": []}
    # and the tag drops out of the global vocabulary
    assert client.get("/api/tags").json()["tags"] == []
