"""Tests for the session-sync relay WebSocket (/ws/sync/{session_id}).

Behavior tests run against a minimal FastAPI app carrying just the router
(fast — no full-server import); one integration test imports the real server
to pin that the route is actually mounted there.

Covers the feedBack#1030 acceptance list: bidirectional fan-out, late join,
sender never echoed, room garbage collection, and the limit closes (invalid
session id, binary frames, frame size, room size, room count, rate cap) —
including that one client tripping a limit doesn't disturb the others.
"""

from __future__ import annotations

import importlib
import sys

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from starlette.websockets import WebSocketDisconnect

from routers import ws_sync


@pytest.fixture(autouse=True)
def _clean_rooms():
    ws_sync._rooms.clear()
    yield
    ws_sync._rooms.clear()


@pytest.fixture()
def client():
    app = FastAPI()
    app.include_router(ws_sync.router)
    with TestClient(app) as c:
        yield c


def _expect_close(ws, code):
    with pytest.raises(WebSocketDisconnect) as exc:
        ws.receive_text()
    assert exc.value.code == code


# ── Fan-out semantics ────────────────────────────────────────────────────────

def test_two_clients_relay_both_directions_and_no_echo(client):
    with client.websocket_connect("/ws/sync/ROOM01") as a, \
         client.websocket_connect("/ws/sync/ROOM01") as b:
        a.send_text('{"type":"time","t":1.5}')
        assert b.receive_text() == '{"type":"time","t":1.5}'
        b.send_text('{"type":"hello"}')
        # A's first inbound frame is B's hello — NOT an echo of its own send.
        assert a.receive_text() == '{"type":"hello"}'


def test_late_joiner_receives_subsequent_frames(client):
    with client.websocket_connect("/ws/sync/ROOM02") as a, \
         client.websocket_connect("/ws/sync/ROOM02") as b:
        a.send_text("f1")
        assert b.receive_text() == "f1"
        with client.websocket_connect("/ws/sync/ROOM02") as c:
            a.send_text("f2")
            assert b.receive_text() == "f2"
            assert c.receive_text() == "f2"


def test_rooms_are_isolated(client):
    with client.websocket_connect("/ws/sync/ROOMA1") as a, \
         client.websocket_connect("/ws/sync/ROOMB1") as b, \
         client.websocket_connect("/ws/sync/ROOMA1") as a2:
        a.send_text("for-room-a")
        assert a2.receive_text() == "for-room-a"
        # B (other room) got nothing: prove it by relaying within B's room.
        with client.websocket_connect("/ws/sync/ROOMB1") as b2:
            b2.send_text("for-room-b")
            assert b.receive_text() == "for-room-b"


def test_client_disconnect_does_not_disrupt_remaining(client):
    with client.websocket_connect("/ws/sync/ROOM03") as a, \
         client.websocket_connect("/ws/sync/ROOM03") as b:
        with client.websocket_connect("/ws/sync/ROOM03") as c:
            a.send_text("before")
            assert b.receive_text() == "before"
            assert c.receive_text() == "before"
        # C is gone; relay between A and B continues.
        a.send_text("after")
        assert b.receive_text() == "after"


def test_room_garbage_collected_when_last_client_leaves(client):
    with client.websocket_connect("/ws/sync/ROOM04") as a:
        with client.websocket_connect("/ws/sync/ROOM04") as b:
            a.send_text("x")
            assert b.receive_text() == "x"
            assert "ROOM04" in ws_sync._rooms
    assert "ROOM04" not in ws_sync._rooms
    assert ws_sync._rooms == {}


# ── Limit enforcement ────────────────────────────────────────────────────────

@pytest.mark.parametrize("bad_id", ["abc", "x" * 65, "has space", "bad$id", "nope!"])
def test_invalid_session_id_closed_with_policy_code(client, bad_id):
    with client.websocket_connect(f"/ws/sync/{bad_id}") as ws:
        _expect_close(ws, 1008)
    assert ws_sync._rooms == {}


def test_binary_frame_closes_with_unsupported_data(client):
    with client.websocket_connect("/ws/sync/ROOM05") as ws:
        ws.send_bytes(b"\x00\x01")
        _expect_close(ws, 1003)


def test_oversized_frame_closes_sender_only(client):
    with client.websocket_connect("/ws/sync/ROOM06") as a, \
         client.websocket_connect("/ws/sync/ROOM06") as b, \
         client.websocket_connect("/ws/sync/ROOM06") as c:
        a.send_text("x" * (ws_sync.MAX_FRAME_BYTES + 1))
        _expect_close(a, 1009)
        # The room carries on without A.
        b.send_text("still-alive")
        assert c.receive_text() == "still-alive"


def test_room_client_cap(client, monkeypatch):
    monkeypatch.setattr(ws_sync, "MAX_CLIENTS_PER_ROOM", 2)
    with client.websocket_connect("/ws/sync/ROOM07") as a, \
         client.websocket_connect("/ws/sync/ROOM07") as b, \
         client.websocket_connect("/ws/sync/ROOM07") as c:
        _expect_close(c, 1013)
        a.send_text("two-is-fine")
        assert b.receive_text() == "two-is-fine"


def test_total_room_cap(client, monkeypatch):
    monkeypatch.setattr(ws_sync, "MAX_ROOMS", 1)
    with client.websocket_connect("/ws/sync/ROOM08"):
        with client.websocket_connect("/ws/sync/ROOM09") as overflow:
            _expect_close(overflow, 1013)
        # Joining the EXISTING room is still fine at the room cap.
        with client.websocket_connect("/ws/sync/ROOM08"):
            pass


def test_rate_cap_closes_flooding_sender(client, monkeypatch):
    monkeypatch.setattr(ws_sync, "RATE_BURST", 3.0)
    monkeypatch.setattr(ws_sync, "RATE_MSGS_PER_SEC", 0.0)
    with client.websocket_connect("/ws/sync/ROOM10") as a, \
         client.websocket_connect("/ws/sync/ROOM10") as b:
        for i in range(3):
            a.send_text(f"burst-{i}")
        for i in range(3):
            assert b.receive_text() == f"burst-{i}"
        a.send_text("one-too-many")
        _expect_close(a, 1008)
        # The over-limit frame was dropped, not relayed, and B lives on.
        with client.websocket_connect("/ws/sync/ROOM10") as c:
            c.send_text("fresh-socket")
            assert b.receive_text() == "fresh-socket"


# ── Real-app integration ─────────────────────────────────────────────────────

def test_route_mounted_on_real_server(tmp_path, monkeypatch):
    monkeypatch.setenv("CONFIG_DIR", str(tmp_path / "config"))
    monkeypatch.setenv("DLC_DIR", str(tmp_path / "dlc"))
    monkeypatch.setenv("FEEDBACK_SYNC_STARTUP", "1")
    sys.modules.pop("server", None)
    server = importlib.import_module("server")
    monkeypatch.setattr(server, "load_plugins", lambda *a, **kw: None)
    monkeypatch.setattr(server, "startup_scan", lambda: None)

    with TestClient(server.app) as client:
        with client.websocket_connect("/ws/sync/REALAPP") as a, \
             client.websocket_connect("/ws/sync/REALAPP") as b:
            a.send_text('{"type":"time","t":0}')
            assert b.receive_text() == '{"type":"time","t":0}'
