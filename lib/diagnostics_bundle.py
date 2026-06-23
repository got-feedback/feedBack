"""Diagnostic bundle assembly.

Builds the zip described in docs/diagnostics-bundle-spec.md. Pure
function — `build_bundle()` returns bytes; the FastAPI handler is the
only place that wraps it in an HTTP response.

`preview_bundle()` returns the same file tree without packaging the zip
so the UI can show the user what's about to be exported.
"""

from __future__ import annotations

import base64
import datetime
import io
import json
import logging
import os
import platform
import queue
import re
import sys
import threading
import zipfile
from pathlib import Path

from diagnostics_hardware import collect as collect_hardware, detect_runtime
from diagnostics_redact import Redactor

BUNDLE_SCHEMA = 1
LOG_TAIL_BYTES = 5 * 1024 * 1024  # 5 MB
CALLABLE_TIMEOUT_S = 10  # seconds; prevents a hung plugin from stalling an export


def _safe_zip_segment(plugin_id: str) -> str:
    """Return *plugin_id* sanitized for use as a single ZIP path segment.

    Plugin ids may contain dots (``com.example.foo``), hyphens, and
    underscores, all of which are valid in ZIP archive path segments.
    Forward slashes and backslashes are not — they introduce path traversal.

    Uses a bijective percent-encoding scheme so no two distinct plugin ids
    produce the same segment: ``%`` → ``%25``, ``/`` → ``%2F``,
    ``\\`` → ``%5C``.  Encoding ``%`` first ensures the scheme is reversible
    (a literal ``%2F`` in a plugin id encodes to ``%252F``, which is
    unambiguous).  Normal ids with underscores, dots, and hyphens pass
    through unchanged.

    Additionally, bare dot-segments (``.`` and ``..``) are encoded as
    ``%2E`` / ``%2E%2E`` to prevent path-traversal after archive extraction
    (many unzip tools normalise ``plugins/../manifest.json`` to
    ``manifest.json``).
    """
    result = plugin_id.replace("%", "%25").replace("/", "%2F").replace("\\", "%5C")
    if result == ".":
        return "%2E"
    if result == "..":
        return "%2E%2E"
    return result


CALLABLE_CONCURRENCY_LIMIT = 4  # max concurrent diagnostic callable threads
_CALLABLE_SEMAPHORE = threading.BoundedSemaphore(CALLABLE_CONCURRENCY_LIMIT)


def _run_callable_with_daemon_thread(
    fn, ctx: dict, timeout: float
) -> tuple[object, Exception | None]:
    """Invoke *fn(ctx)* in a daemon thread, returning ``(result, exc)``.

    Uses a module-level bounded semaphore (``_CALLABLE_SEMAPHORE``, capacity
    ``CALLABLE_CONCURRENCY_LIMIT``) to cap the number of live callable threads
    at any moment.  If the bound is already reached (e.g. N previous exports
    whose callables are still running past their timeout), this call returns a
    skipped error immediately *without* spawning a new thread, so the process
    cannot accumulate unbounded live threads.

    The semaphore is always released by the *worker thread* in its
    ``finally`` block — never by the caller on timeout — so each slot is
    freed when the thread eventually completes regardless of how long it takes.
    """
    if not _CALLABLE_SEMAPHORE.acquire(blocking=False):
        return None, RuntimeError(
            f"callable skipped: {CALLABLE_CONCURRENCY_LIMIT} concurrent "
            "diagnostic callable threads already running"
        )

    _result_q: queue.Queue = queue.Queue(maxsize=1)

    def _worker() -> None:
        try:
            _result_q.put_nowait((fn(ctx), None))
        except Exception as e:  # noqa: BLE001
            _result_q.put_nowait((None, e))
        finally:
            _CALLABLE_SEMAPHORE.release()

    threading.Thread(target=_worker, daemon=True, name="diag-callable").start()
    try:
        return _result_q.get(timeout=timeout)
    except queue.Empty:
        # The worker is still running.  Do NOT release the semaphore here —
        # the worker will release it when it eventually finishes.  That keeps
        # the live-thread count bounded.
        return None, TimeoutError(
            f"callable timed out after {timeout}s"
        )


def _callable_semaphore_free_slots() -> int:
    """Return the number of free slots in the callable concurrency semaphore.

    Exposed for testing only: lets tests wait for leftover threads from
    previous test cases to finish without accessing CPython internals directly.
    """
    return _CALLABLE_SEMAPHORE._value  # noqa: SLF001 (test-only helper)

# Placeholder bytes injected by preview_bundle() for plugins that declare a
# diagnostics callable.  The real export emits exactly one of callable.json /
# callable.bin / callable.txt; the preview cannot know which, so it always
# advertises callable.json and notes the ambiguity.  Defined at module level
# to avoid re-serializing on every preview request.
_CALLABLE_PREVIEW_PLACEHOLDER: bytes = (
    '{"preview_placeholder": true, "schema": "plugin.callable_output.v1", '
    '"note": "callable output — actual file will be callable.json, '
    'callable.bin, or callable.txt depending on return type"}'
).encode("utf-8")

ENV_ALLOWLIST = (
    "LOG_LEVEL",
    "LOG_FORMAT",
    "LOG_FILE",
    "FEEDBACK_RUNTIME",
    "PORT",
    "HOST",
    "TZ",
    "PYTHONUNBUFFERED",
    "DEMUCS_SERVER_URL",
)


def _now_iso() -> str:
    return datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def _now_filename_slug() -> str:
    return datetime.datetime.now(datetime.timezone.utc).strftime("%Y%m%d-%H%M%S")


def _safe_json_dumps(obj) -> str:
    try:
        return json.dumps(obj, indent=2, sort_keys=True, default=str)
    except (TypeError, ValueError):
        return json.dumps({"error": "unserializable payload"}, indent=2)


def _system_version(feedBack_version: str, redactor=None) -> dict:
    executable = sys.executable
    if redactor is not None:
        executable = redactor.redact_text(executable)
    return {
        "schema": "system.version.v1",
        "feedBack_version": feedBack_version,
        "python": {
            "version": platform.python_version(),
            "implementation": platform.python_implementation(),
            "executable": executable,
        },
        "os": {
            "system": platform.system(),
            "release": platform.release(),
            "machine": platform.machine(),
        },
        "exported_at": _now_iso(),
    }


def _system_env(redactor=None) -> dict:
    raw_vars = {k: os.environ.get(k) for k in ENV_ALLOWLIST if k in os.environ}
    if redactor is not None:
        raw_vars = {
            k: redactor.redact_text(v) if isinstance(v, str) else v
            for k, v in raw_vars.items()
        }
    return {
        "schema": "system.env.v1",
        "vars": raw_vars,
    }


