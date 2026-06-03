"""Plugin manifest schema sanity tests.

Four independent guarantees:

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
4. The schema accepts capability-pipelines.v1 manifest metadata so
    native capability declarations are not blocked by legacy-only tooling.
"""

from __future__ import annotations

import ast
import glob
import json
import re
from pathlib import Path

import jsonschema
import pytest


REPO_ROOT = Path(__file__).resolve().parent.parent
SCHEMA_PATH = REPO_ROOT / "schema" / "plugin.schema.json"
DOCS_SCHEMA_PATH = REPO_ROOT / "docs" / "plugin-manifest.schema.json"
CONTRIBUTING_PATH = REPO_ROOT / "CONTRIBUTING.md"
PLUGINS_GLOB = str(REPO_ROOT / "plugins" / "*" / "plugin.json")
BACKEND_CAPABILITIES_PATH = REPO_ROOT / "plugins" / "__init__.py"
FRONTEND_CAPABILITIES_PATH = REPO_ROOT / "static" / "capabilities.js"


@pytest.fixture(scope="module")
def schema() -> dict:
    with SCHEMA_PATH.open() as f:
        return json.load(f)


@pytest.fixture(scope="module")
def docs_schema() -> dict:
    with DOCS_SCHEMA_PATH.open() as f:
        return json.load(f)


def test_schema_is_well_formed(schema: dict) -> None:
    """The schema file must itself validate as a Draft 2020-12 schema."""
    jsonschema.Draft202012Validator.check_schema(schema)


def test_schema_contains_capability_contract(schema: dict) -> None:
    """The published schema must keep capability-pipelines.v1 fields first-class."""
    assert schema["properties"]["standards"]["items"]["type"] == "string"
    assert schema["properties"]["capabilities"]["additionalProperties"]["$ref"] == "#/$defs/capabilityDeclaration"
    declaration = schema["$defs"]["capabilityDeclaration"]
    assert "owner" in declaration["properties"]["roles"]["items"]["enum"]
    assert "provider-coordinator" in declaration["properties"]["kind"]["enum"]
    assert declaration["properties"]["operations"]["items"]["type"] == "string"
    assert declaration["properties"]["requests"]["items"]["type"] == "string"
    assert declaration["properties"]["observes"]["items"]["type"] == "string"
    assert "exclusive-owner" in declaration["properties"]["ownership"]["enum"]
    assert "diagnostic-only" in declaration["properties"]["safety"]["enum"]
    assert "styles" in schema["properties"]
    assert schema["properties"]["styles"]["pattern"].startswith("^assets/")


def test_docs_schema_capability_contract_matches_ci_schema(schema: dict, docs_schema: dict) -> None:
    """The docs copy and CI schema must not drift on capability vocabulary."""
    def without_descriptions(value):
        if isinstance(value, dict):
            return {key: without_descriptions(item) for key, item in value.items() if key != "description"}
        if isinstance(value, list):
            return [without_descriptions(item) for item in value]
        return value

    for key in ("standards", "capability_api", "capabilities", "ui", "ui_contributions", "runtime_domains", "domains", "settings_schema", "styles"):
        assert without_descriptions(docs_schema["properties"][key]) == without_descriptions(schema["properties"][key])
    assert without_descriptions(docs_schema["$defs"]["domainName"]) == without_descriptions(schema["$defs"]["domainName"])
    assert without_descriptions(docs_schema["$defs"]["capabilityDeclaration"]) == without_descriptions(schema["$defs"]["capabilityDeclaration"])
    assert without_descriptions(docs_schema["$defs"]["domainDeclaration"]) == without_descriptions(schema["$defs"]["domainDeclaration"])
    assert without_descriptions(docs_schema["$defs"]["contributionList"]) == without_descriptions(schema["$defs"]["contributionList"])


def _python_constant_set(name: str) -> set[str]:
    module = ast.parse(BACKEND_CAPABILITIES_PATH.read_text(encoding="utf-8"))
    for node in module.body:
        if isinstance(node, ast.Assign) and any(isinstance(target, ast.Name) and target.id == name for target in node.targets):
            value = ast.literal_eval(node.value)
            return set(value)
    pytest.fail(f"Backend capability constant {name} not found")


