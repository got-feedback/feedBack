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

from fastapi import Body, FastAPI, UploadFile, File, HTTPException
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
    _safe_art_redirect_url, _sync_collection_provider,
)
from dlc_paths import _get_dlc_dir, _resolve_dlc_path
# The router seam. Imported as a module (never `from appstate import ...`) so
# `appstate.configure(...)` below publishes into the same namespace routers read.
# Lives in lib/ because that is the one core dir every packaging path copies.
import appstate
# Extracted route modules. They import `appstate`, never `server` — one-way graph.
from routers import audio_effects, artist_aliases, loops, playlists, ws_highway, chart, wanted, library_extras, shop, progression, profile, stats, version, diagnostics
from routers import tunings as tunings_router
import enrichment
from routers import art as art_router
from routers import settings as settings_router
from routers import song as song_router
from routers import library as library_router
import sloppak as sloppak_mod
import loosefolder as loosefolder_mod
# Pure text-matching engine for MusicBrainz enrichment (P8): denoise/score/
# tier classification + response parsing. No network/DB in there — the
# throttled transport and the song_enrichment writes live in this module.
import mb_match
# Metadata extraction lives in a side-effect-free module so ProcessPool
# scan workers can import + unpickle _scan_one without re-running this
# module's import-time side effects (see lib/scan_worker.py).
from scan_worker import _extract_meta_for_file, _relpath, _scan_one

import concurrent.futures
import inspect
import ipaddress
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
            # OSError bubble out of _background_scan(), killing the
            # scan thread while `_scan_status["running"]` stays true.
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


_SCAN_STATUS_INIT = {"running": False, "stage": "idle", "total": 0, "done": 0, "current": "", "error": None, "is_first_scan": False, "added": 0, "removed": 0}
_scan_status = dict(_SCAN_STATUS_INIT)

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


def _make_scan_executor():
    """Build the executor for the background metadata scan.

    A `spawn` ProcessPoolExecutor in production. `spawn` (not the platform
    default) is mandatory: _background_scan runs on a non-main daemon
    thread, and forking a multithreaded process from a non-main thread can
    deadlock on locks held by other threads at fork time (the default on
    Linux). `spawn` boots a clean interpreter that imports only scan_worker
    (+ its pure lib deps) to unpickle the worker — never this module — so
    workers don't re-run server.py's import-time side effects (reopening
    SQLite, attaching a second RotatingFileHandler, re-registering routes).

    Tests monkeypatch this to a ThreadPoolExecutor so the scan runs
    in-process and metadata extraction can be mocked.
    """
    mp_ctx = multiprocessing.get_context("spawn")
    # Default to one worker per core so CPU-bound metadata parsing uses the
    # whole machine (the point of moving to processes).
    # FEEDBACK_MAX_SCAN_WORKERS (set by the Desktop launcher to cap memory
    # usage on low-RAM machines — e.g. 8 GB M2 MacBook Air) takes priority;
    # SCAN_MAX_WORKERS is a legacy override for Docker/bare installs.
    # A malformed override falls back to the core count rather than crashing.
    try:
        max_workers = int(
            getenv_compat("FEEDBACK_MAX_SCAN_WORKERS")
            or os.environ.get("SCAN_MAX_WORKERS")
            or (os.cpu_count() or 1)
        )
    except ValueError:
        max_workers = os.cpu_count() or 1
    # ProcessPoolExecutor raises ValueError on Windows when max_workers > 61
    # (the WaitForMultipleObjects handle limit), so clamp there — otherwise
    # a high-core Windows host can't construct the pool and the scan never
    # starts.
    if sys.platform == "win32":
        max_workers = min(max_workers, 61)
    return concurrent.futures.ProcessPoolExecutor(
        max_workers=max(1, max_workers), mp_context=mp_ctx,
    )


_BUILTIN_DIAGNOSTIC_SUBDIR = "diagnostics-builtin"
_BUILTIN_DIAGNOSTIC_SOURCES: list[tuple[str, str]] = [
    (
        "feedBack-diagnostic-basic-guitar.sloppak",
        "docs/diagnostics/feedBack-diagnostic-basic-guitar.sloppak",
    ),
]


def _feedBack_server_root() -> Path:
    """Directory containing server.py (repo root in dev; resources/feedBack when bundled)."""
    return Path(__file__).resolve().parent


def _builtin_diagnostic_filename() -> str:
    """Library filename (DLC-relative POSIX path) of the calibration sloppak —
    the onboarding challenge target (spec 010)."""
    return f"{_BUILTIN_DIAGNOSTIC_SUBDIR}/{_BUILTIN_DIAGNOSTIC_SOURCES[0][0]}"


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
    builtin_diagnostic_filename=_builtin_diagnostic_filename,
    tuning_providers=tuning_providers,
)


