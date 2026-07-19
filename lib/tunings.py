"""Tuning data and helpers.

Kept separate from server.py so tests can import it without triggering
FastAPI / SQLite module-level side effects.
"""

from __future__ import annotations

import math

DEFAULT_REFERENCE_PITCH = 440.0

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
        "tuning": "Standard",
        "reference_pitch": DEFAULT_REFERENCE_PITCH,
        "pathway": "songs",
    },
    "guitar-rhythm": {
        "id": "guitar-rhythm",
        "label": "Rhythm Guitar",
        "instrument": "guitar",
        "role": "rhythm",
        "string_count": 6,
        "tuning": "Standard",
        "reference_pitch": DEFAULT_REFERENCE_PITCH,
        "pathway": "songs",
    },
    "bass": {
        "id": "bass",
        "label": "Bass",
        "instrument": "bass",
        "role": "bass",
        "string_count": 4,
        "tuning": "Standard",
        "reference_pitch": DEFAULT_REFERENCE_PITCH,
        "pathway": "songs",
    },
}


def instrument_key(instrument: str, string_count: int) -> str:
    return f"{instrument}-{string_count}"


def default_instrument_profiles() -> dict[str, dict]:
    return {profile_id: dict(profile) for profile_id, profile in PROFILE_DEFAULTS.items()}


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


def _valid_tuning_for_key(key: str, tuning):
    if isinstance(tuning, str):
        if len(tuning) > 64:
            return None
        if tuning in TUNING_PRESET_MIDIS.get(key, {}):
            return tuning
        # A name that IS a built-in preset for a different key is a misapplied
        # built-in (e.g. "Drop D" on a 5-string bass, whose low string is B) —
        # reject it. A name unknown to every built-in table is a provider/custom
        # tuning (the tuner plugin's, exposed via /api/tunings) that this pure
        # layer can't resolve — accept it so settings round-trip; the provider
        # owns its validity.
        if any(tuning in names for names in TUNING_PRESET_MIDIS.values()):
            return None
        return tuning
    if isinstance(tuning, list):
        expected = len(STANDARD_OPEN_MIDIS.get(key, []))
        if len(tuning) != expected:
            return None
        if any(isinstance(o, bool) or not isinstance(o, int) or o < -12 or o > 12 for o in tuning):
            return None
        return list(tuning)
    return None


def normalize_instrument_profile(profile_id: str, raw) -> tuple[dict | None, str | None]:
    """Validate one persisted host instrument profile."""
    base = dict(PROFILE_DEFAULTS.get(profile_id, {}))
    if not base:
        return None, f"unknown instrument profile: {profile_id}"
    if raw is None:
        return base, None
    if not isinstance(raw, dict):
        return None, f"instrument_profiles.{profile_id} must be an object"

    instrument = raw.get("instrument", base["instrument"])
    if instrument not in ("guitar", "bass"):
        return None, f"instrument_profiles.{profile_id}.instrument must be 'guitar' or 'bass'"

    try:
        string_count = int(raw.get("string_count", base["string_count"]))
    except (TypeError, ValueError, OverflowError):
        return None, f"instrument_profiles.{profile_id}.string_count must be valid for the instrument"
    key = instrument_key(instrument, string_count)
    if key not in STANDARD_OPEN_MIDIS:
        return None, f"instrument_profiles.{profile_id}.string_count must be valid for the instrument"

    tuning = _valid_tuning_for_key(key, raw.get("tuning", base["tuning"]))
    if tuning is None:
        return None, f"instrument_profiles.{profile_id}.tuning must match {key}"

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


def normalize_instrument_profiles(raw_profiles=None) -> tuple[dict[str, dict] | None, str | None]:
    """Validate persisted host profiles, filling omitted built-ins with defaults."""
    if raw_profiles is None:
        return default_instrument_profiles(), None
    if not isinstance(raw_profiles, dict):
        return None, "instrument_profiles must be an object"
    profiles = {}
    for profile_id in PROFILE_IDS:
        profile, error = normalize_instrument_profile(profile_id, raw_profiles.get(profile_id))
        if error:
            return None, error
        profiles[profile_id] = profile
    return profiles, None


