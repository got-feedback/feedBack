# Note Detection Tuning Workflow

How to iterate on the `note_detect` plugin's detection quality with objective, repeatable measurements instead of "feels worse / feels better" guesswork. The same workflow works for tuning the user's environment (A/V offset, latency comp, channel selection) and for tuning the detector code itself (frame size, confidence thresholds, chord-scoring algorithm).

## Why this exists

Detection quality varies by guitar pickup, audio interface, monitor latency, the user's playing style, and the chart's note density. Eyeballing the player UI tells you whether something feels right, not whether a change improved or regressed scoring. The pieces below let you record once and replay many times against arbitrary parameter combinations:

- **Reference recording** — captures the exact PCM frames the live detector saw, so a single take can be re-scored against any settings.
- **Benchmark sloppak** — a known, distributable chart with isolated failure-mode sections.
- **Headless harness** — runs the same `processFrame` / `matchNotes` / `checkMisses` code path the browser uses, off Node, in seconds per run.
- **Diagnostic JSON** — both live (in-browser) and harness output share the `note_detect.diagnostic.v1` schema, so cross-comparison is trivial.

## The benchmark sloppak

The distributable sloppak ships in-tree at [docs/benchmarks/note_detect_v1/note_detect_benchmark_v1.sloppak](benchmarks/note_detect_v1/note_detect_benchmark_v1.sloppak) — drop it directly in your library folder (e.g. `<your-library>/sloppak/`) and it shows up in the library. The file is a zip under the hood but feedBack's loader (`is_sloppak`) keys off the `.sloppak` suffix, so don't rename. After playing it once it ends up extracted under `static/sloppak_cache/note_detect_benchmark_v1.sloppak/`, which is where the harness reads its `arrangements/lead.json` from. 90 BPM, 8 numbered sections, ~2:20 total:

| Section | Notes | Isolates |
|---|---|---|
| A. Open strings | 12 single notes | low-frequency YIN behaviour (E2=82 Hz) |
| B. 5th-fret positions | 12 single notes | mid-range pitch accuracy |
| C. 12th-fret octaves | sparse single notes | high-frequency YIN behaviour |
| D. Sustained notes | long-hold single notes | sustain matching / pure-miss vs detected |
| E. Hammer / pull | legato pairs | technique-flag handling, attack ambiguity |
| F. Power chords | 8 chord events | 2-string chord scorer |
| G. Open chords | 8 chord events | dense chord scorer (5+ strings ringing) |
| H. Bends | bend pairs | pitch-tolerance edge behaviour |

