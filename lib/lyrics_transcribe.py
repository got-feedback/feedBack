"""WhisperX-based lyric transcription for vocal stems.

Acts as a fallback path when a sloppak lacks `lyrics.json`. Operates on an
already-isolated vocal stem (a Demucs `vocals.ogg`) — does NOT separate
vocals from a mixed track; that's the caller's responsibility.

Output shape matches the on-disk `lyrics.json` shape documented at
`docs/sloppak-spec.md` §2.3:

    [{"t": float, "d": float, "w": str}, ...]

`t` and `d` are seconds. `w` carries a `-` suffix when it joins to the
following syllable, and a `+` suffix when it's the last syllable on a
line (the frontend renderer in `static/highway.js` keys off
`raw.endsWith('+')` and strips the suffix before drawing — see
`docs/sloppak-spec.md` §2.3). Both markers are suffixes on real
syllables, never standalone tokens. WhisperX emits words, not
syllables; the mapper appends `+` to the previous word on segment-gap
heuristics and otherwise lets each word stand as its own syllable.

Engine selection
────────────────
Two transcription paths share a common output:

* `transcribe_vocals_remote(path, server_url, ...)` — POST the vocal
  stem to the `/transcribe` endpoint on a feedBack-demucs-server
  (got-feedBack's reference server already hosts WhisperX alongside
  Demucs at the same URL).

  It used to POST to `/align`, which is *forced alignment* — "here are
  the lyrics, tell me when each word is sung". Its `text` field is
  required and we have no lyrics (transcribing them is the point), so
  the server answered 422 from FastAPI's validation layer before its
  handler ran, and remote transcription never worked for anyone
  (feedBack-plugin-stem-splitter#17). `/transcribe` takes only audio.
  Requires feedBack-demucs-server ≥ the revision adding that endpoint;
  an older server answers 404 and the error says so.

* `transcribe_vocals_local(path, ...)` — load WhisperX in-process. Heavy
  (~3 GB of model weights for `large-v2` + the wav2vec2 aligner) and
  slow on CPU. Deferred imports of `whisperx`, `torch`, and `soundfile`
  keep the rest of feedBack free of those dependencies.

Callers pick between them based on a `whisperx.server_url` config and
fall back as appropriate. This module does not read config — both
entry points are pure functions of their arguments.

Hallucination mitigation
────────────────────────
Whisper invents plausible-sounding lyrics on near-silent or purely
instrumental input. Two gates guard against that:

1. `vocals_has_signal(path, threshold)` — cheap RMS check before
   inference. Skips songs where the vocal stem is below threshold
   (Demucs returns near-silent vocals for instrumentals).

2. `min_word_score` post-filter — WhisperX's word alignment emits a
   per-word confidence score; words below the threshold are dropped
   from the output. Default 0.35 matches the value the reference
   TabGrabber prototype settled on.
"""

from __future__ import annotations

import gc
import logging
from pathlib import Path
from typing import Callable, Optional

log = logging.getLogger("feedBack.lib.lyrics_transcribe")

ProgressCB = Optional[Callable[[float, str, str], None]]


# ── Availability probes ──────────────────────────────────────────────────────

def whisperx_available() -> bool:
    """Cheap probe — does this interpreter have whisperx importable?

    The local transcription path imports whisperx lazily, so this probe lets
    callers gate on availability without paying the full import cost
    (which transitively pulls torch and may try to initialize CUDA).

    Catches a broader exception set than just ImportError because
    importing whisperx can fail with OSError (libsndfile or other
    native libs missing), RuntimeError (torch CUDA init failure,
    BLAS/LAPACK load problems), or essentially any exception the
    deep transitive stack chooses to raise. The tests assert this
    probe NEVER raises; falling back to False for any failure mode
    keeps that contract while still surfacing the real error if a
    later actual transcription tries to use the helper."""
    try:
        import whisperx  # noqa: F401
        return True
    except (ImportError, OSError, RuntimeError) as e:
        log.debug("whisperx_available: import failed (%s)", e)
        return False
    except Exception as e:
        # Last-resort catch so a transient/unexpected failure can't
        # crash the caller. Logged at WARNING so it's visible in normal
        # operation (vs the expected ImportError on installs without
        # whisperx, which stays at DEBUG).
        log.warning("whisperx_available: unexpected probe failure (%s)", e)
        return False


# ── Silence gate ─────────────────────────────────────────────────────────────

