"""
lib/gp2rs_gpx.py — Guitar Pro 6 (.gpx) support shim for gp2rs.

Drop this file into feedBack/lib/ alongside gp2rs.py.
No third-party dependencies — pure Python stdlib only.

Public API mirrors the two functions that the editor plugin calls:
    list_tracks(gp_path)          -> list[dict]
    convert_file(gp_path, ...)    -> list[str]

Both are called transparently by gp2rs.py when the file extension is .gpx.
Do not call this module directly; use gp2rs.list_tracks / gp2rs.convert_file.
"""

import logging
import re
import struct
import xml.etree.ElementTree as ET
from pathlib import Path

from safepath import safe_join

_log = logging.getLogger("feedBack.lib.gp2rs_gpx")


def _safe_filename_stem(name: str) -> str:
    """Filesystem-safe stem from an untrusted (GPX-supplied) track name.

    Track names come from an arbitrary user-uploaded file, so they may contain
    path separators (``/`` or ``\\``), ``..``, colons, etc. Collapse anything
    outside ``[A-Za-z0-9._-]`` to ``_`` and strip leading/trailing dots/dashes
    so the result can't traverse out of the output directory on any platform.
    """
    s = re.sub(r'[^A-Za-z0-9._-]+', '_', name or '').strip('._-')
    return s or 'track'

# Hard cap on the BCFZ-declared decompressed size. The size comes from a
# 32-bit field in an attacker-controllable upload; without a cap a crafted
# file could declare a multi-GB target and exhaust memory. Real GPX payloads
# are small (the November Rain example expands to ~1.4 MB); 64 MB is generous.
_GPX_MAX_DECOMPRESSED = 64 * 1024 * 1024

# ---------------------------------------------------------------------------
# GPX container parsing (BCFZ/BCFS)
# Identical to gpx_parser.py — duplicated here so lib/ is self-contained.
# ---------------------------------------------------------------------------

def _decompress_bcfz(raw: bytes) -> bytes:
    if raw[:4] != b'BCFZ':
        raise ValueError(f"Expected BCFZ magic, got {raw[:4]!r}")
    src = raw[4:]
    n = len(src)
    pos = 0; current_byte = 0; bit_pos = 8

    def _read_bit():
        nonlocal pos, current_byte, bit_pos
        if bit_pos >= 8:
            if pos >= n: raise EOFError()
            current_byte = src[pos]; pos += 1; bit_pos = 0
        val = (current_byte >> (7 - bit_pos)) & 1; bit_pos += 1; return val

    def _rb(count):
        v = 0
        for i in range(count - 1, -1, -1): v |= _read_bit() << i
        return v

    def _rr(count):
        v = 0
        for i in range(count): v |= _read_bit() << i
        return v

    lb = bytes(_rb(8) & 0xFF for _ in range(4))
    expected = struct.unpack_from('<I', lb)[0]
    if expected > _GPX_MAX_DECOMPRESSED:
        raise ValueError(
            f"GPX declares implausible decompressed size {expected} bytes "
            f"(> {_GPX_MAX_DECOMPRESSED} cap); refusing to decompress"
        )
    out = bytearray()
    try:
        while len(out) < expected:
            if _rb(1):
                ws = _rb(4); off = _rr(ws); sz = _rr(ws)
                sp = len(out) - off
                for i in range(min(off, sz)): out.append(out[sp + i])
            else:
                sz = _rr(2)
                for _ in range(sz): out.append(_rb(8) & 0xFF)
    except EOFError:
        pass
    return bytes(out)


