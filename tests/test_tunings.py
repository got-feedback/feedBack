"""Tests for lib/tunings.py: semitone-offset → human-readable tuning name."""

import pytest

from tunings import (
    DEFAULT_TUNINGS,
    TUNING_PRESET_MIDIS,
    _valid_tuning_for_key,
    apply_flat_instrument_patch_to_profiles,
    open_midis_to_freqs,
    settings_with_instrument_profiles,
    tuning_midis_from_offsets,
    tuning_name,
    tuning_offsets_from_midis,
    tuning_preset_offsets,
)


def test_valid_tuning_for_key_builtin_and_provider_names():
    # A built-in valid for the key is accepted; a built-in valid only for a
    # DIFFERENT key (misapplied, e.g. "Drop D" on a 5-string bass) is rejected.
    assert _valid_tuning_for_key("bass-5", "Drop A") == "Drop A"
    assert _valid_tuning_for_key("bass-5", "Drop D") is None
    assert _valid_tuning_for_key("guitar-6", "Standard") == "Standard"
    # A name unknown to every built-in table is a provider/custom tuning (tuner
    # plugin, /api/tunings) the pure layer can't resolve — accept it so settings
    # round-trip rather than normalizing it away to Standard.
    assert _valid_tuning_for_key("bass-5", "My Custom DADGAD") == "My Custom DADGAD"
    assert _valid_tuning_for_key("guitar-6", "x" * 65) is None   # length cap kept


# ── Standard tunings (all six strings share the same offset) ─────────────────

STANDARD_CASES = [
    ([0, 0, 0, 0, 0, 0], "E Standard"),
    ([-1, -1, -1, -1, -1, -1], "Eb Standard"),
    ([-2, -2, -2, -2, -2, -2], "D Standard"),
    ([-3, -3, -3, -3, -3, -3], "C# Standard"),
    ([-4, -4, -4, -4, -4, -4], "C Standard"),
    ([-5, -5, -5, -5, -5, -5], "B Standard"),
    ([-6, -6, -6, -6, -6, -6], "Bb Standard"),
    ([-7, -7, -7, -7, -7, -7], "A Standard"),
    ([1, 1, 1, 1, 1, 1], "F Standard"),
    ([2, 2, 2, 2, 2, 2], "F# Standard"),
]


@pytest.mark.parametrize("offsets,expected", STANDARD_CASES)
def test_standard_tunings(offsets, expected):
    assert tuning_name(offsets) == expected


# ── Drop tunings (low string 2 semitones below the rest) ─────────────────────
# The auto-generator handles these; the explicit "Drop D" / "Drop C" entries in
# the named-tunings dict are effectively dead code because the auto-generator
# fires first and produces the same string.

DROP_CASES = [
    ([-2, 0, 0, 0, 0, 0], "Drop D"),
    ([-4, -2, -2, -2, -2, -2], "Drop C"),
    ([-3, -1, -1, -1, -1, -1], "Drop C#"),
    ([-5, -3, -3, -3, -3, -3], "Drop B"),
    ([-7, -5, -5, -5, -5, -5], "Drop A"),
    ([-8, -6, -6, -6, -6, -6], "Drop Ab"),
]


@pytest.mark.parametrize("offsets,expected", DROP_CASES)
def test_drop_tunings_auto_generated(offsets, expected):
    assert tuning_name(offsets) == expected


# ── Named tunings (non-drop patterns the auto-generator doesn't catch) ───────

NAMED_CASES = [
    ([-2, -2, 0, 0, 0, 0], "Double Drop D"),
    ([0, 0, 0, -1, 0, 0], "Open G"),
    ([-2, -2, 0, 0, -2, -2], "Open D"),
    ([-2, 0, 0, 0, -2, 0], "DADGAD"),
    ([0, 2, 2, 1, 0, 0], "Open E"),
    ([-2, 0, 0, 2, 3, 2], "Open D (alt)"),
]


@pytest.mark.parametrize("offsets,expected", NAMED_CASES)
def test_named_tunings(offsets, expected):
    assert tuning_name(offsets) == expected


# ── Fallback: unrecognized offsets return a musician-friendly label ────────────