def vocals_has_signal(vocals_path: Path, threshold: float = 0.005) -> bool:
    """Return True if the vocal stem has RMS energy above `threshold`.

    Cheap pre-check intended to short-circuit transcription on
    instrumentals — Demucs separates instrumental tracks into a
    near-silent vocals stem, and running Whisper on silence produces
    hallucinated lyrics. The default threshold is conservative; a
    truly silent stem reads ~1e-6, normal vocals well above 0.01.

    Returns True when soundfile or numpy is missing OR fails to load
    its native lib (best-effort gate, not a hard requirement). The
    transcription itself will surface the real failure if those deps
    are actually needed downstream.

    Catching OSError matters because `import soundfile` performs a
    ctypes load of `libsndfile` at import time — on a host without the
    native lib installed, that raises `OSError` (not ImportError) and
    would otherwise propagate up and break the surrounding
    transcription run instead of just skipping the gate."""
    try:
        import numpy as np
        import soundfile as sf
    except (ImportError, OSError) as e:
        log.debug("vocals_has_signal: soundfile/numpy unavailable (%s) — skipping gate", e)
        return True
    # Stream the file in blocks instead of loading the whole stem into
    # memory. A 4-minute stereo vocal stem at 44.1kHz is ~84 MB as
    # float32; multiply that across a batch of conversions and the
    # allocations get noticeable. SoundFile.blocks() yields chunks
    # without ever holding the full buffer, and we only need a
    # running sum-of-squares + frame count to compute RMS at the end.
    # Short-circuit threshold check inside the loop: once we've
    # accumulated enough signal to clear the gate, no need to keep
    # scanning the rest of the file.
    sumsq = 0.0
    nframes = 0
    try:
        with sf.SoundFile(str(vocals_path)) as fh:
            for block in fh.blocks(blocksize=65536, dtype="float32", always_2d=False):
                if block.size == 0:
                    continue
                if block.ndim > 1:
                    block = block.mean(axis=1)
                sumsq += float(np.sum(np.square(block)))
                nframes += int(block.shape[0])
                # Early exit once we know the gate will pass — no point
                # reading the rest of a 4-minute file to confirm.
                if nframes > 0 and (sumsq / nframes) >= (threshold * threshold):
                    log.debug("vocals_has_signal: %s passed early at %d frames",
                              vocals_path.name, nframes)
                    return True
    except Exception as e:
        log.warning("vocals_has_signal: read of %s failed: %s", vocals_path, e)
        return True
    if nframes == 0:
        return False
    rms = float(np.sqrt(sumsq / nframes))
    log.debug("vocals_has_signal: %s rms=%.6f threshold=%.6f", vocals_path.name, rms, threshold)
    return rms >= threshold


# ── Output mapping ───────────────────────────────────────────────────────────

# Gap (in seconds) between WhisperX segments that triggers a `+` line break
# syllable in the sloppak output. Bumped from 1.5s (TabGrabber's value) to
# 3.0s after seeing the lower threshold produce short-burst phrasing on
# sung material — singers breathe at ~0.5-1.5s between phrases of the
# same verse, so the tighter cutoff fragmented every line into a few
# words. 3.0s captures stanza-level pauses (verse→chorus, end-of-bridge)
# while keeping intra-line breaths grouped on one rendered line. The
# highway renderer still has its own 4.0s safety fallback (see
# static/highway.js) that forces a wrap regardless, so this only
# controls when WE author breaks vs delegating to the renderer.
_LINE_BREAK_GAP_SECONDS = 3.0

# Floor on per-word duration in the sloppak output. WhisperX occasionally
# emits zero-length words for very short syllables; the highway overlay's
# fade timing expects a non-zero `d`, so clamp here.
_MIN_WORD_DURATION = 0.05

# Semver for the lyric-transcription artifact contract that gets stamped
# into the sloppak manifest's `lyric_transcription` block alongside the
# engine + model. Bump per the semantics defined in feedBack#357 (the
# parent `stem_separation` RFC):
#   * patch — metadata-only or implementation fixes; no regeneration
#   * minor — backward-compatible additions
#   * major — output shape / semantics changed; existing transcriptions
#            should be regenerated
# Independent from any upstream WhisperX / Whisper / wav2vec2 version.
LYRIC_TRANSCRIPTION_SCHEMA_VERSION = "1.0.0"
LYRIC_TRANSCRIPTION_ENGINE = "whisperx"