def _summarize_payload(path: str, parsed) -> dict | None:
    """Extract a small, user-readable summary dict from a parsed JSON
    payload — used by the preview UI to surface counts inline. Returns
    None when there's nothing useful to surface for this path."""
    if not isinstance(parsed, dict):
        return None
    if path == "system/plugins.json":
        return {
            "loaded_count": len(parsed.get("plugins", []) or []),
            "orphan_count": len(parsed.get("orphans", []) or []),
        }
    if path == "client/console.json":
        entries = parsed.get("entries", []) or []
        levels: dict[str, int] = {}
        for e in entries:
            if isinstance(e, dict):
                lvl = str(e.get("level", "log"))
                levels[lvl] = levels.get(lvl, 0) + 1
        return {"entry_count": len(entries), "by_level": levels}
    if path == "system/hardware.json":
        cpu = parsed.get("cpu") or {}
        gpus = parsed.get("gpu") or []
        runtime = parsed.get("runtime") or {}
        out: dict = {
            "cpu_brand": cpu.get("brand"),
            "cores_logical": cpu.get("cores_logical"),
            "gpu_count": len(gpus),
            "runtime": runtime.get("kind"),
        }
        return {k: v for k, v in out.items() if v is not None}
    if path == "client/hardware.json":
        wgl = parsed.get("webgl") or {}
        runtime = parsed.get("runtime") or {}
        out = {
            "runtime": runtime.get("kind"),
            "webgl_renderer": wgl.get("renderer"),
        }
        return {k: v for k, v in out.items() if v}
    if path == "client/local_storage.json":
        data = parsed.get("data") or {}
        return {"key_count": len(data)}
    if path == "system/version.json":
        py = parsed.get("python") or {}
        os_ = parsed.get("os") or {}
        return {
            "feedBack": parsed.get("feedBack_version"),
            "python": py.get("version"),
            "os": os_.get("system"),
        }
    return None


def _resolve_git_dir(plugin_dir: Path) -> Path | None:
    """Return the plugin's actual `.git` directory.

    `.git` may be a directory (standalone clone) or a single-line file
    pointing at `gitdir: <relpath>` (submodule, worktree, or
    `git init --separate-git-dir` setup). Returns None when the dir
    isn't a git checkout.
    """
    git_path = plugin_dir / ".git"
    if not git_path.exists():
        return None
    if git_path.is_dir():
        return git_path
    if git_path.is_file():
        try:
            line = git_path.read_text(encoding="utf-8", errors="ignore").strip()
        except OSError:
            return None
        if line.startswith("gitdir:"):
            target = line[len("gitdir:"):].strip()
            target_path = (plugin_dir / target).resolve() if not Path(target).is_absolute() else Path(target)
            if target_path.exists():
                return target_path
    return None


def _read_head_sha(git_dir: Path) -> str | None:
    """Resolve `.git/HEAD` to a short SHA without shelling out.

    HEAD is either a 40-char SHA (detached) or `ref: refs/heads/<name>`
    pointing at a loose ref or an entry in packed-refs. Best-effort —
    returns None on any malformed file.
    """
    head_file = git_dir / "HEAD"
    if not head_file.exists():
        return None
    try:
        head = head_file.read_text(encoding="utf-8", errors="ignore").strip()
    except OSError:
        return None
    if not head:
        return None
    if not head.startswith("ref:"):
        # Detached HEAD — value is the SHA itself.
        return head[:7] if len(head) >= 7 else None
    ref = head[4:].strip()
    # 1. Loose ref file (most common for active branch)
    ref_file = git_dir / ref
    if ref_file.exists():
        try:
            sha = ref_file.read_text(encoding="utf-8", errors="ignore").strip()
            if sha:
                return sha[:7]
        except OSError:
            pass
    # 2. packed-refs (the ref has been packed; happens after gc)
    packed = git_dir / "packed-refs"
    if packed.exists():
        try:
            for line in packed.read_text(encoding="utf-8", errors="ignore").splitlines():
                if line.startswith("#") or line.startswith("^"):
                    continue
                parts = line.split(" ", 1)
                if len(parts) == 2 and parts[1] == ref:
                    return parts[0][:7]
        except OSError:
            pass
    return None


def _read_remote_url(git_dir: Path) -> str | None:
    """Parse `[remote "origin"] url = ...` out of `.git/config`."""
    cfg = git_dir / "config"
    if not cfg.exists():
        return None
    try:
        text = cfg.read_text(encoding="utf-8", errors="ignore")
    except OSError:
        return None
    in_origin = False
    for line in text.splitlines():
        stripped = line.strip()
        if not stripped or stripped.startswith("#"):
            continue
        if stripped.startswith("["):
            # Section header — match `[remote "origin"]` exactly.
            in_origin = stripped.lower().replace(" ", "") == '[remote"origin"]'
            continue
        if in_origin and stripped.lower().startswith("url"):
            _key, _, val = stripped.partition("=")
            return val.strip() or None
    return None


def _git_info(plugin_dir: Path) -> dict | None:
    """Return git short SHA + remote URL for a plugin checkout.

    Pure-Python — reads `.git/HEAD` and `.git/config` directly so this
    works in containers without the `git` binary installed (feedBack's
    runtime image is minimal). Plugins are gitlinks (see CLAUDE.md);
    the SHA is the most reliable "what build is this" identifier.

    Dirty detection isn't included — checking for uncommitted changes
    requires walking the index and computing object hashes, which is
    too much code to maintain in a diagnostics path. If a maintainer
    needs that signal, install git in the runtime image and we can
    add a `git status --porcelain` shell-out as a separate field.
    """
    git_dir = _resolve_git_dir(plugin_dir)
    if git_dir is None:
        return None
    info: dict = {}
    sha = _read_head_sha(git_dir)
    if sha:
        info["sha"] = sha
    remote = _read_remote_url(git_dir)
    if remote:
        info["remote"] = _sanitize_remote_url(remote)
    return info or None


def _sanitize_remote_url(url: str) -> str:
    """Strip userinfo (embedded credentials) from a git remote URL.

    Git remotes legally embed credentials in the URL, e.g.:
        https://mytoken@github.com/org/repo.git
        https://user:password@bitbucket.org/org/repo.git

    Those must not appear verbatim in a diagnostics bundle that users
    post publicly. We strip only the userinfo component so the host/path
    (useful for identifying which plugin) is preserved.
    """
    # HTTP(S) URLs with credentials: https://user[:pass]@host/...
    sanitized = re.sub(r"(?i)(https?://)([^@/]+@)", r"\1", url)
    # Secrets are also sometimes embedded as ?token=... or &token=...
    # in clone URLs (rare but possible). The existing _QSTRING_SECRET_RE
    # regex handles those in redact_text, but we can't call the Redactor
    # here because we have no salt. Strip the known secret params directly.
    sanitized = re.sub(
        r"(?i)([?&])(api[_-]?key|key|token|secret|password|pwd|auth)=[^\s&\"']+",
        r"\1\2=<redacted>",
        sanitized,
    )
    return sanitized


