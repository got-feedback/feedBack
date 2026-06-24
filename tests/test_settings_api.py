"""Tests for server.py /api/settings — partial-update safety and the
master_difficulty key added in feedBack#48 PR 2.

The endpoint must merge only keys present in the request body so that
single-key POSTs (like the difficulty slider's oninput fire-and-forget)
don't clobber unrelated settings on disk.

Also covers _get_dlc_dir() precedence: empty/unset DLC_DIR must not
shadow the config.json dlc_dir fallback.
"""

import importlib
import json
import sys

import pytest


class _DirectResponse:
    def __init__(self, payload, status_code=200):
        self._payload = payload
        self.status_code = status_code

    def json(self):
        return self._payload


class _DirectSettingsClient:
    def __init__(self, server):
        self._server = server

    def get(self, path):
        if path != "/api/settings":
            raise ValueError(f"unsupported path: {path}")
        return _DirectResponse(self._server.get_settings())

    def post(self, path, json):
        if path == "/api/settings":
            return _DirectResponse(self._server.save_settings(json))
        if path == "/api/settings/reset":
            return _DirectResponse(self._server.reset_settings(json))
        raise ValueError(f"unsupported path: {path}")

    def close(self):
        pass


@pytest.fixture()
def client(tmp_path, monkeypatch):
    # Point CONFIG_DIR at a per-test temp path BEFORE server's
    # import-time side effects run. server.py reads CONFIG_DIR from the
    # environment at module load (line 35) and immediately constructs
    # `meta_db = MetadataDB()` at module level, which calls
    # CONFIG_DIR.mkdir(...) and opens a sqlite file — a plain
    # post-import monkeypatch on server.CONFIG_DIR wouldn't catch those
    # side effects, and the real user config dir would get written to.
    # Forcing a fresh import inside the patched env means each test
    # gets an isolated meta_db + config dir.
    monkeypatch.setenv("CONFIG_DIR", str(tmp_path))
    monkeypatch.setenv("FEEDBACK_SKIP_STARTUP_TASKS", "1")
    sys.modules.pop("server", None)
    server = importlib.import_module("server")
    test_client = _DirectSettingsClient(server)
    try:
        yield test_client
    finally:
        # This fixture drives settings handlers directly (no FastAPI/HTTP
        # layer), so there's nothing to close on the client side — the
        # `close()` is just a stub kept for symmetry. What we *do* need
        # to release is the sqlite connection meta_db opened at import:
        # without this teardown each test leaks a file handle and
        # pytest's per-test tmp_path cleanup can fail on Windows while
        # that handle is still open.
        test_client.close()
        meta_db = getattr(server, "meta_db", None)
        conn = getattr(meta_db, "conn", None)
        if conn is not None:
            conn.close()


def _read_cfg(tmp_path):
    return json.loads((tmp_path / "config.json").read_text())


# ── master_difficulty round-trip ─────────────────────────────────────────────

def test_post_master_difficulty_persists(client, tmp_path):
    r = client.post("/api/settings", json={"master_difficulty": 75})
    assert r.status_code == 200
    assert _read_cfg(tmp_path)["master_difficulty"] == 75


def test_get_returns_persisted_master_difficulty(client, tmp_path):
    client.post("/api/settings", json={"master_difficulty": 60})
    r = client.get("/api/settings")
    assert r.status_code == 200
    assert r.json()["master_difficulty"] == 60


def test_master_difficulty_clamped_to_range(client, tmp_path):
    client.post("/api/settings", json={"master_difficulty": 150})
    assert _read_cfg(tmp_path)["master_difficulty"] == 100
    client.post("/api/settings", json={"master_difficulty": -5})
    assert _read_cfg(tmp_path)["master_difficulty"] == 0


def test_master_difficulty_accepts_numeric_string(client, tmp_path):
    # Some clients stringify numbers before POSTing. int(float(...))
    # covers both "75" and "75.0" without introducing a hard type
    # constraint on the wire.
    client.post("/api/settings", json={"master_difficulty": "75"})
    assert _read_cfg(tmp_path)["master_difficulty"] == 75
    client.post("/api/settings", json={"master_difficulty": "42.9"})
    assert _read_cfg(tmp_path)["master_difficulty"] == 42


