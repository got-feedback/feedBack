"""Tests for lib/tunings.py: semitone-offset → human-readable tuning name."""

import pytest

from tunings import (
    DEFAULT_TUNINGS,
    PERSPECTIVES,
    TUNING_PRESET_MIDIS,
    _valid_tuning_for_key,
    apply_flat_instrument_patch_to_profiles,
    normalize_offsets,
    open_midis_to_freqs,
    perspective_low_pitch,
    perspective_tuning_key,
    perspective_tuning_name,
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
    # The legacy 6-string-bass name migrates to the corrected one: the
    # pitches [19,24,29,34,39,44] sound lowest G, and extended-range bass is
    # named off its actual lowest string. Same tuning, right label — and the
    # alias is what keeps this profile VALID rather than rejected.
    assert settings["instrument_profiles"]["bass"]["tuning"] == "G Standard"
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


# ── freqs_to_midis (the /api/tunings tuningMidis inverse) ────────────────────

def test_freqs_to_midis_round_trips_every_builtin_at_440():
    from tunings import freqs_to_midis
    for key, presets in TUNING_PRESET_MIDIS.items():
        for name, midis in presets.items():
            assert freqs_to_midis(open_midis_to_freqs(midis)) == midis, f"{key}/{name}"


def test_freqs_to_midis_round_trips_at_nonstandard_reference():
    # The consumer footgun this exists to kill: frequencies served at a 432/450
    # reference must recover the SAME integer midis when inverted at that
    # reference (client-side log2-at-440 reconstruction drifts here).
    from tunings import freqs_to_midis
    for ref in (430.0, 432.0, 444.0, 450.0):
        for midis in (TUNING_PRESET_MIDIS["guitar-8"]["Standard"], TUNING_PRESET_MIDIS["bass-5"]["Standard"]):
            freqs = open_midis_to_freqs(midis, ref)
            assert freqs_to_midis(freqs, ref) == midis, f"ref={ref}"


def test_freqs_to_midis_rejects_garbage():
    from tunings import freqs_to_midis
    assert freqs_to_midis([82.41, 0]) is None          # non-positive
    assert freqs_to_midis([82.41, "x"]) is None        # non-numeric
    assert freqs_to_midis([float("nan")]) is None      # non-finite (would raise in int(round(...)))
    assert freqs_to_midis([float("inf")]) is None      # non-finite
    assert freqs_to_midis([float("-inf")]) is None     # non-finite
    assert freqs_to_midis([]) == []                    # vacuously fine


# ── Extended-range BASS naming (feedBack: 6-string bass read as guitar) ──────
# A 6-string bass has SIX offsets exactly like a 6-string guitar, but its
# lowest string is B, not E. `tuning_name` gated its guitar ladder on
# `len(offsets) == 6` alone, so a bass got guitar names: an all-zeros bass
# read "E Standard" (it is Standard/B) and a whole-step-down bass read
# "D Standard" (it is A Standard). Reported from a real Sleep Token chart
# tuned A0 D1 G1 C2 F2 A#2; the player called it A standard and was right.
# Convention (bass- and guitar-pedagogy seats, 2026-07-18): name extended
# range by the ACTUAL lowest string, matching the 7-string guitar presets.

def test_bass_perspective_keeps_proven_six_string_tuning_but_truncates_padding():
    bass = PERSPECTIVES["bass"]

    # Legacy four-string Rocksmith data pads its unused tail with zeroes.
    assert normalize_offsets([-2, -2, -2, -2, 0, 0], bass) == [-2] * 4

    # A uniform non-zero six-string tuning cannot be that padding shape.
    extended = normalize_offsets([-2] * 6, bass)
    assert extended == [-2] * 6
    assert perspective_tuning_name(extended, bass) == "A Standard"
    assert perspective_tuning_key(extended, bass) == "bass:21:26:31:36:41:46"
    assert perspective_low_pitch(extended, bass) == 21


BASS_STANDARD_CASES = [
    # 4-string bass is E-A-D-G — the guitar ladder's low four, names unchanged.
    ([0, 0, 0, 0], "E Standard"),
    ([-1, -1, -1, -1], "Eb Standard"),
    ([-2, -2, -2, -2], "D Standard"),
    # 5-string adds a low B → the B ladder.
    ([0] * 5, "Standard"),
    ([-1] * 5, "Bb Standard"),
    ([-2] * 5, "A Standard"),
    ([-3] * 5, "G# Standard"),
    ([-4] * 5, "G Standard"),
    # 6-string: same names, extra top string.
    ([0] * 6, "Standard"),
    ([-1] * 6, "Bb Standard"),
    ([-2] * 6, "A Standard"),
    ([-3] * 6, "G# Standard"),
    ([-4] * 6, "G Standard"),
]


@pytest.mark.parametrize("offsets,expected", BASS_STANDARD_CASES)
def test_bass_standard_tunings(offsets, expected):
    assert tuning_name(offsets, is_bass=True) == expected


def test_six_offsets_alone_do_not_imply_a_guitar():
    """The regression the bug report came from."""
    sleep_token = [-2] * 6           # A0 D1 G1 C2 F2 A#2
    assert tuning_name(sleep_token, is_bass=True) == "A Standard"
    # ...and the identical offsets on a guitar keep the guitar name.
    assert tuning_name(sleep_token) == "D Standard"
    # A STANDARD 6-string bass is not "E Standard" either.
    assert tuning_name([0] * 6, is_bass=True) == "Standard"
    assert tuning_name([0] * 6) == "E Standard"


def test_bass_drop_tunings_name_the_resulting_low_string():
    # 5-string B standard, low string dropped a whole step → A.
    assert tuning_name([-2, 0, 0, 0, 0], is_bass=True) == "Drop A"
    # 4-string E standard → D.
    assert tuning_name([-2, 0, 0, 0], is_bass=True) == "Drop D"


def test_bass_presets_are_named_off_their_lowest_string():
    """Every bass preset's name must match the note its low string sounds."""
    names = ["C", "C#", "D", "Eb", "E", "F", "F#", "G", "Ab", "A", "Bb", "B"]
    alt = {"Ab": "G#", "G#": "Ab", "Bb": "A#", "A#": "Bb", "Eb": "D#", "D#": "Eb"}
    for key in ("bass-4", "bass-5", "bass-6"):
        for name, midis in TUNING_PRESET_MIDIS[key].items():
            if not name.endswith("Standard") or name == "Standard":
                continue
            root = name.rsplit(" ", 1)[0]
            low = names[midis[0] % 12]
            assert root in (low, alt.get(low)), (
                f"{key} {name!r} lowest string sounds {low}"
            )


def test_superseded_bass_names_migrate_instead_of_being_rejected():
    """Renaming must not invalidate saved profiles (both pedagogy seats)."""
    for key in ("bass-5", "bass-6"):
        assert _valid_tuning_for_key(key, "D Standard") == "A Standard"
        assert _valid_tuning_for_key(key, "C Standard") == "G Standard"
        # Current names still pass straight through.
        assert _valid_tuning_for_key(key, "A Standard") == "A Standard"
    # The rename must not leak into other instruments.
    assert _valid_tuning_for_key("guitar-6", "D Standard") == "D Standard"
    assert _valid_tuning_for_key("bass-4", "D Standard") == "D Standard"
