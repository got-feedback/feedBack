"""Demo mode: the read-only request guard and the hourly session janitor.

Carved VERBATIM out of server.py (R3b). Bodies are byte-identical — including a bug, see
below.

━━━ THE MIDDLEWARE NEEDS `app`, SO THIS MODULE TAKES IT ━━━

`_demo_mode_guard` is an @app.middleware("http"), and a middleware has to be attached to an
app object. Rather than reach for a global, this module exposes install(app): server.py
owns the app and hands it over. Same direction as every other seam here — server.py knows
things lib/ must not have to guess.

The janitor is symmetrical: start_janitor() / stop_janitor(), called from server.py's
startup and shutdown hooks, which is where the process lifecycle actually lives.

━━━ register_demo_janitor_hook IS PART OF THE PLUGIN CONTRACT ━━━

It is a key in plugin_context, so plugins hold it as a LIVE REFERENCE from setup(). Moving
the function is fine; wrapping or renaming it is not. server.py imports this exact object
and puts it in the dict unchanged, so callable identity is preserved —
tests/test_plugin_context_contract.py (#898) fails if that ever stops being true.

━━━ A BUG MOVED VERBATIM, ON PURPOSE ━━━

The janitor start guard in server.py reads:

    if getenv_compat("FEEDBACK_DEMO_MODE") or getenv_compat("FEEDBACK_DEMO_MODE") == "1" \
            and not _DEMO_JANITOR_STARTED:

`and` binds tighter than `or`, so that is `A or (B and C)` — the `not _DEMO_JANITOR_STARTED`
re-entry guard is DEAD whenever the env var is truthy, which is the only case that runs. A
second startup leaks a janitor thread (the handle is overwritten, so shutdown joins only
the last). Preserved exactly as-is here and filed as issue #902: a carve whose value is
being provably behaviour-neutral is not the place to change behaviour.
"""
import inspect
import logging
import re
import threading
import uuid
import warnings

from fastapi import Request
from fastapi.responses import JSONResponse
from env_compat import getenv_compat

log = logging.getLogger("feedBack.demo_mode")


# Plugins that maintain session stores can register a cleanup callback here.
# The demo-mode janitor calls every registered hook once per hour so stale
# sessions are swept without the core needing to know plugin internals.
_DEMO_JANITOR_HOOKS: list = []


_DEMO_JANITOR_HOOKS_LOCK = threading.Lock()


_DEMO_JANITOR_STARTED = False


_DEMO_JANITOR_STOP = threading.Event()


_DEMO_JANITOR_THREAD: threading.Thread | None = None


def register_demo_janitor_hook(fn) -> None:
    """Register a zero-argument callable to be invoked hourly by the demo
    janitor.  Plugins call this from their ``setup(app, context)`` when they
    want to participate in session cleanup under demo mode.

    The callable must accept no required arguments.  Async (coroutine)
    functions are rejected: the janitor runs in a plain thread and cannot
    await coroutines.
    """
    if not callable(fn):
        raise TypeError(
            f"register_demo_janitor_hook expects a callable, got {type(fn).__name__!r}"
        )
    # Reject coroutine functions — check both the callable itself and its
    # __call__ method so objects with an async __call__ (e.g. class instances,
    # functools.partial wrappers around async functions) are also caught.
    _call = getattr(fn, "__call__", None)
    if inspect.iscoroutinefunction(fn) or (
        _call is not None and inspect.iscoroutinefunction(_call)
    ):
        raise TypeError(
            "register_demo_janitor_hook does not accept async functions; "
            "the janitor runs in a plain thread and cannot await coroutines"
        )
    # Validate that the callable accepts zero required arguments so it won't
    # crash at sweep time (hourly, far from the registration site).
    try:
        sig = inspect.signature(fn)
    except ValueError:
        # inspect.signature() raises ValueError for built-in C callables whose
        # signature cannot be determined.  Accept them as-is; if they fail at
        # runtime the janitor will catch and log the exception.
        pass
    else:
        required = [
            p for p in sig.parameters.values()
            if p.default is inspect.Parameter.empty
            and p.kind not in (
                inspect.Parameter.VAR_POSITIONAL,
                inspect.Parameter.VAR_KEYWORD,
            )
        ]
        if required:
            raise TypeError(
                f"register_demo_janitor_hook expects a zero-argument callable; "
                f"{fn!r} has {len(required)} required parameter(s): "
                + ", ".join(p.name for p in required)
            )
    with _DEMO_JANITOR_HOOKS_LOCK:
        _DEMO_JANITOR_HOOKS.append(fn)