def _copy_builtin_packs(
    root: Path,
    dest_dir: Path,
    sources: list[tuple[str, str]],
    label: str,
    update_existing: bool = True,
) -> int:
    """Symlink-safe, mtime-aware copy of bundled packs into ``dest_dir``.

    ``sources`` is a list of ``(dest_name, rel_source)`` pairs; each source is
    resolved under ``root`` (the repo root in dev, ``resources/feedBack`` when
    bundled). A pack is copied when its destination is missing. Never deletes
    user files; refuses to follow a symlinked seed directory or destination and
    refuses to clobber a non-regular destination (any would let a copy escape
    ``dest_dir`` or destroy user data). Logs and continues on error. ``label``
    prefixes every log line.

    ``update_existing`` controls what happens when a *regular* destination file
    already exists: when True (diagnostic seed) a bundle copy newer than the
    destination refreshes it; when False (one-time starter content) an existing
    file is always left as-is so the user's copy is never overwritten.

    Returns the number of ``sources`` that are present at their destination
    afterwards (freshly seeded, refreshed, or already current) — so callers can
    tell whether every pack made it. A skip (missing source, symlink/non-regular
    refusal, copy error) does not count.
    """
    # Refuse a symlinked seed directory: mkdir(exist_ok=True) would accept it
    # and copies would land at the link target, outside the DLC tree. The
    # per-file symlink guard below cannot catch this.
    if dest_dir.is_symlink():
        log.warning("%s: %s is a symlink, skipping all seeding", label, dest_dir.name)
        return 0
    dest_dir.mkdir(parents=True, exist_ok=True)

    # Pin the seed directory by an O_NOFOLLOW fd so a symlink swapped in for
    # dest_dir *after* the check above cannot redirect the per-file stat /
    # temp-create / replace outside the DLC tree (parent-directory TOCTOU).
    # os.replace accepts dir_fd on POSIX even though it isn't listed in
    # os.supports_dir_fd, so gate on os.rename (the reliable proxy); platforms
    # without dir_fd/O_NOFOLLOW (e.g. Windows) fall back to path-based ops.
    dir_fd = None
    if (
        hasattr(os, "O_NOFOLLOW")
        and hasattr(os, "O_DIRECTORY")
        and os.open in os.supports_dir_fd
        and os.rename in os.supports_dir_fd
    ):
        try:
            dir_fd = os.open(dest_dir, os.O_RDONLY | os.O_NOFOLLOW | os.O_DIRECTORY)
        except OSError as exc:
            log.warning("%s: cannot open seed dir %s: %s", label, dest_dir, exc)
            return 0

    try:
        present = 0
        for dest_name, rel_source in sources:
            source = root / rel_source
            if not source.is_file():
                log.warning("%s: source missing, skipping %s (%s)", label, dest_name, source)
                continue

            # lstat the destination without following symlinks. Pinned by dir_fd
            # this resolves within the real seed dir, immune to a parent swap.
            try:
                if dir_fd is not None:
                    dstat = os.lstat(dest_name, dir_fd=dir_fd)
                else:
                    dstat = os.lstat(dest_dir / dest_name)
                dest_exists = True
                dest_islink = stat.S_ISLNK(dstat.st_mode)
            except FileNotFoundError:
                dest_exists = False
                dest_islink = False
            except OSError as exc:
                log.warning("%s: cannot stat %s: %s", label, dest_name, exc)
                continue

            # Refuse to seed through a symlink at the destination name.
            if dest_islink:
                log.warning("%s: destination is a symlink, skipping %s", label, dest_name)
                continue

            # A non-regular destination (directory, fifo, …) the user placed
            # there: never clobber it, and never count it as present — otherwise
            # a one-time seed would mark itself done without a real pack on disk.
            if dest_exists and not stat.S_ISREG(dstat.st_mode):
                log.warning("%s: destination is not a regular file, skipping %s", label, dest_name)
                continue

            if dest_exists:
                # A regular file is already there. One-time seeds (starter
                # content) must never overwrite the user's copy; refreshing
                # seeds (diagnostics) replace it only when the bundle is newer.
                if not update_existing:
                    log.info("%s: already present %s", label, dest_name)
                    present += 1
                    continue
                try:
                    src_mtime = source.stat().st_mtime
                except OSError as exc:
                    log.warning("%s: cannot stat source %s: %s", label, source, exc)
                    continue
                if src_mtime <= dstat.st_mtime:
                    log.info("%s: already present %s", label, dest_name)
                    present += 1
                    continue
                action = "updated"
            else:
                action = "seeded"

            if _write_builtin_pack(source, dest_dir, dest_name, dir_fd):
                present += 1
                log.info("%s: %s %s -> %s", label, action, source.name, dest_name)
            else:
                log.warning("%s: failed to copy %s -> %s/%s", label, source, dest_dir.name, dest_name)

        return present
    finally:
        if dir_fd is not None:
            os.close(dir_fd)


def _write_builtin_pack(
    source: Path,
    dest_dir: Path,
    dest_name: str,
    dir_fd: int | None,
) -> bool:
    """Atomically write ``source`` to ``dest_name`` inside ``dest_dir``.

    Writes to a temp file then ``os.replace()``s onto the final name so a
    symlink raced in at the destination is overwritten (rename semantics), not
    followed, and a crash never leaves a half-written pack. When ``dir_fd`` is
    given, every step is anchored to that fd (O_NOFOLLOW temp create + dir_fd
    replace), closing the parent-directory TOCTOU; otherwise falls back to
    path-based temp+replace. Returns True on success. Never raises.
    """
    # Unique per-attempt name (O_EXCL create) so a crash that orphans a temp
    # can't permanently block later seeds via an EEXIST collision.
    tmp_name = f".seed-{dest_name}.{os.getpid()}.{secrets.token_hex(4)}.tmp"
    try:
        src_stat = source.stat()
    except OSError as exc:
        log.debug("builtin pack: cannot stat source %s: %s", source, exc)
        return False
    if dir_fd is not None:
        tmp_fd = None
        try:
            tmp_fd = os.open(
                tmp_name,
                os.O_CREAT | os.O_EXCL | os.O_WRONLY | os.O_NOFOLLOW,
                0o644,
                dir_fd=dir_fd,
            )
            with open(source, "rb") as sf, os.fdopen(tmp_fd, "wb") as tf:
                tmp_fd = None  # fdopen now owns the descriptor
                shutil.copyfileobj(sf, tf)
            os.replace(tmp_name, dest_name, src_dir_fd=dir_fd, dst_dir_fd=dir_fd)
            # Preserve the bundle mtime (copyfileobj doesn't) so the mtime-based
            # refresh check matches the shutil.copy2 fallback path. Best-effort.
            try:
                os.utime(
                    dest_name,
                    ns=(src_stat.st_atime_ns, src_stat.st_mtime_ns),
                    dir_fd=dir_fd,
                    follow_symlinks=False,
                )
            except OSError as exc:
                log.debug("builtin pack: could not set mtime on %s: %s", dest_name, exc)
            return True
        except OSError as exc:
            log.debug("builtin pack write (dir_fd) failed for %s: %s", dest_name, exc)
            if tmp_fd is not None:
                try:
                    os.close(tmp_fd)
                except OSError:
                    pass
            try:
                os.unlink(tmp_name, dir_fd=dir_fd)
            except OSError:
                pass
            return False

    tmp = None
    try:
        fd, tmp = tempfile.mkstemp(dir=dest_dir, prefix=".seed-", suffix=".tmp")
        os.close(fd)
        shutil.copy2(source, tmp)
        os.replace(tmp, dest_dir / dest_name)
        tmp = None
        return True
    except OSError as exc:
        log.debug("builtin pack write failed for %s: %s", dest_name, exc)
        return False
    finally:
        if tmp is not None:
            try:
                os.unlink(tmp)
            except OSError:
                pass


def _seed_builtin_diagnostic_sloppaks(dlc: Path | None = None) -> None:
    """Copy bundled diagnostic sloppaks into DLC before library scan.

    Creates ``DLC_DIR/diagnostics-builtin/`` and copies each bundled sloppak
    when the destination is missing or older than the repo/bundle source.
    Never deletes user files or touches manually copied paths (e.g.
    ``diagnostics-test/``). Re-seeds whenever the destination is missing so the
    diagnostic target is always available. Logs and continues on errors.
    """
    try:
        if dlc is None:
            dlc = _get_dlc_dir()
        if dlc is None:
            log.debug("Builtin diagnostic seed: no DLC folder configured, skipping")
            return
        _copy_builtin_packs(
            _feedBack_server_root(),
            dlc / _BUILTIN_DIAGNOSTIC_SUBDIR,
            _BUILTIN_DIAGNOSTIC_SOURCES,
            "Builtin diagnostic seed",
        )
    except Exception:
        log.warning("Builtin diagnostic seed: unexpected error", exc_info=True)


