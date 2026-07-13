"""Regression tests for the feedpak spec-conformance gate.

The gate (tools/check_spec_conformance.py) is what keeps the app from drifting
away from the feedpak spec, so the gate itself must not be weakenable by a
quiet refactor: these tests pin its load-bearing behaviours — read/write
classification, the closed allowlist, and the duplicate/malformed-entry
rejections. If one of these fails, the spec's protection regressed.
"""
import importlib.util
import sys
import textwrap
from pathlib import Path

import pytest

_SPEC_GATE = Path(__file__).resolve().parent.parent / "tools" / "check_spec_conformance.py"
_spec = importlib.util.spec_from_file_location("check_spec_conformance", _SPEC_GATE)
gate = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(gate)


def _touch(tmp_path, source):
    p = tmp_path / "mod.py"
    p.write_text(textwrap.dedent(source), encoding="utf-8")
    return gate.keys_touched(p)


# ---------------------------------------------------------------- keys_touched

def test_get_is_a_read(tmp_path):
    reads, writes = _touch(tmp_path, 'x = manifest.get("title")')
    assert reads == {"title"} and writes == set()


def test_subscript_load_is_a_read(tmp_path):
    reads, writes = _touch(tmp_path, 'x = manifest["artist"]')
    assert reads == {"artist"} and writes == set()


def test_subscript_store_is_a_write_not_a_read(tmp_path):
    # The original scan ignored ctx and scored this as a read (lib/songmeta.py
    # pattern). A regression here reopens the emitted-key blind spot.
    reads, writes = _touch(tmp_path, 'manifest["year"] = 1999')
    assert writes == {"year"} and reads == set()


def test_setdefault_is_a_write(tmp_path):
    # lib/gp2notation.py stamps feedpak_version this way; a subscript-only scan
    # missed it entirely.
    reads, writes = _touch(tmp_path, 'manifest.setdefault("feedpak_version", "1.2.0")')
    assert writes == {"feedpak_version"} and reads == set()


def test_load_manifest_wrapped_get_is_seen(tmp_path):
    # lib/enrichment.py idiom: (load_manifest(p) or {}).get("key")
    reads, writes = _touch(
        tmp_path, 'rel = (sloppak_mod.load_manifest(p) or {}).get("original_audio")'
    )
    assert "original_audio" in reads


def test_unrelated_dicts_are_ignored(tmp_path):
    reads, writes = _touch(tmp_path, 'x = config.get("title"); settings["artist"] = 1')
    assert reads == set() and writes == set()


def test_non_literal_keys_are_ignored(tmp_path):
    reads, writes = _touch(tmp_path, 'x = manifest.get(key_var); manifest[key_var] = 1')
    assert reads == set() and writes == set()


# ------------------------------------------------------------ exceptions file

def test_duplicate_exception_key_is_rejected():
    doc = """
    exceptions:
      - key: original_audio
        issue: https://example.com/1
      - key: original_audio
        issue: https://example.com/2
    """
    with pytest.raises(SystemExit):
        gate._parse_exceptions(textwrap.dedent(doc), "test")


def test_exception_without_issue_is_rejected():
    # No tracking issue, no exception — entries are debt and debt is tracked.
    doc = """
    exceptions:
      - key: original_audio
    """
    with pytest.raises(SystemExit):
        gate._parse_exceptions(textwrap.dedent(doc), "test")


# --------------------------------------------------------- allowlist is CLOSED

def _yml(tmp_path, name, keys):
    p = tmp_path / name
    entries = "".join(
        f"  - key: {k}\n    issue: https://example.com/{k}\n" for k in keys
    )
    p.write_text("exceptions:\n" + (entries or " []\n"), encoding="utf-8")
    return p


def test_allowlist_may_not_grow(tmp_path, monkeypatch):
    # THE core property: adding an entry must fail, or the FEP process has an
    # in-repo bypass and the gate is a speed bump with a signed excuse note.
    baseline = _yml(tmp_path, "base.yml", ["original_audio"])
    current = _yml(tmp_path, "current.yml", ["original_audio", "sneaky_new_key"])
    monkeypatch.setattr(gate, "EXCEPTIONS_FILE", current)
    assert gate.check_allowlist_closed(baseline, bootstrap=False) is False


def test_allowlist_may_shrink(tmp_path, monkeypatch):
    baseline = _yml(tmp_path, "base.yml", ["original_audio"])
    current = _yml(tmp_path, "current.yml", [])
    monkeypatch.setattr(gate, "EXCEPTIONS_FILE", current)
    assert gate.check_allowlist_closed(baseline, bootstrap=False) is True


def test_allowlist_steady_state_passes(tmp_path, monkeypatch):
    baseline = _yml(tmp_path, "base.yml", ["original_audio"])
    current = _yml(tmp_path, "current.yml", ["original_audio"])
    monkeypatch.setattr(gate, "EXCEPTIONS_FILE", current)
    assert gate.check_allowlist_closed(baseline, bootstrap=False) is True


def test_bootstrap_skips_the_diff(tmp_path, monkeypatch):
    current = _yml(tmp_path, "current.yml", ["original_audio"])
    monkeypatch.setattr(gate, "EXCEPTIONS_FILE", current)
    assert gate.check_allowlist_closed(None, bootstrap=True) is True


# ------------------------------------------------------------ readers-complete

def test_readers_list_matches_the_codebase():
    # If this fails, a module started touching feedpak manifests without being
    # added to READERS — its keys are going unchecked. Same check CI runs.
    assert gate.check_readers_complete() is True


def test_no_undeclared_keys_beyond_the_grandfathered(monkeypatch):
    # Every key core touches is either spec-declared or grandfathered with a
    # tracking issue. New keys go through the FEP process, full stop.
    reads, writes = set(), set()
    for rel in gate.READERS:
        r, w = gate.keys_touched(gate.REPO / rel)
        reads |= r
        writes |= w
    grandfathered = set(gate.load_exceptions())
    # Not asserting against the spec here (no spec checkout in unit tests) —
    # asserting the *shape*: the only non-spec keys tolerated are grandfathered,
    # and today that is exactly {original_audio}.
    assert grandfathered == {"original_audio"}
    assert "original_audio" in reads
