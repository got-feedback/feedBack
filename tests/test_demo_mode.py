"""Tests for FEEDBACK_DEMO_MODE middleware.

Covers:
- Demo mode off: write routes pass through (middleware is a no-op).
- Demo mode on: selected entries from _DEMO_BLOCKED return 403 {"error": "demo mode: read-only"}.
- Demo mode on: first GET / sets the feedBack_demo_session cookie.
- Demo mode on: subsequent GET / (cookie already present) does not re-set it.
- Cookie secure flag: set when X-Forwarded-Proto indicates https, including comma-separated values.
- register_demo_janitor_hook: registered hooks are called by the janitor sweep.
- register_demo_janitor_hook: non-callables are rejected with TypeError.
- register_demo_janitor_hook: async (coroutine) functions are rejected with TypeError.
- register_demo_janitor_hook: callables with required arguments are rejected with TypeError.
- register_demo_janitor_hook: present in the plugin context dict passed to load_plugins.
"""

import importlib
import sys

import pytest
from fastapi.testclient import TestClient


def _make_client(tmp_path, monkeypatch, *, demo: bool = False):
    """Return a (server_module, TestClient) pair isolated in tmp_path.

    The TestClient is returned open; caller is responsible for closing it.
    raise_server_exceptions defaults to True so unexpected server errors
    surface as test failures rather than silently passing status checks.
    FEEDBACK_SYNC_STARTUP=1 makes the plugin-loader run inline (no background
    thread spawned), consistent with tests/test_startup_status.py.  startup_scan
    and load_plugins are also stubbed to no-ops so background file-scan and
    plugin I/O are suppressed.
    """
    monkeypatch.setenv("CONFIG_DIR", str(tmp_path))
    monkeypatch.setenv("FEEDBACK_SYNC_STARTUP", "1")
    if demo:
        monkeypatch.setenv("FEEDBACK_DEMO_MODE", "1")
    else:
        monkeypatch.delenv("FEEDBACK_DEMO_MODE", raising=False)
    sys.modules.pop("server", None)
    server = importlib.import_module("server")
    # Stub out background threads to keep tests fast and non-flaky.
    monkeypatch.setattr(server, "startup_scan", lambda: None)
    monkeypatch.setattr(server, "load_plugins", lambda app, context, progress_cb=None, route_setup_fn=None: None)
    client = TestClient(server.app, raise_server_exceptions=True)
    return server, client


def _cleanup(server, client):
    client.close()
    # Stop the demo-mode janitor thread (if started) so daemon threads don't
    # accumulate across tests.
    server._DEMO_JANITOR_STOP.set()
    thread = server._DEMO_JANITOR_THREAD
    if thread is not None:
        thread.join(timeout=2)
    server._DEMO_JANITOR_STARTED = False
    server._DEMO_JANITOR_THREAD = None
    with server._DEMO_JANITOR_HOOKS_LOCK:
        server._DEMO_JANITOR_HOOKS.clear()
    conn = getattr(getattr(server, "meta_db", None), "conn", None)
    if conn is not None:
        conn.close()


# ── Demo mode OFF: write routes are not blocked ───────────────────────────────

def test_demo_off_settings_post_not_blocked(tmp_path, monkeypatch):
    server, client = _make_client(tmp_path, monkeypatch, demo=False)
    try:
        r = client.post("/api/settings", json={"master_difficulty": 50})
        assert r.status_code == 200
    finally:
        _cleanup(server, client)


# ── Demo mode ON: blocked routes return 403 ───────────────────────────────────

@pytest.mark.parametrize("method,path", [
    ("POST",   "/api/settings"),
    ("POST",   "/api/settings/import"),
    ("POST",   "/api/rescan"),
    ("POST",   "/api/rescan/full"),
    ("POST",   "/api/favorites/toggle"),
    ("POST",   "/api/loops"),
    ("DELETE", "/api/loops/some-id"),
    ("POST",   "/api/audio-effects/mappings"),
    ("DELETE", "/api/audio-effects/mappings/some-id"),
    ("POST",   "/api/audio-effects/mappings/some-id/activate"),
    ("DELETE", "/api/audio-effects/active-mapping"),
    ("GET",    "/api/plugins/updates"),
    ("POST",   "/api/plugins/highway_3d/files"),
    ("DELETE", "/api/plugins/highway_3d/files"),
])
def test_demo_on_blocked_routes_return_403(tmp_path, monkeypatch, method, path):
    server, client = _make_client(tmp_path, monkeypatch, demo=True)
    try:
        r = client.request(method, path)
        assert r.status_code == 403
        assert r.json() == {"error": "demo mode: read-only"}
    finally:
        _cleanup(server, client)


