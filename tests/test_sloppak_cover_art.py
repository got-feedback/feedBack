"""Album-art fast path + conditional-caching contract.

Covers the library cover-loading perf fix: `sloppak.read_cover_bytes` reads the
cover WITHOUT unpacking the whole archive, and `GET /api/song/{f}/art` serves it
with a content validator so re-scroll gets bodyless 304s — never a stale cover.

Pins, so a future refactor can't silently reintroduce:
  - the full-unpack-per-cover regression (covers served straight from the zip),
  - the non-canonical manifest cover name (`./cover.jpg`) 404,
  - zip-slip / degenerate cover names,
  - dir-form sloppaks emitting a stale 304 after an in-place cover edit.
"""

import importlib
import sys
import zipfile

import pytest
import yaml
from fastapi.testclient import TestClient

import sloppak as sloppak_mod


# ── Unit: read_cover_bytes ────────────────────────────────────────────────────

def _zip_sloppak(path, cover_name="cover.jpg", manifest_cover="cover.jpg",
                 cover_bytes=b"\xff\xd8\xff\xe0JPG", with_stem=True):
    with zipfile.ZipFile(path, "w") as zf:
        zf.writestr("manifest.yaml", yaml.safe_dump({"cover": manifest_cover}))
        zf.writestr(cover_name, cover_bytes)
        if with_stem:
            # A big-ish stem so a regression that unpacks the whole archive
            # would be doing real work, not just touching the cover.
            zf.writestr("stems/full.ogg", b"OggS" + b"\x00" * 4096)


def _dir_sloppak(path, cover_bytes=b"\xff\xd8\xff\xe0JPG"):
    path.mkdir(parents=True)
    (path / "manifest.yaml").write_text(yaml.safe_dump({"cover": "cover.jpg"}))
    (path / "cover.jpg").write_bytes(cover_bytes)
    return path


def test_read_cover_from_zip(tmp_path):
    z = tmp_path / "a.sloppak"
    _zip_sloppak(z, cover_bytes=b"\xff\xd8\xff\xe0HELLO")
    res = sloppak_mod.read_cover_bytes(z)
    assert res is not None
    data, mt = res
    assert data == b"\xff\xd8\xff\xe0HELLO"
    assert mt == "image/jpeg"


def test_read_cover_from_dir(tmp_path):
    d = _dir_sloppak(tmp_path / "b.sloppak", cover_bytes=b"\xff\xd8\xff\xe0DIR")
    res = sloppak_mod.read_cover_bytes(d)
    assert res is not None and res[0] == b"\xff\xd8\xff\xe0DIR" and res[1] == "image/jpeg"


@pytest.mark.parametrize("manifest_cover", ["./cover.jpg", "art/../cover.jpg"])
def test_noncanonical_manifest_cover_resolves(tmp_path, manifest_cover):
    """A valid-but-non-canonical name must resolve to the real member, matching
    the old unpack-then-resolve-on-filesystem behavior."""
    z = tmp_path / "c.sloppak"
    _zip_sloppak(z, manifest_cover=manifest_cover, cover_bytes=b"\xff\xd8\xff\xe0X")
    res = sloppak_mod.read_cover_bytes(z)
    assert res is not None and res[0] == b"\xff\xd8\xff\xe0X"


@pytest.mark.parametrize("bad", ["../../escape.png", ".", "subdir/..", "/abs.png", ""])
def test_unsafe_or_degenerate_cover_name_rejected(tmp_path, bad):
    z = tmp_path / "d.sloppak"
    # Put a real cover.jpg in the archive; the manifest points at the bad name.
    _zip_sloppak(z, manifest_cover=bad if bad else "cover.jpg")
    if bad == "":
        # Empty falls back to the default cover.jpg (intended contract).
        assert sloppak_mod.read_cover_bytes(z) is not None
    else:
        assert sloppak_mod.read_cover_bytes(z) is None


def test_webp_media_type(tmp_path):
    z = tmp_path / "e.sloppak"
    _zip_sloppak(z, cover_name="cover.webp", manifest_cover="cover.webp",
                 cover_bytes=b"RIFF....WEBP")
    res = sloppak_mod.read_cover_bytes(z)
    assert res is not None and res[1] == "image/webp"


# ── Endpoint: conditional caching ─────────────────────────────────────────────

@pytest.fixture()
def dlc_client(tmp_path, monkeypatch):
    """TestClient with a temp DLC_DIR; sync startup, no scan, no plugins."""
    dlc = tmp_path / "dlc"
    dlc.mkdir()
    config = tmp_path / "cfg"
    config.mkdir()
    monkeypatch.setenv("DLC_DIR", str(dlc))
    monkeypatch.setenv("CONFIG_DIR", str(config))
    monkeypatch.setenv("FEEDBACK_SYNC_STARTUP", "1")
    sys.modules.pop("server", None)
    server = importlib.import_module("server")
    server.sloppak_mod._source_cache.clear()
    monkeypatch.setattr(server, "load_plugins", lambda *a, **kw: None)
    monkeypatch.setattr(server, "startup_scan", lambda: None)
    static_tmp = tmp_path / "static"
    static_tmp.mkdir()
    monkeypatch.setattr(server, "STATIC_DIR", static_tmp)
    tc = TestClient(server.app, client=("127.0.0.1", 50000))
    try:
        yield tc, server, dlc
    finally:
        tc.close()
        meta_db = getattr(server, "meta_db", None)
        conn = getattr(meta_db, "conn", None)
        if conn is not None:
            conn.close()


def test_zip_art_endpoint_conditional_304(dlc_client):
    tc, _server, dlc = dlc_client
    _zip_sloppak(dlc / "song.sloppak", cover_bytes=b"\xff\xd8\xff\xe0ZIP")
    r1 = tc.get("/api/song/song.sloppak/art")
    assert r1.status_code == 200
    assert r1.content == b"\xff\xd8\xff\xe0ZIP"
    assert r1.headers["cache-control"] == "no-cache"
    etag = r1.headers["etag"]
    assert etag
    r2 = tc.get("/api/song/song.sloppak/art", headers={"If-None-Match": etag})
    assert r2.status_code == 304
    assert r2.content == b""


def test_dir_art_endpoint_no_stale_304_after_inplace_edit(dlc_client):
    """Editing cover.jpg in place must invalidate the validator (the dir-form
    staleness bug: a dir-stat ETag would wrongly 304 here)."""
    tc, _server, dlc = dlc_client
    pak = _dir_sloppak(dlc / "dir.sloppak", cover_bytes=b"\xff\xd8\xff\xe0OLD")
    r1 = tc.get("/api/song/dir.sloppak/art")
    assert r1.status_code == 200 and r1.content == b"\xff\xd8\xff\xe0OLD"
    etag_old = r1.headers["etag"]
    # Replace the cover content in place (same path).
    (pak / "cover.jpg").write_bytes(b"\xff\xd8\xff\xe0NEW")
    r2 = tc.get("/api/song/dir.sloppak/art", headers={"If-None-Match": etag_old})
    assert r2.status_code == 200
    assert r2.content == b"\xff\xd8\xff\xe0NEW"