# Starter content: bundled songs copied into ``DLC_DIR/starter/`` exactly ONCE,
# on first run, as a welcome library so a fresh install isn't empty. Unlike the
# diagnostic seed this is one-time — guarded by a marker in CONFIG_DIR — so if
# the user deletes the starter song it stays gone. ``starter/`` is NOT in the
# library scan carve-out (unlike diagnostics-builtin/ / tutorials-builtin/), so
# seeded packs surface as ordinary library songs.
_BUILTIN_STARTER_SUBDIR = "starter"
_BUILTIN_STARTER_SOURCES: list[tuple[str, str]] = [
    (
        "beethoven-fur_elise.feedpak",
        "content/starter/beethoven-fur_elise.feedpak",
    ),
    (
        "star_spangled_banner.feedpak",
        "content/starter/star_spangled_banner.feedpak",
    ),
    (
        "the_adicts-ode-to-joy_vst_cover.feedpak",
        "content/starter/the_adicts-ode-to-joy_vst_cover.feedpak",
    ),
]
_STARTER_SEED_MARKER = ".starter-content-seeded"


def _seed_builtin_starter_content(dlc: Path | None = None) -> None:
    """Copy bundled starter songs into ``DLC_DIR/starter/`` exactly once.

    Guarded by ``CONFIG_DIR/.starter-content-seeded``: the first run with a DLC
    folder configured seeds the packs and writes the marker; subsequent runs are
    no-ops, so a user who deletes the starter song does not get it back on the
    next launch. Symlink-safe; never deletes user files. Logs, never raises.
    """
    try:
        marker = CONFIG_DIR / _STARTER_SEED_MARKER
        # Already seeded? The marker is a sentinel: any existing path there
        # (regular file, or a symlink/dir a user deliberately planted to opt
        # out) means "done" — lstat so we detect it without following a symlink.
        # Worst case of a planted marker is simply no starter content, never a
        # data write; the O_EXCL|O_NOFOLLOW create below refuses to write
        # *through* a symlink regardless.
        try:
            os.lstat(marker)
            return
        except FileNotFoundError:
            pass
        except OSError as exc:
            log.warning("Starter content seed: cannot stat marker %s: %s", marker, exc)
            return
        if dlc is None:
            dlc = _get_dlc_dir()
        if dlc is None:
            # No DLC yet — leave the marker unwritten so we retry once a
            # library folder is configured.
            log.debug("Starter content seed: no DLC folder configured, skipping")
            return
        present = _copy_builtin_packs(
            _feedBack_server_root(),
            dlc / _BUILTIN_STARTER_SUBDIR,
            _BUILTIN_STARTER_SOURCES,
            "Starter content seed",
            update_existing=False,
        )
        # Only mark seeding complete once every starter pack is actually in
        # place. If a source was missing or a copy failed, leave the marker
        # unwritten so the next launch retries rather than permanently skipping.
        if present < len(_BUILTIN_STARTER_SOURCES):
            log.info(
                "Starter content seed: %d/%d packs present, will retry next launch",
                present,
                len(_BUILTIN_STARTER_SOURCES),
            )
            return
        # Record completion with an exclusive, no-follow create so a planted or
        # raced symlink at the marker path can't redirect the write outside
        # CONFIG_DIR. O_EXCL fails (EEXIST) on any existing path including a
        # symlink, so we never write through one.
        try:
            CONFIG_DIR.mkdir(parents=True, exist_ok=True)
            flags = os.O_CREAT | os.O_EXCL | os.O_WRONLY | getattr(os, "O_NOFOLLOW", 0)
            fd = os.open(marker, flags, 0o644)
            try:
                os.write(fd, b"1\n")
            finally:
                os.close(fd)
        except FileExistsError:
            pass  # already marked (or a non-regular path is squatting) — fine
        except OSError as exc:
            log.warning("Starter content seed: could not write marker %s: %s", marker, exc)
    except Exception:
        log.warning("Starter content seed: unexpected error", exc_info=True)


def _background_scan():
    """Scan the library and cache song metadata on startup. Uses a process pool to bypass the GIL for CPU-bound metadata parsing.

    Never sets `_scan_status["running"] = False` — ownership of that flag
    lives in `_scan_runner` so a `_kick_scan()` racing this function's
    terminal write cannot observe a stale False and start a second runner.
    """
    global _scan_status
    _scan_status = {**_SCAN_STATUS_INIT, "running": True, "stage": "listing"}

    # Load config once so both the DLC-dir lookup and the platform filter
    # read from the same snapshot, avoiding a redundant parse of config.json.
    _cfg = _load_config(CONFIG_DIR / "config.json") or _default_settings()
    dlc = _get_dlc_dir(_cfg)
    if not dlc:
        _scan_status = {**_SCAN_STATUS_INIT, "running": True, "stage": "idle", "error": "DLC folder not configured"}
        log.warning("Scan: no DLC folder configured")
        return

    _seed_builtin_diagnostic_sloppaks(dlc)
    _seed_builtin_starter_content(dlc)

    # Listing can fail on macOS without Full Disk Access, or on Docker if the
    # path isn't shared. Report the failure explicitly rather than silently
    # appearing to scan nothing.
    try:
        # Generated-content sloppaks that the highway WS must resolve by path
        # but that are NOT library songs. Two conventions share this carve-out:
        #   - tutorials-builtin/  — lesson drills seeded by the tutorials plugin
        #     (see plugins/tutorials/routes.py::_seed_builtin_packs).
        #   - minigames-builtin/  — exercise charts generated on demand by
        #     minigame plugins (e.g. Chord Sprint writes alternating-chord
        #     drills here). Cached/reused per exercise, never browsed.
        # Both are kept out of the scan; _resolve_dlc_path still loads them by
        # path for playback.
        def _is_excluded_from_library(p: Path) -> bool:
            return "tutorials-builtin" in p.parts or "minigames-builtin" in p.parts
        # Sloppaks: match both file (zip) and directory form, across both the
        # `.feedpak` and legacy `.sloppak` suffixes.
        _cands = sorted(p for ext in sloppak_mod.SONG_EXTS for p in dlc.rglob(f"*{ext}"))
        sloppaks = [f for f in _cands
                    if sloppak_mod.is_sloppak(f)
                    and not _is_excluded_from_library(f)]

        # Loose song folders: any directory containing a non-preview *.wem + *.xml.
        # Skip directories that are actually sloppak bundles — those are
        # already in `sloppaks`; the dispatcher's sloppak-first precedence
        # would route them to the sloppak path anyway, but adding them
        # here would inflate the scan queue and over-count the total.
        loose_songs = []
        seen_loose = set()
        sloppak_dirs = {p for p in sloppaks if p.is_dir()}
        for wem in sorted(dlc.rglob("*.wem")):
            if "preview" in wem.stem.lower():
                continue
            if _is_excluded_from_library(wem):
                continue
            d = wem.parent
            if d in sloppak_dirs or d.name.lower().endswith(sloppak_mod.SONG_EXTS):
                continue
            if d not in seen_loose and loosefolder_mod.is_loose_song(d):
                loose_songs.append(d)
                seen_loose.add(d)
    except PermissionError as e:
        msg = (f"Permission denied reading {dlc}. "
               "On macOS: grant Full Disk Access to the app in System Settings → Privacy & Security. "
               "With Docker: share this path in Docker Desktop → Settings → Resources → File Sharing.")
        log.error("Scan failed: %s (%s)", msg, e)
        _scan_status = {**_SCAN_STATUS_INIT, "running": True, "stage": "error", "error": msg}
        return
    except OSError as e:
        log.error("Scan failed listing %s: %s", dlc, e)
        _scan_status = {**_SCAN_STATUS_INIT, "running": True, "stage": "error", "error": f"Unable to list {dlc}: {e}"}
        return

    all_songs = sloppaks + loose_songs
    log.info("Scan: listed %d sloppaks and %d loose folders in %s",
             len(sloppaks), len(loose_songs), dlc)

    current_files = {_relpath(f, dlc) for f in all_songs}

    # Clean up stale DB entries. delete_missing reports both deltas (rows pruned
    # + genuinely-new files) so the scan can surface an added/removed summary.
    _delta = meta_db.delete_missing(current_files)
    removed, added = _delta["removed"], _delta["added"]
    if removed:
        log.info("Removed %d stale DB entries", removed)

    # Figure out which need scanning
    to_scan = []
    for f in all_songs:
        # Skip entries that vanish or become unreadable between listing
        # and stat. Without this, one concurrent move/delete in DLC_DIR
        # would crash the scan thread and leave `_scan_status["running"]`
        # stuck true with no path to recover.
        try:
            mtime, size = _stat_for_cache(f)
        except OSError as e:
            log.debug("scan: skipping %s (%s)", f, e)
            continue
        cache_key = _relpath(f, dlc)
        try:
            cached = meta_db.get(cache_key, mtime, size)
        except Exception as e:
            # Keep scanning even if a single metadata lookup fails.
            # The file will be re-scanned and cache repaired by put().
            log.warning("scan cache lookup failed for %s: %s", cache_key, e)
            cached = None
        if not cached:
            to_scan.append((f, mtime, size, dlc))
        elif cached.get("arrangements") and any(
            "smart_name" not in a for a in cached["arrangements"]
        ):
            # Row was scanned before smart naming was introduced — force a
            # rescan so the DB picks up authoritative path flags from the
            # manifest JSON and stores correct smart_name values. Don't
            # re-queue rows where smart_name is explicitly null: the writer
            # only emits that when compute_smart_names truly can't classify
            # the arrangement (e.g. a name outside the recognised set with
            # zero path flags), so rescanning would produce the same null
            # forever and never converge.
            to_scan.append((f, mtime, size, dlc))

    if not to_scan:
        _scan_status = {**_SCAN_STATUS_INIT, "running": True, "stage": "complete", "added": added, "removed": removed}
        log.info("Scan: nothing new to scan (%d songs, all cached)", len(all_songs))
        return

    # Refine: all discovered songs need scanning → treat as first-time import
    # (covers moved DLC folder / fully-stale DB as well as a genuinely empty DB).
    is_first_scan = bool(all_songs) and len(to_scan) == len(all_songs)
    _scan_status = {**_SCAN_STATUS_INIT, "running": True, "stage": "scanning", "total": len(to_scan),
                    "is_first_scan": is_first_scan}
    log.info("Library: %d sloppaks + %d loose folders, %d cached, %d to scan",
             len(sloppaks), len(loose_songs), len(all_songs) - len(to_scan), len(to_scan))

    with _make_scan_executor() as executor:
        futures = {executor.submit(_scan_one, item): item[0].name for item in to_scan}
        for future in concurrent.futures.as_completed(futures):
            fname = futures[future]
            try:
                name, mtime, size, meta = future.result()
                meta_db.put(name, mtime, size, meta)
            except Exception as e:
                log.warning("scan failed for %s: %s", fname, e)
            _scan_status["done"] += 1
            _scan_status["current"] = fname

    log.info("Scan complete: %d songs cached", len(to_scan))
    _scan_status = {**_SCAN_STATUS_INIT, "running": True, "stage": "complete", "added": added, "removed": removed}


