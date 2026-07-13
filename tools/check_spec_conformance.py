#!/usr/bin/env python3
"""feedpak spec-conformance gate.

feedpak is an open, versioned format with its own normative spec, JSON Schemas,
and reference validator (https://github.com/got-feedback/feedpak-spec). That
makes the spec a contract with everyone outside this repo: third-party packers,
converters, and players build against it. When core reads a manifest key the
spec never defined, the contract quietly breaks — a spec-compliant pack stops
being a fully-working pack, and the format's real definition migrates into our
source tree. See #933 for the instance that motivated this gate.

We cannot mechanically prove core *interprets* a key the way the spec means. We
can prove four surface properties, and those cover the drift that actually
happens:

  1. key-coverage    — every manifest key core reads OR WRITES is declared by the
                       spec. (Guarded by check_readers_complete(), so the list of
                       scanned modules cannot quietly fall behind the codebase.)
  2. allowlist-closed— feedpak-spec-exceptions.yml never grows. It grandfathers
                       keys that predate this gate; it is not a way to merge a
                       new one. The only route for a new key is the FEP process.
  3. forward         — core ingests the spec's own example packs.
  4. reverse         — packs committed here satisfy the spec's reference validator.

Dev/CI tooling only: never imported on the serve or Docker path (constitution
Principle I — same category as scripts/build-tailwind.sh). `jsonschema` is
therefore a CI-only dependency, not a runtime requirement.

Usage:
    python tools/check_spec_conformance.py --spec <path-to-feedpak-spec-checkout>

Exit status is 0 only when every layer passes.
"""
from __future__ import annotations

import argparse
import ast
import json
import re
import subprocess
import sys
import tempfile
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent

# Modules that read or write a feedpak manifest dict. Explicit rather than
# globbed, because `manifest` is an overloaded name in this codebase: the
# loose-folder format (lib/loosefolder.py) and the diagnostics bundle
# (lib/diagnostics_bundle.py) both have their own unrelated `manifest`, and
# scanning those would flag *their* keys as feedpak drift.
#
# A hand-maintained list is itself a blind spot, so check_readers_complete()
# below re-derives the set and fails if this list has fallen behind. A missing
# file here is a hard error too, so a rename cannot silently disable the scan.
READERS = [
    "lib/sloppak.py",
    "lib/enrichment.py",
    "lib/songmeta.py",
    "lib/gp2notation.py",        # rewrites manifest.yaml; stamps feedpak_version
    "lib/routers/ws_highway.py", # reads `authors` off a feedpak manifest
]

# Where check_readers_complete() looks for modules READERS may have missed.
READER_SEARCH = ["lib/**/*.py", "server.py"]

# A module is handling a *feedpak* manifest (rather than some other manifest) if
# it shows one of these signals. lib/loosefolder.py and lib/diagnostics_bundle.py
# score zero on all of them, which is what keeps their keys out of the scan.
FEEDPAK_SIGNALS = re.compile(r"import sloppak|from sloppak|load_manifest|manifest\.yaml|feedpak")

# Does this module touch manifest keys at all?
KEY_OPS = re.compile(r"(manifest|mf)\.(get|setdefault)\(|(manifest|mf)\[")

# Locals that hold a manifest dict. The loaders use a uniform idiom
# (`manifest.get("key")`), so binding by name is sufficient today. See
# "Limitations" in docs/feedpak-spec-gate.md for the hardening path.
MANIFEST_VARS = {"manifest", "mf"}

# Packs committed to this repo, checked against the spec's reference validator.
PACK_GLOBS = ["content/starter/*.feedpak", "docs/**/*.sloppak", "docs/**/*.feedpak"]

EXCEPTIONS_FILE = REPO / "feedpak-spec-exceptions.yml"

# How a new manifest key gets into core. There is no in-repo shortcut, by design:
# the spec's own governance says "a change is not part of the format until it
# lands here", and the FEP process is how it lands.
FEP = (
    "A new manifest key must go through the feedpak Enhancement Proposal process "
    "(https://github.com/got-feedback/feedpak-spec/blob/main/CONTRIBUTING.md): land a PR on "
    "feedpak-spec that updates the normative spec, the JSON Schemas, an example, and the "
    "changelog together — then bump .feedpak-spec-ref to the merged SHA in this PR."
)


def _fail(msg: str) -> None:
    print(f"::error::{msg}")


