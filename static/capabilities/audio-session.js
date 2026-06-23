// Core audio graph/session capability domain host.
(function () {
    'use strict';

    window.feedBack = window.feedBack || {};
    const capabilities = window.feedBack.capabilities;
    if (!capabilities || capabilities.version !== 1) return;
    if (window.feedBack.audioSession && window.feedBack.audioSession.version === 1) return;

    const SCHEMA = 'feedBack.audio_session.diagnostics.v1';
    const DOMAINS = Object.freeze(['audio-mix', 'audio-input', 'audio-monitoring', 'stems']);
    const MAX_OUTCOMES = 100;
    const MAX_DOMAIN_ITEMS = 50;
    const FADER_OPERATION_TIMEOUT_MS = 2000;
    const INPUT_OPERATION_TIMEOUT_MS = 2000;
    const MONITORING_OPERATION_TIMEOUT_MS = 2000;
    const SELECTED_INPUT_STORAGE_KEY = 'feedBack.audioInput.selectedLogicalSourceKey';
    const SELECTED_MONITORING_PROVIDER_STORAGE_KEY = 'feedBack.audioMonitoring.selectedLogicalMonitoringKey';
    const DIRECT_MONITOR_STORAGE_KEY = 'feedBack.audioMonitoring.directMonitorPreference';
    const OWNER_ID = 'core.audio.session';
    const REQUIRED_MIX_KINDS = Object.freeze(['song', 'plugin', 'stem', 'monitoring', 'preview']);
    const MIX_KINDS = new Set([...REQUIRED_MIX_KINDS, 'analyser', 'other']);
    const AVAILABILITY = new Set(['available', 'pending', 'unavailable', 'disabled', 'denied', 'failed', 'incompatible', 'unknown']);
    const SOURCE_MODES = new Set(['native', 'compatibility', 'core']);
    const INPUT_KINDS = new Set(['instrument', 'microphone', 'desktop', 'plugin', 'virtual', 'unknown']);
    const CHANNEL_SHAPES = new Set(['mono', 'stereo', 'multi', 'unknown']);
    const MONITORING_STATES = new Set(['active', 'degraded', 'stopped', 'unavailable', 'denied', 'failed', 'orphaned', 'unknown']);
    const MONITORING_OUTCOMES = new Set(['handled', 'denied', 'degraded', 'failed', 'no-owner', 'no-handler', 'unsupported-command', 'incompatible', 'incompatible-version', 'unavailable', 'provider-selection-required', 'user-action-required', 'stopped', 'overridden']);
    // Outcomes accepted from audio-mix / audio-input provider handlers. Deliberately excludes the
    // monitoring-only outcomes (provider-selection-required, user-action-required, stopped, unavailable)
    // so a mix/input provider can't leak a monitoring-specific terminal outcome into generic dispatch.
    const PROVIDER_OUTCOMES = new Set(['handled', 'denied', 'degraded', 'failed', 'no-owner', 'no-handler', 'unsupported-command', 'incompatible', 'incompatible-version', 'overridden']);
    const AUTHORIZATION_MODES = new Set(['user-action', 'attach-existing', 'background']);
    const DIRECT_MONITOR_STATES = new Set(['muted', 'unmuted', 'unsupported', 'unavailable', 'unknown']);
    const DIRECT_MONITOR_CONTROLS = new Set(['supported', 'unsupported', 'unavailable', 'unknown']);
    // Matched against a normalized key (camelCase split to snake_case, lowercased — see _safeInputValue)
    // so concatenated names like streamHandle / rawDeviceId / nativeHandleRef are caught, not just
    // underscore/exact-token forms.
    const LIVE_HANDLE_KEYS = /(^|_)(stream|mediastream|audionode|node|nativehandle|handle|buffer|buffers|sample|samples|waveform|rawlabel|label|device|deviceid|hardware|hardwareid|path|secret|token|password|api|apikey)(_|$)/;
    // Explicitly redaction-safe label keys (normalized snake_case form) that bypass LIVE_HANDLE_KEYS
    // so a provider can pass a safe display label through enumerate/_safeInputValue to _safeInputLabel.
    const SAFE_INPUT_LABEL_KEYS = new Set(['safe_label', 'display_label', 'label_pseudonym', 'label_safe']);

    let sequence = 0;
    const knownMixParticipants = new Map();
    const knownInputSources = new Map();
    const knownInputProviders = new Map();
    const knownMonitoringProviders = new Map();
    let currentSession = _newSession({});

    function _now() { return new Date().toISOString(); }

    function _id(prefix) {
        sequence += 1;
        return `${prefix}-${sequence}`;
    }

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

    function _strings(value) {
        return Array.isArray(value) ? value.map(item => _string(item)).filter(Boolean) : [];
    }

    function _plainObject(value) {
        return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
    }

    function _availability(value, fallback = 'available') {
        const normalized = _string(value, fallback);
        return AVAILABILITY.has(normalized) ? normalized : fallback;
    }

    function _mixKind(value) {
        const normalized = _string(value, 'other');
        return MIX_KINDS.has(normalized) ? normalized : 'other';
    }

    function _sourceMode(value, fallback = 'native') {
        const normalized = _string(value, fallback);
        return SOURCE_MODES.has(normalized) ? normalized : fallback;
    }

    function _inputKind(value) {
        const normalized = _string(value, 'unknown');
        return INPUT_KINDS.has(normalized) ? normalized : 'unknown';
    }

    function _channelShape(value, fallback = 'unknown') {
        const normalized = _string(value, fallback);
        return CHANNEL_SHAPES.has(normalized) ? normalized : fallback;
    }

    function _requesterId(value, fallback = 'unknown') {
        // Capability dispatch does not validate `source`, so redact paths/tokens (via _boundedReason)
        // before stripping to the id charset — otherwise fragments of a path/token in a malicious or
        // buggy requester id would survive into redaction-safe diagnostics.
        return _boundedReason(value).replace(/[^A-Za-z0-9_.:-]+/g, '-').slice(0, 80) || fallback;
    }

    function _redactString(value) {
        // Redact absolute paths (macOS, Linux/Docker home & root, Windows). Spaces
        // are allowed because song files/paths routinely contain them, but matching
        // stops at line breaks, tabs, and structural delimiters so unrelated trailing
        // diagnostic text on the same line is preserved rather than over-redacted.
        const tail = `[^\\r\\n\\t"'\`,;(){}\\[\\]<>|]*`;
        const path = new RegExp(`(?:/Users/|/home/|/root\\b/?|[A-Za-z]:\\\\)${tail}`, 'g');
        return _string(value)
            .replace(path, '[path]')
            .replace(/\b(raw[-_ ]?audio|audio[-_ ]?buffer|sample[s]?|waveform[s]?|recording[s]?)\b/gi, '[audio-data]')
            .replace(/\b(token|secret|password|api[_-]?key)=([^\s&]+)/gi, '$1=[redacted]');
    }

    function _boundedReason(value) {
        return _redactString(value).replace(/\s+/g, ' ').slice(0, 240);
    }

    function _storageStatus() {
        try {
            if (!window.localStorage || typeof window.localStorage.getItem !== 'function') return 'unavailable';
            window.localStorage.getItem(SELECTED_INPUT_STORAGE_KEY);
            return 'available';
        } catch (_) {
            return 'failed';
        }
    }

    function _readStorage(key) {
        try {
            if (!window.localStorage || typeof window.localStorage.getItem !== 'function') return '';
            const stored = _string(window.localStorage.getItem(key));
            // localStorage is untrusted/mutable: ignore (and clear) a persisted key that isn't already
            // redaction-safe, so an injected path/token can't be restored into selected logical keys.
            if (stored && key !== DIRECT_MONITOR_STORAGE_KEY && _boundedReason(stored) !== stored) {
                try { window.localStorage.removeItem(key); } catch (_) { /* best effort */ }
                return '';
            }
            return stored;
        } catch (_) {
            return '';
        }
    }

    function _writeStorage(key, value) {
        try {
            if (!window.localStorage || typeof window.localStorage.setItem !== 'function') return 'unavailable';
            window.localStorage.setItem(key, _string(value));
            return 'available';
        } catch (_) {
            return 'failed';
        }
    }

    function _readSelectedLogicalSourceKey() {
        return _readStorage(SELECTED_INPUT_STORAGE_KEY);
    }

    function _writeSelectedLogicalSourceKey(logicalSourceKey) {
        return _writeStorage(SELECTED_INPUT_STORAGE_KEY, logicalSourceKey);
    }

    function _readSelectedLogicalMonitoringKey() {
        return _readStorage(SELECTED_MONITORING_PROVIDER_STORAGE_KEY);
    }

    function _writeSelectedLogicalMonitoringKey(logicalMonitoringKey) {
        return _writeStorage(SELECTED_MONITORING_PROVIDER_STORAGE_KEY, logicalMonitoringKey);
    }

    function _readDirectMonitorPreference() {
        const stored = _readStorage(DIRECT_MONITOR_STORAGE_KEY);
        return stored === 'muted' || stored === 'unmuted' ? stored : 'muted';
    }

    function _writeDirectMonitorPreference(state) {
        return _writeStorage(DIRECT_MONITOR_STORAGE_KEY, state === 'unmuted' ? 'unmuted' : 'muted');
    }

    function _storedSelectedInput() {
        const logicalSourceKey = _readSelectedLogicalSourceKey();
        if (!logicalSourceKey) return null;
        return {
            logicalSourceKey,
            sourceId: '',
            providerId: '',
            availability: 'unavailable',
            restored: true,
            restoreStatus: 'missing-provider',
            selectedAt: '',
            lastSelectedAt: '',
            lastRestoredAt: _now(),
        };
    }

    function _storedSelectedMonitoringProvider() {
        const logicalMonitoringKey = _readSelectedLogicalMonitoringKey();
        if (!logicalMonitoringKey) return null;
        return {
            providerId: '',
            logicalMonitoringKey,
            availability: 'unavailable',
            restored: true,
            restoreStatus: 'missing-provider',
            selectedAt: '',
            lastSelectedAt: '',
            lastRestoredAt: _now(),
            requesterId: 'storage',
        };
    }

    function _storedDirectMonitorPreference() {
        return {
            state: _readDirectMonitorPreference(),
            control: 'unknown',
            preference: _readDirectMonitorPreference(),
            applied: false,
            reason: '',
            lastChangedAt: '',
        };
    }

    function _clone(value) {
        if (value == null || typeof value !== 'object') return value;
        try { return JSON.parse(JSON.stringify(value)); }
        catch (_) { return null; }
    }

    function _safeInputValue(value, depth = 0, seen = null) {
        if (typeof value === 'string') return _boundedReason(value);
        if (value == null || typeof value === 'number' || typeof value === 'boolean') return value;
        if (depth > 6) return '[truncated]';
        if (typeof value === 'object') {
            const refs = seen || new WeakSet();
            if (refs.has(value)) return '[circular]';
            refs.add(value);
            if (Array.isArray(value)) return value.slice(0, 20).map(item => _safeInputValue(item, depth + 1, refs));
            const out = {};
            for (const [key, item] of Object.entries(value).slice(0, 30)) {
                // Normalize camelCase to snake_case so concatenated keys (streamHandle, rawDeviceId,
                // nativeHandleRef) are caught by the segment-delimited LIVE_HANDLE_KEYS pattern.
                const normalizedKey = _string(key).replace(/([a-z0-9])([A-Z])/g, '$1_$2').replace(/([A-Z]+)([A-Z][a-z])/g, '$1_$2').toLowerCase();
                // Explicitly-safe label keys are allowed through (the `label` token would otherwise
                // strip them) so providers can supply a redaction-safe display label via enumerate.
                if (!SAFE_INPUT_LABEL_KEYS.has(normalizedKey) && LIVE_HANDLE_KEYS.test(normalizedKey)) continue;
                if (typeof item === 'function') continue;
                out[key] = _safeInputValue(item, depth + 1, refs);
            }
            return out;
        }
        return '';
    }

    function _safeInputLabel(source, fallback) {
        const explicit = _string(source.safeLabel || source.displayLabel || source.labelPseudonym || source.label || source.name, fallback);
        const redacted = _boundedReason(explicit).slice(0, 80);
        const suspicious = redacted !== explicit || /\b(serial|hardware|device|token|secret|password|api[_-]?key)\b/i.test(redacted) || /\d{4,}/.test(redacted);
        if (suspicious && source.labelSafe !== true && !source.safeLabel && !source.displayLabel && !source.labelPseudonym) return fallback;
        return redacted || fallback;
    }

    function _newSession(options) {
        const source = _plainObject(options);
        return {
            sessionId: _string(source.sessionId, 'main:idle'),
            playerId: _string(source.playerId, 'main'),
            songKey: _string(source.songKey, ''),
            songFormat: _string(source.songFormat, 'unknown'),
            state: _string(source.state, 'idle'),
            routeState: _normalizeRoute(source.routeState || source.route || {}),
            analyserState: _normalizeAnalyser(source.analyserState || source.analyser || {}),
            mixParticipants: new Map(),
            inputProviders: new Map(),
            inputSources: new Map(),
            selectedInput: _storedSelectedInput(),
            openInputSessions: new Map(),
            storageStatus: _storageStatus(),
            monitoringProviders: new Map(),
            selectedMonitoringProvider: _storedSelectedMonitoringProvider(),
            directMonitor: _storedDirectMonitorPreference(),
            monitoringSessions: new Map(),
            stemOwner: null,
            stemClaims: new Map(),
            bridges: new Map(),
            outcomes: [],
            createdAt: _now(),
            updatedAt: _now(),
        };
    }

    function _touch() {
        currentSession.updatedAt = _now();
        _contributeDiagnostics();
    }

    function _normalizeRoute(route) {
        const source = _plainObject(route);
        return {
            routeId: _string(source.routeId || source.id, 'route:unknown'),
            routeKind: _string(source.routeKind || source.kind, 'unknown'),
            availability: _string(source.availability, 'unknown'),
            selectedByUser: source.selectedByUser === true,
            devicePseudonym: _string(source.devicePseudonym || source.deviceId || source.deviceLabel, ''),
            fallbackReason: _boundedReason(source.fallbackReason || source.reason),
            lastChangedAt: _string(source.lastChangedAt, _now()),
        };
    }

    function _normalizeAnalyser(analyser) {
        const source = _plainObject(analyser);
        return {
            source: _string(source.source, 'unavailable'),
            availability: _string(source.availability, 'unavailable'),
            participantId: _string(source.participantId || source.providerId, ''),
            reason: _boundedReason(source.reason),
            lastChangedAt: _string(source.lastChangedAt, _now()),
        };
    }

    function _normalizeFader(fader) {
        const source = _plainObject(fader);
        if (!Object.keys(source).length) return null;
        const min = _number(source.min, 0);
        const max = _number(source.max, 1);
        const step = _number(source.step, 0.01);
        const defaultValue = _clamp(_number(source.defaultValue, min), min, max > min ? max : min + 1);
        const currentValue = _number(source.currentValue, _number(source.value, defaultValue));
        return {
            id: _string(source.faderId || source.id, 'main'),
            label: _string(source.label, 'Volume'),
            unit: _string(source.unit, ''),
            min,
            max: max > min ? max : min + 1,
            step: step > 0 ? step : 0.01,
            defaultValue,
            currentValue: _clamp(currentValue, min, max > min ? max : min + 1),
            lastRequestedValue: _number(source.lastRequestedValue, null),
            lastRejectedValue: _number(source.lastRejectedValue, null),
            userAdjustable: source.userAdjustable !== false && source.readOnly !== true,
            availability: _availability(source.availability, 'available'),
            lastCommittedAt: _string(source.lastCommittedAt, ''),
        };
    }

    function _clamp(value, min, max) {
        const numeric = Number(value);
        if (!Number.isFinite(numeric)) return min;
        return Math.min(max, Math.max(min, numeric));
    }

    function _normalizeOperationHandlers(source) {
        const handlers = {};
        const operationHandlers = _plainObject(source.operationHandlers || source.handlers || source.providerOperations);
        for (const [key, value] of Object.entries(operationHandlers)) {
            if (typeof value === 'function') handlers[key] = value;
        }
        if (typeof source.getValue === 'function') handlers['fader.get-value'] = source.getValue;
        if (typeof source.setValue === 'function') handlers['fader.set-value'] = source.setValue;
        const fader = _plainObject(source.fader);
        if (typeof fader.getValue === 'function') handlers['fader.get-value'] = fader.getValue;
        if (typeof fader.setValue === 'function') handlers['fader.set-value'] = fader.setValue;
        return handlers;
    }

    function _logicalFaderKey(participant, source) {
        const explicit = source.logicalFaderKey || source.logicalKey || (source.fader && source.fader.logicalFaderKey);
        if (explicit) return _string(explicit);
        const faderId = participant.fader ? participant.fader.id : 'main';
        const owner = participant.ownerPluginId || participant.participantId;
        return `${owner}:${faderId}`;
    }

    function _normalizeParticipant(spec) {
        const source = _plainObject(spec);
        const participantId = _string(source.participantId || source.id);
        if (!participantId) return null;
        const compatibilitySource = _string(source.compatibilitySource || source.legacySurface, '');
        const sourceMode = _sourceMode(source.sourceMode, source.ownerPluginId === 'core' || source.pluginId === 'core' || source.source === 'core' ? 'core' : (compatibilitySource ? 'compatibility' : 'native'));
        return {
            participantId,
            ownerPluginId: _string(source.ownerPluginId || source.pluginId || source.source, 'core'),
            label: _string(source.label || source.name, participantId),
            kind: _mixKind(source.kind),
            fader: _normalizeFader(source.fader),
            operations: _strings(source.operations || source.providerOperations),
            operationHandlers: _normalizeOperationHandlers(source),
            availability: _availability(source.availability, source.disabled ? 'disabled' : (currentSession.state === 'active' ? 'available' : 'pending')),
            sourceMode,
            compatibilitySource,
            supersededBy: _string(source.supersededBy, ''),
            registeredAt: _string(source.registeredAt, _now()),
            lastSeenAt: _now(),
        };
    }

    function _summaryParticipant(participant) {
        const clone = _clone(participant);
        if (clone) delete clone.operationHandlers;
        return clone;
    }

    function _summaryFader(participant, options = {}) {
        if (!participant || !participant.fader) return null;
        const fader = participant.fader;
        const availability = options.availability || _effectiveFaderAvailability(participant);
        return {
            participantId: participant.participantId,
            ownerPluginId: participant.ownerPluginId,
            label: participant.label,
            kind: participant.kind,
            sourceMode: participant.sourceMode,
            compatibilitySource: participant.compatibilitySource,
            supersededBy: participant.supersededBy || '',
            logicalFaderKey: participant.logicalFaderKey,
            faderId: fader.id,
            id: fader.id,
            faderKey: _faderKey(participant.participantId, fader.id),
            faderLabel: fader.label,
            unit: fader.unit,
            min: fader.min,
            max: fader.max,
            step: fader.step,
            defaultValue: fader.defaultValue,
            currentValue: fader.currentValue,
            lastRequestedValue: fader.lastRequestedValue,
            lastRejectedValue: fader.lastRejectedValue,
            userAdjustable: fader.userAdjustable && availability === 'available',
            availability,
            lastCommittedAt: fader.lastCommittedAt,
        };
    }

    function _normalizeSource(spec) {
        const source = _plainObject(spec);
        const sourceId = _string(source.sourceId || source.id);
        const providerId = _string(source.providerId || source.participantId);
        const logicalSourceKey = _string(source.logicalSourceKey || source.logicalKey || source.sourceKey);
        if (!sourceId || !providerId || !logicalSourceKey) return null;
        const channelSummary = _normalizeChannelSummary(source.channelSummary || source.channel || source);
        const now = _now();
        const compatibilitySource = _string(source.compatibilitySource || source.legacySurface, '');
        const sourceMode = _sourceMode(source.sourceMode, compatibilitySource ? 'compatibility' : 'native');
        return {
            sourceId,
            logicalSourceKey,
            providerId,
            ownerPluginId: _string(source.ownerPluginId || source.pluginId || providerId, providerId),
            kind: _inputKind(source.kind),
            label: _safeInputLabel(source, _string(source.diagnosticsPseudonym || source.pseudonym, 'Input source')),
            channelSummary,
            channelCount: channelSummary.channelCount,
            availability: _availability(source.availability, source.disabled ? 'disabled' : 'available'),
            selected: source.selected === true,
            sourceMode,
            compatibilitySource,
            supersededBy: _string(source.supersededBy, ''),
            reason: _boundedReason(source.reason || source.failureReason || source.unavailableReason),
            operations: _strings(source.operations || source.providerOperations),
            diagnosticsPseudonym: _string(source.diagnosticsPseudonym || source.pseudonym || sourceId, sourceId),
            registeredAt: _string(source.registeredAt, now),
            lastSeenAt: now,
            lastChangedAt: _string(source.lastChangedAt, now),
        };
    }

    function _normalizeChannelSummary(value) {
        const source = _plainObject(value);
        const count = _number(source.channelCount ?? source.channels, null);
        const inferred = count === 1 ? 'mono' : (count === 2 ? 'stereo' : (count && count > 2 ? 'multi' : 'unknown'));
        const shape = _channelShape(source.channelShape || source.shape, inferred);
        const supports = _strings(source.supports || source.supportedShapes).map(item => _channelShape(item, '')).filter(Boolean);
        return {
            channelCount: count,
            channelShape: shape,
            supports: supports.length ? Array.from(new Set(supports)) : (shape !== 'unknown' ? [shape] : []),
            defaultShape: _channelShape(source.defaultShape, shape),
            reason: _boundedReason(source.reason),
        };
    }

    function _normalizeInputProvider(source, input) {
        const providerId = input.providerId;
        const existing = currentSession.inputProviders.get(providerId) || knownInputProviders.get(providerId) || {};
        const operationHandlers = { ...(existing.operationHandlers || {}), ..._normalizeOperationHandlers(source) };
        const operations = Array.from(new Set([...(existing.operations || []), ...input.operations, ...Object.keys(operationHandlers)]));
        const provider = {
            providerId,
            ownerPluginId: _string(source.ownerPluginId || source.pluginId || existing.ownerPluginId || input.ownerPluginId, input.ownerPluginId),
            label: _safeInputLabel(source, _string(existing.label || providerId, providerId)),
            sourceMode: input.sourceMode,
            operations,
            operationHandlers,
            availability: _availability(source.providerAvailability || source.availability || existing.availability, 'available'),
            version: _number(source.version || existing.version, 1),
            registeredAt: existing.registeredAt || _now(),
            lastSeenAt: _now(),
        };
        knownInputProviders.set(providerId, provider);
        currentSession.inputProviders.set(providerId, provider);
        return provider;
    }

    function _inputSourcePriority(source) {
        if (source.sourceMode === 'core') return 0;
        if (source.sourceMode === 'native') return 1;
        return 2;
    }

    function _inputSourceAvailabilityRank(source) {
        return source.availability === 'available' ? 0 : (source.availability === 'pending' ? 1 : 2);
    }

    function _sourceRecordKey(source) {
        return `${source.providerId}:${source.sourceMode}:${source.logicalSourceKey}`;
    }

    function _findInputSource(query = {}) {
        const source = _plainObject(query);
        const sourceId = _string(source.sourceId || source.id);
        const providerId = _string(source.providerId);
        const logicalSourceKey = _string(source.logicalSourceKey || source.logicalKey || source.sourceKey);
        if (sourceId && currentSession.inputSources.has(sourceId)) return currentSession.inputSources.get(sourceId);
        let matches = Array.from(currentSession.inputSources.values()).filter(item => item.logicalSourceKey === logicalSourceKey);
        // When a providerId is supplied (e.g. unregister-source), prefer that provider's source so a
        // native + compatibility duplicate sharing one logical key resolves to the intended one.
        if (providerId) {
            const byProvider = matches.filter(item => item.providerId === providerId);
            if (byProvider.length) matches = byProvider;
        }
        if (!matches.length) return null;
        matches.sort((a, b) => _inputSourcePriority(a) - _inputSourcePriority(b) || _inputSourceAvailabilityRank(a) - _inputSourceAvailabilityRank(b) || a.providerId.localeCompare(b.providerId) || a.sourceId.localeCompare(b.sourceId));
        return matches[0];
    }

    function _visibleInputSources() {
        _refreshInputDuplicateSuppression();
        return Array.from(currentSession.inputSources.values())
            .filter(source => !source.supersededBy)
            .sort((a, b) => _inputSourcePriority(a) - _inputSourcePriority(b) || a.label.localeCompare(b.label) || a.providerId.localeCompare(b.providerId));
    }

    function _refreshInputDuplicateSuppression() {
        const groups = new Map();
        for (const source of currentSession.inputSources.values()) {
            source.supersededBy = '';
            const list = groups.get(source.logicalSourceKey) || [];
            list.push(source);
            groups.set(source.logicalSourceKey, list);
        }
        for (const list of groups.values()) {
            if (list.length < 2) continue;
            list.sort((a, b) => _inputSourcePriority(a) - _inputSourcePriority(b) || _inputSourceAvailabilityRank(a) - _inputSourceAvailabilityRank(b) || a.providerId.localeCompare(b.providerId) || a.sourceId.localeCompare(b.sourceId));
            const winner = list[0];
            for (const loser of list.slice(1)) {
                loser.supersededBy = winner.sourceId;
            }
        }
        _syncSelectedInput();
    }

    function _recordInputDuplicateSuppression() {
        for (const source of currentSession.inputSources.values()) {
            if (!source.supersededBy || source.sourceMode !== 'compatibility') continue;
            recordBridgeHit({
                domain: 'audio-input',
                bridgeId: 'audio-input.legacy-source',
                legacySurface: source.compatibilitySource || 'plugin/browser input source handoff',
                participantId: source.providerId,
                logicalSourceKey: source.logicalSourceKey,
                outcome: 'overridden',
                status: 'overshadowed',
                reason: `Native source owns logical source ${source.logicalSourceKey}`,
            });
        }
    }

    function _monitoringState(value, fallback = 'unknown') {
        const normalized = _string(value, fallback);
        if (MONITORING_STATES.has(normalized)) return normalized;
        // Callers sometimes pass a non-state outcome (e.g. 'no-handler') as the fallback; clamp it
        // so a session.state is always a declared MONITORING_STATES member for inspectors/events.
        return MONITORING_STATES.has(fallback) ? fallback : 'unknown';
    }

    function _monitoringOutcome(value, fallback = 'handled') {
        const normalized = _string(value, fallback);
        return MONITORING_OUTCOMES.has(normalized) ? normalized : fallback;
    }

    function _authorizationMode(value) {
        const normalized = _string(value, 'background');
        return AUTHORIZATION_MODES.has(normalized) ? normalized : 'background';
    }

    function _directMonitorState(value, fallback = 'unknown') {
        const normalized = _string(value, fallback);
        return DIRECT_MONITOR_STATES.has(normalized) ? normalized : fallback;
    }

    function _directMonitorControl(value, fallback = 'unknown') {
        const normalized = _string(value, fallback);
        return DIRECT_MONITOR_CONTROLS.has(normalized) ? normalized : fallback;
    }

    function _normalizeDirectMonitor(value = {}) {
        const source = _plainObject(value);
        const preference = source.preference === 'muted' || source.preference === 'unmuted' ? source.preference : _readDirectMonitorPreference();
        return {
            state: _directMonitorState(source.state, preference || 'unknown'),
            control: _directMonitorControl(source.control, source.supported === false ? 'unsupported' : 'unknown'),
            preference,
            applied: source.applied === true,
            reason: _boundedReason(source.reason),
            lastChangedAt: _string(source.lastChangedAt, source.changedAt || ''),
        };
    }

    function _normalizeLatencySummary(value = {}) {
        const source = _plainObject(value);
        if (!Object.keys(source).length) return null;
        return {
            // bucket/level is provider-supplied and surfaced in diagnostics, so bound it like reason.
            bucket: _boundedReason(source.bucket || source.level),
            ms: _number(source.ms ?? source.latencyMs, null),
            reason: _boundedReason(source.reason),
        };
    }

    function _logicalMonitoringKey(provider, source) {
        const explicit = source.logicalMonitoringKey || source.logicalKey || source.monitoringKey;
        if (explicit) return _string(explicit);
        return `${provider.sourceMode}:${provider.providerId}`;
    }

    function _normalizeMonitoringProvider(spec) {
        const source = _plainObject(spec);
        // providerId is surfaced in diagnostics/events and used for selection, so normalize it the same
        // way requester ids are (redact paths/tokens, restrict to the id charset, bound length) before it
        // becomes session state — a buggy/malicious provider must not leak a path/token through it.
        const providerId = _boundedReason(_string(source.providerId || source.participantId || source.id)).replace(/[^A-Za-z0-9_.:-]+/g, '-').slice(0, 80);
        if (!providerId) return null;
        const existing = currentSession.monitoringProviders.get(providerId) || knownMonitoringProviders.get(providerId) || {};
        const compatibilitySource = _string(source.compatibilitySource || source.legacySurface || existing.compatibilitySource, '');
        const sourceMode = _sourceMode(source.sourceMode, compatibilitySource ? 'compatibility' : (source.ownerPluginId === 'core' || source.pluginId === 'core' || source.source === 'core' ? 'core' : 'native'));
        const operationHandlers = { ...(existing.operationHandlers || {}), ..._normalizeOperationHandlers(source) };
        const operations = Array.from(new Set([...(existing.operations || []), ..._strings(source.operations || source.providerOperations), ...Object.keys(operationHandlers)]));
        const provider = {
            providerId,
            ownerPluginId: _string(source.ownerPluginId || source.pluginId || existing.ownerPluginId || providerId, providerId),
            label: _safeInputLabel(source, _string(existing.label || providerId, providerId)),
            sourceMode,
            compatibilitySource,
            logicalMonitoringKey: _string(source.logicalMonitoringKey || source.logicalKey || source.monitoringKey || existing.logicalMonitoringKey, ''),
            availability: _availability(source.providerAvailability || source.availability || existing.availability, source.disabled ? 'disabled' : 'available'),
            operations,
            operationHandlers,
            version: _number(source.version || existing.version, 1),
            directMonitor: _normalizeDirectMonitor(source.directMonitor || existing.directMonitor || {}),
            latencySummary: _normalizeLatencySummary(source.latencySummary || existing.latencySummary || {}),
            reason: _boundedReason(source.reason || source.failureReason || source.unavailableReason || existing.reason),
            supersededBy: _string(source.supersededBy || existing.supersededBy, ''),
            registeredAt: existing.registeredAt || _string(source.registeredAt, _now()),
            lastSeenAt: _now(),
            lastChangedAt: _string(source.lastChangedAt || existing.lastChangedAt, _now()),
        };
        provider.logicalMonitoringKey = _logicalMonitoringKey(provider, source);
        return provider;
    }

    function _monitoringProviderPriority(provider) {
        if (provider.sourceMode === 'core') return 0;
        if (provider.sourceMode === 'native') return 1;
        return 2;
    }

    function _findMonitoringProvider(query = {}) {
        const source = _plainObject(query);
        const providerId = _string(source.providerId || source.participantId || source.id);
        const logicalMonitoringKey = _string(source.logicalMonitoringKey || source.logicalKey || source.monitoringKey);
        if (providerId && currentSession.monitoringProviders.has(providerId)) return currentSession.monitoringProviders.get(providerId);
        const matches = Array.from(currentSession.monitoringProviders.values()).filter(item => item.logicalMonitoringKey === logicalMonitoringKey);
        if (!matches.length) return null;
        matches.sort((a, b) => _monitoringProviderPriority(a) - _monitoringProviderPriority(b) || _inputSourceAvailabilityRank(a) - _inputSourceAvailabilityRank(b) || a.providerId.localeCompare(b.providerId));
        return matches[0];
    }

    function _refreshMonitoringDuplicateSuppression() {
        const groups = new Map();
        for (const provider of currentSession.monitoringProviders.values()) {
            provider.supersededBy = '';
            const list = groups.get(provider.logicalMonitoringKey) || [];
            list.push(provider);
            groups.set(provider.logicalMonitoringKey, list);
        }
        for (const list of groups.values()) {
            if (list.length < 2) continue;
            list.sort((a, b) => _monitoringProviderPriority(a) - _monitoringProviderPriority(b) || _inputSourceAvailabilityRank(a) - _inputSourceAvailabilityRank(b) || a.providerId.localeCompare(b.providerId));
            const winner = list[0];
            for (const loser of list.slice(1)) loser.supersededBy = winner.providerId;
        }
        _syncSelectedMonitoringProvider();
    }

    function _recordMonitoringDuplicateSuppression() {
        for (const provider of currentSession.monitoringProviders.values()) {
            if (!provider.supersededBy || provider.sourceMode !== 'compatibility') continue;
            recordBridgeHit({
                domain: 'audio-monitoring',
                bridgeId: provider.compatibilitySource || 'audio-monitoring.legacy-provider',
                legacySurface: provider.compatibilitySource || 'plugin/browser monitoring handoff',
                participantId: provider.providerId,
                outcome: 'overridden',
                status: 'overshadowed',
                reason: `Native monitoring provider ${provider.supersededBy} owns logical path ${provider.logicalMonitoringKey}`,
            });
        }
    }

    function _visibleMonitoringProviders() {
        _refreshMonitoringDuplicateSuppression();
        return Array.from(currentSession.monitoringProviders.values())
            .filter(provider => !provider.supersededBy)
            .sort((a, b) => _monitoringProviderPriority(a) - _monitoringProviderPriority(b) || a.label.localeCompare(b.label) || a.providerId.localeCompare(b.providerId));
    }

    function _syncSelectedMonitoringProvider() {
        const selected = currentSession.selectedMonitoringProvider;
        if (!selected || !selected.logicalMonitoringKey) return null;
        const provider = _findMonitoringProvider({ logicalMonitoringKey: selected.logicalMonitoringKey });
        if (provider && !provider.supersededBy) {
            selected.providerId = provider.providerId;
            selected.availability = provider.availability;
            selected.restoreStatus = provider.availability === 'available' ? (selected.restored ? 'restored' : 'available') : provider.availability;
            if (selected.restored && !selected.lastRestoredAt) selected.lastRestoredAt = _now();
        } else {
            selected.providerId = '';
            selected.availability = 'unavailable';
            selected.restoreStatus = selected.restored ? 'missing-provider' : 'unavailable';
        }
        return selected;
    }

    function _makeSelectedMonitoringProvider(provider, requester) {
        const now = _now();
        return {
            providerId: provider.providerId,
            logicalMonitoringKey: provider.logicalMonitoringKey,
            availability: provider.availability,
            restored: false,
            restoreStatus: provider.availability === 'available' ? 'available' : provider.availability,
            selectedAt: now,
            lastSelectedAt: now,
            lastRestoredAt: '',
            requesterId: _requesterId(requester),
        };
    }

    function _summaryMonitoringProvider(provider) {
        if (!provider) return null;
        return {
            providerId: provider.providerId,
            ownerPluginId: provider.ownerPluginId,
            label: provider.label,
            sourceMode: provider.sourceMode,
            compatibilitySource: provider.compatibilitySource || '',
            logicalMonitoringKey: provider.logicalMonitoringKey,
            availability: provider.availability,
            operations: _strings(provider.operations),
            directMonitor: _clone(provider.directMonitor),
            latencySummary: _clone(provider.latencySummary),
            reason: provider.reason || '',
            supersededBy: provider.supersededBy || '',
            registeredAt: provider.registeredAt || '',
            lastSeenAt: provider.lastSeenAt || '',
            lastChangedAt: provider.lastChangedAt || '',
        };
    }

    function _summarySelectedMonitoringProvider(selected) {
        if (!selected) return null;
        return {
            providerId: selected.providerId || '',
            logicalMonitoringKey: selected.logicalMonitoringKey || '',
            availability: selected.availability || 'unavailable',
            restored: !!selected.restored,
            restoreStatus: selected.restoreStatus || 'not-selected',
            selectedAt: selected.selectedAt || selected.lastSelectedAt || '',
            lastSelectedAt: selected.lastSelectedAt || '',
            lastRestoredAt: selected.lastRestoredAt || '',
            requesterId: selected.requesterId || '',
        };
    }

    function _monitoringSourceRef(openResult, fallback = {}) {
        const payload = _plainObject(openResult && openResult.payload ? openResult.payload : openResult);
        const source = _plainObject(fallback);
        return {
            logicalSourceKey: _string(payload.logicalSourceKey || source.logicalSourceKey, ''),
            sourceId: _string(payload.sourceId || source.sourceId, ''),
            providerId: _string(payload.providerId || source.providerId, ''),
            availability: _string(payload.state || payload.availability || source.availability, ''),
            channelShape: _channelShape(payload.channelShape || source.channelShape, 'unknown'),
            openSessionId: _string(payload.openSessionId || payload.openInputSessionId || source.openSessionId, ''),
        };
    }

    function _monitoringSessionKey(provider, sourceRef, requiredChannelShape, directMonitorPolicy) {
        return [
            provider && provider.logicalMonitoringKey,
            sourceRef && sourceRef.logicalSourceKey,
            _channelShape(requiredChannelShape, 'unknown'),
            directMonitorPolicy || 'default',
        ].map(item => _string(item, 'unknown')).join('::');
    }

    function _findCompatibleMonitoringSession(provider, sourceRef, requiredChannelShape, directMonitorPolicy) {
        const key = _monitoringSessionKey(provider, sourceRef, requiredChannelShape, directMonitorPolicy);
        for (const session of currentSession.monitoringSessions.values()) {
            if (session.sessionKey === key && (session.state === 'active' || session.state === 'degraded')) return session;
        }
        return null;
    }

    function _monitoringRequesterRef(source = {}) {
        return {
            requesterId: _requesterId(source.requesterId || source.requester || source.source, 'unknown'),
            purpose: _boundedReason(source.purpose).slice(0, 80),
            requiredChannelShape: _channelShape(source.requiredChannelShape, 'unknown'),
            directMonitorRequirement: _directMonitorState(source.directMonitorRequirement, source.directMonitorRequirement ? 'unknown' : 'unknown'),
            status: _string(source.status, ''),
            reason: _boundedReason(source.reason),
            attachedAt: _string(source.attachedAt, _now()),
        };
    }

    function _withMonitoringTimeout(promise, operation) {
        let timer = null;
        const timeout = new Promise((_, reject) => {
            timer = setTimeout(() => {
                const err = new Error(`${operation} timed out after ${MONITORING_OPERATION_TIMEOUT_MS}ms`);
                err.timedOut = true;
                reject(err);
            }, MONITORING_OPERATION_TIMEOUT_MS);
        });
        return Promise.race([Promise.resolve(promise), timeout]).finally(() => { if (timer !== null) clearTimeout(timer); });
    }

    function _monitoringProviderOutcome(raw, fallbackPayload = {}, voidIsFailure = false) {
        // Per the control-plane contract a malformed (non-object) provider response is a failure, not a
        // silently-'handled' active session. A void return (null/undefined) is lenient for stop/status
        // (some handlers legitimately return nothing) but a failure for monitoring.start (voidIsFailure),
        // which must not report monitoring active when the provider returned no result.
        const isVoid = raw === null || raw === undefined;
        if ((isVoid && voidIsFailure) || (!isVoid && (typeof raw !== 'object' || Array.isArray(raw)))) {
            return { outcome: 'failed', status: 'failed', reason: _boundedReason(isVoid ? 'Monitoring provider returned no result' : 'Malformed monitoring provider response'), payload: fallbackPayload };
        }
        if (isVoid) {
            // Void return tolerated for stop/status: treat as handled but with a neutral 'unknown' status
            // (never 'active', which would fake an active session) and surface fallbackPayload verbatim.
            return { outcome: 'handled', status: 'unknown', reason: '', payload: fallbackPayload };
        }
        const source = _plainObject(raw);
        const outcome = _monitoringOutcome(source.outcome, 'handled');
        const payload = _safeInputValue(source.payload || source.session || source.summary || source, 0) || fallbackPayload;
        return {
            outcome,
            status: _monitoringState(source.status || source.state, outcome === 'handled' ? 'active' : outcome),
            reason: _boundedReason(source.reason || source.error || source.message),
            payload,
        };
    }

    function _monitoringEventFor(outcome, state) {
        if (outcome === 'handled' && state === 'active') return 'monitoring-started';
        if (outcome === 'degraded' || state === 'degraded') return 'monitoring-degraded';
        if (outcome === 'denied' || state === 'denied') return 'monitoring-denied';
        if (outcome === 'failed' || state === 'failed' || outcome === 'incompatible' || outcome === 'incompatible-version') return 'monitoring-failed';
        if (outcome === 'stopped' || state === 'stopped') return 'monitoring-stopped';
        if (outcome === 'provider-selection-required') return 'provider-selection-required';
        return 'monitoring-unavailable';
    }

    function _emitMonitoringOutcome(outcome, session, extra = {}) {
        // Events are broadcast to all observers, so emit the redaction-safe session shape (same as
        // diagnostics) rather than a raw clone that would leak internal sessionKey/monitoringId/sourceRef.
        const payload = { ..._redactedMonitoringSession(session, _newPseudonymizer()), ...extra };
        const event = _monitoringEventFor(outcome, session && session.state);
        capabilities.emitEvent('audio-monitoring', event, payload);
        if (outcome === 'denied' || (session && session.state === 'denied')) capabilities.emitEvent('audio-monitoring', 'permission-denied', payload);
    }

    function _monitoringResultFor(outcome, reason, payload) {
        if (outcome === 'handled') return _handled(payload);
        if (outcome === 'denied') return _denied(reason, payload);
        if (outcome === 'degraded') return _degraded(reason, payload);
        if (outcome === 'failed') return _failed(reason, payload);
        if (outcome === 'no-owner') return _noOwner(reason, payload);
        if (outcome === 'no-handler') return _noHandler(reason, payload);
        if (outcome === 'unsupported-command') return _unsupportedCommand(reason, payload);
        if (outcome === 'incompatible') return _incompatible(reason, payload);
        if (outcome === 'incompatible-version') return _incompatibleVersion(reason, payload);
        if (outcome === 'provider-selection-required') return _providerSelectionRequired(reason, payload);
        if (outcome === 'user-action-required') return _userActionRequired(reason, payload);
        if (outcome === 'stopped') return _stopped(reason, payload);
        if (outcome === 'unavailable') return _unavailable(reason, payload);
        if (outcome === 'overridden') return { outcome: 'overridden', reason, payload };
        return _degraded(reason, payload);
    }

    function _syncSelectedInput() {
        const selected = currentSession.selectedInput;
        if (!selected || !selected.logicalSourceKey) {
            for (const source of currentSession.inputSources.values()) source.selected = false;
            return null;
        }
        const source = _findInputSource({ logicalSourceKey: selected.logicalSourceKey });
        for (const item of currentSession.inputSources.values()) item.selected = item.logicalSourceKey === selected.logicalSourceKey && item.sourceId === (source && source.sourceId);
        if (source) {
            selected.sourceId = source.sourceId;
            selected.providerId = source.providerId;
            selected.availability = source.availability;
            selected.restoreStatus = source.availability === 'available' ? (selected.restored ? 'restored' : 'available') : source.availability;
            if (selected.restored && !selected.lastRestoredAt) selected.lastRestoredAt = _now();
        } else {
            selected.sourceId = '';
            selected.providerId = '';
            selected.availability = 'unavailable';
            selected.restoreStatus = selected.restored ? 'missing-provider' : 'unavailable';
        }
        return selected;
    }

    function _makeSelectedInput(source, requester) {
        const now = _now();
        return {
            logicalSourceKey: source.logicalSourceKey,
            sourceId: source.sourceId,
            providerId: source.providerId,
            availability: source.availability,
            restored: false,
            restoreStatus: source.availability === 'available' ? 'available' : source.availability,
            selectedAt: now,
            lastSelectedAt: now,
            lastRestoredAt: '',
            requesterId: _requesterId(requester),
        };
    }

    function _requiredChannelShape(value) {
        const source = _plainObject(value);
        return _channelShape(source.requiredChannelShape || source.channelShape || source.shape || value, 'unknown');
    }

    function _channelCompatible(channelSummary, requiredChannelShape) {
        const required = _channelShape(requiredChannelShape, 'unknown');
        if (required === 'unknown') return { ok: true, channelShape: _channelShape(channelSummary && channelSummary.defaultShape, _channelShape(channelSummary && channelSummary.channelShape, 'unknown')) };
        const summary = _plainObject(channelSummary);
        const supports = Array.isArray(summary.supports) ? summary.supports.map(item => _channelShape(item, '')).filter(Boolean) : [];
        const shape = _channelShape(summary.channelShape, 'unknown');
        const count = _number(summary.channelCount, null);
        const compatible = supports.includes(required) || shape === required || (required === 'mono' && count && count >= 1) || (required === 'stereo' && count && count >= 2) || (required === 'multi' && count && count > 2);
        return { ok: compatible, channelShape: required };
    }

    function _openSessionKey(logicalSourceKey, channelShape) {
        return `${_string(logicalSourceKey)}::${_channelShape(channelShape, 'unknown')}`;
    }

    function _requesterRef(requesterId, purpose) {
        return { requesterId: _requesterId(requesterId), purpose: _boundedReason(purpose).slice(0, 80), openedAt: _now() };
    }

    function _withInputTimeout(promise, operation) {
        let timer = null;
        const timeout = new Promise((_, reject) => {
            timer = setTimeout(() => {
                const err = new Error(`${operation} timed out after ${INPUT_OPERATION_TIMEOUT_MS}ms`);
                err.timedOut = true;
                reject(err);
            }, INPUT_OPERATION_TIMEOUT_MS);
        });
        return Promise.race([Promise.resolve(promise), timeout]).finally(() => { if (timer !== null) clearTimeout(timer); });
    }

    function _unsupportedCommand(reason, payload) { return { outcome: 'unsupported-command', reason, payload }; }

    function _providerOutcome(raw, fallbackPayload = {}) {
        const source = _plainObject(raw);
        const outcome = _string(source.outcome, 'handled');
        const payload = _safeInputValue(source.payload || source.session || source.summary || source, 0) || fallbackPayload;
        return {
            outcome: PROVIDER_OUTCOMES.has(outcome) ? outcome : 'handled',
            status: _string(source.status || source.state, ''),
            reason: _boundedReason(source.reason || source.error || source.message),
            payload,
        };
    }

    function _recordOutcome(entry) {
        const source = _plainObject(entry);
        const outcome = _string(source.outcome, 'handled');
        const record = {
            domain: DOMAINS.includes(source.domain) ? source.domain : 'audio-mix',
            operation: _string(source.operation || source.command || source.event, 'inspect'),
            participantId: _string(source.participantId || source.ownerId || source.requester, ''),
            providerId: _string(source.providerId, ''),
            monitoringId: _string(source.monitoringId, ''),
            sourceId: _string(source.sourceId, ''),
            logicalSourceKey: _string(source.logicalSourceKey, ''),
            requesterId: _string(source.requesterId, ''),
            openSessionId: _string(source.openSessionId, ''),
            faderId: _string(source.faderId, ''),
            bridgeId: _string(source.bridgeId, ''),
            outcome,
            status: _string(source.status, ''),
            reason: _boundedReason(source.reason),
            timestamp: _string(source.timestamp, _now()),
        };
        currentSession.outcomes.push(record);
        while (currentSession.outcomes.length > MAX_OUTCOMES) currentSession.outcomes.shift();
        currentSession.updatedAt = _now();
        return record;
    }

    function _redactedOutcome(outcome, pseudonymize) {
        const clone = _clone(outcome) || {};
        if (clone.domain === 'audio-input' || clone.domain === 'audio-monitoring') {
            if (clone.sourceId) clone.sourceId = pseudonymize(clone.sourceId, 'source');
            // openSessionId is left verbatim: it is an internally-generated `input-open-<n>` id (not
            // sensitive) and must correlate with openSessions[].openSessionId in the same snapshot.
            // The one untrusted entry point (a close-source miss) is bounded at its call site instead.
            // logicalSourceKey/providerId/participantId/requesterId are only *supposed* to be
            // redaction-safe; some paths derive them from caller-supplied values (e.g. an enumerate
            // option payload), so bound them so a path/token cannot leak into diagnostics.
            if (clone.logicalSourceKey) clone.logicalSourceKey = _boundedReason(clone.logicalSourceKey);
            if (clone.providerId) clone.providerId = _boundedReason(clone.providerId);
            if (clone.participantId) clone.participantId = _boundedReason(clone.participantId);
            if (clone.requesterId) clone.requesterId = _boundedReason(clone.requesterId);
        }
        if (clone.domain === 'audio-monitoring' && clone.monitoringId) clone.monitoringId = pseudonymize(clone.monitoringId, 'monitoring');
        // audio-input openSessionId is always an internally-generated `input-open-<n>` id (the one
        // untrusted close-source path bounds it at its call site), so it stays verbatim to correlate
        // with openSessions[]. On audio-monitoring it can be caller-supplied via sourceRef.openSessionId,
        // so only keep it verbatim when it names a live internally-tracked open-input session (preserving
        // the cross-domain correlation); pseudonymize anything else — a raw/native handle, or a spoofed
        // id matching the safe format that would otherwise falsely correlate to another session.
        if (clone.domain === 'audio-monitoring' && clone.openSessionId
            && !Array.from(currentSession.openInputSessions.values()).some(item => item.openSessionId === clone.openSessionId)) {
            clone.openSessionId = pseudonymize(clone.openSessionId, 'input-open');
        }
        if (clone.reason) clone.reason = _boundedReason(clone.reason);
        return clone;
    }

    function _handled(payload) { return { outcome: 'handled', payload }; }
    function _degraded(reason, payload) { return { outcome: 'degraded', reason, payload }; }
    function _failed(reason, payload) { return { outcome: 'failed', reason, payload }; }
    function _noHandler(reason, payload) { return { outcome: 'no-handler', reason, payload }; }
    function _noOwner(reason, payload) { return { outcome: 'no-owner', reason, payload }; }
    function _incompatible(reason, payload) { return { outcome: 'incompatible', reason, payload }; }
    function _incompatibleVersion(reason, payload) { return { outcome: 'incompatible-version', reason, payload }; }
    function _unavailable(reason, payload) { return { outcome: 'unavailable', reason, payload }; }
    function _providerSelectionRequired(reason, payload) { return { outcome: 'provider-selection-required', reason, payload }; }
    function _userActionRequired(reason, payload) { return { outcome: 'user-action-required', reason, payload }; }
    function _stopped(reason, payload) { return { outcome: 'stopped', reason, payload }; }

    function _denied(reason, payload) { return { outcome: 'denied', reason, payload }; }

    function _faderKey(participantId, faderId) {
        return `${_string(participantId)}:${_string(faderId, 'main')}`;
    }

    function _findParticipant(participantId, faderId) {
        const id = _string(participantId);
        if (id && currentSession.mixParticipants.has(id)) return currentSession.mixParticipants.get(id);
        const requestedFaderId = _string(faderId);
        for (const participant of currentSession.mixParticipants.values()) {
            if (participant.fader && participant.fader.id === requestedFaderId) return participant;
        }
        return null;
    }

    function _effectiveFaderAvailability(participant) {
        if (!participant || !participant.fader) return 'unavailable';
        if (participant.supersededBy) return 'disabled';
        if (participant.availability !== 'available') return participant.availability;
        if (participant.fader.availability !== 'available') return participant.fader.availability;
        if (!participant.fader.userAdjustable) return 'disabled';
        if (currentSession.state !== 'active' && participant.kind !== 'song') return 'pending';
        return 'available';
    }

    function _operationPriority(participant) {
        if (participant.sourceMode === 'core') return 0;
        if (participant.sourceMode === 'native') return 1;
        return 2;
    }

    function _refreshDuplicateSuppression() {
        const groups = new Map();
        for (const participant of currentSession.mixParticipants.values()) {
            participant.supersededBy = '';
            if (!participant.fader) continue;
            const list = groups.get(participant.logicalFaderKey) || [];
            list.push(participant);
            groups.set(participant.logicalFaderKey, list);
        }
        for (const list of groups.values()) {
            if (list.length < 2) continue;
            list.sort((a, b) => _operationPriority(a) - _operationPriority(b) || a.participantId.localeCompare(b.participantId));
            const winner = list[0];
            for (const loser of list.slice(1)) {
                loser.supersededBy = winner.participantId;
            }
        }
    }

    function _recordDuplicateSuppression() {
        for (const participant of currentSession.mixParticipants.values()) {
            if (!participant.supersededBy || participant.sourceMode !== 'compatibility') continue;
            recordBridgeHit({
                domain: 'audio-mix',
                bridgeId: participant.compatibilitySource || 'audio-mix.fader-registry',
                legacySurface: participant.compatibilitySource || 'registerFader',
                participantId: participant.participantId,
                outcome: 'overridden',
                status: 'overshadowed',
                reason: `Native audio-mix participant ${participant.supersededBy} owns logical fader ${participant.logicalFaderKey}`,
            });
        }
    }

    function _visibleFaderParticipants() {
        _refreshDuplicateSuppression();
        return Array.from(currentSession.mixParticipants.values())
            .filter(participant => participant.fader && !participant.supersededBy)
            .sort((a, b) => REQUIRED_MIX_KINDS.indexOf(a.kind) - REQUIRED_MIX_KINDS.indexOf(b.kind) || a.label.localeCompare(b.label) || a.participantId.localeCompare(b.participantId));
    }

    function _withFaderTimeout(promise, participant, operation) {
        let timer = null;
        const timeout = new Promise((_, reject) => {
            timer = setTimeout(() => {
                const err = new Error(`${operation} timed out after ${FADER_OPERATION_TIMEOUT_MS}ms`);
                err.timedOut = true;
                reject(err);
            }, FADER_OPERATION_TIMEOUT_MS);
        });
        return Promise.race([Promise.resolve(promise), timeout]).finally(() => { if (timer !== null) clearTimeout(timer); });
    }

    function _extractCommittedValue(result, fallback) {
        if (Number.isFinite(Number(result))) return Number(result);
        const source = _plainObject(result);
        const value = _number(source.committedValue, _number(source.currentValue, _number(source.value, fallback)));
        return Number.isFinite(value) ? value : fallback;
    }

    function _emitFaderUnavailable(participant, reason) {
        const payload = _summaryFader(participant, { availability: _effectiveFaderAvailability(participant) });
        if (payload) payload.reason = _boundedReason(reason);
        capabilities.emitEvent('audio-mix', 'fader-unavailable', payload || { participantId: participant && participant.participantId, reason: _boundedReason(reason) });
    }

    async function listFaders() {
        const faders = _visibleFaderParticipants().map(participant => _summaryFader(participant));
        const kinds = Object.fromEntries(REQUIRED_MIX_KINDS.map(kind => [kind, faders.some(fader => fader.kind === kind)]));
        _recordOutcome({ domain: 'audio-mix', operation: 'list-faders', participantId: OWNER_ID, outcome: 'handled', status: `${faders.length}` });
        return _handled({ faders, requiredKinds: kinds, timeoutMs: FADER_OPERATION_TIMEOUT_MS });
    }

    async function getFaderValue(payload = {}) {
        const participant = _findParticipant(payload.participantId, payload.faderId || payload.id);
        if (!participant || !participant.fader) {
            const result = _noHandler('Unknown audio-mix fader', { participantId: payload.participantId || '', faderId: payload.faderId || payload.id || '' });
            _recordOutcome({ domain: 'audio-mix', operation: 'get-fader-value', participantId: result.payload.participantId, faderId: result.payload.faderId, outcome: result.outcome, reason: result.reason });
            return result;
        }
        const availability = _effectiveFaderAvailability(participant);
        if (availability !== 'available') {
            const result = _degraded(`Fader is ${availability}`, _summaryFader(participant, { availability }));
            _emitFaderUnavailable(participant, result.reason);
            _recordOutcome({ domain: 'audio-mix', operation: 'get-fader-value', participantId: participant.participantId, faderId: participant.fader.id, outcome: result.outcome, status: availability, reason: result.reason });
            return result;
        }
        const previous = participant.fader.currentValue;
        try {
            const handler = participant.operationHandlers['fader.get-value'];
            const raw = handler ? await _withFaderTimeout(handler({ participant: _summaryParticipant(participant), fader: _summaryFader(participant) }), participant, 'fader.get-value') : previous;
            const committed = _clamp(_extractCommittedValue(raw, previous), participant.fader.min, participant.fader.max);
            participant.fader.currentValue = committed;
            participant.fader.lastCommittedAt = _now();
            _recordOutcome({ domain: 'audio-mix', operation: 'get-fader-value', participantId: participant.participantId, faderId: participant.fader.id, outcome: 'handled', status: 'available' });
            _touch();
            return _handled({ ..._summaryFader(participant), committedValue: committed, previousCommittedValue: previous });
        } catch (err) {
            const timedOut = !!(err && err.timedOut);
            const reason = timedOut ? 'Fader get-value timed out' : _boundedReason(err && err.message ? err.message : String(err));
            _recordOutcome({ domain: 'audio-mix', operation: 'get-fader-value', participantId: participant.participantId, faderId: participant.fader.id, outcome: 'failed', status: timedOut ? 'timeout' : 'failed', reason });
            _touch();
            return _failed(reason, { ..._summaryFader(participant), committedValue: previous, timedOut });
        }
    }

    async function setFaderValue(payload = {}) {
        const participant = _findParticipant(payload.participantId, payload.faderId || payload.id);
        const requestedValue = _number(payload.value ?? payload.requestedValue, null);
        if (!participant || !participant.fader) {
            const result = _noHandler('Unknown audio-mix fader', { participantId: payload.participantId || '', faderId: payload.faderId || payload.id || '', requestedValue });
            _recordOutcome({ domain: 'audio-mix', operation: 'set-fader-value', participantId: result.payload.participantId, faderId: result.payload.faderId, outcome: result.outcome, reason: result.reason });
            return result;
        }
        if (!Number.isFinite(requestedValue)) {
            const result = _denied('Fader value must be a finite number', { ..._summaryFader(participant), requestedValue });
            _recordOutcome({ domain: 'audio-mix', operation: 'set-fader-value', participantId: participant.participantId, faderId: participant.fader.id, outcome: result.outcome, status: 'invalid-value', reason: result.reason });
            return result;
        }
        const availability = _effectiveFaderAvailability(participant);
        if (availability !== 'available') {
            const result = _degraded(`Fader is ${availability}`, { ..._summaryFader(participant, { availability }), requestedValue });
            _emitFaderUnavailable(participant, result.reason);
            _recordOutcome({ domain: 'audio-mix', operation: 'set-fader-value', participantId: participant.participantId, faderId: participant.fader.id, outcome: result.outcome, status: availability, reason: result.reason });
            return result;
        }
        const previous = participant.fader.currentValue;
        const normalizedValue = _clamp(requestedValue, participant.fader.min, participant.fader.max);
        participant.fader.lastRequestedValue = requestedValue;
        try {
            const handler = participant.operationHandlers['fader.set-value'];
            const raw = handler ? await _withFaderTimeout(handler(normalizedValue, { requestedValue, participant: _summaryParticipant(participant), fader: _summaryFader(participant) }), participant, 'fader.set-value') : normalizedValue;
            const committed = _clamp(_extractCommittedValue(raw, normalizedValue), participant.fader.min, participant.fader.max);
            participant.fader.currentValue = committed;
            participant.fader.lastRejectedValue = null;
            participant.fader.lastCommittedAt = _now();
            const result = { ..._summaryFader(participant), requestedValue, normalizedValue, committedValue: committed, previousCommittedValue: previous };
            _recordOutcome({ domain: 'audio-mix', operation: 'set-fader-value', participantId: participant.participantId, faderId: participant.fader.id, outcome: 'handled', status: committed === normalizedValue ? 'committed' : 'normalized' });
            capabilities.emitEvent('audio-mix', 'fader-value-changed', result);
            _touch();
            return _handled(result);
        } catch (err) {
            const timedOut = !!(err && err.timedOut);
            const reason = timedOut ? 'Fader set-value timed out' : _boundedReason(err && err.message ? err.message : String(err));
            participant.fader.lastRejectedValue = requestedValue;
            participant.fader.currentValue = previous;
            _recordOutcome({ domain: 'audio-mix', operation: 'set-fader-value', participantId: participant.participantId, faderId: participant.fader.id, outcome: 'failed', status: timedOut ? 'timeout' : 'failed', reason });
            _touch();
            return _failed(reason, { ..._summaryFader(participant), requestedValue, normalizedValue, committedValue: previous, previousCommittedValue: previous, timedOut });
        }
    }

    function startSession(options = {}) {
        // Close any open input sessions on the outgoing session before it is replaced, so a direct
        // startSession() (e.g. a song switch that does not call stopSession first) doesn't orphan
        // provider-owned capture with no state left to close it.
        if (currentSession) _closeOpenInputSessions('Session restarted');
        const previousSelectedInput = currentSession && currentSession.selectedInput ? _clone(currentSession.selectedInput) : null;
        const previousSelectedMonitoringProvider = currentSession && currentSession.selectedMonitoringProvider ? _clone(currentSession.selectedMonitoringProvider) : null;
        const previousDirectMonitor = currentSession && currentSession.directMonitor ? _clone(currentSession.directMonitor) : null;
        const previousMonitoringSessions = currentSession ? Array.from(currentSession.monitoringSessions.values()).map(_clone) : [];
        const previousStorageStatus = currentSession && currentSession.storageStatus;
        currentSession = _newSession({ ...options, state: 'active' });
        if (previousStorageStatus === 'failed') {
            // Persistence is failed, so the stored key may be stale — keep the in-memory selection
            // stable instead of silently reverting to whatever storage happens to hold.
            if (previousSelectedInput) currentSession.selectedInput = previousSelectedInput;
            if (previousSelectedMonitoringProvider) currentSession.selectedMonitoringProvider = previousSelectedMonitoringProvider;
            if (previousDirectMonitor) currentSession.directMonitor = previousDirectMonitor;
            currentSession.storageStatus = 'failed';
        } else if (!currentSession.selectedInput && previousSelectedInput) {
            currentSession.selectedInput = previousSelectedInput;
            if (!currentSession.selectedMonitoringProvider && previousSelectedMonitoringProvider) currentSession.selectedMonitoringProvider = previousSelectedMonitoringProvider;
            if (previousDirectMonitor) currentSession.directMonitor = previousDirectMonitor;
        } else {
            if (!currentSession.selectedMonitoringProvider && previousSelectedMonitoringProvider) currentSession.selectedMonitoringProvider = previousSelectedMonitoringProvider;
            if (previousDirectMonitor) currentSession.directMonitor = previousDirectMonitor;
        }
        for (const participant of knownMixParticipants.values()) {
            const attached = { ...participant, lastSeenAt: _now() };
            if (attached.availability === 'pending') attached.availability = 'available';
            if (attached.fader && attached.fader.availability === 'pending') attached.fader.availability = 'available';
            currentSession.mixParticipants.set(attached.participantId, attached);
        }
        for (const provider of knownInputProviders.values()) {
            currentSession.inputProviders.set(provider.providerId, { ...provider, lastSeenAt: _now() });
        }
        for (const source of knownInputSources.values()) {
            currentSession.inputSources.set(source.sourceId, { ...source, lastSeenAt: _now(), selected: false });
        }
        for (const provider of knownMonitoringProviders.values()) {
            currentSession.monitoringProviders.set(provider.providerId, { ...provider, lastSeenAt: _now() });
        }
        for (const session of previousMonitoringSessions) {
            if (session && (session.state === 'active' || session.state === 'degraded')) currentSession.monitoringSessions.set(session.monitoringId, { ...session, updatedAt: _now() });
        }
        _refreshDuplicateSuppression();
        _refreshInputDuplicateSuppression();
        _refreshMonitoringDuplicateSuppression();
        _recordOutcome({ domain: 'audio-mix', operation: 'session.start', participantId: OWNER_ID, outcome: 'handled' });
        _recordOutcome({ domain: 'audio-input', operation: 'session.start', participantId: OWNER_ID, outcome: 'handled', status: currentSession.selectedInput ? currentSession.selectedInput.restoreStatus : 'not-selected' });
        _recordOutcome({ domain: 'audio-monitoring', operation: 'session.start', participantId: OWNER_ID, outcome: 'handled', status: currentSession.monitoringSessions.size ? 'active' : 'stopped' });
        _touch();
        return snapshot();
    }

    function stopSession(reason = 'Session stopped') {
        currentSession.state = 'stopped';
        currentSession.routeState = _normalizeRoute({ routeKind: 'unknown', availability: 'unavailable', reason });
        _closeOpenInputSessions(reason);
        _recordOutcome({ domain: 'audio-mix', operation: 'session.stop', participantId: OWNER_ID, outcome: 'handled', reason });
        _recordOutcome({ domain: 'audio-monitoring', operation: 'session.stop', participantId: OWNER_ID, outcome: 'handled', status: currentSession.monitoringSessions.size ? 'active' : 'stopped', reason: 'Playback stopped; live monitoring remains requester-owned' });
        _touch();
        return snapshot();
    }

    // Tear down any open input sessions so providers release live capture when the
    // session stops (e.g. song switch) instead of leaving microphones/instruments hot.
    // Provider close is best-effort and non-blocking — teardown must not depend on it.
    function _closeOpenInputSessions(reason) {
        if (!currentSession.openInputSessions.size) return;
        const boundedReason = _boundedReason(reason);
        // One pseudonymizer for the whole batch so distinct sources keep distinct source-NN ids
        // across the emitted source-closed events instead of every event reusing source-01.
        const pseudonymize = _newPseudonymizer();
        for (const session of Array.from(currentSession.openInputSessions.values())) {
            const provider = currentSession.inputProviders.get(session.providerId);
            const handler = provider && provider.operationHandlers && provider.operationHandlers['source.close'];
            if (typeof handler === 'function') {
                try {
                    Promise.resolve(handler({ sourceId: session.sourceId, logicalSourceKey: session.logicalSourceKey, openSessionId: session.openSessionId, requesterIds: session.requesters.map(item => item.requesterId) })).catch(() => {});
                } catch (err) { /* best-effort teardown */ }
            }
            session.state = 'closed';
            session.closedAt = _now();
            session.reason = boundedReason;
            session.requesters = [];
            _recordOutcome({ domain: 'audio-input', operation: 'close-source', participantId: OWNER_ID, providerId: session.providerId, sourceId: session.sourceId, logicalSourceKey: session.logicalSourceKey, openSessionId: session.openSessionId, outcome: 'handled', status: 'closed', reason: boundedReason });
            capabilities.emitEvent('audio-input', 'source-closed', _redactedOpenSession(session, pseudonymize));
        }
        currentSession.openInputSessions.clear();
    }

    function setRoute(route) {
        currentSession.routeState = _normalizeRoute(route);
        const degraded = currentSession.routeState.availability === 'degraded' || currentSession.routeState.availability === 'unavailable';
        _recordOutcome({
            domain: 'audio-mix',
            operation: 'route.set',
            participantId: OWNER_ID,
            outcome: degraded ? 'degraded' : 'handled',
            status: currentSession.routeState.availability,
            reason: currentSession.routeState.fallbackReason,
        });
        // Redact the device identity before it reaches event subscribers or the
        // caller; raw deviceLabel/deviceId only ever live in currentSession.
        // Snapshot the return clone before dispatching the (mutable) event payload
        // so a subscriber can't desync or mutate the caller's copy.
        const redactedRoute = _redactedRoute(currentSession.routeState, _newPseudonymizer());
        const returnedRoute = _clone(redactedRoute);
        capabilities.emitEvent('audio-mix', degraded ? 'route-degraded' : 'route-changed', redactedRoute);
        _touch();
        return returnedRoute;
    }

    function setAnalyser(analyser) {
        currentSession.analyserState = _normalizeAnalyser(analyser);
        const degraded = currentSession.analyserState.availability !== 'available';
        _recordOutcome({ domain: 'audio-mix', operation: 'analyser.set', participantId: currentSession.analyserState.participantId || OWNER_ID, outcome: degraded ? 'degraded' : 'handled', status: currentSession.analyserState.availability, reason: currentSession.analyserState.reason });
        capabilities.emitEvent('audio-mix', degraded ? 'analyser-unavailable' : 'analyser-changed', currentSession.analyserState);
        _touch();
        return _clone(currentSession.analyserState);
    }

    function registerMixParticipant(spec) {
        const source = _plainObject(spec);
        if (source.incompatible || (source.version && Number(source.version) !== 1)) {
            const result = _incompatibleVersion('Mix participant requires audio-session contract version 1');
            _recordOutcome({ domain: 'audio-mix', operation: 'register-participant', participantId: source.participantId || source.id, outcome: result.outcome, reason: result.reason });
            return result;
        }
        const participant = _normalizeParticipant(source);
        if (!participant) {
            const result = _failed('Mix participant registration requires participantId');
            _recordOutcome({ domain: 'audio-mix', operation: 'register-participant', outcome: result.outcome, reason: result.reason });
            return result;
        }
        // Preserve operation handlers across re-registration, the same way
        // registerInputSource and the monitoring provider already do. Without
        // this, a caller that re-registers to refresh availability / current
        // value but doesn't re-pass getValue/setValue would silently drop the
        // fader handlers — which is exactly how the song fader's volume-apply
        // handler was being wiped on every song load. New handlers still
        // override; only ones the new spec omits are retained.
        const _existingParticipant = knownMixParticipants.get(participant.participantId);
        if (_existingParticipant && _existingParticipant.operationHandlers) {
            participant.operationHandlers = {
                ..._existingParticipant.operationHandlers,
                ...participant.operationHandlers,
            };
        }
        participant.logicalFaderKey = _logicalFaderKey(participant, source);
        if (participant.fader && participant.fader.availability === 'available' && participant.availability !== 'available') {
            participant.fader.availability = participant.availability;
        }
        knownMixParticipants.set(participant.participantId, participant);
        currentSession.mixParticipants.set(participant.participantId, participant);
        _refreshDuplicateSuppression();
        _recordDuplicateSuppression();
        _recordOutcome({ domain: 'audio-mix', operation: 'register-participant', participantId: participant.participantId, outcome: 'handled', status: participant.availability });
        capabilities.emitEvent('audio-mix', 'participant-registered', _summaryParticipant(participant));
        _touch();
        return _handled(_summaryParticipant(participant));
    }

    function unregisterMixParticipant(participantId) {
        const id = _string(participantId);
        const removed = currentSession.mixParticipants.delete(id);
        knownMixParticipants.delete(id);
        const outcome = removed ? 'handled' : 'no-handler';
        _recordOutcome({ domain: 'audio-mix', operation: 'unregister-participant', participantId: id, outcome });
        if (removed) capabilities.emitEvent('audio-mix', 'participant-removed', { participantId: id });
        _touch();
        return removed ? _handled({ participantId: id, removed: true }) : _noHandler(`Unknown mix participant: ${id}`, { participantId: id, removed: false });
    }

    function registerInputSource(spec) {
        const source = _plainObject(spec);
        if (source.incompatible || (source.version && Number(source.version) !== 1)) {
            const result = _incompatibleVersion('Input source requires audio-session contract version 1');
            _recordOutcome({ domain: 'audio-input', operation: 'register-source', participantId: source.providerId, providerId: source.providerId, outcome: result.outcome, reason: result.reason });
            _touch();
            return result;
        }
        const input = _normalizeSource(source);
        if (!input) {
            const result = _failed('Input source registration requires sourceId, providerId, and logicalSourceKey');
            _recordOutcome({ domain: 'audio-input', operation: 'register-source', outcome: result.outcome, reason: result.reason });
            _touch();
            return result;
        }
        // The logical key is surfaced verbatim in redaction-safe diagnostics, so the contract
        // requires it to already be redaction-safe. Reject a key that _boundedReason would alter
        // (a path, token, whitespace, or over-long value) rather than silently leaking it.
        const boundedLogicalKey = _boundedReason(input.logicalSourceKey);
        if (boundedLogicalKey !== input.logicalSourceKey) {
            const result = _failed('Input source logicalSourceKey must be redaction-safe');
            _recordOutcome({ domain: 'audio-input', operation: 'register-source', participantId: input.providerId, providerId: input.providerId, logicalSourceKey: boundedLogicalKey, outcome: result.outcome, status: 'unsafe-key', reason: result.reason });
            _touch();
            return result;
        }
        // sourceId is the global Map key, so a sourceId already owned by a different provider would
        // silently overwrite that provider's record. Reject the collision instead — providers must
        // namespace sourceId to be globally unique (the stable cross-provider handle is logicalSourceKey).
        const existingById = currentSession.inputSources.get(input.sourceId);
        if (existingById && existingById.providerId !== input.providerId) {
            const result = _failed('Input source sourceId collides with another provider; sourceId must be globally unique');
            _recordOutcome({ domain: 'audio-input', operation: 'register-source', participantId: input.providerId, providerId: input.providerId, sourceId: input.sourceId, logicalSourceKey: input.logicalSourceKey, outcome: result.outcome, status: 'sourceid-collision', reason: result.reason });
            _touch();
            return result;
        }
        const provider = _normalizeInputProvider(source, input);
        const existingByRecord = Array.from(currentSession.inputSources.values()).find(item => _sourceRecordKey(item) === _sourceRecordKey(input));
        const existing = currentSession.inputSources.get(input.sourceId) || existingByRecord || null;
        const previousAvailability = existing && existing.availability;
        if (existing && existing.sourceId !== input.sourceId) {
            currentSession.inputSources.delete(existing.sourceId);
            knownInputSources.delete(existing.sourceId);
        }
        if (existing) {
            input.registeredAt = existing.registeredAt;
            input.selected = existing.selected;
        }
        currentSession.inputSources.set(input.sourceId, input);
        knownInputSources.set(input.sourceId, input);
        _refreshInputDuplicateSuppression();
        _recordInputDuplicateSuppression();
        const pseudonymize = _newPseudonymizer();
        const summary = _redactedSource(input, pseudonymize);
        const returned = _clone(summary);
        _recordOutcome({ domain: 'audio-input', operation: 'register-source', participantId: input.providerId, providerId: provider.providerId, sourceId: input.sourceId, logicalSourceKey: input.logicalSourceKey, outcome: 'handled', status: input.availability });
        capabilities.emitEvent('audio-input', 'source-registered', summary);
        if (previousAvailability && previousAvailability !== input.availability) capabilities.emitEvent('audio-input', 'source-availability-changed', summary);
        _touch();
        return _handled(returned);
    }

    function unregisterInputSource(query) {
        const payload = typeof query === 'string' ? { sourceId: query } : _plainObject(query);
        const source = _findInputSource(payload);
        const removed = source ? currentSession.inputSources.delete(source.sourceId) : false;
        if (source) knownInputSources.delete(source.sourceId);
        const outcome = removed ? 'handled' : 'no-handler';
        _refreshInputDuplicateSuppression();
        _recordOutcome({ domain: 'audio-input', operation: 'unregister-source', participantId: source && source.providerId, providerId: source && source.providerId, sourceId: source && source.sourceId, logicalSourceKey: source && source.logicalSourceKey, outcome });
        const pseudonymize = _newPseudonymizer();
        // Only a raw sourceId is pseudonymized; logicalSourceKey/providerId are redaction-safe and
        // echoed back so a miss still tells the caller which source it was looking for.
        const resolvedSourceId = source ? source.sourceId : _string(payload.sourceId || payload.id);
        const redacted = {
            sourceId: resolvedSourceId ? pseudonymize(resolvedSourceId, 'source') : '',
            // On a miss these come straight from an untrusted caller — bound them so a path/token
            // cannot land in the echoed payload or diagnostics. Resolved-source values are safe.
            logicalSourceKey: source ? source.logicalSourceKey : _boundedReason(payload.logicalSourceKey || payload.logicalKey || payload.sourceKey),
            providerId: source ? source.providerId : _boundedReason(payload.providerId),
            removed,
        };
        if (removed) capabilities.emitEvent('audio-input', 'source-removed', redacted);
        _touch();
        return removed ? _handled(_clone(redacted)) : _noHandler('Unknown input source', redacted);
    }

    function selectInputSource(query, requester = 'unknown') {
        const payload = typeof query === 'string' ? { sourceId: query } : _plainObject(query);
        const selected = _findInputSource(payload);
        // Bound/sanitize the requester before it reaches redaction-safe diagnostics, consistent
        // with open/close-source attribution.
        const requesterId = _requesterId(requester, 'unknown');
        // A caller-provided logical key is only *supposed* to be redaction-safe; bound it before it
        // reaches diagnostics or the echoed payload in case the caller passed a path/token.
        const requestedLogicalKey = _boundedReason(payload.logicalSourceKey || payload.logicalKey || payload.sourceKey);
        const requestedSourceId = _string(payload.sourceId || payload.id);
        if (!selected) {
            const missingSourceId = requestedSourceId ? _newPseudonymizer()(requestedSourceId, 'source') : '';
            const result = _degraded('Input source is unavailable', { logicalSourceKey: requestedLogicalKey, sourceId: missingSourceId, availability: 'unavailable' });
            _recordOutcome({ domain: 'audio-input', operation: 'select-source', participantId: requesterId, requesterId, logicalSourceKey: requestedLogicalKey, outcome: result.outcome, status: 'unavailable', reason: result.reason });
            _touch();
            return result;
        }
        currentSession.selectedInput = _makeSelectedInput(selected, requesterId);
        currentSession.storageStatus = _writeSelectedLogicalSourceKey(selected.logicalSourceKey);
        _syncSelectedInput();
        const summary = _redactedSelectedInput(currentSession.selectedInput, _newPseudonymizer());
        _recordOutcome({ domain: 'audio-input', operation: 'select-source', participantId: requesterId, requesterId, providerId: selected.providerId, sourceId: selected.sourceId, logicalSourceKey: selected.logicalSourceKey, outcome: 'handled', status: selected.availability });
        capabilities.emitEvent('audio-input', 'source-selected', summary);
        _touch();
        return _handled(summary);
    }

    function listInputSources(payload = {}) {
        const includeUnavailable = payload.includeUnavailable !== false;
        const pseudonymize = _newPseudonymizer();
        const sources = _visibleInputSources()
            .filter(source => includeUnavailable || source.availability === 'available' || (currentSession.selectedInput && source.logicalSourceKey === currentSession.selectedInput.logicalSourceKey))
            .map(source => _redactedSource(source, pseudonymize));
        _recordOutcome({ domain: 'audio-input', operation: 'list-sources', participantId: OWNER_ID, outcome: 'handled', status: `${sources.length}` });
        return _handled({ sources, selected: _redactedSelectedInput(_syncSelectedInput(), pseudonymize), timeoutMs: INPUT_OPERATION_TIMEOUT_MS });
    }

    function inspectInput(payload = {}) {
        const snapshotData = snapshot().domains['audio-input'];
        if (payload.sourceId || payload.logicalSourceKey) {
            // Snapshot sourceIds are per-snapshot pseudonyms, so a raw sourceId can't match them.
            // Resolve the request to its source and pin the snapshot entry by stable, redaction-safe
            // identity (logicalSourceKey + provider + mode) — the snapshot still contains suppressed
            // duplicates, so a logicalSourceKey-only match could return a compatibility loser.
            const resolved = _findInputSource(payload);
            const logicalSourceKey = resolved ? resolved.logicalSourceKey : _string(payload.logicalSourceKey || payload.logicalKey || payload.sourceKey);
            const match = resolved
                ? snapshotData.sources.find(source => source.logicalSourceKey === resolved.logicalSourceKey && source.providerId === resolved.providerId && source.sourceMode === resolved.sourceMode)
                : (logicalSourceKey ? snapshotData.sources.find(source => source.logicalSourceKey === logicalSourceKey) : null);
            return _handled({ ...snapshotData, source: match || null });
        }
        return _handled(snapshotData);
    }

    async function enumerateInputSources(options = {}) {
        const payload = _plainObject(options);
        if (payload.explicit !== true && payload.userInitiated !== true) {
            const result = _denied('Source enumeration requires an explicit user/provider request');
            _recordOutcome({ domain: 'audio-input', operation: 'source.enumerate', participantId: payload.providerId || OWNER_ID, providerId: payload.providerId, outcome: result.outcome, reason: result.reason });
            _touch();
            return result;
        }
        const providers = Array.from(currentSession.inputProviders.values()).filter(provider => !payload.providerId || provider.providerId === payload.providerId);
        if (!providers.length) {
            const result = _noOwner('No input provider is available for source enumeration');
            _recordOutcome({ domain: 'audio-input', operation: 'source.enumerate', participantId: payload.providerId || OWNER_ID, providerId: payload.providerId, outcome: result.outcome, reason: result.reason });
            _touch();
            return result;
        }
        const registered = [];
        // Re-redact every registered source with one pseudonymizer so distinct sources get distinct,
        // stable pseudonyms across the whole enumerate response. registerInputSource() redacts each
        // payload with its own fresh pseudonymizer, which would otherwise emit duplicate `source-01`s.
        const pseudonymize = _newPseudonymizer();
        let handledAny = false;
        for (const provider of providers) {
            const handler = provider.operationHandlers && provider.operationHandlers['source.enumerate'];
            if (typeof handler !== 'function') continue;
            handledAny = true;
            try {
                const raw = await _withInputTimeout(handler({ providerId: provider.providerId, explicit: true, requesterId: _requesterId(payload.requesterId || payload.requester, 'enumerate') }), 'source.enumerate');
                const result = _providerOutcome(raw);
                // Preserve a provider's explicit non-handled outcome exactly (denied/failed/degraded/
                // no-owner/no-handler/unsupported-command/incompatible-version/overridden) instead of
                // treating it as an empty success or collapsing it to a generic degrade.
                if (result.outcome !== 'handled') {
                    const reason = _boundedReason(result.reason) || `Source enumeration ${result.outcome}`;
                    _recordOutcome({ domain: 'audio-input', operation: 'source.enumerate', participantId: provider.providerId, providerId: provider.providerId, outcome: result.outcome, status: result.status || result.outcome, reason });
                    _touch();
                    return { outcome: result.outcome, reason, payload: { providerId: provider.providerId } };
                }
                const list = Array.isArray(result.payload && result.payload.sources) ? result.payload.sources : [];
                for (const item of list) {
                    const response = registerInputSource({ ...item, providerId: item.providerId || provider.providerId, ownerPluginId: item.ownerPluginId || provider.ownerPluginId });
                    if (response.outcome !== 'handled') continue;
                    const stored = currentSession.inputSources.get(_string(item.sourceId || item.id));
                    registered.push(stored ? _redactedSource(stored, pseudonymize) : response.payload);
                }
            } catch (err) {
                const timedOut = !!(err && err.timedOut);
                const reason = timedOut ? 'Source enumeration timed out' : _boundedReason(err && err.message ? err.message : String(err));
                _recordOutcome({ domain: 'audio-input', operation: 'source.enumerate', participantId: provider.providerId, providerId: provider.providerId, outcome: 'failed', status: timedOut ? 'timeout' : 'failed', reason });
                _touch();
                return _failed(reason, { providerId: provider.providerId, timedOut });
            }
        }
        if (!handledAny) {
            // Providers exist but none expose a source.enumerate handler, so the explicit request
            // was a no-op — report it as no-handler rather than an empty success.
            const result = _noHandler('No input provider supports source enumeration');
            _recordOutcome({ domain: 'audio-input', operation: 'source.enumerate', participantId: payload.providerId || OWNER_ID, providerId: payload.providerId, outcome: result.outcome, status: 'no-handler', reason: result.reason });
            _touch();
            return result;
        }
        _recordOutcome({ domain: 'audio-input', operation: 'source.enumerate', participantId: payload.providerId || OWNER_ID, providerId: payload.providerId, outcome: 'handled', status: `${registered.length}` });
        _touch();
        return _handled({ sources: registered });
    }

    async function openInputSource(payload = {}, requester = 'unknown') {
        const source = _plainObject(payload);
        // Identity comes from the authenticated dispatch caller, never the payload —
        // a payload-supplied requesterId could otherwise spoof another requester and
        // misattribute or release shared open sessions it does not own.
        const requesterId = _requesterId(requester, 'unknown');
        const selectedInput = currentSession.selectedInput;
        if (!selectedInput) {
            const session = _inputSessionSummary({ requesterId, purpose: source.purpose, state: 'unavailable', reason: 'No selected input source is available' }, _newPseudonymizer());
            const result = _noOwner('No selected input source is available', session);
            _recordOutcome({ domain: 'audio-input', operation: 'open-source', participantId: requesterId, requesterId, outcome: result.outcome, status: 'not-selected', reason: result.reason });
            capabilities.emitEvent('audio-input', 'source-open-degraded', session);
            _touch();
            return result;
        }
        // open-source uses the selected source by default; an explicit logicalSourceKey/sourceId
        // may disambiguate but must resolve to the selected source — it must not silently switch.
        // Resolve the canonical winner for the selected logical key (duplicate suppression may have
        // changed which concrete source wins since selection), and compare the hint against its
        // sourceId — not just logicalSourceKey — so a non-selected native/compatibility duplicate
        // sharing the same logical key cannot be opened by passing its sourceId.
        const selectedSource = _findInputSource({ logicalSourceKey: selectedInput.logicalSourceKey });
        const hasHint = !!(source.logicalSourceKey || source.sourceId);
        const selected = hasHint ? _findInputSource(source) : selectedSource;
        if (!selectedSource) {
            // A source is selected but no matching source is registered (e.g. a restored selection
            // before its provider hydrates, or the provider unregistered). Report it as unavailable
            // rather than implying the requester asked for a different source.
            const selectedKey = _boundedReason(selectedInput.logicalSourceKey);
            const session = _inputSessionSummary({ logicalSourceKey: selectedKey, requesterId, purpose: source.purpose, state: 'unavailable', reason: 'Selected input source is unavailable' }, _newPseudonymizer());
            const result = _degraded('Selected input source is unavailable', session);
            _recordOutcome({ domain: 'audio-input', operation: 'open-source', participantId: requesterId, requesterId, logicalSourceKey: selectedKey, outcome: result.outcome, status: 'unavailable', reason: result.reason });
            capabilities.emitEvent('audio-input', 'source-open-degraded', session);
            _touch();
            return result;
        }
        if (!selected || selected.sourceId !== selectedSource.sourceId) {
            // Bound the caller-provided hint key, and echo a pseudonymized sourceId hint (callers often
            // disambiguate by sourceId) so the payload/snapshot can correlate it without leaking it.
            const hintKey = _boundedReason(source.logicalSourceKey);
            const hintSourceId = _string(source.sourceId || source.id);
            const session = _inputSessionSummary({ source: { logicalSourceKey: hintKey, sourceId: hintSourceId }, requesterId, purpose: source.purpose, state: 'unavailable', reason: 'Requested input source is not the selected source' }, _newPseudonymizer());
            const result = _degraded('Requested input source is not the selected source', session);
            _recordOutcome({ domain: 'audio-input', operation: 'open-source', participantId: requesterId, requesterId, sourceId: hintSourceId, logicalSourceKey: hintKey, outcome: result.outcome, status: 'unavailable', reason: result.reason });
            capabilities.emitEvent('audio-input', 'source-open-degraded', session);
            _touch();
            return result;
        }
        if (selected.availability !== 'available') {
            // Emit an OpenInputSessionSummary-shaped payload (with requester attribution) for a
            // denied/unavailable selected source too, so consumers see one consistent event schema
            // across pre-marked and provider-reported denials.
            const reason = _boundedReason(selected.reason) || (selected.availability === 'denied' ? 'Input permission denied' : `Input source is ${selected.availability}`);
            const session = _inputSessionSummary({ source: selected, requesterId, purpose: source.purpose, channelShape: selected.channelSummary && selected.channelSummary.channelShape, state: selected.availability, reason }, _newPseudonymizer());
            const result = selected.availability === 'denied' ? _denied(reason, session) : _degraded(reason, session);
            _recordOutcome({ domain: 'audio-input', operation: 'open-source', participantId: requesterId, requesterId, providerId: selected.providerId, sourceId: selected.sourceId, logicalSourceKey: selected.logicalSourceKey, outcome: result.outcome, status: selected.availability, reason: result.reason });
            capabilities.emitEvent('audio-input', result.outcome === 'denied' ? 'permission-denied' : 'source-open-degraded', session);
            _touch();
            return result;
        }
        const requiredShape = _requiredChannelShape(source.requiredChannelShape || source.channelShape || source.channel);
        const compatible = _channelCompatible(selected.channelSummary, requiredShape);
        if (!compatible.ok) {
            const session = _inputSessionSummary({ source: selected, requesterId, purpose: source.purpose, channelShape: compatible.channelShape, state: 'incompatible', reason: 'Selected source cannot satisfy requested channel shape' }, _newPseudonymizer());
            const result = _degraded(session.reason, session);
            _recordOutcome({ domain: 'audio-input', operation: 'open-source', participantId: requesterId, requesterId, providerId: selected.providerId, sourceId: selected.sourceId, logicalSourceKey: selected.logicalSourceKey, outcome: result.outcome, status: 'incompatible', reason: result.reason });
            capabilities.emitEvent('audio-input', 'source-open-degraded', session);
            _touch();
            return result;
        }
        const channelShape = compatible.channelShape;
        const key = _openSessionKey(selected.logicalSourceKey, channelShape);
        const existing = currentSession.openInputSessions.get(key);
        if (existing && existing.state === 'open') {
            if (!existing.requesters.some(item => item.requesterId === requesterId)) existing.requesters.push(_requesterRef(requesterId, source.purpose));
            existing.lastUsedAt = _now();
            const summary = _redactedOpenSession(existing, _newPseudonymizer());
            _recordOutcome({ domain: 'audio-input', operation: 'open-source', participantId: requesterId, requesterId, providerId: selected.providerId, sourceId: selected.sourceId, logicalSourceKey: selected.logicalSourceKey, openSessionId: existing.openSessionId, outcome: 'handled', status: 'open' });
            _touch();
            return _handled(summary);
        }
        const provider = currentSession.inputProviders.get(selected.providerId);
        if (!provider) {
            const session = _inputSessionSummary({ source: selected, requesterId, purpose: source.purpose, state: 'no-owner', reason: 'No provider owns the selected input source' }, _newPseudonymizer());
            const result = _noOwner('No provider owns the selected input source', session);
            _recordOutcome({ domain: 'audio-input', operation: 'open-source', participantId: requesterId, requesterId, sourceId: selected.sourceId, logicalSourceKey: selected.logicalSourceKey, outcome: result.outcome, status: 'no-owner', reason: result.reason });
            capabilities.emitEvent('audio-input', 'source-open-degraded', session);
            _touch();
            return result;
        }
        if (provider.version !== 1) {
            const result = _incompatibleVersion('Input provider requires audio-session contract version 1');
            _recordOutcome({ domain: 'audio-input', operation: 'open-source', participantId: requesterId, requesterId, providerId: provider.providerId, sourceId: selected.sourceId, logicalSourceKey: selected.logicalSourceKey, outcome: result.outcome, status: 'incompatible-version', reason: result.reason });
            _touch();
            return result;
        }
        const handler = provider.operationHandlers && provider.operationHandlers['source.open'];
        if (!provider.operations.includes('source.open')) {
            const result = _unsupportedCommand('Selected input provider does not support source.open');
            _recordOutcome({ domain: 'audio-input', operation: 'open-source', participantId: requesterId, requesterId, providerId: provider.providerId, sourceId: selected.sourceId, logicalSourceKey: selected.logicalSourceKey, outcome: result.outcome, status: 'unsupported-command', reason: result.reason });
            _touch();
            return result;
        }
        if (typeof handler !== 'function') {
            const result = _noHandler('Selected input provider has no source.open handler');
            _recordOutcome({ domain: 'audio-input', operation: 'open-source', participantId: requesterId, requesterId, providerId: provider.providerId, sourceId: selected.sourceId, logicalSourceKey: selected.logicalSourceKey, outcome: result.outcome, status: 'no-handler', reason: result.reason });
            _touch();
            return result;
        }
        const openSession = {
            openSessionId: _id('input-open'),
            logicalSourceKey: selected.logicalSourceKey,
            sourceId: selected.sourceId,
            providerId: selected.providerId,
            channelShape,
            state: 'opening',
            requesters: [_requesterRef(requesterId, source.purpose)],
            openedAt: '',
            lastUsedAt: _now(),
            closedAt: '',
            reason: '',
            key,
        };
        try {
            const raw = await _withInputTimeout(handler({ sourceId: selected.sourceId, logicalSourceKey: selected.logicalSourceKey, requesterId, requiredChannelShape: channelShape, purpose: source.purpose }), 'source.open');
            const providerResult = _providerOutcome(raw);
            openSession.state = providerResult.outcome === 'handled' ? 'open' : (providerResult.status || providerResult.outcome);
            openSession.reason = providerResult.reason;
            if (providerResult.outcome === 'handled') {
                openSession.openedAt = _now();
                currentSession.openInputSessions.set(key, openSession);
                const summary = _redactedOpenSession(openSession, _newPseudonymizer());
                _recordOutcome({ domain: 'audio-input', operation: 'open-source', participantId: requesterId, requesterId, providerId: provider.providerId, sourceId: selected.sourceId, logicalSourceKey: selected.logicalSourceKey, openSessionId: openSession.openSessionId, outcome: 'handled', status: 'open' });
                capabilities.emitEvent('audio-input', 'source-opened', summary);
                _touch();
                return _handled(summary);
            }
            const summary = _redactedOpenSession(openSession, _newPseudonymizer());
            _recordOutcome({ domain: 'audio-input', operation: 'open-source', participantId: requesterId, requesterId, providerId: provider.providerId, sourceId: selected.sourceId, logicalSourceKey: selected.logicalSourceKey, openSessionId: openSession.openSessionId, outcome: providerResult.outcome, status: openSession.state, reason: providerResult.reason });
            capabilities.emitEvent('audio-input', providerResult.outcome === 'denied' ? 'permission-denied' : 'source-open-degraded', summary);
            _touch();
            if (providerResult.outcome === 'denied') return _denied(providerResult.reason || 'Input permission denied', summary);
            if (providerResult.outcome === 'failed') return _failed(providerResult.reason || 'Input provider failed', summary);
            // Preserve the provider's exact non-handled outcome (no-handler/no-owner/unsupported-command/
            // incompatible-version/overridden/degraded) instead of collapsing it to a generic degrade.
            return { outcome: providerResult.outcome, reason: providerResult.reason || `Input open returned ${providerResult.outcome}`, payload: summary };
        } catch (err) {
            const timedOut = !!(err && err.timedOut);
            openSession.state = 'failed';
            openSession.reason = timedOut ? 'Input source open timed out' : _boundedReason(err && err.message ? err.message : String(err));
            const summary = _redactedOpenSession(openSession, _newPseudonymizer());
            _recordOutcome({ domain: 'audio-input', operation: 'open-source', participantId: requesterId, requesterId, providerId: provider.providerId, sourceId: selected.sourceId, logicalSourceKey: selected.logicalSourceKey, openSessionId: openSession.openSessionId, outcome: 'failed', status: timedOut ? 'timeout' : 'failed', reason: openSession.reason });
            capabilities.emitEvent('audio-input', 'source-open-degraded', summary);
            _touch();
            return _failed(openSession.reason, { ...summary, timedOut });
        }
    }

    async function closeInputSource(payload = {}, requester = 'unknown') {
        const source = _plainObject(payload);
        // Identity comes from the authenticated dispatch caller, never the payload, so a
        // caller cannot release a shared open-session reference it does not own.
        const requesterId = _requesterId(requester, 'unknown');
        // openSessionId may be caller-supplied on a miss; bound it (a generated `input-open-<n>` id is
        // unchanged) so it can't leak a path/token into diagnostics, and still match for lookup.
        const openSessionId = _boundedReason(source.openSessionId || source.id);
        // Accept the same logicalSourceKey aliases the other audio-input paths do.
        const logicalSourceKey = _string(source.logicalSourceKey || source.logicalKey || source.sourceKey);
        const hasExplicitChannelShape = source.requiredChannelShape != null || source.channelShape != null || source.channel != null;
        const requiredShape = _requiredChannelShape(source.requiredChannelShape || source.channelShape || source.channel);
        const key = logicalSourceKey ? _openSessionKey(logicalSourceKey, requiredShape) : '';
        let session = null;
        if (openSessionId) {
            session = Array.from(currentSession.openInputSessions.values()).find(item => item.openSessionId === openSessionId) || null;
        } else if (key && currentSession.openInputSessions.has(key)) {
            session = currentSession.openInputSessions.get(key);
        } else if (logicalSourceKey && !hasExplicitChannelShape) {
            // requiredChannelShape is optional, so the exact channel-shape key may not match the
            // shape the session was opened with. Only when the caller omitted the shape, fall back
            // to the logical source key — unambiguous only when a single session is open for it;
            // otherwise require shape/openSessionId. When a shape WAS given but didn't match, fall
            // through to "no match" rather than closing a differently-shaped session.
            const matches = Array.from(currentSession.openInputSessions.values()).filter(item => item.logicalSourceKey === logicalSourceKey);
            if (matches.length === 1) {
                session = matches[0];
            } else if (matches.length > 1) {
                const result = _failed('Multiple open input sessions match the logical source key; specify requiredChannelShape or openSessionId');
                _recordOutcome({ domain: 'audio-input', operation: 'close-source', participantId: requesterId, requesterId, logicalSourceKey, outcome: result.outcome, status: 'ambiguous', reason: result.reason });
                _touch();
                return result;
            }
        }
        if (!session) {
            const result = _noHandler('No matching open input session exists');
            _recordOutcome({ domain: 'audio-input', operation: 'close-source', participantId: requesterId, requesterId, openSessionId, outcome: result.outcome, status: 'missing', reason: result.reason });
            _touch();
            return result;
        }
        session.requesters = session.requesters.filter(item => item.requesterId !== requesterId);
        session.lastUsedAt = _now();
        if (session.requesters.length) {
            const summary = _redactedOpenSession(session, _newPseudonymizer());
            _recordOutcome({ domain: 'audio-input', operation: 'close-source', participantId: requesterId, requesterId, providerId: session.providerId, sourceId: session.sourceId, logicalSourceKey: session.logicalSourceKey, openSessionId: session.openSessionId, outcome: 'handled', status: 'open' });
            _touch();
            return _handled(summary);
        }
        const provider = currentSession.inputProviders.get(session.providerId);
        const handler = provider && provider.operationHandlers && provider.operationHandlers['source.close'];
        if (!provider || typeof handler !== 'function') {
            session.state = 'failed';
            session.reason = 'Selected input provider has no source.close handler';
            const summary = _redactedOpenSession(session, _newPseudonymizer());
            const result = _noHandler(session.reason, summary);
            _recordOutcome({ domain: 'audio-input', operation: 'close-source', participantId: requesterId, requesterId, providerId: session.providerId, sourceId: session.sourceId, logicalSourceKey: session.logicalSourceKey, openSessionId: session.openSessionId, outcome: result.outcome, status: 'no-handler', reason: result.reason });
            _touch();
            return result;
        }
        session.state = 'closing';
        try {
            const raw = await _withInputTimeout(handler({ sourceId: session.sourceId, logicalSourceKey: session.logicalSourceKey, openSessionId: session.openSessionId, requesterIds: [requesterId] }), 'source.close');
            const providerResult = _providerOutcome(raw);
            if (providerResult.outcome !== 'handled') {
                session.state = providerResult.status || providerResult.outcome;
                session.reason = providerResult.reason;
                const summary = _redactedOpenSession(session, _newPseudonymizer());
                _recordOutcome({ domain: 'audio-input', operation: 'close-source', participantId: requesterId, requesterId, providerId: session.providerId, sourceId: session.sourceId, logicalSourceKey: session.logicalSourceKey, openSessionId: session.openSessionId, outcome: providerResult.outcome, status: session.state, reason: providerResult.reason });
                _touch();
                if (providerResult.outcome === 'failed') return _failed(providerResult.reason || 'Input close failed', summary);
                // Preserve the provider's exact non-handled outcome instead of collapsing it to degraded.
                return { outcome: providerResult.outcome, reason: providerResult.reason || `Input close returned ${providerResult.outcome}`, payload: summary };
            }
            session.state = 'closed';
            session.closedAt = _now();
            const summary = _redactedOpenSession(session, _newPseudonymizer());
            currentSession.openInputSessions.delete(session.key || _openSessionKey(session.logicalSourceKey, session.channelShape));
            _recordOutcome({ domain: 'audio-input', operation: 'close-source', participantId: requesterId, requesterId, providerId: session.providerId, sourceId: session.sourceId, logicalSourceKey: session.logicalSourceKey, openSessionId: session.openSessionId, outcome: 'handled', status: 'closed' });
            capabilities.emitEvent('audio-input', 'source-closed', summary);
            _touch();
            return _handled(summary);
        } catch (err) {
            const timedOut = !!(err && err.timedOut);
            session.state = 'failed';
            session.reason = timedOut ? 'Input source close timed out' : _boundedReason(err && err.message ? err.message : String(err));
            const summary = _redactedOpenSession(session, _newPseudonymizer());
            _recordOutcome({ domain: 'audio-input', operation: 'close-source', participantId: requesterId, requesterId, providerId: session.providerId, sourceId: session.sourceId, logicalSourceKey: session.logicalSourceKey, openSessionId: session.openSessionId, outcome: 'failed', status: timedOut ? 'timeout' : 'failed', reason: session.reason });
            _touch();
            return _failed(session.reason, { ...summary, timedOut });
        }
    }

    function registerMonitoringProvider(spec) {
        const source = _plainObject(spec);
        if (source.incompatible || (source.version && Number(source.version) !== 1)) {
            const result = _incompatibleVersion('Monitoring provider requires audio-session contract version 1');
            _recordOutcome({ domain: 'audio-monitoring', operation: 'register-provider', participantId: source.providerId || source.id, providerId: source.providerId || source.id, outcome: result.outcome, reason: result.reason });
            return result;
        }
        const provider = _normalizeMonitoringProvider(source);
        if (!provider) {
            const result = _failed('Monitoring provider registration requires providerId');
            _recordOutcome({ domain: 'audio-monitoring', operation: 'register-provider', outcome: result.outcome, reason: result.reason });
            return result;
        }
        // logicalMonitoringKey is surfaced verbatim via list/inspect and persisted, so reject a key
        // that isn't redaction-safe (path/token) the same way audio-input guards logicalSourceKey.
        if (provider.logicalMonitoringKey && _boundedReason(provider.logicalMonitoringKey) !== provider.logicalMonitoringKey) {
            const result = _failed('Monitoring provider logicalMonitoringKey must be redaction-safe');
            _recordOutcome({ domain: 'audio-monitoring', operation: 'register-provider', participantId: provider.providerId, providerId: provider.providerId, outcome: result.outcome, status: 'unsafe-key', reason: result.reason });
            return result;
        }
        // providerId is the Map key surfaced in diagnostics/events; a different plugin claiming an
        // already-owned providerId must fail rather than silently overwrite it (mirrors audio-input's
        // sourceId-collision guard). Re-registration by the same owner is the normal idempotent update.
        const ownerCollision = currentSession.monitoringProviders.get(provider.providerId) || knownMonitoringProviders.get(provider.providerId);
        // Compute the effective new owner from the registration itself, defaulting to providerId — NOT
        // inheriting the existing owner the way _normalizeMonitoringProvider does. Otherwise a colliding
        // registration that omits ownerPluginId would silently inherit the original owner and bypass this.
        const effectiveNewOwner = _string(source.ownerPluginId || source.pluginId, '') || provider.providerId;
        if (ownerCollision && ownerCollision.ownerPluginId && ownerCollision.ownerPluginId !== effectiveNewOwner) {
            const result = _failed(`Monitoring provider ${provider.providerId} is already registered by ${_boundedReason(ownerCollision.ownerPluginId)}`);
            _recordOutcome({ domain: 'audio-monitoring', operation: 'register-provider', participantId: provider.providerId, providerId: provider.providerId, outcome: result.outcome, status: 'providerid-collision', reason: result.reason });
            return result;
        }
        const existingByKey = Array.from(currentSession.monitoringProviders.values()).find(item => item.logicalMonitoringKey === provider.logicalMonitoringKey && item.sourceMode === provider.sourceMode && item.providerId === provider.providerId);
        const existing = currentSession.monitoringProviders.get(provider.providerId) || existingByKey || null;
        const previousAvailability = existing && existing.availability;
        if (existing) provider.registeredAt = existing.registeredAt;
        currentSession.monitoringProviders.set(provider.providerId, provider);
        knownMonitoringProviders.set(provider.providerId, provider);
        _refreshMonitoringDuplicateSuppression();
        _recordMonitoringDuplicateSuppression();
        const summary = _summaryMonitoringProvider(provider);
        _recordOutcome({ domain: 'audio-monitoring', operation: 'register-provider', participantId: provider.providerId, providerId: provider.providerId, outcome: 'handled', status: provider.availability });
        capabilities.emitEvent('audio-monitoring', 'provider-registered', summary);
        if (previousAvailability && previousAvailability !== provider.availability) capabilities.emitEvent('audio-monitoring', 'provider-availability-changed', summary);
        _touch();
        return _handled(summary);
    }

    function unregisterMonitoringProvider(query) {
        const payload = typeof query === 'string' ? { providerId: query } : _plainObject(query);
        const provider = _findMonitoringProvider(payload);
        const id = provider ? provider.providerId : _string(payload.providerId || payload.id || payload.logicalMonitoringKey);
        const removed = provider ? currentSession.monitoringProviders.delete(provider.providerId) : false;
        if (provider) knownMonitoringProviders.delete(provider.providerId);
        if (removed) {
            for (const session of currentSession.monitoringSessions.values()) {
                if (session.providerId !== provider.providerId || (session.state !== 'active' && session.state !== 'degraded')) continue;
                session.state = 'orphaned';
                session.reason = 'Monitoring provider disappeared';
                session.updatedAt = _now();
                capabilities.emitEvent('audio-monitoring', 'monitoring-orphaned', _redactedMonitoringSession(session, _newPseudonymizer()));
            }
        }
        _refreshMonitoringDuplicateSuppression();
        const outcome = removed ? 'handled' : 'no-handler';
        _recordOutcome({ domain: 'audio-monitoring', operation: 'unregister-provider', participantId: id, providerId: id, outcome });
        if (removed) capabilities.emitEvent('audio-monitoring', 'provider-removed', { providerId: id, logicalMonitoringKey: provider.logicalMonitoringKey, removed: true });
        _touch();
        if (removed) return _handled({ providerId: id, logicalMonitoringKey: provider.logicalMonitoringKey, removed: true });
        // `id` here is caller-supplied (no provider matched), so bound it before reflecting it back.
        const safeId = _boundedReason(id);
        return _noHandler(`Unknown monitoring provider: ${safeId}`, { providerId: safeId, removed: false });
    }

    function selectMonitoringProvider(query, requester = 'unknown') {
        const payload = typeof query === 'string' ? { providerId: query } : _plainObject(query);
        const provider = _findMonitoringProvider(payload);
        // requestedKey is caller-supplied; bound it before echoing it back in the reason/payload.
        const requestedKey = _boundedReason(_string(payload.logicalMonitoringKey || payload.logicalKey || payload.monitoringKey || payload.providerId || payload.id));
        if (!provider || provider.supersededBy) {
            const result = _unavailable(`Monitoring provider is unavailable: ${requestedKey}`, { logicalMonitoringKey: requestedKey, availability: 'unavailable' });
            // No logicalSourceKey here: requestedKey is a monitoring key, not an audio-input logical
            // source key, and reusing that field would misrepresent the outcome in diagnostics. The
            // requested key is already present in the bounded reason.
            _recordOutcome({ domain: 'audio-monitoring', operation: 'select-provider', participantId: requester, requesterId: requester, outcome: result.outcome, status: 'unavailable', reason: result.reason });
            return result;
        }
        currentSession.selectedMonitoringProvider = _makeSelectedMonitoringProvider(provider, requester);
        currentSession.storageStatus = _writeSelectedLogicalMonitoringKey(provider.logicalMonitoringKey);
        _syncSelectedMonitoringProvider();
        const summary = _summarySelectedMonitoringProvider(currentSession.selectedMonitoringProvider);
        _recordOutcome({ domain: 'audio-monitoring', operation: 'select-provider', participantId: requester, requesterId: requester, providerId: provider.providerId, outcome: 'handled', status: provider.availability });
        capabilities.emitEvent('audio-monitoring', 'provider-selected', summary);
        _touch();
        return _handled(summary);
    }

    function listMonitoringProviders(payload = {}) {
        const includeUnavailable = payload.includeUnavailable !== false;
        const providers = _visibleMonitoringProviders()
            .filter(provider => includeUnavailable || provider.availability === 'available')
            .map(_summaryMonitoringProvider);
        _recordOutcome({ domain: 'audio-monitoring', operation: 'list-providers', participantId: OWNER_ID, outcome: 'handled', status: `${providers.length}` });
        return _handled({ providers, selectedProvider: _summarySelectedMonitoringProvider(_syncSelectedMonitoringProvider()), timeoutMs: MONITORING_OPERATION_TIMEOUT_MS });
    }

    function _resolveMonitoringProvider(payload = {}) {
        _refreshMonitoringDuplicateSuppression();
        const explicit = _findMonitoringProvider(payload);
        if (explicit && !explicit.supersededBy) return { outcome: 'handled', provider: explicit };
        const selected = _syncSelectedMonitoringProvider();
        if (selected && selected.providerId) {
            const selectedProvider = currentSession.monitoringProviders.get(selected.providerId);
            if (selectedProvider && !selectedProvider.supersededBy) return { outcome: 'handled', provider: selectedProvider };
        }
        const compatible = _visibleMonitoringProviders().filter(provider => provider.availability === 'available' || provider.availability === 'pending');
        if (compatible.length === 1) return { outcome: 'handled', provider: compatible[0] };
        if (compatible.length > 1) return { outcome: 'provider-selection-required', reason: 'Multiple compatible monitoring providers require an explicit provider choice', providers: compatible.map(_summaryMonitoringProvider) };
        return { outcome: 'no-owner', reason: 'No monitoring provider is available', providers: [] };
    }

    async function _refreshMonitoringStatuses(payload = {}) {
        const providers = _visibleMonitoringProviders().filter(provider => !payload.providerId || provider.providerId === payload.providerId);
        // Prompt-free status must not hand the raw device sourceId to providers: selectedInput.sourceId is
        // the raw input source id, so strip it (keep only the redaction-safe logicalSourceKey context).
        const statusSourceRef = { ..._monitoringSourceRef(currentSession.selectedInput || {}), sourceId: '' };
        // Refresh provider statuses concurrently: a single hung/slow provider must not serialize the
        // whole prompt-free inspect path into O(N * timeout). Each provider mutates only its own record.
        await Promise.allSettled(providers.map(async (provider) => {
            if (provider.version !== 1) return;
            const handler = provider.operationHandlers && provider.operationHandlers['monitoring.status'];
            if (!provider.operations.includes('monitoring.status') || typeof handler !== 'function') return;
            try {
                const raw = await _withMonitoringTimeout(handler({ providerId: provider.providerId, sourceRef: statusSourceRef }), 'monitoring.status');
                const result = _monitoringProviderOutcome(raw);
                if (result.payload && typeof result.payload === 'object') {
                    // result.status is a clamped/derived value: a non-state provider outcome (e.g.
                    // 'no-handler') resolves to 'unknown', which is itself a valid availability and would
                    // wrongly overwrite a healthy provider. Only let an explicit payload.availability or a
                    // genuine reported state drive availability; a derived 'unknown' preserves the prior value.
                    const statusAvailability = result.status && result.status !== 'unknown' ? result.status : '';
                    provider.availability = _availability(result.payload.availability || statusAvailability || provider.availability, provider.availability);
                    provider.directMonitor = _normalizeDirectMonitor(result.payload.directMonitor || provider.directMonitor || {});
                    provider.latencySummary = _normalizeLatencySummary(result.payload.latencySummary || provider.latencySummary || {});
                }
                provider.reason = result.reason || provider.reason;
                provider.lastChangedAt = _now();
                _recordOutcome({ domain: 'audio-monitoring', operation: 'status', participantId: provider.providerId, providerId: provider.providerId, outcome: result.outcome, status: result.status, reason: result.reason });
            } catch (err) {
                provider.availability = 'failed';
                provider.reason = err && err.timedOut ? 'Monitoring status timed out' : _boundedReason(err && err.message ? err.message : String(err));
                _recordOutcome({ domain: 'audio-monitoring', operation: 'status', participantId: provider.providerId, providerId: provider.providerId, outcome: 'failed', status: err && err.timedOut ? 'timeout' : 'failed', reason: provider.reason });
            }
        }));
        _syncSelectedMonitoringProvider();
        // An explicit status refresh mutates provider state/outcomes, so bump diagnostics freshness.
        _touch();
    }

    async function inspectMonitoring(payload = {}) {
        if (payload.refreshStatus === true || payload.includeStatus === true) await _refreshMonitoringStatuses(payload);
        const snapshotData = snapshot().domains['audio-monitoring'];
        if (payload.providerId || payload.logicalMonitoringKey) {
            const match = snapshotData.providers.find(provider => (payload.providerId && provider.providerId === payload.providerId) || (payload.logicalMonitoringKey && provider.logicalMonitoringKey === payload.logicalMonitoringKey));
            return _handled({ ...snapshotData, provider: match || null });
        }
        return _handled(snapshotData);
    }

    async function _ensureMonitoringInput(payload, requesterId) {
        const requiredChannelShape = _channelShape(payload.requiredChannelShape || payload.channelShape, 'unknown');
        // Always resolve through audio-input open-source and derive the monitoring sourceRef from its
        // redaction-safe payload — never the caller payload — so a caller can't bypass open-source
        // readiness/ownership or inject arbitrary sourceId/logicalSourceKey fields that would leak into
        // the shared session and other requesters' start() responses. openInputSource reuses an
        // already-open session for the selected source, so this does not double-open; openSessionId is the
        // only trusted cross-domain correlation.
        return openInputSource({ ...(payload.sourceRef || {}), logicalSourceKey: payload.logicalSourceKey || payload.sourceRef?.logicalSourceKey, sourceId: payload.sourceId || payload.sourceRef?.sourceId, requesterId, purpose: payload.purpose, requiredChannelShape }, requesterId);
    }

    function _blockingInputOutcome(openResult) {
        if (openResult.outcome === 'handled') return null;
        const payload = _plainObject(openResult.payload);
        const status = _string(payload.state || openResult.status, openResult.outcome);
        if (openResult.outcome === 'denied') return { outcome: 'denied', state: 'denied', reason: openResult.reason || 'Input permission denied' };
        if (status === 'incompatible') return { outcome: 'incompatible', state: 'failed', reason: openResult.reason || 'Selected source cannot satisfy requested channel shape' };
        if (openResult.outcome === 'no-owner') return { outcome: 'no-owner', state: 'unavailable', reason: openResult.reason || 'No selected input source is available' };
        if (openResult.outcome === 'failed') return { outcome: 'failed', state: 'failed', reason: openResult.reason || 'Input source failed to open' };
        return { outcome: 'unavailable', state: 'unavailable', reason: openResult.reason || 'Input source is unavailable' };
    }

    async function startMonitoring(spec = {}, requester = 'unknown') {
        const payload = _plainObject(spec);
        // Identity comes from the authenticated dispatch caller, never the payload — a
        // payload-supplied requesterId/source could otherwise spoof another requester and
        // misattribute or share a monitoring session it does not own (mirrors openInputSource).
        const requesterId = _requesterId(requester, 'unknown');
        const requiredChannelShape = _channelShape(payload.requiredChannelShape || payload.channelShape, 'unknown');
        const directMonitorPreference = payload.directMonitorPreference === 'muted' || payload.directMonitorPreference === 'unmuted' ? payload.directMonitorPreference : _readDirectMonitorPreference();
        const authorization = _authorizationMode(payload.authorization || payload.mode);
        capabilities.emitEvent('audio-monitoring', 'monitoring-start-requested', { requesterId, authorization, requiredChannelShape });

        const resolved = _resolveMonitoringProvider(payload);
        if (resolved.outcome !== 'handled') {
            const result = _monitoringResultFor(resolved.outcome, resolved.reason, { providers: resolved.providers || [] });
            _recordOutcome({ domain: 'audio-monitoring', operation: 'start', participantId: requesterId, requesterId, outcome: result.outcome, status: resolved.outcome, reason: result.reason });
            if (result.outcome === 'provider-selection-required') capabilities.emitEvent('audio-monitoring', 'provider-selection-required', result.payload);
            return result;
        }
        const provider = resolved.provider;
        const selectedRef = _monitoringSourceRef(payload.sourceRef || currentSession.selectedInput || {});
        const existing = _findCompatibleMonitoringSession(provider, selectedRef, requiredChannelShape, directMonitorPreference);
        if (existing) {
            // Attaching to a shared session must still honor this requester's direct-monitor requirement:
            // if it conflicts with the active preference, surface degraded (or unsupported-command when
            // strict) and annotate the requester ref, mirroring the fresh-start conflict handling.
            const attachRequirement = _directMonitorState(payload.directMonitorRequirement, 'unknown');
            const attachConflict = (attachRequirement === 'muted' || attachRequirement === 'unmuted') && attachRequirement !== directMonitorPreference;
            const attachOutcome = attachConflict ? (payload.directMonitorStrict === true ? 'unsupported-command' : 'degraded') : 'handled';
            const conflictReason = 'Direct-monitor requirement conflicts with user/default setting';
            if (!existing.requesters.some(item => item.requesterId === requesterId)) existing.requesters.push(_monitoringRequesterRef({ ...payload, requesterId, requiredChannelShape, directMonitorRequirement: attachRequirement, status: attachConflict ? attachOutcome : '', reason: attachConflict ? conflictReason : '' }));
            existing.lastUsedAt = _now();
            _recordOutcome({ domain: 'audio-monitoring', operation: 'start', participantId: requesterId, requesterId, providerId: provider.providerId, monitoringId: existing.monitoringId, outcome: attachOutcome, status: existing.state, reason: attachConflict ? conflictReason : '' });
            if (attachConflict) _emitMonitoringOutcome(attachOutcome, existing);
            _touch();
            return _monitoringResultFor(attachOutcome, attachConflict ? conflictReason : '', _clone(existing));
        }
        if (authorization !== 'user-action') {
            const result = _userActionRequired('Fresh monitoring start requires explicit user action', { requesterId, providerId: provider.providerId });
            _recordOutcome({ domain: 'audio-monitoring', operation: 'start', participantId: requesterId, requesterId, providerId: provider.providerId, outcome: result.outcome, status: 'user-action-required', reason: result.reason });
            // user-action-required is not a permission denial — emit a dedicated event (like
            // provider-selection-required) so subscribers don't conflate it with 'monitoring-denied'.
            capabilities.emitEvent('audio-monitoring', 'monitoring-user-action-required', result.payload);
            return result;
        }
        if (provider.availability !== 'available' && provider.availability !== 'pending') {
            const result = _unavailable(provider.reason || `Monitoring provider is ${provider.availability}`, _summaryMonitoringProvider(provider));
            _recordOutcome({ domain: 'audio-monitoring', operation: 'start', participantId: requesterId, requesterId, providerId: provider.providerId, outcome: result.outcome, status: provider.availability, reason: result.reason });
            capabilities.emitEvent('audio-monitoring', 'monitoring-unavailable', result.payload);
            return result;
        }
        if (provider.version !== 1) {
            const result = _incompatibleVersion('Monitoring provider requires audio-session contract version 1', _summaryMonitoringProvider(provider));
            _recordOutcome({ domain: 'audio-monitoring', operation: 'start', participantId: requesterId, requesterId, providerId: provider.providerId, outcome: result.outcome, status: 'incompatible-version', reason: result.reason });
            return result;
        }
        const openResult = await _ensureMonitoringInput(payload, requesterId);
        const blockingInput = _blockingInputOutcome(openResult);
        const sourceRef = _monitoringSourceRef(openResult.payload || payload.sourceRef || currentSession.selectedInput || {});
        if (blockingInput) {
            const session = {
                monitoringId: _string(payload.monitoringId || payload.id, _id('monitoring')),
                sessionKey: _monitoringSessionKey(provider, sourceRef, requiredChannelShape, directMonitorPreference),
                providerId: provider.providerId,
                logicalMonitoringKey: provider.logicalMonitoringKey,
                sourceRef,
                openInputSessionId: sourceRef.openSessionId || '',
                state: blockingInput.state,
                requesters: [_monitoringRequesterRef({ ...payload, requesterId, requiredChannelShape, status: blockingInput.outcome, reason: blockingInput.reason })],
                directMonitor: _normalizeDirectMonitor({ ...provider.directMonitor, preference: directMonitorPreference }),
                latencySummary: _clone(provider.latencySummary),
                reason: blockingInput.reason,
                startedAt: '',
                lastUsedAt: _now(),
                stoppedAt: '',
                updatedAt: _now(),
            };
            currentSession.monitoringSessions.set(session.monitoringId, session);
            _recordOutcome({ domain: 'audio-monitoring', operation: 'start', participantId: requesterId, requesterId, providerId: provider.providerId, monitoringId: session.monitoringId, logicalSourceKey: sourceRef.logicalSourceKey, sourceId: sourceRef.sourceId, openSessionId: sourceRef.openSessionId, outcome: blockingInput.outcome, status: session.state, reason: blockingInput.reason });
            _emitMonitoringOutcome(blockingInput.outcome, session);
            _touch();
            return _monitoringResultFor(blockingInput.outcome, blockingInput.reason, _clone(session));
        }
        if (!provider.operations.includes('monitoring.start')) {
            const result = _unsupportedCommand('Monitoring provider does not support monitoring.start', _summaryMonitoringProvider(provider));
            _recordOutcome({ domain: 'audio-monitoring', operation: 'start', participantId: requesterId, requesterId, providerId: provider.providerId, outcome: result.outcome, status: 'unsupported-command', reason: result.reason });
            return result;
        }
        const handler = provider.operationHandlers && provider.operationHandlers['monitoring.start'];
        if (typeof handler !== 'function') {
            const result = _noHandler('Monitoring provider has no monitoring.start handler', _summaryMonitoringProvider(provider));
            _recordOutcome({ domain: 'audio-monitoring', operation: 'start', participantId: requesterId, requesterId, providerId: provider.providerId, outcome: result.outcome, status: 'no-handler', reason: result.reason });
            return result;
        }
        const monitoringId = _string(payload.monitoringId || payload.id, _id('monitoring'));
        const directMonitorRequirement = _directMonitorState(payload.directMonitorRequirement, payload.directMonitorRequirement ? 'unknown' : 'unknown');
        const conflict = (directMonitorRequirement === 'muted' || directMonitorRequirement === 'unmuted') && directMonitorRequirement !== directMonitorPreference;
        try {
            const raw = await _withMonitoringTimeout(handler({ monitoringId, providerId: provider.providerId, requesterId, sourceRef, requiredChannelShape, directMonitorPreference, directMonitorRequirement }), 'monitoring.start');
            const providerResult = _monitoringProviderOutcome(raw, {}, true);
            // A provider that reports a terminal state (denied/unavailable/failed/stopped/orphaned) but a
            // 'handled' (or omitted) outcome must not be coerced into an active session — derive the
            // effective outcome from the reported state so the real condition surfaces. 'degraded' is
            // intentionally NOT promoted: it stays a handled start with session.state 'degraded'
            // (a working-but-degraded session), matching the established degraded contract.
            const reportedState = providerResult.status;
            const TERMINAL_MONITORING_STATES = ['denied', 'unavailable', 'failed', 'stopped', 'orphaned'];
            const effectiveOutcome = providerResult.outcome === 'handled' && TERMINAL_MONITORING_STATES.includes(reportedState)
                ? (reportedState === 'orphaned' ? 'failed' : reportedState)
                : providerResult.outcome;
            const baseState = effectiveOutcome === 'handled' ? (reportedState === 'degraded' ? 'degraded' : 'active') : _monitoringState(reportedState, effectiveOutcome === 'degraded' ? 'degraded' : effectiveOutcome);
            // The direct-monitor conflict only downgrades a session that the provider otherwise
            // accepted (handled/degraded). When the provider itself reported a terminal state the
            // real provider reason must win, so the conflict status/reason must NOT overwrite it.
            const conflictApplies = conflict && (effectiveOutcome === 'handled' || effectiveOutcome === 'degraded');
            const resultOutcome = conflictApplies ? (payload.directMonitorStrict === true ? 'unsupported-command' : 'degraded') : effectiveOutcome;
            const sessionState = conflictApplies && baseState === 'active' ? 'degraded' : baseState;
            const session = {
                monitoringId,
                sessionKey: _monitoringSessionKey(provider, sourceRef, requiredChannelShape, directMonitorPreference),
                providerId: provider.providerId,
                logicalMonitoringKey: provider.logicalMonitoringKey,
                sourceRef,
                openInputSessionId: sourceRef.openSessionId || '',
                state: sessionState,
                requesters: [_monitoringRequesterRef({ ...payload, requesterId, requiredChannelShape, directMonitorRequirement, status: conflictApplies ? resultOutcome : '', reason: conflictApplies ? 'Direct-monitor requirement conflicts with user/default setting' : '' })],
                directMonitor: _normalizeDirectMonitor({ ...((providerResult.payload && providerResult.payload.directMonitor) || provider.directMonitor || {}), preference: directMonitorPreference }),
                latencySummary: _normalizeLatencySummary((providerResult.payload && providerResult.payload.latencySummary) || provider.latencySummary || {}),
                reason: conflictApplies ? 'Direct-monitor requirement conflicts with user/default setting' : providerResult.reason,
                startedAt: sessionState === 'active' || sessionState === 'degraded' ? _now() : '',
                lastUsedAt: _now(),
                stoppedAt: '',
                updatedAt: _now(),
            };
            currentSession.monitoringSessions.set(monitoringId, session);
            provider.directMonitor = _normalizeDirectMonitor({ ...provider.directMonitor, ...session.directMonitor, preference: directMonitorPreference });
            provider.latencySummary = session.latencySummary;
            _recordOutcome({ domain: 'audio-monitoring', operation: 'start', participantId: requesterId, requesterId, providerId: provider.providerId, monitoringId, logicalSourceKey: sourceRef.logicalSourceKey, sourceId: sourceRef.sourceId, openSessionId: sourceRef.openSessionId, outcome: resultOutcome, status: session.state, reason: session.reason || providerResult.reason });
            _emitMonitoringOutcome(resultOutcome, session);
            _touch();
            return _monitoringResultFor(resultOutcome, session.reason || providerResult.reason || `Monitoring returned ${resultOutcome}`, _clone(session));
        } catch (err) {
            const reason = err && err.timedOut ? 'Monitoring start timed out' : _boundedReason(err && err.message ? err.message : String(err));
            const session = { monitoringId, sessionKey: _monitoringSessionKey(provider, sourceRef, requiredChannelShape, directMonitorPreference), providerId: provider.providerId, logicalMonitoringKey: provider.logicalMonitoringKey, sourceRef, openInputSessionId: sourceRef.openSessionId || '', state: 'failed', requesters: [_monitoringRequesterRef({ ...payload, requesterId, requiredChannelShape, status: 'failed', reason })], directMonitor: _normalizeDirectMonitor({ ...provider.directMonitor, preference: directMonitorPreference }), latencySummary: _clone(provider.latencySummary), reason, startedAt: '', lastUsedAt: _now(), stoppedAt: '', updatedAt: _now() };
            currentSession.monitoringSessions.set(monitoringId, session);
            _recordOutcome({ domain: 'audio-monitoring', operation: 'start', participantId: requesterId, requesterId, providerId: provider.providerId, monitoringId, outcome: 'failed', status: err && err.timedOut ? 'timeout' : 'failed', reason });
            _emitMonitoringOutcome('failed', session);
            _touch();
            return _failed(reason, { ..._clone(session), timedOut: !!(err && err.timedOut) });
        }
    }

    async function stopMonitoring(target, requester = 'unknown') {
        const payload = typeof target === 'object' ? _plainObject(target) : { monitoringId: target };
        const requesterId = _requesterId(requester, requester);
        const id = _string(payload.monitoringId || payload.id);
        // stopAll is a user-authoritative global stop (see the audio-monitoring control-plane contract).
        // Require an explicit user action so a background requester can't tear down everyone's monitoring
        // (a DoS); targeted stops remain ownership-scoped below.
        if (payload.stopAll && payload.authorization !== 'user-action') {
            const result = _userActionRequired('Stopping all monitoring sessions requires explicit user action', { requesterId });
            _recordOutcome({ domain: 'audio-monitoring', operation: 'stop', participantId: requesterId, requesterId, outcome: result.outcome, status: 'user-action-required', reason: result.reason });
            return result;
        }
        const sessions = payload.stopAll ? Array.from(currentSession.monitoringSessions.values()).filter(session => session.state === 'active' || session.state === 'degraded') : [currentSession.monitoringSessions.get(id)].filter(Boolean);
        if (!sessions.length) {
            // `id` is caller-supplied and didn't match a session; bound it before reflecting it back.
            const safeId = _boundedReason(id);
            const result = _noHandler(`Unknown monitoring session: ${safeId || 'active session'}`, { monitoringId: safeId });
            _recordOutcome({ domain: 'audio-monitoring', operation: 'stop', participantId: requesterId, requesterId, monitoringId: safeId, outcome: result.outcome, reason: result.reason });
            return result;
        }
        let lastResult = null;
        for (const session of sessions) {
            // A targeted stop may only release/tear down a session the caller actually owns —
            // otherwise any requester could end another's monitoring. `stopAll` is the documented
            // explicit user-authoritative global stop (see audio-monitoring-control-plane contract)
            // and is intentionally not ownership-scoped. An already-ownerless session (every requester
            // released, or a failed/timed-out final stop that emptied requesters before the provider
            // confirmed) has no owner left to protect, so any caller may retry the stop on it.
            if (!payload.stopAll && session.requesters.length > 0 && !session.requesters.some(item => item.requesterId === requesterId)) {
                lastResult = _noHandler('Requester does not own this monitoring session', { monitoringId: session.monitoringId });
                _recordOutcome({ domain: 'audio-monitoring', operation: 'stop', participantId: requesterId, requesterId, providerId: session.providerId, monitoringId: session.monitoringId, outcome: lastResult.outcome, status: 'not-owner', reason: lastResult.reason });
                continue;
            }
            const beforeCount = session.requesters.length;
            if (!payload.stopAll) session.requesters = session.requesters.filter(item => item.requesterId !== requesterId);
            if (!payload.stopAll && beforeCount > 1 && session.requesters.length > 0) {
                session.lastUsedAt = _now();
                _recordOutcome({ domain: 'audio-monitoring', operation: 'stop', participantId: requesterId, requesterId, providerId: session.providerId, monitoringId: session.monitoringId, outcome: 'handled', status: session.state });
                lastResult = _handled(_clone(session));
                continue;
            }
            const provider = currentSession.monitoringProviders.get(session.providerId) || knownMonitoringProviders.get(session.providerId);
            const handler = provider && provider.operationHandlers && provider.operationHandlers['monitoring.stop'];
            try {
                if (!provider) {
                    // Provider disappeared — we can't confirm the live capture actually stopped, so orphan
                    // the session and report no-owner rather than falsely claiming 'stopped'.
                    session.state = 'orphaned';
                    session.reason = 'Monitoring provider is no longer available';
                    session.updatedAt = _now();
                    _recordOutcome({ domain: 'audio-monitoring', operation: 'stop', participantId: requesterId, requesterId, providerId: session.providerId, monitoringId: session.monitoringId, outcome: 'no-owner', status: 'orphaned', reason: session.reason });
                    capabilities.emitEvent('audio-monitoring', 'monitoring-orphaned', _redactedMonitoringSession(session, _newPseudonymizer()));
                    lastResult = _noOwner(session.reason, _clone(session));
                    continue;
                }
                if (!provider.operations.includes('monitoring.stop')) {
                    // Provider advertises no stop operation — don't pretend the live capture stopped.
                    session.state = 'failed';
                    session.reason = 'Monitoring provider does not support monitoring.stop';
                    session.updatedAt = _now();
                    _recordOutcome({ domain: 'audio-monitoring', operation: 'stop', participantId: requesterId, requesterId, providerId: session.providerId, monitoringId: session.monitoringId, outcome: 'unsupported-command', status: 'unsupported-command', reason: session.reason });
                    lastResult = _unsupportedCommand(session.reason, _clone(session));
                    continue;
                }
                if (typeof handler === 'function') {
                    const raw = await _withMonitoringTimeout(handler({ monitoringId: session.monitoringId, providerId: session.providerId, requesterIds: Array.from(new Set(session.requesters.map(item => item.requesterId).concat(requesterId))), reason: payload.stopAll ? 'user-stop-all' : 'final-requester-released' }), 'monitoring.stop');
                    const providerResult = _monitoringProviderOutcome(raw, _clone(session));
                    // A 'handled'/'stopped' outcome paired with a terminal non-stopped status (failed/
                    // denied/unavailable/orphaned) must not be reported as a clean stop — derive the
                    // effective outcome from the reported state, mirroring startMonitoring.
                    const reportedState = providerResult.status;
                    const stopEffectiveOutcome = (providerResult.outcome === 'handled' || providerResult.outcome === 'stopped') && ['denied', 'unavailable', 'failed', 'orphaned'].includes(reportedState)
                        ? (reportedState === 'orphaned' ? 'failed' : reportedState)
                        : providerResult.outcome;
                    if (stopEffectiveOutcome !== 'handled' && stopEffectiveOutcome !== 'stopped') {
                        session.state = stopEffectiveOutcome === 'failed' ? 'failed' : _monitoringState(reportedState, stopEffectiveOutcome);
                        session.reason = providerResult.reason;
                        session.updatedAt = _now();
                        _recordOutcome({ domain: 'audio-monitoring', operation: 'stop', participantId: requesterId, requesterId, providerId: session.providerId, monitoringId: session.monitoringId, outcome: stopEffectiveOutcome, status: session.state, reason: providerResult.reason });
                        _emitMonitoringOutcome(stopEffectiveOutcome, session);
                        lastResult = _monitoringResultFor(stopEffectiveOutcome, providerResult.reason || `Monitoring stop returned ${stopEffectiveOutcome}`, _clone(session));
                        continue;
                    }
                } else {
                    // Provider advertises monitoring.stop but supplied no handler.
                    session.state = 'failed';
                    session.reason = 'Monitoring provider has no monitoring.stop handler';
                    _recordOutcome({ domain: 'audio-monitoring', operation: 'stop', participantId: requesterId, requesterId, providerId: session.providerId, monitoringId: session.monitoringId, outcome: 'no-handler', status: 'no-handler', reason: session.reason });
                    lastResult = _noHandler(session.reason, _clone(session));
                    continue;
                }
                session.state = 'stopped';
                session.stoppedAt = _now();
                session.updatedAt = _now();
                session.requesters = [];
                _recordOutcome({ domain: 'audio-monitoring', operation: 'stop', participantId: requesterId, requesterId, providerId: session.providerId, monitoringId: session.monitoringId, outcome: 'stopped', status: 'stopped' });
                capabilities.emitEvent('audio-monitoring', 'monitoring-stopped', _redactedMonitoringSession(session, _newPseudonymizer()));
                lastResult = _stopped('Monitoring stopped', _clone(session));
            } catch (err) {
                session.state = 'failed';
                session.reason = err && err.timedOut ? 'Monitoring stop timed out' : _boundedReason(err && err.message ? err.message : String(err));
                session.updatedAt = _now();
                _recordOutcome({ domain: 'audio-monitoring', operation: 'stop', participantId: requesterId, requesterId, providerId: session.providerId, monitoringId: session.monitoringId, outcome: 'failed', status: err && err.timedOut ? 'timeout' : 'failed', reason: session.reason });
                _emitMonitoringOutcome('failed', session);
                lastResult = _failed(session.reason, { ..._clone(session), timedOut: !!(err && err.timedOut) });
            }
        }
        _touch();
        return lastResult || _stopped('Monitoring stopped', {});
    }

    async function setDirectMonitoringState(payload = {}, requester = 'unknown') {
        const source = typeof payload === 'string' ? { state: payload } : _plainObject(payload);
        const state = _directMonitorState(source.state, 'unknown');
        // Identity comes from the authenticated dispatch caller, never the payload (anti-spoofing).
        const requesterId = _requesterId(requester, 'unknown');
        if (state !== 'muted' && state !== 'unmuted') {
            const result = _denied('Direct-monitor preference must be muted or unmuted', { state });
            _recordOutcome({ domain: 'audio-monitoring', operation: 'set-direct-monitor', participantId: requesterId, requesterId, outcome: result.outcome, status: 'invalid-state', reason: result.reason });
            return result;
        }
        currentSession.directMonitor = _normalizeDirectMonitor({ ...currentSession.directMonitor, state, preference: state, applied: false, lastChangedAt: _now() });
        currentSession.storageStatus = _writeDirectMonitorPreference(state);
        const activeSessions = Array.from(currentSession.monitoringSessions.values()).filter(session => session.state === 'active' || session.state === 'degraded');
        let outcome = 'handled';
        let reason = '';
        for (const session of activeSessions) {
            const provider = currentSession.monitoringProviders.get(session.providerId);
            const handler = provider && provider.operationHandlers && (provider.operationHandlers['monitoring.set-direct-monitor'] || provider.operationHandlers['direct-monitor.set']);
            const supports = provider && (provider.operations.includes('monitoring.set-direct-monitor') || provider.operations.includes('direct-monitor.set'));
            if (supports && typeof handler === 'function') {
                try {
                    const raw = await _withMonitoringTimeout(handler({ monitoringId: session.monitoringId, providerId: session.providerId, state, requesterId }), 'set-direct-monitor');
                    const result = _monitoringProviderOutcome(raw, session.directMonitor);
                    if (result.outcome !== 'handled' && result.outcome !== 'degraded') {
                        outcome = result.outcome;
                        reason = result.reason || reason;
                    }
                    // Only claim applied when the provider explicitly reports a directMonitor summary; a
                    // bare 'handled' doesn't confirm the hardware preference was actually applied.
                    session.directMonitor = _normalizeDirectMonitor((result.payload && result.payload.directMonitor) || { state, control: 'supported', preference: state, applied: false, reason: result.reason, lastChangedAt: _now() });
                } catch (err) {
                    outcome = 'failed';
                    reason = err && err.timedOut ? 'Direct-monitor apply timed out' : _boundedReason(err && err.message ? err.message : String(err));
                    session.directMonitor = _normalizeDirectMonitor({ state, control: 'unknown', preference: state, applied: false, reason, lastChangedAt: _now() });
                }
            } else {
                outcome = outcome === 'handled' ? 'unsupported-command' : outcome;
                reason = reason || 'Monitoring provider does not support direct-monitor control';
                session.directMonitor = _normalizeDirectMonitor({ state, control: 'unsupported', preference: state, applied: false, reason, lastChangedAt: _now() });
            }
            // The session key encodes the direct-monitor policy; refresh its policy segment to the new
            // user preference so a later start with this preference re-attaches to the live session
            // instead of failing to match and forking a duplicate (or returning user-action-required).
            session.sessionKey = String(session.sessionKey).split('::').slice(0, -1).concat(state).join('::');
            session.updatedAt = _now();
        }
        // Reflect the actual per-session apply results back into the domain-level summary so
        // snapshot().domains['audio-monitoring'].directMonitor and the emitted event are not stale
        // (the pre-call seed above optimistically set applied:false/unknown control). Derive from the
        // sessions' own directMonitor states — not the aggregate outcome — so a provider that returns
        // outcome:'handled' but directMonitor.applied:false is reported as not-applied.
        if (activeSessions.length) {
            const monitors = activeSessions.map(session => session.directMonitor || {});
            const applied = monitors.every(monitor => monitor.applied === true);
            const control = monitors.some(monitor => monitor.control === 'unsupported') ? 'unsupported'
                : monitors.some(monitor => monitor.control === 'unavailable') ? 'unavailable'
                : (monitors.every(monitor => monitor.control === 'supported') ? 'supported' : 'unknown');
            // Prefer the command-level error reason (unsupported/failed/timeout), else surface the first
            // per-session reason so a handled-but-not-applied provider note (e.g. 'hardware busy') isn't lost.
            const summaryReason = reason || monitors.map(monitor => monitor.reason).find(value => value) || '';
            currentSession.directMonitor = _normalizeDirectMonitor({ ...currentSession.directMonitor, state, preference: state, control, applied, reason: summaryReason, lastChangedAt: _now() });
        }
        const summary = { directMonitor: _clone(currentSession.directMonitor), sessions: activeSessions.map(_clone) };
        _recordOutcome({ domain: 'audio-monitoring', operation: 'set-direct-monitor', participantId: requesterId, requesterId, outcome, status: state, reason });
        // The event is broadcast to all observers, so emit redaction-safe sessions; the raw summary is
        // only returned to the (owning) dispatch caller.
        const eventPseudonymizer = _newPseudonymizer();
        capabilities.emitEvent('audio-monitoring', 'direct-monitor-changed', { directMonitor: _clone(currentSession.directMonitor), sessions: activeSessions.map(session => _redactedMonitoringSession(session, eventPseudonymizer)) });
        _touch();
        return _monitoringResultFor(outcome, reason || 'Direct-monitor preference updated', summary);
    }

    function registerStemOwner(owner) {
        const source = _plainObject(owner);
        const previousOwnerId = currentSession.stemOwner ? currentSession.stemOwner.ownerId : '';
        if (currentSession.stemOwner && source.availability && source.availability !== 'available') {
            for (const claim of currentSession.stemClaims.values()) {
                if (claim.state === 'active') {
                    claim.state = 'orphaned';
                    claim.updatedAt = _now();
                    capabilities.emitEvent('stems', 'claim-orphaned', _clone(claim));
                }
            }
        }
        currentSession.stemOwner = {
            ownerId: _string(source.ownerId || source.participantId || source.id, 'stems'),
            stemIds: _strings(source.stemIds),
            stemStates: _clone(source.stemStates || {}) || {},
            availability: _string(source.availability, 'available'),
        };
        // When the provider identity changes, retire the prior provider participant
        // so the stems pipeline/diagnostics don't keep a stale active provider.
        // Never retire the audio-session coordinator (OWNER_ID) itself.
        if (previousOwnerId && previousOwnerId !== currentSession.stemOwner.ownerId && previousOwnerId !== OWNER_ID && typeof capabilities.unregisterParticipant === 'function') {
            capabilities.unregisterParticipant(previousOwnerId, 'stems');
        }
        if (typeof capabilities.registerParticipant === 'function') {
            capabilities.registerParticipant(currentSession.stemOwner.ownerId, {
                stems: {
                    roles: ['provider'],
                    operations: ['stem.get-state', 'stem.apply-automation', 'stem.restore-automation'],
                    events: ['owner-available', 'owner-unavailable'],
                    kind: 'provider-coordinator',
                    mode: currentSession.stemOwner.availability === 'available' ? 'active' : 'disabled',
                    compatibility: 'none',
                    ownership: 'multi-provider',
                    safety: 'safe',
                    runtime: true,
                    version: 1,
                    description: 'Active Stems provider registered behind the audio-session coordinator.',
                },
            });
        }
        _recordOutcome({ domain: 'stems', operation: 'owner.register', participantId: currentSession.stemOwner.ownerId, outcome: 'handled', status: currentSession.stemOwner.availability });
        const ownerEvent = currentSession.stemOwner.availability === 'available' ? 'owner-available' : 'owner-unavailable';
        capabilities.emitEvent('stems', ownerEvent, _clone(currentSession.stemOwner));
        _touch();
        return _handled(_clone(currentSession.stemOwner));
    }

    function _pruneStemClaims() {
        // Bound claim growth for long-running/buggy sessions so snapshots and
        // diagnostics bundles stay small. Drop the oldest terminal-state claims
        // first (Map preserves insertion order); never drop an active claim.
        if (currentSession.stemClaims.size <= MAX_DOMAIN_ITEMS) return;
        for (const [claimId, claim] of currentSession.stemClaims) {
            if (currentSession.stemClaims.size <= MAX_DOMAIN_ITEMS) break;
            if (claim.state !== 'active') currentSession.stemClaims.delete(claimId);
        }
    }

    function muteStems(spec = {}) {
        if (!currentSession.stemOwner || currentSession.stemOwner.availability !== 'available') {
            const result = _noOwner('No active stem owner is available');
            _recordOutcome({ domain: 'stems', operation: 'mute', participantId: _string(spec.requester, ''), outcome: result.outcome, status: currentSession.stemOwner ? currentSession.stemOwner.availability : 'no-owner', reason: result.reason });
            return result;
        }
        const source = _plainObject(spec);
        const claimId = _string(source.claimId, _id('stem-claim'));
        const claim = {
            claimId,
            requesterId: _string(source.requester || source.requesterId, 'unknown'),
            targetStemIds: _strings(source.stemIds || source.targetStemIds),
            requestedAction: _string(source.action || source.requestedAction, 'mute'),
            restoreSnapshot: _clone(source.restoreSnapshot || currentSession.stemOwner.stemStates) || {},
            state: 'active',
            createdAt: _now(),
            updatedAt: _now(),
        };
        currentSession.stemClaims.set(claimId, claim);
        _pruneStemClaims();
        capabilities.claim({ capability: 'stems', claimId, requester: claim.requesterId, owner: currentSession.stemOwner.ownerId, target: { stemIds: claim.targetStemIds } });
        _recordOutcome({ domain: 'stems', operation: 'mute', participantId: claim.requesterId, outcome: 'handled' });
        capabilities.emitEvent('stems', 'automation-applied', _clone(claim));
        _touch();
        return _handled(_clone(claim));
    }

    function restoreStems(spec = {}) {
        const source = _plainObject(spec);
        const claimId = _string(source.claimId || source.id);
        const claim = currentSession.stemClaims.get(claimId);
        if (!claim) {
            const result = _noHandler(`Unknown stem automation claim: ${claimId}`);
            _recordOutcome({ domain: 'stems', operation: 'restore', participantId: source.requester, outcome: result.outcome, reason: result.reason });
            return result;
        }
        claim.state = source.overridden || claim.state === 'overridden' ? 'overridden' : 'restored';
        claim.updatedAt = _now();
        capabilities.release({ capability: 'stems', claimId, requester: source.requester || claim.requesterId });
        _recordOutcome({ domain: 'stems', operation: 'restore', participantId: source.requester || claim.requesterId, outcome: claim.state === 'overridden' ? 'overridden' : 'handled' });
        capabilities.emitEvent('stems', claim.state === 'overridden' ? 'automation-overridden' : 'automation-restored', _clone(claim));
        _touch();
        return claim.state === 'overridden' ? { outcome: 'overridden', payload: _clone(claim) } : _handled(_clone(claim));
    }

    function recordStemManualOverride(override = {}) {
        const source = _plainObject(override);
        const targets = _strings(source.stemIds || source.targetStemIds);
        const overriddenClaims = [];
        for (const claim of currentSession.stemClaims.values()) {
            if (claim.state !== 'active') continue;
            const claimTargets = Array.isArray(claim.targetStemIds) ? claim.targetStemIds : [];
            const matches = !targets.length || !claimTargets.length || claimTargets.some(stemId => targets.includes(stemId));
            if (!matches) continue;
            claim.state = 'overridden';
            claim.updatedAt = _now();
            overriddenClaims.push(_clone(claim));
            capabilities.emitEvent('stems', 'automation-overridden', _clone(claim));
        }
        if (typeof capabilities.recordUserOverride === 'function') {
            capabilities.recordUserOverride({ capability: 'stems', source: source.requester || 'user', target: { stemIds: targets }, reason: source.reason || 'Manual stem choice overrode automation' });
        }
        _recordOutcome({ domain: 'stems', operation: 'manual-override', participantId: source.requester || 'user', outcome: overriddenClaims.length ? 'overridden' : 'handled', status: overriddenClaims.length ? 'overridden' : 'no-active-claim', reason: source.reason });
        _touch();
        return { overriddenClaims };
    }

    function recordBridgeHit(bridge = {}) {
        const source = _plainObject(bridge);
        const domain = DOMAINS.includes(source.domain) ? source.domain : _string(source.capability, 'audio-mix');
        // Bridge entries are exported verbatim in snapshot().domains[].bridges, so bound the
        // caller-provided string fields (a legacy caller could pass a path/token-like value).
        const legacySurface = _boundedReason(source.legacySurface) || 'unknown';
        // Preserve the original bridgeId fallback key (`${domain}.legacy`, not `.unknown`) for stability.
        const bridgeId = _boundedReason(source.bridgeId || source.shimId) || `${domain}.${_boundedReason(source.legacySurface) || 'legacy'}`;
        const entry = {
            bridgeId,
            legacySurface,
            domain,
            participantId: _boundedReason(source.participantId || source.source || source.requester) || 'legacy-runtime',
            logicalSourceKey: _boundedReason(source.logicalSourceKey || source.logicalKey || source.sourceKey),
            outcome: _string(source.outcome, 'handled'),
            status: _string(source.status, 'used'),
            reason: _boundedReason(source.reason),
            hitCount: (currentSession.bridges.get(bridgeId)?.hitCount || 0) + 1,
            lastHitAt: _now(),
        };
        currentSession.bridges.set(bridgeId, entry);
        if (typeof capabilities.recordLegacyHit === 'function') {
            capabilities.recordLegacyHit({ capability: domain, legacySurface: entry.legacySurface, source: entry.participantId, reason: entry.reason, shimId: bridgeId });
        }
        _recordOutcome({ domain, operation: 'bridge-hit', participantId: entry.participantId, bridgeId, outcome: entry.outcome, status: entry.status, reason: entry.reason });
        capabilities.emitEvent(domain, 'bridge-hit', _clone(entry));
        _touch();
        return _clone(entry);
    }

    function _newPseudonymizer() {
        const seen = new Map();
        let count = 0;
        return function pseudonym(value, prefix = 'source') {
            const key = `${prefix}:${_string(value, prefix)}`;
            if (!seen.has(key)) {
                count += 1;
                seen.set(key, `${prefix}-${String(count).padStart(2, '0')}`);
            }
            return seen.get(key);
        };
    }

    function _redactedSource(source, pseudonymize) {
        // Per-bundle pseudonym (spec FR-011/SC-005: scoped to one export, not stable
        // across exports). Keyed off the unique sourceId — used only as an internal
        // pseudonymizer key, never exposed — so distinct sources stay distinct even
        // when they share a device label, and monitoring (also keyed off sourceId)
        // correlates within the bundle.
        const sourcePseudonym = pseudonymize(source.sourceId, 'source');
        return {
            sourceId: sourcePseudonym,
            logicalSourceKey: source.logicalSourceKey,
            providerId: source.providerId,
            ownerPluginId: source.ownerPluginId,
            kind: source.kind,
            label: source.label || sourcePseudonym,
            channelSummary: _clone(source.channelSummary),
            channelCount: source.channelCount,
            availability: source.availability,
            selected: !!source.selected,
            sourceMode: source.sourceMode,
            compatibilitySource: source.compatibilitySource || '',
            supersededBy: source.supersededBy ? pseudonymize(source.supersededBy, 'source') : '',
            reason: source.reason || '',
            lastSeenAt: source.lastSeenAt || '',
            diagnosticsPseudonym: sourcePseudonym,
        };
    }

    function _redactedSelectedInput(selected, pseudonymize) {
        if (!selected) return null;
        return {
            logicalSourceKey: selected.logicalSourceKey,
            sourceId: selected.sourceId ? pseudonymize(selected.sourceId, 'source') : '',
            providerId: selected.providerId || '',
            availability: selected.availability || 'unavailable',
            restored: !!selected.restored,
            restoreStatus: selected.restoreStatus || 'not-selected',
            selectedAt: selected.selectedAt || selected.lastSelectedAt || '',
            lastSelectedAt: selected.lastSelectedAt || '',
            lastRestoredAt: selected.lastRestoredAt || '',
            requesterId: selected.requesterId || '',
        };
    }

    function _inputSessionSummary(spec, pseudonymize) {
        const source = spec.source || {};
        const openSessionId = spec.openSessionId || _id('input-open');
        return {
            openSessionId,
            logicalSourceKey: source.logicalSourceKey || spec.logicalSourceKey || '',
            sourceId: source.sourceId ? pseudonymize(source.sourceId, 'source') : '',
            providerId: source.providerId || spec.providerId || '',
            channelShape: _channelShape(spec.channelShape, 'unknown'),
            state: _string(spec.state, 'open'),
            // Match _redactedOpenSession's requester shape ({ requesterId, purpose }) — no per-requester
            // openedAt — so degraded session summaries and real open sessions share one schema.
            requesters: [{ requesterId: _requesterId(spec.requesterId), purpose: _boundedReason(spec.purpose).slice(0, 80) }].filter(item => item.requesterId),
            reason: _boundedReason(spec.reason),
        };
    }

    function _redactedOpenSession(session, pseudonymize) {
        if (!session) return null;
        return {
            openSessionId: session.openSessionId,
            logicalSourceKey: session.logicalSourceKey,
            sourceId: session.sourceId ? pseudonymize(session.sourceId, 'source') : '',
            providerId: session.providerId,
            channelShape: session.channelShape,
            state: session.state,
            requesters: Array.isArray(session.requesters) ? session.requesters.map(requester => ({ requesterId: requester.requesterId, purpose: requester.purpose || '' })) : [],
            openedAt: session.openedAt || '',
            lastUsedAt: session.lastUsedAt || '',
            closedAt: session.closedAt || '',
            reason: session.reason || '',
        };
    }

    function _redactedMonitoringProvider(provider) {
        // supersededBy is a (normalized, redaction-safe) providerId, and providerId itself is surfaced
        // verbatim, so keep supersededBy verbatim too — pseudonymizing only it would break correlation
        // with the winning provider in the same snapshot (and diverges from the audio-input pattern).
        return _summaryMonitoringProvider(provider) || {};
    }

    function _redactedMonitoringSession(session, pseudonymize) {
        if (!session) return null;
        const sourceRef = _plainObject(session.sourceRef);
        // Keep an internally-generated `input-open-<n>` id verbatim so monitoring sessions still
        // correlate with audio-input openSessions[] in the same snapshot (and match the diagnostics
        // schema); pseudonymize anything else as defense-in-depth.
        const _openId = value => (value && /^input-open-\d+$/.test(value)) ? value : (value ? pseudonymize(value, 'input-open') : '');
        return {
            monitoringId: session.monitoringId ? pseudonymize(session.monitoringId, 'monitoring') : '',
            sessionKey: session.sessionKey ? pseudonymize(session.sessionKey, 'monitoring-session') : '',
            providerId: session.providerId || '',
            logicalMonitoringKey: session.logicalMonitoringKey || '',
            sourceRef: {
                logicalSourceKey: sourceRef.logicalSourceKey || '',
                sourceId: sourceRef.sourceId ? pseudonymize(sourceRef.sourceId, 'source') : '',
                providerId: sourceRef.providerId || '',
                availability: sourceRef.availability || '',
                channelShape: sourceRef.channelShape || '',
                openSessionId: _openId(sourceRef.openSessionId),
            },
            openInputSessionId: _openId(session.openInputSessionId),
            state: session.state || 'unknown',
            requesters: Array.isArray(session.requesters) ? session.requesters.map(requester => ({ requesterId: requester.requesterId, purpose: requester.purpose || '', requiredChannelShape: requester.requiredChannelShape || 'unknown', directMonitorRequirement: requester.directMonitorRequirement || 'unknown', status: requester.status || '', reason: requester.reason || '' })) : [],
            directMonitor: _clone(session.directMonitor),
            latencySummary: _clone(session.latencySummary),
            reason: _boundedReason(session.reason),
            startedAt: session.startedAt || '',
            lastUsedAt: session.lastUsedAt || '',
            stoppedAt: session.stoppedAt || '',
            updatedAt: session.updatedAt || '',
        };
    }

    function _redactedRoute(route, pseudonymize) {
        return {
            ...route,
            devicePseudonym: route.devicePseudonym ? pseudonymize(route.devicePseudonym, 'device') : '',
        };
    }

    function _domainBridges(domain) {
        return Array.from(currentSession.bridges.values()).filter(bridge => bridge.domain === domain).map(_clone);
    }

    function snapshot() {
        // One per-bundle pseudonymizer for the whole snapshot: sources correlate
        // within this export but pseudonyms are not stable across exports.
        const pseudonymize = _newPseudonymizer();
        _refreshInputDuplicateSuppression();
        _refreshMonitoringDuplicateSuppression();
        const inputSources = Array.from(currentSession.inputSources.values()).slice(-MAX_DOMAIN_ITEMS);
        const openInputSessions = Array.from(currentSession.openInputSessions.values()).slice(-MAX_DOMAIN_ITEMS);
        const monitoringProviders = Array.from(currentSession.monitoringProviders.values()).slice(-MAX_DOMAIN_ITEMS);
        const monitoringSessions = Array.from(currentSession.monitoringSessions.values()).slice(-MAX_DOMAIN_ITEMS);
        return {
            schema: SCHEMA,
            session: {
                sessionId: _redactString(currentSession.sessionId),
                playerId: currentSession.playerId,
                songKey: currentSession.songKey ? pseudonymize(currentSession.songKey, 'song') : '',
                songFormat: currentSession.songFormat,
                state: currentSession.state,
                route: _redactedRoute(currentSession.routeState, pseudonymize),
                analyser: _clone(currentSession.analyserState),
                createdAt: currentSession.createdAt,
                updatedAt: currentSession.updatedAt,
            },
            domains: {
                'audio-mix': {
                    state: currentSession.state,
                    participants: Array.from(currentSession.mixParticipants.values()).map(_summaryParticipant),
                    faders: _visibleFaderParticipants().map(participant => _summaryFader(participant)),
                    requiredKinds: Object.fromEntries(REQUIRED_MIX_KINDS.map(kind => [kind, Array.from(currentSession.mixParticipants.values()).some(participant => participant.kind === kind)])),
                    route: _redactedRoute(currentSession.routeState, pseudonymize),
                    analyser: _clone(currentSession.analyserState),
                    bridges: _domainBridges('audio-mix'),
                },
                'audio-input': {
                    sources: inputSources.map(source => _redactedSource(source, pseudonymize)),
                    selected: _redactedSelectedInput(_syncSelectedInput(), pseudonymize),
                    openSessions: openInputSessions.map(session => _redactedOpenSession(session, pseudonymize)),
                    totalSources: currentSession.inputSources.size,
                    totalOpenSessions: currentSession.openInputSessions.size,
                    storageStatus: currentSession.storageStatus || _storageStatus(),
                    bridges: _domainBridges('audio-input'),
                },
                'audio-monitoring': {
                    providers: monitoringProviders.map(provider => _redactedMonitoringProvider(provider)),
                    selectedProvider: _summarySelectedMonitoringProvider(_syncSelectedMonitoringProvider()),
                    sessions: monitoringSessions.map(session => _redactedMonitoringSession(session, pseudonymize)),
                    totalProviders: currentSession.monitoringProviders.size,
                    totalSessions: currentSession.monitoringSessions.size,
                    directMonitor: _clone(currentSession.directMonitor),
                    bridges: _domainBridges('audio-monitoring'),
                },
                stems: {
                    owner: _clone(currentSession.stemOwner),
                    claims: Array.from(currentSession.stemClaims.values()).map(_clone),
                    bridges: _domainBridges('stems'),
                },
            },
            recentOutcomes: currentSession.outcomes.map(outcome => _redactedOutcome(outcome, pseudonymize)),
        };
    }

    function _payload(ctx) {
        return _plainObject(ctx && ctx.payload);
    }

    function _target(ctx) {
        const target = _plainObject(ctx && ctx.target);
        return { ..._payload(ctx), ...target };
    }

    function _audioMixCommand(commandName, ctx = {}) {
        const payload = _target(ctx);
        if (commandName === 'inspect') return _handled(snapshot().domains['audio-mix']);
        if (commandName === 'list-faders') return listFaders();
        if (commandName === 'get-fader-value') return getFaderValue(payload);
        if (commandName === 'set-fader-value') return setFaderValue(payload);
        if (commandName === 'inspect-route') return _handled(_clone(snapshot().domains['audio-mix'].route));
        if (commandName === 'inspect-analyser') return _handled(_clone(snapshot().domains['audio-mix'].analyser));
        if (commandName === 'register-participant') return registerMixParticipant(payload);
        if (commandName === 'unregister-participant') return unregisterMixParticipant(payload.participantId || payload.id);
        return _degraded(`Unsupported audio-mix command: ${commandName}`);
    }

    function _audioInputCommand(commandName, ctx = {}) {
        const payload = _target(ctx);
        if (commandName === 'inspect') return inspectInput(payload);
        if (commandName === 'list-sources') return listInputSources(payload);
        if (commandName === 'register-source') return registerInputSource(payload);
        if (commandName === 'unregister-source') return unregisterInputSource(payload);
        if (commandName === 'select-source') return selectInputSource(payload, ctx.requester);
        if (commandName === 'open-source') return openInputSource(payload, ctx.requester);
        if (commandName === 'close-source') return closeInputSource(payload, ctx.requester);
        return _degraded(`Unsupported audio-input command: ${commandName}`);
    }

    function _audioMonitoringCommand(commandName, ctx = {}) {
        const payload = _target(ctx);
        if (commandName === 'inspect') return inspectMonitoring(payload);
        if (commandName === 'list-providers') return listMonitoringProviders(payload);
        if (commandName === 'register-provider') return registerMonitoringProvider(payload);
        if (commandName === 'unregister-provider') return unregisterMonitoringProvider(payload);
        if (commandName === 'select-provider') return selectMonitoringProvider(payload, ctx.requester);
        if (commandName === 'start') return startMonitoring(payload, ctx.requester);
        if (commandName === 'stop') return stopMonitoring(payload, ctx.requester);
        if (commandName === 'set-direct-monitor') return setDirectMonitoringState(payload, ctx.requester);
        return _degraded(`Unsupported audio-monitoring command: ${commandName}`);
    }

    function _stemsCommand(commandName, ctx = {}) {
        const payload = _target(ctx);
        if (commandName === 'inspect') {
            const stems = snapshot().domains.stems;
            return stems.owner ? _handled(stems) : _noOwner('No active stem owner is available', stems);
        }
        if (commandName === 'mute') return muteStems({ ...payload, requester: ctx.requester });
        if (commandName === 'restore') return restoreStems({ ...payload, requester: ctx.requester });
        return _degraded(`Unsupported stems command: ${commandName}`);
    }

    function _registerDomains() {
        capabilities.registerOwner('audio-mix', {
            pluginId: OWNER_ID,
            kind: 'provider-coordinator',
            commands: ['inspect', 'list-faders', 'get-fader-value', 'set-fader-value', 'inspect-route', 'inspect-analyser', 'register-participant', 'unregister-participant'],
            operations: ['fader.get-value', 'fader.set-value', 'analyser.get-summary', 'route.get-current'],
            events: ['participant-registered', 'participant-removed', 'fader-value-changed', 'fader-unavailable', 'route-changed', 'route-degraded', 'analyser-changed', 'analyser-unavailable', 'bridge-hit'],
            safety: 'safe',
            description: 'Coordinates the active player audio mix, route, fader participants, analyser inspection, and audio compatibility bridge usage.',
            handlers: {
                inspect: ctx => _audioMixCommand('inspect', ctx),
                'list-faders': ctx => _audioMixCommand('list-faders', ctx),
                'get-fader-value': ctx => _audioMixCommand('get-fader-value', ctx),
                'set-fader-value': ctx => _audioMixCommand('set-fader-value', ctx),
                'inspect-route': ctx => _audioMixCommand('inspect-route', ctx),
                'inspect-analyser': ctx => _audioMixCommand('inspect-analyser', ctx),
                'register-participant': ctx => _audioMixCommand('register-participant', ctx),
                'unregister-participant': ctx => _audioMixCommand('unregister-participant', ctx),
            },
        });
        capabilities.registerOwner('audio-input', {
            pluginId: OWNER_ID,
            kind: 'provider-coordinator',
            commands: ['inspect', 'list-sources', 'register-source', 'unregister-source', 'select-source', 'open-source', 'close-source'],
            operations: ['source.enumerate', 'source.describe', 'source.open', 'source.close'],
            events: ['source-registered', 'source-removed', 'source-selected', 'source-availability-changed', 'permission-denied', 'source-opened', 'source-open-degraded', 'source-closed', 'bridge-hit'],
            safety: 'sensitive',
            description: 'Coordinates redaction-safe input source identity, availability, selection, open-session state, and bridge diagnostics.',
            handlers: {
                inspect: ctx => _audioInputCommand('inspect', ctx),
                'list-sources': ctx => _audioInputCommand('list-sources', ctx),
                'register-source': ctx => _audioInputCommand('register-source', ctx),
                'unregister-source': ctx => _audioInputCommand('unregister-source', ctx),
                'select-source': ctx => _audioInputCommand('select-source', ctx),
                'open-source': ctx => _audioInputCommand('open-source', ctx),
                'close-source': ctx => _audioInputCommand('close-source', ctx),
            },
        });
        capabilities.registerOwner('audio-monitoring', {
            pluginId: OWNER_ID,
            kind: 'provider-coordinator',
            commands: ['inspect', 'list-providers', 'register-provider', 'unregister-provider', 'select-provider', 'start', 'stop', 'set-direct-monitor'],
            operations: ['monitoring.start', 'monitoring.stop', 'monitoring.status', 'monitoring.set-direct-monitor'],
            events: ['provider-registered', 'provider-removed', 'provider-availability-changed', 'provider-selected', 'provider-selection-required', 'monitoring-start-requested', 'monitoring-started', 'monitoring-degraded', 'monitoring-unavailable', 'monitoring-failed', 'monitoring-denied', 'monitoring-user-action-required', 'monitoring-stopped', 'monitoring-orphaned', 'direct-monitor-changed', 'permission-denied', 'bridge-hit'],
            safety: 'sensitive',
            description: 'Coordinates monitoring provider selection, live monitoring lifecycle, direct-monitor state, consent/availability state, and monitoring compatibility bridge diagnostics.',
            handlers: {
                inspect: ctx => _audioMonitoringCommand('inspect', ctx),
                'list-providers': ctx => _audioMonitoringCommand('list-providers', ctx),
                'register-provider': ctx => _audioMonitoringCommand('register-provider', ctx),
                'unregister-provider': ctx => _audioMonitoringCommand('unregister-provider', ctx),
                'select-provider': ctx => _audioMonitoringCommand('select-provider', ctx),
                start: ctx => _audioMonitoringCommand('start', ctx),
                stop: ctx => _audioMonitoringCommand('stop', ctx),
                'set-direct-monitor': ctx => _audioMonitoringCommand('set-direct-monitor', ctx),
            },
        });
        capabilities.registerParticipant(OWNER_ID, {
            stems: {
                roles: ['coordinator'],
                kind: 'provider-coordinator',
                commands: ['inspect', 'mute', 'restore'],
                operations: ['stem.get-state', 'stem.apply-automation', 'stem.restore-automation'],
                events: ['owner-available', 'owner-unavailable', 'automation-applied', 'automation-restored', 'automation-overridden', 'claim-orphaned', 'bridge-hit'],
                safety: 'safe',
                compatibility: 'none',
                ownership: 'multi-provider',
                runtime: true,
                version: 1,
                description: 'Coordinates the active Stems provider and temporary stem automation claims without taking ownership of stem playback.',
                handlers: {
                    inspect: ctx => _stemsCommand('inspect', ctx),
                    mute: ctx => _stemsCommand('mute', ctx),
                    restore: ctx => _stemsCommand('restore', ctx),
                },
            },
        });
    }

    function _registerBridgeMetadata() {
        if (typeof capabilities.registerCompatibilityShim !== 'function') return;
        const shims = [
            { shimId: 'audio-mix.fader-registry', capability: 'audio-mix', source: OWNER_ID, legacySurface: 'window.feedBack.audio.registerFader', reason: 'Legacy mixer faders are attributed as audio-mix participants.' },
            { shimId: 'audio-mix.song-volume', capability: 'audio-mix', source: OWNER_ID, legacySurface: 'applySongVolume', reason: 'Legacy song volume writes are attributed as audio-mix route/fader bridge hits.' },
            { shimId: 'audio-mix.analyser', capability: 'audio-mix', source: OWNER_ID, legacySurface: '3D Highway analyser fallback', reason: 'Legacy analyser taps are attributed until renderers request analyser providers through audio-mix.' },
            { shimId: 'audio-input.legacy-source', capability: 'audio-input', source: OWNER_ID, legacySurface: 'plugin/browser input source handoff', reason: 'Legacy input source handoffs are attributed while note-detection input providers migrate to audio-input.' },
            { shimId: 'audio-monitoring.audio-barrier', capability: 'audio-monitoring', source: OWNER_ID, legacySurface: 'window.feedBackAudioBarrier', reason: 'Legacy audio startup barriers are attributed as monitoring readiness bridges.' },
            { shimId: 'stems.master-volume', capability: 'stems', source: OWNER_ID, legacySurface: 'window.feedBack.stems.setMasterVolume', reason: 'Legacy Stems master volume calls are attributed while native owner operations are staged.' },
            { shimId: 'stems.private-state', capability: 'stems', source: OWNER_ID, legacySurface: 'plugin-specific Stems/NAM ducking handshake', reason: 'Existing stem automation requesters are tracked until they migrate to native claims.' },
        ];
        for (const shim of shims) capabilities.registerCompatibilityShim({ ...shim, status: 'active' });
    }

    function _contributeDiagnostics() {
        const diagnostics = window.feedBack && window.feedBack.diagnostics;
        if (diagnostics && typeof diagnostics.contribute === 'function') {
            try { diagnostics.contribute('audio-session', snapshot()); }
            catch (_) { /* diagnostics must not break playback */ }
        }
    }

    const api = {
        version: 1,
        startSession,
        stopSession,
        setRoute,
        setAnalyser,
        registerMixParticipant,
        unregisterMixParticipant,
        listFaders,
        getFaderValue,
        setFaderValue,
        registerInputSource,
        unregisterInputSource,
        selectInputSource,
        listInputSources,
        inspectInput,
        enumerateInputSources,
        openInputSource,
        closeInputSource,
        registerMonitoringProvider,
        unregisterMonitoringProvider,
        selectMonitoringProvider,
        listMonitoringProviders,
        inspectMonitoring,
        startMonitoring,
        stopMonitoring,
        setDirectMonitoringState,
        registerStemOwner,
        muteStems,
        restoreStems,
        recordStemManualOverride,
        recordBridgeHit,
        recordOutcome: (entry) => { const outcome = _recordOutcome(entry); _touch(); return _clone(outcome); },
        snapshot,
        getDiagnostics: snapshot,
    };

    window.feedBack.audioSession = api;
    _registerDomains();
    _registerBridgeMetadata();
    _contributeDiagnostics();
})();