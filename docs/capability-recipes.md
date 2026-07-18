# Capability Authoring Recipes

Use these examples as small manifest fragments when migrating plugin-facing integrations to capability pipelines. The capability model is system-wide; these recipes focus on plugin manifests because core-owned domains are registered by FeedBack itself. Each example is intentionally complete enough to pass the loader contract in [plugin-manifest.schema.json](plugin-manifest.schema.json).

> **Self-hosted CSS?** If your plugin uses Tailwind classes core doesn't ship (notably arbitrary values like `text-[11px]`), declare a `styles` key and bundle your own preflight-off stylesheet — see [plugin-styles.md](plugin-styles.md). That is separate from the capability-pipeline recipes below.

## Owner And Provider

A plugin that owns a domain and handles commands declares `owner` and `provider`. Use this for a single canonical implementation in a plugin-owned domain, such as a future stem-control capability.

```json
{
  "id": "stems",
  "name": "Stems",
  "standards": ["capability-pipelines.v1", "plugin-runtime-idempotent.v1"],
  "capabilities": {
    "stems": {
      "roles": ["owner", "provider"],
      "commands": ["mute", "restore", "inspect"],
      "events": ["claim:created", "claim:released", "stems.ready"],
      "mode": "active",
      "compatibility": "none",
      "ownership": "exclusive-owner",
      "safety": "safe",
      "version": 1
    }
  }
}
```

## Requester And Observer

A plugin that requests work from another domain and listens for lifecycle events declares `requester` and `observer`.

```json
{
  "id": "example_requester",
  "name": "Example Requester",
  "standards": ["capability-pipelines.v1", "plugin-runtime-idempotent.v1"],
  "capabilities": {
    "example.plugin-domain": {
      "roles": ["requester", "observer"],
      "commands": ["apply", "restore", "inspect"],
      "events": ["claim:created", "claim:released", "example.manual-override"],
      "mode": "active",
      "compatibility": "none",
      "ownership": "requester-only",
      "safety": "safe",
      "version": 1
    }
  }
}
```

## Observer Only

A plugin that only reads public events should declare `observer` and no command handlers. In PR1, this is most useful for participants that observe the delivered `library` workflow; future plugin-owned domains can use the same pattern once promoted.

```json
{
  "id": "practice_hud",
  "name": "Practice HUD",
  "standards": ["capability-pipelines.v1"],
  "capabilities": {
    "example.plugin-domain": {
      "roles": ["observer"],
      "commands": [],
      "events": ["claim:created", "claim:released", "example.manual-override"],
      "mode": "active",
      "compatibility": "degrade-noop",
      "ownership": "observer-only",
      "safety": "safe",
      "version": 1
    }
  }
}
```

## Library Provider

A plugin that registers a remote client or generated library source declares itself as a `library` provider. The backend registration call is still made from `routes.py` with `context["register_library_provider"](...)`; the native browser library capability turns the provider registry into runtime provider participants. A thin server wrapper that only exposes the local library over HTTP should not declare `library` as a provider unless it also registers a provider in the library registry.

```json
{
  "id": "remote_library_client",
  "name": "Remote Library Client",
  "standards": ["capability-pipelines.v1"],
  "capabilities": {
    "library": {
      "roles": ["provider"],
      "operations": ["query-page", "query-artists", "query-stats", "tuning-names", "get-art", "sync-song"],
      "mode": "active",
      "compatibility": "none",
      "safety": "safe",
      "version": 1
    }
  }
}
```

## Library Requester And Observer

A route-only wrapper that uses the library capability without registering a browsable provider should declare requester/observer intent instead of provider ownership. This is a generic manifest shape for external plugins to adopt in their own repositories; it does not make the wrapper part of this PR's delivered domain set.

```json
{
  "id": "library_route_wrapper",
  "name": "Library Route Wrapper",
  "standards": ["capability-pipelines.v1"],
  "capabilities": {
    "library": {
      "roles": ["requester", "observer"],
      "requests": ["list-providers", "get-current", "inspect"],
      "observes": ["providers-refreshed", "source-changed"],
      "description": "Uses the library source list through its own route surface without registering a provider.",
      "mode": "active",
      "compatibility": "none",
      "safety": "safe",
      "version": 1
    }
  }
}
```

