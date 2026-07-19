"""loosefolder.py — treat a directory of raw RS2014 assets as a playable song.

Expected layout (artist/album/song_dir structure is optional but used for
metadata inference when manifest.json is absent):

    song_dir/
        audio.wem          (required)
        lead.xml           (at least one arrangement XML required)
        rhythm.xml
        bass.xml
        manifest.json      (optional)
        album_art.jpg / cover.jpg / album.png  (optional)

manifest.json fields (all optional — XML metadata fills in gaps):
    {
        "title":          "Song Name",
        "artist":         "Artist Name",
        "album":          "Album Name",
        "year":           "2024",
        "tuning_offsets": [0, 0, 0, 0, 0, 0]
    }
"""

import json
import math
import xml.etree.ElementTree as ET
from pathlib import Path

AUDIO_NAMES = ["audio.wem", "song.wem"]
# Match every extension server.get_song_art is prepared to serve
# (jpeg/png/webp). Without `.jpeg`/`.webp`, loose folders shipping
# `cover.jpeg` or `album_art.webp` would never have their art surfaced.
_ART_STEMS = ["album_art", "cover", "album", "art", "folder"]
_ART_EXTS  = [".jpg", ".jpeg", ".png", ".webp"]
ART_NAMES   = [f"{stem}{ext}" for stem in _ART_STEMS for ext in _ART_EXTS]

# Arrangement type detection from filename keywords or <arrangement> tag
# Format: keyword -> (type, display_name, sort_priority)
ARR_TYPE_MAP = {
    "lead":     ("lead",   "Lead",   0),
    "rhythm":   ("rhythm", "Rhythm", 2),
    "bass":     ("bass",   "Bass",   3),
    "combo":    ("combo",  "Combo",  1),
    "chord":    ("combo",  "Combo",  1),
    "humstrum": ("combo",  "Combo",  1),
}


def _iter_local(path: Path, pattern: str):
    """Yield regular files matching `pattern` in `path` that resolve
    inside `path`.

    Two guards in one helper:
      * Reject directories (a folder named `audio.wem` or `lead.xml`
        would otherwise be matched by glob and break downstream
        readers / converters).
      * Reject symlinks escaping the folder so a crafted custom song can't
        smuggle external content into the scan.
    """
    root = path.resolve()
    for match in path.glob(pattern):
        if not match.is_file():
            continue
        try:
            resolved = match.resolve()
            resolved.relative_to(root)
        except (OSError, ValueError):
            continue
        yield resolved


def _iter_local_xmls(path: Path):
    """Backwards-compatible wrapper for `_iter_local(path, '*.xml')`."""
    yield from _iter_local(path, "*.xml")


def is_loose_song(path: Path) -> bool:
    """True if this directory looks like a playable loose song folder.

    Requires both a non-preview WEM and at least one arrangement XML
    that isn't a vocals or showlights track — otherwise highway_ws would
    later fail when it tries to pick an arrangement from an empty list.

    Classification looks at the XML root element rather than the
    filename so a custom named `lead_vocals_fix.xml` (root `<song>`)
    still counts as a playable arrangement.
    """
    if not path.is_dir():
        return False
    # Require an actual file that resolves inside `path` — both
    # rejects directories named `audio.wem` and refuses symlinks
    # escaping the song folder.
    def _named_audio_ok(name: str) -> bool:
        p = path / name
        if not p.is_file():
            return False
        try:
            p.resolve().relative_to(path.resolve())
        except (OSError, ValueError):
            return False
        return True

    has_audio = (
        any(_named_audio_ok(a) for a in AUDIO_NAMES)
        or any("preview" not in f.stem.lower()
               for f in _iter_local(path, "*.wem"))
    )
    if not has_audio:
        return False
    for xml in _iter_local_xmls(path):
        try:
            root_tag = ET.parse(str(xml)).getroot().tag
        except Exception:
            continue
        if root_tag == "song":
            return True
    return False


