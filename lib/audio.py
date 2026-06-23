"""Audio extraction and conversion for custom songs."""

import logging
import os
import re
import shutil
import subprocess
from pathlib import Path

log = logging.getLogger("feedBack.lib.audio")

# Maximum length of any single decoder-error fragment that we surface to
# the client. ffmpeg can emit multi-kB build-configuration / version
# banners on failure, which would make the WebSocket `audio_error`
# payload huge and bury the actionable bit.
_MAX_DECODER_DETAIL_CHARS = 500


def _basename_any_path(raw: str) -> str:
    """Cross-platform basename: recognises both `/` and `\\` as
    separators regardless of host, and strips trailing separators before
    splitting so a directory match collapses to its final segment
    instead of the empty string.

    `os.path.basename` is platform-specific — on POSIX it only treats
    `/` as a separator, so a Windows path emitted by a decoder running
    inside a cross-platform error log would leak through verbatim."""
    candidate = raw.rstrip("/\\")
    if not candidate:
        return raw
    last = max(candidate.rfind("/"), candidate.rfind("\\"))
    base = candidate[last + 1:] if last >= 0 else candidate
    return base or raw


# Lines that match this regex are version / build banner output that
# ffmpeg (and friends) emit before the actual error message. They're
# never actionable on their own — the useful error is somewhere after.
_BANNER_LINE_RE = re.compile(
    r"""^\s*(
        ffmpeg\sversion             # e.g. "ffmpeg version 4.4.2-..."
        | built\swith               # "  built with gcc ..."
        | configuration:            # "  configuration: ..."
        | lib(av\w+|sw\w+|postproc) # "  libavutil 56.70.100"
        | Stream\smapping:          # ffmpeg's "Stream mapping:" header
        | Input\s\#                 # "Input #0, wav, from ..."
        | Output\s\#                # "Output #0, mp3, ..."
        | Duration:                 # "  Duration: ..."
        | Press\s\[q\]              # interactive prompts
    )""",
    re.VERBOSE,
)


def _truncate_detail(text: str, limit: int = _MAX_DECODER_DETAIL_CHARS) -> str:
    """Shrink a multi-line decoder stderr blob to one actionable line
    under `limit` characters.

    ffmpeg-style failures start with a multi-line version / build /
    config banner and put the actual error after it, so naive
    "first non-empty line" picks the banner. Skip lines matching
    `_BANNER_LINE_RE` and prefer the first remaining non-empty line.
    If every line matched the banner pattern (shouldn't happen in
    practice but cover the case), fall back to the first non-empty
    line so we don't end up emitting an empty string."""
    lines = [ln for ln in text.splitlines() if ln.strip()]
    actionable = next(
        (ln for ln in lines if not _BANNER_LINE_RE.match(ln)),
        None,
    )
    if actionable is None:
        actionable = lines[0] if lines else text.strip()
    actionable = actionable.strip()
    if len(actionable) <= limit:
        return actionable
    return actionable[:limit - 1].rstrip() + "…"


# Unquoted absolute paths: stop at whitespace or common delimiters. The
# quote characters are excluded so the quoted-path pass (below) can
# claim those matches instead.
#
# Drive-letter Windows paths support both separator conventions —
# `C:\Users\…` and `C:/Users/…`. Native Windows APIs and many tools
# (PowerShell, .NET, ffmpeg with -i C:/...) emit the forward-slash form,
# and the unquoted-path branch alone can't handle that case without it
# because the body `[^\s"'`<>|]+` would never have matched the
# colon-then-slash prefix.
_UNQUOTED_ABS_PATH_RE = re.compile(
    r"""(?:
        (?:[A-Za-z]:[\\/] | \\\\)    # Windows: C:\… / C:/… or UNC \\host\…
        | /                          # POSIX: leading /
    )
    [^\s"'`<>|]+
    """,
    re.VERBOSE,
)

# Quoted absolute paths (single, double, or backtick quotes). Captures
# the opening quote so the replacement can keep the quoting wrapper
# intact while collapsing the inner path to its basename. Allows spaces
# in the path — that's the whole reason quotes get used in stderr
# output (`C:\Program Files\…`, `/Users/Alice/My Secrets/…`).
_QUOTED_ABS_PATH_RE = re.compile(
    r"""(['"`])
        ((?:[A-Za-z]:[\\/] | \\\\ | /)
         [^'"`\n]+)
        \1
    """,
    re.VERBOSE,
)


def _scrub_unquoted_match(match: re.Match) -> str:
    return _basename_any_path(match.group(0))


