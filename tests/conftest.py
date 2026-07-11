"""Shared pytest fixtures for the feedBack test suite."""

import importlib
import logging
import sys

import pytest
import structlog


_LOGGING_NAMES = ("feedBack", "uvicorn", "uvicorn.error", "uvicorn.access")


@pytest.fixture(autouse=True)
def _reset_enrichment_state():
    """Reset the enrichment worker's process-global state between tests.

    The `server` fixtures pop-and-reimport `server`, but `lib/enrichment.py`
    (which now owns the worker) stays imported for the whole session, so its
    module globals — the cancel Event, the status dict, the caches — would
    otherwise leak across tests. A test that set `_enrich_cancel` (or a stale
    `running` status) could silently short-circuit a later direct
    `_background_enrich()` call. Clear it up front so each test starts clean.
    """
    try:
        import enrichment
    except ImportError:
        yield
        return
    enrichment._enrich_cancel.clear()
    enrichment._enrich_pending_pass = False
    enrichment._enrich_status.update(
        {"running": False, "processed": 0, "last_pass_at": None,
         "total": 0, "matched": 0, "current": None})
    enrichment._enrich_last_fetch = 0.0
    enrichment._artist_alias_cache.clear()
    # _caa_index_locks is deliberately left alone: it's guarded by
    # _caa_index_locks_guard, so clearing it here (unlocked) would race a
    # still-alive worker thread, and its entries are stateless per-release
    # mutexes that don't leak test state anyway.
    yield


@pytest.fixture()
def isolate_logging():
    """Restore feedBack / uvicorn logger state after each test.

    Saves handlers, level, and propagate flag before the test runs and
    restores all three on teardown.  Import into any test module that calls
    configure_logging() so mutations don't bleed across tests.
    """
    saved = {}
    for name in _LOGGING_NAMES:
        lg = logging.getLogger(name)
        saved[name] = (
            list(lg.handlers),  # snapshot the handler list
            lg.level,
            lg.propagate,
        )
    yield
    for name in _LOGGING_NAMES:
        lg = logging.getLogger(name)
        original_handlers, original_level, original_propagate = saved[name]

        # Close and remove any handlers that were added during the test.
        for h in list(lg.handlers):
            if h not in original_handlers:
                lg.removeHandler(h)
                h.close()
        # Remove any original handlers that may have been removed during the test
        # so we can add them back cleanly.
        for h in list(lg.handlers):
            lg.removeHandler(h)
        # Reattach the original handlers.
        for h in original_handlers:
            lg.addHandler(h)

        lg.setLevel(original_level)
        lg.propagate = original_propagate
    structlog.reset_defaults()


# ── Plugin-loader isolation ─────────────────────────────────────────────────────
#
# Lifted verbatim out of tests/test_plugins.py so more than one test module can drive
# the real plugins.load_plugins(). It has to be ONE fixture, not a copy per file:
# load_plugins() mutates sys.path, sys.modules, PENDING_PLUGINS and LOADED_PLUGINS, and a
# partial restore makes the suite order- and environment-dependent (Codex [P2] on
# test_plugin_context_contract.py — it was right).

# Bare module names that this test module pre-populates into
# sys.modules to simulate the bare-import path. Saved/restored by
# the reset_plugin_state fixture so they don't leak to other test
# files. Codex / Copilot review on PR for feedBack#33.
_BARE_NAMES_USED = ("util", "extractor")


@pytest.fixture()
def reset_plugin_state(monkeypatch):
    """Clear loader module-level state and restore on teardown.

    Saves and restores:
      * `plugins.LOADED_PLUGINS`
      * any `plugin_*` keys we add to `sys.modules`
      * the bare names this module simulates (`util`, `extractor`)
      * `sys.path` — `plugins.load_plugins()` mutates it
    Also unsets `FEEDBACK_PLUGINS_DIR` for the test's duration
    (via monkeypatch) so a CI env that pre-sets it can't leak
    real user plugins into a tmp_path-driven test. Per-module
    locks are owned by the standard import system
    (`importlib._bootstrap._module_locks`) and are not our
    responsibility to reset.
    """
    monkeypatch.delenv("FEEDBACK_PLUGINS_DIR", raising=False)
    plugins = importlib.import_module("plugins")
    saved_loaded = list(plugins.LOADED_PLUGINS)
    saved_pending = dict(plugins.PENDING_PLUGINS)
    saved_modules = {k: v for k, v in sys.modules.items() if k.startswith("plugin_")}
    saved_bare = {k: sys.modules[k] for k in _BARE_NAMES_USED if k in sys.modules}
    saved_path = list(sys.path)
    plugins.LOADED_PLUGINS.clear()
    plugins.PENDING_PLUGINS.clear()
    for k in list(sys.modules):
        if k.startswith("plugin_") or k in _BARE_NAMES_USED:
            del sys.modules[k]
    try:
        yield plugins
    finally:
        plugins.LOADED_PLUGINS.clear()
        plugins.LOADED_PLUGINS.extend(saved_loaded)
        plugins.PENDING_PLUGINS.clear()
        plugins.PENDING_PLUGINS.update(saved_pending)
        for k in list(sys.modules):
            if k.startswith("plugin_") or k in _BARE_NAMES_USED:
                del sys.modules[k]
        sys.modules.update(saved_modules)
        sys.modules.update(saved_bare)
        sys.path[:] = saved_path
