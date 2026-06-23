"""Tests for GET /api/startup-status — shape, field types, and the
_set_startup_status / _get_startup_status state helpers introduced in
the async plugin-loading PR (feedBack#115).
"""

import importlib
import json
import sys
import threading
import time
import asyncio

import httpx
import pytest
from fastapi.testclient import TestClient

# ── Fake load_plugins event sequences ────────────────────────────────────────

# Events emitted by a single-plugin successful load (mirrors the real loader).
_FAKE_SUCCESS_EVENTS = [
    {"phase": "plugins-discovered", "message": "Discovered 1 plugin(s)", "plugin_id": "", "loaded": 0, "total": 1},
    {"phase": "plugin-start", "message": "Loading plugin 'demo'", "plugin_id": "demo", "loaded": 0, "total": 1},
    {"phase": "plugin-requirements", "message": "Installing requirements for 'demo' (if needed)", "plugin_id": "demo", "loaded": 0, "total": 1},
    {"phase": "plugin-routes", "message": "Loading routes for 'demo'", "plugin_id": "demo", "loaded": 0, "total": 1},
    {"phase": "plugin-registered", "message": "Registered plugin 'demo'", "plugin_id": "demo", "loaded": 1, "total": 1},
    {"phase": "plugins-complete", "message": "Loaded 1 plugin(s)", "plugin_id": "", "loaded": 1, "total": 1},
]

# Error text and events for a single-plugin requirements failure.
# Mirrors the REAL loader sequence from plugins/__init__.py:522-660:
# - plugin-requirements is always emitted before the req_ok check
# - plugin-error is emitted when req_ok is False
# - execution continues: plugin-routes (if routes declared), plugin-registered, plugins-complete
# The "bad" plugin below has no routes file, so no plugin-routes event.
# Including the post-error events ensures the test catches any regression that
# accidentally clears status.error in those follow-up non-error events.
_FAKE_PLUGIN_ERROR_TEXT = "Requirements installation failed"
_FAKE_PLUGIN_ERROR_EVENTS = [
    {"phase": "plugins-discovered", "message": "Discovered 1 plugin(s)", "plugin_id": "", "loaded": 0, "total": 1},
    {"phase": "plugin-start", "message": "Loading plugin 'bad'", "plugin_id": "bad", "loaded": 0, "total": 1},
    {"phase": "plugin-requirements", "message": "Installing requirements for 'bad' (if needed)", "plugin_id": "bad", "loaded": 0, "total": 1},
    {"phase": "plugin-error", "message": "Failed to install requirements for 'bad'",
     "plugin_id": "bad", "loaded": 0, "total": 1, "error": _FAKE_PLUGIN_ERROR_TEXT},
    # Real loader continues after requirements failure: registers the plugin and completes.
    {"phase": "plugin-registered", "message": "Registered plugin 'bad'", "plugin_id": "bad", "loaded": 1, "total": 1},
    {"phase": "plugins-complete", "message": "Loaded 1 plugin(s)", "plugin_id": "", "loaded": 1, "total": 1},
]


@pytest.fixture()
def client(tmp_path, monkeypatch, isolate_logging):
    """TestClient with CONFIG_DIR isolated in a per-test tmp_path.

    FEEDBACK_SYNC_STARTUP=1 makes the plugin-loader run synchronously
    inside startup_events() so startup is complete before TestClient.__enter__
    returns — no threading races, no polling.  load_plugins is still stubbed
    to a no-op so the "load" takes microseconds and startup_scan is also
    suppressed to avoid unrelated background I/O during tests.
    """
    monkeypatch.setenv("CONFIG_DIR", str(tmp_path))
    monkeypatch.setenv("FEEDBACK_SYNC_STARTUP", "1")
    sys.modules.pop("server", None)
    server = importlib.import_module("server")
    # Stub out the two background callables that call _set_startup_status.
    # Patching at the function level (not threading.Thread) leaves TestClient
    # and AnyIO free to create real threads for their own internal use.
    monkeypatch.setattr(server, "load_plugins", lambda *a, **kw: None)
    monkeypatch.setattr(server, "startup_scan", lambda: None)
    with TestClient(server.app) as test_client:
        # With FEEDBACK_SYNC_STARTUP the loader ran inline during startup, so
        # the status must already be complete.  Poll briefly as a safety net in
        # case something unexpected deferred the update.
        deadline = time.monotonic() + 5.0
        while time.monotonic() < deadline:
            if not server._get_startup_status().get("running", True):
                break
            time.sleep(0.01)
        last_status = server._get_startup_status()
        assert not last_status.get("running", True), (
            f"Background startup thread did not complete within 5 s; "
            f"last status: {last_status}"
        )
        try:
            yield test_client, server
        finally:
            conn = getattr(getattr(server, "meta_db", None), "conn", None)
            if conn is not None:
                conn.close()


@pytest.fixture()
def startup_harness(tmp_path, monkeypatch, isolate_logging):
    """Shared setup/teardown harness for startup_events() transition tests.

    Yields (server_module, phases_list):
    - server_module: freshly imported server with startup_scan stubbed and
      _set_startup_status wired to record every phase transition.
    - phases_list: accumulates the `phase` field of every _set_startup_status
      call so tests can assert the exact sequence.

    Teardown stops the demo-janitor thread (if accidentally started) and
    closes the meta_db connection.
    """
    monkeypatch.setenv("CONFIG_DIR", str(tmp_path))
    monkeypatch.setenv("FEEDBACK_SYNC_STARTUP", "1")
    monkeypatch.delenv("FEEDBACK_DEMO_MODE", raising=False)
    sys.modules.pop("server", None)
    server = importlib.import_module("server")
    monkeypatch.setattr(server, "startup_scan", lambda: None)

    phases = []
    original_set = server._set_startup_status

    def recording_set(**updates):
        original_set(**updates)
        phases.append(server._get_startup_status()["phase"])

    monkeypatch.setattr(server, "_set_startup_status", recording_set)

    yield server, phases

    server._DEMO_JANITOR_STOP.set()
    thread = server._DEMO_JANITOR_THREAD
    if thread is not None:
        thread.join(timeout=2)
    server._DEMO_JANITOR_STARTED = False
    server._DEMO_JANITOR_THREAD = None
    conn = getattr(getattr(server, "meta_db", None), "conn", None)
    if conn is not None:
        conn.close()


