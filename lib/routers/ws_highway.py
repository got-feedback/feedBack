"""The highway chart WebSocket — /ws/highway/{filename}.

The single largest handler in server.py, extracted to its own router (R3). Path
constants are read through the appstate seam (appstate.static_dir /
sloppak_cache_dir / audio_cache_dir / config_dir); the smart-arrangement /
author / offset helpers it exclusively uses move with it. Everything else is
nested inside the handler or imported from the shared lib modules. Logs through
the same `feedBack.server` logger name, so existing filters resolve unchanged.
"""

import asyncio
import bisect
import contextvars
import hashlib
import json
import logging
import math
import os
import shutil
import uuid
from pathlib import Path

import structlog

from fastapi import APIRouter, WebSocket, WebSocketDisconnect

from song import (
    anchor_to_wire,
    arrangement_is_bass,
    arrangement_string_count,
    base_open_string_midis,
    chord_template_to_wire,
    chord_to_wire,
    compute_smart_names,
    hand_shape_to_wire,
    key_to_tonic_pc,
    load_song,
    note_to_wire,
    phrase_to_wire,
    pitch_from_base,
    scale_degree_for_pitch,
)
from audio import find_wem_files, convert_wem
import sloppak as sloppak_mod
import drums as drums_mod
import notation as notation_mod
import loosefolder as loosefolder_mod
from metadata_db import _arr_smart_sort_key
from dlc_paths import _get_dlc_dir, _resolve_dlc_path

import appstate

log = logging.getLogger("feedBack.server")

router = APIRouter()


def _pick_smart_arrangement(
    arrangements: list,
    smart_names: list,
    pref: str,
) -> int:
    """Return the best arrangement index for `pref` using smart-name priority.

    Priority order:
    1. Exact match  — smart_name == pref  (e.g. "Lead")
    2. Alt. variants — "Alt. Lead", "Alt. Lead 1", ...
    3. Bonus variants — "Bonus Lead", "Bonus Lead 1", ...
    4. First arrangement in smart sort order (Lead > Rhythm > Bass > ...)

    Returns -1 when `pref` is empty / "Auto" or `arrangements` is empty
    (caller falls through to the existing most-notes fallback).
    """
    pref = (pref or "").strip()
    if not pref or pref.lower() == "auto" or not arrangements:
        return -1

    sorted_pairs = sorted(
        enumerate(smart_names),
        key=lambda x: _arr_smart_sort_key({"smart_name": x[1]}),
    )

    alt_prefix = f"Alt. {pref}"
    bonus_prefix = f"Bonus {pref}"

    for i, sn in sorted_pairs:
        if sn == pref:
            return i

    for i, sn in sorted_pairs:
        if sn and (sn == alt_prefix or sn.startswith(alt_prefix + " ")):
            return i

    for i, sn in sorted_pairs:
        if sn and (sn == bonus_prefix or sn.startswith(bonus_prefix + " ")):
            return i

    if sorted_pairs:
        return sorted_pairs[0][0]
    return 0


def _sanitized_song_offset(song) -> float:
    """Return song.offset coerced to a finite float, or 0.0.

    Malformed loose-folder XMLs can put `NaN`/`Infinity` into <offset>;
    Python's `float()` happily accepts those, but Starlette's JSON
    encoder then emits the literal `NaN` token which is invalid JSON
    and breaks the frontend's song_info parsing.
    """
    try:
        v = float(getattr(song, "offset", 0.0))
    except (TypeError, ValueError):
        return 0.0
    return v if math.isfinite(v) else 0.0


def _sanitize_authors(manifest: dict | None) -> list[dict]:
    """Extract a display-safe contributor list from a feedpak manifest.

    The feedpak spec (§5.4) defines an OPTIONAL top-level `authors` list of
    objects `{name (required), role?, email?, url?}`. We surface only `name`
    and `role` to the highway — contact fields (email/url) are intentionally
    dropped from the on-screen credits. Malformed entries (non-dict, missing /
    blank name) are skipped; absent / non-list `authors` yields `[]`.
    """
    if not isinstance(manifest, dict):
        return []
    raw = manifest.get("authors")
    if not isinstance(raw, list):
        return []
    out: list[dict] = []
    for entry in raw:
        if not isinstance(entry, dict):
            continue
        name = entry.get("name")
        if not isinstance(name, str) or not name.strip():
            continue
        role = entry.get("role")
        out.append({
            "name": name.strip(),
            "role": role.strip() if isinstance(role, str) and role.strip() else None,
        })
    return out


def _drum_part_id_for_wire(drum_parts: list[dict] | None, selected_id: str | None) -> str | None:
    """Expose a part id only when the pack genuinely has multiple parts."""
    return selected_id if selected_id is not None and len(drum_parts or []) > 1 else None