## Audio Mix Fader Provider

Existing plugins can keep using `window.feedBack.audio.registerFader(spec)` while migrating. The compatibility bridge records the fader as an `audio-mix` participant. New bundled code should prefer a native participant declaration plus the audio-session helper once available in its integration point.

```json
{
  "id": "delay_fx",
  "name": "Delay FX",
  "standards": ["capability-pipelines.v1"],
  "capabilities": {
    "audio-mix": {
      "roles": ["provider"],
      "operations": ["fader.get-value", "fader.set-value"],
      "events": ["fader-value-changed", "fader-unavailable"],
      "mode": "active",
      "compatibility": "none",
      "safety": "safe",
      "version": 1
    }
  }
}
```

Native audio-mix fader providers should register a stable participant id and fader id, return the committed value from every set operation, and settle get/set operations within two seconds. The player mixer displays the committed value rather than the raw requested value. If the fader is temporarily unavailable, keep the participant registered with unavailable/disabled state so the mixer can render a disabled control and diagnostics can explain why it cannot be changed.

During migration, a plugin may still call `window.feedBack.audio.registerFader(spec)`. Core maps that legacy fader into a compatibility-backed audio-mix participant and records bridge hits. If a native participant and a legacy fader represent the same logical source, the native participant owns the visible control and the legacy path is reported as compatibility-backed/overshadowed.

## Audio Effects Provider

Plugins that can provide guitar/bass processing chains should declare `audio-effects` as a provider and register at runtime with `window.feedBack.audioEffects.registerProvider(...)`. The provider returns opaque chain plans; it must not expose local filenames, URLs, native preset JSON, VST state blobs, or raw handles through diagnostics or public route state.

```json
{
  "id": "rig_builder",
  "name": "Rig Builder",
  "standards": ["capability-pipelines.v1", "plugin-runtime-idempotent.v1"],
  "capabilities": {
    "audio-effects": {
      "roles": ["provider"],
      "operations": ["chain.resolve", "chain.inspect", "segment.activate", "stage.set-bypass", "stage.set-parameter"],
      "events": ["provider-registered", "route-selected", "plan-resolved", "changed", "fallback", "bridge-hit"],
      "mode": "active",
      "compatibility": "shim-allowed",
      "safety": "sensitive",
      "version": 1
    }
  }
}
```

```js
const effects = window.feedBack && window.feedBack.audioEffects;
effects.registerProvider({
  providerId: 'rig-builder',
  pluginId: 'rig_builder',
  routeKey: 'desktop-main',
  priority: 40,
  operations: ['chain.resolve', 'segment.activate', 'stage.set-bypass', 'stage.set-parameter'],
  operationHandlers: {
    'chain.resolve': request => ({
      outcome: 'handled',
      plan: {
        schema: 'feedBack.audio_effects.chain_plan.v1',
        planId: 'song-tone-plan',
        routeKey: request.routeKey,
        providerId: 'rig-builder',
        stages: [
          { stageId: 'amp', kind: 'nam', role: 'amp', assetRef: 'rig-builder:asset:amp-main' },
          { stageId: 'cab', kind: 'ir', role: 'cab', assetRef: 'rig-builder:asset:cab-main' }
        ],
        segments: [{ segmentId: 'base', stageIds: ['amp', 'cab'] }],
        summary: { stageCount: 2 }
      }
    })
  }
});
```

User-facing controls should dispatch through the domain instead of mutating another plugin's private state:

```js
await window.feedBack.capabilities.dispatch({
  capability: 'audio-effects',
  command: 'select-chain',
  source: 'rig_builder',
  payload: { routeKey: 'desktop-main', providerId: 'rig-builder', authorization: 'user-action' }
});

const resolved = await window.feedBack.capabilities.dispatch({
  capability: 'audio-effects',
  command: 'resolve-plan',
  source: 'nam_tone',
  payload: { routeKey: 'desktop-main', target: { settingsKey: 'settings-v1-...' } }
});
```

Providers should store public song/tone routing through the host-owned mapping index and keep their own preset or chain rows private. The mapping's `provider_ref` is opaque to core: NAM Tone can use a preset id, Rig Builder can use a chain/preset id, and each provider resolves that reference in `chain.resolve`.