def _run_janitor_hook(hook) -> None:
    """Run a single janitor hook inline, swallowing and logging any exception.

    If the hook returns an awaitable (e.g. a coroutine slipped through the
    async-function guard), the coroutine is closed immediately to avoid
    ``RuntimeWarning: coroutine was never awaited`` noise, and a warning is
    emitted so the plugin author knows to fix their hook.
    """
    try:
        result = hook()
    except Exception:
        log.exception("janitor hook %r raised", hook)
        return
    if inspect.iscoroutine(result):
        # A coroutine slipped through the async-function guard (e.g. via a
        # wrapper/partial).  Close it to suppress "coroutine never awaited",
        # then warn so the plugin author knows to fix their hook.
        try:
            result.close()
        except Exception:
            log.exception("error closing coroutine from janitor hook %r", hook)
        warnings.warn(
            f"janitor hook {hook!r} returned a coroutine; "
            "hooks must be plain synchronous callables — "
            "register_demo_janitor_hook does not accept async functions",
            RuntimeWarning,
            stacklevel=1,
        )
    elif inspect.isawaitable(result):
        # Future/Task: no .close() method; just warn and leave it alone.
        warnings.warn(
            f"janitor hook {hook!r} returned an awaitable (Future/Task); "
            "hooks must be plain synchronous callables",
            RuntimeWarning,
            stacklevel=1,
        )