def test_fallback_unrecognized_offsets():
    assert tuning_name([-3, -1, 0, 1, 2, 3]) == "Custom Tuning"


def test_fallback_partial_drop_pattern():
    assert tuning_name([-2, 0, 0, 0, -2]) == "Custom Tuning"


def test_fallback_with_seven_strings():
    assert tuning_name([-5, 0, 0, 0, 0, 0, 0]) == "Custom Tuning"


# ── 7+-string regression tests (#43) ─────────────────────────────────────────
# The 6-string naming conventions (E Standard, Drop D, Double Drop D, etc.)
# don't generalize — a 7-string all-zeros has a low B, not an E. All three
# pattern checks are gated on len == 6; 7+ falls through to the numeric fallback.

SEVEN_STRING_FALLBACK_CASES = [
    # Previously mislabeled "E Standard" because len >= 6 + all-same matched.
    ([0, 0, 0, 0, 0, 0, 0], "Custom Tuning"),
    # Previously mislabeled "Eb Standard".
    ([-1, -1, -1, -1, -1, -1, -1], "Custom Tuning"),
    # Previously mislabeled "Drop D" because the drop auto-generator matched
    # (offsets[0] == offsets[1] - 2, rest all equal).
    ([-2, 0, 0, 0, 0, 0, 0], "Custom Tuning"),
    # Previously mislabeled "Drop C" similarly.
    ([-4, -2, -2, -2, -2, -2, -2], "Custom Tuning"),
    # Previously mislabeled "Double Drop D" because the named-dict lookup used
    # tuple(offsets[:6]) which silently truncated the seventh offset.
    ([-2, -2, 0, 0, 0, 0, 0], "Custom Tuning"),
]


@pytest.mark.parametrize("offsets,expected", SEVEN_STRING_FALLBACK_CASES)
def test_seven_string_falls_through_to_fallback(offsets, expected):
    assert tuning_name(offsets) == expected


def test_five_string_falls_through_to_fallback():
    assert tuning_name([0, 0, 0, 0, 0]) == "Custom Tuning"


# ── Edge cases ───────────────────────────────────────────────────────────────

def test_empty_list_returns_unknown():
    # Empty offsets is the one case where the numeric fallback is useless —
    # `" ".join(str(o) for o in [])` is `""`, which used to flow downstream
    # as a blank badge. `or "Unknown"` kicks in only for empty input.
    assert tuning_name([]) == "Unknown"


def test_too_short_list_falls_through_to_fallback():
    assert tuning_name([-2, 0, 0]) == "Custom Tuning"


def test_standard_dict_takes_precedence_over_numeric_fallback():
    # A list of 6 zeros could theoretically also hit the named-tunings tuple lookup
    # (if (0,0,0,0,0,0) were in there), but the standard-tuning branch runs first.
    # This test pins the priority.
    assert tuning_name([0, 0, 0, 0, 0, 0]) == "E Standard"


def test_drop_pattern_takes_precedence_over_named_dict():
    # [-2, 0, 0, 0, 0, 0] is in the named dict as "Drop D", but the drop-pattern
    # auto-generator fires first and produces the same string. The named dict entry
    # is effectively dead code for this case — this test documents the behavior.
    assert tuning_name([-2, 0, 0, 0, 0, 0]) == "Drop D"


# ── Host tuning profile catalogue -------------------------------------------

def test_default_tunings_include_extended_host_profiles():
    assert "bass-6" in DEFAULT_TUNINGS
    assert "C Standard" in DEFAULT_TUNINGS["guitar-6"]
    assert "C# Standard" in DEFAULT_TUNINGS["guitar-6"]
    assert "Drop Ab" in DEFAULT_TUNINGS["guitar-6"]
    assert "BEAD" in DEFAULT_TUNINGS["bass-4"]
    assert "High C" in DEFAULT_TUNINGS["bass-5"]
    assert "Drop A + Drop E" in DEFAULT_TUNINGS["guitar-8"]