def _system_plugins(loaded_plugins: list[dict], plugins_root: "Path | list[Path] | None" = None, redactor=None) -> dict:
    """Build `system.plugins.v1`. Captures every loaded plugin with
    git/manifest info, AND every directory under each plugins root that
    contains a `plugin.json` so orphan / failed-to-load plugins still
    show up in the bundle.

    *plugins_root* accepts a single Path, a list of Paths (to cover both
    the built-in ``plugins/`` directory and ``FEEDBACK_PLUGINS_DIR``), or
    None to skip orphan detection entirely.

    Plugin directories not in ``LOADED_PLUGINS`` appear in ``orphans``.
    Two sub-cases are distinguished:

    * **Stale/evicted copies**: same plugin id as a loaded plugin but a
      different on-disk path (e.g. an old user clone of a bundled plugin).
      These receive ``"evicted": True``. This also covers bundled plugin
      directories whose routes failed and whose server fell back to a
      user copy — the bundled dir is then the non-loaded directory and
      appears here too. Check the server startup log for the specific
      failure reason in that case.
    * **Failed-to-load orphans**: directories whose plugin id is not in
      ``LOADED_PLUGINS`` at all (requirements install failure, manifest
      error, etc.). These appear without ``"evicted"`` set.
    """
    loaded_ids: set[str] = set()
    # Map plugin_id → resolved directory path for the loaded copy,
    # used below to distinguish the canonical dir from stale clones.
    loaded_dir_by_id: dict[str, Path] = {}
    plugins_out: list[dict] = []
    for p in loaded_plugins:
        manifest = p.get("_manifest") or {}
        plugin_dir = p.get("_dir")
        entry = {
            "id": p.get("id"),
            "name": p.get("name"),
            "version": manifest.get("version"),
            "type": p.get("type"),
            "loaded": True,
            "has_screen": bool(p.get("has_screen")),
            "has_script": bool(p.get("has_script")),
            "has_settings": bool(p.get("has_settings")),
            "has_routes": bool(manifest.get("routes")),
            "diagnostics_declared": bool(
                p.get("_diagnostics_paths") or p.get("_diagnostics_callable") or p.get("_diagnostics_callable_spec")
            ),
            "dir": plugin_dir.name if isinstance(plugin_dir, Path) else None,
        }
        # Strip + drop blanks to match the loader/API normalization
        # (_normalize_string_list), so the bundle doesn't diverge from
        # /api/plugins for manifests with whitespace-padded standards tokens.
        standards = [s for item in manifest.get("standards", []) if isinstance(item, str) and (s := item.strip())]
        if standards:
            entry["standards"] = standards
        if "capabilities" in p:
            # Prefer the loader's validated capabilities. An empty dict here
            # means the manifest declarations were invalid and intentionally
            # dropped — falling back to the raw manifest would leak those
            # unvalidated declarations into the diagnostics bundle.
            if p["capabilities"]:
                entry["capabilities"] = p["capabilities"]
        elif isinstance(manifest.get("capabilities"), (dict, list)) and manifest.get("capabilities"):
            # No loader-validated value (e.g. a stub/legacy entry) — fall back
            # to the raw manifest capabilities.
            entry["capabilities"] = manifest.get("capabilities")
        if p.get("capability_validation_warnings"):
            entry["capability_validation_warnings"] = p.get("capability_validation_warnings")
        if p.get("capability_unsupported_versions"):
            entry["capability_unsupported_versions"] = p.get("capability_unsupported_versions")
        if p.get("compatibility_shims"):
            entry["compatibility_shims"] = p.get("compatibility_shims")
        if isinstance(manifest.get("settings_schema"), dict):
            entry["settings_schema"] = manifest.get("settings_schema")
        declared_ui = {
            **(manifest.get("ui_contributions") if isinstance(manifest.get("ui_contributions"), dict) else {}),
            **(manifest.get("ui") if isinstance(manifest.get("ui"), dict) else {}),
        }
        if declared_ui:
            entry["ui_contributions"] = declared_ui
        runtime_domains = {
            **(manifest.get("runtime_domains") if isinstance(manifest.get("runtime_domains"), dict) else {}),
            **(manifest.get("domains") if isinstance(manifest.get("domains"), dict) else {}),
        }
        if runtime_domains:
            entry["runtime_domains"] = dict(runtime_domains)
        if isinstance(plugin_dir, Path):
            git = _git_info(plugin_dir)
            if git is not None:
                entry["git"] = git
        plugins_out.append(entry)
        if entry["id"]:
            loaded_ids.add(entry["id"])
            if isinstance(plugin_dir, Path):
                loaded_dir_by_id[entry["id"]] = plugin_dir.resolve()

    # Walk plugin root directories to catch orphans (manifest exists but
    # plugin failed to load — common when requirements.txt installs
    # fail in a read-only container). Accepts a single Path, a list of
    # Paths (to cover both the built-in plugins/ dir and
    # FEEDBACK_PLUGINS_DIR), or None.
    orphans: list[dict] = []
    if plugins_root is not None:
        roots: list[Path] = plugins_root if isinstance(plugins_root, list) else [plugins_root]
        seen_orphan_dirs: set[Path] = set()  # deduplicate across roots
        for root in roots:
            if not isinstance(root, Path) or not root.is_dir():
                continue
            for child in sorted(root.iterdir()):
                if not child.is_dir() or child.name.startswith("."):
                    continue
                child_key = child.resolve()
                if child_key in seen_orphan_dirs:
                    continue
                seen_orphan_dirs.add(child_key)
                manifest_path = child / "plugin.json"
                if not manifest_path.exists():
                    continue
                try:
                    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
                except (OSError, json.JSONDecodeError):
                    manifest = {}
                pid = manifest.get("id") or child.name
                if pid in loaded_ids:
                    # Skip only if this IS the loaded plugin's directory.
                    # A different directory with the same id is a stale/evicted
                    # copy — still report it so the diagnostics bundle surfaces it.
                    loaded_dir = loaded_dir_by_id.get(pid)
                    if loaded_dir is not None and loaded_dir == child_key:
                        continue
                    # Falls through to report as an evicted orphan.
                orphan = {
                    "id": pid,
                    "name": manifest.get("name", pid),
                    "version": manifest.get("version"),
                    "type": manifest.get("type"),
                    "loaded": False,
                    "dir": child.name,
                    # Full resolved path for disambiguation: when the bundled
                    # and user-installed copies share the same directory name
                    # (e.g. both are named "highway_3d"), `dir` alone is
                    # ambiguous.  `path` lets maintainers identify which root
                    # the evicted copy came from without inspecting server logs.
                    # When redaction is active, the path passes through the
                    # text redactor so home-dir / config-dir prefixes are
                    # replaced with their placeholder tokens — preventing
                    # filesystem paths and usernames from leaking in a
                    # supposedly redacted bundle.
                    "path": redactor.redact_text(str(child_key)) if redactor is not None else str(child_key),
                }
                # Flag directories that share an id with a loaded plugin
                # (bundled-wins evicted them) vs. true orphans (failed to load).
                if pid in loaded_ids:
                    orphan["evicted"] = True
                git = _git_info(child)
                if git is not None:
                    orphan["git"] = git
                orphans.append(orphan)

    return {
        "schema": "system.plugins.v1",
        "plugins": plugins_out,
        "orphans": orphans,
    }


