"""A client that disconnects mid-stream is routine, not a logged error.

The highway WS streams ~15 message batches before its keep-alive loop. A
disconnect during that streaming used to fall through to the blanket
`except Exception` and log `highway_ws unhandled error`. The dedicated
`except WebSocketDisconnect: return` makes it quiet.
"""

import asyncio
import importlib
import json
import logging
import sys

import pytest
import yaml
from fastapi import WebSocketDisconnect


def _write_sloppak(dlc_root):
    pak = dlc_root / "disc.sloppak"
    pak.mkdir(parents=True)
    (pak / "arrangements").mkdir()
    (pak / "arrangements" / "lead.json").write_text(json.dumps({
        "notes": [], "chords": [], "anchors": [], "handshapes": [],
        "templates": [], "beats": [{"time": 0.0, "measure": 1}],
        "sections": [{"name": "intro", "number": 1, "time": 0.0}],
    }))
    (pak / "manifest.yaml").write_text(yaml.safe_dump({
        "title": "Disc", "artist": "T", "album": "", "year": 2026, "duration": 10.0,
        "arrangements": [{"id": "lead", "name": "Lead", "file": "arrangements/lead.json"}],
        "stems": [],
    }, sort_keys=False))
    return pak


class _DisconnectingWS:
    """Accepts, then raises WebSocketDisconnect on the first streamed send —
    i.e. a client that drops mid-stream."""
    def __init__(self):
        self.sends = 0

    async def accept(self):
        pass

    async def send_json(self, data):
        self.sends += 1
        # Raise only on the FIRST send. If the handler wrongly kept streaming
        # after catching the disconnect, later sends would succeed and `sends`
        # would climb past 1 — the exactly-one assertion catches that.
        if self.sends == 1:
            raise WebSocketDisconnect(code=1001)

    async def receive_text(self):
        raise WebSocketDisconnect(code=1001)

    async def close(self):
        pass


@pytest.fixture()
def server(tmp_path, monkeypatch):
    (tmp_path / "dlc").mkdir()
    monkeypatch.setenv("CONFIG_DIR", str(tmp_path / "config"))
    monkeypatch.setenv("DLC_DIR", str(tmp_path / "dlc"))
    monkeypatch.setenv("FEEDBACK_SKIP_STARTUP_TASKS", "1")
    sys.modules.pop("server", None)
    mod = importlib.import_module("server")
    yield mod, tmp_path / "dlc"
    conn = getattr(getattr(mod, "meta_db", None), "conn", None)
    if conn is not None:
        getattr(mod, "_join_background_db_threads", lambda: None)()
        conn.close()
    sys.modules.pop("server", None)


class _Capture(logging.Handler):
    def __init__(self):
        super().__init__()
        self.messages = []

    def emit(self, record):
        self.messages.append(record.getMessage())


def test_midstream_disconnect_is_not_logged_as_error(server):
    """The first streamed send (`loading`) raises WebSocketDisconnect; the
    handler must return quietly, not log `highway_ws unhandled error`.

    A raw handler on `feedBack.server` is used rather than pytest's `caplog`
    because `configure_logging()` (run at server import) reroutes that logger
    through the structlog pipeline, which caplog's fixture doesn't observe.
    """
    _server, dlc = server
    _write_sloppak(dlc)
    from routers.ws_highway import highway_ws

    cap = _Capture()
    cap.setLevel(logging.ERROR)
    lg = logging.getLogger("feedBack.server")
    lg.addHandler(cap)
    try:
        ws = _DisconnectingWS()
        asyncio.run(highway_ws(ws, "disc.sloppak", arrangement=0))  # must not raise
    finally:
        lg.removeHandler(cap)

    assert ws.sends == 1, f"handler kept streaming after the disconnect ({ws.sends} sends)"
    unhandled = [m for m in cap.messages if "highway_ws unhandled error" in m]
    assert not unhandled, f"disconnect logged as unhandled error: {unhandled}"
