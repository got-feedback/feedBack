"""Tests for /api/settings/export and /api/settings/import (feedBack#113).

The bundle round-trip covers four persistence stores; this file exercises
the two server-managed ones (server config + plugin server-side files).
The frontend localStorage layer is browser-only and out of scope here.

Each test stubs `LOADED_PLUGINS` directly rather than spinning up the
plugin loader — the loader's job (manifest parsing → `_export_paths`)
is exercised separately in `test_plugins.py`.
"""

import base64
import importlib
from routers import settings as settings_router
import json
import os
import sys
from pathlib import Path

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
        getattr(__import__("sys").modules.get("server"), "_join_background_db_threads", lambda: None)()
        conn.close()


@pytest.fixture()
def client(server_mod):
    c = TestClient(server_mod.app)
    try:
        yield c
    finally:
        c.close()


def _stub_plugin(server_mod, plugin_id: str, export_paths: list[str]):
    """Append a fake plugin record to LOADED_PLUGINS so export/import see
    it. The loader is bypassed entirely — the only fields the endpoints
    consult are `id` and `_export_paths`."""
    from plugins import LOADED_PLUGINS
    LOADED_PLUGINS.append({
        "id": plugin_id,
        "name": plugin_id,
        "nav": None,
        "type": None,
        "has_screen": False,
        "has_script": False,
        "has_settings": False,
        "_export_paths": export_paths,
        "_dir": Path("."),
        "_manifest": {},
    })


@pytest.fixture(autouse=True)
def reset_loaded_plugins():
    """LOADED_PLUGINS is module-level state in plugins/__init__.py — it
    persists across tests within the same pytest process and gets
    populated by `load_plugins()` on import. Snapshot/restore so each
    test starts from the post-import baseline rather than carrying
    fakes from previous tests."""
    from plugins import LOADED_PLUGINS
    snapshot = list(LOADED_PLUGINS)
    yield
    LOADED_PLUGINS.clear()
    LOADED_PLUGINS.extend(snapshot)


# ── Round-trip: server config only, no plugins ──────────────────────────────

def test_round_trip_no_plugins(client, tmp_path):
    (tmp_path / "config.json").write_text(json.dumps({
        "dlc_dir": "/some/path",
        "default_arrangement": "Lead",
        "master_difficulty": 75,
    }))

    bundle = client.get("/api/settings/export").json()
    assert bundle["schema"] == 1
    assert bundle["server_config"]["master_difficulty"] == 75
    assert bundle["server_config"]["default_arrangement"] == "Lead"

    # Wipe and re-import
    (tmp_path / "config.json").unlink()
    r = client.post("/api/settings/import", json=bundle)
    assert r.status_code == 200, r.json()
    assert r.json()["ok"] is True

    cfg = json.loads((tmp_path / "config.json").read_text())
    assert cfg["master_difficulty"] == 75
    assert cfg["default_arrangement"] == "Lead"


# ── Round-trip: plugin server files (binary + json + nested dir) ────────────

def test_round_trip_with_plugin_files(client, server_mod, tmp_path):
    _stub_plugin(server_mod, "fake_plugin", ["fake_plugin.db", "fake_models/"])

    # Stage some files.
    binary = bytes(range(256)) * 4  # 1 KiB of binary noise
    (tmp_path / "fake_plugin.db").write_bytes(binary)
    (tmp_path / "fake_models").mkdir()
    (tmp_path / "fake_models" / "a.json").write_text(json.dumps({"k": "v"}))
    (tmp_path / "fake_models" / "sub").mkdir()
    (tmp_path / "fake_models" / "sub" / "b.bin").write_bytes(b"\x00\x01\x02")

    bundle = client.get("/api/settings/export").json()
    files = bundle["plugin_server_configs"]["fake_plugin"]["files"]
    assert "fake_plugin.db" in files
    assert files["fake_plugin.db"]["encoding"] == "base64"
    assert "fake_models/a.json" in files
    assert files["fake_models/a.json"]["encoding"] == "json"
    assert files["fake_models/a.json"]["data"] == {"k": "v"}
    assert "fake_models/sub/b.bin" in files
    assert files["fake_models/sub/b.bin"]["encoding"] == "base64"

    # Wipe everything plugin-owned, then import.
    (tmp_path / "fake_plugin.db").unlink()
    import shutil
    shutil.rmtree(tmp_path / "fake_models")

    r = client.post("/api/settings/import", json=bundle)
    assert r.status_code == 200, r.json()

    assert (tmp_path / "fake_plugin.db").read_bytes() == binary
    assert json.loads((tmp_path / "fake_models" / "a.json").read_text()) == {"k": "v"}
    assert (tmp_path / "fake_models" / "sub" / "b.bin").read_bytes() == b"\x00\x01\x02"


