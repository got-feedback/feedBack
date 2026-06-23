"""Unit tests for lib/tailwind_rebuild.py pure-Python contracts.

These cover the wrapper-config generation, installed-plugin counting, and the
skip/no-op behavior when the Tailwind engine or inputs are absent — without
ever invoking the Tailwind CLI.
"""

import tailwind_rebuild as tw


def test_user_plugin_count_counts_only_plugin_json(tmp_path, monkeypatch):
    pdir = tmp_path / "plugins"
    (pdir / "real").mkdir(parents=True)
    (pdir / "real" / "plugin.json").write_text("{}")
    (pdir / "cache").mkdir()          # no plugin.json -> not counted
    (pdir / "__pycache__").mkdir()    # also has no plugin.json -> not counted
    monkeypatch.setenv("FEEDBACK_PLUGINS_DIR", str(pdir))
    assert tw.user_plugin_count() == 1


def test_user_plugin_count_zero_when_unset(monkeypatch):
    monkeypatch.delenv("FEEDBACK_PLUGINS_DIR", raising=False)
    assert tw.user_plugin_count() == 0


def test_write_runtime_config_covers_user_dir_and_excludes_highway(tmp_path, monkeypatch):
    app = tmp_path / "app"
    (app / "static").mkdir(parents=True)
    (app / "plugins").mkdir()
    (app / "tailwind.config.js").write_text("module.exports = {}")
    user = tmp_path / "userplugins"
    user.mkdir()
    monkeypatch.setattr(tw, "APP_DIR", app)
    monkeypatch.setenv("FEEDBACK_PLUGINS_DIR", str(user))

    cfg = tw._write_runtime_config(tmp_path)
    text = cfg.read_text()

    assert "require(" in text                       # reuses base config
    assert str(app / "static") in text              # core static scanned
    assert str(app / "plugins") in text             # baked-in plugins scanned
    assert str(user) in text                        # runtime user plugins scanned
    assert "highway_3d" in text                     # exclusion preserved


def test_write_runtime_config_omits_user_dir_when_unset(tmp_path, monkeypatch):
    app = tmp_path / "app"
    app.mkdir()
    (app / "tailwind.config.js").write_text("module.exports = {}")
    monkeypatch.setattr(tw, "APP_DIR", app)
    monkeypatch.delenv("FEEDBACK_PLUGINS_DIR", raising=False)

    text = tw._write_runtime_config(tmp_path).read_text()
    assert str(app / "static") in text
    # no user dir entry beyond the app tree
    assert "userplugins" not in text


def test_can_rebuild_false_without_inputs(tmp_path, monkeypatch):
    monkeypatch.setattr(tw, "APP_DIR", tmp_path)            # no config/_src present
    monkeypatch.setattr(tw, "_tailwind_cmd", lambda: ["tailwindcss"])
    assert tw.can_rebuild() is False


def test_rebuild_skips_without_engine(monkeypatch):
    monkeypatch.setattr(tw, "_tailwind_cmd", lambda: None)
    assert tw.rebuild("test") is False
