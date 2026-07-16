// Core "working tuning" capability domain — the live, host-authoritative CURRENT
// instrument tuning (session state), distinct from the soft opt-in default and from
// any one song's tuning. This is the single source of truth the whole app reads:
// the highway, the library/song-picker, Virtuoso, and the minigames all consult it,
// and the tuner is the sole WRITER (it updates this when the player retunes, clears
// the gate, or switches instruments).
//
// PER-INSTRUMENT: a player has separate physical instruments, each in its OWN tuning
// ("I'm not tuning two instruments when I pick a song"). So state is a MAP keyed by
// instrument — `${instrument}-${stringCount}` (e.g. "guitar-6", "bass-4"), the same key
// the v3 instrument selector uses. `get()` returns the CURRENTLY-SELECTED instrument's
// tuning; switching the selector surfaces that instrument's own remembered tuning. You
// only ever deal with the one you've picked.
//
// Design: WORKING-TUNING-STATE-DESIGN.md (host-first PR series, PR 1 = this file).
// Pattern mirrors `capabilities/tuning.js` (capability registration) + the host theme
// read-API (`window.feedBack.theme`): a synchronous `get()` plus a `working-tuning-
// changed` event that also fires once on hydration.
//
// State is IN-MEMORY and NOT persisted — reset-to-home on restart is deliberate (a
// stale "you're in drop-A" assumption is worse than re-asking). The opt-in "default
// tuning on app open" lands later; for now we seed the selected instrument from
// /api/settings.
//
// PR 1 is PURE PLUMBING: it introduces the state + read/write surface + event, but
// nothing writes to it yet and no behavior changes. The tuner becomes the writer (and
// the gate's E->C# asymmetry is fixed) in a later PR.
(function () {
    'use strict';

    window.feedBack = window.feedBack || {};
    // Idempotent: a second injection of this module must not replace the live state
    // with a fresh (empty) one — once we're registered, re-running is a no-op.
    if (window.feedBack.workingTuning && window.feedBack.workingTuning.version === 1) return;
    const capabilities = window.feedBack.capabilities;

    const _byInstrument = {};   // key -> tuning state (the per-instrument map)
    let _currentKey = null;     // the selected instrument's key; cached so get() is sync
    let _hydrated = false;
    let _touched = false;       // set once anything explicitly writes/selects; gates the async seed

    function _normInstrument(instrument) {
        if (!instrument || typeof instrument !== 'string') return 'guitar';
        var inst = _getInstDef(instrument);
        if (inst) return inst.id;
        if (instrument === 'bass' || instrument === 'guitar') return instrument;
        return 'guitar';
    }

    function _getInstDef(instId) {
        var insts = window.feedBack && window.feedBack._instruments;
        if (Array.isArray(insts)) {
            for (var i = 0; i < insts.length; i++) {
                if (insts[i].id === instId) return insts[i];
            }
        }
        return null;
    }

    function _defaultStringCount(instrument) {
        var inst = _getInstDef(instrument);
        if (inst && inst.kind === 'stringed') return inst.default_string_count;
        if (instrument === 'bass') return 4;
        return 6;
    }
    function _keyOf(instrument, stringCount) {
        const inst = _normInstrument(instrument);
        const sc = Number(stringCount) || _defaultStringCount(inst);
        return inst + '-' + sc;
    }
    // Like _keyOf, but when the caller omits a string count we resolve it against the
    // current selection (if it's the same instrument) before falling back to the
    // per-instrument default — so `set({instrument:'bass'})` targets the selected
    // bass-5, not a hard-coded bass-4.
    function _keyOfResolved(instrument, stringCount) {
        const inst = _normInstrument(instrument);
        let sc = Number(stringCount);
        if (!sc) {
            if (_currentKey) {
                const cur = _splitKey(_currentKey);
                if (cur.instrument === inst) sc = cur.stringCount;
            }
            if (!sc) sc = _defaultStringCount(inst);
        }
        return inst + '-' + sc;
    }
    function _splitKey(key) {
        const parts = (typeof key === 'string' ? key : '').split('-');
        const inst = _normInstrument(parts[0]);
        return { instrument: inst, stringCount: Number(parts[1]) || _defaultStringCount(inst) };
    }

    // The shape every consumer reads. `offsets` are per-string semitone offsets from
    // standard (same vocabulary as song_info.tuning and /api/tunings); `instrument`
    // disambiguates the open-string base so offsets resolve to real pitches. A drop-A
    // 8-string is just an offsets array — fully custom tunings are first-class.
    // `provenance` is the honesty flag: 'verified' means the tuner did a choreographed
    // per-string mic check this session; everything else is 'assumed'.
    function _defaultState(key) {
        const id = _splitKey(key);
        return {
            offsets: null,
            stringCount: id.stringCount,
            instrument: id.instrument,
            referencePitch: 440,
            provenance: 'assumed',
            verifiedStrings: null,
            verifiedAt: null,
            source: 'default',
        };
    }

    // Resolve which instrument key a get/set targets: an explicit arg wins (a string
    // key "guitar-6", a bare "guitar"/"bass", or { instrument, stringCount }); else the
    // cached current selection.
    function _resolveKey(instrument) {
        if (instrument && typeof instrument === 'object') return _keyOfResolved(instrument.instrument, instrument.stringCount);
        if (typeof instrument === 'string' && instrument) {
            return instrument.indexOf('-') > 0 ? instrument : _keyOfResolved(instrument, null);
        }
        return _currentKey || _keyOf('guitar', 6);
    }

    // Synchronous read of an instrument's current tuning (default = selected
    // instrument). Returns a deep-enough copy — the object plus its mutable array
    // fields (`offsets`, `verifiedStrings`) — so a reader can't mutate the live state.
    function get(instrument) {
        const key = _resolveKey(instrument);
        const state = Object.assign(_defaultState(key), _byInstrument[key] || {});
        if (Array.isArray(state.offsets)) state.offsets = state.offsets.slice();
        if (Array.isArray(state.verifiedStrings)) state.verifiedStrings = state.verifiedStrings.slice();
        return state;
    }

    function _emitChanged(key) {
        if (window.feedBack && typeof window.feedBack.emit === 'function') {
            window.feedBack.emit('working-tuning-changed', { key: key, instrument: _splitKey(key).instrument, tuning: get(key) });
        }
    }

    // The single mutator. The tuner calls this on retune / gate-clear / swap. Writes to
    // the instrument the state targets (opts.instrument, or next.instrument+stringCount,
    // or the current selection) and makes that the active instrument. `opts.provenance`
    // stamps 'verified' (mic-confirmed) vs the default 'assumed'. Changing the tuning
    // invalidates a prior verification unless fresh verifiedStrings are supplied — fail
    // toward "assumed".
    function set(next, opts) {
        opts = opts || {};
        next = next || {};
        // Resolve the target key. An explicit opts.instrument wins; otherwise a
        // next.instrument/next.stringCount targets that slot — but a bare stringCount
        // (no instrument) applies to the CURRENTLY-SELECTED instrument, not a hard-coded
        // guitar, so `set({stringCount:5})` on a selected bass writes bass-5.
        let key;
        if (opts.instrument) {
            key = _resolveKey(opts.instrument);
        } else if (next.instrument || next.stringCount) {
            const inst = next.instrument ? _normInstrument(next.instrument)
                : (_currentKey ? _splitKey(_currentKey).instrument : 'guitar');
            key = _keyOfResolved(inst, next.stringCount);
        } else {
            key = _currentKey || _resolveKey();
        }
        const id = _splitKey(key);
        const merged = Object.assign(get(key), next);   // get() gives copies, so `merged` is ours to mutate
        merged.instrument = id.instrument;              // keep coherent with the key
        merged.stringCount = id.stringCount;            // the key is authoritative for string count
        const tuningChanged = ('offsets' in next) || ('stringCount' in next) || ('referencePitch' in next);

        // Provenance: explicit opts wins; a bare tuning change downgrades to 'assumed'.
        if (opts.provenance) {
            merged.provenance = opts.provenance;
        } else if (tuningChanged) {
            merged.provenance = 'assumed';
        }

        // Verification metadata is coherent by construction: a tuning change invalidates
        // prior per-string verification unless the caller supplies a fresh bundle, and the
        // metadata exists ONLY while provenance === 'verified'. So verified <=> we hold
        // verifiedStrings — a "verified with no strings" state is impossible.
        if (!('verifiedStrings' in next) && tuningChanged) {
            merged.verifiedStrings = null;
        }
        if (merged.provenance === 'verified' && !Array.isArray(merged.verifiedStrings)) {
            merged.provenance = 'assumed';              // claimed verified but no evidence — fail toward assumed
        }
        if (merged.provenance === 'verified') {
            // verified always carries a real timestamp — a caller-supplied null/NaN/absent
            // verifiedAt is stamped now, so 'verified' can never mean "at no known time".
            if (typeof merged.verifiedAt !== 'number' || !isFinite(merged.verifiedAt)) {
                merged.verifiedAt = Date.now();
            }
        } else {
            merged.verifiedStrings = null;
            merged.verifiedAt = null;
        }

        // Store copies of the mutable arrays so a caller can't mutate live state post-set.
        if (Array.isArray(merged.offsets)) merged.offsets = merged.offsets.slice();
        if (Array.isArray(merged.verifiedStrings)) merged.verifiedStrings = merged.verifiedStrings.slice();
        _byInstrument[key] = merged;
        _currentKey = key;        // writing a tuning makes that instrument the active one
        _touched = true;          // an explicit write must not be clobbered by the async seed
        _emitChanged(key);
        return get(key);
    }

    // Tell the host which instrument is now selected (the v3 selector calls this when
    // the player switches guitar<->bass / string count) so get() returns the right
    // instrument's tuning. Emits if the selection actually changed.
    function setCurrentInstrument(instrument, stringCount) {
        const key = (typeof instrument === 'string' && instrument.indexOf('-') > 0) ? instrument : _keyOfResolved(instrument, stringCount);
        _touched = true;          // an explicit selection must not be reverted by the async seed
        if (key === _currentKey) return get(key);
        _currentKey = key;
        _emitChanged(key);
        return get(key);
    }

    // Reset an instrument's live tuning back to its baseline (the home/default).
    function resetToDefault(instrument) {
        const key = _resolveKey(instrument);
        _byInstrument[key] = _defaultState(key);
        _touched = true;
        _emitChanged(key);
        return get(key);
    }

    // Per-string semitone offsets of a named tuning relative to Standard, derived from
    // the /api/tunings frequency tables. The reference pitch cancels in the ratio, so
    // this is pitch-independent. Returns null if either row is missing/mismatched.
    function _offsetsFromFreqs(named, standard) {
        if (!Array.isArray(named) || !Array.isArray(standard) || named.length !== standard.length) return null;
        const out = [];
        for (let i = 0; i < named.length; i++) {
            const a = Number(named[i]);
            const b = Number(standard[i]);
            if (!(a > 0) || !(b > 0)) return null;
            out.push(Math.round(12 * Math.log2(a / b)));
        }
        return out;
    }

    // ---- Opt-in "launch tuning" default (soft, per-instrument) -------------------
    // A convenience the player opts into: "start me in THIS tuning on app open." Off
    // by default (nothing stored) → boot seeds from /api/settings as before. It is
    // only a SEED — the live working tuning still resets on restart.
    const LAUNCH_KEY = 'v3-working-tuning-launch-default';
    function _readLaunchMap() {
        try { return JSON.parse(localStorage.getItem(LAUNCH_KEY) || '{}') || {}; }
        catch (_) { return {}; }
    }
    function _writeLaunchMap(map) {
        try {
            if (map && Object.keys(map).length) localStorage.setItem(LAUNCH_KEY, JSON.stringify(map));
            else localStorage.removeItem(LAUNCH_KEY);
        } catch (_) { /* private mode */ }
    }
    function getLaunchDefault(instrument) {
        const key = _resolveKey(instrument);
        const d = _readLaunchMap()[key];
        return d ? Object.assign(_defaultState(key), d, { source: 'launch-default' }) : null;
    }
    // Remember an instrument's CURRENT working tuning (or a supplied state) as its
    // launch default. Opt-in — nothing calls this unless the player asks.
    function setLaunchDefault(instrument, state) {
        const key = _resolveKey(instrument);
        const src = state || get(key);
        const map = _readLaunchMap();
        map[key] = {
            offsets: Array.isArray(src.offsets) ? src.offsets.slice() : null,
            stringCount: src.stringCount,
            instrument: _splitKey(key).instrument,
            referencePitch: src.referencePitch || 440,
        };
        _writeLaunchMap(map);
        return getLaunchDefault(key);
    }
    function clearLaunchDefault(instrument) {
        const key = _resolveKey(instrument);
        const map = _readLaunchMap();
        if (key in map) { delete map[key]; _writeLaunchMap(map); }
    }

    // Seed the SELECTED instrument's slot on boot (best-effort 'assumed' starting
    // point, NOT a persisted working tuning): the player's opt-in launch default if one
    // is set for this instrument, else /api/settings — where a NAMED tuning ("Drop D") is
    // resolved to offsets via /api/tunings so it isn't lost. If neither can be read we
    // still hydrate so consumers aren't stuck waiting; an explicit set()/select before we
    // resolve wins (no clobber).
    function _seedFromSettings() {
        fetch('/api/settings')
            .then(function (r) { return r && r.ok ? r.json() : null; })
            .then(function (s) {
                if (!s || _touched) return;   // nothing to seed, or a consumer already wrote — don't clobber
                const inst = _normInstrument(s.instrument);
                const sc = Number(s.string_count) || _defaultStringCount(inst);
                const key = _keyOf(inst, sc);

                function commit(offsets) {
                    if (_touched) return;     // re-check: a write may have raced the /api/tunings fetch
                    _currentKey = key;
                    // Opt-in launch default wins over the raw profile; otherwise use the
                    // resolved `offsets` (a named settings tuning was already turned into
                    // offsets via /api/tunings before commit()).
                    const launch = _readLaunchMap()[key];
                    _byInstrument[key] = launch
                        ? {
                            offsets: Array.isArray(launch.offsets) ? launch.offsets.slice(0, sc) : null,
                            stringCount: sc, instrument: inst,
                            referencePitch: Number(launch.referencePitch) || 440,
                            provenance: 'assumed', verifiedStrings: null, verifiedAt: null,
                            source: 'launch-default',
                        }
                        : {
                            offsets: Array.isArray(offsets) ? offsets.slice(0, sc) : null,
                            stringCount: sc, instrument: inst,
                            referencePitch: Number(s.reference_pitch) || 440,
                            provenance: 'assumed', verifiedStrings: null, verifiedAt: null,
                            source: 'settings',
                        };
                }

                if (Array.isArray(s.tuning)) { commit(s.tuning); return; }
                if (typeof s.tuning === 'string' && s.tuning) {
                    return fetch('/api/tunings')
                        .then(function (r) { return r && r.ok ? r.json() : null; })
                        .then(function (t) {
                            const byName = t && ((t.tunings && t.tunings[key]) || t[key]);
                            commit(byName ? _offsetsFromFreqs(byName[s.tuning], byName.Standard) : null);
                        })
                        .catch(function () { commit(null); });
                }
                commit(null);
            })
            .catch(function () { /* keep defaults */ })
            .then(function () { _hydrate(); });
    }

    function _hydrate() {
        if (_hydrated) return;
        _hydrated = true;
        _emitChanged(_currentKey || _resolveKey());
    }

    // A per-string mic verification is only trustworthy for the context it was done
    // in — a new song means the player may have retuned, so a stale 'verified' must
    // never suppress a needed prompt (fail toward re-checking). Decay the CURRENT
    // instrument's verification back to 'assumed' on each song load; offsets are kept.
    function _decayVerifiedOnSongLoad() {
        const key = _currentKey || _resolveKey();
        const st = _byInstrument[key];
        if (st && st.provenance === 'verified') {
            st.provenance = 'assumed';
            st.verifiedStrings = null;
            st.verifiedAt = null;
            _emitChanged(key);
        }
    }
    if (typeof window.feedBack.on === 'function') {
        window.feedBack.on('song:loading', _decayVerifiedOnSongLoad);
    }

    // ---- Capability registration (mirrors capabilities/tuning.js) ----------------
    if (capabilities && capabilities.version === 1 &&
        !(window.feedBack.workingTuning && window.feedBack.workingTuning.version === 1)) {
        capabilities.registerOwner('working-tuning', {
            description: 'The live, host-authoritative current instrument tuning (session state), per ' +
                'instrument: offsets + string-count + reference pitch + assumed/verified provenance. ' +
                'Written by the tuner, read by the highway/library/Virtuoso/minigames.',
            operations: ['get-working-tuning', 'set-working-tuning'],
            events: ['working-tuning-changed'],
            kind: 'command',
            ownership: 'exclusive-owner',
        });
        capabilities.registerParticipant('plugin.tuner', {
            'working-tuning': {
                roles: ['contributor', 'requester'],
                operations: ['get-working-tuning', 'set-working-tuning'],
                emits: ['working-tuning-changed'],
                mode: 'active',
                compatibility: 'none',
                safety: 'safe',
            },
        });
        capabilities.registerParticipant('core.settings.instruments', {
            'working-tuning': {
                roles: ['requester'],
                operations: ['get-working-tuning'],
                events: ['working-tuning-changed'],
                mode: 'active',
                compatibility: 'none',
                safety: 'safe',
            },
        });
    }

    // ---- Public read/write surface (attached defensively, like feedBack.theme) ----
    window.feedBack.workingTuning = Object.freeze({
        version: 1,
        get: get,
        set: set,
        setCurrentInstrument: setCurrentInstrument,
        resetToDefault: resetToDefault,
        getLaunchDefault: getLaunchDefault,
        setLaunchDefault: setLaunchDefault,
        clearLaunchDefault: clearLaunchDefault,
    });

    _seedFromSettings();
})();
