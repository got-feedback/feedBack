# Plugin Capability Inventory

This report inventories the currently included plugins staged in `plugins/` and maps their observed behavior to FeedBack capability domains. It is intended to inform the capability roadmap and the next migration specs now that PR1, the audio graph/session slice, playback, and audio-effects are active capability surfaces.

## Scope And Method

- Inventory source: 41 `plugin.json` manifests under `plugins/`, plus the first-party plugin repos that were migrated during the 008/playback and audio-effects work (`nam_tone`, `rig_builder`, Remote Library Client, and Remote Library Server).
- Verification pass: the original bundled-plugin scan found 25 plugins with backend `routes.py` and 14 plugins with `settings.html`. First-party plugin repos outside `plugins/` were checked separately from their current manifests and handoff docs.
- Most bundled plugin entries below are still inferred/recommended declarations. Current first-party manifests now declare active capability intent for `diagnostics`, `pipeline`, `library`, `audio-mix`, `audio-input`, `audio-monitoring`, `stems`, `playback`, `audio-effects`, `jobs`, and privileged capability inventory surfaces where their repos have already migrated.
- Manifest fields such as `nav`, `screen`, `settings`, `routes`, and `type: "visualization"` were treated as high-confidence evidence.
- Code patterns such as `window.feedBackViz_*`, `window.playSong` wrappers, `window.showScreen` wrappers, `window.registerShortcut`, `window.feedBackTour.register`, `window.feedBack.audio.registerFader`, `highway.setNoteStateProvider`, and route/WebSocket handlers were treated as behavior evidence.

## Roadmap Baseline

The current roadmap already covers several surfaces implied by the plugin set:

| Roadmap State | Domains |
|---------------|---------|
| Active PR1 domains | `pipeline`, `diagnostics`, `library` |
| Active audio graph/session slice | `audio-mix`, `audio-input`, `audio-monitoring`, `stems` |
| Active playback slice | `playback` |
| Active audio-effects slice | `audio-effects` |
| Planned UI domains | `ui.navigation`, `ui.plugin-screens`, `ui.player-controls`, `ui.player-panels`, `ui.player-overlays`, `settings` |
| Planned player/runtime domains | `midi-control`, `tempo-clock` (`visualization` active as of the cap:6 slice; `note-detection` active as of the spec-009 slice) |
| Planned privileged domains | `backend.routes`, `plugins`, `jobs` |

The plugin inventory confirms these planned domains are directionally right. The main gaps are additional domain names or command scopes for library card injection, guided tours, keyboard shortcuts, media import/export, recording/capture, practice/session scoring, external services, and collaboration. `audio-effects` is no longer a missing candidate: it is an active provider-coordinator domain, with remaining work concentrated in provider adoption, bridge removal, and executor coverage.

## Executive Summary

- The most common plugin surface is a plugin screen backed by optional routes and settings. `ui.plugin-screens`, `backend.routes`, and `settings` should be treated as first-class migration targets.
- Player integrations are still heavily legacy-global today. `playback` now provides the active transport lifecycle/control plane, and `visualization` now provides the renderer provider/selection contract (legacy globals ride accounted shims), while `ui.player-overlays`, `ui.player-controls`, and `ui.player-panels` still need lifecycle and ordering contracts before wrappers can be retired.
- The audio domains promoted by the audio graph/session slice match real plugin behavior. `audio-mix`, `audio-input`, `audio-monitoring`, and `stems` are active; remaining work is mostly native provider adoption, bridge-hit cleanup, and cross-domain smoke coverage.
- `audio-effects` is active. Core owns provider/executor selection, route state, mapping index, constrained chain-plan validation, route gain/release, segment activation, stage bypass/parameter dispatch, fallback accounting, and redaction-safe diagnostics. Desktop owns trusted native execution. NAM Tone provides the baseline NAM+IR provider/executor path, while Rig Builder is the high-priority full-chain provider for NAM/VST/IR routes.
- `playback` is active as of the 008 slice, with redaction-safe target/settings keys and transport lifecycle diagnostics. Legacy `window.playSong` and song-event wrappers remain compatibility paths while plugins migrate requester/observer workflows.
- Long-running work is spread across conversion, update, import, preview, and studio plugins. The `jobs` domain should include progress, cancellation, terminal failure, and provider attribution.
- Several plugins perform privileged or externally mediated work: subprocesses, downloads, native audio bridges, plugin updates, and media conversion. These should stay out of broad capability activation until each surface has user confirmation, diagnostics redaction, and failure recovery.

