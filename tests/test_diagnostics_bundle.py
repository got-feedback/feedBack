import io
import json
import logging
import zipfile
from pathlib import Path

import diagnostics_bundle as db


LOG = logging.getLogger("test")


def _basic_kwargs(tmp_path):
    return dict(
        feedBack_version="0.0.0-test",
        config_dir=tmp_path,
        dlc_dir=None,
        log_file=None,
        loaded_plugins=[],
        include={"system": True, "hardware": False, "logs": False, "console": False, "plugins": False},
        redact=True,
        client_console=None,
        client_hardware=None,
        client_ua=None,
        local_storage=None,
        log=LOG,
    )


def _open_zip(payload: bytes) -> zipfile.ZipFile:
    return zipfile.ZipFile(io.BytesIO(payload))


def test_minimal_bundle_has_manifest_and_readme(tmp_path):
    zip_bytes, filename, manifest = db.build_bundle(**_basic_kwargs(tmp_path))
    assert filename.startswith("feedBack-diag-0.0.0-test-")
    assert filename.endswith(".zip")
    with _open_zip(zip_bytes) as zf:
        names = zf.namelist()
        assert "manifest.json" in names
        assert "README.txt" in names
        assert "system/version.json" in names
        m = json.loads(zf.read("manifest.json"))
        assert m["schema"] == 1
        assert m["feedBack_version"] == "0.0.0-test"
        assert any(f["path"] == "system/version.json" for f in m["files"])


def test_manifest_schema_field_extracted_from_json_files(tmp_path):
    _zip, _name, manifest = db.build_bundle(**_basic_kwargs(tmp_path))
    version_entry = next(f for f in manifest["files"] if f["path"] == "system/version.json")
    assert version_entry["schema"] == "system.version.v1"


def test_logs_section_omitted_when_log_file_none(tmp_path):
    kw = _basic_kwargs(tmp_path)
    kw["include"]["logs"] = True
    _zip, _name, manifest = db.build_bundle(**kw)
    assert any("LOG_FILE not set" in n for n in manifest["notes"])


def test_logs_section_included_when_log_file_present(tmp_path):
    log_file = tmp_path / "server.log"
    log_file.write_text("hello world\nline 2\n", encoding="utf-8")
    kw = _basic_kwargs(tmp_path)
    kw["log_file"] = log_file
    kw["include"]["logs"] = True
    zip_bytes, _name, manifest = db.build_bundle(**kw)
    with _open_zip(zip_bytes) as zf:
        assert "logs/server.log" in zf.namelist()
        assert b"hello world" in zf.read("logs/server.log")
        meta = json.loads(zf.read("logs/server.log.meta.json"))
        assert meta["exists"] is True
        assert meta["size_bytes"] > 0


def test_logs_redacted_when_redact_true(tmp_path):
    log_file = tmp_path / "server.log"
    log_file.write_text("client 192.168.1.42 connected\n", encoding="utf-8")
    kw = _basic_kwargs(tmp_path)
    kw["log_file"] = log_file
    kw["include"]["logs"] = True
    kw["redact"] = True
    zip_bytes, _name, manifest = db.build_bundle(**kw)
    with _open_zip(zip_bytes) as zf:
        log_text = zf.read("logs/server.log").decode("utf-8")
    assert "192.168.1.42" not in log_text
    assert "<ip:" in log_text
    assert manifest["redactions"]["ips_replaced"] == 1


def test_logs_not_redacted_when_redact_false(tmp_path):
    log_file = tmp_path / "server.log"
    log_file.write_text("client 192.168.1.42 connected\n", encoding="utf-8")
    kw = _basic_kwargs(tmp_path)
    kw["log_file"] = log_file
    kw["include"]["logs"] = True
    kw["redact"] = False
    zip_bytes, _name, _manifest = db.build_bundle(**kw)
    with _open_zip(zip_bytes) as zf:
        log_text = zf.read("logs/server.log").decode("utf-8")
    assert "192.168.1.42" in log_text


def test_client_console_section(tmp_path):
    kw = _basic_kwargs(tmp_path)
    kw["include"]["console"] = True
    kw["client_console"] = [
        {"t": 1700000000, "kind": "console", "level": "log", "msg": "hi"},
        {"t": 1700000001, "kind": "error", "level": "error", "msg": "oops at 10.0.0.1"},
    ]
    zip_bytes, _name, manifest = db.build_bundle(**kw)
    with _open_zip(zip_bytes) as zf:
        data = json.loads(zf.read("client/console.json"))
    assert data["schema"] == "client.console.v1"
    assert len(data["entries"]) == 2
    # second entry's message should have IP redacted (redact=True default)
    assert "10.0.0.1" not in data["entries"][1]["msg"]


def test_plugin_diagnostics_files_collected(tmp_path):
    cfg = tmp_path / "config"
    cfg.mkdir()
    (cfg / "nam_tone.diag.json").write_text('{"models": []}', encoding="utf-8")
    plugin = {
        "id": "nam_tone",
        "name": "NAM",
        "_dir": cfg,
        "_manifest": {"version": "1.0.0"},
        "_diagnostics_paths": ["nam_tone.diag.json"],
        "_diagnostics_callable": None,
    }
    kw = _basic_kwargs(tmp_path)
    kw["config_dir"] = cfg
    kw["loaded_plugins"] = [plugin]
    kw["include"]["plugins"] = True
    zip_bytes, _name, _manifest = db.build_bundle(**kw)
    with _open_zip(zip_bytes) as zf:
        assert "plugins/nam_tone/nam_tone.diag.json" in zf.namelist()


def test_plugin_callable_dict_serialized_as_json(tmp_path):
    cfg = tmp_path / "config"
    cfg.mkdir()
    plugin = {
        "id": "stems",
        "name": "Stems",
        "_dir": cfg,
        "_manifest": {"version": "1.0.0"},
        "_diagnostics_paths": [],
        "_diagnostics_callable": lambda ctx: {"last_split": "song-x"},
    }
    kw = _basic_kwargs(tmp_path)
    kw["config_dir"] = cfg
    kw["loaded_plugins"] = [plugin]
    kw["include"]["plugins"] = True
    zip_bytes, _name, _m = db.build_bundle(**kw)
    with _open_zip(zip_bytes) as zf:
        data = json.loads(zf.read("plugins/stems/callable.json"))
    assert data == {"last_split": "song-x"}


def test_plugin_callable_exception_does_not_crash(tmp_path):
    cfg = tmp_path / "config"
    cfg.mkdir()

    def raises(_ctx):
        raise RuntimeError("boom")

    plugin = {
        "id": "buggy",
        "name": "Buggy",
        "_dir": cfg,
        "_manifest": {"version": "0.1"},
        "_diagnostics_paths": [],
        "_diagnostics_callable": raises,
    }
    kw = _basic_kwargs(tmp_path)
    kw["config_dir"] = cfg
    kw["loaded_plugins"] = [plugin]
    kw["include"]["plugins"] = True
    zip_bytes, _name, _m = db.build_bundle(**kw)
    with _open_zip(zip_bytes) as zf:
        # No callable.json entry; bundle still built
        assert "plugins/buggy/callable.json" not in zf.namelist()


def test_client_audio_session_contribution_redacts_paths(tmp_path):
    cfg = tmp_path / "config"
    cfg.mkdir()
    plugin = {
        "id": "note_detect",
        "name": "Note Detect",
        "_dir": cfg,
        "_manifest": {"version": "1.0.0"},
        "_diagnostics_paths": [],
        "_diagnostics_callable": None,
    }
    kw = _basic_kwargs(tmp_path)
    kw["config_dir"] = cfg
    home_path = Path.home()
    kw["loaded_plugins"] = [plugin]
    kw["include"]["plugins"] = True
    kw["client_contributions"] = {
        "note_detect": {
            "schema": "feedBack.audio_session.diagnostics.v1",
            "session": {"sessionId": str(home_path / "DLC" / "private-song.archive")},
            "domains": {"audio-input": {"sources": [{"label": str(home_path / "devices" / "raw-id")}]}},
        }
    }
    zip_bytes, _name, _m = db.build_bundle(**kw)
    with _open_zip(zip_bytes) as zf:
        data = json.loads(zf.read("plugins/note_detect/client.json"))
    encoded = json.dumps(data)
    assert str(home_path) not in encoded
    assert "feedBack.audio_session.diagnostics.v1" in encoded


