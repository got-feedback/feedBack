"""Tests for the curated album (P6, metadata-design §7.2): a playlists row with
kind='album' + per-slot pinned chart/arrangement, work_key stamped at add,
slot chart-swap validated to the same work, and orphan-at-read self-heal."""

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


def _put(server, fn, title, artist, arrangements=("Lead",)):
    arr = [{"name": n, "index": i} for i, n in enumerate(arrangements)]
    server.meta_db.put(fn, 0, 0, {"title": title, "artist": artist, "arrangements": arr})


def _album(client, name="My Album"):
    return client.post("/api/playlists", json={"name": name, "kind": "album"}).json()


def _add(client, pid, fn):
    return client.post(f"/api/playlists/{pid}/songs", json={"filename": fn}).json()


# ── kind discriminator ────────────────────────────────────────────────────────

def test_create_album_kind(client):
    pl = _album(client)
    assert pl["kind"] == "album"
    listed = {p["id"]: p for p in client.get("/api/playlists").json()}
    assert listed[pl["id"]]["kind"] == "album"


def test_regular_playlist_payload_has_no_album_fields(client, server):
    _put(server, "a.archive", "Song", "Artist")
    pl = client.post("/api/playlists", json={"name": "Mix"}).json()
    assert "kind" not in pl
    body = _add(client, pl["id"], "a.archive")
    assert "arrangement" not in body["songs"][0]
    assert "work_key" not in body["songs"][0]


def test_bad_kind_rejected(client):
    r = client.post("/api/playlists", json={"name": "X", "kind": "boss-fight"})
    assert r.status_code == 400


# ── add stamps work identity; slot payload carries the album fields ──────────

def test_album_add_stamps_work_key(client, server):
    _put(server, "a.archive", "Song", "Artist")
    pid = _album(client)["id"]
    slot = _add(client, pid, "a.archive")["songs"][0]
    assert slot["work_key"] == server.meta_db.work_key_for("a.archive")
    assert slot["arrangement"] is None
    assert [a["name"] for a in slot["arrangements"]] == ["Lead"]


# ── slot arrangement pin ──────────────────────────────────────────────────────

def test_slot_arrangement_pin_and_clear(client, server):
    _put(server, "a.archive", "Song", "Artist", arrangements=("Lead", "Bass"))
    pid = _album(client)["id"]
    _add(client, pid, "a.archive")
    body = client.patch(f"/api/playlists/{pid}/songs/a.archive",
                        json={"arrangement": "Bass"}).json()
    assert body["songs"][0]["arrangement"] == "Bass"
    body = client.patch(f"/api/playlists/{pid}/songs/a.archive",
                        json={"arrangement": None}).json()
    assert body["songs"][0]["arrangement"] is None


def test_slot_edit_rejected_for_mix(client, server):
    _put(server, "a.archive", "Song", "Artist")
    pid = client.post("/api/playlists", json={"name": "Mix"}).json()["id"]
    _add(client, pid, "a.archive")
    r = client.patch(f"/api/playlists/{pid}/songs/a.archive", json={"arrangement": "Lead"})
    assert r.status_code == 400


# ── slot chart swap (same work only; position + pin kept) ────────────────────

def test_slot_chart_swap_same_work(client, server):
    _put(server, "a.archive", "Song", "Artist")
    _put(server, "b.archive", "Song", "Artist")
    _put(server, "z.archive", "Closer", "Artist")
    pid = _album(client)["id"]
    _add(client, pid, "a.archive")
    _add(client, pid, "z.archive")
    client.patch(f"/api/playlists/{pid}/songs/a.archive", json={"arrangement": "Lead"})
    body = client.patch(f"/api/playlists/{pid}/songs/a.archive",
                        json={"chart_filename": "b.archive"}).json()
    slots = body["songs"]
    assert [s["filename"] for s in slots] == ["b.archive", "z.archive"]   # position kept
    assert slots[0]["arrangement"] == "Lead"                              # pin kept
    assert slots[0]["work_key"] == server.meta_db.work_key_for("b.archive")


def test_slot_chart_swap_rejects_other_work(client, server):
    _put(server, "a.archive", "Song", "Artist")
    _put(server, "x.archive", "Other", "Artist")
    pid = _album(client)["id"]
    _add(client, pid, "a.archive")
    r = client.patch(f"/api/playlists/{pid}/songs/a.archive",
                     json={"chart_filename": "x.archive"})
    assert r.status_code == 400


