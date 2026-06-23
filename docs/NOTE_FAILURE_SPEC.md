# Note Failure Feedback — Technical Spec

## Goal

When a user loops over a lick, **show note misses on the highway** with diagnostic
detail: which note was missed, and *how* it was missed (timing vs pitch).

Many rhythm-practice tools show a `!` marker at the missed note position after it
passes. We improve on this by showing *why* the note was missed — too early, too
late, wrong pitch, or not played at all.

---

## Prerequisites

This feature depends on the **note detection plugin** (`feedBack-plugin-notedetect`),
which provides real-time pitch detection via server-side aubio/YIN over WebSocket.
The detection plugin streams `DetectedNote` events; this spec describes the
**matching, judgment, and rendering** layer that consumes those events.

Without the detection plugin active, no miss/hit feedback is shown — the highway
renders exactly as it does today.

---

## Architecture

```
Guitar → USB Adapter → sounddevice (server)
                          ↓
                   aubio YIN detection
                          ↓
              WebSocket: detected notes
                          ↓
              ┌───────────────────────┐
              │   Note Matcher        │  ← THIS SPEC
              │   (client-side JS)    │
              │                       │
              │ Chart notes (highway) │
              │ × Detected notes (WS) │
              │ = Match/Miss/Extra    │
              └───────────────────────┘
                          ↓
              Highway draw hook overlay
              (hit glow, miss markers, diagnostics)
```

### Data Flow

1. **Chart notes** arrive via existing highway WebSocket (`/ws/highway/{filename}`).
   Wire format: `{ t, s, f, sus, bn, ho, po, ... }` (see `lib/song.py:note_to_wire`)

2. **Detected notes** arrive via detection plugin WebSocket
   (`/api/plugins/note_detect/stream`).
   Wire format: `{ note: "A2", freq: 110.0, confidence: 0.92, time: 1.234 }`

   > **Plugin naming note:** The detection plugin's repository is named
   > `feedBack-plugin-notedetect`, but the plugin registers with the id
   > `note_detect` (snake_case). Its HTTP/WebSocket routes therefore appear
   > under `/api/plugins/note_detect/…`. There is no `window.feedBackPlugin_*`
   > global pattern in FeedBack — to check whether the detection plugin is
   > available at runtime, attempt a fetch to `/api/plugins/note_detect/status`
   > (or similar) or consult the `/api/plugins` list. Use the repo name only
   > in documentation links.

3. **Note Matcher** (new, client-side) correlates these two streams in real-time.

4. **Draw hook** renders results on the highway via `highway.addDrawHook()`.

   > **⚠ Limitation:** `addDrawHook()` is only invoked by the **default 2D renderer**.
   > If the user has switched to a custom renderer (e.g., a WebGL 3D highway plugin),
   > draw hooks are not called and this overlay will be invisible. Implementers should
   > note this in the plugin's UI (e.g., a warning banner when a non-default renderer
   > is detected) and may want to explore a renderer-agnostic overlay approach
   > (own canvas + own rAF loop, reading public highway state via getters) as a
   > future improvement.

---

## Note Matching Algorithm

### Match Window

A detected note matches a chart note when:

| Criterion      | Threshold              | Notes                                      |
|----------------|------------------------|---------------------------------------------|
| **Time**       | ±200ms (configurable)  | Centered on chart note time                 |
| **Pitch**      | ±50 cents              | Accounts for imperfect intonation           |
| **String**     | Pitch-only (for now)   | `DetectedNote` carries no string field; exact-string matching requires the detection plugin to be extended to emit a string estimate. Treat string as always-unknown until that extension lands. |

### Expected Frequency Calculation

