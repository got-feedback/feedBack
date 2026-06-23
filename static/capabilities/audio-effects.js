// Core audio-effects capability domain host.
(function () {
    'use strict';

    window.feedBack = window.feedBack || {};
    const capabilities = window.feedBack.capabilities;
    if (!capabilities || capabilities.version !== 1) return;
    if (window.feedBack.audioEffects && window.feedBack.audioEffects.version === 1) return;

    const SCHEMA = 'feedBack.audio_effects.diagnostics.v1';
    const PLAN_SCHEMA = 'feedBack.audio_effects.chain_plan.v1';
    const OWNER_ID = 'core.audio.effects';
    const DEFAULT_ROUTE_KEY = 'desktop-main';
    const DEFAULT_TIMEOUT_MS = 2000;
    const MAPPING_ENDPOINT = '/api/audio-effects/mappings';
    const MAX_PROVIDERS = 50;
    const MAX_EXECUTORS = 20;
    const MAX_ROUTES = 20;
    const MAX_OUTCOMES = 120;
    const MAX_BRIDGES = 60;
    const MAX_STAGES = 24;
    const MAX_SEGMENTS = 80;
    const MAX_SAFE_ARRAY = 40;
    const MAX_REASON = 240;
    const VALID_KINDS = new Set(['nam', 'ir', 'vst', 'utility', 'bypass']);
    const VALID_ROLES = new Set(['input', 'pre-pedal', 'pedal', 'amp', 'post-pedal', 'rack', 'cab', 'master-pre', 'master-post', 'utility', 'unknown']);
    const VALID_OUTCOMES = new Set(['handled', 'denied', 'degraded', 'failed', 'no-owner', 'no-handler', 'no-target', 'unsupported-command', 'incompatible-version', 'unavailable', 'provider-selection-required', 'user-action-required', 'stale', 'cancelled']);
    const LOAD_AUTHORIZATIONS = new Set(['user-action', 'restore-selection', 'playback-session']);
    const RAW_KEY_RE = /(^|_)(asset|path|filepath|file|filename|url|uri|token|secret|password|api|apikey|key|native|preset|model|ir|vststate|stateblob|raw|buffer|sample|waveform|audio|handle|callback|function|node|element)(_|$)/i;

    let sequence = 0;
    const providers = new Map();
    const executors = new Map();
    const routes = new Map();
    const bridges = new Map();
    // Snapshot of each plugin's audio-effects participant declaration as it existed before the
    // host first registered a runtime provider/executor for it (i.e. anything the plugin declared
    // in its own manifest). The host overlay is rebuilt by unregister-then-register, so this lets
    // it clear its own stale roles without clobbering the plugin's manifest declaration.
    const manifestParticipants = new Map();
    const recentOutcomes = [];

    function _now() { return new Date().toISOString(); }

    function _id(prefix) {
        sequence += 1;
        return `${prefix}-${sequence}`;
    }

    function _string(value, fallback = '') {
        const normalized = String(value == null ? '' : value).trim();
        return normalized || fallback;
    }

    // Select the first snake/camel alias the caller actually supplied, by key presence rather
    // than truthiness, so a present-but-falsey non-string value (false/0) is forwarded to the
    // server for validation instead of being silently swallowed by an `|| ''` chain.
    function _aliasValue(payload, ...keys) {
        if (payload && typeof payload === 'object') {
            for (const key of keys) {
                if (Object.prototype.hasOwnProperty.call(payload, key)) return payload[key];
            }
        }
        return undefined;
    }

    function _number(value, fallback = 0) {
        const numeric = Number(value);
        return Number.isFinite(numeric) ? numeric : fallback;
    }

    function _bool(value, fallback = false) {
        if (value === true || value === false) return value;
        return fallback;
    }

    function _plainObject(value) {
        return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
    }

    function _asArray(value) {
        return Array.isArray(value) ? value : [];
    }

    function _safeId(value, fallback = 'unknown') {
        const raw = _string(value, fallback);
        return raw.replace(/[^A-Za-z0-9_.:-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 96) || fallback;
    }

    function _safeRoute(value) {
        return _safeId(value || DEFAULT_ROUTE_KEY, DEFAULT_ROUTE_KEY);
    }

    function _safeKeyName(key) {
        return _string(key).replace(/([a-z0-9])([A-Z])/g, '$1_$2').replace(/([A-Z]+)([A-Z][a-z])/g, '$1_$2').toLowerCase();
    }

    function _redactString(value) {
        return _string(value)
            .replace(/(?:\/Users\/|\/home\/|\/root\b\/?)[^\r\n\t"'`,;(){}\[\]<>|]*/g, '[path]')
            .replace(/[A-Za-z]:\\[^\r\n\t"'`,;(){}\[\]<>|]*/g, '[path]')
            .replace(/https?:\/\/[^\s?#]+[^\s]*/gi, '[url]')
            .replace(/file:\/\/[^\s]+/gi, '[path]')
            .replace(/\b(token|secret|password|api[_-]?key|key)=([^\s&]+)/gi, '$1=[redacted]')
            .replace(/\b[^\s]+\.(archive|sloppak|wem|ogg|mp3|wav|flac|nam|vst3|component|dll|json|db)\b/gi, '[file]')
            .replace(/\b(raw[-_ ]?audio|audio[-_ ]?buffer|sample[s]?|waveform[s]?|recording[s]?|native[-_ ]?preset|model[-_ ]?file|ir[-_ ]?file|vst[-_ ]?state)\b/gi, '[private]');
    }

    function _boundedReason(value) {
        return _redactString(value).replace(/\s+/g, ' ').slice(0, MAX_REASON);
    }

    function _safeValue(value, depth = 0, seen = null) {
        if (typeof value === 'string') return _boundedReason(value);
        if (value == null || typeof value === 'number' || typeof value === 'boolean') return value;
        if (typeof value === 'function') return undefined;
        if (depth > 6) return '[truncated]';
        if (typeof value === 'object') {
            const refs = seen || new WeakSet();
            if (refs.has(value)) return '[circular]';
            refs.add(value);
            if (Array.isArray(value)) return value.slice(0, MAX_SAFE_ARRAY).map(item => _safeValue(item, depth + 1, refs)).filter(item => item !== undefined);
            const out = {};
            for (const [key, item] of Object.entries(value).slice(0, 40)) {
                if (RAW_KEY_RE.test(_safeKeyName(key))) continue;
                const safe = _safeValue(item, depth + 1, refs);
                if (safe !== undefined) out[_safeId(key, 'field')] = safe;
            }
            return out;
        }
        return '';
    }

    function _clone(value) {
        try { return JSON.parse(JSON.stringify(value)); }
        catch (_) { return null; }
    }

    function _queryParam(params, name, value) {
        // Absent or empty -> no filter; a present non-empty value (including a falsey non-string)
        // is forwarded so the server, not the client, decides whether it is valid.
        if (value === undefined || value === null) return;
        const text = _string(value);
        if (text) params.push(`${name}=${encodeURIComponent(text)}`);
    }

    function _mappingQuery(payload = {}) {
        const params = [];
        _queryParam(params, 'song_key', _aliasValue(payload, 'song_key', 'songKey'));
        _queryParam(params, 'filename', _aliasValue(payload, 'filename', 'fileName'));
        _queryParam(params, 'tone_key', _aliasValue(payload, 'tone_key', 'toneKey'));
        _queryParam(params, 'provider_id', _aliasValue(payload, 'provider_id', 'providerId'));
        const query = params.join('&');
        return query ? `${MAPPING_ENDPOINT}?${query}` : MAPPING_ENDPOINT;
    }

    async function _mappingFetch(url, options = {}) {
        if (typeof window.fetch !== 'function') return _unavailable('Audio-effects mapping API requires fetch');
        let response;
        // Bound the request so a stalled network call can't hang mapping flows
        // indefinitely; abort after DEFAULT_TIMEOUT_MS and fail deterministically.
        const controller = (typeof AbortController === 'function') ? new AbortController() : null;
        const timer = controller ? setTimeout(() => { try { controller.abort(); } catch (_) {} }, DEFAULT_TIMEOUT_MS) : null;
        try {
            response = await window.fetch(url, controller ? { ...options, signal: controller.signal } : options);
        } catch (error) {
            if (timer) clearTimeout(timer);
            if (error && error.name === 'AbortError') return _failed(`Audio-effects mapping request timed out after ${DEFAULT_TIMEOUT_MS} ms`);
            return _failed(error && error.message ? error.message : 'Audio-effects mapping request failed');
        }
        if (timer) clearTimeout(timer);
        let body = null;
        try { body = await response.json(); }
        catch (_) { body = {}; }
        if (!response.ok || body && body.error) {
            return _failed(body && body.error ? body.error : `Audio-effects mapping request failed (${response.status})`);
        }
        return { outcome: 'handled', status: 'handled', reason: 'Audio-effects mapping request handled', payload: body || {} };
    }

    function _operationHandlers(source) {
        const handlers = {};
        const input = _plainObject(source.operationHandlers || source.handlers || source.providerOperations);
        for (const [key, handler] of Object.entries(input)) {
            if (typeof handler === 'function') handlers[key] = handler;
        }
        return handlers;
    }

    function _executorHandlers(source) {
        const handlers = _operationHandlers(source);
        for (const name of ['loadChainPlan', 'releaseRoute', 'activateSegment', 'setStageBypass', 'setStageParameter', 'setRouteGain']) {
            if (typeof source[name] === 'function') handlers[name] = source[name];
        }
        return handlers;
    }

    function _providerKey(pluginId, providerId) {
        return `${pluginId}::${providerId}`;
    }

    function _executorKey(pluginId, executorId) {
        return `${pluginId}::${executorId}`;
    }

    function _selectedProviderId(routeKey) {
        const route = routes.get(routeKey);
        return route && route.providerId ? route.providerId : '';
    }

    function _providerForRoute(routeKey, requestedProviderId = '') {
        const requested = _safeId(requestedProviderId || _selectedProviderId(routeKey), '');
        const available = Array.from(providers.values())
            .filter(provider => provider.enabled && provider.availability !== 'unavailable' && provider.availability !== 'disabled')
            .filter(provider => provider.routeKey === routeKey || provider.routeKey === DEFAULT_ROUTE_KEY || provider.routeKey === 'default')
            .sort((a, b) => b.priority - a.priority || a.providerId.localeCompare(b.providerId));
        if (requested) return available.find(provider => provider.providerId === requested || provider.pluginId === requested) || null;
        return available[0] || null;
    }

    function _publicProvider(provider) {
        if (!provider) return null;
        return {
            providerId: provider.providerId,
            pluginId: provider.pluginId,
            routeKey: provider.routeKey,
            label: provider.label,
            enabled: !!provider.enabled,
            availability: provider.availability,
            sourceMode: provider.sourceMode,
            priority: provider.priority,
            operations: provider.operations.slice(),
            requests: (provider.requests || []).slice(),
            capabilities: provider.capabilities.slice(),
            dependencies: _clone(provider.dependencies) || {},
            updatedAt: provider.updatedAt,
        };
    }

    function _publicRoute(route) {
        if (!route) return null;
        return {
            routeKey: route.routeKey,
            chainId: route.chainId,
            providerId: route.providerId,
            executorId: route.executorId || '',
            state: route.state,
            bypassed: !!route.bypassed,
            activePlanId: route.activePlanId || '',
            activeSegmentId: route.activeSegmentId || '',
            planSummary: _safeValue(route.planSummary || {}),
            dependencies: _safeValue(route.dependencies || {}),
            selectedAt: route.selectedAt,
            updatedAt: route.updatedAt,
            lastOutcome: route.lastOutcome ? _safeValue(route.lastOutcome) : null,
        };
    }

    function _planSummary(plan) {
        const stages = _asArray(plan && plan.stages);
        const segments = _asArray(plan && plan.segments);
        const kinds = Array.from(new Set(stages.map(stage => stage && stage.kind).filter(Boolean))).slice(0, 12);
        const roles = Array.from(new Set(stages.map(stage => stage && stage.role).filter(Boolean))).slice(0, 12);
        return _safeValue({ stageCount: stages.length, segmentCount: segments.length, kinds, roles });
    }

    function _clampedGain(value, fallback = Number.NaN) {
        const numeric = _number(value, fallback);
        return Number.isFinite(numeric) ? Math.max(0, Math.min(32, numeric)) : Number.NaN;
    }

    function _safeGainMap(source = {}) {
        const input = _plainObject(source);
        const gains = {};
        for (const key of ['input', 'chain']) {
            const value = _clampedGain(input[key]);
            if (Number.isFinite(value)) gains[key] = value;
        }
        return gains;
    }

    function _safeExecutorOptions(source = {}) {
        const input = _plainObject(source);
        const options = {};
        const rawPreload = _plainObject(input.preloadMute || input.preLoadMute || input.loadMute || input.preload || {});
        if (input.preloadMute === true || input.loadMute === true || Object.keys(rawPreload).length) {
            const targetGain = _clampedGain(rawPreload.targetGain ?? rawPreload.restoreGain ?? rawPreload.chainGain, 1);
            options.preloadMute = {
                enabled: rawPreload.enabled !== false && input.preloadMute !== false && input.loadMute !== false,
                dryDuringLoad: rawPreload.dryDuringLoad !== false,
                targetGain: Number.isFinite(targetGain) ? targetGain : 1,
                holdMs: Math.max(0, Math.min(5000, Math.round(_number(rawPreload.holdMs, 0)))),
            };
        }
        const gains = _safeGainMap(input.gains || input.gain || {});
        if (Object.keys(gains).length) options.gains = gains;
        if (input.startAudio === true) options.startAudio = true;
        return options;
    }

    function _publicExecutor(executor) {
        if (!executor) return null;
        return {
            executorId: executor.executorId,
            pluginId: executor.pluginId,
            routeKey: executor.routeKey,
            label: executor.label,
            enabled: !!executor.enabled,
            availability: executor.availability,
            sourceMode: executor.sourceMode,
            priority: executor.priority,
            providerIds: executor.providerIds.slice(),
            supportedKinds: executor.supportedKinds.slice(),
            maxStages: executor.maxStages,
            operations: executor.operations.slice(),
            updatedAt: executor.updatedAt,
        };
    }

    function _decision(outcome, reason, payload = {}) {
        const normalized = VALID_OUTCOMES.has(outcome) ? outcome : 'failed';
        return { outcome: normalized, status: normalized, reason: _boundedReason(reason), payload: _safeValue(payload) };
    }

    function _handled(payload = {}, reason = 'Handled') { return _decision('handled', reason, payload); }
    function _failed(reason, payload = {}) { return _decision('failed', reason, payload); }
    function _unsupported(reason, payload = {}) { return _decision('unsupported-command', reason, payload); }
    function _noTarget(reason, payload = {}) { return _decision('no-target', reason, payload); }
    function _noHandler(reason, payload = {}) { return _decision('no-handler', reason, payload); }
    function _unavailable(reason, payload = {}) { return _decision('unavailable', reason, payload); }

    function _recordOutcome(entry = {}) {
        const outcome = {
            operation: _safeId(entry.operation || entry.command || 'unknown', 'unknown'),
            outcome: VALID_OUTCOMES.has(entry.outcome) ? entry.outcome : (VALID_OUTCOMES.has(entry.status) ? entry.status : 'handled'),
            status: _safeId(entry.status || entry.outcome || 'handled', 'handled'),
            routeKey: entry.routeKey ? _safeRoute(entry.routeKey) : undefined,
            providerId: entry.providerId ? _safeId(entry.providerId) : undefined,
            pluginId: entry.pluginId ? _safeId(entry.pluginId) : undefined,
            reason: _boundedReason(entry.reason || ''),
            details: _safeValue(entry.details || entry.summary || {}),
            timestamp: _now(),
        };
        recentOutcomes.push(outcome);
        while (recentOutcomes.length > MAX_OUTCOMES) recentOutcomes.shift();
        _contributeDiagnostics();
        return outcome;
    }

    function _touchRoute(route, outcome = null) {
        route.updatedAt = _now();
        if (outcome) route.lastOutcome = outcome;
    }

    function _emit(event, detail) {
        try {
            if (window.feedBack && typeof window.feedBack.emit === 'function') window.feedBack.emit(event, detail);
        } catch (_) { /* best effort */ }
    }

    function _invokeWithTimeout(handler, request, timeoutMs = DEFAULT_TIMEOUT_MS) {
        return new Promise(resolve => {
            let settled = false;
            const finish = value => {
                if (settled) return;
                settled = true;
                clearTimeout(timer);
                resolve({ timedOut: false, value });
            };
            const timer = setTimeout(() => {
                if (settled) return;
                settled = true;
                resolve({ timedOut: true, value: null });
            }, Math.max(1, _number(timeoutMs, DEFAULT_TIMEOUT_MS)));
            try { Promise.resolve(handler(request)).then(finish, error => finish({ outcome: 'failed', reason: error && error.message ? error.message : String(error || 'handler failed') })); }
            catch (error) { finish({ outcome: 'failed', reason: error && error.message ? error.message : String(error || 'handler failed') }); }
        });
    }

    function _desktopExecutor() {
        const desktop = window.feedBackDesktop && window.feedBackDesktop.audioEffects;
        if (!desktop || typeof desktop.loadChainPlan !== 'function') return null;
        const handlers = { loadChainPlan: desktop.loadChainPlan.bind(desktop) };
        if (typeof desktop.releaseRoute === 'function') handlers.releaseRoute = desktop.releaseRoute.bind(desktop);
        if (typeof desktop.activateSegment === 'function') handlers.activateSegment = desktop.activateSegment.bind(desktop);
        if (typeof desktop.setStageBypass === 'function') handlers.setStageBypass = desktop.setStageBypass.bind(desktop);
        if (typeof desktop.setStageParameter === 'function') handlers.setStageParameter = desktop.setStageParameter.bind(desktop);
        if (typeof desktop.setRouteGain === 'function') handlers.setRouteGain = desktop.setRouteGain.bind(desktop);
        return {
            executorId: 'desktop-native',
            pluginId: 'feedBack-desktop',
            routeKey: DEFAULT_ROUTE_KEY,
            label: 'FeedBack Desktop native audio',
            enabled: true,
            availability: 'available',
            sourceMode: 'native',
            priority: 100,
            providerIds: [],
            supportedKinds: [],
            maxStages: MAX_STAGES,
            operations: Object.keys(handlers),
            operationHandlers: handlers,
            registeredAt: '',
            updatedAt: '',
        };
    }

    function _executorSupports(executor, routeKey, providerId, requestedExecutorId = '') {
        if (!executor || !executor.enabled || executor.availability === 'unavailable' || executor.availability === 'disabled') return false;
        if (requestedExecutorId && executor.executorId !== requestedExecutorId && executor.pluginId !== requestedExecutorId) return false;
        if (executor.routeKey !== routeKey && executor.routeKey !== DEFAULT_ROUTE_KEY && executor.routeKey !== 'default') return false;
        if (executor.providerIds.length && !executor.providerIds.includes(providerId)) return false;
        return true;
    }

    function _executorForRoute(routeKey, providerId, requestedExecutorId = '') {
        const requested = _safeId(requestedExecutorId || '', '');
        const candidates = Array.from(executors.values());
        const desktop = _desktopExecutor();
        if (desktop) candidates.push(desktop);
        return candidates
            .filter(executor => _executorSupports(executor, routeKey, providerId, requested))
            .sort((a, b) => b.priority - a.priority || a.executorId.localeCompare(b.executorId))[0] || null;
    }

    function _executorPlanSupport(executor, plan) {
        if (!executor) return { ok: false, reason: 'No compatible audio-effects executor is available' };
        const stages = _asArray(plan && plan.stages);
        if (executor.maxStages > 0 && stages.length > executor.maxStages) {
            return { ok: false, reason: `Executor supports at most ${executor.maxStages} stages` };
        }
        const supportedKinds = new Set(_asArray(executor.supportedKinds));
        if (supportedKinds.size) {
            const unsupported = stages.find(stage => !supportedKinds.has(stage.kind));
            if (unsupported) return { ok: false, reason: `Executor does not support ${unsupported.kind} stages` };
        }
        return { ok: true, reason: '' };
    }

    function _executorForPlan(routeKey, providerId, plan, requestedExecutorId = '') {
        const requested = _safeId(requestedExecutorId || '', '');
        const candidates = Array.from(executors.values());
        const desktop = _desktopExecutor();
        if (desktop) candidates.push(desktop);
        return candidates
            .filter(executor => _executorSupports(executor, routeKey, providerId, requested))
            .filter(executor => _executorPlanSupport(executor, plan).ok)
            .sort((a, b) => b.priority - a.priority || a.executorId.localeCompare(b.executorId))[0] || null;
    }

    function _captureManifestParticipant(id) {
        // Record the plugin's pre-host declaration exactly once, before the host registers any
        // runtime overlay for it, so later rebuilds can restore it. Stored value is null when the
        // plugin never declared audio-effects itself.
        if (manifestParticipants.has(id)) return;
        let snapshot = null;
        try {
            const pipeline = typeof capabilities.inspect === 'function' ? capabilities.inspect('audio-effects') : null;
            const existing = pipeline && Array.isArray(pipeline.participants)
                ? pipeline.participants.find(item => item && item.pluginId === id)
                : null;
            if (existing) {
                snapshot = {
                    roles: _asArray(existing.roles),
                    operations: _asArray(existing.operations),
                    requests: _asArray(existing.requests),
                    events: _asArray(existing.events),
                    description: existing.description || '',
                    mode: existing.mode || 'active',
                    compatibility: existing.compatibility,
                    ownership: existing.ownership,
                    safety: existing.safety,
                    runtime: !!existing.runtime,
                    version: existing.version || 1,
                };
            }
        } catch (_err) {
            snapshot = null;
        }
        manifestParticipants.set(id, snapshot);
    }

    function _syncCapabilityParticipant(pluginId) {
        if (!capabilities || typeof capabilities.registerParticipant !== 'function') return;
        const id = _safeId(pluginId || '', '');
        if (!id) return;
        _captureManifestParticipant(id);
        const ownedProviders = Array.from(providers.values()).filter(provider => provider.pluginId === id);
        const ownedExecutors = Array.from(executors.values()).filter(executor => executor.pluginId === id);
        // capabilities.registerParticipant merges declarations by union and never drops
        // roles/operations, so refreshing in place would keep stale provider state after an
        // executor-only unregister. Clear the prior declaration first so the rebuilt overlay is a
        // true replacement, and so removing the last provider/executor also removes the host
        // overlay instead of leaving it registered forever. Restore the plugin's own manifest
        // declaration (if any) so only the host's runtime overlay is rebuilt, never clobbered.
        if (typeof capabilities.unregisterParticipant === 'function') {
            capabilities.unregisterParticipant(id, 'audio-effects');
        }
        const manifest = manifestParticipants.get(id);
        if (manifest) {
            capabilities.registerParticipant(id, { 'audio-effects': { ...manifest } });
        }
        if (!ownedProviders.length && !ownedExecutors.length) return;
        const operations = Array.from(new Set([
            ...ownedProviders.flatMap(provider => _asArray(provider.operations)),
            ...ownedExecutors.flatMap(executor => _asArray(executor.operations)),
            ...(ownedExecutors.length ? ['executor.load-chain-plan'] : []),
        ].map(item => _safeId(item, '')).filter(Boolean))).slice(0, 40);
        const requests = Array.from(new Set([
            ...ownedProviders.flatMap(provider => _asArray(provider.requests)),
            ...ownedExecutors.flatMap(executor => _asArray(executor.requests)),
        ].map(item => _safeId(item, '')).filter(Boolean))).slice(0, 40);
        const events = ['provider-registered', 'executor-registered', 'route-selected', 'plan-resolved', 'changed', 'fallback', 'bridge-hit'];
        capabilities.registerParticipant(id, {
            'audio-effects': {
                roles: [
                    ...(ownedProviders.length ? ['provider'] : []),
                    ...(ownedExecutors.length ? ['executor'] : []),
                    ...(requests.length ? ['requester'] : []),
                ],
                requests,
                operations,
                events,
                description: 'Runtime audio-effects provider/executor participant registered through the core audio-effects host.',
                mode: ownedProviders.some(provider => provider.enabled !== false) || ownedExecutors.some(executor => executor.enabled !== false) ? 'active' : 'disabled',
                compatibility: 'shim-allowed',
                ownership: 'multi-provider',
                safety: 'sensitive',
                runtime: true,
                version: 1,
            },
        });
    }

    function registerProvider(input = {}) {
        const source = _plainObject(input);
        const providerId = _safeId(source.providerId || source.participantId || source.id || source.pluginId, 'provider');
        const pluginId = _safeId(source.pluginId || source.ownerPluginId || source.ownerId || providerId, providerId);
        const key = _providerKey(pluginId, providerId);
        if (providers.size >= MAX_PROVIDERS && !providers.has(key)) return _failed('audio-effects provider registry is full');
        const routeKey = _safeRoute(source.routeKey || source.route || DEFAULT_ROUTE_KEY);
        const operationHandlers = _operationHandlers(source);
        const operations = Array.from(new Set([
            ..._asArray(source.operations || source.commands || source.capabilities).map(item => _safeId(item, '')).filter(Boolean),
            ...Object.keys(operationHandlers),
        ])).slice(0, 30);
        const requests = Array.from(new Set(_asArray(source.requests || source.requestedCommands || source.requested_commands)
            .map(item => _safeId(item, ''))
            .filter(Boolean))).slice(0, 30);
        const provider = {
            providerId,
            pluginId,
            routeKey,
            label: _boundedReason(source.label || source.name || providerId).slice(0, 96),
            enabled: source.enabled !== false,
            availability: _safeId(source.availability || 'available', 'available'),
            sourceMode: source.sourceMode === 'compatibility' || source.compatibilityMode === 'compatibility' ? 'compatibility' : 'native',
            priority: _number(source.priority, 0),
            operations,
            requests,
            capabilities: operations.slice(),
            dependencies: _safeValue(source.dependencies || {}),
            operationHandlers,
            registeredAt: _now(),
            updatedAt: _now(),
        };
        providers.set(key, provider);
        _syncCapabilityParticipant(pluginId);
        const outcome = _recordOutcome({ operation: 'register-provider', outcome: 'handled', providerId, pluginId, routeKey });
        _emit('audio-effects:provider-registered', { provider: _publicProvider(provider) });
        _contributeDiagnostics();
        return _handled({ provider: _publicProvider(provider), outcome }, 'Audio-effects provider registered');
    }

    function unregisterProvider(input = {}) {
        const providerId = _safeId(input.providerId || input.participantId || input.id || '', '');
        const pluginId = _safeId(input.pluginId || input.ownerPluginId || input.ownerId || '', '');
        let key = '';
        if (providerId && pluginId) key = _providerKey(pluginId, providerId);
        else if (providerId) {
            key = Array.from(providers.keys()).find(item => item.endsWith(`::${providerId}`)) || '';
        }
        if (!key || !providers.has(key)) return _noTarget('Audio-effects provider was not registered');
        const provider = providers.get(key);
        providers.delete(key);
        for (const route of routes.values()) {
            if (route.providerId === provider.providerId) {
                route.state = 'provider-unavailable';
                route.activePlanId = '';
                route.activeSegmentId = '';
                route.executorId = '';
                route.planSummary = {};
                _touchRoute(route);
            }
        }
        _syncCapabilityParticipant(provider.pluginId);
        const outcome = _recordOutcome({ operation: 'unregister-provider', outcome: 'handled', providerId: provider.providerId, pluginId: provider.pluginId, routeKey: provider.routeKey });
        _emit('audio-effects:provider-unregistered', { providerId: provider.providerId, pluginId: provider.pluginId });
        _contributeDiagnostics();
        return _handled({ providerId: provider.providerId, outcome }, 'Audio-effects provider unregistered');
    }

    function registerExecutor(input = {}) {
        const source = _plainObject(input);
        const executorId = _safeId(source.executorId || source.id || source.pluginId, 'executor');
        const pluginId = _safeId(source.pluginId || source.ownerPluginId || source.ownerId || executorId, executorId);
        const key = _executorKey(pluginId, executorId);
        if (executors.size >= MAX_EXECUTORS && !executors.has(key)) return _failed('audio-effects executor registry is full');
        const routeKey = _safeRoute(source.routeKey || source.route || DEFAULT_ROUTE_KEY);
        const operationHandlers = _executorHandlers(source);
        const operations = Array.from(new Set([
            ..._asArray(source.operations || source.commands || source.capabilities).map(item => _safeId(item, '')).filter(Boolean),
            ...Object.keys(operationHandlers),
        ])).slice(0, 20);
        const providerIds = _asArray(source.providerIds || source.supportedProviders || source.providers)
            .map(item => _safeId(item, ''))
            .filter(Boolean)
            .slice(0, MAX_PROVIDERS);
        const supportedKinds = _asArray(source.supportedKinds || source.stageKinds || source.kinds)
            .map(item => _safeId(item, ''))
            .filter(kind => VALID_KINDS.has(kind))
            .slice(0, VALID_KINDS.size);
        const maxStages = Math.max(0, Math.min(MAX_STAGES, _number(source.maxStages || source.stageLimit, 0)));
        const mode = _safeId(source.sourceMode || source.mode || 'native', 'native');
        const executor = {
            executorId,
            pluginId,
            routeKey,
            label: _boundedReason(source.label || source.name || executorId).slice(0, 96),
            enabled: source.enabled !== false,
            availability: _safeId(source.availability || 'available', 'available'),
            sourceMode: mode === 'compatibility' || mode === 'browser' || mode === 'native' ? mode : 'native',
            priority: _number(source.priority, 0),
            providerIds,
            supportedKinds,
            maxStages,
            operations,
            operationHandlers,
            registeredAt: _now(),
            updatedAt: _now(),
        };
        executors.set(key, executor);
        _syncCapabilityParticipant(pluginId);
        const outcome = _recordOutcome({ operation: 'register-executor', outcome: 'handled', pluginId, routeKey, details: { executorId, providerIds, supportedKinds, maxStages } });
        _emit('audio-effects:executor-registered', { executor: _publicExecutor(executor) });
        _contributeDiagnostics();
        return _handled({ executor: _publicExecutor(executor), outcome }, 'Audio-effects executor registered');
    }

    function unregisterExecutor(input = {}) {
        const executorId = _safeId(input.executorId || input.id || '', '');
        const pluginId = _safeId(input.pluginId || input.ownerPluginId || input.ownerId || '', '');
        let key = '';
        if (executorId && pluginId) key = _executorKey(pluginId, executorId);
        else if (executorId) key = Array.from(executors.keys()).find(item => item.endsWith(`::${executorId}`)) || '';
        if (!key || !executors.has(key)) return _noTarget('Audio-effects executor was not registered');
        const executor = executors.get(key);
        executors.delete(key);
        for (const route of routes.values()) {
            if (route.executorId === executor.executorId) {
                route.executorId = '';
                route.state = 'executor-unavailable';
                _touchRoute(route);
            }
        }
        _syncCapabilityParticipant(executor.pluginId);
        const outcome = _recordOutcome({ operation: 'unregister-executor', outcome: 'handled', pluginId: executor.pluginId, routeKey: executor.routeKey, details: { executorId: executor.executorId } });
        _emit('audio-effects:executor-unregistered', { executorId: executor.executorId, pluginId: executor.pluginId });
        _contributeDiagnostics();
        return _handled({ executorId: executor.executorId, outcome }, 'Audio-effects executor unregistered');
    }

    function listExecutors(payload = {}) {
        const routeKey = payload.routeKey || payload.route ? _safeRoute(payload.routeKey || payload.route) : '';
        const providerId = payload.providerId ? _safeId(payload.providerId, '') : '';
        const desktop = _desktopExecutor();
        const items = Array.from(executors.values())
            .concat(desktop ? [desktop] : [])
            .filter(executor => (!routeKey || executor.routeKey === routeKey || executor.routeKey === DEFAULT_ROUTE_KEY || executor.routeKey === 'default')
                && (!providerId || !executor.providerIds.length || executor.providerIds.includes(providerId)))
            .map(_publicExecutor);
        return _handled({ executors: items }, 'Listed audio-effects executors');
    }

    function listProviders(payload = {}) {
        const routeKey = payload.routeKey || payload.route ? _safeRoute(payload.routeKey || payload.route) : '';
        const items = Array.from(providers.values())
            .filter(provider => !routeKey || provider.routeKey === routeKey || provider.routeKey === DEFAULT_ROUTE_KEY || provider.routeKey === 'default')
            .map(_publicProvider);
        return _handled({ providers: items }, 'Listed audio-effects providers');
    }

    function selectChain(payload = {}, requester = '') {
        const routeKey = _safeRoute(payload.routeKey || payload.route);
        if (payload.authorization !== 'user-action' && payload.authorization !== 'restore-selection') {
            return _decision('user-action-required', 'Selecting an audio-effects chain requires visible user action or restored selection', { routeKey });
        }
        const provider = _providerForRoute(routeKey, payload.providerId || payload.participantId);
        if (!provider) return _decision('provider-selection-required', 'No enabled audio-effects provider is available for route', { routeKey });
        const route = {
            routeKey,
            chainId: _id('effects'),
            providerId: provider.providerId,
            state: 'selected',
            bypassed: false,
            activePlanId: '',
            activeSegmentId: '',
            planSummary: _safeValue(payload.chainSummary || payload.planSummary || payload.summary || {}),
            dependencies: _safeValue(payload.dependencies || provider.dependencies || {}),
            selectedAt: _now(),
            updatedAt: _now(),
            selectedBy: _safeId(requester || 'unknown', 'unknown'),
            lastOutcome: null,
        };
        routes.set(routeKey, route);
        const outcome = _recordOutcome({ operation: 'select-chain', outcome: 'handled', providerId: provider.providerId, pluginId: provider.pluginId, routeKey, details: { planSummary: route.planSummary } });
        _touchRoute(route, outcome);
        _emit('audio-effects:route-selected', { route: _publicRoute(route), provider: _publicProvider(provider) });
        _contributeDiagnostics();
        return _handled({ route: _publicRoute(route), provider: _publicProvider(provider) }, 'Audio-effects chain selected');
    }

    function _validateRef(value, field, errors) {
        const text = _string(value);
        if (!text) return '';
        if (/^(?:https?:|file:)/i.test(text) || /(?:^\/Users\/|^\/home\/|^\/root\b|^[A-Za-z]:\\)/.test(text) || /\.(nam|wav|flac|vst3|component|dll)(?:$|[?#])/i.test(text)) {
            errors.push(`${field} must be an opaque provider or host reference, not a path or URL`);
            return '';
        }
        return _boundedReason(text).slice(0, 160);
    }

    function _validatePlan(rawPlan, provider, routeKey) {
        const errors = [];
        const source = _plainObject(rawPlan);
        const schema = _string(source.schema || source.version, PLAN_SCHEMA);
        if (schema !== PLAN_SCHEMA && schema !== '1') errors.push('Unsupported chain plan schema');
        const planRoute = _safeRoute(source.routeKey || source.route || routeKey);
        if (planRoute !== routeKey) errors.push('Chain plan route does not match selected route');
        const providerId = _safeId(source.providerId || provider.providerId, provider.providerId);
        if (providerId !== provider.providerId) errors.push('Chain plan provider does not match selected provider');
        const stages = _asArray(source.stages || source.chain);
        if (!stages.length) errors.push('Chain plan must include at least one stage');
        if (stages.length > MAX_STAGES) errors.push(`Chain plan exceeds maximum stage count ${MAX_STAGES}`);
        const safeStages = [];
        stages.slice(0, MAX_STAGES).forEach((stage, index) => {
            const item = _plainObject(stage);
            const kind = _safeId(item.kind || item.stageKind || (item.type === 1 ? 'nam' : item.type === 2 ? 'ir' : item.type === 0 ? 'vst' : ''), '');
            if (!VALID_KINDS.has(kind)) errors.push(`Stage ${index} has unsupported kind`);
            const rawRole = _safeId(item.role || item.slot || item.category || 'unknown', 'unknown');
            const role = VALID_ROLES.has(rawRole) ? rawRole : 'unknown';
            const stageId = _safeId(item.stageId || item.id || `${kind || 'stage'}-${index}`, `stage-${index}`);
            const assetRef = _validateRef(item.assetRef || item.modelRef || item.irRef || item.pluginRef || item.ref, `stage ${index} assetRef`, errors);
            const stateRef = _validateRef(item.stateRef || item.paramsRef || item.parameterRef, `stage ${index} stateRef`, errors);
            if ((kind === 'nam' || kind === 'ir' || kind === 'vst') && !assetRef) errors.push(`Stage ${index} requires an opaque assetRef`);
            safeStages.push({
                stageId,
                kind: VALID_KINDS.has(kind) ? kind : 'utility',
                role,
                assetRef,
                stateRef,
                bypassed: _bool(item.bypassed, false),
                gainDb: _number(item.gainDb, 0),
                summary: _safeValue(item.summary || {}),
            });
        });
        const rawSegments = _asArray(source.segments || source.toneSegments || source.segmentMap).slice(0, MAX_SEGMENTS);
        const segments = rawSegments.map((segment, index) => {
            const item = _plainObject(segment);
            const rawStageBypass = _plainObject(item.stageBypass || item.stageBypasses || item.bypassByStage || {});
            const stageBypass = {};
            for (const [stageId, bypassed] of Object.entries(rawStageBypass).slice(0, MAX_STAGES)) {
                const safeStageId = _safeId(stageId, '');
                if (safeStageId) stageBypass[safeStageId] = _bool(bypassed, false);
            }
            return {
                segmentId: _safeId(item.segmentId || item.toneKey || item.id || `segment-${index}`, `segment-${index}`),
                stageIds: _asArray(item.stageIds || item.stages).map(value => _safeId(value, '')).filter(Boolean).slice(0, MAX_STAGES),
                stageBypass,
                summary: _safeValue(item.summary || {}),
            };
        });
        const plan = {
            schema: PLAN_SCHEMA,
            planId: _safeId(source.planId || source.chainId || _id('plan'), 'plan'),
            routeKey: planRoute,
            providerId,
            stages: safeStages,
            segments,
            summary: _safeValue(source.summary || source.chainSummary || {}),
        };
        return { ok: errors.length === 0, plan, errors };
    }

    async function resolvePlan(payload = {}, requester = '') {
        const routeKey = _safeRoute(payload.routeKey || payload.route);
        let route = routes.get(routeKey);
        const provider = _providerForRoute(routeKey, payload.providerId || payload.participantId || (route && route.providerId));
        if (!provider) return _decision('provider-selection-required', 'No enabled audio-effects provider is available for route', { routeKey });
        if (!route || route.providerId !== provider.providerId) {
            route = {
                routeKey,
                chainId: _id('effects'),
                providerId: provider.providerId,
                state: 'resolving',
                bypassed: false,
                activePlanId: '',
                activeSegmentId: '',
                planSummary: {},
                dependencies: _safeValue(provider.dependencies || {}),
                selectedAt: _now(),
                updatedAt: _now(),
                selectedBy: _safeId(requester || 'unknown', 'unknown'),
                lastOutcome: null,
            };
            routes.set(routeKey, route);
        }
        const handler = provider.operationHandlers['chain.resolve'] || provider.operationHandlers['resolve-plan'];
        if (typeof handler !== 'function') {
            const outcome = _recordOutcome({ operation: 'resolve-plan', outcome: 'no-handler', providerId: provider.providerId, pluginId: provider.pluginId, routeKey, reason: 'Selected provider does not support chain.resolve' });
            route.state = 'fallback';
            _touchRoute(route, outcome);
            return _noHandler('Selected audio-effects provider does not support chain.resolve', { route: _publicRoute(route), provider: _publicProvider(provider) });
        }
        route.state = 'resolving';
        _touchRoute(route);
        const request = {
            routeKey,
            requesterId: _safeId(requester || 'unknown', 'unknown'),
            target: _clone(payload.target || {}) || {},
            planRequest: _clone(payload.planRequest || payload.summary || {}) || {},
            authorization: _safeId(payload.authorization || '', ''),
        };
        const invoked = await _invokeWithTimeout(handler, request, payload.timeoutMs);
        if (invoked.timedOut) {
            const outcome = _recordOutcome({ operation: 'resolve-plan', outcome: 'failed', status: 'timeout', providerId: provider.providerId, pluginId: provider.pluginId, routeKey, reason: 'Provider chain resolution timed out' });
            route.state = 'fallback';
            _touchRoute(route, outcome);
            return _failed('Provider chain resolution timed out', { route: _publicRoute(route), provider: _publicProvider(provider) });
        }
        const result = _plainObject(invoked.value);
        const outcomeName = _string(result.outcome || result.status || 'handled', 'handled');
        if (outcomeName !== 'handled') {
            const outcome = _recordOutcome({ operation: 'resolve-plan', outcome: VALID_OUTCOMES.has(outcomeName) ? outcomeName : 'failed', providerId: provider.providerId, pluginId: provider.pluginId, routeKey, reason: result.reason || 'Provider did not resolve a plan', details: result.summary || {} });
            route.state = outcome.outcome === 'no-target' ? 'fallback' : 'degraded';
            _touchRoute(route, outcome);
            return _decision(outcome.outcome, result.reason || 'Provider did not resolve a plan', { route: _publicRoute(route), provider: _publicProvider(provider), providerResult: _safeValue(result.summary || {}) });
        }
        const rawPlan = result.plan || result.chainPlan || result.payload || invoked.value;
        const validation = _validatePlan(rawPlan, provider, routeKey);
        if (!validation.ok) {
            const outcome = _recordOutcome({ operation: 'resolve-plan', outcome: 'failed', providerId: provider.providerId, pluginId: provider.pluginId, routeKey, reason: validation.errors.join('; ') });
            route.state = 'fallback';
            _touchRoute(route, outcome);
            return _failed('Provider returned an invalid audio-effects chain plan', { route: _publicRoute(route), provider: _publicProvider(provider), errors: validation.errors });
        }
        route.state = 'resolved';
        route.activePlanId = validation.plan.planId;
        route.planSummary = _planSummary(validation.plan);
        route.dependencies = _safeValue(result.dependencies || route.dependencies || {});
        const outcome = _recordOutcome({ operation: 'resolve-plan', outcome: 'handled', providerId: provider.providerId, pluginId: provider.pluginId, routeKey, details: { planId: validation.plan.planId, stageCount: validation.plan.stages.length, segmentCount: validation.plan.segments.length } });
        _touchRoute(route, outcome);
        _emit('audio-effects:plan-resolved', { route: _publicRoute(route), planSummary: route.planSummary });
        _contributeDiagnostics();
        return { outcome: 'handled', status: 'handled', reason: 'Audio-effects chain plan resolved', payload: { route: _publicRoute(route), provider: _publicProvider(provider), plan: validation.plan } };
    }

    async function loadPlan(payload = {}, requester = '') {
        const authorization = _safeId(payload.authorization || '', '');
        const routeKey = _safeRoute(payload.routeKey || payload.route);
        if (!LOAD_AUTHORIZATIONS.has(authorization)) {
            return _decision('user-action-required', 'Loading an audio-effects plan requires user-action, restore-selection, or playback-session authorization', { routeKey });
        }

        let route = routes.get(routeKey);
        const explicitProviderId = payload.providerId || payload.participantId || '';
        const selectedProviderId = route && route.providerId || '';
        let provider = _providerForRoute(routeKey, explicitProviderId || selectedProviderId);
        if (!provider) return _decision('provider-selection-required', 'No enabled audio-effects provider is available for route', { routeKey });
        let executor = _executorForRoute(routeKey, provider.providerId, payload.executorId || route && route.executorId || '');
        if (!executor && !explicitProviderId && payload.fallbackProviderId) {
            const fallbackProvider = _providerForRoute(routeKey, payload.fallbackProviderId);
            const fallbackExecutor = fallbackProvider ? _executorForRoute(routeKey, fallbackProvider.providerId, payload.executorId || '') : null;
            if (fallbackProvider && fallbackExecutor) {
                provider = fallbackProvider;
                executor = fallbackExecutor;
            }
        }
        if (!route || route.providerId !== provider.providerId) {
            route = {
                routeKey,
                chainId: _id('effects'),
                providerId: provider.providerId,
                state: 'resolving',
                bypassed: false,
                activePlanId: '',
                activeSegmentId: '',
                planSummary: {},
                dependencies: _safeValue(provider.dependencies || {}),
                selectedAt: _now(),
                updatedAt: _now(),
                selectedBy: _safeId(requester || 'unknown', 'unknown'),
                lastOutcome: null,
            };
            routes.set(routeKey, route);
        }
        if (!executor || typeof executor.operationHandlers.loadChainPlan !== 'function') {
            const outcome = _recordOutcome({ operation: 'load-plan', outcome: 'unavailable', providerId: provider.providerId, pluginId: provider.pluginId, routeKey, reason: 'No compatible audio-effects executor is available' });
            route.state = 'fallback';
            _touchRoute(route, outcome);
            return _unavailable('No compatible audio-effects executor is available', { route: _publicRoute(route), provider: _publicProvider(provider) });
        }

        const handler = provider.operationHandlers['chain.resolve'] || provider.operationHandlers['resolve-plan'];
        if (typeof handler !== 'function') {
            const outcome = _recordOutcome({ operation: 'load-plan', outcome: 'no-handler', providerId: provider.providerId, pluginId: provider.pluginId, routeKey, reason: 'Selected provider does not support chain.resolve' });
            route.state = 'fallback';
            _touchRoute(route, outcome);
            return _noHandler('Selected audio-effects provider does not support chain.resolve', { route: _publicRoute(route), provider: _publicProvider(provider) });
        }

        const request = {
            routeKey,
            requesterId: _safeId(requester || 'unknown', 'unknown'),
            target: _clone(payload.target || {}) || {},
            planRequest: _clone(payload.planRequest || payload.summary || {}) || {},
            authorization,
        };
        route.state = 'resolving';
        _touchRoute(route);
        const invoked = await _invokeWithTimeout(handler, request, payload.timeoutMs);
        if (invoked.timedOut) {
            const outcome = _recordOutcome({ operation: 'load-plan', outcome: 'failed', status: 'timeout', providerId: provider.providerId, pluginId: provider.pluginId, routeKey, reason: 'Provider chain resolution timed out' });
            route.state = 'fallback';
            _touchRoute(route, outcome);
            return _failed('Provider chain resolution timed out', { route: _publicRoute(route), provider: _publicProvider(provider) });
        }
        const result = _plainObject(invoked.value);
        const outcomeName = _string(result.outcome || result.status || 'handled', 'handled');
        if (outcomeName !== 'handled') {
            const outcome = _recordOutcome({ operation: 'load-plan', outcome: VALID_OUTCOMES.has(outcomeName) ? outcomeName : 'failed', providerId: provider.providerId, pluginId: provider.pluginId, routeKey, reason: result.reason || 'Provider did not resolve a plan', details: result.summary || {} });
            route.state = outcome.outcome === 'no-target' ? 'fallback' : 'degraded';
            _touchRoute(route, outcome);
            return _decision(outcome.outcome, result.reason || 'Provider did not resolve a plan', { route: _publicRoute(route), provider: _publicProvider(provider), providerResult: _safeValue(result.summary || {}) });
        }

        const rawPlan = result.plan || result.chainPlan || result.payload || invoked.value;
        const validation = _validatePlan(rawPlan, provider, routeKey);
        if (!validation.ok) {
            const outcome = _recordOutcome({ operation: 'load-plan', outcome: 'failed', providerId: provider.providerId, pluginId: provider.pluginId, routeKey, reason: validation.errors.join('; ') });
            route.state = 'fallback';
            _touchRoute(route, outcome);
            return _failed('Provider returned an invalid audio-effects chain plan', { route: _publicRoute(route), provider: _publicProvider(provider), errors: validation.errors });
        }

        const planExecutor = _executorForPlan(routeKey, provider.providerId, validation.plan, payload.executorId || route.executorId || '');
        if (!planExecutor) {
            const support = _executorPlanSupport(executor, validation.plan);
            if (!explicitProviderId && payload.fallbackProviderId && provider.providerId !== _safeId(payload.fallbackProviderId, '')) {
                return loadPlan({ ...payload, providerId: payload.fallbackProviderId, fallbackProviderId: '' }, requester);
            }
            const outcome = _recordOutcome({ operation: 'load-plan', outcome: 'unavailable', providerId: provider.providerId, pluginId: provider.pluginId, routeKey, reason: support.reason || 'No compatible audio-effects executor can load this chain plan' });
            route.state = 'fallback';
            _touchRoute(route, outcome);
            return _unavailable('No compatible audio-effects executor can load this chain plan', { route: _publicRoute(route), provider: _publicProvider(provider), reason: support.reason });
        }
        executor = planExecutor;

        const assets = result.assets || result.trustedAssets || result.assetMap || {};
        const states = result.states || result.trustedStates || result.stateMap || undefined;
        let executorResult;
        {
            // Bound the executor call so a hung promise can't stall load-plan; the
            // arrow preserves `this` for plugin-provided handlers. _invokeWithTimeout
            // also catches handler throws (value -> {outcome:'failed',reason}).
            const _exReq = {
                authorization,
                routeKey,
                plan: validation.plan,
                assets,
                states,
                options: _safeExecutorOptions(payload.options || payload.executorOptions || payload.loadOptions || {}),
                target: request.target,
                planRequest: request.planRequest,
            };
            const _ex = await _invokeWithTimeout((r) => executor.operationHandlers.loadChainPlan(r), _exReq, payload.timeoutMs);
            executorResult = _ex.timedOut
                ? { outcome: 'failed', status: 'timeout', reason: 'Executor loadChainPlan timed out' }
                : _ex.value;
        }
        const executorOutcome = _plainObject(executorResult);
        const executorOutcomeName = _string(executorOutcome.outcome || executorOutcome.status || 'failed', 'failed');
        const normalizedOutcome = VALID_OUTCOMES.has(executorOutcomeName) ? executorOutcomeName : 'failed';
        route.activePlanId = validation.plan.planId;
        route.executorId = executor.executorId;
        route.planSummary = _planSummary(validation.plan);
        route.dependencies = _safeValue(result.dependencies || route.dependencies || {});
        route.state = normalizedOutcome === 'handled' ? 'loaded' : (normalizedOutcome === 'degraded' ? 'degraded' : 'fallback');
        const outcome = _recordOutcome({
            operation: 'load-plan',
            outcome: normalizedOutcome,
            status: _safeId(executorOutcome.status || normalizedOutcome, normalizedOutcome),
            providerId: provider.providerId,
            pluginId: provider.pluginId,
            routeKey,
            reason: executorOutcome.reason || 'Audio-effects executor completed',
            details: { executorId: executor.executorId, result: executorOutcome.payload || executorOutcome.summary || {} },
        });
        _touchRoute(route, outcome);
        _emit('audio-effects:changed', { route: _publicRoute(route), operation: 'load-plan', outcome: normalizedOutcome });
        _contributeDiagnostics();
        return _decision(normalizedOutcome, executorOutcome.reason || 'Audio-effects executor completed', {
            route: _publicRoute(route),
            provider: _publicProvider(provider),
            executor: _publicExecutor(executor),
            result: _safeValue(executorOutcome.payload || executorOutcome.summary || {}),
        });
    }

    async function _providerOperation(operation, payload = {}, requester = '') {
        const routeKey = _safeRoute(payload.routeKey || payload.route);
        const route = routes.get(routeKey);
        if (!route) return _noTarget('No active audio-effects route was selected', { routeKey });
        const provider = _providerForRoute(routeKey, route.providerId);
        if (!provider) return _unavailable('Selected audio-effects provider is unavailable', { route: _publicRoute(route) });
        const handler = provider.operationHandlers[operation];
        if (typeof handler !== 'function') return _noHandler(`Selected audio-effects provider does not support ${operation}`, { route: _publicRoute(route), provider: _publicProvider(provider) });
        const request = {
            routeKey,
            requesterId: _safeId(requester || 'unknown', 'unknown'),
            planId: _safeId(payload.planId || route.activePlanId || '', ''),
            segmentId: _safeId(payload.segmentId || payload.toneKey || payload.activeSegmentId || '', ''),
            stageId: _safeId(payload.stageId || '', ''),
            bypassed: _bool(payload.bypassed, false),
            parameterId: _safeId(payload.parameterId || payload.paramId || '', ''),
            value: typeof payload.value === 'number' ? payload.value : undefined,
            summary: _safeValue(payload.summary || {}),
        };
        const invoked = await _invokeWithTimeout(handler, request, payload.timeoutMs);
        const outcomeName = invoked.timedOut ? 'failed' : _string(invoked.value && (invoked.value.outcome || invoked.value.status), 'handled');
        let finalOutcomeName = VALID_OUTCOMES.has(outcomeName) ? outcomeName : 'failed';
        let finalReason = invoked.timedOut ? 'Provider operation timed out' : (invoked.value && invoked.value.reason) || '';
        let finalDetails = invoked.value && invoked.value.summary || {};
        const executor = _executorForRoute(routeKey, provider.providerId, route.executorId || '');
        const executorMethod = operation === 'segment.activate' ? 'activateSegment'
            : operation === 'stage.set-bypass' ? 'setStageBypass'
                : operation === 'stage.set-parameter' ? 'setStageParameter'
                    : '';
        if (finalOutcomeName === 'handled' && executor && executorMethod && typeof executor.operationHandlers[executorMethod] === 'function') {
            const _ex = await _invokeWithTimeout((r) => executor.operationHandlers[executorMethod](r), request);
            if (_ex.timedOut) {
                finalOutcomeName = 'failed';
                finalReason = `Executor ${executorMethod} timed out`;
            } else {
                const executorResult = _plainObject(_ex.value);
                finalOutcomeName = VALID_OUTCOMES.has(_string(executorResult.outcome || executorResult.status, 'handled'))
                    ? _string(executorResult.outcome || executorResult.status, 'handled')
                    : 'failed';
                finalReason = executorResult.reason || finalReason;
                finalDetails = executorResult.payload || executorResult.summary || finalDetails;
            }
        }
        const outcome = _recordOutcome({ operation, outcome: finalOutcomeName, providerId: provider.providerId, pluginId: provider.pluginId, routeKey, reason: finalReason, details: finalDetails });
        if (operation === 'segment.activate' && outcome.outcome === 'handled') route.activeSegmentId = request.segmentId;
        _touchRoute(route, outcome);
        _emit('audio-effects:changed', { route: _publicRoute(route), operation, outcome: outcome.outcome });
        return _decision(outcome.outcome, outcome.reason || 'Provider operation completed', { route: _publicRoute(route), provider: _publicProvider(provider), result: _safeValue(finalDetails || {}) });
    }

    function setRouteBypass(payload = {}, bypassed) {
        const routeKey = _safeRoute(payload.routeKey || payload.route);
        const route = routes.get(routeKey);
        if (!route) return _noTarget('No active audio-effects route was selected', { routeKey });
        if (payload.authorization !== 'user-action' && payload.authorization !== 'restore-selection') {
            return _decision('user-action-required', 'Bypass changes require visible user action or restored selection', { route: _publicRoute(route) });
        }
        route.bypassed = !!bypassed;
        route.state = bypassed ? 'bypassed' : (route.executorId ? 'loaded' : (route.activePlanId ? 'resolved' : 'selected'));
        const outcome = _recordOutcome({ operation: bypassed ? 'bypass' : 'restore', outcome: 'handled', routeKey, providerId: route.providerId });
        _touchRoute(route, outcome);
        _emit('audio-effects:changed', { route: _publicRoute(route), operation: bypassed ? 'bypass' : 'restore' });
        return _handled({ route: _publicRoute(route) }, bypassed ? 'Audio-effects route bypassed' : 'Audio-effects route restored');
    }

    async function setRouteGain(payload = {}) {
        const routeKey = _safeRoute(payload.routeKey || payload.route);
        const route = routes.get(routeKey);
        if (!route) return _noTarget('No active audio-effects route was selected', { routeKey });
        if (!LOAD_AUTHORIZATIONS.has(_safeId(payload.authorization || '', ''))) {
            return _decision('user-action-required', 'Route gain changes require user-action, restore-selection, or playback-session authorization', { route: _publicRoute(route) });
        }
        const gains = _safeGainMap(payload.gains || (payload.which ? { [payload.which]: payload.value } : {}));
        if (!Object.keys(gains).length) return _failed('No valid route gain was provided', { route: _publicRoute(route) });
        const provider = _providerForRoute(routeKey, route.providerId);
        const executor = _executorForRoute(routeKey, route.providerId, route.executorId || '');
        if (!executor || typeof executor.operationHandlers.setRouteGain !== 'function') {
            const outcome = _recordOutcome({ operation: 'route.set-gain', outcome: 'no-handler', routeKey, providerId: route.providerId, reason: 'Selected executor does not support route gain' });
            _touchRoute(route, outcome);
            return _noHandler('Selected audio-effects executor does not support route gain', { route: _publicRoute(route), provider: _publicProvider(provider) });
        }
        let executorResult;
        {
            const _exReq = { routeKey, authorization: _safeId(payload.authorization || '', ''), gains, summary: _safeValue(payload.summary || {}) };
            const _ex = await _invokeWithTimeout((r) => executor.operationHandlers.setRouteGain(r), _exReq, payload.timeoutMs);
            executorResult = _ex.timedOut
                ? { outcome: 'failed', status: 'timeout', reason: 'Executor route gain timed out' }
                : _ex.value;
        }
        const result = _plainObject(executorResult);
        const outcomeName = _string(result.outcome || result.status || 'failed', 'failed');
        const normalizedOutcome = VALID_OUTCOMES.has(outcomeName) ? outcomeName : 'failed';
        const outcome = _recordOutcome({ operation: 'route.set-gain', outcome: normalizedOutcome, routeKey, providerId: route.providerId, pluginId: provider && provider.pluginId, reason: result.reason || 'Route gain operation completed', details: result.payload || result.summary || {} });
        _touchRoute(route, outcome);
        _emit('audio-effects:changed', { route: _publicRoute(route), operation: 'route.set-gain', outcome: outcome.outcome });
        return _decision(outcome.outcome, outcome.reason || 'Route gain operation completed', { route: _publicRoute(route), provider: _publicProvider(provider), result: _safeValue(result.payload || result.summary || {}) });
    }

    async function releaseRoute(payload = {}, requester = '') {
        const routeKey = _safeRoute(payload.routeKey || payload.route);
        const route = routes.get(routeKey);
        if (!route) return _noTarget('No active audio-effects route was selected', { routeKey });
        const authorization = _safeId(payload.authorization || '', '');
        if (!LOAD_AUTHORIZATIONS.has(authorization)) {
            return _decision('user-action-required', 'Releasing an audio-effects route requires user-action, restore-selection, or playback-session authorization', { route: _publicRoute(route) });
        }
        const provider = _providerForRoute(routeKey, route.providerId);
        const executor = _executorForRoute(routeKey, route.providerId, route.executorId || '');
        if (!executor || typeof executor.operationHandlers.releaseRoute !== 'function') {
            const outcome = _recordOutcome({ operation: 'release-route', outcome: 'no-handler', routeKey, providerId: route.providerId, reason: 'Selected executor does not support route release' });
            _touchRoute(route, outcome);
            return _noHandler('Selected audio-effects executor does not support route release', { route: _publicRoute(route), provider: _publicProvider(provider) });
        }
        let executorResult;
        {
            const _exReq = { routeKey, authorization, requesterId: _safeId(requester || 'unknown', 'unknown'), planId: route.activePlanId || '', summary: _safeValue(payload.summary || {}) };
            const _ex = await _invokeWithTimeout((r) => executor.operationHandlers.releaseRoute(r), _exReq, payload.timeoutMs);
            executorResult = _ex.timedOut
                ? { outcome: 'failed', status: 'timeout', reason: 'Executor route release timed out' }
                : _ex.value;
        }
        const result = _plainObject(executorResult);
        const outcomeName = _string(result.outcome || result.status || 'failed', 'failed');
        const normalizedOutcome = VALID_OUTCOMES.has(outcomeName) ? outcomeName : 'failed';
        const outcome = _recordOutcome({ operation: 'release-route', outcome: normalizedOutcome, routeKey, providerId: route.providerId, pluginId: provider && provider.pluginId, reason: result.reason || 'Route release operation completed', details: result.payload || result.summary || {} });
        if (normalizedOutcome === 'handled') {
            routes.delete(routeKey);
            _contributeDiagnostics();
        }
        else _touchRoute(route, outcome);
        _emit('audio-effects:changed', { route: _publicRoute(routes.get(routeKey)), operation: 'release-route', outcome: outcome.outcome });
        if (normalizedOutcome === 'handled') _emit('audio-effects:released', { routeKey, providerId: route.providerId });
        return _decision(outcome.outcome, outcome.reason || 'Route release operation completed', { route: _publicRoute(routes.get(routeKey)), provider: _publicProvider(provider), result: _safeValue(result.payload || result.summary || {}) });
    }

    function fallback(payload = {}) {
        const routeKey = _safeRoute(payload.routeKey || payload.route);
        const route = routes.get(routeKey) || {
            routeKey,
            chainId: _id('effects'),
            providerId: _safeId(payload.providerId || '', ''),
            state: 'fallback',
            bypassed: false,
            activePlanId: '',
            activeSegmentId: '',
            planSummary: {},
            dependencies: {},
            selectedAt: _now(),
            updatedAt: _now(),
            lastOutcome: null,
        };
        route.state = 'fallback';
        const outcome = _recordOutcome({ operation: 'fallback', outcome: 'degraded', routeKey, providerId: route.providerId, reason: payload.reason || 'Audio-effects fallback requested' });
        _touchRoute(route, outcome);
        routes.set(routeKey, route);
        _emit('audio-effects:fallback', { route: _publicRoute(route) });
        return _decision('degraded', payload.reason || 'Audio-effects fallback recorded', { route: _publicRoute(route) });
    }

    function inspectRoute(payload = {}) {
        const routeKey = _safeRoute(payload.routeKey || payload.route);
        return _handled({ route: _publicRoute(routes.get(routeKey)), provider: _publicProvider(_providerForRoute(routeKey, payload.providerId)), conflicts: [] }, 'Inspected audio-effects route');
    }

    async function listMappings(payload = {}) {
        return _mappingFetch(_mappingQuery(payload));
    }

    async function upsertMapping(payload = {}) {
        return _mappingFetch(MAPPING_ENDPOINT, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload || {}),
        });
    }

    async function deleteMapping(payload = {}) {
        const mappingId = _safeId(payload.mappingId || payload.mapping_id || payload.id || '', '');
        if (!mappingId) return _failed('mappingId is required');
        const params = [];
        _queryParam(params, 'provider_id', _aliasValue(payload, 'provider_id', 'providerId'));
        const suffix = params.length ? `?${params.join('&')}` : '';
        return _mappingFetch(`${MAPPING_ENDPOINT}/${encodeURIComponent(mappingId)}${suffix}`, { method: 'DELETE' });
    }

    async function activateMapping(payload = {}) {
        const mappingId = _safeId(payload.mappingId || payload.mapping_id || payload.id || '', '');
        if (!mappingId) return _failed('mappingId is required');
        const providerId = _aliasValue(payload, 'provider_id', 'providerId');
        return _mappingFetch(`${MAPPING_ENDPOINT}/${encodeURIComponent(mappingId)}/activate`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            // Forward the raw value (null/undefined -> '') so a non-string provider_id is rejected
            // by the server rather than silently coerced into an unscoped activate.
            body: JSON.stringify({ provider_id: providerId == null ? '' : providerId }),
        });
    }

    async function clearActiveMapping(payload = {}) {
        const songKeyRaw = _aliasValue(payload, 'song_key', 'songKey');
        const songKey = songKeyRaw == null ? '' : _string(songKeyRaw);
        if (!songKey) return _failed('songKey is required');
        const params = [`song_key=${encodeURIComponent(songKey)}`];
        const toneKeyRaw = _aliasValue(payload, 'tone_key', 'toneKey');
        params.push(`tone_key=${encodeURIComponent(toneKeyRaw == null ? '' : _string(toneKeyRaw))}`);
        return _mappingFetch(`/api/audio-effects/active-mapping?${params.join('&')}`, { method: 'DELETE' });
    }

    function recordBridgeHit(input = {}) {
        const routeKey = _safeRoute(input.routeKey || input.route);
        const bridgeId = _safeId(input.bridgeId || 'audio-effects.legacy-unknown', 'audio-effects.legacy-unknown');
        const pluginId = _safeId(input.pluginId || input.source || 'legacy', 'legacy');
        const key = `${routeKey}::${bridgeId}::${pluginId}`;
        const previous = bridges.get(key);
        const bridge = {
            bridgeId,
            routeKey,
            pluginId,
            expected: input.expected !== false,
            status: _safeId(input.status || input.outcome || 'used', 'used'),
            legacySurface: _boundedReason(input.legacySurface || input.sourceSurface || '').slice(0, 120),
            hitCount: previous ? previous.hitCount + 1 : 1,
            firstHitAt: previous ? previous.firstHitAt : _now(),
            lastHitAt: _now(),
            reason: _boundedReason(input.reason || ''),
        };
        bridges.set(key, bridge);
        while (bridges.size > MAX_BRIDGES) bridges.delete(bridges.keys().next().value);
        if (capabilities && typeof capabilities.registerCompatibilityShim === 'function') {
            capabilities.registerCompatibilityShim({
                shimId: bridgeId,
                capability: 'audio-effects',
                source: pluginId,
                legacySurface: bridge.legacySurface || bridgeId,
                status: 'used',
                hit: true,
                hitCount: bridge.hitCount,
                reason: bridge.reason || 'Audio-effects legacy bridge used',
                ownerPluginId: pluginId,
            });
        } else if (capabilities && typeof capabilities.recordLegacyHit === 'function') {
            capabilities.recordLegacyHit({
                shimId: bridgeId,
                capability: 'audio-effects',
                domain: 'audio-effects',
                routeKey,
                pluginId,
                source: pluginId,
                status: 'used',
                hit: true,
                hitCount: bridge.hitCount,
                reason: bridge.reason || 'Audio-effects legacy bridge used',
                legacySurface: bridge.legacySurface || bridgeId,
            });
        }
        const outcome = _recordOutcome({ operation: 'record-bridge-hit', outcome: 'handled', routeKey, pluginId, details: { bridgeId } });
        _emit('audio-effects:bridge-hit', { bridgeId, routeKey, pluginId });
        return _handled({ bridge, outcome }, 'Audio-effects bridge hit recorded');
    }

    function snapshot() {
        return {
            schema: SCHEMA,
            generatedAt: _now(),
            routeCount: routes.size,
            providerCount: providers.size,
            executorCount: executors.size + (_desktopExecutor() ? 1 : 0),
            providers: Array.from(providers.values()).slice(0, MAX_PROVIDERS).map(_publicProvider),
            executors: Array.from(executors.values()).concat(_desktopExecutor() ? [_desktopExecutor()] : []).slice(0, MAX_EXECUTORS).map(_publicExecutor),
            routes: Array.from(routes.values()).slice(0, MAX_ROUTES).map(_publicRoute),
            bridges: Array.from(bridges.values()).slice(-MAX_BRIDGES).map(bridge => ({ ...bridge })),
            recentOutcomes: recentOutcomes.slice(-MAX_OUTCOMES).map(item => ({ ...item })),
            limits: { maxProviders: MAX_PROVIDERS, maxExecutors: MAX_EXECUTORS, maxRoutes: MAX_ROUTES, maxStages: MAX_STAGES, maxSegments: MAX_SEGMENTS, maxSnapshotBytes: 100 * 1024 },
            redactionNotes: ['raw-chain-plans-omitted', 'paths-redacted', 'filenames-redacted', 'model-and-ir-names-omitted', 'vst-state-omitted', 'callbacks-omitted', 'handles-omitted'],
        };
    }

    function inspect(payload = {}) {
        return _handled({ ...snapshot(), options: _safeValue(payload) }, 'Inspected audio-effects domain');
    }

    function _payload(ctx = {}) {
        const payload = _plainObject(ctx.payload || ctx.args || ctx.target);
        return { ...payload, ..._plainObject(ctx.target) };
    }

    async function _command(commandName, ctx = {}) {
        const payload = _payload(ctx);
        if (commandName === 'inspect') return inspect(payload);
        if (commandName === 'list-providers') return listProviders(payload);
        if (commandName === 'list-executors') return listExecutors(payload);
        if (commandName === 'register-provider' || commandName === 'register-participant') return registerProvider(payload.provider || payload.participant || payload);
        if (commandName === 'register-executor') return registerExecutor(payload.executor || payload);
        if (commandName === 'unregister-provider' || commandName === 'unregister-participant') return unregisterProvider(payload);
        if (commandName === 'unregister-executor') return unregisterExecutor(payload);
        if (commandName === 'select-chain') return selectChain(payload, ctx.requester || ctx.source);
        if (commandName === 'resolve-plan') return resolvePlan(payload, ctx.requester || ctx.source);
        if (commandName === 'load-plan' || commandName === 'execute-plan') return loadPlan(payload, ctx.requester || ctx.source);
        if (commandName === 'release-route' || commandName === 'unload-plan' || commandName === 'clear-route') return releaseRoute(payload, ctx.requester || ctx.source);
        if (commandName === 'inspect-route') return inspectRoute(payload);
        if (commandName === 'list-mappings') return listMappings(payload);
        if (commandName === 'upsert-mapping') return upsertMapping(payload);
        if (commandName === 'delete-mapping') return deleteMapping(payload);
        if (commandName === 'activate-mapping') return activateMapping(payload);
        if (commandName === 'clear-active-mapping') return clearActiveMapping(payload);
        if (commandName === 'bypass') return setRouteBypass(payload, true);
        if (commandName === 'restore') return setRouteBypass(payload, false);
        if (commandName === 'fallback') return fallback(payload);
        if (commandName === 'activate-segment') return _providerOperation('segment.activate', payload, ctx.requester || ctx.source);
        if (commandName === 'set-stage-bypass') return _providerOperation('stage.set-bypass', payload, ctx.requester || ctx.source);
        if (commandName === 'set-stage-parameter') return _providerOperation('stage.set-parameter', payload, ctx.requester || ctx.source);
        if (commandName === 'set-route-gain') return setRouteGain(payload);
        if (commandName === 'record-bridge-hit') return recordBridgeHit(payload);
        return _unsupported(`Unsupported audio-effects command: ${commandName}`);
    }

    function _registerDomain() {
        capabilities.registerOwner('audio-effects', {
            pluginId: OWNER_ID,
            kind: 'provider-coordinator',
            commands: ['inspect', 'list-providers', 'list-executors', 'register-provider', 'register-participant', 'unregister-provider', 'unregister-participant', 'register-executor', 'unregister-executor', 'select-chain', 'resolve-plan', 'load-plan', 'execute-plan', 'release-route', 'unload-plan', 'clear-route', 'inspect-route', 'list-mappings', 'upsert-mapping', 'delete-mapping', 'activate-mapping', 'clear-active-mapping', 'bypass', 'restore', 'fallback', 'activate-segment', 'set-stage-bypass', 'set-stage-parameter', 'set-route-gain', 'record-bridge-hit'],
            operations: ['chain.resolve', 'chain.inspect', 'mapping.list', 'mapping.upsert', 'mapping.delete', 'mapping.activate', 'mapping.clear-active', 'executor.load-chain-plan', 'executor.release-route', 'executor.activate-segment', 'executor.set-stage-bypass', 'executor.set-stage-parameter', 'executor.set-route-gain', 'segment.activate', 'stage.set-bypass', 'stage.set-parameter', 'route.bypass', 'route.restore', 'route.release', 'route.set-gain'],
            events: ['provider-registered', 'provider-unregistered', 'executor-registered', 'executor-unregistered', 'route-selected', 'plan-resolved', 'changed', 'released', 'fallback', 'bridge-hit'],
            safety: 'sensitive',
            description: 'Coordinates audio-effects route provider selection, compatible executor selection, constrained chain-plan resolution/loading, route bypass/fallback, and redaction-safe diagnostics.',
            handlers: {
                inspect: ctx => _command('inspect', ctx),
                'list-providers': ctx => _command('list-providers', ctx),
                'list-executors': ctx => _command('list-executors', ctx),
                'register-provider': ctx => _command('register-provider', ctx),
                'register-participant': ctx => _command('register-participant', ctx),
                'register-executor': ctx => _command('register-executor', ctx),
                'unregister-provider': ctx => _command('unregister-provider', ctx),
                'unregister-participant': ctx => _command('unregister-participant', ctx),
                'unregister-executor': ctx => _command('unregister-executor', ctx),
                'select-chain': ctx => _command('select-chain', ctx),
                'resolve-plan': ctx => _command('resolve-plan', ctx),
                'load-plan': ctx => _command('load-plan', ctx),
                'execute-plan': ctx => _command('execute-plan', ctx),
                'release-route': ctx => _command('release-route', ctx),
                'unload-plan': ctx => _command('unload-plan', ctx),
                'clear-route': ctx => _command('clear-route', ctx),
                'inspect-route': ctx => _command('inspect-route', ctx),
                'list-mappings': ctx => _command('list-mappings', ctx),
                'upsert-mapping': ctx => _command('upsert-mapping', ctx),
                'delete-mapping': ctx => _command('delete-mapping', ctx),
                'activate-mapping': ctx => _command('activate-mapping', ctx),
                'clear-active-mapping': ctx => _command('clear-active-mapping', ctx),
                bypass: ctx => _command('bypass', ctx),
                restore: ctx => _command('restore', ctx),
                fallback: ctx => _command('fallback', ctx),
                'activate-segment': ctx => _command('activate-segment', ctx),
                'set-stage-bypass': ctx => _command('set-stage-bypass', ctx),
                'set-stage-parameter': ctx => _command('set-stage-parameter', ctx),
                'set-route-gain': ctx => _command('set-route-gain', ctx),
                'record-bridge-hit': ctx => _command('record-bridge-hit', ctx),
            },
        });
    }

    function _registerBridgeMetadata() {
        if (typeof capabilities.registerCompatibilityShim !== 'function') return;
        const shims = [
            { shimId: 'audio-effects.legacy-tone-controls', capability: 'audio-effects', source: OWNER_ID, legacySurface: 'legacy tone/effect controls', reason: 'Legacy tone controls are attributed until providers use native audio-effects route operations.' },
            { shimId: 'audio-effects.legacy-nam-routing', capability: 'audio-effects', source: OWNER_ID, legacySurface: 'NAM tone native-preset route interception', reason: 'Legacy NAM/Rig Builder route interception remains a migration bridge until providers resolve chain plans natively.' },
            { shimId: 'audio-effects.legacy-native-load', capability: 'audio-effects', source: OWNER_ID, legacySurface: 'window.feedBackDesktop.audio.loadPreset', reason: 'Direct Desktop native preset loading is attributed until providers route physical loads through compatible audio-effects executors.' },
            { shimId: 'audio-effects.legacy-tone-db', capability: 'audio-effects', source: OWNER_ID, legacySurface: 'nam_tone.db tone_mappings', reason: 'Legacy NAM tone database mapping access is attributed until providers use the core audio-effects mapping index exclusively.' },
            { shimId: 'audio-effects.legacy-midi-amp', capability: 'audio-effects', source: OWNER_ID, legacySurface: 'MIDI amp/external effect handoff', reason: 'Legacy external effect handoffs are attributed until provider route operations land.' },
        ];
        for (const shim of shims) capabilities.registerCompatibilityShim({ ...shim, status: 'active' });
    }

    function _contributeDiagnostics() {
        const diagnostics = window.feedBack && window.feedBack.diagnostics;
        if (diagnostics && typeof diagnostics.contribute === 'function') {
            try { diagnostics.contribute('audio-effects', snapshot()); }
            catch (_) { /* diagnostics must not break playback */ }
        }
    }

    const api = {
        version: 1,
        planSchema: PLAN_SCHEMA,
        registerProvider,
        unregisterProvider,
        listProviders,
        registerExecutor,
        unregisterExecutor,
        listExecutors,
        selectChain,
        resolvePlan,
        loadPlan,
        releaseRoute,
        inspectRoute,
        listMappings,
        upsertMapping,
        deleteMapping,
        activateMapping,
        clearActiveMapping,
        bypass: payload => setRouteBypass(payload, true),
        restore: payload => setRouteBypass(payload, false),
        fallback,
        activateSegment: payload => _providerOperation('segment.activate', payload),
        setStageBypass: payload => _providerOperation('stage.set-bypass', payload),
        setStageParameter: payload => _providerOperation('stage.set-parameter', payload),
        setRouteGain,
        recordBridgeHit,
        recordOutcome: entry => _clone(_recordOutcome(entry)),
        snapshot,
        getDiagnostics: snapshot,
    };

    window.feedBack.audioEffects = api;
    _registerDomain();
    _registerBridgeMetadata();
    _contributeDiagnostics();
})();
