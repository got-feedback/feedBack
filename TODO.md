# Note Failure Feedback

Some rhythm-practice tools mark missed or failed notes with **exclamation marks** (!) on the note highway at the position where the missed note was. On chords, the exclamation mark sits directly above the chord "bars," which can make them hard to see on songs with dense six-string chords — and such markers often can't be resized or recolored.

A few related things worth knowing:

- The markers are persistent visual flags on the note track after the note passes, not a popup or audio cue.
- For stricter feedback, a zero error-tolerance mode can require a clean run before a looped section advances.
- Forgiving note detection means an occasional genuinely missed note won't get
  flagged, especially in fast passages — a tighter scoring mode helps when you
  want stricter grading.

Goal: reproduce and improve on that behavior. When a user loops over the same
5-note lick repeatedly, the highway should show note misses with diagnostic
detail — which note was missed and *how* it was missed (too late / too early /
too sharp / too flat / not played).

## Docs

- **[Technical Spec](docs/NOTE_FAILURE_SPEC.md)** — architecture, matching
  algorithm, rendering design, data structures, integration points
- **[Implementation Plan](docs/NOTE_FAILURE_PLAN.md)** — 7 phases from
  detection foundation through section grading and polish
- **Note Detection Plugin Plan** — see the
  [slopsmith-plugin-notedetect](https://github.com/topkoa/slopsmith-plugin-notedetect)
  repository (Phase 0 foundation)
