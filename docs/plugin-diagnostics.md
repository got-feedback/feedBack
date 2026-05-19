# Plugin diagnostics contribution

Slopsmith ships an **Export Diagnostics** feature (Settings → Export Diagnostics) that bundles a redacted set of host + plugin state into a zip the user can share with maintainers. Plugins have three independent opt-ins for contributing to this bundle.

The bundle layout and per-file schemas are documented in [diagnostics-bundle-spec.md](diagnostics-bundle-spec.md). This doc covers how plugins integrate.

## 1. `manifest.diagnostics.server_files` — opt-in file capture

Declare files under `context["config_dir"]` to copy verbatim into the bundle:

```json
{
  "diagnostics": {
    "server_files": ["my_plugin.diag.json", "my_plugin_models/active.json"]
  }
}
```

Rules (same as `settings.server_files`):
- Relpaths only. No `..`, no abs paths, no backslashes, no leading dots.
- Files land at `plugins/<plugin_id>/<relpath>` inside the bundle.
- Encoded as `{"encoding": "json", "data": <parsed>}` if `.json` parses cleanly, base64 otherwise.

Use this for **snapshot-style state** — small DB excerpts, model lists, last-error files. Don't use it for backups (that's `settings.server_files`).

## 2. `manifest.diagnostics.callable` — opt-in dynamic capture

Declare a Python entry point that produces diagnostics at export time:

```json
{
  "diagnostics": {
    "callable": "diagnostics:collect"
  }
}
```

The form is `"<module>:<function>"`. The module is resolved lazily via `load_sibling` when the user clicks Export, then called as:

```python
# plugins/my_plugin/diagnostics.py
def collect(ctx):
    """ctx is {"plugin_id": str, "config_dir": Path}."""
    return {
        "schema": "my_plugin.diag.v1",
        "active_preset": _read_active_preset(ctx["config_dir"]),
        "model_count": len(list((ctx["config_dir"] / "models").glob("*.pt"))),
    }
```

Return-type handling:
- `dict` / `list` → written to `plugins/<id>/callable.json`
- `bytes` → `callable.bin`
- `str` → `callable.txt`

Exceptions are caught and appended to the bundle's `manifest.notes` — a buggy plugin never crashes the export.

## 3. Frontend contribution (slopsmith#166)

Plugins that hold useful debug state in the browser (active model name, last user input, internal counters) can push it into the bundle from `screen.js`:

```js
window.slopsmith.diagnostics.contribute('my_plugin', {
    schema: 'my_plugin.client_diag.v1',
    active_preset: getActivePreset(),
    last_error: _lastError,
});
```

- **Idempotent.** Repeated calls overwrite the previous value.
- Whatever was last contributed before the user hits Export Diagnostics is what lands in `plugins/<plugin_id>/client.json`.
- Available namespace: `window.slopsmith.diagnostics.{contribute, snapshotConsole, snapshotHardware, snapshotUa, snapshotLocalStorage, snapshotContributions}`.
- Loaded from `static/diagnostics.js` ASAP in `<head>` so the console-wrap is in place before any other script runs.

## Best practices

- **Embed a `schema` field** (e.g. `"my_plugin.diag.v1"`) in JSON returned by `callable` so future tooling can dispatch by version.
- **Keep payloads small (< 100 KB).** Diagnostics are not a backup channel — that's `settings.server_files`.
- **Don't include secrets, API keys, or session tokens.** Bundles are shared with maintainers / posted to GitHub issues.

## Related

- [PLUGIN_AUTHORING.md](PLUGIN_AUTHORING.md) — guide index
- [diagnostics-bundle-spec.md](diagnostics-bundle-spec.md) — full bundle layout + per-file schemas
- [plugin-manifest.md](plugin-manifest.md) — declaring `diagnostics` fields
- [plugin-logging.md](plugin-logging.md) — `log.exception()` writes traceback into the diagnostics log capture
