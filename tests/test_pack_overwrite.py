"""Tests for the R4b pack-field overwrite — the §7-AMENDMENT shape made
executable: per-field confirmation with values only from a match the user
EXPLICITLY confirmed (`manual` — an automatic match may gap-fill but never
replace), a default-OFF Settings gate (allow_pack_overwrite), identity keys
(mbid/isrc) never overwritable, receipts in write_log (old/new/source/score,
pruned at 5000 rows), and .bak = the pristine author original with a working
Revert that preserves the backup.

Reuses the gap-fill fixtures/helpers (tests/test_gap_fill.py); no network
anywhere — matches are seeded straight into the enrichment cache.
"""

import importlib
import sys
import zipfile

import yaml
from fastapi.testclient import TestClient

from tests.test_gap_fill import (  # noqa: F401  (server/client fixtures)
    BASE_MANIFEST,
    client,
    make_dir_sloppak,
    make_zip_sloppak,
    seed_match,
    server,
)

# Author-set values that all DIFFER from the seeded match (artist/album/year/
# genres), plus a title equal to the match (equal values are never offered).
DIFF_MANIFEST = ("# my hand-made pack\n"
                 "title: Thunderstruck\n"
                 "artist: ACDC   # typo the match fixes\n"
                 "album: Razors Edge\n"
                 "year: 1991\n"
                 "genres:\n"
                 "- Rock\n"
                 "duration: 292\n"
                 "arrangements: []\n"
                 "stems: []\n")


def enable_overwrite(client):
    r = client.post("/api/settings", json={"allow_pack_overwrite": True})
    assert r.status_code == 200


# ── differs (preview) ─────────────────────────────────────────────────────────

def test_differs_only_for_manual_rows(server, client):
    """The librarian rule: an automatic match may gap-fill absent keys but is
    not authority to replace author bytes — differs is empty until the user
    pins the match."""
    make_dir_sloppak(server, "a.sloppak", DIFF_MANIFEST)
    seed_match(server, "a.sloppak", state="matched")
    d = client.get("/api/song/a.sloppak/gap-fill").json()
    assert d["differs"] == []
    # The same row, user-pinned → the differences surface.
    seed_match(server, "a.sloppak", state="manual")
    d = client.get("/api/song/a.sloppak/gap-fill").json()
    got = {x["key"]: x for x in d["differs"]}
    assert set(got) == {"artist", "album", "year", "genres"}
    assert got["artist"]["current"] == "ACDC" and got["artist"]["proposed"] == "AC/DC"
    assert got["album"]["current"] == "Razors Edge"
    assert got["album"]["proposed"] == "The Razors Edge"
    assert got["year"]["current"] == "1991" and got["year"]["proposed"] == 1990
    assert got["genres"]["current"] == ["Rock"]
    assert got["genres"]["proposed"] == ["hard rock", "rock"]


def test_differs_excludes_identity_keys_and_equal_values(server, client):
    """mbid/isrc present in the file AND different from the match are still
    never offered (identity changes only via explicit re-match); a value equal
    to the match isn't a difference; an ABSENT key is a gap (missing), not a
    differ."""
    make_dir_sloppak(server, "a.sloppak", BASE_MANIFEST +
                     "mbid: 00000000-0000-4000-8000-000000000000\n"
                     "isrc: USZZZ0000001\n")
    seed_match(server, "a.sloppak", state="manual")
    d = client.get("/api/song/a.sloppak/gap-fill").json()
    assert d["differs"] == []           # title/artist equal; mbid/isrc barred
    assert {m["key"] for m in d["missing"]} == {"album", "year", "genres"}


def test_preview_reports_gate_state_and_backup(server, client):
    make_dir_sloppak(server, "a.sloppak", DIFF_MANIFEST)
    seed_match(server, "a.sloppak", state="manual")
    d = client.get("/api/song/a.sloppak/gap-fill").json()
    assert d["overwrite_allowed"] is False      # default OFF
    assert d["has_backup"] is False             # nothing written yet
    enable_overwrite(client)
    assert client.get("/api/song/a.sloppak/gap-fill").json()["overwrite_allowed"] is True


# ── refusals ──────────────────────────────────────────────────────────────────

def test_overwrite_refused_when_setting_off(server, client):
    """The gate refuses the WHOLE request before anything is written."""
    d = make_dir_sloppak(server, "a.sloppak", DIFF_MANIFEST)
    seed_match(server, "a.sloppak", state="manual")
    before = (d / "manifest.yaml").read_text(encoding="utf-8")
    r = client.post("/api/song/a.sloppak/gap-fill", json={"overwrite_keys": ["artist"]})
    assert r.status_code == 409
    assert (d / "manifest.yaml").read_text(encoding="utf-8") == before
    assert not (d / "manifest.yaml.bak").exists()


