"""Tests for the R3 art layer: the user>pack>CAA serve chain, user overrides
(upload / URL / delete, with GIF kept animated and LOCAL-ONLY), and the
enrichment art worker's Cover Art Archive fetch + LRU cache.

Both network seams (`_caa_http_get`, `_fetch_art_url`) are faked — nothing
here opens a socket, and the offline default is itself asserted.
"""

import importlib
import enrichment
from routers import art
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
            getattr(__import__("sys").modules.get("server"), "_join_background_db_threads", lambda: None)()
            conn.close()
        sys.modules.pop("server", None)


@pytest.fixture()
def client(server):
    return TestClient(server.app)


def png_bytes(color=(200, 30, 30)):
    buf = _io.BytesIO()
    Image.new("RGB", (4, 4), color).save(buf, "PNG")
    return buf.getvalue()


def gif_bytes():
    """A tiny 2-frame animated GIF."""
    buf = _io.BytesIO()
    frames = [Image.new("P", (4, 4), i) for i in (0, 255)]
    frames[0].save(buf, "GIF", save_all=True, append_images=frames[1:], duration=100)
    return buf.getvalue()


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


def b64(data):
    import base64
    return base64.b64encode(data).decode()


# ── the serve chain: user > pack > CAA ────────────────────────────────────────

def test_user_override_beats_pack_art(server, client):
    make_sloppak(server, "a.sloppak", with_cover=True)
    r = client.get("/api/song/a.sloppak/art")
    assert r.status_code == 200                       # pack art serves
    assert client.post("/api/song/a.sloppak/art/upload",
                       json={"image": b64(png_bytes((1, 2, 3)))}).json()["ok"]
    r = client.get("/api/song/a.sloppak/art")
    assert r.status_code == 200
    assert r.headers["content-type"] == "image/png"   # the override, not the pack jpeg
    # Removing the override falls back to pack art. (The route lives under
    # /api/art — the DELETE /api/song/{path} catch-all would shadow it.)
    assert client.delete("/api/art/a.sloppak/override").json()["removed"]
    r = client.get("/api/song/a.sloppak/art")
    assert r.status_code == 200
    assert r.headers["content-type"] == "image/jpeg"


def test_gif_override_kept_animated_and_local_only(server, client):
    make_sloppak(server, "a.sloppak", with_cover=True)
    raw = gif_bytes()
    body = client.post("/api/song/a.sloppak/art/upload", json={"image": b64(raw)}).json()
    assert body == {"ok": True, "kind": "gif"}
    r = client.get("/api/song/a.sloppak/art")
    assert r.headers["content-type"] == "image/gif"
    assert r.content == raw                           # VERBATIM — animation intact
    # …and the pack file was never touched (GIF never reaches the feedpak).
    assert (server.DLC_DIR / "a.sloppak" / "cover.jpg").read_bytes() == png_bytes((10, 200, 10))
    assert not (server.DLC_DIR / "a.sloppak" / "cover.gif").exists()
    # A later PNG upload replaces the GIF (one override per song).
    client.post("/api/song/a.sloppak/art/upload", json={"image": b64(png_bytes())})
    assert client.get("/api/song/a.sloppak/art").headers["content-type"] == "image/png"
    assert len(server._art_override_paths("a.sloppak")) == 1


def test_bad_upload_rejected(server, client):
    make_sloppak(server, "a.sloppak")
    assert "error" in client.post("/api/song/a.sloppak/art/upload",
                                  json={"image": b64(b"GIF89a not really a gif")}).json()
    assert "error" in client.post("/api/song/a.sloppak/art/upload",
                                  json={"image": b64(b"plain text")}).json()


# ── art by URL ────────────────────────────────────────────────────────────────

def test_art_url_fetches_and_overrides(server, client, monkeypatch):
    make_sloppak(server, "a.sloppak", with_cover=True)
    monkeypatch.setattr(art, "_fetch_art_url", lambda url: png_bytes((9, 9, 9)))
    body = client.post("/api/song/a.sloppak/art/url",
                       json={"url": "https://example.com/cover.png"}).json()
    assert body == {"ok": True, "kind": "png"}
    assert client.get("/api/song/a.sloppak/art").headers["content-type"] == "image/png"