```js
await window.feedBack.audioEffects.upsertMapping({
  song_key: playbackTarget.settingsKey,
  filename: playbackTarget.filename, // optional migration/debug context
  tone_key: 'Dist',
  provider_id: 'rig-builder',
  provider_ref: 'chain:99',
  label: 'Full Rig Builder chain',
  source: 'manual',
  active: true
});

const mappings = await window.feedBack.audioEffects.listMappings({
  song_key: playbackTarget.settingsKey,
  tone_key: 'Dist'
});
```

Only one mapping is active for a `song_key + tone_key` at a time, but multiple providers may have rows for the same song/tone. The active row decides which provider core asks first; provider fallback remains explicit through provider priority and `fallbackProviderId` during `loadPlan(...)`.

Browser or native executors should declare both provider scope and plan scope. A NAM-only browser executor should not claim Rig Builder plans just because it can load NAM files:

```js
window.feedBack.audioEffects.registerExecutor({
  executorId: 'nam-tone-browser-wasm',
  pluginId: 'nam_tone',
  routeKey: 'desktop-main',
  providerIds: ['nam-tone'],
  supportedKinds: ['nam', 'ir'],
  maxStages: 2,
  sourceMode: 'browser',
  loadChainPlan: request => loadNamToneWasmPlan(request)
});
```

Trusted Desktop can advertise broader support, while provider-specific browser executors should keep their `providerIds`, `supportedKinds`, and `maxStages` as narrow as the runtime actually supports.

The desktop executor is the trust boundary for physical loading. It should treat `assetRef` and `stateRef` values as opaque provider references, validate them through provider-owned lookup code, enforce local policy, then load or reject processor stages. Browser diagnostics should report route/provider/outcome summaries only.

## Audio Input And Monitoring Requester

Plugins that need live instrument input should declare requester/observer intent and let the host expose redaction-safe source identity. Diagnostics must not contain raw device labels, stable hardware ids, or audio buffers.

```json
{
  "id": "note_detect",
  "name": "Note Detect",
  "standards": ["capability-pipelines.v1"],
  "capabilities": {
    "audio-input": {
      "roles": ["requester", "observer"],
      "requests": ["inspect", "list-sources", "select-source", "open-source", "close-source"],
      "observes": ["source-registered", "source-selected", "source-opened", "source-open-degraded", "source-closed", "permission-denied"],
      "mode": "active",
      "compatibility": "shim-allowed",
      "ownership": "requester-only",
      "safety": "sensitive",
      "version": 1
    },
    "audio-monitoring": {
      "roles": ["requester", "observer"],
      "requests": ["inspect", "list-providers", "select-provider", "start", "stop", "set-direct-monitor"],
      "observes": ["provider-registered", "provider-selected", "provider-selection-required", "monitoring-started", "monitoring-degraded", "monitoring-unavailable", "monitoring-failed", "monitoring-denied", "monitoring-stopped", "direct-monitor-changed"],
      "mode": "active",
      "compatibility": "shim-allowed",
      "ownership": "requester-only",
      "safety": "sensitive",
      "version": 1
    }
  }
}
```

Requesters should list or inspect sources before opening them. `inspect`, `list-sources`, and `select-source` are prompt-free and must not call provider enumeration or open live input. When a requester needs audio, it dispatches `open-source` with a purpose and required channel shape. The requester identity is taken from the dispatch `source` (the authenticated caller) — a payload-supplied `requesterId` is ignored, so a requester cannot spoof another's identity or release a shared session it does not own. Compatible requesters share one open session; each requester later dispatches `close-source`, and the provider is closed only after the last requester releases it.

```js
const api = window.feedBack.capabilities;
await api.dispatch({ capability: 'audio-input', command: 'select-source', source: 'user', payload: { logicalSourceKey: 'browser:instrument:primary' } });
const opened = await api.dispatch({
  capability: 'audio-input',
  command: 'open-source',
  source: 'note_detect', // identity for the open session; payload requesterId is ignored
  payload: { purpose: 'note-detection', requiredChannelShape: 'mono' },
});
// Keep provider-owned streams/nodes private. Diagnostics receive only opened.payload summaries.
await api.dispatch({ capability: 'audio-input', command: 'close-source', source: 'note_detect', payload: { openSessionId: opened.payload.openSessionId } });
```

