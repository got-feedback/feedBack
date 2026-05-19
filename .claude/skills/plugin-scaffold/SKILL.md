---
name: plugin-scaffold
description: Scaffold a new Slopsmith plugin skeleton. USE WHEN the user asks to create a new plugin, scaffold a plugin, bootstrap a plugin, new visualization plugin, new overlay plugin, new settings-only plugin, plugin starter, plugin skeleton. Args needed - plugin slug (snake_case) and type (visualization / overlay / settings-only / routes-only). Generates plugins/<id>/ with plugin.json, screen.js, and optional routes.py / settings.html / Playwright test stub matching the requested type.
---

# plugin-scaffold

Generates a minimum-viable Slopsmith plugin skeleton matching a requested shape. The output validates against [`schema/plugin.schema.json`](../../../schema/plugin.schema.json).

## When to invoke

The user says one of:
- "scaffold a new plugin called X"
- "create a visualization plugin"
- "new overlay plugin"
- "plugin starter for settings"
- "bootstrap a routes-only plugin"

If the plugin slug or type is missing, ask once.

## Inputs

| Arg | Required | Values | Notes |
|---|---|---|---|
| `id` | yes | snake_case | Becomes plugin's `id` field and directory name |
| `name` | optional | string | Defaults to title-case of `id` |
| `type` | yes | `visualization` / `overlay` / `settings-only` / `routes-only` | Determines which files get scaffolded |

## What to generate

**Common to all types:**

- `plugins/<id>/plugin.json` — minimum schema-valid manifest. Set `id`, `name`, `version: "0.1.0"`, and `license: "AGPL-3.0-only"` by default (ask if a different license is desired).

**`type=visualization`** — adds:
- `"type": "visualization"` and `"script": "screen.js"` to manifest
- `screen.js` exporting `window.slopsmithViz_<id> = function () { return { contextType: '2d', init(canvas, bundle) { this.ctx = canvas.getContext('2d'); }, draw(bundle) { /* TODO */ }, destroy() {} }; };` plus a static `matchesArrangement` example commented out
- `tests/browser/<id>.spec.ts` — Playwright stub that loads the app and asserts the plugin's factory is registered

**`type=overlay`** — adds:
- `"script": "screen.js"` to manifest (no `type` declared — overlays don't use the picker)
- `screen.js` scaffolding a navbar toggle, an own-canvas + own-rAF loop reading `highway.getNotes()` / `getChords()` / `getTime()`, and respecting `highway.isDefaultRenderer()` if using `highway.project` / `fretX`
- `tests/browser/<id>.spec.ts` — toggle on / off test

**`type=settings-only`** — adds:
- `"settings": { "html": "settings.html" }` to manifest
- `settings.html` — empty form skeleton with explanatory comments
- `screen.js` reading/writing `localStorage` keys prefixed with `<id>_`

**`type=routes-only`** — adds:
- `"routes": "routes.py"` to manifest
- `routes.py` with `def setup(app, context):` that registers one example route and uses `context["log"].info("plugin ready")` (never `print()`)
- `tests/test_<id>_routes.py` — FastAPI TestClient stub

## After scaffolding

Run validation locally:

```bash
python -c "import json,jsonschema; s=json.load(open('schema/plugin.schema.json')); jsonschema.validate(json.load(open('plugins/<id>/plugin.json')), s); print('OK')"
```

Then point the user at [`docs/PLUGIN_AUTHORING.md`](../../../docs/PLUGIN_AUTHORING.md) and the relevant contract doc for the type they chose.

## Don'ts

- Don't add fields to the manifest that aren't in the schema. If the user wants something custom, ask whether it should become a real field — that's a `schema/plugin.schema.json` change, not a plugin-local convention.
- Don't scaffold a `requirements.txt` without confirming the deps. The plugin loader installs them on first load; an accidental dep slows everyone's startup.
- Don't pre-fill `localStorage` keys without a prefix. Collisions across plugins are real.
- Don't generate hidden side effects at import time (`screen.js` top level or `routes.py` top level). Keep all wiring inside the IIFE / `setup()`.

## Verification

The scaffolded plugin should pass:

```bash
pytest tests/test_plugin_schema.py::test_in_tree_manifest_validates -v
pytest tests/test_plugin_schema.py::test_in_tree_manifest_id_matches_directory -v
```