def _whisperx_to_sloppak(aligned: dict, min_score: float) -> list[dict]:
    """Map WhisperX `aligned` output to sloppak `lyrics.json` shape.

    `aligned` is the dict returned by `whisperx.align()`: a `segments`
    list, each segment carrying a `words` list of `{word, start, end,
    score}` dicts. Drops words below `min_score` (hallucination filter)
    and marks line breaks on segment gaps that exceed
    `_LINE_BREAK_GAP_SECONDS`.

    Line-break encoding follows the frontend lyric renderer's convention
    in `static/highway.js`: `+` is a SUFFIX on the last word of a line,
    not a standalone token. A bare `{"w": "+"}` token would be parsed
    as an empty syllable that ends a line — visible as a blank slot in
    the overlay. Emitting `"world+"` instead keeps the syllable count
    correct and the renderer strips the suffix when drawing.

    Times are rounded to 3 decimals to match the on-disk `lyrics.json`
    convention (docs/sloppak-spec.md §2.3)."""
    out: list[dict] = []
    # `prev_end` tracks the actual end of the last processed segment
    # (NOT the last surviving word), so the gap heuristic measures
    # against real audio timing. Segments whose only words get filtered
    # out still advance the cursor — otherwise the next segment's gap
    # would falsely measure all the way back to whatever survived
    # several segments ago.
    prev_end: float | None = None
    for segment in aligned.get("segments", []) or []:
        words = segment.get("words") or []
        # Walk every word, regardless of whether it survives the
        # confidence filter, so we can apply the line-break heuristic
        # at the moment we actually emit a syllable. Doing the gap
        # check at emit time (vs. once per segment) means a segment
        # whose entire word list gets filtered can't strand a "pending"
        # break that fires against an unrelated syllable in a later
        # segment.
        for w in words:
            text = (w.get("word") or "").strip()
            if not text:
                continue
            start = w.get("start")
            end = w.get("end")
            score = w.get("score")
            # Drop words that fail confidence threshold. WhisperX
            # occasionally emits words without a score (e.g. when
            # alignment couldn't localize them); treat those as
            # untrustworthy and drop too.
            if not isinstance(score, (int, float)) or score < min_score:
                continue
            if not isinstance(start, (int, float)) or not isinstance(end, (int, float)):
                continue
            # Line break: suffix `+` on the previous emitted syllable
            # if there's a comfortably large silence between the last
            # processed-segment cursor and the current surviving word.
            # Anchoring on `prev_end` (segment end), not `out[-1]`'s
            # actual end, keeps the heuristic aligned with real audio
            # timing — a long mid-segment pause within one phrase
            # shouldn't force a break, and a trailing-words-filtered
            # segment shouldn't falsely inflate the gap to the next one.
            if (
                prev_end is not None
                and (float(start) - prev_end) > _LINE_BREAK_GAP_SECONDS
                and out
                and not out[-1]["w"].endswith("+")
            ):
                out[-1]["w"] = out[-1]["w"] + "+"
            duration = max(_MIN_WORD_DURATION, float(end) - float(start))
            out.append({
                "t": round(float(start), 3),
                "d": round(duration, 3),
                "w": text,
            })
        # Advance `prev_end` to the segment's actual end (or the latest
        # numeric word end if the segment lacks an `end`). This runs
        # for every segment — even empty / fully-filtered ones — so
        # the next segment's gap measurement reflects real audio
        # timing regardless of survivorship.
        seg_end = segment.get("end")
        if isinstance(seg_end, (int, float)):
            prev_end = float(seg_end)
        else:
            word_ends = [
                float(w["end"]) for w in words
                if isinstance(w.get("end"), (int, float))
            ]
            if word_ends:
                prev_end = max(word_ends)
    return out


# ── Local transcription ─────────────────────────────────────────────────────

def _pick_compute_type(device: str) -> str:
    """Match TabGrabber's compute-type defaults: float16 on CUDA, int8 on CPU.

    WhisperX accepts float16/float32/int8 on CUDA and int8/float32 on CPU.
    int8 is the only viable choice for CPU inference at usable speeds."""
    return "float16" if device == "cuda" else "int8"


def _resolve_device(device: str | None) -> str:
    if device and device != "auto":
        return device
    try:
        import torch
        return "cuda" if torch.cuda.is_available() else "cpu"
    except ImportError:
        return "cpu"


def _free_gpu_memory() -> None:
    """Force a GC + CUDA cache flush.

    Note that `del`-ing a local in a helper function only deletes the
    helper's parameter binding, not the caller's reference — to actually
    drop the model the caller must null its own variables (see the
    finally block in `transcribe_vocals_local`). This helper only handles
    the GC + CUDA side, which is the same regardless of who held the
    references. Safe to call regardless of CUDA availability or whether
    torch is even installed."""
    gc.collect()
    try:
        import torch
        if torch.cuda.is_available():
            torch.cuda.empty_cache()
    except ImportError:
        pass