def test_art_url_validation(server, client, monkeypatch):
    make_sloppak(server, "a.sloppak")
    assert client.post("/api/song/a.sloppak/art/url",
                       json={"url": "ftp://example.com/x.png"}).status_code == 400
    assert client.post("/api/song/a.sloppak/art/url", json={}).status_code == 400
    assert client.post("/api/song/ghost.sloppak/art/url",
                       json={"url": "https://example.com/x.png"}).status_code == 404
    # Oversize → 400 (the seam raises ValueError at the cap).
    def _huge(url):
        raise ValueError("image larger than 10 MB")
    monkeypatch.setattr(art, "_fetch_art_url", _huge)
    assert client.post("/api/song/a.sloppak/art/url",
                       json={"url": "https://example.com/x.png"}).status_code == 400


def test_art_url_offline_by_default(server, client):
    """The real fetch seam refuses under the test env — pytest can never
    reach the network even when a test forgets to fake it."""
    make_sloppak(server, "a.sloppak")
    r = client.post("/api/song/a.sloppak/art/url",
                    json={"url": "https://example.com/x.png"})
    assert r.status_code == 502


# ── the enrichment art worker (Cover Art Archive) ─────────────────────────────

def _match_row(server, fn, release_id="rel-1"):
    """Seed a matched enrichment row with a release id (as the P8 matcher
    would have written) so the art worker picks it up."""
    song = server.meta_db.enrichment_song_row(fn)
    h = server.meta_db.enrichment_content_hash(
        song["artist"], song["title"], song["album"], song["duration"])
    server.meta_db.apply_enrichment_match(
        fn, h, "matched", source="text", score=1.0,
        cand={"recording_id": "rec-1", "release_id": release_id,
              "title": song["title"], "artist": song["artist"]})


@pytest.fixture()
def caa(server, monkeypatch):
    """Fake CAA transport + network flag on (mirrors the P8 test fixture)."""
    calls = []
    art = {"rel-1": png_bytes((60, 60, 200))}

    def fake(release_id):
        calls.append(release_id)
        return art.get(release_id)
    fake.calls, fake.art = calls, art
    monkeypatch.setattr(enrichment, "_caa_http_get", fake)
    monkeypatch.setattr(enrichment, "_enrich_network_enabled", lambda: True)
    return fake


def test_caa_fetch_fills_missing_art(server, client, caa):
    make_sloppak(server, "a.sloppak")                 # no pack art
    _match_row(server, "a.sloppak")
    enrichment._background_enrich()
    row = server.meta_db.get_enrichment("a.sloppak")
    assert row["art_state"] == "caa"
    assert row["art_cache_path"] and row["art_cache_path"].endswith("caa_rel-1.jpg")
    r = client.get("/api/song/a.sloppak/art")
    assert r.status_code == 200
    assert r.headers["content-type"] == "image/jpeg"
    # Settled: the next pass never re-fetches.
    n = len(caa.calls)
    enrichment._background_enrich()
    assert len(caa.calls) == n


def test_caa_skips_pack_art_and_dedupes_by_release(server, caa):
    make_sloppak(server, "haspack.sloppak", with_cover=True, title="One")
    make_sloppak(server, "b.sloppak", title="Two")
    make_sloppak(server, "c.sloppak", title="Three")
    _match_row(server, "haspack.sloppak")
    _match_row(server, "b.sloppak")                   # same release as c
    _match_row(server, "c.sloppak")
    enrichment._background_enrich()
    assert server.meta_db.get_enrichment("haspack.sloppak")["art_state"] == "pack"
    assert server.meta_db.get_enrichment("b.sloppak")["art_state"] == "caa"
    assert server.meta_db.get_enrichment("c.sloppak")["art_state"] == "caa"
    assert len(caa.calls) == 1                        # one release → ONE fetch


def test_caa_404_marks_none(server, caa):
    make_sloppak(server, "a.sloppak")
    _match_row(server, "a.sloppak", release_id="rel-missing")
    enrichment._background_enrich()
    assert server.meta_db.get_enrichment("a.sloppak")["art_state"] == "none"
    n = len(caa.calls)
    enrichment._background_enrich()
    assert len(caa.calls) == n                        # never re-hammered


def test_caa_transport_error_leaves_row_unevaluated(server, caa, monkeypatch):
    make_sloppak(server, "a.sloppak")
    _match_row(server, "a.sloppak")

    def _down(release_id):
        raise enrichment.EnrichTransportError("down")
    monkeypatch.setattr(enrichment, "_caa_http_get", _down)
    enrichment._background_enrich()
    assert server.meta_db.get_enrichment("a.sloppak")["art_state"] is None
    # Network back → next pass completes it.
    monkeypatch.setattr(enrichment, "_caa_http_get", caa)
    enrichment._background_enrich()
    assert server.meta_db.get_enrichment("a.sloppak")["art_state"] == "caa"


