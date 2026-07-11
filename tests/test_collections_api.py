"""Tests for smart/dynamic collections (got-feedback/feedBack#636 item 2).

A collection is a saved set of library filter rules, surfaced as a registered
library provider so it inherits the v3 Songs UI. Storage reuses the playlists
table (a `rules` JSON blob → smart collection); membership is the LIVE filter
result, not stored songs.
"""

import importlib
import library_registry
import sys

import pytest
from fastapi.testclient import TestClient


@pytest.fixture()
def server_mod(tmp_path, monkeypatch):
    monkeypatch.setenv("CONFIG_DIR", str(tmp_path))
    sys.modules.pop("server", None)
    mod = importlib.import_module("server")
    yield mod
    conn = getattr(getattr(mod, "meta_db", None), "conn", None)
    if conn is not None:
        getattr(__import__("sys").modules.get("server"), "_join_background_db_threads", lambda: None)()
        conn.close()


@pytest.fixture()
def client(server_mod):
    c = TestClient(server_mod.app)
    try:
        yield c
    finally:
        c.close()


def _put(server_mod, *, filename, title, artist, tuning_name="E Standard", tuning_sort_key=0):
    server_mod.meta_db.put(filename, 1.0, 1, {
        "title": title, "artist": artist, "album": "LP", "year": "", "duration": 1.0,
        "tuning": tuning_name, "arrangements": [], "has_lyrics": False, "format": "archive",
        "stem_count": 0, "stem_ids": [], "tuning_name": tuning_name,
        "tuning_sort_key": tuning_sort_key, "tuning_offsets": "",
    })


def _seed_mixed(server_mod):
    _put(server_mod, filename="d1.archive", title="Drop One", artist="Anna", tuning_name="Drop D", tuning_sort_key=-2)
    _put(server_mod, filename="d2.archive", title="Drop Two", artist="Bea", tuning_name="Drop D", tuning_sort_key=-2)
    _put(server_mod, filename="e1.archive", title="Std One", artist="Cy", tuning_name="E Standard")


# ── CRUD ────────────────────────────────────────────────────────────────────

def test_create_list_delete_collection(client):
    assert client.get("/api/collections").json() == {"collections": []}

    r = client.post("/api/collections", json={"name": "Drop D stuff", "rules": {"tunings": ["Drop D"]}})
    assert r.status_code == 200
    col = r.json()["collection"]
    assert col["name"] == "Drop D stuff"
    assert col["rules"] == {"tunings": "Drop D"}        # raw query-param format
    cid = col["id"]

    listed = client.get("/api/collections").json()["collections"]
    assert [c["name"] for c in listed] == ["Drop D stuff"]

    assert client.request("DELETE", f"/api/collections/{cid}").json() == {"ok": True}
    assert client.get("/api/collections").json() == {"collections": []}


def test_create_requires_name_and_sanitizes_rules(client):
    assert client.post("/api/collections", json={"rules": {}}).status_code == 400
    # Unknown rule keys are dropped (never 500); known ones normalized to the
    # raw query-param format (list→CSV, favorites→1).
    col = client.post("/api/collections", json={
        "name": "Mix", "rules": {"tunings": ["Drop D", "Eb Standard"], "sort": "title", "bogus": "x", "favorites": True},
    }).json()["collection"]
    assert col["rules"] == {"tunings": "Drop D,Eb Standard", "sort": "title", "favorites": 1}


def test_update_collection(client):
    cid = client.post("/api/collections", json={"name": "A", "rules": {"tunings": ["Drop D"]}}).json()["collection"]["id"]
    r = client.put(f"/api/collections/{cid}", json={"name": "B", "rules": {"format": "sloppak"}})
    assert r.status_code == 200
    assert r.json()["collection"]["name"] == "B"
    assert r.json()["collection"]["rules"] == {"format": "sloppak"}
    assert client.put("/api/collections/99999", json={"name": "x"}).status_code == 404


# ── Provider behaviour ──────────────────────────────────────────────────────

