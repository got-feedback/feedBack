"""The plugin context is a THIRD-PARTY CONTRACT. Pin it.

`context` is handed to every plugin's `setup()`. Plugins — including ones we don't ship
and can't grep — read keys out of it and hold the callables as live references. Issue #48
flagged this while planning the server.py split and asked for exactly this assertion:

    "Plugin context[...] are passed as live references into already-loaded plugins.
     Refactoring must preserve the exact callables — moving them to a new module is
     fine, but renaming or wrapping them breaks third-party plugins. We'd want a
     'plugin context unchanged' assertion in CI."

It doesn't exist yet, and server.py is about to be carved apart around the code that
builds it. This is the guard that makes the carve safe: a key silently dropped or
renamed by a move is invisible to every other test in the suite (nothing in-tree reads
most of these) and would break plugins at runtime, in the field.

Same lesson the frontend carve learned the hard way: a contract that only external code
reads cannot be found by a call-graph scan, so it has to be pinned by name.

WHY A LITERAL LIST AND NOT A DERIVED ONE. Deriving the expected set from the source would
assert the code equals itself. The whole point is that a human has to look at a diff and
consciously agree to change the contract.
"""

import ast
from pathlib import Path

import pytest

SERVER_PY = Path(__file__).resolve().parents[1] / "server.py"
PLUGINS_PY = Path(__file__).resolve().parents[1] / "plugins" / "__init__.py"

# The keys server.py puts in the shared context handed to register_plugin_api().
BASE_CONTEXT_KEYS = {
    "config_dir",
    "get_dlc_dir",
    "extract_meta",
    "meta_db",
    "get_scan_status",
    "get_art_cache_dir",
    "library_providers",
    "register_library_provider",
    "unregister_library_provider",
    "register_tuning_provider",
    "unregister_tuning_provider",
    "get_sloppak_cache_dir",
    "register_demo_janitor_hook",
    "award_xp",
    "get_xp_progress",
    "seed_xp",
    "reset_xp",
    "record_progression_event",
}

# Added PER PLUGIN by plugins/__init__.py on top of the base — so the surface a plugin
# actually sees is the union. Real shipped plugins read `log` and `load_sibling`, and
# neither is in server.py's dict; a test that pinned only the base would miss them.
PER_PLUGIN_KEYS = {"load_sibling", "log"}

FULL_CONTEXT = BASE_CONTEXT_KEYS | PER_PLUGIN_KEYS


def _plugin_context_keys() -> set:
    """The literal keys of server.py's `plugin_context = {...}`, read from the AST.

    AST, not a regex: the dict spans ~40 lines and is dense with comments, lambdas and
    nested calls, and the values contain braces of their own.
    """
    tree = ast.parse(SERVER_PY.read_text(encoding="utf-8"))
    for node in ast.walk(tree):
        if (
            isinstance(node, ast.Assign)
            and node.targets
            and isinstance(node.targets[0], ast.Name)
            and node.targets[0].id == "plugin_context"
            and isinstance(node.value, ast.Dict)
        ):
            keys = set()
            for k in node.value.keys:
                assert isinstance(k, ast.Constant), (
                    "plugin_context must be built from literal string keys — a computed "
                    "key makes this contract un-reviewable"
                )
                keys.add(k.value)
            return keys
    pytest.fail(
        "server.py no longer builds a literal `plugin_context = {...}` dict. If it moved "
        "to another module, point this test at that module — do NOT delete it."
    )


def test_plugin_context_keys_are_exactly_the_pinned_contract():
    actual = _plugin_context_keys()

    missing = BASE_CONTEXT_KEYS - actual
    added = actual - BASE_CONTEXT_KEYS

    assert not missing, (
        f"plugin_context lost {sorted(missing)}. Every one of these is read by plugins we "
        "do not control and cannot grep. Dropping one breaks them at runtime, in the "
        "field, with nothing else in this suite failing."
    )
    assert not added, (
        f"plugin_context gained {sorted(added)}. That's fine — but it is a PUBLIC API "
        "addition, so add the key to BASE_CONTEXT_KEYS here deliberately, and document it "
        "in docs/. This test exists to make that a conscious act rather than a side effect."
    )


