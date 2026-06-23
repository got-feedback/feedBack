"""Builds the Note Detect Benchmark sloppak (v1).

A reproducible, distributable test piece for the note_detect plugin: 8
short exercises designed to isolate specific failure modes (open-string
mono, fretted positions, octaves, sustained held notes, hammer-on /
pull-off, sparse power chords, dense open chords, bends).

How to run inside the feedBack container (recommended — has ffmpeg +
pyyaml already):

    docker cp docs/benchmarks/note_detect_v1/build_benchmark.py \
              feedBack-web-1:/tmp/build_benchmark.py
    docker exec feedBack-web-1 python /tmp/build_benchmark.py \
              /app/static/sloppak_cache/note_detect_benchmark_v1.sloppak

The output sloppak lands under `static/sloppak_cache/` on the host
(bind-mounted into the container). Copy / zip it from there.
"""

import json
import math
import shutil
import struct
import subprocess
import sys
import wave
from pathlib import Path

import yaml  # bundled with the feedBack image

# ── Benchmark parameters ────────────────────────────────────────────────
BPM = 90.0
SECONDS_PER_BEAT = 60.0 / BPM           # 0.6667
BEATS_PER_BAR = 4
BAR_S = BEATS_PER_BAR * SECONDS_PER_BEAT  # 2.667
INTRO_BARS = 2                          # silence before the first event
OUTRO_BARS = 2                          # tail after the last
EXERCISE_BARS = 6                       # length of each exercise

# Standard E-tuning open MIDI per string, low → high (matches lib/tunings
# convention used by note_detect when arrangement is 'guitar').
OPEN_MIDI = [40, 45, 50, 55, 59, 64]  # E2 A2 D3 G3 B3 E4

SR = 44100  # sample rate for the click WAV


# ── Click-track audio generator ────────────────────────────────────────
def _sine_burst(freq_hz, duration_s, amplitude):
    """Short sine burst with a linear attack/release envelope so the
    click reads as a tick, not a pop."""
    n = int(SR * duration_s)
    out = []
    fade = max(1, int(0.004 * SR))      # 4 ms fade in + out
    for i in range(n):
        env = 1.0
        if i < fade:
            env = i / fade
        elif i >= n - fade:
            env = (n - 1 - i) / fade
        s = math.sin(2 * math.pi * freq_hz * (i / SR)) * amplitude * env
        out.append(s)
    return out


def write_click_wav(path: Path, total_duration_s: float):
    """A click on every beat; the downbeat (beat 0 of each bar) is louder
    and a tone higher. Steady reference for the player; the chart's
    event times sit on the same beat grid."""
    n_total = int(math.ceil(total_duration_s * SR))
    buf = [0.0] * n_total

    click_dur = 0.045
    downbeat_tone = 1500
    upbeat_tone = 1000
    downbeat_amp = 0.22
    upbeat_amp = 0.12

    beat_idx = 0
    t = 0.0
    while t < total_duration_s - click_dur:
        is_downbeat = (beat_idx % BEATS_PER_BAR) == 0
        click = _sine_burst(
            downbeat_tone if is_downbeat else upbeat_tone,
            click_dur,
            downbeat_amp if is_downbeat else upbeat_amp,
        )
        i0 = int(t * SR)
        for j, v in enumerate(click):
            if i0 + j < n_total:
                buf[i0 + j] += v
        t += SECONDS_PER_BEAT
        beat_idx += 1

    # Soft clip to keep within 16-bit headroom even if a future tweak
    # piles bursts up.
    pcm = bytearray()
    for v in buf:
        s = max(-1.0, min(1.0, v))
        pcm.extend(struct.pack('<h', int(s * 32700)))

    path.parent.mkdir(parents=True, exist_ok=True)
    with wave.open(str(path), 'wb') as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(SR)
        w.writeframes(bytes(pcm))


