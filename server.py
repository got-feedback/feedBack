"""FeedBack — FastAPI backend serving highway viewer + library."""

import asyncio
import json
import logging
import os
import secrets
import stat
import sys
import tempfile
import shutil
from pathlib import Path
from typing import ClassVar

from logging_setup import configure_logging
from env_compat import getenv_compat
configure_logging()

log = logging.getLogger("feedBack.server")

from fastapi import FastAPI, File
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse, JSONResponse, StreamingResponse

from safepath import safe_join
from appconfig import _load_config
from tunings import (
    DEFAULT_REFERENCE_PITCH, DEFAULT_TUNINGS,
    apply_reference_pitch, tuning_name,
)
# The library metadata cache. `MetadataDB` and the query helpers it owns live in
# their own module; the `meta_db` singleton below stays here. The private names
# are re-imported because callers outside the DB layer still use them.
from metadata_db import MetadataDB
# The audio-effect routing index. Same shape as metadata_db: the class lives in
# its own module, the `audio_effect_mappings` singleton below stays here.
from audio_effects_db import AudioEffectsMappingDB
from library_registry import (  # registry classes + collection lifecycle moved to lib (R3)
    LibraryProviderRegistry, LocalLibraryProvider,
    _sync_collection_provider,
)
from dlc_paths import _get_dlc_dir, _resolve_dlc_path
# The router seam. Imported as a module (never `from appstate import ...`) so
# `appstate.configure(...)` below publishes into the same namespace routers read.
# Lives in lib/ because that is the one core dir every packaging path copies.
import appstate
import builtin_content
import scan
# Extracted route modules. They import `appstate`, never `server` — one-way graph.
from routers import audio_effects, artist_aliases, loops, playlists, ws_highway, chart, wanted, library_extras, shop, progression, profile, stats, version, diagnostics
from routers import tunings as tunings_router
import enrichment
from routers import art as art_router
from routers import settings as settings_router
from routers import song as song_router
from routers import library as library_router
from routers import enrichment as enrichment_routes
from routers import media as media_router
from routers import artist as artist_router
import sloppak as sloppak_mod
import loosefolder as loosefolder_mod
# Pure text-matching engine for MusicBrainz enrichment (P8): denoise/score/
# tier classification + response parsing. No network/DB in there — the
# throttled transport and the song_enrichment writes live in this module.
# Metadata extraction lives in a side-effect-free module so ProcessPool
# scan workers can import + unpickle _scan_one without re-running this
# module's import-time side effects (see lib/scan_worker.py).
from scan_worker import _extract_meta_for_file, _relpath, _scan_one

import concurrent.futures
import inspect
import multiprocessing
import re
import threading
import time
import uuid
import warnings
import xml.etree.ElementTree as ET

from fastapi import Request

app = FastAPI(title="FeedBack")

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


@app.middleware("http")
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

from asgi_correlation_id import CorrelationIdMiddleware

# validator=None accepts any non-empty inbound X-Request-ID value, including
# opaque proxy-generated hex strings, not just RFC-4122 UUIDs.
app.add_middleware(CorrelationIdMiddleware, validator=None)

STATIC_DIR = Path(__file__).parent / "static"
try:
    STATIC_DIR.mkdir(exist_ok=True)
except OSError:
    pass  # Read-only in packaged installs

# Distinguish "env not set / empty" from "explicitly set". Path("") collapses
# to Path(".") so we can't recover that signal after the cast — capture the
# raw env-var string up front and let _get_dlc_dir() consult both. This way
# `DLC_DIR=.` remains a valid opt-in for cwd while `DLC_DIR=""` (or unset)
# falls through to the config.json fallback.
_DLC_DIR_ENV = os.environ.get("DLC_DIR", "").strip()
DLC_DIR = Path(_DLC_DIR_ENV) if _DLC_DIR_ENV else Path("")
CONFIG_DIR = Path(os.environ.get("CONFIG_DIR", str(Path.home() / ".local" / "share" / "feedback")))

# Writable cache directories (use CONFIG_DIR, not STATIC_DIR which may be read-only)
ART_CACHE_DIR = CONFIG_DIR / "art_cache"
AUDIO_CACHE_DIR = CONFIG_DIR / "audio_cache"
SLOPPAK_CACHE_DIR = CONFIG_DIR / "sloppak_cache"


def _env_flag(name: str) -> bool:
    """Parse a conventional boolean env flag (honours legacy SLOPSMITH_* alias)."""
    return (getenv_compat(name, "") or "").strip().lower() in {"1", "true", "yes", "on"}




meta_db = MetadataDB(CONFIG_DIR)
audio_effect_mappings = AudioEffectsMappingDB(CONFIG_DIR)

# Publish the singletons to the router seam. server.py stays their owner — a
# `sys.modules.pop("server")` + re-import must keep rebuilding them under a
# patched CONFIG_DIR — and `routers/` read them back as `appstate.<name>` at
# call time. See appstate.py for why the reads must be late-bound.
appstate.configure(
    meta_db=meta_db,
    audio_effect_mappings=audio_effect_mappings,
    config_dir=CONFIG_DIR,
    dlc_dir=DLC_DIR,
    dlc_dir_env=_DLC_DIR_ENV,
    static_dir=STATIC_DIR,
    sloppak_cache_dir=SLOPPAK_CACHE_DIR,
    audio_cache_dir=AUDIO_CACHE_DIR,
)






library_providers = LibraryProviderRegistry()
_local_library_provider = LocalLibraryProvider(meta_db)
library_providers.register(_local_library_provider)
# Publish the registry + local provider to the seam for routers/library.py. The
# registry stays server-owned (plugins register through plugin_context, and the
# pop-and-reimport fixtures rebuild it under a fresh meta_db).
appstate.configure(
    library_providers=library_providers,
    local_library_provider=_local_library_provider,
)








# ── Library + collections routes → routers/library.py (R3) ──────────────────
app.include_router(library_router.router)




# Boot scan: surface every saved collection as a source.
for _c in meta_db.list_collections():
    _sync_collection_provider(_c)


def register_library_provider(provider: object, *, replace: bool = False, owner_plugin_id: str | None = None) -> object:
    return library_providers.register(provider, replace=replace, owner_plugin_id=owner_plugin_id)


def unregister_library_provider(provider_id: str) -> bool:
    return library_providers.unregister(provider_id)


