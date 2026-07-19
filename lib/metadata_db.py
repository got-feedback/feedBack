"""SQLite metadata cache for the chart library — the `MetadataDB` class and
the query helpers it owns (keyset paging cursors, the tuning grouping key,
smart-arrangement naming, tag normalisation).

Extracted verbatim from ``server.py`` (R3). ``server.py`` still owns the
``meta_db`` singleton; this module only supplies the class, so nothing here
touches config paths at import time — the caller passes ``config_dir`` in.

Logs through the ``feedBack.server`` logger, unchanged from when this code
lived in ``server.py``, so existing log filters and caplog assertions still
resolve to the same logger object.
"""

import contextlib
import hashlib
import json
import logging
import math
import os
import re
import secrets
import sqlite3
import threading
import time
from pathlib import Path

from song import compute_smart_names
from tunings import DEFAULT_PERSPECTIVE, ROLE_PERSPECTIVES
from tunings import perspective as _perspective

log = logging.getLogger("feedBack.server")


# Canonical Tuning-filter grouping key (feedBack#867). tuning_name collapses
# every non-standard tuning to "Custom Tuning"; for those rows we key on the
# raw offsets so distinct customs stay distinct, while named tunings keep
# grouping by name (stable across the offsets-column migration). Used by both
# the tuning-names listing and the filter WHERE so the contract matches.
#
# A non-default PERSPECTIVE (guitar-rhythm / bass) swaps every tuning column
# for its EFFECTIVE expression: that role's indexed tuning when the song has
# such an arrangement, falling back to the guitar-derived song tuning
# otherwise — so a song with no rhythm/bass chart (or a row that predates the
# columns, NULL there) still groups/filters/sorts instead of disappearing.
# guitar-lead reads the original unprefixed columns, so it is byte-identical
# to the historical behaviour.
def _effective_tuning_cols_sql(alias: str, perspective: str = DEFAULT_PERSPECTIVE) -> tuple[str, str, str]:
    """(name_sql, offsets_sql, sort_key_sql) for the given perspective."""
    persp = _perspective(perspective)
    if not persp.column_prefix:
        return (f"{alias}.tuning_name", f"{alias}.tuning_offsets", f"{alias}.tuning_sort_key")
    has_own = f"COALESCE({alias}.{persp.column('name')}, '') != ''"
    return (
        f"COALESCE(NULLIF({alias}.{persp.column('name')}, ''), {alias}.tuning_name)",
        f"CASE WHEN {has_own} THEN {alias}.{persp.column('offsets')} ELSE {alias}.tuning_offsets END",
        f"CASE WHEN {has_own} THEN {alias}.{persp.column('sort_key')} ELSE {alias}.tuning_sort_key END",
    )


def _effective_low_pitch_sql(alias: str, perspective: str = DEFAULT_PERSPECTIVE) -> str:
    """Lowest open-string MIDI pitch under this perspective, with the same
    fallback as the tuning columns — the "playable without retuning"
    comparison reads it (see tunings.chart_is_playable_in)."""
    persp = _perspective(perspective)
    if not persp.column_prefix:
        return f"{alias}.tuning_low_pitch"
    has_own = f"COALESCE({alias}.{persp.column('name')}, '') != ''"
    return (f"CASE WHEN {has_own} THEN {alias}.{persp.column('low_pitch')} "
            f"ELSE {alias}.tuning_low_pitch END")


def _perspective_is_inferred_sql(alias: str, perspective: str) -> str:
    """1 when this row is BORROWING the guitar-derived song tuning because it
    has no chart in the perspective's role. Always 0 for guitar-lead, which is
    never a fallback."""
    persp = _perspective(perspective)
    if not persp.column_prefix:
        return "0"
    return f"(CASE WHEN COALESCE({alias}.{persp.column('name')}, '') = '' THEN 1 ELSE 0 END)"


# ── The custom-tuning group key ──────────────────────────────────────────────
#
# Named tunings group by NAME, which is already serialization-agnostic. Custom
# tunings group on a raw offsets STRING, which is not: the same physical bass
# tuning stored as "-2 0 0 0" and "-2 0 0 0 0 0" would fragment into two facet
# rows with split counts.
#
# For BASS we therefore group customs on `bass_tuning_key` — the tuning's
# absolute open-string PITCHES, computed once at scan time
# (tunings.bass_tuning_key) after the padded tail is truncated away. Pitch is
# the identity that matters musically and it is serialization-independent, so
# one physical tuning is one entry however it was authored. Guitar keeps the
# offsets string (unchanged; six-element guitar arrays are not padded).
#
# The key is built HERE, once, and read by the facet listing, the filter WHERE
# and the grouped member-match alike — a facet row that selected a different
# set than it counted is exactly the bug this shared expression prevents.
def _tuning_group_key_sql(alias: str, perspective: str = DEFAULT_PERSPECTIVE) -> str:
    """The tuning grouping key (name for named tunings, canonical pitches or
    raw offsets for customs) against an explicit table alias — the grouped
    filter law (§7.1) evaluates chart-intrinsic predicates inside a member
    subquery, where bare column names would resolve against the wrong scope."""
    persp = _perspective(perspective)
    name_sql, offsets_sql, _ = _effective_tuning_cols_sql(alias, perspective)
    if persp.column_prefix:
        # Fall back to the offsets string when the canonical key is absent
        # (a fallback row borrowing the guitar tuning, or a row scanned before
        # the key column existed) so a custom never groups under an empty key.
        offsets_sql = (f"COALESCE(NULLIF({alias}.{persp.column('key')}, ''), "
                       f"{offsets_sql})")
    return (f"CASE WHEN {name_sql} = 'Custom Tuning' AND COALESCE({offsets_sql}, '') != '' "
            f"THEN {offsets_sql} ELSE {name_sql} END")


def _put_perspective_value(meta: dict, col: str):
    """Value to store for one per-perspective column on a freshly-scanned row."""
    if col.endswith("_low_pitch"):
        val = meta.get(col)
        return int(val) if isinstance(val, int) else None
    if col.endswith("_sort_key"):
        return int(meta.get(col, 0) or 0)
    return meta.get(col, "") or ""


# ── SQLite metadata cache ─────────────────────────────────────────────────────

def _arrangements_all_bass(raw) -> bool:
    """True when EVERY arrangement on a chart is a bass part (raw ``arrangements``
    JSON, as stored). Mirrors the library grid's card rule: such a chart's tuning
    must be scored against bass base pitches, or a 4-string bass tuning read as
    guitar can false-match a guitarist. A chart with no arrangements is not bass.
    """
    try:
        arrs = json.loads(raw) if raw else []
    except (ValueError, TypeError):
        return False
    if not isinstance(arrs, list) or not arrs:
        return False
    return all(
        isinstance(a, dict) and re.search(r"\bbass\b", str(a.get("name") or ""), re.I)
        for a in arrs
    )


def _ensure_smart_names(arrangements: list[dict]) -> list[dict]:
    """Fill in missing ``smart_name`` fields and sort arrangements by smart order.

    Applied to every library query result so the client always receives
    arrangements in priority order:
      Lead → Alt. Lead [1,2,…] → Bonus Lead [1,2,…]
      → Rhythm → Alt. Rhythm → Bonus Rhythm
      → Bass → Alt. Bass → Bonus Bass → other

    Rows scanned before the smart-naming feature was introduced don't carry a
    ``smart_name`` key.  The background scanner automatically rescans those rows
    to populate the field from authoritative manifest JSON path flags.

    In the meantime this function provides a best-effort on-the-fly computation.
    However, when multiple arrangements share the same name (e.g. two "Combo"
    tracks in a archive that bundles all path flags as zero), name-based inference
    cannot distinguish Lead from Rhythm — so we emit ``smart_name: null`` and
    let the UI fall back to the legacy name until the background rescan corrects
    the row.  Arrangements that already have the field are never modified.
    """
    if not arrangements:
        return arrangements

    # Fill in missing smart_name values.
    if not all("smart_name" in a for a in arrangements):
        # Detect duplicate raw names across ALL arrangements (not just the
        # missing subset).  A duplicate anywhere means the name-based fallback
        # may assign the same smart type a scanned row already owns — emit
        # None for the missing entries and let the legacy name show through
        # until the background rescan corrects them.
        # Coerce to str so a malformed cached row with a list/dict name
        # doesn't blow up the set() conversion (and every query that hits it).
        all_names = [
            a.get("name", "") if isinstance(a.get("name"), str) else str(a.get("name", ""))
            for a in arrangements
        ]
        has_duplicates = len(all_names) != len(set(all_names))
        if has_duplicates:
            for a in arrangements:
                if "smart_name" not in a:
                    a["smart_name"] = None
        else:
            # No duplicates — name-based fallback is safe.
            from song import Arrangement as _ArrCls
            arr_objs = [
                _ArrCls(
                    name=a.get("name", ""),
                    path_lead=a.get("_path_lead", False),
                    path_rhythm=a.get("_path_rhythm", False),
                    path_bass=a.get("_path_bass", False),
                    bonus_arr=a.get("_bonus_arr", False),
                    represent=a.get("_represent", 0),
                )
                for a in arrangements
            ]
            smart = compute_smart_names(arr_objs)
            for a, sn in zip(arrangements, smart):
                if "smart_name" not in a:
                    a["smart_name"] = sn

    # Always sort by smart priority order so the client receives a consistent
    # list regardless of how the DB row was originally stored.
    # _arr_smart_sort_key is defined later in this module but resolved at
    # call-time, so the forward reference is safe.
    arrangements.sort(key=_arr_smart_sort_key)
    return arrangements


def _sqlite_file_integrity_ok(path: Path) -> bool:
    """True if `path` is a SQLite database that opens and passes
    `PRAGMA quick_check`. Used to gate a DB restore so a truncated or
    corrupt snapshot can never overwrite the live library DB."""
    try:
        with open(path, "rb") as f:
            if f.read(16) != b"SQLite format 3\x00":   # cheap header gate, no full read
                return False
    except OSError:
        return False
    conn = None
    try:
        conn = sqlite3.connect(str(path))
        row = conn.execute("PRAGMA quick_check").fetchone()
        return bool(row) and row[0] == "ok"
    except sqlite3.Error:
        return False
    finally:
        if conn is not None:
            conn.close()
        # quick_check on a non-WAL file makes no sidecars, but a malformed
        # file can; sweep them so a probe never litters config_dir.
        for suffix in ("-wal", "-shm"):
            try:
                path.with_name(path.name + suffix).unlink()
            except FileNotFoundError:
                pass


def _apply_pending_db_restore(config_dir: Path) -> None:
    """Swap in a library DB restored from a settings bundle, if one is
    staged. A settings import writes the restored snapshot to
    `web_library.db.restore` rather than over the live DB (the running
    server holds the old file open, and a stale `-wal`/`-shm` could be
    replayed onto a fresh main file → corruption). The swap happens here,
    at startup, BEFORE the connection opens: delete the old DB and its WAL
    sidecars, then rename the staged snapshot into place. The snapshot is a
    fully-checkpointed single file (SQLite online-backup API), so it needs
    no sidecars of its own. Idempotent and a no-op when nothing is staged.

    The staged file is re-validated here before anything is destroyed: a
    restore that fails its integrity check is discarded and the live DB is
    left untouched, so a bad bundle can never brick startup or lose data."""
    pending = config_dir / "web_library.db.restore"
    if not pending.exists():
        return
    if not _sqlite_file_integrity_ok(pending):
        log.error("pending library DB restore failed its integrity check; "
                  "discarding it and keeping the existing database")
        try:
            pending.unlink()
        except FileNotFoundError:
            pass
        return
    for suffix in ("", "-wal", "-shm"):
        try:
            (config_dir / f"web_library.db{suffix}").unlink()
        except FileNotFoundError:
            pass
    os.replace(pending, config_dir / "web_library.db")
    log.info("applied pending library DB restore from settings import")


# ── Keyset (cursor) pagination for the library grid (feedBack#636 item 3) ─────
# Forward-only, O(page) deep paging that doesn't grow with OFFSET. Only simple
# single-column sorts can keyset cleanly (the compound tuning/year sorts fall
# back to OFFSET). Every sort gets a unique `filename` tiebreak so the order is
# TOTAL — which also fixes a latent OFFSET skip/dupe across equal-key rows.
# (column, collate-clause, primary-direction) — tiebreak is always `filename` ASC.
_KEYSET_SORTS = {
    # artist/artist-desc left OUT deliberately: their ORDER BY carries a
    # title secondary (so cards within an artist read alphabetically, like
    # the tree view) which a two-term (value, filename) cursor can't seek
    # correctly — they page by OFFSET, which is measured-trivial at real
    # library sizes. Restore them with a composite sort-key column if
    # 50k-song libraries ever make OFFSET hurt.
    "title": ("title", "COLLATE NOCASE", "ASC"),
    "title-desc": ("title", "COLLATE NOCASE", "DESC"),
    "recent": ("mtime", "", "DESC"),
}
# Index into a query_page row tuple for each keyset column (see the SELECT in
# query_page: filename, title, artist, ... mtime at 9).
_KEYSET_ROW_IDX = {"artist": 2, "title": 1, "mtime": 9}


def _encode_cursor(values: list) -> str:
    import base64
    return base64.urlsafe_b64encode(json.dumps(values).encode("utf-8")).decode("ascii")


def _decode_cursor(cursor: str):
    """Decode an opaque keyset cursor to [sort_value, filename], or None if it's
    malformed (a bad cursor degrades to the first page, never 500s)."""
    import base64
    try:
        out = json.loads(base64.urlsafe_b64decode(cursor.encode("ascii")).decode("utf-8"))
    except (ValueError, TypeError):
        return None
    return out if isinstance(out, list) and len(out) == 2 else None


def _effective_keyset_sort(sort: str, direction: str) -> str:
    """Fold the legacy `dir=desc` toggle into the canonical keyset sort key, so
    the seek/cursor direction matches the ORDER BY that same toggle produces
    (without this, `sort=artist&dir=desc` would seek with `>` against a DESC
    order → gaps/dupes)."""
    if direction == "desc" and sort in ("artist", "title"):
        return sort + "-desc"
    return sort


def _keyset_seek(col: str, collate: str, primary_dir: str, cv, fn: str):
    """(sql, params) for 'rows strictly after (cv, fn)' in the total order
    `<col> <primary_dir>, filename ASC`, matching SQLite's NULL placement
    (NULLs sort first in ASC, last in DESC) so keyset is exactly OFFSET-
    equivalent even for NULL sort keys."""
    ce = f"{col} {collate}".strip()
    if primary_dir == "ASC":   # NULLs first
        if cv is None:
            return (f"(({col} IS NULL AND filename > ?) OR {col} IS NOT NULL)", [fn])
        return (f"({col} IS NOT NULL AND ({ce} > ? OR ({ce} = ? AND filename > ?)))",
                [cv, cv, fn])
    # DESC — NULLs last
    if cv is None:
        return (f"({col} IS NULL AND filename > ?)", [fn])
    return (f"({col} IS NULL OR ({col} IS NOT NULL AND "
            f"({ce} < ? OR ({ce} = ? AND filename > ?))))", [cv, cv, fn])


def next_library_cursor(sort: str, last_song: dict | None) -> str | None:
    """The cursor for the last row of a page, so the next request resumes after
    it. None when the sort can't keyset or the page was empty."""
    if sort not in _KEYSET_SORTS or not last_song:
        return None
    col = _KEYSET_SORTS[sort][0]
    key = "mtime" if col == "mtime" else col
    if key not in last_song or "filename" not in last_song:
        return None
    # A title display-override (Fix-metadata popup) replaces last_song["title"]
    # for the card, but the keyset seek runs on the RAW title column — resume
    # from the raw value query_page stashed (present only when the last row's
    # title was overridden), so paging never skips/dupes.
    val = (last_song["_sort_title"] if (key == "title" and "_sort_title" in last_song)
           else last_song[key])
    return _encode_cursor([val, last_song["filename"]])


# Song-level "mastered" threshold — best accuracy across a song's arrangements
# at/above this counts as in your repertoire. One number shared by the green
# accuracy badge, the Repertoire meter, the mastery filter/sort, and the P3
# growth-edge recommender (matches the frontend MASTERY_ACCURACY).
MASTERY_ACCURACY = 0.9


_SMART_TYPE_BASE: dict[str, int] = {"Lead": 0, "Rhythm": 10, "Bass": 20}


def _arr_smart_sort_key(entry: dict) -> tuple[int, int]:
    """Sort key for arrangement entries ordered by smart naming priority.

    Order: Lead → Alt. Lead [1,2,…] → Bonus Lead [1,2,…]
           → Rhythm → Alt. Rhythm → Bonus Rhythm
           → Bass → Alt. Bass → Bonus Bass → other (stable fallback)
    """
    sn = entry.get("smart_name")
    if not sn:
        return (99, 0)
    for label, base in _SMART_TYPE_BASE.items():
        if sn == label:
            return (base, 0)
        alt_prefix = f"Alt. {label}"
        if sn == alt_prefix:
            return (base + 1, 0)
        if sn.startswith(alt_prefix + " "):
            suffix = sn[len(alt_prefix) + 1:]
            return (base + 1, int(suffix) if suffix.isdigit() else 0)
        bonus_prefix = f"Bonus {label}"
        if sn == bonus_prefix:
            return (base + 2, 0)
        if sn.startswith(bonus_prefix + " "):
            suffix = sn[len(bonus_prefix) + 1:]
            return (base + 2, int(suffix) if suffix.isdigit() else 0)
    return (99, 0)


# Strips a trailing tag parenthetical from a filename stem — "(440Hz)",
# "(Live)", "(No Lead)", the retune/arrangement noise CDLC names carry.
_FN_TAG_RE = re.compile(r"\s*\([^)]*\)")


def _artist_title_from_filename(filename: str) -> dict | None:
    """Derive artist + title from the CDLC filename convention
    'Artist_Song-Title_v1_p.feedpak' — spaces written as hyphens WITHIN a
    field, underscores separating Artist | Title | version/arrangement. Used
    ONLY as a match SEED for packs whose own `artist` field is blank (a large
    slice of community charts): text search needs an artist, and the filename
    reliably carries it. This never becomes displayed metadata — the shown
    values still come from the confirmed MusicBrainz match (provenance
    'matched'), so nothing estimated is presented as author-set; if no match is
    found, the pack stays exactly as-is. Returns None when the name doesn't fit
    the convention (so a non-CDLC pack falls through untouched)."""
    base = filename.replace("\\", "/").rsplit("/", 1)[-1]
    base = base.rsplit(".", 1)[0]                 # drop the extension
    base = _FN_TAG_RE.sub("", base).strip()       # drop "(440Hz)" etc.
    parts = [p for p in base.split("_") if p]
    if len(parts) < 2:
        return None
    artist = parts[0].replace("-", " ").strip()
    title = parts[1].replace("-", " ").strip()
    if not artist or not title:
        return None
    return {"artist": artist, "title": title}


def _normalize_tag(tag) -> str:
    """Canonical form for a personal practice tag: trimmed, lowercased,
    internal whitespace collapsed, length-capped. Lowercasing is what keeps
    "Rock"/"rock" from splitting into two tags. Non-strings → ''."""
    if not isinstance(tag, str):
        return ""
    return " ".join(tag.strip().lower().split())[:60]


def _as_int(value) -> int:
    """Coerce a JSON value to an int, REJECTING bool and non-integral numbers
    so e.g. 1.9 / True don't silently truncate to 1. Accepts ints, integral
    floats (1.0), and integer-shaped strings ("5"); raises ValueError otherwise."""
    if isinstance(value, bool):
        raise ValueError("bool is not an integer")
    if isinstance(value, int):
        return value
    if isinstance(value, float):
        if not math.isfinite(value) or not value.is_integer():
            raise ValueError("non-integral float")
        return int(value)
    if isinstance(value, str):
        return int(value)   # int("5") ok; int("1.9")/"nan"/"inf" raise ValueError
    raise ValueError("not an integer")