@pytest.mark.parametrize("bad_value", [
    None, "", "abc", [], {},
    "inf", "-inf", "1e309",  # float("inf") / overflow past int range
    True, False,             # bool is a subclass of int in Python
])
def test_master_difficulty_rejects_non_numeric(client, tmp_path, bad_value):
    # Public endpoint — a bad value shouldn't 500. Returns an error
    # object like the dlc_dir validation branch, and doesn't write
    # anything to disk. Overflow cases (int(float("inf"))) raise
    # OverflowError distinctly from ValueError, so the handler catches
    # both.
    (tmp_path / "config.json").write_text(json.dumps({"master_difficulty": 50}))
    r = client.post("/api/settings", json={"master_difficulty": bad_value})
    assert r.status_code == 200  # handler returns dict, not HTTPException
    assert "error" in r.json()
    # Previous value is preserved
    assert _read_cfg(tmp_path)["master_difficulty"] == 50


# ── Partial-update safety: a single-key POST must not clobber siblings ──────

def test_slider_post_does_not_clobber_other_keys(client, tmp_path):
    # Seed all three "soft" keys.
    (tmp_path / "config.json").write_text(json.dumps({
        "default_arrangement": "Lead",
        "demucs_server_url": "http://demucs.example:9000",
        "master_difficulty": 100,
    }))

    # Simulate the slider's fire-and-forget POST — just the one key.
    client.post("/api/settings", json={"master_difficulty": 50})

    cfg = _read_cfg(tmp_path)
    assert cfg["master_difficulty"] == 50
    assert cfg["default_arrangement"] == "Lead"
    assert cfg["demucs_server_url"] == "http://demucs.example:9000"


def test_default_arrangement_post_does_not_clobber_master_difficulty(client, tmp_path):
    # Symmetric: persisting default_arrangement from the arrangement picker
    # must not wipe a previously-set master_difficulty.
    (tmp_path / "config.json").write_text(json.dumps({
        "master_difficulty": 80,
    }))

    client.post("/api/settings", json={"default_arrangement": "Bass"})

    cfg = _read_cfg(tmp_path)
    assert cfg["master_difficulty"] == 80
    assert cfg["default_arrangement"] == "Bass"


def test_dlc_dir_null_is_noop_not_clear(client, tmp_path):
    # Pre-refactor, absent dlc_dir was implicitly ignored. Some clients
    # send `null` rather than omitting the key; those should also be a
    # no-op so an unrelated POST can't silently wipe the DLC setting.
    (tmp_path / "config.json").write_text(json.dumps({
        "dlc_dir": "/existing/path",
    }))
    client.post("/api/settings", json={"dlc_dir": None, "master_difficulty": 50})
    assert _read_cfg(tmp_path)["dlc_dir"] == "/existing/path"


@pytest.mark.parametrize("bad_content", ["[]", '"hello"', "42", "null", "not valid json {"])
def test_post_recovers_from_malformed_config_file(client, tmp_path, bad_content):
    # If config.json is valid JSON but a non-dict (e.g. a migrated
    # version or user tampering), assignments like cfg["dlc_dir"] = ...
    # would crash with TypeError. Treat non-dict parsed values the same
    # as missing — fall back to defaults, merge the request, write back
    # a clean dict-shaped file.
    (tmp_path / "config.json").write_text(bad_content)
    r = client.post("/api/settings", json={"master_difficulty": 60})
    assert r.status_code == 200
    cfg = _read_cfg(tmp_path)
    assert isinstance(cfg, dict)
    assert cfg["master_difficulty"] == 60


def test_first_run_slider_post_preserves_default_dlc_dir(client, tmp_path):
    # Regression: on first run there's no config.json yet. If the
    # slider's single-key POST is the first write, the server must
    # seed cfg with _default_settings() first — otherwise the written
    # config.json would lack dlc_dir, and subsequent GETs would return
    # blank instead of the fallback DLC_DIR path.
    assert not (tmp_path / "config.json").exists()
    client.post("/api/settings", json={"master_difficulty": 50})
    cfg = _read_cfg(tmp_path)
    assert cfg["master_difficulty"] == 50
    # dlc_dir key must be present (value can be empty string if the
    # default DLC_DIR doesn't exist on this host — the point is the
    # key survives rather than getting dropped).
    assert "dlc_dir" in cfg


