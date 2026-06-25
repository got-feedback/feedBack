# 3D Highway Plugin — AI Maintainer Guide

This guide tells future AI assistants where each visual element lives in `screen.js`, what controls it, and the gotchas to watch for. The goal is for small polishes (color tweaks, sizing, animation timing, add/remove a label) to land in the right place on the first try without grep spelunking.

The whole renderer is **one file** — `screen.js`, wrapped in an IIFE, registered as `window.feedBackViz_highway_3d` (a feedBack#36 setRenderer factory). No imports beyond Three.js loaded from the vendored `/static/vendor/three/three.module.min.js` (pinned r170; swapped from CDN when bundled into core).

**Styling (feedBack `styles` capability).** This plugin owns its Tailwind CSS: it ships `assets/plugin.css` and declares `"styles": "assets/plugin.css"` in `plugin.json`, so core's prebuilt `static/tailwind.min.css` no longer scans it (it's excluded from core's content globs). The frontend injects `assets/plugin.css` as a `<link>` when the renderer activates. This is the one maintainer-time build step: after you add/change a Tailwind class in `screen.js` or `settings.html`, run `bash build-tailwind.sh` (pinned `tailwindcss@3.4.19`, `corePlugins.preflight=false` — utilities only) and **bump the `version` in `plugin.json`** so the injected `<link>`'s `?v=` cache-buster fetches the fresh file. The generated `assets/plugin.css` is committed; end users never build. See [docs/plugin-styles.md](../../docs/plugin-styles.md).

> **Navigation note:** This guide references functions by name and uses the existing banner comments (`/* ── Scene initialisation ─ */`, etc.) as section anchors. Line numbers are deliberately avoided so this stays correct as the file evolves. Use `Grep` for the function name or banner text to jump to a section.

## File structure at a glance

The file is laid out top-to-bottom as:

1. **Constants block** — palette (`S_COL`), scale (`SCALE`, `K`), fret/string counts, geometry sizes, camera, fog
2. **Pure helpers** — `fretX`, `fretMid`, `dZ`, `computeBPM`
3. **Three.js loader** — `loadThree()` (loads vendored `/static/vendor/three/three.module.min.js`, memoized)
4. **Splitscreen helpers** — `_ssActive`, `_ssIsCanvasFocused` (read `window.feedBackSplitscreen`)
5. **`createFactory()`** — the rest of the file is one big closure
   - Per-instance state (Three.js refs, pools, camera state, lifecycle flags)
   - `txtMat()` text-sprite cache, `pool()` factory
   - `drawChordDiagram()` — 2D canvas chord diagram (top-left overlay)
   - `drawLyrics()` — 2D canvas lyrics renderer (top centre)
   - `initScene()` — one-time WebGL setup: scene, camera, lights, materials, pools
   - `buildBoard()` — static fretboard geometry: strings, fret wires, fret dots, board plane
   - `updateStringHighlights()` — per-frame string emissive glow + opacity
   - `update(bundle)` — the big per-frame function: notes, chords, beats, lane, fret labels
   - `drawNote()` — single note: outline, body, sustain, drop line, technique labels, projection
   - `camUpdate()` — smooth camera lerp + self-correcting NDC look-at
   - `applySize()` — DPR + canvas size + aspect clamping
   - `teardown()` — dispose all GPU resources + reset state
   - `canvasSize()` — resilient canvas-dimension lookup
   - **Returned API** — `init / draw / resize / destroy` (setRenderer contract)

## Coordinate system

- **+X** runs along the fretboard (low frets → high frets, `fretX(f)` and `fretMid(f)`).
- **+Y** is up (string Y is `sY(s)`, low strings have lower Y when not inverted).
- **+Z** is toward the camera. Notes spawn at negative Z and approach Z=0 (the hit line). Past notes would be at positive Z, but `noteZ` is clamped via `Math.min(0, dZ(dt))` in `drawNote()` so they stop at the string plane.
- **Camera** sits at roughly `(curX + 20*K, h*0.95, dist*0.75)` — positive Z, slightly above and behind the play line, looking toward `(curX, curLookY, -FOCUS_D * 0.35)`.

`dZ(dt) = -dt * TS` — the closer to "now," the closer to Z=0. `TS = 200*K` is the world-units-per-second scroll rate.

## The K scale and why everything is multiplied by it

`SCALE = 2.25`, `K = SCALE / 300 ≈ 0.0075`. **Almost every world-space dimension is expressed as `N * K`** so the whole scene scales as one unit. Tweaking `SCALE` alone resizes the entire highway. If you change a literal world dimension, write it as `N * K` to keep it consistent — naked numeric literals in Three.js geometry creation calls (e.g. inside `BoxGeometry`) are an obvious smell.

Concrete sizes (search the constants block for the names):

| Const | Value (world units) | Meaning |
|---|---|---|
| `STR_THICK` | `0.25 * K` | String thickness |
| `S_BASE` / `S_GAP` | `3 * K` / `4 * K` | Lowest-string Y / inter-string gap |
| `NW`, `NH`, `ND` | `5 * K`, `3 * K`, `0.5 * K` | Note width / height / depth |
| `TS` | `200 * K` | Scroll speed (world units per second) |
| `AHEAD` / `BEHIND` | `3.0` / `0.5` | Seconds visible ahead / behind hit line |
| `CAM_DIST_BASE` / `CAM_H_BASE` | `240 * K` / `150 * K` | Reference camera distance / height |
| `FOG_START` / `FOG_END` | `200 * K` / `670 * K` | Fog kicks in past hit line, swallows by the horizon |

## "I want to change X" — quick lookup

Each entry names the function or banner you should grep for, plus key sub-blocks (also marked with banner comments inside the function).

### Strings
- **String colors** → `S_COL` array in the top-level constants block. Eight-element vibrant palette; index `s` is the string (0 = high E for guitar). `MAX_RENDER_STRINGS` keys off `S_COL.length`.
- **String count for the active arrangement** → `resolveStringCount(bundle)` (top-level helper). Reads `bundle.stringCount` (feedBack#93) with a `bass`-name fallback. Don't reintroduce `tuning.length` — see Pitfall #4.
- **String thickness / gap / base Y** → `STR_THICK`, `S_BASE`, `S_GAP` constants.
- **String-to-Y mapping (respects invert)** → the `sY(s)` arrow function inside `createFactory()`. Single source of truth for "where on Y is string s."
- **Static string mesh creation** → `buildBoard()`, the `// Thin Line strings (glow layer)` and `// BoxGeometry strings — emissive glow ...` comment blocks. Two layers: low-opacity `Line` for soft glow, `BoxGeometry` mesh per string with its own material clone (kept in `stringLines[]` for live emissive updates).
- **Live string glow / pulse** → `updateStringHighlights(noteState)`. Tunables: `BASE_GLOW`, `MAX_GLOW`, `IDLE_OP`. Driven by `noteState.stringSustain` and `noteState.stringAnticipation`.

### Fretboard
- **Fret count** → `NFRETS` constant. Increasing requires nothing else.
- **Fret X positioning** → `fretX(f)` and `fretMid(f)` (top-level helpers). Logarithmic guitar-fret spacing within `SCALE`.
- **Fretboard plane / fret wires / fret dots** → `buildBoard()`, separate banner-style comment blocks (`// Fret wires`, `// Fret dots`). The dark background plane is the first thing built; main fret wires use `0xbbbbff` / opacity 0.8, minor wires `0x666688` / opacity 0.4. Single/double dots: `DOTS` array + `DDOTS` set in the constants block.
- **Fret-row label colors / sizing** (the heat-coloured row of fret numbers below the board) → `update()`, `// ── Dynamic fret number row ──` block. Active = `#ffe84d`, inactive = `#9ab8cc`, opacity / scale driven by `noteState.fretHeat[f]`. Text rendering (font, outline, shadow) is governed by the `'fretRow'` preset in `TXT_STYLES` — see "Tweaking text-sprite styling".
- **Active-fret cooldown** → `FRET_COOLDOWN` constant. How long after the last note in a fret it stays in the active set.

### Notes
- **Single-note rendering** → `drawNote()`. Handles outline, core body, open-string variant, sustain trail, lane drop line, all technique labels, fret connector label, and the board projection. Each visual block has its own banner comment (`// ── Outline ──`, `// ── Core (filled note body) ──`, `// ── Sustain trail ──`, `// ── Lane drop line ──`, `// ── Technique labels ──`, `// ── Per-note fret connector label ──`, `// ── Board projection ──`).
- **Note geometry / size** → `gNote = new T.BoxGeometry(NW, NH, ND)` in `initScene()`. Per-note scale tweaks happen inside `drawNote()`.
- **Note approach rotation (vertical → horizontal)** → search `approachRot` inside `drawNote()`. Maps `dt / AHEAD` to `[0, π/2]`. Open strings skip the rotation.
- **Note color** → `mStr[s]` (idle) / `mGlow[s]` (hit), built in `initScene()`. Hit material is white-with-emissive, idle is dim emissive of the string color.
- **Sustain trail** → `// ── Sustain trail ──` block in `drawNote()`. Geometry: scaled `gSus` (`BoxGeometry(1,1,1)`). Width `NW * 0.85`, height `NH * 0.12`. Outline mesh + colored core mesh.
- **Lane drop line** → `// ── Lane drop line ──` block in `drawNote()`. Vertical line from each upcoming note down to the fretboard plane in the string's color.
- **Per-note fret connector label** → `// ── Per-note fret connector label ──` block in `drawNote()`. Number below the board with a thin line up to the note. Be careful with `replace_all` on the `0.5` and `0.4` floats in the alpha formula — they're separate constants. Uses the `'noteFret'` preset in `TXT_STYLES` (also applied to the on-body fret number when `showFretOnNote` is enabled).
- **Technique markers** (bend, slide, hammer/pull/tap, accent, tremolo, palm-mute, pinch harmonic) → `// ── Technique labels ──` block in `drawNote()`. Most are small if-blocks using `txtMat(text, color, wide, style)` (cached sprite material; `'technique'` preset in `TXT_STYLES`). Exceptions: a **bend** draws a string-coloured chevron strength stack (`bendChevronMat`, one chevron per half-step), and **hammer-on / pull-off** draw a white ▲/▼ triangle with a string-coloured border (`triMat`) — both pinned to the gem; the bend ribbon's up→hold→down contour is driven by `bendSemisAtTime`.
- **Open-string note** → special-cased throughout `drawNote()`: `n.f === 0`. Wider/flatter geometry, "0" label sprite, uses `openX` (the chord's open-string centroid) when supplied.
- **Board projection ("ghost" preview)** → `// ── Board projection ──` block in `drawNote()`. Two meshes per string (`projMeshArr`, `projGlowArr`), one visible per frame for the next note. Linger window `PROJ_WIN`. Gated on the `projectionVisible` setting (BG_DEFAULTS / `h3dBgSetProjectionVisible` / the "Show note preview on the fretboard" checkbox in `settings.html`) — when off, the block is skipped and `update()`'s per-frame `m.visible = false` reset leaves the ghost hidden. **The glow has `renderOrder = -1`** which fights the strings — see Pitfall #6.
- **Note-hit "sizzle" (feedBack#254)** → `drawNotedetectSizzle()` (called from the `lyricsCtx` block in `draw()`, just before `drawNotedetectLabels()`). For each confirmed hit/active note (`_ndGood` in `drawNote()` pushes `{x, y, z, s, alpha, color}` onto the per-frame `_ndSizzle` array — `alpha` is the provider's clamped fade, `color` an optional palette override), it projects the note's world point through the up-to-date `cam`, sizes the burst from a fretboard-X-axis offset projection (reliable even when the note's rotated flat at the line), and twinkles a few short crackling ellipse-arc segments + tiny dots hugging the note's rectangle — re-randomised every frame, contained to ≲1.4× the note, half white / half the string colour (or the provider's `color` when given). Every dot/arc's `globalAlpha` and `shadowBlur` are scaled by the entry's `alpha`, and the per-element "off-this-frame" probability rises as `alpha` decays, so a struck-note glow visibly thins and fades. Also: `_ndGood` swaps the note's outline to `mGlow[s]` (bright string-tinted, not green). Knobs are inline: arc/dot count, base on-probability, line widths, `shadowBlur`, spread radii. Lives entirely on the 2D overlay layer — no Three.js geometry/disposal.

### Chords
- **Chord rendering loop** → `update()`, `// ── Chords ──` block. Iterates `bundle.chords`, calls `drawNote()` per chord-note, then draws the frame box, name label, and barre indicator.
- **Chord linger after hit** → the `0.55`-second value passed as the `linger` arg to `drawNote()` from inside the chord loop, and used in the chord-frame Z clamp + opacity formulas.
- **Chord frame-box** (rectangle around frets in the chord) → inside the chord loop, search for the `drawEdge` helper. Four edges + a low-opacity fill. `isRepeat` halves the height + dims it.
- **Chord name label (gold)** → in the same chord loop, search `chordName`. Cached via `txtMat(chordName, '#e8d080', true)`. Anchored above the chord box.
- **Barre indicator** (white vertical line at the barre fret during linger) → in the chord loop, gated on `/barre/i.test(chordName) && chDt <= 0`. Position is `fretMid(bFret)` where `bFret` is the lowest fretted string.
- **Repeat-chord detection** → `prevChordSig` / `prevChordTime` inside the chord loop. Same shape within 0.5 s → `isRepeat = true` (suppresses note bodies, dims frame).
- **Chord diagram (top-left 2D overlay)** → `drawChordDiagram()`, called from the `lyricsCtx` block at the bottom of the returned `draw()`. The chord-to-display is selected in `update()` under `// ── Chord diagram: track most recently hit chord ──` and stashed in `_diagChord` (most recently hit named chord within the 0.55 s linger window).

### Camera
- **Reference values** → `CAM_H_BASE`, `CAM_DIST_BASE`, `REF_ASPECT`, `FOCUS_D`, `CAM_LERP_BASE` in the constants block.
- **Smooth lerp + look-at** → `camUpdate()`. BPM-scaled lerp speed (`CAM_LERP_BASE * bpm/120`).
- **Self-correcting framing** → bottom half of `camUpdate()`. Projects the fretboard mid-Y to NDC, nudges `tgtLookY` until that point sits at NDC Y ≈ `DESIRED_NDC_Y` (lower third of frame). This is what lets the camera adapt automatically to ultra-wide split-screen panels.
- **Aspect compensation** → `aspectScale = Math.max(1, REF_ASPECT / Math.max(cam.aspect, 0.5))` in `applySize()`. Clamped to ≥ 1 so wide panels keep baseline depth (don't dolly in flat). Removing the `Math.max(1, …)` is the bug we already fixed; don't reintroduce it.

### Beats and sections
- **Beat lines** (downbeats highlighted) → `update()`, `// ── Beat lines ──` block. `mBeatM` (full opacity 0.25) for measure starts, `mBeatQ` (0.07) for other beats.
- **Section labels** → `update()`, `// ── Section labels ──` block. Cyan (`#00cccc`) sprite at fret 12, above the highest string.

### Scene colors (two independent axes: Background + Highway)
- **Scene-color themes** → `BG_THEMES` table near the top of `createFactory()`. One combined table is the single source of truth, but it drives **two independent axes that share the same id-set**:
  - **Background axis** — setting key `bgTheme`, setter `window.h3dBgSetBgTheme`, state `bgThemeId`. Owns `clear` (WebGL clear color) + `fog`.
  - **Highway axis** — setting key `hwTheme`, setter `window.h3dBgSetHwTheme`, state `hwThemeId`. Owns `board` (fretboard/highway-surface plane) + optional `lane`/`laneDim` (the lit lane strip).
  Any background id can mix with any highway id; picking the same id in both gives the original "matched" look. Per-axis accessors are `_bgBackgroundColors(id)` / `_bgHighwayColors(id)` (both alias `_bgThemeColors`). Both axes default to `'default'` (byte-identical to the original look).
- **Applying a theme** → `_applyBgTheme()`. Background half sets clear+fog from `bgThemeId` (skipped under the venue scene); highway half sets the board plane + lane materials (`mLaneOdd`/`mLaneEven`) from `hwThemeId`. Re-run on init, `buildBoard()`, and the settings listener (which fires for **both** `bgTheme` and `hwTheme`), so changing either dropdown retints only its half live.
- **Backward-compat migration** → `_bgLoadSettings()`: if `hwTheme` was never written (`_bgHasStored` false), `hwThemeId` inherits `bgThemeId`, so a pre-split single-`bgTheme` pick drives both axes = byte-identical until the user diverges them. settings.html mirrors this (`storedHwTheme == null ? bgTheme : coerceHwTheme(...)`).
- **Adding/removing a theme** → edit `BG_THEMES` AND keep `settings.html`'s `VALID_BG_THEMES` set (shared by both the Background and Highway dropdowns) + both `<option>` lists in sync.

### Highway lane (the highlighted strip under active frets)
- **Lane drawing** → `update()`, `// ── Dynamic highway lane ──` block. `pLane` is a single quad on the fretboard plane; `pLaneDivider` is thin vertical lines at each fret inside the lane. Width keys off the active-fret range; min width ≈ 4 frets.
- **Lane intensity** → `highwayIntensity` accumulated from upcoming notes (further notes dim it, near notes light it).
- **Lane color** → the lit quad color is `mLaneOdd.color` (stock `HWY_LANE_STRIPE_ODD_HEX = 0x103B5C`), the dimmer alternating row `mLaneEven.color` (`HWY_LANE_STRIPE_EVEN_HEX = 0x08283C`). These are now **theme-aware**: `_applyBgTheme()` recolors them from the active HIGHWAY theme's optional `lane`/`laneDim` fields, falling back to the stock hexes when a highway theme omits them. (`_laneTargetColor`, set in `initScene()`, is kept in sync with the lit color but has no live consumer today.)

### Lyrics & overlays
- **Lyrics overlay** → `drawLyrics()`. 2D canvas, top centre, semi-transparent rounded background, syllable-level highlighting (current syllable in white, played in muted, upcoming in dim).
- **Chord diagram overlay** → `drawChordDiagram()` (see "Chords" above). 2D canvas, top-left, fades over the 0.55 s linger window. Respects `inverted` (column 0 is high-e when inverted, low-E otherwise).
- **The `lyricsCanvas`** is created in `initScene()` with `z-index:1`, appended to `wrap` **after** `ren.domElement` — this is the empirically-correct stacking order for all browsers/contexts (including splitscreen panels with `position:relative; overflow:hidden`). Don't reorder; see Pitfall #5.

### Splitscreen
- **Focus dim** → `_isFocused` flag, manipulated by `_updateFocusState()`. Fades ambient + directional light intensity in non-focused panels.
- **Per-panel resize fallback** → search `_lastHwW` in the returned `draw()`. The renderer self-detects when the highway canvas backing-store dimensions change and re-runs `applySize()`. Needed because the splitscreen plugin overrides `hw.resize` and never calls `renderer.resize()`.
- **Reduced DPR in split** → `applySize()` clamps DPR to 1.25 when splitscreen is active vs 2 otherwise (search `baseDPR`). Keeps four-panel quad layout from melting GPUs.

### Splitscreen panel controls/settings
- Per-panel background overrides use `localStorage` keys shaped as `h3d_bg_panel<N>_<key>`. When present, they override the global `h3d_bg_<key>` value for panel `N`; when absent, the global value still applies.
- Keep per-panel keys to `BG_DEFAULTS` entries that `_bgLoadSettings()` reads. Do not add panel-only keys outside that load path.
- `panelControls` is a static, host-readable, curated descriptor list for controls a host can expose per panel. It documents the supported per-panel surface; the renderer still loads values through `_bgLoadSettings()`.
- Asset/background image keys remain global-only. Do not make uploaded or selected asset references panel-scoped unless that contract is explicitly widened.
- Host refresh nudges that call toggle setters must pass real booleans, not strings such as `'false'`, so setters can distinguish `true` from `false`.

## The `bundle` object

Every per-frame renderer call receives a `bundle` from feedBack core. Fields used by this plugin:

- `currentTime` — playback time in seconds (drives `dt` for everything)
- `notes`, `chords`, `beats`, `sections` — chart arrays (already difficulty-filtered by core)
- `chordTemplates` — array indexed by `ch.id`; each `{ name, frets: [N] }`
- `lyrics` — syllable array `[{ w, t, d }, …]`
- `inverted` — display flag honored via `sY(s)` (low-string-on-top vs the default low-string-on-bottom)
- `lyricsVisible` — gate for lyrics overlay
- `renderScale` — pixel-ratio multiplier from the user's quality setting
- `songInfo.arrangement` — only field of `songInfo` this plugin reads, used as the bass-name fallback in `resolveStringCount()`
- `stringCount` — feedBack#93; always prefer this over deriving from tuning/arrangement
- `lefty` — display flag consumed by this renderer from `bundle.lefty`. Captured into `_leftyCached` before each frame so `xFret()`, `xFretMid()`, `boardSpanX()`, board geometry, note placement, and the camera shoulder offset mirror the fret axis for left-handed mode. A runtime lefty flip rebuilds board state and mirrors `curX`/`tgtX` plus the lookahead camera X cache so the camera does not drift across the neck.
- `getNoteState(note, chartTime)` — feedBack#254; per-note judgment from a scorer (note_detect). Captured each frame into `_ndGetNoteState` at the top of `update()` and consulted in `drawNote()` AFTER the event-driven `_ndHitMarks`/`_ndMissMarks` lookup AND over the proximity-based `hit` heuristic, both of which it overrides when it has a verdict: `'hit'`/`'active'` → `mGlow[s]` outline (bright string-tinted, *not* green) + `mGlow[s]` body + `mGlow[s]` sustain trail + a queue entry for `drawNotedetectSizzle` (so a held sustain keeps glowing/sparkling as long as the provider keeps returning `'active'`); `'miss'` → `mMissOutline` and `_showHit = false` (suppresses the bright body even if the note is near the line). Called with the note's chart time (`n.t`), which is how note_detect keys its `noteResults` map — *not* `now`. Returns null on cores without the API or songs with no scorer — then the event path / `hit` heuristic drive feedback for older note_detect builds. **notedetect ≥1.13 object verdicts additionally carry `{ points, mult, popKey }`** (game-scoring layer): `points` is the note's awarded score, `mult` the multiplier tier it landed at, and `popKey` a dedup key — chord members all return the chord-level judgment's key so a chord pops once, not once per gem. Consumed by the score-pop spawn in `drawNote()` (see Score FX below); all three are absent on older notedetect builds, so guard with `!== undefined`.

`tuning` and `capo` aren't consumed by this plugin.

### Score FX (notedetect game-scoring layer)

- **"+N" score pops** → `_fxSpawnPop()` from `drawNote()` (just after the provider verdict-override block), drawn by `drawScoreFx()` (called from the `lyricsCtx` block in `draw()`, right after `drawNotedetectLabels()`). Fixed 24-slot pool (`_fxPops`), deduped per `popKey` via the TTL'd `_fxSeen` map (pruned in `drawScoreFx`). Pops rise/fade over 700 ms; font size scales with the multiplier tier.
- **Session FX** → `notedetect:fx` events (`{ fxType: 'multiplier'|'milestone'|'streakBreak', ... }`). notedetect dispatches each detail object twice in the same task: on `window` (unscoped, first) and as a bubbling CustomEvent from its per-panel instanceRoot (scoped, second). The listener (`_fxOnFx`, bound with the other notedetect listeners) treats element-targeted copies as authoritative — accepted only when their root lives in this panel's container — and **defers the window copy by a task** (`setTimeout 0`): if the element copy (same detail reference) arrived meanwhile it's dropped as a duplicate, otherwise it's the compat fallback for a detector whose root isn't in the DOM. This keeps splitscreen panels from rendering each other's FX even for the first event of a session. Effects: milestone → particle burst from a 4-slot Float32Array pool (`_fxBursts`), multiplier tier-up → expanding ring pulse at the strike-line centre, streak break → brief red wash.
- **Skin palette** → `_fxResolvePalette()` reads `localStorage['feedBack_notedetect_skin']` (`neon`/`esports`/`metal` → `_FX_PALETTES`) at listener-bind time and on the `notedetect:skin` bus event. The display fonts are document-loaded by notedetect's stylesheet, so the overlay canvas can reference the family names directly.
- Everything lives on the 2D overlay layer — no Three.js geometry, no `txtMat()` cache traffic, nothing to dispose; `teardown()` deactivates the pools and removes both listeners.
- **This block is the reference implementation for other renderer plugins** (drum highway, piano, custom highways) that want score pops / session FX: copy the `_fxOnFx` dedup+scoping listener, the `popKey`-keyed seen-map (cleared on backward seek), and the `_FX_PALETTES` skin mapping. The full consumer contract (events, payloads, provider verdict fields, theming variables) is documented in feedBack-plugin-notedetect's `CLAUDE.md`.

If you need a bundle field that isn't here yet, check `_makeBundle()` in `static/highway.js` in the **feedBack core repo** — this is the plugin repo, `static/highway.js` is not here. The full path in the parent feedBack checkout is `feedBack/static/highway.js`.

## Per-string state arrays

Several frame-local arrays are sized to `nStr`:

```js
const noteState = {
    stringSustain:    new Array(nStr).fill(false),
    stringAnticipation: new Array(nStr).fill(0),
    fretHeat:         new Array(NFRETS + 1).fill(0),
    strGlow:          new Array(nStr).fill(0.5),
};
```

Anything that indexes a per-string array MUST be guarded by `validString(s)`. The function checks that `s` is an integer in `[0, nStr)` (returning `false` otherwise so the caller can skip), warns once when an out-of-range index is seen, and keeps the `mStr / mGlow / mSus / projMeshArr` lookups safe. It does NOT clamp — out-of-range strings are dropped, not silently mapped to a valid one. `filterValidNotes(notes)` is the chord-note equivalent (allocates only when something would actually be dropped).

## Object pools

Pools live as closure refs (`pNote`, `pSus`, `pLbl`, `pBeat`, `pSec`, `pFretLbl`, `pLane`, `pLaneDivider`, `pChordBox`, `pChordLbl`, `pBarreLine`, `pNoteFretLabel`, `pConnectorLine`, `pDropLine`, `pSusOutline`).

The pool factory `pool(parent, mk)` returns `{ get(), reset() }`. **Every pool MUST be `.reset()`-ed at the top of `update()`** — otherwise objects from the previous frame stay visible. When you add a new pool, add the reset call too. Search for the existing block of `.reset()` calls at the top of `update()` to find where to add yours.

If a pool's mesh has per-instance state (its own material clone, its own texture map), set those fields each `get()` call so a recycled instance picks up the right values. The "first context wins" trap is real — recycled sprites that retain a stale `material.map` from a previous frame won't repaint. The chord-name label loops on this (search `lbl.material.map !== mat.map`) by checking before swapping.

## Key gotchas / pitfalls

1. **Adding a new pool? Reset it.** The reset block at the top of `update()` is easy to miss when adding a new pool elsewhere.
2. **`txtMat()` is cache-keyed by `(style, text, color, wide)`.** Calling it with a numeric `text` works (it's coerced via `String(...)`), but new label content creates a new texture forever. Don't generate dynamic per-frame text (e.g. interpolated values) through `txtMat()` or you'll leak GPU memory. For static labels that change occasionally (chord names, fret numbers), the cache is fine. The `style` arg picks a preset from the `TXT_STYLES` table — see "Tweaking text-sprite styling" below.
3. **Disposal in `teardown()` matters.** Three.js doesn't garbage-collect GPU resources. Every `material.dispose()`, `geometry.dispose()`, `map.dispose()`, and `ren.dispose()` call there is load-bearing. `teardown()` is called from `init()` (when re-initing), `destroy()` (setRenderer swap or `highway.stop()`), and on init failure.
4. **Don't use `tuning.length` for string count.** `bundle.tuning` (and `arr.tuning` server-side) is always 6 elements even for bass — feedBack pre-fills the array with zeros for unused strings. Use `bundle.stringCount` (feedBack#93), with `/bass/i.test(arrangement)` as the only acceptable fallback. There's a comment in `resolveStringCount()` documenting this.
5. **lyricsCanvas DOM order.** The 2D overlay canvas is appended to `wrap` AFTER `ren.domElement` and given `z-index:1`. This is the empirically-correct order — earlier versions had it before the WebGL canvas, which broke in splitscreen panels with `position:relative; overflow:hidden`. Don't reorder without testing both modes.
6. **Projection glow `renderOrder = -1`** in `initScene()`. This is a known-suboptimal setting — it forces the glow to draw before the strings in the transparent queue, so the string visibly cuts through the preview. Removing the line lets natural Z-sort layer it correctly. Plus the projection's world-Y matches the string Y, which after perspective projection puts the preview slightly screen-lower than the string; bumping `projY = y + NH * 0.4` recenters it. (Both fixes live on the `fix/preview-stacking` branch.)
7. **`renderOrder` on transparent objects is sticky.** Three.js sorts the transparent queue by `renderOrder` first, then back-to-front. A stray `m.renderOrder = -1` on something will pull it under everything regardless of Z. When in doubt, leave `renderOrder` at the default 0 and rely on Z position.
   - **Corollary: `depthTest: false` alone does NOT make a sprite "always on top."** It removes the sprite from depth-buffer comparison, but draw order in the transparent queue is still determined by `renderOrder` then Z. Anything rendered after a `depthTest: false` sprite will still overdraw it. For HUD-style overlays that must always be visible (fret-row labels — issue #35, technique callouts), set `renderOrder = 1000` AND keep `depthTest: false`. Both knobs together is the contract; either alone leaves the door open to occlusion.
8. **`ch.id` may be missing.** Some chord events lack an `id` (or it doesn't index into `chordTemplates`). Always optional-chain: `bundle.chordTemplates?.[ch.id]?.name`. The chord diagram + name label both gate on a non-empty result.
9. **The `aspectScale` clamp (`Math.max(1, …)`).** Without it, ultra-wide split-screen panels (top/bottom layout, ~5:1 aspect) yield aspectScale ≈ 0.33, which dollies the camera way in and kills highway depth. The clamp keeps wide panels at baseline depth and only allows narrow panels to dolly the camera back.
10. **The `_oobStringWarned` flag is reset on `nStr` change** in the returned `draw()` — switching from guitar (6) to bass (4) re-arms the warning so a malformed bass chart still gets logged.
11. **`renderOrder` values for the lane and dividers are explicit** in `update()` (`lane.renderOrder = 1`, `div.renderOrder = 2`). The lane plane needs to draw above the static fretboard plane (which has no renderOrder), and dividers need to draw above the lane.

## Tweaking colors safely

The eight-color palette `S_COL` is the single source of truth for per-string color. **Don't hardcode hex values inside `drawNote()` or `update()`** — every per-string color reference is either an entry in `S_COL` or one of the per-string material arrays (`mStr`, `mGlow`, `mSus`, `mProj`, `mProjGlow`) built from it.

If a planned color-palette feature lands (issue #10), expect it to swap the palette source array but keep this single-array indirection. Anything that hardcodes color today will break that swap; flag it during review.

Non-string colors (the stock lane hexes `HWY_LANE_STRIPE_ODD_HEX`/`_EVEN_HEX` — now overridable per Highway theme, see "Scene colors" above; fret-row label colors `#ffe84d` / `#9ab8cc`, fret-dot color `0x556677`, lyrics box rgba, chord-name gold `#e8d080`, etc.) are scattered as literals — that's intentional for now, since they're scene-wide accents rather than per-string. Pulling them into named constants is fine if you're already in that area.

## Tweaking text-sprite styling

Every text label in the 3D scene is rasterised by `txtMat(text, color, wide, style)` and the look (font, outline, drop-shadow, source-canvas resolution) is driven by a preset in the `TXT_STYLES` table at the top of `createFactory()`. **Do not edit the body of `txtMat()` to change a single label class** — change the relevant preset entry instead, so the rest stay unaffected.

Current presets and their callers:

| Preset | Used by | Default look |
|---|---|---|
| `fretRow` | Fret-number row under the board (`update()`, fret-row block) | Arial Black 900, 256px source canvas, 18px dark outline + soft drop-shadow — designed to pop against any background |
| `noteFret` | Per-note connector numbers + on-body fret label (`drawNote()`) | Same heavy treatment as `fretRow` |
| `chord` | 3D chord-name labels above chord boxes | bold sans, 128px source, 6px outline (lighter so the gold reads) |
| `section` | Section banners ("Verse", "Chorus") at fret 12 | bold sans, 128px source, 6px outline |
| `technique` | Bend / slide / H / P / T / PH / PM / accent / tremolo / open-string overlay | bold sans, 128px source, 6px outline |
| `open` | The "0" label on open-string note bodies | bold sans, 128px source, 6px outline |

Style fields:

- `font` / `wideFont` — full CSS font shorthand (weight + size + family); `wideFont` is used when `wide=true` (long-aspect labels: chord names, section names, "↑1/2", "~~~"). Keep both in sync if you change weight or family.
- `srcH` — source-canvas height in px. Wide labels use `srcH * 4` for width. Larger `srcH` keeps glyph strokes crisp after bilinear downsampling onto small sprites — bumping it from 128 → 256 was the difference between thin-and-blurry and crisp on the fret-number presets. **Keep `srcH` power-of-two** (128, 256, 512, …): WebGL1 and Three.js silently disable mipmap generation on NPOT textures and fall back to a non-mipmap min-filter, which causes shimmer/aliasing on labels far down the highway. The 4× width derivation preserves POT-ness too (e.g. 256 → 1024 wide).
- `stroke` / `strokeW` — outline color and line-width in source-canvas px. Set `stroke: null` or `strokeW: 0` to skip the outline (faster cache rasterisation, no contrast halo).
- `shadow` — `{ color, blur, dx, dy }` or `null`. Drawn via canvas 2D `shadowColor` / `shadowBlur` / `shadowOffsetX/Y` *before* the stroke and fill, so it haloes the whole glyph.

**Cache key includes the preset name** (`style|wide|text|color`), so two presets with otherwise-identical text produce two distinct cached materials. Adding a new preset is safe — just add the entry to `TXT_STYLES` and pass its name as the 4th arg at the call site. Forgetting to pass `style` falls back to `'technique'` (the broadest, most generic preset) and is the right default for a brand-new label class.

**Don't generate per-frame distinct text through `txtMat()`** (e.g. interpolated values, tick counters). The cache is unbounded and will leak GPU memory across the session — see Pitfall #2.

## Lifecycle (setRenderer contract)

Per feedBack#36, the factory returns `{ init, draw, resize, destroy }`:

- **`init(canvas, bundle)`** tears down any prior state, sets `highwayCanvas`, lazily loads Three.js, runs `initScene()`, calls `applySize()` (with a `retrySize` rAF loop fallback if the canvas isn't laid out yet).
- **`draw(bundle)`** is gated on `_isReady`. Re-resolves `nStr` / inverted / renderScale, then `update(bundle) → camUpdate(bundle) → ren.render → 2D overlays`. The `_lastHwW/_lastHwH` check at the top auto-resizes when the splitscreen plugin bypasses `resize()`.
- **`resize(w, h)`** is gated on `_isReady`. Just calls `applySize()`.
- **`destroy()`** is idempotent. Sets flags, runs `teardown()`, drops `highwayCanvas`. Tolerates being called on an instance that's been destroyed and re-init'd already (resets `_lastHwW/H`, `_diagChord`, etc.).

The factory **returns a fresh instance per call**, so splitscreen's per-panel `setRenderer(feedBackViz_highway_3d())` gets independent state per panel — important because the chord diagram, projection meshes, etc. are all per-instance.

## Branching / PR conventions

- Feature branches off `main`, descriptive name (e.g. `fix/preview-stacking`, `feat/palette-picker`).
- PR target: target the contributor's own fork by default unless they ask otherwise; confirm before opening a PR upstream. Run `git remote -v` in this directory to see the remotes that are configured locally.
- Commit messages: short imperative subject, optional body explaining *why*. Don't summarize the diff — the diff already does that.
- This plugin is bundled **in-tree** at `plugins/highway_3d/` inside the `got-feedback/feedBack` repository (not a gitlink/submodule). It ships with the default container image. Changes go through the normal feedBack PR process — no separate upstream repo to sync.

## When in doubt

- `screen.js` is one file — `Grep` for the function name or banner text before guessing.
- The constants block at the top is intentionally exhaustive; scan it before introducing a new magic number.
- If a "polish" feels like it should be one or two lines but stretches into restructuring, double-check whether a per-frame state field, pool reset, or `validString()` guard already covers your case.