# ── Schema gating ───────────────────────────────────────────────────────────

def test_schema_mismatch_refused(client, tmp_path):
    (tmp_path / "config.json").write_text(json.dumps({"master_difficulty": 50}))
    pre_mtime = (tmp_path / "config.json").stat().st_mtime_ns

    r = client.post("/api/settings/import", json={
        "schema": 2,
        "server_config": {"master_difficulty": 99},
    })
    assert r.status_code == 400
    assert "schema" in r.json()["error"].lower()

    # Disk untouched.
    assert (tmp_path / "config.json").stat().st_mtime_ns == pre_mtime
    assert json.loads((tmp_path / "config.json").read_text())["master_difficulty"] == 50


def test_missing_schema_refused(client):
    r = client.post("/api/settings/import", json={"server_config": {}})
    assert r.status_code == 400


def test_non_dict_body_refused(client):
    # FastAPI's body validation (`bundle: dict` in the handler signature)
    # produces 422 before our phase-1 check runs; the explicit `isinstance`
    # guard inside the handler covers the case where someone calls the
    # function directly. Either way, non-dict input never reaches the
    # filesystem.
    r = client.post("/api/settings/import", json=[])
    assert r.status_code in (400, 422)


# ── Version warning is non-blocking ─────────────────────────────────────────

def test_version_warning_nonblocking(client, tmp_path, server_mod):
    bundle = {
        "schema": 1,
        "feedBack_version": "999.999.999",
        "server_config": {"master_difficulty": 42},
        "plugin_server_configs": {},
    }
    r = client.post("/api/settings/import", json=bundle)
    assert r.status_code == 200, r.json()
    body = r.json()
    assert body["ok"] is True
    assert any("version mismatch" in w for w in body["warnings"])
    assert json.loads((tmp_path / "config.json").read_text())["master_difficulty"] == 42


# ── Path traversal / absolute path / undeclared file ─────────────────────────

def test_path_traversal_rejected(client, server_mod, tmp_path):
    _stub_plugin(server_mod, "fake_plugin", ["fake_plugin.db"])
    pre = json.dumps({"master_difficulty": 50})
    (tmp_path / "config.json").write_text(pre)

    bundle = {
        "schema": 1,
        "server_config": {"master_difficulty": 99},
        "plugin_server_configs": {
            "fake_plugin": {
                "files": {
                    "../../etc/passwd": {"encoding": "base64", "data": ""},
                },
            },
        },
    }
    r = client.post("/api/settings/import", json=bundle)
    assert r.status_code == 400
    # Server config also untouched — phase-1 validation refused before
    # any disk write.
    assert json.loads((tmp_path / "config.json").read_text())["master_difficulty"] == 50


def test_dotdot_after_allowed_prefix_rejected(client, server_mod, tmp_path):
    """Regression for the allowlist-bypass that would let a relpath
    starting with an allowed directory prefix smuggle a `..` past the
    matcher (e.g. `fake_models/../config.json`). The raw string passes
    a naive prefix check, but `posixpath.normpath` would collapse the
    `..` to a target outside the manifest's intent. `_validate_relpath`
    must reject any `..` segment in the *raw* relpath BEFORE
    normalization."""
    _stub_plugin(server_mod, "fake_plugin", ["fake_models/"])
    (tmp_path / "config.json").write_text(json.dumps({"master_difficulty": 50}))

    bundle = {
        "schema": 1,
        "server_config": {"master_difficulty": 99},
        "plugin_server_configs": {
            "fake_plugin": {
                "files": {
                    "fake_models/../config.json": {
                        "encoding": "base64",
                        "data": base64.b64encode(b"hijacked").decode(),
                    },
                },
            },
        },
    }
    r = client.post("/api/settings/import", json=bundle)
    assert r.status_code == 400
    # Disk untouched — phase-1 refusal blocks every write.
    assert json.loads((tmp_path / "config.json").read_text())["master_difficulty"] == 50
    assert (tmp_path / "config.json").read_text() != "hijacked"


