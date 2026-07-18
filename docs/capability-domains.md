# Capability Domains

Capability domains are FeedBack-wide coordination surfaces for core, bundled first-party plugins, external plugins, and future adapters. Plugins declare the runtime surfaces they use in `plugin.json`; core declares and owns host workflows directly in the runtime. These declarations let diagnostics and support tools reason about behavior without relying on private globals.

## Standards

Migrated plugins should declare standards explicitly:

```json
{
  "standards": ["capability-pipelines.v1", "plugin-runtime-idempotent.v1"]
}
```

Only declare `plugin-runtime-idempotent.v1` when repeated script hydration cannot duplicate wrappers, listeners, timers, DOM roots, diagnostics contributors, jobs, media nodes, or capability participants.

## UI Contributions

Legacy `nav`, `screen`, and `settings` fields still work through the existing plugin loader. PR1 keeps UI capability domains out of the runtime graph, so migrated plugins should not treat `ui.navigation`, `ui.plugin-screens`, or `settings` as active capability contracts yet. Their candidate manifest shape is reserved for a future UI-host PR:

```json
{
  "ui": {
    "ui.navigation": [{ "id": "my-plugin-nav", "region": "plugins", "label": "My Plugin" }],
    "ui.plugin-screens": [{ "id": "my-plugin-screen", "region": "plugin-screens", "label": "My Plugin" }],
    "settings": [{ "id": "my-plugin-settings", "region": "plugin-settings", "label": "My Plugin" }]
  }
}
```

Core continues to load legacy UI fields normally. It does not emit PR1 compatibility shim entries for UI placement or visualization `type`; the PR that promotes those domains will own their shim accounting and tests.

## Runtime Domains

Declare non-UI runtime surfaces under `domains` or `runtime_domains`:

```json
{
  "domains": {
    "library": { "role": "provider" }
  }
}
```

If a plugin still uses `routes`, the backend loader continues to load `routes.py` normally. PR1 does not expose that legacy surface as `backend.routes`; the backend route domain is deferred until a future PR has a concrete route/provider workflow and privilege review.

Plugins that call `context["register_library_provider"](...)` are attributed to the loading plugin id in `/api/library/providers` as `owner_plugin_id`. The browser library capability module at [static/capabilities/library.js](../static/capabilities/library.js) owns the `library` domain as a `provider-coordinator`: it refreshes `/api/library/providers`, registers the built-in `local` provider as `core.library.local`, and registers plugin-backed providers under their `owner_plugin_id` when one is known. Provider manifests should still declare the `library` capability so diagnostics and the bundled inspector can show intended relationships before the backend route code runs.

Route-only external plugins that participate in library workflows without registering a browsable provider should declare requester/observer intent instead of provider ownership when they adopt this contract in their own repositories. This PR documents the generic shape only: such plugins use `library` requester/observer `requests` and `observes` declarations and do not appear as providers, owners, or separate `backend.routes` domains.

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

The frontend exposes the current source list through `window.feedBack.capabilities.command('library', 'list-providers')`. Public owner commands (`list-providers`, `refresh-providers`, `get-current`, `select-provider`, `sync-song`, `inspect`) are distinct from provider operations (`query-page`, `query-artists`, `query-stats`, `tuning-names`, `get-art`, `sync-song`). The app-owned handler delegates to the existing provider registry and source selector, so plugins should not scrape the `#lib-provider` dropdown.

Capability declarations may include a short `description`. The bundled Capability Inspector shows that text on expanded domain owner cards; when it is omitted, the inspector falls back to a compact generated owner summary.

## Audio Graph/Session Domains

The audio graph/session slice promotes four player-audio domains into the runtime graph: `audio-mix`, `audio-input`, `audio-monitoring`, and `stems`. The browser module at [static/capabilities/audio-session.js](../static/capabilities/audio-session.js) owns the active session boundary, contributes diagnostics under `feedBack.audio_session.diagnostics.v1`, and records compatibility bridge hits for legacy audio surfaces.

`audio-mix`, `audio-input`, and `audio-monitoring` are core-owned provider-coordinator domains. They expose bounded inspect/register/start/stop style commands, redaction-safe diagnostics, and bridge accounting for legacy fader, analyser, input, and monitoring handshakes.

For `audio-mix`, native fader providers register mix participants with stable `participantId`, `kind`, `sourceMode`, optional `logicalFaderKey`, and `fader` metadata. The public command surface is `inspect`, `list-faders`, `get-fader-value`, `set-fader-value`, `inspect-route`, `inspect-analyser`, `register-participant`, and `unregister-participant`; provider operations are `fader.get-value`, `fader.set-value`, `route.get-current`, and `analyser.get-summary`. Providers own persistence for plugin faders and must return committed values from set operations so the player mixer can display the value that actually applied.

Legacy `window.feedBack.audio.registerFader(...)` remains supported as an audio-mix compatibility bridge. The bridge registers a compatibility-backed participant, wraps legacy `getValue`/`setValue` callbacks as provider operations, and preserves `window.feedBack.audio.getFaders()` for external callers. If a native participant and a legacy fader share the same logical fader key, the native participant owns the visible control; the legacy participant is retained for diagnostics with `supersededBy` and an `overshadowed` bridge hit. Removal gates for the bridge are: native providers cover bundled mixer integrations, diagnostics show no unexpected legacy hits in normal playback, and repeated plugin hydration does not create duplicate faders.