## Current Manifest Declarations Since The First Pass

| Plugin Or Runtime | Current Declarations | Notes |
|-------------------|----------------------|-------|
| Core capability runtime | `pipeline`, `diagnostics`, `library`, `audio-mix`, `audio-input`, `audio-monitoring`, `stems`, `playback`, `audio-effects` | Active runtime owners/coordinators are registered by core, not by plugin manifests. |
| `capability_inspector` | `diagnostics`, `pipeline` | Bundled support surface for the graph and diagnostics snapshots. |
| `remote_library_client` | `library` provider | Declares provider operations for query, art, stats, tuning names, and sync. |
| `remote_library_server` | `library` requester/observer | Wraps the local provider for direct remote clients without claiming provider ownership. |
| `nam_tone` | `stems`, `audio-mix`, `audio-input`, `audio-monitoring`, `audio-effects`, `playback` | Baseline NAM+IR provider/executor and live guitar requester/observer path. |
| `rig_builder` | `library`, `audio-effects`, `playback`, `jobs`, privileged inventory, UI contributions | High-priority full-chain provider; library migration is complete for the Songs tab, while privileged routes and long-running work still need host-backed execution slices. |
| Desktop native executor | `audio-effects` executor | Trusted native execution for the `desktop-main` route: load/clear chain, activate segments, set stage bypass/parameters, set route gain, start audio, and release/mute routes. It does not own provider semantics. |

## Per-Plugin Mapping