Monitoring is a separate lifecycle layered on top of input readiness. A fresh live monitoring start must come from an explicit user action; background requesters can attach only when an already-active compatible session exists.

```js
const monitoring = await api.dispatch({
  capability: 'audio-monitoring',
  command: 'start',
  source: 'note_detect',
  payload: {
    authorization: 'user-action',
    requiredChannelShape: 'mono',
    directMonitorRequirement: 'muted'
  },
});

if (monitoring.outcome === 'user-action-required') {
  // Show your own UI affordance; do not trigger a device prompt in the background.
}

await api.dispatch({
  capability: 'audio-monitoring',
  command: 'stop',
  source: 'note_detect',
  payload: { monitoringId: monitoring.payload && monitoring.payload.monitoringId },
});
```

## Audio Input Provider

Native input providers register redaction-safe source summaries with stable logical keys. Use `source.enumerate` only for an explicit user/provider discovery action; normal list/inspect/select flows should use already-registered summaries.

```json
{
  "id": "desktop_audio",
  "name": "Desktop Audio",
  "standards": ["capability-pipelines.v1"],
  "capabilities": {
    "audio-input": {
      "roles": ["provider", "observer"],
      "operations": ["source.enumerate", "source.open", "source.close"],
      "events": ["source-registered", "source-opened", "source-closed", "source-open-degraded", "permission-denied"],
      "mode": "active",
      "compatibility": "none",
      "safety": "sensitive",
      "version": 1
    }
  }
}
```

Provider source records should include `sourceId`, `providerId`, `logicalSourceKey`, `kind`, safe label or diagnostics pseudonym, availability, `channelSummary`, and supported operations/handlers. Do not put browser `MediaStream`, `AudioNode`, native handles, buffers, samples, waveform data, raw device labels, stable hardware ids, paths, or secrets in returned payloads; keep those in provider-private state.

## Audio Monitoring Provider

Native monitoring providers register a stable `logicalMonitoringKey` and keep actual audio streams, native handles, and device labels provider-private. The core host coordinates selected provider, requester sharing, direct-monitor policy, and diagnostics, but the provider owns the actual live monitor graph.

```json
{
  "id": "desktop_audio",
  "name": "Desktop Audio",
  "standards": ["capability-pipelines.v1"],
  "capabilities": {
    "audio-monitoring": {
      "roles": ["provider", "observer"],
      "operations": ["monitoring.start", "monitoring.stop", "monitoring.status", "monitoring.set-direct-monitor"],
      "events": ["provider-registered", "monitoring-started", "monitoring-stopped", "direct-monitor-changed"],
      "mode": "active",
      "compatibility": "none",
      "safety": "sensitive",
      "version": 1
    }
  }
}
```

Provider records should include `providerId`, `logicalMonitoringKey`, safe label or diagnostics pseudonym, `availability`, `sourceMode`, supported operations, `directMonitor` summary, and `latencySummary`. `monitoring.start` receives a redaction-safe `sourceRef`, `requesterId`, `requiredChannelShape`, `directMonitorPreference`, and optional `directMonitorRequirement`; it should return only status summaries such as active/degraded/denied/unavailable/failed. `monitoring.status` must be prompt-free and must not open audio input. `monitoring.set-direct-monitor` may apply the user's preference for active sessions; requester requirements must never mutate the user's stored preference.

## Stems Provider Behind Audio Session Coordination

The Stems plugin remains the provider/owner of actual stem playback state. `core.audio.session` coordinates dispatch, claims, overrides, orphan detection, and diagnostics, but it does not replace the provider.

```json
{
  "id": "stems",
  "name": "Stems",
  "standards": ["capability-pipelines.v1", "plugin-runtime-idempotent.v1"],
  "capabilities": {
    "stems": {
      "roles": ["owner", "provider"],
      "commands": ["mute", "restore", "inspect"],
      "operations": ["stem.get-state", "stem.apply-automation", "stem.restore-automation"],
      "events": ["owner-available", "automation-applied", "automation-restored", "automation-overridden", "claim-orphaned"],
      "mode": "active",
      "compatibility": "shim-allowed",
      "ownership": "exclusive-owner",
      "safety": "safe",
      "version": 1
    }
  }
}
```

