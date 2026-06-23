# FeedBack Note Detect Bass Benchmark — v1

A bass-focused companion to the guitar benchmarks
(note_detect_v1 + note_detect_v2). Tests `note_detect` against bass-
specific idioms: walking lines, octave jumps, root+fifth patterns,
double-stops, and long low-E holds that stress YIN's accumulator at
~41 Hz.

- **Tempo**: 90 BPM
- **Tuning**: E standard 4-string (E1 A1 D2 G2, no capo)
- **Audio**: metronome click track only — play *over* the click.
- **Duration**: 181 s

## Sections

| Section | Tests |
|---|---|
| A. Open strings (slow walk) | Mono detection on each open string, low → high → low |
| B. 5th-fret (slow walk) | Fretted-note detection across the 4 strings |
| C. Sustained notes | 3 × 4-second held roots |
| D. Octave walks | Root ↔ octave alternation, 2 strings + 2 frets up |
| E. Walking bassline | A minor pentatonic ascending + descending |
| F. Root + fifth pattern | Classic rock bass pattern (8 events) |
| G. Double-stops | 2-string voicings — the chord-scorer test for bass |
| H. Long low-E holds | 3 × 5-second E1 holds, stresses YIN under-buffer regime |

## Reporting

Diagnostic JSON schema is `note_detect.diagnostic.v1`. Filter
`benchmark_hint` to bucket bass vs guitar runs.

## Source

Built by `docs/benchmarks/note_detect_bass_v1/build_benchmark.py`.
