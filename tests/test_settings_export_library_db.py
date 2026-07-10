"""Tests for the library-DB + custom-art half of the settings bundle
(got-feedback/feedBack#636 item 1).

The base bundle (config + plugin files) is covered in test_settings_export.py;
this file pins the additive `core_server_files` section:

  - the live library DB is exported as a CONSISTENT single-file snapshot
    (SQLite online-backup), base64-encoded;
  - custom playlist covers / avatar are walked into the bundle;
  - on import the DB is STAGED to `web_library.db.restore` (never written
    over the live, open DB) and swapped in at next startup, clearing stale
    WAL sidecars; custom art is written immediately;
  - the whole thing round-trips: export → wipe → import → restart → data back.
"""

import base64
import importlib
import sqlite3
import sys
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

# The startup DB swap lives with the DB layer it guards, not with server.py.
# metadata_db reads no environment at import, so a plain module import is safe
# alongside the env-patched `server_mod` fixture below.
from metadata_db import _apply_pending_db_restore


@pytest.fixture()
def server_mod(tmp_path, monkeypatch):
    monkeypatch.setenv("CONFIG_DIR", str(tmp_path))
    sys.modules.pop("server", None)
    mod = importlib.import_module("server")
    yield mod
    conn = getattr(getattr(mod, "meta_db", None), "conn", None)
    if conn is not None:
        getattr(__import__("sys").modules.get("server"), "_join_background_db_threads", lambda: None)()
        conn.close()


@pytest.fixture()
def client(server_mod):
    c = TestClient(server_mod.app)
    try:
        yield c
    finally:
        c.close()


def _valid_db_bytes(tmp_path, name="mk.db", marker="x"):
    """Bytes of a small, valid (quick_check-clean) SQLite database."""
    p = tmp_path / name
    c = sqlite3.connect(str(p))
    try:
        c.execute("CREATE TABLE t (x TEXT)")
        c.execute("INSERT INTO t VALUES (?)", (marker,))
        c.commit()
    finally:
        c.close()
    return p.read_bytes()


def _seed_song(server_mod, filename="marker.archive", title="Marker", artist="Tester"):
    server_mod.meta_db.put(filename, 1.0, 1, {
        "title": title, "artist": artist, "album": "LP", "year": "",
        "duration": 200.0, "tuning": "E Standard", "arrangements": [],
        "has_lyrics": False, "format": "archive", "stem_count": 0,
        "stem_ids": [], "tuning_name": "E Standard", "tuning_sort_key": 0,
        "tuning_offsets": "",
    })


# ── Export ──────────────────────────────────────────────────────────────────

def test_export_includes_consistent_library_db_snapshot(client, server_mod, tmp_path):
    _seed_song(server_mod, filename="snap.archive", title="SnapSong")

    bundle = client.get("/api/settings/export").json()
    core = bundle["core_server_files"]
    assert "web_library.db" in core
    entry = core["web_library.db"]
    assert entry["encoding"] == "base64"

    # The snapshot must be a complete, openable DB reflecting current data —
    # written to its own file (no WAL sidecar needed) and queryable.
    snap = tmp_path / "snapshot.db"
    snap.write_bytes(base64.b64decode(entry["data"]))
    conn = sqlite3.connect(str(snap))
    try:
        rows = conn.execute(
            "SELECT title FROM songs WHERE filename = ?", ("snap.archive",)
        ).fetchall()
    finally:
        getattr(__import__("sys").modules.get("server"), "_join_background_db_threads", lambda: None)()
        conn.close()
    assert rows == [("SnapSong",)]


def test_export_includes_custom_art_dirs(client, tmp_path):
    (tmp_path / "playlist_covers").mkdir()
    (tmp_path / "playlist_covers" / "3.png").write_bytes(b"\x89PNG-cover")
    (tmp_path / "avatars").mkdir()
    (tmp_path / "avatars" / "me.png").write_bytes(b"\x89PNG-avatar")

    core = client.get("/api/settings/export").json()["core_server_files"]
    assert core["playlist_covers/3.png"]["encoding"] == "base64"
    assert base64.b64decode(core["playlist_covers/3.png"]["data"]) == b"\x89PNG-cover"
    assert base64.b64decode(core["avatars/me.png"]["data"]) == b"\x89PNG-avatar"


# ── Import: DB is staged, never written over the live file ──────────────────