def test_overwrite_refused_when_not_manual(server, client):
    d = make_dir_sloppak(server, "a.sloppak", DIFF_MANIFEST)
    seed_match(server, "a.sloppak", state="matched")
    enable_overwrite(client)
    before = (d / "manifest.yaml").read_text(encoding="utf-8")
    r = client.post("/api/song/a.sloppak/gap-fill", json={"overwrite_keys": ["artist"]})
    assert r.status_code == 409
    assert r.json()["skipped"] == ["artist"]
    assert (d / "manifest.yaml").read_text(encoding="utf-8") == before


def test_overwrite_validates_keys(server, client):
    make_dir_sloppak(server, "a.sloppak", DIFF_MANIFEST)
    seed_match(server, "a.sloppak", state="manual")
    enable_overwrite(client)
    # Identity keys and unknown keys are turned away wholesale (400).
    for bad in (["mbid"], ["isrc"], ["nope"]):
        r = client.post("/api/song/a.sloppak/gap-fill", json={"overwrite_keys": bad})
        assert r.status_code == 400
    # Both lists empty is still a 400.
    assert client.post("/api/song/a.sloppak/gap-fill",
                       json={"keys": [], "overwrite_keys": []}).status_code == 400


def test_overwrite_equal_value_is_skipped(server, client):
    """A requested key whose value already equals the match is not in differs
    → skipped, and with nothing else to write the request 409s untouched."""
    d = make_dir_sloppak(server, "a.sloppak", DIFF_MANIFEST)
    seed_match(server, "a.sloppak", state="manual")
    enable_overwrite(client)
    r = client.post("/api/song/a.sloppak/gap-fill", json={"overwrite_keys": ["title"]})
    assert r.status_code == 409
    assert r.json()["skipped"] == ["title"]
    assert (d / "manifest.yaml").read_text(encoding="utf-8") == DIFF_MANIFEST


# ── happy path ────────────────────────────────────────────────────────────────

def test_overwrite_dir_form_replaces_and_keeps_pristine_bak(server, client):
    d = make_dir_sloppak(server, "a.sloppak", DIFF_MANIFEST)
    seed_match(server, "a.sloppak", state="manual")
    enable_overwrite(client)
    r = client.post("/api/song/a.sloppak/gap-fill",
                    json={"overwrite_keys": ["artist", "genres"]})
    assert r.status_code == 200
    body = r.json()
    assert body["overwritten"] == {
        "artist": {"old": "ACDC", "new": "AC/DC"},
        "genres": {"old": ["Rock"], "new": ["hard rock", "rock"]},
    }
    assert body["written"] == {}
    manifest = yaml.safe_load((d / "manifest.yaml").read_text(encoding="utf-8"))
    assert manifest["artist"] == "AC/DC"
    assert manifest["genres"] == ["hard rock", "rock"]
    assert manifest["album"] == "Razors Edge"       # unrequested keys untouched
    assert manifest["year"] == 1991
    # The backup is the author's pristine original…
    assert (d / "manifest.yaml.bak").read_text(encoding="utf-8") == DIFF_MANIFEST
    # …and a SECOND write never clobbers it.
    r = client.post("/api/song/a.sloppak/gap-fill", json={"overwrite_keys": ["album"]})
    assert r.status_code == 200
    assert (d / "manifest.yaml.bak").read_text(encoding="utf-8") == DIFF_MANIFEST
    manifest = yaml.safe_load((d / "manifest.yaml").read_text(encoding="utf-8"))
    assert manifest["album"] == "The Razors Edge"
    assert manifest["artist"] == "AC/DC"            # the first write survives
    # DB sync: the songs row reflects the replaced values.
    row = client.get("/api/song/a.sloppak").json()
    assert row["artist"] == "AC/DC"
    assert row["album"] == "The Razors Edge"