def _scrub_quoted_match(match: re.Match) -> str:
    quote = match.group(1)
    inner = match.group(2)
    return f"{quote}{_basename_any_path(inner)}{quote}"


def _bundled_bin_dir() -> Path | None:
    """Resolve the desktop bundle's resources/bin/ directory if we're
    running inside one. Layout: resources/feedBack/lib/audio.py →
    resources/bin/. Gate on vgmstream-cli's presence so we don't
    misidentify random parent dirs (e.g. Docker's `/bin`, dev
    layouts where parents[2] resolves to the repo root) — vgmstream-cli
    is bundled on every desktop platform and isn't a typical system
    binary, so it's a precise signature for the desktop layout."""
    bundled = Path(__file__).resolve().parents[2] / "bin"
    if any((bundled / n).is_file() for n in ("vgmstream-cli", "vgmstream-cli.exe")):
        return bundled
    return None


def _bundled_or_path(name: str) -> str | None:
    """Prefer the bundled binary on desktop, fall back to PATH lookup.

    Necessary because Electron's child PATH on macOS / Linux puts
    user-installed binaries (Homebrew `/opt/homebrew/bin`, /usr/local)
    before our `resources/bin`, so `shutil.which` alone picks up the
    user's binary — which may have been built without the features
    we rely on (e.g. Homebrew ffmpeg formulas that omit libvorbis)."""
    bundled = _bundled_bin_dir()
    if bundled is not None:
        for fname in (name, f"{name}.exe"):
            cand = bundled / fname
            if cand.is_file():
                return str(cand)
    return shutil.which(name)


def _repo_root() -> Path:
    """Return the repository root for local binary fallbacks."""
    return Path(__file__).resolve().parent.parent


def _resolve_executable(candidate: str | None) -> str | None:
    """Resolve either a command name on PATH or an explicit executable path.

    Explicit paths must refer to a regular file (directories often satisfy
    os.access(..., X_OK) on POSIX but cannot be exec'd by subprocess)."""
    if not candidate:
        return None
    if os.path.sep in candidate or (os.path.altsep and os.path.altsep in candidate):
        path = Path(candidate).expanduser()
        if path.is_file() and os.access(path, os.X_OK):
            return str(path.resolve())
        return None
    return shutil.which(candidate)


def _vgmstream_cmd(resolution_notes: list[str] | None = None) -> str | None:
    """Return the best available vgmstream-cli executable.

    Resolution order:
      1. `VGMSTREAM_CLI` env var (explicit override — must beat everything
         else so a user can force a known-good binary when the bundled or
         system one is broken)
      2. Bundled `resources/bin/vgmstream-cli` (desktop)
      3. `vgmstream-cli` on PATH
      4. Repo-local build outputs (autotools `.libs/`, CMake `build/cli/`,
         and the in-tree `vgmstream/cli/` location), checked for both Unix
         and Windows (`.exe`) names so a local `cmake --build` discovered
         off-PATH still works.

    `vgmstream123` is intentionally excluded: it is a player-style frontend
    with a different argument schema and cannot be invoked with the
    `-o <wav> <wem>` interface the rest of this module assumes.

    `resolution_notes` (optional): when provided, the resolver appends
    human-readable warnings about resolution-time problems (e.g. a
    `VGMSTREAM_CLI` value that didn't resolve). Callers that surface
    decode failures to the user can fold these into the final error
    message so the user understands why their override was ignored
    instead of seeing only the generic "no decoder found" guidance."""
    env_value = os.environ.get("VGMSTREAM_CLI")
    explicit = _resolve_executable(env_value)
    if explicit:
        return explicit
    if env_value:
        # The env var is documented as an explicit override, so silently
        # falling through when it's set to a stale or non-executable path
        # is misleading. Log a warning so the user sees why their override
        # didn't take, but don't raise — we still want the next fallback
        # to succeed if e.g. PATH has a working binary.
        log.warning(
            "VGMSTREAM_CLI=%r is set but does not resolve to an "
            "executable file; falling through to other candidates",
            env_value,
        )
        if resolution_notes is not None:
            # Don't echo the env's full value back to the user — it's an
            # absolute path; the basename + "ignored" is enough to point
            # them at their misconfiguration without leaking layout.
            # `_basename_any_path` (not `os.path.basename`) so a Windows
            # value on a POSIX host still collapses correctly.
            resolution_notes.append(
                f"VGMSTREAM_CLI={_basename_any_path(env_value) or '<set>'!r}"
                " is not an executable file and was ignored"
            )

    bundled_dir = _bundled_bin_dir()
    if bundled_dir is not None:
        for fname in ("vgmstream-cli", "vgmstream-cli.exe"):
            cand = bundled_dir / fname
            # Same exec check we apply to env/repo-local candidates —
            # a present-but-not-executable file (lost +x after a tar
            # extract, marked unreadable, etc.) would otherwise be
            # returned here and block the perfectly fine PATH binary
            # below from getting a chance.
            if cand.is_file() and os.access(cand, os.X_OK):
                return str(cand)

    on_path = shutil.which("vgmstream-cli")
    if on_path:
        return on_path

    root = _repo_root()
    for rel in (
        "vgmstream/build/cli/vgmstream-cli",
        "vgmstream/build/cli/vgmstream-cli.exe",
        "vgmstream/cli/vgmstream-cli",
        "vgmstream/cli/vgmstream-cli.exe",
        "vgmstream/cli/.libs/vgmstream-cli",
        "vgmstream/cli/.libs/vgmstream-cli.exe",
    ):
        resolved = _resolve_executable(str(root / rel))
        if resolved:
            return resolved

    return None


