"""FeedBack — FastAPI backend serving highway viewer + library."""

import asyncio
import bisect
import hashlib
import json
import logging
import math
import os
import secrets
import stat
import sys
import tempfile
import shutil
from pathlib import Path
from typing import Any, ClassVar

from logging_setup import configure_logging
from env_compat import getenv_compat
configure_logging()

log = logging.getLogger("feedBack.server")

from fastapi import Body, FastAPI, WebSocket, WebSocketDisconnect, UploadFile, File, HTTPException, Query
from fastapi.concurrency import run_in_threadpool
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse, JSONResponse, RedirectResponse, Response, StreamingResponse

from safepath import safe_join
from song import (
    anchor_to_wire,
    arrangement_string_count,
    base_open_string_midis,
    compute_smart_names,
    chord_template_to_wire,
    chord_to_wire,
    hand_shape_to_wire,
    key_to_tonic_pc,
    load_song,
    note_to_wire,
    phrase_to_wire,
    pitch_from_base,
    scale_degree_for_pitch,
)
from audio import find_wem_files, convert_wem
from tunings import (
    DEFAULT_REFERENCE_PITCH, DEFAULT_TUNINGS, PROFILE_IDS, PROFILE_PATHWAYS,
    TUNING_PRESET_MIDIS, apply_flat_instrument_patch_to_profiles,
    apply_reference_pitch, freqs_to_midis, normalize_instrument_profile,
    normalize_instrument_profiles, settings_with_instrument_profiles,
    tuning_name,
)
# The library metadata cache. `MetadataDB` and the query helpers it owns live in
# their own module; the `meta_db` singleton below stays here. The private names
# are re-imported because callers outside the DB layer still use them.
from metadata_db import (
    MetadataDB,
    _arr_smart_sort_key,
    _artist_title_from_filename,
    _as_int,
    _effective_keyset_sort,
    _sqlite_file_integrity_ok,
    _tuning_group_key_sql,
    next_library_cursor,
)
# The audio-effect routing index. Same shape as metadata_db: the class lives in
# its own module, the `audio_effect_mappings` singleton below stays here.
from audio_effects_db import AudioEffectsMappingDB
# The router seam. Imported as a module (never `from appstate import ...`) so
# `appstate.configure(...)` below publishes into the same namespace routers read.
import appstate
import sloppak as sloppak_mod
import drums as drums_mod
import notation as notation_mod
import loosefolder as loosefolder_mod
# Pure text-matching engine for MusicBrainz enrichment (P8): denoise/score/
# tier classification + response parsing. No network/DB in there — the
# throttled transport and the song_enrichment writes live in this module.
import mb_match
import acoustid_match
# Metadata extraction lives in a side-effect-free module so ProcessPool
# scan workers can import + unpickle _scan_one without re-running this
# module's import-time side effects (see lib/scan_worker.py).
from scan_worker import _extract_meta_for_file, _relpath, _scan_one

import concurrent.futures
import contextvars
import inspect
import ipaddress
import multiprocessing
import re
import sqlite3
import threading
import time
import uuid
import warnings
import xml.etree.ElementTree as ET

import structlog
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


_TUNING_GROUP_KEY_SQL = _tuning_group_key_sql("songs")


meta_db = MetadataDB(CONFIG_DIR)
audio_effect_mappings = AudioEffectsMappingDB(CONFIG_DIR)

# Publish the singletons to the router seam. server.py stays their owner — a
# `sys.modules.pop("server")` + re-import must keep rebuilding them under a
# patched CONFIG_DIR — and `routers/` read them back as `appstate.<name>` at
# call time. See appstate.py for why the reads must be late-bound.
appstate.configure(
    meta_db=meta_db,
    audio_effect_mappings=audio_effect_mappings,
)


class LocalLibraryProvider:
    id = "local"
    label = "My Library"
    kind = "local"
    capabilities = (
        "library.read",
        "art.read",
        "song.play",
        "favorite.write",
        "metadata.write",
    )

    def __init__(self, db: MetadataDB):
        self._db = db

    def query_page(self, **kwargs) -> tuple[list[dict], int]:
        return self._db.query_page(**kwargs)

    def query_artists(self, **kwargs) -> tuple[list[dict], int]:
        return self._db.query_artists(**kwargs)

    def query_albums(self, **kwargs) -> tuple[list[dict], int]:
        return self._db.query_albums(**kwargs)

    def query_stats(self, **kwargs) -> dict:
        return self._db.query_stats(**kwargs)

    def tuning_names(self) -> dict:
        # Group custom tunings on their raw offsets so distinct ones stay
        # distinct (tuning_name collapses them all to "Custom Tuning"); named
        # tunings keep grouping by name (stable across the rescan boundary, no
        # offsets/name split). `key` is the value the client sends back as the
        # filter selector — equal to the name for named tunings, the offsets
        # string for customs; offsets also feed the client's custom-pill label.
        with self._db._lock:
            rows = self._db.conn.execute(
                f"SELECT tuning_name, {_TUNING_GROUP_KEY_SQL} AS gkey, "
                "MIN(tuning_sort_key), COUNT(*), MIN(tuning_offsets) "
                "FROM songs WHERE title != '' AND COALESCE(tuning_name, '') != '' "
                "GROUP BY gkey COLLATE NOCASE "
                "ORDER BY ABS(COALESCE(MIN(tuning_sort_key), 0)), "
                "COALESCE(MIN(tuning_sort_key), 0) ASC, "
                "tuning_name COLLATE NOCASE"
            ).fetchall()
        return {
            "tunings": [
                {"name": name, "key": gkey, "offsets": offs or "",
                 "sort_key": int(sk or 0), "count": count}
                for name, gkey, sk, count, offs in rows
            ],
        }

    async def get_art(self, song_id: str):
        return await get_song_art(song_id)


class LibraryProviderRegistry:
    # Methods required per declared capability — only validated when the
    # provider advertises the corresponding capability so action-only providers
    # (e.g. art.read + song.sync without library.read) don't need to implement
    # unused stubs.
    _CAPABILITY_METHODS: ClassVar[dict[str, tuple[str, ...]]] = {
        "library.read": ("query_page", "query_artists", "query_stats", "tuning_names"),
        "art.read": ("get_art",),
        "song.sync": ("sync_song",),
    }
    _ID_RE: ClassVar[re.Pattern[str]] = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$")

    def __init__(self):
        self._providers: dict[str, object] = {}
        # Capabilities inferred at registration for legacy providers that omit
        # the `capabilities` field.  Merged with provider_capabilities() so that
        # runtime capability checks see the complete effective capability set.
        self._inferred_caps: dict[str, set[str]] = {}
        self._owner_plugin_ids: dict[str, str] = {}
        self._lock = threading.RLock()

    def register(self, provider: object, *, replace: bool = False, owner_plugin_id: str | None = None) -> object:
        provider_id = self.provider_id(provider)
        if not self._ID_RE.match(provider_id):
            raise ValueError(
                "library provider id must start with an alphanumeric character "
                "and contain only letters, digits, _, ., :, or -"
            )
        if not self.provider_label(provider):
            raise ValueError("library provider label must be a non-empty string")
        # Use declared-only caps during validation — never include stale inferred
        # caps from a previous provider registered under the same id (replace=True).
        caps = self._declared_capabilities(provider)
        # Backward compatibility: providers that predate explicit capability
        # declarations may omit `capabilities` entirely. If the browse methods
        # are all present, infer `library.read` so they still work unchanged.
        # If capabilities are absent but the browse surface is also absent,
        # raise a clear error rather than letting the provider register and
        # then fail on every API call with a late 501.
        inferred: set[str] = set()
        if not caps:
            browse_methods = self._CAPABILITY_METHODS["library.read"]
            if all(callable(self.provider_method(provider, m)) for m in browse_methods):
                # Legacy provider without explicit capabilities — infer library.read
                # from the presence of all browse methods.  Store in _inferred_caps
                # so that runtime capability checks see the full effective set.
                inferred = {"library.read"}
                caps = inferred
            else:
                raise TypeError(
                    f"library provider {provider_id!r} must declare at least one capability "
                    f"(or implement the {browse_methods!r} browse methods for backward compatibility)"
                )
        for cap, methods in self._CAPABILITY_METHODS.items():
            if cap not in caps:
                continue
            for method_name in methods:
                if not callable(self.provider_method(provider, method_name)):
                    raise TypeError(f"library provider {provider_id!r} declares {cap!r} but is missing callable {method_name}()")
        with self._lock:
            if provider_id == "local" and provider_id in self._providers and self._providers[provider_id] is not provider:
                raise ValueError("the local library provider cannot be replaced")
            if provider_id in self._providers and not replace:
                raise ValueError(f"library provider {provider_id!r} is already registered")
            self._providers[provider_id] = provider
            # owner_plugin_id is attribution that flows into the browser
            # capability participant id. The scoped register_library_provider
            # wrappers force it to the trusted loading plugin id, so the spoof
            # vector is closed there. Here we only normalize: trim and require a
            # non-empty string. We deliberately do NOT apply the provider-id
            # grammar (_ID_RE) — plugin ids aren't constrained to it at load
            # time, so that would silently drop attribution for valid plugins.
            owner = owner_plugin_id.strip() if isinstance(owner_plugin_id, str) else ""
            owner = owner or None
            if owner:
                self._owner_plugin_ids[provider_id] = owner
            else:
                self._owner_plugin_ids.pop(provider_id, None)
            if inferred:
                self._inferred_caps[provider_id] = inferred
            else:
                self._inferred_caps.pop(provider_id, None)
        return provider

    def unregister(self, provider_id: str) -> bool:
        if provider_id == "local":
            raise ValueError("the local library provider cannot be unregistered")
        with self._lock:
            self._inferred_caps.pop(provider_id, None)
            self._owner_plugin_ids.pop(provider_id, None)
            return self._providers.pop(provider_id, None) is not None

    def get(self, provider_id: str = "local") -> object | None:
        with self._lock:
            return self._providers.get(provider_id or "local")

    def list(self) -> list[dict]:
        with self._lock:
            providers = list(self._providers.values())
        return [self.describe(provider) for provider in providers]

    def describe(self, provider: object) -> dict:
        provider_id = self.provider_id(provider)
        with self._lock:
            owner_plugin_id = self._owner_plugin_ids.get(provider_id)
        return {
            "id": provider_id,
            "label": self.provider_label(provider),
            "kind": self.provider_field(provider, "kind", "local" if provider_id == "local" else "remote"),
            "capabilities": sorted(self.provider_capabilities(provider)),
            "owner_plugin_id": owner_plugin_id,
            "default": provider_id == "local",
        }

    def provider_field(self, provider: object, name: str, default=None):
        if isinstance(provider, dict):
            return provider.get(name, default)
        return getattr(provider, name, default)

    def provider_id(self, provider: object) -> str:
        provider_id = self.provider_field(provider, "id", "")
        if not isinstance(provider_id, str) or not provider_id:
            raise ValueError("library provider id must be a non-empty string")
        return provider_id

    def provider_label(self, provider: object) -> str:
        label = self.provider_field(provider, "label", self.provider_field(provider, "name", ""))
        if not isinstance(label, str):
            return ""
        return label.strip()

    def _declared_capabilities(self, provider: object) -> set[str]:
        """Return only the capabilities explicitly declared on the provider object."""
        raw = self.provider_field(provider, "capabilities", ())
        if raw is None:
            raw = ()
        if isinstance(raw, str):
            raw = (raw,) if raw else ()
        return {str(cap) for cap in raw if cap}

    def provider_capabilities(self, provider: object) -> set[str]:
        # Guard against a common plugin authoring mistake: passing a single string
        # instead of a list/tuple. Iterating a string produces individual characters,
        # none of which would match a valid capability name.
        declared = self._declared_capabilities(provider)
        # Merge with any capabilities inferred at registration time for legacy
        # providers that omit the `capabilities` field but implement browse methods.
        provider_id = self.provider_id(provider)
        with self._lock:
            inferred = self._inferred_caps.get(provider_id, set())
        return declared | inferred

    def provider_method(self, provider: object, name: str):
        if isinstance(provider, dict):
            return provider.get(name)
        return getattr(provider, name, None)


library_providers = LibraryProviderRegistry()
_local_library_provider = LocalLibraryProvider(meta_db)
library_providers.register(_local_library_provider)


# Keys `_library_filter_args` (and a smart collection's stored `rules`) accept.
_LIBRARY_FILTER_PARAM_KEYS = frozenset((
    "q", "favorites", "format", "artist", "album",
    "arrangements_has", "arrangements_lacks", "stems_has", "stems_lacks",
    "has_lyrics", "tunings",
))
# Rules mirror the raw /api/library query params (so the provider can feed them
# straight through `_library_filter_args`, and the frontend can build a rule from
# the same query string it already constructs). Multi-value filters are CSV
# strings; `favorites` is 0/1; the rest are plain strings.
_RULE_CSV_KEYS = frozenset((
    "tunings", "arrangements_has", "arrangements_lacks", "stems_has", "stems_lacks",
))
_RULE_STR_KEYS = frozenset(("q", "format", "artist", "album", "has_lyrics", "sort"))


def _sanitize_collection_rules(raw) -> dict:
    """Normalize rules to the raw query-param format, keeping only known keys. A
    list for a multi-value filter is joined to CSV; `favorites` becomes 0/1.
    Unknown keys are dropped so a rule survives a filter-vocab change rather than
    500-ing. Applied at API ingress AND when a provider loads a persisted row, so
    a hand-edited / imported bad value (e.g. an int where a string is expected,
    or a list for `sort`) can never crash a query."""
    if not isinstance(raw, dict):
        return {}
    out: dict = {}
    for k, v in raw.items():
        if k in _RULE_CSV_KEYS:
            if isinstance(v, list):
                vals = [str(x) for x in v if isinstance(x, (str, int)) and not isinstance(x, bool)]
            elif isinstance(v, str):
                vals = [s for s in (p.strip() for p in v.split(",")) if s]
            else:
                continue
            if vals:
                out[k] = ",".join(vals)
        elif k == "favorites":
            if v:
                out[k] = 1
        elif k in _RULE_STR_KEYS:
            if isinstance(v, (str, int)) and not isinstance(v, bool):
                s = str(v).strip()
                if s:
                    out[k] = s
    return out


class SmartCollectionProvider:
    """A saved library filter, surfaced as a source (#636 item 2). Browse/stats
    delegate to the local DB with the collection's stored `rules` applied — so
    selecting it in the v3 source picker shows exactly that filtered slice with
    the whole Songs UI (paging, stats, A–Z rail, art) for free. P1: the rules
    ARE the query (live in-collection search is a P2 nicety). The matched songs
    are local rows, so `kind="local"` keeps the client's play/art paths on the
    local (not remote-sync) branch and art delegates straight through."""
    kind = "local"
    capabilities = ("library.read", "art.read")

    def __init__(self, collection: dict, local: "LocalLibraryProvider"):
        self._local = local
        self.update(collection)

    def update(self, collection: dict) -> None:
        self.id = f"collection:{collection['id']}"
        self.collection_id = collection["id"]
        self.label = collection.get("name") or "Collection"
        # Re-sanitize on load: persisted JSON may predate the current vocab or
        # have been hand-edited; never let a bad value reach a query.
        self._rules = _sanitize_collection_rules(collection.get("rules") or {})

    def _filter_kwargs(self) -> dict:
        return _library_filter_args(**{k: v for k, v in self._rules.items()
                                       if k in _LIBRARY_FILTER_PARAM_KEYS})

    def _sort(self, fallback: str) -> str:
        # A collection may pin its own sort (e.g. "recently added"); query_page
        # falls back safely for an unknown value, so no validation needed here.
        return self._rules.get("sort") or fallback

    def query_page(self, *, page=0, size=24, sort="artist", direction="asc",
                   naming_mode="legacy", **_ignore):
        return self._local._db.query_page(
            page=page, size=size, sort=self._sort(sort), direction=direction,
            naming_mode=naming_mode, **self._filter_kwargs())

    def query_artists(self, *, letter="", page=0, size=50, naming_mode="legacy", **_ignore):
        return self._local._db.query_artists(
            letter=letter, page=page, size=size, naming_mode=naming_mode,
            **self._filter_kwargs())

    def query_albums(self, *, page=0, size=120, naming_mode="legacy", **_ignore):
        return self._local._db.query_albums(
            page=page, size=size, naming_mode=naming_mode, **self._filter_kwargs())

    def query_stats(self, *, sort="artist", want_sort_letters=False,
                    naming_mode="legacy", **_ignore):
        return self._local._db.query_stats(
            sort=self._sort(sort), want_sort_letters=want_sort_letters,
            naming_mode=naming_mode, **self._filter_kwargs())

    def tuning_names(self):
        return self._local.tuning_names()

    async def get_art(self, song_id: str):
        return await self._local.get_art(song_id)


def _sync_collection_provider(collection: dict) -> None:
    """Register (or replace) the provider for one collection."""
    library_providers.register(
        SmartCollectionProvider(collection, _local_library_provider), replace=True)


def _unregister_collection_provider(pid: int) -> None:
    library_providers.unregister(f"collection:{pid}")


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


def _get_library_provider(provider: str = "local") -> object:
    library_provider = library_providers.get(provider or "local")
    if library_provider is None:
        raise HTTPException(status_code=404, detail=f"Unknown library provider: {provider}")
    return library_provider


def _require_library_provider_capability(provider: object, capability: str) -> None:
    if capability in library_providers.provider_capabilities(provider):
        return
    provider_id = library_providers.provider_id(provider)
    raise HTTPException(
        status_code=501,
        detail=f"Library provider {provider_id!r} does not declare capability {capability!r}",
    )


_OPTIONAL_NEW_PROVIDER_KWARGS = ("naming_mode", "sort", "want_sort_letters", "after",
                                 "mastery", "match_states")


def _filter_provider_kwargs(method: object, kwargs: dict) -> dict:
    """Drop kwargs that the method's signature does not declare.

    Provides backward-compat for third-party library providers whose
    query_page/query_artists/query_stats methods were written before
    naming_mode was added — calling them with the extra kwarg would
    raise TypeError and return a 500 to the client.

    When ``inspect.signature`` cannot introspect the method (rare: C
    extensions / built-ins / exotic callables), fall back to stripping
    only the kwargs we know were added later — older providers won't
    accept them, anything else stays so the call still works.
    """
    try:
        sig = inspect.signature(method)  # type: ignore[arg-type]
        for p in sig.parameters.values():
            if p.kind == inspect.Parameter.VAR_KEYWORD:
                return kwargs  # method accepts **kwargs, pass everything
        return {k: v for k, v in kwargs.items() if k in sig.parameters}
    except (ValueError, TypeError):
        return {k: v for k, v in kwargs.items() if k not in _OPTIONAL_NEW_PROVIDER_KWARGS}


def _call_library_provider(provider: object, method_name: str, **kwargs) -> Any:
    method = library_providers.provider_method(provider, method_name)
    if not callable(method):
        provider_id = library_providers.provider_id(provider)
        raise HTTPException(
            status_code=501,
            detail=f"Library provider {provider_id!r} does not support {method_name}",
        )
    try:
        return method(**_filter_provider_kwargs(method, kwargs))
    except HTTPException:
        raise
    except Exception as exc:
        provider_id = library_providers.provider_id(provider)
        # A provider with an explicit kind="local" is treated as local even if
        # its id is not "local" (e.g. a kind="local" plugin variant). Otherwise
        # fall back to provider_id comparison so providers that omit `kind` are
        # still wrapped correctly — the safe default for unknown providers is to
        # surface an offline message rather than leaking raw exceptions.
        provider_kind = str(library_providers.provider_field(provider, "kind", "") or "")
        if provider_kind:
            is_remote = provider_kind not in ("", "local")
        else:
            is_remote = provider_id != "local"
        if is_remote:
            detail = f"This source appears to be offline ({provider_id})."
            message = str(exc).strip()
            if message:
                detail = f"{detail} {message}"
            raise HTTPException(status_code=503, detail=detail) from exc
        raise


def _is_async_callable(obj: object) -> bool:
    """Return True if obj is an async function or a callable object with an async __call__.

    ``inspect.iscoroutinefunction`` only recognises bare coroutine functions; it returns
    False for class instances whose ``__call__`` method is defined as ``async def``.
    Checking both handles the common plugin pattern of wrapping an async method in a
    callable object.
    """
    if inspect.iscoroutinefunction(obj):
        return True
    _call = getattr(obj, "__call__", None)
    return _call is not None and inspect.iscoroutinefunction(_call)


async def _call_library_provider_async(provider: object, method_name: str, **kwargs) -> Any:
    method = library_providers.provider_method(provider, method_name)
    if _is_async_callable(method):
        # Async provider method — call directly on the event loop.
        try:
            return await method(**_filter_provider_kwargs(method, kwargs))
        except HTTPException:
            raise
        except Exception as exc:
            provider_id = library_providers.provider_id(provider)
            provider_kind = str(library_providers.provider_field(provider, "kind", "") or "")
            if provider_kind:
                is_remote = provider_kind not in ("", "local")
            else:
                is_remote = provider_id != "local"
            if is_remote:
                detail = f"This source appears to be offline ({provider_id})."
                message = str(exc).strip()
                if message:
                    detail = f"{detail} {message}"
                raise HTTPException(status_code=503, detail=detail) from exc
            raise
    # Synchronous provider method — run in a threadpool so the event loop stays free.
    return await run_in_threadpool(_call_library_provider, provider, method_name, **kwargs)


def _safe_art_redirect_url(url: str) -> str | None:
    """Return the URL if it is safe to redirect to (http/https only), else None."""
    from urllib.parse import urlparse
    if not url or not isinstance(url, str):
        return None
    try:
        parsed = urlparse(url)
        if parsed.scheme.lower() not in ("http", "https"):
            return None
        if not parsed.hostname:
            return None
        return url
    except Exception:
        return None


def _library_art_response(result: Any) -> Response:
    if result is None:
        raise HTTPException(status_code=404, detail="Library provider returned no art")
    if isinstance(result, Response):
        return result
    if isinstance(result, (bytes, bytearray, memoryview)):
        return Response(content=bytes(result), media_type="image/png")
    if isinstance(result, str):
        safe_url = _safe_art_redirect_url(result)
        if safe_url is not None:
            return RedirectResponse(safe_url)
        # If the string looks like a URL (contains a scheme separator) but
        # didn't pass the http/https check, refuse it rather than treating
        # it as a filesystem path — a provider returning ftp:// or file://
        # should get a 400, not a 500 from FileResponse failing on a URL.
        if "://" in result:
            raise HTTPException(
                status_code=400,
                detail="Library provider returned an unsupported URL scheme for art",
            )
        if not Path(result).is_file():
            raise HTTPException(status_code=404, detail="Library provider returned an unreadable art path")
        return FileResponse(result)
    if isinstance(result, Path):
        if not result.is_file():
            raise HTTPException(status_code=404, detail="Library provider returned an unreadable art path")
        return FileResponse(str(result))
    if isinstance(result, dict):
        url = result.get("url") or result.get("art_url") or result.get("artUrl")
        if isinstance(url, str) and url:
            safe_url = _safe_art_redirect_url(url)
            if safe_url is None:
                raise HTTPException(status_code=400, detail="Library provider returned an unsafe art URL")
            return RedirectResponse(safe_url)
        path = result.get("path") or result.get("file")
        if isinstance(path, (str, Path)):
            media_type = result.get("media_type") or result.get("content_type")
            if not Path(path).is_file():
                raise HTTPException(status_code=404, detail="Library provider returned an unreadable art path")
            return FileResponse(str(path), media_type=media_type)
        content = result.get("content") or result.get("bytes")
        if isinstance(content, (bytes, bytearray, memoryview)):
            media_type = result.get("media_type") or result.get("content_type") or "image/png"
            return Response(content=bytes(content), media_type=media_type)
    raise HTTPException(status_code=500, detail="Library provider returned unsupported art data")


def _get_dlc_dir(cfg: dict | None = None) -> Path | None:
    # Only consider DLC_DIR if the env var was non-empty. `Path("")` collapses
    # to `.` and reports `.is_dir() == True`, which would silently shadow the
    # config.json fallback. Checking the raw env string preserves
    # `DLC_DIR=.` as a valid opt-in for cwd while keeping unset/empty out.
    if _DLC_DIR_ENV and DLC_DIR.is_dir():
        return DLC_DIR
    if cfg is None:
        config_file = CONFIG_DIR / "config.json"
        if config_file.exists():
            try:
                cfg = json.loads(config_file.read_text(encoding="utf-8"))
            except Exception:
                pass
    if isinstance(cfg, dict):
        raw = str(cfg.get("dlc_dir", "")).strip()
        if raw:
            p = Path(raw)
            if p.is_dir():
                return p
    return None


# ── Background metadata scan ──────────────────────────────────────────────────

def _resolve_dlc_path(dlc: Path, filename: str) -> Path | None:
    """Resolve `filename` under DLC_DIR and refuse anything that escapes.

    `filename` arrives from `:path` route params and can contain `..`
    segments. The Sloppak and archive paths happen to fail safely later
    because their loaders raise on missing/invalid files, but loose-
    folder format detection (`is_loose_song`) globs and parses XML on
    disk first, which lets a crafted path trigger filesystem reads
    outside DLC_DIR before any guard fires. Centralise the containment
    check so every filename-bound handler validates before touching the
    filesystem.

    Containment here is LEXICAL (normalize `.`/`..` WITHOUT following
    symlinks), not `safe_join`'s `.resolve()`-based check — because users
    commonly mount their song library through a directory JUNCTION/symlink
    (a library shared across app installs; the desktop app's own mounts).
    `.resolve()` follows that junction to its real target, sees it sits
    outside DLC_DIR, and wrongly rejects every song reached through it — the
    scanner's `rglob` indexes those songs, but art/load then 403/404s (broken
    covers, unplayable songs). Lexical normalization still rejects the only
    escapes a `:path` filename can express — `..` traversal and absolute
    paths — which the traversal tests pin. `safe_join` stays strict (it is
    the zip-slip / plugin-asset guard, where following a symlink out IS the
    defense); the loose-folder art handler keeps its own per-file symlink
    re-check for defence-in-depth.

    Returns the validated Path (not necessarily link-resolved), or None if
    the filename is empty, contains a NUL, or escapes the DLC root.
    """
    if not filename:
        return None
    # Backslashes → forward slashes so a Windows-style `..\\x` traversal is
    # rejected identically on POSIX (mirrors safe_join's normalisation).
    safe = filename.replace("\\", "/")
    if "\x00" in safe:
        return None
    # Reject drive-letter / absolute paths in BOTH conventions. A POSIX "/x" is
    # caught by the containment check below (the `/` operator discards `root`),
    # but a Windows drive-absolute "C:/x" is treated as a relative "C:" dir on
    # POSIX and would otherwise slip in as `<root>/C:/x` — so the contract must
    # hold cross-platform (a shared library is reached from either OS).
    from pathlib import PurePosixPath, PureWindowsPath
    if (PurePosixPath(safe).is_absolute()
            or PureWindowsPath(safe).is_absolute()
            or PureWindowsPath(safe).drive):
        return None
    try:
        root = dlc.resolve()
        # normpath collapses `.`/`..`/duplicate separators purely lexically —
        # it never touches the filesystem, so an in-library junction component
        # is preserved (allowed) while `..`/absolute segments still escape and
        # get caught by the containment check below.
        candidate = Path(os.path.normpath(root / safe))
        if not candidate.is_relative_to(root):
            return None
    except (ValueError, OSError):
        return None
    return candidate


def _pick_smart_arrangement(
    arrangements: list,
    smart_names: list,
    pref: str,
) -> int:
    """Return the best arrangement index for `pref` using smart-name priority.

    Priority order:
    1. Exact match  — smart_name == pref  (e.g. "Lead")
    2. Alt. variants — "Alt. Lead", "Alt. Lead 1", ...
    3. Bonus variants — "Bonus Lead", "Bonus Lead 1", ...
    4. First arrangement in smart sort order (Lead > Rhythm > Bass > ...)

    Returns -1 when `pref` is empty / "Auto" or `arrangements` is empty
    (caller falls through to the existing most-notes fallback).
    """
    pref = (pref or "").strip()
    if not pref or pref.lower() == "auto" or not arrangements:
        return -1

    sorted_pairs = sorted(
        enumerate(smart_names),
        key=lambda x: _arr_smart_sort_key({"smart_name": x[1]}),
    )

    alt_prefix = f"Alt. {pref}"
    bonus_prefix = f"Bonus {pref}"

    for i, sn in sorted_pairs:
        if sn == pref:
            return i

    for i, sn in sorted_pairs:
        if sn and (sn == alt_prefix or sn.startswith(alt_prefix + " ")):
            return i

    for i, sn in sorted_pairs:
        if sn and (sn == bonus_prefix or sn.startswith(bonus_prefix + " ")):
            return i

    if sorted_pairs:
        return sorted_pairs[0][0]
    return 0


def _sanitized_song_offset(song) -> float:
    """Return song.offset coerced to a finite float, or 0.0.

    Malformed loose-folder XMLs can put `NaN`/`Infinity` into <offset>;
    Python's `float()` happily accepts those, but Starlette's JSON
    encoder then emits the literal `NaN` token which is invalid JSON
    and breaks the frontend's song_info parsing.
    """
    try:
        v = float(getattr(song, "offset", 0.0))
    except (TypeError, ValueError):
        return 0.0
    return v if math.isfinite(v) else 0.0


def _sanitize_authors(manifest: dict | None) -> list[dict]:
    """Extract a display-safe contributor list from a feedpak manifest.

    The feedpak spec (§5.4) defines an OPTIONAL top-level `authors` list of
    objects `{name (required), role?, email?, url?}`. We surface only `name`
    and `role` to the highway — contact fields (email/url) are intentionally
    dropped from the on-screen credits. Malformed entries (non-dict, missing /
    blank name) are skipped; absent / non-list `authors` yields `[]`.
    """
    if not isinstance(manifest, dict):
        return []
    raw = manifest.get("authors")
    if not isinstance(raw, list):
        return []
    out: list[dict] = []
    for entry in raw:
        if not isinstance(entry, dict):
            continue
        name = entry.get("name")
        if not isinstance(name, str) or not name.strip():
            continue
        role = entry.get("role")
        out.append({
            "name": name.strip(),
            "role": role.strip() if isinstance(role, str) and role.strip() else None,
        })
    return out


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
_enrich_thread: threading.Thread | None = None


def _join_background_db_threads(timeout: float = 30.0) -> None:
    """Block until the background scan + enrichment workers finish (or timeout).

    A scan kicks enrichment on completion, so join the scan first — by the time
    it returns, _kick_enrich() has set _enrich_thread — then join enrichment."""
    st = _scan_thread
    if st is not None and st.is_alive():
        st.join(timeout)
    et = _enrich_thread
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
    _kick_enrich()


# ── Metadata enrichment worker (P7 plumbing + P8 matcher) ─────────────────────
# A single throttled daemon thread + queue, mirroring _kick_scan/_scan_runner
# (single-flight + coalescing; NOT a pool — external lookups are rate-limited
# to ~1/s, which makes a pool pointless). P7 shipped the lifecycle; P8 fills
# in the matcher (_enrich_one): local cache → manifest mbid/isrc exact keys →
# MusicBrainz text search, scored into auto/review/failed tiers by
# lib/mb_match.py. Wrong-match is worse than slow (design §5): medium
# confidence goes to the Match-Review queue, never straight to canonical.

_enrich_kick_lock = threading.Lock()
_enrich_pending_pass = False
# processed = phase-1 stubs stamped this pass (legacy field). total/matched =
# the phase-2 MATCHING progress the "Refresh Metadata" batch bar reads (the
# slow, rate-limited part worth a progress readout); current = the song being
# matched right now, which drives the per-tile "working" badge.
_enrich_status = {"running": False, "processed": 0, "last_pass_at": None,
                  "total": 0, "matched": 0, "current": None}
# Cooperative cancel for the Stop button: the matching/art loops check it
# between songs (an in-flight ≤1/s lookup can't be interrupted, but no new one
# is started). Set by /api/enrichment/cancel, cleared when a fresh pass kicks.
_enrich_cancel = threading.Event()
# Minimum spacing between EXTERNAL lookups (design: ≤1 req/s + local cache).
_ENRICH_MIN_INTERVAL = 1.1
_enrich_last_fetch = 0.0
# Serializes throttling across the background daemon thread AND the sync
# /api/enrichment/search route (FastAPI runs sync routes in a threadpool).
_enrich_throttle_lock = threading.Lock()


def _enrichment_art_dir() -> Path:
    """The size-capped art cache dir (populated by the Cover Art slice; the
    LRU cap policy lands with it). Under CONFIG_DIR so Settings backup/restore
    and the docker volume already cover it."""
    d = CONFIG_DIR / "art_cache"
    d.mkdir(parents=True, exist_ok=True)
    return d


def _enrich_throttle():
    """Block until an external lookup is allowed. Matchers MUST call this
    before every network request — and must NOT hold meta_db._lock across the
    request (fetch outside the lock, write inside)."""
    global _enrich_last_fetch
    # Hold the lock across the read, sleep, and write so concurrent callers
    # serialize instead of all reading the same stale timestamp and firing
    # together (which would burst past MusicBrainz's 1 req/s limit).
    with _enrich_throttle_lock:
        wait = _ENRICH_MIN_INTERVAL - (time.monotonic() - _enrich_last_fetch)
        if wait > 0:
            time.sleep(wait)
        _enrich_last_fetch = time.monotonic()


class EnrichTransportError(Exception):
    """Network-level enrichment failure — offline, DNS, MusicBrainz down or
    rate-limiting. Pauses the current pass (rows keep their state and no
    attempt is consumed); the next kick (scan-complete / the 5-min periodic
    rescan) retries naturally."""


_MB_API_ROOT = "https://musicbrainz.org/ws/2"
_enrich_ua_cache: str | None = None


def _enrich_user_agent() -> str:
    """MusicBrainz etiquette requires a real identifying User-Agent
    (app/version + contact URL); anonymous defaults get throttled/blocked."""
    global _enrich_ua_cache
    if _enrich_ua_cache is None:
        version = "unknown"
        try:
            vf = Path(__file__).parent / "VERSION"
            if vf.exists():
                version = vf.read_text().strip() or "unknown"
        except (OSError, UnicodeDecodeError):
            pass
        _enrich_ua_cache = f"feedBack/{version} (https://github.com/got-feedback/feedBack)"
    return _enrich_ua_cache


def _enrich_network_enabled() -> bool:
    """False = the matcher runs local-only (hash stamping, cache copies) and
    never opens a socket. FEEDBACK_ENRICH_OFFLINE is the explicit user
    kill-switch (privacy / air-gapped installs); FEEDBACK_SKIP_STARTUP_TASKS
    marks the test/CI environment, where pytest must never reach the network
    no matter what a test triggers."""
    return not (_env_flag("FEEDBACK_ENRICH_OFFLINE")
                or _env_flag("FEEDBACK_SKIP_STARTUP_TASKS"))


def _mb_http_get(path: str, params: dict) -> dict | None:
    """The ONE place enrichment touches the network (tests fake exactly this
    seam). Throttled (≤1 req/s via _enrich_throttle), identified (real
    User-Agent), offline-guarded. Returns the parsed JSON body, or None for
    a 404 lookup; raises EnrichTransportError for anything network-shaped.
    NEVER call this while holding meta_db._lock — fetch outside, write
    inside."""
    if not _enrich_network_enabled():
        raise EnrichTransportError("enrichment network disabled")
    import requests  # declared in requirements.txt; lazy so tests never need it
    _enrich_throttle()
    try:
        resp = requests.get(
            f"{_MB_API_ROOT}/{path.lstrip('/')}",
            params={**params, "fmt": "json"},
            headers={"User-Agent": _enrich_user_agent()},
            timeout=10,
        )
    except requests.RequestException as e:
        raise EnrichTransportError(str(e)) from e
    if resp.status_code == 404:
        return None
    if resp.status_code == 503:
        # MusicBrainz signals rate-limit pressure with 503 — back the whole
        # pass off rather than hammering on.
        raise EnrichTransportError("musicbrainz 503 (rate limited)")
    if resp.status_code != 200:
        raise EnrichTransportError(f"musicbrainz HTTP {resp.status_code}")
    try:
        return resp.json()
    except ValueError as e:
        raise EnrichTransportError("bad JSON from musicbrainz") from e


