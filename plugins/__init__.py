"""Plugin discovery and loading system."""

import hashlib
import importlib.util
import json
import logging
import mimetypes
import os
import re
import subprocess
import sys
import threading
from pathlib import Path
from fastapi import FastAPI, Request
from fastapi.responses import FileResponse, HTMLResponse, JSONResponse, Response

from safepath import safe_join

log = logging.getLogger("feedBack.plugins")


def _plugin_media_type(path: Path) -> str:
    """Best-effort Content-Type for a served plugin file. `.js`/`.css` must come
    back as JavaScript/CSS so `<script type=module>` / `addModule()` / a `<link>`
    accept them; `mimetypes.guess_type` can miss these on a stripped platform
    registry, so fall back explicitly (mirrors the assets/ route)."""
    media_type = mimetypes.guess_type(path.name)[0]
    if media_type is None and path.suffix == ".js":
        return "application/javascript"
    if media_type is None and path.suffix == ".css":
        return "text/css"
    return media_type or "application/octet-stream"


def _plugin_file_etag(path: Path) -> str | None:
    """Weak ETag from mtime+size — cheap, stable across reads, changes on edit.
    This is what makes the live-edit loop work for module graphs: a conditional
    GET revalidates and 304s unchanged files on refresh instead of re-downloading
    the whole `src/` tree. Returns None if the file can't be stat'd."""
    try:
        st = path.stat()
    except OSError:
        return None
    return f'W/"{st.st_mtime_ns:x}-{st.st_size:x}"'


def _if_none_match(request: Request, etag: str) -> bool:
    """True when the client's If-None-Match already holds `etag`."""
    # ponytail: we serve one weak ETag; the browser echoes it back verbatim, so
    # a direct compare is enough (comma-split tolerates a proxy concatenation).
    return etag in [t.strip() for t in request.headers.get("if-none-match", "").split(",")]


def _plugin_file_response(request: Request, path: Path, media_type: str) -> Response:
    """Serve a plugin source/asset file with the live-edit cache contract:
    `Cache-Control: no-cache` (browser may store but MUST revalidate) + a weak
    ETag, and a bodyless 304 when the client's If-None-Match already matches.
    Starlette's `FileResponse` emits an ETag but never evaluates If-None-Match
    itself, so the conditional handling has to live here."""
    headers = {"Cache-Control": "no-cache"}
    etag = _plugin_file_etag(path)
    if etag:
        headers["ETag"] = etag
        if _if_none_match(request, etag):
            return Response(status_code=304, headers=headers)
    # FileResponse sets etag/last-modified via setdefault, so the ETag above wins.
    return FileResponse(path, media_type=media_type, headers=headers)


PLUGINS_DIR = Path(__file__).parent
# Holds only *ready* (loaded) plugins — those whose dependencies installed
# and whose routes registered. A plugin GRADUATES from PENDING_PLUGINS into
# this list when it becomes ready. Kept ready-only because every consumer
# that imports LOADED_PLUGINS (settings export/import, diagnostics, the
# orphan-detection in lib/diagnostics_bundle.py) wants only usable plugins.
LOADED_PLUGINS = []
# Every discovered plugin that is NOT yet ready, keyed by plugin_id and held
# in discovery order. Each value is a lightweight, manifest-derived nav entry
# (no routes, no callables) carrying a `status` of "installing" or "failed"
# (plus `error` text when failed) so /api/plugins can render the nav slot
# immediately — disabled "installing…" / "failed" — while the background
# loader works through installs sequentially. A plugin leaves PENDING_PLUGINS
# only by GRADUATING into LOADED_PLUGINS (ready); a failed plugin stays here
# so it remains a visible, disabled nav entry until the next restart retries it.
PENDING_PLUGINS: dict = {}
# Guards all mutations of and snapshots from LOADED_PLUGINS and
# PENDING_PLUGINS so the background plugin-loader thread and the event-loop
# request handlers never race on either structure.
PLUGINS_LOCK = threading.RLock()
# Monotonic load-generation counter, bumped under PLUGINS_LOCK at the start of
# every load_plugins() pass. Each pass captures its generation and every
# registry mutation (the pending seed, _graduate, _mark_failed) re-checks it
# under the lock before touching LOADED_PLUGINS / PENDING_PLUGINS. This keeps a
# still-running loader from an EARLIER pass — e.g. a "reload plugins" action,
# FEEDBACK_SYNC_STARTUP hot-reload, or test teardown re-invoking load_plugins()
# while the first pass's background install thread is mid-flight — from
# repopulating or duplicating entries after a NEWER pass has already cleared the
# registries. Only the latest pass is allowed to publish.
_LOAD_GENERATION = 0

# Persistent pip install location (survives container restarts)
_PIP_TARGET = Path(os.environ.get("CONFIG_DIR", "/config")) / "pip_packages"

# --- Plugin enable/disable persistence (v3 Pedalboard footswitch) ---------
# Disabled plugins are persisted under CONFIG_DIR so the choice survives
# restarts; the loader skips them at startup (no routes/screen/nav/caps) while
# still surfacing them in /api/plugins as an "off" pedal you can switch back on.
# Guards the small JSON state file against the loader thread and request
# handlers racing on read/modify/write.
_PLUGIN_STATE_LOCK = threading.Lock()
# Plugins that may never be disabled — disabling them would brick the app or the
# capability-graph review surface. capability_inspector is the support surface
# for the capability pipelines; app_tour_* drive the first-run onboarding.
_ALWAYS_ENABLED_EXACT = frozenset({"capability_inspector"})


def _is_always_enabled(plugin_id: str) -> bool:
    """A small always-on set that cannot be disabled via the toggle endpoint."""
    return plugin_id in _ALWAYS_ENABLED_EXACT or plugin_id.startswith("app_tour_")


def _suppress_capabilities_for_disabled(row: dict) -> dict:
    """A disabled plugin contributes NOTHING to the capability pipeline.

    The frontend `static/capabilities.js` `registerParticipants()` registers any
    /api/plugins entry that carries a `capabilities` declaration regardless of
    status, so the backend empties the capability-pipelines.v1 fields here for
    any plugin that is not actively contributing. That is:
      * `enabled` is False (runtime-toggled-off, still in LOADED_PLUGINS), or
      * status is "disabled" — a startup-skipped plugin that is NOT mounted.
        Re-enabling such a plugin flips its `enabled` flag to True immediately
        (to reflect intent) but it only actually mounts on the next restart, so
        its handlers don't exist yet — surfacing its capabilities would register
        a phantom pipeline participant. Keep them suppressed until it graduates.
    Mutates and returns the row in place.
    """
    if row.get("enabled", True) and row.get("status") != "disabled":
        return row
    row["capabilities"] = {}
    row["standards"] = []
    row["capability_validation_warnings"] = []
    row["capability_unsupported_versions"] = []
    row["compatibility_shims"] = []
    return row


def _plugin_state_path() -> Path:
    """Location of the persisted enable/disable state. Resolved at call time (not
    import time) so CONFIG_DIR can be overridden per-process (and per test)."""
    return Path(os.environ.get("CONFIG_DIR", "/config")) / "plugin_state.json"


def _load_plugin_state() -> dict:
    """Read CONFIG_DIR/plugin_state.json → ``{"<id>": {"enabled": false}, ...}``.

    Tolerant by construction: a missing file, unreadable file, malformed JSON,
    or a non-object top level all fall back to ``{}`` with a warning. This MUST
    never raise — it runs on the startup path and a corrupt state file must not
    brick plugin loading (ADR: disabled is opt-in; absence means enabled).
    """
    path = _plugin_state_path()
    with _PLUGIN_STATE_LOCK:
        try:
            raw = path.read_text(encoding="utf-8")
        except FileNotFoundError:
            return {}
        except UnicodeDecodeError as e:
            # Non-UTF-8 bytes (encoding-corrupt file). Not an OSError, so it
            # would otherwise escape — treat as corrupt and fall back to {}.
            log.warning("Ignoring corrupt (non-UTF-8) plugin state %s: %s", path, e)
            return {}
        except OSError as e:
            log.warning("Could not read plugin state %s: %s", path, e)
            return {}
        try:
            data = json.loads(raw)
        except json.JSONDecodeError as e:
            log.warning("Ignoring corrupt plugin state %s: %s", path, e)
            return {}
    if not isinstance(data, dict):
        log.warning("Ignoring plugin state %s: expected an object, got %s", path, type(data).__name__)
        return {}
    return data


def _is_plugin_enabled(state: dict, plugin_id: str) -> bool:
    """Resolve a plugin's enabled flag from loaded state. Absent → enabled
    (default true); a malformed per-plugin entry is treated as enabled too.
    Always-on plugins are enabled regardless of what the file says."""
    if _is_always_enabled(plugin_id):
        return True
    entry = state.get(plugin_id)
    if not isinstance(entry, dict):
        return True
    value = entry.get("enabled")
    # Only a real boolean is authoritative — anything else (missing, or junk
    # like 0/""/[]/{} from a hand-edited or partially-corrupt file) falls back
    # to enabled. This mirrors the endpoint's strict isinstance(bool) check so
    # the only way to disable a plugin is a genuine ``{"enabled": false}``.
    if not isinstance(value, bool):
        return True
    return value


def _persist_plugin_enabled(plugin_id: str, enabled: bool) -> None:
    """Persist a plugin's enabled flag, keeping the file minimal: only the
    non-default (``enabled: false``) entries are stored; re-enabling drops the
    key entirely. Written atomically (temp + os.replace) under the state lock."""
    path = _plugin_state_path()
    with _PLUGIN_STATE_LOCK:
        # Re-read inside the lock so concurrent toggles compose instead of
        # clobbering each other.
        state: dict = {}
        try:
            existing = json.loads(path.read_text(encoding="utf-8"))
            if isinstance(existing, dict):
                state = existing
        except FileNotFoundError:
            state = {}  # First write — nothing to preserve.
        except (json.JSONDecodeError, UnicodeDecodeError):
            # The existing file is corrupt (bad JSON or non-UTF-8 bytes) and is
            # already ignored on load (treated as {}), so its disabled states
            # aren't honored anyway — rewrite fresh to self-heal rather than fail
            # the toggle.
            state = {}
        # Any other OSError (permission, IO error on an existing, readable-later
        # file) is NOT swallowed: resetting to {} and writing would clobber every
        # OTHER plugin's persisted disabled state. Let it propagate so the caller
        # (set_plugin_enabled) returns a controlled 500 and the file is untouched.
        if enabled:
            state.pop(plugin_id, None)
        else:
            state[plugin_id] = {"enabled": False}
        path.parent.mkdir(parents=True, exist_ok=True)
        tmp = path.with_suffix(path.suffix + ".tmp")
        tmp.write_text(json.dumps(state, indent=2), encoding="utf-8")
        os.replace(tmp, path)


def _safe_plugin_id_for_module_name(plugin_id: str) -> str:
    """Bijectively encode a plugin_id for safe use as part of a Python
    module name.

    Plugin ids are opaque manifest values that can take reverse-DNS
    forms (`com.example.foo`) or contain other characters that
    Python's import machinery interprets specially — most
    importantly `.`, which it treats as a package boundary.

    The encoding is **bijective** so distinct plugin_ids always map
    to distinct encoded strings (otherwise two installed plugins
    could share a cache-key prefix and reintroduce the cross-plugin
    collision this PR is fixing). To make `_<hex>_` sequences in
    the output ONLY appear as a result of intentional escapes, the
    underscore is encoded first:

      `_` → `_5f_`   (hex of `_`)
      `.` → `_2e_`   (hex of `.`, applied after the `_` pass)

    With this scheme:
      `foo`            → `foo`
      `foo_bar`        → `foo_5f_bar`
      `foo.bar`        → `foo_2e_bar`
      `foo_2e_bar`     → `foo_5f_2e_5f_bar`  (distinct from `foo.bar`)
      `com.example.x`  → `com_2e_example_2e_x`

    Spotted across multiple Copilot review rounds on PR #105.
    """
    return plugin_id.replace("_", "_5f_").replace(".", "_2e_")


def _normalize_string_list(value) -> list[str]:
    if not isinstance(value, list):
        return []
    # Strip surrounding whitespace and drop empty-after-strip entries so values
    # like "  capability-pipelines.v1  " match for version detection and a "   "
    # entry doesn't leak into API responses.
    return [stripped for item in value if isinstance(item, str) and (stripped := item.strip())]


def _normalize_manifest_mapping(value) -> dict:
    return value if isinstance(value, dict) else {}


def _normalize_manifest_sequence(value) -> list:
    return value if isinstance(value, list) else []


_CAPABILITY_STANDARD = "capability-pipelines.v1"
_VALID_CAPABILITY_ROLES = {
    "owner", "provider", "observer", "requester", "transformer", "handler",
    "validator", "short-circuiter", "contributor",
}
_VALID_CAPABILITY_MODES = {"active", "optional", "legacy-shim", "disabled"}
_VALID_CAPABILITY_COMPATIBILITY = {"none", "shim-allowed", "degrade-noop", "required", "legacy-window-shim"}
_VALID_CAPABILITY_OWNERSHIP = {"exclusive-owner", "multi-provider", "observer-only", "requester-only", "privileged", "diagnostic-only"}
_VALID_CAPABILITY_KINDS = {"command", "provider-coordinator", "event", "diagnostic", "privileged"}
_VALID_CAPABILITY_SAFETY = {"safe", "privileged", "sensitive", "diagnostic-only"}
_VALID_CAPABILITY_SETTING_TYPES = {"toggle", "range", "select"}


def _validate_capability_setting_options(value, key):
    """Validate a `select` descriptor's options. Returns (clean, warning).

    `clean` is None when absent; a warning string (and None clean) rejects the
    whole options list. Mirrors the all-or-nothing strictness used for the
    surrounding capability fields.
    """
    if value is None:
        return None, None
    if not isinstance(value, list):
        return None, f"settings entry '{key}' options must be a list"
    clean = []
    for opt in value:
        if not isinstance(opt, dict):
            return None, f"settings entry '{key}' options must be objects"
        oid = opt.get("id")
        if not isinstance(oid, str) or not oid.strip():
            return None, f"settings entry '{key}' option requires a non-empty id"
        descriptor = {"id": oid.strip()}
        label = opt.get("label")
        if isinstance(label, str) and label.strip():
            descriptor["label"] = label.strip()
        clean.append(descriptor)
    return clean, None