_PRETTY_LEVEL_PAD = 7  # widest level name "warning"
_PRETTY_NOISE_KEYS = {"timestamp", "level", "event", "logger", "logger_name"}


def _format_pretty_kv(key: str, value) -> str:
    if isinstance(value, str):
        # Quote when the string has whitespace or shell-meaningful chars,
        # so `event="some message"` stays one logical token.
        if any(c.isspace() or c in '"\\' for c in value):
            return f'{key}="{value}"'
        return f"{key}={value}"
    if isinstance(value, bool):
        return f"{key}={'true' if value else 'false'}"
    if value is None:
        return f"{key}=null"
    if isinstance(value, (int, float)):
        return f"{key}={value}"
    return f"{key}={json.dumps(value, default=str)}"


def _pretty_print_json_log(text: str) -> str | None:
    """Convert a structlog-JSON log tail into a one-line-per-event
    human-friendly format, or return None if the content doesn't look
    like JSON-per-line.

    Format: ``<timestamp> [<level>] <event>  key=value key=value``
    """
    sample = None
    for line in text.split("\n"):
        stripped = line.strip()
        if stripped:
            sample = stripped
            break
    if sample is None or not sample.startswith("{"):
        return None
    out_lines: list[str] = []
    json_lines = 0
    other_lines = 0
    for raw_line in text.split("\n"):
        line = raw_line.strip()
        if not line:
            out_lines.append("")
            continue
        if not line.startswith("{"):
            # Non-JSON line — emit verbatim. Mixed-format tails happen
            # when a config flip leaves both line shapes in the file.
            out_lines.append(line)
            other_lines += 1
            continue
        try:
            obj = json.loads(line)
        except json.JSONDecodeError:
            out_lines.append(line)
            other_lines += 1
            continue
        if not isinstance(obj, dict):
            out_lines.append(line)
            other_lines += 1
            continue
        json_lines += 1
        ts = obj.get("timestamp", "")
        level = str(obj.get("level", "info")).upper().ljust(_PRETTY_LEVEL_PAD)
        event = obj.get("event", "")
        extras = []
        for key, val in obj.items():
            if key in _PRETTY_NOISE_KEYS:
                continue
            extras.append(_format_pretty_kv(key, val))
        suffix = ("  " + " ".join(extras)) if extras else ""
        out_lines.append(f"{ts} [{level.strip()}] {event}{suffix}")
    if json_lines == 0:
        # All lines were non-JSON — original was already pretty.
        return None
    return "\n".join(out_lines)


def _read_log_tail(log_file: Path, max_bytes: int) -> tuple[bytes, dict]:
    """Return (tail_bytes, meta). Meta is always populated."""
    meta = {
        "schema": "logs.server.v1",
        "log_file": str(log_file),
        "exists": False,
        "size_bytes": 0,
        "tail_bytes": 0,
        "truncated": False,
    }
    if not log_file.exists() or not log_file.is_file():
        return b"", meta
    meta["exists"] = True
    try:
        size = log_file.stat().st_size
    except OSError:
        return b"", meta
    meta["size_bytes"] = size
    try:
        with log_file.open("rb") as f:
            if size > max_bytes:
                f.seek(-max_bytes, io.SEEK_END)
                meta["truncated"] = True
                # Discard partial first line so log parsers don't choke.
                f.readline()
            data = f.read()
    except OSError as e:
        meta["error"] = str(e)
        return b"", meta
    meta["tail_bytes"] = len(data)
    return data, meta


def _resolve_plugin_callable(
    plugin: dict, log: logging.Logger, notes: list | None = None,
):
    """Return the plugin's diagnostics callable (or None).

    Two cases:
      1. Tests / direct callers can pre-attach `_diagnostics_callable`
         (a Python callable) on the plugin dict — used in unit tests.
      2. Real plugin loader records `_diagnostics_callable_spec`
         (`<module>:<function>`) + `_load_sibling` (closure). Resolve
         lazily so a missing/broken sibling at load time doesn't fail
         registration — only export.

    Resolution failures (missing module, non-callable symbol) are both
    logged and appended to *notes* so the bundle consumer can see the
    problem without unpacking server logs.
    """
    direct = plugin.get("_diagnostics_callable")
    if direct is not None and callable(direct):
        return direct
    spec = plugin.get("_diagnostics_callable_spec")
    if not spec:
        return None
    load_sibling = plugin.get("_load_sibling")
    if load_sibling is None:
        return None
    module_name, _, fn_name = spec.partition(":")
    try:
        mod = load_sibling(module_name)
    except Exception as e:
        msg = (
            f"plugin {plugin.get('id')} diagnostics callable {spec!r}: "
            f"load_sibling failed: {e}"
        )
        log.warning("%s", msg)
        if notes is not None:
            notes.append(msg)
        return None
    fn = getattr(mod, fn_name, None)
    if fn is None or not callable(fn):
        msg = (
            f"plugin {plugin.get('id')} diagnostics callable {spec!r}: "
            f"{module_name}.{fn_name} not found or not callable"
        )
        log.warning("%s", msg)
        if notes is not None:
            notes.append(msg)
        return None
    return fn


