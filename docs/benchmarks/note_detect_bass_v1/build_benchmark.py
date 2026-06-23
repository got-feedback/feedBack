"""Builds the Note Detect Bass Benchmark sloppak (v1).

A bass-focused companion to the guitar benchmarks (note_detect_v1 +
note_detect_v2). Same 90 BPM click, similar half-note pacing as v2,
but the sections are built around what bass actually plays: single-
note lines, octave jumps, walking patterns, sustained roots, and
two-string double-stops (the closest bass gets to "chords").

Why a separate bass benchmark instead of toggling string count on
the guitar one:

- Tuning is different — 4-string bass open MIDI is [28, 33, 38, 43]
  (E1, A1, D2, G2) vs the guitar's [40, 45, 50, 55, 59, 64]. The
  benchmark needs to produce notes the player can actually play on
  the instrument they have plugged in.
- Bass idioms are different from guitar idioms. Strumming sections
  don't apply; walking bass + octave patterns do.
- Low-frequency detection is materially harder for YIN — E1 at
  ~41 Hz needs more accumulated samples for confident detection
  than guitar E2 at ~82 Hz. The benchmark should exercise that
  regime explicitly so we can spot regressions there.

How to run inside the feedBack container:

    docker cp docs/benchmarks/note_detect_bass_v1/build_benchmark.py \\
              feedBack-web-1:/tmp/build_benchmark_bass.py
    docker exec feedBack-web-1 python /tmp/build_benchmark_bass.py \\
              /app/static/sloppak_cache/note_detect_benchmark_bass_v1.sloppak

After regenerating, copy the zip output to the tracked path with the
`.sloppak` (not `.sloppak.zip`) suffix.
"""

import json
import math
import shutil
import struct
import subprocess
import sys
import wave
from pathlib import Path

import yaml

# ── Benchmark parameters ────────────────────────────────────────────────
BPM = 90.0
SECONDS_PER_BEAT = 60.0 / BPM
BEATS_PER_BAR = 4
BAR_S = BEATS_PER_BAR * SECONDS_PER_BEAT
INTRO_BARS = 2
OUTRO_BARS = 2
EXERCISE_BARS = 8

# 4-string bass open MIDI per string, low → high.
# Matches lib/tunings convention used by note_detect when the
# arrangement is 'bass' and stringCount is 4.
OPEN_MIDI = [28, 33, 38, 43]  # E1 A1 D2 G2
N_STRINGS = 4

SR = 44100


# ── Click-track audio generator ────────────────────────────────────────
def _sine_burst(freq_hz, duration_s, amplitude):
    n = int(SR * duration_s)
    out = []
    fade = max(1, int(0.004 * SR))
    for i in range(n):
        env = 1.0
        if i < fade:
            env = i / fade
        elif i >= n - fade:
            env = (n - 1 - i) / fade
        s = math.sin(2 * math.pi * freq_hz * (i / SR)) * amplitude * env
        out.append(max(-1.0, min(1.0, s)))
    return out


def write_click_wav(path: Path, duration_s: float):
    total_samples = int(SR * duration_s)
    pcm = [0] * total_samples
    beat = 0
    t = 0.0
    while t < duration_s:
        is_downbeat = (beat % BEATS_PER_BAR == 0)
        freq = 1200 if is_downbeat else 800
        amp = 0.6 if is_downbeat else 0.35
        burst = _sine_burst(freq, 0.040, amp)
        start = int(t * SR)
        for i, s in enumerate(burst):
            j = start + i
            if 0 <= j < total_samples:
                pcm[j] = int(max(-1.0, min(1.0, pcm[j] / 32767 + s)) * 32767)
        t += SECONDS_PER_BEAT
        beat += 1

    pcm = [struct.pack('<h', v) for v in pcm]

    path.parent.mkdir(parents=True, exist_ok=True)
    with wave.open(str(path), 'wb') as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(SR)
        w.writeframes(bytes(b''.join(pcm)))


# ── Chart helpers ─────────────────────────────────────────────────────
def note(t, s, f, sus=0.0, **flags):
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
    n.pop('t')
    return n


# ── Exercises ─────────────────────────────────────────────────────────
# Bass idioms: single notes dominate, occasional double-stops (root +
# fifth on adjacent higher string two frets up, or root + octave two
# strings + two frets up), long sustains. Half-note pacing throughout
# for the same "give the player time to land cleanly" reasoning as
# guitar v2.

