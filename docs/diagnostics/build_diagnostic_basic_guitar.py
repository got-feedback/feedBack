"""Build the FeedBack Diagnostic — Basic Guitar sloppak (POC).

A short, generated, non-copyrighted mini-song for technique-assessment
style checks: open strings, one fretted note, and repeated E5 power chords.
Click-track backing only — no external audio.

Run from the feedBack repo root:

    python3 docs/diagnostics/build_diagnostic_basic_guitar.py

Output (zip archive):

    docs/diagnostics/feedBack-diagnostic-basic-guitar.sloppak

Pattern matches docs/benchmarks/note_detect_v1/build_benchmark.py.
"""

from __future__ import annotations

import json
import math
import shutil
import struct
import subprocess
import sys
import wave
import zipfile
from pathlib import Path

try:
    import yaml
except ImportError:
    yaml = None


def _yaml_scalar(v):
    if isinstance(v, bool):
        return 'true' if v else 'false'
    if isinstance(v, int):
        return str(v)
    if isinstance(v, float):
        return repr(v)
    if v is None:
        return 'null'
    s = str(v)
    if any(c in s for c in ':{}[]&*#?|-<>=!%@`"') or s.strip() != s:
        return json.dumps(s, ensure_ascii=False)
    return s


def _yaml_lines(obj, indent=0):
    prefix = '  ' * indent
    lines = []
    if isinstance(obj, dict):
        for k, v in obj.items():
            if isinstance(v, dict):
                lines.append(f'{prefix}{k}:')
                lines.extend(_yaml_lines(v, indent + 1))
            elif isinstance(v, list):
                if not v:
                    lines.append(f'{prefix}{k}: []')
                elif all(isinstance(x, dict) for x in v):
                    lines.append(f'{prefix}{k}:')
                    for item in v:
                        lines.append(f'{prefix}  -')
                        for ik, iv in item.items():
                            if isinstance(iv, (dict, list)):
                                lines.append(f'{prefix}    {ik}:')
                                lines.extend(_yaml_lines(iv, indent + 3))
                            else:
                                lines.append(f'{prefix}    {ik}: {_yaml_scalar(iv)}')
                else:
                    lines.append(f'{prefix}{k}:')
                    for item in v:
                        lines.append(f'{prefix}  - {_yaml_scalar(item)}')
            else:
                lines.append(f'{prefix}{k}: {_yaml_scalar(v)}')
    elif isinstance(obj, list):
        for item in obj:
            if isinstance(item, dict):
                lines.append(f'{prefix}-')
                for k, v in item.items():
                    if isinstance(v, (dict, list)):
                        lines.append(f'{prefix}  {k}:')
                        lines.extend(_yaml_lines(v, indent + 2))
                    else:
                        lines.append(f'{prefix}  {k}: {_yaml_scalar(v)}')
            else:
                lines.append(f'{prefix}- {_yaml_scalar(item)}')
    return lines


def dump_manifest_yaml(manifest: dict) -> str:
    if yaml is not None:
        return yaml.safe_dump(manifest, sort_keys=False, allow_unicode=True)
    return '\n'.join(_yaml_lines(manifest)) + '\n'


# ── Chart timing ────────────────────────────────────────────────────────
BPM = 90.0
SECONDS_PER_BEAT = 60.0 / BPM
BEATS_PER_BAR = 4
BAR_S = BEATS_PER_BAR * SECONDS_PER_BEAT

COUNT_IN_S = 3.0          # silence / quiet count-in before first note
NOTE_SUS = 2.8            # single-note ring time
CHORD_SUS = 3.0           # power-chord ring time
OUTRO_S = 4.0             # tail after last event

SR = 44100


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
        out.append(s)
    return out


def write_click_wav(path: Path, total_duration_s: float, count_in_s: float):
    """Metronome click on every beat; quieter during count-in."""
    n_total = int(math.ceil(total_duration_s * SR))
    buf = [0.0] * n_total

    click_dur = 0.045
    downbeat_tone = 1500
    upbeat_tone = 1000
    downbeat_amp = 0.22
    upbeat_amp = 0.12
    count_in_amp_scale = 0.35

    beat_idx = 0
    t = 0.0
    while t < total_duration_s - click_dur:
        is_downbeat = (beat_idx % BEATS_PER_BAR) == 0
        amp = downbeat_amp if is_downbeat else upbeat_amp
        if t < count_in_s:
            amp *= count_in_amp_scale
        click = _sine_burst(
            downbeat_tone if is_downbeat else upbeat_tone,
            click_dur,
            amp,
        )
        i0 = int(t * SR)
        for j, v in enumerate(click):
            if i0 + j < n_total:
                buf[i0 + j] += v
        t += SECONDS_PER_BEAT
        beat_idx += 1

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


