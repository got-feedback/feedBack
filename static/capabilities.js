// Slopsmith capability registry and dispatcher.
(function () {
    'use strict';

    function _fallbackEventTarget() {
        const listeners = new Map();
        return {
            addEventListener(type, handler, options) {
                if (typeof handler !== 'function') return;
                const eventType = String(type || '');
                const list = listeners.get(eventType) || [];
                list.push({ handler, once: !!(options && options.once) });
                listeners.set(eventType, list);
            },
            removeEventListener(type, handler) {
                const eventType = String(type || '');
                const list = listeners.get(eventType) || [];
                listeners.set(eventType, list.filter(entry => entry.handler !== handler));
            },
            dispatchEvent(event) {
                if (!event || !event.type) return true;
                const eventType = String(event.type);
                const list = (listeners.get(eventType) || []).slice();
                for (const entry of list) {
                    entry.handler(event);
                    if (entry.once) this.removeEventListener(eventType, entry.handler);
                }
                return true;
            },
        };
    }

    function _ensureSlopsmithEventBus() {
        const existing = window.slopsmith && typeof window.slopsmith === 'object' ? window.slopsmith : null;
        const hasEventTarget = existing
            && typeof existing.addEventListener === 'function'
            && typeof existing.removeEventListener === 'function'
            && typeof existing.dispatchEvent === 'function';
        const bus = hasEventTarget
            ? existing
            : (typeof EventTarget === 'function' ? new EventTarget() : _fallbackEventTarget());
        if (existing && existing !== bus) {
            for (const key of Object.keys(existing)) {
                if (!(key in bus)) bus[key] = existing[key];
            }
        }
        bus.emit = function (event, detail) {
            this.dispatchEvent(new CustomEvent(event, { detail }));
        };
        bus.on = function (event, fn, options) {
            this.addEventListener(event, fn, options);
        };
        bus.off = function (event, fn, options) {
            this.removeEventListener(event, fn, options);
        };
        window.slopsmith = bus;
        return bus;
    }

    _ensureSlopsmithEventBus();
    if (window.slopsmith.capabilities && window.slopsmith.capabilities.version === 1) return;

    const VALID_ROLES = new Set([
        'owner', 'coordinator', 'provider', 'executor', 'observer', 'requester', 'transformer', 'handler',
        'validator', 'short-circuiter', 'contributor',
    ]);
    const VALID_MODES = new Set(['active', 'optional', 'legacy-shim', 'disabled']);
    const VALID_COMPATIBILITY = new Set(['none', 'shim-allowed', 'degrade-noop', 'required', 'legacy-window-shim']);
    const VALID_OWNERSHIP = new Set(['exclusive-owner', 'multi-provider', 'observer-only', 'requester-only', 'privileged', 'diagnostic-only']);
    const VALID_DOMAIN_KINDS = new Set(['command', 'provider-coordinator', 'event', 'diagnostic', 'privileged']);
    const VALID_SAFETY = new Set(['safe', 'privileged', 'sensitive', 'diagnostic-only']);
    const OUTCOMES = new Set([
        'passed', 'transformed', 'handled', 'denied', 'degraded', 'failed',
        'short-circuited', 'overridden', 'no-owner', 'no-handler',
        'unsupported-command', 'unsupported-operation', 'incompatible', 'incompatible-version',
        'unavailable', 'provider-selection-required', 'user-action-required', 'no-target',
        'stale', 'queued', 'validation-failed', 'cancelled', 'completed', 'timeout', 'retry-started', 'stopped',
    ]);
    const MAX_DECISIONS = 100;
    const MAX_SNAPSHOT_BYTES = 64 * 1024;
    const DEFAULT_HANDLER_TIMEOUT_MS = 250;
    const RESERVED_FUTURE_DOMAINS = new Set([
        'ui.navigation',
        'ui.plugin-screens',
        'settings',
        'backend.routes',
        'ui.player-controls',
        'ui.player-panels',
        'ui.player-overlays',
        'plugins',
        'midi-control',
        'tempo-clock',
    ]);
    const RUNTIME_DOMAIN_DEFAULTS = Object.freeze({
        library: Object.freeze({
            roles: ['provider'],
            commands: [],
            operations: ['query-page', 'query-artists', 'query-stats', 'get-art', 'sync-song'],
            events: [],
            description: 'Provides library source operations to the core library domain owner.',
            compatibility: 'none',
            safety: 'safe',
        }),
    });
    const CORE_DOMAIN_REVIEW = Object.freeze({
        diagnostics: Object.freeze({ lifecycle: 'diagnostic', label: 'Snapshot surface', tone: 'info', summary: 'Read-only diagnostics snapshot/export facade for support bundles and the Capability Inspector.' }),
        'audio-input': Object.freeze({ lifecycle: 'active', label: 'Active contract', tone: 'clean', summary: 'Sensitive input-source identity, availability, and redacted diagnostics for monitoring and later note detection.' }),
        'audio-effects': Object.freeze({ lifecycle: 'active', label: 'Active contract', tone: 'clean', summary: 'Provider-selected effect routes, constrained chain-plan resolution, route/stage controls, fallback, and redaction-safe diagnostics.' }),
        'audio-mix': Object.freeze({ lifecycle: 'active', label: 'Active contract', tone: 'clean', summary: 'Core-coordinated song route, fader, participant, and analyser inspection surface.' }),
        'audio-monitoring': Object.freeze({ lifecycle: 'active', label: 'Active contract', tone: 'clean', summary: 'Core-coordinated monitoring lifecycle, availability, consent, and bridge diagnostics.' }),
        library: Object.freeze({ lifecycle: 'active', label: 'Active contract', tone: 'clean', summary: 'Current local and plugin-provided library source selection and sync surface.' }),
        jobs: Object.freeze({ lifecycle: 'active', label: 'Active contract', tone: 'clean', summary: 'Privileged provider-coordinator control plane for long-running work, scheduling, recovery, bridges, and redaction-safe diagnostics.' }),
        playback: Object.freeze({ lifecycle: 'active', label: 'Active contract', tone: 'clean', summary: 'Core-coordinated song transport, timing, loop, route, requester, bridge, and diagnostics surface.' }),
        pipeline: Object.freeze({ lifecycle: 'diagnostic', label: 'Graph controls', tone: 'info', summary: 'Capability graph operations: resolve, inspect, validate, and enable or disable participants.' }),
        stems: Object.freeze({ lifecycle: 'active', label: 'Active contract', tone: 'clean', summary: 'Core-coordinated stem automation, restore, manual override, and compatibility bridge surface backed by the active Stems provider.' }),
        visualization: Object.freeze({ lifecycle: 'active', label: 'Active contract', tone: 'clean', summary: 'Core-coordinated highway renderer providers: discovery, picker selection, auto-match attribution, failure fallback, and redaction-safe diagnostics.' }),
        'note-detection': Object.freeze({ lifecycle: 'active', label: 'Active contract', tone: 'clean', summary: 'Coordinates note-detection providers and requester-owned, context-scoped detection bindings (spec 009); consumers own judgment, hit/miss flow as observability events.' }),
    });
    const EXPECTED_COMPATIBILITY_SHIMS = Object.freeze({});

    const pipelines = new Map();
    const recentDecisions = [];
    const missingProviders = [];
    const compatibilityShims = [];
    const userOverrides = [];
    const claimLifecycle = [];
    const unsupportedVersions = [];
    const activeClaims = new Map();
    const subscribers = new Map();
    const knownPlugins = new Map();
    let commandSeq = 0;
    let decisionSeq = 0;

    function _now() { return new Date().toISOString(); }

    function _asArray(value) {
        return Array.isArray(value) ? value : [];
    }

    function _uniqueStrings(value, allowed = null) {
        const out = [];
        const seen = new Set();
        for (const item of _asArray(value)) {
            if (typeof item !== 'string' || !item.trim()) continue;
            const normalized = item.trim();
            if (allowed && !allowed.has(normalized)) continue;
            if (seen.has(normalized)) continue;
            seen.add(normalized);
            out.push(normalized);
        }
        return out;
    }

    function _shortDescription(value) {
        if (typeof value !== 'string') return '';
        const normalized = value.replace(/\s+/g, ' ').trim();
        return normalized.length > 240 ? `${normalized.slice(0, 237)}...` : normalized;
    }

    function _order(order) {
        const source = order && typeof order === 'object' ? order : {};
        return {
            fixed: !!source.fixed,
            before: _uniqueStrings(source.before),
            after: _uniqueStrings(source.after),
        };
    }

    function _ownershipForKind(kind) {
        if (kind === 'provider-coordinator') return 'multi-provider';
        if (kind === 'diagnostic') return 'diagnostic-only';
        if (kind === 'privileged') return 'privileged';
        return 'exclusive-owner';
    }

    function _manifestUnsupported(source) {
        const standards = _standardList(source);
        if (standards.some(item => /^capability-pipelines\.v(?!1$)/.test(item))) return true;
        const version = Number(source && source.version);
        return Number.isFinite(version) && version !== 1;
    }

    // Recursive clone of a plain-JSON value into null-prototype objects, so a
    // consumer mutating a returned copy can't leak back into registry state and
    // a manifest-controlled `__proto__` key is an ordinary own property rather
    // than a prototype-pollution vector.
    function _deepCloneJson(value) {
        if (Array.isArray(value)) return value.map(_deepCloneJson);
        if (value && typeof value === 'object') {
            const copy = Object.create(null);
            for (const key of Object.keys(value)) copy[key] = _deepCloneJson(value[key]);
            return copy;
        }
        return value;
    }

    const VALID_SETTING_TYPES = new Set(['toggle', 'range', 'select']);

    // Normalize per-instance control descriptors (slopsmith#849) declared on a
    // capability. Lenient (drops malformed entries rather than failing the whole
    // declaration): the server-side validator in plugins/__init__.py already
    // strict-checks the /api/plugins manifest path; this keeps runtime
    // registerParticipant calls forgiving while preserving the descriptors on
    // the registered participant so generic inspect() — not just the
    // visualization side channel — sees them.
    function _normalizeSettings(value) {
        if (!Array.isArray(value)) return [];
        const out = [];
        const seen = new Set();
        for (const entry of value) {
            if (!entry || typeof entry !== 'object') continue;
            const key = typeof entry.key === 'string' ? entry.key.trim() : '';
            if (!key || seen.has(key) || !VALID_SETTING_TYPES.has(entry.type)) continue;
            const descriptor = { key, type: entry.type };
            if (typeof entry.label === 'string' && entry.label.trim()) descriptor.label = entry.label.trim();
            // Clone `default` (schema-unconstrained, can be a nested object/array)
            // so a caller mutating its own object after registerParticipant()
            // can't reach into registry state.
            if ('default' in entry) descriptor.default = _deepCloneJson(entry.default);
            for (const num of ['min', 'max', 'step']) {
                if (typeof entry[num] === 'number' && Number.isFinite(entry[num])) descriptor[num] = entry[num];
            }
            if (entry.type === 'select' && Array.isArray(entry.options)) {
                const opts = [];
                for (const opt of entry.options) {
                    if (!opt || typeof opt !== 'object') continue;
                    const id = typeof opt.id === 'string' ? opt.id.trim() : '';
                    if (!id) continue;
                    const normalized = { id };
                    if (typeof opt.label === 'string' && opt.label.trim()) normalized.label = opt.label.trim();
                    opts.push(normalized);
                }
                if (opts.length) descriptor.options = opts;
            }
            out.push(descriptor);
            seen.add(key);
        }
        return out;
    }

    function _normalizeDeclaration(declaration, container = null) {
        const source = declaration && typeof declaration === 'object' ? declaration : {};
        const mode = VALID_MODES.has(source.mode) ? source.mode : 'active';
        const kind = VALID_DOMAIN_KINDS.has(source.kind) ? source.kind : '';
        const compatibility = VALID_COMPATIBILITY.has(source.compatibility)
            ? source.compatibility
            : 'degrade-noop';
        const ownership = VALID_OWNERSHIP.has(source.ownership) ? source.ownership : _ownershipForKind(kind);
        const safety = VALID_SAFETY.has(source.safety) ? source.safety : 'safe';
        const incompatible = !!(source.incompatible || source.unsupportedVersion || _manifestUnsupported(source) || _manifestUnsupported(container));
        return {
            roles: _uniqueStrings(source.roles, VALID_ROLES),
            events: _uniqueStrings(source.events),
            commands: _uniqueStrings(source.commands),
            operations: _uniqueStrings(source.operations || source.providerOperations || source.provider_operations),
            requests: _uniqueStrings(source.requests),
            observes: _uniqueStrings(source.observes),
            emits: _uniqueStrings(source.emits),
            description: _shortDescription(source.description) || _shortDescription(source.summary),
            order: _order(source.order),
            kind,
            mode: incompatible ? 'disabled' : mode,
            compatibility,
            ownership,
            safety,
            providerPolicy: source.provider_policy && typeof source.provider_policy === 'object' ? source.provider_policy : {},
            settings: _normalizeSettings(source.settings),
            handlers: source.handlers && typeof source.handlers === 'object' ? source.handlers : {},
            eventHandlers: source.eventHandlers && typeof source.eventHandlers === 'object' ? source.eventHandlers : {},
            runtime: !!source.runtime,
            availability: incompatible ? 'incompatible' : (mode === 'disabled' ? 'disabled' : 'available'),
            incompatible,
            version: Number(source.version) || 1,
        };
    }

    function _runtimeDomainRoleList(source) {
        const roles = _uniqueStrings(source && source.roles, VALID_ROLES);
        const role = typeof (source && source.role) === 'string' ? source.role.trim() : '';
        if (role && VALID_ROLES.has(role) && !roles.includes(role)) roles.push(role);
        return roles;
    }

    function _runtimeDomainDeclaration(domainName, declaration) {
        if (!domainName || !declaration || typeof declaration !== 'object' || Array.isArray(declaration)) return null;
        const canonical = _canonicalCapabilityName(domainName);
        const defaults = RUNTIME_DOMAIN_DEFAULTS[canonical] || {};
        const roles = _runtimeDomainRoleList(declaration);
        const commands = _uniqueStrings(declaration.commands || defaults.commands);
        const operations = _uniqueStrings(declaration.operations || declaration.providerOperations || declaration.provider_operations || defaults.operations);
        const requests = _uniqueStrings(declaration.requests || defaults.requests);
        const observes = _uniqueStrings(declaration.observes || defaults.observes);
        const emits = _uniqueStrings(declaration.emits || defaults.emits);
        const events = _uniqueStrings(declaration.events || defaults.events);
        const kind = VALID_DOMAIN_KINDS.has(declaration.kind) ? declaration.kind : (defaults.kind || '');
        const normalized = {
            roles: roles.length ? roles : _uniqueStrings(defaults.roles, VALID_ROLES),
            commands,
            operations,
            requests,
            observes,
            emits,
            events,
            kind,
            mode: VALID_MODES.has(declaration.mode) ? declaration.mode : 'active',
            compatibility: VALID_COMPATIBILITY.has(declaration.compatibility) ? declaration.compatibility : (defaults.compatibility || 'degrade-noop'),
            ownership: VALID_OWNERSHIP.has(declaration.ownership) ? declaration.ownership : (defaults.ownership || _ownershipForKind(kind)),
            safety: VALID_SAFETY.has(declaration.safety) ? declaration.safety : (defaults.safety || 'safe'),
        };
        const description = _shortDescription(declaration.description) || _shortDescription(declaration.summary) || _shortDescription(defaults.description);
        if (description) normalized.description = description;
        if (declaration.order && typeof declaration.order === 'object') normalized.order = declaration.order;
        if (declaration.provider_policy && typeof declaration.provider_policy === 'object') normalized.provider_policy = declaration.provider_policy;
        if (!normalized.roles.length || (!normalized.commands.length && !normalized.operations.length && !normalized.requests.length && !normalized.events.length && !normalized.observes.length && !normalized.emits.length)) return null;
        return normalized;
    }

    function _runtimeDomainCapabilityMap(declaration) {
        if (!declaration || typeof declaration !== 'object') return {};
        const domains = {
            ...(declaration.runtime_domains && typeof declaration.runtime_domains === 'object' ? declaration.runtime_domains : {}),
            ...(declaration.domains && typeof declaration.domains === 'object' ? declaration.domains : {}),
        };
        const capabilities = {};
        for (const [domainName, domainDeclaration] of Object.entries(domains)) {
            const normalized = _runtimeDomainDeclaration(domainName, domainDeclaration);
            if (normalized) capabilities[_canonicalCapabilityName(domainName)] = normalized;
        }
        return capabilities;
    }

    function _capabilityMap(declaration) {
        if (!declaration || typeof declaration !== 'object') return {};
        const runtimeCapabilities = _runtimeDomainCapabilityMap(declaration);
        if (declaration.capabilities && typeof declaration.capabilities === 'object') {
            return { ...runtimeCapabilities, ...declaration.capabilities };
        }
        if (Object.keys(runtimeCapabilities).length) return runtimeCapabilities;
        if ('id' in declaration || 'name' in declaration || 'pluginId' in declaration || 'ui_contributions' in declaration || 'ui' in declaration) return {};
        return declaration;
    }

    function _standardList(source) {
        if (!source || typeof source !== 'object' || !Array.isArray(source.standards)) return [];
        const result = [];
        const seen = new Set();
        for (const entry of source.standards) {
            if (typeof entry !== 'string' || !entry.trim()) continue;
            const standard = entry.trim();
            if (seen.has(standard)) continue;
            seen.add(standard);
            result.push(standard);
        }
        return result;
    }

    function _canonicalCapabilityName(name) {
        const value = String(name || '').trim();
        return value === 'library.providers' ? 'library' : value;
    }

    function _rememberPluginManifest(pluginId, declaration) {
        if (!pluginId || typeof pluginId !== 'string') return;
        const existing = knownPlugins.get(pluginId) || {
            pluginId,
            capabilities: new Set(),
            standards: new Set(),
            firstSeenAt: _now(),
            updatedAt: null,
        };
        for (const standard of _standardList(declaration)) {
            existing.standards.add(standard);
        }
        const caps = _capabilityMap(declaration && declaration.declaration ? declaration.declaration : declaration);
        for (const [capabilityName, rawDeclaration] of Object.entries(caps)) {
            const canonicalCapabilityName = _canonicalCapabilityName(capabilityName);
            if (!canonicalCapabilityName || !rawDeclaration || typeof rawDeclaration !== 'object') continue;
            if (RESERVED_FUTURE_DOMAINS.has(canonicalCapabilityName)) continue;
            existing.capabilities.add(canonicalCapabilityName);
        }
        if (_manifestUnsupported(declaration)) {
            _remember(unsupportedVersions, {
                pluginId,
                standards: _standardList(declaration),
                reason: 'Unsupported capability-pipelines version',
            });
        }
        existing.updatedAt = _now();
        knownPlugins.set(pluginId, existing);
    }

    function _pluginEntryId(entry) {
        if (!entry || typeof entry !== 'object') return '';
        return typeof entry.pluginId === 'string' ? entry.pluginId : (typeof entry.id === 'string' ? entry.id : '');
    }

    function _pluginEntryDeclaration(entry) {
        if (!entry || typeof entry !== 'object') return {};
        if (entry.declaration && typeof entry.declaration === 'object') return entry.declaration;
        return _capabilityMap(entry);
    }

    function _pipeline(name) {
        const capabilityName = _canonicalCapabilityName(name);
        if (!pipelines.has(capabilityName)) {
            pipelines.set(capabilityName, {
                name: capabilityName,
                participants: new Map(),
                order: [],
                conflicts: [],
                resolvedAt: null,
            });
        }
        return pipelines.get(capabilityName);
    }

    function _mergeParticipant(existing, incoming) {
        if (!existing) return incoming;
        const runtimeOverride = existing.runtimeOverride;
        const mergedDeclarationMode = incoming.declarationMode || existing.declarationMode;
        const mergedMode = runtimeOverride
            ? (runtimeOverride.enabled ? (mergedDeclarationMode !== 'disabled' ? mergedDeclarationMode : 'active') : 'disabled')
            : (incoming.mode || existing.mode);
        return {
            ...existing,
            roles: _uniqueStrings([...(existing.roles || []), ...(incoming.roles || [])], VALID_ROLES),
            events: _uniqueStrings([...(existing.events || []), ...(incoming.events || [])]),
            commands: _uniqueStrings([...(existing.commands || []), ...(incoming.commands || [])]),
            operations: _uniqueStrings([...(existing.operations || []), ...(incoming.operations || [])]),
            requests: _uniqueStrings([...(existing.requests || []), ...(incoming.requests || [])]),
            observes: _uniqueStrings([...(existing.observes || []), ...(incoming.observes || [])]),
            emits: _uniqueStrings([...(existing.emits || []), ...(incoming.emits || [])]),
            order: {
                fixed: !!(existing.order && existing.order.fixed) || !!(incoming.order && incoming.order.fixed),
                before: _uniqueStrings([...(existing.order?.before || []), ...(incoming.order?.before || [])]),
                after: _uniqueStrings([...(existing.order?.after || []), ...(incoming.order?.after || [])]),
            },
            mode: mergedMode,
            kind: incoming.kind || existing.kind || '',
            compatibility: incoming.compatibility || existing.compatibility,
            ownership: incoming.ownership || existing.ownership || 'exclusive-owner',
            safety: incoming.safety || existing.safety || 'safe',
            description: incoming.description || existing.description || '',
            providerPolicy: { ...(existing.providerPolicy || {}), ...(incoming.providerPolicy || {}) },
            // Prefer an incoming settings list (a deliberate re-declaration) but
            // fall back to the existing one — a runtime owner re-registering a
            // manifest participant (e.g. the viz host adding provider_policy)
            // doesn't carry settings and must not wipe the manifest's.
            settings: (incoming.settings && incoming.settings.length) ? incoming.settings : (existing.settings || []),
            handlers: { ...(existing.handlers || {}), ...(incoming.handlers || {}) },
            eventHandlers: { ...(existing.eventHandlers || {}), ...(incoming.eventHandlers || {}) },
            runtime: !!existing.runtime || !!incoming.runtime,
            availability: incoming.availability || existing.availability || 'available',
            incompatible: !!existing.incompatible || !!incoming.incompatible,
            version: incoming.version || existing.version || 1,
            declarationMode: mergedDeclarationMode,
            runtimeOverride,
        };
    }

    function _missingOrderPeerConflict(capabilityName, participant, peer, relation) {
        const inactivePeer = _pipeline(capabilityName).participants.get(peer);
        if (inactivePeer && inactivePeer.mode === 'disabled') {
            return {
                type: 'disabled-order-peer',
                participant: participant.pluginId,
                peer,
                reason: `${relation} peer is registered but disabled`,
            };
        }
        const knownPeer = knownPlugins.get(peer);
        if (knownPeer && !(knownPeer.capabilities || new Set()).has(capabilityName)) {
            return {
                type: 'missing-capability-peer',
                participant: participant.pluginId,
                peer,
                reason: `${relation} peer is registered but does not declare capability ${capabilityName}`,
            };
        }
        return {
            type: 'missing-order-peer',
            participant: participant.pluginId,
            peer,
            reason: `${relation} peer is not registered`,
        };
    }

    function _participantPriority(participant) {
        if (participant.roles.includes('owner')) return 0;
        if (participant.roles.includes('coordinator')) return 1;
        if (participant.roles.includes('provider')) return 2;
        if (participant.roles.includes('validator')) return 3;
        if (participant.roles.includes('transformer')) return 4;
        if (participant.roles.includes('handler')) return 5;
        if (participant.roles.includes('short-circuiter')) return 6;
        return 7;
    }

    function _resolvePipeline(name) {
        const pipeline = _pipeline(name);
        const participants = Array.from(pipeline.participants.values())
            .filter(p => p.mode !== 'disabled')
            .sort((a, b) => {
                const fixedDelta = Number(!!b.order.fixed) - Number(!!a.order.fixed);
                if (fixedDelta) return fixedDelta;
                const priorityDelta = _participantPriority(a) - _participantPriority(b);
                if (priorityDelta) return priorityDelta;
                return a.pluginId.localeCompare(b.pluginId);
            });

        const byId = new Map(participants.map(p => [p.pluginId, p]));
        const ids = participants.map(p => p.pluginId);
        const edges = new Map(ids.map(id => [id, new Set()]));
        const conflicts = [];

        for (const participant of participants) {
            for (const before of participant.order.before || []) {
                if (!byId.has(before)) {
                    conflicts.push(_missingOrderPeerConflict(name, participant, before, 'before'));
                    continue;
                }
                edges.get(participant.pluginId).add(before);
            }
            for (const after of participant.order.after || []) {
                if (!byId.has(after)) {
                    conflicts.push(_missingOrderPeerConflict(name, participant, after, 'after'));
                    continue;
                }
                edges.get(after).add(participant.pluginId);
            }
        }

        const owners = participants.filter(p => p.roles.includes('owner') && p.ownership !== 'multi-provider');
        if (owners.length > 1) {
            conflicts.push({
                type: 'duplicate-owner',
                participants: owners.map(p => p.pluginId),
                reason: `Capability ${name} has multiple owners`,
            });
        }

        const indegree = new Map(ids.map(id => [id, 0]));
        for (const [, next] of edges) {
            for (const id of next) indegree.set(id, (indegree.get(id) || 0) + 1);
        }
        const baseOrder = new Map(ids.map((id, idx) => [id, idx]));
        const queue = ids.filter(id => indegree.get(id) === 0)
            .sort((a, b) => baseOrder.get(a) - baseOrder.get(b));
        const insertByBaseOrder = (id) => {
            const rank = baseOrder.get(id);
            let low = 0;
            let high = queue.length;
            while (low < high) {
                const mid = (low + high) >>> 1;
                if (baseOrder.get(queue[mid]) < rank) low = mid + 1;
                else high = mid;
            }
            queue.splice(low, 0, id);
        };
        const resolved = [];
        while (queue.length) {
            const id = queue.shift();
            resolved.push(id);
            for (const next of edges.get(id) || []) {
                indegree.set(next, indegree.get(next) - 1);
                if (indegree.get(next) === 0) {
                    insertByBaseOrder(next);
                }
            }
        }
        if (resolved.length !== ids.length) {
            conflicts.push({ type: 'order-cycle', reason: `Capability ${name} has incompatible ordering constraints` });
            pipeline.order = ids;
        } else {
            pipeline.order = resolved;
        }
        pipeline.conflicts = conflicts;
        pipeline.resolvedAt = _now();
        _emitEvent('pipeline', 'resolved', { capability: name, order: pipeline.order, conflicts });
        return pipeline;
    }

    function _participantSummary(participant) {
        return {
            pluginId: participant.pluginId,
            capability: participant.capability,
            roles: participant.roles.slice(),
            events: participant.events.slice(),
            commands: participant.commands.slice(),
            operations: (participant.operations || []).slice(),
            requests: (participant.requests || []).slice(),
            observes: (participant.observes || []).slice(),
            emits: (participant.emits || []).slice(),
            description: participant.description || '',
            order: {
                fixed: !!participant.order.fixed,
                before: participant.order.before.slice(),
                after: participant.order.after.slice(),
            },
            mode: participant.mode,
            declarationMode: participant.declarationMode || participant.mode,
            enabled: participant.mode !== 'disabled',
            kind: participant.kind || '',
            compatibility: participant.compatibility,
            ownership: participant.ownership || 'exclusive-owner',
            safety: participant.safety || 'safe',
            providerPolicy: participant.providerPolicy || {},
            // Deep-clone (not shallow): `default` is schema-unconstrained, so a
            // shallow copy would leak nested-value references and let a consumer
            // mutate registry state through inspect()/diagnostics.
            settings: _deepCloneJson(participant.settings || []),
            availability: participant.availability || (participant.mode === 'disabled' ? 'disabled' : 'available'),
            incompatible: !!participant.incompatible,
            version: participant.version || 1,
            runtime: !!participant.runtime,
            runtimeOverride: participant.runtimeOverride || null,
        };
    }

    function _pipelineParticipants(pipeline) {
        const ordered = [];
        const seen = new Set();
        for (const id of pipeline.order) {
            const participant = pipeline.participants.get(id);
            if (!participant) continue;
            ordered.push(participant);
            seen.add(id);
        }
        const remaining = Array.from(pipeline.participants.values())
            .filter(participant => !seen.has(participant.pluginId))
            .sort((a, b) => a.pluginId.localeCompare(b.pluginId));
        return [...ordered, ...remaining];
    }

    function _pipelineSummary(pipeline) {
        return {
            name: pipeline.name,
            review: _domainReviewSummary(pipeline.name),
            order: pipeline.order.slice(),
            resolvedAt: pipeline.resolvedAt,
            conflicts: pipeline.conflicts.slice(),
            participants: _pipelineParticipants(pipeline).map(_participantSummary),
        };
    }

    function _domainReviewSummary(domainName) {
        return CORE_DOMAIN_REVIEW[domainName] || {
            lifecycle: 'plugin-defined',
            label: 'Plugin-defined',
            tone: 'info',
            summary: 'Declared by a plugin or test fixture rather than registered as a core Slopsmith domain.',
        };
    }

    function _knownPluginSummary(plugin) {
        return {
            pluginId: plugin.pluginId,
            standards: Array.from(plugin.standards || []).sort(),
            capabilities: Array.from(plugin.capabilities || []).sort(),
            firstSeenAt: plugin.firstSeenAt,
            updatedAt: plugin.updatedAt,
        };
    }

    function _expectedCompatibilityShimSummary() {
        return Object.entries(EXPECTED_COMPATIBILITY_SHIMS).flatMap(([capability, shims]) => (
            shims.map(shim => ({ capability, status: 'expected', ...shim }))
        ));
    }

    function _redactString(value) {
        return String(value)
            .replace(/\/Users\/[^\s/]+(?:\/[^\s]*)?/g, '[path]')
            .replace(/[A-Za-z]:\\[^\s]+/g, '[path]')
            .replace(/\b(token|secret|password|api[_-]?key)=([^\s&]+)/gi, '$1=[redacted]');
    }

    function _safeValue(value, depth = 0) {
        if (typeof value === 'string') return _redactString(value);
        if (value == null || typeof value === 'number' || typeof value === 'boolean') return value;
        if (depth > 8) return '[truncated]';
        if (Array.isArray(value)) return value.slice(0, 50).map(item => _safeValue(item, depth + 1));
        if (typeof value === 'object') {
            const out = {};
            for (const [key, item] of Object.entries(value).slice(0, 50)) {
                out[_redactString(key)] = _safeValue(item, depth + 1);
            }
            return out;
        }
        return String(value);
    }

    function _recordDecision(decision) {
        recentDecisions.push({ decisionId: `decision-${++decisionSeq}`, timestamp: _now(), ...decision });
        while (recentDecisions.length > MAX_DECISIONS) recentDecisions.shift();
        _contributeDiagnostics();
    }

    function _remember(list, entry, max = 50) {
        list.push({ timestamp: _now(), ...entry });
        while (list.length > max) list.shift();
        _contributeDiagnostics();
    }

    function _claimKey(capability, claimId) {
        return `${capability || 'unknown'}:${claimId || 'unknown'}`;
    }

    function _targetSelector(source = {}) {
        const payload = source.payload && typeof source.payload === 'object' ? source.payload : source.args || source;
        const target = payload.target && typeof payload.target === 'object' ? payload.target : source.target || {};
        const value = payload.selector || target.selector || target.id || target.kind || source.selector || '*';
        return String(value || '*').toLowerCase();
    }

    function _claimFromContext(ctx) {
        const payload = ctx.payload && typeof ctx.payload === 'object' ? ctx.payload : {};
        const claim = ctx.claim && typeof ctx.claim === 'object' ? ctx.claim : (payload.claim && typeof payload.claim === 'object' ? payload.claim : {});
        const claimId = claim.claimId || payload.claimId;
        if (!claimId) return null;
        const capability = claim.capability || ctx.capability;
        return activeClaims.get(_claimKey(capability, claimId)) || {
            claimId,
            capability,
            owner: claim.owner || ctx.requester || 'unknown',
            createdAt: ctx.timestamp || _now(),
            synthetic: true,
        };
    }

    function _claimOwner(capability, source = {}) {
        const explicitOwner = String(source.owner || '').trim();
        if (explicitOwner) return explicitOwner;
        const pipeline = _resolvePipeline(capability);
        const owners = (pipeline.order || [])
            .map(pluginId => pipeline.participants.get(pluginId))
            .filter(participant => participant && participant.mode !== 'disabled' && participant.roles.includes('owner'));
        if (owners.length === 1) return owners[0].pluginId;
        const exclusiveOwners = owners.filter(participant => participant.ownership !== 'multi-provider');
        if (exclusiveOwners.length === 1) return exclusiveOwners[0].pluginId;
        return 'unknown';
    }

    function _releaseClaimEntry(key, entry, reason = 'Claim released') {
        activeClaims.delete(key);
        const released = {
            ...entry,
            state: 'released',
            updatedAt: _now(),
            restoreSnapshotRef: null,
            reason,
        };
        _remember(claimLifecycle, released);
        _emitEvent(entry.capability, 'claim:released', released);
        return released;
    }

    function _orphanClaimEntry(entry, reason) {
        entry.state = 'orphaned';
        entry.updatedAt = _now();
        entry.orphanReason = reason;
        entry.nonDispatchable = true;
        entry.restoreSnapshotRef = null;
        _remember(claimLifecycle, { ...entry });
        _emitEvent(entry.capability, 'claim:orphaned', entry);
    }

    function _cleanupClaimsForParticipant(pluginId, capabilityName = null) {
        for (const [key, entry] of Array.from(activeClaims.entries())) {
            if (capabilityName && entry.capability !== capabilityName) continue;
            if (entry.requester === pluginId) {
                const released = _releaseClaimEntry(key, entry, `Requester ${pluginId} disappeared`);
                _recordDecision({ commandId: `release-${released.claimId}`, capability: released.capability, command: 'release', requester: pluginId, participant: 'core', outcome: 'handled', reason: released.reason });
                continue;
            }
            if (entry.owner === pluginId && entry.state !== 'orphaned') {
                _orphanClaimEntry(entry, `Owner ${pluginId} disappeared`);
                _recordDecision({ commandId: `orphan-${entry.claimId}`, capability: entry.capability, command: 'orphan', requester: entry.requester || 'unknown', participant: pluginId, outcome: 'no-owner', reason: entry.orphanReason });
            }
        }
    }

    function _overrideMatchesClaim(ctx, claim) {
        const selector = _targetSelector(ctx);
        const createdAt = Date.parse(claim.createdAt || '') || 0;
        return userOverrides.some(entry => {
            if (entry.type !== 'manual') return false;
            if (entry.capability !== claim.capability) return false;
            if ((Date.parse(entry.timestamp || '') || 0) < createdAt) return false;
            const entrySelector = _targetSelector(entry);
            return selector === '*' || entrySelector === '*' || selector === entrySelector;
        });
    }

    function _notifySubscribers(event, detail) {
        for (const key of [event, '*']) {
            const handlers = subscribers.get(key) || [];
            for (const handler of handlers.slice()) {
                try { handler(detail); }
                catch (err) { console.warn('[capabilities] subscriber failed:', err); }
            }
        }
    }

    function _withTimeout(promise, timeoutMs, participant) {
        return Promise.race([
            promise,
            new Promise(resolve => {
                setTimeout(() => resolve({
                    outcome: 'failed',
                    reason: `Handler ${participant.pluginId} timed out after ${timeoutMs} ms`,
                }), timeoutMs);
            }),
        ]);
    }

    function _normalizeDecision(participant, result) {
        const source = result && typeof result === 'object' ? result : { outcome: result ? 'handled' : 'passed' };
        const outcome = OUTCOMES.has(source.outcome) ? source.outcome : 'handled';
        const decision = {
            participant: participant.pluginId,
            outcome,
            status: typeof source.status === 'string' ? source.status : undefined,
            reason: typeof source.reason === 'string' ? source.reason : undefined,
            payload: source.payload,
        };
        if (['denied', 'degraded', 'failed', 'short-circuited', 'overridden'].includes(decision.outcome) && !decision.reason) {
            decision.reason = `${participant.pluginId} returned ${decision.outcome}`;
        }
        return decision;
    }

    function _finalOutcome(decisions) {
        if (!decisions.length) return 'degraded';
        const terminal = decisions.find(d => ['denied', 'failed', 'short-circuited', 'handled', 'degraded', 'overridden', 'no-owner', 'no-handler', 'no-target', 'unsupported-command', 'unsupported-operation', 'incompatible', 'incompatible-version', 'unavailable', 'provider-selection-required', 'user-action-required', 'stale', 'queued', 'validation-failed', 'cancelled', 'completed', 'timeout', 'retry-started', 'stopped'].includes(d.outcome));
        return terminal ? terminal.outcome : decisions[decisions.length - 1].outcome;
    }

    function _blockingConflict(conflicts) {
        return conflicts.find(conflict => conflict.type === 'duplicate-owner' || conflict.type === 'order-cycle') || null;
    }

    function _emitEvent(capability, event, payload) {
        const capabilityName = _canonicalCapabilityName(capability);
        if (!capabilityName || RESERVED_FUTURE_DOMAINS.has(capabilityName)) return;
        const detail = { capability: capabilityName, event, payload: payload || {}, timestamp: _now() };
        _notifySubscribers(event, detail);
        _notifySubscribers(`${capabilityName}:${event}`, detail);
        try {
            if (window.slopsmith && typeof window.slopsmith.emit === 'function') {
                window.slopsmith.emit(`${capabilityName}:${event}`, detail);
                window.slopsmith.emit('capability:event', detail);
            } else {
                window.dispatchEvent(new CustomEvent(`${capabilityName}:${event}`, { detail }));
                window.dispatchEvent(new CustomEvent('slopsmith:capability:event', { detail }));
            }
        } catch (err) {
            console.warn('[capabilities] event dispatch failed:', err);
        }
        const pipeline = pipelines.get(capabilityName);
        if (!pipeline) return;
        for (const participant of pipeline.participants.values()) {
            const handler = participant.eventHandlers && participant.eventHandlers[event];
            if (typeof handler !== 'function') continue;
            try { handler(detail); }
            catch (err) {
                _recordDecision({
                    commandId: `event-${capability}-${event}`,
                    capability: capabilityName,
                    command: event,
                    requester: detail.payload.source || 'event',
                    participant: participant.pluginId,
                    outcome: 'failed',
                    reason: err && err.message ? err.message : String(err),
                });
            }
        }
    }

    async function command(capabilityName, commandName, context = {}) {
        capabilityName = _canonicalCapabilityName(capabilityName);
        const commandId = `command-${++commandSeq}`;
        if (!capabilityName || RESERVED_FUTURE_DOMAINS.has(capabilityName)) {
            return {
                capability: capabilityName,
                command: commandName,
                requester: context.requester || 'unknown',
                outcome: 'degraded',
                reason: `Capability ${capabilityName || 'unknown'} is reserved for a future domain PR`,
                decisions: [],
            };
        }
        const pipeline = _resolvePipeline(capabilityName);
        const commandContext = {
            ...context,
            capability: capabilityName,
            command: commandName,
            requester: context.requester || 'unknown',
            origin: context.origin || 'system',
            reason: context.reason || 'No reason provided',
        };
        const decisions = [];
        const blockingConflict = _blockingConflict(pipeline.conflicts || []);
        if (blockingConflict) {
            const reason = `Capability ${capabilityName}.${commandName} degraded because ${blockingConflict.reason || blockingConflict.type}`;
            const decision = { participant: 'core', outcome: 'degraded', reason };
            decisions.push(decision);
            _recordDecision({
                commandId,
                capability: capabilityName,
                command: commandName,
                requester: commandContext.requester,
                origin: commandContext.origin,
                target: commandContext.target,
                participant: 'core',
                outcome: 'degraded',
                reason,
            });
            return {
                capability: capabilityName,
                command: commandName,
                requester: commandContext.requester,
                outcome: 'degraded',
                reason,
                decisions,
            };
        }
        const claim = _claimFromContext(commandContext);
        if (claim && _overrideMatchesClaim(commandContext, claim)) {
            const reason = `Capability ${capabilityName}.${commandName} skipped because a user override beat claim ${claim.claimId}`;
            const decision = { participant: 'core', outcome: 'overridden', reason, payload: { claimId: claim.claimId } };
            decisions.push(decision);
            _recordDecision({
                commandId,
                capability: capabilityName,
                command: commandName,
                requester: commandContext.requester,
                origin: commandContext.origin,
                target: commandContext.target,
                participant: 'core',
                outcome: 'overridden',
                reason,
                claimId: claim.claimId,
            });
            _emitEvent(capabilityName, 'override', { command: commandName, requester: commandContext.requester, claimId: claim.claimId, target: commandContext.target || commandContext.payload?.target || null });
            return {
                capability: capabilityName,
                command: commandName,
                requester: commandContext.requester,
                outcome: 'overridden',
                reason,
                payload: decision.payload,
                decisions,
            };
        }
        for (const participantId of pipeline.order) {
            const participant = pipeline.participants.get(participantId);
            if (!participant || participant.mode === 'disabled') continue;
            const handler = participant.handlers && participant.handlers[commandName];
            if (typeof handler !== 'function') continue;
            let decision;
            try {
                const timeoutMs = Number(commandContext.timeoutMs || DEFAULT_HANDLER_TIMEOUT_MS);
                const result = await _withTimeout(Promise.resolve(handler(commandContext)), timeoutMs, participant);
                decision = _normalizeDecision(participant, result);
            } catch (err) {
                decision = {
                    participant: participant.pluginId,
                    outcome: 'failed',
                    reason: err && err.message ? err.message : String(err),
                };
            }
            decisions.push(decision);
            _recordDecision({
                commandId,
                capability: capabilityName,
                command: commandName,
                requester: commandContext.requester,
                origin: commandContext.origin,
                target: commandContext.target,
                participant: decision.participant,
                outcome: decision.outcome,
                reason: decision.reason,
            });
            if (decision.outcome === 'transformed' && decision.payload && typeof decision.payload === 'object') {
                commandContext.payload = decision.payload;
                continue;
            }
            if (['denied', 'failed', 'short-circuited', 'handled', 'degraded', 'overridden', 'no-owner', 'no-handler', 'no-target', 'unsupported-command', 'unsupported-operation', 'incompatible', 'incompatible-version', 'unavailable', 'provider-selection-required', 'user-action-required', 'stale', 'queued', 'validation-failed', 'cancelled', 'completed', 'timeout', 'retry-started', 'stopped'].includes(decision.outcome)) break;
        }
        if (!decisions.length) {
            const reason = `No provider handled ${capabilityName}.${commandName}`;
            _remember(missingProviders, { capability: capabilityName, command: commandName, requester: commandContext.requester, reason });
            const decision = { participant: 'core', outcome: 'no-handler', reason };
            decisions.push(decision);
            _recordDecision({
                commandId,
                capability: capabilityName,
                command: commandName,
                requester: commandContext.requester,
                origin: commandContext.origin,
                participant: 'core',
                outcome: 'no-handler',
                reason,
            });
        }
        const outcome = _finalOutcome(decisions);
        const terminalDecision = decisions.find(d => ['denied', 'failed', 'short-circuited', 'handled', 'degraded', 'overridden', 'no-owner', 'no-handler', 'no-target', 'unsupported-command', 'unsupported-operation', 'incompatible', 'incompatible-version', 'unavailable', 'provider-selection-required', 'user-action-required', 'stale', 'queued', 'validation-failed', 'cancelled', 'completed', 'timeout', 'retry-started', 'stopped'].includes(d.outcome))
            || decisions[decisions.length - 1];
        return {
            capability: capabilityName,
            command: commandName,
            requester: commandContext.requester,
            outcome,
            status: terminalDecision && terminalDecision.status,
            reason: decisions.find(d => d.reason)?.reason,
            payload: terminalDecision && terminalDecision.payload,
            decisions,
        };
    }

    function _registerParticipant(pluginId, declaration, options = {}) {
        if (!pluginId || typeof pluginId !== 'string') return;
        _rememberPluginManifest(pluginId, declaration);
        const caps = _capabilityMap(declaration);
        const touched = new Set();
        for (const [capabilityName, rawDeclaration] of Object.entries(caps)) {
            const canonicalCapabilityName = _canonicalCapabilityName(capabilityName);
            if (!canonicalCapabilityName || !rawDeclaration || typeof rawDeclaration !== 'object') continue;
            if (RESERVED_FUTURE_DOMAINS.has(canonicalCapabilityName)) continue;
            const normalized = _normalizeDeclaration(rawDeclaration, declaration);
            const pipeline = _pipeline(canonicalCapabilityName);
            const participant = {
                pluginId,
                capability: canonicalCapabilityName,
                ...normalized,
                declarationMode: normalized.mode,
            };
            if (normalized.incompatible) {
                participant.handlers = {};
                participant.eventHandlers = {};
            }
            pipeline.participants.set(pluginId, _mergeParticipant(pipeline.participants.get(pluginId), participant));
            touched.add(canonicalCapabilityName);
            if (!options.deferResolve) _resolvePipeline(canonicalCapabilityName);
            _notifySubscribers('registered', { capability: canonicalCapabilityName, pluginId, timestamp: _now() });
        }
        return touched;
    }

    function registerParticipant(pluginId, declaration) {
        _registerParticipant(pluginId, declaration);
        _contributeDiagnostics();
    }

    function registerOwner(domainName, spec = {}) {
        const capabilityName = _canonicalCapabilityName(domainName);
        if (!capabilityName || RESERVED_FUTURE_DOMAINS.has(capabilityName)) return null;
        const source = spec && typeof spec === 'object' ? spec : {};
        const pluginId = typeof source.pluginId === 'string' && source.pluginId ? source.pluginId : `core.${capabilityName}`;
        const kind = VALID_DOMAIN_KINDS.has(source.kind) ? source.kind : 'command';
        const declaration = {
            roles: ['owner'],
            commands: _uniqueStrings(source.commands),
            operations: _uniqueStrings(source.operations || source.providerOperations || source.provider_operations),
            events: _uniqueStrings(source.events),
            emits: _uniqueStrings(source.emits),
            kind,
            mode: VALID_MODES.has(source.mode) ? source.mode : 'active',
            compatibility: VALID_COMPATIBILITY.has(source.compatibility) ? source.compatibility : 'none',
            ownership: VALID_OWNERSHIP.has(source.ownership) ? source.ownership : _ownershipForKind(kind),
            safety: VALID_SAFETY.has(source.safety) ? source.safety : (kind === 'diagnostic' ? 'diagnostic-only' : 'safe'),
            description: _shortDescription(source.description) || _shortDescription(source.summary),
            provider_policy: source.provider_policy && typeof source.provider_policy === 'object' ? source.provider_policy : {},
            handlers: source.handlers && typeof source.handlers === 'object' ? source.handlers : {},
            eventHandlers: source.eventHandlers && typeof source.eventHandlers === 'object' ? source.eventHandlers : {},
            runtime: true,
            version: 1,
        };
        registerParticipant(pluginId, { [capabilityName]: declaration });
        return { pluginId, capability: capabilityName, kind };
    }

    function setParticipantEnabled(pluginId, capabilityName, enabled, options = {}) {
        capabilityName = _canonicalCapabilityName(capabilityName);
        if (!pluginId || typeof pluginId !== 'string' || !capabilityName || typeof capabilityName !== 'string') {
            return { ok: false, reason: 'pluginId and capabilityName are required' };
        }
        if (pluginId === 'core') {
            return { ok: false, reason: 'Core capability participants cannot be disabled at runtime' };
        }
        const pipeline = pipelines.get(capabilityName);
        const participant = pipeline && pipeline.participants.get(pluginId);
        if (!participant) {
            return { ok: false, reason: `${pluginId} is not registered for ${capabilityName}` };
        }
        const nextEnabled = !!enabled;
        const previousMode = participant.mode;
        const restoredMode = participant.declarationMode && participant.declarationMode !== 'disabled'
            ? participant.declarationMode
            : 'active';
        participant.mode = nextEnabled ? restoredMode : 'disabled';
        participant.runtimeOverride = {
            enabled: nextEnabled,
            requester: options.requester || 'runtime',
            reason: options.reason || (nextEnabled ? 'Runtime capability enabled' : 'Runtime capability disabled'),
            timestamp: _now(),
        };
        const resolved = _resolvePipeline(capabilityName);
        _emitEvent('pipeline', 'participant.state-changed', {
            capability: capabilityName,
            pluginId,
            enabled: nextEnabled,
            previousMode,
            mode: participant.mode,
            conflicts: resolved.conflicts.slice(),
        });
        _contributeDiagnostics();
        return {
            ok: true,
            capability: capabilityName,
            pluginId,
            enabled: nextEnabled,
            previousMode,
            mode: participant.mode,
            conflicts: resolved.conflicts.slice(),
        };
    }

    function registerParticipants(entries) {
        const touched = new Set();
        const list = Array.isArray(entries) ? entries : [];
        for (const entry of list) {
            const pluginId = _pluginEntryId(entry);
            if (!pluginId) continue;
            _rememberPluginManifest(pluginId, entry);
        }
        for (const entry of list) {
            const pluginId = _pluginEntryId(entry);
            if (!pluginId) continue;
            const participantCaps = _registerParticipant(pluginId, _pluginEntryDeclaration(entry), { deferResolve: true });
            for (const capabilityName of participantCaps || []) touched.add(capabilityName);
        }
        for (const capabilityName of Array.from(touched).sort()) _resolvePipeline(capabilityName);
        _contributeDiagnostics();
        return Array.from(touched).sort();
    }

    function unregisterParticipant(pluginId, capabilityName = null) {
        capabilityName = capabilityName == null ? null : _canonicalCapabilityName(capabilityName);
        _cleanupClaimsForParticipant(pluginId, capabilityName);
        for (const [name, pipeline] of pipelines.entries()) {
            if (capabilityName && name !== capabilityName) continue;
            if (pipeline.participants.delete(pluginId)) {
                _resolvePipeline(name);
                _notifySubscribers('unregistered', { capability: name, pluginId, timestamp: _now() });
            }
        }
        _contributeDiagnostics();
    }

    function inspect(capabilityName = null) {
        if (capabilityName) {
            const pipeline = pipelines.get(_canonicalCapabilityName(capabilityName));
            return pipeline ? _pipelineSummary(pipeline) : null;
        }
        return Array.from(pipelines.values()).map(_pipelineSummary);
    }

    function validateRuntime(options = {}) {
        const phase = options && typeof options.phase === 'string' ? options.phase : 'runtime';
        for (const capabilityName of Array.from(pipelines.keys()).sort()) _resolvePipeline(capabilityName);
        const snapshot = snapshotDiagnostics();
        _emitEvent('pipeline', 'runtime.validated', {
            phase,
            conflicts: snapshot.conflicts || [],
            pipelineCount: (snapshot.pipelines || []).length,
            participantCount: (snapshot.participants || []).length,
        });
        _contributeDiagnostics();
        return snapshot;
    }

    function registerCompatibilityShim(shim) {
        const source = shim && typeof shim === 'object' ? shim : {};
        const capability = _canonicalCapabilityName(source.capability || 'unknown') || 'unknown';
        if (RESERVED_FUTURE_DOMAINS.has(capability)) return null;
        const shimId = source.shimId || `${capability}:${source.legacySurface || 'legacy'}`;
        const existing = compatibilityShims.find(entry => entry.shimId === shimId);
        const hit = source.status === 'used' || source.used === true || source.hit === true;
        const explicitHitCount = Number(source.hitCount);
        const hasExplicitHitCount = Number.isFinite(explicitHitCount) && explicitHitCount >= 0;
        const previousHitCount = existing && Number.isFinite(Number(existing.hitCount)) ? Number(existing.hitCount) : 0;
        const hitCount = Math.max(previousHitCount, hasExplicitHitCount ? explicitHitCount : 0) + (hit && !hasExplicitHitCount ? 1 : 0);
        const status = hit || hitCount > 0 ? 'used' : (source.status || (existing && existing.status) || 'active');
        const entry = {
            ...(existing || {}),
            shimId,
            source: source.source || 'unknown',
            capability,
            legacySurface: source.legacySurface || 'unknown',
            status,
            reason: source.reason,
            hitCount,
            lastHitAt: source.lastHitAt || (hit ? _now() : (existing && existing.lastHitAt) || null),
        };
        const providerId = source.providerId || source.provider_id || (existing && existing.providerId);
        if (providerId) entry.providerId = String(providerId);
        const ownerPluginId = source.ownerPluginId || source.owner_plugin_id || (existing && existing.ownerPluginId);
        if (ownerPluginId) entry.ownerPluginId = String(ownerPluginId);
        if (existing) {
            const index = compatibilityShims.indexOf(existing);
            compatibilityShims.splice(index, 1, { timestamp: existing.timestamp || _now(), ...entry });
            _contributeDiagnostics();
        } else {
            _remember(compatibilityShims, entry);
        }
        return entry;
    }

    function _legacyHitSource(source) {
        if (!source || typeof source !== 'object') return 'legacy-runtime';
        const candidate = source.source || source.pluginId || source.owner || source.requester || source.providerId || source.id;
        if (candidate) return String(candidate);
        const activePluginId = window.slopsmith && (window.slopsmith._loadingPluginId || window.slopsmith._activePluginId);
        return activePluginId ? String(activePluginId) : 'legacy-runtime';
    }

    function _legacyHitIdPart(value) {
        return String(value || 'unknown').replace(/[^a-zA-Z0-9_.:-]+/g, '-');
    }

    function recordLegacyHit(hit) {
        const source = hit && typeof hit === 'object' ? hit : {};
        if (!source.capability || !source.legacySurface) return null;
        const actor = _legacyHitSource(source);
        const capability = _canonicalCapabilityName(source.capability);
        return registerCompatibilityShim({
            shimId: source.shimId || `runtime:${_legacyHitIdPart(capability)}:${_legacyHitIdPart(source.legacySurface)}:${_legacyHitIdPart(actor)}`,
            source: actor,
            capability,
            legacySurface: source.legacySurface,
            status: 'used',
            reason: source.reason || 'Legacy runtime surface used',
            hit: true,
            lastHitAt: source.lastHitAt,
            providerId: source.providerId || source.provider_id,
            ownerPluginId: source.ownerPluginId || source.owner_plugin_id,
        });
    }

    function recordUserOverride(override) {
        const source = override && typeof override === 'object' ? override : {};
        _remember(userOverrides, {
            type: 'manual',
            capability: _canonicalCapabilityName(source.capability || 'unknown') || 'unknown',
            command: source.command,
            source: source.source || 'unknown',
            target: source.target,
            selector: source.selector || _targetSelector(source),
            reason: source.reason || 'User override recorded',
        });
    }

    function claim(request = {}) {
        const source = request && typeof request === 'object' ? request : {};
        const capability = _canonicalCapabilityName(source.capability || 'unknown') || 'unknown';
        const claimId = source.claimId || source.id;
        if (!claimId) return () => {};
        const key = _claimKey(capability, claimId);
        if (!activeClaims.has(key)) {
            const owner = _claimOwner(capability, source);
            const entry = {
                claimId,
                capability,
                owner,
                requester: source.requester || source.source || source.owner || 'unknown',
                targetSelector: _targetSelector(source),
                state: 'active',
                createdAt: _now(),
                updatedAt: _now(),
                restoreSnapshotRef: source.restoreSnapshotRef || null,
                reason: source.reason,
            };
            activeClaims.set(key, entry);
            _recordDecision({ commandId: `claim-${claimId}`, capability, command: 'claim', requester: entry.requester, participant: 'core', outcome: 'handled', reason: entry.reason });
            _emitEvent(capability, 'claim:created', entry);
        }
        return () => release({ capability, claimId });
    }

    function release(request = {}) {
        const source = typeof request === 'string' ? { claimId: request } : (request && typeof request === 'object' ? request : {});
        if (source.capability) source.capability = _canonicalCapabilityName(source.capability);
        const claimId = source.claimId || source.id;
        if (!claimId) return { ok: true, released: false };
        let released = null;
        for (const [key, entry] of Array.from(activeClaims.entries())) {
            if (entry.claimId !== claimId) continue;
            if (source.capability && entry.capability !== source.capability) continue;
            released = _releaseClaimEntry(key, entry, source.reason || 'Claim released');
        }
        if (!released) {
            _recordDecision({ commandId: `release-${claimId}`, capability: source.capability || 'unknown', command: 'release', requester: source.requester || source.source || source.owner || 'unknown', participant: 'core', outcome: 'degraded', reason: 'Release requested for unknown claim' });
            return { ok: true, released: false };
        }
        _recordDecision({ commandId: `release-${claimId}`, capability: released.capability, command: 'release', requester: source.requester || source.source || released.requester || released.owner || source.owner, participant: 'core', outcome: 'handled' });
        return { ok: true, released: true, claim: released };
    }

    function _dispatchStatus(result) {
        if (!result) return 'error';
        if (result.status) return result.status;
        if (result.outcome === 'handled' || result.outcome === 'passed') return 'applied';
        if (result.outcome === 'overridden') return 'overridden';
        if (result.outcome === 'no-owner') return 'no-owner';
        if (result.outcome === 'no-handler') return 'no-handler';
        if (result.outcome === 'no-target') return 'no-target';
        if (result.outcome === 'unsupported-command') return 'unsupported-command';
        if (result.outcome === 'unsupported-operation') return 'unsupported-operation';
        if (result.outcome === 'incompatible') return 'incompatible';
        if (result.outcome === 'incompatible-version') return 'incompatible-version';
        if (result.outcome === 'unavailable') return 'unavailable';
        if (result.outcome === 'provider-selection-required') return 'provider-selection-required';
        if (result.outcome === 'user-action-required') return 'user-action-required';
        if (result.outcome === 'stale') return 'stale';
        if (result.outcome === 'queued') return 'queued';
        if (result.outcome === 'validation-failed') return 'validation-failed';
        if (result.outcome === 'cancelled') return 'cancelled';
        if (result.outcome === 'completed') return 'completed';
        if (result.outcome === 'timeout') return 'timeout';
        if (result.outcome === 'retry-started') return 'retry-started';
        if (result.outcome === 'stopped') return 'stopped';
        if (result.outcome === 'denied' || result.outcome === 'short-circuited') return 'blocked';
        if (result.outcome === 'failed') return 'error';
        if (result.outcome === 'degraded') return 'no-handler';
        return result.outcome || 'error';
    }

    async function dispatch(request = {}) {
        const source = request && typeof request === 'object' ? request : {};
        const capability = _canonicalCapabilityName(source.capability);
        const commandName = source.command;
        if (!capability || !commandName) return { status: 'error', outcome: 'failed', reason: 'capability and command are required' };
        if (RESERVED_FUTURE_DOMAINS.has(capability)) {
            return { status: 'no-handler', outcome: 'degraded', capability, command: commandName, reason: `Capability ${capability} is reserved for a future domain PR` };
        }
        const pipeline = _resolvePipeline(capability);
        const incompatibleParticipants = _pipelineParticipants(pipeline).filter(participant => participant.incompatible);
        if (incompatibleParticipants.length && incompatibleParticipants.length === pipeline.participants.size) {
            const reason = `Capability ${capability} is unavailable because all participants are incompatible`;
            _recordDecision({ commandId: `dispatch-${++commandSeq}`, capability, command: commandName, requester: source.source || source.requester || 'dispatch', participant: 'core', outcome: 'incompatible-version', reason });
            return { status: 'incompatible-version', outcome: 'incompatible-version', capability, command: commandName, reason };
        }
        const participants = _pipelineParticipants(pipeline).filter(participant => participant.mode !== 'disabled' && !participant.incompatible);
        const owners = participants.filter(participant => participant.roles.includes('owner'));
        const coordinators = participants.filter(participant => participant.roles.includes('coordinator'));
        if (!owners.length && !coordinators.length) {
            const reason = `No owner or coordinator registered for ${capability}`;
            _remember(missingProviders, { capability, command: commandName, requester: source.source || source.requester || 'dispatch', reason });
            _recordDecision({ commandId: `dispatch-${++commandSeq}`, capability, command: commandName, requester: source.source || source.requester || 'dispatch', participant: 'core', outcome: 'no-owner', reason });
            _emitEvent(capability, 'conflict:missing-provider', { command: commandName, reason });
            return { status: 'no-owner', outcome: 'no-owner', capability, command: commandName, reason };
        }
        const commandDeclared = participants.some(participant => (participant.commands || []).includes(commandName));
        if (!commandDeclared) {
            const reason = `Unsupported command ${capability}.${commandName}`;
            _recordDecision({ commandId: `dispatch-${++commandSeq}`, capability, command: commandName, requester: source.source || source.requester || 'dispatch', participant: 'core', outcome: 'unsupported-command', reason });
            return { status: 'unsupported-command', outcome: 'unsupported-command', capability, command: commandName, reason };
        }
        const hasHandler = participants.some(participant => participant.handlers && typeof participant.handlers[commandName] === 'function');
        if (!hasHandler) {
            const reason = `No handler registered for ${capability}.${commandName}`;
            _remember(missingProviders, { capability, command: commandName, requester: source.source || source.requester || 'dispatch', reason });
            _recordDecision({ commandId: `dispatch-${++commandSeq}`, capability, command: commandName, requester: source.source || source.requester || 'dispatch', participant: 'core', outcome: 'no-handler', reason });
            return { status: 'no-handler', outcome: 'no-handler', capability, command: commandName, reason };
        }
        const result = await command(capability, commandName, {
            requester: source.source || source.requester || 'dispatch',
            origin: source.origin || 'dispatch',
            reason: source.reason || 'Capability dispatch',
            target: source.target || source.args?.target || null,
            payload: source.args || source.payload || {},
            claim: source.claim,
            timeoutMs: source.timeoutMs || (capability === 'audio-mix' && (commandName === 'get-fader-value' || commandName === 'set-fader-value') ? 2100 : undefined),
        });
        const status = _dispatchStatus(result);
        _emitEvent(capability, 'dispatched', { command: commandName, status, result, source: source.source || source.requester || 'dispatch' });
        return { ...result, status };
    }

    function subscribe(event, fn) {
        if (typeof event !== 'string' || typeof fn !== 'function') return () => {};
        const handlers = subscribers.get(event) || [];
        handlers.push(fn);
        subscribers.set(event, handlers);
        return () => {
            const current = subscribers.get(event) || [];
            subscribers.set(event, current.filter(handler => handler !== fn));
        };
    }

    function snapshotDiagnostics() {
        const pipelineSummaries = inspect();
        const snapshot = {
            schema: 'slopsmith.capabilities.diagnostics.v1',
            pipelines: pipelineSummaries,
            participants: pipelineSummaries.flatMap(pipeline => Array.isArray(pipeline.participants) ? pipeline.participants : []),
            recentDecisions: recentDecisions.slice(),
            conflicts: Array.from(pipelines.values()).flatMap(p => p.conflicts.map(c => ({ capability: p.name, ...c }))),
            missingProviders: missingProviders.slice(),
            compatibilityShims: compatibilityShims.slice(),
            userOverrides: userOverrides.slice(),
            activeClaims: Array.from(activeClaims.values()),
            claimLifecycle: claimLifecycle.slice(),
            unsupportedVersions: unsupportedVersions.slice(),
            knownPlugins: Array.from(knownPlugins.values()).map(_knownPluginSummary),
            expectedCompatibilityShims: _expectedCompatibilityShimSummary(),
        };
        let currentSize = JSON.stringify(snapshot).length;
        while (snapshot.recentDecisions.length && currentSize > MAX_SNAPSHOT_BYTES) {
            const removedDecision = snapshot.recentDecisions.shift();
            currentSize -= JSON.stringify(removedDecision).length;
        }
        snapshot.snapshotBytes = JSON.stringify(snapshot).length;
        return _safeValue(snapshot);
    }

    let contributing = false;
    let capabilitiesChangeScheduled = false;

    function _scheduleCapabilitiesChanged() {
        if (capabilitiesChangeScheduled) return;
        capabilitiesChangeScheduled = true;
        const schedule = window.queueMicrotask ? window.queueMicrotask.bind(window) : callback => setTimeout(callback, 0);
        schedule(() => {
            capabilitiesChangeScheduled = false;
            const detail = { timestamp: _now() };
            try {
                window.dispatchEvent(new CustomEvent('slopsmith:capabilities:changed', { detail }));
            } catch (_err) { /* capability diagnostics must not break runtime behavior */ }
        });
    }

    function _contributeDiagnostics() {
        if (contributing) return;
        const diagnostics = window.slopsmith && window.slopsmith.diagnostics;
        if (diagnostics && typeof diagnostics.contribute === 'function') {
            contributing = true;
            try { diagnostics.contribute('capabilities', snapshotDiagnostics()); }
            catch (_err) { /* diagnostics must never break plugin behavior */ }
            finally { contributing = false; }
        }
        _scheduleCapabilitiesChanged();
    }

    function _coreHandled(payload = {}) {
        return { outcome: 'handled', payload };
    }

    function _coreDegraded(reason, payload = {}) {
        return { outcome: 'degraded', reason, payload };
    }

    const api = {
        version: 1,
        registerOwner,
        registerParticipant,
        registerParticipants,
        unregisterParticipant,
        setParticipantEnabled,
        command,
        dispatch,
        claim,
        release,
        subscribe,
        emitEvent: _emitEvent,
        inspect,
        validateRuntime,
        snapshotDiagnostics,
        getDiagnostics: snapshotDiagnostics,
        registerCompatibilityShim,
        recordLegacyHit,
        recordUserOverride,
    };

    window.slopsmith.capabilities = api;

    registerParticipant('core', {
        diagnostics: {
            roles: ['owner', 'provider'],
            commands: ['snapshot'],
            events: [],
            kind: 'diagnostic',
            description: 'Provides read-only capability snapshots for support bundles and the Capability Inspector.',
            compatibility: 'none',
            ownership: 'diagnostic-only',
            safety: 'diagnostic-only',
            handlers: {
                snapshot: () => _coreHandled(snapshotDiagnostics()),
            },
        },
        pipeline: {
            roles: ['owner', 'provider'],
            commands: ['resolve', 'inspect', 'validate', 'participant.set-enabled'],
            events: ['resolved', 'runtime.validated', 'participant.state-changed'],
            kind: 'diagnostic',
            description: 'Owns capability graph inspection, validation, resolution, and participant enablement commands.',
            compatibility: 'none',
            ownership: 'diagnostic-only',
            safety: 'diagnostic-only',
            handlers: {
                resolve: (ctx) => _coreHandled(inspect(ctx.target && ctx.target.capability)),
                inspect: (ctx) => _coreHandled(inspect(ctx.target && ctx.target.capability)),
                validate: () => _coreHandled(validateRuntime({ phase: 'pipeline-command' })),
                'participant.set-enabled': (ctx) => _coreHandled(setParticipantEnabled(
                    ctx.target && ctx.target.pluginId,
                    ctx.target && ctx.target.capability,
                    !!(ctx.target && ctx.target.enabled),
                    { requester: ctx.requester, reason: ctx.reason }
                )),
            },
        },
    });
    try {
        window.dispatchEvent(new CustomEvent('slopsmith:capabilities:ready', { detail: api }));
        _notifySubscribers('registered', { capability: '*', pluginId: 'core', timestamp: _now() });
    } catch (_) {}
})();