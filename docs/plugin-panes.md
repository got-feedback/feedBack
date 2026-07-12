# Detachable panes (`window.feedBack.panes`)

A **pane** is live UI that stays put: a mixer, a camera rig, a readout, a settings
board. You author it once, and the host decides where it lives — docked beside the
player, or popped out into its own OS window that remembers where you put it and
minimizes to the system tray.

Panes exist because the player's rail popovers are **exclusive**: opening one closes
the last. You cannot watch the mixer while riding the camera, and both vanish the
moment you want to look at the highway. Panes are non-exclusive, and they survive
song switches.

---

## The two-line version

If your plugin already has a dialog, give it a pop-out chip:

```js
feedBack.panes.register({
    id: 'camera_director',
    title: 'Camera Director',
    icon: '🎥',
    mount(root, ctx) { root.appendChild(buildCameraUI(ctx)); },   // your existing builder
    unmount(root) { root.replaceChildren(); },
});

feedBack.panes.attachChip(myDialogEl, 'camera_director');
```

`attachChip()` injects **the** standard ⇱ button — same glyph, same place, same
behaviour everywhere. Clicking it opens the pane in its host and **hides your
dialog**, leaving a "⇲ … is popped out" stub in its place. Closing the pane
un-hides your dialog and restores the chip.

**You write no show/hide logic.** Core owns it, so that every plugin's pop-out
behaves identically — which is the entire point.

---

## The one rule

> **`mount(root, ctx)` runs in a realm that may not have the app in it.**

Docked, your pane runs in the main window with everything present. Popped out, it
runs in a **separate JS realm** — a different window, with no `window.highway`, no
`window.feedBack.capabilities`, no `<audio>` element, and no audio graph. Same file,
same `mount()`, different world.

So: **everything your pane touches must come through `ctx`.** A pane that reaches
for a global works docked and silently dies popped out. There is no way for core to
paper over that, because a closure cannot cross a window boundary.

---

## `ctx`

| | |
|---|---|
| `ctx.call(domain, command, payload)` → `Promise` | The capability bus. This is your only door into app services. Core builds the requester/origin/timeout envelope; you send a payload. Cross-realm calls have a 10 s deadline and reject with `PaneRpcTimeout`. |
| `ctx.on(event, fn)` → `unsub` | The `feedBack` bus. Handlers get a `{ detail }` object, exactly as in the main window. Only allow-listed events are mirrored (see below). |
| `ctx.subscribe(stream, fn)` → `unsub` | High-rate numerics: `'playhead'` → `{ t, duration, playing }`, `'meters'` → `{ master }`. |
| `ctx.playhead()` → `number` | The current time in seconds, smoothed. **Use this, not a stream, for per-frame drawing** — see "The clock" below. |
| `ctx.state.get(path)` / `.set(path, value)` / `.subscribe(fn)` | A dotted-path store, persisted per pane. The **main realm is authoritative**. |
| `ctx.song()` | The current `feedBack.currentSong`, or `null`. |
| `ctx.toast(opts)`, `ctx.close()` | |
| `ctx.paneId`, `ctx.host`, `ctx.isRemote` | |

**`ctx` tracks every subscription it hands you and drops them on unmount.** You
cannot leak a listener across a dock/undock cycle even if you try. Your `unmount()`
only needs to clear your own DOM.

### Events mirrored by default

`song:loading`, `song:loaded`, `song:ready`, `song:play`, `song:pause`, `song:ended`,
`song:stop`, `song:seek`, `song:arrangement-changed`, `screen:changed`,
`theme:changed`, `library:changed`, `highway:canvas-replaced`, `highway:visibility`.

Widen with `spec.events: ['audio-mix:fader-value-changed', …]`.

**`song:position-changed` is deliberately not on the list.** It fires every 250 ms —
too coarse to animate with, too chatty to mirror across a window. Use the `playhead`
stream or `ctx.playhead()`.

---

## The clock

The main window broadcasts the playhead every frame. But **Chromium throttles a
backgrounded window's rAF to ~1 Hz** — and the main window is exactly what's
backgrounded while the user is looking at your pane. A pane that renders the raw
broadcast stutters at 1 fps.

`ctx.playhead()` solves this: it extrapolates between broadcasts
(`anchor + observedRate × elapsed`, capped at 2 s). The rate is *learned from the
broadcasts themselves*, so it tracks the speed slider without being told, and a dead
main window decays into a frozen clock rather than one that confidently runs away.

