# Debugging Keyboard Shortcuts

This skill helps you debug keyboard shortcut issues in FeedBack.

## Quick Start

1. **Start FeedBack:**
   ```bash
   cd ~/path/to/feedBack
   LIBRARY_PATH=/path/to/your/library docker compose up -d
   ```

2. **Open browser:** http://localhost:8000

3. **Open DevTools:** Press `F12` or `Ctrl+Shift+I`

## Debugging Commands

Open the browser console and run these commands:

### Enable Debug Logging
```javascript
_setDebugShortcuts(true)
```
This will log every keypress and shortcut match attempt.

### List All Registered Shortcuts
```javascript
_listShortcuts()
```
Shows all shortcuts with their keys, scopes, and descriptions.

### Test a Specific Shortcut
```javascript
_testShortcut('Space')
```
Shows if a shortcut would be active in the current context.

## Common Issues

### 1. Shortcut Not Triggering

**Check:**
- Are you on the right screen? (Player shortcuts only work on player screen)
- Is focus in an input field? (Shortcuts are disabled when typing)
- Is the key registered? Run `_listShortcuts()` to see all registered shortcuts

**Debug:**
```javascript
_setDebugShortcuts(true)
// Now press your key and watch the console
```

### 2. Scope Issues

**Check current context:**
```javascript
// This shows which screen you're on
document.querySelector('.screen.active')?.id
```

**Common scopes:**
- `global` - Works on any screen
- `player` - Only on player screen
- `library` - On home, favorites, or settings screens
- `plugin-{id}` - Only on a specific plugin's screen

### 3. Key Matching Issues

The system matches on both `e.key` (character produced) and `e.code` (physical key):

- Use `e.key` for letters/symbols that depend on keyboard layout
- Use `e.code` for special keys (Space, ArrowLeft, Escape, etc.)

**Example:**
```javascript
// Good for special keys
registerShortcut({ key: 'Space', ... })  // or 'ArrowLeft', 'Escape'

// Good for layout-dependent keys
registerShortcut({ key: '?', ... })       // or '[', ']', 'k'
```

### 4. Condition Not Met

If your shortcut has a condition function, it must return `true`:

```javascript
registerShortcut({
    key: 'k',
    description: 'My action',
    scope: 'player',
    condition: () => _isMyViewActive,  // Must be true
    handler: () => _myAction()
})
```

**Test it:**
```javascript
_testShortcut('k')
// Check if `conditionMet` is true
```

## Testing Your Changes

1. Make changes to `static/app.js`
2. Refresh the browser (changes are live-reloaded via Docker volume mount)
3. Run `_listShortcuts()` to verify your shortcut is registered
4. Press `?` to open the shortcuts help panel
5. Test your shortcut

## Built-in Shortcuts

Press `?` to see all shortcuts in the UI. Built-in shortcuts:

| Key | Scope | Description |
|-----|-------|-------------|
| `?` | Global | Show keyboard shortcuts |
| `Space` | Player | Play/Pause |
| `ArrowLeft` | Player | Seek back 5 seconds |
| `ArrowRight` | Player | Seek forward 5 seconds |
| `Escape` | Player | Back to library |
| `[` | Player | Offset audio back (Shift: 50ms, else 10ms) |
| `]` | Player | Offset audio forward (Shift: 50ms, else 10ms) |

## Adding Your Own Shortcuts

```javascript
registerShortcut({
    key: 'k',                       // Key to press
    description: 'Toggle my view',  // Shown in help panel
    scope: 'player',                // When it's active
    condition: () => _isMyViewActive, // Optional guard
    handler: (e) => _myAction()      // What to do
});
```

## Panel-Scoped Shortcuts

For plugins that create multiple panels (e.g., splitscreen), shortcuts are automatically scoped to the active panel:

```javascript
// Create panels (must exist before setActiveShortcutPanel can target them)
const panel1 = window.createShortcutPanel('panel-1');
const panel2 = window.createShortcutPanel('panel-2');

// Set active panel and register shortcuts
window.setActiveShortcutPanel('panel-1');
registerShortcut({
    key: 'd',
    description: 'Dock panel',
    scope: 'global',
    handler: () => _dockPanel()
});

// Switch to another panel
window.setActiveShortcutPanel('panel-2');
registerShortcut({
    key: 'f',
    description: 'Toggle fullscreen',
    scope: 'global',
    handler: () => _toggleFullscreen()
});

// Clean up when done — clear every panel you created
panel1.clearShortcuts();
panel2.clearShortcuts();
```

**Important:** In splitscreen, `scope: 'player'` means "player screen in the current panel". Each panel can have its own player shortcuts without collisions.

**Truly global shortcuts:** Use `window.getGlobalShortcutContext()` for shortcuts that must work in all panels (exceptional case, logs warning).

## Network Issues

If shortcuts aren't working at all:

1. Check the **Network** tab in DevTools
2. Look for failed requests to `/api/plugins`
3. Check the **Console** tab for JavaScript errors
4. Verify the container is running:
   ```bash
   docker compose ps
   docker compose logs -f
   ```

## WebSocket Issues

Keyboard shortcuts don't require WebSocket, but if other features aren't working:

1. Check **Network** tab → "WS" filter
2. Look for WebSocket connections to `/ws/highway/...`
3. Should show status "101 Switching Protocols"

## Getting Help

If you're still stuck:

1. Enable debug mode: `_setDebugShortcuts(true)`
2. Reproduce the issue
3. Copy the console output
4. Share it along with:
   - Which screen you're on
   - What key you're pressing
   - What you expect to happen
   - What actually happens
