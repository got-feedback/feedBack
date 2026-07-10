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

# Config paths. server.py derives these from the environment (fresh on every
# import, so the ~49 pop-and-reimport fixtures keep working) and injects them
# here. Routers read them as `appstate.config_dir` etc. — a module attribute at
# call time. NOTE: config_dir/dlc_dir are env-derived, so a `setenv`+reimport
# test reconfigures them for free; STATIC_DIR/SLOPPAK_CACHE_DIR are patched via
# `setattr(server, …)` in a few tests, so those slots (when added) need their
# tests retargeted to appstate in the same PR.
config_dir = None

_SLOTS = frozenset({"meta_db", "audio_effect_mappings", "config_dir"})


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