# ── /api/startup-status endpoint ─────────────────────────────────────────────

def test_startup_status_returns_200(client):
    tc, _ = client
    r = tc.get("/api/startup-status")
    assert r.status_code == 200


def test_startup_status_response_has_expected_keys(client):
    tc, _ = client
    data = tc.get("/api/startup-status").json()
    for key in ("running", "phase", "message", "current_plugin", "loaded", "total", "error"):
        assert key in data, f"Missing key '{key}' in /api/startup-status response"


def test_startup_status_field_types(client):
    tc, _ = client
    data = tc.get("/api/startup-status").json()
    assert isinstance(data["running"], bool)
    assert isinstance(data["phase"], str)
    assert isinstance(data["message"], str)
    assert isinstance(data["current_plugin"], str)
    assert isinstance(data["loaded"], int)
    assert isinstance(data["total"], int)
    # error is either None (JSON null) or a string
    assert data["error"] is None or isinstance(data["error"], str)


# ── _set_startup_status / _get_startup_status helpers ────────────────────────

def test_set_get_startup_status_round_trip(client):
    """_set_startup_status partial-updates the state; _get_startup_status
    returns a snapshot dict."""
    _, server = client
    server._set_startup_status(running=False, phase="complete", message="done",
                               current_plugin="", loaded=3, total=3, error=None)
    status = server._get_startup_status()
    assert status["running"] is False
    assert status["phase"] == "complete"
    assert status["loaded"] == 3
    assert status["total"] == 3
    assert status["error"] is None


def test_set_startup_status_partial_update_does_not_clobber_other_keys(client):
    """A partial _set_startup_status call must not lose previously-set keys."""
    _, server = client
    server._set_startup_status(running=True, phase="plugins-loading", message="loading",
                               current_plugin="myplugin", loaded=1, total=5, error=None)
    # Only update message.
    server._set_startup_status(message="installing requirements")
    status = server._get_startup_status()
    assert status["message"] == "installing requirements"
    assert status["phase"] == "plugins-loading"
    assert status["current_plugin"] == "myplugin"
    assert status["loaded"] == 1
    assert status["total"] == 5


def test_startup_status_endpoint_reflects_set_status(client):
    """The HTTP endpoint must reflect what was last written via _set_startup_status."""
    tc, server = client
    server._set_startup_status(running=False, phase="complete", message="All done",
                               current_plugin="", loaded=7, total=7, error=None)
    data = tc.get("/api/startup-status").json()
    assert data["running"] is False
    assert data["phase"] == "complete"
    assert data["loaded"] == 7
    assert data["total"] == 7


def test_startup_status_exact_success_transition_sequence(monkeypatch, startup_harness):
    """Lock the startup phase sequence for successful plugin startup."""
    server, phases = startup_harness

    def fake_load_plugins(_app, _context, progress_cb=None, route_setup_fn=None):
        for event in _FAKE_SUCCESS_EVENTS:
            progress_cb(event)

    monkeypatch.setattr(server, "load_plugins", fake_load_plugins)
    asyncio.run(server.startup_events())
    final = server._get_startup_status()

    assert phases == [
        "starting",
        "plugins-loading",
        "plugins-discovered",
        "plugin-start",
        "plugin-requirements",
        "plugin-routes",
        "plugin-registered",
        "plugins-complete",
        "complete",
    ]
    assert final["phase"] == "complete"
    assert final["running"] is False
    assert final["loaded"] == 1
    assert final["total"] == 1
    assert final["total"] >= final["loaded"]
    assert final["error"] is None

    # Verify the HTTP endpoint exposes the same terminal state — a regression
    # that breaks the endpoint handler or disconnects it from _get_startup_status()
    # would silently pass if we only read the internal helper.  ASGITransport
    # sends requests directly to the ASGI app without re-running lifespan events.
    async def _check_endpoint():
        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=server.app), base_url="http://test"
        ) as ac:
            r = await ac.get("/api/startup-status")
            return r.json()

    endpoint_data = asyncio.run(_check_endpoint())
    assert endpoint_data["phase"] == "complete"
    assert endpoint_data["running"] is False
    assert endpoint_data["error"] is None


def test_startup_status_exact_error_transition_sequence(monkeypatch, startup_harness):
    """Lock the startup phase sequence when plugin startup raises."""
    server, phases = startup_harness

    def failing_load_plugins(*a, **kw):
        raise RuntimeError("boom")

    monkeypatch.setattr(server, "load_plugins", failing_load_plugins)
    asyncio.run(server.startup_events())
    final = server._get_startup_status()

    assert phases == [
        "starting",
        "plugins-loading",
        "error",
    ]
    assert final["phase"] == "error"
    assert final["running"] is False
    assert final["loaded"] == 0
    assert final["total"] == 0
    assert isinstance(final["error"], str)
    assert "boom" in final["error"]

    # Verify the HTTP endpoint exposes the terminal error state — a regression
    # that stops the endpoint surfacing the error would silently pass above.
    async def _fetch_endpoint_data():
        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=server.app), base_url="http://test"
        ) as ac:
            r = await ac.get("/api/startup-status")
            return r.json()

    endpoint_data = asyncio.run(_fetch_endpoint_data())
    assert endpoint_data["phase"] == "error"
    assert endpoint_data["running"] is False
    assert isinstance(endpoint_data["error"], str)
    assert "boom" in endpoint_data["error"]


