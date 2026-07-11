"""Tests for plugins/__init__.py — namespace isolation for sibling
modules and startup-time collision detection (feedBack#33).

The plugin loader used to insert each plugin directory onto `sys.path`,
which made bare `import sibling` fall through Python's per-name cache
in `sys.modules`. Two plugins shipping a same-named top-level module
(`extractor.py`, `util.py`, …) would step on each other. The loader
now exposes `context['load_sibling'](name)` that loads the sibling
under a namespaced module name `plugin_<plugin_id>.<name>` (with `.`
in plugin_id bijectively encoded — `_` -> `_5f_`, `.` -> `_2e_`),
plus a warning at startup so
existing colliding plugins are visible.
"""

import contextlib
import concurrent.futures
import importlib
import json
import logging
import sys
from pathlib import Path

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient


@contextlib.contextmanager
def capture_logger(caplog, logger_name, level=logging.WARNING):
    """Context manager that attaches *caplog.handler* directly to the named
    logger for the duration of the ``with`` block, then restores its original
    level and ``propagate`` flag.  Bypasses pytest's default root-logger
    attachment so tests that set ``propagate=False`` on their logger still
    capture records even when the ``feedBack`` hierarchy hasn't set up
    handlers yet."""
    logger = logging.getLogger(logger_name)
    orig_level, orig_propagate = logger.level, logger.propagate
    logger.addHandler(caplog.handler)
    logger.setLevel(level)
    logger.propagate = False
    try:
        yield logger
    finally:
        logger.removeHandler(caplog.handler)
        logger.setLevel(orig_level)
        logger.propagate = orig_propagate


def _make_plugin(plugin_root, plugin_id, *, sibling_files=None, routes_body=None):
    """Create a minimal plugin directory under `plugin_root`.

    `sibling_files` is a dict of `{module_name: file_body}` written as
    `{module_name}.py` next to routes. `routes_body` is the contents of
    routes.py — defaults to a no-op `setup` so the plugin loads cleanly.
    """
    plugin_dir = plugin_root / plugin_id
    plugin_dir.mkdir(parents=True)
    (plugin_dir / "plugin.json").write_text(
        json.dumps({"id": plugin_id, "name": plugin_id, "routes": "routes.py"})
    )
    (plugin_dir / "routes.py").write_text(
        routes_body if routes_body is not None else "def setup(app, ctx):\n    pass\n"
    )
    for name, body in (sibling_files or {}).items():
        (plugin_dir / f"{name}.py").write_text(body)
    return plugin_dir


def _run_load_plugins(plugins, app, tmp_path, context=None):
    """Drive load_plugins against a tmp plugin root, restoring module
    state on the way out so each test is isolated."""
    saved_dir = plugins.PLUGINS_DIR
    plugins.PLUGINS_DIR = tmp_path
    try:
        plugins.load_plugins(app, context if context is not None else {})
    finally:
        plugins.PLUGINS_DIR = saved_dir


def test_load_sibling_returns_per_plugin_namespaced_modules(tmp_path, reset_plugin_state):
    """Two plugins shipping `extractor.py` with different exports must
    each see their OWN file via load_sibling — no cross-contamination."""
    plugins = reset_plugin_state
    _make_plugin(
        tmp_path, "alpha",
        sibling_files={"extractor": "MANIFEST_DIR = 'alpha-manifest'\n"},
        routes_body=(
            "def setup(app, ctx):\n"
            "    extractor = ctx['load_sibling']('extractor')\n"
            "    app.state.alpha_manifest = extractor.MANIFEST_DIR\n"
        ),
    )
    _make_plugin(
        tmp_path, "beta",
        sibling_files={"extractor": "BETA_VALUE = 42\n"},
        routes_body=(
            "def setup(app, ctx):\n"
            "    extractor = ctx['load_sibling']('extractor')\n"
            "    app.state.beta_value = extractor.BETA_VALUE\n"
        ),
    )
    fake_app = type("FakeApp", (), {})()
    fake_app.state = type("State", (), {})()
    _run_load_plugins(plugins, fake_app, tmp_path)
    assert fake_app.state.alpha_manifest == "alpha-manifest"
    assert fake_app.state.beta_value == 42
    # The two extractors are namespaced into distinct sys.modules
    # entries. `.` separates id and name to disambiguate when either
    # contains underscores.
    alpha_mod = sys.modules["plugin_alpha.extractor"]
    beta_mod = sys.modules["plugin_beta.extractor"]
    assert alpha_mod is not beta_mod
    assert getattr(alpha_mod, "MANIFEST_DIR", None) == "alpha-manifest"
    assert getattr(beta_mod, "BETA_VALUE", None) == 42
    # Negative cross-check: alpha's extractor must NOT carry beta's exports.
    assert not hasattr(alpha_mod, "BETA_VALUE")
    assert not hasattr(beta_mod, "MANIFEST_DIR")


def test_register_library_provider_context_is_scoped_to_plugin_id(tmp_path, reset_plugin_state):
    plugins = reset_plugin_state
    captured = []
    _make_plugin(
        tmp_path, "remote_source",
        routes_body=(
            "def setup(app, ctx):\n"
            "    provider = {'id': 'remote:source', 'label': 'Remote Source', 'capabilities': ['library.read']}\n"
            "    ctx['register_library_provider'](provider)\n"
        ),
    )

    def register_library_provider(provider, *, replace=False, owner_plugin_id=None):
        captured.append({"provider": provider, "replace": replace, "owner_plugin_id": owner_plugin_id})
        return provider

    _run_load_plugins(
        plugins,
        type("FakeApp", (), {})(),
        tmp_path,
        context={"register_library_provider": register_library_provider},
    )

    assert captured == [{
        "provider": {"id": "remote:source", "label": "Remote Source", "capabilities": ["library.read"]},
        "replace": False,
        "owner_plugin_id": "remote_source",
    }]
    loaded = next(entry for entry in plugins.LOADED_PLUGINS if entry["id"] == "remote_source")
    assert not any(entry.get("capability") == "library" for entry in loaded["compatibility_shims"])


def test_load_sibling_caches_repeat_calls(tmp_path, reset_plugin_state):
    """Two `load_sibling('util')` calls within the same plugin return
    the identical module object — no double exec_module."""
    plugins = reset_plugin_state
    _make_plugin(
        tmp_path, "cached",
        sibling_files={"util": "INSTANCE = object()\n"},
        routes_body=(
            "def setup(app, ctx):\n"
            "    a = ctx['load_sibling']('util')\n"
            "    b = ctx['load_sibling']('util')\n"
            "    app.state.same = a is b\n"
            "    app.state.instance = a.INSTANCE\n"
        ),
    )
    fake_app = type("FakeApp", (), {})()
    fake_app.state = type("State", (), {})()
    _run_load_plugins(plugins, fake_app, tmp_path)
    assert fake_app.state.same is True
    assert fake_app.state.instance is sys.modules["plugin_cached.util"].INSTANCE


def test_load_sibling_missing_module_raises_import_error(tmp_path, reset_plugin_state):
    plugins = reset_plugin_state
    plugin_dir = _make_plugin(tmp_path, "bare")
    with pytest.raises(ImportError):
        plugins._load_plugin_sibling("bare", plugin_dir, "does_not_exist")


def test_load_sibling_rejects_traversal_and_suffix(tmp_path, reset_plugin_state):
    """The helper takes a bare module name; reject anything that could
    traverse paths or carry a redundant .py suffix."""
    plugins = reset_plugin_state
    plugin_dir = _make_plugin(tmp_path, "p")
    # Reject:
    # - empty / non-string (bare module name required)
    # - path traversal (`/`, `\`, `../`)
    # - redundant `.py` suffix
    # - any `.` (used as separator in the cache key — would
    #   otherwise allow ambiguous keys)
    for bad in ("", "../etc", "sub/util", "util.py", "pkg.helper", 123, None):
        with pytest.raises((ValueError, TypeError)):
            plugins._load_plugin_sibling("p", plugin_dir, bad)


def test_collision_warning_fires_for_shared_module_name(tmp_path, reset_plugin_state, caplog):
    """Two plugins both shipping extractor.py must trigger the warning."""
    plugins = reset_plugin_state
    _make_plugin(tmp_path, "rs1extract", sibling_files={"extractor": "X = 1\n"})
    _make_plugin(tmp_path, "discextract", sibling_files={"extractor": "Y = 2\n"})
    with capture_logger(caplog, "feedBack.plugins"):
        _run_load_plugins(plugins, type("FakeApp", (), {})(), tmp_path)
    assert "Module-name collision" in caplog.text
    assert "'extractor' (module)" in caplog.text
    assert "rs1extract" in caplog.text
    assert "discextract" in caplog.text


def test_collision_warning_silent_when_names_unique(tmp_path, reset_plugin_state, caplog):
    plugins = reset_plugin_state
    _make_plugin(tmp_path, "alpha", sibling_files={"alpha_helper": "A = 1\n"})
    _make_plugin(tmp_path, "beta", sibling_files={"beta_helper": "B = 2\n"})
    with capture_logger(caplog, "feedBack.plugins"):
        _run_load_plugins(plugins, type("FakeApp", (), {})(), tmp_path)
    assert "Module-name collision" not in caplog.text


def test_collision_warning_excludes_routes_and_dunders(tmp_path, reset_plugin_state, caplog):
    """routes.py is already namespaced by the loader; __init__.py
    belongs to a plugin that opted into being a package and namespaces
    itself. Neither should trip the collision warning even when both
    plugins ship one."""
    plugins = reset_plugin_state
    p1 = _make_plugin(tmp_path, "one", sibling_files={"unique_one": "V = 1\n"})
    p2 = _make_plugin(tmp_path, "two", sibling_files={"unique_two": "V = 2\n"})
    (p1 / "__init__.py").write_text("")
    (p2 / "__init__.py").write_text("")
    with capture_logger(caplog, "feedBack.plugins"):
        _run_load_plugins(plugins, type("FakeApp", (), {})(), tmp_path)
    assert "Module-name collision" not in caplog.text


def test_collision_warning_dedupes_per_plugin(tmp_path, reset_plugin_state, caplog):
    """A single plugin shipping BOTH `extractor.py` and
    `extractor/__init__.py` is a supported intra-plugin layout
    (load_sibling deterministically prefers the package form,
    matching CPython's import precedence). The warning must NOT
    count it as a 2-plugin collision and emit a bogus message
    listing the same plugin id twice. Codex round 5."""
    plugins = reset_plugin_state
    plugin_dir = _make_plugin(tmp_path, "lonely")
    (plugin_dir / "extractor.py").write_text("FROM = 'file'\n")
    pkg_dir = plugin_dir / "extractor"
    pkg_dir.mkdir()
    (pkg_dir / "__init__.py").write_text("FROM = 'package'\n")
    with capture_logger(caplog, "feedBack.plugins"):
        _run_load_plugins(plugins, type("FakeApp", (), {})(), tmp_path)
    # Only one plugin is involved, so no cross-plugin warning fires.
    assert "Module-name collision" not in caplog.text


def test_collision_warning_still_fires_when_two_plugins_each_have_both_forms(
    tmp_path, reset_plugin_state, caplog
):
    """Two plugins each shipping both forms of `extractor` IS a
    real cross-plugin collision and must be reported. Codex round 5
    sanity check on the dedup logic."""
    plugins = reset_plugin_state
    for pid in ("alpha", "beta"):
        plugin_dir = _make_plugin(tmp_path, pid)
        (plugin_dir / "extractor.py").write_text(f"OWNER = '{pid}-file'\n")
        pkg_dir = plugin_dir / "extractor"
        pkg_dir.mkdir()
        (pkg_dir / "__init__.py").write_text(f"OWNER = '{pid}-package'\n")
    with capture_logger(caplog, "feedBack.plugins"):
        _run_load_plugins(plugins, type("FakeApp", (), {})(), tmp_path)
    collision_records = [r for r in caplog.records if "Module-name collision" in r.getMessage()]
    assert len(collision_records) == 1
    warning = collision_records[0].getMessage()
    assert "alpha" in warning
    assert "beta" in warning
    # The warning text should list each plugin id ONCE, even though
    # both plugins ship two forms of `extractor`.
    assert warning.count("'alpha'") == 1
    assert warning.count("'beta'") == 1
    # Both forms reported in the kind label.
    assert "module/package" in warning


def test_load_sibling_does_not_alias_bare_imported_package(tmp_path, reset_plugin_state):
    """A bare-imported package keeps `__package__` and
    `__spec__.name` as the un-namespaced bare name, so lazy
    relative imports inside it would still resolve through the
    global cache. To avoid that, load_sibling does NOT reuse a
    bare-imported package — it re-executes under the namespaced
    spec instead. Two copies of the package coexist (one bare,
    one namespaced); module-level state diverges. This is
    documented as the trade-off; the alternative would silently
    leak submodule cross-loads. Codex round 5."""
    plugins = reset_plugin_state
    plugin_dir = _make_plugin(tmp_path, "pkgsafe")
    pkg_dir = plugin_dir / "extractor"
    pkg_dir.mkdir()
    (pkg_dir / "__init__.py").write_text("MARK = object()\n")
    (pkg_dir / "child.py").write_text("FROM = 'leaf'\n")
    # Pre-populate sys.modules['extractor'] as if a bare import had
    # already pulled in the package.
    spec = importlib.util.spec_from_file_location(
        "extractor",
        str(pkg_dir / "__init__.py"),
        submodule_search_locations=[str(pkg_dir)],
    )
    bare_pkg = importlib.util.module_from_spec(spec)
    sys.modules["extractor"] = bare_pkg
    spec.loader.exec_module(bare_pkg)
    bare_mark = bare_pkg.MARK
    # load_sibling re-executes under the namespaced spec rather
    # than aliasing the bare package.
    via_helper = plugins._load_plugin_sibling("pkgsafe", plugin_dir, "extractor")
    assert via_helper is not bare_pkg
    # Different MARK objects confirm the namespaced version was
    # actually re-executed.
    assert via_helper.MARK is not bare_mark
    # The namespaced submodule resolves through the namespaced
    # package, NOT through `extractor.child`.
    child = importlib.import_module("plugin_pkgsafe.extractor.child")
    assert child.FROM == "leaf"


def test_load_sibling_handles_dotted_plugin_id_via_escape(tmp_path, reset_plugin_state):
    """Plugins with reverse-DNS-style ids (`foo.bar`) must still be
    able to use load_sibling — the helper escapes `.` in the
    plugin_id portion of the cache key so the synthetic parent
    package is still well-formed. Spotted across codex review
    rounds on PR for feedBack#33."""
    plugins = reset_plugin_state
    plugin_dir = tmp_path / "rdns"
    plugin_dir.mkdir()
    (plugin_dir / "util.py").write_text("VALUE = 'reverse-dns'\n")
    util = plugins._load_plugin_sibling("com.example.foo", plugin_dir, "util")
    assert util.VALUE == "reverse-dns"
    # The cache key uses the bijectively-encoded form so it doesn't
    # fight with Python's package resolution. `.` -> `_2e_`.
    assert "plugin_com_2e_example_2e_foo.util" in sys.modules
    assert sys.modules["plugin_com_2e_example_2e_foo.util"] is util


def test_load_sibling_rejects_empty_plugin_id(tmp_path, reset_plugin_state):
    """Empty / non-string plugin_id is still rejected — the helper
    needs SOMETHING to namespace under."""
    plugins = reset_plugin_state
    plugin_dir = _make_plugin(tmp_path, "valid_id", sibling_files={"util": "X = 1\n"})
    for bad in ("", None, 123):
        with pytest.raises((ValueError, TypeError)):
            plugins._load_plugin_sibling(bad, plugin_dir, "util")


def test_load_sibling_exposes_child_as_parent_attribute(tmp_path, reset_plugin_state):
    """After load_sibling caches a child, Python's package-style
    relative imports (`from . import sibling`, `from .. import
    sibling`) need to find the child as an ATTRIBUTE on the parent
    package — not just in sys.modules. The standard import
    machinery sets that attribute; load_sibling must mimic the
    behavior. Codex round 9."""
    plugins = reset_plugin_state
    plugin_dir = _make_plugin(tmp_path, "expose")
    (plugin_dir / "extractor.py").write_text("VAL = 'extr'\n")
    # Another sibling does `from . import extractor` — pure
    # attribute lookup on the synthetic parent.
    (plugin_dir / "consumer.py").write_text(
        "from . import extractor\n"
        "GOT = extractor.VAL\n"
    )
    # Load the consumer first; while it's executing, the
    # `from . import extractor` triggers extractor's import
    # through the parent package's __path__. After it loads,
    # extractor must be visible as an attribute on the parent.
    consumer = plugins._load_plugin_sibling("expose", plugin_dir, "consumer")
    assert consumer.GOT == "extr"
    parent = sys.modules["plugin_expose"]
    assert hasattr(parent, "extractor")
    assert parent.extractor is sys.modules["plugin_expose.extractor"]
    # And consumer is exposed on the parent the same way.
    assert hasattr(parent, "consumer")
    assert parent.consumer is consumer


def test_load_sibling_supports_relative_imports_between_siblings(tmp_path, reset_plugin_state):
    """A sibling loaded via load_sibling that does `from .shared
    import X` (relative import to another top-level sibling) must
    resolve. The synthetic parent's __path__ points at the plugin
    directory so the import machinery can find sibling files via
    the standard relative-import path. Codex round 7."""
    plugins = reset_plugin_state
    plugin_dir = _make_plugin(tmp_path, "rel")
    (plugin_dir / "shared.py").write_text("SHARED_VALUE = 'shared'\n")
    (plugin_dir / "extractor.py").write_text(
        "from .shared import SHARED_VALUE\n"
        "RE_EXPORT = SHARED_VALUE\n"
    )
    extractor = plugins._load_plugin_sibling("rel", plugin_dir, "extractor")
    assert extractor.RE_EXPORT == "shared"
    # The relatively-imported sibling is registered under the
    # namespaced key, NOT polluted into the global `shared` slot
    # (collision risk with other plugins' `shared.py`).
    assert "plugin_rel.shared" in sys.modules


def test_load_sibling_package_relative_import_to_outside_sibling(tmp_path, reset_plugin_state):
    """A package-form sibling whose __init__.py does
    `from ..shared import X` reaches the parent and finds another
    sibling. Verifies the package + parent-__path__ wiring works
    end-to-end. Codex round 7."""
    plugins = reset_plugin_state
    plugin_dir = _make_plugin(tmp_path, "pkgrel")
    (plugin_dir / "shared.py").write_text("VAL = 42\n")
    pkg_dir = plugin_dir / "extractor"
    pkg_dir.mkdir()
    (pkg_dir / "__init__.py").write_text(
        "from ..shared import VAL\n"
        "VALUE = VAL\n"
    )
    extractor = plugins._load_plugin_sibling("pkgrel", plugin_dir, "extractor")
    assert extractor.VALUE == 42


def test_load_sibling_package_relative_import_works(tmp_path, reset_plugin_state):
    """A package-form sibling whose __init__.py uses `from .child
    import X` must load. Without registering the synthetic parent
    package `plugin_<id>` in sys.modules first, Python can't resolve
    the relative import. Codex round 3 caught this."""
    plugins = reset_plugin_state
    plugin_dir = _make_plugin(tmp_path, "relpkg")
    pkg_dir = plugin_dir / "extractor"
    pkg_dir.mkdir()
    (pkg_dir / "child.py").write_text("CHILD_VALUE = 99\n")
    (pkg_dir / "__init__.py").write_text(
        "from .child import CHILD_VALUE\n"
        "RE_EXPORT = CHILD_VALUE\n"
    )
    extractor = plugins._load_plugin_sibling("relpkg", plugin_dir, "extractor")
    assert extractor.RE_EXPORT == 99
    # Parent package was registered as a synthetic ModuleType.
    assert "plugin_relpkg" in sys.modules


def test_load_sibling_does_not_alias_bare_imported_file_module(tmp_path, reset_plugin_state):
    """Mixed migration: bare `import util` already cached this
    plugin's util.py under the global `util` name. load_sibling
    does NOT alias the bare module into the namespaced cache —
    it re-executes under the namespaced spec. The bare module's
    `__package__` / `__name__` / `__spec__` would otherwise stay
    set to the un-namespaced bare name, and any later relative
    import inside util.py (`from .shared import X` in a function
    body) would route through the bare global cache, undoing the
    isolation. Trade-off: module-level state in util splits across
    two copies until the plugin removes its bare imports. Spotted
    by codex review on PR for feedBack#33 round 8."""
    plugins = reset_plugin_state
    plugin_dir = _make_plugin(tmp_path, "mixmig")
    util_path = plugin_dir / "util.py"
    util_path.write_text("MARK = object()\n")
    spec = importlib.util.spec_from_file_location("util", str(util_path))
    bare_mod = importlib.util.module_from_spec(spec)
    sys.modules["util"] = bare_mod
    spec.loader.exec_module(bare_mod)
    bare_mark = bare_mod.MARK
    via_helper = plugins._load_plugin_sibling("mixmig", plugin_dir, "util")
    # Different module objects — the helper re-executed instead
    # of aliasing.
    assert via_helper is not bare_mod
    assert via_helper.MARK is not bare_mark
    # Namespaced key has the namespaced object; bare key still has
    # the bare-imported object.
    assert sys.modules["plugin_mixmig.util"] is via_helper
    assert sys.modules["util"] is bare_mod
    # Critically, via_helper has the correct namespaced metadata so
    # later relative imports inside it would route through the
    # synthetic parent.
    assert via_helper.__name__ == "plugin_mixmig.util"
    assert via_helper.__package__ == "plugin_mixmig"