class TuningProviderRegistry:
    """Registry for plugins that contribute custom tunings to the core tuning.read capability."""

    _ID_RE: ClassVar[re.Pattern[str]] = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$")

    def __init__(self) -> None:
        self._providers: dict[str, callable] = {}
        self._lock = threading.Lock()

    def register(self, provider_id: str, get_tunings: callable) -> None:
        if not self._ID_RE.match(provider_id):
            raise ValueError(f"tuning provider id {provider_id!r} contains invalid characters")
        if not callable(get_tunings):
            raise TypeError("get_tunings must be callable")
        with self._lock:
            self._providers[provider_id] = get_tunings

    def unregister(self, provider_id: str) -> None:
        with self._lock:
            self._providers.pop(provider_id, None)

    def get_merged(self, reference_pitch: float = DEFAULT_REFERENCE_PITCH) -> dict:
        """DEFAULT_TUNINGS scaled to reference_pitch, merged with all provider contributions."""
        result: dict[str, dict[str, list[float]]] = apply_reference_pitch(DEFAULT_TUNINGS, reference_pitch)
        scale = reference_pitch / DEFAULT_REFERENCE_PITCH
        with self._lock:
            providers = list(self._providers.items())
        for provider_id, get_tunings in providers:
            try:
                extra = get_tunings() or {}
                for instrument, names in extra.items():
                    if instrument not in result:
                        result[instrument] = {}
                    for name, freqs in names.items():
                        result[instrument][name] = [round(f * scale, 4) for f in freqs]
            except Exception:
                logger.exception("tuning provider %r raised during get_merged()", provider_id)
        return result


tuning_providers = TuningProviderRegistry()


def register_tuning_provider(provider_id: str, get_tunings: callable) -> None:
    tuning_providers.register(provider_id, get_tunings)


def unregister_tuning_provider(provider_id: str) -> None:
    tuning_providers.unregister(provider_id)





















# ── Background metadata scan ──────────────────────────────────────────────────





def _stat_for_cache(f: Path) -> tuple[float, int]:
    """Return (mtime, size) for cache freshness checks.

    For loose-folder directories the directory's own mtime does not
    change when inner files (audio.wem / *.xml / manifest.json) are
    edited in place, so we aggregate over the contents. archives and
    sloppak files (zip form) use their own stat directly. Sloppak
    *directories* are aggregated too: the editor and the library Edit
    button rewrite their `manifest.yaml` / `arrangements/*.json` in
    place, which does NOT bump the directory's own mtime/size — so
    keying the cache on the bare directory stat would make metadata
    edits invisible to a rescan.
    """
    # Aggregate inner stats for loose folders. We detect "loose-shape"
    # purely by file presence (xml + wem + optional manifest.json) so
    # this stays O(stat) on the hot path — `/api/song/{filename}` and
    # the background scan call this on every check, and we avoid
    # calling `is_loose_song` here because that would parse XML on
    # every cache lookup.
    if f.is_dir():
        # Skip symlinks pointing outside the song folder — without this
        # an attacker-crafted custom song could keep a stale cache hot by
        # bumping the mtime of an unrelated file via a symlink.
        root = f.resolve()
        def _in_folder(p: Path) -> bool:
            try:
                p.resolve().relative_to(root)
            except (OSError, ValueError):
                return False
            return True
        xmls = [p for p in f.glob("*.xml") if _in_folder(p)]
        wems = [p for p in f.glob("*.wem") if _in_folder(p)]
        inner: list[Path] = []
        if xmls and wems:
            inner = xmls + wems + [p for p in f.glob("manifest.json") if _in_folder(p)]
        else:
            # Sloppak directory: aggregate over the files that an in-place
            # metadata/arrangement edit actually touches. Stems (ogg) are
            # deliberately excluded — they don't change on a metadata edit and
            # stat-ing them on every cache lookup would be wasteful; a stem
            # add/remove rewrites manifest.yaml, which IS covered here.
            man = [
                p for p in (f / "manifest.yaml", f / "manifest.yml")
                if p.exists() and _in_folder(p)
            ]
            if man:
                inner = man
                inner += [p for p in f.glob("arrangements/*.json") if _in_folder(p)]
                inner += [p for p in f.glob("drum_tab.json") if _in_folder(p)]
        if inner:
            # Tolerate files vanishing between glob() and stat() —
            # otherwise a concurrent edit/move in DLC_DIR can let an
            # OSError bubble out of scan.background_scan(), killing the
            # scan thread while `scan.status()["running"]` stays true.
            stats = []
            for p in inner:
                try:
                    stats.append(p.stat())
                except OSError:
                    continue
            if stats:
                return max(s.st_mtime for s in stats), sum(s.st_size for s in stats)
    st = f.stat()
    return st.st_mtime, st.st_size



_STARTUP_STATUS_INIT = {
    "running": True,
    "phase": "booting",
    "message": "Starting FeedBack server...",
    "current_plugin": "",
    "loaded": 0,
    "total": 0,
    "error": None,
}
_startup_status = dict(_STARTUP_STATUS_INIT)
_startup_status_lock = threading.Lock()

_startup_sse_subscribers: set[asyncio.Queue] = set()
# threading.Lock (not asyncio.Lock) — also acquired from background threads
# in _notify_startup_sse; held only for set mutations (microseconds).
_startup_sse_lock = threading.Lock()
_event_loop: asyncio.AbstractEventLoop | None = None

_SSE_POLL_INTERVAL = 2.0    # seconds: idle wait between disconnect checks
_SSE_KA_INTERVAL = 15.0     # seconds: interval between SSE keepalive data events


def _set_startup_status(**updates):
    global _startup_status
    with _startup_status_lock:
        next_status = dict(_startup_status)
        next_status.update(updates)
        _startup_status = next_status
        snapshot = dict(next_status)
    _notify_startup_sse(snapshot)


def _put_latest(q: asyncio.Queue, snapshot: dict) -> None:
    """Coalescing put: drain any stale snapshot then put the newest one.

    Because the queue is bounded to maxsize=1 and this function runs on the
    event loop, consecutive rapid updates replace the queued snapshot with
    the latest state rather than growing an unbounded backlog.
    """
    while not q.empty():
        try:
            q.get_nowait()
        except asyncio.QueueEmpty:
            break
    try:
        q.put_nowait(snapshot)
    except asyncio.QueueFull:
        pass  # shouldn't happen after draining, but be defensive


def _notify_startup_sse(snapshot: dict) -> None:
    loop = _event_loop
    if loop is None or loop.is_closed():
        return
    with _startup_sse_lock:
        for q in _startup_sse_subscribers:
            try:
                loop.call_soon_threadsafe(_put_latest, q, snapshot)
            except RuntimeError:
                # Loop is closing (shutdown race); all remaining subscribers are
                # on the same loop and equally unreachable — break is correct.
                break