def active_profile_id(raw) -> str:
    return raw if raw in PROFILE_DEFAULTS else DEFAULT_ACTIVE_INSTRUMENT_PROFILE


def profile_from_legacy_settings(cfg: dict) -> dict:
    """Build an active profile from the old flat settings keys."""
    instrument = cfg.get("instrument") if cfg.get("instrument") in ("guitar", "bass") else "guitar"
    fallback_sc = 4 if instrument == "bass" else 6
    try:
        sc = int(cfg.get("string_count", fallback_sc))
    except (TypeError, ValueError, OverflowError):
        sc = fallback_sc
    key = instrument_key(instrument, sc)
    if key not in STANDARD_OPEN_MIDIS:
        sc = fallback_sc
        key = instrument_key(instrument, sc)
    tuning = _valid_tuning_for_key(key, cfg.get("tuning", "Standard")) or "Standard"
    ref = _valid_reference_pitch(cfg.get("reference_pitch", DEFAULT_REFERENCE_PITCH)) or DEFAULT_REFERENCE_PITCH
    pathway = cfg.get("pathway") if cfg.get("pathway") in PROFILE_PATHWAYS else "songs"
    profile_id = "bass" if instrument == "bass" else DEFAULT_ACTIVE_INSTRUMENT_PROFILE
    profile = dict(PROFILE_DEFAULTS[profile_id])
    profile.update({
        "instrument": instrument,
        "string_count": sc,
        "tuning": tuning,
        "reference_pitch": ref,
        "pathway": pathway,
    })
    return profile


def settings_with_instrument_profiles(cfg: dict) -> dict:
    """Return settings with canonical host profiles and mirrored flat keys."""
    out = dict(cfg)
    profiles, _error = normalize_instrument_profiles(out.get("instrument_profiles"))
    if profiles is None:
        profiles = default_instrument_profiles()
    if "instrument_profiles" not in out:
        legacy = profile_from_legacy_settings(out)
        profiles[legacy["id"]] = legacy
        # Default the active profile to the one migrated from the legacy flat
        # fields, but DON'T clobber an explicit request — a fresh-config
        # `POST {"active_instrument_profile": "bass"}` must switch, not be
        # overwritten by the guitar-lead inferred from defaults. active_profile_id
        # below normalizes an invalid value.
        out.setdefault("active_instrument_profile", legacy["id"])
    active = active_profile_id(out.get("active_instrument_profile"))
    selected = profiles[active]
    out["instrument_profiles"] = profiles
    out["active_instrument_profile"] = active
    out["instrument"] = selected["instrument"]
    out["string_count"] = selected["string_count"]
    out["tuning"] = selected["tuning"]
    out["reference_pitch"] = selected["reference_pitch"]
    out["pathway"] = selected["pathway"]
    return out


def apply_flat_instrument_patch_to_profiles(cfg: dict, updates: dict) -> dict:
    """Mirror legacy flat instrument updates into the active host profile."""
    out = settings_with_instrument_profiles(cfg)
    if not any(k in updates for k in ("instrument", "string_count", "tuning", "reference_pitch", "pathway")):
        return out
    active = active_profile_id(out.get("active_instrument_profile"))
    if "instrument" in updates:
        active = "bass" if updates["instrument"] == "bass" else "guitar-lead"
        out["active_instrument_profile"] = active
    current = dict(out["instrument_profiles"][active])

    if "instrument" in updates:
        current["instrument"] = updates["instrument"]
        if "string_count" not in updates:
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
        key = instrument_key(current["instrument"], current["string_count"])
        if _valid_tuning_for_key(key, current.get("tuning")) is None:
            current["tuning"] = "Standard"

    profile, error = normalize_instrument_profile(active, current)
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