def test_dlc_dir_empty_string_clears(client, tmp_path):
    # Explicit empty string IS "clear" — keeps a route for a user who
    # wants to unset the DLC dir via the settings panel.
    (tmp_path / "config.json").write_text(json.dumps({
        "dlc_dir": "/existing/path",
    }))
    client.post("/api/settings", json={"dlc_dir": ""})
    assert _read_cfg(tmp_path)["dlc_dir"] == ""


@pytest.mark.parametrize("key", ["default_arrangement", "demucs_server_url"])
def test_string_key_null_is_noop(client, tmp_path, key):
    # Match the dlc_dir contract: null preserves the on-disk value.
    (tmp_path / "config.json").write_text(json.dumps({key: "existing"}))
    client.post("/api/settings", json={key: None, "master_difficulty": 50})
    assert _read_cfg(tmp_path)[key] == "existing"


@pytest.mark.parametrize("key", ["default_arrangement", "demucs_server_url"])
@pytest.mark.parametrize("bad_value", [42, [], {}, True])
def test_string_key_non_string_rejected(client, tmp_path, key, bad_value):
    # Downstream consumers call string methods on these values
    # (e.g. demucs_server_url.rstrip('/') in lib/sloppak_convert.py).
    # Reject non-strings at the boundary so garbage can't persist.
    (tmp_path / "config.json").write_text(json.dumps({key: "existing"}))
    r = client.post("/api/settings", json={key: bad_value})
    assert "error" in r.json()
    assert _read_cfg(tmp_path)[key] == "existing"


@pytest.mark.parametrize("key", ["default_arrangement", "demucs_server_url"])
def test_string_key_empty_string_clears(client, tmp_path, key):
    (tmp_path / "config.json").write_text(json.dumps({key: "existing"}))
    client.post("/api/settings", json={key: ""})
    assert _read_cfg(tmp_path)[key] == ""


def test_dlc_dir_non_string_rejected(client, tmp_path):
    # Non-string JSON (number, list, object) shouldn't reach Path(...)
    # and crash. Returns the structured error + preserves on-disk value.
    (tmp_path / "config.json").write_text(json.dumps({
        "dlc_dir": "/existing/path",
    }))
    r = client.post("/api/settings", json={"dlc_dir": 42})
    assert "error" in r.json()
    assert _read_cfg(tmp_path)["dlc_dir"] == "/existing/path"


def test_empty_post_preserves_all_existing_keys(client, tmp_path):
    (tmp_path / "config.json").write_text(json.dumps({
        "default_arrangement": "Lead",
        "demucs_server_url": "http://demucs.example:9000",
        "master_difficulty": 42,
    }))

    client.post("/api/settings", json={})

    assert _read_cfg(tmp_path) == {
        "default_arrangement": "Lead",
        "demucs_server_url": "http://demucs.example:9000",
        "master_difficulty": 42,
    }


# ── Absent master_difficulty → GET falls through (frontend default) ─────────

def test_get_without_master_difficulty_omits_key(client, tmp_path):
    # When no master_difficulty has been saved, the GET response should
    # not include it — frontend defaults to 100 on its own side. This
    # matches the other keys' behaviour (GET reflects what's on disk).
    r = client.get("/api/settings")
    assert r.status_code == 200
    assert "master_difficulty" not in r.json()


# ── _get_dlc_dir() — env-var / config.json precedence ───────────────────────

@pytest.fixture()
def server_module(tmp_path, monkeypatch):
    """Import server with CONFIG_DIR isolated in tmp_path and DLC_DIR unset."""
    monkeypatch.setenv("CONFIG_DIR", str(tmp_path))
    monkeypatch.delenv("DLC_DIR", raising=False)
    sys.modules.pop("server", None)
    mod = importlib.import_module("server")
    yield mod
    meta_db = getattr(mod, "meta_db", None)
    conn = getattr(meta_db, "conn", None)
    if conn is not None:
        conn.close()


