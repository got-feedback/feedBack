# Capability Domains

Capability domains are Slopsmith-wide coordination surfaces for core, bundled first-party plugins, external plugins, and future adapters. Plugins declare the runtime surfaces they use in `plugin.json`; core declares and owns host workflows directly in the runtime. These declarations let diagnostics and support tools reason about behavior without relying on private globals.

## Standards

Migrated plugins should declare standards explicitly:

```json
{
  "standards": ["capability-pipelines.v1", "plugin-runtime-idempotent.v1"]
}
```

Only declare `plugin-runtime-idempotent.v1` when repeated script hydration cannot duplicate wrappers, listeners, timers, DOM roots, diagnostics contributors, jobs, media nodes, or capability participants.

## UI Contributions

New plugin UI should declare stable `ui` contribution metadata so diagnostics and support tools can attribute surfaces before runtime code hydrates. The runtime host for UI placement is still promoted by a future UI-host PR, but manifests can use the candidate shape now:

```json
{
  "ui": {
    "ui.navigation": [{ "id": "my-plugin-nav", "region": "plugins", "label": "My Plugin" }],
    "ui.plugin-screens": [{ "id": "my-plugin-screen", "region": "plugin-screens", "label": "My Plugin" }],
    "settings": [{ "id": "my-plugin-settings", "region": "plugin-settings", "label": "My Plugin" }]
  }
}
```

## Runtime Domains

Declare non-UI runtime surfaces under `capabilities`:

```json
{
  "capabilities": {
    "library": {
      "roles": ["provider"],
      "operations": ["query-page", "query-artists", "query-stats"],
      "mode": "active",
      "compatibility": "none",
      "safety": "safe",
      "version": 1
    }
  }
}
```

Backend route metadata should support a declared capability domain. A generic `backend.routes` domain is deferred until a future PR has a concrete route/provider workflow and privilege review.

Plugins that call `context["register_library_provider"](...)` are attributed to the loading plugin id in `/api/library/providers` as `owner_plugin_id`. The browser library capability module at [static/capabilities/library.js](../static/capabilities/library.js) owns the `library` domain as a `provider-coordinator`: it refreshes `/api/library/providers`, registers the built-in `local` provider as `core.library.local`, and registers plugin-backed providers under their `owner_plugin_id` when one is known. Provider manifests should still declare the `library` capability so diagnostics and the bundled inspector can show intended relationships before the backend route code runs.

Route-only external plugins that participate in library workflows without registering a browsable provider declare requester/observer intent instead of provider ownership when they adopt this contract in their own repositories. This PR documents the generic shape only: such plugins use `library` requester/observer `requests` and `observes` declarations and do not appear as providers, owners, or separate `backend.routes` domains.

```json
{
  "capabilities": {
    "library": {
      "roles": ["provider"],
      "operations": ["query-page", "query-artists", "query-stats", "tuning-names", "get-art", "sync-song"],
      "description": "Adds a browsable library source and optional song sync.",
      "mode": "active",
      "compatibility": "none",
      "safety": "safe"
    }
  }
}
```

The frontend exposes the current source list through `window.slopsmith.capabilities.command('library', 'list-providers')`. Public owner commands (`list-providers`, `refresh-providers`, `get-current`, `select-provider`, `sync-song`, `inspect`) are distinct from provider operations (`query-page`, `query-artists`, `query-stats`, `tuning-names`, `get-art`, `sync-song`). The app-owned handler delegates to the existing provider registry and source selector, so plugins should not scrape the `#lib-provider` dropdown.

Capability declarations may include a short `description`. The bundled Capability Inspector shows that text on expanded domain owner cards; when it is omitted, the inspector falls back to a compact generated owner summary.

## Audio Graph/Session Domains

The audio graph/session slice promotes four player-audio domains into the runtime graph: `audio-mix`, `audio-input`, `audio-monitoring`, and `stems`. The browser module at [static/capabilities/audio-session.js](../static/capabilities/audio-session.js) owns the active session boundary, contributes diagnostics under `slopsmith.audio_session.diagnostics.v1`, and records compatibility bridge hits for older audio surfaces.

`audio-mix`, `audio-input`, and `audio-monitoring` are core-owned provider-coordinator domains. They expose bounded inspect/register/start/stop style commands, redaction-safe diagnostics, and bridge accounting for older fader, analyser, input, and monitoring handshakes.

