# Testing plugins

Slopsmith has three test surfaces — Python unit/integration tests (pytest), JS plugin-API contract tests (Node), and end-to-end browser tests (Playwright). This doc covers what to use when.

## Test layout

```
tests/
├── conftest.py          Shared pytest fixtures (isolate_logging)
├── test_plugins.py      Plugin loader + load_sibling + collision tests (includes reset_plugin_state)
├── test_song.py         Wire-format serialization round-trips
├── test_*.py            Per-feature backend tests
├── js/                  Node --test JS plugin-API contract tests
└── browser/             Playwright end-to-end tests
```

## Running tests

```bash
pytest                              # All Python tests
pytest tests/test_plugins.py -v     # Specific file
pytest -k "load_sibling" -v         # Pattern match

npm run test:js                     # Node-native JS contract tests
npm run install:playwright          # One-time: install Chromium
npm test                            # Playwright browser tests
npm run test:headed                 # Playwright with visible browser
npm run test:debug                  # Playwright inspector
```

CI runs `pytest` on every push/PR to `main` (Python 3.12).

## Shared fixtures

### `isolate_logging` (in `conftest.py`)

Saves and restores handlers, level, and `propagate` flag on the `slopsmith`, `uvicorn`, `uvicorn.error`, and `uvicorn.access` loggers, plus calls `structlog.reset_defaults()`. **Import into any test module that calls `configure_logging()`** so mutations don't bleed across tests.

```python
def test_my_log_thing(isolate_logging):
    configure_logging()
    # ... assertions
```

### `reset_plugin_state` (in `test_plugins.py`)

Local fixture used by plugin-loader tests. Saves and restores:
- `plugins.LOADED_PLUGINS`
- any `plugin_*` keys in `sys.modules`
- the bare names the tests simulate (`util`, `extractor`) in `sys.modules`
- `sys.path` (the loader mutates it)

Also unsets `SLOPSMITH_PLUGINS_DIR` for the test's duration via `monkeypatch` so a CI env that pre-sets it can't leak real user plugins into a tmp-path-driven test.

If you're authoring a plugin that ships top-level helper modules, model new tests on the patterns in `test_plugins.py` — use `reset_plugin_state` to guarantee a clean import slate.

## Backend test patterns

- **Wire-format round-trips.** `test_song.py` is the model: pure serialization tests, no fixtures, narrative docstring. Pattern: build a `Song`/`Arrangement`/`Note`, serialize, deserialize, assert equal.
- **Loader behaviour.** `test_plugins.py` uses tmp-path-driven plugin roots + `reset_plugin_state` + `_make_plugin` / `_run_load_plugins` helpers. Adopt these helpers for any new loader-touching tests.
- **Async / WebSocket.** Tests for FastAPI WebSocket endpoints use `httpx.AsyncClient` and `app.websocket_connect()`. See `test_audio.py` and `test_highway_3d_routes.py` for examples.

## JS contract tests (`tests/js/`)

Plain `node --test` files. No browser, no server. Cover the plugin-API surface as exposed on `window.slopsmith` and related globals. Run with `npm run test:js`.

Use these when a plugin needs to assert against the API contract without spinning up a real browser. They run in seconds; CI can grow these without slowing.

## Browser tests (`tests/browser/`)

Playwright + Chromium. `playwright.config.ts` runs serially (`workers: 1`) and boots a real Slopsmith instance via Docker Compose. Traces / video on failure.

What's currently covered: page load and keyboard shortcuts. **No plugin E2E patterns yet** — if you're adding the first one for your plugin, set the precedent. Suggested structure:

```ts
import { test, expect } from '@playwright/test';

test('my plugin loads its navbar entry', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByRole('link', { name: 'My Plugin' })).toBeVisible();
});

test('my plugin shortcut fires', async ({ page }) => {
    await page.goto('/#plugin-my_plugin');
    await page.keyboard.press('k');
    await expect(page.getByTestId('my-plugin-toggle')).toHaveAttribute('aria-pressed', 'true');
});
```

Prefer `data-testid` over text-based selectors so refactors don't break tests.

## Debugging

- **Browser console shortcut inventory.** `_listShortcuts()` prints every registered shortcut, its scope, and source.
- **`LOG_FORMAT=json pytest`** — get machine-readable test logs.
- **`pytest -s`** — disable output capture (handy for `print()`-style debug, though prefer `log.debug()` in production code).
- **Playwright trace viewer** — `npx playwright show-trace test-results/.../trace.zip` after a failure.

## Related

- [PLUGIN_AUTHORING.md](PLUGIN_AUTHORING.md) — guide index
- [plugin-logging.md](plugin-logging.md) — `context["log"]` and why `print()` breaks the logging pipeline
- [plugin-sibling-imports.md](plugin-sibling-imports.md) — `load_sibling` and the collision tests
- [plugin-keyboard-shortcuts.md](plugin-keyboard-shortcuts.md) — `window.registerShortcut` and `_listShortcuts()`