Audio-mix diagnostics live under `feedBack.audio_session.diagnostics.v1`. The `audio-mix` domain snapshot includes session state, participants, visible fader summaries, required participant-kind coverage, route summary, analyser summary, bridge hits, and bounded recent outcomes. Fader outcomes include operation name, participant id, fader id, status such as `committed`, `normalized`, `unavailable`, or `timeout`, and a bounded reason. Diagnostics must not include raw audio buffers, FFT arrays, device labels, stable hardware identifiers, secrets, or unredacted local paths; route/analyser payloads are summaries only.

For `audio-input`, native providers register source summaries with `sourceId`, `providerId`, `logicalSourceKey`, `kind`, redaction-safe label/pseudonym, `availability`, `channelSummary`, `sourceMode`, and provider operations. The public command surface is `inspect`, `list-sources`, `register-source`, `unregister-source`, `select-source`, `open-source`, and `close-source`; provider operations are `source.enumerate`, `source.describe`, `source.open`, and `source.close`. `inspect`, `list-sources`, and `select-source` are prompt-free and never open live input or call enumeration. `source.enumerate` runs only when explicitly requested by provider/user discovery. `open-source` is the permission boundary: it routes to `source.open`, attributes the requester, checks the selected source and requested channel shape, and records `handled`, `denied`, `degraded`, `failed`, `no-owner`, `no-handler`, `unsupported-command`, or `incompatible-version` outcomes.

Selected input is persisted by `logicalSourceKey` when browser storage is available. If storage is unavailable, the in-memory selection remains usable for the current session and diagnostics report the storage status. Start/stop/song switches preserve selected input independently of playback transport while clearing live open sessions. Compatible requesters share one open session per logical source and channel shape; requester references are released via `close-source`, and the provider receives `source.close` only after the last requester releases.

Compatibility-backed input sources should record `sourceMode: "compatibility"` plus `compatibilitySource` and, when applicable, an `audio-input.legacy-source` bridge hit. If a native provider and a compatibility-backed source share the same logical source key, the native source owns the visible source list and the compatibility source is retained in diagnostics with `supersededBy`. Removal gates for input bridges are: native providers cover bundled source discovery/open flows, diagnostics show no unexpected compatibility hits in normal playback, denied/unavailable/failure outcomes are distinguishable, repeated hydration does not create duplicate sources, and support snapshots contain no raw device labels, hardware ids, paths, secrets, live handles, buffers, samples, or waveform data.

For `audio-monitoring`, native providers register monitoring summaries with `providerId`, `logicalMonitoringKey`, redaction-safe label/pseudonym, `availability`, `sourceMode`, provider operations, `directMonitor`, and `latencySummary`. The public command surface is `inspect`, `list-providers`, `register-provider`, `unregister-provider`, `select-provider`, `start`, `stop`, and `set-direct-monitor`; provider operations are `monitoring.start`, `monitoring.stop`, `monitoring.status`, and `monitoring.set-direct-monitor`. `inspect`, `list-providers`, `select-provider`, and `monitoring.status` are prompt-free and must not open audio input or start monitoring.

Fresh monitoring start is a user-action boundary. A requester that calls `start` without `authorization: "user-action"` receives `user-action-required` unless it can attach to an already-active compatible monitoring session. Start dispatch opens the selected audio-input source through the `audio-input` domain, checks the requested channel shape, and then calls the provider's `monitoring.start` with a redaction-safe `sourceRef`, requester id, required channel shape, direct-monitor preference, and optional requester requirement. Outcomes distinguish `handled`, `degraded`, `denied`, `unavailable`, `failed`, `no-owner`, `no-handler`, `unsupported-command`, `incompatible`, `incompatible-version`, `provider-selection-required`, and `user-action-required`.

Monitoring sessions are keyed by provider, selected source, required channel shape, and direct-monitor policy. Compatible requesters share an active session without re-calling `monitoring.start`; each requester later calls `stop`, and the provider receives `monitoring.stop` only after the final requester releases it. Song switches and playback stops preserve active monitoring sessions for the current browser runtime, while page reload restores only the selected provider and direct-monitor preference; live monitoring stays stopped until a new explicit start.

Direct-monitor state is user-authoritative. `set-direct-monitor` updates the user's/default preference and applies provider control to active sessions only when the provider supports it. Requester `directMonitorRequirement` values are advisory constraints: when they conflict with the user's preference or provider support, the requester/session is marked degraded or unsupported, but the stored user/default preference is not changed.

