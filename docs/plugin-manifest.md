# `plugin.json` manifest reference

Every plugin lives in `plugins/<name>/` and must declare a `plugin.json` manifest. JSON Schema for this format ships at [`schema/plugin.schema.json`](../schema/plugin.schema.json) and is enforced in CI for in-tree plugins.

## Full example

```json
{
  "id": "my_plugin",
  "name": "My Plugin",
  "version": "1.0.0",
  "private": false,
  "standards": ["capability-pipelines.v1", "plugin-runtime-idempotent.v1"],
  "type": "visualization",
  "nav": { "label": "My Plugin", "screen": "plugin-my_plugin" },
  "screen": "screen.html",
  "script": "screen.js",
  "styles": "assets/plugin.css",
  "routes": "routes.py",
  "settings": {
    "html": "settings.html",
    "server_files": ["my_plugin.db", "my_plugin_models/"]
  },
  "diagnostics": {
    "server_files": ["my_plugin.diag.json"],
    "callable": "diagnostics:collect"
  },
  "settings_schema": {
    "schema_version": "1",
    "packable_keys": ["enabled"]
  },
  "ui": {
    "settings": [{ "id": "my-plugin-settings", "region": "plugin-settings", "label": "My Plugin" }]
  },
  "capabilities": {
    "library": {
      "roles": ["provider"],
      "operations": ["query-page", "query-artists", "query-stats"],
      "mode": "active",
      "compatibility": "none",
      "ownership": "multi-provider",
      "safety": "safe",
      "version": 1
    }
  }
}
```

All fields except `id` and `name` are optional. Plugins can have any combination of frontend (screen/script), backend (routes), and settings.

## Fields

### `id` (required, string)

Snake-case identifier. Used to namespace `localStorage` keys, build the plugin's screen id (`plugin-<id>`), namespace the backend logger (`slopsmith.plugin.<id>`), and as the directory name in diagnostics bundles. Cannot contain slashes, dots are encoded by the sibling-import loader (see [plugin-sibling-imports.md](plugin-sibling-imports.md)).

### `name` (required, string)

Human-readable name shown in UI surfaces.

### `version` (string, optional)

Plain semver string. Advisory only — the plugin loader does not consume this. Plugins commonly include it for publishing/tooling purposes.

### `private` (boolean, optional)

Advisory metadata for plugin authors. Not consumed by the loader.

### `standards` (string[], optional)

Versioned contracts the plugin participates in. New capability-aware plugins should declare `"capability-pipelines.v1"` when they include native `capabilities`, `ui`, `runtime_domains`, or related metadata.

Declare `"plugin-runtime-idempotent.v1"` only when repeated script hydration cannot duplicate wrappers, listeners, timers, DOM roots, diagnostics contributors, jobs, media nodes, or capability participants.

### `capability_api` (object, optional)

Explicit capability API marker. Most plugins can use the compact `standards` form instead:

```json
{ "capability_api": { "standard": "capability-pipelines.v1", "version": 1 } }
```

### `type` (string, optional — role hint, slopsmith#36)

Supported values:
- `"visualization"` — plugin provides a highway renderer. Declaring this makes the plugin eligible for the main-player viz picker AND splitscreen's per-panel picker. Must pair with a `window.slopsmithViz_<id>` factory exporting the setRenderer contract (see [plugin-visualization-contracts.md](plugin-visualization-contracts.md)).
- Absent → no declared role; plugin is loaded and its script runs, but it doesn't appear in role-specific UIs.

### `nav` (object, optional)

`{ "label": string, "screen": string }` — adds a navbar entry that calls `showScreen(<screen>)`. `screen` is typically `plugin-<id>`.

### `screen` (string, optional)

Path to HTML file (relative to plugin dir). Mounted at `#plugin-<id>` in the SPA.

### `script` (string, optional)

Path to JS file (relative to plugin dir). Loaded via `<script>` tag in global scope. Wrap in an IIFE.

### `styles` (string, optional)