_DEMO_BLOCKED: list[tuple[str, re.Pattern]] = [
    ("POST",   re.compile(r"^/api/settings$")),
    ("POST",   re.compile(r"^/api/settings/import$")),
    ("POST",   re.compile(r"^/api/settings/reset$")),
    ("POST",   re.compile(r"^/api/rescan$")),
    ("POST",   re.compile(r"^/api/rescan/full$")),
    ("POST",   re.compile(r"^/api/songs/upload$")),
    ("DELETE", re.compile(r"^/api/song/.+$")),
    ("POST",   re.compile(r"^/api/favorites/toggle$")),
    ("POST",   re.compile(r"^/api/loops$")),
    ("DELETE", re.compile(r"^/api/loops/[^/]+$")),
    ("POST",   re.compile(r"^/api/audio-effects/mappings$")),
    ("DELETE", re.compile(r"^/api/audio-effects/mappings/[^/]+$")),
    ("POST",   re.compile(r"^/api/audio-effects/mappings/[^/]+/activate$")),
    ("DELETE", re.compile(r"^/api/audio-effects/active-mapping$")),
    ("POST",   re.compile(r"^/api/song/.*/meta$")),
    ("POST",   re.compile(r"^/api/song/.*/art/upload$")),
    ("PUT",    re.compile(r"^/api/song/.+/overrides$")),
    ("GET",    re.compile(r"^/api/plugins/updates$")),
    ("POST",   re.compile(r"^/api/plugins/[^/]+/update$")),
    ("POST",   re.compile(r"^/api/plugins/editor/save$")),
    ("POST",   re.compile(r"^/api/plugins/editor/build$")),
    ("POST",   re.compile(r"^/api/plugins/editor/upload-art$")),
    ("POST",   re.compile(r"^/api/plugins/editor/upload-audio$")),
    ("POST",   re.compile(r"^/api/plugins/editor/youtube-audio$")),
    ("POST",   re.compile(r"^/api/plugins/editor/import-gp$")),
    ("POST",   re.compile(r"^/api/plugins/editor/import-midi$")),
    ("POST",   re.compile(r"^/api/plugins/lyrics_karaoke/align$")),
    ("POST",   re.compile(r"^/api/plugins/lyrics_karaoke/generate-pitch$")),
    ("POST",   re.compile(r"^/api/plugins/lyrics_karaoke/save-lyrics$")),
    ("POST",   re.compile(r"^/api/plugins/lyrics_sync/align$")),
    ("POST",   re.compile(r"^/api/plugins/lyrics_sync/save$")),
    ("POST",   re.compile(r"^/api/plugins/studio/sessions/[^/]+/extract-drums$")),
    ("POST",   re.compile(r"^/api/diagnostics/export$")),
    ("GET",    re.compile(r"^/api/diagnostics/preview$")),
    ("GET",    re.compile(r"^/api/diagnostics/hardware$")),
    # Bundled core plugin — video background upload/delete
    ("POST",   re.compile(r"^/api/plugins/highway_3d/files$")),
    ("DELETE", re.compile(r"^/api/plugins/highway_3d/files$")),
    # fee[dB]ack v0.3.0 write endpoints — demo mode is read-only, so block the
    # new profile / XP / stats / playlists / saved mutators too.
    ("POST",   re.compile(r"^/api/profile$")),
    ("POST",   re.compile(r"^/api/profile/avatar$")),
    ("POST",   re.compile(r"^/api/xp/award$")),
    ("POST",   re.compile(r"^/api/stats$")),
    ("POST",   re.compile(r"^/api/playlists$")),
    ("PATCH",  re.compile(r"^/api/playlists/[^/]+$")),
    ("DELETE", re.compile(r"^/api/playlists/[^/]+$")),
    ("POST",   re.compile(r"^/api/playlists/[^/]+/songs$")),
    ("DELETE", re.compile(r"^/api/playlists/[^/]+/songs/.+$")),
    ("POST",   re.compile(r"^/api/playlists/[^/]+/reorder$")),
    ("POST",   re.compile(r"^/api/playlists/[^/]+/cover$")),
    ("DELETE", re.compile(r"^/api/playlists/[^/]+/cover$")),
    ("POST",   re.compile(r"^/api/saved/toggle$")),
    # Progression (spec 010) write endpoints — demo mode stays read-only.
    ("POST",   re.compile(r"^/api/progression/paths$")),
    ("POST",   re.compile(r"^/api/progression/onboarding$")),
    ("POST",   re.compile(r"^/api/progression/events$")),
    ("POST",   re.compile(r"^/api/shop/buy$")),
    ("POST",   re.compile(r"^/api/shop/equip$")),
    # Enrichment (P8): review writes mutate the local match cache, and the
    # search proxy / manual kick relay to MusicBrainz — none of it belongs to
    # anonymous demo visitors (they'd spend the shared rate limit).
    ("POST",   re.compile(r"^/api/enrichment/review/.+$")),
    ("POST",   re.compile(r"^/api/enrichment/kick$")),
    ("POST",   re.compile(r"^/api/enrichment/cancel$")),
    ("POST",   re.compile(r"^/api/enrichment/rematch$")),
    ("GET",    re.compile(r"^/api/enrichment/search$")),
    # AcoustID audio fingerprinting: both identify endpoints run fpcalc (CPU)
    # and spend the shared AcoustID rate budget on the caller's behalf — same
    # rule as the search/kick relays above; not for anonymous demo visitors.
    ("POST",   re.compile(r"^/api/enrichment/identify$")),
    ("POST",   re.compile(r"^/api/enrichment/identify/.+$")),
    # Context menus (R2): the per-song re-match mutates the cache + spends
    # rate limit; Get-info exposes filesystem paths.
    ("POST",   re.compile(r"^/api/enrichment/refresh/.+$")),
    ("GET",    re.compile(r"^/api/chart/.+/fileinfo$")),
    # Gap-fill (R4a) rewrites pack files on disk — never for demo visitors.
    ("POST",   re.compile(r"^/api/song/.+/gap-fill$")),
    # Art layer (R3): all three mutate server state / touch the network on a
    # visitor's behalf — the base64 upload writes files, the URL fetch makes the
    # server request arbitrary images, and the override delete removes files.
    ("POST",   re.compile(r"^/api/song/.+/art/upload$")),
    ("POST",   re.compile(r"^/api/song/.+/art/url$")),
    ("DELETE", re.compile(r"^/api/art/.+/override$")),
    # Cover picker (PR-C): read-only, but a cache-miss open spends 1-3
    # throttled Cover Art Archive calls — anonymous demo visitors don't get
    # to spend the shared rate budget (same rule as enrichment search/kick).
    ("GET",    re.compile(r"^/api/song/.+/art/candidates$")),
    # Artist pages (PR-B): the links GET lazily fetches from MusicBrainz on a
    # visitor's behalf AND writes the artist_enrichment cache; refresh
    # re-spends the shared rate limit. The /page route stays open (all-local
    # read). Same rationale as /api/enrichment/search above.
    ("GET",    re.compile(r"^/api/artist/.+/links$")),
    ("POST",   re.compile(r"^/api/artist/.+/links/refresh$")),
]


