"""MIDI file import — list tracks and convert tracks to sloppak payloads.

Two parallel flows live here:

- **Keys path** (`list_midi_tracks` + `convert_midi_track_to_keys_wire`):
  filters channel-9 out and emits a standard guitar-style arrangement that
  the piano plugin decodes via `midi = string * 24 + fret`.

- **Drums path** (`list_drum_tracks` + `convert_drum_track_from_midi`):
  keeps channel-9 only and emits the `drum_tab.json` shape documented in
  `docs/sloppak-spec.md` §5.3, ready to drop alongside the sloppak
  manifest's `drum_tab:` key.

The editor's track picker uses both for the +Drums and +Keys modals.
"""

from __future__ import annotations

import math
from bisect import bisect_right
from collections import deque
from typing import Callable

import mido

import drums as drums_mod


# General MIDI piano-family programs (0-7) plus chromatic percussion + organ.
# Used to flag obvious keyboard tracks for the picker UI.
_KEY_PROGRAMS = set(range(0, 24))
_KEYBOARD_NAME_HINTS = (
    "piano", "keys", "keyboard", "synth", "organ", "rhodes",
    "harpsichord", "clavinet", "wurlitzer", "ep ", "epiano",
)


def list_midi_tracks(midi_path: str) -> list[dict]:
    """Return a list of track descriptors suitable for the picker UI.

    Format-0 MIDI files store every channel in a single track; if we just
    enumerated `midi.tracks` we'd produce one picker entry that merged
    every part into a single Keys arrangement. For format-0 only, split
    that single track into one virtual entry per non-drum channel so the
    user can isolate the piano part.

    Type-1 (parallel tracks) and type-2 (independent sequences) keep their
    one-entry-per-track shape: their tracks already represent the parts
    the author intended, and a track that uses e.g. LH/RH on separate
    channels would otherwise lose half its notes when the user picked
    just one of the split entries with no way to recover the merged form.

    Drum (channel-9) channels are dropped from the listing here — the
    keys-import converter unconditionally skips channel-9 events, so a
    drums entry would yield an empty arrangement. Use `list_drum_tracks`
    + `convert_drum_track_from_midi` for the MIDI drum-import flow.

    Each item: {index, name, instrument, notes, channel, is_piano, is_drums,
    channel_filter}. For split entries `channel_filter` is set; for
    unsplit entries it's None.
    """
    midi = mido.MidiFile(midi_path)
    tracks: list[dict] = []
    midi_type = getattr(midi, "type", 1)
    # Only format-0 collapses every part into one track and therefore
    # benefits from per-channel splitting. Type-1/2 tracks already
    # represent author-defined parts.
    split_format = (midi_type == 0)

    for i, track in enumerate(midi.tracks):
        name = ""
        # Per-channel stats, populated by walking the track once.
        per_channel: dict[int, dict] = {}

        for msg in track:
            if msg.type == "track_name" and not name:
                name = msg.name or ""
            elif msg.type == "program_change":
                ch = int(getattr(msg, "channel", -1))
                slot = per_channel.setdefault(ch, {"program": -1, "notes": 0})
                if slot["program"] < 0:
                    slot["program"] = int(msg.program)
            elif msg.type == "note_on" and int(getattr(msg, "velocity", 0)) > 0:
                ch = int(getattr(msg, "channel", -1))
                slot = per_channel.setdefault(ch, {"program": -1, "notes": 0})
                slot["notes"] += 1

        # Drop channels that never produced a note (tempo/meta-only entries
        # would just clutter the picker) AND drop drum channels — the
        # keys-import converter skips channel-9 events unconditionally,
        # so a drums entry would always yield an empty arrangement.
        active_channels = sorted(
            ch for ch, info in per_channel.items()
            if info["notes"] > 0 and ch != 9
        )

        if not active_channels:
            # Track with no melodic notes (silent or drums-only). Skip.
            continue

        # Format-0 with multiple non-drum channels is the only case where
        # we split. Type-1/2 keep one-entry-per-track so the user can
        # always import the whole part.
        split = split_format and len(active_channels) > 1

        if split:
            iter_channels = active_channels
        else:
            # One merged entry; channel comes from the first active one
            # for display purposes (and in case the converter ever needs
            # a hint, though channel_filter=None means "merge all").
            iter_channels = [active_channels[0]]

        for ch in iter_channels:
            info = per_channel[ch]
            program = info["program"]
            note_count = (
                info["notes"] if split
                else sum(per_channel[c]["notes"] for c in active_channels)
            )

            if split:
                channel_label = f"Ch{ch + 1}"
                base = name or f"Track {i}"
                entry_name = f"{base} — {channel_label}"
            else:
                entry_name = name or f"Track {i}"

            # Classify on the per-channel program first. The track-level
            # name hint is a tiebreaker only when no program_change was
            # seen for this channel — otherwise a track named "Piano"
            # that hosts bass on ch2 would wrongly flag ch2 as piano in
            # the format-0 split case. For non-split tracks the name
            # hint still carries weight (single-channel tracks usually
            # share track name + program intent).
            if program in _KEY_PROGRAMS:
                is_piano = True
            elif program < 0 and not split:
                # Program unknown for this single-channel track — fall
                # back to the track-name heuristic.
                name_lower = entry_name.lower()
                is_piano = any(hint in name_lower for hint in _KEYBOARD_NAME_HINTS)
            else:
                is_piano = False

            tracks.append({
                "index": i,
                # When set, the converter filters the track's events to this
                # channel only. None means "use every non-drum channel".
                "channel_filter": ch if split else None,
                "name": entry_name,
                "instrument": program,
                "notes": note_count,
                "channel": ch,
                "is_piano": bool(is_piano),
                # `is_drums` is always False on emitted entries because we
                # filter channel 9 above. Kept for shape compatibility
                # with the GP picker entries the frontend also reads.
                "is_drums": False,
                "strings": 0,
                "is_percussion": False,
            })

    return tracks


