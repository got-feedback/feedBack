"""Tests for the R4a gap-fill write-back — the §7 contract made executable:
user-initiated, adds ABSENT keys only (author bytes preserved verbatim),
spec'd-keys allowlist, values only from a CONFIRMED match, atomic + .bak.

No network anywhere: matches are seeded straight into the enrichment cache
(as the P8 matcher would have written them).
"""

import importlib
import sys
import zipfile

import pytest
import yaml
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


BASE_MANIFEST = ("# my hand-made pack\n"
                 "title: Thunderstruck\n"
                 "artist: AC/DC   # the real one\n"
                 "duration: 292\n"
                 "arrangements: []\n"
                 "stems: []\n")


def make_dir_sloppak(server, name, manifest=BASE_MANIFEST):
    d = server.DLC_DIR / name
    d.mkdir(parents=True)
    (d / "manifest.yaml").write_text(manifest, encoding="utf-8")
    _put_db(server, name)
    return d


def make_zip_sloppak(server, name, manifest=BASE_MANIFEST):
    p = server.DLC_DIR / name
    with zipfile.ZipFile(p, "w", zipfile.ZIP_DEFLATED) as z:
        z.writestr("manifest.yaml", manifest)
        z.writestr("stems/full.ogg", b"OggS-fake")
    _put_db(server, name)
    return p


def _put_db(server, name):
    server.meta_db.put(name, 0, 0, {
        "title": "Thunderstruck", "artist": "AC/DC", "album": "", "year": "",
        "duration": 292, "arrangements": [{"name": "Lead", "index": 0}],
    })


def seed_match(server, fn, state="matched", **overrides):
    """Seed a confirmed enrichment row as the P8 matcher would have."""
    cand = {"recording_id": "12345678-abcd-4ef0-9876-0123456789ab",
            "release_id": "rel-1", "artist_id": "art-1",
            "artist": "AC/DC", "title": "Thunderstruck",
            "album": "The Razors Edge", "year": "1990",
            "genres": ["hard rock", "rock"], "isrc": "AUAP09000045"}
    cand.update(overrides)
    song = server.meta_db.enrichment_song_row(fn)
    h = server.meta_db.enrichment_content_hash(
        song["artist"], song["title"], song["album"], song["duration"])
    server.meta_db.apply_enrichment_match(
        fn, h, state, source="text", score=1.0, cand=cand,
        candidates=([cand] if state == "review" else None))


# ── preview ───────────────────────────────────────────────────────────────────

def test_preview_offers_only_absent_confirmed_keys(server, client):
    make_dir_sloppak(server, "a.sloppak")
    seed_match(server, "a.sloppak")
    d = client.get("/api/song/a.sloppak/gap-fill").json()
    assert d["eligible"] is True
    got = {m["key"]: m["value"] for m in d["missing"]}
    assert got == {"album": "The Razors Edge", "year": 1990,
                   "genres": ["hard rock", "rock"],
                   "mbid": "12345678-abcd-4ef0-9876-0123456789ab",
                   "isrc": "AUAP09000045"}


def test_preview_excludes_author_set_keys(server, client):
    make_dir_sloppak(server, "a.sloppak",
                     BASE_MANIFEST + "album: Live Bootleg\nyear: 1991\n")
    seed_match(server, "a.sloppak")
    got = {m["key"] for m in client.get("/api/song/a.sloppak/gap-fill").json()["missing"]}
    assert "album" not in got and "year" not in got
    assert {"genres", "mbid", "isrc"} <= got


def test_preview_treats_empty_values_as_gaps(server, client):
    make_dir_sloppak(server, "a.sloppak", BASE_MANIFEST + "album: ''\nyear: 0\n")
    seed_match(server, "a.sloppak")
    got = {m["key"] for m in client.get("/api/song/a.sloppak/gap-fill").json()["missing"]}
    assert {"album", "year"} <= got


def test_preview_requires_confirmed_match(server, client):
    make_dir_sloppak(server, "a.sloppak")
    d = client.get("/api/song/a.sloppak/gap-fill").json()
    assert d["eligible"] is False and d["reason"] == "no-match"
    seed_match(server, "a.sloppak", state="review")
    d = client.get("/api/song/a.sloppak/gap-fill").json()
    assert d["eligible"] is False and d["reason"] == "review"
    # A user-pinned match is confirmed.
    seed_match(server, "a.sloppak", state="manual")
    assert client.get("/api/song/a.sloppak/gap-fill").json()["eligible"] is True


# ── writing ───────────────────────────────────────────────────────────────────