def _is_manifest_receiver(node: ast.expr) -> bool:
    """True when `node` evaluates to a manifest dict.

    Covers the plain `manifest.get(...)` idiom plus the wrapped form used in
    lib/enrichment.py: `(sloppak_mod.load_manifest(p) or {}).get("key")`.
    """
    if isinstance(node, ast.Name) and node.id in MANIFEST_VARS:
        return True
    try:
        src = ast.unparse(node)
    except Exception:
        return False
    return "load_manifest" in src


def keys_touched(path: Path) -> tuple[set[str], set[str]]:
    """Literal top-level manifest keys `path` reads and writes, separately.

    Writes matter as much as reads: `manifest["k"] = v` means core *emits* `k`
    into a pack it ships, so an undeclared key there puts non-spec surface into
    the wild — the same drift, pointed outward. `manifest["k"]` in a subscript
    is a read only when its context is a Load; an `ast.walk` that ignores `ctx`
    would score `manifest["year"] = ...` (lib/songmeta.py) as a read.
    """
    reads: set[str] = set()
    writes: set[str] = set()
    tree = ast.parse(path.read_text(encoding="utf-8"), filename=str(path))
    for node in ast.walk(tree):
        if (
            isinstance(node, ast.Call)
            and isinstance(node.func, ast.Attribute)
            # `setdefault("k", v)` writes k when absent — lib/gp2notation.py
            # stamps feedpak_version that way, and a subscript-only scan misses
            # it entirely, letting an emitted key slip past the gate.
            and node.func.attr in ("get", "setdefault")
            and _is_manifest_receiver(node.func.value)
            and node.args
            and isinstance(node.args[0], ast.Constant)
            and isinstance(node.args[0].value, str)
        ):
            bucket = writes if node.func.attr == "setdefault" else reads
            bucket.add(node.args[0].value)
        elif (
            isinstance(node, ast.Subscript)
            and _is_manifest_receiver(node.value)
            and isinstance(node.slice, ast.Constant)
            and isinstance(node.slice.value, str)
        ):
            target = writes if isinstance(node.ctx, ast.Store) else reads
            target.add(node.slice.value)
    return reads, writes


def _parse_exceptions(text: str, origin: str) -> dict[str, str]:
    """Parse an exceptions document into {key: tracking issue}."""
    import yaml  # runtime dep (PyYAML is already in requirements.txt)

    data = yaml.safe_load(text) or {}
    out: dict[str, str] = {}
    for entry in data.get("exceptions") or []:
        key, issue = entry.get("key"), entry.get("issue")
        if not key or not issue:
            _fail(f"{origin}: every exception needs both 'key' and 'issue'")
            sys.exit(1)
        # A duplicate would silently take the last issue link, quietly retargeting
        # the debt this file exists to track. Fail instead.
        if key in out:
            _fail(
                f"{origin}: '{key}' is listed more than once. "
                f"Keep one entry per key so the tracking issue is unambiguous."
            )
            sys.exit(1)
        out[key] = issue
    return out


def load_exceptions() -> dict[str, str]:
    """Map of grandfathered key -> tracking issue URL, as of this working tree."""
    if not EXCEPTIONS_FILE.exists():
        return {}
    return _parse_exceptions(
        EXCEPTIONS_FILE.read_text(encoding="utf-8"), EXCEPTIONS_FILE.name
    )


def check_allowlist_closed(baseline: Path | None, bootstrap: bool) -> bool:
    """The allowlist is CLOSED: it may shrink, never grow.

    `feedpak-spec-exceptions.yml` grandfathers keys that predate this gate. It is
    not a way to merge a new one. Without this check the gate would be a speed
    bump with a signed excuse note — anyone could append an entry and route
    around the FEP process from inside this repo, which is exactly the drift that
    produced #933.

    So: removing an entry is fine (that's the debt being paid down); adding one
    fails the build, and the error points at the FEP process instead.
    """
    if bootstrap:
        print("  allowlist-closed: bootstrapping (no baseline on the base branch) — skipped")
        return True
    if baseline is None:
        print("  allowlist-closed: no baseline supplied (local run) — skipped")
        return True

    base_keys = set(
        _parse_exceptions(baseline.read_text(encoding="utf-8"), f"{EXCEPTIONS_FILE.name} (base)")
    )
    now_keys = set(load_exceptions())
    added = sorted(now_keys - base_keys)
    removed = sorted(base_keys - now_keys)

    for key in added:
        _fail(
            f"{EXCEPTIONS_FILE.name}: this PR ADDS an exception for '{key}'. The allowlist is "
            f"closed — it grandfathers keys that predate this gate and may only shrink. {FEP}"
        )
    if removed:
        print(f"  allowlist shrank (debt paid down): {', '.join(removed)}")
    print(f"  allowlist-closed: {'FAILED' if added else 'OK'}")
    return not added


