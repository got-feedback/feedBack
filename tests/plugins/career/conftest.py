import sqlite3
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent.parent.parent / 'plugins' / 'career'))

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

# Drop a sibling 'routes' cached by another plugin's tests (bare-name collision).
sys.modules.pop('routes', None)
import routes as career_routes


class FakeMetaDb:
    """song_stats-only stand-in for MetadataDB (the plugin reads nothing else)."""

    def __init__(self):
        self.conn = sqlite3.connect(":memory:", check_same_thread=False)
        self.conn.execute(
            """CREATE TABLE song_stats (
                   filename TEXT, arrangement TEXT, best_accuracy REAL
               )"""
        )
        self.conn.execute("CREATE TABLE songs (filename TEXT, title TEXT, artist TEXT)")

    def add(self, filename, arrangement, best_accuracy, in_library=True):
        self.conn.execute("INSERT INTO song_stats VALUES (?, ?, ?)",
                          (filename, arrangement, best_accuracy))
        if in_library:
            self.conn.execute(
                "INSERT INTO songs SELECT ?, ?, ? WHERE NOT EXISTS "
                "(SELECT 1 FROM songs WHERE filename = ?)",
                (filename, filename.replace(".feedpak", "").title(), "Test Artist", filename))
        self.conn.commit()


@pytest.fixture(autouse=True)
def _bind_career_routes():
    """Keep sys.modules['routes'] pointing at THIS plugin's routes for these tests."""
    prev = sys.modules.get('routes')
    sys.modules['routes'] = career_routes
    try:
        yield
    finally:
        if prev is not None:
            sys.modules['routes'] = prev
        else:
            sys.modules.pop('routes', None)


@pytest.fixture(autouse=True)
def _reset_state():
    # Module state outlives tests when the module stays imported — reset the
    # mutable bits so ordering can't leak downloads/content between tests.
    career_routes._state["downloads"] = {}
    yield


@pytest.fixture
def meta_db():
    return FakeMetaDb()


@pytest.fixture
def client(tmp_path, meta_db):
    app = FastAPI()
    career_routes.setup(app, {"config_dir": str(tmp_path), "meta_db": meta_db})
    return TestClient(app)