def test_startup_status_plugin_error_event_preserved_in_complete(monkeypatch, startup_harness):
    """When an individual plugin fails via a plugin-error progress event, startup
    ends in 'complete' (not 'error'), but the error field is propagated to the
    terminal status — a regression in that path would silently pass the
    load_plugins-raises test above.
    """
    server, phases = startup_harness

    def failing_plugin_load_plugins(_app, _context, progress_cb=None, route_setup_fn=None):
        """Simulate load_plugins emitting plugin-error for one plugin then completing."""
        if progress_cb:
            for event in _FAKE_PLUGIN_ERROR_EVENTS:
                progress_cb(event)
        # load_plugins returns normally — startup will set phase to 'complete'

    monkeypatch.setattr(server, "load_plugins", failing_plugin_load_plugins)
    asyncio.run(server.startup_events())
    final = server._get_startup_status()

    assert phases == [
        "starting",
        "plugins-loading",
        "plugins-discovered",
        "plugin-start",
        "plugin-requirements",
        "plugin-error",
        "plugin-registered",
        "plugins-complete",
        "complete",
    ]
    assert final["phase"] == "complete"
    assert final["running"] is False
    # The exact error text from the plugin-error event must survive in the
    # terminal status — a regression that clears it in any of the follow-up
    # non-error events (plugin-registered, plugins-complete) would now fail.
    assert final["error"] == _FAKE_PLUGIN_ERROR_TEXT

    # Verify the HTTP endpoint exposes the preserved error — a bug where the
    # endpoint stops surfacing the plugin error once startup reaches 'complete'
    # would silently pass the _get_startup_status assertion above.
    async def _fetch_endpoint_data():
        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=server.app), base_url="http://test"
        ) as ac:
            r = await ac.get("/api/startup-status")
            return r.json()

    endpoint_data = asyncio.run(_fetch_endpoint_data())
    assert endpoint_data["phase"] == "complete"
    assert endpoint_data["running"] is False
    assert endpoint_data["error"] == _FAKE_PLUGIN_ERROR_TEXT


def test_startup_status_plugin_error_cleared_by_explicit_none_progress(monkeypatch, startup_harness):
    """When a plugin-registered event carries explicit error=None after a
    preceding plugin-error event, the stale error must be cleared from
    startup-status. This exercises the ``'error' in event`` path in _on_progress
    which was added to support the bundled-plugin fallback (Thread 4,
    review-4226783807).

    A regression that checks ``event.get("error") is not None`` instead of
    ``"error" in event`` would leave the stale bundled-failure error in the
    status even though the user-copy fallback succeeded.
    """
    server, phases = startup_harness

    # Simulate the exact sequence load_plugins emits during a successful
    # bundled-failure fallback: plugin-error (bundled broken) followed by
    # plugin-registered with explicit error=None (fallback OK, clear error).
    _FAKE_FALLBACK_RECOVERY_EVENTS = [
        {"phase": "plugins-discovered", "message": "Discovered 1 plugin(s)",
         "plugin_id": "", "loaded": 0, "total": 1},
        {"phase": "plugin-start", "message": "Loading plugin 'myplug'",
         "plugin_id": "myplug", "loaded": 0, "total": 1},
        {"phase": "plugin-requirements", "message": "Installing requirements for 'myplug' (if needed)",
         "plugin_id": "myplug", "loaded": 0, "total": 1},
        {"phase": "plugin-error", "message": "Failed loading routes for 'myplug'",
         "plugin_id": "myplug", "loaded": 0, "total": 1, "error": "Failed to load bundled plugin routes"},
        # Fallback success: event explicitly carries error=None to clear the stale error.
        {"phase": "plugin-registered", "message": "Registered fallback copy of plugin 'myplug'",
         "plugin_id": "myplug", "loaded": 1, "total": 1, "error": None},
        {"phase": "plugins-complete", "message": "Loaded 1 plugin(s)",
         "plugin_id": "", "loaded": 1, "total": 1},
    ]

    def fake_load_plugins(_app, _context, progress_cb=None, route_setup_fn=None):
        if progress_cb:
            for event in _FAKE_FALLBACK_RECOVERY_EVENTS:
                progress_cb(event)

    monkeypatch.setattr(server, "load_plugins", fake_load_plugins)
    asyncio.run(server.startup_events())
    final = server._get_startup_status()

    # The plugin-error event sets error; the plugin-registered with error=None
    # must clear it. If _on_progress only forwards non-null errors, this fails.
    assert final["error"] is None, (
        f"Expected error to be cleared by explicit error=None event, got {final['error']!r}"
    )
    assert final["phase"] == "complete"
    assert final["running"] is False

    # Verify via the HTTP endpoint too — a disconnect between the endpoint
    # handler and _get_startup_status would silently pass the assertion above.
    async def _fetch_endpoint_data():
        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=server.app), base_url="http://test"
        ) as ac:
            r = await ac.get("/api/startup-status")
            return r.json()

    endpoint_data = asyncio.run(_fetch_endpoint_data())
    assert endpoint_data["phase"] == "complete"
    assert endpoint_data["running"] is False
    assert endpoint_data["error"] is None, (
        f"HTTP endpoint should also show cleared error, got {endpoint_data['error']!r}"
    )


def test_startup_status_clear_error_does_not_erase_unrelated_plugin_failure(
    monkeypatch, startup_harness
):
    """When plugin A fails and then plugin B's fallback recovery emits
    error=None, the error set by plugin A must NOT be cleared.

    This exercises the _active_errors dict tracking added in server.py
    (Thread 2, review-4226937699).  Without that guard, a fallback clear
    from any plugin would erase all startup-status errors regardless of
    source, hiding a broken plugin from the user.
    """
    server, phases = startup_harness

    # plugin_a fails; plugin_b's fallback succeeds and emits error=None.
    # plugin_a's error must survive because the clear came from plugin_b.
    _EVENTS = [
        {"phase": "plugin-error", "message": "Failed for plugin_a",
         "plugin_id": "plugin_a", "loaded": 0, "total": 2,
         "error": "plugin_a route failure"},
        # plugin_b's fallback recovery — clears *its own* error, not plugin_a's.
        {"phase": "plugin-registered", "message": "Registered fallback of plugin_b",
         "plugin_id": "plugin_b", "loaded": 1, "total": 2, "error": None},
        {"phase": "plugins-complete", "message": "Loaded 1 plugin(s)",
         "plugin_id": "", "loaded": 1, "total": 2},
    ]

    def fake_load_plugins(_app, _context, progress_cb=None, route_setup_fn=None):
        if progress_cb:
            for event in _EVENTS:
                progress_cb(event)

    monkeypatch.setattr(server, "load_plugins", fake_load_plugins)
    asyncio.run(server.startup_events())
    final = server._get_startup_status()

    # plugin_a's error must still be present — plugin_b's clear must not erase it.
    assert final["error"] == "plugin_a route failure", (
        f"plugin_a error should be preserved after plugin_b's clear, got {final['error']!r}"
    )