```javascript
// Open-string base frequencies (Hz), string index 0 = lowest string.
// Select by highway.getStringCount() + arrangement name from highway.getSongInfo():
//   4-string          → BASS_TUNING    (E1 A1 D2 G2)
//   5-string bass     → BASS5_TUNING   (B0 E1 A1 D2 G2)
//   6-string (default)→ GUITAR_TUNING  (E2 A2 D3 G3 B3 E4)
//   7-string          → GUITAR7_TUNING (B1 E2 A2 D3 G3 B3 E4)
const GUITAR_TUNING  = [82.41, 110.00, 146.83, 196.00, 246.94, 329.63];
const BASS_TUNING    = [41.20,  55.00,  73.42,  98.00];
const BASS5_TUNING   = [30.87,  41.20,  55.00,  73.42,  98.00];
const GUITAR7_TUNING = [61.74,  82.41, 110.00, 146.83, 196.00, 246.94, 329.63];

function getBaseTuning(stringCount, arrangementName) {
    const isBass = /bass/i.test(arrangementName || '');
    if (stringCount === 4) return BASS_TUNING;
    if (stringCount === 5 && isBass) return BASS5_TUNING;
    if (stringCount === 7) return GUITAR7_TUNING;
    return GUITAR_TUNING;  // 6-string or unknown
}

function expectedFreq(string, fret, tuningOffsets, capo = 0, stringCount, arrangementName = '') {
    // tuningOffsets: per-string semitone offsets from standard (from song metadata).
    // stringCount: REQUIRED — pass highway.getStringCount(). Do NOT default to
    // tuningOffsets.length: RS XML sources pad the tuning array to length 6 even for
    // 4-string bass, which would cause incorrect base-tuning selection.
    // arrangementName: pass highway.getSongInfo().arrangement to resolve ambiguous
    // 5-string cases (5-string bass vs 5-string extended guitar).
    const BASE = getBaseTuning(stringCount, arrangementName);
    if (string < 0 || string >= stringCount || string >= BASE.length) {
        return null;
    }
    const semitones = tuningOffsets[string] + capo;
    const base = BASE[string] * Math.pow(2, semitones / 12);
    return base * Math.pow(2, fret / 12);
}
```

### Match States

Each chart note resolves to a **judgment** with two independent axes:

- **Timing axis** (`timingState`): `'OK'` if within `timingThresholdMs`, `'EARLY'` if matched
  more than `timingThresholdMs` before chart time, `'LATE'` if more than `timingThresholdMs`
  after. `null` if the note was never matched (MISSED).
- **Pitch axis** (`pitchState`): `'OK'` if detected pitch is within `pitchThresholdCents` of
  expected, `'SHARP'` if above by more than `pitchThresholdCents`, `'FLAT'` if below. `null`
  if unmatched.
- **`hit`**: `true` when both axes are `'OK'`; `false` for MISSED or any off-axis result.

The axes combine independently (e.g., `LATE + FLAT`, `EARLY + SHARP`). The state diagram
below shows possible terminal values per axis:

```
PENDING  →  hit=true,  timingState='OK',    pitchState='OK'
         →  hit=false, timingState=null,    pitchState=null   (MISSED — window expired)
         →  hit=false, timingState='EARLY', pitchState=...    (too early)
         →  hit=false, timingState='LATE',  pitchState=...    (too late)
         →  hit=false, timingState='OK',    pitchState='SHARP'
         →  hit=false, timingState='OK',    pitchState='FLAT'
```

Timing and pitch thresholds are read from configuration (`timingThresholdMs`,
`pitchThresholdCents`) — never hard-coded.

### Judgment Data Structure

```javascript
// Per-note judgment, attached after the note passes the now-line.
// Compound judgments (e.g. LATE + FLAT) are expressed as separate
// timingState / pitchState fields; never concatenate them into `state`.
{
    chartNote: { t, s, f, ... },      // Original chart note

    // Overall outcome — top-level quick check
    hit: false,                        // true iff timing AND pitch are both clean

    // Timing axis: null if no detection arrived (pure MISSED)
    timingState: 'EARLY' | 'LATE' | 'OK' | null,
    timingError: -120,                // Milliseconds (negative = early); null if no detection

    // Pitch axis: null if no detection arrived (same condition as timingState).
    // Pitch is evaluated independently for any matched detection — a LATE note
    // can also be FLAT (both axes are set even when timingState ≠ 'OK').
    pitchState: 'SHARP' | 'FLAT' | 'OK' | null,
    pitchError: +15,                  // Cents (positive = sharp); null if no detection

    // Raw detection data (null if no detection arrived)
    detectedFreq: 112.3,             // What was actually played
    expectedFreq: 110.0,             // What should have been played
    detectedAt: 1.354,               // When the detection arrived
}
```

**Precedence / rendering rules:**
- `hit: true` → green glow; both timing/pitch states will be `'OK'`. A judgment is a hit when `|timingError| ≤ timingThresholdMs` **and** `|pitchError| ≤ pitchThresholdCents` (see §Configuration).
- `timingState: null` (no detection) → pure miss (`✕`); skip pitch display.
- Non-null `timingState` + non-null `pitchState` → compound: render timing
  indicator on top, pitch indicator below.
