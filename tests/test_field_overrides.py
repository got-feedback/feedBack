"""Tests for the per-field metadata override + lock store (Fix-metadata popup).

A reversible DISPLAY overlay, never written to the pack: filename-keyed, so it
survives a rescan (never purged by delete_missing) and is dropped only with the
song (delete_song). Locks pin a field against a later auto-match.
"""

import importlib
import enrichment
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
            getattr(sys.modules.get("server"), "_join_background_db_threads", lambda: None)()
            conn.close()
        sys.modules.pop("server", None)


@pytest.fixture()
def client(server):
    return TestClient(server.app)


def _put(server, fn, **meta):
    base = {"title": "Song", "artist": "Artist", "album": "", "duration": 100,
            "arrangements": [{"name": "Lead", "index": 0}]}
    base.update(meta)
    server.meta_db.put(fn, 0, 0, base)


# ── store semantics ───────────────────────────────────────────────────────────

def test_set_get_and_partial_upsert(server):
    db = server.meta_db
    assert db.get_song_overrides("a.archive") == {}
    db.set_song_override("a.archive", "artist", value="AC/DC")
    assert db.get_song_overrides("a.archive") == {"artist": {"value": "AC/DC", "locked": False}}
    # partial: lock without touching the value
    db.set_song_override("a.archive", "artist", locked=True)
    assert db.get_song_overrides("a.archive")["artist"] == {"value": "AC/DC", "locked": True}
    # partial: change the value, keep the lock
    db.set_song_override("a.archive", "artist", value="AC/DC (fixed)")
    assert db.get_song_overrides("a.archive")["artist"] == {"value": "AC/DC (fixed)", "locked": True}


def test_lock_only_row_persists_without_a_value(server):
    db = server.meta_db
    db.set_song_override("a.archive", "year", locked=True)
    # a pure lock (no override value) is a valid, kept row
    assert db.get_song_overrides("a.archive") == {"year": {"value": None, "locked": True}}


def test_empty_and_unlocked_drops_the_row(server):
    db = server.meta_db
    db.set_song_override("a.archive", "album", value="X", locked=True)
    db.set_song_override("a.archive", "album", value="", locked=False)
    assert db.get_song_overrides("a.archive") == {}          # no empty shell


def test_clear_one_field_leaves_others(server):
    db = server.meta_db
    db.set_song_override("a.archive", "title", value="T")
    db.set_song_override("a.archive", "artist", value="A")
    db.clear_song_override("a.archive", "title")
    assert set(db.get_song_overrides("a.archive")) == {"artist"}


# ── lifecycle: rescan survival vs explicit delete ─────────────────────────────

def test_rescan_never_purges_overrides_delete_does(server):
    _put(server, "a.archive")
    server.meta_db.set_song_override("a.archive", "artist", value="AC/DC", locked=True)
    server.meta_db.delete_missing(set())                     # file vanished from a scan
    assert server.meta_db.get_song_overrides("a.archive")["artist"]["value"] == "AC/DC"
    server.meta_db.purge_song_user_data("a.archive")         # the delete_song purge
    assert server.meta_db.get_song_overrides("a.archive") == {}


def test_overrides_map_batches(server):
    db = server.meta_db
    db.set_song_override("a.archive", "artist", value="A")
    db.set_song_override("b.archive", "title", value="B", locked=True)
    m = db.overrides_map(["a.archive", "b.archive", "missing.archive"])
    assert m["a.archive"]["artist"]["value"] == "A"
    assert m["b.archive"]["title"] == {"value": "B", "locked": True}
    assert "missing.archive" not in m
    assert db.overrides_map([]) == {}


# ── API ───────────────────────────────────────────────────────────────────────

def test_api_put_get_and_clear(client, server):
    _put(server, "a.archive")
    r = client.put("/api/song/a.archive/overrides",
                   json={"overrides": {"artist": {"value": "AC/DC", "locked": True},
                                       "year": {"value": "1979"}}})
    assert r.status_code == 200
    ov = r.json()["overrides"]
    assert ov["artist"] == {"value": "AC/DC", "locked": True}
    assert ov["year"] == {"value": "1979", "locked": False}
    assert client.get("/api/song/a.archive/overrides").json()["overrides"]["artist"]["value"] == "AC/DC"
    # clear via PUT (value null + unlocked) — DELETE is shadowed by /api/song/{path}
    client.put("/api/song/a.archive/overrides",
               json={"overrides": {"artist": {"value": None, "locked": False}}})
    assert "artist" not in client.get("/api/song/a.archive/overrides").json()["overrides"]


def test_api_get_returns_pack_values(client, server):
    _put(server, "a.archive", title="Pack Title", artist="Pack Artist",
         album="Pack Album", year="1988")
    server.meta_db.set_song_override("a.archive", "title", value="Fixed Title")
    body = client.get("/api/song/a.archive/overrides").json()
    # the override rides "overrides"; the pack baseline rides "pack" (all 5 fields)
    assert body["overrides"]["title"]["value"] == "Fixed Title"
    assert body["pack"] == {"title": "Pack Title", "artist": "Pack Artist",
                            "album": "Pack Album", "year": "1988", "genre": ""}
    # a song with no row still gets an all-empty pack (popup always has values)
    assert client.get("/api/song/ghost.archive/overrides").json()["pack"]["title"] == ""