# ── Bass tuning normalization (library indexing) ─────────────────────────────
#
# Bass charts in the wild store SIX-element tuning arrays even when the chart is
# a 4-string part: slots 4-5 are PADDING. Confirmed by inspecting the charts
# themselves — across every pack whose bass and guitar tunings diverge, no bass
# note ever references string index 4 or 5 (the deepest reach is index 3).
#
# The feedpak spec carries NO string-count field (manifest `arrangement.tuning`
# is an untyped integer array, `minItems: 1`), and counting strings for real
# would mean parsing the 600KB-1.2MB arrangement JSON of every song on the
# manifest-only fast scan path — unacceptable for scan time. So we DEFAULT BASS
# TO 4 STRINGS and truncate.
#
# KNOWN GAP (deliberate, documented): a genuine 5- or 6-string bass is
# truncated to its low four. That is harmless for the overwhelmingly common
# case — a 5-string in standard truncates to [0,0,0,0] and still names
# "Standard" — and only misreads a tuning that DIFFERS at string 4 or above.
# Revisit if the spec ever gains a string count.
BASS_DEFAULT_STRING_COUNT = 4

# Bassists tune DOWN, essentially never up: a whole-instrument up-tune fights
# string tension. Anything above +1 semitone across the board is data we do not
# trust, not a tuning a human plays (the real-world example that motivated this
# is a bass array of [5,5,5,5,4,4] — "all four strings up a perfect fourth" —
# on a song whose guitar chart is dead standard and whose own note content is
# consistent with standard tuning; the offsets were almost certainly computed
# against a 6-string-bass reference with an uninitialised tail).
#
# Such a tuning MUST NOT be named: printing "A Standard" would send a player
# off to retune to something nobody plays. It degrades to the custom path,
# where it stays visible and distinct but makes no pitch claim.
BASS_MAX_PLAUSIBLE_OFFSET = 1


# ── Tuning PERSPECTIVES ──────────────────────────────────────────────────────
#
# The library's tuning facet/filter/sort always answers for ONE arrangement
# role. There are three, matching `active_instrument_profile`:
#
#   guitar-lead    the song-level (guitar-first) tuning — the historical
#                  default. Its columns are the original unprefixed
#                  `tuning_*` family, so today's behaviour is byte-identical.
#   guitar-rhythm  the RHYTHM chart's own tuning. Lead and rhythm charts can
#                  disagree (the same bug a bassist hit, inside guitar).
#   bass           the BASS chart's own tuning.
#
# One table drives extraction, the derived columns, the SQL, and the labels —
# rather than three near-identical column families maintained in parallel.
class TuningPerspective:
    __slots__ = ("id", "role", "instrument", "string_count", "column_prefix",
                 "truncate", "guard_up_tuning", "label")

    def __init__(self, id, role, instrument, string_count, column_prefix,
                 truncate, guard_up_tuning, label):
        self.id = id
        self.role = role                    # arrangement name to look for ('' = song-level)
        self.instrument = instrument
        self.string_count = string_count
        self.column_prefix = column_prefix  # '' | 'rhythm_' | 'bass_'
        self.truncate = truncate
        self.guard_up_tuning = guard_up_tuning
        self.label = label

    @property
    def instrument_key(self) -> str:
        return instrument_key(self.instrument, self.string_count)

    def column(self, suffix: str) -> str:
        return f"{self.column_prefix}tuning_{suffix}"


PERSPECTIVES: dict[str, TuningPerspective] = {
    "guitar-lead": TuningPerspective(
        "guitar-lead", "", "guitar", 6, "", False, False, "lead"),
    "guitar-rhythm": TuningPerspective(
        "guitar-rhythm", "rhythm", "guitar", 6, "rhythm_", False, False, "rhythm"),
    # Bass alone truncates (padded arrays) and guards against up-tuned data —
    # both are bass-specific findings, see the block above.
    "bass": TuningPerspective(
        "bass", "bass", "bass", BASS_DEFAULT_STRING_COUNT, "bass_", True, True, "bass"),
}

