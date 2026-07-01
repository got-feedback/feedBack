"""Unit tests for config logic (module-level helpers) and config read/write via HTTP."""

import json
import pytest
import routes


# ── _migrate_custom_tuning ────────────────────────────────────────────────────

class TestMigrateCustomTuning:
    def test_old_flat_list_guitar6(self):
        result = routes._migrate_custom_tuning("My Tuning", [82.41, 110.00, 146.83, 196.00, 246.94, 329.63])
        assert result == {"instrument": "guitar-6", "strings": [82.41, 110.00, 146.83, 196.00, 246.94, 329.63]}

    def test_old_flat_list_bass4(self):
        result = routes._migrate_custom_tuning("Drop D Bass", [36.71, 55.00, 73.42, 98.00])
        assert result["instrument"] == "bass-4"
        assert result["strings"] == [36.71, 55.00, 73.42, 98.00]

    def test_old_flat_list_bass5(self):
        result = routes._migrate_custom_tuning("5-String", [30.87, 41.20, 55.00, 73.42, 98.00])
        assert result["instrument"] == "bass-5"

    def test_old_flat_list_guitar7(self):
        result = routes._migrate_custom_tuning("7-String", [61.74, 82.41, 110.00, 146.83, 196.00, 246.94, 329.63])
        assert result["instrument"] == "guitar-7"

    def test_old_flat_list_guitar8(self):
        strings = [46.25, 61.74, 82.41, 110.00, 146.83, 196.00, 246.94, 329.63]
        result = routes._migrate_custom_tuning("8-String", strings)
        assert result["instrument"] == "guitar-8"

    def test_old_flat_list_unknown_count_defaults_guitar6(self):
        result = routes._migrate_custom_tuning("3-String", [100.0, 200.0, 300.0])
        assert result["instrument"] == "guitar-6"

    def test_new_dict_format_passthrough(self):
        value = {"instrument": "bass-4", "strings": [41.20, 55.00, 73.42, 98.00]}
        result = routes._migrate_custom_tuning("My Bass", value)
        assert result == value

    def test_malformed_dict_returns_empty_guitar6(self):
        result = routes._migrate_custom_tuning("Bad", {"foo": "bar"})
        assert result == {"instrument": "guitar-6", "strings": []}


# ── Config read/write via HTTP ────────────────────────────────────────────────

class TestConfigDefaults:
    def test_get_returns_all_default_keys(self, client):
        r = client.get("/api/plugins/tuner/config")
        assert r.status_code == 200
        body = r.json()
        assert body["lastTuning"] == "Standard"
        assert body["lastInstrument"] == "guitar-6"
        assert body["audioInputMode"] == "auto"
        assert body["showFloatingButton"] is True
        assert body["visualizationMode"] == "default"
        assert body["customTunings"] == {}
        assert body["disabledTunings"] == []

    def test_get_does_not_include_default_tunings(self, client):
        # defaultTunings moved to GET /api/tunings (core tuning.read capability).
        body = client.get("/api/plugins/tuner/config").json()
        assert "defaultTunings" not in body


