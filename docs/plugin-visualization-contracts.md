# Plugin visualization contracts

Slopsmith supports two ways for a plugin to participate in the main player's visuals. They coexist; the **setRenderer** contract is the default for any viz that draws a highway-shaped surface, and **overlays** handle layered decorations on top. A third orthogonal contract — **note-state provider** — lets scorers feed per-note judgments back into whichever renderer is active.

**Pick the right shape:**
- Replacing the whole highway drawing on the existing highway canvas (your renderer owns its rendering context / resources; `createHighway()` still owns the canvas element and the rAF loop)? → **setRenderer** (section 1). Enters the viz picker. Works in both the main player and per-panel under splitscreen.
- Adding a layer on top of whichever viz is active? → **Overlay** (section 2). Navbar toggle, not in the picker.
- Scoring plugin that wants renderers to "light up" notes on correct hits? → **Note-state provider** (section 3). Orthogonal — can coexist with overlay HUDs.

## 1. setRenderer contract (slopsmith#36) — preferred

Plugins that want to replace the main highway's draw function (per panel, per session) export a renderer factory on `window.slopsmithViz_<id>` where `<id>` matches the `id` in `plugin.json` (`type: "visualization"` required). The factory returns an object matching this shape:

```js
window.slopsmithViz_my_viz = function () {
    return {
        // Required canvas context type. Default '2d' if omitted.
        // highway.js reads this BEFORE calling init() so it can
        // replace the underlying <canvas> element if the current
        // one is locked to a different context type (see "Canvas
        // context-type swapping" below).
        contextType: '2d', // or 'webgl2'
        init(canvas, bundle) {
            // One-time setup. Own your getContext() call here —
            // acquire '2d' or 'webgl2' depending on the renderer.
            // The canvas you receive is guaranteed to either be
            // unbound or already bound to your declared contextType.
            this.ctx = canvas.getContext('2d');
        },
        draw(bundle) {
            // Called each requestAnimationFrame tick by the factory.
            // `bundle` is a snapshot with: currentTime, songInfo, isReady,
            // notes, chords, anchors (all difficulty-filter-aware),
            // beats, sections, chordTemplates, stringCount, lyrics,
            // toneChanges, toneBase, mastery, hasPhraseData, inverted,
            // lefty, renderScale, lyricsVisible, the 2D coordinate
            // helpers project and fretX, and getNoteState (see below).
            // `stringCount` is the active arrangement's string count (4
            // for bass, 6 for guitar, 7+ for extended-range GP imports —
            // size string-indexed geometry against this, not a hardcoded
            // 6). If your renderer needs lefty-aware text rendering, check
            // bundle.lefty and apply the mirror transform yourself —
            // a bundle-level helper isn't provided because it would
            // need your renderer's own context, not the factory's.
            //
            // bundle.getNoteState(note, chartTime) (slopsmith#254) — call
            // this per visible chart note / chord-note to find out whether
            // a scorer (note_detect) has flagged it 'hit' / 'active' (a
            // sustain currently being held correctly) / 'miss', so the gem
            // itself can light up / a held sustain can glow instead of
            // relying on an overlay ring. Returns null when no provider is
            // registered or it reports nothing for this note; otherwise
            // { state: 'hit'|'active'|'miss', alpha: 0..1, color: string|null }.
            // For chord notes pass the chord's time (note_detect keys its
            // judgments by `${time}_${string}_${fret}`). 'hit' and 'active'
            // are both "lit" — a renderer may treat them identically; the
            // provider owns all fade timing via `alpha` and by simply
            // ceasing to return state when the effect should end.
        },
        resize(w, h) {
            // Optional. Canvas dims already updated; re-create WebGL
            // framebuffers / reset 2D transforms here.
        },
        destroy() {
            // Optional. Release resources, remove DOM nodes, null refs.
            // Called before setRenderer() swaps to another renderer
            // and on highway.stop().
        },
    };
};
```

