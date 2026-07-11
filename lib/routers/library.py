"""Library + smart-collection routes: the provider list/art/sync endpoints, the
library query surface (songs, albums, artists, stats, genres, tuning-names,
practice-suggestions), and collection CRUD.

Extracted verbatim from server.py (R3) except @app->@router and the seam reads:
meta_db->appstate.meta_db, and the registry singletons ->
appstate.library_providers / appstate.local_library_provider (constructed +
owned by server.py; plugins register providers through plugin_context). The
provider classes + shared query/collection helpers live in lib/library_registry.py.
"""

import inspect
from pathlib import Path
from typing import Any

from fastapi import APIRouter, HTTPException
from fastapi.responses import FileResponse, JSONResponse, RedirectResponse, Response
from starlette.concurrency import run_in_threadpool

import appstate
from library_registry import (
    _library_filter_args, _sanitize_collection_rules,
    _safe_art_redirect_url, _split_csv, _sync_collection_provider,
    _unregister_collection_provider,
)
from metadata_db import _effective_keyset_sort, next_library_cursor
from reqfields import _clean_str

import logging
log = logging.getLogger("feedBack.server")
router = APIRouter()





def _get_library_provider(provider: str = "local") -> object:
    library_provider = appstate.library_providers.get(provider or "local")
    if library_provider is None:
        raise HTTPException(status_code=404, detail=f"Unknown library provider: {provider}")
    return library_provider


def _require_library_provider_capability(provider: object, capability: str) -> None:
    if capability in appstate.library_providers.provider_capabilities(provider):
        return
    provider_id = appstate.library_providers.provider_id(provider)
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
    method = appstate.library_providers.provider_method(provider, method_name)
    if not callable(method):
        provider_id = appstate.library_providers.provider_id(provider)
        raise HTTPException(
            status_code=501,
            detail=f"Library provider {provider_id!r} does not support {method_name}",
        )
    try:
        return method(**_filter_provider_kwargs(method, kwargs))
    except HTTPException:
        raise
    except Exception as exc:
        provider_id = appstate.library_providers.provider_id(provider)
        # A provider with an explicit kind="local" is treated as local even if
        # its id is not "local" (e.g. a kind="local" plugin variant). Otherwise
        # fall back to provider_id comparison so providers that omit `kind` are
        # still wrapped correctly — the safe default for unknown providers is to
        # surface an offline message rather than leaking raw exceptions.
        provider_kind = str(appstate.library_providers.provider_field(provider, "kind", "") or "")
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
    method = appstate.library_providers.provider_method(provider, method_name)
    if _is_async_callable(method):
        # Async provider method — call directly on the event loop.
        try:
            return await method(**_filter_provider_kwargs(method, kwargs))
        except HTTPException:
            raise
        except Exception as exc:
            provider_id = appstate.library_providers.provider_id(provider)
            provider_kind = str(appstate.library_providers.provider_field(provider, "kind", "") or "")
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


@router.get("/api/library/providers")
def list_library_providers():
    """List registered library providers."""
    return {"providers": appstate.library_providers.list()}


@router.get("/api/library/providers/{provider_id}/songs/{song_id:path}/art")
async def get_library_provider_song_art(provider_id: str, song_id: str):
    """Return album art for a song owned by a library provider."""
    library_provider = _get_library_provider(provider_id)
    _require_library_provider_capability(library_provider, "art.read")
    result = await _call_library_provider_async(library_provider, "get_art", song_id=song_id)
    return _library_art_response(result)


@router.post("/api/library/providers/{provider_id}/songs/{song_id:path}/sync")
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


@router.get("/api/library")
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


@router.get("/api/library/albums")
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


@router.get("/api/library/artists")
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


@router.get("/api/library/stats")
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


@router.get("/api/library/genres")
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
    kind = str(appstate.library_providers.provider_field(library_provider, "kind", "") or "")
    is_remote = kind not in ("", "local") if kind else provider != "local"
    if is_remote:
        return {"genres": []}
    with appstate.meta_db._lock:
        g = appstate.meta_db._effective_genre_expr()
        rows = appstate.meta_db.conn.execute(
            f"SELECT g FROM (SELECT DISTINCT ({g}) AS g FROM songs) "
            "WHERE g IS NOT NULL AND g != '' ORDER BY g COLLATE NOCASE"
        ).fetchall()
    return {"genres": [r[0] for r in rows]}


@router.get("/api/library/tuning-names")
async def list_tuning_names(provider: str = "local"):
    """Distinct tuning names present in the library, with per-tuning
    counts. Powers the tuning multi-select. Sorted by `tuning_sort_key`
    so names appear in the same musical order the sort uses
    (feedBack#22) — E Standard first, then nearest neighbors."""
    library_provider = _get_library_provider(provider)
    _require_library_provider_capability(library_provider, "library.read")
    return await _call_library_provider_async(library_provider, "tuning_names")


@router.get("/api/library/practice-suggestions")
def api_practice_suggestions(limit: int = 8):
    """Growth-edge 'practice next' shelf (P3): attempted-but-not-mastered songs
    ranked by difficulty-appropriateness × mastery-proximity, joined to song
    metadata. Replaces the recency-only 'Keep practicing' shelf ordering. Local
    library only — reads local practice stats."""
    from urllib.parse import quote
    out = []
    for r in appstate.meta_db.growth_edge_suggestions(limit):
        meta = appstate.meta_db.conn.execute(
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


@router.get("/api/collections")
def api_list_collections():
    """Smart/dynamic collections (saved live library filters)."""
    return {"collections": appstate.meta_db.list_collections()}


@router.post("/api/collections")
def api_create_collection(data: dict):
    """Create a collection from a name + a set of library filter rules. It
    immediately appears as a source in the library provider picker."""
    if not isinstance(data, dict):
        return JSONResponse({"error": "body must be an object"}, status_code=400)
    name = _clean_str(data.get("name"))
    if not name:
        return JSONResponse({"error": "name required"}, status_code=400)
    col = appstate.meta_db.create_collection(name, _sanitize_collection_rules(data.get("rules")))
    _sync_collection_provider(col)
    return {"ok": True, "collection": col}


@router.put("/api/collections/{pid}")
def api_update_collection(pid: int, data: dict):
    """Rename a collection and/or replace its rules."""
    if not isinstance(data, dict):
        return JSONResponse({"error": "body must be an object"}, status_code=400)
    name = _clean_str(data.get("name")) or None
    rules = _sanitize_collection_rules(data["rules"]) if "rules" in data else None
    col = appstate.meta_db.update_collection(pid, name=name, rules=rules)
    if col is None:
        return JSONResponse({"error": "collection not found"}, status_code=404)
    _sync_collection_provider(col)
    return {"ok": True, "collection": col}


@router.delete("/api/collections/{pid}")
def api_delete_collection(pid: int):
    """Delete a collection and unregister its provider."""
    if not appstate.meta_db.is_collection(pid):
        return JSONResponse({"error": "collection not found"}, status_code=404)
    appstate.meta_db.delete_playlist(pid)
    _unregister_collection_provider(pid)
    return {"ok": True}
