"""Tuning data and helpers.

Kept separate from server.py so tests can import it without triggering
FastAPI / SQLite module-level side effects.
"""

from __future__ import annotations

import math

DEFAULT_REFERENCE_PITCH = 440.0

_instrument_registry = None


def set_instrument_registry(reg):
    global _instrument_registry
    _instrument_registry = reg


def _build_standard_midis(registry=None):
    reg = registry or _instrument_registry
    result = {}
    if reg:
        for inst in reg.get_all():
            if inst["kind"] == "stringed":
                for sc_key, midis in inst.get("standard_tunings", {}).items():
                    key = f"{inst['id']}-{sc_key}"
                    if key not in result:
                        result[key] = midis
    if not result:
        return dict(STANDARD_OPEN_MIDIS)
    return result


def _build_preset_midis(registry=None):
    reg = registry or _instrument_registry
    result = {}
    if reg:
        for inst in reg.get_all():
            if inst["kind"] == "stringed":
                std = inst.get("standard_tunings", {})
                for sc_key, named_offsets in inst.get("tunings", {}).items():
                    key = f"{inst['id']}-{sc_key}"
                    std_midis = std.get(sc_key)
                    if not std_midis:
                        continue
                    presets = {}
                    for t_name, offsets in named_offsets.items():
                        if len(std_midis) == len(offsets):
                            presets[t_name] = [s + o for s, o in zip(std_midis, offsets)]
                    if presets:
                        result[key] = presets
    if not result:
        return {k: dict(v) for k, v in TUNING_PRESET_MIDIS.items()}
    return result


def _build_profile_defaults(registry=None):
    reg = registry or _instrument_registry
    result = {}
    if reg:
        for inst in reg.get_all():
            default_role = inst["roles"][0]["id"] if inst["roles"] else inst["id"]
            for role in inst["roles"]:
                r_default = role.get("default", False)
                if r_default:
                    default_role = role["id"]
                profile_id = f"{inst['id']}-{role['id']}"
                result[profile_id] = {
                    "id": profile_id,
                    "label": f"{role['label']} {inst['label']}",
                    "instrument": inst["id"],
                    "role": role["id"],
                    "string_count": inst.get("default_string_count", 0),
                    "tuning": "E Standard",
                    "reference_pitch": inst.get("reference_pitch", DEFAULT_REFERENCE_PITCH),
                    "pathway": "songs",
                    "default_role": r_default,
                }
            if default_role and f"{inst['id']}-{default_role}" in result:
                for pid, profile in result.items():
                    if pid == f"{inst['id']}-{default_role}":
                        profile["default_role"] = True
    if not result:
        return {pid: dict(p) for pid, p in PROFILE_DEFAULTS.items()}
    return result


def _build_profile_ids(registry=None):
    profiles = _build_profile_defaults(registry)
    return tuple(profiles.keys())


def _valid_instrument_ids(registry=None):
    reg = registry or _instrument_registry
    if reg:
        ids = {inst["id"] for inst in reg.get_all()}
        if ids:
            return ids
    return {"guitar", "bass"}


def _default_profile_id_for_instrument(instrument_id, registry=None):
    profiles = _build_profile_defaults(registry)
    for pid, profile in profiles.items():
        if profile["instrument"] == instrument_id and profile.get("default_role"):
            return pid
    for pid, profile in profiles.items():
        if profile["instrument"] == instrument_id:
            return pid
    return "guitar-lead"

# Canonical open strings, low to high, as MIDI notes. This is the host-level
# source of truth for guitar/bass tuning profiles; UI surfaces derive names,
# frequencies, and semitone offsets from these absolute pitches.
STANDARD_OPEN_MIDIS: dict[str, list[int]] = {
    "guitar-6": [40, 45, 50, 55, 59, 64],
    "guitar-7": [35, 40, 45, 50, 55, 59, 64],
    "guitar-8": [30, 35, 40, 45, 50, 55, 59, 64],
    "bass-4": [28, 33, 38, 43],
    "bass-5": [23, 28, 33, 38, 43],
    "bass-6": [23, 28, 33, 38, 43, 48],
}