_scan_kick_lock = threading.Lock()
_scan_rescan_pending = False

# Handles to the running scan / enrichment worker threads. Both use the shared
# MetadataDB connection, so teardown/shutdown MUST join them before closing that
# connection — a daemon thread mid-query on a closed SQLite conn is a native
# use-after-free that segfaults the process (seen flaky in CI). Set by
# _kick_scan / _kick_enrich; joined by _join_background_db_threads().
_scan_thread: threading.Thread | None = None


def _join_background_db_threads(timeout: float = 30.0) -> None:
    """Block until the background scan + enrichment workers finish (or timeout).

    A scan kicks enrichment on completion, so join the scan first — by the time
    it returns, _kick_enrich() has set _enrich_thread — then join enrichment."""
    st = _scan_thread
    if st is not None and st.is_alive():
        st.join(timeout)
    et = enrichment._enrich_thread
    if et is not None and et.is_alive():
        et.join(timeout)


def _kick_scan() -> bool:
    """Request a library rescan, single-flight + coalescing.

    Returns True if a new scan thread was started, False if one was already
    running. In the latter case a follow-up pass is queued and runs as soon
    as the current scan finishes so files landing mid-scan (e.g. an upload
    that finalizes after the scan has already listed DLC_DIR) are not lost
    until the next periodic pass. Multiple late-arriving requests coalesce
    into a single follow-up.
    """
    global _scan_rescan_pending, _scan_thread
    with _scan_kick_lock:
        if _scan_status["running"]:
            _scan_rescan_pending = True
            return False
        # Mark running synchronously so a parallel _kick_scan() observes it
        # before the worker thread has a chance to reassign _scan_status.
        _scan_status["running"] = True
    _scan_thread = threading.Thread(target=_scan_runner, daemon=True)
    _scan_thread.start()
    return True


def _scan_runner():
    """Run _background_scan, then re-run if requests arrived mid-scan."""
    global _scan_rescan_pending
    while True:
        try:
            _background_scan()
        except Exception:
            log.exception("background scan failed unexpectedly")

        with _scan_kick_lock:
            if not _scan_rescan_pending:
                _scan_status["running"] = False
                break
            _scan_rescan_pending = False
            _scan_status["running"] = True
    # Enrichment rides scan completion (library-metadata design §6): the scan
    # pool is a side-effect-free, no-network process pool by design, so
    # enrichment is a SEPARATE post-scan pass — non-blocking, the library is
    # usable immediately. The 5-minute periodic rescan re-kicks it, which is
    # the natural low-priority retry hook.
    enrichment._kick_enrich()


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
        "get_scan_status": lambda: dict(_scan_status),
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
    _kick_scan()
    # Periodic rescan every 5 minutes
    rescan_thread = threading.Thread(target=_periodic_rescan, daemon=True)
    rescan_thread.start()


def _periodic_rescan():
    """Check for new files every 5 minutes."""
    time.sleep(300)  # Wait 5 minutes after startup
    while True:
        # _kick_scan() is a no-op (returns False, queues a pending pass) when
        # a scan is already running, so racing against the active scan is
        # safe — no second runner is spawned.
        _kick_scan()
        time.sleep(300)




# ── App version / source URLs ────────────────────────────────────────────────
# Mounted here (registration order). Implementation in lib/routers/version.py.
app.include_router(version.router)


@app.get("/api/scan-status")
def scan_status():
    return _scan_status


