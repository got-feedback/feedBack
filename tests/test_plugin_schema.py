"""Plugin manifest schema sanity tests.

Three independent guarantees:

1. `schema/plugin.schema.json` is itself a well-formed JSON Schema
   (Draft 2020-12) and accepts every in-tree `plugins/*/plugin.json`.
2. Each in-tree manifest's `id` matches its parent directory name —
   the loader assumes this and silent drift would break plugin
   discovery.
3. The `license` enum in the schema is a subset of the SPDX identifiers
   listed in `CONTRIBUTING.md`'s "Plugin licensing" curated allowlist.
   If you edit the allowlist in `CONTRIBUTING.md`, run pytest locally
   and update the schema enum to match — these two files must stay in
   sync because the same allowlist is referenced from both human-facing
   docs and from CI manifest validation.
"""

from __future__ import annotations

import glob
import json
import re
from pathlib import Path

import jsonschema
import pytest


REPO_ROOT = Path(__file__).resolve().parent.parent
SCHEMA_PATH = REPO_ROOT / "schema" / "plugin.schema.json"
CONTRIBUTING_PATH = REPO_ROOT / "CONTRIBUTING.md"
PLUGINS_GLOB = str(REPO_ROOT / "plugins" / "*" / "plugin.json")


@pytest.fixture(scope="module")
def schema() -> dict:
    with SCHEMA_PATH.open() as f:
        return json.load(f)


def test_schema_is_well_formed(schema: dict) -> None:
    """The schema file must itself validate as a Draft 2020-12 schema."""
    jsonschema.Draft202012Validator.check_schema(schema)


@pytest.mark.parametrize("manifest_path", sorted(glob.glob(PLUGINS_GLOB)))
def test_in_tree_manifest_validates(manifest_path: str, schema: dict) -> None:
    """Every plugin.json under plugins/ must pass schema validation."""
    with open(manifest_path) as f:
        manifest = json.load(f)
    jsonschema.validate(manifest, schema)


@pytest.mark.parametrize("manifest_path", sorted(glob.glob(PLUGINS_GLOB)))
def test_in_tree_manifest_id_matches_directory(manifest_path: str) -> None:
    """The `id` field must match the parent directory name."""
    with open(manifest_path) as f:
        manifest = json.load(f)
    expected = Path(manifest_path).parent.name
    assert manifest["id"] == expected, (
        f"Plugin id {manifest['id']!r} in {manifest_path} does not match "
        f"directory name {expected!r}. The loader keys plugin lookup by "
        f"directory; drift would silently break discovery."
    )


def _extract_allowlist_from_contributing() -> set[str]:
    """Pull the curated-license allowlist out of CONTRIBUTING.md.

    Looks at the "Plugin licensing" section: any bullet line whose text
    starts with a recognized SPDX-shape identifier is considered part of
    the allowlist. Forms like "AGPL-3.0-only or AGPL-3.0-or-later" are
    split on " or ".
    """
    text = CONTRIBUTING_PATH.read_text(encoding="utf-8")
    section = text.split("## Plugin licensing", 1)
    if len(section) < 2:
        pytest.fail("'## Plugin licensing' section not found in CONTRIBUTING.md")
    body = section[1].split("\n## ", 1)[0]

    spdx_re = re.compile(r"^[A-Za-z0-9.+-]+$")
    allowlist: set[str] = set()
    for line in body.splitlines():
        if not line.lstrip().startswith("- "):
            continue
        rest = line.lstrip()[2:].strip()
        # Strip trailing punctuation / parenthetical notes.
        rest = re.split(r"\s*\(|\s*—|\s*--", rest)[0].strip().rstrip(".,;")
        for token in re.split(r"\s+or\s+|\s*/\s+|\s*,\s+", rest):
            token = token.strip().rstrip(".,;").strip()
            if token and spdx_re.match(token):
                allowlist.add(token)
    return allowlist


def test_schema_license_enum_subset_of_contributing_allowlist(schema: dict) -> None:
    """Schema's license enum must be ⊆ CONTRIBUTING.md curated allowlist.

    If you add a license to the schema enum, also list it in
    CONTRIBUTING.md "Plugin licensing". Direction matters: schema ⊆
    allowlist (the schema can be stricter than what CONTRIBUTING.md
    documents — typically the schema *equals* the allowlist).
    """
    license_enum = set(schema["properties"]["license"]["enum"])
    allowlist = _extract_allowlist_from_contributing()
    missing = license_enum - allowlist
    assert not missing, (
        f"License enum values present in schema/plugin.schema.json but "
        f"not listed in CONTRIBUTING.md 'Plugin licensing' section: {sorted(missing)}. "
        f"Update CONTRIBUTING.md or remove from the schema enum."
    )