def _ffmpeg_cmd() -> str | None:
    """Return the path to ffmpeg, preferring the bundled binary."""
    return _bundled_or_path("ffmpeg")


def _ffmpeg_wav_to_ogg(ffmpeg: str, wav: Path, out_ogg: Path) -> subprocess.CompletedProcess:
    """Encode WAV → Ogg Vorbis. Prefers libvorbis (external, full quality);
    if the ffmpeg build lacks it (some Homebrew formulas no longer set
    --enable-libvorbis), retries with ffmpeg's built-in `vorbis` encoder
    under `-strict experimental`. Same .ogg container either way; the
    built-in path produces a lower-quality file but always works."""
    r = subprocess.run(
        [ffmpeg, "-y", "-i", str(wav), "-c:a", "libvorbis", "-q:a", "5", str(out_ogg)],
        capture_output=True,
    )
    if r.returncode == 0 and out_ogg.exists() and out_ogg.stat().st_size >= 100:
        return r
    if b"Unknown encoder 'libvorbis'" not in (r.stderr or b""):
        return r
    return subprocess.run(
        [ffmpeg, "-y", "-i", str(wav),
         "-c:a", "vorbis", "-strict", "experimental", "-q:a", "5", str(out_ogg)],
        capture_output=True,
    )


def _scrub_paths(text: str, *paths: str) -> str:
    """Replace absolute filesystem paths in `text` with their basenames.

    Decoder error strings get joined into the RuntimeError that
    `convert_wem` raises, and feedBack surfaces that text in the
    browser as `audio_error`. Leaking install / user / DLC paths to the
    client is a needless info disclosure, so before any decoder error
    leaves this module we strip absolute paths down to their final
    segment.

    Two-pass approach:
      1. Replace each *known* path (decoder binary, input WEM, intended
         output) verbatim so its basename survives even when the path
         contains characters the generic regex's character class
         excludes (e.g. quoted arguments).
      2. Run the generic absolute-path regex over the remainder so
         paths the decoder emitted itself ("could not open
         /unrelated/private/file") also get redacted to their
         basename. Decoders sometimes log paths the caller never
         passed in (e.g. plugin search paths, dynamic loader paths),
         and those are exactly the ones the caller can't enumerate."""
    out = text
    for p in paths:
        if not p:
            continue
        out = out.replace(p, _basename_any_path(p))
    # Quoted paths first so the unquoted pass doesn't claim part of a
    # quoted match — paths with spaces only survive when quoted, so we
    # need that branch to win there.
    out = _QUOTED_ABS_PATH_RE.sub(_scrub_quoted_match, out)
    out = _UNQUOTED_ABS_PATH_RE.sub(_scrub_unquoted_match, out)
    return out