@app.get("/api/enrichment/status")
def enrichment_status():
    """Enrichment pipeline state: worker flags + row counts by match_state.
    Ambient tool-state for the match-review UI (never a home-screen score —
    design §11); also what tests poke."""
    return {
        "running": enrichment._enrich_status["running"],
        "processed": enrichment._enrich_status["processed"],
        "last_pass_at": enrichment._enrich_status["last_pass_at"],
        "states": meta_db.enrichment_state_counts(),
        "total_songs": meta_db.count(),
        # Per-pass matching progress for the "Refresh Metadata" batch bar +
        # per-tile badges (total = songs queued to match this pass, matched =
        # done so far, current = the one being matched now).
        "total": enrichment._enrich_status.get("total", 0),
        "matched": enrichment._enrich_status.get("matched", 0),
        "current": enrichment._enrich_status.get("current"),
        "cancelling": enrichment._enrich_cancel.is_set(),
    }


@app.get("/api/enrichment/song/{filename:path}")
def api_enrichment_song(filename: str):
    """Read-only per-song match provenance for the Details drawer (launch
    polish): which canonical identity this chart matched and how. A tiny
    projection of the cache row — no candidates, no cache paths."""
    row = meta_db.get_enrichment(filename)
    if not row:
        raise HTTPException(status_code=404, detail="no enrichment row")
    return {k: row.get(k) for k in
            ("match_state", "canon_artist", "canon_title",
             "match_source", "match_score")}


@app.post("/api/enrichment/kick")
def api_enrichment_kick():
    """The Settings "Match now" button AND the library's "Refresh Metadata"
    button: request an enrichment pass without waiting for a scan to complete.
    Processes the songs that still need it (unscanned/changed + retriable
    failures) — already-matched songs are left alone, so on a fully-matched
    library this is a fast no-op. Single-flight + coalescing like every other
    kick — spamming it queues at most one follow-up pass."""
    return {"started": enrichment._kick_enrich()}


@app.post("/api/enrichment/cancel")
def api_enrichment_cancel():
    """Stop button on the "Refresh Metadata" batch: signal the running pass to
    halt after the current song (an in-flight ≤1/s lookup can't be interrupted,
    but no new one is started) and drop any coalesced follow-up. A no-op when
    nothing is running."""
    was_running = enrichment._enrich_status["running"]
    if was_running:
        enrichment._enrich_cancel.set()
    return {"ok": True, "was_running": was_running}


@app.post("/api/enrichment/rematch")
def api_enrichment_rematch(data: dict = Body(...)):
    """The library "Refresh Metadata" button: force a fresh re-match of the
    songs the grid is SHOWING (its visible/filtered window). Resets each to
    `unscanned` so the next pass re-fetches it from scratch — EXCEPT user-pinned
    `manual` rows, which are never auto-overwritten (apply_enrichment_match
    guards that) — then kicks one pass. Scoped to the visible set on purpose:
    fast (dozens of songs), visible (tiles animate), and it can't blow the whole
    ≤1/s rate budget on a 1000-song library the way a full re-sweep would.
    Returns the filenames actually queued so the UI badges exactly those."""
    raw = (data or {}).get("filenames") or []
    fns = [str(f) for f in raw if isinstance(f, str)][:500]
    queued: list[str] = []
    for fn in fns:
        song = meta_db.enrichment_song_row(fn)
        if not song:
            continue
        h = meta_db.enrichment_content_hash(
            song["artist"], song["title"], song["album"], song["duration"])
        # allow_manual_overwrite=False → a manual pin is left as-is (returns
        # False), everything else resets to unscanned (returns True).
        if meta_db.apply_enrichment_match(fn, h, "unscanned",
                                          allow_manual_overwrite=False):
            queued.append(fn)
    started = enrichment._kick_enrich() if queued else False
    return {"queued": queued, "count": len(queued), "started": started}


@app.post("/api/enrichment/states")
def api_enrichment_states(data: dict = Body(...)):
    """Per-tile match states for the grid's VISIBLE window during a metadata
    refresh: the client posts the filenames it is showing and gets back each
    one's match_state (+ the song being matched right now, + whether a pass is
    running), so a card can animate queued→working→result without a per-song
    round-trip. Read-only — safe for demo visitors (no network, no mutation)."""
    raw = (data or {}).get("filenames") or []
    # Bound the batch: a visible grid window is dozens of cards; cap defensively.
    fns = [str(f) for f in raw if isinstance(f, str)][:500]
    return {
        "states": meta_db.enrichment_states_for(fns),
        "current": enrichment._enrich_status.get("current"),
        "running": enrichment._enrich_status["running"],
    }


@app.post("/api/enrichment/refresh/{filename:path}")
def api_enrichment_refresh(filename: str):
    """The context menu's "Refresh metadata": reset THIS song's match to
    unscanned (canonical values + candidates cleared, backoff zeroed) and
    kick a pass so it re-matches immediately. An EXPLICIT user action, so it
    may discard a manual pin — the automation never does, but the user
    asking for a re-match is the one party who owns that pin."""
    song = meta_db.enrichment_song_row(filename)
    if not song:
        raise HTTPException(status_code=404, detail="unknown song")
    h = meta_db.enrichment_content_hash(
        song["artist"], song["title"], song["album"], song["duration"])
    meta_db.apply_enrichment_match(filename, h, "unscanned",
                                   allow_manual_overwrite=True)
    return {"ok": True, "started": enrichment._kick_enrich()}


@app.get("/api/enrichment/review")
def api_enrichment_review(limit: int = 200):
    """The Match-Review queue: songs whose text match landed in the medium-
    confidence review tier, each with its stored candidate list — the drawer
    renders straight from this, no MusicBrainz round-trip. Ordered by the
    user's enrich_review_order setting."""
    limit = max(1, min(int(limit), 500))
    cfg = _load_config(CONFIG_DIR / "config.json") or {}
    order = cfg.get("enrich_review_order", "missing_first")
    return {
        "songs": meta_db.enrichment_review_queue(limit=limit, order=order),
        "total_review": meta_db.enrichment_state_counts().get("review", 0),
    }


@app.post("/api/enrichment/review/{filename:path}/accept")
def api_enrichment_accept(filename: str, data: dict = Body(...)):
    """Accept one of the stored review candidates: the row becomes a
    user-pinned `manual` match (never auto-reset). Display-only, like every
    enrichment write — nothing touches the pack file."""
    recording_id = str((data or {}).get("recording_id") or "")
    row = meta_db.get_enrichment(filename)
    if not row or row["match_state"] != "review":
        raise HTTPException(status_code=404, detail="no review row for this song")
    cand = next((c for c in (row.get("candidates") or [])
                 if c.get("recording_id") == recording_id), None)
    if not cand:
        raise HTTPException(status_code=404, detail="candidate not in the stored list")
    if not meta_db.set_enrichment_manual(filename, cand, source="review"):
        raise HTTPException(status_code=404, detail="unknown song")
    return {"ok": True, "enrichment": meta_db.get_enrichment(filename)}