def test_startup_status_two_plugin_errors_one_clears_other_remains(
    monkeypatch, startup_harness
):
    """When two plugins fail and only one recovers via fallback, the other
    plugin's error must remain visible in startup-status.

    The _last_error single-pointer approach could not handle this case: once
    plugin B overwrote the pointer, B's subsequent clear_error would wipe
    the status to None even though A was still broken.  The _active_errors
    dict correctly removes B and restores A's failure.
    """
    server, phases = startup_harness

    _EVENTS = [
        # Both plugins fail.
        {"phase": "plugin-error", "message": "Failed for plugin_a",
         "plugin_id": "plugin_a", "loaded": 0, "total": 2,
         "error": "plugin_a route failure"},
        {"phase": "plugin-error", "message": "Failed for plugin_b",
         "plugin_id": "plugin_b", "loaded": 0, "total": 2,
         "error": "plugin_b route failure"},
        # plugin_b's fallback succeeds and clears its own error.
        {"phase": "plugin-registered", "message": "Registered fallback of plugin_b",
         "plugin_id": "plugin_b", "loaded": 1, "total": 2, "error": None},
        {"phase": "plugins-complete", "message": "Loaded 1 plugin(s)",
         "plugin_id": "", "loaded": 1, "total": 2},
    ]

    def fake_load_plugins(_app, _context, progress_cb=None, route_setup_fn=None):
        if progress_cb:
            for event in _EVENTS:
                progress_cb(event)

    monkeypatch.setattr(server, "load_plugins", fake_load_plugins)
    asyncio.run(server.startup_events())
    final = server._get_startup_status()

    # plugin_a's error must still be present after plugin_b's recovery.
    assert final["error"] == "plugin_a route failure", (
        f"plugin_a error should remain after plugin_b recovery, got {final['error']!r}"
    )


def test_startup_status_latest_error_wins_when_same_plugin_emits_multiple(
    monkeypatch, startup_harness
):
    """When the same plugin emits multiple error events (e.g. requirements
    failure then routes failure), restoring after another plugin clears must
    surface the *latest* error from the first plugin, not the first one.

    The dict.update()-in-place approach fails here because assigning a key
    that already exists does NOT move it to the end of insertion order.
    The fix (pop + re-insert) guarantees remaining[-1] is always the most
    recently emitted unresolved failure.
    (Thread 3, review-4228077246)
    """
    server, phases = startup_harness

    _EVENTS = [
        # plugin_a emits two successive errors.
        {"phase": "plugin-error", "message": "req failure",
         "plugin_id": "plugin_a", "loaded": 0, "total": 2,
         "error": "plugin_a requirements failure"},
        {"phase": "plugin-error", "message": "routes failure",
         "plugin_id": "plugin_a", "loaded": 0, "total": 2,
         "error": "plugin_a routes failure"},
        # plugin_b fails, then recovers — clears only its own error.
        {"phase": "plugin-error", "message": "Failed for plugin_b",
         "plugin_id": "plugin_b", "loaded": 1, "total": 2,
         "error": "plugin_b route failure"},
        {"phase": "plugin-registered", "message": "Registered fallback of plugin_b",
         "plugin_id": "plugin_b", "loaded": 2, "total": 2, "error": None},
        {"phase": "plugins-complete", "message": "Loaded 1 plugin(s)",
         "plugin_id": "", "loaded": 1, "total": 2},
    ]

    def fake_load_plugins(_app, _context, progress_cb=None, route_setup_fn=None):
        if progress_cb:
            for event in _EVENTS:
                progress_cb(event)

    monkeypatch.setattr(server, "load_plugins", fake_load_plugins)
    asyncio.run(server.startup_events())
    final = server._get_startup_status()

    # After plugin_b clears its own error, plugin_a's *latest* error (routes
    # failure) should be surfaced — not the earlier requirements failure.
    assert final["error"] == "plugin_a routes failure", (
        f"Expected latest plugin_a error after plugin_b recovery, got {final['error']!r}"
    )


def test_startup_status_fallback_req_error_not_cleared_by_route_success(
    monkeypatch, startup_harness
):
    """When a fallback copy's requirements installation fails (non-fatal) but its
    routes succeed, the plugin-registered event must NOT carry error=None — that
    would wipe the req-failure from _active_errors and make startup look clean
    even though the active fallback copy has missing dependencies.
    (Thread 1, review-4228421486)
    """
    server, phases = startup_harness

    _EVENTS = [
        # Bundled plugin fails its routes.
        {"phase": "plugin-error", "message": "Bundled routes failed",
         "plugin_id": "highway_3d", "loaded": 0, "total": 1,
         "error": "bundled routes failure"},
        # Fallback req install also fails (non-fatal).
        {"phase": "plugin-error", "message": "Fallback req failed",
         "plugin_id": "highway_3d", "loaded": 0, "total": 1,
         "error": "fallback req failure"},
        # Fallback routes succeed — plugin-registered WITHOUT clear_error
        # because req failed.  event must NOT carry "error" key.
        {"phase": "plugin-registered", "message": "Registered fallback",
         "plugin_id": "highway_3d", "loaded": 1, "total": 1},
        {"phase": "plugins-complete", "message": "Loaded 1 plugin(s)",
         "plugin_id": "", "loaded": 1, "total": 1},
    ]

    def fake_load_plugins(_app, _context, progress_cb=None, route_setup_fn=None):
        if progress_cb:
            for event in _EVENTS:
                progress_cb(event)

    monkeypatch.setattr(server, "load_plugins", fake_load_plugins)
    asyncio.run(server.startup_events())
    final = server._get_startup_status()

    # Startup must still report the req-failure error — the fallback succeeded
    # in loading routes but its dependencies are degraded.
    assert final["error"] == "fallback req failure", (
        f"Expected req-failure error to persist after fallback route success, "
        f"got {final['error']!r}"
    )


