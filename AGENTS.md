# AGENTS.md

Project orientation for AI coding assistants (Cursor, GitHub Copilot, OpenAI Codex, Aider, Claude Code, Cline, Continue, Cody, Devin, …) and human contributors.

Slopsmith is a self-hosted web app for browsing, playing, and practicing Rocksmith 2014 Custom DLC. It runs as a Docker container with a FastAPI backend (`server.py`), vanilla JavaScript frontend (`static/`), shared Python libraries (`lib/`), and an extensive plugin system (`plugins/`). No frontend frameworks — plain JS, HTML, Tailwind CSS. AGPL-3.0-only.

This file is the canonical orientation. Tool-specific automation (Claude skills/subagents/rules, Copilot instructions, etc.) lives in [`.claude/`](.claude/) and [`.github/copilot-instructions.md`](.github/copilot-instructions.md); both point back here. For plugin work, start at [`docs/PLUGIN_AUTHORING.md`](docs/PLUGIN_AUTHORING.md).

## Architecture quick reference

```text
server.py              FastAPI app — library API, WebSocket highway, plugin loading
main.py                Programmatic uvicorn entrypoint — installs structlog before boot
logging_setup.py       Structured logging + correlation IDs (LOG_LEVEL/LOG_FORMAT/LOG_FILE)
static/
  app.js               Main frontend — screens, library views, player, plugin loader
  highway.js           Canvas note highway renderer (createHighway factory)
  diagnostics.js       window.slopsmith.diagnostics namespace (loaded first in <head>)
  index.html           Single-page app shell
lib/
  song.py              Core data models (Note, Chord, Arrangement, Song)
  psarc.py             PSARC archive reading and extraction
  sloppak.py           Sloppak format support
  sloppak_convert.py   PSARC → sloppak conversion + Demucs stem split
  audio.py             WEM/OGG/MP3 audio handling
  retune.py            Pitch-shifting logic
  tunings.py           Tuning name/offset utilities
  gp2rs.py             Guitar Pro to Rocksmith XML conversion
  gp2midi.py           Guitar Pro to MIDI
plugins/
  __init__.py          Plugin discovery, loading, requirements install, load_sibling
  <plugin>/            Each plugin is its own directory (often a git submodule)
schema/
  plugin.schema.json   JSON Schema for plugin.json (validated in CI)
docs/                  Plugin contracts + format specs (see Plugin authoring below)
tests/                 pytest + tests/js/ (node --test) + tests/browser/ (Playwright)
specs/                 Active spec-kit features (specs/001-slopsmith-platform/...)
```

## Running the app

Canonical dev path is Docker Compose — `docker-compose.yml` live-mounts `static/`, `server.py`, `lib/`, `plugins/`, and `VERSION` into the container, so frontend edits are visible on refresh and backend edits trigger uvicorn auto-reload.

```bash
docker compose up                                     # build + run on :8000
DLC_PATH=/path/to/dlc docker compose up               # override default Steam DLC path
```

For host-side runs (tests, scripts, no Docker), the programmatic entry point is `main.py`:

```bash
python main.py                                        # HOST=0.0.0.0 PORT=8000 default
HOST=127.0.0.1 PORT=8001 python main.py
```

`main.py` installs the structlog pipeline via `logging_setup.configure_logging()` **before** uvicorn boots and passes `log_config=None` so uvicorn's `dictConfig` never overwrites it. Do not invoke `uvicorn server:app` directly during development — early lifecycle log lines will bypass the structured pipeline and correlation IDs.

**Logging env vars** (read by `logging_setup`):
- `LOG_LEVEL` — `DEBUG | INFO | WARNING | ERROR` (default `INFO`)
- `LOG_FORMAT` — `json | text` (default `text` — coloured console)
- `LOG_FILE` — optional path for a persistent log file (e.g. `/config/slopsmith.log`)

Plugin backend code receives a pre-configured `context["log"]` logger namespaced to `slopsmith.plugin.<id>` — never use `print()`. See [`docs/plugin-logging.md`](docs/plugin-logging.md).

## Testing

```bash
pytest                              # All Python tests
pytest tests/test_plugins.py -v     # Specific file
pytest -k "load_sibling" -v         # Pattern match

npm run test:js                     # Node-native JS plugin-API contract tests (tests/js/)
npm run install:playwright          # One-time: install Chromium for Playwright
npm test                            # Playwright browser tests (tests/browser/)
```

Pytest config in `pyproject.toml` sets `pythonpath = [".", "lib"]` and `testpaths = ["tests"]`. CI runs `pytest` on every push/PR to `main` (Python 3.12). See [`docs/testing-plugins.md`](docs/testing-plugins.md) for fixtures (`isolate_logging`, `reset_plugin_state`) and Playwright patterns.

## Git workflow