def _plugin_diagnostic_files(
    plugin: dict, config_dir: Path, log: logging.Logger,
    notes: list | None = None,
) -> dict[str, bytes]:
    """Collect diagnostics-opted-in files + invoke the plugin's
    diagnostics callable if present. Returns `{relpath: bytes}` keyed
    under `plugins/<plugin_id>/`.

    Callable failures are caught and appended to *notes* (when provided)
    so the bundle consumer can see "plugin X diagnostics callable raised"
    without crashing the export.
    """
    plugin_id = plugin["id"]
    # Sanitize plugin_id for use as a ZIP path segment so that a loaded
    # plugin whose id contains slashes cannot create entries outside
    # plugins/<id>/ (e.g. "com.foo/../../bar" → "com.foo_sl__sl_..bar").
    safe_id = _safe_zip_segment(plugin_id)
    out: dict[str, bytes] = {}
    paths = plugin.get("_diagnostics_paths") or []
    for rel in paths:
        if rel.endswith("/"):
            # Directory entry — use os.walk(followlinks=False) so we never
            # follow symlinked subdirectories, matching _walk_export_paths.
            abs_dir = config_dir / rel.rstrip("/")
            if abs_dir.is_symlink():
                continue  # skip symlinked directory entries
            if not abs_dir.is_dir():
                continue
            collected: list[Path] = []
            for dirpath, dirnames, filenames in os.walk(str(abs_dir), followlinks=False):
                # Strip symlinked subdirs in-place so the walker neither
                # yields their names nor descends into them.
                dirnames[:] = [
                    d for d in dirnames
                    if not os.path.islink(os.path.join(dirpath, d))
                ]
                for fname in filenames:
                    full = os.path.join(dirpath, fname)
                    if os.path.islink(full) or not os.path.isfile(full):
                        continue
                    collected.append(Path(full))
            for child in sorted(collected):
                try:
                    file_rel_path = child.relative_to(config_dir)
                    out[f"plugins/{safe_id}/{file_rel_path.as_posix()}"] = child.read_bytes()
                except (OSError, ValueError) as e:
                    log.warning(
                        "plugin %s diagnostics dir file %s read failed: %s",
                        plugin_id, child, e,
                    )
        else:
            # File entry — check that no component of the path is a symlink
            # (matches the semantics of _walk_export_paths + the import safety
            # check), then read the file directly without resolving symlinks.
            rel_clean = rel.lstrip("/")
            probe = config_dir
            skip = False
            for part in rel_clean.split("/"):
                if not part:
                    continue
                probe = probe / part
                if probe.is_symlink():
                    skip = True
                    break
            if skip:
                continue
            target = config_dir / rel_clean
            if not target.exists() or not target.is_file():
                continue
            try:
                # rel_clean comes from the JSON manifest and already uses
                # forward slashes, so no as_posix() conversion is needed
                # (unlike directory entries which come from Path.relative_to).
                out[f"plugins/{safe_id}/{rel_clean}"] = target.read_bytes()
            except OSError as e:
                log.warning("plugin %s diagnostics file %s read failed: %s", plugin_id, rel, e)

    callable_fn = _resolve_plugin_callable(plugin, log, notes=notes)
    if callable_fn is not None:
        ctx = {"plugin_id": plugin_id, "config_dir": config_dir}
        result, exc = _run_callable_with_daemon_thread(callable_fn, ctx, CALLABLE_TIMEOUT_S)
        if isinstance(exc, TimeoutError):
            log.warning(
                "plugin %s diagnostics callable timed out after %ss",
                plugin_id, CALLABLE_TIMEOUT_S,
            )
            if notes is not None:
                notes.append(
                    f"plugin {plugin_id} diagnostics callable timed out "
                    f"after {CALLABLE_TIMEOUT_S}s"
                )
            return out
        elif exc is not None:
            log.warning("plugin %s diagnostics callable raised: %s", plugin_id, exc)
            if notes is not None:
                notes.append(
                    f"plugin {plugin_id} diagnostics callable raised: {exc}"
                )
            return out
        if isinstance(result, (dict, list)):
            out[f"plugins/{safe_id}/callable.json"] = _safe_json_dumps(result).encode("utf-8")
        elif isinstance(result, (bytes, bytearray)):
            out[f"plugins/{safe_id}/callable.bin"] = bytes(result)
        elif isinstance(result, str):
            out[f"plugins/{safe_id}/callable.txt"] = result.encode("utf-8")
        else:
            log.warning(
                "plugin %s diagnostics callable returned unsupported type %s",
                plugin_id, type(result).__name__,
            )
    return out


def _redact_value(value: object, redactor: "Redactor") -> object:
    """Recursively redact string leaf values using *redactor*.

    Used to sanitise arbitrary JSON-serialisable payloads (client
    contributions, localStorage values) that may contain DLC paths,
    song names, or URLs with secret query params.
    """
    if isinstance(value, str):
        return redactor.redact_text(value)
    if isinstance(value, dict):
        return {k: _redact_value(v, redactor) for k, v in value.items()}
    if isinstance(value, list):
        return [_redact_value(v, redactor) for v in value]
    return value


README_TEMPLATE = """\
FeedBack Diagnostics Bundle
============================

Generated: {exported_at}
FeedBack: {feedBack_version}
Runtime:   {runtime_kind}
Redacted:  {redacted}

This bundle was produced by Settings -> Export Diagnostics. Attach it to
GitHub issues, share with maintainers, or feed it to an AI agent.

# Layout

  manifest.json          Top-level index. Every file listed with its schema id.
  system/                Backend view: version, env, hardware, plugins
  logs/                  Server logs (tail of LOG_FILE if set)
  client/                Browser view: console transcript, hardware, ua, localStorage
  plugins/<id>/          Per-plugin contributed diagnostics (if any)

# AGENT NOTES

Read manifest.json first. Each file under `system/` and `client/` carries
an explicit `schema` field (e.g. `system.hardware.v1`). Dispatch on schema.

Symptom -> file map (start here):

  audio not playing            -> system/plugins.json (stems plugin?), logs/server.log (grep ffmpeg, vgmstream)
  3D highway slow / black      -> client/hardware.json (webgl.renderer, webgpu.adapter_info)
  plugin error on load         -> logs/server.log (grep "Plugin"), system/plugins.json
  websocket disconnects        -> client/console.json (kind=error level=warn)
  "works on my machine"        -> compare system/version.json + system/env.json across bundles
  song-specific bug            -> logs/server.log (look for <song:HASH> tokens; they are stable across the bundle)

Redaction:
  - Paths replaced with <DLC_DIR>, <HOME>, <CONFIG_DIR>
  - Song filenames replaced with <song:HASH8> (stable per-bundle)
  - IPs replaced with <ip:HASH6> (stable per-bundle)
  - Bearer tokens / api_key= / token= replaced with <redacted>
"""