def _parse_bcfs(bcfs: bytes) -> dict:
    if bcfs[:4] != b'BCFS':
        raise ValueError(f"Expected BCFS magic, got {bcfs[:4]!r}")
    HDR = 4; data = bcfs; SECTOR = 0x1000
    # A file can't reference more sectors than the container physically holds;
    # cap the sector-pointer walk so a malformed/crafted chain that never
    # yields a 0 terminator can't loop unbounded and exhaust memory.
    max_sectors = (len(data) // SECTOR) + 1

    def _gi(off):
        # Bounds-check every 4-byte read so a truncated/crafted file raises a
        # clean ValueError instead of leaking struct.error / IndexError.
        if off < 0 or HDR + off + 4 > len(data):
            raise ValueError("GPX BCFS read past end of container (malformed file)")
        return struct.unpack_from('<I', data, HDR + off)[0]
    def _gs(off, ml):
        base = HDR + off; end = base
        limit = min(base + ml, len(data))
        while end < limit and data[end] != 0: end += 1
        return data[base:end].decode('utf-8', errors='replace')

    files: dict = {}
    offset = SECTOR
    while HDR + offset + 4 <= len(data):
        if _gi(offset) == 2:
            fn = _gs(offset + 0x04, 127); fs = _gi(offset + 0x8C)
            po = offset + 0x94; sc = 0; fb = bytearray()
            while sc <= max_sectors:
                s = _gi(po + 4 * sc); sc += 1
                if s == 0: break
                so = s * SECTOR
                if HDR + so + SECTOR > len(data):
                    raise ValueError("GPX BCFS sector pointer out of range (malformed file)")
                fb.extend(data[HDR + so: HDR + so + SECTOR])
            else:
                raise ValueError("GPX BCFS sector chain too long (malformed file)")
            files[fn] = bytes(fb[:fs])
        offset += SECTOR
    return files


def _load_gpif(gp_path: str) -> ET.Element:
    """Load and parse score.gpif from a .gpx (GP6) or .gp (GP7/GP8) file.

    GP6 (.gpx): custom BCFZ/BCFS binary container holding score.gpif.
    GP7/GP8 (.gp): standard ZIP archive holding Content/score.gpif.
    Both formats use the same GPIF XML schema inside, so a single parser
    handles all versions once the outer container is unpacked.
    """
    with open(gp_path, 'rb') as fh:
        raw = fh.read()

    # GP7/GP8: ZIP container (PK magic)
    if raw[:2] == b'PK':
        import zipfile
        import io as _io
        with zipfile.ZipFile(_io.BytesIO(raw)) as zf:
            if 'Content/score.gpif' not in zf.namelist():
                raise ValueError("Content/score.gpif not found in GP7/GP8 ZIP container")
            return ET.fromstring(zf.read('Content/score.gpif'))

    # GP6 (.gpx): BCFZ compressed or raw BCFS
    if raw[:4] == b'BCFZ':
        bcfs = _decompress_bcfz(raw)
    elif raw[:4] == b'BCFS':
        bcfs = raw
    else:
        raise ValueError(
            f"Unrecognised Guitar Pro container (magic: {raw[:4]!r}). "
            f"Supported: .gpx (GP6, BCFZ/BCFS) and .gp (GP7/GP8, ZIP)."
        )
    fs = _parse_bcfs(bcfs)
    if 'score.gpif' not in fs:
        raise ValueError("score.gpif not found in GPX container")
    return ET.fromstring(fs['score.gpif'])


# ---------------------------------------------------------------------------
# GPIF helpers
# ---------------------------------------------------------------------------

# GPX NoteValue string -> quarter-note multiplier
_NOTE_VALUE_QN = {
    'Whole': 4.0, 'Half': 2.0, 'Quarter': 1.0, 'Eighth': 0.5,
    '16th': 0.25, '32nd': 0.125, '64th': 0.0625, '128th': 0.03125,
}

# Diatonic step index (0=C) -> semitone offset
_STEP_TO_SEMI = [0, 2, 4, 5, 7, 9, 11]  # C D E F G A B


def _gpif_tempo(root: ET.Element) -> float:
    """Return the first Tempo automation value from MasterTrack.

    GPX stores tempo as e.g. "72 2" where the second token is an internal
    interpolation flag. Only the first token is the BPM value.
    """
    mt = root.find('MasterTrack')
    if mt is not None:
        for auto in mt.findall('.//Automations/*'):
            if auto.findtext('Type') == 'Tempo':
                raw = (auto.findtext('Value') or '').strip()
                try:
                    return float(raw.split()[0])
                except (ValueError, TypeError, IndexError):
                    pass
    return 120.0


def _build_tempo_map(root: ET.Element) -> list[tuple[int, float]]:
    """
    Build a bar-indexed tempo map from all Tempo automations on MasterTrack.

    Returns a list of (bar_index, bpm) sorted by bar_index. The map is used
    by convert_file() to step through bars at the correct tempo, which is
    critical for songs with multiple tempo changes (e.g. Bohemian Rhapsody
    goes from 72 -> 144 -> gradual slowdown to 32 BPM).

    GPX tempo Value format: "72 2" — first token = BPM, second = interpolation flag.
    """
    events: list[tuple[int, float]] = []
    mt = root.find('MasterTrack')
    if mt is not None:
        for auto in mt.findall('.//Automations/*'):
            if auto.findtext('Type') == 'Tempo':
                try:
                    bar = int(auto.findtext('Bar') or 0)
                    raw = (auto.findtext('Value') or '').strip()
                    bpm = float(raw.split()[0])
                    events.append((bar, bpm))
                except (ValueError, TypeError, IndexError):
                    pass
    events.sort(key=lambda e: e[0])
    if not events:
        events = [(0, 120.0)]
    return events


def _gpif_tracks(root: ET.Element) -> list[dict]:
    """Return a list of raw track dicts from the GPIF Tracks element."""
    # Lookups for per-track note counting. MasterBar/Bars lists one bar id per
    # track in raw Tracks order, so the enumerate index below (which counts
    # skipped pseudo-tracks) is the correct bar-lookup index — same mapping
    # convert_file uses via filtered_to_raw.
    _masterbars = list(root.find('MasterBars') or [])
    _bars_by_id = {b.get('id'): b for b in (root.find('Bars') or [])}
    _voices_by_id = {v.get('id'): v for v in (root.find('Voices') or [])}
    _beats_by_id = {b.get('id'): b for b in (root.find('Beats') or [])}

    def _note_count_for_raw(raw_idx: int) -> int:
        # Total note count for the track (sum of notes across all its beats).
        # This is the single source of truth: list_tracks surfaces it as the
        # 'notes' field, and _auto_select_gpx uses (count == 0) to skip empty
        # tracks — so the graph is walked once here, not again in list_tracks.
        n = 0
        for mb in _masterbars:
            bar_ids = mb.findtext('Bars', '').split()
            if raw_idx >= len(bar_ids):
                continue
            bar = _bars_by_id.get(bar_ids[raw_idx])
            if bar is None:
                continue
            for vid in bar.findtext('Voices', '').split():
                if vid == '-1':
                    continue
                voice = _voices_by_id.get(vid)
                if voice is None:
                    continue
                for bid in voice.findtext('Beats', '').split():
                    beat = _beats_by_id.get(bid)
                    if beat is None:
                        continue
                    notes_text = beat.findtext('Notes', '').strip()
                    if notes_text:
                        n += len(notes_text.split())
        return n

    result = []
    for raw_idx, t in enumerate(root.find('Tracks') or []):
        name = (t.findtext('Name') or '').strip()
        if name.startswith('@$') and name.endswith('$@'):
            continue  # GP internal pseudo-tracks (raw_idx still advances)

        gm = t.find('GeneralMidi')
        midi_program = 0
        midi_channel = 0
        is_drums = False
        if gm is not None:
            # GP6 (.gpx): <GeneralMidi table="Percussion"><Program>...</Program>
            try: midi_program = int(gm.findtext('Program') or 0)
            except (ValueError, TypeError): pass
            try:
                ch = int(gm.findtext('PrimaryChannel') or 0)
                midi_channel = ch
                if ch == 9: is_drums = True
            except (ValueError, TypeError): pass
            if gm.get('table') == 'Percussion':
                is_drums = True
        else:
            # GP7/GP8 (.gp): <InstrumentSet><Type>drumKit</Type>
            # and <MidiConnection><PrimaryChannel>9</PrimaryChannel>
            inst_set = t.find('InstrumentSet')
            if inst_set is not None:
                inst_type = (inst_set.findtext('Type') or '').lower()
                if inst_type == 'drumkit':
                    is_drums = True
            midi_conn = t.find('MidiConnection')
            if midi_conn is not None:
                try:
                    ch_text = (midi_conn.findtext('PrimaryChannel') or '').strip()
                    if ch_text:
                        ch = int(ch_text)
                        midi_channel = ch
                        if ch == 9:
                            is_drums = True
                except (ValueError, TypeError):
                    pass

        # String tuning
        string_pitches: list[int] = []
        for prop in t.findall('.//Property'):
            if prop.get('name') == 'Tuning':
                pe = prop.find('Pitches')
                if pe is not None and pe.text:
                    try:
                        string_pitches = [int(p) for p in pe.text.split()]
                    except ValueError:
                        pass

        result.append({
            '_el': t,
            'id': t.get('id', ''),
            'name': name,
            'string_pitches': string_pitches,
            'is_drums': is_drums,
            'midi_program': midi_program,
            'midi_channel': midi_channel,
            'note_count': _note_count_for_raw(raw_idx),
        })
    return result


def _beat_dur_secs(beat_el: ET.Element, rhythms_dict: dict, tempo_bpm: float) -> float:
    """Return the duration of a beat in seconds."""
    rref = beat_el.find('Rhythm')
    dur_qn = 0.25
    if rref is not None:
        rhythm = rhythms_dict.get(rref.get('ref', ''))
        if rhythm is not None:
            nv = rhythm.findtext('NoteValue', 'Quarter')
            dur_qn = _NOTE_VALUE_QN.get(nv, 0.25)
            if rhythm.find('AugmentationDot') is not None:
                dur_qn *= 1.5
            # Tuplets
            tuplet = rhythm.find('PrimaryTuplet')
            if tuplet is not None:
                try:
                    num = int(tuplet.get('num', 1))
                    den = int(tuplet.get('den', 1))
                    if num and den:
                        dur_qn *= den / num
                except (TypeError, ValueError):
                    pass
    return dur_qn * (60.0 / tempo_bpm)


# ---------------------------------------------------------------------------
# Drum encoding tables — ported from alphaTab PercussionMapper (MIT licensed)
# ---------------------------------------------------------------------------

# GP6 Element+Variation -> articulation ID
# _GP6_EV[element][variation] = articulation_id
# Source: alphaTab PercussionMapper._gp6ElementAndVariationToArticulation
_GP6_EV: list[list[int]] = [
    [35, 35, 35],    # [0]  Kick (hit, -, -)
    [38, 91, 37],    # [1]  Snare (hit, rim shot, side stick)
    [99, 100, 99],   # [2]  Cowbell low (hit, tip, -)
    [56, 100, 56],   # [3]  Cowbell medium (hit, tip, -)
    [102, 103, 102], # [4]  Cowbell high (hit, tip, -)
    [43, 43, 43],    # [5]  Tom very low (hit, -, -)
    [45, 45, 45],    # [6]  Tom low (hit, -, -)
    [47, 47, 47],    # [7]  Tom medium (hit, -, -)
    [48, 48, 48],    # [8]  Tom high (hit, -, -)
    [50, 50, 50],    # [9]  Tom very high (hit, -, -)
    [42, 92, 46],    # [10] Hihat (closed, half, open)
    [44, 44, 44],    # [11] Pedal hihat (hit, -, -)
    [57, 98, 57],    # [12] Crash medium (hit, choke, -)
    [49, 97, 49],    # [13] Crash high (hit, choke, -)
    [55, 95, 55],    # [14] Splash (hit, choke, -)
    [51, 93, 127],   # [15] Ride (middle, edge, bell)
    [52, 96, 52],    # [16] China (hit, choke, -)
]

# Articulation IDs that differ from their MIDI output note.
# Most IDs equal the MIDI note; only the non-standard ones are listed here.
# Source: alphaTab InstrumentArticulation.create(uniqueId, name, staffLine, outputMidi, ...)
_ART_TO_MIDI: dict[int, int] = {
    91: 38,   # Snare rim shot       -> snare (38)
    92: 46,   # Hihat half-open      -> open hihat (46)
    93: 51,   # Ride edge            -> ride (51)
    94: 51,   # Ride choke           -> ride (51)
    95: 55,   # Splash choke         -> splash (55)
    96: 52,   # China choke          -> china (52)
    97: 49,   # Crash high choke     -> crash (49)
    98: 57,   # Crash medium choke   -> crash 2 (57)
    99: 56,   # Cowbell low hit      -> cowbell (56)
    100: 56,  # Cowbell low tip      -> cowbell (56)
    101: 56,  # Cowbell medium tip   -> cowbell (56)
    102: 56,  # Cowbell high hit     -> cowbell (56)
    103: 56,  # Cowbell high tip     -> cowbell (56)
    104: 60,  # Bongo high mute      -> bongo high (60)
    105: 60,  # Bongo high slap      -> bongo high (60)
    106: 61,  # Bongo low mute       -> bongo low (61)
    107: 61,  # Bongo low slap       -> bongo low (61)
    108: 64,  # Conga low slap       -> conga low (64)
    109: 64,  # Conga low mute       -> conga low (64)
    110: 63,  # Conga high slap      -> conga high (63)
    111: 54,  # Tambourine return    -> tambourine (54)
    112: 54,  # Tambourine roll      -> tambourine (54)
    113: 54,  # Tambourine hand      -> tambourine (54)
    114: 43,  # Grancassa            -> tom very low (43)
    115: 49,  # Piatti hit           -> crash (49)
    116: 49,  # Piatti hand          -> crash (49)
    117: 69,  # Cabasa return        -> cabasa (69)
    118: 70,  # Left maraca return   -> maraca (70)
    119: 70,  # Right maraca hit     -> maraca (70)
    120: 70,  # Right maraca return  -> maraca (70)
    122: 82,  # Shaker return        -> shaker (82)
    123: 53,  # Bell tree return     -> ride bell (53)
    124: 62,  # Golpe thumb          -> conga high mute (62)
    125: 62,  # Golpe finger         -> conga high mute (62)
    126: 59,  # Ride cymbal 2 mid    -> ride 2 (59)
    127: 59,  # Ride bell            -> ride 2 (59)
}

# GP5 special fret->MIDI overrides (only 5 non-GM entries; all others are fret==MIDI)
# Source: alphaTab Gp3To5Importer._gp5PercussionInstrumentMap
_GP5_SPECIAL: dict[int, int] = {27: 42, 28: 60, 29: 29, 30: 30, 32: 31}


def _gp6_element_variation_to_midi(element: int, variation: int) -> int | None:
    """
    Convert a GP6 Element+Variation pair to a MIDI percussion note number.

    This is the primary drum encoding in all GPX (Guitar Pro 6) files.
    Ported from alphaTab PercussionMapper.articulationFromElementVariation().
    """
    if element < 0 or element >= len(_GP6_EV):
        return None  # Unknown element — silently skip
    var = min(max(variation, 0), len(_GP6_EV[element]) - 1)
    art_id = _GP6_EV[element][var]
    return _ART_TO_MIDI.get(art_id, art_id)


# GPIF chord-diagram <Position finger="..."> names → RS finger integers,
# matching the editor (E1) + gp2rs/pyguitarpro convention:
# open/unused = -1, thumb = 0, index = 1, middle = 2, ring = 3, pinky = 4.
_GPIF_FINGER_MAP = {
    'none': -1, 'open': -1, '': -1,
    'thumb': 0,
    'index': 1,
    'middle': 2,
    'ring': 3, 'annular': 3,
    'pinky': 4, 'little': 4,
}

# Per-note <LeftFingering> teaching mark (§6.2.2). Unlike the chord-diagram
# <Position finger=".."> path above, GPIF stores a single note's fret-hand
# finger as a direct <Note> child element with the classical p-i-m-a-c letter
# codes (verified against GP8 exports), mapped to the same RS finger integers
# (open = -1, thumb = 0, index = 1, middle = 2, annular/ring = 3, little = 4).
_GPIF_LEFT_FINGERING_MAP = {
    'open': -1, 'none': -1, '': -1,
    'p': 0, 'thumb': 0,
    'i': 1, 'index': 1,
    'm': 2, 'middle': 2,
    'a': 3, 'annular': 3, 'ring': 3,
    'c': 4, 'little': 4, 'pinky': 4,
}


def _gpif_left_fingering(note_el) -> int:
    """Read a GPIF <Note>'s fret-hand finger (<LeftFingering>) -> RS finger int.

    Returns -1 (unset) when absent or unrecognised — never fabricates a finger.
    Teaching mark only (§6.2.2); never used for grading."""
    raw = (note_el.findtext('LeftFingering') or '').strip().lower()
    if not raw:
        return -1
    return _GPIF_LEFT_FINGERING_MAP.get(raw, -1)


def _rs_string_order(string_pitches: list[int]) -> dict[int, int]:
    """Map each GPIF string index → RS string index (0 = lowest pitch).

    Mirrors the per-note transform in ``convert_file`` (sort GPIF string
    indices by open pitch ascending, tiebreak on index, use the rank), so a
    chord diagram's string indices land on the same RS strings as the played
    notes regardless of format direction (GP6 .gpx high→low, GP8 .gp low→high).
    """
    order = sorted(range(len(string_pitches)),
                   key=lambda i: (string_pitches[i], i))
    return {gp: rs for rs, gp in enumerate(order)}


def _parse_chord_diagrams(track_el, string_pitches: list[int]) -> dict:
    """Map fret-pattern tuple → ``{'name', 'fingers'}`` from a track's diagrams.

    GP7/GP8 GPIF stores authored chord diagrams per track under
    ``Properties/Property[@name="DiagramCollection"]/Items/Item``. Each Item
    carries the chord name (its ``name`` attribute) and a ``<Diagram>`` with
    per-string ``<Fret string=.. fret=..>`` plus
    ``<Fingering><Position finger=.. string=..></Fingering>``. Diagram string
    indices share the positional space of note ``String`` indices, so they go
    through the same pitch-rank transform; ``<Fret fret>`` is the absolute fret
    (``baseFret`` is display-only and not applied).

    Keying by fret pattern (width-normalised to ≥6, exactly like the template
    build site) keeps the join key consistent with GP5 + the editor's
    preserve-by-fret-key (E0). Returns ``{}`` when there are no diagrams or no
    string tuning (orientation/width would be undefined).
    """
    diagrams: dict[tuple, dict] = {}
    if track_el is None or not string_pitches:
        return diagrams
    gp_to_rs = _rs_string_order(string_pitches)
    for item in track_el.findall(
            './/Property[@name="DiagramCollection"]/Items/Item'):
        diag = item.find('Diagram')
        if diag is None:
            continue
        rs_frets: dict[int, int] = {}
        for fr in diag.findall('Fret'):
            try:
                gp = int(fr.get('string'))
                fret = int(fr.get('fret'))
            except (TypeError, ValueError):
                continue
            if fret < 0:
                continue
            rs = gp_to_rs.get(gp)
            if rs is not None:
                rs_frets[rs] = fret
        if not rs_frets:
            continue
        width = max(6, max(rs_frets) + 1)
        frets = [-1] * width
        fingers = [-1] * width
        for rs, fret in rs_frets.items():
            frets[rs] = fret
        for pos in diag.findall('Fingering/Position'):
            try:
                gp = int(pos.get('string'))
            except (TypeError, ValueError):
                continue
            rs = gp_to_rs.get(gp)
            if rs is None or not (0 <= rs < width) or frets[rs] < 0:
                continue
            fname = (pos.get('finger') or '').strip().lower()
            fingers[rs] = _GPIF_FINGER_MAP.get(fname, -1)
        # First diagram wins for a given voicing (stable, deterministic).
        diagrams.setdefault(tuple(frets),
                            {'name': item.get('name', '') or '', 'fingers': fingers})
    return diagrams


def _gpx_percussion_midis(track_el) -> list[int]:
    """Flatten a drumKit ``InstrumentSet``'s articulations into a list of GM
    ``OutputMidiNumber``s, positionally indexed to match a note's
    ``<InstrumentArticulation>`` value.

    GP7/GP8 percussion notes carry the drum piece as a direct
    ``<InstrumentArticulation>N</InstrumentArticulation>`` child of ``<Note>``,
    where N is the 0-based index into the track's InstrumentSet articulation
    list (flattened across Elements in document order). Returns ``[]`` when the
    track has no percussion InstrumentSet. Unparseable entries become ``-1`` so
    indices stay aligned (``midi_to_piece(-1)`` is ``None`` → skipped).
    """
    out: list[int] = []
    iset = track_el.find('InstrumentSet') if track_el is not None else None
    if iset is None:
        return out
    elements = iset.find('Elements')
    if elements is None:
        return out
    for el in elements:
        arts = el.find('Articulations')
        if arts is None:
            continue
        for art in arts:
            try:
                out.append(int(art.findtext('OutputMidiNumber')))
            except (TypeError, ValueError):
                out.append(-1)
    return out


def _note_midi(note_el: ET.Element, string_pitches: list[int],
               perc_midis: list[int] | None = None) -> int | None:
    """
    Extract MIDI note number from a GPIF <Note> element.

    Handles all encoding variants found in Guitar Pro files:

    0. InstrumentArticulation child  (GP7/GP8 drums — primary encoding)
       The drum piece is a direct ``<InstrumentArticulation>`` child of the
       note: a positional index into the track's InstrumentSet articulation
       list. `perc_midis` (from `_gpx_percussion_midis`) maps that index to the
       GM OutputMidiNumber. This is the real GP8 percussion encoding — without
       it every drum note decodes to None and the whole drum track drops.

    1. Element + Variation  (GPX / GP6 drums — primary encoding)
       All GPX percussion tracks use this. The Element index selects the drum
       piece; Variation selects the articulation (e.g. open vs closed hi-hat).

    2. String + Fret  (guitar/bass, and some GPX pitched tracks)
       String is 0-based from the highest string. Pitch = string_pitches[idx] + fret.
       Also used for guitar-model vocal tracks and some piano tabs (string_pitches
       must be present and in descending MIDI order, high string first).

    3. Tone + Octave  (GPX melodic/piano tracks — diatonic step encoding)
       Step is an integer 0–6 (C=0 … B=6). MIDI = (octave+1)*12 + semitone.

    4. InstrumentArticulation index  (GP7 primary encoding, rare in GPX)
       A direct index into the track's percussionArticulations list. Not used
       in GP6 files; handled here as a best-effort fallback using the standard
       GM percussion table.
    """
    # ── Encoding 0: percussion InstrumentArticulation child (GP7/GP8) ────
    # A direct <InstrumentArticulation> child (NOT a Property) indexes into the
    # track's InstrumentSet articulation list — resolve via `perc_midis`.
    if perc_midis:
        _ia = note_el.find('InstrumentArticulation')
        if _ia is not None and _ia.text and _ia.text.strip().lstrip('-').isdigit():
            # GP8 drumKit notes carry the authoritative GM percussion number in
            # a <Property name="Midi"><Number>…</Number></Property> child.
            # Prefer it: some exports pin InstrumentArticulation at 0 for EVERY
            # note (a generic/unused kit articulation list), so resolving via
            # perc_midis[idx] would collapse the whole track to one piece (the
            # idx-0 articulation). The Midi property equals the articulation's
            # OutputMidiNumber in well-formed files and is the real pitch when
            # the articulation index is uninformative — so it's safe either way.
            for _p in note_el.findall('.//Property'):
                if _p.get('name') == 'Midi':
                    _num = _p.find('Number')
                    if (_num is not None and _num.text
                            and _num.text.strip().lstrip('-').isdigit()):
                        _mv = int(_num.text.strip())
                        return _mv if _mv >= 0 else None
                    break
            _idx = int(_ia.text.strip())
            if 0 <= _idx < len(perc_midis):
                _m = perc_midis[_idx]
                # `_gpx_percussion_midis` stores -1 for an articulation whose
                # OutputMidiNumber was missing/unparseable; treat that as "no
                # note" rather than emitting an invalid RS note (string=-1).
                return _m if _m >= 0 else None
            return None

    props = {p.get('name'): p for p in note_el.findall('.//Property')}

    # ── Encoding 1: Element + Variation (GPX drums) ──────────────────────
    if 'Element' in props:
        try:
            element = int(props['Element'].findtext('Element') or 0)
            variation = int((props.get('Variation') or ET.Element('x')).findtext('Variation') or 0)
            return _gp6_element_variation_to_midi(element, variation)
        except (ValueError, TypeError):
            return None

    # ── Encoding 2: String + Fret (guitar/bass/vocal/some piano) ─────────
    if 'String' in props and 'Fret' in props:
        try:
            str_idx = int(props['String'].findtext('String') or 0)
            fret = int(props['Fret'].findtext('Fret') or 0)
            if string_pitches:
                # GP6 String index 0 = highest string, and string_pitches is
                # stored high→low (index 0 = highest) — the same ordering
                # _gpx_tuning relies on. So index directly by str_idx; an
                # earlier reverse (n-1-str_idx) transposed every String+Fret
                # note to the wrong string's pitch.
                if 0 <= str_idx < len(string_pitches):
                    return string_pitches[str_idx] + fret
            return None
        except (ValueError, TypeError):
            return None

    # ── Encoding 3: Tone + Octave (GPX melodic/piano) ────────────────────
    if 'Tone' in props and 'Octave' in props:
        try:
            step = int(props['Tone'].findtext('Step') or 0)
            octave = int(props['Octave'].findtext('Number') or 4)
            semi = _STEP_TO_SEMI[step % 7]
            return (octave + 1) * 12 + semi  # C4 = MIDI 60
        except (ValueError, TypeError, IndexError):
            return None

    # ── Encoding 4: InstrumentArticulation index (GP7 fallback) ──────────
    if 'InstrumentArticulation' in props:
        try:
            art_id = int(props['InstrumentArticulation'].findtext('InstrumentArticulation') or 0)
            # art_id is usually the MIDI note number directly for standard GM kit
            return _ART_TO_MIDI.get(art_id, art_id)
        except (ValueError, TypeError):
            return None

    return None


def _note_is_tie(note_el: ET.Element) -> bool:
    """True if this note is a tied continuation (destination tie)."""
    tie = note_el.find('Tie')
    if tie is None:
        return False
    # GP6 XML: <Tie origin="true"> on the first note, <Tie destination="true"> on the tied
    return tie.get('destination', '').lower() in ('true', '1')


def _note_has_vibrato(note_el: ET.Element, prop_map: dict) -> bool:
    """True if a GP7/GP8 note carries fretting-hand vibrato.

    GP7/GP8 encodes note vibrato as a DIRECT ``<Vibrato>Slight|Wide</Vibrato>``
    child of ``<Note>`` — NOT a ``<Property>`` — so the property map alone never
    matched it and note vibrato was silently dropped. Check the direct element
    as well as (defensively) a ``<Property name="Vibrato">`` in ``prop_map``.
    Whammy-bar ``VibratoWTremBar`` is a separate beat-level Property handled
    elsewhere.
    """
    return 'Vibrato' in prop_map or note_el.find('Vibrato') is not None


def _beat_has_tremolo(beat_el: ET.Element) -> bool:
    """True if a GP7/GP8 beat carries tremolo picking.

    GPIF encodes tremolo picking as a DIRECT beat-level
    ``<Tremolo>1/8</Tremolo>`` child of ``<Beat>`` (the value is the rate). The
    RS note model has a single boolean tremolo flag with no rate, so the rate is
    intentionally ignored — any tremolo-picked beat maps to note tremolo across
    it. Matched as a direct child (not ``.//``) so it is never confused with the
    whammy-bar ``VibratoWTremBar`` Property, a separate beat-level effect
    handled elsewhere.
    """
    return beat_el.find('Tremolo') is not None


# ---------------------------------------------------------------------------
# list_tracks — mirrors gp2rs.list_tracks interface
# ---------------------------------------------------------------------------

def list_tracks(gp_path: str) -> list[dict]:
    """List all tracks in a .gpx file with basic info for the editor UI."""
    root = _load_gpif(gp_path)
    tracks = _gpif_tracks(root)
    # Note counts are computed once in _gpif_tracks ('note_count'); reuse them
    # here instead of walking the bar/voice/beat graph a second time.

    result = []
    for i, t in enumerate(tracks):
        is_bass = bool(
            not t['is_drums']  # drums always have low/zero string pitches — must exclude
            and (
                (
                    not t['string_pitches']  # no string tuning = not guitar-family
                    and 32 <= t['midi_program'] <= 39
                ) or (
                    t['string_pitches']
                    and max(t['string_pitches']) <= 48  # bass top string ≤ C3
                )
            )
        )
        is_piano = (
            not t['is_drums']
            and not t['string_pitches']
            and t['midi_program'] in set(range(0, 8)) | set(range(16, 24)) | {80, 81, 82, 83}
        ) or (
            not t['is_drums']
            and any(kw in t['name'].lower() for kw in ('piano', 'keys', 'keyboard', 'organ'))
        )

        is_vocal = _is_vocal_track(t)

        result.append({
            'index': i,
            'name': t['name'],
            'strings': len(t['string_pitches']),
            'is_percussion': t['is_drums'],
            'is_piano': is_piano,
            'is_drums': t['is_drums'],
            'is_bass': is_bass,
            'is_vocal': is_vocal,
            'instrument': t['midi_program'],
            'notes': t['note_count'],
        })
    return result


# ---------------------------------------------------------------------------
# convert_file — mirrors gp2rs.convert_file interface
# Converts GPX tracks directly to arrangement XML, reusing gp2rs._build_xml
# ---------------------------------------------------------------------------



def _find_piano_pairs(
    track_indices: list[int],
    tracks: list[dict],
    names: dict[int, str],
) -> tuple[list[int], dict[int, int]]:
    """
    Detect Piano LH/RH track pairs and return a merge map.

    Guitar Pro 6 models piano tracks on guitar/bass string templates (no native
    keyboard type). A typical GPX piano part has two tracks — e.g. "Piano RH"
    (7-string guitar, treble range) and "Piano LH" (5-string bass, bass range).
    Importing them separately gives two Keys arrangements shown one at a time.
    Merging them gives a single full-width Synthesia-style chart in the piano
    highway, with both hands falling onto the correct keys simultaneously.

    Detection: among the keys tracks being imported, find pairs where both share
    a common stem and one name ends in 'rh' and the other in 'lh'
    (case-insensitive, word-boundary matched).

    Returns:
        filtered_indices — track_indices with LH tracks removed (consumed by merge)
        merge_map        — {rh_track_idx: lh_track_idx}
    """
    keys_tracks = [
        i for i in track_indices
        if 0 <= i < len(tracks)
        and (
            any(kw in tracks[i]['name'].lower()
                for kw in ('piano', 'keys', 'keyboard'))
            or names.get(i, '').lower().startswith('keys')
        )
    ]

    merge_map: dict[int, int] = {}
    consumed: set[int] = set()

    for i in keys_tracks:
        if i in consumed:
            continue
        low_i = tracks[i]['name'].strip().lower()
        if not re.search(r'\brh\b', low_i):
            continue
        stem = re.sub(r'\s*\brh\b\s*$', '', low_i).strip()
        for j in keys_tracks:
            if j == i or j in consumed:
                continue
            low_j = tracks[j]['name'].strip().lower()
            if not re.search(r'\blh\b', low_j):
                continue
            stem_j = re.sub(r'\s*\blh\b\s*$', '', low_j).strip()
            if stem_j == stem:
                merge_map[i] = j
                consumed.add(j)
                break

    filtered = [i for i in track_indices if i not in consumed]
    return filtered, merge_map



def _collect_tone_events(
    raw_idx: int,
    masterbars: list,
    bars_by_id: dict,
    voices_dict: dict,
    beats_dict: dict,
    rhythms_dict: dict,
    tempo_map: list,
    audio_offset: float,
    *,
    tempo_bpm: float = 120.0,
) -> list[tuple[float, str]]:
    """
    Extract tone change events for one track from its beat-level <Bank> elements.

    Guitar Pro 6 stores the active RSE sound preset name as a <Bank> child on
    the first beat of any bar where the sound is set or changes. We deduplicate
    consecutive identical names so only genuine transitions are emitted.

    Returns a list of (time_secs, bank_name) pairs, sorted by time, with
    audio_offset applied. Empty list if the track has no Bank elements.
    """
    current_time = 0.0
    events: list[tuple[float, str]] = []

    tempo_iter = iter(tempo_map)
    next_tempo_bar, next_tempo_bpm = next(tempo_iter, (999999, 120.0))
    # Start at the song's base tempo (same as convert_file's note builder); the
    # per-bar loop applies each tempo change once its bar index is reached.
    # Seeding from tempo_map[0] would wrongly apply a first tempo event that
    # begins at a later bar to the bars before it, and hardcoding 120 would
    # drift tone timestamps off the note timeline when the base tempo isn't 120.
    cur_tempo = tempo_bpm

    for mb_idx, mb in enumerate(masterbars):
        # Advance tempo
        while mb_idx >= next_tempo_bar:
            cur_tempo = next_tempo_bpm
            next_tempo_bar, next_tempo_bpm = next(tempo_iter, (999999, cur_tempo))

        time_sig = mb.findtext('Time', '4/4')
        try:
            num_b, den_b = [int(x) for x in time_sig.split('/')]
        except ValueError:
            num_b, den_b = 4, 4
        bar_duration = num_b * (4.0 / den_b) * (60.0 / cur_tempo)

        bar_ids = mb.findtext('Bars', '').split()
        bid = bar_ids[raw_idx] if raw_idx < len(bar_ids) else '-1'

        if bid != '-1' and bid:
            bar = bars_by_id.get(bid)
            if bar is not None:
                for vid in bar.findtext('Voices', '').split():
                    if vid == '-1':
                        continue
                    voice = voices_dict.get(vid)
                    if voice is None:
                        continue
                    voice_time = current_time
                    for beat_id in voice.findtext('Beats', '').split():
                        beat_el = beats_dict.get(beat_id)
                        if beat_el is None:
                            continue
                        dur = _beat_dur_secs(beat_el, rhythms_dict, cur_tempo)
                        bank = (beat_el.findtext('Bank') or '').strip()
                        if bank:
                            events.append((round(voice_time + audio_offset, 3), bank))
                        voice_time += dur

        current_time += bar_duration

    # Sort by time first, THEN drop consecutive duplicates. Multi-voice bars
    # reset voice_time per voice so traversal order isn't chronological;
    # deduping during traversal could drop an earlier-in-time tone change in a
    # later-traversed voice. Collapsing only after sorting keeps the earliest
    # change for each transition.
    events.sort(key=lambda e: e[0])
    deduped: list[tuple[float, str]] = []
    for ev in events:
        if not deduped or ev[1] != deduped[-1][1]:
            deduped.append(ev)
    return deduped



def _inject_tones(xml_str: str, tone_events: list[tuple[float, str]]) -> str:
    """
    Inject a <tones> element into a chart arrangement XML string.

    Parses the prettified XML returned by _build_xml, inserts the tones
    block before </song>, and re-serialises. Noop if tone_events is empty.

    Each entry in tone_events is (time_secs, name). Consecutive duplicates
    are already removed by _collect_tone_events; here we assign sequential
    integer IDs as required by the RS schema.
    """
    if not tone_events:
        return xml_str

    import xml.etree.ElementTree as _ET
    from xml.dom import minidom as _minidom

    try:
        root = _ET.fromstring(xml_str)
    except _ET.ParseError:
        return xml_str  # don't corrupt XML on parse failure

    # Record the initial tone as <tonebase> (unless one already exists) so tone
    # extraction (lib/tones.py::_xml_tone_changes) and loose-XML playback know
    # the base tone instead of leaving it empty.
    _base_el = root.find('tonebase')
    if _base_el is None:
        _ET.SubElement(root, 'tonebase').text = tone_events[0][1]
    elif not (_base_el.text or '').strip():
        # Populate an empty/whitespace <tonebase> too — leaving it blank would
        # defeat the point of recording the base tone. A non-empty existing
        # base is preserved.
        _base_el.text = tone_events[0][1]

    # Replace ALL pre-existing <tones> blocks rather than appending another
    # (idempotent if this is somehow called twice, or the source XML already
    # carried one or more) — duplicate <tones> sections break tone parsing.
    for existing_tones in root.findall('tones'):
        root.remove(existing_tones)

    tones_el = _ET.SubElement(root, 'tones', count=str(len(tone_events)))
    for i, (t, name) in enumerate(tone_events):
        _ET.SubElement(tones_el, 'tone',
                       id=str(i),
                       name=name,
                       time=f'{t:.3f}')

    # _build_xml already pretty-printed the input, so parsing it leaves the
    # indentation as whitespace-only text/tail nodes. Drop those before the
    # second pretty-print, otherwise minidom preserves them and stacks fresh
    # indentation on top, exploding the output with blank lines.
    def _strip_ws(el: _ET.Element) -> None:
        if el.text is not None and not el.text.strip():
            el.text = None
        if el.tail is not None and not el.tail.strip():
            el.tail = None
        for child in el:
            _strip_ws(child)

    _strip_ws(root)
    raw = _ET.tostring(root, encoding='unicode')
    dom = _minidom.parseString(raw)
    return dom.toprettyxml(indent='  ', encoding=None)



def convert_vocal_track_to_pitch_sidecar(
    root: ET.Element,
    track: dict,
    raw_idx: int,
    masterbars: list,
    bars_by_id: dict,
    voices_dict: dict,
    beats_dict: dict,
    notes_dict: dict,
    rhythms_dict: dict,
    *,
    tempo_bpm: float = 120.0,
    audio_offset: float = 0.0,
) -> dict:
    """
    Extract per-syllable pitch from a GPX vocal track as a vocal_pitch.json dict.

    Returns the same payload shape as the lyrics-karaoke plugin's
    ``_persist_pitch`` function so GPX vocal pitch can be written directly
    into a sloppak alongside lyrics.json:

        {"version": 1, "notes": [{"t": float, "d": float, "midi": int}, ...]}

    This is complementary to convert_vocal_track() which produces arrangement XML.
    NOTE: nothing in this module calls this helper yet — convert_file() does not
    invoke it, so no vocal_pitch.json is emitted automatically. A caller wanting
    the pitch ribbon must call this itself and persist the returned dict (e.g.
    write it as vocal_pitch.json into the sloppak). When wiring vocals into a
    sloppak, call both:
        - convert_vocal_track() → vocals arrangement XML (karaoke highway)
        - convert_vocal_track_to_pitch_sidecar() → vocal_pitch.json (pitch ribbon)

    Pitch source is the tab author's authored notes (exact), not AI audio
    analysis — so this is more accurate than pYIN/CREPE for well-authored tabs.
    """
    string_pitches = track['string_pitches']
    notes: list[dict] = []
    current_time = 0.0

    # Per-bar tempo from map. _build_tempo_map() returns a synthetic [(0, 120)]
    # when the file has no explicit tempo automations — in that case honour the
    # caller-supplied tempo_bpm fallback instead of silently forcing 120 BPM.
    _mt = root.find('MasterTrack')
    _has_explicit_tempo = _mt is not None and any(
        a.findtext('Type') == 'Tempo' for a in _mt.findall('.//Automations/*')
    )
    _tp = _build_tempo_map(root) if _has_explicit_tempo else [(0, tempo_bpm)]
    _tp_iter = iter(_tp)
    _next_bar, _next_bpm = next(_tp_iter, (999999, tempo_bpm))
    _cur_tempo = tempo_bpm

    for mb_idx, mb in enumerate(masterbars):
        while mb_idx >= _next_bar:
            _cur_tempo = _next_bpm
            _next_bar, _next_bpm = next(_tp_iter, (999999, _cur_tempo))

        time_sig = mb.findtext('Time', '4/4')
        try:
            num_b, den_b = [int(x) for x in time_sig.split('/')]
        except ValueError:
            num_b, den_b = 4, 4
        bar_duration = num_b * (4.0 / den_b) * (60.0 / _cur_tempo)

        bar_ids = mb.findtext('Bars', '').split()
        bid = bar_ids[raw_idx] if raw_idx < len(bar_ids) else '-1'

        if bid != '-1' and bid:
            bar = bars_by_id.get(bid)
            if bar is not None:
                for vid in bar.findtext('Voices', '').split():
                    if vid == '-1':
                        continue
                    voice = voices_dict.get(vid)
                    if voice is None:
                        continue
                    voice_time = current_time
                    for beat_id in voice.findtext('Beats', '').split():
                        beat_el = beats_dict.get(beat_id)
                        if beat_el is None:
                            continue
                        dur = _beat_dur_secs(beat_el, rhythms_dict, _cur_tempo)

                        # Only emit notes that have a lyric — unvoiced beats
                        # (rests, instrumental fills) are excluded so the
                        # pitch ribbon stays aligned with lyric tokens.
                        lyric_el = beat_el.find('Lyrics')
                        has_lyric = (
                            lyric_el is not None
                            and lyric_el.find('Line') is not None
                            and (lyric_el.find('Line').text or '').strip()
                        )
                        if not has_lyric:
                            voice_time += dur
                            continue

                        notes_text = beat_el.findtext('Notes', '').strip()
                        for nid in notes_text.split():
                            note_el = notes_dict.get(nid)
                            if note_el is None:
                                continue
                            if _note_is_tie(note_el):
                                # Extend previous note's duration
                                if notes:
                                    notes[-1]['d'] = round(
                                        max(notes[-1]['d'],
                                            (voice_time + audio_offset + dur) - notes[-1]['t']),
                                        3,
                                    )
                                continue
                            midi = _note_midi(note_el, string_pitches)
                            if midi is None:
                                continue
                            notes.append({
                                't': round(voice_time + audio_offset, 3),
                                'd': round(dur, 3),
                                'midi': midi,
                            })
                            break  # one pitch per vocal beat

                        voice_time += dur

        current_time += bar_duration

    # Sort chronologically: multi-voice bars reset voice_time per voice, so
    # traversal order isn't time-ordered. A time-series JSON should be sorted by
    # onset for deterministic output and consumers that assume chronology.
    notes.sort(key=lambda n: n['t'])
    return {'version': 1, 'notes': notes}


def _notes_by_id(root: ET.Element) -> dict:
    """Map note id -> Note element from the GPIF `<Notes>` pool, tolerating
    malformed pools that contain duplicate ids.

    Some exporters emit each fretted note twice under the same id: a real
    tablature note (String/Fret/Midi) followed by a degenerate
    articulation-only twin (placeholder ConcertPitch + `<InstrumentArticulation>`,
    no String/Fret). A plain dict comprehension keeps the *last* occurrence, so
    every duplicated id resolves to the degenerate twin and that track's notes
    silently vanish (observed: a whole guitar importing as 0 notes). Prefer the
    note that carries String+Fret so dup-id'd guitar notes still decode; for
    genuinely single notes (incl. drum articulation notes) behaviour is
    unchanged.
    """
    def _has_string_fret(el: ET.Element) -> bool:
        names = {p.get('name') for p in el.findall('.//Property')}
        return 'String' in names and 'Fret' in names

    out: dict = {}
    for n in (root.find('Notes') or []):
        nid = n.get('id')
        if nid is None:
            continue
        prev = out.get(nid)
        if prev is None or (_has_string_fret(n) and not _has_string_fret(prev)):
            out[nid] = n
    return out


def _gpx_bend_scale(root: ET.Element) -> float:
    """Return the divisor that converts GPIF bend `<Float>` values to semitones.

    GPIF bend magnitudes aren't on a single scale across exporters: some files
    use ~100 for a whole-tone bend (≈50 per semitone), others use ~2500 per
    semitone. Sniff the file's peak bend value and pick the matching divisor so
    imported bend amounts land in a sane semitone range either way.
    """
    peak = 0.0
    for p in root.iter('Property'):
        if p.get('name') in ('BendDestinationValue', 'BendMiddleValue',
                             'BendOriginValue'):
            try:
                peak = max(peak, float(p.findtext('Float') or 0))
            except (ValueError, TypeError):
                pass
    # Small-scale files top out around a few hundred (100 = whole tone → /50);
    # large-scale files use ~2500 per semitone.
    return 50.0 if peak <= 400 else 2500.0


def _gpx_bend_float(tp: dict, name: str):
    """Read a GPIF bend `<Property><Float>` value from the property map, or None."""
    el = tp.get(name)
    if el is None:
        return None
    try:
        return float(el.findtext('Float') or 0)
    except (ValueError, TypeError):
        return None


def _gpx_bend_shape(tp: dict, divisor: float, sustain: float):
    """Build ``(peak, intent, curve)`` from a GPIF note's bend Properties (§6.2.1).

    GPIF describes a bend as origin / middle / destination value+offset pairs;
    `value / divisor` is semitones (divisor auto-detected per file) and the
    `*Offset` Properties are 0..100 (percent of the note's duration). Produces a
    bnv curve of up to three points (mapping each offset to seconds-from-onset),
    or ``None`` when there's no usable shape (no points, flat-zero, or a
    zero-length note). When an offset Property is absent the stage falls back to
    an evenly-spaced default (origin 0%, middle 50%, destination 100%).

    NOTE: offset Property names should be confirmed against a real GP8 export;
    the value path matches the existing scalar-bend extraction either way."""
    from gp2rs import _bend_intent_from_values  # lazy: gp2rs<->gpx circular
    stages = (
        ('BendOriginValue', 'BendOriginOffset', 0.0),
        ('BendMiddleValue', 'BendMiddleOffset1', 50.0),
        ('BendDestinationValue', 'BendDestinationOffset', 100.0),
    )
    pts = []
    for vkey, okey, default_off in stages:
        v = _gpx_bend_float(tp, vkey)
        if v is None:
            continue
        off = _gpx_bend_float(tp, okey)
        if off is None:
            off = default_off
        off = max(0.0, min(100.0, off))
        pts.append((off, round(v / divisor, 1)))
    if not pts:
        return 0.0, 0, None
    pts.sort(key=lambda p: p[0])
    values = [v for _, v in pts]
    peak = round(max(values), 1)
    intent = _bend_intent_from_values(values)
    curve = None
    if peak > 0 and sustain > 0 and len(pts) >= 2:
        curve = [{"t": round(sustain * (off / 100.0), 3), "v": v}
                 for off, v in pts]
    return peak, intent, curve


def _resolve_pending_slides(rs_notes, rs_chords, pending_slides):
    """Resolve GP slide flags collected during the beat loop into RS slide
    fields, now that every note on each string is known.

    ``pending_slides`` is a list of ``(RsNote, rs_string, gp_slide_flags)`` or
    ``(RsNote, rs_string, gp_slide_flags, is_grace)``. Flag bits: 1/2 = pitched
    shift/legato slide to the next note on the string; 4 = unpitched slide out
    (down); 8 = unpitched slide out (up).

    Grace notes are imported as shift-slides into the following main note, but a
    grace beat is short so the converter's >0.2s rule zeroed its sustain — and
    the highway only draws a slide trail when ``sus > 0`` (highway_3d
    ``slideOffsetWorldX``), so a zero-sustain slide is invisible. For any
    zero-sustain shift-slide we stretch the sustain to span the gap up to its
    slide target so the slide renders; already-sustained (normal) slides keep
    their authored sustain.

    ``link_next`` (which tells the highway to suppress the target note's gem so
    the slide visually connects) is set ONLY for normal slides. A grace note is
    an ornament *before* the principal note, so its target IS re-struck and must
    keep its gem — setting link_next there hid the main note and made the grace
    look unrendered. Grace slides therefore get slide_to + sustain but NOT
    link_next: a quick grace flick into a still-visible main note.
    """
    by_string: dict = {}
    for _n in rs_notes:
        by_string.setdefault(_n.string, []).append(_n)
    for _c in rs_chords:
        for _n in _c.notes:
            by_string.setdefault(_n.string, []).append(_n)
    for _lst in by_string.values():
        _lst.sort(key=lambda n: n.time)
    for _item in pending_slides:
        _rn, _sstr, _flags = _item[0], _item[1], _item[2]
        _is_grace = _item[3] if len(_item) > 3 else False
        if _flags & 0b0011:        # shift / legato → pitched slide to next
            _seq = by_string.get(_sstr, [])
            _nxt = next((x for x in _seq if x.time > _rn.time), None)
            if _nxt is not None and _nxt.fret != _rn.fret:
                _rn.slide_to = _nxt.fret
                if not _is_grace:
                    # Normal slide: suppress the target gem so the slide connects
                    # (matches GP5). A grace target is re-struck — keep its gem.
                    _rn.link_next = True
                if _rn.sustain <= 0:
                    _gap = _nxt.time - _rn.time
                    if _gap > 0:
                        _rn.sustain = _gap
        elif _flags & 0b0100:      # slide out, downwards (unpitched)
            _rn.slide_unpitch_to = max(1, _rn.fret - 5)
        elif _flags & 0b1000:      # slide out, upwards (unpitched)
            _rn.slide_unpitch_to = _rn.fret + 5


def convert_file(
    gp_path: str,
    output_dir: str,
    track_indices: list[int] | None = None,
    audio_offset: float = 0.0,
    arrangement_names: dict[int, str] | None = None,
    force_standard_tuning: bool = False,
    *,
    expand_repeats: bool = True,
) -> list[str]:
    """Convert a .gpx file to arrangement XML arrangement files.

    Mirrors gp2rs.convert_file so the editor plugin can call it transparently.
    expand_repeats is accepted for API compatibility but repeat expansion from
    GPX XML is not yet implemented (the GPIF repeat markup differs from GP5
    binary and requires a separate walker — planned for a follow-up PR).
    """
    root = _load_gpif(gp_path)
    out = Path(output_dir)
    out.mkdir(parents=True, exist_ok=True)

    # Metadata
    score = root.find('Score')
    title = (score.findtext('Title') or '').strip() if score is not None else ''
    artist = (score.findtext('Artist') or '').strip() if score is not None else ''
    album = (score.findtext('Album') or '').strip() if score is not None else ''
    tempo_bpm = _gpif_tempo(root)  # initial tempo (used as fallback)
    tempo_map = _build_tempo_map(root)  # full bar->bpm map for multi-tempo songs

    tracks = _gpif_tracks(root)

    if track_indices is None:
        track_indices, auto_names = _auto_select_gpx(tracks)
        if not arrangement_names:
            arrangement_names = auto_names

    names = arrangement_names or {}

    # Pre-build lookup tables (shared across all tracks)
    masterbars = list(root.find('MasterBars') or [])

    # expand_repeats is accepted for gp2rs.convert_file parity but GPIF repeat
    # expansion (Repeat / AlternateEndings / Directions) is not implemented yet.
    # Surface that to the caller rather than only the docstring: if the score
    # actually uses repeats, the produced bar count/timing will differ from the
    # equivalent .gp5. Warn once so plugin code/logs don't silently drift.
    if expand_repeats and any(
        mb.find('Repeat') is not None or mb.find('AlternateEndings') is not None
        for mb in masterbars
    ):
        _log.warning(
            "GPX '%s' contains repeat/volta markup but GPX repeat expansion is "
            "not implemented; arrangement is emitted single-pass and may not "
            "match the equivalent .gp5.", gp_path
        )
    bars_list = list(root.find('Bars') or [])
    bars_by_id = {b.get('id'): b for b in bars_list}
    voices_dict = {v.get('id'): v for v in (root.find('Voices') or [])}
    beats_dict = {b.get('id'): b for b in (root.find('Beats') or [])}
    notes_dict = _notes_by_id(root)
    rhythms_dict = {r.get('id'): r for r in (root.find('Rhythms') or [])}
    _bend_divisor = _gpx_bend_scale(root)   # GPIF bend value -> semitones

    # Map filtered track index -> raw track index (needed for bar lookup)
    raw_tracks = list(root.find('Tracks') or [])
    filtered_to_raw: dict[int, int] = {}
    filtered_pos = 0
    for raw_idx, t_el in enumerate(raw_tracks):
        name = (t_el.findtext('Name') or '').strip()
        if name.startswith('@$') and name.endswith('$@'):
            continue
        filtered_to_raw[filtered_pos] = raw_idx
        filtered_pos += 1


    # Detect and merge Piano LH+RH pairs into single full-keyboard arrangements
    track_indices, _piano_merge_map = _find_piano_pairs(track_indices, tracks, names)

    output_files = []
    # Counts of auto-named guitar/bass arrangements so far, so multiple guitars
    # get distinct RS roles (Lead, Rhythm, Combo, …) instead of all "Lead".
    _role_counts: dict[str, int] = {}

    for track_idx in track_indices:
        if track_idx >= len(tracks):
            continue
        track = tracks[track_idx]
        arr_name = names.get(track_idx, '')
        raw_idx = filtered_to_raw.get(track_idx, track_idx)

        # Decide conversion mode
        is_drum = track['is_drums'] or (arr_name.lower().startswith('drums'))
        is_vocal = _is_vocal_track(track) or arr_name.lower().startswith('vocal')
        # GP7/GP8 percussion: build the InstrumentArticulation-index → GM MIDI
        # map once per drum track so each note's <InstrumentArticulation> child
        # resolves to a real drum MIDI in `_note_midi` (Encoding 0).
        _perc_midis = _gpx_percussion_midis(track.get('_el')) if is_drum else None
        # GP6 models piano/keys parts on guitar/bass string templates, so a
        # named keyboard track usually HAS string_pitches. Gate only the
        # midi_program heuristic on `not string_pitches` (to avoid grabbing real
        # guitars); a name/arrangement keyword forces keys regardless, so these
        # tracks take the keys encoding and the LH/RH merge map actually applies.
        is_keys = (
            not is_drum and not is_vocal
            and (
                any(kw in track['name'].lower() for kw in ('piano', 'keys', 'keyboard', 'organ'))
                or arr_name.lower().startswith('keys')
                or (
                    not track['string_pitches']
                    and track['midi_program'] in set(range(0, 8)) | set(range(16, 24)) | {80, 81, 82, 83}
                )
            )
        )

        # Default arrangement name for guitar/bass tracks when the caller didn't
        # supply one (the editor passes track_indices without names). Mirror
        # gp2rs: detect bass by MIDI program (32-39 Bass family) or the top
        # string's pitch (<= C3/48, which holds for 4/5/6-string bass), else
        # fall back to a name keyword. Without this every GP8 guitar/bass track
        # defaulted to "Lead", so basses imported as guitar arrangements.
        if not arr_name and not is_drum and not is_vocal and not is_keys:
            sp = track['string_pitches']
            prog = track['midi_program']
            is_bass = (
                (isinstance(prog, int) and 32 <= prog <= 39)
                or (bool(sp) and max(sp) <= 48)
            )
            low = track['name'].lower()
            if is_bass or 'bass' in low:
                _bc = _role_counts.get('bass', 0)
                _role_counts['bass'] = _bc + 1
                arr_name = 'Bass' if _bc == 0 else f'Bass {_bc + 1}'
            else:
                # Distinct guitar roles by appearance order so two guitars
                # don't both become "Lead": Lead, Rhythm, Combo, then Combo N.
                _gc = _role_counts.get('guitar', 0)
                _role_counts['guitar'] = _gc + 1
                _roles = ('Lead', 'Rhythm', 'Combo')
                arr_name = _roles[_gc] if _gc < len(_roles) else f'Combo {_gc - 1}'

        # Vocal tracks get their own converter — outputs vocals XML, not notes XML
        if is_vocal:
            xml_str = convert_vocal_track(
                root, track, raw_idx,
                masterbars, bars_by_id, voices_dict, beats_dict, notes_dict, rhythms_dict,
                title=title, artist=artist, album=album, tempo_bpm=tempo_bpm,
                audio_offset=audio_offset, arr_name=arr_name or 'Vocals',
            )
            filename = f"{_safe_filename_stem(track['name'])}_{arr_name or 'Vocals'}.xml"
            filepath = safe_join(out, filename)
            if filepath is None:
                raise ValueError(f"unsafe output filename from track name: {track['name']!r}")
            filepath.write_text(xml_str)
            output_files.append(str(filepath))
            continue

        # Iterate all masterbars and collect notes for this track
        from gp2rs import RsNote, RsBeat, RsSection, RsAnchor, ChordTemplate, RsChord, _build_xml

        rs_notes: list[RsNote] = []
        rs_chords: list[RsChord] = []
        chord_templates: list[ChordTemplate] = []
        chord_template_map: dict[tuple, int] = {}
        # Authored chord diagrams (name + per-string fingering) for this track,
        # keyed by fret pattern so they enrich matching played voicings.
        chord_diagram_map = _parse_chord_diagrams(
            track.get('_el'), track['string_pitches'])
        beats_out: list[RsBeat] = []
        sections: list[RsSection] = []
        section_counts: dict[str, int] = {}
        last_note_per_key: dict = {}
        last_note_per_string: dict = {}   # rs_string -> last RsNote (for HO/PO direction)
        pending_slides: list = []         # (RsNote, rs_string, gp_slide_flags) — resolved post-loop

        current_time = 0.0
        num_raw_tracks = len(raw_tracks)

        # Resolve current tempo per bar from the tempo map
        _tempo_iter = iter(tempo_map)
        _next_tempo_bar, _next_tempo_bpm = next(_tempo_iter, (999999, tempo_bpm))
        _cur_tempo = tempo_bpm

        for mb_idx_loop, mb in enumerate(masterbars):
            # Advance tempo map
            while mb_idx_loop >= _next_tempo_bar:
                _cur_tempo = _next_tempo_bpm
                _next_tempo_bar, _next_tempo_bpm = next(_tempo_iter, (999999, _cur_tempo))

            time_sig = mb.findtext('Time', '4/4')
            try:
                num_b, den_b = [int(x) for x in time_sig.split('/')]
            except ValueError:
                num_b, den_b = 4, 4
            beats_per_bar = num_b * (4.0 / den_b)
            bar_duration = beats_per_bar * (60.0 / _cur_tempo)
            # One beat = one denominator unit, NOT always a quarter note. For
            # 6/8, 3/8, 12/8 etc. the beat is shorter than a quarter, so scale
            # by (4/den_b); otherwise markers spread at quarter spacing and run
            # past the bar end on compound/non-quarter meters.
            beat_len = (60.0 / _cur_tempo) * (4.0 / den_b)

            # Downbeat
            beats_out.append(RsBeat(time=current_time + audio_offset, measure=-999))  # placeholder
            for sub_b in range(1, num_b):
                beats_out.append(RsBeat(
                    time=current_time + sub_b * beat_len + audio_offset,
                    measure=-1,
                ))

            # Section markers
            section_el = mb.find('Section')
            if section_el is not None:
                text = (section_el.findtext('Text') or '').strip()
                if text:
                    sname = text.lower().replace(' ', '')
                    section_counts[sname] = section_counts.get(sname, 0) + 1
                    sections.append(RsSection(
                        name=sname,
                        time=current_time + audio_offset,
                        number=section_counts[sname],
                    ))

            # Get this track's bar
            bar_ids = mb.findtext('Bars', '').split()
            bid = bar_ids[raw_idx] if raw_idx < len(bar_ids) else '-1'

            if bid != '-1' and bid:
                bar = bars_by_id.get(bid)
                if bar is not None:
                    for vid in bar.findtext('Voices', '').split():
                        if vid == '-1':
                            continue
                        voice = voices_dict.get(vid)
                        if voice is None:
                            continue

                        voice_time = current_time
                        for beat_id in voice.findtext('Beats', '').split():
                            beat_el = beats_dict.get(beat_id)
                            if beat_el is None:
                                continue

                            dur = _beat_dur_secs(beat_el, rhythms_dict, _cur_tempo)
                            t = voice_time + audio_offset

                            notes_text = beat_el.findtext('Notes', '').strip()
                            if notes_text:
                                beat_note_els = [
                                    notes_dict[nid]
                                    for nid in notes_text.split()
                                    if nid in notes_dict
                                ]

                                beat_rs_notes = []
                                for note_el in beat_note_els:
                                    if _note_is_tie(note_el):
                                        # Extend sustain of previous note at same pitch
                                        midi = _note_midi(note_el, track['string_pitches'], _perc_midis)
                                        if midi is not None:
                                            prev = last_note_per_key.get(midi)
                                            if prev is not None and prev.time < t:
                                                prev.sustain = max(prev.sustain, (t + dur) - prev.time)
                                        continue

                                    midi = _note_midi(note_el, track['string_pitches'], _perc_midis)
                                    if midi is None:
                                        continue

                                    if is_drum:
                                        # GP6 decodes drum pieces to their real GM
                                        # MIDI numbers directly (splash 55, china
                                        # 52, ride bell 53, pedal hi-hat 44, …), so
                                        # no GM_DRUM_MAP gate is needed — that gate
                                        # only exists on the GP3-5 path because
                                        # pyguitarpro emits raw MIDI. The generic
                                        # midi -> (string, fret) encoding below
                                        # represents any drum piece, so filtering
                                        # here would silently drop valid pieces.
                                        rs_str = midi // 24
                                        rs_fret = midi % 24
                                    elif is_keys:
                                        rs_str = midi // 24
                                        rs_fret = midi % 24
                                    else:
                                        # Guitar/bass: need string + fret from XML
                                        props = {p.get('name'): p for p in note_el.findall('.//Property')}
                                        if 'String' in props and 'Fret' in props:
                                            try:
                                                gp_str = int(props['String'].findtext('String') or 0)
                                                fret = int(props['Fret'].findtext('Fret') or 0)
                                                sp = track['string_pitches']
                                                num_strings = len(sp)
                                                # RS string 0 = lowest-pitched string.
                                                # The GPX Note String index matches the
                                                # <Pitches> array positionally, but that
                                                # array's direction differs by format
                                                # (GP6 .gpx high->low, GP8 .gp low->high),
                                                # so derive the RS string from the open
                                                # string's PITCH RANK rather than assuming
                                                # a direction. Assuming high->low (the old
                                                # `num_strings-1-gp_str`) mirrored every
                                                # GP8 import — low-E notes landed on high-e.
                                                # Tiebreak ties on the original index so
                                                # two strings with the SAME open pitch
                                                # (e.g. a unison course) still get distinct
                                                # RS strings instead of colliding.
                                                if 0 <= gp_str < num_strings:
                                                    order = sorted(
                                                        range(num_strings),
                                                        key=lambda i: (sp[i], i),
                                                    )
                                                    rs_str = order.index(gp_str)
                                                else:
                                                    rs_str = gp_str
                                                rs_fret = fret
                                            except (ValueError, TypeError):
                                                continue
                                        else:
                                            continue

                                    sustain = dur if dur > 0.2 else 0.0
                                    if is_drum:
                                        sustain = 0.0

                                    rn = RsNote(
                                        time=t,
                                        string=rs_str,
                                        fret=rs_fret,
                                        sustain=sustain,
                                    )

                                    # Techniques — GPIF stores these as <Property>
                                    # elements (NOT child tags), so the old
                                    # find('PalmMute')/find('Vibrato') reads never
                                    # matched and every GPX/GP technique was dropped.
                                    # Read them from the property map instead.
                                    _tp = {p.get('name'): p
                                           for p in note_el.findall('.//Property')}
                                    if 'PalmMuted' in _tp:
                                        rn.palm_mute = True
                                    if 'Muted' in _tp:        # dead/X note
                                        rn.mute = True
                                    if _note_has_vibrato(note_el, _tp):
                                        rn.vibrato = True
                                    if 'LeftHandTapping' in _tp or 'Tapped' in _tp:
                                        rn.tap = True
                                    # Fret-hand fingering -> fg teaching mark
                                    # (§6.2.2). <LeftFingering> is a direct <Note>
                                    # child, not a <Property>, so read it off
                                    # note_el rather than the property map.
                                    rn.fret_finger = _gpif_left_fingering(note_el)
                                    if 'HarmonicType' in _tp:
                                        _ht = (_tp['HarmonicType'].findtext('HType')
                                               or '').strip().lower()
                                        if _ht == 'pinch':
                                            rn.harmonic_pinch = True
                                        else:
                                            rn.harmonic = True
                                    # Hammer-on / pull-off: a HopoDestination note is
                                    # reached via HO/PO from the prior note on the
                                    # same string — pull-off when descending, else
                                    # hammer-on.
                                    if 'HopoDestination' in _tp:
                                        _prev = last_note_per_string.get(rs_str)
                                        if _prev is not None and _prev.fret > rs_fret:
                                            rn.pull_off = True
                                        else:
                                            rn.hammer_on = True
                                    # Bend: `bn` is the peak; `bnv`/`bt` capture
                                    # the shape over time (§6.2.1). value/divisor
                                    # = semitones (scale auto-detected per file).
                                    if 'Bended' in _tp:
                                        # Use the beat duration `dur`, not
                                        # `rn.sustain` (zeroed for notes <= 0.2s),
                                        # so short bends keep their bnv curve —
                                        # matching the GP5 path, which maps over
                                        # the raw note duration.
                                        _peak, _intent, _curve = _gpx_bend_shape(
                                            _tp, _bend_divisor, dur)
                                        if _peak > 0:
                                            rn.bend = _peak
                                            rn.bend_intent = _intent
                                            rn.bend_values = _curve
                                    # Slide flags: 1/2 = pitched slide to the next
                                    # note; 4 = slide out down, 8 = out up. Resolved
                                    # post-loop (needs the next note on the string).
                                    if 'Slide' in _tp:
                                        try:
                                            _sf = int(_tp['Slide'].findtext('Flags') or 0)
                                        except (ValueError, TypeError):
                                            _sf = 0
                                        if _sf:
                                            # A grace note (BeforeBeat) slides INTO
                                            # the following main note, so force a
                                            # pitched slide-to-next even when the
                                            # flag is an "out" slide (4/8) — e.g.
                                            # the "3/5" grace-slide. Flag 1 = shift.
                                            _is_grace = (
                                                beat_el.find('GraceNotes') is not None)
                                            if _is_grace:
                                                _sf = 1
                                            pending_slides.append(
                                                (rn, rs_str, _sf, _is_grace))

                                    beat_rs_notes.append(rn)
                                    last_note_per_key[midi] = rn
                                    last_note_per_string[rs_str] = rn

                                # Whammy-as-vibrato: GPIF VibratoWTremBar is a
                                # bar wobble (Strength Slight/Wide), not a pitch
                                # dive, so map it to note vibrato across the beat
                                # (a dive would instead be an unpitched slide).
                                if beat_el.find(
                                        './/Property[@name="VibratoWTremBar"]') is not None:
                                    for _bn in beat_rs_notes:
                                        _bn.vibrato = True

                                # Tremolo picking: GP7/GP8 encodes the rate as a
                                # beat-level <Tremolo>1/8</Tremolo> child. The note
                                # model has a single tremolo flag (no rate), so map
                                # any tremolo-picked beat to note tremolo across it.
                                # Independent of vibrato above — a note can carry
                                # both. (Beat-level <Tremolo>, not the whammy
                                # VibratoWTremBar Property, which is handled above.)
                                if _beat_has_tremolo(beat_el):
                                    for _bn in beat_rs_notes:
                                        _bn.tremolo = True

                                if len(beat_rs_notes) == 1:
                                    rs_notes.append(beat_rs_notes[0])
                                elif len(beat_rs_notes) > 1:
                                    width = max(6, max(n.string for n in beat_rs_notes) + 1)
                                    frets_t = [-1] * width
                                    for n in beat_rs_notes:
                                        if 0 <= n.string < width:
                                            frets_t[n.string] = n.fret
                                    fkey = tuple(frets_t)
                                    if fkey not in chord_template_map:
                                        chord_template_map[fkey] = len(chord_templates)
                                        _diag = chord_diagram_map.get(fkey)
                                        chord_templates.append(ChordTemplate(
                                            name=(_diag['name'] if _diag else ''),
                                            frets=list(frets_t),
                                            fingers=(list(_diag['fingers']) if _diag
                                                     else [-1] * width),
                                        ))
                                    rs_chords.append(RsChord(
                                        time=t,
                                        template_idx=chord_template_map[fkey],
                                        notes=beat_rs_notes,
                                    ))

                            voice_time += dur

            current_time += bar_duration

        # Fix downbeat measure numbers
        bar_num = 1
        for b in beats_out:
            if b.measure == -999:
                b.measure = bar_num
                bar_num += 1

        if not sections:
            sections.append(RsSection(name='default', time=audio_offset, number=1))

        rs_notes.sort(key=lambda n: n.time)
        rs_chords.sort(key=lambda c: c.time)

        # Anchors
        if is_drum or is_keys:
            anchors = [RsAnchor(time=audio_offset, fret=1, width=24)]
        else:
            all_frets = [(n.time, n.fret) for n in rs_notes if n.fret > 0]
            for c in rs_chords:
                for cn in c.notes:
                    if cn.fret > 0:
                        all_frets.append((cn.time, cn.fret))
            all_frets.sort()
            first_fret = all_frets[0][1] if all_frets else 1
            anchors = [RsAnchor(time=audio_offset, fret=max(1, first_fret - 1), width=4)]
            for t_f, fret in all_frets:
                lo = anchors[-1].fret
                if fret < lo or fret > lo + anchors[-1].width:
                    new_f = max(1, fret - 1)
                    if new_f != anchors[-1].fret:
                        anchors.append(RsAnchor(time=t_f, fret=new_f, width=4))

        song_length = current_time + audio_offset

        # Use the track's actual string count (matches gp2rs: len(track.strings)).
        # Forcing a minimum of 6 emitted 4/5-string bass as a 6-string
        # arrangement with mismatched tuning/string indexing. Guitar-family
        # tracks always have string_pitches (that's how they're classified).
        # Guitar-family tracks have string_pitches; but an explicit track_indices
        # entry can route a program-only track (no tuning, not drum/keys/vocal)
        # here — fall back to a 6-string default so num_strings/tuning are never
        # empty (which would emit invalid arrangement metadata via _build_xml).
        num_strings = 6 if (is_drum or is_keys) else (len(track['string_pitches']) or 6)
        # force_standard_tuning parity with gp2rs.convert_file: E standard
        # (all-zero offsets), frets unchanged. Drums/keys are always [0]*6.
        if is_drum or is_keys or force_standard_tuning:
            tuning = [0] * num_strings
        else:
            tuning = _gpx_tuning(track)

        # Merge Piano LH notes into this (RH) arrangement if a pair was detected
        if is_keys and track_idx in _piano_merge_map:
            lh_idx = _piano_merge_map[track_idx]
            lh_track = tracks[lh_idx]
            lh_raw_idx = filtered_to_raw.get(lh_idx, lh_idx)

            _lh_notes: list[RsNote] = []
            _lh_last_per_key: dict[int, RsNote] = {}
            _lh_tempo_iter = iter(tempo_map)
            _lh_next_bar, _lh_next_bpm = next(_lh_tempo_iter, (999999, tempo_bpm))
            _lh_cur_tempo = tempo_bpm
            _lh_time = 0.0

            for _lh_mb_idx, _lh_mb in enumerate(masterbars):
                while _lh_mb_idx >= _lh_next_bar:
                    _lh_cur_tempo = _lh_next_bpm
                    _lh_next_bar, _lh_next_bpm = next(_lh_tempo_iter, (999999, _lh_cur_tempo))
                _lh_ts = _lh_mb.findtext('Time', '4/4')
                try:
                    _lh_nb, _lh_db = [int(x) for x in _lh_ts.split('/')]
                except ValueError:
                    _lh_nb, _lh_db = 4, 4
                _lh_bar_dur = _lh_nb * (4.0 / _lh_db) * (60.0 / _lh_cur_tempo)
                _lh_bar_ids = _lh_mb.findtext('Bars', '').split()
                _lh_bid = _lh_bar_ids[lh_raw_idx] if lh_raw_idx < len(_lh_bar_ids) else '-1'
                if _lh_bid != '-1' and _lh_bid:
                    _lh_bar = bars_by_id.get(_lh_bid)
                    if _lh_bar is not None:
                        for _lh_vid in _lh_bar.findtext('Voices', '').split():
                            if _lh_vid == '-1':
                                continue
                            _lh_voice = voices_dict.get(_lh_vid)
                            if _lh_voice is None:
                                continue
                            _lh_vt = _lh_time
                            for _lh_beat_id in _lh_voice.findtext('Beats', '').split():
                                _lh_beat = beats_dict.get(_lh_beat_id)
                                if _lh_beat is None:
                                    continue
                                _lh_dur = _beat_dur_secs(_lh_beat, rhythms_dict, _lh_cur_tempo)
                                for _lh_nid in _lh_beat.findtext('Notes', '').strip().split():
                                    _lh_note_el = notes_dict.get(_lh_nid)
                                    if _lh_note_el is None:
                                        continue
                                    if _note_is_tie(_lh_note_el):
                                        # Extend the matching prior note (same
                                        # pitch), mirroring the main builder's
                                        # last_note_per_key handling — blindly
                                        # extending the last-emitted note
                                        # mishandles polyphonic (chord) LH parts.
                                        _tie_midi = _note_midi(_lh_note_el, lh_track['string_pitches'])
                                        if _tie_midi is not None:
                                            _prev = _lh_last_per_key.get(_tie_midi)
                                            # Full-precision comparison (matching
                                            # the main builder); rounding only
                                            # happens at XML serialization. Rounding
                                            # here could make a short note appear to
                                            # start at the tie time and skip the
                                            # sustain extension.
                                            _tie_t = _lh_vt + audio_offset
                                            if _prev is not None and _prev.time < _tie_t:
                                                _prev.sustain = max(
                                                    _prev.sustain,
                                                    (_tie_t + _lh_dur) - _prev.time,
                                                )
                                        continue
                                    _lh_midi = _note_midi(_lh_note_el, lh_track['string_pitches'])
                                    if _lh_midi is None:
                                        continue
                                    # Keep full-precision time (like the main
                                    # convert_file() builder — rounding happens at
                                    # serialization); same 0.2s sustain threshold.
                                    _lh_rn = RsNote(
                                        time=_lh_vt + audio_offset,
                                        string=_lh_midi // 24,
                                        fret=_lh_midi % 24,
                                        sustain=_lh_dur if _lh_dur > 0.2 else 0.0,
                                    )
                                    _lh_notes.append(_lh_rn)
                                    _lh_last_per_key[_lh_midi] = _lh_rn
                                _lh_vt += _lh_dur
                _lh_time += _lh_bar_dur

            # Merge: combine and deduplicate simultaneous same-pitch notes, then
            # sort by time. Map each (time, string, fret) to its existing RsNote
            # so that when both hands hit the same key at the same instant we
            # keep the LONGER sustain instead of arbitrarily discarding the LH
            # one. Seed from both single notes and chord notes — polyphonic RH
            # beats live in rs_chords[*].notes, so seeding from rs_notes alone
            # would let an identical LH note slip in as a duplicate.
            _seen: dict[tuple, RsNote] = {}
            for _n in rs_notes:
                _seen.setdefault((round(_n.time, 3), _n.string, _n.fret), _n)
            for _c in rs_chords:
                for _cn in _c.notes:
                    _seen.setdefault((round(_cn.time, 3), _cn.string, _cn.fret), _cn)
            for _lh_rn in _lh_notes:
                _k = (round(_lh_rn.time, 3), _lh_rn.string, _lh_rn.fret)
                _existing = _seen.get(_k)
                if _existing is None:
                    rs_notes.append(_lh_rn)
                    _seen[_k] = _lh_rn
                elif _lh_rn.sustain > _existing.sustain:
                    # Same key both hands — preserve the longer sustain (mutating
                    # the RsNote also updates it in place inside any RH chord).
                    _existing.sustain = _lh_rn.sustain
            rs_notes.sort(key=lambda n: (n.time, n.string))

            # Collapse "Keys 2" -> "Keys": the merged LH+RH is a single
            # keyboard arrangement. Keep the standard "Keys" name (not "Piano")
            # so downstream arrangement matching/filtering and the piano-highway
            # auto-select (which keys on arr_name.startswith("keys")) still work.
            arr_name = re.sub(r'\s*\d+$', '', arr_name).strip() or 'Keys'

        # Resolve pending slides now that every note on each string is known.
        # GPIF slide flags: 1=shift, 2=legato (both slide to the NEXT note on the
        # string); 4=slide out downwards, 8=slide out upwards (unpitched).
        if pending_slides:
            _resolve_pending_slides(rs_notes, rs_chords, pending_slides)

        # Build the arrangement XML *after* the optional piano merge so the
        # merged LH notes and the renamed arrangement actually reach the output.
        xml_str = _build_xml(
            title=title or 'Untitled',
            artist=artist or 'Unknown',
            album=album or '',
            year='',
            arrangement=arr_name or ('Drums' if is_drum else ('Keys' if is_keys else 'Lead')),
            tuning=tuning,
            num_strings=num_strings,
            song_length=song_length,
            audio_offset=audio_offset,
            beats=beats_out,
            sections=sections,
            notes=rs_notes,
            chords=rs_chords,
            chord_templates=chord_templates,
            anchors=anchors,
            tempo=int(tempo_bpm),
        )

        # Inject tone change markers for guitar/bass tracks
        if not is_drum and not is_keys and not is_vocal and track['string_pitches']:
            tone_events = _collect_tone_events(
                raw_idx, masterbars, bars_by_id, voices_dict,
                beats_dict, rhythms_dict, tempo_map, audio_offset,
                tempo_bpm=tempo_bpm,
            )
            if tone_events:
                xml_str = _inject_tones(xml_str, tone_events)

        filename = f"{_safe_filename_stem(track['name'])}_{arr_name or 'arr'}.xml"
        filepath = safe_join(out, filename)
        if filepath is None:
            raise ValueError(f"unsafe output filename from track name: {track['name']!r}")
        filepath.write_text(xml_str)
        output_files.append(str(filepath))

        # Keys/piano tracks additionally get a standard-notation sidecar
        # (`<stem>.notation.json`, sloppak-spec §5.3) so the sloppak assembly
        # step can attach a `notation_<id>.json` + manifest `notation:`
        # sub-key without re-walking the GP file. Best-effort: a notation bug
        # must never break the arrangement XML conversion itself.
        if is_keys:
            try:
                import gp2notation as _gp2notation
                _lh_idx = _piano_merge_map.get(track_idx)
                _payload = _gp2notation.convert_track_to_notation(
                    root, raw_idx, track['string_pitches'],
                    instrument='piano',
                    audio_offset=audio_offset,
                    track_name=track['name'],
                    lh_raw_idx=(
                        filtered_to_raw.get(_lh_idx, _lh_idx)
                        if _lh_idx is not None else None
                    ),
                    lh_string_pitches=(
                        tracks[_lh_idx]['string_pitches']
                        if _lh_idx is not None else None
                    ),
                )
                _gp2notation.write_notation_sidecar(filepath, _payload)
            except Exception:
                _log.exception(
                    "gp2notation: notation sidecar emission failed for track %r "
                    "— arrangement XML is unaffected", track['name'],
                )

    return output_files



# ---------------------------------------------------------------------------
# Vocal track detection and conversion
# ---------------------------------------------------------------------------

# MIDI programs associated with voice / choir / lead synth used for vocals in GP tabs
_VOCAL_MIDI_PROGRAMS = {52, 53, 54, 85, 86, 87}  # Choir Aahs, Voice Oohs, Synth Voice, Lead Voice
_VOCAL_NAME_KEYWORDS = {'vocal', 'voice', 'vox', 'sing', 'lyric', 'choir', 'lead voc', 'backing voc'}


def _is_vocal_track(track: dict) -> bool:
    """Return True if this track looks like a vocal/lyric part."""
    name_l = track['name'].lower()
    if any(kw in name_l for kw in _VOCAL_NAME_KEYWORDS):
        return True
    if track['midi_program'] in _VOCAL_MIDI_PROGRAMS and not track['is_drums']:
        return True
    return False


def _gpx_lyric_to_rs(raw: str) -> str:
    """
    Convert a GPX lyric token to the vocal lyric format.

    GPX encodes syllable continuation with a trailing hyphen (e.g. "in-", "t-").
    charts use the same convention for mid-word syllables.  For word-final
    syllables with no hyphen, RS requires a "+" suffix to signal "connect to
    next syllable without a space" — but only when the next beat is a
    continuation of the same word.  We handle this at the sequence level in
    convert_vocal_track() rather than per-token, so here we just normalise
    whitespace and pass through.

    Special GPX tokens:
        "+"  (rare) — word joiner used in some tabs; map to RS "+"
        " "  (empty/space) — rest beat with no lyric; skip at caller
    """
    raw = raw.strip()
    if not raw:
        return ''
    # GP sometimes uses "+" as an explicit word-joiner; keep it
    return raw


def convert_vocal_track(
    root: ET.Element,
    track: dict,
    raw_idx: int,
    masterbars: list,
    bars_by_id: dict,
    voices_dict: dict,
    beats_dict: dict,
    notes_dict: dict,
    rhythms_dict: dict,
    *,
    title: str = '',
    artist: str = '',
    album: str = '',
    tempo_bpm: float = 120.0,
    audio_offset: float = 0.0,
    arr_name: str = 'Vocals',
) -> str:
    """
    Convert a GPX vocal track to a chart vocals arrangement XML.

    Each beat with a lyric and a note becomes a <vocal> element:
        time   — seconds from song start + audio_offset
        note   — MIDI pitch (raw String+Fret value, no transposition applied;
                 see module docstring for a note on vocal transposition)
        length — duration in seconds (ties extend this)
        lyric  — syllable text, RS-formatted:
                   trailing "-" = mid-word hyphen (same as GPX)
                   trailing "+" = connect to next token (no space, no hyphen)
                   no suffix    = word end (RS inserts a space before next)

    Beats with a lyric but no pitch note are included as pitch-0 rests so the
    display timeline stays intact.  Beats with no lyric are skipped entirely.

    The output is a minimal but valid vocals XML.  It does not include
    ebeats or phrases (RS parses vocal XMLs without them).
    """
    string_pitches = track['string_pitches']  # high→low, standard guitar if vocal

    # ---------------------------------------------------------------------------
    # Pass 1: collect raw (time, duration, lyric, midi_note) tuples
    # ---------------------------------------------------------------------------
    raw_vocals: list[dict] = []   # {time, length, lyric, note, is_tie_origin}
    current_time = 0.0

    # Build per-bar tempo map for vocal timing (handles tempo changes correctly)
    _v_tempo_map = _build_tempo_map(root)
    _v_tempo_iter = iter(_v_tempo_map)
    _v_next_bar, _v_next_bpm = next(_v_tempo_iter, (999999, tempo_bpm))
    _v_cur_tempo = tempo_bpm

    for _v_mb_idx, mb in enumerate(masterbars):
        # Advance tempo
        while _v_mb_idx >= _v_next_bar:
            _v_cur_tempo = _v_next_bpm
            _v_next_bar, _v_next_bpm = next(_v_tempo_iter, (999999, _v_cur_tempo))

        time_sig = mb.findtext('Time', '4/4')
        try:
            num_b, den_b = [int(x) for x in time_sig.split('/')]
        except ValueError:
            num_b, den_b = 4, 4
        bar_duration = num_b * (4.0 / den_b) * (60.0 / _v_cur_tempo)

        bar_ids = mb.findtext('Bars', '').split()
        bid = bar_ids[raw_idx] if raw_idx < len(bar_ids) else '-1'

        if bid != '-1' and bid:
            bar = bars_by_id.get(bid)
            if bar is not None:
                for vid in bar.findtext('Voices', '').split():
                    if vid == '-1':
                        continue
                    voice = voices_dict.get(vid)
                    if voice is None:
                        continue

                    voice_time = current_time
                    for beat_id in voice.findtext('Beats', '').split():
                        beat_el = beats_dict.get(beat_id)
                        if beat_el is None:
                            continue

                        dur = _beat_dur_secs(beat_el, rhythms_dict, _v_cur_tempo)

                        # Extract lyric from beat
                        lyric_el = beat_el.find('Lyrics')
                        lyric_raw = ''
                        if lyric_el is not None:
                            line = lyric_el.find('Line')
                            if line is not None and line.text:
                                lyric_raw = line.text.strip()

                        # Extract pitch from note(s) on this beat
                        midi_note = 0
                        is_tie_origin = False
                        notes_text = beat_el.findtext('Notes', '').strip()
                        if notes_text:
                            for nid in notes_text.split():
                                note_el = notes_dict.get(nid)
                                if note_el is None:
                                    continue

                                # Tie destination: extend previous vocal's length
                                if _note_is_tie(note_el):
                                    if raw_vocals:
                                        raw_vocals[-1]['length'] = max(
                                            raw_vocals[-1]['length'],
                                            (voice_time + audio_offset + dur) - raw_vocals[-1]['time']
                                        )
                                    # Do NOT advance voice_time here — the
                                    # beat-end `voice_time += dur` below advances
                                    # exactly once per beat. Incrementing here too
                                    # double-advanced tied beats and drifted every
                                    # later vocal event.
                                    continue

                                # Tie origin: note continues into next beat
                                tie = note_el.find('Tie')
                                if tie is not None and tie.get('origin', '').lower() in ('true', '1'):
                                    is_tie_origin = True

                                midi = _note_midi(note_el, string_pitches)
                                if midi is not None:
                                    midi_note = midi
                                break  # one pitch per vocal beat

                        # Only emit if there is a lyric (beats without lyrics are rests)
                        if lyric_raw:
                            lyric = _gpx_lyric_to_rs(lyric_raw)
                            if lyric:
                                raw_vocals.append({
                                    'time': round(voice_time + audio_offset, 3),
                                    'length': round(dur, 3),
                                    'lyric': lyric,
                                    'note': midi_note,
                                    'is_tie_origin': is_tie_origin,
                                })

                        voice_time += dur

        current_time += bar_duration

    song_length = current_time + audio_offset

    # ---------------------------------------------------------------------------
    # Pass 2: apply RS lyric suffix convention
    #
    # GPX already marks mid-word syllables with trailing "-" (e.g. "in-", "e-").
    # RS additionally requires "+" on the last syllable of a word when the next
    # syllable is a direct continuation with no space.  In GPX this is implicitly
    # signalled by the next token having a leading lowercase letter (continuation)
    # vs an uppercase or punctuation-leading token (new word).  We use a simpler
    # heuristic: if this token ends with "-" it is already marked; otherwise it
    # is a word-end and needs no extra suffix (RS treats no-suffix as word-end).
    #
    # The one GPX convention we need to convert: some tabs use "+" as an explicit
    # join (no hyphen, no space).  These are passed through unchanged.
    # ---------------------------------------------------------------------------
    # (No transformation needed beyond what _gpx_lyric_to_rs already does —
    #  GPX "-" maps directly to RS "-" for mid-word breaks, and word-final tokens
    #  with no suffix are correct as-is.  No "+" insertion is required.)

    # ---------------------------------------------------------------------------
    # Pass 3: emit XML
    # ---------------------------------------------------------------------------
    return _build_vocals_xml(
        title=title or 'Untitled',
        artist=artist or 'Unknown',
        album=album or '',
        arrangement=arr_name,
        song_length=song_length,
        audio_offset=audio_offset,
        vocals=raw_vocals,
        tempo=int(tempo_bpm),
    )


def _build_vocals_xml(
    title: str,
    artist: str,
    album: str,
    arrangement: str,
    song_length: float,
    audio_offset: float,
    vocals: list[dict],
    tempo: int,
) -> str:
    """Build a chart vocals arrangement XML string."""
    from xml.dom import minidom

    # vocals arrangement is a flat <vocals> document — NOT a
    # <song> wrapper. Every lyric consumer in the codebase keys off the root
    # tag being literally "vocals" (lib/loosefolder.py, server.py highway
    # loader), so a <song> root would be silently skipped and the generated
    # lyrics never loaded. The schema is
    # just <vocals count="N"> with <vocal time note length lyric/> children;
    # the song-level metadata params are not part of it.
    root = ET.Element('vocals', count=str(len(vocals)))
    for v in vocals:
        ET.SubElement(root, 'vocal',
                      time=f"{v['time']:.3f}",
                      note=str(v['note']),
                      length=f"{v['length']:.3f}",
                      lyric=v['lyric'])

    xml_str = ET.tostring(root, encoding='unicode')
    dom = minidom.parseString(xml_str)
    return dom.toprettyxml(indent='  ', encoding=None)


def _gpx_tuning(track: dict) -> list[int]:
    """Compute RS tuning offsets (semitones from standard) from GPX string pitches."""
    from gp2rs import STANDARD_TUNING_GUITAR, STANDARD_TUNING_BASS
    pitches = track['string_pitches']
    n = len(pitches)
    if n == 0:
        return [0] * 6

    is_bass = max(pitches) <= 48
    if is_bass:
        # 5-string bass comes in two standards: high-C (C G D A E, top MIDI 48)
        # and low-B (G D A E B, top MIDI 43). Mirror gp2rs._standard_tuning_for:
        # midpoint is 45.5, so top >= 46 selects high-C (drop the low string
        # from the 6-string table); otherwise 4-string / low-B 5-string skips
        # the high C. max(pitches) is the top string regardless of array order.
        top_midi = max(pitches)
        if n == 5 and top_midi >= 46:
            standard = STANDARD_TUNING_BASS[:5]
        elif n <= 5:
            standard = STANDARD_TUNING_BASS[1:1 + n]
        else:
            standard = STANDARD_TUNING_BASS[:n]
    else:
        standard = STANDARD_TUNING_GUITAR[:n]

    # RS tuning is low->high (index 0 = lowest string). Sort both the actual and
    # standard pitches ascending so the offsets are correct regardless of the
    # GPX <Pitches> array direction — GP6 (.gpx) lists them high->low while GP8
    # (.gp) lists them low->high. Assuming high->low mirrored GP8 tunings.
    pit_asc = sorted(pitches)
    std_asc = sorted(standard)
    m = min(n, len(std_asc))
    offsets = [0] * n
    for i in range(m):
        offsets[i] = pit_asc[i] - std_asc[i]
    return offsets


def _auto_select_gpx(tracks: list[dict]) -> tuple[list[int], dict[int, str]]:
    """Auto-select guitar/bass/keys/drums tracks and assign arrangement names."""
    GUITAR_PROGS = set(range(24, 32))
    BASS_PROGS = set(range(32, 40))
    KEYS_PROGS = set(range(0, 8)) | set(range(16, 24)) | {80, 81, 82, 83}
    SKIP_NAMES = {'string', 'choir', 'brass', 'flute', 'violin', 'cello', 'horn'}

    selected = []
    for i, t in enumerate(tracks):
        # Skip note-empty tracks (placeholder / muted-empty) so auto-selection
        # doesn't emit unusable empty arrangements — matches the non-GPX path.
        if t.get('note_count', 1) == 0:
            continue
        if t['is_drums']:
            selected.append((i, 'drums'))
            continue

        name_l = t['name'].lower()

        if _is_vocal_track(t):
            selected.append((i, 'vocal'))
            continue

        if any(kw in name_l for kw in SKIP_NAMES) and not t['string_pitches']:
            continue

        is_bass = (t['string_pitches'] and max(t['string_pitches']) <= 48) \
            or t['midi_program'] in BASS_PROGS
        is_guitar = bool(t['string_pitches']) and not is_bass
        is_keys = (not t['string_pitches'] and t['midi_program'] in KEYS_PROGS) \
            or any(kw in name_l for kw in ('piano', 'keys', 'organ'))

        if is_bass:
            selected.append((i, 'bass'))
        elif is_guitar:
            selected.append((i, 'guitar'))
        elif is_keys:
            selected.append((i, 'keys'))

    if not selected:
        for i, t in enumerate(tracks):
            if not t['is_drums'] and t.get('note_count', 1) > 0:
                selected.append((i, 'guitar'))

    indices = []
    name_map = {}
    counts: dict[str, int] = {}
    RS_NAMES = {'guitar': ('Lead', 'Rhythm', 'Combo'), 'bass': ('Bass',), 'keys': ('Keys',), 'drums': ('Drums',), 'vocal': ('Vocals',)}

    for idx, role in selected:
        counts[role] = counts.get(role, 0) + 1
        c = counts[role]
        names_for_role = RS_NAMES.get(role, (role.title(),))
        arr_name = names_for_role[min(c - 1, len(names_for_role) - 1)]
        if c > len(names_for_role):
            arr_name = f"{names_for_role[-1]} {c}"
        indices.append(idx)
        name_map[idx] = arr_name

    return indices, name_map