@app.post("/api/enrichment/review/{filename:path}/reject")
def api_enrichment_reject(filename: str):
    """"None of these" — clears any canonical values and parks the row as
    failed/rejected (never auto-retried; editing the song's metadata
    re-queues it). Valid from `review` or `matched`, never from `manual`."""
    if not meta_db.set_enrichment_rejected(filename):
        raise HTTPException(status_code=404, detail="no rejectable match for this song")
    return {"ok": True, "enrichment": meta_db.get_enrichment(filename)}


# The candidate fields a manual pick is allowed to carry — the payload comes
# from our own /api/enrichment/search proxy, but the route re-sanitizes so a
# hand-rolled client can't stuff arbitrary keys/types into the cache row.
_CAND_STR_FIELDS = ("recording_id", "title", "artist", "artist_id",
                    "artist_sort", "release_id", "album", "year", "isrc")


def _sanitize_candidate(raw: dict) -> dict | None:
    if not isinstance(raw, dict):
        return None
    out = {k: str(raw.get(k) or "") for k in _CAND_STR_FIELDS}
    if not out["recording_id"] or not out["title"]:
        return None
    genres = raw.get("genres") or []
    out["genres"] = [str(g) for g in genres if isinstance(g, str)][:5] \
        if isinstance(genres, list) else []
    return out


@app.post("/api/enrichment/review/{filename:path}/pick")
def api_enrichment_pick(filename: str, data: dict = Body(...)):
    """Fix-match / manual search-and-pick: pin a candidate the user found via
    /api/enrichment/search (not limited to the stored review list — this is
    the escape hatch for a wrong auto-match too). Sets `manual`, the
    highest-authority state."""
    cand = _sanitize_candidate((data or {}).get("candidate"))
    if not cand:
        raise HTTPException(status_code=400, detail="candidate needs recording_id + title")
    if not meta_db.set_enrichment_manual(filename, cand, source="search"):
        raise HTTPException(status_code=404, detail="unknown song")
    return {"ok": True, "enrichment": meta_db.get_enrichment(filename)}


@app.get("/api/enrichment/search")
def api_enrichment_search(artist: str = "", title: str = "", limit: int = 8,
                          filename: str = "", duration: float = 0.0):
    """Manual-search proxy to MusicBrainz (throttled + identified like the
    background matcher — a user typing in the drawer must not sidestep the
    rate limit). `filename` optionally scores results against that song's
    stored identity (year/duration corroboration) instead of just the typed
    text. `duration` (seconds) lets a caller that HAS the audio but no library
    row — e.g. the editor's create modal, which holds the master track — pass
    its length so the studio take ranks above live/extended cuts. Sync route on
    purpose: FastAPI runs it in the threadpool, so the throttle's sleep never
    blocks the event loop."""
    if not (artist.strip() or title.strip()):
        raise HTTPException(status_code=400, detail="artist or title required")
    limit = max(1, min(int(limit), 25))
    try:
        cands = enrichment._mb_search_recordings(artist, title, limit=limit)
    except enrichment.EnrichTransportError as e:
        return JSONResponse({"error": "musicbrainz unavailable", "detail": str(e)},
                            status_code=503)
    ref = None
    if filename:
        ref = meta_db.enrichment_song_row(filename)
    if ref is None:
        ref = {"artist": artist, "title": title}
    # A caller-supplied duration corroborates the take even without a library row.
    if duration and duration > 0 and not ref.get("duration"):
        ref = dict(ref)
        ref["duration"] = duration
    # Alias-enrich so a non-Latin-primary artist (大橋純子) ranks by its
    # romanized alias against the typed query ("Junko Ohashi") instead of
    # sinking to the bottom with a 0 artist score.
    try:
        enrichment._alias_enrich(ref, cands)
    except enrichment.EnrichTransportError:
        pass   # aliases are a ranking nicety here; fall back to primary-name scoring
    return {"candidates": mb_match.rank_candidates(ref, cands)}


@app.post("/api/enrichment/identify")
async def api_enrichment_identify(request: Request):
    """Identify a song by AUDIO FINGERPRINT (AcoustID) rather than text — the
    reliable way to get the EXACT recording/version (the studio take, not a live
    bootleg or an extended cut). Upload the master audio; returns candidates in
    the same shape as /search, so the review UI and the editor's Match popup can
    render fingerprint hits identically. 412 `needs_setup` when the user hasn't
    opted in / has no key (the UI nudges them to Settings); 503 when it's set up
    but the fpcalc Chromaprint binary is missing or the network is off. Async so
    the multipart is size-capped BEFORE spooling; the blocking fpcalc subprocess
    + AcoustID HTTP run in the threadpool via run_in_executor."""
    gate = enrichment._acoustid_gate()
    if gate is not None:
        return gate
    # Pre-parse Content-Length guard — reject an oversized body before Starlette
    # spools the multipart to temp disk (mirrors the song-upload endpoint). The
    # per-part cap below is the authoritative limit; this is the fast up-front no.
    cl = request.headers.get("content-length")
    if cl is not None:
        try:
            cl_int = int(cl)
        except ValueError:
            return JSONResponse({"error": "Invalid Content-Length header"}, status_code=400)
        if cl_int > enrichment._ACOUSTID_MAX_UPLOAD_BYTES + enrichment._MULTIPART_OVERHEAD_SLACK:
            return JSONResponse({"error": "audio upload too large (256 MB max)"}, status_code=413)
    try:
        form = await request.form(max_part_size=enrichment._ACOUSTID_MAX_UPLOAD_BYTES)
    except Exception:
        return JSONResponse({"error": "audio upload too large (256 MB max)"}, status_code=413)
    file = form.get("file")
    if not isinstance(file, UploadFile):
        raise HTTPException(status_code=400, detail="missing file upload")
    import tempfile
    ext = (Path(file.filename or "").suffix or ".bin").lower()
    tmpdir = tempfile.mkdtemp(prefix="feedback_acoustid_")
    tmp = os.path.join(tmpdir, "audio" + ext)
    try:
        total = 0
        with open(tmp, "wb") as fh:
            while True:
                chunk = await file.read(1024 * 1024)
                if not chunk:
                    break
                total += len(chunk)
                if total > enrichment._ACOUSTID_MAX_UPLOAD_BYTES:
                    return JSONResponse(
                        {"error": "audio upload too large (256 MB max)"}, status_code=413)
                fh.write(chunk)
        if total == 0:
            raise HTTPException(status_code=400, detail="empty upload")
        # fpcalc subprocess + AcoustID HTTP are blocking — off the event loop.
        cands = await asyncio.get_event_loop().run_in_executor(
            None, enrichment._identify_by_fingerprint, tmp)
    except enrichment.EnrichTransportError as e:
        return JSONResponse({"error": "acoustid unavailable", "detail": str(e)},
                            status_code=503)
    finally:
        shutil.rmtree(tmpdir, ignore_errors=True)
    return {"candidates": cands}