Path to a plugin-owned compiled stylesheet under `assets/`, for example `"assets/plugin.css"`. Use this when a plugin ships Tailwind utilities that core's prebuilt stylesheet cannot know about, especially arbitrary-value classes in runtime-installed plugins. The stylesheet must be built ahead of time with Tailwind `preflight: false`; Slopsmith injects one versioned `<link>` for the plugin. See [plugin-styles.md](plugin-styles.md).

### `routes` (string, optional)

Path to Python file exporting `setup(app, context)`. See "Backend routes" below.

### `settings` (object, optional)

`{ "html": string, "server_files": string[] }`

- **`settings.html`** — settings-panel HTML.
- **`settings.server_files`** — **opt-in** for the unified Settings export/import flow (slopsmith#113). List of relpaths under `context["config_dir"]` that the plugin wants included in user-triggered backups. A trailing `/` denotes a directory (recurse).

  Rules:
  - Relpaths only. Absolute paths, drive letters, `..` segments, and backslashes are rejected at load time with a `[Plugin]` warning.
  - The same allowlist is consulted at both export and import: a bundle that references a file the *importing host*'s manifest no longer declares is skipped with a warning (handles plugin updates between export and import). A bundle that references a file your host's manifest never declared is also skipped — no surprise writes.
  - Files are encoded as `{"encoding": "json", "data": <parsed>}` for `.json` files that parse cleanly (diff-friendly), `{"encoding": "base64", "data": "..."}` otherwise (sqlite, model blobs, IRs).
  - Plugins own their internal data migration. Importing a bundle whose data schema predates your current code restores bytes verbatim — your plugin must cope at next load.
  - Symlinks are skipped on export and never followed on import.

  Plugins that omit this field have no server-side files exported; their state lives entirely in browser `localStorage`, which is bundled wholesale on every export.

### `diagnostics` (object, optional)

`{ "server_files": string[], "callable": string }`

**Opt-in** for the troubleshooting bundle (slopsmith#166 — Settings → Export Diagnostics). Two independent fields:

- **`diagnostics.server_files`** — same allowlist semantics as `settings.server_files`: relpaths under `context["config_dir"]`, no `..`, no abs paths, no backslashes, no leading dots. Files listed here are copied verbatim into `plugins/<plugin_id>/<relpath>` inside the bundle. Use this for snapshot-style state (small DB excerpts, model lists, last-error files).
- **`diagnostics.callable`** — `"<module>:<function>"` (e.g. `"diagnostics:collect"`). Resolved lazily via `load_sibling` when the user clicks Export, then called as `func({"plugin_id": "...", "config_dir": Path(...)})`. Return `dict`/`list` → written to `plugins/<id>/callable.json`; `bytes` → `callable.bin`; `str` → `callable.txt`. Exceptions are caught and appended to the bundle's `manifest.notes` — a buggy plugin never crashes the export.

See [plugin-diagnostics.md](plugin-diagnostics.md) for full diagnostics integration patterns.

### `settings_schema` (object, optional)

Redaction-safe settings metadata for support tooling and capability diagnostics. Use this to describe schema/version and packable key names; do not store user settings values, paths, tokens, or plugin-private payloads here.

### `ui` / `ui_contributions` (object, optional)

Native UI contribution declarations keyed by UI domain or surface. These let Slopsmith attribute plugin UI to stable contribution records while legacy `nav`, `screen`, `settings`, visualization picker entries, shortcuts, overlays, player panels, and tours continue to work through compatibility bridges.

Example:

```json
{
  "ui": {
    "settings": [{ "id": "my-plugin-settings", "region": "plugin-settings", "label": "My Plugin" }],
    "ui.player-overlays": [{ "id": "my-plugin-overlay", "region": "player.overlays.highway", "label": "My Overlay" }]
  }
}
```

Contribution ids must be stable and unique per plugin. Keep metadata redaction-safe: no settings values, DOM handles, local paths, callbacks, or private payloads.

### `capabilities` (object, optional)

Native `capability-pipelines.v1` declarations keyed by capability domain. They describe what the plugin owns, provides, requests, observes, or emits before the runtime script hydrates.

```json
{
  "standards": ["capability-pipelines.v1"],
  "capabilities": {
    "library": {
      "roles": ["provider"],
      "operations": ["query-page", "query-artists", "query-stats", "tuning-names", "get-art", "sync-song"],
      "description": "Adds a browsable library source.",
      "mode": "active",
      "compatibility": "none",
      "ownership": "multi-provider",
      "safety": "safe",
      "version": 1
    },
    "playback": {
      "roles": ["observer"],
      "observes": ["loading", "ready", "stopped", "ended"],
      "description": "Observes playback lifecycle without wrapping window.playSong.",
      "mode": "active",
      "compatibility": "shim-allowed",
      "ownership": "observer-only",
      "safety": "safe",
      "version": 1
    }
  }
}
```

Supported declaration fields include:

- `roles`: `owner`, `coordinator`, `provider`, `observer`, `requester`, `transformer`, `handler`, `validator`, `short-circuiter`, `contributor`
- `commands`, `operations`, `requests`, `observes`, `emits`, `events`: string arrays naming public commands, provider operations, or events
- `kind`: `command`, `provider-coordinator`, `event`, `diagnostic`, `privileged`
- `mode`: `active`, `optional`, `legacy-shim`, `disabled`
- `compatibility`: `none`, `shim-allowed`, `degrade-noop`, `required`, `legacy-window-shim`
- `ownership`: `exclusive-owner`, `multi-provider`, `observer-only`, `requester-only`, `privileged`, `diagnostic-only`
- `safety`: `safe`, `privileged`, `sensitive`, `diagnostic-only`
- `description` / `summary`: short redaction-safe text for local tooling
- `version`: `1`

Invalid capability metadata is rejected by schema validation and ignored by runtime capability tooling; legacy plugin fields still load through their existing app paths.

### `runtime_domains` / `domains` (object, optional)

Legacy bridge declarations for older runtime-domain metadata. Prefer `capabilities` for new native declarations.

### `license` (string, optional but recommended)

SPDX identifier. For curated plugins, must be AGPL-3.0-or-later or AGPL-compatible (MIT, BSD-2-Clause, BSD-3-Clause, Apache-2.0). See [CONTRIBUTING.md](../CONTRIBUTING.md).

## Backend routes — `setup(app, context)`

`routes.py` must export `setup(app, context)`. The `context` dict provides:

- `config_dir` — persistent config path (`Path`)
- `get_dlc_dir()` — returns the DLC folder `Path`
- `extract_meta()` — metadata extraction callable
- `meta_db` — shared `MetadataDB` instance
- `get_sloppak_cache_dir()` — sloppak cache `Path`
- `load_sibling(name)` — loads a sibling module from this plugin's directory under a unique, namespaced module name. See [plugin-sibling-imports.md](plugin-sibling-imports.md).
- `log` — stdlib `logging.Logger` namespaced to `slopsmith.plugin.<id>`. Pre-configured with the app-wide level, format (including JSON mode), and correlation IDs. Use this for all backend plugin output instead of `print()`. See [plugin-logging.md](plugin-logging.md).

Example:

```python
def setup(app, context):
    log = context["log"]
    extractor = context["load_sibling"]("extractor")

    @app.get("/api/my_plugin/status")
    def status():
        return {"ready": True}

    log.info("my_plugin ready")
```

## Validation

Run the local validator skill `/plugin-validate` (Claude Code) or the CI workflow `.github/workflows/validate-plugins.yml`. Both consume [`schema/plugin.schema.json`](../schema/plugin.schema.json), including capability-pipelines metadata.

## Related

- [PLUGIN_AUTHORING.md](PLUGIN_AUTHORING.md) — guide index
- [plugin-logging.md](plugin-logging.md) — `context["log"]` pattern
- [plugin-sibling-imports.md](plugin-sibling-imports.md) — `load_sibling`
- [plugin-diagnostics.md](plugin-diagnostics.md) — diagnostics opt-in details
- [diagnostics-bundle-spec.md](diagnostics-bundle-spec.md) — full diagnostics bundle layout