# ── Chart helpers ─────────────────────────────────────────────────────
def note(t, s, f, sus=0.0, **flags):
    """Build a single-note dict in the sloppak wire format. Defaults
    match the wire-format defaults from docs/sloppak-spec.md §3.2."""
    return {
        't': round(t, 3),
        's': s,
        'f': f,
        'sus': round(sus, 3),
        'sl': flags.get('sl', -1),
        'slu': flags.get('slu', -1),
        'bn': flags.get('bn', 0.0),
        'ho': flags.get('ho', False),
        'po': flags.get('po', False),
        'hm': flags.get('hm', False),
        'hp': flags.get('hp', False),
        'pm': flags.get('pm', False),
        'mt': flags.get('mt', False),
        'vb': flags.get('vb', False),
        'tr': flags.get('tr', False),
        'ac': flags.get('ac', False),
        'tp': flags.get('tp', False),
    }


def chord(t, id_, notes):
    return {
        't': round(t, 3),
        'id': id_,
        'hd': False,
        'notes': notes,
    }


def chord_note(s, f, sus=0.0, **flags):
    n = note(0.0, s, f, sus, **flags)
    n.pop('t')   # chord notes inherit the chord's time
    return n


# ── Exercises ─────────────────────────────────────────────────────────
# Each returns a 3-tuple `(notes, chords_or_with_templates, description)`.
# The middle slot is overloaded so single-note exercises don't have to
# carry a useless empty `templates` list:
#   • Single-note exercises return `(notes, [], desc)` — second slot is
#     just the (empty) chords list.
#   • Chord exercises return `(notes, (chords, templates), desc)` — the
#     driver unpacks the tuple when it sees one (see `build()`).
# Exercise start times are computed by the driver; helpers use `t0` as
# the exercise's bar-aligned start time, then place events relative to it.

def exercise_open_strings(t0):
    """Single notes — open strings, low → high → low, quarter notes."""
    seq = [0, 1, 2, 3, 4, 5, 5, 4, 3, 2, 1, 0]   # 12 notes = 3 bars at q-note
    notes = []
    for i, s in enumerate(seq):
        notes.append(note(t0 + i * SECONDS_PER_BEAT, s, 0, sus=SECONDS_PER_BEAT * 0.9))
    # Cap the last note's sustain into the trailing bar so it rings out
    notes[-1]['sus'] = round(SECONDS_PER_BEAT * 3, 3)
    return notes, [], 'Open strings (low→high→low)'


def exercise_fretted_positions(t0):
    """Each string's 5th fret, ascending then descending. Tests basic
    fretted-note detection across the range."""
    seq = [(s, 5) for s in range(6)] + [(s, 5) for s in range(5, -1, -1)]
    notes = []
    for i, (s, f) in enumerate(seq):
        notes.append(note(t0 + i * SECONDS_PER_BEAT, s, f, sus=SECONDS_PER_BEAT * 0.9))
    notes[-1]['sus'] = round(SECONDS_PER_BEAT * 3, 3)
    return notes, [], 'Fretted positions (5th fret on each string)'


def exercise_octaves(t0):
    """12th-fret octaves on each string. Tests detection at higher
    frequencies where YIN can lock onto the second harmonic."""
    notes = []
    # 6 notes, half-note each (2 beats), so the player has time to land
    # cleanly. 6 × 2 = 12 beats = 3 bars.
    for i, s in enumerate(range(6)):
        notes.append(note(t0 + i * 2 * SECONDS_PER_BEAT, s, 12,
                          sus=SECONDS_PER_BEAT * 1.6))
    notes[-1]['sus'] = round(SECONDS_PER_BEAT * 3, 3)
    return notes, [], '12th-fret octaves'


def exercise_sustained(t0):
    """Four-second sustained notes. The renderer's `active` glow
    requires the provider to keep returning state — exercises the
    on-pitch hold check (`_sustainStillHeld`)."""
    sus = 4.0
    # Three targets spread across the range (low / mid / high). Held at
    # 3 to keep the whole exercise within the section's 16 s slot —
    # 4 events with a 4-s sustain at a 5-s cadence would end at t0+19
    # and bleed 3 s into the next section's note-detect window, which
    # contaminates the bin attribution we promise section-by-section.
    targets = [(0, 5), (2, 7), (5, 5)]
    notes = []
    # One every 5 seconds (4-sec sustain + 1-sec gap). 3 events × 5 s
    # = 14 s of music, comfortably inside EXERCISE_BARS * BAR_S = 16 s.
    for i, (s, f) in enumerate(targets):
        notes.append(note(t0 + i * (sus + 1.0), s, f, sus=sus))
    return notes, [], 'Sustained notes (4 s each, on-pitch hold)'


