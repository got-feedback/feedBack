// Core jobs capability domain host.
(function () {
    'use strict';

    window.slopsmith = window.slopsmith || {};
    const capabilities = window.slopsmith.capabilities;
    if (!capabilities || capabilities.version !== 1) return;
    if (window.slopsmith.jobs && window.slopsmith.jobs.version === 1) return;

    const SCHEMA = 'slopsmith.jobs.diagnostics.v1';
    const OWNER_ID = 'core.jobs';
    const SELECTED_PROVIDER_STORAGE_KEY = 'slopsmith.jobs.selectedProviders.v1';
    const RECOVERY_STORAGE_KEY = 'slopsmith.jobs.recoverableRefs.v1';
    const MAX_REASON = 240;
    const MAX_LABEL = 120;
    const MAX_HISTORY_PER_JOB = 50;
    const MAX_TERMINAL_JOBS = 20;
    const MIN_TERMINAL_RETAINED = 5;
    const MAX_OUTCOMES = 100;
    const MAX_BRIDGES = 100;
    const SNAPSHOT_BUDGET_BYTES = 64 * 1024;

    const STATES = Object.freeze({
        QUEUED: 'queued',
        RUNNING: 'running',
        PAUSED: 'paused',
        CANCELLATION_REQUESTED: 'cancellation-requested',
        CANCELLED: 'cancelled',
        COMPLETED: 'completed',
        FAILED: 'failed',
        PROVIDER_UNAVAILABLE: 'provider-unavailable',
        ORPHANED: 'orphaned',
    });
    const TERMINAL_STATES = new Set([STATES.CANCELLED, STATES.COMPLETED, STATES.FAILED, STATES.PROVIDER_UNAVAILABLE, STATES.ORPHANED]);
    const ACTIVE_STATES = new Set([STATES.QUEUED, STATES.RUNNING, STATES.PAUSED, STATES.CANCELLATION_REQUESTED]);
    const OUTCOMES = new Set([
        'handled', 'queued', 'denied', 'user-action-required', 'unavailable', 'no-owner', 'no-handler', 'no-target',
        'unsupported-command', 'unsupported-operation', 'incompatible', 'incompatible-version', 'provider-selection-required',
        'validation-failed', 'stale', 'cancelled', 'completed', 'failed', 'timeout', 'retry-started',
    ]);
    const ACTIONS = new Set(['enqueue', 'inspect', 'cancel', 'pause', 'resume', 'retry', 'recover']);
    const PRIORITIES = new Set(['user-approved-interactive', 'background-maintenance']);
    const AVAILABILITY = new Set(['available', 'unavailable', 'degraded', 'disabled', 'incompatible']);
    const FAILURE_CATEGORIES = new Set(['invalid-input', 'permission-denied', 'provider-unavailable', 'unsupported-operation', 'timeout', 'cancellation', 'external-dependency', 'storage', 'provider-failure', 'unknown']);
    const BRIDGE_IDS = new Set(['jobs.legacy-plugin-queue', 'jobs.legacy-status-screen', 'jobs.legacy-backend-route', 'jobs.legacy-progress-poll', 'jobs.legacy-update-flow']);
    const RAW_KEY_RE = /(^|_)(path|filename|file|url|token|secret|password|apiKey|api_key|command|commandLine|env|environment|artifact|media|audio|buffer|recording|handle|native|subprocess|payload|private|raw)(_|$)/i;

    let sequence = 0;
    let outcomeSequence = 0;
    const providers = new Map();
    const selectedProviders = new Map();
    const jobs = new Map();
    const terminalJobIds = [];
    const outcomes = [];
    const bridgeHits = [];
    const pendingRecoverableRefs = new Map();
    const memoryStorage = new Map();

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

    function _plainObject(value) {
        return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
    }

    function _strings(value) {
        const out = [];
        const seen = new Set();
        for (const item of Array.isArray(value) ? value : []) {
            const normalized = _string(item);
            if (!normalized || seen.has(normalized)) continue;
            seen.add(normalized);
            out.push(normalized);
        }
        return out;
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
        return _string(value)
            .replace(/\/Users\/[^\s/]+(?:\/[^\s]*)?/g, '[path]')
            .replace(/[A-Za-z]:\\[^\s]+/g, '[path]')
            .replace(/https?:\/\/[^\s?#]+[^\s]*/gi, '[url]')
            .replace(/\b(token|secret|password|api[_-]?key)=([^\s&]+)/gi, '$1=[redacted]')
            .replace(/\b[A-Za-z0-9._%+-]+\.(psarc|sloppak|wav|mp3|ogg|flac|zip|sqlite|db)\b/gi, '[file]')
            .replace(/\b(raw[-_ ]?artifact|raw[-_ ]?audio|audio[-_ ]?buffer|sample[s]?|waveform[s]?|recording[s]?|subprocess|native[-_ ]?handle|process[-_ ]?handle)\b/gi, '[private]')
            .replace(/\b(?:ffmpeg|vgmstream|rscli|python|node|uvicorn)\s+[^\n\r]*/gi, '[command]');
    }

    function _safeText(value, fallback = '', limit = MAX_REASON) {
        const normalized = _redactString(value).replace(/\s+/g, ' ').trim();
        return (normalized || fallback).slice(0, limit);
    }

    function _safeId(value, fallback = 'unknown') {
        return _string(value, fallback).replace(/[^A-Za-z0-9_.:-]+/g, '-').slice(0, 96) || fallback;
    }

    function _safeValue(value, depth = 0) {
        if (typeof value === 'string') return _safeText(value);
        if (value == null || typeof value === 'number' || typeof value === 'boolean') return value;
        if (typeof value === 'function') return undefined;
        if (depth > 6) return '[truncated]';
        if (Array.isArray(value)) return value.slice(0, 30).map(item => _safeValue(item, depth + 1)).filter(item => item !== undefined);
        if (typeof value === 'object') {
            const out = {};
            for (const [key, item] of Object.entries(value).slice(0, 40)) {
                if (RAW_KEY_RE.test(key)) continue;
                const safeItem = _safeValue(item, depth + 1);
                if (safeItem !== undefined) out[_safeText(key, 'field', 80)] = safeItem;
            }
            return out;
        }
        return '';
    }

    function _clone(value) {
        try { return JSON.parse(JSON.stringify(value)); }
        catch (_) { return null; }
    }

    function _storageGet(key) {
        try {
            if (window.localStorage && typeof window.localStorage.getItem === 'function') return window.localStorage.getItem(key);
        } catch (_) {}
        return memoryStorage.has(key) ? memoryStorage.get(key) : null;
    }

    function _storageSet(key, value) {
        const normalized = String(value == null ? '' : value);
        try {
            if (window.localStorage && typeof window.localStorage.setItem === 'function') {
                window.localStorage.setItem(key, normalized);
                return 'available';
            }
        } catch (_) {}
        memoryStorage.set(key, normalized);
        return 'memory-fallback';
    }

    function _storageRemove(key) {
        try {
            if (window.localStorage && typeof window.localStorage.removeItem === 'function') window.localStorage.removeItem(key);
        } catch (_) {}
        memoryStorage.delete(key);
    }

    function _readJsonStorage(key, fallback) {
        const raw = _storageGet(key);
        if (!raw) return fallback;
        try {
            const parsed = JSON.parse(raw);
            return parsed == null ? fallback : parsed;
        } catch (_) {
            return fallback;
        }
    }

    function _writeJsonStorage(key, value) {
        return _storageSet(key, JSON.stringify(value));
    }

    function _normalizeCapacity(value) {
        const source = _plainObject(value);
        return {
            maxRunning: Math.max(0, _number(source.maxRunning, 1) ?? 1),
            maxQueued: Math.max(0, _number(source.maxQueued, 100) ?? 100),
        };
    }

    function _normalizeRecoverySupport(value) {
        const source = _plainObject(value);
        return {
            queued: !!source.queued,
            running: !!source.running,
            paused: !!source.paused,
        };
    }

    function _normalizeProvider(raw) {
        const source = _plainObject(raw);
        const providerId = _safeId(source.providerId || source.id, '');
        const jobTypes = _strings(source.jobTypes || source.supportedJobTypes);
        const actions = _strings(source.actions || source.supportedActions).filter(action => ACTIONS.has(action));
        const availability = AVAILABILITY.has(source.availability) ? source.availability : 'available';
        return {
            providerId,
            pluginId: _safeId(source.pluginId || source.ownerPluginId || providerId, providerId || 'unknown'),
            label: _safeText(source.label || source.safeLabel || providerId, providerId, MAX_LABEL),
            jobTypes,
            actions: actions.length ? actions : ['enqueue', 'inspect'],
            availability,
            capacity: _normalizeCapacity(source.capacity),
            currentLoad: { running: 0, queued: 0 },
            selectionEligible: source.selectionEligible !== false,
            recoverySupport: _normalizeRecoverySupport(source.recoverySupport),
            safeReason: source.safeReason || source.reason ? _safeText(source.safeReason || source.reason) : null,
            operationHandlers: _plainObject(source.operationHandlers || source.handlers || source.operationsHandlers),
            version: _number(source.version, 1) || 1,
            logicalProviderKey: _safeId(source.logicalProviderKey || providerId, providerId || 'unknown'),
            lastSeenAt: _now(),
        };
    }

    function _providerSummary(provider) {
        const load = _providerLoad(provider.providerId);
        return {
            providerId: provider.providerId,
            pluginId: provider.pluginId,
            label: provider.label,
            jobTypes: provider.jobTypes.slice(),
            actions: provider.actions.slice(),
            availability: provider.availability,
            capacity: _clone(provider.capacity),
            currentLoad: load,
            recoverySupport: _clone(provider.recoverySupport),
            safeReason: provider.safeReason || null,
            lastSeenAt: provider.lastSeenAt,
        };
    }

    function _targetRef(target) {
        const source = _plainObject(target);
        const seed = source.targetRef || source.safeRef || source.safeFingerprint || source.id || source.kind || source.name || 'unknown';
        if (source.targetRef && /^[A-Za-z0-9_.:-]+$/.test(String(source.targetRef))) return String(source.targetRef).slice(0, 96);
        return `target-${_hash(seed)}`;
    }

    function _inputFingerprint(inputs) {
        const source = _plainObject(inputs);
        return _safeId(source.safeFingerprint || source.fingerprint || _hash(JSON.stringify(_safeValue(source))), 'input-unknown');
    }

    function _approvalScope(args, providerId) {
        const source = _plainObject(args);
        return {
            providerId,
            jobType: _safeId(source.jobType, 'unknown'),
            targetRef: _targetRef(source.target),
            requesterId: _safeId(source.requesterId || source.requester || source.source, 'unknown'),
            inputFingerprint: _inputFingerprint(source.inputs),
        };
    }

    function _scopeKey(scope) {
        return [scope.providerId, scope.jobType, scope.targetRef, scope.requesterId, scope.inputFingerprint].join('|');
    }

    function _priority(value) {
        return PRIORITIES.has(value) ? value : 'user-approved-interactive';
    }

    function _priorityRank(job) {
        return job.priority === 'user-approved-interactive' ? 0 : 1;
    }

    function _actionsAvailable(job) {
        if (!job || TERMINAL_STATES.has(job.state)) return job && job.retryable ? ['retry'] : [];
        const provider = providers.get(job.providerId);
        const providerActions = provider ? provider.actions : [];
        const actions = ['inspect'];
        if (job.state === STATES.QUEUED || job.state === STATES.RUNNING || job.state === STATES.PAUSED) {
            if (providerActions.includes('cancel') || job.state === STATES.QUEUED) actions.push('cancel');
        }
        if (job.state === STATES.RUNNING && providerActions.includes('pause')) actions.push('pause');
        if (job.state === STATES.PAUSED && providerActions.includes('resume')) actions.push('resume');
        return actions;
    }

    function _newAttempt(job, state) {
        return {
            attemptId: _id('attempt'),
            jobId: job.jobId,
            attemptNumber: job.attempts.length + 1,
            providerId: job.providerId,
            approvalScopeId: job.approvalScopeKey,
            state,
            startedAt: state === STATES.RUNNING ? _now() : null,
            updatedAt: _now(),
            terminalAt: null,
            terminalOutcome: null,
        };
    }

    function _newJob(args, providerId) {
        const now = _now();
        const scope = _approvalScope(args, providerId);
        const job = {
            jobId: _safeId(args.jobId, '') || _id('job'),
            logicalJobKey: _safeId(args.logicalJobKey || '', ''),
            jobType: _safeId(args.jobType, 'unknown'),
            providerId,
            requesterId: scope.requesterId,
            targetRef: scope.targetRef,
            inputFingerprint: scope.inputFingerprint,
            approvalScope: scope,
            approvalScopeKey: _scopeKey(scope),
            authorization: _safeId(args.authorization || 'none', 'none'),
            priority: _priority(args.priority || (args.authorization === 'background' ? 'background-maintenance' : 'user-approved-interactive')),
            safeLabel: _safeText(args.safeLabel || args.label || `${args.jobType || 'Job'} job`, 'Job', MAX_LABEL),
            state: STATES.QUEUED,
            progress: { mode: 'indeterminate', percent: null, step: '', message: '', updatedAt: now },
            attempts: [],
            history: [],
            retryable: false,
            safeReason: null,
            terminalOutcome: null,
            bridgeSource: args.bridgeSource ? _safeText(args.bridgeSource, '', 80) : null,
            createdAt: now,
            queuedAt: now,
            startedAt: null,
            updatedAt: now,
            terminalAt: null,
        };
        job.attempts.push(_newAttempt(job, STATES.QUEUED));
        return job;
    }

    function _jobSummary(job, options = {}) {
        return {
            jobId: job.jobId,
            jobType: job.jobType,
            providerId: job.providerId,
            requesterId: job.requesterId,
            targetRef: job.targetRef,
            inputFingerprint: job.inputFingerprint,
            state: job.state,
            priority: job.priority,
            safeLabel: job.safeLabel,
            progress: _clone(job.progress),
            actionsAvailable: _actionsAvailable(job),
            retryable: !!job.retryable,
            attempts: job.attempts.map(attempt => ({
                attemptId: attempt.attemptId,
                attemptNumber: attempt.attemptNumber,
                state: attempt.state,
                terminalOutcome: attempt.terminalOutcome,
            })),
            terminalOutcome: job.terminalOutcome ? _clone(job.terminalOutcome) : null,
            safeReason: job.safeReason || null,
            timestamps: {
                createdAt: job.createdAt,
                queuedAt: job.queuedAt,
                startedAt: job.startedAt,
                updatedAt: job.updatedAt,
                terminalAt: job.terminalAt,
            },
            history: options.includeHistory === false ? [] : job.history.slice(-MAX_HISTORY_PER_JOB).map(entry => _clone(entry)),
            bridgeSource: job.bridgeSource || null,
        };
    }

    function _providerLoad(providerId) {
        let running = 0;
        let queued = 0;
        for (const job of jobs.values()) {
            if (job.providerId !== providerId) continue;
            if (job.state === STATES.RUNNING || job.state === STATES.CANCELLATION_REQUESTED) running += 1;
            if (job.state === STATES.QUEUED) queued += 1;
        }
        return { running, queued };
    }

    function _rememberOutcome(operation, status, details = {}) {
        const normalized = OUTCOMES.has(status) ? status : 'handled';
        const entry = {
            seq: ++outcomeSequence,
            operation: _safeText(operation, 'operation', 80),
            jobId: details.jobId || null,
            providerId: details.providerId || null,
            requesterId: details.requesterId || null,
            status: normalized,
            category: details.category || null,
            safeReason: details.safeReason ? _safeText(details.safeReason) : null,
            timestamp: _now(),
        };
        outcomes.push(entry);
        while (outcomes.length > MAX_OUTCOMES) outcomes.shift();
        _contributeDiagnostics();
        return entry;
    }

    function _history(job, kind, message, extra = {}) {
        if (!job) return null;
        const entry = {
            entryId: `${job.jobId}-entry-${job.history.length + 1}`,
            jobId: job.jobId,
            attemptId: job.attempts[job.attempts.length - 1]?.attemptId || null,
            kind: _safeId(kind, 'event'),
            message: _safeText(message),
            timestamp: _now(),
            ..._safeValue(extra),
        };
        job.history.push(entry);
        while (job.history.length > MAX_HISTORY_PER_JOB) job.history.shift();
        job.updatedAt = _now();
        _persistRecoverableRefs();
        _contributeDiagnostics();
        return entry;
    }

    function _emitJobs(event, payload = {}) {
        if (capabilities && typeof capabilities.emitEvent === 'function') capabilities.emitEvent('jobs', event, _safeValue(payload));
    }

    function _result(outcome, payload = {}, reason = '') {
        return { outcome, payload: _safeValue(payload), reason: reason ? _safeText(reason) : undefined };
    }

    function _handled(payload = {}) { return _result('handled', payload); }

    function _callProvider(provider, operation, payload) {
        const handlers = provider && provider.operationHandlers ? provider.operationHandlers : {};
        const handler = handlers[operation] || handlers[operation.replace(/^job\./, '')];
        if (typeof handler !== 'function') return null;
        return handler(_safeValue(payload));
    }

    function _compatibleProviders(jobType) {
        return Array.from(providers.values()).filter(provider => {
            if (!provider.jobTypes.includes(jobType)) return false;
            if (provider.availability === 'disabled' || provider.availability === 'incompatible') return false;
            return true;
        });
    }

    function _providerCanRun(provider) {
        return provider && (provider.availability === 'available' || provider.availability === 'degraded');
    }

    function _resolveProvider(args) {
        const jobType = _safeId(args.jobType, '');
        if (!jobType) return { outcome: 'validation-failed', reason: 'jobType is required' };
        const explicitProviderId = _safeId(args.providerId || '', '');
        const compatible = _compatibleProviders(jobType);
        if (explicitProviderId) {
            const explicit = providers.get(explicitProviderId);
            if (!explicit) return { outcome: 'no-owner', reason: `Provider ${explicitProviderId} is not registered` };
            if (!explicit.jobTypes.includes(jobType)) return { outcome: 'no-handler', reason: `Provider ${explicitProviderId} does not handle ${jobType}` };
            if (explicit.availability === 'incompatible') return { outcome: 'incompatible-version', reason: explicit.safeReason || 'Provider is incompatible' };
            if (!_providerCanRun(explicit)) return { outcome: 'unavailable', reason: explicit.safeReason || 'Provider unavailable' };
            return { provider: explicit };
        }
        const runnable = compatible.filter(_providerCanRun);
        if (!compatible.length) return { outcome: 'no-owner', reason: `No provider handles ${jobType}` };
        if (!runnable.length) return { outcome: 'unavailable', reason: `No available provider handles ${jobType}` };
        if (runnable.length === 1) return { provider: runnable[0] };
        const selected = selectedProviders.get(jobType);
        if (selected && runnable.some(provider => provider.providerId === selected.providerId)) return { provider: providers.get(selected.providerId) };
        return { outcome: 'provider-selection-required', reason: `Multiple providers handle ${jobType}` };
    }

    function _authorizationAllowed(args, providerId) {
        if (args.privileged === false) return true;
        if (args.authorization === 'user-action') return true;
        if (args.authorization === 'approved-continuation') {
            const scope = _approvalScope(args, providerId);
            return _scopeKey(scope) === _safeId(args.approvalScopeKey || args.approvalKey || '', '');
        }
        return false;
    }

    function _findDuplicateJob(args, providerId) {
        const logicalJobKey = _safeId(args.logicalJobKey || '', '');
        if (!logicalJobKey) return null;
        for (const job of jobs.values()) {
            if (job.logicalJobKey === logicalJobKey && job.providerId === providerId && !TERMINAL_STATES.has(job.state)) return job;
        }
        return null;
    }

    function _persistSelectedProviders() {
        _writeJsonStorage(SELECTED_PROVIDER_STORAGE_KEY, Array.from(selectedProviders.values()).map(item => _safeValue(item)));
    }

    function _loadSelectedProviders() {
        const stored = _readJsonStorage(SELECTED_PROVIDER_STORAGE_KEY, []);
        for (const item of Array.isArray(stored) ? stored : []) {
            const jobType = _safeId(item && item.jobType, '');
            const providerId = _safeId(item && item.providerId, '');
            if (!jobType || !providerId) continue;
            selectedProviders.set(jobType, { jobType, providerId, source: _safeId(item.source || 'stored', 'stored'), updatedAt: item.updatedAt || _now(), restored: true });
        }
    }

    function _recoverableRef(job) {
        const provider = providers.get(job.providerId);
        if (!provider || !ACTIVE_STATES.has(job.state)) return null;
        const recoveryState = job.state === STATES.CANCELLATION_REQUESTED ? STATES.RUNNING : job.state;
        if (!provider.recoverySupport[recoveryState]) return null;
        return {
            jobId: job.jobId,
            logicalJobKey: job.logicalJobKey || '',
            jobType: job.jobType,
            providerId: job.providerId,
            requesterId: job.requesterId,
            targetRef: job.targetRef,
            inputFingerprint: job.inputFingerprint,
            approvalScopeKey: job.approvalScopeKey,
            priority: job.priority,
            safeLabel: job.safeLabel,
            state: recoveryState,
            persistedAt: _now(),
        };
    }

    function _persistRecoverableRefs() {
        const refs = [];
        for (const job of jobs.values()) {
            const ref = _recoverableRef(job);
            if (ref) refs.push(ref);
        }
        if (refs.length) _writeJsonStorage(RECOVERY_STORAGE_KEY, refs);
        else _storageRemove(RECOVERY_STORAGE_KEY);
    }

    function _loadRecoverableRefs() {
        const refs = _readJsonStorage(RECOVERY_STORAGE_KEY, []);
        for (const ref of Array.isArray(refs) ? refs : []) {
            const jobId = _safeId(ref && ref.jobId, '');
            if (!jobId) continue;
            pendingRecoverableRefs.set(jobId, _safeValue(ref));
        }
    }

    function _jobFromRecoveryRef(ref, state) {
        const now = _now();
        const job = {
            jobId: _safeId(ref.jobId, _id('job')),
            logicalJobKey: _safeId(ref.logicalJobKey || '', ''),
            jobType: _safeId(ref.jobType, 'unknown'),
            providerId: _safeId(ref.providerId, 'unknown'),
            requesterId: _safeId(ref.requesterId, 'unknown'),
            targetRef: _safeId(ref.targetRef, 'target-unknown'),
            inputFingerprint: _safeId(ref.inputFingerprint, 'input-unknown'),
            approvalScope: null,
            approvalScopeKey: _safeId(ref.approvalScopeKey, ''),
            authorization: 'recovered',
            priority: _priority(ref.priority),
            safeLabel: _safeText(ref.safeLabel || 'Recovered job', 'Recovered job', MAX_LABEL),
            state,
            progress: { mode: 'indeterminate', percent: null, step: 'recovered', message: 'Recovered after reload', updatedAt: now },
            attempts: [],
            history: [],
            retryable: false,
            safeReason: state === STATES.PROVIDER_UNAVAILABLE || state === STATES.ORPHANED ? 'Provider recovery unavailable after reload' : 'Recovered after reload',
            terminalOutcome: null,
            bridgeSource: null,
            createdAt: ref.createdAt || now,
            queuedAt: state === STATES.QUEUED ? now : null,
            startedAt: state === STATES.RUNNING ? now : null,
            updatedAt: now,
            terminalAt: null,
        };
        job.attempts.push(_newAttempt(job, state));
        return job;
    }

    function _recoverRefsForProvider(provider) {
        for (const [jobId, ref] of Array.from(pendingRecoverableRefs.entries())) {
            if (ref.providerId !== provider.providerId || jobs.has(jobId)) continue;
            const recoverState = ref.state === STATES.PAUSED ? STATES.PAUSED : (ref.state === STATES.RUNNING ? STATES.RUNNING : STATES.QUEUED);
            if (!provider.recoverySupport[recoverState]) {
                const job = _jobFromRecoveryRef(ref, STATES.PROVIDER_UNAVAILABLE);
                _terminal(job, 'provider-unavailable', 'provider-unavailable', 'Provider does not support recovery for this job state', false);
                jobs.set(job.jobId, job);
                pendingRecoverableRefs.delete(jobId);
                continue;
            }
            let nextState = recoverState;
            const recoveryResult = _callProvider(provider, 'job.recover', { ref });
            if (recoveryResult && recoveryResult.state && [STATES.QUEUED, STATES.RUNNING, STATES.PAUSED].includes(recoveryResult.state)) nextState = recoveryResult.state;
            const job = _jobFromRecoveryRef(ref, nextState);
            jobs.set(job.jobId, job);
            _history(job, 'event', 'Recovered job reference after reload');
            _emitJobs(nextState === STATES.PAUSED ? 'paused' : (nextState === STATES.RUNNING ? 'started' : 'queued'), { job: _jobSummary(job, { includeHistory: false }) });
            pendingRecoverableRefs.delete(jobId);
        }
        _persistRecoverableRefs();
    }

    function _registerProviderCommand(ctx) {
        const provider = _normalizeProvider(ctx.payload && ctx.payload.provider || ctx.payload);
        if (!provider.providerId || !provider.jobTypes.length) {
            _rememberOutcome('register-provider', 'validation-failed', { safeReason: 'providerId and jobTypes are required' });
            return _result('validation-failed', {}, 'providerId and jobTypes are required');
        }
        if (provider.version !== 1 || provider.availability === 'incompatible') provider.availability = 'incompatible';
        const existing = providers.get(provider.providerId);
        providers.set(provider.providerId, { ...(existing || {}), ...provider, lastSeenAt: _now() });
        _recoverRefsForProvider(provider);
        _rememberOutcome('register-provider', provider.availability === 'incompatible' ? 'incompatible-version' : 'handled', { providerId: provider.providerId, safeReason: provider.safeReason });
        _emitJobs('provider-registered', { provider: _providerSummary(provider) });
        return provider.availability === 'incompatible'
            ? _result('incompatible-version', { provider: _providerSummary(provider) }, provider.safeReason || 'Provider version incompatible')
            : _handled({ provider: _providerSummary(provider) });
    }

    function _unregisterProviderCommand(ctx) {
        const providerId = _safeId(ctx.payload && (ctx.payload.providerId || ctx.payload.id), '');
        if (!providerId || !providers.has(providerId)) return _result('no-target', {}, 'provider not found');
        providers.delete(providerId);
        for (const job of jobs.values()) {
            if (job.providerId !== providerId || TERMINAL_STATES.has(job.state)) continue;
            _terminal(job, 'provider-unavailable', 'provider-unavailable', 'Provider unregistered', true);
        }
        _rememberOutcome('unregister-provider', 'handled', { providerId });
        return _handled({ providerId });
    }

    function _listProvidersCommand() {
        return _handled({ providers: Array.from(providers.values()).map(_providerSummary), selectedProviders: Array.from(selectedProviders.values()).map(item => _safeValue(item)) });
    }

    function _enqueueCommand(ctx) {
        const args = _plainObject(ctx.payload);
        if (!_safeId(args.jobType, '')) return _result('validation-failed', {}, 'jobType is required');
        if (!args.requester && !args.requesterId && !ctx.requester) return _result('validation-failed', {}, 'requester is required');
        if (!args.requester && ctx.requester) args.requester = ctx.requester;
        const resolved = _resolveProvider(args);
        if (!resolved.provider) {
            _rememberOutcome('enqueue', resolved.outcome, { requesterId: _safeId(args.requester || ctx.requester, 'unknown'), safeReason: resolved.reason });
            return _result(resolved.outcome, {}, resolved.reason);
        }
        const provider = resolved.provider;
        if (!_authorizationAllowed(args, provider.providerId)) {
            const outcome = args.authorization === 'background' || args.authorization === 'none' || !args.authorization ? 'user-action-required' : 'denied';
            _rememberOutcome('enqueue', outcome, { providerId: provider.providerId, requesterId: _safeId(args.requester || ctx.requester, 'unknown'), safeReason: 'Explicit user action required before privileged work starts' });
            return _result(outcome, {}, 'Explicit user action required before privileged work starts');
        }
        const duplicate = _findDuplicateJob(args, provider.providerId);
        if (duplicate) {
            _rememberOutcome('enqueue', 'handled', { jobId: duplicate.jobId, providerId: provider.providerId, requesterId: duplicate.requesterId, safeReason: 'Duplicate logical job suppressed' });
            return _handled({ job: _jobSummary(duplicate, { includeHistory: false }), duplicate: true });
        }
        const job = _newJob(args, provider.providerId);
        jobs.set(job.jobId, job);
        _history(job, 'event', 'Job queued');
        _rememberOutcome('enqueue', 'queued', { jobId: job.jobId, providerId: provider.providerId, requesterId: job.requesterId });
        _emitJobs('queued', { job: _jobSummary(job, { includeHistory: false }) });
        _scheduleProvider(provider.providerId);
        return _result(job.state === STATES.RUNNING ? 'handled' : 'queued', { job: _jobSummary(job) });
    }

    function _listCommand(ctx) {
        const filters = _plainObject(ctx.payload);
        const includeTerminal = filters.includeTerminal !== false;
        const summaries = Array.from(jobs.values()).filter(job => {
            if (filters.providerId && job.providerId !== filters.providerId) return false;
            if (filters.jobType && job.jobType !== filters.jobType) return false;
            if (filters.state && job.state !== filters.state) return false;
            if (filters.requesterId && job.requesterId !== filters.requesterId) return false;
            if (!includeTerminal && TERMINAL_STATES.has(job.state)) return false;
            return true;
        }).map(job => _jobSummary(job, { includeHistory: false }));
        return _handled({ jobs: summaries, providers: Array.from(providers.values()).map(_providerSummary) });
    }

    function _inspectCommand(ctx) {
        const jobId = _safeId(ctx.payload && ctx.payload.jobId, '');
        if (!jobId || !jobs.has(jobId)) return _result('no-target', {}, 'job not found');
        const job = jobs.get(jobId);
        return _handled({ job: _jobSummary(job), provider: providers.has(job.providerId) ? _providerSummary(providers.get(job.providerId)) : null });
    }

    function _unsupportedIfNoAction(job, action) {
        const provider = providers.get(job.providerId);
        if (!provider || !_providerCanRun(provider)) return { outcome: 'unavailable', reason: 'Provider unavailable' };
        if (!provider.actions.includes(action) && !(action === 'cancel' && job.state === STATES.QUEUED)) return { outcome: 'unsupported-operation', reason: `${action} is unsupported` };
        return { provider };
    }

    function _cancelCommand(ctx) {
        const jobId = _safeId(ctx.payload && ctx.payload.jobId, '');
        const job = jobs.get(jobId);
        if (!job) return _result('no-target', {}, 'job not found');
        if (TERMINAL_STATES.has(job.state)) return _result('stale', { job: _jobSummary(job) }, 'job is already terminal');
        if (job.state === STATES.QUEUED) {
            _terminal(job, 'cancelled', 'cancellation', 'Cancelled before start', false);
            _rememberOutcome('cancel', 'cancelled', { jobId: job.jobId, providerId: job.providerId, requesterId: job.requesterId });
            _emitJobs('cancelled', { job: _jobSummary(job, { includeHistory: false }) });
            _scheduleProvider(job.providerId);
            return _result('cancelled', { job: _jobSummary(job) });
        }
        const check = _unsupportedIfNoAction(job, 'cancel');
        if (!check.provider) return _result(check.outcome, { job: _jobSummary(job) }, check.reason);
        job.state = STATES.CANCELLATION_REQUESTED;
        job.updatedAt = _now();
        _history(job, 'event', 'Cancellation requested');
        _callProvider(check.provider, 'job.cancel', { job: _jobSummary(job, { includeHistory: false }), requester: ctx.payload && ctx.payload.requester });
        _rememberOutcome('cancel', 'handled', { jobId: job.jobId, providerId: job.providerId, requesterId: job.requesterId, safeReason: 'Cancellation requested' });
        _emitJobs('cancellation-requested', { job: _jobSummary(job, { includeHistory: false }) });
        return _handled({ job: _jobSummary(job) });
    }

    function _pauseCommand(ctx) {
        const jobId = _safeId(ctx.payload && ctx.payload.jobId, '');
        const job = jobs.get(jobId);
        if (!job) return _result('no-target', {}, 'job not found');
        if (TERMINAL_STATES.has(job.state) || job.state !== STATES.RUNNING) return _result('stale', { job: _jobSummary(job) }, 'job is not running');
        const check = _unsupportedIfNoAction(job, 'pause');
        if (!check.provider) return _result(check.outcome, { job: _jobSummary(job) }, check.reason);
        job.state = STATES.PAUSED;
        job.updatedAt = _now();
        _history(job, 'event', 'Job paused');
        _callProvider(check.provider, 'job.pause', { job: _jobSummary(job, { includeHistory: false }) });
        _rememberOutcome('pause', 'handled', { jobId: job.jobId, providerId: job.providerId, requesterId: job.requesterId });
        _emitJobs('paused', { job: _jobSummary(job, { includeHistory: false }) });
        return _handled({ job: _jobSummary(job) });
    }

    function _resumeCommand(ctx) {
        const jobId = _safeId(ctx.payload && ctx.payload.jobId, '');
        const job = jobs.get(jobId);
        if (!job) return _result('no-target', {}, 'job not found');
        if (TERMINAL_STATES.has(job.state) || job.state !== STATES.PAUSED) return _result('stale', { job: _jobSummary(job) }, 'job is not paused');
        const check = _unsupportedIfNoAction(job, 'resume');
        if (!check.provider) return _result(check.outcome, { job: _jobSummary(job) }, check.reason);
        job.state = STATES.QUEUED;
        job.queuedAt = _now();
        job.updatedAt = _now();
        _history(job, 'event', 'Job resumed');
        _callProvider(check.provider, 'job.resume', { job: _jobSummary(job, { includeHistory: false }) });
        _rememberOutcome('resume', 'queued', { jobId: job.jobId, providerId: job.providerId, requesterId: job.requesterId });
        _emitJobs('resumed', { job: _jobSummary(job, { includeHistory: false }) });
        _scheduleProvider(job.providerId);
        return _result(job.state === STATES.RUNNING ? 'handled' : 'queued', { job: _jobSummary(job) });
    }

    function _retryCommand(ctx) {
        const args = _plainObject(ctx.payload);
        const jobId = _safeId(args.jobId, '');
        const job = jobs.get(jobId);
        if (!job) return _result('no-target', {}, 'job not found');
        if (!TERMINAL_STATES.has(job.state)) return _result('stale', { job: _jobSummary(job) }, 'job is not terminal');
        if (!job.retryable) return _result('unsupported-operation', { job: _jobSummary(job) }, 'job is not retryable');
        if (job.attempts.some(attempt => !TERMINAL_STATES.has(attempt.state))) return _result('stale', { job: _jobSummary(job) }, 'retry already active');
        if (args.authorization !== 'user-action') {
            if (args.authorization !== 'approved-continuation' || _safeId(args.approvalScopeKey || args.approvalKey, '') !== job.approvalScopeKey) {
                return _result(args.authorization ? 'denied' : 'user-action-required', { job: _jobSummary(job) }, 'matching approval required for retry');
            }
        }
        const provider = providers.get(job.providerId);
        if (!provider || !_providerCanRun(provider)) return _result('unavailable', { job: _jobSummary(job) }, 'provider unavailable');
        if (!provider.actions.includes('retry') && !provider.actions.includes('enqueue')) return _result('unsupported-operation', { job: _jobSummary(job) }, 'retry unsupported');
        job.state = STATES.QUEUED;
        job.terminalOutcome = null;
        job.terminalAt = null;
        job.retryable = false;
        job.queuedAt = _now();
        job.updatedAt = _now();
        job.attempts.push(_newAttempt(job, STATES.QUEUED));
        _history(job, 'event', 'Retry attempt queued');
        _callProvider(provider, 'job.retry', { job: _jobSummary(job, { includeHistory: false }) });
        _rememberOutcome('retry', 'retry-started', { jobId: job.jobId, providerId: job.providerId, requesterId: job.requesterId });
        _emitJobs('retried', { job: _jobSummary(job, { includeHistory: false }) });
        _scheduleProvider(job.providerId);
        return _result('retry-started', { job: _jobSummary(job) });
    }

    function _recordBridgeHitCommand(ctx) {
        const source = _plainObject(ctx.payload);
        const bridge = {
            bridgeId: _safeId(source.bridgeId || (BRIDGE_IDS.has(source.legacySurface) ? source.legacySurface : 'jobs.legacy-plugin-queue'), 'jobs.legacy-plugin-queue'),
            legacySurface: _safeId(source.legacySurface || 'plugin-queue', 'plugin-queue'),
            pluginId: _safeId(source.pluginId || source.source || 'unknown', 'unknown'),
            operation: _safeText(source.operation || 'unknown', 'unknown', 80),
            jobId: source.jobId && jobs.has(source.jobId) ? source.jobId : null,
            providerId: source.providerId && providers.has(source.providerId) ? source.providerId : null,
            logicalJobKey: _safeId(source.logicalJobKey || '', ''),
            diagnosticsOnly: false,
            timestamp: _now(),
            safeReason: _safeText(source.safeReason || source.reason || 'legacy surface observed'),
        };
        if (!bridge.jobId && bridge.logicalJobKey) {
            for (const job of jobs.values()) {
                if (job.logicalJobKey === bridge.logicalJobKey) {
                    bridge.jobId = job.jobId;
                    bridge.providerId = job.providerId;
                    bridge.diagnosticsOnly = true;
                    break;
                }
            }
        }
        bridgeHits.push(bridge);
        while (bridgeHits.length > MAX_BRIDGES) bridgeHits.shift();
        if (capabilities && typeof capabilities.registerCompatibilityShim === 'function') {
            capabilities.registerCompatibilityShim({
                shimId: bridge.bridgeId,
                source: bridge.pluginId,
                capability: 'jobs',
                legacySurface: bridge.legacySurface,
                status: 'used',
                reason: bridge.safeReason,
                hit: true,
                providerId: bridge.providerId,
                ownerPluginId: bridge.pluginId,
            });
        }
        _rememberOutcome('record-bridge-hit', 'handled', { jobId: bridge.jobId, providerId: bridge.providerId, safeReason: bridge.safeReason });
        _emitJobs('bridge-hit', { bridge });
        return _handled({ bridge });
    }

    function _scheduleProvider(providerId) {
        const provider = providers.get(providerId);
        if (!provider || !_providerCanRun(provider)) return;
        let load = _providerLoad(providerId);
        const queued = Array.from(jobs.values())
            .filter(job => job.providerId === providerId && job.state === STATES.QUEUED)
            .sort((a, b) => _priorityRank(a) - _priorityRank(b) || String(a.queuedAt || '').localeCompare(String(b.queuedAt || '')) || a.jobId.localeCompare(b.jobId));
        for (const job of queued) {
            if (load.running >= provider.capacity.maxRunning) {
                job.safeReason = 'Waiting for provider capacity';
                continue;
            }
            _startJob(job, provider);
            load = _providerLoad(providerId);
        }
        _persistRecoverableRefs();
    }

    function _startJob(job, provider) {
        if (!job || !provider || job.state !== STATES.QUEUED) return;
        job.state = STATES.RUNNING;
        job.startedAt = job.startedAt || _now();
        job.updatedAt = _now();
        job.safeReason = null;
        const attempt = job.attempts[job.attempts.length - 1];
        if (attempt) {
            attempt.state = STATES.RUNNING;
            attempt.startedAt = attempt.startedAt || _now();
            attempt.updatedAt = _now();
        }
        _history(job, 'event', 'Job started');
        const result = _callProvider(provider, 'job.enqueue', { job: _jobSummary(job, { includeHistory: false }) });
        if (result && result.progress) updateProgress(provider.providerId, job.jobId, result.progress);
        _emitJobs('started', { job: _jobSummary(job, { includeHistory: false }) });
    }

    function _terminal(job, outcomeStatus, category, safeReason, retryable, resultSummary = '') {
        const status = outcomeStatus === 'timeout' ? 'failed' : outcomeStatus;
        job.state = status === 'provider-unavailable' ? STATES.PROVIDER_UNAVAILABLE : (status === 'orphaned' ? STATES.ORPHANED : (status === 'cancelled' ? STATES.CANCELLED : (status === 'completed' ? STATES.COMPLETED : STATES.FAILED)));
        job.retryable = !!retryable;
        job.safeReason = safeReason ? _safeText(safeReason) : null;
        job.terminalAt = _now();
        job.updatedAt = job.terminalAt;
        job.terminalOutcome = {
            status: outcomeStatus,
            category: FAILURE_CATEGORIES.has(category) ? category : (outcomeStatus === 'completed' ? null : 'unknown'),
            retryable: !!retryable,
            safeReason: job.safeReason,
            resultSummary: resultSummary ? _safeText(resultSummary) : null,
        };
        const attempt = job.attempts[job.attempts.length - 1];
        if (attempt) {
            attempt.state = job.state;
            attempt.updatedAt = job.updatedAt;
            attempt.terminalAt = job.terminalAt;
            attempt.terminalOutcome = _clone(job.terminalOutcome);
        }
        if (!terminalJobIds.includes(job.jobId)) terminalJobIds.push(job.jobId);
        while (terminalJobIds.length > MAX_TERMINAL_JOBS) terminalJobIds.shift();
        _history(job, 'event', `Job ${outcomeStatus}`);
        _persistRecoverableRefs();
        return job;
    }

    function updateProgress(providerId, jobId, progress = {}) {
        const job = jobs.get(_safeId(jobId, ''));
        if (!job || job.providerId !== providerId) return _result('no-target', {}, 'job not found');
        if (TERMINAL_STATES.has(job.state)) {
            _rememberOutcome('progress', 'stale', { jobId: job.jobId, providerId: job.providerId, requesterId: job.requesterId, safeReason: 'progress after terminal state' });
            return _result('stale', { job: _jobSummary(job) }, 'job is terminal');
        }
        const source = _plainObject(progress);
        const mode = source.mode === 'determinate' || source.mode === 'indeterminate' || source.mode === 'step-only' ? source.mode : (source.percent == null ? 'indeterminate' : 'determinate');
        let percent = mode === 'determinate' ? Math.max(0, Math.min(100, _number(source.percent, 0) || 0)) : null;
        let message = _safeText(source.message || source.safeMessage || '', '', MAX_REASON);
        if (job.progress && job.progress.mode === 'determinate' && percent != null && job.progress.percent != null && percent < job.progress.percent && !source.newStep && !source.newAttempt) {
            message = message || 'Progress decreased and was flagged';
        }
        job.progress = {
            mode,
            percent,
            step: _safeText(source.step || source.currentStep || '', '', 80),
            message,
            updatedAt: _now(),
        };
        job.updatedAt = job.progress.updatedAt;
        _history(job, 'progress', job.progress.message || job.progress.step || mode, { progress: job.progress });
        _rememberOutcome('progress', 'handled', { jobId: job.jobId, providerId: job.providerId, requesterId: job.requesterId });
        _emitJobs('progress', { job: _jobSummary(job, { includeHistory: false }) });
        return _handled({ job: _jobSummary(job) });
    }

    function log(providerId, jobId, entry = {}) {
        const job = jobs.get(_safeId(jobId, ''));
        if (!job || job.providerId !== providerId) return _result('no-target', {}, 'job not found');
        const message = typeof entry === 'string' ? entry : (entry.message || entry.safeMessage || '');
        _history(job, 'log', message);
        _emitJobs('log', { job: _jobSummary(job, { includeHistory: false }), message: _safeText(message) });
        return _handled({ job: _jobSummary(job) });
    }

    function complete(providerId, jobId, result = {}) {
        const job = jobs.get(_safeId(jobId, ''));
        if (!job || job.providerId !== providerId) return _result('no-target', {}, 'job not found');
        if (TERMINAL_STATES.has(job.state)) return _result('stale', { job: _jobSummary(job) }, 'job is terminal');
        _terminal(job, 'completed', null, result.safeReason || result.reason || '', false, result.resultSummary || result.summary || 'Completed');
        _rememberOutcome('complete', 'completed', { jobId: job.jobId, providerId: job.providerId, requesterId: job.requesterId });
        _emitJobs('completed', { job: _jobSummary(job, { includeHistory: false }) });
        _scheduleProvider(providerId);
        return _result('completed', { job: _jobSummary(job) });
    }

    function fail(providerId, jobId, result = {}) {
        const job = jobs.get(_safeId(jobId, ''));
        if (!job || job.providerId !== providerId) return _result('no-target', {}, 'job not found');
        if (TERMINAL_STATES.has(job.state)) return _result('stale', { job: _jobSummary(job) }, 'job is terminal');
        const status = result.status === 'timeout' ? 'timeout' : 'failed';
        const category = FAILURE_CATEGORIES.has(result.category) ? result.category : (status === 'timeout' ? 'timeout' : 'provider-failure');
        _terminal(job, status, category, result.safeReason || result.reason || 'Provider reported failure', !!result.retryable, result.resultSummary || 'Failed');
        _rememberOutcome('fail', status, { jobId: job.jobId, providerId: job.providerId, requesterId: job.requesterId, category, safeReason: job.safeReason });
        _emitJobs('failed', { job: _jobSummary(job, { includeHistory: false }) });
        _scheduleProvider(providerId);
        return _result(status, { job: _jobSummary(job) });
    }

    function markProviderUnavailable(providerId, reason = 'Provider unavailable') {
        const provider = providers.get(providerId);
        if (provider) {
            provider.availability = 'unavailable';
            provider.safeReason = _safeText(reason);
            provider.lastSeenAt = _now();
        }
        for (const job of jobs.values()) {
            if (job.providerId !== providerId || TERMINAL_STATES.has(job.state)) continue;
            _terminal(job, 'provider-unavailable', 'provider-unavailable', reason, true);
            _emitJobs('provider-unavailable', { job: _jobSummary(job, { includeHistory: false }) });
        }
        _contributeDiagnostics();
    }

    function simulateReload() {
        for (const job of Array.from(jobs.values())) {
            if (!ACTIVE_STATES.has(job.state)) continue;
            const provider = providers.get(job.providerId);
            const recoveryState = job.state === STATES.CANCELLATION_REQUESTED ? STATES.RUNNING : job.state;
            if (provider && provider.recoverySupport[recoveryState]) continue;
            _terminal(job, provider ? 'orphaned' : 'provider-unavailable', provider ? 'unknown' : 'provider-unavailable', provider ? 'Job has no provider-declared recovery support' : 'Provider unavailable during reload', false);
            _emitJobs(provider ? 'orphaned' : 'provider-unavailable', { job: _jobSummary(job, { includeHistory: false }) });
        }
        _persistRecoverableRefs();
        _contributeDiagnostics();
    }

    function setSelectedProvider(jobType, providerId, source = 'user-selected') {
        const normalizedJobType = _safeId(jobType, '');
        const normalizedProviderId = _safeId(providerId, '');
        if (!normalizedJobType || !normalizedProviderId) return { ok: false, reason: 'jobType and providerId are required' };
        selectedProviders.set(normalizedJobType, { jobType: normalizedJobType, providerId: normalizedProviderId, source: _safeId(source, 'user-selected'), updatedAt: _now() });
        _persistSelectedProviders();
        _contributeDiagnostics();
        return { ok: true };
    }

    function _snapshotJobs() {
        const active = [];
        const queued = [];
        const paused = [];
        const recentTerminal = [];
        for (const job of jobs.values()) {
            if (job.state === STATES.QUEUED) queued.push(_jobSummary(job));
            else if (job.state === STATES.PAUSED) paused.push(_jobSummary(job));
            else if (job.state === STATES.RUNNING || job.state === STATES.CANCELLATION_REQUESTED) active.push(_jobSummary(job));
        }
        for (const jobId of terminalJobIds.slice(-MAX_TERMINAL_JOBS)) {
            const job = jobs.get(jobId);
            if (job && TERMINAL_STATES.has(job.state)) recentTerminal.push(_jobSummary(job));
        }
        return { active, queued, paused, recentTerminal };
    }

    function snapshot(options = {}) {
        const jobsSnapshot = _snapshotJobs();
        const notes = [];
        if (pendingRecoverableRefs.size) notes.push(`${pendingRecoverableRefs.size} recoverable job reference(s) awaiting provider registration`);
        const result = {
            schema: SCHEMA,
            generatedAt: _now(),
            providers: Array.from(providers.values()).map(_providerSummary),
            selectedProviders: Array.from(selectedProviders.values()).map(item => _safeValue(item)),
            jobs: jobsSnapshot,
            outcomes: outcomes.slice(-MAX_OUTCOMES).map(item => _safeValue(item)),
            bridgeHits: bridgeHits.slice(-MAX_BRIDGES).map(item => _safeValue(item)),
            limits: {
                terminalJobsRetained: MIN_TERMINAL_RETAINED,
                perJobHistoryLimit: MAX_HISTORY_PER_JOB,
                snapshotBudgetBytes: SNAPSHOT_BUDGET_BYTES,
            },
            notes,
        };
        let currentSize = JSON.stringify(result).length;
        while (result.jobs.recentTerminal.length > MIN_TERMINAL_RETAINED && currentSize > SNAPSHOT_BUDGET_BYTES) {
            const removed = result.jobs.recentTerminal.shift();
            currentSize -= JSON.stringify(removed).length;
        }
        for (const group of ['active', 'queued', 'paused', 'recentTerminal']) {
            for (const job of result.jobs[group]) {
                while (job.history && job.history.length && JSON.stringify(result).length > SNAPSHOT_BUDGET_BYTES) job.history.shift();
            }
        }
        result.snapshotBytes = JSON.stringify(result).length;
        return _safeValue(result);
    }

    let contributing = false;
    function _contributeDiagnostics() {
        if (contributing) return;
        const diagnostics = window.slopsmith && window.slopsmith.diagnostics;
        if (diagnostics && typeof diagnostics.contribute === 'function') {
            contributing = true;
            try { diagnostics.contribute('jobs', snapshot()); }
            catch (_) {}
            finally { contributing = false; }
        }
        try { window.dispatchEvent(new CustomEvent('slopsmith:capabilities:changed', { detail: { timestamp: _now() } })); }
        catch (_) {}
    }

    function resetForTests(options = {}) {
        providers.clear();
        selectedProviders.clear();
        jobs.clear();
        terminalJobIds.length = 0;
        outcomes.length = 0;
        bridgeHits.length = 0;
        pendingRecoverableRefs.clear();
        if (options.clearStorage !== false) {
            _storageRemove(SELECTED_PROVIDER_STORAGE_KEY);
            _storageRemove(RECOVERY_STORAGE_KEY);
        }
        _loadSelectedProviders();
        _loadRecoverableRefs();
        _contributeDiagnostics();
    }

    _loadSelectedProviders();
    _loadRecoverableRefs();

    capabilities.registerOwner('jobs', {
        pluginId: OWNER_ID,
        kind: 'provider-coordinator',
        compatibility: 'shim-allowed',
        ownership: 'multi-provider',
        safety: 'privileged',
        commands: ['register-provider', 'unregister-provider', 'list-providers', 'enqueue', 'list', 'inspect', 'cancel', 'pause', 'resume', 'retry', 'record-bridge-hit'],
        operations: ['job.enqueue', 'job.status', 'job.cancel', 'job.pause', 'job.resume', 'job.retry', 'job.recover'],
        events: ['provider-registered', 'provider-unregistered', 'provider-unavailable', 'queued', 'started', 'progress', 'log', 'paused', 'resumed', 'cancellation-requested', 'cancelled', 'completed', 'failed', 'retried', 'orphaned', 'bridge-hit'],
        description: 'Owns the privileged jobs provider registry, scheduling, lifecycle state, recovery, bridge hits, and redaction-safe diagnostics.',
        provider_policy: { providerId: 'jobs', kind: 'core', safety: 'privileged' },
        handlers: {
            'register-provider': _registerProviderCommand,
            'unregister-provider': _unregisterProviderCommand,
            'list-providers': _listProvidersCommand,
            enqueue: _enqueueCommand,
            list: _listCommand,
            inspect: _inspectCommand,
            cancel: _cancelCommand,
            pause: _pauseCommand,
            resume: _resumeCommand,
            retry: _retryCommand,
            'record-bridge-hit': _recordBridgeHitCommand,
        },
    });

    const api = {
        version: 1,
        constants: { schema: SCHEMA, states: STATES, outcomes: Array.from(OUTCOMES), limits: { perJobHistoryLimit: MAX_HISTORY_PER_JOB, snapshotBudgetBytes: SNAPSHOT_BUDGET_BYTES } },
        snapshot,
        getDiagnostics: snapshot,
        registerProvider(provider) { return _registerProviderCommand({ payload: { provider }, requester: 'api' }); },
        unregisterProvider(providerId) { return _unregisterProviderCommand({ payload: { providerId }, requester: 'api' }); },
        setSelectedProvider,
        updateProgress,
        reportProgress: updateProgress,
        log,
        complete,
        fail,
        markProviderUnavailable,
        simulateReload,
        resetForTests,
        _test: { reset: resetForTests, providers, jobs, selectedProviders, pendingRecoverableRefs, storage: memoryStorage },
    };

    window.slopsmith.jobs = api;
    _contributeDiagnostics();
})();