"""Per-syllable vocal pitch extraction via the demucs server's /pitch endpoint.

Sibling to `lyrics_transcribe.py` on the karaoke side: once we have
isolated vocals + per-syllable lyric timing (both produced by the
WhisperX fallback or shipped in the source archive), the /pitch endpoint
runs CREPE over the vocals stem and returns one MIDI note per supplied
timing token. The result lands in `<sloppak>/vocal_pitch.json` in the
shape the got-feedback/feedBack-plugin-lyrics-karaoke renderer
already consumes:

    {"version": 1, "notes": [{"t": float, "d": float, "midi": int}, ...]}

Pre-generating during sloppak conversion means the karaoke plugin no
longer has to run pYIN locally on every first-play — the file is
already there.

Engine selection
────────────────
This module exposes only the remote path (`extract_pitch_remote`). The
demucs server's /pitch endpoint runs CREPE on a GPU when available,
which is materially better than the pYIN fallback the karaoke plugin
runs locally. Adding a local CREPE path here would mean pulling
`crepe` + `tensorflow` as plugin deps (~500 MB+ on top of the
existing torch/demucs/whisperx). Deferred until users hit the gap.
If you need a local fallback today, install
`got-feedback/feedBack-plugin-lyrics-karaoke` and let its local
pYIN run when the server isn't reachable.

Cache key parity with stem_separation / lyric_transcription
───────────────────────────────────────────────────────────
A `pitch_extraction` manifest block mirrors the shape introduced by
slopsmith#357: `{engine, model, version}`. Today engine is fixed at
`"crepe"` (the server's choice) and model at `"v1"` (server doesn't
yet expose the CREPE capacity dial it uses internally; this is the
requested value, same caveat as `lyric_transcription.model`). The
schema version is independent of the upstream CREPE version and bumps
per slopsmith's contract:
   * patch — metadata-only or implementation fixes
   * minor — backward-compatible additions
   * major — output shape / semantics changed; existing
            vocal_pitch.json should be regenerated and remote caches
            should miss
"""

from __future__ import annotations

import json
import logging
import math
from pathlib import Path
from typing import Callable, Optional

log = logging.getLogger("slopsmith.lib.vocal_pitch")

ProgressCB = Optional[Callable[[float, str, str], None]]

# `pitch_extraction` manifest-block constants. See module docstring for
# semver semantics.
PITCH_EXTRACTION_ENGINE = "crepe"
PITCH_EXTRACTION_MODEL = "v1"
PITCH_EXTRACTION_SCHEMA_VERSION = "1.0.0"


def extract_pitch_remote(
    vocals_path: Path,
    lyrics: list[dict],
    server_url: str,
    *,
    api_key: str | None = None,
    timeout: int = 300,
    progress_cb: ProgressCB = None,
) -> list[dict]:
    """POST the vocal stem + lyric timings to `{server_url}/pitch`.

    `lyrics` is the same `[{t, d, w}, ...]` list slopsmith writes to
    `lyrics.json`. The endpoint only consumes `t` + `d` (it doesn't
    need the word text), but we pass the full payload through —
    slimmer to forward what we already have than to project.

    Returns a normalized `notes` list: each entry is
    `{"t": float, "d": float, "midi": int}` with `t`/`d` rounded to 3
    decimals and `midi` coerced to int. Malformed server entries
    (missing key, non-numeric, wrong type) are skipped rather than
    propagated. Tokens the server couldn't extract a pitch for
    (silent, sub-threshold confidence, no neighbour to borrow from)
    are omitted from the response — the output may be shorter than
    the input lyrics.

    Errors raise `RuntimeError` with a truncated server response so
    the caller can log+continue without bringing down the surrounding
    transcription / split job. Transport-level failures
    (`requests.RequestException`: connection, DNS, timeout, upload
    aborted) are wrapped here so callers see one exception type, not
    requests' hierarchy. Matches the failure idiom in
    `transcribe_vocals_remote` and `_run_demucs_remote`."""
    import requests

    server_url = server_url.rstrip("/")
    if progress_cb:
        try:
            progress_cb(0.10, "pitch", f"Uploading to CREPE server ({server_url})")
        except Exception:
            pass

    headers: dict[str, str] = {}
    if api_key:
        headers["Authorization"] = f"Bearer {api_key}"

    # The /pitch endpoint validates each entry has numeric `t` + `d`;
    # the `w` field is ignored server-side but harmless to forward.
    # Wrap the upload so a connection / DNS / timeout failure becomes a
    # RuntimeError instead of leaking requests' own exception hierarchy
    # past the docstring contract.
    log.debug("POST %s/pitch vocals=%s lyrics=%d timeout=%ds",
              server_url, vocals_path.name, len(lyrics), timeout)
    # Catch both `requests.RequestException` (network / DNS / timeout /
    # upload aborted) AND `OSError` from the `open(vocals_path)` itself
    # (file disappeared between gate-check and upload, permissions
    # change, EIO). Both surface as `RuntimeError` to keep the
    # docstring contract one-type and let the caller handle every
    # failure mode with one `except`. RequestException MUST be caught
    # first because it inherits from OSError — listing OSError first
    # would steal the network-failure path and label it as a vocals
    # read error.
    try:
        with open(vocals_path, "rb") as f:
            resp = requests.post(
                f"{server_url}/pitch",
                files={"file": (vocals_path.name, f, "audio/ogg")},
                data={"lyrics": json.dumps(lyrics)},
                headers=headers or None,
                timeout=timeout,
            )
    except requests.RequestException as e:
        raise RuntimeError(f"CREPE server request failed: {e}") from e
    except OSError as e:
        raise RuntimeError(f"Reading vocals stem {vocals_path.name} failed: {e}") from e

    if resp.status_code != 200:
        raise RuntimeError(
            f"CREPE server error ({resp.status_code}): {resp.text[:300]}"
        )

    try:
        data = resp.json()
    except ValueError as e:
        raise RuntimeError(f"CREPE server returned non-JSON: {e}") from e

    if not isinstance(data, dict) or "notes" not in data:
        raise RuntimeError(
            f"CREPE server returned unexpected shape: {str(data)[:300]}"
        )

    raw_notes = data.get("notes")
    if not isinstance(raw_notes, list):
        raise RuntimeError(
            f"CREPE server `notes` is not a list: {type(raw_notes).__name__}"
        )

    # Defensive: skip malformed entries entirely rather than crashing
    # the whole pass on one bad record. Same posture as the WhisperX
    # remote path. Non-finite t/d (NaN, ±Inf — a misbehaving server or
    # a numerical edge in CREPE could surface them) are also filtered
    # so they can't reach the on-disk vocal_pitch.json and break
    # strict-JSON consumers downstream.
    out: list[dict] = []
    for n in raw_notes:
        if not isinstance(n, dict):
            continue
        if "t" not in n or "d" not in n or "midi" not in n:
            continue
        try:
            t = float(n["t"])
            d = float(n["d"])
            if not math.isfinite(t) or not math.isfinite(d):
                continue
            out.append({
                "t": round(t, 3),
                "d": round(d, 3),
                "midi": int(n["midi"]),
            })
        except (TypeError, ValueError):
            continue

    log.debug("CREPE /pitch returned %d raw notes, %d after normalization",
              len(raw_notes), len(out))
    if progress_cb:
        try:
            progress_cb(1.0, "pitch", f"Got {len(out)} pitch notes")
        except Exception:
            pass

    return out