For `audio-mix`, native fader providers register mix participants with stable `participantId`, `kind`, `sourceMode`, optional `logicalFaderKey`, and `fader` metadata. The public command surface is `inspect`, `list-faders`, `get-fader-value`, `set-fader-value`, `inspect-route`, `inspect-analyser`, `register-participant`, and `unregister-participant`; provider operations are `fader.get-value`, `fader.set-value`, `route.get-current`, and `analyser.get-summary`. Providers own persistence for plugin faders and must return committed values from set operations so the player mixer can display the value that actually applied.

Audio-mix diagnostics live under `slopsmith.audio_session.diagnostics.v1`. The `audio-mix` domain snapshot includes session state, participants, visible fader summaries, required participant-kind coverage, route summary, analyser summary, bridge hits, and bounded recent outcomes. Fader outcomes include operation name, participant id, fader id, status such as `committed`, `normalized`, `unavailable`, or `timeout`, and a bounded reason. Diagnostics must not include raw audio buffers, FFT arrays, device labels, stable hardware identifiers, secrets, or unredacted local paths; route/analyser payloads are summaries only.

For `audio-input`, native providers register source summaries with `sourceId`, `providerId`, `logicalSourceKey`, `kind`, redaction-safe label/pseudonym, `availability`, `channelSummary`, `sourceMode`, and provider operations. The public command surface is `inspect`, `list-sources`, `register-source`, `unregister-source`, `select-source`, `open-source`, and `close-source`; provider operations are `source.enumerate`, `source.describe`, `source.open`, and `source.close`. `inspect`, `list-sources`, and `select-source` are prompt-free and never open live input or call enumeration. `source.enumerate` runs only when explicitly requested by provider/user discovery. `open-source` is the permission boundary: it routes to `source.open`, attributes the requester, checks the selected source and requested channel shape, and records `handled`, `denied`, `degraded`, `failed`, `no-owner`, `no-handler`, `unsupported-command`, or `incompatible-version` outcomes.

Selected input is persisted by `logicalSourceKey` when browser storage is available. If storage is unavailable, the in-memory selection remains usable for the current session and diagnostics report the storage status. Start/stop/song switches preserve selected input independently of playback transport while clearing live open sessions. Compatible requesters share one open session per logical source and channel shape; requester references are released via `close-source`, and the provider receives `source.close` only after the last requester releases.

Compatibility-backed input sources are retained for diagnostics only when a native provider supersedes the same logical source key. Removal gates for input bridges are: native providers cover bundled source discovery/open flows, diagnostics show no unexpected compatibility hits in normal playback, denied/unavailable/failure outcomes are distinguishable, repeated hydration does not create duplicate sources, and support snapshots contain no raw device labels, hardware ids, paths, secrets, live handles, buffers, samples, or waveform data.

For `audio-monitoring`, native providers register monitoring summaries with `providerId`, `logicalMonitoringKey`, redaction-safe label/pseudonym, `availability`, `sourceMode`, provider operations, `directMonitor`, and `latencySummary`. The public command surface is `inspect`, `list-providers`, `register-provider`, `unregister-provider`, `select-provider`, `start`, `stop`, and `set-direct-monitor`; provider operations are `monitoring.start`, `monitoring.stop`, `monitoring.status`, and `monitoring.set-direct-monitor`. `inspect`, `list-providers`, `select-provider`, and `monitoring.status` are prompt-free and must not open audio input or start monitoring.

Fresh monitoring start is a user-action boundary. A requester that calls `start` without `authorization: "user-action"` receives `user-action-required` unless it can attach to an already-active compatible monitoring session. Start dispatch opens the selected audio-input source through the `audio-input` domain, checks the requested channel shape, and then calls the provider's `monitoring.start` with a redaction-safe `sourceRef`, requester id, required channel shape, direct-monitor preference, and optional requester requirement. Outcomes distinguish `handled`, `degraded`, `denied`, `unavailable`, `failed`, `no-owner`, `no-handler`, `unsupported-command`, `incompatible`, `incompatible-version`, `provider-selection-required`, and `user-action-required`.

Monitoring sessions are keyed by provider, selected source, required channel shape, and direct-monitor policy. Compatible requesters share an active session without re-calling `monitoring.start`; each requester later calls `stop`, and the provider receives `monitoring.stop` only after the final requester releases it. Song switches and playback stops preserve active monitoring sessions for the current browser runtime, while page reload restores only the selected provider and direct-monitor preference; live monitoring stays stopped until a new explicit start.

Direct-monitor state is user-authoritative. `set-direct-monitor` updates the user's/default preference and applies provider control to active sessions only when the provider supports it. Requester `directMonitorRequirement` values are advisory constraints: when they conflict with the user's preference or provider support, the requester/session is marked degraded or unsupported, but the stored user/default preference is not changed.