def exercise_open_strings_slow(t0):
    """All 4 open strings, low → high → low. Tests the lowest end of
    YIN's range (E1 = 41 Hz) where the under-buffering threshold
    kicks in."""
    seq = [0, 1, 2, 3, 3, 2, 1, 0]
    notes_out = []
    for i, s in enumerate(seq):
        notes_out.append(note(t0 + i * 2 * SECONDS_PER_BEAT, s, 0,
                              sus=SECONDS_PER_BEAT * 1.6))
    notes_out[-1]['sus'] = round(SECONDS_PER_BEAT * 4, 3)
    return notes_out, [], 'Open strings (slow walk)'


def exercise_fretted_5th_slow(t0):
    """5th fret on each string, ascending. Maps to A1 / D2 / G2 / C3
    — comfortable register for hand position, no stretch."""
    seq = [(s, 5) for s in range(N_STRINGS)]
    notes_out = []
    for i, (s, f) in enumerate(seq):
        notes_out.append(note(t0 + i * 2 * SECONDS_PER_BEAT, s, f,
                              sus=SECONDS_PER_BEAT * 1.6))
    notes_out[-1]['sus'] = round(SECONDS_PER_BEAT * 4, 3)
    return notes_out, [], 'Fretted positions (5th fret, slow walk)'


def exercise_sustained(t0):
    """Three 4-second sustained roots across the range. Tests the
    `_sustainStillHeld` active-glow path on bass tonalities."""
    sus = 4.0
    targets = [(0, 5), (1, 7), (2, 5)]   # A1, E2, G2 — spread across mid-range
    notes_out = []
    for i, (s, f) in enumerate(targets):
        notes_out.append(note(t0 + i * (sus + 1.0), s, f, sus=sus))
    return notes_out, [], 'Sustained notes (3 holds, 4 s each)'


def exercise_octave_walk(t0):
    """Octave jumps — common bass pattern (root note + octave on the
    string two above). Pairs: (0,0)↔(2,2) = E1↔E2 octave. Plays root,
    octave, root, octave at half-note pacing."""
    pairs = [
        (0, 0, 2, 2),    # E1 ↔ E2
        (1, 0, 3, 2),    # A1 ↔ A2
    ]
    notes_out = []
    t = 0.0
    for (sa, fa, sb, fb) in pairs:
        notes_out.append(note(t0 + t, sa, fa, sus=SECONDS_PER_BEAT * 1.6))
        t += 2 * SECONDS_PER_BEAT
        notes_out.append(note(t0 + t, sb, fb, sus=SECONDS_PER_BEAT * 1.6))
        t += 2 * SECONDS_PER_BEAT
        notes_out.append(note(t0 + t, sa, fa, sus=SECONDS_PER_BEAT * 1.6))
        t += 2 * SECONDS_PER_BEAT
        notes_out.append(note(t0 + t, sb, fb, sus=SECONDS_PER_BEAT * 1.6))
        t += 2 * SECONDS_PER_BEAT
    notes_out[-1]['sus'] = round(SECONDS_PER_BEAT * 2, 3)
    return notes_out, [], 'Octave walks (root ↔ octave)'


def exercise_walking_line(t0):
    """Walking bassline — root, third, fifth, sixth ascending, then
    descending. Classic 4-bar walking pattern in A minor pentatonic
    starting on A string open. Tests detection across a fretted run."""
    # A1, C2, D2, E2 (ascend), E2, D2, C2, A1 (descend)
    pattern = [
        (1, 0),  # A1
        (1, 3),  # C2
        (1, 5),  # D2
        (1, 7),  # E2
        (1, 7),  # E2
        (1, 5),  # D2
        (1, 3),  # C2
        (1, 0),  # A1
    ]
    notes_out = []
    for i, (s, f) in enumerate(pattern):
        notes_out.append(note(t0 + i * 2 * SECONDS_PER_BEAT, s, f,
                              sus=SECONDS_PER_BEAT * 1.6))
    notes_out[-1]['sus'] = round(SECONDS_PER_BEAT * 4, 3)
    return notes_out, [], 'Walking bassline (A minor pentatonic)'


