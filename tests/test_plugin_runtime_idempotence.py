import re
from pathlib import Path

import pytest


ROOT = Path(__file__).resolve().parents[1]
WORKSPACE_ROOT = ROOT.parent

# The plugin loader was carved out of static/app.js into its own module (R3a).
# These tests assert on its source text, so they read it from its new home.
PLUGIN_LOADER = ROOT / "static" / "js" / "plugin-loader.js"


def _sibling_file(plugin_dir: str, filename: str) -> Path:
    path = WORKSPACE_ROOT / plugin_dir / filename
    if not path.exists():
        pytest.skip(f"requires sibling plugin checkout: {plugin_dir}/{filename}")
    return path


def _sibling_text(plugin_dir: str, filename: str, required_token: str | None = None) -> str:
    text = _sibling_file(plugin_dir, filename).read_text(encoding="utf-8")
    if required_token and required_token not in text:
        pytest.skip(f"requires {plugin_dir} checkout with {required_token}")
    return text


def test_plugin_loader_guards_duplicate_hydration_and_scripts():
    source = PLUGIN_LOADER.read_text(encoding="utf-8")

    assert "let _loadPluginsInFlight = false" in source
    assert "window.feedBack._loadedPluginScripts" in source
    assert "document.querySelectorAll('.screen[id^=\"plugin-\"]')" in source


def test_plugin_loader_unmounts_previous_ui_contributions_before_reregistering():
    source = PLUGIN_LOADER.read_text(encoding="utf-8")

    assert "const _pluginUiContributions = new Map()" in source
    assert "await _commandUiDomain(contribution.domain, 'unmount', plugin, contribution)" in source
    assert "await _commandUiDomain(contribution.domain, 'register-contribution', plugin, contribution)" in source
    assert "await _commandUiDomain(contribution.domain, 'mount', plugin, contribution)" in source


def test_plugin_loader_does_not_treat_response_absence_as_uninstall():
    # A plugin transiently absent from /api/plugins (the backend clears its
    # registry at the start of load_plugins() and repopulates incrementally
    # while HTTP stays up, so restarts serve partial responses) must NOT be
    # torn down: the old absence sweep unmounted UI contributions and
    # unregistered the capability participant with no re-registration path
    # (plugin scripts don't re-run), and the DOM/style wipes forced a
    # mid-session screen.js re-evaluation that duplicated the desktop
    # audio_engine's native signal chain.
    source = PLUGIN_LOADER.read_text(encoding="utf-8")

    # The absence-triggered sweep is gone (rationale comment in its place)...
    assert "const livePluginIds" not in source
    assert "const stalePlugin = { id: pluginId }" not in source
    assert "deliberately NO stale-contribution sweep" in source
    # ...and the DOM/style reconcilers only act on plugins the response names.
    assert "const respondedIds = new Set(plugins.map((p) => p.id))" in source
    assert "respondedIds.has(pid) && !alreadyHydrated.has(pid)" in source
    assert "responded.has(id) && !styled.has(id)" in source



def test_capability_visualizer_waits_for_registry_instead_of_hard_error():
    source = _sibling_file("feedBack-plugin-capability-visualizer", "screen.js").read_text(encoding="utf-8")

    assert "scheduleRegistryRetry" in source
    assert "Capability runtime is loading..." in source
    assert "Capability registry unavailable" not in source


def test_app_shell_loads_capability_registry_before_app_runtime():
    source = (ROOT / "static" / "v3" / "index.html").read_text(encoding="utf-8")

    assert re.search(r'<script[^>]+src="/static/capabilities\.js"', source)
    assert re.search(r'<script[^>]+src="/static/capabilities/library\.js"', source)
    assert source.index('/static/diagnostics.js') < source.index('/static/capabilities.js')
    assert source.index('/static/capabilities.js') < source.index('/static/capabilities/library.js')
    assert source.index('/static/capabilities/library.js') < source.index('/static/app.js')