- Emitted `note:hit` / `note:miss` events carry the full judgment object so
  subscribers can inspect either axis independently.

---

## Highway Rendering

### Hit Feedback

Notes matched within `timingThresholdMs` (default 100 ms) **and**
`pitchThresholdCents` (default 20 ¢) get a **green glow ring** that fades over
`hitGlowDuration` (default 0.5 s). This is the combination that sets `hit: true`
on the judgment object. The existing note rendering is unchanged — the glow is
drawn *behind* the note at the now-line position as it passes.

```
  [existing note bubble]
  └── green glow ring (additive blend, fades)
```

### Miss Markers

Missed notes get a persistent marker that continues downward past the now-line
and remains visible for 2 seconds (configurable). The marker stays at the
note's string/fret position on the "past" portion of the highway (below
now-line).

**Positioning rule:** do **not** rely on `highway.project(tOffset)` for the full
miss-marker lifetime below the now-line. That helper returns `null` for offsets
more than ~50ms into the past, so it cannot place markers that persist for
seconds after the note passes. Instead, define a dedicated mapping anchored at
the now-line:

- `tOffset = 0` starts at the now-line (use `highway.project(0)` to get this Y).
- For the past region (`tOffset < 0` up to `-missMarkerDuration`), place the
  marker below the now-line using a configurable linear pixels-per-second mapping,
  clamped to the visible past area.
- The existing `highway.project()` may still be used for positions at/above the
  now-line (approaching notes in the last ~50ms), but once a marker has crossed
  into the past region its Y is governed by this below-now-line mapping.

| State  | Visual                                                      |
|--------|-------------------------------------------------------------|
| MISSED | Red `✕` at note position + red tint on string segment       |
| EARLY  | Orange `↑` (up arrow) + timing offset label (e.g., "-120ms")|
| LATE   | Orange `↓` (down arrow) + timing offset label ("+85ms")     |
| SHARP  | Blue `♯` + cents label ("+35¢")                             |
| FLAT   | Blue `♭` + cents label ("-42¢")                             |

Compound states stack vertically: timing indicator on top, pitch indicator below.

### Miss markers on the string area

Below the now-line, all strings for the active arrangement are always visible
(use `highway.getStringCount()` — 4 for bass, 6 for guitar, 7+ for extended-range).
For a missed note,
the relevant string segment between the now-line and ~20px below it gets a brief
red pulse (200ms fade).

### Loop Iteration Summary

When A-B looping is active, at the end of each loop iteration (when playback
wraps from B back to A), show a brief overlay:

```
┌─────────────────────┐
│  Loop 3/∞           │
│  5/7 notes hit (71%)│
│  Best: 6/7 (86%)    │
└─────────────────────┘
```

Displayed for 1.5s, then fades. Does not block the highway.

---

## State Management

### NoteJudgmentTracker

Client-side class that manages the correlation between chart notes and detections.

```javascript
class NoteJudgmentTracker {
    constructor(chartNotes, chartChords, tuning) { ... }

    // Called when a detected note arrives from the detection WebSocket
    addDetection(detected) { ... }

    // Called each frame; checks for expired match windows
    update(currentTime) { ... }

    // Returns judgments for notes in the visible time range
    getJudgmentsInRange(tStart, tEnd) { ... }

    // Reset (on song change, loop restart, arrangement switch)
    reset() { ... }

    // Stats for the current loop iteration
    getLoopStats() { ... }
}
```

### Memory Management

- Judgments older than 10 seconds behind current time are pruned each frame.
- Detection buffer holds last 5 seconds of raw detections.
- On loop wrap (B→A), archive current iteration stats, reset judgments for
  the loop range, keep detections flowing.

### Loop-Aware Behavior

The tracker must handle A-B looping:

1. Detect loop wrap: `currentTime < previousTime - 0.5` (jumped backward).
2. On wrap: snapshot current stats to `loopHistory[]`, reset judgments
   for notes in `[loopA, loopB]` range.
3. `getLoopStats()` returns current iteration + best historical iteration.

---

## Integration Points

### Existing Highway API Used