def test_directory_bare_name_rejected(client, server_mod, tmp_path):
    """A directory entry in the allowlist (`fake_models/`) authorizes
    files *under* that prefix, never the directory itself. A bundle
    that targets the bare directory name (`fake_models`) would either
    fail `os.replace()` mid-apply (500, partial state) or — worse,
    on platforms where replace-over-empty-dir succeeds — silently
    overwrite a directory with a file. Phase-1 refuses outright."""
    _stub_plugin(server_mod, "fake_plugin", ["fake_models/"])
    (tmp_path / "fake_models").mkdir()

    bundle = {
        "schema": 1,
        "server_config": {},
        "plugin_server_configs": {
            "fake_plugin": {
                "files": {
                    "fake_models": {
                        "encoding": "base64",
                        "data": base64.b64encode(b"x").decode(),
                    },
                },
            },
        },
    }
    r = client.post("/api/settings/import", json=bundle)
    # Treated as undeclared (manifest rule was a directory entry, but
    # the bundle targets the bare dir name) → soft skip with warning,
    # no writes. Important: the fake_models directory is preserved.
    assert r.status_code == 200, r.json()
    assert any("fake_models" in w for w in r.json().get("warnings", []))
    assert (tmp_path / "fake_models").is_dir()


@pytest.mark.parametrize("bad", ["/etc/passwd", "C:/Windows/foo", r"C:\Windows\foo"])
def test_absolute_path_rejected(client, server_mod, bad):
    _stub_plugin(server_mod, "fake_plugin", ["fake_plugin.db"])
    bundle = {
        "schema": 1,
        "server_config": {},
        "plugin_server_configs": {
            "fake_plugin": {"files": {bad: {"encoding": "base64", "data": ""}}},
        },
    }
    r = client.post("/api/settings/import", json=bundle)
    assert r.status_code == 400


def test_undeclared_file_skipped_with_warning(client, server_mod, tmp_path):
    """A file in the bundle whose plugin no longer declares it (manifest
    tightened between export and import) is skipped with a warning, not
    a hard 400. The bundle's other files still apply. Path-traversal
    attempts (covered separately) remain hard failures."""
    _stub_plugin(server_mod, "fake_plugin", ["fake_plugin.db"])
    bundle = {
        "schema": 1,
        "server_config": {"master_difficulty": 77},
        "plugin_server_configs": {
            "fake_plugin": {
                "files": {
                    "fake_plugin.db": {"encoding": "base64", "data": base64.b64encode(b"new").decode()},
                    "secrets/api.key": {"encoding": "base64", "data": base64.b64encode(b"k").decode()},
                },
            },
        },
    }
    r = client.post("/api/settings/import", json=bundle)
    assert r.status_code == 200, r.json()
    body = r.json()
    assert body["ok"] is True
    assert any("secrets/api.key" in w for w in body["warnings"])
    # Declared file applied.
    assert (tmp_path / "fake_plugin.db").read_bytes() == b"new"
    # Undeclared file NOT written.
    assert not (tmp_path / "secrets" / "api.key").exists()
    # Server config still applied.
    assert json.loads((tmp_path / "config.json").read_text())["master_difficulty"] == 77


# ── Unknown plugin: skip with warning, don't fail ───────────────────────────

def test_unknown_plugin_skipped(client, tmp_path):
    bundle = {
        "schema": 1,
        "server_config": {"master_difficulty": 33},
        "plugin_server_configs": {
            "mystery_plugin": {
                "files": {"any.txt": {"encoding": "base64", "data": ""}},
            },
        },
    }
    r = client.post("/api/settings/import", json=bundle)
    assert r.status_code == 200, r.json()
    body = r.json()
    assert body["ok"] is True
    assert any("mystery_plugin" in w and "not loaded" in w for w in body["warnings"])
    assert "mystery_plugin" not in body["applied"]["plugins"]
    # Server config still applied.
    assert json.loads((tmp_path / "config.json").read_text())["master_difficulty"] == 33


