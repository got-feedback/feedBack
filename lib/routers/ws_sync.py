"""Session-sync relay WebSocket — /ws/sync/{session_id} (feedBack#1030).

A deliberately dumb fan-out room: a JSON text frame received from one client
is forwarded verbatim to every OTHER client connected to the same session id.
The server interprets nothing beyond the limits below — message schemas are
owned entirely by consumers. First consumer: splitscreen's LAN follower mode
(feedBack-plugin-splitscreen#21), which relays playhead/playstate/song-change
frames from a host window to view-only followers on other LAN devices.

Design points (full spec in the issue):

- Rooms are created on first join and garbage-collected when the last socket
  leaves. No history, no replay, no persistence — a late joiner simply waits
  for the next frame. Consumers that need state on join re-send it themselves
  (splitscreen answers every follower ``hello`` with a fresh ``config``).
- That statelessness is what makes consumer crash-recovery work: a host that
  relaunches and rejoins the same session id resumes publishing to its
  reconnecting subscribers with no server-side coordination, and an idle room
  is indistinguishable from a nonexistent one.
- ``session_id`` is client-generated and opaque (``[A-Za-z0-9_-]{4,64}``);
  consumers pick their own id policy (splitscreen uses a short typeable,
  persistent room key).
- DoS hygiene for a port that may be LAN-exposed: frame-size cap, per-room and
  total-room caps, and a per-socket inbound token-bucket rate cap. Over-limit
  sockets are closed with a policy code; the room carries on. A peer that dies
  mid-fan-out is dropped without wedging delivery to the rest.
"""

import asyncio
import logging
import re
import time

from fastapi import APIRouter, WebSocket

log = logging.getLogger("feedBack.server")

router = APIRouter()

_SESSION_ID_RE = re.compile(r"^[A-Za-z0-9_-]{4,64}$")

# Limits. Sized generously above the first consumer's needs (splitscreen
# publishes time frames at ~15-20 Hz to a handful of viewers) while bounding
# what an open LAN port can be made to do. All module-level so tests (and a
# desperate operator) can override them.
MAX_FRAME_BYTES = 16 * 1024
MAX_CLIENTS_PER_ROOM = 16
MAX_ROOMS = 32
RATE_MSGS_PER_SEC = 120.0  # sustained inbound frames per socket
RATE_BURST = 240.0  # token-bucket burst headroom

# RFC 6455 close codes.
_WS_UNSUPPORTED_DATA = 1003  # binary frame on a text-only relay
_WS_POLICY_VIOLATION = 1008  # invalid session id / rate cap exceeded
_WS_MSG_TOO_BIG = 1009
_WS_TRY_AGAIN_LATER = 1013  # room or server at capacity

# session_id → {socket: per-socket send lock}. The lock serializes concurrent
# fan-out sends to the same peer (two publishers relaying at once must not
# interleave writes on a third socket's transport).
_rooms: dict[str, dict[WebSocket, asyncio.Lock]] = {}


async def _send_locked(peer: WebSocket, lock: asyncio.Lock, text: str) -> None:
    async with lock:
        await peer.send_text(text)


@router.websocket("/ws/sync/{session_id}")
async def sync_ws(websocket: WebSocket, session_id: str):
    """Join the fan-out room *session_id*; relay every inbound text frame."""
    await websocket.accept()

    if not _SESSION_ID_RE.fullmatch(session_id):
        await websocket.close(code=_WS_POLICY_VIOLATION, reason="invalid session id")
        return

    # Capacity checks and insertion run with no await between them, so
    # concurrent joiners on the event loop can't race past the caps.
    room = _rooms.get(session_id)
    if room is None:
        if len(_rooms) >= MAX_ROOMS:
            await websocket.close(code=_WS_TRY_AGAIN_LATER, reason="too many active sessions")
            return
        room = _rooms[session_id] = {}
        log.debug("ws_sync: room %s created", session_id)
    elif len(room) >= MAX_CLIENTS_PER_ROOM:
        await websocket.close(code=_WS_TRY_AGAIN_LATER, reason="session full")
        return
    room[websocket] = asyncio.Lock()

    tokens = RATE_BURST
    last_refill = time.monotonic()

    try:
        while True:
            message = await websocket.receive()
            if message["type"] == "websocket.disconnect":
                break
            text = message.get("text")
            if text is None:
                await websocket.close(code=_WS_UNSUPPORTED_DATA, reason="text frames only")
                break
            if len(text.encode("utf-8", errors="ignore")) > MAX_FRAME_BYTES:
                await websocket.close(code=_WS_MSG_TOO_BIG, reason="frame too large")
                break

            now = time.monotonic()
            tokens = min(RATE_BURST, tokens + (now - last_refill) * RATE_MSGS_PER_SEC)
            last_refill = now
            tokens -= 1.0
            if tokens < 0:
                await websocket.close(code=_WS_POLICY_VIOLATION, reason="rate cap exceeded")
                break

            peers = [(ws, lock) for ws, lock in room.items() if ws is not websocket]
            if not peers:
                continue
            results = await asyncio.gather(
                *(_send_locked(ws, lock, text) for ws, lock in peers),
                return_exceptions=True,
            )
            # A peer that failed mid-send is dropped from the room here; its
            # own handler finishes cleanup (the finally below) when its
            # receive loop observes the disconnect.
            for (peer, _lock), result in zip(peers, results):
                if isinstance(result, Exception):
                    room.pop(peer, None)
    finally:
        room.pop(websocket, None)
        # Guard against deleting a NEW room another joiner created after this
        # one emptied (only possible for a dict that is no longer ours).
        if not room and _rooms.get(session_id) is room:
            del _rooms[session_id]
            log.debug("ws_sync: room %s closed", session_id)