# Curated built-in profiles. This intentionally starts by absorbing the useful
# Virtuoso guitar/bass coverage into host-owned data so the host selector,
# tuner, practice tools, and plugins can converge on one profile model.
TUNING_PRESET_MIDIS: dict[str, dict[str, list[int]]] = {
    "guitar-6": {
        "Standard": [40, 45, 50, 55, 59, 64],
        "Eb Standard": [39, 44, 49, 54, 58, 63],
        "D Standard": [38, 43, 48, 53, 57, 62],
        "C# Standard": [37, 42, 47, 52, 56, 61],
        "C Standard": [36, 41, 46, 51, 55, 60],
        "Drop D": [38, 45, 50, 55, 59, 64],
        "Drop C": [36, 43, 48, 53, 57, 62],
        "Drop B": [35, 42, 47, 52, 56, 61],
        "Drop A": [33, 40, 45, 50, 54, 59],
        "Drop Ab": [32, 39, 44, 49, 53, 58],
        "Open G": [38, 43, 50, 55, 59, 62],
        "Open D": [38, 45, 50, 54, 57, 62],
        "DADGAD": [38, 45, 50, 55, 57, 62],
        "Open E": [40, 47, 52, 56, 59, 64],
    },
    "guitar-7": {
        "Standard": [35, 40, 45, 50, 55, 59, 64],
        "Bb Standard": [34, 39, 44, 49, 54, 58, 63],
        "A Standard": [33, 38, 43, 48, 53, 57, 62],
        "G Standard": [31, 36, 41, 46, 51, 55, 60],
        "Drop A": [33, 40, 45, 50, 55, 59, 64],
        "Drop G": [31, 38, 43, 48, 53, 57, 62],
        "Drop F#": [30, 37, 42, 47, 52, 56, 61],
    },
    "guitar-8": {
        "Standard": [30, 35, 40, 45, 50, 55, 59, 64],
        "Drop E": [28, 35, 40, 45, 50, 55, 59, 64],
        "Drop A + Drop E": [28, 33, 40, 45, 50, 55, 59, 64],
        "E Standard": [28, 33, 38, 43, 48, 53, 57, 62],
        "Eb Standard": [27, 32, 37, 42, 47, 52, 56, 61],
        "Drop D": [26, 33, 38, 43, 48, 53, 57, 62],
    },
    "bass-4": {
        "Standard": [28, 33, 38, 43],
        "Eb Standard": [27, 32, 37, 42],
        "D Standard": [26, 31, 36, 41],
        "C# Standard": [25, 30, 35, 40],
        "C Standard": [24, 29, 34, 39],
        "Drop D": [26, 33, 38, 43],
        "Drop C": [24, 31, 36, 41],
        "BEAD": [23, 28, 33, 38],
    },
    "bass-5": {
        "Standard": [23, 28, 33, 38, 43],
        "High C": [28, 33, 38, 43, 48],
        "Eb Standard": [22, 27, 32, 37, 42],
        "D Standard": [21, 26, 31, 36, 41],
        "C# Standard": [20, 25, 30, 35, 40],
        "C Standard": [19, 24, 29, 34, 39],
        "Drop A": [21, 28, 33, 38, 43],
    },
    "bass-6": {
        "Standard": [23, 28, 33, 38, 43, 48],
        "Eb Standard": [22, 27, 32, 37, 42, 47],
        "D Standard": [21, 26, 31, 36, 41, 46],
        "C# Standard": [20, 25, 30, 35, 40, 45],
        "C Standard": [19, 24, 29, 34, 39, 44],
    },
}


def midi_to_freq(midi: int, reference_pitch: float = DEFAULT_REFERENCE_PITCH) -> float:
    """Return the frequency for a MIDI note at the supplied A4 reference."""
    return reference_pitch * math.pow(2, (midi - 69) / 12)


def open_midis_to_freqs(midis: list[int], reference_pitch: float = DEFAULT_REFERENCE_PITCH) -> list[float]:
    """Return rounded frequencies for low-to-high MIDI open strings."""
    return [round(midi_to_freq(m, reference_pitch), 2) for m in midis]