# ── Atomicity: bad encoding rejects whole bundle in phase 1 ─────────────────

def test_atomicity_on_decode_failure(client, server_mod, tmp_path):
    _stub_plugin(server_mod, "fake_plugin", ["fake_plugin.db"])
    (tmp_path / "config.json").write_text(json.dumps({"master_difficulty": 50}))
    (tmp_path / "fake_plugin.db").write_bytes(b"original")

    bundle = {
        "schema": 1,
        "server_config": {"master_difficulty": 99},
        "plugin_server_configs": {
            "fake_plugin": {
                "files": {
                    "fake_plugin.db": {"encoding": "base64", "data": "this is not base64!!!"},
                },
            },
        },
    }
    r = client.post("/api/settings/import", json=bundle)
    assert r.status_code == 400
    assert json.loads((tmp_path / "config.json").read_text())["master_difficulty"] == 50
    assert (tmp_path / "fake_plugin.db").read_bytes() == b"original"


def test_unknown_encoding_rejected(client, server_mod, tmp_path):
    _stub_plugin(server_mod, "fake_plugin", ["fake_plugin.db"])
    bundle = {
        "schema": 1,
        "server_config": {},
        "plugin_server_configs": {
            "fake_plugin": {
                "files": {
                    "fake_plugin.db": {"encoding": "rot13", "data": "abc"},
                },
            },
        },
    }
    r = client.post("/api/settings/import", json=bundle)
    assert r.status_code == 400


# ── Export edge cases ───────────────────────────────────────────────────────

def test_export_skips_missing_files(client, server_mod):
    _stub_plugin(server_mod, "fake_plugin", ["does_not_exist.db", "absent_dir/"])
    bundle = client.get("/api/settings/export").json()
    # Plugin block is present but files map is empty — we still emit the
    # block so a round-trip preserves the manifest's namespace.
    assert bundle["plugin_server_configs"]["fake_plugin"]["files"] == {}


def test_export_directory_walk(client, server_mod, tmp_path):
    _stub_plugin(server_mod, "fake_plugin", ["models/"])
    (tmp_path / "models").mkdir()
    (tmp_path / "models" / "a.bin").write_bytes(b"a")
    (tmp_path / "models" / "b.bin").write_bytes(b"b")
    (tmp_path / "models" / "nested").mkdir()
    (tmp_path / "models" / "nested" / "c.bin").write_bytes(b"c")

    bundle = client.get("/api/settings/export").json()
    files = bundle["plugin_server_configs"]["fake_plugin"]["files"]
    assert set(files.keys()) == {"models/a.bin", "models/b.bin", "models/nested/c.bin"}


def test_export_includes_schema_and_version(client):
    bundle = client.get("/api/settings/export").json()
    assert bundle["schema"] == 1
    assert "feedBack_version" in bundle
    assert "exported_at" in bundle


# ── Empty bundle round-trip (defaults config) ───────────────────────────────

def test_import_with_empty_plugin_blocks(client, tmp_path):
    bundle = {
        "schema": 1,
        "server_config": {"master_difficulty": 80},
        "plugin_server_configs": {},
    }
    r = client.post("/api/settings/import", json=bundle)
    assert r.status_code == 200
    assert json.loads((tmp_path / "config.json").read_text())["master_difficulty"] == 80


def test_import_rejects_non_dict_server_config(client):
    r = client.post("/api/settings/import", json={
        "schema": 1,
        "server_config": [],
        "plugin_server_configs": {},
    })
    assert r.status_code == 400


def test_import_rejects_non_dict_plugin_blocks(client):
    r = client.post("/api/settings/import", json={
        "schema": 1,
        "server_config": {},
        "plugin_server_configs": "not an object",
    })
    assert r.status_code == 400


# ── Loader/importer rule consistency ────────────────────────────────────────