def test_system_plugins_exports_capability_metadata_and_shims(tmp_path):
    cfg = tmp_path / "config"
    cfg.mkdir()
    plugin = {
        "id": "stems",
        "name": "Stems",
        "type": None,
        "has_screen": True,
        "has_script": True,
        "has_settings": False,
        "_dir": cfg,
        "_manifest": {"version": "1.0.0", "routes": "routes.py"},
        "capabilities": {"stems": {"roles": ["owner", "provider"], "commands": ["mute"]}},
        "capability_validation_warnings": [{"field": "capabilities.bad", "reason": "invalid"}],
        "capability_unsupported_versions": [],
        "compatibility_shims": [{"shimId": "stems:legacy-window", "source": "stems", "capability": "stems", "legacySurface": "window._stemsState", "status": "used"}],
    }
    kw = _basic_kwargs(tmp_path)
    kw["loaded_plugins"] = [plugin]
    zip_bytes, _name, _m = db.build_bundle(**kw)
    with _open_zip(zip_bytes) as zf:
        data = json.loads(zf.read("system/plugins.json"))
    entry = data["plugins"][0]
    assert entry["capabilities"]["stems"]["roles"] == ["owner", "provider"]
    assert entry["capability_validation_warnings"]
    assert entry["compatibility_shims"][0]["legacySurface"] == "window._stemsState"


def test_preview_returns_manifest_shape(tmp_path):
    out = db.preview_bundle(
        feedBack_version="0.0.0-test",
        config_dir=tmp_path,
        dlc_dir=None,
        log_file=None,
        loaded_plugins=[],
        include={"system": True, "hardware": False, "logs": False, "console": False, "plugins": False},
        redact=True,
        log=LOG,
    )
    assert "filename" in out
    assert out["filename"].endswith(".zip")
    assert "manifest" in out
    assert out["manifest"]["schema"] == 1


def test_json_log_pretty_companion(tmp_path):
    log_file = tmp_path / "server.log"
    log_file.write_text(
        '{"timestamp":"2026-05-03T22:00:00Z","level":"info","event":"server started","port":8000}\n'
        '{"timestamp":"2026-05-03T22:00:01Z","level":"warning","event":"slow query","duration_ms":523}\n',
        encoding="utf-8",
    )
    kw = _basic_kwargs(tmp_path)
    kw["log_file"] = log_file
    kw["include"]["logs"] = True
    zip_bytes, _name, _m = db.build_bundle(**kw)
    with _open_zip(zip_bytes) as zf:
        names = zf.namelist()
        assert "logs/server.log" in names
        assert "logs/server.pretty.log" in names
        pretty = zf.read("logs/server.pretty.log").decode("utf-8")
        meta = json.loads(zf.read("logs/server.log.meta.json"))
    assert meta["pretty_companion"] is True
    assert "server started" in pretty
    assert "[INFO]" in pretty
    assert "[WARNING]" in pretty
    assert "port=8000" in pretty
    assert "duration_ms=523" in pretty


def test_text_log_no_pretty_companion(tmp_path):
    log_file = tmp_path / "server.log"
    log_file.write_text(
        "2026-05-03 22:00:00 [info] server started port=8000\n",
        encoding="utf-8",
    )
    kw = _basic_kwargs(tmp_path)
    kw["log_file"] = log_file
    kw["include"]["logs"] = True
    zip_bytes, _name, _m = db.build_bundle(**kw)
    with _open_zip(zip_bytes) as zf:
        names = zf.namelist()
        assert "logs/server.log" in names
        assert "logs/server.pretty.log" not in names


def test_log_tail_truncation(tmp_path):
    log_file = tmp_path / "server.log"
    # Write more than LOG_TAIL_BYTES
    line = ("x" * 100 + "\n").encode()
    big = line * 100_000  # ~10 MB
    log_file.write_bytes(big)
    kw = _basic_kwargs(tmp_path)
    kw["log_file"] = log_file
    kw["include"]["logs"] = True
    zip_bytes, _name, _m = db.build_bundle(**kw)
    with _open_zip(zip_bytes) as zf:
        out = zf.read("logs/server.log")
        meta = json.loads(zf.read("logs/server.log.meta.json"))
    assert meta["truncated"] is True
    assert len(out) <= db.LOG_TAIL_BYTES + 1024


def test_callable_failure_recorded_in_manifest_notes(tmp_path):
    """Callable exceptions must appear in manifest.notes, not be silently dropped."""
    cfg = tmp_path / "config"
    cfg.mkdir()

    def raises(_ctx):
        raise RuntimeError("boom")

    plugin = {
        "id": "buggy",
        "name": "Buggy",
        "_dir": cfg,
        "_manifest": {"version": "0.1"},
        "_diagnostics_paths": [],
        "_diagnostics_callable": raises,
    }
    kw = _basic_kwargs(tmp_path)
    kw["config_dir"] = cfg
    kw["loaded_plugins"] = [plugin]
    kw["include"]["plugins"] = True
    _zip, _name, manifest = db.build_bundle(**kw)
    assert any("buggy" in n and "boom" in n for n in manifest["notes"])


def test_client_contributions_written_to_bundle(tmp_path):
    """window.feedBack.diagnostics.contribute() payloads land in plugins/<id>/client.json."""
    kw = _basic_kwargs(tmp_path)
    kw["include"]["plugins"] = True  # contributions are gated on the plugins toggle
    # Must also include the plugin in loaded_plugins so the ID is recognised.
    kw["loaded_plugins"] = [{"id": "my_plugin", "_diagnostics_paths": [], "_diagnostics_callable": None}]
    kw["client_contributions"] = {
        "my_plugin": {"schema": "my_plugin.client_diag.v1", "active_preset": "rock"},
    }
    zip_bytes, _name, manifest = db.build_bundle(**kw)
    with _open_zip(zip_bytes) as zf:
        data = json.loads(zf.read("plugins/my_plugin/client.json"))
    assert data["schema"] == "plugin.client_contribution.v1"
    assert data["data"]["active_preset"] == "rock"
    assert any(f["path"] == "plugins/my_plugin/client.json" for f in manifest["files"])


def test_client_contributions_suppressed_when_plugins_toggle_off(tmp_path):
    """Contributions must NOT be written when include.plugins=False."""
    kw = _basic_kwargs(tmp_path)
    # plugins toggle is already False in _basic_kwargs
    assert kw["include"]["plugins"] is False
    kw["client_contributions"] = {"my_plugin": {"active_preset": "rock"}}
    zip_bytes, _name, _m = db.build_bundle(**kw)
    with _open_zip(zip_bytes) as zf:
        assert "plugins/my_plugin/client.json" not in zf.namelist()


def test_console_args_redacted(tmp_path):
    """Secondary console arguments (args list) must be redacted, not just msg."""
    kw = _basic_kwargs(tmp_path)
    kw["include"]["console"] = True
    kw["client_console"] = [
        {
            "t": 1700000000, "kind": "console", "level": "log",
            "msg": "request",
            "args": ["token=supersecret123", "http://example.com/api?api_key=abc123"],
        },
    ]
    zip_bytes, _name, _m = db.build_bundle(**kw)
    with _open_zip(zip_bytes) as zf:
        data = json.loads(zf.read("client/console.json"))
    args = data["entries"][0]["args"]
    assert "supersecret123" not in args[0]
    assert "abc123" not in args[1]
    assert "<redacted>" in args[0]
    assert "<redacted>" in args[1]


