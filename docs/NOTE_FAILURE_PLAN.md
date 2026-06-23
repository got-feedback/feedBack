# Note Failure Feedback — Implementation Plan

Depends on: `docs/NOTE_FAILURE_SPEC.md` (read that first)

---

## Phase 0: Detection Plugin Foundation

**Goal:** Working note detection plugin streaming detected notes via WebSocket.

This phase was previously tracked in a separate NOTE_DETECTION_PLUGIN_PLAN
document (in the `feedBack-plugin-notedetect` repository). The relevant scope
is summarized here to avoid relying on an internal git-only reference:

- [ ] Plugin skeleton: `feedBack-plugin-notedetect/` with plugin.json, routes.py, screen.js
- [ ] Port TonalRecall YIN detection (aubio + sounddevice) to routes.py
- [ ] WebSocket at `/api/plugins/note_detect/stream` streaming `{ note, freq, confidence, time }`
- [ ] Device selection UI in screen.html
- [ ] requirements.txt: aubio, sounddevice, numpy

**Exit criterion:** With plugin active and guitar plugged in, playing a note
causes a JSON event to appear in the browser console.

---

## Phase 1: Note Matching Core

**Goal:** Client-side matching of detected notes to chart notes. No rendering yet —
console logging only.

**Files:**
- `screen.js` in the notedetect plugin

**Tasks:**
- [ ] Implement `expectedFreq(string, fret, tuningOffsets, capo, stringCount, arrangementName)` using
      base open-string frequencies, semitone offsets from `highway.getSongInfo().tuning`,
      and semitone math (`2^(semitones/12)`) rather than assuming 6-string standard
      tuning; use `highway.getStringCount()` as the authoritative string count because
      tuning may be padded to length 6 for RS XML sources even for bass/extended-range
      arrangements; include `highway.getSongInfo().capo` as additional semitones if
      the intent is expected sounding pitch; pass `highway.getSongInfo().arrangement` as
      `arrangementName` to disambiguate 5-string bass vs 5-string guitar (matching the
      spec's `getBaseTuning` helper)
- [ ] Implement `NoteJudgmentTracker` class with:
  - `addDetection(detected)` — correlate with nearest unmatched chart note
  - `update(currentTime)` — expire pending notes whose match window has passed
  - `getJudgmentsInRange(tStart, tEnd)` — return judgments in time range
  - `reset()` — clear all state
- [ ] Connect to detection WebSocket, feed events into tracker
- [ ] Initialize tracker with `highway.getNotes()` and `highway.getChords()` on song ready
- [ ] Console.log each judgment as it resolves (HIT/MISSED/EARLY/LATE/SHARP/FLAT)
- [ ] Re-initialize tracker on `song:ready` (fires on every new song **and** on every
      arrangement switch — no need to hook `highway.reconnect` or other internals);
      do **not** use `song:loaded` — note/chord arrays are still empty at that point (data
      arrives incrementally and only completes at `song:ready`)

**Exit criterion:** Playing along with a song, console shows correct HIT/MISSED
judgments with timing and pitch error values.

**Estimated scope:** ~200 lines JS

---

## Phase 2: Hit/Miss Highway Overlay

**Goal:** Visual feedback on the highway — green glow for hits, red X for misses.

**Files:**
- `screen.js` in the notedetect plugin (draw hook)

**Tasks:**
- [ ] Register `highway.addDrawHook()` that reads judgments from the tracker
- [ ] **Hit rendering:** Green glow ring behind notes at the now-line, fading over
      `hitGlowDuration` seconds. Use `highway.project()` and `highway.fretX()` for
      positioning. Additive blend via `ctx.globalCompositeOperation = 'lighter'`.
- [ ] **Miss rendering:** Red `✕` marker at the note's string/fret position, drawn
      in the "past" region below the now-line. Do **not** rely on
      `highway.project(negative_offset)` for long-lived placement — the current
      renderer returns `null` for offsets more than ~50ms into the past. Instead,
      anchor at the now-line (`highway.project(0)`) and map elapsed time since the
      miss to a linear below-now-line Y position (configurable pixels/second), fading
      the marker after `missMarkerDuration` seconds.
- [ ] **String pulse:** Brief red tint on the missed note's string (200ms fade on
      the string line segment near the now-line).
- [ ] Handle lefty mode: use `highway.fillTextUnmirrored()` for text markers.
- [ ] Cleanup: `highway.removeDrawHook()` on plugin destroy.

**Exit criterion:** Playing a song, you see green flashes on hit notes and red X
markers scrolling past on missed notes.

**Estimated scope:** ~150 lines JS

---

## Phase 3: Diagnostic Labels (Timing + Pitch)

**Goal:** Show *why* a note was missed — too early, too late, sharp, flat.

**Files:**
- `screen.js` in the notedetect plugin

**Tasks:**
- [ ] Extend draw hook to render timing indicators:
  - EARLY: orange `↑` + "-XXms" label above the miss marker
  - LATE: orange `↓` + "+XXms" label below the miss marker
  - Only shown when timing error exceeds `timingThresholdMs`