Compatibility-backed monitoring providers should record `sourceMode: "compatibility"` plus `compatibilitySource` (which becomes the bridge id, defaulting to `audio-monitoring.legacy-provider` when unset) and, when applicable, the `audio-monitoring.audio-barrier` startup-barrier bridge hit. If a native provider and compatibility-backed provider share a logical monitoring key, the native provider owns the visible provider list and the compatibility provider is retained in diagnostics with `supersededBy`. Removal gates for monitoring bridges are: native providers cover bundled start/stop/status/direct-monitor flows, normal playback shows no unexpected legacy hits, background requesters cannot silently start live monitoring, repeated hydration does not duplicate providers or sessions, and support snapshots contain no raw device labels, hardware ids, paths, secrets, live handles, buffers, samples, waveform data, recordings, or provider-private payloads.

`stems` is different: `core.audio.session` is a coordinator, not the semantic owner of stem playback. The Stems plugin, or another active stem provider, remains the provider/owner of actual stem state, mute/restore mechanics, and per-song availability. The session coordinator records the active provider via `registerStemOwner(...)`, brokers claim/override/orphan diagnostics, and returns `no-owner` when no stem provider is available.

New bundled audio code should use the session host or native capability dispatch instead of adding new globals, private stem-state reads, direct analyser ownership, or plugin-specific handshakes. Existing legacy paths remain supported through named compatibility bridges until their migration notes and removal gates are satisfied.

## Audio Effects Domain

The audio-effects slice promotes `audio-effects` as a core-owned provider-coordinator domain implemented by [static/capabilities/audio-effects.js](../static/capabilities/audio-effects.js). The host owns provider selection, compatible executor selection, route state, fallback accounting, redaction-safe diagnostics, and the constrained chain-plan schema. Providers do not call executors. Provider code proposes plans and, for execution requests, returns a provider-private trusted asset map to the host; the host immediately hands that private request to a compatible executor such as trusted Desktop native audio or NAM Tone's browser/WASM executor.

The public command surface is `inspect`, `list-providers`, `list-executors`, `register-provider`, `unregister-provider`, `register-executor`, `unregister-executor`, `select-chain`, `resolve-plan`, `load-plan`, `inspect-route`, `list-mappings`, `upsert-mapping`, `delete-mapping`, `activate-mapping`, `clear-active-mapping`, `bypass`, `restore`, `fallback`, `activate-segment`, `set-stage-bypass`, `set-stage-parameter`, and `record-bridge-hit`. Provider operations are `chain.resolve`, `chain.inspect`, `mapping.list`, `mapping.upsert`, `mapping.delete`, `mapping.activate`, `mapping.clear-active`, `segment.activate`, `stage.set-bypass`, `stage.set-parameter`, `route.bypass`, and `route.restore`; executor operations are `loadChainPlan`, `activateSegment`, `setStageBypass`, and `setStageParameter`. Fresh chain selection and route bypass/restore require `authorization: "user-action"` or `authorization: "restore-selection"`; physical loading through `load-plan` requires `authorization: "user-action"`, `authorization: "restore-selection"`, or `authorization: "playback-session"`. Background requesters may inspect the current route and resolve an already selected compatible provider.

Core also owns the durable public mapping index at `/api/audio-effects/mappings`. A mapping answers "for this song/tone, this provider has an addressable effect plan"; it does not contain the provider's preset or chain data. Rows are keyed by `song_key + tone_key + provider_id`, carry an opaque `provider_ref`, and may be marked as the active mapping for that song/tone. Providers CRUD their own rows through the audio-effects host and resolve `provider_ref` inside their own storage when `chain.resolve` runs. This lets NAM Tone and Rig Builder coexist for the same song/tone while core owns arbitration and fallback order. `song_key` should be the playback domain's redaction-safe settings key when available; `filename` is optional legacy/debug context for migration and display.

Providers register stable `providerId`, `pluginId`, `routeKey`, priority, availability, source mode, operations, and operation handlers. Executors register stable `executorId`, `pluginId`, `routeKey`, priority, availability, source mode, supported provider ids, supported stage kinds, optional maximum stage count, operations, and handlers. The host chooses the highest-priority enabled provider for a route unless the caller requests a specific provider, then chooses the highest-priority compatible executor for that provider and resolved plan. Compatibility means both provider-compatible and plan-compatible: a browser/WASM NAM executor can advertise `providerIds: ["nam-tone"]`, `supportedKinds: ["nam", "ir"]`, and `maxStages: 2`, so it will not be asked to execute a Rig Builder VST/full-chain plan. If a selected provider has no compatible executor and the caller supplies a fallback provider, the host may fall back to that provider; if the caller explicitly requested the original provider, the host reports `unavailable` instead of silently changing providers. The initial default route is `desktop-main`, matching the desktop native executor path planned for full-chain NAM/IR/VST playback while still allowing browser executors for non-Desktop runtimes.

`chain.resolve` returns schema `feedBack.audio_effects.chain_plan.v1`. A valid plan includes `planId`, `routeKey`, `providerId`, `stages`, optional `segments`, and optional redaction-safe summaries. Each stage exposes only stable opaque `stageId`, `kind` (`nam`, `ir`, `vst`, `utility`, or `bypass`), `role` (`pre-pedal`, `amp`, `cab`, `rack`, `master-pre`, etc.), opaque `assetRef`, optional opaque `stateRef`, bypass state, gain summary, and safe summary metadata. Raw file paths, URLs, model filenames, IR filenames, VST state blobs, native preset JSON, callbacks, handles, DOM nodes, audio buffers, samples, and waveform data are rejected or omitted.