def test_safe_plugin_id_encoding_is_collision_free(reset_plugin_state):
    """Distinct plugin_ids must always map to distinct encoded
    forms. The previous `.` -> `_x2e_` (only when `.` was present)
    was not bijective: ids `foo.bar` and `foo_x2e_bar` both produced
    `foo_x2e_bar`. With the bijective `_` -> `_5f_`, `.` -> `_2e_`
    encoding (in that order), no two distinct plugin_ids map to the
    same output. Copilot review on PR #105 round 3."""
    plugins = reset_plugin_state
    samples = [
        "foo",
        "foo_bar",
        "foo.bar",
        "foo_2e_bar",
        "foo_5f_bar",
        "foo_5f_2e_5f_bar",
        "com.example.foo",
        "com_example_foo",
        "com_2e_example_2e_foo",
        "",  # empty edge — empty maps to empty, distinct from all others
        "_",
        ".",
        "._",
        "_.",
    ]
    encoded = [plugins._safe_plugin_id_for_module_name(s) for s in samples]
    # Bijective: distinct inputs -> distinct outputs.
    assert len(set(encoded)) == len(samples), dict(zip(samples, encoded))


def test_load_plugins_skips_non_string_id(tmp_path, reset_plugin_state, caplog):
    """A malformed manifest with a non-string id (e.g. number) is
    skipped with a clear message rather than crashing later inside
    `_safe_plugin_id_for_module_name`'s `.replace()` call. Copilot
    review on PR #105 round 3."""
    plugins = reset_plugin_state
    bad_dir = tmp_path / "bad"
    bad_dir.mkdir()
    (bad_dir / "plugin.json").write_text('{"id": 42, "name": "bad"}')
    _make_plugin(tmp_path, "good", sibling_files={"util": "X = 1\n"})
    fake_app = type("FakeApp", (), {})()
    with capture_logger(caplog, "feedBack.plugins"):
        _run_load_plugins(plugins, fake_app, tmp_path)
    assert "must be a string" in caplog.text
    assert "int" in caplog.text  # type name surfaced
    loaded_ids = {p["id"] for p in plugins.LOADED_PLUGINS}
    assert 42 not in loaded_ids
    assert "good" in loaded_ids


def test_load_plugins_warns_on_falsy_non_string_id(tmp_path, reset_plugin_state, caplog):
    """`{"id": 0}` and `{"id": []}` are falsy non-strings. The
    type-check must run BEFORE the falsy-empty check so the user
    gets the explicit "must be a string" warning instead of a
    silent skip. Copilot review on PR #105 round 4."""
    plugins = reset_plugin_state
    for i, bad_value in enumerate(("0", "[]", "false")):  # JSON literals
        bad_dir = tmp_path / f"bad{i}"
        bad_dir.mkdir()
        (bad_dir / "plugin.json").write_text(f'{{"id": {bad_value}, "name": "x"}}')
    with capture_logger(caplog, "feedBack.plugins"):
        _run_load_plugins(plugins, type("FakeApp", (), {})(), tmp_path)
    # Each malformed manifest produces a "must be a string" warning;
    # none are silently dropped.
    assert caplog.text.count("must be a string") == 3
    assert "int" in caplog.text  # for {"id": 0}
    assert "list" in caplog.text  # for {"id": []}
    assert "bool" in caplog.text  # for {"id": false}


def test_load_plugins_escapes_dotted_id_in_routes_module_name(tmp_path, reset_plugin_state):
    """A plugin with a reverse-DNS id like `com.example.foo` must
    have its routes module registered under a `.`-free name, or
    Python would treat the cache key as a dotted package path and
    set `__package__` to an unintended parent (relative imports in
    routes.py would then resolve against something else entirely).
    The same `.` -> `_2e_` encoding used by load_sibling now
    applies to routes too. Copilot review on PR #105 round 2."""
    plugins = reset_plugin_state
    plugin_dir = tmp_path / "rdns_routes"
    plugin_dir.mkdir()
    (plugin_dir / "plugin.json").write_text(
        json.dumps({"id": "com.example.foo", "name": "rdns", "routes": "routes.py"})
    )
    (plugin_dir / "routes.py").write_text(
        "def setup(app, ctx):\n    app.state.routes_loaded = True\n"
    )
    fake_app = type("FakeApp", (), {})()
    fake_app.state = type("State", (), {})()
    _run_load_plugins(plugins, fake_app, tmp_path)
    assert fake_app.state.routes_loaded is True
    # Routes module is registered under the escaped name and is a
    # single identifier-shaped key — NOT a dotted path that Python
    # would try to resolve as a real package.
    assert "plugin_com_2e_example_2e_foo_routes" in sys.modules
    routes_mod = sys.modules["plugin_com_2e_example_2e_foo_routes"]
    # __package__ is empty (top-level module), not a dotted parent.
    assert (routes_mod.__package__ or "") == ""


def test_load_sibling_parent_registration_is_atomic(tmp_path, reset_plugin_state):
    """Two threads loading DIFFERENT siblings for the same plugin
    must agree on the synthetic parent. If they each constructed a
    fresh ModuleType and assigned to sys.modules[parent_name]
    without coordination, the second assignment could replace the
    first — and child attributes already attached to the
    first parent would disappear, breaking `from . import sibling`.
    setdefault makes the registration atomic. Copilot round 2."""
    import threading
    plugins = reset_plugin_state
    plugin_dir = _make_plugin(tmp_path, "atomic")
    # Two slow siblings so the threads have time to overlap.
    (plugin_dir / "alpha.py").write_text("import time\ntime.sleep(0.05)\nVALUE = 'a'\n")
    (plugin_dir / "beta.py").write_text("import time\ntime.sleep(0.05)\nVALUE = 'b'\n")
    errors: list = []

    def worker(name):
        try:
            plugins._load_plugin_sibling("atomic", plugin_dir, name)
        except BaseException as e:  # pragma: no cover
            errors.append(e)

    threads = [
        threading.Thread(target=worker, args=("alpha",)),
        threading.Thread(target=worker, args=("beta",)),
    ]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    assert not errors
    parent = sys.modules["plugin_atomic"]
    # Both children are exposed as attributes on the SAME parent —
    # neither was lost to a parent-replacement race.
    assert hasattr(parent, "alpha")
    assert hasattr(parent, "beta")
    assert parent.alpha.VALUE == "a"
    assert parent.beta.VALUE == "b"


