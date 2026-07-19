"""Tests for lib/loosefolder.py — pure helpers for loose custom song folders."""

import json
from pathlib import Path

import pytest

import loosefolder


_MIN_XML = """<?xml version="1.0" encoding="utf-8"?>
<song>
  <title>{title}</title>
  <artistName>{artist}</artistName>
  <albumName>{album}</albumName>
  <albumYear>{year}</albumYear>
  <songLength>{duration}</songLength>
  <arrangement>{arrangement}</arrangement>
  <offset>0.0</offset>
  <tuning string0="0" string1="0" string2="0" string3="0" string4="0" string5="0"/>
</song>
"""


def _write_min_xml(path: Path, *, title="T", artist="A", album="Alb",
                   year="2024", duration="123.4", arrangement="Lead"):
    path.write_text(_MIN_XML.format(
        title=title, artist=artist, album=album, year=year,
        duration=duration, arrangement=arrangement,
    ), encoding="utf-8")


def test_is_loose_song_requires_audio_and_xml(tmp_path):
    assert loosefolder.is_loose_song(tmp_path) is False  # empty

    (tmp_path / "audio.wem").write_bytes(b"RIFF\x00")
    assert loosefolder.is_loose_song(tmp_path) is False  # no xml

    _write_min_xml(tmp_path / "lead.xml")
    assert loosefolder.is_loose_song(tmp_path) is True

    not_a_dir = tmp_path / "lead.xml"
    assert loosefolder.is_loose_song(not_a_dir) is False


def test_is_loose_song_ignores_preview_wem(tmp_path):
    (tmp_path / "preview_song.wem").write_bytes(b"RIFF\x00")
    _write_min_xml(tmp_path / "lead.xml")
    # No non-preview WEM: not a loose song.
    assert loosefolder.is_loose_song(tmp_path) is False


def test_is_loose_song_rejects_vocals_only_folder(tmp_path):
    """A folder with audio + only a vocals/showlights XML has no playable
    arrangement and must not be classified as a loose song."""
    (tmp_path / "audio.wem").write_bytes(b"RIFF\x00")
    (tmp_path / "vocals.xml").write_text("<vocals/>", encoding="utf-8")
    (tmp_path / "showlights.xml").write_text("<showlights/>", encoding="utf-8")
    assert loosefolder.is_loose_song(tmp_path) is False


def test_is_loose_song_rejects_external_symlinked_xml(tmp_path):
    """An XML symlinked outside the folder must not count as an
    in-folder arrangement (folder-boundary check)."""
    outside = tmp_path / "outside"
    outside.mkdir()
    real_xml = outside / "real.xml"
    _write_min_xml(real_xml)

    song = tmp_path / "song"
    song.mkdir()
    (song / "audio.wem").write_bytes(b"\0")
    try:
        (song / "lead.xml").symlink_to(real_xml)
    except (OSError, NotImplementedError):
        pytest.skip("symlink creation not permitted on this host")
    assert loosefolder.is_loose_song(song) is False


def test_is_loose_song_keeps_song_xml_with_vocals_in_filename(tmp_path):
    """Classification uses the XML root tag, not the filename — a custom
    named `lead_vocals_fix.xml` whose root is <song> is still a real
    playable arrangement."""
    (tmp_path / "audio.wem").write_bytes(b"RIFF\x00")
    _write_min_xml(tmp_path / "lead_vocals_fix.xml")
    assert loosefolder.is_loose_song(tmp_path) is True


def test_find_audio_prefers_known_names(tmp_path):
    big = tmp_path / "other.wem"
    big.write_bytes(b"\0" * 4096)
    canonical = tmp_path / "audio.wem"
    canonical.write_bytes(b"\0" * 8)
    assert loosefolder.find_audio(tmp_path) == canonical