def _decode_wem_to_wav(vgmstream: str, wem_path: str, wav_path: str) -> tuple[bool, str]:
    """Decode a WEM file to WAV using vgmstream and return status + detail.

    Catches launch-time OSError (wrong architecture, missing dynamic loader,
    permission errors a stat-check can't predict) so callers can record the
    failure and fall through to ffmpeg / ww2ogg instead of crashing. The
    returned detail is scrubbed of absolute paths because callers fold it
    into the user-facing decode error."""
    try:
        r = subprocess.run(
            [vgmstream, "-o", wav_path, wem_path],
            capture_output=True,
            text=True,
            # `errors='replace'` — without this, a vgmstream build that
            # emits non-UTF-8 bytes (corrupt input, locale mismatch) makes
            # subprocess.run raise UnicodeDecodeError and bypass the
            # failure-aggregation path the caller relies on.
            errors="replace",
            timeout=120,
        )
    except (OSError, subprocess.TimeoutExpired) as exc:
        # Log the full path server-side for ops, but keep the client-facing
        # detail path-neutral. OSError/TimeoutExpired stringify with the
        # command path or filename in many cases (e.g. exec-format errors
        # quote the filename, TimeoutExpired stringifies the cmd list), so
        # the exc text itself also needs scrubbing.
        log.warning("vgmstream launch failed (%s): %s", vgmstream, exc)
        scrubbed = _scrub_paths(str(exc), vgmstream, wem_path, wav_path)
        return False, f"failed to invoke {_basename_any_path(vgmstream)}: {_truncate_detail(scrubbed)}"

    if r.returncode == 0 and os.path.exists(wav_path) and os.path.getsize(wav_path) > 0:
        return True, ""

    # Strip both streams before choosing which to report — a whitespace-only
    # stderr would otherwise suppress a useful stdout message and the caller
    # would see only "exit code N".
    err = (r.stderr or "").strip()
    out = (r.stdout or "").strip()
    detail = err or out or f"exit code {r.returncode}"
    return False, _truncate_detail(_scrub_paths(detail, vgmstream, wem_path, wav_path))


def find_wem_files(extracted_dir: str) -> list[str]:
    """Find WEM audio files, sorted largest first (full song before preview)."""
    wem_files = list(Path(extracted_dir).rglob("*.wem"))
    wem_files.sort(key=lambda p: p.stat().st_size, reverse=True)
    return [str(f) for f in wem_files]