def test_every_external_script_defers_so_document_order_is_execution_order():
    """The shell's scripts must all execute in document order.

    `capabilities.js` builds the `window.feedBack` bus and must run before
    `app.js`, which calls `window.feedBack.on(...)` at top level. Today document
    order gives that for free, because every script is a parse-time classic one.

    That guarantee survives the ES-module migration ONLY while no script is a
    *plain* classic script: `defer` and `type="module"` scripts share one
    "execute after parsing" list and run in document order, but a plain classic
    script runs DURING parse — ahead of every deferred one. So the moment
    capabilities.js becomes a module while app.js is still plain, app.js runs
    first and `window.feedBack.on` is undefined.

    Pinning "no plain external scripts" is what keeps that from silently
    regressing as tags flip to type="module" one at a time.
    """
    source = (ROOT / "static" / "v3" / "index.html").read_text(encoding="utf-8")

    plain = [
        tag for tag in re.findall(r'<script\b[^>]*\bsrc=[^>]*>', source)
        if 'defer' not in tag and 'async' not in tag and 'type="module"' not in tag
    ]
    assert not plain, f"external scripts that would jump the deferred queue: {plain}"


def test_capability_registry_exposes_claim_dispatch_and_ready_contracts():
    source = (ROOT / "static" / "capabilities.js").read_text(encoding="utf-8")

    for token in ["function claim(", "function release(", "async function dispatch(", "function subscribe(", "getDiagnostics: snapshotDiagnostics"]:
        assert token in source
    assert "activeClaims" in source
    assert "feedBack:capabilities:ready" in source
    assert "outcome: 'overridden'" in source


def test_capability_runtime_overrides_do_not_mask_claims():
    source = (ROOT / "static" / "capabilities.js").read_text(encoding="utf-8")
    set_enabled = source[source.index("function setParticipantEnabled("):source.index("function registerParticipants(")]
    reserved = source[source.index("const RESERVED_FUTURE_DOMAINS"):source.index("const RUNTIME_DOMAIN_DEFAULTS")]

    assert "['denied', 'failed', 'short-circuited', 'handled', 'degraded', 'overridden', 'no-owner', 'no-handler', 'no-target', 'unsupported-command', 'incompatible', 'incompatible-version', 'unavailable', 'provider-selection-required', 'user-action-required', 'stale', 'cancelled', 'stopped'].includes(decision.outcome)" in source
    assert "if (entry.type !== 'manual') return false;" in source
    assert "type: 'manual'" in source
    assert "_remember(userOverrides" not in set_enabled
    assert "'audio-monitoring'" not in reserved
    assert "'audio-mix'" not in reserved
    assert "'audio-input'" not in reserved
    assert "'playback'" not in reserved
    assert "playback:" in source
    assert "'backend.routes'" in reserved
    assert "'backend.routes':" not in source


def test_deferred_runtime_domains_remain_reserved_not_bridged():
    capability_source = (ROOT / "static" / "capabilities.js").read_text(encoding="utf-8")
    reserved = capability_source[capability_source.index("const RESERVED_FUTURE_DOMAINS"):capability_source.index("const RUNTIME_DOMAIN_DEFAULTS")]
    review = capability_source[capability_source.index("const CORE_DOMAIN_REVIEW"):capability_source.index("const EXPECTED_COMPATIBILITY_SHIMS")]

    # Domains still reserved (not yet promoted).
    for token in ["'ui.navigation'"]:
        assert token in reserved, f"{token} should still be in RESERVED_FUTURE_DOMAINS"
        assert token not in review, f"{token} should not yet appear in CORE_DOMAIN_REVIEW"
    # 'visualization' was promoted to an active domain (cap:6).
    assert "'visualization'" not in reserved, "'visualization' should have been removed from RESERVED_FUTURE_DOMAINS after promotion"
    assert "visualization:" in review, "'visualization' should appear in CORE_DOMAIN_REVIEW after promotion"
    # 'note-detection' was promoted to an active domain (cap:9 / spec 009).
    assert "'note-detection'" not in reserved, "'note-detection' should have been removed from RESERVED_FUTURE_DOMAINS after promotion"
    assert "note-detection':" in review, "'note-detection' should appear in CORE_DOMAIN_REVIEW after promotion"
    assert "playback:" in review
    assert "chartT: _chartTime(audioT)" not in capability_source
    assert "loop: _loopSnapshot()" not in capability_source