def _mb_search_recordings(artist, title, limit: int = 12) -> list[dict]:
    """Text search (tier 2–4): denoised Lucene query over /recording. The strict
    query drops live-only recordings and the ranker rewards the studio take, so a
    slightly larger default result set gives the re-ranker room to surface the
    canonical version.

    Runs the strict field-phrase query first (high precision); if it finds
    nothing, retries ONCE with a loose term query. The strict phrase only matches
    MusicBrainz's *primary* artist/title, so a recording stored under a non-Latin
    primary name (大橋純子) whose romanized form ("Junko Ohashi") is only an alias
    is invisible to it — the loose query searches aliases and rescues it. The
    retry spends a second throttled request only on a miss; results are re-scored
    by rank_candidates, so the looser recall doesn't lower match quality
    (auto-accept still needs the per-field floors)."""
    query = mb_match.build_recording_query(artist, title)
    cands: list[dict] = []
    if query:
        body = _mb_http_get("recording", {"query": query, "limit": limit})
        cands = mb_match.parse_search_response(body or {})
    if not cands:
        loose = mb_match.build_recording_query(artist, title, loose=True)
        if loose and loose != query:
            body = _mb_http_get("recording", {"query": loose, "limit": limit})
            cands = mb_match.parse_search_response(body or {})
    return cands


def _mb_search_release_groups(query: str, limit: int = 8) -> list[dict]:
    """Text search /release-group for the Change-cover picker: albums matching a
    free query, each mapped to its Cover Art Archive front thumb. One request;
    tiles whose CAA art is missing self-hide client-side (front-250 404s). Lets a
    cover be found even for a song with no metadata match (the city-pop pile)."""
    q = (query or "").strip()
    if not q:
        return []
    body = _mb_http_get("release-group", {"query": q, "limit": limit})
    out: list[dict] = []
    for rg in ((body or {}).get("release-groups") or []):
        rid = rg.get("id")
        if not rid:
            continue
        # artist-credit is a list of {name, joinphrase, artist} (joinphrase glues
        # collaborations) — reconstruct the credited name.
        artist = "".join(
            (c.get("name", "") + c.get("joinphrase", "")) if isinstance(c, dict) else str(c)
            for c in (rg.get("artist-credit") or [])
        ).strip()
        title = rg.get("title") or ""
        year = (rg.get("first-release-date") or "")[:4]
        out.append({
            "id": rid,
            "label": " · ".join(x for x in (title, artist, year) if x) or title or "Cover",
            "thumb_url": f"https://coverartarchive.org/release-group/{rid}/front-250",
        })
    return out


# ── AcoustID audio fingerprinting (content-based identification) ──────────────
# Optional path: requires the Chromaprint `fpcalc` binary AND an AcoustID API
# key ($ACOUSTID_API_KEY). Both absent ⇒ graceful no-op; the text matcher runs.

_ACOUSTID_MAX_UPLOAD_BYTES = 256 * 1024 * 1024  # 256 MB — an uncompressed master


def _fpcalc_bin() -> str | None:
    """Locate the Chromaprint `fpcalc` binary: $FPCALC override, else PATH."""
    import shutil
    cand = os.environ.get("FPCALC")
    if cand and Path(cand).exists():
        return cand
    return shutil.which("fpcalc")


def _acoustid_settings() -> "tuple[bool, str]":
    """(enabled, api_key) for AcoustID, resolved from settings with an env-var
    fallback for the key. Opt-in: `acoustid_enabled` defaults off. The key lives
    in settings so a user can set it themselves in the UI; $ACOUSTID_API_KEY is a
    server-wide fallback for a headless deploy."""
    cfg = _load_config(CONFIG_DIR / "config.json") or {}
    enabled = cfg.get("acoustid_enabled", False) is True
    key = cfg.get("acoustid_api_key")
    if not isinstance(key, str) or not key.strip():
        key = os.environ.get("ACOUSTID_API_KEY", "")
    return enabled, (key or "").strip()


def _acoustid_available() -> bool:
    """True only when the user opted in, a key is set (settings or env), the
    network is on, AND fpcalc exists."""
    enabled, key = _acoustid_settings()
    return (enabled
            and _enrich_network_enabled()
            and acoustid_match.is_configured(key)
            and _fpcalc_bin() is not None)


def _fpcalc(path: str) -> "tuple[int, str] | None":
    """Fingerprint a local audio file → (duration_seconds, fingerprint). None on
    any failure (missing binary/file, decode error, timeout)."""
    binp = _fpcalc_bin()
    if not binp or not Path(path).exists():
        return None
    import subprocess
    import json as _json
    try:
        pr = subprocess.run([binp, "-json", str(path)],
                            capture_output=True, timeout=30)
    except Exception:
        return None
    if pr.returncode != 0:
        return None
    try:
        data = _json.loads(pr.stdout.decode("utf-8", "replace"))
        dur = int(round(float(data.get("duration"))))
        fp = str(data.get("fingerprint") or "")
    except Exception:
        return None
    if not fp or dur <= 0:
        return None
    return dur, fp


def _acoustid_lookup(duration: int, fingerprint: str) -> list[dict]:
    """Look a fingerprint up on AcoustID → candidate dicts (mb_match shape).
    Throttled + offline-guarded like the MusicBrainz path. [] when unavailable
    or no hit; raises EnrichTransportError for network-shaped failures."""
    _, key = _acoustid_settings()
    if not key or not _enrich_network_enabled():
        return []
    import requests
    _enrich_throttle()
    try:
        # POST, not GET: a fingerprint is multi-KB (a 3.5-min track is ~3.5k
        # chars), so a GET crams it into the URL and a long song overflows the
        # server's URL limit → a spurious failure. AcoustID accepts the same
        # params form-encoded in the body.
        resp = requests.post(
            f"{acoustid_match.ACOUSTID_API_ROOT}/lookup",
            data={
                "client": key, "format": "json",
                "meta": acoustid_match.LOOKUP_META,
                "duration": duration, "fingerprint": fingerprint,
            },
            headers={"User-Agent": _enrich_user_agent()},
            timeout=10,
        )
    except requests.RequestException as e:
        raise EnrichTransportError(str(e)) from e
    if resp.status_code == 429:
        raise EnrichTransportError("acoustid 429 (rate limited)")
    if resp.status_code != 200:
        raise EnrichTransportError(f"acoustid HTTP {resp.status_code}")
    try:
        body = resp.json()
    except ValueError as e:
        raise EnrichTransportError("bad JSON from acoustid") from e
    return acoustid_match.parse_lookup_response(body)


def _identify_by_fingerprint(path: str) -> list[dict]:
    """fpcalc + AcoustID lookup for a local audio file. [] if fingerprinting is
    unavailable, the file can't be read, or nothing matched. Available to the
    library-enrichment pipeline as well as the /identify endpoint."""
    if not _acoustid_available():
        return []
    fp = _fpcalc(path)
    if not fp:
        return []
    return _acoustid_lookup(fp[0], fp[1])


def _acoustid_gate() -> "JSONResponse | None":
    """Shared availability gate for the identify endpoints: None when ready,
    else a 412 needs_setup (opt-in off / no key → the UI re-prompts) or a 503
    (set up but fpcalc/network missing). Never lets a caller pretend a
    fingerprint ran."""
    if _acoustid_available():
        return None
    enabled, key = _acoustid_settings()
    if not enabled or not key:
        return JSONResponse(
            {"error": "audio fingerprinting not set up", "needs_setup": True,
             "detail": "Turn on AcoustID and add a free API key to identify by audio — "
                       "it reads the recording itself, far more reliable than text search."},
            status_code=412)
    return JSONResponse(
        {"error": "audio fingerprinting unavailable", "needs_setup": False,
         "detail": "the fpcalc (Chromaprint) binary was not found on the server"},
        status_code=503)


def _song_audio_file(filename: str) -> "str | None":
    """Resolve a LIBRARY song (by filename/id) to a local master-audio file for
    fingerprinting: the full-mix `original_audio` extracted from a sloppak, or a
    loose folder's audio. None when the song can't be found or ships no full-mix
    audio (some packs carry only stems). Mirrors serve_sloppak_file's containment
    guards so a crafted filename can't read outside DLC_DIR / the pack."""
    dlc = _get_dlc_dir()
    if not dlc:
        return None
    resolved = _resolve_dlc_path(dlc, filename)
    if resolved is None or not resolved.exists():
        return None
    if sloppak_mod.is_sloppak(resolved):
        try:
            canon = resolved.relative_to(dlc.resolve()).as_posix()
        except ValueError:
            return None
        rel = (sloppak_mod.load_manifest(resolved) or {}).get("original_audio")
        if not isinstance(rel, str) or not rel.strip():
            return None
        src = sloppak_mod.get_cached_source_dir(canon)
        if src is None:
            try:
                src = sloppak_mod.resolve_source_dir(canon, dlc, SLOPPAK_CACHE_DIR)
            except Exception:
                return None
        target = (src / rel.strip()).resolve()
        try:
            target.relative_to(src.resolve())
        except ValueError:
            return None
        return str(target) if target.is_file() else None
    try:
        audio = loosefolder_mod.find_audio(resolved)
    except Exception:
        audio = None
    return str(audio) if audio and Path(str(audio)).is_file() else None


def _mb_lookup_recording(mbid: str) -> dict | None:
    """Direct lookup for a manifest-carried recording MBID (tier 0)."""
    body = _mb_http_get(
        f"recording/{mbid}",
        {"inc": "artist-credits+releases+release-groups+isrcs+genres"})
    return mb_match.parse_recording_doc(body) if body else None


def _mb_lookup_isrc(isrc: str) -> list[dict]:
    """Recordings registered under a manifest-carried ISRC (tier 1)."""
    body = _mb_http_get(
        f"isrc/{isrc}", {"inc": "artist-credits+releases+release-groups"})
    if not body:
        return []
    docs = body.get("recordings") or []
    return [c for c in (mb_match.parse_recording_doc(d) for d in docs) if c]


# Strict shapes for the manifest's optional identity keys (feedpak spec §5.1).
# Validated before use — the mbid is interpolated into a URL path, so junk or
# hostile manifest values must never reach the request line.
_MBID_RE = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$")
_ISRC_RE = re.compile(r"^[A-Z]{2}[A-Z0-9]{3}[0-9]{7}$")


# ── Alias-aware scoring ───────────────────────────────────────────────────────
# MusicBrainz stores many artists under a non-Latin PRIMARY name (大橋純子) with
# the romanized form ("Junko Ohashi") only as an ALIAS. A recording search
# returns the primary name in its artist-credit, never the aliases — so scoring
# a romanized reference against the primary gives 0 and the match can't confirm.
# We fetch the artist's aliases (one throttled lookup, process-cached) and hand
# them to the scorer, but ONLY for a promising near-miss (title already agrees,
# artist doesn't) so a normal pass spends no extra requests.
_ALIAS_ENRICH_MAX = 3          # cap alias lookups per song/search (each is ≤1/s)
_artist_alias_cache: dict[str, list[str]] = {}


def _mb_artist_aliases(artist_id: str) -> list[str]:
    """Romanized/alternate names for a MusicBrainz artist, process-cached (an
    artist recurs across a whole discography, so a library of one artist costs
    ONE lookup). Returns [] for an unknown/aliasless artist. Raises
    EnrichTransportError on a network failure so the caller pauses the pass
    (nothing is cached on failure → retried next pass)."""
    aid = str(artist_id or "")
    if aid in _artist_alias_cache:
        return _artist_alias_cache[aid]
    if not _MBID_RE.match(aid):
        return []
    body = _mb_http_get(f"artist/{aid}", {"inc": "aliases"})
    names: list[str] = []
    if body:
        sort_name = str(body.get("sort-name") or "").strip()
        if sort_name:
            names.append(sort_name)          # often the romanized form for JP artists
        for al in body.get("aliases") or []:
            if isinstance(al, dict) and al.get("name"):
                names.append(str(al["name"]))
    seen: set[str] = set()
    out: list[str] = []
    for n in names:
        k = n.casefold()
        if k and k not in seen:
            seen.add(k)
            out.append(n)
    out = out[:12]
    _artist_alias_cache[aid] = out
    return out


def _alias_enrich(ref: dict, cands: list[dict]) -> None:
    """Attach `artist_aliases` in place to candidates that look like the
    non-Latin-primary case — title agrees with the reference but the primary
    artist doesn't — so the scorer can confirm them via a romanized alias.
    Bounded by _ALIAS_ENRICH_MAX + the process cache; a no-op when the
    reference has no artist or nothing is aliasable."""
    ref_artist = (ref.get("artist") or "").strip()
    if not ref_artist:
        return
    spent = 0
    for c in cands:
        if spent >= _ALIAS_ENRICH_MAX:
            break
        if not isinstance(c, dict) or c.get("artist_aliases") is not None:
            continue
        aid = c.get("artist_id")
        if not aid:
            continue
        # Only spend a lookup on a promising near-miss: the title already
        # matches, but the primary artist doesn't (that's the alias signature).
        if mb_match.similarity(ref.get("title"), c.get("title")) < mb_match.AUTO_TITLE_MIN:
            continue
        if mb_match.similarity(ref_artist, c.get("artist"), artist=True) >= mb_match.AUTO_ARTIST_MIN:
            continue
        c["artist_aliases"] = _mb_artist_aliases(aid)   # cached; attach [] to avoid refetch
        spent += 1


def _manifest_exact_ids(filename: str) -> dict:
    """Optional `mbid`/`isrc` from the pack manifest — the spec's additive
    identity keys. Feature-detected: packs published before that spec
    revision simply lack them and fall through to text matching. READ-only:
    enrichment never writes anything into pack files."""
    try:
        dlc = _get_dlc_dir()
        if not dlc:
            return {}
        p = _resolve_dlc_path(dlc, filename)
        if p is None or not p.exists() or not sloppak_mod.is_sloppak(p):
            return {}
        manifest = sloppak_mod.load_manifest(p) or {}
    except Exception:
        return {}
    out = {}
    mbid = str(manifest.get("mbid", "") or "").strip().lower()
    if _MBID_RE.match(mbid):
        out["mbid"] = mbid
    isrc = str(manifest.get("isrc", "") or "").strip().upper()
    # Spec 1.14.0: the stored form is the bare 12-char code, but ISRCs
    # circulate hyphenated in the wild (US-ABC-24-00001) — the separators
    # are presentation, not part of the code, so a hand-authored display
    # form still matches (consumers SHOULD strip before comparing).
    isrc = isrc.replace("-", "").replace(" ", "")
    if _ISRC_RE.match(isrc):
        out["isrc"] = isrc
    return out


# Failed-row retry backoff: 1 h after the first failed attempt, doubling per
# attempt, capped at a week — a permanently-unmatchable obscure chart must
# not re-hammer MusicBrainz on every scan kick.
_ENRICH_BACKOFF_BASE = 3600.0
_ENRICH_BACKOFF_CAP = 7 * 86400.0


def _enrich_backoff_elapsed(attempts, last_attempt_at, now: float) -> bool:
    if not last_attempt_at:
        return True
    delay = min(_ENRICH_BACKOFF_BASE * (2 ** max(0, int(attempts or 1) - 1)),
                _ENRICH_BACKOFF_CAP)
    return (now - float(last_attempt_at)) >= delay


# Review tier keeps a short ranked candidate list for the drawer; more than a
# handful is noise the user has to scroll past.
_ENRICH_MAX_CANDIDATES = 5

# ── Cover art (R3/P9) ─────────────────────────────────────────────────────────
# The art cache dir (CONFIG_DIR/art_cache) holds two kinds of file:
#   {safe_name}.png / .gif  — USER OVERRIDES (upload or URL-fetch; never
#                             evicted, removed only with the song or by the
#                             explicit remove-override route)
#   caa_{release_mbid}.jpg  — COVER ART ARCHIVE fetches, keyed by release so
#                             every chart of the same release shares one file;
#                             size-capped LRU (evictions reset the enrichment
#                             rows so a later pass may re-fetch)
_CAA_CACHE_CAP_BYTES = 200 * 1024 * 1024
# Per-cover cap on a single CAA fetch. The 500px thumbnail is normally tens of
# KB; this bounds any one response independently of the aggregate LRU cap so a
# single oversized (or misbehaving) release can't blow up memory/disk.
_CAA_MAX_BYTES = 10 * 1024 * 1024
# A release MBID is a UUID; before interpolating it into a cache-file path we
# require a conservative token (alphanumerics, hyphen, underscore only) so no
# separator or '.' can ever appear — blocks path traversal. Defence in depth:
# cheap even though the DB only ever holds MusicBrainz UUIDs. (Distinct name
# from the strict recording-MBID _MBID_RE above — this only gates a filename.)
_CAA_ID_RE = re.compile(r"^[A-Za-z0-9_-]{1,128}$")


def _caa_http_get(release_id: str) -> bytes | None:
    """Fetch a release's front cover from the Cover Art Archive — the one
    network seam of the art layer (tests fake exactly this). Same etiquette
    as the MusicBrainz client: throttled, identified, offline-guarded.
    Returns the image bytes, None when the release has no cover (404), and
    raises EnrichTransportError for anything network-shaped."""
    if not _enrich_network_enabled():
        raise EnrichTransportError("enrichment network disabled")
    import requests
    _enrich_throttle()
    try:
        with requests.get(
            f"https://coverartarchive.org/release/{release_id}/front-500",
            headers={"User-Agent": _enrich_user_agent()},
            timeout=15, allow_redirects=True, stream=True,
        ) as resp:
            if resp.status_code == 404:
                return None
            if resp.status_code != 200:
                raise EnrichTransportError(f"cover art archive HTTP {resp.status_code}")
            # Stream with a per-file cap so a huge response never fully downloads.
            data = b""
            for chunk in resp.iter_content(65536):
                data += chunk
                if len(data) > _CAA_MAX_BYTES:
                    # Not network-shaped: settle just this row as 'error' (the
                    # art loop's generic handler) rather than pausing the pass.
                    raise ValueError("cover art exceeds size cap")
            return data
    except requests.RequestException as e:
        raise EnrichTransportError(str(e)) from e


def _caa_release_index(release_id: str) -> dict | None:
    """Fetch a release's Cover Art Archive INDEX (json — image METADATA, not
    image bytes): the cover picker's one network seam (tests fake exactly
    this). Same etiquette as _caa_http_get: throttled, identified,
    offline-guarded. Returns the parsed index dict, None when the archive
    has no art for the release (404), and raises EnrichTransportError for
    anything network-shaped."""
    if not _enrich_network_enabled():
        raise EnrichTransportError("enrichment network disabled")
    import requests
    _enrich_throttle()
    try:
        resp = requests.get(
            f"https://coverartarchive.org/release/{release_id}",
            headers={"User-Agent": _enrich_user_agent(),
                     "Accept": "application/json"},
            timeout=15, allow_redirects=True)
        if resp.status_code == 404:
            return None
        if resp.status_code != 200:
            raise EnrichTransportError(f"cover art archive HTTP {resp.status_code}")
        body = resp.json()
        return body if isinstance(body, dict) else None
    except requests.RequestException as e:
        raise EnrichTransportError(str(e)) from e
    except ValueError as e:
        # Non-JSON body — treat as a transport blip (nothing gets cached, a
        # later picker-open retries) rather than caching an empty index.
        raise EnrichTransportError(f"cover art archive returned non-JSON: {e}") from e


# Per-release lock so two concurrent /art/candidates opens for the SAME
# release serialise their read→fetch→write (the "index cached, no second
# fetch" invariant). Different releases still fetch in parallel; the guard
# lock only protects the tiny registry lookup.
_caa_index_locks: dict[str, threading.Lock] = {}
_caa_index_locks_guard = threading.Lock()


def _caa_index_lock(release_id: str) -> threading.Lock:
    with _caa_index_locks_guard:
        lock = _caa_index_locks.get(release_id)
        if lock is None:
            lock = _caa_index_locks[release_id] = threading.Lock()
        return lock


def _caa_index_cached(release_id: str) -> list[dict]:
    """A release's CAA index images through a TTL-less on-disk cache
    (`caa_index_{id}.json` beside the cover files — indexes are stable, and
    a 404 is cached as an empty index so a coverless release is never
    re-asked). Outside the network seam on purpose: tests fake
    _caa_release_index and still exercise this cache. Raises
    EnrichTransportError on a cache-miss network failure (the caller stops
    asking for further releases); malformed ids/bodies yield []."""
    if not _CAA_ID_RE.match(str(release_id or "")):
        return []
    cache_file = _enrichment_art_dir() / f"caa_index_{release_id}.json"
    # Hold the per-id lock across the check→fetch→write so a concurrent open
    # for the same release finds the freshly-written cache instead of racing a
    # second fetch. (The network fetch sleeps in _enrich_throttle under a
    # different lock — no deadlock; a different release is never blocked.)
    with _caa_index_lock(str(release_id)):
        if cache_file.is_file():
            try:
                body = json.loads(cache_file.read_text(encoding="utf-8"))
                imgs = body.get("images") if isinstance(body, dict) else None
                if isinstance(imgs, list):
                    return imgs
            except (OSError, ValueError):
                pass  # unreadable/corrupt cache → refetch below
        body = _caa_release_index(release_id)
        if body is None or not isinstance(body.get("images"), list):
            body = {"images": []}
        try:
            cache_file.write_text(json.dumps(body), encoding="utf-8")
        except OSError:
            pass  # cache is best-effort; the response still serves
        return body["images"]


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


def _prune_caa_cache() -> None:
    """Keep the CAA side of the art cache under its size cap: evict the
    oldest caa_* files (mtime LRU) and reset the enrichment rows that pointed
    at them. User-override files are never touched."""
    try:
        files = sorted(ART_CACHE_DIR.glob("caa_*.jpg"), key=lambda p: p.stat().st_mtime)
        total = sum(p.stat().st_size for p in files)
        evicted: list[str] = []
        while files and total > _CAA_CACHE_CAP_BYTES:
            victim = files.pop(0)
            try:
                total -= victim.stat().st_size
                victim.unlink()
                evicted.append(str(victim))
            except OSError:
                break
        if evicted:
            meta_db.clear_enrichment_art_paths(evicted)
            log.info("art cache: evicted %d cover(s) to stay under the cap", len(evicted))
    except Exception:
        log.exception("art cache prune failed")


def _enrich_art_one(row: dict) -> bool:
    """Resolve one matched song's cover-art situation (art worker, phase 3).
    Returns True when a cover was actually fetched. Every outcome writes an
    art_state so the row never re-queues:
      'pack'  — the song ships its own art (it wins; nothing to do)
      'user'  — an override exists (it wins; nothing to do)
      'caa'   — front cover cached (possibly deduped from an earlier fetch
                of the same release — no network on that path)
      'none'  — the Cover Art Archive has no cover for this release
    Network errors raise EnrichTransportError → the pass pauses and the row
    stays unevaluated for the next kick."""
    fn, release_id = row["filename"], row["mb_release_id"]
    if not release_id or not _CAA_ID_RE.match(str(release_id)):
        # Malformed release id — never build a cache path from it. Settle the
        # row as 'error' so it isn't re-queued every pass.
        meta_db.set_enrichment_art(fn, None, "error")
        return False
    if _song_pack_art_exists(fn):
        meta_db.set_enrichment_art(fn, None, "pack")
        return False
    if _art_override_paths(fn):
        meta_db.set_enrichment_art(fn, None, "user")
        return False
    cache_file = _enrichment_art_dir() / f"caa_{release_id}.jpg"
    if cache_file.is_file():
        meta_db.set_enrichment_art(fn, str(cache_file), "caa")
        return False
    data = _caa_http_get(release_id)
    if data is None:
        meta_db.set_enrichment_art(fn, None, "none")
        return False
    cache_file.write_bytes(data)
    meta_db.set_enrichment_art(fn, str(cache_file), "caa")
    _prune_caa_cache()
    return True


_ENRICH_APPLY_FIELDS = {
    # Per-field auto-apply toggle → the candidate fields it governs. The
    # MusicBrainz ids + isrc are deliberately NOT here: they're identity,
    # not display — the art fetch and any future re-match need them stamped
    # even when every display field is toggled off.
    "enrich_apply_names": ("artist", "title", "album", "artist_sort"),
    "enrich_apply_year": ("year",),
    "enrich_apply_genres": ("genres",),
}


def _enrich_blocked_apply_keys(cfg: dict) -> frozenset:
    """The per-field auto-apply toggle keys that are currently OFF (suppressed).
    Its complement (`_ENRICH_APPLY_FIELDS` minus these) is what an automatic
    match may canonicalize."""
    return frozenset(k for k in _ENRICH_APPLY_FIELDS if cfg.get(k, True) is False)


def _enrich_apply_mask(cfg: dict) -> str:
    """Canonical marker of the suppressed apply keys, persisted on each
    automatic match so re-enabling a field re-queues the row for backfill
    (enrichment_pending) and a partial match can't seed siblings
    (enrichment_cache_lookup). '' = nothing suppressed (the default)."""
    return ",".join(sorted(_enrich_blocked_apply_keys(cfg)))


def _enrich_field_filter(cfg: dict):
    """Build the cand filter for AUTOMATIC matches from the per-field
    auto-apply settings: strips the display fields whose toggle is off
    before they're stamped as canonical. Returns None when everything is
    on (the default) so the common path stays zero-copy. Review candidates
    and user-confirmed picks bypass this — a match the user confirms in
    the modal applies in full."""
    blocked = {f for key in _enrich_blocked_apply_keys(cfg)
               for f in _ENRICH_APPLY_FIELDS[key]}
    if not blocked:
        return None
    return lambda cand: {k: v for k, v in cand.items() if k not in blocked}


# A per-song LOCK (Fix-metadata popup) → the candidate display keys it
# suppresses on an AUTOMATIC match. Identity keys (recording/release/artist ids,
# isrc) are deliberately absent: a locked DISPLAY field still gets matched for
# art + future re-match, it just isn't re-canonicalized behind the user's back.
_LOCK_FIELD_TO_CAND = {
    "artist": ("artist", "artist_sort"),
    "title": ("title",),
    "album": ("album",),
    "year": ("year",),
    "genre": ("genres",),
}


def _compose_lock_filter(base_filter, locked_fields):
    """Wrap the pass's global per-field apply-filter with a per-song filter that
    also strips the song's LOCKED display fields, so an automatic match never
    re-canonicalizes a field the user pinned. Returns base_filter unchanged when
    the song has no relevant lock (the common path)."""
    blocked = {ck for f in locked_fields for ck in _LOCK_FIELD_TO_CAND.get(f, ())}
    if not blocked:
        return base_filter

    def lock_filter(cand):
        c = base_filter(cand) if base_filter else cand
        return {k: v for k, v in c.items() if k not in blocked}
    return lock_filter


def _enrich_one(row: dict, auto_min: float | None = None, field_filter=None,
                apply_mask: str = "") -> None:
    """The matcher (P8; replaces P7's no-op). Precedence per design §5:

    1. local match-cache by content_hash — another chart of the same
       recording already matched/pinned → copy it, NO network;
    2. manifest `mbid` (tier 0) / `isrc` (tier 1) exact keys → direct
       lookup, auto;
    3. text search → scored tiers: auto (high) / review (medium — a human
       confirms before anything canonicalizes) / failed (low, retried on
       backoff).

    `auto_min` is the user's auto-apply confidence setting (None → the
    engine default); it moves only the auto/review boundary of step 3 —
    the per-field floors and exact-key tiers are unaffected. `field_filter`
    (from _enrich_field_filter) strips per-field-disabled display values
    from every AUTOMATIC stamp — all three steps here are automatic, so it
    applies to each; the review tier stores candidates unfiltered because
    accepting one is a user action. Never touches a `manual` row (the
    writer enforces it). `apply_mask` (the suppressed keys, from
    _enrich_apply_mask) is stamped on each AUTOMATIC match so a later
    re-enable re-queues the row for backfill and a partial match can't seed
    siblings. Network errors raise EnrichTransportError so the pass pauses
    instead of burning attempts while offline."""
    fn, chash = row["filename"], row["content_hash"]
    # Respect per-song field LOCKS (Fix-metadata popup): an automatic match must
    # not re-canonicalize a field the user pinned. Compose the lock filter onto
    # the pass's global apply-filter — both the cache-copy and text-match auto
    # paths run their candidate through it. (Review/manual picks bypass the
    # filter, so confirming a match in the modal is an explicit override.)
    locked = meta_db.locked_fields(fn)
    if locked:
        field_filter = _compose_lock_filter(field_filter, locked)

    cached = meta_db.enrichment_cache_lookup(chash, exclude_filename=fn)
    if cached:
        score = cached.pop("score", None)
        if field_filter:
            cached = field_filter(cached)
        meta_db.apply_enrichment_match(fn, chash, "matched", source="cache",
                                       score=score, cand=cached, apply_mask=apply_mask)
        return

    ids = _manifest_exact_ids(fn)
    if ids.get("mbid"):
        cand = _mb_lookup_recording(ids["mbid"])
        if cand:
            meta_db.apply_enrichment_match(fn, chash, "matched", source="mbid",
                                           score=1.0, apply_mask=apply_mask,
                                           cand=field_filter(cand) if field_filter else cand)
            return
        # A 404'd mbid (typo'd manifest) falls through to the text tiers.
    # A pack that left `artist` blank can't be text-matched (search needs an
    # artist, and the per-field floor rejects a blank one) — so when it's blank,
    # seed the query/scoring from the filename's Artist_Song convention. Seed
    # only: fn/chash and the stored row are untouched, and the DISPLAYED values
    # still come from the confirmed match. The exact-key tiers above don't need
    # it (mbid/isrc identify without text).
    ref = row
    if not (row.get("artist") or "").strip():
        derived = _artist_title_from_filename(fn)
        if derived:
            ref = {**row, **derived}

    if ids.get("isrc"):
        cands = mb_match.rank_candidates(ref, _mb_lookup_isrc(ids["isrc"]))
        if cands:
            meta_db.apply_enrichment_match(fn, chash, "matched", source="isrc",
                                           score=1.0, apply_mask=apply_mask,
                                           cand=field_filter(cands[0]) if field_filter else cands[0])
            return

    cands = _mb_search_recordings(ref.get("artist"), ref.get("title"))
    # Alias-enrich promising near-misses (title agrees, primary artist doesn't)
    # so a non-Latin-primary artist can confirm via its romanized alias, then
    # rank once with the aliases in hand. `ref` carries any filename-derived
    # artist seed, so alias scoring runs against the searched identity.
    _alias_enrich(ref, cands)
    ranked = mb_match.rank_candidates(ref, cands)
    best = ranked[0] if ranked else None
    tier = mb_match.classify(ref, best, best["score"], auto_min=auto_min) if best else "none"
    if tier == "auto":
        meta_db.apply_enrichment_match(fn, chash, "matched", source="text",
                                       score=best["score"], apply_mask=apply_mask,
                                       cand=field_filter(best) if field_filter else best)
    elif tier == "review":
        meta_db.apply_enrichment_match(fn, chash, "review", source="text",
                                       score=best["score"],
                                       candidates=ranked[:_ENRICH_MAX_CANDIDATES])
    else:
        meta_db.apply_enrichment_match(fn, chash, "failed", source="text",
                                       score=(best["score"] if best else None),
                                       candidates=ranked[:_ENRICH_MAX_CANDIDATES] or None,
                                       bump_attempts=True)


def _background_enrich():
    """One bounded pass, two phases. Phase 1 stamps/refreshes identity-hash
    stubs for every song whose identity is new or changed — pure-local, so
    hashes stay fresh (and stale matches drop back to `unscanned`) even
    fully offline. Phase 2 runs the matcher over those rows plus any
    `failed` rows whose backoff has elapsed; a transport failure pauses it
    (state untouched, no attempt burned) and the next kick retries. Offline
    (kill-switch or the test env) skips phase 2 entirely. Never drains in a
    loop — a dead network would make that spin forever. Between songs it
    honours the Stop button's cancel flag (phases 2 and 3), so a long trickle
    can be halted without waiting for the whole queue to drain."""
    _enrich_status["processed"] = 0
    _enrich_status["total"] = 0
    _enrich_status["matched"] = 0
    _enrich_status["current"] = None
    # User settings gate the BACKGROUND matcher only (the review modal's
    # manual search/fix stays available when it's off); read once per pass,
    # up front so the pending query can honour the per-field apply mask
    # (a re-enabled field re-queues its `matched` rows for backfill).
    cfg = _load_config(CONFIG_DIR / "config.json") or {}
    allowed_keys = frozenset(_ENRICH_APPLY_FIELDS) - _enrich_blocked_apply_keys(cfg)
    apply_mask = _enrich_apply_mask(cfg)
    try:
        pending = meta_db.enrichment_pending(limit=100000, allowed_keys=allowed_keys)
    except Exception:
        log.exception("enrichment: pending query failed")
        return
    for row in pending:
        try:
            meta_db.upsert_enrichment_stub(row["filename"], row["content_hash"])
        except Exception as e:
            log.warning("enrichment stub failed for %s: %s", row.get("filename"), e)
        _enrich_status["processed"] += 1
    _enrich_status["last_pass_at"] = time.time()

    if cfg.get("enrich_enabled", True) is False:
        if pending:
            log.info("Enrichment pass: %d rows stamped (matching disabled in Settings)", len(pending))
        return
    try:
        auto_min = float(cfg.get("enrich_auto_threshold", 0.9))
    except (TypeError, ValueError):
        auto_min = 0.9

    if not _enrich_network_enabled():
        if pending:
            log.info("Enrichment pass: %d rows stamped (network disabled — matching skipped)", len(pending))
        return

    # Scraper options (R1), read from the same per-pass cfg: `mb_on` gates
    # the matcher (phase 2), `art_on` the cover-art fetch (phase 3 — the
    # Cover Art Archive is the only automatic art source today, so the
    # source toggle and the cover-art apply toggle both have to be on).
    mb_on = cfg.get("enrich_src_musicbrainz", True) is not False
    art_on = (cfg.get("enrich_src_caa", True) is not False
              and cfg.get("enrich_apply_art", True) is not False)
    field_filter = _enrich_field_filter(cfg)

    now = time.time()
    retriable = []
    if mb_on:
        try:
            retriable = [r for r in meta_db.enrichment_failed_rows(limit=100000)
                         if _enrich_backoff_elapsed(r.get("attempts"), r.get("last_attempt_at"), now)]
        except Exception:
            log.exception("enrichment: failed-row query failed")
    elif pending:
        log.info("Enrichment pass: %d rows stamped (MusicBrainz source disabled in Settings)", len(pending))
    matched = 0
    # A `failed` row with a changed identity hash can surface in BOTH lists;
    # de-dup by filename so each row consumes the rate budget only once.
    seen_filenames = set()
    queue = []
    for row in (pending + retriable) if mb_on else []:
        fn = row.get("filename")
        if fn in seen_filenames:
            continue
        seen_filenames.add(fn)
        queue.append(row)
    _enrich_status["total"] = len(queue)
    for row in queue:
        if _enrich_cancel.is_set():
            log.info("enrichment: pass cancelled by user after %d matched", matched)
            break
        _enrich_status["current"] = row.get("filename")
        try:
            _enrich_one(row, auto_min=auto_min, field_filter=field_filter,
                        apply_mask=apply_mask)
            matched += 1
            _enrich_status["matched"] = matched
        except EnrichTransportError as e:
            log.info("enrichment: network unavailable, pass paused (%s)", e)
            break
        except Exception as e:
            log.warning("enrichment failed for %s: %s", row.get("filename"), e)
            try:
                # Park the row on the failure backoff instead of retrying a
                # poisoned input every pass.
                meta_db.apply_enrichment_match(
                    row["filename"], row["content_hash"], "failed",
                    source="error", bump_attempts=True)
            except Exception:
                pass
    _enrich_status["current"] = None
    if mb_on and (pending or retriable):
        log.info("Enrichment pass: %d rows stamped, %d matched", len(pending), matched)

    # Phase 3 — cover art (R3/P9). For freshly-matched songs, resolve the art
    # situation once: songs with their own pack art (or a user override) are
    # marked and skipped; the rest fetch the release's front cover from the
    # Cover Art Archive into the size-capped cache. Same pause-on-transport-
    # error rule as matching — a dead network never burns a row's evaluation.
    # Rows skipped here stay art_state NULL, so re-enabling the toggles picks
    # them up on the next pass — nothing is permanently forfeited.
    if not art_on:
        return
    try:
        art_rows = meta_db.enrichment_art_pending(limit=100000)
    except Exception:
        log.exception("enrichment: art-pending query failed")
        return
    fetched = 0
    for row in art_rows:
        if _enrich_cancel.is_set():
            log.info("enrichment: art pass cancelled by user after %d fetched", fetched)
            break
        try:
            fetched += 1 if _enrich_art_one(row) else 0
        except EnrichTransportError as e:
            log.info("enrichment: network unavailable, art pass paused (%s)", e)
            break
        except Exception as e:
            log.warning("enrichment art failed for %s: %s", row.get("filename"), e)
            try:
                meta_db.set_enrichment_art(row["filename"], None, "error")
            except Exception:
                pass
    if art_rows:
        log.info("Enrichment art pass: %d evaluated, %d covers fetched", len(art_rows), fetched)