def convert_wem(wem_path: str, output_base: str) -> str:
    """
    Convert a WEM file to a playable format.
    Returns path to the converted audio file.
    """
    # `errors` holds *attempted-decoder* failures (something ran, didn't
    # work); `resolution_notes` holds *configuration* warnings (e.g.
    # a stale VGMSTREAM_CLI). Keeping them separate matters for the
    # final branch: if every decoder is missing entirely we want the
    # actionable "install vgmstream-cli" guidance, not "Failed to
    # decode" — but the resolution note should still ride along on
    # either path so a misconfigured user understands why their
    # override was ignored.
    errors: list[str] = []
    resolution_notes: list[str] = []

    # Try vgmstream-cli → WAV → MP3 (best browser compatibility).
    vgmstream = _vgmstream_cmd(resolution_notes=resolution_notes)
    if vgmstream:
        wav = output_base + ".wav"
        ok, detail = _decode_wem_to_wav(vgmstream, wem_path, wav)
        if ok:
            ffmpeg = _ffmpeg_cmd()
            if ffmpeg:
                mp3 = output_base + ".mp3"
                # Same OSError/timeout protection as the direct-fallback
                # ffmpeg calls below — vgmstream decoded fine, but a
                # wrong-arch / missing-loader ffmpeg would otherwise
                # raise raw out of convert_wem instead of letting us
                # fall back to returning the decoded WAV.
                try:
                    r2 = subprocess.run(
                        [ffmpeg, "-y", "-i", wav, "-b:a", "192k", mp3],
                        capture_output=True,
                        timeout=120,
                    )
                except (OSError, subprocess.TimeoutExpired) as exc:
                    log.warning("ffmpeg MP3-transcode launch failed (%s): %s", ffmpeg, exc)
                    r2 = None
                if r2 is not None and r2.returncode == 0 and os.path.exists(mp3):
                    os.remove(wav)
                    return mp3
            return wav
        errors.append(f"vgmstream: {detail}")

    # Try ffmpeg directly (some builds handle Wwise). Wrap subprocess.run
    # in try/except like _decode_wem_to_wav does — a wrong-architecture
    # or broken-loader ffmpeg binary would otherwise raise OSError out of
    # convert_wem and the browser would receive the raw exception text
    # (including absolute paths) instead of the scrubbed aggregated
    # decoder error, while also skipping the ww2ogg fallback below.
    ffmpeg = _ffmpeg_cmd()
    if ffmpeg:
        mp3 = output_base + ".mp3"
        try:
            r = subprocess.run(
                [ffmpeg, "-y", "-i", wem_path, "-b:a", "192k", mp3],
                capture_output=True,
                timeout=120,
            )
        except (OSError, subprocess.TimeoutExpired) as exc:
            log.warning("ffmpeg launch failed (%s): %s", ffmpeg, exc)
            errors.append(
                f"ffmpeg mp3: failed to invoke {_basename_any_path(ffmpeg)}: "
                + _truncate_detail(_scrub_paths(str(exc), ffmpeg, wem_path, mp3))
            )
            r = None
        if r is not None:
            if r.returncode == 0 and os.path.exists(mp3) and os.path.getsize(mp3) > 0:
                return mp3
            stderr = (r.stderr or b'').decode(errors='replace').strip() or f"exit code {r.returncode}"
            errors.append(
                f"ffmpeg mp3: {_truncate_detail(_scrub_paths(stderr, ffmpeg, wem_path, mp3))}"
            )

        # Try WAV output as fallback
        wav = output_base + ".wav"
        try:
            r = subprocess.run(
                [ffmpeg, "-y", "-i", wem_path, wav],
                capture_output=True,
                timeout=120,
            )
        except (OSError, subprocess.TimeoutExpired) as exc:
            log.warning("ffmpeg launch failed (%s): %s", ffmpeg, exc)
            errors.append(
                f"ffmpeg wav: failed to invoke {_basename_any_path(ffmpeg)}: "
                + _truncate_detail(_scrub_paths(str(exc), ffmpeg, wem_path, wav))
            )
            r = None
        if r is not None:
            if r.returncode == 0 and os.path.exists(wav) and os.path.getsize(wav) > 0:
                return wav
            stderr = (r.stderr or b'').decode(errors='replace').strip() or f"exit code {r.returncode}"
            errors.append(
                f"ffmpeg wav: {_truncate_detail(_scrub_paths(stderr, ffmpeg, wem_path, wav))}"
            )

    # Try ww2ogg — same launch-failure protection as ffmpeg above.
    # `shutil.which` confirms the file is executable, not that the kernel
    # can actually exec it (wrong arch / missing loader still raise here).
    ww2ogg = shutil.which("ww2ogg")
    if ww2ogg:
        ogg = output_base + ".ogg"
        try:
            r = subprocess.run(
                [ww2ogg, wem_path, "-o", ogg],
                capture_output=True,
                timeout=120,
            )
        except (OSError, subprocess.TimeoutExpired) as exc:
            log.warning("ww2ogg launch failed (%s): %s", ww2ogg, exc)
            errors.append(
                f"ww2ogg: failed to invoke {_basename_any_path(ww2ogg)}: "
                + _truncate_detail(_scrub_paths(str(exc), ww2ogg, wem_path, ogg))
            )
            r = None
        if r is not None:
            if r.returncode == 0 and os.path.exists(ogg) and os.path.getsize(ogg) > 0:
                return ogg
            stderr = (r.stderr or b'').decode(errors='replace').strip() or f"exit code {r.returncode}"
            errors.append(
                f"ww2ogg: {_truncate_detail(_scrub_paths(stderr, ww2ogg, wem_path, ogg))}"
            )

    _INSTALL_GUIDANCE = (
        "Install vgmstream-cli:\n"
        "  Manjaro/Arch:  yay -S vgmstream-cli-bin\n"
        "  Or set VGMSTREAM_CLI to a built binary, e.g. vgmstream/cli/vgmstream-cli"
    )

    user_msg_prefix = " | ".join(resolution_notes) + (" | " if resolution_notes else "")

    if errors:
        # Something ran and failed. `wem_path` is the on-disk input
        # path, often deep inside the user's DLC dir — log the full
        # path for ops, but keep the client-facing error to just the
        # filename. If vgmstream itself was never resolved (only ffmpeg
        # or ww2ogg tried-and-failed), append the install guidance —
        # ffmpeg is commonly present and often can't decode Wwise WEMs,
        # so without this hint a user missing the primary decoder
        # never sees "install vgmstream-cli" guidance.
        suffix = ""
        if not vgmstream:
            suffix = f" | (Hint: {_INSTALL_GUIDANCE})"
        log.warning("Decode failed for %s: %s",
                    wem_path, " | ".join([*resolution_notes, *errors]))
        raise RuntimeError(
            f"Failed to decode WEM {_basename_any_path(wem_path)}: "
            + user_msg_prefix + " | ".join(errors) + suffix
        )

    # No decoder ran at all — give the actionable guidance, with the
    # resolution note prefixed so a user who *did* set VGMSTREAM_CLI
    # (incorrectly) understands why their override didn't help.
    raise RuntimeError(
        user_msg_prefix + "No WEM audio decoder found. " + _INSTALL_GUIDANCE
    )
