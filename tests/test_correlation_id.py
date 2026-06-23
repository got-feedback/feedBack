"""Integration test for CorrelationIdMiddleware wiring in server.py.

Verifies that every HTTP response carries the X-Request-ID header that was
introduced alongside the structured logging bootstrap (feedBack#155).
Requests that include an X-Request-ID should echo it; requests without it
should receive a server-generated ID.  A cross-cutting end-to-end test
additionally asserts that the ID propagates into log output.
"""

import importlib
import io
import json
import logging
import sys
import uuid

import pytest
import structlog
from fastapi import FastAPI
from fastapi.testclient import TestClient
from asgi_correlation_id import CorrelationIdMiddleware


@pytest.fixture()
def client(tmp_path, monkeypatch):
    """Minimal server client with background I/O suppressed."""
    monkeypatch.setenv("CONFIG_DIR", str(tmp_path))
    monkeypatch.setenv("FEEDBACK_SYNC_STARTUP", "1")
    sys.modules.pop("server", None)
    server = importlib.import_module("server")
    monkeypatch.setattr(server, "load_plugins", lambda *a, **kw: None)
    monkeypatch.setattr(server, "startup_scan", lambda: None)
    with TestClient(server.app) as tc:
        try:
            yield tc
        finally:
            conn = getattr(getattr(server, "meta_db", None), "conn", None)
            if conn is not None:
                conn.close()


def test_response_includes_x_request_id_header(client):
    """Every response must carry X-Request-ID regardless of the endpoint."""
    r = client.get("/api/startup-status")
    assert "x-request-id" in {k.lower() for k in r.headers}, (
        f"X-Request-ID missing from response headers: {dict(r.headers)}"
    )


def test_provided_x_request_id_is_echoed(client):
    """When the client sends a valid UUID X-Request-ID, the server echoes it."""
    custom_id = str(uuid.uuid4())
    r = client.get("/api/startup-status", headers={"X-Request-ID": custom_id})
    assert r.headers.get("x-request-id") == custom_id


def test_opaque_proxy_id_is_echoed(client):
    """Non-UUID proxy-style request IDs must be propagated unchanged (validator=None)."""
    opaque_id = "abc123def456"
    r = client.get("/api/startup-status", headers={"X-Request-ID": opaque_id})
    assert r.headers.get("x-request-id") == opaque_id, (
        "Opaque proxy ID was replaced instead of propagated — "
        "ensure CorrelationIdMiddleware is configured with validator=None"
    )


def test_generated_x_request_id_is_nonempty(client):
    """When no X-Request-ID is sent, the server generates a non-empty one."""
    r = client.get("/api/startup-status")
    request_id = r.headers.get("x-request-id", "")
    assert request_id, "Server-generated X-Request-ID must not be empty"


# ---------------------------------------------------------------------------
# End-to-end: middleware + logging_setup integration
# ---------------------------------------------------------------------------


@pytest.fixture(autouse=True)
def _isolate_logging(isolate_logging):
    """Auto-use wrapper that pulls in the shared isolate_logging fixture."""


def test_request_id_appears_in_log_line(monkeypatch):
    """An HTTP request's X-Request-ID must appear as request_id in log output.

    This is the end-to-end integration check: CorrelationIdMiddleware sets the
    context var, and logging_setup._add_correlation_id reads it into the event
    dict, so both pieces must be wired together for this test to pass.
    """
    import logging_setup

    monkeypatch.setenv("LOG_FORMAT", "json")
    monkeypatch.setenv("LOG_LEVEL", "DEBUG")
    monkeypatch.delenv("LOG_FILE", raising=False)
    logging_setup.configure_logging()

    buf = io.StringIO()
    for h in logging.getLogger("feedBack").handlers:
        if isinstance(h, logging.StreamHandler) and not isinstance(
            h, logging.FileHandler
        ):
            h.stream = buf

    # Minimal app that replicates the same middleware wiring as server.py.
    mini_app = FastAPI()
    mini_app.add_middleware(CorrelationIdMiddleware, validator=None)

    @mini_app.get("/probe")
    def probe():
        logging.getLogger("feedBack.probe").info("probe_event")
        return {"ok": True}

    known_id = str(uuid.uuid4())
    with TestClient(mini_app) as tc:
        tc.get("/probe", headers={"X-Request-ID": known_id})

    lines = [ln for ln in buf.getvalue().splitlines() if "probe_event" in ln]
    assert lines, "No log line captured during HTTP request"
    parsed = json.loads(lines[0])
    assert parsed.get("request_id") == known_id, (
        f"Log line request_id {parsed.get('request_id')!r} != {known_id!r}"
    )


def test_server_app_request_id_propagated_to_logs(monkeypatch, tmp_path):
    """request_id must appear in log output from the real server.app.

    Uses the actual server.app instance (with its CorrelationIdMiddleware) to
    confirm no middleware-ordering regression can silence the correlation field.
    A temporary route is added for the test and removed afterwards so that
    server.app is not permanently modified.
    """
    monkeypatch.setenv("LOG_FORMAT", "json")
    monkeypatch.setenv("LOG_LEVEL", "DEBUG")
    monkeypatch.delenv("LOG_FILE", raising=False)
    monkeypatch.setenv("CONFIG_DIR", str(tmp_path))
    monkeypatch.setenv("FEEDBACK_SYNC_STARTUP", "1")

    sys.modules.pop("server", None)
    server_mod = importlib.import_module("server")
    monkeypatch.setattr(server_mod, "load_plugins", lambda *a, **kw: None)
    monkeypatch.setattr(server_mod, "startup_scan", lambda: None)

    # Add a probe route to server.app so the test can trigger a log write.
    @server_mod.app.get("/_test_log_probe")
    def _probe():
        logging.getLogger("feedBack.server").info("server_probe_event")
        return {"ok": True}

    known_id = str(uuid.uuid4())
    buf = io.StringIO()
    try:
        with TestClient(server_mod.app) as tc:
            # startup_events() has now run (including its configure_logging() call),
            # so the feedBack handlers are freshly created.  Redirect their stream
            # to buf NOW, after startup, so we capture the probe request's output.
            for h in logging.getLogger("feedBack").handlers:
                if isinstance(h, logging.StreamHandler) and not isinstance(
                    h, logging.FileHandler
                ):
                    h.stream = buf
            tc.get("/_test_log_probe", headers={"X-Request-ID": known_id})
    finally:
        # Remove the test route to avoid polluting server.app for other tests.
        server_mod.app.router.routes = [
            r for r in server_mod.app.router.routes
            if getattr(r, "path", None) != "/_test_log_probe"
        ]
        conn = getattr(getattr(server_mod, "meta_db", None), "conn", None)
        if conn is not None:
            conn.close()

    lines = [ln for ln in buf.getvalue().splitlines() if "server_probe_event" in ln]
    assert lines, "No log line captured from server.app probe route"
    parsed = json.loads(lines[0])
    assert parsed.get("request_id") == known_id, (
        f"server.app log line request_id {parsed.get('request_id')!r} != {known_id!r}"
    )