## Playback Requester And Observer

Plugins that need to inspect or coordinate song transport should declare `playback` requester/observer intent and use the capability dispatch surface instead of wrapping `window.playSong` or scraping the `<audio>` element. Raw media handles stay private to core; diagnostics expose only pseudonymous targets, sanitized timing, route, loop, requester, observer, and recent outcome summaries.

```json
{
  "id": "practice_hud",
  "name": "Practice HUD",
  "standards": ["capability-pipelines.v1"],
  "capabilities": {
    "playback": {
      "roles": ["requester", "observer"],
      "requests": ["inspect", "pause", "resume", "seek", "set-loop", "clear-loop"],
      "observes": ["ready", "started", "paused", "resumed", "seeking", "seeked", "stopped", "loop-set", "loop-cleared"],
      "mode": "active",
      "compatibility": "shim-allowed",
      "ownership": "requester-only",
      "safety": "safe",
      "version": 1
    }
  }
}
```

Fresh audible starts require a user action. Background plugins should call `inspect` first and attach to an existing compatible session; if a plugin needs to offer a play/start action, wire it to a visible user gesture and pass `authorization: "user-action"`.

```js
const api = window.feedBack.capabilities;

const state = await api.dispatch({
  capability: 'playback',
  command: 'inspect',
  source: 'practice_hud',
  args: {},
});

if (state.status !== 'idle') {
  await api.dispatch({
    capability: 'playback',
    command: 'seek',
    source: 'practice_hud',
    args: { time: 42.0, reason: 'practice segment jump' },
  });
}
```

During migration, legacy uses of `window.playSong`, `song:*` events, `window.feedBack.seek`, and loop helpers remain available and are recorded as playback bridge hits. Treat bridge hits as migration telemetry: native capability requests should eventually cover normal plugin workflows so unexpected legacy hits disappear from diagnostics.

## Progression Requester And Observer

Plugins that report gameplay outcomes or react to player progression (spec 010) should declare `progression` requester/observer intent and use capability dispatch instead of private fetches. Externally postable event types are whitelisted (`minigame_run` in v1); `song_completed` is server-derived inside `/api/stats` and is denied at this surface. Backend plugin code can use the plugin-context hook `record_progression_event` instead (the minigames hub does).

```json
{
  "id": "my_minigame",
  "name": "My Minigame",
  "standards": ["capability-pipelines.v1"],
  "capabilities": {
    "progression": {
      "roles": ["requester", "observer"],
      "requests": ["inspect", "record-event"],
      "observes": ["challenge-completed", "quest-completed", "path-level-up", "rank-changed", "db-changed"],
      "mode": "active",
      "compatibility": "none",
      "ownership": "requester-only",
      "safety": "safe",
      "version": 1
    }
  }
}
```

`buy-item` and `equip-item` require a visible user gesture (`authorization: "user-action"`). Decibels are play-earned only; plugins must not present any purchase path.

```js
const api = window.feedBack.capabilities;

const result = await api.dispatch({
  capability: 'progression',
  command: 'record-event',
  source: 'my_minigame',
  payload: { type: 'minigame_run', payload: { game_id: 'my-minigame', score: 420 } },
});
// result.payload lists challenges/quests completed by this event (toast UX).

window.feedBack.on('progression:quest-completed', (e) => {
  console.log('quest done:', e.detail.title, '+' + e.detail.reward_db + ' dB');
});
```

## Chart-Transform Provider