Diagnostics live under `feedBack.audio_effects.diagnostics.v1`. The snapshot includes provider summaries, executor summaries, route summaries, bridge hits, bounded recent outcomes, limits, and redaction notes. It intentionally omits full chain plans, stage asset references, provider-private mapping payloads, raw filenames, and song keys; diagnostics should explain which provider/executor/route failed without leaking local library structure or licensed asset names. Legacy NAM Tone/Rig Builder fetch interception, direct Desktop `loadPreset` calls, legacy tone controls, old `nam_tone.db` `tone_mappings` access, and MIDI/external effect handoffs are attributed through `audio-effects.legacy-nam-routing`, `audio-effects.legacy-native-load`, `audio-effects.legacy-tone-controls`, `audio-effects.legacy-tone-db`, and `audio-effects.legacy-midi-amp` bridge records while providers migrate.

## Playback Control Plane

The playback slice promotes `playback` as a core-owned command domain implemented by [static/capabilities/playback.js](../static/capabilities/playback.js). The public command surface is `inspect`, `start`, `pause`, `resume`, `stop`, `seek`, `set-loop`, `clear-loop`, `register-requester`, and `register-observer`. The domain emits `playback:*` lifecycle events for requests, loading, ready/start/pause/resume/seek/stop/end, route transitions, loop changes, failures/degraded states, superseded sessions, and compatibility bridge hits.

`static/app.js` remains the transport data plane. It registers a private playback adapter that can start songs, pause/resume/stop, seek, and manage loops, but the capability snapshot never exposes the `<audio>` element, JUCE player object, raw audio buffers, native route handles, samples, waveforms, recordings, local file paths, or URL payloads. Exported diagnostics use pseudonymous `target-*` ids for arrangement-scoped identity and hashed `settings-*` keys for per-song plugin settings; the local Capability Inspector may show visible title, artist, and arrangement labels for the active song.

Legacy playback surfaces remain supported during migration and are attributed through bridges such as `playback.window-play-song`, `playback.song-events`, `playback.window-feedBack-transport`, `playback.loop-api`, and native route handoff records. Fresh audible `start` commands require `authorization: "user-action"`; background requesters may inspect or control an existing session, but user-priority pause/stop decisions block lower-priority automation until a user action resumes or starts a new session.

## Progression Domain

The progression slice (spec 010) promotes `progression` as a core-owned command domain implemented by [static/v3/progression-core.js](../static/v3/progression-core.js). Core owns the player's mastery rank (onboarding calibration + instrument-path levels), the challenge/quest engine, the Decibels wallet, and the cosmetics shop; all definitions are bundled content under `data/progression/` so new paths, levels, challenges, quests, and shop items are JSON edits, never code.

The public command surface is `inspect`, `record-event`, `list-shop`, `buy-item`, and `equip-item`. `record-event` accepts only whitelisted externally-postable event types (`minigame_run` in v1); `song_completed` is server-derived inside `/api/stats` so scored-session authority stays in one place and is denied at this surface. `buy-item` and `equip-item` require `authorization: "user-action"`. Backend plugins use the symmetric plugin-context hook `record_progression_event` (the minigames hub reports runs through it), which trusts backend code and skips the HTTP whitelist.

The domain emits `challenge-completed`, `quest-completed`, `path-level-up`, `rank-changed`, `db-changed`, `calibration-completed`, and `cosmetic-equipped` on the capability surface, mirrored as `progression:*` events on `window.feedBack` for non-capability consumers. Diagnostics live under `feedBack.progression.diag.v1` and contain content-load warnings, rank/path-level/quest counts, and wallet totals only — no song filenames or display names.

Decibels are earned exclusively by playing (songs, minigame runs, quest rewards); there is no real-money acquisition path and none may be added. The wallet tracks spend separately from the monotonic lifetime-earned total, so per-source XP resets and `db_earned` goals stay correct. A deferred release slice adds a `contributor` role so plugins can ship their own challenge/quest content (e.g. a drums plugin contributing drums challenges); content stays core-bundled until then.

## Visualization Domain

The visualization slice (cap:6) promotes `visualization` as a core-owned provider-coordinator implemented by [static/capabilities/visualization.js](../static/capabilities/visualization.js). Viz plugins are providers of the highway renderer surface; the core picker/auto-match machinery in `static/app.js` stays the selection workflow and attributes every renderer change into the domain.

The public command surface is `inspect`, `list-providers`, `select-renderer`, and `clear-renderer`. Selection delegates to the existing picker (`setViz`) so localStorage persistence, WebGL2 gating, and fallback semantics have exactly one implementation. The domain emits `providers-refreshed`, `renderer-changed` (with a `source` of `auto-match`, `user-select`, `fallback`, or `command:<requester>`), `renderer-ready`, and `renderer-failed`.