def test_get_dlc_dir_uses_config_when_env_unset(tmp_path, server_module):
    """When DLC_DIR is unset, _get_dlc_dir() returns the path from config.json."""
    dlc_dir = tmp_path / "my_dlc"
    dlc_dir.mkdir()
    (tmp_path / "config.json").write_text(json.dumps({"dlc_dir": str(dlc_dir)}))

    result = server_module._get_dlc_dir()
    assert result == dlc_dir


def test_get_dlc_dir_uses_config_when_env_empty(tmp_path, monkeypatch):
    """When DLC_DIR is set to an empty string, config.json still wins."""
    monkeypatch.setenv("CONFIG_DIR", str(tmp_path))
    monkeypatch.setenv("DLC_DIR", "")
    sys.modules.pop("server", None)
    mod = importlib.import_module("server")
    try:
        dlc_dir = tmp_path / "my_dlc"
        dlc_dir.mkdir()
        (tmp_path / "config.json").write_text(json.dumps({"dlc_dir": str(dlc_dir)}))
        result = mod._get_dlc_dir()
        assert result == dlc_dir
    finally:
        conn = getattr(getattr(mod, "meta_db", None), "conn", None)
        if conn is not None:
            conn.close()


def test_get_dlc_dir_env_takes_precedence(tmp_path, monkeypatch):
    """When DLC_DIR env var points to a real directory, it wins over config.json."""
    env_dir = tmp_path / "env_dlc"
    env_dir.mkdir()
    cfg_dir = tmp_path / "cfg_dlc"
    cfg_dir.mkdir()

    monkeypatch.setenv("CONFIG_DIR", str(tmp_path))
    monkeypatch.setenv("DLC_DIR", str(env_dir))
    sys.modules.pop("server", None)
    mod = importlib.import_module("server")
    try:
        (tmp_path / "config.json").write_text(json.dumps({"dlc_dir": str(cfg_dir)}))
        result = mod._get_dlc_dir()
        assert result == env_dir
    finally:
        conn = getattr(getattr(mod, "meta_db", None), "conn", None)
        if conn is not None:
            conn.close()


def test_get_dlc_dir_env_dot_is_valid(tmp_path, monkeypatch):
    """An explicit DLC_DIR=. treats the current directory as the DLC folder."""
    monkeypatch.setenv("CONFIG_DIR", str(tmp_path))
    monkeypatch.setenv("DLC_DIR", ".")
    sys.modules.pop("server", None)
    mod = importlib.import_module("server")
    try:
        result = mod._get_dlc_dir()
        # "." resolves to cwd which exists as a directory
        assert result is not None
        assert result.is_dir()
    finally:
        conn = getattr(getattr(mod, "meta_db", None), "conn", None)
        if conn is not None:
            conn.close()


def test_get_dlc_dir_returns_none_when_no_dir(tmp_path, server_module):
    """Returns None when both env and config.json lack a valid directory."""
    # No config.json → falls through to None
    result = server_module._get_dlc_dir()
    assert result is None


def test_get_dlc_dir_ignores_nonexistent_config_dir(tmp_path, server_module):
    """If config.json names a path that doesn't exist, returns None."""
    (tmp_path / "config.json").write_text(json.dumps({"dlc_dir": str(tmp_path / "no_such_dir")}))
    result = server_module._get_dlc_dir()
    assert result is None


# ── library scan fixtures ────────────────────────────────────────────────────

@pytest.fixture()
def scan_module(tmp_path, monkeypatch, isolate_logging):
    """Import server with CONFIG_DIR and DLC_DIR isolated in tmp_path.

    The background scan uses a `spawn` ProcessPoolExecutor in production
    (see server._make_scan_executor), whose workers run in fresh
    interpreters that an in-process mock.patch() can't reach. Override it
    with an in-process ThreadPoolExecutor so these tests can mock metadata
    extraction (on scan_worker, where the worker resolves it) and observe
    the resulting DB state.
    """
    import concurrent.futures
    monkeypatch.setenv("CONFIG_DIR", str(tmp_path))
    monkeypatch.delenv("DLC_DIR", raising=False)
    sys.modules.pop("server", None)
    mod = importlib.import_module("server")
    monkeypatch.setattr(
        mod, "_make_scan_executor",
        lambda: concurrent.futures.ThreadPoolExecutor(max_workers=4),
    )
    yield mod
    conn = getattr(getattr(mod, "meta_db", None), "conn", None)
    if conn is not None:
        conn.close()


