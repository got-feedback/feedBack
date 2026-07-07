# Plugin ES-module migration playbook

How to move a plugin off a single global-scope `screen.js` IIFE onto a native
ES-module graph — **no build step, no framework, no bundler**. This is the
mechanism the monolith-killing refactor uses; the host rails for it shipped in
R0 (see `.specify/memory/constitution.md` Principle II + the "Module load
contract" in Operating Constraints).

## The shape

```
my-plugin/
  plugin.json      +  "scriptType": "module"        ← opt in
  screen.js           import './src/main.js';        ← the entire file
  src/
    state.js          (0) module state + accessors
    util/…            (1) pure helpers — real-import testable
    …/…               (2..4) model → render/audio/io → input
    globals.js        (5) THE ONLY file that writes window.*
    main.js           (5) boot: wire modules, register screen:changed
  assets/…            worklets / WASM / images (unchanged, served as today)
```

`screen.js` becomes a one-line static `import`. The host injects it as
`<script type="module">`, whose load event fires **only after the whole
static-import graph fetches and evaluates** — so the loader's
completion-by-`onload` + `_loadingPluginId` window + `playSong` wrapper-chain
order are all preserved. (A classic IIFE that fired a fire-and-forget
`import()` would break that contract — don't do that; use `scriptType:"module"`.)

## Non-negotiable rules

1. **Source-served, no build.** Modules are plain source files fetched from
   `/api/plugins/<id>/src/<path>`. No bundler, transpiler, or TypeScript.
2. **Layering points downward** — `state → util → commands/model →
   render/audio/io → input → globals/main`. A lint check (`import-x/no-cycle`)
   enforces acyclicity; extract bottom-up so each move only imports
   already-extracted layers.
3. **`globals.js` is the only writer of `window.*`.** The deliberate global
   surface shrinks to one auditable file; everything else is module-scoped.
4. **Import-time purity.** `node --test` runs a module's top-level code on
   import, so a module you want to unit-test must be side-effect-free at import:
   no `document` / `window` / `localStorage` at module top level — lift init
   into an exported `init()` called by `main.js`. (Constitution Principle V's
   "no implicit IO at import time", applied to the frontend.) Tests are `.mjs`
   and use real `import`, retiring the regex/`extractFunction` harness.
5. **Assets resolve via `import.meta.url`.** `document.currentScript` is `null`
   inside a module. For a worklet/WASM/image under `assets/`, use
   `new URL('assets/x.js', import.meta.url)` — or the absolute route path
   `/api/plugins/<id>/assets/x.js`. Worklets run in a *separate* module graph
   (`AudioWorkletGlobalScope`) and cannot share modules with `src/`.
6. **Re-init comes from `screen:changed`, not re-execution.** The host loads
   `screen.js` once per version and `showScreen` re-injects nothing, so module
   top-level code does **not** re-run when the user re-enters the screen at the
   same version. Keep per-visit setup/teardown in a `window.feedBack.on(
   'screen:changed', …)` handler — exactly as classic plugins (tuner,
   minigames) already do. Do not rely on the IIFE re-running.
7. **Inline `onclick=` keeps working** during migration via `globals.js` (which
   keeps every referenced symbol on `window`); retire inline handlers to
   module-side `addEventListener` opportunistically, never as a blocking step.

## The live-edit loop

The host serves `screen.js`, `src/**`, and `assets/**` with
`Cache-Control: no-cache` + a weak `ETag` and honors `If-None-Match` → `304`.
So: edit a `src/` file → **refresh the browser** → the edited module returns
`200` and reloads while every unchanged module `304`s. There is no hot-reload;
the loop is edit → refresh → see change, exactly as before. The `?v=<version>`
query on `screen.js` is the legacy version buster; it does **not** propagate
into the `src/` graph and does not need to — ETag/mtime is the correctness
authority for the whole graph.

## Host-version floor (`minHost`)

A migrated plugin *requires* a host new enough to serve `src/` and inject
`type=module`. Declare the floor with `"minHost": "X.Y.Z"` in `plugin.json`.
(R0 plumbs the field through `/api/plugins`; enforcement — refuse-with-message
on an older host — is deferred, so bundled plugins are unaffected. Community
plugins should state the floor and not migrate below it.)

## Migration mechanics

- **Move-only PRs.** One slice extracts one module: cut code, add
  imports/exports, update `globals.js` — zero behavior change. Behavior fixes
  are separate PRs. (Init-lifts for import purity are the one non-pure move —
  budget them.)
- **Bottom-up, layer by layer.** Within a layer, independent modules are
  independent PRs (a DAG, not a chain); use a git worktree per branch.
- Tests move with their subject and convert to real `.mjs` imports in the same
  PR (assertions unchanged).
- Size norm: no source file over **1,500 lines**; legitimate exceptions
  (hot renderers, etc.) go in the signed register at `docs/size-exemptions.md`.

## Verifying a migration

`node --test <plugin>/tests/*.mjs`; load the plugin on the `:8000` testbed and
confirm it boots (`<script type=module>` in DevTools, the `src/` graph in
Network); edit a `src/` file → refresh → change visible (`200` on the edited
file, `304` on the rest); leave and re-enter the screen at the same version →
it re-inits via `screen:changed`. The R1 pilots (stems, then studio) certify
this end-to-end before the flagship repos migrate.