def test_slot_chart_swap_rejects_duplicate_member(client, server):
    _put(server, "a.archive", "Song", "Artist")
    _put(server, "b.archive", "Song", "Artist")
    pid = _album(client)["id"]
    _add(client, pid, "a.archive")
    _add(client, pid, "b.archive")
    r = client.patch(f"/api/playlists/{pid}/songs/a.archive",
                     json={"chart_filename": "b.archive"})
    assert r.status_code == 400


# ── orphan-at-read self-heal (§7.2) ──────────────────────────────────────────

def test_orphan_slot_resolves_to_current_keeper(client, server):
    _put(server, "a.archive", "Song", "Artist", arrangements=("Lead", "Rhythm"))
    _put(server, "b.archive", "Song", "Artist")
    pid = _album(client)["id"]
    _add(client, pid, "b.archive")                       # pin the 1-arr chart
    server.meta_db.delete_missing({"a.archive"})         # rescan: b's file is gone
    slot = client.get(f"/api/playlists/{pid}").json()["songs"][0]
    assert slot["filename"] == "b.archive"               # membership NOT rewritten
    assert slot["resolved_from_orphan"] is True
    assert slot["resolved_filename"] == "a.archive"      # the work's current keeper
    assert slot["title"] == "Song"
    assert "missing" not in slot


def test_orphan_slot_missing_when_work_gone(client, server):
    _put(server, "a.archive", "Song", "Artist")
    pid = _album(client)["id"]
    _add(client, pid, "a.archive")
    server.meta_db.delete_missing(set())                 # library emptied
    slot = client.get(f"/api/playlists/{pid}").json()["songs"][0]
    assert slot["missing"] is True
    assert "resolved_filename" not in slot


def test_mix_still_hides_dead_songs(client, server):
    _put(server, "a.archive", "Song", "Artist")
    pid = client.post("/api/playlists", json={"name": "Mix"}).json()["id"]
    _add(client, pid, "a.archive")
    server.meta_db.delete_missing(set())
    assert client.get(f"/api/playlists/{pid}").json()["songs"] == []


# ── list-card count parity: albums count ALL slots (list vs detail) ──────────

def test_album_list_count_includes_orphaned_and_missing_slots(client, server):
    # The detail view renders / plays EVERY album slot — a self-healing orphan
    # and a fully-missing work both stay in the denominator (§7.2) — so the
    # list-card count must agree. Guards against the mix "dead-filter" (count
    # only songs still in `songs`) leaking into albums, which undercounted a
    # slot the moment its pinned file was deleted.
    _put(server, "a.archive", "Song", "Artist")      # work A keeper (survives)
    _put(server, "b.archive", "Song", "Artist")      # work A, pinned then deleted
    _put(server, "c.archive", "Closer", "Artist")    # work C, deleted whole
    pid = _album(client)["id"]
    _add(client, pid, "a.archive")                   # live slot
    _add(client, pid, "b.archive")                   # → orphan (self-heals to a)
    _add(client, pid, "c.archive")                   # → fully missing
    server.meta_db.delete_missing({"a.archive"})     # rescan: only a survives
    detail = client.get(f"/api/playlists/{pid}").json()["songs"]
    assert len(detail) == 3                           # detail keeps all 3 slots
    listed = {p["id"]: p for p in client.get("/api/playlists").json()}
    assert listed[pid]["count"] == 3                  # list card agrees (was 1)


def test_mix_list_count_still_dead_filters(client, server):
    # The other side of the discriminator: a mix's list count keeps hiding dead
    # songs, so the album fix doesn't regress non-album playlists.
    _put(server, "a.archive", "Song", "Artist")
    _put(server, "b.archive", "Closer", "Artist")
    pid = client.post("/api/playlists", json={"name": "Mix"}).json()["id"]
    _add(client, pid, "a.archive")
    _add(client, pid, "b.archive")
    server.meta_db.delete_missing({"a.archive"})     # b's file gone
    listed = {p["id"]: p for p in client.get("/api/playlists").json()}
    assert listed[pid]["count"] == 1                  # dead b not counted