def _make_sloppaks(dlc_dir, names):
    """Create empty .sloppak stub files and return Path objects.

    is_sloppak() keys on the .sloppak suffix, so empty stubs are enough for
    scan-listing tests where metadata extraction is mocked.
    """
    paths = []
    for name in names:
        p = dlc_dir / name
        p.write_bytes(b"")
        paths.append(p)
    return paths


# ── is_first_scan flag ───────────────────────────────────────────────────────

def test_is_first_scan_true_when_all_songs_unscanned(tmp_path, scan_module):
    """is_first_scan is True when every discovered song needs scanning."""
    dlc = tmp_path / "dlc"
    dlc.mkdir()
    _make_sloppaks(dlc, ["song_a.sloppak", "song_b.sloppak"])
    (tmp_path / "config.json").write_text(json.dumps({"dlc_dir": str(dlc)}))

    captured_status = {}

    import unittest.mock as mock

    def mock_extract(f, dlc):
        # Capture the scan status on the first call (during the scanning phase)
        if not captured_status:
            captured_status.update(scan_module._scan_status)
        return {"title": f.name, "artist": "", "album": ""}

    with mock.patch("scan_worker._extract_meta_for_file", new=mock_extract):
        scan_module._background_scan()

    assert captured_status.get("is_first_scan") is True


def test_is_first_scan_false_when_some_songs_cached(tmp_path, scan_module):
    """is_first_scan is False when only a subset of discovered songs need scanning."""
    dlc = tmp_path / "dlc"
    dlc.mkdir()
    files = _make_sloppaks(dlc, ["song_a.sloppak", "song_b.sloppak"])
    (tmp_path / "config.json").write_text(json.dumps({"dlc_dir": str(dlc)}))

    # Pre-populate the DB with song_a so only song_b needs scanning.
    stat_a = files[0].stat()
    scan_module.meta_db.put(
        "song_a.sloppak", stat_a.st_mtime, stat_a.st_size,
        {"title": "Song A", "artist": "", "album": ""},
    )

    captured_status = {}

    import unittest.mock as mock

    def mock_extract(f, dlc):
        if not captured_status:
            captured_status.update(scan_module._scan_status)
        return {"title": f.name, "artist": "", "album": ""}

    with mock.patch("scan_worker._extract_meta_for_file", new=mock_extract):
        scan_module._background_scan()

    assert captured_status.get("is_first_scan") is False


# ── TestClient lifespan coverage ─────────────────────────────────────────────
#
# The rest of this module drives settings handlers directly to keep tests fast
# and side-effect-free, but that bypass means the FastAPI route registration,
# request parsing, and lifespan/startup wiring would never get exercised. The
# tests below restore that coverage by going through a real `TestClient`, with
# `FEEDBACK_SKIP_STARTUP_TASKS=1` so plugin loading and the background scan
# don't reach for the user's filesystem.

def _snapshot_loaded_plugins():
    """Snapshot `plugins.LOADED_PLUGINS` so a test that triggers the
    skip-startup branch (which clears the registry) can restore it on
    teardown — otherwise the cleared state leaks to later tests that
    expect it to look as the importer left it."""
    import plugins as plugins_mod
    with plugins_mod.PLUGINS_LOCK:
        return list(plugins_mod.LOADED_PLUGINS)


def _restore_loaded_plugins(snapshot):
    import plugins as plugins_mod
    with plugins_mod.PLUGINS_LOCK:
        plugins_mod.LOADED_PLUGINS.clear()
        plugins_mod.LOADED_PLUGINS.extend(snapshot)