Compatibility-backed monitoring providers are retained for diagnostics only when a native provider supersedes the same logical monitoring key. Removal gates for monitoring bridges are: native providers cover bundled start/stop/status/direct-monitor flows, normal playback shows no unexpected compatibility hits, background requesters cannot silently start live monitoring, repeated hydration does not duplicate providers or sessions, and support snapshots contain no raw device labels, hardware ids, paths, secrets, live handles, buffers, samples, waveform data, recordings, or provider-private payloads.

`stems` is different: `core.audio.session` is a coordinator, not the semantic owner of stem playback. The Stems plugin, or another active stem provider, remains the provider/owner of actual stem state, mute/restore mechanics, and per-song availability. The session coordinator records the active provider via `registerStemOwner(...)`, brokers claim/override/orphan diagnostics, and returns `no-owner` when no stem provider is available.

New bundled audio code should use the session host or native capability dispatch instead of adding new globals, private stem-state reads, direct analyser ownership, or plugin-specific handshakes.

## Playback Control Plane

The playback slice promotes `playback` as a core-owned command domain implemented by [static/capabilities/playback.js](../static/capabilities/playback.js). The public command surface is `inspect`, `start`, `pause`, `resume`, `stop`, `seek`, `set-loop`, `clear-loop`, `register-requester`, and `register-observer`. The domain emits `playback:*` lifecycle events for requests, loading, ready/start/pause/resume/seek/stop/end, route transitions, loop changes, failures/degraded states, superseded sessions, and compatibility bridge hits.

`static/app.js` remains the transport data plane. It registers a private playback adapter that can start songs, pause/resume/stop, seek, and manage loops, but the capability snapshot never exposes the `<audio>` element, JUCE player object, raw audio buffers, native route handles, samples, waveforms, recordings, local file paths, or URL payloads. Exported diagnostics use pseudonymous `target-*` ids for arrangement-scoped identity and hashed `settings-*` keys for per-song plugin settings; the local Capability Inspector may show visible title, artist, and arrangement labels for the active song.

Fresh audible `start` commands require `authorization: "user-action"`; background requesters may inspect or control an existing session, but user-priority pause/stop decisions block lower-priority automation until a user action resumes or starts a new session.

## Capability Roles

Use capability declarations for provider/requester/observer relationships:

```json
{
  "capabilities": {
    "library": {
      "roles": ["requester", "observer"],
      "requests": ["list-providers", "get-current", "inspect"],
      "observes": ["providers-refreshed", "source-changed"],
      "mode": "active",
      "compatibility": "none"
    }
  }
}
```

Future app-level workflows can then express intent through capability domains instead of hard-coding plugin-private implementation details.

Core registers manifest capability declarations from `/api/plugins` before plugin scripts hydrate. Runtime owners can then re-register the same participant with command handlers, event handlers, and current availability state. The merged participant view is visible through `window.slopsmith.capabilities.snapshotDiagnostics()` and `getDiagnostics()`.

Core domains include review metadata in diagnostics:

- `active`: wired to current Slopsmith behavior and expected to work as an integration point.
- `diagnostic`: support/inspection-only runtime surfaces.

PR1 includes only the delivered domains listed in [capability-roadmap.md](capability-roadmap.md): `pipeline`, `diagnostics`, and `library`. The follow-up audio graph/session slice promotes `audio-mix`, `audio-input`, `audio-monitoring`, and a coordinated `stems` surface. The playback slice promotes `playback` as an active transport control plane. Backend routes, app UI, settings, visualization, note-detection, and other hardware-facing domains remain documented in the roadmap and safety matrix until their own host workflow/provider slice exists.

Capability metadata is versioned by the `capability-pipelines.v1` standard. Invalid roles, commands, operations, requests, observes, emits, events, owner kinds, compatibility modes, ownership policies, safety classes, or version fields are excluded from the capability graph and surfaced through `capability_validation_warnings`. Plugins that declare a future `capability-pipelines` version are reported through `capability_unsupported_versions` and their runtime handlers are marked incompatible.

`diagnostics` and `pipeline` are adjacent support domains. `diagnostics` is the read-only snapshot/export surface: `snapshot` returns the redaction-safe state used by support bundles and the Capability Inspector. `pipeline` is the graph operations surface: `inspect`, `validate`, and `participant.set-enabled` operate on the capability graph itself and emit graph lifecycle events such as `resolved`, `runtime.validated`, and `participant.state-changed`.

Requesters should use the public claim/dispatch/release flow instead of mutating another plugin's globals:

```js
const api = window.slopsmith.capabilities;
const releaseClaim = api.claim({ capability: 'example.plugin-domain', claimId: 'example.automation-active', requester: 'example_requester' });
await api.dispatch({
  capability: 'example.plugin-domain',
  command: 'apply',
  source: 'example_requester',
  claim: { claimId: 'example.automation-active' },
  args: { target: { kind: 'example-target' } },
});
releaseClaim();
```

The claim owner is inferred from the active owner participant for the capability, so requesters should identify themselves with `requester` or `source` instead of passing an `owner` field. `release` only needs the `claimId` and, when useful for disambiguation, the `capability`.

Manual user actions win over matching automation claims. When an owner records a user override for the same capability target, the registry reports the command as `overridden` and skips re-applying automation for that target. Owners keep restore snapshots for their own surfaces so requesters do not need to read private state.

When a requester disappears, the registry releases its active claims and clears restore snapshot references. When an owner or live handler disappears, matching claims become `orphaned` and non-dispatchable until the user or owning plugin resolves them. Runtime enable/disable state is lifecycle metadata, not a manual override.

## Owner Kinds And Dispatch Outcomes

Owner participants use a `kind` that describes how the domain is coordinated:

- `command`: one active owner handles public commands.
- `provider-coordinator`: one owner coordinates provider participants through provider operations.
- `event`: the owner primarily emits or coordinates events.
- `diagnostic`: read-only support and inspector surfaces.
- `privileged`: command execution needs an explicit enforcement plan before shipping.

New domains should prefer `kind` plus participant roles. Ownership is derived for core owners where possible: `provider-coordinator` behaves like a multi-provider domain, diagnostics are diagnostic-only, privileged owners are privileged, and command/event owners are exclusive by default.

The compatibility ownership vocabulary remains:

- `exclusive-owner`: at most one active owner; duplicate owners produce a conflict and dispatch degrades.
- `multi-provider`: multiple providers may participate, but ordering must be deterministic through fixed priority or `before`/`after` constraints.
- `observer-only`: participants listen for events and should not handle commands.
- `requester-only`: participants request commands from another owner.
- `privileged`: command execution needs an explicit enforcement plan before shipping.
- `diagnostic-only`: read-only support and inspector surfaces.

Dispatch results use explicit outcomes: `handled`, `transformed`, `denied`, `failed`, `degraded`, `short-circuited`, `overridden`, `no-owner`, `no-handler`, `no-target`, `unsupported-command`, `incompatible`, `incompatible-version`, `unavailable`, `provider-selection-required`, `user-action-required`, `stale`, `cancelled`, and `stopped`. No-owner, no-handler, no-target, unsupported-command, incompatible, incompatible-version, provider-selection-required, user-action-required, stale, and cancelled decisions are recorded in diagnostics so support bundles explain why nothing happened.

## Deferred Core Adapters

UI placement, settings contributions, visualization, and note-detection are real Slopsmith surfaces, but they are not PR1 capability contracts. Audio mixer/session domains are active as of the audio graph/session slice, and playback is active as of the playback control-plane slice. For remaining areas, document the capability gap and avoid adding new private integration surfaces until the corresponding domain PR ships the host workflow, command/event contract, diagnostics fields, and tests.

The library provider workflow is the PR1 core adapter and is implemented natively as the `library` capability module. Provider refresh, selection, and sync run through `library` owner commands; backend provider registration remains the way providers enter the library registry, and the browser module turns that registry into provider participants. Playback mirrors song transport, route, seek, and loop lifecycle into `playback`, while navigation, note, visualization, route-only, and highway rendering surfaces remain outside capability domains until their own slices land.

The direct `window.highway` object remains the renderer data plane. Per-frame reads such as notes, chords, beats, and renderer hooks should not be moved behind asynchronous capability commands until there is a dedicated chart/render facade.

## First-Party Management Plugins

Large management surfaces should prefer plugin-owned UI over crowding normal Settings. First-party management plugins can contribute screens and settings panels while core keeps shared services and diagnostics contracts centralized.