def _get_startup_status():
    with _startup_status_lock:
        return dict(_startup_status)






def _feedBack_server_root() -> Path:
    """Directory containing server.py (repo root in dev; resources/feedBack when bundled)."""
    return Path(__file__).resolve().parent




# Progression content (spec 010): bundled JSON under data/progression/ (paths,
# quest pools, shop catalog). Loaded lazily-once; invalid entries are logged
# warnings, never fatal. FEEDBACK_PROGRESSION_DATA overrides the root (tests).
_progression_content: dict | None = None
_progression_content_lock = threading.Lock()


def _get_progression_content() -> dict:
    global _progression_content
    if _progression_content is None:
        with _progression_content_lock:
            if _progression_content is None:
                import progression as progression_mod
                root = getenv_compat("FEEDBACK_PROGRESSION_DATA") or (
                    _feedBack_server_root() / "data" / "progression"
                )
                content, warnings = progression_mod.load_content(root)
                for warning in warnings:
                    log.warning("progression content: %s", warning)
                _progression_content = content
    return _progression_content


# Publish the progression-content accessor into the seam now that it's defined
# (the main configure() at import-top runs before this def). The cache global +
# lock stay in server.py, so the `setattr(server, "_progression_content")` test
# path is unchanged; routers call `appstate.get_progression_content()`.
appstate.configure(
    get_progression_content=_get_progression_content,
    builtin_diagnostic_filename=builtin_content.builtin_diagnostic_filename,
    tuning_providers=tuning_providers,
)

















def _join_background_db_threads(timeout: float = 30.0) -> None:
    """Block until the background scan + enrichment workers finish (or timeout).

    A scan kicks enrichment on completion, so join the scan first — by the time
    it returns, _kick_enrich() has set _enrich_thread — then join enrichment."""
    st = scan.scan_thread()
    if st is not None and st.is_alive():
        st.join(timeout)
    et = enrichment._enrich_thread
    if et is not None and et.is_alive():
        et.join(timeout)






# ── Metadata enrichment worker (P7 plumbing + P8 matcher) ─────────────────────
# A single throttled daemon thread + queue, mirroring _kick_scan/_scan_runner
# (single-flight + coalescing; NOT a pool — external lookups are rate-limited
# to ~1/s, which makes a pool pointless). P7 shipped the lifecycle; P8 fills
# in the matcher (_enrich_one): local cache → manifest mbid/isrc exact keys →
# MusicBrainz text search, scored into auto/review/failed tiers by
# lib/mb_match.py. Wrong-match is worse than slow (design §5): medium
# confidence goes to the Match-Review queue, never straight to canonical.





















# ── AcoustID audio fingerprinting (content-based identification) ──────────────
# Optional path: requires the Chromaprint `fpcalc` binary AND an AcoustID API
# key ($ACOUSTID_API_KEY). Both absent ⇒ graceful no-op; the text matcher runs.


















































def _art_safe_name(filename: str) -> str:
    """The flattened cache-file stem the art routes key user overrides on
    (matches the legacy /art/upload naming, so old uploads keep working)."""
    return filename.replace("/", "_").replace(" ", "_")


def _art_override_paths(filename: str) -> list[Path]:
    """Existing user-override art files for a song, GIF first (it wins —
    the animated local-only bonus outranks a stale PNG)."""
    stem = _art_safe_name(filename)
    return [p for p in (ART_CACHE_DIR / f"{stem}.gif", ART_CACHE_DIR / f"{stem}.png")
            if p.is_file()]


def _song_pack_art_exists(filename: str) -> bool:
    """Whether the song carries its own art (sloppak cover / loose-folder
    image). Pack art always outranks a CAA fetch, so the art worker marks
    these and never spends a request on them."""
    try:
        dlc = _get_dlc_dir()
        if not dlc:
            return False
        p = _resolve_dlc_path(dlc, filename)
        if p is None or not p.exists():
            return False
        if sloppak_mod.is_sloppak(p):
            return sloppak_mod.read_cover_bytes(p) is not None
        if loosefolder_mod.is_loose_song(p):
            return loosefolder_mod.find_art(p) is not None
    except Exception:
        pass
    return False


# Publish the art cache dir + the two shared art helpers to the enrichment seam
# (lib/enrichment.py's worker calls these; the defs stay here because the art /
# delete routes share them). configure() is idempotent/additive.
appstate.configure(
    art_cache_dir=ART_CACHE_DIR,
    song_pack_art_exists=_song_pack_art_exists,
    art_override_paths=_art_override_paths,
    art_safe_name=_art_safe_name,
)


























# ── Register plugin API endpoints (lightweight, before app starts) ───────────
from plugins import load_plugins, register_plugin_api
register_plugin_api(app)

# Plugin loading deferred to startup event (see below) to avoid blocking
# server startup when many plugins are installed.