def test_collection_registers_as_a_provider(client, server_mod):
    _seed_mixed(server_mod)
    cid = client.post("/api/collections", json={"name": "DropD", "rules": {"tunings": ["Drop D"]}}).json()["collection"]["id"]
    providers = client.get("/api/library/providers").json()["providers"]
    ids = [p["id"] for p in providers]
    assert f"collection:{cid}" in ids


def test_collection_provider_returns_only_matching_songs(client, server_mod):
    _seed_mixed(server_mod)
    cid = client.post("/api/collections", json={"name": "DropD", "rules": {"tunings": ["Drop D"]}}).json()["collection"]["id"]
    pid = f"collection:{cid}"

    page = client.get("/api/library", params={"provider": pid}).json()
    titles = sorted(s["title"] for s in page["songs"])
    assert titles == ["Drop One", "Drop Two"]          # E Standard song excluded

    stats = client.get("/api/library/stats", params={"provider": pid}).json()
    assert stats["total_songs"] == 2


def test_collection_provider_is_local_kind(client, server_mod):
    # kind="local" keeps the client's play/art paths on the local branch (a
    # collection's matched songs are local rows), not the remote-sync branch.
    cid = client.post("/api/collections", json={"name": "C", "rules": {"tunings": ["Drop D"]}}).json()["collection"]["id"]
    prov = next(p for p in client.get("/api/library/providers").json()["providers"]
                if p["id"] == f"collection:{cid}")
    assert prov["kind"] == "local"


def test_collection_tolerates_corrupt_persisted_rules(client, server_mod):
    # A hand-edited / imported bad rules row (int where a string is expected, a
    # list for `sort`) must not crash the query — the provider re-sanitizes on
    # load. Write the bad JSON straight past the API sanitizer.
    _seed_mixed(server_mod)
    cid = client.post("/api/collections", json={"name": "Bad", "rules": {"tunings": ["Drop D"]}}).json()["collection"]["id"]
    # `artist: []` (list for a string field) and `sort: []` (unhashable) are
    # the values that would crash `.strip()` / `sort_map.get` if they reached a
    # query — they must be dropped, leaving the valid `tunings` rule intact.
    server_mod.meta_db.conn.execute(
        "UPDATE playlists SET rules = ? WHERE id = ?",
        ('{"artist": [], "sort": [], "tunings": ["Drop D"]}', cid),
    )
    server_mod.meta_db.conn.commit()
    library_registry._sync_collection_provider(server_mod.meta_db.get_collection(cid))

    r = client.get("/api/library", params={"provider": f"collection:{cid}"})
    assert r.status_code == 200                          # no 500/503 from bad rules
    assert sorted(s["title"] for s in r.json()["songs"]) == ["Drop One", "Drop Two"]


def test_collection_provider_survives_restart(client, server_mod, tmp_path, monkeypatch):
    _seed_mixed(server_mod)
    cid = client.post("/api/collections", json={"name": "DropD", "rules": {"tunings": ["Drop D"]}}).json()["collection"]["id"]
    server_mod.meta_db.conn.close()
    # Re-import the server (same CONFIG_DIR) → boot scan must re-register it.
    sys.modules.pop("server", None)
    mod2 = importlib.import_module("server")
    try:
        ids = [p["id"] for p in mod2.library_providers.list()]
        assert f"collection:{cid}" in ids
    finally:
        mod2.meta_db.conn.close()


# ── Isolation from manual playlists ─────────────────────────────────────────

def test_collections_excluded_from_playlists_and_are_read_only(client):
    cid = client.post("/api/collections", json={"name": "Coll", "rules": {"tunings": ["Drop D"]}}).json()["collection"]["id"]
    # Not listed among manual playlists...
    assert all(p["id"] != cid for p in client.get("/api/playlists").json())
    # ...and manual-playlist mutations 404 on a collection id (get_playlist gate).
    assert client.post(f"/api/playlists/{cid}/songs", json={"filename": "d1.archive"}).status_code == 404
    assert client.get(f"/api/playlists/{cid}").status_code == 404