def _kick_enrich() -> bool:
    """Request an enrichment pass, single-flight + coalescing (the _kick_scan
    contract): True = a worker thread was started, False = one is running and
    a follow-up pass was queued."""
    global _enrich_pending_pass, _enrich_thread
    with _enrich_kick_lock:
        if _enrich_status["running"]:
            _enrich_pending_pass = True
            return False
        # A fresh pass supersedes any prior Stop — clear the flag so the new
        # pass isn't cancelled the instant it checks (a stale set() from a
        # cancelled-then-re-kicked run would otherwise abort it immediately).
        _enrich_cancel.clear()
        _enrich_status["running"] = True
    _enrich_thread = threading.Thread(target=_enrich_runner, daemon=True)
    _enrich_thread.start()
    return True


def _enrich_runner():
    global _enrich_pending_pass
    while True:
        try:
            _background_enrich()
        except Exception:
            log.exception("background enrichment failed unexpectedly")
        with _enrich_kick_lock:
            _enrich_status["current"] = None
            if _enrich_cancel.is_set():
                # Stop: abandon any coalesced follow-up and clear the flag so the
                # next kick starts clean. The current pass already broke out of
                # its loop between songs (see _background_enrich).
                _enrich_pending_pass = False
                _enrich_cancel.clear()
                _enrich_status["running"] = False
                return
            if not _enrich_pending_pass:
                _enrich_status["running"] = False
                return
            _enrich_pending_pass = False


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


def _safe_http_url(raw):
    """Return `raw` stripped + trailing-slash-stripped if it parses as an
    http(s) URL with a non-empty host; else None.

    Used to validate operator-supplied `APP_SOURCE_URL` / `APP_LICENSE_URL`
    env vars before they reach `<a href>` in the UI. A bare prefix check
    like `startswith(("http://","https://"))` accepts malformed inputs
    such as `"https://"` (no host) or `"https:///foo"` (empty host) that
    still produce broken hrefs — and, when used as a base for the default
    `license_url`, garbage like `"https:///blob/main/LICENSE"`.
    """
    from urllib.parse import urlsplit
    if not raw:
        return None
    s = raw.strip().rstrip("/")
    if not s:
        return None
    try:
        parsed = urlsplit(s)
    except ValueError:
        return None
    if parsed.scheme.lower() not in ("http", "https"):
        return None
    # `netloc` includes any `user:pass@` and `:port` — strings like
    # "http://:80/path" have non-empty netloc (":80") but no real
    # hostname. Validate `hostname` so only URLs with an actual host
    # are accepted.
    if not parsed.hostname:
        return None
    return s


@app.get("/api/version")
def get_version():
    env_version = os.environ.get("APP_VERSION", "").strip()
    if env_version:
        version = env_version
    else:
        version_file = Path(__file__).parent / "VERSION"
        version = "unknown"
        if version_file.exists():
            try:
                version = version_file.read_text().strip()
            except (OSError, UnicodeDecodeError):
                pass
    default_source_url = "https://github.com/got-feedback/feedBack"
    # APP_SOURCE_URL / APP_LICENSE_URL flow straight into <a href> in the UI,
    # so validate with urllib.parse rather than a bare prefix check — a prefix
    # check accepts malformed values like "https://" (no host) which produce
    # broken hrefs (and a constructed license_url like "https:///blob/main/LICENSE").
    # _safe_http_url requires scheme in {http,https} AND a non-empty hostname
    # (not just netloc — that would still accept port-only authorities like
    # "http://:80/path"); fall back to the safe default otherwise.
    source_url = _safe_http_url(os.environ.get("APP_SOURCE_URL")) or default_source_url
    # APP_LICENSE_URL: explicit override for the LICENSE link. The default
    # constructed value (source_url + "/blob/main/LICENSE") is GitHub-
    # specific and assumes the repo's default branch is `main`; non-GitHub
    # hosts (GitLab, Gitea, self-hosted) need an explicit value.
    license_url = _safe_http_url(os.environ.get("APP_LICENSE_URL")) or (source_url + "/blob/main/LICENSE")
    return {
        "version": version,
        "source_url": source_url,
        "license_url": license_url,
    }


@app.get("/api/scan-status")
def scan_status():
    return _scan_status