def test_demo_on_read_routes_not_blocked(tmp_path, monkeypatch):
    """Safe read routes must still work in demo mode."""
    server, client = _make_client(tmp_path, monkeypatch, demo=True)
    try:
        r = client.get("/api/settings")
        assert r.status_code == 200
    finally:
        _cleanup(server, client)


# ── Demo cookie: set on first GET /, not on subsequent requests ───────────────

def test_demo_cookie_set_on_first_get_root(tmp_path, monkeypatch):
    server, client = _make_client(tmp_path, monkeypatch, demo=True)
    try:
        r = client.get("/")
        assert "feedBack_demo_session" in r.cookies
    finally:
        _cleanup(server, client)


def test_demo_cookie_not_reset_when_already_present(tmp_path, monkeypatch):
    server, client = _make_client(tmp_path, monkeypatch, demo=True)
    try:
        # First request sets the cookie.
        r1 = client.get("/")
        session_id = r1.cookies.get("feedBack_demo_session")
        assert session_id is not None

        # Second request (cookie already in jar) must not overwrite it.
        r2 = client.get("/", cookies={"feedBack_demo_session": session_id})
        # The Set-Cookie header for our cookie must be absent.
        set_cookie = r2.headers.get("set-cookie", "")
        assert "feedBack_demo_session" not in set_cookie
    finally:
        _cleanup(server, client)


def test_demo_cookie_not_set_in_non_demo_mode(tmp_path, monkeypatch):
    server, client = _make_client(tmp_path, monkeypatch, demo=False)
    try:
        r = client.get("/")
        assert "feedBack_demo_session" not in r.cookies
    finally:
        _cleanup(server, client)


# ── Cookie secure flag ────────────────────────────────────────────────────────

def test_demo_cookie_not_secure_over_http(tmp_path, monkeypatch):
    server, client = _make_client(tmp_path, monkeypatch, demo=True)
    try:
        r = client.get("/")
        set_cookie = r.headers.get("set-cookie", "")
        # The cookie must be present but without the Secure attribute.
        assert "feedBack_demo_session" in set_cookie
        assert "secure" not in set_cookie.lower()
    finally:
        _cleanup(server, client)


def test_demo_cookie_secure_over_https_via_forwarded_proto(tmp_path, monkeypatch):
    server, client = _make_client(tmp_path, monkeypatch, demo=True)
    try:
        r = client.get("/", headers={"x-forwarded-proto": "https"})
        set_cookie = r.headers.get("set-cookie", "")
        assert "feedBack_demo_session" in set_cookie
        assert "secure" in set_cookie.lower()
    finally:
        _cleanup(server, client)


def test_demo_cookie_secure_with_comma_separated_forwarded_proto(tmp_path, monkeypatch):
    """Proxies sometimes send 'https,http'; first value must win."""
    server, client = _make_client(tmp_path, monkeypatch, demo=True)
    try:
        r = client.get("/", headers={"x-forwarded-proto": "https,http"})
        set_cookie = r.headers.get("set-cookie", "")
        assert "feedBack_demo_session" in set_cookie
        assert "secure" in set_cookie.lower()
    finally:
        _cleanup(server, client)


def test_demo_cookie_not_secure_when_forwarded_proto_is_http(tmp_path, monkeypatch):
    """x-forwarded-proto: http must not trigger Secure."""
    server, client = _make_client(tmp_path, monkeypatch, demo=True)
    try:
        r = client.get("/", headers={"x-forwarded-proto": "http"})
        set_cookie = r.headers.get("set-cookie", "")
        assert "feedBack_demo_session" in set_cookie
        assert "secure" not in set_cookie.lower()
    finally:
        _cleanup(server, client)


