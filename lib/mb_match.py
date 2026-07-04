"""Text-matching engine for MusicBrainz metadata enrichment (P8).

Pure functions only — no network, no database, no server imports — so the
whole matching pipeline is unit-testable in isolation. server.py owns the
throttled HTTP transport and the song_enrichment writes; this module owns:

* denoise/tokenize: fold community chart-title noise (author suffixes,
  ``(440Hz)``/``(Live)``/``(No Lead)``/``(v2)`` parentheticals, punctuation,
  diacritics, ``AC DC``/``ACDC``/``AC/DC`` spelling drift) into a comparable
  token form,
* similarity + scoring: token-set similarity on artist+title with year and
  duration proximity as corroborating bonuses,
* tier classification: auto (high) / review (medium) / none (low) — the
  design rule is that a WRONG match is worse than no match, so the auto
  tier is deliberately strict and medium confidence goes to a human,
* MusicBrainz JSON parsing: normalize ``/ws/2`` recording documents into
  the flat candidate dicts the review UI and song_enrichment store.
"""

import re
import unicodedata

# ── Tier thresholds ───────────────────────────────────────────────────────────
# Combined score = 0.5*artist_sim + 0.5*title_sim + corroboration bonuses
# (capped at 1.0). Wrong-match is worse than slow (design §5), so `auto`
# additionally requires BOTH fields to individually agree — a perfect title
# with a mismatched artist (a cover) must never auto-canonicalize, whatever
# the combined threshold is set to. AUTO_MIN is only the DEFAULT: the host
# surfaces it as the user-configurable "auto-apply confidence" setting and
# passes the chosen value into classify(auto_min=…).
AUTO_MIN = 0.90
AUTO_ARTIST_MIN = 0.8
AUTO_TITLE_MIN = 0.6
REVIEW_MIN = 0.65

YEAR_BONUS = 0.05        # candidate year within ±1 of the chart's year
DURATION_BONUS = 0.05    # candidate length within 5s of the chart's audio
DURATION_BONUS_LOOSE = 0.025   # …within 15s
_DURATION_TIGHT = 5
_DURATION_LOOSE = 15

# ── Denoise ───────────────────────────────────────────────────────────────────
# A parenthetical/bracketed group is dropped when it contains any of these
# noise terms as a whole word (chart-variant markers, tuning/pitch notes,
# performance qualifiers) or when it reads as an author credit ("by X",
# "charted by X"). Both sides of a comparison are denoised symmetrically, so
# over-stripping a meaningful group costs a little precision but never
# produces an asymmetric mismatch.
_NOISE_TERMS = (
    r"440\s*hz", r"a440", r"432\s*hz",
    r"live", r"acoustic", r"instrumental",
    r"no\s+(?:lead|rhythm|bass|vocals?|drums)",
    r"(?:lead|rhythm|bass)\s+only",
    r"v\d+", r"ver(?:sion)?\s*\d+",
    r"remaster(?:ed)?(?:\s*\d{4})?", r"re-?recorded?",
    r"fix(?:ed)?", r"updated?",
    r"bonus", r"custom",
)
_NOISE_GROUP_RE = re.compile(
    r"[(\[][^)\]]*\b(?:" + "|".join(_NOISE_TERMS) + r")\b[^)\]]*[)\]]",
    re.IGNORECASE,
)
# Author credits: "(by SomeCharter)", "[charted by X]", "(chart by X)".
_AUTHOR_GROUP_RE = re.compile(
    r"[(\[]\s*(?:chart(?:ed)?\s+)?by\s+[^)\]]*[)\]]", re.IGNORECASE)
# Trailing "- by SomeCharter" outside parens.
_AUTHOR_TAIL_RE = re.compile(r"\s+-\s+(?:chart(?:ed)?\s+)?by\s+.+$", re.IGNORECASE)

_PUNCT_RE = re.compile(r"[^\w\s]|_")
_WS_RE = re.compile(r"\s+")


def _strip_diacritics(s: str) -> str:
    return "".join(
        ch for ch in unicodedata.normalize("NFKD", s)
        if not unicodedata.combining(ch)
    )


def denoise(s, *, strip_leading_the: bool = False) -> str:
    """Fold a community metadata string into its comparable form:
    lowercase, diacritics stripped, noise parentheticals and author credits
    removed, punctuation collapsed to spaces. ``strip_leading_the`` drops a
    leading "The " — used for ARTIST comparison only ("The Beatles" ==
    "Beatles"), never titles ("The Trooper" must keep its "the")."""
    s = str(s or "")
    s = _NOISE_GROUP_RE.sub(" ", s)
    s = _AUTHOR_GROUP_RE.sub(" ", s)
    s = _AUTHOR_TAIL_RE.sub(" ", s)
    s = _strip_diacritics(s).casefold()
    s = s.replace("&", " and ")
    s = _PUNCT_RE.sub(" ", s)
    s = _WS_RE.sub(" ", s).strip()
    if strip_leading_the and s.startswith("the "):
        s = s[4:]
    return s