def find_audio(path: Path) -> Path | None:
    """Return the path to the best audio file in the folder.
    Prefers known names, then falls back to any WEM that isn't a preview clip.
    Only returns regular files that resolve inside `path` — a directory,
    broken symlink, or symlink escaping the folder would otherwise be
    returned and either break convert_wem or read external content.
    """
    root = path.resolve()

    def _in_folder(p: Path) -> bool:
        try:
            p.resolve().relative_to(root)
        except (OSError, ValueError):
            return False
        return True

    # Check known names first
    for a in AUDIO_NAMES:
        cand = path / a
        if cand.is_file() and _in_folder(cand):
            return cand

    def _safe_size(f: Path) -> int:
        # Treat unreadable files (broken symlinks, permission errors)
        # as zero-byte so they sort last and never get picked.
        try:
            return f.stat().st_size
        except OSError:
            return 0

    candidates = sorted(
        [f for f in _iter_local(path, "*.wem")
         if "preview" not in f.stem.lower()],
        key=_safe_size,
        reverse=True,
    )
    return candidates[0] if candidates else None


def find_art(path: Path) -> Path | None:
    """Return the path to the first recognised album art file in the folder.

    Only matches regular files — a directory named `cover.jpg` would
    otherwise be returned and trip the FileResponse / containment
    checks downstream.
    """
    return next((path / a for a in ART_NAMES if (path / a).is_file()), None)


def _arr_type_from_filename(stem: str) -> tuple:
    """Infer arrangement type from filename keywords."""
    s = stem.lower()
    for key, val in ARR_TYPE_MAP.items():
        if key in s:
            return val
    return ("lead", "Lead", 0)  # fallback


def _parse_xml_meta(xml_path: Path) -> dict:
    """Parse a chart arrangement XML and return song-level metadata."""
    try:
        root = ET.parse(str(xml_path)).getroot()
        if root.tag != "song":
            return {}

        def txt(tag, default=""):
            el = root.find(tag)
            return el.text.strip() if el is not None and el.text else default

        # Tuning from attributes
        tuning_el = root.find("tuning")
        if tuning_el is not None:
            offsets = [int(tuning_el.get(f"string{i}", 0)) for i in range(6)]
        else:
            offsets = [0] * 6

        # Arrangement type — filename is more reliable than the XML tag
        # because some authoring tools write "Lead" for all arrangements.
        # We read the XML tag here and let _detect_arrangements decide
        # which source to trust.
        arr_tag = txt("arrangement", "").lower()
        arr_from_tag = ARR_TYPE_MAP.get(arr_tag, None)

        duration = 0.0
        try:
            duration = float(txt("songLength", "0"))
        except (ValueError, TypeError):
            pass

        return {
            "title":          txt("title"),
            "artist":         txt("artistName"),
            "album":          txt("albumName"),
            "year":           txt("albumYear", ""),
            "duration":       duration,
            "tuning_offsets": offsets,
            "arr_from_tag":   arr_from_tag,  # may be None
        }
    except Exception:
        return {}