def exercise_root_fifth_pattern(t0):
    """Root + fifth alternation — single most common bass pattern in
    rock / country. Plays (root, fifth, root, fifth) on each of two
    voicings. The fifth sits on the next-higher string, 2 frets up
    from the root — a one-finger reach with no string skip."""
    # Root on (0, 0) = E1, fifth = (1, 2) = B1 (A string fret 2)
    # Then root on (1, 0) = A1, fifth = (2, 2) = E2 (D string fret 2)
    pattern = [
        (0, 0), (1, 2), (0, 0), (1, 2),
        (1, 0), (2, 2), (1, 0), (2, 2),
    ]
    notes_out = []
    for i, (s, f) in enumerate(pattern):
        notes_out.append(note(t0 + i * 2 * SECONDS_PER_BEAT, s, f,
                              sus=SECONDS_PER_BEAT * 1.6))
    notes_out[-1]['sus'] = round(SECONDS_PER_BEAT * 4, 3)
    return notes_out, [], 'Root + fifth pattern'


def exercise_double_stops(t0):
    """Two-string "chord" events — closest bass gets to chords.
    Root + fifth simultaneously on adjacent strings, repeated 8
    times at half-note pacing. Lets the chord scorer exercise the
    2-string code path with bass-range frequencies."""
    # Voicing: E1 + B1 (root + fifth on E + A strings)
    voicing = [(0, 0), (1, 2)]
    strums = 8
    chords_out = []
    sus = SECONDS_PER_BEAT * 1.6
    # Sloppak wire spec keeps chord-template fingers/frets in six-slot
    # arrays even for bass (docs/sloppak-spec.md §chord-template), so we
    # pad the unused two slots with -1; the chord notes themselves stay
    # on strings 0–1.
    template = {
        'name': 'E5 (bass)', 'displayName': 'E5', 'arp': False,
        'fingers': [-1, -1, -1, -1, -1, -1],
        'frets':   [ 0,  2, -1, -1, -1, -1],
    }
    for i in range(strums):
        chord_notes = [chord_note(s, f, sus=sus) for (s, f) in voicing]
        chords_out.append(chord(t0 + i * 2 * SECONDS_PER_BEAT, 0, chord_notes))
    return [], (chords_out, [template]), 'Double-stops (root + fifth, 8 strums)'


def exercise_low_e_long_holds(t0):
    """Three long-held low E (open string, lowest note on the
    instrument). Specifically targets YIN's under-buffering regime
    — E1 at 41 Hz needs roughly 4096 samples for a confident lock
    at 44.1 kHz, so the detector should spend ~95 ms accumulating
    before it can report. Holds of 5 s each give the scorer huge
    runway; if the detector can't lock here it can't lock anywhere."""
    sus = 5.0
    notes_out = []
    for i in range(3):
        notes_out.append(note(t0 + i * (sus + 0.5), 0, 0, sus=sus))
    return notes_out, [], 'Long low-E holds (5 s each)'


