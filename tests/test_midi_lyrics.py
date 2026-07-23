"""Tests for lib/midi_import.py — extract_midi_lyrics (lyrics + vocal melody).

Synthetic mido.MidiFile objects are built in-memory and saved to tmp_path,
same style as test_midi_import.py.

Covers:
  - Lyric (0x05) events on a vocal track → lyrics.json + vocal_pitch.json payloads
  - lyric/note pairing snaps t/d to the note; midi pitch carried through
  - lyrics with no identifiable vocal track → lyrics payload only
  - no lyric events at all → None (import behavior unchanged)
  - .kar '/' line-break prefixes → spec trailing '+' on the previous syllable
  - .kar '-' hyphen joins pass through untouched
  - space-delimited syllable streams gain '-' joins
  - '@'-metadata tokens dropped; Text-event (0x01) fallback on vocal-ish tracks
  - Text events on non-vocal tracks are NOT treated as lyrics
  - unpaired lyric durations run to the next syllable, capped at 2.0 s
  - format-0 mixed-channel file pairs only the vocal-program channel
  - vocal GM program (52-54 / 85-87) detection without a track name
  - audio_offset applied to both payloads
"""

import pytest
import mido

from midi_import import extract_midi_lyrics


TPB = 480  # ticks per beat; default 120 BPM → 480 ticks = 0.5 s


def _save(mid: mido.MidiFile, tmp_path, name: str = "test.mid") -> str:
    p = tmp_path / name
    mid.save(str(p))
    return str(p)


def _vocal_file(tmp_path, *, track_name="Vocals", program=None, meta="lyrics",
                syllables=("Hel-", "lo", "world")):
    """Type-1 file: conductor + one melody track carrying notes with a lyric
    event at each note-on. Notes: 60, 62, 64, each one beat (0.5 s) long,
    back to back."""
    mid = mido.MidiFile(type=1, ticks_per_beat=TPB)
    conductor = mido.MidiTrack()
    mid.tracks.append(conductor)
    conductor.append(mido.MetaMessage("set_tempo", tempo=500000, time=0))

    tr = mido.MidiTrack()
    mid.tracks.append(tr)
    if track_name:
        tr.append(mido.MetaMessage("track_name", name=track_name, time=0))
    if program is not None:
        tr.append(mido.Message("program_change", channel=0, program=program, time=0))
    for i, syl in enumerate(syllables):
        tr.append(mido.MetaMessage(meta, text=syl, time=0))
        tr.append(mido.Message("note_on", channel=0, note=60 + 2 * i,
                               velocity=90, time=0))
        tr.append(mido.Message("note_off", channel=0, note=60 + 2 * i,
                               velocity=0, time=TPB))
    return _save(mid, tmp_path)


# ── both sidecars from a lyric+vocal-track file ──────────────────────────────

def test_vocal_track_emits_both_payloads(tmp_path):
    result = extract_midi_lyrics(_vocal_file(tmp_path))
    assert result is not None
    assert result["lyrics_source"] == "authored"

    lyr = result["lyrics"]
    assert [e["w"] for e in lyr] == ["Hel-", "lo", "world"]
    assert [e["t"] for e in lyr] == pytest.approx([0.0, 0.5, 1.0])
    # Paired syllables snap d to the note duration (1 beat = 0.5 s).
    assert [e["d"] for e in lyr] == pytest.approx([0.5, 0.5, 0.5])

    vp = result["vocal_pitch"]
    assert vp is not None
    assert vp["version"] == 1
    assert [n["midi"] for n in vp["notes"]] == [60, 62, 64]
    # vocal_pitch t/d mirror the matching lyrics entries (spec §7.2).
    assert [(n["t"], n["d"]) for n in vp["notes"]] == \
        [(e["t"], e["d"]) for e in lyr]


def test_vocal_program_detection_without_name(tmp_path):
    """GM program 53 (Voice Oohs) marks the track vocal even with no name."""
    path = _vocal_file(tmp_path, track_name="", program=53)
    result = extract_midi_lyrics(path)
    assert result is not None
    assert result["vocal_pitch"] is not None
    assert [n["midi"] for n in result["vocal_pitch"]["notes"]] == [60, 62, 64]


# ── lyrics-only fallbacks ────────────────────────────────────────────────────