**Draw from `ctx.playhead()` in your own rAF loop. Subscribe to `'playhead'` only
for things that change slowly** (a time readout, a progress bar).

---

## Levels, and why they are numbers

An `AnalyserNode` **cannot cross a window boundary.** Your pane can never hold one.

So core samples the analyser in the realm that owns the audio graph and ships you
plain numbers over `ctx.subscribe('meters', …)`. The stream stays **silent** when
there is no analyser (no stems plugin) rather than reporting zeros — so "silent" and
"actually silent" stay distinguishable, and you can render an honest "unavailable"
state.

---

## Declaring a pane in `plugin.json` (preferred)

```json
"panes": [{
    "id": "camera_director",
    "title": "Camera Director",
    "icon": "🎥",
    "script": "panes/camera.js",
    "defaultHost": "window",
    "mirrorGlobal": "__h3dCamCtl",
    "width": 380,
    "height": 560
}]
```

Declaring it beats calling `panes.register()` from `screen.js`, because a
manifest pane is **openable from the rail and the tray without your plugin's screen
ever having been visited**. Core registers a stub and fetches the script only when
the user opens it. (A pane you can only reach by first navigating to the screen it
was meant to replace is not much of a pane.)

`script` is a relpath under your plugin's `src/`, served through the sandboxed
`/api/plugins/<id>/src/…` route. It sets a factory global — the same shape the viz
contract already uses:

```js
window.feedBackPane_camera_director = {
    mount(root, ctx) { … },
    unmount(root, ctx) { … },
};
```

**This exact file is what a pop-out window loads in its own realm.** Write it to the
one rule above.

---

## `mirrorGlobal` — for panes that drive a plain global

The 3D highways read their free camera from `window.__h3dCamCtl` once per frame.
A camera panel in the main window just writes that object. A panel in a **pop-out
window cannot** — `window.__h3dCamCtl` there is a different object in a different
realm, and writing it moves nothing.

Declare `mirrorGlobal: '__h3dCamCtl'` and core copies your pane's state onto that
global, **in the main realm, mutating the object in place** (a renderer may be
holding the reference). You write `ctx.state.set('yaw', 0.3)`; the renderer keeps
reading the plain global it always read; `highway_3d` is not modified and does not
know panes exist.

---

## Rules that will bite you

1. **Never cache the renderer or the canvas.** `playSong()` calls `highway.stop()` →
   `destroy()`. Re-bind on `song:ready` / `highway:canvas-replaced` /
   `highway:visibility`.
2. **Module top-level does not re-run** on screen re-entry (see
   [plugin-modules.md](plugin-modules.md)). Per-visit init belongs in `mount()`.
3. **No per-frame `querySelector`.** Panes share the main thread with a 60 fps render
   loop. Resolve refs in `mount()`, cache them. (See the perf rules in
   [CLAUDE.md](../CLAUDE.md).)
4. **A pane with no `script` can only ever be docked.** It exists solely as a closure
   in the main realm, and there is no honest way to move a closure across a window
   boundary — the window host declines it and the router falls back to the dock.
5. **`localStorage` is shared with your pop-out window** (same origin). Use
   `ctx.state`, which has exactly one writer.
6. **Persistence is on by default** (`persist: false` to opt out). State is keyed by
   pane id.

---

## Hosts

`panes.detach(id)` opens a pane in the best available host:

| host | priority | |
|---|---|---|
| `desktop` | 20 | A real Electron `BrowserWindow`. Remembered geometry, always-on-top, system tray. |
| `window` | 10 | A browser pop-up (`window.open`). No tray, no remembered bounds. |
| `dock` | 0 | The in-window card stack. **The floor** — always available, so a pane can never fail to open. |

You do not choose; you declare `defaultHost` and the router does the rest. A pane
popped out in the desktop app comes back popped out on next launch; in a browser it
comes back **docked**, because a browser blocks `window.open()` without a user
gesture and a "pop-up blocked" toast on every page load would be worse than useless.

## API

```js
feedBack.panes.register(spec) -> unregister
feedBack.panes.attachChip(el, paneId, { header }) -> detach
feedBack.panes.open(id, { host }) / close(id) / detach(id) / dock(id) / focus(id)
feedBack.panes.isOpen(id) / hostOf(id) / get(id) / list()
```

`spec`: `{ id*, title, icon, mount*, unmount, script, events[], persist, initialState,
defaultHost, mirrorGlobal, width, height }`.
