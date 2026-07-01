# 3D Drum Highway — Mockup

![3D Drum Highway mockup screenshot](screenshots/drum-highway-3d.png)

An exploratory **pure-visual** sibling of `highway_3d`. Renders an 8-lane
drum highway (7 lanes for hand pieces + a full-width kick bar) populated
from a hardcoded demo pattern that loops indefinitely. Not yet wired to
song data, hit detection, audio, or note_detect — this is here to play
with the look-and-feel.

To see it, load any song in the player, then pick **3D Drum Highway**
from the viz picker. The mockup animates regardless of what song is
playing.

## Layout

```
 [HH]  [SNR]  [TM1]  [TM2]  [FT]  [CR]  [RD]    <- 7 lanes, left to right
   |    |      |      |     |    |     |
   v    v      v      v     v    v     v
 -----  hit line  -----------------------------
 ▓▓▓▓▓▓▓▓▓▓▓▓▓ KICK BAR ▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓     <- full-width kick lane
```

- **Drums** (snare, toms, floor tom): flat disc geometry (`CylinderGeometry`),
  palette-tinted, with subtle emissive pulse on approach. Snare gets a
  thin white "wires" stripe.
- **Cymbals** (hi-hat, crash, ride): faceted gem geometry (truncated
  `CylinderGeometry`), metallic material, slightly translucent.
- **Kick**: full-width amber bar across the base, brighter on approach.

## Variants visible in the demo

| Variant | How it reads |
|---|---|
| `accent` | Bigger note + white halo ring |
| `ghost`  | Hollow ring (~65% size) instead of a solid disc |
| `flam`   | Main note + a small grace disc offset slightly before |
| `bell`   | Ride only — adds a bright dot in the center of the gem |

The **Fill showcase** demo pattern fires every variant at least once in
a few bars, plus a tom roll down the kit. Best read of what's possible.

## Settings (Settings → Plugins → 3D Drum Highway)

- **Palette** — shared 3 palettes with `highway_3d` (default / neon / pastel).
- **Demo pattern** — rock backbeat / jazz swing / fill showcase.
- **Camera angle** — 0 (down the lanes) to 1 (top-down). Default 0.35.

All settings persist in `localStorage` under the `drum_h3d_*` prefix.

## What this plugin is *not* doing yet

(Historical note: this started as a pure-visual mockup; it now reads
`bundle.drumTab` + `bundle.currentTime` and scores MIDI hits against the
chart, so the old "no song-data wiring" caveats are gone.)

- Sustain trails (drums don't sustain meaningfully)
- Sticking labels, double kick, rolls — see the TODOs in `screen.js`
  for the variant backlog

## Ported helpers (keep in sync with highway_3d)

Visual-parity code copied from `plugins/highway_3d/screen.js` — same
function names, signatures, and constants on purpose, marked with
`PORTED FROM highway_3d` comments at each site. If the guitar highway
tunes one of these, mirror the change here (and in `keys_highway_3d`):

- `_bloomEnsure()` / `_bloomDispose()` — EffectComposer + UnrealBloomPass
  (0.65/0.5/0.82) on a multisampled HalfFloat target, ACES↔None tone-
  mapping switch in `draw()`; addons dynamic-imported from
  `/static/vendor/three/addons/` (no CDN fallback — direct render is the
  graceful degrade)
- `_sparkBurst()` / `_sparkUpdate()` — pooled additive Points hit sparks
  (pool 160 here vs the guitar's 256)
- `_makeGaussTex()` — soft-falloff DataTexture for the additive lane-flash
  quads
- `_timingHex()` — early/late/on-time feedback colors (green/cyan/amber)
- `_ssActive()` — host splitscreen probe (minus the guitar's focus-API
  checks, which it needs for input routing and we don't)
- `BG_THEMES` / `_bgThemeColors()` — the scene theme table (same ids/values
  as the guitar's, except `default` which is this plugin's original
  palette); one pick drives both of the guitar's background/highway axes
- `_applyCinematic()` — ambient/key rebalance (values tuned per plugin)

## Why a separate plugin (vs. drum mode inside highway_3d)?

Cleaner iteration. The drum highway is its own geometry, its own
gameplay assumptions (lanes ≠ strings, no frets, no chord shapes,
no sustains), and likely its own chart format. Forking the visuals
in a sibling plugin lets the mockup move fast without risking
regressions in the guitar viz that ships today. If the drum highway
eventually matures, we can decide whether to merge or keep separate.