def test_api_rejects_unknown_field(client, server):
    _put(server, "a.archive")
    r = client.put("/api/song/a.archive/overrides",
                   json={"overrides": {"tuning": {"value": "Drop D"}}})
    assert r.status_code == 400
    assert "unknown field" in r.json()["error"]


# ── lock enforcement (slice 2) ────────────────────────────────────────────────

def test_locked_fields_reader(server):
    db = server.meta_db
    db.set_song_override("a.archive", "artist", value="X", locked=True)
    db.set_song_override("a.archive", "title", value="Y")            # override, not locked
    db.set_song_override("a.archive", "year", locked=True)           # lock only
    assert db.locked_fields("a.archive") == {"artist", "year"}


def test_compose_lock_filter_strips_locked_cand_keys(server):
    f = enrichment._compose_lock_filter(None, {"artist", "year"})
    cand = {"recording_id": "r", "artist": "X", "artist_sort": "X", "title": "T",
            "year": "1990", "album": "A", "genres": ["rock"]}
    out = f(cand)
    # locked display keys stripped (artist maps to artist + artist_sort)…
    assert not ({"artist", "artist_sort", "year"} & set(out))
    # …identity + unlocked display fields survive
    assert out["recording_id"] == "r" and out["title"] == "T" and out["album"] == "A"
    # no locks → base filter returned unchanged (zero-copy common path)
    assert enrichment._compose_lock_filter(None, set()) is None


# ── display overlay in the grid (slice 3) ─────────────────────────────────────
# "Grid shows only overrides": the effective cell is the user's override else the
# pack value. Display-only + keyset-safe — the seek stays on the raw column.

def _grid(server, **kw):
    songs, _ = server.meta_db.query_page(**kw)
    return {s["filename"]: s for s in songs}


def test_grid_shows_override_value_over_pack(server):
    _put(server, "a.archive", title="Wrong Title", artist="Wrong",
         album="Pack Album", year="1999")
    server.meta_db.set_song_override("a.archive", "title", value="Right Title")
    server.meta_db.set_song_override("a.archive", "artist", value="Right Artist")
    server.meta_db.set_song_override("a.archive", "year", value="1979")
    s = _grid(server)["a.archive"]
    assert s["title"] == "Right Title"
    assert s["artist"] == "Right Artist"
    assert s["year"] == "1979"
    assert s["album"] == "Pack Album"            # no override → pack value shows
    assert s["_sort_title"] == "Wrong Title"     # raw title stashed for the cursor


def test_grid_ignores_lock_only_override(server):
    _put(server, "a.archive", title="Pack Title")
    server.meta_db.set_song_override("a.archive", "title", locked=True)   # lock, no value
    s = _grid(server)["a.archive"]
    assert s["title"] == "Pack Title"            # a lock without a value never retitles
    assert "_sort_title" not in s                # …and stashes nothing


def test_override_beats_alias_relabel_for_artist(server):
    _put(server, "a.archive", artist="ACDC")
    server.meta_db.set_artist_alias("ACDC", "AC/DC")                 # P4 alias
    assert _grid(server)["a.archive"]["artist"] == "AC/DC"          # alias applies alone
    server.meta_db.set_song_override("a.archive", "artist", value="AC-DC (mine)")
    assert _grid(server)["a.archive"]["artist"] == "AC-DC (mine)"   # override wins over alias


def test_route_strips_private_sort_title(client, server):
    _put(server, "a.archive", title="Pack")
    server.meta_db.set_song_override("a.archive", "title", value="Shown")
    row = next(s for s in client.get("/api/library?sort=title").json()["songs"]
               if s["filename"] == "a.archive")
    assert row["title"] == "Shown"
    assert "_sort_title" not in row              # private keyset stash never leaks to the client


def test_genre_override_drives_facet_and_filter(client, server):
    # a.archive: pack genre "Rock"; b.archive: blank genre, overridden to "City Pop".
    _put(server, "a.archive", title="A", genre="Rock")
    _put(server, "b.archive", title="B", genre="")
    server.meta_db.set_song_override("b.archive", "genre", value="City Pop")
    # Facet lists the EFFECTIVE genres (override surfaces; empty raw doesn't).
    genres = client.get("/api/library/genres").json()["genres"]
    assert "City Pop" in genres and "Rock" in genres
    # Filtering by the override genre returns the overridden song…
    fns = [s["filename"] for s in client.get("/api/library?genre=City%20Pop").json()["songs"]]
    assert fns == ["b.archive"]
    # …and its raw (blank) genre no longer matches a stale query for it.
    rock = [s["filename"] for s in client.get("/api/library?genre=Rock").json()["songs"]]
    assert rock == ["a.archive"]


def test_lock_only_genre_does_not_change_facet(server):
    # A pure lock (no value) must not invent an effective genre.
    _put(server, "a.archive", title="A", genre="Metal")
    server.meta_db.set_song_override("a.archive", "genre", locked=True)
    assert server.meta_db._has_genre_overrides() is False   # value-less rows don't count
    assert server.meta_db._effective_genre_expr() == "genre"


