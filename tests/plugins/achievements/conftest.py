import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent.parent.parent / 'plugins' / 'achievements'))

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

import routes as ach_routes


@pytest.fixture(autouse=True)
def _no_live_drain():
    # routes now defaults the wall URL to the live onrender service, so setup()
    # would auto-start the drain thread. Disable it for every test so no test
    # ever POSTs to production; the drain logic is exercised via _drain_once()
    # with an injected poster instead.
    ach_routes._WALL_URL = ""
    ach_routes._drain_started = False
    yield


@pytest.fixture
def client(tmp_path):
    app = FastAPI()
    ach_routes.setup(app, {"config_dir": str(tmp_path)})
    return TestClient(app)