def test_write_dir_form_appends_and_preserves_author_bytes(server, client):
    d = make_dir_sloppak(server, "a.sloppak")
    seed_match(server, "a.sloppak")
    r = client.post("/api/song/a.sloppak/gap-fill",
                    json={"keys": ["album", "year", "genres", "mbid", "isrc"]})
    assert r.status_code == 200
    body = r.json()
    assert set(body["written"]) == {"album", "year", "genres", "mbid", "isrc"}
    text = (d / "manifest.yaml").read_text(encoding="utf-8")
    # The author's original bytes — comments included — survive verbatim as a
    # prefix; the additions are appended after them.
    assert text.startswith(BASE_MANIFEST)
    manifest = yaml.safe_load(text)
    assert manifest["album"] == "The Razors Edge"
    assert manifest["year"] == 1990
    assert manifest["genres"] == ["hard rock", "rock"]
    assert manifest["mbid"] == "12345678-abcd-4ef0-9876-0123456789ab"
    assert manifest["isrc"] == "AUAP09000045"
    # Backup + DB sync (the row must match what the scanner would derive).
    assert (d / "manifest.yaml.bak").read_text(encoding="utf-8") == BASE_MANIFEST
    row = client.get("/api/song/a.sloppak").json()
    assert row["album"] == "The Razors Edge"
    assert str(row["year"]) == "1990"


def test_write_zip_form_appends_with_backup(server, client):
    p = make_zip_sloppak(server, "a.sloppak")
    seed_match(server, "a.sloppak")
    r = client.post("/api/song/a.sloppak/gap-fill", json={"keys": ["album", "mbid"]})
    assert r.status_code == 200
    with zipfile.ZipFile(p) as z:
        text = z.read("manifest.yaml").decode("utf-8")
        assert text.startswith(BASE_MANIFEST)
        manifest = yaml.safe_load(text)
        assert manifest["album"] == "The Razors Edge"
        assert manifest["mbid"] == "12345678-abcd-4ef0-9876-0123456789ab"
        assert "year" not in manifest            # unrequested keys untouched
        assert z.read("stems/full.ogg") == b"OggS-fake"
    bak = p.with_name(p.name + ".bak")
    assert bak.exists()
    with zipfile.ZipFile(bak) as z:
        assert z.read("manifest.yaml").decode("utf-8") == BASE_MANIFEST


def test_write_never_replaces_author_values(server, client):
    d = make_dir_sloppak(server, "a.sloppak", BASE_MANIFEST + "album: Live Bootleg\n")
    seed_match(server, "a.sloppak")
    # Requesting a present key: skipped, not replaced; nothing else requested
    # → 409 and the file is untouched.
    r = client.post("/api/song/a.sloppak/gap-fill", json={"keys": ["album"]})
    assert r.status_code == 409
    assert r.json()["skipped"] == ["album"]
    assert (d / "manifest.yaml").read_text(encoding="utf-8").endswith("album: Live Bootleg\n")
    # Mixed request: the gap is written, the author value survives.
    r = client.post("/api/song/a.sloppak/gap-fill", json={"keys": ["album", "year"]})
    assert r.status_code == 200
    assert r.json() == {"ok": True, "written": {"year": 1990}, "skipped": ["album"]}
    manifest = yaml.safe_load((d / "manifest.yaml").read_text(encoding="utf-8"))
    assert manifest["album"] == "Live Bootleg"
    assert manifest["year"] == 1990


def test_writer_last_line_guard(server):
    """The lib-level never-clobber guard holds even if a caller skips the
    proposal check."""
    import songmeta
    d = make_dir_sloppak(server, "a.sloppak", BASE_MANIFEST + "album: Kept\n")
    with pytest.raises(ValueError):
        songmeta.gap_fill_sloppak(d, {"album": "Clobber"})
    assert "Kept" in (d / "manifest.yaml").read_text(encoding="utf-8")


def test_write_validates_keys(server, client):
    make_dir_sloppak(server, "a.sloppak")
    seed_match(server, "a.sloppak")
    assert client.post("/api/song/a.sloppak/gap-fill",
                       json={"keys": ["title"]}).status_code == 400
    assert client.post("/api/song/a.sloppak/gap-fill",
                       json={"keys": []}).status_code == 400
    assert client.post("/api/song/a.sloppak/gap-fill", json={}).status_code == 400


def test_demo_mode_blocks_write(tmp_path, monkeypatch, isolate_logging):
    """The middleware turns the write route away before any handler runs —
    demo visitors can never rewrite pack files."""
    monkeypatch.setenv("CONFIG_DIR", str(tmp_path / "config"))
    dlc = tmp_path / "dlc"
    dlc.mkdir()
    monkeypatch.setenv("DLC_DIR", str(dlc))
    monkeypatch.setenv("FEEDBACK_SKIP_STARTUP_TASKS", "1")
    monkeypatch.setenv("FEEDBACK_DEMO_MODE", "1")
    sys.modules.pop("server", None)
    srv = importlib.import_module("server")
    try:
        r = TestClient(srv.app).post("/api/song/a.sloppak/gap-fill",
                                     json={"keys": ["album"]})
        assert r.status_code == 403
    finally:
        conn = getattr(getattr(srv, "meta_db", None), "conn", None)
        if conn is not None:
            conn.close()
        sys.modules.pop("server", None)
