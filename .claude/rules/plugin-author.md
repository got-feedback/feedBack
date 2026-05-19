---
name: plugin-author
description: Rules that apply when editing files under plugins/**. Enforces the plugin contracts documented in docs/PLUGIN_AUTHORING.md.
globs:
  - "plugins/**"
---

# Plugin authoring rules

These rules apply only when editing files under `plugins/**`. They encode the contracts described in [`docs/PLUGIN_AUTHORING.md`](../../docs/PLUGIN_AUTHORING.md) so AI suggestions don't drift from them.

## Manifest

- **`plugin.json` is required** and must validate against [`schema/plugin.schema.json`](../../schema/plugin.schema.json). Required fields: `id`, `name`. The `id` must match the parent directory name (the loader keys discovery by directory; drift breaks plugin lookup).
- **License must come from the curated allowlist** if the plugin is intended for the curated list. See [`CONTRIBUTING.md`](../../CONTRIBUTING.md) "Plugin licensing".
- **`type: "visualization"`** requires a `script` field exporting `window.slopsmithViz_<id>`. See [`docs/plugin-visualization-contracts.md`](../../docs/plugin-visualization-contracts.md).

## Backend (`routes.py`)

- **Use `context["log"]`, never `print()` or `traceback.print_exc()`.** The CI workflow blocks `print(` and `traceback.print_exc(` in `server.py` / `lib/`; plugin code should follow the same rule. The provided logger is a stdlib `logging.Logger` namespaced to `slopsmith.plugin.<id>` with correlation IDs, JSON mode, and rotation already wired. See [`docs/plugin-logging.md`](../../docs/plugin-logging.md).
- **Multi-file plugins must use `context["load_sibling"]("<module>")`**, not bare `from <module> import X`. Two plugins shipping a same-named helper collide via `sys.modules`. See [`docs/plugin-sibling-imports.md`](../../docs/plugin-sibling-imports.md).
- **`setup(app, context)` is the required entry.** Don't run side effects at import time.

## Frontend (`screen.js`)

- **Wrap in an IIFE** — `(function () { 'use strict'; ... })();`. Frontend scripts share global scope; leaking variables collides with other plugins.
- **Hook `window.playSong` carefully** — always call the original, always `await` it. Wrappers run outermost-first; awaiting yields to the event loop and WebSocket messages can arrive before the outer wrapper finishes setup. Use `highway.getSongInfo()` as a fallback rather than relying solely on `_onReady`.
- **Hook `window.showScreen`** — clean up your plugin's state when the user leaves the player screen.
- **Use `window.slopsmith.emit` / `on`** for cross-plugin communication. Don't poll other plugins' globals.
- **Register shortcuts with `window.registerShortcut({ key, scope, handler })`** and clean up with `window.unregisterShortcut(key, scope)` — pass the same scope you registered with (default `'global'` won't match `'player'` / `'plugin-*'`). For panel-scoped registries, prefer `panel.clearShortcuts()`. See [`docs/plugin-keyboard-shortcuts.md`](../../docs/plugin-keyboard-shortcuts.md).

## State and config

- **`localStorage` keys must be prefixed with the plugin id** to avoid collisions.
- **`settings.server_files` declares config-dir paths the plugin wants included in the Settings export/import flow.** Relpaths only — no `..`, no abs paths, no backslashes. See [`docs/plugin-manifest.md`](../../docs/plugin-manifest.md).
- **`diagnostics.server_files` / `diagnostics.callable`** declares what enters the Export Diagnostics bundle. Keep payloads under 100 KB and don't include secrets. See [`docs/plugin-diagnostics.md`](../../docs/plugin-diagnostics.md).

## Visualization specifics

When `plugin.json` declares `"type": "visualization"`:

- **Factory must be `window.slopsmithViz_<id>`** where `<id>` matches `plugin.json`.
- **Factory must return a fresh object on each call** — splitscreen creates N instances.
- **The renderer owns its `getContext()` call.** Declare `contextType: '2d'` or `'webgl2'` on the returned object so the highway can swap the canvas element when needed (`getContext` is one-shot per canvas).
- **`draw(bundle)` receives difficulty-filtered arrays** — never read from `_filteredNotes` or other internals.

See [`docs/plugin-visualization-contracts.md`](../../docs/plugin-visualization-contracts.md) for the full lifecycle and the Overlay + Note-state-provider contracts.

## Testing

When changing plugin internals, add or update a test under `tests/` (Python) or `tests/js/` (Node) or `tests/browser/` (Playwright). See [`docs/testing-plugins.md`](../../docs/testing-plugins.md) for fixtures (`isolate_logging`, `reset_plugin_state`).
