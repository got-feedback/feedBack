"""FastAPI route modules extracted from ``server.py`` (R3).

Each module here exposes a module-level ``router`` (a ``fastapi.APIRouter``)
that ``server.py`` mounts with ``app.include_router(...)`` at the point in the
file where those routes used to be defined — FastAPI matches routes in
registration order, so keeping the mount site preserves it.

**Routers must never ``import server``.** They reach core singletons through
the injected seam instead::

    import appstate

    @router.get("/api/thing")
    def get_thing():
        return appstate.meta_db.thing()

and always as a **module attribute, at call time** — never
``from appstate import meta_db``, which freezes the binding and defeats both a
later ``appstate.configure()`` and ``monkeypatch.setattr``. See ``appstate.py``.

Dependencies flow one way: ``server -> routers -> appstate``.

**Why this lives under ``lib/``.** ``lib/`` is the only core directory every
packaging path already copies wholesale — the Dockerfile (``COPY lib/``),
``docker-compose.yml``, and feedback-desktop's ``bundle-slopsmith.sh``
(``cp -r lib``) — and all three put it on ``sys.path``. A root-level package
ships in Docker but is silently dropped from the packaged desktop app, whose
bundler copies a hardcoded file list. Route modules import nothing at module
scope beyond FastAPI and ``appstate``, so they do no import-time IO and satisfy
Principle V's rule for ``lib/``.
"""