@pytest.fixture()
def api_client(tmp_path, monkeypatch, isolate_logging):
    """A real FastAPI TestClient against a fresh server import.

    Using `TestClient` as a context manager runs the lifespan/startup hook,
    which is the only place the skip-tasks branch is actually exercised.

    Pulls in `isolate_logging` from tests/conftest.py — the startup hook
    calls `configure_logging()`, which mutates global feedBack/uvicorn
    handlers and structlog defaults; without snapshot/restore those
    changes leak into later tests and the suite becomes order-dependent."""
    from fastapi.testclient import TestClient

    monkeypatch.setenv("CONFIG_DIR", str(tmp_path))
    monkeypatch.setenv("FEEDBACK_SKIP_STARTUP_TASKS", "1")
    sys.modules.pop("server", None)
    plugins_snapshot = _snapshot_loaded_plugins()
    server = importlib.import_module("server")
    try:
        with TestClient(server.app) as tc:
            yield tc, server
    finally:
        conn = getattr(getattr(server, "meta_db", None), "conn", None)
        if conn is not None:
            conn.close()
        _restore_loaded_plugins(plugins_snapshot)


def test_api_get_settings_via_testclient(api_client, tmp_path):
    """End-to-end smoke through the real /api/settings GET route."""
    tc, _server = api_client
    r = tc.get("/api/settings")
    assert r.status_code == 200
    assert isinstance(r.json(), dict)


def test_api_post_settings_via_testclient(api_client, tmp_path):
    """End-to-end smoke through the real /api/settings POST route."""
    tc, _server = api_client
    r = tc.post("/api/settings", json={"master_difficulty": 73})
    assert r.status_code == 200
    assert _read_cfg(tmp_path)["master_difficulty"] == 73


# Validation/rejection cases that the direct-call fixture covers
# extensively, but that we also want to pin at the route level — that's
# the only layer FastAPI request parsing / response serialization runs
# at, so an API-contract regression (e.g. a Pydantic model change that
# subtly alters how null or non-numeric values are handled) could pass
# the direct-call tests while breaking the real /api/settings clients.

@pytest.mark.parametrize(
    "payload",
    [
        {"master_difficulty": "abc"},
        {"master_difficulty": "1e309"},  # overflow past int range
        {"dlc_dir": 42},                  # non-string for path field
    ],
)
def test_api_post_settings_invalid_values_via_testclient(api_client, payload):
    """POSTing invalid values through the real route still returns 200
    with an `error` field (handler returns a dict rather than raising
    HTTPException), and doesn't 500 on the wire."""
    tc, _server = api_client
    r = tc.post("/api/settings", json=payload)
    assert r.status_code == 200
    body = r.json()
    assert "error" in body, body


def test_api_post_settings_null_string_is_noop_via_testclient(api_client, tmp_path):
    """null for a string-shaped key is a no-op at the API layer — the
    handler must merge the request without clearing the on-disk value."""
    (tmp_path / "config.json").write_text(json.dumps({"dlc_dir": "/existing/path"}))
    tc, _server = api_client
    r = tc.post("/api/settings", json={"dlc_dir": None, "master_difficulty": 50})
    assert r.status_code == 200
    assert _read_cfg(tmp_path)["dlc_dir"] == "/existing/path"
    assert _read_cfg(tmp_path)["master_difficulty"] == 50


def test_achievements_enabled_persists_and_validates(api_client, tmp_path):
    """The achievements-epic opt-in flag round-trips as a boolean and rejects
    non-bools at the route level (mirrors countdown_before_song)."""
    tc, _server = api_client
    r = tc.post("/api/settings", json={"achievements_enabled": True})
    assert r.status_code == 200
    assert _read_cfg(tmp_path)["achievements_enabled"] is True
    bad = tc.post("/api/settings", json={"achievements_enabled": "yes"})
    assert bad.status_code == 200 and "error" in bad.json()


def test_achievements_enabled_is_resettable(server_module):
    """The flag is in the resettable allow-list so a Reset clears it to default."""
    assert "achievements_enabled" in server_module._RESETTABLE_SETTINGS_KEYS