def tokens(s, **kw) -> list[str]:
    d = denoise(s, **kw)
    return d.split() if d else []


def _compact(toks: list[str]) -> str:
    return "".join(toks)


def similarity(a, b, *, artist: bool = False) -> float:
    """Token-set similarity in [0, 1]. Dice coefficient over the denoised
    token sets, with a compacted-string equality fold so spelling drift that
    only moves token boundaries ("ACDC" / "AC DC" / "AC/DC", "Greenday" /
    "Green Day") counts as identical."""
    kw = {"strip_leading_the": artist}
    ta, tb = tokens(a, **kw), tokens(b, **kw)
    if not ta or not tb:
        return 0.0
    if _compact(ta) == _compact(tb):
        return 1.0
    sa, sb = set(ta), set(tb)
    return 2.0 * len(sa & sb) / (len(sa) + len(sb))


def _year_int(v):
    try:
        y = int(str(v)[:4])
        return y if y > 0 else None
    except (TypeError, ValueError):
        return None


def _duration_int(v):
    try:
        d = int(round(float(v)))
        return d if d > 0 else None
    except (TypeError, ValueError):
        return None


def score_candidate(song: dict, cand: dict) -> float:
    """Combined confidence that MusicBrainz candidate `cand` is the song the
    chart transcribes. 0.5*artist + 0.5*title, plus small year/duration
    corroboration bonuses, capped at 1.0. Missing fields score 0 on their
    half — classify() separately refuses to auto-match without both."""
    artist_sim = similarity(song.get("artist"), cand.get("artist"), artist=True)
    title_sim = similarity(song.get("title"), cand.get("title"))
    score = 0.5 * artist_sim + 0.5 * title_sim
    sy, cy = _year_int(song.get("year")), _year_int(cand.get("year"))
    if sy and cy and abs(sy - cy) <= 1:
        score += YEAR_BONUS
    sd, cd = _duration_int(song.get("duration")), _duration_int(cand.get("duration"))
    if sd and cd:
        diff = abs(sd - cd)
        if diff <= _DURATION_TIGHT:
            score += DURATION_BONUS
        elif diff <= _DURATION_LOOSE:
            score += DURATION_BONUS_LOOSE
    return min(score, 1.0)


def classify(song: dict, cand: dict, score: float, auto_min: float | None = None) -> str:
    """Tier for a scored candidate: 'auto' | 'review' | 'none'.

    `auto` (tier-2) needs the combined score AND per-field agreement AND
    both fields present — a perfect-title/wrong-artist cover, or a chart
    with no artist at all, is at best a review item, never an auto match.
    `auto_min` overrides the default combined-score threshold (the user's
    "auto-apply confidence" setting); the per-field floors always apply.
    """
    if auto_min is None:
        auto_min = AUTO_MIN
    artist_sim = similarity(song.get("artist"), cand.get("artist"), artist=True)
    title_sim = similarity(song.get("title"), cand.get("title"))
    if (score >= auto_min and artist_sim >= AUTO_ARTIST_MIN
            and title_sim >= AUTO_TITLE_MIN):
        return "auto"
    if score >= REVIEW_MIN:
        return "review"
    return "none"


def rank_candidates(song: dict, candidates: list[dict]) -> list[dict]:
    """Score every candidate against the song and return them sorted by our
    score (MusicBrainz's own search score is only a tiebreak). Each returned
    dict is a copy carrying `score` (rounded — it's displayed and stored)."""
    ranked = []
    for cand in candidates or []:
        c = dict(cand)
        c["score"] = round(score_candidate(song, cand), 4)
        ranked.append(c)
    ranked.sort(key=lambda c: (c["score"], c.get("mb_score") or 0), reverse=True)
    return ranked


# ── MusicBrainz query + response parsing ──────────────────────────────────────

def _lucene_escape_phrase(s: str) -> str:
    """Escape a string for use inside a quoted Lucene phrase."""
    return s.replace("\\", "\\\\").replace('"', '\\"')


