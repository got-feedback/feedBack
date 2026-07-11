"""The metadata-enrichment subsystem: MusicBrainz/AcoustID/Cover-Art-Archive
transport, the match scorer glue, and the background enrichment worker (R3).

Moved verbatim out of server.py. The only changes are the seam reads — the
singletons and the two shared art helpers that stay in server.py are reached
through appstate at call time:

  meta_db            -> appstate.meta_db
  CONFIG_DIR         -> appstate.config_dir
  SLOPPAK_CACHE_DIR  -> appstate.sloppak_cache_dir
  ART_CACHE_DIR      -> appstate.art_cache_dir
  _song_pack_art_exists / _art_override_paths -> appstate.<callable>
  the User-Agent VERSION lookup: Path(__file__).parent -> .resolve().parents[1]
  (lib/enrichment.py -> app root; VERSION ships at the app root everywhere).

server.py drives the worker through the public names here (import enrichment;
enrichment._kick_enrich(), enrichment._enrich_thread, the routes call the
matchers/transport). Tests that faked the network on `server` now patch the
same names on `enrichment` (the module attribute is resolved at call time, so a
setattr(enrichment, "_mb_http_get", ...) reaches both the routes and the
worker's internal callers).
"""

import json
import os
import re
import threading
import time
from pathlib import Path

from fastapi.responses import JSONResponse

import acoustid_match
import appstate
import loosefolder as loosefolder_mod
import mb_match
import sloppak as sloppak_mod
from appconfig import _load_config
from dlc_paths import _get_dlc_dir, _resolve_dlc_path
from env_compat import env_flag_compat as _env_flag
from metadata_db import _artist_title_from_filename

import logging
log = logging.getLogger("feedBack.server")

_enrich_thread: threading.Thread | None = None


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
    LRU cap policy lands with it). Under appstate.config_dir so Settings backup/restore
    and the docker volume already cover it."""
    d = appstate.config_dir / "art_cache"
    d.mkdir(parents=True, exist_ok=True)
    return d


def _enrich_throttle():
    """Block until an external lookup is allowed. Matchers MUST call this
    before every network request — and must NOT hold appstate.meta_db._lock across the
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
            vf = Path(__file__).resolve().parents[1] / "VERSION"
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
    NEVER call this while holding appstate.meta_db._lock — fetch outside, write
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


_ACOUSTID_MAX_UPLOAD_BYTES = 256 * 1024 * 1024  # 256 MB — an uncompressed master
# Slack for the multipart envelope on the Content-Length pre-parse guard, shared
# by the AcoustID-identify route (server.py) and the song-upload route
# (routers/song.py). The real per-file cap is the streaming check downstream.
_MULTIPART_OVERHEAD_SLACK = 1024 * 1024  # 1 MiB


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
    cfg = _load_config(appstate.config_dir / "config.json") or {}
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
                src = sloppak_mod.resolve_source_dir(canon, dlc, appstate.sloppak_cache_dir)
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
# The art cache dir (appstate.config_dir/art_cache) holds two kinds of file:
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


def _prune_caa_cache() -> None:
    """Keep the CAA side of the art cache under its size cap: evict the
    oldest caa_* files (mtime LRU) and reset the enrichment rows that pointed
    at them. User-override files are never touched."""
    try:
        files = sorted(appstate.art_cache_dir.glob("caa_*.jpg"), key=lambda p: p.stat().st_mtime)
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
            appstate.meta_db.clear_enrichment_art_paths(evicted)
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
        appstate.meta_db.set_enrichment_art(fn, None, "error")
        return False
    if appstate.song_pack_art_exists(fn):
        appstate.meta_db.set_enrichment_art(fn, None, "pack")
        return False
    if appstate.art_override_paths(fn):
        appstate.meta_db.set_enrichment_art(fn, None, "user")
        return False
    cache_file = _enrichment_art_dir() / f"caa_{release_id}.jpg"
    if cache_file.is_file():
        appstate.meta_db.set_enrichment_art(fn, str(cache_file), "caa")
        return False
    data = _caa_http_get(release_id)
    if data is None:
        appstate.meta_db.set_enrichment_art(fn, None, "none")
        return False
    cache_file.write_bytes(data)
    appstate.meta_db.set_enrichment_art(fn, str(cache_file), "caa")
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
    locked = appstate.meta_db.locked_fields(fn)
    if locked:
        field_filter = _compose_lock_filter(field_filter, locked)

    cached = appstate.meta_db.enrichment_cache_lookup(chash, exclude_filename=fn)
    if cached:
        score = cached.pop("score", None)
        if field_filter:
            cached = field_filter(cached)
        appstate.meta_db.apply_enrichment_match(fn, chash, "matched", source="cache",
                                       score=score, cand=cached, apply_mask=apply_mask)
        return

    ids = _manifest_exact_ids(fn)
    if ids.get("mbid"):
        cand = _mb_lookup_recording(ids["mbid"])
        if cand:
            appstate.meta_db.apply_enrichment_match(fn, chash, "matched", source="mbid",
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
            appstate.meta_db.apply_enrichment_match(fn, chash, "matched", source="isrc",
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
        appstate.meta_db.apply_enrichment_match(fn, chash, "matched", source="text",
                                       score=best["score"], apply_mask=apply_mask,
                                       cand=field_filter(best) if field_filter else best)
    elif tier == "review":
        appstate.meta_db.apply_enrichment_match(fn, chash, "review", source="text",
                                       score=best["score"],
                                       candidates=ranked[:_ENRICH_MAX_CANDIDATES])
    else:
        appstate.meta_db.apply_enrichment_match(fn, chash, "failed", source="text",
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
    cfg = _load_config(appstate.config_dir / "config.json") or {}
    allowed_keys = frozenset(_ENRICH_APPLY_FIELDS) - _enrich_blocked_apply_keys(cfg)
    apply_mask = _enrich_apply_mask(cfg)
    try:
        pending = appstate.meta_db.enrichment_pending(limit=100000, allowed_keys=allowed_keys)
    except Exception:
        log.exception("enrichment: pending query failed")
        return
    for row in pending:
        try:
            appstate.meta_db.upsert_enrichment_stub(row["filename"], row["content_hash"])
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
            retriable = [r for r in appstate.meta_db.enrichment_failed_rows(limit=100000)
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
                appstate.meta_db.apply_enrichment_match(
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
        art_rows = appstate.meta_db.enrichment_art_pending(limit=100000)
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
                appstate.meta_db.set_enrichment_art(row["filename"], None, "error")
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