def test_normalize_export_paths_consistency(server_mod, tmp_path):
    """Round-trip safety property: every entry the loader keeps in
    `_export_paths` must satisfy `_validate_relpath` at import time. If
    these two sides drift, exports become unimportable on the same
    server (the importer rejects entries the loader produced). The
    fix in `_normalize_export_paths` mirrors the import-side rules
    (whitespace / `.` segments / leading-dot first segment); this test
    locks that contract in."""
    from plugins import _normalize_export_paths

    # Mix of bad shapes that older versions of the loader let through:
    # leading/trailing whitespace, embedded `.` segment, dotfile first
    # segment, and one good entry that should survive.
    settings_field = {
        "server_files": [
            "  trim_me.db  ",
            "models/./a.json",
            ".cache/file",
            "good.db",
        ]
    }
    cleaned = _normalize_export_paths(settings_field, "fake_plugin")
    assert cleaned == ["good.db"]

    # Every survivor must pass `_validate_relpath` against an allowlist
    # that includes itself — i.e. the loader can't produce something
    # the importer would refuse with a `ValueError` on traversal /
    # absolute-path / illegal-segment grounds.
    for rel in cleaned:
        # Wraps `_validate_relpath` to assert it doesn't raise the
        # hard-failure ValueErrors. _UndeclaredFile would mean the
        # allowlist is wrong, not that the relpath shape is bad.
        settings_router._validate_relpath(rel, cleaned, tmp_path)


# ── Atomic write: unique tmp + cleanup on failure ───────────────────────────

def test_atomic_write_cleans_up_tmp_on_failure(server_mod, tmp_path, monkeypatch):
    """`_atomic_write_file` must remove its temp file when `os.replace`
    fails. Otherwise a failed import leaves `.tmp.import` litter in
    config_dir that persists across server restarts. Also verifies the
    contract that two failed calls don't collide on the same temp name
    (mkstemp ensures unique names; we assert both temps are gone)."""
    target = tmp_path / "out.db"

    boom_calls = {"n": 0}
    real_replace = server_mod.os.replace

    def boom(*args, **kwargs):
        boom_calls["n"] += 1
        raise OSError("simulated replace failure")

    monkeypatch.setattr(server_mod.os, "replace", boom)

    for _ in range(2):
        with pytest.raises(OSError):
            settings_router._atomic_write_file(target, b"payload")

    # Both attempts cleaned up. No .tmp.import residue means the
    # mkstemp + finally-unlink pattern held even across failures.
    leftover = list(tmp_path.glob("*.tmp.import"))
    assert leftover == [], f"temp files leaked: {leftover}"
    assert boom_calls["n"] == 2

    # Restoring real replace, the function should still work end-to-end.
    monkeypatch.setattr(server_mod.os, "replace", real_replace)
    settings_router._atomic_write_file(target, b"payload")
    assert target.read_bytes() == b"payload"
    assert list(tmp_path.glob("*.tmp.import")) == []


# ── Partial-failure response uses relpaths, not absolute paths ──────────────

def test_partial_field_uses_relpaths_not_absolute(client, server_mod, tmp_path, monkeypatch):
    """When `_atomic_write_file` fails mid-apply, the 500 response
    surfaces a `partial` list. Returning absolute resolved paths there
    leaks deployment layout (e.g. `/srv/feedBack/config/...`); the
    importer instead returns the bundle's own relpaths, which are
    portable and meaningful to the user."""
    _stub_plugin(server_mod, "fake_plugin", ["a.db", "b.db"])

    # Fail on the second `os.replace` call so the first file commits
    # but the second triggers the OSError branch. `partial` should
    # then list the first file as `<plugin_id>/<relpath>` — never an
    # absolute path containing the tmp_path config dir.
    call_count = {"n": 0}
    real_replace = server_mod.os.replace

    def selective_boom(src, dst, *args, **kwargs):
        call_count["n"] += 1
        if call_count["n"] == 2:
            raise OSError("simulated mid-apply failure")
        return real_replace(src, dst, *args, **kwargs)

    monkeypatch.setattr(server_mod.os, "replace", selective_boom)

    bundle = {
        "schema": 1,
        "server_config": {"master_difficulty": 99},
        "plugin_server_configs": {
            "fake_plugin": {
                "files": {
                    "a.db": {"encoding": "base64", "data": base64.b64encode(b"A").decode()},
                    "b.db": {"encoding": "base64", "data": base64.b64encode(b"B").decode()},
                },
            },
        },
    }
    r = client.post("/api/settings/import", json=bundle)
    assert r.status_code == 500
    body = r.json()
    partial = body.get("partial")
    assert isinstance(partial, list) and partial, body
    config_root = str(tmp_path)
    for p in partial:
        # Relpath form: no absolute prefix, no drive letter, no leak
        # of the local config_dir's filesystem path.
        assert not p.startswith("/"), p
        assert config_root not in p, p
        assert ":" not in p[:3], p  # no drive letter
    # First file actually got written (because we let the first
    # replace through); listed in `partial` under its plugin-prefixed
    # relpath form.
    assert any(p.endswith("a.db") for p in partial)