async def _demo_mode_guard(request: Request, call_next):
    if getenv_compat("FEEDBACK_DEMO_MODE") or getenv_compat("FEEDBACK_DEMO_MODE") == "1":
        path = request.url.path
        for method, pattern in _DEMO_BLOCKED:
            if request.method == method and pattern.match(path):
                return JSONResponse({"error": "demo mode: read-only"}, status_code=403)
        response = await call_next(request)
        if request.method == "GET" and path == "/" and "feedBack_demo_session" not in request.cookies:
            forwarded_proto = (request.headers.get("x-forwarded-proto") or "").split(",")[0].strip()
            is_secure = request.url.scheme == "https" or forwarded_proto.lower() == "https"
            response.set_cookie(
                "feedBack_demo_session", str(uuid.uuid4()),
                max_age=86400, httponly=True, samesite="lax",
                secure=is_secure,
            )
        return response
    return await call_next(request)


def install(app) -> None:
    """Attach the demo-mode request guard to `app`.

    Called by server.py, which owns the app. A middleware cannot exist without one, and a
    module under lib/ should not be reaching for a global to find it.
    """
    app.middleware("http")(_demo_mode_guard)


def demo_mode_enabled() -> bool:
    """True when demo mode is on. Read at CALL time, never captured — tests set and unset
    FEEDBACK_DEMO_MODE with monkeypatch, so a value cached at import pins the wrong one."""
    return bool(getenv_compat("FEEDBACK_DEMO_MODE"))


def start_janitor() -> None:
    """Start the hourly session janitor. Called from server.py's startup hook.

    NB the caller's guard is the buggy one described in this module's header (issue #902).
    Behaviour is preserved verbatim: this starts a thread every time it is called.
    """
    global _DEMO_JANITOR_STARTED, _DEMO_JANITOR_THREAD
    _DEMO_JANITOR_STARTED = True
    _DEMO_JANITOR_STOP.clear()

    def _janitor():
        while not _DEMO_JANITOR_STOP.wait(timeout=3600):
            with _DEMO_JANITOR_HOOKS_LOCK:
                hooks = list(_DEMO_JANITOR_HOOKS)
            for hook in hooks:
                _run_janitor_hook(hook)

    _DEMO_JANITOR_THREAD = threading.Thread(target=_janitor, daemon=True, name="demo-janitor")
    _DEMO_JANITOR_THREAD.start()


def janitor_started() -> bool:
    return _DEMO_JANITOR_STARTED


def stop_janitor(timeout: float = 5) -> bool:
    """Signal the janitor to stop, join it, and drop the registered hooks.

    Returns True if it stopped, False if it outlived the join (the caller warns).

    THE ORDER HERE IS LOAD-BEARING and preserved exactly from server.py. When the thread
    does NOT die within the timeout we return WITHOUT clearing _DEMO_JANITOR_STARTED and
    WITHOUT dropping the thread handle — deliberately — so a subsequent startup does not
    spawn a SECOND janitor alongside the one still running. Clearing the flag first (the
    obvious way to write this) would quietly reintroduce exactly the double-janitor leak
    the flag exists to prevent.
    """
    global _DEMO_JANITOR_STARTED, _DEMO_JANITOR_THREAD
    if not _DEMO_JANITOR_STARTED:
        return True
    _DEMO_JANITOR_STOP.set()
    thread = _DEMO_JANITOR_THREAD
    if thread is not None:
        thread.join(timeout=timeout)
        if thread.is_alive():
            # Leave _DEMO_JANITOR_STARTED True so a new janitor is not spawned by a
            # subsequent startup while the old one is alive.
            return False
        _DEMO_JANITOR_THREAD = None
    _DEMO_JANITOR_STARTED = False
    with _DEMO_JANITOR_HOOKS_LOCK:
        _DEMO_JANITOR_HOOKS.clear()
    return True