class TestConfigPersistence:
    def test_partial_update_persisted(self, client):
        client.post("/api/plugins/tuner/config", json={"lastTuning": "Drop D"})
        r = client.get("/api/plugins/tuner/config")
        assert r.json()["lastTuning"] == "Drop D"

    def test_unmodified_fields_survive_partial_update(self, client):
        client.post("/api/plugins/tuner/config", json={"lastTuning": "Drop D"})
        client.post("/api/plugins/tuner/config", json={"visualizationMode": "strobe"})
        body = client.get("/api/plugins/tuner/config").json()
        assert body["lastTuning"] == "Drop D"
        assert body["visualizationMode"] == "strobe"

    def test_default_tunings_not_written_to_file(self, client, config_dir):
        client.post("/api/plugins/tuner/config", json={
            "lastTuning": "Open G",
            "defaultTunings": {"guitar-6": {"Standard": []}},
        })
        saved = json.loads((config_dir / "tuner.json").read_text())
        assert "defaultTunings" not in saved

    def test_invalid_audio_mode_resets_to_auto(self, client):
        client.post("/api/plugins/tuner/config", json={"audioInputMode": "invalid"})
        body = client.get("/api/plugins/tuner/config").json()
        assert body["audioInputMode"] == "auto"

    def test_valid_audio_mode_browser_accepted(self, client):
        client.post("/api/plugins/tuner/config", json={"audioInputMode": "browser"})
        assert client.get("/api/plugins/tuner/config").json()["audioInputMode"] == "browser"

    def test_auto_open_defaults_false(self, client):
        assert client.get("/api/plugins/tuner/config").json()["autoOpenOnTuningChange"] is False

    def test_auto_open_true_accepted(self, client):
        client.post("/api/plugins/tuner/config", json={"autoOpenOnTuningChange": True})
        assert client.get("/api/plugins/tuner/config").json()["autoOpenOnTuningChange"] is True

    def test_auto_open_fail_closed_on_non_bool(self, client):
        # A hand-edited / bad-client non-boolean (e.g. the string "false") must NOT be
        # coerced to True by bool() — the opt-in stays off.
        for bad in ("false", "0", "1", "yes", 1, {}):
            client.post("/api/plugins/tuner/config", json={"autoOpenOnTuningChange": bad})
            assert client.get("/api/plugins/tuner/config").json()["autoOpenOnTuningChange"] is False, bad

    def test_disabled_tunings_strips_entries_without_colon(self, client):
        client.post("/api/plugins/tuner/config", json={
            "disabledTunings": ["guitar-6:Drop D", "legacy-entry", "bass-4:Standard"]
        })
        body = client.get("/api/plugins/tuner/config").json()
        assert "legacy-entry" not in body["disabledTunings"]
        assert "guitar-6:Drop D" in body["disabledTunings"]
        assert "bass-4:Standard" in body["disabledTunings"]

    def test_custom_tuning_old_format_migrated_on_read(self, client, config_dir):
        (config_dir / "tuner.json").write_text(json.dumps({
            "customTunings": {"My Tuning": [82.41, 110.0, 146.83, 196.0, 246.94, 329.63]}
        }))
        body = client.get("/api/plugins/tuner/config").json()
        assert body["customTunings"]["My Tuning"]["instrument"] == "guitar-6"
        assert isinstance(body["customTunings"]["My Tuning"]["strings"], list)

    def test_malformed_config_file_returns_defaults(self, client, config_dir):
        (config_dir / "tuner.json").write_text("not json at all {{")
        r = client.get("/api/plugins/tuner/config")
        assert r.status_code == 200
        assert r.json()["lastTuning"] == "Standard"


# ── referencePitch — now a core setting, not a tuner config field ─────────────
# referencePitch moved to GET/POST /api/settings (core tuning.read capability).
# The tuner config must not expose or persist it.

class TestReferencePitchNotInTunerConfig:
    def test_not_present_in_default_response(self, client):
        body = client.get("/api/plugins/tuner/config").json()
        assert "referencePitch" not in body

    def test_posting_reference_pitch_is_ignored(self, client):
        # POSTing referencePitch must not break the request or leak the field back.
        r = client.post("/api/plugins/tuner/config", json={"referencePitch": 432, "lastTuning": "Drop D"})
        assert r.status_code == 200
        body = client.get("/api/plugins/tuner/config").json()
        assert "referencePitch" not in body
        assert body["lastTuning"] == "Drop D"

    def test_reference_pitch_not_written_to_file(self, client, config_dir):
        client.post("/api/plugins/tuner/config", json={"referencePitch": 443})
        saved = json.loads((config_dir / "tuner.json").read_text())
        assert "referencePitch" not in saved