def test_import_stages_db_restore_without_touching_live_db(client, server_mod, tmp_path):
    live = tmp_path / "web_library.db"
    live_bytes_before = live.read_bytes()

    payload = _valid_db_bytes(tmp_path, name="incoming.db", marker="restored")
    r = client.post("/api/settings/import", json={
        "schema": server_mod.SETTINGS_BUNDLE_SCHEMA,
        "server_config": {},
        "core_server_files": {
            "web_library.db": {"encoding": "base64",
                               "data": base64.b64encode(payload).decode()},
        },
    })
    assert r.status_code == 200
    body = r.json()
    assert body["ok"] is True
    assert body["restart_required"] is True
    assert any("restart" in w.lower() for w in body["warnings"])
    assert "web_library.db" in body["applied"]["core_files"]

    # Live DB untouched; the restore is staged beside it for next startup.
    assert live.read_bytes() == live_bytes_before
    assert (tmp_path / "web_library.db.restore").read_bytes() == payload


def test_import_rejects_corrupt_db_with_valid_magic_header(client, server_mod, tmp_path):
    # The dangerous case: SQLite magic header but a corrupt body. It must be
    # refused at import — otherwise startup would delete the live DB and then
    # fail to open the bad restore.
    corrupt = b"SQLite format 3\x00" + b"\xff" * 200
    r = client.post("/api/settings/import", json={
        "schema": server_mod.SETTINGS_BUNDLE_SCHEMA,
        "server_config": {},
        "core_server_files": {
            "web_library.db": {"encoding": "base64",
                               "data": base64.b64encode(corrupt).decode()},
        },
    })
    assert r.status_code == 400
    assert not (tmp_path / "web_library.db.restore").exists()


def test_import_rejects_non_sqlite_db_payload(client, server_mod, tmp_path):
    # A truncated / wrong file staged as the restore would brick startup —
    # reject anything lacking the SQLite magic header, before touching disk.
    r = client.post("/api/settings/import", json={
        "schema": server_mod.SETTINGS_BUNDLE_SCHEMA,
        "server_config": {},
        "core_server_files": {
            "web_library.db": {"encoding": "base64",
                               "data": base64.b64encode(b"not a database").decode()},
        },
    })
    assert r.status_code == 400
    assert not (tmp_path / "web_library.db.restore").exists()


def test_import_writes_custom_art_immediately(client, server_mod, tmp_path):
    r = client.post("/api/settings/import", json={
        "schema": server_mod.SETTINGS_BUNDLE_SCHEMA,
        "server_config": {},
        "core_server_files": {
            "playlist_covers/7.png": {"encoding": "base64",
                                      "data": base64.b64encode(b"cover7").decode()},
        },
    })
    assert r.status_code == 200
    assert r.json()["restart_required"] is False
    assert (tmp_path / "playlist_covers" / "7.png").read_bytes() == b"cover7"


def test_import_core_path_traversal_rejected(client, server_mod, tmp_path):
    secret = tmp_path.parent / "escape.txt"
    r = client.post("/api/settings/import", json={
        "schema": server_mod.SETTINGS_BUNDLE_SCHEMA,
        "server_config": {},
        "core_server_files": {
            "../escape.txt": {"encoding": "base64",
                              "data": base64.b64encode(b"pwned").decode()},
        },
    })
    assert r.status_code == 400
    assert not secret.exists()


def test_import_core_undeclared_path_skipped_not_fatal(client, server_mod, tmp_path):
    # A relpath outside the core allowlist is a warn-and-skip, not a refusal —
    # the rest of the bundle still applies.
    r = client.post("/api/settings/import", json={
        "schema": server_mod.SETTINGS_BUNDLE_SCHEMA,
        "server_config": {},
        "core_server_files": {
            "audio_cache/x.ogg": {"encoding": "base64",
                                  "data": base64.b64encode(b"nope").decode()},
        },
    })
    assert r.status_code == 200
    assert not (tmp_path / "audio_cache" / "x.ogg").exists()
    assert any("undeclared" in w.lower() for w in r.json()["warnings"])


# ── Startup swap ────────────────────────────────────────────────────────────