def test_romaji_fallback_for_blank_artist_pack(server):
    fn = "CDLC/0 - City Pop/Junko-Yagami_BAY-CITY_v1_p.feedpak"
    _put(server, fn, title="Junko-Yagami_BAY-CITY_v1_p", artist="")   # scanner fell back to the filename
    s = {x["filename"]: x for x in server.meta_db.query_page()[0]}[fn]
    # the grid shows the author's romaji, not blank / the raw filename / kanji
    assert s["artist"] == "Junko Yagami"
    assert s["title"] == "BAY CITY"
    # the Details baseline (pack_fields) matches, so the popup agrees with the grid
    pack = server.meta_db.pack_fields(fn)
    assert pack["artist"] == "Junko Yagami" and pack["title"] == "BAY CITY"


def test_romaji_fallback_left_alone_when_pack_has_artist(server):
    _put(server, "a.archive", title="Real Title", artist="Real Artist")
    s = {x["filename"]: x for x in server.meta_db.query_page()[0]}["a.archive"]
    assert s["artist"] == "Real Artist" and s["title"] == "Real Title"


def test_title_keyset_paging_is_complete_with_overrides(client, server):
    # Raw titles A/B/C → title-sort order is A, B, C on the RAW column.
    _put(server, "b.archive", title="B")
    _put(server, "a.archive", title="A")
    _put(server, "c.archive", title="C")
    # Overrides that would reshuffle the order IF the cursor wrongly used the
    # displayed value — the seek must stay on the raw title, so paging still
    # covers every row exactly once (no skip/dupe).
    server.meta_db.set_song_override("a.archive", "title", value="ZZZ")
    server.meta_db.set_song_override("c.archive", "title", value="AAA")
    seen, cursor = [], None
    for _ in range(10):
        url = "/api/library?sort=title&size=1" + (f"&after={cursor}" if cursor else "")
        data = client.get(url).json()
        if not data["songs"]:
            break
        seen.append(data["songs"][0]["filename"])
        cursor = data["next_cursor"]
        if not cursor:
            break
    assert sorted(seen) == ["a.archive", "b.archive", "c.archive"]   # each exactly once


def test_enrichment_genre_fallback_precedence(client, server):
    # Precedence: override → pack genre → MusicBrainz enrichment (matched only).
    _put(server, "a.archive", title="A", genre="Rock")   # pack wins over enrichment
    _put(server, "b.archive", title="B", genre="")       # falls back to enrichment
    _put(server, "c.archive", title="C", genre="")       # override beats enrichment
    _put(server, "d.archive", title="D", genre="")       # unmatched candidate: ignored
    ins = "INSERT INTO song_enrichment (filename, match_state, genres) VALUES (?, ?, ?)"
    server.meta_db.conn.execute(ins, ("a.archive", "matched", '["metal"]'))
    server.meta_db.conn.execute(ins, ("b.archive", "matched", '["progressive rock", "rock"]'))
    server.meta_db.conn.execute(ins, ("c.archive", "matched", '["jazz"]'))
    server.meta_db.conn.execute(ins, ("d.archive", "review", '["country"]'))
    _put(server, "e.archive", title="E", genre="")       # manual pin is trusted too
    server.meta_db.conn.execute(ins, ("e.archive", "manual", '["ska"]'))
    server.meta_db.conn.commit()
    server.meta_db.set_song_override("c.archive", "genre", value="City Pop")

    genres = client.get("/api/library/genres").json()["genres"]
    assert "Rock" in genres                 # pack value kept for a
    assert "metal" not in genres            # enrichment never overrides a pack genre
    assert "progressive rock" in genres     # b: enrichment primary ([0]) surfaces
    assert "City Pop" in genres and "jazz" not in genres   # override beats enrichment
    assert "country" not in genres          # review/failed candidates never leak
    assert "ska" in genres                  # user-pinned (manual) matches count

    # Filtering by the enriched genre finds the song.
    r = client.get("/api/library", params={"genre": "progressive rock"}).json()
    assert [s["filename"] for s in r["songs"]] == ["b.archive"]


def test_no_enrichment_and_no_overrides_uses_plain_column(server):
    _put(server, "a.archive", title="A", genre="Rock")
    assert server.meta_db._effective_genre_expr() == "genre"


def test_overrides_without_enrichment_table_stay_safe(server):
    # A stand-in scenario: overrides exist but song_enrichment is gone — the
    # expression must not reference the missing table.
    server.meta_db.conn.execute("DROP TABLE song_enrichment")
    _put(server, "a.archive", title="A", genre="")
    server.meta_db.set_song_override("a.archive", "genre", value="City Pop")
    expr = server.meta_db._effective_genre_expr()
    assert "song_enrichment" not in expr
    # And it still evaluates: the override surfaces through the facet query.
    row = server.meta_db.conn.execute(
        f"SELECT {expr} FROM songs WHERE filename = 'a.archive'").fetchone()
    assert row[0] == "City Pop"
