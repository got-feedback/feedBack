# Building plugins for the v3 UI (fee[dB]ack v0.3.0)

v0.3.0 ("fee[dB]ack") ships a redesigned UI. It is **the only UI** — the classic v2
shell and its `FEEDBACK_UI` / `/v2` opt-outs have been removed, so there is no
longer a second shell to support.

The good news: v3 **reuses the same engine** the classic UI did — same `server.py`,
`app.js`, `highway.js`, `playSong`, `showScreen`, capability registry, library
providers, and the `window.feedBackViz_<id>` / `setRenderer` visualization contract.
So your plugin's **backend, capabilities, library providers, `nav`/`screen`,
visualization renderers, diagnostics, and settings export all work unchanged.** v3
surfaces your `nav` entry in the new sidebar (via `shell.js` `renderPluginNav`) and
your screen mounts exactly as before.

**The one thing that changed is the player chrome** — and only if your plugin
injects controls into it.

## What changed in the player

In v2, `#player-controls` was a wide, **always-visible** bottom bar. In v3 it
became a **minimal, auto-hiding centered transport** (it fades ~2.5 s after the
pointer goes still during playback), flanked by a **hover-reveal left icon rail**
with popovers.

So the legacy way of injecting a control breaks in v3 two ways:

1. **Auto-hide** — a button you append to `#player-controls` vanishes with the
   transport after a couple seconds.
2. **Dead anchors** — legacy code commonly inserts before a `<span class="text-gray-700">`
   separator or the `button:last-child` (the ✕ Close button). **Neither exists in
   the v3 transport**, so your control lands at the wrong end or is unreachable.

## The contract: detect v3, mount into the plugin-control slot

The host exposes:

- `window.feedBack.uiVersion === 'v3'` — detect v3 (absent / not `'v3'` in v2).
- `window.feedBack.ui.playerControlSlot()` — returns a **stable, always-reachable
  container** (the "Plugins" rail popover). In v3, append your control(s) here
  instead of `#player-controls`.

Canonical pattern for any control you inject into the player:

```js
function playerSlot() {
  return (window.feedBack && window.feedBack.uiVersion === 'v3'
    && window.feedBack.ui && typeof window.feedBack.ui.playerControlSlot === 'function')
    ? window.feedBack.ui.playerControlSlot() : null;
}

function injectMyButton() {
  const slot = playerSlot();
  const controls = slot || document.getElementById('player-controls');   // v3 slot, else v2 bar
  if (!controls) return;
  if (myBtn && controls.contains(myBtn)) return;                          // guard the ACTUAL container
  // Legacy inserts before a separator / the ✕ Close button; the v3 slot has no
  // such anchor, so just append there.
  const anchor = slot ? null : controls.querySelector('span.text-gray-700, button:last-child');
  myBtn = document.createElement('button');
  /* ... */
  if (anchor) controls.insertBefore(myBtn, anchor); else controls.appendChild(myBtn);
}
```

Rules:

- **Gate v3 behavior on `uiVersion`** so v2 is byte-for-byte unchanged.
- **Never** `insertBefore` the legacy `span.text-gray-700` separator or
  `button:last-child` — they don't exist in the v3 transport. Append instead.
- **Guard idempotency against the actual container** (`controls.contains(myBtn)`),
  not a hard-coded `#player-controls` — otherwise re-injection logic breaks in v3.
- **Dropdowns/panels** your control opens: position them via the trigger's
  `getBoundingClientRect()` (portal to `document.body` or `#player`), **not**
  relative to `#player-controls` — the trigger now lives in the rail popover.
- **Overlays/HUDs/canvases** you attach to `#player` keep working; just keep their
  `z-index` **under the chrome layers**: transport/HUD `z-20`, rail `z-30`,
  popovers `z-40`.

## Pedalboard metadata (icon, description, category)

The v3 **Plugins page** renders each plugin as a guitar **pedal** grouped onto
category **pedalboards**. To make your pedal look good, declare three optional,
additive manifest fields (all surfaced in `/api/plugins`):

```json
{
  "id": "my_plugin",
  "name": "My Plugin",
  "description": "One short sentence shown under the pedal name.",
  "category": "audio",
  "icon": "assets/thumb.png"
}
```

- **`description`** — one short sentence (clamped to ~2 lines on the pedal).
- **`category`** — which board the pedal sits on. Suggested:
  `audio | creation | practice | game | tools`. Unknown/absent → a curated default
  then `"other"`.
- **`icon`** — assets-relative thumbnail (~square, ~256×256 PNG/SVG), served via
  the existing sandboxed `/api/plugins/<id>/assets/...` route (same containment
  rule as `styles`). **Shortcut:** if you omit `icon` but ship
  `assets/thumb.png`, the loader auto-detects it — no manifest edit needed.
  Plugins with no thumbnail get a default pedal graphic.