def test_offline_default_skips_art_worker(server, monkeypatch):
    """Under the plain test env the whole art phase is skipped with the rest
    of the network work."""
    calls = []
    monkeypatch.setattr(enrichment, "_caa_http_get", lambda rid: calls.append(rid))
    make_sloppak(server, "a.sloppak")
    _match_row(server, "a.sloppak")
    enrichment._background_enrich()
    assert calls == []
    assert server.meta_db.get_enrichment("a.sloppak")["art_state"] is None


def test_lru_prune_evicts_oldest_and_resets_rows(server, caa, monkeypatch):
    monkeypatch.setattr(enrichment, "_CAA_CACHE_CAP_BYTES", 1)   # everything over cap
    make_sloppak(server, "a.sloppak", title="One")
    make_sloppak(server, "b.sloppak", title="Two")
    caa.art["rel-2"] = png_bytes((1, 1, 1))
    _match_row(server, "a.sloppak", release_id="rel-1")
    _match_row(server, "b.sloppak", release_id="rel-2")
    enrichment._background_enrich()
    # With a 1-byte cap every fetch immediately evicts — the rows that pointed
    # at evicted files were reset to unevaluated.
    caa_files = list(server.ART_CACHE_DIR.glob("caa_*.jpg"))
    assert len(caa_files) <= 1
    states = {fn: server.meta_db.get_enrichment(fn)["art_state"]
              for fn in ("a.sloppak", "b.sloppak")}
    assert None in states.values() or list(states.values()).count("caa") <= 1


def test_delete_song_removes_override(server, client):
    make_sloppak(server, "a.sloppak")
    client.post("/api/song/a.sloppak/art/upload", json={"image": b64(png_bytes())})
    assert server._art_override_paths("a.sloppak")
    r = client.delete("/api/song/a.sloppak")
    assert r.status_code == 200
    assert server._art_override_paths("a.sloppak") == []


def test_delete_override_restores_caa_fallback(server, client, caa):
    """Removing a user override that had settled the row as 'user' must reset
    the enrichment state so the CAA fallback is fetched and served again —
    otherwise the song is stranded with no art at all."""
    make_sloppak(server, "a.sloppak")                 # no pack art
    _match_row(server, "a.sloppak")
    # Pin an override BEFORE the art worker runs → the pass stamps art_state='user'.
    client.post("/api/song/a.sloppak/art/upload", json={"image": b64(png_bytes())})
    enrichment._background_enrich()
    assert server.meta_db.get_enrichment("a.sloppak")["art_state"] == "user"
    # Remove it → the row resets to unevaluated…
    assert client.delete("/api/art/a.sloppak/override").json()["removed"]
    assert server.meta_db.get_enrichment("a.sloppak")["art_state"] is None
    # …and the next pass fetches + serves the release's front cover.
    enrichment._background_enrich()
    assert server.meta_db.get_enrichment("a.sloppak")["art_state"] == "caa"
    r = client.get("/api/song/a.sloppak/art")
    assert r.status_code == 200
    assert r.headers["content-type"] == "image/jpeg"


def test_upload_rejects_unknown_song_and_oversize(server, client):
    # Unknown filename → 404 (no stray override file written).
    assert client.post("/api/song/ghost.sloppak/art/upload",
                       json={"image": b64(png_bytes())}).status_code == 404
    assert server._art_override_paths("ghost.sloppak") == []
    # Oversize decoded payload → 400 (bounds the base64 upload path).
    make_sloppak(server, "a.sloppak")
    huge = b64(b"\x00" * (art._ART_URL_MAX_BYTES + 1))
    assert client.post("/api/song/a.sloppak/art/upload",
                       json={"image": huge}).status_code == 400


def test_fetch_art_url_blocks_internal_hosts(server):
    """The SSRF guard refuses loopback / link-local / private targets before
    any request is made (the real seam, not the faked one)."""
    assert art._url_host_is_internal("http://127.0.0.1/x.png")
    assert art._url_host_is_internal("http://localhost/x.png")
    assert art._url_host_is_internal("http://169.254.169.254/latest/meta-data")
    assert art._url_host_is_internal("http://10.0.0.5/x.png")
    assert art._url_host_is_internal("http://[::1]/x.png")
    assert art._url_host_is_internal("http://nonexistent.invalid/x.png")  # unresolvable → closed
    assert not art._url_host_is_internal("http://93.184.216.34/x.png")    # public literal
