"""Tests for the PR-C cover picker's server side: the /art/candidates
assembly (current + pack + Cover Art Archive index candidates), the
`caa_index_{id}.json` TTL-less cache around the new `_caa_release_index`
seam, the `?source=pack` art-route variant, and the redirect-following
art-by-URL fetch that lets a CAA pick apply through the existing
override lane.

Both network seams (`_caa_release_index`, `requests.get` under
`_fetch_art_url`) are faked — nothing here opens a socket, and the
offline default is itself asserted. Fixture patterns mirror
tests/test_art_layer.py.
"""

import importlib
import io as _io
import sys

import pytest
from fastapi.testclient import TestClient
from PIL import Image


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


def png_bytes(color=(200, 30, 30)):
    buf = _io.BytesIO()
    Image.new("RGB", (4, 4), color).save(buf, "PNG")
    return buf.getvalue()


def b64(data):
    import base64
    return base64.b64encode(data).decode()


def make_sloppak(server, name, with_cover=False, title="Song", artist="Artist"):
    d = server.DLC_DIR / name
    d.mkdir(parents=True)
    (d / "manifest.yaml").write_text(
        f"title: {title}\nartist: {artist}\nduration: 100\n"
        "arrangements: []\nstems: []\n", encoding="utf-8")
    if with_cover:
        (d / "cover.jpg").write_bytes(png_bytes((10, 200, 10)))
    server.meta_db.put(name, 0, 0, {
        "title": title, "artist": artist, "album": "", "year": "",
        "duration": 100, "arrangements": [{"name": "Lead", "index": 0}],
    })
    return d


def _match_row(server, fn, release_id="rel-1", state="matched"):
    """Seed a matched/manual enrichment row with a release id (as the P8
    matcher would have written)."""
    song = server.meta_db.enrichment_song_row(fn)
    h = server.meta_db.enrichment_content_hash(
        song["artist"], song["title"], song["album"], song["duration"])
    server.meta_db.apply_enrichment_match(
        fn, h, state, source="text", score=1.0,
        cand={"recording_id": "rec-1", "release_id": release_id,
              "title": song["title"], "artist": song["artist"]})


def _review_row(server, fn, candidates):
    """Seed a review-tier row: no canonical release of its own, releases
    live only in the stored candidates JSON."""
    song = server.meta_db.enrichment_song_row(fn)
    h = server.meta_db.enrichment_content_hash(
        song["artist"], song["title"], song["album"], song["duration"])
    server.meta_db.apply_enrichment_match(
        fn, h, "review", source="text", score=0.75, candidates=candidates)


def _img(img_id, *, front=False, approved=True, sizes=("500",)):
    """One CAA index image dict, with thumbnails for the given size keys."""
    return {
        "id": img_id,
        "front": front,
        "approved": approved,
        "types": ["Front"] if front else ["Back"],
        "image": f"https://caa.example/full/{img_id}.jpg",
        "thumbnails": {s: f"https://caa.example/{img_id}-{s}.jpg" for s in sizes},
    }


@pytest.fixture()
def caa_index(server, monkeypatch):
    """Fake CAA index transport + network flag on (mirrors the art-layer
    `caa` fixture; this is the picker's own seam)."""
    calls = []
    indexes = {
        "rel-1": {"images": [_img(101, front=True),
                             _img(102, approved=False, sizes=("250",))]},
        "rel-2": {"images": [_img(201, front=True)]},
    }

    def fake(release_id):
        calls.append(release_id)
        return indexes.get(release_id)   # unknown release → None (a CAA 404)
    fake.calls, fake.indexes = calls, indexes
    monkeypatch.setattr(server, "_caa_release_index", fake)
    monkeypatch.setattr(server, "_enrich_network_enabled", lambda: True)
    return fake


def _get(client, fn="a.sloppak"):
    r = client.get(f"/api/song/{fn}/art/candidates")
    assert r.status_code == 200
    return r.json()


def _caa(body):
    return [c for c in body["candidates"] if c["kind"] == "caa"]


def _current(body):
    return next(c for c in body["candidates"] if c["kind"] == "current")


# ── candidate assembly ────────────────────────────────────────────────────────