# ── register_demo_janitor_hook ────────────────────────────────────────────────

def test_register_demo_janitor_hook_is_callable(tmp_path, monkeypatch):
    """register_demo_janitor_hook must exist and accept a callable."""
    server, client = _make_client(tmp_path, monkeypatch, demo=True)
    try:
        called = []
        server.register_demo_janitor_hook(lambda: called.append(1))
        # Manually invoke the registered hooks (simulating a janitor sweep).
        for hook in list(server._DEMO_JANITOR_HOOKS):
            hook()
        assert 1 in called
    finally:
        # Clean up our test hook so it doesn't leak into other tests.
        with server._DEMO_JANITOR_HOOKS_LOCK:
            server._DEMO_JANITOR_HOOKS.clear()
        _cleanup(server, client)


def test_register_demo_janitor_hook_rejects_non_callable(tmp_path, monkeypatch):
    """Passing a non-callable must raise TypeError immediately at registration."""
    server, client = _make_client(tmp_path, monkeypatch, demo=True)
    try:
        with pytest.raises(TypeError):
            server.register_demo_janitor_hook("not a function")
    finally:
        _cleanup(server, client)


def test_register_demo_janitor_hook_rejects_async_callable(tmp_path, monkeypatch):
    """Async functions must be rejected: the janitor cannot await coroutines."""
    server, client = _make_client(tmp_path, monkeypatch, demo=True)
    try:
        async def _async_hook():
            pass

        with pytest.raises(TypeError, match="async"):
            server.register_demo_janitor_hook(_async_hook)
    finally:
        _cleanup(server, client)


def test_register_demo_janitor_hook_rejects_non_zero_arg_callable(tmp_path, monkeypatch):
    """Callables with required arguments must be rejected at registration time."""
    server, client = _make_client(tmp_path, monkeypatch, demo=True)
    try:
        def _needs_arg(x):
            pass

        with pytest.raises(TypeError, match="zero-argument"):
            server.register_demo_janitor_hook(_needs_arg)
    finally:
        _cleanup(server, client)


def test_register_demo_janitor_hook_accepts_default_arg_callable(tmp_path, monkeypatch):
    """Callables with only default/optional arguments must be accepted."""
    server, client = _make_client(tmp_path, monkeypatch, demo=True)
    try:
        def _optional_arg(x=None):
            pass

        server.register_demo_janitor_hook(_optional_arg)
    finally:
        with server._DEMO_JANITOR_HOOKS_LOCK:
            server._DEMO_JANITOR_HOOKS.clear()
        _cleanup(server, client)


def test_register_demo_janitor_hook_in_plugin_context(tmp_path, monkeypatch):
    """register_demo_janitor_hook must be surfaced in the plugin context dict
    passed to load_plugins(), not just on the server module."""
    monkeypatch.setenv("CONFIG_DIR", str(tmp_path))
    monkeypatch.setenv("FEEDBACK_DEMO_MODE", "1")
    monkeypatch.setenv("FEEDBACK_SYNC_STARTUP", "1")
    sys.modules.pop("server", None)
    server = importlib.import_module("server")

    captured: dict = {}

    def _capturing_load_plugins(app, context, **kw):
        captured.update(context)
        # Do NOT call the real loader — we only care that the context dict
        # contains the expected key; running the real loader would trigger pip
        # installs and filesystem scanning, making the test slow/flaky.
        return None

    monkeypatch.setattr(server, "load_plugins", _capturing_load_plugins)
    monkeypatch.setattr(server, "startup_scan", lambda: None)

    with TestClient(server.app):
        assert "register_demo_janitor_hook" in captured, (
            "register_demo_janitor_hook was not passed in the plugin context"
        )
        assert captured["register_demo_janitor_hook"] is server.register_demo_janitor_hook

    conn = getattr(getattr(server, "meta_db", None), "conn", None)
    if conn is not None:
        conn.close()
    # Clean up janitor state so it doesn't bleed into other tests.
    server._DEMO_JANITOR_STOP.set()
    thread = server._DEMO_JANITOR_THREAD
    if thread is not None:
        thread.join(timeout=2)
    server._DEMO_JANITOR_STARTED = False
    server._DEMO_JANITOR_THREAD = None
    with server._DEMO_JANITOR_HOOKS_LOCK:
        server._DEMO_JANITOR_HOOKS.clear()