@app.post("/api/enrichment/identify/{filename:path}")
def api_enrichment_identify_song(filename: str):
    """Identify an EXISTING library song by AUDIO FINGERPRINT — the library-side
    counterpart to /api/enrichment/identify (which takes an upload). Fingerprints
    the song's own master audio on disk (the manual "Identify by audio" action in
    the Fix-metadata / match-review flow). Same candidate shape as /search, so the
    review UI renders fingerprint hits like text hits. Same 412/503 gating; 404
    when the song has no full-mix audio to fingerprint."""
    gate = enrichment._acoustid_gate()
    if gate is not None:
        return gate
    audio = enrichment._song_audio_file(filename)
    if not audio:
        return JSONResponse(
            {"error": "no audio",
             "detail": "couldn't find this song's master audio to fingerprint "
                       "(a stems-only pack has no full mix to identify)."},
            status_code=404)
    try:
        cands = enrichment._identify_by_fingerprint(audio)
    except enrichment.EnrichTransportError as e:
        return JSONResponse({"error": "acoustid unavailable", "detail": str(e)},
                            status_code=503)
    return {"candidates": cands}


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
    if not _kick_scan():
        return {"message": "Scan already in progress"}
    return {"message": "Rescan started"}


@app.post("/api/rescan/full")
def trigger_full_rescan():
    """Clear cache and rescan everything."""
    if _scan_status["running"]:
        return {"message": "Scan already in progress"}
    with meta_db._lock:
        # Force every file to re-scan by invalidating the mtime cache (get()
        # keys on mtime equality) WITHOUT emptying `songs` — keeping the rows
        # means the table is never transiently empty mid-scan, so the
        # existing-song stats/playlist read-filter stays correct throughout.
        # delete_missing() prunes anything genuinely gone at the end.
        meta_db.conn.execute("UPDATE songs SET mtime = -1")
        meta_db.conn.commit()
    if not _kick_scan():
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