def test_capability_events_do_not_bridge_deferred_surfaces():
    # These are NEGATIVE assertions, so they must span every file the code could
    # have moved to — otherwise carving a function out of app.js turns the guard
    # vacuous instead of failing.
    app_source = (
        (ROOT / "static" / "app.js").read_text(encoding="utf-8")
        + PLUGIN_LOADER.read_text(encoding="utf-8")
    )
    capability_source = (ROOT / "static" / "capabilities.js").read_text(encoding="utf-8")

    for token in ["return 'ui.navigation'", "return 'note-detection'", "eventName.startsWith('viz:') || eventName.startsWith('highway:')"]:
        assert token not in app_source
    for token in ["'navigate'", "'screen:changed'", "function _navigate(", "window.feedBack.navigate(id, params)"]:
        assert token not in capability_source


def test_plugin_loader_registers_manifest_capability_declarations():
    source = PLUGIN_LOADER.read_text(encoding="utf-8")

    assert "const capabilityPlugins = fetchedPlugins.slice().sort((a, b) => String(a.id || '').localeCompare(String(b.id || '')))" in source
    assert "capabilityApi.registerParticipants(capabilityPlugins)" in source
    assert "window.feedBack.capabilities.registerParticipants(plugins)" not in source
    assert "plugin-manifest-load" in source


def test_app_event_bus_dispatches_locally_and_preserves_juce_stop_state():
    source = (ROOT / "static" / "app.js").read_text(encoding="utf-8")

    assert "this.dispatchEvent(new CustomEvent(event, { detail }))" in source
    # `isPlaying` moved onto the shared player-state container (static/js/player-state.js)
    # so a carved module can WRITE it — an imported binding is read-only.
    assert "const hadPlayableSong = !!audio.src || !!window._juceAudioUrl || S.isPlaying" in source
    assert "sm.emit('song:resume', payload)" in source
    assert "window.feedBack.emit('song:resume', payload)" in source


def test_nam_and_stems_use_owner_claim_dispatch_semantics():
    nam_source = _sibling_text("feedBack-plugin-nam-tone", "screen.js", "NAM_STEM_CLAIM_ID = 'nam.amp-active'")
    stems_source = _sibling_text("feedBack-plugin-stems", "screen.js", "claimSnapshots")

    assert "NAM_STEM_CLAIM_ID = 'nam.amp-active'" in nam_source
    assert "api.dispatch({" in nam_source
    assert "command: 'mute'" in nam_source
    assert "command: 'restore'" in nam_source
    assert "claim: { claimId, requester: NAM_PLUGIN_ID }" in nam_source
    assert "window._stemsState" not in nam_source
    assert "claimSnapshots" in stems_source
    assert "api.registerParticipant('stems'" in stems_source
    assert "mute: capMute" in stems_source
    assert "restore: capRestore" in stems_source
    assert "recordUserOverride" in stems_source
    assert "clearClaimSnapshots" in stems_source
    assert "'claim:released'" in stems_source


def test_nam_screen_uses_stable_singleton_hooks_for_rehydration():
    source = _sibling_text("feedBack-plugin-nam-tone", "screen.js", "window.__feedBackNamHooks")
    manifest = _sibling_text("feedBack-plugin-nam-tone", "plugin.json", "capability-pipelines.v1")

    assert "plugin-runtime-idempotent.v1" in manifest
    assert "capability-pipelines.v1" in manifest
    assert "window.__feedBackNamHooks" in source
    assert "hookState.impl" in source
    assert "if (hookState.installed) return" in source


def test_stems_screen_uses_stable_singleton_hooks_for_rehydration():
    source = _sibling_text("feedBack-plugin-stems", "screen.js", "window.__feedBackStemsHooks")
    manifest = _sibling_text("feedBack-plugin-stems", "plugin.json", "capability-pipelines.v1")

    assert "plugin-runtime-idempotent.v1" in manifest
    assert "capability-pipelines.v1" in manifest
    assert "window.__feedBackStemsHooks" in source
    assert "hookState.impl" in source
    assert "if (hookState.installed) return" in source