| API                          | Purpose                                  |
|------------------------------|------------------------------------------|
| `highway.addDrawHook(fn)`    | Register the overlay renderer            |
| `highway.removeDrawHook(fn)` | Cleanup on plugin unload                 |
| `highway.getTime()`          | Current chart time (audio-aligned)       |
| `highway.getAvOffset()`      | A/V offset in ms; visual render clock = `getTime() + getAvOffset()/1000` — use this when computing `tOffset` for `project()` calls inside draw hooks, otherwise markers appear shifted when the user has calibrated A/V latency |
| `highway.getNotes()`         | All chart notes (for matching)           |
| `highway.getChords()`        | All chart chords (match individual notes)|
| `highway.getSections()`      | Section boundaries (for section grading) |
| `highway.getSongInfo()`      | Tuning offsets for frequency calculation |
| `highway.project(tOffset)`   | Convert time offset to Y position        |
| `highway.fretX(fret, scale, w)` | Convert fret to X position using `scale` from `highway.project(tOffset)` |
| `highway.fillTextUnmirrored` | Text that stays readable in lefty mode   |

### Existing App.js Used

| Global                       | Purpose                                  |
|------------------------------|------------------------------------------|
| `loopA`, `loopB`             | Current A-B loop boundaries              |
| `audio.currentTime`          | Actual audio playback position           |

### New Events Emitted (via `window.feedBack.emit`)

| Event                        | Payload                                  |
|------------------------------|------------------------------------------|
| `note:hit`                   | full `Judgment` object (see §Judgment Data Structure) |
| `note:miss`                  | full `Judgment` object                   |
| `loop:complete`              | `{ iteration, stats }`                   |
| `note:sectionGrade`          | `{ section, grade, hits, total }`        |

`note:hit` and `note:miss` always carry the complete `Judgment` object so
subscribers can inspect `timingState`, `pitchState`, timing/pitch errors, and
raw detection data independently, without the emitter having to pre-select fields.

---

## Configuration (plugin settings)

There are three distinct threshold tiers — keep them conceptually separate:

| Tier | Setting(s) | Role |
|------|-----------|------|
| **Match window** | `matchWindowMs`, `pitchToleranceCents` | Outer gate: a detection is only correlated to a chart note if it falls within these limits. Outside → ignored (extra note, not an attempt). |
| **Hit threshold** | `timingThresholdMs`, `pitchThresholdCents` | Sets `hit: true`. A matched note is a clean hit when `|timingError| ≤ timingThresholdMs` **and** `|pitchError| ≤ pitchThresholdCents`. Also triggers the green glow. Must be ≤ match window values. |
| **Label threshold** | (same keys) | Same values double as the boundary at which EARLY/LATE/SHARP/FLAT labels appear. Within the hit threshold = `'OK'` state; outside = labeled state. |

| Setting                | Default | Description                                                    |
|------------------------|---------|----------------------------------------------------------------|
| `matchWindowMs`        | 200     | Outer time tolerance for correlating a detection to a chart note (ms) |
| `pitchToleranceCents`  | 50      | Outer pitch tolerance for correlation (cents)                  |
| `timingThresholdMs`    | 100     | `|timingError| ≤ this` → `timingState: 'OK'` and `hit` eligible; also defines the EARLY/LATE label boundary |
| `pitchThresholdCents`  | 20      | `|pitchError| ≤ this` → `pitchState: 'OK'` and `hit` eligible; also defines the SHARP/FLAT label boundary |
| `showTimingErrors`     | true    | Show EARLY/LATE labels when `timingState` is non-OK            |
| `showPitchErrors`      | true    | Show SHARP/FLAT labels when `pitchState` is non-OK             |
| `missMarkerDuration`   | 2.0     | How long miss markers stay visible (sec)                       |
| `showLoopSummary`      | true    | Show stats on loop wrap                                        |
| `hitGlowDuration`      | 0.5     | Green glow fade time (sec)                                     |

Persist these settings in plugin-local storage (e.g. `localStorage` prefixed
with the plugin id). Do **not** assume they can be saved through FeedBack's
`/api/settings` endpoint under a `notedetect_feedback` key — the current server
only persists a fixed set of known settings keys. If backend support for a
dedicated persisted key is added later, this plugin may migrate to `/api/settings`.

---

## What This Does NOT Cover

- **Audio input / pitch detection** — handled by the detection plugin
- **Device selection UI** — handled by the detection plugin
- **Score persistence / history** — future work (practice journal plugin)
- **Difficulty scaling** — automatic dynamic-difficulty scaling is not implemented
- **Chord grading** — chords are graded per-note (each note in the chord
  is independently matched), not as a single unit