@router.websocket("/ws/highway/{filename:path}")
async def highway_ws(websocket: WebSocket, filename: str, arrangement: int = -1,
                     naming_mode: str = "legacy", drum_part: str = ""):
    """Stream song data for the highway renderer over WebSocket.

    `drum_part` selects WHICH drum part's tab streams when the pack carries
    several (feedpak 1.17.0 "drums as arrangements") — a part id from
    song_info's `drum_parts`. Empty / unknown ids fall back to the primary,
    so a stale or mistyped selection degrades to today's behavior instead of
    silencing drums."""
    await websocket.accept()
    structlog.contextvars.bind_contextvars(ws_conn_id=uuid.uuid4().hex[:8])

    dlc = _get_dlc_dir()
    if not dlc:
        await websocket.send_json({"error": "DLC folder not configured"})
        await websocket.close()
        return

    song_path = _resolve_dlc_path(dlc, filename)
    if song_path is None:
        await websocket.send_json({"error": "forbidden"})
        await websocket.close()
        return
    if not song_path.exists():
        await websocket.send_json({"error": "File not found"})
        await websocket.close()
        return

    is_slop = sloppak_mod.is_sloppak(song_path)
    # Sloppak wins precedence: `_extract_meta_for_file()` and the
    # background scanner both treat a `.sloppak` directory as sloppak
    # even if it happens to contain WEM/XML. Gate is_loose on that
    # so the loose-only branches (audio_id, offset, audio conversion)
    # don't fire for sloppak bundles.
    is_loose = (not is_slop) and loosefolder_mod.is_loose_song(song_path)
    tmp = None
    owns_tmp = False
    loaded_slop = None  # LoadedSloppak when is_slop
    _keepalive_active = True

    async def _send_keepalives():
        while _keepalive_active:
            try:
                await asyncio.sleep(3)
                if _keepalive_active:
                    await websocket.send_json({"type": "loading", "stage": "Loading..."})
            except Exception:
                break

    try:
        await websocket.send_json({"type": "loading", "stage": "Extracting..."})
        keepalive_task = asyncio.create_task(_send_keepalives())

        try:
            loop = asyncio.get_running_loop()
            _ctx = contextvars.copy_context()
            if is_slop:
                appstate.sloppak_cache_dir.mkdir(parents=True, exist_ok=True)
                loaded_slop = await loop.run_in_executor(
                    None,
                    lambda: _ctx.run(sloppak_mod.load_song, filename, dlc, appstate.sloppak_cache_dir),
                )
                song = loaded_slop.song
                tmp = str(loaded_slop.source_dir)
                owns_tmp = False
            elif is_loose:
                # Loose folders need no extraction — load_song reads the
                # arrangement XMLs directly from the flat directory.
                # song_path is already DLC-containment-validated by
                # _resolve_dlc_path, so audio conversion below can use
                # it directly.
                song = await loop.run_in_executor(None, lambda: load_song(str(song_path)))
                tmp = str(song_path)
                owns_tmp = False
            else:
                # Only open formats (.sloppak bundles and loose folders) are
                # servable. There is no fallback container extraction path.
                raise ValueError("Unsupported song format")
        finally:
            _keepalive_active = False
            keepalive_task.cancel()

        if not song.arrangements:
            await websocket.send_json({"error": "No arrangements found"})
            await websocket.close()
            return

        # Smart names are needed for smart-mode arrangement selection.
        smart_names = compute_smart_names(song.arrangements)

        # Pick arrangement: explicit request > user preference > most notes
        best = -1
        if 0 <= arrangement < len(song.arrangements):
            best = arrangement
        else:
            # Read the user's config once: their selected instrument (route the chart
            # to the matching part) and their default-arrangement preference.
            pref = ""
            sel_instrument = ""
            config_file = appstate.config_dir / "config.json"
            if config_file.exists():
                try:
                    _cfg = json.loads(config_file.read_text(encoding="utf-8"))
                    pref = _cfg.get("default_arrangement", "")
                    sel_instrument = (_cfg.get("instrument", "") or "")
                except Exception:
                    pass
            # Instrument routing: load the part that matches the selected instrument so
            # "your instrument" and "the chart you play" line up. The default ordering
            # is Lead/guitar-first, so without this a bass player gets handed a guitar
            # chart (and any tune-check then compares a 4-string bass against a 6-string
            # part). Currently routes bass -> a Bass arrangement; guitar — and any
            # unknown/future instrument (drums, keys) — falls through to the
            # preference/most-notes logic below, which already lands on a guitar part.
            # Drums/keys get their own match when those arrangement types + selector
            # entries land. Only applies when no explicit arrangement was requested, so
            # a manual arrangement switch is always respected.
            if sel_instrument.lower() == "bass":
                # Candidate bass parts, preferring the structured pathBass flag; the
                # normalized smart name (itself pathBass-derived) and raw name are
                # fallbacks for sources without the flag.
                bass_idxs = [
                    i
                    for i, a in enumerate(song.arrangements)
                    if arrangement_is_bass(a)
                    or (smart_names[i] or "").lower().startswith("bass")
                ]
                if bass_idxs:
                    # Among the bass parts: (1) honor the saved default-arrangement
                    # preference if it names one of them (so a bass player who prefers
                    # "Bass 2"/"Alt. Bass" keeps it), (2) else the canonical main "Bass",
                    # (3) else the first bass part in order.
                    pref_bass = -1
                    if pref:
                        for i in bass_idxs:
                            nm = (smart_names[i] if naming_mode == "smart" and i < len(smart_names)
                                  else getattr(song.arrangements[i], "name", ""))
                            if nm == pref:
                                pref_bass = i
                                break
                    if pref_bass >= 0:
                        best = pref_bass
                    else:
                        best = next(
                            (i for i in bass_idxs
                             if (smart_names[i] if i < len(smart_names) else "") == "Bass"),
                            bass_idxs[0],
                        )
            # User's default arrangement preference (only when instrument routing did not
            # already resolve a part — i.e. guitar, or a bass player with no bass part).
            if best < 0 and pref:
                if naming_mode == "smart":
                    best = _pick_smart_arrangement(song.arrangements, smart_names, pref)
                else:
                    for i, a in enumerate(song.arrangements):
                        if a.name == pref:
                            best = i
                            break
        if best < 0:
            # Fallback: most notes
            best = 0
            best_count = 0
            for i, a in enumerate(song.arrangements):
                c = len(a.notes) + sum(len(ch.notes) for ch in a.chords)
                if c > best_count:
                    best_count = c
                    best = i
        arr = song.arrangements[best]

        # Resolve the manifest arrangement id for notation lookup (Option B loader).
        # Use the parallel arrangement_ids list (indexed by compacted position,
        # i.e. song.arrangements index) so skipped manifest entries can't shift
        # the index and serve the wrong arrangement's notation.
        _notation_arr_id: str | None = None
        if is_slop and loaded_slop is not None:
            _ids = loaded_slop.arrangement_ids
            if best < len(_ids):
                _notation_arr_id = _ids[best]

        # Convert audio with unique filename (check cache first)
        audio_url = None
        audio_error: str | None = None  # Surfaced in song_info when audio_url is None
        stems_payload: list[dict] = []
        # URL of the pack's complete mixdown — the RESERVED `full` stem (spec
        # §5.3), which sloppak.load_song() lifts out of `stems` because it is a
        # mixdown, not a layer. The stems plugin plays it while every stem slider
        # is at unity (separation is lossy, so it beats re-summing the stems) and
        # crosses to the separated stems as soon as one is attenuated.
        #
        # None when the pack has no mixdown to offer separately from its stems:
        # a single-mix pack (its one stem IS the mixdown), a loose folder, or an
        # archive.
        full_mix_url: str | None = None
        if is_loose:
            # Loose folder filenames are relative paths (artist/album/song).
            # Hash the *canonical* dlc-relative path (so two URL spellings
            # of the same physical folder share a cache key) PLUS the
            # source WEM's mtime+size so:
            #  - different songs with the same leaf folder name can't
            #    collide (a `/`→`__` escape would collapse `a/b__c` and
            #    `a__b/c`);
            #  - editing audio.wem in place invalidates the cached
            #    converted file (without this, in-place custom song iteration
            #    keeps serving the stale mp3/ogg from the cache).
            try:
                canonical = song_path.relative_to(dlc.resolve()).as_posix()
            except ValueError:
                canonical = filename
            wem_for_id = loosefolder_mod.find_audio(song_path)
            try:
                wem_stat = wem_for_id.stat() if wem_for_id else None
            except OSError:
                wem_stat = None
            stamp = f"{wem_stat.st_mtime_ns}-{wem_stat.st_size}" if wem_stat else ""
            digest = hashlib.sha256(
                (canonical + "|" + stamp).encode("utf-8")
            ).hexdigest()[:12]
            leaf = Path(canonical.rstrip("/\\")).stem.replace(" ", "_")[:40] or "song"
            audio_id = f"{leaf}_{digest}"
        else:
            audio_id = Path(filename).stem.replace(" ", "_")

        if is_slop:
            # Stems are served via the sloppak file endpoint; the first stem
            # (or explicit default) is the core <audio> source. The stems
            # plugin replaces it with a mixed graph when active.
            from urllib.parse import quote
            q_fn = quote(filename, safe="")
            for s in loaded_slop.stems:
                url = f"/api/sloppak/{q_fn}/file/{quote(s['file'])}"
                stems_payload.append(
                    {"id": s["id"], "url": url, "default": s["default"],
                     **{k: s[k] for k in ("name", "description") if k in s}})
            # Full-mix URL (served by the same /api/sloppak/.../file/ endpoint).
            if loaded_slop is not None and loaded_slop.full_mix:
                full_mix_url = (
                    f"/api/sloppak/{q_fn}/file/{quote(loaded_slop.full_mix)}"
                )
            if stems_payload:
                # Stems present: keep the core <audio> pointed at stem[0]. This
                # URL is only ever heard in the degraded path (stems plugin
                # refuses takeover / decode fails); the full-mix↔stems switch is
                # driven client-side by `full_mix_url`, not `audio_url`.
                audio_url = stems_payload[0]["url"]
            elif full_mix_url:
                # Stem-less full-mix pack: nothing to separate, so play the full
                # mix natively through the core <audio>. The stems plugin's
                # onSongReady returns early on an empty stems list (no graph).
                # Reachable only via the deprecated `original_audio:` key, whose
                # packs put the mixdown outside `stems` — a pack that carries its
                # mixdown as the `full` stem has it IN `stems`, so it lands in the
                # branch above with stems_payload == [full].
                audio_url = full_mix_url
            else:
                audio_error = "This sloppak has no playable stems."
        else:
            appstate.audio_cache_dir.mkdir(parents=True, exist_ok=True)
            # Check if audio already cached (writable cache dir or legacy static dir)
            for ext in [".mp3", ".ogg", ".wav"]:
                for cache_dir in [appstate.audio_cache_dir, appstate.static_dir]:
                    cached_audio = cache_dir / f"audio_{audio_id}{ext}"
                    if cached_audio.exists() and cached_audio.stat().st_size > 1000:
                        audio_url = f"/audio/audio_{audio_id}{ext}"
                        break
                if audio_url:
                    break

        def _evict_audio_cache():
            # Keep appstate.audio_cache_dir bounded so a library full of loose
            # folders / many archives doesn't fill disk. LRU on st_atime
            # so songs the user keeps replaying stay warm. Best-effort:
            # log at debug so permission / disk errors are diagnosable
            # without aborting the request.
            try:
                audio_files = [f for f in appstate.audio_cache_dir.iterdir()
                               if f.name.startswith("audio_") and f.suffix in (".mp3", ".ogg", ".wav")]
                if len(audio_files) > 100:
                    audio_files.sort(key=lambda f: f.stat().st_atime)
                    for f in audio_files[:len(audio_files) - 100]:
                        f.unlink(missing_ok=True)
            except Exception:
                log.debug("audio cache eviction failed for %s", appstate.audio_cache_dir, exc_info=True)

        if not audio_url and is_loose:
            await websocket.send_json({"type": "loading", "stage": "Converting audio..."})
            wem_path = loosefolder_mod.find_audio(song_path)
            if wem_path:
                # Re-resolve to defeat a symlinked audio.wem that points
                # outside the song folder — without this, a crafted
                # custom song could turn convert_wem into an arbitrary-file
                # decode/read primitive.
                wem_resolved = wem_path.resolve()
                try:
                    wem_resolved.relative_to(song_path)
                except ValueError:
                    audio_error = "Audio file escapes the loose folder."
                    wem_resolved = None
                if wem_resolved is not None:
                    # Convert into a unique temp basename and then
                    # atomically rename onto the final cache name.
                    # Two clients requesting the same song concurrently
                    # would otherwise race writing the same file and
                    # one could serve a partial mp3/wav.
                    tmp_suffix = uuid.uuid4().hex[:8]
                    tmp_base = appstate.audio_cache_dir / f"audio_{audio_id}.{tmp_suffix}"
                    try:
                        produced = convert_wem(str(wem_resolved), str(tmp_base))
                        ext = Path(produced).suffix
                        final_path = appstate.audio_cache_dir / f"audio_{audio_id}{ext}"
                        os.replace(produced, final_path)
                        audio_url = f"/audio/audio_{audio_id}{ext}"
                    except Exception as e:
                        log.exception("loose-folder audio conversion failed for %s", audio_id)
                        audio_error = f"Audio conversion failed: {e}"
                        # Best-effort cleanup of partial temp artifacts.
                        for stale in appstate.audio_cache_dir.glob(f"audio_{audio_id}.{tmp_suffix}.*"):
                            stale.unlink(missing_ok=True)
            else:
                audio_error = "No audio file found in loose folder."
            _evict_audio_cache()

        if not audio_url and not is_slop and not is_loose:
            await websocket.send_json({"type": "loading", "stage": "Converting audio..."})
            wem_files = find_wem_files(tmp)
            if not wem_files:
                audio_error = "No WEM audio files were found inside this archive."
            else:
                try:
                    audio_path = convert_wem(wem_files[0], os.path.join(tmp, "audio"))
                    ext = Path(audio_path).suffix
                    audio_dest = appstate.audio_cache_dir / f"audio_{audio_id}{ext}"
                    shutil.copy2(audio_path, audio_dest)
                    audio_url = f"/audio/audio_{audio_id}{ext}"
                except Exception as e:
                    log.exception("audio conversion failed for %s", audio_id)
                    audio_error = f"Audio conversion failed: {e}"

            _evict_audio_cache()

        # Send song metadata
        arr_list = [
            {
                "index": i,
                "name": a.name,
                "smart_name": smart_names[i],
                "notes": len(a.notes) + sum(len(c.notes) for c in a.chords),
            }
            for i, a in enumerate(song.arrangements)
        ]
        arr_list.sort(key=_arr_smart_sort_key)
        await websocket.send_json({
            "type": "song_info",
            "title": song.title,
            "artist": song.artist,
            "duration": song.song_length,
            "arrangement": arr.name,
            "arrangement_smart_name": smart_names[best],
            "arrangement_index": best,
            # Echo the resolved naming mode so highway.js doesn't have to
            # re-read localStorage (which can be unavailable / disagree with
            # app.js's in-memory cache when storage writes fail).
            "naming_mode": "smart" if naming_mode == "smart" else "legacy",
            "arrangements": arr_list,
            "audio_url": audio_url,
            "audio_error": audio_error,
            "tuning": arr.tuning,
            # Number of strings on the active arrangement
            # (feedBack-plugin-3dhighway#7). arrangement XML / archive sources
            # always emit `tuning` as length 6 with zero-padding for
            # unused string slots, so `len(arr.tuning)` is unreliable
            # there; sloppak / GP-imported sources may instead carry
            # a trimmed list. arrangement_string_count() combines a
            # notes-derived lower bound, a name-based fallback (4 for
            # "bass" arrangements), and the tuning length (when it
            # disagrees with the RS-XML padded 6) into a single
            # reliable signal. Plugins should size string-indexed UI
            # / geometry against THIS rather than assuming 6 or
            # using `tuning.length` directly.
            "stringCount": arrangement_string_count(arr),
            "capo": arr.capo,
            "centOffset": arr.cent_offset,
            # Sanitize song.offset before send_json: a malformed loose
            # chart can produce NaN via `float("nan")`, which Starlette
            # would serialise as the literal `NaN` token (invalid JSON)
            # and break the frontend's song_info parsing.
            "offset": _sanitized_song_offset(song) if is_loose else 0.0,
            "format": "sloppak" if is_slop else ("loose" if is_loose else "archive"),
            # Feedpak contributor credits (manifest `authors:`, spec §5.4) —
            # name + role only, shown on the highway when a song is loaded.
            # Only sloppak/feedpak packs carry a manifest; loose/archive
            # sources get []. The frontend uses a non-empty list as the gate
            # for the credits overlay, so minigames / synthetic highway uses
            # (no manifest) never trigger it.
            "authors": _sanitize_authors(loaded_slop.manifest) if (is_slop and loaded_slop is not None) else [],
            # Instrument stems ONLY. The pack's complete mixdown (the RESERVED
            # `full` stem, spec §5.3) is deliberately NOT in this list: consumers
            # sum `stems` into one mix and render one fader per entry, and the
            # mixdown is neither a layer nor an instrument — summing it would
            # double the whole song. It is surfaced separately, below.
            "stems": stems_payload,
            # The complete mixdown, served by the same /api/sloppak/.../file/
            # endpoint as the stems. The stems plugin plays this single file
            # while every stem slider is at unity and crosses to the separated
            # stems the moment one drops below 100% — separation is lossy, so the
            # mixdown is strictly better audio when nothing is muted. None when
            # the pack has no mixdown apart from its stems. The `has_*` flags
            # mirror the has_drum_tab/has_keys convention so a client can branch
            # without re-deriving from the URLs.
            "full_mix_url": full_mix_url,
            "has_full_mix": bool(full_mix_url),
            "has_stems": bool(stems_payload),
            # DEPRECATED aliases of the two keys above, kept so a client built
            # against the old frame keeps working across one release. They were
            # named after `original_audio:` — a manifest key this repo invented
            # and the feedpak spec never had (#933). The key is gone; the mixdown
            # is a stem. Remove these once the shipped stems plugin reads
            # `full_mix_url` (#945).
            "original_audio_url": full_mix_url,
            "has_original_audio": bool(full_mix_url),
            # Surface a drum_tab presence flag so the visualization picker
            # can auto-activate the drums plugin even when the chosen
            # arrangement isn't named "Drums" (drum_tab.json lives next
            # to the manifest, not inside the arrangements list).
            "has_drum_tab": bool(
                is_slop and loaded_slop is not None and loaded_slop.drum_tab is not None
            ),
            # The song's DRUM PARTS (feedpak 1.17.0 "drums as arrangements"),
            # primary first — names only; the selected part's payload streams
            # as the `drum_tab`/`drum_hits` messages below. Always a list
            # (empty when the pack has no drums, and a single entry for a
            # legacy one-drum pack), so a part picker can bind unconditionally.
            "drum_parts": [
                {"id": p["id"], "name": p["name"]}
                for p in (loaded_slop.drum_parts or [])
            ] if is_slop and loaded_slop is not None else [],
            "has_notation": bool(
                is_slop
                and loaded_slop is not None
                and loaded_slop.notation_by_id is not None
                and _notation_arr_id is not None
                and _notation_arr_id in loaded_slop.notation_by_id
            ),
            # Song-level key/scale track presence (keys.json, spec §7.7) so a
            # consumer can light up a key/scale display without parsing the pack.
            "has_keys": bool(
                is_slop and loaded_slop is not None and loaded_slop.keys is not None
            ),
        })

        # Send drum_tab when the sloppak ships one (manifest `drum_tab:` key,
        # see lib/sloppak.py). The drums plugin subscribes to `drum_tab` for
        # the kit legend and `drum_hits` for the timed hit stream. Chunked
        # 500-per-frame like notes so a long song stays well under WS frame
        # limits. Legacy drum sloppaks (drums encoded as guitar notes) skip
        # this branch and fall through to the regular `notes` stream — the
        # client-side drums plugin keeps a fallback decoder for them.
        if is_slop and loaded_slop is not None and loaded_slop.drum_tab is not None:
            dt = loaded_slop.drum_tab
            # Multiple drum parts: `?drum_part=<id>` picks which part's tab
            # streams; the default (and any unknown id) is the PRIMARY —
            # exactly the pre-parts behavior, so legacy clients notice nothing.
            _dt_part_id = None
            if loaded_slop.drum_parts:
                _dt_part_id = loaded_slop.drum_parts[0]["id"]
                if drum_part:
                    for _p in loaded_slop.drum_parts:
                        if _p["id"] == drum_part:
                            dt = _p["drum_tab"]
                            _dt_part_id = _p["id"]
                            break
            kit = drums_mod.normalise_kit(dt.get("kit"))
            hits_wire = drums_mod.hits_to_wire(dt.get("hits") or [])
            _dt_name = dt.get("name")
            _dt_name = _dt_name if isinstance(_dt_name, str) and _dt_name else "Drums"
            _dt_msg = {
                "type": "drum_tab",
                "version": int(dt.get("version", drums_mod.SCHEMA_VERSION)),
                "name": _dt_name,
                "kit": kit,
                "total": len(hits_wire),
            }
            # Only multi-part packs identify a part on the wire. Legacy packs
            # synthesize a one-item list internally but keep their old frame.
            _wire_part_id = _drum_part_id_for_wire(loaded_slop.drum_parts, _dt_part_id)
            if _wire_part_id is not None:
                _dt_msg["part_id"] = _wire_part_id
            try:
                await websocket.send_json(_dt_msg)
                for i in range(0, len(hits_wire), 500):
                    await websocket.send_json({
                        "type": "drum_hits",
                        "data": hits_wire[i:i + 500],
                        "total": len(hits_wire),
                    })
            except WebSocketDisconnect:
                return

        # Send beats
        beats = [{"time": b.time, "measure": b.measure} for b in song.beats]
        await websocket.send_json({"type": "beats", "data": beats})

        # Send sections
        sections = [{"name": s.name, "time": s.start_time} for s in song.sections]
        await websocket.send_json({"type": "sections", "data": sections})

        # Send the song-level key/scale track (keys.json, spec §7.7) when the
        # sloppak ships one. Consumers read it from the WS rather than the file,
        # like drum_tab/beats/sections. The loader already sanitized the events
        # (finite t, non-empty string key, sorted), so this is a direct send.
        if is_slop and loaded_slop is not None and loaded_slop.keys is not None:
            await websocket.send_json({
                "type": "keys",
                "version": int(loaded_slop.keys.get("version", 1)),
                "data": loaded_slop.keys.get("events") or [],
            })

        # Song-level tempo + time-signature maps (song_timeline, feedpak 1.2.0),
        # plus the per-chart tempo override (§6.10): the active arrangement's own
        # `tempos` wins over the song-level map for this chart. Both are
        # pre-sanitized by the loader / arrangement_from_wire, so they stream
        # directly. Consumers read these rather than the file.
        _song_tempos = loaded_slop.tempos if (is_slop and loaded_slop is not None) else None
        _tempos_out = getattr(arr, "tempos", None) or _song_tempos
        if _tempos_out:
            await websocket.send_json({"type": "tempos", "data": _tempos_out})
        _time_sigs = (loaded_slop.time_signatures
                      if (is_slop and loaded_slop is not None) else None)
        if _time_sigs:
            await websocket.send_json({"type": "time_signatures", "data": _time_sigs})

        # Send notation data when the sloppak ships it for the active arrangement.
        # Slots after sections (cursor sync depends on beats, which precede sections)
        # and before anchors — per docs/sloppak-spec.md §5.3.
        if (
            is_slop
            and loaded_slop is not None
            and loaded_slop.notation_by_id is not None
            and _notation_arr_id is not None
            and _notation_arr_id in loaded_slop.notation_by_id
        ):
            nt = loaded_slop.notation_by_id[_notation_arr_id]
            measures_wire = notation_mod.measures_to_wire(nt.get("measures") or [])
            try:
                await websocket.send_json({
                    "type": "notation_info",
                    "version": int(nt.get("version", notation_mod.SCHEMA_VERSION)),
                    "instrument": str(nt.get("instrument", "")),
                    "staves": nt.get("staves") or [],
                    "total": len(measures_wire),
                })
                _NOTATION_CHUNK = 32
                for i in range(0, len(measures_wire), _NOTATION_CHUNK):
                    await websocket.send_json({
                        "type": "notation_measures",
                        "data": measures_wire[i:i + _NOTATION_CHUNK],
                        "total": len(measures_wire),
                    })
            except WebSocketDisconnect:
                return

        # Send anchors
        anchors = [anchor_to_wire(a) for a in arr.anchors]
        await websocket.send_json({"type": "anchors", "data": anchors})

        # Send chord templates. Include `fingers` alongside `name` /
        # `frets` so plugin overlays consuming highway.getChordTemplates()
        # can render full chord boxes (chord-style fingering
        # diagrams), not just chord names. Each fingering entry is
        # per-string: -1 = unused, 0 = open string, n > 0 = finger
        # number. RS XML sources populate real values; GP imports
        # currently emit all -1 (no finger data available pre-import).
        templates = [chord_template_to_wire(ct) for ct in arr.chord_templates]
        await websocket.send_json({"type": "chord_templates", "data": templates})

        # Send lyrics if available
        import xml.etree.ElementTree as ET
        lyrics = []
        lyrics_source = ""
        # Loose folders are flat — only inspect direct children so a
        # nested backup/export directory inside the song folder can't
        # override the active arrangement's lyrics / tone. archives are
        # unpacked into nested tmp dirs, so they keep recursive rglob.
        # Sloppak skips XML lookups entirely below but the json loop
        # is unconditional, so define both walkers up front.
        _xml_walk = Path(tmp).glob if is_loose else Path(tmp).rglob
        _json_walk = Path(tmp).glob if is_loose else Path(tmp).rglob
        if is_slop:
            lyrics = list(song.lyrics or [])
            lyrics_source = getattr(song, "lyrics_source", "") or ""
        else:
            for xml_path in sorted(_xml_walk("*.xml")):
                try:
                    root = ET.parse(xml_path).getroot()
                    if root.tag == "vocals":
                        # An empty <vocals/> shell would otherwise
                        # short-circuit later XML files, so only stop
                        # scanning when the XML actually produced lyric
                        # tokens — a meaningful XML further down the
                        # walk must still be reachable.
                        candidate = [
                            {
                                "t": round(float(v.get("time", "0")), 3),
                                "d": round(float(v.get("length", "0")), 3),
                                "w": v.get("lyric", ""),
                            }
                            for v in root.findall("vocal")
                        ]
                        if candidate:
                            lyrics = candidate
                            lyrics_source = "xml"
                            break
                except Exception:
                    pass
        if lyrics:
            payload = {"type": "lyrics", "data": lyrics}
            if lyrics_source:
                payload["source"] = lyrics_source
            await websocket.send_json(payload)

        # Send tone changes. archive and loose folders carry tone data in
        # arrangement XMLs; a sloppak ships it inline in its arrangement JSON
        # (Arrangement.tones, populated by the converter), so read it straight
        # off `arr` rather than walking for XML that doesn't exist.
        if is_slop:
            # `sloppak_tone_changes` builds the (base, base_rig, sorted
            # changes) triple from `Arrangement.tones`, skipping non-string
            # names, non-finite/non-numeric times, and unusable rig ids —
            # unit-tested in test_tones.py.
            from tones import sloppak_tone_changes
            base_name, base_rig, tone_changes = sloppak_tone_changes(
                getattr(arr, "tones", None)
            )
            # Send when there's a base tone OR timed changes — a single-tone
            # arrangement has a base but no switches, and the highway should
            # still be able to show the initial tone.
            if tone_changes or base_name:
                payload = {
                    "type": "tone_changes",
                    "base": base_name,
                    "data": tone_changes,
                }
                # `base_rig` is additive (feedpak-spec §6.9) — omitted entirely
                # when the chart binds no rig, so consumers that predate the rig
                # model see the exact payload they always did.
                if base_rig:
                    payload["base_rig"] = base_rig
                await websocket.send_json(payload)
        else:
            xml_paths = sorted(_xml_walk("*.xml"))

            # Build tone ID→name map from the manifest JSON for the selected
            # arrangement. Match on the entry's `ArrangementName` field, not a
            # filename-stem substring — "Lead" is a substring of "Bonus Lead",
            # so the old substring test could build the map from the wrong
            # arrangement. Record the matched JSON stem so the XML below can
            # be paired exactly (RS names the JSON and XML with the same stem).
            arr_tone_names = {}  # the SELECTED arrangement's own Tone_A..D only
            matched_stem = None
            # Strip + lowercase both sides when matching ArrangementName,
            # mirroring lib/tones.py — a manifest with padded whitespace
            # must not fall through to an unrelated arrangement.
            arr_name_lower = arr.name.strip().lower() if arr else ""

            def _manifest_entries(path):
                """Parsed `Entries` dict for a manifest JSON, or {} if the
                file isn't a well-formed manifest (non-dict top level /
                Entries, unparseable JSON)."""
                try:
                    # JSON is UTF-8; decode strictly so malformed bytes fail
                    # cleanly (caught below) rather than silently corrupting
                    # arrangement / tone names.
                    jdata = json.loads(path.read_text(encoding="utf-8"))
                except Exception:
                    return {}
                entries = jdata.get("Entries") if isinstance(jdata, dict) else None
                return entries if isinstance(entries, dict) else {}

            def _tone_names(attrs):
                """{idx: name} from an entry's Tone_A..Tone_D — string values
                only, so a malformed manifest can't emit a non-string name."""
                m = {}
                for idx, key in enumerate(("Tone_A", "Tone_B", "Tone_C", "Tone_D")):
                    val = attrs.get(key)
                    if isinstance(val, str) and val:
                        m[idx] = val
                return m

            for jf in sorted(_json_walk("*.json")):
                for entry in _manifest_entries(jf).values():
                    if not isinstance(entry, dict):
                        continue
                    attrs = entry.get("Attributes")
                    if not isinstance(attrs, dict):
                        continue
                    ename = attrs.get("ArrangementName")
                    if not isinstance(ename, str) or ename.strip().lower() != arr_name_lower:
                        continue
                    # Only the SELECTED arrangement's own Tone_A..D — never
                    # borrowed from another manifest. An unrelated map would
                    # mislabel `N/A` tone-change markers; `Tone {id}` is the
                    # correct fallback (matching lib/tones.py).
                    arr_tone_names = _tone_names(attrs)
                    matched_stem = jf.stem.lower()
                    break
                if matched_stem is not None:
                    break

            # Parse XMLs. Prefer the XML paired with the matched manifest
            # (identical stem). When no manifest matched (loose/custom song), fall
            # back to a name-token match — but rank by how few *extra* stem
            # tokens a candidate carries, mirroring lib/tones.py: {"lead"} is
            # a subset of both `song_lead` and `song_bonus_lead`, so a plain
            # subset test still ties. A unique fewest-extra match wins; an
            # exact tie among token candidates is treated as ambiguous —
            # `_token_ambiguous` then suppresses the rank-2 best-effort
            # fallback, so no arrangement's tone timeline is guessed at
            # (matching lib/tones.py, which attaches nothing on a tie).
            # Shared tokenizer with lib/tones.py so archive playback and
            # archive→sloppak conversion select arrangement XMLs identically.
            from tones import tokens as _name_tokens
            _arr_tokens = _name_tokens(arr.name) if arr else set()
            _token_pick = None
            _token_ambiguous = False
            if _arr_tokens and matched_stem is None:
                _cands = []
                for xp in xml_paths:
                    stem_tokens = _name_tokens(xp.stem)
                    if _arr_tokens <= stem_tokens:
                        _cands.append((len(stem_tokens - _arr_tokens), xp))
                if _cands:
                    _best = min(extra for extra, _ in _cands)
                    _tied = [xp for extra, xp in _cands if extra == _best]
                    if len(_tied) == 1:
                        _token_pick = _tied[0]
                    else:
                        _token_ambiguous = True

            def _xml_rank(xp):
                if matched_stem and xp.stem.lower() == matched_stem:
                    return 0
                if _token_pick is not None and xp == _token_pick:
                    return 1
                return 2
            sorted_xml = sorted(xml_paths, key=lambda xp: (_xml_rank(xp), xp.name))
            # When the arrangement was positively identified (manifest stem
            # pair or a unique token match), tone data must come only from
            # that XML — a rank-2 fallback XML belongs to another
            # arrangement. A token tie is likewise suppressed (guessing among
            # equally-named XMLs would be wrong). Only a genuine no-match
            # case (loose/custom song with no usable manifest and no name overlap)
            # keeps the long-standing rank-2 best-effort source.
            _suppress_fallback = (
                matched_stem is not None or _token_pick is not None or _token_ambiguous
            )
            sent_tones = False
            tone_base = ""  # <tonebase> of the preferred arrangement XML
            for xml_path in sorted_xml:
                try:
                    root = ET.parse(xml_path).getroot()
                    if root.tag != "song":
                        continue
                    if _suppress_fallback and _xml_rank(xml_path) == 2:
                        # Don't read tones from an unrelated arrangement's XML.
                        continue
                    # Capture the base tone from the first XML the loop
                    # accepts. The skip above already excluded untrusted
                    # rank-2 XMLs whenever a match was confirmed; in the
                    # genuine no-match case rank-2 IS the best-effort source,
                    # so its <tonebase> is equally valid for a base-only song.
                    if not tone_base:
                        _tb = root.find("tonebase")
                        if _tb is not None and _tb.text:
                            # Strip whitespace from pretty-printed XML so the
                            # base name matches the sloppak path, which also
                            # strips it.
                            tone_base = _tb.text.strip()
                    tones_el = root.find("tones")
                    if tones_el is not None:
                        # Accumulate into a per-XML list — if this file
                        # raises partway through, its partial changes are
                        # discarded rather than bleeding into the next
                        # candidate XML.
                        xml_tone_changes = []
                        for t in tones_el.findall("tone"):
                            tc_time = t.get("time")
                            tc_name = t.get("name", "")
                            tc_id = t.get("id", "")
                            # Resolve "N/A" or empty names via the selected
                            # arrangement's own tone map; `Tone {id}` when it
                            # has none (never another arrangement's names).
                            if (not tc_name or tc_name == "N/A") and tc_id:
                                try:
                                    tc_name = arr_tone_names.get(int(tc_id), f"Tone {tc_id}")
                                except (TypeError, ValueError):
                                    pass
                            if tc_time and tc_name:
                                # Skip a single malformed/non-finite marker
                                # rather than letting it raise — the outer
                                # `except` would otherwise swallow the whole
                                # XML and drop every tone change. NaN/inf
                                # would also produce client-unparseable JSON.
                                try:
                                    tc_t = float(tc_time)
                                except (TypeError, ValueError):
                                    continue
                                if not math.isfinite(tc_t):
                                    continue
                                xml_tone_changes.append({
                                    "t": round(tc_t, 3),
                                    "name": tc_name,
                                })
                        if xml_tone_changes:
                            tonebase = root.find("tonebase")
                            base_name = tonebase.text.strip() if tonebase is not None and tonebase.text else ""
                            # If base name not in XML, use the selected
                            # arrangement's own Tone_A.
                            if not base_name:
                                base_name = arr_tone_names.get(0, "")
                            await websocket.send_json({
                                "type": "tone_changes",
                                "base": base_name,
                                "data": sorted(xml_tone_changes, key=lambda x: x["t"]),
                            })
                            sent_tones = True
                            break
                except (ET.ParseError, OSError) as e:
                    # Only swallow unreadable/malformed XML — skip to the next
                    # candidate. A blanket `except` here would also eat a
                    # `WebSocketDisconnect` from `send_json`; let that bubble
                    # to the handler's outer disconnect handler.
                    log.debug(
                        "highway: skipping unreadable arrangement XML %s: %s",
                        xml_path.name, e,
                    )
                    continue
            # Base-only fallback: a single-tone arrangement has a <tonebase>
            # but no <tones> markers — still surface the initial tone so the
            # highway can show it (parity with the sloppak path above).
            # `tone_base` is the <tonebase> of whichever XML the loop
            # accepted: the confirmed-match XML, or — in the genuine no-match
            # case — the best-effort rank-2 XML. `arr_tone_names` holds the
            # selected arrangement's own Tone_A..D. An ambiguous arrangement
            # (token tie) accepts no XML and has no manifest map, so it
            # correctly sends nothing rather than a guessed tone.
            if not sent_tones:
                base_name = tone_base
                if not base_name:
                    base_name = arr_tone_names.get(0, "")
                if base_name:
                    await websocket.send_json({
                        "type": "tone_changes",
                        "base": base_name,
                        "data": [],
                    })

        # Teaching mark sd (§6.2.2): derive each note's scale degree from the
        # active key (keys.json §7.7) + its sounding pitch (tuning[string] +
        # fret), only when the author didn't author one. Display/teaching only —
        # NEVER feeds grading. Notes whose string/fret has no tuning entry, or
        # that have no active key, or whose key name is unparseable, stay unset.
        _key_events = (
            (loaded_slop.keys.get("events") or [])
            if (is_slop and loaded_slop is not None and loaded_slop.keys is not None)
            else []
        )
        _key_times = [e["t"] for e in _key_events]
        _key_tonics = [key_to_tonic_pc(e.get("key")) for e in _key_events]
        _tuning = arr.tuning or []
        # Hoist the open-string base out of the per-note loop: arr.tuning holds
        # per-string OFFSETS from standard, so the sounding pitch is
        # base[string] + offset + capo + fret (matches the tuner / open-string
        # labels). arrangement_string_count is O(notes), so compute once here.
        _base = base_open_string_midis(
            arrangement_string_count(arr), arrangement_is_bass(arr))
        _capo = int(getattr(arr, "capo", 0) or 0)

        def _fill_scale_degree(wire: dict, n, t: float) -> None:
            # Author-provided sd wins — note_to_wire already emitted it.
            if "sd" in wire or not _key_times:
                return
            idx = bisect.bisect_right(_key_times, t) - 1
            if idx < 0:
                return
            tonic = _key_tonics[idx]
            if tonic is None:
                return
            midi = pitch_from_base(_base, _capo, _tuning, n.string, n.fret)
            if midi is None:
                return
            wire["sd"] = scale_degree_for_pitch(midi, tonic)

        # Send notes in chunks
        notes = []
        for n in arr.notes:
            w = note_to_wire(n)
            _fill_scale_degree(w, n, n.time)
            notes.append(w)
        # Send in chunks of 500
        for i in range(0, len(notes), 500):
            await websocket.send_json({
                "type": "notes",
                "data": notes[i:i+500],
                "total": len(notes),
            })

        # Send chords
        chords = []
        for c in arr.chords:
            cw = chord_to_wire(c)
            for cn, cnw in zip(c.notes, cw.get("notes", [])):
                _fill_scale_degree(cnw, cn, c.time)
            chords.append(cw)
        for i in range(0, len(chords), 500):
            await websocket.send_json({
                "type": "chords",
                "data": chords[i:i+500],
                "total": len(chords),
            })

        hand_shapes_out = [hand_shape_to_wire(h) for h in arr.hand_shapes]
        for i in range(0, len(hand_shapes_out), 500):
            await websocket.send_json({
                "type": "handshapes",
                "data": hand_shapes_out[i:i+500],
                "total": len(hand_shapes_out),
            })

        # Per-phrase difficulty data for the master-difficulty slider
        # (feedBack#48). Only sent when the source chart had multiple
        # `<level>` tiers — single-level charts (GP converter, older
        # sloppaks without phrase data) produce arr.phrases=None, and the
        # frontend treats the missing message as "slider disabled".
        # Consumers that don't know about this message type ignore it.
        #
        # Chunked at phrase granularity (20 phrases per frame) because
        # each phrase nests per-level note/chord lists — a single frame
        # could otherwise exceed proxy/WS size limits on large songs.
        # Chunk boundary is per-phrase (not per-level) so the frontend
        # reassembles whole phrase ladders.
        if arr.phrases:
            total = len(arr.phrases)
            for i in range(0, total, 20):
                await websocket.send_json({
                    "type": "phrases",
                    "data": [phrase_to_wire(p) for p in arr.phrases[i:i + 20]],
                    "total": total,
                })

        await websocket.send_json({"type": "ready"})

        # Keep connection alive for control messages
        try:
            while True:
                msg = await websocket.receive_text()
                data = json.loads(msg)
                if data.get("action") == "change_arrangement":
                    pass
        except WebSocketDisconnect:
            pass

    except WebSocketDisconnect:
        # A client that navigates away / closes the tab mid-stream is routine,
        # not an error. Without this, the disconnect falls through to the blanket
        # handler below and logs `highway_ws unhandled error` for every send point
        # (the inner guard only covers the post-`ready` keep-alive loop). Matches
        # the two localized WebSocketDisconnect guards in the streaming body.
        return
    except Exception as e:
        log.exception("highway_ws unhandled error for %s", filename)
        try:
            await websocket.send_json({"error": str(e)})
            await websocket.close()
        except Exception:
            pass

    finally:
        pass  # Don't clean up — cached for arrangement switching