def _power_chord_e5(t):
    """E5: thickest string open + next string fret 2."""
    return chord(
        t,
        0,
        [
            chord_note(0, 0, sus=CHORD_SUS),
            chord_note(1, 2, sus=CHORD_SUS),
        ],
    )


def build_chart():
    notes = []
    chords = []
    sections = []

    # ── Event times (seconds) ──
    t_open_low = 4.0
    t_open_next = 8.0
    t_fret5 = 12.0
    power_times_1 = [16.0, 20.0, 24.0, 28.0]
    t_open_repeat = 32.0
    t_fret5_repeat = 36.0
    power_times_2 = [40.0, 44.0, 48.0]

    notes.append(note(t_open_low, 0, 0, sus=NOTE_SUS))
    notes.append(note(t_open_next, 1, 0, sus=NOTE_SUS))
    notes.append(note(t_fret5, 0, 5, sus=NOTE_SUS))
    notes.append(note(t_open_repeat, 0, 0, sus=NOTE_SUS))
    notes.append(note(t_fret5_repeat, 0, 5, sus=NOTE_SUS))

    for t in power_times_1 + power_times_2:
        chords.append(_power_chord_e5(t))

    last_event_t = max(power_times_2)
    end_t = last_event_t + CHORD_SUS + OUTRO_S

    sections = [
        {'name': 'Intro', 'number': 1, 'time': 0.0},
        {'name': 'Open Strings', 'number': 2, 'time': round(t_open_low, 3)},
        {'name': 'Fretted Note', 'number': 3, 'time': round(t_fret5, 3)},
        {'name': 'Power Chords', 'number': 4, 'time': round(power_times_1[0], 3)},
        {'name': 'Repeat Check', 'number': 5, 'time': round(t_open_repeat, 3)},
    ]

    beats = []
    bar_count = 0
    bt = 0.0
    while bt < end_t:
        if abs(bt % BAR_S) < 1e-3:
            bar_count += 1
            beats.append({'time': round(bt, 3), 'measure': bar_count})
        else:
            beats.append({'time': round(bt, 3), 'measure': -1})
        bt += SECONDS_PER_BEAT

    anchors = [{'time': 0.0, 'fret': 0, 'width': 6}]
    for sec in sections:
        anchors.append({'time': sec['time'], 'fret': 0, 'width': 6})

    templates = [{
        'name': 'E5',
        'displayName': 'E5',
        'arp': False,
        'fingers': [-1, -1, -1, -1, -1, -1],
        'frets': [0, 2, -1, -1, -1, -1],
    }]

    arrangement = {
        'name': 'Diagnostic Guitar',
        'tuning': [0, 0, 0, 0, 0, 0],
        'capo': 0,
        'notes': sorted(notes, key=lambda n: n['t']),
        'chords': sorted(chords, key=lambda c: c['t']),
        'anchors': anchors,
        'handshapes': [],
        'templates': templates,
        'beats': beats,
        'sections': sections,
    }

    manifest = {
        'title': 'FeedBack Diagnostic — Basic Guitar',
        'artist': 'FeedBack',
        'album': 'Technique Assessment Diagnostics',
        'year': 2026,
        'duration': round(end_t, 3),
        'arrangements': [{
            'id': 'lead',
            'name': 'Diagnostic Guitar',
            'file': 'arrangements/lead.json',
            'tuning': [0, 0, 0, 0, 0, 0],
            'capo': 0,
        }],
        'stems': [{
            'id': 'full',
            'file': 'stems/full.ogg',
            'default': True,
        }],
        'diagnostic': {
            'kind': 'technique-assessment-basic',
            'instrument': 'guitar',
            'string_count': 6,
            'version': 1,
        },
    }

    return manifest, arrangement, end_t