def _validate_capability_settings(value):
    """Validate a capability's per-instance `settings` control descriptors.

    Returns (clean_settings, warnings). `clean_settings` is None when the field
    is absent, else a list of sanitized descriptor dicts. Any warning means the
    surrounding capability declaration is dropped (the caller folds these into
    its all-or-nothing `domain_warnings`), so manifest authors get a clear
    signal rather than a silently half-applied control surface.
    """
    if value is None:
        return None, []
    if not isinstance(value, list):
        return None, ["settings must be a list of control descriptors"]
    warnings = []
    clean = []
    seen_keys = set()
    for entry in value:
        if not isinstance(entry, dict):
            warnings.append("each settings entry must be an object")
            continue
        key = entry.get("key")
        ctype = entry.get("type")
        if not isinstance(key, str) or not key.strip():
            warnings.append("settings entry requires a non-empty string key")
            continue
        key = key.strip()
        if key in seen_keys:
            warnings.append(f"duplicate settings key '{key}'")
            continue
        if ctype not in _VALID_CAPABILITY_SETTING_TYPES:
            warnings.append(f"settings entry '{key}' has unsupported type")
            continue
        descriptor = {"key": key, "type": ctype}
        label = entry.get("label")
        # Trim and treat empty-after-strip as absent (mirrors manifest
        # normalization elsewhere) so hosts don't render blank labels.
        if isinstance(label, str) and label.strip():
            descriptor["label"] = label.strip()
        if "default" in entry:
            descriptor["default"] = entry["default"]
        bad_number = False
        for num_field in ("min", "max", "step"):
            if num_field not in entry:
                continue
            num = entry[num_field]
            # bool is an int subclass — exclude it so a stray `true` isn't a number.
            # Declared-but-non-numeric is a warning (and drops the declaration via
            # the all-or-nothing gate), not a silent drop: otherwise the author's
            # control would behave differently than declared with no signal.
            if isinstance(num, bool) or not isinstance(num, (int, float)):
                warnings.append(f"settings entry '{key}' {num_field} must be a number")
                bad_number = True
            else:
                descriptor[num_field] = num
        if bad_number:
            continue
        if ctype == "select":
            options, opt_warning = _validate_capability_setting_options(entry.get("options"), key)
            if opt_warning:
                warnings.append(opt_warning)
            elif options is not None:
                descriptor["options"] = options
        clean.append(descriptor)
        seen_keys.add(key)
    return clean, warnings


def _coerce_capability_version(value):
    """Coerce a capability `version` to a finite number for the supported-version
    check, or None when it isn't a recognizable number. The motivating case is a
    numeric *string* like "1": the browser runtime does `Number(version)` and
    treats "1" as version 1, so the backend must accept it too rather than drop
    the declaration. A returned number != 1 is reported unsupported (matching the
    runtime's `Number.isFinite(v) && v !== 1`); None defaults to compatible
    (version 1), consistent with the runtime's `Number(version) || 1` fallback.

    This handles ints, floats, and decimal numeric strings — the forms that
    occur in real manifests. It does NOT mirror every JS `Number()` quirk
    (hex/binary/octal literals, "" / null / false coercing to 0); those are not
    valid manifest versions, and the runtime itself is inconsistent about them,
    so they fall through to the compatible default. bool is rejected so
    `True`/`False` aren't read as 1/0."""
    if isinstance(value, bool):
        return None
    if isinstance(value, (int, float)):
        try:
            number = float(value)
        except OverflowError:
            # An absurdly large JSON integer can't convert to float; it's not a
            # real version, so default to compatible rather than crash parsing.
            return None
    elif isinstance(value, str):
        text = value.strip()
        if not text:
            return None
        try:
            number = float(text)
        except (ValueError, OverflowError):
            return None
    else:
        return None
    # Reject NaN and infinities (a non-finite version is not a real version).
    if number != number or number in (float("inf"), float("-inf")):
        return None
    return number


def _capability_warnings(manifest: dict, plugin_id: str) -> tuple[dict, list[dict], list[dict]]:
    raw_capabilities = manifest.get("capabilities")
    warnings: list[dict] = []
    unsupported: list[dict] = []
    if raw_capabilities is None:
        return {}, warnings, unsupported
    if not isinstance(raw_capabilities, dict):
        warnings.append({"field": "capabilities", "reason": "capabilities must be an object"})
        return {}, warnings, unsupported

    standards = _normalize_string_list(manifest.get("standards"))
    unsupported_standards = [item for item in standards if item.startswith("capability-pipelines.") and item != _CAPABILITY_STANDARD]
    sanitized: dict = {}
    for domain, declaration in raw_capabilities.items():
        domain_warnings: list[str] = []
        if not isinstance(domain, str) or not domain:
            warnings.append({"field": "capabilities", "reason": "capability domain names must be non-empty strings"})
            continue
        if not isinstance(declaration, dict):
            warnings.append({"field": f"capabilities.{domain}", "reason": "capability declaration must be an object"})
            continue

        version = declaration.get("version", 1)
        # Mirror the browser runtime's version handling: it does
        # `Number(version)` and treats a declaration incompatible only when
        # that is finite and != 1 (static/capabilities.js). So a numeric string
        # like "1" coerces to a supported version, and an unparseable version
        # falls back to 1 (compatible) rather than being dropped. Matching this
        # avoids /api/plugins dropping declarations the runtime would accept.
        numeric_version = _coerce_capability_version(version)
        version_incompatible = numeric_version is not None and numeric_version != 1
        if unsupported_standards or version_incompatible:
            unsupported.append({
                "plugin_id": plugin_id,
                "domain": domain,
                "standards": unsupported_standards or standards,
                # Keep the raw value for diagnostics of truly unsupported versions.
                "version": version,
                "reason": "unsupported capability-pipelines version",
            })
            sanitized[domain] = {
                "roles": [],
                "commands": [],
                "events": [],
                "mode": "disabled",
                "compatibility": "degrade-noop",
                "ownership": "diagnostic-only",
                "safety": "diagnostic-only",
                "version": int(numeric_version) if numeric_version is not None and numeric_version == int(numeric_version) else 1,
                "incompatible": True,
            }
            continue

        roles = declaration.get("roles", [])
        commands = declaration.get("commands", [])
        operations = declaration.get("operations", [])
        requests = declaration.get("requests", [])
        observes = declaration.get("observes", [])
        emits = declaration.get("emits", [])
        events = declaration.get("events", [])
        kind = declaration.get("kind", "")
        mode = declaration.get("mode", "active")
        compatibility = declaration.get("compatibility", "degrade-noop")
        ownership = declaration.get("ownership", "exclusive-owner")
        safety = declaration.get("safety", "safe")

        if not isinstance(roles, list) or any(not isinstance(item, str) or item not in _VALID_CAPABILITY_ROLES for item in roles):
            domain_warnings.append("roles must be known capability roles")
        # Reject whitespace-only entries (not just empty strings): the browser
        # runtime trims and drops them, so accepting them here would surface
        # commands/operations/etc via /api/plugins that the runtime never sees.
        if not isinstance(commands, list) or any(not isinstance(item, str) or not item.strip() for item in commands):
            domain_warnings.append("commands must be a list of non-empty strings")
        if not isinstance(operations, list) or any(not isinstance(item, str) or not item.strip() for item in operations):
            domain_warnings.append("operations must be a list of non-empty strings")
        if not isinstance(requests, list) or any(not isinstance(item, str) or not item.strip() for item in requests):
            domain_warnings.append("requests must be a list of non-empty strings")
        if not isinstance(observes, list) or any(not isinstance(item, str) or not item.strip() for item in observes):
            domain_warnings.append("observes must be a list of non-empty strings")
        if not isinstance(emits, list) or any(not isinstance(item, str) or not item.strip() for item in emits):
            domain_warnings.append("emits must be a list of non-empty strings")
        if not isinstance(events, list) or any(not isinstance(item, str) or not item.strip() for item in events):
            domain_warnings.append("events must be a list of non-empty strings")
        if kind and kind not in _VALID_CAPABILITY_KINDS:
            domain_warnings.append("kind is not supported")
        if mode not in _VALID_CAPABILITY_MODES:
            domain_warnings.append("mode is not supported")
        if compatibility not in _VALID_CAPABILITY_COMPATIBILITY:
            domain_warnings.append("compatibility is not supported")
        if ownership not in _VALID_CAPABILITY_OWNERSHIP:
            domain_warnings.append("ownership is not supported")
        if safety not in _VALID_CAPABILITY_SAFETY:
            domain_warnings.append("safety is not supported")
        order = declaration.get("order")
        if order is not None and not isinstance(order, dict):
            domain_warnings.append("order must be an object")
        clean_settings, settings_warnings = _validate_capability_settings(declaration.get("settings"))
        domain_warnings.extend(settings_warnings)
        if domain_warnings:
            warnings.append({"field": f"capabilities.{domain}", "reason": "; ".join(domain_warnings)})
            continue

        clean = {
            "roles": roles,
            # Store trimmed values so backend output matches the browser
            # runtime (which trims). Validation above already guaranteed every
            # entry is a non-empty-after-strip string.
            "commands": _normalize_string_list(commands),
            "operations": _normalize_string_list(operations),
            "requests": _normalize_string_list(requests),
            "observes": _normalize_string_list(observes),
            "emits": _normalize_string_list(emits),
            "events": _normalize_string_list(events),
            "mode": mode,
            "compatibility": compatibility,
            "ownership": ownership,
            "safety": safety,
            "version": 1,
        }
        # Only emit `kind` when the manifest actually declared one. It defaults
        # to "" above, but "" is not a valid value in the published manifest
        # schema (kind is an enum), so emitting kind: "" would make /api/plugins
        # and diagnostics violate the schema and confuse consumers.
        if kind:
            clean["kind"] = kind
        if isinstance(order, dict):
            clean["order"] = order
        if isinstance(declaration.get("provider_policy"), dict):
            clean["provider_policy"] = declaration["provider_policy"]
        # Declarative per-instance control descriptors a consuming host renders
        # generically (feedBack#849). Domain-agnostic: validated for any
        # capability here and surfaced via /api/plugins; each domain defines how
        # a value is applied (visualization is the first consumer).
        if clean_settings:
            clean["settings"] = clean_settings
        # Preserve the human-readable text the runtime/Inspector display
        # (static/capabilities.js reads declaration.description / .summary).
        # Dropping these here would blank capability descriptions in
        # /api/plugins and the diagnostics bundle even for valid manifests.
        for _text_field in ("description", "summary"):
            _value = declaration.get(_text_field)
            if isinstance(_value, str) and _value:
                clean[_text_field] = _value
        sanitized[domain] = clean
    return sanitized, warnings, unsupported


def _compatibility_shims_from_manifest(manifest: dict, plugin_id: str) -> list[dict]:
    return []


def _normalize_ui_contributions(manifest: dict) -> dict:
    declared = {
        **_normalize_manifest_mapping(manifest.get("ui_contributions")),
        **_normalize_manifest_mapping(manifest.get("ui")),
    }
    legacy = []
    if manifest.get("nav"):
        legacy.append({"region": "ui.navigation", "legacy_source": "nav"})
    if manifest.get("screen"):
        legacy.append({"region": "ui.plugin-screens", "legacy_source": "screen"})
    if manifest.get("settings"):
        legacy.append({"region": "settings", "legacy_source": "settings"})
    if manifest.get("type") == "visualization":
        legacy.append({"region": "visualization", "legacy_source": "type"})
    return {"declared": declared, "legacy": legacy}


def _normalize_runtime_domains(manifest: dict) -> dict:
    return {
        **_normalize_manifest_mapping(manifest.get("runtime_domains")),
        **_normalize_manifest_mapping(manifest.get("domains")),
    }


def _load_plugin_sibling(plugin_id: str, plugin_dir: Path, name: str):
    """Load a sibling module from a plugin's directory under a namespaced
    module name (`plugin_<plugin_id>.<name>`, with plugin_id
    bijectively encoded by `_safe_plugin_id_for_module_name` —
    `_` -> `_5f_`, `.` -> `_2e_`). Both single-file siblings
    (`extractor.py`) and package-form siblings (`extractor/__init__.py`)
    are supported; package form wins when both exist (matches CPython's
    import precedence). Mirrors the routes-loading pattern in
    `load_plugins()` and shares its `sys.modules` cache, so two plugins
    that each ship `extractor.py` get distinct cached modules instead
    of stomping each other through `sys.path`. See feedBack#33."""
    if not isinstance(plugin_id, str) or not plugin_id:
        raise ValueError(
            f"load_sibling: plugin_id must be a non-empty string, got {plugin_id!r}"
        )
    if (
        not isinstance(name, str)
        or not name
        or "/" in name
        or "\\" in name
        or "." in name
        or name.endswith(".py")
    ):
        # Reject path traversal, the redundant `.py` suffix, and any
        # `.` (the separator between id and name in the cache key).
        raise ValueError(
            f"plugin {plugin_id!r}: load_sibling expects a bare module name, got {name!r}"
        )
    safe_plugin_id = _safe_plugin_id_for_module_name(plugin_id)
    parent_name = f"plugin_{safe_plugin_id}"
    module_name = f"{parent_name}.{name}"

    # Pre-check that the sibling actually exists before we hand off
    # to importlib.import_module — its ModuleNotFoundError is less
    # specific than the message we want to surface (which lists both
    # probed paths so a confused author sees "I checked here AND
    # here").
    file_path = plugin_dir / f"{name}.py"
    pkg_init = plugin_dir / name / "__init__.py"
    if not file_path.is_file() and not pkg_init.is_file():
        raise ImportError(
            f"plugin {plugin_id!r}: no sibling module {name!r} at "
            f"{file_path} or {pkg_init}"
        )

    # Register a synthetic parent package so the standard import
    # machinery can find this plugin's siblings via the parent's
    # `__path__`. The parent points at the plugin's directory; this
    # is what relative imports between siblings consult. It does NOT
    # undermine the namespace isolation, because:
    #   • bare `import sibling` still goes through sys.path (the
    #     transition fallback for plugins that haven't migrated)
    #   • `import plugin_<id>.sibling` lands in the namespaced
    #     sys.modules entry — same key load_sibling produces
    # `setdefault` is atomic under the GIL so two threads racing to
    # create the parent can't overwrite each other's registration.
    # Spotted by codex/Copilot reviews on PRs for feedBack#33.
    import types
    new_parent = types.ModuleType(parent_name)
    new_parent.__path__ = [str(plugin_dir)]
    sys.modules.setdefault(parent_name, new_parent)

    # Delegate the actual load to importlib.import_module. It uses
    # Python's per-module import lock, so concurrent callers — via
    # load_sibling, relative imports inside another sibling
    # (`from . import extractor`), or an explicit
    # `importlib.import_module('plugin_<id>.<name>')` from anywhere
    # — all serialize through the SAME lock. A rolled-our-own lock
    # could only coordinate load_sibling callers; the standard lock
    # plugs cross-API races where the half-initialized module would
    # otherwise leak. Python's standard finder walks the parent's
    # `__path__`, picks package over file when both exist (matching
    # CPython precedence), exposes the child as an attribute on the
    # parent post-load (`setattr(parent, name, child)`), and cleans
    # up sys.modules on exec failure — all the things this helper
    # used to do by hand. Spotted by Copilot review on PR #105
    # round 5.
    return importlib.import_module(module_name)