@app.on_event("startup")
async def startup_events():
    # Safety net: re-apply the structlog pipeline in case the server was
    # started directly via `uvicorn server:app` (without main.py).  When
    # running via `python main.py`, configure_logging() was already called
    # before uvicorn.run(..., log_config=None), so uvicorn never calls its
    # own dictConfig() and this call is effectively a no-op.  When running
    # the uvicorn CLI directly, uvicorn applies LOGGING_CONFIG before the
    # ASGI startup hook fires, overwriting the uvicorn* handlers; this call
    # restores them for all messages after "Waiting for application startup".
    configure_logging()

    loop = asyncio.get_running_loop()
    global _event_loop
    _event_loop = loop

    # Test/CI escape hatch: tests that import the FastAPI app via TestClient
    # don't need plugin loading or the background library scan, and those
    # paths touch the user filesystem in ways that aren't safe under
    # parallel test runs. Drive startup straight to a terminal "complete"
    # phase so any frontend startup waiter that observes the lifespan also
    # unblocks cleanly (the SSE/poll client treats only `complete` and
    # `error` as terminal when `running` becomes false).
    if _env_flag("FEEDBACK_SKIP_STARTUP_TASKS"):
        log.info("[startup] Skipping plugin load and background scan")
        # Tests pop `server` from sys.modules across runs, but the `plugins`
        # module is not reloaded — so LOADED_PLUGINS can carry stale entries
        # from a previous test's startup, which `/api/plugins` would then
        # expose despite this branch reporting zero loaded plugins. Normal
        # startup clears it inside load_plugins; do the same here under the
        # same lock so this skip path matches that invariant.
        from plugins import LOADED_PLUGINS, PENDING_PLUGINS, PLUGINS_LOCK
        with PLUGINS_LOCK:
            LOADED_PLUGINS.clear()
            PENDING_PLUGINS.clear()
        _set_startup_status(
            running=False,
            phase="complete",
            message="Startup tasks skipped (FEEDBACK_SKIP_STARTUP_TASKS).",
            error=None,
            current_plugin="",
            loaded=0,
            total=0,
        )
        return

    _set_startup_status(
        running=True,
        phase="starting",
        message="Core server ready. Starting plugin loader...",
        error=None,
    )

    plugin_context = {
        "config_dir": CONFIG_DIR,
        "get_dlc_dir": _get_dlc_dir,
        # Pass the DLC-root resolver (not its result) so loose-folder
        # metadata keeps its dlc-relative artist/album inference while the
        # lookup stays lazy — archive/sloppak extraction never reads config.
        # Plugins still call this with just a path.
        "extract_meta": lambda p: _extract_meta_for_file(p, _get_dlc_dir),
        "meta_db": meta_db,
        "get_scan_status": lambda: dict(scan.status()),
        "get_art_cache_dir": lambda: ART_CACHE_DIR,
        "library_providers": library_providers,
        "register_library_provider": register_library_provider,
        "unregister_library_provider": unregister_library_provider,
        "register_tuning_provider": register_tuning_provider,
        "unregister_tuning_provider": unregister_tuning_provider,
        "get_sloppak_cache_dir": lambda: SLOPPAK_CACHE_DIR,
        "register_demo_janitor_hook": register_demo_janitor_hook,
        # Unified XP service (fee[dB]ack v0.3.0). Plugins that award XP
        # (minigames, tutorials, …) should feed the single core store via these
        # instead of keeping a private XP curve. `award_xp` returns the new
        # progress payload; `seed_xp` is a one-time migration of pre-unification
        # XP from a plugin's own store.
        "award_xp": lambda amount, source=None: (meta_db.award_xp(amount, source), meta_db.get_progress())[1],
        "get_xp_progress": lambda: meta_db.get_progress(),
        "seed_xp": lambda amount, marker="minigames": meta_db.seed_xp_once(amount, marker),
        # Reset one source's contribution to the unified total (e.g. a minigames
        # profile-reset). Returns the new progress payload.
        "reset_xp": lambda source: meta_db.reset_source_xp(source),
        # Progression engine (spec 010): the backend twin of the frontend
        # `progression` capability's record-event command. Backend plugin code
        # is trusted, so no type whitelist here (the HTTP intake enforces one);
        # returns the toast-ready summary {challenges_completed,
        # quests_completed, level_ups, calibration_completed, mastery_rank}.
        "record_progression_event": lambda event_type, payload=None: meta_db.record_progression_event(
            event_type, payload, _get_progression_content()
        ),
    }

    # Load plugins asynchronously so HTTP routes and the desktop window can
    # come up immediately while heavy plugin imports/install steps continue.
    _sync_mode = getenv_compat("FEEDBACK_SYNC_STARTUP", "").lower() in {"1", "true", "yes", "on"}

    def _load_plugins_background():
        try:
            # Track all active plugin errors so that a `clear_error=True`
            # event from a fallback recovery correctly restores any *other*
            # plugin's still-unresolved failure rather than wiping the error
            # field entirely.
            #
            # Using a single "last error" pointer was insufficient: if plugin A
            # fails, then plugin B fails and later recovers, the recovery would
            # overwrite the pointer with B's id — and then B's `error=None`
            # clears the status to null even though A is still broken.
            #
            # With a dict (keyed by plugin_id, insertion-ordered) we can
            # remove B's entry on recovery and restore the most recent remaining
            # failure from A, giving an accurate picture of startup health.
            _active_errors: dict[str, str] = {}  # plugin_id -> error text

            def _on_progress(event: dict):
                total = int(event.get("total") or 0)
                loaded = int(event.get("loaded") or 0)
                plugin_id = event.get("plugin_id") or ""
                message = event.get("message") or "Loading plugins..."
                phase = event.get("phase") or "plugins-loading"
                update: dict = dict(
                    running=True,
                    phase=phase,
                    message=message,
                    current_plugin=plugin_id,
                    loaded=loaded,
                    total=total,
                )
                # Forward the error field only when the event explicitly
                # carries it.  Two cases:
                # - Non-null string: record this plugin's failure and display it.
                # - Explicit null (clear_error=True in _emit_progress):
                #   remove this plugin's failure entry, then restore the most
                #   recently recorded still-active failure (if any) so
                #   unresolved failures from other plugins remain visible.
                #   An unscoped clear (no plugin_id) removes the unscoped
                #   sentinel and applies the same restore logic.
                # Events that omit the key entirely leave the status unchanged,
                # preserving any earlier plugin error across the many
                # non-error progress events that follow normal setup steps.
                if "error" in event:
                    err_val = event["error"]
                    if err_val is not None:
                        # Pop then re-insert so the key moves to the end of
                        # insertion order even when this plugin already has an
                        # entry.  A plugin can emit more than one error during a
                        # single load (requirements + routes), and dict.update()
                        # on an existing key does NOT move it to the end, so
                        # remaining[-1] could return a stale earlier message
                        # after another plugin clears its own error.
                        _active_errors.pop(plugin_id, None)
                        _active_errors[plugin_id] = err_val
                        update["error"] = err_val
                    else:
                        # Clear this plugin's error entry (fallback recovery or
                        # unscoped clear), then surface the most recently added
                        # remaining failure, or None if all have been resolved.
                        _active_errors.pop(plugin_id, None)
                        remaining = list(_active_errors.values())
                        update["error"] = remaining[-1] if remaining else None
                _set_startup_status(**update)

            def _route_setup_on_main(fn):
                """Schedule plugin route registration on the event-loop thread.

                FastAPI/Starlette router mutation is not thread-safe, so the
                actual setup() call is normally marshalled back onto the event
                loop via call_soon_threadsafe.  The background thread blocks
                until the registration completes, raises, or a 60 s timeout
                elapses.

                In synchronous startup mode (_sync_mode=True) this function is
                called directly from the event-loop thread, so marshalling via
                call_soon_threadsafe + fut.result() would deadlock (the loop
                cannot drain the queued callback while it is blocked here).
                In that case fn() is invoked inline instead.

                On timeout (async mode only), startup continues normally.  Any
                exception that eventually arrives is logged via a done-callback
                so it is never silently dropped.
                """
                if _sync_mode:
                    # Already on the event-loop thread — call directly.
                    fn()
                    return

                fut: concurrent.futures.Future = concurrent.futures.Future()
                # _state_lock makes the "check _cancelled + set _started"
                # transition in _do() atomic with the "read _started + set
                # _cancelled" transition in the timeout handler.  Without this
                # lock the two threads can interleave:
                #
                #   Thread A (_do):   passes check-1, yields to event loop
                #   Thread B (timeout): reads _started=False → _mid_flight=False
                #   Thread A (_do):   sets _started, passes check-2 → calls fn()
                #   Thread B (timeout): sets _cancelled (too late)
                #   Result: fn() runs AND fallback loads — concurrent mutation.
                #
                # With the lock, either _do() commits to running fn() before
                # the timeout can set _cancelled (in which case _mid_flight=True
                # and the fallback is skipped), or the timeout wins (sets
                # _cancelled=True and reads _started=False → _mid_flight=False,
                # then _do() sees _cancelled inside the lock and bails out).
                _state_lock = threading.Lock()
                _cancelled = threading.Event()
                _started = threading.Event()

                def _do():
                    with _state_lock:
                        if _cancelled.is_set():
                            # Timeout already fired before we started; bail
                            # to prevent a race with any fallback that may
                            # have been activated by load_plugins().
                            if not fut.done():
                                fut.set_result(None)
                            return
                        _started.set()
                    # Past the lock — committed to running fn().
                    try:
                        fn()
                        fut.set_result(None)
                    except Exception as exc:
                        fut.set_exception(exc)

                loop.call_soon_threadsafe(_do)
                try:
                    fut.result(timeout=60)
                except concurrent.futures.TimeoutError as _te:
                    _pid = getattr(fn, "_plugin_id", "unknown")
                    # Read _started and set _cancelled atomically so _do()
                    # can't slip through the lock and start fn() between the
                    # two operations.
                    with _state_lock:
                        _mid_flight = _started.is_set()
                        _cancelled.set()
                    if _mid_flight:
                        log.warning(
                            "route registration for %r timed out after 60 s and "
                            "setup() was already mid-flight; any routes registered "
                            "before the timeout cannot be removed. The user-copy "
                            "fallback will NOT be activated to prevent concurrent "
                            "router mutation (Python threads cannot be interrupted "
                            "mid-execution). Restart the server to recover.",
                            _pid,
                        )
                        # Signal to load_plugins() that fallback is unsafe
                        # for this plugin — the original setup() is still
                        # running and may add more routes concurrently.
                        _te.setup_mid_flight = True
                    else:
                        log.warning(
                            "route registration for %r timed out after 60 s; "
                            "setup() had not started yet, so it has been cancelled "
                            "and the user-copy fallback (if any) can proceed safely.",
                            _pid,
                        )
                    # Prevent the still-queued _do() from executing if it
                    # hasn't started yet — avoids races with any fallback.
                    # Note: _cancelled was already set inside _state_lock above.

                    def _log_deferred(f: concurrent.futures.Future):
                        try:
                            exc = f.exception()
                        except concurrent.futures.CancelledError:
                            return
                        if exc is not None:
                            log.error("deferred route registration for %r raised: %s", _pid, exc)

                    fut.add_done_callback(_log_deferred)
                    raise  # propagate to load_plugins() so it emits plugin-error and skips "Loaded routes"

            _set_startup_status(
                running=True,
                phase="plugins-loading",
                message="Loading plugins...",
                current_plugin="",
                loaded=0,
                total=0,
                error=None,
            )
            load_plugins(app, plugin_context, progress_cb=_on_progress,
                         route_setup_fn=_route_setup_on_main)
            # Self-heal a freshly recreated container: its filesystem reset to
            # the image-baked sheet (in-tree plugins only), but a mounted
            # FEEDBACK_PLUGINS_DIR may carry user-installed plugins whose
            # classes aren't in it. Run in its OWN daemon thread so the startup
            # status can flip to "complete" immediately rather than waiting on
            # the (up to 120s) Tailwind subprocess. No-op when there are no user
            # plugins or no Tailwind engine (e.g. desktop/native).
            def _startup_tailwind_rebuild():
                try:
                    import tailwind_rebuild
                    if tailwind_rebuild.user_plugin_count() > 0:
                        tailwind_rebuild.rebuild("startup-scan")
                except Exception:
                    log.warning("startup tailwind rebuild failed", exc_info=True)

            # Skip entirely in sync-startup mode (used by tests): no background
            # thread AND no slow inline subprocess. The startup self-heal only
            # matters for a real async startup of a recreated container.
            if not _sync_mode:
                threading.Thread(target=_startup_tailwind_rebuild, daemon=True).start()
            status = _get_startup_status()
            _set_startup_status(
                running=False,
                phase="complete",
                message="Startup complete",
                current_plugin="",
                loaded=status.get("loaded", 0),
                total=max(status.get("total", 0), status.get("loaded", 0)),
                error=status.get("error"),
            )
        except Exception as e:
            _set_startup_status(
                running=False,
                phase="error",
                message="Plugin startup failed",
                error=str(e),
            )
            log.exception("plugin startup failed")

    if _sync_mode:
        # Caller requested synchronous startup (e.g. test environment).
        # Run the loader inline so startup is complete before the server's
        # startup handler returns — no polling or timing workarounds needed.
        _load_plugins_background()
    else:
        threading.Thread(target=_load_plugins_background, daemon=True).start()

    global _DEMO_JANITOR_STARTED, _DEMO_JANITOR_THREAD
    if getenv_compat("FEEDBACK_DEMO_MODE") or getenv_compat("FEEDBACK_DEMO_MODE") == "1" and not _DEMO_JANITOR_STARTED:
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

    # Start background metadata scan
    startup_scan()