def test_ua_url_redacted(tmp_path):
    """client/ua.json url field must be redacted when redact=True."""
    kw = _basic_kwargs(tmp_path)
    kw["client_ua"] = {
        "url": "http://localhost:8080/settings?api_key=secret99",
        "ua": "Mozilla/5.0",
    }
    zip_bytes, _name, _m = db.build_bundle(**kw)
    with _open_zip(zip_bytes) as zf:
        data = json.loads(zf.read("client/ua.json"))
    assert "secret99" not in data["url"]
    assert "<redacted>" in data["url"]


def test_ua_url_not_redacted_when_redact_false(tmp_path):
    """URL is preserved verbatim when redact=False."""
    kw = _basic_kwargs(tmp_path)
    kw["redact"] = False
    kw["client_ua"] = {"url": "http://localhost:8080/settings?api_key=secret99"}
    zip_bytes, _name, _m = db.build_bundle(**kw)
    with _open_zip(zip_bytes) as zf:
        data = json.loads(zf.read("client/ua.json"))
    assert "secret99" in data["url"]


def test_runtime_kind_set_without_hardware_section(tmp_path, monkeypatch):
    """manifest.runtime must reflect actual runtime even when include.hardware=False."""
    monkeypatch.setenv("FEEDBACK_RUNTIME", "electron")
    kw = _basic_kwargs(tmp_path)
    kw["include"]["hardware"] = False
    _zip, _name, manifest = db.build_bundle(**kw)
    assert manifest["runtime"] == "electron"


def test_preview_does_not_execute_callables(tmp_path):
    """preview_bundle must not invoke plugin diagnostics callables."""
    called = []

    def side_effect(_ctx):
        called.append(True)
        return {"was_called": True}

    plugin = {
        "id": "side_fx",
        "name": "SideFX",
        "_dir": tmp_path,
        "_manifest": {},
        "_diagnostics_paths": [],
        "_diagnostics_callable": side_effect,
    }
    db.preview_bundle(
        feedBack_version="0.0.0-test",
        config_dir=tmp_path,
        dlc_dir=None,
        log_file=None,
        loaded_plugins=[plugin],
        include={"system": False, "hardware": False, "logs": False, "console": False, "plugins": True},
        redact=False,
        log=LOG,
    )
    assert called == [], "preview_bundle must not execute diagnostics callables"


def test_python_executable_redacted_in_version_json(tmp_path, monkeypatch):
    """python.executable under HOME/config_dir must be redacted when redact=True."""
    import sys as _sys
    # Simulate a venv executable under the user's home directory.
    from pathlib import Path as _Path
    home = _Path.home()
    fake_executable = str(home / ".venv" / "bin" / "python")
    monkeypatch.setattr(_sys, "executable", fake_executable)
    kw = _basic_kwargs(tmp_path)
    kw["include"]["system"] = True
    zip_bytes, _name, _m = db.build_bundle(**kw)
    with _open_zip(zip_bytes) as zf:
        data = json.loads(zf.read("system/version.json"))
    # The raw home-directory prefix must not appear verbatim.
    assert str(home) not in data["python"]["executable"]


def test_python_executable_not_redacted_when_redact_false(tmp_path):
    """python.executable must be preserved verbatim when redact=False."""
    kw = _basic_kwargs(tmp_path)
    kw["redact"] = False
    kw["include"]["system"] = True
    zip_bytes, _name, _m = db.build_bundle(**kw)
    with _open_zip(zip_bytes) as zf:
        data = json.loads(zf.read("system/version.json"))
    import sys as _sys
    assert data["python"]["executable"] == _sys.executable


def test_log_meta_log_file_path_redacted(tmp_path):
    """server.log.meta.json must not contain the raw LOG_FILE path when redact=True."""
    log_file = tmp_path / "server.log"
    log_file.write_text("line1\n", encoding="utf-8")
    kw = _basic_kwargs(tmp_path)
    kw["log_file"] = log_file
    kw["include"]["logs"] = True
    zip_bytes, _name, _m = db.build_bundle(**kw)
    with _open_zip(zip_bytes) as zf:
        meta = json.loads(zf.read("logs/server.log.meta.json"))
    assert str(log_file) not in meta["log_file"]


def test_log_meta_log_file_path_not_redacted_when_redact_false(tmp_path):
    """server.log.meta.json log_file is verbatim when redact=False."""
    log_file = tmp_path / "server.log"
    log_file.write_text("line1\n", encoding="utf-8")
    kw = _basic_kwargs(tmp_path)
    kw["redact"] = False
    kw["log_file"] = log_file
    kw["include"]["logs"] = True
    zip_bytes, _name, _m = db.build_bundle(**kw)
    with _open_zip(zip_bytes) as zf:
        meta = json.loads(zf.read("logs/server.log.meta.json"))
    assert meta["log_file"] == str(log_file)


def test_diagnostics_directory_entry_recurses(tmp_path):
    """Trailing-slash entries must recurse into the directory and collect all files."""
    cfg = tmp_path / "config"
    cfg.mkdir()
    model_dir = cfg / "models"
    model_dir.mkdir()
    (model_dir / "a.json").write_text('{"x": 1}', encoding="utf-8")
    (model_dir / "b.json").write_text('{"x": 2}', encoding="utf-8")
    plugin = {
        "id": "amp",
        "name": "Amp",
        "_dir": cfg,
        "_manifest": {},
        "_diagnostics_paths": ["models/"],  # trailing slash = directory
        "_diagnostics_callable": None,
    }
    kw = _basic_kwargs(tmp_path)
    kw["config_dir"] = cfg
    kw["loaded_plugins"] = [plugin]
    kw["include"]["plugins"] = True
    zip_bytes, _name, _m = db.build_bundle(**kw)
    with _open_zip(zip_bytes) as zf:
        names = zf.namelist()
    assert "plugins/amp/models/a.json" in names
    assert "plugins/amp/models/b.json" in names


def test_preview_suppresses_callable_spec(tmp_path):
    """preview_bundle must not run _diagnostics_callable_spec-based callables."""
    called = []

    def fake_load_sibling(name):
        class FakeMod:
            def collect(ctx):
                called.append(True)
                return {"invoked": True}
        return FakeMod()

    plugin = {
        "id": "spec_plugin",
        "name": "SpecPlugin",
        "_dir": tmp_path,
        "_manifest": {},
        "_diagnostics_paths": [],
        "_diagnostics_callable": None,
        "_diagnostics_callable_spec": "diagnostics:collect",
        "_load_sibling": fake_load_sibling,
    }
    db.preview_bundle(
        feedBack_version="0.0.0-test",
        config_dir=tmp_path,
        dlc_dir=None,
        log_file=None,
        loaded_plugins=[plugin],
        include={"system": False, "hardware": False, "logs": False, "console": False, "plugins": True},
        redact=False,
        log=LOG,
    )
    assert called == [], "preview_bundle must not execute _diagnostics_callable_spec callables"


def test_system_plugins_exports_manifest_capability_declarations(tmp_path):
    plugin_dir = tmp_path / "capable"
    plugin_dir.mkdir()
    loaded_plugins = [{
        "id": "capable",
        "name": "Capable",
        "_dir": plugin_dir,
        "_manifest": {
            "version": "1.0.0",
            "capabilities": {"stems": {"roles": ["requester", "observer"]}},
            "ui_contributions": {"ui.player-panels": [{"id": "capable-panel"}]},
            "ui": {"ui.player-controls": [{"id": "capable-control"}]},
            "runtime_domains": {"midi-control": {"role": "observer"}},
            "domains": {"tempo-clock": {"role": "provider"}},
        },
    }]

    result = db._system_plugins(loaded_plugins, plugins_root=tmp_path)

    plugin = result["plugins"][0]
    assert plugin["capabilities"] == {"stems": {"roles": ["requester", "observer"]}}
    assert plugin["ui_contributions"] == {
        "ui.player-controls": [{"id": "capable-control"}],
        "ui.player-panels": [{"id": "capable-panel"}],
    }
    assert plugin["runtime_domains"] == {
        "midi-control": {"role": "observer"},
        "tempo-clock": {"role": "provider"},
    }