| Plugin | Recommended Domains | Expected Roles | Roadmap Status | Confidence | Evidence |
|--------|---------------------|----------------|----------------|------------|----------|
| `app_tour_library` | `tours`, `ui.player-overlays` | provider, observer | Missing `tours`; overlay planned | High | Tour registration and screen-change observation. |
| `app_tour_settings` | `tours`, `ui.player-overlays` | provider, observer | Missing `tours`; overlay planned | High | Tour registration and screen-change observation. |
| `audio_engine` | `audio-monitoring`, `audio-effects`, `ui.plugin-screens`, `settings` | provider, requester | Audio monitoring/effects active; plugin adoption pending | Medium | Screen/settings surfaces and native/VST audio engine intent. |
| `drum_highway_3d` | `visualization`, `ui.player-overlays`, `settings`, `midi-control` | visualization provider, observer | Planned | High | `type: "visualization"`, WebGL renderer, settings surface, drum/MIDI use case. |
| `drums` | `visualization` | visualization provider | Planned | High | `type: "visualization"` and renderer script. |
| `editor` | `ui.plugin-screens`, `backend.routes`, `media-import-export`, `jobs` | screen provider, route provider, job provider | UI/routes/jobs planned; media domain missing | High | Screen plus backend routes for editing/import/export workflows. |
| `find_more` | `library`, `ui.plugin-screens`, `backend.routes`, `ui.library-card-injection`, `external-services` | requester/provider, route provider | Library active; card injection/external services missing | High | Screen/routes plus library discovery and card injection behavior. |
| `flappy_bend` | `ui.plugin-screens`, `backend.routes`, `practice-session` | screen provider, route provider | UI/routes planned; practice-session missing | Medium | Game screen and backend route surface. |
| `fretboard` | `ui.player-overlays` | overlay provider | Planned | High | Highway-state overlay pattern. |
| `guitar_theory` | `ui.plugin-screens`, `settings`, `practice-session` | screen provider, settings provider | UI/settings planned; practice-session missing | Medium | Screen/settings manifest surfaces for theory tools. |
| `highway_3d` | `visualization`, `ui.player-overlays`, `backend.routes`, `settings`, `audio-monitoring` | visualization provider, route provider, observer | Audio-monitoring active; visualization/UI/routes planned | High | `type: "visualization"`, WebGL renderer, routes/settings, analyser monitoring bridge. |
| `invert_highway` | `ui.player-overlays`, `settings`, `visualization` | overlay provider, observer | Planned | High | Settings surface and highway/playback wrapper behavior. |
| `jumpingtab` | `visualization`, `ui.player-overlays` | visualization provider, observer | Planned | High | `type: "visualization"`, renderer factory, highway visibility behavior. |
| `lyrics_karaoke` | `ui.plugin-screens`, `backend.routes`, `playback`, `recording` | screen provider, route provider, observer | Playback active; UI/routes planned; recording missing | High | Screen/routes plus karaoke timing and lyric/audio workflows. |
| `metronome` | `ui.player-overlays`, `audio-mix`, `playback`, `tempo-clock` | overlay provider, audio participant, observer | Audio-mix/playback active; overlay/tempo planned | High | Player overlay behavior, metronome audio, playback coupling. |
| `midi_amp` | `midi-control`, `ui.plugin-screens`, `backend.routes`, `settings`, `audio-effects` | MIDI provider, screen provider, route provider | MIDI/UI/routes planned; audio-effects active bridge target | High | Manifest id `midi_amp`, routes, settings, and MIDI amp workflow. |
| `minigames` | `ui.plugin-screens`, `backend.routes`, `settings`, `diagnostics`, `practice-session` | screen provider, route provider, diagnostics provider | Mostly planned/active; practice-session missing | High | Routes/settings, diagnostics files, minigame state. |
| `multiplayer` | `collaboration`, `ui.plugin-screens`, `backend.routes`, `playback`, `audio-mix` | collaboration provider, route provider, observer | Collaboration missing | Medium | Screen/routes and real-time multiplayer/audio mix behavior. |
| `rig_builder` | `library`, `playback`, `audio-effects`, `jobs`, `privileged-capabilities`, `ui.plugin-screens`, `backend.routes`, `media-import-export` | effects provider/requester/observer, screen provider, route provider | First-party manifest active; backend/jobs/UI hosts still incomplete | High | Full-chain NAM/VST/IR provider, core mapping writes, library provider routing, mega-chain playback, tone3000/import/export routes. |
| `nam_tone` | `audio-mix`, `audio-input`, `audio-monitoring`, `stems`, `audio-effects`, `playback`, `ui.plugin-screens`, `backend.routes`, `settings` | audio provider/requester/observer, effects provider/executor, screen provider, route provider | First-party manifest active; UI/routes/settings planned | High | Fader registration, input/monitoring graph, stem ducking, baseline NAM+IR provider/executor, model/IR routes/settings. |
| `note_detect` | `note-detection`, `audio-input`, `audio-monitoring`, `ui.player-overlays`, `backend.routes`, `settings`, `diagnostics` | note provider, audio requester, overlay provider | Audio input/monitoring active; note/UI/routes planned | High | `highway.setNoteStateProvider`, calibration/settings/routes, diagnostic workflow. |
| `piano` | `visualization` | visualization provider | Planned | High | `type: "visualization"` and renderer script. |
| `plugin_manager` | `plugins`, `ui.plugin-screens` | plugin lifecycle provider, screen provider | Planned | High | Plugin management screen and desktop bridge integration. |
| `practice_journal` | `practice-session`, `ui.plugin-screens`, `backend.routes` | practice provider, screen provider, route provider | Practice-session missing | High | Practice journal screen/routes. |
| `profileimport` | `media-import-export`, `ui.plugin-screens`, `backend.routes`, `jobs` | import provider, screen provider, route provider | Media domain missing; jobs planned | High | Profile import screen/routes. |
| `section_map` | `ui.player-overlays`, `playback` | overlay provider, observer | Planned | High | Highway section overlay behavior. |
| `setlist` | `library`, `playback`, `ui.plugin-screens`, `backend.routes` | requester/provider, screen provider, route provider | Library/playback active; UI/routes planned | High | Setlist screen/routes and song selection/playback workflow. |
| `sloppak_converter` | `media-import-export`, `jobs`, `library`, `ui.plugin-screens`, `backend.routes`, `ui.library-card-injection` | conversion provider, job provider, route provider | Library active; jobs/UI/routes planned; media/card missing | High | Converter routes, queue UI, library card actions, conversion jobs. |
| `virtuoso` | `ui.plugin-screens`, `backend.routes`, `settings`, `visualization` | screen provider, route provider, observer | Active | High | Contained practice studio (scale/technique/rhythm drills, workouts, jam backing); borrows the 3D highway visualization. |
| `song_preview` | `playback`, `audio-mix`, `ui.plugin-screens`, `backend.routes`, `settings` | preview provider, route provider, audio participant | Playback/audio-mix active; UI/routes planned | Medium | Preview screen/routes/settings and audio preview behavior. |
| `splitscreen` | `ui.player-panels`, `ui.player-overlays`, `visualization`, `playback`, `keyboard-shortcuts`, `settings` | panel provider, observer, shortcut provider | Playback active; UI/visualization planned; shortcuts missing | High | Multi-highway panels, playback/screen wrappers, panel shortcuts/settings. |
| `stem_mixer` | `stems`, `audio-mix`, `ui.plugin-screens`, `backend.routes`, `settings`, `jobs` | stem provider, mixer provider, route provider | Audio active; jobs planned | High | Stems mixer routes/settings and stem/audio mix ownership. |
| `step_mode` | `ui.player-overlays`, `playback`, `settings`, `keyboard-shortcuts` | overlay provider, observer, shortcut provider | Shortcuts missing | Medium | Player overlay/settings and step-practice behavior. |
| `studio` | `audio-mix`, `audio-input`, `audio-monitoring`, `recording`, `media-import-export`, `jobs`, `ui.plugin-screens`, `backend.routes` | DAW provider, route provider, job provider | Audio active; jobs/UI/routes planned; recording/media missing | Medium | Studio screen/routes, multitrack recording/mixing workflows. |
| `tab_import` | `media-import-export`, `ui.plugin-screens`, `backend.routes`, `jobs` | import provider, route provider, job provider | Media missing; jobs planned | High | Tab import screen/routes. |
| `tabview` | `visualization`, `backend.routes` | visualization provider, route provider | Planned | High | `type: "visualization"` and backend tab routes. |
| `themes` | `settings`, `ui.theme` | theme provider | Settings planned; theme domain missing | Medium | Global settings/routes for theming. |
| `tones` | `audio-effects`, `playback`, `ui.plugin-screens`, `backend.routes` | tone provider, playback observer, route provider | Audio-effects/playback active; provider adoption pending | High | Tone screen/routes and playback wrapper behavior. |
| `transpose-chords` | `ui.player-overlays`, `visualization`, `playback` | overlay provider, highway observer | Planned | High | Chord/highway reader and playback wrapper behavior. |
| `tutorials` | `tours`, `ui.plugin-screens`, `backend.routes`, `settings` | tutorial provider, route provider | Tours missing | Medium | Tutorial screen/routes/settings and guided content. |
| `update_manager` | `plugins`, `jobs`, `ui.plugin-screens`, `backend.routes`, `external-services` | update provider, job provider, route provider | Plugins/jobs planned; external services missing | Medium | Update screen/routes and desktop/network integration. |