def test_apply_pending_db_restore_swaps_and_clears_sidecars(server_mod, tmp_path):
    main = tmp_path / "web_library.db"
    new_db = _valid_db_bytes(tmp_path, name="new.db", marker="new")
    # Simulate a live DB with stale WAL sidecars + a (valid) staged restore.
    main.write_bytes(b"OLD-DB")
    (tmp_path / "web_library.db-wal").write_bytes(b"OLD-WAL")
    (tmp_path / "web_library.db-shm").write_bytes(b"OLD-SHM")
    (tmp_path / "web_library.db.restore").write_bytes(new_db)

    _apply_pending_db_restore(tmp_path)

    assert main.read_bytes() == new_db                  # swapped in
    assert not (tmp_path / "web_library.db.restore").exists()
    assert not (tmp_path / "web_library.db-wal").exists()  # stale sidecars gone
    assert not (tmp_path / "web_library.db-shm").exists()


def test_apply_pending_db_restore_discards_corrupt_keeps_live(server_mod, tmp_path):
    # A corrupt staged restore must be thrown away WITHOUT destroying the
    # live DB — never brick startup or lose data for a bad bundle.
    main = tmp_path / "web_library.db"
    main.write_bytes(b"LIVE-GOOD-DB")
    (tmp_path / "web_library.db.restore").write_bytes(b"SQLite format 3\x00" + b"\xff" * 64)

    _apply_pending_db_restore(tmp_path)

    assert main.read_bytes() == b"LIVE-GOOD-DB"          # live DB preserved
    assert not (tmp_path / "web_library.db.restore").exists()  # bad restore dropped


def test_apply_pending_db_restore_noop_without_staging(server_mod, tmp_path):
    (tmp_path / "web_library.db").write_bytes(b"LIVE")
    _apply_pending_db_restore(tmp_path)        # nothing staged
    assert (tmp_path / "web_library.db").read_bytes() == b"LIVE"


# ── Full round-trip ─────────────────────────────────────────────────────────

def test_full_db_backup_restore_round_trip(client, server_mod, tmp_path):
    _seed_song(server_mod, filename="keepme.archive", title="KeepMe")
    bundle = client.get("/api/settings/export").json()

    # Lose the data (a song removed from the live DB after the backup).
    server_mod.meta_db.conn.execute("DELETE FROM songs WHERE filename = ?", ("keepme.archive",))
    server_mod.meta_db.conn.commit()
    assert server_mod.meta_db.conn.execute(
        "SELECT COUNT(*) FROM songs WHERE filename = ?", ("keepme.archive",)
    ).fetchone()[0] == 0

    # Re-import the bundle → DB staged, not yet live.
    r = client.post("/api/settings/import", json=bundle)
    assert r.status_code == 200 and r.json()["restart_required"] is True

    # Simulate a restart: close the live conn, apply the staged restore,
    # reopen — the song is back.
    server_mod.meta_db.conn.close()
    _apply_pending_db_restore(tmp_path)
    conn = sqlite3.connect(str(tmp_path / "web_library.db"))
    try:
        rows = conn.execute(
            "SELECT title FROM songs WHERE filename = ?", ("keepme.archive",)
        ).fetchall()
    finally:
        getattr(__import__("sys").modules.get("server"), "_join_background_db_threads", lambda: None)()
        conn.close()
    assert rows == [("KeepMe",)]
    assert not (tmp_path / "web_library.db.restore").exists()


# ── Failure modes ───────────────────────────────────────────────────────────

def test_export_fails_hard_when_db_snapshot_unavailable(client, server_mod, monkeypatch):
    # A backup that silently omits the library DB is a data-loss trap — the
    # export must error rather than hand back an incomplete-looking bundle.
    monkeypatch.setattr(server_mod, "_snapshot_library_db", lambda: None)
    r = client.get("/api/settings/export")
    assert r.status_code == 500
    assert "library database" in r.json()["error"].lower()


def test_failed_import_disarms_staged_db_restore(client, server_mod, tmp_path, monkeypatch):
    # If a later write in phase 2 fails, the request 500s — but a staged DB
    # restore must NOT survive to swap in on the next restart.
    payload = _valid_db_bytes(tmp_path, name="incoming.db")
    real_write = server_mod._atomic_write_file

    def boom(target, data):
        if target.name == "config.json":          # last write of the commit
            raise OSError("disk full")
        return real_write(target, data)

    monkeypatch.setattr(server_mod, "_atomic_write_file", boom)
    r = client.post("/api/settings/import", json={
        "schema": server_mod.SETTINGS_BUNDLE_SCHEMA,
        "server_config": {},
        "core_server_files": {
            "web_library.db": {"encoding": "base64",
                               "data": base64.b64encode(payload).decode()},
        },
    })
    assert r.status_code == 500
    assert not (tmp_path / "web_library.db.restore").exists()