def test_system_plugins_multi_root_scans_all(tmp_path):
    """_system_plugins accepts a list of roots and scans all for orphans."""
    root1 = tmp_path / "plugins1"
    root2 = tmp_path / "plugins2"
    root1.mkdir()
    root2.mkdir()
    (root1 / "pluginA").mkdir()
    (root1 / "pluginA" / "plugin.json").write_text('{"id":"pluginA","name":"A"}')
    (root2 / "pluginB").mkdir()
    (root2 / "pluginB" / "plugin.json").write_text('{"id":"pluginB","name":"B"}')
    result = db._system_plugins([], plugins_root=[root1, root2])
    orphan_ids = {o["id"] for o in result["orphans"]}
    assert "pluginA" in orphan_ids
    assert "pluginB" in orphan_ids


def test_system_plugins_evicted_stale_copy_appears_in_orphans(tmp_path):
    """A stale/evicted copy (same plugin id, different directory) appears
    in the orphans list with ``evicted: True`` so it's visible in diagnostics.

    Previously, _system_plugins silently skipped any directory whose manifest
    id matched a loaded plugin, which meant evicted stale copies were invisible
    in exported bundles.
    """
    plugins_dir = tmp_path / "plugins"
    plugins_dir.mkdir()

    # Stale in-tree clone: same manifest id, different directory name.
    stale_dir = plugins_dir / "3dhighway"
    stale_dir.mkdir()
    (stale_dir / "plugin.json").write_text('{"id":"highway_3d","name":"3D Highway (stale)"}')

    # The real bundled copy is loaded from a different dir.
    bundled_dir = plugins_dir / "highway_3d"
    bundled_dir.mkdir()

    loaded_plugins = [{
        "id": "highway_3d",
        "name": "3D Highway",
        "_dir": bundled_dir,
        "_manifest": {},
    }]

    result = db._system_plugins(loaded_plugins, plugins_root=plugins_dir)

    # The stale clone must appear as an orphan with evicted=True.
    evicted = [o for o in result["orphans"] if o["id"] == "highway_3d"]
    assert len(evicted) == 1
    assert evicted[0]["dir"] == "3dhighway"
    assert evicted[0].get("evicted") is True
    # The `path` field must contain the full resolved path so maintainers can
    # tell which root the evicted copy came from even when dir names match.
    assert evicted[0].get("path") == str(stale_dir.resolve())
    # The canonical loaded copy must NOT appear in orphans.
    loaded_ids = {p["id"] for p in result["plugins"]}
    assert "highway_3d" in loaded_ids


def test_system_plugins_orphan_path_redacted_when_redactor_provided(tmp_path):
    """Orphan `path` must pass through the redactor when one is provided.

    The full resolved path of an evicted copy (e.g.
    ``/home/user/.config/feedBack/plugins/highway_3d``) contains the user's
    home directory.  Without redaction that leaks in a supposedly-sanitised
    bundle.  When a Redactor is passed to _system_plugins, home-dir prefixes
    in `path` must be replaced with the ``<HOME>`` placeholder.
    """
    from diagnostics_redact import Redactor

    home = tmp_path / "home" / "user"
    home.mkdir(parents=True)
    plugins_dir = home / "plugins"
    plugins_dir.mkdir()

    stale_dir = plugins_dir / "highway_3d"
    stale_dir.mkdir()
    (stale_dir / "plugin.json").write_text('{"id":"highway_3d","name":"3D Highway (user)"}')

    # Simulate that the canonical copy was loaded from somewhere else.
    other_dir = tmp_path / "bundled" / "highway_3d"
    other_dir.mkdir(parents=True)
    loaded_plugins = [{"id": "highway_3d", "name": "3D Highway", "_dir": other_dir, "_manifest": {}}]

    redactor = Redactor(home_dir=home)
    result = db._system_plugins(loaded_plugins, plugins_root=plugins_dir, redactor=redactor)

    evicted = [o for o in result["orphans"] if o["id"] == "highway_3d"]
    assert len(evicted) == 1
    path_val = evicted[0]["path"]
    # The raw home-dir path must not appear.
    assert str(home) not in path_val
    # The placeholder must be present.
    assert "<HOME>" in path_val


def test_system_plugins_orphan_path_not_redacted_when_no_redactor(tmp_path):
    """Without a redactor the `path` field is the raw resolved path (no change)."""
    plugins_dir = tmp_path / "plugins"
    plugins_dir.mkdir()
    stale_dir = plugins_dir / "old_plugin"
    stale_dir.mkdir()
    (stale_dir / "plugin.json").write_text('{"id":"my_plugin","name":"My Plugin"}')

    loaded_plugins = [{"id": "my_plugin", "name": "My Plugin",
                       "_dir": tmp_path / "canonical", "_manifest": {}}]

    result = db._system_plugins(loaded_plugins, plugins_root=plugins_dir)

    evicted = [o for o in result["orphans"] if o["id"] == "my_plugin"]
    assert len(evicted) == 1
    # Raw path — no <HOME> or <CONFIG_DIR> replacement.
    assert str(stale_dir.resolve()) == evicted[0]["path"]


def test_git_remote_token_stripped():
    """Embedded credentials in git remote URLs must be stripped from system/plugins.json."""
    # Simulate a plugin with a git remote that embeds a token.
    url = "https://ghp_secrettoken@github.com/org/repo.git"
    sanitized = db._sanitize_remote_url(url)
    assert "ghp_secrettoken" not in sanitized
    assert "github.com/org/repo.git" in sanitized


def test_git_remote_user_pass_stripped():
    """user:password@host form is also stripped."""
    url = "https://user:password@bitbucket.org/org/repo.git"
    sanitized = db._sanitize_remote_url(url)
    assert "user" not in sanitized
    assert "password" not in sanitized
    assert "bitbucket.org/org/repo.git" in sanitized


def test_git_remote_no_credentials_unchanged():
    """SSH and plain-HTTPS remotes without credentials are preserved."""
    for url in [
        "https://github.com/org/repo.git",
        "git@github.com:org/repo.git",
        "ssh://git@github.com/org/repo.git",
    ]:
        assert db._sanitize_remote_url(url) == url


def test_git_remote_qstring_secret_stripped():
    """Query-string secrets in clone URLs are stripped."""
    url = "https://github.com/org/repo.git?token=supersecret"
    sanitized = db._sanitize_remote_url(url)
    assert "supersecret" not in sanitized
    assert "token=<redacted>" in sanitized


# ── console entry url redaction ────────────────────────────────────────────────

def test_console_onerror_url_redacted(tmp_path, monkeypatch):
    """window.onerror entries carry a `url` field that must be redacted."""
    monkeypatch.setenv("HOME", str(tmp_path))
    kw = _basic_kwargs(tmp_path)
    kw["include"]["console"] = True
    kw["client_console"] = [
        {"level": "error", "msg": "TypeError", "url": "/api/diagnostics/export?token=secret123", "stack": ""}
    ]
    zip_bytes, _, _ = db.build_bundle(**kw)
    zf = _open_zip(zip_bytes)
    console = json.loads(zf.read("client/console.json"))
    entry_url = console["entries"][0]["url"]
    assert "secret123" not in entry_url
    assert "token=<redacted>" in entry_url


def test_console_onerror_url_not_redacted_when_redact_false(tmp_path, monkeypatch):
    """Without redaction the url field is kept verbatim."""
    monkeypatch.setenv("HOME", str(tmp_path))
    kw = _basic_kwargs(tmp_path)
    kw["include"]["console"] = True
    kw["redact"] = False
    raw_url = "/api/diagnostics/export?token=secret123"
    kw["client_console"] = [
        {"level": "error", "msg": "TypeError", "url": raw_url, "stack": ""}
    ]
    zip_bytes, _, _ = db.build_bundle(**kw)
    zf = _open_zip(zip_bytes)
    console = json.loads(zf.read("client/console.json"))
    assert console["entries"][0]["url"] == raw_url