def freqs_to_midis(freqs: list[float], reference_pitch: float = DEFAULT_REFERENCE_PITCH) -> list[int] | None:
    """Return absolute open-string MIDI notes for frequencies at the supplied
    A4 reference — the inverse of open_midis_to_freqs. None if any entry is
    non-numeric, non-finite, or non-positive (a provider could hand us
    anything; NaN/Infinity would otherwise raise inside int(round(...)) and
    500 the /api/tunings endpoint)."""
    out: list[int] = []
    for f in freqs:
        try:
            f = float(f)
        except (TypeError, ValueError):
            return None
        if not math.isfinite(f) or f <= 0:
            return None
        out.append(int(round(69 + 12 * math.log2(f / reference_pitch))))
    return out


def tuning_offsets_from_midis(instrument_key: str, midis: list[int]) -> list[int] | None:
    """Return semitone offsets from the instrument's standard open strings."""
    standard = STANDARD_OPEN_MIDIS.get(instrument_key)
    if not standard or len(standard) != len(midis):
        return None
    return [int(m - s) for m, s in zip(midis, standard)]


def tuning_midis_from_offsets(instrument_key: str, offsets: list[int]) -> list[int] | None:
    """Return absolute open-string MIDI notes for host semitone offsets."""
    standard = STANDARD_OPEN_MIDIS.get(instrument_key)
    if not standard or len(standard) != len(offsets):
        return None
    return [int(s + o) for s, o in zip(standard, offsets)]


def tuning_preset_offsets(instrument_key: str, name: str) -> list[int] | None:
    """Return host semitone offsets for a named preset."""
    midis = TUNING_PRESET_MIDIS.get(instrument_key, {}).get(name)
    if not midis:
        return None
    return tuning_offsets_from_midis(instrument_key, midis)


# Canonical tuning frequencies at 440 Hz reference, keyed by instrument then
# tuning name. Kept for the existing /api/tunings contract.
DEFAULT_TUNINGS: dict[str, dict[str, list[float]]] = {
    instrument: {
        name: open_midis_to_freqs(midis)
        for name, midis in presets.items()
    }
    for instrument, presets in TUNING_PRESET_MIDIS.items()
}


def apply_reference_pitch(
    tunings: dict[str, dict[str, list[float]]],
    reference_pitch: float,
) -> dict[str, dict[str, list[float]]]:
    """Return a copy of tunings with all frequencies scaled to reference_pitch."""
    scale = reference_pitch / DEFAULT_REFERENCE_PITCH
    return {
        instrument: {
            name: [round(f * scale, 4) for f in freqs]
            for name, freqs in names.items()
        }
        for instrument, names in tunings.items()
    }


PROFILE_IDS = ("guitar-lead", "guitar-rhythm", "bass")
PROFILE_PATHWAYS = ("songs", "practice", "learn", "studio")
DEFAULT_ACTIVE_INSTRUMENT_PROFILE = "guitar-lead"
PROFILE_DEFAULTS: dict[str, dict] = {
    "guitar-lead": {
        "id": "guitar-lead",
        "label": "Lead Guitar",
        "instrument": "guitar",
        "role": "lead",
        "string_count": 6,
        "tuning": "E Standard",
        "reference_pitch": DEFAULT_REFERENCE_PITCH,
        "pathway": "songs",
    },
    "guitar-rhythm": {
        "id": "guitar-rhythm",
        "label": "Rhythm Guitar",
        "instrument": "guitar",
        "role": "rhythm",
        "string_count": 6,
        "tuning": "E Standard",
        "reference_pitch": DEFAULT_REFERENCE_PITCH,
        "pathway": "songs",
    },
    "bass": {
        "id": "bass",
        "label": "Bass",
        "instrument": "bass",
        "role": "bass",
        "string_count": 4,
        "tuning": "E Standard",
        "reference_pitch": DEFAULT_REFERENCE_PITCH,
        "pathway": "songs",
    },
}


def instrument_key(instrument: str, string_count: int) -> str:
    return f"{instrument}-{string_count}"


