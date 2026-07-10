"""The router seam (`appstate.py`).

The load-bearing assertion here is `test_server_wires_the_seam`: that `server`
actually calls `appstate.configure(...)`. Every other test in this file would
pass just fine against a seam nothing ever wires up — the same class of silent
no-op that bit the frontend refactor twice when a scripted `setHostHooks` edit
stopped matching its anchor. Unit tests cannot see wiring unless you make them
look at it.
"""

import importlib
import sys

import pytest

import appstate


def _close_server_dbs(mod):
    conn = getattr(getattr(mod, "meta_db", None), "conn", None)
    if conn is not None:
        getattr(mod, "_join_background_db_threads", lambda: None)()
        conn.close()
    ae_conn = getattr(getattr(mod, "audio_effect_mappings", None), "conn", None)
    if ae_conn is not None:
        ae_conn.close()


@pytest.fixture()
def isolated_server(tmp_path, monkeypatch):
    """A freshly imported `server` bound to a throwaway CONFIG_DIR.

    Importing `server` constructs `MetadataDB` + `AudioEffectsMappingDB` at
    module level, so it MUST be re-imported under a patched CONFIG_DIR — an
    unguarded `import server` would create/mutate the developer's real
    `~/.local/share/feedback` databases. Same idiom as the other ~49
    server-importing suites.

    Teardown restores the appstate slots as well as closing the connections:
    leaving `appstate.meta_db` published but pointing at a closed sqlite handle
    would hand a later test (or router) a live-looking, dead singleton.
    """
    previous = (appstate.meta_db, appstate.audio_effect_mappings)
    monkeypatch.setenv("CONFIG_DIR", str(tmp_path))
    sys.modules.pop("server", None)
    mod = importlib.import_module("server")
    yield mod
    _close_server_dbs(mod)
    # Leave no half-torn-down `server` behind: the next fixture re-imports it.
    sys.modules.pop("server", None)
    appstate.configure(meta_db=previous[0], audio_effect_mappings=previous[1])


def test_import_is_side_effect_free():
    """`import appstate` must construct nothing and touch no disk.

    This is why the ~49 fixtures that `sys.modules.pop("server")` and re-import
    (to rebuild `meta_db` under a patched CONFIG_DIR) keep working untouched:
    server owns construction, appstate only mirrors it. A singleton *owned*
    here would survive that pop and go stale.
    """
    sys.modules.pop("appstate", None)
    fresh = importlib.import_module("appstate")
    try:
        assert fresh.meta_db is None
        assert fresh.audio_effect_mappings is None
    finally:
        sys.modules["appstate"] = appstate


def test_configure_publishes_known_slots():
    sentinel = object()
    original = appstate.meta_db
    try:
        appstate.configure(meta_db=sentinel)
        assert appstate.meta_db is sentinel
    finally:
        appstate.configure(meta_db=original)


def test_configure_is_idempotent():
    """server re-imports call configure() again; the last write must win."""
    original = appstate.meta_db
    try:
        appstate.configure(meta_db="first")
        appstate.configure(meta_db="second")
        assert appstate.meta_db == "second"
    finally:
        appstate.configure(meta_db=original)


def test_configure_rejects_an_unknown_slot():
    """A typo'd or stale keyword must raise, not silently create a global that
    nothing reads. A seam whose wiring can no-op undetected is worse than none."""
    with pytest.raises(TypeError, match="unknown slot"):
        appstate.configure(met_db="typo")
    assert not hasattr(appstate, "met_db")


def test_late_bound_read_sees_a_later_configure():
    """Routers must read `appstate.meta_db`, never `from appstate import meta_db`.
    This pins the property that makes that rule work."""
    def router_style_read():
        return appstate.meta_db          # module attribute, resolved at call time

    original = appstate.meta_db
    try:
        appstate.configure(meta_db="before")
        assert router_style_read() == "before"
        appstate.configure(meta_db="after")
        assert router_style_read() == "after"
    finally:
        appstate.configure(meta_db=original)


def test_server_wires_the_seam(isolated_server):
    """The one that catches a dropped `appstate.configure(...)` call.

    Identity, not truthiness, so a stray re-assignment or a half-applied edit
    fails here rather than in some router months later.
    """
    assert appstate.meta_db is isolated_server.meta_db
    assert appstate.audio_effect_mappings is isolated_server.audio_effect_mappings
    assert appstate.meta_db is not None


def test_reimporting_server_republishes_the_fresh_singletons(
    isolated_server, tmp_path, monkeypatch
):
    """The 49-fixture contract, exercised end to end.

    Those fixtures `sys.modules.pop("server")` + re-import to rebuild `meta_db`
    under a new CONFIG_DIR, and know nothing about appstate. So the seam must
    re-publish on that second import. This is the test that would fail if
    `appstate` ever *owned* the singletons: a module-level `meta_db` there
    survives the pop and the assertions below would still see the FIRST DB.
    """
    first_db = isolated_server.meta_db
    assert appstate.meta_db is first_db
    assert str(tmp_path) in first_db.db_path

    second_config = tmp_path / "second"
    monkeypatch.setenv("CONFIG_DIR", str(second_config))
    sys.modules.pop("server", None)
    second_server = importlib.import_module("server")
    try:
        assert second_server.meta_db is not first_db          # genuinely rebuilt
        assert str(second_config) in second_server.meta_db.db_path
        assert appstate.meta_db is second_server.meta_db      # ...and re-published
        assert appstate.audio_effect_mappings is second_server.audio_effect_mappings
    finally:
        _close_server_dbs(second_server)
        sys.modules.pop("server", None)
