# FeedBack Diagnostics Bundle — Format Specification

This document is the authoritative reference for the `feedBack-diag-*.zip`
file produced by Settings → Export Diagnostics (feedBack#166).

The bundle is consumed by humans (maintainers reading bug reports) **and**
AI agents (auto-triage, code-aware assistants). Every JSON file inside
the zip carries an explicit `schema` field so consumers can dispatch by
version without guessing.

---

## Overview

A diagnostic bundle is a plain ZIP archive. The default filename is:

```
feedBack-diag-<feedBack-version>-<YYYYMMDD-HHMMSS>.zip
```

Top-level layout:

```
feedBack-diag-0.2.4-20260503-143022.zip
├── manifest.json          AI-friendly index, schema 1
├── README.txt             Human-friendly: what's in here, how to read
├── system/
│   ├── version.json       feedBack + python + OS
│   ├── env.json           allowlisted env vars only (no secrets)
│   ├── hardware.json      backend hardware (container-limited if Docker)
│   └── plugins.json       loaded + orphan plugins, with git info
├── logs/
│   ├── server.log         tail of LOG_FILE (last ~5 MB), redacted if requested
│   ├── server.pretty.log  human-readable companion when LOG_FORMAT=json (auto-detected)
│   └── server.log.meta.json
├── client/
│   ├── console.json       all console levels + window errors + rejections
│   ├── hardware.json      browser-visible hardware: WebGL/WebGPU, host OS
│   ├── local_storage.json filtered
│   └── ua.json            browser, screen, page URL on export
└── plugins/<plugin_id>/   per-plugin contributed diagnostics
```

Sections are conditional on the user's include toggles (system, hardware,
logs, console, plugins). Missing sections are not represented in
`manifest.json`'s `files` array.

---

## `manifest.json` (bundle-level, schema `1`)

```jsonc
{
  "schema": 1,                          // bundle schema; bump = breaking change
  "exported_at": "2026-05-03T14:30:22Z",
  "feedBack_version": "0.2.4",
  "runtime": "docker",                  // "docker" | "electron" | "bare"
  "redacted": true,                     // were redactions applied?
  "files": [
    { "path": "system/version.json", "kind": "json", "schema": "system.version.v1", "size": 312 },
    { "path": "logs/server.log",     "kind": "text", "lines": 41203, "size": 5242880 }
  ],
  "redactions": {                       // present when redacted=true
    "paths_replaced": 142,
    "ips_replaced": 3,
    "song_names_replaced": 27,
    "secrets_replaced": 1
  },
  "notes": [
    "container masks host CPU/RAM in system/hardware.json — real host info lives in client/hardware.json"
  ]
}
```

Field semantics:

- `schema: 1` — top-level bundle schema. Increment only on breaking changes
  to the layout (file moves, mandatory new sections). New optional fields
  are NOT a schema bump; consumers must ignore unknown keys.