def default_instrument_profiles(registry=None) -> dict[str, dict]:
    return _build_profile_defaults(registry)


def _valid_reference_pitch(value) -> float | None:
    if isinstance(value, bool):
        return None
    try:
        ref = float(value)
    except (TypeError, ValueError, OverflowError):
        return None
    if not math.isfinite(ref) or ref < 430.0 or ref > 450.0:
        return None
    return ref


def _valid_tuning_for_key(key: str, tuning, *, registry=None):
    preset_midis = _build_preset_midis(registry)
    standard_midis = _build_standard_midis(registry)
    if isinstance(tuning, str):
        if len(tuning) > 64:
            return None
        if tuning in preset_midis.get(key, {}):
            return tuning
        # Accept any named tuning not in our presets as a provider/custom
        # tuning — the registry (and tuning providers) own validity now.
        # Previously we rejected names that existed in a different key as
        # misapplied built-ins, but with instruments-as-plugins the same
        # name (e.g. "E Standard") can legitimately exist for different
        # instrument keys (guitar-6 vs guitar-8).
        return tuning
    if isinstance(tuning, list):
        expected = len(standard_midis.get(key, []))
        if len(tuning) != expected:
            return None
        if any(isinstance(o, bool) or not isinstance(o, int) or o < -12 or o > 12 for o in tuning):
            return None
        return list(tuning)
    return None


def normalize_instrument_profile(profile_id: str, raw, *, registry=None) -> tuple[dict | None, str | None]:
    """Validate one persisted host instrument profile."""
    profile_defaults = _build_profile_defaults(registry)
    base = dict(profile_defaults.get(profile_id, {}))
    if not base:
        return None, f"unknown instrument profile: {profile_id}"
    if raw is None:
        return base, None
    if not isinstance(raw, dict):
        return None, f"instrument_profiles.{profile_id} must be an object"

    instrument = raw.get("instrument", base["instrument"])
    valid_ids = _valid_instrument_ids(registry)
    if instrument not in valid_ids:
        return None, f"instrument_profiles.{profile_id}.instrument must be one of {sorted(valid_ids)}"

    inst_def = None
    reg = registry or _instrument_registry
    if reg:
        inst_def = reg.get(instrument)
    is_stringed = (inst_def is not None and inst_def.get("kind") == "stringed") or instrument in ("guitar", "bass")

    if is_stringed:
        try:
            string_count = int(raw.get("string_count", base["string_count"]))
        except (TypeError, ValueError, OverflowError):
            return None, f"instrument_profiles.{profile_id}.string_count must be valid for the instrument"
        key = instrument_key(instrument, string_count)
        standard_midis = _build_standard_midis(registry)
        if key not in standard_midis:
            return None, f"instrument_profiles.{profile_id}.string_count must be valid for the instrument"
        tuning = _valid_tuning_for_key(key, raw.get("tuning", base["tuning"]), registry=registry)
        if tuning is None:
            return None, f"instrument_profiles.{profile_id}.tuning must match {key}"
    else:
        string_count = 0
        tuning = ""

    ref = _valid_reference_pitch(raw.get("reference_pitch", base["reference_pitch"]))
    if ref is None:
        return None, f"instrument_profiles.{profile_id}.reference_pitch must be a number between 430 and 450"

    label = raw.get("label", base["label"])
    if not isinstance(label, str) or len(label) > 64:
        return None, f"instrument_profiles.{profile_id}.label must be a short string"
    role = raw.get("role", base["role"])
    if not isinstance(role, str) or len(role) > 32:
        return None, f"instrument_profiles.{profile_id}.role must be a short string"
    pathway = raw.get("pathway", base["pathway"])
    if not isinstance(pathway, str) or pathway not in PROFILE_PATHWAYS:
        return None, f"instrument_profiles.{profile_id}.pathway must be one of songs, practice, learn, studio"

    out = dict(base)
    out.update({
        "id": profile_id,
        "label": label,
        "instrument": instrument,
        "role": role,
        "string_count": string_count,
        "tuning": tuning,
        "reference_pitch": ref,
        "pathway": pathway,
    })
    return out, None


