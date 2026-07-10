"""Playlist cover upload: client vs server errors, no temp litter, no leak.

The pre-split handler caught decode AND persistence failures in one `except`,
returned 400 for both, and echoed the exception (`Invalid image: {e}`) — so a
disk/permission failure was mislabeled as a client error and could leak a
filesystem path. These pin the split.
"""

import base64
import io

import pytest
from fastapi.testclient import TestClient
from PIL import Image

import appstate
from metadata_db import MetadataDB
from routers import playlists


@pytest.fixture()
def client(tmp_path):
    prev = (appstate.meta_db, appstate.config_dir)
    db = MetadataDB(tmp_path)
    appstate.configure(meta_db=db, config_dir=tmp_path)
    app_ = __import__("fastapi").FastAPI()
    app_.include_router(playlists.router)
    try:
        yield TestClient(app_), tmp_path
    finally:
        db.conn.close()
        appstate.configure(meta_db=prev[0], config_dir=prev[1])


def _png_b64():
    buf = io.BytesIO()
    Image.new("RGB", (8, 8), (10, 20, 30)).save(buf, "PNG")
    return base64.b64encode(buf.getvalue()).decode()


def _make_playlist(client):
    return client.post("/api/playlists", json={"name": "P"}).json()["id"]


def test_valid_cover_saves_and_leaves_no_temp(client):
    c, tmp_path = client
    pid = _make_playlist(c)
    r = c.post(f"/api/playlists/{pid}/cover", json={"image": _png_b64()})
    assert r.status_code == 200
    cover_dir = tmp_path / "playlist_covers"
    assert (cover_dir / f"{pid}.png").exists()
    # The atomic-publish temp file must not linger.
    assert not list(cover_dir.glob("*.tmp"))


def test_undecodable_image_is_a_400_without_leaking(client):
    c, _ = client
    pid = _make_playlist(c)
    # valid base64, not a valid image
    r = c.post(f"/api/playlists/{pid}/cover", json={"image": base64.b64encode(b"not an image").decode()})
    assert r.status_code == 400
    body = r.json()["error"]
    assert body == "Invalid image"          # generic — no exception detail echoed
    assert "playlist_covers" not in body    # no filesystem path leak


def test_save_failure_is_a_500_not_a_400(client, monkeypatch):
    """A persistence failure (here: Image.save raising) must be a logged 500,
    not a 400 — the whole point of the decode/persist split. Negative-checks
    against the pre-fix behavior, which returned 400 for exactly this."""
    c, tmp_path = client
    pid = _make_playlist(c)
    payload = _png_b64()                     # build BEFORE patching save

    def boom(self, fp, *a, **k):
        raise OSError("disk full")

    monkeypatch.setattr(Image.Image, "save", boom)
    r = c.post(f"/api/playlists/{pid}/cover", json={"image": payload})

    assert r.status_code == 500
    assert "disk full" not in r.json()["error"]           # no internal detail
    assert not list((tmp_path / "playlist_covers").glob("*.tmp"))  # temp cleaned up


def test_temp_creation_failure_is_a_500(client, monkeypatch):
    """mkstemp raising (unwritable dir / full disk) must hit the same logged 500
    path as a save failure, not escape as an unhandled server error."""
    import tempfile as _tempfile

    c, _ = client
    pid = _make_playlist(c)
    payload = _png_b64()

    def boom(*a, **k):
        raise OSError("read-only file system")

    monkeypatch.setattr(_tempfile, "mkstemp", boom)
    r = c.post(f"/api/playlists/{pid}/cover", json={"image": payload})
    assert r.status_code == 500
    assert "read-only" not in r.json()["error"]


def test_upload_to_missing_playlist_is_404(client):
    c, _ = client
    r = c.post("/api/playlists/9999/cover", json={"image": _png_b64()})
    assert r.status_code == 404