# Publish the scan/ingest seam for routers/song.py. These stay here (the scan
# lifecycle owns them); scan_status is a getter so the reassigned dict stays live.
appstate.configure(
    kick_scan=_kick_scan,
    invalidate_song_caches=_invalidate_song_caches,
    stat_for_cache=_stat_for_cache,
    scan_status=lambda: _scan_status,
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

# MB artist url-relation types → the page's link slots (locked position 4:
# whitelist only, links-only forever). Everything not listed is dropped.
_ARTIST_URL_REL_SLOTS = {
    "official homepage": "official",
    "setlistfm": "tour",
    "concerts": "tour",
    "youtube": "video",
    "video channel": "video",
    "social network": "social",
    "bandcamp": "social",
    "soundcloud": "social",
    "wikipedia": "wikipedia",
    "wikidata": "wikipedia",
}


def _artist_links_from_mb(body: dict) -> tuple[dict, list]:
    """Whitelist an MB artist doc's url-relations into the page's link slots:
    {official, tour, video, social: [...], wikipedia}. Every URL passes the
    same http(s)-scheme gate as art redirects (_safe_art_redirect_url) so a
    hostile javascript:/data:/file: resource can never reach an href. First
    URL wins per single slot; social collects up to 5; wikipedia is preferred
    over wikidata when both exist. Also returns MB's genre names (capped)."""
    links: dict = {}
    social: list = []
    wikidata_url = None
    for rel in (body or {}).get("relations") or []:
        if not isinstance(rel, dict):
            continue
        rtype = str(rel.get("type") or "").strip().lower()
        slot = _ARTIST_URL_REL_SLOTS.get(rtype)
        if not slot:
            continue
        url = rel.get("url")
        url = url.get("resource") if isinstance(url, dict) else url
        if _safe_art_redirect_url(url) is None:
            continue
        if slot == "social":
            if url not in social and len(social) < 5:
                social.append(url)
        elif rtype == "wikidata":
            wikidata_url = wikidata_url or url
        elif slot not in links:
            links[slot] = url
    if social:
        links["social"] = social
    if "wikipedia" not in links and wikidata_url:
        links["wikipedia"] = wikidata_url
    genres = [str(g.get("name")) for g in (body or {}).get("genres") or []
              if isinstance(g, dict) and g.get("name")]
    return links, genres[:8]


def _artist_links_payload(name: str, force: bool = False) -> dict:
    """Shared by GET links + POST refresh. Order of gates: the user's opt-in
    setting (external links are OFF by default — the dev-chat thread's call),
    then a known mb_artist_id (no id → nothing to look up), then the cache
    (unless force), then the offline guard, then ONE throttled fetch."""
    cfg = _load_config(CONFIG_DIR / "config.json") or _default_settings()
    if cfg.get("artist_external_links") is not True:
        return {"links": {}, "matched": False, "disabled": True}
    canonical = meta_db._terminal_canonical((name or "").strip())
    mbid = meta_db.artist_known_mb_id(meta_db._raw_variants_for(canonical))
    mbid = (mbid or "").strip().lower()
    # The id is interpolated into the MB request path — same strict-shape rule
    # as the manifest identity keys (_MBID_RE), so a junk/hostile value stored
    # via a hand-rolled /pick body can never reach the request line.
    if not mbid or not enrichment._MBID_RE.match(mbid):
        return {"links": {}, "matched": False}
    if not force:
        cached = meta_db.get_artist_enrichment(mbid)
        if cached:
            return {"links": cached["url_rels"], "genres": cached["genres"],
                    "matched": True, "cached": True, "mb_artist_id": mbid}
    if not enrichment._enrich_network_enabled():
        return {"links": {}, "matched": True, "offline": True, "mb_artist_id": mbid}
    try:
        body = enrichment._mb_http_get(f"artist/{mbid}", {"inc": "url-rels+genres+tags"})
    except enrichment.EnrichTransportError:
        return {"links": {}, "matched": True, "offline": True, "mb_artist_id": mbid}
    links, genres = _artist_links_from_mb(body or {})
    meta_db.put_artist_enrichment(mbid, links, genres)
    return {"links": links, "genres": genres, "matched": True, "cached": False,
            "mb_artist_id": mbid}


@app.get("/api/artist/{name:path}/page")
def api_artist_page(name: str):
    """The artist page's all-LOCAL payload — counts, albums, aliases, similar-
    in-library, mosaic art, play-all seed. Never touches the network; an
    unmatched or even unknown artist still returns a functional page."""
    return meta_db.artist_page(name)


@app.get("/api/artist/{name:path}/links")
def api_artist_links(name: str):
    """External links for a matched artist — cached after the first call.
    Sync route on purpose (like /api/enrichment/search): FastAPI runs it in
    the threadpool so the MB throttle's sleep never blocks the event loop."""
    return _artist_links_payload(name)


@app.post("/api/artist/{name:path}/links/refresh")
def api_artist_links_refresh(name: str):
    """Explicit re-fetch of the cached links (the page's manual Refresh)."""
    return _artist_links_payload(name, force=True)
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


def _resolve_sloppak_local_file(filename: str, rel_path: str):
    """Resolve a file inside a sloppak to its on-disk path.

    Applies the same containment guards as ``serve_sloppak_file``. Returns the
    resolved ``Path`` on success, or an ``(error, status)`` tuple on failure so
    callers can produce their endpoint-appropriate response.
    """
    dlc = _get_dlc_dir()
    if not dlc:
        return ("not configured", 404)
    # `filename` is caller-controlled. Contain it under DLC_DIR before it
    # reaches the resolver (see serve_sloppak_file for the traversal rationale).
    resolved = _resolve_dlc_path(dlc, filename)
    if resolved is None:
        return ("forbidden", 403)
    # Confine to actual sloppak bundles — otherwise any plain subdirectory
    # would become a read-any-file-under-DLC_DIR source.
    if not sloppak_mod.is_sloppak(resolved):
        return ("not found", 404)
    # Canonicalise the cache key against the resolved path so equivalent URL
    # forms of the same sloppak converge on one _source_cache entry.
    try:
        filename = resolved.relative_to(dlc.resolve()).as_posix()
    except ValueError:
        # safe_join already proved containment; fail closed regardless.
        return ("forbidden", 403)
    src = sloppak_mod.get_cached_source_dir(filename)
    if src is None:
        try:
            src = sloppak_mod.resolve_source_dir(filename, dlc, SLOPPAK_CACHE_DIR)
        except Exception:
            return ("not found", 404)
    # Prevent path traversal within the sloppak.
    target = (src / rel_path).resolve()
    try:
        target.relative_to(src.resolve())
    except ValueError:
        return ("forbidden", 403)
    if not target.exists() or not target.is_file():
        return ("not found", 404)
    return target


@app.get("/api/sloppak/{filename:path}/file/{rel_path:path}")
def serve_sloppak_file(filename: str, rel_path: str):
    """Serve a file from inside a sloppak (stems, cover, etc.)."""
    result = _resolve_sloppak_local_file(filename, rel_path)
    if isinstance(result, tuple):
        error, status = result
        return JSONResponse({"error": error}, status)
    target = result
    ext = target.suffix.lower()
    mt = {
        ".ogg": "audio/ogg", ".opus": "audio/ogg", ".oga": "audio/ogg",
        ".mp3": "audio/mpeg", ".wav": "audio/wav", ".flac": "audio/flac",
        ".m4a": "audio/mp4",
        ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
        ".png": "image/png", ".webp": "image/webp",
        ".json": "application/json",
    }.get(ext)
    return FileResponse(str(target), media_type=mt) if mt else FileResponse(str(target))


# ── Highway chart WebSocket ──────────────────────────────────────────────────
# Mounted here, where the handler used to be defined (registration order).
# Implementation in lib/routers/ws_highway.py.
app.include_router(ws_highway.router)


# ── Audio serving ─────────────────────────────────────────────────────────────


@app.get("/api/audio-local-path")
def audio_local_path(url: str, request: Request):
    """Return absolute local filesystem path for a song URL (Electron desktop only).

    Accepts ``/audio/<path>`` where ``<path>`` may include subdirectory segments —
    no scheme, no host, no query string, no fragment.  The resolved path must stay
    inside AUDIO_CACHE_DIR or STATIC_DIR; ``..`` traversal, backslashes, and
    absolute ``filename`` values are rejected.

    Also accepts ``/api/sloppak/<filename>/file/<rel>`` (percent-encoded, as
    emitted by the highway song payload) and resolves it to the unpacked
    sloppak cache file via the same containment guards as
    ``serve_sloppak_file`` — this lets the desktop engine play a feedpak
    full-mix natively under WASAPI-exclusive output.

    This endpoint returns a raw filesystem path and is intended exclusively for
    the Electron desktop process (which runs on loopback). Requests from non-
    loopback clients are rejected with 403.
    """
    # Loopback-only — only the local Electron process should call this
    client_host = request.client.host if request.client else None
    try:
        is_loopback = bool(client_host and ipaddress.ip_address(client_host).is_loopback)
    except ValueError:
        is_loopback = client_host == "localhost"
    if not is_loopback:
        return JSONResponse({"error": "forbidden"}, status_code=403)
    # Sloppak in-pack file (feedpak full-mix): /api/sloppak/<fn>/file/<rel>.
    # Both segments arrive percent-encoded (built with urllib quote() in the
    # highway payload); decode before handing to the shared resolver, which
    # re-applies all containment guards on the decoded values.
    slop_match = re.fullmatch(r"/api/sloppak/([^?#]+)/file/([^?#]+)", url)
    if slop_match:
        from urllib.parse import unquote

        result = _resolve_sloppak_local_file(
            unquote(slop_match.group(1)), unquote(slop_match.group(2))
        )
        if isinstance(result, tuple):
            error, status = result
            return JSONResponse({"error": error}, status_code=status)
        return JSONResponse({"path": str(result)})
    # Accept only simple /audio/<filename> — no scheme, no host, no query/fragment
    if not re.fullmatch(r"/audio/[^?#]+", url):
        return JSONResponse({"error": "invalid url"}, status_code=400)
    filename = url[len("/audio/"):]
    # Reject traversal, absolute paths, and backslash separators
    if ".." in filename.split("/") or filename.startswith("/") or "\\" in filename:
        return JSONResponse({"error": "invalid url"}, status_code=400)
    for d in [AUDIO_CACHE_DIR, STATIC_DIR]:
        candidate = (d / filename).resolve()
        # Ensure resolved path is inside the allowed directory
        try:
            candidate.relative_to(d.resolve())
        except ValueError:
            continue
        if candidate.is_file():
            return JSONResponse({"path": str(candidate)})
    return JSONResponse({"error": "not found"}, status_code=404)


@app.get("/audio/{filename:path}")
def serve_audio(filename: str):
    """Serve audio files from the writable audio cache directory."""
    # Reject traversal attempts and absolute-path components
    if ".." in filename.split("/") or filename.startswith("/") or "\\" in filename:
        return JSONResponse({"error": "not found"}, status_code=404)
    for d in [AUDIO_CACHE_DIR, STATIC_DIR]:
        candidate = (d / filename).resolve()
        try:
            candidate.relative_to(d.resolve())
        except ValueError:
            continue
        if candidate.is_file():
            return FileResponse(str(candidate))
    return JSONResponse({"error": "not found"}, status_code=404)


app.mount("/static", StaticFiles(directory=str(STATIC_DIR)), name="static")


@app.get("/")
def index():
    # fee[dB]ack v0.3.0: the v3 shell is now the DEFAULT at `/`. The classic v2
    # UI remains fully available as a fallback — opt back in with
    # FEEDBACK_UI=v2 (or =legacy), or hit the dedicated /v2 route below (which
    # serves it regardless of the env var).
    if getenv_compat("FEEDBACK_UI") or getenv_compat("FEEDBACK_UI") in ("v2", "legacy"):
        return FileResponse(str(STATIC_DIR / "index.html"))
    return FileResponse(str(STATIC_DIR / "v3" / "index.html"))


@app.get("/v3")
def index_v3():
    # Always serve the v0.3.0 shell, independent of the env var (kept for
    # explicit/back-compat links even though `/` now defaults to v3).
    return FileResponse(str(STATIC_DIR / "v3" / "index.html"))


@app.get("/v2")
def index_v2():
    # Always serve the classic v2 UI, independent of the env var, so the
    # fallback is reachable without flipping FEEDBACK_UI.
    return FileResponse(str(STATIC_DIR / "index.html"))