def check_readers_complete() -> bool:
    """READERS must not fall behind the codebase.

    The key-coverage scan is only as good as the list of modules it scans, and a
    hand-maintained list rots: `lib/routers/ws_highway.py` and
    `lib/gp2notation.py` both touched feedpak manifests for a while without being
    on it. So re-derive the set — any module that both touches manifest keys and
    shows a feedpak signal must be listed — and fail if one is missing.

    This is a guard on the gate itself, not on the format.
    """
    listed = set(READERS)
    missing: list[str] = []
    for pattern in READER_SEARCH:
        for path in sorted(REPO.glob(pattern)):
            rel = path.relative_to(REPO).as_posix()
            if rel in listed:
                continue
            src = path.read_text(encoding="utf-8", errors="replace")
            if KEY_OPS.search(src) and FEEDPAK_SIGNALS.search(src):
                missing.append(rel)

    for rel in missing:
        _fail(
            f"{rel} touches feedpak manifest keys but is not in READERS "
            f"({Path(__file__).name}) — its keys are going unchecked. Add it."
        )
    print(f"  scanning {len(listed)} modules; readers-complete: {'FAILED' if missing else 'OK'}")
    return not missing


def check_key_coverage(spec: Path) -> bool:
    """Layer 1 — core must not read or write a manifest key the spec does not declare."""
    schema = json.loads((spec / "schemas" / "manifest.schema.json").read_text(encoding="utf-8"))
    declared = set(schema.get("properties") or {})
    if not declared:
        _fail("spec manifest.schema.json declares no properties — wrong path or bad checkout?")
        return False

    reads: set[str] = set()
    writes: set[str] = set()
    for rel in READERS:
        path = REPO / rel
        if not path.exists():
            _fail(f"reader {rel} not found — was it renamed? Update READERS in {Path(__file__).name}.")
            return False
        r, w = keys_touched(path)
        reads |= r
        writes |= w

    exceptions = load_exceptions()
    ok = True

    def _undeclared(keys: set[str]) -> list[str]:
        return sorted((keys - declared) - set(exceptions))

    for key in _undeclared(reads):
        _fail(f"core reads manifest key '{key}', which the feedpak spec does not define. {FEP}")
        ok = False

    for key in _undeclared(writes):
        _fail(
            f"core writes manifest key '{key}', which the feedpak spec does not define — that "
            f"puts non-spec surface into every pack we emit. {FEP}"
        )
        ok = False

    # A stale exception is its own bug: it means the spec caught up and nobody
    # cleaned up, so the allowlist slowly becomes a place drift hides.
    touched = reads | writes
    for key, issue in exceptions.items():
        if key in declared:
            _fail(
                f"'{key}' is listed in {EXCEPTIONS_FILE.name} but the spec now declares it. "
                f"Remove the exception and close {issue}."
            )
            ok = False
        elif key not in touched:
            _fail(
                f"'{key}' is listed in {EXCEPTIONS_FILE.name} but core no longer reads or writes "
                f"it. Remove the exception."
            )
            ok = False

    print(f"  spec declares {len(declared)} keys; core reads {len(reads)}, writes {len(writes)}")
    if exceptions:
        print(f"  grandfathered (tracked debt): {', '.join(sorted(exceptions))}")
    print(f"  key-coverage: {'OK' if ok else 'FAILED'}")
    return ok


