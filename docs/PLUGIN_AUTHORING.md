# Plugin Authoring Guide

Slopsmith's plugin system is the primary extension point. Each plugin lives in `plugins/<name>/` with a `plugin.json` manifest and can provide any combination of frontend (HTML/JS), backend (Python routes), settings UI, diagnostics, and visualization renderers.

This guide is the entry point. Each topic below has a dedicated doc — read what's relevant to what you're building.

## Quickstart

```text
plugins/my_plugin/
├── plugin.json          Manifest (required) — see docs/plugin-manifest.md
├── screen.html          Optional — markup mounted at #plugin-my_plugin
├── screen.js            Optional — runs in global scope on page load
├── routes.py            Optional — exports setup(app, context)
├── settings.html        Optional — settings-panel HTML
└── requirements.txt     Optional — pip deps auto-installed on load
```

The minimum viable plugin is a `plugin.json` with just `id` and `name`. Everything else is opt-in.

```json
{
  "id": "my_plugin",
  "name": "My Plugin",
  "version": "0.1.0"
}
```

Capability-aware plugins should also declare the `capability-pipelines.v1` standard and the domains they participate in. Legacy fields such as `nav`, `screen`, `settings`, `type: "visualization"`, shortcuts, overlays, and mixer faders still work, but native metadata lets diagnostics, the Capability Inspector, and migration tooling explain plugin behavior without scraping private globals.

## Topics

| Topic | Doc | When to read |
|---|---|---|
| **Manifest reference** | [plugin-manifest.md](plugin-manifest.md) | Field-by-field reference for `plugin.json`. Read first. |
| **Capability declarations** | [plugin-manifest.md#capabilities](plugin-manifest.md#capabilities) | Declaring provider/requester/observer intent with `capability-pipelines.v1`. |
| **Visualization contracts** | [plugin-visualization-contracts.md](plugin-visualization-contracts.md) | Building a highway renderer (setRenderer), an overlay layer, or a note-state provider. |
| **Plugin styles** | [plugin-styles.md](plugin-styles.md) | Shipping a plugin-owned prebuilt stylesheet via `styles: "assets/plugin.css"`. |
| **Audio mixer faders** | [plugin-audio-mixer.md](plugin-audio-mixer.md) | Plugin produces audio outside the song `<audio>` element. |
| **Backend logging** | [plugin-logging.md](plugin-logging.md) | Plugin has a `routes.py`. Use `context["log"]`, never `print()`. |
| **Diagnostics contribution** | [plugin-diagnostics.md](plugin-diagnostics.md) | Adding plugin state to the Export Diagnostics bundle. |
| **Keyboard shortcuts** | [plugin-keyboard-shortcuts.md](plugin-keyboard-shortcuts.md) | Registering keys via `window.registerShortcut()`. |
| **Sibling Python imports** | [plugin-sibling-imports.md](plugin-sibling-imports.md) | Multi-file backend plugins. Use `context["load_sibling"]`. |
| **WebSocket protocol** | [websocket-protocol.md](websocket-protocol.md) | Plugins that read the highway stream directly. |
| **Testing plugins** | [testing-plugins.md](testing-plugins.md) | Conftest fixtures and Playwright patterns for plugin tests. |
| **Diagnostics bundle spec** | [diagnostics-bundle-spec.md](diagnostics-bundle-spec.md) | Existing in-depth spec — what's inside a diagnostics export. |
| **Sloppak format spec** | [sloppak-spec.md](sloppak-spec.md) | Existing in-depth spec — for plugins that read/write sloppaks. |

## General guidelines

- Wrap your plugin code in an IIFE: `(function () { 'use strict'; ... })();`
- Declare `standards: ["capability-pipelines.v1"]` and native `capabilities` when your plugin participates in a Slopsmith capability domain.
- Use `localStorage` for user-facing settings, prefixed with your plugin id.
- If hooking `window.playSong`, always call the original and `await` it.
- If hooking `window.showScreen`, clean up your state when leaving the player screen.
- Use `window.slopsmith.emit()` / `window.slopsmith.on()` for inter-plugin communication.
- Use `window.registerShortcut()` to add keyboard shortcuts. Clean up with `window.unregisterShortcut(key, scope)` — pass the same scope you registered with, since the default is `'global'` and won't match `player`/`library`/`settings`/`plugin-*` bindings. For panel-scoped shortcuts, prefer `panel.clearShortcuts()`.

## Plugin frontend globals available at runtime

- `window.playSong(filename, arrangementIdx)` — load and play a song
- `window.showScreen(name)` — navigate between screens
- `window.createHighway()` — factory for the highway renderer (used by main player and splitscreen panels)
- `window.slopsmith` — event emitter (`emit`, `on`, `off`)
- `window.slopsmith.audio` — audio mixer fader registry
- `window.slopsmith.diagnostics` — diagnostics namespace (`contribute`, `snapshotConsole`, etc.)
- `window.registerShortcut` / `window.unregisterShortcut` / `window.createShortcutPanel` — keyboard shortcuts API
- `highway` global — set when the player is active. Getters: `getTime`, `getNotes`, `getChords`, `getChordTemplates`, `getSongInfo`, `getStringCount`, `getLefty`, `getInverted`, `getBeats`, `isDefaultRenderer`, …

## Plugin load order

Plugins load alphabetically by directory name. This determines the `playSong` wrapper chain order (last-loaded wrapper runs first; alphabetically earliest plugin runs closest to the original) and which plugin's UI elements appear first.

If your plugin depends on another's globals, **check at runtime** with `typeof window.X === 'function'`, not at load time. Plugins are independent — assume any other plugin may be missing or disabled.

## Licensing for curated plugins

Plugins submitted for inclusion in the curated list must be AGPL-3.0 or AGPL-compatible (MIT, BSD, Apache-2.0). See [CONTRIBUTING.md](../CONTRIBUTING.md) for the full policy. The `plugin.json` schema enforces this via the `license` field enum — see [plugin-manifest.md](plugin-manifest.md).