def test_gap_fill_and_overwrite_in_one_request(server, client):
    """`keys` keeps working unchanged alongside `overwrite_keys`: absent keys
    append (author bytes preserved into the one pristine backup), the differing
    key is replaced."""
    d = make_dir_sloppak(server, "a.sloppak", BASE_MANIFEST + "year: 1991\n")
    seed_match(server, "a.sloppak", state="manual")
    enable_overwrite(client)
    r = client.post("/api/song/a.sloppak/gap-fill",
                    json={"keys": ["album", "mbid"], "overwrite_keys": ["year"]})
    assert r.status_code == 200
    body = r.json()
    assert body["written"] == {"album": "The Razors Edge",
                               "mbid": "12345678-abcd-4ef0-9876-0123456789ab"}
    assert body["overwritten"] == {"year": {"old": "1991", "new": 1990}}
    manifest = yaml.safe_load((d / "manifest.yaml").read_text(encoding="utf-8"))
    assert manifest["album"] == "The Razors Edge"
    assert manifest["mbid"] == "12345678-abcd-4ef0-9876-0123456789ab"
    assert manifest["year"] == 1990
    # One request, one pristine backup: the pre-request original bytes.
    assert ((d / "manifest.yaml.bak").read_text(encoding="utf-8")
            == BASE_MANIFEST + "year: 1991\n")


def test_zip_form_overwrite(server, client):
    p = make_zip_sloppak(server, "a.sloppak", DIFF_MANIFEST)
    seed_match(server, "a.sloppak", state="manual")
    enable_overwrite(client)
    r = client.post("/api/song/a.sloppak/gap-fill", json={"overwrite_keys": ["artist"]})
    assert r.status_code == 200
    with zipfile.ZipFile(p) as z:
        manifest = yaml.safe_load(z.read("manifest.yaml"))
        assert manifest["artist"] == "AC/DC"
        assert z.read("stems/full.ogg") == b"OggS-fake"     # pack intact
    bak = p.with_name(p.name + ".bak")
    with zipfile.ZipFile(bak) as z:
        assert z.read("manifest.yaml").decode("utf-8") == DIFF_MANIFEST


# ── write_log (provenance receipts) ───────────────────────────────────────────

def test_write_log_records_old_and_new(server, client):
    make_dir_sloppak(server, "a.sloppak", DIFF_MANIFEST)
    seed_match(server, "a.sloppak", state="manual")
    enable_overwrite(client)
    r = client.post("/api/song/a.sloppak/gap-fill",
                    json={"overwrite_keys": ["artist", "year"]})
    assert r.status_code == 200
    rows = client.get("/api/song/a.sloppak/write-log").json()["rows"]
    by_key = {x["key"]: x for x in rows}
    assert by_key["artist"]["old_value"] == "ACDC"
    assert by_key["artist"]["new_value"] == "AC/DC"
    assert by_key["year"]["old_value"] == "1991"
    assert by_key["year"]["new_value"] == "1990"
    for x in rows:
        assert x["source"] == "text" and x["score"] == 1.0 and x["ts"]


def test_write_log_records_gap_fills_too(server, client):
    make_dir_sloppak(server, "a.sloppak")
    seed_match(server, "a.sloppak")
    r = client.post("/api/song/a.sloppak/gap-fill", json={"keys": ["album", "genres"]})
    assert r.status_code == 200
    rows = client.get("/api/song/a.sloppak/write-log").json()["rows"]
    by_key = {x["key"]: x for x in rows}
    assert by_key["album"]["old_value"] is None         # was a gap — no old value
    assert by_key["album"]["new_value"] == "The Razors Edge"
    assert by_key["genres"]["new_value"] == '["hard rock", "rock"]'


def test_write_log_endpoint_shape_and_order(server, client):
    make_dir_sloppak(server, "a.sloppak", DIFF_MANIFEST)
    seed_match(server, "a.sloppak", state="manual")
    enable_overwrite(client)
    assert client.post("/api/song/a.sloppak/gap-fill",
                       json={"overwrite_keys": ["artist"]}).status_code == 200
    assert client.post("/api/song/a.sloppak/gap-fill",
                       json={"overwrite_keys": ["album"]}).status_code == 200
    rows = client.get("/api/song/a.sloppak/write-log").json()["rows"]
    assert [x["key"] for x in rows] == ["album", "artist"]      # newest first
    assert set(rows[0]) == {"id", "key", "old_value", "new_value",
                            "source", "score", "ts"}
    # Another song's rows don't bleed in.
    make_dir_sloppak(server, "b.sloppak")
    assert client.get("/api/song/b.sloppak/write-log").json()["rows"] == []


def test_write_log_prunes_beyond_cap(server):
    """The receipts table stays bounded at 5000 rows — oldest pruned first."""
    db = server.meta_db
    db.add_write_log("bulk.sloppak",
                     [("album", None, str(i)) for i in range(5100)],
                     source="text", score=1.0)
    n = db.conn.execute("SELECT COUNT(*) FROM write_log").fetchone()[0]
    assert n == 5000
    oldest = db.conn.execute(
        "SELECT new_value FROM write_log ORDER BY id ASC LIMIT 1").fetchone()[0]
    assert oldest == "100"      # rows 0..99 fell off the bottom