@app.on_event("shutdown")
def shutdown_events():
    """Stop the demo-mode janitor thread (if running) on server shutdown."""
    global _DEMO_JANITOR_STARTED, _DEMO_JANITOR_THREAD, _event_loop
    _event_loop = None  # prevent stale loop reference after shutdown
    if _DEMO_JANITOR_STARTED:
        _DEMO_JANITOR_STOP.set()
        thread = _DEMO_JANITOR_THREAD
        if thread is not None:
            thread.join(timeout=5)
            if thread.is_alive():
                import warnings
                warnings.warn(
                    "demo-janitor thread did not stop within 5 s; "
                    "a registered hook may be blocking",
                    RuntimeWarning,
                    stacklevel=1,
                )
                # Leave _DEMO_JANITOR_STARTED True so a new janitor is not
                # spawned by a subsequent startup while the old one is alive.
                return
            _DEMO_JANITOR_THREAD = None
        _DEMO_JANITOR_STARTED = False
        with _DEMO_JANITOR_HOOKS_LOCK:
            _DEMO_JANITOR_HOOKS.clear()


def startup_scan():
    """Start background metadata scan and periodic rescan on server start."""
    scan.kick_scan()
    # Periodic rescan every 5 minutes
    rescan_thread = threading.Thread(target=_periodic_rescan, daemon=True)
    rescan_thread.start()


