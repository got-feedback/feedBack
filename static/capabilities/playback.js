// Core playback capability domain host.
(function () {
    'use strict';

    window.feedBack = window.feedBack || {};
    const capabilities = window.feedBack.capabilities;
    if (!capabilities || capabilities.version !== 1) return;
    if (window.feedBack.playback && window.feedBack.playback.version === 1) return;

    const SCHEMA = 'feedBack.playback.diagnostics.v1';
    const OWNER_ID = 'core.playback';
    const MAX_CURRENT_OUTCOMES = 50;
    const MAX_CURRENT_EVENTS = 50;
    const MAX_STOPPED_SESSIONS = 5;
    const MAX_STOPPED_SESSION_ITEMS = 20;
    const MAX_BRIDGES = 50;
    // Max retained requesters / observers per role. The registration surface is
    // otherwise unbounded, so without this a flood would expand the maps
    // (memory) and the per-snapshot work without limit.
    const MAX_PARTICIPANTS = 50;
    // Generic redaction backstop for arbitrary nested arrays. Kept >= the
    // accounted history caps above so _safeValue never silently re-trims an
    // already-bounded history array (which would make redaction.droppedCounts
    // under-report); it only bounds otherwise-unbounded arrays (e.g. participants).
    const MAX_SAFE_ARRAY = 50;
    const MAX_REASON = 240;
    const MAX_SNAPSHOT_BYTES = 64 * 1024;
    const ACTIVE_STATES = new Set(['loading', 'ready', 'playing', 'paused', 'seeking', 'degraded']);
    const TERMINAL_STATES = new Set(['idle', 'ended', 'stopped', 'unavailable', 'failed']);
    const OUTCOMES = new Set([
        'handled', 'denied', 'degraded', 'failed', 'no-owner', 'no-handler', 'no-target',
        'unsupported-command', 'incompatible-version', 'unavailable', 'user-action-required',
        'stale', 'cancelled', 'stopped', 'overridden',
    ]);
    const EVENT_NAMES = Object.freeze([
        'requested', 'loading', 'ready', 'started', 'paused', 'resumed', 'seeking', 'seeked',
        'ended', 'stopped', 'unavailable', 'degraded', 'failed', 'superseded', 'route-changing',
        'route-changed', 'bridge-hit', 'loop-set', 'loop-cleared', 'loop-restarted',
        'loop-rejected', 'loop-stale',
    ]);
    const COMMANDS = Object.freeze(['inspect', 'start', 'pause', 'resume', 'stop', 'seek', 'set-loop', 'clear-loop', 'register-requester', 'register-observer']);
    const RAW_KEY_RE = /(^|_)(title|artist|album|filename|path|url|audio|stream|media_stream|audio_node|audionode|node|device|device_id|hardware|hardware_id|handle|buffer|sample|waveform|recording|native|route_object|secret|token|password|api|api_key)(_|$)/i;

    let sequence = 0;
    let commandSequence = 0;
    let transportAdapter = null;
    const requesters = new Map();
    const observers = new Map();
    const bridges = new Map();
    const stoppedSessions = [];
    let lastUserAction = null;
    let pendingSeekWasPlaying = null;
    let commandAdapterDepth = 0;
    let currentSession = _newIdleSession();

    // Run a command's transport-adapter call while flagging that any resulting
    // legacy song:* events are echoes of this domain's own command — the legacy
    // bridge skips them so observers don't get duplicate playback:* events
    // (and stop doesn't double-archive). Genuine UI-driven song:* events, which
    // fire outside any command, still flow through the bridge.
    //
    // For the fast commands the echo is emitted synchronously inside the
    // adapter call, so no other handler can interleave; only start's longer
    // load window holds the flag across awaits. In this single-user app (no
    // concurrency model, per the constitution) a real user-originated legacy
    // event landing inside that window is not expected, and missing one bridge
    // reflection is benign — the legacy UI handlers still apply it directly.
    async function _driveAdapter(fn) {
        commandAdapterDepth += 1;
        try { return await fn(); }
        finally { commandAdapterDepth -= 1; }
    }

    function _now() { return new Date().toISOString(); }

    function _string(value, fallback = '') {
        const normalized = String(value == null ? '' : value).trim();
        return normalized || fallback;
    }

    function _number(value, fallback = null) {
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

    function _id(prefix) {
        sequence += 1;
        return `${prefix}-${sequence}`;
    }

    function _safeInternalId(value, prefix, fallback = '') {
        const raw = _string(value);
        // Only the trusted internal fallback (this domain's own id) passes
        // through. Any other caller-supplied id is untrusted — a charset match
        // is not enough (e.g. `playback-secret_token`), so hash it so nothing
        // identifying is exported verbatim in diagnostics/history.
        if (!raw || raw === fallback) return fallback;
        const safePrefix = _string(prefix, 'id');
        return `${safePrefix}-${_hash(raw)}`;
    }

    function _hash(value) {
        const input = _string(value, 'unknown');
        let h = 2166136261;
        for (let i = 0; i < input.length; i += 1) {
            h ^= input.charCodeAt(i);
            h = Math.imul(h, 16777619);
        }
        return (h >>> 0).toString(36);
    }

    function _redactString(value) {
        const localPath = /(?:\/Users\/|\/home\/|\/root\b\/?|[A-Za-z]:\\)[^\r\n\t"',;(){}\[\]<>|]*/g;
        return _string(value)
            .replace(localPath, '[path]')
            .replace(/https?:\/\/[^\s?#]+[^\s]*/gi, '[url]')
            .replace(/\b(token|secret|password|api[_-]?key)=([^\s&]+)/gi, '$1=[redacted]')
            .replace(/\b(raw[-_ ]?audio|audio[-_ ]?buffer|sample[s]?|waveform[s]?|recording[s]?|htmlaudioelement|audionode|mediastream)\b/gi, '[media]');
    }

    function _boundedReason(value) {
        return _redactString(value).replace(/\s+/g, ' ').slice(0, MAX_REASON);
    }

    function _requesterId(value, fallback = 'unknown') {
        return _boundedReason(value || fallback).replace(/[^A-Za-z0-9_.:-]+/g, '-').slice(0, 96) || fallback;
    }

    function _safeKeyName(key) {
        return _string(key).replace(/([a-z0-9])([A-Z])/g, '$1_$2').replace(/([A-Z]+)([A-Z][a-z])/g, '$1_$2').toLowerCase();
    }

    function _eventName(name) {
        return _string(name).replace(/^playback:/, '');
    }

    function _priority(args) {
        const source = _plainObject(args);
        if (source.priority === 'user' || source.authorization === 'user-action' || source.kind === 'user') return 'user';
        return 'normal';
    }

    function _payloadIsPlaying(source, fallback) {
        const payload = _plainObject(source);
        if (payload.isPlaying === true || payload.playing === true) return true;
        if (payload.isPlaying === false || payload.playing === false) return false;
        const state = _string(payload.playbackState || payload.transportState || payload.state).toLowerCase();
        if (state === 'playing' || state === 'started' || state === 'resumed') return true;
        if (state === 'paused' || state === 'stopped' || state === 'ended' || state === 'idle') return false;
        return !!fallback;
    }

    function _safeValue(value, depth = 0, exportMode = 'exported') {
        if (typeof value === 'string') return _boundedReason(value);
        if (value == null || typeof value === 'number' || typeof value === 'boolean') return value;
        if (depth > 6) return '[truncated]';
        // Keep the most recent items as a backstop for unbounded arrays. The
        // cap is >= the explicit history caps, so accounted history (already
        // bounded + budget-trimmed with droppedCounts) passes through untouched;
        // slice(-N) keeps the latest activity rather than the oldest.
        if (Array.isArray(value)) return value.slice(-MAX_SAFE_ARRAY).map(item => _safeValue(item, depth + 1, exportMode));
        if (typeof value === 'object') {
            const out = {};
            for (const [key, item] of Object.entries(value).slice(0, 40)) {
                if (typeof item === 'function') continue;
                if (exportMode === 'local-inspector' && (key === 'localDisplay' || key === 'display')) {
                    out[key] = _safeLocalDisplay(item);
                    continue;
                }
                if (RAW_KEY_RE.test(_safeKeyName(key))) {
                    continue;
                }
                out[_boundedReason(key)] = _safeValue(item, depth + 1, exportMode);
            }
            return out;
        }
        return '';
    }

    function _safeLocalDisplay(value) {
        const source = _plainObject(value);
        return {
            title: _boundedReason(source.title || source.name),
            artist: _boundedReason(source.artist),
            arrangement: _boundedReason(source.arrangement || source.arrangementName || source.arrangementSmartName),
        };
    }

    function _clone(value) {
        try { return JSON.parse(JSON.stringify(value)); }
        catch (_) { return null; }
    }

    function _targetSeed(target) {
        const source = _plainObject(target);
        return source.songKey || source.libraryKey || source.id || source.filename || source.url || source.title || source.name || currentSession.target?.targetId || source.targetId || 'unknown';
    }

    function _settingsSeed(target) {
        const source = _plainObject(target);
        return source.songKey || source.libraryKey || source.id || source.filename || source.url || source.title || source.name || source.settingsKey || source.localSettingsKey || source.playbackSettingsKey || currentSession.target?.settingsKey || currentSession.target?.targetId || 'unknown';
    }

    function _settingsKey(target) {
        const source = _plainObject(target);
        const explicit = _string(source.settingsKey || source.localSettingsKey || source.playbackSettingsKey);
        if (/^settings-v1-[a-z0-9]{7}$/.test(explicit)) return explicit;
        const sourceKind = _boundedReason(source.sourceKind || source.source || source.format || 'unknown').slice(0, 40) || 'unknown';
        return `settings-v1-${_hash(`${sourceKind}:${_settingsSeed(source)}`).padStart(7, '0').slice(-7)}`;
    }

    function _normalizeArrangement(source) {
        // A numeric index is the canonical, non-identifying key — preserve 0
        // ('||' would drop it as falsy).
        const index = _number(source.arrangementIndex, _number(source.arrangement_index, null));
        if (index != null) return `arrangement-${index}`;
        // arrangementRef/arrangementId may already be our normalized form;
        // pass one through only when it matches that exact shape
        // (arrangement-<index|hash>), otherwise pseudonymize it.
        const ref = source.arrangementRef || source.arrangementId;
        if (typeof ref === 'number') return `arrangement-${ref}`;
        if (typeof ref === 'string' && ref) {
            const str = _boundedReason(ref).slice(0, 80);
            return /^arrangement-[a-z0-9]+$/.test(str) ? str : `arrangement-${_hash(str)}`;
        }
        // A free-text arrangement label (e.g. "Lead") is user-visible, so always
        // pseudonymize it — never emit it verbatim via target.arrangementRef.
        const label = source.arrangement;
        if (label == null || label === '') return '';
        if (typeof label === 'number') return `arrangement-${label}`;
        return `arrangement-${_hash(_boundedReason(label).slice(0, 80))}`;
    }

    function _normalizeTarget(target = {}, options = {}) {
        const source = _plainObject(target);
        const seed = _targetSeed(source);
        const arrangementRef = _normalizeArrangement(source) || _normalizeArrangement(options);
        const normalized = {
            targetId: `target-${_hash(`${seed}:${arrangementRef}`)}`,
            settingsKey: _settingsKey(source),
            sourceKind: _boundedReason(source.sourceKind || source.source || source.format || 'unknown').slice(0, 40) || 'unknown',
            arrangementRef: arrangementRef || null,
            format: _boundedReason(source.format || source.sourceKind || 'unknown').slice(0, 40) || 'unknown',
            requestedBy: _requesterId(source.requestedBy || options.requesterId || options.source, 'unknown'),
        };
        const display = _safeLocalDisplay(source.localDisplay || source.display || source);
        if (display.title || display.artist || display.arrangement) normalized.localDisplay = display;
        return normalized;
    }

    function _inactiveLoop(state = 'inactive') {
        return { loopId: null, sessionId: null, startTime: null, endTime: null, enabled: false, state, requesterId: null, reason: '' };
    }

    function _defaultRoute() {
        return { routeId: 'route-unknown', routeKind: 'unknown', state: 'unavailable', preservedTime: null, safeReason: '', lastChangedAt: _now() };
    }

    function _newIdleSession() {
        const now = _now();
        return {
            sessionId: 'playback-idle',
            sequence: 0,
            state: 'idle',
            target: null,
            transport: { state: 'idle', isPlaying: false, isSeeking: false, readiness: 'idle', requesterId: 'system', priority: 'normal', reason: '', updatedAt: now },
            media: { targetId: null, currentTime: null, duration: null, playbackRate: null, chartTime: null, mediaTime: null, timeUncertainty: 'unknown', readiness: 'idle', route: _defaultRoute(), loop: _inactiveLoop() },
            route: _defaultRoute(),
            loop: _inactiveLoop(),
            history: { recentOutcomes: [], lifecycleEvents: [], droppedCounts: { outcomes: 0, events: 0 }, updatedAt: now },
            createdAt: now,
            updatedAt: now,
            stoppedAt: null,
        };
    }

    function _newSession(target, args = {}) {
        const now = _now();
        const sessionId = _id('playback');
        return {
            sessionId,
            sequence,
            state: 'loading',
            target,
            transport: { state: 'loading', isPlaying: false, isSeeking: false, readiness: 'loading', requesterId: _requesterId(args.requesterId || args.source, 'core.player.controls'), priority: _priority(args), reason: _boundedReason(args.reason), updatedAt: now },
            media: { targetId: target && target.targetId, currentTime: null, duration: null, playbackRate: 1, chartTime: null, mediaTime: null, timeUncertainty: 'unknown', readiness: 'loading', route: _defaultRoute(), loop: _inactiveLoop() },
            route: _defaultRoute(),
            loop: _inactiveLoop(),
            history: { recentOutcomes: [], lifecycleEvents: [], droppedCounts: { outcomes: 0, events: 0 }, updatedAt: now },
            createdAt: now,
            updatedAt: now,
            stoppedAt: null,
        };
    }

    function _touch() {
        currentSession.updatedAt = _now();
        currentSession.transport.updatedAt = currentSession.updatedAt;
        currentSession.media.targetId = currentSession.target && currentSession.target.targetId || null;
        currentSession.media.route = _clone(currentSession.route);
        currentSession.media.loop = _clone(currentSession.loop);
        _contributeDiagnostics();
    }

    function _rememberBounded(list, item, max, droppedKey) {
        list.push(item);
        while (list.length > max) {
            list.shift();
            if (currentSession.history && currentSession.history.droppedCounts) currentSession.history.droppedCounts[droppedKey] += 1;
        }
        if (currentSession.history) currentSession.history.updatedAt = _now();
    }

    function _recordOutcome(operation, outcome, details = {}) {
        const normalized = OUTCOMES.has(outcome) ? outcome : 'handled';
        const entry = {
            operation: _boundedReason(operation).slice(0, 80),
            outcome: normalized,
            status: _boundedReason(details.status || normalized).slice(0, 80),
            sessionId: _safeInternalId(details.sessionId, 'playback', currentSession.sessionId),
            targetId: details.targetId || (currentSession.target && currentSession.target.targetId) || null,
            requesterId: _requesterId(details.requesterId || details.source || currentSession.transport.requesterId, 'unknown'),
            reason: _boundedReason(details.reason),
            createdAt: _now(),
        };
        for (const key of ['requestedTime', 'fromTime', 'landedTime']) {
            const numeric = _number(details[key], null);
            if (numeric != null) entry[key] = numeric;
        }
        _rememberBounded(currentSession.history.recentOutcomes, entry, MAX_CURRENT_OUTCOMES, 'outcomes');
        _touch();
        return entry;
    }

    function _recordLifecycle(event, payload = {}) {
        const name = _eventName(event);
        const summary = {
            event: `playback:${name}`,
            sessionId: currentSession.sessionId,
            targetId: currentSession.target && currentSession.target.targetId || null,
            state: currentSession.state,
            requesterId: _requesterId(payload.requesterId || payload.source || currentSession.transport.requesterId, 'unknown'),
            reason: _boundedReason(payload.reason),
            createdAt: _now(),
        };
        _rememberBounded(currentSession.history.lifecycleEvents, summary, MAX_CURRENT_EVENTS, 'events');
        return summary;
    }

    function _emitPlayback(event, payload = {}) {
        const name = _eventName(event);
        // Sanitized caller payload first, canonical session fields last, so a
        // caller-/transport-controlled payload (e.g. via transportEvent or
        // recordRouteChange) can never override the authoritative sessionId,
        // state, target, media, loop, or route and spoof the event identity.
        const safePayload = {
            ..._safeValue(payload, 0, 'exported'),
            sessionId: currentSession.sessionId,
            state: currentSession.state,
            target: _publicTarget(currentSession.target, 'exported'),
            media: _publicMedia(currentSession.media),
            loop: _clone(currentSession.loop),
            route: _clone(currentSession.route),
        };
        _recordLifecycle(name, safePayload);
        if (typeof capabilities.emitEvent === 'function') capabilities.emitEvent('playback', name, safePayload);
    }

    function _finalizeStoppedSession() {
        if (!currentSession || currentSession.sessionId === 'playback-idle') return;
        const summary = {
            sessionId: currentSession.sessionId,
            state: currentSession.state,
            targetId: currentSession.target && currentSession.target.targetId || null,
            stoppedAt: currentSession.stoppedAt || _now(),
            recentOutcomes: currentSession.history.recentOutcomes.slice(-MAX_STOPPED_SESSION_ITEMS),
            lifecycleEvents: currentSession.history.lifecycleEvents.slice(-MAX_STOPPED_SESSION_ITEMS),
            droppedCounts: { ...currentSession.history.droppedCounts },
        };
        stoppedSessions.push(summary);
        while (stoppedSessions.length > MAX_STOPPED_SESSIONS) stoppedSessions.shift();
    }

    function _setState(state, details = {}) {
        const now = _now();
        currentSession.state = state;
        currentSession.transport.state = state;
        currentSession.transport.isSeeking = state === 'seeking';
        // 'degraded' is a route change (e.g. desktop -> browser-media fallback),
        // not a transport change, so playback can continue through it — preserve
        // the current isPlaying unless a caller passes an explicit value.
        currentSession.transport.isPlaying = typeof details.isPlaying === 'boolean'
            ? details.isPlaying
            : (state === 'playing' ? true
                : (state === 'degraded' ? currentSession.transport.isPlaying : false));
        currentSession.transport.readiness = details.readiness || (state === 'loading' ? 'loading' : (state === 'failed' ? 'failed' : (state === 'unavailable' ? 'unavailable' : (state === 'idle' ? 'idle' : 'ready'))));
        currentSession.transport.requesterId = _requesterId(details.requesterId || currentSession.transport.requesterId, 'unknown');
        currentSession.transport.priority = details.priority || currentSession.transport.priority || 'normal';
        currentSession.transport.reason = _boundedReason(details.reason);
        currentSession.transport.updatedAt = now;
        currentSession.media.readiness = currentSession.transport.readiness;
        currentSession.updatedAt = now;
        if (state === 'stopped' || state === 'ended') currentSession.stoppedAt = now;
        _touch();
    }

    function _hasActiveSession() {
        return !!(currentSession && currentSession.target && !TERMINAL_STATES.has(currentSession.state));
    }

    function _targetMatches(args = {}) {
        const source = _plainObject(args);
        if (source.sessionId && source.sessionId !== currentSession.sessionId) return false;
        if (source.targetId && currentSession.target && source.targetId !== currentSession.target.targetId) return false;
        return true;
    }

    function _normalizeParticipant(source, role) {
        const item = _plainObject(source);
        const id = _requesterId(item.requesterId || item.observerId || item.participantId || item.id || item.source, role === 'observer' ? 'observer.unknown' : 'requester.unknown');
        return {
            id,
            requesterId: role === 'requester' ? id : undefined,
            observerId: role === 'observer' ? id : undefined,
            role,
            kind: _boundedReason(item.kind || (id.startsWith('core.') ? 'core' : 'plugin')).slice(0, 40),
            priority: item.priority === 'user' ? 'user' : 'normal',
            authorization: _boundedReason(item.authorization || 'none').slice(0, 40),
            status: _boundedReason(item.status || 'available').slice(0, 40),
            observes: Array.isArray(item.observes) ? item.observes.map(_eventName).slice(0, 30) : [],
            lastSeenAt: _now(),
            lastActionAt: item.lastActionAt || '',
        };
    }

    function _rememberParticipant(map, normalized) {
        const previous = map.get(normalized.id) || {};
        // Re-insert so an updated participant counts as most-recently-seen, then
        // evict the oldest beyond the cap to bound memory and snapshot work.
        map.delete(normalized.id);
        map.set(normalized.id, { ...previous, ...normalized, firstSeenAt: previous.firstSeenAt || normalized.lastSeenAt });
        while (map.size > MAX_PARTICIPANTS) map.delete(map.keys().next().value);
        return map.get(normalized.id);
    }

    function registerRequester(requester) {
        const result = _rememberParticipant(requesters, _normalizeParticipant(requester, 'requester'));
        _contributeDiagnostics();
        return result;
    }

    function registerObserver(observer) {
        const result = _rememberParticipant(observers, _normalizeParticipant(observer, 'observer'));
        _contributeDiagnostics();
        return result;
    }

    function _participants() {
        // Take the most recent share from each role (the maps are themselves
        // capped at registration) so the snapshot stays bounded and fair across
        // requesters/observers before snapshot()'s JSON.stringify byte check —
        // the budget-trim loops only shrink history, not participants.
        const perRole = Math.floor(MAX_SAFE_ARRAY / 2);
        const recent = values => Array.from(values).slice(-perRole);
        return [...recent(requesters.values()), ...recent(observers.values())].map(item => {
            const copy = { ...item };
            delete copy.id;
            Object.keys(copy).forEach(key => copy[key] === undefined && delete copy[key]);
            return copy;
        });
    }

    function _publicTarget(target, exportMode = 'exported') {
        if (!target) return null;
        const out = {
            targetId: target.targetId,
            settingsKey: target.settingsKey,
            sourceKind: target.sourceKind,
            arrangementRef: target.arrangementRef,
            format: target.format,
            requestedBy: target.requestedBy,
        };
        if (exportMode === 'local-inspector' && target.localDisplay) out.localDisplay = _safeLocalDisplay(target.localDisplay);
        return out;
    }

    function _publicMedia(media) {
        const source = _plainObject(media);
        return {
            targetId: source.targetId || null,
            currentTime: _number(source.currentTime, null),
            duration: _number(source.duration, null),
            playbackRate: _number(source.playbackRate, null),
            chartTime: _number(source.chartTime, null),
            mediaTime: _number(source.mediaTime, null),
            timeUncertainty: _boundedReason(source.timeUncertainty || 'unknown').slice(0, 40),
            readiness: _boundedReason(source.readiness || currentSession.transport.readiness || 'unknown').slice(0, 40),
            route: _clone(currentSession.route),
            loop: _clone(currentSession.loop),
        };
    }

    function _bridgeSummary(entry) {
        return {
            bridgeId: entry.bridgeId,
            legacySurface: entry.legacySurface,
            source: entry.source,
            hitCount: Math.min(Number(entry.hitCount || 0), 9999),
            lastHitAt: entry.lastHitAt || null,
            status: entry.status || 'active',
            reason: _boundedReason(entry.reason),
        };
    }

    function recordBridgeHit(bridge) {
        const source = _plainObject(bridge);
        const bridgeId = _requesterId(source.bridgeId || source.id || `playback.${source.legacySurface || 'legacy'}`, 'playback.legacy');
        const previous = bridges.get(bridgeId) || { hitCount: 0 };
        const entry = {
            bridgeId,
            legacySurface: _boundedReason(source.legacySurface || source.surface || 'unknown').slice(0, 80),
            source: _requesterId(source.source || source.requesterId || 'legacy-runtime'),
            hitCount: Math.min(Number(previous.hitCount || 0) + 1, 9999),
            lastHitAt: source.lastHitAt || _now(),
            status: _boundedReason(source.status || 'active').slice(0, 40),
            reason: _boundedReason(source.reason || 'Legacy runtime surface used'),
        };
        bridges.set(bridgeId, entry);
        while (bridges.size > MAX_BRIDGES) bridges.delete(bridges.keys().next().value);
        if (typeof capabilities.recordLegacyHit === 'function') {
            capabilities.recordLegacyHit({
                capability: 'playback',
                legacySurface: entry.legacySurface,
                source: entry.source,
                reason: entry.reason,
                shimId: entry.bridgeId,
            });
        }
        _emitPlayback('bridge-hit', { bridge: _bridgeSummary(entry) });
        _contributeDiagnostics();
        return _bridgeSummary(entry);
    }

    function _snapshotTransport() {
        if (!transportAdapter || typeof transportAdapter.inspect !== 'function') return null;
        try { return transportAdapter.inspect(); }
        catch (_) { return null; }
    }

    function _mergeTransportSnapshot(snapshot) {
        const source = _plainObject(snapshot);
        if (!Object.keys(source).length) return;
        const currentTime = _number(source.currentTime, _number(source.mediaTime, currentSession.media.currentTime));
        currentSession.media.currentTime = currentTime;
        currentSession.media.mediaTime = _number(source.mediaTime, currentTime);
        currentSession.media.chartTime = _number(source.chartTime, currentTime);
        currentSession.media.duration = _number(source.duration, currentSession.media.duration);
        currentSession.media.playbackRate = _number(source.playbackRate, currentSession.media.playbackRate);
        currentSession.media.timeUncertainty = _boundedReason(source.timeUncertainty || currentSession.media.timeUncertainty || 'none').slice(0, 40);
        if (source.route || source.routeKind || source.routeState) _updateRoute(source.route || source);
        if (source.loop || source.loopA != null || source.loopB != null) _updateLoopFromSnapshot(source.loop || source);
        if (source.isPlaying === true) currentSession.transport.isPlaying = true;
        if (source.isPlaying === false) currentSession.transport.isPlaying = false;
    }

    function _updateRoute(route) {
        const source = _plainObject(route);
        const routeKind = _boundedReason(source.routeKind || source.kind || (source.juceMode ? 'desktop-native' : 'browser-media')).slice(0, 40) || 'unknown';
        currentSession.route = {
            routeId: _safeInternalId(source.routeId, 'route', `route-${_hash(routeKind)}`),
            routeKind,
            state: _boundedReason(source.state || source.routeState || source.availability || 'active').slice(0, 40),
            preservedTime: source.preservedTime == null ? null : !!source.preservedTime,
            safeReason: _boundedReason(source.safeReason || source.reason),
            lastChangedAt: source.lastChangedAt || _now(),
        };
        currentSession.media.route = _clone(currentSession.route);
    }

    function _updateLoopFromSnapshot(loop) {
        const source = _plainObject(loop);
        const start = _number(source.startTime, _number(source.loopA, null));
        const end = _number(source.endTime, _number(source.loopB, null));
        if (start == null || end == null) {
            currentSession.loop = _inactiveLoop(source.state || 'inactive');
        } else {
            currentSession.loop = {
                loopId: source.loopId || `loop-${_hash(`${currentSession.sessionId}:${start}:${end}`)}`,
                sessionId: currentSession.sessionId,
                startTime: start,
                endTime: end,
                enabled: source.enabled !== false,
                requesterId: _requesterId(source.requesterId || currentSession.transport.requesterId, 'unknown'),
                state: _boundedReason(source.state || 'active').slice(0, 40),
                lastRestartAt: source.lastRestartAt || '',
                reason: _boundedReason(source.reason),
            };
        }
        currentSession.media.loop = _clone(currentSession.loop);
    }

    function snapshot(options = {}) {
        _mergeTransportSnapshot(_snapshotTransport());
        const exportMode = options.exportMode === 'local-inspector' || options.local === true ? 'local-inspector' : 'exported';
        const data = {
            schema: SCHEMA,
            domain: 'playback',
            generatedAt: _now(),
            exportMode,
            state: {
                sessionId: currentSession.sessionId,
                state: currentSession.state,
                target: _publicTarget(currentSession.target, exportMode),
                transport: _clone(currentSession.transport),
                media: _publicMedia(currentSession.media),
                route: _clone(currentSession.route),
                loop: _clone(currentSession.loop),
            },
            participants: _participants(),
            bridges: Array.from(bridges.values()).map(_bridgeSummary),
            history: {
                current: _clone(currentSession.history),
                stoppedSessions: stoppedSessions.map(item => _clone(item)),
            },
            redaction: { targetIdentity: exportMode === 'exported' ? 'pseudonymous' : 'local-display-allowed', droppedCounts: _clone(currentSession.history.droppedCounts) },
        };
        let encoded = JSON.stringify(data);
        while (encoded.length > MAX_SNAPSHOT_BYTES && data.history.stoppedSessions.length) {
            data.history.stoppedSessions.shift();
            data.redaction.trimmedForBudget = true;
            encoded = JSON.stringify(data);
        }
        while (encoded.length > MAX_SNAPSHOT_BYTES && data.history.current.recentOutcomes.length) {
            data.history.current.recentOutcomes.shift();
            data.history.current.droppedCounts.outcomes += 1;
            data.redaction.trimmedForBudget = true;
            encoded = JSON.stringify(data);
        }
        while (encoded.length > MAX_SNAPSHOT_BYTES && data.history.current.lifecycleEvents.length) {
            data.history.current.lifecycleEvents.shift();
            data.history.current.droppedCounts.events += 1;
            data.redaction.trimmedForBudget = true;
            encoded = JSON.stringify(data);
        }
        // Budget trimming above bumps history.current.droppedCounts; mirror the
        // final tally into redaction.droppedCounts so the summary matches the
        // history actually returned (it was cloned pre-trim).
        data.redaction.droppedCounts = _clone(data.history.current.droppedCounts);
        return _safeValue(data, 0, exportMode);
    }

    function _flushDiagnostics() {
        const diagnostics = window.feedBack && window.feedBack.diagnostics;
        if (diagnostics && typeof diagnostics.contribute === 'function') {
            try { diagnostics.contribute('playback', snapshot({ exportMode: 'exported' })); }
            catch (_) { /* diagnostics must never break playback */ }
        }
        try { window.dispatchEvent(new CustomEvent('feedBack:playback:changed', { detail: { timestamp: _now() } })); }
        catch (_) { /* support UI refresh is best effort */ }
    }

    // Coalesce contributions to once per microtask: a single command often
    // touches state and records an outcome (each calls _touch -> here), and the
    // snapshot()/UI-refresh work should run once for that logical action, not
    // per mutation. Still flushes within the same tick, so freshness is kept.
    let _contributeScheduled = false;
    function _contributeDiagnostics() {
        if (_contributeScheduled) return;
        _contributeScheduled = true;
        Promise.resolve().then(() => {
            _contributeScheduled = false;
            _flushDiagnostics();
        });
    }

    function _handled(command, status, payload = {}) {
        return { outcome: 'handled', status: status || 'handled', payload };
    }

    function _outcome(command, outcome, status, reason, payload = {}) {
        const normalized = OUTCOMES.has(outcome) ? outcome : 'failed';
        _recordOutcome(command, normalized, { status, reason, ...payload });
        return { outcome: normalized, status: status || normalized, reason: _boundedReason(reason), payload };
    }

    // dispatch() runs command handlers concurrently with no per-capability
    // lock, so any handler that awaits the transport adapter must re-check that
    // the session it started with is still current before mutating state — a
    // newer start/stop may have replaced it mid-await.
    function _supersededOutcome(command, session, requesterId, extra = {}) {
        return _outcome(command, 'stale', 'stale', `Playback session was superseded during ${command}`, { requesterId, sessionId: session.sessionId, ...extra });
    }

    function _commandArgs(ctx) {
        const payload = { ..._plainObject(ctx && ctx.payload) };
        if (ctx && ctx.requester) payload.requesterId = ctx.requester;
        return payload;
    }

    function _inspect(ctx) {
        const args = _commandArgs(ctx);
        // Don't force kind here — _commandArgs always injects the authenticated
        // requesterId, so hard-coding 'plugin' misclassifies core.* callers.
        // Omit kind and let _normalizeParticipant derive it from the id.
        registerRequester({ requesterId: args.requesterId || 'inspect', authorization: 'none' });
        _mergeTransportSnapshot(_snapshotTransport());
        _recordOutcome('inspect', 'handled', { status: currentSession.state, requesterId: args.requesterId || ctx.requester });
        return _handled('inspect', currentSession.state === 'idle' ? 'idle' : currentSession.transport.readiness, snapshot({ exportMode: args.includeLocalDisplay ? 'local-inspector' : 'exported' }));
    }

    async function _start(ctx) {
        const args = _commandArgs(ctx);
        const requesterId = _requesterId(args.requesterId || ctx.requester || 'core.player.controls');
        // Don't take kind from the raw payload: a control command must not let
        // a plugin label itself 'core' in diagnostics (anti-spoofing — payload
        // identity is for the explicit register-requester command only). Omit
        // kind so _normalizeParticipant derives it from the authenticated
        // requesterId ('core.*' -> 'core', otherwise 'plugin').
        registerRequester({ requesterId, priority: _priority(args), authorization: args.authorization || 'none', lastActionAt: _now() });
        if (!args.target || typeof args.target !== 'object') {
            // A missing target is a malformed request, not an unavailable route;
            // return the no-target outcome without emitting an 'unavailable'
            // lifecycle event that would mislead observers/diagnostics.
            return _outcome('start', 'no-target', 'no-target', 'No playback target supplied', { requesterId });
        }
        // Any terminal state (idle/ended/stopped/unavailable/failed) means no
        // active session, so starting again is fresh audible playback and needs
        // a user action — not just idle/stopped/ended.
        const freshStart = !currentSession.target || TERMINAL_STATES.has(currentSession.state);
        const target = _normalizeTarget(args.target, { requesterId, arrangement: args.arrangement });
        // A fresh start OR switching to a different target is audible playback
        // initiation and requires an explicit user action; plugins may only
        // drive an already-active session for its current target without one.
        const targetChange = !freshStart && currentSession.target && currentSession.target.targetId !== target.targetId;
        if ((freshStart || targetChange) && args.authorization !== 'user-action') {
            return _outcome('start', 'user-action-required', 'user-action-required', 'Fresh audible playback or switching target requires explicit user action', { requesterId });
        }
        if (currentSession.target && ACTIVE_STATES.has(currentSession.state)) {
            _emitPlayback('superseded', { requesterId, previousSessionId: currentSession.sessionId });
            _recordOutcome('start', 'stale', { status: 'superseded', requesterId, sessionId: currentSession.sessionId });
            _finalizeStoppedSession();
        }
        commandSequence += 1;
        if (_priority(args) === 'user') lastUserAction = { command: 'start', sequence: commandSequence, requesterId, createdAt: _now() };
        currentSession = _newSession(target, { ...args, requesterId });
        const session = currentSession;
        _emitPlayback('requested', { requesterId, command: 'start' });
        _emitPlayback('loading', { requesterId });
        if (transportAdapter && typeof transportAdapter.start === 'function') {
            try {
                const result = await _driveAdapter(() => transportAdapter.start({ ...args, target: args.target, normalizedTarget: target, requesterId }));
                if (currentSession !== session) return _supersededOutcome('start', session, requesterId);
                _mergeTransportSnapshot(result);
            } catch (err) {
                if (currentSession !== session) return _supersededOutcome('start', session, requesterId);
                _setState('failed', { requesterId, reason: err && err.message ? err.message : String(err) });
                _emitPlayback('failed', { requesterId, reason: currentSession.transport.reason });
                return _outcome('start', 'failed', 'failed', currentSession.transport.reason, { requesterId });
            }
        } else {
            // No transport adapter is wired up, so nothing can actually start.
            // Report the route as unavailable instead of falsely transitioning
            // to ready/playing and emitting a success lifecycle event.
            const reason = 'No playback transport adapter is registered';
            _setState('unavailable', { requesterId, readiness: 'unavailable', reason });
            _emitPlayback('unavailable', { requesterId, reason });
            return _outcome('start', 'unavailable', 'unavailable', reason, { requesterId });
        }
        const nextState = currentSession.state === 'loading'
            ? (currentSession.transport.isPlaying ? 'playing' : 'ready')
            : currentSession.state;
        _setState(nextState, { requesterId, readiness: 'ready' });
        _recordOutcome('start', 'handled', { status: currentSession.state, requesterId });
        _emitPlayback(nextState === 'playing' ? 'started' : 'ready', { requesterId });
        return _handled('start', currentSession.state, snapshot({ exportMode: 'exported' }));
    }

    function _denyIfStale(command, args) {
        if (!_targetMatches(args)) return _outcome(command, 'stale', 'stale', 'Command targeted a stale playback session', { requesterId: args.requesterId, sessionId: _safeInternalId(args.sessionId, 'playback', currentSession.sessionId) });
        return null;
    }

    function _denyIfNoTarget(command, args) {
        if (!_hasActiveSession() && command !== 'stop') return _outcome(command, 'no-target', 'no-target', 'No active playback session', { requesterId: args.requesterId });
        if (!currentSession.target && command === 'stop') return _outcome(command, 'no-target', 'no-target', 'No active playback session', { requesterId: args.requesterId });
        return null;
    }

    function _userPriorityBlocks(command, args) {
        if (_priority(args) === 'user') return null;
        if (!lastUserAction) return null;
        if (lastUserAction.command === 'pause' && command === 'resume') return _outcome(command, 'denied', 'denied', 'User-priority pause overrides normal resume', { requesterId: args.requesterId });
        if (lastUserAction.command === 'stop' && command !== 'inspect') return _outcome(command, 'denied', 'denied', 'User-priority stop overrides normal playback request', { requesterId: args.requesterId });
        return null;
    }

    async function _pause(ctx) {
        const args = _commandArgs(ctx);
        const requesterId = _requesterId(args.requesterId || ctx.requester || 'unknown');
        const stale = _denyIfStale('pause', args); if (stale) return stale;
        const missing = _denyIfNoTarget('pause', args); if (missing) return missing;
        commandSequence += 1;
        if (_priority(args) === 'user') lastUserAction = { command: 'pause', sequence: commandSequence, requesterId, createdAt: _now() };
        // A stopped (terminal) session is already rejected as 'no-target' by
        // _denyIfNoTarget above, so no separate 'already stopped' branch here.
        const session = currentSession;
        try { if (transportAdapter && typeof transportAdapter.pause === 'function') await _driveAdapter(() => transportAdapter.pause({ requesterId })); }
        catch (err) {
            if (currentSession !== session) return _supersededOutcome('pause', session, requesterId);
            return _outcome('pause', 'failed', 'failed', err && err.message ? err.message : String(err), { requesterId });
        }
        if (currentSession !== session) return _supersededOutcome('pause', session, requesterId);
        _setState('paused', { requesterId, priority: _priority(args) });
        _recordOutcome('pause', 'handled', { status: 'paused', requesterId });
        _emitPlayback('paused', { requesterId });
        return _handled('pause', 'paused', snapshot({ exportMode: 'exported' }));
    }

    async function _resume(ctx) {
        const args = _commandArgs(ctx);
        const requesterId = _requesterId(args.requesterId || ctx.requester || 'unknown');
        const stale = _denyIfStale('resume', args); if (stale) return stale;
        const missing = _denyIfNoTarget('resume', args); if (missing) return missing;
        const blocked = _userPriorityBlocks('resume', { ...args, requesterId }); if (blocked) return blocked;
        // A user-priority resume is itself a user action that lifts a prior
        // user-pause override — record it so it stops blocking later
        // normal-priority resumes (the block keys off lastUserAction.command).
        if (_priority(args) === 'user') { commandSequence += 1; lastUserAction = { command: 'resume', sequence: commandSequence, requesterId, createdAt: _now() }; }
        const session = currentSession;
        try {
            if (transportAdapter && typeof transportAdapter.resume === 'function') {
                const result = await _driveAdapter(() => transportAdapter.resume({ requesterId }));
                if (currentSession !== session) return _supersededOutcome('resume', session, requesterId);
                if (result && result.unavailable) return _outcome('resume', 'unavailable', 'unavailable', result.reason || 'Media route cannot resume', { requesterId });
            }
        } catch (err) {
            if (currentSession !== session) return _supersededOutcome('resume', session, requesterId);
            return _outcome('resume', 'failed', 'failed', err && err.message ? err.message : String(err), { requesterId });
        }
        if (currentSession !== session) return _supersededOutcome('resume', session, requesterId);
        _setState('playing', { requesterId, priority: _priority(args) });
        _recordOutcome('resume', 'handled', { status: 'playing', requesterId });
        // Emit only 'resumed' (not 'started'): observers must be able to tell a
        // resume from a fresh start, and a double signal can fire startup logic
        // twice. Fresh playback emits 'started' from _start.
        _emitPlayback('resumed', { requesterId });
        return _handled('resume', 'playing', snapshot({ exportMode: 'exported' }));
    }

    async function _stop(ctx) {
        const args = _commandArgs(ctx);
        const requesterId = _requesterId(args.requesterId || ctx.requester || 'unknown');
        const stale = _denyIfStale('stop', args); if (stale) return stale;
        if (!currentSession.target) return _outcome('stop', 'no-target', 'no-target', 'No active playback session', { requesterId });
        // Idempotent: an already-stopped session must not re-hit the transport
        // adapter (whose stop() re-emits song:stop) or re-archive the session.
        if (currentSession.state === 'stopped') return _outcome('stop', 'stopped', 'stopped', 'Playback is already stopped', { requesterId });
        commandSequence += 1;
        if (_priority(args) === 'user') lastUserAction = { command: 'stop', sequence: commandSequence, requesterId, createdAt: _now() };
        let failedReason = '';
        const session = currentSession;
        try { if (transportAdapter && typeof transportAdapter.stop === 'function') await _driveAdapter(() => transportAdapter.stop({ requesterId, reason: args.reason })); }
        catch (err) { failedReason = err && err.message ? err.message : String(err); }
        if (currentSession !== session) return _supersededOutcome('stop', session, requesterId);
        // One bounded reason, used verbatim across state, event, outcome, and
        // the returned value (failure reason takes precedence, else the
        // caller's). Bounding up front keeps all four literally identical.
        const reason = _boundedReason(failedReason || args.reason);
        _setState('stopped', { requesterId, priority: _priority(args), reason });
        _recordOutcome('stop', failedReason ? 'failed' : 'stopped', { status: 'stopped', requesterId, reason });
        _emitPlayback('stopped', { requesterId, reason });
        _finalizeStoppedSession();
        return { outcome: failedReason ? 'failed' : 'stopped', status: 'stopped', reason, payload: snapshot({ exportMode: 'exported' }) };
    }

    async function _seek(ctx) {
        const args = _commandArgs(ctx);
        const requesterId = _requesterId(args.requesterId || ctx.requester || 'unknown');
        const stale = _denyIfStale('seek', args); if (stale) return stale;
        const missing = _denyIfNoTarget('seek', args); if (missing) return missing;
        const requestedTime = _number(args.time, null);
        if (requestedTime == null) return _outcome('seek', 'failed', 'failed', 'Seek target must be finite', { requesterId });
        const fromTime = currentSession.media.currentTime;
        const wasPlaying = currentSession.transport.isPlaying;
        if (!transportAdapter || typeof transportAdapter.seek !== 'function') return _outcome('seek', 'unsupported-command', 'unsupported-command', 'Playback route does not support seek', { requesterId, requestedTime, fromTime });
        const session = currentSession;
        _setState('seeking', { requesterId, priority: _priority(args), reason: args.reason });
        _emitPlayback('seeking', { requesterId, requestedTime, fromTime, reason: args.reason });
        let result = null;
        try {
            result = await _driveAdapter(() => transportAdapter.seek({ time: requestedTime, requesterId, reason: args.reason }));
        } catch (err) {
            if (currentSession !== session) return _supersededOutcome('seek', session, requesterId, { requestedTime, fromTime });
            _setState(wasPlaying ? 'playing' : 'paused', { requesterId, reason: 'seek failed' });
            return _outcome('seek', 'failed', 'failed', err && err.message ? err.message : String(err), { requesterId, requestedTime, fromTime });
        }
        if (currentSession !== session) return _supersededOutcome('seek', session, requesterId, { requestedTime, fromTime });
        const completed = result && result.completed !== false;
        const landedTime = _number(result && result.to, _number(result && result.landedTime, null));
        const actualFrom = _number(result && result.from, fromTime);
        if (completed && landedTime == null) {
            _setState(wasPlaying ? 'playing' : 'paused', { requesterId, reason: 'malformed seek result' });
            return _outcome('seek', 'failed', 'failed', 'Playback route returned a malformed seek result', { requesterId, requestedTime, fromTime: actualFrom });
        }
        if (!completed) {
            _setState(wasPlaying ? 'playing' : 'paused', { requesterId, reason: 'seek cancelled' });
            _emitPlayback('seeked', { requesterId, requestedTime, fromTime: actualFrom, landedTime, status: 'cancelled' });
            return _outcome('seek', 'cancelled', 'cancelled', 'Seek cancelled before completion', { requesterId, requestedTime, fromTime: actualFrom, landedTime });
        }
        currentSession.media.currentTime = landedTime;
        currentSession.media.mediaTime = landedTime;
        currentSession.media.chartTime = landedTime;
        currentSession.media.timeUncertainty = 'none';
        const delta = landedTime == null ? 0 : Math.abs(landedTime - requestedTime);
        const status = delta <= 0.05 ? 'completed' : (landedTime === 0 || (currentSession.media.duration != null && Math.abs(landedTime - currentSession.media.duration) <= 0.05) ? 'clamped' : 'rolled-back');
        _setState(wasPlaying ? 'playing' : 'paused', { requesterId });
        _recordOutcome('seek', 'handled', { status, requesterId, requestedTime, fromTime: actualFrom, landedTime, reason: args.reason });
        _emitPlayback('seeked', { requesterId, requestedTime, fromTime: actualFrom, landedTime, status });
        return _handled('seek', status, { requestedTime, fromTime: actualFrom, landedTime, status, snapshot: snapshot({ exportMode: 'exported' }) });
    }

    async function _setLoop(ctx) {
        const args = _commandArgs(ctx);
        const requesterId = _requesterId(args.requesterId || ctx.requester || 'unknown');
        const stale = _denyIfStale('set-loop', args); if (stale) return stale;
        const missing = _denyIfNoTarget('set-loop', args); if (missing) return missing;
        const startTime = _number(args.startTime, null);
        const endTime = _number(args.endTime, null);
        if (startTime == null || endTime == null || endTime <= startTime) {
            _emitPlayback('loop-rejected', { requesterId, reason: 'invalid loop boundaries' });
            return _outcome('set-loop', 'failed', 'rejected', 'Invalid loop boundaries', { requesterId });
        }
        let ok = true;
        const session = currentSession;
        try { if (transportAdapter && typeof transportAdapter.setLoop === 'function') ok = await _driveAdapter(() => transportAdapter.setLoop({ startTime, endTime, requesterId })); }
        catch (err) {
            if (currentSession !== session) return _supersededOutcome('set-loop', session, requesterId);
            _emitPlayback('loop-rejected', { requesterId, reason: err && err.message ? err.message : String(err) });
            return _outcome('set-loop', 'failed', 'failed', err && err.message ? err.message : String(err), { requesterId });
        }
        if (currentSession !== session) return _supersededOutcome('set-loop', session, requesterId);
        if (!ok) {
            _emitPlayback('loop-rejected', { requesterId, reason: 'loop-set seek did not land on target' });
            return _outcome('set-loop', 'cancelled', 'cancelled', 'Loop-set seek did not land on target', { requesterId });
        }
        _updateLoopFromSnapshot({ startTime, endTime, requesterId, state: 'active', enabled: true });
        _recordOutcome('set-loop', 'handled', { status: 'active', requesterId });
        _emitPlayback('loop-set', { requesterId, loop: _clone(currentSession.loop) });
        return _handled('set-loop', 'active', { loop: _clone(currentSession.loop) });
    }

    async function _clearLoop(ctx) {
        const args = _commandArgs(ctx);
        const requesterId = _requesterId(args.requesterId || ctx.requester || 'unknown');
        const stale = _denyIfStale('clear-loop', args); if (stale) return stale;
        const missing = _denyIfNoTarget('clear-loop', args); if (missing) return missing;
        const session = currentSession;
        try { if (transportAdapter && typeof transportAdapter.clearLoop === 'function') await _driveAdapter(() => transportAdapter.clearLoop({ requesterId })); }
        catch (err) {
            if (currentSession !== session) return _supersededOutcome('clear-loop', session, requesterId);
            return _outcome('clear-loop', 'failed', 'failed', err && err.message ? err.message : String(err), { requesterId });
        }
        if (currentSession !== session) return _supersededOutcome('clear-loop', session, requesterId);
        currentSession.loop = _inactiveLoop('cleared');
        currentSession.media.loop = _clone(currentSession.loop);
        _recordOutcome('clear-loop', 'handled', { status: 'cleared', requesterId });
        _emitPlayback('loop-cleared', { requesterId });
        return _handled('clear-loop', 'cleared', { loop: _clone(currentSession.loop) });
    }

    function _registerRequesterCommand(ctx) {
        const args = _plainObject(ctx && ctx.payload);
        const requester = registerRequester(args);
        _recordOutcome('register-requester', 'handled', { status: 'registered', requesterId: requester.requesterId });
        return _handled('register-requester', 'registered', { requester });
    }

    function _registerObserverCommand(ctx) {
        const args = _plainObject(ctx && ctx.payload);
        const observer = registerObserver(args);
        _recordOutcome('register-observer', 'handled', { status: 'registered', requesterId: observer.observerId });
        return _handled('register-observer', 'registered', { observer });
    }

    function registerTransportAdapter(adapter) {
        transportAdapter = adapter && typeof adapter === 'object' ? adapter : null;
        _mergeTransportSnapshot(_snapshotTransport());
        _contributeDiagnostics();
        return true;
    }

    function transportEvent(event, payload = {}) {
        const name = _eventName(event);
        const source = _plainObject(payload);
        if (source.target) {
            const target = _normalizeTarget(source.target, source);
            if (!currentSession.target || source.newSession === true || currentSession.state === 'idle' || currentSession.state === 'stopped' || currentSession.state === 'ended') {
                currentSession = _newSession(target, source);
            } else {
                currentSession.target = target;
            }
        }
        const hasSnapshot = source.media || source.currentTime != null || source.duration != null || source.route || source.loop;
        if (hasSnapshot && name !== 'seeked' && name !== 'seeking') _mergeTransportSnapshot(source.media || source);
        if (name === 'loading') _setState('loading', { requesterId: source.requesterId, readiness: 'loading' });
        else if (name === 'ready') _setState(currentSession.transport.isPlaying ? 'playing' : 'ready', { requesterId: source.requesterId, readiness: 'ready' });
        else if (name === 'started' || name === 'resumed') _setState('playing', { requesterId: source.requesterId, readiness: 'ready' });
        else if (name === 'paused') _setState('paused', { requesterId: source.requesterId, readiness: 'ready' });
        else if (name === 'ended') _setState('ended', { requesterId: source.requesterId, readiness: 'ready' });
        else if (name === 'stopped') { _setState('stopped', { requesterId: source.requesterId, reason: source.reason }); _finalizeStoppedSession(); }
        else if (name === 'unavailable') _setState('unavailable', { requesterId: source.requesterId, readiness: 'unavailable', reason: source.reason });
        else if (name === 'failed') _setState('failed', { requesterId: source.requesterId, readiness: 'failed', reason: source.reason });
        else if (name === 'degraded') _setState('degraded', { requesterId: source.requesterId, readiness: 'ready', reason: source.reason });
        else if (name === 'seeking') {
            pendingSeekWasPlaying = _payloadIsPlaying(source, currentSession.transport.isPlaying);
            if (hasSnapshot) _mergeTransportSnapshot(source.media || source);
            _setState('seeking', { requesterId: source.requesterId, readiness: 'ready', reason: source.reason });
        } else if (name === 'seeked') {
            const wasPlaying = pendingSeekWasPlaying == null ? currentSession.transport.isPlaying : pendingSeekWasPlaying;
            if (hasSnapshot) _mergeTransportSnapshot(source.media || source);
            const shouldPlay = _payloadIsPlaying(source, wasPlaying);
            pendingSeekWasPlaying = null;
            _setState(shouldPlay ? 'playing' : 'paused', { requesterId: source.requesterId, readiness: 'ready', reason: source.reason });
        }
        else if (name === 'loop-restarted') {
            if (currentSession.loop) currentSession.loop.lastRestartAt = _now();
        } else if (name === 'loop-stale') {
            if (currentSession.loop) currentSession.loop.state = 'stale';
        }
        if (name === 'route-changing') _updateRoute({ ...source, state: 'switching' });
        if (name === 'route-changed') _updateRoute(source);
        _emitPlayback(name, source);
        // Record failure-shaped lifecycle events (failed/unavailable/degraded/
        // stopped) under their own outcome rather than 'handled', so diagnostics
        // history matches the actual transition.
        _recordOutcome(name, OUTCOMES.has(name) ? name : 'handled', { status: currentSession.state, requesterId: source.requesterId, reason: source.reason });
        return snapshot({ exportMode: 'exported' });
    }

    function recordRouteChange(route) {
        const source = _plainObject(route);
        _updateRoute(source);
        const name = source.state === 'switching' || source.phase === 'changing' ? 'route-changing' : 'route-changed';
        _emitPlayback(name, source);
        if (source.state === 'degraded' || source.degraded) {
            _setState('degraded', { requesterId: source.requesterId || 'core.player.route', reason: source.safeReason || source.reason });
            _emitPlayback('degraded', source);
            _recordOutcome('route-change', 'degraded', { status: 'degraded', requesterId: source.requesterId || 'core.player.route', reason: source.safeReason || source.reason });
        } else {
            _recordOutcome('route-change', 'handled', { status: source.state || 'active', requesterId: source.requesterId || 'core.player.route', reason: source.safeReason || source.reason });
        }
        return _clone(currentSession.route);
    }

    function _installLegacyEventBridge() {
        if (!window.feedBack || typeof window.feedBack.on !== 'function') return;
        const map = {
            'song:loading': 'loading',
            'song:loaded': 'ready',
            'song:ready': 'ready',
            'song:play': 'started',
            'song:resume': 'resumed',
            'song:pause': 'paused',
            'song:seek': 'seeked',
            'song:ended': 'ended',
            'song:stop': 'stopped',
            'loop:restart': 'loop-restarted',
        };
        for (const [legacy, playbackEvent] of Object.entries(map)) {
            window.feedBack.on(legacy, event => {
                // Skip echoes of our own command: while a command handler is
                // driving the transport adapter, the song:* events it produces
                // are not genuine legacy-surface usage and would duplicate the
                // command's own playback:* events (and re-archive on stop).
                if (commandAdapterDepth > 0) return;
                const detail = _plainObject(event && event.detail);
                recordBridgeHit({ bridgeId: 'playback.song-events', legacySurface: legacy, source: detail.requesterId || 'legacy-event-bus', reason: 'legacy song event observed' });
                if (legacy === 'song:loading') {
                    transportEvent('loading', { target: { filename: detail.filename, arrangement: detail.arrangement, sourceKind: 'local' }, requesterId: 'core.player.controls', newSession: true });
                    return;
                }
                if (legacy === 'song:loaded') {
                    transportEvent('ready', { target: detail, media: { duration: detail.duration, readiness: 'ready' }, requesterId: 'core.highway' });
                    return;
                }
                if (legacy === 'song:seek') {
                    transportEvent('seeked', { fromTime: detail.from, landedTime: detail.to, currentTime: detail.to, mediaTime: detail.to, chartTime: detail.to, reason: detail.reason, requesterId: 'legacy-event-bus' });
                    return;
                }
                if (legacy === 'loop:restart') {
                    transportEvent('loop-restarted', { loopA: detail.loopA, loopB: detail.loopB, currentTime: detail.time, requesterId: 'core.loop' });
                    return;
                }
                transportEvent(playbackEvent, { ...detail, requesterId: detail.requesterId || 'legacy-event-bus' });
            });
        }
    }

    capabilities.registerOwner('playback', {
        pluginId: OWNER_ID,
        commands: COMMANDS,
        events: EVENT_NAMES,
        kind: 'command',
        compatibility: 'shim-allowed',
        ownership: 'exclusive-owner',
        safety: 'safe',
        description: 'Authoritative redaction-safe playback transport, timing, loop, route, requester, bridge, and diagnostics surface.',
        handlers: {
            inspect: _inspect,
            start: _start,
            pause: _pause,
            resume: _resume,
            stop: _stop,
            seek: _seek,
            'set-loop': _setLoop,
            'clear-loop': _clearLoop,
            'register-requester': _registerRequesterCommand,
            'register-observer': _registerObserverCommand,
        },
    });

    const api = {
        version: 1,
        registerTransportAdapter,
        registerRequester,
        registerObserver,
        recordBridgeHit,
        recordRouteChange,
        transportEvent,
        snapshot,
        getDiagnostics: snapshot,
        inspect: () => snapshot({ exportMode: 'exported' }),
    };

    window.feedBack.playback = api;
    _installLegacyEventBridge();
    _contributeDiagnostics();
})();
