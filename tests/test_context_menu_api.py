"""Tests for the R2 context-menu backend: per-song "Refresh metadata"
(explicit re-match reset + kick) and "Get info" (file location + pack
contents). The refresh flow reuses the P8 fake-transport pattern — nothing
here opens a socket."""

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


def _put(server, fn, title="Thunderstruck", artist="AC/DC", album="", year="1990",
         duration=292):
    server.meta_db.put(fn, 0, 0, {
        "title": title, "artist": artist, "album": album, "year": year,
        "duration": duration, "arrangements": [{"name": "Lead", "index": 0}],
    })


def make_sloppak(server, name, extra_yaml="", title="Thunderstruck", artist="AC/DC"):
    d = server.DLC_DIR / name
    d.mkdir(parents=True)
    (d / "manifest.yaml").write_text(
        f"title: {title}\nartist: {artist}\nduration: 292\n"
        "arrangements:\n  - name: Lead\n    id: lead\n"
        "stems:\n  - id: full\n    file: stems/full.ogg\n" + extra_yaml,
        encoding="utf-8")
    _put(server, name, title=title, artist=artist)
    return d


# ── Refresh metadata ──────────────────────────────────────────────────────────

def test_refresh_resets_even_a_manual_pin_and_rematches(server, client, monkeypatch):
    _put(server, "a.sloppak")
    server.meta_db.set_enrichment_manual(
        "a.sloppak", {"recording_id": "old-pin", "title": "Thunderstruck",
                      "artist": "AC/DC"}, source="search")
    # The reset itself is synchronous; the kicked pass runs on a daemon
    # thread, so assert the reset here and drive the re-match inline below.
    r = client.post("/api/enrichment/refresh/a.sloppak")
    assert r.status_code == 200
    for _ in range(200):
        if not client.get("/api/enrichment/status").json()["running"]:
            break
        import time as _t
        _t.sleep(0.02)
    row = server.meta_db.get_enrichment("a.sloppak")
    assert row["match_state"] == "unscanned"        # the pin was discarded
    assert row["mb_recording_id"] is None
    assert row["attempts"] == 0
    # …and the normal pass re-matches it (fake transport, network flag on).
    def fake(path, params):
        return {"recordings": [{
            "id": "rec-new", "score": 100, "title": "Thunderstruck",
            "length": 292000,
            "artist-credit": [{"name": "AC/DC", "artist": {
                "id": "art-1", "name": "AC/DC", "sort-name": "AC/DC"}}],
            "releases": [{"id": "rel-1", "title": "The Razors Edge",
                          "status": "Official", "date": "1990-09-24",
                          "release-group": {"primary-type": "Album"}}],
        }]}
    monkeypatch.setattr(server, "_mb_http_get", fake)
    monkeypatch.setattr(server, "_enrich_network_enabled", lambda: True)
    server._background_enrich()
    assert server.meta_db.get_enrichment("a.sloppak")["mb_recording_id"] == "rec-new"


def test_refresh_unknown_song_404(server, client):
    assert client.post("/api/enrichment/refresh/ghost.sloppak").status_code == 404


# ── Get info ──────────────────────────────────────────────────────────────────

def test_fileinfo_sloppak_contents(server, client):
    make_sloppak(server, "a.sloppak",
                 extra_yaml="mbid: 12345678-abcd-4ef0-9876-0123456789ab\n"
                            "genres: [rock, hard rock]\ntrack: 3\n")
    body = client.get("/api/chart/a.sloppak/fileinfo").json()
    assert body["format"] == "sloppak"
    assert body["filename"] == "a.sloppak"
    assert body["path"].endswith("a.sloppak")
    assert body["size"] > 0
    m = body["manifest"]
    assert m["title"] == "Thunderstruck"
    assert m["arrangements"] == ["Lead"]
    assert m["stems"] == ["full"]
    assert m["has_cover"] is False
    assert m["identity"]["mbid"] == "12345678-abcd-4ef0-9876-0123456789ab"
    assert m["identity"]["genres"] == ["rock", "hard rock"]
    assert m["identity"]["track"] == 3
    assert "isrc" not in m["identity"]              # only keys actually present
    # No enrichment row yet → no match block (the panel shows "Not scanned").
    assert "match" not in body


def test_fileinfo_includes_match_verdict(server, client):
    make_sloppak(server, "a.sloppak")
    server.meta_db.set_enrichment_manual(
        "a.sloppak", {"recording_id": "rec-1", "title": "Thunderstruck",
                      "artist": "AC/DC", "album": "The Razors Edge"},
        source="search")
    body = client.get("/api/chart/a.sloppak/fileinfo").json()
    assert body["match"]["match_state"] == "manual"
    assert body["match"]["canon_album"] == "The Razors Edge"


def test_fileinfo_missing_and_traversal(server, client):
    assert client.get("/api/chart/ghost.sloppak/fileinfo").status_code == 404
    assert client.get("/api/chart/..%2f..%2fetc%2fpasswd/fileinfo").status_code in (403, 404)


def test_fileinfo_non_chart_file_is_404(server, client):
    """A stray non-song file the user keeps under DLC_DIR must not have its
    path/size/mtime exposed — the route is charts only, not a filesystem stat."""
    (server.DLC_DIR / "private-notes.txt").write_text("secret", encoding="utf-8")
    assert client.get("/api/chart/private-notes.txt/fileinfo").status_code == 404