def _client_section(
    client_console: list | None,
    client_hardware: dict | None,
    client_ua: dict | None,
    local_storage: dict | None,
    redactor: Redactor | None,
) -> dict[str, bytes]:
    out: dict[str, bytes] = {}
    if client_console is not None:
        if redactor is not None:
            for entry in client_console:
                if isinstance(entry, dict):
                    if isinstance(entry.get("msg"), str):
                        entry["msg"] = redactor.redact_text(entry["msg"])
                    if isinstance(entry.get("stack"), str):
                        entry["stack"] = redactor.redact_text(entry["stack"])
                    # window.onerror entries include a `url` field that can
                    # contain raw file:// / Electron paths or query-string
                    # secrets.  Redact alongside msg/stack.
                    if isinstance(entry.get("url"), str):
                        entry["url"] = redactor.redact_text(entry["url"])
                    # Redact secondary console arguments (string values and
                    # Error objects stored as {name, message, stack}).
                    args = entry.get("args")
                    if isinstance(args, list):
                        redacted_args = []
                        for a in args:
                            if isinstance(a, str):
                                redacted_args.append(redactor.redact_text(a))
                            elif isinstance(a, dict):
                                # diagnostics.js serialises Error objects as
                                # {name, message, stack} — redact string values.
                                redacted_args.append({
                                    k: redactor.redact_text(v) if isinstance(v, str) else v
                                    for k, v in a.items()
                                })
                            else:
                                redacted_args.append(a)
                        entry["args"] = redacted_args
        out["client/console.json"] = _safe_json_dumps({
            "schema": "client.console.v1",
            "entries": client_console,
        }).encode("utf-8")
    if client_hardware is not None:
        # Enforce the schema field server-side so manifest.files can always
        # advertise "client.hardware.v1" regardless of whether the browser
        # payload included it.
        # The browser always sends a dict, but the defensive non-dict branch
        # wraps unexpected payloads in {"data": ...} to produce valid JSON
        # rather than crashing — browser input is untrusted.
        hw_data: dict[str, object] = dict(client_hardware) if isinstance(client_hardware, dict) else {"data": client_hardware}
        hw_data.setdefault("schema", "client.hardware.v1")
        out["client/hardware.json"] = _safe_json_dumps(hw_data).encode("utf-8")
    if client_ua is not None:
        ua_data = dict(client_ua)
        if redactor is not None and isinstance(ua_data.get("url"), str):
            ua_data["url"] = redactor.redact_text(ua_data["url"])
        out["client/ua.json"] = _safe_json_dumps({
            "schema": "client.ua.v1",
            **ua_data,
        }).encode("utf-8")
    if local_storage is not None:
        # Redact string values that could contain paths, URLs, or tokens
        # when redaction is active (the JS side already strips secret-named
        # keys; here we pass remaining values through the text redactor so
        # DLC paths and song names embedded in storage strings are removed).
        if redactor is not None and isinstance(local_storage, dict):
            local_storage = {
                k: redactor.redact_text(v) if isinstance(v, str) else v
                for k, v in local_storage.items()
            }
        out["client/local_storage.json"] = _safe_json_dumps({
            "schema": "client.local_storage.v1",
            "data": local_storage,
        }).encode("utf-8")
    return out


def _build_files_meta(files: dict[str, bytes]) -> list[dict]:
    """Convert assembled file bytes into manifest entry dicts.

    Each entry carries a small `summary` dict that the preview UI can
    render inline ("32 plugins loaded · 0 orphans") so users don't have
    to unzip the bundle to know what they're sending.
    """
    entries: list[dict] = []
    for path, payload in sorted(files.items()):
        entry: dict = {
            "path": path,
            "size": len(payload),
        }
        if path.endswith(".json"):
            entry["kind"] = "json"
            try:
                parsed = json.loads(payload.decode("utf-8"))
                if isinstance(parsed, dict) and isinstance(parsed.get("schema"), str):
                    entry["schema"] = parsed["schema"]
                elif path.startswith("plugins/"):
                    # Assign a fallback schema for plugin files that don't
                    # self-declare one, so AI consumers can dispatch by path.
                    parts = path.split("/")
                    filename = parts[-1]
                    if filename == "callable.json":
                        entry["schema"] = "plugin.callable_output.v1"
                    elif filename == "client.json":
                        entry["schema"] = "plugin.client_contribution.v1"
                    else:
                        entry["schema"] = "plugin.server_file.v1"
                summary = _summarize_payload(path, parsed)
                if summary:
                    entry["summary"] = summary
            except (UnicodeDecodeError, json.JSONDecodeError):
                pass
        elif path.endswith(".log"):
            entry["kind"] = "text"
            entry["lines"] = payload.count(b"\n")
        else:
            entry["kind"] = "binary"
        entries.append(entry)
    return entries


