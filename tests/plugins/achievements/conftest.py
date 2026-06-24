import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent.parent.parent / 'plugins' / 'achievements'))

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

import routes as ach_routes


@pytest.fixture
def client(tmp_path):
    app = FastAPI()
    ach_routes.setup(app, {"config_dir": str(tmp_path)})
    return TestClient(app)
