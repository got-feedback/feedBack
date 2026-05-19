# Plugin keyboard shortcuts

Plugins can register keyboard shortcuts via the global `window.registerShortcut()` function. Shortcuts appear in the `?` help panel.

## Registration

```js
window.registerShortcut({
    key: 'k',                       // key value (e.key) or key code (e.code)
    description: 'Toggle my view',  // shown in the help panel
    scope: 'player',                // 'global' | 'player' | 'library' | 'settings' | 'plugin-{id}'
    condition: () => _isMyViewActive, // optional guard
    handler: (e) => _myAction()      // called when shortcut triggers
});
```

## Scope

Scope controls when the shortcut is active:

- **`global`** — works on any screen
- **`player`** — only on the player screen
- **`library`** — only on the home/favorites screens
- **`settings`** — only on the settings screen
- **`plugin-{id}`** — only when your plugin's screen is active

## Panel-scoped shortcuts

For plugins that create multiple panels (e.g., splitscreen), shortcuts are automatically scoped to the active panel. Use `const panel = window.createShortcutPanel(id)` to create a panel (keep the returned reference so you can call `panel.clearShortcuts()` during cleanup) and `window.setActiveShortcutPanel(id)` to switch between them. Each panel has its own shortcut registry, so multiple panels can have the same key without collisions.

## Condition

`condition` is an optional guard function. If it returns false, the shortcut is skipped even if in scope.

## Key matching

The handler matches against both `e.key` (character produced) and `e.code` (physical key). Use `e.key` for letters/symbols that depend on keyboard layout, and `e.code` for special keys (e.g. `Space`, `ArrowLeft`).

## Cleanup

Clean up with `window.unregisterShortcut(key, scope)`. **You must pass the same scope you registered with** — the default is `'global'` and won't match `player`/`library`/`settings`/`plugin-*` bindings.

For panel-scoped shortcuts, prefer `panel.clearShortcuts()` over per-key unregister calls.

## Built-in shortcuts

| Key | Description |
|-----|-------------|
| `?` | Show keyboard shortcuts panel (global) |
| `Space` | Play/Pause (player only) |
| `←` / `→` | Seek ±5 seconds (player only) |
| `Escape` | Back to library (player only) |
| `[` / `]` | Audio offset ±10ms (Shift: ±50ms) (player only) |

Don't override these. The `?` panel is the canonical reference for users.

## Debugging

Open the browser console and type `_listShortcuts()` to inspect every registered shortcut, its scope, and its source plugin.

## Related

- [PLUGIN_AUTHORING.md](PLUGIN_AUTHORING.md) — guide index
- [testing-plugins.md](testing-plugins.md) — Playwright tests for shortcut behaviour