DEFAULT_PERSPECTIVE = "guitar-lead"

# Perspectives that carry their OWN indexed columns (guitar-lead reads the
# song-level ones, which the scanner has always written).
ROLE_PERSPECTIVES = tuple(p for p in PERSPECTIVES.values() if p.column_prefix)


def perspective(perspective_id) -> TuningPerspective:
    """Resolve a perspective id, tolerating the legacy two-valued vocabulary
    ('guitar' -> guitar-lead) and anything unknown (-> the default). An
    unrecognised value must never change filter semantics."""
    if perspective_id in PERSPECTIVES:
        return PERSPECTIVES[perspective_id]
    if perspective_id == "guitar":
        return PERSPECTIVES[DEFAULT_PERSPECTIVE]
    return PERSPECTIVES[DEFAULT_PERSPECTIVE]


def normalize_offsets(offsets, persp: TuningPerspective) -> list[int] | None:
    """Coerce a stored tuning array to the strings the perspective's
    instrument actually has. Returns None for anything unusable (empty /
    non-integer / too short), so callers leave the index empty rather than
    record a guess."""
    if not isinstance(offsets, list) or not offsets:
        return None
    if any(isinstance(o, bool) for o in offsets):
        return None
    try:
        vals = [int(o) for o in offsets]
    except (TypeError, ValueError):
        return None
    if len(vals) < persp.string_count:
        return None
    # Only bass truncates: its arrays are padded (see above). A guitar array
    # longer than 6 is a genuine 7/8-string chart, and cutting it to 6 would
    # invent a tuning the chart does not have.
    if persp.truncate:
        return vals[:persp.string_count]
    return vals


def offsets_are_plausible(offsets: list[int], persp: TuningPerspective) -> bool:
    """False for data the perspective refuses to trust — currently only the
    bass up-tuning guard (see BASS_MAX_PLAUSIBLE_OFFSET)."""
    if not persp.guard_up_tuning:
        return True
    return all(o <= BASS_MAX_PLAUSIBLE_OFFSET for o in offsets)


def perspective_tuning_name(offsets: list[int], persp: TuningPerspective) -> str:
    """Name a NORMALIZED tuning for this perspective, refusing to name data the
    perspective distrusts — that becomes "Custom Tuning", which stays distinct
    by its canonical pitches without asserting a tuning anyone plays."""
    if not offsets_are_plausible(offsets, persp):
        return "Custom Tuning"
    return tuning_name(offsets)


def perspective_tuning_key(offsets: list[int], persp: TuningPerspective) -> str:
    """CANONICAL grouping key: the tuning's absolute open-string pitches, so
    the same physical tuning groups as ONE facet entry no matter how it was
    serialized. Keyed on pitch rather than the raw offsets string, which is
    serialization-dependent and fragments.

    Joined with ':' and NOT ',' — this key travels back as a `tunings` filter
    selector, and that query param is a COMMA-separated list, so a comma here
    would be split into meaningless fragments and match nothing.
    """
    midis = tuning_midis_from_offsets(persp.instrument_key, offsets)
    if not midis:
        return ""
    return persp.id + ":" + ":".join(str(m) for m in midis)


def perspective_low_pitch(offsets: list[int], persp: TuningPerspective) -> int | None:
    """Absolute MIDI pitch of the tuning's LOWEST open string — the value the
    "playable without retuning" comparison is built on (see
    `chart_is_playable_in`)."""
    midis = tuning_midis_from_offsets(persp.instrument_key, offsets)
    if not midis:
        return None
    return min(midis)


