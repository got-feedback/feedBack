"""Keyset (cursor) pagination for the library grid (feedBack#636 item 3, stage 1).

Pins the data layer the virtualized grid builds on:
  - every sort gets a unique `filename` tiebreak → a TOTAL order (fixes the
    latent OFFSET skip/dupe across equal-key rows);
  - `/api/library?after=<cursor>` walks the SAME total order with a WHERE-seek,
    returning exactly the OFFSET page would, with no gaps or dupes;
  - bad cursors / non-keyset sorts fall back to OFFSET safely.
"""

import importlib
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
        conn.close()


@pytest.fixture()
def client(server_mod):
    c = TestClient(server_mod.app)
    try:
        yield c
    finally:
        c.close()


def _seed(server_mod, n=25, *, shared_artist=False):
    for i in range(n):
        artist = "SameArtist" if shared_artist else f"Artist{i:02d}"
        server_mod.meta_db.put(f"song{i:02d}.archive", float(i), 1, {
            "title": f"Title{i:02d}", "artist": artist, "album": "LP", "year": "",
            "duration": 1.0, "tuning": "E Standard", "arrangements": [], "has_lyrics": False,
            "format": "archive", "stem_count": 0, "stem_ids": [], "tuning_name": "E Standard",
            "tuning_sort_key": 0, "tuning_offsets": "",
        })


def _walk_keyset(client, sort, size, total):
    """Page the whole library via the cursor and return the filename order."""
    seen, cursor, guard = [], "", 0
    while len(seen) < total and guard < total + 5:
        guard += 1
        params = {"sort": sort, "size": size}
        if cursor:
            params["after"] = cursor
        body = client.get("/api/library", params=params).json()
        seen.extend(s["filename"] for s in body["songs"])
        cursor = body.get("next_cursor")
        if not body["songs"] or not cursor:
            break
    return seen


def _walk_offset(client, sort, size, total):
    seen, page = [], 0
    while len(seen) < total:
        body = client.get("/api/library", params={"sort": sort, "size": size, "page": page}).json()
        if not body["songs"]:
            break
        seen.extend(s["filename"] for s in body["songs"])
        page += 1
    return seen


# artist/artist-desc left out: their ORDER BY carries a title secondary
# (grid cards read alphabetically within an artist, like the tree), which
# the two-term cursor cannot seek — they page by OFFSET (covered below).
@pytest.mark.parametrize("sort", ["title", "title-desc", "recent"])
def test_keyset_matches_offset_exactly(client, server_mod, sort):
    _seed(server_mod, 25)
    offset_order = _walk_offset(client, sort, 7, 25)
    keyset_order = _walk_keyset(client, sort, 7, 25)
    assert keyset_order == offset_order              # same order...
    assert len(keyset_order) == 25
    assert len(set(keyset_order)) == 25              # ...no gaps, no dupes


def test_stable_tiebreak_on_equal_keys(client, server_mod):
    # 25 songs, all the SAME artist → the artist sort is decided entirely by the
    # filename tiebreak. Both pagers must still cover all 25 with no dupe.
    _seed(server_mod, 25, shared_artist=True)
    keyset_order = _walk_offset(client, "artist", 6, 25)
    assert len(keyset_order) == 25 and len(set(keyset_order)) == 25
    assert keyset_order == sorted(keyset_order)      # tiebreak is filename ASC


def test_first_page_has_cursor_and_no_after_is_offset(client, server_mod):
    _seed(server_mod, 5)
    body = client.get("/api/library", params={"sort": "title", "size": 2}).json()
    assert body["next_cursor"]                       # keyset sort: cursor offered
    body = client.get("/api/library", params={"sort": "artist", "size": 2}).json()
    assert body["next_cursor"] is None               # artist sorts page by OFFSET
    assert [s["filename"] for s in body["songs"]] == ["song00.archive", "song01.archive"]


def test_bad_cursor_falls_back_to_first_page(client, server_mod):
    _seed(server_mod, 5)
    body = client.get("/api/library", params={"sort": "artist", "size": 3, "after": "not-a-cursor"}).json()
    assert [s["filename"] for s in body["songs"]] == ["song00.archive", "song01.archive", "song02.archive"]


def test_legacy_dir_desc_keysets_correctly(client, server_mod):
    # The legacy `sort=artist&dir=desc` shape must keyset against a DESC order
    # (canonicalized to artist-desc), not seek `>` against it → no gaps/dupes.
    _seed(server_mod, 20)
    offset_order, page = [], 0
    while True:
        body = client.get("/api/library", params={"sort": "title", "dir": "desc", "size": 6, "page": page}).json()
        if not body["songs"]:
            break
        offset_order.extend(s["filename"] for s in body["songs"])
        page += 1
    keyset, cursor, guard = [], "", 0
    while len(keyset) < 20 and guard < 25:
        guard += 1
        params = {"sort": "title", "dir": "desc", "size": 6}
        if cursor:
            params["after"] = cursor
        body = client.get("/api/library", params=params).json()
        keyset.extend(s["filename"] for s in body["songs"])
        cursor = body.get("next_cursor")
        if not body["songs"] or not cursor:
            break
    assert keyset == offset_order
    assert len(set(keyset)) == 20


@pytest.mark.parametrize("sort", ["recent"])
def test_keyset_handles_null_sort_keys(client, server_mod, sort):
    # NULL artist/mtime (corrupt/legacy rows past put()'s '' defaults) sort
    # first in ASC / last in DESC; keyset must cover them exactly like OFFSET.
    _seed(server_mod, 10)
    server_mod.meta_db.conn.executemany(
        "INSERT INTO songs (filename, mtime, size, title, artist) VALUES (?, NULL, 1, ?, NULL)",
        [("zznull1.archive", "ZZ1"), ("zznull2.archive", "ZZ2")],
    )
    server_mod.meta_db.conn.commit()
    offset_order = _walk_offset(client, sort, 4, 12)
    keyset_order = _walk_keyset(client, sort, 4, 12)
    assert keyset_order == offset_order
    assert len(keyset_order) == 12 and len(set(keyset_order)) == 12


def test_non_keyset_sort_offers_no_cursor(client, server_mod):
    _seed(server_mod, 5)
    body = client.get("/api/library", params={"sort": "tuning", "size": 2}).json()
    assert body["next_cursor"] is None               # compound sort → OFFSET only
    assert len(body["songs"]) == 2