@pytest.mark.parametrize("method,path", [
    ("POST", "/api/diagnostics/export"),
    ("GET",  "/api/diagnostics/preview"),
    ("GET",  "/api/diagnostics/hardware"),
])
def test_demo_on_diagnostics_routes_blocked(tmp_path, monkeypatch, method, path):
    """Diagnostics endpoints must return 403 in demo mode."""
    server, client = _make_client(tmp_path, monkeypatch, demo=True)
    try:
        r = client.request(method, path)
        assert r.status_code == 403
        assert r.json() == {"error": "demo mode: read-only"}
    finally:
        _cleanup(server, client)


def test_diag_normalize_include_string_false_treated_as_disabled(tmp_path, monkeypatch):
    """String 'false' must be treated as disabled, not truthy."""
    server, client = _make_client(tmp_path, monkeypatch, demo=False)
    try:
        result = server._diag_normalize_include({"logs": "false", "system": "true"})
        assert result["logs"] is False
        assert result["system"] is True
    finally:
        _cleanup(server, client)


def test_diag_normalize_include_string_zero_treated_as_disabled(tmp_path, monkeypatch):
    """String '0' must be treated as disabled."""
    server, client = _make_client(tmp_path, monkeypatch, demo=False)
    try:
        result = server._diag_normalize_include({"console": "0", "hardware": "1"})
        assert result["console"] is False
        assert result["hardware"] is True
    finally:
        _cleanup(server, client)


def test_diag_normalize_include_missing_keys_default_true(tmp_path, monkeypatch):
    """Missing keys must default to True so a bare {} request exports everything."""
    server, client = _make_client(tmp_path, monkeypatch, demo=False)
    try:
        result = server._diag_normalize_include({})
        for key in ("system", "hardware", "logs", "console", "plugins"):
            assert result[key] is True
    finally:
        _cleanup(server, client)


def test_diag_normalize_include_none_returns_all_true(tmp_path, monkeypatch):
    """None input must default to all-True."""
    server, client = _make_client(tmp_path, monkeypatch, demo=False)
    try:
        result = server._diag_normalize_include(None)
        for key in ("system", "hardware", "logs", "console", "plugins"):
            assert result[key] is True
    finally:
        _cleanup(server, client)


def test_diag_coerce_bool_string_false(tmp_path, monkeypatch):
    """_diag_coerce_bool must treat string 'false' as False so the export
    endpoint handles { "redact": "false" } correctly."""
    server, client = _make_client(tmp_path, monkeypatch, demo=False)
    try:
        assert server._diag_coerce_bool("false") is False
        assert server._diag_coerce_bool("False") is False
        assert server._diag_coerce_bool("0") is False
        assert server._diag_coerce_bool("no") is False
        assert server._diag_coerce_bool("") is False
    finally:
        _cleanup(server, client)


def test_diag_coerce_bool_truthy_values(tmp_path, monkeypatch):
    """_diag_coerce_bool must treat 'true', '1', True, and arbitrary objects
    as True."""
    server, client = _make_client(tmp_path, monkeypatch, demo=False)
    try:
        assert server._diag_coerce_bool(True) is True
        assert server._diag_coerce_bool("true") is True
        assert server._diag_coerce_bool("1") is True
        assert server._diag_coerce_bool("yes") is True
        assert server._diag_coerce_bool(1) is True
    finally:
        _cleanup(server, client)


def test_diag_coerce_bool_none_uses_default(tmp_path, monkeypatch):
    """_diag_coerce_bool(None) must return the supplied default."""
    server, client = _make_client(tmp_path, monkeypatch, demo=False)
    try:
        assert server._diag_coerce_bool(None, default=True) is True
        assert server._diag_coerce_bool(None, default=False) is False
    finally:
        _cleanup(server, client)


