# FeedBack — AI Agent Guide

FeedBack is a self-hosted web app for browsing, playing, and practicing interactive music notation, built around its own open `.sloppak` chart format. Charts come from importing Guitar Pro (GP5/GP8) or MusicXML, or from authoring in the built-in editor. It runs as a Docker container with a FastAPI backend (`server.py`), vanilla JavaScript frontend (`static/`), shared Python libraries (`lib/`), and an extensive plugin system (`plugins/`). There are no frontend frameworks — everything is plain JS, HTML, and Tailwind CSS.

## Architecture Quick Reference

```
server.py              FastAPI app — library API, WebSocket highway, plugin loading
static/
  app.js               Main frontend — screens, library views, player, plugin loader
  highway.js           Canvas note highway renderer (createHighway factory)
  index.html           Single-page app shell
  style.css            Custom CSS loaded alongside Tailwind
lib/
  song.py              Core data models (Note, Chord, Arrangement, Song)
  sloppak.py           Sloppak format support
  loosefolder.py       Loose-folder XML chart support
  audio.py             OGG/MP3 audio handling
  retune.py            Pitch-shifting logic
  tunings.py           Tuning name/offset utilities
  gp2rs.py             Guitar Pro to arrangement XML conversion
  gp2midi.py           Guitar Pro to MIDI
plugins/
  __init__.py           Plugin discovery, loading, requirements install
  <plugin_name>/        Each plugin is its own directory (often a git submodule)
tests/
  test_*.py             pytest test suite
```

## Plugin System

Plugins are the primary extension point. Each plugin lives in `plugins/<name>/` with a `plugin.json` manifest. Plugins are typically their own git repositories — see [CONTRIBUTING.md](CONTRIBUTING.md) for the licensing policy (curated plugins should be AGPL-3.0 or AGPL-compatible: MIT, BSD, Apache-2.0).

```json
{
  "id": "my_plugin",
  "name": "My Plugin",
  "version": "1.0.0",
  "private": false,
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
  }
}
```

All fields except `id` and `name` are optional. Plugins can have any combination of frontend (screen/script), backend (routes), and settings.

`version` and `private` are advisory metadata — the plugin loader does not currently consume them, but plugins commonly include them for publishing/tooling purposes.

`description`, `category`, and `icon` are **optional, additive v3 Pedalboard metadata** (surfaced in `/api/plugins`, consumed by the v3 Plugins page `static/v3/plugins-page.js`). `description` is a short one-sentence summary shown under the pedal name. `category` (`audio | creation | practice | game | tools`, free-form; unknown/absent → curated default → `"other"`) picks which pedalboard the plugin sits on. `icon` is an assets-relative thumbnail path (e.g. `"assets/thumb.png"`, ~square ~256×256, same containment rule as `styles`, served via `/api/plugins/<id>/assets/...`); if omitted the loader auto-detects `assets/thumb.png`, and plugins with no thumbnail get a default pedal graphic. All three are backward-compatible — omit them and the plugin still loads. See [docs/plugin-v3-ui.md](docs/plugin-v3-ui.md).