def test_per_plugin_keys_are_still_layered_on_top():
    """`log` and `load_sibling` are added per-plugin in plugins/__init__.py, not by
    server.py — so they're invisible to the check above. Real plugins read both."""
    src = PLUGINS_PY.read_text(encoding="utf-8")
    for key in sorted(PER_PLUGIN_KEYS):
        assert f'plugin_context["{key}"]' in src, (
            f"plugins/__init__.py no longer sets plugin_context[{key!r}] — shipped plugins "
            "read it"
        )


def test_context_values_reach_a_REAL_plugin_by_identity(tmp_path, reset_plugin_state):
    """The contract is CALLABLE IDENTITY, not just key names.

    A carve that moves these into a module and re-exports them through a wrapper (a
    property, a functools.partial, a lazily-bound getter) keeps every key name intact and
    STILL breaks plugins that stored the reference at setup() time.

    Codex [P2] on the first cut of this test, and it was right: I originally built a dict
    locally and called setup() on it, which asserts `dict(x)['k'] is x['k']` — trivially
    true, and blind to everything plugins/__init__.py does. It has to go through the REAL
    loader, because the real loader is exactly what copies and re-binds the context.

    (That is not hypothetical: `register_library_provider` IS deliberately wrapped by the
    loader, per-plugin, to force owner attribution. Pinned below so the one intentional
    exception can't quietly become two.)
    """
    from fastapi import FastAPI

    # reset_plugin_state (tests/conftest.py) is the ONLY safe way to drive the real
    # load_plugins(): it also mutates sys.path, sys.modules and PENDING_PLUGINS, and a
    # hand-rolled partial restore makes the suite order- and environment-dependent.
    # Codex [P2] on the first cut of this, and it was right.
    plugins_mod = reset_plugin_state

    plugin_dir = tmp_path / "ctxprobe"
    plugin_dir.mkdir()
    (plugin_dir / "plugin.json").write_text(
        '{"id": "ctxprobe", "name": "ctx probe", "routes": "routes.py"}'
    )
    # A backend plugin's entry point is routes.py's `setup(app, ctx)` — the same shape
    # tests/test_plugins.py::_make_plugin uses. The probe hands the context BACK through a
    # sink in the context itself: importing the probe module by name does not work (the
    # loader namespaces plugin modules), and a file/JSON channel would lose the object
    # IDENTITY that is the entire point of this test.
    (plugin_dir / "routes.py").write_text(
        "def setup(app, ctx):\n"
        "    ctx['_probe_sink'].append(ctx)\n"
    )

    sentinel_db = object()

    def sentinel_extract(_p):
        return {}

    def sentinel_register_library_provider(provider, *a, **kw):
        return None

    sink = []
    context = {
        "_probe_sink": sink,
        "meta_db": sentinel_db,
        "extract_meta": sentinel_extract,
        "config_dir": tmp_path,
        "register_library_provider": sentinel_register_library_provider,
    }

    app = FastAPI()
    saved_dir = plugins_mod.PLUGINS_DIR
    plugins_mod.PLUGINS_DIR = tmp_path
    try:
        plugins_mod.load_plugins(app, context)
    finally:
        plugins_mod.PLUGINS_DIR = saved_dir

    assert sink, "the probe plugin's setup() never ran — the harness is not exercising the loader"
    seen = sink[0]

    assert seen["meta_db"] is sentinel_db, "meta_db must reach a real plugin BY IDENTITY"
    assert seen["extract_meta"] is sentinel_extract, (
        "extract_meta must reach a real plugin BY IDENTITY — wrapping it (partial, "
        "property, re-binding getter) breaks plugins that stored the reference at setup()"
    )
    assert seen["config_dir"] is context["config_dir"]

    # The loader adds these per-plugin; shipped plugins read both.
    assert callable(seen["load_sibling"])
    assert seen["log"].name == "feedBack.plugin.ctxprobe"

    # THE ONE DELIBERATE WRAPPER. register_library_provider is scoped per-plugin so a
    # plugin cannot forge owner attribution and impersonate another. Pinned so that the
    # single intentional exception to identity cannot quietly become two.
    assert seen["register_library_provider"] is not sentinel_register_library_provider, (
        "register_library_provider is supposed to be wrapped per-plugin for owner "
        "attribution — if that wrapper is gone, a plugin can impersonate another"
    )