def _assemble_files_and_notes(
    *,
    feedBack_version: str,
    config_dir: Path,
    dlc_dir: Path | None,
    log_file: Path | None,
    loaded_plugins: list[dict],
    include: dict,
    redact: bool,
    client_console: list | None,
    client_hardware: dict | None,
    client_ua: dict | None,
    local_storage: dict | None,
    client_contributions: dict | None,
    log: logging.Logger,
    plugins_root: "Path | list[Path] | None" = None,
) -> tuple[dict[str, bytes], list[str], str, "Redactor | None"]:
    """Assemble all diagnostic file bytes without packaging into a zip.

    Returns ``(files, notes, runtime_kind, redactor)``.  Callers are
    responsible for building the zip (``build_bundle``) or just the
    manifest metadata (``preview_bundle``).
    """
    home_dir = Path.home() if Path.home() else None
    redactor = Redactor(dlc_dir=dlc_dir, home_dir=home_dir, config_dir=config_dir) if redact else None
    # Always detect the runtime kind — even when the hardware section is
    # excluded. The cheap env-var + cgroup check is free; the full probe
    # (nvidia-smi, psutil) only runs when include.hardware is True.
    runtime_kind = detect_runtime()["kind"]
    notes: list[str] = []
    files: dict[str, bytes] = {}

    if include.get("system", True):
        # Pass the redactor so python.executable is redacted when paths
        # should be hidden (it often lives under $HOME or a per-user venv).
        ver_payload = _safe_json_dumps(_system_version(feedBack_version, redactor=redactor)).encode("utf-8")
        files["system/version.json"] = ver_payload
        env_payload = _safe_json_dumps(_system_env(redactor=redactor)).encode("utf-8")
        files["system/env.json"] = env_payload
        plugins_data = _system_plugins(loaded_plugins, plugins_root=plugins_root, redactor=redactor)
        files["system/plugins.json"] = _safe_json_dumps(plugins_data).encode("utf-8")
        # Plugin loading is async and takes a few seconds on cold
        # boot. If the bundle was captured during that window, every
        # plugin appears as an "orphan" — flag the likely race so the
        # bundle reader (or AI agent) doesn't conclude the install is
        # broken.
        if (
            len(plugins_data.get("plugins", [])) == 0
            and len(plugins_data.get("orphans", [])) > 0
        ):
            notes.append(
                "system/plugins.json shows 0 loaded plugins but "
                f"{len(plugins_data['orphans'])} on disk — likely a startup "
                "race (plugin loading is async). Re-export after waiting ~10s "
                "for an accurate inventory."
            )

    if include.get("hardware", True):
        hw = collect_hardware()
        # Full probe is more accurate — update runtime_kind with the
        # richer result (psutil parent-process check for Electron, etc.).
        runtime_kind = (hw.get("runtime") or {}).get("kind", runtime_kind)
        files["system/hardware.json"] = _safe_json_dumps(hw).encode("utf-8")
        if (hw.get("runtime") or {}).get("in_docker"):
            notes.append(
                "container masks host CPU/RAM in system/hardware.json — "
                "real host info lives in client/hardware.json"
            )

    if include.get("logs", True) and log_file is not None:
        raw, meta = _read_log_tail(log_file, LOG_TAIL_BYTES)
        if raw:
            text = raw.decode("utf-8", errors="replace")
            if redactor is not None:
                text = redactor.redact_text(text)
            files["logs/server.log"] = text.encode("utf-8")
            # When LOG_FORMAT=json, the file is one JSON-per-line —
            # great for agents, awful for humans. Emit a pretty-printed
            # companion so a maintainer can scan it without piping
            # through jq. Detection is content-based (first non-empty
            # line starts with `{`) rather than env-based: a log file
            # captured under a previous LOG_FORMAT setting still gets
            # the right treatment.
            pretty = _pretty_print_json_log(text)
            if pretty is not None:
                files["logs/server.pretty.log"] = pretty.encode("utf-8")
                meta["pretty_companion"] = True
        # Redact the log_file path in meta so an absolute filesystem path
        # (which may live under HOME or CONFIG_DIR) isn't leaked even in a
        # redacted bundle.
        if redactor is not None and isinstance(meta.get("log_file"), str):
            meta["log_file"] = redactor.redact_text(meta["log_file"])
        files["logs/server.log.meta.json"] = _safe_json_dumps(meta).encode("utf-8")
        if not meta["exists"]:
            # Use the already-redacted path from meta (if redaction is on) so
            # the note doesn't re-leak the raw filesystem path.
            display_path = meta.get("log_file") or str(log_file)
            notes.append(
                f"LOG_FILE is set ({display_path}) but the file does not exist yet"
            )
    elif include.get("logs", True):
        notes.append("LOG_FILE not set — server.log section omitted")

    # Client section is per-file. Console + hardware respect the
    # corresponding include flags (so an unchecked toggle drops the
    # snapshot even if the browser sent it). UA + localStorage are
    # always written when present — they're tiny and useful for any
    # report.
    files.update(_client_section(
        client_console=client_console if include.get("console", True) else None,
        client_hardware=client_hardware if include.get("hardware", True) else None,
        client_ua=client_ua,
        local_storage=local_storage,
        redactor=redactor,
    ))

    if include.get("plugins", True):
        for p in loaded_plugins:
            plugin_files = _plugin_diagnostic_files(p, config_dir, log, notes=notes)
            files.update(plugin_files)

    # Per-plugin client-side contributions from
    # window.feedBack.diagnostics.contribute(plugin_id, payload).
    # Gated on the same "plugins" toggle as backend plugin diagnostics.
    if include.get("plugins", True) and client_contributions and isinstance(client_contributions, dict):
        # Build the set of actually-loaded plugin IDs so we only accept
        # contributions from known plugins.  This prevents a crafted
        # plugin_id value (e.g. "../logs" or "../../manifest.json") in the
        # POST body from creating path-traversal entries in the ZIP archive.
        loaded_plugin_ids = {p["id"] for p in loaded_plugins}
        for plugin_id, payload in client_contributions.items():
            if not isinstance(plugin_id, str) or not plugin_id:
                continue
            if plugin_id not in loaded_plugin_ids:
                log.warning(
                    "client_contributions: unknown plugin_id %r — skipping",
                    plugin_id,
                )
                continue
            # Redact the contribution payload when redaction is active:
            # recursively sanitize string leaf values so plugins that
            # include DLC paths, song names, or API URLs don't bypass the
            # main redaction pass.
            if redactor is not None:
                payload = _redact_value(payload, redactor)
            safe_id = _safe_zip_segment(plugin_id)
            files[f"plugins/{safe_id}/client.json"] = _safe_json_dumps({
                "schema": "plugin.client_contribution.v1",
                "plugin_id": plugin_id,
                "data": payload,
            }).encode("utf-8")

    return files, notes, runtime_kind, redactor


def _make_manifest(
    *,
    feedBack_version: str,
    runtime_kind: str,
    redact: bool,
    files: dict[str, bytes],
    notes: list[str],
    redactor: "Redactor | None",
) -> dict:
    return {
        "schema": BUNDLE_SCHEMA,
        "exported_at": _now_iso(),
        "feedBack_version": feedBack_version,
        "runtime": runtime_kind,
        "redacted": redact,
        "files": _build_files_meta(files),
        "redactions": dict(redactor.counts) if redactor is not None else {},
        "notes": notes,
    }