# ── manifest.notes log-file-missing uses redacted path ─────────────────────────

def test_manifest_notes_missing_log_file_path_redacted(tmp_path, monkeypatch):
    """When LOG_FILE is set but missing, the manifest note must not leak the raw path."""
    home = tmp_path / "home"
    home.mkdir()
    monkeypatch.setenv("HOME", str(home))
    log_file = home / "feedBack" / "server.log"  # under HOME — sensitive
    kw = _basic_kwargs(tmp_path)
    kw["include"]["logs"] = True
    kw["log_file"] = log_file  # file does not exist
    zip_bytes, _, manifest = db.build_bundle(**kw)
    for note in manifest.get("notes", []):
        assert str(home) not in note, f"raw path leaked in note: {note}"


# ── system/env.json values redacted when redact=True ──────────────────────────

def test_env_json_values_redacted(tmp_path, monkeypatch):
    """Path-bearing env vars must be redacted in system/env.json when redact=True."""
    home = tmp_path / "home"
    home.mkdir()
    monkeypatch.setenv("HOME", str(home))
    log_path = str(home / "server.log")
    monkeypatch.setenv("LOG_FILE", log_path)
    kw = _basic_kwargs(tmp_path)
    kw["include"]["system"] = True
    zip_bytes, _, _ = db.build_bundle(**kw)
    zf = _open_zip(zip_bytes)
    env_data = json.loads(zf.read("system/env.json"))
    assert str(home) not in env_data["vars"].get("LOG_FILE", ""), \
        "HOME path must be redacted from LOG_FILE in env.json"


def test_env_json_values_not_redacted_when_redact_false(tmp_path, monkeypatch):
    """Env vars are written verbatim when redact=False."""
    home = tmp_path / "home"
    home.mkdir()
    monkeypatch.setenv("HOME", str(home))
    log_path = str(home / "server.log")
    monkeypatch.setenv("LOG_FILE", log_path)
    kw = _basic_kwargs(tmp_path)
    kw["include"]["system"] = True
    kw["redact"] = False
    zip_bytes, _, _ = db.build_bundle(**kw)
    zf = _open_zip(zip_bytes)
    env_data = json.loads(zf.read("system/env.json"))
    assert env_data["vars"].get("LOG_FILE") == log_path


# ── callable timeout ──────────────────────────────────────────────────────────

def test_callable_timeout_recorded_in_notes(tmp_path):
    """A callable that sleeps longer than the timeout must be cancelled and
    a manifest note recorded — the export must not hang."""
    import time

    def _slow_callable(ctx):
        time.sleep(0.3)  # longer than the 0.1s timeout we set below
        return {"should": "not reach"}

    plugin = {
        "id": "slow",
        "_diagnostics_callable": _slow_callable,
        "_diagnostics_callable_spec": None,
        "_diagnostics_paths": [],
    }
    notes: list[str] = []
    orig_timeout = db.CALLABLE_TIMEOUT_S
    db.CALLABLE_TIMEOUT_S = 0.1  # override to 0.1s so the test is fast
    try:
        result = db._plugin_diagnostic_files(plugin, tmp_path, LOG, notes=notes)
    finally:
        db.CALLABLE_TIMEOUT_S = orig_timeout

    # Callable output must not appear in the result.
    assert "plugins/slow/callable.json" not in result
    # A timeout note must be recorded.
    assert any("timed out" in n for n in notes), f"No timeout note in {notes}"


def test_callable_completes_within_timeout(tmp_path):
    """A callable that returns quickly must still produce its output."""
    def _fast_callable(ctx):
        return {"ok": True}

    plugin = {
        "id": "fast",
        "_diagnostics_callable": _fast_callable,
        "_diagnostics_callable_spec": None,
        "_diagnostics_paths": [],
    }
    notes: list[str] = []
    result = db._plugin_diagnostic_files(plugin, tmp_path, LOG, notes=notes)
    assert "plugins/fast/callable.json" in result
    data = json.loads(result["plugins/fast/callable.json"])
    assert data == {"ok": True}
    assert notes == []


def test_callable_bounded_execution_model(tmp_path):
    """Bounded semaphore caps concurrent diagnostic callable threads.

    The first CALLABLE_CONCURRENCY_LIMIT timed-out callables each acquire a
    semaphore slot and leave it held (they are still running).  The very next
    call cannot acquire a slot and is skipped immediately — the export records
    a note but no new thread is spawned.  Once the hung threads eventually
    finish and release their slots, a fast callable succeeds again.
    """
    import time

    slow_duration = 0.3  # long enough that threads are still alive when we saturate
    short_timeout = 0.05  # shorter than slow_duration so we always time out

    def _slow_callable(ctx):
        time.sleep(slow_duration)
        return {"late": True}

    def _fast_callable(ctx):
        return {"ok": True}

    slow_plugin = {
        "id": "slow_bsem",
        "_diagnostics_callable": _slow_callable,
        "_diagnostics_callable_spec": None,
        "_diagnostics_paths": [],
    }

    # Wait for any leftover threads from previous tests to release semaphore
    # slots so this test starts with a clean slate.
    for _ in range(60):  # up to 3s wait
        if db._callable_semaphore_free_slots() >= db.CALLABLE_CONCURRENCY_LIMIT:
            break
        time.sleep(0.05)

    orig_timeout = db.CALLABLE_TIMEOUT_S
    db.CALLABLE_TIMEOUT_S = short_timeout
    try:
        # Fill all semaphore slots with timed-out (still-running) threads.
        for i in range(db.CALLABLE_CONCURRENCY_LIMIT):
            notes: list[str] = []
            db._plugin_diagnostic_files(slow_plugin, tmp_path, LOG, notes=notes)
            assert any("timed out" in n for n in notes), (
                f"call {i} should have timed out"
            )

        # One more call should hit the bound and be skipped, not timed out.
        notes_over: list[str] = []
        db._plugin_diagnostic_files(slow_plugin, tmp_path, LOG, notes=notes_over)
        assert len(notes_over) > 0, "over-limit call must produce a note"
        assert not any("timed out" in n for n in notes_over), (
            "over-limit call must be skipped before spawning a thread, "
            "not allowed to time out"
        )
    finally:
        db.CALLABLE_TIMEOUT_S = orig_timeout

    # Wait for all hung threads to complete and release semaphore slots.
    time.sleep(slow_duration + 0.1)

    # After slots are free, a fast callable must succeed.
    fast_plugin = {
        "id": "fast_bsem",
        "_diagnostics_callable": _fast_callable,
        "_diagnostics_callable_spec": None,
        "_diagnostics_paths": [],
    }
    notes2: list[str] = []
    result = db._plugin_diagnostic_files(fast_plugin, tmp_path, LOG, notes=notes2)
    assert "plugins/fast_bsem/callable.json" in result
    assert notes2 == []


# ── preview placeholders ──────────────────────────────────────────────────────

def _preview_kwargs(tmp_path):
    return dict(
        feedBack_version="0.0.0-test",
        config_dir=tmp_path,
        dlc_dir=None,
        log_file=None,
        loaded_plugins=[],
        include={"system": True, "hardware": False, "logs": False, "console": True, "plugins": True},
        redact=True,
        log=LOG,
    )


def test_preview_includes_browser_placeholders(tmp_path):
    """preview_bundle must include placeholder entries for client-side files."""
    result = db.preview_bundle(**_preview_kwargs(tmp_path))
    paths = {f["path"] for f in result["manifest"]["files"]}
    # UA and localStorage are always included.
    assert "client/ua.json" in paths
    assert "client/local_storage.json" in paths
    # console is toggled on in the kwargs above.
    assert "client/console.json" in paths


def test_preview_omits_browser_placeholder_when_toggle_off(tmp_path):
    """preview_bundle must not include console placeholder when console toggle is off."""
    kw = _preview_kwargs(tmp_path)
    kw["include"]["console"] = False
    result = db.preview_bundle(**kw)
    paths = {f["path"] for f in result["manifest"]["files"]}
    assert "client/console.json" not in paths


