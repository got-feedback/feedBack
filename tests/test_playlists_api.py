"""Tests for playlists, Saved-for-Later, and the Continue-Playing endpoint (P16)."""

import importlib
import sys

import pytest
from fastapi.testclient import TestClient

# Moved to routers/playlists in R3; reads appstate.config_dir, which the
# `server` fixture configures via CONFIG_DIR before this is called.
from routers.playlists import _playlist_cover_path


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


# ── Playlist covers (content-dependent art + custom upload) ──────────────────

def _png_b64():
    """A tiny base64 PNG with the data-URL prefix, like the browser sends."""
    import base64
    import io
    from PIL import Image
    buf = io.BytesIO()
    Image.new("RGB", (4, 4), (200, 30, 60)).save(buf, "PNG")
    return "data:image/png;base64," + base64.b64encode(buf.getvalue()).decode()


def test_list_includes_song_art_urls_for_content_cover(client, server):
    for fn in ("x.archive", "y.archive"):
        server.meta_db.put(fn, 0, 0, {})
    pid = client.post("/api/playlists", json={"name": "Arts"}).json()["id"]
    client.post(f"/api/playlists/{pid}/songs", json={"filename": "x.archive"})
    client.post(f"/api/playlists/{pid}/songs", json={"filename": "y.archive"})
    pl = [p for p in client.get("/api/playlists").json() if p["id"] == pid][0]
    assert pl["art_urls"] == ["/api/song/x.archive/art", "/api/song/y.archive/art"]
    assert pl["cover_url"] is None   # no custom cover yet


def test_custom_cover_roundtrip(client):
    pid = client.post("/api/playlists", json={"name": "Cover"}).json()["id"]
    r = client.post(f"/api/playlists/{pid}/cover", json={"image": _png_b64()})
    assert r.status_code == 200 and r.json()["ok"] is True
    assert r.json()["cover_url"].startswith(f"/api/playlists/{pid}/cover")
    # list + detail both report it
    assert [p for p in client.get("/api/playlists").json() if p["id"] == pid][0]["cover_url"]
    assert client.get(f"/api/playlists/{pid}").json()["cover_url"]
    # served as a real PNG
    img = client.get(f"/api/playlists/{pid}/cover")
    assert img.status_code == 200 and img.headers["content-type"] == "image/png"
    assert img.content[:8] == b"\x89PNG\r\n\x1a\n"
    # removed
    assert client.delete(f"/api/playlists/{pid}/cover").json() == {"ok": True}
    assert client.get(f"/api/playlists/{pid}/cover").status_code == 404
    assert client.get(f"/api/playlists/{pid}").json()["cover_url"] is None


def test_cover_rejects_non_image(client):
    pid = client.post("/api/playlists", json={"name": "Bad"}).json()["id"]
    assert client.post(f"/api/playlists/{pid}/cover",
                       json={"image": "data:text/plain;base64,bm90IGFuIGltYWdl"}).status_code == 400
    assert client.post(f"/api/playlists/{pid}/cover", json={"image": ""}).status_code == 400


def test_cover_rejects_non_string_image_with_400_not_500(client):
    # A non-string `image` (number / null / object) must be a clean 400, not a
    # 500 from `"," in <non-str>` raising TypeError before the type check.
    pid = client.post("/api/playlists", json={"name": "Typed"}).json()["id"]
    for bad in (123, None, {"x": 1}, ["a"]):
        assert client.post(f"/api/playlists/{pid}/cover", json={"image": bad}).status_code == 400


def test_deleting_playlist_removes_custom_cover(client, server):
    pid = client.post("/api/playlists", json={"name": "Doomed"}).json()["id"]
    client.post(f"/api/playlists/{pid}/cover", json={"image": _png_b64()})
    assert _playlist_cover_path(pid).exists()
    client.delete(f"/api/playlists/{pid}")
    assert not _playlist_cover_path(pid).exists()