@app.get("/api/enrichment/status")
def enrichment_status():
    """Enrichment pipeline state: worker flags + row counts by match_state.
    Ambient tool-state for the match-review UI (never a home-screen score —
    design §11); also what tests poke."""
    return {
        "running": _enrich_status["running"],
        "processed": _enrich_status["processed"],
        "last_pass_at": _enrich_status["last_pass_at"],
        "states": meta_db.enrichment_state_counts(),
        "total_songs": meta_db.count(),
        # Per-pass matching progress for the "Refresh Metadata" batch bar +
        # per-tile badges (total = songs queued to match this pass, matched =
        # done so far, current = the one being matched now).
        "total": _enrich_status.get("total", 0),
        "matched": _enrich_status.get("matched", 0),
        "current": _enrich_status.get("current"),
        "cancelling": _enrich_cancel.is_set(),
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
    return {"started": _kick_enrich()}


@app.post("/api/enrichment/cancel")
def api_enrichment_cancel():
    """Stop button on the "Refresh Metadata" batch: signal the running pass to
    halt after the current song (an in-flight ≤1/s lookup can't be interrupted,
    but no new one is started) and drop any coalesced follow-up. A no-op when
    nothing is running."""
    was_running = _enrich_status["running"]
    if was_running:
        _enrich_cancel.set()
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
    started = _kick_enrich() if queued else False
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
        "current": _enrich_status.get("current"),
        "running": _enrich_status["running"],
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
    return {"ok": True, "started": _kick_enrich()}


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
        cands = _mb_search_recordings(artist, title, limit=limit)
    except EnrichTransportError as e:
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
        _alias_enrich(ref, cands)
    except EnrichTransportError:
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
    gate = _acoustid_gate()
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
        if cl_int > _ACOUSTID_MAX_UPLOAD_BYTES + _MULTIPART_OVERHEAD_SLACK:
            return JSONResponse({"error": "audio upload too large (256 MB max)"}, status_code=413)
    try:
        form = await request.form(max_part_size=_ACOUSTID_MAX_UPLOAD_BYTES)
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
                if total > _ACOUSTID_MAX_UPLOAD_BYTES:
                    return JSONResponse(
                        {"error": "audio upload too large (256 MB max)"}, status_code=413)
                fh.write(chunk)
        if total == 0:
            raise HTTPException(status_code=400, detail="empty upload")
        # fpcalc subprocess + AcoustID HTTP are blocking — off the event loop.
        cands = await asyncio.get_event_loop().run_in_executor(
            None, _identify_by_fingerprint, tmp)
    except EnrichTransportError as e:
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
    gate = _acoustid_gate()
    if gate is not None:
        return gate
    audio = _song_audio_file(filename)
    if not audio:
        return JSONResponse(
            {"error": "no audio",
             "detail": "couldn't find this song's master audio to fingerprint "
                       "(a stems-only pack has no full mix to identify)."},
            status_code=404)
    try:
        cands = _identify_by_fingerprint(audio)
    except EnrichTransportError as e:
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
_MAX_UPLOAD_BYTES = 1024 * 1024 * 1024  # 1 GB — covers sloppaks bundled with stems
# Per-request batch cap. Lets a user drop a whole album of sloppaks at once
# without giving a hostile client a 1000-file DoS surface via Starlette's
# default max_files=1000. The pre-parse Content-Length guard is sized as
# _MAX_UPLOAD_FILES * _MAX_UPLOAD_BYTES + slack.
_MAX_UPLOAD_FILES = 50
# Multipart Content-Length includes boundary markers + per-part headers, so a
# file sitting right at _MAX_UPLOAD_BYTES would be rejected by an equality cap
# on Content-Length. Add a generous slack for the multipart envelope; the real
# file-size cap is enforced by the streaming check in _save_uploaded_song().
_MULTIPART_OVERHEAD_SLACK = 1024 * 1024  # 1 MiB
# Serializes the mutating step of upload (os.replace into DLC_DIR) with
# delete_song so the two endpoints can't interleave on the same path —
# e.g. an upload finishing right after a concurrent delete shouldn't
# resurrect a song the user just removed, and a delete arriving mid-
# overwrite shouldn't strand a half-written file. threading.Lock (not
# asyncio.Lock) because delete_song is sync (runs in the threadpool);
# upload acquires it inside ``run_in_threadpool`` for the same reason.
_song_io_lock = threading.Lock()


def _commit_uploaded_song(tmp_path: Path, dest: Path, overwrite: bool, base: str):
    """Atomically move a validated temp upload into ``dest`` under ``_song_io_lock``.

    Returns ``None`` on success or an error result dict matching the upload
    endpoint's contract. Holds the lock across the directory re-check and
    the final ``os.replace`` so a concurrent delete or upload can't slip
    between them. Always cleans up the temp file on the error paths.
    """
    with _song_io_lock:
        if dest.exists():
            if not overwrite:
                # Lost the race against a concurrent upload of the same name.
                try:
                    tmp_path.unlink()
                except OSError:
                    pass
                return {"status": "exists", "filename": base,
                        "error": "A file with this name already exists"}
            # Re-check directory state under the lock — the pre-check
            # may have raced an unrelated mkdir, and a sloppak directory
            # has to be removed before os.replace() can write over it.
            if dest.is_dir():
                if not sloppak_mod.is_sloppak(dest):
                    try:
                        tmp_path.unlink()
                    except OSError:
                        pass
                    return {"status": "exists", "filename": base,
                            "error": "A directory with this name exists and is not "
                                     "a sloppak — refusing to overwrite"}
                shutil.rmtree(str(dest))
        os.replace(str(tmp_path), str(dest))
    return None


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


@app.post("/api/songs/upload")
async def upload_song(request: Request):
    """Upload one or more .sloppak files into the configured DLC folder.

    Multipart body with one or more ``file`` fields (up to ``_MAX_UPLOAD_FILES``
    per request). Query string:
      ``overwrite=1`` — replace existing files with the same name.

    Response shape (always HTTP 200 once we've gotten past request-level guards
    like DLC-not-configured / payload-too-large):
      ``{"results": [{"filename": "...", "status": "ok" | "exists" | "error",
                       "error"?: "...", "size"?: N, "format"?: "sloppak"}, ...]}``
    Per-file conflicts surface as ``status: "exists"`` so a batch upload can
    surface ALL conflicts at once instead of bailing on the first one. The
    client re-POSTs just the conflicting files with ``overwrite=1`` if the
    user opts in.

    The DLC directory is resolved via ``_get_dlc_dir()`` which honours the
    ``DLC_DIR`` env var first and falls back to ``dlc_dir`` in
    ``config.json`` — so uploads land in whichever folder the rest of the
    app already considers the library root, regardless of which mechanism
    configured it.
    """
    dlc = _get_dlc_dir()
    if dlc is None:
        return JSONResponse(
            {"error": "DLC folder is not configured. Set DLC_DIR or configure it in Settings."},
            status_code=503,
        )
    if not os.access(str(dlc), os.W_OK):
        return JSONResponse(
            {"error": f"DLC folder {dlc} is not writable by the server process."},
            status_code=500,
        )

    # Pre-parse Content-Length guard — fail fast before reading any body.
    # Multipart Content-Length is file bytes + boundary + per-part headers, so
    # we can't use _MAX_UPLOAD_BYTES as an exact cap here (a file right at the
    # advertised max would be rejected before _save_uploaded_song() can apply
    # the real per-file byte cap). For batch uploads we allow up to
    # _MAX_UPLOAD_FILES files at _MAX_UPLOAD_BYTES each; the parser still
    # enforces per-part size via max_part_size and per-batch count via
    # max_files. The streaming check inside _save_uploaded_song() is the
    # authoritative per-file size cap.
    max_total = _MAX_UPLOAD_FILES * _MAX_UPLOAD_BYTES + _MULTIPART_OVERHEAD_SLACK
    cl = request.headers.get("content-length")
    if cl is not None:
        try:
            cl_int = int(cl)
        except ValueError:
            return JSONResponse({"error": "Invalid Content-Length header"}, status_code=400)
        if cl_int < 0:
            return JSONResponse({"error": "Invalid Content-Length header"}, status_code=400)
        if cl_int > max_total:
            return JSONResponse(
                {"error": f"Batch upload exceeds {_MAX_UPLOAD_FILES} files × "
                          f"{_MAX_UPLOAD_BYTES // (1024 * 1024)} MB limit"},
                status_code=413,
            )

    overwrite = request.query_params.get("overwrite") == "1"
    # Tighten the parser to the handler's contract: up to _MAX_UPLOAD_FILES
    # file parts, no text parts (overwrite comes from query params).
    # Starlette's defaults of max_files=1000 / max_fields=1000 would
    # otherwise let a client force the parser to spool far more parts than
    # the endpoint is willing to process.
    form = await request.form(
        max_files=_MAX_UPLOAD_FILES,
        max_fields=0,
        max_part_size=_MAX_UPLOAD_BYTES,
    )
    try:
        from starlette.datastructures import UploadFile as _StarletteUploadFile
        # form.getlist("file") returns all parts named "file" in submission
        # order. Filter to file parts only — Starlette would yield strings
        # for text parts, but we've capped max_fields=0 so any non-file part
        # is already a parser error before reaching here.
        uploads = [u for u in form.getlist("file") if isinstance(u, _StarletteUploadFile)]
        if not uploads:
            return JSONResponse(
                {"error": "Expected one or more files in multipart field 'file'"},
                status_code=400,
            )

        results = []
        any_saved = False
        for upload in uploads:
            try:
                result = await _save_uploaded_song(upload, dlc, overwrite)
                results.append(result)
                if result.get("status") == "ok":
                    any_saved = True
            except Exception as e:
                # Per-file failure must not abort the batch — record and
                # continue so the client gets a complete report.
                log.exception("upload failed for %r", getattr(upload, "filename", "?"))
                results.append({
                    "filename": Path(getattr(upload, "filename", "") or "").name or "?",
                    "status": "error",
                    "error": f"Upload failed: {e}",
                })
            finally:
                try:
                    await upload.close()
                except Exception:
                    log.debug("failed to close upload file handle", exc_info=True)

        if any_saved:
            _kick_scan()
        return {"results": results}
    finally:
        try:
            await form.close()
        except Exception:
            log.debug("failed to close form", exc_info=True)


async def _save_uploaded_song(upload: UploadFile, dlc: Path, overwrite: bool) -> dict:
    """Save one upload into ``dlc``. Returns a per-file result dict (never
    a JSONResponse) so batch uploads can aggregate.

    Shape:
      ok:     ``{"status": "ok", "filename": base, "size": N, "format": "sloppak"}``
      exists: ``{"status": "exists", "filename": base, "error": "..."}``
      error:  ``{"status": "error", "filename": base, "error": "..."}``
    """
    # Strip any path components a client may have included in the filename —
    # only the basename lands in the DLC root. Path traversal would otherwise
    # let a crafted upload escape the library directory.
    raw_name = upload.filename or ""
    base = Path(raw_name).name
    if not base or base in (".", "..") or "/" in base or "\\" in base:
        return {"status": "error", "filename": raw_name or "?", "error": "Invalid filename"}
    suffix = Path(base).suffix.lower()
    if suffix not in _ALLOWED_SONG_EXTS:
        return {"status": "error", "filename": base,
                "error": "Only .feedpak files are accepted"}

    dest = dlc / base
    if dest.exists():
        if not overwrite:
            return {"status": "exists", "filename": base,
                    "error": "A file with this name already exists"}
        # overwrite=1 must handle directory-form sloppaks (the scanner and
        # delete path both treat them as song entries). os.replace() can't
        # clobber a non-empty directory, so without the rmtree below the
        # whole upload would write to a temp file and then surface a late
        # 500 at the os.replace() call. Refuse other directories so an
        # unrelated folder isn't blown away by a same-named upload.
        if dest.is_dir() and not sloppak_mod.is_sloppak(dest):
            return {"status": "exists", "filename": base,
                    "error": "A directory with this name exists and is not a sloppak — "
                             "refusing to overwrite"}

    # Temp file in the DLC dir itself so os.replace is atomic (same filesystem).
    # Dot-prefix keeps it out of the rglob("*.sloppak") scan glob.
    fd, tmp_name = await run_in_threadpool(
        tempfile.mkstemp, dir=str(dlc), prefix=".upload-", suffix=".part"
    )
    tmp_path = Path(tmp_name)
    bytes_read = 0
    head = b""
    error_result: dict | None = None
    try:
        try:
            tmpf = await run_in_threadpool(os.fdopen, fd, "wb")
        except BaseException:
            try:
                await run_in_threadpool(os.close, fd)
            except OSError:
                pass
            raise
        try:
            while True:
                chunk = await upload.read(1024 * 1024)
                if not chunk:
                    break
                bytes_read += len(chunk)
                if bytes_read > _MAX_UPLOAD_BYTES:
                    error_result = {
                        "status": "error", "filename": base,
                        "error": f"Upload exceeds {_MAX_UPLOAD_BYTES // (1024 * 1024)} MB cap",
                    }
                    break
                if len(head) < 4:
                    head += chunk[: 4 - len(head)]
                await run_in_threadpool(tmpf.write, chunk)
        finally:
            await run_in_threadpool(tmpf.close)

        if error_result is None:
            if bytes_read == 0:
                error_result = {"status": "error", "filename": base,
                                "error": "Empty upload — file is 0 bytes"}
            elif suffix in _ALLOWED_SONG_EXTS:
                if head[:2] != b"PK":
                    error_result = {"status": "error", "filename": base,
                                    "error": "Not a valid feedpak file (expected zip archive)"}
                else:
                    # ZIP magic alone admits any renamed zip — verify the sloppak
                    # loader can actually parse a manifest.yaml inside. Without
                    # this, /api/songs/upload returns "ok" for files the rest of
                    # the backend would refuse to scan or load.
                    try:
                        await run_in_threadpool(sloppak_mod.load_manifest, tmp_path)
                    except Exception as e:
                        error_result = {"status": "error", "filename": base,
                                        "error": f"Not a valid sloppak file: {e}"}

        if error_result is not None:
            try:
                await run_in_threadpool(tmp_path.unlink)
            except OSError:
                pass
            return error_result

        # Single sync helper so the lock is held for the whole commit —
        # ``async with _upload_lock`` would have released between every
        # ``run_in_threadpool`` and let a concurrent delete or upload slip
        # in between the dir check and the final ``os.replace``.
        commit_result = await run_in_threadpool(
            _commit_uploaded_song, tmp_path, dest, overwrite, base
        )
        if commit_result is not None:
            return commit_result
    except BaseException:
        try:
            await run_in_threadpool(tmp_path.unlink)
        except OSError:
            pass
        raise

    # Even on a fresh (non-overwrite) upload, evict any stale entries left
    # over from a previous delete+re-upload of the same name.
    await run_in_threadpool(_invalidate_song_caches, base)

    log.info("Uploaded %s (%d bytes) to %s", base, bytes_read, dlc)
    return {"status": "ok", "filename": base, "size": bytes_read,
            "format": suffix.lstrip(".")}


@app.delete("/api/song/{filename:path}")
def delete_song(filename: str):
    """Remove a song from the DLC folder and clear its cache entries.

    Works for both formats: ``.sloppak`` files OR directories, and
    loose-folder songs (the directory containing the chart). The path is
    resolved through ``_resolve_dlc_path`` so URL-encoded ``..`` segments
    cannot escape the library root.
    """
    dlc = _get_dlc_dir()
    if dlc is None:
        return JSONResponse({"error": "DLC folder not configured"}, status_code=503)
    resolved = _resolve_dlc_path(dlc, filename)
    if resolved is None:
        return JSONResponse({"error": "forbidden"}, status_code=403)
    if not resolved.exists():
        return JSONResponse({"error": "File not found"}, status_code=404)
    if resolved == dlc.resolve():
        return JSONResponse({"error": "Refusing to delete the DLC root"}, status_code=400)

    # Only delete actual song entries. Without this, DELETE /api/song/ArtistName
    # would recursively wipe a whole artist subfolder — far broader than the
    # UI's per-song contract. Sloppak detection wins over loose because a
    # sloppak dir can also contain WEM/XML (matches the scanner's precedence).
    is_sloppak = sloppak_mod.is_sloppak(resolved)
    is_loose = (
        resolved.is_dir()
        and not is_sloppak
        and loosefolder_mod.is_loose_song(resolved)
    )
    if not (is_sloppak or is_loose):
        return JSONResponse(
            {"error": "Not a song entry — only sloppaks "
                      "or loose-folder songs can be deleted"},
            status_code=400,
        )

    # Hold ``_song_io_lock`` across the filesystem removal AND the DB/cache
    # eviction. Without it, an upload of the same filename could ``os.replace``
    # a new file into place between our removal and DB delete, leaving the
    # new generation stranded with no library row; or the reverse, where
    # delete runs between an upload's directory check and its replace and
    # the upload then resurrects the song we just removed.
    with _song_io_lock:
        try:
            if resolved.is_dir():
                shutil.rmtree(resolved)
            else:
                resolved.unlink()
        except OSError as e:
            log.error("Failed to delete %s: %s", resolved, e)
            return JSONResponse({"error": f"Delete failed: {e}"}, status_code=500)

        # Canonicalise the cache key the same way update_song_meta does so we
        # hit the row the scanner indexed under.
        try:
            cache_key = resolved.relative_to(dlc.resolve()).as_posix()
        except ValueError:
            cache_key = filename
        with meta_db._lock:
            meta_db.conn.execute("DELETE FROM songs WHERE filename = ?", (cache_key,))
            meta_db.conn.execute("DELETE FROM favorites WHERE filename = ?", (cache_key,))
            meta_db.conn.execute("DELETE FROM loops WHERE filename = ?", (cache_key,))
            # Purge the v3 filename-keyed state too, so the deleted song stops
            # surfacing in stats / recent / continue / playlists immediately.
            meta_db.conn.execute("DELETE FROM song_stats WHERE filename = ?", (cache_key,))
            meta_db.conn.execute("DELETE FROM playlist_songs WHERE filename = ?", (cache_key,))
            # Personal difficulty / notes / tags for this song (we hold the
            # lock, so purge is lock-free).
            meta_db.purge_song_user_data(cache_key)
            # Multi-chart grouping (P5a): drop this chart's split + read-model rows,
            # and any preferred-chart pointer that named it (the work re-auto-picks).
            # work_key-keyed prefs for OTHER charts survive. Mark the read-model
            # dirty so the affected work regroups on the next grouped query.
            meta_db.conn.execute("DELETE FROM chart_group_split WHERE filename = ?", (cache_key,))
            meta_db.conn.execute("DELETE FROM work_display WHERE filename = ?", (cache_key,))
            meta_db.conn.execute("DELETE FROM chart_group_pref WHERE preferred_filename = ?", (cache_key,))
            meta_db._work_display_dirty = True
            # Enrichment is never purged on rescan (delete_missing), only here
            # on the explicit per-song delete — the never-clobber contract.
            meta_db.conn.execute("DELETE FROM song_enrichment WHERE filename = ?", (cache_key,))
            meta_db.conn.commit()

        # User art overrides go with the song (CAA cache files are keyed by
        # RELEASE and may be shared with other charts — the LRU owns those).
        for _p in _art_override_paths(cache_key):
            try:
                _p.unlink()
            except OSError:
                pass

        _invalidate_song_caches(cache_key)

    log.info("Deleted song %s", cache_key)
    # If a scan was mid-flight when we removed the row, it may already have
    # listed (and not yet processed) the file and will call ``meta_db.put()``
    # for it after our DB delete — reinserting a ghost row. Coalesce a
    # follow-up pass via ``_kick_scan`` so the next scan's ``delete_missing()``
    # purges that entry. Cheap no-op when no scan is running.
    if _scan_status["running"]:
        _kick_scan()
    return {"ok": True, "filename": cache_key}


# ── Library API ───────────────────────────────────────────────────────────────

def _split_csv(raw: str) -> list[str]:
    """Parse a comma-separated query-string list. Empty / whitespace-only
    entries are dropped so `arrangements_has=` (no value) and
    `arrangements_has=,` both mean 'no filter'."""
    if not raw:
        return []
    return [s.strip() for s in raw.split(",") if s.strip()]


def _parse_has_lyrics(raw: str) -> int | None:
    """Tri-state parse for has_lyrics. `1` → require, `0` → exclude,
    anything else (including empty) → no filter."""
    if raw == "1":
        return 1
    if raw == "0":
        return 0
    return None


def _library_filter_args(q: str = "", favorites: int = 0, format: str = "",
                         artist: str = "", album: str = "",
                         arrangements_has: str = "", arrangements_lacks: str = "",
                         stems_has: str = "", stems_lacks: str = "",
                         has_lyrics: str = "", tunings: str = "") -> dict:
    fmt = format if format in ("archive", "sloppak", "loose") else ""
    return {
        "q": q,
        "favorites_only": bool(favorites),
        "format_filter": fmt,
        "artist_filter": (artist or "").strip(),
        "album_filter": (album or "").strip(),
        "arrangements_has": _split_csv(arrangements_has),
        "arrangements_lacks": _split_csv(arrangements_lacks),
        "stems_has": _split_csv(stems_has),
        "stems_lacks": _split_csv(stems_lacks),
        "has_lyrics": _parse_has_lyrics(has_lyrics),
        "tunings": _split_csv(tunings),
    }


@app.get("/api/library/providers")
def list_library_providers():
    """List registered library providers."""
    return {"providers": library_providers.list()}


@app.get("/api/library/providers/{provider_id}/songs/{song_id:path}/art")
async def get_library_provider_song_art(provider_id: str, song_id: str):
    """Return album art for a song owned by a library provider."""
    library_provider = _get_library_provider(provider_id)
    _require_library_provider_capability(library_provider, "art.read")
    result = await _call_library_provider_async(library_provider, "get_art", song_id=song_id)
    return _library_art_response(result)


@app.post("/api/library/providers/{provider_id}/songs/{song_id:path}/sync")
async def sync_library_provider_song(provider_id: str, song_id: str):
    """Ask a provider to sync a remote song into the local library/cache."""
    library_provider = _get_library_provider(provider_id)
    _require_library_provider_capability(library_provider, "song.sync")
    result = await _call_library_provider_async(library_provider, "sync_song", song_id=song_id)
    if result is None:
        return {"ok": True}
    if isinstance(result, dict):
        return result
    return {"ok": True, "result": result}


@app.get("/api/library")
async def list_library(q: str = "", page: int = 0, size: int = 24, sort: str = "artist",
                       dir: str = "asc", favorites: int = 0, format: str = "",
                       artist: str = "", album: str = "",
                       arrangements_has: str = "", arrangements_lacks: str = "",
                       stems_has: str = "", stems_lacks: str = "",
                       has_lyrics: str = "", tunings: str = "", provider: str = "local",
                       mastery: str = "", tags: str = "", user_difficulty: str = "",
                       match: str = "", genre: str = "", after: str = "", group: int = 0,
                       naming_mode: str = "legacy"):
    """Paginated library search through the selected library provider.

    `after` is an opaque keyset cursor (feedBack#636 item 3): pass back the
    `next_cursor` from the previous response to fetch the next page with a
    WHERE-seek instead of OFFSET. Providers that don't support it ignore it and
    page by OFFSET, so the client can always fall back."""
    size = min(size, 100)
    library_provider = _get_library_provider(provider)
    _require_library_provider_capability(library_provider, "library.read")
    # Only the true local provider keysets: it's the one whose effective sort is
    # exactly the request `sort`. A smart collection may pin its own sort and
    # remote providers don't keyset — both must page by OFFSET, so never hand
    # them a cursor (a mismatched one would mis-seek).
    is_local = getattr(library_provider, "id", "") == "local"
    songs, total = await _call_library_provider_async(
        library_provider,
        "query_page",
        page=page,
        size=size,
        sort=sort,
        direction=dir,
        after=((after or None) if is_local else None),
        group=bool(group),
        naming_mode=naming_mode,
        mastery=_split_csv(mastery),
        tags_has=_split_csv(tags),
        user_difficulty_in=_split_csv(user_difficulty),
        match_states=_split_csv(match),
        genre=_split_csv(genre),
        **_library_filter_args(
            q=q, favorites=favorites, format=format,
            artist=artist, album=album,
            arrangements_has=arrangements_has, arrangements_lacks=arrangements_lacks,
            stems_has=stems_has, stems_lacks=stems_lacks,
            has_lyrics=has_lyrics, tunings=tunings,
        ),
    )
    # The cursor to resume after this page (effective sort folds in dir=desc).
    next_cursor = (next_library_cursor(_effective_keyset_sort(sort, dir), songs[-1])
                   if (is_local and songs) else None)
    # Drop the private raw-title stash query_page attached for the cursor — it's
    # an internal keyset detail, not part of the card payload.
    for s in songs:
        s.pop("_sort_title", None)
    return {"songs": songs, "total": total, "page": page, "size": size,
            "next_cursor": next_cursor}


# ── Multi-chart work grouping API (P5b) ──────────────────────────────────────
# Read + manage the charts of a work (the P5d Charts drawer consumes this). The
# grouping engine lives in MetadataDB (P5a); these are its HTTP surface. Local
# library only. NOTE: a scoped "work changed" repaint broadcast for OTHER open
# views is deferred to P5d — there's no server-side library event bus today, and
# the drawer updates itself from these responses.

@app.get("/api/work/{work_key:path}/charts")
def api_get_work_charts(work_key: str):
    """All charts in a work + which is the keeper (your pick vs auto-pick)."""
    return meta_db.work_charts(work_key)


@app.put("/api/work/{work_key:path}/preferred")
def api_set_work_preferred(work_key: str, data: dict):
    """Set the keeper chart of a work: body {filename}. The filename must be a
    current member of the work. Returns the refreshed chart list."""
    fn = (data.get("filename") or "").strip()
    if not fn:
        return JSONResponse({"error": "filename is required"}, 400)
    members = {c["filename"] for c in meta_db.work_charts(work_key)["charts"]}
    if fn not in members:
        return JSONResponse({"error": "filename is not a chart of this work"}, 400)
    meta_db.set_chart_preferred(work_key, fn)
    return meta_db.work_charts(work_key)


@app.delete("/api/work/{work_key:path}/preferred")
def api_reset_work_preferred(work_key: str):
    """Reset a work to auto-pick (drop the explicit preferred)."""
    meta_db.clear_chart_preferred(work_key)
    return meta_db.work_charts(work_key)


@app.post("/api/chart/{filename:path}/split")
def api_split_chart(filename: str):
    """'These aren't the same song' — split this chart out as its own singleton
    work. Under /api/chart (NOT /api/song) so the DELETE /api/song/{path}
    catch-all can't shadow it."""
    key = meta_db._canonical_song_filename(filename)
    meta_db.split_chart(key)
    return {"ok": True, "filename": key}


@app.post("/api/chart/{filename:path}/unsplit")
def api_unsplit_chart(filename: str):
    """Undo a split — rejoin the chart to its work."""
    key = meta_db._canonical_song_filename(filename)
    meta_db.unsplit_chart(key)
    return {"ok": True, "filename": key}


@app.get("/api/chart/{filename:path}/work")
def api_get_chart_work(filename: str):
    """Resolve a chart's work membership: {work_key, chart_count}. For openers
    on rows that came from an ungrouped query (the tree view) — grouped grid
    rows already carry both fields inline."""
    return meta_db.chart_work(filename)


@app.get("/api/chart/{filename:path}/fileinfo")
def api_chart_fileinfo(filename: str):
    """The context menu's "Get info": where the file lives + what the pack
    contains. Under /api/chart — the GET /api/song/{path} catch-all would
    swallow a /api/song/…/fileinfo suffix. Read-only; demo-mode blocks it
    because it exposes filesystem paths."""
    dlc = _get_dlc_dir()
    if not dlc:
        raise HTTPException(status_code=404, detail="not configured")
    p = _resolve_dlc_path(dlc, filename)
    if p is None:
        raise HTTPException(status_code=403, detail="forbidden")
    if not p.exists():
        raise HTTPException(status_code=404, detail="not found")
    # Restrict to actual charts — sloppak or loose song. Without this the route
    # would stat ANY file the user happens to keep under DLC_DIR (e.g. notes),
    # leaking its path/size; the app only recognises these two song formats.
    is_pak = sloppak_mod.is_sloppak(p)
    is_loose = loosefolder_mod.is_loose_song(p)
    if not (is_pak or is_loose):
        raise HTTPException(status_code=404, detail="not a chart")
    st = p.stat()
    info = {
        "filename": filename,
        "path": str(p),
        "folder": str(p.parent),
        "format": "sloppak" if is_pak else "loose",
        # Directory-form songs report the tree's total (covers loose folders
        # and dir-form paks); zip-form paks report the archive size. Symlinked
        # entries are skipped so a link inside the folder can't pull in — or
        # leak the size of — a file outside it.
        "size": (st.st_size if p.is_file()
                 else sum(f.stat().st_size for f in p.rglob("*")
                          if f.is_file() and not f.is_symlink())),
        "mtime": st.st_mtime,
    }
    if is_pak:
        try:
            m = sloppak_mod.load_manifest(p) or {}
        except Exception:
            m = {}
        arrs = [str(a.get("name", a.get("id", ""))) for a in (m.get("arrangements") or [])
                if isinstance(a, dict)]
        stems = [str(s.get("id", "")) for s in (m.get("stems") or []) if isinstance(s, dict)]
        try:
            has_cover = sloppak_mod.read_cover_bytes(p, m) is not None
        except Exception:
            has_cover = False
        # The optional identity/catalog keys, listed only when present — the
        # Get-info panel's "what this pack carries vs what's missing" readout.
        identity = {k: m.get(k) for k in
                    ("mbid", "isrc", "genres", "track", "disc", "album_artist",
                     "feedpak_version", "language")
                    if m.get(k) not in (None, "", [])}
        info["manifest"] = {
            "title": str(m.get("title", "")), "artist": str(m.get("artist", "")),
            "album": str(m.get("album", "")), "year": str(m.get("year", "") or ""),
            "arrangements": arrs, "stems": stems,
            "has_cover": has_cover, "has_lyrics": bool(m.get("lyrics")),
            "authors": [a.get("name", "") if isinstance(a, dict) else str(a)
                        for a in (m.get("authors") or [])],
            "identity": identity,
        }
    # The enrichment verdict, so Get info can say "Matched (auto, 96%)" /
    # "Pinned by you" / "Not matched" alongside the file facts.
    row = meta_db.get_enrichment(filename)
    if row:
        info["match"] = {k: row.get(k) for k in
                         ("match_state", "match_source", "match_score",
                          "canon_artist", "canon_title", "canon_album", "canon_year")}
    return info


@app.get("/api/library/albums")
async def list_library_albums(q: str = "", page: int = 0, size: int = 120,
                              favorites: int = 0, format: str = "",
                              artist: str = "", album: str = "",
                              arrangements_has: str = "", arrangements_lacks: str = "",
                              stems_has: str = "", stems_lacks: str = "",
                              has_lyrics: str = "", tunings: str = "", mastery: str = "",
                              match: str = "", genre: str = "",
                              provider: str = "local"):
    """Album-condensed browse: distinct (artist, album) groups with a track count
    and a representative cover song. Paged by album. Same filters as /api/library."""
    size = min(size, 500)
    library_provider = _get_library_provider(provider)
    _require_library_provider_capability(library_provider, "library.read")
    albums, total = await _call_library_provider_async(
        library_provider, "query_albums",
        page=page, size=size, mastery=_split_csv(mastery),
        match_states=_split_csv(match), genre=_split_csv(genre),
        **_library_filter_args(
            q=q, favorites=favorites, format=format, artist=artist, album=album,
            arrangements_has=arrangements_has, arrangements_lacks=arrangements_lacks,
            stems_has=stems_has, stems_lacks=stems_lacks,
            has_lyrics=has_lyrics, tunings=tunings,
        ),
    )
    return {"albums": albums, "total": total, "page": page, "size": size}


@app.get("/api/library/artists")
async def list_artists(letter: str = "", q: str = "", favorites: int = 0, page: int = 0,
                       size: int = 50, format: str = "",
                       artist: str = "", album: str = "",
                       arrangements_has: str = "", arrangements_lacks: str = "",
                       stems_has: str = "", stems_lacks: str = "",
                       has_lyrics: str = "", tunings: str = "", provider: str = "local",
                       naming_mode: str = "legacy"):
    """Get artists grouped by letter with albums and songs (for tree view)."""
    size = min(size, 100)
    library_provider = _get_library_provider(provider)
    _require_library_provider_capability(library_provider, "library.read")
    artists, total = await _call_library_provider_async(
        library_provider,
        "query_artists",
        letter=letter,
        page=page,
        size=size,
        naming_mode=naming_mode,
        **_library_filter_args(
            q=q, favorites=favorites, format=format,
            artist=artist, album=album,
            arrangements_has=arrangements_has, arrangements_lacks=arrangements_lacks,
            stems_has=stems_has, stems_lacks=stems_lacks,
            has_lyrics=has_lyrics, tunings=tunings,
        ),
    )
    return {"artists": artists, "total_artists": total, "page": page, "size": size}


@app.get("/api/library/stats")
async def library_stats(favorites: int = 0, q: str = "", format: str = "",
                        artist: str = "", album: str = "",
                        arrangements_has: str = "", arrangements_lacks: str = "",
                        stems_has: str = "", stems_lacks: str = "",
                        has_lyrics: str = "", tunings: str = "", provider: str = "local",
                        match: str = "",
                        sort: str = "artist", sort_letters: int = 0,
                        group: int = 0, naming_mode: str = "legacy"):
    """Aggregate stats for the UI. Accepts the same filter params as
    /api/library so the letter bar mirrors the active grid filter set.
    `sort` selects the column the jump rail's `sort_letters` keys on;
    `sort_letters=1` opts into that breakdown (the rail), so non-rail
    callers skip the extra per-letter aggregate. `group=1` counts works not
    charts (mirrors the grouped grid)."""
    library_provider = _get_library_provider(provider)
    _require_library_provider_capability(library_provider, "library.read")
    return await _call_library_provider_async(
        library_provider,
        "query_stats",
        naming_mode=naming_mode,
        sort=sort,
        want_sort_letters=bool(sort_letters),
        group=bool(group),
        # The match facet rides the stats call too — the A–Z rail's letter
        # counts must agree with the grid under the facet or its cumulative
        # seek + sizer geometry break.
        match_states=_split_csv(match),
        **_library_filter_args(
            q=q, favorites=favorites, format=format,
            artist=artist, album=album,
            arrangements_has=arrangements_has, arrangements_lacks=arrangements_lacks,
            stems_has=stems_has, stems_lacks=stems_lacks,
            has_lyrics=has_lyrics, tunings=tunings,
        ),
    )


@app.get("/api/library/genres")
def library_genres(provider: str = "local"):
    """Distinct non-empty genres for the filter facet.

    Genres are a local-library facet: they're populated from the feedpak
    `genres` field at scan time and live in the local meta DB. Local-backed
    providers (the local library and its smart collections, kind="local")
    share that DB, so they surface the same set. Remote providers don't
    expose genres here, so return an empty facet for them — the client then
    hides the filter rather than offering local genres that don't apply to
    the remote grid. Mirrors the local/remote gating used elsewhere for
    provider calls (see `_call_library_provider`)."""
    library_provider = _get_library_provider(provider)
    kind = str(library_providers.provider_field(library_provider, "kind", "") or "")
    is_remote = kind not in ("", "local") if kind else provider != "local"
    if is_remote:
        return {"genres": []}
    with meta_db._lock:
        g = meta_db._effective_genre_expr()
        rows = meta_db.conn.execute(
            f"SELECT g FROM (SELECT DISTINCT ({g}) AS g FROM songs) "
            "WHERE g IS NOT NULL AND g != '' ORDER BY g COLLATE NOCASE"
        ).fetchall()
    return {"genres": [r[0] for r in rows]}


@app.get("/api/library/tuning-names")
async def list_tuning_names(provider: str = "local"):
    """Distinct tuning names present in the library, with per-tuning
    counts. Powers the tuning multi-select. Sorted by `tuning_sort_key`
    so names appear in the same musical order the sort uses
    (feedBack#22) — E Standard first, then nearest neighbors."""
    library_provider = _get_library_provider(provider)
    _require_library_provider_capability(library_provider, "library.read")
    return await _call_library_provider_async(library_provider, "tuning_names")


@app.post("/api/favorites/toggle")
def toggle_favorite(data: dict):
    """Toggle a song's favorite status."""
    filename = data.get("filename", "")
    if not filename:
        return {"error": "No filename"}
    new_state = meta_db.toggle_favorite(filename)
    return {"favorite": new_state}


# ── Personal per-song metadata (difficulty / notes / tags) ───────────────────
# The local, never-shared layer. Distinct from POST /api/song/{f}/meta, which
# writes catalog fields (title/artist/album/year) BACK INTO the feedpak file;
# these endpoints are DB-only and never touch the file. Likes stay the heart
# (POST /api/favorites/toggle).

@app.get("/api/song/{filename:path}/user-meta")
def get_song_user_meta(filename: str):
    """Read {user_difficulty, notes, tags} for one song."""
    return meta_db.get_song_user_meta(meta_db._canonical_song_filename(filename))


@app.put("/api/song/{filename:path}/user-meta")
def put_song_user_meta(filename: str, data: dict):
    """Partial update. Send any of: `user_difficulty` (int 1–5, or null/"" to
    clear), `notes` (string, or null to clear), `tags` (a full-replace array of
    strings). Omitted keys are preserved. Returns the merged meta.

    Tag removal is a full-replace `tags` array (send the new set) rather than a
    granular DELETE sub-route, because `DELETE /api/song/{filename:path}` already
    owns every DELETE under /api/song and would shadow it."""
    key = meta_db._canonical_song_filename(filename)
    kwargs: dict = {}
    if "user_difficulty" in data:
        v = data["user_difficulty"]
        if v is None or v == "":
            kwargs["user_difficulty"] = None
        else:
            # Reject bools (int subclass) and non-integral floats so 2.5 / true
            # can't silently truncate into a valid band.
            if isinstance(v, bool) or (isinstance(v, float) and not v.is_integer()):
                return JSONResponse({"error": "user_difficulty must be an integer 1–5 or null"}, 400)
            try:
                iv = int(v)
            except (TypeError, ValueError):
                return JSONResponse({"error": "user_difficulty must be an integer 1–5 or null"}, 400)
            if not (1 <= iv <= 5):
                return JSONResponse({"error": "user_difficulty must be 1–5 or null"}, 400)
            kwargs["user_difficulty"] = iv
    if "notes" in data:
        n = data["notes"]
        if n is None:
            kwargs["notes"] = None
        elif isinstance(n, str):
            kwargs["notes"] = n.strip()[:4000]
        else:
            return JSONResponse({"error": "notes must be a string or null"}, 400)
    tags = data.get("tags", "__absent__")
    if tags != "__absent__" and not isinstance(tags, list):
        return JSONResponse({"error": "tags must be an array of strings"}, 400)
    if not kwargs and tags == "__absent__":
        return JSONResponse({"error": "No fields to update"}, 400)
    if kwargs:
        meta_db.set_song_user_meta(key, **kwargs)
    if tags != "__absent__":
        meta_db.set_song_tags(key, tags)
    return meta_db.get_song_user_meta(key)


# Catalog fields the Fix-metadata popup may override/lock — the intersection of
# "displayable identity" and "safe to correct locally". Guitar/practice facts
# and personal fields are never overrides.
_OVERRIDE_FIELDS = frozenset({"title", "artist", "album", "year", "genre"})


@app.get("/api/song/{filename:path}/overrides")
def get_song_overrides(filename: str):
    """Per-field metadata overrides + locks for one song (Fix-metadata popup):
    {"overrides": {field: {"value": str|null, "locked": bool}},
     "pack": {field: str}}. `pack` is the stored value each override sits on top
    of — the popup's Details tab renders it as the revert-to-pack reference and
    the Yours/Pack provenance."""
    key = meta_db._canonical_song_filename(filename)
    return {"overrides": meta_db.get_song_overrides(key),
            "pack": meta_db.pack_fields(key)}


@app.put("/api/song/{filename:path}/overrides")
def put_song_overrides(filename: str, data: dict):
    """Set/clear per-field overrides + locks. Body:
    `{"overrides": {field: {"value": str|null, "locked": bool}}}`. Only catalog
    fields (title/artist/album/year/genre) are accepted. A field left with no
    value and unlocked is removed. Returns the merged override map.

    Clearing rides this PUT (send value:null, locked:false) rather than a DELETE
    sub-route, because `DELETE /api/song/{filename:path}` already owns every
    DELETE under /api/song and would shadow it (same reason as tags)."""
    ov = (data or {}).get("overrides")
    if not isinstance(ov, dict) or not ov:
        return JSONResponse({"error": "overrides must be a non-empty object"}, 400)
    bad = sorted(f for f in ov if f not in _OVERRIDE_FIELDS)
    if bad:
        return JSONResponse({"error": "unknown field(s): " + ", ".join(bad)}, 400)
    key = meta_db._canonical_song_filename(filename)
    for field, spec in ov.items():
        if not isinstance(spec, dict):
            return JSONResponse({"error": f"'{field}' must be an object with value/locked"}, 400)
        kwargs: dict = {}
        if "value" in spec:
            v = spec["value"]
            if v is None:
                kwargs["value"] = None
            elif isinstance(v, (str, int, float)) and not isinstance(v, bool):
                kwargs["value"] = str(v).strip()[:500]
            else:
                return JSONResponse({"error": f"'{field}' value must be a string or null"}, 400)
        if "locked" in spec:
            kwargs["locked"] = bool(spec["locked"])
        if kwargs:
            meta_db.set_song_override(key, field, **kwargs)
    return {"overrides": meta_db.get_song_overrides(key)}


@app.post("/api/songs/user-meta/batch")
def batch_song_user_meta(data: dict):
    """Bulk personal-meta edit over a selection — one request instead of N×2
    per-song round-trips (the batch bar's apply-to-all). DB-only; never touches
    files. Body:
      {"filenames": [...],            # required, non-empty
       "set_difficulty": 1-5 | null,  # optional: set on all / clear on all
       "add_tags": [...],             # optional: add to all (never full-replace)
       "remove_tags": [...]}          # optional: remove from all
    Omit `set_difficulty` entirely to leave each song's difficulty as-is
    (mixed-state "leave unchanged"). Returns {"updated": N, "tags": [...]} so the
    caller can refresh the tag-filter list without a second call."""
    fns = data.get("filenames")
    if not isinstance(fns, list) or not fns:
        return JSONResponse({"error": "filenames must be a non-empty array"}, 400)
    if not all(isinstance(f, str) and f for f in fns):
        return JSONResponse({"error": "filenames must be non-empty strings"}, 400)

    kwargs: dict = {}
    if "set_difficulty" in data:
        v = data["set_difficulty"]
        if v is None or v == "":
            kwargs["set_difficulty"] = None
        else:
            if isinstance(v, bool) or (isinstance(v, float) and not v.is_integer()):
                return JSONResponse({"error": "set_difficulty must be an integer 1–5 or null"}, 400)
            try:
                iv = int(v)
            except (TypeError, ValueError):
                return JSONResponse({"error": "set_difficulty must be an integer 1–5 or null"}, 400)
            if not (1 <= iv <= 5):
                return JSONResponse({"error": "set_difficulty must be 1–5 or null"}, 400)
            kwargs["set_difficulty"] = iv

    add_tags = data.get("add_tags")
    remove_tags = data.get("remove_tags")
    for name, val in (("add_tags", add_tags), ("remove_tags", remove_tags)):
        if val is not None and not isinstance(val, list):
            return JSONResponse({"error": f"{name} must be an array of strings"}, 400)
    if "set_difficulty" not in data and not add_tags and not remove_tags:
        return JSONResponse({"error": "Nothing to apply"}, 400)

    keys = [meta_db._canonical_song_filename(f) for f in fns]
    n = meta_db.batch_user_meta(keys, add_tags=add_tags, remove_tags=remove_tags, **kwargs)
    return {"updated": n, "tags": meta_db.all_tags()}


@app.get("/api/tags")
def list_tags():
    """All personal tags in use (over still-present songs), most-used first —
    powers the tag filter UI."""
    return {"tags": meta_db.all_tags()}


# ── Artist aliases / Tidy-up (P4) ────────────────────────────────────────────
# Canonicalize messy artist tags at DISPLAY ("ACDC" → "AC/DC") without touching
# the feedpak files or the scanner-derived songs.artist. All DB-only.

@app.get("/api/artist-aliases")
def list_artist_aliases():
    """Existing raw→canonical overrides (the Tidy-up 'current merges' list)."""
    return {"aliases": meta_db.list_artist_aliases()}


@app.get("/api/artists/raw")
def list_raw_artists(limit: int = 2000):
    """Distinct RAW artist names + song counts + current canonical — the Tidy-up
    picker (you merge raw variants into one canonical)."""
    return {"artists": meta_db.raw_artists(limit)}


@app.post("/api/artist-aliases")
def set_artist_alias(data: dict):
    """Upsert one override: {raw_name, canonical_name, mb_artist_id?}. A self-alias
    (raw == canonical) clears the row instead (un-merge)."""
    raw = (data.get("raw_name") or "").strip()
    canon = (data.get("canonical_name") or "").strip()
    if not raw or not canon:
        return JSONResponse({"error": "raw_name and canonical_name are required"}, 400)
    result = meta_db.set_artist_alias(raw, canon, (data.get("mb_artist_id") or None))
    if not result.get("ok"):
        # Would form a cycle (raw → … → raw) — refuse rather than corrupt the chain.
        return JSONResponse(
            {"error": "alias would create a cycle", "raw_name": raw, "canonical_name": canon},
            409)
    return {"ok": True, "raw_name": raw, "canonical_name": result.get("canonical_name", canon)}


@app.post("/api/artist-aliases/merge")
def merge_artist_aliases(data: dict):
    """Merge several raw artist variants into one canonical:
    {raw_names: [...], canonical_name}. The canonical's own self-alias is skipped.
    Returns {merged: N}."""
    canon = (data.get("canonical_name") or "").strip()
    raws = data.get("raw_names")
    if not canon:
        return JSONResponse({"error": "canonical_name is required"}, 400)
    if not isinstance(raws, list) or not raws:
        return JSONResponse({"error": "raw_names must be a non-empty array"}, 400)
    n = meta_db.merge_artists(raws, canon)
    return {"merged": n, "canonical_name": canon}


@app.delete("/api/artist-aliases/{raw_name:path}")
def delete_artist_alias(raw_name: str):
    """Remove one override so that raw artist stands on its own again."""
    meta_db.remove_artist_alias(raw_name)
    return {"ok": True}


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
    if not mbid or not _MBID_RE.match(mbid):
        return {"links": {}, "matched": False}
    if not force:
        cached = meta_db.get_artist_enrichment(mbid)
        if cached:
            return {"links": cached["url_rels"], "genres": cached["genres"],
                    "matched": True, "cached": True, "mb_artist_id": mbid}
    if not _enrich_network_enabled():
        return {"links": {}, "matched": True, "offline": True, "mb_artist_id": mbid}
    try:
        body = _mb_http_get(f"artist/{mbid}", {"inc": "url-rels+genres+tags"})
    except EnrichTransportError:
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


# ── Player profile / unified XP / streak (fee[dB]ack v0.3.0) ──────────────────

def _list_bundled_avatars() -> list[str]:
    """Bundled default avatar filenames under static/v3/avatars/."""
    d = STATIC_DIR / "v3" / "avatars"
    if not d.is_dir():
        return []
    exts = {".svg", ".png", ".webp"}
    return sorted(
        p.name for p in d.iterdir()
        if p.is_file() and p.suffix.lower() in exts and not p.name.startswith(".")
    )


@app.get("/api/profile")
def api_get_profile():
    profile = meta_db.get_profile()
    # Equipped cosmetics ride along (resolved to their payloads) so the theme
    # and avatar frame apply at boot without an extra request. Never let a
    # cosmetics/content problem break the profile read.
    cosmetics = {}
    try:
        shop = _get_progression_content()["shop"]
        for slot, item_id in meta_db.get_equipped().items():
            item = shop.get(item_id)
            if item:
                cosmetics[slot] = {"item_id": item_id, "payload": item["payload"]}
    except Exception:
        log.warning("profile cosmetics enrich failed", exc_info=True)
    profile["cosmetics"] = cosmetics
    return profile


def _clean_str(value) -> str:
    """Trim a request field to a string; non-strings (or missing) → ''.
    Lets the raw-`dict` POST handlers treat wrong-typed JSON (an int/list/etc.
    where a string was expected) as "empty" and answer 400, instead of raising
    AttributeError/TypeError → 500 on a later .strip()/`in`."""
    return value.strip() if isinstance(value, str) else ""


@app.post("/api/profile")
def api_set_profile(data: dict):
    """Set/update the player profile. Body: {display_name, avatar:{type,value}}.
    avatar.type is 'default' (value = bundled filename) or 'upload' (value =
    the /api/profile/avatar/<name> URL returned by the upload endpoint); omit
    avatar to keep the existing one (name-only edit)."""
    name = _clean_str(data.get("display_name"))
    if not (1 <= len(name) <= 32):
        return JSONResponse({"error": "Display name must be 1–32 characters."}, status_code=400)
    avatar = data.get("avatar")
    if avatar is None:
        avatar = {}            # omitted → keep the current avatar (name-only edit)
    elif not isinstance(avatar, dict):
        return JSONResponse({"error": "avatar must be an object."}, status_code=400)
    atype = avatar.get("type")
    aval = _clean_str(avatar.get("value"))
    avatar_url = None
    if atype == "default":
        if aval not in _list_bundled_avatars():
            return JSONResponse({"error": "Unknown default avatar."}, status_code=400)
        avatar_url = f"/static/v3/avatars/{aval}"
    elif atype == "upload":
        from safepath import safe_join
        fname = aval.rsplit("/", 1)[-1] if aval.startswith("/api/profile/avatar/") else ""
        target = safe_join(CONFIG_DIR / "avatars", fname) if fname else None
        if target is None or not target.is_file():
            return JSONResponse({"error": "Uploaded avatar not found."}, status_code=400)
        avatar_url = f"/api/profile/avatar/{fname}"
    elif atype:
        return JSONResponse({"error": "Unknown avatar type."}, status_code=400)
    # atype None/missing → keep the current avatar (name-only edit).
    return meta_db.set_profile(name, avatar_url)


@app.get("/api/profile/avatars")
def api_list_avatars():
    return [{"name": n, "url": f"/static/v3/avatars/{n}"} for n in _list_bundled_avatars()]


@app.post("/api/profile/avatar")
def api_upload_avatar(data: dict):
    """Upload a custom avatar as base64 (mirrors the album-art upload pattern).
    Re-encodes to a ≤512px PNG under CONFIG_DIR/avatars/."""
    import base64
    import io
    b64 = data.get("image", "")
    if not isinstance(b64, str) or not b64:
        return JSONResponse({"error": "No image data"}, status_code=400)
    if "," in b64:
        b64 = b64.split(",", 1)[1]
    try:
        raw = base64.b64decode(b64)
    except Exception:
        return JSONResponse({"error": "Invalid base64"}, status_code=400)
    if len(raw) > 6 * 1024 * 1024:
        return JSONResponse({"error": "Image too large (max 6 MB)."}, status_code=400)
    avatars_dir = CONFIG_DIR / "avatars"
    avatars_dir.mkdir(parents=True, exist_ok=True)
    try:
        from PIL import Image
        img = Image.open(io.BytesIO(raw)).convert("RGB")
        img.thumbnail((512, 512))
        fname = f"upload-{secrets.token_hex(4)}.png"  # token busts caches on change
        img.save(str(avatars_dir / fname), "PNG")
    except Exception as e:
        return JSONResponse({"error": f"Invalid image: {e}"}, status_code=400)
    return {"url": f"/api/profile/avatar/{fname}"}


@app.get("/api/profile/avatar/{name}")
def api_get_avatar(name: str):
    from safepath import safe_join
    target = safe_join(CONFIG_DIR / "avatars", name)
    if target is None or not target.is_file():
        return JSONResponse({"error": "not found"}, status_code=404)
    return FileResponse(str(target), media_type="image/png")


@app.get("/api/profile/progress")
def api_profile_progress():
    """One call for the whole profile badge: {level, xp, xp_in_level,
    xp_to_next, current_streak, best_streak, last_active_date}."""
    return meta_db.get_progress()


@app.post("/api/xp/award")
def api_award_xp(data: dict):
    """Award XP into the unified store. Body: {source, amount}. Returns the
    new progress payload. The single XP authority — song-play, minigames, and
    tutorials all feed this (no second curve)."""
    try:
        amount = _as_int(data.get("amount", 0))   # rejects bool / non-integral / inf
    except (TypeError, ValueError, OverflowError):
        return JSONResponse({"error": "amount must be an integer"}, status_code=400)
    # Upper-bound it: an unbounded value overflows SQLite's 64-bit INTEGER on
    # bind (→ 500) and no real run awards anywhere near this.
    if not (0 <= amount <= 10_000_000):
        return JSONResponse({"error": "amount must be between 0 and 10,000,000"}, status_code=400)
    meta_db.award_xp(amount)
    return meta_db.get_progress()


# ── Progression (spec 010): mastery rank, challenges, quests, shop ───────────

def _goal_ui_progress(goal: dict, state: dict, streak: int, xp_total: int) -> tuple:
    """(count, target) for a challenge/quest progress bar. Count goals show
    n/target; threshold goals show how far the live stat is along the line."""
    import progression as progression_mod
    gtype = goal.get("type")
    if gtype in progression_mod.COUNT_GOAL_TYPES:
        target = int(goal.get("target") or 1)
        count = target if state.get("completed") else min(int(state.get("count") or 0), target)
        return count, target
    if gtype == "streak_reached":
        target = int(goal.get("days") or 1)
        return (target if state.get("completed") else min(streak, target)), target
    if gtype == "db_earned":
        target = int(goal.get("amount") or 1)
        return (target if state.get("completed") else min(xp_total, target)), target
    return 0, 1


def _progression_overview() -> dict:
    """The full GET /api/progression payload (also the capability `inspect`
    result): rank, onboarding, per-path challenge checklists, quests, wallet."""
    import progression as progression_mod
    from datetime import datetime as _dt
    content = _get_progression_content()
    now = _dt.now()
    meta_db.ensure_quest_period(content, now)

    state = meta_db.get_progression_state()
    player_paths = meta_db.get_player_paths()
    challenge_state = meta_db.get_challenge_state()
    wallet = meta_db.get_wallet()
    streak_progress = meta_db.get_progress()
    streak = int(streak_progress.get("current_streak") or 0)
    xp_total = wallet["lifetime_db"]
    keys = progression_mod.period_keys(now)

    def _path_order(pid):
        pdef = content["paths"].get(pid) or {}
        return (pdef.get("order") or 0, pid)

    paths_payload = []
    for pid in sorted(player_paths, key=_path_order):
        pdef = content["paths"].get(pid)
        level = player_paths[pid]
        if not pdef:
            # Path selected under older content that no longer ships: keep its
            # rank contribution visible rather than silently dropping it.
            paths_payload.append({"id": pid, "name": pid, "icon": "", "level": level,
                                  "max_level": level, "next": None})
            continue
        next_block = None
        active = progression_mod.active_challenges(content, pid, level)
        if active:
            level_def = next(e for e in pdef["levels"] if e["level"] == level + 1)
            challenges = []
            completed_count = 0
            for ch in active:
                st = challenge_state.get(ch["id"]) or {}
                count, target = _goal_ui_progress(ch["goal"], st, streak, xp_total)
                if st.get("completed"):
                    completed_count += 1
                challenges.append({
                    "id": ch["id"],
                    "title": ch["title"],
                    "description": ch["description"],
                    "count": count,
                    "target": target,
                    "completed": bool(st.get("completed")),
                    "completed_at": st.get("completed_at"),
                })
            next_block = {
                "level": level + 1,
                "required": level_def["required"],
                "completed": completed_count,
                "challenges": challenges,
            }
        paths_payload.append({
            "id": pid,
            "name": pdef["name"],
            "icon": pdef["icon"],
            "level": level,
            "max_level": progression_mod.path_max_level(content, pid),
            "next": next_block,
        })

    available = [
        {"id": pid, "name": pdef["name"], "icon": pdef["icon"]}
        for pid, pdef in sorted(content["paths"].items(), key=lambda kv: (kv[1].get("order") or 0, kv[0]))
        if pid not in player_paths
    ]

    quest_rows = meta_db.get_quest_rows(keys)
    quests_payload = {}
    for period_type in ("daily", "weekly"):
        pool = content["quests"][period_type]["pool"]
        quests = []
        for row in quest_rows:
            if row["period_type"] != period_type:
                continue
            qdef = pool.get(row["quest_id"])
            if not qdef:
                continue  # removed from the pool mid-period: hide, keep the row
            count, target = _goal_ui_progress(qdef["goal"], row, streak, xp_total)
            quests.append({
                "id": row["quest_id"],
                "title": qdef["title"],
                "description": qdef["description"],
                "reward_db": row["reward_db"],
                "count": count,
                "target": target,
                "completed": row["completed"],
                "completed_at": row["completed_at"],
            })
        quests_payload[period_type] = {
            "period_key": keys[period_type],
            "resets_at": progression_mod.period_resets_at(period_type, now).isoformat(),
            "quests": quests,
        }

    return {
        "mastery_rank": progression_mod.mastery_rank(state["calibration_status"], player_paths),
        "onboarding": {
            "calibration_status": state["calibration_status"],
            "calibration_completed_at": state["calibration_completed_at"],
            "diagnostic_filename": _builtin_diagnostic_filename(),
        },
        "paths": paths_payload,
        "available_paths": available,
        "quests": quests_payload,
        "wallet": wallet,
    }


@app.get("/api/progression")
def api_progression():
    return _progression_overview()


@app.post("/api/progression/paths")
def api_progression_add_paths(data: dict):
    """Select instrument paths. Body: {add: [path_id, ...]}. Idempotent;
    removal is unsupported (Mastery Rank never decreases)."""
    add = data.get("add")
    if not isinstance(add, list) or not add:
        return JSONResponse({"error": "add must be a non-empty list of path ids"}, status_code=400)
    content = _get_progression_content()
    for pid in add:
        if not isinstance(pid, str) or pid not in content["paths"]:
            return JSONResponse({"error": f"unknown path: {pid!r}"}, status_code=400)
    meta_db.add_player_paths(add)
    return _progression_overview()


@app.post("/api/progression/onboarding")
def api_progression_onboarding(data: dict):
    """Onboarding calibration choice. Body: {action: "skip"} — completing the
    calibration needs no endpoint, it flows through the normal /api/stats path."""
    if _clean_str(data.get("action")) != "skip":
        return JSONResponse({"error": "action must be 'skip'"}, status_code=400)
    # Spec invariant: onboarding requires picking at least one instrument path
    # before finishing, so skipping straight to rank 1 with no paths would
    # leave a rank that can never grow. Only enforced when the content bundle
    # actually defines paths — broken/empty content must never brick onboarding.
    if _get_progression_content()["paths"] and not meta_db.get_player_paths():
        return JSONResponse(
            {"error": "select at least one instrument path before skipping calibration"},
            status_code=400,
        )
    meta_db.skip_calibration()
    return _progression_overview()


# Externally postable progression events. song_completed is deliberately NOT
# here: it is server-derived inside /api/stats so the scored-session authority
# stays in one place.
_PROGRESSION_EVENT_TYPES = {"minigame_run"}


@app.post("/api/progression/events")
def api_progression_events(data: dict):
    """Generic progression-event intake for plugins (capability `record-event`).
    Body: {type, payload}. Whitelisted types, scalar payload values only."""
    etype = _clean_str(data.get("type"))
    if etype not in _PROGRESSION_EVENT_TYPES:
        return JSONResponse(
            {"error": f"event type must be one of {sorted(_PROGRESSION_EVENT_TYPES)}"},
            status_code=400,
        )
    payload = data.get("payload")
    if payload is None:
        payload = {}
    if not isinstance(payload, dict) or len(payload) > 16:
        return JSONResponse({"error": "payload must be a small object"}, status_code=400)
    clean = {}
    for key, value in payload.items():
        if not isinstance(key, str) or len(key) > 64:
            return JSONResponse({"error": "payload keys must be short strings"}, status_code=400)
        if value is None:
            continue
        if isinstance(value, bool) or (
            not isinstance(value, (int, float, str))
        ) or (isinstance(value, float) and not math.isfinite(value)) or (
            isinstance(value, str) and len(value) > 256
        ):
            return JSONResponse({"error": "payload values must be short strings or finite numbers"}, status_code=400)
        clean[key] = value
    summary = meta_db.record_progression_event(etype, clean, _get_progression_content())
    return {"ok": True, "progression": summary}


@app.get("/api/shop")
def api_shop():
    content = _get_progression_content()
    owned = meta_db.get_owned_items()
    equipped = meta_db.get_equipped()
    items = [
        {**item, "owned": iid in owned, "equipped": equipped.get(item["slot"]) == iid}
        for iid, item in sorted(content["shop"].items())
    ]
    return {"items": items, "wallet": meta_db.get_wallet()}


@app.post("/api/shop/buy")
def api_shop_buy(data: dict):
    """Spend Decibels on a cosmetic. Atomic: balance check + spend + ownership
    in one transaction. Decibels are earned by playing only — never purchasable."""
    item_id = _clean_str(data.get("item_id"))
    item = _get_progression_content()["shop"].get(item_id)
    if not item:
        return JSONResponse({"error": f"unknown item: {item_id!r}"}, status_code=400)
    status, wallet = meta_db.buy_shop_item(item)
    if status == "owned":
        return JSONResponse({"error": "already owned", "wallet": wallet}, status_code=409)
    if status == "insufficient":
        return JSONResponse({"error": "insufficient balance", "wallet": wallet}, status_code=402)
    return {"ok": True, "item_id": item_id, "wallet": wallet}


@app.post("/api/shop/equip")
def api_shop_equip(data: dict):
    """Equip an owned cosmetic into its slot. Body: {slot, item_id|null}
    (null unequips, restoring the default look)."""
    import progression as progression_mod
    slot = _clean_str(data.get("slot"))
    if slot not in progression_mod.SHOP_SLOTS:
        return JSONResponse({"error": f"slot must be one of {sorted(progression_mod.SHOP_SLOTS)}"}, status_code=400)
    item_id = data.get("item_id")
    if item_id is not None:
        item_id = _clean_str(item_id)
        item = _get_progression_content()["shop"].get(item_id)
        if not item or item["slot"] != slot:
            return JSONResponse({"error": f"unknown item for slot {slot}: {item_id!r}"}, status_code=400)
        if item_id not in meta_db.get_owned_items():
            return JSONResponse({"error": "item not owned"}, status_code=403)
    return {"ok": True, "equipped": meta_db.equip_item(slot, item_id)}


# ── Per-song practice stats (fee[dB]ack v0.3.0) ───────────────────────────────

@app.post("/api/stats")
def api_record_stats(data: dict):
    """Record a play. With `score`+`accuracy` → a scored session (plays += 1,
    best_* = max, last_* = new) plus unified-XP + streak side-effects. With
    only `lastPlayPosition`/`last_position` → a lightweight resume-position
    touch (no plays change) so Continue-Playing works for non-scored plays."""
    filename = _clean_str(data.get("filename"))
    if not filename:
        return JSONResponse({"error": "filename required"}, status_code=400)
    # The recorder hands us URL-encoded filenames; canonicalize to the library
    # key so stored rows line up with `songs` (and so the arrangement-count bound
    # below resolves the real song). See MetadataDB._canonical_song_filename.
    filename = meta_db._canonical_song_filename(filename)
    arr_raw = data.get("arrangement", 0)
    if arr_raw is None:
        arrangement = 0
    else:
        try:
            arrangement = _as_int(arr_raw)   # rejects bool / non-integral (1.9) / inf
        except (TypeError, ValueError, OverflowError):
            return JSONResponse({"error": "arrangement must be a non-negative integer"}, status_code=400)
    # Reject (don't silently coerce to 0) so a malformed/out-of-range index
    # can't corrupt arrangement 0's stats; also keeps it bindable to INTEGER.
    if not (0 <= arrangement < 2**63):
        return JSONResponse({"error": "arrangement must be a non-negative integer"}, status_code=400)
    # Bound against the song's real arrangement count when it's a known library
    # song, so a bad index can't create fake arrangement buckets that poison the
    # per-song aggregate / Continue. Skipped when the song isn't in the library
    # yet (count unknown — dead-song reads are filtered anyway).
    _acount = meta_db.arrangement_count(filename)
    if _acount and arrangement >= _acount:
        return JSONResponse({"error": "arrangement out of range for this song"}, status_code=400)
    score = data.get("score")
    accuracy = data.get("accuracy")
    last_pos = data.get("lastPlayPosition", data.get("last_position"))
    if isinstance(last_pos, bool):   # float(False)=0.0 would otherwise store a bogus position
        return JSONResponse({"error": "lastPlayPosition must be a finite number"}, status_code=400)

    # A scored session needs BOTH score and accuracy. Exactly one provided is
    # ambiguous — don't silently fall through to the position-only branch.
    if (score is None) != (accuracy is None):
        return JSONResponse({"error": "score and accuracy must be provided together"}, status_code=400)

    if score is not None and accuracy is not None:
        # Reject booleans explicitly — float(True) would otherwise record a play.
        if isinstance(score, bool) or isinstance(accuracy, bool):
            return JSONResponse({"error": "score/accuracy must be finite numbers"}, status_code=400)
        # Reject NaN/Inf too: round(inf) raises OverflowError (→ 500), and a
        # stored Inf/NaN later breaks JSON serialization of /api/stats reads.
        try:
            score = float(score)
            accuracy = float(accuracy)
            if not (math.isfinite(score) and math.isfinite(accuracy)):
                raise ValueError("non-finite")
            score = int(round(score))
        except (TypeError, ValueError, OverflowError):
            return JSONResponse({"error": "score/accuracy must be finite numbers"}, status_code=400)
        # A huge-but-finite score passes isfinite() yet overflows SQLite's
        # 64-bit INTEGER on bind (→ 500). Bound it to the int64 range.
        if not (0 <= score < 2**63):
            return JSONResponse({"error": "score out of range"}, status_code=400)
        # accuracy is a 0..1 fraction (the recorder's contract); reject
        # out-of-range values so they don't surface as >100% / negative in
        # /api/stats/best and the badge UI.
        if not (0 <= accuracy <= 1):
            return JSONResponse({"error": "accuracy must be between 0 and 1"}, status_code=400)
        # Validate the optional resume position in this branch too (the
        # position-only branch below already rejects non-finite).
        if last_pos is not None:
            try:
                last_pos = float(last_pos)
                if not math.isfinite(last_pos):
                    raise ValueError("non-finite")
            except (TypeError, ValueError, OverflowError):
                return JSONResponse({"error": "lastPlayPosition must be a finite number"}, status_code=400)
        row = meta_db.record_session(filename, arrangement, score=score,
                                     accuracy=accuracy, last_position=last_pos)
        # Unified XP + streak side-effects — never let these drop the stat write.
        progress = None
        try:
            from xp import xp_for_run
            from datetime import date
            meta_db.award_xp(xp_for_run(score))
            meta_db.record_active_day(date.today().isoformat())
            progress = meta_db.get_progress()
        except Exception:
            log.warning("stats side-effects (xp/streak) failed", exc_info=True)
        # Progression engine (spec 010) — same never-drop-the-stat-write
        # contract. Scored sessions are the server-derived `song_completed`
        # authority (scored == note detection by construction); instrument is
        # resolved from library arrangement metadata, after the XP award so
        # db_earned goals see this run's Decibels.
        progression_summary = None
        try:
            import progression as progression_mod
            instrument = progression_mod.instrument_for_arrangement(
                meta_db.arrangement_entry(filename, arrangement)
            )
            progression_summary = meta_db.record_progression_event(
                "song_completed",
                {
                    "filename": filename,
                    "instrument": instrument,
                    "accuracy": accuracy,
                    "score": score,
                    "is_diagnostic": filename == _builtin_diagnostic_filename(),
                },
                _get_progression_content(),
            )
        except Exception:
            log.warning("stats side-effects (progression) failed", exc_info=True)
        return {"stats": row, "progress": progress, "progression": progression_summary}

    # Position-only touch.
    if last_pos is None:
        return JSONResponse(
            {"error": "provide score+accuracy (scored) or lastPlayPosition (resume)"},
            status_code=400,
        )
    try:
        pos = float(last_pos)
        if not math.isfinite(pos):
            raise ValueError("non-finite")
        row = meta_db.touch_position(filename, arrangement, pos)
    except (TypeError, ValueError, OverflowError):
        return JSONResponse({"error": "lastPlayPosition must be a finite number"}, status_code=400)
    # A resume session still counts as playing today: advance the streak (no XP —
    # that's scoring-only) so a non-scored practice day keeps the streak alive,
    # consistent with these sessions also surfacing in recent / continue.
    progress = None
    try:
        from datetime import date
        meta_db.record_active_day(date.today().isoformat())
        progress = meta_db.get_progress()
    except Exception:
        log.warning("stats side-effects (streak) failed", exc_info=True)
    return {"stats": row, "progress": progress}


@app.get("/api/stats/recent")
def api_recent_stats(limit: int = 12):
    """Recently-played rows joined to song metadata for 'Jump back in'."""
    from urllib.parse import quote
    out = []
    for r in meta_db.recent_stats(limit):
        meta = meta_db.conn.execute(
            "SELECT title, artist, tuning_name FROM songs WHERE filename = ?",
            (r["filename"],),
        ).fetchone()
        title, artist, tuning_name = meta if meta else (None, None, None)
        out.append({
            **r,
            "title": title or r["filename"],
            "artist": artist or "",
            "tuning_name": tuning_name or "",
            "art_url": f"/api/song/{quote(r['filename'])}/art",
        })
    return out


@app.get("/api/stats/best")
def api_stats_best():
    """{filename: best_accuracy} for all songs with a recorded best — one call
    to badge the library grid (defined before the {filename} catch-all)."""
    return meta_db.best_accuracy_map()


@app.get("/api/stats/top")
def api_top_stats(limit: int = 5):
    """Top scored songs (best first), joined to song metadata, for the profile
    'Your best scores' panel (defined before the {filename} catch-all)."""
    from urllib.parse import quote
    out = []
    for r in meta_db.top_stats(limit):
        meta = meta_db.conn.execute(
            "SELECT title, artist, tuning_name FROM songs WHERE filename = ?",
            (r["filename"],),
        ).fetchone()
        title, artist, tuning_name = meta if meta else (None, None, None)
        out.append({
            **r,
            "title": title or r["filename"],
            "artist": artist or "",
            "tuning_name": tuning_name or "",
            "art_url": f"/api/song/{quote(r['filename'])}/art",
        })
    return out


@app.get("/api/library/practice-suggestions")
def api_practice_suggestions(limit: int = 8):
    """Growth-edge 'practice next' shelf (P3): attempted-but-not-mastered songs
    ranked by difficulty-appropriateness × mastery-proximity, joined to song
    metadata. Replaces the recency-only 'Keep practicing' shelf ordering. Local
    library only — reads local practice stats."""
    from urllib.parse import quote
    out = []
    for r in meta_db.growth_edge_suggestions(limit):
        meta = meta_db.conn.execute(
            "SELECT title, artist, tuning_name FROM songs WHERE filename = ?",
            (r["filename"],),
        ).fetchone()
        title, artist, tuning_name = meta if meta else (None, None, None)
        out.append({
            **r,
            "title": title or r["filename"],
            "artist": artist or "",
            "tuning_name": tuning_name or "",
            "art_url": f"/api/song/{quote(r['filename'])}/art",
        })
    return out


@app.get("/api/stats/{filename:path}")
def api_song_stats(filename: str):
    return meta_db.get_song_stats(filename)


# ── Playlists / Saved for Later / Continue-Playing (fee[dB]ack v0.3.0) ────────

def _playlist_cover_path(pid) -> Path | None:
    """Filesystem path of a playlist's optional custom cover image (PNG),
    stored under CONFIG_DIR. Returns None for a non-integer id."""
    try:
        pid = int(pid)
    except (TypeError, ValueError):
        return None
    return CONFIG_DIR / "playlist_covers" / f"{pid}.png"


def _playlist_cover_url(pid) -> str | None:
    cover = _playlist_cover_path(pid)
    if not cover or not cover.exists():
        return None
    try:
        # Nanosecond mtime so a same-second replace/remove/re-upload still
        # changes the cache-bust token (int seconds could collide → stale image).
        mt = cover.stat().st_mtime_ns
    except OSError:
        mt = 0
    return f"/api/playlists/{pid}/cover?v={mt}"


@app.get("/api/playlists")
def api_list_playlists():
    lists = meta_db.list_playlists()
    for pl in lists:
        pl["cover_url"] = _playlist_cover_url(pl["id"])
    return lists


@app.post("/api/playlists")
def api_create_playlist(data: dict):
    name = _clean_str(data.get("name"))
    if not (1 <= len(name) <= 100):
        return JSONResponse({"error": "Playlist name must be 1–100 characters."}, status_code=400)
    # kind='album' = a curated album (§7.2): hand-picked works, a chosen chart
    # per slot, played front-to-back on the queue. Absent/None = a regular mix.
    kind = _clean_str(data.get("kind")) or None
    if kind not in (None, "album"):
        return JSONResponse({"error": "kind must be 'album' or omitted"}, status_code=400)
    return meta_db.create_playlist(name, kind=kind)


@app.get("/api/playlists/{pid}")
def api_get_playlist(pid: int):
    pl = meta_db.get_playlist(pid)
    if pl is None:
        return JSONResponse({"error": "not found"}, status_code=404)
    pl["cover_url"] = _playlist_cover_url(pid)
    return pl


@app.patch("/api/playlists/{pid}")
def api_rename_playlist(pid: int, data: dict):
    pl = meta_db.get_playlist(pid)
    if pl is None:
        return JSONResponse({"error": "not found"}, status_code=404)
    if pl["system_key"]:
        return JSONResponse({"error": "System playlists cannot be renamed."}, status_code=400)
    name = _clean_str(data.get("name"))
    if not (1 <= len(name) <= 100):
        return JSONResponse({"error": "Playlist name must be 1–100 characters."}, status_code=400)
    meta_db.rename_playlist(pid, name)
    return meta_db.get_playlist(pid)


@app.delete("/api/playlists/{pid}")
def api_delete_playlist(pid: int):
    pl = meta_db.get_playlist(pid)
    if pl is None:
        return JSONResponse({"error": "not found"}, status_code=404)
    if pl["system_key"]:
        return JSONResponse({"error": "System playlists cannot be deleted."}, status_code=400)
    if not meta_db.delete_playlist(pid):   # vanished under us (concurrent delete)
        return JSONResponse({"error": "not found"}, status_code=404)
    cover = _playlist_cover_path(pid)       # drop any custom cover with the playlist
    if cover and cover.exists():
        try:
            cover.unlink()
        except OSError:
            pass
    return {"ok": True}


@app.post("/api/playlists/{pid}/songs")
def api_add_playlist_song(pid: int, data: dict):
    if meta_db.get_playlist(pid) is None:
        return JSONResponse({"error": "not found"}, status_code=404)
    filename = _clean_str(data.get("filename"))
    if not filename:
        return JSONResponse({"error": "filename required"}, status_code=400)
    if meta_db.add_playlist_song(pid, filename) is None:   # playlist vanished under us
        return JSONResponse({"error": "not found"}, status_code=404)
    pl = meta_db.get_playlist(pid)
    return pl if pl is not None else JSONResponse({"error": "not found"}, status_code=404)


@app.patch("/api/playlists/{pid}/songs/{filename:path}")
def api_update_playlist_slot(pid: int, filename: str, data: dict):
    """Edit one curated-album slot: {"arrangement": name|null} pins/clears the
    slot's arrangement; {"chart_filename": fn} swaps the slot to another chart
    of the same work (position + pin kept). Albums only — a mix has no slots."""
    pl = meta_db.get_playlist(pid)
    if pl is None:
        return JSONResponse({"error": "not found"}, status_code=404)
    if pl.get("kind") != "album":
        return JSONResponse({"error": "Slot editing is for albums."}, status_code=400)
    kwargs = {}
    if "chart_filename" in data:
        new_fn = _clean_str(data.get("chart_filename"))
        if not new_fn:
            return JSONResponse({"error": "chart_filename must be a filename"}, status_code=400)
        kwargs["new_filename"] = new_fn
    if "arrangement" in data:
        arr = data.get("arrangement")
        if arr is not None and not (isinstance(arr, str) and 1 <= len(arr.strip()) <= 100):
            return JSONResponse({"error": "arrangement must be a name or null"}, status_code=400)
        kwargs["arrangement"] = arr.strip() if isinstance(arr, str) else None
    if not kwargs:
        return JSONResponse({"error": "nothing to update"}, status_code=400)
    if meta_db.update_playlist_slot(pid, filename, **kwargs) is None:
        return JSONResponse(
            {"error": "no such slot, or the chart isn't a version of this song"},
            status_code=400)
    return meta_db.get_playlist(pid)


@app.delete("/api/playlists/{pid}/songs/{filename:path}")
def api_remove_playlist_song(pid: int, filename: str):
    if meta_db.get_playlist(pid) is None:
        return JSONResponse({"error": "not found"}, status_code=404)
    meta_db.remove_playlist_song(pid, filename)
    pl = meta_db.get_playlist(pid)
    return pl if pl is not None else JSONResponse({"error": "not found"}, status_code=404)


@app.post("/api/playlists/{pid}/reorder")
def api_reorder_playlist(pid: int, data: dict):
    pl = meta_db.get_playlist(pid)
    if pl is None:
        return JSONResponse({"error": "not found"}, status_code=404)
    order = data.get("order")
    if not isinstance(order, list) or not all(isinstance(f, str) for f in order):
        return JSONResponse({"error": "order must be a list of filenames"}, status_code=400)
    # Require an exact permutation of the playlist's current songs: a list with
    # duplicates, omissions, or extras would otherwise produce duplicate
    # positions / a partial reorder while still returning 200.
    current = [s["filename"] for s in pl["songs"]]
    if len(order) != len(current) or sorted(order) != sorted(current):
        return JSONResponse(
            {"error": "order must be a permutation of the playlist's current songs"},
            status_code=400,
        )
    meta_db.reorder_playlist(pid, order)
    return meta_db.get_playlist(pid)


@app.post("/api/playlists/{pid}/cover")
async def api_set_playlist_cover(pid: int, data: dict):
    """Set a playlist's custom cover from a base64 / data-URL image (PNG/JPG).
    Overrides the content-dependent (song-art) cover. Stored as a small PNG
    thumbnail under CONFIG_DIR/playlist_covers/."""
    if meta_db.get_playlist(pid) is None:
        return JSONResponse({"error": "not found"}, status_code=404)
    import base64
    import io
    b64 = data.get("image", "")
    # Guard the type before the `","` membership test — a non-string image
    # (e.g. {"image": 123} / null) would otherwise raise TypeError → 500.
    # Mirrors the avatar/song-art upload guard.
    if not isinstance(b64, str) or not b64:
        return JSONResponse({"error": "No image data"}, status_code=400)
    if "," in b64:
        b64 = b64.split(",", 1)[1]
    if not b64:
        return JSONResponse({"error": "No image data"}, status_code=400)
    try:
        img_data = base64.b64decode(b64)
    except Exception:
        return JSONResponse({"error": "Invalid base64"}, status_code=400)
    cover = _playlist_cover_path(pid)
    cover.parent.mkdir(parents=True, exist_ok=True)
    try:
        from PIL import Image
        img = Image.open(io.BytesIO(img_data)).convert("RGB")
        img.thumbnail((640, 640))                  # covers stay small
        tmp = cover.with_suffix(".png.tmp")
        img.save(str(tmp), "PNG")
        tmp.replace(cover)
    except Exception as e:
        return JSONResponse({"error": f"Invalid image: {e}"}, status_code=400)
    return {"ok": True, "cover_url": _playlist_cover_url(pid)}


@app.get("/api/playlists/{pid}/cover")
def api_get_playlist_cover(pid: int):
    cover = _playlist_cover_path(pid)
    if not cover or not cover.exists():
        return JSONResponse({"error": "not found"}, status_code=404)
    # no-cache (revalidate) like song art, so a replaced cover is never served
    # stale — pairs with the mtime-ns cache-bust token on the URL.
    return FileResponse(str(cover), media_type="image/png", headers=_ART_CACHE_HEADERS)


@app.delete("/api/playlists/{pid}/cover")
def api_delete_playlist_cover(pid: int):
    cover = _playlist_cover_path(pid)
    if cover and cover.exists():
        try:
            cover.unlink()
        except OSError:
            pass
    return {"ok": True}


# ── Smart collections API (feedBack#636 item 2) ───────────────────────────────
# (rule schema + `_sanitize_collection_rules` are defined with the provider.)

@app.get("/api/collections")
def api_list_collections():
    """Smart/dynamic collections (saved live library filters)."""
    return {"collections": meta_db.list_collections()}


@app.post("/api/collections")
def api_create_collection(data: dict):
    """Create a collection from a name + a set of library filter rules. It
    immediately appears as a source in the library provider picker."""
    if not isinstance(data, dict):
        return JSONResponse({"error": "body must be an object"}, status_code=400)
    name = _clean_str(data.get("name"))
    if not name:
        return JSONResponse({"error": "name required"}, status_code=400)
    col = meta_db.create_collection(name, _sanitize_collection_rules(data.get("rules")))
    _sync_collection_provider(col)
    return {"ok": True, "collection": col}


@app.put("/api/collections/{pid}")
def api_update_collection(pid: int, data: dict):
    """Rename a collection and/or replace its rules."""
    if not isinstance(data, dict):
        return JSONResponse({"error": "body must be an object"}, status_code=400)
    name = _clean_str(data.get("name")) or None
    rules = _sanitize_collection_rules(data["rules"]) if "rules" in data else None
    col = meta_db.update_collection(pid, name=name, rules=rules)
    if col is None:
        return JSONResponse({"error": "collection not found"}, status_code=404)
    _sync_collection_provider(col)
    return {"ok": True, "collection": col}


@app.delete("/api/collections/{pid}")
def api_delete_collection(pid: int):
    """Delete a collection and unregister its provider."""
    if not meta_db.is_collection(pid):
        return JSONResponse({"error": "collection not found"}, status_code=404)
    meta_db.delete_playlist(pid)
    _unregister_collection_provider(pid)
    return {"ok": True}


@app.post("/api/saved/toggle")
def api_toggle_saved(data: dict):
    """Add/remove a song on the reserved Saved-for-Later playlist."""
    filename = _clean_str(data.get("filename"))
    if not filename:
        return JSONResponse({"error": "filename required"}, status_code=400)
    return {"saved": meta_db.toggle_saved(filename)}


@app.get("/api/session/continue")
def api_session_continue():
    """The Continue-Playing card's song (most recent play) or null."""
    return meta_db.continue_session()


# ── Wishlist / "wanted" API (feedBack#636 item 4) ─────────────────────────────

@app.get("/api/wanted")
def api_list_wanted():
    """The wishlist — songs the user wants but doesn't own yet (newest first)."""
    return {"wanted": meta_db.list_wanted()}


@app.post("/api/wanted")
def api_add_wanted(data: dict):
    """Add a not-owned song to the wishlist. `artist`/`title` are required (at
    least one non-empty); `source`/`source_ref`/`note` are optional. Idempotent
    on identity so producers (find_more ownership-diff, manual add) can re-post."""
    if not isinstance(data, dict):
        return JSONResponse({"error": "body must be an object"}, status_code=400)
    artist = _clean_str(data.get("artist"))
    title = _clean_str(data.get("title"))
    if not artist and not title:
        return JSONResponse({"error": "artist or title required"}, status_code=400)
    row = meta_db.add_wanted(
        artist=artist, title=title,
        source=_clean_str(data.get("source")) or "manual",
        source_ref=_clean_str(data.get("source_ref")),
        note=_clean_str(data.get("note")),
    )
    return {"ok": True, "wanted": row}


@app.delete("/api/wanted/{wanted_id}")
def api_remove_wanted(wanted_id: int):
    """Remove a wishlist entry by id."""
    return {"ok": meta_db.remove_wanted(wanted_id)}


# ── Loops API ────────────────────────────────────────────────────────────────

@app.get("/api/loops")
def list_loops(filename: str):
    rows = meta_db.conn.execute(
        "SELECT id, name, start_time, end_time FROM loops WHERE filename = ? ORDER BY start_time",
        (filename,)
    ).fetchall()
    return [{"id": r[0], "name": r[1], "start": r[2], "end": r[3]} for r in rows]


@app.post("/api/loops")
def save_loop(data: dict):
    filename = data.get("filename", "")
    name = data.get("name", "").strip()
    start = data.get("start")
    end = data.get("end")
    if not filename or start is None or end is None:
        return {"error": "Missing fields"}
    if not name:
        count = meta_db.conn.execute(
            "SELECT COUNT(*) FROM loops WHERE filename = ?", (filename,)
        ).fetchone()[0]
        name = f"Loop {count + 1}"
    with meta_db._lock:
        meta_db.conn.execute(
            "INSERT INTO loops (filename, name, start_time, end_time) VALUES (?, ?, ?, ?)",
            (filename, name, float(start), float(end))
        )
        meta_db.conn.commit()
    return {"ok": True, "name": name}


@app.delete("/api/loops/{loop_id}")
def delete_loop(loop_id: int):
    with meta_db._lock:
        meta_db.conn.execute("DELETE FROM loops WHERE id = ?", (loop_id,))
        meta_db.conn.commit()
    return {"ok": True}


# ── Audio Effects Mapping API ───────────────────────────────────────────────

def _audio_effects_error(exc: Exception):
    return JSONResponse({"error": str(exc)}, status_code=400)


@app.get("/api/audio-effects/mappings")
def list_audio_effect_mappings(
    song_key: str = Query(""),
    filename: str = Query(""),
    tone_key: str = Query(""),
    provider_id: str = Query(""),
):
    try:
        return {
            "mappings": audio_effect_mappings.list(
                song_key=song_key,
                filename=filename,
                tone_key=tone_key,
                provider_id=provider_id,
            )
        }
    except ValueError as exc:
        return _audio_effects_error(exc)


@app.post("/api/audio-effects/mappings")
def upsert_audio_effect_mapping(data: dict = Body(...)):
    try:
        mapping = audio_effect_mappings.upsert(data)
    except ValueError as exc:
        return _audio_effects_error(exc)
    return {"ok": True, "mapping": mapping}


@app.delete("/api/audio-effects/mappings/{mapping_id}")
def delete_audio_effect_mapping(mapping_id: int, provider_id: str = Query("")):
    try:
        deleted = audio_effect_mappings.delete(mapping_id, provider_id=provider_id)
    except ValueError as exc:
        return _audio_effects_error(exc)
    if not deleted:
        return JSONResponse({"error": "mapping not found"}, status_code=404)
    return {"ok": True}


@app.post("/api/audio-effects/mappings/{mapping_id}/activate")
def activate_audio_effect_mapping(mapping_id: int, data: dict = Body(default_factory=dict)):
    try:
        provider_id = data.get("provider_id") if "provider_id" in data else data.get("providerId")
        mapping = audio_effect_mappings.activate(mapping_id, provider_id="" if provider_id is None else provider_id)
    except ValueError as exc:
        return _audio_effects_error(exc)
    if not mapping:
        return JSONResponse({"error": "mapping not found"}, status_code=404)
    return {"ok": True, "mapping": mapping}


@app.delete("/api/audio-effects/active-mapping")
def clear_audio_effect_active_mapping(song_key: str = Query(...), tone_key: str = Query("")):
    try:
        cleared = audio_effect_mappings.clear_active(song_key=song_key, tone_key=tone_key)
    except ValueError as exc:
        return _audio_effects_error(exc)
    return {"ok": True, "cleared": cleared}


# ── Settings API ──────────────────────────────────────────────────────────────

# Serializes the read-modify-write in save_settings(). See the note there.
_settings_lock = threading.Lock()


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


def _load_config(config_file):
    """Read and parse config.json. Returns the parsed dict, or None if
    the file is missing, unreadable, invalid JSON, or parses to a
    non-dict (e.g. the file contains `[]` or `42`). Callers treat None
    as "fall back to defaults". Shared between GET and POST so both
    handle bad files the same way."""
    if not config_file.exists():
        return None
    try:
        # Explicit UTF-8: save_settings()/import write config.json as
        # UTF-8 bytes, so the read must not depend on the platform's
        # default text encoding (cp1252 on Windows would mojibake or
        # UnicodeDecodeError on a non-ASCII DLC path).
        parsed = json.loads(config_file.read_text(encoding="utf-8"))
    except Exception:
        return None
    return parsed if isinstance(parsed, dict) else None


@app.get("/api/tunings")
def get_tunings():
    cfg = _load_config(CONFIG_DIR / "config.json") or {}
    ref = cfg.get("reference_pitch", DEFAULT_REFERENCE_PITCH)
    try:
        ref = float(ref)
        if not (430.0 <= ref <= 450.0):
            ref = DEFAULT_REFERENCE_PITCH
    except (TypeError, ValueError):
        ref = DEFAULT_REFERENCE_PITCH
    merged = tuning_providers.get_merged(ref)
    # tuningMidis: the same catalog as exact integer MIDI notes (low → high).
    # Built-ins come straight from TUNING_PRESET_MIDIS (no float round-trip);
    # provider-contributed entries are recovered from their frequencies at the
    # served reference pitch. Every consumer today (the v3 badges, plugins)
    # reconstructs midis client-side via log2 — a rounding footgun at non-440
    # references — so serve the integers once, host-side. Additive: the
    # existing referencePitch/tunings shape is unchanged.
    tuning_midis: dict[str, dict[str, list[int]]] = {}
    for key, names in merged.items():
        builtin = TUNING_PRESET_MIDIS.get(key, {})
        resolved: dict[str, list[int]] = {}
        for name, freqs in names.items():
            midis = builtin.get(name) or freqs_to_midis(freqs, ref)
            if midis:
                resolved[name] = list(midis)
        if resolved:
            tuning_midis[key] = resolved
    return {"referencePitch": ref, "tunings": merged, "tuningMidis": tuning_midis}


@app.get("/api/settings")
def get_settings():
    cfg = _load_config(CONFIG_DIR / "config.json")
    return settings_with_instrument_profiles(cfg if cfg is not None else _default_settings())


@app.post("/api/settings")
def save_settings(data: dict):
    # Partial-update: merge only keys present in the request body so
    # single-key POSTs (like the difficulty slider's oninput) don't
    # clobber unrelated settings on disk.
    #
    # Validation runs FIRST, outside _settings_lock. The dlc_dir branch
    # stats the folder and counts sloppak files, which can be slow on a
    # large or networked DLC dir — holding the lock across it would block
    # every other settings writer (dropdown/slider autosaves, imports).
    # So validation only resolves `updates` (the keys to merge); the
    # short read-merge-write critical section at the end takes the lock.
    config_file = CONFIG_DIR / "config.json"
    updates: dict = {}
    messages: list[str] = []
    # Named dlc_warnings (not `warnings`) so it can't shadow the module-level
    # `import warnings` used elsewhere in this file.
    dlc_warnings: list[str] = []

    if "dlc_dir" in data:
        dlc_path = data["dlc_dir"]
        # null / missing is no-op (preserve on-disk value). Only an
        # explicit empty string means "clear". Non-string values are
        # rejected so Path(...) can't be surprised by non-str JSON.
        if dlc_path is None:
            pass
        elif not isinstance(dlc_path, str):
            return {"error": "dlc_dir must be a string path or empty"}
        elif dlc_path == "":
            updates["dlc_dir"] = ""
        else:
            if Path(dlc_path).is_dir():
                updates["dlc_dir"] = dlc_path
                count = sum(1 for f in Path(dlc_path).iterdir()
                            if f.suffix.lower() in sloppak_mod.SONG_EXTS)
                messages.append(f"DLC folder: {count} song files found")
            else:
                # A non-resolving DLC path (a stale value, an unplugged
                # external/network drive, or a path carried over from another
                # machine) must NOT abort the whole POST. saveSettings() bundles
                # dlc_dir together with demucs_server_url / default_arrangement /
                # av_offset_ms in a single request, so an early `return` here
                # silently dropped every co-submitted key — this is the "can't
                # set the Demucs server address" report (feedBack-demucs-server
                # #3). Record it as a warning, skip persisting dlc_dir, and keep
                # validating the rest so the other settings still save.
                dlc_warnings.append(f"DLC directory not found: {dlc_path}")

    # Both of these are consumed downstream as strings (e.g.
    # demucs_server_url.rstrip('/')), so reject non-string shapes
    # here. Matches the dlc_dir pattern above:
    # null is no-op, empty string clears, non-string is a structured
    # error that preserves the on-disk value.
    for key in ("default_arrangement", "demucs_server_url"):
        if key in data:
            raw = data[key]
            if raw is None:
                pass
            elif not isinstance(raw, str):
                return {"error": f"{key} must be a string or empty"}
            else:
                updates[key] = raw
    if "master_difficulty" in data:
        # Coerce defensively — public endpoint, so `null`, `""`, or a
        # non-numeric string shouldn't 500 the request. float() accepts
        # both integer and float-shaped strings; anything else returns
        # a structured error like the dlc_dir branch above.
        raw = data["master_difficulty"]
        # Reject bool explicitly: Python makes bool a subclass of int, so
        # True/False would otherwise coerce to 1/0 and persist as a valid
        # difficulty. Caller almost certainly means "bad input".
        if isinstance(raw, bool):
            return {"error": "master_difficulty must be a number between 0 and 100"}
        try:
            updates["master_difficulty"] = max(0, min(100, int(float(raw))))
        except (TypeError, ValueError, OverflowError):
            # OverflowError covers int(float("inf")) / int(float("1e309"))
            # which Python raises distinctly from ValueError.
            return {"error": "master_difficulty must be a number between 0 and 100"}

    if "av_offset_ms" in data:
        # Audio-output pipeline latency compensation. Positive values
        # mean audio is running ahead of visuals; the highway adds
        # this to its render clock to catch the visuals up. Clamped
        # to ±1000 ms to mirror the client-side slider — a direct
        # POST shouldn't be able to persist `1e9`. Same defensive
        # coercion shape as master_difficulty above (reject bool,
        # cover OverflowError, structured 4xx-style return on bad
        # input rather than 500).
        raw = data["av_offset_ms"]
        if isinstance(raw, bool):
            return {"error": "av_offset_ms must be a number between -1000 and 1000"}
        try:
            updates["av_offset_ms"] = max(-1000.0, min(1000.0, float(raw)))
        except (TypeError, ValueError, OverflowError):
            return {"error": "av_offset_ms must be a number between -1000 and 1000"}

    # fee[dB]ack v0.3.0 gameplay settings (tabbed settings page). null is a
    # no-op per the merge contract; bad shapes return a structured error
    # rather than 500. countdown_before_song is consumed by the song-start
    # count-in; miss_penalty / fail_behavior are persisted-only stubs.
    if "countdown_before_song" in data:
        raw = data["countdown_before_song"]
        if raw is not None:
            if not isinstance(raw, bool):
                return {"error": "countdown_before_song must be a boolean"}
            updates["countdown_before_song"] = raw
    if "achievements_enabled" in data:
        raw = data["achievements_enabled"]
        if raw is not None:
            if not isinstance(raw, bool):
                return {"error": "achievements_enabled must be a boolean"}
            updates["achievements_enabled"] = raw
    if "use_amp_sims" in data:
        raw = data["use_amp_sims"]
        if raw is not None:
            if not isinstance(raw, bool):
                return {"error": "use_amp_sims must be a boolean"}
            updates["use_amp_sims"] = raw
    if "enrich_enabled" in data:
        raw = data["enrich_enabled"]
        if raw is not None:
            if not isinstance(raw, bool):
                return {"error": "enrich_enabled must be a boolean"}
            updates["enrich_enabled"] = raw
    if "enrich_auto_threshold" in data:
        # Auto-apply confidence for the metadata matcher. 0.5–1.0 are real
        # thresholds; values just above 1.0 are the "Always review" option (a
        # capped score can equal exactly 1.0, so "never auto" must sit above
        # the cap). Same defensive coercion shape as av_offset_ms.
        raw = data["enrich_auto_threshold"]
        if raw is not None:
            if isinstance(raw, bool):
                return {"error": "enrich_auto_threshold must be a number between 0.5 and 1.01"}
            try:
                t = float(raw)
            except (TypeError, ValueError, OverflowError):
                return {"error": "enrich_auto_threshold must be a number between 0.5 and 1.01"}
            if not math.isfinite(t) or not (0.5 <= t <= 1.01):
                return {"error": "enrich_auto_threshold must be a number between 0.5 and 1.01"}
            updates["enrich_auto_threshold"] = t
    for _bool_key in ("enrich_src_musicbrainz", "enrich_src_caa",
                      "enrich_apply_names", "enrich_apply_year",
                      "enrich_apply_genres", "enrich_apply_art",
                      # Artist pages (PR-B): page on/off + external-links opt-in.
                      "artist_pages_enabled", "artist_external_links",
                      # AcoustID audio-fingerprinting opt-in (default off).
                      "acoustid_enabled"):
        if _bool_key in data:
            raw = data[_bool_key]
            if raw is not None:
                if not isinstance(raw, bool):
                    return {"error": f"{_bool_key} must be a boolean"}
                updates[_bool_key] = raw
    if "acoustid_api_key" in data:
        # Free AcoustID application key (opaque token). null is a no-op, empty
        # string clears; length-capped so a bad POST can't bloat config.json.
        # Never logged. The matcher trims + validates presence at read time.
        raw = data["acoustid_api_key"]
        if raw is not None:
            if not isinstance(raw, str) or len(raw) > 128:
                return {"error": "acoustid_api_key must be a string (at most 128 chars)"}
            updates["acoustid_api_key"] = raw.strip()
    if "enrich_review_order" in data:
        raw = data["enrich_review_order"]
        if raw is not None:
            if not isinstance(raw, str) or raw not in ("missing_first", "artist", "recent"):
                return {"error": "enrich_review_order must be one of missing_first, artist, recent"}
            updates["enrich_review_order"] = raw
    if "miss_penalty" in data:
        raw = data["miss_penalty"]
        if raw is not None:
            if not isinstance(raw, str) or raw not in ("none", "low", "medium", "high"):
                return {"error": "miss_penalty must be one of none, low, medium, high"}
            updates["miss_penalty"] = raw
    if "fail_behavior" in data:
        raw = data["fail_behavior"]
        if raw is not None:
            if not isinstance(raw, str) or raw not in ("continue", "restart", "stop"):
                return {"error": "fail_behavior must be one of continue, restart, stop"}
            updates["fail_behavior"] = raw

    # fee[dB]ack v0.3.0 — tuner reference pitch + instrument selection.
    # These drive the topbar tuner/instrument badges and (when installed) the
    # note_detect scoring tuning tables. null is a no-op per the merge contract.
    if "reference_pitch" in data:
        raw = data["reference_pitch"]
        if raw is not None:
            if isinstance(raw, bool):
                return {"error": "reference_pitch must be a number between 430 and 450"}
            try:
                rp = float(raw)
            except (TypeError, ValueError, OverflowError):
                return {"error": "reference_pitch must be a number between 430 and 450"}
            # Reject non-finite rather than letting min/max silently clamp
            # NaN/Inf (and "nan"/"inf") to 430/450.
            if not math.isfinite(rp):
                return {"error": "reference_pitch must be a number between 430 and 450"}
            updates["reference_pitch"] = max(430.0, min(450.0, rp))
    if "instrument" in data:
        raw = data["instrument"]
        if raw is not None:
            if not isinstance(raw, str) or raw not in ("guitar", "bass"):
                return {"error": "instrument must be 'guitar' or 'bass'"}
            updates["instrument"] = raw
    if "string_count" in data:
        raw = data["string_count"]
        if raw is not None:
            try:
                sc = _as_int(raw)   # rejects bool / non-integral (4.9) / inf
            except (TypeError, ValueError, OverflowError):
                return {"error": "string_count must be an integer 4–8"}
            if sc < 4 or sc > 8:
                return {"error": "string_count must be an integer 4–8"}
            updates["string_count"] = sc
    if "tuning" in data:
        raw = data["tuning"]
        # Accept a tuning NAME (string ≤64) or a list of up to 8 semitone
        # offsets (ints −12..12). null is a no-op.
        if raw is not None:
            if isinstance(raw, str):
                if len(raw) > 64:
                    return {"error": "tuning name too long"}
                updates["tuning"] = raw
            elif isinstance(raw, list):
                if len(raw) > 8 or any(isinstance(o, bool) or not isinstance(o, int) or o < -12 or o > 12 for o in raw):
                    return {"error": "tuning offsets must be ≤8 integers between -12 and 12"}
                updates["tuning"] = raw
            else:
                return {"error": "tuning must be a name (string) or a list of semitone offsets"}

    if "pathway" in data:
        raw = data["pathway"]
        if raw is not None:
            if not isinstance(raw, str) or raw not in PROFILE_PATHWAYS:
                return {"error": "pathway must be one of songs, practice, learn, studio"}
            updates["pathway"] = raw

    _profile_patch = None
    if "instrument_profiles" in data:
        raw = data["instrument_profiles"]
        if raw is not None:
            if not isinstance(raw, dict):
                return {"error": "instrument_profiles must be an object"}
            # Validate each PROVIDED profile individually and keep the patch
            # PARTIAL — /api/settings is a partial-merge endpoint, so updating one
            # profile must NOT reset the others to defaults. Merged over the
            # persisted profiles inside the lock below (not via the wholesale
            # `updates` merge, which would clobber the unspecified ones).
            _profile_patch = {}
            for _pid, _praw in raw.items():
                if _pid not in PROFILE_IDS:
                    return {"error": f"unknown instrument profile: {_pid}"}
                _prof, _perr = normalize_instrument_profile(_pid, _praw)
                if _perr:
                    return {"error": _perr}
                _profile_patch[_pid] = _prof
    if "active_instrument_profile" in data:
        raw = data["active_instrument_profile"]
        if raw is not None:
            if not isinstance(raw, str) or raw not in PROFILE_IDS:
                return {"error": "active_instrument_profile must be one of guitar-lead, guitar-rhythm, bass"}
            updates["active_instrument_profile"] = raw
    CONFIG_DIR.mkdir(parents=True, exist_ok=True)
    # Critical section — the read-merge-write must be atomic. FastAPI runs
    # sync handlers in a threadpool, so two concurrent partial POSTs (e.g.
    # the two Settings dropdowns auto-saving back-to-back) could each read
    # the pre-write file and the second write would silently drop the
    # first's key. /api/settings/import shares _settings_lock for the same
    # reason. The seed-from-_default_settings() guards a missing/unreadable
    # /non-dict config.json so the merge can't TypeError and 500 the
    # endpoint. The write is atomic temp+rename so a concurrent reader
    # (export, get_settings, the _get_dlc_dir fallback) never sees a torn
    # file.
    with _settings_lock:
        cfg = _load_config(config_file)
        if cfg is None:
            cfg = _default_settings()
        cfg.update(updates)
        if _profile_patch is not None:
            # Merge the validated partial over the persisted profiles so a
            # single-profile update leaves the others intact (a fresh config
            # falls back to the built-in defaults for the unspecified ones).
            _existing, _ = normalize_instrument_profiles(cfg.get("instrument_profiles"))
            if _existing is None:
                _existing = {}
            _existing.update(_profile_patch)
            cfg["instrument_profiles"] = _existing
        # Only canonicalize/persist the instrument profiles when this save
        # actually touches them (or the config already carries them). GET always
        # virtualizes profiles via settings_with_instrument_profiles, so a save
        # that doesn't touch instrument settings must stay a plain partial merge
        # — otherwise an empty (or unrelated) POST would freeze the default
        # profiles into the on-disk config.
        _profile_keys = ("instrument", "string_count", "tuning", "reference_pitch",
                         "pathway", "instrument_profiles", "active_instrument_profile")
        if "instrument_profiles" in cfg or any(k in updates for k in _profile_keys):
            try:
                cfg = apply_flat_instrument_patch_to_profiles(cfg, updates)
            except ValueError as exc:
                return {"error": str(exc)}
            cfg = settings_with_instrument_profiles(cfg)
        _atomic_write_file(config_file, json.dumps(cfg, indent=2).encode("utf-8"))
    resp = {"message": ". ".join(messages) if messages else "Settings saved"}
    if dlc_warnings:
        # `warnings` is an additive response field (existing clients read
        # `message || error`); fold the text into `message` too so the current
        # settings status line still surfaces the bad DLC path even though the
        # rest of the save succeeded.
        resp["warnings"] = dlc_warnings
        resp["message"] = resp["message"] + " — " + "; ".join(dlc_warnings)
    return resp


# Keys a client "Reset {category}" action may clear. Resetting removes the key
# from config.json so the next GET falls back to the _default_settings() value
# (or the frontend's own default when the key is then absent). Restricting to a
# known set means a malformed or hostile body can't wipe unrelated config.
_RESETTABLE_SETTINGS_KEYS = frozenset({
    "default_arrangement", "demucs_server_url", "master_difficulty",
    "av_offset_ms", "countdown_before_song", "miss_penalty", "fail_behavior",
    "reference_pitch", "instrument", "string_count", "tuning", "pathway",
    "instrument_profiles", "active_instrument_profile",
    "achievements_enabled", "use_amp_sims",
})


@app.post("/api/settings/reset")
def reset_settings(data: dict):
    """Clear the given settings keys back to their defaults — backs the
    per-category "Reset" buttons on the tabbed settings page. Unknown keys are
    ignored (not an error) so a newer client asking to reset a key an older
    server doesn't recognise degrades gracefully. Shares _settings_lock with
    save_settings()/import for the same read-merge-write atomicity reason."""
    raw_keys = data.get("keys")
    if not isinstance(raw_keys, list):
        return {"error": "keys must be a list of setting names"}
    keys = [k for k in raw_keys if isinstance(k, str) and k in _RESETTABLE_SETTINGS_KEYS]
    config_file = CONFIG_DIR / "config.json"
    with _settings_lock:
        cfg = _load_config(config_file)
        if cfg is None:
            # Nothing persisted yet — already at defaults.
            return {"message": "Settings reset", "reset": []}
        removed = [k for k in keys if k in cfg]
        for k in removed:
            del cfg[k]
        # `pathway` is mirrored into every instrument profile, so deleting the
        # flat key alone doesn't reset it — GET re-derives the value from the
        # active profile. Reset it inside the persisted profiles too (back to the
        # "songs" default), without disturbing the rest of the instrument config.
        if "pathway" in keys and isinstance(cfg.get("instrument_profiles"), dict):
            for prof in cfg["instrument_profiles"].values():
                if isinstance(prof, dict):
                    prof["pathway"] = "songs"
            if "pathway" not in removed:
                removed.append("pathway")
        _atomic_write_file(config_file, json.dumps(cfg, indent=2).encode("utf-8"))
    return {"message": "Settings reset", "reset": removed}


# ── Settings export/import (feedBack#113) ───────────────────────────────────

# Bumped only when the bundle JSON shape changes incompatibly. Importer
# refuses anything but this exact value — version mismatches are warned
# but not blocked, schema mismatches ARE blocked.
SETTINGS_BUNDLE_SCHEMA = 1


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


def _validate_server_config_types(cfg: dict) -> str | None:
    """Type-and-range gate for the server_config block of an import
    bundle, mirroring the per-key checks in `POST /api/settings`. The
    importer writes config.json verbatim, so without this gate a
    hand-edited bundle could persist a non-string `demucs_server_url`
    (which downstream code calls `.rstrip('/')` on and crashes) or an
    out-of-range `master_difficulty` (which bypasses the slider's
    clamp). Returns None on success, an error string on the first
    violation. Filesystem-existence checks (e.g. dlc_dir is_dir) are
    NOT performed here — restoring a bundle on a different machine
    legitimately may reference paths that don't exist locally yet,
    and the `POST /api/settings` interactive endpoint is the right
    place for that ergonomic check, not the bulk-restore path.
    Unknown keys are passed through so future settings (and per-plugin
    keys that may be added later) round-trip without code changes
    here."""
    if "dlc_dir" in cfg:
        v = cfg["dlc_dir"]
        if v is not None and not isinstance(v, str):
            return "server_config.dlc_dir must be a string"
    for key in ("default_arrangement", "demucs_server_url"):
        if key in cfg:
            v = cfg[key]
            if v is not None and not isinstance(v, str):
                return f"server_config.{key} must be a string"
    if "master_difficulty" in cfg:
        v = cfg["master_difficulty"]
        # bool is an int subclass — reject explicitly so True/False
        # don't quietly persist as 1/0 difficulty values.
        if isinstance(v, bool) or not isinstance(v, (int, float)):
            return "server_config.master_difficulty must be a number between 0 and 100"
        if not (0 <= v <= 100):
            return "server_config.master_difficulty must be between 0 and 100"
    if "av_offset_ms" in cfg:
        v = cfg["av_offset_ms"]
        if isinstance(v, bool) or not isinstance(v, (int, float)):
            return "server_config.av_offset_ms must be a number between -1000 and 1000"
        if not (-1000 <= v <= 1000):
            return "server_config.av_offset_ms must be between -1000 and 1000"
    # fee[dB]ack v0.3.0 tuner/instrument keys — keep in sync with POST /api/settings.
    if "reference_pitch" in cfg:
        v = cfg["reference_pitch"]
        if v is not None and (isinstance(v, bool) or not isinstance(v, (int, float)) or not (430 <= v <= 450)):
            return "server_config.reference_pitch must be a number between 430 and 450"
    if "instrument" in cfg:
        v = cfg["instrument"]
        if v is not None and v not in ("guitar", "bass"):
            return "server_config.instrument must be 'guitar' or 'bass'"
    if "string_count" in cfg:
        v = cfg["string_count"]
        if v is not None and (isinstance(v, bool) or not isinstance(v, int) or not (4 <= v <= 8)):
            return "server_config.string_count must be an integer between 4 and 8"
    if "tuning" in cfg:
        v = cfg["tuning"]
        if v is not None:
            if isinstance(v, str):
                if len(v) > 64:
                    return "server_config.tuning name too long"
            elif isinstance(v, list):
                if len(v) > 8 or any(isinstance(o, bool) or not isinstance(o, int) or o < -12 or o > 12 for o in v):
                    return "server_config.tuning offsets must be ≤8 integers between -12 and 12"
            else:
                return "server_config.tuning must be a name (string) or a list of semitone offsets"
    if "pathway" in cfg:
        v = cfg["pathway"]
        if v is not None and (not isinstance(v, str) or v not in PROFILE_PATHWAYS):
            return "server_config.pathway must be one of songs, practice, learn, studio"
    if "instrument_profiles" in cfg:
        profiles, error = normalize_instrument_profiles(cfg["instrument_profiles"])
        if error:
            return f"server_config.{error}"
    if "active_instrument_profile" in cfg:
        v = cfg["active_instrument_profile"]
        if v is not None and (not isinstance(v, str) or v not in PROFILE_IDS):
            return "server_config.active_instrument_profile must be one of guitar-lead, guitar-rhythm, bass"
    return None


class _UndeclaredFile(ValueError):
    """Raised when a relpath would otherwise be safe but isn't covered by
    the plugin's manifest allowlist. Distinct from the generic
    `ValueError` so the import handler can warn-and-skip this case
    without resorting to message-string matching (which would silently
    change behavior on a future error-text refactor)."""


def _matches_allowlist(relpath: str, allowed: list[str]) -> bool:
    """Return True if `relpath` is covered by an entry in the manifest's
    `_export_paths`. Entries ending in `/` are directory rules
    (strict prefix-match); other entries are exact-file rules. Both
    `relpath` and `allowed` are POSIX strings already normalized
    through `_normalize_export_paths` on the loader side. Caller is
    expected to pass an already-normalized relpath — `_validate_relpath`
    enforces this so a bundle can't satisfy a prefix rule with a
    string that later normalizes to a different target."""
    for allow in allowed:
        if allow.endswith("/"):
            # Strict prefix match only. We deliberately reject
            # `relpath == prefix.rstrip("/")` — a directory entry
            # never authorizes writing AT the directory itself, and
            # accepting that would let phase 2 try to `os.replace()`
            # over an existing directory and crash mid-apply.
            if relpath.startswith(allow):
                return True
        elif relpath == allow:
            return True
    return False


def _validate_relpath(relpath: str, allowed: list[str], config_dir: Path) -> Path:
    """Resolve `relpath` to an absolute path under `config_dir`, raising
    on anything that smells like path-traversal, an absolute path, or
    a manifest-undeclared file. Layered defenses:

      1. String-level: reject backslash, drive letter, absolute, and
         any `.` / `..` segment in the *raw* input — BEFORE any
         normalization. Critically, this catches the
         `allowed_dir/../config.json` shape: the raw string starts
         with `allowed_dir/`, so a naive prefix-match would accept
         it; if we then normalized first, the `..` would collapse
         away and the segment guard would have nothing to reject. By
         refusing pre-normalization any input containing a `.` or
         `..` segment, we make it impossible for a normalize-then-
         resolve pass to "launder" a hostile prefix into a different
         target.
      2. Allowlist match against the now-known-clean relpath.
         Allowlist-miss raises `_UndeclaredFile` (a `ValueError`
         subclass) so the caller can distinguish "manifest changed
         between export and import" from "this looks like an attack"
         without string-matching the error message.
      3. Realpath check: after resolving under config_dir, the target
         must still live inside config_dir. This catches symlinks-
         under-config_dir attacks where someone planted a symlink
         pointing out and tried to import a file "under" it.
      4. Symlink rejection: even when a symlink (or symlinked
         directory component) resolves to a path that *still* lives
         inside config_dir, importing through it would let an
         allowlisted relpath redirect the write to a different
         in-config file — bypassing the manifest's intent. We probe
         every path component from `config_dir` down to the target
         using `lstat`, refusing if any link is set on the chain.
         This matches the documented "symlinks are never followed on
         import" guarantee.

    Returns the resolved absolute path (caller writes there in phase 2).
    """
    if not isinstance(relpath, str) or not relpath or relpath != relpath.strip():
        raise ValueError(f"illegal relpath: {relpath!r}")
    # Reject backslashes outright — manifest entries are POSIX, and
    # accepting `foo\bar` here on a platform whose Path treats `\` as
    # a separator would let a hostile bundle smuggle traversal past
    # the part-by-part check below.
    if "\\" in relpath:
        raise ValueError(f"relpath uses non-POSIX separator: {relpath!r}")
    # Absolute / drive-letter check before splitting.
    if relpath.startswith("/") or (len(relpath) >= 2 and relpath[1] == ":"):
        raise ValueError(f"relpath must be relative: {relpath!r}")
    raw_parts = relpath.split("/")
    # Empty parts catch `foo//bar` and a trailing `/`. `.` / `..` catch
    # both leading and embedded forms (`./x`, `a/./b`, `allow/../escape`).
    if any(part in ("", ".", "..") for part in raw_parts):
        raise ValueError(f"relpath contains illegal segment: {relpath!r}")
    # Defense-in-depth: any leading `.` segment (e.g. dotfile-disguised
    # paths like `.git/config`) is also rejected — config_dir isn't a
    # place plugins should be writing dotfiles, and accepting them here
    # would let one plugin claim a global filename like `.npmrc`.
    if raw_parts[0].startswith("."):
        raise ValueError(f"relpath starts with dotfile segment: {relpath!r}")

    if not _matches_allowlist(relpath, allowed):
        raise _UndeclaredFile(
            f"relpath not declared in plugin manifest: {relpath!r}"
        )

    target = (config_dir / relpath).resolve()
    config_root = config_dir.resolve()
    # `target == config_root` would mean the relpath resolved to the
    # config dir itself, which can't be a file write target — reject.
    if target == config_root:
        raise ValueError(f"relpath resolves to config_dir itself: {relpath!r}")
    if config_root not in target.parents:
        raise ValueError(f"relpath escapes config_dir: {relpath!r}")

    # Walk every component from config_dir down to (but not including)
    # the target file, refusing if any is a symlink. The target itself
    # is checked too — a symlinked file inside config_dir could still
    # redirect the write to another in-config file, defeating the
    # manifest's allowlist intent. `lstat` is the right primitive: it
    # reports the link itself rather than the link's destination, so a
    # broken or self-referential symlink won't slip through. Missing
    # intermediate dirs are fine — `_atomic_write_file` mkdirs them
    # under config_dir, and a path that doesn't exist yet trivially
    # isn't a symlink.
    probe = config_dir
    for part in relpath.split("/"):
        probe = probe / part
        try:
            st = os.lstat(probe)
        except FileNotFoundError:
            # Component doesn't exist yet → can't be a symlink. Any
            # remaining components also don't exist, so we're done.
            break
        import stat as _stat
        if _stat.S_ISLNK(st.st_mode):
            raise ValueError(
                f"relpath traverses or targets a symlink: {relpath!r}"
            )
    return target


def _encode_file(abs_path: Path) -> dict:
    """Encode a single file for the export bundle. JSON files that parse
    cleanly use the `json` encoding so the bundle stays diff-friendly;
    everything else (sqlite, NAM models, IRs, binary blobs) falls back
    to base64. Symlinks are skipped at the caller — we never reach this
    helper for them."""
    import base64
    raw = abs_path.read_bytes()
    if abs_path.suffix.lower() == ".json":
        try:
            return {"encoding": "json", "data": json.loads(raw.decode("utf-8"))}
        except (UnicodeDecodeError, json.JSONDecodeError):
            # Fall through to base64 — file claimed `.json` but isn't
            # valid JSON; preserve bytes verbatim rather than refusing.
            pass
    return {"encoding": "base64", "data": base64.b64encode(raw).decode("ascii")}


def _decode_entry(entry: dict) -> bytes:
    """Inverse of `_encode_file`. Raises ValueError on malformed entries
    so phase 1 of the importer can refuse the whole bundle without
    having written anything."""
    import base64
    if not isinstance(entry, dict):
        raise ValueError(f"file entry must be an object, got {type(entry).__name__}")
    encoding = entry.get("encoding")
    data = entry.get("data")
    if encoding == "base64":
        if not isinstance(data, str):
            raise ValueError("base64 entry: 'data' must be a string")
        try:
            return base64.b64decode(data, validate=True)
        except Exception as e:
            raise ValueError(f"base64 entry: invalid payload ({e})")
    if encoding == "json":
        # We re-serialize the parsed value with stable formatting. Round
        # trips with the original byte stream aren't guaranteed (key
        # order, whitespace), but the file's *meaning* is preserved.
        try:
            return json.dumps(data, indent=2).encode("utf-8")
        except (TypeError, ValueError) as e:
            raise ValueError(f"json entry: cannot re-serialize ({e})")
    raise ValueError(f"unknown encoding: {encoding!r}")


def _walk_export_paths(allowed: list[str], config_dir: Path) -> dict:
    """Expand a plugin's `_export_paths` against disk and return a
    `{relpath: encoded_entry}` dict. Missing files are silently skipped
    (intentional — manifests can list optional files). Symlinks are
    skipped with no entry. Directories are walked recursively; their
    contained files surface as POSIX-joined relpaths.

    Symlink policy is "skipped and never followed" at every depth:
    `os.walk(..., followlinks=False)` ensures we don't *recurse* into
    symlinked subdirectories, but we additionally drop any symlinked
    entry from `dirnames` (so its name isn't even reported to the
    caller, even though the walker wouldn't descend) and skip files
    whose path is itself a symlink. Without those extra filters, a
    planted symlink directory under an allowed prefix could leak data
    from outside `config_dir` into the export bundle.
    """
    out: dict[str, dict] = {}
    for entry in allowed:
        is_dir = entry.endswith("/")
        rel = entry.rstrip("/")
        abs_target = config_dir / rel
        if abs_target.is_symlink():
            continue
        if is_dir:
            if not abs_target.is_dir():
                continue
            collected: list[Path] = []
            for dirpath, dirnames, filenames in os.walk(
                str(abs_target), followlinks=False
            ):
                # Strip symlinked subdirs from `dirnames` in-place so
                # the walker neither yields their names nor descends.
                dirnames[:] = [
                    d for d in dirnames
                    if not os.path.islink(os.path.join(dirpath, d))
                ]
                for fname in filenames:
                    full = os.path.join(dirpath, fname)
                    if os.path.islink(full) or not os.path.isfile(full):
                        continue
                    collected.append(Path(full))
            # Sort for deterministic bundle output (test fixtures and
            # diffs both rely on stable ordering).
            for child in sorted(collected):
                # POSIX-joined relpath relative to config_dir keeps the
                # bundle cross-platform — Windows-authored bundles can
                # be applied on Linux and vice versa.
                child_rel = child.relative_to(config_dir).as_posix()
                out[child_rel] = _encode_file(child)
        else:
            if not abs_target.is_file():
                continue
            out[rel] = _encode_file(abs_target)
    return out


def _atomic_write_file(target: Path, payload: bytes):
    """Write `payload` to `target` via a uniquely-named sibling temp file
    + os.replace. `os.replace` is atomic on both POSIX and Win32 —
    readers see either the old file or the new one, never a half-written
    state.

    The temp name is generated by `tempfile.mkstemp` so two concurrent
    imports (or two workers sharing the same config volume) can't race
    on the same `<target>.tmp.import` path and clobber each other's
    in-flight writes. On any failure between mkstemp and the successful
    `os.replace`, we remove the temp file so a failed import doesn't
    leave `.tmp.import` litter under config_dir."""
    target.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp_name = tempfile.mkstemp(
        dir=str(target.parent),
        prefix=target.name + ".",
        suffix=".tmp.import",
    )
    tmp = Path(tmp_name)
    # Hand fd to os.fdopen inside its own try, so a failure to wrap
    # the descriptor (rare — typically EMFILE / ENOMEM) doesn't leak
    # the raw fd. On Windows an open fd would also keep the temp file
    # locked and undeletable. Once `with` enters, the fdopen'd file
    # owns close responsibility.
    try:
        f = os.fdopen(fd, "wb")
    except Exception:
        os.close(fd)
        try:
            tmp.unlink()
        except OSError:
            pass
        raise
    try:
        with f:
            f.write(payload)
        os.replace(tmp, target)
    except Exception:
        try:
            tmp.unlink()
        except OSError:
            pass
        raise


# Core (non-plugin) server-side state that the settings bundle backs up
# alongside config.json. The library DB is the only state a rescan can't
# rebuild (scores, favorites, playlists, play history); the art dirs hold
# custom playlist covers + the user avatar. `web_library.db` is handled
# specially (consistent snapshot on export, staged restore on import) — the
# art dirs are walked like plugin export paths. NOTE: custom uploaded
# *song* art currently lands in `art_cache/` commingled with the derived
# (rebuildable) cache, so it is intentionally NOT bundled here to avoid
# bloating the backup with regenerable thumbnails — splitting custom song
# art into its own dir is a tracked follow-up (got-feedback/feedBack#636).
_CORE_LIBRARY_DB = "web_library.db"
_CORE_EXPORT_ART_DIRS = ("playlist_covers/", "avatars/")
_CORE_IMPORT_ALLOWED = (_CORE_LIBRARY_DB,) + _CORE_EXPORT_ART_DIRS


def _snapshot_library_db() -> dict | None:
    """A consistent, fully-checkpointed single-file copy of the live library
    DB, base64-encoded for the bundle. Uses the SQLite online-backup API so
    it is safe to call while the server is serving requests; the live write
    lock is held for the copy so no write lands mid-snapshot. Returns None if
    the DB or backup is unavailable (export proceeds without it)."""
    import base64
    fd, tmp = tempfile.mkstemp(dir=str(CONFIG_DIR), prefix="._dbsnap.", suffix=".db")
    os.close(fd)
    try:
        dst = sqlite3.connect(tmp)
        try:
            with meta_db._lock:
                meta_db.conn.backup(dst)
        finally:
            dst.close()
        raw = Path(tmp).read_bytes()
    except (sqlite3.Error, OSError):
        log.warning("library DB snapshot for settings export failed", exc_info=True)
        return None
    finally:
        for suffix in ("", "-wal", "-shm"):
            try:
                Path(tmp + suffix).unlink()
            except FileNotFoundError:
                pass
    return {"encoding": "base64", "data": base64.b64encode(raw).decode("ascii")}


def _sqlite_payload_integrity_ok(payload: bytes) -> bool:
    """Validate decoded DB bytes by materializing them to a temp file and
    running the same integrity probe used at restore time — so a corrupt or
    truncated snapshot is refused at import, before it's ever staged."""
    fd, tmp = tempfile.mkstemp(dir=str(CONFIG_DIR), prefix="._dbcheck.", suffix=".db")
    try:
        with os.fdopen(fd, "wb") as f:
            f.write(payload)
        return _sqlite_file_integrity_ok(Path(tmp))
    except OSError:
        return False
    finally:
        try:
            Path(tmp).unlink()
        except FileNotFoundError:
            pass


def _core_server_files() -> dict | None:
    """`{relpath: encoded_entry}` for core server-side state in the bundle:
    a snapshot of the library DB plus any custom playlist covers / avatar.
    Returns None if the DB snapshot could not be produced — the caller must
    treat that as a hard export failure rather than silently shipping a
    backup that's missing the irreplaceable library state."""
    snap = _snapshot_library_db()
    if snap is None:
        return None
    out: dict[str, dict] = dict(_walk_export_paths(list(_CORE_EXPORT_ART_DIRS), CONFIG_DIR))
    out[_CORE_LIBRARY_DB] = snap
    return out


@app.get("/api/settings/export")
def export_settings():
    """Build a settings bundle covering server config + opted-in plugin
    server-side files. Frontend layers in `local_storage` before
    triggering the download. See feedBack#113."""
    import datetime
    from plugins import LOADED_PLUGINS, PLUGINS_LOCK

    config_file = CONFIG_DIR / "config.json"
    server_config = _load_config(config_file)
    if server_config is None:
        server_config = _default_settings()
    server_config = settings_with_instrument_profiles(server_config)

    # Snapshot the library DB + custom art FIRST: if the irreplaceable state
    # can't be captured, abort with an error rather than hand back a bundle
    # that looks like a backup but silently omits it.
    core_files = _core_server_files()
    if core_files is None:
        return JSONResponse(
            {"ok": False, "error": "could not snapshot the library database; "
                                   "export aborted to avoid an incomplete backup"},
            status_code=500,
        )

    plugin_blocks: dict[str, dict] = {}
    with PLUGINS_LOCK:
        plugins_snapshot = list(LOADED_PLUGINS)
    for p in plugins_snapshot:
        allowed = p.get("_export_paths") or []
        plugin_blocks[p["id"]] = {"files": _walk_export_paths(allowed, CONFIG_DIR)}

    # Capture the timestamp once so the bundle's `exported_at` and the
    # download filename's date prefix can't disagree if the request
    # crosses midnight UTC between the two formats.
    now = datetime.datetime.now(datetime.timezone.utc)
    bundle = {
        "schema": SETTINGS_BUNDLE_SCHEMA,
        "exported_at": now.strftime("%Y-%m-%dT%H:%M:%SZ"),
        "feedBack_version": _running_version(),
        "server_config": server_config,
        "plugin_server_configs": plugin_blocks,
        "core_server_files": core_files,
    }
    filename = f"feedBack-settings-{now.strftime('%Y-%m-%d')}.json"
    return JSONResponse(
        bundle,
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


@app.post("/api/settings/import")
def import_settings(bundle: dict):
    """Apply a previously exported settings bundle. Validates the entire
    bundle in phase 1 (no disk writes); only on full success does
    phase 2 commit each file via temp+rename. The frontend reads
    `local_storage` itself — server ignores it. See feedBack#113."""
    from plugins import LOADED_PLUGINS, PLUGINS_LOCK

    if not isinstance(bundle, dict):
        return JSONResponse({"ok": False, "error": "bundle must be a JSON object"}, status_code=400)

    # ── Phase 1: validate everything before touching disk ────────────
    schema = bundle.get("schema")
    if schema != SETTINGS_BUNDLE_SCHEMA:
        return JSONResponse(
            {
                "ok": False,
                "error": f"unsupported schema {schema!r}; this server speaks schema {SETTINGS_BUNDLE_SCHEMA}",
            },
            status_code=400,
        )

    server_config = bundle.get("server_config")
    if not isinstance(server_config, dict):
        return JSONResponse(
            {"ok": False, "error": "server_config must be an object"},
            status_code=400,
        )
    cfg_err = _validate_server_config_types(server_config)
    if cfg_err is not None:
        return JSONResponse(
            {"ok": False, "error": cfg_err},
            status_code=400,
        )

    plugin_blocks = bundle.get("plugin_server_configs") or {}
    if not isinstance(plugin_blocks, dict):
        return JSONResponse(
            {"ok": False, "error": "plugin_server_configs must be an object"},
            status_code=400,
        )

    warnings: list[str] = []
    bundle_version = bundle.get("feedBack_version")
    running = _running_version()
    if bundle_version and bundle_version != running:
        warnings.append(
            f"version mismatch: bundle {bundle_version!r} vs running {running!r}; importing anyway"
        )

    with PLUGINS_LOCK:
        by_id = {p["id"]: p for p in LOADED_PLUGINS}

    # Stage every (display_relpath, target_abs_path, payload) tuple before
    # writing. The relpath is what we surface in the `partial` field on a
    # mid-apply failure — absolute paths would leak the deployment's
    # config_dir layout, while the relpath is the same identifier the
    # bundle itself used and is portable across machines.
    staged: list[tuple[str, Path, bytes]] = []
    applied_plugins: list[str] = []
    for plugin_id, block in plugin_blocks.items():
        if not isinstance(plugin_id, str) or not plugin_id:
            return JSONResponse(
                {"ok": False, "error": f"invalid plugin id key: {plugin_id!r}"},
                status_code=400,
            )
        plugin = by_id.get(plugin_id)
        if plugin is None:
            warnings.append(f"plugin {plugin_id!r} not loaded; skipping its files")
            continue
        if not isinstance(block, dict):
            return JSONResponse(
                {"ok": False, "error": f"plugin {plugin_id!r}: block must be an object"},
                status_code=400,
            )
        files = block.get("files") or {}
        if not isinstance(files, dict):
            return JSONResponse(
                {"ok": False, "error": f"plugin {plugin_id!r}: files must be an object"},
                status_code=400,
            )
        allowed = plugin.get("_export_paths") or []
        skipped_for_plugin: list[str] = []
        applied_for_plugin = False
        for relpath, file_entry in files.items():
            try:
                target = _validate_relpath(relpath, allowed, CONFIG_DIR)
            except _UndeclaredFile:
                # Manifest-allowlist miss is a normal outcome of a
                # plugin update between export and import — warn-and-
                # skip so the rest of the bundle still applies.
                skipped_for_plugin.append(relpath)
                continue
            except ValueError as e:
                # Path-traversal / absolute-path / illegal-segment /
                # backslash / dotfile errors are hard failures: we
                # never want to apply a bundle that contains those,
                # even partially. Caught AFTER `_UndeclaredFile`
                # because that's a `ValueError` subclass — Python
                # would otherwise route it through this branch.
                return JSONResponse(
                    {
                        "ok": False,
                        "error": f"plugin {plugin_id!r}, file {relpath!r}: {e}",
                    },
                    status_code=400,
                )
            try:
                payload = _decode_entry(file_entry)
            except ValueError as e:
                return JSONResponse(
                    {
                        "ok": False,
                        "error": f"plugin {plugin_id!r}, file {relpath!r}: {e}",
                    },
                    status_code=400,
                )
            # Display key prefixes the plugin id so a partial-failure
            # report is unambiguous when two plugins happen to declare
            # files with the same relpath.
            display = f"{plugin_id}/{relpath}"
            staged.append((display, target, payload))
            applied_for_plugin = True
        if skipped_for_plugin:
            warnings.append(
                f"plugin {plugin_id!r}: skipped {len(skipped_for_plugin)} file(s) "
                f"no longer declared in manifest: {skipped_for_plugin}"
            )
        if applied_for_plugin:
            applied_plugins.append(plugin_id)

    # ── Core server-side files (library DB + custom art) ─────────────
    core_blocks = bundle.get("core_server_files") or {}
    if not isinstance(core_blocks, dict):
        return JSONResponse(
            {"ok": False, "error": "core_server_files must be an object"},
            status_code=400,
        )
    db_restore_staged = False
    applied_core: list[str] = []
    for relpath, file_entry in core_blocks.items():
        if not isinstance(relpath, str) or not relpath:
            return JSONResponse(
                {"ok": False, "error": f"core_server_files: invalid relpath key {relpath!r}"},
                status_code=400,
            )
        if relpath == _CORE_LIBRARY_DB:
            # Stage the DB beside the live one; the swap happens at next
            # startup (_apply_pending_db_restore), so we never overwrite a DB
            # the server holds open or strand a stale WAL against a fresh file.
            target = CONFIG_DIR / (_CORE_LIBRARY_DB + ".restore")
            db_restore_staged = True
        else:
            try:
                target = _validate_relpath(relpath, list(_CORE_IMPORT_ALLOWED), CONFIG_DIR)
            except _UndeclaredFile:
                warnings.append(f"core_server_files: skipped undeclared path {relpath!r}")
                continue
            except ValueError as e:
                return JSONResponse(
                    {"ok": False, "error": f"core_server_files, file {relpath!r}: {e}"},
                    status_code=400,
                )
        try:
            payload = _decode_entry(file_entry)
        except ValueError as e:
            return JSONResponse(
                {"ok": False, "error": f"core_server_files, file {relpath!r}: {e}"},
                status_code=400,
            )
        # Guard the DB payload: a truncated/corrupt file staged as the restore
        # would fail to open at startup and brick the app (after the live DB
        # is already gone). Reject anything that doesn't open + pass
        # quick_check before it's ever staged.
        if relpath == _CORE_LIBRARY_DB and not _sqlite_payload_integrity_ok(payload):
            return JSONResponse(
                {"ok": False, "error": "core_server_files: web_library.db is not a valid SQLite database"},
                status_code=400,
            )
        staged.append((f"core/{relpath}", target, payload))
        applied_core.append(relpath)
    if db_restore_staged:
        warnings.append(
            "library database restored; restart FeedBack to load it "
            "(scores, favorites, playlists, and play history)"
        )

    # ── Phase 2: commit ──────────────────────────────────────────────
    written: list[str] = []
    try:
        for display, target, payload in staged:
            _atomic_write_file(target, payload)
            written.append(display)
        # Server config last so a write failure on a plugin file
        # doesn't leave config.json mismatched against the (untouched)
        # plugin state. Full-replace: caller is responsible for the
        # whole dict — this is restore semantics, not partial-update.
        CONFIG_DIR.mkdir(parents=True, exist_ok=True)
        # Share _settings_lock with save_settings() so a full-replace
        # import and a concurrent partial-update POST can't interleave
        # on config.json and drop each other's write.
        with _settings_lock:
            _atomic_write_file(
                CONFIG_DIR / "config.json",
                json.dumps(settings_with_instrument_profiles(server_config), indent=2).encode("utf-8"),
            )
    except OSError as e:
        # Phase-1 validation should have caught all foreseeable
        # failures; an OSError here means disk-level trouble (ENOSPC,
        # permission). We can't roll back already-replaced files
        # because we didn't snapshot them — surface what got written
        # (as relpaths, not absolute server paths) so the user knows
        # the state is partial without leaking deployment layout.
        # Disarm a staged DB restore THIS request wrote: a partial import must
        # NOT silently swap the library DB on the next restart. Gate on the
        # write actually having happened (display key in `written`) so we don't
        # delete a valid restore staged by a prior, not-yet-applied import.
        if f"core/{_CORE_LIBRARY_DB}" in written:
            try:
                (CONFIG_DIR / (_CORE_LIBRARY_DB + ".restore")).unlink()
            except FileNotFoundError:
                pass
        return JSONResponse(
            {
                "ok": False,
                "error": f"write failed mid-apply: {e}",
                "partial": written,
            },
            status_code=500,
        )

    return {
        "ok": True,
        "warnings": warnings,
        "applied": {
            "server_config": True,
            "plugins": applied_plugins,
            "core_files": applied_core,
        },
        "restart_required": db_restore_staged,
    }


# ── Diagnostic bundle export (feedBack#166) ──────────────────────────
#
# One-click "Export Diagnostics" in Settings produces a redacted zip
# combining server logs, system info, hardware (CPU/GPU/RAM), plugin
# inventory, and the browser-side console transcript + hardware probe.
# The bundle format is specified in docs/diagnostics-bundle-spec.md.

from fastapi import Body

from diagnostics_bundle import build_bundle as _diag_build, preview_bundle as _diag_preview
from diagnostics_hardware import collect as _diag_hardware


def _diag_log_file() -> Path | None:
    raw = os.environ.get("LOG_FILE", "").strip()
    if not raw:
        return None
    return Path(raw)


def _diag_plugins_roots() -> list[Path]:
    """Return all plugin root directories for orphan scanning.

    Includes both the built-in ``plugins/`` directory and
    ``FEEDBACK_PLUGINS_DIR`` when set, so user-installed plugins and
    orphans in the external dir are reflected in the bundle.
    """
    roots: list[Path] = []
    user_dir = getenv_compat("FEEDBACK_PLUGINS_DIR", "").strip()
    if user_dir:
        p = Path(user_dir)
        if p.is_dir():
            roots.append(p)
    builtin = Path(__file__).parent / "plugins"
    if builtin not in roots:
        roots.append(builtin)
    return roots


def _diag_coerce_bool(v, *, default: bool = True) -> bool:
    """Coerce a request-side value to bool, accepting both JSON booleans and
    string representations.

    - Falsy strings: ``"false"``, ``"0"``, ``"no"``, ``""`` → ``False``
    - ``None`` → *default*
    - Everything else (including ``"true"``, ``"1"``) → ``True``
    """
    if v is None:
        return default
    if isinstance(v, bool):
        return v
    if isinstance(v, str):
        return v.strip().lower() not in ("false", "0", "no", "")
    return bool(v)


def _diag_normalize_include(include: dict | None) -> dict:
    """Coerce request-side flags to the booleans build_bundle expects.
    Missing keys default to True so a bare {} request still produces
    the full bundle.

    Accepts both JSON booleans (``true``/``false``) and string
    representations so callers that serialize flags as strings behave
    consistently with the preview endpoint:
    - Falsy strings: ``"false"``, ``"0"``, ``"no"``, ``""`` → ``False``
    - Everything else (including ``"true"``, ``"1"``, ``"yes"``) → ``True``
    """
    keys = ("system", "hardware", "logs", "console", "plugins")
    if not isinstance(include, dict):
        return {k: True for k in keys}

    return {k: _diag_coerce_bool(include.get(k), default=True) for k in keys}


# Server-side caps on client-supplied payload sections.  diagnostics.js
# enforces a 500-entry / ~250 KB ring buffer on the browser side; these
# bounds give generous headroom while still preventing a crafted POST from
# forcing the server to allocate arbitrarily large in-memory bundles.
_DIAG_MAX_CONSOLE_ENTRIES = 1000          # hard cap: truncate silently
_DIAG_MAX_CONSOLE_BYTES = 2 * 1024 * 1024  # 2 MB hard cap on total console list
_DIAG_MAX_CLIENT_PAYLOAD_BYTES = 2 * 1024 * 1024   # 2 MB per dict section
_DIAG_MAX_CONTRIBUTIONS_BYTES = 4 * 1024 * 1024    # 4 MB aggregate cap for contributions


def _diag_cap_console(v) -> list | None:
    """Return *v* if it is a list, truncated to _DIAG_MAX_CONSOLE_ENTRIES entries
    and _DIAG_MAX_CONSOLE_BYTES total.  Entries are accumulated until either cap
    is reached; no partial-entry splitting occurs."""
    if not isinstance(v, list):
        return None
    result = v[:_DIAG_MAX_CONSOLE_ENTRIES]
    # Also enforce a byte cap — the count cap alone does not bound memory when
    # entries contain arbitrarily large strings.
    try:
        out = []
        total = 0
        for entry in result:
            encoded = json.dumps(entry, separators=(",", ":")).encode("utf-8", errors="replace")
            if total + len(encoded) > _DIAG_MAX_CONSOLE_BYTES:
                break
            out.append(entry)
            total += len(encoded)
        return out
    except (TypeError, ValueError):
        return None


def _diag_cap_dict(v) -> dict | None:
    """Return *v* if it is a dict whose JSON serialisation fits within
    _DIAG_MAX_CLIENT_PAYLOAD_BYTES, otherwise return None."""
    if not isinstance(v, dict):
        return None
    try:
        encoded = json.dumps(v, separators=(",", ":")).encode("utf-8", errors="replace")
    except (TypeError, ValueError) as e:
        log.warning("diagnostics client payload is not JSON-serialisable, dropping: %s", e)
        return None
    if len(encoded) > _DIAG_MAX_CLIENT_PAYLOAD_BYTES:
        return None
    return v


def _diag_cap_contributions(v, known_ids=None) -> dict | None:
    """Apply per-plugin and aggregate size caps on client_contributions.

    Unlike _diag_cap_dict(), which drops the whole dict when any plugin
    exceeds the limit, this function caps each plugin independently so
    one noisy plugin does not silence every other plugin's contribution.

    Parameters
    ----------
    v:
        The raw contributions dict from the POST payload.
    known_ids:
        When provided, contributions from plugins not in this set are
        skipped *before* serialisation, preventing a malicious caller
        from forcing the server to JSON-encode hundreds of near-limit
        payloads that ``build_bundle()`` would later discard anyway.
        ``None`` means "accept all plugin ids" (used in tests / preview).
    """
    if not isinstance(v, dict):
        return None
    result = {}
    total_bytes = 0
    for pid, contribution in v.items():
        if not isinstance(pid, str):
            continue
        # Filter unknown plugin ids early — before serialising — so a
        # crafted request cannot force large allocations for plugins that
        # build_bundle() would drop.
        if known_ids is not None and pid not in known_ids:
            continue
        try:
            encoded = json.dumps(contribution, separators=(",", ":")).encode("utf-8", errors="replace")
        except (TypeError, ValueError) as e:
            log.warning(
                "client_contributions[%r] is not JSON-serialisable, dropping: %s", pid, e
            )
            continue
        if len(encoded) > _DIAG_MAX_CLIENT_PAYLOAD_BYTES:
            log.warning(
                "client_contributions[%r] exceeds %d bytes, dropping",
                pid, _DIAG_MAX_CLIENT_PAYLOAD_BYTES,
            )
            continue
        if total_bytes + len(encoded) > _DIAG_MAX_CONTRIBUTIONS_BYTES:
            log.warning(
                "client_contributions aggregate size limit (%d bytes) reached, "
                "dropping remaining entries",
                _DIAG_MAX_CONTRIBUTIONS_BYTES,
            )
            break
        result[pid] = contribution
        total_bytes += len(encoded)
    return result or None


@app.post("/api/diagnostics/export")
def export_diagnostics(payload: dict = Body(default_factory=dict)):
    """Build a diagnostic bundle and stream it back as a zip download.

    The browser layers in `client_console`, `client_hardware`,
    `client_ua`, and `local_storage` before posting; the server adds
    server logs, hardware, plugin inventory, and packages everything
    into a single zip.

    Errors during plugin diagnostics callables are caught and logged
    to the bundle's manifest `notes` rather than failing the export.
    """
    from plugins import LOADED_PLUGINS, PLUGINS_LOCK

    redact = _diag_coerce_bool(payload.get("redact", True), default=True)
    include = _diag_normalize_include(payload.get("include"))
    client_console = _diag_cap_console(payload.get("client_console"))
    client_hardware = _diag_cap_dict(payload.get("client_hardware"))
    client_ua = _diag_cap_dict(payload.get("client_ua"))
    local_storage = _diag_cap_dict(payload.get("local_storage"))
    # Fetch the plugin list first so we can filter contributions to known
    # plugin ids before serialising — prevents a crafted request from
    # forcing large allocations for plugins build_bundle() would drop.
    with PLUGINS_LOCK:
        plugins_snapshot = list(LOADED_PLUGINS)
    known_ids = {p.get("id") for p in plugins_snapshot if isinstance(p.get("id"), str)}
    client_contributions = _diag_cap_contributions(
        payload.get("client_contributions"), known_ids=known_ids
    )

    zip_bytes, filename, _manifest = _diag_build(
        feedBack_version=_running_version(),
        config_dir=CONFIG_DIR,
        dlc_dir=_get_dlc_dir(),
        log_file=_diag_log_file(),
        loaded_plugins=plugins_snapshot,
        include=include,
        redact=redact,
        client_console=client_console,
        client_hardware=client_hardware,
        client_ua=client_ua,
        local_storage=local_storage,
        client_contributions=client_contributions,
        log=log,
        plugins_root=_diag_plugins_roots(),
    )
    return Response(
        content=zip_bytes,
        media_type="application/zip",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


@app.get("/api/diagnostics/preview")
def preview_diagnostics(
    redact: bool = True,
    system: bool = True,
    hardware: bool = True,
    logs: bool = True,
    console: bool = True,
    plugins: bool = True,
):
    """Return what `/api/diagnostics/export` would produce, minus the
    actual file contents — file tree, sizes, schemas, redaction counts.
    Lets the Settings UI show the user what's about to be sent."""
    from plugins import LOADED_PLUGINS, PLUGINS_LOCK

    include = {
        "system": system,
        "hardware": hardware,
        "logs": logs,
        "console": console,
        "plugins": plugins,
    }
    with PLUGINS_LOCK:
        plugins_snapshot = list(LOADED_PLUGINS)
    return _diag_preview(
        feedBack_version=_running_version(),
        config_dir=CONFIG_DIR,
        dlc_dir=_get_dlc_dir(),
        log_file=_diag_log_file(),
        loaded_plugins=plugins_snapshot,
        include=include,
        redact=redact,
        log=log,
        plugins_root=_diag_plugins_roots(),
    )


@app.get("/api/diagnostics/hardware")
def diagnostics_hardware():
    """Backend hardware probe (cross-platform). Reusable independently
    of the bundle export — handy for "what's my GPU" plugin queries."""
    return _diag_hardware()


# ── Plugin-provided routes are registered at startup via plugins/__init__.py ─
# (CustomsForge, Ultimate Guitar, etc. are loaded from plugins/ directory)



def _if_none_match_hits(header: str | None, etag: str) -> bool:
    """True if an If-None-Match header matches `etag` (weak comparison).

    Handles the `*` wildcard and comma-separated lists, and ignores a weak
    `W/` prefix on either side — the standard semantics for a conditional GET.
    """
    if not header:
        return False
    bare = etag.removeprefix("W/")
    for tok in header.split(","):
        t = tok.strip()
        if t == "*" or t.removeprefix("W/") == bare:
            return True
    return False


# Album art is served with a strong validator (an ETag on the sloppak byte
# path; FileResponse's own ETag/Last-Modified on the file paths) and revalidated
# with `no-cache`. That keeps re-scroll cheap — a conditional GET returns a
# bodyless 304 — without ever serving a stale cover. A long `immutable` max-age
# was rejected: the frontend's `?v=<mtime>` buster is only second-resolution, so
# a same-second cover rewrite would keep the URL and pin the old bytes for the
# cache lifetime. Validation cost is negligible for a localhost backend.
_ART_CACHE_HEADERS = {"Cache-Control": "no-cache"}


def _art_etag(path: Path) -> str | None:
    """Strong validator for an art file: nanosecond mtime + size (so a
    same-second rewrite still changes it). None if the file can't be stat'd."""
    try:
        st = path.stat()
        return f'"{st.st_mtime_ns}-{st.st_size}"'
    except OSError:
        return None


def _art_conditional(etag: str | None, request: Request | None):
    """Return (headers, not_modified) for an art response. `not_modified` is
    True when the client's If-None-Match already matches `etag` → caller should
    return a bodyless 304. Starlette's FileResponse emits an ETag but does NOT
    itself evaluate If-None-Match, so every art path routes through here to get
    real conditional handling."""
    headers = dict(_ART_CACHE_HEADERS)
    if etag:
        headers["ETag"] = etag
    inm = request.headers.get("if-none-match") if request is not None else None
    return headers, bool(etag) and _if_none_match_hits(inm, etag)


def _file_art_response(path: Path, media_type: str, request: Request | None):
    """FileResponse for an on-disk art file, with no-cache + ETag and a bodyless
    304 when the client's validator still matches."""
    headers, not_modified = _art_conditional(_art_etag(path), request)
    if not_modified:
        return Response(status_code=304, headers=headers)
    return FileResponse(str(path), media_type=media_type, headers=headers)


@app.get("/api/song/{filename:path}/art")
async def get_song_art(filename: str, request: Request = None, source: str = ""):
    """Serve album art for a song, walking the R3 override chain:

      1. USER OVERRIDE (upload / URL-fetch, {safe_name}.gif|.png in the art
         cache) — art the user explicitly pinned outranks everything, pack
         art included. GIF is allowed HERE only: an animated cover is a
         local-only bonus; packs stay jpg/png/webp and nothing ever writes
         art into a pack file.
      2. PACK ART — sloppak cover (single member read, no full unpack) or
         the loose folder's discovered image.
      3. COVER ART ARCHIVE cache — fetched by the enrichment art worker for
         matched songs that lack pack art, keyed by release MBID.

    `?source=pack` narrows the chain to step 2 only (no override, no CAA):
    the cover picker's "Pack original" tile must show the pack's own art
    even while a user override is what the plain route serves. 404 when the
    song ships no art of its own.
    """
    dlc = _get_dlc_dir()
    if not dlc:
        return JSONResponse({"error": "not configured"}, 404)

    song_path = _resolve_dlc_path(dlc, filename)
    if song_path is None:
        return JSONResponse({"error": "forbidden"}, 403)
    if not song_path.exists():
        return JSONResponse({"error": "not found"}, 404)

    pack_only = source == "pack"

    # 1. User override — GIF first (it wins over a stale PNG override).
    if not pack_only:
        for cached in _art_override_paths(filename):
            mt = "image/gif" if cached.suffix == ".gif" else "image/png"
            return _file_art_response(cached, mt, request)

    # 2a. Sloppak: read the cover (manifest-declared or default) straight from
    # the package. For a zip-form sloppak this opens just the cover member —
    # NOT the whole archive — so the library grid never triggers a full unpack
    # of stems just to paint a thumbnail.
    if sloppak_mod.is_sloppak(song_path):
        # Read the cover (cheap — single member, no full unpack) and validate by
        # its CONTENT. A stat-based ETag would be wrong for directory-form
        # sloppaks: editing cover.jpg in place changes the file's mtime, not the
        # directory's, so a dir-stat ETag could emit a stale 304. Content hashing
        # is correct for both dir- and zip-form. Raw byte Response lacks
        # FileResponse's validators, so we attach the ETag + honor If-None-Match.
        try:
            art = await asyncio.to_thread(sloppak_mod.read_cover_bytes, song_path)
        except Exception:
            art = None
        if art is not None:
            data, mt = art
            etag = f'"{hashlib.sha1(data).hexdigest()}"'
            headers, not_modified = _art_conditional(etag, request)
            if not_modified:
                return Response(status_code=304, headers=headers)
            return Response(content=data, media_type=mt, headers=headers)

    # 2b. Loose folder: serve the discovered art file directly.
    # song_path is already validated against DLC_DIR by _resolve_dlc_path.
    elif loosefolder_mod.is_loose_song(song_path):
        art_path = loosefolder_mod.find_art(song_path)
        if art_path:
            # Re-resolve in case the matched file is a symlink — a crafted
            # custom song could put `album_art.jpg` as a symlink to anywhere on
            # disk. Insist the final target stays inside the song folder.
            art_resolved = art_path.resolve()
            try:
                art_resolved.relative_to(song_path)
            except ValueError:
                return JSONResponse({"error": "forbidden"}, 403)
            if art_resolved.is_file():
                mt = {
                    ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
                    ".png": "image/png", ".webp": "image/webp",
                }.get(art_resolved.suffix.lower(), "image/jpeg")
                return _file_art_response(art_resolved, mt, request)

    # 3. Cover Art Archive cache (the enrichment art worker's fetch).
    if not pack_only:
        row = meta_db.get_enrichment(filename)
        if row and row.get("art_state") == "caa" and row.get("art_cache_path"):
            caa = Path(row["art_cache_path"])
            if caa.is_file():
                return _file_art_response(caa, "image/jpeg", request)

    return JSONResponse({"error": "no art"}, 404)


# ── Cover picker (PR-C): candidate assembly ───────────────────────────────────
# Enumerated ON OPEN, never at scan time (charrette §8), and NO image bytes
# are fetched here — Cover Art Archive release INDEX jsons only (1-3 throttled
# calls on a cache miss); the tiles' thumbnails load straight from the archive
# in the client. Applying a pick never grows a new write path: the client
# POSTs the chosen thumb URL to the EXISTING …/art/url route (the override
# lane — never evicted, survives a re-match), "Pack original" DELETEs the
# override, uploads keep the existing upload route.
_ART_PICKER_MAX_CAA = 12


@app.get("/api/song/{filename:path}/art/cover-search")
def api_art_cover_search(filename: str, q: str = ""):
    """Search Cover Art Archive (via MusicBrainz release-groups) for album covers
    — powers the Change-cover picker's search box, so a cover can be found even
    for a song with no metadata match (the unmatched city-pop pile, where
    /art/candidates is empty). `q` defaults to the song's own artist + album/
    title (romaji fallback applied). Read-only; the picker renders the thumbs and
    applies a pick through the existing /art/url route."""
    query = (q or "").strip()
    if not query:
        pack = meta_db.pack_fields(meta_db._canonical_song_filename(filename))
        query = " ".join(x for x in (pack.get("artist"), pack.get("album") or pack.get("title")) if x).strip()
    if not query:
        return {"query": "", "covers": []}
    try:
        return {"query": query, "covers": _mb_search_release_groups(query, limit=8)}
    except EnrichTransportError:
        return {"query": query, "covers": [], "error": "unavailable"}


@app.get("/api/song/{filename:path}/art/candidates")
def get_song_art_candidates(filename: str):
    """Everything the cover picker can offer for one song, without fetching a
    single image: the current cover (with its provenance), the pack original
    when the song ships art, and CAA candidates for the matched/manual
    release plus any distinct releases among the stored review candidates.
    Sync route on purpose (the CAA index fetch sleeps in the shared
    throttle — FastAPI runs `def` routes in the threadpool). One response,
    `pending` always False — the client shows a spinner for the request's own
    latency; offline / CAA-down just means an empty caa tail (the instant
    tiles keep working), never an error."""
    from urllib.parse import quote
    dlc = _get_dlc_dir()
    song_path = _resolve_dlc_path(dlc, filename) if dlc else None
    if song_path is None or not song_path.exists():
        raise HTTPException(status_code=404, detail="unknown song")

    row = meta_db.get_enrichment(filename) or {}
    has_pack = _song_pack_art_exists(filename)
    art_url = f"/api/song/{quote(filename)}/art"

    # What the plain art route would serve right now — the serve chain's
    # order (override > pack > CAA cache) restated as provenance.
    if _art_override_paths(filename):
        provenance = "yours"
    elif has_pack:
        provenance = "pack"
    elif row.get("art_state") == "caa" and row.get("art_cache_path"):
        provenance = "matched"
    else:
        provenance = "none"

    candidates: list[dict] = [{
        "id": "current", "kind": "current", "label": "Current",
        "thumb_url": art_url, "provenance": provenance,
    }]
    if has_pack:
        candidates.append({
            "id": "pack", "kind": "pack", "label": "Pack original",
            "thumb_url": art_url + "?source=pack", "provenance": "pack",
        })

    # Releases worth asking the archive about: the matched/manual release
    # first (it seeds the best candidates), then any distinct release among
    # the stored review candidates (a review row has no mb_release_id of its
    # own — its releases live in the candidates JSON).
    # Only spend the shared CAA rate budget on rows whose match warrants it:
    # a matched/manual release seeds the best candidates, and a review row's
    # stored candidates are still live proposals. A failed/rejected (or
    # unscanned) row has no accepted match — asking would burn the budget and
    # surface releases already rejected as non-matches. The Current + Pack
    # tiles above serve regardless, so those songs still get a picker.
    rids: list[str] = []
    if row.get("match_state") in ("matched", "manual", "review"):
        if row.get("match_state") in ("matched", "manual") and row.get("mb_release_id"):
            rids.append(str(row["mb_release_id"]))
        for cand in (row.get("candidates") or []):
            rid = str(cand.get("release_id") or "") if isinstance(cand, dict) else ""
            if rid and rid not in rids:
                rids.append(rid)

    caa_entries: list[dict] = []
    for rid in rids:
        if len(caa_entries) >= _ART_PICKER_MAX_CAA:
            break
        try:
            imgs = _caa_index_cached(rid)
        except EnrichTransportError:
            # Offline / archive down — stop asking (each further miss would
            # only burn a timeout). The instant tiles still serve; a later
            # picker-open retries naturally (failures are never cached).
            break
        # Front covers first, approved before pending, otherwise index order
        # (the picker grammar is a RANKED list — §7/§9).
        def _rank(img):
            types = img.get("types") or []
            is_front = bool(img.get("front")) or "Front" in types
            return (not is_front, not bool(img.get("approved")))
        for img in sorted((i for i in imgs if isinstance(i, dict)), key=_rank):
            if len(caa_entries) >= _ART_PICKER_MAX_CAA:
                break
            thumbs = img.get("thumbnails") or {}
            if not isinstance(thumbs, dict):
                continue
            thumb = (thumbs.get("500") or thumbs.get("large")
                     or thumbs.get("250") or thumbs.get("small"))
            if not thumb:
                continue
            types = [str(t) for t in (img.get("types") or []) if isinstance(t, str)]
            caa_entries.append({
                "id": f"caa-{rid}-{img.get('id', '')}",
                "kind": "caa",
                "label": ", ".join(types) or "Cover",
                "thumb_url": str(thumb),
                "provenance": "matched",
                "types": types,
                "approved": bool(img.get("approved")),
                "release_id": rid,
            })

    return {"candidates": candidates + caa_entries, "pending": False}


@app.post("/api/song/{filename:path}/meta")
def update_song_meta(filename: str, data: dict):
    """Update song metadata, persisting it back into the underlying file.

    The library scanner re-derives title/artist/album/year from the file
    (archive manifest Attributes / sloppak manifest.yaml) on every full rescan,
    so a DB-only edit reverts. We write the edit into the file first, then
    refresh the cache row (including mtime/size) to match. Loose-folder and
    unwritable songs fall back to a DB-only update (which still survives an
    incremental rescan via the mtime/size cache hit).
    """
    # Canonicalise to the same key get_song_info uses so an update via
    # one URL form (e.g. with `..` segments) lands on the row that
    # later reads will see.
    dlc = _get_dlc_dir()
    cache_key = filename
    resolved = None
    if dlc:
        resolved = _resolve_dlc_path(dlc, filename)
        if resolved is None:
            return JSONResponse({"error": "forbidden"}, 403)
        try:
            cache_key = resolved.relative_to(dlc.resolve()).as_posix()
        except ValueError:
            pass

    fields = {k: data[k] for k in ("title", "artist", "album", "year") if k in data}
    if not fields:
        return {"error": "No fields to update"}
    # Normalise the year value so the DB and file stay in sync.  The file
    # writer (songmeta) coerces empty/non-numeric years to 0, which the
    # scanner reads back as "".  Store "" in the DB instead of a raw
    # non-numeric string so that if the mtime/size are updated (making the
    # row cache-fresh) the DB still matches what the scanner would derive.
    if "year" in fields:
        try:
            _yr_int = int(fields["year"])
        except (TypeError, ValueError):
            _yr_int = 0
        fields = {**fields, "year": str(_yr_int) if _yr_int else ""}

    # Persist into the file so the edit survives a full rescan.
    # Hold _song_io_lock across the existence check and file write so a
    # concurrent delete cannot remove the file between our check and the
    # repack's atomic replace, and so a concurrent upload cannot be clobbered
    # by our atomic rename. archive repack is slow — the lock is held longer
    # than a simple upload/delete, but correctness requires serialisation.
    persisted = False
    with _song_io_lock:
        if resolved is not None and resolved.exists():
            try:
                import songmeta
                persisted = songmeta.write_song_metadata(resolved, fields)
            except Exception:
                log.warning("metadata file write failed for %s", cache_key, exc_info=True)

        with meta_db._lock:
            updates = [f"{field} = ?" for field in fields]
            params = list(fields.values())
            if persisted:
                # The file changed — re-stat so an incremental rescan sees a
                # consistent cache row instead of re-reading the (now matching)
                # file.
                try:
                    mtime, size = _stat_for_cache(resolved)
                    updates += ["mtime = ?", "size = ?"]
                    params += [mtime, size]
                except OSError:
                    pass
            params.append(cache_key)
            meta_db.conn.execute(
                f"UPDATE songs SET {', '.join(updates)} WHERE filename = ?", params
            )
            meta_db.conn.commit()

    if persisted:
        _invalidate_song_caches(cache_key)
        # Coalesce a follow-up scan so a mid-flight scan's stale meta_db.put()
        # for this file can't win: if a scan is running _kick_scan() queues a
        # pending pass; if not it starts a fresh one. Unconditional to avoid a
        # race where the scan finishes between our DB commit and a guarded check.
        _kick_scan()
    return {"ok": True, "persisted": persisted}


# ── Gap-fill: write CONFIRMED missing metadata into the pack (R4a) ────────────
# The agreed write-back contract (spec-alignment §7): opt-in + user-initiated
# (nothing here runs in the background), adds ABSENT keys only (never replaces
# an author-set value — the writer refuses, and existing manifest bytes are
# preserved verbatim by appending), spec'd-keys allowlist, values only from a
# CONFIRMED identity (an auto/exact match or a user pin — review-tier rows are
# not eligible until a human confirms), atomic write + .bak. Single-song only;
# batch write-back stays an open question with the spec chair.
_GAP_FILL_KEYS = ("album", "year", "genres", "mbid", "isrc")


def _gap_fill_manifest_absent(manifest: dict, key: str) -> bool:
    """A key is a GAP only when it's genuinely MISSING from the manifest.

    Gap-fill is append-only: the writer's never-clobber guard raises on ANY
    key already present, and appending a second `album:` line to a manifest
    that already carries `album: ''` would just create a duplicate YAML key.
    So a present-but-empty value (None / '' / [] / year 0) is NOT a gap the
    append-only writer can fill — offering it in the preview would only lead
    to a POST the writer refuses. Present-but-empty keys are therefore left
    to the metadata editor (which re-serializes and can replace in place)."""
    return key not in manifest


def _gap_fill_proposals(cache_key: str, resolved) -> tuple[dict, str]:
    """What gap-fill could add for this song: (proposals, reason). Empty
    proposals explain themselves via reason — 'not-sloppak', 'no-match'
    (nothing confirmed yet), 'review' (a human hasn't confirmed the match),
    or 'nothing-missing'."""
    if resolved is None or not resolved.exists() or not sloppak_mod.is_sloppak(resolved):
        return {}, "not-sloppak"
    row = meta_db.get_enrichment(cache_key)
    if not row or row.get("match_state") not in ("matched", "manual"):
        state = (row or {}).get("match_state")
        return {}, ("review" if state == "review" else "no-match")
    try:
        manifest = sloppak_mod.load_manifest(resolved) or {}
    except Exception:
        return {}, "not-sloppak"
    # A LOCKED field (Fix-metadata popup) is never gap-filled — the user pinned
    # it away from the matched value, so writing that value to the file would
    # be exactly the clobber the lock exists to prevent. (The lock field name is
    # `genre`; the manifest/gap-fill key is `genres`.)
    locked = meta_db.locked_fields(cache_key)
    out = {}
    album = (row.get("canon_album") or "").strip()
    if album and "album" not in locked and _gap_fill_manifest_absent(manifest, "album"):
        out["album"] = album
    year = (row.get("canon_year") or "").strip()
    if (year.isdigit() and int(year) and "year" not in locked
            and _gap_fill_manifest_absent(manifest, "year")):
        out["year"] = int(year)
    genres = [str(g) for g in (row.get("genres") or []) if isinstance(g, str) and g.strip()]
    if genres and "genre" not in locked and _gap_fill_manifest_absent(manifest, "genres"):
        out["genres"] = genres
    # Identity keys (feedpak spec 1.14.0) — written in canonical form only.
    mbid = (row.get("mb_recording_id") or "").strip().lower()
    if _MBID_RE.match(mbid) and _gap_fill_manifest_absent(manifest, "mbid"):
        out["mbid"] = mbid
    isrc = (row.get("isrc") or "").strip().upper().replace("-", "").replace(" ", "")
    if _ISRC_RE.match(isrc) and _gap_fill_manifest_absent(manifest, "isrc"):
        out["isrc"] = isrc
    return out, ("" if out else "nothing-missing")


@app.get("/api/song/{filename:path}/gap-fill")
def get_song_gap_fill(filename: str):
    """Preview what "Write missing info to file" would add — the Details
    drawer renders its confirm list straight from this. Read-only."""
    dlc = _get_dlc_dir()
    cache_key, resolved = filename, None
    if dlc:
        resolved = _resolve_dlc_path(dlc, filename)
        if resolved is None:
            return JSONResponse({"error": "forbidden"}, 403)
        try:
            cache_key = resolved.relative_to(dlc.resolve()).as_posix()
        except ValueError:
            pass
    proposals, reason = _gap_fill_proposals(cache_key, resolved)
    row = meta_db.get_enrichment(cache_key) or {}
    return {
        "eligible": bool(proposals),
        "reason": reason,
        "match_state": row.get("match_state"),
        "missing": [{"key": k, "value": v} for k, v in proposals.items()],
    }


@app.post("/api/song/{filename:path}/gap-fill")
def post_song_gap_fill(filename: str, data: dict):
    """Write the user-confirmed subset of the preview into the pack file.
    Proposals are recomputed under the io lock, so a key that gained an
    author value between preview and confirm is skipped, never replaced."""
    keys = (data or {}).get("keys")
    if not isinstance(keys, list) or not keys:
        return JSONResponse({"error": "keys must be a non-empty list"}, 400)
    bad = [k for k in keys if k not in _GAP_FILL_KEYS]
    if bad:
        return JSONResponse(
            {"error": "unknown key(s): " + ", ".join(sorted(set(map(str, bad))))}, 400)

    dlc = _get_dlc_dir()
    cache_key, resolved = filename, None
    if dlc:
        resolved = _resolve_dlc_path(dlc, filename)
        if resolved is None:
            return JSONResponse({"error": "forbidden"}, 403)
        try:
            cache_key = resolved.relative_to(dlc.resolve()).as_posix()
        except ValueError:
            pass

    with _song_io_lock:
        proposals, reason = _gap_fill_proposals(cache_key, resolved)
        additions = {k: proposals[k] for k in _GAP_FILL_KEYS if k in keys and k in proposals}
        skipped = sorted(set(keys) - set(additions))
        if not additions:
            return JSONResponse({"error": "nothing to write", "reason": reason,
                                 "skipped": skipped}, 409)
        try:
            import songmeta
            songmeta.gap_fill_sloppak(resolved, additions)
        except Exception:
            log.warning("gap-fill write failed for %s", cache_key, exc_info=True)
            return JSONResponse({"error": "write failed"}, 500)

        # Keep the cache row consistent with what the scanner would now derive
        # (same contract as the metadata editor above): sync the columns the
        # scan reads from the keys we appended, then re-stat so the row stays
        # cache-fresh.
        fields = {}
        if "album" in additions:
            fields["album"] = additions["album"]
        if "year" in additions:
            fields["year"] = str(additions["year"])
        if "genres" in additions:
            fields["genre"] = additions["genres"][0]
        with meta_db._lock:
            updates = [f"{field} = ?" for field in fields]
            params = list(fields.values())
            try:
                mtime, size = _stat_for_cache(resolved)
                updates += ["mtime = ?", "size = ?"]
                params += [mtime, size]
            except OSError:
                pass
            if updates:
                params.append(cache_key)
                meta_db.conn.execute(
                    f"UPDATE songs SET {', '.join(updates)} WHERE filename = ?", params)
                meta_db.conn.commit()

    _invalidate_song_caches(cache_key)
    _kick_scan()
    return {"ok": True, "written": additions, "skipped": skipped}


def _save_art_override(filename: str, img_data: bytes) -> dict:
    """Persist a user art override into the art cache (R3). One override per
    song: GIF input is validated and kept VERBATIM as .gif (animation intact —
    the local-only bonus; it is never written into the pack file), everything
    else is normalized to RGB PNG via PIL. Saving either kind removes the
    other so the serve chain has exactly one user file to find."""
    ART_CACHE_DIR.mkdir(parents=True, exist_ok=True)
    stem = _art_safe_name(filename)
    png_path = ART_CACHE_DIR / f"{stem}.png"
    gif_path = ART_CACHE_DIR / f"{stem}.gif"
    from PIL import Image
    import io as _io
    if img_data[:6] in (b"GIF87a", b"GIF89a"):
        try:
            probe = Image.open(_io.BytesIO(img_data))
            probe.verify()   # decodes headers/frames without keeping the image
            if probe.format != "GIF":
                raise ValueError("not a GIF")
        except Exception as e:
            return {"error": f"Invalid image: {e}"}
        gif_path.write_bytes(img_data)
        png_path.unlink(missing_ok=True)
        return {"ok": True, "kind": "gif"}
    try:
        img = Image.open(_io.BytesIO(img_data)).convert("RGB")
        img.save(str(png_path), "PNG")
    except Exception as e:
        return {"error": f"Invalid image: {e}"}
    gif_path.unlink(missing_ok=True)
    return {"ok": True, "kind": "png"}


@app.post("/api/song/{filename:path}/art/upload")
async def upload_song_art_b64(filename: str, data: dict):
    """Upload a custom cover as base64 (PNG/JPG/WebP → normalized PNG;
    GIF → kept animated, local-only). The override outranks pack art in the
    serve chain; remove it via DELETE …/art/override."""
    import base64
    # Reject art for a filename that doesn't resolve to a real song (mirrors the
    # url route's guard) — no writing stray override files for unknown keys.
    dlc = _get_dlc_dir()
    song_path = _resolve_dlc_path(dlc, filename) if dlc else None
    if song_path is None or not song_path.exists():
        raise HTTPException(status_code=404, detail="unknown song")
    b64 = data.get("image", "")
    if not b64:
        return {"error": "No image data"}
    # Strip data URL prefix if present
    if "," in b64:
        b64 = b64.split(",", 1)[1]
    try:
        img_data = base64.b64decode(b64)
    except Exception:
        return {"error": "Invalid base64"}
    if len(img_data) > _ART_URL_MAX_BYTES:
        raise HTTPException(status_code=400, detail="image larger than 10 MB")
    return _save_art_override(filename, img_data)


# Art-by-URL fetch cap — a cover, not a wallpaper pack.
_ART_URL_MAX_BYTES = 10 * 1024 * 1024


def _url_host_is_internal(url: str) -> bool:
    """True when a user-supplied URL's host resolves to a loopback, private,
    link-local, reserved, multicast or unspecified address — an SSRF target we
    refuse to fetch on the user's behalf (e.g. 169.254.169.254 metadata, LAN
    services). Fails CLOSED: an unresolvable or unparseable host is treated as
    internal. Every resolved address must be public for the URL to pass."""
    from urllib.parse import urlparse
    import socket
    host = urlparse(url).hostname
    if not host:
        return True
    try:
        infos = socket.getaddrinfo(host, None)
    except OSError:
        return True
    if not infos:
        return True
    for info in infos:
        raw = info[4][0].split("%", 1)[0]  # strip any zone id
        try:
            ip = ipaddress.ip_address(raw)
        except ValueError:
            return True
        if (ip.is_private or ip.is_loopback or ip.is_link_local
                or ip.is_reserved or ip.is_multicast or ip.is_unspecified):
            return True
    return False


# Art-by-URL redirect budget. Cover hosts commonly answer with a redirect —
# the Cover Art Archive (whose thumbs the cover picker applies through this
# very route) 307s every image to archive.org — so redirects must work; 5
# hops is generous for any real CDN chain while still bounding the walk.
_ART_URL_MAX_REDIRECTS = 5


def _fetch_art_url(url: str) -> bytes:
    """The one place art-by-URL touches the network (tests fake this seam).
    User-initiated, so not throttled like the background workers — but the
    same offline guard applies (pytest can never fetch), the host is checked
    against internal/reserved ranges (SSRF), redirects are followed MANUALLY
    with the scheme + internal-host guard re-applied to every hop (so a
    redirect can't smuggle the request to an internal target — a blanket
    no-redirect rule would break every Cover Art Archive pick, which always
    redirects to archive.org), and the size cap is enforced while streaming
    so a huge response never fully downloads.

    Residual, accepted: each hop's host is resolved here and again by
    requests, so a rebinding DNS name is a theoretical TOCTOU. Not closed
    with an IP-pinned connection because (a) this is a single-user, no-auth
    app (constitution §I) and the route is demo-blocked, so there is no
    untrusted submission path, and (b) no other in-tree client (MusicBrainz,
    CAA) pins either — a bespoke pinned+SNI adapter here would be
    inconsistent and disproportionate. The cheap guards above still stop the
    realistic vectors (direct internal URL, redirect-to-internal)."""
    if not _enrich_network_enabled():
        raise EnrichTransportError("art fetch disabled (offline)")
    import requests
    from urllib.parse import urljoin, urlparse
    for _hop in range(_ART_URL_MAX_REDIRECTS + 1):
        # Re-validate EVERY hop, not just the user's original URL: the whole
        # point of handling redirects ourselves is that each target gets the
        # same scheme + SSRF gate before any request is made.
        if urlparse(url).scheme not in ("http", "https"):
            raise ValueError("url must be http(s)")
        if _url_host_is_internal(url):
            raise ValueError("url host is not allowed")
        try:
            with requests.get(url, timeout=15, stream=True, allow_redirects=False,
                              headers={"User-Agent": _enrich_user_agent()}) as resp:
                if resp.status_code in (301, 302, 303, 307, 308):
                    loc = resp.headers.get("Location") or ""
                    if not loc:
                        raise EnrichTransportError(
                            f"HTTP {resp.status_code} without a Location")
                    url = urljoin(url, loc)
                    continue
                if resp.status_code != 200:
                    raise EnrichTransportError(f"HTTP {resp.status_code}")
                data = b""
                for chunk in resp.iter_content(65536):
                    data += chunk
                    if len(data) > _ART_URL_MAX_BYTES:
                        raise ValueError("image larger than 10 MB")
                return data
        except requests.RequestException as e:
            raise EnrichTransportError(str(e)) from e
    raise EnrichTransportError("too many redirects")


@app.post("/api/song/{filename:path}/art/url")
def set_song_art_from_url(filename: str, data: dict):
    """Paste-a-link cover art (the media-server idiom): the server fetches the
    image and stores it as this song's local override — identical result to an
    upload, including the GIF-stays-local rule. http(s) only."""
    url = str((data or {}).get("url") or "").strip()
    from urllib.parse import urlparse
    parsed = urlparse(url)
    if parsed.scheme not in ("http", "https") or not parsed.hostname:
        raise HTTPException(status_code=400, detail="url must be http(s)")
    dlc = _get_dlc_dir()
    song_path = _resolve_dlc_path(dlc, filename) if dlc else None
    if song_path is None or not song_path.exists():
        raise HTTPException(status_code=404, detail="unknown song")
    try:
        img_data = _fetch_art_url(url)
    except EnrichTransportError as e:
        return JSONResponse({"error": "could not fetch image", "detail": str(e)},
                            status_code=502)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    return _save_art_override(filename, img_data)


@app.delete("/api/art/{filename:path}/override")
def remove_song_art_override(filename: str):
    """Drop the user art override — the serve chain falls back to pack art,
    then the Cover Art Archive cache. Lives under /api/art (NOT /api/song) so
    the greedy DELETE /api/song/{path} catch-all can't shadow it — the same
    dodge the chart split/unsplit routes use."""
    removed = False
    for p in _art_override_paths(filename):
        try:
            p.unlink()
            removed = True
        except OSError:
            pass
    if removed:
        # The art worker may have settled this row as 'user' (override present,
        # no pack art). Reset it so the next enrichment pass re-evaluates and the
        # CAA fallback resumes — otherwise a removed override strands the row
        # (enrichment_art_pending only re-queues art_state IS NULL) and the song
        # is left with no art at all.
        try:
            meta_db.set_enrichment_art(filename, None, None)
        except Exception:
            log.exception("art override delete: failed to reset enrichment state")
    return {"ok": True, "removed": removed}


@app.get("/api/song/{filename:path}")
async def get_song_info(filename: str):
    """Return song metadata, from cache or by extracting it from the song source."""
    import asyncio
    dlc = _get_dlc_dir()
    if not dlc:
        return JSONResponse({"error": "DLC folder not configured"}, 404)

    song_path = _resolve_dlc_path(dlc, filename)
    if song_path is None:
        return JSONResponse({"error": "forbidden"}, 403)
    if not song_path.exists():
        return JSONResponse({"error": "File not found"}, 404)

    # Canonicalise the cache key against the resolved path so two URL
    # forms of the same physical file (e.g. `Artist/song.sloppak` vs
    # `Artist/../Artist/song.sloppak`) converge on a single row instead
    # of fragmenting / shadowing each other in meta_db.
    try:
        cache_key = song_path.relative_to(dlc.resolve()).as_posix()
    except ValueError:
        cache_key = filename

    mtime, size = _stat_for_cache(song_path)
    cached = meta_db.get(cache_key, mtime, size)
    if cached:
        return cached

    # Extract in thread pool
    def _extract():
        meta = _extract_meta_for_file(song_path, dlc)
        meta_db.put(cache_key, mtime, size, meta)
        return meta

    meta = await asyncio.get_event_loop().run_in_executor(None, _extract)
    return meta


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


@app.websocket("/ws/highway/{filename:path}")
async def highway_ws(websocket: WebSocket, filename: str, arrangement: int = -1, naming_mode: str = "legacy"):
    """Stream song data for the highway renderer over WebSocket."""
    await websocket.accept()
    structlog.contextvars.bind_contextvars(ws_conn_id=uuid.uuid4().hex[:8])

    dlc = _get_dlc_dir()
    if not dlc:
        await websocket.send_json({"error": "DLC folder not configured"})
        await websocket.close()
        return

    song_path = _resolve_dlc_path(dlc, filename)
    if song_path is None:
        await websocket.send_json({"error": "forbidden"})
        await websocket.close()
        return
    if not song_path.exists():
        await websocket.send_json({"error": "File not found"})
        await websocket.close()
        return

    is_slop = sloppak_mod.is_sloppak(song_path)
    # Sloppak wins precedence: `_extract_meta_for_file()` and the
    # background scanner both treat a `.sloppak` directory as sloppak
    # even if it happens to contain WEM/XML. Gate is_loose on that
    # so the loose-only branches (audio_id, offset, audio conversion)
    # don't fire for sloppak bundles.
    is_loose = (not is_slop) and loosefolder_mod.is_loose_song(song_path)
    tmp = None
    owns_tmp = False
    loaded_slop = None  # LoadedSloppak when is_slop
    _keepalive_active = True

    async def _send_keepalives():
        while _keepalive_active:
            try:
                await asyncio.sleep(3)
                if _keepalive_active:
                    await websocket.send_json({"type": "loading", "stage": "Loading..."})
            except Exception:
                break

    try:
        await websocket.send_json({"type": "loading", "stage": "Extracting..."})
        keepalive_task = asyncio.create_task(_send_keepalives())

        try:
            loop = asyncio.get_running_loop()
            _ctx = contextvars.copy_context()
            if is_slop:
                SLOPPAK_CACHE_DIR.mkdir(parents=True, exist_ok=True)
                loaded_slop = await loop.run_in_executor(
                    None,
                    lambda: _ctx.run(sloppak_mod.load_song, filename, dlc, SLOPPAK_CACHE_DIR),
                )
                song = loaded_slop.song
                tmp = str(loaded_slop.source_dir)
                owns_tmp = False
            elif is_loose:
                # Loose folders need no extraction — load_song reads the
                # arrangement XMLs directly from the flat directory.
                # song_path is already DLC-containment-validated by
                # _resolve_dlc_path, so audio conversion below can use
                # it directly.
                song = await loop.run_in_executor(None, lambda: load_song(str(song_path)))
                tmp = str(song_path)
                owns_tmp = False
            else:
                # Only open formats (.sloppak bundles and loose folders) are
                # servable. There is no fallback container extraction path.
                raise ValueError("Unsupported song format")
        finally:
            _keepalive_active = False
            keepalive_task.cancel()

        if not song.arrangements:
            await websocket.send_json({"error": "No arrangements found"})
            await websocket.close()
            return

        # Smart names are needed for smart-mode arrangement selection.
        smart_names = compute_smart_names(song.arrangements)

        # Pick arrangement: explicit request > user preference > most notes
        best = -1
        if 0 <= arrangement < len(song.arrangements):
            best = arrangement
        else:
            # Read the user's config once: their selected instrument (route the chart
            # to the matching part) and their default-arrangement preference.
            pref = ""
            sel_instrument = ""
            config_file = CONFIG_DIR / "config.json"
            if config_file.exists():
                try:
                    _cfg = json.loads(config_file.read_text(encoding="utf-8"))
                    pref = _cfg.get("default_arrangement", "")
                    sel_instrument = (_cfg.get("instrument", "") or "")
                except Exception:
                    pass
            # Instrument routing: load the part that matches the selected instrument so
            # "your instrument" and "the chart you play" line up. The default ordering
            # is Lead/guitar-first, so without this a bass player gets handed a guitar
            # chart (and any tune-check then compares a 4-string bass against a 6-string
            # part). Currently routes bass -> a Bass arrangement; guitar — and any
            # unknown/future instrument (drums, keys) — falls through to the
            # preference/most-notes logic below, which already lands on a guitar part.
            # Drums/keys get their own match when those arrangement types + selector
            # entries land. Only applies when no explicit arrangement was requested, so
            # a manual arrangement switch is always respected.
            if sel_instrument.lower() == "bass":
                # Candidate bass parts, preferring the structured pathBass flag; the
                # normalized smart name (itself pathBass-derived) and raw name are
                # fallbacks for sources without the flag.
                bass_idxs = [
                    i
                    for i, a in enumerate(song.arrangements)
                    if getattr(a, "path_bass", False)
                    or (smart_names[i] or "").lower().startswith("bass")
                    or "bass" in (getattr(a, "name", "") or "").lower()
                ]
                if bass_idxs:
                    # Among the bass parts: (1) honor the saved default-arrangement
                    # preference if it names one of them (so a bass player who prefers
                    # "Bass 2"/"Alt. Bass" keeps it), (2) else the canonical main "Bass",
                    # (3) else the first bass part in order.
                    pref_bass = -1
                    if pref:
                        for i in bass_idxs:
                            nm = (smart_names[i] if naming_mode == "smart" and i < len(smart_names)
                                  else getattr(song.arrangements[i], "name", ""))
                            if nm == pref:
                                pref_bass = i
                                break
                    if pref_bass >= 0:
                        best = pref_bass
                    else:
                        best = next(
                            (i for i in bass_idxs
                             if (smart_names[i] if i < len(smart_names) else "") == "Bass"),
                            bass_idxs[0],
                        )
            # User's default arrangement preference (only when instrument routing did not
            # already resolve a part — i.e. guitar, or a bass player with no bass part).
            if best < 0 and pref:
                if naming_mode == "smart":
                    best = _pick_smart_arrangement(song.arrangements, smart_names, pref)
                else:
                    for i, a in enumerate(song.arrangements):
                        if a.name == pref:
                            best = i
                            break
        if best < 0:
            # Fallback: most notes
            best = 0
            best_count = 0
            for i, a in enumerate(song.arrangements):
                c = len(a.notes) + sum(len(ch.notes) for ch in a.chords)
                if c > best_count:
                    best_count = c
                    best = i
        arr = song.arrangements[best]

        # Resolve the manifest arrangement id for notation lookup (Option B loader).
        # Use the parallel arrangement_ids list (indexed by compacted position,
        # i.e. song.arrangements index) so skipped manifest entries can't shift
        # the index and serve the wrong arrangement's notation.
        _notation_arr_id: str | None = None
        if is_slop and loaded_slop is not None:
            _ids = loaded_slop.arrangement_ids
            if best < len(_ids):
                _notation_arr_id = _ids[best]

        # Convert audio with unique filename (check cache first)
        audio_url = None
        audio_error: str | None = None  # Surfaced in song_info when audio_url is None
        stems_payload: list[dict] = []
        # URL of the single full-mix audio (sloppak `original_audio:`), when the
        # pack ships one. The stems plugin uses this to play the untouched mix
        # while every stem slider is at unity; None otherwise (separate stems
        # only, loose folder, or archive).
        original_audio_url: str | None = None
        if is_loose:
            # Loose folder filenames are relative paths (artist/album/song).
            # Hash the *canonical* dlc-relative path (so two URL spellings
            # of the same physical folder share a cache key) PLUS the
            # source WEM's mtime+size so:
            #  - different songs with the same leaf folder name can't
            #    collide (a `/`→`__` escape would collapse `a/b__c` and
            #    `a__b/c`);
            #  - editing audio.wem in place invalidates the cached
            #    converted file (without this, in-place custom song iteration
            #    keeps serving the stale mp3/ogg from the cache).
            try:
                canonical = song_path.relative_to(dlc.resolve()).as_posix()
            except ValueError:
                canonical = filename
            wem_for_id = loosefolder_mod.find_audio(song_path)
            try:
                wem_stat = wem_for_id.stat() if wem_for_id else None
            except OSError:
                wem_stat = None
            stamp = f"{wem_stat.st_mtime_ns}-{wem_stat.st_size}" if wem_stat else ""
            digest = hashlib.sha256(
                (canonical + "|" + stamp).encode("utf-8")
            ).hexdigest()[:12]
            leaf = Path(canonical.rstrip("/\\")).stem.replace(" ", "_")[:40] or "song"
            audio_id = f"{leaf}_{digest}"
        else:
            audio_id = Path(filename).stem.replace(" ", "_")

        if is_slop:
            # Stems are served via the sloppak file endpoint; the first stem
            # (or explicit default) is the core <audio> source. The stems
            # plugin replaces it with a mixed graph when active.
            from urllib.parse import quote
            q_fn = quote(filename, safe="")
            for s in loaded_slop.stems:
                url = f"/api/sloppak/{q_fn}/file/{quote(s['file'])}"
                stems_payload.append({"id": s["id"], "url": url, "default": s["default"]})
            # Full-mix URL (served by the same /api/sloppak/.../file/ endpoint).
            if loaded_slop is not None and loaded_slop.original_audio:
                original_audio_url = (
                    f"/api/sloppak/{q_fn}/file/{quote(loaded_slop.original_audio)}"
                )
            if stems_payload:
                # Stems present: keep the core <audio> pointed at stem[0]. This
                # URL is only ever heard in the degraded path (stems plugin
                # refuses takeover / decode fails); the full-mix↔stems switch is
                # driven client-side by `original_audio_url`, not `audio_url`.
                audio_url = stems_payload[0]["url"]
            elif original_audio_url:
                # Stem-less full-mix pack: nothing to separate, so play the full
                # mix natively through the core <audio>. The stems plugin's
                # onSongReady returns early on an empty stems list (no graph).
                audio_url = original_audio_url
            else:
                audio_error = "This sloppak has no playable stems."
        else:
            AUDIO_CACHE_DIR.mkdir(parents=True, exist_ok=True)
            # Check if audio already cached (writable cache dir or legacy static dir)
            for ext in [".mp3", ".ogg", ".wav"]:
                for cache_dir in [AUDIO_CACHE_DIR, STATIC_DIR]:
                    cached_audio = cache_dir / f"audio_{audio_id}{ext}"
                    if cached_audio.exists() and cached_audio.stat().st_size > 1000:
                        audio_url = f"/audio/audio_{audio_id}{ext}"
                        break
                if audio_url:
                    break

        def _evict_audio_cache():
            # Keep AUDIO_CACHE_DIR bounded so a library full of loose
            # folders / many archives doesn't fill disk. LRU on st_atime
            # so songs the user keeps replaying stay warm. Best-effort:
            # log at debug so permission / disk errors are diagnosable
            # without aborting the request.
            try:
                audio_files = [f for f in AUDIO_CACHE_DIR.iterdir()
                               if f.name.startswith("audio_") and f.suffix in (".mp3", ".ogg", ".wav")]
                if len(audio_files) > 100:
                    audio_files.sort(key=lambda f: f.stat().st_atime)
                    for f in audio_files[:len(audio_files) - 100]:
                        f.unlink(missing_ok=True)
            except Exception:
                log.debug("audio cache eviction failed for %s", AUDIO_CACHE_DIR, exc_info=True)

        if not audio_url and is_loose:
            await websocket.send_json({"type": "loading", "stage": "Converting audio..."})
            wem_path = loosefolder_mod.find_audio(song_path)
            if wem_path:
                # Re-resolve to defeat a symlinked audio.wem that points
                # outside the song folder — without this, a crafted
                # custom song could turn convert_wem into an arbitrary-file
                # decode/read primitive.
                wem_resolved = wem_path.resolve()
                try:
                    wem_resolved.relative_to(song_path)
                except ValueError:
                    audio_error = "Audio file escapes the loose folder."
                    wem_resolved = None
                if wem_resolved is not None:
                    # Convert into a unique temp basename and then
                    # atomically rename onto the final cache name.
                    # Two clients requesting the same song concurrently
                    # would otherwise race writing the same file and
                    # one could serve a partial mp3/wav.
                    tmp_suffix = uuid.uuid4().hex[:8]
                    tmp_base = AUDIO_CACHE_DIR / f"audio_{audio_id}.{tmp_suffix}"
                    try:
                        produced = convert_wem(str(wem_resolved), str(tmp_base))
                        ext = Path(produced).suffix
                        final_path = AUDIO_CACHE_DIR / f"audio_{audio_id}{ext}"
                        os.replace(produced, final_path)
                        audio_url = f"/audio/audio_{audio_id}{ext}"
                    except Exception as e:
                        log.exception("loose-folder audio conversion failed for %s", audio_id)
                        audio_error = f"Audio conversion failed: {e}"
                        # Best-effort cleanup of partial temp artifacts.
                        for stale in AUDIO_CACHE_DIR.glob(f"audio_{audio_id}.{tmp_suffix}.*"):
                            stale.unlink(missing_ok=True)
            else:
                audio_error = "No audio file found in loose folder."
            _evict_audio_cache()

        if not audio_url and not is_slop and not is_loose:
            await websocket.send_json({"type": "loading", "stage": "Converting audio..."})
            wem_files = find_wem_files(tmp)
            if not wem_files:
                audio_error = "No WEM audio files were found inside this archive."
            else:
                try:
                    audio_path = convert_wem(wem_files[0], os.path.join(tmp, "audio"))
                    ext = Path(audio_path).suffix
                    audio_dest = AUDIO_CACHE_DIR / f"audio_{audio_id}{ext}"
                    shutil.copy2(audio_path, audio_dest)
                    audio_url = f"/audio/audio_{audio_id}{ext}"
                except Exception as e:
                    log.exception("audio conversion failed for %s", audio_id)
                    audio_error = f"Audio conversion failed: {e}"

            _evict_audio_cache()

        # Send song metadata
        arr_list = [
            {
                "index": i,
                "name": a.name,
                "smart_name": smart_names[i],
                "notes": len(a.notes) + sum(len(c.notes) for c in a.chords),
            }
            for i, a in enumerate(song.arrangements)
        ]
        arr_list.sort(key=_arr_smart_sort_key)
        await websocket.send_json({
            "type": "song_info",
            "title": song.title,
            "artist": song.artist,
            "duration": song.song_length,
            "arrangement": arr.name,
            "arrangement_smart_name": smart_names[best],
            "arrangement_index": best,
            # Echo the resolved naming mode so highway.js doesn't have to
            # re-read localStorage (which can be unavailable / disagree with
            # app.js's in-memory cache when storage writes fail).
            "naming_mode": "smart" if naming_mode == "smart" else "legacy",
            "arrangements": arr_list,
            "audio_url": audio_url,
            "audio_error": audio_error,
            "tuning": arr.tuning,
            # Number of strings on the active arrangement
            # (feedBack-plugin-3dhighway#7). arrangement XML / archive sources
            # always emit `tuning` as length 6 with zero-padding for
            # unused string slots, so `len(arr.tuning)` is unreliable
            # there; sloppak / GP-imported sources may instead carry
            # a trimmed list. arrangement_string_count() combines a
            # notes-derived lower bound, a name-based fallback (4 for
            # "bass" arrangements), and the tuning length (when it
            # disagrees with the RS-XML padded 6) into a single
            # reliable signal. Plugins should size string-indexed UI
            # / geometry against THIS rather than assuming 6 or
            # using `tuning.length` directly.
            "stringCount": arrangement_string_count(arr),
            "capo": arr.capo,
            "centOffset": arr.cent_offset,
            # Sanitize song.offset before send_json: a malformed loose
            # chart can produce NaN via `float("nan")`, which Starlette
            # would serialise as the literal `NaN` token (invalid JSON)
            # and break the frontend's song_info parsing.
            "offset": _sanitized_song_offset(song) if is_loose else 0.0,
            "format": "sloppak" if is_slop else ("loose" if is_loose else "archive"),
            # Feedpak contributor credits (manifest `authors:`, spec §5.4) —
            # name + role only, shown on the highway when a song is loaded.
            # Only sloppak/feedpak packs carry a manifest; loose/archive
            # sources get []. The frontend uses a non-empty list as the gate
            # for the credits overlay, so minigames / synthetic highway uses
            # (no manifest) never trigger it.
            "authors": _sanitize_authors(loaded_slop.manifest) if (is_slop and loaded_slop is not None) else [],
            "stems": stems_payload,
            # Full-mix audio (sloppak `original_audio:`) served alongside the
            # separate `stems`. The stems plugin plays this single file while
            # every stem slider is at unity and switches to the separate stems
            # the moment one drops below 100%. None when the pack ships stems
            # only. `has_*` flags mirror the has_drum_tab/has_keys convention so
            # a client can branch without re-deriving from the URLs.
            "original_audio_url": original_audio_url,
            "has_original_audio": bool(original_audio_url),
            "has_stems": bool(stems_payload),
            # Surface a drum_tab presence flag so the visualization picker
            # can auto-activate the drums plugin even when the chosen
            # arrangement isn't named "Drums" (drum_tab.json lives next
            # to the manifest, not inside the arrangements list).
            "has_drum_tab": bool(
                is_slop and loaded_slop is not None and loaded_slop.drum_tab is not None
            ),
            "has_notation": bool(
                is_slop
                and loaded_slop is not None
                and loaded_slop.notation_by_id is not None
                and _notation_arr_id is not None
                and _notation_arr_id in loaded_slop.notation_by_id
            ),
            # Song-level key/scale track presence (keys.json, spec §7.7) so a
            # consumer can light up a key/scale display without parsing the pack.
            "has_keys": bool(
                is_slop and loaded_slop is not None and loaded_slop.keys is not None
            ),
        })

        # Send drum_tab when the sloppak ships one (manifest `drum_tab:` key,
        # see lib/sloppak.py). The drums plugin subscribes to `drum_tab` for
        # the kit legend and `drum_hits` for the timed hit stream. Chunked
        # 500-per-frame like notes so a long song stays well under WS frame
        # limits. Legacy drum sloppaks (drums encoded as guitar notes) skip
        # this branch and fall through to the regular `notes` stream — the
        # client-side drums plugin keeps a fallback decoder for them.
        if is_slop and loaded_slop is not None and loaded_slop.drum_tab is not None:
            dt = loaded_slop.drum_tab
            kit = drums_mod.normalise_kit(dt.get("kit"))
            hits_wire = drums_mod.hits_to_wire(dt.get("hits") or [])
            _dt_name = dt.get("name")
            _dt_name = _dt_name if isinstance(_dt_name, str) and _dt_name else "Drums"
            try:
                await websocket.send_json({
                    "type": "drum_tab",
                    "version": int(dt.get("version", drums_mod.SCHEMA_VERSION)),
                    "name": _dt_name,
                    "kit": kit,
                    "total": len(hits_wire),
                })
                for i in range(0, len(hits_wire), 500):
                    await websocket.send_json({
                        "type": "drum_hits",
                        "data": hits_wire[i:i + 500],
                        "total": len(hits_wire),
                    })
            except WebSocketDisconnect:
                return

        # Send beats
        beats = [{"time": b.time, "measure": b.measure} for b in song.beats]
        await websocket.send_json({"type": "beats", "data": beats})

        # Send sections
        sections = [{"name": s.name, "time": s.start_time} for s in song.sections]
        await websocket.send_json({"type": "sections", "data": sections})

        # Send the song-level key/scale track (keys.json, spec §7.7) when the
        # sloppak ships one. Consumers read it from the WS rather than the file,
        # like drum_tab/beats/sections. The loader already sanitized the events
        # (finite t, non-empty string key, sorted), so this is a direct send.
        if is_slop and loaded_slop is not None and loaded_slop.keys is not None:
            await websocket.send_json({
                "type": "keys",
                "version": int(loaded_slop.keys.get("version", 1)),
                "data": loaded_slop.keys.get("events") or [],
            })

        # Song-level tempo + time-signature maps (song_timeline, feedpak 1.2.0),
        # plus the per-chart tempo override (§6.10): the active arrangement's own
        # `tempos` wins over the song-level map for this chart. Both are
        # pre-sanitized by the loader / arrangement_from_wire, so they stream
        # directly. Consumers read these rather than the file.
        _song_tempos = loaded_slop.tempos if (is_slop and loaded_slop is not None) else None
        _tempos_out = getattr(arr, "tempos", None) or _song_tempos
        if _tempos_out:
            await websocket.send_json({"type": "tempos", "data": _tempos_out})
        _time_sigs = (loaded_slop.time_signatures
                      if (is_slop and loaded_slop is not None) else None)
        if _time_sigs:
            await websocket.send_json({"type": "time_signatures", "data": _time_sigs})

        # Send notation data when the sloppak ships it for the active arrangement.
        # Slots after sections (cursor sync depends on beats, which precede sections)
        # and before anchors — per docs/sloppak-spec.md §5.3.
        if (
            is_slop
            and loaded_slop is not None
            and loaded_slop.notation_by_id is not None
            and _notation_arr_id is not None
            and _notation_arr_id in loaded_slop.notation_by_id
        ):
            nt = loaded_slop.notation_by_id[_notation_arr_id]
            measures_wire = notation_mod.measures_to_wire(nt.get("measures") or [])
            try:
                await websocket.send_json({
                    "type": "notation_info",
                    "version": int(nt.get("version", notation_mod.SCHEMA_VERSION)),
                    "instrument": str(nt.get("instrument", "")),
                    "staves": nt.get("staves") or [],
                    "total": len(measures_wire),
                })
                _NOTATION_CHUNK = 32
                for i in range(0, len(measures_wire), _NOTATION_CHUNK):
                    await websocket.send_json({
                        "type": "notation_measures",
                        "data": measures_wire[i:i + _NOTATION_CHUNK],
                        "total": len(measures_wire),
                    })
            except WebSocketDisconnect:
                return

        # Send anchors
        anchors = [anchor_to_wire(a) for a in arr.anchors]
        await websocket.send_json({"type": "anchors", "data": anchors})

        # Send chord templates. Include `fingers` alongside `name` /
        # `frets` so plugin overlays consuming highway.getChordTemplates()
        # can render full chord boxes (chord-style fingering
        # diagrams), not just chord names. Each fingering entry is
        # per-string: -1 = unused, 0 = open string, n > 0 = finger
        # number. RS XML sources populate real values; GP imports
        # currently emit all -1 (no finger data available pre-import).
        templates = [chord_template_to_wire(ct) for ct in arr.chord_templates]
        await websocket.send_json({"type": "chord_templates", "data": templates})

        # Send lyrics if available
        import xml.etree.ElementTree as ET
        lyrics = []
        lyrics_source = ""
        # Loose folders are flat — only inspect direct children so a
        # nested backup/export directory inside the song folder can't
        # override the active arrangement's lyrics / tone. archives are
        # unpacked into nested tmp dirs, so they keep recursive rglob.
        # Sloppak skips XML lookups entirely below but the json loop
        # is unconditional, so define both walkers up front.
        _xml_walk = Path(tmp).glob if is_loose else Path(tmp).rglob
        _json_walk = Path(tmp).glob if is_loose else Path(tmp).rglob
        if is_slop:
            lyrics = list(song.lyrics or [])
            lyrics_source = getattr(song, "lyrics_source", "") or ""
        else:
            for xml_path in sorted(_xml_walk("*.xml")):
                try:
                    root = ET.parse(xml_path).getroot()
                    if root.tag == "vocals":
                        # An empty <vocals/> shell would otherwise
                        # short-circuit later XML files, so only stop
                        # scanning when the XML actually produced lyric
                        # tokens — a meaningful XML further down the
                        # walk must still be reachable.
                        candidate = [
                            {
                                "t": round(float(v.get("time", "0")), 3),
                                "d": round(float(v.get("length", "0")), 3),
                                "w": v.get("lyric", ""),
                            }
                            for v in root.findall("vocal")
                        ]
                        if candidate:
                            lyrics = candidate
                            lyrics_source = "xml"
                            break
                except Exception:
                    pass
        if lyrics:
            payload = {"type": "lyrics", "data": lyrics}
            if lyrics_source:
                payload["source"] = lyrics_source
            await websocket.send_json(payload)

        # Send tone changes. archive and loose folders carry tone data in
        # arrangement XMLs; a sloppak ships it inline in its arrangement JSON
        # (Arrangement.tones, populated by the converter), so read it straight
        # off `arr` rather than walking for XML that doesn't exist.
        if is_slop:
            # `sloppak_tone_changes` builds the (base, sorted changes) pair
            # from `Arrangement.tones`, skipping non-string names and
            # non-finite/non-numeric times — unit-tested in test_tones.py.
            from tones import sloppak_tone_changes
            base_name, tone_changes = sloppak_tone_changes(getattr(arr, "tones", None))
            # Send when there's a base tone OR timed changes — a single-tone
            # arrangement has a base but no switches, and the highway should
            # still be able to show the initial tone.
            if tone_changes or base_name:
                await websocket.send_json({
                    "type": "tone_changes",
                    "base": base_name,
                    "data": tone_changes,
                })
        else:
            xml_paths = sorted(_xml_walk("*.xml"))

            # Build tone ID→name map from the manifest JSON for the selected
            # arrangement. Match on the entry's `ArrangementName` field, not a
            # filename-stem substring — "Lead" is a substring of "Bonus Lead",
            # so the old substring test could build the map from the wrong
            # arrangement. Record the matched JSON stem so the XML below can
            # be paired exactly (RS names the JSON and XML with the same stem).
            arr_tone_names = {}  # the SELECTED arrangement's own Tone_A..D only
            matched_stem = None
            # Strip + lowercase both sides when matching ArrangementName,
            # mirroring lib/tones.py — a manifest with padded whitespace
            # must not fall through to an unrelated arrangement.
            arr_name_lower = arr.name.strip().lower() if arr else ""

            def _manifest_entries(path):
                """Parsed `Entries` dict for a manifest JSON, or {} if the
                file isn't a well-formed manifest (non-dict top level /
                Entries, unparseable JSON)."""
                try:
                    # JSON is UTF-8; decode strictly so malformed bytes fail
                    # cleanly (caught below) rather than silently corrupting
                    # arrangement / tone names.
                    jdata = json.loads(path.read_text(encoding="utf-8"))
                except Exception:
                    return {}
                entries = jdata.get("Entries") if isinstance(jdata, dict) else None
                return entries if isinstance(entries, dict) else {}

            def _tone_names(attrs):
                """{idx: name} from an entry's Tone_A..Tone_D — string values
                only, so a malformed manifest can't emit a non-string name."""
                m = {}
                for idx, key in enumerate(("Tone_A", "Tone_B", "Tone_C", "Tone_D")):
                    val = attrs.get(key)
                    if isinstance(val, str) and val:
                        m[idx] = val
                return m

            for jf in sorted(_json_walk("*.json")):
                for entry in _manifest_entries(jf).values():
                    if not isinstance(entry, dict):
                        continue
                    attrs = entry.get("Attributes")
                    if not isinstance(attrs, dict):
                        continue
                    ename = attrs.get("ArrangementName")
                    if not isinstance(ename, str) or ename.strip().lower() != arr_name_lower:
                        continue
                    # Only the SELECTED arrangement's own Tone_A..D — never
                    # borrowed from another manifest. An unrelated map would
                    # mislabel `N/A` tone-change markers; `Tone {id}` is the
                    # correct fallback (matching lib/tones.py).
                    arr_tone_names = _tone_names(attrs)
                    matched_stem = jf.stem.lower()
                    break
                if matched_stem is not None:
                    break

            # Parse XMLs. Prefer the XML paired with the matched manifest
            # (identical stem). When no manifest matched (loose/custom song), fall
            # back to a name-token match — but rank by how few *extra* stem
            # tokens a candidate carries, mirroring lib/tones.py: {"lead"} is
            # a subset of both `song_lead` and `song_bonus_lead`, so a plain
            # subset test still ties. A unique fewest-extra match wins; an
            # exact tie among token candidates is treated as ambiguous —
            # `_token_ambiguous` then suppresses the rank-2 best-effort
            # fallback, so no arrangement's tone timeline is guessed at
            # (matching lib/tones.py, which attaches nothing on a tie).
            # Shared tokenizer with lib/tones.py so archive playback and
            # archive→sloppak conversion select arrangement XMLs identically.
            from tones import tokens as _name_tokens
            _arr_tokens = _name_tokens(arr.name) if arr else set()
            _token_pick = None
            _token_ambiguous = False
            if _arr_tokens and matched_stem is None:
                _cands = []
                for xp in xml_paths:
                    stem_tokens = _name_tokens(xp.stem)
                    if _arr_tokens <= stem_tokens:
                        _cands.append((len(stem_tokens - _arr_tokens), xp))
                if _cands:
                    _best = min(extra for extra, _ in _cands)
                    _tied = [xp for extra, xp in _cands if extra == _best]
                    if len(_tied) == 1:
                        _token_pick = _tied[0]
                    else:
                        _token_ambiguous = True

            def _xml_rank(xp):
                if matched_stem and xp.stem.lower() == matched_stem:
                    return 0
                if _token_pick is not None and xp == _token_pick:
                    return 1
                return 2
            sorted_xml = sorted(xml_paths, key=lambda xp: (_xml_rank(xp), xp.name))
            # When the arrangement was positively identified (manifest stem
            # pair or a unique token match), tone data must come only from
            # that XML — a rank-2 fallback XML belongs to another
            # arrangement. A token tie is likewise suppressed (guessing among
            # equally-named XMLs would be wrong). Only a genuine no-match
            # case (loose/custom song with no usable manifest and no name overlap)
            # keeps the long-standing rank-2 best-effort source.
            _suppress_fallback = (
                matched_stem is not None or _token_pick is not None or _token_ambiguous
            )
            sent_tones = False
            tone_base = ""  # <tonebase> of the preferred arrangement XML
            for xml_path in sorted_xml:
                try:
                    root = ET.parse(xml_path).getroot()
                    if root.tag != "song":
                        continue
                    if _suppress_fallback and _xml_rank(xml_path) == 2:
                        # Don't read tones from an unrelated arrangement's XML.
                        continue
                    # Capture the base tone from the first XML the loop
                    # accepts. The skip above already excluded untrusted
                    # rank-2 XMLs whenever a match was confirmed; in the
                    # genuine no-match case rank-2 IS the best-effort source,
                    # so its <tonebase> is equally valid for a base-only song.
                    if not tone_base:
                        _tb = root.find("tonebase")
                        if _tb is not None and _tb.text:
                            # Strip whitespace from pretty-printed XML so the
                            # base name matches the sloppak path, which also
                            # strips it.
                            tone_base = _tb.text.strip()
                    tones_el = root.find("tones")
                    if tones_el is not None:
                        # Accumulate into a per-XML list — if this file
                        # raises partway through, its partial changes are
                        # discarded rather than bleeding into the next
                        # candidate XML.
                        xml_tone_changes = []
                        for t in tones_el.findall("tone"):
                            tc_time = t.get("time")
                            tc_name = t.get("name", "")
                            tc_id = t.get("id", "")
                            # Resolve "N/A" or empty names via the selected
                            # arrangement's own tone map; `Tone {id}` when it
                            # has none (never another arrangement's names).
                            if (not tc_name or tc_name == "N/A") and tc_id:
                                try:
                                    tc_name = arr_tone_names.get(int(tc_id), f"Tone {tc_id}")
                                except (TypeError, ValueError):
                                    pass
                            if tc_time and tc_name:
                                # Skip a single malformed/non-finite marker
                                # rather than letting it raise — the outer
                                # `except` would otherwise swallow the whole
                                # XML and drop every tone change. NaN/inf
                                # would also produce client-unparseable JSON.
                                try:
                                    tc_t = float(tc_time)
                                except (TypeError, ValueError):
                                    continue
                                if not math.isfinite(tc_t):
                                    continue
                                xml_tone_changes.append({
                                    "t": round(tc_t, 3),
                                    "name": tc_name,
                                })
                        if xml_tone_changes:
                            tonebase = root.find("tonebase")
                            base_name = tonebase.text.strip() if tonebase is not None and tonebase.text else ""
                            # If base name not in XML, use the selected
                            # arrangement's own Tone_A.
                            if not base_name:
                                base_name = arr_tone_names.get(0, "")
                            await websocket.send_json({
                                "type": "tone_changes",
                                "base": base_name,
                                "data": sorted(xml_tone_changes, key=lambda x: x["t"]),
                            })
                            sent_tones = True
                            break
                except (ET.ParseError, OSError) as e:
                    # Only swallow unreadable/malformed XML — skip to the next
                    # candidate. A blanket `except` here would also eat a
                    # `WebSocketDisconnect` from `send_json`; let that bubble
                    # to the handler's outer disconnect handler.
                    log.debug(
                        "highway: skipping unreadable arrangement XML %s: %s",
                        xml_path.name, e,
                    )
                    continue
            # Base-only fallback: a single-tone arrangement has a <tonebase>
            # but no <tones> markers — still surface the initial tone so the
            # highway can show it (parity with the sloppak path above).
            # `tone_base` is the <tonebase> of whichever XML the loop
            # accepted: the confirmed-match XML, or — in the genuine no-match
            # case — the best-effort rank-2 XML. `arr_tone_names` holds the
            # selected arrangement's own Tone_A..D. An ambiguous arrangement
            # (token tie) accepts no XML and has no manifest map, so it
            # correctly sends nothing rather than a guessed tone.
            if not sent_tones:
                base_name = tone_base
                if not base_name:
                    base_name = arr_tone_names.get(0, "")
                if base_name:
                    await websocket.send_json({
                        "type": "tone_changes",
                        "base": base_name,
                        "data": [],
                    })

        # Teaching mark sd (§6.2.2): derive each note's scale degree from the
        # active key (keys.json §7.7) + its sounding pitch (tuning[string] +
        # fret), only when the author didn't author one. Display/teaching only —
        # NEVER feeds grading. Notes whose string/fret has no tuning entry, or
        # that have no active key, or whose key name is unparseable, stay unset.
        _key_events = (
            (loaded_slop.keys.get("events") or [])
            if (is_slop and loaded_slop is not None and loaded_slop.keys is not None)
            else []
        )
        _key_times = [e["t"] for e in _key_events]
        _key_tonics = [key_to_tonic_pc(e.get("key")) for e in _key_events]
        _tuning = arr.tuning or []
        # Hoist the open-string base out of the per-note loop: arr.tuning holds
        # per-string OFFSETS from standard, so the sounding pitch is
        # base[string] + offset + capo + fret (matches the tuner / open-string
        # labels). arrangement_string_count is O(notes), so compute once here.
        _base = base_open_string_midis(
            arrangement_string_count(arr), "bass" in (arr.name or "").lower())
        _capo = int(getattr(arr, "capo", 0) or 0)

        def _fill_scale_degree(wire: dict, n, t: float) -> None:
            # Author-provided sd wins — note_to_wire already emitted it.
            if "sd" in wire or not _key_times:
                return
            idx = bisect.bisect_right(_key_times, t) - 1
            if idx < 0:
                return
            tonic = _key_tonics[idx]
            if tonic is None:
                return
            midi = pitch_from_base(_base, _capo, _tuning, n.string, n.fret)
            if midi is None:
                return
            wire["sd"] = scale_degree_for_pitch(midi, tonic)

        # Send notes in chunks
        notes = []
        for n in arr.notes:
            w = note_to_wire(n)
            _fill_scale_degree(w, n, n.time)
            notes.append(w)
        # Send in chunks of 500
        for i in range(0, len(notes), 500):
            await websocket.send_json({
                "type": "notes",
                "data": notes[i:i+500],
                "total": len(notes),
            })

        # Send chords
        chords = []
        for c in arr.chords:
            cw = chord_to_wire(c)
            for cn, cnw in zip(c.notes, cw.get("notes", [])):
                _fill_scale_degree(cnw, cn, c.time)
            chords.append(cw)
        for i in range(0, len(chords), 500):
            await websocket.send_json({
                "type": "chords",
                "data": chords[i:i+500],
                "total": len(chords),
            })

        hand_shapes_out = [hand_shape_to_wire(h) for h in arr.hand_shapes]
        for i in range(0, len(hand_shapes_out), 500):
            await websocket.send_json({
                "type": "handshapes",
                "data": hand_shapes_out[i:i+500],
                "total": len(hand_shapes_out),
            })

        # Per-phrase difficulty data for the master-difficulty slider
        # (feedBack#48). Only sent when the source chart had multiple
        # `<level>` tiers — single-level charts (GP converter, older
        # sloppaks without phrase data) produce arr.phrases=None, and the
        # frontend treats the missing message as "slider disabled".
        # Consumers that don't know about this message type ignore it.
        #
        # Chunked at phrase granularity (20 phrases per frame) because
        # each phrase nests per-level note/chord lists — a single frame
        # could otherwise exceed proxy/WS size limits on large songs.
        # Chunk boundary is per-phrase (not per-level) so the frontend
        # reassembles whole phrase ladders.
        if arr.phrases:
            total = len(arr.phrases)
            for i in range(0, total, 20):
                await websocket.send_json({
                    "type": "phrases",
                    "data": [phrase_to_wire(p) for p in arr.phrases[i:i + 20]],
                    "total": total,
                })

        await websocket.send_json({"type": "ready"})

        # Keep connection alive for control messages
        try:
            while True:
                msg = await websocket.receive_text()
                data = json.loads(msg)
                if data.get("action") == "change_arrangement":
                    pass
        except WebSocketDisconnect:
            pass

    except Exception as e:
        log.exception("highway_ws unhandled error for %s", filename)
        try:
            await websocket.send_json({"error": str(e)})
            await websocket.close()
        except Exception:
            pass

    finally:
        pass  # Don't clean up — cached for arrangement switching


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