- `runtime` — single source of truth for "where was this bundle produced"
  so an agent can pick the right interpretation rules. See
  [Runtime kinds](#runtime-kinds).
- `files[].schema` — present only when the file's first-level JSON object
  carries a string `schema` field (e.g. `"system.hardware.v1"`).
- `files[].kind` — `"json"` | `"text"` | `"binary"`.
- `notes` — human-readable callouts. Always present; may be empty.

---

## Per-file schemas

### `system.version.v1` — `system/version.json`

```jsonc
{
  "schema": "system.version.v1",
  "feedBack_version": "0.2.4",
  "python":   { "version": "3.12.4", "implementation": "CPython", "executable": "/usr/bin/python" },
  "os":       { "system": "Linux", "release": "6.5.0", "machine": "x86_64" },
  "exported_at": "2026-05-03T14:30:22Z"
}
```

### `system.env.v1` — `system/env.json`

```jsonc
{
  "schema": "system.env.v1",
  "vars": {
    "LOG_LEVEL": "INFO",
    "LOG_FORMAT": "json",
    "FEEDBACK_RUNTIME": "electron"
  }
}
```

Allowlisted env var keys only (see `ENV_ALLOWLIST` in `lib/diagnostics_bundle.py`):
`LOG_LEVEL`, `LOG_FORMAT`, `LOG_FILE`, `FEEDBACK_RUNTIME`, `PORT`, `HOST`,
`TZ`, `PYTHONUNBUFFERED`, `DEMUCS_SERVER_URL`. New entries require an
allowlist edit; secrets must never be added.

### `system.hardware.v1` — `system/hardware.json`

```jsonc
{
  "schema": "system.hardware.v1",
  "runtime": { "kind": "docker", "in_docker": true, "in_kubernetes": false },
  "os":      { "system": "Linux", "release": "6.5.0", "version": "...", "machine": "x86_64" },
  "cpu": {
    "brand": "AMD Ryzen 9 7950X 16-Core Processor",
    "arch": "x86_64",
    "cores_logical": 32,
    "cores_physical": 16,
    "freq_mhz_current": 4500,
    "freq_mhz_max": 5700
  },
  "memory": { "total_bytes": 67108864000, "available_bytes": 42000000000 },
  "gpu": [
    {
      "source": "nvidia-smi",
      "name": "NVIDIA GeForce RTX 4070",
      "driver": "550.54.14",
      "memory_total_mb": 12282
    }
  ],
  "notes": ["container masks host CPU/RAM"]
}
```

`gpu` is a list (zero, one, or many entries). Source values in the wild:
`"nvidia-smi"`, `"rocm-smi"`, `"system_profiler"`. Container deployments
without NVIDIA Container Toolkit will have an empty list and a `notes`
entry explaining why.

### `system.plugins.v1` — `system/plugins.json`

```jsonc
{
  "schema": "system.plugins.v1",
  "plugins": [
    {
      "id": "stems",
      "name": "Stems",
      "version": "1.2.0",
      "type": null,
      "loaded": true,
      "has_screen": true,
      "has_script": true,
      "has_settings": false,
      "has_routes": true,
      "diagnostics_declared": true,
      "dir": "stems",
      "standards": ["capability-pipelines.v1"],
      "capabilities": {
        "stems": { "roles": ["owner", "provider"], "commands": ["mute", "restore"] }
      },
      "capability_validation_warnings": [],
      "capability_unsupported_versions": [],
      "compatibility_shims": [],
      "git": { "sha": "abc123d", "remote": "https://github.com/topkoa/feedBack-plugin-stems.git" }
    }
  ],
  "orphans": [
    {
      "id": "broken",
      "name": "Broken Plugin",
      "version": "0.1.0",
      "loaded": false,
      "dir": "broken",
      "path": "/home/user/.config/feedBack/plugins/broken"
    }
  ]
}
```

`orphans` covers plugin directories that contain a `plugin.json` but are
NOT in `LOADED_PLUGINS`. Two sub-cases:

- **Failed-to-load** (no `evicted` field): the plugin id is not loaded at
  all — usually requirements install failure or manifest error. A plugin
  appearing only in `orphans` without `evicted` is the single best
  diagnostic signal for "user installed plugin X but it's not working".
- **Evicted/superseded** (`"evicted": true`): the plugin id IS loaded, but
  from a *different* directory. Typical cause: bundled-wins logic discarded
  an old user-installed clone in favour of the in-tree copy. Also covers
  bundled plugin directories whose routes failed and whose server fell back
  to a user copy (the bundled dir then has a different path from the loaded
  entry). Check the server startup log for the specific failure reason.

`dir` is the bare directory name. `path` is the full resolved absolute path
to the orphan directory — the key disambiguator when the bundled copy and a
user-installed copy share the same directory name (e.g. both `highway_3d`).
In a redacted bundle `path` has home-dir and config-dir prefixes replaced
with placeholder tokens (e.g. `<HOME>/...`, `<CONFIG_DIR>/...`) so
filesystem paths and usernames do not leak.

Capability fields are redaction-safe manifest metadata. Invalid capability
declarations are excluded from `capabilities` and explained in
`capability_validation_warnings`; legacy surfaces still appear as
`compatibility_shims` so maintainers can see which old fields were bridged
into the capability model. Unsupported future `capability-pipelines` versions
appear in `capability_unsupported_versions` and should be treated as
non-executable runtime intent.

Client-side capability snapshots contributed under `plugins/capabilities/client.json`
use schema `feedBack.capabilities.diagnostics.v1`. They include current
pipelines, participants, conflicts, missing providers, user overrides, active
or orphaned claims, claim lifecycle records, compatibility shim hit counts,
unsupported-version reports, and recent decisions. The runtime caps this
snapshot at 64 KB by trimming older `recentDecisions` first while preserving
current graph state.

### `logs.server.v1` — `logs/server.log.meta.json`

```jsonc
{
  "schema": "logs.server.v1",
  "log_file": "/data/log/feedBack.log",
  "exists": true,
  "size_bytes": 8388608,
  "tail_bytes": 5242880,
  "truncated": true
}
```

The companion `logs/server.log` is the raw text tail (UTF-8). When
`LOG_FORMAT=json`, every line is independently parseable as JSON.
When the file exceeds 5 MB, the partial first line is dropped before
serialization so log parsers don't choke.

When the tail is JSON-per-line (auto-detected by content, not by env
var), an additional `logs/server.pretty.log` companion is written:
human-readable lines of the form `<timestamp> [<LEVEL>] <event>  k=v
k=v`. Mixed-format tails (a config flip mid-run) preserve non-JSON
lines verbatim. The original `server.log` is still emitted unchanged
for machine consumers. `server.log.meta.json:pretty_companion` is set
to `true` whenever `server.pretty.log` is present.

### `client.console.v1` — `client/console.json`

```jsonc
{
  "schema": "client.console.v1",
  "entries": [
    {
      "t": 1714752622123,
      "kind": "console",            // "console" | "error" | "rejection"
      "level": "warn",              // "log" | "info" | "warn" | "error" | "debug"
      "msg": "WebSocket disconnected: 1006",
      "args": ["WebSocket disconnected: 1006"],
      "ua": "Mozilla/5.0 ...",
      "screen": { "width": 2560, "height": 1440, "devicePixelRatio": 1, "colorDepth": 24 }
    },
    {
      "t": 1714752623456,
      "kind": "rejection",
      "level": "error",
      "msg": "fetch failed",
      "stack": "Error: ...\n    at ...",
      "ua": "...",
      "screen": { ... }
    }
  ]
}
```

Bounded ring buffer: 500 entries, ~250 KB cap. Each entry's `args` may
contain truncated stringifications of non-string console arguments —
depth limit 4, key cap 30, string truncation at 1024 chars, circular refs
serialized as `"[circular]"`.

### `client.hardware.v1` — `client/hardware.json`

```jsonc
{
  "schema": "client.hardware.v1",
  "runtime": {
    "kind": "electron",
    "electron": "28.1.0",
    "chrome": "120.0.6099.109",
    "node": "18.18.2",
    "v8": "12.0.267.8",
    "app_version": "0.2.4"
  },
  "navigator": {
    "userAgent": "Mozilla/5.0 ...",
    "platform": "Win32",
    "hardwareConcurrency": 16,
    "deviceMemory": 8,
    "languages": ["en-US"]
  },
  "userAgentData": {
    "platform": "Windows",
    "platformVersion": "15.0.0",
    "architecture": "x86",
    "model": "",
    "bitness": "64"
  },
  "screen": { "width": 2560, "height": 1440, "devicePixelRatio": 1, "colorDepth": 24 },
  "webgl": {
    "available": true,
    "vendor": "Google Inc. (NVIDIA)",
    "renderer": "ANGLE (NVIDIA, NVIDIA GeForce RTX 4070 Direct3D11 vs_5_0 ps_5_0)",
    "version": "WebGL 2.0 (OpenGL ES 3.0 Chromium)",
    "shading_language_version": "WebGL GLSL ES 3.00 (OpenGL ES GLSL ES 3.0 Chromium)",
    "max_texture_size": 16384,
    "redacted": false
  },
  "webgpu": {
    "available": true,
    "adapter_info": {
      "vendor": "nvidia",
      "architecture": "ada",
      "device": "",
      "description": ""
    }
  }
}
```

`runtime.kind` rules:

- `"electron"` if `navigator.userAgent` contains `Electron/`. Versions
  populated when the desktop launcher exposes `window.feedBackElectron`
  via a preload `contextBridge`.
- `"browser"` otherwise.

`webgl.redacted: true` indicates the browser refused to expose the real
renderer string (Firefox privacy mode, Safari ≥17). Treat the `vendor`
and `renderer` fields as advisory in that case.

### `client.local_storage.v1` — `client/local_storage.json`

```jsonc
{
  "schema": "client.local_storage.v1",
  "data": { "<key>": "<value as string>" }
}
```

Every key/value in browser `localStorage` at export time. Plugins
typically prefix their keys with their `plugin_id`.

### `client.ua.v1` — `client/ua.json`

```jsonc
{
  "schema": "client.ua.v1",
  "userAgent": "...",
  "url": "https://feedBack.local/",
  "screen": { ... }
}
```

### Plugin diagnostics — `plugins/<plugin_id>/...`

Per-plugin directory. Two ways to populate it:

1. `diagnostics.server_files` — relpaths under `config_dir`, copied
   verbatim. Same allowlist semantics as `settings.server_files`.
2. `diagnostics.callable` — `<module>:<function>`; called with
   `({"plugin_id", "config_dir"})`. Return values:
   - `dict` / `list` → written to `plugins/<id>/callable.json`
   - `bytes` → written to `plugins/<id>/callable.bin`
   - `str`   → written to `plugins/<id>/callable.txt`
   - other types → discarded with a warning
   Exceptions are caught and logged to the bundle's `manifest.notes`
   — a buggy plugin never crashes the export.

Plugins are encouraged to embed their own `schema` field
(`"<plugin_id>.diag.v1"`) in any JSON they emit so future tooling can
dispatch by plugin schema.

---

## Runtime kinds

`manifest.runtime` and `system/hardware.json:runtime.kind` and
`client/hardware.json:runtime.kind` may take these values:

| Kind       | Backend sees…           | Frontend sees… | Cross-correlate? |
|------------|-------------------------|----------------|------------------|
| `docker`   | container-limited       | host           | NO — different machines |
| `electron` | host (Python is child)  | host           | YES — same machine |
| `bare`     | host                    | host           | YES — same machine |

Detection precedence (backend):

1. `FEEDBACK_RUNTIME` env var (`"electron"`/`"docker"`/`"bare"`)
2. `/.dockerenv` exists OR `/proc/1/cgroup` mentions `docker`/
   `containerd`/`kubepods` → `docker`
3. Parent process name matches `electron` or `FeedBack` → `electron`
4. Default: `bare`

Detection (frontend): `Electron/` in user agent → `electron`, else
`browser`.

---

## Redaction

Applied to `logs/server.log` text and `client/console.json` entry
messages when `redact: true` (default). The bundle's
`manifest.json:redactions` reports per-token-class counts.

Token grammar (stable within a single bundle, salted differently
between bundles):

| Token              | Source                                              |
|--------------------|-----------------------------------------------------|
| `<DLC_DIR>`        | configured DLC root path                             |
| `<HOME>`           | user's home directory                                |
| `<CONFIG_DIR>`     | feedBack config directory                           |
| `<song:HASH8>`     | song filename / basename (8-char salted SHA-256)    |
| `<ip:HASH6>`       | IPv4 / IPv6 address                                  |
| `<redacted>`       | bearer token, `key=`/`token=`/`api_key=` query strings |

`hardware.json` and `plugins.json` are NOT redacted (no PII).
`local_storage.json` always has values for keys matching secret-name
patterns (`api_key`, `token`, `secret`, `password`, `auth`, `bearer`,
etc.) replaced with `"<redacted>"` — this happens unconditionally,
regardless of the main redaction toggle, because plugin authors
commonly store tokens in localStorage.

---

## Versioning policy

- **Bundle schema (`manifest.schema`)**: integer. Bump on breaking
  layout changes (file relocations, removed required sections,
  incompatible structural changes to existing schemas). Today: `1`.
- **Per-file schemas (`<area>.<name>.v<n>`)**: bumped independently.
  A bundle MAY mix old and new file schemas during transitions.
- **Adding optional fields** to an existing schema is NOT a bump.
  Consumers MUST ignore unknown keys.
- **Removing a field** is a bump.

Bundles older than the consumer's known schemas should be processed on
a best-effort basis (display what's recognized, warn about the rest).

---

## AI agent reading guide

Start at `manifest.json`. It lists every file with its schema id —
dispatch on schema, never on path or filename heuristics.

Common symptom → file map:

| Symptom                          | Files to inspect                                                                       |
|----------------------------------|-----------------------------------------------------------------------------------------|
| Audio not playing                | `system/plugins.json` (stems plugin loaded?), grep `logs/server.log` for `ffmpeg`/`vgmstream`, `client/console.json` for fetch errors |
| 3D highway slow / black          | `client/hardware.json` (`webgl.renderer`, `webgpu.adapter_info`); `client/console.json` for WebGL warnings |
| Plugin error on load             | grep `logs/server.log` for `Plugin %r`, check `system/plugins.json:orphans` for failed-to-load |
| WebSocket disconnects            | `client/console.json` (`level: "warn"` / `"error"`)                                     |
| "Works on my machine"            | Diff `system/version.json` + `system/env.json` + `system/hardware.json` between bundles |
| Song-specific bug                | grep `logs/server.log` for the song's `<song:HASH>` token (stable across the bundle)    |
| Cross-platform crash             | `manifest.runtime` + `system/hardware.json:runtime` + `client/hardware.json:runtime`    |
| Cache / disk issue               | `system/env.json:LOG_FILE`, `logs/server.log.meta.json:exists`                          |

When the bundle was redacted, the redaction token map is documented
above. Two log lines mentioning `<song:a3f1c2>` are about the same song
— but a bundle exported separately with the same song will use a
different token.

When `manifest.runtime == "docker"`, the backend `system/hardware.json`
reports container-limited values. Real host CPU / RAM / GPU live in
`client/hardware.json` only. Don't cross-correlate.

When `manifest.runtime == "electron"`, both halves describe the same
machine.

---

## Plugin contribution contract

```jsonc
// plugin.json
{
  "id": "nam_tone",
  "name": "NAM Tone",
  "version": "1.0.0",
  "diagnostics": {
    "server_files": ["nam_tone.db.diag.json"],
    "callable": "diagnostics:collect"
  }
}
```

Frontend plugins push diagnostics by calling
`window.feedBack.diagnostics.contribute(plugin_id, payload)` before the
user clicks Export. The payload is written to `plugins/<id>/client.json`
(gated on the same "Plugin diagnostics" toggle as backend plugin files).

Backend callable signature:

```python
# plugins/nam_tone/diagnostics.py
def collect(ctx: dict) -> dict | bytes | str:
    """ctx: {'plugin_id': 'nam_tone', 'config_dir': Path(...)}"""
    return {
        "schema": "nam_tone.diag.v1",
        "models": [...],
    }
```

Best practices:

- Return small payloads (< 100 KB). Diagnostics are not a backup channel.
- Embed your own `schema` field in returned dicts.
- Never raise — but if you do, the export keeps going and notes the
  failure.
- Don't include user secrets, API keys, or session tokens.