All three are backward-compatible: omit them and the plugin still loads and shows
a default pedal.

## The compatibility shim (don't rely on it)

So un-updated plugins still function, the host runs a `MutationObserver` that
re-homes any non-native `#player-controls` child into the slot. It's a safety net
— but it **breaks plugins that guard re-injection with
`#player-controls.contains(myBtn)`** (once the host moves the node out, the check
goes false and the plugin re-injects every song). **Mount into the slot yourself**
(the pattern above) to be correct; treat the shim as a fallback only.

## Styling

v3 uses `fb-*` design tokens (`fb-card`, `fb-text`, `fb-textDim`, `fb-primary`,
`fb-border`); v2 uses `dark-*` / `accent`. Legacy classes still **render
acceptably** in v3's dark theme, so a plugin that only uses core-guaranteed
utilities is functional in both. For polish, ship your own stylesheet via the
`styles` capability ([plugin-styles.md](plugin-styles.md)) declaring the tokens you
use — but the host slot already provides a styled container, so simple controls
need nothing special.

## Enabling / disabling plugins (Pedalboard footswitch)

The v3 **Pedalboard** Plugins page renders each plugin as a guitar pedal whose
"footswitch" turns the plugin on or off. The backend contract:

- **`enabled` field on every `/api/plugins` entry** — a boolean, default `true`.
  Absent (older entries, stubbed test rows) is treated as enabled. The frontend
  hides the nav and shows the footswitch unlit when `enabled` is `false`.
- **`POST /api/plugins/{plugin_id}/enabled`** — body `{"enabled": <bool>}`,
  returns `{"id": "<id>", "enabled": <bool>}`.
  - `400` if the body is missing/invalid or `enabled` isn't a real boolean
    (`0`/`1`/strings are rejected).
  - `400` if you try to disable an always-on plugin — `capability_inspector`
    and any `app_tour_*` may never be disabled (disabling would brick the app or
    the capability-graph review surface). Bundled plugins are otherwise
    disable-able.
  - `404` for an unknown plugin id (not loaded and not pending).

### Persistence

The choice is persisted under `CONFIG_DIR/plugin_state.json` as
`{"<plugin_id>": {"enabled": false}, ...}`. **Only non-default (`enabled:false`)
entries are stored** — re-enabling drops the key entirely, so the file stays
small and "absent ⇒ enabled" is the invariant. A missing or corrupt state file
is tolerated (logged, falls back to `{}`) and never crashes startup.

### Restart semantics

- Toggling **persists immediately** and flips the **in-memory** `enabled` flag,
  so the very next `/api/plugins` (and thus the nav, the Pedalboard, and the
  capability pipeline) reflects the change at once — no restart needed for the
  UI to update.
- A plugin **disabled at runtime keeps its already-mounted routes/screen** until
  the next restart; full hot-unload is out of scope. The frontend treats
  `enabled:false` as "off" regardless.
- At **startup**, the loader **skips disabled plugins entirely** — it does not
  install requirements, run `routes.setup()`, or register their screen, nav, or
  capabilities. They still appear in `/api/plugins` as a disabled entry
  (`status: "disabled"`, `enabled: false`) so the UI can show an "off" pedal you
  can switch back on. **Re-enabling** a plugin that was skipped at startup
  updates the flag immediately but the plugin only actually mounts on the next
  restart.

### Capability pipeline

A disabled plugin is **excluded from the capability pipeline**: its
`capabilities`, `standards`, `capability_validation_warnings`,
`capability_unsupported_versions`, and `compatibility_shims` are emptied in the
`/api/plugins` response whenever `enabled` is `false` (covering both
startup-skipped and runtime-toggled-off plugins). Because the browser capability
registry registers any entry that carries a capability declaration regardless of
status, suppressing the metadata here is what actually keeps a disabled plugin
out of the capability graph.

## Checklist

- [ ] Backend / capabilities / library provider / `nav` + `screen` /
      visualization renderer — **no change needed** (they work in v3 as-is).
- [ ] If you inject a control into the player: detect v3 and mount into
      `window.feedBack.ui.playerControlSlot()`; drop the dead separator /
      `button:last-child` anchor; guard `contains()` against the actual container.
- [ ] Dropdowns positioned via `getBoundingClientRect()`, not `#player-controls`.
- [ ] `#player` overlays keep `z-index` ≤ the chrome layers (transport/HUD 20,
      rail 30, popovers 40).
- [ ] Verify at `/` — it and `/v3` serve the same (and only) v3 shell.