# ── "Playable without retuning" ──────────────────────────────────────────────
#
# What the player actually wants is "don't make me retune", not "match this
# label". A chart is playable as-is when every pitch it needs is reachable on
# the instrument as currently tuned.
#
# WHAT WE CAN HONESTLY COMPUTE. We index open-string TUNINGS, not the notes a
# chart plays — note data lives in the 600KB-1.2MB arrangement JSON, and the
# library scan is deliberately manifest-only, so we do not read it (indexing a
# per-song lowest note would mean opening every chart on every scan).
#
# So the comparison is on OPEN-STRING PITCH, with a conservative assumption:
# a chart may require its own lowest open string. That gives
#
#     playable  <=>  your lowest open pitch  <=  the chart's lowest open pitch
#
# On a fretted instrument every pitch ABOVE your lowest open string is
# reachable by fretting (strings sit within an octave of each other and the
# neck gives ~2 octaves), so the low end is the binding constraint. This is
# exactly the dominant real case: a 5-string bass (low B) plays every 4-string
# standard chart AND every drop-D chart untouched, because the low D is just
# fretted on the B string.
#
# DELIBERATE LIMITATIONS, both erring toward NOT claiming playability:
#   * A chart that never actually touches its lowest open string is excluded
#     anyway. Conservative: excluding a playable chart costs a scroll;
#     including an unplayable one costs a mid-practice retune, which is the
#     failure this feature exists to prevent.
#   * The UPPER bound is not checked — a chart tuned far above you could in
#     principle exceed your neck. Checking it needs the note range we do not
#     have. It is the rare direction (and the guard above already refuses
#     up-tuned bass data), but it is a real gap, not an oversight.
def chart_is_playable_in(chart_low_pitch, your_low_pitch) -> bool:
    """True when a chart whose lowest open string is `chart_low_pitch` needs no
    retune for a player tuned to `your_low_pitch`. Unknown chart pitch => False
    (never claim playability we cannot support)."""
    if chart_low_pitch is None or your_low_pitch is None:
        return False
    return int(your_low_pitch) <= int(chart_low_pitch)


# Back-compat wrappers over the generic helpers — bass was the first
# perspective and reads better spelled out at bass-specific call sites.
def normalize_bass_offsets(offsets) -> list[int] | None:
    return normalize_offsets(offsets, PERSPECTIVES["bass"])


def bass_offsets_are_plausible(offsets: list[int]) -> bool:
    return offsets_are_plausible(offsets, PERSPECTIVES["bass"])


def bass_tuning_name(offsets: list[int]) -> str:
    return perspective_tuning_name(offsets, PERSPECTIVES["bass"])


def bass_tuning_key(offsets: list[int]) -> str:
    return perspective_tuning_key(offsets, PERSPECTIVES["bass"])


def tuning_name(offsets: list[int]) -> str:
    # The pattern checks below are gated on `len(offsets)` being 6 or 4. The
    # naming conventions are E-standard-rooted — e.g. a 7-string all-zeros
    # tuning has a low B, not an E, so labeling it "E Standard" would be wrong.
    # 7+-string community content falls through to the numeric fallback (#43).
    #
    # Length 4 is accepted because a bass's open strings (EADG) are the low
    # four of the guitar, so the same standard/drop names apply at the same
    # offsets. Bass callers must normalize FIRST (`normalize_bass_offsets`):
    # stored bass arrays are commonly six elements with a padded tail, and the
    # padding must never reach this namer. See the block above.

    # Standard tunings (all strings same offset)
    standard = {
        0: "E Standard", -1: "Eb Standard", -2: "D Standard",
        -3: "C# Standard", -4: "C Standard", -5: "B Standard",
        -6: "Bb Standard", -7: "A Standard",
        1: "F Standard", 2: "F# Standard",
    }
    if len(offsets) in (4, 6) and all(o == offsets[0] for o in offsets):
        name = standard.get(offsets[0])
        if name:
            return name

    # Drop tunings (low string 2 semitones below the rest)
    # Named after the low string's note: e.g. offsets[-2,0,0,0,0,0] = Drop D (low E dropped to D)
    if len(offsets) in (4, 6) and offsets[0] == offsets[1] - 2 and all(o == offsets[1] for o in offsets[1:]):
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
