---
name: plugin-validate
description: Validate a Slopsmith plugin's plugin.json against the schema and run structural checks. USE WHEN the user asks to validate a plugin, check the manifest, plugin.json errors, lint plugin, verify plugin structure, plugin license check, or audit plugin contract. Runs JSON Schema validation, file-existence checks for declared script/routes/settings.html/tour paths, and license-allowlist check.
---

# plugin-validate

Runs the same checks `.github/workflows/validate-plugins.yml` + `tests/test_plugin_schema.py` run in CI, but **locally and instantly** — useful for catching errors before push.

## When to invoke

The user says one of:
- "validate plugins/<id>"
- "check the manifest for X"
- "lint this plugin"
- "verify my plugin.json"
- "plugin license check"

Works on either a specific plugin (e.g. `plugins/highway_3d/`) or all in-tree plugins if none is specified.

## What to run

```bash
# All in-tree plugins (default)
python <<'PY'
import json, glob, sys, jsonschema, pathlib
schema = json.load(open('schema/plugin.schema.json'))
jsonschema.Draft202012Validator.check_schema(schema)
ok = True
for path in sorted(glob.glob('plugins/*/plugin.json')):
    plugin_dir = pathlib.Path(path).parent
    plugin_id = plugin_dir.name
    m = json.load(open(path))
    # 1. Schema
    try:
        jsonschema.validate(m, schema)
    except jsonschema.ValidationError as e:
        print(f"FAIL {path}: {e.message} (at {list(e.absolute_path)})")
        ok = False
        continue
    # 2. id == directory name
    if m['id'] != plugin_id:
        print(f"FAIL {path}: id={m['id']!r} but directory is {plugin_id!r}")
        ok = False
    # 3. Declared files exist
    for field in ('script', 'routes', 'tour'):
        if field in m and not (plugin_dir / m[field]).exists():
            print(f"FAIL {path}: {field}={m[field]!r} but file missing")
            ok = False
    if 'settings' in m and 'html' in m['settings']:
        h = m['settings']['html']
        if not (plugin_dir / h).exists():
            print(f"FAIL {path}: settings.html={h!r} but file missing")
            ok = False
    for field in ('settings', 'diagnostics'):
        if field in m and 'server_files' in m[field]:
            for relpath in m[field]['server_files']:
                # server_files paths live under context["config_dir"], NOT the
                # plugin dir, so we don't existence-check them here. We only
                # confirm the path *looks* safe (already enforced by schema).
                if '..' in relpath or relpath.startswith('/') or '\\' in relpath:
                    print(f"FAIL {path}: {field}.server_files contains unsafe path {relpath!r}")
                    ok = False
    print(f"OK   {path}")
sys.exit(0 if ok else 1)
PY
```

## Targeted invocation

If the user names a specific plugin, swap the glob for `plugins/<id>/plugin.json` and report on just that one.

## License-allowlist check

If the user specifically asks for a license check (or the plugin declares `license` in `plugin.json`), additionally run:

```bash
pytest tests/test_plugin_schema.py::test_schema_license_enum_subset_of_contributing_allowlist -v --noconftest
```

(or skip `--noconftest` if `structlog` is installed locally).

## Output

Use the format from the script: `OK <path>` per validated manifest, `FAIL <path>: <reason>` per failure. Add a one-line summary:

```
Result: 3/3 plugins valid (OK app_tour_library, app_tour_settings, highway_3d)
```

or

```
Result: 2/3 plugins valid; 1 FAIL (see above)
```

## Related

- [`schema/plugin.schema.json`](../../../schema/plugin.schema.json)
- [`tests/test_plugin_schema.py`](../../../tests/test_plugin_schema.py)
- [`.github/workflows/validate-plugins.yml`](../../../.github/workflows/validate-plugins.yml)
- [`docs/plugin-manifest.md`](../../../docs/plugin-manifest.md)