def transcribe_vocals_local(
    vocals_path: Path,
    *,
    model_size: str = "medium",
    language: str | None = None,
    device: str | None = None,
    compute_type: str | None = None,
    min_word_score: float = 0.35,
    progress_cb: ProgressCB = None,
) -> list[dict]:
    """Run WhisperX in-process against a vocal stem.

    Deferred whisperx import — callers gate on `whisperx_available()`
    first to avoid the ImportError surfacing here. Heavy: first call
    downloads ~1.5 GB of model weights for `medium` (~3 GB for
    `large-v2`) into the WhisperX cache.

    `model_size` is one of WhisperX's accepted sizes: tiny, base, small,
    medium, large-v2, large-v3. Default `medium` balances accuracy and
    first-run download size; bump to `large-v2` for production quality.

    `language` is an ISO code (e.g. `"en"`); `None` lets WhisperX
    autodetect from the audio.

    `device` is `"cuda"` / `"cpu"` / `None` (auto-detect). `compute_type`
    follows TabGrabber's defaults when `None`."""
    try:
        import whisperx
    except ImportError as e:
        raise RuntimeError(
            "whisperx not installed. Install via `pip install whisperx`."
        ) from e

    resolved_device = _resolve_device(device)
    resolved_compute = compute_type or _pick_compute_type(resolved_device)

    if progress_cb:
        try:
            progress_cb(0.05, "transcribing", f"Loading WhisperX ({model_size}, {resolved_device})")
        except Exception:
            pass

    # Wrap every model lifecycle call in a single try/finally so a failure in
    # load_audio / transcribe / load_align_model still frees the ASR model —
    # otherwise a bad stem in the middle of a batch run strands GPU memory and
    # the next song's load_model OOMs.
    #
    # Caller-side `= None` reassignment is the only way to actually drop the
    # references here; a helper's `del m` only releases the helper's binding,
    # leaving the caller's reference live and the GPU memory pinned until
    # this function returns. That defeats the purpose of running gc + empty
    # cache mid-batch — by the time the next song's transcribe_vocals_local
    # fires, we want the previous model GONE, not held until the caller
    # frame unwinds.
    asr_model = align_model = align_metadata = None
    try:
        asr_model = whisperx.load_model(model_size, resolved_device, compute_type=resolved_compute)
        audio = whisperx.load_audio(str(vocals_path))

        if progress_cb:
            try:
                progress_cb(0.30, "transcribing", "Transcribing vocals")
            except Exception:
                pass

        result = asr_model.transcribe(audio, language=language)
        detected_lang = result.get("language") or language or "en"

        if progress_cb:
            try:
                progress_cb(0.60, "transcribing", f"Aligning words ({detected_lang})")
            except Exception:
                pass

        align_model, align_metadata = whisperx.load_align_model(
            language_code=detected_lang, device=resolved_device
        )
        aligned = whisperx.align(
            result["segments"], align_model, align_metadata, audio,
            resolved_device, return_char_alignments=False,
        )
    finally:
        asr_model = None
        align_model = None
        align_metadata = None
        _free_gpu_memory()

    if progress_cb:
        try:
            progress_cb(0.90, "transcribing", "Building lyric tokens")
        except Exception:
            pass

    return _whisperx_to_sloppak(aligned, min_word_score)


# ── Remote transcription ────────────────────────────────────────────────────

_MAX_ERR_BODY = 4000


def _err_body(resp) -> str:
    """The server's error body, whole if it plausibly is one, and marked when it isn't.

    This was capped at 300 chars, which is enough for "Internal Server Error" and not much else.
    The bodies carrying the most diagnosis are the long ones — a FastAPI validation body naming
    the field it rejected, a 500 whose traceback answers on its LAST line — and those are exactly
    the ones a 300-char cap decapitates. The cap survives so a server answering with a 2 MB HTML
    error page can't dump a novel into a log line.
    """
    # Strip FIRST, then measure: a body that is 300 chars of JSON and 3900 of trailing whitespace
    # is not a long body, and truncating it would cut real content to make room for blanks.
    text = (getattr(resp, "text", "") or "").strip()
    if len(text) <= _MAX_ERR_BODY:
        return text
    # The marker has to fit INSIDE the cap, not be appended past it — otherwise _MAX_ERR_BODY is
    # a suggestion rather than a bound, and the one caller who trusts it (a log line, a job record
    # persisted to disk) is the one who gets surprised.
    marker = f"\n… [truncated, {len(text)} chars total]"
    keep = max(0, _MAX_ERR_BODY - len(marker))
    return text[:keep].rstrip() + marker