EXERCISES = [
    ('A. Open strings (slow)',     exercise_open_strings_slow),
    ('B. 5th-fret (slow)',         exercise_fretted_5th_slow),
    ('C. Sustained notes',         exercise_sustained),
    ('D. Octave walks',            exercise_octave_walk),
    ('E. Walking bassline',        exercise_walking_line),
    ('F. Root + fifth pattern',    exercise_root_fifth_pattern),
    ('G. Double-stops (root + 5)', exercise_double_stops),
    ('H. Long low-E holds',        exercise_low_e_long_holds),
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
            # Rebase section-local chord template ids — see v1/v2
            # builders for the full explanation. Bass v1 only has one
            # chord exercise today (double-stops), but applying the
            # same offset pattern future-proofs the driver against the
            # day someone adds a second chord exercise that also uses
            # local-zero-based ids.
            offset = len(templates_all)
            for c in cs:
                c['id'] = c.get('id', 0) + offset
            chords_all.extend(cs)
            templates_all.extend(tmpls)
        else:
            chords_all.extend(ch_or_tuple)
        t += EXERCISE_BARS * BAR_S

    end_t = t + OUTRO_BARS * BAR_S

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

    anchors = [{'time': 0.0, 'fret': 1, 'width': 12}]
    for sec in sections:
        anchors.append({'time': sec['time'], 'fret': 1, 'width': 12})

    arrangement = {
        'name': 'Bass',
        # Pad to 6 slots even on bass — feedBack's `tuning_name()` only
        # recognises named tunings (E Standard, Drop D, etc.) on 6-element
        # arrays, so a 4-element array shows up in the library card as the
        # raw numeric form ("0 0 0 0") instead of "E Standard". The
        # arrangement name ("Bass") + note positions still drive the
        # detector's bass-specific behaviour; this just makes the library
        # display friendly.
        'tuning': [0] * 6,
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
        'title': 'Note Detect Bass Benchmark v1',
        'artist': 'FeedBack',
        'album': 'Note Detection Benchmark',
        'year': 2026,
        'duration': round(end_t, 3),
        'arrangements': [
            {
                'id': 'bass',
                'name': 'Bass',
                'file': 'arrangements/bass.json',
                # Pad to 6 slots — see arrangement-level comment.
                'tuning': [0] * 6,
                'capo': 0,
            },
        ],
        'stems': [
            {'id': 'full', 'file': 'stems/full.ogg', 'default': True},
        ],
        'benchmark': {
            'id': 'feedBack-note-detect-benchmark-bass',
            'version': 1,
        },
    }

    out_dir = Path(out_dir)
    if out_dir.exists():
        # Defensive — see v1 builder. Only rmtree something that looks
        # like a sloppak so a typo on the CLI doesn't nuke an unrelated
        # directory.
        if not (out_dir.suffix == '.sloppak'
                or (out_dir / 'manifest.yaml').exists()):
            raise RuntimeError(
                f"refusing to rmtree {out_dir!r}: does not look like a sloppak "
                f"(no .sloppak suffix, no manifest.yaml)."
            )
        shutil.rmtree(out_dir)
    out_dir.mkdir(parents=True)
    (out_dir / 'arrangements').mkdir()
    (out_dir / 'stems').mkdir()

    (out_dir / 'manifest.yaml').write_text(
        yaml.safe_dump(manifest, sort_keys=False, allow_unicode=True),
        encoding='utf-8',
    )
    (out_dir / 'arrangements' / 'bass.json').write_text(
        json.dumps(arrangement, separators=(',', ':')),
        encoding='utf-8',
    )

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
    wav_path.unlink()

    (out_dir / 'BENCHMARK.md').write_text(_benchmark_readme(end_t), encoding='utf-8')
    _build_zip(out_dir)

    print(f'Built {out_dir}')
    print(f'        {out_dir}.zip')
    print(f'  Duration: {end_t:.1f} s')
    print(f'  Notes:    {len(arrangement["notes"])}')
    print(f'  Chords:   {len(arrangement["chords"])}')
    print(f'  Templates:{len(arrangement["templates"])}')


def _build_zip(src_dir: Path):
    """Pack with fixed dates / attrs for zip-metadata reproducibility.
    See v1 guitar builder docstring for full caveats."""
    import zipfile
    zip_path = src_dir.with_suffix(src_dir.suffix + '.zip')
    if zip_path.exists():
        zip_path.unlink()
    with zipfile.ZipFile(zip_path, 'w', compression=zipfile.ZIP_DEFLATED) as zf:
        for p in sorted(src_dir.rglob('*')):
            if p.is_file():
                rel = p.relative_to(src_dir).as_posix()
                info = zipfile.ZipInfo(filename=rel, date_time=(1980, 1, 1, 0, 0, 0))
                info.compress_type = zipfile.ZIP_DEFLATED
                info.external_attr = (0o644 & 0xFFFF) << 16
                info.create_system = 3   # POSIX — see v1 builder for why
                zf.writestr(info, p.read_bytes())


def _benchmark_readme(duration_s):
    return f"""# FeedBack Note Detect Bass Benchmark — v1

A bass-focused companion to the guitar benchmarks
(note_detect_v1 + note_detect_v2). Tests `note_detect` against bass-
specific idioms: walking lines, octave jumps, root+fifth patterns,
double-stops, and long low-E holds that stress YIN's accumulator at
~41 Hz.

- **Tempo**: {BPM:g} BPM
- **Tuning**: E standard 4-string (E1 A1 D2 G2, no capo)
- **Audio**: metronome click track only — play *over* the click.
- **Duration**: {duration_s:.0f} s

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
"""


if __name__ == '__main__':
    out = Path(sys.argv[1]) if len(sys.argv) > 1 else Path('./note_detect_benchmark_bass_v1.sloppak')
    build(out)