# ── revert ────────────────────────────────────────────────────────────────────

def test_revert_dir_form_restores_original_and_resyncs_db(server, client):
    d = make_dir_sloppak(server, "a.sloppak", DIFF_MANIFEST)
    seed_match(server, "a.sloppak", state="manual")
    enable_overwrite(client)
    assert client.post("/api/song/a.sloppak/gap-fill",
                       json={"overwrite_keys": ["artist"]}).status_code == 200
    assert client.get("/api/song/a.sloppak").json()["artist"] == "AC/DC"
    r = client.post("/api/song/a.sloppak/revert-original")
    assert r.status_code == 200
    # Author bytes restored verbatim; the backup is PRESERVED (re-apply later).
    assert (d / "manifest.yaml").read_text(encoding="utf-8") == DIFF_MANIFEST
    assert (d / "manifest.yaml.bak").exists()
    row = client.get("/api/song/a.sloppak").json()
    assert row["artist"] == "ACDC"
    assert str(row["year"]) == "1991"
    # And the preview still offers the revert + the differences again.
    d2 = client.get("/api/song/a.sloppak/gap-fill").json()
    assert d2["has_backup"] is True
    assert {x["key"] for x in d2["differs"]} >= {"artist"}


def test_revert_zip_form(server, client):
    p = make_zip_sloppak(server, "a.sloppak", DIFF_MANIFEST)
    seed_match(server, "a.sloppak", state="manual")
    enable_overwrite(client)
    assert client.post("/api/song/a.sloppak/gap-fill",
                       json={"overwrite_keys": ["artist"]}).status_code == 200
    assert client.post("/api/song/a.sloppak/revert-original").status_code == 200
    with zipfile.ZipFile(p) as z:
        assert z.read("manifest.yaml").decode("utf-8") == DIFF_MANIFEST
        assert z.read("stems/full.ogg") == b"OggS-fake"     # pack intact
    assert p.with_name(p.name + ".bak").exists()            # backup preserved
    assert client.get("/api/song/a.sloppak").json()["artist"] == "ACDC"


def test_revert_without_backup_is_404(server, client):
    make_dir_sloppak(server, "a.sloppak")
    assert client.post("/api/song/a.sloppak/revert-original").status_code == 404


def test_revert_refuses_non_package_target_with_sibling_bak(server, client):
    """A non-package file under DLC_DIR with a sibling `.bak` must NOT be
    reverted — revert mirrors the write path's is_sloppak guard, so it never
    restores a stray backup over a file the feature was not meant to touch."""
    target = server.DLC_DIR / "notes.txt"
    target.write_bytes(b"user notes, not a pack")
    (server.DLC_DIR / "notes.txt.bak").write_bytes(b"stray backup")
    r = client.post("/api/song/notes.txt/revert-original")
    assert r.status_code == 404
    # The target is left byte-for-byte untouched.
    assert target.read_bytes() == b"user notes, not a pack"


def test_preview_reports_backup_after_gap_fill(server, client):
    """Plain gap-fill (R4a) also leaves the one-time backup — the preview
    surfaces it so the drawer can offer Revert."""
    make_dir_sloppak(server, "a.sloppak")
    seed_match(server, "a.sloppak")
    assert client.post("/api/song/a.sloppak/gap-fill",
                       json={"keys": ["album"]}).status_code == 200
    assert client.get("/api/song/a.sloppak/gap-fill").json()["has_backup"] is True


def test_demo_mode_blocks_revert(tmp_path, monkeypatch, isolate_logging):
    """The middleware turns revert away before any handler runs — demo
    visitors can never rewrite pack files."""
    monkeypatch.setenv("CONFIG_DIR", str(tmp_path / "config"))
    dlc = tmp_path / "dlc"
    dlc.mkdir()
    monkeypatch.setenv("DLC_DIR", str(dlc))
    monkeypatch.setenv("FEEDBACK_SKIP_STARTUP_TASKS", "1")
    monkeypatch.setenv("FEEDBACK_DEMO_MODE", "1")
    sys.modules.pop("server", None)
    srv = importlib.import_module("server")
    try:
        r = TestClient(srv.app).post("/api/song/a.sloppak/revert-original")
        assert r.status_code == 403
    finally:
        conn = getattr(getattr(srv, "meta_db", None), "conn", None)
        if conn is not None:
            conn.close()
        sys.modules.pop("server", None)
