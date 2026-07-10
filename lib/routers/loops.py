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
    rows = appstate.meta_db.conn.execute(
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
    if not name:
        count = appstate.meta_db.conn.execute(
            "SELECT COUNT(*) FROM loops WHERE filename = ?", (filename,)
        ).fetchone()[0]
        name = f"Loop {count + 1}"
    with appstate.meta_db._lock:
        appstate.meta_db.conn.execute(
            "INSERT INTO loops (filename, name, start_time, end_time) VALUES (?, ?, ?, ?)",
            (filename, name, float(start), float(end))
        )
        appstate.meta_db.conn.commit()
    return {"ok": True, "name": name}


@router.delete("/api/loops/{loop_id}")
def delete_loop(loop_id: int):
    with appstate.meta_db._lock:
        appstate.meta_db.conn.execute("DELETE FROM loops WHERE id = ?", (loop_id,))
        appstate.meta_db.conn.commit()
    return {"ok": True}
