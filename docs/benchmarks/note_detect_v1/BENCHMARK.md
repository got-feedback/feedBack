# FeedBack Note Detect Benchmark — v1

A short test piece for tuning FeedBack's `note_detect` plugin. Eight
exercises, each isolating a specific detection failure mode. Run with
**Detect** enabled, play through, then export the diagnostic JSON
(Settings → Plugins → Note Detection → Download Diagnostic JSON, or
the button on the end-of-session summary modal).

- **Tempo**: 90 BPM
- **Tuning**: E standard (no capo)
- **Audio**: metronome click track only (downbeat = louder + higher
  tone). Play *over* the click — `note_detect` listens to your guitar
  signal, not the audio in this file.
- **Duration**: 139 s

## Sections

| Section | Tests | Watch in the diagnostic |
|---|---|---|
| A. Open strings (low→high→low) | Basic mono detection on each open string | `pure` (mic/audio chain), per-string accuracy |
| B. 5th-fret positions | Fretted-note detection across all 6 strings | per-string variance |
| C. 12th-fret octaves | Higher-frequency detection — YIN's octave-up risk | `sharp` bin spiking |
| D. Sustained notes (4 s) | The `active` held-on-pitch glow | `sharp`/`flat` drift while held |
| E. Hammer-on / pull-off | Transient detection without a fresh pick attack | `pure` (no transient registered) |
| F. Power chords (2-string) | Chord leniency on sparse voicings | `chordPartial` |
| G. Open major chords | Chord leniency on dense voicings (E, A, D, G) | `chordPartial` |
| H. Bends (half- + whole-step) | Single-note pitch tolerance with pitch in motion | `sharp` bin |

## Reporting

Share the JSON (schema `note_detect.diagnostic.v1`). It includes:

- Hit/miss totals split single-note vs chord
- Primary-cause bin per miss (pure / chord-partial / early / late / sharp / flat)
- Per-string hit rate
- Signed timing- and pitch-error percentiles (p10 / median / p90)
- Detection settings snapshot (method, tolerances, leniency)
- Per-judgment event log (capped at 2000 events) with the chart note's
  technique flags so each miss can be re-binned by `SUS`/`B`/`H`/etc. offline
- `benchmark_hint`: `{title, artist, arrangement}` — filter on these
  to bucket reports from different runs of this benchmark.

## Source

Built by `docs/benchmarks/note_detect_v1/build_benchmark.py` in the
feedBack repo. Tweak the exercise list there and regenerate.