- **Never push directly to `main`** — always create a feature branch and open a PR.
- **DCO sign-off is mandatory.** `git commit -s` appends `Signed-off-by:`. Forgot? `git commit --amend -s`. See [`CONTRIBUTING.md`](CONTRIBUTING.md).
- **Upstream remote** — set `upstream` to the canonical Slopsmith repository; `origin` is your fork.
- **Plugins are gitlinks** — each plugin in `plugins/` is typically its own git repo (submodule or clone). Branch switches on the main repo can clobber plugin directories. Use `git update-index --assume-unchanged` for plugin dirs if needed.
- **Commit style** — short imperative subject line, blank line, then body explaining *why*. Conventional-commit prefixes (`feat(scope):`, `fix(scope):`, `chore:`, `docs:`) are conventional in the log but not enforced.

## Versioning

- **`VERSION`** (repo root) — single source of truth; plain semver string. Bind-mounted into the container and copied by the Dockerfile so it's always available at `/app/VERSION`.
- **`GET /api/version`** — returns `{"version", "source_url", "license_url"}`. `source_url` is overridable via `APP_SOURCE_URL` (default `https://github.com/byrongamatos/slopsmith`); `license_url` falls back to `source_url + "/blob/main/LICENSE"` and is overridable via `APP_LICENSE_URL`. Both must be `http(s)`; non-http(s) values are rejected.
- **Auto-sync** — `.github/workflows/sync-version.yml` rewrites `VERSION` via a `repository_dispatch` (`desktop-released`) from `slopsmith-desktop`'s release job. As an explicit automation-only exception to "Never push directly to main", the sync job commits straight to `main` as `github-actions[bot]`. Humans still go through PRs.
- **`CHANGELOG.md`** — [Keep a Changelog](https://keepachangelog.com/) format. Update `[Unreleased]` on each PR; release renames it.

## Song formats

Slopsmith supports two:

- **PSARC** (Rocksmith native) — encrypted archive. Read-only. Fast metadata scan via `lib/psarc.py` (`read_psarc_entries`); full unpack via `unpack_psarc()` for playback. Audio via `vgmstream-cli` + `ffmpeg`.
- **Sloppak** (open format) — hand-editable, two interchangeable forms: `.sloppak` zip or `.sloppak/` directory. Preferred for new features. Full spec: [`docs/sloppak-spec.md`](docs/sloppak-spec.md). Key code: `lib/sloppak.py`, `lib/sloppak_convert.py`, `lib/song.py`.

## Frontend conventions

- **No frameworks** — vanilla JS, fetch API, DOM manipulation
- **Globals** — `highway`, `audio`, `playSong()`, `showScreen()`, `createHighway()`, `window.slopsmith`
- **Storage** — `localStorage` for all user preferences, prefixed with plugin id
- **Styling** — Tailwind utility classes; dark theme (`bg-dark-600`, `text-gray-300`, accent `#4080e0`, gold `#e8c040`)
- **Naming** — camelCase for JS, kebab-case for CSS, snake_case for plugin IDs
- **Player layout** — `#player` is `display:flex; flex-direction:column; position:fixed; inset:0`. `#highway` is `flex:1`. Hiding the highway collapses the layout — use `margin-top: auto` on controls if you must hide it.

## Backend conventions

- **Framework** — FastAPI + uvicorn (boot via `main.py`)
- **Imports** — flat imports from `lib/` (no `__init__.py`): `from song import Song`
- **Database** — SQLite via `MetadataDB` class with `threading.Lock`
- **WebSocket** — JSON frames, try/except `WebSocketDisconnect`. Protocol: [`docs/websocket-protocol.md`](docs/websocket-protocol.md)
- **Error handling** — graceful fallbacks (audio conversion errors don't crash the song; missing art returns a placeholder)
- **Type hints** — used sparingly (`Path | None`, `dict`, `list`)
- **Docstrings** — minimal; code is self-documenting

## Plugin authoring — see [`docs/PLUGIN_AUTHORING.md`](docs/PLUGIN_AUTHORING.md)

Plugins are the primary extension point. Each lives in `plugins/<name>/` with a `plugin.json` manifest. Curated plugins must be AGPL-3.0 or AGPL-compatible — see [`CONTRIBUTING.md`](CONTRIBUTING.md) for the allowlist. Manifest is validated in CI against [`schema/plugin.schema.json`](schema/plugin.schema.json), including `capability-pipelines.v1` metadata for native capability declarations.

Topic | Doc
--- | ---
Manifest reference (`plugin.json` fields) | [`docs/plugin-manifest.md`](docs/plugin-manifest.md)
Capability declarations (`standards`, `capabilities`, `ui`) | [`docs/plugin-manifest.md#capabilities`](docs/plugin-manifest.md#capabilities)
Visualization (setRenderer / overlay / note-state) | [`docs/plugin-visualization-contracts.md`](docs/plugin-visualization-contracts.md)
Plugin styles (`styles: "assets/plugin.css"`) | [`docs/plugin-styles.md`](docs/plugin-styles.md)
Audio mixer fader registration | [`docs/plugin-audio-mixer.md`](docs/plugin-audio-mixer.md)
Backend `context["log"]` logging | [`docs/plugin-logging.md`](docs/plugin-logging.md)
Diagnostics opt-in (export bundle) | [`docs/plugin-diagnostics.md`](docs/plugin-diagnostics.md)
Keyboard shortcuts (`registerShortcut`) | [`docs/plugin-keyboard-shortcuts.md`](docs/plugin-keyboard-shortcuts.md)
Multi-file backends (`load_sibling`) | [`docs/plugin-sibling-imports.md`](docs/plugin-sibling-imports.md)
WebSocket highway protocol | [`docs/websocket-protocol.md`](docs/websocket-protocol.md)
Testing plugins (pytest + Playwright) | [`docs/testing-plugins.md`](docs/testing-plugins.md)
Diagnostics bundle layout | [`docs/diagnostics-bundle-spec.md`](docs/diagnostics-bundle-spec.md)
Sloppak format spec | [`docs/sloppak-spec.md`](docs/sloppak-spec.md)
Tuning the note_detect plugin | [`docs/note-detect-tuning.md`](docs/note-detect-tuning.md)

## First-hour pitfalls (read these before your first PR)

1. **`load_sibling` for cross-file backend plugins.** Bare `from extractor import X` in `routes.py` collides across plugins because Python caches by module name in `sys.modules`. Use `context["load_sibling"]("extractor")` — gets a per-plugin namespaced module. Full explanation: [`docs/plugin-sibling-imports.md`](docs/plugin-sibling-imports.md).

2. **`playSong` wrapper race condition.** Plugins commonly wrap `window.playSong`. Wrappers chain outermost-first (last-loaded runs first). If an inner wrapper does `await import(CDN)`, it yields to the event loop and WebSocket messages (`song_info`, `ready`) can arrive before outer wrappers finish setup. Use `getSongInfo()` as a fallback, not `_onReady` alone.

3. **Highway flex layout.** `#highway` has `flex:1` in the player. Hiding it with `display:none` removes the flex child and `#player-controls` floats to the top. If you must hide the highway, add `margin-top: auto` to the controls div.

4. **Plugin gitlinks bite on branch switches.** Plugins are separate git repos cloned into `plugins/`. `git checkout` / `git clean` on the main repo can delete or clobber them. Use `git update-index --assume-unchanged plugins/<id>` if needed.

5. **DCO sign-off is mandatory.** Every commit needs `Signed-off-by:`. Add via `git commit -s` (or `git commit --amend -s` if you forgot). PRs without DCO won't merge.

## Verification (run before claiming done)

```bash
pytest -q                         # backend tests
npm run test:js                   # JS plugin-API contract tests
npm test                          # Playwright browser tests (slow; defers to CI)
```

If you touched `plugins/*/plugin.json` or `schema/`:

```bash
python -c "import json,glob,jsonschema; s=json.load(open('schema/plugin.schema.json')); [jsonschema.validate(json.load(open(p)), s) for p in sorted(glob.glob('plugins/*/plugin.json'))]"
```

## House rules

- **AGPL-3.0-only.** Inbound contributions are inbound under the same terms. Don't paste from incompatible sources.
- **DCO sign-off mandatory** on every commit (`git commit -s`).
- **No frontend frameworks.** Vanilla JS, fetch API, Tailwind classes. Don't add React/Vue/Svelte.
- **Backend logging.** Plugin `routes.py` must use `context["log"]`, never `print()`. See [`docs/plugin-logging.md`](docs/plugin-logging.md).
- **Plugin Python imports.** Multi-file backends use `context["load_sibling"]("<module>")`, not bare `from <module> import`. See [`docs/plugin-sibling-imports.md`](docs/plugin-sibling-imports.md).
- **Capability metadata.** New plugin integrations should declare `standards: ["capability-pipelines.v1"]` plus redaction-safe `capabilities`/`ui` metadata rather than relying only on private globals.
- **Spec-kit owns `.specify/` and `specs/`.** Don't modify those without explicit instruction; the `/speckit-*` skills own that surface.

## Tool-specific surfaces (optional reading)

- [`CLAUDE.md`](CLAUDE.md) — points back here. Exists for Claude Code's auto-loading convention. Claude-specific *automation* lives in [`.claude/`](.claude/) (skills, subagents, rules, settings).
- [`.github/copilot-instructions.md`](.github/copilot-instructions.md) — points back here. Exists for GitHub Copilot's native instructions format.
- No `.cursorrules` — Cursor reads `AGENTS.md` natively. Cursor-specific rules, if ever needed, would go under `.cursor/rules/`.
