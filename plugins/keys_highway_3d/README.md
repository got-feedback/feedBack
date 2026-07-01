# Keys Highway 3D

RS+-style falling-note 3D piano highway for [Slopsmith](https://github.com/got-feedback/feedback), fed by the **Sloppak Notation Format** (sloppak-spec §5.3) — part of the piano/keys first-class epic (slopsmith#828, plugin workstream slopsmith#824).

- Consumes the `notation_info` / `notation_measures` highway-WS stream over a private per-instance socket and flattens measure → staff → voice → beat → note into `{midi, t, durSec, hand}` (durations derived from written `dur`/`dot`/`tu` at the running tempo; ties extend; overlap-clamped).
- 3D perspective highway to a vanishing point with a real white/black-key keyboard; per-key **pitch-class colours** (Synthesia convention — C red, D yellow, E blue, …) with hand (rh/lh) as a secondary brightness cue.
- Full RS+ visual treatment: key **letter glyphs** printed on the active-range key tops (cached CanvasTextures), **bevelled gem-style note blocks** (ExtrudeGeometry, geometry/material caches keyed by size and pitch-class×hand), **floating bar numbers** scrolling with the notes, **active-range lane dimming** so the playable span pops, and a **glowing pulsing hit-line** (layered additive gradient planes — no postprocessing).
- Performance discipline: no per-frame allocations or DOM queries in `draw()`. Chart-scoped resources — note geometries/materials, bar-number and glow textures — are cached and disposed on chart teardown; the key-letter glyph `CanvasTexture`s live in a shared module-level cache that survives teardown and is reused across instances.
- Auto-selected for arrangements with notation via `matchesArrangement(songInfo.has_notation)`; capability-native `visualization` provider declaration.
- **Web MIDI input scoring**: module-level MIDI singleton (one access per tab, focused-instance routing) with device auto-connect by saved id+name, loopback blocklist, channel filter, transpose and CC64 sustain (`keys3d_` localStorage prefix; `window.keysH3d*` settings API). Hit detection matches played MIDI against the flattened chart notes within ±0.10 s with per-note dedupe and a missed-note sweep (only while a device is connected — never retroactive across a mid-song connect).
- **Live hit feedback on the MIDI path** (not the chart): key depress (~4° back-edge pivot, ~120 ms spring; the key letter rides along), wrong-note red key flash, and a vertical flame flare on hits (pooled additive sprites, white-hot base fading into the pitch-class colour, ~400 ms).
- **End-of-run stats**: POSTs `/api/stats` `{filename, arrangement, score, accuracy}` exactly once per run with the same formula as the guitar notedetect path (`accuracy = hits / max(1, hits+misses)`, `score = round(hits·100·accuracy)`), then notifies the progression core when present.
- **Capability wiring** (all guarded for servers without the hosts): registers as a note-detection `midi` provider (`keys-midi`, `verify.target`), opens a per-song binding scoped to the chart's keys range, reports hit/miss observability events, and exposes Web MIDI inputs to the audio-input domain with pseudonymized labels (`midi-input-1`, …) via `source.enumerate/describe/open/close`.
- Headless test hook: `window.__keysHwTest = { injectNoteOn(midi, when), getScore() }`.

## Tests

```
node --test tests/*.test.js
```

## License

AGPL-3.0.