## Domain Coverage Summary

| Domain | Approximate Plugin Count | Roadmap Fit | Notes |
|--------|--------------------------|-------------|-------|
| `ui.plugin-screens` | 24 | Planned | Main extension surface; should include screen lifecycle, visibility, focus, and teardown. |
| `backend.routes` | 25 route files | Planned privileged | Needs route diagnostics, plugin attribution, and privilege review. |
| `settings` | 14 | Planned sensitive | Should cover contribution metadata and backup/import allowlists without exposing values. |
| `visualization` | 6 declared providers plus observers | Planned | Existing renderer factory contract is mature enough to formalize. |
| `ui.player-overlays` | 14 | Planned | Needs overlay placement, visibility, z-order, and coexistence policy. |
| `audio-mix` | 6+ | Active | Runtime control plane exists; migration work is native participant coverage and legacy fader bridge removal gates. |
| `audio-input` | 4+ | Active | Needs broader provider coverage across browser, Desktop, and native paths. |
| `audio-monitoring` | 5+ | Active | Needs broader provider coverage and cross-domain failure smoke tests. |
| `stems` | 3 | Active coordinated provider | Current coordinator/provider split matches plugin ownership. |
| `library` | 3+ | Active | Needs to account for library card actions separately from browsable providers. |
| `jobs` | 7+ | Planned privileged | Conversion/import/update/studio work all need a common job model. |
| `playback` | 9+ | Active | Wrapper chains should migrate to transport commands, requester/observer declarations, and lifecycle events. |
| `note-detection` | 1 | Planned sensitive | Current provider is high-impact enough for a focused spec. |
| `midi-control` | 2 | Planned sensitive | Needs consent, device redaction, and mapping diagnostics. |
| `tempo-clock` | 1+ | Planned | Metronome and practice tools imply clock source/consumer semantics. |
| `plugins` | 2 | Planned privileged | Plugin manager/update manager require confirmation and rollback. |
| `diagnostics` | 2+ | Active | Existing diagnostics contributions should become easier to inspect by domain. |
| `ui.library-card-injection` | 2+ | Missing | Library card buttons/actions are distinct from library source providers. |
| `tours` | 4 | Missing | Guided tours behave like UI overlays with screen navigation coupling. |
| `keyboard-shortcuts` | 2+ | Missing | Existing global shortcut registry needs contribution and conflict policy. |
| `media-import-export` | 6+ | Missing | Import/export/conversion is broader than `jobs` and often uses privileged backend routes. |
| `recording` | 2+ | Missing | Studio and karaoke workflows need capture/session semantics. |
| `audio-effects` | 5+ | Active | Core host, mapping index, provider/executor registry, route gain/release, segment/stage controls, fallback, and diagnostics exist; remaining work is provider adoption and bridge removal. |
| `practice-session` | 4+ | Missing | Practice journal, minigames, theory, and note detection imply scoring/progression state. |
| `collaboration` | 1 | Missing | Multiplayer needs its own trust, identity, and sync model. |
| `external-services` | 3+ | Missing or safety inventory | Network/download/subprocess integrations may be better tracked as safety metadata than as one capability. |