def test_load_sibling_concurrent_first_call_returns_fully_initialized(tmp_path, reset_plugin_state):
    """Two threads racing on the same first-time load_sibling call
    should both receive a fully-initialized module object — neither
    can observe the half-built module that's briefly registered in
    sys.modules between `module_from_spec` and the end of
    `exec_module`. The per-module lock added in round 8 enforces
    this."""
    import threading
    plugins = reset_plugin_state
    plugin_dir = _make_plugin(tmp_path, "racy")
    # The sibling's __init__ does meaningful work BEFORE setting
    # `READY = True`, so a partially-initialized module would lack
    # the attribute even though the module object exists in
    # sys.modules.
    (plugin_dir / "slow.py").write_text(
        "import time\n"
        "time.sleep(0.05)\n"
        "READY = True\n"
        "VALUE = 'done'\n"
    )
    results: list = []
    errors: list = []

    def worker():
        try:
            mod = plugins._load_plugin_sibling("racy", plugin_dir, "slow")
            results.append((mod, getattr(mod, "READY", None), getattr(mod, "VALUE", None)))
        except BaseException as e:  # pragma: no cover - bug path
            errors.append(e)

    threads = [threading.Thread(target=worker) for _ in range(8)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    assert not errors
    assert len(results) == 8
    # Every caller sees the same fully-initialized module.
    first_mod, _, _ = results[0]
    for mod, ready, value in results:
        assert mod is first_mod
        assert ready is True
        assert value == "done"


def test_load_sibling_does_not_reuse_other_plugins_bare_import(tmp_path, reset_plugin_state):
    """If sys.path has already cached a util.py from PLUGIN A under
    the bare name `util`, plugin B's load_sibling('util') must NOT
    return plugin A's module — it has to load plugin B's own copy
    under the namespaced key. This is the whole point of the
    isolation fix; the reuse path can't accidentally undo it."""
    plugins = reset_plugin_state
    plugin_a = _make_plugin(tmp_path, "plug_a")
    plugin_b = _make_plugin(tmp_path, "plug_b")
    (plugin_a / "util.py").write_text("OWNER = 'a'\n")
    (plugin_b / "util.py").write_text("OWNER = 'b'\n")
    # Simulate plugin A's bare import landing in sys.modules['util'].
    spec_a = importlib.util.spec_from_file_location("util", str(plugin_a / "util.py"))
    bare_a = importlib.util.module_from_spec(spec_a)
    sys.modules["util"] = bare_a
    spec_a.loader.exec_module(bare_a)
    assert bare_a.OWNER == "a"
    # Plugin B's load_sibling must give plugin B's util, NOT plugin A's.
    b_util = plugins._load_plugin_sibling("plug_b", plugin_b, "util")
    assert b_util is not bare_a
    assert b_util.OWNER == "b"


def test_load_sibling_loads_package_form(tmp_path, reset_plugin_state):
    """A plugin shipping a sibling as a package directory
    (`extractor/__init__.py`) should be loadable through
    load_sibling exactly like a single-file `.py` sibling. The
    collision-warning scanner directs maintainers of package-form
    plugins toward load_sibling, so the helper has to actually
    support them. Codex review on PR for feedBack#33."""
    plugins = reset_plugin_state
    plugin_dir = _make_plugin(tmp_path, "pkgplugin")
    pkg_dir = plugin_dir / "extractor"
    pkg_dir.mkdir()
    (pkg_dir / "__init__.py").write_text("ROOT_VALUE = 7\n")
    (pkg_dir / "child.py").write_text("CHILD_VALUE = 8\n")
    extractor = plugins._load_plugin_sibling("pkgplugin", plugin_dir, "extractor")
    assert extractor.ROOT_VALUE == 7
    # Submodule lookup works because spec carried submodule_search_locations.
    child = importlib.import_module("plugin_pkgplugin.extractor.child")
    assert child.CHILD_VALUE == 8


def test_load_sibling_prefers_package_over_file_when_both_exist(tmp_path, reset_plugin_state):
    """If a plugin ships BOTH `extractor.py` and `extractor/__init__.py`
    in the same directory, the package form wins — matches CPython's
    own import-resolution precedence so bare `import extractor` and
    `load_sibling('extractor')` always run the same code path.
    Spotted by codex review on PR for feedBack#33."""
    plugins = reset_plugin_state
    plugin_dir = _make_plugin(tmp_path, "both")
    (plugin_dir / "extractor.py").write_text("FROM = 'file'\n")
    pkg_dir = plugin_dir / "extractor"
    pkg_dir.mkdir()
    (pkg_dir / "__init__.py").write_text("FROM = 'package'\n")
    extractor = plugins._load_plugin_sibling("both", plugin_dir, "extractor")
    assert extractor.FROM == "package"


def test_load_sibling_missing_in_both_forms_raises_with_useful_message(tmp_path, reset_plugin_state):
    plugins = reset_plugin_state
    plugin_dir = _make_plugin(tmp_path, "empty")
    with pytest.raises(ImportError) as exc:
        plugins._load_plugin_sibling("empty", plugin_dir, "missing")
    msg = str(exc.value)
    # Error message should mention BOTH probed locations so a
    # confused author sees "I checked here AND here" not "I checked
    # only the .py form".
    assert "missing.py" in msg
    assert "missing" in msg and "__init__.py" in msg


def test_load_sibling_disambiguates_underscored_ids_and_names(tmp_path, reset_plugin_state):
    """`(plugin_id='a_b', name='c')` and `(plugin_id='a', name='b_c')`
    must NOT collide in sys.modules. The `.` separator + bijective
    `_` -> `_5f_` encoding of plugin_id make the cache key
    unambiguous (the old `_` separator collapsed both to
    `plugin_a_b_c`). Codex review on PR for feedBack#33."""
    plugins = reset_plugin_state
    p1 = _make_plugin(tmp_path, "a_b", sibling_files={"c": "WHO = 'a_b/c'\n"})
    p2 = _make_plugin(tmp_path, "a", sibling_files={"b_c": "WHO = 'a/b_c'\n"})
    m1 = plugins._load_plugin_sibling("a_b", p1, "c")
    m2 = plugins._load_plugin_sibling("a", p2, "b_c")
    assert m1 is not m2
    assert m1.WHO == "a_b/c"
    assert m2.WHO == "a/b_c"
    # Both keys exist independently in sys.modules. plugin_id `a_b`
    # encodes to `a_5f_b` so the parent is `plugin_a_5f_b`. The
    # NAME portion is not encoded (it's only the plugin_id that
    # could be confused with the `.` separator). So:
    #   id='a_b', name='c'   -> plugin_a_5f_b.c
    #   id='a',   name='b_c' -> plugin_a.b_c
    # The old `_` separator collapsed both to `plugin_a_b_c`.
    assert "plugin_a_5f_b.c" in sys.modules
    assert "plugin_a.b_c" in sys.modules
    assert sys.modules["plugin_a_5f_b.c"] is m1
    assert sys.modules["plugin_a.b_c"] is m2


def test_collision_warning_detects_package_form(tmp_path, reset_plugin_state, caplog):
    """A plugin shipping `extractor/__init__.py` collides with another
    plugin's `extractor.py` the same way two `.py` files would. The
    scanner picks up packages too. Codex review on PR for feedBack#33."""
    plugins = reset_plugin_state
    # Plugin one: extractor.py
    _make_plugin(tmp_path, "as_module", sibling_files={"extractor": "X = 1\n"})
    # Plugin two: extractor/ (package form)
    plugin_pkg = _make_plugin(tmp_path, "as_package")
    pkg_dir = plugin_pkg / "extractor"
    pkg_dir.mkdir()
    (pkg_dir / "__init__.py").write_text("Y = 2\n")
    with capture_logger(caplog, "feedBack.plugins"):
        _run_load_plugins(plugins, type("FakeApp", (), {})(), tmp_path)
    assert "Module-name collision" in caplog.text
    assert "extractor" in caplog.text
    assert "as_module" in caplog.text
    assert "as_package" in caplog.text
    # The mixed-form label should also appear so the maintainer knows
    # to look for both shapes.
    assert "module/package" in caplog.text


def test_collision_warning_detects_two_packages(tmp_path, reset_plugin_state, caplog):
    """Two plugins each shipping the SAME package directory form."""
    plugins = reset_plugin_state
    for pid in ("plug_a", "plug_b"):
        plugin_dir = _make_plugin(tmp_path, pid)
        pkg = plugin_dir / "shared_pkg"
        pkg.mkdir()
        (pkg / "__init__.py").write_text(f"# {pid}\n")
    with capture_logger(caplog, "feedBack.plugins"):
        _run_load_plugins(plugins, type("FakeApp", (), {})(), tmp_path)
    assert "Module-name collision" in caplog.text
    assert "shared_pkg" in caplog.text
    assert "plug_a" in caplog.text
    assert "plug_b" in caplog.text


def test_per_plugin_context_does_not_leak_load_sibling_across_plugins(tmp_path, reset_plugin_state):
    """Plugin A's `load_sibling` must close over plugin A's id+dir.
    If both plugins received the SAME closure (the bug we are
    preventing), plugin A calling `load_sibling('thing')` would
    load whatever the loop's last-iteration closure pointed at —
    typically the alphabetically-last plugin's directory."""
    plugins = reset_plugin_state
    _make_plugin(
        tmp_path, "aaa",
        sibling_files={"thing": "ORIGIN = 'aaa'\n"},
        routes_body=(
            "def setup(app, ctx):\n"
            "    app.state.aaa_origin = ctx['load_sibling']('thing').ORIGIN\n"
        ),
    )
    _make_plugin(
        tmp_path, "zzz",
        sibling_files={"thing": "ORIGIN = 'zzz'\n"},
        routes_body=(
            "def setup(app, ctx):\n"
            "    app.state.zzz_origin = ctx['load_sibling']('thing').ORIGIN\n"
        ),
    )
    fake_app = type("FakeApp", (), {})()
    fake_app.state = type("State", (), {})()
    _run_load_plugins(plugins, fake_app, tmp_path)
    assert fake_app.state.aaa_origin == "aaa"
    assert fake_app.state.zzz_origin == "zzz"


# ── Bundled plugins always win over user-installed copies ────────────────────

def test_bundled_plugin_always_wins_over_feedBack_plugins_dir_copy(
    tmp_path, reset_plugin_state, monkeypatch, caplog
):
    """Bundled plugins always win over user-installed copies in FEEDBACK_PLUGINS_DIR.

    Even though FEEDBACK_PLUGINS_DIR is scanned first, a user-installed copy
    with the same id as a bundled plugin is evicted in favour of the bundled
    version. The loader emits a warning naming the ignored user copy.
    """
    plugins = reset_plugin_state

    # Simulate the in-tree (bundled) plugins directory.
    bundled_dir = tmp_path / "bundled"
    bundled_dir.mkdir()
    _make_plugin(
        bundled_dir, "highway_3d",
        routes_body=(
            "def setup(app, ctx):\n"
            "    app.state.origin = 'bundled'\n"
        ),
    )
    # Mark the in-tree plugin as bundled — required for override detection.
    (bundled_dir / "highway_3d" / "plugin.json").write_text(
        json.dumps({"id": "highway_3d", "name": "highway_3d", "routes": "routes.py", "bundled": True})
    )

    # Simulate a user-installed plugins directory (FEEDBACK_PLUGINS_DIR).
    user_dir = tmp_path / "user"
    user_dir.mkdir()
    _make_plugin(
        user_dir, "highway_3d",
        routes_body=(
            "def setup(app, ctx):\n"
            "    app.state.origin = 'user'\n"
        ),
    )

    monkeypatch.setenv("FEEDBACK_PLUGINS_DIR", str(user_dir))

    fake_app = type("FakeApp", (), {})()
    fake_app.state = type("State", (), {})()

    # Use bundled_dir as the in-tree PLUGINS_DIR root.
    saved_dir = plugins.PLUGINS_DIR
    plugins.PLUGINS_DIR = bundled_dir
    try:
        with capture_logger(caplog, "feedBack.plugins"):
            plugins.load_plugins(fake_app, {})
    finally:
        plugins.PLUGINS_DIR = saved_dir

    # Bundled copy must win — setup() from bundled_dir ran, not user_dir.
    assert fake_app.state.origin == "bundled"
    # Exactly one highway_3d entry registered.
    hw3d_entries = [p for p in plugins.LOADED_PLUGINS if p["id"] == "highway_3d"]
    assert len(hw3d_entries) == 1
    # The loader emits a warning about the ignored user copy, naming its path.
    assert (
        "User-installed copy of bundled plugin 'highway_3d'" in caplog.text
        and "ignored" in caplog.text
        and str(user_dir / "highway_3d") in caplog.text
    )


def test_bundled_plugin_wins_over_user_copy_and_logs_warning(
    tmp_path, reset_plugin_state, monkeypatch, caplog
):
    """Bundled plugin wins over a user-installed copy with the same id.

    The loader emits a warning naming the ignored user copy. The kept entry
    is the bundled version (bundled=True, dir matches plugin id).
    """
    plugins = reset_plugin_state

    # In-tree bundled plugin — plugin.json carries ``"bundled": true``.
    bundled_dir = tmp_path / "bundled"
    bundled_dir.mkdir()
    plugin_dir = bundled_dir / "highway_3d"
    plugin_dir.mkdir()
    (plugin_dir / "plugin.json").write_text(
        json.dumps({"id": "highway_3d", "name": "3D Highway", "bundled": True})
    )

    # User-installed copy with the same id in a differently-named directory.
    user_dir = tmp_path / "user"
    user_dir.mkdir()
    user_plugin_dir = user_dir / "3dhighway"  # different directory name
    user_plugin_dir.mkdir()
    (user_plugin_dir / "plugin.json").write_text(
        json.dumps({"id": "highway_3d", "name": "3D Highway (user)"})
    )

    monkeypatch.setenv("FEEDBACK_PLUGINS_DIR", str(user_dir))

    fake_app = type("FakeApp", (), {})()
    saved_dir = plugins.PLUGINS_DIR
    plugins.PLUGINS_DIR = bundled_dir
    try:
        with capture_logger(caplog, "feedBack.plugins"):
            plugins.load_plugins(fake_app, {})
    finally:
        plugins.PLUGINS_DIR = saved_dir

    # Exactly one entry registered.
    hw3d_entries = [p for p in plugins.LOADED_PLUGINS if p["id"] == "highway_3d"]
    assert len(hw3d_entries) == 1

    # The kept copy must be the bundled version.
    kept = hw3d_entries[0]
    assert str(kept["_dir"]) == str(plugin_dir)
    assert kept.get("bundled") is True

    # The loader must emit the specific warning about the ignored user copy, naming its path.
    assert (
        "User-installed copy of bundled plugin 'highway_3d'" in caplog.text
        and "ignored" in caplog.text
        and str(user_plugin_dir) in caplog.text
    )


def test_bundled_plugin_wins_over_verbatim_user_copy(
    tmp_path, reset_plugin_state, monkeypatch, caplog
):
    """Bundled plugin wins even when the user copy verbatim-copied ``"bundled": true``.

    The three-part ``_is_bundled()`` check — in-tree directory, manifest field,
    AND dir name == plugin id — correctly identifies the in-tree copy as
    bundled and ignores the user copy regardless of its manifest contents.
    """
    plugins = reset_plugin_state

    # In-tree bundled plugin.
    bundled_dir = tmp_path / "bundled"
    bundled_dir.mkdir()
    plugin_dir = bundled_dir / "highway_3d"
    plugin_dir.mkdir()
    (plugin_dir / "plugin.json").write_text(
        json.dumps({"id": "highway_3d", "name": "3D Highway", "bundled": True})
    )

    # User copy that was copied verbatim from in-tree — still carries bundled=true.
    user_dir = tmp_path / "user"
    user_dir.mkdir()
    user_plugin_dir = user_dir / "highway_3d_custom"
    user_plugin_dir.mkdir()
    (user_plugin_dir / "plugin.json").write_text(
        json.dumps({"id": "highway_3d", "name": "3D Highway (custom)", "bundled": True})
    )

    monkeypatch.setenv("FEEDBACK_PLUGINS_DIR", str(user_dir))

    fake_app = type("FakeApp", (), {})()
    saved_dir = plugins.PLUGINS_DIR
    plugins.PLUGINS_DIR = bundled_dir
    try:
        with capture_logger(caplog, "feedBack.plugins"):
            plugins.load_plugins(fake_app, {})
    finally:
        plugins.PLUGINS_DIR = saved_dir

    # Exactly one entry registered.
    hw3d_entries = [p for p in plugins.LOADED_PLUGINS if p["id"] == "highway_3d"]
    assert len(hw3d_entries) == 1

    # The kept copy must be the real bundled version.
    kept = hw3d_entries[0]
    assert str(kept["_dir"]) == str(plugin_dir)
    assert kept.get("bundled") is True

    # The loader emits the warning about the ignored user copy, naming its path.
    assert (
        "User-installed copy of bundled plugin 'highway_3d'" in caplog.text
        and "ignored" in caplog.text
        and str(user_plugin_dir) in caplog.text
    )


def test_bundled_plugin_wins_over_copy_in_same_plugins_dir(
    tmp_path, reset_plugin_state, caplog
):
    """Bundled plugin wins even when a user fork sorts alphabetically first.

    Both plugins live under the same PLUGINS_DIR, so override detection cannot
    use the directory parent alone. The three-part ``_is_bundled()`` check —
    ``(in-tree dir) AND manifest.get("bundled") AND (dir name == plugin id)`` —
    identifies the bundled copy and discards the user fork.

    Layout mirroring the canonical example from the PR description:
      plugins/3dhighway/   ← user-installed fork (no "bundled" field)
      plugins/highway_3d/  ← bundled core (has "bundled": true, dir name == id)

    ``3dhighway`` sorts before ``highway_3d`` alphabetically and is registered
    first; when ``highway_3d`` arrives it evicts the user fork and wins.
    """
    plugins = reset_plugin_state

    plugins_dir = tmp_path / "plugins"
    plugins_dir.mkdir()

    # User-installed fork — comes first alphabetically.
    user_plugin_dir = plugins_dir / "3dhighway"
    user_plugin_dir.mkdir()
    (user_plugin_dir / "plugin.json").write_text(
        json.dumps({"id": "highway_3d", "name": "3D Highway (user fork)"})
    )

    # Bundled core — sorts after "3dhighway"; evicts the user fork when encountered.
    bundled_plugin_dir = plugins_dir / "highway_3d"
    bundled_plugin_dir.mkdir()
    (bundled_plugin_dir / "plugin.json").write_text(
        json.dumps({"id": "highway_3d", "name": "3D Highway", "bundled": True})
    )

    fake_app = type("FakeApp", (), {})()
    saved_dir = plugins.PLUGINS_DIR
    plugins.PLUGINS_DIR = plugins_dir
    try:
        with capture_logger(caplog, "feedBack.plugins"):
            plugins.load_plugins(fake_app, {})
    finally:
        plugins.PLUGINS_DIR = saved_dir

    hw3d_entries = [p for p in plugins.LOADED_PLUGINS if p["id"] == "highway_3d"]
    assert len(hw3d_entries) == 1

    # The bundled copy must win, regardless of alphabetical order.
    kept = hw3d_entries[0]
    assert str(kept["_dir"]) == str(bundled_plugin_dir)

    # Bundled flag set on the kept copy.
    assert kept.get("bundled") is True

    # The loader emits the specific warning about the ignored user copy, naming its path.
    assert (
        "User-installed copy of bundled plugin 'highway_3d'" in caplog.text
        and "ignored" in caplog.text
        and str(user_plugin_dir) in caplog.text
    )


def test_bundled_plugin_wins_over_copy_in_same_plugins_dir_bundled_sorts_first(
    tmp_path, reset_plugin_state, caplog
):
    """Bundled plugin wins when it sorts *before* the user directory.

    When the bundled copy is encountered first it is registered; the later
    user copy is discarded with a warning.

    Layout where bundled sorts before user:
      plugins/highway_3d/   ← bundled core (has "bundled": true), sorts first
      plugins/zzz-highway/  ← user-installed fork (no "bundled" field), sorts last
    """
    plugins = reset_plugin_state

    plugins_dir = tmp_path / "plugins"
    plugins_dir.mkdir()

    # Bundled core — sorts first alphabetically.
    bundled_plugin_dir = plugins_dir / "highway_3d"
    bundled_plugin_dir.mkdir()
    (bundled_plugin_dir / "plugin.json").write_text(
        json.dumps({"id": "highway_3d", "name": "3D Highway", "bundled": True})
    )

    # User-installed fork — sorts after "highway_3d", will be encountered second.
    user_plugin_dir = plugins_dir / "zzz-highway"
    user_plugin_dir.mkdir()
    (user_plugin_dir / "plugin.json").write_text(
        json.dumps({"id": "highway_3d", "name": "3D Highway (user fork)"})
    )

    fake_app = type("FakeApp", (), {})()
    saved_dir = plugins.PLUGINS_DIR
    plugins.PLUGINS_DIR = plugins_dir
    try:
        with capture_logger(caplog, "feedBack.plugins"):
            plugins.load_plugins(fake_app, {})
    finally:
        plugins.PLUGINS_DIR = saved_dir

    hw3d_entries = [p for p in plugins.LOADED_PLUGINS if p["id"] == "highway_3d"]
    assert len(hw3d_entries) == 1

    # The bundled copy must win; user fork is discarded.
    kept = hw3d_entries[0]
    assert str(kept["_dir"]) == str(bundled_plugin_dir)

    # Bundled flag set on the kept copy.
    assert kept.get("bundled") is True

    # The loader emits the specific warning about the ignored user copy, naming its path.
    assert (
        "User-installed copy of bundled plugin 'highway_3d'" in caplog.text
        and "ignored" in caplog.text
        and str(user_plugin_dir) in caplog.text
    )


def test_bundled_plugin_wins_over_verbatim_copy_in_same_plugins_dir(
    tmp_path, reset_plugin_state, caplog
):
    """Bundled plugin wins over a verbatim user copy that carries ``"bundled": true``.

    The three-part ``_is_bundled()`` check — in-tree directory, manifest field,
    AND directory-name-matches-plugin-id — correctly identifies the real core
    copy and rejects the verbatim clone (dir name ≠ plugin id).

    Layout:
      plugins/highway_3d/   ← bundled core (has "bundled": true, dir name == id)
      plugins/zzz-highway/  ← verbatim user copy (has "bundled": true, dir name ≠ id)

    ``highway_3d`` sorts before ``zzz-highway``; the bundled copy is encountered
    first. When the user copy arrives it is not truly bundled (dir name mismatch)
    and is discarded with a warning.
    """
    plugins = reset_plugin_state

    plugins_dir = tmp_path / "plugins"
    plugins_dir.mkdir()

    # Bundled core — dir name == plugin id, has "bundled": true.
    bundled_plugin_dir = plugins_dir / "highway_3d"
    bundled_plugin_dir.mkdir()
    (bundled_plugin_dir / "plugin.json").write_text(
        json.dumps({"id": "highway_3d", "name": "3D Highway", "bundled": True})
    )

    # Verbatim user copy — different dir name, but manifest is identical (including "bundled": true).
    user_plugin_dir = plugins_dir / "zzz-highway"
    user_plugin_dir.mkdir()
    (user_plugin_dir / "plugin.json").write_text(
        json.dumps({"id": "highway_3d", "name": "3D Highway", "bundled": True})
    )

    fake_app = type("FakeApp", (), {})()
    saved_dir = plugins.PLUGINS_DIR
    plugins.PLUGINS_DIR = plugins_dir
    try:
        with capture_logger(caplog, "feedBack.plugins"):
            plugins.load_plugins(fake_app, {})
    finally:
        plugins.PLUGINS_DIR = saved_dir

    hw3d_entries = [p for p in plugins.LOADED_PLUGINS if p["id"] == "highway_3d"]
    assert len(hw3d_entries) == 1

    # The real bundled copy (highway_3d) must win; the verbatim clone is discarded.
    kept = hw3d_entries[0]
    assert str(kept["_dir"]) == str(bundled_plugin_dir)

    # Bundled flag set on the kept copy.
    assert kept.get("bundled") is True

    # Warning about the ignored user copy must be emitted, naming its path.
    assert (
        "User-installed copy of bundled plugin 'highway_3d'" in caplog.text
        and "ignored" in caplog.text
        and str(user_plugin_dir) in caplog.text
    )


def test_bundled_wins_with_multiple_stale_copies(
    tmp_path, reset_plugin_state, monkeypatch, caplog
):
    """Bundled plugin wins when multiple stale copies exist simultaneously.

    Exercises the exact #181 layout: the user has both an external
    ``FEEDBACK_PLUGINS_DIR/highway_3d`` copy AND a stale in-tree clone at
    ``plugins/3dhighway``, alongside the real bundled ``plugins/highway_3d``.

    Scan order:
    1. FEEDBACK_PLUGINS_DIR scanned first → user_dir/highway_3d registered.
    2. PLUGINS_DIR scanned next (sorted):
       - ``3dhighway`` sorts before ``highway_3d`` → duplicate, neither is bundled
         → discarded with a warning naming the specific plugin_dir.
       - ``highway_3d`` → bundled; evicts the FEEDBACK_PLUGINS_DIR copy; wins.

    Both stale paths must be named in warning log messages.
    """
    plugins = reset_plugin_state

    # Simulate the in-tree (bundled) plugins directory.
    plugins_dir = tmp_path / "plugins"
    plugins_dir.mkdir()

    # Stale in-tree clone (different dir name; not bundled because dir ≠ id).
    stale_intree_dir = plugins_dir / "3dhighway"
    stale_intree_dir.mkdir()
    (stale_intree_dir / "plugin.json").write_text(
        json.dumps({"id": "highway_3d", "name": "3D Highway (stale clone)"})
    )

    # Real bundled copy.
    bundled_plugin_dir = plugins_dir / "highway_3d"
    bundled_plugin_dir.mkdir()
    (bundled_plugin_dir / "plugin.json").write_text(
        json.dumps({"id": "highway_3d", "name": "3D Highway", "bundled": True})
    )

    # Simulate a user-installed plugins directory (FEEDBACK_PLUGINS_DIR).
    user_dir = tmp_path / "user"
    user_dir.mkdir()
    user_plugin_dir = user_dir / "highway_3d"
    user_plugin_dir.mkdir()
    (user_plugin_dir / "plugin.json").write_text(
        json.dumps({"id": "highway_3d", "name": "3D Highway (user)"})
    )

    monkeypatch.setenv("FEEDBACK_PLUGINS_DIR", str(user_dir))

    fake_app = type("FakeApp", (), {})()
    saved_dir = plugins.PLUGINS_DIR
    plugins.PLUGINS_DIR = plugins_dir
    try:
        with capture_logger(caplog, "feedBack.plugins"):
            plugins.load_plugins(fake_app, {})
    finally:
        plugins.PLUGINS_DIR = saved_dir

    # Exactly one entry registered.
    hw3d_entries = [p for p in plugins.LOADED_PLUGINS if p["id"] == "highway_3d"]
    assert len(hw3d_entries) == 1

    # The bundled copy must win.
    kept = hw3d_entries[0]
    assert str(kept["_dir"]) == str(bundled_plugin_dir)
    assert kept.get("bundled") is True

    # The stale in-tree clone path must be named in the log.
    assert str(stale_intree_dir) in caplog.text
    # The user-installed copy path must be named in the log (bundled-wins warning).
    assert (
        "User-installed copy of bundled plugin 'highway_3d'" in caplog.text
        and "ignored" in caplog.text
        and str(user_plugin_dir) in caplog.text
    )


def test_fallback_to_user_copy_when_bundled_routes_fail(
    tmp_path, reset_plugin_state, monkeypatch, caplog
):
    """If a bundled plugin's routes.setup() raises, the loader falls back to
    the previously-evicted user-installed copy so the server keeps working.
    """
    plugins = reset_plugin_state

    bundled_dir = tmp_path / "bundled"
    bundled_dir.mkdir()
    # Bundled copy whose routes.setup() will raise.
    bundled_plugin_dir = bundled_dir / "highway_3d"
    bundled_plugin_dir.mkdir()
    (bundled_plugin_dir / "plugin.json").write_text(
        json.dumps({"id": "highway_3d", "name": "3D Highway", "routes": "routes.py", "bundled": True})
    )
    (bundled_plugin_dir / "routes.py").write_text(
        "def setup(app, ctx):\n    raise RuntimeError('bundled broken')\n"
    )

    user_dir = tmp_path / "user"
    user_dir.mkdir()
    user_plugin_dir = user_dir / "highway_3d"
    user_plugin_dir.mkdir()
    (user_plugin_dir / "plugin.json").write_text(
        json.dumps({"id": "highway_3d", "name": "3D Highway (user)", "routes": "routes.py"})
    )
    (user_plugin_dir / "routes.py").write_text(
        "def setup(app, ctx):\n    app.state.origin = 'user_fallback'\n"
    )

    monkeypatch.setenv("FEEDBACK_PLUGINS_DIR", str(user_dir))

    fake_app = type("FakeApp", (), {})()
    fake_app.state = type("State", (), {})()
    saved_dir = plugins.PLUGINS_DIR
    plugins.PLUGINS_DIR = bundled_dir
    try:
        with capture_logger(caplog, "feedBack.plugins", level=logging.WARNING):
            plugins.load_plugins(fake_app, {})
    finally:
        plugins.PLUGINS_DIR = saved_dir

    # The fallback user copy should be registered.
    hw3d_entries = [p for p in plugins.LOADED_PLUGINS if p["id"] == "highway_3d"]
    assert len(hw3d_entries) == 1
    assert hw3d_entries[0].get("bundled") is False
    assert str(hw3d_entries[0]["_dir"]) == str(user_plugin_dir)

    # The fallback's routes.setup() should have run.
    assert getattr(fake_app.state, "origin", None) == "user_fallback"

    # The fallback warning must be logged.
    assert "falling back to user-installed copy" in caplog.text
    assert str(user_plugin_dir) in caplog.text


def test_fallback_when_bundled_sorts_first_and_routes_fail(
    tmp_path, reset_plugin_state, caplog
):
    """Fallback works even when the bundled plugin is discovered BEFORE the user copy.

    Thread 6 regression: the `elif kept_is_bundled:` branch previously
    discarded the user copy without storing it in `_pending_evictions`, so
    a bundled plugin discovered first had no fallback available.

    Layout (both in the same plugins_dir, bundled sorts first):
      plugins/highway_3d/   ← bundled (broken routes)
      plugins/zzz-highway/  ← user copy (working routes)
    """
    plugins = reset_plugin_state

    plugins_dir = tmp_path / "plugins"
    plugins_dir.mkdir()

    # Bundled copy — sorts first alphabetically; routes.setup() will raise.
    bundled_plugin_dir = plugins_dir / "highway_3d"
    bundled_plugin_dir.mkdir()
    (bundled_plugin_dir / "plugin.json").write_text(
        json.dumps({"id": "highway_3d", "name": "3D Highway", "routes": "routes.py", "bundled": True})
    )
    (bundled_plugin_dir / "routes.py").write_text(
        "def setup(app, ctx):\n    raise RuntimeError('bundled broken')\n"
    )

    # User copy — sorts after bundled; working routes.
    user_plugin_dir = plugins_dir / "zzz-highway"
    user_plugin_dir.mkdir()
    (user_plugin_dir / "plugin.json").write_text(
        json.dumps({"id": "highway_3d", "name": "3D Highway (user)", "routes": "routes.py"})
    )
    (user_plugin_dir / "routes.py").write_text(
        "def setup(app, ctx):\n    app.state.origin = 'user_fallback'\n"
    )

    fake_app = type("FakeApp", (), {})()
    fake_app.state = type("State", (), {})()
    saved_dir = plugins.PLUGINS_DIR
    plugins.PLUGINS_DIR = plugins_dir
    try:
        with capture_logger(caplog, "feedBack.plugins", level=logging.WARNING):
            plugins.load_plugins(fake_app, {})
    finally:
        plugins.PLUGINS_DIR = saved_dir

    # The fallback user copy should be registered.
    hw3d_entries = [p for p in plugins.LOADED_PLUGINS if p["id"] == "highway_3d"]
    assert len(hw3d_entries) == 1
    assert hw3d_entries[0].get("bundled") is False
    assert str(hw3d_entries[0]["_dir"]) == str(user_plugin_dir)

    # The fallback's routes.setup() should have run.
    assert getattr(fake_app.state, "origin", None) == "user_fallback"

    # The fallback warning must be logged.
    assert "falling back to user-installed copy" in caplog.text
    assert str(user_plugin_dir) in caplog.text


def test_plugin_absent_when_both_routes_fail(
    tmp_path, reset_plugin_state, monkeypatch, caplog
):
    """When both bundled routes AND fallback routes fail, plugin is absent from LOADED_PLUGINS.

    Thread 5 regression: the old code always appended to _loaded_batch even when
    the fallback routes also failed, causing the plugin to appear in /api/plugins
    despite having no working routes — contradicting the 'plugin unavailable' log.
    """
    plugins = reset_plugin_state

    bundled_dir = tmp_path / "bundled"
    bundled_dir.mkdir()
    bundled_plugin_dir = bundled_dir / "highway_3d"
    bundled_plugin_dir.mkdir()
    (bundled_plugin_dir / "plugin.json").write_text(
        json.dumps({"id": "highway_3d", "name": "3D Highway", "routes": "routes.py", "bundled": True})
    )
    (bundled_plugin_dir / "routes.py").write_text(
        "def setup(app, ctx):\n    raise RuntimeError('bundled broken')\n"
    )

    user_dir = tmp_path / "user"
    user_dir.mkdir()
    user_plugin_dir = user_dir / "highway_3d"
    user_plugin_dir.mkdir()
    (user_plugin_dir / "plugin.json").write_text(
        json.dumps({"id": "highway_3d", "name": "3D Highway (user)", "routes": "routes.py"})
    )
    # User copy routes also raise.
    (user_plugin_dir / "routes.py").write_text(
        "def setup(app, ctx):\n    raise RuntimeError('user also broken')\n"
    )

    monkeypatch.setenv("FEEDBACK_PLUGINS_DIR", str(user_dir))

    fake_app = type("FakeApp", (), {})()
    saved_dir = plugins.PLUGINS_DIR
    plugins.PLUGINS_DIR = bundled_dir
    try:
        with capture_logger(caplog, "feedBack.plugins", level=logging.WARNING):
            plugins.load_plugins(fake_app, {})
    finally:
        plugins.PLUGINS_DIR = saved_dir

    # Plugin must be absent — neither bundled nor user copy registered.
    hw3d_entries = [p for p in plugins.LOADED_PLUGINS if p["id"] == "highway_3d"]
    assert len(hw3d_entries) == 0

    # Both failures must be logged.
    assert "falling back to user-installed copy" in caplog.text
    assert "also failed to load routes" in caplog.text


def test_partial_route_registration_warning(
    tmp_path, reset_plugin_state, monkeypatch, caplog
):
    """When bundled setup() registers routes before raising, a specific
    warning should name the count so maintainers can identify the partial
    registration in the server log (Thread 1, review-4226318201).
    """
    plugins = reset_plugin_state

    bundled_dir = tmp_path / "bundled"
    bundled_dir.mkdir()
    bundled_plugin_dir = bundled_dir / "highway_3d"
    bundled_plugin_dir.mkdir()
    (bundled_plugin_dir / "plugin.json").write_text(
        json.dumps({"id": "highway_3d", "name": "3D Highway", "routes": "routes.py", "bundled": True})
    )
    # Routes that register one endpoint before raising.
    (bundled_plugin_dir / "routes.py").write_text(
        "def setup(app, ctx):\n"
        "    app.routes.append('stub')\n"
        "    raise RuntimeError('partial fail')\n"
    )

    fake_app = type("FakeApp", (), {"routes": []})()
    saved_dir = plugins.PLUGINS_DIR
    plugins.PLUGINS_DIR = bundled_dir
    try:
        with capture_logger(caplog, "feedBack.plugins", level=logging.WARNING):
            plugins.load_plugins(fake_app, {})
    finally:
        plugins.PLUGINS_DIR = saved_dir

    assert "registered 1 route" in caplog.text
    assert "cannot be removed" in caplog.text


def test_sibling_module_cache_purged_before_fallback(
    tmp_path, reset_plugin_state, monkeypatch
):
    """Sibling modules from the failed bundled copy are purged from sys.modules
    before the fallback copy's routes are loaded, so the fallback gets a clean
    slate and doesn't accidentally resolve to bundled helper code
    (Thread 2, review-4226318201).
    """
    import sys
    plugins = reset_plugin_state

    bundled_dir = tmp_path / "bundled"
    bundled_dir.mkdir()
    bundled_plugin_dir = bundled_dir / "highway_3d"
    bundled_plugin_dir.mkdir()
    (bundled_plugin_dir / "plugin.json").write_text(
        json.dumps({"id": "highway_3d", "name": "3D Highway", "routes": "routes.py", "bundled": True})
    )
    # Bundled helper reports 'bundled'; bundled routes load it via load_sibling
    # then fail — this caches the bundled helper in sys.modules.
    (bundled_plugin_dir / "helper.py").write_text("ORIGIN = 'bundled'\n")
    (bundled_plugin_dir / "routes.py").write_text(
        "def setup(app, ctx):\n"
        "    ctx['load_sibling']('helper')  # caches bundled helper\n"
        "    raise RuntimeError('bundled broken')\n"
    )

    user_dir = tmp_path / "user"
    user_dir.mkdir()
    user_plugin_dir = user_dir / "highway_3d"
    user_plugin_dir.mkdir()
    (user_plugin_dir / "plugin.json").write_text(
        json.dumps({"id": "highway_3d", "name": "3D Highway (user)", "routes": "routes.py"})
    )
    # User copy has its own helper with a different ORIGIN; routes use load_sibling.
    (user_plugin_dir / "helper.py").write_text("ORIGIN = 'user'\n")
    (user_plugin_dir / "routes.py").write_text(
        "def setup(app, ctx):\n"
        "    helper = ctx['load_sibling']('helper')\n"
        "    app.state.helper_origin = helper.ORIGIN\n"
    )

    monkeypatch.setenv("FEEDBACK_PLUGINS_DIR", str(user_dir))

    fake_app = type("FakeApp", (), {})()
    fake_app.state = type("State", (), {})()
    saved_dir = plugins.PLUGINS_DIR
    plugins.PLUGINS_DIR = bundled_dir
    try:
        plugins.load_plugins(fake_app, {})
    finally:
        plugins.PLUGINS_DIR = saved_dir

    # The fallback routes ran and resolved the user copy's helper, not bundled's.
    hw3d_entries = [p for p in plugins.LOADED_PLUGINS if p["id"] == "highway_3d"]
    assert len(hw3d_entries) == 1
    assert getattr(fake_app.state, "helper_origin", None) == "user"


def test_fallback_success_clears_error_in_progress_events(
    tmp_path, reset_plugin_state, monkeypatch
):
    """When fallback succeeds, the progress event should carry explicit
    error=None (clear_error=True) so downstream startup-status handlers can
    clear the bundled-failure error text (Thread 3, review-4226318201).
    """
    plugins = reset_plugin_state

    bundled_dir = tmp_path / "bundled"
    bundled_dir.mkdir()
    bundled_plugin_dir = bundled_dir / "highway_3d"
    bundled_plugin_dir.mkdir()
    (bundled_plugin_dir / "plugin.json").write_text(
        json.dumps({"id": "highway_3d", "name": "3D Highway", "routes": "routes.py", "bundled": True})
    )
    (bundled_plugin_dir / "routes.py").write_text(
        "def setup(app, ctx):\n    raise RuntimeError('bundled broken')\n"
    )

    user_dir = tmp_path / "user"
    user_dir.mkdir()
    user_plugin_dir = user_dir / "highway_3d"
    user_plugin_dir.mkdir()
    (user_plugin_dir / "plugin.json").write_text(
        json.dumps({"id": "highway_3d", "name": "3D Highway (user)", "routes": "routes.py"})
    )
    (user_plugin_dir / "routes.py").write_text(
        "def setup(app, ctx):\n    pass\n"
    )

    monkeypatch.setenv("FEEDBACK_PLUGINS_DIR", str(user_dir))

    events = []
    fake_app = type("FakeApp", (), {})()
    saved_dir = plugins.PLUGINS_DIR
    plugins.PLUGINS_DIR = bundled_dir
    try:
        plugins.load_plugins(fake_app, {}, progress_cb=events.append)
    finally:
        plugins.PLUGINS_DIR = saved_dir

    # After fallback success, a "plugin-registered" event with explicit
    # "error": None should clear the bundled-failure error in the handler.
    registered_clear_events = [
        e for e in events
        if e.get("phase") == "plugin-registered"
        and e.get("plugin_id") == "highway_3d"
        and "error" in e
        and e["error"] is None
    ]
    assert registered_clear_events, (
        "Expected a plugin-registered event with explicit error=None after fallback success"
    )


def test_plugins_complete_loaded_count_when_both_routes_fail(
    tmp_path, reset_plugin_state, monkeypatch
):
    """When both bundled and fallback routes fail, plugins-complete must
    report loaded = actual registered count, not len(plugin_load_specs)
    (Thread 4, review-4226318201).
    """
    plugins = reset_plugin_state

    bundled_dir = tmp_path / "bundled"
    bundled_dir.mkdir()
    # One healthy plugin + one that will fail completely.
    healthy_plugin_dir = bundled_dir / "healthy"
    healthy_plugin_dir.mkdir()
    (healthy_plugin_dir / "plugin.json").write_text(
        json.dumps({"id": "healthy", "name": "Healthy Plugin", "bundled": True})
    )
    bundled_plugin_dir = bundled_dir / "highway_3d"
    bundled_plugin_dir.mkdir()
    (bundled_plugin_dir / "plugin.json").write_text(
        json.dumps({"id": "highway_3d", "name": "3D Highway", "routes": "routes.py", "bundled": True})
    )
    (bundled_plugin_dir / "routes.py").write_text(
        "def setup(app, ctx):\n    raise RuntimeError('bundled broken')\n"
    )

    user_dir = tmp_path / "user"
    user_dir.mkdir()
    user_plugin_dir = user_dir / "highway_3d"
    user_plugin_dir.mkdir()
    (user_plugin_dir / "plugin.json").write_text(
        json.dumps({"id": "highway_3d", "name": "3D Highway (user)", "routes": "routes.py"})
    )
    (user_plugin_dir / "routes.py").write_text(
        "def setup(app, ctx):\n    raise RuntimeError('user also broken')\n"
    )

    monkeypatch.setenv("FEEDBACK_PLUGINS_DIR", str(user_dir))

    events = []
    fake_app = type("FakeApp", (), {})()
    saved_dir = plugins.PLUGINS_DIR
    plugins.PLUGINS_DIR = bundled_dir
    try:
        plugins.load_plugins(fake_app, {}, progress_cb=events.append)
    finally:
        plugins.PLUGINS_DIR = saved_dir

    complete = next(e for e in events if e["phase"] == "plugins-complete")
    # "healthy" loaded OK, "highway_3d" failed completely → actual loaded == 1
    assert complete["loaded"] == 1, (
        f"plugins-complete loaded should be 1 (only healthy), got {complete['loaded']}"
    )
    # total still reflects how many specs were discovered
    assert complete["total"] == 2


def test_fallback_preserves_plugin_order(
    tmp_path, reset_plugin_state, monkeypatch
):
    """When a bundled copy evicts a user-installed copy and then fails to load
    its routes, the fallback (user copy) must occupy the SAME slot the user
    copy had at discovery time — not the position the bundled copy would have
    been appended at (Thread 1, review-4227852922; Thread 3, review-4227201020).

    Layout:
      user dir: highway_3d (working fallback, has routes)
      bundled:  alpha (healthy), highway_3d (broken routes), omega (healthy)

    Scan order: user dir first, then bundled.  user/highway_3d lands at slot 0.
    When bundled/highway_3d is scanned it replaces the user copy IN-PLACE at
    slot 0 (review-4227852922 fix).  After route failure the fallback is
    inserted back at slot 0.

    Expected order after fallback: [highway_3d (fallback), alpha, omega]
    """
    plugins = reset_plugin_state

    bundled_dir = tmp_path / "bundled"
    bundled_dir.mkdir()

    for name, content in [
        ("alpha", {"id": "alpha", "name": "Alpha", "bundled": True}),
        ("highway_3d", {"id": "highway_3d", "name": "3D Highway", "routes": "routes.py", "bundled": True}),
        ("omega", {"id": "omega", "name": "Omega", "bundled": True}),
    ]:
        d = bundled_dir / name
        d.mkdir()
        (d / "plugin.json").write_text(json.dumps(content))
        if name == "highway_3d":
            (d / "routes.py").write_text("def setup(app, ctx):\n    raise RuntimeError('broken')\n")

    user_dir = tmp_path / "user"
    user_dir.mkdir()
    user_hw = user_dir / "highway_3d"
    user_hw.mkdir()
    # User copy must have a routes file; without one fallback_routes_ok is
    # False and the entry is never added to LOADED_PLUGINS (review-4227852922).
    (user_hw / "plugin.json").write_text(
        json.dumps({"id": "highway_3d", "name": "3D Highway (user)", "routes": "routes.py"})
    )
    (user_hw / "routes.py").write_text("def setup(app, ctx): pass\n")

    monkeypatch.setenv("FEEDBACK_PLUGINS_DIR", str(user_dir))

    fake_app = type("FakeApp", (), {})()
    saved_dir = plugins.PLUGINS_DIR
    plugins.PLUGINS_DIR = bundled_dir
    try:
        plugins.load_plugins(fake_app, {})
    finally:
        plugins.PLUGINS_DIR = saved_dir

    ids = [p["id"] for p in plugins.LOADED_PLUGINS]
    assert ids == ["highway_3d", "alpha", "omega"], (
        f"Fallback entry must occupy the user copy's original discovery slot, got order: {ids}"
    )
    # The entry at position 0 (user copy's original slot) is the fallback.
    assert plugins.LOADED_PLUGINS[0].get("fallback") is True


def test_fallback_not_registered_when_user_copy_has_no_routes(
    tmp_path, reset_plugin_state, monkeypatch
):
    """If the evicted user copy has no routes entry it cannot restore the
    bundled plugin's backend endpoints.  The fallback must be treated as
    unsuccessful (fallback_routes_ok=False) so the plugin is absent from
    LOADED_PLUGINS and the bundled-failure error stays in startup-status.
    (Thread 2, review-4227852922)
    """
    plugins = reset_plugin_state

    bundled_dir = tmp_path / "bundled"
    bundled_dir.mkdir()
    bd = bundled_dir / "highway_3d"
    bd.mkdir()
    (bd / "plugin.json").write_text(
        json.dumps({"id": "highway_3d", "name": "3D Highway", "routes": "routes.py", "bundled": True})
    )
    (bd / "routes.py").write_text("def setup(app, ctx):\n    raise RuntimeError('broken')\n")

    user_dir = tmp_path / "user"
    user_dir.mkdir()
    user_hw = user_dir / "highway_3d"
    user_hw.mkdir()
    # No routes in user copy — cannot restore bundled endpoints.
    (user_hw / "plugin.json").write_text(
        json.dumps({"id": "highway_3d", "name": "3D Highway (user)"})
    )

    monkeypatch.setenv("FEEDBACK_PLUGINS_DIR", str(user_dir))

    fake_app = type("FakeApp", (), {})()
    saved_dir = plugins.PLUGINS_DIR
    plugins.PLUGINS_DIR = bundled_dir
    try:
        plugins.load_plugins(fake_app, {})
    finally:
        plugins.PLUGINS_DIR = saved_dir

    ids = [p["id"] for p in plugins.LOADED_PLUGINS]
    assert "highway_3d" not in ids, (
        "Plugin with no-routes user copy must NOT appear in LOADED_PLUGINS"
    )


def test_fallback_skipped_when_setup_was_mid_flight_on_timeout(
    tmp_path, reset_plugin_state, monkeypatch, caplog
):
    """When bundled setup() times out mid-flight (already executing), the loader
    must NOT activate the user-copy fallback — the original setup() may still be
    mutating the router concurrently (Thread 4, review-4227201020).

    Simulated by injecting an exception with ``setup_mid_flight=True`` (the
    attribute _route_setup_on_main attaches when it detects _started is set at
    timeout).
    """
    plugins = reset_plugin_state

    bundled_dir = tmp_path / "bundled"
    bundled_dir.mkdir()
    bundled_plugin_dir = bundled_dir / "highway_3d"
    bundled_plugin_dir.mkdir()
    (bundled_plugin_dir / "plugin.json").write_text(
        json.dumps({"id": "highway_3d", "name": "3D Highway", "routes": "routes.py", "bundled": True})
    )
    (bundled_plugin_dir / "routes.py").write_text("def setup(app, ctx): pass\n")

    user_dir = tmp_path / "user"
    user_dir.mkdir()
    user_plugin_dir = user_dir / "highway_3d"
    user_plugin_dir.mkdir()
    (user_plugin_dir / "plugin.json").write_text(
        json.dumps({"id": "highway_3d", "name": "3D Highway (user)", "routes": "routes.py"})
    )
    (user_plugin_dir / "routes.py").write_text(
        "def setup(app, ctx):\n    app.state.fallback_ran = True\n"
    )

    monkeypatch.setenv("FEEDBACK_PLUGINS_DIR", str(user_dir))

    # Inject a route_setup_fn that simulates a mid-flight timeout by raising
    # a TimeoutError with setup_mid_flight=True.
    def _mid_flight_timeout_setup_fn(fn):
        e = concurrent.futures.TimeoutError()
        e.setup_mid_flight = True
        raise e

    fake_app = type("FakeApp", (), {})()
    fake_app.state = type("State", (), {})()
    saved_dir = plugins.PLUGINS_DIR
    plugins.PLUGINS_DIR = bundled_dir
    try:
        with capture_logger(caplog, "feedBack.plugins", level=logging.WARNING):
            plugins.load_plugins(fake_app, {}, route_setup_fn=_mid_flight_timeout_setup_fn)
    finally:
        plugins.PLUGINS_DIR = saved_dir

    # Fallback must NOT have run — original setup() was mid-flight.
    assert not getattr(fake_app.state, "fallback_ran", False), (
        "Fallback setup() must not run when bundled setup() was mid-flight at timeout"
    )
    # Plugin must be absent from LOADED_PLUGINS (both copies failed).
    hw3d_entries = [p for p in plugins.LOADED_PLUGINS if p["id"] == "highway_3d"]
    assert len(hw3d_entries) == 0, (
        "Plugin must be absent when bundled timed out mid-flight and fallback was skipped"
    )
    # Warning about skipping fallback must appear in log.
    assert "Skipping fallback" in caplog.text or "mid-flight" in caplog.text



def test_fallback_entry_has_fallback_true_field(
    tmp_path, reset_plugin_state, monkeypatch
):
    """When a user-copy fallback is activated because bundled routes fail,
    the registered LOADED_PLUGINS entry must include ``"fallback": True``.
    The /api/plugins endpoint exposes this field so the settings UI can
    show a warning badge (Thread 4, review-4226937699).
    """
    plugins = reset_plugin_state

    bundled_dir = tmp_path / "bundled"
    bundled_dir.mkdir()
    bundled_plugin_dir = bundled_dir / "highway_3d"
    bundled_plugin_dir.mkdir()
    (bundled_plugin_dir / "plugin.json").write_text(
        json.dumps({"id": "highway_3d", "name": "3D Highway", "routes": "routes.py", "bundled": True})
    )
    (bundled_plugin_dir / "routes.py").write_text(
        "def setup(app, ctx):\n    raise RuntimeError('bundled broken')\n"
    )

    user_dir = tmp_path / "user"
    user_dir.mkdir()
    user_plugin_dir = user_dir / "highway_3d"
    user_plugin_dir.mkdir()
    (user_plugin_dir / "plugin.json").write_text(
        json.dumps({"id": "highway_3d", "name": "3D Highway (user)", "routes": "routes.py"})
    )
    (user_plugin_dir / "routes.py").write_text("def setup(app, ctx):\n    pass\n")

    monkeypatch.setenv("FEEDBACK_PLUGINS_DIR", str(user_dir))

    fake_app = type("FakeApp", (), {})()
    saved_dir = plugins.PLUGINS_DIR
    plugins.PLUGINS_DIR = bundled_dir
    try:
        plugins.load_plugins(fake_app, {})
    finally:
        plugins.PLUGINS_DIR = saved_dir

    entries = [p for p in plugins.LOADED_PLUGINS if p["id"] == "highway_3d"]
    assert len(entries) == 1
    entry = entries[0]
    assert entry.get("fallback") is True, (
        "Fallback user copy entry must have fallback=True, got "
        f"{entry.get('fallback')!r}"
    )
    assert entry.get("bundled") is False, (
        "Fallback user copy must not be marked bundled"
    )


def test_fallback_proceeds_when_install_requirements_returns_false(
    tmp_path, reset_plugin_state, monkeypatch
):
    """_install_requirements returning False in the fallback path must be
    non-fatal — the fallback must still load routes, matching the main loop
    behaviour which only emits a plugin-error but does not abort.

    Previously the fallback block did ``if not _install_requirements(...): continue``
    which skipped the user copy entirely, leaving the bundled-failure error in
    startup-status even when the user copy could have run without those deps.
    (Thread 1, review-4227643820)

    A plugin-error must also be emitted when requirements fail, mirroring the
    main loop — without it the later clear_error=True makes startup look healthy
    even though the running plugin may be missing dependencies.
    (Thread 2, review-4228077246)
    """
    plugins = reset_plugin_state

    bundled_dir = tmp_path / "bundled"
    bundled_dir.mkdir()
    bundled_plugin_dir = bundled_dir / "highway_3d"
    bundled_plugin_dir.mkdir()
    (bundled_plugin_dir / "plugin.json").write_text(
        json.dumps({"id": "highway_3d", "name": "3D Highway", "routes": "routes.py", "bundled": True})
    )
    (bundled_plugin_dir / "routes.py").write_text(
        "def setup(app, ctx):\n    raise RuntimeError('bundled broken')\n"
    )

    user_dir = tmp_path / "user"
    user_dir.mkdir()
    user_plugin_dir = user_dir / "highway_3d"
    user_plugin_dir.mkdir()
    (user_plugin_dir / "plugin.json").write_text(
        json.dumps({"id": "highway_3d", "name": "3D Highway (user)", "routes": "routes.py"})
    )
    (user_plugin_dir / "routes.py").write_text(
        "def setup(app, ctx):\n    app.state.fallback_ran = True\n"
    )

    monkeypatch.setenv("FEEDBACK_PLUGINS_DIR", str(user_dir))
    # Simulate _install_requirements failing (read-only filesystem, optional
    # dep, etc.) — same scenario the main loop tolerates.
    monkeypatch.setattr(plugins, "_install_requirements", lambda *a, **kw: False)

    fake_app = type("FakeApp", (), {})()
    fake_app.state = type("State", (), {})()
    events: list = []
    saved_dir = plugins.PLUGINS_DIR
    plugins.PLUGINS_DIR = bundled_dir
    try:
        plugins.load_plugins(fake_app, {}, progress_cb=events.append)
    finally:
        plugins.PLUGINS_DIR = saved_dir

    # Despite requirements failure the fallback routes.setup() must have run.
    assert getattr(fake_app.state, "fallback_ran", False) is True, (
        "Fallback routes.setup() must run even when _install_requirements returns False"
    )
    entries = [p for p in plugins.LOADED_PLUGINS if p["id"] == "highway_3d"]
    assert entries, "highway_3d must be registered as a fallback"
    assert entries[0].get("fallback") is True

    # A plugin-error must have been emitted for the fallback requirements failure.
    req_errors = [
        e for e in events
        if e.get("phase") == "plugin-error"
        and e.get("plugin_id") == "highway_3d"
        and e.get("error")
    ]
    assert req_errors, (
        "Expected at least one plugin-error event for highway_3d fallback requirements failure; "
        f"events were: {events}"
    )

    # The req-failure event must include loaded/total so startup-status
    # progress counters are not zeroed out.
    # (Thread 2, review-4228421486)
    for e in req_errors:
        assert "loaded" in e and "total" in e, (
            f"plugin-error event for req failure must include loaded/total; got: {e}"
        )

    # After successful route registration the plugin-registered event must
    # NOT carry error=None when req install failed; that would wipe the req
    # error from startup-status, making startup look clean despite degraded
    # dependencies. (Thread 1, review-4228421486)
    registered_clear_events = [
        e for e in events
        if e.get("phase") == "plugin-registered"
        and e.get("plugin_id") == "highway_3d"
        and "error" in e
        and e["error"] is None
    ]
    assert not registered_clear_events, (
        "plugin-registered must NOT carry error=None when req install failed "
        "(that would silently wipe the req-failure error from startup-status); "
        f"events were: {events}"
    )


def test_fallback_routes_failure_emits_plugin_error(
    tmp_path, reset_plugin_state, monkeypatch
):
    """When the fallback user-copy's routes also fail, a plugin-error event
    must be emitted so startup-status reflects the fallback's failure as the
    root cause.

    Without this, startup-status is left pointing at the earlier bundled-copy
    error even though that is no longer the active failure, making it harder
    for operators to identify the correct root cause.
    (Thread 1, review-4228077246)
    """
    plugins = reset_plugin_state

    bundled_dir = tmp_path / "bundled"
    bundled_dir.mkdir()
    bundled_plugin_dir = bundled_dir / "highway_3d"
    bundled_plugin_dir.mkdir()
    (bundled_plugin_dir / "plugin.json").write_text(
        json.dumps({"id": "highway_3d", "name": "3D Highway", "routes": "routes.py", "bundled": True})
    )
    (bundled_plugin_dir / "routes.py").write_text(
        "def setup(app, ctx):\n    raise RuntimeError('bundled broken')\n"
    )

    user_dir = tmp_path / "user"
    user_dir.mkdir()
    user_plugin_dir = user_dir / "highway_3d"
    user_plugin_dir.mkdir()
    (user_plugin_dir / "plugin.json").write_text(
        json.dumps({"id": "highway_3d", "name": "3D Highway (user)", "routes": "routes.py"})
    )
    (user_plugin_dir / "routes.py").write_text(
        "def setup(app, ctx):\n    raise RuntimeError('fallback also broken')\n"
    )

    monkeypatch.setenv("FEEDBACK_PLUGINS_DIR", str(user_dir))

    fake_app = type("FakeApp", (), {})()
    events: list = []
    saved_dir = plugins.PLUGINS_DIR
    plugins.PLUGINS_DIR = bundled_dir
    try:
        plugins.load_plugins(fake_app, {}, progress_cb=events.append)
    finally:
        plugins.PLUGINS_DIR = saved_dir

    # The plugin must NOT be registered.
    entries = [p for p in plugins.LOADED_PLUGINS if p["id"] == "highway_3d"]
    assert not entries, "highway_3d must not be registered when both copies fail"

    # A plugin-error event must have been emitted for the fallback failure.
    fallback_errors = [
        e for e in events
        if e.get("phase") == "plugin-error"
        and e.get("plugin_id") == "highway_3d"
        and e.get("error")
    ]
    assert fallback_errors, (
        "Expected at least one plugin-error event when fallback routes also fail; "
        f"events were: {events}"
    )
    # The error message must mention 'Both' or 'fallback' to distinguish it
    # from the original bundled-failure error.
    assert any(
        "fallback" in e["error"].lower() or "both" in e["error"].lower()
        for e in fallback_errors
    ), f"plugin-error text should reference the fallback failure; got: {[e['error'] for e in fallback_errors]}"

    # The fallback route-error event must include loaded/total so the
    # startup-status progress counters are not zeroed mid-run.
    # (Thread 3, review-4228421486)
    for e in fallback_errors:
        assert "loaded" in e and "total" in e, (
            f"plugin-error event for fallback route failure must include loaded/total; got: {e}"
        )


def test_normal_plugins_do_not_have_fallback_field_set(
    tmp_path, reset_plugin_state, monkeypatch
):
    """Normal (non-fallback) plugins — both bundled and user-installed —
    must not have ``fallback: True`` set.  Only emergency user-copy
    fallbacks that replaced a broken bundled plugin carry the flag.
    """
    plugins = reset_plugin_state

    bundled_dir = tmp_path / "bundled"
    bundled_dir.mkdir()
    bundled_plugin_dir = bundled_dir / "my_plugin"
    bundled_plugin_dir.mkdir()
    (bundled_plugin_dir / "plugin.json").write_text(
        json.dumps({"id": "my_plugin", "name": "My Plugin", "bundled": True})
    )

    fake_app = type("FakeApp", (), {})()
    saved_dir = plugins.PLUGINS_DIR
    plugins.PLUGINS_DIR = bundled_dir
    try:
        plugins.load_plugins(fake_app, {})
    finally:
        plugins.PLUGINS_DIR = saved_dir

    entries = [p for p in plugins.LOADED_PLUGINS if p["id"] == "my_plugin"]
    assert len(entries) == 1
    assert not entries[0].get("fallback"), (
        "Normal bundled plugin must not have fallback=True"
    )


def test_sibling_purge_does_not_affect_other_plugin_with_same_prefix(
    tmp_path, reset_plugin_state, monkeypatch
):
    """The sibling module purge in the fallback block must only remove the
    exact routes module key for the evicted plugin and its namespaced
    load_sibling modules.  It must NOT delete modules for other plugins
    whose namespaced IDs share the same prefix.

    Previously, ``k.startswith(f"{_parent_pkg}_")`` would match
    ``plugin_a_routes`` when purging plugin ``a``, and would also
    incorrectly match ``plugin_a_5f_b_routes`` (routes for plugin ``a_b``).
    The fix replaces the startswith check with an exact key match.

    (Thread 1, review-4226937699)
    """
    plugins = reset_plugin_state
    import sys

    # plugin "a" — bundled, fails routes.
    # plugin "a_b" — also bundled, healthy.
    # user copy of "a" — provides the fallback.
    bundled_dir = tmp_path / "bundled"
    bundled_dir.mkdir()

    ba_dir = bundled_dir / "a"
    ba_dir.mkdir()
    (ba_dir / "plugin.json").write_text(
        json.dumps({"id": "a", "name": "Plugin A", "routes": "routes.py", "bundled": True})
    )
    (ba_dir / "routes.py").write_text(
        "def setup(app, ctx):\n    raise RuntimeError('a broken')\n"
    )

    ab_dir = bundled_dir / "a_b"
    ab_dir.mkdir()
    # `a_b` routes capture a ref so we can assert they ran from the right module.
    (ab_dir / "plugin.json").write_text(
        json.dumps({"id": "a_b", "name": "Plugin A_B", "routes": "routes.py", "bundled": True})
    )
    (ab_dir / "routes.py").write_text(
        "def setup(app, ctx):\n    app.state.ab_setup_ran = True\n"
    )

    user_dir = tmp_path / "user"
    user_dir.mkdir()
    ua_dir = user_dir / "a"
    ua_dir.mkdir()
    (ua_dir / "plugin.json").write_text(
        json.dumps({"id": "a", "name": "Plugin A (user)", "routes": "routes.py"})
    )
    (ua_dir / "routes.py").write_text(
        "def setup(app, ctx):\n    app.state.a_fallback_ran = True\n"
    )

    monkeypatch.setenv("FEEDBACK_PLUGINS_DIR", str(user_dir))

    fake_app = type("FakeApp", (), {})()
    fake_app.state = type("State", (), {})()
    saved_dir = plugins.PLUGINS_DIR
    plugins.PLUGINS_DIR = bundled_dir
    try:
        plugins.load_plugins(fake_app, {})
    finally:
        plugins.PLUGINS_DIR = saved_dir

    # plugin "a_b" routes should have run without being clobbered by
    # the prefix-based purge.
    assert getattr(fake_app.state, "ab_setup_ran", False) is True, (
        "plugin 'a_b' setup() was not called — its module was incorrectly "
        "purged during the 'a' fallback sibling purge"
    )
    # plugin "a" fallback also ran.
    assert getattr(fake_app.state, "a_fallback_ran", False) is True, (
        "plugin 'a' fallback setup() did not run"
    )


def test_bundled_flag_requires_both_in_tree_directory_and_manifest_field(
    tmp_path, reset_plugin_state, monkeypatch
):
    """``bundled`` requires ALL THREE: in-tree PLUGINS_DIR location, the
    manifest's ``"bundled": true`` field, AND the directory name matching the
    plugin id.

    - In-tree plugin, dir name == id, ``"bundled": true`` → ``bundled: true``.
    - In-tree plugin, dir name == id, no ``"bundled"`` field → ``bundled: false``
      (user-installed plugin cloned into plugins/).
    - In-tree plugin, dir name ≠ id, ``"bundled": true`` → ``bundled: false``
      (verbatim user copy under a different folder name).
    - User-dir plugin, ``"bundled": true`` → ``bundled: false``
      (not in-tree; manifest field alone is not sufficient).

    This ensures a user-installed plugin cannot forge core status by adding
    ``"bundled": true`` to its own plugin.json, while correctly identifying
    legitimate in-tree bundled plugins.
    """
    plugins = reset_plugin_state

    bundled_dir = tmp_path / "bundled"
    bundled_dir.mkdir()
    # In-tree plugin WITH "bundled": true AND dir name == id — the real bundled core plugin.
    (bundled_dir / "real_core").mkdir()
    (bundled_dir / "real_core" / "plugin.json").write_text(
        json.dumps({"id": "real_core", "name": "Real Core Plugin", "bundled": True})
    )
    # In-tree plugin WITHOUT "bundled" field — a user plugin cloned into plugins/.
    (bundled_dir / "user_in_tree").mkdir()
    (bundled_dir / "user_in_tree" / "plugin.json").write_text(
        json.dumps({"id": "user_in_tree", "name": "User Plugin (in plugins/)"})
    )
    # In-tree plugin WITH "bundled": true but dir name ≠ id — verbatim user copy
    # of a bundled plugin placed under a different folder name.
    (bundled_dir / "other_name").mkdir()
    (bundled_dir / "other_name" / "plugin.json").write_text(
        json.dumps({"id": "real_core_copy", "name": "Verbatim Copy", "bundled": True})
    )

    user_dir = tmp_path / "user"
    user_dir.mkdir()
    # User plugin in FEEDBACK_PLUGINS_DIR that forges "bundled": true.
    (user_dir / "fake_bundled").mkdir()
    (user_dir / "fake_bundled" / "plugin.json").write_text(
        json.dumps({"id": "fake_bundled", "name": "Fake Bundled", "bundled": True})
    )

    monkeypatch.setenv("FEEDBACK_PLUGINS_DIR", str(user_dir))

    fake_app = type("FakeApp", (), {})()
    saved_dir = plugins.PLUGINS_DIR
    plugins.PLUGINS_DIR = bundled_dir
    try:
        plugins.load_plugins(fake_app, {})
    finally:
        plugins.PLUGINS_DIR = saved_dir

    by_id = {p["id"]: p for p in plugins.LOADED_PLUGINS}

    # In-tree plugin with "bundled": true AND dir name == id → bundled=True.
    assert by_id["real_core"]["bundled"] is True

    # In-tree plugin without "bundled" field → bundled=False (user clone in plugins/).
    assert by_id["user_in_tree"]["bundled"] is False

    # In-tree plugin with "bundled": true but dir name ≠ id → bundled=False.
    # (verbatim copy under a different folder; dir name "other_name" ≠ id "real_core_copy")
    assert by_id["real_core_copy"]["bundled"] is False

    # Plugin from user dir with "bundled": true → bundled=False (manifest field alone insufficient).
    assert by_id["fake_bundled"]["bundled"] is False



def test_bundled_returned_by_api(tmp_path, reset_plugin_state):
    """GET /api/plugins must include a ``bundled`` boolean field for each plugin.

    - A plugin loaded from a manifest with ``"bundled": true`` (in-tree, dir name
      matches id) must surface ``bundled: true``.
    - A plain user plugin must surface ``bundled: false``.
    """
    plugins_mod = reset_plugin_state

    plugin_dir = tmp_path / "dummy"
    plugin_dir.mkdir()

    # Bundled plugin entry.
    plugins_mod.LOADED_PLUGINS.append({
        "id": "core_viz",
        "name": "Core Viz",
        "nav": None,
        "type": None,
        "bundled": True,
        "has_screen": False,
        "has_script": False,
        "has_settings": False,
        "has_tour": False,
        "_dir": plugin_dir,
        "_manifest": {},
    })

    # Plain user plugin.
    plugins_mod.LOADED_PLUGINS.append({
        "id": "my_plugin",
        "name": "My Plugin",
        "nav": None,
        "type": None,
        "bundled": False,
        "has_screen": False,
        "has_script": False,
        "has_settings": False,
        "has_tour": False,
        "_dir": plugin_dir,
        "_manifest": {},
    })

    client = _make_api_client(plugins_mod)
    try:
        r = client.get("/api/plugins")
        assert r.status_code == 200
        ids = {p["id"]: p for p in r.json()}

        assert ids["core_viz"]["bundled"] is True
        assert "overrides_bundled" not in ids["core_viz"]

        assert ids["my_plugin"]["bundled"] is False
        assert "overrides_bundled" not in ids["my_plugin"]
    finally:
        client.close()

def test_fallback_field_is_surfaced_in_api_response(tmp_path, reset_plugin_state):
    """GET /api/plugins must include a ``fallback`` boolean field for each plugin.

    - A fallback user-copy entry (bundled routes failed) must surface ``fallback: true``.
    - A normal plugin must surface ``fallback: false``.

    This ensures the frontend badge rendering is reliable — the badge depends
    on this field being present in the JSON response from the endpoint, not
    just in the internal LOADED_PLUGINS list (Thread 6, review-4227201020).
    """
    plugins_mod = reset_plugin_state

    plugin_dir = tmp_path / "dummy"
    plugin_dir.mkdir()

    # Fallback user-copy entry (bundled routes failed, user copy active).
    plugins_mod.LOADED_PLUGINS.append({
        "id": "highway_3d",
        "name": "3D Highway (user fallback)",
        "nav": None,
        "type": None,
        "bundled": False,
        "fallback": True,
        "has_screen": False,
        "has_script": False,
        "has_settings": False,
        "has_tour": False,
        "_dir": plugin_dir,
        "_manifest": {},
    })

    # Normal user plugin — must NOT have fallback=true.
    plugins_mod.LOADED_PLUGINS.append({
        "id": "normal_plugin",
        "name": "Normal Plugin",
        "nav": None,
        "type": None,
        "bundled": False,
        "has_screen": False,
        "has_script": False,
        "has_settings": False,
        "has_tour": False,
        "_dir": plugin_dir,
        "_manifest": {},
    })

    client = _make_api_client(plugins_mod)
    try:
        r = client.get("/api/plugins")
        assert r.status_code == 200
        ids = {p["id"]: p for p in r.json()}

        # Fallback entry must have fallback=true in the response.
        assert "fallback" in ids["highway_3d"], (
            "/api/plugins response must include the 'fallback' key"
        )
        assert ids["highway_3d"]["fallback"] is True

        # Normal plugin must have fallback=false in the response.
        assert "fallback" in ids["normal_plugin"], (
            "/api/plugins response must include the 'fallback' key for all plugins"
        )
        assert ids["normal_plugin"]["fallback"] is False
    finally:
        client.close()


def test_api_plugins_exposes_capability_validation_and_shim_metadata(reset_plugin_state):
    plugins_mod = reset_plugin_state
    fixture_dir = Path(__file__).resolve().parents[1] / "tests" / "fixtures" / "plugin_capabilities"
    valid = json.loads((fixture_dir / "valid_owner_provider.json").read_text(encoding="utf-8"))
    invalid = json.loads((fixture_dir / "invalid_capability_metadata.json").read_text(encoding="utf-8"))
    unsupported = json.loads((fixture_dir / "unsupported_capability_version.json").read_text(encoding="utf-8"))

    valid_caps, _, _ = plugins_mod._capability_warnings(valid, "stems")
    invalid_caps, invalid_warnings, _ = plugins_mod._capability_warnings(invalid, "broken_capability_metadata")
    unsupported_caps, _, unsupported_versions = plugins_mod._capability_warnings(unsupported, "future_capabilities")
    plugins_mod.LOADED_PLUGINS.extend([
        {
            "id": "stems", "name": "Stems", "nav": None, "type": None,
            "bundled": False, "has_screen": False, "has_script": False,
            "has_settings": False, "has_tour": False, "standards": valid["standards"],
            "capabilities": valid_caps, "settings_schema": {},
            "ui_contributions": plugins_mod._normalize_ui_contributions(valid),
            "runtime_domains": plugins_mod._normalize_runtime_domains(valid),
            "compatibility_shims": plugins_mod._compatibility_shims_from_manifest(valid, "stems"),
            "capability_validation_warnings": [], "capability_unsupported_versions": [],
            "_manifest": valid,
        },
        {
            "id": "broken_capability_metadata", "name": "Broken Capability Metadata",
            "nav": invalid["nav"], "type": None, "bundled": False,
            "has_screen": True, "has_script": False, "has_settings": True,
            "has_tour": False, "standards": invalid["standards"],
            "capabilities": invalid_caps, "settings_schema": {},
            "ui_contributions": plugins_mod._normalize_ui_contributions(invalid),
            "runtime_domains": plugins_mod._normalize_runtime_domains(invalid),
            "compatibility_shims": plugins_mod._compatibility_shims_from_manifest(invalid, "broken_capability_metadata"),
            "capability_validation_warnings": invalid_warnings,
            "capability_unsupported_versions": [], "_manifest": invalid,
        },
        {
            "id": "future_capabilities", "name": "Future Capabilities",
            "nav": None, "type": None, "bundled": False, "has_screen": False,
            "has_script": False, "has_settings": False, "has_tour": False,
            "standards": unsupported["standards"], "capabilities": unsupported_caps,
            "settings_schema": {}, "ui_contributions": plugins_mod._normalize_ui_contributions(unsupported),
            "runtime_domains": plugins_mod._normalize_runtime_domains(unsupported),
            "compatibility_shims": plugins_mod._compatibility_shims_from_manifest(unsupported, "future_capabilities"),
            "capability_validation_warnings": [],
            "capability_unsupported_versions": unsupported_versions,
            "_manifest": unsupported,
        },
    ])

    client = _make_api_client(plugins_mod)
    try:
        listing = {entry["id"]: entry for entry in client.get("/api/plugins").json()}
    finally:
        client.close()

    assert listing["stems"]["capabilities"]["stems"]["roles"] == ["owner", "provider"]
    assert listing["broken_capability_metadata"]["capabilities"] == {}
    assert listing["broken_capability_metadata"]["capability_validation_warnings"]
    assert listing["broken_capability_metadata"]["ui_contributions"]["legacy"]
    assert listing["broken_capability_metadata"]["compatibility_shims"] == []
    assert listing["future_capabilities"]["capability_unsupported_versions"]
    assert listing["future_capabilities"]["capabilities"]["stems"]["incompatible"] is True



def _run_load_plugins_with_cb(plugins, app, tmp_path, progress_cb, context=None):
    """Like _run_load_plugins but passes a progress_cb spy."""
    saved_dir = plugins.PLUGINS_DIR
    plugins.PLUGINS_DIR = tmp_path
    try:
        plugins.load_plugins(app, context if context is not None else {}, progress_cb=progress_cb)
    finally:
        plugins.PLUGINS_DIR = saved_dir


def test_progress_cb_receives_phases_and_counts(tmp_path, reset_plugin_state):
    """progress_cb spy should receive structured events including
    plugins-discovered, plugins-complete, loaded/total counters, and
    the complete event should have loaded == total == number of plugins."""
    plugins = reset_plugin_state
    _make_plugin(tmp_path, "alpha")
    _make_plugin(tmp_path, "beta")

    events = []
    _run_load_plugins_with_cb(plugins, type("FakeApp", (), {})(), tmp_path, events.append)

    phases = [e["phase"] for e in events]
    assert "plugins-discovered" in phases
    assert "plugins-complete" in phases
    # All events carry int counters.
    for e in events:
        assert isinstance(e["loaded"], int), f"loaded not int in {e}"
        assert isinstance(e["total"], int), f"total not int in {e}"
    # The complete event has loaded == total == 2.
    complete = next(e for e in events if e["phase"] == "plugins-complete")
    assert complete["loaded"] == 2
    assert complete["total"] == 2


def test_progress_cb_errors_do_not_break_plugin_startup(tmp_path, reset_plugin_state):
    """A progress_cb that raises must not abort plugin loading — the
    _emit_progress guard must swallow the exception."""
    plugins = reset_plugin_state
    _make_plugin(tmp_path, "safe")

    def bad_cb(event):
        raise RuntimeError("spy exploded")

    _run_load_plugins_with_cb(plugins, type("FakeApp", (), {})(), tmp_path, bad_cb)

    # Plugin still registered despite cb explosion.
    assert any(p["id"] == "safe" for p in plugins.LOADED_PLUGINS)


def test_progress_cb_emits_plugin_error_on_requirements_failure(tmp_path, reset_plugin_state, monkeypatch):
    """When _install_requirements returns False, a plugin-error event
    with a non-empty error field must be emitted via progress_cb, and
    plugin loading must still continue (non-fatal)."""
    plugins = reset_plugin_state
    _make_plugin(tmp_path, "req_fail")
    # Force _install_requirements to report failure without actually running pip.
    monkeypatch.setattr(plugins, "_install_requirements", lambda *a, **kw: False)

    events = []
    _run_load_plugins_with_cb(plugins, type("FakeApp", (), {})(), tmp_path, events.append)

    error_events = [e for e in events if e["phase"] == "plugin-error" and e.get("plugin_id") == "req_fail"]
    assert error_events, "Expected at least one plugin-error event for req_fail"
    assert all(e["error"] for e in error_events), "plugin-error events must carry a non-empty error field"
    # Loading continued: req_fail is still registered.
    assert any(p["id"] == "req_fail" for p in plugins.LOADED_PLUGINS)


# ── Async loading: pending registry, incremental publish, failed status ─────────

def test_pending_then_incremental_publish_observed_during_setup(tmp_path, reset_plugin_state):
    """Every discovered plugin is recorded in PENDING_PLUGINS as "installing"
    up front, then GRADUATES into LOADED_PLUGINS as it becomes ready — one at a
    time, not all-at-once at the end (issue #421 incremental publish).

    Each plugin's setup() records the live LOADED/PENDING state under its own
    plugin id (read from ctx['log'].name):
      * During "aaa".setup(): both plugins are still pending+installing and
        nothing has graduated yet (LOADED is empty).
      * During "zzz".setup(): "aaa" has ALREADY graduated into LOADED while
        "zzz" is still pending — proving plugins publish incrementally.
    """
    plugins = reset_plugin_state
    body = (
        "import plugins\n"
        "def setup(app, ctx):\n"
        "    pid = ctx['log'].name.rsplit('.', 1)[-1]\n"
        "    app.state.snaps = getattr(app.state, 'snaps', {})\n"
        "    app.state.snaps[pid] = {\n"
        "        'pending': {k: v['status'] for k, v in plugins.PENDING_PLUGINS.items()},\n"
        "        'loaded': [p['id'] for p in plugins.LOADED_PLUGINS],\n"
        "    }\n"
    )
    _make_plugin(tmp_path, "aaa", routes_body=body)
    _make_plugin(tmp_path, "zzz", routes_body=body)

    fake_app = type("FakeApp", (), {})()
    fake_app.state = type("State", (), {})()
    _run_load_plugins(plugins, fake_app, tmp_path)

    snaps = fake_app.state.snaps
    # During aaa.setup(): both pending+installing, nothing graduated yet.
    assert snaps["aaa"]["pending"] == {"aaa": "installing", "zzz": "installing"}
    assert snaps["aaa"]["loaded"] == []
    # During zzz.setup(): aaa already graduated (incremental publish); zzz pending.
    assert snaps["zzz"]["loaded"] == ["aaa"]
    assert "zzz" in snaps["zzz"]["pending"]
    assert "aaa" not in snaps["zzz"]["pending"]
    # Final: both ready, none pending.
    assert sorted(p["id"] for p in plugins.LOADED_PLUGINS) == ["aaa", "zzz"]
    assert plugins.PENDING_PLUGINS == {}


def test_stale_load_pass_cannot_republish_after_newer_pass(tmp_path, reset_plugin_state):
    """A still-running load pass must NOT republish into the registries after a
    NEWER load_plugins() pass has cleared them (re-entrancy race: a "reload
    plugins" action, FEEDBACK_SYNC_STARTUP hot-reload, or test teardown firing
    while the first pass's background install thread is mid-flight).

    The loader bumps a generation token at the start of every pass; _graduate()
    and _mark_failed() bail when the generation has advanced. Without the guard,
    the older pass's _graduate() would re-insert a plugin the newer pass already
    cleared, leaving a cross-generation / duplicate entry in LOADED_PLUGINS.
    """
    import threading

    plugins = reset_plugin_state
    setup_entered = threading.Event()
    release_setup = threading.Event()
    # Stash the events on the module so the file-exec'd plugin setup() can reach
    # them without globals plumbing. Cleaned up at the end of the test.
    plugins._TEST_setup_entered = setup_entered
    plugins._TEST_release_setup = release_setup
    try:
        root1 = tmp_path / "gen1"
        root2 = tmp_path / "gen2"
        root1.mkdir()
        root2.mkdir()
        # Pass 1's plugin blocks inside setup() — past discovery and the PENDING
        # seed, just before it would graduate — until the test releases it.
        _make_plugin(
            root1, "slow",
            routes_body=(
                "import plugins\n"
                "def setup(app, ctx):\n"
                "    plugins._TEST_setup_entered.set()\n"
                "    plugins._TEST_release_setup.wait(5)\n"
            ),
        )
        _make_plugin(root2, "fast")  # no-op setup, graduates immediately

        errors = []

        def _pass1():
            saved = plugins.PLUGINS_DIR
            plugins.PLUGINS_DIR = root1
            try:
                plugins.load_plugins(type("FakeApp", (), {})(), {})
            except Exception as e:  # pragma: no cover - failure path
                errors.append(e)
            finally:
                plugins.PLUGINS_DIR = saved

        t1 = threading.Thread(target=_pass1)
        t1.start()
        # Wait until pass 1 is parked inside slow.setup() (discovery done,
        # PENDING seeded, about to eventually graduate "slow").
        assert setup_entered.wait(5), "pass 1 never entered slow.setup()"

        # Pass 2 runs to completion on the main thread: bumps the generation,
        # clears both registries, graduates "fast".
        saved = plugins.PLUGINS_DIR
        plugins.PLUGINS_DIR = root2
        try:
            plugins.load_plugins(type("FakeApp", (), {})(), {})
        finally:
            plugins.PLUGINS_DIR = saved

        # Release pass 1; it resumes and attempts to graduate "slow" — now stale.
        release_setup.set()
        t1.join(5)
        assert not t1.is_alive(), "pass 1 thread did not finish"
        assert not errors, f"pass 1 raised: {errors}"

        # Only pass 2's output survives. The stale pass's "slow" must NOT appear
        # in either registry — its _graduate() was a no-op.
        assert [p["id"] for p in plugins.LOADED_PLUGINS] == ["fast"]
        assert "slow" not in plugins.PENDING_PLUGINS
        assert "slow" not in {p["id"] for p in plugins.LOADED_PLUGINS}
    finally:
        delattr(plugins, "_TEST_setup_entered")
        delattr(plugins, "_TEST_release_setup")


def test_failed_plugin_shows_failed_status_and_stays_visible(tmp_path, reset_plugin_state):
    """A plugin whose routes fail to load is NOT added to LOADED_PLUGINS
    (ready-only) but STAYS visible as a disabled "failed" entry in
    PENDING_PLUGINS and on /api/plugins, with its error text — so the nav can
    render it disabled with a tooltip rather than dropping it (ADR 0001)."""
    plugins = reset_plugin_state
    _make_plugin(tmp_path, "okp")  # healthy, no-op setup
    _make_plugin(
        tmp_path, "broken",
        routes_body="def setup(app, ctx):\n    raise RuntimeError('boom')\n",
    )
    _run_load_plugins(plugins, type("FakeApp", (), {})(), tmp_path)

    # LOADED_PLUGINS stays ready-only: broken absent, okp present.
    loaded_ids = {p["id"] for p in plugins.LOADED_PLUGINS}
    assert "broken" not in loaded_ids
    assert "okp" in loaded_ids
    # broken remains a visible "failed" pending entry with error text.
    assert plugins.PENDING_PLUGINS["broken"]["status"] == "failed"
    assert plugins.PENDING_PLUGINS["broken"]["error"]
    assert "okp" not in plugins.PENDING_PLUGINS  # graduated, no longer pending

    # /api/plugins exposes the union with per-plugin status + error.
    client = _make_api_client(plugins)
    try:
        rows = {p["id"]: p for p in client.get("/api/plugins").json()}
        assert rows["broken"]["status"] == "failed"
        assert rows["broken"]["error"]
        assert rows["okp"]["status"] == "ready"
        assert rows["okp"]["error"] is None
    finally:
        client.close()


def test_api_plugins_surfaces_installing_pending_entry(tmp_path, reset_plugin_state):
    """An "installing" pending entry surfaces on /api/plugins immediately with
    its manifest-derived nav fields and status="installing" (no error), so the
    frontend can render a disabled "installing…" nav slot before the (possibly
    very slow) dependency install finishes."""
    plugins = reset_plugin_state
    pdir = tmp_path / "heavy"
    pdir.mkdir()
    plugins.PENDING_PLUGINS["heavy"] = {
        "id": "heavy", "name": "Heavy ML Plugin", "nav": "/heavy",
        "type": "visualization", "bundled": True, "version": "2.0.0",
        "has_screen": True, "has_script": False, "has_settings": False,
        "has_tour": False, "_order": 0, "status": "installing", "error": None,
    }
    client = _make_api_client(plugins)
    try:
        rows = {p["id"]: p for p in client.get("/api/plugins").json()}
        h = rows["heavy"]
        assert h["status"] == "installing"
        assert h["error"] is None
        assert h["nav"] == "/heavy"
        assert h["type"] == "visualization"
        assert h["bundled"] is True
        assert h["version"] == "2.0.0"
        assert h["has_screen"] is True
        assert h["fallback"] is False
    finally:
        client.close()


def test_api_plugins_union_sorted_by_discovery_order(tmp_path, reset_plugin_state):
    """The /api/plugins union is re-sorted by discovery order so an installing
    plugin occupies its eventual nav slot regardless of whether it currently
    lives in LOADED_PLUGINS (ready) or PENDING_PLUGINS (installing/failed)."""
    plugins = reset_plugin_state
    pdir = tmp_path / "d"
    pdir.mkdir()
    # Ready plugin discovered SECOND (order 1) lives in LOADED_PLUGINS.
    plugins.LOADED_PLUGINS.append({
        "id": "ready_second", "name": "Ready", "nav": None, "type": None,
        "bundled": False, "has_screen": False, "has_script": False,
        "has_settings": False, "has_tour": False, "status": "ready",
        "_order": 1, "_dir": pdir, "_manifest": {},
    })
    # Installing plugin discovered FIRST (order 0) lives in PENDING_PLUGINS.
    plugins.PENDING_PLUGINS["installing_first"] = {
        "id": "installing_first", "name": "Installing", "nav": None, "type": None,
        "bundled": False, "version": None, "has_screen": False, "has_script": False,
        "has_settings": False, "has_tour": False, "_order": 0,
        "status": "installing", "error": None,
    }
    client = _make_api_client(plugins)
    try:
        order = [p["id"] for p in client.get("/api/plugins").json()]
        assert order == ["installing_first", "ready_second"]
    finally:
        client.close()


def test_pending_plugin_assets_not_served(tmp_path, reset_plugin_state):
    """Asset endpoints serve only ready plugins. A plugin still installing
    (present in PENDING_PLUGINS, absent from LOADED_PLUGINS) returns 404 for
    its screen.js / screen.html even though its manifest advertises them."""
    plugins = reset_plugin_state
    pdir = tmp_path / "heavy"
    pdir.mkdir()
    (pdir / "screen.js").write_text("console.log('x');\n")
    (pdir / "screen.html").write_text("<p>hi</p>\n")
    plugins.PENDING_PLUGINS["heavy"] = {
        "id": "heavy", "name": "Heavy", "nav": None, "type": None,
        "bundled": False, "version": None, "has_screen": True, "has_script": True,
        "has_settings": False, "has_tour": False, "_order": 0,
        "status": "installing", "error": None, "_dir": pdir, "_manifest": {},
    }
    client = _make_api_client(plugins)
    try:
        assert client.get("/api/plugins/heavy/screen.js").status_code == 404
        assert client.get("/api/plugins/heavy/screen.html").status_code == 404
    finally:
        client.close()


# ── Tour API tests ─────────────────────────────────────────────────────────────

def _make_tour_plugin(plugin_root, plugin_id, *, tour_file_name="tour.json", tour_content=None):
    """Create a minimal plugin directory with a tour field in plugin.json."""
    plugin_dir = plugin_root / plugin_id
    plugin_dir.mkdir(parents=True)
    manifest = {"id": plugin_id, "name": plugin_id, "tour": tour_file_name}
    (plugin_dir / "plugin.json").write_text(json.dumps(manifest))
    if tour_content is not None:
        (plugin_dir / tour_file_name).write_text(json.dumps(tour_content))
    return plugin_dir


def _make_api_client(plugins):
    """Register the plugin API on a fresh FastAPI app and return a TestClient."""
    app = FastAPI()
    plugins.register_plugin_api(app)
    return TestClient(app)


@pytest.fixture()
def tour_client(tmp_path, reset_plugin_state):
    """A TestClient with two plugins: one with a tour, one without."""
    plugins = reset_plugin_state

    # Plugin with tour
    tour_content = {"tour": [{"id": "step1", "title": "Hello", "content": "World"}]}
    plugin_dir = _make_tour_plugin(tmp_path, "with_tour", tour_content=tour_content)

    # Plugin without tour
    no_tour_dir = tmp_path / "no_tour"
    no_tour_dir.mkdir()
    (no_tour_dir / "plugin.json").write_text(json.dumps({"id": "no_tour", "name": "No Tour"}))

    # Stub LOADED_PLUGINS with both plugins
    plugins.LOADED_PLUGINS.append({
        "id": "with_tour",
        "name": "With Tour",
        "nav": None,
        "type": None,
        "has_screen": False,
        "has_script": False,
        "has_settings": False,
        "has_tour": True,
        "_dir": plugin_dir,
        "_manifest": {"tour": "tour.json"},
    })
    plugins.LOADED_PLUGINS.append({
        "id": "no_tour",
        "name": "No Tour",
        "nav": None,
        "type": None,
        "has_screen": False,
        "has_script": False,
        "has_settings": False,
        "has_tour": False,
        "_dir": no_tour_dir,
        "_manifest": {},
    })

    client = _make_api_client(plugins)
    try:
        yield client, plugin_dir
    finally:
        client.close()


def test_list_plugins_includes_has_tour(tour_client):
    """GET /api/plugins must include a has_tour boolean for each plugin."""
    client, _ = tour_client
    r = client.get("/api/plugins")
    assert r.status_code == 200
    plugins_list = r.json()
    ids = {p["id"]: p for p in plugins_list}
    assert "has_tour" in ids["with_tour"]
    assert ids["with_tour"]["has_tour"] is True
    assert "has_tour" in ids["no_tour"]
    assert ids["no_tour"]["has_tour"] is False


def test_nav_entry_derives_has_styles_from_manifest(tmp_path, reset_plugin_state):
    """The real loader must derive has_styles + carry the styles path from the
    manifest WITHOUT importing plugin code (mirrors has_screen/has_tour)."""
    plugins = reset_plugin_state
    styled = _make_plugin(tmp_path, "styled")
    (styled / "plugin.json").write_text(json.dumps(
        {"id": "styled", "name": "Styled", "routes": "routes.py",
         "styles": "assets/plugin.css"}))
    _make_plugin(tmp_path, "plain")  # no styles key

    _run_load_plugins(plugins, type("FakeApp", (), {})(), tmp_path)

    by_id = {p["id"]: p for p in plugins.LOADED_PLUGINS}
    assert by_id["styled"]["has_styles"] is True
    assert by_id["styled"]["styles"] == "assets/plugin.css"
    assert by_id["plain"]["has_styles"] is False
    assert by_id["plain"]["styles"] is None


def test_list_plugins_surfaces_has_styles_and_path(tmp_path, reset_plugin_state):
    """GET /api/plugins must surface has_styles + styles for each plugin so the
    frontend can build the <link> URL; a plugin without styles → False/None."""
    plugins = reset_plugin_state
    plugin_dir = tmp_path / "dummy"
    plugin_dir.mkdir()
    plugins.LOADED_PLUGINS.append({
        "id": "with_styles", "name": "With Styles", "nav": None, "type": None,
        "has_screen": False, "has_script": False, "has_settings": False,
        "has_tour": False, "has_styles": True, "styles": "assets/plugin.css",
        "_dir": plugin_dir, "_manifest": {},
    })
    plugins.LOADED_PLUGINS.append({
        "id": "no_styles", "name": "No Styles", "nav": None, "type": None,
        "has_screen": False, "has_script": False, "has_settings": False,
        "has_tour": False, "_dir": plugin_dir, "_manifest": {},
    })

    client = _make_api_client(plugins)
    try:
        r = client.get("/api/plugins")
        assert r.status_code == 200
        ids = {p["id"]: p for p in r.json()}
        assert ids["with_styles"]["has_styles"] is True
        assert ids["with_styles"]["styles"] == "assets/plugin.css"
        # A stubbed entry without the keys falls back cleanly (no KeyError).
        assert ids["no_styles"]["has_styles"] is False
        assert ids["no_styles"]["styles"] is None
    finally:
        client.close()


def test_nav_entry_surfaces_pedalboard_metadata(tmp_path, reset_plugin_state):
    """The loader must carry description/category/icon from the manifest WITHOUT
    importing plugin code, and auto-detect assets/thumb.png when `icon` is
    omitted (v3 Pedalboard page)."""
    plugins = reset_plugin_state

    full = _make_plugin(tmp_path, "full")
    (full / "plugin.json").write_text(json.dumps(
        {"id": "full", "name": "Full", "routes": "routes.py",
         "description": "A short blurb.", "category": "audio",
         "icon": "assets/custom.png"}))

    # No `icon` in the manifest, but ships assets/thumb.png → auto-detected.
    probed = _make_plugin(tmp_path, "probed")
    (probed / "plugin.json").write_text(json.dumps(
        {"id": "probed", "name": "Probed", "routes": "routes.py"}))
    (probed / "assets").mkdir(exist_ok=True)
    (probed / "assets" / "thumb.png").write_bytes(b"\x89PNG\r\n")

    _make_plugin(tmp_path, "bare")  # no pedalboard fields, no thumb

    _run_load_plugins(plugins, type("FakeApp", (), {})(), tmp_path)

    by_id = {p["id"]: p for p in plugins.LOADED_PLUGINS}
    assert by_id["full"]["description"] == "A short blurb."
    assert by_id["full"]["category"] == "audio"
    assert by_id["full"]["icon"] == "assets/custom.png"
    # Auto-detected convention thumbnail.
    assert by_id["probed"]["icon"] == "assets/thumb.png"
    assert by_id["probed"]["description"] is None
    assert by_id["probed"]["category"] is None
    # Nothing declared and nothing on disk → all None (no default injected here;
    # the frontend supplies the default pedal graphic).
    assert by_id["bare"]["icon"] is None
    assert by_id["bare"]["description"] is None
    assert by_id["bare"]["category"] is None


def test_list_plugins_surfaces_pedalboard_metadata(tmp_path, reset_plugin_state):
    """GET /api/plugins must surface description/category/icon; a stubbed entry
    missing the keys falls back to None without raising."""
    plugins = reset_plugin_state
    plugin_dir = tmp_path / "dummy"
    plugin_dir.mkdir()
    plugins.LOADED_PLUGINS.append({
        "id": "decorated", "name": "Decorated", "nav": None, "type": None,
        "has_screen": False, "has_script": False, "has_settings": False,
        "has_tour": False, "description": "Blurb", "category": "tools",
        "icon": "assets/thumb.png", "_dir": plugin_dir, "_manifest": {},
    })
    plugins.LOADED_PLUGINS.append({
        "id": "plain", "name": "Plain", "nav": None, "type": None,
        "has_screen": False, "has_script": False, "has_settings": False,
        "has_tour": False, "_dir": plugin_dir, "_manifest": {},
    })

    client = _make_api_client(plugins)
    try:
        r = client.get("/api/plugins")
        assert r.status_code == 200
        ids = {p["id"]: p for p in r.json()}
        assert ids["decorated"]["description"] == "Blurb"
        assert ids["decorated"]["category"] == "tools"
        assert ids["decorated"]["icon"] == "assets/thumb.png"
        assert ids["plain"]["description"] is None
        assert ids["plain"]["category"] is None
        assert ids["plain"]["icon"] is None
    finally:
        client.close()


def test_list_plugins_version_field(tmp_path, reset_plugin_state):
    """GET /api/plugins must include a `version` field for each plugin.

    A plugin that declares ``version`` in its manifest must surface it;
    a plugin that omits the field must return ``None`` (not raise).
    """
    plugins_mod = reset_plugin_state

    versioned_dir = tmp_path / "versioned"
    versioned_dir.mkdir()
    (versioned_dir / "plugin.json").write_text(
        json.dumps({"id": "versioned", "name": "Versioned", "version": "1.2.3"})
    )

    unversioned_dir = tmp_path / "unversioned"
    unversioned_dir.mkdir()
    (unversioned_dir / "plugin.json").write_text(
        json.dumps({"id": "unversioned", "name": "Unversioned"})
    )

    plugins_mod.LOADED_PLUGINS.append({
        "id": "versioned",
        "name": "Versioned",
        "nav": None,
        "type": None,
        "has_screen": False,
        "has_script": False,
        "has_settings": False,
        "has_tour": False,
        "_dir": versioned_dir,
        "_manifest": {"version": "1.2.3"},
    })
    plugins_mod.LOADED_PLUGINS.append({
        "id": "unversioned",
        "name": "Unversioned",
        "nav": None,
        "type": None,
        "has_screen": False,
        "has_script": False,
        "has_settings": False,
        "has_tour": False,
        "_dir": unversioned_dir,
        "_manifest": {},
    })

    client = _make_api_client(plugins_mod)
    try:
        r = client.get("/api/plugins")
        assert r.status_code == 200
        plugins_list = r.json()
        ids = {p["id"]: p for p in plugins_list}
        assert "version" in ids["versioned"], "version key must be present"
        assert ids["versioned"]["version"] == "1.2.3"
        assert "version" in ids["unversioned"], "version key must be present even when absent from manifest"
        assert ids["unversioned"]["version"] is None
    finally:
        client.close()


def test_list_plugins_exposes_profile_domain_manifest_metadata(tmp_path, reset_plugin_state):
    plugins_mod = reset_plugin_state
    plugin_dir = tmp_path / "declared"
    plugin_dir.mkdir()
    manifest = {
        "id": "declared",
        "name": "Declared",
        "nav": "Declared",
        "screen": "screen.html",
        "settings": "settings.html",
        "type": "visualization",
        "routes": "routes.py",
        "standards": ["capability-pipelines.v1", "profiles.v1", 42, ""],
        "capabilities": {"profiles": {"roles": ["observer"]}},
        "settings_schema": {"schema_version": "1", "packable_keys": ["gain"]},
        "ui_contributions": {"ui.player-panels": [{"id": "declared-panel"}]},
        "ui": {"ui.player-controls": [{"id": "declared-control"}]},
        "runtime_domains": {"midi-control": {"role": "observer"}, "custom-domain": {"role": "owner"}},
        "domains": {"jobs": [{"id": "declared-job"}], "tempo-clock": {"role": "observer"}},
    }
    plugins_mod.LOADED_PLUGINS.append({
        "id": "declared",
        "name": "Declared",
        "nav": "Declared",
        "type": "visualization",
        "has_screen": True,
        "has_script": False,
        "has_settings": True,
        "has_tour": False,
        "_dir": plugin_dir,
        "_manifest": manifest,
    })

    client = _make_api_client(plugins_mod)
    try:
        response = client.get("/api/plugins")
        assert response.status_code == 200
        plugin = response.json()[0]
        assert plugin["standards"] == ["capability-pipelines.v1", "profiles.v1"]
        assert plugin["capabilities"] == {"profiles": {"roles": ["observer"]}}
        assert plugin["settings_schema"] == {"schema_version": "1", "packable_keys": ["gain"]}
        assert plugin["ui_contributions"]["declared"] == {
            "ui.player-controls": [{"id": "declared-control"}],
            "ui.player-panels": [{"id": "declared-panel"}],
        }
        assert {item["legacy_source"] for item in plugin["ui_contributions"]["legacy"]} == {"nav", "screen", "settings", "type"}
        assert plugin["runtime_domains"] == {
            "custom-domain": {"role": "owner"},
            "jobs": [{"id": "declared-job"}],
            "midi-control": {"role": "observer"},
            "tempo-clock": {"role": "observer"},
        }
    finally:
        client.close()


def test_tour_json_serves_file(tour_client):
    """GET /api/plugins/{id}/tour.json returns file content as JSON for a plugin with a tour."""
    client, _ = tour_client
    r = client.get("/api/plugins/with_tour/tour.json")
    assert r.status_code == 200
    assert r.headers["content-type"].startswith("application/json")
    data = r.json()
    assert "tour" in data
    assert data["tour"][0]["id"] == "step1"


def test_tour_json_returns_404_for_missing_plugin(tour_client):
    """GET /api/plugins/{id}/tour.json returns 404 JSON for an unknown plugin."""
    client, _ = tour_client
    r = client.get("/api/plugins/nonexistent/tour.json")
    assert r.status_code == 404
    assert r.headers["content-type"].startswith("application/json")


def test_tour_json_returns_404_for_plugin_without_tour(tour_client):
    """GET /api/plugins/{id}/tour.json returns 404 for a plugin with no tour manifest entry."""
    client, _ = tour_client
    r = client.get("/api/plugins/no_tour/tour.json")
    assert r.status_code == 404
    assert r.headers["content-type"].startswith("application/json")


def test_tour_json_rejects_path_traversal(tmp_path, reset_plugin_state):
    """tour field with `../` path traversal must be rejected (returns 404)."""
    plugins = reset_plugin_state
    plugin_dir = tmp_path / "evil_plugin"
    plugin_dir.mkdir()
    # Write a 'secret' file outside the plugin dir that the traversal targets
    (tmp_path / "secret.json").write_text(json.dumps({"secret": "data"}))
    plugins.LOADED_PLUGINS.append({
        "id": "evil_plugin",
        "name": "Evil Plugin",
        "nav": None,
        "type": None,
        "has_screen": False,
        "has_script": False,
        "has_settings": False,
        "has_tour": True,
        "_dir": plugin_dir,
        "_manifest": {"tour": "../secret.json"},
    })
    app = FastAPI()
    plugins.register_plugin_api(app)
    client = TestClient(app)
    try:
        r = client.get("/api/plugins/evil_plugin/tour.json")
        assert r.status_code == 404
    finally:
        client.close()


def test_tour_json_handles_non_string_tour_manifest(tmp_path, reset_plugin_state):
    """A plugin whose `tour` manifest field is truthy but not a string or dict
    (e.g. ``true``, ``1``) must return 404 without raising AttributeError."""
    plugins = reset_plugin_state
    plugin_dir = tmp_path / "bool_tour_plugin"
    plugin_dir.mkdir()
    plugins.LOADED_PLUGINS.append({
        "id": "bool_tour_plugin",
        "name": "Bool Tour Plugin",
        "nav": None,
        "type": None,
        "has_screen": False,
        "has_script": False,
        "has_settings": False,
        "has_tour": False,  # _is_valid_tour_manifest(True) → False
        "_dir": plugin_dir,
        "_manifest": {"tour": True},  # boolean true in manifest
    })
    app = FastAPI()
    plugins.register_plugin_api(app)
    client = TestClient(app)
    try:
        r = client.get("/api/plugins/bool_tour_plugin/tour.json")
        assert r.status_code == 404
        assert r.headers["content-type"].startswith("application/json")
    finally:
        client.close()


def test_tour_json_rejects_directory_path(tmp_path, reset_plugin_state):
    """A `tour` field of `"."` resolves to the plugin dir itself.  The route
    must return 404 (not IsADirectoryError) because is_file() gates read_text."""
    plugins = reset_plugin_state
    plugin_dir = tmp_path / "dot_tour_plugin"
    plugin_dir.mkdir()
    plugins.LOADED_PLUGINS.append({
        "id": "dot_tour_plugin",
        "name": "Dot Tour Plugin",
        "nav": None,
        "type": None,
        "has_screen": False,
        "has_script": False,
        "has_settings": False,
        "has_tour": True,
        "_dir": plugin_dir,
        "_manifest": {"tour": "."},
    })
    app = FastAPI()
    plugins.register_plugin_api(app)
    client = TestClient(app)
    try:
        r = client.get("/api/plugins/dot_tour_plugin/tour.json")
        assert r.status_code == 404
        assert r.headers["content-type"].startswith("application/json")
    finally:
        client.close()


def test_tour_json_rejects_null_file_key(tmp_path, reset_plugin_state):
    """`{"tour": {"file": null}}` has an explicitly invalid `file` value.
    _is_valid_tour_manifest must reject it (has_tour=False) and the route
    must return 404 without an AttributeError."""
    import plugins as _plugins_mod
    # Directly verify the validation function rejects {"file": None}
    assert _plugins_mod._is_valid_tour_manifest({"file": None}) is False
    assert _plugins_mod._is_valid_tour_manifest({"file": ""}) is False
    assert _plugins_mod._is_valid_tour_manifest({}) is True   # bare dict defaults to tour.json
    plugins = reset_plugin_state
    plugin_dir = tmp_path / "null_file_plugin"
    plugin_dir.mkdir()
    plugins.LOADED_PLUGINS.append({
        "id": "null_file_plugin",
        "name": "Null File Plugin",
        "nav": None,
        "type": None,
        "has_screen": False,
        "has_script": False,
        "has_settings": False,
        "has_tour": False,  # _is_valid_tour_manifest({"file": None}) → False
        "_dir": plugin_dir,
        "_manifest": {"tour": {"file": None}},
    })
    app = FastAPI()
    plugins.register_plugin_api(app)
    client = TestClient(app)
    try:
        # Confirm the listing endpoint reflects has_tour=False for this plugin
        listing = client.get("/api/plugins").json()
        p_entry = next(p for p in listing if p["id"] == "null_file_plugin")
        assert p_entry["has_tour"] is False
        # Route must also return 404 (defensive: route validates independently)
        r = client.get("/api/plugins/null_file_plugin/tour.json")
        assert r.status_code == 404
        assert r.headers["content-type"].startswith("application/json")
    finally:
        client.close()


def test_install_requirements_marker_is_stable_across_calls(tmp_path, reset_plugin_state, monkeypatch):
    """The install marker must be deterministic so plugins don't reinstall
    every boot. Regression for a bug where ``hash(req_file.read_text())``
    returned a different integer per process (PYTHONHASHSEED randomisation),
    so ``_install_requirements`` re-ran pip on every restart.
    """
    import hashlib
    import subprocess as _sp

    plugins = reset_plugin_state

    plugin_dir = tmp_path / "myplugin"
    plugin_dir.mkdir()
    req_file = plugin_dir / "requirements.txt"
    req_file.write_text("librosa>=0.10.1\nnumpy>=1.24\n")

    pip_target = tmp_path / "pip_packages"
    monkeypatch.setattr(plugins, "_PIP_TARGET", pip_target)

    pip_calls: list = []

    def fake_run(cmd, **kwargs):
        pip_calls.append(cmd)
        return _sp.CompletedProcess(args=cmd, returncode=0, stdout="", stderr="")

    monkeypatch.setattr(plugins.subprocess, "run", fake_run)

    # First call — pip runs once and writes the marker.
    assert plugins._install_requirements(plugin_dir, "myplugin") is True
    assert len(pip_calls) == 1, "first call must invoke pip"
    marker = pip_target / ".installed_myplugin"
    assert marker.exists(), "marker must be written after successful install"
    first_marker_contents = marker.read_text().strip()

    # Second call in the same process — must skip pip.
    assert plugins._install_requirements(plugin_dir, "myplugin") is True
    assert len(pip_calls) == 1, "second in-process call must not re-invoke pip"

    # The crucial regression check: the marker must be derivable purely
    # from the requirements.txt bytes — no process-local state. If a
    # future change reintroduces ``hash()`` (or any other randomised
    # digest) the freshly-computed expected value below differs from
    # what was written, and the marker would never match on restart.
    expected = hashlib.sha256(req_file.read_bytes()).hexdigest()
    assert first_marker_contents == expected, (
        "marker must contain a deterministic digest of requirements.txt; "
        f"got {first_marker_contents!r}, expected {expected!r}"
    )


# ── settings.html encoding ─────────────────────────────────────────────────────

def test_settings_html_served_as_utf8_regardless_of_host_locale(
    tmp_path, reset_plugin_state, monkeypatch
):
    """Regression for feedBack-desktop#166 — mojibake in the Settings UI.

    The ``settings.html`` plugin endpoint must read its file with an
    explicit ``encoding="utf-8"``.  Without it, ``Path.read_text()`` falls
    back to the host's locale encoding — cp1252 on a Windows host — which
    decodes UTF-8 punctuation (em-dash ``—``, arrow ``→``) into mojibake
    (``â€``, ``â†``).  Its sibling endpoints ``screen.html`` / ``screen.js``
    already pass ``encoding="utf-8"``; ``settings.html`` was the lone
    outlier.  This test simulates the Windows locale default so the bug is
    caught even on a UTF-8 CI host.
    """
    plugins = reset_plugin_state

    plugin_dir = tmp_path / "fx"
    plugin_dir.mkdir()
    settings_html = (
        "<p>Audio Quality (Guitar → audio rendering)</p>"
        "<p>Default — GeneralUser GS (~32 MB, bundled)</p>"
    )
    # The on-disk file is genuine, correct UTF-8 — the strings are not the bug.
    (plugin_dir / "settings.html").write_text(settings_html, encoding="utf-8")
    (plugin_dir / "plugin.json").write_text(
        json.dumps({"id": "fx", "name": "FX", "settings": {"html": "settings.html"}})
    )

    plugins.LOADED_PLUGINS.append({
        "id": "fx",
        "name": "FX",
        "nav": None,
        "type": None,
        "has_screen": False,
        "has_script": False,
        "has_settings": True,
        "has_tour": False,
        "_dir": plugin_dir,
        "_manifest": {"settings": {"html": "settings.html"}},
    })

    # Simulate a Windows host: a ``read_text()`` call with no explicit
    # encoding falls back to the cp1252 locale default. An explicit
    # encoding (the fix) is honoured unchanged.
    real_read_text = Path.read_text

    def cp1252_default_read_text(self, encoding=None, *args, **kwargs):
        if encoding is None:
            return self.read_bytes().decode("cp1252")
        return real_read_text(self, encoding, *args, **kwargs)

    monkeypatch.setattr(Path, "read_text", cp1252_default_read_text)

    client = _make_api_client(plugins)
    try:
        r = client.get("/api/plugins/fx/settings.html")
        assert r.status_code == 200
        # The served body must byte-for-byte match the on-disk UTF-8 file.
        assert r.content == settings_html.encode("utf-8")
        # And must contain the real characters, not their mojibake forms.
        assert "Guitar → audio rendering" in r.text
        assert "Default — GeneralUser GS" in r.text
        assert "â€" not in r.text  # 'â€' — em-dash decoded as cp1252
        assert "â†" not in r.text  # 'â†' — arrow decoded as cp1252
    finally:
        client.close()


@pytest.fixture()
def asset_client(tmp_path, reset_plugin_state):
    """A TestClient with one plugin that bundles files under ``assets/``."""
    plugins = reset_plugin_state

    plugin_dir = tmp_path / "stems"
    (plugin_dir / "assets" / "sub").mkdir(parents=True)
    (plugin_dir / "assets" / "worklet.js").write_text("registerProcessor('x', class {});\n")
    (plugin_dir / "assets" / "plugin.css").write_text(".x-[11px]{font-size:11px}\n")
    (plugin_dir / "assets" / "sub" / "data.bin").write_bytes(b"\x00\x01\x02")
    # A sibling Python module OUTSIDE assets/ that must never be reachable.
    (plugin_dir / "routes.py").write_text("SECRET = 1\n")

    plugins.LOADED_PLUGINS.append({
        "id": "stems",
        "name": "Stems",
        "nav": None,
        "type": None,
        "has_screen": False,
        "has_script": False,
        "has_settings": False,
        "has_tour": False,
        "_dir": plugin_dir,
        "_manifest": {},
    })

    client = _make_api_client(plugins)
    try:
        yield client
    finally:
        client.close()


def test_plugin_asset_serves_bundled_file(asset_client):
    """A real file under <plugin>/assets/ is served with a JS media type."""
    r = asset_client.get("/api/plugins/stems/assets/worklet.js")
    assert r.status_code == 200
    assert r.text == "registerProcessor('x', class {});\n"
    assert "javascript" in r.headers["content-type"]


def test_plugin_asset_serves_css_as_stylesheet(asset_client):
    """A plugin's `styles` CSS under assets/ must serve as text/css so a
    <link rel=stylesheet> (the styles capability) is honoured by the browser."""
    r = asset_client.get("/api/plugins/stems/assets/plugin.css")
    assert r.status_code == 200
    assert "text/css" in r.headers["content-type"]


def test_plugin_asset_serves_nested_file(asset_client):
    """Nested asset paths (assets/sub/...) resolve via the {path} match."""
    r = asset_client.get("/api/plugins/stems/assets/sub/data.bin")
    assert r.status_code == 200
    assert r.content == b"\x00\x01\x02"


def test_plugin_asset_missing_file_404(asset_client):
    """A path under assets/ that does not exist returns 404, not 500."""
    r = asset_client.get("/api/plugins/stems/assets/nope.js")
    assert r.status_code == 404


def test_plugin_asset_rejects_traversal(asset_client):
    """`..` traversal must not escape assets/ to reach plugin Python modules."""
    # FastAPI normalises some `..` segments at the routing layer; hit the
    # handler's own safe_join guard with an encoded traversal too.
    for attack in (
        "/api/plugins/stems/assets/../routes.py",
        "/api/plugins/stems/assets/..%2froutes.py",
        "/api/plugins/stems/assets/sub/../../routes.py",
    ):
        r = asset_client.get(attack)
        assert r.status_code == 404, attack
        assert "SECRET" not in r.text


def test_plugin_asset_unknown_plugin_404(asset_client):
    """An asset request for an unloaded plugin id returns 404."""
    r = asset_client.get("/api/plugins/ghost/assets/worklet.js")
    assert r.status_code == 404


# --- Plugin enable/disable (v3 Pedalboard footswitch) ---------------------
#
# Backend contract: every /api/plugins entry carries `enabled` (default true);
# POST /api/plugins/{id}/enabled persists the choice to
# CONFIG_DIR/plugin_state.json; the loader skips disabled plugins at startup but
# still surfaces them as "off" pedals; a disabled plugin is excluded from the
# capability pipeline (its capability metadata is suppressed in /api/plugins).


def test_list_plugins_enabled_default_true(tmp_path, reset_plugin_state):
    """A plugin entry with no `enabled` key surfaces enabled:true by default."""
    plugins = reset_plugin_state
    plugin_dir = tmp_path / "dummy"
    plugin_dir.mkdir()
    plugins.LOADED_PLUGINS.append({
        "id": "demo", "name": "Demo", "nav": None, "type": None,
        "has_screen": False, "has_script": False, "has_settings": False,
        "has_tour": False, "_dir": plugin_dir, "_manifest": {},
    })
    client = _make_api_client(plugins)
    try:
        r = client.get("/api/plugins")
        assert r.status_code == 200
        ids = {p["id"]: p for p in r.json()}
        assert ids["demo"]["enabled"] is True
    finally:
        client.close()


def test_set_plugin_enabled_persists_and_suppresses_caps(tmp_path, reset_plugin_state, monkeypatch):
    """Disabling persists to plugin_state.json, returns {id, enabled:false}, and
    a subsequent GET shows enabled:false AND empty capability metadata so the
    plugin no longer occupies the capability pipeline graph."""
    plugins = reset_plugin_state
    config_dir = tmp_path / "config"
    config_dir.mkdir()
    monkeypatch.setenv("CONFIG_DIR", str(config_dir))

    plugin_dir = tmp_path / "dummy"
    plugin_dir.mkdir()
    plugins.LOADED_PLUGINS.append({
        "id": "demo", "name": "Demo", "nav": None, "type": None,
        "has_screen": False, "has_script": False, "has_settings": False,
        "has_tour": False, "_dir": plugin_dir, "_manifest": {},
        "capabilities": {"example.domain": {"role": "owner"}},
        "standards": ["capability-pipelines.v1"],
    })

    client = _make_api_client(plugins)
    try:
        r = client.post("/api/plugins/demo/enabled", json={"enabled": False})
        assert r.status_code == 200
        assert r.json() == {"id": "demo", "enabled": False}

        # Persisted (only the non-default entry is stored).
        state = json.loads((config_dir / "plugin_state.json").read_text())
        assert state == {"demo": {"enabled": False}}

        # Reflected immediately, with capabilities suppressed.
        r = client.get("/api/plugins")
        ids = {p["id"]: p for p in r.json()}
        assert ids["demo"]["enabled"] is False
        assert ids["demo"]["capabilities"] == {}
        assert ids["demo"]["standards"] == []
    finally:
        client.close()


def test_set_plugin_enabled_re_enable_clears_state(tmp_path, reset_plugin_state, monkeypatch):
    """Re-enabling drops the key from plugin_state.json (only non-defaults are
    stored) and restores the plugin's capability metadata in /api/plugins."""
    plugins = reset_plugin_state
    config_dir = tmp_path / "config"
    config_dir.mkdir()
    monkeypatch.setenv("CONFIG_DIR", str(config_dir))
    (config_dir / "plugin_state.json").write_text(json.dumps({"demo": {"enabled": False}}))

    plugin_dir = tmp_path / "dummy"
    plugin_dir.mkdir()
    plugins.LOADED_PLUGINS.append({
        "id": "demo", "name": "Demo", "nav": None, "type": None,
        "has_screen": False, "has_script": False, "has_settings": False,
        "has_tour": False, "_dir": plugin_dir, "_manifest": {}, "enabled": False,
        "capabilities": {"example.domain": {"role": "owner"}},
        "standards": ["capability-pipelines.v1"],
    })

    client = _make_api_client(plugins)
    try:
        r = client.post("/api/plugins/demo/enabled", json={"enabled": True})
        assert r.status_code == 200
        assert r.json() == {"id": "demo", "enabled": True}

        assert json.loads((config_dir / "plugin_state.json").read_text()) == {}

        r = client.get("/api/plugins")
        ids = {p["id"]: p for p in r.json()}
        assert ids["demo"]["enabled"] is True
        assert ids["demo"]["capabilities"] == {"example.domain": {"role": "owner"}}
        assert ids["demo"]["standards"] == ["capability-pipelines.v1"]
    finally:
        client.close()


def test_set_plugin_enabled_unknown_id_404(tmp_path, reset_plugin_state, monkeypatch):
    """Toggling a plugin id that isn't loaded or pending → 404."""
    plugins = reset_plugin_state
    monkeypatch.setenv("CONFIG_DIR", str(tmp_path / "config"))
    client = _make_api_client(plugins)
    try:
        r = client.post("/api/plugins/ghost/enabled", json={"enabled": False})
        assert r.status_code == 404
        assert "error" in r.json()
    finally:
        client.close()


def test_set_plugin_enabled_bad_body_400(tmp_path, reset_plugin_state, monkeypatch):
    """A missing or non-boolean `enabled` field → 400 (not FastAPI's 422)."""
    plugins = reset_plugin_state
    monkeypatch.setenv("CONFIG_DIR", str(tmp_path / "config"))
    plugin_dir = tmp_path / "dummy"
    plugin_dir.mkdir()
    plugins.LOADED_PLUGINS.append({
        "id": "demo", "name": "Demo", "nav": None, "type": None,
        "has_screen": False, "has_script": False, "has_settings": False,
        "has_tour": False, "_dir": plugin_dir, "_manifest": {},
    })
    client = _make_api_client(plugins)
    try:
        for bad in ({}, {"enabled": "yes"}, {"enabled": 1}, {"other": True}):
            r = client.post("/api/plugins/demo/enabled", json=bad)
            assert r.status_code == 400, bad
            assert "error" in r.json()
        # A non-JSON body is rejected too.
        r = client.post("/api/plugins/demo/enabled", content=b"not json")
        assert r.status_code == 400
    finally:
        client.close()


def test_set_plugin_enabled_guardrails_block_always_on(tmp_path, reset_plugin_state, monkeypatch):
    """A LOADED capability_inspector / app_tour_* may never be disabled → 400,
    and nothing is written to plugin_state.json."""
    plugins = reset_plugin_state
    config_dir = tmp_path / "config"
    config_dir.mkdir()
    monkeypatch.setenv("CONFIG_DIR", str(config_dir))
    plugin_dir = tmp_path / "dummy"
    plugin_dir.mkdir()
    # The guard rail runs AFTER the existence check, so the always-on plugins
    # must actually be present for the 400 to fire (an absent id → 404 instead).
    for pid in ("capability_inspector", "app_tour_library"):
        plugins.LOADED_PLUGINS.append({
            "id": pid, "name": pid, "nav": None, "type": None,
            "has_screen": False, "has_script": False, "has_settings": False,
            "has_tour": False, "_dir": plugin_dir, "_manifest": {},
        })
    client = _make_api_client(plugins)
    try:
        for pid in ("capability_inspector", "app_tour_library"):
            r = client.post(f"/api/plugins/{pid}/enabled", json={"enabled": False})
            assert r.status_code == 400, pid
            assert "error" in r.json()
        assert not (config_dir / "plugin_state.json").exists()
    finally:
        client.close()


def test_set_plugin_enabled_unknown_always_on_id_is_404_not_400(tmp_path, reset_plugin_state, monkeypatch):
    """An UNKNOWN id that happens to match the always-on pattern (e.g.
    app_tour_ghost) is "not found" (404), not "cannot be disabled" (400) — the
    response must not depend on the spelling of a nonexistent id (Codex review)."""
    plugins = reset_plugin_state
    monkeypatch.setenv("CONFIG_DIR", str(tmp_path / "config"))
    client = _make_api_client(plugins)
    try:
        r = client.post("/api/plugins/app_tour_ghost/enabled", json={"enabled": False})
        assert r.status_code == 404
    finally:
        client.close()


def test_set_plugin_enabled_persist_failure_returns_500(tmp_path, reset_plugin_state, monkeypatch):
    """A filesystem write failure when persisting is a controlled 500, and the
    in-memory flag is NOT flipped (memory and disk stay consistent)."""
    plugins = reset_plugin_state
    monkeypatch.setenv("CONFIG_DIR", str(tmp_path / "config"))
    plugin_dir = tmp_path / "dummy"
    plugin_dir.mkdir()
    plugins.LOADED_PLUGINS.append({
        "id": "demo", "name": "Demo", "nav": None, "type": None,
        "has_screen": False, "has_script": False, "has_settings": False,
        "has_tour": False, "_dir": plugin_dir, "_manifest": {},
    })

    def boom(plugin_id, enabled):
        raise OSError("disk full")
    monkeypatch.setattr(plugins, "_persist_plugin_enabled", boom)

    client = _make_api_client(plugins)
    try:
        r = client.post("/api/plugins/demo/enabled", json={"enabled": False})
        assert r.status_code == 500
        assert "error" in r.json()
        # In-memory flag untouched, so a later GET still shows enabled.
        ids = {p["id"]: p for p in client.get("/api/plugins").json()}
        assert ids["demo"]["enabled"] is True
    finally:
        client.close()


def test_disabled_plugin_skipped_by_loader(tmp_path, reset_plugin_state, monkeypatch):
    """A plugin persisted as enabled:false is NOT loaded (its routes.setup never
    runs) but still surfaces in /api/plugins as a disabled entry; an enabled
    sibling loads normally."""
    plugins = reset_plugin_state
    config_dir = tmp_path / "config"
    config_dir.mkdir()
    monkeypatch.setenv("CONFIG_DIR", str(config_dir))
    (config_dir / "plugin_state.json").write_text(json.dumps({"off": {"enabled": False}}))

    marker_body = (
        "import os\n"
        "from pathlib import Path\n"
        "def setup(app, ctx):\n"
        "    Path(os.environ['CONFIG_DIR'], 'marker_{id}').write_text('1')\n"
    )
    plugins_root = tmp_path / "plugins"
    _make_plugin(plugins_root, "off", routes_body=marker_body.format(id="off"))
    _make_plugin(plugins_root, "on", routes_body=marker_body.format(id="on"))

    _run_load_plugins(plugins, type("FakeApp", (), {})(), plugins_root)

    loaded_ids = {p["id"] for p in plugins.LOADED_PLUGINS}
    assert "on" in loaded_ids
    assert "off" not in loaded_ids
    # routes.setup() ran only for the enabled plugin.
    assert (config_dir / "marker_on").exists()
    assert not (config_dir / "marker_off").exists()
    # The disabled plugin is still a visible, disabled pending entry.
    assert plugins.PENDING_PLUGINS["off"]["status"] == "disabled"
    assert plugins.PENDING_PLUGINS["off"]["enabled"] is False

    client = _make_api_client(plugins)
    try:
        ids = {p["id"]: p for p in client.get("/api/plugins").json()}
        assert ids["off"]["enabled"] is False
        assert ids["off"]["status"] == "disabled"
        assert ids["on"]["enabled"] is True
    finally:
        client.close()


def test_corrupt_plugin_state_does_not_crash_loader(tmp_path, reset_plugin_state, monkeypatch):
    """A corrupt plugin_state.json is ignored (all plugins enabled by default)
    and loading does not raise."""
    plugins = reset_plugin_state
    config_dir = tmp_path / "config"
    config_dir.mkdir()
    monkeypatch.setenv("CONFIG_DIR", str(config_dir))
    (config_dir / "plugin_state.json").write_text("{not valid json")

    plugins_root = tmp_path / "plugins"
    _make_plugin(plugins_root, "ok")

    _run_load_plugins(plugins, type("FakeApp", (), {})(), plugins_root)

    assert "ok" in {p["id"] for p in plugins.LOADED_PLUGINS}


def test_reenable_startup_disabled_plugin_keeps_caps_suppressed(tmp_path, reset_plugin_state, monkeypatch):
    """Re-enabling a plugin that was SKIPPED at startup (pending, status
    "disabled") flips its `enabled` flag immediately but must NOT reintroduce
    its capability metadata into /api/plugins — the plugin isn't mounted until
    the next restart, so surfacing its capabilities would register a phantom
    pipeline participant (Codex review)."""
    plugins = reset_plugin_state
    config_dir = tmp_path / "config"
    config_dir.mkdir()
    monkeypatch.setenv("CONFIG_DIR", str(config_dir))
    (config_dir / "plugin_state.json").write_text(json.dumps({"off": {"enabled": False}}))

    # A startup-skipped plugin lives in PENDING_PLUGINS with status "disabled".
    plugins.PENDING_PLUGINS["off"] = {
        "id": "off", "name": "Off", "nav": None, "type": None,
        "status": "disabled", "enabled": False, "_order": 0,
        "capabilities": {"example.domain": {"role": "owner"}},
        "standards": ["capability-pipelines.v1"],
    }

    client = _make_api_client(plugins)
    try:
        r = client.post("/api/plugins/off/enabled", json={"enabled": True})
        assert r.status_code == 200
        assert r.json() == {"id": "off", "enabled": True}

        ids = {p["id"]: p for p in client.get("/api/plugins").json()}
        # Flag reflects intent immediately...
        assert ids["off"]["enabled"] is True
        # ...but it is still not mounted, so capabilities stay suppressed.
        assert ids["off"]["status"] == "disabled"
        assert ids["off"]["capabilities"] == {}
        assert ids["off"]["standards"] == []
    finally:
        client.close()


def test_is_plugin_enabled_ignores_malformed_entry(reset_plugin_state):
    """Only a real boolean `enabled` is authoritative; missing or junk values
    fall back to enabled (matches the endpoint's strict isinstance(bool) check),
    so a partially-corrupt or hand-edited plugin_state.json can't silently
    disable a plugin (Codex review)."""
    plugins = reset_plugin_state
    # A genuine ``{"enabled": false}`` disables.
    assert plugins._is_plugin_enabled({"p": {"enabled": False}}, "p") is False
    assert plugins._is_plugin_enabled({"p": {"enabled": True}}, "p") is True
    # Junk / falsey-but-not-bool values are treated as enabled (default true).
    for junk in (0, 1, "", "false", [], {}, None):
        assert plugins._is_plugin_enabled({"p": {"enabled": junk}}, "p") is True, junk
    # Missing key, non-dict entry, and absent plugin all default to enabled.
    assert plugins._is_plugin_enabled({"p": {}}, "p") is True
    assert plugins._is_plugin_enabled({"p": "nope"}, "p") is True
    assert plugins._is_plugin_enabled({}, "p") is True


def test_disable_while_installing_is_carried_into_loaded_entry(tmp_path, reset_plugin_state, monkeypatch):
    """A disable that arrives while a plugin is still loading must survive
    graduation. The ready entry is rebuilt from the startup _spec_entries
    snapshot, so _graduate carries the live pending entry's `enabled` flag
    forward — otherwise the runtime disable silently reverts until restart
    (Codex review)."""
    plugins = reset_plugin_state
    config_dir = tmp_path / "config"
    config_dir.mkdir()
    monkeypatch.setenv("CONFIG_DIR", str(config_dir))

    # routes.setup() runs after the pending-seed snapshot but before this
    # plugin graduates, so flipping the live pending entry here simulates a
    # runtime disable racing an in-flight load.
    body = (
        "import plugins\n"
        "def setup(app, ctx):\n"
        "    plugins.PENDING_PLUGINS['demo']['enabled'] = False\n"
    )
    plugins_root = tmp_path / "plugins"
    _make_plugin(plugins_root, "demo", routes_body=body)

    _run_load_plugins(plugins, type("FakeApp", (), {})(), plugins_root)

    by_id = {p["id"]: p for p in plugins.LOADED_PLUGINS}
    assert "demo" in by_id, "plugin should still graduate (routes already mounting)"
    # The ready entry reflects the runtime disable, not the stale startup value.
    assert by_id["demo"]["enabled"] is False


def test_persist_does_not_clobber_on_unreadable_existing_state(tmp_path, reset_plugin_state, monkeypatch):
    """A read-time OSError on an existing plugin_state.json must propagate (→ a
    controlled 500 at the endpoint) rather than reset to {} and overwrite — that
    would silently clobber every other plugin's persisted disabled state (Codex
    review)."""
    plugins = reset_plugin_state
    config_dir = tmp_path / "config"
    config_dir.mkdir()
    monkeypatch.setenv("CONFIG_DIR", str(config_dir))
    # Make the state path unreadable as a file: a directory at that path makes
    # read_text raise IsADirectoryError (a non-FileNotFound OSError).
    (config_dir / "plugin_state.json").mkdir()

    with pytest.raises(OSError):
        plugins._persist_plugin_enabled("demo", False)
    # Untouched — not replaced with a fresh file.
    assert (config_dir / "plugin_state.json").is_dir()


def test_disable_before_route_setup_aborts_mount(tmp_path, reset_plugin_state, monkeypatch):
    """A disable that lands BEFORE a plugin's routes are mounted prevents the
    mount entirely (no setup(), not graduated) — not just suppressed after the
    fact. Plugins load alphabetically, so 'a_disabler' runs first and disables
    'z_target' (simulating a runtime POST during an earlier install); the loader
    must re-check the live flag and skip 'z_target' (Codex review)."""
    plugins = reset_plugin_state
    config_dir = tmp_path / "config"
    config_dir.mkdir()
    monkeypatch.setenv("CONFIG_DIR", str(config_dir))

    plugins_root = tmp_path / "plugins"
    _make_plugin(plugins_root, "a_disabler", routes_body=(
        "import plugins\n"
        "def setup(app, ctx):\n"
        "    plugins.PENDING_PLUGINS['z_target']['enabled'] = False\n"
    ))
    _make_plugin(plugins_root, "z_target", routes_body=(
        "import os\n"
        "from pathlib import Path\n"
        "def setup(app, ctx):\n"
        "    Path(os.environ['CONFIG_DIR'], 'z_marker').write_text('1')\n"
    ))

    _run_load_plugins(plugins, type("FakeApp", (), {})(), plugins_root)

    loaded_ids = {p["id"] for p in plugins.LOADED_PLUGINS}
    assert "a_disabler" in loaded_ids
    assert "z_target" not in loaded_ids
    # Its routes.setup() never ran...
    assert not (config_dir / "z_marker").exists()
    # ...and it remains a visible, disabled pending entry.
    assert plugins.PENDING_PLUGINS["z_target"]["status"] == "disabled"
    assert plugins.PENDING_PLUGINS["z_target"]["enabled"] is False


def test_disable_during_requirements_install_aborts_mount(tmp_path, reset_plugin_state, monkeypatch):
    """A disable that lands WHILE this plugin's own requirements are installing
    is caught by the final re-check before route setup, so the plugin is never
    mounted (Codex review — closes the install-window gap)."""
    plugins = reset_plugin_state
    config_dir = tmp_path / "config"
    config_dir.mkdir()
    monkeypatch.setenv("CONFIG_DIR", str(config_dir))

    plugins_root = tmp_path / "plugins"
    _make_plugin(plugins_root, "demo", routes_body=(
        "import os\n"
        "from pathlib import Path\n"
        "def setup(app, ctx):\n"
        "    Path(os.environ['CONFIG_DIR'], 'demo_marker').write_text('1')\n"
    ))

    def fake_install(plugin_dir, plugin_id):
        if plugin_id == "demo":
            # Simulate a runtime POST /enabled {"enabled": false} arriving mid-install.
            plugins.PENDING_PLUGINS["demo"]["enabled"] = False
        return True
    monkeypatch.setattr(plugins, "_install_requirements", fake_install)

    _run_load_plugins(plugins, type("FakeApp", (), {})(), plugins_root)

    assert "demo" not in {p["id"] for p in plugins.LOADED_PLUGINS}
    assert not (config_dir / "demo_marker").exists(), "setup() must not have run"
    assert plugins.PENDING_PLUGINS["demo"]["status"] == "disabled"
    assert plugins.PENDING_PLUGINS["demo"]["enabled"] is False


def test_non_utf8_plugin_state_does_not_crash_loader(tmp_path, reset_plugin_state, monkeypatch):
    """Encoding-corrupt (non-UTF-8) plugin_state.json is tolerated like bad JSON:
    the loader doesn't crash (all plugins enabled by default) and a subsequent
    toggle self-heals the file rather than escaping its controlled path (Codex
    review — UnicodeDecodeError is a ValueError, not OSError/JSONDecodeError)."""
    plugins = reset_plugin_state
    config_dir = tmp_path / "config"
    config_dir.mkdir()
    monkeypatch.setenv("CONFIG_DIR", str(config_dir))
    (config_dir / "plugin_state.json").write_bytes(b"\xff\xfe\x00not utf-8")

    # Load helper must not raise on the corrupt bytes.
    assert plugins._load_plugin_state() == {}

    plugins_root = tmp_path / "plugins"
    _make_plugin(plugins_root, "ok")
    _run_load_plugins(plugins, type("FakeApp", (), {})(), plugins_root)
    assert "ok" in {p["id"] for p in plugins.LOADED_PLUGINS}

    # Persist self-heals the encoding-corrupt file instead of raising.
    plugins._persist_plugin_enabled("ok", False)
    assert json.loads((config_dir / "plugin_state.json").read_text()) == {"ok": {"enabled": False}}


def test_disable_during_fallback_aborts_fallback_mount(tmp_path, reset_plugin_state, monkeypatch):
    """The bundled-plugin fallback path honors a runtime disable too: if a
    disable lands before the fallback user copy mounts, the loader skips it
    (no setup()), leaving a disabled entry — same contract as the main path
    (Codex review)."""
    plugins = reset_plugin_state
    config_dir = tmp_path / "config"
    config_dir.mkdir()
    monkeypatch.setenv("CONFIG_DIR", str(config_dir))

    bundled_dir = tmp_path / "bundled"
    (bundled_dir / "highway_3d").mkdir(parents=True)
    (bundled_dir / "highway_3d" / "plugin.json").write_text(
        json.dumps({"id": "highway_3d", "name": "3D Highway", "routes": "routes.py", "bundled": True})
    )
    # Bundled setup() disables the plugin (simulating a runtime POST) and then
    # fails — so the disable is live by the time the fallback path runs.
    (bundled_dir / "highway_3d" / "routes.py").write_text(
        "import plugins\n"
        "def setup(app, ctx):\n"
        "    plugins.PENDING_PLUGINS['highway_3d']['enabled'] = False\n"
        "    raise RuntimeError('bundled broken')\n"
    )

    user_dir = tmp_path / "user"
    (user_dir / "highway_3d").mkdir(parents=True)
    (user_dir / "highway_3d" / "plugin.json").write_text(
        json.dumps({"id": "highway_3d", "name": "3D Highway (user)", "routes": "routes.py"})
    )
    (user_dir / "highway_3d" / "routes.py").write_text(
        "def setup(app, ctx):\n    app.state.origin = 'user_fallback'\n"
    )
    monkeypatch.setenv("FEEDBACK_PLUGINS_DIR", str(user_dir))

    fake_app = type("FakeApp", (), {})()
    fake_app.state = type("State", (), {})()
    saved_dir = plugins.PLUGINS_DIR
    plugins.PLUGINS_DIR = bundled_dir
    try:
        plugins.load_plugins(fake_app, {})
    finally:
        plugins.PLUGINS_DIR = saved_dir

    # The fallback copy must NOT have been registered or mounted.
    assert "highway_3d" not in {p["id"] for p in plugins.LOADED_PLUGINS}
    assert getattr(fake_app.state, "origin", None) != "user_fallback"
    # It remains a visible, disabled entry.
    assert plugins.PENDING_PLUGINS["highway_3d"]["status"] == "disabled"
    assert plugins.PENDING_PLUGINS["highway_3d"]["enabled"] is False


def test_loader_honors_persisted_disable_without_memory_flip(tmp_path, reset_plugin_state, monkeypatch):
    """The loader's _became_disabled check consults the PERSISTED state, not
    just the in-memory flag — so a disable that has been written to disk (the
    endpoint persists BEFORE flipping memory) is honored even if the in-memory
    flag hasn't been flipped yet (Codex review — persist-then-flip window).
    'a_disabler' persists a disable for 'z_target' WITHOUT touching memory."""
    plugins = reset_plugin_state
    config_dir = tmp_path / "config"
    config_dir.mkdir()
    monkeypatch.setenv("CONFIG_DIR", str(config_dir))

    plugins_root = tmp_path / "plugins"
    _make_plugin(plugins_root, "a_disabler", routes_body=(
        "import plugins\n"
        "def setup(app, ctx):\n"
        "    plugins._persist_plugin_enabled('z_target', False)\n"  # disk only, no memory flip
    ))
    _make_plugin(plugins_root, "z_target", routes_body=(
        "import os\n"
        "from pathlib import Path\n"
        "def setup(app, ctx):\n"
        "    Path(os.environ['CONFIG_DIR'], 'z_marker').write_text('1')\n"
    ))

    _run_load_plugins(plugins, type("FakeApp", (), {})(), plugins_root)

    loaded_ids = {p["id"] for p in plugins.LOADED_PLUGINS}
    assert "a_disabler" in loaded_ids
    assert "z_target" not in loaded_ids
    assert not (config_dir / "z_marker").exists()
    assert plugins.PENDING_PLUGINS["z_target"]["status"] == "disabled"
    assert plugins.PENDING_PLUGINS["z_target"]["enabled"] is False


def test_settings_category_parsed_from_manifest(tmp_path, reset_plugin_state):
    """A plugin manifest's settings.category is parsed into settings_category
    on the loaded entry (drives the v3 settings-tab placement). Absent or a
    bare-string `settings` value yields None → the frontend's fallback tab."""
    plugins = reset_plugin_state

    def _write(pid, settings_value):
        d = tmp_path / pid
        d.mkdir()
        (d / "plugin.json").write_text(json.dumps({
            "id": pid, "name": pid, "routes": "routes.py", "settings": settings_value,
        }))
        (d / "routes.py").write_text("def setup(app, ctx):\n    pass\n")

    _write("graphy", {"html": "settings.html", "category": "graphics"})
    _write("plainset", {"html": "settings.html"})        # dict, no category
    _write("noset", None)                                # no settings at all

    _run_load_plugins(plugins, type("FakeApp", (), {})(), tmp_path)

    rows = {p["id"]: p for p in plugins.LOADED_PLUGINS}
    assert rows["graphy"]["settings_category"] == "graphics"
    assert rows["graphy"]["has_settings"] is True
    assert rows["plainset"]["settings_category"] is None
    assert rows["plainset"]["has_settings"] is True
    assert rows["noset"]["settings_category"] is None
    assert rows["noset"]["has_settings"] is False


def test_fullscreen_flag_parsed_from_manifest(tmp_path, reset_plugin_state):
    """A plugin manifest's top-level `fullscreen: true` surfaces as the boolean
    `fullscreen` on the loaded entry (drives the v3 shell's immersive mode).
    Only a strict boolean `true` opts in — absent, false, or a truthy non-bool
    (e.g. the string "true") all resolve to False so a plugin can't be opted in
    by accident."""
    plugins = reset_plugin_state

    def _write(pid, manifest_extra):
        d = tmp_path / pid
        d.mkdir()
        (d / "plugin.json").write_text(json.dumps({
            "id": pid, "name": pid, "routes": "routes.py",
            "screen": "screen.html", **manifest_extra,
        }))
        (d / "routes.py").write_text("def setup(app, ctx):\n    pass\n")
        (d / "screen.html").write_text("<div></div>")

    _write("immersive", {"fullscreen": True})
    _write("strflag", {"fullscreen": "true"})   # truthy non-bool → not opted in
    _write("falseflag", {"fullscreen": False})
    _write("noflag", {})                          # field absent

    _run_load_plugins(plugins, type("FakeApp", (), {})(), tmp_path)

    rows = {p["id"]: p for p in plugins.LOADED_PLUGINS}
    assert rows["immersive"]["fullscreen"] is True
    assert rows["strflag"]["fullscreen"] is False
    assert rows["falseflag"]["fullscreen"] is False
    assert rows["noflag"]["fullscreen"] is False