def _frontend_constant_set(name: str) -> set[str]:
    text = FRONTEND_CAPABILITIES_PATH.read_text(encoding="utf-8")
    match = re.search(rf"const\s+{re.escape(name)}\s*=\s*new\s+Set\(\s*\[(.*?)\]\s*\)", text, re.S)
    if not match:
        pytest.fail(f"Frontend capability constant {name} not found")
    return set(re.findall(r"['\"]([^'\"]+)['\"]", match.group(1)))


def test_capability_schema_vocabulary_matches_runtime_constants(schema: dict) -> None:
    """Schema enums should evolve with backend and frontend capability validators."""
    declaration = schema["$defs"]["capabilityDeclaration"]["properties"]
    checks = [
        (set(declaration["roles"]["items"]["enum"]), "_VALID_CAPABILITY_ROLES", "VALID_ROLES"),
        (set(declaration["mode"]["enum"]), "_VALID_CAPABILITY_MODES", "VALID_MODES"),
        (set(declaration["compatibility"]["enum"]), "_VALID_CAPABILITY_COMPATIBILITY", "VALID_COMPATIBILITY"),
        (set(declaration["ownership"]["enum"]), "_VALID_CAPABILITY_OWNERSHIP", "VALID_OWNERSHIP"),
        (set(declaration["kind"]["enum"]), "_VALID_CAPABILITY_KINDS", "VALID_DOMAIN_KINDS"),
        (set(declaration["safety"]["enum"]), "_VALID_CAPABILITY_SAFETY", "VALID_SAFETY"),
    ]
    for schema_values, backend_name, frontend_name in checks:
        assert schema_values == _python_constant_set(backend_name)
        assert schema_values == _frontend_constant_set(frontend_name)


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


def test_capability_manifest_metadata_validates(schema: dict) -> None:
    """Capability-aware manifests should validate alongside legacy plugin fields."""
    manifest = {
        "id": "capability_example",
        "name": "Capability Example",
        "version": "0.1.0",
        "standards": ["capability-pipelines.v1", "plugin-runtime-idempotent.v1"],
        "script": "screen.js",
        "settings": {"html": "settings.html"},
        "settings_schema": {
            "schema_version": "1",
            "packable_keys": ["enabled"],
        },
        "ui": {
            "settings": [{"id": "capability-example-settings", "region": "plugin-settings", "label": "Capability Example"}],
        },
        "capabilities": {
            "library": {
                "roles": ["provider"],
                "kind": "provider-coordinator",
                "operations": ["query-page", "query-artists", "query-stats"],
                "description": "Provides a browsable library source.",
                "mode": "active",
                "compatibility": "none",
                "ownership": "multi-provider",
                "safety": "safe",
                "version": 1,
            },
            "playback": {
                "roles": ["observer"],
                "observes": ["ready", "stopped"],
                "mode": "active",
                "compatibility": "shim-allowed",
                "ownership": "observer-only",
                "safety": "safe",
                "version": 1,
            },
        },
    }
    jsonschema.validate(manifest, schema)


def test_current_capability_and_styles_manifests_validate(schema: dict) -> None:
    """Validate real manifests that exercise the capability and styles surfaces."""
    for relpath in [
        "plugins/capability_inspector/plugin.json",
        "plugins/highway_3d/plugin.json",
    ]:
        with (REPO_ROOT / relpath).open() as f:
            jsonschema.validate(json.load(f), schema)


def test_invalid_capability_metadata_fails_schema(schema: dict) -> None:
    """Schema validation should still catch malformed native declarations."""
    manifest = {
        "id": "bad_capability_example",
        "name": "Bad Capability Example",
        "standards": ["capability-pipelines.v1"],
        "capabilities": {
            "library": {
                "roles": ["admin"],
                "mode": "active",
                "compatibility": "none",
                "safety": "safe",
                "version": 1,
            },
        },
    }
    with pytest.raises(jsonschema.ValidationError):
        jsonschema.validate(manifest, schema)


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