def test_startup_status_e2e_real_plugin_loader(tmp_path, monkeypatch, isolate_logging):
    """Integration: run startup_events() with the REAL load_plugins against a
    minimal test plugin, using the production background-thread code path.

    Unlike the fake-load_plugins test, a regression in the plugin loader's
    emitted phase order or a missing phase will cause this test to fail.
    Unlike the sync-mode transition tests, this omits FEEDBACK_SYNC_STARTUP so
    the background thread runs and route registration is marshalled back onto the
    event loop via call_soon_threadsafe — the path the production server uses.
    """
    import plugins as plugins_mod

    # Create a minimal test plugin whose routes.py registers a sentinel GET
    # endpoint.  This lets us verify that _route_setup_on_main() actually
    # executed the setup() call via call_soon_threadsafe — a no-op setup()
    # would pass even if the callback was queued but never executed.
    plugins_root = tmp_path / "test_plugins"
    plugins_root.mkdir()
    plugin_dir = plugins_root / "e2eplugin"
    plugin_dir.mkdir()
    (plugin_dir / "plugin.json").write_text(
        json.dumps({"id": "e2eplugin", "name": "E2E Plugin", "routes": "routes.py"})
    )
    (plugin_dir / "routes.py").write_text(
        "def setup(app, ctx):\n"
        "    @app.get('/api/plugin-e2eplugin-ok')\n"
        "    def _sentinel():\n"
        "        return {'ok': True}\n"
    )

    # Override the plugin loader's built-in directory to our isolated test
    # plugins root so real installed plugins don't affect the phase sequence.
    monkeypatch.setattr(plugins_mod, "PLUGINS_DIR", plugins_root)
    monkeypatch.delenv("FEEDBACK_PLUGINS_DIR", raising=False)

    # _PIP_TARGET is computed from CONFIG_DIR at plugins import time, so it
    # may point at a previous test's tmp dir or the system /config path.
    # Redirect it to the current tmp_path so requirement installs (a no-op
    # for our test plugin) stay fully isolated.
    monkeypatch.setattr(plugins_mod, "_PIP_TARGET", tmp_path / "pip_packages")

    # Set up server WITHOUT FEEDBACK_SYNC_STARTUP so startup_events() spawns
    # the real background thread and route registration is marshalled back onto
    # the event loop via call_soon_threadsafe (the production path).
    monkeypatch.setenv("CONFIG_DIR", str(tmp_path))
    monkeypatch.delenv("FEEDBACK_SYNC_STARTUP", raising=False)
    monkeypatch.delenv("FEEDBACK_DEMO_MODE", raising=False)
    sys.modules.pop("server", None)
    server = importlib.import_module("server")
    monkeypatch.setattr(server, "startup_scan", lambda: None)

    # Wire phase recording on _set_startup_status.  The original uses a lock,
    # so calling it before appending to the list is thread-safe (the background
    # thread and the GIL together make list.append atomic).
    phases = []
    original_set = server._set_startup_status

    def recording_set(**updates):
        original_set(**updates)
        phases.append(server._get_startup_status()["phase"])

    monkeypatch.setattr(server, "_set_startup_status", recording_set)

    # Save state the plugin loader will mutate for cleanup.
    saved_loaded = list(plugins_mod.LOADED_PLUGINS)
    saved_path = list(sys.path)
    saved_e2e_modules = {k for k in sys.modules if k.startswith("plugin_e2eplugin")}
    data: dict | None = None
    try:
        with TestClient(server.app) as tc:
            # startup_events() returned immediately after spawning the background
            # thread; poll /api/startup-status via HTTP until running=False.
            deadline = time.monotonic() + 10.0
            while time.monotonic() < deadline:
                data = tc.get("/api/startup-status").json()
                if not data.get("running", True):
                    break
                time.sleep(0.05)
            assert data is not None, "No response received from /api/startup-status"
            assert not data.get("running", True), (
                f"Background startup thread did not complete within 10 s; "
                f"last status: {data}"
            )
            # Assert terminal state via the HTTP endpoint (not just the internal
            # helper) so a disconnect between the handler and _get_startup_status
            # would fail.
            assert data["phase"] == "complete"
            assert data["running"] is False
            assert data["loaded"] == 1
            assert data["total"] == 1
            assert data["error"] is None
            # Verify that _route_setup_on_main() actually ran the plugin's setup()
            # call via call_soon_threadsafe — if the callback was queued but never
            # executed the sentinel route would be missing and this would return 404.
            # We check this inside the same TestClient context to avoid opening a
            # second client (which would re-run app lifespan and startup_events()).
            sentinel = tc.get("/api/plugin-e2eplugin-ok")
            assert sentinel.status_code == 200
            assert sentinel.json() == {"ok": True}
    finally:
        server._DEMO_JANITOR_STOP.set()
        thread = server._DEMO_JANITOR_THREAD
        if thread is not None:
            thread.join(timeout=2)
        server._DEMO_JANITOR_STARTED = False
        server._DEMO_JANITOR_THREAD = None
        conn = getattr(getattr(server, "meta_db", None), "conn", None)
        if conn is not None:
            conn.close()
        with plugins_mod.PLUGINS_LOCK:
            plugins_mod.LOADED_PLUGINS.clear()
            plugins_mod.LOADED_PLUGINS.extend(saved_loaded)
        sys.path[:] = saved_path
        for key in list(sys.modules):
            if key.startswith("plugin_e2eplugin") and key not in saved_e2e_modules:
                del sys.modules[key]

    assert phases == [
        "starting",
        "plugins-loading",
        "plugins-discovered",
        "plugin-start",
        "plugin-requirements",
        "plugin-routes",
        "plugin-registered",
        "plugins-complete",
        "complete",
    ]