def test_diag_cap_console_truncates_to_limit(tmp_path, monkeypatch):
    """_diag_cap_console must return a list truncated to _DIAG_MAX_CONSOLE_ENTRIES."""
    server, client = _make_client(tmp_path, monkeypatch, demo=False)
    try:
        limit = server._DIAG_MAX_CONSOLE_ENTRIES
        big_list = [{"msg": f"entry {i}"} for i in range(limit + 100)]
        result = server._diag_cap_console(big_list)
        assert isinstance(result, list)
        assert len(result) == limit
        assert result[0] == {"msg": "entry 0"}
    finally:
        _cleanup(server, client)


def test_diag_cap_console_accepts_list_within_limit(tmp_path, monkeypatch):
    """_diag_cap_console must pass through a short list unchanged."""
    server, client = _make_client(tmp_path, monkeypatch, demo=False)
    try:
        short = [{"msg": "hi"}] * 5
        assert server._diag_cap_console(short) == short
    finally:
        _cleanup(server, client)


def test_diag_cap_console_rejects_non_list(tmp_path, monkeypatch):
    """_diag_cap_console must return None for non-list inputs."""
    server, client = _make_client(tmp_path, monkeypatch, demo=False)
    try:
        assert server._diag_cap_console("not a list") is None
        assert server._diag_cap_console({"a": 1}) is None
        assert server._diag_cap_console(None) is None
    finally:
        _cleanup(server, client)


def test_diag_cap_dict_rejects_oversized_payload(tmp_path, monkeypatch):
    """_diag_cap_dict must return None when the serialised dict exceeds the byte cap."""
    server, client = _make_client(tmp_path, monkeypatch, demo=False)
    try:
        limit = server._DIAG_MAX_CLIENT_PAYLOAD_BYTES
        # Build a dict whose JSON representation exceeds the cap.
        big_dict = {"k": "x" * (limit + 1)}
        assert server._diag_cap_dict(big_dict) is None
    finally:
        _cleanup(server, client)


def test_diag_cap_dict_accepts_dict_within_limit(tmp_path, monkeypatch):
    """_diag_cap_dict must pass through a small dict unchanged."""
    server, client = _make_client(tmp_path, monkeypatch, demo=False)
    try:
        small = {"renderer": "Intel Iris Xe", "vram_mb": 4096}
        assert server._diag_cap_dict(small) == small
    finally:
        _cleanup(server, client)


def test_diag_cap_dict_rejects_non_dict(tmp_path, monkeypatch):
    """_diag_cap_dict must return None for non-dict inputs."""
    server, client = _make_client(tmp_path, monkeypatch, demo=False)
    try:
        assert server._diag_cap_dict([1, 2, 3]) is None
        assert server._diag_cap_dict("string") is None
        assert server._diag_cap_dict(None) is None
    finally:
        _cleanup(server, client)


def test_diag_cap_contributions_drops_oversized_plugin(tmp_path, monkeypatch):
    """_diag_cap_contributions must drop only the oversized plugin, not others."""
    server, client = _make_client(tmp_path, monkeypatch, demo=False)
    try:
        limit = server._DIAG_MAX_CLIENT_PAYLOAD_BYTES
        big_payload = {"data": "x" * (limit + 1)}
        small_payload = {"active_preset": "rock"}
        result = server._diag_cap_contributions({
            "big_plugin": big_payload,
            "small_plugin": small_payload,
        })
        assert result is not None
        assert "big_plugin" not in result, "Oversized plugin must be dropped"
        assert result["small_plugin"] == small_payload
    finally:
        _cleanup(server, client)


def test_diag_cap_contributions_returns_none_for_non_dict(tmp_path, monkeypatch):
    """_diag_cap_contributions must return None for non-dict inputs."""
    server, client = _make_client(tmp_path, monkeypatch, demo=False)
    try:
        assert server._diag_cap_contributions(None) is None
        assert server._diag_cap_contributions([{"a": 1}]) is None
        assert server._diag_cap_contributions("string") is None
    finally:
        _cleanup(server, client)