def test_default_tuning_frequencies_are_derived_from_midis():
    assert DEFAULT_TUNINGS["guitar-6"]["Standard"] == open_midis_to_freqs([40, 45, 50, 55, 59, 64])
    assert DEFAULT_TUNINGS["bass-6"]["Standard"] == open_midis_to_freqs([23, 28, 33, 38, 43, 48])


def test_tuning_offsets_from_named_presets():
    assert tuning_preset_offsets("guitar-6", "Drop D") == [-2, 0, 0, 0, 0, 0]
    assert tuning_preset_offsets("guitar-6", "C Standard") == [-4, -4, -4, -4, -4, -4]
    assert tuning_preset_offsets("bass-4", "BEAD") == [-5, -5, -5, -5]
    assert tuning_preset_offsets("bass-5", "High C") == [5, 5, 5, 5, 5]


def test_tuning_midis_round_trip_offsets():
    offsets = [-2, 0, 0, 0, 0, 0]
    midis = tuning_midis_from_offsets("guitar-6", offsets)
    assert midis == TUNING_PRESET_MIDIS["guitar-6"]["Drop D"]
    assert tuning_offsets_from_midis("guitar-6", midis) == offsets


def test_tuning_conversion_rejects_wrong_string_count():
    assert tuning_offsets_from_midis("guitar-6", [40, 45, 50, 55]) is None
    assert tuning_midis_from_offsets("bass-4", [0, 0, 0, 0, 0]) is None

def test_settings_profiles_default_to_lead_rhythm_and_bass():
    settings = settings_with_instrument_profiles({})
    assert settings["active_instrument_profile"] == "guitar-lead"
    assert set(settings["instrument_profiles"]) == {"guitar-lead", "guitar-rhythm", "bass"}
    assert settings["instrument"] == "guitar"
    assert settings["string_count"] == 6
    assert settings["tuning"] == "Standard"
    assert settings["pathway"] == "songs"
    assert settings["instrument_profiles"]["guitar-lead"]["pathway"] == "songs"


def test_settings_profiles_migrate_legacy_flat_bass_selection():
    settings = settings_with_instrument_profiles({
        "instrument": "bass",
        "string_count": 6,
        "tuning": "C Standard",
        "reference_pitch": 432,
        "pathway": "practice",
    })
    assert settings["active_instrument_profile"] == "bass"
    assert settings["instrument_profiles"]["bass"]["string_count"] == 6
    assert settings["instrument_profiles"]["bass"]["tuning"] == "C Standard"
    assert settings["reference_pitch"] == 432
    assert settings["pathway"] == "practice"
    assert settings["instrument_profiles"]["bass"]["pathway"] == "practice"


def test_flat_patch_updates_active_profile_and_mirrors_legacy_keys():
    settings = settings_with_instrument_profiles({})
    patched = apply_flat_instrument_patch_to_profiles(settings, {"tuning": "Drop D"})
    assert patched["tuning"] == "Drop D"
    assert patched["instrument_profiles"]["guitar-lead"]["tuning"] == "Drop D"


def test_flat_pathway_patch_updates_active_profile_and_mirrors_legacy_key():
    settings = settings_with_instrument_profiles({})
    patched = apply_flat_instrument_patch_to_profiles(settings, {"pathway": "studio"})
    assert patched["pathway"] == "studio"
    assert patched["instrument_profiles"]["guitar-lead"]["pathway"] == "studio"


def test_flat_instrument_patch_defaults_to_target_string_count():
    settings = settings_with_instrument_profiles({"instrument": "guitar", "string_count": 6, "tuning": "Drop D"})
    patched = apply_flat_instrument_patch_to_profiles(settings, {"instrument": "bass"})
    assert patched["instrument"] == "bass"
    assert patched["string_count"] == 4
    assert patched["tuning"] == "Standard"
    assert patched["active_instrument_profile"] == "bass"
    assert patched["instrument_profiles"]["bass"]["string_count"] == 4


def test_flat_string_count_patch_resets_incompatible_named_tuning():
    settings = settings_with_instrument_profiles({"instrument": "guitar", "string_count": 6, "tuning": "DADGAD"})
    patched = apply_flat_instrument_patch_to_profiles(settings, {"string_count": 7})
    assert patched["string_count"] == 7
    assert patched["tuning"] == "Standard"