def _detect_arrangements(path: Path) -> tuple[list[dict], dict]:
    """
    Parse all arrangement XMLs.
    Returns (arrangements_list, shared_meta).
    shared_meta contains title/artist/album/year/duration/tuning_offsets
    sourced from the highest-priority arrangement (lead > combo > rhythm >
    bass) — picking the guitar tuning when both bass and lead are present —
    plus `bass_tuning_offsets` from the first bass arrangement (None when the
    folder has none), so the index can carry both tunings.
    """
    arrangements = []
    # Track which arrangement priority sourced shared_meta so a later,
    # higher-priority arrangement (lead < bass in sort order) overrides.
    shared_meta = {}
    shared_priority = None
    # First tuning seen per arrangement ROLE, kept alongside the guitar-first
    # song tuning so the library can answer for the part a player plays.
    role_tunings: dict[str, list[int] | None] = {"bass": None, "rhythm": None}

    for xml in sorted(_iter_local_xmls(path)):
        # Trust the XML root over the filename — a custom named
        # `lead_vocals_fix.xml` is still a real arrangement.
        # `_parse_xml_meta` returns {} for any root other than <song>,
        # which is how vocals/showlights tracks get filtered out.
        stem = xml.stem.lower()

        meta = _parse_xml_meta(xml)
        if not meta:
            continue

        # Arrangement type: prefer filename keywords over the XML tag
        # because some tools write "Lead" for all arrangements regardless
        # of actual type. Only fall back to the XML tag when the filename
        # gives no useful signal (i.e. no recognisable keyword found).
        filename_type = _arr_type_from_filename(stem)
        if filename_type[0] != "lead" or "lead" in stem:
            # Filename gave a confident answer
            arr_type, arr_name, priority = filename_type
        else:
            # Filename wasn't specific — try the XML tag
            arr_from_tag = meta.get("arr_from_tag")
            if arr_from_tag:
                arr_type, arr_name, priority = arr_from_tag
            else:
                arr_type, arr_name, priority = filename_type

        # Take song-level fields from the highest-priority arrangement
        # (lowest `priority` number) so tuning reflects the main guitar
        # instead of whatever sorted first alphabetically.
        if meta.get("title") and (shared_priority is None or priority < shared_priority):
            shared_meta = {k: meta[k] for k in
                           ("title", "artist", "album", "year",
                            "duration", "tuning_offsets")}
            shared_priority = priority

        if (arr_type in role_tunings and role_tunings[arr_type] is None
                and meta.get("tuning_offsets")):
            role_tunings[arr_type] = list(meta["tuning_offsets"])

        arrangements.append({
            "type":     arr_type,
            "name":     arr_name,
            "file":     xml.name,
            "priority": priority,
        })

    arrangements.sort(key=lambda a: a["priority"])
    for i, a in enumerate(arrangements):
        a["index"] = i
        del a["priority"]

    for role, offs in role_tunings.items():
        shared_meta[f"{role}_tuning_offsets"] = offs
    return arrangements, shared_meta


def _has_lyrics(path: Path) -> bool:
    """Return True if any XML in the folder is a vocals track."""
    for xml in _iter_local_xmls(path):
        try:
            if ET.parse(str(xml)).getroot().tag == "vocals":
                return True
        except Exception:
            pass
    return False


def _coerce_duration(raw, fallback) -> float:
    """Coerce a manifest duration to a finite float, falling back on bad input.

    Rejects NaN / Infinity so a manifest like `{"duration": "Infinity"}`
    can't poison `meta_db` and then crash Starlette's JSON encoder when
    the row is served back through `/api/song/...`.
    """
    try:
        v = float(raw)
        if math.isfinite(v):
            return v
    except (TypeError, ValueError):
        pass
    try:
        v = float(fallback or 0.0)
        return v if math.isfinite(v) else 0.0
    except (TypeError, ValueError):
        return 0.0


def _coerce_text(raw) -> str | None:
    """Return raw if it's a non-empty string, else None.

    Manifest fields like `title` / `artist` / `album` can arrive as
    JSON nulls, lists, or numbers (e.g. someone setting album to a
    year by mistake). Returning None lets the caller fall back to
    XML / folder inference instead of crashing the DB row write.
    """
    if isinstance(raw, str) and raw:
        return raw
    return None


def _coerce_tuning_offsets(raw, fallback) -> list[int]:
    """Validate manifest tuning_offsets: must be a list of 6 numeric values."""
    if isinstance(raw, list) and len(raw) == 6:
        try:
            return [int(v) for v in raw]
        except (TypeError, ValueError):
            pass
    if isinstance(fallback, list) and len(fallback) == 6:
        return list(fallback)
    return [0] * 6


