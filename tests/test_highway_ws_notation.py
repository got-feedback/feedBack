"""Integration test for notation streaming on the highway WebSocket.

Spins up the real FastAPI app via TestClient against a temp DLC_DIR holding a
hand-authored notation sloppak, then asserts the wire contract end-to-end:

- `song_info` carries `has_notation: true` (and `false` without notation),
- `notation_info` streams after `sections` and before `anchors` (WS-order-B),
- `notation_measures` chunks carry every measure with beat times rounded,
- a notation-only arrangement (no `file:` key) still streams.
"""

from __future__ import annotations

import importlib
import json
import sys

import pytest
import yaml
from fastapi.testclient import TestClient


VALID_NOTATION = {
    "version": 1,
    "instrument": "piano",
    "staves": [
        {"id": "rh", "clef": "G2", "label": "Right Hand"},
        {"id": "lh", "clef": "F4", "label": "Left Hand"},
    ],
    "measures": [
        {
            "idx": 1,
            "t": 0.0,
            "ts": [4, 4],
            "tempo": 120.0,
            "staves": {
                "rh": {
                    "voices": [
                        {
                            "v": 1,
                            "beats": [
                                {"t": 0.0001234, "dur": 4, "notes": [{"midi": 64}]},
                                {"t": 0.5, "dur": 4, "notes": [{"midi": 67}]},
                            ],
                        }
                    ]
                },
                "lh": {
                    "voices": [
                        {
                            "v": 1,
                            "beats": [
                                {"t": 0.0, "dur": 1, "notes": [{"midi": 52}, {"midi": 60}]}
                            ],
                        }
                    ]
                },
            },
        },
        {
            "idx": 2,
            "t": 2.0,
            "staves": {
                "rh": {
                    "voices": [
                        {"v": 1, "beats": [{"t": 2.0, "dur": 2, "notes": [{"midi": 65}]}]}
                    ]
                }
            },
        },
    ],
}


def _write_sloppak(dlc_root, *, notation: bool, include_file: bool = True):
    pak = dlc_root / "wstest.sloppak"
    pak.mkdir()
    (pak / "arrangements").mkdir()

    entry = {"id": "keys", "name": "Keys"}
    if include_file:
        entry["file"] = "arrangements/keys.json"
        (pak / "arrangements" / "keys.json").write_text(
            json.dumps(
                {
                    "notes": [],
                    "chords": [],
                    "anchors": [],
                    "handshapes": [],
                    "templates": [],
                    "beats": [{"time": 0.0, "measure": 1}, {"time": 2.0, "measure": 2}],
                    "sections": [{"name": "intro", "number": 1, "time": 0.0}],
                }
            )
        )
    if notation:
        entry["notation"] = "notation_keys.json"
        (pak / "notation_keys.json").write_text(json.dumps(VALID_NOTATION))

    manifest = {
        "title": "WS Test",
        "artist": "Tester",
        "album": "",
        "year": 2026,
        "duration": 10.0,
        "arrangements": [entry],
        "stems": [],
    }
    (pak / "manifest.yaml").write_text(yaml.safe_dump(manifest, sort_keys=False))
    return pak


@pytest.fixture()
def make_client(tmp_path, monkeypatch):
    """Factory: build the DLC dir first, then import a fresh server bound to it."""

    def _make():
        monkeypatch.setenv("CONFIG_DIR", str(tmp_path / "config"))
        monkeypatch.setenv("DLC_DIR", str(tmp_path / "dlc"))
        monkeypatch.setenv("FEEDBACK_SYNC_STARTUP", "1")
        sys.modules.pop("server", None)
        server = importlib.import_module("server")
        monkeypatch.setattr(server, "load_plugins", lambda *a, **kw: None)
        monkeypatch.setattr(server, "startup_scan", lambda: None)
        monkeypatch.setattr(server, "SLOPPAK_CACHE_DIR", tmp_path / "cache")
        # ws_highway reads the cache dir through the appstate seam now.
        import appstate as _appstate
        monkeypatch.setattr(_appstate, "sloppak_cache_dir", tmp_path / "cache")
        return server

    (tmp_path / "dlc").mkdir()
    yield _make
    server = sys.modules.get("server")
    conn = getattr(getattr(server, "meta_db", None), "conn", None)
    if conn is not None:
        getattr(__import__("sys").modules.get("server"), "_join_background_db_threads", lambda: None)()
        conn.close()