class MetadataDB:
    def __init__(self, config_dir: Path):
        config_dir.mkdir(parents=True, exist_ok=True)
        _apply_pending_db_restore(config_dir)
        self.db_path = str(config_dir / "web_library.db")
        self.conn = sqlite3.connect(self.db_path, check_same_thread=False)
        self.conn.execute("PRAGMA journal_mode=WAL")
        self.conn.execute("""
            CREATE TABLE IF NOT EXISTS songs (
                filename TEXT PRIMARY KEY,
                mtime REAL,
                size INTEGER,
                title TEXT,
                artist TEXT,
                album TEXT,
                year TEXT,
                duration REAL,
                tuning TEXT,
                arrangements TEXT,
                has_lyrics INTEGER DEFAULT 0,
                format TEXT DEFAULT 'archive',
                stem_count INTEGER DEFAULT 0,
                stem_ids TEXT DEFAULT '[]',
                tuning_name TEXT DEFAULT '',
                tuning_sort_key INTEGER DEFAULT 0,
                tuning_offsets TEXT DEFAULT '',
                genre TEXT DEFAULT '',
                track_number INTEGER,
                disc INTEGER,
                bass_tuning_name TEXT,
                bass_tuning_sort_key INTEGER,
                bass_tuning_offsets TEXT,
                bass_tuning_key TEXT,
                bass_tuning_low_pitch INTEGER,
                rhythm_tuning_name TEXT,
                rhythm_tuning_sort_key INTEGER,
                rhythm_tuning_offsets TEXT,
                rhythm_tuning_key TEXT,
                rhythm_tuning_low_pitch INTEGER,
                tuning_low_pitch INTEGER
            )
        """)
        # Idempotent migrations for installs that predate each column.
        for ddl in (
            "ALTER TABLE songs ADD COLUMN format TEXT DEFAULT 'archive'",
            "ALTER TABLE songs ADD COLUMN stem_count INTEGER DEFAULT 0",
            # feedBack#129: per-stem filter needs the id list, not just count.
            "ALTER TABLE songs ADD COLUMN stem_ids TEXT DEFAULT '[]'",
            # feedBack#69 + #22: denormalized canonical tuning name + numeric
            # sort key (sum of offsets). The existing `tuning` text column
            # stays — these are caches, repopulated on rescan.
            "ALTER TABLE songs ADD COLUMN tuning_name TEXT DEFAULT ''",
            "ALTER TABLE songs ADD COLUMN tuning_sort_key INTEGER DEFAULT 0",
            # feedBack#867: raw per-string offsets (space-joined ints) so the
            # v3 client can render target notes and the Tuning filter can keep
            # distinct custom tunings distinct (tuning_name collapses them all
            # to "Custom Tuning"). Cache; repopulated on rescan.
            "ALTER TABLE songs ADD COLUMN tuning_offsets TEXT DEFAULT ''",
            # Primary genre from the feedpak `genres` list (spec 1.12.0). Cache;
            # repopulated on rescan.
            "ALTER TABLE songs ADD COLUMN genre TEXT DEFAULT ''",
            # Album track order from the feedpak `track`/`disc` fields (spec
            # 1.12.0). NULL when the pack doesn't author them; the album view
            # falls back to title order. Cache; repopulated on rescan.
            "ALTER TABLE songs ADD COLUMN track_number INTEGER",
            "ALTER TABLE songs ADD COLUMN disc INTEGER",
            # Bass-arrangement tuning (the KwasimodoZAZA report): the song-level
            # tuning columns above are guitar-first, so the library filter lied
            # to bass players when the bass chart is tuned differently. Caches;
            # repopulated on rescan. NULL (no literal default) is deliberate —
            # it marks a pre-migration row the scanner must re-extract, while
            # '' means "extracted, song has no bass arrangement" (see scan.py).
            "ALTER TABLE songs ADD COLUMN bass_tuning_name TEXT",
            "ALTER TABLE songs ADD COLUMN bass_tuning_sort_key INTEGER",
            "ALTER TABLE songs ADD COLUMN bass_tuning_offsets TEXT",
            # Canonical grouping key: the bass tuning's absolute open-string
            # pitches. Keyed on PITCH, not the serialization-dependent offsets
            # string, so one physical tuning is one facet entry however it was
            # stored. See tunings.bass_tuning_key.
            "ALTER TABLE songs ADD COLUMN bass_tuning_key TEXT",
            # Lowest open-string MIDI pitch per perspective — the "playable
            # without retuning" comparison (tunings.chart_is_playable_in).
            "ALTER TABLE songs ADD COLUMN bass_tuning_low_pitch INTEGER",
            "ALTER TABLE songs ADD COLUMN tuning_low_pitch INTEGER",
            # The RHYTHM chart's own tuning: lead and rhythm arrangements can
            # be tuned differently, which is the same bug a bassist hit,
            # inside guitar. Same NULL-vs-'' contract as the bass family.
            "ALTER TABLE songs ADD COLUMN rhythm_tuning_name TEXT",
            "ALTER TABLE songs ADD COLUMN rhythm_tuning_sort_key INTEGER",
            "ALTER TABLE songs ADD COLUMN rhythm_tuning_offsets TEXT",
            "ALTER TABLE songs ADD COLUMN rhythm_tuning_key TEXT",
            "ALTER TABLE songs ADD COLUMN rhythm_tuning_low_pitch INTEGER",
        ):
            try:
                self.conn.execute(ddl)
            except sqlite3.OperationalError:
                pass
        self.conn.execute("CREATE INDEX IF NOT EXISTS idx_songs_artist ON songs(artist COLLATE NOCASE)")
        self.conn.execute("CREATE INDEX IF NOT EXISTS idx_songs_title ON songs(title COLLATE NOCASE)")
        # Composite (sort col, filename) indexes cover the grid's ORDER BY +
        # its unique filename tiebreak — for both the OFFSET scan and keyset
        # seek (feedBack#636 item 3). idx_songs_artist/title above stay for the
        # distinct-artist / letter-bar aggregates.
        self.conn.execute("CREATE INDEX IF NOT EXISTS idx_songs_artist_fn ON songs(artist COLLATE NOCASE, filename)")
        self.conn.execute("CREATE INDEX IF NOT EXISTS idx_songs_title_fn ON songs(title COLLATE NOCASE, filename)")
        self.conn.execute("CREATE INDEX IF NOT EXISTS idx_songs_mtime_fn ON songs(mtime, filename)")
        self.conn.execute("CREATE INDEX IF NOT EXISTS idx_songs_tuning_name ON songs(tuning_name COLLATE NOCASE)")
        self.conn.execute("CREATE INDEX IF NOT EXISTS idx_songs_genre ON songs(genre COLLATE NOCASE)")
        self.conn.execute("CREATE INDEX IF NOT EXISTS idx_songs_tuning_sort_key ON songs(tuning_sort_key)")
        self.conn.execute("CREATE INDEX IF NOT EXISTS idx_songs_year ON songs(year)")
        self.conn.execute("CREATE TABLE IF NOT EXISTS favorites (filename TEXT PRIMARY KEY)")
        # Personal, per-song metadata that must NEVER travel in the shared
        # feedpak file: a light 1–5 user-difficulty (planning only — distinct
        # from the authored 1–10 difficulty bands) + freeform notes. Likes are
        # NOT here — they stay the existing `favorites` heart (Christian's call).
        # A SEPARATE table (not `songs` columns) so a rescan's
        # `INSERT OR REPLACE INTO songs` can't wipe it; keyed by the same on-disk
        # filename as every other personal table. Additive + idempotent.
        self.conn.execute("""
            CREATE TABLE IF NOT EXISTS song_user_meta (
                filename TEXT PRIMARY KEY,
                user_difficulty INTEGER,   -- 1..5, NULL = unset
                notes TEXT,
                updated_at TEXT
            )
        """)
        # Free-form personal practice tags ("warm-ups", "riffs to nail") — an
        # intent practice-set primitive (Play-all-over-a-tag comes later). Tags
        # are normalized lowercase on write so "Rock"/"rock" don't split. Peer
        # of song_user_meta; same never-clobber rationale.
        self.conn.execute("""
            CREATE TABLE IF NOT EXISTS song_tags (
                filename TEXT NOT NULL,
                tag TEXT NOT NULL,
                created_at TEXT,
                PRIMARY KEY (filename, tag)
            )
        """)
        self.conn.execute("CREATE INDEX IF NOT EXISTS idx_song_tags_tag ON song_tags(tag COLLATE NOCASE)")
        # Per-field metadata OVERRIDES + LOCKS (the Fix-metadata popup). A
        # reversible DISPLAY overlay, never written to the pack: `value` is the
        # user's corrected value for a catalog field (title/artist/album/year/
        # genre), `locked=1` pins the field so a metadata refresh / auto-match
        # never changes what's shown for it (Plex-style field lock). Effective
        # display value = override → matched-MusicBrainz → pack → derived.
        # Filename-keyed → purged with the song on delete_song, NEVER on a
        # rescan (delete_missing), so an edit survives re-import like every other
        # local layer.
        self.conn.execute("""
            CREATE TABLE IF NOT EXISTS song_field_override (
                filename TEXT NOT NULL,
                field TEXT NOT NULL,        -- title|artist|album|year|genre
                value TEXT,                 -- corrected value (NULL = lock only, no override)
                locked INTEGER NOT NULL DEFAULT 0,
                updated_at TEXT,
                PRIMARY KEY (filename, field)
            )
        """)
        self.conn.execute("CREATE INDEX IF NOT EXISTS idx_field_override_fn ON song_field_override(filename)")
        # Artist-name aliases (P4): "ACDC" → "AC/DC", "the beatles" → "The Beatles".
        # A CANONICALIZATION OVERRIDE applied AT DISPLAY only — the scanner-derived
        # `songs.artist` and the feedpak files are never rewritten (a rescan can't
        # fight the user; one alias row fixes every matching song at once). Keyed by
        # the raw artist string (COLLATE NOCASE so case variants collapse), so it is
        # NOT filename-keyed → never touched by delete_missing/delete_song (an alias
        # outlives the songs that motivated it, ready for re-import). mb_artist_id is
        # reserved for a future confident MusicBrainz match (unused now).
        self.conn.execute("""
            CREATE TABLE IF NOT EXISTS artist_alias (
                raw_name TEXT PRIMARY KEY COLLATE NOCASE,
                canonical_name TEXT NOT NULL,
                mb_artist_id TEXT,
                updated_at TEXT
            )
        """)
        # ── Multi-chart grouping (P5a) ───────────────────────────────────────
        # A "work" is a song that may be charted by several feedpaks; each chart
        # stays its own `songs` row (unchanged), but they GROUP under a shared
        # work_key = normalize(artist+title). Two sparse, never-purged-on-rescan
        # override tables + one MATERIALIZED read-model so the grid can group
        # server-side without a query-time GROUP BY (which would kill the keyset
        # seek / A–Z / virtualization — see query_page).
        #
        # chart_group_pref: your chosen "keeper" chart per work (sparse; unset ⇒
        # auto-pick). Keyed by work_key, NOT filename, so it survives a chart's
        # rescan; an orphaned preferred (file gone) degrades to auto-pick.
        self.conn.execute("""
            CREATE TABLE IF NOT EXISTS chart_group_pref (
                work_key TEXT PRIMARY KEY,
                preferred_filename TEXT NOT NULL,
                updated_at TEXT
            )
        """)
        # chart_group_split: "these aren't the same song" escape hatch — a chart
        # gets its own unique split_key so it stands alone as a singleton work.
        # Filename-keyed → purged with the song on delete_song.
        self.conn.execute("""
            CREATE TABLE IF NOT EXISTS chart_group_split (
                filename TEXT PRIMARY KEY,
                split_key TEXT NOT NULL,
                updated_at TEXT
            )
        """)
        # work_display: the MATERIALIZED representative-filter read-model, rebuilt
        # from songs + the two override tables. One row per song:
        #   effective_work_key    = split_key if split else work_key
        #   is_group_representative = 1 for the keeper (pref or auto-pick) of a work
        #   group_size            = the ⚑ N charts in the work
        # Grouping-ON is then just `WHERE is_group_representative = 1` (keyset-safe).
        # A derived cache: filename-keyed, rebuilt on demand (dirty flag) — safe to
        # drop/rebuild, so it's purged on delete and re-materialized after a scan.
        self.conn.execute("""
            CREATE TABLE IF NOT EXISTS work_display (
                filename TEXT PRIMARY KEY,
                work_key TEXT NOT NULL,
                effective_work_key TEXT NOT NULL,
                is_group_representative INTEGER NOT NULL DEFAULT 1,
                group_size INTEGER NOT NULL DEFAULT 1
            )
        """)
        self.conn.execute("CREATE INDEX IF NOT EXISTS idx_work_display_rep ON work_display(is_group_representative)")
        self.conn.execute("CREATE INDEX IF NOT EXISTS idx_work_display_eff ON work_display(effective_work_key)")
        self.conn.execute("CREATE INDEX IF NOT EXISTS idx_work_display_wk ON work_display(work_key)")
        self.conn.execute("""
            CREATE TABLE IF NOT EXISTS loops (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                filename TEXT NOT NULL,
                name TEXT NOT NULL,
                start_time REAL NOT NULL,
                end_time REAL NOT NULL,
                created_at TEXT DEFAULT (datetime('now'))
            )
        """)
        # fee[dB]ack v0.3.0 — single-user player profile (id=1), streak, and the
        # unified XP store. Peers of favorites/loops; additive + idempotent.
        # `player_hash` is a future-leaderboard identity label (SHA-256 of the
        # first display name + a once-generated salt), never an auth credential.
        self.conn.execute("""
            CREATE TABLE IF NOT EXISTS profile (
                id INTEGER PRIMARY KEY CHECK (id = 1),
                display_name TEXT,
                avatar_path TEXT,
                player_hash TEXT,
                player_salt TEXT,
                onboarded INTEGER NOT NULL DEFAULT 0,
                created_at TEXT
            )
        """)
        self.conn.execute("""
            CREATE TABLE IF NOT EXISTS profile_progress (
                id INTEGER PRIMARY KEY CHECK (id = 1),
                current_streak INTEGER NOT NULL DEFAULT 0,
                best_streak INTEGER NOT NULL DEFAULT 0,
                last_active_date TEXT          -- YYYY-MM-DD (local)
            )
        """)
        # Unified XP store: the single source of truth the profile badge reads.
        # Song-play, minigames, and tutorials all feed THIS via award_xp() — no
        # second XP curve (lib/xp.py owns the math).
        self.conn.execute("""
            CREATE TABLE IF NOT EXISTS xp_profile (
                id INTEGER PRIMARY KEY CHECK (id = 1),
                xp INTEGER NOT NULL DEFAULT 0,
                total_awards INTEGER NOT NULL DEFAULT 0,
                minigames_seeded INTEGER NOT NULL DEFAULT 0,
                updated_at TEXT
            )
        """)
        # Per-source XP ledger: the unified `xp` total above is a single number,
        # but a source (minigames, tutorials, song-play, …) needs to know its own
        # contribution so it can be reset/reversed independently (a minigames
        # profile-reset must subtract only its share, not song-play XP).
        self.conn.execute("""
            CREATE TABLE IF NOT EXISTS xp_sources (
                source TEXT PRIMARY KEY,
                xp INTEGER NOT NULL DEFAULT 0
            )
        """)
        # Per-song/arrangement practice stats (best score + accuracy, plays,
        # last position for Continue-Playing). Fed by the highway note-detection
        # scorer via POST /api/stats. Additive + idempotent; a 0.2.9 build
        # tolerates it and the new build opens an old db without it.
        self.conn.execute("""
            CREATE TABLE IF NOT EXISTS song_stats (
                filename TEXT NOT NULL,
                arrangement INTEGER NOT NULL DEFAULT 0,
                plays INTEGER NOT NULL DEFAULT 0,
                best_score INTEGER NOT NULL DEFAULT 0,
                best_accuracy REAL NOT NULL DEFAULT 0,
                last_score INTEGER NOT NULL DEFAULT 0,
                last_accuracy REAL NOT NULL DEFAULT 0,
                last_position REAL NOT NULL DEFAULT 0,
                last_played_at TEXT,
                updated_at TEXT,
                PRIMARY KEY (filename, arrangement)
            )
        """)
        self.conn.execute("CREATE INDEX IF NOT EXISTS idx_song_stats_recent ON song_stats(last_played_at DESC)")
        # Cumulative wall-clock play time (career "hours in genre" odometer).
        # Fed by the same POST /api/stats the recorder already sends; additive
        # + idempotent like every other song_stats change.
        try:
            self.conn.execute(
                "ALTER TABLE song_stats ADD COLUMN seconds_total REAL NOT NULL DEFAULT 0")
        except sqlite3.OperationalError:
            pass
        # Playlists + the reserved "Saved for Later" system playlist. Additive.
        self.conn.execute("""
            CREATE TABLE IF NOT EXISTS playlists (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                name TEXT NOT NULL,
                system_key TEXT,            -- 'saved_for_later' for reserved playlists, else NULL
                created_at TEXT,
                updated_at TEXT
            )
        """)
        self.conn.execute("""
            CREATE TABLE IF NOT EXISTS playlist_songs (
                playlist_id INTEGER NOT NULL,
                filename TEXT NOT NULL,
                position INTEGER NOT NULL DEFAULT 0,
                PRIMARY KEY (playlist_id, filename)
            )
        """)
        self.conn.execute("CREATE UNIQUE INDEX IF NOT EXISTS idx_playlists_system_key ON playlists(system_key) WHERE system_key IS NOT NULL")
        # Smart collections (feedBack#636 item 2): a playlist row whose `rules`
        # JSON is non-NULL is a smart/dynamic collection — its membership is the
        # LIVE result of those library filter params, not a stored song list.
        # It surfaces as a registered library provider (the v3 source picker),
        # so it inherits the whole Songs UI. Additive, idempotent migration.
        try:
            self.conn.execute("ALTER TABLE playlists ADD COLUMN rules TEXT")
        except sqlite3.OperationalError:
            pass
        # Curated album (P6, metadata-design §7.2): a playlists row with
        # kind='album' is a hand-picked, ORDERED practice set of works with a
        # chosen chart per slot — the repeatable gameplay loop. Reuses the
        # playlist machinery wholesale (membership/order/cover/queue); the whole
        # schema delta is this `kind` discriminator plus two per-slot columns:
        # `arrangement` = the pinned arrangement NAME (names survive rescans;
        # the client resolves name→index at play), `work_key` = stamped at
        # add-time so a slot whose pinned chart is later deleted can self-heal
        # to the work's CURRENT preferred at read (never rewritten). Additive,
        # idempotent — same pattern as `rules` above.
        for _ddl in ("ALTER TABLE playlists ADD COLUMN kind TEXT",
                     "ALTER TABLE playlist_songs ADD COLUMN arrangement TEXT",
                     "ALTER TABLE playlist_songs ADD COLUMN work_key TEXT"):
            try:
                self.conn.execute(_ddl)
            except sqlite3.OperationalError:
                pass
        # Manual playlist ordering (tester ask): `position` orders the
        # PLAYLISTS themselves (playlist_songs.position orders songs within
        # one). NULL = unpositioned — those sort alphabetically AFTER the
        # manually positioned ones, and system playlists stay pinned first
        # regardless (see list_playlists). Additive, idempotent — same
        # pattern as `rules`/`kind` above.
        try:
            self.conn.execute("ALTER TABLE playlists ADD COLUMN position INTEGER")
        except sqlite3.OperationalError:
            pass
        # Wishlist / "wanted" (feedBack#636 item 4): a persisted, actionable
        # list of songs the user does NOT own yet — the *arr "Wanted/Monitored"
        # analogue. Unlike playlists (which reference owned local songs by
        # filename), a wanted entry has no local file, so it lives in its own
        # table keyed by descriptive identity. Producers (the find_more plugin's
        # ownership-diff, or a manual add) POST here; the consuming UI reads it.
        # Additive + idempotent.
        self.conn.execute("""
            CREATE TABLE IF NOT EXISTS wanted (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                artist TEXT NOT NULL DEFAULT '',
                title TEXT NOT NULL DEFAULT '',
                source TEXT NOT NULL DEFAULT '',      -- e.g. 'find_more', 'manual'
                source_ref TEXT NOT NULL DEFAULT '',  -- opaque id/url within that source
                note TEXT NOT NULL DEFAULT '',
                created_at TEXT
            )
        """)
        # Identity = (artist, title, source, source_ref), case-insensitive on
        # the human fields, so re-running an ownership-diff doesn't duplicate.
        self.conn.execute(
            "CREATE UNIQUE INDEX IF NOT EXISTS idx_wanted_identity "
            "ON wanted(artist COLLATE NOCASE, title COLLATE NOCASE, source, source_ref)"
        )
        # Metadata-enrichment cache (P7, library-metadata design §4/§5/§6): one
        # row per song holding its match lifecycle + the canonical values a
        # confident match supplies. A CACHE/OVERRIDE layer — canonical values
        # are displayed, NEVER auto-written into the pack file. Never purged on
        # rescan (only by the explicit per-song delete); re-derivable, so a lost
        # row just re-enriches. `content_hash` keys the row to the metadata a
        # match depends on (normalized artist|title|album|duration — NOT the
        # filename), which makes enrichment idempotent AND rename-survivable.
        # match_state lifecycle: unscanned → matched(source,score) | manual |
        # failed. A `manual` row is the user's pinned pick — NEVER auto-reset;
        # `failed` retries on backoff via `attempts` (the matcher, P8, owns
        # that policy). Additive + idempotent.
        self.conn.execute("""
            CREATE TABLE IF NOT EXISTS song_enrichment (
                filename TEXT PRIMARY KEY,
                content_hash TEXT,
                match_state TEXT NOT NULL DEFAULT 'unscanned',
                match_source TEXT,
                match_score REAL,
                attempts INTEGER NOT NULL DEFAULT 0,
                mb_recording_id TEXT,
                mb_release_id TEXT,
                mb_artist_id TEXT,
                isrc TEXT,
                canon_artist TEXT,
                canon_album TEXT,
                canon_title TEXT,
                canon_year TEXT,
                canon_artist_sort TEXT,
                genres TEXT,
                art_cache_path TEXT,
                art_state TEXT,
                fetched_at TEXT
            )
        """)
        self.conn.execute("CREATE INDEX IF NOT EXISTS idx_enrichment_hash ON song_enrichment(content_hash)")
        self.conn.execute("CREATE INDEX IF NOT EXISTS idx_enrichment_state ON song_enrichment(match_state)")
        # P8 (the matcher): `candidates` holds the review tier's ranked
        # candidate list (JSON) so the Match-Review drawer never re-queries
        # MusicBrainz just to render; `last_attempt_at` anchors the failed-row
        # retry backoff (epoch seconds). Idempotent ALTERs, same pattern as
        # the `songs` migrations above.
        # R1 scraper options: `apply_mask` records which per-field auto-apply
        # toggles were OFF (suppressed) when an AUTOMATIC match settled the row,
        # as a canonical sorted comma-joined marker of blocked keys (''/NULL =
        # nothing suppressed). It keeps the per-field toggles to the same
        # "nothing forfeited" contract as the source/art toggles: re-enabling a
        # field re-queues affected `matched` rows for backfill (enrichment_pending)
        # and a partially-applied row is barred from seeding siblings
        # (enrichment_cache_lookup). Idempotent ALTER, same pattern as above.
        for ddl in (
            "ALTER TABLE song_enrichment ADD COLUMN candidates TEXT",
            "ALTER TABLE song_enrichment ADD COLUMN last_attempt_at REAL",
            "ALTER TABLE song_enrichment ADD COLUMN apply_mask TEXT",
        ):
            try:
                self.conn.execute(ddl)
            except sqlite3.OperationalError:
                pass
        # Artist-level enrichment cache (artist pages, launch charrette §5):
        # ONE row per matched MusicBrainz artist holding the whitelisted
        # url-relations (external links) + MB genres from a single throttled
        # artist lookup, fetched lazily on the first artist-page links request
        # and refreshed only on demand. Keyed by mb_artist_id (NOT the display
        # name), so alias merges / renames never orphan it. Never purged on
        # rescan — like song_enrichment, it is re-derivable but expensive
        # (rate-limited) to re-fetch. Additive + idempotent.
        self.conn.execute("""
            CREATE TABLE IF NOT EXISTS artist_enrichment (
                mb_artist_id TEXT PRIMARY KEY,
                url_rels TEXT,
                genres TEXT,
                fetched_at TEXT
            )
        """)
        # Progression (spec 010): instrument paths, challenges, quests, the
        # Decibels wallet, and the cosmetics shop. Targets/titles live in the
        # bundled content (data/progression/); these tables hold only player
        # state (counters, completion timestamps, spend, ownership) so content
        # edits update live displays without migrations. Additive + idempotent.
        self.conn.execute("""
            CREATE TABLE IF NOT EXISTS progression_state (
                id INTEGER PRIMARY KEY CHECK (id = 1),
                calibration_status TEXT NOT NULL DEFAULT 'pending',  -- pending|completed|skipped
                calibration_completed_at TEXT,
                created_at TEXT
            )
        """)
        self.conn.execute("""
            CREATE TABLE IF NOT EXISTS player_paths (
                path_id TEXT PRIMARY KEY,          -- 'guitar' | 'bass' | 'drums' | future
                level INTEGER NOT NULL DEFAULT 0,
                selected_at TEXT
            )
        """)
        self.conn.execute("""
            CREATE TABLE IF NOT EXISTS challenge_progress (
                challenge_id TEXT PRIMARY KEY,     -- namespaced 'guitar.l1.clean-run'
                path_id TEXT NOT NULL,
                level INTEGER NOT NULL,            -- the level whose set this belongs to
                count INTEGER NOT NULL DEFAULT 0,
                progress_detail TEXT,              -- JSON, e.g. {"seen": [...]} for distinct goals
                completed_at TEXT
            )
        """)
        self.conn.execute("""
            CREATE TABLE IF NOT EXISTS quest_state (
                period_type TEXT NOT NULL,         -- 'daily' | 'weekly'
                period_key TEXT NOT NULL,          -- '2026-06-12' | '2026-W24'
                quest_id TEXT NOT NULL,
                count INTEGER NOT NULL DEFAULT 0,
                reward_db INTEGER NOT NULL DEFAULT 0,  -- snapshot at instantiation
                progress_detail TEXT,
                completed_at TEXT,
                PRIMARY KEY (period_type, period_key, quest_id)
            )
        """)
        # Spend is tracked separately from xp_profile.xp on purpose: the xp
        # total stays the monotonic lifetime-earned stat (db_earned goals,
        # xp_sources reset semantics) and balance = MAX(0, xp - spent).
        self.conn.execute("""
            CREATE TABLE IF NOT EXISTS wallet (
                id INTEGER PRIMARY KEY CHECK (id = 1),
                spent INTEGER NOT NULL DEFAULT 0
            )
        """)
        self.conn.execute("""
            CREATE TABLE IF NOT EXISTS shop_owned (
                item_id TEXT PRIMARY KEY,
                cost_paid INTEGER NOT NULL DEFAULT 0,
                acquired_at TEXT
            )
        """)
        self.conn.execute("""
            CREATE TABLE IF NOT EXISTS shop_equipped (
                slot TEXT PRIMARY KEY,             -- 'theme' | 'avatar_frame'
                item_id TEXT
            )
        """)
        # Ensure the singleton rows exist so reads never special-case "no row".
        self.conn.execute("INSERT OR IGNORE INTO profile (id, onboarded, created_at) VALUES (1, 0, datetime('now'))")
        self.conn.execute("INSERT OR IGNORE INTO profile_progress (id) VALUES (1)")
        self.conn.execute("INSERT OR IGNORE INTO xp_profile (id, xp, total_awards, updated_at) VALUES (1, 0, 0, datetime('now'))")
        self.conn.execute("INSERT OR IGNORE INTO progression_state (id, created_at) VALUES (1, datetime('now'))")
        self.conn.execute("INSERT OR IGNORE INTO wallet (id) VALUES (1)")
        self.conn.commit()
        self._lock = threading.Lock()
        # work_display (P5a) is a derived cache; True forces a (re)build on the
        # first grouped query and after any songs churn (put / delete / rescan).
        self._work_display_dirty = True
        # One-time repair of pre-fix rows written under URL-encoded filenames
        # (idempotent: a no-op once every row is canonical).
        self._migrate_decode_stat_filenames()

    def _song_exists(self, filename: str) -> bool:
        return self.conn.execute(
            "SELECT 1 FROM songs WHERE filename = ?", (filename,)).fetchone() is not None

    def _canonical_song_filename(self, filename: str) -> str:
        """Map a (possibly URL-encoded) filename to the `songs` library key.

        The recorder relays encodeURIComponent'd names ('/'→'%2F', ' '→'%20'),
        but `songs` keys on the decoded on-disk path. Decoding is LIBRARY-AWARE so
        a real filename that legitimately contains literal %XX is never corrupted:
        prefer the form that already exists in `songs`, and decode only when the
        decoded form resolves to a real song. When NEITHER form is in the library
        (e.g. a play recorded before the library scan finishes) keep the stored
        name unchanged — the next-startup migration canonicalizes it once the song
        is scanned, rather than risk corrupting a real %XX name now."""
        if not isinstance(filename, str):
            return filename
        if self._song_exists(filename):
            return filename                      # already a real library key (may contain %)
        from urllib.parse import unquote
        decoded = unquote(filename)
        if decoded != filename and self._song_exists(decoded):
            return decoded                       # encoded → real library key
        return filename                          # neither in library: leave as-is (heals on migrate)

    def _migrate_decode_stat_filenames(self):
        """Rewrite URL-encoded song_stats.filename rows to the decoded
        library-path key (the form `songs` uses). Pre-fix, the recorder stored
        encodeURIComponent'd names, so every recorded best was invisible to the
        reads that filter on `filename IN (SELECT filename FROM songs)`. Merge on
        collision — two encoded rows decoding to the same name, or an encoded row
        meeting an already-decoded one — with the same best=max / plays=sum /
        last-wins semantics as song_score.merge_stats, so the (filename,
        arrangement) primary key is never violated.

        Library-aware via the shared _canonical_song_filename rule: only decode a
        row when the decoded form is a real song, so a correctly-stored name
        containing literal %XX is never rewritten, and dead-song/orphan rows
        (neither form in the library) are left exactly as-is."""
        cols = self._STATS_COLS
        with self._lock:
            rows = [dict(zip(cols, r)) for r in self.conn.execute(
                "SELECT " + ", ".join(cols) + " FROM song_stats").fetchall()]
            canon = self._canonical_song_filename
            if all(canon(r["filename"]) == r["filename"] for r in rows):
                return  # every row already canonical (or an untouchable orphan)
            merged: dict = {}
            for r in rows:
                key = (canon(r["filename"]), int(r["arrangement"]))
                cur = merged.get(key)
                if cur is None:
                    merged[key] = dict(r, filename=key[0], arrangement=key[1])
                    continue
                # Most-recently-updated row wins the "last_*"/position fields.
                def _stamp(x):
                    return str(x.get("updated_at") or x.get("last_played_at") or "")
                newer = r if _stamp(r) >= _stamp(cur) else cur
                merged[key] = {
                    "filename": key[0], "arrangement": key[1],
                    "plays": (cur["plays"] or 0) + (r["plays"] or 0),
                    "best_score": max(cur["best_score"] or 0, r["best_score"] or 0),
                    "best_accuracy": max(cur["best_accuracy"] or 0.0, r["best_accuracy"] or 0.0),
                    "last_score": newer["last_score"], "last_accuracy": newer["last_accuracy"],
                    "last_position": newer["last_position"],
                    # Play time is additive: both encodings' hours belong to
                    # the one canonical song.
                    "seconds_total": (cur.get("seconds_total") or 0.0) + (r.get("seconds_total") or 0.0),
                    "last_played_at": newer["last_played_at"], "updated_at": newer["updated_at"],
                }
            # Atomic swap: clear and reinsert the canonicalized set in one txn.
            try:
                self.conn.execute("DELETE FROM song_stats")
                self.conn.executemany(
                    "INSERT INTO song_stats (" + ", ".join(cols) + ") VALUES ("
                    + ", ".join("?" * len(cols)) + ")",
                    [tuple(m[c] for c in cols) for m in merged.values()],
                )
                self.conn.commit()
            except Exception:
                self.conn.rollback()
                raise

    def is_favorite(self, filename: str) -> bool:
        return self.conn.execute("SELECT 1 FROM favorites WHERE filename = ?", (filename,)).fetchone() is not None

    def toggle_favorite(self, filename: str) -> bool:
        """Toggle favorite status. Returns new state."""
        with self._lock:
            if self.is_favorite(filename):
                self.conn.execute("DELETE FROM favorites WHERE filename = ?", (filename,))
                self.conn.commit()
                return False
            else:
                self.conn.execute("INSERT OR IGNORE INTO favorites VALUES (?)", (filename,))
                self.conn.commit()
                return True

    # ── Personal per-song metadata: user-difficulty / notes / tags ───────────
    # All keyed by the on-disk `songs` filename and kept OUT of the shared
    # feedpak file. Likes are the `favorites` heart, deliberately NOT duplicated
    # here. Reads are lock-free (WAL); writes take self._lock like the rest.
    def get_song_user_meta(self, filename: str) -> dict:
        """{'user_difficulty', 'notes', 'tags'} for one song (tags sorted)."""
        row = self.conn.execute(
            "SELECT user_difficulty, notes FROM song_user_meta WHERE filename = ?",
            (filename,)).fetchone()
        tags = [r[0] for r in self.conn.execute(
            "SELECT tag FROM song_tags WHERE filename = ? ORDER BY tag COLLATE NOCASE",
            (filename,)).fetchall()]
        return {
            "user_difficulty": (row[0] if row else None),
            "notes": ((row[1] if row else None) or ""),
            "tags": tags,
        }

    def set_song_user_meta(self, filename: str, *,
                           user_difficulty="__keep__", notes="__keep__") -> dict:
        """Partial upsert of the personal fields. Pass a value to set it, None to
        clear it, or leave it out (sentinel `__keep__`) to preserve the current
        one. When nothing personal remains the row is dropped so an
        unset-everything leaves no empty shell. Returns the merged meta."""
        with self._lock:
            cur = self.conn.execute(
                "SELECT user_difficulty, notes FROM song_user_meta WHERE filename = ?",
                (filename,)).fetchone()
            cur_diff = cur[0] if cur else None
            cur_notes = cur[1] if cur else None
            new_diff = cur_diff if user_difficulty == "__keep__" else user_difficulty
            new_notes = cur_notes if notes == "__keep__" else notes
            if new_diff is None and not (new_notes or "").strip():
                self.conn.execute("DELETE FROM song_user_meta WHERE filename = ?", (filename,))
            else:
                self.conn.execute(
                    "INSERT INTO song_user_meta (filename, user_difficulty, notes, updated_at) "
                    "VALUES (?, ?, ?, datetime('now')) "
                    "ON CONFLICT(filename) DO UPDATE SET "
                    "user_difficulty = excluded.user_difficulty, "
                    "notes = excluded.notes, updated_at = excluded.updated_at",
                    (filename, new_diff, (new_notes or None)))
            self.conn.commit()
        return self.get_song_user_meta(filename)

    # ── Per-field metadata overrides + locks (Fix-metadata popup) ─────────────
    def get_song_overrides(self, filename: str) -> dict:
        """{field: {"value": str|None, "locked": bool}} for one song."""
        rows = self.conn.execute(
            "SELECT field, value, locked FROM song_field_override WHERE filename = ?",
            (filename,)).fetchall()
        return {r[0]: {"value": r[1], "locked": bool(r[2])} for r in rows}

    def set_song_override(self, filename: str, field: str, *,
                          value="__keep__", locked="__keep__") -> dict:
        """Partial upsert of one field's override value and/or lock. Pass a
        value/locked to set it or leave the sentinel to keep the current one. A
        row with neither a value nor a lock is dropped (no empty shell). Returns
        the song's full override map."""
        with self._lock:
            cur = self.conn.execute(
                "SELECT value, locked FROM song_field_override WHERE filename = ? AND field = ?",
                (filename, field)).fetchone()
            new_val = (cur[0] if cur else None) if value == "__keep__" else value
            new_lock = (bool(cur[1]) if cur else False) if locked == "__keep__" else bool(locked)
            new_val = (new_val or "").strip() or None
            if new_val is None and not new_lock:
                self.conn.execute(
                    "DELETE FROM song_field_override WHERE filename = ? AND field = ?",
                    (filename, field))
            else:
                self.conn.execute(
                    "INSERT INTO song_field_override (filename, field, value, locked, updated_at) "
                    "VALUES (?, ?, ?, ?, datetime('now')) "
                    "ON CONFLICT(filename, field) DO UPDATE SET "
                    "value = excluded.value, locked = excluded.locked, updated_at = excluded.updated_at",
                    (filename, field, new_val, 1 if new_lock else 0))
            self.conn.commit()
        return self.get_song_overrides(filename)

    def locked_fields(self, filename: str) -> set:
        """The catalog fields the user LOCKED for a song (Fix-metadata popup).
        An automatic match must never (re)canonicalize these, and gap-fill must
        never write them to the file. Locked read (the enrichment worker calls
        it), minimal projection."""
        with self._lock:
            return {r[0] for r in self.conn.execute(
                "SELECT field FROM song_field_override WHERE filename = ? AND locked = 1",
                (filename,)).fetchall()}

    def clear_song_override(self, filename: str, field: str) -> dict:
        """Remove a field's override + lock entirely (revert to the resolved
        pack/matched value)."""
        with self._lock:
            self.conn.execute(
                "DELETE FROM song_field_override WHERE filename = ? AND field = ?",
                (filename, field))
            self.conn.commit()
        return self.get_song_overrides(filename)

    def overrides_map(self, filenames) -> dict:
        """{filename: {field: {value, locked}}} for a batch — feeds the grid's
        effective-value resolution (display slice). Chunked under SQLite's
        variable limit."""
        fns = list(filenames)
        out: dict = {}
        for i in range(0, len(fns), 400):
            chunk = fns[i:i + 400]
            if not chunk:
                break
            q = ("SELECT filename, field, value, locked FROM song_field_override "
                 "WHERE filename IN (%s)" % ",".join("?" * len(chunk)))
            for fn, field, value, locked in self.conn.execute(q, chunk).fetchall():
                out.setdefault(fn, {})[field] = {"value": value, "locked": bool(locked)}
        return out

    def _romaji_display(self, filename: str, artist: str, title: str):
        """English-base display fallback. A blank-artist CDLC pack named
        'Artist_Title_v1_p' has no readable name (artist blank; title = the raw
        filename), and a match would fill it with the artist's NATIVE script
        (kanji/kana). Surface the author's own romaji parsed from the filename
        instead, so an English base reads 'Junko Yagami - BAY CITY'. Only kicks in
        when the pack has no artist of its own — a real pack artist is untouched."""
        if (artist or "").strip():
            return artist, title
        d = _artist_title_from_filename(filename)
        return (d["artist"], d["title"]) if d else (artist, title)

    def pack_fields(self, filename: str) -> dict:
        """The stored (pack) values for the overridable catalog fields — the
        Fix-metadata popup shows these behind each override as the 'revert to
        pack' reference + the Yours/Pack provenance. Empty strings for a missing
        song so the popup always has a value to render."""
        keys = ("title", "artist", "album", "year", "genre")
        row = self.conn.execute(
            "SELECT title, artist, album, year, genre FROM songs WHERE filename = ?",
            (filename,)).fetchone()
        vals = {k: ((row[i] or "") if row else "") for i, k in enumerate(keys)}
        # Baseline the author's romaji (from the filename) for a blank-artist pack,
        # so the Details tab's Pack reference matches what the grid shows.
        vals["artist"], vals["title"] = self._romaji_display(filename, vals["artist"], vals["title"])
        return vals

    # Effective genre precedence: per-song OVERRIDE (Fix-metadata popup) →
    # scanned pack genre → MusicBrainz enrichment primary genre (matched/manual rows
    # only — a 'review'/'failed' candidate's genres could belong to the wrong
    # recording). Applied at FILTER/FACET time (like the P4 artist alias) so a
    # corrected or enriched genre is browsable. The vast majority of converted
    # packs carry no `genres` manifest key, so without the enrichment leg the
    # genre facet (and career passports) starve on real libraries. The
    # correlated subqueries are used ONLY when overrides/enrichment genres
    # actually exist; the common case stays on the plain indexed `genre`
    # column. Genre stays a library-only overlay (it isn't a write-to-file
    # field), so it never touches the pack.
    _EFFECTIVE_GENRE_OVERRIDE_SQL = (
        "COALESCE((SELECT o.value FROM song_field_override o "
        "WHERE o.filename = songs.filename AND o.field = 'genre' "
        "AND o.value IS NOT NULL AND o.value != ''), genre)"
    )
    _EFFECTIVE_GENRE_SQL = (
        "COALESCE((SELECT o.value FROM song_field_override o "
        "WHERE o.filename = songs.filename AND o.field = 'genre' "
        "AND o.value IS NOT NULL AND o.value != ''), "
        "NULLIF(genre, ''), "
        "(SELECT json_extract(e.genres, '$[0]') FROM song_enrichment e "
        "WHERE e.filename = songs.filename AND e.match_state IN ('matched', 'manual') "
        "AND e.genres IS NOT NULL AND e.genres NOT IN ('', '[]')), "
        "'')"
    )

    def _has_genre_overrides(self) -> bool:
        return self.conn.execute(
            "SELECT 1 FROM song_field_override WHERE field = 'genre' "
            "AND value IS NOT NULL AND value != '' LIMIT 1").fetchone() is not None

    def _has_enrichment_genres(self) -> bool:
        try:
            return self.conn.execute(
                "SELECT 1 FROM song_enrichment WHERE match_state IN ('matched', 'manual') "
                "AND genres IS NOT NULL AND genres NOT IN ('', '[]') "
                "LIMIT 1").fetchone() is not None
        except sqlite3.OperationalError:
            return False  # stand-ins / DBs without the enrichment table

    def _effective_genre_expr(self) -> str:
        """`genre` normally; the enrichment-aware COALESCE only when trusted
        enrichment genres exist (which also proves the table exists — a
        stand-in DB without song_enrichment must never receive SQL that
        references it); the override-only form when just overrides exist."""
        if self._has_enrichment_genres():
            return self._EFFECTIVE_GENRE_SQL
        if self._has_genre_overrides():
            return self._EFFECTIVE_GENRE_OVERRIDE_SQL
        return "genre"

    def set_song_tags(self, filename: str, tags) -> list:
        """Replace ALL of a song's tags with the given set (each normalized;
        blanks + case-dupes dropped). Full-replace so the whole personal-meta
        blob edits as a unit. Returns the stored tag list (sorted, like reads)."""
        norm: list = []
        seen: set = set()
        for t in (tags or []):
            nt = _normalize_tag(t)
            if nt and nt not in seen:
                seen.add(nt)
                norm.append(nt)
        # Bound the number of tags so one PUT can't write unbounded rows.
        # Per-tag length is already capped in _normalize_tag; cap the count too.
        norm = norm[:50]
        with self._lock:
            self.conn.execute("DELETE FROM song_tags WHERE filename = ?", (filename,))
            if norm:
                self.conn.executemany(
                    "INSERT OR IGNORE INTO song_tags (filename, tag, created_at) "
                    "VALUES (?, ?, datetime('now'))",
                    [(filename, t) for t in norm])
            self.conn.commit()
        return self.get_song_user_meta(filename)["tags"]

    def all_tags(self) -> list:
        """[{tag, count}] over songs that still exist, most-used first — powers
        the tag filter UI. Excludes tags whose only songs were deleted."""
        rows = self.conn.execute(
            "SELECT tag, COUNT(*) c FROM song_tags "
            "WHERE filename IN (SELECT filename FROM songs) "
            "GROUP BY tag ORDER BY c DESC, tag COLLATE NOCASE").fetchall()
        return [{"tag": r[0], "count": r[1]} for r in rows]

    def user_meta_map(self, filenames) -> dict:
        """Batch {filename: user_difficulty} for a set of rows (set values
        only). Lets query_page / query_artists embed difficulty without an
        N+1. Chunked under SQLite's variable limit — query_artists can pass
        every song across 50 artists, well past a single IN (...)."""
        fns = list(filenames)
        out: dict = {}
        for i in range(0, len(fns), 400):
            chunk = fns[i:i + 400]
            if not chunk:
                break
            ph = ",".join("?" * len(chunk))
            rows = self.conn.execute(
                f"SELECT filename, user_difficulty FROM song_user_meta "
                f"WHERE filename IN ({ph}) AND user_difficulty IS NOT NULL", chunk).fetchall()
            for fn, diff in rows:
                out[fn] = diff
        return out

    def tags_map(self, filenames) -> dict:
        """Batch {filename: [tags]} for a page of rows."""
        fns = list(filenames)
        if not fns:
            return {}
        ph = ",".join("?" * len(fns))
        rows = self.conn.execute(
            f"SELECT filename, tag FROM song_tags WHERE filename IN ({ph}) "
            f"ORDER BY tag COLLATE NOCASE", fns).fetchall()
        out: dict = {}
        for fn, tag in rows:
            out.setdefault(fn, []).append(tag)
        return out

    def purge_song_user_data(self, filename: str) -> None:
        """Drop all personal rows for a deleted song. Called by delete_song
        INSIDE the caller's `meta_db._lock` — must not re-acquire the lock."""
        self.conn.execute("DELETE FROM song_user_meta WHERE filename = ?", (filename,))
        self.conn.execute("DELETE FROM song_tags WHERE filename = ?", (filename,))
        self.conn.execute("DELETE FROM song_field_override WHERE filename = ?", (filename,))

    def batch_user_meta(self, filenames, *, set_difficulty="__keep__",
                        add_tags=None, remove_tags=None) -> int:
        """Apply personal-meta edits across MANY songs in one transaction —
        the bulk-edit primitive behind the batch bar. Additive by design so a
        bulk action never silently clobbers per-song data the user can't see:

        - `set_difficulty`: an int 1–5 sets it on every song; `None` clears it
          on every song; the `__keep__` sentinel leaves each song's own value
          untouched (mixed-state "leave unchanged"). Notes are preserved; a row
          that ends up difficulty-less AND notes-less is dropped (no empty shell,
          matching set_song_user_meta).
        - `add_tags` / `remove_tags`: tag sets ADDED to / REMOVED from each song
          (never a full-replace — bulk must not wipe a song's other tags). A tag
          in both add and remove resolves to add (explicit set wins).

        Returns the count of songs touched. Caller normalizes tags is NOT
        assumed — we normalize here so the endpoint and the DB agree."""
        add = []
        seen: set = set()
        for t in (add_tags or []):
            nt = _normalize_tag(t)
            if nt and nt not in seen:
                seen.add(nt)
                add.append(nt)
        rem = {nt for nt in (_normalize_tag(t) for t in (remove_tags or [])) if nt}
        rem -= set(add)  # add wins a conflict
        fns = list(dict.fromkeys(filenames or []))  # dedupe, keep order
        if not fns:
            return 0
        with self._lock:
            for fn in fns:
                if set_difficulty != "__keep__":
                    cur = self.conn.execute(
                        "SELECT notes FROM song_user_meta WHERE filename = ?",
                        (fn,)).fetchone()
                    cur_notes = cur[0] if cur else None
                    if set_difficulty is None and not (cur_notes or "").strip():
                        self.conn.execute(
                            "DELETE FROM song_user_meta WHERE filename = ?", (fn,))
                    else:
                        self.conn.execute(
                            "INSERT INTO song_user_meta (filename, user_difficulty, notes, updated_at) "
                            "VALUES (?, ?, ?, datetime('now')) "
                            "ON CONFLICT(filename) DO UPDATE SET "
                            "user_difficulty = excluded.user_difficulty, "
                            "updated_at = excluded.updated_at",
                            (fn, set_difficulty, cur_notes))
                if rem:
                    ph = ",".join("?" * len(rem))
                    self.conn.execute(
                        f"DELETE FROM song_tags WHERE filename = ? AND tag IN ({ph})",
                        [fn, *rem])
                if add:
                    self.conn.executemany(
                        "INSERT OR IGNORE INTO song_tags (filename, tag, created_at) "
                        "VALUES (?, ?, datetime('now'))",
                        [(fn, t) for t in add])
            self.conn.commit()
        return len(fns)

    # ── Player profile (fee[dB]ack v0.3.0) ─────────────────────────────────
    def get_profile(self) -> dict:
        row = self.conn.execute(
            "SELECT display_name, avatar_path, player_hash, onboarded FROM profile WHERE id = 1"
        ).fetchone()
        if not row:
            return {"display_name": None, "avatar_url": None, "player_hash": None, "onboarded": False}
        return {
            "display_name": row[0],
            "avatar_url": row[1],
            "player_hash": row[2],
            "onboarded": bool(row[3]),
        }

    def set_profile(self, display_name: str, avatar_url: str | None) -> dict:
        """Set/update the display name (+ avatar). Computes player_hash ONCE
        from the first name + a stored random salt; it stays stable across
        later name changes. Marks onboarded=1."""
        with self._lock:
            cur = self.conn.execute(
                "SELECT player_hash, player_salt FROM profile WHERE id = 1"
            ).fetchone()
            player_hash = cur[0] if cur else None
            salt = cur[1] if cur else None
            if not player_hash:
                salt = secrets.token_hex(16)
                player_hash = hashlib.sha256((display_name + salt).encode("utf-8")).hexdigest()
            self.conn.execute(
                "UPDATE profile SET display_name = ?, "
                "avatar_path = COALESCE(?, avatar_path), "
                "player_hash = ?, player_salt = ?, onboarded = 1 WHERE id = 1",
                (display_name, avatar_url, player_hash, salt),
            )
            self.conn.commit()
        return self.get_profile()

    # ── Unified XP store ────────────────────────────────────────────────────
    def get_xp(self) -> int:
        row = self.conn.execute("SELECT xp FROM xp_profile WHERE id = 1").fetchone()
        return int(row[0]) if row else 0

    def award_xp(self, amount: int, source: str | None = None) -> int:
        """Add XP to the unified store; returns the new total. `amount` may be
        NEGATIVE — used internally to REVERSE a failed award (the total and the
        per-source bucket both clamp at 0). `source` (when given) is tracked in
        the xp_sources ledger so it can be reset independently.

        Service boundary: the plugin hook (context["award_xp"]) passes this
        straight through, so coerce defensively — bad input (bool, NaN/Inf,
        non-integral, out-of-int64-range) must neither raise NOR mutate state.
        _as_int rejects bool/non-integral; bad → no-op (0)."""
        try:
            amount = _as_int(amount)
        except (TypeError, ValueError, OverflowError):
            amount = 0
        amount = max(-10_000_000, min(amount, 10_000_000))
        with self._lock:
            # MAX(0, …) clamps the result so a reversal can't drive XP negative.
            self.conn.execute(
                "UPDATE xp_profile SET xp = MAX(0, xp + ?), "
                "total_awards = total_awards + ?, updated_at = datetime('now') WHERE id = 1",
                (amount, 1 if amount > 0 else 0),
            )
            if source:
                self.conn.execute(
                    "INSERT INTO xp_sources (source, xp) VALUES (?, MAX(0, ?)) "
                    "ON CONFLICT(source) DO UPDATE SET xp = MAX(0, xp + ?)",
                    (source, amount, amount),
                )
            self.conn.commit()
            row = self.conn.execute("SELECT xp FROM xp_profile WHERE id = 1").fetchone()
        return int(row[0]) if row else 0

    def reset_source_xp(self, source: str) -> dict:
        """Subtract a single source's tracked contribution from the unified
        total and zero its bucket (e.g. a minigames profile-reset removes only
        minigames XP, leaving song-play/tutorials XP intact). Returns progress."""
        with self._lock:
            row = self.conn.execute("SELECT xp FROM xp_sources WHERE source = ?", (source,)).fetchone()
            amt = int(row[0]) if row and row[0] else 0
            if amt:
                self.conn.execute(
                    "UPDATE xp_profile SET xp = MAX(0, xp - ?), updated_at = datetime('now') WHERE id = 1",
                    (amt,),
                )
            self.conn.execute("UPDATE xp_sources SET xp = 0 WHERE source = ?", (source,))
            self.conn.commit()
        return self.get_progress()

    def seed_xp_once(self, amount: int, marker: str = "minigames") -> bool:
        """One-time seed of the unified store from a pre-unification source
        (e.g. the minigames plugin's profile.json), so existing earned XP is
        preserved. No-ops if already seeded or the store already has XP.
        Returns True if it seeded."""
        # Same no-raise / no-silent-mutate contract as award_xp(): this is a
        # plugin-facing service (context["seed_xp"]). _as_int rejects bool /
        # non-integral; bad input becomes a 0 (no-op) seed rather than raising.
        try:
            amount = _as_int(amount)
        except (TypeError, ValueError, OverflowError):
            amount = 0
        amount = max(0, min(amount, 10_000_000))
        if marker != "minigames":
            return False
        with self._lock:
            row = self.conn.execute(
                "SELECT xp, minigames_seeded FROM xp_profile WHERE id = 1"
            ).fetchone()
            xp_now, seeded = (row[0], row[1]) if row else (0, 0)
            if seeded or xp_now > 0 or amount <= 0:
                if not seeded:
                    self.conn.execute("UPDATE xp_profile SET minigames_seeded = 1 WHERE id = 1")
                    self.conn.commit()
                return False
            self.conn.execute(
                "UPDATE xp_profile SET xp = ?, minigames_seeded = 1, updated_at = datetime('now') WHERE id = 1",
                (amount,),
            )
            # Record the seeded amount in the source ledger too, so a later
            # minigames reset subtracts the migrated XP rather than orphaning it.
            self.conn.execute(
                "INSERT INTO xp_sources (source, xp) VALUES (?, ?) "
                "ON CONFLICT(source) DO UPDATE SET xp = xp + ?",
                (marker, amount, amount),
            )
            self.conn.commit()
        return True

    # ── Streak ──────────────────────────────────────────────────────────────
    def record_active_day(self, today: str) -> dict:
        """Mark `today` (YYYY-MM-DD, local) as an active day. Any session on a
        calendar day keeps the streak: yesterday→+1, today→unchanged, gap or
        first-ever→reset to 1. Updates best_streak."""
        from datetime import date, timedelta
        with self._lock:
            row = self.conn.execute(
                "SELECT current_streak, best_streak, last_active_date FROM profile_progress WHERE id = 1"
            ).fetchone()
            cur, best, last = (row[0], row[1], row[2]) if row else (0, 0, None)
            if last != today:
                try:
                    yesterday = (date.fromisoformat(today) - timedelta(days=1)).isoformat()
                except ValueError:
                    yesterday = None
                cur = cur + 1 if (last and last == yesterday) else 1
                best = max(best or 0, cur)
                self.conn.execute(
                    "UPDATE profile_progress SET current_streak = ?, best_streak = ?, last_active_date = ? WHERE id = 1",
                    (cur, best, today),
                )
                self.conn.commit()
                last = today
        return {"current_streak": cur, "best_streak": best, "last_active_date": last}

    def get_progress(self) -> dict:
        """The full profile-badge payload: XP/level (lib/xp) + streak."""
        from xp import progress as _xp_progress
        p = self.conn.execute(
            "SELECT current_streak, best_streak, last_active_date FROM profile_progress WHERE id = 1"
        ).fetchone()
        cur, best, last = (p[0], p[1], p[2]) if p else (0, 0, None)
        out = _xp_progress(self.get_xp())
        out.update({"current_streak": cur, "best_streak": best, "last_active_date": last})
        return out

    # ── Progression (spec 010): paths, challenges, quests, wallet, shop ────
    # Lock discipline: self._lock is NOT reentrant and award_xp() takes it, so
    # record_progression_event() applies state inside the lock but awards quest
    # dB (and re-enters for quest_completed goals) only after releasing it.

    def get_progression_state(self) -> dict:
        row = self.conn.execute(
            "SELECT calibration_status, calibration_completed_at FROM progression_state WHERE id = 1"
        ).fetchone()
        status = row[0] if row else "pending"
        return {"calibration_status": status, "calibration_completed_at": row[1] if row else None}

    def skip_calibration(self) -> dict:
        """pending → skipped (no-op once completed/skipped). Either way the
        player holds onboarding rank 1 afterwards."""
        with self._lock:
            self.conn.execute(
                "UPDATE progression_state SET calibration_status = 'skipped' "
                "WHERE id = 1 AND calibration_status = 'pending'"
            )
            self.conn.commit()
        return self.get_progression_state()

    def get_player_paths(self) -> dict:
        """{path_id: level} for every selected path."""
        rows = self.conn.execute("SELECT path_id, level FROM player_paths").fetchall()
        return {r[0]: int(r[1]) for r in rows}

    def add_player_paths(self, path_ids) -> dict:
        """Select paths (idempotent; re-adding never resets a level)."""
        with self._lock:
            for pid in path_ids:
                self.conn.execute(
                    "INSERT OR IGNORE INTO player_paths (path_id, level, selected_at) "
                    "VALUES (?, 0, datetime('now'))",
                    (pid,),
                )
            self.conn.commit()
        return self.get_player_paths()

    def get_challenge_state(self) -> dict:
        """{challenge_id: {count, completed, detail}} for every touched challenge."""
        rows = self.conn.execute(
            "SELECT challenge_id, count, progress_detail, completed_at FROM challenge_progress"
        ).fetchall()
        out = {}
        for cid, count, detail, completed_at in rows:
            try:
                parsed = json.loads(detail) if detail else None
            except (ValueError, TypeError):
                parsed = None
            out[cid] = {
                "count": int(count or 0),
                "completed": completed_at is not None,
                "completed_at": completed_at,
                "detail": parsed,
            }
        return out

    def ensure_quest_period(self, content, now) -> None:
        """Lazily instantiate the current daily/weekly quest rows (deterministic
        per period key; rewards snapshot so live quests survive content edits)."""
        import progression as progression_mod
        keys = progression_mod.period_keys(now)
        with self._lock:
            for period_type in ("daily", "weekly"):
                cfg = (content.get("quests") or {}).get(period_type) or {}
                pool = cfg.get("pool") or {}
                count = int(cfg.get("count") or 0)
                if not pool or count < 1:
                    continue
                key = keys[period_type]
                exists = self.conn.execute(
                    "SELECT 1 FROM quest_state WHERE period_type = ? AND period_key = ? LIMIT 1",
                    (period_type, key),
                ).fetchone()
                if exists:
                    continue
                for qid in progression_mod.select_quests(pool.keys(), period_type, key, count):
                    self.conn.execute(
                        "INSERT OR IGNORE INTO quest_state "
                        "(period_type, period_key, quest_id, reward_db) VALUES (?, ?, ?, ?)",
                        (period_type, key, qid, int(pool[qid].get("reward_db") or 0)),
                    )
            self.conn.commit()

    def get_quest_rows(self, period_keys_map: dict) -> list:
        """Current-period quest instances as snapshot/API rows."""
        out = []
        for period_type, key in period_keys_map.items():
            rows = self.conn.execute(
                "SELECT quest_id, count, reward_db, progress_detail, completed_at "
                "FROM quest_state WHERE period_type = ? AND period_key = ? ORDER BY quest_id",
                (period_type, key),
            ).fetchall()
            for qid, count, reward, detail, completed_at in rows:
                try:
                    parsed = json.loads(detail) if detail else None
                except (ValueError, TypeError):
                    parsed = None
                out.append({
                    "period_type": period_type,
                    "period_key": key,
                    "quest_id": qid,
                    "count": int(count or 0),
                    "reward_db": int(reward or 0),
                    "detail": parsed,
                    "completed": completed_at is not None,
                    "completed_at": completed_at,
                })
        return out

    def get_wallet(self) -> dict:
        """{balance, lifetime_db, spent} — see the wallet table comment for
        why spend never mutates xp_profile.xp."""
        import progression as progression_mod
        row = self.conn.execute("SELECT spent FROM wallet WHERE id = 1").fetchone()
        spent = int(row[0]) if row and row[0] else 0
        lifetime = self.get_xp()
        return {
            "balance": progression_mod.wallet_balance(lifetime, spent),
            "lifetime_db": lifetime,
            "spent": spent,
        }

    def buy_shop_item(self, item: dict) -> tuple:
        """Atomic purchase: balance check + spend + ownership in one
        transaction. Returns ("ok"|"owned"|"insufficient", wallet)."""
        with self._lock:
            owned = self.conn.execute(
                "SELECT 1 FROM shop_owned WHERE item_id = ?", (item["id"],)
            ).fetchone()
            if owned:
                status = "owned"
            else:
                xp_row = self.conn.execute("SELECT xp FROM xp_profile WHERE id = 1").fetchone()
                spent_row = self.conn.execute("SELECT spent FROM wallet WHERE id = 1").fetchone()
                balance = max(0, int(xp_row[0] if xp_row else 0) - int(spent_row[0] if spent_row else 0))
                cost = int(item.get("cost") or 0)
                if cost < 0:
                    status = "invalid"
                elif balance < cost:
                    status = "insufficient"
                else:
                    self.conn.execute(
                        "UPDATE wallet SET spent = spent + ? WHERE id = 1", (cost,)
                    )
                    self.conn.execute(
                        "INSERT INTO shop_owned (item_id, cost_paid, acquired_at) "
                        "VALUES (?, ?, datetime('now'))",
                        (item["id"], cost),
                    )
                    self.conn.commit()
                    status = "ok"
        return status, self.get_wallet()

    def get_owned_items(self) -> dict:
        rows = self.conn.execute(
            "SELECT item_id, cost_paid, acquired_at FROM shop_owned"
        ).fetchall()
        return {r[0]: {"cost_paid": int(r[1] or 0), "acquired_at": r[2]} for r in rows}

    def get_equipped(self) -> dict:
        rows = self.conn.execute("SELECT slot, item_id FROM shop_equipped").fetchall()
        return {r[0]: r[1] for r in rows if r[1]}

    def equip_item(self, slot: str, item_id) -> dict:
        """Equip an owned item into a slot (item_id=None unequips)."""
        with self._lock:
            if item_id is None:
                self.conn.execute("DELETE FROM shop_equipped WHERE slot = ?", (slot,))
            else:
                self.conn.execute(
                    "INSERT INTO shop_equipped (slot, item_id) VALUES (?, ?) "
                    "ON CONFLICT(slot) DO UPDATE SET item_id = excluded.item_id",
                    (slot, item_id),
                )
            self.conn.commit()
        return self.get_equipped()

    def progression_snapshot(self, content, now) -> dict:
        """The plain-dict state view lib/progression.evaluate_event reads."""
        import progression as progression_mod
        keys = progression_mod.period_keys(now)
        streak_row = self.conn.execute(
            "SELECT current_streak FROM profile_progress WHERE id = 1"
        ).fetchone()
        return {
            "calibration_status": self.get_progression_state()["calibration_status"],
            "paths": self.get_player_paths(),
            "challenges": self.get_challenge_state(),
            "quests": self.get_quest_rows(keys),
            "streak": int(streak_row[0]) if streak_row and streak_row[0] else 0,
            "xp_total": self.get_xp(),
        }

    def record_progression_event(self, event_type: str, payload, content,
                                 now=None, _depth: int = 0) -> dict:
        """The single progression choke point: evaluate one event, persist the
        deltas, award quest dB, and re-enter once for quest_completed goals.
        Returns a toast-ready summary."""
        import progression as progression_mod
        from datetime import datetime as _dt
        now = now or _dt.now()
        self.ensure_quest_period(content, now)
        snapshot = self.progression_snapshot(content, now)
        outcome = progression_mod.evaluate_event(
            {"type": event_type, "payload": payload or {}}, content, snapshot
        )
        keys = progression_mod.period_keys(now)
        challenge_index = content.get("challenge_index") or {}
        quest_pools = content.get("quests") or {}

        summary = {
            "challenges_completed": [],
            "quests_completed": [],
            "level_ups": list(outcome["level_ups"]),
            "calibration_completed": bool(outcome["calibration_completed"]),
        }
        with self._lock:
            for ch in outcome["challenges"]:
                detail = json.dumps(ch["detail"]) if ch.get("detail") else None
                self.conn.execute(
                    "INSERT INTO challenge_progress "
                    "(challenge_id, path_id, level, count, progress_detail, completed_at) "
                    "VALUES (?, ?, ?, ?, ?, CASE WHEN ? THEN datetime('now') END) "
                    "ON CONFLICT(challenge_id) DO UPDATE SET "
                    "count = excluded.count, progress_detail = excluded.progress_detail, "
                    "completed_at = COALESCE(challenge_progress.completed_at, excluded.completed_at)",
                    (ch["challenge_id"], ch["path_id"], ch["level"], ch["count"],
                     detail, 1 if ch["completed"] else 0),
                )
                if ch["completed"]:
                    info = challenge_index.get(ch["challenge_id"]) or {}
                    title = (info.get("challenge") or {}).get("title") or ch["challenge_id"]
                    summary["challenges_completed"].append(
                        {"id": ch["challenge_id"], "title": title, "path_id": ch["path_id"]}
                    )
            for lu in outcome["level_ups"]:
                # Guard on the old level so a stale evaluation can't double-bump.
                self.conn.execute(
                    "UPDATE player_paths SET level = ? WHERE path_id = ? AND level = ?",
                    (lu["new_level"], lu["path_id"], lu["new_level"] - 1),
                )
            # Only quests whose row actually TRANSITIONED to completed in this
            # call get rewarded/re-entered. The pure outcome was computed from
            # a pre-lock snapshot, so a concurrent event may have completed the
            # same quest first — its guarded UPDATE (completed_at IS NULL)
            # then touches 0 rows here, and paying it again would double-award
            # Decibels and double-advance quest_completed challenges.
            newly_completed_quests = []
            for q in outcome["quests"]:
                detail = json.dumps(q["detail"]) if q.get("detail") else None
                cur = self.conn.execute(
                    "UPDATE quest_state SET count = ?, progress_detail = ?, "
                    "completed_at = COALESCE(completed_at, CASE WHEN ? THEN datetime('now') END) "
                    "WHERE period_type = ? AND period_key = ? AND quest_id = ? AND completed_at IS NULL",
                    (q["count"], detail, 1 if q["completed"] else 0,
                     q["period_type"], keys.get(q["period_type"], ""), q["quest_id"]),
                )
                if q["completed"] and cur.rowcount > 0:
                    newly_completed_quests.append(q)
            if outcome["calibration_completed"]:
                self.conn.execute(
                    "UPDATE progression_state SET calibration_status = 'completed', "
                    "calibration_completed_at = datetime('now') "
                    "WHERE id = 1 AND calibration_status != 'completed'"
                )
            self.conn.commit()

        # Quest awards + bounded re-entry, outside the lock (award_xp locks).
        for q in newly_completed_quests:
            pool = (quest_pools.get(q["period_type"]) or {}).get("pool") or {}
            qdef = pool.get(q["quest_id"]) or {}
            summary["quests_completed"].append({
                "id": q["quest_id"],
                "title": qdef.get("title") or q["quest_id"],
                "period_type": q["period_type"],
                "reward_db": q["reward_db"],
            })
            if q["reward_db"]:
                self.award_xp(q["reward_db"], "quests")
            if _depth < 1:
                sub = self.record_progression_event(
                    "quest_completed",
                    {"period_type": q["period_type"], "quest_id": q["quest_id"]},
                    content, now=now, _depth=_depth + 1,
                )
                summary["challenges_completed"].extend(sub["challenges_completed"])
                summary["quests_completed"].extend(sub["quests_completed"])
                summary["level_ups"].extend(sub["level_ups"])

        summary["mastery_rank"] = progression_mod.mastery_rank(
            self.get_progression_state()["calibration_status"], self.get_player_paths()
        )
        return summary

    # ── Per-song practice stats ───────────────────────────────────────────---
    _STATS_COLS = (
        "filename", "arrangement", "plays", "best_score", "best_accuracy",
        "last_score", "last_accuracy", "last_position", "seconds_total",
        "last_played_at", "updated_at",
    )

    def _stats_row(self, filename: str, arrangement: int) -> dict | None:
        r = self.conn.execute(
            "SELECT " + ", ".join(self._STATS_COLS) +
            " FROM song_stats WHERE filename = ? AND arrangement = ?",
            (filename, int(arrangement)),
        ).fetchone()
        return dict(zip(self._STATS_COLS, r)) if r else None

    # Constant SQL fragment restricting stats reads to songs that still exist.
    # Unconditional: a genuinely empty (but scanned) library must still hide
    # stale stats/playlist ghosts. We rely on `songs` NEVER being transiently
    # empty mid-scan — /api/rescan/full bumps mtime to force a full re-scan
    # rather than DELETEing rows — so the only times `songs` is empty are a
    # fresh install (no stats anyway) or a truly empty library (ghosts should be
    # hidden). Race-free orphan handling: dead-song stats are hidden here, never
    # deleted on scan (see delete_missing).
    _EXISTING_SONG_FILTER = " AND filename IN (SELECT filename FROM songs) "

    def _existing_song_filter(self) -> str:
        return self._EXISTING_SONG_FILTER

    # ── Artist-name canonicalization (P4) ─────────────────────────────────────
    # "Apply at display": resolve songs.artist through the artist_alias override
    # for the deduped dropdown/tree (query_artists) — else keep the raw name. The
    # correlated PK-lookup subquery is fine for the offset-paged catalog; the grid
    # FILTER instead expands a canonical name to its raw variants (index-friendly,
    # keyset-safe), and the grid DISPLAY re-labels rows in Python via alias_map().
    _EFFECTIVE_ARTIST_SQL = (
        "COALESCE((SELECT aa.canonical_name FROM artist_alias aa "
        "WHERE aa.raw_name = songs.artist COLLATE NOCASE), songs.artist)"
    )

    def alias_map(self) -> dict:
        """{raw_name_lower: canonical_name} for every alias — one read to re-label
        a page of grid rows without an N+1. Lowercased keys so the lookup matches
        the raw artist case-insensitively (the table is COLLATE NOCASE)."""
        return {r[0].lower(): r[1] for r in self.conn.execute(
            "SELECT raw_name, canonical_name FROM artist_alias").fetchall()}

    def effective_artist(self, raw: str, amap: dict | None = None) -> str:
        """Canonical display name for a raw artist (alias override else itself)."""
        if raw is None:
            return raw
        amap = self.alias_map() if amap is None else amap
        return amap.get(raw.lower(), raw)

    def _single_hop_canonical(self, name: str) -> str | None:
        """The stored canonical for a raw name (a SINGLE hop), or None if `name`
        is not itself an alias key. Case-insensitive (the table is COLLATE NOCASE)
        — the shared primitive the chain-flatteners reuse."""
        if not name:
            return None
        row = self.conn.execute(
            "SELECT canonical_name FROM artist_alias WHERE raw_name = ? COLLATE NOCASE",
            (name,)).fetchone()
        return row[0] if row else None

    def _terminal_canonical(self, name: str) -> str:
        """Follow the alias chain from `name` to its TERMINAL canonical — the first
        name that is not itself an alias key — so transitive chains (raw → mid →
        … → terminal) collapse to one hop. A visited-set breaks cycles: if we come
        back to a name already seen we return the last name reached rather than
        looping. Reuses the single-hop primitive."""
        seen: set = set()
        cur = name
        while True:
            key = (cur or "").lower()
            if key in seen:
                return cur           # cycle — stop, return where we are
            seen.add(key)
            nxt = self._single_hop_canonical(cur)
            if nxt is None or (nxt or "").lower() == key:
                return cur           # not an alias key (or self) → terminal
            cur = nxt

    def _raw_variants_for(self, canonical: str) -> list:
        """Every raw artist string that should match a filter on `canonical`: the
        canonical name itself plus all raw names aliased to it (case-insensitive).
        Lets the artist filter be `artist IN (...)` — uses the artist index and is
        keyset-safe, instead of a per-row COALESCE subquery."""
        rows = self.conn.execute(
            "SELECT raw_name FROM artist_alias WHERE canonical_name = ? COLLATE NOCASE",
            (canonical,)).fetchall()
        seen, out = set(), []
        for name in [canonical, *[r[0] for r in rows]]:
            k = (name or "").lower()
            if name and k not in seen:
                seen.add(k)
                out.append(name)
        return out

    def list_artist_aliases(self) -> list:
        """All alias rows (raw → canonical), canonical then raw, for the Tidy-up
        'current merges' list."""
        rows = self.conn.execute(
            "SELECT raw_name, canonical_name, mb_artist_id FROM artist_alias "
            "ORDER BY canonical_name COLLATE NOCASE, raw_name COLLATE NOCASE").fetchall()
        return [{"raw_name": r[0], "canonical_name": r[1], "mb_artist_id": r[2]} for r in rows]

    def _set_artist_alias_locked(self, raw_name: str, canonical_name: str,
                                 mb_artist_id: str | None = None) -> dict:
        """Core upsert — assumes self._lock is HELD and does NOT commit (so the
        single set and the batch merge can share one transaction). Flattens chains
        and guards cycles:

        * A self-alias (raw == canonical) DROPs any existing row (the UI un-merge).
        * Otherwise `canonical` is resolved to its TERMINAL canonical, so setting a
          new hop onto an existing chain collapses to one hop rather than growing a
          two-hop chain that grouping/filtering would then split.
        * Cycle guard: if that terminal IS `raw`, storing would loop the chain back
          on itself — we no-op and report it so the caller can surface a failure.
        * Forward-flatten: any existing rows whose canonical == `raw` are re-pointed
          to the new terminal, so previously-merged variants follow `raw` onward.

        Returns a result dict {ok, raw_name, canonical_name, ...}."""
        raw = (raw_name or "").strip()
        canon = (canonical_name or "").strip()
        if not raw or not canon:
            raise ValueError("raw_name and canonical_name are required")
        if raw.lower() == canon.lower():
            self.conn.execute("DELETE FROM artist_alias WHERE raw_name = ? COLLATE NOCASE", (raw,))
            return {"ok": True, "raw_name": raw, "canonical_name": raw, "unmerged": True}
        terminal = self._terminal_canonical(canon)
        if (terminal or "").lower() == raw.lower():
            # raw → … → raw would be a cycle; refuse rather than corrupt the chain.
            return {"ok": False, "reason": "cycle", "raw_name": raw,
                    "canonical_name": canon, "terminal": terminal}
        self.conn.execute(
            "INSERT INTO artist_alias (raw_name, canonical_name, mb_artist_id, updated_at) "
            "VALUES (?, ?, ?, datetime('now')) "
            "ON CONFLICT(raw_name) DO UPDATE SET "
            "canonical_name = excluded.canonical_name, "
            "mb_artist_id = excluded.mb_artist_id, updated_at = excluded.updated_at",
            (raw, terminal, mb_artist_id))
        # Re-point any variants that were previously merged INTO raw onto the new
        # terminal (raw itself now aliases onward, so it can't stay a canonical).
        self.conn.execute(
            "UPDATE artist_alias SET canonical_name = ?, updated_at = datetime('now') "
            "WHERE canonical_name = ? COLLATE NOCASE AND raw_name != ? COLLATE NOCASE",
            (terminal, raw, terminal))
        return {"ok": True, "raw_name": raw, "canonical_name": terminal}

    def set_artist_alias(self, raw_name: str, canonical_name: str,
                         mb_artist_id: str | None = None) -> dict:
        """Upsert one raw→canonical override (chain-flattened, cycle-guarded — see
        _set_artist_alias_locked). Returns the result dict."""
        with self._lock:
            result = self._set_artist_alias_locked(raw_name, canonical_name, mb_artist_id)
            self.conn.commit()
        return result

    def remove_artist_alias(self, raw_name: str) -> None:
        with self._lock:
            self.conn.execute("DELETE FROM artist_alias WHERE raw_name = ? COLLATE NOCASE", (raw_name,))
            self.conn.commit()

    def merge_artists(self, raw_names, canonical_name: str) -> int:
        """Point several raw artist names at one canonical (the Tidy-up merge).
        Skips the canonical's own self-alias. Returns the count of aliases written.
        ATOMIC: the whole batch runs under one lock and one commit, so a mid-batch
        cycle rejection can't leave a half-applied merge."""
        canon = (canonical_name or "").strip()
        if not canon:
            raise ValueError("canonical_name is required")
        n = 0
        with self._lock:
            for raw in (raw_names or []):
                r = (raw or "").strip()
                if r and r.lower() != canon.lower():
                    result = self._set_artist_alias_locked(r, canon)
                    if result.get("ok"):
                        n += 1
            self.conn.commit()
        return n

    def raw_artists(self, limit: int = 2000) -> list:
        """Distinct RAW artist names in the library with song counts + their
        current canonical (for the Tidy-up picker — you merge raw variants). Raw,
        not effective, so both 'ACDC' and 'AC/DC' show as separate mergeable rows."""
        limit = max(1, min(10000, int(limit)))
        amap = self.alias_map()
        rows = self.conn.execute(
            "SELECT artist, COUNT(*) c FROM songs WHERE artist IS NOT NULL AND artist != '' "
            "GROUP BY artist COLLATE NOCASE ORDER BY c DESC, artist COLLATE NOCASE LIMIT ?",
            (limit,)).fetchall()
        return [{"name": r[0], "count": r[1],
                 "canonical": amap.get((r[0] or "").lower(), r[0])} for r in rows]

    # ── Artist pages (launch charrette PR-B) ─────────────────────────────────
    # The artist page is "X *in your library*" — a shelf plus your relationship
    # to it, never a discography browser (locked position 1). Everything here
    # reads LOCAL rows only; the external-links layer (artist_enrichment) is a
    # separate lazy cache keyed by mb_artist_id.

    def artist_known_mb_id(self, variants: list) -> str | None:
        """The artist's MusicBrainz id, if any of their songs' enrichment rows
        carry one. Only `matched`/`manual` rows count (partial coverage is the
        contract — degrade gracefully); the most common id wins so one stray
        wrong match can't out-vote the rest of the shelf."""
        if not variants:
            return None
        ph = ",".join(["?"] * len(variants))
        row = self.conn.execute(
            f"SELECT e.mb_artist_id, COUNT(*) c FROM song_enrichment e "
            f"JOIN songs s ON s.filename = e.filename "
            f"WHERE s.artist COLLATE NOCASE IN ({ph}) "
            f"AND e.match_state IN ('matched', 'manual') "
            f"AND e.mb_artist_id IS NOT NULL AND e.mb_artist_id != '' "
            f"GROUP BY e.mb_artist_id ORDER BY c DESC, e.mb_artist_id LIMIT 1",
            variants).fetchone()
        return row[0] if row else None

    def artist_page(self, name: str) -> dict:
        """The all-LOCAL artist-page payload: canonical name (alias-aware),
        the raw variants it merges, song/album counts, the albums list, the
        mastered count (DENOMINATOR LAW, locked position 2: every number
        counts songs YOU OWN — the WHERE is `artist IN (your variants)` over
        `songs`, never anything external), mb_artist_id when known, header-
        mosaic art, similar-in-library via genre co-occurrence (locked
        position 3: only artists already in the library, empty → hidden), and
        the play-all file list. An unknown name returns a zero-count page (an
        unmatched artist is still a fully functional page)."""
        from urllib.parse import quote
        canonical = self._terminal_canonical((name or "").strip())
        variants = self._raw_variants_for(canonical)
        ph = ",".join(["?"] * len(variants)) if variants else "?"
        rows = self.conn.execute(
            f"SELECT filename, title, album, year, genre FROM songs "
            f"WHERE title != '' AND artist COLLATE NOCASE IN ({ph}) "
            f"ORDER BY album COLLATE NOCASE, (track_number IS NULL) ASC, "
            f"COALESCE(disc, 1), track_number, title COLLATE NOCASE",
            variants or [canonical]).fetchall()
        # Albums: distinct non-empty album names in shelf order, each with the
        # earliest authored year, a track count, and a representative cover
        # song (the first row → also the mosaic's source).
        albums: dict = {}
        album_order: list = []
        for fn, _t, album, year, _g in rows:
            key = (album or "").strip()
            if not key:
                continue
            k = key.lower()
            if k not in albums:
                albums[k] = {"name": key, "year": (year or ""), "count": 0, "cover": fn}
                album_order.append(k)
            albums[k]["count"] += 1
            if not albums[k]["year"] and year:
                albums[k]["year"] = year
        album_list = [albums[k] for k in album_order]
        # "also shown as": the raw variants actually present in the library
        # (the canonical itself is the headline, so it's excluded).
        vrows = self.conn.execute(
            f"SELECT artist, COUNT(*) FROM songs "
            f"WHERE title != '' AND artist COLLATE NOCASE IN ({ph}) "
            f"GROUP BY artist COLLATE NOCASE ORDER BY COUNT(*) DESC",
            variants or [canonical]).fetchall()
        shown_as = [{"name": r[0], "count": r[1]} for r in vrows
                    if (r[0] or "").lower() != (canonical or "").lower()]
        # Mastered / practice presence — over THIS artist's library songs only.
        mastered = 0
        has_stats = False
        fns = [r[0] for r in rows]
        if fns:
            fph = ",".join(["?"] * len(fns))
            srows = self.conn.execute(
                f"SELECT filename, MAX(best_accuracy) FROM song_stats "
                f"WHERE filename IN ({fph}) GROUP BY filename", fns).fetchall()
            has_stats = len(srows) > 0
            mastered = sum(1 for _fn, acc in srows
                           if acc is not None and acc >= MASTERY_ACCURACY)
        # Similar in your library: other artists sharing songs.genre values,
        # ranked by distinct shared genres then by how many of their songs sit
        # in those genres. Raw artist rows are folded through the alias map so
        # "ACDC" and "AC/DC" rank as one artist; self is excluded either way.
        genres = sorted({(r[4] or "").strip().lower() for r in rows} - {""})
        similar: list = []
        if genres:
            gph = ",".join(["?"] * len(genres))
            grows = self.conn.execute(
                f"SELECT artist, COUNT(DISTINCT lower(genre)), COUNT(*) FROM songs "
                f"WHERE title != '' AND genre != '' AND lower(genre) IN ({gph}) "
                f"AND artist IS NOT NULL AND artist != '' "
                f"GROUP BY artist COLLATE NOCASE", genres).fetchall()
            amap = self.alias_map()
            agg: dict = {}
            for raw, shared, n in grows:
                canon = amap.get((raw or "").lower(), raw)
                if (canon or "").lower() == (canonical or "").lower():
                    continue
                cur = agg.setdefault((canon or "").lower(),
                                     {"artist": canon, "shared_genres": 0, "count": 0})
                cur["shared_genres"] = max(cur["shared_genres"], shared)
                cur["count"] += n
            similar = sorted(
                agg.values(),
                key=lambda a: (-a["shared_genres"], -a["count"], (a["artist"] or "").lower())
            )[:5]
        # Header mosaic (locked position 10: MB hosts no artist images — the
        # default is a mosaic of OWNED album art via the playlist-cover
        # grammar): one representative song per album first, then fill from
        # the remaining songs, up to 4.
        seen: set = set()
        art_files: list = []
        for al in album_list:
            if al["cover"] not in seen:
                seen.add(al["cover"])
                art_files.append(al["cover"])
            if len(art_files) >= 4:
                break
        if len(art_files) < 4:
            for fn in fns:
                if fn not in seen:
                    seen.add(fn)
                    art_files.append(fn)
                if len(art_files) >= 4:
                    break
        return {
            "artist": canonical,
            "variants": shown_as,
            "song_count": len(rows),
            "album_count": len(album_list),
            "mastered_count": mastered,
            "has_stats": has_stats,
            "albums": album_list,
            "mb_artist_id": self.artist_known_mb_id(variants),
            "similar": similar,
            "art_urls": [f"/api/song/{quote(fn)}/art" for fn in art_files],
            # Play-all seed (album/track order, same as the rows above).
            # Bounded so a pathological library can't balloon the payload.
            "files": fns[:1000],
        }

    def get_artist_enrichment(self, mb_artist_id: str) -> dict | None:
        """Cached artist-level enrichment row, JSON fields parsed (bad/legacy
        JSON degrades to empty rather than 500ing the links route)."""
        row = self.conn.execute(
            "SELECT mb_artist_id, url_rels, genres, fetched_at "
            "FROM artist_enrichment WHERE mb_artist_id = ?",
            (mb_artist_id,)).fetchone()
        if not row:
            return None

        def _parsed(raw, fallback):
            try:
                v = json.loads(raw) if raw else fallback
            except (TypeError, ValueError):
                return fallback
            return v if isinstance(v, type(fallback)) else fallback

        return {"mb_artist_id": row[0], "url_rels": _parsed(row[1], {}),
                "genres": _parsed(row[2], []), "fetched_at": row[3]}

    def put_artist_enrichment(self, mb_artist_id: str, url_rels: dict,
                              genres: list) -> None:
        """Store (or refresh) the one artist-level cache row."""
        with self._lock:
            self.conn.execute(
                "INSERT OR REPLACE INTO artist_enrichment "
                "(mb_artist_id, url_rels, genres, fetched_at) "
                "VALUES (?, ?, ?, strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))",
                (mb_artist_id, json.dumps(url_rels or {}), json.dumps(genres or [])))
            self.conn.commit()

    def record_session(self, filename: str, arrangement: int, *, score: int,
                       accuracy: float, last_position=None, seconds: float = 0) -> dict:
        """Record a scored play: plays += 1, best_* = max, last_* = new.
        `seconds` (wall-clock play time from the recorder) accrues."""
        from song_score import merge_stats
        with self._lock:
            existing = self._stats_row(filename, int(arrangement))
            merged = merge_stats(existing, {
                "score": score, "accuracy": accuracy, "last_position": last_position,
            })
            self.conn.execute(
                """INSERT INTO song_stats
                       (filename, arrangement, plays, best_score, best_accuracy,
                        last_score, last_accuracy, last_position, seconds_total,
                        last_played_at, updated_at)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?,
                           strftime('%Y-%m-%d %H:%M:%f','now'), strftime('%Y-%m-%d %H:%M:%f','now'))
                   ON CONFLICT(filename, arrangement) DO UPDATE SET
                       plays = excluded.plays,
                       best_score = excluded.best_score,
                       best_accuracy = excluded.best_accuracy,
                       last_score = excluded.last_score,
                       last_accuracy = excluded.last_accuracy,
                       last_position = excluded.last_position,
                       seconds_total = song_stats.seconds_total + excluded.seconds_total,
                       last_played_at = excluded.last_played_at,
                       updated_at = excluded.updated_at""",
                (filename, int(arrangement), merged["plays"], merged["best_score"],
                 merged["best_accuracy"], merged["last_score"], merged["last_accuracy"],
                 merged["last_position"], float(seconds or 0)),
            )
            self.conn.commit()
        return self._stats_row(filename, int(arrangement))

    def touch_position(self, filename: str, arrangement: int, last_position: float,
                       seconds: float = 0) -> dict:
        """Persist just the resume position (no plays/score change), so
        Continue-Playing works for non-scored plays. Also stamps
        last_played_at — both /api/stats/recent and /api/session/continue
        filter/order on it, so a position-only touch must set it or the song
        never surfaces as 'recent' / 'continue playing'. `seconds` accrues
        wall-clock play time (career hours odometer)."""
        with self._lock:
            self.conn.execute(
                """INSERT INTO song_stats (filename, arrangement, last_position,
                                           seconds_total, last_played_at, updated_at)
                   VALUES (?, ?, ?, ?, strftime('%Y-%m-%d %H:%M:%f','now'),
                           strftime('%Y-%m-%d %H:%M:%f','now'))
                   ON CONFLICT(filename, arrangement) DO UPDATE SET
                       last_position = excluded.last_position,
                       seconds_total = song_stats.seconds_total + excluded.seconds_total,
                       last_played_at = excluded.last_played_at,
                       updated_at = excluded.updated_at""",
                (filename, int(arrangement), float(last_position), float(seconds or 0)),
            )
            self.conn.commit()
        return self._stats_row(filename, int(arrangement))

    def add_play_seconds(self, filename: str, arrangement: int, seconds: float) -> dict:
        """Accrue wall-clock play time (no plays/score/position change) —
        the recorder's seconds-only flush for unscored plays that ran to the
        song's natural end (no resume position to touch there: `song:ended`
        must not overwrite Continue with the end-of-song offset). Stamps
        last_played_at like touch_position does: the song WAS played, so
        /api/stats/recent and Continue ordering must see it. Accepted skew:
        the recorder retries FAILED flushes later, which stamps recency at
        retry time — rare (offline corner), self-healing on the next play,
        and preferable to the alternative (keep-existing would leave repeat
        plays looking stale, the common case)."""
        with self._lock:
            self.conn.execute(
                """INSERT INTO song_stats (filename, arrangement, seconds_total,
                                           last_played_at, updated_at)
                   VALUES (?, ?, ?, strftime('%Y-%m-%d %H:%M:%f','now'),
                           strftime('%Y-%m-%d %H:%M:%f','now'))
                   ON CONFLICT(filename, arrangement) DO UPDATE SET
                       seconds_total = song_stats.seconds_total + excluded.seconds_total,
                       last_played_at = excluded.last_played_at,
                       updated_at = excluded.updated_at""",
                (filename, int(arrangement), float(seconds)),
            )
            self.conn.commit()
        return self._stats_row(filename, int(arrangement))

    def get_song_stats(self, filename: str) -> dict:
        """Best/last/plays across all arrangements of a song, plus per-arrangement rows."""
        rows = self.conn.execute(
            "SELECT " + ", ".join(self._STATS_COLS) +
            " FROM song_stats WHERE filename = ? ORDER BY arrangement",
            (filename,),
        ).fetchall()
        arr = [dict(zip(self._STATS_COLS, r)) for r in rows]
        best_acc = max((a["best_accuracy"] for a in arr), default=0.0)
        best_score = max((a["best_score"] for a in arr), default=0)
        plays = sum(a["plays"] for a in arr)
        return {
            "filename": filename,
            "best_accuracy": best_acc,
            "best_score": best_score,
            "plays": plays,
            "arrangements": arr,
        }

    def recent_stats(self, limit: int = 12) -> list[dict]:
        """Recently-played rows (most recent first) for 'Jump back in'."""
        limit = max(1, min(100, int(limit)))
        rows = self.conn.execute(
            "SELECT " + ", ".join(self._STATS_COLS) +
            " FROM song_stats WHERE last_played_at IS NOT NULL " +
            self._existing_song_filter() +
            "ORDER BY last_played_at DESC LIMIT ?",
            (limit,),
        ).fetchall()
        return [dict(zip(self._STATS_COLS, r)) for r in rows]

    def best_accuracy_map(self) -> dict:
        """{filename: best_accuracy} across all arrangements, for batch-badging
        the library grid in one request. Includes every SCORED song (plays > 0)
        — even a genuine 0% best — but excludes resume-only rows (plays == 0,
        which carry a default best_accuracy of 0 and shouldn't badge)."""
        rows = self.conn.execute(
            "SELECT filename, MAX(best_accuracy), SUM(plays) FROM song_stats "
            "WHERE 1=1 " + self._existing_song_filter() +   # skip dead songs (race-free)
            "GROUP BY filename"
        ).fetchall()
        return {r[0]: r[1] for r in rows if r[2] and r[2] > 0}

    def top_stats(self, limit: int = 5) -> list[dict]:
        """Top scored songs (best score first) for the profile 'Your best
        scores' panel. Aggregated per-song across arrangements (best score,
        best accuracy, total plays), only SCORED songs (plays > 0), dead songs
        skipped. Mirrors best_accuracy_map's grouping; enriched with metadata
        by the /api/stats/top route."""
        limit = max(1, min(50, int(limit)))
        rows = self.conn.execute(
            "SELECT filename, MAX(best_score), MAX(best_accuracy), SUM(plays) "
            "FROM song_stats WHERE 1=1 " + self._existing_song_filter() +   # skip dead songs
            "GROUP BY filename HAVING SUM(plays) > 0 "
            "ORDER BY MAX(best_score) DESC, MAX(best_accuracy) DESC LIMIT ?",
            (limit,),
        ).fetchall()
        return [
            {"filename": r[0], "best_score": r[1], "best_accuracy": r[2], "plays": r[3]}
            for r in rows
        ]

    # ── FUTURE ENHANCEMENT (revisit once the feedpak difficulty spec is locked) ──
    # The library-metadata design (§8) calls for user-difficulty to be
    # PER-ARRANGEMENT ("easy on bass ≠ easy on lead") and SEEDED FROM the authored/
    # derived difficulty so it's never blank. Neither ships here on purpose:
    #   • personal difficulty is currently per-FILENAME (P1's song_user_meta);
    #     per-arrangement is a P1-schema + Details-drawer (P2) re-scope; and
    #   • there is NO authored/derived difficulty field on `songs` yet — that waits
    #     on the feedpak difficulty spec (the #37-family FEP), which is unmerged.
    # So this recommender ships the growth-edge PAYOFF now and degrades gracefully
    # (an unrated song is treated as mid). When the feedpak difficulty field lands,
    # revisit: (1) seed unset user-difficulty from authored instead of assuming mid,
    # and (2) score per (filename, arrangement) rather than per song.
    @staticmethod
    def _growth_edge_score(best_accuracy: float, user_difficulty) -> float:
        """The 'practice next' score = difficulty-appropriateness × proximity to
        mastery. Peaks where a song is BOTH at a productive challenge level (the
        mid difficulty band) AND close to — but not yet at — mastery (the
        goal-gradient push). An UNSET personal difficulty is treated as mid, so
        the recommender still works before anything is rated (it degrades to
        closest-to-mastery-first) — see P3 notes: authored/derived difficulty
        seeding waits on the feedpak difficulty spec.

        diff_weight: 3 → 1.0, 2/4 → 0.8, 1/5 → 0.6 (extremes deprioritized, never
        zeroed — you grow on the challenging middle, not the trivially easy or the
        frustratingly hard). Never writes anything."""
        d = user_difficulty if user_difficulty is not None else 3
        weight = 1.0 - abs(d - 3) * 0.2
        return weight * (best_accuracy or 0.0)

    def growth_edge_suggestions(self, limit: int = 8) -> list[dict]:
        """Attempted-but-not-yet-mastered songs ranked by the growth-edge score —
        the 'Keep practicing' recommender that replaces recency-only ordering.
        Song-level (best accuracy across arrangements, like the badge); the
        suggested `arrangement` is the one you're closest to mastering, so the
        shelf opens the version worth pushing. Read-only."""
        limit = max(1, min(24, int(limit)))
        rows = self.conn.execute(
            "SELECT filename, arrangement, best_accuracy, plays, last_played_at "
            "FROM song_stats WHERE 1=1 " + self._existing_song_filter()
        ).fetchall()
        # Aggregate per song: best accuracy + the arrangement that owns it, total
        # plays, most-recent play (used as a stable tiebreak).
        agg: dict = {}
        for fn, arr, acc, plays, lp in rows:
            a = agg.get(fn)
            if a is None:
                a = agg[fn] = {"acc": None, "arr": 0, "plays": 0, "lp": None}
            a["plays"] += (plays or 0)
            if acc is not None and (a["acc"] is None or acc > a["acc"]):
                a["acc"] = acc
                a["arr"] = arr
            if lp and (not a["lp"] or lp > a["lp"]):
                a["lp"] = lp
        cands = [(fn, a) for fn, a in agg.items()
                 if a["plays"] > 0 and a["acc"] is not None and a["acc"] < MASTERY_ACCURACY]
        if not cands:
            # Two different empties (launch polish): attempts exist but
            # everything attempted is mastered → an empty shelf is honest;
            # NOTHING attempted yet (day one) → "starter" picks instead, so
            # the library home invites a first play rather than dead-ending.
            if any(a["plays"] > 0 and a["acc"] is not None for a in agg.values()):
                return []
            return self.starter_suggestions(limit)
        diffs = self.user_meta_map([fn for fn, _ in cands])   # {filename: 1..5}
        out = []
        for fn, a in cands:
            d = diffs.get(fn)
            out.append({
                "filename": fn,
                "best_accuracy": a["acc"],
                "arrangement": a["arr"],
                "last_played_at": a["lp"],
                "user_difficulty": d,
                "growth_score": round(self._growth_edge_score(a["acc"], d), 6),
            })
        out.sort(key=lambda r: (r["growth_score"], r["last_played_at"] or "", r["filename"]), reverse=True)
        return out[:limit]

    def starter_suggestions(self, limit: int = 8) -> list[dict]:
        """Day-one 'Start here' picks for a library with no practice attempts
        yet: up to 8 approachable songs — sensible length (90s–480s, so intros/
        jingles and 10-minute epics don't lead), shortest first, filename as a
        stable tiebreak. Same row shape as the growth-edge rows plus a
        `starter: true` marker so the client renders the invitational 'Start
        here' shelf instead of 'Keep practicing'. Read-only."""
        limit = max(1, min(8, int(limit)))
        rows = self.conn.execute(
            "SELECT filename FROM songs WHERE title != '' "
            "AND duration >= 90 AND duration <= 480 "
            "ORDER BY duration ASC, filename ASC LIMIT ?", (limit,)).fetchall()
        return [{
            "filename": r[0],
            "best_accuracy": None,
            "arrangement": None,
            "last_played_at": None,
            "user_difficulty": None,
            "growth_score": 0.0,
            "starter": True,
        } for r in rows]

    # ── Playlists ─────────────────────────────────────────────────────────--
    SAVED_KEY = "saved_for_later"

    def _playlist_count(self, pid: int, kind: str | None = None) -> int:
        # An ALBUM keeps every slot in its denominator: get_playlist renders /
        # plays ALL slots — self-healing orphans and even fully-missing works
        # (§7.2) stay visible — so the list-card count must agree with the detail
        # view and skip the dead-filter (is_album → no `AND s.filename IS NOT
        # NULL`, mirroring get_playlist). Mixes/other kinds count only songs that
        # still exist (mirrors the stats read-filter — dead songs are hidden, not
        # deleted on scan), passing through when the songs table is empty. Single
        # statement → no probe-then-read race. `kind` is passed by list_playlists
        # (already in hand); fetched here when a caller omits it.
        if kind is None:
            row = self.conn.execute(
                "SELECT kind FROM playlists WHERE id = ?", (pid,)
            ).fetchone()
            kind = row[0] if row else None
        if kind == "album":
            return self.conn.execute(
                "SELECT COUNT(*) FROM playlist_songs WHERE playlist_id = ?",
                (pid,),
            ).fetchone()[0]
        return self.conn.execute(
            "SELECT COUNT(*) FROM playlist_songs ps WHERE ps.playlist_id = ? "
            "AND EXISTS (SELECT 1 FROM songs s WHERE s.filename = ps.filename)",
            (pid,),
        ).fetchone()[0]

    def arrangement_count(self, filename: str):
        """Number of arrangements for a song, or None if the song isn't in the
        library (so callers can skip validation when it can't be checked)."""
        row = self.conn.execute("SELECT arrangements FROM songs WHERE filename = ?", (filename,)).fetchone()
        if not row or not row[0]:
            return None
        try:
            arr = json.loads(row[0])
        except (ValueError, TypeError):
            return None
        return len(arr) if isinstance(arr, list) else None

    def arrangement_entry(self, filename: str, index: int):
        """One arrangement's metadata dict for a library song, or None when
        the song/index is unknown (progression then falls back to guitar)."""
        row = self.conn.execute("SELECT arrangements FROM songs WHERE filename = ?", (filename,)).fetchone()
        if not row or not row[0]:
            return None
        try:
            arr = json.loads(row[0])
        except (ValueError, TypeError):
            return None
        if isinstance(arr, list) and 0 <= index < len(arr) and isinstance(arr[index], dict):
            return arr[index]
        return None

    def list_playlists(self) -> list[dict]:
        from urllib.parse import quote
        # Order: system playlists pinned first, then manually positioned user
        # playlists (position = drag order), then unpositioned ones
        # alphabetically — so a manual order wins and a playlist created after
        # a reorder still lands somewhere predictable (see reorder_playlists).
        rows = self.conn.execute(
            "SELECT id, name, system_key, created_at, updated_at, kind FROM playlists "
            "WHERE rules IS NULL "          # smart collections live in the source picker, not here
            "ORDER BY (system_key IS NULL), (position IS NULL), position, name COLLATE NOCASE"
        ).fetchall()
        out = []
        for r in rows:
            pid = r[0]
            # First few still-present songs (in order) → art URLs, for a
            # content-dependent playlist cover (single art / 2x2 mosaic). The
            # JOIN drops dead songs, matching get_playlist's visibility.
            arts = self.conn.execute(
                "SELECT ps.filename FROM playlist_songs ps "
                "JOIN songs s ON s.filename = ps.filename "
                "WHERE ps.playlist_id = ? ORDER BY ps.position LIMIT 4",
                (pid,),
            ).fetchall()
            out.append({
                "id": pid, "name": r[1], "system_key": r[2],
                "created_at": r[3], "updated_at": r[4], "kind": r[5],
                "count": self._playlist_count(pid, r[5]),
                "art_urls": [f"/api/song/{quote(a[0])}/art" for a in arts],
            })
        return out

    def create_playlist(self, name: str, system_key: str | None = None,
                        kind: str | None = None) -> dict:
        with self._lock:
            cur = self.conn.execute(
                "INSERT INTO playlists (name, system_key, kind, created_at, updated_at) "
                "VALUES (?, ?, ?, datetime('now'), datetime('now'))",
                (name, system_key, kind),
            )
            self.conn.commit()
            pid = cur.lastrowid
        return self.get_playlist(pid)

    def saved_playlist_id(self) -> int:
        """Id of the reserved Saved-for-Later playlist, created on first use.
        Tolerates a create race: two concurrent first-use toggles can both see
        no row and try to insert; the unique system_key index makes the loser
        raise IntegrityError, so catch it and re-read the winner's row rather
        than 500."""
        row = self.conn.execute(
            "SELECT id FROM playlists WHERE system_key = ?", (self.SAVED_KEY,)
        ).fetchone()
        if row:
            return row[0]
        try:
            return self.create_playlist("Saved for Later", self.SAVED_KEY)["id"]
        except sqlite3.IntegrityError:
            row = self.conn.execute(
                "SELECT id FROM playlists WHERE system_key = ?", (self.SAVED_KEY,)
            ).fetchone()
            if row:
                return row[0]
            raise

    def rename_playlist(self, pid: int, name: str) -> bool:
        with self._lock:
            cur = self.conn.execute(
                "UPDATE playlists SET name = ?, updated_at = datetime('now') WHERE id = ?",
                (name, pid),
            )
            self.conn.commit()
            return cur.rowcount > 0

    def delete_playlist(self, pid: int) -> bool:
        """Delete a user playlist (system playlists are protected — caller checks)."""
        with self._lock:
            self.conn.execute("DELETE FROM playlist_songs WHERE playlist_id = ?", (pid,))
            cur = self.conn.execute("DELETE FROM playlists WHERE id = ?", (pid,))
            self.conn.commit()
            return cur.rowcount > 0

    # ── Smart collections (feedBack#636 item 2) ───────────────────────────
    @staticmethod
    def _collection_row(r) -> dict:
        rules = {}
        if r[3]:
            try:
                parsed = json.loads(r[3])
                if isinstance(parsed, dict):
                    rules = parsed
            except (ValueError, TypeError):
                rules = {}
        return {"id": r[0], "name": r[1], "system_key": r[2], "rules": rules,
                "created_at": r[4], "updated_at": r[5]}

    def is_collection(self, pid: int) -> bool:
        row = self.conn.execute(
            "SELECT rules IS NOT NULL FROM playlists WHERE id = ?", (pid,)
        ).fetchone()
        return bool(row and row[0])

    def list_collections(self) -> list[dict]:
        rows = self.conn.execute(
            "SELECT id, name, system_key, rules, created_at, updated_at FROM playlists "
            "WHERE rules IS NOT NULL ORDER BY name COLLATE NOCASE"
        ).fetchall()
        return [self._collection_row(r) for r in rows]

    def get_collection(self, pid: int) -> dict | None:
        r = self.conn.execute(
            "SELECT id, name, system_key, rules, created_at, updated_at FROM playlists "
            "WHERE id = ? AND rules IS NOT NULL", (pid,)
        ).fetchone()
        return self._collection_row(r) if r else None

    def create_collection(self, name: str, rules: dict) -> dict:
        with self._lock:
            cur = self.conn.execute(
                "INSERT INTO playlists (name, system_key, rules, created_at, updated_at) "
                "VALUES (?, NULL, ?, datetime('now'), datetime('now'))",
                (name, json.dumps(rules or {})),
            )
            self.conn.commit()
            pid = cur.lastrowid
        return self.get_collection(pid)

    def update_collection(self, pid: int, name: str | None = None,
                          rules: dict | None = None) -> dict | None:
        if not self.is_collection(pid):
            return None
        with self._lock:
            if name is not None:
                self.conn.execute("UPDATE playlists SET name = ? WHERE id = ?", (name, pid))
            if rules is not None:
                self.conn.execute("UPDATE playlists SET rules = ? WHERE id = ?",
                                  (json.dumps(rules or {}), pid))
            self.conn.execute("UPDATE playlists SET updated_at = datetime('now') WHERE id = ?", (pid,))
            self.conn.commit()
        return self.get_collection(pid)

    def get_playlist(self, pid: int) -> dict | None:
        # A path-param int outside SQLite's 64-bit range raises OverflowError at
        # bind time (→ 500). Treat it as a miss; every mutating playlist handler
        # gates on this first, so the guard covers them too.
        if not isinstance(pid, int) or not (-(2**63) <= pid < 2**63):
            return None
        # `rules IS NULL` excludes smart collections (#636 item 2): they share
        # the playlists table but their membership is rules-based, so every
        # manual-playlist mutation (add/remove/reorder/cover) that gates on
        # get_playlist uniformly 404s on a collection id — collections are
        # managed only through /api/collections.
        head = self.conn.execute(
            "SELECT id, name, system_key, created_at, updated_at, kind FROM playlists "
            "WHERE id = ? AND rules IS NULL", (pid,)
        ).fetchone()
        if not head:
            return None
        is_album = head[5] == "album"
        # Mixes hide dead songs (race-free; not deleted on scan). An ALBUM keeps
        # every slot: a slot whose pinned chart was deleted self-heals to the
        # work's current preferred at READ (§7.2 orphan-at-play — never a
        # membership rewrite), and reports `missing` when the whole work is gone
        # so the practice set keeps its denominator visible.
        dead_filter = "" if is_album else "AND s.filename IS NOT NULL"
        rows = self.conn.execute(
            f"""SELECT ps.filename, ps.position, s.title, s.artist, s.tuning_name,
                       ps.arrangement, ps.work_key, s.arrangements,
                       (s.filename IS NULL) AS dead, s.tuning_offsets,
                       s.bass_tuning_name, s.bass_tuning_offsets,
                       s.rhythm_tuning_name, s.rhythm_tuning_offsets
               FROM playlist_songs ps LEFT JOIN songs s ON s.filename = ps.filename
               WHERE ps.playlist_id = ? {dead_filter}
               ORDER BY ps.position, ps.filename""",
            (pid,),
        ).fetchall()
        from urllib.parse import quote
        songs = []
        for r in rows:
            entry = {
                "filename": r[0], "position": r[1],
                "title": r[2] or r[0], "artist": r[3] or "", "tuning_name": r[4] or "",
                # Offsets + the bass-only flag let the playlist tuning check score a
                # row against the player's working tuning the same way the library
                # grid's chips do: a NAME alone can't be scored (two "Custom Tuning"
                # rows are different tunings), and coverage needs to know whether to
                # measure against bass or guitar base pitches.
                "tuning_offsets": r[9] or "",
                "bass_tuning_name": r[10] or "",
                "bass_tuning_offsets": r[11] or "",
                "rhythm_tuning_name": r[12] or "",
                "rhythm_tuning_offsets": r[13] or "",
                "bass_only": _arrangements_all_bass(r[7]),
                "art_url": f"/api/song/{quote(r[0])}/art",
            }
            if is_album:
                entry["arrangement"] = r[5]
                entry["work_key"] = r[6]
                try:
                    entry["arrangements"] = _ensure_smart_names(json.loads(r[7]) if r[7] else [])
                except Exception:
                    entry["arrangements"] = []
                if r[8]:
                    entry.update(self._resolve_album_orphan(r[6]))
            songs.append(entry)
        return {
            "id": head[0], "name": head[1], "system_key": head[2],
            "created_at": head[3], "updated_at": head[4], "songs": songs,
            **({"kind": head[5]} if head[5] else {}),
        }

    def _resolve_album_orphan(self, work_key: str | None) -> dict:
        """A deleted album slot resolves to its work's CURRENT preferred/auto
        pick at read (§7.2): the slot plays `resolved_filename` today, and if
        the pinned file reappears (rescan) it simply resolves back to itself —
        no rewrite in either direction. A work with no charts left reports
        `missing` (the row stays, dimmed, so the set's denominator is honest)."""
        if work_key:
            self._ensure_work_display()
            row = self.conn.execute(
                "SELECT wd.filename, s.title, s.artist, s.tuning_name, s.arrangements, "
                "s.tuning_offsets, s.bass_tuning_name, s.bass_tuning_offsets, "
                "s.rhythm_tuning_name, s.rhythm_tuning_offsets "
                "FROM work_display wd JOIN songs s ON s.filename = wd.filename "
                "WHERE wd.effective_work_key = ? AND wd.is_group_representative = 1",
                (work_key,)).fetchone()
            if row:
                from urllib.parse import quote
                try:
                    arrs = _ensure_smart_names(json.loads(row[4]) if row[4] else [])
                except Exception:
                    arrs = []
                # An orphan-resolved slot PLAYS a different chart, so it must report
                # that chart's tuning to the check — not the dead pin's.
                return {"resolved_filename": row[0], "title": row[1] or row[0],
                        "artist": row[2] or "", "tuning_name": row[3] or "",
                        "tuning_offsets": row[5] or "",
                        "bass_tuning_name": row[6] or "",
                        "bass_tuning_offsets": row[7] or "",
                        "rhythm_tuning_name": row[8] or "",
                        "rhythm_tuning_offsets": row[9] or "",
                        "bass_only": _arrangements_all_bass(row[4]),
                        "arrangements": arrs,
                        "art_url": f"/api/song/{quote(row[0])}/art",
                        "resolved_from_orphan": True}
        return {"missing": True}

    def add_playlist_song(self, pid: int, filename: str):
        with self._lock:
            # Re-check existence INSIDE the lock: the handler's earlier 404 check
            # is a separate step, so a concurrent delete_playlist could land
            # between them and leave an orphan playlist_songs row. Returning None
            # lets the handler answer 404 instead of inserting an orphan.
            row = self.conn.execute("SELECT kind FROM playlists WHERE id = ?", (pid,)).fetchone()
            if not row:
                return None
            # Album slots stamp the work identity at ADD time (§7.2 "resolved to
            # preferred once at add, pinned thereafter") — it's what lets a
            # later-deleted chart's slot self-heal to the work's current keeper.
            wk = self.work_key_for(filename) if row[0] == "album" else None
            nxt = self.conn.execute(
                "SELECT COALESCE(MAX(position), -1) + 1 FROM playlist_songs WHERE playlist_id = ?", (pid,)
            ).fetchone()[0]
            cur = self.conn.execute(
                "INSERT OR IGNORE INTO playlist_songs (playlist_id, filename, position, work_key) "
                "VALUES (?, ?, ?, ?)",
                (pid, filename, nxt, wk),
            )
            self.conn.execute("UPDATE playlists SET updated_at = datetime('now') WHERE id = ?", (pid,))
            self.conn.commit()
            return cur.rowcount > 0

    _SLOT_KEEP = object()   # sentinel: "leave the arrangement pin unchanged"

    def update_playlist_slot(self, pid: int, filename: str,
                             new_filename: str | None = None,
                             arrangement=_SLOT_KEEP):
        """Edit ONE album slot in place (§7.2): pin/clear its arrangement (a
        NAME — names survive rescans; None clears back to full-song) and/or swap
        the slot's chart for another chart of the SAME work, keeping position +
        pin — the per-slot pick is deliberately independent of the work's
        global preferred. Returns the slot's (possibly new) filename, or None
        when the slot doesn't exist, the swap target isn't a chart of the
        slot's work, or it's already in the playlist."""
        with self._lock:
            row = self.conn.execute(
                "SELECT position, work_key FROM playlist_songs "
                "WHERE playlist_id = ? AND filename = ?", (pid, filename)).fetchone()
            if not row:
                return None
            out_fn = filename
            if new_filename and new_filename != filename:
                # Same-work guard: the stored stamp wins (works even when the
                # pinned file is gone); fall back to computing from the row.
                wk_slot = row[1] or self.work_key_for(filename)
                if not wk_slot or self.work_key_for(new_filename) != wk_slot:
                    return None
                if self.conn.execute(
                        "SELECT 1 FROM playlist_songs WHERE playlist_id = ? AND filename = ?",
                        (pid, new_filename)).fetchone():
                    return None
                self.conn.execute(
                    "UPDATE playlist_songs SET filename = ?, work_key = ? "
                    "WHERE playlist_id = ? AND filename = ?",
                    (new_filename, wk_slot, pid, filename))
                out_fn = new_filename
            if arrangement is not self._SLOT_KEEP:
                self.conn.execute(
                    "UPDATE playlist_songs SET arrangement = ? "
                    "WHERE playlist_id = ? AND filename = ?",
                    (arrangement, pid, out_fn))
            self.conn.execute("UPDATE playlists SET updated_at = datetime('now') WHERE id = ?", (pid,))
            self.conn.commit()
        return out_fn

    def remove_playlist_song(self, pid: int, filename: str) -> bool:
        with self._lock:
            cur = self.conn.execute(
                "DELETE FROM playlist_songs WHERE playlist_id = ? AND filename = ?", (pid, filename)
            )
            self.conn.execute("UPDATE playlists SET updated_at = datetime('now') WHERE id = ?", (pid,))
            self.conn.commit()
            return cur.rowcount > 0

    def reorder_playlist(self, pid: int, ordered_filenames: list[str]) -> bool:
        with self._lock:
            for pos, fn in enumerate(ordered_filenames):
                self.conn.execute(
                    "UPDATE playlist_songs SET position = ? WHERE playlist_id = ? AND filename = ?",
                    (pos, pid, fn),
                )
            self.conn.execute("UPDATE playlists SET updated_at = datetime('now') WHERE id = ?", (pid,))
            self.conn.commit()
        return True

    def reorder_playlists(self, ordered_ids: list[int]) -> bool:
        """Persist a manual ordering of the playlists THEMSELVES: position =
        index in `ordered_ids` (the songs-within sibling is reorder_playlist).
        Caller (the route) validates the list is an exact permutation of the
        current non-system playlist ids."""
        with self._lock:
            for pos, pid in enumerate(ordered_ids):
                self.conn.execute(
                    "UPDATE playlists SET position = ?, updated_at = datetime('now') WHERE id = ?",
                    (pos, pid),
                )
            self.conn.commit()
        return True

    def clear_playlist_positions(self) -> bool:
        """Drop every manual playlist position → back to alphabetical
        (the "Sort A–Z" affordance)."""
        with self._lock:
            self.conn.execute(
                "UPDATE playlists SET position = NULL, updated_at = datetime('now') "
                "WHERE position IS NOT NULL")
            self.conn.commit()
        return True

    def toggle_saved(self, filename: str) -> bool:
        """Add/remove a song on the Saved-for-Later playlist. Returns new state.
        The presence check and the add/remove run under one lock so two
        concurrent toggles of the same song can't both take the add path (or
        both remove) and leave an inconsistent saved state."""
        pid = self.saved_playlist_id()
        with self._lock:
            present = self.conn.execute(
                "SELECT 1 FROM playlist_songs WHERE playlist_id = ? AND filename = ?", (pid, filename)
            ).fetchone() is not None
            if present:
                self.conn.execute(
                    "DELETE FROM playlist_songs WHERE playlist_id = ? AND filename = ?", (pid, filename))
                new_state = False
            else:
                nxt = self.conn.execute(
                    "SELECT COALESCE(MAX(position), -1) + 1 FROM playlist_songs WHERE playlist_id = ?", (pid,)
                ).fetchone()[0]
                self.conn.execute(
                    "INSERT OR IGNORE INTO playlist_songs (playlist_id, filename, position) VALUES (?, ?, ?)",
                    (pid, filename, nxt))
                new_state = True
            self.conn.execute("UPDATE playlists SET updated_at = datetime('now') WHERE id = ?", (pid,))
            self.conn.commit()
        return new_state

    # ── Wishlist / "wanted" (feedBack#636 item 4) ─────────────────────────
    _WANTED_COLS = ("id", "artist", "title", "source", "source_ref", "note", "created_at")

    def add_wanted(self, artist: str, title: str, source: str = "manual",
                   source_ref: str = "", note: str = "") -> dict:
        """Add a not-owned song to the wishlist (or return the existing row if
        an entry with the same identity is already wanted — idempotent, so a
        re-run of an ownership-diff doesn't duplicate). Returns the row."""
        artist = (artist or "").strip()
        title = (title or "").strip()
        source = (source or "manual").strip() or "manual"
        source_ref = (source_ref or "").strip()
        note = (note or "").strip()
        with self._lock:
            self.conn.execute(
                "INSERT OR IGNORE INTO wanted (artist, title, source, source_ref, note, created_at) "
                "VALUES (?, ?, ?, ?, ?, datetime('now'))",
                (artist, title, source, source_ref, note),
            )
            row = self.conn.execute(
                "SELECT " + ", ".join(self._WANTED_COLS) + " FROM wanted "
                "WHERE artist = ? COLLATE NOCASE AND title = ? COLLATE NOCASE "
                "AND source = ? AND source_ref = ?",
                (artist, title, source, source_ref),
            ).fetchone()
            self.conn.commit()
        return dict(zip(self._WANTED_COLS, row)) if row else {}

    def list_wanted(self) -> list[dict]:
        """All wishlist entries, newest first."""
        rows = self.conn.execute(
            "SELECT " + ", ".join(self._WANTED_COLS) + " FROM wanted "
            "ORDER BY created_at DESC, id DESC"
        ).fetchall()
        return [dict(zip(self._WANTED_COLS, r)) for r in rows]

    def remove_wanted(self, wanted_id: int) -> bool:
        """Drop a wishlist entry by id. Returns True if a row was removed."""
        with self._lock:
            cur = self.conn.execute("DELETE FROM wanted WHERE id = ?", (wanted_id,))
            self.conn.commit()
            return cur.rowcount > 0

    def count_wanted(self) -> int:
        return self.conn.execute("SELECT COUNT(*) FROM wanted").fetchone()[0]

    def continue_session(self) -> dict | None:
        """Most-recently-played song (from song_stats) + metadata, for the
        Continue-Playing card. Null when nothing has been played."""
        row = self.conn.execute(
            "SELECT filename, arrangement, last_position FROM song_stats "
            "WHERE last_played_at IS NOT NULL " +
            self._existing_song_filter() +   # skip dead songs (race-free)
            "ORDER BY last_played_at DESC LIMIT 1"
        ).fetchone()
        if not row:
            return None
        filename, arrangement, last_position = row
        meta = self.conn.execute(
            "SELECT title, artist, tuning_name, duration FROM songs WHERE filename = ?", (filename,)
        ).fetchone()
        title, artist, tuning_name, duration = meta if meta else (None, None, None, None)
        from urllib.parse import quote
        return {
            "filename": filename, "arrangement": arrangement,
            "title": title or filename, "artist": artist or "",
            "tuning_name": tuning_name or "", "duration": duration or 0,
            "last_position": last_position,
            "art_url": f"/api/song/{quote(filename)}/art",
        }

    def favorite_set(self) -> set[str]:
        return {r[0] for r in self.conn.execute("SELECT filename FROM favorites").fetchall()}

    # Every per-perspective column, in one place, so the SELECT, the INSERT and
    # the scanner's "was this ever extracted?" check can never drift apart.
    # NULL is meaningful on `name`/`key`/`low_pitch`: it marks a row written
    # before the column existed, which the scanner re-extracts (see
    # scan._has_unextracted_columns). '' / 0 means "extracted, no such chart".
    _PERSPECTIVE_COLS = tuple(
        p.column(suffix)
        for p in ROLE_PERSPECTIVES
        for suffix in ("name", "sort_key", "offsets", "key", "low_pitch")
    ) + ("tuning_low_pitch",)
    # Columns whose NULL means "never extracted" rather than "no such chart".
    #
    # low_pitch is deliberately NOT a marker: a song with no chart in that role
    # legitimately has NULL there (nothing to compute a pitch from), so keying
    # re-extraction on it would re-scan those rows on every single pass and
    # never converge. `name` and `key` carry the signal instead — they are ''
    # when extracted-but-absent, NULL only when the column predates the row.
    _EXTRACTION_MARKER_COLS = tuple(
        p.column(suffix) for p in ROLE_PERSPECTIVES for suffix in ("name", "key")
    )

    def get(self, filename: str, mtime: float, size: int) -> dict | None:
        cache_key = str(filename)
        pcols = ", ".join(self._PERSPECTIVE_COLS)
        with self._lock:
            row = self.conn.execute(
                "SELECT mtime, size, title, artist, album, year, duration, tuning, arrangements, has_lyrics, "
                "format, stem_count, stem_ids, tuning_name, tuning_sort_key, tuning_offsets, "
                f"{pcols} "
                "FROM songs WHERE filename = ?", (cache_key,)
            ).fetchone()
        if row and row[0] == mtime and row[1] == size and row[2]:
            out = {
                "title": row[2], "artist": row[3], "album": row[4],
                "year": row[5], "duration": row[6], "tuning": row[7],
                "arrangements": json.loads(row[8]) if row[8] else [],
                "has_lyrics": bool(row[9]),
                "format": row[10] or "archive",
                "stem_count": int(row[11] or 0),
                "stem_ids": json.loads(row[12]) if row[12] else [],
                "tuning_name": row[13] or "",
                "tuning_sort_key": int(row[14] or 0),
                "tuning_offsets": row[15] or "",
            }
            for i, col in enumerate(self._PERSPECTIVE_COLS, start=16):
                val = row[i]
                if col in self._EXTRACTION_MARKER_COLS:
                    out[col] = val          # NULL preserved — drives re-extraction
                elif col.endswith("_sort_key"):
                    out[col] = int(val or 0)
                else:
                    out[col] = val or ""
            return out
        return None

    def put(self, filename: str, mtime: float, size: int, meta: dict):
        with self._lock:
            self.conn.execute(
                "INSERT OR REPLACE INTO songs "
                "(filename, mtime, size, title, artist, album, year, duration, tuning, arrangements, "
                "has_lyrics, format, stem_count, stem_ids, tuning_name, tuning_sort_key, tuning_offsets, genre, track_number, disc, "
                + ", ".join(self._PERSPECTIVE_COLS) + ") "
                "VALUES (" + ", ".join(["?"] * (20 + len(self._PERSPECTIVE_COLS))) + ")",
                (filename, mtime, size, meta.get("title", ""), meta.get("artist", ""),
                 meta.get("album", ""), meta.get("year", ""), meta.get("duration", 0),
                 meta.get("tuning", ""), json.dumps(meta.get("arrangements", [])),
                 1 if meta.get("has_lyrics") else 0,
                 meta.get("format", "archive"),
                 int(meta.get("stem_count", 0) or 0),
                 json.dumps(meta.get("stem_ids", []) or []),
                 meta.get("tuning_name", "") or "",
                 int(meta.get("tuning_sort_key", 0) or 0),
                 meta.get("tuning_offsets", "") or "",
                 meta.get("genre", "") or "",
                 meta.get("track_number"),
                 meta.get("disc"),
                 # A put() row is by definition freshly extracted, so the
                 # marker columns must never be written NULL — that state is
                 # reserved for rows predating the column, which re-extract.
                 # low_pitch is the exception: NULL there means "this tuning
                 # has no computable pitch" (unusable offsets), and the
                 # playable filter treats unknown as not-playable.
                 *[_put_perspective_value(meta, col) for col in self._PERSPECTIVE_COLS]),
            )
            self.conn.commit()
            # A song's identity may have changed → the grouping read-model is stale.
            self._work_display_dirty = True

    def count(self) -> int:
        return self.conn.execute("SELECT COUNT(*) FROM songs WHERE title != ''").fetchone()[0]

    def delete_missing(self, current_filenames: set[str]):
        """Remove `songs` rows for files no longer on disk.

        Deliberately does NOT purge song_stats / playlist_songs here: a scan is a
        point-in-time snapshot, so a song that briefly disappears mid-scan (e.g.
        a directory-form .sloppak being overwritten via rmtree-then-extract, or a
        delete+reupload) and returns under the same filename would otherwise lose
        its stats/playlist membership permanently. Instead, stats are purged on
        the EXPLICIT delete path (DELETE /api/song) and dead-song rows are
        filtered at read time (recent_stats / continue_session /
        best_accuracy_map gate on the song still existing)."""
        with self._lock:
            db_files = {r[0] for r in self.conn.execute("SELECT filename FROM songs").fetchall()}
            stale = db_files - current_filenames
            if stale:
                self.conn.executemany("DELETE FROM songs WHERE filename = ?", [(f,) for f in stale])
                self.conn.commit()
                self._work_display_dirty = True   # membership changed → regroup
            # Report both deltas from the one query we already ran: rows pruned,
            # and how many current files are genuinely new (not yet in the DB),
            # so a scan can surface an "N added / M removed" summary.
            return {"removed": len(stale), "added": len(current_filenames - db_files)}

    # ── Metadata enrichment (P7 — plumbing; the matcher itself is the next
    # slice) ─────────────────────────────────────────────────────────────────

    @staticmethod
    def enrichment_content_hash(artist, title, album, duration) -> str:
        """Identity hash of the metadata a match keys on — normalized
        artist|title|album|duration. Deliberately excludes the filename, so a
        renamed pack keeps its enrichment (rename-survivable), and an unchanged
        hash makes re-enrichment a no-op (idempotent). Whitespace/case-folded
        so trivial edits don't invalidate a match; duration is rounded to whole
        seconds for the same reason."""
        def norm(s):
            return " ".join(str(s or "").lower().split())
        try:
            dur = str(int(round(float(duration or 0))))
        except (TypeError, ValueError):
            dur = "0"
        raw = "|".join([norm(artist), norm(title), norm(album), dur])
        return hashlib.sha1(raw.encode("utf-8")).hexdigest()

    def enrichment_pending(self, limit: int = 500,
                           allowed_keys: frozenset | None = None) -> list[dict]:
        """Songs whose enrichment row needs (re)matching: no row yet, or a
        row whose content_hash no longer matches the song's current metadata
        (an edit changed the identity → re-match), or an `unscanned` row.
        `manual` rows are the user's pinned pick and are NEVER re-queued.
        `matched`/`review`/`failed` rows with an UNCHANGED hash are settled
        here — a review row stands until the user acts, and a failed row
        retries only via the matcher's backoff policy (enrichment_failed_rows)
        rather than being re-queued every pass. An identity edit (say, the
        user fixes the typo that made matching fail) re-queues any of them
        immediately via the hash mismatch.

        `allowed_keys` is the set of per-field auto-apply toggle keys that are
        currently ON. A `matched` row stamped while one of those fields was
        suppressed (its key in `apply_mask`) is re-queued for backfill, so
        re-enabling a field honours the same "nothing forfeited" contract the
        source/art toggles already keep. None = don't apply the mask rule (the
        caller isn't the field-aware matcher, e.g. a plain count)."""
        # Read under _lock: the worker commits on this shared connection under
        # _lock, so an unlocked SELECT could interleave with its execute+commit.
        with self._lock:
            rows = self.conn.execute(
                "SELECT s.filename, s.artist, s.title, s.album, s.year, s.duration, "
                "e.content_hash, e.match_state, e.apply_mask "
                "FROM songs s LEFT JOIN song_enrichment e ON e.filename = s.filename "
                "WHERE s.title != '' AND (e.filename IS NULL "
                "OR e.match_state IN ('unscanned', 'matched', 'review', 'failed')) "
                "ORDER BY s.filename LIMIT ?", (max(1, int(limit)),)).fetchall()
        out = []
        for fn, artist, title, album, year, duration, ehash, state, mask in rows:
            h = self.enrichment_content_hash(artist, title, album, duration)
            # No row yet, still unmatched, or the identity changed under a
            # settled row → needs the matcher. A settled row with an
            # unchanged hash stays settled (idempotence)…
            needs = state is None or state == "unscanned" or ehash != h
            # …EXCEPT a `matched` row that suppressed a field now re-enabled:
            # re-queue it so the newly-allowed field gets backfilled.
            if not needs and state == "matched" and allowed_keys is not None and mask:
                if {k for k in mask.split(",") if k} & allowed_keys:
                    needs = True
            if needs:
                out.append({"filename": fn, "artist": artist, "title": title,
                            "album": album, "year": year, "duration": duration,
                            "content_hash": h, "match_state": state})
        return out

    def upsert_enrichment_stub(self, filename: str, content_hash: str) -> None:
        """Write/refresh a row's identity hash ahead of matching. A row whose
        hash changed drops back to `unscanned` (the old match no longer applies)
        — EXCEPT a `manual` row, which is the user's explicit pick and survives
        metadata edits untouched."""
        with self._lock:
            # Idempotence: skip the UPDATE/commit when the upsert would be a
            # no-op. The no-op matcher (P7) re-stamps every pending row each
            # pass; without this guard an already-settled row would be
            # rewritten every ~5 min, N commits/pass contending with request
            # writes. A `manual` pick never changes here, and a non-manual row
            # whose hash already matches keeps its state+hash — both no-ops.
            cur = self.conn.execute(
                "SELECT content_hash, match_state FROM song_enrichment WHERE filename = ?",
                (filename,)).fetchone()
            if cur is not None:
                old_hash, state = cur
                if state == "manual" or old_hash == content_hash:
                    return
            self.conn.execute(
                "INSERT INTO song_enrichment (filename, content_hash, match_state) "
                "VALUES (?, ?, 'unscanned') "
                "ON CONFLICT(filename) DO UPDATE SET "
                "  match_state = CASE WHEN song_enrichment.match_state = 'manual' "
                "                     THEN song_enrichment.match_state "
                "                     WHEN song_enrichment.content_hash IS NOT excluded.content_hash "
                "                     THEN 'unscanned' "
                "                     ELSE song_enrichment.match_state END, "
                # An identity change restarts the failure backoff too — the
                # accumulated attempts belonged to the OLD identity (e.g. the
                # user just fixed the typo that made matching fail).
                "  attempts = CASE WHEN song_enrichment.match_state = 'manual' "
                "                  THEN song_enrichment.attempts "
                "                  WHEN song_enrichment.content_hash IS NOT excluded.content_hash "
                "                  THEN 0 "
                "                  ELSE song_enrichment.attempts END, "
                "  content_hash = CASE WHEN song_enrichment.match_state = 'manual' "
                "                      THEN song_enrichment.content_hash "
                "                      ELSE excluded.content_hash END",
                (filename, content_hash))
            self.conn.commit()

    def get_enrichment(self, filename: str) -> dict | None:
        # Read under _lock (shared write connection — see enrichment_pending).
        with self._lock:
            row = self.conn.execute(
                "SELECT filename, content_hash, match_state, match_source, match_score, attempts, "
                "mb_recording_id, mb_release_id, mb_artist_id, isrc, "
                "canon_artist, canon_album, canon_title, canon_year, canon_artist_sort, "
                "genres, art_cache_path, art_state, fetched_at, candidates, last_attempt_at, "
                "apply_mask "
                "FROM song_enrichment WHERE filename = ?", (filename,)).fetchone()
        if not row:
            return None
        keys = ("filename", "content_hash", "match_state", "match_source", "match_score",
                "attempts", "mb_recording_id", "mb_release_id", "mb_artist_id", "isrc",
                "canon_artist", "canon_album", "canon_title", "canon_year",
                "canon_artist_sort", "genres", "art_cache_path", "art_state", "fetched_at",
                "candidates", "last_attempt_at", "apply_mask")
        out = dict(zip(keys, row))
        for k in ("genres", "candidates"):
            try:
                out[k] = json.loads(out[k]) if out[k] else []
            except (ValueError, TypeError):
                out[k] = []
        return out

    def enrichment_state_counts(self) -> dict:
        """{match_state: count} over rows whose song still exists (dead rows are
        filtered at read time, matching the never-purged-on-rescan contract)."""
        # Read under _lock (shared write connection — see enrichment_pending).
        with self._lock:
            rows = self.conn.execute(
                "SELECT e.match_state, COUNT(*) FROM song_enrichment e "
                "JOIN songs s ON s.filename = e.filename GROUP BY e.match_state").fetchall()
        return {r[0]: r[1] for r in rows}

    def enrichment_states_for(self, filenames: list[str]) -> dict:
        """{filename: match_state} for the given songs — a never-enriched (or
        unknown) filename is simply absent from the result. Powers the per-tile
        badges on the "Refresh Metadata" batch: the grid polls only the
        filenames in its visible window, not the whole library, so a card can
        animate queued→working→result without a per-song round-trip."""
        if not filenames:
            return {}
        out: dict = {}
        with self._lock:
            # Chunk under SQLite's variable limit so a huge visible window (or a
            # hostile caller) can't overflow the single IN (...) parameter list.
            for i in range(0, len(filenames), 400):
                chunk = filenames[i:i + 400]
                q = ("SELECT filename, match_state FROM song_enrichment "
                     "WHERE filename IN (%s)" % ",".join("?" * len(chunk)))
                for fn, st in self.conn.execute(q, chunk).fetchall():
                    out[fn] = st
        return out

    def _unmatched_set(self, filenames) -> set:
        """The subset of `filenames` whose enrichment landed in the 'failed'
        (no-match) state — feeds the grid's persistent per-card "no match" badge,
        so the misses stay visible at rest (the batch tile only shows while a
        refresh runs). Chunked set membership, like favorite_set."""
        fns = list(filenames)
        out: set = set()
        for i in range(0, len(fns), 400):
            chunk = fns[i:i + 400]
            if not chunk:
                break
            q = ("SELECT filename FROM song_enrichment WHERE match_state = 'failed' "
                 "AND filename IN (%s)" % ",".join("?" * len(chunk)))
            out.update(r[0] for r in self.conn.execute(q, chunk).fetchall())
        return out

    def enrichment_song_row(self, filename: str) -> dict | None:
        """The identity fields the matcher/scorer keys on, for one song."""
        row = self.conn.execute(
            "SELECT filename, artist, title, album, year, duration "
            "FROM songs WHERE filename = ?", (filename,)).fetchone()
        if not row:
            return None
        return dict(zip(("filename", "artist", "title", "album", "year", "duration"), row))

    def enrichment_failed_rows(self, limit: int = 500) -> list[dict]:
        """`failed` rows that MAY retry, with the fields the backoff policy
        (worker-side) needs to decide eligibility. `rejected` rows are the
        user's explicit "none of these" — never auto-retried (an identity
        edit re-queues them through enrichment_pending's hash mismatch
        instead)."""
        rows = self.conn.execute(
            "SELECT s.filename, s.artist, s.title, s.album, s.year, s.duration, "
            "e.attempts, e.last_attempt_at "
            "FROM songs s JOIN song_enrichment e ON e.filename = s.filename "
            "WHERE s.title != '' AND e.match_state = 'failed' "
            "AND COALESCE(e.match_source, '') != 'rejected' "
            "ORDER BY s.filename LIMIT ?", (max(1, int(limit)),)).fetchall()
        out = []
        for fn, artist, title, album, year, duration, attempts, last_at in rows:
            out.append({"filename": fn, "artist": artist, "title": title,
                        "album": album, "year": year, "duration": duration,
                        "content_hash": self.enrichment_content_hash(artist, title, album, duration),
                        "attempts": attempts or 0, "last_attempt_at": last_at})
        return out

    def enrichment_cache_lookup(self, content_hash: str, exclude_filename: str = "") -> dict | None:
        """A settled match for the same identity hash — another chart of the
        same recording already matched/pinned → copy it, no network (design
        §5 step 1: the local match-cache). Only FULLY-applied donors qualify
        (apply_mask empty/NULL): a row that suppressed a display field under an
        auto-apply toggle would otherwise seed siblings with its blanks even
        when the reader's own toggles want that field — so a partial row is
        skipped and the sibling falls through to its own (re-filtered) match."""
        row = self.conn.execute(
            "SELECT match_score, mb_recording_id, mb_release_id, mb_artist_id, isrc, "
            "canon_artist, canon_album, canon_title, canon_year, canon_artist_sort, genres "
            "FROM song_enrichment WHERE content_hash = ? AND filename != ? "
            "AND match_state IN ('matched', 'manual') AND mb_recording_id IS NOT NULL "
            "AND COALESCE(apply_mask, '') = '' "
            "LIMIT 1", (content_hash, exclude_filename or "")).fetchone()
        if not row:
            return None
        try:
            genres = json.loads(row[10]) if row[10] else []
        except (ValueError, TypeError):
            genres = []
        return {
            "score": row[0],
            "recording_id": row[1], "release_id": row[2] or "", "artist_id": row[3] or "",
            "isrc": row[4] or "", "artist": row[5] or "", "album": row[6] or "",
            "title": row[7] or "", "year": row[8] or "", "artist_sort": row[9] or "",
            "genres": genres,
        }

    def apply_enrichment_match(self, filename: str, content_hash: str, state: str,
                               source: str | None = None, score: float | None = None,
                               cand: dict | None = None, candidates: list | None = None,
                               bump_attempts: bool = False,
                               allow_manual_overwrite: bool = False,
                               apply_mask: str | None = None) -> bool:
        """The single writer for every matcher/review outcome. Writes the
        full lifecycle row: state + source + score, the canonical fields a
        confident match supplies (`cand`), and/or the review tier's ranked
        `candidates`. Returns False without touching anything when the row is
        `manual` and the caller isn't explicitly acting for the user — the
        never-overwrite-manual contract lives HERE so no future call path
        can forget it. Art-cache fields are preserved verbatim (they belong
        to the art slice, not the matcher). `apply_mask` (blocked per-field
        keys, from the matcher) is stamped verbatim so enrichment_pending /
        enrichment_cache_lookup can tell a fully-applied match from a
        field-suppressed one; the review/manual writers leave it NULL (a
        confirmed pick applies in full)."""
        cand = cand or {}
        now = time.time()
        with self._lock:
            cur = self.conn.execute(
                "SELECT match_state, attempts, art_cache_path, art_state, fetched_at "
                "FROM song_enrichment WHERE filename = ?", (filename,)).fetchone()
            if cur and cur[0] == "manual" and not allow_manual_overwrite:
                return False
            # An explicit reset to `unscanned` (Refresh metadata) is a fresh
            # start — the failure backoff restarts with the identity, same as
            # the stub upsert's hash-change rule.
            attempts = 0 if state == "unscanned" else (int(cur[1] or 0) if cur else 0)
            if bump_attempts:
                attempts += 1
            fetched_at = (time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
                          if state in ("matched", "manual", "review")
                          else (cur[4] if cur else None))
            self.conn.execute(
                "INSERT OR REPLACE INTO song_enrichment (filename, content_hash, "
                "match_state, match_source, match_score, attempts, "
                "mb_recording_id, mb_release_id, mb_artist_id, isrc, "
                "canon_artist, canon_album, canon_title, canon_year, canon_artist_sort, "
                "genres, art_cache_path, art_state, fetched_at, candidates, last_attempt_at, "
                "apply_mask) "
                "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                (filename, content_hash, state, source, score, attempts,
                 cand.get("recording_id") or None, cand.get("release_id") or None,
                 cand.get("artist_id") or None, cand.get("isrc") or None,
                 cand.get("artist") or None, cand.get("album") or None,
                 cand.get("title") or None, cand.get("year") or None,
                 cand.get("artist_sort") or None,
                 json.dumps(cand.get("genres") or []) if cand else "[]",
                 cur[2] if cur else None, cur[3] if cur else None,
                 fetched_at,
                 json.dumps(candidates) if candidates else None,
                 now if state == "failed" else None,
                 apply_mask or None))
            self.conn.commit()
        return True

    def set_enrichment_manual(self, filename: str, cand: dict, source: str = "search") -> bool:
        """User-pinned match (review Accept / manual search-and-pick). The
        highest-authority state: never auto-reset, survives identity edits.
        `source` records HOW it was pinned ('review' = accepted a proposed
        candidate, 'search' = picked from a manual search)."""
        song = self.enrichment_song_row(filename)
        if not song:
            return False
        h = self.enrichment_content_hash(
            song["artist"], song["title"], song["album"], song["duration"])
        return self.apply_enrichment_match(
            filename, h, "manual", source=source, score=1.0, cand=cand,
            allow_manual_overwrite=True)

    def set_enrichment_rejected(self, filename: str) -> bool:
        """User said "none of these candidates" — clear any canonical values
        and park the row as failed/rejected (never auto-retried; an identity
        edit re-queues it). Refused for `manual` rows: un-pinning a pick the
        user explicitly made is not a review-drawer action."""
        row = self.get_enrichment(filename)
        if not row or row["match_state"] not in ("review", "matched"):
            return False
        return self.apply_enrichment_match(
            filename, row["content_hash"], "failed", source="rejected",
            score=None, candidates=row.get("candidates") or None)

    def enrichment_review_queue(self, limit: int = 200,
                                order: str = "missing_first") -> list[dict]:
        """The Match-Review drawer's queue: review-tier rows joined to their
        (still-existing) songs, with the stored candidate list parsed.
        `order` is the user's review-queue preference: 'missing_first'
        (default — charts missing album/year surface first, they gain the
        most from a confirm; complete charts only stand to be re-labelled),
        'artist' (A–Z), or 'recent' (newest files first). Unknown values
        fall back to missing_first."""
        order_sql = {
            "artist": "s.artist COLLATE NOCASE, s.title COLLATE NOCASE, e.filename",
            "recent": "s.mtime DESC, e.filename",
        }.get(order, "((COALESCE(s.album, '') = '') + (COALESCE(s.year, '') = '')) DESC, "
                     "s.artist COLLATE NOCASE, s.title COLLATE NOCASE, e.filename")
        rows = self.conn.execute(
            "SELECT e.filename, s.title, s.artist, s.album, s.year, s.duration, s.mtime, "
            "e.match_score, e.candidates, e.attempts "
            "FROM song_enrichment e JOIN songs s ON s.filename = e.filename "
            "WHERE e.match_state = 'review' "
            "ORDER BY " + order_sql + " "
            "LIMIT ?", (max(1, int(limit)),)).fetchall()
        out = []
        for fn, title, artist, album, year, duration, mtime, score, cands, attempts in rows:
            try:
                candidates = json.loads(cands) if cands else []
            except (ValueError, TypeError):
                candidates = []
            out.append({"filename": fn, "title": title, "artist": artist,
                        "album": album, "year": year, "duration": duration,
                        "mtime": mtime, "match_score": score,
                        "candidates": candidates, "attempts": attempts or 0})
        return out

    def enrichment_art_pending(self, limit: int = 500) -> list[dict]:
        """Matched songs whose cover-art situation hasn't been evaluated yet
        (art_state NULL). The art worker resolves each to 'pack' (song has its
        own art), 'user' (an override exists), 'caa' (fetched), 'none' (the
        release has no cover) or 'error' — any of which settles the row, so
        this never re-offers a song each pass."""
        rows = self.conn.execute(
            "SELECT e.filename, e.mb_release_id "
            "FROM song_enrichment e JOIN songs s ON s.filename = e.filename "
            "WHERE e.match_state IN ('matched', 'manual') "
            "AND e.mb_release_id IS NOT NULL AND e.art_state IS NULL "
            "ORDER BY e.filename LIMIT ?", (max(1, int(limit)),)).fetchall()
        return [{"filename": r[0], "mb_release_id": r[1]} for r in rows]

    def set_enrichment_art(self, filename: str, path: str | None, state: str | None) -> None:
        """Stamp a row's art-cache outcome. Targeted UPDATE (not the match
        writer) so it can never disturb the match lifecycle fields."""
        with self._lock:
            self.conn.execute(
                "UPDATE song_enrichment SET art_cache_path = ?, art_state = ? "
                "WHERE filename = ?", (path, state, filename))
            self.conn.commit()

    def clear_enrichment_art_paths(self, paths: list[str]) -> None:
        """Reset rows whose cached art file was evicted (LRU prune) back to
        unevaluated, so a later pass may re-fetch if the song still qualifies."""
        if not paths:
            return
        with self._lock:
            ph = ",".join("?" * len(paths))
            self.conn.execute(
                f"UPDATE song_enrichment SET art_cache_path = NULL, art_state = NULL "
                f"WHERE art_cache_path IN ({ph})", paths)
            self.conn.commit()

    def _estd_set(self) -> set[str]:
        """Get set of filenames that have a retuned variant (_EStd_ or _DropD_) in the DB."""
        rows = self.conn.execute(
            "SELECT filename FROM songs WHERE filename LIKE '%\\_EStd\\_%' ESCAPE '\\' "
            "OR filename LIKE '%\\_DropD\\_%' ESCAPE '\\'"
        ).fetchall()
        originals = set()
        for (fname,) in rows:
            originals.add(fname.replace("_EStd_", "_").replace("_DropD_", "_"))
        return originals

    # Manifest-allowed filter values. Whitelisted before binding so a
    # malformed query string can't push arbitrary text through to SQL —
    # parameters are bound, but capping the input space is still cheap
    # defense-in-depth (see feedBack#129).
    _ALLOWED_ARRANGEMENT_NAMES = {"Lead", "Rhythm", "Bass", "Combo"}
    # Per-smart-type list of (sql_op, sql_param) pairs appended to the SQL
    # name-fallback branch (key-absent smart_name). Covers legacy raw names
    # and load_song()'s synthesised display names that map to each smart type.
    _SMART_NULL_FALLBACK_EXTRAS: dict[str, tuple[tuple[str, str], ...]] = {
        "Lead": (("=", "Combo"), ("LIKE", "Alt. Combo%"), ("LIKE", "Bonus Combo%")),
        "Bass": (("=", "Bass 2"),),
    }
    # Stem ids match the bare strings sloppak manifests use today —
    # `full`, `guitar`, `bass`, `drums`, `vocals`, `piano`, `other`. The
    # frontend filter UI omits `full` (it's the always-on fallback mix
    # and would match every sloppak), but the server-side whitelist
    # keeps it so a hand-rolled API client can still ask for it.
    _ALLOWED_STEM_IDS = {"full", "guitar", "bass", "drums", "vocals", "piano", "other"}

    @classmethod
    def _smart_null_extras(cls, arr_type: str) -> tuple[str, list[str]]:
        """Return (sql_fragment, bound_params) for the extra raw-name terms to
        OR into the key-absent NULL-smart_name fallback branch for arr_type.
        Empty when no extras are defined."""
        terms = cls._SMART_NULL_FALLBACK_EXTRAS.get(arr_type, ())
        fragment = "".join(
            f" OR json_extract(value, '$.name') {op} ?" for op, _ in terms
        )
        return fragment, [val for _, val in terms]

    def _build_where(self, q: str = "", favorites_only: bool = False,
                     format_filter: str = "",
                     artist_filter: str = "",
                     album_filter: str = "",
                     arrangements_has: list[str] | None = None,
                     arrangements_lacks: list[str] | None = None,
                     stems_has: list[str] | None = None,
                     stems_lacks: list[str] | None = None,
                     has_lyrics: int | None = None,
                     tunings: list[str] | None = None,
                     mastery: list[str] | None = None,
                     tags_has: list[str] | None = None,
                     user_difficulty_in: list[str] | None = None,
                     match_states: list[str] | None = None,
                     genre: list[str] | None = None,
                     naming_mode: str = "legacy",
                     instrument: str = DEFAULT_PERSPECTIVE,
                     playable_from_pitch: int | None = None,
                     include_intrinsic: bool = True) -> tuple[str, list]:
        """Shared WHERE-clause builder for query_page / query_artists /
        query_stats. Returns (where_sql, params). Leading 'WHERE' is
        included so callers paste it directly. See feedBack#129/#69.

        Clauses are two classes (the §7.1 filter law): work-identity +
        practice-state predicates live here; CHART-INTRINSIC predicates
        (format / arrangements / stems / lyrics / tuning) are built by
        `_build_intrinsic_where` and appended when `include_intrinsic`.
        Grouped queries pass include_intrinsic=False and re-apply the
        intrinsic set as a match-if-ANY-member subquery instead.
        """
        where = "WHERE title != ''"
        params: list = []
        if favorites_only:
            where += " AND filename IN (SELECT filename FROM favorites)"
        if artist_filter:
            # The dropdown/tree list CANONICAL names (query_artists), so a filter
            # value is canonical — expand it to every raw variant aliased to it so
            # picking "AC/DC" returns songs tagged "ACDC" too. `artist IN (...)`
            # keeps the artist index (keyset-safe), unlike a per-row COALESCE.
            variants = self._raw_variants_for(artist_filter)
            ph = ",".join(["?"] * len(variants))
            where += f" AND artist COLLATE NOCASE IN ({ph})"
            params += variants
        if album_filter:
            where += " AND album = ? COLLATE NOCASE"
            params.append(album_filter)
        # Genre facet (primary genre column, populated from the feedpak `genres`
        # list on scan). OR within the selected set.
        if genre:
            _gph = ",".join(["?"] * len(genre))
            where += f" AND ({self._effective_genre_expr()}) COLLATE NOCASE IN ({_gph})"
            params += list(genre)
        # Mastery bands = best accuracy across a song's arrangements (song_stats,
        # a separate table -> correlated subquery). mastered >= 0.9, in_progress =
        # attempted but < 0.9, not_started = no score. OR within the selected set.
        if mastery:
            _msub = "(SELECT MAX(best_accuracy) FROM song_stats s WHERE s.filename = songs.filename)"
            _bands = {
                "mastered": f"{_msub} >= 0.9",
                "in_progress": f"({_msub} IS NOT NULL AND {_msub} < 0.9)",
                "not_started": f"{_msub} IS NULL",
            }
            _sel = [_bands[b] for b in mastery if b in _bands]
            if _sel:
                where += " AND (" + " OR ".join(_sel) + ")"
        # Personal practice tags (song_tags) — any-of. EXISTS-style IN keeps it a
        # predicate on `songs` (keyset-safe, no row multiplication). Normalized to
        # match how tags are stored.
        _tags = [t for t in (_normalize_tag(x) for x in (tags_has or [])) if t]
        if _tags:
            ph = ",".join(["?"] * len(_tags))
            where += (" AND filename IN (SELECT filename FROM song_tags "
                      f"WHERE tag IN ({ph}))")
            params += _tags
        # Personal user-difficulty (song_user_meta) — any-of over the 1..5 set.
        _diffs = []
        for d in (user_difficulty_in or []):
            try:
                di = int(d)
            except (TypeError, ValueError):
                continue
            if 1 <= di <= 5:
                _diffs.append(di)
        if _diffs:
            ph = ",".join(["?"] * len(_diffs))
            where += (" AND filename IN (SELECT filename FROM song_user_meta "
                      f"WHERE user_difficulty IN ({ph}))")
            params += _diffs
        # Match facet (P8) = the song's enrichment lifecycle state, from the
        # separate song_enrichment table (same EXISTS idiom as mastery above).
        # 'matched' folds in 'manual' (a user pin IS a match); 'pending' means
        # no verdict yet (no row, or still unscanned). OR within the set.
        if match_states:
            _esub = "SELECT 1 FROM song_enrichment e WHERE e.filename = songs.filename"
            _mstates = {
                "review": f"EXISTS ({_esub} AND e.match_state = 'review')",
                "matched": f"EXISTS ({_esub} AND e.match_state IN ('matched', 'manual'))",
                "unmatched": f"EXISTS ({_esub} AND e.match_state = 'failed')",
                "pending": f"NOT EXISTS ({_esub} AND e.match_state != 'unscanned')",
            }
            _msel = [_mstates[b] for b in match_states if b in _mstates]
            if _msel:
                where += " AND (" + " OR ".join(_msel) + ")"
        if q:
            _qlike = f"%{q}%"
            _qterms = ("title LIKE ? COLLATE NOCASE OR artist LIKE ? COLLATE NOCASE "
                       "OR album LIKE ? COLLATE NOCASE")
            _qparams = [_qlike] * 3
            # Alias-aware artist term (launch polish): searching the CANONICAL
            # name ("AC/DC") must also find songs whose raw tag is a merged
            # variant ("ACDC") — expand via the artist_alias table. Pure
            # predicate (keyset-safe); probe-guarded so the common no-aliases
            # library keeps the exact original 3-term query.
            if self.conn.execute("SELECT 1 FROM artist_alias LIMIT 1").fetchone() is not None:
                _qterms += (" OR artist COLLATE NOCASE IN (SELECT raw_name FROM artist_alias "
                            "WHERE canonical_name LIKE ? COLLATE NOCASE)")
                _qparams.append(_qlike)
            where += f" AND ({_qterms})"
            params += _qparams
        if include_intrinsic:
            ifrag, iparams = self._build_intrinsic_where(
                "songs", format_filter=format_filter,
                arrangements_has=arrangements_has, arrangements_lacks=arrangements_lacks,
                stems_has=stems_has, stems_lacks=stems_lacks,
                has_lyrics=has_lyrics, tunings=tunings, naming_mode=naming_mode,
                instrument=instrument, playable_from_pitch=playable_from_pitch)
            where += ifrag
            params += iparams
        return where, params

    def _build_intrinsic_where(self, alias: str, format_filter: str = "",
                               arrangements_has: list[str] | None = None,
                               arrangements_lacks: list[str] | None = None,
                               stems_has: list[str] | None = None,
                               stems_lacks: list[str] | None = None,
                               has_lyrics: int | None = None,
                               tunings: list[str] | None = None,
                               naming_mode: str = "legacy",
                               instrument: str = DEFAULT_PERSPECTIVE,
                               playable_from_pitch: int | None = None) -> tuple[str, list]:
        """CHART-INTRINSIC predicates (format / arrangements / stems / lyrics /
        tuning) as ' AND …' fragments against an explicit table alias. Flat
        queries apply them to `songs` directly; grouped queries evaluate them
        against each work member `m` inside an EXISTS (§7.1 filter law — a
        work matches when ANY of its charts does, so a song you own in Drop D
        isn't hidden because your preferred chart is E Standard)."""
        where = ""
        params: list = []
        if format_filter:
            where += f" AND {alias}.format = ?"
            params.append(format_filter)
        # arrangements_has / arrangements_lacks: OR within axis (any-of).
        # Uses JSON1's json_each which yields one row per arrangement, then
        # matches the relevant field. The whole subquery is wrapped in EXISTS
        # so we don't multiply rows in the outer SELECT.
        #
        # Smart mode: each requested type (Lead/Rhythm/Bass) matches against
        # smart_name when present. "Lead" matches smart_name in
        # ('Lead', 'Alt. Lead', 'Alt. Lead N', 'Bonus Lead', 'Bonus Lead N').
        # Falls back to matching `name` for older rows without smart_name.
        # Legacy mode: matches `name` directly (original behaviour).
        arr_has = [a for a in (arrangements_has or []) if a in self._ALLOWED_ARRANGEMENT_NAMES]
        if arr_has and naming_mode == "smart":
            # Smart mode subsumes "Combo" into "Lead" — normalize here so a
            # hand-rolled API client matches the client-side behaviour and
            # the SQL doesn't need a "Combo" smart-type branch.
            arr_has = list(dict.fromkeys("Lead" if a == "Combo" else a for a in arr_has))
        if arr_has:
            if naming_mode == "smart":
                clauses = []
                for arr_type in arr_has:
                    # Extra raw-name fragments matched only in the key-absent
                    # NULL-smart_name fallback branch — they cover the legacy
                    # display names that map to this smart type:
                    #   Lead: "Combo" (combined guitar) + Alt./Bonus Combo
                    #   Bass: "Bass 2" (load_song synthesises for real_bass_22)
                    extra_null, extra_null_params = self._smart_null_extras(arr_type)
                    # json_type() returns NULL when the key is absent and the
                    # string 'null' when the key exists with explicit JSON null
                    # (set by the scanner for ambiguous duplicate-name rows).
                    # Name-fallback only applies to key-absent rows so an
                    # explicit null suppresses the fallback and lets the
                    # background rescan resolve the ambiguity authoritatively.
                    clauses.append(
                        "(json_extract(value, '$.smart_name') IS NOT NULL AND ("
                        f"json_extract(value, '$.smart_name') = ? OR "
                        f"json_extract(value, '$.smart_name') LIKE ? OR "
                        f"json_extract(value, '$.smart_name') LIKE ?"
                        ")) OR ("
                        "json_type(value, '$.smart_name') IS NULL AND ("
                        "json_extract(value, '$.name') = ? OR "
                        "json_extract(value, '$.name') LIKE ? OR "
                        f"json_extract(value, '$.name') LIKE ?{extra_null}))"
                    )
                    params += [
                        arr_type,
                        f"Alt. {arr_type}%",
                        f"Bonus {arr_type}%",
                        arr_type,
                        f"Alt. {arr_type}%",
                        f"Bonus {arr_type}%",
                    ] + extra_null_params
                where += (
                    f" AND EXISTS (SELECT 1 FROM json_each({alias}.arrangements) WHERE "
                    + " OR ".join(f"({c})" for c in clauses)
                    + ")"
                )
            else:
                placeholders = ",".join(["?"] * len(arr_has))
                where += (f" AND EXISTS (SELECT 1 FROM json_each({alias}.arrangements) "
                          f"WHERE json_extract(value, '$.name') IN ({placeholders}))")
                params += arr_has
        arr_lacks = [a for a in (arrangements_lacks or []) if a in self._ALLOWED_ARRANGEMENT_NAMES]
        if arr_lacks and naming_mode == "smart":
            arr_lacks = list(dict.fromkeys("Lead" if a == "Combo" else a for a in arr_lacks))
        if arr_lacks:
            if naming_mode == "smart":
                clauses = []
                for arr_type in arr_lacks:
                    extra_null, extra_null_params = self._smart_null_extras(arr_type)
                    # See "has" branch above for the json_type rationale.
                    # Extra branch (vs `has`): an explicit smart_name=null
                    # arrangement is ambiguous; we don't know whether it's
                    # `arr_type` or not. Be conservative and treat it as
                    # potentially matching, so `arrangements_lacks` excludes
                    # the parent row instead of falsely claiming it lacks
                    # `arr_type`. The background rescan resolves the ambiguity.
                    clauses.append(
                        "(json_extract(value, '$.smart_name') IS NOT NULL AND ("
                        f"json_extract(value, '$.smart_name') = ? OR "
                        f"json_extract(value, '$.smart_name') LIKE ? OR "
                        f"json_extract(value, '$.smart_name') LIKE ?"
                        ")) OR ("
                        "json_type(value, '$.smart_name') = 'null'"
                        ") OR ("
                        "json_type(value, '$.smart_name') IS NULL AND ("
                        "json_extract(value, '$.name') = ? OR "
                        "json_extract(value, '$.name') LIKE ? OR "
                        f"json_extract(value, '$.name') LIKE ?{extra_null}))"
                    )
                    params += [
                        arr_type,
                        f"Alt. {arr_type}%",
                        f"Bonus {arr_type}%",
                        arr_type,
                        f"Alt. {arr_type}%",
                        f"Bonus {arr_type}%",
                    ] + extra_null_params
                where += (
                    f" AND NOT EXISTS (SELECT 1 FROM json_each({alias}.arrangements) WHERE "
                    + " OR ".join(f"({c})" for c in clauses)
                    + ")"
                )
            else:
                placeholders = ",".join(["?"] * len(arr_lacks))
                where += (f" AND NOT EXISTS (SELECT 1 FROM json_each({alias}.arrangements) "
                          f"WHERE json_extract(value, '$.name') IN ({placeholders}))")
                params += arr_lacks
        stems_h = [s for s in (stems_has or []) if s in self._ALLOWED_STEM_IDS]
        if stems_h:
            placeholders = ",".join(["?"] * len(stems_h))
            where += (f" AND EXISTS (SELECT 1 FROM json_each({alias}.stem_ids) "
                      f"WHERE value IN ({placeholders}))")
            params += stems_h
        stems_l = [s for s in (stems_lacks or []) if s in self._ALLOWED_STEM_IDS]
        if stems_l:
            placeholders = ",".join(["?"] * len(stems_l))
            where += (f" AND NOT EXISTS (SELECT 1 FROM json_each({alias}.stem_ids) "
                      f"WHERE value IN ({placeholders}))")
            params += stems_l
        if has_lyrics in (0, 1):
            where += f" AND {alias}.has_lyrics = ?"
            params.append(has_lyrics)
        if tunings:
            # Keep the input cap conservative (32) so a hostile caller
            # can't blow out the parameter list. Real tuning sets in the
            # wild number in the low double digits.
            tn = [t for t in tunings if isinstance(t, str) and t][:32]
            if tn:
                placeholders = ",".join(["?"] * len(tn))
                # Match the same grouping key tuning_names() returns so a single
                # "Custom Tuning" pill selects exactly its offset set while named
                # tunings still match by name. `instrument` swaps in the
                # effective bass tuning key (guitar fallback) — the facet and
                # this WHERE must use the same expression or they disagree.
                where += (f" AND {_tuning_group_key_sql(alias, instrument)} "
                          f"COLLATE NOCASE IN ({placeholders})")
                params += tn
        if playable_from_pitch is not None:
            # "Playable without retuning" — the mode the tester actually wants
            # ("don't make me retune"), offered ALONGSIDE exact match, not
            # instead of it. A chart needs no retune when its lowest required
            # pitch is reachable, and every pitch above your lowest open string
            # is reachable by fretting, so the comparison is:
            #
            #     your lowest open pitch <= the chart's lowest open pitch
            #
            # That is why a 5-string bass (low B) covers every 4-string
            # standard AND every drop-D chart untouched.
            #
            # CONSERVATIVE BY CONSTRUCTION: a chart whose low pitch we could
            # not compute (NULL) is EXCLUDED rather than assumed playable —
            # wrongly claiming playability costs a mid-practice retune, which
            # is the failure this whole feature exists to prevent. See
            # tunings.chart_is_playable_in for the full reasoning + limits.
            low_sql = _effective_low_pitch_sql(alias, instrument)
            where += f" AND {low_sql} IS NOT NULL AND {low_sql} >= ?"
            params.append(int(playable_from_pitch))
        return where, params

    # Under group=1, chart-intrinsic filters match if ANY member of the work
    # matches (§7.1 filter law). A pure predicate on the representative scan —
    # no GROUP BY, no row multiplication — so the keyset cursor stays valid.
    def _grouped_member_match(self, intrinsic_frag: str, intrinsic_params: list) -> tuple[str, list]:
        if not intrinsic_frag:
            return "", []
        return ((" AND EXISTS (SELECT 1 FROM songs m JOIN work_display mw ON mw.filename = m.filename "
                 "WHERE mw.effective_work_key = (SELECT w0.effective_work_key FROM work_display w0 "
                 "WHERE w0.filename = songs.filename)" + intrinsic_frag + ")"),
                list(intrinsic_params))

    # ── Multi-chart grouping engine (P5a) ────────────────────────────────────
    @staticmethod
    def _norm_token(s, fold_the=False):
        """Fold a name to a comparison token: strip diacritics + punctuation +
        whitespace, lowercase, optionally drop a leading 'the ' (artist names)."""
        import re
        import unicodedata
        raw = str(s or "")
        s = unicodedata.normalize("NFKD", raw)
        s = "".join(c for c in s if not unicodedata.combining(c)).lower()
        if fold_the:
            s = re.sub(r"^the\s+", "", s)
        folded = re.sub(r"[^a-z0-9]+", "", s)
        if folded:
            return folded
        # All-non-Latin titles (CJK/Cyrillic/Greek/Arabic) fold to "" above,
        # which would collapse every such song into one bogus work. Fall back to
        # the raw text lowercased with whitespace collapsed so distinct titles
        # keep distinct keys. Latin names always hit the `folded` branch, so
        # their behavior is unchanged.
        return re.sub(r"\s+", " ", raw.strip().lower())

    @classmethod
    def _work_key(cls, artist, title) -> str:
        """Identity of a musical WORK = normalize(artist)+'|'+normalize(title).
        Recording-MBID identity is a later enrichment upgrade (§3); this text key
        groups the common 'same song, several charts' case now."""
        return cls._norm_token(artist, fold_the=True) + "|" + cls._norm_token(title)

    def _alias_map_if_exists(self) -> dict:
        """{raw_artist_lower: canonical} from P4's artist_alias when that table is
        present, so work_key groups across artist aliases (ACDC/AC/DC) once P4 is
        merged; {} (→ raw artist) when it isn't. Forward-compatible, no hard P4 dep."""
        try:
            rows = self.conn.execute("SELECT raw_name, canonical_name FROM artist_alias").fetchall()
        except Exception:
            return {}
        return {r[0].lower(): r[1] for r in rows}

    @staticmethod
    def _pick_representative(members: list, prefs: dict) -> str:
        """The keeper chart of a group: the user's chart_group_pref when its file
        is present, else auto-pick = MOST-PLAYED (history-sticky, §7.1: real
        practice wins — a newer/'more complete' import must not silently take
        the pick from the chart your reps accrued on, and a one-off try of an
        alternate can't out-rank a practiced incumbent) → most-complete
        (arrangements) → newest → filename. An all-unplayed group therefore
        still picks by completeness. `members` = dicts {fn, wk, arr, plays, mtime}."""
        if members:
            pref = prefs.get(members[0]["wk"])
            if pref and any(m["fn"] == pref for m in members):
                return pref
        best = min(members, key=lambda m: (-m["plays"], -m["arr"], -m["mtime"], m["fn"]))
        return best["fn"]

    def _load_work_members(self):
        """Read songs + overrides → ({effective_work_key: [member dicts]}, prefs)."""
        amap = self._alias_map_if_exists()
        splits = dict(self.conn.execute(
            "SELECT filename, split_key FROM chart_group_split").fetchall())
        prefs = dict(self.conn.execute(
            "SELECT work_key, preferred_filename FROM chart_group_pref").fetchall())
        plays = dict(self.conn.execute(
            "SELECT filename, SUM(plays) FROM song_stats GROUP BY filename").fetchall())
        groups: dict = {}
        for fn, artist, title, arr_json, mtime in self.conn.execute(
                "SELECT filename, artist, title, arrangements, mtime FROM songs WHERE title != ''"):
            wk = self._work_key(amap.get((artist or "").lower(), artist), title)
            eff = splits.get(fn) or wk
            try:
                arr = len(json.loads(arr_json)) if arr_json else 0
            except Exception:
                arr = 0
            groups.setdefault(eff, []).append(
                {"fn": fn, "wk": wk, "arr": arr, "plays": int(plays.get(fn) or 0), "mtime": mtime or 0})
        return groups, prefs

    def rebuild_work_display(self) -> None:
        """Full re-materialization of work_display from songs + the override
        tables. O(n) — cheap enough to run lazily after any songs churn."""
        with self._lock:
            groups, prefs = self._load_work_members()
            out = []
            for eff, members in groups.items():
                rep = self._pick_representative(members, prefs)
                n = len(members)
                for m in members:
                    out.append((m["fn"], m["wk"], eff, 1 if m["fn"] == rep else 0, n))
            self.conn.execute("DELETE FROM work_display")
            if out:
                self.conn.executemany(
                    "INSERT INTO work_display (filename, work_key, effective_work_key, "
                    "is_group_representative, group_size) VALUES (?, ?, ?, ?, ?)", out)
            self.conn.commit()
            self._work_display_dirty = False

    def _ensure_work_display(self) -> None:
        """(Re)build the read-model when a change marked it dirty (or it's never
        been built). Called at the top of every grouped query."""
        if getattr(self, "_work_display_dirty", True):
            self.rebuild_work_display()

    def work_key_for(self, filename: str):
        """work_key of a song (from its current artist+title), or None if absent."""
        row = self.conn.execute(
            "SELECT artist, title FROM songs WHERE filename = ?", (filename,)).fetchone()
        if not row:
            return None
        amap = self._alias_map_if_exists()
        return self._work_key(amap.get((row[0] or "").lower(), row[0]), row[1])

    def set_chart_preferred(self, work_key: str, filename: str) -> None:
        """Pick the keeper chart of a work. Incremental: re-flips
        is_group_representative within the work's (non-split) group only —
        group_size is unchanged — so no full rebuild."""
        with self._lock:
            self.conn.execute(
                "INSERT INTO chart_group_pref (work_key, preferred_filename, updated_at) "
                "VALUES (?, ?, datetime('now')) "
                "ON CONFLICT(work_key) DO UPDATE SET "
                "preferred_filename = excluded.preferred_filename, updated_at = excluded.updated_at",
                (work_key, filename))
            if not self._work_display_dirty:
                members = [r[0] for r in self.conn.execute(
                    "SELECT filename FROM work_display WHERE effective_work_key = ?",
                    (work_key,)).fetchall()]
                if filename in members:
                    self.conn.execute(
                        "UPDATE work_display SET is_group_representative = "
                        "CASE WHEN filename = ? THEN 1 ELSE 0 END "
                        "WHERE effective_work_key = ?", (filename, work_key))
                else:
                    # pref target isn't a current member (orphan/split) — reconcile
                    # on the next lazy rebuild rather than leave it half-applied.
                    self._work_display_dirty = True
            self.conn.commit()

    def clear_chart_preferred(self, work_key: str) -> None:
        """Reset a work to auto-pick; lazy full rebuild."""
        with self._lock:
            self.conn.execute("DELETE FROM chart_group_pref WHERE work_key = ?", (work_key,))
            self._work_display_dirty = True
            self.conn.commit()

    def split_chart(self, filename: str) -> None:
        """'These aren't the same' — give a chart a unique split_key so it stands
        alone as a singleton work. Lazy full rebuild (the old group's membership +
        sizes shift)."""
        wk = self.work_key_for(filename) or filename
        with self._lock:
            self.conn.execute(
                "INSERT INTO chart_group_split (filename, split_key, updated_at) "
                "VALUES (?, ?, datetime('now')) "
                "ON CONFLICT(filename) DO UPDATE SET "
                "split_key = excluded.split_key, updated_at = excluded.updated_at",
                (filename, f"{wk}#split#{filename}"))
            self._work_display_dirty = True
            self.conn.commit()

    def unsplit_chart(self, filename: str) -> None:
        """Undo a split — the chart rejoins its work. Lazy full rebuild."""
        with self._lock:
            self.conn.execute("DELETE FROM chart_group_split WHERE filename = ?", (filename,))
            self._work_display_dirty = True
            self.conn.commit()

    def work_charts(self, work_key: str) -> dict:
        """Every chart in a work (P5b) — the Charts drawer's data. Members are the
        work's CURRENT (non-split) group: work_display rows whose effective_work_key
        matches. Each carries its effective title/artist, arrangements, tuning,
        format, best accuracy, and the representative/preferred flags so the drawer
        can label 'Preferred — your pick' vs 'Preferred (auto)'."""
        self._ensure_work_display()
        amap = self._alias_map_if_exists()
        pref_row = self.conn.execute(
            "SELECT preferred_filename FROM chart_group_pref WHERE work_key = ?", (work_key,)).fetchone()
        pref_fn = pref_row[0] if pref_row else None
        rows = self.conn.execute(
            "SELECT wd.filename, wd.is_group_representative, s.title, s.artist, s.album, s.year, "
            "s.arrangements, s.tuning_name, s.tuning, s.format, "
            "(SELECT MAX(best_accuracy) FROM song_stats st WHERE st.filename = wd.filename AND st.plays > 0) "
            "FROM work_display wd JOIN songs s ON s.filename = wd.filename "
            "WHERE wd.effective_work_key = ? "
            "ORDER BY wd.is_group_representative DESC, s.title COLLATE NOCASE, s.filename",
            (work_key,)).fetchall()
        charts = []
        for fn, is_rep, title, artist, album, year, arr_json, tuning_name, tuning, fmt, best in rows:
            try:
                arrangements = _ensure_smart_names(json.loads(arr_json) if arr_json else [])
            except Exception:
                arrangements = []
            charts.append({
                "filename": fn,
                "title": title or fn,
                "artist": amap.get((artist or "").lower(), artist) or "",
                "album": album or "", "year": year or "",
                "arrangements": arrangements,
                "tuning_name": tuning_name or "", "tuning": tuning or "",
                "format": fmt or "archive",
                "best_accuracy": best,
                "is_representative": bool(is_rep),
                "is_preferred": (fn == pref_fn),
            })
        return {
            "work_key": work_key,
            "count": len(charts),
            "preferred_filename": pref_fn,
            # Whether the keeper is your explicit pick or the auto-pick — drives the
            # drawer's "Preferred — your pick" vs "Preferred (auto)" label.
            "preferred_source": "user" if pref_fn else "auto",
            "charts": charts,
        }

    def chart_work(self, filename: str) -> dict:
        """The work a chart belongs to (P5d): its EFFECTIVE work_key (a split
        chart resolves to its own singleton key) + how many charts share it.
        Lets an opener resolve group membership for rows that didn't come from
        a grouped query — the tree view's rows ride the ungrouped artists
        endpoint, so they carry no chart_count/work_key annotation."""
        key = self._canonical_song_filename(filename)
        self._ensure_work_display()
        row = self.conn.execute(
            "SELECT effective_work_key, group_size FROM work_display WHERE filename = ?",
            (key,)).fetchone()
        if not row:
            return {"filename": key, "work_key": None, "chart_count": 0, "is_split": False}
        split = self.conn.execute(
            "SELECT 1 FROM chart_group_split WHERE filename = ?", (key,)).fetchone()
        return {"filename": key, "work_key": row[0], "chart_count": row[1],
                "is_split": bool(split)}

    # Predicate that narrows a query to one representative chart per work — the
    # keyset-safe grouping filter (see query_page / query_stats).
    _GROUP_REP_PREDICATE = " AND filename IN (SELECT filename FROM work_display WHERE is_group_representative = 1)"

    def query_page(self, q: str = "", page: int = 0, size: int = 24,
                   sort: str = "artist", direction: str = "asc",
                   favorites_only: bool = False,
                   format_filter: str = "",
                   artist_filter: str = "",
                   album_filter: str = "",
                   arrangements_has: list[str] | None = None,
                   arrangements_lacks: list[str] | None = None,
                   stems_has: list[str] | None = None,
                   stems_lacks: list[str] | None = None,
                   has_lyrics: int | None = None,
                   tunings: list[str] | None = None,
                   mastery: list[str] | None = None,
                   tags_has: list[str] | None = None,
                   user_difficulty_in: list[str] | None = None,
                   match_states: list[str] | None = None,
                   genre: list[str] | None = None,
                   after: str | None = None,
                   group: bool = False,
                   naming_mode: str = "legacy",
                   instrument: str = DEFAULT_PERSPECTIVE,
                   playable_from_pitch: int | None = None) -> tuple[list[dict], int]:
        """Server-side paginated search. Returns (songs, total_count).

        `after` is an opaque keyset cursor (the last row of the previous page).
        When supplied and the sort can keyset, the page is fetched with a
        WHERE-seek instead of OFFSET — O(page), independent of depth. Unknown
        sorts / bad cursors fall back to OFFSET, so it's always safe.

        `group` collapses a work's charts to one card (P5a): it adds a single
        `WHERE is_group_representative = 1` predicate over the materialized
        work_display, so the total counts WORKS not charts and the keyset seek /
        sort / A–Z all stay correct over the representative subset. Each grouped
        row carries `chart_count` (the ⚑ N).

        Filter law under grouping (P5e, §7.1): work-identity (artist/album/q)
        + practice-state (favorites/mastery/tags/difficulty) predicates stay on
        the representative row (identity ≈ the work; practice-state anchors on
        the preferred chart), while CHART-INTRINSIC predicates (format/
        arrangements/stems/lyrics/tuning) match if ANY member of the work does
        — and when the representative itself doesn't match, the row carries a
        `display_chart` override so the card can show/play the matching one."""
        where, params = self._build_where(
            q=q, favorites_only=favorites_only, format_filter=format_filter,
            artist_filter=artist_filter, album_filter=album_filter,
            arrangements_has=arrangements_has, arrangements_lacks=arrangements_lacks,
            stems_has=stems_has, stems_lacks=stems_lacks,
            has_lyrics=has_lyrics, tunings=tunings, mastery=mastery,
            tags_has=tags_has, user_difficulty_in=user_difficulty_in,
            match_states=match_states, genre=genre,
            naming_mode=naming_mode, instrument=instrument,
            playable_from_pitch=playable_from_pitch,
            include_intrinsic=not group,
        )
        ifrag, iparams = "", []
        if group:
            self._ensure_work_display()
            ifrag, iparams = self._build_intrinsic_where(
                "m", format_filter=format_filter,
                arrangements_has=arrangements_has, arrangements_lacks=arrangements_lacks,
                stems_has=stems_has, stems_lacks=stems_lacks,
                has_lyrics=has_lyrics, tunings=tunings, naming_mode=naming_mode,
                instrument=instrument, playable_from_pitch=playable_from_pitch)
            mfrag, mparams = self._grouped_member_match(ifrag, iparams)
            where += mfrag
            params += mparams
            where += self._GROUP_REP_PREDICATE

        _eff_tuning_name, _, _eff_tuning_sort = _effective_tuning_cols_sql("songs", instrument)
        sort_map = {
            # Artist sorts order WITHIN an artist by title (the tree view's
            # artist -> album -> title feel) instead of raw filename — the
            # "list is organised, cards look random" report. Direction is
            # baked per entry (the legacy `dir=desc` append would otherwise
            # land on the title term); title stays ascending under Z->A.
            "artist": "artist COLLATE NOCASE ASC, title COLLATE NOCASE ASC",
            "artist-desc": "artist COLLATE NOCASE DESC, title COLLATE NOCASE ASC",
            "title": "title COLLATE NOCASE", "title-desc": "title COLLATE NOCASE DESC",
            "recent": "mtime DESC",
            # Tuning sort uses musical distance from E Standard
            # (feedBack#22 — was alphabetical). `tuning_sort_key` is
            # the sum of per-string offsets, so |sort_key| is the
            # magnitude of the down/up-tune. ABS ascending puts E
            # Standard (0) first, then ±2 (Drop D, F Standard), then
            # ±6 (Eb Standard, F# Standard), and so on. Within a
            # magnitude tier we break ties by signed key ASC so the
            # negative (down-tuned) variant comes before the positive
            # (up-tuned) one — Eb Standard before F Standard, matching
            # how the app groups its tuning list. Final tiebreak by
            # name keeps the order fully deterministic.
            #
            # Leading term pushes pre-migration / unscanned rows to
            # the bottom — without it ABS(0) collides with E
            # Standard's 0 and unindexed rows would sort first.
            # COALESCE on every column the clause references guards
            # against NULL values — SQLite's literal-constant ADD
            # COLUMN does backfill on most versions, but raw SQL
            # inserts that bypass `put()`, edge-case migration paths,
            # or future code that writes None could still leave NULLs
            # behind, and a NULL `tuning_name` in `(tuning_name = '')`
            # evaluates to NULL itself (which sorts ahead of 0 in
            # ASC), defeating the push-to-bottom intent.
            #
            # Under `instrument=bass` the effective expressions swap in
            # the bass arrangement's tuning (guitar fallback) so a bass
            # player's tuning sort orders by the tuning they'd play.
            "tuning": (
                f"(COALESCE({_eff_tuning_name}, '') = '') ASC, "
                f"ABS(COALESCE({_eff_tuning_sort}, 0)), "
                f"COALESCE({_eff_tuning_sort}, 0) ASC, "
                f"COALESCE({_eff_tuning_name}, '') COLLATE NOCASE"
            ),
            # Year sort (feedBack#128). Empty-year rows pushed to the
            # bottom for both directions; otherwise CAST so '2010' >
            # '2005' rather than alphabetic.
            "year": "(year = '') ASC, CAST(year AS INTEGER) ASC",
            "year-desc": "(year = '') ASC, CAST(year AS INTEGER) DESC",
            # Album track order: authored track number (disc, then track); songs
            # with no number fall to the bottom, ordered by title. Used by the
            # album detail view. Alpha-by-title is the fallback when unauthored.
            "track": "(track_number IS NULL) ASC, COALESCE(disc, 1), track_number, title COLLATE NOCASE",
            # Mastery = best accuracy across a song's arrangements, from the
            # separate song_stats table (so via a correlated subquery — this sort
            # drops to OFFSET paging, like tuning/year). Unscored ("not started")
            # songs push to the BOTTOM in both directions (the IS NULL term);
            # ascending is "needs practice first" (weakest measured first),
            # descending is "most mastered first".
            "mastery": (
                "((SELECT MAX(best_accuracy) FROM song_stats s WHERE s.filename = songs.filename) IS NULL) ASC, "
                "(SELECT MAX(best_accuracy) FROM song_stats s WHERE s.filename = songs.filename) ASC"
            ),
            "mastery-desc": (
                "((SELECT MAX(best_accuracy) FROM song_stats s WHERE s.filename = songs.filename) IS NULL) ASC, "
                "(SELECT MAX(best_accuracy) FROM song_stats s WHERE s.filename = songs.filename) DESC"
            ),
            # Personal difficulty rating (song_user_meta.user_difficulty, 1..5 —
            # manually set or seeded by the difficulty_tagger plugin), via a
            # correlated subquery like mastery above (drops to OFFSET paging).
            # Unrated songs push to the bottom in both directions.
            "difficulty": (
                "((SELECT user_difficulty FROM song_user_meta u WHERE u.filename = songs.filename) IS NULL) ASC, "
                "(SELECT user_difficulty FROM song_user_meta u WHERE u.filename = songs.filename) ASC"
            ),
            "difficulty-desc": (
                "((SELECT user_difficulty FROM song_user_meta u WHERE u.filename = songs.filename) IS NULL) ASC, "
                "(SELECT user_difficulty FROM song_user_meta u WHERE u.filename = songs.filename) DESC"
            ),
        }
        if group and sort in ("mastery", "mastery-desc"):
            # Sort law (§7.1): mastery aggregates MAX across the WHOLE group —
            # a song surfaces on any chart you've touched, even when the
            # preferred chart is unplayed. Mastery never keysets (OFFSET
            # paging), so the aggregate can't disturb a cursor. The recency
            # ("Recently Added") aggregate is deliberately NOT applied: mtime
            # IS a keyset sort, so its aggregate would need materializing into
            # work_display to stay cursor-safe — deferred until wanted (the
            # auto-pick's `newest` factor already surfaces new charts of
            # unplayed works; played works stay put by the sticky rule).
            _gm = ("(SELECT MAX(st.best_accuracy) FROM song_stats st "
                   "JOIN work_display sw ON sw.filename = st.filename "
                   "WHERE sw.effective_work_key = (SELECT w1.effective_work_key "
                   "FROM work_display w1 WHERE w1.filename = songs.filename))")
            sort_map["mastery"] = f"({_gm} IS NULL) ASC, {_gm} ASC"
            sort_map["mastery-desc"] = f"({_gm} IS NULL) ASC, {_gm} DESC"
        # Fold the legacy `dir=desc` toggle into the canonical sort key BEFORE
        # the lookup, so the ORDER BY is built from the effective sort — mirrors
        # what `_effective_keyset_sort` does on the cursor side. Needed because
        # the artist clause now bakes in `ASC` (for the title secondary), so the
        # ` DESC` append below is suppressed and would otherwise silently ignore
        # `sort=artist&dir=desc` (return A→Z). Only artist/title fold (they have
        # `-desc` twins); tuning/year/mastery keep their own dir handling.
        eff = _effective_keyset_sort(sort, direction)
        order = sort_map.get(eff, "artist COLLATE NOCASE")
        # Legacy `dir=desc` toggle: only safe to append on simple sort
        # clauses that don't already encode a direction. Compound /
        # multi-term entries above (artist, tuning, year, year-desc) bake their
        # ASC/DESC into the clause, so a global ` DESC` append would
        # produce invalid SQL like `CAST(year AS INTEGER) ASC DESC`.
        # Skip the append in that case — clients flipping direction on
        # those sorts use the explicit `-desc` sort key instead. (For
        # artist/title the fold above already picked the `-desc` clause.)
        if direction == "desc" and " ASC" not in order and " DESC" not in order:
            order += " DESC"
        # Unique, deterministic tiebreak → a TOTAL order. Without it, rows with
        # an equal sort key can reshuffle between OFFSET pages (skip/dupe); it's
        # also what makes keyset seeking correct.
        order += ", filename"

        # Grouped reads filter through the materialized work_display (the
        # `is_group_representative=1` predicate). rebuild_work_display does
        # DELETE→INSERT→commit under self._lock, so a lock-free reader on
        # another thread (shared conn, check_same_thread=False) could land its
        # SELECT in the mid-rebuild window and see 0 rows. Hold self._lock
        # across the representative COUNT+SELECT so it can't overlap a rebuild.
        # _ensure_work_display already rebuilt above under its own lock (and
        # self._lock is NOT reentrant), so we must NOT nest it here. Ungrouped
        # reads stay lock-free (WAL) via nullcontext.
        read_guard = self._lock if group else contextlib.nullcontext()
        with read_guard:
            total = self.conn.execute(f"SELECT COUNT(*) FROM songs {where}", params).fetchone()[0]

            cols = ("SELECT filename, title, artist, album, year, duration, tuning, "
                    "arrangements, has_lyrics, mtime, format, stem_count, stem_ids, "
                    "tuning_name, tuning_offsets, bass_tuning_name, bass_tuning_offsets, "
                    "rhythm_tuning_name, rhythm_tuning_offsets "
                    "FROM songs ")
            cursor = _decode_cursor(after) if after else None
            eff_sort = _effective_keyset_sort(sort, direction)
            if cursor and eff_sort in _KEYSET_SORTS:
                # Keyset seek: rows strictly after the cursor in the total order
                # `<col> <dir>, filename ASC` (NULL-aware, so == OFFSET exactly).
                col, collate, primary_dir = _KEYSET_SORTS[eff_sort]
                seek, seek_params = _keyset_seek(col, collate, primary_dir, cursor[0], cursor[1])
                seek_where = where + (" AND " if where else " WHERE ") + seek
                rows = self.conn.execute(
                    f"{cols}{seek_where} ORDER BY {order} LIMIT ?",
                    params + seek_params + [size],
                ).fetchall()
            else:
                rows = self.conn.execute(
                    f"{cols}{where} ORDER BY {order} LIMIT ? OFFSET ?",
                    params + [size, page * size],
                ).fetchall()

        estd = self._estd_set()
        favs = self.favorite_set()
        songs = []
        for r in rows:
            songs.append({
                "filename": r[0], "title": r[1], "artist": r[2], "album": r[3],
                "year": r[4], "duration": r[5], "tuning": r[6],
                "arrangements": _ensure_smart_names(json.loads(r[7]) if r[7] else []),
                "has_lyrics": bool(r[8]), "mtime": r[9],
                "format": r[10] or "archive",
                "stem_count": int(r[11] or 0),
                "stem_ids": json.loads(r[12]) if r[12] else [],
                "tuning_name": r[13] or "",
                "tuning_offsets": r[14] or "",
                # '' when the song has no bass arrangement (or the row predates
                # '' when the song has no such chart (or the row predates the
                # columns) — clients fall back to tuning_name.
                "bass_tuning_name": r[15] or "",
                "bass_tuning_offsets": r[16] or "",
                "rhythm_tuning_name": r[17] or "",
                "rhythm_tuning_offsets": r[18] or "",
                "has_estd": r[0] in estd, "favorite": r[0] in favs,
            })
        # PROVENANCE (non-default perspectives): a row shown to a bass or
        # rhythm player either carries that chart's own tuning (native) or is
        # borrowing the guitar-derived song tuning (inferred). The fallback is
        # deliberate — a third of a real library has no bass chart and
        # excluding it would be worse — but it must never be SILENT, or we
        # reproduce the original bug in a new place. The client marks inferred
        # rows; it can't infer this itself without duplicating the COALESCE.
        #
        # guitar-lead adds NOTHING here, so the default payload is unchanged.
        _persp = _perspective(instrument)
        if _persp.column_prefix:
            _name_key = _persp.column("name")
            for s in songs:
                s["tuning_perspective"] = _persp.id
                s["tuning_inferred"] = not s.get(_name_key)
        # Personal layer (difficulty + tags) rides along like `favorite`, so a
        # card can badge it without a second request. Notes stay OUT of the list
        # payload (they can be long) — fetch per-song via /user-meta. Batched to
        # avoid an N+1 over the page.
        fns = [s["filename"] for s in songs]
        udm = self.user_meta_map(fns)
        tgm = self.tags_map(fns)
        # Enrichment "no match" (failed) set for the page, so a card can show a
        # persistent "no match" badge — the Refresh-Metadata batch's transient
        # per-tile state only paints while a pass runs. Cheap set membership like
        # favs/estd, so the misses stay visible at rest.
        um = self._unmatched_set(fns)
        # Per-song display OVERRIDES (Fix-metadata popup, slice 3). "Grid shows
        # only overrides": the effective cell is the user's override else the
        # pack value — a matched MusicBrainz canon NEVER silently re-titles a
        # card (canon lives in the Details drawer + art). Overlaid in Python
        # over the visible window, keyset-safe exactly like the P4 alias re-label
        # below: the seek still runs on the raw column (the one overridable
        # keyset column, title, stashes its raw value for the cursor — see
        # _sort_title / next_library_cursor).
        omap = self.overrides_map(fns)
        # Canonical artist at display (P4): re-label the card's artist through the
        # alias override so "ACDC" reads as "AC/DC". Display-only — the row's sort
        # position (raw artist) is untouched, so a card can show a canonical name
        # that differs from its A–Z bucket for cross-letter aliases; the full
        # sort/rail reindex under aliases is the P5a materialization pass.
        amap = self.alias_map()
        for s in songs:
            s["user_difficulty"] = udm.get(s["filename"])
            s["tags"] = tgm.get(s["filename"], [])
            s["unmatched"] = s["filename"] in um
            if amap:
                s["artist"] = amap.get((s.get("artist") or "").lower(), s.get("artist"))
            # English-base romaji fallback: a blank-artist CDLC pack shows nothing
            # useful (artist blank; title = the raw filename). Surface the author's
            # romaji from the "Artist_Title_v1_p" filename so the card reads
            # "Junko Yagami — BAY CITY", never blank or native script. Display-only;
            # a user override (below) still wins. Keyset-safe: stash the raw title
            # for the cursor before replacing it.
            if not (s.get("artist") or "").strip():
                r_artist, r_title = self._romaji_display(s["filename"], s.get("artist"), s.get("title"))
                if r_title != s.get("title") and "_sort_title" not in s:
                    s["_sort_title"] = s["title"]
                s["artist"], s["title"] = r_artist, r_title
            # Override wins over the pack AND the alias re-label — it's the user's
            # explicit per-song choice. Only a non-empty override VALUE replaces a
            # cell; a lock-only row (value None) leaves the displayed value alone.
            ov = omap.get(s["filename"])
            if ov:
                for field in ("title", "artist", "album", "year"):
                    cell = ov.get(field)
                    val = cell.get("value") if cell else None
                    if val:
                        if field == "title" and "_sort_title" not in s:
                            s["_sort_title"] = s["title"]   # raw title, for the keyset cursor
                        s[field] = val
        # Grouped rows carry the ⚑ N (chart_count) + the work_key from the
        # materialized read-model, so the card can render the "N charts" chip and
        # address the Charts drawer (GET /api/work/{work_key}/charts) without a
        # second request — plus `is_split` (P5e) so the ⋮ menu can offer the
        # "Rejoin other versions" undo on a split-out chart.
        if group and fns:
            ph = ",".join("?" * len(fns))
            wd = {r[0]: (r[1], r[2], r[3]) for r in self.conn.execute(
                "SELECT filename, group_size, work_key, effective_work_key "
                f"FROM work_display WHERE filename IN ({ph})", fns).fetchall()}
            splits = {r[0] for r in self.conn.execute(
                f"SELECT filename FROM chart_group_split WHERE filename IN ({ph})", fns).fetchall()}
            eff_by_fn = {}
            for s in songs:
                gs, wk, eff = wd.get(s["filename"], (1, None, None))
                s["chart_count"] = gs
                s["work_key"] = wk
                s["is_split"] = s["filename"] in splits
                if eff:
                    eff_by_fn[s["filename"]] = eff
            if ifrag:
                self._attach_display_charts(songs, eff_by_fn, ifrag, iparams)
        return songs, total

    def _attach_display_charts(self, songs: list[dict], eff_by_fn: dict,
                               intrinsic_frag: str, intrinsic_params: list) -> None:
        """§7.1: when chart-intrinsic filters admit a work through a member the
        REPRESENTATIVE doesn't itself satisfy, the card 'switches its displayed
        chart to a matching one'. The row (sort keys, cursor identity, the
        mastery/favorite anchor) stays the representative's — only the
        display/play facts ride along under `display_chart`, so keyset paging
        and the practice-state anchor are untouched. `intrinsic_frag`/`params`
        are the member-aliased ('m') predicates already built by the caller."""
        keys = sorted(set(eff_by_fn.values()))
        if not keys:
            return
        ph = ",".join("?" * len(keys))
        rows = self.conn.execute(
            "SELECT mw.effective_work_key, m.filename, m.title, m.duration, m.tuning, "
            "m.arrangements, m.has_lyrics, m.mtime, m.format, m.stem_count, m.stem_ids, "
            "m.tuning_name, m.tuning_offsets, m.bass_tuning_name, m.bass_tuning_offsets "
            "FROM songs m JOIN work_display mw ON mw.filename = m.filename "
            f"WHERE mw.effective_work_key IN ({ph}){intrinsic_frag} "
            "ORDER BY mw.is_group_representative DESC, m.mtime DESC, m.filename",
            keys + list(intrinsic_params)).fetchall()
        best: dict = {}
        for r in rows:
            best.setdefault(r[0], r)   # rep-first, then newest — one match per work
        for s in songs:
            m = best.get(eff_by_fn.get(s["filename"]))
            if not m or m[1] == s["filename"]:
                continue   # the representative itself matches (or nothing does)
            s["display_chart"] = {
                "filename": m[1], "title": m[2] or m[1], "duration": m[3],
                "tuning": m[4],
                "arrangements": _ensure_smart_names(json.loads(m[5]) if m[5] else []),
                "has_lyrics": bool(m[6]), "mtime": m[7],
                "format": m[8] or "archive",
                "stem_count": int(m[9] or 0),
                "stem_ids": json.loads(m[10]) if m[10] else [],
                "tuning_name": m[11] or "", "tuning_offsets": m[12] or "",
                "bass_tuning_name": m[13] or "", "bass_tuning_offsets": m[14] or "",
            }

    def query_artists(self, letter: str = "", q: str = "",
                      favorites_only: bool = False,
                      page: int = 0, size: int = 50,
                      format_filter: str = "",
                      artist_filter: str = "",
                      album_filter: str = "",
                      arrangements_has: list[str] | None = None,
                      arrangements_lacks: list[str] | None = None,
                      stems_has: list[str] | None = None,
                      stems_lacks: list[str] | None = None,
                      has_lyrics: int | None = None,
                      tunings: list[str] | None = None,
                      naming_mode: str = "legacy",
                      instrument: str = DEFAULT_PERSPECTIVE,
                      playable_from_pitch: int | None = None) -> tuple[list[dict], int]:
        """Get artists grouped by letter with their albums and songs. Returns (artists, total_artists)."""
        where, params = self._build_where(
            q=q, favorites_only=favorites_only, format_filter=format_filter,
            artist_filter=artist_filter, album_filter=album_filter,
            arrangements_has=arrangements_has, arrangements_lacks=arrangements_lacks,
            stems_has=stems_has, stems_lacks=stems_lacks,
            has_lyrics=has_lyrics, tunings=tunings, naming_mode=naming_mode,
            instrument=instrument, playable_from_pitch=playable_from_pitch,
        )
        # Canonicalize artists at display when aliases exist (P4): dedupe / group /
        # letter / order on the EFFECTIVE artist so "ACDC" + "AC/DC" list as one
        # entry. With no aliases, `art_expr` stays the plain (indexed) `artist`
        # column, so the common case pays zero subquery cost.
        has_aliases = self.conn.execute("SELECT 1 FROM artist_alias LIMIT 1").fetchone() is not None
        art_expr = self._EFFECTIVE_ARTIST_SQL if has_aliases else "artist"

        if letter == "#":
            where += f" AND ({art_expr}) NOT GLOB '[A-Za-z]*'"
        elif letter:
            where += f" AND UPPER(SUBSTR(({art_expr}), 1, 1)) = ?"
            params.append(letter.upper())

        # Get paginated distinct (effective) artists
        total_artists = self.conn.execute(
            f"SELECT COUNT(DISTINCT ({art_expr}) COLLATE NOCASE) FROM songs {where}", params
        ).fetchone()[0]

        artist_rows = self.conn.execute(
            f"SELECT DISTINCT ({art_expr}) COLLATE NOCASE as a FROM songs {where} ORDER BY a LIMIT ? OFFSET ?",
            params + [size, page * size]
        ).fetchall()
        artist_names = [r[0] for r in artist_rows]

        if not artist_names:
            return [], total_artists

        # Fetch songs for these (effective) artists only
        placeholders = ",".join(["?"] * len(artist_names))
        song_where = f"{where} AND ({art_expr}) COLLATE NOCASE IN ({placeholders})"
        song_params = params + artist_names

        rows = self.conn.execute(
            f"SELECT filename, title, ({art_expr}) as artist, album, year, duration, tuning, arrangements, has_lyrics, "
            f"format, stem_count, stem_ids, tuning_name, bass_tuning_name "
            f"FROM songs {song_where} ORDER BY ({art_expr}) COLLATE NOCASE, album COLLATE NOCASE, title COLLATE NOCASE",
            song_params
        ).fetchall()

        # Group into artist -> album -> songs
        from collections import OrderedDict
        estd = self._estd_set()
        favs = self.favorite_set()
        # Personal difficulty rides along here too (feedBack#810 follow-up),
        # same batched pattern as query_page — without this the tree view's
        # difficulty badge silently never renders (song.user_difficulty was
        # always undefined for every row).
        udm = self.user_meta_map([r[0] for r in rows])
        artists = OrderedDict()
        for r in rows:
            artist = r[2] or "Unknown Artist"
            album = r[3] or "Unknown Album"
            akey = artist.lower()
            if akey not in artists:
                artists[akey] = {"name": artist, "albums": OrderedDict()}
            bkey = album.lower()
            if bkey not in artists[akey]["albums"]:
                artists[akey]["albums"][bkey] = {"name": album, "songs": []}
            artists[akey]["albums"][bkey]["songs"].append({
                "filename": r[0], "title": r[1], "artist": r[2], "album": r[3],
                "year": r[4], "duration": r[5], "tuning": r[6],
                "arrangements": _ensure_smart_names(json.loads(r[7]) if r[7] else []),
                "has_lyrics": bool(r[8]),
                "format": r[9] or "archive",
                "stem_count": int(r[10] or 0),
                "stem_ids": json.loads(r[11]) if r[11] else [],
                "tuning_name": r[12] or "",
                "bass_tuning_name": r[13] or "",
                "has_estd": r[0] in estd,
                "favorite": r[0] in favs,
                "user_difficulty": udm.get(r[0]),
            })

        # Pick most common name variant per artist/album
        result = []
        for akey, aval in artists.items():
            albums = []
            for bkey, bval in aval["albums"].items():
                albums.append({"name": bval["name"], "songs": bval["songs"]})
            result.append({"name": aval["name"], "album_count": len(albums),
                           "song_count": sum(len(a["songs"]) for a in albums), "albums": albums})
        return result, total_artists

    def query_albums(self, q="", favorites_only=False, format_filter="",
                     artist_filter="", album_filter="",
                     arrangements_has=None, arrangements_lacks=None,
                     stems_has=None, stems_lacks=None,
                     has_lyrics=None, tunings=None, mastery=None,
                     match_states=None, genre=None,
                     naming_mode="legacy", instrument=DEFAULT_PERSPECTIVE,
                     playable_from_pitch=None, page=0, size=120):
        """Distinct (artist, album) groups with a track count + a representative
        cover song, for the album-condensed browse (paged by album). Rows with no
        album name are excluded -- they can't form an album card. Same filters as
        query_page."""
        where, params = self._build_where(
            q=q, favorites_only=favorites_only, format_filter=format_filter,
            artist_filter=artist_filter, album_filter=album_filter,
            arrangements_has=arrangements_has, arrangements_lacks=arrangements_lacks,
            stems_has=stems_has, stems_lacks=stems_lacks,
            has_lyrics=has_lyrics, tunings=tunings, mastery=mastery,
            match_states=match_states, genre=genre,
            naming_mode=naming_mode, instrument=instrument,
            playable_from_pitch=playable_from_pitch,
        )
        awhere = where + " AND album IS NOT NULL AND album != ''"
        total = self.conn.execute(
            f"SELECT COUNT(*) FROM (SELECT 1 FROM songs {awhere} "
            f"GROUP BY artist COLLATE NOCASE, album COLLATE NOCASE)", params
        ).fetchone()[0]
        rows = self.conn.execute(
            f"SELECT artist, album, COUNT(*) AS n, MIN(filename) AS cover "
            f"FROM songs {awhere} "
            f"GROUP BY artist COLLATE NOCASE, album COLLATE NOCASE "
            f"ORDER BY artist COLLATE NOCASE, album COLLATE NOCASE LIMIT ? OFFSET ?",
            params + [size, page * size]
        ).fetchall()
        return ([{"artist": r[0] or "Unknown Artist", "album": r[1] or "Unknown Album",
                  "count": int(r[2] or 0), "cover": r[3]} for r in rows], total)

    def query_stats(self, favorites_only: bool = False,
                    q: str = "", format_filter: str = "",
                    artist_filter: str = "",
                    album_filter: str = "",
                    arrangements_has: list[str] | None = None,
                    arrangements_lacks: list[str] | None = None,
                    stems_has: list[str] | None = None,
                    stems_lacks: list[str] | None = None,
                    has_lyrics: int | None = None,
                    tunings: list[str] | None = None,
                    match_states: list[str] | None = None,
                    sort: str = "artist",
                    want_sort_letters: bool = False,
                    group: bool = False,
                    naming_mode: str = "legacy",
                    instrument: str = DEFAULT_PERSPECTIVE,
                    playable_from_pitch: int | None = None) -> dict:
        """Aggregate stats for the letter bar. Accepts the same filter
        params as query_page so the letter counts stay synchronized
        with the grid when filters are active.

        `group` (P5a) restricts every count to one representative chart per work
        (the same predicate query_page uses), so `total_songs` and the jump-rail
        `sort_letters` count WORKS not charts and stay in lockstep with the
        grouped grid.

        `sort` selects the column the v3 jump rail's `sort_letters`
        breakdown keys on (artist for artist sorts, title for title
        sorts) so the rail's present-letters match the grid's actual
        order; other sorts fall back to artist (the rail is hidden for
        them client-side anyway). The legacy `letters` field is always
        the artist breakdown, unchanged, for the dashboard + classic tree.

        `sort_letters` is computed (and the key included) ONLY when
        `want_sort_letters` is set — the jump rail opts in, while the
        dashboard / v2 tree read only `letters` and skip the extra
        per-letter aggregate scan."""
        where, params = self._build_where(
            q=q, favorites_only=favorites_only, format_filter=format_filter,
            artist_filter=artist_filter, album_filter=album_filter,
            arrangements_has=arrangements_has, arrangements_lacks=arrangements_lacks,
            stems_has=stems_has, stems_lacks=stems_lacks,
            has_lyrics=has_lyrics, tunings=tunings, match_states=match_states,
            naming_mode=naming_mode, instrument=instrument,
            playable_from_pitch=playable_from_pitch,
            include_intrinsic=not group,
        )
        if group:
            # Same filter law as query_page (§7.1): chart-intrinsic predicates
            # match-if-ANY-member, applied identically here so the letter-bar
            # counts stay in lockstep with the grouped grid.
            self._ensure_work_display()
            ifrag, iparams = self._build_intrinsic_where(
                "m", format_filter=format_filter,
                arrangements_has=arrangements_has, arrangements_lacks=arrangements_lacks,
                stems_has=stems_has, stems_lacks=stems_lacks,
                has_lyrics=has_lyrics, tunings=tunings, naming_mode=naming_mode,
                instrument=instrument, playable_from_pitch=playable_from_pitch)
            mfrag, mparams = self._grouped_member_match(ifrag, iparams)
            where += mfrag
            params += mparams
            where += self._GROUP_REP_PREDICATE
        # Grouped stat counts filter through work_display (same
        # is_group_representative=1 predicate as query_page); hold self._lock
        # across these representative SELECTs so they can't observe a
        # mid-rebuild empty table (see query_page for the full rationale).
        # _ensure_work_display already rebuilt above under its own lock, so we
        # do NOT nest it here (self._lock is non-reentrant). Ungrouped reads
        # stay lock-free (WAL) via nullcontext.
        read_guard = self._lock if group else contextlib.nullcontext()
        with read_guard:
            total = self.conn.execute(f"SELECT COUNT(*) FROM songs {where}", params).fetchone()[0]
            # NOCASE collation here mirrors `query_artists` and the per-
            # letter `COUNT(DISTINCT artist COLLATE NOCASE)` below — without
            # it, an artist stored under two different casings would inflate
            # `total_artists` against the letter-bar breakdown the UI
            # renders next to it.
            artist_count = self.conn.execute(
                f"SELECT COUNT(DISTINCT artist COLLATE NOCASE) FROM songs {where}", params
            ).fetchone()[0]
            rows = self.conn.execute(
                f"SELECT UPPER(SUBSTR(artist, 1, 1)) as letter, COUNT(DISTINCT artist COLLATE NOCASE) "
                f"FROM songs {where} GROUP BY letter", params
            ).fetchall()
        letters = {}
        for letter, count in rows:
            count = int(count or 0)
            if count <= 0:
                continue
            key = str(letter or "")
            if key.isascii() and key.isalpha():
                letters[key] = letters.get(key, 0) + count
            else:
                letters["#"] = letters.get("#", 0) + count
        result = {"total_songs": total, "total_artists": artist_count, "letters": letters}
        # Active-sort letter buckets for the v3 jump rail. Counts SONGS (the
        # grid's unit, unlike `letters` which counts distinct artists) per
        # first-letter bucket of the column the active sort keys on, so a tap
        # on a present letter always finds a card. Non-A–Z first chars bucket
        # under '#'. Only artist/title sorts are alphabetical; anything else
        # keys on artist here but the client hides the rail for it. Computed
        # only when the caller opts in, so non-rail callers skip the scan.
        if want_sort_letters:
            sort_col = "title" if sort in ("title", "title-desc") else "artist"
            # Same representative-SELECT lock guard as the counts above.
            with read_guard:
                sort_rows = self.conn.execute(
                    f"SELECT UPPER(SUBSTR(COALESCE({sort_col}, ''), 1, 1)) AS letter, COUNT(*) "
                    f"FROM songs {where} GROUP BY letter", params
                ).fetchall()
            sort_letters: dict[str, int] = {}
            for letter, count in sort_rows:
                count = int(count or 0)
                if count <= 0:
                    continue
                key = str(letter or "")
                bucket = key if (key.isascii() and key.isalpha()) else "#"
                sort_letters[bucket] = sort_letters.get(bucket, 0) + count
            result["sort_letters"] = sort_letters
        return result
