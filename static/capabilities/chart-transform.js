// Chart-transform provider registration, selection, and diagnostics.
// Transformation stays on the synchronous highway data plane and runs after
// difficulty filtering; the selected provider is shared by highway instances.
(function () {
    'use strict';

    window.feedBack = window.feedBack || {};
    const capabilities = window.feedBack.capabilities;
    if (!capabilities || capabilities.version !== 1) return;
    if (window.feedBack.chartTransformDomain && window.feedBack.chartTransformDomain.version === 1) return;

    const STORAGE_KEY = 'feedBack.chartTransform.selectedProviderId';
    const PUBLIC_FAILURE_REASON = 'Chart transform provider failed';

    // providerId → { id, label, pluginId, transform }
    const providers = new Map();
    let activeProviderId = null;
    let activeSource = 'startup';
    let lastFailure = null;
    // Count of highway instances the active provider is installed on
    // (the primary window.highway plus any announced via highway:created —
    // e.g. splitscreen panels). 0 = nothing capable exists yet.
    let installedCount = 0;
    // Known highway surfaces beyond window.highway, held weakly so closed
    // splitscreen panels can be collected. WeakRef is guarded for minimal
    // test environments; the strong-ref fallback only over-retains there.
    const _HasWeakRef = typeof WeakRef === 'function';
    let _surfaces = [];

    function _handled(payload = {}) { return { outcome: 'handled', payload }; }
    function _degraded(reason, payload = {}) { return { outcome: 'degraded', reason, payload }; }

    function _snapshot(extra = {}) {
        return {
            available: true,
            active: activeProviderId,
            activeSource,
            installed: installedCount > 0,
            surfaces: installedCount,
            providers: [...providers.values()].map(p => ({
                id: p.id,
                label: p.label,
                pluginId: p.pluginId,
            })),
            lastFailure: lastFailure ? { ...lastFailure } : null,
            ...extra,
        };
    }

    function _emit(name, detail) {
        try { capabilities.emitEvent('chart-transform', name, detail || {}); }
        catch (_) { /* eventing must not break rendering */ }
    }

    function _contributeDiagnostics() {
        const diagnostics = window.feedBack && window.feedBack.diagnostics;
        if (diagnostics && typeof diagnostics.contribute === 'function') {
            try {
                diagnostics.contribute('chart-transform-capability', {
                    schema: 'feedBack.chart_transform.diagnostics.v1',
                    ..._snapshot(),
                });
            } catch (_) { /* diagnostics must not break rendering */ }
        }
    }

    function _persistSelection(providerId) {
        try {
            if (providerId) window.localStorage.setItem(STORAGE_KEY, providerId);
            else window.localStorage.removeItem(STORAGE_KEY);
        } catch (_) { /* storage unavailable → in-memory selection only */ }
    }

    function _persistedSelection() {
        try { return window.localStorage.getItem(STORAGE_KEY) || null; }
        catch (_) { return null; }
    }

    function _capable(hw) {
        return !!(hw && typeof hw.setChartTransform === 'function');
    }

    // Every capable highway surface: window.highway plus live announced
    // instances (splitscreen panels), deduped, dead refs pruned in place.
    function _eachSurface(fn) {
        const seen = new Set();
        const primary = window.highway;
        if (_capable(primary)) { seen.add(primary); fn(primary); }
        const live = [];
        for (const ref of _surfaces) {
            const hw = _HasWeakRef ? ref.deref() : ref;
            if (!hw) continue;
            live.push(ref);
            if (seen.has(hw) || !_capable(hw)) continue;
            seen.add(hw);
            fn(hw);
        }
        _surfaces = live;
        return seen.size;
    }

    function _rememberSurface(hw) {
        if (!_capable(hw) || hw === window.highway) return;
        let known = false;
        _eachSurface(() => {});
        for (const ref of _surfaces) {
            if ((_HasWeakRef ? ref.deref() : ref) === hw) { known = true; break; }
        }
        if (!known) _surfaces.push(_HasWeakRef ? new WeakRef(hw) : hw);
    }

    // Hand the current selection to every highway surface (or clear it).
    // Selection survives with zero surfaces — it re-applies as instances
    // appear (song:ready for the primary, highway:created for panels).
    function _install() {
        const provider = activeProviderId ? providers.get(activeProviderId) : null;
        const payload = provider ? { id: provider.id, transform: provider.transform } : null;
        installedCount = 0;
        _eachSurface((hw) => {
            try {
                hw.setChartTransform(payload);
                if (payload) installedCount += 1;
            } catch (_) { /* one broken surface must not block the rest */ }
        });
        return installedCount > 0 || payload === null;
    }

    function _setActive(providerId, source) {
        const from = activeProviderId;
        activeProviderId = providerId;
        activeSource = String(source || 'unknown');
        _persistSelection(providerId);
        _install();
        if (from !== providerId) {
            _emit('transform-changed', { from, to: providerId, source: activeSource });
        }
        _contributeDiagnostics();
    }

    function _payload(ctx = {}) {
        return ctx.payload && typeof ctx.payload === 'object' ? ctx.payload : {};
    }

    function _providersForParticipant(participantId) {
        return [...providers.values()].filter(provider => provider.pluginId === participantId);
    }

    function _registerProviderParticipant(participantId) {
        const owned = _providersForParticipant(participantId);
        if (!owned.length) return;
        capabilities.registerParticipant(participantId, {
            'chart-transform': {
                roles: ['provider'],
                operations: ['chart.transform'],
                events: [],
                mode: 'active',
                compatibility: 'none',
                safety: 'safe',
                runtime: true,
                description: `${owned.length} registered chart transform provider${owned.length === 1 ? '' : 's'}.`,
                provider_policy: {
                    providerIds: owned.map(provider => provider.id),
                    providers: owned.map(provider => ({ id: provider.id, label: provider.label })),
                },
            },
        });
    }

    function _registerProvider(ctx = {}) {
        const payload = _payload(ctx);
        const providerId = String(payload.providerId || payload.id || '').trim();
        if (!providerId) return _degraded('Provider registration requires a providerId', _snapshot());
        if (typeof payload.transform !== 'function') {
            return _degraded('Provider registration requires a transform(input) function', _snapshot());
        }
        const participantId = String(ctx.source || ctx.requester || providerId);
        const existing = providers.get(providerId);
        if (existing && existing.pluginId !== participantId) {
            return _degraded(
                `Provider ${providerId} is already registered by a different participant`,
                _snapshot(),
            );
        }
        providers.set(providerId, {
            id: providerId,
            label: String(payload.label || providerId),
            pluginId: participantId,
            transform: payload.transform,
        });
        _registerProviderParticipant(participantId);
        _emit('provider-registered', { providerId });
        // Restore a persisted selection the moment its provider appears.
        if (!activeProviderId && _persistedSelection() === providerId) {
            _setActive(providerId, 'restore-selection');
        } else if (activeProviderId === providerId) {
            // Re-registration after script rehydration: reinstall the fresh
            // transform closure so the highway isn't holding a stale one.
            _install();
        }
        _contributeDiagnostics();
        return _handled(_snapshot({ registered: providerId }));
    }

    function _unregisterProvider(ctx = {}) {
        const payload = _payload(ctx);
        const providerId = String(payload.providerId || payload.id || '').trim();
        const provider = providers.get(providerId);
        if (!provider) return _degraded(`Unknown chart-transform provider: ${providerId || '(none)'}`, _snapshot());
        const callerId = String(ctx.source || ctx.requester || providerId);
        if (provider.pluginId !== callerId) {
            return _degraded(
                `Provider ${providerId} can only be unregistered by its original registrant`,
                _snapshot(),
            );
        }
        providers.delete(providerId);
        if (activeProviderId === providerId) {
            // Keep the persisted selection so the provider re-activates on
            // its next registration; just detach it from the highway.
            activeProviderId = null;
            _install();
            _emit('transform-changed', { from: providerId, to: null, source: 'provider-unregistered' });
        }
        const remainingProviders = _providersForParticipant(provider.pluginId);
        if (remainingProviders.length) {
            _registerProviderParticipant(provider.pluginId);
        } else if (typeof capabilities.unregisterParticipant === 'function') {
            const live = typeof capabilities.inspect === 'function' ? capabilities.inspect('chart-transform') : null;
            const participant = ((live && live.participants) || []).find(p => p.pluginId === provider.pluginId);
            const roles = participant && Array.isArray(participant.roles) ? participant.roles : [];
            const providerOnly = roles.length === 1 && roles[0] === 'provider';
            if (!participant || providerOnly) {
                try { capabilities.unregisterParticipant(provider.pluginId, 'chart-transform'); }
                catch (_) { /* participant cleanup is best-effort */ }
            }
        }
        _emit('provider-unregistered', { providerId });
        _contributeDiagnostics();
        return _handled(_snapshot({ unregistered: providerId }));
    }

    function _targetProviderId(ctx = {}) {
        const payload = _payload(ctx);
        const target = ctx.target && typeof ctx.target === 'object' ? ctx.target : {};
        return String(
            target.providerId || target.provider_id || target.id
            || payload.providerId || payload.provider_id || payload.id
            || (typeof ctx.target === 'string' ? ctx.target : '') || ''
        ).trim();
    }

    function _selectProvider(ctx = {}) {
        const providerId = _targetProviderId(ctx);
        if (!providerId) return _degraded('Transform selection requires a provider id', _snapshot());
        if (!providers.has(providerId)) {
            return _degraded(`Unknown chart-transform provider: ${providerId}`, _snapshot());
        }
        _setActive(providerId, ctx.requester ? `command:${ctx.requester}` : 'command');
        return _handled(_snapshot({ selected: providerId }));
    }

    function _clearProvider(ctx = {}) {
        _setActive(null, ctx.requester ? `command:${ctx.requester}` : 'command');
        return _handled(_snapshot({ cleared: true }));
    }

    function _refresh() {
        if (!activeProviderId || installedCount === 0) return _handled(_snapshot({ refreshed: false }));
        let refreshed = 0;
        _eachSurface((hw) => {
            if (typeof hw.refreshChartTransform !== 'function') return;
            try { hw.refreshChartTransform(); refreshed += 1; }
            catch (_) { /* one broken surface must not block the rest */ }
        });
        return _handled(_snapshot({ refreshed: refreshed > 0 }));
    }

    capabilities.registerOwner('chart-transform', {
        pluginId: 'core.chart-transform',
        kind: 'provider-coordinator',
        safety: 'safe',
        commands: ['inspect', 'list-providers', 'register-provider', 'unregister-provider', 'select-provider', 'clear-provider', 'refresh'],
        operations: ['chart.transform'],
        events: ['provider-registered', 'provider-unregistered', 'transform-changed', 'transform-failed'],
        description: 'Owns chart-transform providers: pre-render/pre-scoring chart substitution applied after difficulty filtering, with selection, refresh, and failure attribution.',
        handlers: {
            inspect: () => _handled(_snapshot()),
            'list-providers': () => _handled(_snapshot()),
            'register-provider': (ctx) => _registerProvider(ctx),
            'unregister-provider': (ctx) => _unregisterProvider(ctx),
            'select-provider': (ctx) => _selectProvider(ctx),
            'clear-provider': (ctx) => _clearProvider(ctx),
            refresh: () => _refresh(),
        },
    });

    // Bus mirroring (guarded: the bus may not exist in minimal/test envs).
    const sm = window.feedBack;
    if (typeof sm.on === 'function') {
        try {
            sm.on('highway:chart-transform-failed', (e) => {
                const detail = (e && e.detail) || e || {};
                lastFailure = {
                    providerId: String(detail.id || activeProviderId || 'unknown'),
                    reason: PUBLIC_FAILURE_REASON,
                };
                _emit('transform-failed', { ...lastFailure });
                _contributeDiagnostics();
            });
            // The primary highway is created after this module evaluates —
            // install a pending selection once a song is loading/ready.
            sm.on('song:ready', () => {
                if (activeProviderId && installedCount === 0 && _install()) {
                    // setChartTransform restages immediately, so the chart
                    // that just became ready picks the transform up now.
                    _contributeDiagnostics();
                }
            });
            // Additional instances restage the active provider against their
            // own chart state.
            sm.on('highway:created', (e) => {
                const detail = (e && e.detail) || e || {};
                if (!_capable(detail.highway)) return;
                _rememberSurface(detail.highway);
                if (activeProviderId) _install();
                _contributeDiagnostics();
            });
        } catch (_) { /* bus mirroring is best-effort */ }
    }

    window.feedBack.chartTransformDomain = {
        version: 1,
        snapshot: _snapshot,
    };
    _contributeDiagnostics();
})();