# ── Import validates server_config types/ranges ─────────────────────────────

@pytest.mark.parametrize("bad_cfg, needle", [
    ({"master_difficulty": 150}, "master_difficulty"),
    ({"master_difficulty": -1}, "master_difficulty"),
    ({"master_difficulty": True}, "master_difficulty"),
    ({"master_difficulty": "75"}, "master_difficulty"),
    ({"av_offset_ms": 5000}, "av_offset_ms"),
    ({"av_offset_ms": False}, "av_offset_ms"),
    ({"demucs_server_url": 42}, "demucs_server_url"),
    ({"default_arrangement": ["Lead"]}, "default_arrangement"),
    ({"dlc_dir": 42}, "dlc_dir"),
])
def test_import_refuses_invalid_server_config(client, tmp_path, bad_cfg, needle):
    """Importer must apply the same per-key type/range gates that
    POST /api/settings enforces; otherwise a hand-edited bundle could
    persist values that downstream code crashes on (e.g. non-string
    demucs_server_url, out-of-range difficulty)."""
    pre = json.dumps({"master_difficulty": 50})
    (tmp_path / "config.json").write_text(pre)

    bundle = {
        "schema": 1,
        "server_config": bad_cfg,
        "plugin_server_configs": {},
    }
    r = client.post("/api/settings/import", json=bundle)
    assert r.status_code == 400, r.json()
    assert needle in r.json()["error"]
    # Disk untouched — phase-1 refusal blocks every write.
    assert json.loads((tmp_path / "config.json").read_text())["master_difficulty"] == 50


def test_import_passes_through_unknown_server_config_keys(client, tmp_path):
    """Unknown server_config keys round-trip verbatim. The import path
    isn't the place to gatekeep what plugins / future versions may add
    to the settings dict — gates apply only to keys we know about."""
    bundle = {
        "schema": 1,
        "server_config": {
            "master_difficulty": 60,
            "future_setting": {"nested": True},
            "unknown_string": "hello",
        },
        "plugin_server_configs": {},
    }
    r = client.post("/api/settings/import", json=bundle)
    assert r.status_code == 200, r.json()
    cfg = json.loads((tmp_path / "config.json").read_text())
    assert cfg["future_setting"] == {"nested": True}
    assert cfg["unknown_string"] == "hello"
    assert cfg["master_difficulty"] == 60


# ── Export refuses to follow symlinked subdirectories ───────────────────────

def test_export_skips_symlinked_subdir_contents(client, server_mod, tmp_path):
    """Manifest declares `models/`, the user's config_dir contains a
    real file `models/a.bin` and a symlinked subdirectory
    `models/linked → outside/`. `os.walk(followlinks=False)` plus the
    explicit `dirnames`/`islink` filters must keep the bundle from
    capturing the symlinked contents — otherwise an attacker (or just
    a misconfigured volume mount) can leak data outside config_dir."""
    _stub_plugin(server_mod, "fake_plugin", ["models/"])

    (tmp_path / "models").mkdir()
    (tmp_path / "models" / "a.bin").write_bytes(b"real")
    (tmp_path / "outside").mkdir()
    (tmp_path / "outside" / "secret.bin").write_bytes(b"SECRET")

    try:
        os.symlink(
            str(tmp_path / "outside"),
            str(tmp_path / "models" / "linked"),
            target_is_directory=True,
        )
    except (OSError, NotImplementedError):
        # Windows without Developer Mode / admin can't create symlinks;
        # that's a privilege limitation of the test host, not a bug in
        # the code under test. Skip rather than xfail so devs with the
        # privilege still exercise the assertion.
        pytest.skip("symlink creation not permitted on this host")

    bundle = client.get("/api/settings/export").json()
    files = bundle["plugin_server_configs"]["fake_plugin"]["files"]
    assert "models/a.bin" in files
    # The leak we're guarding against: the symlinked subdir's contents
    # must NOT appear in the bundle in any form.
    assert "models/linked/secret.bin" not in files
    assert not any("secret.bin" in k for k in files)


