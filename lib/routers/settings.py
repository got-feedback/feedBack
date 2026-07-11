"""Settings routes: GET/POST /api/settings, /api/settings/reset, and the
two-phase atomic export/import bundle (/api/settings/export|import).

Extracted verbatim from server.py (R3) except @app->@router and the seam reads:
meta_db->appstate.meta_db, CONFIG_DIR->appstate.config_dir, _default_settings->
appstate.default_settings (it stays in server.py, shared with the scan/
artist-links code), and _running_version->appstate.running_version().
"""

import json
import math
import os
import sqlite3
import tempfile
import threading
from pathlib import Path

from fastapi import APIRouter
from fastapi.responses import JSONResponse

import appstate
import sloppak as sloppak_mod
from appconfig import _load_config
from metadata_db import _as_int, _sqlite_file_integrity_ok
from tunings import (
    PROFILE_IDS, PROFILE_PATHWAYS, apply_flat_instrument_patch_to_profiles,
    normalize_instrument_profile, normalize_instrument_profiles,
    settings_with_instrument_profiles,
)

import logging
log = logging.getLogger("feedBack.server")
router = APIRouter()

# Serializes the read-modify-write in save_settings(). See the note there.
_settings_lock = threading.Lock()


@router.get("/api/settings")
def get_settings():
    cfg = _load_config(appstate.config_dir / "config.json")
    return settings_with_instrument_profiles(cfg if cfg is not None else appstate.default_settings())


@router.post("/api/settings")
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
    config_file = appstate.config_dir / "config.json"
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
    appstate.config_dir.mkdir(parents=True, exist_ok=True)
    # Critical section — the read-merge-write must be atomic. FastAPI runs
    # sync handlers in a threadpool, so two concurrent partial POSTs (e.g.
    # the two Settings dropdowns auto-saving back-to-back) could each read
    # the pre-write file and the second write would silently drop the
    # first's key. /api/settings/import shares _settings_lock for the same
    # reason. The seed-from-appstate.default_settings() guards a missing/unreadable
    # /non-dict config.json so the merge can't TypeError and 500 the
    # endpoint. The write is atomic temp+rename so a concurrent reader
    # (export, get_settings, the _get_dlc_dir fallback) never sees a torn
    # file.
    with _settings_lock:
        cfg = _load_config(config_file)
        if cfg is None:
            cfg = appstate.default_settings()
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
# from config.json so the next GET falls back to the appstate.default_settings() value
# (or the frontend's own default when the key is then absent). Restricting to a
# known set means a malformed or hostile body can't wipe unrelated config.
_RESETTABLE_SETTINGS_KEYS = frozenset({
    "default_arrangement", "demucs_server_url", "master_difficulty",
    "av_offset_ms", "countdown_before_song", "miss_penalty", "fail_behavior",
    "reference_pitch", "instrument", "string_count", "tuning", "pathway",
    "instrument_profiles", "active_instrument_profile",
    "achievements_enabled", "use_amp_sims",
})


@router.post("/api/settings/reset")
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
    config_file = appstate.config_dir / "config.json"
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


# Bumped only when the bundle JSON shape changes incompatibly. Importer
# refuses anything but this exact value — version mismatches are warned
# but not blocked, schema mismatches ARE blocked.
SETTINGS_BUNDLE_SCHEMA = 1


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
    fd, tmp = tempfile.mkstemp(dir=str(appstate.config_dir), prefix="._dbsnap.", suffix=".db")
    os.close(fd)
    try:
        dst = sqlite3.connect(tmp)
        try:
            with appstate.meta_db._lock:
                appstate.meta_db.conn.backup(dst)
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
    fd, tmp = tempfile.mkstemp(dir=str(appstate.config_dir), prefix="._dbcheck.", suffix=".db")
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
    out: dict[str, dict] = dict(_walk_export_paths(list(_CORE_EXPORT_ART_DIRS), appstate.config_dir))
    out[_CORE_LIBRARY_DB] = snap
    return out


@router.get("/api/settings/export")
def export_settings():
    """Build a settings bundle covering server config + opted-in plugin
    server-side files. Frontend layers in `local_storage` before
    triggering the download. See feedBack#113."""
    import datetime
    from plugins import LOADED_PLUGINS, PLUGINS_LOCK

    config_file = appstate.config_dir / "config.json"
    server_config = _load_config(config_file)
    if server_config is None:
        server_config = appstate.default_settings()
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
        plugin_blocks[p["id"]] = {"files": _walk_export_paths(allowed, appstate.config_dir)}

    # Capture the timestamp once so the bundle's `exported_at` and the
    # download filename's date prefix can't disagree if the request
    # crosses midnight UTC between the two formats.
    now = datetime.datetime.now(datetime.timezone.utc)
    bundle = {
        "schema": SETTINGS_BUNDLE_SCHEMA,
        "exported_at": now.strftime("%Y-%m-%dT%H:%M:%SZ"),
        "feedBack_version": appstate.running_version(),
        "server_config": server_config,
        "plugin_server_configs": plugin_blocks,
        "core_server_files": core_files,
    }
    filename = f"feedBack-settings-{now.strftime('%Y-%m-%d')}.json"
    return JSONResponse(
        bundle,
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


@router.post("/api/settings/import")
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
    running = appstate.running_version()
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
                target = _validate_relpath(relpath, allowed, appstate.config_dir)
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
            target = appstate.config_dir / (_CORE_LIBRARY_DB + ".restore")
            db_restore_staged = True
        else:
            try:
                target = _validate_relpath(relpath, list(_CORE_IMPORT_ALLOWED), appstate.config_dir)
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
        appstate.config_dir.mkdir(parents=True, exist_ok=True)
        # Share _settings_lock with save_settings() so a full-replace
        # import and a concurrent partial-update POST can't interleave
        # on config.json and drop each other's write.
        with _settings_lock:
            _atomic_write_file(
                appstate.config_dir / "config.json",
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
                (appstate.config_dir / (_CORE_LIBRARY_DB + ".restore")).unlink()
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