def transcribe_vocals_remote(
    vocals_path: Path,
    server_url: str,
    *,
    language: str | None = None,
    api_key: str | None = None,
    timeout: int = 300,
    min_word_score: float = 0.35,
    progress_cb: ProgressCB = None,
) -> list[dict]:
    """POST the vocal stem to `{server_url}/transcribe` and parse the response.

    NOT `/align` — that endpoint is forced alignment ("here are the lyrics,
    tell me when each word is sung") and its `text` field is required. We
    have no lyrics; producing them is the point. Posting there returned a
    422 from FastAPI's validation layer before the server's handler ran, so
    remote transcription never worked at all
    (feedBack-plugin-stem-splitter#17).

    Requires a feedBack-demucs-server carrying `/transcribe`; an older one
    answers 404 and the raised error says so.

    Expects the server to respond with a JSON object carrying a `words` (or
    `segments`) field in WhisperX's native shape; `_whisperx_to_sloppak`
    consumes that directly.

    `min_word_score` is applied to native `segments` responses the same
    way the local path applies it, so the hallucination guard doesn't
    weaken when routing to a remote server. Pre-flattened `{"words": [...]}`
    responses are passed through unfiltered (the server is assumed to
    have applied its own gating before flattening).

    Errors raise `RuntimeError` with a truncated server response, same
    idiom Demucs uses, so the caller can log+continue without bringing
    down the surrounding split job."""
    import requests

    server_url = server_url.rstrip("/")
    if progress_cb:
        try:
            progress_cb(0.10, "transcribing", f"Uploading to WhisperX server ({server_url})")
        except Exception:
            pass

    headers: dict[str, str] = {}
    if api_key:
        headers["Authorization"] = f"Bearer {api_key}"

    # POST to /transcribe, not /align.
    #
    # /align is FORCED ALIGNMENT: "here are the lyrics, tell me when each word is sung". Its
    # `text` field is required, and we have no lyrics — transcription is the whole point. So the
    # server rejected every request with a 422 in FastAPI's validation layer, before its handler
    # ever ran, and remote transcription has never worked for anyone. /transcribe answers the
    # question we are actually asking and takes only the audio.
    # (feedBack-plugin-stem-splitter#17; endpoint added in feedBack-demucs-server#14.)
    #
    # `language` goes in the FORM BODY, not the query string: the server reads it with
    # Form(""), and a query param would be silently ignored — so an explicit language hint would
    # do nothing and Whisper's auto-detection would quietly decide instead, which is exactly the
    # kind of "it works but it's wrong" that hides for months.
    form: dict[str, str] = {}
    if language:
        form["language"] = language

    with open(vocals_path, "rb") as f:
        resp = requests.post(
            f"{server_url}/transcribe",
            files={"file": (vocals_path.name, f, "audio/ogg")},
            data=form or None,
            headers=headers or None,
            timeout=timeout,
        )

    if resp.status_code != 200:
        raise RuntimeError(f"WhisperX server error ({resp.status_code}): {_err_body(resp)}")

    data = resp.json()

    # Two response shapes are accepted, in this order of preference:
    #
    #   1. Native WhisperX `{"segments": [...]}` — let the standard
    #      mapper handle it (line breaks + score filter + clamps).
    #   2. Pre-flattened sloppak shape `{"words": [{"t","d","w"}, ...]}`
    #      — pass through with rounding for parity with local path.
    #
    # Anything else is an error: surface enough of the response that
    # `_maybe_transcribe_lyrics` can log it and move on.
    if "segments" in data:
        return _whisperx_to_sloppak(data, min_score=min_word_score)
    if "words" in data:
        raw_words = data["words"]
        if not isinstance(raw_words, list):
            raise RuntimeError(
                f"WhisperX server returned non-list `words`: {type(raw_words).__name__}"
            )
        out: list[dict] = []
        for w in raw_words:
            # Defensive: a malformed server could ship strings, numbers,
            # or partial dicts. Skip anything that isn't a dict with all
            # three required keys so the loop doesn't crash on bad data —
            # the worst case is a partial transcription, not a wedged job.
            if not isinstance(w, dict):
                continue
            if "t" not in w or "d" not in w or "w" not in w:
                continue
            try:
                out.append({
                    "t": round(float(w["t"]), 3),
                    "d": round(float(w["d"]), 3),
                    "w": str(w["w"]),
                })
            except (TypeError, ValueError):
                # Bad numeric types on this entry; skip and continue.
                continue
        return out
    raise RuntimeError(f"WhisperX server returned unrecognized shape: {str(data)[:300]}")