def exercise_hammer_pull(t0):
    """Open → hammer-on → pull-off. Hammer-ons and pull-offs have no
    fresh pick attack, so transient detection is what's tested."""
    notes = []
    # Pattern per bar: D3 (s=1, f=5 — A-string fretted at 5) picked, HO
    # to f=7 (E3), PO back to f=5 (D3). HO/PO flags ride the destination
    # note, not the source — that's where the technique is performed.
    # Use 4 bars.
    for bar in range(4):
        bt = t0 + bar * BAR_S
        notes.append(note(bt + 0 * SECONDS_PER_BEAT, 1, 5, sus=0.4))       # pluck D3
        notes.append(note(bt + 1 * SECONDS_PER_BEAT, 1, 7, sus=0.4, ho=True))
        notes.append(note(bt + 2 * SECONDS_PER_BEAT, 1, 5, sus=0.4, po=True))
        # rest on beat 4
    return notes, [], 'Hammer-on / pull-off (no pick attack)'


def exercise_power_chords(t0):
    """Two-string power chords. Sparse voicing tests whether the chord
    leniency threshold is appropriate for 2-string chord events."""
    # Wire format: s=0 is the lowest-pitched string (low E on guitar),
    # s=5 the highest (high E). Two-string power-chord voicings, each
    # rooted on the lower of the two strings:
    #   E5 — low E open + A fret 2  (E2 + B2)
    #   A5 — A open      + D fret 2 (A2 + E3)
    #   D5 — D open      + G fret 2 (D3 + A3)
    #   G5 — G open      + B fret 3 (G3 + D4)
    voicings = [
        ('E5', [(0, 0), (1, 2)]),
        ('A5', [(1, 0), (2, 2)]),
        ('D5', [(2, 0), (3, 2)]),
        ('G5', [(3, 0), (4, 3)]),
    ]
    templates = []
    chords_out = []
    sus = SECONDS_PER_BEAT * 1.6
    # 8 chord events over 8 half-note slots (4 bars at half notes).
    pattern = list(range(4)) + list(range(4))   # play each voicing twice
    for slot, idx in enumerate(pattern):
        name, sf = voicings[idx]
        tmpl_id = idx
        if slot < len(voicings):   # only add each template once
            frets = [-1] * 6
            for (s, f) in sf:
                frets[s] = f
            templates.append({
                'name': name,
                'displayName': name,
                'arp': False,
                'fingers': [-1] * 6,
                'frets': frets,
            })
        chord_notes = [chord_note(s, f, sus=sus) for (s, f) in sf]
        chords_out.append(chord(t0 + slot * 2 * SECONDS_PER_BEAT, tmpl_id, chord_notes))
    return [], (chords_out, templates), 'Power chords (2-string sparse voicings)'