`styles` is the **opt-in** for self-hosted CSS (Principle II — prebuilt Tailwind, no Play CDN). Core's `static/tailwind.min.css` only contains classes scanned from core source at build time, so a plugin installed at runtime (community / NAS) that uses classes core didn't scan — especially arbitrary values like `text-[11px]` — renders unstyled. Declaring `styles` makes the frontend inject one versioned `<link rel="stylesheet">` into `<head>` (covering the plugin's screen *and* its settings panel) pointing at the plugin's own compiled stylesheet. The value is a **plugin-root-relative path that must live under `assets/`** (e.g. `"assets/plugin.css"`) so it serves through the sandboxed `/api/plugins/<id>/assets/...` route. Build it with `corePlugins: { preflight: false }` (utilities only — core ships the single base reset; don't duplicate it) and **never** the Tailwind Play CDN. Plugins that use only core-guaranteed utilities, or ship no Tailwind, omit `styles` and are byte-for-byte unaffected. Full authoring guide + scaffold: [docs/plugin-styles.md](docs/plugin-styles.md).

`settings.server_files` is the **opt-in** for the unified Settings export/import flow (feedBack#113). It's a list of relpaths under `context["config_dir"]` that the plugin wants included in user-triggered backups. A trailing `/` denotes a directory (recurse). Plugins that omit this field have no server-side files exported; their state lives entirely in browser `localStorage`, which is bundled wholesale on every export. Rules:
- Relpaths only. Absolute paths, drive letters, `..` segments, and backslashes are rejected at load time with a `[Plugin]` warning.
- The same allowlist is consulted at both export and import: a bundle that references a file the *importing host*'s manifest no longer declares is skipped with a warning (handles plugin updates between export and import). A bundle that references a file your host's manifest never declared is also skipped — no surprise writes.
- Files are encoded as `{"encoding": "json", "data": <parsed>}` for `.json` files that parse cleanly (diff-friendly), `{"encoding": "base64", "data": "..."}` otherwise (sqlite, model blobs, IRs).
- Plugins own their internal data migration. Importing a bundle whose data schema predates your current code restores bytes verbatim — your plugin must cope at next load.
- Symlinks are skipped on export and never followed on import.

`diagnostics` is the **opt-in** for the troubleshooting bundle (feedBack#166 — Settings → Export Diagnostics). Two independent fields:
- `diagnostics.server_files` — same allowlist semantics as `settings.server_files`: relpaths under `context["config_dir"]`, no `..`, no abs paths, no backslashes, no leading dots. Files listed here are copied verbatim into `plugins/<plugin_id>/<relpath>` inside the bundle. Use this for snapshot-style state (small DB excerpts, model lists, last-error files).
- `diagnostics.callable` — `"<module>:<function>"` (e.g. `"diagnostics:collect"`). Resolved lazily via `load_sibling` when the user clicks Export, then called as `func({"plugin_id": "...", "config_dir": Path(...)})`. Return `dict`/`list` → written to `plugins/<id>/callable.json`; `bytes` → `callable.bin`; `str` → `callable.txt`. Exceptions are caught and appended to the bundle's `manifest.notes` — a buggy plugin never crashes the export.

Plugins that omit the field contribute nothing to the bundle from the backend side. Frontend plugins can independently push state via `window.feedBack.diagnostics.contribute(plugin_id, payload)` from their `screen.js` before the user hits Export. Bundle layout + per-file schemas: [docs/diagnostics-bundle-spec.md](docs/diagnostics-bundle-spec.md).

Best practices:
- Embed your own `schema` field (e.g. `"my_plugin.diag.v1"`) in JSON returned by `callable` so future tooling can dispatch by version.
- Keep payloads small (< 100 KB). Diagnostics are not a backup channel — that's `settings.server_files`.
- Don't include user secrets, API keys, or session tokens. The bundle is shared with maintainers / posted to GitHub issues.

`type` is an optional role hint (feedBack#36). Supported values:
- `"visualization"` — plugin provides a highway renderer. Declaring this makes the plugin eligible for the main-player viz picker AND splitscreen's per-panel picker. Must pair with a `window.feedBackViz_<id>` factory exporting the setRenderer contract below.
- Absent → no declared role; plugin is loaded and its script runs, but it doesn't appear in role-specific UIs.

**Backend routes** — `routes.py` must export a `setup(app, context)` function. The `context` dict provides:
- `config_dir` — persistent config path
- `get_dlc_dir()` — returns the DLC folder Path
- `extract_meta()` — metadata extraction callable
- `meta_db` — shared MetadataDB instance
- `library_providers` — shared library provider registry for source-aware browsing
- `register_library_provider(provider)` — register a plugin-provided library source. Providers expose `id`, `label`, optional `kind`/`capabilities`, and callable `query_page`, `query_artists`, `query_stats`, and `tuning_names` methods. Providers with `art.read` may also expose `get_art(song_id)` returning one of: a `Response` object (any media type, served as-is); raw `bytes` or `bytearray` (**assumed PNG** — use a `Response` or a `dict` with `content`+`media_type` keys for JPEG/WebP or other formats); a URL string (http/https → 302 redirect; other schemes are rejected with 400); a filesystem path string or `Path` (served as a file with auto-detected media type); or a `dict` with a `url`, `path`, or `content` key. Providers with `song.sync` may expose `sync_song(song_id)` returning `None` (success with no local file) or a `dict` — the dict is passed through as the JSON response and should include `filename`/`local_filename` if a local playable file was produced.
- `unregister_library_provider(provider_id)` — remove a plugin-provided library source by id. The built-in `local` provider cannot be removed.
- `get_sloppak_cache_dir()` — sloppak cache path
- `load_sibling(name)` — loads a sibling module from this plugin's directory under a unique, namespaced module name. See "Sibling imports" below.
- `log` — stdlib `logging.Logger` namespaced to `feedBack.plugin.<id>`. Pre-configured with the app-wide level, format (including JSON mode), and correlation IDs. Use this for all backend plugin output instead of `print()`. See "Backend plugin logging" below.

**Sibling imports — use `load_sibling`, not bare imports** (feedBack#33). The plugin loader inserts each plugin's directory onto `sys.path` so `from extractor import X` works, but Python caches imports by **module name** in `sys.modules`. Two plugins that each ship a top-level `extractor.py` (or any other generic name — `util.py`, `client.py`, `parser.py`, `config.py`, …) collide: whichever loads first wins, and the other plugin's `from extractor import X` either gets the wrong module or fails with `cannot import name 'X' from 'extractor'`.

The fix is `context["load_sibling"](name)`, which loads the sibling under a namespaced module name (`plugin_<id>.<name>`, where plugin_id is bijectively encoded so reverse-DNS-style ids like `com.example.foo` work without colliding: `_` -> `_5f_`, `.` -> `_2e_`) so each plugin gets its own copy:

```python
def setup(app, context):
    helper = context["load_sibling"]("helper")
    HelperClass = helper.HelperClass
    # …
```

Notes:
- `name` is a bare module name — no `.py` suffix, no slashes, no `.`. The helper raises `ValueError` for path traversal / format issues and `ImportError` for missing files.
- Both single-file siblings (`extractor.py`) and package-form siblings (`extractor/__init__.py`) work. Package form wins when both exist (matches CPython's import-resolution precedence).
- Relative imports between siblings work — `from .shared import X` in a top-level helper, `from ..shared import X` from inside a sibling package. The synthetic parent package `plugin_<id>` carries the plugin directory in its `__path__`.
- `from . import sibling` (attribute-style) also resolves: loaded children are exposed as attributes on the parent package.
- Repeat calls return the cached module. Concurrent first-time calls are serialized via per-module locks so no caller observes a half-initialized module.
- Bare `import sibling` from `routes.py` still works during the transition period, but the loader prints a startup warning when it detects two plugins shipping a same-named top-level module — covering both `.py` files and package directories. Migrate to `load_sibling` to silence the warning and immunize your plugin from future ecosystem collisions. (Don't mix bare imports and `load_sibling` for the same module — they'd execute the file twice and split module-level state.)

**Frontend scripts** — `screen.js` runs in the global scope via a `<script>` tag. It can access `window.playSong`, `window.showScreen`, `window.createHighway`, the `<audio>` element, and the `window.feedBack` event emitter.

**The playSong wrapper chain** — Plugins commonly wrap `window.playSong` to hook into song playback. Plugins load alphabetically, so the last-loaded (alphabetically later) wrapper runs first, while the alphabetically first plugin runs closest to the original. Be aware that `await` calls in inner wrappers yield to the event loop — WebSocket messages can arrive before outer wrappers finish setup.

## Plugin Best Practices

### v3 UI (fee[dB]ack v0.3.0) — player-chrome contract

v0.3.0 ships a redesigned UI behind a flag (`FEEDBACK_UI=v3` or the `/v3` route);
the classic UI (v2) stays the default until 0.3.0 ships, so **plugins must work in
both**. v3 reuses the same engine (`server.py`, `app.js`, `highway.js`, `playSong`,
`showScreen`, capabilities, library providers, the `window.feedBackViz_<id>` /
`setRenderer` contract), so a plugin's **backend, capabilities, `nav`/`screen`,
visualization renderers, diagnostics, and settings export work unchanged** — v3
surfaces `nav` in its sidebar and mounts screens exactly as v2 does.

**The only thing that changed is the player chrome.** If your plugin injects a
control into it, you must adapt:

- v2's wide always-visible `#player-controls` bar is, in v3, a **minimal
  auto-hiding transport** (fades ~2.5 s after the pointer stills during playback)
  plus a hover-reveal left icon rail. So injecting into `#player-controls` the
  legacy way means your control **auto-hides**, and the legacy insertion anchors
  (`insertBefore` the `span.text-gray-700` separator, or `button:last-child` / ✕
  Close) **don't exist in v3** → it lands wrong / unreachable.
- **Detect v3** with `window.feedBack.uiVersion === 'v3'` and **mount into
  `window.feedBack.ui.playerControlSlot()`** (a stable, always-reachable container
  — the "Plugins" rail popover) instead of `#player-controls`. Drop the dead
  anchors (append), and guard re-injection against the *actual* container
  (`controls.contains(myBtn)`), not a hard-coded `#player-controls`.
- A host `MutationObserver` re-homes legacy `#player-controls` children into the
  slot as a fallback, but it **breaks plugins that guard on
  `#player-controls.contains()`** (the moved node fails the check → re-inject every
  song). Mount into the slot yourself; don't rely on the shim.
- v3 uses `fb-*` tokens (`fb-card`, `fb-text`, `fb-textDim`, `fb-primary`,
  `fb-border`) vs v2's `dark-*`/`accent`; legacy classes still render acceptably.
  Keep `#player` overlay `z-index` ≤ the chrome layers (transport/HUD 20, rail 30,
  popovers 40).

Full guide + the canonical snippet: **[docs/plugin-v3-ui.md](docs/plugin-v3-ui.md)**.
Verify any player-injecting plugin in **both** `/` (v2) and `/v3`.

### Performance — never run DOM queries on a per-frame path

Plugins share the main thread with the highway's 60 fps render loop, and during
playback the highway + note detectors mutate the DOM ~60×/s — so anything that
*reacts* to DOM changes runs that often too. Work that looks cheap in isolation
becomes the dominant cost when it runs every frame. A profiled "the 3D highway is
laggy" report turned out to be **three plugins doing per-frame `querySelectorAll`**
(~18% of main-thread CPU + NodeList GC churn), not the renderer. The GPU was idle.

- **Never call `querySelector` / `querySelectorAll` inside `draw()`, a
  `requestAnimationFrame` loop, a short `setInterval`, or a `MutationObserver`
  callback.** Resolve the element(s) **once** when your UI mounts and cache the
  references; re-resolve only when the cached node is gone (`!el.isConnected`).
  `querySelectorAll` also allocates a fresh `NodeList` every call → GC pressure at
  60 fps. (notedetect #75 — a VU meter that `querySelector`'d its bar every tick.)

- **Scope `MutationObserver`s narrowly — never `observe(document.body, { subtree:
  true })` just to notice your own UI's container mount.** A body-subtree observer
  fires on *every* DOM mutation anywhere, including the per-frame highway churn, so
  a callback that then scans the document is a per-frame full-DOM scan. Observe the
  specific container; if it's swapped on screen changes, observe a stable parent,
  or **cheaply early-bail** (one `getElementById` / a screen-state check) *before*
  the expensive work. (sloppak-converter #32 — a body-subtree observer re-ran
  whole-document inject sweeps on every frame of playback.)

- **Stop playback-tied loops when their UI is hidden.** An rAF/interval meter (VU,
  etc.) that keeps drawing while its panel is closed is pure waste — gate it on
  visibility, or stop and restart it on open/close.

- **Per-instance, not global.** Under splitscreen a viz/detector plugin runs
  multiple instances. Cache refs and resolve panels against your *own* instance's
  container, never a global `document.querySelector` that could grab a sibling
  instance's node. (notedetect #75 follow-up.)

These are cheap to get right up front and expensive to retrofit. Profile the
**main thread**, not the GPU, when a renderer "feels laggy" — the offender is
usually an unrelated plugin's per-frame DOM work.

### Visualization plugins — two complementary contracts

FeedBack supports two ways for a plugin to participate in the main player's visuals. They coexist; the setRenderer contract is the default for any viz that draws a highway-shaped surface, and overlays handle layered decorations on top.

**Pick the right shape:**
- Replacing the whole highway drawing on the existing highway canvas (your renderer owns its rendering context / resources; `createHighway()` still owns the canvas element and the rAF loop)? → **setRenderer** (section 1). Enters the viz picker. Works in both the main player and per-panel under splitscreen.
- Adding a layer on top of whichever viz is active? → **Overlay** (section 2). Navbar toggle, not in the picker.

#### 1. setRenderer contract (feedBack#36) — preferred

Plugins that want to replace the main highway's draw function (per panel, per session) export a renderer factory on `window.feedBackViz_<id>` where `<id>` matches the `id` in `plugin.json` (`type: "visualization"` required). The factory returns an object matching this shape:

```js
window.feedBackViz_my_viz = function () {
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
            // bundle.getNoteState(note, chartTime) (feedBack#254) — call
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

**Lifecycle contract.** The factory returns a single renderer instance that may go through multiple `init() → ... → destroy()` cycles as the user navigates between songs or screens. Specifically:

- `init(canvas, bundle)` runs when the highway has a canvas and the renderer takes over drawing. This is when to acquire `getContext()`, build shaders / meshes / DOM nodes, and register listeners.
- `draw(bundle)` runs on every rAF frame once the WebSocket `ready` message has fired and until the renderer is replaced or the highway stops. It is **not** called during the loading / reconnect window (between `api.init()` + `stop()` and the next `ready`) — that would hand the renderer half-populated chart arrays. Renderers that want to show a "loading" state can read `bundle.isReady` inside a future-widened contract, but today the factory gates `draw` behind the ready flag and `isReady` is only informational once it does fire.
- `destroy()` runs when the renderer is replaced via another `setRenderer(...)` call, OR when `highway.stop()` is called (e.g. the user navigates away from the player). It releases everything `init()` acquired.
- **After `destroy()`, the same instance may receive another `init()` call** — this happens on `playSong()` which does `stop()` → `init()` to reuse the same canvas element for the next song. Renderers must tolerate `init()` being called again on an instance that was previously destroyed. Practically: null your refs in destroy, re-acquire them in init.
- `destroy()` is skipped when it would run on an un-init'd renderer — if a caller does `setRenderer(x)` before the highway ever init'd (possible when restoring a saved picker selection at page load), `x.destroy()` is not called until `x.init()` has run at least once.
- `resize(w, h)` is optional; runs after init and whenever the canvas dimensions change.

**Key rules:**
- The factory **returns a fresh object on each call** — important for splitscreen, where multiple panels will each get an independent instance.
- The renderer **owns its own rendering context** (2D or WebGL). Factory will not call getContext for you.
- **Canvas context-type swapping.** Browsers lock a `<canvas>` to the first context type successfully acquired for its lifetime: once `getContext('2d')` succeeds, `getContext('webgl2')` on that same canvas returns `null`, and vice versa. To let arbitrary 2D ⇄ WebGL renderer swaps work mid-session, `highway.setRenderer()` reads the next renderer's `contextType` before calling its `init()` and, if it differs from the type currently bound, replaces the underlying `<canvas>` element with a fresh one via `oldCanvas.cloneNode(false)` followed by `oldCanvas.replaceWith(newCanvas)`. The factory then calls the renderer's `init(newCanvas, bundle)` with the fresh element so its `getContext()` succeeds. Practical implications:
  - **What survives the swap.** `cloneNode(false)` preserves *every HTML attribute* on the element — `id`, `class`, inline `style`, all `data-*` and `aria-*` attributes, `role`, `tabindex`, the attribute form of `width`/`height`, and anything else a plugin attached. DOM position is preserved by `replaceWith()`, so siblings, parents, and surrounding layout are unaffected.
  - **What does NOT survive.** Event listeners attached via `addEventListener` are NOT cloned, and expando properties set imperatively on the JavaScript object (such as the bound rendering context, or any `canvas._myPlugin = …`-style data a plugin attached) are not carried over either. The bound rendering context being left behind on the detached element is exactly what allows the new canvas to start fresh and accept a different `getContext()` call. Note: `canvas.width`/`canvas.height` *are* reflected HTML attributes, so those values do survive the clone; `api.resize()` re-applies the backing-store dimensions on the new element after the swap regardless.
  - Renderers must **declare `contextType`** on the returned instance (`'2d'` or `'webgl2'`; absent → `'2d'`). Factories may also expose it as a static (`window.feedBackViz_<id>.contextType = 'webgl2'`) so core can read it before constructing the renderer — used today by Auto-mode evaluation.
  - Plugins that hold a stale reference to the highway canvas across renderer swaps — including any code that registered listeners directly on the canvas element rather than on `window`/`document` — should listen for the `highway:canvas-replaced` event on `window.feedBack` and re-acquire / re-register. `window.feedBack.emit` dispatches a `CustomEvent`, so the payload `{ oldCanvas, newCanvas, contextType }` lives on `event.detail`, not on the event object itself:
    ```js
    window.feedBack.on('highway:canvas-replaced', (event) => {
        const { oldCanvas, newCanvas, contextType } = event.detail;
        // re-acquire / re-register against newCanvas
    });
    ```
    Plugins that re-query `document.getElementById('highway')` lazily inside their own event handlers don't need this listener — they pick up the new element automatically (it keeps `id="highway"`).
  - **`highway:visibility`** — fired on `window.feedBack` whenever the highway canvas transitions between displayed and hidden. Detection is DOM-based via `canvas.offsetParent === null` (catches `display:none` on the canvas or any ancestor — e.g. splitscreen's `#highway` hide) or whatever a host explicitly sets via `highway.setVisible(bool)`. While `visible === false`, core skips the rAF `renderer.draw(bundle)` call AND the default 2D draw, so renderers don't have to no-op themselves. The event is emitted only on transitions (including the first one after `init()`), not every frame. Payload `{ visible, canvas }` lives on `event.detail`:
    ```js
    window.feedBack.on('highway:visibility', (event) => {
        const { visible, canvas } = event.detail;
        // Toggle any sibling DOM your renderer mounts. The 3D Highway
        // renderer hides its `.h3d-wrap` overlay here so `display:none`
        // on `#highway` actually hides the visible output.
    });
    ```
    Renderers that only paint to the feedBack canvas don't need this listener — the rAF skip is enough. Renderers that mount sibling DOM (separate WebGL contexts, overlays, etc.) do.
  - **`highway.setVisible(bool | null)`** — forces the visibility state regardless of `offsetParent`. Pass `null` to clear the override and resume DOM-based detection. Useful when the host hides the highway via `visibility:hidden`, `opacity:0`, transforms, or clipping rather than `display:none`. The override re-emits any resulting transition immediately rather than waiting for the next rAF tick.
  - Default-renderer ctx is closure-cached. The replace path nulls the closure ctx so stale draw paths short-circuit; the next default-renderer `init()` re-acquires the 2D context from the new canvas cleanly.
- `draw(bundle)` receives difficulty-filtered arrays — never read from `_filteredNotes` or other internals.
- `_drawHooks` fire for the default 2D renderer (the factory calls them at the end of each frame). Custom WebGL renderers that maintain a 2D overlay canvas (like the bundled 3D highway) also call `window.highway.fireDrawHooks(ctx, W, H)` on that overlay so overlay plugins continue to work regardless of which renderer is active. Custom renderers without a 2D overlay context should not attempt to fire hooks.

**Auto mode — `matchesArrangement(songInfo)` (optional).**

The viz picker prepends an "Auto (match arrangement)" entry that is the default selection on fresh installs. When Auto is active, core evaluates registered viz factories on every `song:ready` and swaps the renderer to the first factory whose `matchesArrangement(songInfo)` predicate returns truthy. No match → the built-in 2D highway.

Declare the predicate as a static on the factory (not the instance) so core can evaluate it without constructing a throwaway renderer:

```js
window.feedBackViz_piano = function () { /* ... */ };
window.feedBackViz_piano.matchesArrangement = function (songInfo) {
    return /keys|piano|synth/i.test((songInfo && songInfo.arrangement) || '');
};
```

- `songInfo` is the highway's live song_info snapshot — `arrangement`, `tuning`, `capo`, `centOffset`, `arrangement_index`, `filename`, `artist`, `title`, etc. May be `{}` before the first song loads.
- Factories without `matchesArrangement` are skipped during auto-selection — the correct default for arrangement-agnostic viz (tabview, jumpingtab) that only make sense as manual picks.
- Explicit picker selections override Auto and are persisted to `localStorage.vizSelection`, so the pinned choice survives page reloads until the user switches back to "Auto" (which also persists). Picking "Auto" re-evaluates against the current song immediately. In contexts where `localStorage` is unavailable (private mode, sandboxed iframes, some test runners) persistence falls back to the current picker `<option>` value, which still overrides Auto for as long as the page stays loaded.
- When an Auto-selected renderer fails and core emits `viz:reverted`, the picker falls back to the built-in default and disables auto-switching until the user re-selects Auto.
- First match wins (picker order), so the registration order of plugins is the tiebreaker. Keep predicates narrow to avoid stealing songs from more specialized viz.

**WebGL viz in Auto mode.** Auto evaluation runs on every `song:ready` regardless of which renderer is active. Auto-installing a WebGL renderer when the canvas is currently 2D — or reverting from a WebGL Auto pick to the default 2D — works without a reload because `setRenderer` swaps the canvas element when `contextType` differs (see "Canvas context-type swapping" above). WebGL viz can therefore safely declare `matchesArrangement` and rely on Auto. For 3D Highway specifically, `_canRun3D()` in app.js still gates Auto from picking it on machines without WebGL2 — that fallback is independent of canvas swapping.

**Per-instance settings for host plugins (feedBack#849).** A viz provider may declare per-instance controls a consuming host (e.g. splitscreen's per-panel popover) renders generically, by adding a `settings` array to its `capabilities.visualization` manifest block: `[{ key, label, type: "toggle" | "range" | "select", default, min?, max?, step?, options? }]`. This is the capability-native, declarative replacement for the ad-hoc `factory.panelControls` static. The validated list is surfaced through the visualization host's `list-providers` snapshot, so a host reads it without knowing the plugin. **A provider that declares `settings` MUST implement `applySetting(key, value)` on its renderer instance** — the host calls it on the specific per-panel instance, which is inherently per-panel (no canvas→panel resolution, no shared global localStorage keys). `getSetting(key)` is optional (the host falls back to the declared `default`); the host owns persistence. `factory.panelControls` remains read as a legacy fallback for hosts that still consume it, but new viz should declare `settings` + `applySetting`.

#### 2. Overlay contract — for add-on layers

Plugins that add a layer on top of whichever visualization is active — HUDs, fretboard diagrams, chord labels, practice feedback — don't replace the renderer. They manage their own canvas, their own rAF loop, and a toggle button somewhere visible (typically a navbar pill), reading public highway state via the getters:

- `highway.getTime()` / `highway.getBeats()` — current playback position
- `highway.getNotes()` / `highway.getChords()` — raw arrays containing every note/chord in the chart regardless of the current difficulty level
- `highway.getFilteredNotes()` / `highway.getFilteredChords()` — difficulty-filtered variants. Returns the master-difficulty-filtered arrays when the song has phrase-level data (slider active); falls through to the raw arrays for songs with a single difficulty level (slider disabled). Plugins that process only the notes the player is currently expected to play should use these instead of `getNotes()` / `getChords()`
- `highway.hasPhraseData()` — returns `true` when the current song has phrase-level difficulty ladder data (i.e. the mastery slider is active and `getFilteredNotes()` / `getFilteredChords()` return a filtered subset). Use this to gate logic that only makes sense when difficulty filtering is available
- `highway.getPhrases()` — phrase timing windows `[{ index, start_time, end_time, max_difficulty }]` for the current song's difficulty ladder. Returns `null` when phrase data is absent (GP imports, single-difficulty charts). Read-only; do not mutate. Pair with `hasPhraseData()` to gate phrase-aware logic.
- `highway.getMastery()` — current master-difficulty slider value as a fraction `0..1`. Reflects the same value the mastery slider is set to; meaningful only when `hasPhraseData()` is true.
- `highway.getChordTemplates()` — chord shape lookup table; index by `chord.id` from `getChords()` to get `{ name, fingers, frets }`. `fingers` and `frets` are per-string arrays (length matches the tuning's string count); within `fingers`, `-1` = unused, `0` = open string, `n > 0` = finger number. arrangement XML sources populate real fingerings; GP imports currently emit all `-1` since pre-import sources don't carry finger data. Not filter-aware: templates are static metadata, every `chord_id` referenced by `getChords()` is guaranteed valid
- `highway.getSongInfo()` — tuning, arrangement, capo
- `highway.getStringCount()` — number of strings on the active arrangement (4 for bass, 6 for guitar, 7+ for extended-range GP imports). Derived server-side as `max(notes-max-string + 1, name-based fallback, len(tuning))` where the tuning length only contributes when it isn't the arrangement XML padded 6-string form (sloppak / GP-imported sources carry trimmed tuning lengths). The name-based fallback is 4 for arrangements containing "bass" (case-insensitive) and 6 otherwise. This combination handles partial-string-usage charts (a 6-string lead that never plays string 5), extended-range GP imports (5-string bass, 7-string guitar), and sloppaks that explicitly encode the instrument range — without requiring plugins to do their own arrangement-name matching
- `highway.getLefty()` / `highway.getInverted()` — mirror + invert state

Overlays do NOT appear in the viz picker and do NOT declare `"type": "visualization"` in `plugin.json`. They coexist with whichever renderer (default 2D, 3D highway, piano, ...) the user has picked.

**Key rules:**
- **Own your rAF + canvas** — don't piggyback on `_drawHooks` or on `createHighway`'s rendering context. Draw hooks fire for the default 2D renderer and for custom renderers that explicitly call `window.highway.fireDrawHooks(ctx, W, H)` (e.g. the bundled 3D highway fires them on its 2D overlay canvas), but not for every custom renderer.
- **Re-read state every frame** — overlay output must track whatever the current renderer is drawing. Don't cache note positions across frames.
- **Respect lefty + invert toggles** — if the overlay depicts strings or frets, mirror using the same transforms the active renderer would.
- **If you position with `highway.project` / `highway.fretX` (the 2D-highway geometry), gate on `highway.isDefaultRenderer()`** — those helpers describe the *built-in 2D* highway's depth curve and fret zoom. When a custom renderer (3D highway, piano, …) is active your draw hook still fires (on that renderer's 2D overlay layer), but those coordinates won't match its scene — markers land in arbitrary places. Skip rendering when `isDefaultRenderer()` is false; the custom renderer owns that feedback. Renderer-agnostic overlays (fretboard diagram, chord-label HUD — they use `getNotes()`/`getChordTemplates()` + their own layout) don't need this guard.
- **Clean up on toggle-off** — cancel rAF and remove/hide the overlay canvas so inactive overlays aren't wasting frames.

Reference: [fretboard plugin](https://github.com/got-feedback/feedBack-plugin-fretboard) — canonical overlay implementation (navbar toggle, own canvas, 80ms active-note window).

**Why two?** setRenderer plugs into an existing highway — main-player or splitscreen-panel — reusing its WebSocket and data parsing, so the common "I want a different look for the same data" case is zero boilerplate AND multi-instance for free. Overlays compose with whatever renderer is active — they decorate rather than replace, so multiple can stack (fretboard + chord labels + practice feedback) without fighting over the canvas.

A previous standalone-pane contract (`window.createMyVisualization({ container })` with its own WebSocket per pane) was used by splitscreen pre-Wave-C. It's been retired now that splitscreen calls `setRenderer` on per-panel `createHighway()` instances; if you find references in older plugin docs or external integration guides, those describe the legacy path.

#### 3. Note-state provider — for scorers that want renderers to "light up" notes (feedBack#254)

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

### Audio mixer fader registration (feedBack#87)

Plugins that produce audio outside the song's `<audio>` element (NAM amp output, synth voices, etc.) can register a labeled fader so users can balance them against the song from one mixer popover in the player controls.

```js
function _registerFader() {
    const api = window.feedBack && window.feedBack.audio;
    if (!api) return;
    api.registerFader({
        id: 'my_plugin',           // unique key
        label: 'My Plugin',        // shown above the fader
        unit: 'dB',                // optional suffix shown next to the value (e.g. '%', 'dB')
        min: 0, max: 2, step: 0.05,
        defaultValue: 1.0,
        getValue: () => _myCurrentVolume,        // read current value
        setValue: (v) => _setMyVolume(v),         // write + persist + apply
    });
}

if (window.feedBack && window.feedBack.audio) {
    _registerFader();
} else {
    window.addEventListener('feedBack:audio:ready', _registerFader, { once: true });
}
```

The plugin owns persistence — the registry calls `getValue()` when the popover opens, and also after each `setValue()` during slider drags to re-sync the displayed value. Keep `getValue()` cheap and side-effect-free, and make sure `setValue()` updates whatever backing state `getValue()` reads synchronously. Pair `setValue` with whatever your plugin already does internally (write the GainNode, persist to localStorage, update any in-plugin label). Use `unregisterFader(id)` when your plugin is teardown-able and you want the strip to disappear; otherwise keep it registered so the user's setting persists across toggle states.

### Backend plugin logging

Use `context["log"]` for all backend plugin output. It is a stdlib `logging.Logger` namespaced to `feedBack.plugin.<id>`, pre-configured with the app-wide level, format (including JSON mode), and correlation IDs. Never use `print()` — it bypasses correlation context and log rotation.

```python
def setup(app, context):
    log = context["log"]
    log.info("plugin ready")
    log.warning("optional dependency %r not found, feature disabled", dep)
    try:
        risky_init()
    except Exception:
        log.exception("unhandled error during setup")  # auto-captures traceback
```

For CLI entry points (scripts that also run as `__main__`), add a stdlib fallback so the logger works without the server pipeline:

```python
if __name__ == "__main__":
    import logging
    logging.basicConfig(level=logging.INFO, format="%(levelname)s %(message)s")
```

### Diagnostics contribution from frontend (feedBack#166)

Plugins that hold useful debug state in the browser (active model name, last user input, internal counters) can push it into the diagnostics bundle by calling `window.feedBack.diagnostics.contribute(plugin_id, payload)` at any time. The contribution API is idempotent — repeated calls overwrite the previous value. Whatever was last contributed before the user hits Export Diagnostics is what lands in `plugins/<plugin_id>/client.json`.

```js
window.feedBack.diagnostics.contribute('my_plugin', {
    schema: 'my_plugin.client_diag.v1',
    active_preset: getActivePreset(),
    last_error: _lastError,
});
```

Loaded from `static/diagnostics.js` ASAP in `<head>` so the console-wrap is in place before any other script runs. Available on the `window.feedBack.diagnostics` namespace alongside `snapshotConsole()`, `snapshotHardware()`, `snapshotUa()`, `snapshotLocalStorage()`, `snapshotContributions()`. Keep your payload small (< 100 KB) and don't include secrets — bundles are shared with maintainers.

### Keyboard Shortcuts

Plugins can register keyboard shortcuts via the global `window.registerShortcut()` function. Shortcuts appear in the `?` help panel.

```js
window.registerShortcut({
    key: 'k',                       // key value (e.key) or key code (e.code)
    description: 'Toggle my view',  // shown in the help panel
    scope: 'player',                // 'global' | 'player' | 'library' | 'settings' | 'plugin-{id}'
    condition: () => _isMyViewActive, // optional guard
    handler: (e) => _myAction()      // called when shortcut triggers
});
```

**Scope** controls when the shortcut is active:
- `global` — works on any screen
- `player` — only on the player screen
- `library` — only on the home/favorites screens
- `settings` — only on the settings screen
- `plugin-{id}` — only when your plugin's screen is active

**Panel-scoped shortcuts:** For plugins that create multiple panels (e.g., splitscreen), shortcuts are automatically scoped to the active panel. Use `const panel = window.createShortcutPanel(id)` to create a panel (it returns the panel object — keep the reference so you can call `panel.clearShortcuts()` during cleanup) and `window.setActiveShortcutPanel(id)` to switch between them. Each panel has its own shortcut registry, so multiple panels can have the same key without collisions.

**Condition** is an optional guard function. If it returns false, the shortcut is skipped even if in scope.

**Key matching:** The handler matches against both `e.key` (character produced) and `e.code` (physical key). Use `e.key` for letters/symbols that depend on keyboard layout, and `e.code` for special keys (e.g. `Space`, `ArrowLeft`).

**Built-in shortcuts:**

| Key | Description |
|-----|-------------|
| `?` | Show keyboard shortcuts panel (global) |
| `Space` | Play/Pause (player only) |
| `←` / `→` | Seek ±5 seconds (player only) |
| `Escape` | Back to library (player only) |
| `[` / `]` | Audio offset ±10ms (Shift: ±50ms) (player only) |

**Debugging:** Open browser console and type `_listShortcuts()` to inspect registered shortcuts.

### General plugin guidelines

- Wrap your plugin code in an IIFE: `(function () { 'use strict'; ... })();`
- Use `localStorage` for user-facing settings, prefixed with your plugin id
- If hooking `window.playSong`, always call the original and `await` it
- If hooking `window.showScreen`, clean up your state when leaving the player screen
- Use `window.feedBack.emit()` / `window.feedBack.on()` for inter-plugin communication
- Use `window.registerShortcut()` to add keyboard shortcuts. Clean up with `window.unregisterShortcut(key, scope)` — pass the same scope you registered with, since the default is `'global'` and won't match `player`/`library`/`settings`/`plugin-*` bindings. For panel-scoped shortcuts, prefer `panel.clearShortcuts()`.

## Song Formats

FeedBack supports two song formats:

### Loose folder (XML charts)
A directory containing arrangement XML plus an audio file (and optional `manifest.json` + album art). Discovered, indexed, and played directly — see `lib/loosefolder.py`. Metadata follows a `manifest.json` → XML tags → folder-name priority chain. Songs are tagged `format: "loose"` in the library.

### Sloppak (open format)
An open, hand-editable song package designed for FeedBack. Exists in two interchangeable forms:
- **Zip archive** (`.sloppak` file) — distribution form
- **Directory** (`.sloppak/` folder) — authoring form

**Contents:**
```
manifest.yaml          Song metadata (title, artist, album, duration, tuning, arrangement IDs, ...)
arrangements/
  lead.json            Note/chord/anchor data in wire format (see song.py)
  rhythm.json          Files here are driven by manifest.yaml arrangement entries
  ...                  (e.g. arrangements/<arrangement-id>.json)
stems/
  full.ogg             Mixed audio (always present)
  guitar.ogg           Individual stems (optional, from Demucs split)
  bass.ogg
  drums.ogg
  vocals.ogg
  piano.ogg
  other.ogg
cover.jpg              Album art (optional)
lyrics.json            Syllable-level lyrics (optional)
```

Sloppak is the preferred format for new features. The [Stems plugin](https://github.com/topkoa/feedBack-plugin-stems) provides live stem mixing for sloppak songs.

**Full developer reference:** the authoritative format spec now lives in its own repo —
[got-feedback/feedpak-spec](https://github.com/got-feedback/feedpak-spec)
([`spec/feedpak-v1.md`](https://github.com/got-feedback/feedpak-spec/blob/main/spec/feedpak-v1.md)):
manifest schema, arrangement wire format, and how to extend the format with new data types (drum
tab, key/scale annotations, etc.). Published as **feedpak**; this codebase still uses the legacy
**sloppak** name internally — same on-disk format. [docs/sloppak-spec.md](docs/sloppak-spec.md) is
a local pointer + code map.

**Key code:**
- `lib/sloppak.py` — format detection, zip/directory resolution, metadata extraction, song loading
- `lib/sloppak_convert.py` — sloppak assembly pipeline, Demucs stem splitting
- `lib/song.py` — shared data models (`Note`, `Chord`, `Arrangement`, `Song`) and wire format serialization used by both formats

## Frontend Conventions

- **No frameworks** — vanilla JS, fetch API, DOM manipulation
- **Globals** — `highway`, `audio`, `playSong()`, `showScreen()`, `createHighway()`, `window.feedBack`
- **Storage** — `localStorage` for all user preferences
- **Styling** — Tailwind CSS utility classes, dark theme (`bg-dark-600`, `text-gray-300`, accent `#4080e0`, gold `#e8c040`). Tailwind is served as a **prebuilt** stylesheet (`static/tailwind.min.css`, regenerated by `bash scripts/build-tailwind.sh`), **never** the runtime Play CDN — the CDN's on-the-fly JIT rescanned the DOM on the main thread and dropped ~26% of frames with the 3D highway (feedBack-desktop#110). The committed CSS only contains classes the build scanner saw, so CI (`tailwind-fresh`) rebuilds and diffs it; run the build script and commit when you add new classes. A plugin that uses classes not guaranteed in core (notably arbitrary values like `w-[37px]`) MUST ship its own compiled stylesheet via the `styles` manifest key, built with `corePlugins.preflight = false` (utilities only — core ships the one base reset). Plugins MUST NOT load the Tailwind Play CDN or any runtime CSS JIT. See constitution Principle II.
- **Naming** — camelCase for JS functions, kebab-case for CSS classes, snake_case for plugin IDs
- **Player layout** — `#player` is `display:flex; flex-direction:column; position:fixed; inset:0`. `#highway` is `flex:1`. `#player-controls` sits at the bottom. Hiding the highway collapses the layout — use `margin-top: auto` on controls if you need to hide it.

## Backend Conventions

- **Framework** — FastAPI with uvicorn
- **Imports** — flat imports from `lib/` (no package `__init__.py`): `from song import Song`
- **Database** — SQLite via MetadataDB class with `threading.Lock` for thread safety
- **WebSocket** — JSON frames, try/except `WebSocketDisconnect`
- **Error handling** — graceful fallbacks (audio conversion errors don't crash the song, missing art returns placeholder)
- **Type hints** — used sparingly (`Path | None`, `dict`, `list`)
- **Docstrings** — minimal; code is self-documenting

## Testing

```bash
pytest                         # Run all tests
pytest tests/test_song.py -v   # Specific file
pytest -k "round_trip" -v      # Pattern match
```

- Framework: pytest
- Config: `pyproject.toml` sets `pythonpath = [".", "lib"]` and `testpaths = ["tests"]`
- CI: GitHub Actions runs pytest on push/PR to main (Python 3.12)
- Test dependencies: `requirements-test.txt`

## Tuning the note_detect plugin

Detection quality is hard to judge by eye — a player UI that "feels worse" after a code change isn't a regression you can defend in review. The plugin ships with a record-replay-sweep workflow so changes to the detector, the matcher, or the user's environment (A/V offset, latency, channel) can be measured against a single reference take.

Quick orientation:
- **Reference recording** lives in the gear popover on the player (gated behind Settings → Note Detection → "Detection tuning (advanced)"). Arm before pressing Play; auto-saves a WAV to `static/note_detect_recordings/` on song-end. The directory is bind-mounted, so the host-side harness can read it without a copy step.
- **Benchmark sloppak** ships in-tree at [docs/benchmarks/note_detect_v1/note_detect_benchmark_v1.sloppak](docs/benchmarks/note_detect_v1/note_detect_benchmark_v1.sloppak) — 8 sections each isolating a different failure mode (low-freq mono, sustained holds, hammer/pull, power chords, dense open chords, bends). Drop it directly into your sloppak DLC folder to install (don't rename — feedBack keys off the `.sloppak` suffix even though the file is a zip under the hood). The unzipped form lands at `static/sloppak_cache/note_detect_benchmark_v1.sloppak/` after first play. Builder: [docs/benchmarks/note_detect_v1/build_benchmark.py](docs/benchmarks/note_detect_v1/build_benchmark.py).
- **Headless harness** at [`tools/harness.js`](https://github.com/got-feedback/feedBack-plugin-notedetect/blob/main/tools/harness.js) in the note_detect plugin's own repo (cloned into `plugins/note_detect/` locally) runs the same `processFrame` / `matchNotes` / `checkMisses` code path off Node, in seconds per run. Same `note_detect.diagnostic.v1` schema as the in-app Download Diagnostic button.
- **A/V auto-calibrate** (Settings → Note Detection) reads `timing_error_ms_hits.median` and proposes the av-offset that drives it to zero. Iterative: usually converges in 2–3 Apply rounds.

**Always record at 1.0× playback speed** — half-speed takes produce all-miss garbage because chart times are absolute. **Always use `timing_error_ms_hits` (not all-matched) as a calibration signal** — the all-matched median pins near a constant when the offset is wrong, because the matcher silently snaps to neighbouring chart notes.

Full developer reference (workflow recipes, harness flag table, diagnostic schema, common pitfalls): [docs/note-detect-tuning.md](docs/note-detect-tuning.md).

## Versioning

- **`VERSION`** (repo root) — single source of truth; plain semver string (e.g. `0.2.4`). Bind-mounted into the container and copied by the Dockerfile so it's always available at `/app/VERSION`.
- **`GET /api/version`** — returns `{"version": "<contents of VERSION>", "source_url": "...", "license_url": "..."}`. The version drives the navbar badge; `source_url` / `license_url` populate the Settings → About links. `source_url` is configurable via the `APP_SOURCE_URL` env var (default `https://github.com/got-feedback/feedBack`); `license_url` falls back to `source_url + "/blob/main/LICENSE"` (GitHub-style, default branch `main`) and is overridable via the `APP_LICENSE_URL` env var — set it explicitly when the source is hosted on a non-GitHub forge (GitLab/Gitea/self-hosted) or under a non-`main` default branch. Both env values must be `http(s)`; non-http(s) values are rejected and fall back to the safe default to prevent `javascript:`/`data:` hrefs.
- **Auto-sync** — `.github/workflows/sync-version.yml` rewrites `VERSION` via a `repository_dispatch` (`desktop-released`) fired from `feedBack-desktop`'s release job. As an explicit automation-only exception to the "Never push directly to main" rule in Git Workflow below, the sync job commits straight to `main` as `github-actions[bot]` (version bumps are mechanical; the PR round-trip adds no signal). Human contributors must still go through feature branches + PRs. No manual VERSION edits needed. Use the workflow's `workflow_dispatch` trigger with `version: X.Y.Z` for manual runs (recovery / out-of-band bumps).
- **`CHANGELOG.md`** — follows [Keep a Changelog](https://keepachangelog.com/) format. Update the `[Unreleased]` section with each PR; when `feedBack-desktop` cuts a release, rename `[Unreleased]` to the new version + date (the VERSION bump itself is automated).

## Git Workflow

- **Never push directly to main** — always create a feature branch and open a PR
- **Upstream remote** — set `upstream` to the canonical FeedBack repository; `origin` is your fork
- **Plugins are gitlinks** — each plugin in `plugins/` is typically its own git repo (submodule or clone). Branch switches on the main repo can clobber plugin directories. Use `git update-index --assume-unchanged` for plugin dirs if needed.
- **Commit style** — short imperative subject line, blank line, then body explaining *why*

## WebSocket Protocol Reference

The highway WebSocket at `/ws/highway/{filename}?arrangement={index}` streams these messages in order:

| Message | Shape | Description |
|---------|-------|-------------|
| `loading` | `{ type: 'loading', stage }` | Status/progress message during extraction or conversion |
| `song_info` | `{ type, title, artist, arrangement, arrangement_index, arrangements, duration, tuning, capo, centOffset, format, audio_url, audio_error, stems }` | Song metadata. `arrangements` is the full list for the switcher. `audio_url` is `null` when audio is unavailable, in which case `audio_error` is non-null; otherwise `audio_error` is `null`. `stems` is always present — an empty array for non-sloppak songs or sloppak songs with no split stems. `tuning` is an array (6 for guitar, 4 for bass). `centOffset` is a float (cents) from the RS2014 `<centOffset>` field — commonly `-1200.0` for extended-range bass (one octave down), small non-zero values for true-tuned content (e.g. A443 ≈ +11.8 cents), `0.0` when absent. Available via `getSongInfo().centOffset`. |
| `beats` | `{ type, data: [{ time, measure }] }` | Beat timestamps with measure numbers |
| `sections` | `{ type, data: [{ time, name }] }` | Named sections (Intro, Verse, Chorus, etc.) |
| `anchors` | `{ type, data: [{ time, fret, width }] }` | Fret zoom anchors |
| `chord_templates` | `{ type, data: [{ name, frets: [6] }] }` | Named chord shapes |
| `lyrics` | `{ type, data: [{ w, t, d }], source }` | Syllables: `w`=word, `t`=time, `d`=duration. `-` joins to previous, `+` = line break. `source` is one of `"xml"`, `"whisperx"`, `"user"` — UI can use it to render an "auto-transcribed" badge for `whisperx`. Sloppaks always include `source` (legacy sloppaks without a `lyrics_source` manifest key default to `"xml"` at load time). Loose folders set it based on which extractor matched. Absent only when no lyrics fired the message at all |
| `tone_changes` | `{ type: 'tone_changes', base, data: [{ time, name }] }` | Optional — tone change events relative to the arrangement base tone; only sent if tones were found |
| `notes` | `{ type, data: [{ t, s, f, sus, ho, po, sl, bn, ... }] }` | Single notes |
| `chords` | `{ type, data: [{ t, notes: [{ s, f, sus, ... }] }] }` | Chord events |
| `phrases` | `{ type, data: [{ start_time, end_time, max_difficulty, levels: [{ difficulty, notes, chords, anchors, handshapes }] }], total }` | Optional — per-phrase difficulty ladder for master-difficulty slider (feedBack#48). Only sent when the source chart carries multi-level phrase data (phrase-aware sloppak). Sent in chunks (`data` is a batch, `total` is the full count across messages) to avoid multi-MB single frames. Absent for GP imports and legacy sloppak; consumers must treat missing message as "single fixed difficulty — slider disabled". |
| `ready` | `{ type: 'ready' }` | All data sent — safe to finalize and start rendering |

Message delivery is incremental. You may receive `loading` updates and `lyrics` before note/chord payloads; `tone_changes` comes after `lyrics` when present and may be omitted entirely. Do not finalize rendering until you receive `ready`.

## Common Pitfalls

1. **playSong wrapper race condition** — The wrapper chain runs outermost-first (last-loaded wrapper runs first). If an inner plugin (e.g. `3dhighway`) does `await import(CDN)`, it yields to the event loop. WebSocket messages (`song_info`, `ready`) can arrive before outer plugins set their callbacks. Use `getSongInfo()` as a fallback rather than relying solely on `_onReady`.

2. **Plugin gitlinks** — Plugins are separate git repos cloned into `plugins/`. Switching branches on the main repo can delete or clobber these directories. Be careful with `git checkout` and `git clean`.

3. **Highway flex layout** — `#highway` has `flex:1` in the player. Hiding it with `display:none` removes the flex child, causing `#player-controls` to float to the top. If you hide the highway, add `margin-top: auto` to the controls div to keep it at the bottom.

4. **Multiple WebSocket connections** — The server supports many simultaneous WebSocket connections to the same song. Split screen panels, lyrics panes, and jumping tab panes each open their own. This is by design — don't try to multiplex.

5. **Plugin load order** — Plugins load alphabetically by directory name. This determines the `playSong` wrapper chain order and which plugin's UI elements appear first. If your plugin depends on another's globals, check at runtime (`typeof window.X === 'function'`), not at load time.