def _build_zip(src_dir: Path, zip_path: Path):
    if zip_path.exists():
        zip_path.unlink()
    with zipfile.ZipFile(zip_path, 'w', compression=zipfile.ZIP_DEFLATED) as zf:
        for p in sorted(src_dir.rglob('*')):
            if p.is_file():
                rel = p.relative_to(src_dir).as_posix()
                info = zipfile.ZipInfo(filename=rel, date_time=(1980, 1, 1, 0, 0, 0))
                info.compress_type = zipfile.ZIP_DEFLATED
                info.external_attr = (0o644 & 0xFFFF) << 16
                info.create_system = 3
                zf.writestr(info, p.read_bytes())


def build(output_zip: Path) -> dict:
    manifest, arrangement, end_t = build_chart()

    staging = output_zip.parent / '_diag_basic_guitar_staging'
    if staging.exists():
        shutil.rmtree(staging)
    staging.mkdir(parents=True)
    (staging / 'arrangements').mkdir()
    (staging / 'stems').mkdir()

    (staging / 'manifest.yaml').write_text(
        dump_manifest_yaml(manifest),
        encoding='utf-8',
    )
    (staging / 'arrangements' / 'lead.json').write_text(
        json.dumps(arrangement, separators=(',', ':')),
        encoding='utf-8',
    )

    wav_path = staging / 'stems' / 'full.wav'
    write_click_wav(wav_path, end_t, COUNT_IN_S)
    ogg_path = staging / 'stems' / 'full.ogg'
    encoder_cmds = [
        ['-c:a', 'libvorbis', '-q:a', '5'],
        # FFmpeg 8's built-in vorbis encoder requires stereo input.
        ['-strict', '-2', '-ac', '2', '-c:a', 'vorbis', '-q:a', '5'],
    ]
    last_err = None
    for enc_args in encoder_cmds:
        try:
            subprocess.run(
                ['ffmpeg', '-y', '-loglevel', 'error',
                 '-i', str(wav_path),
                 *enc_args,
                 str(ogg_path)],
                check=True,
                stderr=subprocess.DEVNULL if enc_args != encoder_cmds[-1] else None,
            )
            last_err = None
            break
        except FileNotFoundError as e:
            shutil.rmtree(staging, ignore_errors=True)
            raise RuntimeError(
                'ffmpeg not found — install ffmpeg to build the OGG stem.'
            ) from e
        except subprocess.CalledProcessError as e:
            last_err = e
    if last_err is not None:
        shutil.rmtree(staging, ignore_errors=True)
        raise RuntimeError(
            'ffmpeg failed to encode stems/full.ogg — tried libvorbis and vorbis encoders.'
        ) from last_err
    wav_path.unlink()

    (staging / 'DIAGNOSTIC.md').write_text(
        _diagnostic_readme(end_t),
        encoding='utf-8',
    )

    _build_zip(staging, output_zip)
    shutil.rmtree(staging, ignore_errors=True)

    return {
        'output': output_zip,
        'duration_s': end_t,
        'notes': len(arrangement['notes']),
        'chords': len(arrangement['chords']),
        'sections': len(arrangement['sections']),
        'stem': 'stems/full.ogg',
        'size_bytes': output_zip.stat().st_size,
    }


def _diagnostic_readme(duration_s: float) -> str:
    return f"""# FeedBack Diagnostic — Basic Guitar

Short generated diagnostic track for technique-assessment style checks.
Non-copyrighted click-track backing only.

- Duration: {duration_s:.0f} s
- Tuning: E standard (6-string), capo 0
- Sections: Intro, Open Strings, Fretted Note, Power Chords, Repeat Check

Report-only — does not change gameplay settings.

Built by docs/diagnostics/build_diagnostic_basic_guitar.py
"""


def main():
    repo_root = Path(__file__).resolve().parents[2]
    default_out = Path(__file__).resolve().parent / 'feedBack-diagnostic-basic-guitar.sloppak'
    out = Path(sys.argv[1]) if len(sys.argv) > 1 else default_out
    if not out.is_absolute():
        out = repo_root / out

    stats = build(out)
    print(f'Built {stats["output"]}')
    print(f'  Duration:  {stats["duration_s"]:.1f} s')
    print(f'  Notes:     {stats["notes"]}')
    print(f'  Chords:    {stats["chords"]}')
    print(f'  Sections:  {stats["sections"]}')
    print(f'  Stem:      {stats["stem"]}')
    print(f'  Size:      {stats["size_bytes"]} bytes')


if __name__ == '__main__':
    main()