def _drain(client, path, *, stop_type="anchors", limit=200):
    """Collect typed frames (skipping keepalive `loading` frames) until ready.

    Always drains through the ``ready`` terminal frame so the server task can
    finish cleanly — stopping mid-stream with TestClient leaves the server
    coroutine blocked on its next send, which can stall test teardown.  Returns
    only frames up to and including *stop_type* so callers can assert ordering
    without caring about later frame types (chord_templates, notes, ready).

    Asserts the stop_type frame was actually reached — silently returning a
    truncated stream would let ordering assertions pass vacuously.

    Note: the starlette TestClient WebSocketTestSession uses a synchronous
    portal that runs the ASGI app in a background thread. A per-receive
    threading timeout is not safe here — the daemon thread can block teardown
    when the test exits. Global CI job timeout is the correct safety net for
    WS server regressions that produce no frames at all.
    """

    frames = []
    stop_reached = False
    with client.websocket_connect(path) as ws:
        for _ in range(limit):
            msg = ws.receive_json()
            if msg.get("error"):
                raise AssertionError(f"WS error frame: {msg}")
            if msg.get("type") == "loading":
                continue
            if not stop_reached:
                frames.append(msg)
            if msg.get("type") == stop_type:
                stop_reached = True
            if msg.get("type") == "ready":
                break
    assert stop_reached, (
        f"terminal frame {stop_type!r} not reached within {limit} frames; "
        f"got {[f.get('type') for f in frames]}"
    )
    return frames


def test_notation_streams_in_ws_order_b(make_client):
    server = make_client()
    _write_sloppak(server._get_dlc_dir(), notation=True)
    with TestClient(server.app) as client:
        frames = _drain(client, "/ws/highway/wstest.sloppak?arrangement=0")

    order = [f["type"] for f in frames]
    assert order[0] == "song_info"
    assert frames[0]["has_notation"] is True

    i_sections = order.index("sections")
    i_info = order.index("notation_info")
    i_anchors = order.index("anchors")
    assert i_sections < i_info < i_anchors, order

    info = frames[i_info]
    assert info["instrument"] == "piano"
    assert [s["id"] for s in info["staves"]] == ["rh", "lh"]
    assert info["total"] == 2

    chunks = [f for f in frames if f["type"] == "notation_measures"]
    assert chunks, order
    # Every chunk (not just the first) must arrive between notation_info and anchors.
    chunk_positions = [i for i, f in enumerate(frames) if f["type"] == "notation_measures"]
    assert all(i_info < pos < i_anchors for pos in chunk_positions), (
        f"notation_measures chunk out of order: positions={chunk_positions} "
        f"notation_info={i_info} anchors={i_anchors}"
    )
    measures = [m for c in chunks for m in c["data"]]
    assert [m["idx"] for m in measures] == [1, 2]
    assert all(c["total"] == 2 for c in chunks)

    # measure_to_wire rounds beat times to 3 decimals on the hot path.
    rh_beats = measures[0]["staves"]["rh"]["voices"][0]["beats"]
    assert rh_beats[0]["t"] == 0.0


def test_notation_chunking_respects_chunk_size(make_client):
    server = make_client()
    pak_root = server._get_dlc_dir()
    many = dict(VALID_NOTATION)
    many["measures"] = [
        {"idx": i + 1, "t": float(i), "staves": {}} for i in range(70)
    ]
    pak = _write_sloppak(pak_root, notation=True)
    (pak / "notation_keys.json").write_text(json.dumps(many))

    with TestClient(server.app) as client:
        frames = _drain(client, "/ws/highway/wstest.sloppak?arrangement=0")

    chunks = [f for f in frames if f["type"] == "notation_measures"]
    sizes = [len(c["data"]) for c in chunks]
    assert sum(sizes) == 70
    assert max(sizes) <= 32
    assert sizes[:-1] == [32] * (len(sizes) - 1)  # all but last chunk are full


def test_notation_only_arrangement_streams_without_file(make_client):
    server = make_client()
    _write_sloppak(server._get_dlc_dir(), notation=True, include_file=False)
    with TestClient(server.app) as client:
        frames = _drain(client, "/ws/highway/wstest.sloppak?arrangement=0")

    order = [f["type"] for f in frames]
    assert frames[0]["has_notation"] is True
    assert "notation_info" in order and "notation_measures" in order


def test_no_notation_key_means_has_notation_false(make_client):
    server = make_client()
    _write_sloppak(server._get_dlc_dir(), notation=False)
    with TestClient(server.app) as client:
        frames = _drain(client, "/ws/highway/wstest.sloppak?arrangement=0")

    order = [f["type"] for f in frames]
    assert frames[0]["has_notation"] is False
    assert "notation_info" not in order
    assert "notation_measures" not in order
