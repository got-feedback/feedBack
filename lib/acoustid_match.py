"""AcoustID audio-fingerprint identification for MusicBrainz enrichment.

A flat MusicBrainz *text* search ties every take of a song at the same score —
studio, a dozen live bootlegs, and every compilation — so "AC/DC — Highway to
Hell" returns junk (see lib/mb_match.py's canonical re-ranking, which mitigates
it). The definitive fix is content-based: fingerprint the actual audio with
Chromaprint (`fpcalc`) and look it up on AcoustID, which maps the fingerprint
straight to the *exact* MusicBrainz recording — the same approach Lidarr uses.

This module is the PURE half (no network, no subprocess): response parsing +
config gating, so it is unit-testable in isolation. server.py owns the `fpcalc`
subprocess and the throttled HTTP GET to api.acoustid.org.

Operational requirements (both optional — absent ⇒ this path is a graceful
no-op and the text matcher still runs):
  * `fpcalc` (Chromaprint) on PATH or at $FPCALC — generates the fingerprint.
  * an AcoustID application API key in $ACOUSTID_API_KEY — free from
    https://acoustid.org/new-application ; AcoustID etiquette limits to ~3 req/s.
"""

import os

ACOUSTID_API_ROOT = "https://api.acoustid.org/v2"

# The `meta` fields we ask AcoustID to return so a hit resolves to displayable
# metadata without a second MusicBrainz round-trip. SPACE-separated, not
# `+`-joined: a literal `+` in the value gets percent-encoded to %2B, which
# AcoustID does NOT split into flags — it then attaches no recording metadata
# and every hit comes back empty (verified: `+` → 0 recordings, space → 28).
# `releases` is what carries the per-release DATE (nested under each
# releasegroup), which we need to pick the earliest original album + fill year.
LOOKUP_META = "recordings releasegroups releases compress"

# Mirror mb_match._SECONDARY_SKIP: release-group secondary types that mark a
# non-canonical (live/comp/remix) release, so we can flag the studio take.
_SECONDARY_SKIP = {
    "live", "compilation", "remix", "dj-mix", "mixtape/street",
    "demo", "interview", "audiobook", "spokenword",
}


def api_key(explicit: str | None = None) -> str:
    """The AcoustID application API key: an explicit value (e.g. a host setting)
    wins, else $ACOUSTID_API_KEY, else "" (⇒ fingerprinting disabled)."""
    return (explicit or os.environ.get("ACOUSTID_API_KEY") or "").strip()


def is_configured(explicit_key: str | None = None) -> bool:
    """True when an API key is available. `fpcalc` presence is checked by
    server.py (it owns the binary lookup); both are required to actually run."""
    return bool(api_key(explicit_key))


def _rg_is_studio(rg: dict) -> bool:
    if str(rg.get("type", "")).lower() != "album":
        return False
    secs = {str(s).lower() for s in (rg.get("secondarytypes") or [])}
    return not (secs & _SECONDARY_SKIP)


def _rg_earliest_year(rg: dict) -> "int | None":
    """Earliest release YEAR in a release-group (min over its nested releases'
    dates). None when no release carries a date. This is what separates the
    original pressing from later reissues/comps sharing the same group."""
    years = []
    for rel in (rg.get("releases") or []):
        d = (rel or {}).get("date")
        if isinstance(d, dict) and d.get("year"):
            try:
                years.append(int(d["year"]))
            except (TypeError, ValueError):
                pass
    return min(years) if years else None


def _best_group(recording: dict) -> dict:
    """Pick the display album: a clean studio Album first, and among those the
    EARLIEST-released one — the original, not a later reissue or a compilation
    that happens to be typed 'Album' (e.g. a soundtrack). This is what pulls
    "Machine Head" ahead of a later comp for "Smoke on the Water". Falls back to
    the first group when nothing is a studio album or nothing carries a date."""
    groups = [g for g in (recording.get("releasegroups") or []) if isinstance(g, dict)]
    if not groups:
        return {}

    def sort_key(g):
        yr = _rg_earliest_year(g)
        # studio (0) before non-studio (1); then earliest year (undated last).
        return (0 if _rg_is_studio(g) else 1, yr if yr is not None else 9999)

    return sorted(groups, key=sort_key)[0]


def _first_artist(recording: dict) -> str:
    for a in (recording.get("artists") or []):
        if isinstance(a, dict) and a.get("name"):
            return str(a["name"])
    return ""


def parse_lookup_response(body: dict) -> list[dict]:
    """Normalize an AcoustID /v2/lookup response into the same flat candidate
    shape as mb_match (recording_id / title / artist / album / year / duration /
    studio / mb_score / score), so the review UI and the editor's Match popup
    render fingerprint hits and text hits identically. `mb_score` carries the
    AcoustID confidence (0-100) — a fingerprint hit is high-signal by nature."""
    if not isinstance(body, dict) or body.get("status") != "ok":
        return []
    out: list[dict] = []
    seen: set[str] = set()
    for result in (body.get("results") or []):
        if not isinstance(result, dict):
            continue
        try:
            score = float(result.get("score") or 0.0)
        except (TypeError, ValueError):
            score = 0.0
        for rec in (result.get("recordings") or []):
            if not isinstance(rec, dict) or not rec.get("id"):
                continue
            rid = str(rec["id"])
            if rid in seen:
                continue
            seen.add(rid)
            rg = _best_group(rec)
            _yr = _rg_earliest_year(rg)
            year = str(_yr) if _yr else ""
            dur = rec.get("duration")
            try:
                duration = int(round(float(dur))) if dur else None
            except (TypeError, ValueError):
                duration = None
            out.append({
                "recording_id": rid,
                "title": str(rec.get("title", "") or ""),
                "artist": _first_artist(rec),
                "album": str(rg.get("title", "") or ""),
                "year": year,
                "duration": duration,
                "isrc": "",
                "genres": [],
                "studio": _rg_is_studio(rg),
                "acoustid_score": round(score, 4),
                # Fingerprint hits are content-verified, not text-guessed — carry
                # the AcoustID confidence as the display score band.
                "mb_score": int(round(score * 100)),
                "score": round(score, 4),
                "source": "acoustid",
            })
    # Best AcoustID confidence first; studio take breaks ties.
    out.sort(key=lambda c: (c["acoustid_score"], 1 if c["studio"] else 0), reverse=True)
    return out