def convert_midi_track_to_keys_wire(
    midi_path: str,
    track_index: int,
    audio_offset: float = 0.0,
    name: str = "Keys",
    channel_filter: int | None = None,
) -> dict:
    """Convert a single MIDI track into a sloppak-format keys arrangement.

    Encodes each MIDI note as the piano plugin expects: string = pitch // 24,
    fret = pitch % 24 (so noteToMidi(s, f) = s * 24 + f recovers the pitch).
    Returns a wire-format arrangement dict ready to be written to
    arrangements/<id>.json.

    audio_offset (seconds) is added to every note's start time. Useful as a
    coarse pre-sync handle; finer alignment happens in the editor.

    channel_filter (optional): when set, only events on this channel are
    processed. Used by the picker to isolate one channel out of a format-0
    track that mixes multiple instruments.

    CC64 (sustain pedal) is honored: when a key is released while the pedal
    is held, the note's end time is extended to the pedal-up event on the
    same channel. Pedal-down/up transitions are tracked per channel.
    """
    midi = mido.MidiFile(midi_path)
    if track_index < 0 or track_index >= len(midi.tracks):
        raise ValueError(f"track_index {track_index} out of range")

    # Build a tempo map. The right scope depends on the SMF format:
    #   - type 0 (single track holding everything): the lone track is also
    #     the source of tempo events. Walking it (and only it) is correct.
    #   - type 1 (parallel tracks, shared timeline): tempo events live on
    #     the conductor track (usually track 0) but the spec allows them
    #     anywhere. Merge across all tracks so we don't miss any.
    #   - type 2 (independent sequential tracks, each its own timeline):
    #     a foreign track's tempo events do NOT apply to the chosen
    #     track. Merging would mis-time the notes — restrict the tempo
    #     scan to the selected track only.
    # ``ticks_per_beat`` is 0 for a malformed header and NEGATIVE for SMPTE
    # division (mido returns the signed short as-is). Both feed the two
    # divisions below (tempo-table build + tick_to_seconds), so guard here:
    # 0 would raise ZeroDivisionError and a negative value would yield
    # negative/garbage times. Use ``> 0`` (not ``or``) so the negative SMPTE
    # case also falls back to the SMF default.
    ticks_per_beat = midi.ticks_per_beat if midi.ticks_per_beat > 0 else 480
    raw_events: list[tuple[int, int]] = [(0, 500000)]  # default 120 BPM
    midi_type = getattr(midi, "type", 1)
    tempo_source = (
        [midi.tracks[track_index]] if midi_type == 2 else midi.tracks
    )
    for track in tempo_source:
        abs_tick = 0
        for msg in track:
            abs_tick += msg.time
            if msg.type == "set_tempo":
                raw_events.append((abs_tick, int(msg.tempo)))
    raw_events.sort(key=lambda e: e[0])
    # Deduplicate at same tick (keep the last one written).
    deduped: list[tuple[int, int]] = []
    for ev in raw_events:
        if deduped and deduped[-1][0] == ev[0]:
            deduped[-1] = ev
        else:
            deduped.append(ev)

    # Precompute (tick, seconds_at_tick, microseconds_per_beat). seconds_at_tick
    # is the cumulative time up to that tempo-change event.
    tempo_table: list[tuple[int, float, int]] = []
    cum_seconds = 0.0
    prev_tick = 0
    prev_tempo = deduped[0][1]
    for ev_tick, ev_tempo in deduped:
        cum_seconds += (ev_tick - prev_tick) * (prev_tempo / 1_000_000.0) / ticks_per_beat
        tempo_table.append((ev_tick, cum_seconds, ev_tempo))
        prev_tick = ev_tick
        prev_tempo = ev_tempo
    tempo_ticks = [row[0] for row in tempo_table]

    def tick_to_seconds(tick: int) -> float:
        """O(log N) tempo-aware tick→seconds via cumulative table + bisect."""
        i = bisect_right(tempo_ticks, tick) - 1
        if i < 0:
            i = 0
        base_tick, base_seconds, tempo = tempo_table[i]
        return base_seconds + (tick - base_tick) * (tempo / 1_000_000.0) / ticks_per_beat

    # Walk the requested track, collect note_on/note_off pairs. To handle
    # rapid retriggers (same pitch starting again before the previous
    # note_off), keep a stack of start ticks per (channel, pitch).
    #
    # Sustain pedal (CC64): when value >= 64, the channel is "pedal down"
    # and key-release events don't truncate the note — they move the
    # pending start onto `pedal_pending`, where it waits for the pedal-up
    # transition. Pedal-up finalises every pending note on that channel
    # using the pedal-up tick as the end.
    track = midi.tracks[track_index]
    abs_tick = 0
    active: dict[tuple[int, int], deque[int]] = {}
    pedal_pending: dict[int, list[tuple[int, int]]] = {}  # ch -> [(pitch, start_tick)]
    pedal_down: dict[int, bool] = {}
    notes_out: list[dict] = []

    def _emit(pitch: int, start_tick: int, end_tick: int) -> None:
        t = tick_to_seconds(start_tick) + float(audio_offset)
        end = tick_to_seconds(end_tick) + float(audio_offset)
        notes_out.append({
            "t": round(t, 3),
            "s": int(pitch // 24),
            "f": int(pitch % 24),
            "sus": round(max(0.0, end - t), 3),
            "sl": -1, "slu": -1, "bn": 0,
            "ho": False, "po": False, "hm": False, "hp": False,
            "pm": False, "mt": False, "tr": False, "ac": False, "tp": False,
        })

    for msg in track:
        abs_tick += msg.time
        msg_ch = int(getattr(msg, "channel", -1))
        # Channel filter: when the picker entry was a format-0 split, only
        # process events on the chosen channel. Channel-less meta events
        # (set_tempo, etc.) have channel == -1 and pass through unaffected
        # because the message types we act on below all have a channel.
        if channel_filter is not None and msg_ch != -1 and msg_ch != channel_filter:
            continue

        if msg.type == "note_on" and int(getattr(msg, "velocity", 0)) > 0:
            if msg_ch == 9:
                continue  # skip percussion
            pitch = int(msg.note)
            active.setdefault((msg_ch, pitch), deque()).append(abs_tick)
        elif msg.type == "note_off" or (
            msg.type == "note_on" and int(getattr(msg, "velocity", 0)) == 0
        ):
            pitch = int(msg.note)
            stack = active.get((msg_ch, pitch))
            if not stack:
                continue
            # FIFO match against the oldest still-active start so overlapping
            # retriggers each get a sensible end time.
            start_tick = stack.popleft()
            if not stack:
                active.pop((msg_ch, pitch), None)
            if pedal_down.get(msg_ch, False):
                # Defer: extend the note until pedal-up.
                pedal_pending.setdefault(msg_ch, []).append((pitch, start_tick))
            else:
                _emit(pitch, start_tick, abs_tick)
        elif msg.type == "control_change" and int(getattr(msg, "control", -1)) == 64:
            was_down = pedal_down.get(msg_ch, False)
            now_down = int(getattr(msg, "value", 0)) >= 64
            pedal_down[msg_ch] = now_down
            if was_down and not now_down:
                # Pedal-up: finalise every pending note on this channel.
                pending = pedal_pending.pop(msg_ch, [])
                for pitch, start_tick in pending:
                    _emit(pitch, start_tick, abs_tick)

    # End-of-track: close anything still active or held by the pedal,
    # using abs_tick as the end. Pedaled notes that never saw a pedal-up
    # land here too.
    for (_ch, pitch), starts in active.items():
        for start_tick in starts:
            _emit(pitch, start_tick, abs_tick)
    active.clear()
    for _ch, pending in pedal_pending.items():
        for pitch, start_tick in pending:
            _emit(pitch, start_tick, abs_tick)
    pedal_pending.clear()

    notes_out.sort(key=lambda n: n["t"])

    return {
        "name": name,
        "tuning": [0, 0, 0, 0, 0, 0],
        "capo": 0,
        "notes": notes_out,
        "chords": [],
        "anchors": [],
        "handshapes": [],
        "templates": [],
    }


# ── Tempo + drum-import shared helpers ───────────────────────────────────────

def _build_tick_to_seconds(midi: mido.MidiFile, track_index: int) -> Callable[[int], float]:
    """Return an `(abs_tick) -> seconds` function for the chosen track.

    Tempo-event scope depends on the SMF format (mirrors the keys converter):
      - type 0: single track holds tempo + notes; walk it alone.
      - type 1: parallel tracks share the timeline; merge tempo events.
      - type 2: independent timelines; tempo only from the chosen track.
    """
    # A metrical header carries positive ticks-per-beat. mido reads the SMF
    # division as a signed short, so an SMPTE-division file surfaces as a
    # negative value and a malformed header as 0 — both make the two division
    # sites below divide by a non-positive number (ZeroDivisionError, or
    # negative seconds that send the bar walk off the rails). Fall back to the
    # SMF default here, the single place every caller routes ticks through, so
    # each caller's own fallback is real rather than cosmetic.
    ticks_per_beat = midi.ticks_per_beat if midi.ticks_per_beat > 0 else 480
    raw_events: list[tuple[int, int]] = [(0, 500000)]  # default 120 BPM
    midi_type = getattr(midi, "type", 1)
    tempo_source = (
        [midi.tracks[track_index]] if midi_type == 2 else midi.tracks
    )
    for tr in tempo_source:
        abs_tick = 0
        for msg in tr:
            abs_tick += msg.time
            if msg.type == "set_tempo":
                raw_events.append((abs_tick, int(msg.tempo)))
    raw_events.sort(key=lambda e: e[0])
    deduped: list[tuple[int, int]] = []
    for ev in raw_events:
        if deduped and deduped[-1][0] == ev[0]:
            deduped[-1] = ev
        else:
            deduped.append(ev)

    tempo_table: list[tuple[int, float, int]] = []
    cum_seconds = 0.0
    prev_tick = 0
    prev_tempo = deduped[0][1]
    for ev_tick, ev_tempo in deduped:
        cum_seconds += (ev_tick - prev_tick) * (prev_tempo / 1_000_000.0) / ticks_per_beat
        tempo_table.append((ev_tick, cum_seconds, ev_tempo))
        prev_tick = ev_tick
        prev_tempo = ev_tempo
    tempo_ticks = [row[0] for row in tempo_table]

    def tick_to_seconds(tick: int) -> float:
        i = bisect_right(tempo_ticks, tick) - 1
        if i < 0:
            i = 0
        base_tick, base_seconds, tempo = tempo_table[i]
        return base_seconds + (tick - base_tick) * (tempo / 1_000_000.0) / ticks_per_beat

    return tick_to_seconds


# Safety valve for the bar walk below: a malformed SMF (absurd tempo + long
# trailing meta) could otherwise imply millions of bars. Real charts sit
# orders of magnitude below this.
_TEMPO_MAP_MAX_BARS = 20000


def convert_midi_tempo_map(midi_path: str, track_index: int = 0) -> dict:
    """Extract the song-timeline grid a `.mid` file carries: tempos, time
    signatures, and a full beat grid — the data the note converters here
    always computed internally (to bake note times) and then threw away,
    which left every MIDI import with no bars, no measures, and an implied
    4/4 no matter what the file said.

    Returns ``{"tempos": [...], "time_signatures": [...], "beats": [...]}``:

    - ``tempos``: ``{time, bpm}`` per tempo event (deduped per tick).
    - ``time_signatures``: ``{time, ts: [num, den]}`` per signature event —
      the song-timeline sidecar shape (feedpak-spec §7.4).
    - ``beats``: one row per beat on the editor grid shape — downbeats carry
      a running ``measure`` (1, 2, 3, …) plus a ``den`` hint (the signature
      denominator), interior beats carry ``measure: -1``. The beat unit
      follows the active signature (6/8 ⇒ six eighth-note rows per bar).

    Event scope mirrors ``_build_tick_to_seconds``: SMF type 0/1 merge meta
    from all tracks (shared timeline); type 2 reads ONLY ``track_index``
    (independent timelines — callers must never share one grid across
    type-2 tracks). Signature changes apply at the NEXT bar boundary when a
    file places one mid-bar (ill-formed but seen in the wild). All times
    are computed from absolute ticks through the cumulative tempo table and
    rounded once at emit — rounding error never accumulates with song
    length. An SMF with no note events yields empty ``beats``.
    """
    midi = mido.MidiFile(midi_path)
    # Positive for metrical files; 0 (malformed) or negative (SMPTE division,
    # read as a signed short) otherwise — fall back so beat_ticks below stays
    # sane, mirroring the guard inside _build_tick_to_seconds.
    ticks_per_beat = midi.ticks_per_beat if midi.ticks_per_beat > 0 else 480
    midi_type = getattr(midi, "type", 1)
    # Same scope both converters use: type 2 reads only the chosen track
    # (independent timelines); type 0/1 merge all tracks (shared timeline).
    source_tracks = (
        [midi.tracks[track_index]] if midi_type == 2 else midi.tracks
    )
    tick_to_seconds = _build_tick_to_seconds(midi, track_index)

    # ── collect meta + the end of musical content in one pass ────────────
    sig_events: list[tuple[int, int, int]] = []
    tempo_events: list[tuple[int, int]] = []
    end_tick = 0
    for tr in source_tracks:
        abs_tick = 0
        for msg in tr:
            abs_tick += msg.time
            if msg.type == "time_signature":
                num = int(getattr(msg, "numerator", 4) or 4)
                den = int(getattr(msg, "denominator", 4) or 4)
                if num > 0 and den > 0:
                    sig_events.append((abs_tick, num, den))
            elif msg.type == "set_tempo":
                tempo_events.append((abs_tick, int(msg.tempo)))
            elif msg.type in ("note_on", "note_off"):
                end_tick = max(end_tick, abs_tick)

    # Dedupe at equal ticks (last wins), matching the tempo-table rule.
    sig_events.sort(key=lambda e: e[0])
    sigs: list[tuple[int, int, int]] = []
    for ev in sig_events:
        if sigs and sigs[-1][0] == ev[0]:
            sigs[-1] = ev
        else:
            sigs.append(ev)
    if not sigs or sigs[0][0] > 0:
        sigs.insert(0, (0, 4, 4))

    tempo_events.sort(key=lambda e: e[0])
    seen_tempo_ticks: dict[int, int] = {}
    for ev_tick, ev_tempo in tempo_events:
        seen_tempo_ticks[ev_tick] = ev_tempo
    sorted_tempo_ticks = sorted(seen_tempo_ticks)
    tempos_out: list[dict] = []
    # Seed the MIDI default (120 BPM) at time 0 when the first tempo event
    # lands after the start (or there are none). The beat grid already runs
    # at 120 for the head of the song, so the sidecar must say so too —
    # symmetric with the (0, 4, 4) default seeded into the signatures above.
    if not sorted_tempo_ticks or sorted_tempo_ticks[0] > 0:
        tempos_out.append({"time": 0.0, "bpm": 120.0})
    for ev_tick in sorted_tempo_ticks:
        tempos_out.append({
            "time": round(tick_to_seconds(ev_tick), 3),
            "bpm": round(60_000_000.0 / seen_tempo_ticks[ev_tick], 3),
        })

    time_signatures_out = [
        {"time": round(tick_to_seconds(t), 3), "ts": [num, den]}
        for t, num, den in sigs
    ]

    # ── walk bars from tick 0 to the end of the notes ────────────────────
    beats: list[dict] = []
    if end_tick > 0:
        cur_tick = 0.0
        measure = 1
        sig_idx = 0
        while cur_tick < end_tick and measure <= _TEMPO_MAP_MAX_BARS:
            # Active signature: the latest event at or before this bar's
            # start. Mid-bar events wait for the next boundary by
            # construction (we only re-read between bars).
            while (sig_idx + 1 < len(sigs)
                    and sigs[sig_idx + 1][0] <= cur_tick + 1e-6):
                sig_idx += 1
            _, num, den = sigs[sig_idx]
            beat_ticks = ticks_per_beat * 4.0 / den
            beats.append({
                "time": round(tick_to_seconds(int(round(cur_tick))), 3),
                "measure": measure,
                "den": den,
            })
            for k in range(1, num):
                sub_tick = cur_tick + k * beat_ticks
                if sub_tick >= end_tick:
                    break
                beats.append({
                    "time": round(tick_to_seconds(int(round(sub_tick))), 3),
                    "measure": -1,
                })
            cur_tick += num * beat_ticks
            measure += 1

    return {
        "tempos": tempos_out,
        "time_signatures": time_signatures_out,
        "beats": beats,
    }


# ── Drum track listing (channel-9 only) ──────────────────────────────────────

# Velocity below this is treated as a ghost note. GM doesn't have an explicit
# ghost flag; chartists encode dynamics through velocity. 40 is the same
# threshold the drums plugin uses for ghost-note styling.
_GHOST_VELOCITY = 40

# Two hits on the same piece closer together than this are interpreted as a
# flam (the later one carries `f: true`). 30 ms matches the drums plugin's
# leading-glyph offset for flam rendering.
_FLAM_WINDOW_S = 0.030

# A cymbal note whose explicit note-off arrives within this window after the
# note-on is treated as a choke (the chartist clamped the cymbal). 120 ms
# matches the spec's mention of choke tail durations.
_CHOKE_MAX_S = 0.120


def list_drum_tracks(midi_path: str) -> list[dict]:
    """List tracks that contain GM channel-9 (percussion) note_on events.

    For format-0 files (everything in one track, channels intermixed), this
    surfaces the lone track once when it has channel-9 hits. For format-1/2
    files, each track that fires channel-9 notes shows up. Mirrors
    `list_midi_tracks` so the editor's +Drums modal can show the same shape
    of picker entry the +Keys modal does.

    Each item: {index, name, instrument, notes, channel, is_piano,
    is_drums, strings, is_percussion, channel_filter} — the same
    picker-entry shape `list_midi_tracks` emits, so the editor frontend
    can consume either list uniformly. For drum tracks the classification
    fields are fixed: `is_drums`/`is_percussion` True, `is_piano` False,
    `instrument` -1, `strings` 0. `channel_filter` is always 9 — the
    converter uses it to skip non-drum events on a mixed-channel track.
    """
    midi = mido.MidiFile(midi_path)
    out: list[dict] = []
    for i, track in enumerate(midi.tracks):
        name = ""
        note_count = 0
        for msg in track:
            if msg.type == "track_name" and not name:
                name = msg.name or ""
            elif (
                msg.type == "note_on"
                and int(getattr(msg, "velocity", 0)) > 0
                and int(getattr(msg, "channel", -1)) == 9
            ):
                note_count += 1
        if note_count == 0:
            continue
        out.append({
            "index": i,
            "channel_filter": 9,
            "name": name or f"Track {i} (drums)",
            "instrument": -1,
            "notes": note_count,
            "channel": 9,
            "is_piano": False,
            "is_drums": True,
            "strings": 0,
            "is_percussion": True,
        })
    return out


def convert_drum_track_from_midi(
    midi_path: str,
    track_index: int,
    audio_offset: float = 0.0,
    name: str = "Drums",
    *,
    out_unmapped: dict[int, dict] | None = None,
) -> dict:
    """Convert a MIDI drum track to a `drum_tab.json` dict.

    Reads channel-9 note_on events on the chosen track, maps each MIDI note
    to a piece-id via `lib.drums.midi_to_piece`, and emits hits with
    velocity preserved verbatim. Three heuristics encode articulations that
    GM MIDI doesn't have explicit flags for:

    - **Ghost**: velocity < 40 → `g: true`.
    - **Flam**: two hits on the same piece within 30 ms → the louder one
      (the main strike) carries `f: true` and the quieter grace note is
      dropped (the renderer draws the leading glyph itself from the `f`
      flag). Typically the grace note arrives first in time, but the
      heuristic is velocity-based to handle MIDI files where encoding
      order differs from chronological order.
    - **Choke**: a cymbal note-off arriving within 120 ms of its note-on
      sets `k` to the actual on→off duration.

    Callers can pass an empty dict as ``out_unmapped`` to receive a
    per-MIDI record of every channel-9 note_on that didn't resolve to a
    piece-id (``{midi: {"count": int, "times": [float, ...],
    "velocities": [int, ...]}}``, times/velocities index-aligned and
    capped at 100 samples per note — velocities carry the source notes'
    real dynamics so a hand-mapping UI doesn't have to flatten them to a
    default). The default path skips this capture entirely so MIDIs
    heavy with cowbell/tambourine/etc. take no extra work.
    """
    offset = float(audio_offset)
    if not math.isfinite(offset):
        raise ValueError(f"audio_offset must be a finite number, got {audio_offset!r}")

    midi = mido.MidiFile(midi_path)
    if track_index < 0 or track_index >= len(midi.tracks):
        raise ValueError(f"track_index {track_index} out of range")

    tick_to_seconds = _build_tick_to_seconds(midi, track_index)
    track = midi.tracks[track_index]

    # Two passes: collect raw note_on/note_off pairs in pass 1 (so we know
    # each on's actual off time for choke detection), then apply the
    # flam-collapse + serialisation in pass 2.
    raw: list[dict] = []  # one entry per note_on
    # Use list[int] per MIDI note so overlapping/retriggered hits (note_on
    # before note_off for the same note) are each tracked independently
    # rather than the later one overwriting the earlier one's index.
    open_hits: dict[int, deque[int]] = {}  # midi note -> FIFO queue of indices in `raw`
    abs_tick = 0
    for msg in track:
        abs_tick += msg.time
        if int(getattr(msg, "channel", -1)) != 9:
            continue
        if msg.type == "note_on" and int(getattr(msg, "velocity", 0)) > 0:
            midi_note = int(msg.note)
            piece = drums_mod.midi_to_piece(midi_note)
            if piece is None:
                # Default path: drop silently. Only pay the tick->seconds
                # cost on the opt-in capture path so MIDIs full of unmapped
                # percussion don't take a perf hit when the caller didn't
                # ask for unmapped reporting.
                if out_unmapped is None:
                    continue
                t = tick_to_seconds(abs_tick) + offset
                entry = out_unmapped.setdefault(
                    midi_note, {"count": 0, "times": [], "velocities": []})
                entry["count"] += 1
                if len(entry["times"]) < 100:
                    entry["times"].append(round(t, 3))
                    # Index-aligned with times: the note's real dynamics,
                    # so hand-mapping doesn't flatten everything to 100.
                    entry["velocities"].append(int(msg.velocity))
                continue
            # Mapped note: compute t once for the raw entry.
            t = tick_to_seconds(abs_tick) + offset
            raw.append({
                "t": t,
                "p": piece,
                "v": int(msg.velocity),
                "_midi": midi_note,
                "_on_tick": abs_tick,
            })
            open_hits.setdefault(midi_note, deque()).append(len(raw) - 1)
        elif msg.type == "note_off" or (
            msg.type == "note_on" and int(getattr(msg, "velocity", 0)) == 0
        ):
            midi_note = int(msg.note)
            stack = open_hits.get(midi_note)
            if not stack:
                continue
            idx = stack.popleft()  # FIFO: oldest note_on matches this note_off
            if not stack:
                del open_hits[midi_note]
            hit = raw[idx]
            if drums_mod.piece_category(hit["p"]) != "cymbal":
                continue
            on_secs = tick_to_seconds(hit["_on_tick"])
            off_secs = tick_to_seconds(abs_tick)
            dur = off_secs - on_secs
            if 0.0 < dur <= _CHOKE_MAX_S:
                hit["k"] = round(dur, 3)

    raw.sort(key=lambda h: (h["t"], h["p"]))

    # Flam collapse: for each hit, compare it against the most-recent
    # previous hit of the SAME piece (not just the globally adjacent entry),
    # so an intervening hit from a different piece does not break flam
    # detection for densely-played patterns (e.g. kick + snare flam).
    flam_indices: set[int] = set()
    drop_indices: set[int] = set()
    last_by_piece: dict[str, int] = {}  # piece-id -> index in raw[]
    for i, curr in enumerate(raw):
        piece = curr["p"]
        prev_i = last_by_piece.get(piece)
        if prev_i is not None and prev_i not in drop_indices:
            prev = raw[prev_i]
            if (curr["t"] - prev["t"]) <= _FLAM_WINDOW_S:
                # Prefer the louder hit as the "main"; the quieter is the
                # leading grace. The main hit receives `f: true` so the
                # renderer draws a small grace glyph slightly ahead of it.
                if prev["v"] <= curr["v"]:
                    drop_indices.add(prev_i)
                    flam_indices.add(i)
                else:
                    drop_indices.add(i)
                    flam_indices.add(prev_i)
                # Don't advance last_by_piece — keep prev_i as anchor so a
                # triple flam doesn't chain two drops.
                continue
        last_by_piece[piece] = i

    out_hits: list[dict] = []
    for i, hit in enumerate(raw):
        if i in drop_indices:
            continue
        # Round here (not at append time) so flam comparisons above used full precision.
        new_hit: dict = {"t": round(hit["t"], 3), "p": hit["p"]}
        vel = hit["v"]
        if 1 <= vel <= 127:
            new_hit["v"] = vel
        if vel < _GHOST_VELOCITY:
            new_hit["g"] = True
        if i in flam_indices:
            new_hit["f"] = True
        if "k" in hit:
            new_hit["k"] = hit["k"]
        out_hits.append(new_hit)

    # Build kit legend from the union of piece-ids that survived.
    seen_pieces: list[str] = []
    seen_set: set[str] = set()
    for h in out_hits:
        if h["p"] not in seen_set:
            seen_set.add(h["p"])
            seen_pieces.append(h["p"])

    return {
        "version": drums_mod.SCHEMA_VERSION,
        "name": name,
        "kit": [
            {"id": pid, "name": pid.replace("_", " ").title()}
            for pid in seen_pieces
        ],
        "hits": out_hits,
    }