def test_find_audio_skips_directories_named_audio_wem(tmp_path):
    """A directory named audio.wem must not be returned by find_audio
    or counted by is_loose_song (would later crash convert_wem)."""
    (tmp_path / "audio.wem").mkdir()  # directory, not a file
    _write_min_xml(tmp_path / "lead.xml")
    assert loosefolder.find_audio(tmp_path) is None
    assert loosefolder.is_loose_song(tmp_path) is False


def test_find_audio_falls_back_to_largest_non_preview(tmp_path):
    small = tmp_path / "tiny.wem"
    small.write_bytes(b"\0" * 16)
    big = tmp_path / "full.wem"
    big.write_bytes(b"\0" * 4096)
    (tmp_path / "preview_clip.wem").write_bytes(b"\0" * 8192)  # ignored
    assert loosefolder.find_audio(tmp_path) == big


def test_find_art_picks_first_recognised_name(tmp_path):
    (tmp_path / "album_art.jpg").write_bytes(b"\xff\xd8\xff\xe0")
    assert loosefolder.find_art(tmp_path).name == "album_art.jpg"


def test_find_art_matches_jpeg_and_webp_extensions(tmp_path):
    """get_song_art serves .jpeg and .webp media types, so find_art
    must discover those extensions too."""
    (tmp_path / "cover.webp").write_bytes(b"RIFF")
    assert loosefolder.find_art(tmp_path).name == "cover.webp"

    other = tmp_path / "elsewhere"
    other.mkdir()
    (other / "album_art.jpeg").write_bytes(b"\xff\xd8\xff\xe0")
    assert loosefolder.find_art(other).name == "album_art.jpeg"


def test_arr_type_from_filename():
    assert loosefolder._arr_type_from_filename("lead_v1")[0] == "lead"
    assert loosefolder._arr_type_from_filename("rhythm")[0] == "rhythm"
    assert loosefolder._arr_type_from_filename("bass_final")[0] == "bass"
    assert loosefolder._arr_type_from_filename("combo")[0] == "combo"
    assert loosefolder._arr_type_from_filename("chord_v2")[0] == "combo"
    # Unknown stem defaults to lead.
    assert loosefolder._arr_type_from_filename("mystery")[0] == "lead"


def test_extract_meta_priority_chain_manifest_wins(tmp_path):
    (tmp_path / "audio.wem").write_bytes(b"\0")
    _write_min_xml(tmp_path / "lead.xml",
                   title="XmlTitle", artist="XmlArtist", album="XmlAlbum",
                   year="2024", arrangement="Lead")
    (tmp_path / "manifest.json").write_text(json.dumps({
        "title": "ManifestTitle",
        "artist": "ManifestArtist",
        "year": "1999",
    }), encoding="utf-8")

    meta = loosefolder.extract_meta(tmp_path)
    assert meta["title"] == "ManifestTitle"
    assert meta["artist"] == "ManifestArtist"
    # Manifest didn't override album, so XML wins.
    assert meta["album"] == "XmlAlbum"
    assert meta["year"] == "1999"


def test_extract_meta_falls_back_to_xml(tmp_path):
    (tmp_path / "audio.wem").write_bytes(b"\0")
    _write_min_xml(tmp_path / "lead.xml",
                   title="XmlTitle", artist="XmlArtist", album="XmlAlbum",
                   year="2024", duration="200.0", arrangement="Lead")

    meta = loosefolder.extract_meta(tmp_path)
    assert meta["title"] == "XmlTitle"
    assert meta["artist"] == "XmlArtist"
    assert meta["album"] == "XmlAlbum"
    assert meta["year"] == "2024"
    assert meta["duration"] == 200.0
    assert meta["has_lyrics"] is False
    assert meta["audio_path"] and meta["audio_path"].endswith("audio.wem")


def test_extract_meta_detects_arrangements_sorted_by_priority(tmp_path):
    (tmp_path / "audio.wem").write_bytes(b"\0")
    _write_min_xml(tmp_path / "bass.xml", arrangement="Bass")
    _write_min_xml(tmp_path / "rhythm.xml", arrangement="Rhythm")
    _write_min_xml(tmp_path / "lead.xml", arrangement="Lead")

    meta = loosefolder.extract_meta(tmp_path)
    types = [a["type"] for a in meta["arrangements"]]
    assert types == ["lead", "rhythm", "bass"]


