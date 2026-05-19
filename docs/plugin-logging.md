# Plugin logging

Use `context["log"]` for all backend plugin output. It is a stdlib `logging.Logger` namespaced to `slopsmith.plugin.<id>`, pre-configured with the app-wide level, format (including JSON mode), and correlation IDs. **Never use `print()`** — it bypasses correlation context and log rotation.

## Backend usage

```python
def setup(app, context):
    log = context["log"]
    log.info("plugin ready")
    log.warning("optional dependency %r not found, feature disabled", dep)
    try:
        risky_init()
    except Exception:
        log.exception("unhandled error during setup")  # auto-captures traceback
```

## CLI entry-point fallback

For helper scripts that also run as `__main__`, add a stdlib fallback so the logger works without the server pipeline:

```python
if __name__ == "__main__":
    import logging
    logging.basicConfig(level=logging.INFO, format="%(levelname)s %(message)s")
```

## How it's wired

The plugin loader assigns each plugin a logger before calling `setup()`:

```python
context["log"] = logging.getLogger(f"slopsmith.plugin.{plugin_id}")
```

That logger inherits from the root `slopsmith` logger, which is configured by `logging_setup.configure_logging()` (called from `main.py` before uvicorn boots). It respects:

- **`LOG_LEVEL`** — `DEBUG | INFO | WARNING | ERROR` (default `INFO`)
- **`LOG_FORMAT`** — `json | text` (default `text` — coloured console)
- **`LOG_FILE`** — optional path for a persistent log file (e.g. `/config/slopsmith.log`)
- **Correlation IDs** — each HTTP request carries `X-Request-ID`; structlog injects it into every log line during that request's lifetime. WebSocket sessions get their own `ws_conn_id` contextvar bound at accept time.

## Verifying

Look for your plugin's logger name in the console output:

```
INFO     slopsmith.plugin.my_plugin: plugin ready
```

Switch `LOG_FORMAT=json` to see structured output:

```json
{"timestamp": "...", "level": "info", "logger": "slopsmith.plugin.my_plugin", "event": "plugin ready", "request_id": "..."}
```

## Common mistakes

- **Using `print()` inside `setup()` or request handlers.** `print()` goes to stdout, bypasses level filtering, log rotation, JSON formatting, and correlation IDs. Audit your plugin with `grep -nR 'print(' plugins/<id>/`.
- **Creating a new logger with `logging.getLogger("my_plugin")`.** This creates an unparented logger that doesn't inherit slopsmith's configuration. Always use the one passed via `context["log"]`.
- **Logging at `INFO` in hot paths.** Default `LOG_LEVEL` is `INFO`, so `log.info(...)` inside a per-frame or per-message loop floods output. Use `log.debug(...)` for hot-path tracing.

## Related

- [PLUGIN_AUTHORING.md](PLUGIN_AUTHORING.md) — guide index
- [plugin-manifest.md](plugin-manifest.md) — the `routes.py` / `setup(app, context)` contract
- [plugin-diagnostics.md](plugin-diagnostics.md) — capturing logs into the diagnostics bundle
