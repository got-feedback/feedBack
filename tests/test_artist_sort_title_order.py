"""The grid's artist sort orders WITHIN an artist by title (tree-view feel),
not raw filename — the tester's "list is organised by artist, but the cards
look alphabetical/random" report. Artist sorts page by OFFSET now (the title
secondary can't ride the two-term keyset cursor), so pagination across an
artist boundary is pinned too."""

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


def _put(server, fn, artist, title):
    server.meta_db.put(fn, 0, 0, {
        "title": title, "artist": artist, "album": "", "year": "",
        "duration": 100, "arrangements": [{"name": "Lead", "index": 0}],
    })


def test_artist_sort_orders_titles_within_artist(server, client):
    # Filenames deliberately REVERSE the title order, so filename ordering
    # (the old behaviour) and title ordering disagree.
    _put(server, "z1.sloppak", "Alpha Band", "Aardvark")
    _put(server, "a9.sloppak", "Alpha Band", "Zebra")
    _put(server, "m5.sloppak", "Alpha Band", "Mango")
    _put(server, "q1.sloppak", "Beta Band", "Only Song")
    body = client.get("/api/library", params={"sort": "artist", "size": 50}).json()
    assert [s["title"] for s in body["songs"]] == ["Aardvark", "Mango", "Zebra", "Only Song"]
    # Z→A flips the ARTIST order; titles stay A→Z within each artist.
    body = client.get("/api/library", params={"sort": "artist-desc", "size": 50}).json()
    assert [s["title"] for s in body["songs"]] == ["Only Song", "Aardvark", "Mango", "Zebra"]


def test_artist_sort_offset_pagination_no_skip_or_dupe(server, client):
    for i in range(7):
        _put(server, f"f{6 - i}.sloppak", "One Artist", f"Title {chr(65 + i)}")
    seen = []
    for page in range(4):
        body = client.get("/api/library", params={"sort": "artist", "size": 2, "page": page}).json()
        seen += [s["title"] for s in body["songs"]]
    assert seen == [f"Title {chr(65 + i)}" for i in range(7)]
    # And no keyset cursor is offered for artist sorts (OFFSET path).
    body = client.get("/api/library", params={"sort": "artist", "size": 2}).json()
    assert body["next_cursor"] is None