## Operation And Event Gaps

### High Priority

| Domain | Missing Or Under-Specified Surface |
|--------|------------------------------------|
| `playback` | Migrate legacy wrapper users onto active `start`, `pause`, `resume`, `stop`, `seek`, `set-loop`, `clear-loop`, and `inspect` commands plus playback lifecycle events. Keep compatibility bridge hits visible until normal playback/loop/route smoke runs are clean. |
| `audio-effects` | Finish provider adoption: NAM Tone remains the fallback provider/executor and owns the legacy player `Chain` control; Rig Builder owns full-chain routes while enabled/pending/failed/active; Desktop owns trusted native execution only. Remaining gaps are host-backed active mapping read paths, replacement of old fetch/native-load bridges, additional provider declarations for `tones`/`midi_amp`/`audio_engine`, and zero-leak diagnostics around asset refs. |
| `jobs` | Add `register-provider`, `enqueue`, `list`, `inspect`, `cancel`, `pause`, `resume`, and `retry`. Emit `queued`, `started`, `progress`, `log`, `completed`, `failed`, `cancelled`, and `provider-unavailable`. |
| `note-detection` | Add provider registration, active provider selection, note-state provider lifecycle, input binding, hit/miss/state events, calibration diagnostics, and performance-data redaction. |

### Medium Priority

| Domain | Missing Or Under-Specified Surface |
|--------|------------------------------------|
| `ui.plugin-screens` | Define contribution registration, mount/unmount, visibility, focus, navigation, teardown, and rehydration policy. |
| `ui.player-overlays` | Define surface, anchor, z-order, visibility, teardown, hit-testing, and renderer compatibility flags. |
| `ui.player-panels` | Define panel registration, per-panel renderer state, focus, shortcut scope, layout constraints, and teardown. |
| `ui.player-controls` | Define ordered contribution regions, command buttons, popovers, sliders, disabled states, and conflict policy. |
| `visualization` | Formalize provider registration, `contextType`, `matchesArrangement`, `panelControls`, per-panel selection, fallback/revert events, and renderer failure diagnostics. |
| `media-import-export` | Add import/export job requests, accepted file types, source trust metadata, generated artifact paths, and cleanup/failure semantics. |
| `audio-input` | Broaden native/browser provider adoption and test denied/unavailable/degraded/failure outcomes without raw device labels or hardware ids. |
| `audio-monitoring` | Broaden native/browser provider adoption, direct-monitor policy coverage, startup barrier accounting, and safe input-level summaries. |

