"""The library-provider registry — the plugin extension point for song sources.

`LocalLibraryProvider` wraps the local `MetadataDB`; third-party plugins register
their own providers (duck-typed: any object with the advertised methods) through
`LibraryProviderRegistry`, and smart collections are surfaced as
`SmartCollectionProvider`s over the local one. server.py constructs the singleton
(`library_providers`), injects it + the local provider into appstate, and exposes
`register_library_provider`/`unregister_library_provider` to plugins via
plugin_context (with per-plugin ownership scoping in plugins/__init__.py).

Moved verbatim out of server.py (R3). The shared query/collection helpers live
here too so routers/library.py can import them without reaching into server.
"""

import re
import threading
from typing import ClassVar

import appstate
from metadata_db import MetadataDB, _tuning_group_key_sql
from routers import art as art_router

import logging
log = logging.getLogger("feedBack.server")

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


_TUNING_GROUP_KEY_SQL = _tuning_group_key_sql("songs")


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
        return await art_router.get_song_art(song_id)


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


def _sync_collection_provider(collection: dict) -> None:
    """Register (or replace) the provider for one collection."""
    appstate.library_providers.register(
        SmartCollectionProvider(collection, appstate.local_library_provider), replace=True)


def _unregister_collection_provider(pid: int) -> None:
    appstate.library_providers.unregister(f"collection:{pid}")