def exercise_open_chords(t0):
    """Open major chords. Dense voicings test whether the leniency
    threshold is too strict when the player can't reliably ring every
    string."""
    # Standard open-chord voicings, low → high string. Strings with `-1`
    # in the template's frets list aren't part of the chord.
    #   E open:  E0 A2 D2 G1 B0 e0  (all 6 strings)
    #   A open:    — A0 D2 G2 B2 e0 (skip low E)
    #   D open:    —  — D0 G2 B3 e2 (skip low E + A)
    #   G open:  E3 A2 D0 G0 B0 e3  (all 6 strings; common 6-string fingering)
    voicings = [
        ('E', [(0, 0), (1, 2), (2, 2), (3, 1), (4, 0), (5, 0)]),
        ('A', [(1, 0), (2, 2), (3, 2), (4, 2), (5, 0)]),
        ('D', [(2, 0), (3, 2), (4, 3), (5, 2)]),
        ('G', [(0, 3), (1, 2), (2, 0), (3, 0), (4, 0), (5, 3)]),
    ]
    templates = []
    chords_out = []
    sus = SECONDS_PER_BEAT * 1.6
    pattern = list(range(4)) + list(range(4))
    for slot, idx in enumerate(pattern):
        name, sf = voicings[idx]
        # Local-zero-based template id. The driver in `build()` rebases
        # these onto the global `templates_all` index before emitting
        # the arrangement, so we don't need to pre-offset here — and
        # in fact mustn't, since double-offsetting would point at
        # template ids past the end of the list.
        tmpl_id = idx
        if slot < len(voicings):
            frets = [-1] * 6
            for (s, f) in sf:
                frets[s] = f
            templates.append({
                'name': name,
                'displayName': name,
                'arp': False,
                'fingers': [-1] * 6,
                'frets': frets,
            })
        chord_notes = [chord_note(s, f, sus=sus) for (s, f) in sf]
        chords_out.append(chord(t0 + slot * 2 * SECONDS_PER_BEAT, tmpl_id, chord_notes))
    return [], (chords_out, templates), 'Open major chords (E A D G — dense)'


def exercise_bends(t0):
    """Half-step and whole-step bends. Bends shift pitch mid-note —
    tests whether the single-note pitch tolerance is wide enough."""
    notes = []
    # Whole-step bend on G string fret 7 (D4 → E4): bn=2.0 semitones.
    # Half-step bend on B string fret 8 (G4 → G#4): bn=1.0 semitone.
    pattern = [
        (3, 7, 2.0),   # whole-step on G string
        (4, 8, 1.0),   # half-step on B string
        (3, 7, 2.0),
        (4, 8, 1.0),
    ]
    for i, (s, f, bn) in enumerate(pattern):
        # 4 bends, half-note each (2 beats), 4 × 2 = 8 beats = 2 bars.
        notes.append(note(t0 + i * 2 * SECONDS_PER_BEAT, s, f,
                          sus=SECONDS_PER_BEAT * 1.6, bn=bn))
    notes[-1]['sus'] = round(SECONDS_PER_BEAT * 3, 3)
    return notes, [], 'Bends (half-step + whole-step)'


EXERCISES = [
    ('A. Open strings',     exercise_open_strings),
    ('B. 5th-fret positions', exercise_fretted_positions),
    ('C. 12th-fret octaves', exercise_octaves),
    ('D. Sustained notes',  exercise_sustained),
    ('E. Hammer / pull',    exercise_hammer_pull),
    ('F. Power chords',     exercise_power_chords),
    ('G. Open chords',      exercise_open_chords),
    ('H. Bends',            exercise_bends),
]