def _warn_on_module_collisions(plugin_specs):
    """Scan top-level importable modules across all plugins about to
    be loaded. Print a warning for any module name shipped by 2+
    plugins, since bare `import <name>` from those plugins will hit
    the sys.path-based cache and cross-load (feedBack#33).

    Both top-level `.py` files AND top-level packages (directories
    containing `__init__.py`) are scanned — the same collision
    pattern applies to either, e.g. one plugin's `extractor.py` vs
    another plugin's `extractor/__init__.py` both produce a shared
    `sys.modules['extractor']` entry. Spotted by codex review on
    PR for feedBack#33.

    `routes.py` itself is excluded because the loader already
    namespaces it as `plugin_{id}_routes`. Top-level dunder files
    (like a hypothetical bare `__main__.py`) are excluded too.

    `plugin_specs` is a list of `(plugin_id, plugin_dir)` tuples for
    plugins the loader has decided to load (post-dedup).
    """
    # Map: module_name -> {plugin_id: set_of_kinds}.
    # Using a per-plugin nested dict deduplicates the case where ONE
    # plugin ships both `extractor.py` and `extractor/__init__.py`
    # — that intra-plugin layout is supported by load_sibling
    # (package form wins, matching CPython precedence) and shouldn't
    # trip a cross-plugin collision warning. Spotted by codex review
    # on PR for feedBack#33.
    by_name: dict[str, dict[str, set[str]]] = {}
    for plugin_id, plugin_dir in plugin_specs:
        try:
            for child in plugin_dir.iterdir():
                module_name = None
                kind = None
                if child.is_file() and child.suffix == ".py":
                    if child.name == "routes.py" or child.name.startswith("__"):
                        continue
                    module_name = child.stem
                    kind = "module"
                elif child.is_dir() and (child / "__init__.py").is_file():
                    if child.name.startswith("__"):
                        continue
                    module_name = child.name
                    kind = "package"
                if module_name is None:
                    continue
                by_name.setdefault(module_name, {}).setdefault(plugin_id, set()).add(kind)
        except OSError:
            # Unreadable plugin dir — the per-plugin load below will
            # surface the error in a more useful place; don't warn here.
            continue
    for name, by_plugin in by_name.items():
        # Count distinct plugin ids — only fire when MULTIPLE plugins
        # ship the same module name. A single plugin shipping the
        # name in multiple forms is fine.
        if len(by_plugin) < 2:
            continue
        ids_quoted = ", ".join(f"'{pid}'" for pid in sorted(by_plugin))
        # Aggregate kinds across all plugins to label the warning.
        kinds = {k for kind_set in by_plugin.values() for k in kind_set}
        kind_label = "module/package" if len(kinds) > 1 else next(iter(kinds))
        log.warning(
            "Module-name collision: %r (%s) is shipped by %d plugins (%s). "
            "Bare `import %s` may load the wrong file. "
            "Migrate to context['load_sibling']('%s') — see CLAUDE.md (feedBack#33).",
            name, kind_label, len(by_plugin), ids_quoted, name, name,
        )


def _is_safe_tour_manifest_filename(val) -> bool:
    """Return True only for non-empty relative tour manifest filenames.

    The filename must not be absolute, must not contain backslashes, must
    not contain any ``..`` path segment, and must not be a bare ``.`` (which
    would resolve to the plugin directory itself) so ``has_tour`` only
    advertises files that are eligible to be served by the route handler.
    """
    if not isinstance(val, str) or not val:
        return False
    if "\\" in val or os.path.isabs(val):
        return False
    p = Path(val)
    if ".." in p.parts:
        return False
    # Reject "." and any path whose final component is "." (e.g. "./").
    return p.name != '.'


def _is_valid_tour_manifest(val) -> bool:
    """Return True only when the tour manifest field is a usable string
    filename or a dict.  A dict without a ``file`` key is valid — the route
    handler defaults it to ``"tour.json"``.  A dict that explicitly sets
    ``file`` must use a non-empty safe relative string (``file: null``,
    ``file: 1``, ``file: "../x.json"``, absolute paths, etc. are rejected).
    Empty strings, non-string scalars (e.g. ``true``, ``1``), and dicts with
    an explicitly invalid ``file`` value are treated as absent.
    """
    if isinstance(val, str):
        return _is_safe_tour_manifest_filename(val)
    if isinstance(val, dict):
        if "file" not in val:
            return True  # no file key → defaults to "tour.json" in the route
        return _is_safe_tour_manifest_filename(val["file"])
    return False


def _normalize_export_paths(settings_field, plugin_id: str) -> list[str]:
    """Validate and normalize a plugin's `settings.server_files` manifest
    list into clean POSIX-style relpaths suitable for the settings
    export/import bundle (feedBack#113).

    Each entry must be a non-empty string with no absolute prefix and
    no `..` segment. A trailing `/` denotes a directory (recurse on
    export). Invalid entries are dropped with a `[Plugin]` warning so
    a bad manifest can't smuggle a path-traversal opportunity into
    the importer's allowlist.

    Returns a list of normalized strings. Returns `[]` when the
    manifest doesn't declare any exportable server files (the common
    case — most plugins keep state purely in localStorage).
    """
    if not isinstance(settings_field, dict):
        return []
    raw = settings_field.get("server_files")
    if raw is None:
        return []
    if not isinstance(raw, list):
        log.warning(
            "Plugin %r: settings.server_files must be a list, got %s; ignoring",
            plugin_id, type(raw).__name__,
        )
        return []

    cleaned: list[str] = []
    for entry in raw:
        if not isinstance(entry, str) or not entry:
            log.warning(
                "Plugin %r: dropping non-string / empty server_files entry %r",
                plugin_id, entry,
            )
            continue
        # Loader rules mirror what `_validate_relpath` enforces at import
        # time, so any entry that passes here is guaranteed to round-trip
        # through export and back through import. Surfacing whitespace /
        # `.` / dotfile entries as warnings beats silently producing a
        # bundle that the same server later refuses to ingest.
        if entry != entry.strip():
            log.warning(
                "Plugin %r: dropping server_files entry with leading/trailing whitespace %r",
                plugin_id, entry,
            )
            continue
        # Reject absolute paths, drive letters, and any backslash-
        # separated form before splitting — the importer treats the
        # allowlist as POSIX strings, so accepting `foo\bar` here would
        # let a malicious manifest sidestep traversal detection on
        # platforms whose `Path` accepts both separators.
        if "\\" in entry:
            log.warning(
                "Plugin %r: server_files entry must use POSIX separators, dropping %r",
                plugin_id, entry,
            )
            continue
        # Strip a single trailing slash for the traversal check, then
        # re-attach it so the export walker can still detect "this is
        # a directory" from the normalized form.
        is_dir = entry.endswith("/")
        body = entry.rstrip("/")
        if not body:
            log.warning("Plugin %r: dropping empty server_files entry", plugin_id)
            continue
        parts = body.split("/")
        if (
            body.startswith("/")
            or (len(body) >= 2 and body[1] == ":")  # Windows drive letter
            or any(part in ("", ".", "..") for part in parts)
            or parts[0].startswith(".")
        ):
            log.warning(
                "Plugin %r: dropping unsafe server_files entry %r "
                "(absolute / traversal / dotfile / empty segment)",
                plugin_id, entry,
            )
            continue
        cleaned.append(body + ("/" if is_dir else ""))
    return cleaned


def _normalize_diagnostics_paths(diagnostics_field, plugin_id: str) -> list[str]:
    """Validate and normalize a plugin's `diagnostics.server_files`
    manifest list. Mirrors `_normalize_export_paths` semantics — the
    diagnostics export reads files using the same allowlist rules so
    every entry that passes here is safe for the bundle assembler to
    open without re-validating. Returns `[]` when the manifest doesn't
    declare any diagnostic files.
    """
    if not isinstance(diagnostics_field, dict):
        return []
    raw = diagnostics_field.get("server_files")
    if raw is None:
        return []
    if not isinstance(raw, list):
        log.warning(
            "Plugin %r: diagnostics.server_files must be a list, got %s; ignoring",
            plugin_id, type(raw).__name__,
        )
        return []
    cleaned: list[str] = []
    for entry in raw:
        if not isinstance(entry, str) or not entry:
            log.warning(
                "Plugin %r: dropping non-string / empty diagnostics.server_files entry %r",
                plugin_id, entry,
            )
            continue
        if entry != entry.strip():
            log.warning(
                "Plugin %r: dropping diagnostics.server_files entry with leading/trailing whitespace %r",
                plugin_id, entry,
            )
            continue
        if "\\" in entry:
            log.warning(
                "Plugin %r: diagnostics.server_files entry must use POSIX separators, dropping %r",
                plugin_id, entry,
            )
            continue
        is_dir = entry.endswith("/")
        body = entry.rstrip("/")
        if not body:
            log.warning("Plugin %r: dropping empty diagnostics.server_files entry", plugin_id)
            continue
        parts = body.split("/")
        if (
            body.startswith("/")
            or (len(body) >= 2 and body[1] == ":")
            or any(part in ("", ".", "..") for part in parts)
            or parts[0].startswith(".")
        ):
            log.warning(
                "Plugin %r: dropping unsafe diagnostics.server_files entry %r "
                "(absolute / traversal / dotfile / empty segment)",
                plugin_id, entry,
            )
            continue
        cleaned.append(body + ("/" if is_dir else ""))
    return cleaned


def _parse_diagnostics_callable(diagnostics_field, plugin_id: str) -> str | None:
    """Validate `diagnostics.callable` shape (`"<module>:<function>"`)
    and return the literal spec string. Resolution happens lazily when
    the export endpoint actually needs the callable, so a missing
    sibling at load time doesn't fail plugin registration.
    """
    if not isinstance(diagnostics_field, dict):
        return None
    spec = diagnostics_field.get("callable")
    if spec is None:
        return None
    if not isinstance(spec, str) or ":" not in spec:
        log.warning(
            "Plugin %r: diagnostics.callable must be a string of the form "
            "'<module>:<function>', got %r; ignoring",
            plugin_id, spec,
        )
        return None
    module_name, _, fn_name = spec.partition(":")
    if not module_name or not fn_name:
        log.warning(
            "Plugin %r: diagnostics.callable %r is missing module or function name; ignoring",
            plugin_id, spec,
        )
        return None
    # Validate module_name matches load_sibling() constraints: bare name,
    # no dots, no slashes, no .py suffix.  A malformed spec would only
    # surface as an error at export time; reject it here consistently.
    if (
        "/" in module_name
        or "\\" in module_name
        or "." in module_name
        or module_name.endswith(".py")
    ):
        log.warning(
            "Plugin %r: diagnostics.callable module %r must be a bare "
            "module name (no dots, slashes, or .py suffix); ignoring",
            plugin_id, module_name,
        )
        return None
    return spec


def _install_requirements(plugin_dir: Path, plugin_id: str):
    """Install plugin requirements.txt to a persistent location."""
    req_file = plugin_dir / "requirements.txt"
    if not req_file.exists():
        return True

    _PIP_TARGET.mkdir(parents=True, exist_ok=True)
    pip_target = str(_PIP_TARGET)

    # Add to sys.path if not already there
    if pip_target not in sys.path:
        sys.path.insert(0, pip_target)

    # Check if already installed (marker file). Use a deterministic
    # digest — Python's built-in hash() is randomised per process
    # (PYTHONHASHSEED), so the marker would never match on restart and
    # pip would re-resolve every plugin's requirements on every boot.
    marker = _PIP_TARGET / f".installed_{plugin_id}"
    req_hash = hashlib.sha256(req_file.read_bytes()).hexdigest()
    if marker.exists() and marker.read_text().strip() == req_hash:
        return True  # Already installed, same requirements

    log.info("Installing requirements for plugin %r (this can take a while for large deps)...", plugin_id)
    try:
        result = subprocess.run(
            [sys.executable, "-m", "pip", "install",
             "--target", pip_target,
             "--quiet",
             "-r", str(req_file)],
            capture_output=True, text=True, timeout=1800,
        )
        if result.returncode == 0:
            marker.write_text(req_hash)
            log.info("Requirements installed for plugin %r", plugin_id)
            return True
        else:
            err_lower = result.stderr.lower() if result.stderr else ""
            if "read-only" in err_lower or "permission denied" in err_lower:
                log.warning(
                    "Plugin %r: optional dependencies not installed — "
                    "functionality may be limited. Install dependencies manually "
                    "or configure an external service if available.",
                    plugin_id,
                )
            else:
                log.warning("Plugin %r: failed to install requirements: %s", plugin_id, result.stderr[:300])
            return False
    except Exception as e:
        err_lower = str(e).lower()
        if "read-only" in err_lower or "permission denied" in err_lower:
            log.warning(
                "Plugin %r: optional dependencies not installed — "
                "functionality may be limited. Install dependencies manually "
                "or configure an external service if available.",
                plugin_id,
            )
        else:
            log.warning("Plugin %r: error installing requirements: %s", plugin_id, e)
        return False


