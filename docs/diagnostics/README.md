# FeedBack diagnostic sloppaks

Generated, non-copyrighted mini-songs for technique-assessment style
checks. Report-only — they do not change gameplay settings or detection
thresholds.

## Basic Guitar (POC)

**Artifact:** `feedBack-diagnostic-basic-guitar.sloppak`

**Contents (~55 s):**

- 3 s count-in (quiet click)
- Open thickest string, open next string
- Thickest string, 5th fret
- Repeated E5 power chords (thickest open + next string fret 2)
- Repeat pass: open, fretted, power chords again

Sections: Intro, Open Strings, Fretted Note, Power Chords, Repeat Check.

Manifest includes a custom `diagnostic:` tag (ignored by the loader today;
for future Technique Assessment integration).

## Rebuild

From the feedBack repo root (requires `ffmpeg`; the feedBack Docker image
has `libvorbis`, Homebrew ffmpeg may use the built-in `vorbis` encoder):

```bash
python3 docs/diagnostics/build_diagnostic_basic_guitar.py
```

## Builtin seeding

On library scan startup (and periodic rescans), the server copies bundled
diagnostic sloppaks into the user DLC folder when missing or when the
bundled source is newer:

`DLC_DIR/diagnostics-builtin/feedBack-diagnostic-basic-guitar.sloppak`

Source: `docs/diagnostics/feedBack-diagnostic-basic-guitar.sloppak` (next to
`server.py` in dev; must be included in the desktop bundle — see
`feedBack-desktop/scripts/bundle-feedBack.sh`).

Unlike `tutorials-builtin/`, `diagnostics-builtin/` **is** included in the
library scan. Tracks appear under **FeedBack** /
**Technique Assessment Diagnostics**.

Existing destination files are not overwritten unless the bundled source
has a newer modification time. User files elsewhere (e.g. `diagnostics-test/`)
are never touched.

## Manual install / test

Normally seeding is automatic once a DLC folder is configured. To test a
custom copy or an unreleased build:

1. Copy `feedBack-diagnostic-basic-guitar.sloppak` into your FeedBack
   DLC folder (e.g. `diagnostics-test/` or any scanned path).
2. Restart FeedBack or trigger a library rescan if the song does not appear.
3. Load **FeedBack Diagnostic — Basic Guitar**.
4. Play the **Diagnostic Guitar** arrangement.
5. Confirm the 3D highway shows open notes and power-chord gems.
6. Turn **Detect** on — note_detect should push the chart to the desktop
   verifier on `song:ready` like any other sloppak.

## Future

- Bass diagnostic sloppak
- 7/8-string guitar variants
- Drums (`drum_tab.json`)
- Piano/keys (separate wire model)
- Detection Health “Run Basic Guitar Diagnostic” launch button (note_detect)
