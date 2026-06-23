import importlib
import sys

import pytest
from fastapi.testclient import TestClient


@pytest.fixture()
def client(tmp_path, monkeypatch):
    monkeypatch.setenv("CONFIG_DIR", str(tmp_path))
    monkeypatch.setenv("FEEDBACK_SKIP_STARTUP_TASKS", "1")
    sys.modules.pop("server", None)
    server = importlib.import_module("server")
    with TestClient(server.app) as tc:
        try:
            yield tc
        finally:
            for attr in ("meta_db", "audio_effect_mappings"):
                conn = getattr(getattr(server, attr, None), "conn", None)
                if conn is not None:
                    conn.close()


def _post_mapping(client, **overrides):
    payload = {
        "song_key": "settings-v1-song",
        "filename": "Artist - Song_p.archive",
        "tone_key": "Dist",
        "provider_id": "nam-tone",
        "provider_ref": "preset:42",
        "label": "NAM fallback",
        "source": "manual",
        "active": True,
    }
    payload.update(overrides)
    response = client.post("/api/audio-effects/mappings", json=payload)
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["ok"] is True
    return body["mapping"]


def test_provider_mappings_coexist_and_active_selection_moves(client):
    nam = _post_mapping(client)
    rig = _post_mapping(
        client,
        provider_id="rig-builder",
        provider_ref="chain:99",
        label="Full rig",
        active=False,
    )

    assert nam["active"] is True
    assert rig["active"] is False

    listed = client.get("/api/audio-effects/mappings", params={"song_key": "settings-v1-song"})
    assert listed.status_code == 200, listed.text
    mappings = listed.json()["mappings"]
    assert {item["provider_id"] for item in mappings} == {"nam-tone", "rig-builder"}
    assert next(item for item in mappings if item["active"])["provider_id"] == "nam-tone"

    activated = client.post(
        f"/api/audio-effects/mappings/{rig['id']}/activate",
        json={"provider_id": "rig-builder"},
    )
    assert activated.status_code == 200, activated.text
    assert activated.json()["mapping"]["active"] is True

    after = client.get("/api/audio-effects/mappings", params={"song_key": "settings-v1-song"}).json()["mappings"]
    assert next(item for item in after if item["active"])["provider_id"] == "rig-builder"


def test_upsert_updates_provider_mapping_without_colliding_with_other_provider(client):
    first = _post_mapping(client, active=False)
    second = _post_mapping(client, provider_ref="preset:43", label="Updated", active=False)
    rig = _post_mapping(client, provider_id="rig-builder", provider_ref="chain:1", active=False)

    assert second["id"] == first["id"]
    assert second["provider_ref"] == "preset:43"
    assert second["label"] == "Updated"
    assert rig["id"] != first["id"]

    listed = client.get("/api/audio-effects/mappings", params={"filename": "Artist - Song_p.archive"}).json()["mappings"]
    assert len(listed) == 2


def test_delete_can_be_scoped_to_provider_id(client):
    mapping = _post_mapping(client, active=False)

    denied = client.delete(f"/api/audio-effects/mappings/{mapping['id']}", params={"provider_id": "rig-builder"})
    assert denied.status_code == 404

    deleted = client.delete(f"/api/audio-effects/mappings/{mapping['id']}", params={"provider_id": "nam-tone"})
    assert deleted.status_code == 200
    assert deleted.json()["ok"] is True

    listed = client.get("/api/audio-effects/mappings", params={"song_key": "settings-v1-song"}).json()["mappings"]
    assert listed == []


@pytest.mark.parametrize("bad", [True, False, 0, 1, ["x"], {"a": 1}])
def test_upsert_rejects_non_string_fields(client, bad):
    response = client.post(
        "/api/audio-effects/mappings",
        json={
            "song_key": "settings-v1-song",
            "tone_key": "Dist",
            "provider_id": bad,
            "provider_ref": "preset:42",
        },
    )
    assert response.status_code == 400, response.text
    assert "provider_id" in response.json()["error"]


def test_activate_rejects_non_string_provider_id(client):
    mapping = _post_mapping(client, active=False)
    # A falsey non-string provider_id must be a 400, not a silent unscoped activate.
    response = client.post(
        f"/api/audio-effects/mappings/{mapping['id']}/activate",
        json={"provider_id": False},
    )
    assert response.status_code == 400, response.text
    assert "provider_id" in response.json()["error"]


def test_oversized_mapping_id_is_a_clean_miss(client):
    _post_mapping(client)
    huge = 10 ** 40  # well outside SQLite's signed int64 range
    activated = client.post(f"/api/audio-effects/mappings/{huge}/activate", json={})
    assert activated.status_code == 404, activated.text
    deleted = client.delete(f"/api/audio-effects/mappings/{huge}")
    assert deleted.status_code == 404, deleted.text


def test_clear_active_mapping_keeps_provider_rows(client):
    _post_mapping(client)

    cleared = client.delete(
        "/api/audio-effects/active-mapping",
        params={"song_key": "settings-v1-song", "tone_key": "Dist"},
    )
    assert cleared.status_code == 200, cleared.text
    assert cleared.json()["cleared"] is True

    listed = client.get("/api/audio-effects/mappings", params={"song_key": "settings-v1-song"}).json()["mappings"]
    assert len(listed) == 1
    assert listed[0]["active"] is False