def test_skip_startup_tasks_drives_startup_to_complete(api_client):
    """With FEEDBACK_SKIP_STARTUP_TASKS set, the startup hook must:
      * skip plugin loading and the background scan,
      * leave the status in a terminal `complete` phase with running=False,
      * reset current_plugin/loaded/total so stale data from a prior import
        doesn't bleed into the skip branch.
    """
    _tc, server = api_client
    status = server._startup_status
    assert status["running"] is False
    assert status["phase"] == "complete"
    assert status["error"] is None
    assert status["current_plugin"] == ""
    assert status["loaded"] == 0
    assert status["total"] == 0


def test_skip_startup_tasks_does_not_call_load_plugins_or_scan(tmp_path, monkeypatch, isolate_logging):
    """Concrete contract check: with the skip flag set, the startup hook
    must not invoke `load_plugins` *or* `startup_scan`. The status
    assertions in `test_skip_startup_tasks_drives_startup_to_complete`
    only show the end state — they'd still pass if either ran and the
    status was reset, so they don't prove the skip path actually skipped.
    The background scan in particular doesn't touch _startup_status, so
    without a dedicated tripwire a regression here would be silent."""
    from fastapi.testclient import TestClient

    monkeypatch.setenv("CONFIG_DIR", str(tmp_path))
    monkeypatch.setenv("FEEDBACK_SKIP_STARTUP_TASKS", "1")
    sys.modules.pop("server", None)
    plugins_snapshot = _snapshot_loaded_plugins()
    server = importlib.import_module("server")

    load_calls: list[tuple] = []
    scan_calls: list[tuple] = []

    def _load_tripwire(*args, **kwargs):
        load_calls.append((args, kwargs))

    def _scan_tripwire(*args, **kwargs):
        scan_calls.append((args, kwargs))

    # Patch the names the startup hook resolves at call time. server.py
    # does `from plugins import load_plugins, ...`, and `startup_scan` is
    # defined in server.py itself — both end up bound on the server module
    # and that's what `@app.on_event("startup")` looks up.
    monkeypatch.setattr(server, "load_plugins", _load_tripwire)
    monkeypatch.setattr(server, "startup_scan", _scan_tripwire)

    try:
        with TestClient(server.app):
            pass
    finally:
        conn = getattr(getattr(server, "meta_db", None), "conn", None)
        if conn is not None:
            conn.close()
        _restore_loaded_plugins(plugins_snapshot)

    assert load_calls == [], f"load_plugins was invoked despite skip flag: {load_calls}"
    assert scan_calls == [], f"startup_scan was invoked despite skip flag: {scan_calls}"


def test_skip_startup_tasks_clears_stale_plugin_registry(tmp_path, monkeypatch, isolate_logging):
    """The plugins module is not re-imported when tests reload `server`, so
    LOADED_PLUGINS can carry stale entries from a previous test's startup.
    The skip branch must clear it so /api/plugins doesn't expose stale
    plugins despite reporting zero loaded plugins in the status."""
    from fastapi.testclient import TestClient

    monkeypatch.setenv("CONFIG_DIR", str(tmp_path))
    monkeypatch.setenv("FEEDBACK_SKIP_STARTUP_TASKS", "1")

    # Snapshot the registry as the importer left it so we can restore it
    # after this test mutates it — otherwise the cleared state would leak
    # to any later test that imports `plugins`.
    plugins_snapshot = _snapshot_loaded_plugins()
    server = None

    try:
        # Pre-seed plugins.LOADED_PLUGINS with a fake entry from a
        # "previous run". The try/finally wraps this mutation so that even
        # if the subsequent server import raises, the sentinel doesn't
        # leak into later tests.
        import plugins as plugins_mod
        sentinel = {"id": "stale.previous-run", "name": "stale"}
        with plugins_mod.PLUGINS_LOCK:
            plugins_mod.LOADED_PLUGINS.clear()
            plugins_mod.LOADED_PLUGINS.append(sentinel)

        sys.modules.pop("server", None)
        server = importlib.import_module("server")

        with TestClient(server.app):
            pass
        # After the skip branch runs, the stale entry must be gone.
        assert sentinel not in plugins_mod.LOADED_PLUGINS
        assert plugins_mod.LOADED_PLUGINS == []
    finally:
        conn = getattr(getattr(server, "meta_db", None), "conn", None) if server else None
        if conn is not None:
            conn.close()
        _restore_loaded_plugins(plugins_snapshot)


