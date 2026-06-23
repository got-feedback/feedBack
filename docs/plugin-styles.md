# Plugin styling — the `styles` capability

> Building for the redesigned **v3 UI** (`FEEDBACK_UI=v3` / `/v3`)? v3 uses `fb-*`
> design tokens and a restructured player chrome with a dedicated plugin-control
> slot. See **[plugin-v3-ui.md](plugin-v3-ui.md)** for the player-chrome contract
> plugins must follow in v3.

FeedBack serves Tailwind as a **prebuilt** stylesheet
(`static/tailwind.min.css`), never the runtime Play CDN. The CDN's on-the-fly
JIT rescanned the DOM on the main thread and dropped ~26% of frames with the 3D
highway running (feedBack-desktop#110). See **constitution Principle II**.

A prebuilt stylesheet only contains the classes the build scanner saw in **core
source at core build time**. That has a consequence for plugins:

- Core's build scans bundled plugins on disk, but **a plugin installed at
  runtime** (community / NAS) was never scanned. Its classes — especially
  arbitrary values like `text-[11px]`, `grid-cols-[1fr_auto]`,
  `shadow-[0_0_8px_rgba(0,0,0,.5)]` — are **absent** from the served CSS, so its
  UI renders unstyled.

The `styles` capability fixes this: your plugin ships its **own** compiled
stylesheet and declares it in the manifest. The frontend injects one versioned
`<link rel="stylesheet">` into `<head>` when your plugin activates, covering both
your screen and your settings panel.

> You only need this if you use Tailwind classes that aren't guaranteed in core —
> in practice, **any arbitrary-value class** (`w-[37px]`), or a custom class core
> doesn't ship. If you use only common core utilities (`flex`, `p-4`,
> `text-gray-300`, `bg-dark-600`), you can omit `styles` and rely on core's CSS.

## 1. Declare it in `plugin.json`

```json
{
  "id": "my_plugin",
  "name": "My Plugin",
  "version": "1.2.0",
  "screen": "screen.html",
  "script": "screen.js",
  "styles": "assets/plugin.css"
}
```

`styles` is a **plugin-root-relative path that must live under `assets/`** (like
`screen`/`script`/`routes` are root-relative). It serves through the sandboxed
`/api/plugins/<id>/assets/...` route, so the file must be at
`<plugin>/assets/plugin.css`. The injected `<link>` is cache-busted with
`?v=<version>`, so **bump your manifest `version`** whenever you rebuild the CSS,
or browsers may serve a stale copy within a session.

## 2. Build the stylesheet — utilities only, `preflight: false`

Core already ships Tailwind's base reset (preflight) once. Your plugin must
**not** re-apply it, or it would double the reset and fight core's styles. Build
with `corePlugins: { preflight: false }` so your sheet emits **only the utility
classes your files use**.

`tailwind.config.js` (in your plugin repo):

```js
/** Plugin stylesheet build — utilities only, scanned from this plugin's files.
 *  Regenerate assets/plugin.css with: bash build-tailwind.sh                */
module.exports = {
  corePlugins: { preflight: false }, // core owns the single base reset
  content: [
    './screen.js',
    './settings.html',
    './screen.html',
    // add any other file that carries Tailwind classes (e.g. './tour.json')
  ],
  theme: {
    extend: {
      // Re-declare any core theme tokens you reference so they compile here.
      colors: {
        dark: { 900: '#050508', 800: '#0a0a12', 700: '#10101e', 600: '#181830', 500: '#1e1e3a' },
        accent: { DEFAULT: '#4080e0', light: '#60a0ff', dark: '#2060b0' },
        gold: '#e8c040',
      },
      fontFamily: { display: ['"Inter"', 'system-ui', 'sans-serif'] },
    },
  },
  // Mirror only the dynamically-built classes your code generates at runtime
  // (Tailwind can't see them textually). Drop this if you have none.
  safelist: [
    { pattern: /^(bg|text|border)-(dark|accent)(-.+)?$/ },
  ],
  plugins: [],
};
```

Input CSS — **`@tailwind utilities;` only** (no `@tailwind base`, that's the
preflight you're disabling):

`_plugin.src.css`:

```css
@tailwind utilities;
```

Build script `build-tailwind.sh` (run at your plugin's release time — the output
is committed; end users never build):

```bash
#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
# Pin the same Tailwind 3.x core uses so output stays diff-stable.
exec npx -y tailwindcss@3.4.19 \
    -c tailwind.config.js \
    -i _plugin.src.css \
    -o assets/plugin.css \
    --minify
```

```bash
bash build-tailwind.sh   # writes assets/plugin.css — commit it
```

## 3. Rules (inherited from the constitution)

- **No Play CDN, no runtime CSS JIT** — anywhere, ever. Same rule that binds core.
- **`preflight: false`** — utilities only; core ships the one base reset.
- **`styles` under `assets/`** — it serves through the sandboxed asset route;
  `..`, absolute paths, and NUL bytes are rejected by `safe_join`.
- **Bump `version` on every CSS rebuild** so the `?v=` cache-buster fetches fresh.
- Plugins without `styles` are unaffected and inject no `<link>`.

## How it works (for reference)

- The loader derives a manifest-only `has_styles` boolean and passes the `styles`
  path through to `/api/plugins` — no plugin code is imported
  (`plugins/__init__.py::_nav_entry`).
- The frontend (`static/app.js::_injectPluginStyles`) injects one
  `<link rel="stylesheet" data-plugin-id data-plugin-version
  href="/api/plugins/<id>/assets/plugin.css?v=<version>">` (the `styles` value —
  e.g. `assets/plugin.css` — appended to `/api/plugins/<id>/`) into `<head>`, **before** the
  screen markup so styles are present on first paint. It's deduped by version: a
  plugin upgrade swaps the old `<link>` for the new one; re-activation never piles
  up duplicates.
- The stylesheet is served by the existing
  `/api/plugins/<id>/assets/<path>` route as `text/css`.