_BASS_TUNED_XML = """<?xml version="1.0" encoding="utf-8"?>
<song>
  <title>Same</title>
  <artistName>A</artistName>
  <albumName>Alb</albumName>
  <albumYear>2024</albumYear>
  <songLength>200</songLength>
  <arrangement>Bass</arrangement>
  <offset>0</offset>
  <tuning string0="-4" string1="-4" string2="-4" string3="-4" string4="0" string5="0"/>
</song>
"""

_LEAD_STD_XML = """<?xml version="1.0" encoding="utf-8"?>
<song>
  <title>Same</title>
  <artistName>A</artistName>
  <albumName>Alb</albumName>
  <albumYear>2024</albumYear>
  <songLength>200</songLength>
  <arrangement>Lead</arrangement>
  <offset>0</offset>
  <tuning string0="0" string1="0" string2="0" string3="0" string4="0" string5="0"/>
</song>
"""


def test_extract_meta_coerces_non_string_text_fields(tmp_path):
    """Non-string manifest title/artist/album/year values must fall
    back to XML/folder defaults instead of being stored verbatim."""
    (tmp_path / "audio.wem").write_bytes(b"\0")
    _write_min_xml(tmp_path / "lead.xml",
                   title="XmlTitle", artist="XmlArtist", album="XmlAlbum",
                   year="2024")
    (tmp_path / "manifest.json").write_text(json.dumps({
        "title": ["not", "a", "string"],
        "artist": None,
        "album": 1999,           # number masquerading as album
        "year": 2024,            # numeric year is allowed, becomes "2024"
    }), encoding="utf-8")

    meta = loosefolder.extract_meta(tmp_path)
    assert meta["title"] == "XmlTitle"
    assert meta["artist"] == "XmlArtist"
    assert meta["album"] == "XmlAlbum"
    assert meta["year"] == "2024"


def test_extract_meta_rejects_non_finite_manifest_duration(tmp_path):
    """A manifest with duration=Infinity / NaN must not poison metadata
    because Starlette refuses to JSON-encode non-finite floats and would
    later crash /api/song responses."""
    (tmp_path / "audio.wem").write_bytes(b"\0")
    _write_min_xml(tmp_path / "lead.xml", duration="120")
    (tmp_path / "manifest.json").write_text(json.dumps({
        "duration": "Infinity",
    }), encoding="utf-8")

    meta = loosefolder.extract_meta(tmp_path)
    assert meta["duration"] == 120.0  # falls back to XML, not float('inf')


def test_extract_meta_survives_malformed_manifest_duration(tmp_path):
    """A manifest.json with a non-numeric duration must not crash the
    scan — the value should be coerced to 0.0 and XML/folder fallback
    should still produce a row."""
    (tmp_path / "audio.wem").write_bytes(b"\0")
    _write_min_xml(tmp_path / "lead.xml", duration="200.0")
    (tmp_path / "manifest.json").write_text(json.dumps({
        "duration": "abc",
        "tuning_offsets": "not a list",
        "arrangements": "garbage",
    }), encoding="utf-8")

    meta = loosefolder.extract_meta(tmp_path)
    # Bad manifest duration falls back to XML's 200.0
    assert meta["duration"] == 200.0
    # Bad tuning_offsets falls back to XML's [0]*6
    assert meta["tuning_offsets"] == [0, 0, 0, 0, 0, 0]
    # Bad arrangements payload is ignored; detected arrangements survive
    assert len(meta["arrangements"]) == 1


def test_extract_meta_does_not_leak_absolute_path_as_artist(tmp_path):
    """Without a dlc_root, artist/album must not pull from absolute path
    components (e.g. user's home dir name)."""
    (tmp_path / "audio.wem").write_bytes(b"\0")
    _write_min_xml(tmp_path / "lead.xml", title="T", artist="", album="")

    meta = loosefolder.extract_meta(tmp_path)  # no dlc_root
    assert meta["artist"] == ""
    assert meta["album"] == ""


