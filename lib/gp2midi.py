"""Generate MIDI and render audio from a Guitar Pro file."""

import glob
import logging
import os
import subprocess
import sys
import tempfile
from pathlib import Path

from env_compat import getenv_compat

log = logging.getLogger("feedBack.lib.gp2midi")

import guitarpro
from midiutil import MIDIFile

GP_TICKS_PER_QUARTER = 960

# Standard tuning MIDI values (GP string order: 1=high, 6=low)
STANDARD_6 = [64, 59, 55, 50, 45, 40]  # e B G D A E
STANDARD_4 = [43, 38, 33, 28]          # G D A E (bass)


def gp_to_midi(gp_path: str, output_midi: str, track_indices: list[int] | None = None,
               force_standard_tuning: bool = False) -> str:
    """Convert Guitar Pro file to MIDI.

    Args:
        gp_path: Path to .gp5/.gp4/.gp3 file
        output_midi: Output .mid file path
        track_indices: Which tracks to include (None = all non-percussion)
        force_standard_tuning: If True, use E standard tuning for all instruments
            (keeps fret numbers, changes the pitch of open strings)

    Returns:
        Path to the MIDI file
    """
    song = guitarpro.parse(gp_path)

    if track_indices is None:
        track_indices = list(range(len(song.tracks)))

    midi = MIDIFile(
        len(track_indices),
        ticks_per_quarternote=GP_TICKS_PER_QUARTER,
    )

    for midi_track_idx, gp_track_idx in enumerate(track_indices):
        track = song.tracks[gp_track_idx]
        is_perc = track.isPercussionTrack

        # MIDI channel: percussion must be 9, others avoid 9
        if is_perc:
            channel = 9
        else:
            channel = midi_track_idx if midi_track_idx < 9 else midi_track_idx + 1
            channel = min(channel, 15)

        midi.addTrackName(midi_track_idx, 0, track.name)
        midi.addTempo(midi_track_idx, 0, song.tempo)

        # Instrument and volume from GP channel data
        gp_ch = track.channel
        if gp_ch and not is_perc:
            midi.addProgramChange(midi_track_idx, channel, 0, gp_ch.instrument)
        elif not is_perc:
            midi.addProgramChange(midi_track_idx, channel, 0, 29)  # overdriven guitar

        # Volume (CC7) and pan (CC10)
        if gp_ch:
            vol = min(127, gp_ch.volume)
            pan = min(127, gp_ch.balance)
            midi.addControllerEvent(midi_track_idx, channel, 0, 7, vol)
            midi.addControllerEvent(midi_track_idx, channel, 0, 10, pan)

        # Tempo changes
        tempo_added = set()
        for measure in track.measures:
            for voice in measure.voices:
                for beat in voice.beats:
                    if beat.effect and beat.effect.mixTableChange:
                        mtc = beat.effect.mixTableChange
                        if mtc.tempo and mtc.tempo.value > 0:
                            tick_time = beat.start / GP_TICKS_PER_QUARTER
                            if tick_time not in tempo_added:
                                midi.addTempo(midi_track_idx, tick_time, mtc.tempo.value)
                                tempo_added.add(tick_time)

        # Notes
        for measure in track.measures:
            for voice in measure.voices:
                for beat in voice.beats:
                    if not beat.notes:
                        continue

                    beat_time = beat.start / GP_TICKS_PER_QUARTER

                    dur_quarters = 4.0 / beat.duration.value
                    if beat.duration.isDotted:
                        dur_quarters *= 1.5
                    if beat.duration.tuplet.enters > 0 and beat.duration.tuplet.times > 0:
                        dur_quarters *= beat.duration.tuplet.times / beat.duration.tuplet.enters

                    for note in beat.notes:
                        if note.type == guitarpro.NoteType.rest:
                            continue

                        if force_standard_tuning and not is_perc:
                            num_strings = len(track.strings)
                            std = STANDARD_4 if num_strings == 4 else STANDARD_6
                            string_midi = std[note.string - 1] if note.string - 1 < len(std) else track.strings[note.string - 1].value
                        else:
                            string_midi = track.strings[note.string - 1].value
                        pitch = string_midi + note.value

                        if note.type == guitarpro.NoteType.dead:
                            dur_q = 0.05
                        else:
                            dur_q = dur_quarters

                        velocity = note.velocity
                        if note.effect.ghostNote:
                            velocity = max(20, velocity // 2)

                        # Skip invalid notes that would cause midiutil to crash
                        if dur_q <= 0:
                            dur_q = 0.05
                        if pitch < 0 or pitch > 127:
                            continue
                        if velocity <= 0:
                            velocity = 1

                        midi.addNote(
                            midi_track_idx, channel,
                            pitch, beat_time, dur_q, velocity,
                        )

    with open(output_midi, "wb") as f:
        try:
            midi.writeFile(f)
        except IndexError:
            # midiutil can crash with "pop from empty list" on malformed note events
            # Retry with deinterleave disabled
            f.seek(0)
            f.truncate()
            midi.close()
            midi.writeFile(f)

    return output_midi


def _find_soundfont() -> str | None:
    """Locate a .sf2 soundfont for MIDI rendering.

    Precedence:
      1. ``FEEDBACK_SOUNDFONT`` env var (user override / desktop-app-supplied)
      2. Bundled ``<RESOURCESPATH>/soundfonts/*.sf2`` (Electron desktop builds)
      3. Common system locations per OS.
    """
    override = getenv_compat("FEEDBACK_SOUNDFONT")
    if override:
        if os.path.isfile(override):
            return override
        log.warning("FEEDBACK_SOUNDFONT is set to %r but that file does not exist; falling back to other sources", override)

    resources = os.environ.get("RESOURCESPATH")
    if resources:
        matches = sorted(glob.glob(os.path.join(resources, "soundfonts", "*.sf2")))
        if matches:
            return matches[0]

    candidates: list[str] = []
    if sys.platform.startswith("linux"):
        candidates += [
            "/usr/share/soundfonts/FluidR3_GM.sf2",
            "/usr/share/soundfonts/FluidR3_GS.sf2",
            "/usr/share/soundfonts/default.sf2",
            "/usr/share/sounds/sf2/FluidR3_GM.sf2",
            "/usr/share/sounds/sf2/default-GM.sf2",
        ]
    elif sys.platform == "darwin":
        candidates += [
            "/opt/homebrew/share/sounds/sf2/FluidR3_GM.sf2",
            "/opt/homebrew/share/soundfonts/FluidR3_GM.sf2",
            "/usr/local/share/sounds/sf2/FluidR3_GM.sf2",
            "/usr/local/share/soundfonts/FluidR3_GM.sf2",
        ]
    elif sys.platform == "win32":
        appdata = os.environ.get("APPDATA")
        if appdata:
            # "FeedBack" matches feedBack-desktop's Electron productName
            # (app.getPath('userData') resolves to %APPDATA%\FeedBack on Windows).
            for pattern in (
                os.path.join(appdata, "FeedBack", "soundfonts", "*.sf2"),
                os.path.join(appdata, "SoundFonts", "*.sf2"),
            ):
                candidates += sorted(glob.glob(pattern))

    for path in candidates:
        if os.path.isfile(path):
            return path
    return None


def _soundfont_install_hint() -> str:
    if sys.platform.startswith("linux"):
        return (
            "Install a soundfont:\n"
            "  Arch/Manjaro:  sudo pacman -S soundfont-fluid\n"
            "  Debian/Ubuntu: sudo apt install fluid-soundfont-gm\n"
            "  Fedora:        sudo dnf install fluid-soundfont-gm"
        )
    if sys.platform == "darwin":
        # Homebrew's fluid-synth formula doesn't bundle a soundfont; the user
        # needs to fetch one separately (confirmed 2026-04 against the
        # upstream formula).
        return (
            "Download a soundfont (e.g. GeneralUser GS from schristiancollins.com "
            "or FluidR3_GM from musical-artifacts.com) and either place the .sf2 "
            "file in /usr/local/share/sounds/sf2/ (Intel) or "
            "/opt/homebrew/share/sounds/sf2/ (Apple Silicon), or set the "
            "FEEDBACK_SOUNDFONT environment variable to its full path."
        )
    if sys.platform == "win32":
        return (
            "Download a soundfont (e.g. GeneralUser GS from schristiancollins.com or "
            "FluidR3_GM from musical-artifacts.com) and either place the .sf2 file in "
            "%APPDATA%\\FeedBack\\soundfonts\\ or set the FEEDBACK_SOUNDFONT "
            "environment variable to its full path."
        )
    return "Set FEEDBACK_SOUNDFONT to the full path of a .sf2 file."


def _fluidsynth_install_hint() -> str:
    if sys.platform.startswith("linux"):
        return (
            "Install fluidsynth:\n"
            "  Arch/Manjaro:  sudo pacman -S fluidsynth\n"
            "  Debian/Ubuntu: sudo apt install fluidsynth\n"
            "  Fedora:        sudo dnf install fluidsynth"
        )
    if sys.platform == "darwin":
        return "Install fluidsynth with Homebrew: brew install fluid-synth"
    if sys.platform == "win32":
        return (
            "Install fluidsynth (https://github.com/FluidSynth/fluidsynth/releases) and "
            "ensure fluidsynth.exe is on your PATH."
        )
    return "Install fluidsynth and ensure it is on PATH."


def render_midi_to_audio(midi_path: str, output_path: str) -> str:
    """Render MIDI to OGG audio using fluidsynth."""
    soundfont = _find_soundfont()
    if not soundfont:
        raise RuntimeError(
            "No soundfont found. " + _soundfont_install_hint()
        )

    wav_path = output_path + ".wav"
    ogg_path = output_path + ".ogg"

    try:
        result = subprocess.run(
            ["fluidsynth", "-ni", "-T", "wav", "-F", wav_path, "-r", "44100", soundfont, midi_path],
            capture_output=True, text=True, timeout=600,
        )
    except FileNotFoundError as e:
        raise RuntimeError("fluidsynth not found. " + _fluidsynth_install_hint()) from e

    if result.returncode != 0 or not os.path.exists(wav_path):
        raise RuntimeError(f"fluidsynth failed: {result.stderr[-300:]}")

    result = subprocess.run(
        ["ffmpeg", "-y", "-i", wav_path, "-q:a", "6", ogg_path],
        capture_output=True, timeout=60,
    )
    if result.returncode == 0 and os.path.exists(ogg_path):
        os.remove(wav_path)
        return ogg_path

    return wav_path


def gp_to_audio(gp_path: str, output_path: str,
                track_indices: list[int] | None = None,
                force_standard_tuning: bool = False) -> str:
    """Convert Guitar Pro file directly to audio.

    Args:
        gp_path: Path to .gp5 file
        output_path: Output audio file path (without extension)
        track_indices: Which tracks (None = all including drums)
        force_standard_tuning: Force E standard tuning (keeps frets, changes pitch)

    Returns:
        Path to the audio file
    """
    tmp_midi = tempfile.mktemp(suffix=".mid", prefix="rs_midi_")
    try:
        tuning_label = " (E Standard)" if force_standard_tuning else ""
        log.info("Generating MIDI from %s%s", Path(gp_path).name, tuning_label)
        gp_to_midi(gp_path, tmp_midi, track_indices, force_standard_tuning)
        log.info("Rendering audio with FluidSynth...")
        return render_midi_to_audio(tmp_midi, output_path)
    finally:
        if os.path.exists(tmp_midi):
            os.remove(tmp_midi)