def build_recording_query(artist, title, *, loose: bool = False) -> str:
    """Lucene query for /ws/2/recording. Built from the DENOISED fields —
    the noise we strip (author credits, "(Live)", "(v2)") would otherwise
    poison the search server's own scoring.

    ``loose=True`` drops the field-scoped quoted PHRASES for plain AND-ed
    term groups (``(telephone number) AND (junko ohashi)``). The point:
    a field phrase like ``artist:"Junko Ohashi"`` only matches MusicBrainz's
    *primary* artist name — it never searches ALIASES — so a recording stored
    under a non-Latin primary (大橋純子) whose romanized name is only an alias
    is invisible to the strict query. A loose term query searches the whole
    document, aliases included, and surfaces it. Lower precision by design: it
    is a FALLBACK for when the strict query returns nothing, and its results
    are re-scored by ``rank_candidates`` (and, for auto-match, gated by the
    per-field floors), so noise never auto-applies."""
    t = denoise(title)
    a = denoise(artist)
    if loose:
        # denoise() already reduced each field to lowercase [a-z0-9 and] tokens
        # (punctuation → spaces, diacritics stripped, & → "and"), so no
        # Lucene-special character survives to need escaping. Group each field's
        # terms and require both groups.
        return " AND ".join("(%s)" % g for g in (t, a) if g)
    parts = []
    if t:
        parts.append('recording:"%s"' % _lucene_escape_phrase(t))
    if a:
        parts.append('artist:"%s"' % _lucene_escape_phrase(a))
    return " AND ".join(parts)


def _artist_credit(doc: dict) -> tuple[str, str, str]:
    """(display name, artist mbid, sort name) from an artist-credit array."""
    credits = doc.get("artist-credit") or []
    name = ""
    for part in credits:
        if isinstance(part, dict):
            name += str(part.get("name", "")) + str(part.get("joinphrase", "") or "")
        else:  # ws/2 can emit bare join strings in older serializations
            name += str(part)
    first = next((p for p in credits if isinstance(p, dict)), None) or {}
    artist = first.get("artist") or {}
    return name, str(artist.get("id", "") or ""), str(artist.get("sort-name", "") or "")


def _best_release(doc: dict) -> dict:
    """Pick the release used for canon album/year: prefer Official status and
    an Album release-group, then the earliest date. Returns {} if none."""
    releases = [r for r in (doc.get("releases") or []) if isinstance(r, dict)]
    if not releases:
        return {}

    def sort_key(r):
        status_ok = 0 if str(r.get("status", "")).lower() == "official" else 1
        rg = r.get("release-group") or {}
        album_ok = 0 if str(rg.get("primary-type", "")).lower() == "album" else 1
        date = str(r.get("date", "") or "9999")
        return (status_ok, album_ok, date)

    return sorted(releases, key=sort_key)[0]


def _genres(doc: dict, limit: int = 5) -> list[str]:
    """Genre names from a recording doc. Search results carry folksonomy
    `tags`; lookups with inc=genres carry curated `genres`. Both are
    [{name, count}] — take the most-voted few."""
    raw = doc.get("genres") or doc.get("tags") or []
    entries = [e for e in raw if isinstance(e, dict) and e.get("name")]
    entries.sort(key=lambda e: e.get("count") or 0, reverse=True)
    return [str(e["name"]) for e in entries[:limit]]


def parse_recording_doc(doc: dict) -> dict | None:
    """Normalize one /ws/2 recording document (search hit or direct lookup)
    into the flat candidate dict stored in song_enrichment.candidates and
    rendered by the review drawer. Returns None for malformed docs."""
    if not isinstance(doc, dict) or not doc.get("id") or not doc.get("title"):
        return None
    artist_name, artist_id, artist_sort = _artist_credit(doc)
    release = _best_release(doc)
    length = doc.get("length")
    try:
        duration = int(round(float(length) / 1000.0)) if length else None
    except (TypeError, ValueError):
        duration = None
    isrcs = doc.get("isrcs") or []
    isrcs = [str(i) for i in isrcs if isinstance(i, (str,))]
    return {
        "recording_id": str(doc["id"]),
        "title": str(doc.get("title", "")),
        "artist": artist_name,
        "artist_id": artist_id,
        "artist_sort": artist_sort,
        "release_id": str(release.get("id", "") or ""),
        "album": str(release.get("title", "") or ""),
        "year": str(release.get("date", "") or "")[:4],
        "duration": duration,
        "isrc": isrcs[0] if isrcs else "",
        "genres": _genres(doc),
        "mb_score": int(doc.get("score") or 0),
    }


def parse_search_response(body: dict) -> list[dict]:
    """Candidates from a /ws/2/recording search response."""
    docs = (body or {}).get("recordings") or []
    out = []
    for doc in docs:
        cand = parse_recording_doc(doc)
        if cand:
            out.append(cand)
    return out