# ── Driver ─────────────────────────────────────────────────────────────
def build(out_dir: Path):
    notes_all = []
    chords_all = []
    templates_all = []
    sections = []
    beats = []

    t = INTRO_BARS * BAR_S
    for label, fn in EXERCISES:
        sections.append({'name': label, 'number': len(sections) + 1, 'time': round(t, 3)})
        result = fn(t)
        ns, ch_or_tuple, _desc = result
        notes_all.extend(ns)
        if isinstance(ch_or_tuple, tuple):
            cs, tmpls = ch_or_tuple
            # Rebase section-local chord template ids onto the global
            # `templates_all` list — see v2 builder for the full
            # explanation. Multiple chord exercises in this benchmark
            # (power, open) each use ids 0..N locally; without
            # offsetting, open-chord events would silently point at
            # power-chord templates.
            offset = len(templates_all)
            for c in cs:
                c['id'] = c.get('id', 0) + offset
            chords_all.extend(cs)
            templates_all.extend(tmpls)
        else:
            chords_all.extend(ch_or_tuple)
        t += EXERCISE_BARS * BAR_S

    end_t = t + OUTRO_BARS * BAR_S

    # Beats array — one entry per beat, measure markers on downbeats.
    bar_count = 0
    bt = 0.0
    while bt < end_t:
        is_downbeat = abs(bt % BAR_S) < 1e-3
        if is_downbeat:
            bar_count += 1
            beats.append({'time': round(bt, 3), 'measure': bar_count})
        else:
            beats.append({'time': round(bt, 3), 'measure': -1})
        bt += SECONDS_PER_BEAT

    # Anchors — keep the highway zoom wide enough for everything on
    # screen. One anchor at start, then per-exercise re-anchors so the
    # camera doesn't drift to the wrong neighbourhood between sections.
    anchors = [{'time': 0.0, 'fret': 1, 'width': 12}]
    for sec in sections:
        anchors.append({'time': sec['time'], 'fret': 1, 'width': 12})

    arrangement = {
        'name': 'Lead',
        'tuning': [0, 0, 0, 0, 0, 0],
        'capo': 0,
        'notes': sorted(notes_all, key=lambda n: n['t']),
        'chords': sorted(chords_all, key=lambda c: c['t']),
        'anchors': anchors,
        'handshapes': [],
        'templates': templates_all,
        'beats': beats,
        'sections': sections,
    }

    manifest = {
        'title': 'Note Detect Benchmark v1',
        'artist': 'FeedBack',
        'album': 'Note Detection Benchmark',
        'year': 2026,
        'duration': round(end_t, 3),
        'arrangements': [
            {
                'id': 'lead',
                'name': 'Lead',
                'file': 'arrangements/lead.json',
                'tuning': [0, 0, 0, 0, 0, 0],
                'capo': 0,
            },
        ],
        'stems': [
            {'id': 'full', 'file': 'stems/full.ogg', 'default': True},
        ],
        # Non-standard key — picked up by future tooling that wants to
        # detect "this is the benchmark, schema v1". The loader ignores it.
        'benchmark': {
            'id': 'feedBack-note-detect-benchmark',
            'version': 1,
        },
    }

    # ── Write files ──
    out_dir = Path(out_dir)
    if out_dir.exists():
        # Defensive: only blow away a directory that LOOKS like a
        # sloppak (has a manifest.yaml at its root, or matches the
        # `.sloppak` suffix this builder generates). A user who
        # passes e.g. `python build_benchmark.py /tmp` by accident
        # otherwise loses `/tmp` to a recursive delete.
        if not (out_dir.suffix == '.sloppak'
                or (out_dir / 'manifest.yaml').exists()):
            raise RuntimeError(
                f"refusing to rmtree {out_dir!r}: does not look like a sloppak "
                f"(no .sloppak suffix, no manifest.yaml). Pass a path ending in "
                f".sloppak or pointing at an existing sloppak directory."
            )
        shutil.rmtree(out_dir)
    out_dir.mkdir(parents=True)
    (out_dir / 'arrangements').mkdir()
    (out_dir / 'stems').mkdir()

    (out_dir / 'manifest.yaml').write_text(
        yaml.safe_dump(manifest, sort_keys=False, allow_unicode=True),
        encoding='utf-8',
    )
    (out_dir / 'arrangements' / 'lead.json').write_text(
        json.dumps(arrangement, separators=(',', ':')),
        encoding='utf-8',
    )

    # Click track. Write WAV first, then transcode to OGG via ffmpeg —
    # the loader expects `stems/full.ogg`.
    wav_path = out_dir / 'stems' / 'full.wav'
    write_click_wav(wav_path, end_t)
    ogg_path = out_dir / 'stems' / 'full.ogg'
    subprocess.run(
        ['ffmpeg', '-y', '-loglevel', 'error',
         '-i', str(wav_path),
         '-c:a', 'libvorbis', '-q:a', '5',
         str(ogg_path)],
        check=True,
    )
    wav_path.unlink()    # ogg is canonical; wav was scaffolding

    # Distribution README — ships inside the sloppak so other devs can
    # follow the exercises without external docs. The loader ignores
    # files it doesn't know about, so this travels with the package.
    (out_dir / 'BENCHMARK.md').write_text(_benchmark_readme(end_t), encoding='utf-8')

    # Zip-archive distribution form alongside the directory. Built with
    # the stdlib zipfile module so paths use forward slashes regardless
    # of the host OS — PowerShell's Compress-Archive on Windows produces
    # backslash paths inside the zip, which the loader (running on
    # Linux) then reads as literal filenames instead of directory
    # separators and quietly drops every arrangement.
    _build_zip(out_dir)

    print(f'Built {out_dir}')
    print(f'        {out_dir}.zip')
    print(f'  Duration: {end_t:.1f} s')
    print(f'  Notes:    {len(arrangement["notes"])}')
    print(f'  Chords:   {len(arrangement["chords"])}')
    print(f'  Templates:{len(arrangement["templates"])}')