- [ ] Extend draw hook to render pitch indicators:
  - SHARP: blue `♯` + "+XX¢" label
  - FLAT: blue `♭` + "-XX¢" label
  - Only shown when pitch error exceeds `pitchThresholdCents`
- [ ] Compound states: stack timing label on top, pitch label below
- [ ] Add settings UI in plugin settings panel for threshold configuration
- [ ] Ensure labels don't overlap — offset vertically when multiple notes
      miss at close timestamps

**Exit criterion:** Playing intentionally early/late or bending sharp/flat
shows the correct diagnostic labels.

**Estimated scope:** ~100 lines JS, ~30 lines settings HTML

---

## Phase 4: Loop Iteration Tracking

**Goal:** Track performance across loop iterations, show summary on each wrap.

**Files:**
- `screen.js` in the notedetect plugin

**Tasks:**
- [ ] Detect loop wrap: `currentTime < previousTime - 0.5` in the frame update
- [ ] On wrap: snapshot `{ hits, misses, total, percentage }` to `loopHistory[]`
- [ ] Reset judgments for notes in `[loopA, loopB]` range (keep tracker alive
      for notes outside the loop)
- [ ] Render loop summary overlay (top-center, semi-transparent background):
  ```
  Loop N  |  X/Y notes (Z%)  |  Best: W%
  ```
  Displayed for 1.5s, then fades.
- [ ] Track `bestIteration` across all iterations for "Best" display
- [ ] Emit `loop:complete` event via `window.feedBack.emit()` so other plugins
      (practice journal) can record the data
- [ ] Reset loop history when loop boundaries change or loop is cleared

**Exit criterion:** Looping a 4-bar phrase, you see iteration count and accuracy
flash briefly at each loop wrap. Best score persists across iterations.

**Estimated scope:** ~120 lines JS

---

## Phase 5: Section Grading

**Goal:** Grade each song section (intro, verse, chorus, solo) and surface weak spots.

**Files:**
- `screen.js` in the notedetect plugin

**Tasks:**
- [ ] Use `highway.getSections()` to identify section boundaries
- [ ] Track hits/misses per section as notes are judged
- [ ] At section boundaries (when `currentTime` crosses a section end),
      briefly flash the section grade:
  - A: 90%+, B: 75%+, C: 60%+, D: 40%+, F: below 40%
  - Color: green (A/B), yellow (C), red (D/F)
- [ ] After song completes (or at any point via a hotkey), show a section
      summary panel listing all sections with grades
- [ ] Highlight lowest-scoring section with a "Loop this section" button
      that sets A-B points to that section's boundaries
- [ ] Emit `note:sectionGrade` event for other plugins

**Exit criterion:** Playing through a song, section grades flash at each
transition. Lowest section is highlighted for targeted practice.

**Estimated scope:** ~150 lines JS, ~40 lines HTML

---

## Phase 6: Polish + Settings

**Goal:** Configurable thresholds, visual polish, performance.

**Tasks:**
- [ ] Full settings panel in plugin settings HTML:
  - Match window slider (100-500ms)
  - Pitch tolerance slider (20-100 cents)
  - Toggle timing/pitch labels
  - Toggle loop summary
  - Miss marker duration slider
- [ ] Performance: ensure draw hook stays under 1ms per frame
  - Pre-compute judgment positions, don't recalculate in draw loop
  - Binary search over judgments by time (same pattern as `drawNotes`)
- [ ] Smooth animations: glow/fade using eased alpha, not linear
- [ ] Color-blind accessible palette option (use shapes not just colors)
- [ ] Persist settings in plugin-local storage (e.g. `localStorage` prefixed with
      plugin id) — do **not** use `/api/settings` for this; the current server only
      persists a fixed set of known keys and will silently discard `notedetect_feedback`

**Estimated scope:** ~100 lines JS, ~60 lines HTML

---

## Dependency Graph

```
Phase 0 (detection plugin)
    ↓
Phase 1 (matching core)
    ↓
Phase 2 (hit/miss overlay)  ← Minimum viable feature
    ↓
Phase 3 (diagnostic labels)
    ↓
Phase 4 (loop tracking)     ← Core practice value
    ↓
Phase 5 (section grading)
    ↓
Phase 6 (polish)
```

Phases 3-5 are independent of each other and can be done in any order after Phase 2.
Phase 6 should be last.

---

## Risk / Open Questions

1. **Latency budget:** Detection → WebSocket → matching → render adds latency.
   If total pipeline > 100ms, the match window needs to compensate with asymmetric
   tolerance (more lenient for "late" detections). Measure in Phase 1.

2. **Chord matching granularity:** Current plan matches chord notes individually.
   Should a chord be "missed" if 4/6 notes hit? Propose: grade chords as
   percentage, treat as HIT if ≥50% of notes matched. Revisit after Phase 2 testing.

3. **Tempo-scaled thresholds:** At 200 BPM, a 200ms match window covers almost
   an entire beat. Should thresholds scale with tempo? Propose: don't over-engineer
   this initially. Fixed thresholds work for most tempos. Revisit if users report
   issues at extreme tempos.

4. **Detection plugin availability:** Everything in Phases 1-6 degrades gracefully
   if the detection WebSocket isn't connected — the draw hook simply has no
   judgments to render, and the highway looks exactly as it does today.