def test_startup_status_endpoint_background_thread_path(tmp_path, monkeypatch, isolate_logging):
    """Verify /api/startup-status reflects the correct terminal state when the
    background-thread code path is used (FEEDBACK_SYNC_STARTUP not set).

    All other transition tests force FEEDBACK_SYNC_STARTUP=1, which exercises
    only the inline branch of startup_events().  In production the loader runs
    in a background thread; thread handoff bugs (missed progress events, route
    marshalling failures, races while the UI polls /api/startup-status) would
    go undetected by the sync-only tests.

    This test omits FEEDBACK_SYNC_STARTUP so startup_events() spawns the real
    background thread, then polls the HTTP endpoint until running=False and
    asserts the terminal contract.
    """
    monkeypatch.setenv("CONFIG_DIR", str(tmp_path))
    monkeypatch.delenv("FEEDBACK_SYNC_STARTUP", raising=False)
    monkeypatch.delenv("FEEDBACK_DEMO_MODE", raising=False)
    sys.modules.pop("server", None)
    server = importlib.import_module("server")

    _route_setup_called = []

    def _load_plugins_with_events(_app, _context, progress_cb=None, route_setup_fn=None):
        """Emit the full success-path event sequence so the background thread's
        status-propagation logic (_on_progress + _set_startup_status) is exercised.
        Also calls route_setup_fn with a sentinel to exercise _route_setup_on_main()
        and the call_soon_threadsafe path — without this, a no-op stub would never
        invoke route_setup_fn and the route-registration branch would go untested.
        """
        if route_setup_fn:
            route_setup_fn(lambda: _route_setup_called.append(True))
        if progress_cb:
            for event in _FAKE_SUCCESS_EVENTS:
                progress_cb(event)

    monkeypatch.setattr(server, "load_plugins", _load_plugins_with_events)
    monkeypatch.setattr(server, "startup_scan", lambda: None)
    try:
        with TestClient(server.app) as tc:
            # startup_events() returned immediately after spawning the background
            # thread; poll /api/startup-status until the thread sets running=False.
            deadline = time.monotonic() + 5.0
            data: dict = {}
            while time.monotonic() < deadline:
                data = tc.get("/api/startup-status").json()
                if not data.get("running", True):
                    break
                time.sleep(0.02)
            assert not data.get("running", True), (
                f"Background startup thread did not complete within 5 s; "
                f"last status: {data}"
            )
            assert data["phase"] == "complete"
            assert data["loaded"] == 1
            assert data["total"] == 1
            assert data["error"] is None
            # Verify route_setup_fn was invoked by the thread so call_soon_threadsafe
            # actually executed the sentinel — proves the main-loop handoff path ran.
            assert _route_setup_called, "route_setup_fn was never called; call_soon_threadsafe path was not exercised"
    finally:
        server._DEMO_JANITOR_STOP.set()
        thread = server._DEMO_JANITOR_THREAD
        if thread is not None:
            thread.join(timeout=2)
        server._DEMO_JANITOR_STARTED = False
        server._DEMO_JANITOR_THREAD = None
        conn = getattr(getattr(server, "meta_db", None), "conn", None)
        if conn is not None:
            conn.close()


def test_startup_status_endpoint_background_thread_failure(tmp_path, monkeypatch, isolate_logging):
    """Verify /api/startup-status reflects phase='error'/running=False when
    load_plugins raises inside the background thread.

    The success-path background-thread test covers status propagation for a
    normal run; this test covers the exception branch so a regression where
    the async thread never publishes running=False or phase='error' is caught.
    """
    monkeypatch.setenv("CONFIG_DIR", str(tmp_path))
    monkeypatch.delenv("FEEDBACK_SYNC_STARTUP", raising=False)
    monkeypatch.delenv("FEEDBACK_DEMO_MODE", raising=False)
    sys.modules.pop("server", None)
    server = importlib.import_module("server")

    _BG_ERROR = "simulated background load_plugins failure"

    def _load_plugins_raises(_app, _context, progress_cb=None, route_setup_fn=None):
        raise RuntimeError(_BG_ERROR)

    monkeypatch.setattr(server, "load_plugins", _load_plugins_raises)
    monkeypatch.setattr(server, "startup_scan", lambda: None)
    try:
        with TestClient(server.app) as tc:
            deadline = time.monotonic() + 5.0
            data: dict = {}
            while time.monotonic() < deadline:
                data = tc.get("/api/startup-status").json()
                if not data.get("running", True):
                    break
                time.sleep(0.02)
            assert not data.get("running", True), (
                f"Background startup thread did not complete within 5 s; "
                f"last status: {data}"
            )
            assert data["phase"] == "error"
            assert _BG_ERROR in data["error"]
    finally:
        server._DEMO_JANITOR_STOP.set()
        thread = server._DEMO_JANITOR_THREAD
        if thread is not None:
            thread.join(timeout=2)
        server._DEMO_JANITOR_STARTED = False
        server._DEMO_JANITOR_THREAD = None
        conn = getattr(getattr(server, "meta_db", None), "conn", None)
        if conn is not None:
            conn.close()


# ── /api/startup-status/stream SSE endpoint ──────────────────────────────────

def _drain_sse(response) -> list[dict]:
    """Read all SSE data events from a streaming response and return decoded dicts.

    Keepalive events (``{"type": "keepalive"}``) are filtered out so callers
    can assert on the actual status events without accounting for timing-driven
    keepalive frames that may or may not appear during a test run.
    """
    events = []
    for raw in response.iter_lines():
        line = raw.decode() if isinstance(raw, bytes) else raw
        line = line.strip()
        if line.startswith("data:"):
            try:
                obj = json.loads(line[5:].strip())
                if obj.get("type") != "keepalive":
                    events.append(obj)
            except json.JSONDecodeError:
                pass
    return events


def test_sse_stream_returns_200(client):
    tc, server = client
    server._set_startup_status(running=False, phase="complete", message="done",
                               current_plugin="", loaded=1, total=1, error=None)
    with tc.stream("GET", "/api/startup-status/stream") as r:
        assert r.status_code == 200
        assert "text/event-stream" in r.headers.get("content-type", "")
        assert r.headers.get("x-accel-buffering", "").lower() == "no"
        _drain_sse(r)


def test_sse_stream_delivers_initial_snapshot(client):
    """Connecting to the stream receives the current status as the first event."""
    tc, server = client
    server._set_startup_status(running=False, phase="complete", message="all done",
                               current_plugin="", loaded=5, total=5, error=None)
    with tc.stream("GET", "/api/startup-status/stream") as r:
        events = _drain_sse(r)
    assert events, "expected at least one SSE event"
    first = events[0]
    assert first["phase"] == "complete"
    assert first["running"] is False
    assert first["loaded"] == 5


def test_sse_stream_closes_after_terminal_event(client):
    """Stream ends on its own when the status is already not-running."""
    tc, server = client
    server._set_startup_status(running=False, phase="complete", message="done",
                               current_plugin="", loaded=2, total=2, error=None)
    with tc.stream("GET", "/api/startup-status/stream") as r:
        events = _drain_sse(r)
    # The last event must be terminal (running=False).
    assert events
    assert events[-1]["running"] is False


