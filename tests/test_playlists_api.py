"""Tests for playlists, Saved-for-Later, and the Continue-Playing endpoint (P16)."""

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


def test_create_list_rename_delete(client):
    pl = client.post("/api/playlists", json={"name": "Warmups"}).json()
    pid = pl["id"]
    assert pl["name"] == "Warmups" and pl["songs"] == []
    listing = client.get("/api/playlists").json()
    assert any(p["id"] == pid and p["count"] == 0 for p in listing)
    # rename
    r = client.patch(f"/api/playlists/{pid}", json={"name": "Warm Ups"})
    assert r.json()["name"] == "Warm Ups"
    # delete
    assert client.delete(f"/api/playlists/{pid}").json() == {"ok": True}
    assert client.get(f"/api/playlists/{pid}").status_code == 404


def test_create_requires_name(client):
    assert client.post("/api/playlists", json={"name": "  "}).status_code == 400


def test_add_remove_reorder_persists(client, server):
    for fn in ("a.archive", "b.archive", "c.archive"):
        server.meta_db.put(fn, 0, 0, {})
    pid = client.post("/api/playlists", json={"name": "Set"}).json()["id"]
    client.post(f"/api/playlists/{pid}/songs", json={"filename": "a.archive"})
    client.post(f"/api/playlists/{pid}/songs", json={"filename": "b.archive"})
    client.post(f"/api/playlists/{pid}/songs", json={"filename": "c.archive"})
    songs = client.get(f"/api/playlists/{pid}").json()["songs"]
    assert [s["filename"] for s in songs] == ["a.archive", "b.archive", "c.archive"]
    # reorder
    client.post(f"/api/playlists/{pid}/reorder", json={"order": ["c.archive", "a.archive", "b.archive"]})
    songs2 = client.get(f"/api/playlists/{pid}").json()["songs"]
    assert [s["filename"] for s in songs2] == ["c.archive", "a.archive", "b.archive"]
    # remove
    client.request("DELETE", f"/api/playlists/{pid}/songs/b.archive")
    songs3 = client.get(f"/api/playlists/{pid}").json()["songs"]
    assert [s["filename"] for s in songs3] == ["c.archive", "a.archive"]


def test_saved_for_later_toggle_and_protection(client):
    # Toggle creates the system playlist on first use.
    assert client.post("/api/saved/toggle", json={"filename": "x.archive"}).json() == {"saved": True}
    assert client.post("/api/saved/toggle", json={"filename": "x.archive"}).json() == {"saved": False}
    saved = next(p for p in client.get("/api/playlists").json() if p["system_key"] == "saved_for_later")
    # Cannot delete or rename the system playlist.
    assert client.delete(f"/api/playlists/{saved['id']}").status_code == 400
    assert client.patch(f"/api/playlists/{saved['id']}", json={"name": "Nope"}).status_code == 400


def test_continue_session(client, server):
    assert client.get("/api/session/continue").json() is None
    for fn in ("one.archive", "two.archive"):
        server.meta_db.put(fn, 0, 0, {})
    client.post("/api/stats", json={"filename": "one.archive", "score": 100, "accuracy": 0.5, "lastPlayPosition": 12.0})
    client.post("/api/stats", json={"filename": "two.archive", "score": 200, "accuracy": 0.7, "lastPlayPosition": 30.0})
    cont = client.get("/api/session/continue").json()
    assert cont["filename"] == "two.archive"
    assert cont["last_position"] == 30.0
    assert "art_url" in cont and "title" in cont


def test_add_song_to_missing_playlist_is_404(client, server):
    # add_playlist_song() must not insert an orphan row for a non-existent
    # playlist (the concurrent-delete TOCTOU); it returns None → handler 404s.
    assert server.meta_db.add_playlist_song(999999, "x.archive") is None
    r = client.post("/api/playlists/999999/songs", json={"filename": "x.archive"})
    assert r.status_code == 404


def test_playlist_hides_dead_songs_when_library_populated(client, server):
    # A playlist song whose file no longer exists is hidden from contents + count
    # (mirrors the stats read-filter), but only while the library is populated.
    db = server.meta_db
    db.put("live.archive", 0, 0, {"title": "Live"})
    pid = client.post("/api/playlists", json={"name": "P"}).json()["id"]
    client.post(f"/api/playlists/{pid}/songs", json={"filename": "live.archive"})
    client.post(f"/api/playlists/{pid}/songs", json={"filename": "ghost.archive"})  # never in songs
    pl = client.get(f"/api/playlists/{pid}").json()
    names = [s["filename"] for s in pl["songs"]]
    assert "live.archive" in names and "ghost.archive" not in names
    assert [p for p in client.get("/api/playlists").json() if p["id"] == pid][0]["count"] == 1