def test_matched_row_lists_index_images(server, client, caa_index):
    make_sloppak(server, "a.sloppak")                 # no pack art
    _match_row(server, "a.sloppak", release_id="rel-1")
    body = _get(client)
    assert body["pending"] is False
    cur = _current(body)
    assert cur["provenance"] == "none"                # nothing served yet
    assert not any(c["kind"] == "pack" for c in body["candidates"])
    caa = _caa(body)
    assert [c["thumb_url"] for c in caa] == [
        "https://caa.example/101-500.jpg",            # front, 500px
        "https://caa.example/102-250.jpg",            # 250 fallback
    ]
    assert caa[0]["provenance"] == "matched"
    assert caa[0]["approved"] is True and caa[1]["approved"] is False
    assert caa[0]["release_id"] == "rel-1"
    assert caa_index.calls == ["rel-1"]               # one index fetch


def test_review_row_includes_candidate_releases(server, client, caa_index):
    make_sloppak(server, "a.sloppak")
    _review_row(server, "a.sloppak", [
        {"recording_id": "rec-1", "title": "Song", "release_id": "rel-1"},
        {"recording_id": "rec-2", "title": "Song", "release_id": "rel-2"},
        {"recording_id": "rec-3", "title": "Song", "release_id": "rel-1"},  # dupe
        {"recording_id": "rec-4", "title": "Song"},   # no release — skipped
    ])
    body = _get(client)
    assert caa_index.calls == ["rel-1", "rel-2"]      # deduped, in order
    assert {c["release_id"] for c in _caa(body)} == {"rel-1", "rel-2"}
    assert len(_caa(body)) == 3


def test_unmatched_instant_tiles_only(server, client, caa_index):
    """No enrichment row at all → current (+ pack when it exists), empty
    caa list, and the index seam is never asked."""
    make_sloppak(server, "a.sloppak", with_cover=True)
    body = _get(client)
    kinds = [c["kind"] for c in body["candidates"]]
    assert kinds == ["current", "pack"]
    assert _current(body)["provenance"] == "pack"
    pack = body["candidates"][1]
    assert pack["thumb_url"].endswith("?source=pack")
    assert caa_index.calls == []


def test_override_provenance_is_yours(server, client, caa_index):
    make_sloppak(server, "a.sloppak", with_cover=True)
    assert client.post("/api/song/a.sloppak/art/upload",
                       json={"image": b64(png_bytes((1, 2, 3)))}).json()["ok"]
    body = _get(client)
    assert _current(body)["provenance"] == "yours"
    # Pack original stays offered even while the override is what serves.
    assert any(c["kind"] == "pack" for c in body["candidates"])


def test_offline_empty_caa_list_no_error(server, client):
    """Under the plain test env the REAL index seam refuses (offline guard);
    the endpoint still answers 200 with the instant tiles and caches
    nothing (a later open retries)."""
    make_sloppak(server, "a.sloppak")
    _match_row(server, "a.sloppak", release_id="rel-1")
    body = _get(client)
    assert _caa(body) == []
    assert _current(body)["kind"] == "current"
    assert list(server.ART_CACHE_DIR.glob("caa_index_*.json")) == []


def test_index_cached_second_call_no_refetch(server, client, caa_index):
    make_sloppak(server, "a.sloppak")
    _match_row(server, "a.sloppak", release_id="rel-1")
    first = _get(client)
    assert len(caa_index.calls) == 1
    cache = server.ART_CACHE_DIR / "caa_index_rel-1.json"
    assert cache.is_file()                            # TTL-less on-disk cache
    # Even a changed upstream index is not re-asked — indexes are stable.
    caa_index.indexes["rel-1"] = {"images": []}
    second = _get(client)
    assert len(caa_index.calls) == 1                  # no refetch
    assert _caa(second) == _caa(first)


def test_404_release_cached_as_empty(server, client, caa_index):
    """A coverless release (CAA 404 → seam returns None) yields no tiles and
    is never re-asked either."""
    make_sloppak(server, "a.sloppak")
    _match_row(server, "a.sloppak", release_id="rel-missing")
    assert _caa(_get(client)) == []
    assert _caa(_get(client)) == []
    assert caa_index.calls == ["rel-missing"]