Selecting this plugin in the main-player viz picker — or in splitscreen's per-panel picker — calls `highway.setRenderer(factory())` on the existing highway instance. The built-in 2D highway is the default renderer and is restored by passing nullish — `setRenderer(null)` and `setRenderer(undefined)` both work (the implementation gates on `r == null`). Splitscreen panels create one `createHighway()` per panel and each independently consults the picker, so N panels can run different renderers (or N copies of the same renderer with different arrangements) without coordination.

### Lifecycle contract

The factory returns a single renderer instance that may go through multiple `init() → ... → destroy()` cycles as the user navigates between songs or screens. Specifically:

- `init(canvas, bundle)` runs when the highway has a canvas and the renderer takes over drawing. This is when to acquire `getContext()`, build shaders / meshes / DOM nodes, and register listeners.
- `draw(bundle)` runs on every rAF frame once the WebSocket `ready` message has fired and until the renderer is replaced or the highway stops. It is **not** called during the loading / reconnect window (between `api.init()` + `stop()` and the next `ready`) — that would hand the renderer half-populated chart arrays. Renderers that want to show a "loading" state can read `bundle.isReady` inside a future-widened contract, but today the factory gates `draw` behind the ready flag and `isReady` is only informational once it does fire.
- `destroy()` runs when the renderer is replaced via another `setRenderer(...)` call, OR when `highway.stop()` is called (e.g. the user navigates away from the player). It releases everything `init()` acquired.
- **After `destroy()`, the same instance may receive another `init()` call** — this happens on `playSong()` which does `stop()` → `init()` to reuse the same canvas element for the next song. Renderers must tolerate `init()` being called again on an instance that was previously destroyed. Practically: null your refs in destroy, re-acquire them in init.
- `destroy()` is skipped when it would run on an un-init'd renderer — if a caller does `setRenderer(x)` before the highway ever init'd (possible when restoring a saved picker selection at page load), `x.destroy()` is not called until `x.init()` has run at least once.
- `resize(w, h)` is optional; runs after init and whenever the canvas dimensions change.

### Key rules

