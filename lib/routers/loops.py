"""Practice loops — saved A/B regions per song.

Extracted verbatim from ``server.py`` (R3); only the decorator receiver
(``@app`` -> ``@router``) and the singleton reads (``meta_db`` ->
``appstate.meta_db``) changed. See ``appstate.py`` for why the reads stay
module attributes.
"""

from fastapi import APIRouter

import appstate

router = APIRouter()


@router.get("/api/loops")
def list_loops(filename: str):
    # Hold the DB lock for the read: the shared single connection
    # (check_same_thread=False) is serialized through meta_db._lock by every
    # writer, so an unlocked SELECT here can overlap a POST/DELETE commit.
    db = appstate.meta_db
    with db._lock:
        rows = db.conn.execute(
            "SELECT id, name, start_time, end_time FROM loops WHERE filename = ? ORDER BY start_time",
            (filename,)
        ).fetchall()
    return [{"id": r[0], "name": r[1], "start": r[2], "end": r[3]} for r in rows]


@router.post("/api/loops")
def save_loop(data: dict):
    filename = data.get("filename", "")
    name = data.get("name", "").strip()
    start = data.get("start")
    end = data.get("end")
    if not filename or start is None or end is None:
        return {"error": "Missing fields"}
    db = appstate.meta_db
    with db._lock:
        # COUNT + INSERT under one lock so two unnamed POSTs can't read the same
        # count and both mint "Loop N" (the count is only used to name the row).
        if not name:
            count = db.conn.execute(
                "SELECT COUNT(*) FROM loops WHERE filename = ?", (filename,)
            ).fetchone()[0]
            name = f"Loop {count + 1}"
        db.conn.execute(
            "INSERT INTO loops (filename, name, start_time, end_time) VALUES (?, ?, ?, ?)",
            (filename, name, float(start), float(end))
        )
        db.conn.commit()
    return {"ok": True, "name": name}


@router.delete("/api/loops/{loop_id}")
def delete_loop(loop_id: int):
    with appstate.meta_db._lock:
        appstate.meta_db.conn.execute("DELETE FROM loops WHERE id = ?", (loop_id,))
        appstate.meta_db.conn.commit()
    return {"ok": True}
