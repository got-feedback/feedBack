"""Builds the Note Detect Benchmark sloppak (v2).

A relaxed-pace test piece tuned for the player's strengths: half-note
spacing throughout, no hammer-on / pull-off section, no bend section,
no fast staccato. Adds explicit strumming sections (single chord
repeated at half-note cadence) so the chord scorer is exercised
across a sequence of strums on the same voicing — closer to how
chords actually appear in real songs than v1's single-stroke
voicings.

Goals vs v1:
- More breathing room between every event (half-notes, ~1.33 s at
  90 BPM, instead of v1's quarter notes at ~0.667 s).
- More chord events overall, with strumming patterns.
- Drop the technique sections (HO/PO/bends) — the detector's
  technique handling is the next algorithm focus, separate from
  measuring "do basic single notes + chords score correctly?"

How to run inside the feedBack container:

    docker cp docs/benchmarks/note_detect_v2/build_benchmark.py \\
              feedBack-web-1:/tmp/build_benchmark_v2.py
    docker exec feedBack-web-1 python /tmp/build_benchmark_v2.py \\
              /app/static/sloppak_cache/note_detect_benchmark_v2.sloppak

After regenerating, copy the zip output to the tracked path with the
`.sloppak` (not `.sloppak.zip`) suffix — same gotcha as v1:

    cp static/sloppak_cache/note_detect_benchmark_v2.sloppak.zip \\
       docs/benchmarks/note_detect_v2/note_detect_benchmark_v2.sloppak
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
EXERCISE_BARS = 8     # v2 uses 8-bar sections (was 6 in v1) for extra breathing room.

# Standard E-tuning open MIDI per string, low → high.
OPEN_MIDI = [40, 45, 50, 55, 59, 64]  # E2 A2 D3 G3 B3 E4

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
    """Per-beat click track. Downbeats louder + higher pitch."""
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
# v2 single-note exercises: HALF-NOTE pacing (2 beats / 1.33 s between
# events). That's roughly half the density of v1's quarter-note pacing,
# giving the player time to mute, reset, and re-pluck cleanly.
#
# v2 chord exercises: each chord voicing is STRUMMED multiple times at
# the same half-note cadence. Two reasons:
#   1. Real songs strum chords; single-stroke voicings are an
#      artificial test that doesn't exercise the chord scorer's
#      consistency across repeated strikes.
#   2. Multiple strums per voicing give the user a forgiving runway —
#      if they nail 3 of 4 strums of an E5 power chord, that's still
#      mostly hits.

def exercise_open_strings_slow(t0):
    """Open strings, half-note pacing, low → high → low. Wide spacing
    lets each string ring out before the next is plucked, so the
    detector has clean steady-state pitch to lock onto."""
    seq = [0, 1, 2, 3, 4, 5, 5, 4, 3, 2, 1, 0]   # 12 strings, half-notes = 24 beats = 6 bars
    notes_out = []
    for i, s in enumerate(seq):
        notes_out.append(note(t0 + i * 2 * SECONDS_PER_BEAT, s, 0,
                              sus=SECONDS_PER_BEAT * 1.6))
    # Final note rings into the 2-bar tail of the section.
    notes_out[-1]['sus'] = round(SECONDS_PER_BEAT * 4, 3)
    return notes_out, [], 'Open strings (slow walk)'


def exercise_fretted_positions_slow(t0):
    """5th-fret on each string, half-note pacing, ascending. One
    direction (no descent) so total runtime fits comfortably in 8 bars
    with plenty of tail room."""
    seq = [(s, 5) for s in range(6)]  # 6 notes × 2 beats = 12 beats = 3 bars
    notes_out = []
    for i, (s, f) in enumerate(seq):
        notes_out.append(note(t0 + i * 2 * SECONDS_PER_BEAT, s, f,
                              sus=SECONDS_PER_BEAT * 1.6))
    notes_out[-1]['sus'] = round(SECONDS_PER_BEAT * 4, 3)
    return notes_out, [], 'Fretted positions (slow walk, 5th fret)'


def exercise_sustained(t0):
    """Three 4-second sustained notes (low E, D, high E — spread across
    the range). 4 s ring + 1 s gap = 5 s per event × 3 events = 15 s,
    comfortably inside an 8-bar (≈ 21.3 s) section."""
    sus = 4.0
    targets = [(0, 5), (2, 7), (5, 5)]
    notes_out = []
    for i, (s, f) in enumerate(targets):
        notes_out.append(note(t0 + i * (sus + 1.0), s, f, sus=sus))
    return notes_out, [], 'Sustained notes (3 holds, 4 s each)'


def exercise_e5_strum(t0):
    """E5 power chord strummed at half-note cadence. 8 strums × 2
    beats = 16 beats = 4 bars of strumming, plus 4 bars of tail."""
    voicing = [(0, 0), (1, 2)]  # low E open + A fret 2 = E5
    strums = 8
    chords_out = []
    sus = SECONDS_PER_BEAT * 1.6  # ring through the next strum, not past it
    template = {
        'name': 'E5', 'displayName': 'E5', 'arp': False,
        'fingers': [-1] * 6,
        'frets': [0 if s == 0 else (2 if s == 1 else -1) for s in range(6)],
    }
    for i in range(strums):
        chord_notes = [chord_note(s, f, sus=sus) for (s, f) in voicing]
        chords_out.append(chord(t0 + i * 2 * SECONDS_PER_BEAT, 0, chord_notes))
    return [], (chords_out, [template]), 'E5 power chord — slow strum (8×)'


def exercise_a5_e5_alternating(t0):
    """A5 / E5 alternating, half-note strums. 8 strums total (4 of
    each), gives a "1 5 1 5" feel that's the simplest chord progression
    a player can land — minimal hand movement between voicings."""
    voicings = [
        ('A5', [(1, 0), (2, 2)]),  # A open + D fret 2 = A5
        ('E5', [(0, 0), (1, 2)]),  # E open + A fret 2 = E5
    ]
    templates = []
    for i, (name, sf) in enumerate(voicings):
        frets = [-1] * 6
        for (s, f) in sf:
            frets[s] = f
        templates.append({
            'name': name, 'displayName': name, 'arp': False,
            'fingers': [-1] * 6, 'frets': frets,
        })
    chords_out = []
    sus = SECONDS_PER_BEAT * 1.6
    strums = 8
    for i in range(strums):
        idx = i % 2  # alternate A5 / E5
        _, sf = voicings[idx]
        chord_notes = [chord_note(s, f, sus=sus) for (s, f) in sf]
        chords_out.append(chord(t0 + i * 2 * SECONDS_PER_BEAT, idx, chord_notes))
    return [], (chords_out, templates), 'A5 / E5 alternating strums (8×)'


def exercise_e_open_strum(t0):
    """E major open chord, half-note strums. All 6 strings ringing —
    the densest voicing in the benchmark, tests the chord scorer's
    per-string differentiation on the full set."""
    voicing = [(0, 0), (1, 2), (2, 2), (3, 1), (4, 0), (5, 0)]
    strums = 8
    chords_out = []
    sus = SECONDS_PER_BEAT * 1.6
    template = {
        'name': 'E', 'displayName': 'E', 'arp': False,
        'fingers': [-1] * 6,
        'frets': [0, 2, 2, 1, 0, 0],
    }
    for i in range(strums):
        chord_notes = [chord_note(s, f, sus=sus) for (s, f) in voicing]
        chords_out.append(chord(t0 + i * 2 * SECONDS_PER_BEAT, 0, chord_notes))
    return [], (chords_out, [template]), 'E major open chord — slow strum (8×)'


def exercise_a_open_strum(t0):
    """A major open chord, half-note strums. 5 strings (skips low E).
    Slightly easier than E for the player (less stretch) and tests
    the scorer's behaviour on a missing-low-string voicing."""
    voicing = [(1, 0), (2, 2), (3, 2), (4, 2), (5, 0)]
    strums = 8
    chords_out = []
    sus = SECONDS_PER_BEAT * 1.6
    template = {
        'name': 'A', 'displayName': 'A', 'arp': False,
        'fingers': [-1] * 6,
        'frets': [-1, 0, 2, 2, 2, 0],
    }
    for i in range(strums):
        chord_notes = [chord_note(s, f, sus=sus) for (s, f) in voicing]
        chords_out.append(chord(t0 + i * 2 * SECONDS_PER_BEAT, 0, chord_notes))
    return [], (chords_out, [template]), 'A major open chord — slow strum (8×)'