The bundled Capability Inspector plugin is the support surface for the current graph. It reads `window.slopsmith.capabilities.snapshotDiagnostics()`, filters by domain, and summarizes manifest participants, runtime participants, conflicts, unsupported versions, safety classes, expected compatibility event surfaces, and compatibility shim hits without rendering raw runtime objects. Domains are grouped in review order: application/library, player/audio runtime, plugin-defined surfaces, then capability runtime. In the all-domains view, each domain starts collapsed with a domain-specific icon plus compact summary badges for participant-lane count, endpoint count, observed links, shimmed links, and status; badge labels live in tooltips/ARIA labels so the header stays scannable. Clicking the domain label expands or collapses the domain, opening the same graph view used by the single-domain filter. The graph places owner details and right-aligned command/event groups on the left, with short owner descriptions bottom-aligned as the final part of that pane. Participant usage is grouped the same way on the right, with observed or shimmed links between border-aligned endpoint ports. In multi-provider domains, links to provider participants use provider-family colors: purple for owner-to-provider command delegation and a lighter violet for provider events. Provider participants, including `library` sources, stay on the right lane and show a provider icon in their header. Headers show role-aware core/non-core origin badges such as Core owner, Core provider, or Non-core participant; owner headers place the origin badge directly after the owner icon, and the built-in local library provider is marked as core-origin. Observer and requester roles are implied by the command/event links rather than separate header badges. Participant cards are shown only when the plugin or runtime source has visible command or event usage for the current graph filter; domains with no such usage show zero participants, and attribution-only shims with no matching endpoint stay out of the lane. Command and event groups can collapse; when collapsed, all links for that side and group converge on the single group port. Hovering a participant, endpoint, or command/event group emphasizes the matching links and dims unrelated links; owner-side labels outside the current focus de-emphasize so the active source endpoints are easy to track. Expanded domain graphs progressively enhance to Cytoscape.js overlays that route bezier links between measured DOM endpoint ports, while keeping the HTML lanes as the fallback and readable data surface. Its Plugins-menu entry is hidden by default; enable **Capability Inspector → Show in Plugins menu** from Settings when reviewing or debugging capability behavior.

## Diagnostics Contract

Capability diagnostics use schema `slopsmith.capabilities.diagnostics.v1`. Snapshots are redaction-safe and capped at 64 KB by trimming older `recentDecisions` first while preserving current participants, active or orphaned claims, conflicts, domain review metadata, shim summaries, safety notes, and unsupported-version reports. Server diagnostics bundles include plugin manifest capability metadata, validation warnings, unsupported-version metadata, and compatibility shim summaries.

Compatibility shim entries include `shimId`, `source`, `capability`, `legacySurface`, `status`, `reason`, and optional hit fields. A shim with `hitCount > 0` means compatibility behavior was observed, not merely declared. The `library` domain no longer uses compatibility shims for provider registration or source selection; provider attribution comes from `owner_plugin_id` and runtime provider participants. Future domains should add expected shim entries only in the PR that implements their actual compatibility bridge.

## Expected Future Domains

Expected future domains live in [capability-roadmap.md](capability-roadmap.md) and [capability-safety-matrix.md](capability-safety-matrix.md) instead of the runtime graph. They are reserved names and candidate command shapes for future PRs, not current contracts. A future-domain PR should add the real host workflow, runtime registration, diagnostics redaction rules, tests, and compatibility shims in the same slice that makes the domain visible to plugins.

## Incremental Roadmap

Release slices should stay reviewable. The domain-level roadmap, PR1 domain set, deferred domains, shim policy, and future-domain PR checklist live in [capability-roadmap.md](capability-roadmap.md).

Future privileged domains must state user value, included and excluded commands, safety class, diagnostics fields, failure recovery, and tests proving disabled or incompatible participants cannot execute handlers before implementation begins.

## Runtime Idempotency Pattern

Plugins that declare `plugin-runtime-idempotent.v1` must tolerate repeated script hydration without duplicating participants, listeners, timers, DOM roots, jobs, media nodes, or diagnostics contributors. Use stable ids and replace the current implementation behind the participant instead of registering a second copy.

```js
const runtime = window.__slopsmithMyPluginRuntime || (window.__slopsmithMyPluginRuntime = {});
runtime.impl = {
  async inspect() {
    return { ready: true };
  },
};

if (!runtime.registered) {
  runtime.registered = true;
  window.slopsmith.capabilities.registerParticipant('my_plugin.runtime', {
    'example.plugin-domain': {
      roles: ['provider'],
      commands: ['inspect'],
      handlers: {
        inspect: () => runtime.impl.inspect(),
      },
      runtime: true,
    },
  });
}
```

## Validation Commands

From the `slopsmith/` directory:

```bash
node --check static/app.js
node --check static/capabilities.js
node --check static/diagnostics.js
node --check plugins/capability_inspector/screen.js
node --test tests/js/*.test.js
pytest tests/test_plugin_runtime_idempotence.py tests/test_plugins.py tests/test_diagnostics_bundle.py -q
```