def test_extract_meta_infers_artist_album_from_dlc_relative_path(tmp_path):
    """With a dlc_root, artist/album are taken from the dlc-relative
    grandparent / parent dirs when XML and manifest are silent."""
    song_dir = tmp_path / "MyArtist" / "MyAlbum" / "MySong"
    song_dir.mkdir(parents=True)
    (song_dir / "audio.wem").write_bytes(b"\0")
    _write_min_xml(song_dir / "lead.xml", artist="", album="")

    meta = loosefolder.extract_meta(song_dir, dlc_root=tmp_path)
    assert meta["artist"] == "MyArtist"
    assert meta["album"] == "MyAlbum"


def test_extract_meta_uses_lead_tuning_when_bass_sorts_first(tmp_path):
    """bass.xml sorts before lead.xml alphabetically; the guitar tuning
    should still win shared_meta so the library shows E Standard rather
    than the bass's down-tuned offsets."""
    (tmp_path / "audio.wem").write_bytes(b"\0")
    (tmp_path / "bass.xml").write_text(_BASS_TUNED_XML, encoding="utf-8")
    (tmp_path / "lead.xml").write_text(_LEAD_STD_XML, encoding="utf-8")

    meta = loosefolder.extract_meta(tmp_path)
    assert meta["tuning_offsets"] == [0, 0, 0, 0, 0, 0]
    # …and the bass chart's OWN tuning is indexed alongside it, so a bass
    # player's library filter isn't answered with the guitar tuning.
    assert meta["bass_tuning_offsets"] == [-4, -4, -4, -4, 0, 0]


def test_extract_meta_bass_tuning_absent_without_bass_arrangement(tmp_path):
    """A folder with no bass chart leaves the bass tuning EMPTY (None) rather
    than echoing the guitar tuning — the library then falls back explicitly,
    and 'no bass part' stays distinguishable from 'bass part in E Standard'."""
    (tmp_path / "audio.wem").write_bytes(b"\0")
    (tmp_path / "lead.xml").write_text(_LEAD_STD_XML, encoding="utf-8")

    meta = loosefolder.extract_meta(tmp_path)
    assert meta["tuning_offsets"] == [0, 0, 0, 0, 0, 0]
    assert meta["bass_tuning_offsets"] is None


def test_extract_meta_bass_tuning_matches_guitar_is_still_indexed(tmp_path):
    """The COMMON case: bass and guitar in the same tuning. The bass column
    must still be populated — an empty one would be read as 'no bass chart'."""
    (tmp_path / "audio.wem").write_bytes(b"\0")
    _write_min_xml(tmp_path / "lead.xml", arrangement="Lead")
    _write_min_xml(tmp_path / "bass.xml", arrangement="Bass")

    meta = loosefolder.extract_meta(tmp_path)
    assert meta["bass_tuning_offsets"] == [0, 0, 0, 0, 0, 0]


def test_extract_meta_manifest_tuning_does_not_become_the_bass_tuning(tmp_path):
    """A manifest `tuning_offsets` overrides the SONG tuning but says nothing
    about which chart it describes, so it must never be mistaken for the bass
    part's tuning — with no bass chart the bass column stays empty."""
    (tmp_path / "audio.wem").write_bytes(b"\0")
    (tmp_path / "lead.xml").write_text(_LEAD_STD_XML, encoding="utf-8")
    (tmp_path / "manifest.json").write_text(json.dumps({
        "tuning_offsets": [-2, -2, -2, -2, -2, -2],
    }), encoding="utf-8")

    meta = loosefolder.extract_meta(tmp_path)
    assert meta["tuning_offsets"] == [-2, -2, -2, -2, -2, -2]
    assert meta["bass_tuning_offsets"] is None
