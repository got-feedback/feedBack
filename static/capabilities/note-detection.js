// Core note-detection capability domain (spec 009 control-plane skeleton).
//
// Promotes `note-detection` as a provider-coordinator over detection
// providers. Doctrine (specs/009-note-detection-domain/spec.md): the domain
// exposes detection PRIMITIVES through requester-owned, context-scoped
// BINDINGS — a monophonic pitch estimate and a polyphonic "is this note set
// ringing now?" verification — while consumers own all judgment semantics
// (hit windows, streaks, accuracy). Hit/miss results flow through the domain
// as observability EVENTS, never as domain-owned scoring.
//
// This slice ships the control plane the piano/keys epic needs: provider
// registration (a Web-MIDI keys "detector" is an exact-verdict provider, the
// JUCE engine verifier and the JS harmonic-comb are DSP providers), binding
// lifecycle with per-binding context, target registration, event flow, shim
// accounting for the legacy chart-coupled `highway.setNoteStateProvider`
// surface, and redaction-safe diagnostics. The deeper spec-009 work — wiring
// per-binding tuning contexts down into the engine verifier and migrating
// the chart path onto bindings — lands with the full spec-009 slice.
(function () {
    'use strict';

    window.feedBack = window.feedBack || {};
    const capabilities = window.feedBack.capabilities;
    if (!capabilities || capabilities.version !== 1) return;
    if (window.feedBack.noteDetection && window.feedBack.noteDetection.version === 1) return;

    // providerId → { id, label, kind, primitives } — kind is 'midi' (exact
    // verdicts from a digital instrument), 'engine' (desktop JUCE verifier),
    // or 'js' (browser harmonic-comb / YIN fallback).
    const providers = new Map();
    // bindingId → { id, requester, providerId, context, target } — context is
    // a REDACTED summary (arrangement kind, string count, capo, midi range);
    // never device labels or song identity.
    const bindings = new Map();
    let bindingSeq = 0;
    let lastOutcome = null;

    function _handled(payload = {}) { return { outcome: 'handled', payload }; }
    function _degraded(reason, payload = {}) { return { outcome: 'degraded', reason, payload }; }
    function _unavailable(reason, payload = {}) { return { outcome: 'unavailable', reason, payload }; }

    function _emit(name, detail) {
        try { capabilities.emitEvent('note-detection', name, detail || {}); }
        catch (_) { /* eventing must not break detection */ }
    }

    const _ARRANGEMENT_KINDS = new Set(['guitar', 'bass', 'keys', 'piano', 'ukulele', 'notation']);

    function _contextSummary(context) {
        const source = context && typeof context === 'object' ? context : {};
        const summary = {};
        const arrangement = String(source.arrangement || '').trim().toLowerCase();
        if (_ARRANGEMENT_KINDS.has(arrangement)) summary.arrangement = arrangement;
        if (Number.isFinite(Number(source.stringCount))) summary.stringCount = Number(source.stringCount);
        if (Number.isFinite(Number(source.capo))) summary.capo = Number(source.capo);
        if (Number.isFinite(Number(source.midiLow))) summary.midiLow = Number(source.midiLow);
        if (Number.isFinite(Number(source.midiHigh))) summary.midiHigh = Number(source.midiHigh);
        return summary;
    }

    function _snapshot(extra = {}) {
        return {
            available: providers.size > 0,
            providers: Array.from(providers.values()).map(({ participantId: _, ...rest }) => ({
                ...rest,
                primitives: Array.isArray(rest.primitives) ? rest.primitives.slice() : [],
            })),
            bindings: Array.from(bindings.values()).map(binding => ({
                id: binding.id,
                requester: binding.requester,
                providerId: binding.providerId,
                context: { ...binding.context },
                hasTarget: !!binding.target,
                targetSize: binding.target ? binding.target.length : 0,
            })),
            lastOutcome: lastOutcome ? { ...lastOutcome } : null,
            ...extra,
        };
    }

    function _contributeDiagnostics() {
        const diagnostics = window.feedBack && window.feedBack.diagnostics;
        if (diagnostics && typeof diagnostics.contribute === 'function') {
            try {
                const snap = _snapshot();
                // Omit provider labels from diagnostics: labels may contain
                // hardware device names (MIDI/audio) that are PII-adjacent.
                // Keep id, kind, and primitives for operational observability.
                const redacted = {
                    ...snap,
                    providers: snap.providers.map(({ label: _label, ...safe }) => safe),
                };
                diagnostics.contribute('note-detection-capability', {
                    schema: 'feedBack.note_detection_capability.v1',
                    ...redacted,
                });
            } catch (_) { /* diagnostics must not break detection */ }
        }
    }

    function _registerProvider(ctx = {}) {
        const payload = ctx.payload && typeof ctx.payload === 'object' ? ctx.payload : {};
        const providerId = String(payload.providerId || payload.id || '').trim();
        if (!providerId) return _degraded('Provider registration requires a providerId', _snapshot());
        const provider = {
            id: providerId,
            label: String(payload.label || providerId),
            kind: ['midi', 'engine', 'js'].includes(payload.kind) ? payload.kind : 'js',
            primitives: Array.isArray(payload.primitives)
                ? payload.primitives.filter(p => ['pitch.estimate', 'verify.target'].includes(p))
                : [],
        };
        const participantId = String(ctx.source || ctx.requester || providerId);
        // Ownership check: if a provider is already registered under this
        // providerId by a different participant, reject the re-registration so a
        // hostile or confused plugin cannot silently take over an existing provider
        // entry and redirect all bindings that resolve to it.
        const existing = providers.get(providerId);
        if (existing && existing.participantId !== participantId) {
            return _degraded(
                `Provider ${providerId} is already registered by a different participant`,
                _snapshot(),
            );
        }
        provider.participantId = participantId;
        // Track whether availability will flip before mutating the map.
        const wasAvailable = providers.size > 0;
        providers.set(providerId, provider);
        capabilities.registerParticipant(participantId, {
            'note-detection': {
                roles: ['provider'],
                operations: provider.primitives.slice(),
                events: [],
                mode: 'active',
                safety: 'sensitive',
                runtime: true,
                description: `Note-detection provider ${provider.label} (${provider.kind}).`,
                provider_policy: { providerId, label: provider.label, kind: provider.kind },
            },
        });
        _emit('provider-registered', { providerId, kind: provider.kind });
        // Emit availability-changed only on a real 0→1 transition so that
        // re-registering or refreshing an existing provider does not produce
        // a spurious edge that subscribers cannot distinguish from a genuine flip.
        if (!wasAvailable) _emit('availability-changed', { available: true });
        _contributeDiagnostics();
        return _handled(_snapshot({ registered: providerId }));
    }

    function _unregisterProvider(ctx = {}) {
        const payload = ctx.payload && typeof ctx.payload === 'object' ? ctx.payload : {};
        const providerId = String(payload.providerId || payload.id || '').trim();
        if (!providerId || !providers.has(providerId)) {
            return _degraded(`Unknown note-detection provider: ${providerId || '(none)'}`, _snapshot());
        }
        const removedProvider = providers.get(providerId);
        // Ownership check: only the original registrant may unregister a provider.
        // A cross-owner unregister would silently cascade binding-closed for all
        // other requesters whose bindings resolve to this provider.
        const callerId = String(ctx.source || ctx.requester || providerId);
        if (removedProvider.participantId && removedProvider.participantId !== callerId) {
            return _degraded(
                `Provider ${providerId} can only be unregistered by its original registrant`,
                _snapshot(),
            );
        }
        providers.delete(providerId);
        for (const [id, binding] of Array.from(bindings.entries())) {
            if (binding.providerId === providerId) {
                bindings.delete(id);
                _emit('binding-closed', { bindingId: id, requester: binding.requester, reason: 'provider-unregistered' });
            }
        }
        // Only remove the participant when all of its providers are gone.
        // A single plugin may have registered multiple providers under the same
        // participantId; removing the participant on the first unregister would
        // leave its remaining providers invisible in inspect() / diagnostics.
        if (removedProvider && removedProvider.participantId &&
                typeof capabilities.unregisterParticipant === 'function') {
            const stillHasProvider = Array.from(providers.values())
                .some(p => p.participantId === removedProvider.participantId);
            if (!stillHasProvider) {
                try { capabilities.unregisterParticipant(removedProvider.participantId, 'note-detection'); }
                catch (_) { /* best-effort */ }
            }
        }
        _emit('provider-unregistered', { providerId });
        if (providers.size === 0) _emit('availability-changed', { available: false });
        _contributeDiagnostics();
        return _handled(_snapshot({ unregistered: providerId }));
    }

    function _openBinding(ctx = {}) {
        const payload = ctx.payload && typeof ctx.payload === 'object' ? ctx.payload : {};
        const requester = String(ctx.source || ctx.requester || 'unknown');
        if (providers.size === 0) {
            return _unavailable('No note-detection provider registered', _snapshot());
        }
        const requestedProvider = String(payload.providerId || '').trim();
        const provider = requestedProvider
            ? providers.get(requestedProvider)
            : providers.values().next().value;
        if (!provider) {
            return _degraded(`Unknown note-detection provider: ${requestedProvider}`, _snapshot());
        }
        const binding = {
            id: `ndb-${++bindingSeq}`,
            requester,
            providerId: provider.id,
            context: _contextSummary(payload.context),
            target: null,
        };
        bindings.set(binding.id, binding);
        _emit('binding-opened', { bindingId: binding.id, requester, providerId: provider.id, context: { ...binding.context } });
        _contributeDiagnostics();
        return _handled(_snapshot({ bindingId: binding.id }));
    }

    function _resolveOwnedBinding(ctx = {}) {
        const payload = ctx.payload && typeof ctx.payload === 'object' ? ctx.payload : {};
        const bindingId = String(payload.bindingId || '').trim();
        const requester = String(ctx.source || ctx.requester || 'unknown');
        const binding = bindings.get(bindingId);
        if (!binding) {
            return { error: _degraded(`Unknown note-detection binding: ${bindingId || '(none)'}`, _snapshot()) };
        }
        if (binding.requester !== requester) {
            return { error: _degraded(`Note-detection binding ${bindingId} is owned by ${binding.requester}`, _snapshot()) };
        }
        return { bindingId, binding };
    }

    function _closeBinding(ctx = {}) {
        const resolved = _resolveOwnedBinding(ctx);
        if (resolved.error) return resolved.error;
        const { bindingId, binding } = resolved;
        bindings.delete(bindingId);
        _emit('binding-closed', { bindingId, requester: binding.requester, reason: 'closed' });
        _contributeDiagnostics();
        return _handled(_snapshot({ closed: bindingId }));
    }

    function _setTarget(ctx = {}) {
        const payload = ctx.payload && typeof ctx.payload === 'object' ? ctx.payload : {};
        const resolved = _resolveOwnedBinding(ctx);
        if (resolved.error) return resolved.error;
        const { bindingId, binding } = resolved;
        const notes = Array.isArray(payload.notes) ? payload.notes.slice() : null;
        binding.target = notes;
        _emit('target-changed', {
            bindingId,
            requester: binding.requester,
            targetSize: notes ? notes.length : 0,
        });
        _contributeDiagnostics();
        return _handled(_snapshot({ bindingId, targetSize: notes ? notes.length : 0 }));
    }

    // Observability flow: providers/consumers report detection results so the
    // pipeline carries hit/miss/verdict events (roadmap: "hit/miss event
    // flow") without the domain owning judgment. Payloads are bounded by the
    // caller; this records the last outcome for diagnostics with safe fields
    // only.
    function _reportResult(name, detail) {
        const source = detail && typeof detail === 'object' ? detail : {};
        lastOutcome = {
            event: name,
            bindingId: source.bindingId ? String(source.bindingId) : null,
            providerId: source.providerId ? String(source.providerId) : null,
            midi: Number.isFinite(Number(source.midi)) ? Number(source.midi) : null,
            hit: typeof source.hit === 'boolean' ? source.hit : null,
        };
        _emit(name, { ...lastOutcome });
        _contributeDiagnostics();
    }

    capabilities.registerOwner('note-detection', {
        pluginId: 'core.note-detection',
        kind: 'provider-coordinator',
        safety: 'sensitive',
        commands: [
            'inspect', 'register-provider', 'unregister-provider',
            'open-binding', 'close-binding', 'set-target', 'clear-target',
        ],
        operations: ['pitch.estimate', 'verify.target'],
        events: [
            'provider-registered', 'provider-unregistered', 'availability-changed',
            'binding-opened', 'binding-closed', 'target-changed',
            'hit', 'miss', 'verdict',
        ],
        description: 'Coordinates note-detection providers and requester-owned, context-scoped detection bindings; consumers own judgment.',
        handlers: {
            inspect: (ctx) => _handled(_snapshot()),
            'register-provider': (ctx) => _registerProvider(ctx),
            'unregister-provider': (ctx) => _unregisterProvider(ctx),
            'open-binding': (ctx) => _openBinding(ctx),
            'close-binding': (ctx) => _closeBinding(ctx),
            'set-target': (ctx) => _setTarget(ctx),
            'clear-target': (ctx) => _setTarget({ ...ctx, payload: { ...(ctx.payload || {}), notes: null } }),
        },
    });

    // ── Legacy chart-coupled shim accounting ────────────────────────────────
    // The notedetect plugin drives the highway through
    // `highway.setNoteStateProvider(fn)` — the single-global-detector surface
    // spec 009 retires. Wrap it (behavior-preserving) to count bridge hits.
    // highway.js loads after this host, so wrap lazily on the first
    // opportunity and give up quietly if the surface never appears.
    function _wrapLegacyNoteStateProvider() {
        const highway = window.highway;
        if (!highway || typeof highway.setNoteStateProvider !== 'function' || highway.__ndShimWrapped) return false;
        const original = highway.setNoteStateProvider.bind(highway);
        highway.setNoteStateProvider = function (fn) {
            try {
                capabilities.registerCompatibilityShim({
                    capability: 'note-detection',
                    shimId: 'note-detection:highway.setNoteStateProvider',
                    legacySurface: 'highway.setNoteStateProvider(fn)',
                    source: 'core.note-detection',
                    ownerPluginId: 'core.note-detection',
                    reason: 'Chart-coupled note-state provider predates spec-009 bindings.',
                    status: 'used',
                    hit: true,
                });
            } catch (_) { /* accounting must not break the legacy path */ }
            return original(fn);
        };
        highway.__ndShimWrapped = true;
        return true;
    }
    if (!_wrapLegacyNoteStateProvider()) {
        const sm = window.feedBack;
        if (typeof sm.on === 'function') {
            try { sm.on('song:loaded', () => { _wrapLegacyNoteStateProvider(); }); }
            catch (_) { /* best-effort */ }
        }
        if (window.document && typeof window.document.addEventListener === 'function') {
            window.document.addEventListener('DOMContentLoaded', () => { _wrapLegacyNoteStateProvider(); }, { once: true });
        }
    }

    window.feedBack.noteDetection = {
        version: 1,
        snapshot: _snapshot,
        reportHit: (detail) => _reportResult('hit', detail),
        reportMiss: (detail) => _reportResult('miss', detail),
        reportVerdict: (detail) => _reportResult('verdict', detail),
    };
    _contributeDiagnostics();
})();
