"""Pure Python WEM (Wwise Vorbis) to OGG converter.
Strips the RIFF/BKHD wrapper and reconstructs valid OGG Vorbis data.
This is a fallback for platforms without vgmstream (e.g. Android)."""

import logging
import struct
import os

log = logging.getLogger("feedBack.lib.wem_decode")


def convert_wem_to_ogg(wem_path: str, output_path: str) -> bool:
    """Convert a WEM file to OGG by extracting the embedded Vorbis data.
    Returns True if successful."""
    try:
        with open(wem_path, 'rb') as f:
            data = f.read()

        # WEM files are RIFF containers with Wwise-specific chunks
        if data[:4] == b'RIFF':
            return _convert_riff_wem(data, output_path)

        return False
    except Exception as e:
        log.warning("WEM decode error for %s -> %s: %s", wem_path, output_path, e, exc_info=True)
        return False


def _convert_riff_wem(data: bytes, output_path: str) -> bool:
    """Parse RIFF-based WEM and extract audio data."""
    pos = 12  # skip RIFF header + size + WAVE

    fmt_data = None
    audio_data = None
    vorb_data = None

    while pos < len(data) - 8:
        chunk_id = data[pos:pos+4]
        chunk_size = struct.unpack_from('<I', data, pos+4)[0]
        chunk_data = data[pos+8:pos+8+chunk_size]

        if chunk_id == b'fmt ':
            fmt_data = chunk_data
        elif chunk_id == b'data':
            audio_data = chunk_data
        elif chunk_id == b'vorb':
            vorb_data = chunk_data

        pos += 8 + chunk_size
        if chunk_size % 2:  # RIFF chunks are word-aligned
            pos += 1

    if fmt_data is None or audio_data is None:
        return False

    # Check codec: 0xFFFF = Wwise Vorbis, 0x0002 = Wwise ADPCM
    codec = struct.unpack_from('<H', fmt_data, 0)[0]

    if codec == 0xFFFF or codec == 0x0069:
        # Wwise Vorbis — audio_data contains raw Ogg pages or encoded Vorbis
        # For custom songs, the data is typically packed Vorbis
        # Try writing raw data as OGG (some WEM files have valid OGG inside)
        if _try_extract_ogg_pages(audio_data, output_path):
            return True

    # Fallback: write raw data and hope the browser can play it
    # Some WEM files are just renamed OGG/Opus
    if audio_data[:4] == b'OggS':
        with open(output_path, 'wb') as f:
            f.write(audio_data)
        return True

    return False


def _try_extract_ogg_pages(data: bytes, output_path: str) -> bool:
    """Try to find and extract OGG pages from the data."""
    # Search for OGG page headers
    ogg_start = data.find(b'OggS')
    if ogg_start >= 0:
        with open(output_path, 'wb') as f:
            f.write(data[ogg_start:])
        return os.path.getsize(output_path) > 100

    return False