def test_preview_includes_callable_placeholder(tmp_path):
    """preview_bundle must include a callable placeholder for plugins with a callable."""
    def _callable(ctx):
        return {}

    plugin = {
        "id": "myplugin",
        "_diagnostics_callable": _callable,
        "_diagnostics_callable_spec": None,
        "_diagnostics_paths": [],
    }
    kw = _preview_kwargs(tmp_path)
    kw["loaded_plugins"] = [plugin]
    result = db.preview_bundle(**kw)
    paths = {f["path"] for f in result["manifest"]["files"]}
    assert "plugins/myplugin/callable.json" in paths


def test_preview_callable_is_never_executed(tmp_path):
    """preview_bundle must never execute the callable even when plugins toggle is on."""
    called = []

    def _callable(ctx):
        called.append(True)
        return {}

    plugin = {
        "id": "myplugin",
        "_diagnostics_callable": _callable,
        "_diagnostics_callable_spec": None,
        "_diagnostics_paths": [],
    }
    kw = _preview_kwargs(tmp_path)
    kw["loaded_plugins"] = [plugin]
    db.preview_bundle(**kw)
    assert called == [], "callable must not run during preview"


def test_preview_callable_placeholder_is_single_file(tmp_path):
    """preview_bundle injects exactly one callable placeholder (callable.json),
    not all three possible extensions.  The real export emits at most one."""
    def _callable(ctx):
        return {}

    plugin = {
        "id": "myplugin",
        "_diagnostics_callable": _callable,
        "_diagnostics_callable_spec": None,
        "_diagnostics_paths": [],
    }
    kw = _preview_kwargs(tmp_path)
    kw["loaded_plugins"] = [plugin]
    result = db.preview_bundle(**kw)
    paths = {f["path"] for f in result["manifest"]["files"]}
    assert "plugins/myplugin/callable.json" in paths
    # bin and txt variants must NOT be present — the real export will emit
    # at most one and we don't know which until the callable runs.
    assert "plugins/myplugin/callable.bin" not in paths
    assert "plugins/myplugin/callable.txt" not in paths


def test_preview_callable_placeholder_uses_safe_plugin_id(tmp_path):
    """preview_bundle must sanitize the plugin id (via _safe_zip_segment) in the
    callable placeholder path, just as the real export does."""
    plugin = {
        "id": "foo/bar",
        "_diagnostics_callable": lambda ctx: {},
        "_diagnostics_callable_spec": None,
        "_diagnostics_paths": [],
    }
    kw = _preview_kwargs(tmp_path)
    kw["loaded_plugins"] = [plugin]
    result = db.preview_bundle(**kw)
    paths = {f["path"] for f in result["manifest"]["files"]}
    # Raw slash must NOT appear in the callable placeholder path.
    assert "plugins/foo/bar/callable.json" not in paths
    # Sanitized path (%2F for '/') must be present.
    assert "plugins/foo%2Fbar/callable.json" in paths


def test_client_hardware_schema_always_enforced(tmp_path):
    """client/hardware.json must always carry schema='client.hardware.v1' even when
    the browser payload omits the field."""
    kw = _basic_kwargs(tmp_path)
    kw["include"] = {"system": False, "hardware": True, "logs": False, "console": False, "plugins": False}
    kw["client_hardware"] = {"webgl": {"renderer": "Intel Iris Xe"}}  # no schema field
    zip_bytes, _name, manifest = db.build_bundle(**kw)
    with _open_zip(zip_bytes) as zf:
        hw = json.loads(zf.read("client/hardware.json"))
    # Schema must be injected server-side.
    assert hw.get("schema") == "client.hardware.v1"
    # Manifest entry must also carry the schema.
    hw_entry = next((f for f in manifest["files"] if f["path"] == "client/hardware.json"), None)
    assert hw_entry is not None
    assert hw_entry.get("schema") == "client.hardware.v1"


def test_client_hardware_existing_schema_not_overwritten(tmp_path):
    """If the browser payload already declares a schema it is preserved (not overwritten)."""
    kw = _basic_kwargs(tmp_path)
    kw["include"] = {"system": False, "hardware": True, "logs": False, "console": False, "plugins": False}
    kw["client_hardware"] = {"schema": "client.hardware.v2", "extra": True}
    zip_bytes, _name, _manifest = db.build_bundle(**kw)
    with _open_zip(zip_bytes) as zf:
        hw = json.loads(zf.read("client/hardware.json"))
    assert hw.get("schema") == "client.hardware.v2"



def test_callable_spec_load_sibling_failure_in_notes(tmp_path):
    """If load_sibling fails, the error must appear in manifest.notes."""
    def _fail_load_sibling(name):
        raise ImportError(f"No module named {name!r}")

    plugin = {
        "id": "broken_spec",
        "_diagnostics_callable": None,
        "_diagnostics_callable_spec": "missing_module:collect",
        "_load_sibling": _fail_load_sibling,
        "_diagnostics_paths": [],
    }
    notes: list[str] = []
    result = db._plugin_diagnostic_files(plugin, tmp_path, LOG, notes=notes)
    assert "plugins/broken_spec/callable.json" not in result
    assert any(
        "broken_spec" in n and "load_sibling" in n for n in notes
    ), f"Expected load_sibling failure note in {notes}"


def test_callable_spec_function_not_found_in_notes(tmp_path):
    """If the named function does not exist in the resolved module, the error
    must appear in manifest.notes."""
    class FakeMod:
        pass  # no 'collect' attribute

    def _load_sibling(name):
        return FakeMod()

    plugin = {
        "id": "missing_fn",
        "_diagnostics_callable": None,
        "_diagnostics_callable_spec": "diagnostics:no_such_fn",
        "_load_sibling": _load_sibling,
        "_diagnostics_paths": [],
    }
    notes: list[str] = []
    result = db._plugin_diagnostic_files(plugin, tmp_path, LOG, notes=notes)
    assert "plugins/missing_fn/callable.json" not in result
    assert any(
        "missing_fn" in n and "no_such_fn" in n for n in notes
    ), f"Expected not-found note in {notes}"


# ── client_contributions path traversal prevention ───────────────────────────

def test_client_contributions_unknown_plugin_id_rejected(tmp_path):
    """Contributions from plugin IDs not in loaded_plugins must be silently
    dropped to prevent path-traversal entries in the ZIP archive."""
    # "good" is a loaded plugin; "../logs" and "../../manifest.json" are crafted.
    good_plugin = {
        "id": "good",
        "_diagnostics_paths": [],
        "_diagnostics_callable": None,
    }
    kw = _basic_kwargs(tmp_path)
    kw["include"]["plugins"] = True
    kw["loaded_plugins"] = [good_plugin]
    kw["client_contributions"] = {
        "good": {"schema": "ok.v1"},
        "../logs": {"schema": "traversal.v1"},
        "../../manifest.json": {"schema": "traversal.v1"},
    }
    zip_bytes, _name, _m = db.build_bundle(**kw)
    with _open_zip(zip_bytes) as zf:
        names = zf.namelist()
    # Known plugin contribution is written.
    assert "plugins/good/client.json" in names
    # Traversal-style IDs must be rejected entirely.
    for name in names:
        assert "../" not in name, f"Traversal path found in archive: {name}"
        assert "manifest.json" not in name or name == "manifest.json"


# ── plugin_id sanitization for ZIP paths ─────────────────────────────────────

def test_safe_zip_segment_replaces_forward_slash():
    """Forward slashes in plugin ids must be replaced to prevent path traversal.

    Uses percent-encoding so the scheme is bijective: '/' → '%2F'.
    """
    result = db._safe_zip_segment("com.foo/../../bar")
    assert "/" not in result
    assert result == "com.foo%2F..%2F..%2Fbar"


def test_safe_zip_segment_replaces_backslash():
    """Backslashes in plugin ids must also be replaced (→ '%5C')."""
    result = db._safe_zip_segment("plugin\\..\\other")
    assert "\\" not in result
    assert result == "plugin%5C..%5Cother"


