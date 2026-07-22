"""Tests for lib/tones.py — sloppak tone-change payload builder."""

from tones import sloppak_tone_changes


# ── sloppak_tone_changes (highway payload builder) ───────────────────────────

def test_sloppak_tone_changes_sorts_and_returns_base():
    base, base_rig, changes = sloppak_tone_changes({
        "base": "Clean",
        "changes": [{"t": 12.5, "name": "Drive"}, {"t": 3.0, "name": "Clean"}],
    })
    assert base == "Clean"
    assert base_rig == ""
    assert changes == [{"t": 3.0, "name": "Clean"}, {"t": 12.5, "name": "Drive"}]


def test_sloppak_tone_changes_skips_malformed_markers():
    _, _, changes = sloppak_tone_changes({
        "changes": [
            {"t": "nan", "name": "BadStr"},
            {"t": float("inf"), "name": "Inf"},
            {"t": 5.0, "name": 123},          # non-string name
            {"t": None, "name": "NoTime"},
            "not-a-dict",
            {"t": 7.0, "name": "Good"},
        ],
    })
    assert changes == [{"t": 7.0, "name": "Good"}]


def test_sloppak_tone_changes_handles_none_and_bad_base():
    assert sloppak_tone_changes(None) == ("", "", [])
    base, base_rig, changes = sloppak_tone_changes({"base": 123, "changes": []})
    assert base == "" and base_rig == "" and changes == []


def test_sloppak_tone_changes_non_dict_input():
    """A truthy non-dict payload must not crash."""
    assert sloppak_tone_changes(["not", "a", "dict"]) == ("", "", [])
    assert sloppak_tone_changes("nope") == ("", "", [])


def test_sloppak_tone_changes_non_list_changes():
    """A truthy non-list `changes` value must not raise on iteration."""
    base, _, changes = sloppak_tone_changes({"base": "Clean", "changes": 1})
    assert base == "Clean" and changes == []


# ── rig bindings (feedpak-spec 1.18.0 §6.9) ──────────────────────────────────

def test_sloppak_tone_changes_carries_rig_bindings():
    """`base_rig` and per-change `rig` reach the wire — the binding a chart
    declares is what core must hand the consumer that voices the part."""
    base, base_rig, changes = sloppak_tone_changes({
        "base": "Clean Rhythm",
        "base_rig": "clean-rhythm",
        "changes": [
            {"t": 12.5, "name": "Lead Drive", "rig": "lead-drive"},
            {"t": 48.0, "name": "Clean Rhythm", "rig": "clean-rhythm"},
        ],
    })
    assert base == "Clean Rhythm"
    assert base_rig == "clean-rhythm"
    assert changes == [
        {"t": 12.5, "name": "Lead Drive", "rig": "lead-drive"},
        {"t": 48.0, "name": "Clean Rhythm", "rig": "clean-rhythm"},
    ]


def test_sloppak_tone_changes_omits_unusable_rig_ids():
    """A non-string or blank `rig` is dropped rather than forwarded, so a
    consumer can treat presence of the key as "this change binds a rig"."""
    _, base_rig, changes = sloppak_tone_changes({
        "base_rig": "   ",
        "changes": [
            {"t": 1.0, "name": "A", "rig": 7},
            {"t": 2.0, "name": "B", "rig": ""},
            {"t": 3.0, "name": "C", "rig": None},
            {"t": 4.0, "name": "D", "rig": "  padded-id  "},
        ],
    })
    assert base_rig == ""
    assert changes == [
        {"t": 1.0, "name": "A"},
        {"t": 2.0, "name": "B"},
        {"t": 3.0, "name": "C"},
        {"t": 4.0, "name": "D", "rig": "padded-id"},
    ]


def test_sloppak_tone_changes_non_string_base_rig():
    """A non-string `base_rig` must not crash or leak a non-id onto the wire."""
    _, base_rig, _ = sloppak_tone_changes({"base": "Clean", "base_rig": 42})
    assert base_rig == ""