def build_bundle(
    *,
    feedBack_version: str,
    config_dir: Path,
    dlc_dir: Path | None,
    log_file: Path | None,
    loaded_plugins: list[dict],
    include: dict,
    redact: bool,
    client_console: list | None,
    client_hardware: dict | None,
    client_ua: dict | None,
    local_storage: dict | None,
    client_contributions: dict | None = None,
    log: logging.Logger,
    plugins_root: "Path | list[Path] | None" = None,
) -> tuple[bytes, str, dict]:
    """Returns (zip_bytes, filename, manifest_dict)."""
    files, notes, runtime_kind, redactor = _assemble_files_and_notes(
        feedBack_version=feedBack_version,
        config_dir=config_dir,
        dlc_dir=dlc_dir,
        log_file=log_file,
        loaded_plugins=loaded_plugins,
        include=include,
        redact=redact,
        client_console=client_console,
        client_hardware=client_hardware,
        client_ua=client_ua,
        local_storage=local_storage,
        client_contributions=client_contributions,
        log=log,
        plugins_root=plugins_root,
    )

    manifest = _make_manifest(
        feedBack_version=feedBack_version,
        runtime_kind=runtime_kind,
        redact=redact,
        files=files,
        notes=notes,
        redactor=redactor,
    )

    readme = README_TEMPLATE.format(
        exported_at=manifest["exported_at"],
        feedBack_version=feedBack_version,
        runtime_kind=runtime_kind,
        redacted=redact,
    )

    # Index manifest.json and README.txt in manifest["files"] so the
    # documented contract holds: every file in the bundle is listed.
    # We compute the manifest.json size from a first-pass serialisation
    # (before these two entries are added), which is a slight undercount
    # but acceptable for a diagnostics bundle.
    readme_bytes = readme.encode("utf-8")
    manifest_json_first_pass = _safe_json_dumps(manifest).encode("utf-8")
    manifest["files"].extend([
        {
            "path": "manifest.json",
            "size": len(manifest_json_first_pass),
            "kind": "json",
            "schema": BUNDLE_SCHEMA,
        },
        {
            "path": "README.txt",
            "size": len(readme_bytes),
            "kind": "text",
            "lines": readme_bytes.count(b"\n"),
        },
    ])

    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
        zf.writestr("manifest.json", _safe_json_dumps(manifest))
        zf.writestr("README.txt", readme)
        for path, payload in sorted(files.items()):
            zf.writestr(path, payload)

    filename = f"feedBack-diag-{feedBack_version}-{_now_filename_slug()}.zip"
    return buf.getvalue(), filename, manifest


def preview_bundle(
    *,
    feedBack_version: str,
    config_dir: Path,
    dlc_dir: Path | None,
    log_file: Path | None,
    loaded_plugins: list[dict],
    include: dict,
    redact: bool,
    log: logging.Logger,
    plugins_root: "Path | list[Path] | None" = None,
) -> dict:
    """Lightweight preview: returns manifest-shaped output without
    building the zip or executing plugin diagnostics callables.

    Plugin callables are stripped before file assembly so that
    side-effectful operations never run twice (once for preview, once
    for the real export). To keep the preview accurate, synthetic
    placeholder entries are injected for:

    - Each plugin that declares a callable (the real export *will*
      include ``plugins/<id>/callable.*`` — exact size is unknown
      until the callable runs).
    - The browser-supplied client sections (``client/ua.json``,
      ``client/local_storage.json``, etc.) that are always present
      in a real export but aren't available on the server during a
      GET preview request.

    Placeholder entries carry ``"preview_placeholder": true`` in their
    JSON payload so consumers can distinguish them from real content.
    """
    # Strip both callable paths so real plugins don't execute during
    # preview. _diagnostics_callable_spec + _load_sibling is how real
    # plugins register, so nulling only _diagnostics_callable would leave
    # spec-based callables still reachable via _resolve_plugin_callable.
    preview_plugins = [
        {**p, "_diagnostics_callable": None, "_diagnostics_callable_spec": None}
        for p in loaded_plugins
    ]
    files, notes, runtime_kind, redactor = _assemble_files_and_notes(
        feedBack_version=feedBack_version,
        config_dir=config_dir,
        dlc_dir=dlc_dir,
        log_file=log_file,
        loaded_plugins=preview_plugins,
        include=include,
        redact=redact,
        client_console=None,
        client_hardware=None,
        client_ua=None,
        local_storage=None,
        client_contributions=None,
        log=log,
        plugins_root=plugins_root,
    )

    # ── Callable-output placeholders ──────────────────────────────────────
    # Plugins with a diagnostics callable will produce exactly ONE of
    # callable.json / callable.bin / callable.txt in the real export,
    # depending on whether the callable returns a dict/list, bytes, or str.
    # Inject a single callable.json placeholder (the most common case) so
    # the preview file tree shows the file will be present without misleading
    # the UI into advertising all three possible extensions simultaneously.
    if include.get("plugins", True):
        for p in loaded_plugins:
            has_direct = callable(p.get("_diagnostics_callable"))
            has_spec = bool(p.get("_diagnostics_callable_spec"))
            if has_direct or has_spec:
                pid = p["id"]
                key = f"plugins/{_safe_zip_segment(pid)}/callable.json"
                if key not in files:
                    files[key] = _CALLABLE_PREVIEW_PLACEHOLDER
            # Frontend plugins (those with a screen or script) may call
            # window.feedBack.diagnostics.contribute() and produce a
            # plugins/<id>/client.json in the real export. Advertise a
            # placeholder so the preview file tree is accurate.
            if p.get("has_screen") or p.get("has_script"):
                pid = p["id"]
                client_key = f"plugins/{_safe_zip_segment(pid)}/client.json"
                if client_key not in files:
                    files[client_key] = _safe_json_dumps({
                        "preview_placeholder": True,
                        "schema": "plugin.client_contribution.v1",
                        "note": "browser-supplied at export time via diagnostics.contribute()",
                    }).encode("utf-8")

    # ── Browser-section placeholders ─────────────────────────────────────
    # The preview is a GET request — the server doesn't have the browser
    # console, UA, or localStorage at preview time. Inject lightweight
    # placeholders so the manifest file tree reflects what a real export
    # will contain, rather than silently omitting these sections.
    # Map path → schema so each placeholder carries the correct schema id.
    _CLIENT_PATH_SCHEMAS = {
        "client/console.json": "client.console.v1",
        "client/hardware.json": "client.hardware.v1",
        "client/ua.json": "client.ua.v1",
        "client/local_storage.json": "client.local_storage.v1",
    }
    _placeholder_paths: list[str] = []
    if include.get("console", True):
        _placeholder_paths.append("client/console.json")
    if include.get("hardware", True):
        _placeholder_paths.append("client/hardware.json")
    # UA and localStorage are always included when present (not gated on toggles).
    _placeholder_paths += ["client/ua.json", "client/local_storage.json"]
    for _path in _placeholder_paths:
        if _path not in files:
            files[_path] = _safe_json_dumps({
                "preview_placeholder": True,
                "schema": _CLIENT_PATH_SCHEMAS[_path],
                "note": "browser-supplied at export time",
            }).encode("utf-8")

    manifest = _make_manifest(
        feedBack_version=feedBack_version,
        runtime_kind=runtime_kind,
        redact=redact,
        files=files,
        notes=notes,
        redactor=redactor,
    )
    filename = f"feedBack-diag-{feedBack_version}-{_now_filename_slug()}.zip"
    return {
        "filename": filename,
        "manifest": manifest,
    }