def _validate_manifest_arrangements(raw) -> list[dict] | None:
    """Return raw if it's a well-formed arrangement list, else None.

    Each entry must be a dict carrying at least `type`, `name`, `file`
    (string-typed). Bad shapes get dropped so the parsed XML list wins.
    """
    if not isinstance(raw, list) or not raw:
        return None
    out = []
    for entry in raw:
        if not isinstance(entry, dict):
            return None
        if not all(isinstance(entry.get(k), str) and entry.get(k)
                   for k in ("type", "name", "file")):
            return None
        out.append(entry)
    return out


def extract_meta(path: Path, dlc_root: Path | None = None) -> dict:
    """Return metadata dict for a loose song folder.

    Priority chain:
      1. manifest.json (explicit user-supplied data)
      2. XML metadata  (parsed from arrangement XMLs)
      3. Folder name   (last resort inference from directory structure)

    `dlc_root` is used to bound the folder-name inference: artist/album
    are only inferred from `path.relative_to(dlc_root)` components, so
    a loose folder placed at `<DLC>/song/` doesn't accidentally surface
    the user's home-directory name as the artist.
    """
    # 1. Try manifest.json
    manifest_path = path / "manifest.json"
    manifest = {}
    if manifest_path.exists():
        try:
            manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        except Exception:
            pass
    if not isinstance(manifest, dict):
        manifest = {}

    # 2. Parse XMLs for song metadata + arrangements
    arrangements, xml_meta = _detect_arrangements(path)

    # 3. Folder inference — only from path components under DLC_DIR so
    # absolute-path parts (`/home/<user>/...`) can never leak as artist.
    rel_parts: tuple[str, ...] = ()
    if dlc_root is not None:
        try:
            rel_parts = path.resolve().relative_to(dlc_root.resolve()).parts
        except (ValueError, OSError):
            rel_parts = ()

    # Coerce manifest text fields — non-strings (lists, numbers, null)
    # would otherwise propagate into meta_db rows and break DB writes.
    title  = _coerce_text(manifest.get("title"))  or xml_meta.get("title")  or path.name
    artist = (_coerce_text(manifest.get("artist")) or xml_meta.get("artist")
              or (rel_parts[-3] if len(rel_parts) >= 3 else ""))
    album  = (_coerce_text(manifest.get("album")) or xml_meta.get("album")
              or (rel_parts[-2] if len(rel_parts) >= 2 else ""))
    raw_year = manifest.get("year")
    if isinstance(raw_year, (int, float)) and not isinstance(raw_year, bool):
        manifest_year = str(int(raw_year))
    else:
        manifest_year = _coerce_text(raw_year) or ""
    year   = manifest_year or str(xml_meta.get("year", ""))
    duration = _coerce_duration(manifest.get("duration"),
                                xml_meta.get("duration", 0))
    tuning_offsets = _coerce_tuning_offsets(manifest.get("tuning_offsets"),
                                            xml_meta.get("tuning_offsets"))
    # Per-role tunings: XML-derived only. A manifest `tuning_offsets` overrides
    # the SONG tuning (above) but says nothing about WHICH chart it describes,
    # so it must never be mistaken for a specific part's tuning.
    role_tunings = {}
    for role in ("bass", "rhythm"):
        offs = xml_meta.get(f"{role}_tuning_offsets")
        role_tunings[f"{role}_tuning_offsets"] = (
            offs if isinstance(offs, list) and offs else None)

    manifest_arr = _validate_manifest_arrangements(manifest.get("arrangements"))
    if manifest_arr is not None:
        arrangements = manifest_arr

    audio = find_audio(path)
    art   = find_art(path)

    return {
        "title":          title,
        "artist":         artist,
        "album":          album,
        "year":           year,
        "duration":       duration,
        "tuning_offsets": tuning_offsets,
        **role_tunings,   # None = no arrangement in that role
        "arrangements":   arrangements,
        "audio_path":     str(audio) if audio else None,
        "art_path":       str(art)   if art   else None,
        "has_lyrics":     _has_lyrics(path),
    }