def _periodic_rescan():
    """Check for new files every 5 minutes."""
    time.sleep(300)  # Wait 5 minutes after startup
    while True:
        # scan.kick_scan() is a no-op (returns False, queues a pending pass) when
        # a scan is already running, so racing against the active scan is
        # safe — no second runner is spawned.
        scan.kick_scan()
        time.sleep(300)




# ── App version / source URLs ────────────────────────────────────────────────
# Mounted here (registration order). Implementation in lib/routers/version.py.
app.include_router(version.router)


@app.get("/api/scan-status")
def scan_status():
    return scan.status()


# ── Enrichment routes → routers/enrichment.py (R3) ──────────────────────────
app.include_router(enrichment_routes.router)
































@app.get("/api/startup-status")
def startup_status():
    return _get_startup_status()


@app.get("/api/startup-status/stream")
async def startup_status_stream(request: Request):
    queue: asyncio.Queue[dict] = asyncio.Queue(maxsize=1)
    # Register before putting the initial snapshot.  asyncio cooperative
    # scheduling guarantees _put_latest cannot run between add() and the
    # put() below: put() on an empty maxsize-1 queue never yields (CPython
    # fast path), so no event-loop iteration fires in between.  Registering
    # first ensures a terminal status fired just after connect is never missed.
    with _startup_sse_lock:
        _startup_sse_subscribers.add(queue)
    await queue.put(_get_startup_status())

    async def _gen():
        since_ka = 0.0
        try:
            while True:
                try:
                    data = await asyncio.wait_for(queue.get(), timeout=_SSE_POLL_INTERVAL)
                except asyncio.TimeoutError:
                    if await request.is_disconnected():
                        break
                    since_ka += _SSE_POLL_INTERVAL
                    if since_ka >= _SSE_KA_INTERVAL:
                        yield 'data: {"type":"keepalive"}\n\n'
                        since_ka = 0.0
                    continue
                yield f"data: {json.dumps(data)}\n\n"
                if not data.get("running", True):
                    break
                since_ka = 0.0  # reset keepalive timer — a real event just went out
                # Check after each delivered message so that rapid-fire updates
                # don't prevent disconnect detection (the timeout path above only
                # fires when the queue is idle for the full _SSE_POLL_INTERVAL).
                if await request.is_disconnected():
                    break
        finally:
            with _startup_sse_lock:
                _startup_sse_subscribers.discard(queue)

    return StreamingResponse(
        _gen(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


@app.post("/api/rescan")
def trigger_rescan():
    """Manually trigger a library rescan."""
    if not scan.kick_scan():
        return {"message": "Scan already in progress"}
    return {"message": "Rescan started"}


@app.post("/api/rescan/full")
def trigger_full_rescan():
    """Clear cache and rescan everything."""
    if scan.status()["running"]:
        return {"message": "Scan already in progress"}
    with meta_db._lock:
        # Force every file to re-scan by invalidating the mtime cache (get()
        # keys on mtime equality) WITHOUT emptying `songs` — keeping the rows
        # means the table is never transiently empty mid-scan, so the
        # existing-song stats/playlist read-filter stays correct throughout.
        # delete_missing() prunes anything genuinely gone at the end.
        meta_db.conn.execute("UPDATE songs SET mtime = -1")
        meta_db.conn.commit()
    if not scan.kick_scan():
        return {"message": "Scan already in progress"}
    return {"message": "Full rescan started"}


# ── Song upload ───────────────────────────────────────────────────────────────

_ALLOWED_SONG_EXTS = set(sloppak_mod.SONG_EXTS)




def _invalidate_song_caches(cache_key: str) -> None:
    """Drop filename-keyed derived caches when a song at ``cache_key`` is
    replaced or removed. Sloppak's ``_source_cache`` and loose-folder audio
    IDs self-invalidate via stat checks; the caches purged here do not."""
    # In-memory archive extraction cache (filename → tmp dir + Song).
    with _extract_cache_lock:
        stale = _extract_cache.pop(cache_key, None)
    if stale:
        shutil.rmtree(stale[0], ignore_errors=True)

    # Art cache — match the safe_name mapping used by get_song_art /
    # upload_song_art_b64 exactly so we hit the same on-disk file.
    safe_name = cache_key.replace("/", "_").replace(" ", "_")
    art_file = ART_CACHE_DIR / f"{safe_name}.png"
    try:
        art_file.unlink()
    except FileNotFoundError:
        pass
    except OSError:
        log.debug("failed to evict art cache for %s", cache_key, exc_info=True)

    # archive audio cache — audio_id is `Path(filename).stem.replace(" ", "_")`
    # without any stat digest, so a same-named replacement would serve the
    # previous file's converted audio. Loose-folder ids include a wem stat
    # digest and self-heal; sloppak streams stems directly and uses no
    # audio_id at all — both safely no-op here.
    audio_id = Path(cache_key).stem.replace(" ", "_")
    for d in (AUDIO_CACHE_DIR, STATIC_DIR):
        for ext in (".mp3", ".ogg", ".wav"):
            f = d / f"audio_{audio_id}{ext}"
            try:
                f.unlink()
            except FileNotFoundError:
                pass
            except OSError:
                log.debug("failed to evict audio cache file %s", f, exc_info=True)


# Publish the scan/ingest seam. The scanner itself is lib/scan.py now; these are the
# handles the routers reach it (and its neighbours) through.
#
# scan_status is a CALLABLE, not the dict. lib/scan.py REBINDS the status dict on every
# stage transition rather than updating it in place, so a value published here would be a
# snapshot frozen at whatever stage it happened to be captured — it would report "listing"
# forever while the scan ran to completion.
#
# server_root is published for the same reason lib/builtin_content.py takes it as a
# parameter: `Path(__file__).resolve().parent` is right HERE and silently wrong anywhere
# under lib/ (it yields lib/, which holds no docs/ or data/), and it fails by finding
# nothing rather than by raising. server.py is the only module that legitimately knows
# where it lives, so it says so once, here.
appstate.configure(
    kick_scan=scan.kick_scan,
    invalidate_song_caches=_invalidate_song_caches,
    stat_for_cache=_stat_for_cache,
    scan_status=scan.status,
    server_root=_feedBack_server_root(),
)








# ── Library API ───────────────────────────────────────────────────────────────















# ── Multi-chart work grouping API (P5b) ──────────────────────────────────────
# Read + manage the charts of a work (the P5d Charts drawer consumes this). The
# grouping engine lives in MetadataDB (P5a); these are its HTTP surface. Local
# library only. NOTE: a scoped "work changed" repaint broadcast for OTHER open
# views is deferred to P5d — there's no server-side library event bus today, and
# the drawer updates itself from these responses.

# ── Small library / user-state endpoints (work prefs, favorites, tags, saved, session)
# Mounted here; implementation in lib/routers/library_extras.py. Paths are all
# distinct, so registering them together does not change routing.
app.include_router(library_extras.router)


# ── Chart-level endpoints (split/work/fileinfo) ──────────────────────────────
# Mounted here (registration order). Implementation in lib/routers/chart.py.
app.include_router(chart.router)














# ── Personal per-song metadata (difficulty / notes / tags) ───────────────────
# The local, never-shared layer. Distinct from POST /api/song/{f}/meta, which
# writes catalog fields (title/artist/album/year) BACK INTO the feedpak file;
# these endpoints are DB-only and never touch the file. Likes stay the heart
# (POST /api/favorites/toggle).















# ── Artist aliases / Tidy-up (P4) ────────────────────────────────────────────
# Mounted here, where these routes used to be defined (FastAPI matches in
# registration order). Implementation in lib/routers/artist_aliases.py.
app.include_router(artist_aliases.router)


# ── Artist pages (launch charrette PR-B) ──────────────────────────────────────
# GET page = 100% local (renders offline, renders unmatched); GET links = the
# ONE lazy MusicBrainz artist lookup, cached forever in artist_enrichment and
# re-fetched only by the explicit refresh. Both links routes are demo-blocked
# (they store server state + spend the shared MB rate limit).

# ── Artist routes → routers/artist.py (R3) ──────────────────────────────────
app.include_router(artist_router.router)










# ── Player profile (identity / avatars / progress) ───────────────────────────
# Mounted here (registration order). Implementation in lib/routers/profile.py.
app.include_router(profile.router)


# ── Gameplay scoring: XP award + per-song practice stats ─────────────────────
# Mounted here (registration order; /api/stats/{path} is last inside the router).
# Implementation in lib/routers/stats.py.
app.include_router(stats.router)


# ── Progression (spec 010) ───────────────────────────────────────────────────
# Mounted here (registration order). Implementation in lib/routers/progression.py.
app.include_router(progression.router)


# ── Cosmetics shop (spec 010) ────────────────────────────────────────────────
# Mounted here (registration order). Implementation in lib/routers/shop.py.
app.include_router(shop.router)








# ── Playlists / custom covers (fee[dB]ack v0.3.0) ─────────────────────────────
# Mounted here, where these routes used to be defined (FastAPI matches in
# registration order). Implementation in lib/routers/playlists.py.
app.include_router(playlists.router)


# ── Smart collections API (feedBack#636 item 2) ───────────────────────────────
# (rule schema + `_sanitize_collection_rules` are defined with the provider.)











# ── Wishlist / "wanted" API (feedBack#636 item 4) ─────────────────────────────
# Mounted here (registration order). Implementation in lib/routers/wanted.py.
app.include_router(wanted.router)


# ── Loops API ────────────────────────────────────────────────────────────────
# Mounted here, where these routes used to be defined (FastAPI matches in
# registration order). Implementation in lib/routers/loops.py.
app.include_router(loops.router)


# ── Audio Effects Mapping API ───────────────────────────────────────────────
# Mounted here, where these routes used to be defined: FastAPI matches in
# registration order, so the mount site preserves it.
app.include_router(audio_effects.router)


# ── Settings API ──────────────────────────────────────────────────────────────

# ── Settings routes → routers/settings.py (R3) ──────────────────────────────
app.include_router(settings_router.router)


def _default_settings():
    """Fallback settings returned when config.json is missing or
    unreadable. Also used to seed a fresh cfg on first-run POSTs so a
    single-key write (e.g. the difficulty slider) can't silently wipe
    defaults that subsequent GETs would have exposed."""
    # Same `_DLC_DIR_ENV` truthy check as `_get_dlc_dir`: an empty env
    # var collapses to `Path(".")` whose `.is_dir()` is True, so without
    # the explicit guard we'd surface `"."` to /api/settings — and any
    # partial-update POST would then persist that into config.json,
    # silently undoing the env-var fix on the next load.
    return {
        "dlc_dir": str(DLC_DIR) if (_DLC_DIR_ENV and DLC_DIR.is_dir()) else "",
        # fee[dB]ack v0.3.0 gameplay settings (tabbed settings page). Each
        # defaults to its neutral / off value so existing users see no
        # behaviour change until they opt in. countdown_before_song is wired
        # into the song-start path; miss_penalty / fail_behavior are persisted
        # but not yet consumed by scoring (stub rows on the Gameplay tab).
        "countdown_before_song": False,
        "miss_penalty": "none",
        "fail_behavior": "continue",
        # Achievements epic: opt-in to publishing earned Feats (name + Feat id
        # only) to the hosted wall. Default OFF — nothing leaves the device
        # until the user opts in. Read by the bundled achievements plugin to
        # gate its wall-sync enqueue.
        "achievements_enabled": False,
        # Amp-sim opt-in (issue feedBack-desktop#46). Whether the desktop app may
        # auto-load an in-app amp-sim / tone chain (NAM / IR / VST) for input
        # monitoring. Default OFF — "own-rig first": players monitoring through
        # their own external amp/rig never get a processed monitor (and never the
        # idle distorted buzz) until they opt in. Set during onboarding (desktop
        # only) and from the desktop Audio settings toggle; read by the desktop
        # renderer to gate its saved-chain restore. Inert on the pure-web build,
        # which has no native amp sims.
        "use_amp_sims": False,
        # Metadata matching (P8). `enrich_enabled` gates only the BACKGROUND
        # matcher — manual Fix-match/search in the review modal keeps working
        # when it's off (the media-server model: scraper off ≠ no manual fix);
        # the FEEDBACK_ENRICH_OFFLINE env var is the hard everything-off kill.
        # `enrich_auto_threshold` is the auto-apply confidence — matches at or
        # above it canonicalize automatically, below it queue for review. The
        # per-field floors in lib/mb_match.py always apply on top, so lowering
        # this can't make a wrong-artist cover auto-match. >1.0 (the "Always
        # review" option) sends every text match to review.
        "enrich_enabled": True,
        "enrich_auto_threshold": 0.9,
        # Scraper options (R1). Two axes, media-server style: sources say WHO
        # may be contacted (MusicBrainz = the matcher, Cover Art Archive = the
        # art fetch); the apply toggles say WHICH fields an AUTOMATIC match may
        # canonicalize. A match the user confirms in the review modal always
        # applies in full — these gate only what happens without them. All of
        # it is display-side cache; nothing here ever writes to a pack file.
        "enrich_src_musicbrainz": True,
        "enrich_src_caa": True,
        "enrich_apply_names": True,
        "enrich_apply_year": True,
        "enrich_apply_genres": True,
        "enrich_apply_art": True,
        # Review-queue ordering: missing_first = charts lacking album/year
        # surface first (they gain the most), artist = A–Z, recent = newest
        # files first.
        "enrich_review_order": "missing_first",
        # Artist pages (PR-B). The page itself is 100% local (renders from
        # your own library rows), so it defaults ON; the external-links row
        # (official site / tour dates / videos / social, one throttled
        # MusicBrainz artist lookup per matched artist) is opt-IN — default
        # OFF per the dev-chat thread. Links are links-only forever: always
        # the external browser, never media delivered in-app.
        "artist_pages_enabled": True,
        "artist_external_links": False,
        # Audio fingerprinting (AcoustID + Chromaprint). OPT-IN, default OFF.
        # Text matching (MusicBrainz) can't reliably pick the exact recording
        # for a song with many comp/live/reissue takes (especially a
        # non-title-track — the title can't find the album); fingerprinting
        # reads the audio itself and resolves the EXACT recording. Needs the
        # user's own free AcoustID application key
        # (https://acoustid.org/new-application) plus the `fpcalc` binary. The
        # key lives here (settings) — not only an env var — so a user can set it
        # themselves in the UI; $ACOUSTID_API_KEY stays a server-wide fallback.
        "acoustid_enabled": False,
        "acoustid_api_key": "",
    }


# _default_settings stays here (the scan + artist-links code share it); publish
# it to the seam so routers/settings.py can build the same defaults.
appstate.configure(default_settings=_default_settings)


# GET /api/tunings → routers/tunings.py (R3, reads config + appstate.tuning_providers)
app.include_router(tunings_router.router)










# ── Settings export/import (feedBack#113) ───────────────────────────────────



def _running_version() -> str:
    """Same lookup chain `/api/version` uses, factored out so the export
    bundle records what shipped this file. Kept as a helper so future
    changes (e.g. baked-in version) only have to touch one site."""
    env_version = os.environ.get("APP_VERSION", "").strip()
    if env_version:
        return env_version
    version_file = Path(__file__).parent / "VERSION"
    if version_file.exists():
        try:
            return version_file.read_text().strip()
        except (OSError, UnicodeDecodeError):
            pass
    return "unknown"


# _running_version is defined below the import-top configure() calls, so publish
# it here (configure is idempotent/additive) for routers/diagnostics.py.
appstate.configure(running_version=_running_version)






























# ── Diagnostic bundle export (feedBack#166) → routers/diagnostics.py (R3) ────
# The pure caps/normalisers are re-exported so existing server._diag_* /
# server._DIAG_* tests keep resolving (none of them monkeypatch these).
from routers.diagnostics import (  # noqa: E402  (re-export for test compatibility)
    _diag_cap_console, _diag_cap_contributions, _diag_cap_dict,
    _diag_coerce_bool, _diag_normalize_include,
    _DIAG_MAX_CLIENT_PAYLOAD_BYTES, _DIAG_MAX_CONSOLE_BYTES,
    _DIAG_MAX_CONSOLE_ENTRIES, _DIAG_MAX_CONTRIBUTIONS_BYTES,
)
app.include_router(diagnostics.router)


# ── Plugin-provided routes are registered at startup via plugins/__init__.py ─
# (CustomsForge, Ultimate Guitar, etc. are loaded from plugins/ directory)



# ── Album-art routes → routers/art.py (R3) ──────────────────────────────────
app.include_router(art_router.router)
# Song routes mount AFTER art (and every other /api/song/{path}/… route): its
# get_song_info catch-all `/api/song/{filename:path}` would otherwise shadow them.
app.include_router(song_router.router)
















































# ── Highway WebSocket ─────────────────────────────────────────────────────────

# Filename-keyed extraction cache, retained so _invalidate_song_caches() has a
# stable handle to purge on song replace/delete. Open formats (sloppak/loose)
# self-invalidate via stat checks and never populate this, so it stays empty in
# practice.
_extract_cache = {}  # filename -> (tmp_dir, song, timestamp)
_extract_cache_lock = threading.Lock()


# ── Media/file-serving routes → routers/media.py (R3) ───────────────────────
app.include_router(media_router.router)




# ── Highway chart WebSocket ──────────────────────────────────────────────────
# Mounted here, where the handler used to be defined (registration order).
# Implementation in lib/routers/ws_highway.py.
app.include_router(ws_highway.router)


# ── Audio serving ─────────────────────────────────────────────────────────────






class _RevalidatedStaticFiles(StaticFiles):
    """StaticFiles that forces conditional revalidation on every request.

    Without Cache-Control, Chromium applies heuristic freshness (10% of the
    file's age since Last-Modified) and serves /static/app.js from its disk
    cache for hours-to-days without asking the server. In the desktop app that
    meant a new build's renderer ran the PREVIOUS build's app.js — the
    2026-07-11 ASIO investigation lost a day to a stale loader that couldn't
    even load module plugins. `no-cache` does NOT disable caching: the browser
    keeps the cached copy and revalidates with If-None-Match; unchanged files
    still cost only a 304."""

    async def get_response(self, path, scope):
        response = await super().get_response(path, scope)
        response.headers.setdefault("Cache-Control", "no-cache")
        return response


app.mount("/static", _RevalidatedStaticFiles(directory=str(STATIC_DIR)), name="static")


@app.get("/")
def index():
    return FileResponse(str(STATIC_DIR / "v3" / "index.html"))


@app.get("/v3")
def index_v3():
    # Retained as a back-compat alias for links minted while v3 was opt-in.
    return FileResponse(str(STATIC_DIR / "v3" / "index.html"))