def test_diag_cap_contributions_returns_none_when_all_dropped(tmp_path, monkeypatch):
    """_diag_cap_contributions must return None when every plugin is dropped."""
    server, client = _make_client(tmp_path, monkeypatch, demo=False)
    try:
        limit = server._DIAG_MAX_CLIENT_PAYLOAD_BYTES
        result = server._diag_cap_contributions({
            "p1": {"data": "x" * (limit + 1)},
            "p2": {"data": "y" * (limit + 1)},
        })
        assert result is None
    finally:
        _cleanup(server, client)


def test_diag_cap_contributions_passes_small_plugins_through(tmp_path, monkeypatch):
    """_diag_cap_contributions must pass through all plugins that fit."""
    server, client = _make_client(tmp_path, monkeypatch, demo=False)
    try:
        contribs = {"p1": {"x": 1}, "p2": {"y": 2}}
        result = server._diag_cap_contributions(contribs)
        assert result == contribs
    finally:
        _cleanup(server, client)


def test_diag_cap_contributions_filters_unknown_plugin_ids(tmp_path, monkeypatch):
    """_diag_cap_contributions must skip plugins not in known_ids before serialising."""
    server, client = _make_client(tmp_path, monkeypatch, demo=False)
    try:
        result = server._diag_cap_contributions(
            {"known_plugin": {"data": "ok"}, "unknown_plugin": {"data": "secret"}},
            known_ids={"known_plugin"},
        )
        assert result is not None
        assert "known_plugin" in result
        assert "unknown_plugin" not in result, "Unknown plugin must be dropped before serialisation"
    finally:
        _cleanup(server, client)


def test_diag_cap_contributions_known_ids_none_accepts_all(tmp_path, monkeypatch):
    """When known_ids is None, all plugins are accepted (no filter applied)."""
    server, client = _make_client(tmp_path, monkeypatch, demo=False)
    try:
        contribs = {"any_plugin": {"x": 1}, "another_plugin": {"y": 2}}
        result = server._diag_cap_contributions(contribs, known_ids=None)
        assert result == contribs
    finally:
        _cleanup(server, client)


def test_diag_cap_contributions_aggregate_cap_enforced(tmp_path, monkeypatch):
    """_diag_cap_contributions must stop accepting plugins once the aggregate byte
    budget is exhausted, rather than accepting all near-limit entries."""
    server, client = _make_client(tmp_path, monkeypatch, demo=False)
    try:
        # Each per-plugin payload is just under the per-plugin cap.
        per_limit = server._DIAG_MAX_CLIENT_PAYLOAD_BYTES
        agg_limit = server._DIAG_MAX_CONTRIBUTIONS_BYTES
        # payload that is slightly under per_limit but together fills agg_limit.
        # The contribution {"data": big} serialises to payload_size + 11 bytes
        # (the JSON envelope `{"data":"..."}` adds 11 bytes), so we need
        # payload_size <= per_limit - 11; use -100 for a safe margin.
        payload_size = per_limit - 100
        big = "x" * payload_size
        # How many plugins would exceed the aggregate limit?
        n_plugins = (agg_limit // payload_size) + 5
        contribs = {f"p{i}": {"data": big} for i in range(n_plugins)}
        result = server._diag_cap_contributions(contribs)
        # Result must be non-None (some plugins fit) but fewer than n_plugins.
        assert result is not None
        assert len(result) < n_plugins, (
            "Aggregate cap must prevent all near-limit plugins from being accepted"
        )
    finally:
        _cleanup(server, client)


def test_diag_cap_console_enforces_byte_cap(tmp_path, monkeypatch):
    """_diag_cap_console must stop accumulating entries once the byte budget is
    reached, even when the entry count is still below _DIAG_MAX_CONSOLE_ENTRIES."""
    server, client = _make_client(tmp_path, monkeypatch, demo=False)
    try:
        byte_limit = server._DIAG_MAX_CONSOLE_BYTES
        # Each entry is 1 KB; create enough to exceed the byte cap long before
        # the count cap kicks in.
        entry = {"level": "log", "msg": "x" * 1024}
        n = (byte_limit // 1024) + 100
        result = server._diag_cap_console([entry] * n)
        assert isinstance(result, list)
        assert len(result) < n, "Byte cap must truncate entries before count cap"
    finally:
        _cleanup(server, client)

