# feedBack-plugin-minigames

The minigame framework for [FeedBack](https://github.com/got-feedback/feedBack).

This plugin provides:

- A **Minigames hub** screen that discovers every installed minigame plugin and lists them as tiles with leaderboards.
- A **shared profile** (XP, level, unlocks, totals) that aggregates runs across every minigame.
- A JS **SDK** exposed at `window.feedBackMinigames` that minigame plugins use to access scoring, HUD primitives, run persistence, and a scheduler — so individual minigames do not need their own DSP or backend.

## Writing a minigame

A minigame is a standard FeedBack plugin that:

1. Adds a `minigame` block to its `plugin.json`:

   ```json
   {
     "id": "my_game",
     "name": "My Game",
     "version": "0.1.0",
     "script": "game.js",
     "minigame": {
       "title": "My Game",
       "tagline": "Short pitch",
       "type": "chart-free",
       "scoring": "pitch-continuous",
       "thumbnail": "thumb.png"
     }
   }
   ```

2. On script load, registers itself with the SDK using the safe late-binding
   pattern (minigame plugins may load before the SDK; the pending queue
   handles both orderings — the SDK drains it on init, and the
   `feedBack-minigames-ready` event is an alternative for plugins that prefer
   event-driven registration):

   > **Important:** `spec.id` must exactly match the `id` field in `plugin.json`.
   > The backend registry uses `plugin_id` (sourced from `plugin.json`) and the
   > hub UI merges manifest metadata (title, tagline, thumbnail, modifiers) by
   > that key. If `spec.id` and `plugin.json` `id` diverge, runs and leaderboard
   > data will be attributed to an unrecognised game and display metadata (title,
   > thumbnail) will fall back to JS-spec values rather than the richer manifest
   > values.

   ```js
   const spec = {
     id: 'my_game',
     start: ({ container, modifiers, sdk }) => { /* mount game into container */ },
     stop:  () => { /* tear down */ },
   };

   if (window.feedBackMinigames) {
     window.feedBackMinigames.register(spec);
   } else {
     (window.__feedBackMinigamesPending = window.__feedBackMinigamesPending || []).push(spec);
   }
   ```

3. Calls `window.feedBackMinigames.end({ score, durationMs, modifiers, meta })` when the run ends.

See [`feedBack-plugin-flappy-bend`](https://github.com/got-feedback/feedBack-plugin-flappy-bend) for a working example.

## SDK reference

`window.feedBackMinigames` exposes:

- `register(spec)` — declare a minigame
- `start(gameId, opts)` / `end(result)` — lifecycle
- `scoring.createContinuous(opts)` — emits per-frame pitch (YIN, ~60 Hz)
- `scoring.createDiscrete(opts)` — wraps `createNoteDetector`, emits hit/miss
- `scoring.createChord(opts)` — full chord scorer (delegates to note_detect)
- `ui.mountHUD(html)` / `ui.runSummary(result)` / `ui.modifierPicker(defs)`
- `submitRun(...)` / `getLeaderboard(...)` / `getProfile()`
- `scheduler.every(ms, cb)` / `in(ms, cb)` / `cancel(id)`

## Dependencies

- `feedBack-plugin-notedetect` >= 1.10.0 — required for discrete/chord scoring modes (continuous mode is self-contained).