def test_no_vocal_track_emits_lyrics_only(tmp_path):
    """Lyric events on a noteless track + only a piano note track → the
    lyrics payload is emitted but vocal_pitch is None (talkies path)."""
    mid = mido.MidiFile(type=1, ticks_per_beat=TPB)
    conductor = mido.MidiTrack()
    mid.tracks.append(conductor)
    conductor.append(mido.MetaMessage("set_tempo", tempo=500000, time=0))

    words = mido.MidiTrack()
    mid.tracks.append(words)
    words.append(mido.MetaMessage("lyrics", text="Hello ", time=0))
    words.append(mido.MetaMessage("lyrics", text="there ", time=TPB))

    piano = mido.MidiTrack()
    mid.tracks.append(piano)
    piano.append(mido.MetaMessage("track_name", name="Piano", time=0))
    piano.append(mido.Message("program_change", channel=0, program=0, time=0))
    piano.append(mido.Message("note_on", channel=0, note=48, velocity=90, time=0))
    piano.append(mido.Message("note_off", channel=0, note=48, velocity=0, time=TPB))

    result = extract_midi_lyrics(_save(mid, tmp_path))
    assert result is not None
    assert [e["w"] for e in result["lyrics"]] == ["Hello", "there"]
    assert result["vocal_pitch"] is None


def test_no_lyrics_returns_none(tmp_path):
    """A file without lyric events changes nothing — extraction reports None."""
    mid = mido.MidiFile(type=0, ticks_per_beat=TPB)
    tr = mido.MidiTrack()
    mid.tracks.append(tr)
    tr.append(mido.Message("note_on", channel=0, note=60, velocity=90, time=0))
    tr.append(mido.Message("note_off", channel=0, note=60, velocity=0, time=TPB))

    assert extract_midi_lyrics(_save(mid, tmp_path)) is None


def test_unpaired_duration_next_event_capped_at_2s(tmp_path):
    """Unpaired lyric entries last until the next syllable, capped at 2.0 s."""
    mid = mido.MidiFile(type=1, ticks_per_beat=TPB)
    conductor = mido.MidiTrack()
    mid.tracks.append(conductor)
    conductor.append(mido.MetaMessage("set_tempo", tempo=500000, time=0))

    words = mido.MidiTrack()
    mid.tracks.append(words)
    words.append(mido.MetaMessage("lyrics", text="one ", time=0))
    words.append(mido.MetaMessage("lyrics", text="two ", time=TPB))       # +0.5 s
    words.append(mido.MetaMessage("lyrics", text="three ", time=TPB * 8))  # +4.0 s

    result = extract_midi_lyrics(_save(mid, tmp_path))
    lyr = result["lyrics"]
    assert lyr[0]["d"] == pytest.approx(0.5)   # gap to next syllable
    assert lyr[1]["d"] == pytest.approx(2.0)   # 4.0 s gap capped
    assert lyr[2]["d"] == pytest.approx(2.0)   # last entry: cap value


# ── .kar conventions ─────────────────────────────────────────────────────────

def test_kar_slash_line_break_maps_to_plus(tmp_path):
    """A '/' prefix on a syllable marks the END of the previous line — the
    previous syllable gains the spec's trailing '+'."""
    path = _vocal_file(
        tmp_path, syllables=("Hel-", "lo", "/world"))
    result = extract_midi_lyrics(path)
    words = [e["w"] for e in result["lyrics"]]
    assert words == ["Hel-", "lo+", "world"]


def test_kar_backslash_paragraph_break_maps_to_plus(tmp_path):
    path = _vocal_file(tmp_path, syllables=("one", "\\two", "three"))
    words = [e["w"] for e in extract_midi_lyrics(path)["lyrics"]]
    assert words == ["one+", "two", "three"]


def test_kar_hyphen_joins_pass_through(tmp_path):
    """.kar hyphen suffixes already ARE the spec join marker — untouched,
    and no extra '-' is synthesized onto hyphenless word-final syllables."""
    path = _vocal_file(tmp_path, syllables=("beau-", "ti-", "ful", "day"))
    words = [e["w"] for e in extract_midi_lyrics(path)["lyrics"]]
    assert words == ["beau-", "ti-", "ful", "day"]


def test_space_delimited_stream_gains_hyphen_joins(tmp_path):
    """Space-delimited Lyric streams ('Hel' 'lo ' 'world') carry word
    boundaries in whitespace — mid-word syllables gain the '-' join."""
    path = _vocal_file(tmp_path, syllables=("Hel", "lo ", "world "))
    words = [e["w"] for e in extract_midi_lyrics(path)["lyrics"]]
    assert words == ["Hel-", "lo", "world"]


def test_newline_in_lyric_event_ends_line(tmp_path):
    path = _vocal_file(tmp_path, syllables=("one \n", "two ", "three "))
    words = [e["w"] for e in extract_midi_lyrics(path)["lyrics"]]
    assert words == ["one+", "two", "three"]


# ── Text-event (0x01) fallback ───────────────────────────────────────────────