def load_plugins(app: FastAPI, context: dict, progress_cb=None, route_setup_fn=None,
                 instrument_registry=None):
    """Discover and load all plugins from built-in and user directories.

    progress_cb, when provided, receives structured progress events:
    {
      "phase": "<phase-id>",
      "message": "<human text>",
      "plugin_id": "<id or ''>",
      "loaded": <int>,
      "total": <int>,
      "error": "<optional error text>"
    }

    route_setup_fn, when provided, is called instead of directly invoking
    `routes_module.setup(app, ctx)`.  Callers that load plugins from a
    background thread can pass a hook that marshals the call back to the
    main thread (e.g. via loop.call_soon_threadsafe) to keep FastAPI/
    Starlette router mutation on the event-loop thread.

    Signature: route_setup_fn(fn: Callable[[], None]) -> None
    where `fn` is a zero-argument callable that performs the setup call.
    """

    def _emit_progress(phase: str, message: str, plugin_id: str = "", loaded: int = 0,
                       total: int = 0, error: str | None = None,
                       clear_error: bool = False):
        if not progress_cb:
            return
        try:
            event: dict = {
                "phase": phase,
                "message": message,
                "plugin_id": plugin_id,
                "loaded": loaded,
                "total": total,
            }
            # Include the error key only when meaningful:
            # - A non-null error string sets/updates the error field.
            # - clear_error=True sends an explicit null to clear a
            #   previously-reported error (e.g. bundled failure cleared
            #   by a successful user-copy fallback). Downstream handlers
            #   must check `"error" in event`, not `event.get("error") is
            #   not None`, to receive the clear signal.
            # - No error kwarg → key is omitted; downstream preserves
            #   any previously-reported error across non-error events.
            if error is not None:
                event["error"] = error
            elif clear_error:
                event["error"] = None
            progress_cb(event)
        except Exception:
            # Progress reporting must never break plugin startup.
            pass

    # Re-entrancy: a fresh load_plugins() pass owns the published state from
    # scratch. Clearing BOTH structures at the START (rather than an atomic
    # clear()+extend() at the END) lets us publish each plugin incrementally
    # as it graduates, so /api/plugins reflects ready plugins the moment they
    # are usable instead of all-at-once when the slowest install finishes.
    # Tests and dev "reload plugins" re-invoke this; the clear keeps repeated
    # passes from accumulating duplicates while preserving list identity.
    #
    # Bump the load generation and capture it locally so every registry
    # mutation below can verify it's still the latest pass before publishing.
    # Without this, a background loader from an earlier pass could call
    # _graduate()/_mark_failed() *after* this pass cleared the registries,
    # re-inserting a plugin it already graduated (a duplicate) or resurrecting
    # a stale "installing" entry. See _LOAD_GENERATION.
    global _LOAD_GENERATION
    with PLUGINS_LOCK:
        _LOAD_GENERATION += 1
        my_generation = _LOAD_GENERATION
        LOADED_PLUGINS.clear()
        PENDING_PLUGINS.clear()

    def _is_current_generation() -> bool:
        """Return True iff this load pass is still the latest one. Callers MUST
        already hold PLUGINS_LOCK (generation reads/writes are lock-guarded)."""
        return _LOAD_GENERATION == my_generation

    def _loaded_count() -> int:
        with PLUGINS_LOCK:
            return len(LOADED_PLUGINS)

    def _mark_failed(plugin_id: str, error: str) -> None:
        """Flip a pending plugin's status to "failed" with error text so it
        stays a visible, disabled nav entry. No-op if the plugin already
        graduated (it can't fail after becoming ready) or if a newer load pass
        has superseded this one."""
        with PLUGINS_LOCK:
            if not _is_current_generation():
                return
            entry = PENDING_PLUGINS.get(plugin_id)
            if entry is not None:
                entry["status"] = "failed"
                entry["error"] = error

    def _graduate(entry: dict) -> int:
        """Move a plugin from pending to loaded (ready). Inserts into
        LOADED_PLUGINS at the slot dictated by its discovery order (`_order`)
        so the published list stays in discovery order even when earlier
        plugins failed (leaving gaps) or a user-copy fallback graduates out of
        sequence after the main loop. Pops the pending entry under the same
        lock so a reader never sees the plugin in both structures. No-op (other
        than returning the current count) if a newer load pass has superseded
        this one, so a stale background loader can't re-insert into a registry
        a newer pass already cleared. Returns the new ready count."""
        order = entry.get("_order", 0)
        with PLUGINS_LOCK:
            if not _is_current_generation():
                return len(LOADED_PLUGINS)
            # Carry the latest runtime enable/disable intent. The ready entry was
            # rebuilt from the startup `_spec_entries` snapshot, but the toggle
            # endpoint may have flipped (and persisted) the live pending entry's
            # `enabled` flag while this plugin was still installing/loading. Both
            # the endpoint and this read happen under PLUGINS_LOCK, so without
            # carrying it forward a disable that arrived mid-load would silently
            # revert here and re-expose the plugin (and its capabilities) until
            # the next restart.
            _pending = PENDING_PLUGINS.get(entry["id"])
            if _pending is not None and "enabled" in _pending:
                entry["enabled"] = _pending["enabled"]
            pos = sum(1 for e in LOADED_PLUGINS if e.get("_order", 0) < order)
            LOADED_PLUGINS.insert(pos, entry)
            PENDING_PLUGINS.pop(entry["id"], None)
            return len(LOADED_PLUGINS)

    # Collect plugin directories — user plugins first so they override built-in
    plugin_dirs = []
    user_plugins_dir = os.environ.get("FEEDBACK_PLUGINS_DIR") or os.environ.get("SLOPSMITH_PLUGINS_DIR")
    if user_plugins_dir:
        user_path = Path(user_plugins_dir)
        if user_path.is_dir() and user_path != PLUGINS_DIR:
            plugin_dirs.append(user_path)
    if PLUGINS_DIR.is_dir():
        plugin_dirs.append(PLUGINS_DIR)

    if not plugin_dirs:
        _emit_progress("plugins-complete", "No plugin directories found", loaded=0, total=0)
        return

    # Add persistent pip target to sys.path
    pip_target = str(_PIP_TARGET)
    if _PIP_TARGET.exists() and pip_target not in sys.path:
        sys.path.insert(0, pip_target)

    loaded_ids = set()
    # id → (plugin_id, plugin_dir, manifest) for the *kept* copy of each
    # plugin id. Used by the duplicate-skip path to log a useful
    # "user copy at X overriding bundled core plugin at Y" message
    # instead of a generic "skipping duplicate" line. Mirrors loaded_ids
    # in lifetime; both are local to this discovery pass.
    loaded_specs_by_id: dict[str, tuple] = {}
    # Maps plugin_id → evicted user spec (plugin_id, plugin_dir, manifest).
    # Populated when a bundled plugin evicts a user-installed copy. Used as
    # a fallback: if the bundled copy later fails to load its routes, the
    # user copy is restored so the server remains functional.
    _pending_evictions: dict[str, tuple] = {}
    # Maps plugin_id → set of sys.modules keys that were NEW during the
    # failed bundled route load. Bundled routes may import helpers under
    # bare names (e.g. `import helper`); these survive the namespaced
    # _parent_pkg cleanup and would resolve to bundled code if the fallback
    # plugin also uses bare imports. Purging them gives the fallback a
    # clean import slate (Thread 1, review-4226783807).
    _pending_eviction_stale_modules: dict[str, set] = {}

    def _is_bundled(pdir: Path, mf: dict) -> bool:
        """Return True iff pdir is the real in-tree bundled core plugin.

        Requires ALL THREE of:
        - Located directly in PLUGINS_DIR (pdir.parent == PLUGINS_DIR)
        - Manifest carries ``"bundled": true``
        - Directory name matches the plugin id (pdir.name == mf.get("id"))

        The directory-name check distinguishes the real in-tree copy from a
        verbatim user copy placed in plugins/ under a different folder name
        but still carrying ``"bundled": true`` from the source manifest.
        Neither the directory location alone nor the manifest field alone is
        sufficient — a user plugin cloned into plugins/ would pass the first
        check, and a user plugin could forge the second. The name check ties
        the directory to the specific plugin id so only the canonical
        ``plugins/<id>/`` location passes all three.
        """
        return (
            pdir.parent == PLUGINS_DIR
            and bool(mf.get("bundled"))
            and pdir.name == mf.get("id")
        )

    # Two-pass discovery so we can warn about cross-plugin module-name
    # collisions BEFORE any plugin's setup runs (feedBack#33). The
    # first pass collects (plugin_id, plugin_dir, manifest) tuples in
    # load order; the second pass actually executes each plugin's
    # setup with a per-plugin context.
    plugin_load_specs = []
    for plugins_base_dir in plugin_dirs:
        for plugin_dir in sorted(plugins_base_dir.iterdir()):
            if not plugin_dir.is_dir():
                continue
            manifest_path = plugin_dir / "plugin.json"
            if not manifest_path.exists():
                continue
            try:
                manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
            except Exception as e:
                log.warning("Failed to read plugin manifest %s: %s", manifest_path, e)
                continue
            plugin_id = manifest.get("id")
            if plugin_id is None:
                # No `id` key at all — silently skip (existing
                # behavior; manifests without an id were never
                # meant to be valid).
                continue
            # Type-check BEFORE the empty check: falsy non-string
            # values (`{"id": 0}`, `{"id": []}`) should produce the
            # explicit "must be a string" warning, not be silently
            # dropped. Spotted by Copilot review on PR #105 round 4.
            if not isinstance(plugin_id, str):
                log.warning(
                    "Skipping %s: 'id' must be a string, got %s (%r)",
                    manifest_path, type(plugin_id).__name__, plugin_id,
                )
                continue
            if not plugin_id:
                # Empty-string id — silently skip (matches the
                # original `if not plugin_id: continue` semantics
                # for empty strings).
                continue
            if plugin_id in loaded_ids:
                # Duplicate id — pick a winner. Bundled plugins always win.
                # `loaded_specs_by_id` records the already-seen copy; this
                # is the new candidate. Use specific log messages so it's
                # obvious which copy wins and why.
                kept = loaded_specs_by_id.get(plugin_id)
                # Bundled-ness requires ALL THREE: the in-tree PLUGINS_DIR
                # location, the manifest's ``"bundled": true`` flag, AND
                # the directory name matching the manifest id. See the
                # ``_is_bundled`` helper defined above for the full contract.
                this_is_bundled = _is_bundled(plugin_dir, manifest)
                kept_is_bundled = _is_bundled(kept[1], kept[2]) if kept else False
                if this_is_bundled and not kept_is_bundled:
                    # The incoming copy is the canonical bundled plugin; the
                    # already-kept copy is user-installed (FEEDBACK_PLUGINS_DIR
                    # or cloned directly into plugins/). Bundled always wins —
                    # evict the user copy and fall through to register the
                    # bundled version instead.
                    #
                    # Store the evicted spec as a potential fallback: if the
                    # bundled copy later fails to load its routes, the server
                    # restores this user copy so it keeps working.
                    _pending_evictions[plugin_id] = kept
                    log.warning(
                        "User-installed copy of bundled plugin %r at %s ignored; "
                        "using bundled version at %s.",
                        plugin_id, kept[1] if kept else "(unknown)", plugin_dir,
                    )
                    # Replace the user copy's slot in-place so the bundled
                    # copy inherits the same discovery position.  Removing and
                    # re-appending would shift the bundled entry to the end of
                    # plugin_load_specs, changing /api/plugins order and the
                    # frontend playSong wrapper chain.
                    _user_slot = next(
                        (i for i, s in enumerate(plugin_load_specs) if s[0] == plugin_id),
                        None,
                    )
                    _bundled_spec = (plugin_id, plugin_dir, manifest)
                    if _user_slot is not None:
                        plugin_load_specs[_user_slot] = _bundled_spec
                    else:
                        plugin_load_specs.append(_bundled_spec)
                    loaded_specs_by_id[plugin_id] = _bundled_spec
                    continue  # loaded_ids already contains plugin_id
                elif this_is_bundled and kept_is_bundled:
                    # Two bundled plugins share an id — shouldn't happen in a
                    # well-maintained tree, but emit a clear warning so it
                    # doesn't pass silently.
                    log.warning(
                        "Skipping duplicate bundled plugin %r at %s (already registered from %s)",
                        plugin_id, plugin_dir, kept[1] if kept else "(unknown)",
                    )
                    continue
                elif kept_is_bundled:
                    # A non-bundled (user) copy encountered after an already-kept
                    # bundled copy. Bundled always wins — discard the user copy.
                    # Store as a potential fallback: if the bundled copy later
                    # fails to load its routes, the server restores this user copy
                    # so it keeps working. Only the first user copy encountered is
                    # kept as the fallback (subsequent duplicates are dropped).
                    if plugin_id not in _pending_evictions:
                        _pending_evictions[plugin_id] = (plugin_id, plugin_dir, manifest)
                    log.warning(
                        "User-installed copy of bundled plugin %r at %s ignored; "
                        "using bundled version at %s.",
                        plugin_id, plugin_dir, kept[1] if kept else "(unknown)",
                    )
                    continue
                else:
                    log.warning("Skipping duplicate plugin %r at %s", plugin_id, plugin_dir)
                    continue
            loaded_ids.add(plugin_id)
            plugin_load_specs.append((plugin_id, plugin_dir, manifest))
            loaded_specs_by_id[plugin_id] = (plugin_id, plugin_dir, manifest)

    # Warn before loading so authors see the message even if a colliding
    # plugin's setup itself blows up later in the loop.
    _warn_on_module_collisions(
        [(plugin_id, plugin_dir) for plugin_id, plugin_dir, _ in plugin_load_specs]
    )

    # ── Instrument plugin registration ────────────────────────────────────
    if instrument_registry is not None:
        for plugin_id, plugin_dir, manifest in plugin_load_specs:
            if manifest.get("type") == "instrument":
                inst_def = manifest.get("instrument")
                if isinstance(inst_def, dict):
                    # Stamp the plugin_id so consumers can build asset URLs
                    # like /api/plugins/<plugin_id>/assets/icon.svg
                    inst_def = dict(inst_def)
                    inst_def["_plugin_id"] = plugin_id
                    # The icon lives at the manifest root, not inside "instrument"
                    if manifest.get("icon") and not inst_def.get("icon"):
                        inst_def["icon"] = manifest["icon"]
                    try:
                        instrument_registry.register(inst_def)
                    except ValueError as e:
                        log.warning(
                            "Invalid instrument definition in plugin %s: %s",
                            plugin_id, e,
                        )

    _emit_progress(
        "plugins-discovered",
        f"Discovered {len(plugin_load_specs)} plugin(s)",
        loaded=0,
        total=len(plugin_load_specs),
    )

    def _nav_entry(plugin_id: str, plugin_dir: Path, manifest: dict, order: int) -> dict:
        """Build the manifest-derived nav fields shared by a pending entry and
        a graduated (ready) entry. Carries everything /api/plugins needs to
        render the nav slot — name, nav, type, bundled flag, version, and the
        has_* capability booleans — without importing the plugin's code.
        Also carries the capability-pipelines.v1 metadata (standards,
        validated capabilities, validation warnings, compatibility shims,
        settings schema, UI contributions, runtime domains), all
        manifest-derived."""
        _validated_capabilities, _capability_validation_warnings, _capability_unsupported_versions = (
            _capability_warnings(manifest, plugin_id)
        )
        # v3 Pedalboard metadata (additive, optional). `description` is a short
        # human sentence; `icon` is an assets-relative thumbnail path. When the
        # manifest omits `icon` we auto-detect the conventional assets/thumb.png
        # so a plugin only needs to ship the file (no manifest edit) to get a
        # real pedal graphic. Both are served via the existing sandboxed
        # /api/plugins/<id>/assets/... route (safe_join guards traversal at
        # serve time), so we carry the raw path here like `styles`.
        _description = manifest.get("description")
        if not isinstance(_description, str) or not _description:
            _description = None
        _category = manifest.get("category")
        if not isinstance(_category, str) or not _category:
            _category = None
        # Settings-tab placement (tabbed settings page). When `settings` is a
        # dict, an optional `category` field names which settings tab the
        # plugin's panel mounts under (e.g. "graphics", "mic", "progression").
        # Distinct from the top-level `category` above (which drives Pedalboard
        # grouping) so the two don't collide. Absent/blank → None → the
        # frontend falls back to the generic "Plugins" tab.
        _settings_manifest = manifest.get("settings")
        _settings_category = None
        if isinstance(_settings_manifest, dict):
            _sc = _settings_manifest.get("category")
            if isinstance(_sc, str) and _sc:
                _settings_category = _sc
        _icon = manifest.get("icon")
        if not isinstance(_icon, str) or not _icon:
            _icon = None
            try:
                if (plugin_dir / "assets" / "thumb.png").is_file():
                    _icon = "assets/thumb.png"
            except OSError:
                _icon = None
        # Immersive (full-screen) screen opt-in. A plugin that declares a
        # top-level `"fullscreen": true` gets the whole content area when its
        # screen is active: the v3 shell hides the topbar and collapses the
        # sidebar to an icon rail (see static/v3/shell.js + v3.css). For
        # DAW-style plugin UIs that need the viewport, not a scrolling content
        # page. Strict `is True` so a stray truthy value can't silently opt in.
        _fullscreen = manifest.get("fullscreen") is True
        return {
            "id": plugin_id,
            "name": manifest.get("name", plugin_id),
            "nav": manifest.get("nav"),
            "type": manifest.get("type"),
            # `enabled` defaults true; the authoritative value (from persisted
            # plugin_state.json) is stamped onto this entry in the pending-seed
            # loop, before it is published or graduated (v3 Pedalboard footswitch).
            "enabled": True,
            "description": _description,
            "category": _category,
            "icon": _icon,
            "bundled": _is_bundled(plugin_dir, manifest),
            "version": manifest.get("version"),
            "has_screen": bool(manifest.get("screen")),
            "has_script": bool(manifest.get("script")),
            # Module-migration (R0): `scriptType:"module"` tells the loader to
            # inject screen.js as <script type="module">; `minHost` is the
            # min core version a migrated plugin needs (passthrough only in R0 —
            # enforcement is deferred to R4, master §4b). None when unset.
            "script_type": manifest.get("scriptType"),
            "min_host": manifest.get("minHost"),
            "has_settings": bool(manifest.get("settings")),
            "settings_category": _settings_category,
            # Drives the v3 shell's immersive (full-screen) mode for this
            # plugin's screen. False unless the manifest declares it explicitly.
            "fullscreen": _fullscreen,
            "has_tour": _is_valid_tour_manifest(manifest.get("tour")),
            # `styles` is an optional relpath (under the plugin's assets/) to a
            # compiled, preflight-off stylesheet the frontend injects as a
            # <link> so runtime-installed plugins style correctly without core
            # rescanning them at build time (Principle II). `has_styles` mirrors
            # the other manifest-only booleans; `styles` carries the path so the
            # client can build the asset URL without a second manifest read.
            "has_styles": bool(manifest.get("styles")),
            "styles": manifest.get("styles"),
            "standards": _normalize_string_list(manifest.get("standards")),
            "capabilities": _validated_capabilities,
            "capability_validation_warnings": _capability_validation_warnings,
            "capability_unsupported_versions": _capability_unsupported_versions,
            "compatibility_shims": _compatibility_shims_from_manifest(manifest, plugin_id),
            "settings_schema": _normalize_manifest_mapping(manifest.get("settings_schema")),
            "ui_contributions": _normalize_ui_contributions(manifest),
            "runtime_domains": _normalize_runtime_domains(manifest),
            "_order": order,
        }

    # Record EVERY discovered plugin as a pending "installing" nav entry up
    # front, in discovery order, so /api/plugins can render the full nav
    # immediately — before any (potentially 20-30 min) dependency install
    # runs. A plugin graduates out of here into LOADED_PLUGINS when ready;
    # on failure it stays here flipped to "failed". `_spec_order` maps each
    # kept plugin_id to its discovery index so a user-copy fallback graduating
    # after the main loop can reclaim the bundled plugin's original nav slot.
    _spec_order: dict[str, int] = {}
    # Cache each kept plugin's base nav entry so graduation can dict()-copy it
    # instead of re-deriving via _nav_entry() (which re-runs the three-part
    # _is_bundled() filesystem check and _is_valid_tour_manifest()). Besides
    # the wasted work, a second computation could disagree with the first if
    # the filesystem changed mid-load (container overlay, plugin deleted), so
    # the pending entry and the ready entry are guaranteed to describe the same
    # plugin. _order is the only mutable field and it's identical here.
    _spec_entries: dict[str, dict] = {}
    # Persisted enable/disable state (v3 Pedalboard footswitch). Loaded once,
    # OUTSIDE PLUGINS_LOCK, since it does filesystem IO. A plugin marked
    # disabled here is surfaced as an "off" pedal but never has its routes /
    # screen / nav / capabilities registered — `_disabled_ids` carries that
    # decision to the main load loop below.
    _plugin_state = _load_plugin_state()
    _disabled_ids: set[str] = set()
    with PLUGINS_LOCK:
        stale = not _is_current_generation()
        for idx, (plugin_id, plugin_dir, manifest) in enumerate(plugin_load_specs):
            _spec_order[plugin_id] = idx
            base = _nav_entry(plugin_id, plugin_dir, manifest, idx)
            # Stamp the authoritative enabled flag onto the cached base so it
            # flows to BOTH the pending entry (dict-copied below) and the ready
            # entry (dict-copied at graduation).
            enabled = _is_plugin_enabled(_plugin_state, plugin_id)
            base["enabled"] = enabled
            _spec_entries[plugin_id] = base
            # A newer load pass already owns the registries — build the local
            # caches (used by this pass's bookkeeping) but don't publish.
            if stale:
                continue
            if not enabled:
                # Disabled: publish a visible, disabled nav entry and record the
                # id so the main loop skips requirements/routes/graduation. Its
                # capabilities are suppressed at the /api/plugins boundary so a
                # disabled plugin contributes nothing to the capability pipeline.
                _disabled_ids.add(plugin_id)
                entry = dict(base)
                entry["status"] = "disabled"
                entry["error"] = None
                PENDING_PLUGINS[plugin_id] = entry
                continue
            entry = dict(base)
            entry["status"] = "installing"
            entry["error"] = None
            PENDING_PLUGINS[plugin_id] = entry

    # Track plugin_ids whose routes.setup() raised an exception, so we
    # can fall back to evicted user copies for those plugin_ids below.
    _route_failed_ids: set[str] = set()
    # Track plugin_ids whose bundled setup() timed out while already
    # running (mid-flight). For those, activating the fallback is unsafe
    # because the original setup() may still be mutating the router
    # concurrently — fallback routes would mount on top of partial bundled
    # routes, producing duplicate or conflicting endpoints.
    _route_mid_flight_ids: set[str] = set()

    def _became_disabled(pid: str) -> bool:
        """Live re-check (under PLUGINS_LOCK) whether the toggle endpoint has
        disabled this plugin AFTER the startup snapshot — e.g. while a slow
        earlier plugin (or this plugin's own requirements) was still installing.
        If so, flip its pending entry to "disabled" and report it so the loader
        skips the mount. Called both before install and again right before route
        setup so a disable that lands anywhere before mounting — including during
        a slow pip install — actually prevents the mount (rather than mounting
        and only suppressing post-graduation).

        The residual race is narrow and inherent: a disable arriving AFTER the
        final check but during the route-module import (exec_module) or its
        setup() call still mounts. That window is sub-second and cannot be closed
        without holding PLUGINS_LOCK across third-party plugin code (setup() may
        call back into lock-taking host APIs like register_library_provider, so
        holding it there risks deadlock). Such a plugin still graduates carrying
        enabled=False (see _graduate) — capabilities suppressed, nav hidden — and
        its routes stay until the next restart, per the documented runtime
        semantics.

        Reads BOTH the persisted state and the in-memory pending flag: the
        toggle endpoint writes plugin_state.json BEFORE it flips the in-memory
        flag, so a disable can be on disk a hair before it is in memory.
        Consulting the durable on-disk state (the source of truth on restart)
        closes that tiny persist-then-flip window without holding a lock across
        file IO. _is_plugin_enabled() also keeps always-on plugins immune."""
        persisted_off = not _is_plugin_enabled(_load_plugin_state(), pid)
        with PLUGINS_LOCK:
            _p = PENDING_PLUGINS.get(pid)
            if _p is None:
                return False
            if persisted_off or _p.get("enabled") is False:
                _p["status"] = "disabled"
                _p["enabled"] = False
                _p["error"] = None
                return True
        return False

    for idx, (plugin_id, plugin_dir, manifest) in enumerate(plugin_load_specs):
        # Persisted as disabled (v3 Pedalboard footswitch): leave it in
        # PENDING_PLUGINS as a visible "off" pedal and register NOTHING — no
        # requirements, no routes.setup(), no screen/nav, no capabilities.
        # Re-enabling takes full effect on the next restart.
        if plugin_id in _disabled_ids:
            continue
        # Honor a runtime disable that landed before this plugin's iteration
        # (skips a potentially long pip install entirely).
        if _became_disabled(plugin_id):
            _disabled_ids.add(plugin_id)
            continue
        _emit_progress(
            "plugin-start",
            f"Loading plugin '{plugin_id}'",
            plugin_id=plugin_id,
            # Report the ready-plugin count, not the loop index: `loaded` means
            # "ready plugins" everywhere else, so emitting idx here would let
            # /api/startup-status jump backwards (idx 3 → _loaded_count() 1)
            # mid-run and break the implied monotonic counter.
            loaded=_loaded_count(),
            total=len(plugin_load_specs),
        )

        # Install plugin requirements if present
        _emit_progress(
            "plugin-requirements",
            f"Installing requirements for '{plugin_id}' (if needed)",
            plugin_id=plugin_id,
            loaded=_loaded_count(),
            total=len(plugin_load_specs),
        )
        req_ok = _install_requirements(plugin_dir, plugin_id)
        if not req_ok:
            # Non-fatal: a pip failure may just mean an OPTIONAL dependency
            # couldn't be installed (read-only filesystem, an extra a plugin
            # degrades gracefully without). We surface the error but still try
            # to load routes. If the plugin genuinely needs the missing dep its
            # routes will fail to import below and it becomes "failed" there —
            # so a real install failure still surfaces as a visible, disabled
            # nav entry (ADR 0001) without disabling plugins that work anyway.
            _emit_progress(
                "plugin-error",
                f"Failed to install requirements for '{plugin_id}'",
                plugin_id=plugin_id,
                loaded=_loaded_count(),
                total=len(plugin_load_specs),
                error="Requirements installation failed; check server logs for details",
            )

        # Authoritative final re-check: a disable may have landed WHILE this
        # plugin's own requirements were installing (the install above can be
        # slow). This is the last point before we touch sys.path / import the
        # routes module / run setup(), so honoring it here means a disable that
        # arrives any time before route setup truly prevents the mount.
        if _became_disabled(plugin_id):
            _disabled_ids.add(plugin_id)
            continue

        # Add plugin directory to sys.path so the plugin's bare
        # `import sibling` keeps working during the feedBack#33
        # transition. New plugins should prefer
        # `context['load_sibling']('sibling')` instead — see
        # CLAUDE.md / Plugin System / Backend routes.
        plugin_dir_str = str(plugin_dir)
        if plugin_dir_str not in sys.path:
            sys.path.insert(0, plugin_dir_str)

        # Build a per-plugin context: dict-copy the shared mapping
        # so plugin A re-binding `ctx['x']` doesn't leak into plugin
        # B's view, then add a `load_sibling` closure scoped to THIS
        # plugin's id + dir. (Note: the COPY is shallow — values
        # stored in context are still the same objects across
        # plugins, so e.g. `ctx['meta_db']` mutations are still
        # observable everywhere by design.) The helper namespaces
        # sibling modules as `plugin_<id>.<name>` (with plugin_id
        # bijectively encoded by _safe_plugin_id_for_module_name:
        # `_` -> `_5f_`, `.` -> `_2e_`) so two plugins shipping the
        # same filename get distinct cached modules. See
        # feedBack#33.
        plugin_context = dict(context)
        plugin_context["load_sibling"] = (
            lambda name, _pid=plugin_id, _pdir=plugin_dir:
                _load_plugin_sibling(_pid, _pdir, name)
        )
        plugin_context["log"] = logging.getLogger(f"feedBack.plugin.{plugin_id}")
        if callable(plugin_context.get("register_library_provider")):
            _register_library_provider = plugin_context["register_library_provider"]

            def _register_scoped_library_provider(provider, *args, _pid=plugin_id, _base=_register_library_provider, **kwargs):
                # Force (not setdefault) the owner attribution to the loading
                # plugin: owner_plugin_id drives provider attribution and the
                # library capability participant id, so a plugin must not be
                # able to pass a forged value and impersonate another plugin.
                kwargs["owner_plugin_id"] = _pid
                return _base(provider, *args, **kwargs)

            plugin_context["register_library_provider"] = _register_scoped_library_provider

        # Load routes using importlib to avoid module name collisions.
        # `route_ok` gates graduation: only a plugin that installs AND
        # registers its routes cleanly becomes ready. A route failure leaves
        # it "failed" in PENDING_PLUGINS (the fallback block below may still
        # graduate a user-copy for an evicted bundled plugin).
        route_ok = True
        routes_file = manifest.get("routes")
        if routes_file:
            _emit_progress(
                "plugin-routes",
                f"Loading routes for '{plugin_id}'",
                plugin_id=plugin_id,
                loaded=_loaded_count(),
                total=len(plugin_load_specs),
            )
            # Capture the current route count so we can detect whether
            # setup() registered any handlers before raising. FastAPI has
            # no route-removal API, so partial registration is permanent.
            _routes_before = len(getattr(app, "routes", []))
            try:
                # Escape `.` in plugin_id the same way load_sibling
                # does. Without it, a plugin id like
                # `com.example.foo` would land at
                # `plugin_com.example.foo_routes` — which Python
                # parses as a dotted module path, sets
                # `__package__` to `plugin_com.example`, and breaks
                # any relative imports inside routes.py. Spotted by
                # Copilot review on PR #105 round 2.
                module_name = f"plugin_{_safe_plugin_id_for_module_name(plugin_id)}_routes"
                spec = importlib.util.spec_from_file_location(
                    module_name, str(plugin_dir / routes_file))
                routes_module = importlib.util.module_from_spec(spec)
                sys.modules[module_name] = routes_module
                spec.loader.exec_module(routes_module)
                if hasattr(routes_module, "setup"):
                    if route_setup_fn is not None:
                        # Bind routes_module and plugin_context by value so
                        # the callable is safe regardless of when/how
                        # route_setup_fn dispatches it — avoids late-binding
                        # closure bugs if the caller defers execution.
                        _fn = lambda rm=routes_module, ctx=plugin_context: rm.setup(app, ctx)
                        _fn._plugin_id = plugin_id
                        route_setup_fn(_fn)
                    else:
                        routes_module.setup(app, plugin_context)
                    log.info("Loaded routes for plugin %r", plugin_id)
            except Exception as e:
                log.exception("Failed to load routes for plugin %r", plugin_id)
                route_ok = False
                _route_failed_ids.add(plugin_id)
                # If this was a mid-flight timeout, mark the plugin so the
                # fallback block skips it — the original setup() may still be
                # running and registering routes concurrently; mounting a
                # fallback on top would produce duplicate/conflicting endpoints.
                if getattr(e, "setup_mid_flight", False):
                    _route_mid_flight_ids.add(plugin_id)
                # Detect partial route registration: if setup() mounted any
                # handlers before raising, those routes stay permanently (no
                # FastAPI deregistration API). Warn loudly so maintainers can
                # identify conflicting endpoints in the server log.
                _routes_after = len(getattr(app, "routes", []))
                if _routes_after > _routes_before:
                    log.warning(
                        "Plugin %r registered %d route(s) before its setup() raised; "
                        "these handlers cannot be removed and may conflict with any fallback.",
                        plugin_id, _routes_after - _routes_before,
                    )
                # Compute bare-import modules added during the failed load.
                # IMPORTANT: Filter strictly to modules whose __file__ lives
                # inside this plugin's directory — the naive set-diff would
                # capture every module imported by any concurrent thread
                # (metadata scan, stdlib lazy imports, etc.) between the
                # snapshot and the failure, causing the fallback block to
                # delete unrelated entries from sys.modules.
                # Purge them NOW (not deferred) so subsequent plugins in the
                # main loop don't accidentally resolve this plugin's helpers
                # when they do bare `import helper`.  The fallback block's
                # per-key pop() is a harmless no-op when the keys are already
                # absent.
                if plugin_id in _pending_evictions:
                    _plugin_dir_prefix = str(plugin_dir) + os.sep
                    _stale = set()
                    # Scan ALL cached modules (not only those newly added since
                    # the snapshot) for any whose __file__ lives inside this
                    # plugin's directory.  A previous load_plugins() call (test
                    # reload, dev restart) may have left same-named helpers from
                    # the bundled copy in sys.modules before this run's
                    # snapshot was taken; diffing against the snapshot alone
                    # would miss those and let the fallback copy resolve the
                    # old bundled code on repeated loads.
                    for _k, _mod in list(sys.modules.items()):
                        _mf = getattr(_mod, "__file__", None)
                        if _mf and str(_mf).startswith(_plugin_dir_prefix):
                            _stale.add(_k)
                    _pending_eviction_stale_modules[plugin_id] = _stale
                    # Purge immediately to prevent module leakage into later plugins.
                    for _k in _stale:
                        sys.modules.pop(_k, None)
                # str(e) is empty for common no-arg exceptions (e.g.
                # concurrent.futures.TimeoutError()), which would leave the
                # plugin "failed" but with a blank tooltip in /api/plugins and a
                # blank startup-status error. Fall back to repr(e) so the error
                # text is always non-empty and identifies the failure type.
                _err_text = str(e) or repr(e)
                _mark_failed(plugin_id, _err_text)
                _emit_progress(
                    "plugin-error",
                    f"Failed loading routes for '{plugin_id}'",
                    plugin_id=plugin_id,
                    loaded=_loaded_count(),
                    total=len(plugin_load_specs),
                    error=_err_text,
                )

        if not route_ok:
            # Not ready: leave it "failed" in PENDING_PLUGINS so it shows as a
            # disabled nav entry. If it's a bundled plugin that evicted a user
            # copy, the fallback block below may still graduate that copy.
            continue

        # Graduate: dependencies are installed and routes registered, so the
        # plugin is ready. Publish it incrementally — readers (and the SSE
        # `plugin-registered` event that drives the frontend re-fetch) see it
        # the moment it's usable, not when the slowest sibling finishes.
        # Reuse the base nav entry computed during discovery rather than
        # re-deriving it, so the ready entry can't disagree with the pending
        # one (see _spec_entries).
        loaded_entry = dict(_spec_entries[plugin_id])
        loaded_entry.update({
            "status": "ready",
            # Normalized list of relpaths under CONFIG_DIR that this
            # plugin opts in to settings export/import. Empty for
            # plugins that don't declare `settings.server_files`. See
            # feedBack#113.
            "_export_paths": _normalize_export_paths(manifest.get("settings"), plugin_id),
            # Diagnostics opt-in (feedBack#166): same allowlist semantics
            # as `_export_paths` but for the troubleshooting bundle.
            "_diagnostics_paths": _normalize_diagnostics_paths(manifest.get("diagnostics"), plugin_id),
            "_diagnostics_callable_spec": _parse_diagnostics_callable(manifest.get("diagnostics"), plugin_id),
            "_load_sibling": plugin_context["load_sibling"],
            "_dir": plugin_dir,
            "_manifest": manifest,
        })
        _new_count = _graduate(loaded_entry)
        log.info("Registered plugin %r (%s)", plugin_id, manifest.get("name", ""))
        _emit_progress(
            "plugin-registered",
            f"Registered plugin '{plugin_id}'",
            plugin_id=plugin_id,
            loaded=_new_count,
            total=len(plugin_load_specs),
        )

    # If any bundled plugin failed to load its routes AND it evicted a
    # user-installed copy during discovery, fall back to that user copy so
    # the server remains functional. A bad bundled release should never
    # leave the plugin completely broken when a working user copy exists.
    #
    # NOTE on partial-registration: if the bundled setup() managed to register
    # some FastAPI routes before raising, those handlers stay permanently (no
    # route-removal API). The partial-registration warning above names the
    # count; the fallback copy's routes then mount alongside them, so duplicate
    # or conflicting endpoints are possible. This is an accepted limitation;
    # the primary mitigation is thorough testing of bundled releases.
    #
    # NOTE on timeout race: in async mode the bundled setup() runs on the
    # event-loop thread via route_setup_fn. If it times out (>60 s) while
    # setup() has ALREADY STARTED executing, `_route_mid_flight_ids` is set
    # for that plugin and the fallback is skipped — the original setup() may
    # still be mutating the router concurrently and mounting a second set of
    # routes on top would produce duplicate/conflicting endpoints. The
    # mid-flight case is detected by the `setup_mid_flight` attribute on the
    # TimeoutError re-raised by _route_setup_on_main (server.py).
    # If the timeout fires BEFORE _do() has started, the _cancelled flag
    # in _route_setup_on_main prevents the queued callback from executing,
    # making the fallback safe in that case.
    for evicted_id, evicted_spec in _pending_evictions.items():
        if evicted_id not in _route_failed_ids:
            continue
        if evicted_id in _route_mid_flight_ids:
            log.warning(
                "Skipping fallback for %r: bundled setup() timed out while already "
                "executing; the router may have partial routes from the bundled copy. "
                "Restart the server to recover.",
                evicted_id,
            )
            # The broken bundled plugin never graduated (route_ok was False),
            # so there is nothing to remove from LOADED_PLUGINS; it stays a
            # "failed" pending entry until a restart recovers it.
            continue
        _ev_id, ev_dir, ev_manifest = evicted_spec
        # Honor a runtime disable before doing any fallback work (mirrors the
        # main load loop's _became_disabled checks). A disable that lands before
        # the fallback copy mounts must prevent the mount — and skip its install —
        # not just suppress it post-graduation.
        if _became_disabled(evicted_id):
            _disabled_ids.add(evicted_id)
            continue
        log.warning(
            "Bundled plugin %r failed to load routes; "
            "falling back to user-installed copy at %s.",
            evicted_id, ev_dir,
        )
        # The fallback reclaims the bundled plugin's original discovery slot so
        # /api/plugins order (and the frontend playSong wrapper chain) is
        # preserved. The broken bundled copy never graduated, so we just
        # graduate the user copy at the bundled plugin's `_order`.
        _bundled_orig_order = _spec_order.get(evicted_id, len(plugin_load_specs))
        # Ensure the fallback directory is at the FRONT of sys.path so
        # its modules take priority over any bundled copy still present.
        # Simply inserting when absent is not enough: on repeated
        # load_plugins() calls (tests, dev reloads) the user-copy dir may
        # already be in sys.path but behind the bundled dir from an earlier
        # run, letting bare imports in the fallback still resolve bundled
        # files. Always remove-then-reinsert to guarantee front-of-path.
        ev_dir_str = str(ev_dir)
        if ev_dir_str in sys.path:
            sys.path.remove(ev_dir_str)
        sys.path.insert(0, ev_dir_str)
        ev_context = dict(context)
        ev_context["load_sibling"] = (
            lambda name, _pid=evicted_id, _pdir=ev_dir:
                _load_plugin_sibling(_pid, _pdir, name)
        )
        ev_context["log"] = logging.getLogger(f"feedBack.plugin.{evicted_id}")
        if callable(ev_context.get("register_library_provider")):
            _ev_register_library_provider = ev_context["register_library_provider"]

            def _register_scoped_fallback_library_provider(provider, *args, _pid=evicted_id, _base=_ev_register_library_provider, **kwargs):
                # Force owner attribution to the loading plugin — see the main
                # context wrapper above; a forged owner_plugin_id must not be
                # able to misattribute providers or collide with another id.
                kwargs["owner_plugin_id"] = _pid
                return _base(provider, *args, **kwargs)

            ev_context["register_library_provider"] = _register_scoped_fallback_library_provider
        # Install the fallback copy's requirements. It was evicted before
        # the main load loop ran, so _install_requirements was never called
        # for it. A user copy that depends on extra packages would otherwise
        # fail with an import error even when those packages can be installed.
        # Mirror the main load-loop contract: _install_requirements returning
        # False is *non-fatal* (read-only filesystem, optional dep, etc.) —
        # we emit a plugin-error and continue loading, exactly as the main
        # loop does. Treating it as fatal here would break the fallback for
        # those same tolerated cases and leave the bundled-failure error
        # unresolved.
        ev_req_ok = _install_requirements(ev_dir, evicted_id)
        if not ev_req_ok:
            _emit_progress(
                "plugin-error",
                f"Failed to install requirements for fallback copy of '{evicted_id}'",
                plugin_id=evicted_id,
                loaded=_loaded_count(),
                total=len(plugin_load_specs),
                error="Requirements installation failed for fallback copy; check server logs",
            )
        # Purge any sibling modules the failed bundled copy may have loaded.
        # They are cached under the same namespace as what the fallback would use.
        # The parent package is `plugin_{safe_id}`, sibling modules are
        # `plugin_{safe_id}.{name}` (from load_sibling), and the routes module is
        # `plugin_{safe_id}_routes` (note the underscore). Clearing all three
        # patterns ensures the fallback gets a clean slate and doesn't accidentally
        # resolve bundled helper code that is still cached in sys.modules.
        _safe_eid = _safe_plugin_id_for_module_name(evicted_id)
        _parent_pkg = f"plugin_{_safe_eid}"
        # The routes module is registered under exactly `{_parent_pkg}_routes`
        # (underscore, not dot — it is NOT a sub-package of _parent_pkg).
        # Using startswith(f"{_parent_pkg}_") would incorrectly match
        # "plugin_a_5f_b_routes" (routes for plugin "a_b") when evicting
        # plugin "a", because "plugin_a_5f_b_routes".startswith("plugin_a_")
        # is True. Match the routes entry exactly instead.
        _stale_sibling_keys = [
            k for k in list(sys.modules)
            if k == _parent_pkg
            or k.startswith(f"{_parent_pkg}.")
            or k == f"{_parent_pkg}_routes"
        ]
        for _k in _stale_sibling_keys:
            del sys.modules[_k]
        # Also purge bare-import modules the failed bundled copy may have added
        # to sys.modules. These are NOT covered by the namespaced purge above;
        # a bundled plugin that does `import helper` (bare import via sys.path)
        # would otherwise leave a stale `helper` module in sys.modules that
        # the fallback copy could accidentally resolve instead of its own file.
        for _k in _pending_eviction_stale_modules.get(evicted_id, set()):
            sys.modules.pop(_k, None)
        # Final live re-check before importing/mounting the fallback's routes —
        # its requirements install above can be slow, so a disable may have
        # arrived in the meantime. (Same residual exec_module()/setup() window
        # applies as on the main path.)
        if _became_disabled(evicted_id):
            _disabled_ids.add(evicted_id)
            continue
        # Re-load the fallback's routes using the same module-name slot so
        # it naturally replaces the previously-failed bundled module.
        ev_routes_file = ev_manifest.get("routes")
        # If the user copy has no routes file it cannot restore the bundled
        # plugin's backend endpoints (the route failure is the very reason we
        # are in this fallback path). Treat that as a failed recovery so the
        # bundled-failure error is NOT cleared from startup-status.
        fallback_routes_ok = bool(ev_routes_file)
        if ev_routes_file:
            # Capture route count before fallback setup() to detect partial
            # registration — same permanent-mount limitation as the main loop.
            _fallback_routes_before = len(getattr(app, "routes", []))
            try:
                ev_module_name = f"plugin_{_safe_plugin_id_for_module_name(evicted_id)}_routes"
                ev_spec = importlib.util.spec_from_file_location(
                    ev_module_name, str(ev_dir / ev_routes_file))
                ev_routes_module = importlib.util.module_from_spec(ev_spec)
                sys.modules[ev_module_name] = ev_routes_module
                ev_spec.loader.exec_module(ev_routes_module)
                if hasattr(ev_routes_module, "setup"):
                    if route_setup_fn is not None:
                        _fn = lambda rm=ev_routes_module, ctx=ev_context, a=app: rm.setup(a, ctx)
                        _fn._plugin_id = evicted_id
                        route_setup_fn(_fn)
                    else:
                        ev_routes_module.setup(app, ev_context)
                log.info("Loaded routes for fallback copy of plugin %r", evicted_id)
            except Exception:
                log.exception(
                    "Fallback user-installed copy of %r also failed to load routes; "
                    "plugin unavailable (not registered).", evicted_id,
                )
                # Update the failed pending entry + emit a plugin-error so both
                # /api/plugins and startup-status reflect the fallback's failure
                # as the root cause, not the earlier bundled-copy error. Without
                # this the status stays on the stale bundled error even though
                # that's no longer the active failure.
                _both_failed_err = (
                    f"Both bundled and user-installed copies of '{evicted_id}' "
                    "failed to load routes; plugin unavailable — check server logs"
                )
                _mark_failed(evicted_id, _both_failed_err)
                _emit_progress(
                    "plugin-error",
                    f"Fallback copy of plugin '{evicted_id}' also failed to load routes",
                    plugin_id=evicted_id,
                    loaded=_loaded_count(),
                    total=len(plugin_load_specs),
                    error=_both_failed_err,
                )
                # Warn on partial registration in the fallback path too.
                _fallback_routes_after = len(getattr(app, "routes", []))
                if _fallback_routes_after > _fallback_routes_before:
                    log.warning(
                        "Fallback copy of %r registered %d route(s) before its setup() raised; "
                        "these handlers cannot be removed.",
                        evicted_id, _fallback_routes_after - _fallback_routes_before,
                    )
                fallback_routes_ok = False
        if fallback_routes_ok:
            ev_entry = dict(_nav_entry(evicted_id, ev_dir, ev_manifest, _bundled_orig_order))
            ev_entry.update({
                "status": "ready",
                # _nav_entry already sets bundled=False for a user copy
                # (not in PLUGINS_DIR); mark it as the emergency fallback so
                # /api/plugins and the settings UI can warn that the bundled
                # build is broken and an older user copy is running.
                "fallback": True,
                # Capability metadata (standards, capabilities, shims,
                # settings_schema, ui_contributions, runtime_domains) and the
                # has_* booleans are already carried by _nav_entry() above.
                "_export_paths": _normalize_export_paths(ev_manifest.get("settings"), evicted_id),
                "_diagnostics_paths": _normalize_diagnostics_paths(ev_manifest.get("diagnostics"), evicted_id),
                "_diagnostics_callable_spec": _parse_diagnostics_callable(ev_manifest.get("diagnostics"), evicted_id),
                "_load_sibling": ev_context["load_sibling"],
                "_dir": ev_dir,
                "_manifest": ev_manifest,
            })
            _graduate(ev_entry)
            log.info("Registered fallback user copy of plugin %r (%s)", evicted_id, ev_manifest.get("name", ""))
            # Emit a compensating progress event to clear the bundled-failure
            # error from startup-status. Without this, the final
            # `plugins-complete` status would still carry the error text from
            # the bundled failure even though the plugin is now active via the
            # fallback copy. Uses clear_error=True so the server handler
            # replaces the stale error with null rather than ignoring it.
            # Only send clear_error when req install also succeeded; if req
            # failed we emitted a plugin-error above and must not clear it —
            # the fallback copy is active but degraded (missing dependencies).
            _emit_progress(
                "plugin-registered",
                f"Registered fallback copy of plugin '{evicted_id}'",
                plugin_id=evicted_id,
                loaded=_loaded_count(),
                total=len(plugin_load_specs),
                clear_error=ev_req_ok,
            )

    # No final atomic publish: plugins were published incrementally as they
    # graduated (see _graduate). LOADED_PLUGINS now holds exactly the ready
    # plugins; any that failed remain visible as "failed" pending entries.
    _emit_progress(
        "plugins-complete",
        f"Loaded {_loaded_count()} plugin(s)",
        loaded=_loaded_count(),
        total=len(plugin_load_specs),
    )


