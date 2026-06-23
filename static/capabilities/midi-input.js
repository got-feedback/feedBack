// Core MIDI-input capability domain (spec 012 control plane).
//
// The MIDI analog of `audio-input`: a core-owned provider-coordinator over MIDI
// device discovery, selection, and open/close session lifecycle. It is NOT
// owned by any feature plugin (an input plane outlives any feature, exactly as
// `audio-input` is `core.audio.session`-owned), and it is deliberately separate
// from `audio-input` (whose source/open contract is audio-frame-centric:
// channel shapes, sample buffers) — MIDI carries discrete messages, not audio.
//
// Consumers (the input_setup wizard, the piano/keys and drums plugins, and —
// later — note-detection's Web-MIDI provider) converge on ONE device-access
// boundary here: one permission prompt, one source list, one redaction
// boundary, replacing private per-plugin `navigator.requestMIDIAccess()` calls.
//
// Web-MIDI nuance vs audio: `requestMIDIAccess()` gates the whole input LIST, so
// `discover` (not `open-source`) is the permission boundary for MIDI. `inspect`
// / `list-sources` / `select-source` stay prompt-free and never request access.
//
// Live message delivery (needed by the "play a note / hit a pad" calibration
// check) is exposed to in-page consumers through the public global's session
// handle, never as raw capability events or diagnostics.
(function () {
    'use strict';

    window.feedBack = window.feedBack || {};
    const capabilities = window.feedBack.capabilities;
    if (!capabilities || capabilities.version !== 1) return;
    if (window.feedBack.midiInput && window.feedBack.midiInput.version === 1) return;

    const STORAGE_KEY = 'feedBack.midiInput.selectedLogicalSourceKey';

    // providerId → { id, label, participantId, handlers:{ enumerate, open, close } }
    // handlers are LIVE functions supplied in-page via the public global; they
    // never travel through the capability `command` payload.
    const providers = new Map();
    // logicalSourceKey → { sourceId, providerId, logicalSourceKey, kind, label, availability }
    const sources = new Map();
    // logicalSourceKey → { refs:Set<requester>, handle } — one shared open
    // session per source; the provider is closed only after the last release.
    const sessions = new Map();
    // logicalSourceKey → Promise — in-flight provider.open() calls, so concurrent
    // opens for the same source coalesce onto one provider session instead of each
    // calling provider.open() (which, for Web-MIDI, would overwrite the shared
    // input.onmidimessage handler and orphan the earlier session/handle).
    const opening = new Map();
    let selectedKey = _readStorage();
    let lastOutcome = null;

    // ── outcome helpers (mirror note-detection.js) ──────────────────────────
    function _handled(payload = {}) { lastOutcome = { outcome: 'handled' }; return { outcome: 'handled', payload }; }
    function _degraded(reason, payload = {}) { lastOutcome = { outcome: 'degraded', reason }; return { outcome: 'degraded', reason, payload }; }
    function _denied(reason, payload = {}) { lastOutcome = { outcome: 'denied', reason }; return { outcome: 'denied', reason, payload }; }
    function _unavailable(reason, payload = {}) { lastOutcome = { outcome: 'unavailable', reason }; return { outcome: 'unavailable', reason, payload }; }

    function _emit(name, detail) {
        try { capabilities.emitEvent('midi-input', name, detail || {}); }
        catch (_) { /* eventing must not break input */ }
    }

    function _readStorage() {
        try { return window.localStorage.getItem(STORAGE_KEY) || null; }
        catch (_) { return null; }
    }
    function _writeStorage(key) {
        try { if (key) window.localStorage.setItem(STORAGE_KEY, key); else window.localStorage.removeItem(STORAGE_KEY); return true; }
        catch (_) { return false; }
    }

    function _str(v, fallback) { const s = (v == null ? '' : String(v)).trim(); return s || fallback; }

    // A stable, redaction-safe key for persistence: provider + a stable source
    // id, NOT the human device label.
    function _logicalKey(providerId, sourceId) { return `${providerId}::${sourceId}`; }

    // ── snapshots ───────────────────────────────────────────────────────────
    // listShape keeps labels (this feeds the picker UI); diagShape strips them
    // (device labels are PII-adjacent).
    function _sourceListShape() {
        return Array.from(sources.values()).map((s) => ({
            logicalSourceKey: s.logicalSourceKey,
            sourceId: s.sourceId,
            providerId: s.providerId,
            kind: s.kind,
            label: s.label,
            availability: s.availability,
            selected: s.logicalSourceKey === selectedKey,
            open: sessions.has(s.logicalSourceKey),
        }));
    }

    function _snapshot(extra = {}) {
        return {
            available: providers.size > 0,
            providers: Array.from(providers.values()).map((p) => ({ id: p.id, label: p.label })),
            sources: _sourceListShape(),
            selected: selectedKey,
            openSessions: Array.from(sessions.keys()),
            lastOutcome: lastOutcome ? { ...lastOutcome } : null,
            ...extra,
        };
    }

    function _contributeDiagnostics() {
        const diagnostics = window.feedBack && window.feedBack.diagnostics;
        if (!diagnostics || typeof diagnostics.contribute !== 'function') return;
        try {
            const snap = _snapshot();
            // Redact device labels everywhere — keep ids/kind/availability for
            // operational observability only. No raw MIDI messages ever.
            const redacted = {
                ...snap,
                providers: snap.providers.map(({ label: _l, ...safe }) => safe),
                sources: snap.sources.map(({ label: _l, ...safe }) => safe),
            };
            diagnostics.contribute('midi-input-capability', {
                schema: 'feedBack.midi_input.diagnostics.v1',
                ...redacted,
            });
        } catch (_) { /* diagnostics must not break input */ }
    }

    // ── provider registry (live handlers via the public global) ─────────────
    function _registerProvider(input = {}) {
        const providerId = _str(input.providerId || input.id, '');
        if (!providerId) return null;
        const handlers = {
            enumerate: typeof input.enumerate === 'function' ? input.enumerate : null,
            open: typeof input.open === 'function' ? input.open : null,
            close: typeof input.close === 'function' ? input.close : null,
        };
        const participantId = _str(input.participantId, providerId);
        const wasAvailable = providers.size > 0;
        providers.set(providerId, { id: providerId, label: _str(input.label, providerId), participantId, handlers });
        // Mirror a serializable declaration into the capability graph so the
        // Inspector/diagnostics can reason about the provider relationship.
        try {
            capabilities.registerParticipant(participantId, {
                'midi-input': {
                    roles: ['provider'],
                    operations: ['source.enumerate', 'source.describe', 'source.open', 'source.close'],
                    mode: 'active',
                    safety: 'sensitive',
                    runtime: true,
                    description: `MIDI input provider ${_str(input.label, providerId)}.`,
                    provider_policy: { providerId },
                },
            });
        } catch (_) { /* declaration is best-effort */ }
        _emit('provider-registered', { providerId });
        if (!wasAvailable) _emit('availability-changed', { available: true });
        _contributeDiagnostics();
        return { providerId };
    }

    function _unregisterProvider(providerId) {
        providerId = _str(providerId, '');
        const provider = providers.get(providerId);
        if (!provider) return false;
        // Drop the provider's sources + any open sessions.
        for (const [key, s] of Array.from(sources.entries())) {
            if (s.providerId === providerId) {
                _closeSessionInternal(key, 'provider-unregistered');
                sources.delete(key);
            }
        }
        providers.delete(providerId);
        if (typeof capabilities.unregisterParticipant === 'function') {
            try { capabilities.unregisterParticipant(provider.participantId, 'midi-input'); } catch (_) { /* best-effort */ }
        }
        _emit('provider-unregistered', { providerId });
        if (providers.size === 0) _emit('availability-changed', { available: false });
        _contributeDiagnostics();
        return true;
    }

    // ── discovery (the Web-MIDI permission boundary) ────────────────────────
    async function _discover() {
        if (providers.size === 0) return _unavailable('No MIDI provider registered', _snapshot());
        let found = 0;
        let enumerated = 0;
        let lastError = null;
        for (const provider of providers.values()) {
            if (!provider.handlers.enumerate) continue;
            let list;
            try { list = await provider.handlers.enumerate(); }
            catch (e) {
                // One provider failing (e.g. browser Web-MIDI permission denied,
                // or unsupported) must NOT hide other providers' devices (e.g. a
                // native/desktop MIDI provider). Record it and keep going; denial
                // is only reported below when NO provider enumerated successfully.
                lastError = e;
                // Drop this provider's now-unverifiable sources so revoked /
                // unplugged devices don't linger as selectable and fail on a
                // later open (it just failed to enumerate, so we can't trust its
                // previous list).
                for (const [key, s] of Array.from(sources.entries())) {
                    if (s.providerId === provider.id) {
                        _closeSessionInternal(key, 'enumerate-failed');
                        sources.delete(key);
                    }
                }
                continue;
            }
            enumerated += 1;
            const fresh = new Set();
            for (const raw of (Array.isArray(list) ? list : [])) {
                const sourceId = _str(raw.sourceId || raw.id, '');
                if (!sourceId) continue;
                const key = _logicalKey(provider.id, sourceId);
                fresh.add(key);
                sources.set(key, {
                    sourceId,
                    providerId: provider.id,
                    logicalSourceKey: key,
                    kind: 'midi',
                    label: _str(raw.label || raw.name, 'MIDI input'),
                    availability: _str(raw.availability, 'available'),
                });
                found += 1;
            }
            // Reconcile: drop this provider's sources that vanished since the
            // last enumeration (e.g. a device unplugged, firing statechange).
            // Without this, list-sources keeps showing disconnected devices and
            // selecting/opening them later fails on stale state.
            for (const [key, s] of Array.from(sources.entries())) {
                if (s.providerId === provider.id && !fresh.has(key)) {
                    // Close any live session but KEEP the selectedKey preference
                    // — the device may be replugged and should re-select.
                    _closeSessionInternal(key, 'device-removed');
                    sources.delete(key);
                }
            }
        }
        // Restore a previously-selected source if it reappeared.
        if (selectedKey && !sources.has(selectedKey)) { /* keep the preference; it may return later */ }
        // Only surface a denial when NO provider could enumerate — otherwise a
        // single denied/unsupported provider would mask the working ones.
        if (enumerated === 0 && lastError) {
            return _denied(_str(lastError && lastError.message, 'MIDI access denied'), _snapshot());
        }
        _emit('sources-changed', { count: found });
        _contributeDiagnostics();
        return _handled(_snapshot({ discovered: found }));
    }

    function _selectSource(ctx = {}) {
        const payload = ctx.payload || {};
        const key = _str(payload.logicalSourceKey, '');
        if (!key) return _degraded('select-source requires a logicalSourceKey', _snapshot());
        if (!sources.has(key)) return _degraded(`Unknown MIDI source: ${key}`, _snapshot());
        selectedKey = key;
        _writeStorage(key);
        _emit('source-selected', { logicalSourceKey: key });
        _contributeDiagnostics();
        return _handled(_snapshot({ selected: key }));
    }

    async function _openSource(ctx = {}) {
        const payload = ctx.payload || {};
        const requester = _str(ctx.source || ctx.requester || payload.requester, 'unknown');
        const key = _str(payload.logicalSourceKey, selectedKey || '');
        if (!key) return _degraded('No MIDI source selected', _snapshot());
        const source = sources.get(key);
        if (!source) return _degraded(`Unknown MIDI source: ${key}`, _snapshot());
        const provider = providers.get(source.providerId);
        if (!provider || !provider.handlers.open) return _unavailable('Provider cannot open MIDI input', _snapshot());

        // Share one open session per source across requesters.
        let session = sessions.get(key);
        if (session) {
            session.refs.add(requester);
            return _handled(_snapshot({ sessionId: session.sessionId, shared: true }));
        }
        // Coalesce concurrent opens for the same source: if a provider.open() is
        // already in flight for this key, await it and adopt the resulting session
        // rather than opening the device a second time.
        if (opening.has(key)) {
            try { await opening.get(key); } catch (_) { /* fall through to retry below */ }
            session = sessions.get(key);
            if (session) {
                session.refs.add(requester);
                return _handled(_snapshot({ sessionId: session.sessionId, shared: true }));
            }
        }
        let handle;
        const openPromise = provider.handlers.open(source.sourceId, { requester });
        opening.set(key, openPromise);
        try { handle = await openPromise; }
        catch (e) { return _denied(_str(e && e.message, 'Could not open MIDI input'), _snapshot()); }
        finally { if (opening.get(key) === openPromise) opening.delete(key); }
        // A concurrent open may have won the race while we awaited; adopt its
        // session and release our redundant handle so we don't orphan a device.
        const existing = sessions.get(key);
        if (existing) {
            if (provider.handlers.close) {
                try { provider.handlers.close(source.sourceId, handle); } catch (_) { /* best-effort */ }
            }
            existing.refs.add(requester);
            return _handled(_snapshot({ sessionId: existing.sessionId, shared: true }));
        }
        session = { sessionId: `mis-${key}`, refs: new Set([requester]), handle };
        sessions.set(key, session);
        _emit('source-opened', { logicalSourceKey: key, requester });
        _contributeDiagnostics();
        return _handled(_snapshot({ sessionId: session.sessionId }));
    }

    function _closeSessionInternal(key, reason) {
        const session = sessions.get(key);
        if (!session) return;
        const source = sources.get(key);
        const provider = source && providers.get(source.providerId);
        if (provider && provider.handlers.close) {
            try { provider.handlers.close(source.sourceId, session.handle); } catch (_) { /* best-effort */ }
        }
        sessions.delete(key);
        _emit('source-closed', { logicalSourceKey: key, reason: reason || 'closed' });
    }

    function _closeSource(ctx = {}) {
        const payload = ctx.payload || {};
        const requester = _str(ctx.source || ctx.requester || payload.requester, 'unknown');
        const key = _str(payload.logicalSourceKey, selectedKey || '');
        const session = sessions.get(key);
        if (!session) return _handled(_snapshot({ closed: key, alreadyClosed: true }));
        session.refs.delete(requester);
        if (session.refs.size === 0) {
            _closeSessionInternal(key, 'released');
            _contributeDiagnostics();
        }
        return _handled(_snapshot({ closed: key }));
    }

    capabilities.registerOwner('midi-input', {
        pluginId: 'core.midi-input',
        kind: 'provider-coordinator',
        safety: 'sensitive',
        commands: [
            'inspect', 'list-sources', 'discover',
            'select-source', 'open-source', 'close-source',
        ],
        operations: ['source.enumerate', 'source.describe', 'source.open', 'source.close'],
        events: [
            'provider-registered', 'provider-unregistered', 'availability-changed',
            'sources-changed', 'source-selected', 'source-opened', 'source-closed',
        ],
        description: 'Core-owned MIDI device control plane: discovery, selection, and shared open/close sessions. `discover` is the Web-MIDI permission boundary.',
        handlers: {
            inspect: () => _handled(_snapshot()),
            'list-sources': () => _handled(_snapshot()),       // prompt-free; never requests access
            discover: (ctx) => _discover(ctx),                 // permission boundary
            'select-source': (ctx) => _selectSource(ctx),      // prompt-free
            'open-source': (ctx) => _openSource(ctx),
            'close-source': (ctx) => _closeSource(ctx),
        },
    });

    // ── public global (live surface for in-page consumers) ──────────────────
    // Providers register live handlers here; consumers (input_setup, piano,
    // drums) get a live session handle for the "play a note" check.
    window.feedBack.midiInput = {
        version: 1,
        snapshot: _snapshot,
        listSources: () => _sourceListShape(),
        getSelected: () => selectedKey,
        registerProvider: _registerProvider,
        unregisterProvider: _unregisterProvider,
        discover: () => _discover(),
        select: (logicalSourceKey) => _selectSource({ payload: { logicalSourceKey } }),
        // Returns { outcome, sessionId, handle } where handle is the provider's
        // live MIDI input wrapper (exposes addListener/removeListener). The live
        // handle is surfaced ONLY through this in-page global, never through the
        // serializable `open-source` command payload. Use for calibration
        // note/pad checks.
        open: async (opts = {}) => {
            const result = await _openSource({ source: opts.requester || 'in-page', payload: opts });
            const key = _str(opts.logicalSourceKey, selectedKey || '');
            const session = sessions.get(key);
            return { ...result, handle: session ? session.handle : null, sessionId: session ? session.sessionId : null };
        },
        close: (opts = {}) => _closeSource({ source: opts.requester || 'in-page', payload: opts }),
    };

    // ── built-in Web-MIDI provider ──────────────────────────────────────────
    // Ship a default Web-MIDI source provider so every consumer (piano, drums,
    // input_setup, …) gets MIDI devices from the domain without any one plugin
    // having to register the provider. Guarded by Web-MIDI support;
    // requestMIDIAccess() is the permission boundary, called lazily on discover.
    (function _registerBuiltinWebMidiProvider() {
        if (typeof navigator === 'undefined' || typeof navigator.requestMIDIAccess !== 'function') return;
        const BLOCK = /(midi through|thru|iac)/i;   // loopback / passthrough ports
        let access = null;
        _registerProvider({
            providerId: 'web-midi',
            label: 'Web MIDI',
            // Distinct from the domain owner's participant id ('core.midi-input').
            // unregisterProvider() unregisters the provider's participant, so
            // sharing the owner's id would tear the whole domain's owner down on
            // a provider swap/hot-reload, leaving midi-input with no owner.
            participantId: 'core.midi-input.web-midi',
            enumerate: async () => {
                access = await navigator.requestMIDIAccess({ sysex: false });
                try { access.onstatechange = () => { _discover(); }; } catch (_) { /* best-effort */ }
                const out = [];
                access.inputs.forEach((input) => {
                    if (BLOCK.test(input.name || '')) return;
                    out.push({ sourceId: input.id, label: input.name || 'MIDI input', availability: 'available' });
                });
                return out;
            },
            open: async (sourceId) => {
                if (!access) access = await navigator.requestMIDIAccess({ sysex: false });
                const input = access.inputs.get(sourceId);
                if (!input) throw new Error('MIDI input not found');
                const listeners = new Set();
                input.onmidimessage = (e) => { listeners.forEach((fn) => { try { fn(e.data); } catch (_) { /* listener isolation */ } }); };
                return {
                    addListener: (fn) => { if (typeof fn === 'function') listeners.add(fn); },
                    removeListener: (fn) => listeners.delete(fn),
                    _input: input,
                };
            },
            close: (sourceId, handle) => {
                if (handle && handle._input) { try { handle._input.onmidimessage = null; } catch (_) { /* best-effort */ } }
            },
        });
    })();

    _contributeDiagnostics();
})();
