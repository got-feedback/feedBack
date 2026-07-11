"""Shared application state — the seam that lets route modules reach core
singletons without importing ``server``.

``server.py`` is the host: it owns the FastAPI ``app``, constructs the DB
singletons, and runs the lifecycle. As routes move out into ``routers/`` (R3),
those modules need ``meta_db`` and friends — but they must not ``import
server``, or the import graph goes circular the moment ``server`` imports them
back.

So ``server`` **injects** its singletons here once, at the point it builds them::

    # server.py
    meta_db = MetadataDB(CONFIG_DIR)
    appstate.configure(meta_db=meta_db, ...)

and a router reads them back as **module attributes, at call time**::

    # routers/artists.py
    import appstate

    @router.get("/api/artist/{name}/page")
    def artist_page(name):
        return appstate.meta_db.artist_page(name)

This is the Python analogue of the injected `configureX({...})` seams the
frontend refactor uses (stems' ``configureStreaming``, studio's
``configureAudioGraph``, the editor's ``src/host.js``), and of the plugin
``setup(app, context)`` contract in Principle III: dependencies flow one way,
``server -> routers -> appstate``, and nothing imports back up.

Two properties this shape buys, both load-bearing:

* **``import appstate`` performs no IO and constructs nothing.** ``server``
  still owns construction, so the ~49 test fixtures that do
  ``sys.modules.pop("server")`` + re-import (to rebuild ``meta_db`` under a
  patched ``CONFIG_DIR``) keep working untouched — a singleton *owned* here
  would survive that pop and go stale.
* **Reads are late-bound.** Routers must use ``appstate.meta_db``, never
  ``from appstate import meta_db`` — a ``from`` import freezes the binding at
  its current value, so a later ``configure()`` (or a
  ``monkeypatch.setattr(appstate, "meta_db", fake)``) would not reach the
  router. This is the same read-only-binding trap as ES ``import``.

Defaults are ``None`` on purpose: they are inert but *type-honest*, so a router
that runs before ``configure()`` fails loudly on ``NoneType`` instead of
quietly operating on a stand-in.

Slots are added here only when a router actually needs one — this is a seam,
not a grab-bag for everything in ``server.py``.

**Why this lives in ``lib/`` and not the repo root.** Because it constructs
nothing and does no import-time IO, it satisfies Principle V's rule for ``lib/``
modules — and ``lib/`` is the only core directory every packaging path already
copies: the Dockerfile (``COPY lib/``), ``docker-compose.yml``, and
feedback-desktop's ``bundle-slopsmith.sh`` (``cp -r lib``). All three also put
both the bundle root and ``lib/`` on ``sys.path``. A root-level module ships in
Docker but is silently dropped from the packaged desktop app, whose bundler
copies a hardcoded file list — that regression is what moved this file here.
"""

# The singletons routers may read. Every name here must also be a `_SLOTS` key.
meta_db = None
audio_effect_mappings = None
# The tuning-provider registry instance (built-ins + plugin-contributed). A
# stable object mutated in place via register()/unregister() — injected here by
# reference so routers read the same registry plugins populate.
tuning_providers = None

# Config paths. server.py derives these from the environment (fresh on every
# import, so the ~49 pop-and-reimport fixtures keep working) and injects them
# here. Routers read them as `appstate.config_dir` etc. — a module attribute at
# call time. NOTE: config_dir/dlc_dir are env-derived, so a `setenv`+reimport
# test reconfigures them for free; STATIC_DIR/SLOPPAK_CACHE_DIR are patched via
# `setattr(server, …)` in a few tests, so those slots (when added) need their
# tests retargeted to appstate in the same PR.
config_dir = None
dlc_dir = None          # the DLC_DIR env value as a Path (Path("") if unset)
dlc_dir_env = None      # the raw DLC_DIR env string, "" if unset — distinguishes
                        # "unset" from Path("")→"." (see dlc_paths._get_dlc_dir)
# Cache/asset dirs. static_dir + sloppak_cache_dir are patched via
# `setattr(server, …)` in a few tests, so a router reading them here needs those
# setattr sites retargeted to `setattr(appstate, …)` in the same PR (ws_highway
# retargets the 3 test_highway_ws_* SLOPPAK sites). config_dir-derived dirs are
# reconfigured for free on a setenv+reimport.
static_dir = None
sloppak_cache_dir = None
audio_cache_dir = None

# Injected callables (not values): server owns the impl + its state, routers call
# through the seam. get_progression_content wraps a lazy content cache that stays
# in server.py (its `setattr(server, "_progression_content")` test is untouched).
get_progression_content = None
builtin_diagnostic_filename = None
running_version = None
# Art helpers that stay in server.py (shared with the art/delete routes) but are
# also called by the enrichment worker in lib/enrichment.py — injected as
# callables to keep enrichment acyclic. art_cache_dir is server's ART_CACHE_DIR.
art_cache_dir = None
song_pack_art_exists = None
art_override_paths = None
art_safe_name = None

_SLOTS = frozenset({
    "meta_db", "audio_effect_mappings", "tuning_providers",
    "config_dir", "dlc_dir", "dlc_dir_env",
    "static_dir", "sloppak_cache_dir", "audio_cache_dir",
    "get_progression_content", "builtin_diagnostic_filename",
    "running_version",
    "art_cache_dir", "song_pack_art_exists", "art_override_paths", "art_safe_name",
})


def configure(**kwargs) -> None:
    """Publish `server`'s singletons into this module. Called once per
    `server` import (and again on re-import), so it must be idempotent."""
    unknown = set(kwargs) - _SLOTS
    if unknown:
        raise TypeError(
            f"appstate.configure() got unknown slot(s): {sorted(unknown)}. "
            f"Known slots: {sorted(_SLOTS)}. Add the name to _SLOTS if a router "
            f"genuinely needs it."
        )
    globals().update(kwargs)