def test_sse_stream_subscriber_cleaned_up_after_stream(client):
    """Subscriber queue is removed from _startup_sse_subscribers when the stream ends."""
    tc, server = client
    server._set_startup_status(running=False, phase="complete", message="done",
                               current_plugin="", loaded=3, total=3, error=None)
    before = len(server._startup_sse_subscribers)
    with tc.stream("GET", "/api/startup-status/stream") as r:
        _drain_sse(r)
    after = len(server._startup_sse_subscribers)
    assert after == before


def test_sse_stream_delivers_pushed_event(client):
    """Events pushed via _set_startup_status after the connection opens are fan-out delivered."""
    tc, server = client
    server._set_startup_status(running=True, phase="plugins-loading", message="loading",
                               current_plugin="", loaded=1, total=3, error=None)

    # Background thread waits until the subscriber queue appears AND has consumed
    # the initial snapshot (queue empty), then pushes the terminal update.  The
    # queue-empty check avoids a race where put_nowait coalesces the terminal
    # onto the still-unread initial snapshot, making len(events) >= 2 flaky.
    thread_exc: list[BaseException] = []

    def _push_terminal():
        try:
            deadline = time.monotonic() + 3.0
            while time.monotonic() < deadline:
                with server._startup_sse_lock:
                    qs = list(server._startup_sse_subscribers)
                if qs:
                    break
                time.sleep(0.01)
            assert server._startup_sse_subscribers, "Subscriber never appeared within deadline"
            while time.monotonic() < deadline:
                with server._startup_sse_lock:
                    qs = list(server._startup_sse_subscribers)
                if all(q.qsize() == 0 for q in qs):
                    break
                time.sleep(0.01)
            server._set_startup_status(running=False, phase="complete", message="done",
                                       current_plugin="", loaded=3, total=3, error=None)
        except BaseException as exc:
            thread_exc.append(exc)
            raise

    t = threading.Thread(target=_push_terminal, daemon=True)
    t.start()

    with tc.stream("GET", "/api/startup-status/stream") as r:
        events = _drain_sse(r)

    t.join(timeout=5.0)
    assert not thread_exc, str(thread_exc[0])
    assert not t.is_alive(), "pusher thread did not finish in time"
    # Must have at least 2 events: initial snapshot (running=True) + pushed terminal (running=False)
    assert len(events) >= 2
    assert events[-1]["running"] is False
    assert events[-1]["phase"] == "complete"


def test_sse_stream_subscriber_cleaned_up_mid_startup(client):
    """Subscriber is removed when the stream terminates while startup was still running.

    With httpx's in-process ASGI transport, closing the stream context before the
    generator finishes causes httpx to drain all remaining bytes — which never ends
    for a live SSE generator.  Instead, this test pushes a terminal event from a
    background thread (simulating server-side completion or a client disconnect where
    the generator notices via the 2 s poll) and verifies that the `finally` block in
    `_gen()` removes the subscriber.
    """
    tc, server = client
    server._set_startup_status(running=True, phase="plugins-loading", message="loading",
                               current_plugin="", loaded=1, total=3, error=None)

    before = len(server._startup_sse_subscribers)
    thread_exc: list[BaseException] = []

    def _push_terminal():
        try:
            # Wait until the new subscriber appears.  Assert so the test fails
            # loudly if it never does (instead of silently pushing to an already-
            # terminal snapshot and passing without exercising the cleanup path).
            deadline = time.monotonic() + 3.0
            while time.monotonic() < deadline:
                if len(server._startup_sse_subscribers) > before:
                    break
                time.sleep(0.01)
            assert len(server._startup_sse_subscribers) > before, (
                "Subscriber never appeared within deadline"
            )
            # Wait for the initial snapshot to be consumed before pushing the
            # terminal so that the two events don't coalesce in the maxsize=1 queue.
            while time.monotonic() < deadline:
                with server._startup_sse_lock:
                    qs = list(server._startup_sse_subscribers)
                if all(q.qsize() == 0 for q in qs):
                    break
                time.sleep(0.01)
            server._set_startup_status(running=False, phase="complete", message="done",
                                       current_plugin="", loaded=3, total=3, error=None)
        except BaseException as exc:
            thread_exc.append(exc)
            raise

    t = threading.Thread(target=_push_terminal, daemon=True)
    t.start()

    with tc.stream("GET", "/api/startup-status/stream") as r:
        _drain_sse(r)  # blocks until the generator sends running=False and closes

    t.join(timeout=5.0)
    assert not thread_exc, str(thread_exc[0])
    assert not t.is_alive(), "pusher thread did not finish in time"
    assert len(server._startup_sse_subscribers) == before


@pytest.mark.anyio
async def test_sse_disconnect_detected_between_rapid_messages(client):
    """is_disconnected() is checked after each message, not only on the 2 s idle timeout.

    Starlette's TestClient only delivers http.disconnect AFTER the full response body
    has been consumed, so this test bypasses TestClient and drives the route handler
    directly.  A Request subclass that overrides is_disconnected() to return True
    immediately lets us verify that the post-yield check causes the generator to exit
    after delivering the initial snapshot (< 500 ms), rather than waiting for the
    full 2 s idle timeout that the old timeout-only code path would require.
    """
    from starlette.requests import Request as StarletteRequest

    _, server_mod = client
    server_mod._set_startup_status(running=True, phase="plugins-loading", message="loading",
                                   current_plugin="", loaded=1, total=10, error=None)

    class _AlwaysDisconnectedRequest(StarletteRequest):
        """Starlette Request whose is_disconnected() immediately returns True."""
        async def is_disconnected(self) -> bool:
            return True

    scope = {
        "type": "http",
        "asgi": {"version": "3.0"},
        "method": "GET",
        "path": "/api/startup-status/stream",
        "raw_path": b"/api/startup-status/stream",
        "query_string": b"",
        "headers": [],
        "http_version": "1.1",
        "scheme": "http",
    }

    async def _noop_receive():
        return {"type": "http.request", "body": b"", "more_body": False}

    request = _AlwaysDisconnectedRequest(scope=scope, receive=_noop_receive)

    before = len(server_mod._startup_sse_subscribers)

    start = time.monotonic()
    response = await server_mod.startup_status_stream(request)
    chunks = []
    async for chunk in response.body_iterator:
        chunks.append(chunk)
    elapsed = time.monotonic() - start

    # Subscriber cleanup must have happened via the finally block.
    assert len(server_mod._startup_sse_subscribers) == before

    # With the post-yield is_disconnected() check the generator exits right after
    # the initial snapshot.  Without it the generator blocks on queue.get() for
    # the full _SSE_POLL_INTERVAL (2 s) before noticing the disconnect.
    # 0.5 s is well above the < 1 ms expected path; leaves plenty of headroom
    # for slow CI while still catching the 2 s regression.
    _MAX_DISCONNECT_LATENCY_S = 0.5
    assert elapsed < _MAX_DISCONNECT_LATENCY_S, (
        f"Generator took {elapsed:.2f}s; post-message is_disconnected() check may be missing"
    )