def test_safe_zip_segment_passthrough_for_normal_id():
    """Normal ids (dots, hyphens, underscores) are unchanged."""
    assert db._safe_zip_segment("com.example.foo-bar_baz") == "com.example.foo-bar_baz"


def test_safe_zip_segment_is_bijective():
    """A literal '%2F' in a plugin id must not collide with an id containing '/'.

    The old '_sl_' scheme was not collision-free: 'a/b' and 'a_sl_b' both
    produced 'a_sl_b'.  The percent-encoding scheme is bijective because '%'
    itself is encoded first: 'a%2Fb' → 'a%252Fb', while 'a/b' → 'a%2Fb'.
    """
    slash = db._safe_zip_segment("a/b")      # 'a%2Fb'
    literal = db._safe_zip_segment("a%2Fb")  # 'a%252Fb'
    assert slash != literal


def test_loaded_plugin_with_slash_id_does_not_traverse(tmp_path):
    """A loaded plugin whose id contains '/' must not create entries outside plugins/<id>/."""
    slash_plugin = {
        "id": "com.foo/../../etc",
        "_diagnostics_paths": [],
        "_diagnostics_callable": None,
    }
    kw = _basic_kwargs(tmp_path)
    kw["include"]["plugins"] = True
    kw["loaded_plugins"] = [slash_plugin]
    kw["client_contributions"] = {
        "com.foo/../../etc": {"schema": "test.v1"},
    }
    zip_bytes, _name, _m = db.build_bundle(**kw)
    with _open_zip(zip_bytes) as zf:
        names = zf.namelist()
    # No traversal sequences must appear in any archive entry.
    for name in names:
        assert "../" not in name, f"Traversal path found in archive: {name}"
    # The contribution must still be written, under the sanitized id.
    assert any("%2F" in name for name in names if "client.json" in name)


# ── fallback schemas for plugin diagnostics files ────────────────────────────

def test_callable_json_without_schema_gets_fallback_schema(tmp_path):
    """callable.json files that omit their own schema field should receive
    'plugin.callable_output.v1' in manifest.files."""
    def _callable(ctx):
        return {"data": "no schema here"}

    plugin = {
        "id": "my_plugin",
        "_diagnostics_paths": [],
        "_diagnostics_callable": _callable,
    }
    kw = _basic_kwargs(tmp_path)
    kw["include"]["plugins"] = True
    kw["loaded_plugins"] = [plugin]
    _zip, _name, manifest = db.build_bundle(**kw)
    callable_entry = next(
        (f for f in manifest["files"] if f["path"] == "plugins/my_plugin/callable.json"),
        None,
    )
    assert callable_entry is not None, "callable.json not in manifest"
    assert callable_entry.get("schema") == "plugin.callable_output.v1"


def test_server_file_json_without_schema_gets_fallback_schema(tmp_path):
    """A plugin server_file JSON that omits its own schema should receive
    'plugin.server_file.v1' in manifest.files."""
    # Write a JSON file with no top-level 'schema' field.
    (tmp_path / "plugin_data.json").write_text('{"hello": "world"}', encoding="utf-8")
    plugin = {
        "id": "my_plugin",
        "_diagnostics_paths": ["plugin_data.json"],
        "_diagnostics_callable": None,
    }
    kw = _basic_kwargs(tmp_path)
    kw["include"]["plugins"] = True
    kw["loaded_plugins"] = [plugin]
    _zip, _name, manifest = db.build_bundle(**kw)
    data_entry = next(
        (f for f in manifest["files"] if f["path"] == "plugins/my_plugin/plugin_data.json"),
        None,
    )
    assert data_entry is not None, "plugin_data.json not in manifest"
    assert data_entry.get("schema") == "plugin.server_file.v1"


def test_server_file_json_with_own_schema_is_not_overridden(tmp_path):
    """A plugin server_file JSON that declares its own schema field must use
    that schema — not the fallback."""
    (tmp_path / "my_diag.json").write_text(
        '{"schema": "my_plugin.diag.v2", "data": 1}', encoding="utf-8"
    )
    plugin = {
        "id": "my_plugin",
        "_diagnostics_paths": ["my_diag.json"],
        "_diagnostics_callable": None,
    }
    kw = _basic_kwargs(tmp_path)
    kw["include"]["plugins"] = True
    kw["loaded_plugins"] = [plugin]
    _zip, _name, manifest = db.build_bundle(**kw)
    entry = next(
        (f for f in manifest["files"] if f["path"] == "plugins/my_plugin/my_diag.json"),
        None,
    )
    assert entry is not None
    assert entry.get("schema") == "my_plugin.diag.v2"


def test_safe_zip_segment_neutralises_dot():
    """A plugin id of '.' must not produce a bare '.' in the ZIP path."""
    result = db._safe_zip_segment(".")
    assert result != "."
    assert result == "%2E"


def test_safe_zip_segment_neutralises_dotdot():
    """A plugin id of '..' must not produce a bare '..' (path traversal) in the ZIP path."""
    result = db._safe_zip_segment("..")
    assert result != ".."
    assert result == "%2E%2E"


def test_safe_zip_segment_dotdot_bijective():
    """Encoding '..' is bijective: a literal '%2E%2E' id must encode differently."""
    dotdot = db._safe_zip_segment("..")         # "%2E%2E"
    literal = db._safe_zip_segment("%2E%2E")    # "%252E%252E"
    assert dotdot != literal


# ── Symlink safety: directory entries ───────────────────────────────────────

def test_diagnostics_dir_entry_skips_symlinked_top_dir(tmp_path):
    """A diagnostics path ending with '/' that resolves to a symlink should be
    skipped entirely — diagnostics symlink policy mirrors settings export."""
    import os as _os
    real_dir = tmp_path / "real"
    real_dir.mkdir()
    (real_dir / "secret.txt").write_text("SECRET", encoding="utf-8")
    link_dir = tmp_path / "link_to_real"
    try:
        _os.symlink(str(real_dir), str(link_dir), target_is_directory=True)
    except (OSError, NotImplementedError):
        import pytest
        pytest.skip("symlink creation not permitted on this host")

    plugin = {
        "id": "myplugin",
        "_diagnostics_paths": ["link_to_real/"],
        "_diagnostics_callable": None,
    }
    result = db._plugin_diagnostic_files(plugin, tmp_path, LOG)
    assert not any("secret" in k for k in result), (
        "symlinked directory should not be followed in diagnostics export"
    )


def test_diagnostics_dir_entry_skips_symlinked_subdir(tmp_path):
    """Even a non-symlinked top directory should not descend into symlinked
    subdirectories (followlinks=False)."""
    import os as _os
    models_dir = tmp_path / "models"
    models_dir.mkdir()
    (models_dir / "real.json").write_text('{"ok": 1}', encoding="utf-8")
    outside = tmp_path / "outside"
    outside.mkdir()
    (outside / "secret.json").write_text('{"secret": 1}', encoding="utf-8")
    try:
        _os.symlink(str(outside), str(models_dir / "linked"), target_is_directory=True)
    except (OSError, NotImplementedError):
        import pytest
        pytest.skip("symlink creation not permitted on this host")

    plugin = {
        "id": "myplugin",
        "_diagnostics_paths": ["models/"],
        "_diagnostics_callable": None,
    }
    result = db._plugin_diagnostic_files(plugin, tmp_path, LOG)
    assert "plugins/myplugin/models/real.json" in result
    assert not any("secret" in k for k in result), (
        "symlinked subdirectory contents must not appear in diagnostics bundle"
    )


# ── Symlink safety: file entries ─────────────────────────────────────────────

def test_diagnostics_file_entry_skips_symlinked_final_target(tmp_path):
    """A diagnostics file entry that is itself a symlink must be skipped."""
    import os as _os
    real_file = tmp_path / "real_data.json"
    real_file.write_text('{"real": 1}', encoding="utf-8")
    link_file = tmp_path / "link.json"
    try:
        _os.symlink(str(real_file), str(link_file))
    except (OSError, NotImplementedError):
        import pytest
        pytest.skip("symlink creation not permitted on this host")

    plugin = {
        "id": "myplugin",
        "_diagnostics_paths": ["link.json"],
        "_diagnostics_callable": None,
    }
    result = db._plugin_diagnostic_files(plugin, tmp_path, LOG)
    assert "plugins/myplugin/link.json" not in result