def normalize_instrument_profiles(raw_profiles=None, *, registry=None) -> tuple[dict[str, dict] | None, str | None]:
    """Validate persisted host profiles, filling omitted built-ins with defaults."""
    if raw_profiles is None:
        return _build_profile_defaults(registry), None
    if not isinstance(raw_profiles, dict):
        return None, "instrument_profiles must be an object"
    profile_ids = _build_profile_ids(registry)
    profiles = {}
    for profile_id in profile_ids:
        profile, error = normalize_instrument_profile(profile_id, raw_profiles.get(profile_id), registry=registry)
        if error:
            return None, error
        profiles[profile_id] = profile
    return profiles, None


def active_profile_id(raw, *, registry=None) -> str:
    defaults = _build_profile_defaults(registry)
    return raw if raw in defaults else "guitar-lead"


def profile_from_legacy_settings(cfg: dict, *, registry=None) -> dict:
    """Build an active profile from the old flat settings keys."""
    valid_ids = _valid_instrument_ids(registry)
    instrument = cfg.get("instrument") if cfg.get("instrument") in valid_ids else "guitar"
    inst_def = None
    if registry:
        inst_def = registry.get(instrument)
    is_stringed = (inst_def is not None and inst_def.get("kind") == "stringed") or instrument in ("guitar", "bass")

    if is_stringed:
        if inst_def:
            fallback_sc = inst_def.get("default_string_count", 6)
        else:
            fallback_sc = 4 if instrument == "bass" else 6
        try:
            sc = int(cfg.get("string_count", fallback_sc))
        except (TypeError, ValueError, OverflowError):
            sc = fallback_sc
        key = instrument_key(instrument, sc)
        standard_midis = _build_standard_midis(registry)
        if key not in standard_midis:
            sc = fallback_sc
            key = instrument_key(instrument, sc)
        tuning = _valid_tuning_for_key(key, cfg.get("tuning", "E Standard"), registry=registry) or "E Standard"
    else:
        sc = 0
        tuning = ""
    ref = _valid_reference_pitch(cfg.get("reference_pitch", DEFAULT_REFERENCE_PITCH)) or DEFAULT_REFERENCE_PITCH
    pathway = cfg.get("pathway") if cfg.get("pathway") in PROFILE_PATHWAYS else "songs"
    profile_id = _default_profile_id_for_instrument(instrument, registry)
    profile = dict(_build_profile_defaults(registry)[profile_id])
    profile.update({
        "instrument": instrument,
        "string_count": sc,
        "tuning": tuning,
        "reference_pitch": ref,
        "pathway": pathway,
    })
    return profile


def settings_with_instrument_profiles(cfg: dict, *, registry=None) -> dict:
    """Return settings with canonical host profiles and mirrored flat keys."""
    reg = registry or _instrument_registry
    out = dict(cfg)
    profiles, _error = normalize_instrument_profiles(out.get("instrument_profiles"), registry=reg)
    if profiles is None:
        profiles = _build_profile_defaults(reg)
    if "instrument_profiles" not in out:
        legacy = profile_from_legacy_settings(out, registry=reg)
        profiles[legacy["id"]] = legacy
        # Default the active profile to the one migrated from the legacy flat
        # fields, but DON'T clobber an explicit request — a fresh-config
        # `POST {"active_instrument_profile": "bass"}` must switch, not be
        # overwritten by the guitar-lead inferred from defaults. active_profile_id
        # below normalizes an invalid value.
        out.setdefault("active_instrument_profile", legacy["id"])
    active = active_profile_id(out.get("active_instrument_profile"), registry=reg)
    selected = profiles[active]
    out["instrument_profiles"] = profiles
    out["active_instrument_profile"] = active
    out["instrument"] = selected["instrument"]
    out["string_count"] = selected["string_count"]
    out["tuning"] = selected["tuning"]
    out["reference_pitch"] = selected["reference_pitch"]
    out["pathway"] = selected["pathway"]
    return out


