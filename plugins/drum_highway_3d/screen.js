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
    // Bumped ~20% (3.6/3.0 → 4.3/3.6) after hands-on feedback: the gems
    // were hard to read at the default camera. Accent scale (1.25×) still
    // fits the 12*K lane gap: 4.3*2*1.25 = 10.75. Every dependent shape
    // (halo/ghost/open rings, snare stripe, bell dot, flam grace) keys off
    // these radii, so the whole family scales together.
    const DISC_R_BASE = 4.3 * K;                   // drum disc radius
    const DISC_H = 1.4 * K;                        // drum disc thickness
    const CYMBAL_R = 3.6 * K;                      // cymbal gem radius
    const CYMBAL_H = 1.9 * K;                      // cymbal gem height

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

    // Build a horizontal gaussian DataTexture for additive flash quads.
    // PORTED FROM highway_3d/screen.js _makeGaussTex — keep in sync.
    // Returns a W×1 RGBA texture where alpha follows exp(-0.5*(u−0.5)²/σ²),
    // peaking at 1.0 in the centre; σ=0.28 keeps ~0.20 alpha at the edges so
    // the additive falloff fades gradually instead of cutting off sharply.
    function _makeGaussTex(ThreeLib, w = 128, sigma = 0.28) {
        const data = new Uint8Array(w * 4);
        for (let i = 0; i < w; i++) {
            const u = i / (w - 1);
            const d = (u - 0.5) / sigma;
            const v = Math.exp(-0.5 * d * d);
            const a = Math.round(v * 255);
            data[i * 4]     = 255;
            data[i * 4 + 1] = 255;
            data[i * 4 + 2] = 255;
            data[i * 4 + 3] = a;
        }
        const tex = new ThreeLib.DataTexture(data, w, 1, ThreeLib.RGBAFormat);
        // LinearFilter on both axes so the quad interpolates smoothly when
        // scaled — the default NearestFilter causes visible banding.
        tex.magFilter = ThreeLib.LinearFilter;
        tex.minFilter = ThreeLib.LinearFilter;
        tex.needsUpdate = true;
        return tex;
    }

    // Classify a hit's timing against its matched chart note.
    // delta = note.t - now: positive → struck before the note crossed the
    // line (EARLY), negative → after (LATE). Within 40% of the hit window
    // either way reads as on-time — same proportions as highway_3d's
    // timing verdicts.
    function _classifyTiming(delta, tol) {
        if (!Number.isFinite(delta) || !Number.isFinite(tol)) return 'OK';
        if (Math.abs(delta) <= tol * 0.4) return 'OK';
        return delta > 0 ? 'EARLY' : 'LATE';
    }

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

    // Host splitscreen state (PORTED FROM highway_3d _ssActive, minus the
    // focus-API checks the guitar needs for input routing — here it only
    // gates GPU cost, so "is a split active at all" is the right question;
    // a mixed split (this viz + another renderer) must count too).
    function _ssActive() {
        const ss = window.feedBackSplitscreen;
        return !!(ss && typeof ss.isActive === 'function' && ss.isActive());
    }

    /* ======================================================================
     *  Visual-FX settings — guitar-highway parity controls
     * ====================================================================== */

    // Defaults for the graphics/FX controls this plugin exposes. Keys mirror
    // the guitar highway's `h3d_bg_*` vocabulary under this plugin's own
    // `drum_h3d_bg_*` localStorage prefix; later parity PRs (sparks, themes,
    // background styles, score FX) extend this object with their own keys.
    // Everything defaults ON — the settings screen is the opt-out.
    const FX_DEFAULTS = {
        bloom: true,
        sparks: true,     // pooled hit-spark bursts (Points cloud)
        hitFx: 0.7,       // 0–1 master intensity for lane flashes / kick pulse
        timingFx: true,   // early/late/on-time coloring of hit feedback
        streakFx: true,   // consecutive-hit escalation (bigger spark bursts)
        cinematic: true,  // rebalanced lighting (dimmer ambient, stronger key)
        glow: 0.5,        // 0–1 emissive multiplier (0.5 = the stock look)
        vibrancy: 0.85,   // lane stripe / halo / ghost opacity strength
        scoreFx: true,    // 2D overlay: +N pops, combo rings, streak-break wash
        bgIntensity: 0.5, // background-ambience density/strength
        bgReactive: true, // background reacts to the audio analyser
    };
    const FX_LS_PREFIX = 'drum_h3d_bg_';
    // Theme id lives OUTSIDE FX_DEFAULTS (string, not bool/number) — its own
    // localStorage key + validation against BG_THEMES.
    const FX_LS_THEME = 'drum_h3d_bg_theme';
    // Background-ambience style — string-valued like the theme, so it gets
    // its own validated key + setter rather than an FX_DEFAULTS slot.
    // butterchurn/image/video from the guitar are deliberately out of scope
    // (per-plugin vendored megabytes / custom-asset upload plumbing).
    const BG_STYLE_IDS = ['off', 'particles', 'lights', 'geometric'];
    const FX_LS_STYLE = 'drum_h3d_bg_style';
    function readBgStyleSetting() {
        try {
            const id = localStorage.getItem(FX_LS_STYLE);
            if (id && BG_STYLE_IDS.indexOf(id) !== -1) return id;
        } catch (_) {}
        return 'particles';
    }
    window.drumH3dSetBgStyle = function (id) {
        if (BG_STYLE_IDS.indexOf(id) === -1) return;
        try { localStorage.setItem(FX_LS_STYLE, id); } catch (_) {}
        try {
            window.dispatchEvent(new CustomEvent('drum_h3d:settings', { detail: { bgStyle: id } }));
        } catch (_) { /* dispatch unavailable — persisted value applies next init */ }
    };

    /* ======================================================================
     *  Audio analyser bridge — module singletons, shared across instances.
     *  PORTED FROM highway_3d _bgGetAnalyser/_bgReadBands (keep in sync;
     *  delta: the guitar's diagnostics recordBridgeHit plumbing is dropped —
     *  this plugin has no diagnostics contribution).
     * ====================================================================== */
    const BG_FREQ_BINS = 128;
    const BG_ZERO_BANDS = { bass: 0, mid: 0, treble: 0 };
    let _bgAudio = null;       // {ctx, analyser, freq, source} | {failed, permanent}
    let _bgAudioCore = null;   // remembered core tap (one-shot per element)
    let _bgAudioFailedAt = 0;
    const _BG_AUDIO_RETRY_MS = 1000;
    function _bgGetAnalyser() {
        // Prefer the stems plugin's side-chain analyser: on sloppaks the
        // #audio element is a silent virtual transport, so tapping it sees
        // only silence. The stems analyser is per-song — key the cache on
        // its identity so a song switch re-adopts automatically.
        const stemsApi = window.feedBack && window.feedBack.stems;
        const stemsAnalyser = (stemsApi && typeof stemsApi.getAnalyser === 'function')
            ? stemsApi.getAnalyser() : null;
        if (stemsAnalyser) {
            if (!_bgAudio || _bgAudio.source !== 'stems' || _bgAudio.analyser !== stemsAnalyser) {
                _bgAudio = {
                    ctx: stemsAnalyser.context,
                    analyser: stemsAnalyser,
                    freq: new Uint8Array(Math.max(BG_FREQ_BINS, stemsAnalyser.frequencyBinCount)),
                    source: 'stems',
                };
            }
            return _bgAudio;
        }
        // No sloppak stems — drop a stale stems cache (restoring the core
        // tap if one exists; re-tapping #audio would throw InvalidStateError).
        if (_bgAudio && _bgAudio.source === 'stems') _bgAudio = _bgAudioCore;
        if (_bgAudio && !_bgAudio.failed) return _bgAudio;
        if (_bgAudio && _bgAudio.failed) {
            if (_bgAudio.permanent) return null;
            if (performance.now() - _bgAudioFailedAt < _BG_AUDIO_RETRY_MS) return null;
        }
        const audio = document.getElementById('audio');
        if (!audio) return null;
        // Never tap #audio before the page has user activation: a fresh
        // AudioContext would start suspended and route LIVE playback into
        // silence until the next play gesture (createMediaElementSource is
        // one-shot — not undoable). Called per frame, so this just retries
        // once activation exists. (Improvement over the guitar's copy, which
        // only resumes after the fact — candidate to port back.)
        const ua = navigator.userActivation;
        if (ua && ua.hasBeenActive === false) return null;
        // Shared tap: createMediaElementSource is one-shot per element, so
        // the FIRST visualizer to tap #audio publishes it at
        // window.__feedBackAudioTap and every later one (this plugin, the
        // keys highway — the guitar is a port-back candidate) adopts it
        // instead of throwing InvalidStateError in a mixed splitscreen.
        const shared = window.__feedBackAudioTap;
        if (shared && shared.analyser && shared.mediaEl === audio) {
            _bgAudio = {
                ctx: shared.ctx,
                analyser: shared.analyser,
                freq: new Uint8Array(Math.max(BG_FREQ_BINS, shared.analyser.frequencyBinCount)),
                source: 'core',
            };
            _bgAudioCore = _bgAudio;
            return _bgAudio;
        }
        let ctx = null;
        try {
            const Ctx = window.AudioContext || window.webkitAudioContext;
            if (!Ctx) throw new Error('Web Audio API not available');
            ctx = new Ctx();
            const source = ctx.createMediaElementSource(audio);
            const analyser = ctx.createAnalyser();
            analyser.fftSize = 256;
            source.connect(analyser);
            analyser.connect(ctx.destination);
            _bgAudio = { ctx, analyser, freq: new Uint8Array(Math.max(BG_FREQ_BINS, analyser.frequencyBinCount)), source: 'core' };
            _bgAudioCore = _bgAudio;
            try { window.__feedBackAudioTap = { ctx, analyser, mediaEl: audio }; } catch (_) {}
            const resume = () => {
                if (ctx.state === 'suspended' && typeof ctx.resume === 'function') {
                    ctx.resume().catch(() => { /* no gesture yet, retry on next play */ });
                }
            };
            resume();
            audio.addEventListener('play', resume);
            return _bgAudio;
        } catch (e) {
            if (ctx && typeof ctx.close === 'function') {
                try { ctx.close(); } catch (_) {}
            }
            console.warn('[Drum-Hwy3D] failed to set up audio analyser:', e);
            // InvalidStateError = the element is already tapped by another
            // consumer (e.g. the guitar highway in a mixed split) — no
            // recovery without a reload; styles keep animating on time only.
            _bgAudio = { failed: true, permanent: !!(e && e.name === 'InvalidStateError') };
            _bgAudioFailedAt = performance.now();
            return null;
        }
    }
    const _BG_BANDS_CACHE_MS = 5;
    let _bgBandsLastT = -Infinity;
    const _bgBandsCache = { bass: 0, mid: 0, treble: 0 };
    function _bgReadBands() {
        const a = _bgGetAnalyser();
        if (!a) return BG_ZERO_BANDS;
        const t = performance.now();
        if (t - _bgBandsLastT < _BG_BANDS_CACHE_MS) return _bgBandsCache;
        _bgBandsLastT = t;
        a.analyser.getByteFrequencyData(a.freq);
        let bass = 0, mid = 0, treble = 0;
        for (let i = 0; i < 8; i++) bass += a.freq[i];
        for (let i = 8; i < 40; i++) mid += a.freq[i];
        for (let i = 40; i < 128; i++) treble += a.freq[i];
        _bgBandsCache.bass = bass / (8 * 255);
        _bgBandsCache.mid = mid / (32 * 255);
        _bgBandsCache.treble = treble / (88 * 255);
        return _bgBandsCache;
    }

    // Scene color themes — PORTED FROM highway_3d BG_THEMES (keep the ids,
    // names and values in sync so a user's look carries across instruments).
    // The guitar splits background/highway into two axes; here one pick
    // drives both (clear/fog + board/lane) — the drum scene is simpler and
    // a single dropdown reads better in its settings panel.
    //   clear/fog — WebGL clear color + distance fog (kept equal so the
    //               horizon dissolves cleanly)
    //   board     — the floor plane under the lanes
    //   lane/laneDim — the alternating lane stripes; themes without them
    //               fall back to the stock teal/blue pair.
    const BG_THEMES = {
        // 'default' is THIS plugin's original palette (fog 0x1a1a2e, floor
        // 0x0a0e1a, stock teal/blue stripes) — byte-identical for anyone who
        // never touches the setting. The guitar's default differs; every
        // OTHER id below matches the guitar's table exactly.
        default:    { clear: 0x1a1a2e, fog: 0x1a1a2e, board: 0x0a0e1a },
        midnight:   { clear: 0x0a0e1a, fog: 0x0a0e1a, board: 0x080d1c, lane: 0x244fae, laneDim: 0x122a5e },
        charcoal:   { clear: 0x16181c, fog: 0x16181c, board: 0x141417, lane: 0x525a66, laneDim: 0x282d34 },
        deeppurple: { clear: 0x140a1e, fog: 0x140a1e, board: 0x0b0610, lane: 0x3a1f6e, laneDim: 0x1f1040 },
        forest:     { clear: 0x0a1614, fog: 0x0a1614, board: 0x06100c, lane: 0x15602a, laneDim: 0x0a3318 },
        warmslate:  { clear: 0x1c130b, fog: 0x1c130b, board: 0x0e0805, lane: 0x5e3a12, laneDim: 0x341f0a },
        deepfocus:  { clear: 0x0c0c0d, fog: 0x0c0c0d, board: 0x060606, lane: 0x2f7fa0, laneDim: 0x163c4e },
        deepsea:    { clear: 0x06222b, fog: 0x06222b, board: 0x03141a, lane: 0x0e5a63, laneDim: 0x063338 },
        cathode:    { clear: 0x140b03, fog: 0x140b03, board: 0x0c0702, lane: 0x6e4a0e, laneDim: 0x3a2806 },
        cathodegreen: { clear: 0x07301a, fog: 0x07301a, board: 0x031a0c, lane: 0x0e6e2a, laneDim: 0x073a18 },
        hearth:     { clear: 0x280806, fog: 0x280806, board: 0x1a0606, lane: 0x7a2410, laneDim: 0x3f1409 },
    };
    function _bgThemeColors(id) { return BG_THEMES[id] || BG_THEMES.default; }
    function readThemeSetting() {
        try {
            const id = localStorage.getItem(FX_LS_THEME);
            if (id && BG_THEMES[id]) return id;
        } catch (_) {}
        return 'default';
    }
    window.drumH3dSetTheme = function (id) {
        if (!BG_THEMES[id]) return;
        try { localStorage.setItem(FX_LS_THEME, id); } catch (_) {}
        try {
            window.dispatchEvent(new CustomEvent('drum_h3d:settings', { detail: { theme: id } }));
        } catch (_) { /* dispatch unavailable — persisted value applies next init */ }
    };

    function readFxSettings() {
        const fx = Object.assign({}, FX_DEFAULTS);
        try {
            for (const k of Object.keys(FX_DEFAULTS)) {
                const raw = localStorage.getItem(FX_LS_PREFIX + k);
                if (raw === null) continue;
                if (typeof FX_DEFAULTS[k] === 'boolean') {
                    // Explicit values only — anything else (corrupt/foreign
                    // write) keeps the default rather than silently
                    // disabling an effect.
                    if (raw === '1' || raw === 'true') fx[k] = true;
                    else if (raw === '0' || raw === 'false') fx[k] = false;
                } else {
                    const n = parseFloat(raw);
                    // All numeric FX keys are 0-1 sliders — clamp so a
                    // corrupt/foreign write can't overdrive opacities
                    // or the camera pulse.
                    if (Number.isFinite(n)) fx[k] = Math.min(1, Math.max(0, n));
                }
            }
        } catch (_) { /* localStorage unavailable — use defaults */ }
        return fx;
    }

    // Single setter for every FX key — settings.html calls
    // window.drumH3dSetFx('bloom', checked). Coerces to the default's type
    // so a slider string can't poison a boolean toggle.
    window.drumH3dSetFx = function (key, value) {
        if (!(key in FX_DEFAULTS)) return;
        let v;
        if (typeof FX_DEFAULTS[key] === 'boolean') {
            // Same accepted representations as readFxSettings so the
            // setter/reader round-trip is consistent ('0'/'false' → false).
            v = value === true || value === 1 || value === '1' || value === 'true';
        } else {
            v = Number(value);
            if (!Number.isFinite(v)) return;
            v = Math.min(1, Math.max(0, v));   // all numeric FX keys are 0-1
        }
        try {
            localStorage.setItem(FX_LS_PREFIX + key, typeof v === 'boolean' ? (v ? '1' : '0') : String(v));
        } catch (_) {}
        try {
            window.dispatchEvent(new CustomEvent('drum_h3d:settings', { detail: { fx: { [key]: v } } }));
        } catch (_) { /* dispatch unavailable — persisted value applies next init */ }
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
        let fx = readFxSettings();
        let _theme = readThemeSetting();

        // Theme/material handles (initScene builds them; _applyTheme /
        // _applyCinematic / the glow slider retune them live).
        let ambLight = null, dirLight = null;
        let mFloor = null, _gFloor = null;
        let _hitBarMat = null, _gHitBar = null;
        let _envRT = null;   // PMREM render target backing scene.environment

        // Host adaptive-quality scale (bundle.renderScale, 0.25–1) —
        // multiplied into the device pixel ratio like highway_3d does.
        let _renderScale = 1;

        // Auto-resize fallback state (PORTED FROM highway_3d — keep in sync).
        // The splitscreen host resizes the panel canvas but overrides
        // hw.resize and never calls our resize(w,h), so draw() self-detects
        // size drift. _lastHwW/H track the backing store last seen; _appliedW/H
        // track the logical size last handed to applySize(); the countdown
        // throttles the per-frame clientWidth/Height read.
        let _lastHwW = 0, _lastHwH = 0;
        let _appliedW = 0, _appliedH = 0;
        let _boxCheckCountdown = 0;

        // Bloom composer state (PORTED FROM highway_3d/screen.js — keep in sync).
        let _composer = null;
        let _bloomPass = null;
        let _bloomLoad = null;
        let _bloomW = 0, _bloomH = 0;
        let _bloomGen = 0;   // bumped by _bloomDispose so stale loads no-op

        // Hit-FX state. Sparks are PORTED FROM highway_3d (keep in sync);
        // _SPARK_N is 160 here vs the guitar's 256 — a drum chart produces
        // fewer simultaneous verified hits than a strummed chord chart.
        const _SPARK_N = 160;
        let _sparkPts = null, _sparkPos = null, _sparkCol = null, _sparkVel = null, _sparkLife = null;
        let _fxLastWall = 0;          // wall clock for FX integration (sparks, pulse decay)
        let _kickPulse = 0;           // kick-hit camera-dip + floor-wash envelope
        let _camBaseH = 0, _camBaseD = 0;  // positionCamera's unpulsed pose
        let _gaussTex = null;         // shared soft-falloff texture for flash quads
        let _laneFlashQuads = [];     // pooled additive quad per hand lane (z=0)
        let _kickFlashQuad = null;    // full-width flash quad for the kick bar
        let _floorFlash = null;       // wide amber wash pulsed on kick hits
        let laneStripeMats = [];      // buildLanes stripe materials (approach highlight)
        let _laneProx = [];           // per-frame max approach proximity per lane

        // Background ambience (PORTED FROM highway_3d BG_STYLES subset).
        let _bgStyle = readBgStyleSetting();
        let bgGroup = null;           // style meshes live here, renderOrder -1
        let _bgState = null;          // active style's build() state

        // Score-FX overlay (2D canvas sibling — the guitar's drawScoreFx
        // adapted to this plugin's internal scoring; no notedetect events).
        let _fxCanvas = null, _fxCtx = null;
        let _fxDpr = 1;                    // backing-store scale (CSS→device px)
        let _fxParentOrigPosition = null;  // parent position to restore on teardown
        let _scorePops = Array.from({ length: 12 }, () => ({ active: false, x: 0, z: 0, bornMs: 0, text: '' }));
        const _SCORE_BURST_N = 36;
        let _scoreBursts = Array.from({ length: 2 }, () => ({
            active: false, bornMs: 0,
            px: new Float32Array(_SCORE_BURST_N), py: new Float32Array(_SCORE_BURST_N),
            vx: new Float32Array(_SCORE_BURST_N), vy: new Float32Array(_SCORE_BURST_N),
        }));
        let _scoreRingMs = -1e9;      // combo tier-up ring anchor
        let _scoreBreakMs = -1e9;     // streak-break wash anchor
        let _probe = null;            // lazy THREE.Vector3 for projections

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
        let gOpenRing = null;       // open hi-hat ring geometry
        let mOpenRing = null;       // open hi-hat ring material

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
                // Below the host's top-left song-info block (title /
                // arrangement / tuning, ~3 lines) so the two never overlap.
                'position:absolute', 'top:96px', 'left:14px',
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

        // Timing → color (PORTED FROM highway_3d _timingHex — keep in sync):
        // on-time green, early cyan, late amber; green when timing is
        // unknown or the user turned timing colors off.
        function _timingHex(ts) {
            if (!fx.timingFx || !ts || ts === 'OK') return 0x22ff88;
            if (ts === 'EARLY') return 0x35d6ff;
            if (ts === 'LATE')  return 0xffb84d;
            return 0x22ff88;
        }

        // Hit sparks (PORTED FROM highway_3d _sparkBurst/_sparkUpdate — keep
        // in sync): a pooled additive Points cloud; a small radial burst with
        // an upward kick fires at the struck lane, integrated with gravity +
        // color fade in draw().
        function _sparkBurst(x, y, z, hex, count) {
            if (!_sparkPts || count <= 0) return;
            const r = ((hex >> 16) & 255) / 255, g = ((hex >> 8) & 255) / 255, b = (hex & 255) / 255;
            let made = 0;
            for (let i = 0; i < _SPARK_N && made < count; i++) {
                if (_sparkLife[i] > 0) continue;
                const j = i * 3, ang = Math.random() * Math.PI * 2, sp = (5 + Math.random() * 12) * K;
                _sparkPos[j] = x; _sparkPos[j + 1] = y; _sparkPos[j + 2] = z;
                _sparkVel[j] = Math.cos(ang) * sp; _sparkVel[j + 1] = (12 + Math.random() * 24) * K; _sparkVel[j + 2] = Math.sin(ang) * sp * 0.55;
                _sparkCol[j] = r; _sparkCol[j + 1] = g; _sparkCol[j + 2] = b;
                _sparkLife[i] = 0.30 + Math.random() * 0.16; made++;
            }
        }
        function _sparkUpdate(dt) {
            if (!_sparkPts) return;
            const grav = 55 * K; let any = false;
            for (let i = 0; i < _SPARK_N; i++) {
                if (_sparkLife[i] <= 0) continue;
                const j = i * 3;
                _sparkLife[i] -= dt;
                if (_sparkLife[i] <= 0) { _sparkCol[j] = _sparkCol[j + 1] = _sparkCol[j + 2] = 0; continue; }
                any = true;
                _sparkVel[j + 1] -= grav * dt;
                _sparkPos[j] += _sparkVel[j] * dt; _sparkPos[j + 1] += _sparkVel[j + 1] * dt; _sparkPos[j + 2] += _sparkVel[j + 2] * dt;
                const fade = 1 - Math.min(1, dt * 3.2);
                _sparkCol[j] *= fade; _sparkCol[j + 1] *= fade; _sparkCol[j + 2] *= fade;
            }
            _sparkPts.geometry.attributes.position.needsUpdate = true;
            _sparkPts.geometry.attributes.color.needsUpdate = true;
            _sparkPts.visible = any;
        }

        // Fire the 3D feedback for a struck lane: spark burst (timing-colored
        // for hand lanes, always-amber for the kick, whose identity color IS
        // amber) + the kick camera/floor pulse. Wrong hits get no sparks —
        // the red lane flash from _applyLaneFlashes carries that verdict.
        function _spawnHitFx(lane, ts, wrong) {
            const laneCfg = LANES[lane];
            if (!laneCfg || wrong) return;
            let count = 10;
            if (fx.streakFx) count += Math.round(8 * Math.min(1, _streak / 16));
            if (laneCfg.kind === 'kick') {
                _kickPulse = 1;
                if (fx.sparks) {
                    for (const sx of [-KICK_W * 0.3, 0, KICK_W * 0.3]) {
                        _sparkBurst(sx, KICK_H + 1 * K, 0, KICK_COLOR, Math.max(6, count - 4));
                    }
                }
            } else if (fx.sparks) {
                const x = LANE_X0 + lane * LANE_GAP;
                const y = (laneCfg.kind === 'cymbal' ? CYMBAL_H : DISC_H) + 1 * K;
                _sparkBurst(x, y, 0, _timingHex(ts), count);
            }
        }

        function _applyLaneFlashes() {
            // Drop expired entries first so the buffer can't grow forever if
            // MIDI hits arrive while no chart is loaded.
            const now = performance.now();
            while (_laneFlashes.length && now - _laneFlashes[0].wall > FLASH_MS) {
                _laneFlashes.shift();
            }
            if (!_laneFlashQuads.length && !_kickFlashQuad) return;
            // Reset, then drive each lane's quad from its strongest live
            // flash. Additive quads with the shared gauss falloff read as a
            // brief light-up of the struck lane at the hit line.
            for (const q of _laneFlashQuads) if (q) q.material.opacity = 0;
            if (_kickFlashQuad) _kickFlashQuad.material.opacity = 0;
            if (!(fx.hitFx > 0)) return;
            for (const f of _laneFlashes) {
                if (f.lane === -1) continue;   // unknown piece — no lane to flash
                const laneCfg = LANES[f.lane];
                if (!laneCfg) continue;
                const quad = laneCfg.kind === 'kick' ? _kickFlashQuad : _laneFlashQuads[f.lane];
                if (!quad) continue;
                const age = (now - f.wall) / FLASH_MS;
                const strength = Math.max(0, 1 - age) * 0.85 * fx.hitFx;
                if (strength > quad.material.opacity) {
                    quad.material.opacity = strength;
                    quad.material.color.setHex(f.kind === 'wrong' ? 0xff4444 : _timingHex(f.ts));
                }
            }
        }

        // Dispose every hit-FX GPU resource. Called from teardown() AND
        // _disposeScene() — like the bloom composer, all of these are bound
        // to the renderer being dropped; initScene rebuilds them.
        function _disposeFxObjects() {
            if (_sparkPts) {
                try { _sparkPts.geometry.dispose(); _sparkPts.material.dispose(); } catch (_) {}
                _sparkPts = null;
                _sparkPos = _sparkCol = _sparkVel = _sparkLife = null;
            }
            for (const q of _laneFlashQuads) {
                if (q) { try { q.geometry.dispose(); q.material.dispose(); } catch (_) {} }
            }
            _laneFlashQuads = [];
            if (_kickFlashQuad) {
                try { _kickFlashQuad.geometry.dispose(); _kickFlashQuad.material.dispose(); } catch (_) {}
                _kickFlashQuad = null;
            }
            if (_floorFlash) {
                try { _floorFlash.geometry.dispose(); _floorFlash.material.dispose(); } catch (_) {}
                _floorFlash = null;
            }
            if (_gaussTex) { try { _gaussTex.dispose(); } catch (_) {} _gaussTex = null; }
            laneStripeMats = [];   // owned + disposed with laneGroup
            _kickPulse = 0;
        }

        /* ── Bloom (PORTED FROM highway_3d/screen.js _bloomEnsure — keep in
         * sync; deliberate delta: this copy tracks pixel-ratio changes via
         * composer.setPixelRatio (here and in applySize) because renderScale
         * changes the ratio at runtime — the upstream composer never learns
         * about ratio changes after construction, a candidate fix to port
         * back to highway_3d) ── */
        // Lazy-load the vendored postprocessing addons and build an
        // EffectComposer (RenderPass -> UnrealBloomPass -> OutputPass/ACES).
        // Returns the composer once ready, or null (caller falls back to a
        // direct render — also the permanent path if the addons are missing,
        // e.g. an older self-hosted core without static/vendor/three/addons).
        function _bloomEnsure() {
            if (_composer) return _composer;
            if (_bloomLoad || !ren || !scene || !cam) return null;
            const A = '/static/vendor/three/addons/';
            const myGen = _bloomGen;   // superseded by any _bloomDispose()
            _bloomLoad = Promise.all([
                import(A + 'postprocessing/EffectComposer.js'),
                import(A + 'postprocessing/RenderPass.js'),
                import(A + 'postprocessing/UnrealBloomPass.js'),
                import(A + 'postprocessing/OutputPass.js'),
            ]).then(([EC, RP, UB, OP]) => {
                try {
                    // Torn down or superseded mid-load (a dispose clears
                    // _bloomLoad, letting a NEW load start against the new
                    // renderer — this stale completion must not also build
                    // and orphan a composer).
                    if (myGen !== _bloomGen || _composer) return;
                    if (!ren || !scene || !cam || !highwayCanvas) return;
                    const w = Math.max(2, (highwayCanvas.clientWidth || highwayCanvas.width || 1280) | 0);
                    const h = Math.max(2, (highwayCanvas.clientHeight || highwayCanvas.height || 720) | 0);
                    // Multisampled (WebGL2 MSAA) HalfFloat target so anti-aliasing
                    // survives the bloom path — EffectComposer's default target has
                    // no `samples`.
                    const rt = new T.WebGLRenderTarget(w, h, { type: T.HalfFloatType, samples: 4 });
                    const comp = new EC.EffectComposer(ren, rt);
                    comp.setPixelRatio(ren.getPixelRatio());
                    comp.addPass(new RP.RenderPass(scene, cam));
                    _bloomPass = new UB.UnrealBloomPass(new T.Vector2(w, h), 0.65, 0.5, 0.82); // strength, radius, threshold (high → only emissive blooms)
                    comp.addPass(_bloomPass);
                    comp.addPass(new OP.OutputPass());
                    comp.setSize(w, h);
                    _bloomW = w; _bloomH = h; _composer = comp;
                } catch (e) { console.warn('[Drum-Hwy3D] bloom init failed', e); _composer = null; }
            }).catch((e) => console.warn('[Drum-Hwy3D] bloom modules failed', e));
            return null;
        }

        // Drop the composer + its render targets. Called from teardown() AND
        // _disposeScene() — the kit-change path recreates the renderer, and a
        // composer bound to the dead renderer would draw into nothing.
        // Nulling _bloomLoad lets _bloomEnsure rebuild lazily against the new
        // renderer.
        function _bloomDispose() {
            if (_composer) {
                // EffectComposer.dispose() only frees its own read/write
                // buffers — passes own additional GPU resources (UnrealBloom
                // keeps several render targets + materials, OutputPass a
                // material), so dispose each pass explicitly first.
                try {
                    for (const p of _composer.passes || []) {
                        if (p && typeof p.dispose === 'function') p.dispose();
                    }
                } catch (_) {}
                try { _composer.dispose(); } catch (_) {}
            }
            _composer = null;
            _bloomPass = null;
            _bloomLoad = null;
            _bloomW = 0; _bloomH = 0;
            _bloomGen++;   // invalidate any in-flight addon load
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
                // Free-play (no chart loaded): no scoring, but still give
                // the pad strike its lane flash + sparks so drumming along
                // to the demo pattern feels alive.
                _laneFlashes.push({ lane, wall: performance.now(), kind: 'hit' });
                _spawnHitFx(lane, null, false);
                return;
            }

            const t = _latestTime;

            let foundHit = false;
            let matchedDelta = 0;   // note.t - now of the matched note (timing verdict)
            for (const n of _latestNotes) {
                if (n.t > t + HIT_TOLERANCE_S) break;
                if (n.t < t - HIT_TOLERANCE_S) continue;
                if (n.lane !== lane) continue;
                const key = _hitKey(n.t, n.lane);
                if (_hitKeys.has(key)) continue;
                _hitKeys.add(key);
                foundHit = true;
                matchedDelta = n.t - t;
                break;
            }

            if (foundHit) {
                _hits++;
                _streak++;
                if (_streak > _bestStreak) _bestStreak = _streak;
                const ts = _classifyTiming(matchedDelta, HIT_TOLERANCE_S);
                _laneFlashes.push({ lane, wall: performance.now(), kind: 'hit', ts });
                _spawnHitFx(lane, ts, false);
                _scoreOnHit(lane);
            } else {
                const prevStreak = _streak;
                _misses++;
                _streak = 0;
                _laneFlashes.push({ lane, wall: performance.now(), kind: 'wrong' });
                _scoreOnBreak(prevStreak);
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
                const prevStreak = _streak;
                _misses++;
                _streak = 0;
                _scoreOnBreak(prevStreak);
            }
        }

        function applySettings(detail) {
            if (!detail) return;
            if (detail.palette && PALETTES[detail.palette]) {
                settings.palette = detail.palette;
                activePalette = PALETTES[detail.palette];
                rebuildPaletteMaterials();
                rebuildKitMap();
                if (_bgStyle === 'lights') _bgMountStyle();   // lights use the palette
            }
            if (detail.pattern && DEMO_PATTERNS[detail.pattern]) {
                settings.pattern = detail.pattern;
            }
            if (typeof detail.cameraAngle === 'number') {
                settings.cameraAngle = Math.min(1, Math.max(0, detail.cameraAngle));
                positionCamera();
            }
            if (detail.fx) {
                // FX toggles are consumed per-frame in draw() — no rebuild
                // needed; the bloom composer stays cached while toggled off.
                for (const k of Object.keys(detail.fx)) {
                    if (k in FX_DEFAULTS) fx[k] = detail.fx[k];
                }
                if ('cinematic' in detail.fx) _applyCinematic();
                if ('glow' in detail.fx) {
                    // Static emissive bases (hit bar, snare stripe, hit/miss
                    // tints) are baked at build time — rebuild them; the
                    // per-frame placeNote pulse picks the new value up on
                    // its own.
                    rebuildPaletteMaterials();
                    if (_hitBarMat) _hitBarMat.emissiveIntensity = 0.9 * _glowMul();
                    if (mSnareStripe) mSnareStripe.emissiveIntensity = 0.5 * _glowMul();
                }
                if ('vibrancy' in detail.fx) _applyVibrancy();
                if ('bgIntensity' in detail.fx) _bgMountStyle();
            }
            if (detail.theme && BG_THEMES[detail.theme]) {
                _theme = detail.theme;
                _applyTheme();
            }
            if (detail.bgStyle && BG_STYLE_IDS.indexOf(detail.bgStyle) !== -1) {
                _bgStyle = detail.bgStyle;
                _bgMountStyle();
            }
        }

        // Vibrancy slider: stripes get their new base next frame (draw()
        // recomputes them); the halo/ghost ring statics update here.
        function _applyVibrancy() {
            const v = Math.min(1, Math.max(0, fx.vibrancy));
            if (mAccentRing) mAccentRing.opacity = 0.6 + 0.3 * v;
            // Ghost rings get their vibrancy at per-note material creation in
            // buildNoteMesh (they never render with the shared mGhostRing).
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
                        emissiveIntensity: 0.45 * _glowMul(),
                        // Drumhead: satin, a little env pickup so the studio
                        // strips give the discs some dimension.
                        roughness: 0.45,
                        metalness: 0.1,
                        envMapIntensity: 0.5,
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
                        emissiveIntensity: 0.55 * _glowMul(),
                        // With scene.environment set (studio env map) the
                        // metalness finally reads as metal — the old 0.7
                        // metalness had no envMap and looked matte.
                        roughness: 0.2,
                        metalness: 0.85,
                        envMapIntensity: 1.2,
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
                emissiveIntensity: 0.6 * _glowMul(),
                roughness: 0.4,
                metalness: 0.2,
                envMapIntensity: 0.6,
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

        /* -- background ambience (PORTED FROM highway_3d BG_STYLES:
         *    off/particles/lights/geometric — keep formulas in sync; the
         *    guitar's silhouettes/butterchurn/image/video are out of scope) -- */

        const BG_STYLES = {
            off: {
                build() { return null; },
                update() {},
                teardown() {},
            },
            particles: {
                build(group, settings) {
                    const N = Math.max(20, Math.floor(80 + 200 * settings.intensity));
                    const positions = new Float32Array(N * 3);
                    for (let i = 0; i < N; i++) {
                        positions[i * 3] = (Math.random() - 0.5) * 800 * K;
                        positions[i * 3 + 1] = (Math.random() - 0.4) * 80 * K;
                        // Inside the visible fog band; renderOrder -1 keeps
                        // them behind notes regardless of z.
                        positions[i * 3 + 2] = -FOG_START - Math.random() * (FOG_END - FOG_START) * 0.85;
                    }
                    const geo = new T.BufferGeometry();
                    geo.setAttribute('position', new T.BufferAttribute(positions, 3));
                    const mat = new T.PointsMaterial({
                        color: 0xa0c0ff, size: 5 * K, transparent: true,
                        blending: T.AdditiveBlending, depthWrite: false, sizeAttenuation: true,
                    });
                    const points = new T.Points(geo, mat);
                    points.renderOrder = -1;
                    points.frustumCulled = false;
                    group.add(points);
                    return { points, geo, mat, N };
                },
                update(s, bands, dt) {
                    const positions = s.geo.attributes.position.array;
                    const dx = dt * (3 + bands.mid * 12) * K;
                    for (let i = 0; i < s.N; i++) {
                        positions[i * 3] += dx;
                        if (positions[i * 3] > 400 * K) positions[i * 3] -= 800 * K;
                    }
                    s.geo.attributes.position.needsUpdate = true;
                    s.mat.opacity = 0.55 + bands.treble * 0.45;
                },
                teardown(s) {
                    if (!s) return;
                    if (s.points.parent) s.points.parent.remove(s.points);
                    s.geo.dispose();
                    s.mat.dispose();
                },
            },
            lights: {
                build(group, settings) {
                    const N = Math.floor(6 + 8 * settings.intensity);
                    const lights = [];
                    const palette = settings.palette || PALETTES.default;
                    for (let i = 0; i < N; i++) {
                        const color = palette[i % palette.length];
                        const geo = new T.PlaneGeometry(30 * K, 30 * K);
                        const mat = new T.MeshBasicMaterial({
                            color, transparent: true,
                            blending: T.AdditiveBlending, depthWrite: false,
                        });
                        const mesh = new T.Mesh(geo, mat);
                        mesh.renderOrder = -1;
                        mesh.position.set(
                            (Math.random() - 0.5) * 600 * K,
                            (Math.random() - 0.3) * 80 * K,
                            -FOG_START - Math.random() * (FOG_END - FOG_START) * 0.85
                        );
                        group.add(mesh);
                        lights.push({ mesh, geo, mat, baseScale: 1 + Math.random() * 0.5, phase: Math.random() * Math.PI * 2 });
                    }
                    return { lights };
                },
                update(s, bands, dt, t) {
                    for (const L of s.lights) {
                        const pulse = 1 + bands.bass * 1.5 + Math.sin(t * 1.5 + L.phase) * 0.2;
                        L.mesh.scale.set(L.baseScale * pulse, L.baseScale * pulse, 1);
                        L.mat.opacity = 0.55 + bands.treble * 0.4;
                    }
                },
                teardown(s) {
                    if (!s) return;
                    for (const L of s.lights) {
                        if (L.mesh.parent) L.mesh.parent.remove(L.mesh);
                        L.geo.dispose();
                        L.mat.dispose();
                    }
                },
            },
            geometric: {
                build(group, settings) {
                    const meshes = [];
                    const op = 0.45 + 0.25 * settings.intensity;
                    const ico = new T.Mesh(
                        new T.IcosahedronGeometry(30 * K, 1),
                        new T.MeshBasicMaterial({ color: 0x6080c0, wireframe: true, transparent: true, opacity: op, depthWrite: false }),
                    );
                    ico.position.set(-100 * K, 30 * K, -FOG_END * 0.65);
                    ico.renderOrder = -1;
                    group.add(ico);
                    meshes.push(ico);
                    const torus = new T.Mesh(
                        new T.TorusGeometry(22 * K, 4 * K, 6, 12),
                        new T.MeshBasicMaterial({ color: 0xc06080, wireframe: true, transparent: true, opacity: op * 0.9, depthWrite: false }),
                    );
                    torus.position.set(120 * K, 20 * K, -FOG_END * 0.75);
                    torus.renderOrder = -1;
                    group.add(torus);
                    meshes.push(torus);
                    return { meshes };
                },
                update(s, bands, dt) {
                    const speed = 0.2 + bands.mid * 0.4;
                    const pulse = 1 + bands.bass * 0.25;
                    for (const m of s.meshes) {
                        m.rotation.x += dt * speed * 0.3;
                        m.rotation.y += dt * speed * 0.4;
                        m.scale.setScalar(pulse);
                    }
                },
                teardown(s) {
                    if (!s) return;
                    for (const m of s.meshes) {
                        if (m.parent) m.parent.remove(m);
                        m.geometry.dispose();
                        m.material.dispose();
                    }
                },
            },
        };

        // (Re)mount the active bg style into bgGroup. Idempotent — tears the
        // old style down first. Called from initScene, on style/intensity
        // settings changes, and after kit-change scene rebuilds.
        function _bgMountStyle() {
            if (!scene || !T) return;
            if (!bgGroup) {
                bgGroup = new T.Group();
                scene.add(bgGroup);
            }
            const style = BG_STYLES[_bgStyle] || BG_STYLES.off;
            if (_bgState && _bgState._style && BG_STYLES[_bgState._style]) {
                try { BG_STYLES[_bgState._style].teardown(_bgState.s); } catch (_) {}
            }
            let s = null;
            try {
                s = style.build(bgGroup, { intensity: Math.min(1, Math.max(0, fx.bgIntensity)), palette: activePalette });
            } catch (e) {
                console.warn('[Drum-Hwy3D] bg style build failed', e);
                s = null;
            }
            _bgState = { _style: _bgStyle, s };
        }
        function _bgTeardownStyle() {
            if (_bgState && _bgState._style && BG_STYLES[_bgState._style]) {
                try { BG_STYLES[_bgState._style].teardown(_bgState.s); } catch (_) {}
            }
            _bgState = null;
            bgGroup = null;   // its children were removed by teardown; group dies with the scene
        }

        /* -- score-FX overlay (guitar drawScoreFx adapted to internal scoring) -- */

        function _ensureFxCanvas() {
            if (_fxCanvas || !highwayCanvas) return;
            const parent = highwayCanvas.parentElement;
            if (!parent) return;
            const cur = parent.style.position || getComputedStyle(parent).position;
            if (cur === 'static' || !cur) {
                // Record the original inline value (usually '') so teardown
                // can undo this layout mutation — same contract as the HUD.
                _fxParentOrigPosition = parent.style.position;
                parent.style.position = 'relative';
            }
            _fxCanvas = document.createElement('canvas');
            _fxCanvas.className = 'drum-h3d-fx';
            _fxCanvas.style.cssText = 'position:absolute;top:0;left:0;width:100%;height:100%;pointer-events:none;z-index:5';
            parent.appendChild(_fxCanvas);
            _fxCtx = _fxCanvas.getContext('2d');
            _sizeFxCanvas();
        }
        function _sizeFxCanvas() {
            if (!_fxCanvas || !highwayCanvas) return;
            const w = highwayCanvas.clientWidth | 0, h = highwayCanvas.clientHeight | 0;
            if (!w || !h) return;
            const r = Math.min(window.devicePixelRatio || 1, 2);
            if (_fxCanvas.width !== (w * r | 0) || _fxCanvas.height !== (h * r | 0)) {
                _fxCanvas.width = w * r | 0;
                _fxCanvas.height = h * r | 0;
            }
            // The draw path works in CSS pixels and scales the context by
            // this — fixed font/line sizes stay physically consistent on
            // HiDPI instead of shrinking with the backing store.
            _fxDpr = r;
        }
        function _removeFxCanvas() {
            if (_fxCanvas && _fxCanvas.parentNode) {
                const parent = _fxCanvas.parentNode;
                parent.removeChild(_fxCanvas);
                // Restore position only if _ensureFxCanvas changed it (and
                // nothing else — e.g. the HUD — still needs it; the HUD sets
                // and restores its own copy of the same guard first).
                if (_fxParentOrigPosition !== null) {
                    parent.style.position = _fxParentOrigPosition;
                    _fxParentOrigPosition = null;
                }
            }
            _fxCanvas = null;
            _fxCtx = null;
        }
        function _scoreSpawnPop(lane) {
            const laneCfg = LANES[lane];
            if (!laneCfg) return;
            const nowMs = performance.now();
            for (const pop of _scorePops) {
                if (pop.active) continue;
                pop.active = true;
                pop.x = laneCfg.kind === 'kick' ? 0 : (LANE_X0 + lane * LANE_GAP);
                pop.z = 0;
                pop.bornMs = nowMs;
                pop.text = '+1';
                return;
            }
        }
        function _scoreSpawnBurst(nowMs) {
            for (const b of _scoreBursts) {
                if (b.active) continue;
                b.active = true;
                b.bornMs = nowMs;
                for (let j = 0; j < _SCORE_BURST_N; j++) {
                    const a = (j / _SCORE_BURST_N) * Math.PI * 2;
                    const sp = 2 + (j % 5) * 0.8;
                    b.px[j] = 0; b.py[j] = 0;
                    b.vx[j] = Math.cos(a) * sp;
                    b.vy[j] = Math.sin(a) * sp - 1.2;
                }
                return;
            }
        }
        // Called from the scoring paths: hit → pop (+ ring on 10-combo
        // tier-ups, burst on 25/50/100 milestones); a broken streak of 3+
        // → brief red wash.
        function _scoreOnHit(lane) {
            if (!fx.scoreFx) return;
            const nowMs = performance.now();
            _scoreSpawnPop(lane);
            if (_streak > 0 && _streak % 10 === 0) _scoreRingMs = nowMs;
            if (_streak === 25 || _streak === 50 || _streak === 100) _scoreSpawnBurst(nowMs);
        }
        function _scoreOnBreak(prevStreak) {
            if (!fx.scoreFx) return;
            if (prevStreak >= 3) _scoreBreakMs = performance.now();
        }
        function _drawScoreFx() {
            if (!_fxCtx || !_fxCanvas || !cam) return;
            // CSS-pixel coordinate space; the context transform applies the
            // DPR so strokes/fonts render at their intended physical size.
            const r = _fxDpr || 1;
            const W = _fxCanvas.width / r, H = _fxCanvas.height / r;
            _fxCtx.setTransform(r, 0, 0, r, 0, 0);
            const nowMs = performance.now();
            let anyPop = false;
            for (const pop of _scorePops) if (pop.active) { anyPop = true; break; }
            let anyBurst = false;
            for (const b of _scoreBursts) if (b.active) { anyBurst = true; break; }
            const ringAge = nowMs - _scoreRingMs;
            const breakAge = nowMs - _scoreBreakMs;
            // Cheap early-out: clear only while something was recently live.
            if (!anyPop && !anyBurst && ringAge >= 600 && breakAge >= 350) {
                if (_fxCanvas._dirty) { _fxCtx.clearRect(0, 0, W, H); _fxCanvas._dirty = false; }
                return;
            }
            _fxCanvas._dirty = true;
            if (!_probe) _probe = new T.Vector3();
            const ctx = _fxCtx;
            ctx.clearRect(0, 0, W, H);
            ctx.save();
            // Streak-break flicker: brief red wash over the panel.
            if (breakAge < 350) {
                ctx.fillStyle = '#ef4444';
                ctx.globalAlpha = 0.10 * (1 - breakAge / 350);
                ctx.fillRect(0, 0, W, H);
                ctx.globalAlpha = 1;
            }
            // Hit-line center in screen px — anchor for rings + bursts.
            let cx = W / 2, cy = H * 0.72, centerOk = false;
            _probe.set(0, 0.5 * K, 0);
            _probe.project(cam);
            if (_probe.z >= -1 && _probe.z <= 1) {
                cx = (_probe.x * 0.5 + 0.5) * W;
                cy = (-_probe.y * 0.5 + 0.5) * H;
                centerOk = true;
            }
            // Combo tier-up ring (every 10-streak).
            if (centerOk && ringAge < 600) {
                const t = ringAge / 600;
                const ease = 1 - Math.pow(1 - t, 2);
                ctx.beginPath();
                ctx.arc(cx, cy, 20 + ease * Math.min(W, H) * 0.28, 0, Math.PI * 2);
                ctx.strokeStyle = _streak >= 30 ? '#fde047' : '#86efac';
                ctx.globalAlpha = 0.6 * (1 - t);
                ctx.lineWidth = 3;
                ctx.stroke();
                ctx.globalAlpha = 1;
            }
            // Milestone bursts (25/50/100 streak).
            if (anyBurst && centerOk) {
                for (const b of _scoreBursts) {
                    if (!b.active) continue;
                    const age = nowMs - b.bornMs;
                    if (age >= 900) { b.active = false; continue; }
                    const t = age / 900;
                    ctx.globalAlpha = 1 - t;
                    for (let j = 0; j < _SCORE_BURST_N; j++) {
                        b.px[j] += b.vx[j];
                        b.py[j] += b.vy[j];
                        b.vy[j] += 0.08;
                        ctx.fillStyle = (j & 1) ? '#fde047' : '#86efac';
                        ctx.fillRect(cx + b.px[j] - 2, cy + b.py[j] - 2, 4, 4);
                    }
                    ctx.globalAlpha = 1;
                }
            }
            // "+1" pops: rise off the struck lane and fade over the back half.
            if (anyPop) {
                ctx.textAlign = 'center';
                ctx.textBaseline = 'middle';
                for (const pop of _scorePops) {
                    if (!pop.active) continue;
                    const age = nowMs - pop.bornMs;
                    if (age >= 800) { pop.active = false; continue; }
                    _probe.set(pop.x, 2 * K, pop.z);
                    _probe.project(cam);
                    if (_probe.z < -1 || _probe.z > 1) continue;
                    const t = age / 800;
                    const sx = (_probe.x * 0.5 + 0.5) * W;
                    const sy = (-_probe.y * 0.5 + 0.5) * H - t * 30;
                    ctx.globalAlpha = t < 0.4 ? 1 : 1 - (t - 0.4) / 0.6;
                    ctx.font = 'bold 15px system-ui, sans-serif';
                    ctx.lineWidth = 4;
                    ctx.strokeStyle = 'rgba(0,0,0,0.8)';
                    ctx.strokeText(pop.text, sx, sy);
                    ctx.fillStyle = '#86efac';
                    ctx.fillText(pop.text, sx, sy);
                }
                ctx.globalAlpha = 1;
            }
            ctx.restore();
        }

        /* -- one-time scene setup --------------------------------------- */

        // Emissive multiplier from the Glow slider — 0.5 is neutral (the
        // stock look), so `base * _glowMul()` leaves defaults byte-identical.
        function _glowMul() {
            return Math.min(1, Math.max(0, fx.glow)) * 2;
        }

        // Cinematic lighting: dimmer ambient + stronger key light, same
        // rebalance idea as highway_3d's _applyCinematic. Off = the plugin's
        // pre-parity values.
        function _applyCinematic() {
            if (!ambLight || !dirLight) return;
            ambLight.intensity = fx.cinematic ? 0.3 : 0.4;
            dirLight.intensity = fx.cinematic ? 1.2 : 1.0;
        }

        // Procedural "studio" environment for image-based lighting: a dark
        // room shell with three emissive light strips (cool overhead key,
        // warm left fill, cool right accent), baked through PMREMGenerator.
        // No addon needed (PMREMGenerator ships in the core three build) —
        // RoomEnvironment is NOT vendored, hence this hand-rolled stand-in.
        // Returns the PMREM render target ({texture}) or null; caller owns
        // disposing the RT.
        function _makeStudioEnv(ThreeLib, renderer) {
            if (!renderer) return null;
            try {
                const envScene = new ThreeLib.Scene();
                const own = [];   // geometries/materials to free after baking
                const shellGeo = new ThreeLib.BoxGeometry(100, 100, 100);
                const shellMat = new ThreeLib.MeshBasicMaterial({ color: 0x11131c, side: ThreeLib.BackSide });
                envScene.add(new ThreeLib.Mesh(shellGeo, shellMat));
                own.push(shellGeo, shellMat);
                const strip = (w, h, hex, intensity, x, y, z, rx, ry) => {
                    const g = new ThreeLib.PlaneGeometry(w, h);
                    // DoubleSide: orientation-proof — the bake only runs once,
                    // so the extra faces are free insurance.
                    const m = new ThreeLib.MeshBasicMaterial({ color: hex, side: ThreeLib.DoubleSide });
                    m.color.multiplyScalar(intensity);
                    const mesh = new ThreeLib.Mesh(g, m);
                    mesh.position.set(x, y, z);
                    mesh.rotation.set(rx, ry, 0);
                    envScene.add(mesh);
                    own.push(g, m);
                };
                strip(60, 8, 0xdfe8ff, 18, 0, 45, 0, Math.PI / 2, 0);      // overhead key
                strip(30, 50, 0xffd9a8, 6, -48, 5, 0, 0, Math.PI / 2);     // warm left wall
                strip(30, 50, 0x9fd8ff, 6, 48, 5, 0, 0, -Math.PI / 2);     // cool right wall
                const pmrem = new ThreeLib.PMREMGenerator(renderer);
                const rt = pmrem.fromScene(envScene, 0.04);
                pmrem.dispose();
                for (const r of own) r.dispose();
                return rt;
            } catch (e) {
                console.warn('[Drum-Hwy3D] studio env failed (continuing without IBL)', e);
                return null;
            }
        }

        function _disposeEnv() {
            if (_envRT) {
                try { _envRT.dispose(); } catch (_) {}
                _envRT = null;
            }
        }

        // Apply the active theme to the live scene (background/fog/clear +
        // floor + lane stripes). Notes keep their piece palette — themes own
        // the SCENE, palettes own the KIT.
        function _applyTheme() {
            const c = _bgThemeColors(_theme);
            if (scene) {
                if (scene.background && scene.background.isColor) scene.background.setHex(c.clear);
                if (scene.fog) scene.fog.color.setHex(c.fog);
            }
            if (ren) ren.setClearColor(c.clear, 1);
            if (mFloor) mFloor.color.setHex(c.board);
            _applyStripeColors();
        }

        // Lane stripe colors + base opacity (theme lane pair or the stock
        // teal/blue; vibrancy drives how strongly they read). draw()'s
        // approach highlight adds on top of the vibrancy base each frame.
        function _stripeBaseOpacity() {
            return 0.12 + 0.24 * Math.min(1, Math.max(0, fx.vibrancy));
        }
        function _applyStripeColors() {
            const c = _bgThemeColors(_theme);
            const pair = (c.lane != null && c.laneDim != null)
                ? [c.laneDim, c.lane]
                : [0x2d5476, 0x42759d];
            for (let i = 0; i < laneStripeMats.length; i++) {
                laneStripeMats[i].color.setHex(pair[i % 2]);
            }
        }

        function initScene() {
            scene = new T.Scene();
            const themeCols = _bgThemeColors(_theme);
            scene.background = new T.Color(themeCols.clear);
            scene.fog = new T.Fog(themeCols.fog, FOG_START, FOG_END);
            if (ren) ren.setClearColor(themeCols.clear, 1);

            // Studio environment map: emissive-strip room baked through
            // PMREM so MeshStandardMaterial metalness/roughness finally get
            // specular payoff (the cymbals' 0.85 metalness reads as metal).
            // Rebuilt here so the kit-change renderer recreation gets a
            // fresh one; the old RT is disposed by _disposeScene/teardown.
            _envRT = _makeStudioEnv(T, ren);
            if (_envRT) scene.environment = _envRT.texture;

            cam = new T.PerspectiveCamera(60, 16 / 9, 0.1, 1000 * K);
            positionCamera();

            lights = new T.Group();
            ambLight = new T.AmbientLight(0xffffff, 0.4);
            dirLight = new T.DirectionalLight(0xffffff, 1.0);
            dirLight.position.set(-50 * K, 200 * K, 200 * K);
            lights.add(ambLight);
            lights.add(dirLight);
            scene.add(lights);
            _applyCinematic();

            // Floor plane — wide darkened quad under the lanes.
            // Use Math.max(1, LANE_COUNT) so a kick-only kit (LANE_COUNT=0)
            // still produces a floor at least as wide as the kick bar (KICK_W).
            const floorW = Math.max(1, LANE_COUNT) * LANE_GAP + 8 * K;
            const floorD = (AHEAD + BEHIND + 0.5) * TS + 60 * K;
            _gFloor = new T.PlaneGeometry(floorW, floorD);
            const gFloor = _gFloor;
            mFloor = new T.MeshStandardMaterial({
                color: themeCols.board,
                // 0.7 (was 0.95): just enough sheen to catch the env strips
                // without turning the floor into a mirror.
                roughness: 0.7,
                metalness: 0.0,
                envMapIntensity: 0.35,
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
            _gHitBar = new T.BoxGeometry(floorW, 0.6 * K, 0.6 * K);
            const gHit = _gHitBar;
            const mHit = new T.MeshStandardMaterial({
                color: 0xffffff,
                emissive: 0xffffff,
                emissiveIntensity: 0.9 * _glowMul(),
                roughness: 0.3,
                metalness: 0.6,
                envMapIntensity: 1.0,
            });
            _hitBarMat = mHit;
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
            // Open hi-hat: thin warm ring around the gem (closed = bare gem).
            gOpenRing = new T.RingGeometry(CYMBAL_R * 1.05, CYMBAL_R * 1.25, 24);
            mOpenRing = new T.MeshBasicMaterial({
                color: 0xffe9a8,
                transparent: true,
                opacity: 0.85,
                side: T.DoubleSide,
            });

            // Hit sparks (PORTED FROM highway_3d): pooled additive Points
            // cloud, burst on verified hits, integrated in draw().
            _sparkPos = new Float32Array(_SPARK_N * 3); _sparkCol = new Float32Array(_SPARK_N * 3);
            _sparkVel = new Float32Array(_SPARK_N * 3); _sparkLife = new Float32Array(_SPARK_N);
            {
                const sg = new T.BufferGeometry();
                sg.setAttribute('position', new T.BufferAttribute(_sparkPos, 3).setUsage(T.DynamicDrawUsage));
                sg.setAttribute('color', new T.BufferAttribute(_sparkCol, 3).setUsage(T.DynamicDrawUsage));
                const sm = new T.PointsMaterial({ size: 1.0 * K, vertexColors: true, transparent: true, opacity: 0.8, depthWrite: false, blending: T.AdditiveBlending, sizeAttenuation: true });
                _sparkPts = new T.Points(sg, sm); _sparkPts.frustumCulled = false; _sparkPts.renderOrder = 8;
                scene.add(_sparkPts);
            }

            // Lane-flash quads: one pooled additive quad per hand lane plus a
            // full-width one for the kick, parked at the hit line with the
            // shared gauss falloff. _applyLaneFlashes drives color/opacity —
            // this resurrects the lane-flash feedback that was removed when
            // note recoloring landed, now as real light instead of boxes.
            _gaussTex = _makeGaussTex(T, 128, 0.28);
            _laneFlashQuads = [];
            for (let i = 0; i < LANE_COUNT; i++) {
                const g = new T.PlaneGeometry(LANE_GAP * 0.9, 12 * K);
                const m = new T.MeshBasicMaterial({
                    color: 0xffffff, map: _gaussTex, transparent: true, opacity: 0,
                    blending: T.AdditiveBlending, depthWrite: false,
                });
                const quad = new T.Mesh(g, m);
                quad.rotation.x = -Math.PI / 2;
                quad.position.set(LANE_X0 + i * LANE_GAP, 0.06 * K, 0);
                quad.renderOrder = 7;
                scene.add(quad);
                _laneFlashQuads.push(quad);
            }
            {
                const g = new T.PlaneGeometry(floorW * 0.92, 8 * K);
                const m = new T.MeshBasicMaterial({
                    color: KICK_COLOR, map: _gaussTex, transparent: true, opacity: 0,
                    blending: T.AdditiveBlending, depthWrite: false,
                });
                _kickFlashQuad = new T.Mesh(g, m);
                _kickFlashQuad.rotation.x = -Math.PI / 2;
                _kickFlashQuad.position.set(0, 0.05 * K, 0);
                _kickFlashQuad.renderOrder = 7;
                scene.add(_kickFlashQuad);
            }
            // Kick pulse floor wash — wide, faint, pulsed in draw().
            {
                const g = new T.PlaneGeometry(floorW, 40 * K);
                const m = new T.MeshBasicMaterial({
                    color: KICK_COLOR, map: _gaussTex, transparent: true, opacity: 0,
                    blending: T.AdditiveBlending, depthWrite: false,
                });
                _floorFlash = new T.Mesh(g, m);
                _floorFlash.rotation.x = -Math.PI / 2;
                _floorFlash.position.set(0, 0.04 * K, -6 * K);
                _floorFlash.renderOrder = 6;
                scene.add(_floorFlash);
            }

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
                emissiveIntensity: 0.5 * _glowMul(),
                roughness: 0.3,
            });
            mBellDot = new T.MeshBasicMaterial({
                color: 0xffeecc,
                transparent: true,
                opacity: 0.95,
                side: T.DoubleSide,
            });

            rebuildPaletteMaterials();
            _applyVibrancy();   // halo/ghost ring opacities from the slider

            // Background ambience behind everything (renderOrder -1).
            _bgMountStyle();
        }

        function positionCamera() {
            // cameraAngle: 0 = down the lanes (low + forward), 1 = top-down.
            const a = settings.cameraAngle;
            // Camera height ramps from low-ish to high; depth pulls back as we
            // tilt down so the lanes still fit the frame.
            const h = (45 + 180 * a) * K;
            const d = (60 + 60 * (1 - a)) * K;
            // Remember the unpulsed pose — the kick pulse in draw() dips
            // cam.position.y relative to this and must not accumulate.
            _camBaseH = h;
            _camBaseD = d;
            cam.position.set(0, h, d);
            cam.lookAt(0, 0, -AHEAD * TS * 0.45);
        }

        // Camera Director bridge resolver. Prefers THIS panel's per-panel camera
        // under splitscreen (window.__h3dCamCtlPanels[panelIndex]) and falls back
        // to the single global (window.__h3dCamCtl); null when Camera Director is
        // absent → 100% stock framing. Defensive on the splitscreen global name
        // (rename in flight: feedBackSplitscreen vs slopsmithSplitscreen).
        function _freeCamFor(canvas) {
            const map = window.__h3dCamCtlPanels;
            if (map) {
                const ss = window.feedBackSplitscreen || window.slopsmithSplitscreen;
                if (ss && typeof ss.panelIndexFor === 'function') {
                    try {
                        const i = ss.panelIndexFor(canvas);
                        if (i != null && map[i]) return map[i];
                    } catch (e) { /* ignore */ }
                }
            }
            return window.__h3dCamCtl || null;
        }

        // Per-frame camera write: static base pose (positionCamera) + kick-pulse Y
        // dip, then layer Camera Director free-cam offsets (dolly/height/orbit on
        // the camera-from-target vector; pan/pitch on the look target). Runs every
        // frame so a live free-cam drag is smooth; allocation-free; NaN-safe; a
        // null/disabled bridge reproduces the stock static+pulse pose exactly.
        function applyCamera() {
            if (_camBaseH == null) return;               // before first positionCamera()
            const _dip = (_kickPulse > 0.001) ? (0.8 * K * _kickPulse * fx.hitFx) : 0;
            let _cx = 0, _cy = _camBaseH - _dip, _cz = _camBaseD;
            let _lx = 0, _ly = 0, _lz = -AHEAD * TS * 0.45;
            const _fc = _freeCamFor(highwayCanvas);
            if (_fc && _fc.enabled) {
                const _dm = Number.isFinite(_fc.distMul) ? _fc.distMul : 1;
                const _hm = Number.isFinite(_fc.heightMul) ? _fc.heightMul : 1;
                const _yaw = Number.isFinite(_fc.yaw) ? _fc.yaw : 0;
                let _vx = _cx - _lx, _vy = _cy - _ly, _vz = _cz - _lz;
                _vx *= _dm; _vy *= _dm; _vz *= _dm;   // dolly (zoom)
                _vy *= _hm;                            // height
                const _cyw = Math.cos(_yaw), _syw = Math.sin(_yaw);
                const _rx = _vx * _cyw - _vz * _syw, _rz = _vx * _syw + _vz * _cyw; // orbit around Y
                _cx = _lx + _rx; _cy = _ly + _vy; _cz = _lz + _rz;
                const _px = Number.isFinite(_fc.panX) ? _fc.panX : 0;
                const _py = Number.isFinite(_fc.panY) ? _fc.panY : 0;
                const _pt = Number.isFinite(_fc.pitch) ? _fc.pitch : 0;
                _lx += _px * K; _ly += (_pt + _py) * K;
            }
            cam.position.set(_cx, _cy, _cz);
            cam.lookAt(_lx, _ly, _lz);
        }

        function buildLanes(_floorW, floorD) {
            laneGroup = new T.Group();
            laneStripeMats = [];
            // Alternating lane stripes for the 7 hand lanes — theme lane
            // pair when the active theme defines one, else the stock
            // teal/blue (a notch darker than highway_3d so discs pop).
            // _applyStripeColors() retints these on a live theme switch.
            const tc = _bgThemeColors(_theme);
            const colors = (tc.lane != null && tc.laneDim != null)
                ? [tc.laneDim, tc.lane]
                : [0x2d5476, 0x42759d];
            for (let i = 0; i < LANE_COUNT; i++) {
                const x = LANE_X0 + i * LANE_GAP;
                const g = new T.PlaneGeometry(LANE_GAP * 0.96, floorD);
                const m = new T.MeshBasicMaterial({
                    color: colors[i % 2],
                    transparent: true,
                    opacity: _stripeBaseOpacity(),
                });
                const stripe = new T.Mesh(g, m);
                stripe.rotation.x = -Math.PI / 2;
                stripe.position.set(x, -0.25 * K, -floorD / 2 + BEHIND * TS);
                laneGroup.add(stripe);
                // Kept for the per-frame approach highlight (rebuildNotes
                // raises a lane's stripe opacity as its next note nears the
                // hit line).
                laneStripeMats.push(m);
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

        function buildNoteMesh(lane, variant, open) {
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
                        // Vibrancy-driven, evaluated per build — notesGroup is
                        // rebuilt every frame, so slider changes apply live.
                        // (The shared mGhostRing is only the hit/miss-tint
                        // template, not what pending ghosts render with.)
                        opacity: 0.5 + 0.29 * Math.min(1, Math.max(0, fx.vibrancy)),
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

                if (laneCfg.subKind === 'hihat' && open) {
                    // Open-hat: a thin warm ring around the gem (closed-hat
                    // stays the bare gem) — mirrors standard drum notation's
                    // "o" marking. Shared geometry/material: zero per-frame
                    // GC despite the every-frame notesGroup rebuild.
                    const ring = new T.Mesh(gOpenRing, mOpenRing);
                    ring.rotation.x = -Math.PI / 2;
                    ring.position.y = CYMBAL_H * 0.55;
                    ring.scale.setScalar(scale);
                    group.add(ring);
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
                // `open` is orthogonal to variant so an accented or flammed
                // open hat keeps both cues (ring + halo / grace disc).
                out.push({ lane, t: +h.t || 0, variant: _variantForHit(h), open: h.p === 'hh_open' });
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

            // Approach highlight: the visible-window walks below record each
            // hand lane's strongest proximity; _applyApproach() then raises
            // that lane's stripe so the eye is drawn to where the next hit
            // lands.
            if (_laneProx.length !== LANE_COUNT) _laneProx = new Array(LANE_COUNT).fill(0);
            else _laneProx.fill(0);

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

            const mesh = buildNoteMesh(note.lane, note.variant, note.open);
            mesh.position.set(x, y, z);

            // Brighten emissive as the note approaches the hit line.
            // 0 at AHEAD, peak at 0, then linger briefly past it.
            const proximity = Math.max(0, 1 - Math.abs(dt) / 0.6);
            // Feed the lane approach highlight (strongest note wins per frame).
            if (note.lane < LANE_COUNT && proximity > (_laneProx[note.lane] || 0)) {
                _laneProx[note.lane] = proximity;
            }
            const g = _glowMul();   // Glow slider (0.5 default = 1.0x, stock)
            if (laneCfg.kind === 'drum' && note.variant !== 'ghost' && mDrumByLane[note.lane]) {
                // Subtle pulse via emissiveIntensity — palette-driven base + pulse.
                mDrumByLane[note.lane].emissiveIntensity = (0.45 + proximity * 0.35) * g;
            } else if (laneCfg.kind === 'cymbal' && mCymbalByLane[note.lane]) {
                mCymbalByLane[note.lane].emissiveIntensity = (0.55 + proximity * 0.35) * g;
            } else if (laneCfg.kind === 'kick' && mKick) {
                mKick.emissiveIntensity = (0.6 + proximity * 0.5) * g;
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
            // Splitscreen: cap the base DPR harder (1.25 vs 2, mirroring
            // highway_3d) so two panels don't double the fill cost. Checks
            // the host split state (covers a mixed split with another
            // renderer) plus our own instance count (covers multi-instance
            // without host state). _renderScale is the host's adaptive
            // quality scale from bundle.renderScale.
            const baseDPR = (_ssActive() || _instances.size > 1)
                ? Math.min(window.devicePixelRatio || 1, 1.25)
                : Math.min(window.devicePixelRatio || 1, 2);
            ren.setPixelRatio(_renderScale * baseDPR);
            ren.setSize(W, H, false);
            if (_composer) {
                // EffectComposer snapshots the renderer's pixelRatio — it must
                // be told about both ratio and box changes or bloom renders at
                // the wrong resolution.
                _composer.setPixelRatio(ren.getPixelRatio());
                _composer.setSize(W, H);
                _bloomW = W; _bloomH = H;
            }
            cam.aspect = W / H;
            cam.updateProjectionMatrix();
            // Record the logical size actually framed for, so the draw()
            // drift check can tell when the live canvas box has moved away
            // from it (PORTED FROM highway_3d).
            _appliedW = W; _appliedH = H;
            _sizeFxCanvas();
        }

        /* -- teardown --------------------------------------------------- */

        // Drop scene geometry / materials / renderer without unsubscribing
        // lifecycle handlers (settings, kit, MIDI). Used for kit-change
        // rebuild where the renderer comes right back up against the same
        // canvas. Returns true when the renderer was re-created cleanly,
        // false when WebGL re-init failed — callers must NOT proceed to
        // initScene() on false (the scene would draw into nothing).
        function _disposeScene() {
            _bloomDispose();   // composer is bound to the renderer we're about to replace
            _disposeFxObjects();
            _disposeEnv();     // PMREM RT is renderer-bound too; initScene rebuilds it
            _bgTeardownStyle();
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
            if (gOpenRing) gOpenRing.dispose();
            if (mOpenRing) mOpenRing.dispose();
            if (ren) ren.dispose();
            // Floor + hit-bar resources (tracked since the themes PR — they
            // previously leaked across kit-change scene rebuilds).
            if (mFloor) mFloor.dispose();
            if (_gFloor) _gFloor.dispose();
            if (_hitBarMat) _hitBarMat.dispose();
            if (_gHitBar) _gHitBar.dispose();
            scene = cam = ren = lights = laneGroup = kitMapGroup = notesGroup = null;
            ambLight = dirLight = mFloor = _gFloor = _hitBarMat = _gHitBar = null;
            mDrumByLane = mCymbalByLane = mKick = mKickHit = mKickMiss = null;
            mDrumHitByLane = mDrumMissByLane = mCymbalHitByLane = mCymbalMissByLane = null;
            mAccentRing = mGhostRing = mSnareStripe = mBellDot = null;
            gDrumDisc = gCymbalGem = gKickBar = null;
            gAccentRing = gGhostRing = gSnareStripe = gBellDot = gFlamGrace = null;
            gOpenRing = mOpenRing = null;
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
            _bloomDispose();
            _disposeFxObjects();
            _disposeEnv();
            _bgTeardownStyle();
            _removeFxCanvas();
            // HUD cleanup lives here (not only destroy): init() re-runs
            // teardown() for renderer re-initialization, possibly against a
            // different canvas — a stale _hudEl would both linger in the old
            // parent and make the next _injectHud() an early-return no-op.
            _removeHud();
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
            if (gOpenRing) gOpenRing.dispose();
            if (mOpenRing) mOpenRing.dispose();
            if (ren) ren.dispose();
            // Floor + hit-bar resources (tracked since the themes PR — they
            // previously leaked across kit-change scene rebuilds).
            if (mFloor) mFloor.dispose();
            if (_gFloor) _gFloor.dispose();
            if (_hitBarMat) _hitBarMat.dispose();
            if (_gHitBar) _gHitBar.dispose();
            scene = cam = ren = lights = laneGroup = kitMapGroup = notesGroup = null;
            ambLight = dirLight = mFloor = _gFloor = _hitBarMat = _gHitBar = null;
            mDrumByLane = mCymbalByLane = mKick = mKickHit = mKickMiss = null;
            mDrumHitByLane = mDrumMissByLane = mCymbalHitByLane = mCymbalMissByLane = null;
            mAccentRing = mGhostRing = mSnareStripe = mBellDot = null;
            gDrumDisc = gCymbalGem = gKickBar = null;
            gAccentRing = gGhostRing = gSnareStripe = gBellDot = gFlamGrace = null;
            gOpenRing = mOpenRing = null;
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
                fx = readFxSettings();
                // Persisted string settings refresh here too — a theme saved
                // while no instance was listening must not come up stale on a
                // later init().
                _theme = readThemeSetting();
                _bgStyle = readBgStyleSetting();

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
                    // Re-apply size now that this instance is counted in
                    // _instances: the applySize above ran before the add, so
                    // its splitscreen DPR check (size > 1) undercounted — the
                    // second panel of a splitscreen mount would otherwise keep
                    // full 2x DPR until some later resize. The already-mounted
                    // panel is corrected by the host's own layout resize when
                    // the split activates (panels change box size), same as on
                    // split teardown.
                    if (_instances.size > 1 || _ssActive()) {
                        applySize(highwayCanvas.clientWidth, highwayCanvas.clientHeight);
                    }
                    _midiInit();
                    _synthInit();
                    _midiResume();

                    _injectHud();

                    _isReady = true;
                });
            },

            draw(bundle) {
                if (!_isReady || !ren || !scene || !cam) return;
                // Host adaptive quality: consume bundle.renderScale like
                // highway_3d — the host lowers it under GPU load ("Quality"
                // + "Min res" controls) and applySize folds it into the DPR.
                const newScale = (bundle && bundle.renderScale) || 1;
                if (newScale !== _renderScale) {
                    _renderScale = newScale;
                    applySize(highwayCanvas.clientWidth, highwayCanvas.clientHeight);
                }
                // Keep the render matched to the highway canvas's real box
                // (PORTED FROM highway_3d — keep in sync). Two drifts to catch:
                //  1. Backing store (canvas.width/height) changed out from under
                //     us — the splitscreen hw.resize override resizes the element
                //     but never calls renderer.resize().
                //  2. The CSS box (clientWidth/Height) drifted while the backing
                //     store held — e.g. the flex #highway box settling after a
                //     fullscreen transition, with no backing-store change and no
                //     resize() call, so branch 1 never fires. Without this the
                //     drum/keys panels stay framed for the pre-fullscreen size.
                if (highwayCanvas) {
                    const _bsChanged = highwayCanvas.width !== _lastHwW
                        || highwayCanvas.height !== _lastHwH;
                    _boxCheckCountdown = (_boxCheckCountdown + 1) % 10;
                    if (_bsChanged || _boxCheckCountdown === 0) {
                        const _bw = highwayCanvas.clientWidth | 0;
                        const _bh = highwayCanvas.clientHeight | 0;
                        if (_bsChanged) {
                            _lastHwW = highwayCanvas.width;
                            _lastHwH = highwayCanvas.height;
                            if (_bw > 0 && _bh > 0) applySize(_bw, _bh);
                        } else if (_bw > 0 && _bh > 0 &&
                                (Math.abs(_bw - _appliedW) > 1 || Math.abs(_bh - _appliedH) > 1)) {
                            applySize(_bw, _bh);
                        }
                    }
                }
                rebuildNotes(bundle);
                // Wall-clock FX step (sparks, kick pulse) — decoupled from
                // song time so effects keep settling while paused/seeking.
                {
                    const nowMs = performance.now();
                    const fdt = _fxLastWall === 0 ? 1 / 60 : Math.min(0.05, (nowMs - _fxLastWall) / 1000);
                    _fxLastWall = nowMs;
                    _sparkUpdate(fdt);
                    // Background ambience: advance the active style with the
                    // audio bands (zeros when reactivity is off). Uses this
                    // block's fdt — recomputing from _fxLastWall after the
                    // line above would read ~0 and freeze the animation.
                    if (_bgState && _bgState.s && BG_STYLES[_bgState._style]) {
                        const bands = fx.bgReactive ? _bgReadBands() : BG_ZERO_BANDS;
                        try {
                            BG_STYLES[_bgState._style].update(_bgState.s, bands, fdt, nowMs / 1000);
                        } catch (_) { /* visual-only */ }
                    }
                    // Kick pulse decays each frame; it drives the floor flash and,
                    // via applyCamera(), the camera Y dip.
                    if (_kickPulse > 0.001) {
                        _kickPulse *= Math.exp(-fdt * 7);
                        if (_floorFlash) _floorFlash.material.opacity = 0.25 * _kickPulse * fx.hitFx;
                    } else if (_kickPulse !== 0) {
                        _kickPulse = 0;
                        if (_floorFlash) _floorFlash.material.opacity = 0;
                    }
                    // Write the camera every frame: static base pose + kick dip +
                    // Camera Director free-cam offsets (per-panel-aware).
                    applyCamera();
                }
                // Approach highlight: raise each lane stripe toward its next
                // note (accumulated by the rebuildNotes walk above).
                for (let i = 0; i < laneStripeMats.length; i++) {
                    laneStripeMats[i].opacity = _stripeBaseOpacity() + 0.28 * (_laneProx[i] || 0) * fx.hitFx;
                }
                _applyLaneFlashes();
                _refreshHud();
                if (fx.scoreFx) { _ensureFxCanvas(); _drawScoreFx(); }
                else if (_fxCtx && _fxCanvas && _fxCanvas._dirty) {
                    _fxCtx.clearRect(0, 0, _fxCanvas.width, _fxCanvas.height);
                    _fxCanvas._dirty = false;
                }
                // Bloom path (PORTED FROM highway_3d): composer + ACES tone
                // mapping when enabled and single-instance; direct render
                // otherwise (including the frames while addons stream in).
                const comp = (fx.bloom && _instances.size === 1 && !_ssActive()) ? _bloomEnsure() : null;
                if (comp) {
                    const w = highwayCanvas.clientWidth | 0, h = highwayCanvas.clientHeight | 0;
                    if (w > 0 && h > 0 && (w !== _bloomW || h !== _bloomH)) {
                        comp.setSize(w, h); _bloomW = w; _bloomH = h;
                    }
                    if (ren.toneMapping !== T.ACESFilmicToneMapping) ren.toneMapping = T.ACESFilmicToneMapping;
                    comp.render();
                } else {
                    if (ren.toneMapping !== T.NoToneMapping) ren.toneMapping = T.NoToneMapping;
                    ren.render(scene, cam);
                }
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
                teardown();   // includes _removeHud()
                // Instances are reused across songs (destroy() → init()); stale
                // applied/backing dims would suppress the first reframe of the
                // next song (PORTED FROM highway_3d).
                _lastHwW = 0; _lastHwH = 0;
                _appliedW = 0; _appliedH = 0;
                highwayCanvas = null;
            },
            // Exposed for module-level MIDI router. The receiver runs on
            // every note-on dispatched to _activeInstance.
            _handleDrumHit,
            // Headless FX-state probe for window.__drumHwTest — reports
            // whether sparks are live, the strongest lane-flash opacity, and
            // the kick-pulse envelope so tests can assert the FX pipeline
            // without pixel-diffing a scrolling scene.
            _fxProbe() {
                let maxFlash = 0;
                for (const q of _laneFlashQuads) {
                    if (q && q.material.opacity > maxFlash) maxFlash = q.material.opacity;
                }
                if (_kickFlashQuad && _kickFlashQuad.material.opacity > maxFlash) {
                    maxFlash = _kickFlashQuad.material.opacity;
                }
                let popsLive = 0;
                for (const pop of _scorePops) if (pop.active) popsLive++;
                return {
                    sparksLive: !!(_sparkPts && _sparkPts.visible),
                    maxFlash,
                    kickPulse: _kickPulse,
                    flashCount: _laneFlashes.length,
                    bgStyle: _bgState ? _bgState._style : null,
                    bgLive: !!(_bgState && _bgState.s),
                    popsLive,
                };
            },
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
    // Pure helpers exposed for the node:test suite (tests/ — screen.js is
    // vm-loaded with no DOM/WebGL; everything here must stay side-effect
    // free to call).
    window.slopsmithViz_drum_highway_3d.__test = {
        _variantForHit,
        _classifyTiming,
        readFxSettings,
        readThemeSetting,
        readBgStyleSetting,
        _bgThemeColors,
        BG_THEMES,
        BG_STYLE_IDS,
        FX_DEFAULTS,
        MIDI_TO_PIECE,
        HIT_TOLERANCE_S,
    };

    // Headless verification hook (keys __keysHwTest pattern): lets
    // Playwright fire synthetic pad hits through the full hit-detection +
    // FX path without a physical MIDI kit, and read the live FX state back
    // (the demo pattern scrolls every frame, so pixel-diff assertions can't
    // distinguish FX from scroll — this probe can).
    window.__drumHwTest = {
        injectHit(midiNote, velocity) {
            if (_activeInstance && typeof _activeInstance._handleDrumHit === 'function') {
                _activeInstance._handleDrumHit(midiNote, velocity == null ? 100 : velocity);
            }
        },
        probe() {
            return (_activeInstance && typeof _activeInstance._fxProbe === 'function')
                ? _activeInstance._fxProbe() : null;
        },
    };
})();