def _check_plugin_update(plugin_dir: Path) -> dict | None:
    """Check if a plugin's git repo has updates available."""
    git_dir = plugin_dir / ".git"
    if not git_dir.exists():
        return None
    try:
        # Fetch latest from remote (quick, refs only)
        subprocess.run(
            ["git", "fetch", "--quiet"],
            cwd=str(plugin_dir), capture_output=True, timeout=15,
        )
        # Compare local HEAD with remote tracking branch
        result = subprocess.run(
            ["git", "rev-list", "HEAD..@{u}", "--count"],
            cwd=str(plugin_dir), capture_output=True, text=True, timeout=10,
        )
        if result.returncode != 0:
            return None
        behind = int(result.stdout.strip())
        # Get current and remote commit hashes
        local = subprocess.run(
            ["git", "rev-parse", "--short", "HEAD"],
            cwd=str(plugin_dir), capture_output=True, text=True, timeout=5,
        ).stdout.strip()
        remote = subprocess.run(
            ["git", "rev-parse", "--short", "@{u}"],
            cwd=str(plugin_dir), capture_output=True, text=True, timeout=5,
        ).stdout.strip()
        return {"behind": behind, "local": local, "remote": remote}
    except Exception:
        return None


def register_plugin_api(app: FastAPI):
    """Register the plugin discovery API endpoints."""

    @app.get("/api/plugins")
    def list_plugins():
        # Return the UNION of ready (LOADED_PLUGINS) and not-yet-ready
        # (PENDING_PLUGINS) plugins, each carrying a `status` so the nav can
        # render every discovered plugin immediately — ready ones active,
        # installing/failed ones disabled — instead of waiting for the
        # slowest dependency install (issue #421). Rows are re-sorted by their
        # discovery order so the nav slot of a still-installing plugin sits
        # where it will land once ready, regardless of which structure it's in.
        with PLUGINS_LOCK:
            loaded = list(LOADED_PLUGINS)
            pending = list(PENDING_PLUGINS.values())
        rows: list[tuple] = []
        for p in loaded:
            rows.append((p.get("_order", 0), {
                "id": p["id"],
                "name": p["name"],
                # Surface the manifest's `version` field (free-form
                # semver string) so diagnostics bundles + the future
                # plugin marketplace can identify exactly which build
                # is loaded. None when the plugin omits the field.
                "version": (p.get("_manifest") or {}).get("version"),
                "nav": p["nav"],
                # type is None for plugins without the manifest hint —
                # frontend filters like "give me all type=visualization"
                # work via identity comparison; absent is treated as
                # "no declared role".
                "type": p.get("type"),
                # v3 Pedalboard footswitch state. `.get(..., True)` keeps stubbed
                # test entries (and any pre-feature entry) enabled by default;
                # capabilities are suppressed below when this is False.
                "enabled": p.get("enabled", True),
                # v3 Pedalboard metadata (carried from _nav_entry; `.get()`
                # fallbacks keep stubbed test entries working). `icon` was
                # resolved at discovery (manifest or assets/thumb.png probe).
                "description": p.get("description") if "description" in p else ((p.get("_manifest") or {}).get("description") or None),
                "category": p.get("category") if "category" in p else ((p.get("_manifest") or {}).get("category") or None),
                "icon": p.get("icon") if "icon" in p else ((p.get("_manifest") or {}).get("icon") or None),
                # `bundled` is reserved metadata flagging plugins that
                # ship with the default container image (feedBack#160).
                # Surfaced in /api/plugins so the plugin-list UI can
                # render a "Bundled" badge (lock icon) next to the
                # plugin name in the settings collapsible.
                "bundled": p.get("bundled", False),
                # `fallback` is True only for user-installed copies that
                # are active because the bundled plugin's routes failed.
                # Surfaced in /api/plugins so the settings UI can show
                # a warning badge, letting users know the bundled build
                # is broken and they are running an older user copy.
                "fallback": p.get("fallback", False),
                "has_screen": p["has_screen"],
                "has_script": p["has_script"],
                # Module-migration passthrough (R0). Re-read from the manifest
                # like `version` above so stubbed test entries (built without
                # _nav_entry) don't need the key.
                "script_type": (p.get("_manifest") or {}).get("scriptType"),
                "min_host": (p.get("_manifest") or {}).get("minHost"),
                "has_settings": p["has_settings"],
                # v3 immersive screen opt-in (full-screen plugin UI).
                "fullscreen": p.get("fullscreen", False),
                # Settings-tab placement; None when the manifest's `settings`
                # is absent, a bare string, or omits `category`.
                "settings_category": p.get("settings_category"),
                "has_tour": p.get("has_tour", False),
                # `.get()` fallbacks keep stubbed test entries (built without
                # _nav_entry) working — styles is None when unset.
                "has_styles": p.get("has_styles", False),
                "styles": p.get("styles"),
                # capability-pipelines.v1 metadata, computed once by
                # _nav_entry() at discovery and carried through graduation.
                # The `.get()` fallbacks keep stubbed test entries (which build
                # rows directly without going through _nav_entry) working.
                "standards": p.get("standards") or _normalize_string_list((p.get("_manifest") or {}).get("standards")),
                "capabilities": p["capabilities"] if "capabilities" in p else _normalize_manifest_mapping((p.get("_manifest") or {}).get("capabilities")),
                "capability_validation_warnings": p.get("capability_validation_warnings", []),
                "capability_unsupported_versions": p.get("capability_unsupported_versions", []),
                "compatibility_shims": p.get("compatibility_shims", _compatibility_shims_from_manifest(p.get("_manifest") or {}, p.get("id", "plugin"))),
                # Check key presence (not truthiness) like `capabilities` above:
                # the loader may intentionally set these to an empty dict after
                # validation/sanitization, and a truthiness `or` would wrongly
                # re-derive legacy/runtime-domain data from the raw manifest.
                "settings_schema": p["settings_schema"] if "settings_schema" in p else _normalize_manifest_mapping((p.get("_manifest") or {}).get("settings_schema")),
                "ui_contributions": p["ui_contributions"] if "ui_contributions" in p else _normalize_ui_contributions(p.get("_manifest") or {}),
                "runtime_domains": p["runtime_domains"] if "runtime_domains" in p else _normalize_runtime_domains(p.get("_manifest") or {}),
                # Anything in LOADED_PLUGINS is ready by construction.
                "status": "ready",
                "error": None,
            }))
        for e in pending:
            rows.append((e.get("_order", 0), {
                "id": e["id"],
                "name": e["name"],
                "version": e.get("version"),
                "nav": e.get("nav"),
                "type": e.get("type"),
                # v3 Pedalboard footswitch state — a startup-disabled plugin sits
                # in PENDING_PLUGINS with status "disabled"; capabilities are
                # suppressed below when this is False.
                "enabled": e.get("enabled", True),
                # v3 Pedalboard metadata — pending entries come from _nav_entry
                # too, so they already carry these.
                "description": e.get("description"),
                "category": e.get("category"),
                "icon": e.get("icon"),
                "bundled": e.get("bundled", False),
                # A pending plugin is never an active fallback (the fallback
                # only exists once a user copy has graduated to ready).
                "fallback": False,
                "has_screen": e.get("has_screen", False),
                "has_script": e.get("has_script", False),
                # Pending entries come from _nav_entry, so they carry these.
                "script_type": e.get("script_type"),
                "min_host": e.get("min_host"),
                "has_settings": e.get("has_settings", False),
                "settings_category": e.get("settings_category"),
                "fullscreen": e.get("fullscreen", False),
                "has_tour": e.get("has_tour", False),
                "has_styles": e.get("has_styles", False),
                "styles": e.get("styles"),
                # Pending entries are built from _nav_entry() too, so they
                # carry the same capability-pipelines.v1 metadata — surface it
                # so the Inspector can show still-installing plugins.
                "standards": e.get("standards", []),
                "capabilities": e.get("capabilities", {}),
                "capability_validation_warnings": e.get("capability_validation_warnings", []),
                "capability_unsupported_versions": e.get("capability_unsupported_versions", []),
                "compatibility_shims": e.get("compatibility_shims", []),
                "settings_schema": e.get("settings_schema", {}),
                "ui_contributions": e.get("ui_contributions", {}),
                "runtime_domains": e.get("runtime_domains", {}),
                # "installing" while its deps install; "failed" if the install
                # or route load failed (the nav entry stays, disabled, with
                # the error text in `error`).
                "status": e.get("status", "installing"),
                "error": e.get("error"),
            }))
        # Stable sort by discovery order. Stubbed test entries default to 0 and
        # keep their insertion order (loaded before pending) under a stable sort.
        rows.sort(key=lambda r: r[0])
        # Final pass: a disabled plugin (startup-skipped or runtime-toggled-off)
        # must not occupy the capability pipeline graph.
        return [_suppress_capabilities_for_disabled(row) for _, row in rows]

    @app.get("/api/plugins/updates")
    def check_updates():
        """Check all plugins for available git updates."""
        with PLUGINS_LOCK:
            snapshot = list(LOADED_PLUGINS)
        updates = {}
        for p in snapshot:
            info = _check_plugin_update(p["_dir"])
            if info and info["behind"] > 0:
                updates[p["id"]] = {
                    "name": p["name"],
                    "behind": info["behind"],
                    "local": info["local"],
                    "remote": info["remote"],
                }
        return {"updates": updates}

    @app.post("/api/plugins/{plugin_id}/update")
    def update_plugin(plugin_id: str):
        """Pull latest changes for a plugin. Stashes local edits first."""
        with PLUGINS_LOCK:
            snapshot = list(LOADED_PLUGINS)
        for p in snapshot:
            if p["id"] == plugin_id:
                if p.get("status", "ready") != "ready":
                    break
                git_dir = p["_dir"] / ".git"
                if not git_dir.exists():
                    return {"error": "Not a git repository"}
                cwd = str(p["_dir"])
                try:
                    # Stash any local modifications so pull doesn't fail
                    subprocess.run(
                        ["git", "stash", "--quiet"],
                        cwd=cwd, capture_output=True, timeout=10,
                    )
                    result = subprocess.run(
                        ["git", "pull", "--ff-only"],
                        cwd=cwd, capture_output=True, text=True, timeout=30,
                    )
                    if result.returncode != 0:
                        # Restore stash on failure
                        subprocess.run(
                            ["git", "stash", "pop", "--quiet"],
                            cwd=cwd, capture_output=True, timeout=10,
                        )
                        return {"error": result.stderr[:500]}
                    return {"ok": True, "message": result.stdout.strip()}
                except Exception as e:
                    return {"error": str(e)}
        return {"error": "Plugin not found"}

    @app.post("/api/plugins/{plugin_id}/enabled")
    async def set_plugin_enabled(plugin_id: str, request: Request):
        """Enable or disable a plugin (v3 Pedalboard footswitch).

        Body: ``{"enabled": <bool>}``. Returns ``{"id", "enabled"}``.

        Runtime semantics: the choice is persisted to
        ``CONFIG_DIR/plugin_state.json`` immediately and the in-memory entry's
        `enabled` flag is flipped so the very next ``/api/plugins`` (and thus the
        nav, the Pedalboard, and the capability pipeline) reflects it at once. A
        plugin disabled at runtime keeps its already-mounted routes/screen until
        the next restart — full hot-unload is out of scope; the frontend treats
        ``enabled: false`` as "off" regardless. Re-enabling a plugin that was
        skipped at startup updates the flag immediately but the plugin only
        actually mounts on the next restart.
        """
        # Async handler (unlike the sync handlers around it) so we can await the
        # raw JSON body — this file has no Pydantic models and we want explicit
        # 400/404 status codes rather than FastAPI's 422 validation envelope.
        try:
            data = await request.json()
        except Exception:
            data = None
        if not isinstance(data, dict) or "enabled" not in data or not isinstance(data["enabled"], bool):
            # `bool` is an `int` subclass, so isinstance(..., bool) is required to
            # reject 0/1/ints/strings and demand a real boolean.
            return JSONResponse({"error": "Body must include boolean 'enabled'"}, status_code=400)
        enabled = data["enabled"]

        # The plugin must exist (ready or pending) to be toggled. Checked BEFORE
        # the always-on guard so an unknown id always 404s regardless of how it
        # is spelled (an unknown `app_tour_*` id is "not found", not "cannot be
        # disabled").
        with PLUGINS_LOCK:
            known = any(p["id"] == plugin_id for p in LOADED_PLUGINS) or plugin_id in PENDING_PLUGINS
        if not known:
            return JSONResponse({"error": "Plugin not found"}, status_code=404)

        # Guard rail: a small always-on set may never be disabled (disabling
        # would brick the app or the capability-graph review surface).
        if not enabled and _is_always_enabled(plugin_id):
            return JSONResponse(
                {"error": f"Plugin '{plugin_id}' cannot be disabled"},
                status_code=400,
            )

        # Persist first; only flip the in-memory flag if the write succeeded so
        # memory and disk never diverge. A write failure (unwritable CONFIG_DIR,
        # disk full, replace failure) is a controlled 500, not an uncaught crash.
        try:
            _persist_plugin_enabled(plugin_id, enabled)
        except OSError as e:
            log.warning("Could not persist plugin state for %r: %s", plugin_id, e)
            return JSONResponse(
                {"error": "Could not persist plugin state"}, status_code=500
            )

        # Flip the in-memory flag so the next /api/plugins reflects the change
        # without a restart (routes stay mounted until restart regardless).
        with PLUGINS_LOCK:
            for p in LOADED_PLUGINS:
                if p["id"] == plugin_id:
                    p["enabled"] = enabled
            pend = PENDING_PLUGINS.get(plugin_id)
            if pend is not None:
                pend["enabled"] = enabled

        return {"id": plugin_id, "enabled": enabled}

    @app.get("/api/plugins/{plugin_id}/screen.html")
    def plugin_screen_html(plugin_id: str):
        with PLUGINS_LOCK:
            snapshot = list(LOADED_PLUGINS)
        for p in snapshot:
            if p["id"] == plugin_id:
                if p.get("status", "ready") != "ready":
                    break
                screen_file = p["_dir"] / p["_manifest"].get("screen", "screen.html")
                if screen_file.exists():
                    return HTMLResponse(screen_file.read_text(encoding="utf-8"))
        return HTMLResponse("", status_code=404)

    @app.get("/api/plugins/{plugin_id}/screen.js")
    def plugin_screen_js(request: Request, plugin_id: str):
        with PLUGINS_LOCK:
            snapshot = list(LOADED_PLUGINS)
        for p in snapshot:
            if p["id"] == plugin_id:
                if p.get("status", "ready") != "ready":
                    break
                script_file = p["_dir"] / p["_manifest"].get("script", "screen.js")
                if script_file.is_file():
                    # no-cache + ETag/304 so an edited screen.js reloads on
                    # refresh while an unchanged one revalidates cheaply — the
                    # same live-edit contract the src/ module graph relies on.
                    return _plugin_file_response(request, script_file, "application/javascript")
        return Response("", status_code=404)

    # ── Module-graph cache busting (#879) ────────────────────────────────
    #
    # ES modules are evaluated ONCE PER URL PER DOCUMENT. Re-inserting a
    # <script type="module"> whose src the module map has already seen fires
    # `load` but does NOT re-run the body. So re-loading a plugin — a rollback,
    # and (see below) an upgrade too — silently kept the OLD module live while
    # the loader recorded success: a no-op that reported it worked.
    #
    # Busting the ENTRY url does not help. A module plugin's screen.js is a
    # one-line `import './src/main.js'`, and a relative specifier resolves
    # against the base URL WITH THE QUERY DROPPED — so a ?v= token never reaches
    # the graph. Driving a real browser through install -> upgrade -> rollback and
    # counting evaluations of src/main.js gives ONE. The upgrade re-runs the shim
    # at its new ?v= URL; the shim imports './src/main.js'; that resolves to the
    # same URL; the module map returns the already-evaluated old module.
    #
    # So the token goes in the PATH: /api/plugins/<id>/g/<n>/screen.js. Every
    # relative import inherits it at every depth — for free, with no
    # import-specifier rewriting (which could never see `import(expr)` anyway).
    #
    # WHY A PATH REWRITE AND NOT TWO MIRRORED ROUTES. The token shifts the base
    # URL, so EVERYTHING a module resolves relatively moves with it — not just
    # imports. `new URL('../assets/worklet.js', import.meta.url)` from
    # /api/plugins/x/g/1/src/main.js resolves to /api/plugins/x/g/1/assets/... .
    # Mirroring only screen.js and src/ would fix imports and 404 every asset,
    # worklet and wasm file the graph reaches — and would silently break again the
    # next time someone adds a plugin route. Stripping the segment before routing
    # makes every plugin route, present and future, work under the prefix.
    #
    # The token is opaque: it is never joined into a filesystem path (and is gone
    # by the time any handler runs), so containment still rests entirely on the
    # same safe_join the un-prefixed routes use.
    _GEN_PREFIX = re.compile(r"^(/api/plugins/[^/]+)/g/[^/]+(/.+)$")

    @app.middleware("http")
    async def _strip_plugin_generation_prefix(request: Request, call_next):
        m = _GEN_PREFIX.match(request.scope.get("path", ""))
        if m:
            # Starlette routes on scope["path"] alone. raw_path is deliberately left
            # ALONE: it is informational, and re-encoding the rewritten str back to
            # bytes would have to guess a codec — `.encode("latin-1")` raises
            # UnicodeEncodeError on a perfectly valid plugin file like src/工具.js,
            # 500ing a request the un-prefixed route serves fine. Leaving raw_path as
            # the client actually sent it is also simply more truthful for logs.
            request.scope["path"] = m.group(1) + m.group(2)
        return await call_next(request)

    @app.get("/api/plugins/{plugin_id}/settings.html")
    def plugin_settings_html(plugin_id: str):
        with PLUGINS_LOCK:
            snapshot = list(LOADED_PLUGINS)
        for p in snapshot:
            if p["id"] == plugin_id:
                if p.get("status", "ready") != "ready":
                    break
                settings = p["_manifest"].get("settings", {})
                settings_file = p["_dir"] / (settings.get("html", "settings.html") if isinstance(settings, dict) else "settings.html")
                if settings_file.exists():
                    return HTMLResponse(settings_file.read_text(encoding="utf-8"))
        return HTMLResponse("", status_code=404)

    @app.get("/api/plugins/{plugin_id}/tour.json")
    def plugin_tour_json(plugin_id: str):
        with PLUGINS_LOCK:
            snapshot = list(LOADED_PLUGINS)
        for p in snapshot:
            if p["id"] == plugin_id:
                if p.get("status", "ready") != "ready":
                    break
                tour_val = p["_manifest"].get("tour")
                if not _is_valid_tour_manifest(tour_val):
                    break
                if isinstance(tour_val, str):
                    tour_filename = tour_val
                elif isinstance(tour_val, dict):
                    tour_filename = tour_val.get("file", "tour.json")
                else:
                    break  # shouldn't reach here; _is_valid_tour_manifest guards above
                # Quick pre-filter for obvious bad paths. This is not the
                # authoritative security boundary — the resolve+relative_to
                # check below is — but catching simple cases early produces
                # a cleaner log message before the filesystem calls.
                if (
                    not isinstance(tour_filename, str)
                    or not tour_filename
                    or ".." in tour_filename.split("/")
                    or tour_filename.startswith("/")
                    or "\\" in tour_filename
                ):
                    log.warning("Plugin %r: invalid tour path rejected: %r", plugin_id, tour_filename)
                    break
                tour_file = (p["_dir"] / tour_filename).resolve()
                plugin_dir = p["_dir"].resolve()
                # Ensure resolved path stays inside the plugin directory
                try:
                    tour_file.relative_to(plugin_dir)
                except ValueError:
                    log.warning("Plugin %r: tour path escapes plugin dir: %r", plugin_id, tour_filename)
                    break
                if tour_file.is_file():
                    return Response(tour_file.read_text(encoding="utf-8"), media_type="application/json")
                break
        return Response("{}", status_code=404, media_type="application/json")

    @app.get("/api/plugins/{plugin_id}/assets/{asset_path:path}")
    def plugin_asset(request: Request, plugin_id: str, asset_path: str):
        """Serve a static file a plugin bundles under its own ``assets/``
        directory (e.g. an AudioWorklet module, WASM, or image). Unlike the
        fixed screen.js/settings.html handlers above, this is a generic
        subtree so plugins can self-host arbitrary assets — required because
        the browser must fetch them by URL (no CDN, per the constitution).

        Containment is enforced by ``safe_join`` against ``<plugin>/assets``,
        so ``..`` traversal, absolute paths, and NUL bytes cannot reach the
        plugin's Python modules or anything outside ``assets/``.
        """
        with PLUGINS_LOCK:
            snapshot = list(LOADED_PLUGINS)
        for p in snapshot:
            if p["id"] == plugin_id:
                if p.get("status", "ready") != "ready":
                    break
                target = safe_join(p["_dir"] / "assets", asset_path)
                if target is None:
                    log.warning("Plugin %r: asset path rejected: %r", plugin_id, asset_path)
                    break
                if target.is_file():
                    # no-cache + ETag/304 so a live-edited worklet/asset reloads
                    # on refresh (bare FileResponse emits an ETag but never 304s).
                    return _plugin_file_response(request, target, _plugin_media_type(target))
                break
        return Response("", status_code=404)

    @app.get("/api/plugins/{plugin_id}/src/{src_path:path}")
    def plugin_src(request: Request, plugin_id: str, src_path: str):
        """Serve a file from a plugin's ES-module source tree under ``src/``.

        This is the R0 host capability that lets a migrated plugin's
        ``screen.js`` (a one-line ``import './src/main.js'``) load its whole
        module graph. Containment mirrors the assets/ route exactly —
        ``safe_join`` against ``<plugin>/src`` rejects ``..``, absolute paths,
        and NUL bytes — and the live-edit cache contract (no-cache + ETag/304)
        makes an edited module reload on refresh while unchanged ones 304.
        Read-only; the src/ tree is source files, never executed server-side.
        """
        with PLUGINS_LOCK:
            snapshot = list(LOADED_PLUGINS)
        for p in snapshot:
            if p["id"] == plugin_id:
                if p.get("status", "ready") != "ready":
                    break
                target = safe_join(p["_dir"] / "src", src_path)
                if target is None:
                    log.warning("Plugin %r: src path rejected: %r", plugin_id, src_path)
                    break
                if target.is_file():
                    return _plugin_file_response(request, target, _plugin_media_type(target))
                break
        return Response("", status_code=404)