def test_diagnostics_file_entry_skips_symlinked_intermediate_dir(tmp_path):
    """A file relpath whose intermediate directory component is a symlink must
    be skipped — prevents data leaks through planted in-config symlinks."""
    import os as _os
    safe = tmp_path / "safe"
    safe.mkdir()
    target_file = safe / "data.json"
    target_file.write_text('{"safe": 1}', encoding="utf-8")
    # Plant a symlink inside config_dir pointing at 'safe'
    link_dir = tmp_path / "linked_models"
    try:
        _os.symlink(str(safe), str(link_dir), target_is_directory=True)
    except (OSError, NotImplementedError):
        import pytest
        pytest.skip("symlink creation not permitted on this host")

    plugin = {
        "id": "myplugin",
        # 'linked_models' is a symlink — must be rejected even though
        # the resolved path is inside config_dir.
        "_diagnostics_paths": ["linked_models/data.json"],
        "_diagnostics_callable": None,
    }
    result = db._plugin_diagnostic_files(plugin, tmp_path, LOG)
    assert "plugins/myplugin/linked_models/data.json" not in result


# ── Preview: client.json contribution placeholders ──────────────────────────

def test_preview_injects_client_json_placeholder_for_frontend_plugin(tmp_path):
    """preview_bundle must advertise plugins/<id>/client.json for plugins with
    has_screen=True (they may call diagnostics.contribute() in screen.js)."""
    plugin = {
        "id": "ui_plugin",
        "has_screen": True,
        "has_script": False,
        "_diagnostics_callable": None,
        "_diagnostics_callable_spec": None,
        "_diagnostics_paths": [],
    }
    kw = _preview_kwargs(tmp_path)
    kw["loaded_plugins"] = [plugin]
    result = db.preview_bundle(**kw)
    paths = {f["path"] for f in result["manifest"]["files"]}
    assert "plugins/ui_plugin/client.json" in paths


def test_preview_injects_client_json_placeholder_for_script_plugin(tmp_path):
    """preview_bundle must advertise client.json for plugins with has_script=True."""
    plugin = {
        "id": "js_plugin",
        "has_screen": False,
        "has_script": True,
        "_diagnostics_callable": None,
        "_diagnostics_callable_spec": None,
        "_diagnostics_paths": [],
    }
    kw = _preview_kwargs(tmp_path)
    kw["loaded_plugins"] = [plugin]
    result = db.preview_bundle(**kw)
    paths = {f["path"] for f in result["manifest"]["files"]}
    assert "plugins/js_plugin/client.json" in paths


def test_preview_does_not_inject_client_json_for_server_only_plugin(tmp_path):
    """Backend-only plugins (no screen, no script) must not get a client.json
    placeholder — they cannot call diagnostics.contribute()."""
    plugin = {
        "id": "backend_plugin",
        "has_screen": False,
        "has_script": False,
        "_diagnostics_callable": None,
        "_diagnostics_callable_spec": None,
        "_diagnostics_paths": [],
    }
    kw = _preview_kwargs(tmp_path)
    kw["loaded_plugins"] = [plugin]
    result = db.preview_bundle(**kw)
    paths = {f["path"] for f in result["manifest"]["files"]}
    assert "plugins/backend_plugin/client.json" not in paths


# ── manifest indexes manifest.json and README.txt ─────────────────────────────

def test_manifest_indexes_manifest_json(tmp_path):
    """manifest.files must include an entry for manifest.json itself."""
    _zip, _name, manifest = db.build_bundle(**_basic_kwargs(tmp_path))
    paths = {f["path"] for f in manifest["files"]}
    assert "manifest.json" in paths


def test_manifest_indexes_readme_txt(tmp_path):
    """manifest.files must include an entry for README.txt."""
    _zip, _name, manifest = db.build_bundle(**_basic_kwargs(tmp_path))
    paths = {f["path"] for f in manifest["files"]}
    assert "README.txt" in paths


def test_manifest_json_entry_has_correct_schema(tmp_path):
    """manifest.json entry must carry BUNDLE_SCHEMA so consumers can dispatch."""
    _zip, _name, manifest = db.build_bundle(**_basic_kwargs(tmp_path))
    entry = next((f for f in manifest["files"] if f["path"] == "manifest.json"), None)
    assert entry is not None
    assert entry["schema"] == db.BUNDLE_SCHEMA
    assert entry["kind"] == "json"


def test_readme_entry_has_text_kind(tmp_path):
    """README.txt entry must have kind='text' and a line count."""
    _zip, _name, manifest = db.build_bundle(**_basic_kwargs(tmp_path))
    entry = next((f for f in manifest["files"] if f["path"] == "README.txt"), None)
    assert entry is not None
    assert entry["kind"] == "text"
    assert "lines" in entry


def test_manifest_files_list_covers_all_zip_entries(tmp_path):
    """Every file in the zip archive must appear in manifest.files."""
    zip_bytes, _name, manifest = db.build_bundle(**_basic_kwargs(tmp_path))
    indexed = {f["path"] for f in manifest["files"]}
    with _open_zip(zip_bytes) as zf:
        archive_names = set(zf.namelist())
    assert archive_names == indexed, (
        f"Unindexed: {archive_names - indexed}  |  Over-indexed: {indexed - archive_names}"
    )


# ── Error-object args redaction in console entries ────────────────────────────

def test_console_error_object_args_are_redacted(tmp_path):
    """Error arguments stored as {name, message, stack} dicts must have their
    string values redacted when redaction is enabled."""
    kw = _basic_kwargs(tmp_path)
    kw["include"]["console"] = True
    kw["redact"] = True
    secret_path = "/home/alice/Music/DLC/my_song.archive"
    kw["client_console"] = [
        {
            "level": "error",
            "msg": "Uncaught error",
            "args": [
                {"name": "Error", "message": f"Cannot load {secret_path}", "stack": f"Error at {secret_path}:1"},
            ],
        }
    ]
    zip_bytes, _name, _m = db.build_bundle(**kw)
    with _open_zip(zip_bytes) as zf:
        console = json.loads(zf.read("client/console.json"))
    entry = console["entries"][0]
    arg = entry["args"][0]
    assert isinstance(arg, dict)
    assert secret_path not in arg.get("message", ""), "DLC path leaked in Error.message"
    assert secret_path not in arg.get("stack", ""), "DLC path leaked in Error.stack"


def test_console_string_args_still_redacted(tmp_path):
    """Plain string args must still be redacted (regression guard)."""
    kw = _basic_kwargs(tmp_path)
    kw["include"]["console"] = True
    kw["redact"] = True
    kw["client_console"] = [
        {"level": "log", "msg": "ok", "args": ["loaded /home/alice/Music/DLC/my_song.archive ok"]},
    ]
    zip_bytes, _name, _m = db.build_bundle(**kw)
    with _open_zip(zip_bytes) as zf:
        console = json.loads(zf.read("client/console.json"))
    # The song filename should be replaced with a hash token, not appear verbatim.
    assert "my_song.archive" not in console["entries"][0]["args"][0]


def test_console_non_string_non_dict_args_pass_through(tmp_path):
    """Numeric and boolean args must not be modified by the redaction pass."""
    kw = _basic_kwargs(tmp_path)
    kw["include"]["console"] = True
    kw["redact"] = True
    kw["client_console"] = [
        {"level": "log", "msg": "ok", "args": [42, True, None]},
    ]
    zip_bytes, _name, _m = db.build_bundle(**kw)
    with _open_zip(zip_bytes) as zf:
        console = json.loads(zf.read("client/console.json"))
    assert console["entries"][0]["args"] == [42, True, None]
