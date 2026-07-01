// 3D Drum Highway — pure visual mockup.
//
// Exploratory sibling of highway_3d. Renders an 8-lane drum highway (7 lanes
// for hand pieces + a full-width kick bar) populated from a hardcoded demo
// pattern that loops indefinitely. No song-data wiring: bundle.notes /
// bundle.chords / bundle.currentTime are ignored. The viz still plugs into
// slopsmith's setRenderer contract so it appears in the player viz picker
// alongside the guitar highway.
//
// Reuses verbatim from highway_3d: Three.js loader, palette arrays, world
// scale (K), fog, lights — so the two highways feel like the same family
// even though they render different geometry.

(function () {
    'use strict';

    /* ======================================================================
     *  Verbatim from highway_3d — keep these in sync if upstream tweaks them
     * ====================================================================== */

    const THREE_URL = '/static/vendor/three/three.module.min.js';
    const THREE_CDN = 'https://cdn.jsdelivr.net/npm/three@0.170.0/build/three.module.min.js';

    const PALETTES = {
        default: [
            0xff2828, 0xffd400, 0x2080ff, 0xff8020,
            0x30d040, 0xa040ff, 0xff6bd5, 0x6bffe6,
        ],
        neon: [
            0xff0030, 0xffe800, 0x0080ff, 0xff8030,
            0x40ff50, 0xb050ff, 0xff40d0, 0x40ffd0,
        ],
        pastel: [
            0xe89aa0, 0xefdf90, 0x9adfee, 0xefb898,
            0xa6e0a8, 0xc4a6e0, 0xe0a6c8, 0xa6e0d8,
        ],
    };
    const PALETTE_IDS = Object.keys(PALETTES);

    const SCALE = 2.25;
    const K = SCALE / 300;

    const FOG_COLOR = 0x1a1a2e;
    const FOG_START = 200 * K;
    const FOG_END = 670 * K;

    let T = null;
    let threeLoadPromise = null;
    function loadThree() {
        if (!threeLoadPromise) {
            threeLoadPromise = import(THREE_URL)
                .then(mod => { T = mod; return mod; })
                .catch(() => import(THREE_CDN)
                    .then(mod => { T = mod; return mod; })
                    .catch(e => {
                        console.error('[Drum-Hwy] Three.js load failed:', e);
                        threeLoadPromise = null;
                        throw e;
                    }));
        }
        return threeLoadPromise;
    }

    /* ======================================================================
     *  Drum-specific constants
     * ====================================================================== */

    // World scroll speed (units / second). Matches highway_3d so the two
    // viz feel like they belong in the same scene.
    const TS = 130 * K;

    // Lane geometry. 7 hand lanes + 1 full-width kick bar.
    //   lane 0: hi-hat   (cymbal)
    //   lane 1: snare    (drum)
    //   lane 2: high tom (drum)
    //   lane 3: mid tom  (drum)
    //   lane 4: floor tom(drum)
    //   lane 5: crash    (cymbal)
    //   lane 6: ride     (cymbal)
    //   lane 7: kick     (full-width bar)
    const LANE_GAP = 12 * K;                       // X spacing between lane centers
    const KICK_COLOR = 0xffa030;                   // amber regardless of palette

    // Note dimensions (world units). All keyed to K so scale changes
    // propagate.
    const DISC_R_BASE = 3.6 * K;                   // drum disc radius
    const DISC_H = 1.2 * K;                        // drum disc thickness
    const CYMBAL_R = 3.0 * K;                      // cymbal gem radius
    const CYMBAL_H = 1.6 * K;                      // cymbal gem height

    // ─── Piece vocabulary (mirrors lib/drums.py PIECES) ──────────────
    // Used for kit configuration: user picks which of these pieces they
    // own and in what lane order.
    const ALL_PIECES = [
        'kick',
        'snare', 'snare_xstick',
        'hh_closed', 'hh_open', 'hh_pedal',
        'tom_hi', 'tom_mid', 'tom_low', 'tom_floor',
        'crash_l', 'crash_r', 'splash', 'china',
        'ride', 'ride_bell',
    ];
    const PIECE_LABELS = {
        kick:         'KICK',
        snare:        'SNR',
        snare_xstick: 'XSTK',
        hh_closed:    'HHc',
        hh_open:      'HHo',
        hh_pedal:     'HHp',
        tom_hi:       'TM1',
        tom_mid:      'TM2',
        tom_low:      'TM3',
        tom_floor:    'FT',
        crash_l:      'CRl',
        crash_r:      'CRr',
        splash:       'SPL',
        china:        'CHN',
        ride:         'RD',
        ride_bell:    'BLL',
    };
    const PIECE_CATEGORY = {
        kick: 'kick',
        snare: 'drum', snare_xstick: 'drum',
        hh_closed: 'cymbal', hh_open: 'cymbal', hh_pedal: 'cymbal',
        tom_hi: 'drum', tom_mid: 'drum', tom_low: 'drum', tom_floor: 'drum',
        crash_l: 'cymbal', crash_r: 'cymbal', splash: 'cymbal', china: 'cymbal',
        ride: 'cymbal', ride_bell: 'cymbal',
    };
    const PIECE_SUBKIND = {
        kick: 'kick',
        snare: 'snare', snare_xstick: 'snare',
        hh_closed: 'hihat', hh_open: 'hihat', hh_pedal: 'hihat',
        tom_hi: 'tom', tom_mid: 'tom', tom_low: 'tom', tom_floor: 'tom',
        crash_l: 'crash', crash_r: 'crash', splash: 'crash', china: 'crash',
        ride: 'ride', ride_bell: 'ride',
    };
    // Palette index per piece — chosen so the default 7-lane kit reads
    // the same colours as the original hardcoded LANES layout.
    const PIECE_PALETTE_IDX = {
        kick: 6,
        snare: 0, snare_xstick: 0,
        hh_closed: 7, hh_open: 7, hh_pedal: 7,
        tom_hi: 4, tom_mid: 2, tom_low: 5, tom_floor: 5,
        crash_l: 1, crash_r: 1, splash: 1, china: 1,
        ride: 3, ride_bell: 3,
    };

    // Default kit — replicates the prior hardcoded 7-piece + kick layout.
    // Users without a saved kit see exactly what the mockup originally
    // showed.
    const DEFAULT_KIT = {
        version: 1,
        name: 'Default 7-piece',
        // Lanes in order (left-to-right on the highway). The kick is a
        // special full-width bar at the bottom — its position in this
        // list is irrelevant (always rendered as the bar), but it must
        // be present for the bar to show.
        lanes: [
            { piece: 'hh_closed' },
            { piece: 'snare' },
            { piece: 'tom_hi' },
            { piece: 'tom_mid' },
            { piece: 'tom_floor' },
            { piece: 'crash_l' },
            { piece: 'ride' },
            { piece: 'kick' },
        ],
        // Chart piece-id → user's piece-id when the chart has a piece
        // the user didn't map. These explicit fallbacks cover the most
        // common kit layouts; any unmapped piece is dropped at render time.
        fallbacks: {
            snare_xstick: 'snare',
            hh_open: 'hh_closed', hh_pedal: 'hh_closed',
            tom_low: 'tom_mid',
            crash_r: 'crash_l', splash: 'crash_l', china: 'crash_l',
            ride_bell: 'ride',
        },
    };

    const LS_KIT_CONFIG = 'drum_h3d_kit_v1';

    // Module-scope mutable lane layout derived from the active kit. Read
    // by createFactory's scene-builders. _rebuildLanesFromKit recomputes
    // when the kit changes; instances rebuild their scene by calling
    // teardown() + initScene() on the same renderer.
    let LANES = [];               // ordered hand-lane entries + (optionally) kick last
    let LANE_COUNT = 0;            // count of HAND lanes (excludes the kick bar)
    let LANE_X0 = 0;
    let KICK_W = 0;

    function _validateKit(raw) {
        // Light validation — accept anything that has lanes[] with
        // pieces in ALL_PIECES. Reject malformed input rather than
        // letting a bad config crash initScene.
        if (!raw || typeof raw !== 'object') return null;
        const lanes = Array.isArray(raw.lanes) ? raw.lanes : null;
        if (!lanes) return null;
        const cleanLanes = [];
        const seenPieces = new Set();
        for (const ln of lanes) {
            if (!ln || typeof ln.piece !== 'string') continue;
            if (!ALL_PIECES.includes(ln.piece)) continue;
            if (seenPieces.has(ln.piece)) continue;
            seenPieces.add(ln.piece);
            cleanLanes.push({ piece: ln.piece });
        }
        if (cleanLanes.length === 0) return null;
        const fb = (raw.fallbacks && typeof raw.fallbacks === 'object') ? raw.fallbacks : {};
        const cleanFb = {};
        for (const [from, to] of Object.entries(fb)) {
            if (!ALL_PIECES.includes(from) || !ALL_PIECES.includes(to)) continue;
            if (!seenPieces.has(to)) continue;
            cleanFb[from] = to;
        }
        return {
            version: 1,
            name: typeof raw.name === 'string' ? raw.name.slice(0, 80) : 'Custom kit',
            lanes: cleanLanes,
            fallbacks: cleanFb,
        };
    }

    function _readKitConfig() {
        try {
            const raw = localStorage.getItem(LS_KIT_CONFIG);
            if (!raw) return null;
            return _validateKit(JSON.parse(raw));
        } catch (_) { return null; }
    }

    function _writeKitConfig(kit) {
        try { localStorage.setItem(LS_KIT_CONFIG, JSON.stringify(kit)); } catch (_) {}
    }

    // The active kit object — replaceable at runtime via setKit().
    let _activeKit = _readKitConfig() || DEFAULT_KIT;

    function _rebuildLanesFromKit(kit) {
        // Split: hand lanes first (in the user's chosen order), kick
        // last (if present). This matches the original 8-entry LANES
        // shape so all downstream geometry code keeps working.
        const handLanes = [];
        let kickLane = null;
        for (const ln of kit.lanes) {
            const piece = ln.piece;
            const entry = {
                kind:       PIECE_CATEGORY[piece] || 'drum',
                subKind:    PIECE_SUBKIND[piece]  || 'tom',
                label:      PIECE_LABELS[piece]   || piece.toUpperCase(),
                paletteIdx: PIECE_PALETTE_IDX[piece] || 0,
                piece,
            };
            if (entry.kind === 'kick') kickLane = entry;
            else handLanes.push(entry);
        }
        LANES = kickLane ? handLanes.concat([kickLane]) : handLanes.slice();
        LANE_COUNT = handLanes.length;
        LANE_X0 = -((LANE_COUNT - 1) / 2) * LANE_GAP;
        KICK_W = Math.max(1, LANE_COUNT) * LANE_GAP + 2 * K;
    }
    _rebuildLanesFromKit(_activeKit);
    const KICK_H = 1.4 * K;                        // kick bar thickness
    const KICK_D = 4.0 * K;                        // kick bar depth (along scroll)

    // Variant size multipliers.
    const GHOST_SCALE = 0.65;
    const ACCENT_SCALE = 1.25;
    const FLAM_GRACE_OFFSET = 0.08;                // seconds before main note
    const FLAM_GRACE_SCALE = 0.55;

    // How many seconds of upcoming notes are visible at once.
    const AHEAD = 3.2;
    const BEHIND = 0.4;

    // Map drum_tab piece-ids (lib/drums.py PIECES) → lane index in the
    // active user kit's LANES. Rebuilt by _rebuildPieceToLaneMap whenever
    // the kit changes. Pieces the user doesn't have route through
    // _activeKit.fallbacks; pieces with no direct or fallback mapping get
    // `undefined` and the hit is dropped at render time.
    let PIECE_TO_LANE = {};
    function _rebuildPieceToLaneMap(kit) {
        PIECE_TO_LANE = {};
        for (let i = 0; i < LANES.length; i++) {
            const piece = LANES[i].piece;
            if (piece) PIECE_TO_LANE[piece] = i;
        }
        // Apply user-defined fallbacks to cover chart pieces the user
        // doesn't have on their kit (e.g. chart has tom_low + tom_floor,
        // user has only one floor tom → fallback maps low onto floor).
        const fb = (kit && kit.fallbacks) || {};
        for (const piece of ALL_PIECES) {
            if (PIECE_TO_LANE[piece] !== undefined) continue;
            const target = fb[piece];
            if (target && PIECE_TO_LANE[target] !== undefined) {
                PIECE_TO_LANE[piece] = PIECE_TO_LANE[target];
            }
        }
    }
    _rebuildPieceToLaneMap(_activeKit);

    // Resolve a drum_tab hit's visual variant. Order matters: ghost wins over
    // accent (ghost notes are intentionally quiet so their flag dominates),
    // flam adds the leading grace disc, ride_bell adds the bright dot. A
    // loud non-ghost hit (v >= 100) is an accent.
    function _variantForHit(hit) {
        if (hit.g) return 'ghost';
        if (hit.f) return 'flam';
        if (hit.p === 'ride_bell') return 'bell';
        const v = typeof hit.v === 'number' ? hit.v : 100;
        if (v >= 100) return 'accent';
        return 'normal';
    }

    /* ======================================================================
     *  MIDI input + hit detection (module-scope singletons)
     * ====================================================================== */

    // Reverse of lib/drums.py PIECES default midis. The 2D drums plugin keeps
    // a user-editable mapping in localStorage; the 3D viz starts with this
    // baseline and the settings UI can override later. Multiple MIDI notes
    // can map to the same piece-id (e.g. 35 & 36 both → kick).
    const MIDI_TO_PIECE = {
        35: 'kick',         36: 'kick',
        37: 'snare_xstick',
        38: 'snare',        40: 'snare',
        41: 'tom_floor',
        42: 'hh_closed',
        43: 'tom_low',      58: 'tom_low',
        44: 'hh_pedal',
        45: 'tom_mid',      47: 'tom_mid',
        46: 'hh_open',
        48: 'tom_hi',       50: 'tom_hi',
        49: 'crash_l',
        51: 'ride',         59: 'ride',
        52: 'china',
        53: 'ride_bell',
        55: 'splash',
        57: 'crash_r',
    };

    // ±50 ms hit window — same as the 2D drums plugin so users get
    // identical timing across both visualisations.
    const HIT_TOLERANCE_S = 0.05;
    // Legacy id-only storage key. Read for migration; new writes go to
    // LS_MIDI_PICK (id + name).
    const LS_MIDI_INPUT = 'drum_h3d_midi_input';
    const LS_MIDI_PICK = 'drum_h3d_midi_pick_v2';

    // Inputs whose name matches this regex are skipped from the auto-pick
    // fallback. They're either passthrough loopbacks (Midi Through) or
    // audio interfaces that happen to expose a MIDI port but don't have
    // a controller behind them.
    const _MIDI_BLOCKLIST_RE = /midi through|^thru\b|^iac\b/i;

    // MIDI is sourced from the core `midi-input` capability domain
    // (window.slopsmith.midiInput) rather than a private requestMIDIAccess() —
    // one device-access boundary shared with piano/drums/keys/onboarding.
    const _MIDI_REQUESTER = 'drum_highway_3d';
    let _midiReady = false;      // discover() has run
    let _midiHandle = null;      // live domain session handle (addListener/removeListener)
    let _midiListener = null;    // addListener callback wrapping _midiOnMessage
    let _midiStateSub = false;   // subscribed to midi-input:sources-changed
    let _midiInput = null;       // selected source descriptor { id, name }
    // Set to true by _midiConnect when a new device is selected. The render
    // loop reads and clears this to skip retroactive miss-counting for notes
    // that elapsed while no device was connected.
    let _midiJustConnected = false;
    // Gates the live listener wiring. init() flips true via _midiResume() and
    // the last destroy() flips false via _midiReleaseSession(). Necessary because _midiConnect is
    // async — an open() can resolve after the renderer was destroyed, and
    // without this gate addListener would wire hits into a dead instance.
    let _midiActive = false;
    // Routes incoming MIDI events to the focused renderer (null when no
    // instance is active). Splitscreen support is deferred; for now this
    // tracks the singleton instance.
    let _activeInstance = null;
    const _instances = new Set();

    function _readStore(k) {
        try { return localStorage.getItem(k); } catch (_) { return null; }
    }
    function _writeStore(k, v) {
        try { localStorage.setItem(k, v); } catch (_) {}
    }

    // The core midi-input domain, if present (it ships with core).
    function _mi() {
        const m = window.slopsmith && window.slopsmith.midiInput;
        return (m && m.version === 1) ? m : null;
    }
    // Domain sources shaped like the old MIDIInput list: { id, name }.
    // sourceId == the old MIDIInput.id, so saved picks stay compatible.
    function _midiSources() {
        const mi = _mi();
        if (!mi) return [];
        return mi.listSources().map(s => ({ id: s.sourceId, name: s.label, key: s.logicalSourceKey }));
    }
    // Detach the live listener + release the domain session.
    function _midiDetach() {
        // Invalidate any in-flight _midiConnect open: a detach driven by device
        // removal (sources-changed) or an opt-out must supersede a pending open
        // so it can't resume and install a handle for a now-gone source.
        _midiConnectSeq += 1;
        if (_midiHandle && _midiListener) { try { _midiHandle.removeListener(_midiListener); } catch (_) { /* best-effort */ } }
        const mi = _mi();
        if (mi && _midiInput) { try { mi.close({ requester: _MIDI_REQUESTER, logicalSourceKey: _midiInput.key || ('web-midi::' + _midiInput.id) }); } catch (_) { /* best-effort */ } }
        _midiHandle = null;
        _midiListener = null;
        _midiInput = null;
    }

    let _midiInitInFlight = null;
    let _midiConnectSeq = 0;     // generation guard for async _midiConnect races
    async function _midiInit() {
        if (_midiReady) {
            // Only (re)connect when there's no live session. A repeated init
            // (settings panel open, extra splitscreen instance) must NOT re-enter
            // _midiConnect on an active handle — that tears down the live session
            // and releases held pads for no reason. After a full release the
            // handle is null, so reconnect happens then.
            if (!_midiHandle) _midiAutoConnect();
            return;
        }
        if (_midiInitInFlight) return _midiInitInFlight;
        const mi = _mi();
        if (!mi) return;
        _midiInitInFlight = (async () => {
            try {
                const r = await mi.discover();   // permission boundary (requestMIDIAccess, in core)
                // Only latch ready on a successful discovery — a denied/unavailable
                // outcome must NOT latch, or reopening never retries the prompt.
                if (!r || r.outcome !== 'handled') return;
                _midiReady = true;
                // Replug/unplug refresh (replaces MIDIAccess.onstatechange).
                if (!_midiStateSub && window.slopsmith && typeof window.slopsmith.on === 'function') {
                    _midiStateSub = true;
                    window.slopsmith.on('midi-input:sources-changed', () => {
                        _midiNotifyDeviceListChanged();
                        // Reconnect the saved device when it (re)appears after an
                        // unplug; recovery only (no fallback) so a transient unplug
                        // doesn't switch to / persist another input.
                        if (!_midiInput) _midiAutoConnect(false);
                    });
                }
                _midiAutoConnect();
                _midiNotifyDeviceListChanged();
            } catch (e) {
                console.warn('[Drum-Hwy3D] MIDI access denied:', e);
            } finally {
                _midiInitInFlight = null;
            }
        })();
        return _midiInitInFlight;
    }

    function _readSavedPick() {
        // New v2 storage: {id, name} JSON. Falls back to legacy v1 id-only.
        // Coerce id/name to strings so _midiAutoConnect can safely call
        // .toLowerCase() even if the stored JSON was manually edited.
        try {
            const v2 = _readStore(LS_MIDI_PICK);
            if (v2) {
                const obj = JSON.parse(v2);
                if (obj && typeof obj === 'object') {
                    return { id: String(obj.id || ''), name: String(obj.name || ''), key: String(obj.key || '') };
                }
            }
        } catch (_) {}
        const v1 = _readStore(LS_MIDI_INPUT);
        if (typeof v1 === 'string') return { id: v1, name: '' };
        return null;
    }

    function _writeSavedPick(id, name, key) {
        try {
            localStorage.setItem(LS_MIDI_PICK, JSON.stringify({ id: id || '', name: name || '', key: key || '' }));
            // Keep the legacy key in sync so a downgrade is non-destructive.
            localStorage.setItem(LS_MIDI_INPUT, id || '');
        } catch (_) {}
    }

    function _midiAutoConnect(allowFallback) {
        // Recovery (sources-changed after unplug) passes false: never switch to a
        // fallback input, because _midiConnect persists the pick and that would
        // overwrite the user's saved device on a transient multi-device unplug
        // (the original returns on replug and reconnects then).
        if (allowFallback === undefined) allowFallback = true;
        const inputs = _midiSources();
        if (!inputs.length) return;
        const saved = _readSavedPick();
        // Explicit None — user opted out, don't auto-connect.
        if (saved && saved.id === '' && saved.name === '') return;
        // Prefer exact id match (browser kept the id stable). Fall back
        // to case-insensitive name match — Chrome+Linux regenerates the
        // hashed id on every page load, so id-only matching strands the
        // saved pick after the first reload.
        let target = null;
        // Prefer the globally-unique logicalSourceKey, then the legacy sourceId.
        if (saved && saved.key) {
            target = inputs.find(i => i.key === saved.key) || null;
        }
        if (!target && saved && saved.id) {
            target = inputs.find(i => i.id === saved.id) || null;
        }
        if (!target && saved && saved.name) {
            const n = saved.name.toLowerCase();
            target = inputs.find(i => (i.name || '').toLowerCase() === n) || null;
        }
        if (!target) {
            // Skip the substitute ONLY when a saved pick exists but is currently
            // absent (recovery: preserve it, don't clobber on a transient unplug).
            // With no saved pick at all, a fallback is the intended first-hotplug
            // auto-connect — allow it even in recovery.
            const hasSavedPick = !!(saved && (saved.key || saved.id || saved.name));
            if (!allowFallback && hasSavedPick) return;
            // Pick the first input that isn't a loopback/passthrough. Falls back to
            // inputs[0] only if every input is blocklisted.
            target = inputs.find(i => !_MIDI_BLOCKLIST_RE.test(i.name || '')) || inputs[0];
        }
        _midiConnect(target.id, target.name, target.key);
    }

    async function _midiConnect(id, name, key) {
        // Capture our generation AFTER _midiDetach()'s own bump, so a later
        // detach (device removal / new connect / opt-out) reliably supersedes us.
        _midiDetach();
        const myGen = ++_midiConnectSeq;
        // Pass through `name` so a future id-drift can still find this
        // device. Empty id is the explicit-None opt-out.
        _writeSavedPick(id || '', name || '', key || '');
        const mi = _mi();
        if ((id || key) && mi) {
            // Prefer the globally-unique logicalSourceKey so two providers that
            // expose the same provider-local sourceId stay distinguishable; fall
            // back to the legacy sourceId match.
            const src = (key && _midiSources().find(s => s.key === key))
                || (id && _midiSources().find(s => s.id === id))
                || null;
            if (src) {
                const lkey = src.key || ('web-midi::' + src.id);
                _midiInput = { id: src.id, name: src.name, key: lkey };
                _midiJustConnected = true;
                // No live renderer to consume OR release a session — don't hold one
                // open (settings-only ensure-init, or the last instance was torn
                // down during async discovery). The pick is saved; a later renderer
                // mount re-runs auto-connect and opens for real, releasing on destroy.
                if (_instances.size === 0) { _midiNotifyDeviceListChanged(); return; }
                try {
                    await mi.select(lkey);
                    const res = await mi.open({ requester: _MIDI_REQUESTER, logicalSourceKey: lkey });
                    // A newer _midiConnect (device switch / None / replug) ran while
                    // we awaited open — discard this stale session so we don't wire a
                    // listener for a device the user already moved off of.
                    if (myGen !== _midiConnectSeq) {
                        if (!_midiInput || _midiInput.key !== lkey) { try { mi.close({ requester: _MIDI_REQUESTER, logicalSourceKey: lkey }); } catch (_) { /* best-effort */ } }
                        return;
                    }
                    if (res && res.handle) {
                        _midiHandle = res.handle;
                        // The domain handle delivers raw MIDI data; adapt to the
                        // old MIDIMessageEvent shape so _midiOnMessage is unchanged.
                        _midiListener = (data) => _midiOnMessage({ data });
                        if (_midiActive) _midiHandle.addListener(_midiListener);
                    } else {
                        // Open yielded no live handle (device vanished post-discovery,
                        // or denied/unavailable). Clear the selection so the render
                        // loop's connected-device gate doesn't sweep phantom misses.
                        _midiInput = null;
                    }
                } catch (e) {
                    console.warn('[Drum-Hwy3D] MIDI open failed:', e);
                    // Only clear if we're still the current connect — a stale older
                    // open's rejection must not wipe a newer connect's installed
                    // _midiInput/_midiHandle (which would also leak the live handle,
                    // since closes are gated on _midiInput).
                    if (myGen === _midiConnectSeq) _midiInput = null;
                }
            }
        }
        // Notify on BOTH connect and disconnect/opt-out so any open
        // settings panel re-renders its device dropdown consistently.
        _midiNotifyDeviceListChanged();
    }

    function _midiResume() {
        // Idempotent: a second live renderer instance (splitscreen/overlapping
        // lifetimes) calls this while already active. The domain handle's
        // addListener is Set-backed, but don't rely on the provider de-duping —
        // re-adding here could double-deliver one MIDI hit to the focused
        // instance and score a hit plus duplicate misses.
        if (_midiActive) return;
        _midiActive = true;
        if (_midiHandle && _midiListener) { try { _midiHandle.addListener(_midiListener); } catch (_) { /* best-effort */ } }
    }
    // Called when the LAST live instance is torn down: fully release the shared
    // midi-input domain session (via _midiDetach: close + null + generation bump),
    // not just the listener, so the device/provider session isn't held open after
    // the visualization is gone. Re-mount's _midiInit auto-connects from the saved
    // pick, so _midiReady is intentionally left latched.
    function _midiReleaseSession() {
        _midiActive = false;
        _midiDetach();
    }

    function _midiOnMessage(e) {
        if (!_activeInstance) return;
        const data = e.data;
        if (!data || data.length < 3) return;
        const type = data[0] & 0xf0;
        const note = data[1];
        const vel = data[2];
        // 0x90 = note-on. note-on with velocity 0 is a note-off (running
        // status); skip those too.
        if (type !== 0x90 || vel === 0) return;
        _activeInstance._handleDrumHit(note, vel);
    }

    // Fired when the MIDI access state changes (device plugged/unplugged
    // or a connect/disconnect from _midiConnect). Settings panels listen
    // via the global event so they can re-render their device dropdown.
    function _midiNotifyDeviceListChanged() {
        // If the currently-selected input was disconnected, clear the reference
        // so _updateMissed() stops counting and the UI shows "no device".
        if (_midiInput && !_midiSources().some(s => s.id === _midiInput.id)) {
            _midiDetach();
        }
        try {
            window.dispatchEvent(new CustomEvent('drum_h3d:midi_devices'));
        } catch (_) {}
    }

    // List the currently-known input devices for the settings UI.
    function _midiListInputs() {
        return _midiSources().map(s => ({ id: s.id, name: s.name || s.id }));
    }
    function _midiCurrentInputId() {
        return _midiInput ? _midiInput.id : '';
    }

    /* ── Kit configuration API for the settings panel ──────────────── */

    window.drumH3dGetKit = function () {
        // Returns a deep clone so the settings UI can mutate without
        // disturbing the live config.
        return JSON.parse(JSON.stringify(_activeKit));
    };
    window.drumH3dGetAllPieces = function () {
        return ALL_PIECES.slice();
    };
    window.drumH3dGetPieceLabels = function () {
        return Object.assign({}, PIECE_LABELS);
    };
    window.drumH3dGetPieceCategory = function () {
        return Object.assign({}, PIECE_CATEGORY);
    };
    // Exposed so settings.html palette swatches stay in sync with the
    // renderer without duplicating the mapping.  kick maps to -1 here
    // (settings.html convention = render amber, matching the renderer's
    // special-case amber for kick bars).
    window.drumH3dGetPiecePaletteIdx = function () {
        return Object.assign({}, PIECE_PALETTE_IDX, { kick: -1 });
    };
    window.drumH3dSetKit = function (raw) {
        const kit = _validateKit(raw);
        if (!kit) return false;
        _activeKit = kit;
        _writeKitConfig(kit);
        _rebuildLanesFromKit(kit);
        _rebuildPieceToLaneMap(kit);
        // Notify renderers + settings panels — each instance rebuilds its
        // scene; settings panels re-render to reflect the new kit.
        try {
            window.dispatchEvent(new CustomEvent('drum_h3d:kit', { detail: { kit } }));
        } catch (_) {}
        return true;
    };
    window.drumH3dResetKit = function () {
        window.drumH3dSetKit(DEFAULT_KIT);
    };
    // Name-only update — does NOT dispatch 'drum_h3d:kit' (which triggers a
    // full WebGL scene teardown/reinit). Typing in the kit-name field therefore
    // causes zero GPU overhead; the new name is persisted immediately so it
    // survives export/clipboard share on the same keystroke.
    window.drumH3dSetKitName = function (name) {
        const trimmed = String(name || '').slice(0, 80);
        if (!_activeKit) return;
        _activeKit.name = trimmed;
        _writeKitConfig(_activeKit);
    };
    // base64(JSON) round-trip for sharing kits between users.
    // Use TextEncoder/TextDecoder for UTF-8-safe base64 (escape/unescape are
    // deprecated and can mis-handle non-ASCII characters in kit names).
    window.drumH3dExportKit = function () {
        const bytes = new TextEncoder().encode(JSON.stringify(_activeKit));
        return btoa(String.fromCharCode(...bytes));
    };
    window.drumH3dImportKit = function (b64) {
        try {
            const binStr = atob((b64 || '').trim());
            const bytes = Uint8Array.from(binStr, c => c.charCodeAt(0));
            const obj = JSON.parse(new TextDecoder().decode(bytes));
            return window.drumH3dSetKit(obj);
        } catch (_) { return false; }
    };

    /* ── MIDI device control API (consumed by settings.html) ───── */
    window.drumH3dEnsureMidiInit = function () {
        // Settings panel calls this on mount so the user can see + pick
        // MIDI devices without having to load a song first. Fires the
        // browser permission prompt the first time; idempotent after.
        // Returns a promise that resolves when _midiInit settles.
        return _midiInit();
    };
    window.drumH3dListMidiInputs = function () {
        // Returns [{id, name}, ...] of all currently-known inputs, in
        // whatever order the browser enumerates them. Settings panel
        // re-renders on the 'drum_h3d:midi_devices' event.
        return _midiListInputs();
    };
    window.drumH3dGetMidiInputId = function () {
        return _midiCurrentInputId();
    };
    window.drumH3dSetMidiInput = function (id) {
        // Empty string = explicit "None" opt-out. Persists by name +
        // id via _midiConnect so a future page reload still finds the
        // device after Chrome regenerates ids.
        // `id` may be a logicalSourceKey (new host calls) or a legacy sourceId.
        const src = id
            ? (_midiSources().find(s => s.key === id) || _midiSources().find(s => s.id === id))
            : null;
        _midiConnect(src ? src.id : (id || ''), src ? src.name : '', src ? src.key : '');
        return true;
    };
    window.drumH3dGetSynthVolume = function () {
        // When the synth has not initialised yet (viz never ran, settings
        // opened first), read from localStorage so the settings slider shows
        // the persisted value rather than the default 0.70.
        if (!_synthPlayer) {
            const raw = _readStore(LS_SYNTH_VOL);
            const parsed = raw === null ? NaN : parseFloat(raw);
            if (Number.isFinite(parsed) && parsed >= 0 && parsed <= 1) return parsed;
        }
        return _synthVolume;
    };
    window.drumH3dSetSynthVolume = function (v) {
        _synthSetVolume(v);
    };

    /* ======================================================================
     *  WebAudioFont drum-kit synth (module-scope, one AudioContext per tab)
     *
     *  Ported verbatim from slopsmith-plugin-drums so the 3D viz makes the
     *  same kit sounds when the user strikes a pad. Preset URLs and the
     *  JCLive soundfont match the 2D plugin so the kit feels identical.
     *  Volume defaults to 0.7 and persists via `drum_h3d_synth_vol`.
     * ====================================================================== */

    const WAF_PLAYER_URL = 'https://surikov.github.io/webaudiofont/npm/dist/WebAudioFontPlayer.js';
    const WAF_BASE = 'https://surikov.github.io/webaudiofontdata/sound/';
    const WAF_SF = 'JCLive_sf2_file';
    // GM percussion notes the JCLive soundfont actually maps. Matches the
    // 2D plugin's DRUM_MIDI_NOTES; adding entries here would just download
    // 404s if the soundfont doesn't ship them.
    const DRUM_MIDI_NOTES = [35, 36, 38, 40, 41, 42, 43, 44, 45, 46, 47, 48, 49, 50, 51, 57, 59];
    const LS_SYNTH_VOL = 'drum_h3d_synth_vol';

    let _audioCtx = null;
    let _synthPlayer = null;
    let _synthGain = null;
    let _synthVolume = 0.7;
    let _playerScriptLoaded = false;
    let _synthInitInFlight = null;    // shared promise while _synthInit is running
    const _drumPresets = {};   // midiNote -> WebAudioFont preset

    function _loadScript(url) {
        return new Promise((resolve, reject) => {
            // Reuse an existing tag only if it succeeded (no data-error).
            // A previously-failed tag must be removed and retried so we don't
            // resolve immediately with a script that never actually executed.
            // An in-flight tag (no data-loaded / data-error yet) gets
            // additional listeners so we wait for its outcome rather than
            // resolving immediately before it has actually run.
            const existing = document.querySelector(`script[src="${url}"]`);
            if (existing) {
                if (existing.dataset.error) {
                    // Previous load failed — remove and retry.
                    existing.remove();
                } else if (existing.dataset.loaded) {
                    // Already fully executed.
                    resolve();
                    return;
                } else {
                    // Still in flight — piggyback on the same tag.
                    existing.addEventListener('load', () => { existing.dataset.loaded = '1'; resolve(); }, { once: true });
                    existing.addEventListener('error', () => { existing.dataset.error = '1'; reject(new Error('Failed to load ' + url)); }, { once: true });
                    return;
                }
            }
            const s = document.createElement('script');
            s.src = url;
            s.onload = () => { s.dataset.loaded = '1'; resolve(); };
            s.onerror = () => { s.dataset.error = '1'; reject(new Error('Failed to load ' + url)); };
            document.head.appendChild(s);
        });
    }

    function _wafVar(note) { return '_drum_' + note + '_0_' + WAF_SF; }
    function _wafUrl(note) { return WAF_BASE + '128' + note + '_0_' + WAF_SF + '.js'; }

    async function _synthInit() {
        if (_synthPlayer) return;
        // Guard against concurrent calls: if a prior call is still awaiting
        // script/preset loads, share its promise so only one AudioContext and
        // one WebAudioFontPlayer are ever created per tab.
        if (_synthInitInFlight) return _synthInitInFlight;
        _synthInitInFlight = (async () => {
        try {
            const raw = _readStore(LS_SYNTH_VOL);
            const parsed = raw === null ? NaN : parseFloat(raw);
            if (Number.isFinite(parsed) && parsed >= 0 && parsed <= 1) _synthVolume = parsed;
            if (!_playerScriptLoaded) {
                await _loadScript(WAF_PLAYER_URL);
                _playerScriptLoaded = true;
            }
            if (typeof WebAudioFontPlayer === 'undefined') return;
            _audioCtx = new (window.AudioContext || window.webkitAudioContext)();
            _synthGain = _audioCtx.createGain();
            _synthGain.gain.value = _synthVolume;
            _synthGain.connect(_audioCtx.destination);
            _synthPlayer = new WebAudioFontPlayer();
            // Chrome creates AudioContext in suspended state and refuses to
            // play scheduled audio until a user gesture resumes it. MIDI
            // note-on events count as gestures in recent Chrome — but only
            // if the gesture-to-resume gap is small. Arm a one-shot
            // pointerdown / keydown listener so the very first user
            // interaction anywhere on the page unblocks playback. The
            // {once:true} flag detaches the listener after it fires.
            const _resumeOnGesture = () => {
                if (_audioCtx && _audioCtx.state === 'suspended') _audioCtx.resume();
            };
            window.addEventListener('pointerdown', _resumeOnGesture, { once: true, capture: true });
            window.addEventListener('keydown',     _resumeOnGesture, { once: true, capture: true });
            await _synthLoadKit();
        } catch (e) {
            console.warn('[Drum-Hwy3D] Synth init failed:', e);
        } finally {
            _synthInitInFlight = null;
        }
        })();
        return _synthInitInFlight;
    }

    async function _synthLoadKit() {
        if (!_synthPlayer || !_audioCtx) return;
        await Promise.all(DRUM_MIDI_NOTES.map(async (note) => {
            const varName = _wafVar(note);
            try {
                if (!window[varName]) await _loadScript(_wafUrl(note));
                const preset = window[varName];
                if (preset) {
                    _synthPlayer.adjustPreset(_audioCtx, preset);
                    _drumPresets[note] = preset;
                }
            } catch (e) {
                console.warn('[Drum-Hwy3D] preset load failed for MIDI ' + note + ':', e);
            }
        }));
    }

    function _synthEnsureCtx() {
        // Most browsers block AudioContext until a user gesture. MIDI input
        // counts as a gesture in Chrome — _synthDrumHit kicks the context
        // out of suspended on first hit.
        if (_audioCtx && _audioCtx.state === 'suspended') _audioCtx.resume();
    }

    function _synthDrumHit(midiNote, velocity) {
        if (!_synthPlayer || !_audioCtx || !_synthGain) return;
        const preset = _drumPresets[midiNote];
        if (!preset) return;
        _synthEnsureCtx();
        // Velocity-to-volume: normalise to 0-1. The overall slider level is
        // already applied by _synthGain (its gain.value == _synthVolume), so
        // don't multiply here — that would square the volume.
        const vol = (velocity || 100) / 127;
        // 0.5 s queue duration — drum samples are short, no sustain needed.
        _synthPlayer.queueWaveTable(_audioCtx, _synthGain, preset, 0, midiNote, 0.5, vol);
    }

    function _synthSetVolume(v) {
        const c = Math.max(0, Math.min(1, Number(v) || 0));
        _synthVolume = c;
        if (_synthGain) _synthGain.gain.value = c;
        _writeStore(LS_SYNTH_VOL, String(c));
    }

    /* ======================================================================
     *  Demo patterns — hardcoded, loop indefinitely
     * ====================================================================== */

    // Each pattern: { length: seconds, notes: [{ t, lane, variant? }] }
    // lane is the LANES index. variant is optional and recognised values are
    // 'accent' | 'ghost' | 'flam' | 'bell' (bell only meaningful on ride lane).
    //
    // Times are in seconds within the loop. The renderer schedules each note
    // at every loop cycle (t, t+length, t+2*length, …) within the active
    // window, so notes recycle naturally without bookkeeping.

    const DEMO_PATTERNS = {
        // Classic rock backbeat: kick on 1+3, snare on 2+4, hi-hat 8ths,
        // crash on the downbeat of bar 1. 4-bar loop at ~120 BPM (2s/bar).
        rock_backbeat: {
            length: 8.0,
            notes: (() => {
                const out = [];
                for (let bar = 0; bar < 4; bar++) {
                    const b = bar * 2.0;
                    // hi-hat 8ths
                    for (let i = 0; i < 8; i++) out.push({ t: b + i * 0.25, lane: 0 });
                    // kick on 1 and 3
                    out.push({ t: b + 0.0, lane: 7 });
                    out.push({ t: b + 1.0, lane: 7 });
                    // snare on 2 and 4
                    out.push({ t: b + 0.5, lane: 1 });
                    out.push({ t: b + 1.5, lane: 1 });
                    // crash on bar-1 downbeat
                    if (bar === 0) out.push({ t: b + 0.0, lane: 5, variant: 'accent' });
                }
                return out;
            })(),
        },

        // Jazz swing — ride pattern, ghost-note snare comping, soft kick.
        jazz_swing: {
            length: 8.0,
            notes: (() => {
                const out = [];
                for (let bar = 0; bar < 4; bar++) {
                    const b = bar * 2.0;
                    // ride: ding ding-a ding ding-a (swing 8ths)
                    for (let beat = 0; beat < 4; beat++) {
                        const onBeat = b + beat * 0.5;
                        out.push({ t: onBeat, lane: 6, variant: beat === 0 ? 'bell' : undefined });
                        // swing "and" — closer to the next beat
                        if (beat === 1 || beat === 3) {
                            out.push({ t: onBeat + 0.33, lane: 6 });
                        }
                    }
                    // hi-hat foot on 2 and 4
                    out.push({ t: b + 0.5, lane: 0 });
                    out.push({ t: b + 1.5, lane: 0 });
                    // snare ghost comping
                    out.push({ t: b + 0.75, lane: 1, variant: 'ghost' });
                    out.push({ t: b + 1.25, lane: 1, variant: 'ghost' });
                    // soft kick on 1
                    out.push({ t: b + 0.0, lane: 7 });
                }
                return out;
            })(),
        },

        // Showcase every variant: ghost, accent, flam, bell — plus every
        // lane fires at least once. Designed to read each visual element
        // clearly without flipping settings.
        fill_showcase: {
            length: 8.0,
            notes: [
                // Bar 1 — basic groove to set the stage
                { t: 0.00, lane: 7 },                        // kick
                { t: 0.00, lane: 0 },                        // hh
                { t: 0.00, lane: 5, variant: 'accent' },     // crash accent (lane 5)
                { t: 0.25, lane: 0 },
                { t: 0.50, lane: 1 },                        // snare
                { t: 0.50, lane: 0 },
                { t: 0.75, lane: 0 },
                { t: 1.00, lane: 7 },
                { t: 1.00, lane: 0 },
                { t: 1.25, lane: 0 },
                { t: 1.50, lane: 1 },
                { t: 1.50, lane: 0 },
                { t: 1.75, lane: 0 },
                // Bar 2 — ghost note showcase on snare
                { t: 2.00, lane: 7 },
                { t: 2.00, lane: 0 },
                { t: 2.125, lane: 1, variant: 'ghost' },
                { t: 2.25, lane: 0 },
                { t: 2.375, lane: 1, variant: 'ghost' },
                { t: 2.50, lane: 1 },
                { t: 2.50, lane: 0 },
                { t: 2.625, lane: 1, variant: 'ghost' },
                { t: 2.75, lane: 0 },
                { t: 3.00, lane: 7 },
                { t: 3.50, lane: 1, variant: 'accent' },     // snare accent
                // Bar 3 — flam showcase + ride
                { t: 4.00, lane: 7 },
                { t: 4.00, lane: 6 },                        // ride
                { t: 4.50, lane: 1, variant: 'flam' },       // snare flam
                { t: 5.00, lane: 6, variant: 'bell' },       // ride bell
                { t: 5.50, lane: 1, variant: 'flam' },       // snare flam
                // Bar 4 — tom roll down the kit
                { t: 6.00, lane: 7 },
                { t: 6.00, lane: 2 },                        // hi tom
                { t: 6.25, lane: 2 },
                { t: 6.50, lane: 3 },                        // mid tom
                { t: 6.75, lane: 3 },
                { t: 7.00, lane: 4 },                        // floor tom
                { t: 7.25, lane: 4 },
                { t: 7.50, lane: 5, variant: 'accent' },     // crash accent
                { t: 7.50, lane: 7 },                        // kick under crash
            ],
        },
    };

    /* ======================================================================
     *  Settings hydration — palette/pattern/camera-angle live in localStorage.
     * ====================================================================== */

    const LS_KEYS = {
        palette: 'drum_h3d_palette',
        pattern: 'drum_h3d_pattern',
        cameraAngle: 'drum_h3d_camera_angle',
    };

    function readSettings() {
        let palette = 'default';
        let pattern = 'rock_backbeat';
        let cameraAngle = 0.35; // 0 = looking down the lanes, 1 = top-down
        try {
            const p = localStorage.getItem(LS_KEYS.palette);
            if (p && PALETTES[p]) palette = p;
            const pat = localStorage.getItem(LS_KEYS.pattern);
            if (pat && DEMO_PATTERNS[pat]) pattern = pat;
            const ca = parseFloat(localStorage.getItem(LS_KEYS.cameraAngle));
            if (Number.isFinite(ca)) cameraAngle = Math.min(1, Math.max(0, ca));
        } catch (_) { /* localStorage unavailable — use defaults */ }
        return { palette, pattern, cameraAngle };
    }

    // Expose setters so settings.html can poke a live preview without a
    // reload. Setters update localStorage and broadcast a CustomEvent that
    // the renderer subscribes to.
    window.drumH3dSetPalette = function (id) {
        if (!PALETTES[id]) return;
        try { localStorage.setItem(LS_KEYS.palette, id); } catch (_) {}
        window.dispatchEvent(new CustomEvent('drum_h3d:settings', { detail: { palette: id } }));
    };
    window.drumH3dSetPattern = function (id) {
        if (!DEMO_PATTERNS[id]) return;
        try { localStorage.setItem(LS_KEYS.pattern, id); } catch (_) {}
        window.dispatchEvent(new CustomEvent('drum_h3d:settings', { detail: { pattern: id } }));
    };
    window.drumH3dSetCameraAngle = function (v) {
        const c = Math.min(1, Math.max(0, Number(v) || 0));
        try { localStorage.setItem(LS_KEYS.cameraAngle, String(c)); } catch (_) {}
        window.dispatchEvent(new CustomEvent('drum_h3d:settings', { detail: { cameraAngle: c } }));
    };

    /* ======================================================================
     *  Renderer factory
     * ====================================================================== */

    function createFactory() {
        // Per-instance state (per-panel under splitscreen).
        let highwayCanvas = null;
        let scene = null;
        let cam = null;
        let ren = null;
        let lights = null;

        // Settings snapshot — mutated by 'drum_h3d:settings' event.
        let settings = readSettings();
        let activePalette = PALETTES[settings.palette];

        // Scene groups / pooled meshes.
        let laneGroup = null;       // lane stripes + dividers
        let kitMapGroup = null;     // top-of-highway kit silhouette
        let notesGroup = null;      // all currently-visible notes (recreated each frame)

        // Cached materials — palette-driven, rebuilt on palette swap.
        let mDrumByLane = null;     // Mesh material per lane (drum lanes)
        let mCymbalByLane = null;   // Mesh material per lane (cymbal lanes)
        // Pre-cloned hit/miss tint materials — avoids per-frame per-note clones.
        let mDrumHitByLane = null;
        let mDrumMissByLane = null;
        let mCymbalHitByLane = null;
        let mCymbalMissByLane = null;
        let mKick = null;           // Kick bar material
        let mKickHit = null;        // Pre-cloned hit tint for kick
        let mKickMiss = null;       // Pre-cloned miss tint for kick
        let mAccentRing = null;     // Halo material for accents
        let mGhostRing = null;      // Hollow ring material for ghost notes
        let mSnareStripe = null;    // White snare wire material
        let mBellDot = null;        // Bright dot for ride bell hits

        // Geometry — shared across notes.
        let gDrumDisc = null;
        let gCymbalGem = null;
        let gKickBar = null;
        let gAccentRing = null;
        let gGhostRing = null;
        let gSnareStripe = null;
        let gBellDot = null;
        let gFlamGrace = null;

        // Demo loop clock — anchored to performance.now() so animation
        // proceeds regardless of audio playback state.
        const t0 = performance.now() / 1000;

        let _isReady = false;
        let _settingsHandler = null;
        let _kitHandler = null;

        /* ── Hit detection + scoring (per-instance) ──────────────── */
        // _hitKeys / _missedKeys: note keys (t|lane) of drum_tab hits the
        // user already scored or scrolled past. Keying on LANE (not piece)
        // lets a hit on either crash MIDI register against either crash
        // note on the shared CR lane — same semantics as the 2D plugin.
        const _hitKeys = new Set();
        const _missedKeys = new Set();
        let _hits = 0, _misses = 0;
        let _streak = 0, _bestStreak = 0;
        // [{lane, wall, kind}] — wall is performance.now(); kind drives
        // the colour of the lane flash (green=hit, red=miss/wrong).
        const _laneFlashes = [];
        // Latest snapshot of (sorted real-data notes, currentTime) so
        // MIDI events (which fire async w.r.t. draw) score against the
        // chart the user is actually looking at.
        let _latestNotes = null;
        let _latestTime = 0;
        // Miss-sweep floor: notes at or before this song-time are exempt
        // from _updateMissed. Set to the connect-frame time when a MIDI
        // device wires up mid-song — notes that passed while no events
        // could arrive are unplayable, not misses. Lowered on seek-back
        // (those notes become playable again) and cleared by _resetScoring.
        let _missSweepFloor = -Infinity;

        /* ── HUD overlay (combo / accuracy / streak) ─────────────── */
        let _hudEl = null;
        let _hudParentOrigPosition = null;   // saved so _removeHud can restore it

        function _injectHud() {
            if (_hudEl || !highwayCanvas) return;
            const parent = highwayCanvas.parentElement;
            if (!parent) return;
            // Position the parent relative so absolute HUD anchors to
            // the canvas. Read-only check first so we don't clobber an
            // existing position the host page set.
            const cur = parent.style.position || getComputedStyle(parent).position;
            if (cur === 'static' || !cur) {
                _hudParentOrigPosition = parent.style.position;
                parent.style.position = 'relative';
            }
            _hudEl = document.createElement('div');
            _hudEl.className = 'drum-h3d-hud';
            _hudEl.style.cssText = [
                'position:absolute', 'top:10px', 'left:14px',
                'font-family:system-ui,sans-serif', 'font-size:13px',
                'color:#e2e8f0', 'pointer-events:none', 'z-index:6',
                'text-shadow:0 1px 2px rgba(0,0,0,0.8)',
                'min-width:140px', 'line-height:1.4',
            ].join(';');
            parent.appendChild(_hudEl);
            _refreshHud();
        }

        function _removeHud() {
            if (_hudEl) {
                const parent = _hudEl.parentNode;
                if (parent) {
                    parent.removeChild(_hudEl);
                    // Restore position only if _injectHud changed it.
                    if (_hudParentOrigPosition !== null) {
                        parent.style.position = _hudParentOrigPosition;
                        _hudParentOrigPosition = null;
                    }
                }
            }
            _hudEl = null;
        }

        function _refreshHud() {
            if (!_hudEl) return;
            const total = _hits + _misses;
            const pct = total ? Math.round((_hits / total) * 100) : 0;
            const comboColor = _streak >= 30 ? '#fde047' :
                               _streak >= 10 ? '#86efac' : '#cbd5e1';
            _hudEl.innerHTML =
                `<div style="color:${comboColor};font-weight:600;font-size:18px">${_streak}× combo</div>` +
                `<div>${_hits}/${total} (${pct}%)</div>` +
                (_bestStreak ? `<div style="color:#94a3b8;font-size:11px">best ${_bestStreak}</div>` : '');
        }

        /* ── Lane flash — pulse a lane's emissive briefly on hit ── */
        // Wallclock decay window — matches the 2D plugin's 300 ms flash.
        const FLASH_MS = 300;

        function _applyLaneFlashes() {
            // No longer used for visual feedback (chart notes now turn
            // green/red on hit/miss via placeNote). Still drop expired
            // entries from the buffer so the array doesn't grow forever
            // if MIDI hits arrive while no chart is loaded.
            const now = performance.now();
            while (_laneFlashes.length && now - _laneFlashes[0].wall > FLASH_MS) {
                _laneFlashes.shift();
            }
        }

        function _resetScoring() {
            _hitKeys.clear();
            _missedKeys.clear();
            _hits = 0; _misses = 0;
            _streak = 0; _bestStreak = 0;
            _laneFlashes.length = 0;
            _missSweepFloor = -Infinity;
        }

        function _hitKey(t, lane) {
            return t.toFixed(3) + '|' + lane;
        }

        // MIDI note-on dispatcher. Resolves the played MIDI to a lane
        // index, scans the visible chart window for an un-hit matching
        // note within ±HIT_TOLERANCE_S, and updates scoring + visual
        // feedback. Wrong-piece or missed-window hits flash red.
        function _handleDrumHit(midiNote, velocity) {
            _synthDrumHit(midiNote, velocity);
            _synthEnsureCtx();

            const piece = MIDI_TO_PIECE[midiNote];
            const lane = piece !== undefined ? PIECE_TO_LANE[piece] : undefined;
            if (lane === undefined) {
                _laneFlashes.push({ lane: -1, wall: performance.now(), kind: 'wrong' });
                return;
            }

            if (!_latestNotes || _latestNotes.length === 0) {
                _laneFlashes.push({ lane, wall: performance.now(), kind: 'hit' });
                return;
            }

            const t = _latestTime;

            let foundHit = false;
            for (const n of _latestNotes) {
                if (n.t > t + HIT_TOLERANCE_S) break;
                if (n.t < t - HIT_TOLERANCE_S) continue;
                if (n.lane !== lane) continue;
                const key = _hitKey(n.t, n.lane);
                if (_hitKeys.has(key)) continue;
                _hitKeys.add(key);
                foundHit = true;
                break;
            }

            if (foundHit) {
                _hits++;
                _streak++;
                if (_streak > _bestStreak) _bestStreak = _streak;
                _laneFlashes.push({ lane, wall: performance.now(), kind: 'hit' });
            } else {
                _misses++;
                _streak = 0;
                _laneFlashes.push({ lane, wall: performance.now(), kind: 'wrong' });
            }
        }

        // Walk recently-passed notes once per frame and mark any unhit
        // ones as missed. Called from rebuildNotes after the bundle's
        // currentTime is known.
        function _updateMissed(t) {
            if (!_latestNotes) return;
            const cutoff = t - HIT_TOLERANCE_S - 0.02;
            for (const n of _latestNotes) {
                if (n.t > cutoff) break;
                if (n.t < cutoff - 2) continue;  // older than 2 s — already counted
                if (n.t <= _missSweepFloor) continue;  // passed before MIDI connected
                const key = _hitKey(n.t, n.lane);
                if (_hitKeys.has(key) || _missedKeys.has(key)) continue;
                _missedKeys.add(key);
                _misses++;
                _streak = 0;
            }
        }

        function applySettings(detail) {
            if (!detail) return;
            if (detail.palette && PALETTES[detail.palette]) {
                settings.palette = detail.palette;
                activePalette = PALETTES[detail.palette];
                rebuildPaletteMaterials();
                rebuildKitMap();
            }
            if (detail.pattern && DEMO_PATTERNS[detail.pattern]) {
                settings.pattern = detail.pattern;
            }
            if (typeof detail.cameraAngle === 'number') {
                settings.cameraAngle = Math.min(1, Math.max(0, detail.cameraAngle));
                positionCamera();
            }
        }

        function rebuildPaletteMaterials() {
            disposeMaterialArray(mDrumByLane);
            disposeMaterialArray(mCymbalByLane);
            disposeMaterialArray(mDrumHitByLane);
            disposeMaterialArray(mDrumMissByLane);
            disposeMaterialArray(mCymbalHitByLane);
            disposeMaterialArray(mCymbalMissByLane);
            mDrumByLane = new Array(LANES.length).fill(null);
            mCymbalByLane = new Array(LANES.length).fill(null);
            mDrumHitByLane = new Array(LANES.length).fill(null);
            mDrumMissByLane = new Array(LANES.length).fill(null);
            mCymbalHitByLane = new Array(LANES.length).fill(null);
            mCymbalMissByLane = new Array(LANES.length).fill(null);
            for (let i = 0; i < LANES.length; i++) {
                const lane = LANES[i];
                const color = lane.kind === 'kick' ? KICK_COLOR : activePalette[lane.paletteIdx];
                if (lane.kind === 'drum') {
                    mDrumByLane[i] = new T.MeshStandardMaterial({
                        color,
                        emissive: color,
                        emissiveIntensity: 0.45,
                        roughness: 0.55,
                        metalness: 0.1,
                    });
                    // Pre-cloned tint materials for hit (green) and miss (red),
                    // keyed per lane so proximity emissive adjustments on the base
                    // material don't affect tinted notes.
                    mDrumHitByLane[i] = mDrumByLane[i].clone();
                    mDrumHitByLane[i].color.setHex(0x22c55e);
                    mDrumHitByLane[i].emissive.setHex(0x22c55e);
                    mDrumMissByLane[i] = mDrumByLane[i].clone();
                    mDrumMissByLane[i].color.setHex(0xef4444);
                    mDrumMissByLane[i].emissive.setHex(0xef4444);
                } else if (lane.kind === 'cymbal') {
                    mCymbalByLane[i] = new T.MeshStandardMaterial({
                        color,
                        emissive: color,
                        emissiveIntensity: 0.55,
                        roughness: 0.25,
                        metalness: 0.7,
                        transparent: true,
                        opacity: 0.92,
                    });
                    mCymbalHitByLane[i] = mCymbalByLane[i].clone();
                    mCymbalHitByLane[i].color.setHex(0x22c55e);
                    mCymbalHitByLane[i].emissive.setHex(0x22c55e);
                    mCymbalMissByLane[i] = mCymbalByLane[i].clone();
                    mCymbalMissByLane[i].color.setHex(0xef4444);
                    mCymbalMissByLane[i].emissive.setHex(0xef4444);
                }
            }
            if (mKick) mKick.dispose();
            if (mKickHit) mKickHit.dispose();
            if (mKickMiss) mKickMiss.dispose();
            mKick = new T.MeshStandardMaterial({
                color: KICK_COLOR,
                emissive: KICK_COLOR,
                emissiveIntensity: 0.6,
                roughness: 0.4,
                metalness: 0.2,
            });
            mKickHit = mKick.clone();
            mKickHit.color.setHex(0x22c55e);
            mKickHit.emissive.setHex(0x22c55e);
            mKickMiss = mKick.clone();
            mKickMiss.color.setHex(0xef4444);
            mKickMiss.emissive.setHex(0xef4444);
        }

        function disposeMaterialArray(arr) {
            if (!arr) return;
            for (const m of arr) if (m) m.dispose();
        }

        /* -- one-time scene setup --------------------------------------- */

        function initScene() {
            scene = new T.Scene();
            scene.background = new T.Color(FOG_COLOR);
            scene.fog = new T.Fog(FOG_COLOR, FOG_START, FOG_END);

            cam = new T.PerspectiveCamera(60, 16 / 9, 0.1, 1000 * K);
            positionCamera();

            lights = new T.Group();
            const ambient = new T.AmbientLight(0xffffff, 0.4);
            const dir = new T.DirectionalLight(0xffffff, 1.0);
            dir.position.set(-50 * K, 200 * K, 200 * K);
            lights.add(ambient);
            lights.add(dir);
            scene.add(lights);

            // Floor plane — wide darkened quad under the lanes.
            // Use Math.max(1, LANE_COUNT) so a kick-only kit (LANE_COUNT=0)
            // still produces a floor at least as wide as the kick bar (KICK_W).
            const floorW = Math.max(1, LANE_COUNT) * LANE_GAP + 8 * K;
            const floorD = (AHEAD + BEHIND + 0.5) * TS + 60 * K;
            const gFloor = new T.PlaneGeometry(floorW, floorD);
            const mFloor = new T.MeshStandardMaterial({
                color: 0x0a0e1a,
                roughness: 0.95,
                metalness: 0.0,
            });
            const floor = new T.Mesh(gFloor, mFloor);
            floor.rotation.x = -Math.PI / 2;
            floor.position.set(0, -0.3 * K, -floorD / 2 + BEHIND * TS);
            scene.add(floor);

            // Build lane stripes / dividers (static).
            buildLanes(floorW, floorD);

            // Build the kit silhouette backboard.
            kitMapGroup = new T.Group();
            scene.add(kitMapGroup);
            rebuildKitMap();

            // Hit-line bar in front of the camera, perpendicular to scroll.
            const gHit = new T.BoxGeometry(floorW, 0.6 * K, 0.6 * K);
            const mHit = new T.MeshStandardMaterial({
                color: 0xffffff,
                emissive: 0xffffff,
                emissiveIntensity: 0.9,
                roughness: 0.3,
                metalness: 0.6,
            });
            const hitBar = new T.Mesh(gHit, mHit);
            hitBar.position.set(0, 0.3 * K, 0);
            scene.add(hitBar);

            // (Lane-flash boxes removed — hit/miss feedback now lives on
            // the chart note itself via a per-note material clone in
            // placeNote. Simpler visual: green note = you struck it,
            // red note = it scrolled past unstruck.)

            // Notes group is rebuilt every frame — pooling could come later
            // but at <100 visible notes per frame the GC cost is negligible.
            notesGroup = new T.Group();
            scene.add(notesGroup);

            // Shared geometry.
            gDrumDisc = new T.CylinderGeometry(DISC_R_BASE, DISC_R_BASE, DISC_H, 32);
            gCymbalGem = new T.CylinderGeometry(CYMBAL_R * 0.15, CYMBAL_R, CYMBAL_H, 8, 1, false);
            gKickBar = new T.BoxGeometry(KICK_W, KICK_H, KICK_D);
            gAccentRing = new T.RingGeometry(DISC_R_BASE * 1.15, DISC_R_BASE * 1.4, 32);
            gGhostRing = new T.RingGeometry(DISC_R_BASE * 0.55, DISC_R_BASE * 0.75, 24);
            gSnareStripe = new T.BoxGeometry(DISC_R_BASE * 1.9, 0.25 * K, 0.4 * K);
            gBellDot = new T.CircleGeometry(CYMBAL_R * 0.3, 16);
            gFlamGrace = new T.CylinderGeometry(
                DISC_R_BASE * FLAM_GRACE_SCALE,
                DISC_R_BASE * FLAM_GRACE_SCALE,
                DISC_H,
                24,
            );

            // Halo and ghost ring materials — additive emissive, palette-agnostic.
            mAccentRing = new T.MeshBasicMaterial({
                color: 0xffffff,
                transparent: true,
                opacity: 0.85,
                side: T.DoubleSide,
            });
            mGhostRing = new T.MeshBasicMaterial({
                color: 0xffffff,
                transparent: true,
                opacity: 0.55,
                side: T.DoubleSide,
            });
            mSnareStripe = new T.MeshStandardMaterial({
                color: 0xffffff,
                emissive: 0xffffff,
                emissiveIntensity: 0.5,
                roughness: 0.3,
            });
            mBellDot = new T.MeshBasicMaterial({
                color: 0xffeecc,
                transparent: true,
                opacity: 0.95,
                side: T.DoubleSide,
            });

            rebuildPaletteMaterials();
        }

        function positionCamera() {
            // cameraAngle: 0 = down the lanes (low + forward), 1 = top-down.
            const a = settings.cameraAngle;
            // Camera height ramps from low-ish to high; depth pulls back as we
            // tilt down so the lanes still fit the frame.
            const h = (45 + 180 * a) * K;
            const d = (60 + 60 * (1 - a)) * K;
            cam.position.set(0, h, d);
            cam.lookAt(0, 0, -AHEAD * TS * 0.45);
        }

        function buildLanes(_floorW, floorD) {
            laneGroup = new T.Group();
            // Alternating lane stripes for the 7 hand lanes (same teal/blue
            // as highway_3d, but a notch darker so the brighter discs pop).
            const colors = [0x2d5476, 0x42759d];
            for (let i = 0; i < LANE_COUNT; i++) {
                const x = LANE_X0 + i * LANE_GAP;
                const g = new T.PlaneGeometry(LANE_GAP * 0.96, floorD);
                const m = new T.MeshBasicMaterial({
                    color: colors[i % 2],
                    transparent: true,
                    opacity: 0.32,
                });
                const stripe = new T.Mesh(g, m);
                stripe.rotation.x = -Math.PI / 2;
                stripe.position.set(x, -0.25 * K, -floorD / 2 + BEHIND * TS);
                laneGroup.add(stripe);
            }
            scene.add(laneGroup);
        }

        function rebuildKitMap() {
            // Clear existing children.
            while (kitMapGroup.children.length) {
                const c = kitMapGroup.children.pop();
                if (c.geometry) c.geometry.dispose();
                if (c.material) {
                    if (Array.isArray(c.material)) c.material.forEach(m => m.dispose());
                    else c.material.dispose();
                }
            }

            // Backboard plane far down the highway where guitar's fretboard
            // would terminate. Each lane's piece silhouette sits over its
            // lane's X position so the kit reads as a top-down map.
            const farZ = -AHEAD * TS - 10 * K;
            const boardW = LANE_COUNT * LANE_GAP + 6 * K;
            const boardH = 28 * K;
            const gBoard = new T.PlaneGeometry(boardW, boardH);
            const mBoard = new T.MeshBasicMaterial({
                color: 0x0a1422,
                transparent: true,
                opacity: 0.85,
            });
            const board = new T.Mesh(gBoard, mBoard);
            board.position.set(0, boardH / 2 + 2 * K, farZ);
            kitMapGroup.add(board);

            // Per-piece silhouettes — circle outlines (drums/cymbals) for
            // each HAND lane. LANE_COUNT excludes the kick (which is
            // rendered as a wide rectangle below instead).
            for (let i = 0; i < LANE_COUNT; i++) {
                const lane = LANES[i];
                if (!lane) continue;
                const color = activePalette[lane.paletteIdx];
                const x = LANE_X0 + i * LANE_GAP;
                const r = lane.kind === 'cymbal' ? 3.2 * K : 2.6 * K;
                const segs = lane.kind === 'cymbal' ? 8 : 32;
                const gOutline = new T.RingGeometry(r * 0.92, r, segs);
                const mOutline = new T.MeshBasicMaterial({
                    color,
                    transparent: true,
                    opacity: 0.85,
                    side: T.DoubleSide,
                });
                const ring = new T.Mesh(gOutline, mOutline);
                ring.position.set(x, boardH * 0.55 + 2 * K, farZ + 0.1 * K);
                kitMapGroup.add(ring);
            }
            // Kick rectangle — only rendered when the active kit includes
            // a kick lane (LANES.length > LANE_COUNT means a kick is appended
            // at the end). Otherwise no bar appears, kit silhouette omits it.
            const hasKick = LANES.length > LANE_COUNT;
            if (hasKick) {
                const kickG = new T.PlaneGeometry(boardW * 0.86, 2.0 * K);
                const kickM = new T.MeshBasicMaterial({
                    color: KICK_COLOR,
                    transparent: true,
                    opacity: 0.85,
                });
                const kick = new T.Mesh(kickG, kickM);
                kick.position.set(0, boardH * 0.18 + 2 * K, farZ + 0.1 * K);
                kitMapGroup.add(kick);
            }
        }

        /* -- per-frame note rendering ----------------------------------- */

        function buildNoteMesh(lane, variant) {
            const laneCfg = LANES[lane];
            const group = new T.Group();

            if (laneCfg.kind === 'kick') {
                const bar = new T.Mesh(gKickBar, mKick);
                if (variant === 'accent') bar.scale.setScalar(ACCENT_SCALE);
                group.add(bar);
                if (variant === 'accent') {
                    // Bright leading edge bar (a thin white strip on the
                    // camera-facing edge of the kick). Geometry + material
                    // are per-note — flag both as transient so disposeMeshTree
                    // releases them when the note recycles.
                    const edgeGeo = new T.BoxGeometry(KICK_W * 0.96, KICK_H * 1.05, 0.6 * K);
                    const edgeMat = new T.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.9 });
                    edgeGeo.userData.transient = true;
                    edgeMat.userData.transient = true;
                    const edge = new T.Mesh(edgeGeo, edgeMat);
                    edge.position.set(0, 0, KICK_D * 0.5);
                    group.add(edge);
                }
                return group;
            }

            if (laneCfg.kind === 'drum') {
                let scale = 1.0;
                if (variant === 'ghost') scale = GHOST_SCALE;
                else if (variant === 'accent') scale = ACCENT_SCALE;

                if (variant === 'ghost') {
                    // Hollow ring instead of disc — easier to read as "quiet".
                    // Material is per-note (palette-tinted but transparent) —
                    // flag it transient so disposeMeshTree releases it.
                    const ghostMat = new T.MeshBasicMaterial({
                        color: activePalette[laneCfg.paletteIdx],
                        transparent: true,
                        opacity: 0.75,
                        side: T.DoubleSide,
                    });
                    ghostMat.userData.transient = true;
                    ghostMat.userData.isGhostRing = true;
                    const ring = new T.Mesh(gGhostRing, ghostMat);
                    ring.rotation.x = -Math.PI / 2;
                    ring.scale.setScalar(scale);
                    group.add(ring);
                } else {
                    const disc = new T.Mesh(gDrumDisc, mDrumByLane[lane]);
                    disc.scale.set(scale, 1, scale);
                    group.add(disc);
                }

                if (laneCfg.subKind === 'snare' && variant !== 'ghost') {
                    const stripe = new T.Mesh(gSnareStripe, mSnareStripe);
                    stripe.position.set(0, DISC_H * 0.55, 0);
                    stripe.scale.set(scale, 1, scale);
                    group.add(stripe);
                }

                if (variant === 'accent') {
                    const halo = new T.Mesh(gAccentRing, mAccentRing);
                    halo.rotation.x = -Math.PI / 2;
                    halo.position.y = DISC_H * 0.6;
                    halo.scale.setScalar(scale);
                    group.add(halo);
                }
                return group;
            }

            if (laneCfg.kind === 'cymbal') {
                // Cymbal "gem" — flattened bipyramid (truncated cone). The
                // top-radius/bottom-radius ratio gives a faceted gem look.
                let scale = 1.0;
                if (variant === 'ghost') scale = GHOST_SCALE;
                else if (variant === 'accent') scale = ACCENT_SCALE;

                const gem = new T.Mesh(gCymbalGem, mCymbalByLane[lane]);
                gem.scale.setScalar(scale);
                group.add(gem);

                if (laneCfg.subKind === 'hihat') {
                    // Open-hat hint: a thin ring around the gem (closed-hat
                    // is the bare gem). For the mockup we don't differentiate
                    // open/closed yet — TODO: drive from variant.
                }
                if (laneCfg.subKind === 'ride' && variant === 'bell') {
                    const dot = new T.Mesh(gBellDot, mBellDot);
                    dot.rotation.x = -Math.PI / 2;
                    dot.position.y = CYMBAL_H * 0.55;
                    group.add(dot);
                }
                if (variant === 'accent') {
                    const halo = new T.Mesh(gAccentRing, mAccentRing);
                    halo.rotation.x = -Math.PI / 2;
                    halo.position.y = CYMBAL_H * 0.55;
                    halo.scale.setScalar(scale * 1.05);
                    group.add(halo);
                }
                return group;
            }

            return group;
        }

        // Cache: converted drum_tab.hits → [{lane, t, variant}] sorted by t.
        // Re-derive only when the bundle's drumTab object identity changes
        // (one allocation per song-load, not per frame).
        let _cachedDrumTabKey = null;
        let _cachedRealNotes = null;

        function _realNotesFromDrumTab(drumTab) {
            const hits = (drumTab && Array.isArray(drumTab.hits)) ? drumTab.hits : [];
            const out = [];
            for (const h of hits) {
                const lane = PIECE_TO_LANE[h.p];
                if (lane === undefined) continue;  // unknown piece — skip silently
                out.push({ lane, t: +h.t || 0, variant: _variantForHit(h) });
            }
            out.sort((a, b) => a.t - b.t);
            return out;
        }

        function rebuildNotes(bundle) {
            // Clear the existing notes group — for <100 simultaneously visible
            // notes the GC churn is fine and the code stays simple.
            while (notesGroup.children.length) {
                const c = notesGroup.children.pop();
                disposeMeshTree(c);
            }

            // Real-data path: when the active sloppak ships a drum_tab,
            // bundle.drumTab is populated by static/highway.js (slopsmith
            // drums-from-scratch PR). Otherwise fall back to the hardcoded
            // demo loop so the viz still has something to show on songs
            // without drums or in standalone playback.
            const drumTab = bundle && bundle.drumTab;
            if (drumTab && Array.isArray(drumTab.hits)) {
                if (_cachedDrumTabKey !== drumTab) {
                    _cachedDrumTabKey = drumTab;
                    _cachedRealNotes = _realNotesFromDrumTab(drumTab);
                    // New chart — reset scoring so combo/accuracy don't
                    // carry over from the previous song. Mirrors the v3
                    // 2D plugin's bundle.isReady edge-detect behaviour.
                    _resetScoring();
                }
                const t = (bundle && typeof bundle.currentTime === 'number') ? bundle.currentTime : 0;
                // Snapshot for the MIDI handler — has to run BEFORE the
                // visible-window walk so an in-flight pad hit fired
                // between frames scores against the same view the user
                // sees. _updateMissed also reads these to retire passed
                // notes that the user didn't strike.
                _latestNotes = _cachedRealNotes;
                _latestTime = t;
                // Only accumulate misses when a MIDI device is connected.
                // With no device selected the user cannot hit notes, so
                // counting passes as misses would corrupt the HUD accuracy.
                // When a device was just connected, reset scoring first so
                // notes that elapsed while no device was connected are not
                // retroactively counted as misses.
                // Gate on _midiHandle (the live wired session), NOT _midiInput: the
                // latter is set as soon as a device is picked, but the async
                // mi.open() may still be pending (slow / permission prompt), during
                // which no events can arrive — counting passes then would bank false
                // misses. _midiHandle is truthy only after a handle is opened+wired.
                if (_midiHandle) {
                    if (_midiJustConnected) {
                        _midiJustConnected = false;
                        _resetScoring();
                        // Floor the sweep at the connect frame: without this
                        // the _updateMissed call right below would bank the
                        // last ~2 s of notes as misses even though no input
                        // could have arrived for them yet.
                        _missSweepFloor = t;
                    }
                    // Seek-back past the floor makes those notes playable
                    // again — let them count.
                    if (t < _missSweepFloor) _missSweepFloor = t;
                    _updateMissed(t);
                }
                // Linear walk with early break — notes are sorted by time so
                // the first note beyond AHEAD ends the visible window.
                // Hit / missed notes get a tag passed through to placeNote
                // so it can render them differently (hit → green tint, miss →
                // red tint). The match is keyed on (t, lane), same as hit
                // detection — multiple piece-ids on a lane (crash_l +
                // crash_r) share the visual feedback.
                for (const note of _cachedRealNotes) {
                    const dt = note.t - t;
                    if (dt > AHEAD) break;
                    if (dt < -BEHIND) continue;
                    const key = _hitKey(note.t, note.lane);
                    const status = _hitKeys.has(key) ? 'hit' :
                                   _missedKeys.has(key) ? 'missed' :
                                   'pending';
                    placeNote(note, dt, status);
                }
                return;
            }

            // Demo-loop fallback: drumTab is absent or empty. If we just
            // transitioned away from a real chart, clear stale scoring state
            // so MIDI hits (and the HUD) don't score against the old notes.
            if (_cachedDrumTabKey !== null) {
                _cachedDrumTabKey = null;
                _cachedRealNotes = [];
                _latestNotes = [];
                _latestTime = 0;
                _resetScoring();
            }
            const pat = DEMO_PATTERNS[settings.pattern];
            if (!pat) return;
            const now = performance.now() / 1000 - t0;
            const phase = now % pat.length;
            for (let cycle = -1; cycle <= 1; cycle++) {
                const cycleBase = cycle * pat.length;
                for (const note of pat.notes) {
                    const dt = note.t + cycleBase - phase;
                    if (dt < -BEHIND || dt > AHEAD) continue;
                    placeNote(note, dt);
                }
            }
        }

        function placeNote(note, dt, status) {
            const laneCfg = LANES[note.lane];
            if (!laneCfg) return;

            const z = -dt * TS;            // dt > 0 → upstream (negative Z)
            const x = laneCfg.kind === 'kick' ? 0 : (LANE_X0 + note.lane * LANE_GAP);
            const y = laneCfg.kind === 'kick' ? 0 : DISC_H * 0.5;

            const mesh = buildNoteMesh(note.lane, note.variant);
            mesh.position.set(x, y, z);

            // Brighten emissive as the note approaches the hit line.
            // 0 at AHEAD, peak at 0, then linger briefly past it.
            const proximity = Math.max(0, 1 - Math.abs(dt) / 0.6);
            if (laneCfg.kind === 'drum' && note.variant !== 'ghost' && mDrumByLane[note.lane]) {
                // Subtle pulse via emissiveIntensity — palette-driven base + pulse.
                mDrumByLane[note.lane].emissiveIntensity = 0.45 + proximity * 0.35;
            } else if (laneCfg.kind === 'cymbal' && mCymbalByLane[note.lane]) {
                mCymbalByLane[note.lane].emissiveIntensity = 0.55 + proximity * 0.35;
            } else if (laneCfg.kind === 'kick' && mKick) {
                mKick.emissiveIntensity = 0.6 + proximity * 0.5;
            }

            // Slight scale-up as notes near the hit line gives the eye a
            // "this is the moment" cue. Capped so it doesn't overshoot.
            const approach = 1.0 + Math.max(0, 1 - Math.abs(dt) / 0.3) * 0.12;
            mesh.scale.multiplyScalar(approach);

            // Status overrides — clone the shared lane material per-note so
            // we can recolor JUST this note (green = hit, red = miss). The
            // Swap in pre-cloned hit/miss tint materials — avoids per-frame
            // per-note material.clone() calls while notesGroup is rebuilt.
            if (status === 'hit' || status === 'missed') {
                const isHit = status === 'hit';
                if (laneCfg.kind === 'kick') {
                    // Kick uses a single shared bar — swap to the pre-cloned
                    // tint material for consistent hit/miss feedback.
                    const tintKick = isHit ? mKickHit : mKickMiss;
                    mesh.traverse((child) => {
                        if (!child.isMesh || !child.material) return;
                        if (child.material === mKick && tintKick) child.material = tintKick;
                    });
                } else {
                    const tintDrum = isHit ? mDrumHitByLane[note.lane] : mDrumMissByLane[note.lane];
                    const tintCymbal = isHit ? mCymbalHitByLane[note.lane] : mCymbalMissByLane[note.lane];
                    const ghostColor = isHit ? 0x00ff88 : 0xff4444;
                    mesh.traverse((child) => {
                        if (!child.isMesh || !child.material) return;
                        const isBase = child.material === mDrumByLane[note.lane];
                        const isCym = child.material === mCymbalByLane[note.lane];
                        // Ghost ring uses a dedicated per-note MeshBasicMaterial
                        // with userData.isGhostRing — tint it in-place (already
                        // unique per note, no clone needed). Not the same as the
                        // kick accent edge which only sets userData.transient.
                        const isGhostRing = child.material.userData && child.material.userData.isGhostRing;
                        if (isBase && tintDrum) child.material = tintDrum;
                        else if (isCym && tintCymbal) child.material = tintCymbal;
                        else if (isGhostRing) child.material.color.setHex(ghostColor);
                    });
                }
            }

            notesGroup.add(mesh);

            // Flam grace note — small auxiliary disc slightly before the main.
            // Hit status applies to the whole flam (grace + main vanish
            // together); missed status leaves the grace at normal size
            // since shrinking just the main reads as enough miss-feedback.
            if (note.variant === 'flam' && laneCfg.kind === 'drum') {
                const graceDt = dt + FLAM_GRACE_OFFSET;
                if (graceDt >= -BEHIND && graceDt <= AHEAD) {
                    const grace = new T.Mesh(gFlamGrace, mDrumByLane[note.lane]);
                    grace.position.set(x - DISC_R_BASE * 0.9, y, -graceDt * TS);
                    notesGroup.add(grace);
                }
            }
        }

        function disposeMeshTree(node) {
            // Shared geometries/materials (gDrumDisc, mDrumByLane[i], etc.)
            // are owned by the renderer and disposed in teardown(). Per-note
            // ephemeral geometries/materials are flagged with
            // .userData.transient = true at construction time — dispose those.
            node.traverse((child) => {
                if (!child.isMesh) return;
                if (child.geometry && child.geometry.userData && child.geometry.userData.transient) {
                    child.geometry.dispose();
                }
                if (child.material && child.material.userData && child.material.userData.transient) {
                    child.material.dispose();
                }
            });
        }

        /* -- size handling ---------------------------------------------- */

        function applySize(w, h) {
            if (!ren || !cam || !highwayCanvas) return;
            const W = Math.max(1, Math.round(w || highwayCanvas.clientWidth || highwayCanvas.width || 1));
            const H = Math.max(1, Math.round(h || highwayCanvas.clientHeight || highwayCanvas.height || 1));
            ren.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
            ren.setSize(W, H, false);
            cam.aspect = W / H;
            cam.updateProjectionMatrix();
        }

        /* -- teardown --------------------------------------------------- */

        // Drop scene geometry / materials / renderer without unsubscribing
        // lifecycle handlers (settings, kit, MIDI). Used for kit-change
        // rebuild where the renderer comes right back up against the same
        // canvas. Returns true when the renderer was re-created cleanly,
        // false when WebGL re-init failed — callers must NOT proceed to
        // initScene() on false (the scene would draw into nothing).
        function _disposeScene() {
            if (notesGroup) {
                while (notesGroup.children.length) {
                    disposeMeshTree(notesGroup.children.pop());
                }
            }
            if (kitMapGroup) {
                while (kitMapGroup.children.length) {
                    const c = kitMapGroup.children.pop();
                    if (c.geometry) c.geometry.dispose();
                    if (c.material) c.material.dispose();
                }
            }
            // Dispose laneGroup stripe meshes (PlaneGeometry + MeshBasicMaterial per
            // lane) so kit-change rebuilds don't leak GPU resources.
            if (laneGroup) {
                while (laneGroup.children.length) {
                    const c = laneGroup.children.pop();
                    if (c.geometry) c.geometry.dispose();
                    if (c.material) c.material.dispose();
                }
            }
            disposeMaterialArray(mDrumByLane);
            disposeMaterialArray(mCymbalByLane);
            disposeMaterialArray(mDrumHitByLane);
            disposeMaterialArray(mDrumMissByLane);
            disposeMaterialArray(mCymbalHitByLane);
            disposeMaterialArray(mCymbalMissByLane);
            if (mKick) mKick.dispose();
            if (mKickHit) mKickHit.dispose();
            if (mKickMiss) mKickMiss.dispose();
            if (mAccentRing) mAccentRing.dispose();
            if (mGhostRing) mGhostRing.dispose();
            if (mSnareStripe) mSnareStripe.dispose();
            if (mBellDot) mBellDot.dispose();
            if (gDrumDisc) gDrumDisc.dispose();
            if (gCymbalGem) gCymbalGem.dispose();
            if (gKickBar) gKickBar.dispose();
            if (gAccentRing) gAccentRing.dispose();
            if (gGhostRing) gGhostRing.dispose();
            if (gSnareStripe) gSnareStripe.dispose();
            if (gBellDot) gBellDot.dispose();
            if (gFlamGrace) gFlamGrace.dispose();
            if (ren) ren.dispose();
            scene = cam = ren = lights = laneGroup = kitMapGroup = notesGroup = null;
            mDrumByLane = mCymbalByLane = mKick = mKickHit = mKickMiss = null;
            mDrumHitByLane = mDrumMissByLane = mCymbalHitByLane = mCymbalMissByLane = null;
            mAccentRing = mGhostRing = mSnareStripe = mBellDot = null;
            gDrumDisc = gCymbalGem = gKickBar = null;
            gAccentRing = gGhostRing = gSnareStripe = gBellDot = gFlamGrace = null;
            // Re-create the renderer against the existing canvas. initScene
            // populates everything we just disposed.
            try {
                ren = new T.WebGLRenderer({
                    canvas: highwayCanvas,
                    antialias: true,
                    alpha: false,
                });
                ren.setClearColor(FOG_COLOR, 1);
                return true;
            } catch (e) {
                console.error('[Drum-Hwy3D] WebGL2 re-init failed:', e);
                ren = null;
                return false;
            }
        }

        function teardown() {
            if (_settingsHandler) {
                window.removeEventListener('drum_h3d:settings', _settingsHandler);
                _settingsHandler = null;
            }
            if (_kitHandler) {
                window.removeEventListener('drum_h3d:kit', _kitHandler);
                _kitHandler = null;
            }
            if (notesGroup) {
                while (notesGroup.children.length) {
                    disposeMeshTree(notesGroup.children.pop());
                }
            }
            if (kitMapGroup) {
                while (kitMapGroup.children.length) {
                    const c = kitMapGroup.children.pop();
                    if (c.geometry) c.geometry.dispose();
                    if (c.material) c.material.dispose();
                }
            }
            disposeMaterialArray(mDrumByLane);
            disposeMaterialArray(mCymbalByLane);
            disposeMaterialArray(mDrumHitByLane);
            disposeMaterialArray(mDrumMissByLane);
            disposeMaterialArray(mCymbalHitByLane);
            disposeMaterialArray(mCymbalMissByLane);
            if (mKick) mKick.dispose();
            if (mKickHit) mKickHit.dispose();
            if (mKickMiss) mKickMiss.dispose();
            if (mAccentRing) mAccentRing.dispose();
            if (mGhostRing) mGhostRing.dispose();
            if (mSnareStripe) mSnareStripe.dispose();
            if (mBellDot) mBellDot.dispose();
            if (gDrumDisc) gDrumDisc.dispose();
            if (gCymbalGem) gCymbalGem.dispose();
            if (gKickBar) gKickBar.dispose();
            if (gAccentRing) gAccentRing.dispose();
            if (gGhostRing) gGhostRing.dispose();
            if (gSnareStripe) gSnareStripe.dispose();
            if (gBellDot) gBellDot.dispose();
            if (gFlamGrace) gFlamGrace.dispose();
            if (ren) ren.dispose();
            scene = cam = ren = lights = laneGroup = kitMapGroup = notesGroup = null;
            mDrumByLane = mCymbalByLane = mKick = mKickHit = mKickMiss = null;
            mDrumHitByLane = mDrumMissByLane = mCymbalHitByLane = mCymbalMissByLane = null;
            mAccentRing = mGhostRing = mSnareStripe = mBellDot = null;
            gDrumDisc = gCymbalGem = gKickBar = null;
            gAccentRing = gGhostRing = gSnareStripe = gBellDot = gFlamGrace = null;
            _isReady = false;
        }

        /* -- setRenderer contract --------------------------------------- */

        const instance = {
            contextType: 'webgl2',

            init(canvas, _bundle) {
                if (_isReady) teardown();
                highwayCanvas = canvas;
                settings = readSettings();
                activePalette = PALETTES[settings.palette];

                loadThree().then(() => {
                    if (!highwayCanvas) return; // destroyed before load resolved
                    try {
                        ren = new T.WebGLRenderer({
                            canvas: highwayCanvas,
                            antialias: true,
                            alpha: false,
                        });
                        ren.setClearColor(FOG_COLOR, 1);
                    } catch (e) {
                        console.error('[Drum-Hwy] WebGL2 init failed:', e);
                        return;
                    }
                    initScene();
                    applySize(highwayCanvas.clientWidth, highwayCanvas.clientHeight);

                    _settingsHandler = (ev) => applySettings(ev && ev.detail);
                    window.addEventListener('drum_h3d:settings', _settingsHandler);

                    // Kit-change: full scene rebuild because lane count,
                    // positions, kit silhouette and all materials depend
                    // on the active kit. Cheaper than dirty-tracking each
                    // affected piece.
                    _kitHandler = () => {
                        if (!_isReady || !ren) return;
                        _cachedDrumTabKey = null;  // force note re-resolution
                        _cachedRealNotes = null;
                        // Drop the scene + rebuild against the new LANES.
                        // initScene reads the module-level LANES which was
                        // recomputed by drumH3dSetKit before this event.
                        const w = highwayCanvas ? highwayCanvas.clientWidth : 0;
                        const h = highwayCanvas ? highwayCanvas.clientHeight : 0;
                        if (!_disposeScene()) {
                            // WebGL renderer re-init failed — don't build a
                            // scene that would draw into nothing. Mark not
                            // ready and fully tear down so the plugin fails
                            // loudly rather than freezing half-initialised.
                            _isReady = false;
                            teardown();
                            return;
                        }
                        initScene();
                        applySize(w, h);
                    };
                    window.addEventListener('drum_h3d:kit', _kitHandler);

                    // MIDI lifecycle. _midiInit is idempotent across init
                    // calls (re-running setRenderer for the same plugin
                    // doesn't re-request browser permission); _midiResume
                    // wires the message handler whenever this instance
                    // claims focus, which for the non-splitscreen case is
                    // immediately at init.
                    _instances.add(instance);
                    _activeInstance = instance;
                    _midiInit();
                    _synthInit();
                    _midiResume();

                    _injectHud();

                    _isReady = true;
                });
            },

            draw(bundle) {
                if (!_isReady || !ren || !scene || !cam) return;
                rebuildNotes(bundle);
                _applyLaneFlashes();
                _refreshHud();
                ren.render(scene, cam);
            },

            resize(w, h) {
                if (!_isReady) return;
                applySize(w, h);
            },

            destroy() {
                _instances.delete(instance);
                // If the focused instance is going away but others remain
                // (splitscreen teardown of one panel), promote a survivor so
                // _midiOnMessage keeps routing instead of dropping every
                // event on its `if (!_activeInstance) return` guard — same
                // behavior as keys_highway_3d.
                if (_activeInstance === instance) {
                    _activeInstance = null;
                    for (const inst of _instances) { _activeInstance = inst; break; }
                }
                if (_instances.size === 0) _midiReleaseSession();
                _removeHud();
                teardown();
                highwayCanvas = null;
            },
            // Exposed for module-level MIDI router. The receiver runs on
            // every note-on dispatched to _activeInstance.
            _handleDrumHit,
        };
        return instance;
    }

    /* ======================================================================
     *  Register
     * ====================================================================== */

    window.slopsmithViz_drum_highway_3d = createFactory;
    // slopsmith→feedBack rename: host viz picker looks up `window.feedBackViz_<id>`.
    window.feedBackViz_drum_highway_3d = window.slopsmithViz_drum_highway_3d;
    // Static contextType so core can read it for canvas-swap decisions
    // before constructing a throwaway renderer instance.
    window.slopsmithViz_drum_highway_3d.contextType = 'webgl2';
    // Auto-select on sloppaks that carry a drum_tab.json (sloppak-spec
    // §5.3). Sorts before `drums` alphabetically so Auto mode picks the
    // 3D viz over the 2D fallback. The 2D drums plugin keeps its own
    // matchesArrangement as a defence-in-depth fallback for WebGL2-less
    // browsers — _autoMatchViz gates webgl2 contextType on _canRun3D
    // before installing the renderer, so non-WebGL2 environments will
    // skip past this and pick the 2D one.
    //
    // Steal-guard (bundling): `has_drum_tab` is a PACK-level flag, and Auto
    // mode is first-match-wins in plugin order — `drum_highway_3d` sorts
    // before `highway_3d`, so matching on the flag alone would take every
    // full-band pack away from the guitar highway even when the active
    // arrangement is Lead/Bass. Only auto-claim when the ACTIVE arrangement
    // is a drum part, or when nothing more specific can render the song
    // (no keys notation, no guitar-family arrangement). A drummer on a
    // full-band pack picks this viz from the picker as before; instrument-
    // selector routing (server.py highway_ws) will auto-route once a drums
    // selector entry lands.
    window.slopsmithViz_drum_highway_3d.matchesArrangement = function (songInfo) {
        if (!songInfo || !songInfo.has_drum_tab) return false;
        const arr = songInfo.arrangement || '';
        if (/\b(?:drums?|percussion)\b/i.test(arr)) return true;
        if (songInfo.has_notation) return false;
        return !/\b(?:lead|rhythm|bass|combo|guitar)\b/i.test(arr);
    };
})();
