// Core visualization capability domain (cap:6).
//
// Promotes the highway renderer surface into the capability graph as a
// provider-coordinator: viz plugins are providers, the core picker/auto-match
// machinery in app.js is the selection workflow, and selection / failure /
// fallback are attributed in redaction-safe diagnostics.
//
// Legacy bridge: today's plugins keep working unchanged. Discovery still
// happens through `type: "visualization"` manifests and `window.feedBackViz_*`
// factory globals — both are registered here as compatibility shims and their
// hits accounted, per the promotion checklist in docs/capability-roadmap.md.
// app.js calls the small runtime API on `window.feedBack.vizDomain` at its
// existing integration points (picker population, renderer install); this
// module owns everything else.
(function () {
    'use strict';

    window.feedBack = window.feedBack || {};
    const capabilities = window.feedBack.capabilities;
    if (!capabilities || capabilities.version !== 1) return;
    if (window.feedBack.vizDomain && window.feedBack.vizDomain.version === 1) return;

    // providerId → { id, label, contextType, claims } in picker (= directory)
    // order, which is the auto-match precedence order.
    let providers = [];
    let activeProviderId = 'default';
    let activeSource = 'startup';
    // Last auto-match evaluation: { resolved, matched } — resolved provider id
    // ('default' on fallthrough) and whether any predicate claimed the song.
    // Deliberately carries no song identity (redaction rule).
    let lastAutoMatch = null;
    let lastFailure = null;

    function _handled(payload = {}) { return { outcome: 'handled', payload }; }
    function _degraded(reason, payload = {}) { return { outcome: 'degraded', reason, payload }; }

    function _factoryFor(providerId) {
        const factory = window['feedBackViz_' + providerId];
        return typeof factory === 'function' ? factory : null;
    }

    function _snapshot(extra = {}) {
        return {
            available: true,
            current: activeProviderId,
            currentSource: activeSource,
            providers: providers.map(provider => ({ ...provider })),
            lastAutoMatch: lastAutoMatch ? { ...lastAutoMatch } : null,
            lastFailure: lastFailure ? { ...lastFailure } : null,
            ...extra,
        };
    }

    function _emit(name, detail) {
        try { capabilities.emitEvent('visualization', name, detail || {}); }
        catch (_) { /* eventing must not break rendering */ }
    }

    function _contributeDiagnostics() {
        const diagnostics = window.feedBack && window.feedBack.diagnostics;
        if (diagnostics && typeof diagnostics.contribute === 'function') {
            try {
                diagnostics.contribute('visualization-capability', {
                    schema: 'feedBack.visualization_capability.v1',
                    ..._snapshot(),
                });
            } catch (_) { /* diagnostics must not break rendering */ }
        }
    }

    // Participant ids registered into the `visualization` pipeline by this
    // module, so a refresh can drop providers that disappeared (plugin
    // uninstalled, factory failed to register). Mirrors library.js.
    let _registeredParticipantIds = new Set();

    function _registerProviderParticipants() {
        const nextIds = new Set();
        for (const provider of providers) {
            if (!provider.id) continue;
            capabilities.registerParticipant(provider.id, {
                visualization: {
                    roles: ['provider'],
                    operations: ['renderer.create', 'renderer.destroy'],
                    events: [],
                    mode: 'active',
                    // Providers reached us through the legacy window-global
                    // surface until they declare `capabilities` in their own
                    // manifests; account for that honestly.
                    compatibility: 'legacy-window-shim',
                    safety: 'safe',
                    runtime: true,
                    description: `Highway renderer ${provider.label || provider.id}.`,
                    provider_policy: {
                        providerId: provider.id,
                        label: provider.label || provider.id,
                        contextType: provider.contextType,
                        claims: provider.claims,
                        hasSettings: !!(provider.settings && provider.settings.length),
                    },
                },
            });
            nextIds.add(provider.id);
        }
        if (typeof capabilities.unregisterParticipant === 'function') {
            const live = typeof capabilities.inspect === 'function' ? capabilities.inspect('visualization') : null;
            const liveById = new Map(((live && live.participants) || []).map(p => [p.pluginId, p]));
            for (const pluginId of _registeredParticipantIds) {
                if (nextIds.has(pluginId)) continue;
                const participant = liveById.get(pluginId);
                const roles = participant && Array.isArray(participant.roles) ? participant.roles : [];
                const providerOnly = roles.length === 1 && roles[0] === 'provider';
                if (!participant || providerOnly) {
                    capabilities.unregisterParticipant(pluginId, 'visualization');
                }
            }
        }
        _registeredParticipantIds = nextIds;
    }

    // ── Runtime API consumed by app.js ───────────────────────────────────────

    // Recursively clone + freeze a plain-JSON value. Descriptors are plain JSON
    // (key/label/type/default/min/max/step/options), so a manual recursive clone
    // is enough and avoids depending on structuredClone in older runtimes.
    function _deepFreeze(value) {
        if (Array.isArray(value)) {
            return Object.freeze(value.map(_deepFreeze));
        }
        if (value && typeof value === 'object') {
            // Null-prototype clone so a manifest-controlled `__proto__` key is
            // an ordinary own property, not a prototype-pollution vector
            // (matches static/v3/plugins-page.js re-homing manifest JSON).
            const copy = Object.create(null);
            for (const key of Object.keys(value)) copy[key] = _deepFreeze(value[key]);
            return Object.freeze(copy);
        }
        return value;
    }

    // Deep-clone + deep-freeze declared setting descriptors so a list-providers
    // snapshot consumer can't mutate the domain's internal provider state through
    // the shallow snapshot clone — including nested values under `default`, which
    // the schema leaves unconstrained (it may be an object/array).
    function _freezeSettings(settings) {
        return _deepFreeze(settings);
    }

    // Per-instance control descriptors (feedBack#849) come from the generic
    // capability participant model: a provider declares them in its manifest
    // (capabilities.visualization.settings), core registers + normalizes them,
    // and we read them back here by pluginId. This keeps inspect('visualization')
    // and list-providers in agreement instead of pulling settings from an
    // app.js/picker side channel.
    function _declaredSettingsById() {
        const map = new Map();
        try {
            const live = typeof capabilities.inspect === 'function' ? capabilities.inspect('visualization') : null;
            for (const participant of ((live && live.participants) || [])) {
                if (Array.isArray(participant.settings) && participant.settings.length) {
                    map.set(participant.pluginId, participant.settings);
                }
            }
        } catch (_) { /* inspect is best-effort; absence just means no settings */ }
        return map;
    }

    // Called by _populateVizPicker with [{id, label}] in picker order. The
    // host introspects each factory global for contextType / predicate
    // presence and refreshes provider participants + shim accounting.
    function refreshProviders(entries) {
        const next = [];
        let windowGlobalHits = 0;
        const settingsById = _declaredSettingsById();
        for (const entry of (Array.isArray(entries) ? entries : [])) {
            const id = String(entry && (entry.id || entry.value) || '').trim();
            if (!id || id === 'auto' || id === 'default') continue;
            const factory = _factoryFor(id);
            if (factory) windowGlobalHits += 1;
            const provider = {
                id,
                label: String(entry.label || entry.text || id),
                contextType: factory && typeof factory.contextType === 'string' ? factory.contextType : '2d',
                claims: !!(factory && typeof factory.matchesArrangement === 'function'),
            };
            // Per-instance control descriptors the provider declared in its
            // manifest (capabilities.visualization.settings), read from the
            // registered capability participant (not an app.js side channel). A
            // consuming host (splitscreen) renders these generically and applies
            // values via the renderer instance's applySetting(key, value)
            // (feedBack#849). Deep-cloned + frozen so a list-providers consumer
            // can't mutate internal provider state through the shallow snapshot
            // clone. Absent until a provider declares them in its manifest.
            const declaredSettings = settingsById.get(id);
            if (Array.isArray(declaredSettings) && declaredSettings.length) {
                provider.settings = _freezeSettings(declaredSettings);
            }
            next.push(provider);
        }
        providers = next;
        if (typeof capabilities.registerCompatibilityShim === 'function') {
            capabilities.registerCompatibilityShim({
                capability: 'visualization',
                shimId: 'visualization:window.feedBackViz_*',
                legacySurface: 'window.feedBackViz_* factory globals',
                source: 'core.visualization',
                ownerPluginId: 'core.visualization',
                reason: 'Renderer factories are discovered via window globals until plugins declare visualization capabilities in their manifests.',
                status: windowGlobalHits > 0 ? 'used' : 'active',
                hitCount: windowGlobalHits,
            });
            capabilities.registerCompatibilityShim({
                capability: 'visualization',
                shimId: 'visualization:type-visualization-manifest',
                legacySurface: 'plugin.json type: "visualization"',
                source: 'core.visualization',
                ownerPluginId: 'core.visualization',
                reason: 'Picker candidates come from the legacy manifest type field until plugins declare visualization capabilities.',
                status: providers.length > 0 ? 'used' : 'active',
                hitCount: providers.length,
            });
        }
        _registerProviderParticipants();
        _emit('providers-refreshed', { providers: providers.map(p => p.id) });
        _contributeDiagnostics();
        return _snapshot();
    }

    // Called whenever a renderer is installed (auto-match, user pick, revert
    // fallback). `source` is one of 'auto-match' | 'user-select' | 'fallback'
    // | 'startup'.
    function notifyRendererChanged(providerId, source) {
        const next = String(providerId || 'default');
        const from = activeProviderId;
        activeProviderId = next;
        activeSource = String(source || 'unknown');
        if (from !== next) {
            _emit('renderer-changed', { from, to: next, source: activeSource });
        }
        _contributeDiagnostics();
    }

    // Called by _autoMatchViz after each evaluation. Carries no song identity.
    function noteAutoMatch(resolvedId, matched) {
        lastAutoMatch = { resolved: String(resolvedId || 'default'), matched: !!matched };
        _contributeDiagnostics();
    }

    function _redactFailureReason(value) {
        const normalized = String(value || 'renderer failure')
            // macOS home dirs: /Users/<name>/...
            .replace(/\/Users\/[^\s/]+(?:\/[^\s]*)?/g, '[path]')
            // Windows drive-letter paths: C:\...
            .replace(/[A-Za-z]:\\[^\s]+/g, '[path]')
            // Generic POSIX absolute paths: /home/..., /tmp/..., /app/..., etc.
            .replace(/\/[a-zA-Z][^\s]*(?:\/[^\s]*)?/g, '[path]')
            .replace(/\s+/g, ' ')
            .trim();
        return normalized.length > 160 ? `${normalized.slice(0, 157)}...` : normalized;
    }

    function notifyRendererFailed(providerId, reason) {
        lastFailure = {
            providerId: String(providerId || 'unknown'),
            reason: _redactFailureReason(reason),
        };
        _emit('renderer-failed', { ...lastFailure });
        _contributeDiagnostics();
    }

    // Mirror the legacy event bus into domain events so observers can rely on
    // `visualization:*` without knowing the window bus names. Guarded: the
    // bus may not exist in minimal/test environments.
    const sm = window.feedBack;
    if (typeof sm.on === 'function') {
        try {
            sm.on('viz:renderer:ready', () => _emit('renderer-ready', { providerId: activeProviderId }));
            sm.on('viz:reverted', (e) => {
                const detail = (e && e.detail) || e || {};
                notifyRendererFailed(detail.id || activeProviderId, detail.reason || 'renderer reverted to default');
            });
        } catch (_) { /* bus mirroring is best-effort */ }
    }

    // ── Owner command handlers ───────────────────────────────────────────────

    function _targetProviderId(ctx = {}) {
        const payload = ctx.payload && typeof ctx.payload === 'object' ? ctx.payload : {};
        const target = ctx.target && typeof ctx.target === 'object' ? ctx.target : {};
        return String(
            target.providerId || target.provider_id || target.id
            || payload.providerId || payload.provider_id || payload.id
            || (typeof ctx.target === 'string' ? ctx.target : '') || ''
        ).trim();
    }

    function _selectRenderer(providerId, ctx = {}) {
        if (!providerId) return _degraded('Renderer selection requires a provider id', _snapshot());
        const known = providerId === 'default' || providerId === 'auto'
            || providers.some(provider => provider.id === providerId);
        if (!known) return _degraded(`Unknown visualization provider: ${providerId}`, _snapshot());
        if (typeof window.setViz !== 'function') {
            return _degraded('Renderer selection surface unavailable (app picker not loaded)', _snapshot());
        }
        try { window.setViz(providerId); }
        catch (error) {
            return _degraded(error && error.message ? error.message : String(error), _snapshot());
        }
        // setViz → _installVizRenderer → notifyRendererChanged keeps state in
        // sync; reflect the requester in the source attribution.
        activeSource = ctx.requester ? `command:${ctx.requester}` : 'command';
        _contributeDiagnostics();
        return _handled(_snapshot({ selected: providerId }));
    }

    capabilities.registerOwner('visualization', {
        pluginId: 'core.visualization',
        kind: 'provider-coordinator',
        safety: 'safe',
        commands: ['inspect', 'list-providers', 'select-renderer', 'clear-renderer'],
        operations: ['renderer.create', 'renderer.destroy'],
        events: ['providers-refreshed', 'renderer-changed', 'renderer-ready', 'renderer-failed'],
        description: 'Owns highway renderer providers: discovery, picker selection, auto-match attribution, and failure fallback.',
        handlers: {
            inspect: (ctx) => _handled(_snapshot()),
            'list-providers': (ctx) => _handled(_snapshot()),
            'select-renderer': (ctx) => _selectRenderer(_targetProviderId(ctx), ctx),
            'clear-renderer': (ctx) => _selectRenderer('default', ctx),
        },
    });

    window.feedBack.vizDomain = {
        version: 1,
        snapshot: _snapshot,
        refreshProviders,
        notifyRendererChanged,
        noteAutoMatch,
        notifyRendererFailed,
    };
    _contributeDiagnostics();
})();