def test_caa_candidates_capped_at_12(server, client, caa_index):
    make_sloppak(server, "a.sloppak")
    caa_index.indexes["rel-big"] = {
        "images": [_img(300 + i, front=(i == 0)) for i in range(20)]}
    _match_row(server, "a.sloppak", release_id="rel-big")
    assert len(_caa(_get(client))) == server._ART_PICKER_MAX_CAA == 12


def test_demo_mode_blocks_candidates(server, client, monkeypatch):
    """Read-only, but it spends the shared CAA rate budget — blocked in demo
    like enrichment search/kick."""
    make_sloppak(server, "a.sloppak")
    monkeypatch.setenv("FEEDBACK_DEMO_MODE", "1")
    r = client.get("/api/song/a.sloppak/art/candidates")
    assert r.status_code == 403
    assert r.json() == {"error": "demo mode: read-only"}


def test_unknown_song_404(server, client):
    assert client.get("/api/song/ghost.sloppak/art/candidates").status_code == 404


# ── the ?source=pack serve variant ────────────────────────────────────────────

def test_pack_source_serves_pack_under_override(server, client):
    """The Pack-original tile's thumb must show the pack's own art even while
    an override is what the plain route serves — and 404 when the song ships
    no art of its own."""
    make_sloppak(server, "a.sloppak", with_cover=True)
    assert client.post("/api/song/a.sloppak/art/upload",
                       json={"image": b64(png_bytes((1, 2, 3)))}).json()["ok"]
    assert client.get("/api/song/a.sloppak/art").headers["content-type"] == "image/png"
    r = client.get("/api/song/a.sloppak/art?source=pack")
    assert r.status_code == 200
    assert r.headers["content-type"] == "image/jpeg"  # the pack cover, not the override
    make_sloppak(server, "bare.sloppak")
    assert client.get("/api/song/bare.sloppak/art?source=pack").status_code == 404


# ── art-by-URL redirect handling (what makes a CAA pick applyable) ────────────

class _FakeResp:
    def __init__(self, status, headers=None, chunks=()):
        self.status_code = status
        self.headers = headers or {}
        self._chunks = chunks

    def iter_content(self, _size):
        return iter(self._chunks)

    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False


def test_fetch_art_url_follows_redirects_validating_each_hop(server, monkeypatch):
    import requests
    fetched, checked = [], []

    def fake_get(url, **kw):
        fetched.append(url)
        assert kw.get("allow_redirects") is False     # hops stay manual
        if "coverartarchive.example" in url:
            return _FakeResp(307, {"Location": "https://archive.example/img.png"})
        return _FakeResp(200, chunks=[b"IMGDATA"])

    monkeypatch.setattr(requests, "get", fake_get)
    monkeypatch.setattr(server, "_enrich_network_enabled", lambda: True)
    monkeypatch.setattr(server, "_url_host_is_internal",
                        lambda u: (checked.append(u), False)[1])
    data = server._fetch_art_url("https://coverartarchive.example/release/x/front-500")
    assert data == b"IMGDATA"
    assert fetched == ["https://coverartarchive.example/release/x/front-500",
                       "https://archive.example/img.png"]
    assert checked == fetched                          # every hop was gated


def test_fetch_art_url_blocks_redirect_to_internal(server, monkeypatch):
    import requests
    monkeypatch.setattr(requests, "get", lambda url, **kw: _FakeResp(
        302, {"Location": "http://internal.example/x.png"}))
    monkeypatch.setattr(server, "_enrich_network_enabled", lambda: True)
    monkeypatch.setattr(server, "_url_host_is_internal",
                        lambda u: "internal" in u)
    with pytest.raises(ValueError):
        server._fetch_art_url("https://public.example/x.png")


def test_fetch_art_url_redirect_budget(server, monkeypatch):
    import requests
    monkeypatch.setattr(requests, "get", lambda url, **kw: _FakeResp(
        307, {"Location": "https://public.example/next.png"}))
    monkeypatch.setattr(server, "_enrich_network_enabled", lambda: True)
    monkeypatch.setattr(server, "_url_host_is_internal", lambda u: False)
    with pytest.raises(server.EnrichTransportError):
        server._fetch_art_url("https://public.example/x.png")