- The factory **returns a fresh object on each call** — important for splitscreen, where multiple panels will each get an independent instance.
- The renderer **owns its own rendering context** (2D or WebGL). Factory will not call getContext for you.
- **Canvas context-type swapping.** Browsers lock a `<canvas>` to the first context type successfully acquired for its lifetime: once `getContext('2d')` succeeds, `getContext('webgl2')` on that same canvas returns `null`, and vice versa. To let arbitrary 2D ⇄ WebGL renderer swaps work mid-session, `highway.setRenderer()` reads the next renderer's `contextType` before calling its `init()` and, if it differs from the type currently bound, replaces the underlying `<canvas>` element with a fresh one via `oldCanvas.cloneNode(false)` followed by `oldCanvas.replaceWith(newCanvas)`. The factory then calls the renderer's `init(newCanvas, bundle)` with the fresh element so its `getContext()` succeeds. Practical implications:
  - **What survives the swap.** `cloneNode(false)` preserves *every HTML attribute* on the element — `id`, `class`, inline `style`, all `data-*` and `aria-*` attributes, `role`, `tabindex`, the attribute form of `width`/`height`, and anything else a plugin attached. DOM position is preserved by `replaceWith()`, so siblings, parents, and surrounding layout are unaffected.
  - **What does NOT survive.** Event listeners attached via `addEventListener` are NOT cloned, and expando properties set imperatively on the JavaScript object (such as the bound rendering context, or any `canvas._myPlugin = …`-style data a plugin attached) are not carried over either. The bound rendering context being left behind on the detached element is exactly what allows the new canvas to start fresh and accept a different `getContext()` call. Note: `canvas.width`/`canvas.height` *are* reflected HTML attributes, so those values do survive the clone; `api.resize()` re-applies the backing-store dimensions on the new element after the swap regardless.
  - Renderers must **declare `contextType`** on the returned instance (`'2d'` or `'webgl2'`; absent → `'2d'`). Factories may also expose it as a static (`window.slopsmithViz_<id>.contextType = 'webgl2'`) so core can read it before constructing the renderer — used today by Auto-mode evaluation.
  - Plugins that hold a stale reference to the highway canvas across renderer swaps — including any code that registered listeners directly on the canvas element rather than on `window`/`document` — should listen for the `highway:canvas-replaced` event on `window.slopsmith` and re-acquire / re-register. `window.slopsmith.emit` dispatches a `CustomEvent`, so the payload `{ oldCanvas, newCanvas, contextType }` lives on `event.detail`, not on the event object itself:
    ```js
    window.slopsmith.on('highway:canvas-replaced', (event) => {
        const { oldCanvas, newCanvas, contextType } = event.detail;
        // re-acquire / re-register against newCanvas
    });
    ```
    Plugins that re-query `document.getElementById('highway')` lazily inside their own event handlers don't need this listener — they pick up the new element automatically (it keeps `id="highway"`).
  - **`highway:visibility`** — fired on `window.slopsmith` whenever the highway canvas transitions between displayed and hidden. Detection is DOM-based via `canvas.offsetParent === null` (catches `display:none` on the canvas or any ancestor — e.g. splitscreen's `#highway` hide) or whatever a host explicitly sets via `highway.setVisible(bool)`. While `visible === false`, core skips the rAF `renderer.draw(bundle)` call AND the default 2D draw, so renderers don't have to no-op themselves. The event is emitted only on transitions (including the first one after `init()`), not every frame. Payload `{ visible, canvas }` lives on `event.detail`:
    ```js
    window.slopsmith.on('highway:visibility', (event) => {
        const { visible, canvas } = event.detail;
        // Toggle any sibling DOM your renderer mounts. The 3D Highway
        // renderer hides its `.h3d-wrap` overlay here so `display:none`
        // on `#highway` actually hides the visible output.
    });
    ```
    Renderers that only paint to the slopsmith canvas don't need this listener — the rAF skip is enough. Renderers that mount sibling DOM (separate WebGL contexts, overlays, etc.) do.
  - **`highway.setVisible(bool | null)`** — forces the visibility state regardless of `offsetParent`. Pass `null` to clear the override and resume DOM-based detection. Useful when the host hides the highway via `visibility:hidden`, `opacity:0`, transforms, or clipping rather than `display:none`. The override re-emits any resulting transition immediately rather than waiting for the next rAF tick.
  - Default-renderer ctx is closure-cached. The replace path nulls the closure ctx so stale draw paths short-circuit; the next default-renderer `init()` re-acquires the 2D context from the new canvas cleanly.
- `draw(bundle)` receives difficulty-filtered arrays — never read from `_filteredNotes` or other internals.
- `_drawHooks` fire for the default 2D renderer (the factory calls them at the end of each frame). Custom WebGL renderers that maintain a 2D overlay canvas (like the bundled 3D highway) also call `window.highway.fireDrawHooks(ctx, W, H)` on that overlay so overlay plugins continue to work regardless of which renderer is active. Custom renderers without a 2D overlay context should not attempt to fire hooks.

### Auto mode — `matchesArrangement(songInfo)` (optional)

The viz picker prepends an "Auto (match arrangement)" entry that is the default selection on fresh installs. When Auto is active, core evaluates registered viz factories on every `song:ready` and swaps the renderer to the first factory whose `matchesArrangement(songInfo)` predicate returns truthy. No match → the built-in 2D highway.

Declare the predicate as a static on the factory (not the instance) so core can evaluate it without constructing a throwaway renderer:

```js
window.slopsmithViz_piano = function () { /* ... */ };
window.slopsmithViz_piano.matchesArrangement = function (songInfo) {
    return /keys|piano|synth/i.test((songInfo && songInfo.arrangement) || '');
};
```

- `songInfo` is the highway's live song_info snapshot — `arrangement`, `tuning`, `capo`, `arrangement_index`, `filename`, `artist`, `title`, etc. May be `{}` before the first song loads.
- Factories without `matchesArrangement` are skipped during auto-selection — the correct default for arrangement-agnostic viz (tabview, jumpingtab) that only make sense as manual picks.
- Explicit picker selections override Auto and are persisted to `localStorage.vizSelection`, so the pinned choice survives page reloads until the user switches back to "Auto" (which also persists). Picking "Auto" re-evaluates against the current song immediately. In contexts where `localStorage` is unavailable (private mode, sandboxed iframes, some test runners) persistence falls back to the current picker `<option>` value, which still overrides Auto for as long as the page stays loaded.
- When an Auto-selected renderer fails and core emits `viz:reverted`, the picker falls back to the built-in default and disables auto-switching until the user re-selects Auto.
- First match wins (picker order), so the registration order of plugins is the tiebreaker. Keep predicates narrow to avoid stealing songs from more specialized viz.

**WebGL viz in Auto mode.** Auto evaluation runs on every `song:ready` regardless of which renderer is active. Auto-installing a WebGL renderer when the canvas is currently 2D — or reverting from a WebGL Auto pick to the default 2D — works without a reload because `setRenderer` swaps the canvas element when `contextType` differs (see "Canvas context-type swapping" above). WebGL viz can therefore safely declare `matchesArrangement` and rely on Auto. For 3D Highway specifically, `_canRun3D()` in app.js still gates Auto from picking it on machines without WebGL2 — that fallback is independent of canvas swapping.

## 2. Overlay contract — for add-on layers

Plugins that add a layer on top of whichever visualization is active — HUDs, fretboard diagrams, chord labels, practice feedback — don't replace the renderer. They manage their own canvas, their own rAF loop, and a toggle button somewhere visible (typically a navbar pill), reading public highway state via the getters:

- `highway.getTime()` / `highway.getBeats()` — current playback position
- `highway.getNotes()` / `highway.getChords()` — difficulty-filter-aware arrays
- `highway.getChordTemplates()` — chord shape lookup table; index by `chord.id` from `getChords()` to get `{ name, fingers, frets }`. `fingers` and `frets` are per-string arrays (length matches the tuning's string count); within `fingers`, `-1` = unused, `0` = open string, `n > 0` = finger number. RS XML sources populate real fingerings; GP imports currently emit all `-1` since pre-import sources don't carry finger data. Not filter-aware: templates are static metadata, every `chord_id` referenced by `getChords()` is guaranteed valid.
- `highway.getSongInfo()` — tuning, arrangement, capo
- `highway.getStringCount()` — number of strings on the active arrangement (4 for bass, 6 for guitar, 7+ for extended-range GP imports). Derived server-side as `max(notes-max-string + 1, name-based fallback, len(tuning))` where the tuning length only contributes when it isn't the RS-XML padded 6-string form (sloppak / GP-imported sources carry trimmed tuning lengths). The name-based fallback is 4 for arrangements containing "bass" (case-insensitive) and 6 otherwise. This combination handles partial-string-usage charts (a 6-string lead that never plays string 5), extended-range GP imports (5-string bass, 7-string guitar), and sloppaks that explicitly encode the instrument range — without requiring plugins to do their own arrangement-name matching.
- `highway.getLefty()` / `highway.getInverted()` — mirror + invert state

Overlays do NOT appear in the viz picker and do NOT declare `"type": "visualization"` in `plugin.json`. They coexist with whichever renderer (default 2D, 3D highway, piano, ...) the user has picked.

### Key rules

- **Own your rAF + canvas** — don't piggyback on `_drawHooks` or on `createHighway`'s rendering context. Draw hooks fire for the default 2D renderer and for custom renderers that explicitly call `window.highway.fireDrawHooks(ctx, W, H)` (e.g. the bundled 3D highway fires them on its 2D overlay canvas), but not for every custom renderer.
- **Re-read state every frame** — overlay output must track whatever the current renderer is drawing. Don't cache note positions across frames.
- **Respect lefty + invert toggles** — if the overlay depicts strings or frets, mirror using the same transforms the active renderer would.
- **If you position with `highway.project` / `highway.fretX` (the 2D-highway geometry), gate on `highway.isDefaultRenderer()`** — those helpers describe the *built-in 2D* highway's depth curve and fret zoom. When a custom renderer (3D highway, piano, …) is active your draw hook still fires (on that renderer's 2D overlay layer), but those coordinates won't match its scene — markers land in arbitrary places. Skip rendering when `isDefaultRenderer()` is false; the custom renderer owns that feedback. Renderer-agnostic overlays (fretboard diagram, chord-label HUD — they use `getNotes()`/`getChordTemplates()` + their own layout) don't need this guard.
- **Clean up on toggle-off** — cancel rAF and remove/hide the overlay canvas so inactive overlays aren't wasting frames.

Reference: [fretboard plugin](https://github.com/byrongamatos/slopsmith-plugin-fretboard) — canonical overlay implementation (navbar toggle, own canvas, 80ms active-note window).

### Why two contracts?

setRenderer plugs into an existing highway — main-player or splitscreen-panel — reusing its WebSocket and data parsing, so the common "I want a different look for the same data" case is zero boilerplate AND multi-instance for free. Overlays compose with whatever renderer is active — they decorate rather than replace, so multiple can stack (fretboard + chord labels + practice feedback) without fighting over the canvas.

A previous standalone-pane contract (`window.createMyVisualization({ container })` with its own WebSocket per pane) was used by splitscreen pre-Wave-C. It's been retired now that splitscreen calls `setRenderer` on per-panel `createHighway()` instances; if you find references in older plugin docs or external integration guides, those describe the legacy path.

## 3. Note-state provider — for scorers that want renderers to "light up" notes (slopsmith#254)

A scoring plugin (note_detect) can publish a per-note judgment so whichever renderer is active draws the **gem itself** lit on a correct hit, and keeps a sustain trail glowing while it's still being played correctly — instead of a separate overlay ring floating near the note.

```js
// In the plugin (after resolving the highway instance):
highway.setNoteStateProvider((note, chartTime) => {
    // `note` is the chart note object ({ t, s, f, sus, ... }); for chord
    // notes `chartTime` is the chord's time. Return one of:
    //   - falsy  → no special state (render normally)
    //   - 'hit'    — struck correctly; renderer lights the gem
    //   - 'active' — a sustained note is right now being held correctly
    //   - 'miss'   — missed; renderer may red-wash the gem
    //   - { state: <one of the above>, alpha?: 0..1, color?: '#rrggbb' }
    // You own all fade timing: return a decaying `alpha` for a struck-note
    // glow, `alpha: 1` (or a bare string) for a held sustain, and stop
    // returning state when the effect should end. Keep it cheap — it's
    // called per visible note per renderer per frame.
});
// On teardown:  highway.setNoteStateProvider(null);
```

- Only one provider is active at a time (last `setNoteStateProvider` wins). `highway.getNoteStateProvider()` returns the current one (or null).
- The built-in 2D highway consults it in `drawNote` / `drawSustains` / the chord-frame path: 'hit'/'active' → bright string colour + additive halo + a contained "sizzle" (crackling sparks, throbbing core, a shockwave ring on a fresh strike) on the gem and a bright (vs dim) sustain trail; 'miss' → faint red wash. The bundled **3D highway** reads the same data via `bundle.getNoteState` (bright string-tinted outline + bright body + glowing sustain + a contained sparkle hugging the note rect on hit/active; red outline + suppressed body on miss). Custom renderers that want it call `bundle.getNoteState(note, chartTime)` — it null-guards and returns the normalized `{ state, alpha, color }` (or null).
- This is orthogonal to the overlay contract: note_detect remains an overlay (HUD, diagnostic miss markers, the "currently detected" indicator) *and* a scorer that feeds this provider. A renderer that ignores `getNoteState` simply doesn't light gems — nothing breaks.

## Related

- [PLUGIN_AUTHORING.md](PLUGIN_AUTHORING.md) — guide index
- [plugin-manifest.md](plugin-manifest.md) — declaring `"type": "visualization"`
- [websocket-protocol.md](websocket-protocol.md) — the WebSocket stream that drives `bundle`
- [plugin-audio-mixer.md](plugin-audio-mixer.md) — companion contract for audio-producing plugins