def _build_zip(src_dir: Path):
    """Pack `src_dir` into `<src_dir>.zip` with forward-slash paths.

    Zip-level reproducibility: every entry uses a fixed `date_time` (the
    zip spec's earliest legal value, 1980-01-01 00:00:00), a fixed
    `external_attr` (rw-r--r--), and an explicit `ZipInfo` so the
    archive metadata depends only on contents, not on when the build
    ran. JSON / YAML / MD entries are byte-identical across rebuilds.

    Caveat: the bundled `stems/full.ogg` is still non-deterministic
    across rebuilds because libvorbis writes a random bitstream serial
    number to every Ogg page (~1% of the file's bytes are container
    framing, not audio). The audio PCM that the detector listens to is
    deterministic; only the container headers differ. So a diff of the
    tracked sloppak will always show OGG churn after `_build_zip`, but
    the chart, manifest, and audible signal are stable. If a future PR
    needs full byte-stability, it can either cache a hand-built OGG or
    switch the stem to FLAC.
    """
    import zipfile
    zip_path = src_dir.with_suffix(src_dir.suffix + '.zip')
    if zip_path.exists():
        zip_path.unlink()
    with zipfile.ZipFile(zip_path, 'w', compression=zipfile.ZIP_DEFLATED) as zf:
        for p in sorted(src_dir.rglob('*')):
            if p.is_file():
                # Force POSIX-style arcname so a Windows build still
                # emits a Linux-loadable archive.
                rel = p.relative_to(src_dir).as_posix()
                info = zipfile.ZipInfo(filename=rel, date_time=(1980, 1, 1, 0, 0, 0))
                info.compress_type = zipfile.ZIP_DEFLATED
                # rw-r--r-- in the upper 16 bits where ZIP stores
                # external attrs on POSIX. Avoids "executable" / weird
                # permission bits leaking from the host filesystem.
                info.external_attr = (0o644 & 0xFFFF) << 16
                # Force POSIX (3) for the create-system byte so the
                # zip's central-directory metadata doesn't drift when
                # the same builder runs on Windows vs Linux. Python's
                # default is host-dependent (3 on POSIX, 0 on Windows)
                # and was the last source of zip-level non-determinism
                # after the date_time + external_attr fixes.
                info.create_system = 3
                zf.writestr(info, p.read_bytes())


def _benchmark_readme(duration_s):
    return f"""# FeedBack Note Detect Benchmark — v1

A short test piece for tuning FeedBack's `note_detect` plugin. Eight
exercises, each isolating a specific detection failure mode. Run with
**Detect** enabled, play through, then export the diagnostic JSON
(Settings → Plugins → Note Detection → Download Diagnostic JSON, or
the button on the end-of-session summary modal).

- **Tempo**: {BPM:g} BPM
- **Tuning**: E standard (no capo)
- **Audio**: metronome click track only (downbeat = louder + higher
  tone). Play *over* the click — `note_detect` listens to your guitar
  signal, not the audio in this file.
- **Duration**: {duration_s:.0f} s

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
- `benchmark_hint`: `{{title, artist, arrangement}}` — filter on these
  to bucket reports from different runs of this benchmark.

## Source

Built by `docs/benchmarks/note_detect_v1/build_benchmark.py` in the
feedBack repo. Tweak the exercise list there and regenerate.
"""


if __name__ == '__main__':
    if len(sys.argv) != 2:
        print('usage: build_benchmark.py <output-sloppak-dir>', file=sys.stderr)
        sys.exit(2)
    build(Path(sys.argv[1]))