Plugins that remap chart data — retuning to another instrument, simplification, exercise generation — register as `chart-transform` providers (#952) instead of forking a renderer. The substituted chart reaches every consumer: built-in 2D highway, custom viz (bundle), overlays/scorers (getters), on the primary highway and announced splitscreen instances.

```json
{
  "id": "my_transform",
  "name": "My Transform",
  "standards": ["capability-pipelines.v1"],
  "capabilities": {
    "chart-transform": {
      "roles": ["provider"],
      "operations": ["chart.transform"],
      "mode": "active",
      "compatibility": "degrade-noop",
      "ownership": "multi-provider",
      "safety": "safe",
      "version": 1
    }
  }
}
```

```js
const api = window.feedBack.capabilities;

await api.dispatch({
  capability: 'chart-transform',
  command: 'register-provider',
  source: 'my_transform',
  payload: {
    providerId: 'my_transform',
    label: 'My Transform',
    transform(input) {
      // input: { notes, chords, anchors, allNotes, allChords,
      //   chordTemplates, handShapes, stringCount, songInfo }
      // notes/chords/anchors/handShapes are DIFFICULTY-FILTERED (the
      // transform applies after the mastery filter). Return any subset of
      // { notes, chords, anchors, allNotes, allChords, chordTemplates,
      //   handShapes, stringCount, tuning, capo, centOffset } — or
      // null/undefined to pass the chart through untouched.
      if (!/\bguitar|bass|lead|rhythm|combo\b/i.test(input.songInfo?.arrangement || '')) return null;
      return { notes: remap(input.notes) };
    },
  },
});

// User toggles it on (selection persists and restores on re-registration):
await api.dispatch({ capability: 'chart-transform', command: 'select-provider',
  source: 'my_transform', payload: { providerId: 'my_transform' } });

// Settings changed mid-song? Re-run the installed transform live:
await api.dispatch({ capability: 'chart-transform', command: 'refresh', source: 'my_transform' });
```

The transform runs once per chart change (ready, mastery recompute, refresh) — never per frame. The host copies and time-sorts accepted timeline arrays before staging them. A throwing transform is skipped for that pass (the original chart renders) and surfaces as the `transform-failed` event with a fixed public reason; raw exception details remain local to the console. `getSongInfo()` keeps the chart's original tuning/capo by contract; export `tuning` as standard-relative offsets for your target string count so scoring consumers judge the target instrument via `bundle.tuning`/`bundle.capo`/`bundle.centOffset`.

## Future Expansion Domains

Some domain names are reserved for expected future contracts, but they are not registered in the runtime graph yet. For example, `ui.player-panels` is documented as a likely panel-host surface, but FeedBack does not currently expose a capability command for panel contributions. See [capability-roadmap.md](capability-roadmap.md) for the PR1 domain set and deferred-domain checklist.

Plugins should not declare future expansion domains until the corresponding host workflow ships. For current integrations, prefer active domains such as `library`, `playback`, `audio-mix`, `audio-input`, `audio-monitoring`, or `stems` intent matching the recipes above.

Invalid capability metadata is excluded from the capability graph, but legacy manifest fields still load through their existing app paths. The `library` workflow is native in PR1 and does not use compatibility shim metadata. Unsupported `capability-pipelines` versions are reported as incompatible and their runtime handlers must not execute.

## Library Card Action (`ui.library-card-injection`)

Delivered in fee[dB]ack v0.3.0 (frontend host). Plugins add per-song actions to
the library cards by REGISTERING them instead of DOM-injecting onto
`.song-card`. The library renders applicable actions in each card's action
menu, dispatches the handler on click, and emits `action-result` events;
the owner is visible in the Capability Inspector.

```json
{
  "id": "my_card_action",
  "name": "My Card Action",
  "standards": ["capability-pipelines.v1"],
  "capabilities": {
    "ui.library-card-injection": {
      "roles": ["provider"],
      "operations": ["action.run"],
      "events": ["action-registered", "action-result"],
      "mode": "active",
      "compatibility": "none",
      "safety": "safe",
      "version": 1
    }
  }
}
```

Register the action from the plugin's `screen.js`:

```js
window.feedBack.libraryCardActions.register({
  id: 'my_card_action.run',
  pluginId: 'my_card_action',
  label: 'Do the thing',
  placement: 'menu',                 // 'menu' | 'inline' | 'overlay'
  order: 50,
  applies: (song) => song.format === 'sloppak',  // shown only when relevant
  enabled: (song) => true,
  run: async (song, ctx) => {        // ctx.source identifies the surface
    await fetch('/api/plugins/my_card_action/run', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ filename: song.filename }),
    });
  },
});
```

`register(spec)` returns an `unregister()` fn. The host owns rendering,
applicability, enabled state, and `action-result` events — plugins do not touch
library DOM. Legacy `.song-card` DOM injection still works in the 0.2.x UI;
migrate to this for the v0.3.0 native library.