# ── Import refuses symlink target / symlinked parent ────────────────────────

def test_import_rejects_symlinked_target_file(client, server_mod, tmp_path):
    """Even a fully-allowlisted relpath must not redirect through a
    symlink on import: the manifest declares `fake_plugin.db`, but the
    user's config_dir contains a symlink at that name pointing at a
    different in-config file. Writing through the symlink would defeat
    the manifest's allowlist intent (the bundle authors `fake_plugin.db`
    but bytes land at `decoy.db`). Phase-1 must refuse outright.
    """
    _stub_plugin(server_mod, "fake_plugin", ["fake_plugin.db"])
    (tmp_path / "decoy.db").write_bytes(b"original")
    try:
        os.symlink(str(tmp_path / "decoy.db"), str(tmp_path / "fake_plugin.db"))
    except (OSError, NotImplementedError):
        pytest.skip("symlink creation not permitted on this host")

    bundle = {
        "schema": 1,
        "server_config": {},
        "plugin_server_configs": {
            "fake_plugin": {
                "files": {
                    "fake_plugin.db": {
                        "encoding": "base64",
                        "data": base64.b64encode(b"hijacked").decode(),
                    },
                },
            },
        },
    }
    r = client.post("/api/settings/import", json=bundle)
    assert r.status_code == 400, r.json()
    # Decoy file untouched — write was refused, not just redirected to
    # a different output destination.
    assert (tmp_path / "decoy.db").read_bytes() == b"original"


def test_import_rejects_symlinked_parent_dir(client, server_mod, tmp_path):
    """Manifest declares `models/`, but the user's config_dir has
    `models` as a symlink to a sibling directory. Writing through it
    would let the bundle author `models/<anything>` and have bytes land
    in the symlink target — bypassing the spirit of the allowlist
    even if the resolved path stays inside config_dir."""
    _stub_plugin(server_mod, "fake_plugin", ["models/"])
    (tmp_path / "real_models").mkdir()
    try:
        os.symlink(
            str(tmp_path / "real_models"),
            str(tmp_path / "models"),
            target_is_directory=True,
        )
    except (OSError, NotImplementedError):
        pytest.skip("symlink creation not permitted on this host")

    bundle = {
        "schema": 1,
        "server_config": {},
        "plugin_server_configs": {
            "fake_plugin": {
                "files": {
                    "models/x.bin": {
                        "encoding": "base64",
                        "data": base64.b64encode(b"x").decode(),
                    },
                },
            },
        },
    }
    r = client.post("/api/settings/import", json=bundle)
    assert r.status_code == 400, r.json()
    # No file written through the symlink either.
    assert not (tmp_path / "real_models" / "x.bin").exists()


# ── _atomic_write_file: closes raw fd if os.fdopen raises ───────────────────

def test_atomic_write_closes_fd_when_fdopen_fails(server_mod, tmp_path, monkeypatch):
    """`tempfile.mkstemp` returns a raw fd; `os.fdopen` is the only
    code path that takes ownership. If `os.fdopen` itself raises
    (rare — EMFILE / ENOMEM), the fd would otherwise leak, and on
    Windows the temp file would remain locked. Verify the
    fdopen-failure path explicitly closes the fd and removes the
    temp file."""
    target = tmp_path / "out.db"

    closed_fds: list[int] = []
    real_close = os.close

    def tracking_close(fd):
        closed_fds.append(fd)
        return real_close(fd)

    def boom_fdopen(*args, **kwargs):
        raise OSError("simulated EMFILE")

    monkeypatch.setattr(server_mod.os, "close", tracking_close)
    monkeypatch.setattr(server_mod.os, "fdopen", boom_fdopen)

    with pytest.raises(OSError, match="simulated EMFILE"):
        settings_router._atomic_write_file(target, b"payload")

    # fd was closed (so it didn't leak), and the temp file mkstemp
    # created was removed (so it doesn't litter / lock on Windows).
    assert closed_fds, "raw fd was never closed after fdopen failure"
    assert list(tmp_path.glob("*.tmp.import")) == []