# ── Tuning-check payload (per-song data the playlist tuning check scores) ────
# A playlist grouped BY TUNING is a run you can practise without retuning, so
# the detail view flags rows your instrument can't reach. Scoring needs more
# than the tuning NAME: two "Custom Tuning" rows are different tunings, and a
# bass-only chart has to be measured against bass base pitches.

def test_playlist_songs_carry_tuning_offsets_for_the_check(client, server):
    db = server.meta_db
    db.put("drop.archive", 0, 0, {"title": "Drop", "tuning_name": "Drop D",
                                  "tuning_offsets": "-2 0 0 0 0 0"})
    pid = client.post("/api/playlists", json={"name": "T"}).json()["id"]
    client.post(f"/api/playlists/{pid}/songs", json={"filename": "drop.archive"})
    song = client.get(f"/api/playlists/{pid}").json()["songs"][0]
    assert song["tuning_offsets"] == "-2 0 0 0 0 0"
    assert song["tuning_name"] == "Drop D"


def test_playlist_songs_flag_bass_only_charts(client, server):
    # Every arrangement a bass part → bass_only, so coverage scores the row
    # against bass strings. A chart that ALSO has a guitar part must not be
    # flagged, or a guitarist's row gets measured on the wrong instrument.
    db = server.meta_db
    db.put("bassonly.archive", 0, 0, {"title": "Bass Only", "arrangements": [
        {"name": "Bass"}, {"name": "Alt. Bass"}]})
    db.put("mixed.archive", 0, 0, {"title": "Mixed", "arrangements": [
        {"name": "Lead"}, {"name": "Bass"}]})
    db.put("noarr.archive", 0, 0, {"title": "No Arrangements"})
    pid = client.post("/api/playlists", json={"name": "B"}).json()["id"]
    for fn in ("bassonly.archive", "mixed.archive", "noarr.archive"):
        client.post(f"/api/playlists/{pid}/songs", json={"filename": fn})
    got = {s["filename"]: s["bass_only"] for s in client.get(f"/api/playlists/{pid}").json()["songs"]}
    assert got == {"bassonly.archive": True, "mixed.archive": False, "noarr.archive": False}


def test_bass_only_flag_survives_adversarial_arrangement_data(client, server):
    # Corrupt/odd `arrangements` must not 500 the playlist, and must not claim
    # bass — an unscoreable row is left for the client to report as "unknown".
    db = server.meta_db
    cases = {
        "empty.archive": [],
        "unnamed.archive": [{"name": ""}],
        "nullname.archive": [{"name": None}],
        "substring.archive": [{"name": "Bassoon"}],       # not a bass part
        "cased.archive": [{"name": "BASS"}],              # is one
    }
    for fn, arrs in cases.items():
        db.put(fn, 0, 0, {"title": fn, "arrangements": arrs})
    pid = client.post("/api/playlists", json={"name": "Adv"}).json()["id"]
    for fn in cases:
        client.post(f"/api/playlists/{pid}/songs", json={"filename": fn})
    r = client.get(f"/api/playlists/{pid}")
    assert r.status_code == 200
    got = {s["filename"]: s["bass_only"] for s in r.json()["songs"]}
    assert got == {"empty.archive": False, "unnamed.archive": False,
                   "nullname.archive": False, "substring.archive": False,
                   "cased.archive": True}


def test_playlist_song_with_no_tuning_data_reports_empty_not_missing(client, server):
    # The key must always be present: the client distinguishes "no tuning data"
    # (unknown — say nothing) from "wrong tuning" (flag it), and a missing key
    # would make every row unscoreable by accident rather than by fact.
    db = server.meta_db
    db.put("bare.archive", 0, 0, {"title": "Bare"})
    pid = client.post("/api/playlists", json={"name": "Bare"}).json()["id"]
    client.post(f"/api/playlists/{pid}/songs", json={"filename": "bare.archive"})
    song = client.get(f"/api/playlists/{pid}").json()["songs"][0]
    assert song["tuning_offsets"] == ""
    assert song["bass_only"] is False