def apply_flat_instrument_patch_to_profiles(cfg: dict, updates: dict, *, registry=None) -> dict:
    """Mirror legacy flat instrument updates into the active host profile."""
    reg = registry or _instrument_registry
    out = settings_with_instrument_profiles(cfg, registry=reg)
    if not any(k in updates for k in ("instrument", "string_count", "tuning", "reference_pitch", "pathway")):
        return out
    active = active_profile_id(out.get("active_instrument_profile"), registry=reg)
    if "instrument" in updates:
        active = _default_profile_id_for_instrument(updates["instrument"], reg)
        out["active_instrument_profile"] = active
    current = dict(out["instrument_profiles"][active])

    if "instrument" in updates:
        current["instrument"] = updates["instrument"]
        if "string_count" not in updates:
            inst_def = reg.get(updates["instrument"]) if reg else None
            if inst_def:
                current["string_count"] = inst_def.get("default_string_count", 0)
            else:
                current["string_count"] = 4 if updates["instrument"] == "bass" else 6
    if "string_count" in updates:
        current["string_count"] = updates["string_count"]
    if "reference_pitch" in updates:
        current["reference_pitch"] = updates["reference_pitch"]
    if "pathway" in updates:
        current["pathway"] = updates["pathway"]
    if "tuning" in updates:
        current["tuning"] = updates["tuning"]
    else:
        inst_def = reg.get(current["instrument"]) if reg else None
        is_str = (inst_def is not None and inst_def.get("kind") == "stringed") or current["instrument"] in ("guitar", "bass")
        if is_str:
            key = instrument_key(current["instrument"], current["string_count"])
            if _valid_tuning_for_key(key, current.get("tuning"), registry=reg) is None:
                current["tuning"] = "E Standard"

    profile, error = normalize_instrument_profile(active, current, registry=reg)
    if error:
        raise ValueError(error)
    out["instrument_profiles"][active] = profile
    out.update({
        "instrument": profile["instrument"],
        "string_count": profile["string_count"],
        "tuning": profile["tuning"],
        "reference_pitch": profile["reference_pitch"],
        "pathway": profile["pathway"],
    })
    return out

def tuning_name(offsets: list[int]) -> str:
    # All three pattern checks below are gated on `len(offsets) == 6`. The
    # naming conventions here are 6-string-specific — e.g. a 7-string all-zeros
    # tuning has a low B, not an E, so labeling it "E Standard" would be wrong.
    # 7+-string community content falls through to the numeric fallback. See #43.

    # Standard tunings (all six strings same offset)
    standard = {
        0: "E Standard", -1: "Eb Standard", -2: "D Standard",
        -3: "C# Standard", -4: "C Standard", -5: "B Standard",
        -6: "Bb Standard", -7: "A Standard",
        1: "F Standard", 2: "F# Standard",
    }
    if len(offsets) == 6 and all(o == offsets[0] for o in offsets):
        name = standard.get(offsets[0])
        if name:
            return name

    # Drop tunings (low string 2 semitones below the rest)
    # Named after the low string's note: e.g. offsets[-2,0,0,0,0,0] = Drop D (low E dropped to D)
    if len(offsets) == 6 and offsets[0] == offsets[1] - 2 and all(o == offsets[1] for o in offsets[1:]):
        note_names = ["E", "F", "F#", "G", "Ab", "A", "Bb", "B", "C", "C#", "D", "Eb"]
        low_note = note_names[offsets[0] % 12]
        return f"Drop {low_note}"

    # Common named tunings
    named = {
        (-2, 0, 0, 0, 0, 0): "Drop D",
        (-4, -2, -2, -2, -2, -2): "Drop C",
        (-2, -2, 0, 0, 0, 0): "Double Drop D",
        (0, 0, 0, -1, 0, 0): "Open G",
        (-2, -2, 0, 0, -2, -2): "Open D",
        (-2, 0, 0, 0, -2, 0): "DADGAD",
        (0, 2, 2, 1, 0, 0): "Open E",
        (-2, 0, 0, 2, 3, 2): "Open D (alt)",
    }
    if len(offsets) == 6 and tuple(offsets) in named:
        return named[tuple(offsets)]

    if not offsets:
        return "Unknown"
    return "Custom Tuning"