Provider discovery is still the legacy surface — `type: "visualization"` manifests populate the picker and `window.feedBackViz_*` factory globals carry the renderer contract — and both are registered as compatibility shims (`visualization:type-visualization-manifest`, `visualization:window.feedBackViz_*`) with hit accounting, so the Inspector shows exactly how much of the domain still rides the bridge. Plugins migrate by declaring a `visualization` provider capability in their manifests; the renderer factory contract (`init`/`draw`/`resize`/`destroy`, `contextType`, `matchesArrangement`) is unchanged.

**Per-instance provider settings (#849).** A provider may declare a `settings` array on its `visualization` capability — generic control descriptors (`{ key, label, type: "toggle" | "range" | "select", default, min/max/step, options }`) the capability-pipelines schema validates on *any* domain (the field lives on the shared `capabilityDeclaration`, not a visualization-only spot — see `docs/plugin-manifest.schema.json`). Descriptors flow through the **generic participant model**: the backend validates them for `/api/plugins` (`plugins/__init__.py`), `static/capabilities.js` normalizes + preserves them on the registered participant (so generic `inspect('visualization')` carries them), and the visualization owner reads them back from the participant by id — no app.js/picker side channel. They surface in the `list-providers` snapshot (each provider's `settings`, deep-frozen) plus a `provider_policy.hasSettings` flag in diagnostics, so a consuming host — splitscreen's per-panel control popover — can render the controls generically without per-plugin hardcoding. The visualization domain's **apply contract**: a provider that declares `settings` MUST implement `applySetting(key, value)` on its renderer instance (the host calls it on the specific per-panel instance, which is inherently per-panel — no canvas→panel resolution, no shared global keys); `getSetting(key)` is optional (the host falls back to the declared `default`). The host owns persistence. **This core slice lands the declarative surface + participant plumbing only** — no bundled provider declares `settings` yet (`highway_3d` still ships the legacy `factory.panelControls` static). The `highway_3d` migration and the splitscreen generic consumer are the remaining #849 follow-ups.

Diagnostics live under `feedBack.visualization_capability.v1` and contain provider ids/labels/context types, the active renderer id and its selection source, the last auto-match outcome (resolved id + whether any predicate claimed the song), and the last failure (provider id + reason) — never song filenames, titles, or arrangement names. Per-panel selection (splitscreen #90) and per-panel provider settings (#849) are tracked follow-ups; the domain currently models the primary highway surface.

## Note-Detection Domain

The note-detection slice (spec 009, issues #727/#728) promotes `note-detection` as a core-owned provider-coordinator implemented by [static/capabilities/note-detection.js](../static/capabilities/note-detection.js). Doctrine per [specs/009-note-detection-domain/spec.md](../specs/009-note-detection-domain/spec.md): the domain exposes detection PRIMITIVES through requester-owned, context-scoped bindings — a monophonic pitch estimate and a polyphonic "is this note set ringing now?" verification — and consumers own all judgment semantics (hit windows, streaks, accuracy, tiers). Hit/miss/verdict results flow through the domain as observability events, never as domain-owned scoring.

The public command surface is `inspect`, `register-provider`, `unregister-provider`, `open-binding`, `close-binding`, `set-target`, and `clear-target`. Providers declare a kind — `midi` (a digital instrument producing exact verdicts, e.g. the keys highway's Web-MIDI input), `engine` (the desktop JUCE verifier), or `js` (the browser harmonic-comb / YIN fallback) — and the primitives they serve (`pitch.estimate`, `verify.target`). Each binding carries its requester's own redacted context summary (arrangement kind, string count, capo, MIDI range), independent of whatever song the host highway has loaded; concurrent bindings never perturb one another (spec 009 FR-003). With no provider registered, `open-binding` reports `unavailable` — consumers degrade, never block.

The legacy chart-coupled surface — `highway.setNoteStateProvider(fn)`, the single-global-detector path spec 009 retires — keeps working unchanged and is wrapped for compatibility-shim hit accounting (`note-detection:highway.setNoteStateProvider`). Migrating the chart `note_detect` consumer, Step Mode verify, minigames YIN scoring, and the `setVerifyTarget` bridge onto real bindings — and wiring per-binding tuning contexts into the engine verifier — is the remainder of the spec-009 slice and lands behind the Spec 003 migration gate.

Diagnostics live under `feedBack.note_detection_capability.v1` and contain provider ids/labels/kinds, binding summaries (requester, provider, redacted context, target size), availability, and the last bounded outcome (event, binding, provider, MIDI number, hit flag) — never raw audio buffers, sample data, device labels, or song identity.

## Chart-Transform Domain

The chart-transform slice (#952) promotes `chart-transform` as a core-owned provider-coordinator implemented by [static/capabilities/chart-transform.js](../static/capabilities/chart-transform.js). A provider substitutes the chart before consumers read it: notes, chords, anchors, chord templates, string count, and tuning are remapped once per chart change — never per frame — and every consumer sees the same substituted chart: the built-in 2D renderer, `setRenderer` viz (via the bundle), and overlays/scorers (via the highway getters).

The hot path is the synchronous `highway.setChartTransform({ id, transform })` hook on the renderer data plane, per the deferred-core-adapters doctrine below (chart reads never move behind async capability commands). `transform(input)` receives `{ notes, chords, anchors, allNotes, allChords, chordTemplates, handShapes, stringCount, songInfo }` and returns any subset of `{ notes, chords, anchors, allNotes, allChords, chordTemplates, handShapes, stringCount, tuning, capo, centOffset }` (`bundle.centOffset` is a transform-aware bundle field added with this contract; it mirrors `songInfo.centOffset` when no transform overrides it). **The transform applies AFTER difficulty/mastery filtering** — the input `notes`/`chords`/`anchors` are the mastery-filtered views, so phrase-level selection keys on original-chart identity and providers solve voicings for the note set actually played at the current difficulty. Accepted timeline arrays are copied and normalized by their time key before staging. It re-runs automatically at chart ready and on every mastery change, and on demand via the `refresh` command (e.g. the provider's target settings changed). A throwing provider is skipped for that pass — the original chart keeps rendering — and the failure is attributed through `highway:chart-transform-failed` into the domain's `transform-failed` event with a fixed public reason; raw exception details remain local to the console.

The public command surface is `inspect`, `list-providers`, `register-provider`, `unregister-provider`, `select-provider`, `clear-provider`, and `refresh`; the provider operation is `chart.transform`. Providers register in-page with `{ providerId, label, transform }`; selection persists by provider id (`feedBack.chartTransform.selectedProviderId`) and restores when the provider re-registers. `getSongInfo()` keeps reporting the chart's original tuning — transform-aware consumers read `bundle.tuning`, `bundle.stringCount`, and `getStringCount()`, which reflect the substitution. The active provider installs on **every** highway surface: the primary `window.highway` plus any instance announced via the `highway:created` window-bus event (`createHighway()` emits it with the api on `event.detail.highway` — splitscreen panels get the transform automatically, and each instance restages against its OWN `songInfo`, so per-panel arrangements resolve independently inside the provider). Per-panel *independent selection* (different providers per panel) remains a tracked follow-up, mirroring the visualization domain. The domain ships no compatibility shims: there is no legacy chart-substitution surface to bridge.

Diagnostics live under `feedBack.chart_transform.diagnostics.v1` and contain provider ids/labels, the active provider and its selection source, install state, and the last failure with a fixed public reason — never song filenames, titles, arrangement names, or chart data.

## MIDI-Input Domain

The MIDI-input slice (spec 012, issues #873/#880) promotes `midi-input` as a **core-owned** provider-coordinator implemented by [static/capabilities/midi-input.js](../static/capabilities/midi-input.js) — the MIDI analog of `audio-input`. It is deliberately separate from `audio-input` (whose source/`open` contract is audio-frame-centric: channel shapes, sample buffers) because MIDI carries discrete messages, not audio; and it is **not** owned by any feature plugin, so the device-access boundary outlives the input-setup wizard (exactly as `audio-input` is `core.audio.session`-owned). Consumers — the `input_setup` onboarding wizard, the `piano`/keys and `drums` plugins, and (as a follow-up, #881) note-detection's Web-MIDI provider — converge here on ONE device-access boundary: one permission prompt, one source list, one redaction boundary, retiring private per-plugin `navigator.requestMIDIAccess()` calls.

Native providers register source summaries with `providerId`, a stable `sourceId`, a derived redaction-safe `logicalSourceKey` (`providerId::sourceId`), `kind: "midi"`, a label, and `availability`. The public command surface is `inspect`, `list-sources`, `discover`, `select-source`, `open-source`, and `close-source`; provider operations are `source.enumerate`, `source.describe`, `source.open`, and `source.close`. `inspect`, `list-sources`, and `select-source` are prompt-free and never request MIDI access. Unlike audio (where `getUserMedia` gates labels and `open-source` is the prompt), Web-MIDI's `requestMIDIAccess()` gates the whole input list, so **`discover` is the permission boundary** and records `denied`/`unavailable` outcomes; `open-source` then attaches a shared listener session and never re-prompts.

Selected input is persisted by `logicalSourceKey` (`feedBack.midiInput.selectedLogicalSourceKey`) when browser storage is available. Compatible requesters share one open session per source; each later calls `close-source`, and the provider receives `source.close` only after the last requester releases. Live MIDI message delivery (for the "play a note / hit a pad" calibration check) is exposed to in-page consumers through the public `window.feedBack.midiInput` session handle only — never as raw capability events or diagnostics.

The reserved `midi-control` domain is the planned **sibling** for control mappings (CC/pitchbend/note → action routing) and will consume `midi-input` for device access (spec 013 / #882); this slice carves the device control plane out so `midi-control` can stay mappings-only. `midi-control` stays RESERVED (documentation-only) until a concrete mapping consumer + tests exist, per the future-domain governance.

Diagnostics live under `feedBack.midi_input.diagnostics.v1` and contain provider ids, source ids/keys/kinds/availability, the selected key, and open-session keys — **device labels are redacted** and no raw MIDI messages are ever included.

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

Core registers manifest capability declarations from `/api/plugins` before plugin scripts hydrate. Runtime owners can then re-register the same participant with command handlers, event handlers, and current availability state. The merged participant view is visible through `window.feedBack.capabilities.snapshotDiagnostics()` and `getDiagnostics()`.

Core domains include review metadata in diagnostics:

- `active`: wired to current FeedBack behavior and expected to work as an integration point.
- `diagnostic`: support/inspection-only runtime surfaces.

PR1 includes only the delivered domains listed in [capability-roadmap.md](capability-roadmap.md): `pipeline`, `diagnostics`, and `library`. The follow-up audio graph/session slice promotes `audio-mix`, `audio-input`, `audio-monitoring`, and a coordinated `stems` surface. The playback slice promotes `playback` as an active transport control plane. The audio-effects slice promotes provider-selected effect-chain planning while leaving physical processor loading to compatible executors such as trusted Desktop native audio or a browser/WASM executor. The visualization slice promotes `visualization` as the highway renderer provider-coordinator, the note-detection slice (spec 009) promotes `note-detection` as the detection-binding control plane, and the chart-transform slice (#952) promotes `chart-transform` as the pre-render/pre-scoring chart substitution coordinator. Backend routes, app UI, settings, and other hardware-facing domains remain documented in the roadmap and safety matrix until their own host workflow/provider slice exists.

Capability metadata is versioned by the `capability-pipelines.v1` standard. Invalid roles, commands, operations, requests, observes, emits, events, owner kinds, compatibility modes, ownership policies, safety classes, or version fields are excluded from the capability graph and surfaced through `capability_validation_warnings`; legacy plugin fields continue to load through their existing app paths. Plugins that declare a future `capability-pipelines` version are reported through `capability_unsupported_versions` and their runtime handlers are marked incompatible.

`diagnostics` and `pipeline` are adjacent support domains. `diagnostics` is the read-only snapshot/export surface: `snapshot` returns the redaction-safe state used by support bundles and the Capability Inspector. `pipeline` is the graph operations surface: `inspect`, `validate`, and `participant.set-enabled` operate on the capability graph itself and emit graph lifecycle events such as `resolved`, `runtime.validated`, and `participant.state-changed`.

Requesters should use the public claim/dispatch/release flow instead of mutating another plugin's globals:

```js
const api = window.feedBack.capabilities;
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

Legacy `ownership` remains accepted in manifests for compatibility and diagnostics, but new domains should prefer `kind` plus participant roles. Ownership is derived for core owners where possible: `provider-coordinator` behaves like a multi-provider domain, diagnostics are diagnostic-only, privileged owners are privileged, and command/event owners are exclusive by default.

The compatibility ownership vocabulary remains:

- `exclusive-owner`: at most one active owner; duplicate owners produce a conflict and dispatch degrades.
- `multi-provider`: multiple providers may participate, but ordering must be deterministic through fixed priority or `before`/`after` constraints.
- `observer-only`: participants listen for events and should not handle commands.
- `requester-only`: participants request commands from another owner.
- `privileged`: command execution needs an explicit enforcement plan before shipping.
- `diagnostic-only`: read-only support and inspector surfaces.

Dispatch results use explicit outcomes: `handled`, `transformed`, `denied`, `failed`, `degraded`, `short-circuited`, `overridden`, `no-owner`, `no-handler`, `no-target`, `unsupported-command`, `incompatible`, `incompatible-version`, `unavailable`, `provider-selection-required`, `user-action-required`, `stale`, `cancelled`, and `stopped`. No-owner, no-handler, no-target, unsupported-command, incompatible, incompatible-version, provider-selection-required, user-action-required, stale, and cancelled decisions are recorded in diagnostics so support bundles explain why nothing happened.

## Deferred Core Adapters

UI placement and settings contributions are real FeedBack surfaces, but they are not PR1 capability contracts (visualization is active as of the cap:6 slice; note-detection as of the spec-009 slice). Audio mixer/session domains are active as of the audio graph/session slice, playback is active as of the playback control-plane slice, and audio-effects is active as a provider/route/chain-plan coordinator; plugins should keep using current documented APIs for remaining areas until the corresponding domain PR ships the host workflow, command/event contract, compatibility shims, diagnostics fields, and tests.

The library provider workflow is the PR1 core adapter and is implemented natively as the `library` capability module. Provider refresh, selection, and sync run through `library` owner commands; backend provider registration remains the way providers enter the library registry, and the browser module turns that registry into provider participants. The app event bus continues to dispatch local `window.feedBack` events for legacy listeners; playback now mirrors song transport, route, seek, and loop lifecycle into `playback`, and visualization attributes renderer selection/failure, while navigation, note, and route-only surfaces remain outside capability domains until their own slices land.

The direct `window.highway` object remains the renderer data plane. Per-frame reads such as notes, chords, beats, and renderer hooks should not be moved behind asynchronous capability commands until there is a dedicated chart/render facade. The `chart-transform` domain follows this doctrine: its substitution runs through the synchronous `highway.setChartTransform` hook (staged once per chart change), while the capability surface owns only registration, selection, and diagnostics.

## First-Party Management Plugins

Large management surfaces should prefer plugin-owned UI over crowding normal Settings. First-party management plugins can contribute screens and settings panels while core keeps shared services and diagnostics contracts centralized.

The bundled Capability Inspector plugin is the support surface for the current graph. It reads `window.feedBack.capabilities.snapshotDiagnostics()`, filters by domain, and summarizes manifest participants, runtime participants, conflicts, unsupported versions, safety classes, expected legacy event surfaces, and compatibility shim hits without rendering raw runtime objects. Domains are grouped in review order: application/library, player/audio runtime, plugin-defined surfaces, then capability runtime. In the all-domains view, each domain starts collapsed with a domain-specific icon plus compact summary badges for participant-lane count, endpoint count, observed links, shimmed links, and status; badge labels live in tooltips/ARIA labels so the header stays scannable. Clicking the domain label expands or collapses the domain, opening the same graph view used by the single-domain filter. The graph places owner details and right-aligned command/event groups on the left, with short owner descriptions bottom-aligned as the final part of that pane. Participant usage is grouped the same way on the right, with observed or shimmed links between border-aligned endpoint ports. In multi-provider domains, links to provider participants use provider-family colors: purple for owner-to-provider command delegation and a lighter violet for provider events. Provider participants, including `library` sources, stay on the right lane and show a provider icon in their header. Headers show role-aware core/non-core origin badges such as Core owner, Core provider, or Non-core participant; owner headers place the origin badge directly after the owner icon, and the built-in local library provider is marked as core-origin. Observer and requester roles are implied by the command/event links rather than separate header badges. Participant cards are shown only when the plugin or runtime source has visible command or event usage for the current graph filter; domains with no such usage show zero participants, and attribution-only shims with no matching endpoint stay out of the lane. Command and event groups can collapse; when collapsed, all links for that side and group converge on the single group port. Hovering a participant, endpoint, or command/event group emphasizes the matching links and dims unrelated links; owner-side labels outside the current focus de-emphasize so the active source endpoints are easy to track. Expanded domain graphs progressively enhance to Cytoscape.js overlays that route bezier links between measured DOM endpoint ports, while keeping the HTML lanes as the fallback and readable data surface. Its Plugins-menu entry is hidden by default; enable **Capability Inspector → Show in Plugins menu** from Settings when reviewing or debugging capability behavior.

## Diagnostics Contract

Capability diagnostics use schema `feedBack.capabilities.diagnostics.v1`. Snapshots are redaction-safe and capped at 64 KB by trimming older `recentDecisions` first while preserving current participants, active or orphaned claims, conflicts, domain review metadata, shim summaries, safety notes, and unsupported-version reports. Server diagnostics bundles include plugin manifest capability metadata, validation warnings, unsupported-version metadata, and compatibility shim summaries.

Compatibility shim entries include `shimId`, `source`, `capability`, `legacySurface`, `status`, `reason`, and optional hit fields. A shim with `hitCount > 0` means legacy behavior was observed, not merely declared. The `library` domain no longer uses compatibility shims for provider registration or source selection; provider attribution comes from `owner_plugin_id` and runtime provider participants. Future domains should add expected shim entries only in the PR that implements their actual legacy bridge.

## Expected Future Domains

Expected future domains live in [capability-roadmap.md](capability-roadmap.md) and [capability-safety-matrix.md](capability-safety-matrix.md) instead of the runtime graph. They are reserved names and candidate command shapes for future PRs, not current contracts. A future-domain PR should add the real host workflow, runtime registration, diagnostics redaction rules, tests, and compatibility shims in the same slice that makes the domain visible to plugins.

## Incremental Roadmap

Release slices should stay reviewable. The domain-level roadmap, PR1 domain set, deferred domains, shim policy, and future-domain PR checklist live in [capability-roadmap.md](capability-roadmap.md).

Future privileged domains must state user value, included and excluded commands, safety class, diagnostics fields, failure recovery, and tests proving disabled or incompatible participants cannot execute handlers before implementation begins.

## Rehydration Pattern

Plugins that wrap shared functions such as `window.playSong` or `window.showScreen` should store wrapper state on a stable `window.__feedBack...Hooks` object. Re-running the script should replace the implementation object and return before installing another wrapper.

```js
const hookState = window.__feedBackMyPluginHooks || (window.__feedBackMyPluginHooks = {});
hookState.impl = { afterPlaySong(filename) { /* current implementation */ } };
if (hookState.installed) return;
hookState.installed = true;
hookState.basePlaySong = window.playSong;
window.playSong = async function(filename, arrangement) {
  await hookState.basePlaySong.call(this, filename, arrangement);
  hookState.impl?.afterPlaySong?.(filename, arrangement);
};
```

## Validation Commands

From the `feedBack/` directory:

```bash
node --check static/app.js
node --check static/capabilities.js
node --check static/capabilities/chart-transform.js
node --check static/diagnostics.js
node --check plugins/capability_inspector/screen.js
node --test tests/js/*.test.js
pytest tests/test_plugin_runtime_idempotence.py tests/test_plugins.py tests/test_diagnostics_bundle.py -q
```