def test_text_event_fallback_on_vocal_track(tmp_path):
    """With no 0x05 events anywhere, Text events on a vocal-ish track are
    accepted as lyrics; '@'-prefixed .kar metadata tokens are dropped."""
    mid = mido.MidiFile(type=1, ticks_per_beat=TPB)
    conductor = mido.MidiTrack()
    mid.tracks.append(conductor)
    conductor.append(mido.MetaMessage("set_tempo", tempo=500000, time=0))

    tr = mido.MidiTrack()
    mid.tracks.append(tr)
    tr.append(mido.MetaMessage("track_name", name="Melody", time=0))
    tr.append(mido.MetaMessage("text", text="@KMIDI KARAOKE FILE", time=0))
    tr.append(mido.MetaMessage("text", text="@T A Song", time=0))
    for i, syl in enumerate(("Some ", "words ")):
        tr.append(mido.MetaMessage("text", text=syl, time=0))
        tr.append(mido.Message("note_on", channel=0, note=64 + i, velocity=90,
                               time=0))
        tr.append(mido.Message("note_off", channel=0, note=64 + i, velocity=0,
                               time=TPB))

    result = extract_midi_lyrics(_save(mid, tmp_path))
    assert result is not None
    assert [e["w"] for e in result["lyrics"]] == ["Some", "words"]
    assert [n["midi"] for n in result["vocal_pitch"]["notes"]] == [64, 65]


def test_text_events_on_non_vocal_track_ignored(tmp_path):
    """Text events on a plain instrument track (copyright notices, markers)
    are not lyrics — extraction returns None."""
    mid = mido.MidiFile(type=1, ticks_per_beat=TPB)
    conductor = mido.MidiTrack()
    mid.tracks.append(conductor)
    conductor.append(mido.MetaMessage("set_tempo", tempo=500000, time=0))

    tr = mido.MidiTrack()
    mid.tracks.append(tr)
    tr.append(mido.MetaMessage("track_name", name="Guitar", time=0))
    tr.append(mido.MetaMessage("text", text="Copyright 2026", time=0))
    tr.append(mido.Message("note_on", channel=0, note=52, velocity=90, time=0))
    tr.append(mido.Message("note_off", channel=0, note=52, velocity=0, time=TPB))

    assert extract_midi_lyrics(_save(mid, tmp_path)) is None


# ── format-0 channel isolation ───────────────────────────────────────────────

def test_format0_pairs_only_vocal_program_channel(tmp_path):
    """Format-0 file mixing a vocal-program channel with an accompaniment
    channel: only the vocal channel's notes feed vocal_pitch."""
    mid = mido.MidiFile(type=0, ticks_per_beat=TPB)
    tr = mido.MidiTrack()
    mid.tracks.append(tr)
    tr.append(mido.Message("program_change", channel=0, program=53, time=0))  # Voice Oohs
    tr.append(mido.Message("program_change", channel=1, program=0, time=0))   # Piano
    # Simultaneous piano note that must NOT be paired.
    tr.append(mido.Message("note_on", channel=1, note=40, velocity=90, time=0))
    tr.append(mido.MetaMessage("lyrics", text="la ", time=0))
    tr.append(mido.Message("note_on", channel=0, note=67, velocity=90, time=0))
    tr.append(mido.Message("note_off", channel=0, note=67, velocity=0, time=TPB))
    tr.append(mido.Message("note_off", channel=1, note=40, velocity=0, time=0))

    result = extract_midi_lyrics(_save(mid, tmp_path))
    assert result is not None
    assert [n["midi"] for n in result["vocal_pitch"]["notes"]] == [67]


def test_format0_without_vocal_channel_is_lyrics_only(tmp_path):
    """Format-0 with lyrics but no vocal program/name: the merged note soup
    cannot be trusted as a melody — lyrics.json only."""
    mid = mido.MidiFile(type=0, ticks_per_beat=TPB)
    tr = mido.MidiTrack()
    mid.tracks.append(tr)
    tr.append(mido.Message("program_change", channel=0, program=0, time=0))
    tr.append(mido.MetaMessage("lyrics", text="la ", time=0))
    tr.append(mido.Message("note_on", channel=0, note=60, velocity=90, time=0))
    tr.append(mido.Message("note_off", channel=0, note=60, velocity=0, time=TPB))

    result = extract_midi_lyrics(_save(mid, tmp_path))
    assert result is not None
    assert len(result["lyrics"]) == 1
    assert result["vocal_pitch"] is None


# ── audio_offset ─────────────────────────────────────────────────────────────

def test_audio_offset_applied_to_both_payloads(tmp_path):
    result = extract_midi_lyrics(_vocal_file(tmp_path), audio_offset=1.5)
    assert result["lyrics"][0]["t"] == pytest.approx(1.5)
    assert result["vocal_pitch"]["notes"][0]["t"] == pytest.approx(1.5)