Every chart note has `sus > 0` — so anything you tune against this benchmark exercises the sustain path, not staccato detection. (If we add a staccato section later, the cleanest split is by section name; don't categorize by `sus` value on the event log — see the "Common pitfalls" section.)

To rebuild after edits to the exercise list, follow the docstring at the top of `build_benchmark.py`. The script writes both an unzipped directory (`.sloppak/`) and a zipped archive (`.sloppak.zip`). The feedBack library scanner (`lib/sloppak.py::is_sloppak()`) matches on the `.sloppak` suffix, **not** on `.sloppak.zip` — the directory form is usable as-is, but the zip output needs its suffix swapped before it'll be discovered. After regenerating, copy the zip output to the tracked path with the `.sloppak` suffix so it stays a drop-in install. Run from the feedBack repo root so the relative paths resolve:

```bash
# From the feedBack repo root.
cp static/sloppak_cache/note_detect_benchmark_v1.sloppak.zip \
   docs/benchmarks/note_detect_v1/note_detect_benchmark_v1.sloppak
```

Also update `docs/benchmarks/note_detect_v1/BENCHMARK.md` if you changed sections — it's the user-facing description that ships inside the sloppak, kept alongside the tracked file so contributors can see the section list without having to unzip.

## End-to-end iteration loop

The typical cycle for one tuning hypothesis:

1. **Enable tuning mode** (Settings → Note Detection → "Detection tuning (advanced)"). Off by default; turns on the dev surfaces (Reference Recording, Diagnostic JSON, miss-category breakdown).
2. **Arm a recording** from the gear popover next to the Detect button on the player. Arm before pressing Play.
3. **Play through the benchmark** (or any song) at **1.0× playback speed**. Half-speed playback breaks audio↔chart alignment and produces all-miss garbage — see Pitfalls.
4. **Auto-save fires on song end.** The WAV lands in `static/note_detect_recordings/note_detect_<slug>_<timestamp>.wav` (bind-mounted, so it's reachable from the host without a copy step).
5. **Run the headless harness** with a known config. Paths below assume the note_detect plugin is cloned into `plugins/note_detect/` (see the feedBack README for the plugin-install flow — note_detect ships as a separate repo):
    ```bash
    node plugins/note_detect/tools/harness.js \
        --audio static/note_detect_recordings/note_detect_<…>.wav \
        --chart static/sloppak_cache/note_detect_benchmark_v1.sloppak/arrangements/lead.json \
        --out /tmp/run.json
    ```
   Prints a one-liner: `<hits>/<total> hits (<%>) — breakdown {pure, chordPartial, early, late, sharp, flat}`.
6. **Sweep parameters** by re-running the harness with different flags (see "Harness flags" below). Compare bins side-by-side. The same recording can drive dozens of runs in seconds.
7. **Form a hypothesis, change code or settings, repeat.** Each PR or settings tweak should move at least one bin in the right direction. If you can't show that, you don't have evidence to ship it.

## Harness flags

All flags map 1:1 to a runtime setting; defaults mirror what a fresh plugin install ships with:

| Flag | Default | Notes |
|---|---|---|
| `--audio <path>` | — | WAV/OGG/MP3 input. WAV is parsed natively; other formats need ffmpeg on PATH. |
| `--chart <path>` | — | The arrangement JSON (e.g. `arrangements/lead.json` from a sloppak directory). |
| `--out <path>` | — | Diagnostic JSON destination. |
| `--method yin\|hps` | `yin` | CREPE is not exercised by the harness (needs WebGL). |
| `--pitch-tolerance <cents>` | `50` | Outer match window for pitch. |
| `--pitch-hit-threshold <cents>` | `20` | Tighter band that counts as "clean" pitch. |
| `--timing-tolerance <s>` | `0.150` | Outer match window for timing. |
| `--timing-hit-threshold <s>` | `0.100` | Tighter band that counts as "clean" timing. |
| `--chord-hit-ratio <r>` | `0.6` | Fraction of strings that must ring for a chord hit (per-string energy bands). |
| `--latency <s>` | `0.080` | Detector pipeline latency compensation. |
| `--frame-size <n>` | `1024` | YIN buffer size in samples. Bigger = better low-freq detection, more latency. |
| `--sample-rate <hz>` | `44100` | Decode target. The WAV reader resamples if the file is different. |
| `--arrangement guitar\|bass` | `guitar` | Picks the open-string MIDI table. |
| `--string-count <n>` | `6` | Used by the string-fret → MIDI math. |
| `--av-offset-ms <ms>` | `0` | Same semantics as `setAvOffsetMs` — pass the user's main-Settings value when replaying their take. **Use `=` for negatives**: `--av-offset-ms=-100`. |
| `--verbose` | off | Logs progress to stderr. |

## Diagnostic JSON — the bits that matter for iteration

Schema `note_detect.diagnostic.v1`. Identical output from live (Settings → Download Diagnostic JSON) and harness. Key fields when comparing runs:

- `summary.hits / misses / accuracy` — top-line score.
- `miss_breakdown` — per-category miss bins:
  - `pure` — detector never reported a confident matching pitch in the note's time window. Usually a detector or buffer issue.
  - `chordPartial` — chord saw some strings but missed the per-string ratio.
  - `early / late` — pitch was right but timing landed outside the inner hit threshold.
  - `sharp / flat` — pitch was outside the pitch hit threshold (but inside the outer tolerance, otherwise it'd be `pure`).
- `timing_error_ms` — distribution over **all matched judgments**. Pinned near a constant when av-offset is wrong (matcher snaps to nearest chart note); use for diagnostics only, *not* as a calibration signal.
- `timing_error_ms_hits` — distribution over **only hits**. Responds linearly to av-offset. The A/V auto-calibrate feature keys off this.
- `pitch_error_cents` — same shape as timing but for pitch.
- `events[]` — per-judgment log (capped). Each entry: `{t, at, s, f, sus, hit, chord, ts, ps, te, pe, ex, dx, cnf, tf}`. The `cnf` field is the pitch-detection confidence at match time; `dx` is the detected MIDI; `ex` is the expected MIDI.

## A/V auto-calibrate — the iterative pattern

Settings → Note Detection → "A/V Sync — Auto-Calibrate" surfaces a button that reads `timing_error_ms_hits.median` and applies `setAvOffsetMs(currentOffset − median)`. Expected workflow:

1. If your current A/V offset is wildly off and you're getting almost no hits, **reset the main Settings A/V slider to 0 first**. The matcher snaps to wrong chart notes when offset is far off, which makes `te-hits` an unreliable signal.
2. Play a section with Detect on until you see at least 5 hits on the counter.
3. Click **Apply** — it sets the new offset and clears the timing samples so the next reading reflects only the new regime.
4. Play another section. Apply again. Usually converges in 2–3 rounds; the button greys out as "Already within 20 ms" when there's nothing useful left to suggest.

Crucially: **don't trust the suggestion at low hit counts.** Hits at a far-off offset come from coincidental near-matches to wrong chart notes, and their median is noise. The button gates on `n ≥ 5` but for noisy players a higher manual threshold is wise.

## Common pitfalls

- **Playback speed must be 1.0× during recording.** The recording captures audio at whatever pace it actually played, but the chart times are absolute. A half-speed take produces all-miss output because every chart event fires its match window before the audio has reached that note. Always confirm the speed slider before pressing Play.
- **Don't categorize event-log entries by `event.sus`.** `checkMisses` historically passed only `{s, f}` into miss judgments, so every pure-missed sustained note showed up as `sus=0` in the event log. The bug is fixed (full chart-note flows through now) but old recordings on older builds will mislead you. The reliable answer is to join event entries back against the source chart by `(t, s, f)` and read `sus` from there.
- **All-matched `timing_error_ms.median` is *not* a calibration signal.** When A/V offset is wrong, the matcher matches the user's pluck against whatever chart note is closest in time, not the intended one. The resulting te median is pinned near a constant regardless of the offset value. Always use `timing_error_ms_hits.median` for calibration math.
- **At a very wrong A/V offset, the auto-calibrate suggestion can point further wrong.** When few hits land, their te median is a property of which wrong chart notes happened to be reachable, not of the user's real skew. Start near zero or near a known reasonable value if you suspect the offset is far off.
- **Sweeping parameter X won't fix a problem that lives outside X.** If pure misses dominate at the default config and stay pinned across a 4× range of frame sizes or pitch tolerances, the bottleneck is not those parameters — likely the detector algorithm, the chord scorer, or the matching window logic. Recognise the ceiling and pivot to code changes.
- **Match the recording's sample rate when scoring chords.** The chord scorer is fully self-contained (its own FFT, not `AnalyserNode`) and runs in the harness identically to the browser path. But the harness defaults to `--sample-rate 44100` while most modern USB interfaces capture at 48000 — passing the WAV at the wrong rate resamples it linearly, which smears the FFT bins enough to swing chord-hit counts by 1–2 per take. Cross-validated against one contributor's 48 kHz recording, harness at `--sample-rate 48000 --frame-size 2048` reproduces his live chord-hit count within ±1 (9/16 vs his 10/16). Single-note scoring is less sensitive to this and the default sample rate is usually fine.
- **Bumping the latency-offset default doesn't generalise.** The right latency comp is heavily audio-chain-dependent (USB interface vs. on-board, ScriptProcessor buffering, OS audio path). A value that's perfect for one user over-corrects for another — bumping the default to match the best-tuned user we had data for regressed two of four fixtures. Leave latency at the conservative default and rely on the A/V auto-calibrate panel + the user-facing slider to dial it in per-chain.

## Recipes

### Live judgment streaming — watching a session in flight

When tuning mode is on, the plugin POSTs each judgment to `POST /api/plugins/note_detect/live-judgment` as it's produced. Backend appends one JSON line to `static/note_detect_recordings/live_<sessionId>.jsonl`. A fresh session id is minted on every `song:play`, so each take produces its own file paired with the recorded WAV (when arming) by timestamp.

The file is human-readable and updates while the song plays. Tail it with `Get-Content -Wait` on Windows or `tail -f` on macOS/Linux:

```jsonl
{"t":5.333,"s":0,"f":0,"hit":true,"ts":"OK","te":12,"pe":3,"cnf":0.94}
{"t":6.000,"s":1,"f":0,"hit":false,"ts":"EARLY","te":-180,"cnf":0.71}
{"t":6.667,"s":2,"f":0,"hit":true,"ts":"OK","te":-20,"pe":8}
```

This is the lowest-friction way to share a session with a collaborator: they don't need to wait for the song to end, you don't need to upload anything — the file lives in the bind-mounted `static/` tree, so any host-side process can read it during play.

Limitations:
- Streaming is fire-and-forget; the POSTs don't block detection. A request failure is silently swallowed so the in-memory diagnostic stays the source of truth.
- File cap is 8 MB per session (a 3-minute song produces ~60 KB, so this is 100× headroom). Beyond the cap the route returns 413 and the in-memory log keeps growing.
- Disabled outside tuning mode — normal users pay no overhead.

### "Did my detector change improve things?" — the regression suite

For a single fixture, two ad-hoc harness runs work (see below). For real iteration where you want **all** your fixtures measured against a stored baseline, use the regression driver in the plugin:

```bash
cd plugins/note_detect

# One-time: copy the example, edit paths to point at your recordings.
cp tools/regression-fixtures.example.json tools/regression-fixtures.json

# Capture a baseline (do this BEFORE making any code changes).
npm run regression:update

# ...make detector changes...

# Re-measure against the baseline. Exit code 1 if any fixture regresses.
npm run regression:vs-baseline
```

The driver iterates each fixture, runs `harness.js`, and prints a table of `hits/total · pure · chordPartial · Δhits-vs-baseline`. Both the fixtures file and the baseline are gitignored — they reference your local recordings, which aren't portable across contributors. Commit them in your fork if you want CI, otherwise treat them as local state.

The same workflow works on any tuning change — A/V offset sweep, frame-size sweep, algorithm experiments. Just make sure the baseline was captured *before* the change you want to measure.

### "Did my detector change improve things?" — ad hoc

Same recording, same chart, two harness runs. Recipe assumes you're at the feedBack repo root *and* that the Note Detection plugin is cloned at `plugins/note_detect/` per the README. The detector source lives in that nested plugin repo, which feedBack's `.gitignore` excludes via `plugins/*/`, so the stash dance has to run **inside** the plugin repo — `git stash` from the feedBack root would either bail out or, worse, stash unrelated feedBack edits.

The stash dance below uses **`git stash push -u -m "..."`** to give the stash a known name *and* include untracked files. `-u` matters: if your detector change added a new module or fixture, an untracked-file-blind stash would leave it on disk during the "before" run and contaminate the baseline. The script then asserts a stash was actually created before popping (so a clean worktree doesn't silently pop someone else's WIP), wraps each step in **`set -euo pipefail`** so a failed `git stash pop` (e.g., conflict) aborts before the "after" harness records an invalid result, and uses `trap` to surface any failure with a clear message.

```bash
set -euo pipefail
PLUGIN_DIR=plugins/note_detect
HARNESS=$PLUGIN_DIR/tools/harness.js
STASH_MSG="harness-before-$$"
trap 'echo "harness recipe aborted — stash may still be in $PLUGIN_DIR (\"git -C $PLUGIN_DIR stash list\")" >&2' ERR
# Stash the detector edits inside the plugin repo, not the feedBack root.
# -u also stashes untracked files (new modules, fixtures) so they don't
# leak into the "before" baseline. `|| true` only swallows the
# clean-worktree case, which the next line catches explicitly.
git -C "$PLUGIN_DIR" stash push -u -m "$STASH_MSG" || true
# Bail out cleanly if nothing was stashed — running the "before" against
# the same code as "after" would just produce identical numbers.
git -C "$PLUGIN_DIR" stash list | grep -q "$STASH_MSG" || { echo "no detector changes to stash in $PLUGIN_DIR — try again with edits in place"; exit 1; }
node $HARNESS --audio <wav> --chart <json> --out /tmp/before.json
# `stash pop` failures (e.g., conflicts that auto-merge can't resolve)
# now abort via set -e instead of silently rolling into the "after" run
# with a half-restored tree.
git -C "$PLUGIN_DIR" stash pop "$(git -C "$PLUGIN_DIR" stash list | grep "$STASH_MSG" | head -1 | cut -d: -f1)"
node $HARNESS --audio <wav> --chart <json> --out /tmp/after.json
node -e "
const fs = require('fs');
for (const [n, p] of [['before','/tmp/before.json'],['after','/tmp/after.json']]) {
  const d = JSON.parse(fs.readFileSync(p,'utf8'));
  console.log(n, d.summary, d.miss_breakdown);
}
"
```

If `summary.hits` went up *and* no miss-bin went up by more than ~1, ship it. If hits went up but `sharp/flat` went up too, you traded pure misses for pitch misses — investigate whether the tolerance shift makes sense.

### "Find the optimal A/V offset for this take"

Sweep:

```bash
HARNESS=plugins/note_detect/tools/harness.js
for AV in -100 -50 0 50 100 150 200; do
  echo "=== av=$AV ==="
  node $HARNESS --audio <wav> --chart <json> --av-offset-ms=$AV --out /tmp/sw_$AV.json | tail -1
done
```

Pick the highest hit count, then narrow in with finer steps. Cross-reference with `timing_error_ms_hits.median` — at the optimum it'll be close to zero.

### "Categorize misses by chart section"

Join the event log against the chart's `sections[]` to bin per-section hit rate. Useful for finding which exercises in the benchmark sloppak a tuning change improves or regresses.

### "Why is this specific note pure-missed?"

Find the note's `t` in the chart, then grep the event log for entries near that time. If `cnf` is 0 for every nearby event, the detector never fired confidently — likely a YIN buffer / confidence issue. If `cnf > 0` but `dx` doesn't match `ex`, pitch detection is firing on a different note (octave error, harmonic, neighbour string).

## Reference

The Note Detection plugin lives in its own repository — these links go to the canonical source at github.com. If you've cloned the plugin into a local `plugins/note_detect/` next to this repo, the same files are at the equivalent path on disk.

- Plugin source: [`screen.js`](https://github.com/got-feedback/feedBack-plugin-notedetect/blob/main/screen.js) — `matchNotes`, `checkMisses`, `_diagTimingErrors` / `_diagTimingErrorsHits`, `getDiagnostic`.
- Routes: [`routes.py`](https://github.com/got-feedback/feedBack-plugin-notedetect/blob/main/routes.py) — the `/api/plugins/note_detect/recording` and `/api/plugins/note_detect/live-judgment` endpoints.
- Harness: [`tools/harness.js`](https://github.com/got-feedback/feedBack-plugin-notedetect/blob/main/tools/harness.js).
- Regression driver: [`tools/regression.js`](https://github.com/got-feedback/feedBack-plugin-notedetect/blob/main/tools/regression.js).
- Benchmark builder: [docs/benchmarks/note_detect_v1/build_benchmark.py](benchmarks/note_detect_v1/build_benchmark.py).
- Settings UI: [`settings.html`](https://github.com/got-feedback/feedBack-plugin-notedetect/blob/main/settings.html) — A/V auto-calibrate panel, tuning-mode toggle, diagnostic block.
