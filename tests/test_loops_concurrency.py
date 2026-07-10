"""Concurrent unnamed loop saves must get unique names.

`save_loop` auto-names an unnamed loop `Loop {count+1}`. If the `COUNT(*)` runs
outside the DB lock (as it did before the fix), two simultaneous unnamed POSTs
read the same count and both mint the same name. A `threading.Barrier` releases
all workers into `save_loop` at once to force that interleave.

Single-user app, so this race is unlikely in practice — but the fix is one lock
scope, and the test pins it.
"""

import threading

import pytest

import appstate
from metadata_db import MetadataDB
from routers import loops


@pytest.fixture()
def meta_db(tmp_path):
    prev = appstate.meta_db
    db = MetadataDB(tmp_path)
    appstate.configure(meta_db=db)
    yield db
    db.conn.close()
    appstate.configure(meta_db=prev)


def test_concurrent_unnamed_saves_get_unique_names(meta_db):
    workers = 16
    barrier = threading.Barrier(workers)
    names, errors = [], []
    lock = threading.Lock()

    def save():
        try:
            barrier.wait()                       # release all at once
            r = loops.save_loop({"filename": "song.feedpak", "start": 0.0, "end": 1.0})
            with lock:
                names.append(r["name"])
        except Exception as e:                   # noqa: BLE001 — surface any thread error
            with lock:
                errors.append(e)

    threads = [threading.Thread(target=save) for _ in range(workers)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()

    assert not errors, errors
    assert len(names) == workers
    # The load-bearing assertion: no two auto-named loops collide.
    assert len(set(names)) == workers, f"duplicate loop names: {sorted(names)}"
    # And the DB agrees — every insert landed.
    stored = meta_db.conn.execute(
        "SELECT COUNT(*) FROM loops WHERE filename = ?", ("song.feedpak",)
    ).fetchone()[0]
    assert stored == workers


def test_list_and_save_do_not_error_under_interleave(meta_db):
    """A read overlapping writes must not raise (shared connection, one lock)."""
    stop = threading.Event()
    errors = []

    def reader():
        while not stop.is_set():
            try:
                loops.list_loops("song.feedpak")
            except Exception as e:               # noqa: BLE001
                errors.append(e)

    r = threading.Thread(target=reader)
    r.start()
    try:
        for i in range(40):
            loops.save_loop({"filename": "song.feedpak", "name": f"n{i}", "start": 0.0, "end": 1.0})
    finally:
        stop.set()
        r.join()
    assert not errors, errors