def exercise_d_open_strum(t0):
    """D major open chord, half-note strums. 4 strings (skips low E
    and A). Tests the chord scorer on partial voicings — common in
    real songs and an easy stretch for new players."""
    voicing = [(2, 0), (3, 2), (4, 3), (5, 2)]
    strums = 8
    chords_out = []
    sus = SECONDS_PER_BEAT * 1.6
    template = {
        'name': 'D', 'displayName': 'D', 'arp': False,
        'fingers': [-1] * 6,
        'frets': [-1, -1, 0, 2, 3, 2],
    }
    for i in range(strums):
        chord_notes = [chord_note(s, f, sus=sus) for (s, f) in voicing]
        chords_out.append(chord(t0 + i * 2 * SECONDS_PER_BEAT, 0, chord_notes))
    return [], (chords_out, [template]), 'D major open chord — slow strum (8×)'


EXERCISES = [
    ('A. Open strings (slow)',     exercise_open_strings_slow),
    ('B. 5th-fret (slow)',         exercise_fretted_positions_slow),
    ('C. Sustained notes',         exercise_sustained),
    ('D. E5 power chord strum',    exercise_e5_strum),
    ('E. A5 / E5 alternating',     exercise_a5_e5_alternating),
    ('F. E major strum',           exercise_e_open_strum),
    ('G. A major strum',           exercise_a_open_strum),
    ('H. D major strum',           exercise_d_open_strum),
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
            # `templates_all` list. Each exercise emits its chords
            # with `tmpl_id` numbered from 0 within the exercise; if
            # we naively appended both chords and templates without
            # offsetting, later sections' chords would silently
            # reference earlier sections' templates (e.g. an open
            # chord pointing at a power-chord shape). Apply the
            # offset to each chord's `id` field before extending the
            # global lists.
            offset = len(templates_all)
            for c in cs:
                c['id'] = c.get('id', 0) + offset
            chords_all.extend(cs)
            templates_all.extend(tmpls)
        else:
            chords_all.extend(ch_or_tuple)
        t += EXERCISE_BARS * BAR_S

    end_t = t + OUTRO_BARS * BAR_S

    # Beats — measure markers on downbeats.
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

    # Anchors — re-anchor on each section so the camera doesn't drift.
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
        'title': 'Note Detect Benchmark v2',
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
        'benchmark': {
            'id': 'feedBack-note-detect-benchmark',
            'version': 2,
        },
    }

    # ── Write files ──
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
    (out_dir / 'arrangements' / 'lead.json').write_text(
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
    See v1 builder docstring for full caveats (OGG framing has its own
    non-determinism we don't try to fix here)."""
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
    return f"""# FeedBack Note Detect Benchmark — v2

A slower-paced companion to v1, focused on what players can actually
land cleanly. Half-note spacing throughout (~1.33 s between events at
90 BPM), with multiple **strumming** sections — single chord voicings
repeated at half-note cadence — to exercise the chord scorer's
consistency across a sequence of strikes.

- **Tempo**: {BPM:g} BPM
- **Tuning**: E standard (no capo)
- **Audio**: metronome click track only — play *over* the click.
- **Duration**: {duration_s:.0f} s

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
"""


# ── CLI ───────────────────────────────────────────────────────────────
if __name__ == '__main__':
    out = Path(sys.argv[1]) if len(sys.argv) > 1 else Path('./note_detect_benchmark_v2.sloppak')
    build(out)
