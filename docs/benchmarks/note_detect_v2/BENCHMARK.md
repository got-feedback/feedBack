# FeedBack Note Detect Benchmark — v2

A slower-paced companion to v1, focused on what players can actually
land cleanly. Half-note spacing throughout (~1.33 s between events at
90 BPM), with multiple **strumming** sections — single chord voicings
repeated at half-note cadence — to exercise the chord scorer's
consistency across a sequence of strikes.

- **Tempo**: 90 BPM
- **Tuning**: E standard (no capo)
- **Audio**: metronome click track only — play *over* the click.
- **Duration**: 181 s

## Sections

| Section | Tests |
|---|---|
| A. Open strings (slow walk) | Basic mono detection, low → high → low at half-note pacing |
| B. 5th-fret (slow walk) | Fretted-note detection, ascending half-notes |
| C. Sustained notes | Long-hold pitch detection, 4 s each |
| D. E5 power chord strum | Chord scorer on a 2-string voicing, 8 strums |
| E. A5 / E5 alternating | Chord scorer on a voicing change, 8 strums total |
| F. E major strum | 6-string dense voicing, 8 strums |
| G. A major strum | 5-string voicing (skips low E), 8 strums |
| H. D major strum | 4-string voicing (skips low E + A), 8 strums |

No hammer/pull, no bends — those are next on the algorithm-tuning
list and aren't useful as benchmarks until that work lands.

## Reporting

Share the diagnostic JSON (schema `note_detect.diagnostic.v1`).
Filter `benchmark_hint` to bucket v1 vs v2 runs.

## Source

Built by `docs/benchmarks/note_detect_v2/build_benchmark.py`.