def test_sse_stream_fan_out_to_multiple_consumers(client):
    """A single _set_startup_status push is fan-out delivered to ALL concurrent subscribers.

    Two threads each open an independent SSE stream while startup is running.  A third
    thread waits until both subscribers are registered, then pushes a terminal event via
    the real _notify_startup_sse / call_soon_threadsafe path.  Both consumers must
    receive the terminal event.  A bug that used a single shared queue (instead of
    per-subscriber queues) or that didn't iterate all subscribers would fail this test.
    """
    tc, server = client
    server._set_startup_status(running=True, phase="plugins-loading", message="loading",
                               current_plugin="", loaded=1, total=3, error=None)

    before = len(server._startup_sse_subscribers)
    events_a: list = []
    events_b: list = []

    def _run_consumer(events_list):
        with tc.stream("GET", "/api/startup-status/stream") as r:
            events_list.extend(_drain_sse(r))

    both_registered = threading.Event()

    def _push_terminal():
        deadline = time.monotonic() + 5.0
        while time.monotonic() < deadline:
            if len(server._startup_sse_subscribers) >= before + 2:
                both_registered.set()
                break
            time.sleep(0.01)
        # Wait for both queues to drain (initial snapshots consumed) before
        # pushing so the terminal isn't coalesced onto an unread snapshot.
        while time.monotonic() < deadline:
            with server._startup_sse_lock:
                qs = list(server._startup_sse_subscribers)
            if all(q.qsize() == 0 for q in qs):
                break
            time.sleep(0.01)
        server._set_startup_status(running=False, phase="complete", message="done",
                                   current_plugin="", loaded=3, total=3, error=None)

    ta = threading.Thread(target=_run_consumer, args=(events_a,), daemon=True)
    tb = threading.Thread(target=_run_consumer, args=(events_b,), daemon=True)
    tp = threading.Thread(target=_push_terminal, daemon=True)
    ta.start(); tb.start(); tp.start()
    ta.join(timeout=10.0); tb.join(timeout=10.0); tp.join(timeout=5.0)

    assert both_registered.is_set(), "Both subscribers not registered within deadline"
    assert not ta.is_alive(), "consumer A did not finish in time"
    assert not tb.is_alive(), "consumer B did not finish in time"
    assert events_a, "consumer A received no events"
    assert events_b, "consumer B received no events"
    assert events_a[-1]["running"] is False, "consumer A did not receive the terminal event"
    assert events_b[-1]["running"] is False, "consumer B did not receive the terminal event"


@pytest.mark.anyio
async def test_sse_stream_emits_keepalive(client, monkeypatch):
    """data: {"type":"keepalive"} event is emitted when the queue has been idle for _SSE_KA_INTERVAL.

    _SSE_POLL_INTERVAL and _SSE_KA_INTERVAL are patched to sub-second values so the
    test runs fast.  The generator is driven directly (bypassing TestClient) so that
    the asyncio Queue lives on the test event loop, enabling direct put_nowait() for
    clean termination once the keepalive is observed.

    Keepalives are sent as real data events (not SSE comment frames) so that
    EventSource.onmessage can see them and re-arm the client's liveness deadline.
    """
    import asyncio
    from starlette.requests import Request as StarletteRequest

    _, server_mod = client
    # Guard: if either constant is renamed the setattr silently becomes a no-op.
    assert hasattr(server_mod, "_SSE_POLL_INTERVAL"), "_SSE_POLL_INTERVAL missing from server"
    assert hasattr(server_mod, "_SSE_KA_INTERVAL"), "_SSE_KA_INTERVAL missing from server"
    monkeypatch.setattr(server_mod, "_SSE_POLL_INTERVAL", 0.05)
    monkeypatch.setattr(server_mod, "_SSE_KA_INTERVAL", 0.1)

    server_mod._set_startup_status(running=True, phase="plugins-loading", message="loading",
                                   current_plugin="", loaded=1, total=10, error=None)

    async def _noop_receive():
        return {"type": "http.request", "body": b"", "more_body": False}

    scope = {
        "type": "http",
        "asgi": {"version": "3.0"},
        "method": "GET",
        "path": "/api/startup-status/stream",
        "raw_path": b"/api/startup-status/stream",
        "query_string": b"",
        "headers": [],
        "http_version": "1.1",
        "scheme": "http",
    }
    request = StarletteRequest(scope=scope, receive=_noop_receive)

    before = set(server_mod._startup_sse_subscribers)
    response = await server_mod.startup_status_stream(request)
    with server_mod._startup_sse_lock:
        new_queues = server_mod._startup_sse_subscribers - before
    assert len(new_queues) == 1, "expected exactly one new subscriber queue"
    our_queue = next(iter(new_queues))

    keepalive_seen = asyncio.Event()

    async def _collect():
        async for chunk in response.body_iterator:
            if isinstance(chunk, bytes):
                chunk = chunk.decode()
            # Keepalives are data events: data: {"type":"keepalive"}
            for line in chunk.splitlines():
                line = line.strip()
                if line.startswith("data:"):
                    try:
                        obj = json.loads(line[5:].strip())
                        if obj.get("type") == "keepalive":
                            keepalive_seen.set()
                    except json.JSONDecodeError:
                        pass

    async def _push_terminal_after_keepalive():
        await keepalive_seen.wait()
        our_queue.put_nowait({
            "running": False, "phase": "complete", "message": "done",
            "current_plugin": "", "loaded": 10, "total": 10, "error": None,
        })

    await asyncio.gather(_collect(), _push_terminal_after_keepalive())
    assert keepalive_seen.is_set(), "No keepalive data event was emitted"