def check_forward(spec: Path) -> bool:
    """Layer 3 — core must ingest every example pack the spec ships."""
    examples_dir = spec / "examples"
    if not examples_dir.is_dir():
        _fail(f"{examples_dir} is missing — wrong path or bad checkout?")
        return False
    # rglob, not iterdir: the contract is "every example pack the spec ships", so
    # a pack nested under examples/<group>/ must not slip through.
    #
    # Deliberately NOT filtered by is_file(): a feedpak is dual-form — a zip
    # (`foo.feedpak`) *or* a directory (`foo.feedpak/`) — and the spec's own
    # examples ship as directories today. An is_file() guard here would silently
    # match zero packs. Matching on the suffix covers both forms, and rglob does
    # not smuggle in a pack's innards because files inside a pack don't carry a
    # pack suffix.
    examples = sorted(
        p for p in examples_dir.rglob("*")
        if p.suffix in (".feedpak", ".sloppak")
    )
    if not examples:
        _fail("spec ships no example packs — wrong path or bad checkout?")
        return False

    sys.path.insert(0, str(REPO / "lib"))
    try:
        import sloppak  # noqa: E402  (path must be set first — flat imports, no package)
    except Exception as e:
        _fail(
            f"could not import core's sloppak loader ({type(e).__name__}: {e}). "
            f"Are requirements.txt deps installed?"
        )
        return False

    ok = True
    with tempfile.TemporaryDirectory() as tmp:
        cache = Path(tmp)
        for pack in examples:
            try:
                loaded = sloppak.load_song(pack.name, pack.parent, cache)
            except Exception as e:
                _fail(
                    f"core failed to load the spec's own example pack {pack.name}: "
                    f"{type(e).__name__}: {e}. A spec-valid pack must load."
                )
                ok = False
                continue
            if not loaded.song.arrangements:
                _fail(f"core loaded {pack.name} but found no arrangements")
                ok = False
                continue
            print(f"  loaded {pack.name}: {len(loaded.song.arrangements)} arrangement(s)")
    print(f"  forward: {'OK' if ok else 'FAILED'}")
    return ok


def check_reverse(spec: Path) -> bool:
    """Layer 4 — packs committed here must pass the spec's reference validator."""
    packs = sorted({p for g in PACK_GLOBS for p in REPO.glob(g)})
    if not packs:
        print("  reverse: no committed packs — skipped")
        return True

    proc = subprocess.run(
        [sys.executable, str(spec / "tools" / "validate.py"), *[str(p) for p in packs]],
        capture_output=True,
        text=True,
    )
    sys.stdout.write("".join(f"  {ln}\n" for ln in proc.stdout.splitlines() if ln.strip()))
    if proc.returncode != 0:
        _fail(
            "a pack committed to this repo does not satisfy the feedpak spec "
            "(see the reference validator output above)."
        )
        if proc.stderr.strip():
            sys.stderr.write(proc.stderr)
    print(f"  reverse: {'OK' if proc.returncode == 0 else 'FAILED'}")
    return proc.returncode == 0


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument(
        "--spec",
        required=True,
        type=Path,
        help="path to a feedpak-spec checkout (CI pins the SHA in .feedpak-spec-ref)",
    )
    ap.add_argument(
        "--baseline-exceptions",
        type=Path,
        help="the exceptions file as it exists on the base branch. Supplied by CI so the "
             "allowlist can be proven to have not grown. Omit for a local run.",
    )
    ap.add_argument(
        "--bootstrap-allowlist",
        action="store_true",
        help="the base branch has no exceptions file yet (this PR introduces the gate), so "
             "there is nothing to diff against. CI passes this only in that case.",
    )
    args = ap.parse_args()

    spec = args.spec.resolve()
    if not (spec / "schemas" / "manifest.schema.json").exists():
        _fail(f"{spec} does not look like a feedpak-spec checkout")
        return 1

    print("[1/4] key-coverage — core reads/writes only keys the spec declares")
    # Both run, always: a stale READERS list and an undeclared key are separate
    # failures, and reporting only the first would hide the second. Hence two
    # calls and an explicit `and` over the results, not a short-circuiting one.
    readers_ok = check_readers_complete()
    coverage_ok = check_key_coverage(spec)
    ok1 = readers_ok and coverage_ok
    print("[2/4] allowlist-closed — the grandfather list may shrink, never grow")
    ok2 = check_allowlist_closed(args.baseline_exceptions, args.bootstrap_allowlist)
    print("[3/4] forward — core ingests the spec's example packs")
    ok3 = check_forward(spec)
    print("[4/4] reverse — committed packs satisfy the reference validator")
    ok4 = check_reverse(spec)

    if ok1 and ok2 and ok3 and ok4:
        print("\nfeedpak spec conformance: OK")
        return 0
    print("\nfeedpak spec conformance: FAILED")
    return 1


if __name__ == "__main__":
    sys.exit(main())