# ── v0.3.0 gameplay settings (tabbed settings page) ─────────────────────────

def test_countdown_before_song_persists_bool(client, tmp_path):
    r = client.post("/api/settings", json={"countdown_before_song": True})
    assert r.status_code == 200
    assert _read_cfg(tmp_path)["countdown_before_song"] is True
    client.post("/api/settings", json={"countdown_before_song": False})
    assert _read_cfg(tmp_path)["countdown_before_song"] is False


@pytest.mark.parametrize("bad_value", [1, 0, "true", "yes", [], {}])
def test_countdown_before_song_rejects_non_bool(client, tmp_path, bad_value):
    (tmp_path / "config.json").write_text(json.dumps({"countdown_before_song": True}))
    r = client.post("/api/settings", json={"countdown_before_song": bad_value})
    assert "error" in r.json()
    # Previous value preserved on bad input.
    assert _read_cfg(tmp_path)["countdown_before_song"] is True


@pytest.mark.parametrize("key,good,bad", [
    ("miss_penalty", "high", "extreme"),
    ("fail_behavior", "restart", "explode"),
])
def test_enum_settings_validate(client, tmp_path, key, good, bad):
    r = client.post("/api/settings", json={key: good})
    assert r.status_code == 200
    assert _read_cfg(tmp_path)[key] == good
    # Bad enum value is rejected and doesn't clobber the persisted good one.
    r = client.post("/api/settings", json={key: bad})
    assert "error" in r.json()
    assert _read_cfg(tmp_path)[key] == good


def test_defaults_include_gameplay_keys(client, tmp_path):
    # Fresh install (no config.json) — GET should expose the new keys at their
    # neutral defaults so the frontend hydrates predictably.
    data = client.get("/api/settings").json()
    assert data["countdown_before_song"] is False
    assert data["miss_penalty"] == "none"
    assert data["fail_behavior"] == "continue"


# ── /api/settings/reset ─────────────────────────────────────────────────────

def test_reset_clears_requested_keys(client, tmp_path):
    (tmp_path / "config.json").write_text(json.dumps({
        "master_difficulty": 40,
        "countdown_before_song": True,
        "default_arrangement": "Lead",
        "demucs_server_url": "http://demucs.example:9000",
    }))
    r = client.post("/api/settings/reset",
                    json={"keys": ["master_difficulty", "countdown_before_song"]})
    assert r.status_code == 200
    body = r.json()
    assert set(body["reset"]) == {"master_difficulty", "countdown_before_song"}
    cfg = _read_cfg(tmp_path)
    # Reset removes the key so GET falls back to the default.
    assert "master_difficulty" not in cfg
    assert "countdown_before_song" not in cfg
    # Unlisted keys are untouched.
    assert cfg["default_arrangement"] == "Lead"
    assert cfg["demucs_server_url"] == "http://demucs.example:9000"


def test_reset_ignores_unknown_keys(client, tmp_path):
    (tmp_path / "config.json").write_text(json.dumps({"master_difficulty": 40}))
    # Unknown / non-resettable keys are silently ignored, not an error, and
    # can't be used to delete arbitrary config.
    r = client.post("/api/settings/reset",
                    json={"keys": ["dlc_dir", "not_a_real_key", "master_difficulty"]})
    assert r.status_code == 200
    assert r.json()["reset"] == ["master_difficulty"]
    assert "master_difficulty" not in _read_cfg(tmp_path)


def test_reset_bad_body_returns_error(client, tmp_path):
    r = client.post("/api/settings/reset", json={"keys": "master_difficulty"})
    assert "error" in r.json()


def test_reset_with_no_config_is_noop(client, tmp_path):
    # No config.json yet — already at defaults, nothing to remove.
    r = client.post("/api/settings/reset", json={"keys": ["master_difficulty"]})
    assert r.status_code == 200
    assert r.json()["reset"] == []
