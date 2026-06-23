// Core library capability domain.
(function () {
    'use strict';

    window.feedBack = window.feedBack || {};
    const capabilities = window.feedBack.capabilities;
    if (!capabilities || capabilities.version !== 1) return;
    if (window.feedBack.libraryProviders && window.feedBack.libraryProviders.version === 1) return;

    const PROVIDER_KEY = 'feedBack.libProvider';
    const LOCAL_PROVIDER = Object.freeze({
        id: 'local',
        label: 'My Library',
        kind: 'local',
        capabilities: ['library.read', 'art.read', 'song.play', 'favorite.write', 'metadata.write', 'retune.write'],
        default: true,
    });
    const PROVIDER_OPERATIONS = Object.freeze({
        'library.read': ['query-page', 'query-artists', 'query-stats', 'tuning-names'],
        'art.read': ['get-art'],
        'song.sync': ['sync-song'],
    });

    let providers = [{ ...LOCAL_PROVIDER }];
    let currentProviderId = _readProvider();

    function _readProvider() {
        try { return localStorage.getItem(PROVIDER_KEY) || 'local'; }
        catch (_) { return 'local'; }
    }

    function _writeProvider(providerId) {
        try { localStorage.setItem(PROVIDER_KEY, providerId); }
        catch (_) { /* private mode / quota */ }
    }

    function _strings(value) {
        return Array.isArray(value) ? value.map(item => String(item || '').trim()).filter(Boolean) : [];
    }

    function _providerId(provider) {
        return String(provider && (provider.id || provider.providerId || provider.provider_id) || '').trim();
    }

    function _ownerPluginId(provider) {
        return String(provider && (provider.owner_plugin_id || provider.ownerPluginId || provider.pluginId || provider.source) || '').trim();
    }

    function _participantId(provider) {
        const providerId = _providerId(provider);
        if (providerId === 'local') return 'core.library.local';
        return _ownerPluginId(provider) || providerId;
    }

    function _operationsFor(provider) {
        const caps = _strings(provider && provider.capabilities);
        const operations = [];
        for (const cap of caps) {
            for (const op of PROVIDER_OPERATIONS[cap] || []) {
                if (!operations.includes(op)) operations.push(op);
            }
        }
        return operations;
    }

    function _normalizeProvider(provider) {
        const providerId = _providerId(provider);
        if (!providerId) return null;
        return {
            ...provider,
            id: providerId,
            label: String(provider.label || provider.name || providerId),
            kind: String(provider.kind || (providerId === 'local' ? 'local' : 'remote')),
            capabilities: _strings(provider.capabilities),
            default: provider.default === true || providerId === 'local',
        };
    }

    function _providerById(providerId) {
        return providers.find(provider => provider.id === providerId) || null;
    }

    function _activeProvider() {
        return _providerById(currentProviderId) || _providerById('local') || providers[0] || { ...LOCAL_PROVIDER };
    }

    function _snapshot(extra = {}) {
        return {
            available: true,
            current: (_activeProvider() || {}).id || 'local',
            providers: providers.map(provider => ({ ...provider })),
            ...extra,
        };
    }

    function _setProviders(nextProviders, { restoreSaved = false } = {}) {
        const normalized = (Array.isArray(nextProviders) ? nextProviders : [])
            .map(_normalizeProvider)
            .filter(Boolean)
            .filter(provider => provider.capabilities.includes('library.read'));
        const hasLocal = normalized.some(provider => provider.id === 'local');
        providers = hasLocal
            ? normalized
            : [{ ...LOCAL_PROVIDER }, ...normalized.filter(provider => provider.id !== 'local')];

        const preferred = restoreSaved ? _readProvider() : currentProviderId;
        if (_providerById(preferred)) currentProviderId = preferred;
        else if (!_providerById(currentProviderId)) currentProviderId = 'local';

        _registerProviderParticipants();
        _contributeDiagnostics();
        return _snapshot();
    }

    // Participant ids this module has registered into the `library` pipeline.
    // Tracked so a later refresh can unregister providers that have gone away
    // — a removed remote source, or a `/api/library/providers` failure that
    // falls back to local-only. Without this, stale provider participants
    // linger in the capability registry and the Inspector diagnostics snapshot.
    let _registeredParticipantIds = new Set();

    function _registerProviderParticipants() {
        const nextIds = new Set();
        for (const provider of providers) {
            const providerId = _providerId(provider);
            const pluginId = _participantId(provider);
            const operations = _operationsFor(provider);
            if (!providerId || !pluginId || !operations.length) continue;
            capabilities.registerParticipant(pluginId, {
                library: {
                    roles: ['provider'],
                    operations,
                    events: [],
                    mode: 'active',
                    compatibility: 'none',
                    safety: 'safe',
                    runtime: true,
                    description: provider.description || `Library source ${provider.label || providerId}.`,
                    provider_policy: {
                        providerId,
                        label: provider.label || providerId,
                        kind: provider.kind || (providerId === 'local' ? 'local' : 'remote'),
                        capabilities: _strings(provider.capabilities),
                        ownerPluginId: _ownerPluginId(provider) || null,
                        default: provider.default === true || providerId === 'local',
                    },
                },
            });
            nextIds.add(pluginId);
        }
        // Drop providers that disappeared since the last registration so they
        // don't linger in the registry / Inspector snapshot. Two safeguards:
        //   * scope the unregister to the `library` capability (a provider
        //     plugin that participates in OTHER domains via its manifest keeps
        //     those), and
        //   * only remove a participant that is purely our provider
        //     contribution (roles === ['provider']). If the same plugin also
        //     declared non-provider library roles (requester/observer/owner)
        //     via its manifest, unregistering would wipe those too — the
        //     registry merges declarations and can't partially remove ours —
        //     so we leave it in place rather than delete legitimate
        //     participation.
        if (typeof capabilities.unregisterParticipant === 'function') {
            const live = typeof capabilities.inspect === 'function' ? capabilities.inspect('library') : null;
            const liveById = new Map(((live && live.participants) || []).map(p => [p.pluginId, p]));
            for (const pluginId of _registeredParticipantIds) {
                if (nextIds.has(pluginId)) continue;
                const participant = liveById.get(pluginId);
                const roles = participant && Array.isArray(participant.roles) ? participant.roles : [];
                const providerOnly = roles.length === 1 && roles[0] === 'provider';
                if (!participant || providerOnly) {
                    capabilities.unregisterParticipant(pluginId, 'library');
                }
            }
        }
        _registeredParticipantIds = nextIds;
    }

    function _targetProviderId(ctx = {}) {
        const payload = ctx.payload && typeof ctx.payload === 'object' ? ctx.payload : {};
        const target = ctx.target && typeof ctx.target === 'object' ? ctx.target : {};
        // Trim to match _providerId/_ownerPluginId/_strings normalization, so
        // accidental whitespace doesn't cause selection/sync lookups to miss.
        return String(target.providerId || target.provider_id || target.id || payload.providerId || payload.provider_id || payload.id || (typeof ctx.target === 'string' ? ctx.target : '') || '').trim();
    }

    function _targetSongId(ctx = {}) {
        const payload = ctx.payload && typeof ctx.payload === 'object' ? ctx.payload : {};
        const target = ctx.target && typeof ctx.target === 'object' ? ctx.target : {};
        return String(target.songId || target.song_id || payload.songId || payload.song_id || payload.id || '');
    }

    async function _refreshProviders(options = {}) {
        try {
            const response = await fetch('/api/library/providers');
            if (!response.ok) throw new Error(`HTTP ${response.status}`);
            const data = await response.json();
            return _setProviders(data.providers, options);
        } catch (error) {
            console.warn('Failed to load library providers:', error);
            return _setProviders([{ ...LOCAL_PROVIDER }], options);
        }
    }

    function _selectProvider(providerId) {
        const provider = _providerById(providerId);
        if (!provider) return _snapshot({ selected: false, reason: `Unknown library provider: ${providerId}` });
        currentProviderId = providerId;
        _writeProvider(providerId);
        _contributeDiagnostics();
        return _snapshot({ selected: true });
    }

    async function _syncProviderSong(providerId, songId) {
        const response = await fetch(
            `/api/library/providers/${encodeURIComponent(providerId)}/songs/${encodeURIComponent(songId)}/sync`,
            { method: 'POST' },
        );
        let data = {};
        try { data = await response.json(); } catch (_) { data = {}; }
        if (!response.ok) throw new Error(data.detail || data.error || `HTTP ${response.status}`);
        return data;
    }

    function _handled(payload = {}) { return { outcome: 'handled', payload }; }
    function _degraded(reason, payload = {}) { return { outcome: 'degraded', reason, payload }; }

    async function _ownerCommand(commandName, ctx = {}) {
        if (commandName === 'list-providers' || commandName === 'inspect') return _handled(_snapshot());
        if (commandName === 'get-current') return _handled(_snapshot());
        if (commandName === 'refresh-providers') {
            const snapshot = await _refreshProviders(ctx.payload || {});
            capabilities.emitEvent('library', 'providers-refreshed', { requester: ctx.requester, providers: snapshot.providers });
            return _handled(snapshot);
        }
        if (commandName === 'select-provider') {
            const providerId = _targetProviderId(ctx);
            if (!providerId) return _degraded('Library provider selection requires a provider id', _snapshot());
            const before = _snapshot();
            const after = _selectProvider(providerId);
            if (!after.selected) return _degraded(after.reason || 'Library provider selection failed', after);
            if (before.current !== after.current) {
                capabilities.emitEvent('library', 'source-changed', { requester: ctx.requester, from: before.current, to: after.current });
            }
            return _handled(after);
        }
        if (commandName === 'sync-song') {
            const providerId = _targetProviderId(ctx);
            const songId = _targetSongId(ctx);
            if (!providerId || !songId) return _degraded('Library provider sync requires providerId and songId', _snapshot());
            capabilities.emitEvent('library', 'song-sync-started', { requester: ctx.requester, providerId, songId });
            try {
                const result = await _syncProviderSong(providerId, songId);
                capabilities.emitEvent('library', 'song-sync-succeeded', { requester: ctx.requester, providerId, songId, result });
                return _handled({ providerId, songId, result });
            } catch (error) {
                capabilities.emitEvent('library', 'song-sync-failed', { requester: ctx.requester, providerId, songId, error: error && error.message ? error.message : String(error) });
                return _degraded(error && error.message ? error.message : String(error), _snapshot());
            }
        }
        return _degraded(`Unsupported library command: ${commandName}`, _snapshot());
    }

    capabilities.registerOwner('library', {
        pluginId: 'core.library',
        kind: 'provider-coordinator',
        commands: ['list-providers', 'refresh-providers', 'get-current', 'select-provider', 'sync-song', 'inspect'],
        operations: ['query-page', 'query-artists', 'query-stats', 'tuning-names', 'get-art', 'sync-song'],
        events: ['providers-refreshed', 'source-changed', 'song-sync-started', 'song-sync-succeeded', 'song-sync-failed'],
        description: 'Owns the library provider domain, source selection, and provider operation routing.',
        handlers: {
            'list-providers': (ctx) => _ownerCommand('list-providers', ctx),
            'refresh-providers': (ctx) => _ownerCommand('refresh-providers', ctx),
            'get-current': (ctx) => _ownerCommand('get-current', ctx),
            'select-provider': (ctx) => _ownerCommand('select-provider', ctx),
            'sync-song': (ctx) => _ownerCommand('sync-song', ctx),
            inspect: (ctx) => _ownerCommand('inspect', ctx),
        },
    });

    _registerProviderParticipants();

    const providerApi = {
        version: 1,
        snapshot: _snapshot,
        list: _snapshot,
        refresh: _refreshProviders,
        setProviders: _setProviders,
        select: _selectProvider,
        syncSong: _syncProviderSong,
        providerById: _providerById,
        activeProvider: () => ({ ..._activeProvider() }),
        activeProviderId: () => (_activeProvider() || {}).id || 'local',
        supports(providerId, capability) {
            const provider = _providerById(providerId);
            return !!provider && _strings(provider.capabilities).includes(capability);
        },
        isLocal(providerId) {
            const provider = _providerById(providerId);
            return providerId === 'local' || (provider && provider.kind === 'local');
        },
    };

    function _contributeDiagnostics() {
        const diagnostics = window.feedBack && window.feedBack.diagnostics;
        if (diagnostics && typeof diagnostics.contribute === 'function') {
            try {
                diagnostics.contribute('library-capability', {
                    schema: 'feedBack.library_capability.v1',
                    ..._snapshot(),
                });
            } catch (_) { /* diagnostics must not break the library */ }
        }
    }

    window.feedBack.libraryProviders = providerApi;
    _contributeDiagnostics();
})();