### Lower Priority Or Cross-Cutting

| Domain | Missing Or Under-Specified Surface |
|--------|------------------------------------|
| `settings` | Add settings contribution metadata, export/import participation, settings schema hints, redaction class, and per-plugin backup diagnostics. |
| `plugins` | Add install/enable/disable/update commands with user confirmation, rollback, disabled-handler enforcement, and desktop bridge failure recovery. |
| `midi-control` | Add device enumerate/open/close, message send/listen, mapping registration, consent, and redacted diagnostics. |
| `tempo-clock` | Add tempo provider registration, BPM/time-signature changes, beat events, metronome tick state, and consumer subscription. |
| `keyboard-shortcuts` | Add shortcut contribution registration, scope, conflict resolution, enable/disable, and help-panel metadata. |
| `tours` | Add tour registration, eligibility, start/stop, step lifecycle, target resolution, and screen navigation dependency declarations. |
| `ui.library-card-injection` | Add card action registration, placement, enabled/disabled state, per-provider applicability, and action-result events. |
| `recording` | Add arm/start/stop capture, take upload/import, latency metadata, capture-source binding, and storage cleanup. |
| `practice-session` | Add session start/stop, goal registration, score/progress events, chart segment focus, and journal persistence boundaries. |
| `collaboration` | Add room/session lifecycle, participant identity redaction, shared playback sync, conflict policy, and disconnect recovery. |

## Audio Domain Notes

The audio graph/session and audio-effects slices should stay scoped to coordination, dispatch, and redaction-safe diagnostics. This inventory reinforces four follow-up requirements:

1. `audio-mix` has a control plane, but native provider coverage and duplicate native-over-legacy cleanup still need release gates before the legacy fader registry can become compatibility-only.
2. `stems` should remain coordinated by core but owned by the active Stems provider. Stem playback, mute/restore semantics, availability, and per-stem state belong to the provider.
3. `audio-input` and `audio-monitoring` should cover both browser and Desktop/native paths without leaking raw device labels, source ids, or capture details in diagnostics.
4. `audio-effects` should keep provider semantics out of Desktop native code. Core selects providers/executors and coordinates route lifecycle; providers resolve opaque chain plans and private trusted asset maps; Desktop only executes the validated native requests and must release/mute routes cleanly. Provider-positive UI should follow route ownership: the legacy player `Chain` control belongs to `nam_tone` and should stay hidden while Rig Builder owns tones.

## Recommended Roadmap Updates

1. Finish audio-effects provider adoption and bridge removal gates: NAM Tone and Rig Builder should read/write the core mapping index first, route playback through the active provider/executor path, and reserve legacy fetch/native-load/DB bridges for fallback/import only.
2. Move long-running and privileged plugin work behind host-owned `jobs` and privileged-operation inventories before migrating converter/import/update/studio/Rig Builder routes. This gives backend work a shared cancellation/progress/error and approval model.
3. Promote `note-detection` as its own sensitive provider domain. It touches audio input, monitoring, visualization feedback, calibration, and diagnostics.
4. Create a UI contribution host spec that includes `ui.navigation`, `ui.plugin-screens`, `ui.player-controls`, `ui.player-overlays`, `ui.player-panels`, `keyboard-shortcuts`, and possibly `tours`.
5. Add missing candidate domains or safety inventories for `media-import-export`, `recording`, `practice-session`, `collaboration`, `ui.library-card-injection`, and `external-services`.
6. Revisit active playback consumers and retire wrapper-only tone/overlay/visualizer integrations once requester/observer declarations and compatibility bridge counts show clean normal playback.

## Suggested Manifest Direction

When these plugins migrate, manifests should describe intent even before runtime handlers hydrate. For example, a visualization plugin might declare:

```json
{
  "standards": ["capability-pipelines.v1", "plugin-runtime-idempotent.v1"],
  "capabilities": {
    "visualization": {
      "roles": ["provider"],
      "operations": ["renderer.create", "renderer.destroy", "renderer.inspect"],
      "emits": ["renderer-ready", "renderer-failed"],
      "mode": "optional",
      "compatibility": "legacy-window-shim",
      "safety": "safe"
    }
  }
}
```

An audio plugin that participates in the active audio-session domains should declare requester/provider relationships more explicitly:

```json
{
  "capabilities": {
    "audio-mix": {
      "roles": ["provider"],
      "operations": ["fader.get-value", "fader.set-value"],
      "emits": ["fader-value-changed"],
      "mode": "active",
      "compatibility": "legacy-window-shim",
      "safety": "safe"
    },
    "stems": {
      "roles": ["requester", "observer"],
      "requests": ["mute", "restore", "inspect"],
      "observes": ["owner-available", "automation-applied", "automation-restored", "automation-overridden", "claim-orphaned"],
      "mode": "active",
      "compatibility": "none",
      "safety": "safe"
    }
  }
}
```

For active domains, command and operation names should follow [capability-domains.md](capability-domains.md) and the relevant host module. For deferred domains, these examples remain direction markers rather than current contracts.

## Highway String Colors (data-plane API)

User-customizable per-string highway colors (the "Highway String Colors" setting in the 3D Highway plugin's panel) are **not** a capability domain. Consistent with `capability-domains.md` keeping highway-rendering and `visualization` surfaces off the capability graph until a dedicated render-facade slice lands, they are exposed as a synchronous **data-plane** API on `window.feedBack.highwayColors` plus a change event. Visualization/overlay plugins (custom highways, minigames, fretboard widgets) should read colors from here so their gems/strings match the user's theme.

Colors are keyed by **named string slot**, not raw index, so a string keeps its color across arrangements (Low E stays Low E's color on a 6-string guitar, 4-string bass, or 7/8-string, where the extra low strings use the `low7`/`low8` slots). Slots: `highE`, `B`, `G`, `D`, `A`, `lowE`, `low7` (7-string Low B), `low8` (8-string Low F#).

`window.feedBack.highwayColors` (`version: 1`):

| Member | Returns | Purpose |
|--------|---------|---------|
| `slots` | `[{key,label,sub}]` | Ordered named slots (stable `key`s). |
| `get()` | `{slot:hex}` | User overrides only (`{}` = pure defaults). |
| `getDefaults()` | `{slot:hex}` | Canonical default color per slot. |
| `getResolved()` | `{slot:hex}` | Defaults overlaid with overrides — colors in effect by name. |
| `keysForChart(sc, isBass)` | `[slotKey…]` | Which slot each chart string index maps to (index 0 = lowest). |
| `toEffective(sc?, isBass?)` | `[hex…]` | Per-string-**index** colors for an arrangement (resolved). Omit args for the loaded chart. |
| `getCurrent()` | `[hex…]` | Per-index colors actually applied to the live 2D highway right now. |
| `apply(slotMap)` | — | Set colors (persists + applies to both highways); `null`/`{}` reverts. |
| `encodeShare(name, map)` / `decodeShare(code)` | `string` / `{name,colors}` | The `SLOPHWY2.` copy/paste share format. |
| `onChange(fn)` / `offChange(fn)` | unsubscribe fn | `fn(resolvedMap)` fires on any color change (also on song load when the slot→index mapping shifts). |

The underlying change event is `window.feedBack.emit('highway:stringColors', …)`; `onChange` wraps it and hands back the resolved map. The raw `window.highway.getStringColors()` data-plane accessor (per-index) remains available for renderers that only need the current applied array. When a `visualization` capability slice eventually lands, this facade is the natural thing to fold into it.

## Validation Notes

This report should be revisited after more bundled plugins adopt manifest capability declarations. The document now separates current first-party declarations from inferred legacy behavior; the next revision should turn each active-domain row into a removal-gate checklist with Capability Inspector smoke output, bridge-hit expectations, and support-bundle redaction checks.