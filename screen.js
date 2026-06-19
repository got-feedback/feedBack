// Keys Highway 3D — RS+-style falling-note piano highway.
//
// Notation-format-fed (sloppak-spec §5.3): consumes the `notation_info` +
// `notation_measures` highway-WS stream over a private per-instance socket
// (same pattern as Staff View) and flattens measure → staff → voice → beat →
// note into a falling-note list `{midi, t, durSec, hand}`. No guitar-wire
// `midi = s*24+f` indirection — that legacy path stays with the 2D piano
// plugin.
//
// Visual contract is the frame analysis on slopsmith#824 (RS+ reference):
// 3D perspective highway to a vanishing point, notes landing on a real 3D
// keyboard, per-key Synthesia-style PITCH-CLASS colours (hand is only a
// secondary brightness cue), active-range key highlighting with letters,
// a glowing hit-line, bevelled cuboid notes sized by durSec, floating bar
// numbers, and key-depress + flame feedback driven by the LIVE MIDI input
// path (not the chart).
//
// Reuses verbatim from highway_3d / drum_highway_3d: Three.js loader, world
// scale (K), fog and light rig — so the three highways read as one family.

(function () {
    'use strict';

    /* ======================================================================
     *  Verbatim from highway_3d — keep in sync if upstream tweaks them
     * ====================================================================== */

    const THREE_URL = '/static/vendor/three/three.module.min.js';
    const THREE_CDN = 'https://cdn.jsdelivr.net/npm/three@0.170.0/build/three.module.min.js';

    const SCALE = 2.25;
    const K = SCALE / 300;

    const FOG_COLOR = 0x1a1a2e;
    const FOG_START = 850 * K;   // fog pushed past the runway end — far notes stay
    const FOG_END = 1600 * K;    // visible, only the extreme distance fades

    let T = null;
    let threeLoadPromise = null;
    function loadThree() {
        if (!threeLoadPromise) {
            threeLoadPromise = import(THREE_URL)
                .then(mod => { T = mod; return mod; })
                .catch(() => import(THREE_CDN)
                    .then(mod => { T = mod; return mod; })
                    .catch(e => {
                        console.error('[Keys-Hwy3D] Three.js load failed:', e);
                        threeLoadPromise = null;
                        throw e;
                    }));
        }
        return threeLoadPromise;
    }

    /* ======================================================================
     *  Keys-specific constants
     * ====================================================================== */

    // World scroll speed (units / second) — matches the sibling highways.
    const TS = 130 * K;

    // Per-pitch-class colours (Synthesia convention observed in the RS+
    // reference frames: C=red, D=yellow, E=blue, F=light blue-grey, …).
    // Index = midi % 12 (C, C#, D, …, B). Sharps take a dimmed blend of
    // their neighbours so black-key notes stay distinguishable.
    const PITCH_CLASS_COLORS = [
        0xff3030, // C  — red
        0xb04818, // C#
        0xffd400, // D  — yellow
        0x9aa018, // D#
        0x2870ff, // E  — blue
        0x8fb8c8, // F  — light blue-grey
        0x4a7a68, // F#
        0x30c050, // G  — green
        0x807838, // G#
        0xff8020, // A  — orange
        0xa05870, // A#
        0xc050ff, // B  — violet
    ];

    // Hand cue is SECONDARY (slopsmith#824 design call): right hand renders
    // at full brightness, left hand slightly darkened — colour stays the
    // pitch class.
    const HAND_BRIGHTNESS = { rh: 1.0, lh: 0.72 };

    // Note block cross-section height and bevel (world units). The bevel
    // turns the flat slabs into glossy gem-like blocks that catch the light
    // on their edges — the RS+ reference look.
    const NOTE_H = 4 * K;
    const NOTE_BEVEL = 0.55 * K;
    const NOTE_EMISSIVE_BASE = 0.08;   // resting note glow
    const CONSUME_GLOW = 5.0;          // peak glow as a note is eaten at the hit-line
    const LABEL_FADE_DIST = 80 * K;    // note-name fades out over this distance past the hit-line (~0.6s)
    // Gem vertical gradient (bottom shade → top highlight), baked per-vertex into
    // the note geometry so a block reads as a lit 3D gem instead of a flat fill —
    // same approach as the bundled guitar highway_3d (`gNoteGrad`). The ramp is
    // greyscale so one geometry serves every pitch-class colour; the material
    // multiplies its colour by it via vertexColors.
    const GEM_SHADE_BOT = 0.12, GEM_SHADE_TOP = 1.1; // strong gem gradient (top slightly blows toward a highlight)

    const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

    // Key-range padding.
    const RANGE_PAD = 2; // semitones of plain keys beyond the active range

    const NOTATION_CHUNK_TIMEOUT_MS = 20000;

    /* ======================================================================
     *  MIDI scoring constants (mirrors the 2D piano plugin)
     * ====================================================================== */

    // ±100 ms hit window — same as the 2D piano plugin's HIT_TOLERANCE so
    // users get identical timing across both keys visualisations.
    const HIT_TOLERANCE_S = 0.10;

    // Persisted settings, `keys3d_` prefix (piano plugin STORE_KEYS pattern).
    const STORE_KEYS = {
        midiPick: 'keys3d_midi_pick',       // {id, name} JSON (drum-h3d v2 pattern)
        midiChannel: 'keys3d_midi_ch',      // -1 = all channels
        transpose: 'keys3d_transpose',      // semitones added to incoming notes
    };

    // Inputs whose name matches this are skipped by auto-connect (loopbacks
    // and passthroughs, same blocklist as drum_highway_3d).
    const _MIDI_BLOCKLIST_RE = /midi through|^thru\b|^iac\b/i;

    // Key-depress feedback: ~4° tilt around the key's back edge, settled in
    // ~120 ms (exponential spring, tau ≈ 30 ms → 98% in 4τ).
    const KEY_PRESS_ANGLE = Math.PI / 45;
    const KEY_PRESS_TAU_MS = 30;

    // Wrong-note red key flash duration.
    const WRONG_FLASH_MS = 250;

    // Flame flare lifetime + pool size (pooled additive sprites — no
    // per-hit allocations).
    const FLAME_MS = 400;
    const FLAME_POOL_SIZE = 24;

    // Capability identity for the note-detection / audio-input domains.
    const ND_PROVIDER_ID = 'keys-midi';
    const PLUGIN_ID = 'keys_highway_3d';

    /* ======================================================================
     *  Notation data layer (pure — exported via createFactory.__test)
     * ====================================================================== */

    // Derive a beat's sounding duration in seconds from its written duration
    // and the running tempo:  base = (60/tempo) * (4/dur), dots multiply by
    // 2 − 2^(−dot), tuplets by tu[1]/tu[0].
    function beatDurSec(beat, tempo) {
        const dur = Number(beat && beat.dur);
        if (!Number.isFinite(dur) || dur <= 0 || !Number.isFinite(tempo) || tempo <= 0) return null;
        const base = (60 / tempo) * (4 / dur);
        const dot = Number(beat.dot) || 0;
        const dotFactor = 2 - Math.pow(2, -dot);
        const tu = Array.isArray(beat.tu) && beat.tu.length === 2
            && Number(beat.tu[0]) > 0 && Number(beat.tu[1]) > 0
            ? Number(beat.tu[1]) / Number(beat.tu[0]) : 1;
        return base * dotFactor * tu;
    }

    // Flatten accumulated notation (info + measures) into a render-ready,
    // time-sorted note list: [{midi, t, durSec, hand, measureIdx}].
    //
    // - `hand` = staff id (rh/lh per sloppak-spec; any other staff id is
    //   passed through and rendered with rh brightness).
    // - durSec: derived from dur/dot/tu at the running tempo (tempo state
    //   carries across measures; measures may omit `tempo` when unchanged).
    //   Tied notes (`tied: true`) extend the previous sounding note of the
    //   same midi in the same staff+voice instead of emitting a new block.
    //   Fallback when no tempo has been seen: gap to the next onset in the
    //   same voice (or +2s for the final beat).
    //   Sanity clamp: never longer than the gap to the next same-staff
    //   same-midi onset (prevents overlap artifacts from tempo-map drift);
    //   floor at 0.05s so 32nds stay visible.
    // - Grace beats (typed `grace` field) render as ordinary short notes at
    //   their written duration — good enough for a falling-note highway.
    function flattenNotation(measures) {
        const out = [];
        let tempo = null;
        // staff|voice → array of beats (for next-onset fallback + ties)
        const lastNoteByKey = new Map(); // `${staff}|${voice}|${midi}` → out[] index

        // First pass: collect every beat with its staff/voice context in
        // measure order so next-onset lookups can be done per voice.
        const beatsByVoice = new Map(); // `${staff}|${voice}` → [{beat, measure}]
        for (const measure of Array.isArray(measures) ? measures : []) {
            if (!measure || typeof measure !== 'object') continue;
            const staves = measure.staves && typeof measure.staves === 'object' ? measure.staves : {};
            for (const staffId of Object.keys(staves)) {
                const staff = staves[staffId];
                const voices = staff && Array.isArray(staff.voices) ? staff.voices : [];
                for (const voice of voices) {
                    if (!voice || !Array.isArray(voice.beats)) continue;
                    const vid = `${staffId}|${voice.v != null ? voice.v : 1}`;
                    if (!beatsByVoice.has(vid)) beatsByVoice.set(vid, []);
                    const list = beatsByVoice.get(vid);
                    for (const beat of voice.beats) {
                        if (!beat || typeof beat !== 'object') continue;
                        list.push({ beat, measure, staffId, vid });
                    }
                }
            }
        }
        for (const list of beatsByVoice.values()) {
            list.sort((a, b) => (Number(a.beat.t) || 0) - (Number(b.beat.t) || 0));
        }

        // Second pass in global measure order so the tempo state machine sees
        // tempo changes when they happen.
        for (const measure of Array.isArray(measures) ? measures : []) {
            if (!measure || typeof measure !== 'object') continue;
            const mTempo = Number(measure.tempo);
            if (Number.isFinite(mTempo) && mTempo > 0) tempo = mTempo;
            const measureIdx = Number(measure.idx) || 0;
            const staves = measure.staves && typeof measure.staves === 'object' ? measure.staves : {};
            for (const staffId of Object.keys(staves)) {
                const staff = staves[staffId];
                const voices = staff && Array.isArray(staff.voices) ? staff.voices : [];
                for (const voice of voices) {
                    if (!voice || !Array.isArray(voice.beats)) continue;
                    const vid = `${staffId}|${voice.v != null ? voice.v : 1}`;
                    const voiceBeats = beatsByVoice.get(vid) || [];
                    for (const beat of voice.beats) {
                        if (!beat || typeof beat !== 'object' || beat.rest) continue;
                        const t = Number(beat.t);
                        if (!Number.isFinite(t)) continue;
                        const notes = Array.isArray(beat.notes) ? beat.notes : [];
                        let durSec = beatDurSec(beat, tempo);
                        if (durSec == null) {
                            // No tempo seen — fall back to next onset in voice.
                            const i = voiceBeats.findIndex(e => e.beat === beat);
                            const next = i >= 0 ? voiceBeats.slice(i + 1).find(e => !e.beat.rest) : null;
                            durSec = next ? Math.max(0.05, Number(next.beat.t) - t) : 2.0;
                        }
                        for (const note of notes) {
                            if (!note || typeof note !== 'object') continue;
                            const midi = Number(note.midi);
                            if (!Number.isFinite(midi) || midi < 0 || midi > 127) continue;
                            const key = `${vid}|${midi}`;
                            if (note.tied && lastNoteByKey.has(key)) {
                                // Extend the previous sounding note; no new block.
                                const prev = out[lastNoteByKey.get(key)];
                                prev.durSec = Math.max(prev.durSec, (t - prev.t) + durSec);
                                continue;
                            }
                            out.push({
                                midi,
                                t,
                                durSec: Math.max(0.05, durSec),
                                hand: staffId,
                                measureIdx,
                            });
                            lastNoteByKey.set(key, out.length - 1);
                        }
                    }
                }
            }
        }

        out.sort((a, b) => a.t - b.t || a.midi - b.midi);

        // Overlap clamp: a note never rings past the next onset of the same
        // midi on the same hand.
        const lastByHandMidi = new Map();
        for (let i = 0; i < out.length; i++) {
            const note = out[i];
            const key = `${note.hand}|${note.midi}`;
            if (lastByHandMidi.has(key)) {
                const prev = out[lastByHandMidi.get(key)];
                if (prev.t + prev.durSec > note.t) {
                    prev.durSec = Math.max(0.05, note.t - prev.t);
                }
            }
            lastByHandMidi.set(key, i);
        }
        return out;
    }

    // Active key range with padding, clamped to the 88-key piano (A0–C8).
    // `activeLow`/`activeHigh` are the actual chart extremes (the keys that
    // tint, print their letter, and keep bright lanes); `low`/`high` add
    // RANGE_PAD semitones of plain keys around them. Keeping the active span
    // explicit (instead of re-deriving it as low+RANGE_PAD) stays correct at
    // the 88-key clamp edges.
    function keyRange(notes) {
        if (!notes.length) {
            // Empty chart: render a neutral two-octave keyboard with an
            // empty active span (activeLow > activeHigh — nothing lights).
            return { low: 48, high: 72, activeLow: 60, activeHigh: 59 };
        }
        let low = 127, high = 0;
        for (const n of notes) {
            if (n.midi < low) low = n.midi;
            if (n.midi > high) high = n.midi;
        }
        return {
            low: Math.max(21, low - RANGE_PAD),
            high: Math.min(108, high + RANGE_PAD),
            activeLow: low,
            activeHigh: high,
        };
    }

    // Measure markers [{idx, t}] for floating bar numbers.
    function measureMarkers(measures) {
        const out = [];
        for (const m of Array.isArray(measures) ? measures : []) {
            if (!m || typeof m !== 'object') continue;
            const t = Number(m.t);
            const idx = Number(m.idx);
            if (Number.isFinite(t) && Number.isFinite(idx)) out.push({ idx, t });
        }
        return out;
    }

    // Letter printed on a key top (C, C#, D, …) — pure.
    function noteLetter(midi) {
        return NOTE_NAMES[((midi % 12) + 12) % 12];
    }

    // World-space Z of a chart event at song-time `now`: the event sits at
    // `hitZ` exactly when now === eventT, approaching from -Z at `speed`
    // world-units per second. Shared by the note blocks (front edge) and the
    // floating bar-number sprites so they scroll in lockstep.
    function scrollZ(eventT, now, hitZ, speed) {
        return hitZ - (eventT - now) * speed;
    }

    /* ======================================================================
     *  Pure scoring logic (exported via createFactory.__test)
     * ====================================================================== */

    // Dedupe key for a chart note — same convention as the piano plugin's
    // _noteKey (time quantised to ms so float drift can't double-count).
    function noteKey(t, midi) {
        return t.toFixed(3) + '|' + midi;
    }

    // Score/accuracy formula MUST mirror the guitar notedetect path
    // (static/v3/stats-recorder.js, which itself mirrors lib/song_score.py):
    //   accuracy = hits / max(1, hits + misses)         (0..1 fraction)
    //   score    = round(hits * 100 * accuracy)         (monotonic in both)
    function accuracyOf(hits, misses) {
        return hits / Math.max(1, hits + misses);
    }
    function scoreOf(hits, misses) {
        return Math.round(hits * 100 * accuracyOf(hits, misses));
    }

    // Judge a played MIDI note against the time-sorted flattened note list
    // (piano plugin _checkHit port, minus the guitar-wire chord path — keys
    // chords are already flattened to simultaneous notes). Returns the
    // dedupe key of the matched un-hit chart note, or null when the play is
    // a wrong note / outside every window / a duplicate. The caller owns
    // adding the key to hitKeys and all hit/miss bookkeeping.
    function judgeHit(notes, playedMidi, t, hitKeys, tol) {
        if (!Array.isArray(notes) || !notes.length) return null;
        for (const n of notes) {
            if (n.t > t + tol + 0.5) break;
            if (n.t < t - tol - 0.5) continue;
            if (n.midi !== playedMidi) continue;
            if (Math.abs(n.t - t) > tol) continue;
            const key = noteKey(n.t, n.midi);
            if (hitKeys.has(key)) continue;
            return key;
        }
        return null;
    }

    // Missed-note sweep (piano _updateMissedNotes, rebuilt on a monotonic
    // cursor): walk notes whose window has fully elapsed and mark unhit
    // ones as missed. `cursor` ({idx}) makes the sweep O(elapsed) and
    // stall-proof — unlike a fixed look-back tail, a backgrounded tab or a
    // multi-second render hitch can't let elapsed notes slip past
    // uncounted (which would inflate accuracy for the rest of the run).
    // `floor` excludes notes that elapsed before a MIDI device was
    // connected so a mid-song connect doesn't retroactively count
    // everything as missed (the cursor still advances past them). Calls
    // onMiss(note) for each newly-missed note; returns the count.
    function sweepMissed(notes, t, hitKeys, missedKeys, tol, floor, onMiss, cursor) {
        if (!Array.isArray(notes)) return 0;
        const cutoff = t - tol - 0.05;
        let i = cursor ? cursor.idx : 0;
        let count = 0;
        for (; i < notes.length; i++) {
            const n = notes[i];
            if (n.t > cutoff) break;
            // Notes at or before the mid-song connect instant must not be
            // swept retroactively — a device connecting exactly as an onset
            // passes should not count that onset as a miss.
            if (floor != null && n.t <= floor) continue;
            const key = noteKey(n.t, n.midi);
            if (hitKeys.has(key) || missedKeys.has(key)) continue;
            missedKeys.add(key);
            count += 1;
            if (onMiss) onMiss(n);
        }
        if (cursor) cursor.idx = i;
        return count;
    }

    /* ======================================================================
     *  Notation fetch — private per-instance WS (Staff View pattern)
     * ====================================================================== */

    function fetchNotation(filename, arrangementIndex) {
        return new Promise((resolve, reject) => {
            let info = null;
            const measures = [];
            const url = (location.protocol === 'https:' ? 'wss://' : 'ws://')
                + location.host + '/ws/highway/' + encodeURIComponent(filename)
                + '?arrangement=' + encodeURIComponent(arrangementIndex);
            let settled = false;
            const ws = new WebSocket(url);
            const timer = setTimeout(() => {
                if (settled) return;
                settled = true;
                try { ws.close(); } catch (_) {}
                reject(new Error('notation stream timed out'));
            }, NOTATION_CHUNK_TIMEOUT_MS);
            const finish = () => {
                if (settled) return;
                settled = true;
                clearTimeout(timer);
                try { ws.close(); } catch (_) {}
                resolve({ info, measures });
            };
            ws.onmessage = (ev) => {
                let msg = null;
                try { msg = JSON.parse(ev.data); } catch (_) { return; }
                if (!msg || typeof msg !== 'object') return;
                if (msg.error) {
                    if (!settled) {
                        settled = true;
                        clearTimeout(timer);
                        try { ws.close(); } catch (_) {}
                        reject(new Error(String(msg.error)));
                    }
                    return;
                }
                if (msg.type === 'song_info' && !msg.has_notation) {
                    // Nothing to stream for this arrangement.
                    finish();
                    return;
                }
                if (msg.type === 'notation_info') {
                    info = msg;
                    if (!msg.total) finish();
                    return;
                }
                if (msg.type === 'notation_measures') {
                    for (const m of Array.isArray(msg.data) ? msg.data : []) measures.push(m);
                    if (info && measures.length >= (Number(msg.total) || 0)) finish();
                    return;
                }
                // `anchors` streams right after the notation block — if we see
                // it, the notation section is over regardless of count.
                if (msg.type === 'anchors' && info) finish();
            };
            ws.onerror = () => {
                if (settled) return;
                settled = true;
                clearTimeout(timer);
                reject(new Error('notation stream socket error'));
            };
            ws.onclose = () => { if (info) finish(); };
        });
    }

    /* ======================================================================
     *  Texture helpers (CanvasTexture — lazy, cached, never per-frame)
     * ====================================================================== */

    // Key-top letter textures, cached module-level by letter+style. Bounded
    // (12 pitch classes × 2 styles) and shared across factory instances;
    // CanvasTexture GPU copies are re-uploaded transparently after a renderer
    // dispose, so the cache survives teardown safely.
    const _glyphTexCache = new Map();
    function _glyphTexture(letter, dark) {
        const key = letter + '|' + (dark ? 'd' : 'l');
        let tex = _glyphTexCache.get(key);
        if (tex) return tex;
        const cnv = document.createElement('canvas');
        cnv.width = 96;
        cnv.height = 96;
        const ctx = cnv.getContext('2d');
        ctx.clearRect(0, 0, 96, 96);
        ctx.font = '600 48px system-ui, sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillStyle = dark ? '#23232e' : '#e8e8f2';
        ctx.fillText(letter, 48, 50);
        tex = new T.CanvasTexture(cnv);
        tex.anisotropy = 4;
        _glyphTexCache.set(key, tex);
        return tex;
    }

    /* ======================================================================
     *  Web MIDI input (module-scope singleton — one MIDI access per tab)
     *
     *  Port of the piano plugin's MIDI block with drum_highway_3d's 3D-plugin
     *  refinements: id+name saved pick (Chrome regenerates ids per load),
     *  loopback blocklist, init-in-flight dedupe, and the _midiActive gate so
     *  an access promise resolving after destroy() can't wire a dead handler.
     * ====================================================================== */

    function _readStore(k) {
        try { return localStorage.getItem(k); } catch (_) { return null; }
    }
    function _writeStore(k, v) {
        try { localStorage.setItem(k, v); } catch (_) {}
    }

    const _cfg = {
        midiChannel: parseInt(_readStore(STORE_KEYS.midiChannel) || '-1', 10),
        transpose: parseInt(_readStore(STORE_KEYS.transpose) || '0', 10),
    };
    if (!Number.isFinite(_cfg.midiChannel)) _cfg.midiChannel = -1;
    if (!Number.isFinite(_cfg.transpose)) _cfg.transpose = 0;

    // MIDI is sourced from the core `midi-input` capability domain
    // (window.slopsmith.midiInput) rather than a private requestMIDIAccess() —
    // one device-access boundary shared with piano/drums/onboarding.
    let _midiReady = false;      // discover() has run
    let _midiHandle = null;      // live domain session handle (addListener/removeListener)
    let _midiListener = null;    // addListener callback wrapping _midiOnMessage
    let _midiStateSub = false;   // subscribed to midi-input:sources-changed
    let _midiInput = null;       // selected source descriptor { id, name }
    // Set by _midiConnect; the focused instance reads + clears it to skip
    // retroactive miss-counting for notes that elapsed while disconnected.
    let _midiJustConnected = false;
    // Gates the live listener wiring across the async connect.
    let _midiActive = false;
    // Routes incoming MIDI to the focused renderer instance.
    let _activeInstance = null;
    const _instances = new Set();
    let _midiInitInFlight = null;
    let _midiConnectSeq = 0;     // generation guard for async _midiConnect races

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
        if (mi && _midiInput) { try { mi.close({ requester: PLUGIN_ID, logicalSourceKey: _midiInput.key || ('web-midi::' + _midiInput.id) }); } catch (_) { /* best-effort */ } }
        _midiHandle = null;
        _midiListener = null;
        _midiInput = null;
    }

    function _midiInit() {
        if (_midiReady) {
            // Only (re)connect when there's no live session. A repeated init
            // (settings panel open, extra splitscreen instance) must NOT re-enter
            // _midiConnect on an active handle — that tears down the live session
            // and releases held keys for no reason. After a full release the
            // handle is null, so reconnect happens then.
            if (!_midiHandle) _midiAutoConnect();
            return Promise.resolve();
        }
        if (_midiInitInFlight) return _midiInitInFlight;
        const mi = _mi();
        if (!mi) return Promise.resolve();
        _midiInitInFlight = (async () => {
            try {
                const r = await mi.discover();   // permission boundary (requestMIDIAccess, in core)
                // Only latch ready on a successful discovery — a denied/unavailable
                // outcome must NOT latch, or reopening never retries the prompt.
                if (!r || r.outcome !== 'handled') return;
                _midiReady = true;
                // Replug/unplug refresh (replaces MIDIAccess.onstatechange): the
                // domain re-discovers and emits sources-changed; refresh the list
                // and re-run auto-connect so a saved device reattaches.
                if (!_midiStateSub && window.slopsmith && typeof window.slopsmith.on === 'function') {
                    _midiStateSub = true;
                    window.slopsmith.on('midi-input:sources-changed', () => {
                        _midiNotifyDeviceListChanged();
                        if (!_midiInput) _midiAutoConnect(false);   // recovery: saved device only
                    });
                }
                _midiAutoConnect();
                _midiNotifyDeviceListChanged();
            } catch (e) {
                console.warn('[Keys-Hwy3D] MIDI access denied:', e);
            } finally {
                _midiInitInFlight = null;
            }
        })();
        return _midiInitInFlight;
    }

    function _readSavedPick() {
        try {
            const raw = _readStore(STORE_KEYS.midiPick);
            if (raw) {
                const obj = JSON.parse(raw);
                if (obj && typeof obj === 'object') {
                    return { id: String(obj.id || ''), name: String(obj.name || '') };
                }
            }
        } catch (_) {}
        return null;
    }

    function _writeSavedPick(id, name) {
        _writeStore(STORE_KEYS.midiPick, JSON.stringify({ id: id || '', name: name || '' }));
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
        // Explicit "None" opt-out.
        if (saved && saved.id === '' && saved.name === '') return;
        // Exact id match first, then case-insensitive name match (Chrome on
        // Linux regenerates ids per page load), then first non-loopback.
        let target = null;
        if (saved && saved.id) target = inputs.find(i => i.id === saved.id) || null;
        if (!target && saved && saved.name) {
            const n = saved.name.toLowerCase();
            target = inputs.find(i => (i.name || '').toLowerCase() === n) || null;
        }
        // Never honour a saved pick that's a loopback / "Midi Through" port — it
        // carries no device input, so a stale pick silently eats every note. The
        // saved-pick lookups above bypass the block-list; re-apply it here.
        if (target && _MIDI_BLOCKLIST_RE.test(target.name || '')) target = null;
        if (!target) {
            // Skip the substitute ONLY when a saved pick exists but is currently
            // absent (recovery: preserve it, don't clobber on a transient unplug).
            // With no saved pick at all, a fallback is the intended first-hotplug
            // auto-connect — allow it even in recovery.
            const hasSavedPick = !!(saved && (saved.id || saved.name));
            if (!allowFallback && hasSavedPick) return;
            target = inputs.find(i => !_MIDI_BLOCKLIST_RE.test(i.name || '')) || inputs[0];
        }
        _midiConnect(target.id, target.name);
    }

    async function _midiConnect(id, name) {
        // Capture our generation AFTER _midiDetach()'s own bump, so a later
        // detach (device removal / new connect / opt-out) reliably supersedes us.
        _midiDetach();
        const myGen = ++_midiConnectSeq;
        // Connecting (or opting out) invalidates per-instance held state —
        // clear EVERY live instance, not just the focused one, so no panel
        // shows stuck keys when it later takes focus (piano-plugin lesson).
        for (const inst of _instances) {
            if (inst && typeof inst._releaseAllHeld === 'function') inst._releaseAllHeld();
        }
        _writeSavedPick(id || '', name || '');
        const mi = _mi();
        if (id && mi) {
            const src = _midiSources().find(s => s.id === id);
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
                    const res = await mi.open({ requester: PLUGIN_ID, logicalSourceKey: lkey });
                    // A newer _midiConnect (device switch / None / replug) ran while
                    // we awaited open — discard this stale session so we don't wire a
                    // listener for a device the user already moved off of.
                    if (myGen !== _midiConnectSeq) {
                        if (!_midiInput || _midiInput.key !== lkey) { try { mi.close({ requester: PLUGIN_ID, logicalSourceKey: lkey }); } catch (_) { /* best-effort */ } }
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
                    console.warn('[Keys-Hwy3D] MIDI open failed:', e);
                    // Only clear if we're still the current connect — a stale older
                    // open's rejection must not wipe a newer connect's installed
                    // _midiInput/_midiHandle (which would also leak the live handle,
                    // since closes are gated on _midiInput).
                    if (myGen === _midiConnectSeq) _midiInput = null;
                }
            }
        }
        _midiNotifyDeviceListChanged();
    }

    function _midiResume() {
        // Idempotent: a second live renderer instance (splitscreen/overlapping
        // lifetimes) calls this while already active. The domain handle's
        // addListener is Set-backed, but don't rely on the provider de-duping —
        // re-adding here could double-deliver one MIDI note to the focused
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
        if (!data || data.length < 2) return;
        const status = data[0];
        const ch = status & 0x0f;
        if (_cfg.midiChannel >= 0 && ch !== _cfg.midiChannel) return;
        const cmd = status & 0xf0;
        const note = data[1];
        const vel = data.length > 2 ? data[2] : 0;
        // Raw note number goes to the instance; transpose is applied there
        // and remembered per note-on so a transpose change between note-on
        // and note-off can't strand a held key (piano-plugin invariant).
        if (cmd === 0x90 && vel > 0) {
            _activeInstance._handleNoteOn(note, vel);
        } else if (cmd === 0x80 || (cmd === 0x90 && vel === 0)) {
            _activeInstance._handleNoteOff(note);
        } else if (cmd === 0xb0 && note === 64) {
            _activeInstance._handleSustain(vel >= 64);  // CC64 sustain pedal
        }
    }

    function _midiNotifyDeviceListChanged() {
        // Clear a vanished selection so miss-sweeping stops. No note-off
        // can ever arrive for keys that were down when the device went
        // away, so clear held state on every instance too — otherwise
        // those keys stay visually depressed for the rest of the session.
        if (_midiInput && !_midiSources().some(s => s.id === _midiInput.id)) {
            _midiDetach();
            for (const inst of _instances) {
                if (inst && typeof inst._releaseAllHeld === 'function') inst._releaseAllHeld();
            }
        }
        _aiRefreshSources();
        try { window.dispatchEvent(new CustomEvent('keys3d:midi_devices')); } catch (_) {}
    }

    function _midiListInputs() {
        return _midiSources().map(s => ({ id: s.id, name: s.name || s.id }));
    }

    /* ── Built-in synth — hear your playing (WebAudio, offline-safe, no CDN) ── */
    let _synthCtx = null, _synthMaster = null;
    const _synthVoices = new Map();   // midi → { o1, o2, g }
    function _synthResume() {
        if (!_synthCtx) {
            try {
                const AC = window.AudioContext || window.webkitAudioContext;
                if (!AC) return;
                _synthCtx = new AC();
                _synthMaster = _synthCtx.createGain();
                _synthMaster.gain.value = 0.45;
                _synthMaster.connect(_synthCtx.destination);
            } catch (_) { _synthCtx = null; return; }
        }
        if (_synthCtx.state === 'suspended') _synthCtx.resume().catch(() => {});
    }
    // Autoplay policy: an AudioContext can only start from a real user gesture
    // (a MIDI event doesn't count), so prime/resume it on any page input.
    // Guard addEventListener — the test harness provides a bare vm window
    // without DOM event support, and the synth is never invoked there.
    if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
        ['pointerdown', 'keydown'].forEach(ev =>
            window.addEventListener(ev, _synthResume, { passive: true }));
    }
    function _synthNoteOn(midi, vel) {
        _synthResume();
        if (!_synthCtx || _synthCtx.state !== 'running') return;
        if (_synthVoices.has(midi)) _synthNoteOff(midi);
        const now = _synthCtx.currentTime;
        const f = 440 * Math.pow(2, (midi - 69) / 12);
        const o1 = _synthCtx.createOscillator(); o1.type = 'triangle'; o1.frequency.value = f;
        const o2 = _synthCtx.createOscillator(); o2.type = 'sine';     o2.frequency.value = f; o2.detune.value = -6;
        const lp = _synthCtx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = Math.min(9000, f * 7);
        const g = _synthCtx.createGain();
        const peak = 0.12 + 0.16 * (Math.max(1, Math.min(127, vel || 96)) / 127);
        g.gain.setValueAtTime(0.0001, now);
        g.gain.exponentialRampToValueAtTime(peak, now + 0.006);        // attack
        g.gain.exponentialRampToValueAtTime(peak * 0.55, now + 0.35);  // decay → sustain
        o1.connect(lp); o2.connect(lp); lp.connect(g); g.connect(_synthMaster);
        o1.start(now); o2.start(now);
        _synthVoices.set(midi, { o1, o2, g });
    }
    function _synthNoteOff(midi) {
        const v = _synthVoices.get(midi);
        if (!v || !_synthCtx) return;
        _synthVoices.delete(midi);
        const now = _synthCtx.currentTime;
        try {
            v.g.gain.cancelScheduledValues(now);
            v.g.gain.setValueAtTime(Math.max(0.0001, v.g.gain.value), now);
            v.g.gain.exponentialRampToValueAtTime(0.0001, now + 0.22); // release
            v.o1.stop(now + 0.25); v.o2.stop(now + 0.25);
        } catch (_) {}
    }
    function _synthAllOff() {
        for (const midi of Array.from(_synthVoices.keys())) _synthNoteOff(midi);
    }

    /* ── Device/settings control API (settings UI + console) ───────────── */
    window.keysH3dEnsureMidiInit = function () { return _midiInit(); };
    window.keysH3dListMidiInputs = function () { return _midiListInputs(); };
    window.keysH3dGetMidiInputId = function () { return _midiInput ? _midiInput.id : ''; };
    window.keysH3dSetMidiInput = function (id) {
        const src = id ? _midiSources().find(s => s.id === id) : null;
        _midiConnect(id || '', src ? src.name : '');
        return true;
    };
    window.keysH3dGetMidiChannel = function () { return _cfg.midiChannel; };
    window.keysH3dSetMidiChannel = function (ch) {
        const v = parseInt(ch, 10);
        _cfg.midiChannel = Number.isFinite(v) ? Math.max(-1, Math.min(15, v)) : -1;
        _writeStore(STORE_KEYS.midiChannel, String(_cfg.midiChannel));
    };
    window.keysH3dGetTranspose = function () { return _cfg.transpose; };
    window.keysH3dSetTranspose = function (semis) {
        const v = parseInt(semis, 10);
        _cfg.transpose = Number.isFinite(v) ? Math.max(-24, Math.min(24, v)) : 0;
        _writeStore(STORE_KEYS.transpose, String(_cfg.transpose));
    };

    /* ======================================================================
     *  Capability wiring — note-detection + audio-input domains
     *
     *  Everything here is guarded: on servers without the capability hosts
     *  (the spec-009 note-detection owner / the audio-session input owner)
     *  every call degrades to a silent no-op.
     * ====================================================================== */

    function _capsApi() {
        const c = window.slopsmith && window.slopsmith.capabilities;
        return (c && c.version === 1 && typeof c.command === 'function') ? c : null;
    }

    async function _capCommand(domain, name, payload, reason) {
        const caps = _capsApi();
        if (!caps) return null;
        try {
            const r = await caps.command(domain, name, {
                requester: PLUGIN_ID,
                source: PLUGIN_ID,
                origin: 'system',
                reason: reason || ('Keys Highway 3D ' + domain + '.' + name),
                payload: payload || {},
            });
            return (r && r.outcome === 'handled') ? (r.payload || {}) : null;
        } catch (_) { return null; }
    }

    // ── note-detection: this plugin is a Web-MIDI exact-verdict provider ──
    let _ndProviderRegistered = false;
    async function _ndEnsureProvider() {
        if (_ndProviderRegistered) return;
        const p = await _capCommand('note-detection', 'register-provider', {
            providerId: ND_PROVIDER_ID,
            label: 'Keys Highway MIDI',
            kind: 'midi',
            primitives: ['verify.target'],
        }, 'Register the Web MIDI keys detector');
        if (p) _ndProviderRegistered = true;
    }

    // Hit/miss observability events (consumers own judgment; the domain
    // only carries the result — spec 009 doctrine).
    function _ndReport(hit, midi, bindingId) {
        const nd = window.slopsmith && window.slopsmith.noteDetection;
        if (!nd || nd.version !== 1) return;
        try {
            (hit ? nd.reportHit : nd.reportMiss)({
                bindingId: bindingId || null,
                providerId: ND_PROVIDER_ID,
                midi,
                hit,
            });
        } catch (_) { /* observability must never break scoring */ }
    }

    // ── audio-input: enumerate Web MIDI inputs as input sources ─────────
    //
    // Labels are PSEUDONYMIZED ('midi-input-1', …) — device names never
    // leave the plugin (the audio-input contract surfaces labels verbatim
    // in redaction-safe diagnostics).
    let _aiRegisteredCount = 0;

    function _aiSourceSpec(index) {
        const n = index + 1;
        return {
            version: 1,
            providerId: ND_PROVIDER_ID,
            ownerPluginId: PLUGIN_ID,
            sourceId: ND_PROVIDER_ID + ':input-' + n,
            logicalSourceKey: ND_PROVIDER_ID + ':input-' + n,
            label: 'midi-input-' + n,
            labelSafe: true,
            kind: 'instrument',
            availability: 'available',
            operations: ['source.enumerate', 'source.describe', 'source.open', 'source.close'],
            operationHandlers: {
                'source.enumerate': _aiEnumerate,
                'source.describe': _aiDescribe,
                'source.open': _aiOpen,
                'source.close': _aiClose,
            },
        };
    }

    function _aiEnumerate() {
        const sources = _midiListInputs().map((_inp, i) => {
            const spec = _aiSourceSpec(i);
            delete spec.operationHandlers;  // host re-merges handlers per provider
            return spec;
        });
        return { outcome: 'handled', payload: { sources } };
    }

    function _aiDescribe(req) {
        const idx = _aiIndexFor(req && (req.sourceId || req.logicalSourceKey));
        const inputs = _midiListInputs();
        if (idx == null || idx >= inputs.length) {
            return { outcome: 'degraded', reason: 'Unknown MIDI input source' };
        }
        const spec = _aiSourceSpec(idx);
        delete spec.operationHandlers;
        return { outcome: 'handled', payload: { source: spec } };
    }

    function _aiIndexFor(key) {
        const m = /:input-(\d+)$/.exec(String(key || ''));
        if (!m) return null;
        const idx = parseInt(m[1], 10) - 1;
        return (Number.isFinite(idx) && idx >= 0) ? idx : null;
    }

    function _aiOpen(req) {
        // Opening a MIDI source connects the corresponding Web MIDI input.
        const idx = _aiIndexFor(req && (req.sourceId || req.logicalSourceKey));
        const inputs = _midiListInputs();
        if (idx == null || idx >= inputs.length) {
            return { outcome: 'failed', reason: 'MIDI input source is no longer present' };
        }
        _midiConnect(inputs[idx].id, inputs[idx].name);
        return { outcome: 'handled', payload: {} };
    }

    function _aiClose() {
        // Closing the session must actually stop note events flowing —
        // detach the input WITHOUT persisting an opt-out (the saved device
        // pick is user state, not session state, so a later open or a
        // device statechange can re-attach it).
        if (_midiInput || _midiHandle) {
            _midiDetach();
            // No note-off can ever arrive for keys that were down at close,
            // so release held/sustained state on every instance — otherwise
            // those keys stay visually depressed until a later reconnect or
            // teardown. (_midiNotifyDeviceListChanged only releases when the
            // device VANISHED from the source list, which a deliberate
            // close is not, so we release explicitly here.)
            for (const inst of _instances) {
                if (inst && typeof inst._releaseAllHeld === 'function') inst._releaseAllHeld();
            }
            _midiNotifyDeviceListChanged();
        }
        return { outcome: 'handled', payload: {} };
    }

    function _aiRefreshSources() {
        // MIDI is no longer surfaced into the audio-input domain — keys MIDI now
        // lives in the dedicated midi-input domain. Exporting pseudonymized
        // 'midi-input-N' sources here polluted audio-input device pickers (e.g.
        // the onboarding guitar input dropdown) with non-audio entries. Drop any
        // left over from an older build, and register none going forward.
        if (!_capsApi()) return;
        // Iterate a fixed bound over the KNOWN sourceId pattern, not a module-local
        // counter: after an in-page upgrade _aiRegisteredCount is reset to 0, so a
        // count-based loop would skip the prior build's leftovers entirely. The
        // sourceId/logicalSourceKey are the real (unpseudonymized) keys this plugin
        // registered, so unregister resolves them directly; an absent source is a
        // harmless no-op. 32 comfortably exceeds any realistic MIDI input count.
        const MAX_LEGACY_MIDI_SOURCES = 32;
        for (let n = 1; n <= MAX_LEGACY_MIDI_SOURCES; n++) {
            const key = ND_PROVIDER_ID + ':input-' + n;
            _capCommand('audio-input', 'unregister-source',
                { providerId: ND_PROVIDER_ID, sourceId: key, logicalSourceKey: key },
                'MIDI no longer exported to audio-input');
        }
        _aiRegisteredCount = 0;
    }

    /* ======================================================================
     *  Renderer factory
     * ====================================================================== */

    function createFactory() {
        let highwayCanvas = null;
        let ren = null, scene = null, cam = null;
        let _camX = 0, _camTargetX = 0;  // camera x pan-follow state (updateScene)
        let _camZoom = 1, _camTargetZoom = 1;  // adaptive dolly-zoom to the note span
        let notesGroup = null, keyboardGroup = null, markersGroup = null, hitLine = null;
        let noteMeshes = [];   // [{mesh, note, len}]
        let markerSprites = []; // [{sprite, t}]
        let keyMeshes = new Map(); // midi → mesh
        let _isReady = false;
        let _notation = null;  // {notes, range, markers}
        let _loadSeq = 0;
        let _songHandler = null;
        // Per-chart geometry/material caches. One bevelled geometry per
        // (width, length-bucket) and one material per (pitch class, hand)
        // keeps per-note cost down to a mesh; rebuilt per chart, disposed on
        // rebuild + teardown.
        const _noteGeoCache = new Map();
        const _noteMatCache = new Map();
        const _barTexCache = new Map(); // measure idx → CanvasTexture
        let _glowTex = null;            // hit-line gradient (lazy, reused)
        const _hitGlowMats = [];        // additive glow materials pulsed in draw()

        // ── MIDI scoring + live feedback state ──────────────────────────
        let _layoutInfo = null;            // {layout, whiteCount} of current chart
        let _hits = 0, _misses = 0, _streak = 0, _bestStreak = 0;
        const _hitNoteKeys = new Set();    // noteKey(t, midi) of hit chart notes
        const _missedNoteKeys = new Set(); // …and swept-missed ones
        const _sweepCursor = { idx: 0 };   // monotonic miss-sweep position
        let _latestTime = 0;               // song time from the last draw bundle
        let _missFloor = null;             // no retroactive misses before this t
        const _rawToPlayed = new Map();    // raw midi → transposed midi (held)
        const _heldNotes = new Set();      // transposed midis currently down
        const _sustainedNotes = new Set(); // released while CC64 held
        let _sustainOn = false;
        const _keyAnim = new Map();        // midi → true while a key is animating
        const _keyFlash = new Map();       // midi → wall ms of wrong-note flash
        let _lastWallMs = 0;               // wall clock of the previous draw
        let _runMeta = null;               // {filename, arrangement} of this run
        let _recordedThisRun = false;      // /api/stats posted exactly once
        let _ndBindingId = null;           // open note-detection binding
        // Flame pool (built with the scene, reused for every hit).
        let _flamesGroup = null;
        const _flamePool = [];             // [{sprite, mat, start, baseY}]
        let _flameIdx = 0;
        const _flameTexCache = new Map();  // pitch class → CanvasTexture
        let _endHandler = null, _stopHandler = null;

        function _emitDomain(event, payload) {
            const caps = window.slopsmith && window.slopsmith.capabilities;
            if (caps && caps.version === 1 && typeof caps.emitEvent === 'function') {
                try { caps.emitEvent('visualization', event, payload || {}); } catch (_) {}
            }
        }

        function isBlackKey(midi) {
            return [1, 3, 6, 8, 10].includes(((midi % 12) + 12) % 12);
        }

        function noteColor(midi, hand) {
            const base = new T.Color(PITCH_CLASS_COLORS[((midi % 12) + 12) % 12]);
            const b = HAND_BRIGHTNESS[hand] != null ? HAND_BRIGHTNESS[hand] : 1.0;
            base.multiplyScalar(b);
            return base;
        }

        // X position of a key's centre. White keys advance one slot each;
        // black keys sit between, narrower and raised.
        function keyLayout(range) {
            const layout = new Map();
            let whiteIndex = 0;
            for (let midi = range.low; midi <= range.high; midi++) {
                if (isBlackKey(midi)) continue;
                layout.set(midi, { slot: whiteIndex, black: false });
                whiteIndex += 1;
            }
            for (let midi = range.low; midi <= range.high; midi++) {
                if (!isBlackKey(midi)) continue;
                const left = layout.get(midi - 1);
                layout.set(midi, { slot: left ? left.slot + 0.5 : 0, black: true });
            }
            return { layout, whiteCount: whiteIndex };
        }

        const WHITE_W = 12 * K, WHITE_L = 46 * K, WHITE_H = 5 * K;
        const BLACK_W = 6.4 * K, BLACK_L = 28 * K, BLACK_H = 6.5 * K;
        const HIGHWAY_LEN = 1150 * K; // longer runway → ~8.8s of lookahead visible

        // Camera — low, near-telephoto rig (RS+-style): a narrow FOV from low
        // and back gives a deep receding runway and frames ~2 octaves instead
        // of cramming the whole note range full-width. The x position pans to
        // follow the active notes (see updateScene), so wide pieces stay zoomed
        // in on the played hand rather than shrinking every key.
        const CAM_FOV = 40;
        const CAM_Y = 46 * K, CAM_Z = 112 * K;
        const LOOK_Y = 8 * K, LOOK_Z = -165 * K;
        // Pan-follow: a slow ease toward a wide, gently-weighted centroid so the
        // camera glides with the melody instead of darting as notes enter/leave.
        const CAM_PAN_LERP = 0.022;      // per-frame ease (~1s glide @60fps)
        // Adaptive dolly-zoom: frame the FULL pitch span of the incoming notes and
        // centre on its MIDPOINT, so both the lowest (LH) and highest (RH) target
        // keys stay on the keyboard in view. Pull back for wide spreads (both
        // hands), push in for tight passages. Camera dollies along its view ray
        // (offset × zoom). BASE_KEYS is calibrated at the keyboard plane (the
        // binding constraint — it sits in a narrower cone than the far notes), so
        // framing the key span here keeps the target keys visible, not just the notes.
        const CAM_ZOOM_AHEAD = 3.5;      // seconds of notes considered for framing
        const CAM_ZOOM_PAD = 9 * WHITE_W;// total margin beyond the span (~4.5 keys/side)
        const CAM_ZOOM_BASE_KEYS = 11;   // white keys framed at zoom = 1
        const CAM_ZOOM_MIN = 0.9, CAM_ZOOM_MAX = 4.8;
        const CAM_ZOOM_LERP = 0.025;     // smooth zoom ease
        // Per-key approach glow: a key lights in its pitch-class colour ONLY while a
        // note is heading for it, ramping up the closer that note gets to the hit-line.
        const KEY_GLOW_AHEAD = 2.0;      // seconds before the hit-line a key starts to light
        const KEY_GLOW_STRENGTH = 1.15;  // peak emissive intensity (note at the hit-line)

        function keyX(layoutEntry, whiteCount) {
            return (layoutEntry.slot - (whiteCount - 1) / 2) * WHITE_W;
        }

        function buildScene() {
            scene = new T.Scene();
            scene.fog = new T.Fog(FOG_COLOR, FOG_START, FOG_END);

            cam = new T.PerspectiveCamera(CAM_FOV, 1, 0.1, 2000 * K);
            _camX = 0; _camTargetX = 0; _camZoom = 1; _camTargetZoom = 1;
            cam.position.set(0, CAM_Y, CAM_Z);
            cam.lookAt(0, LOOK_Y, LOOK_Z);

            const ambient = new T.AmbientLight(0xffffff, 0.75);
            const dir = new T.DirectionalLight(0xffffff, 1.1);
            dir.position.set(60 * K, 200 * K, 80 * K);
            scene.add(ambient, dir);

            keyboardGroup = new T.Group();
            notesGroup = new T.Group();
            markersGroup = new T.Group();
            _flamesGroup = new T.Group();
            scene.add(keyboardGroup, notesGroup, markersGroup, _flamesGroup);
            _buildFlamePool();
        }

        // Drop every child of a group (recursively — key glyphs are children
        // of their key mesh so depress animation carries them), disposing
        // geometry + material. Cached resources (note geometries/materials,
        // bar/glyph textures) may be disposed again via their caches —
        // three.js dispose() is safe to call more than once. Texture maps
        // held by caches are NOT disposed here.
        function _disposeDeep(obj) {
            while (obj.children && obj.children.length) {
                _disposeDeep(obj.children.pop());
            }
            if (obj.geometry) obj.geometry.dispose();
            if (obj.material && obj.material.dispose) obj.material.dispose();
        }
        function _clearGroup(group) {
            if (!group) return;
            while (group.children.length) {
                _disposeDeep(group.children.pop());
            }
        }

        function _clearNoteCaches() {
            for (const g of _noteGeoCache.values()) g.dispose();
            _noteGeoCache.clear();
            for (const m of _noteMatCache.values()) m.dispose();
            _noteMatCache.clear();
        }

        function _clearBarTextures() {
            for (const t of _barTexCache.values()) t.dispose();
            _barTexCache.clear();
        }

        // Bevelled "gem" geometry for a note block: a rectangular cross-
        // section (w × NOTE_H) extruded along Z for the note's length with a
        // small bevel, so edges catch the light. Cached per (width,
        // length-bucket) — lengths quantised to 0.01 world units so charts
        // share geometries instead of allocating one per note.
        // Rounded-rectangle shape (centred) — reused for gem cross-sections and
        // rounded key footprints.
        function _roundedRectShape(w, h, r) {
            r = Math.max(0, Math.min(r, w / 2 - 0.001, h / 2 - 0.001));
            const hw = w / 2, hh = h / 2, s = new T.Shape();
            s.moveTo(-hw + r, -hh);
            s.lineTo(hw - r, -hh);
            s.quadraticCurveTo(hw, -hh, hw, -hh + r);
            s.lineTo(hw, hh - r);
            s.quadraticCurveTo(hw, hh, hw - r, hh);
            s.lineTo(-hw + r, hh);
            s.quadraticCurveTo(-hw, hh, -hw, hh - r);
            s.lineTo(-hw, -hh + r);
            s.quadraticCurveTo(-hw, -hh, -hw + r, -hh);
            return s;
        }

        // Rounded box (w×h×d, centred) — rounded-rect footprint extruded along
        // height with a bevel, so vertical corners are rounded and the top/bottom
        // edges softened. Core-three only (no RoundedBoxGeometry addon). Used for
        // the piano keys.
        function _roundedBoxGeo(w, h, d, r, bev) {
            bev = Math.max(0.001, Math.min(bev, h / 2 - 0.001));
            const g = new T.ExtrudeGeometry(_roundedRectShape(w, d, r), {
                depth: Math.max(h - 2 * bev, 0.001),
                bevelEnabled: true, bevelThickness: bev, bevelSize: bev,
                bevelSegments: 3, curveSegments: 5,
            });
            g.computeBoundingBox();
            const bz = g.boundingBox;
            g.translate(0, 0, -(bz.min.z + bz.max.z) / 2); // centre the height axis
            g.rotateX(-Math.PI / 2);                       // stand up: height → +Y
            return g;
        }

        function _noteGeometry(w, len) {
            const key = w.toFixed(4) + '|' + len.toFixed(2);
            let geo = _noteGeoCache.get(key);
            if (geo) return geo;
            const bevel = Math.min(NOTE_BEVEL, w * 0.25, len * 0.25, NOTE_H * 0.35);
            const hw = w / 2 - bevel;
            const hh = NOTE_H / 2 - bevel;
            // Lightly rounded cross-section — soften the long edges without the
            // pill/plastic look.
            const shape = _roundedRectShape(2 * hw, 2 * hh, Math.min(hw, hh) * 0.3);
            const depth = Math.max(len - 2 * bevel, bevel);
            geo = new T.ExtrudeGeometry(shape, {
                depth,
                bevelEnabled: true,
                bevelThickness: bevel,
                bevelSize: bevel,
                bevelSegments: 3,
                curveSegments: 5,
            });
            // Extrusion spans z ∈ [-bevel, depth + bevel]; centre it.
            geo.translate(0, 0, -depth / 2);
            // Bake a vertical brightness ramp into vertex colours (bottom shade →
            // top highlight) so the gem reads 3D; the material multiplies its
            // pitch-class colour by this (vertexColors).
            geo.computeBoundingBox();
            const y0 = geo.boundingBox.min.y, yr = (geo.boundingBox.max.y - y0) || 1;
            const pos = geo.attributes.position;
            const cols = new Float32Array(pos.count * 3);
            for (let i = 0; i < pos.count; i++) {
                const t = (pos.getY(i) - y0) / yr;            // 0 bottom .. 1 top
                const v = GEM_SHADE_BOT + (GEM_SHADE_TOP - GEM_SHADE_BOT) * (t * t * (3 - 2 * t));
                cols[i * 3] = cols[i * 3 + 1] = cols[i * 3 + 2] = v;
            }
            geo.setAttribute('color', new T.BufferAttribute(cols, 3));
            _noteGeoCache.set(key, geo);
            return geo;
        }

        // Glossy note material, cached per (pitch class, hand).
        function _noteMaterial(midi, hand) {
            const handKey = HAND_BRIGHTNESS[hand] != null ? hand : 'rh';
            const key = (((midi % 12) + 12) % 12) + '|' + handKey;
            let mat = _noteMatCache.get(key);
            if (mat) return mat;
            const col = noteColor(midi, hand);
            mat = new T.MeshStandardMaterial({
                color: col,
                vertexColors: true,         // multiply colour by the baked gem ramp
                emissive: col,
                emissiveIntensity: NOTE_EMISSIVE_BASE,
                roughness: 0.78,            // matte — kills the glossy "plastic" highlight
                metalness: 0.0,
                transparent: true,
                opacity: 0.8,               // see the keys through the notes
            });
            _noteMatCache.set(key, mat);
            return mat;
        }

        function _barNumberTexture(idx) {
            let tex = _barTexCache.get(idx);
            if (tex) return tex;
            const cnv = document.createElement('canvas');
            cnv.width = 128;
            cnv.height = 64;
            const ctx = cnv.getContext('2d');
            ctx.clearRect(0, 0, 128, 64);
            ctx.font = '600 38px system-ui, sans-serif';
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            ctx.fillStyle = 'rgba(232,232,242,0.88)';
            ctx.fillText(String(idx), 64, 34);
            tex = new T.CanvasTexture(cnv);
            _barTexCache.set(idx, tex);
            return tex;
        }

        // Vertical gradient for the hit-line glow: white-hot core fading to
        // transparent cyan at the edges. Lazy, reused for both glow planes.
        function _glowTexture() {
            if (_glowTex) return _glowTex;
            const cnv = document.createElement('canvas');
            cnv.width = 16;
            cnv.height = 64;
            const ctx = cnv.getContext('2d');
            const grad = ctx.createLinearGradient(0, 0, 0, 64);
            grad.addColorStop(0.0, 'rgba(64,255,208,0)');
            grad.addColorStop(0.5, 'rgba(224,255,248,1)');
            grad.addColorStop(1.0, 'rgba(64,255,208,0)');
            ctx.fillStyle = grad;
            ctx.fillRect(0, 0, 16, 64);
            _glowTex = new T.CanvasTexture(cnv);
            return _glowTex;
        }

        // Vertical flame texture for hit flares: white-hot base fading up
        // into the pitch-class colour, with a horizontal falloff. Cached per
        // pitch class (bounded, 12 entries).
        function _flameTexture(pc) {
            let tex = _flameTexCache.get(pc);
            if (tex) return tex;
            const c = PITCH_CLASS_COLORS[pc];
            const r = (c >> 16) & 0xff, g = (c >> 8) & 0xff, b = c & 0xff;
            const cnv = document.createElement('canvas');
            cnv.width = 64;
            cnv.height = 128;
            const ctx = cnv.getContext('2d');
            const grad = ctx.createLinearGradient(0, 128, 0, 0); // bottom → top
            grad.addColorStop(0.0, 'rgba(255,255,255,1)');       // white-hot base
            grad.addColorStop(0.3, `rgba(${r},${g},${b},0.95)`);
            grad.addColorStop(1.0, `rgba(${r},${g},${b},0)`);
            ctx.fillStyle = grad;
            ctx.fillRect(0, 0, 64, 128);
            const falloff = ctx.createLinearGradient(0, 0, 64, 0);
            falloff.addColorStop(0.0, 'rgba(0,0,0,0)');
            falloff.addColorStop(0.5, 'rgba(0,0,0,1)');
            falloff.addColorStop(1.0, 'rgba(0,0,0,0)');
            ctx.globalCompositeOperation = 'destination-in';
            ctx.fillStyle = falloff;
            ctx.fillRect(0, 0, 64, 128);
            tex = new T.CanvasTexture(cnv);
            _flameTexCache.set(pc, tex);
            return tex;
        }

        function _clearFlameTextures() {
            for (const t of _flameTexCache.values()) t.dispose();
            _flameTexCache.clear();
        }

        // Pooled flame sprites — allocated once with the scene; spawning a
        // flame only mutates a slot.
        function _buildFlamePool() {
            _flamePool.length = 0;
            _flameIdx = 0;
            for (let i = 0; i < FLAME_POOL_SIZE; i++) {
                const mat = new T.SpriteMaterial({
                    map: _flameTexture(0),
                    transparent: true,
                    depthWrite: false,
                    blending: T.AdditiveBlending,
                });
                const sprite = new T.Sprite(mat);
                sprite.visible = false;
                _flamesGroup.add(sprite);
                _flamePool.push({ sprite, mat, start: -1, baseY: 0 });
            }
        }

        function _spawnFlame(midi, wallNow) {
            if (!_layoutInfo || !_flamePool.length) return;
            const entry = _layoutInfo.layout.get(midi);
            if (!entry) return;
            const slot = _flamePool[_flameIdx];
            _flameIdx = (_flameIdx + 1) % _flamePool.length;
            slot.mat.map = _flameTexture(((midi % 12) + 12) % 12);
            slot.start = wallNow;
            slot.baseY = entry.black ? BLACK_H + WHITE_H * 0.6 : WHITE_H;
            slot.sprite.position.x = keyX(entry, _layoutInfo.whiteCount);
            slot.sprite.position.z = -WHITE_L / 2; // at the hit-line
            slot.sprite.visible = true;
        }

        function buildKeyboardAndHighway() {
            _clearGroup(keyboardGroup);
            _hitGlowMats.length = 0;
            keyMeshes = new Map();
            _keyAnim.clear();
            _keyFlash.clear();
            const range = _notation.range;
            const { layout, whiteCount } = keyLayout(range);
            _layoutInfo = { layout, whiteCount };
            const totalW = whiteCount * WHITE_W;
            const floorW = totalW + 8 * WHITE_W;
            const hitZ = -WHITE_L / 2;

            // Highway floor receding to the vanishing point.
            const floor = new T.Mesh(
                new T.PlaneGeometry(floorW, HIGHWAY_LEN),
                new T.MeshStandardMaterial({ color: 0x141422, roughness: 0.9 }),
            );
            floor.rotation.x = -Math.PI / 2;
            floor.position.set(0, -0.5 * K, -HIGHWAY_LEN / 2 + WHITE_L);
            keyboardGroup.add(floor);

            // Active-range pop: dim the scroll lanes outside the active span
            // with subtle dark overlays so the playable range reads bright.
            let activeMinX = Infinity, activeMaxX = -Infinity;
            for (const [midi, entry] of layout) {
                if (midi < range.activeLow || midi > range.activeHigh) continue;
                const w = entry.black ? BLACK_W : WHITE_W;
                const x = keyX(entry, whiteCount);
                if (x - w / 2 < activeMinX) activeMinX = x - w / 2;
                if (x + w / 2 > activeMaxX) activeMaxX = x + w / 2;
            }
            if (activeMinX < activeMaxX) {
                const laneLen = HIGHWAY_LEN - WHITE_L;
                const dimMat = new T.MeshBasicMaterial({
                    color: 0x000000, transparent: true, opacity: 0.42, depthWrite: false,
                });
                const zones = [
                    [-floorW / 2, activeMinX],
                    [activeMaxX, floorW / 2],
                ];
                for (const [x0, x1] of zones) {
                    const zoneW = x1 - x0;
                    if (zoneW <= 0.01 * K) continue;
                    const dim = new T.Mesh(new T.PlaneGeometry(zoneW, laneLen), dimMat);
                    dim.rotation.x = -Math.PI / 2;
                    dim.position.set((x0 + x1) / 2, 0.1 * K, hitZ - laneLen / 2);
                    keyboardGroup.add(dim);
                }
            }

            // Lane guides: a faint colour strip running up the runway from each
            // active key, in that key's pitch-class colour. A falling note shares
            // its target key's colour, so the player can trace it straight down
            // its lane to the right key even when it sits near the frame edge.
            //
            // The lanes sit at the NOTES' travel height (coplanar), not on the
            // deck. The camera looks down the y–z plane, so a note elevated above
            // an on-floor lane projects to a different screen column (parallax) —
            // putting the lane at the note's y makes the note ride exactly in its
            // lane, perfectly aligned with the lane and its key.
            const guideLen = HIGHWAY_LEN - WHITE_L;
            const laneY = WHITE_H + NOTE_H / 2 + 0.5 * K; // == white-note travel height
            for (const [midi, entry] of layout) {
                if (midi < range.activeLow || midi > range.activeHigh) continue;
                if (entry.black) continue; // one strip per semitone-slot lands on whites
                const gmat = new T.MeshBasicMaterial({
                    color: noteColor(midi, 'rh'), transparent: true,
                    opacity: 0.16, depthWrite: false,
                });
                const strip = new T.Mesh(new T.PlaneGeometry(WHITE_W * 0.84, guideLen), gmat);
                strip.rotation.x = -Math.PI / 2;
                strip.position.set(keyX(entry, whiteCount), laneY, hitZ - guideLen / 2);
                keyboardGroup.add(strip);
                // Thin brighter rails at the lane edges for crisp separation.
                const railMat = new T.MeshBasicMaterial({
                    color: 0x2a2a3e, transparent: true, opacity: 0.5, depthWrite: false,
                });
                const rail = new T.Mesh(new T.PlaneGeometry(0.6 * K, guideLen), railMat);
                rail.rotation.x = -Math.PI / 2;
                rail.position.set(keyX(entry, whiteCount) - WHITE_W / 2, laneY + 0.05 * K, hitZ - guideLen / 2);
                keyboardGroup.add(rail);
            }

            // Keys (whites first so blacks overlay). Geometries are shared
            // across keys; materials are per key (range tint / depress +
            // wrong-flash feedback are per-key state). The geometry origin
            // is translated to the key's BACK edge so the live MIDI key-
            // depress animation can pivot there (rotation.x > 0 tips the
            // front of the key down, like a real piano action).
            const whiteGeo = _roundedBoxGeo(WHITE_W * 0.94, WHITE_H, WHITE_L, WHITE_W * 0.05, WHITE_H * 0.1);
            whiteGeo.translate(0, 0, WHITE_L / 2);
            const blackGeo = _roundedBoxGeo(BLACK_W, BLACK_H, BLACK_L, BLACK_W * 0.08, BLACK_H * 0.06);
            blackGeo.translate(0, 0, BLACK_L / 2);
            const whiteGlyphGeo = new T.PlaneGeometry(WHITE_W * 0.72, WHITE_W * 0.72);
            const blackGlyphGeo = new T.PlaneGeometry(BLACK_W * 0.96, BLACK_W * 0.96);
            for (const [midi, entry] of layout) {
                const black = entry.black;
                const inRange = midi >= range.activeLow && midi <= range.activeHigh;
                const material = new T.MeshStandardMaterial({
                    color: black ? 0x070708 : 0xe8e8ee,
                    // Pitch-class colour preset on emissive but OFF at rest — the key
                    // is neutral until a note approaches, when updateScene ramps the
                    // intensity up by proximity.
                    emissive: noteColor(midi, 'rh'),
                    emissiveIntensity: 0,
                    roughness: 0.55,
                });
                const mesh = new T.Mesh(black ? blackGeo : whiteGeo, material);
                // Positions place the geometry where the old centred boxes
                // sat: the mesh origin is the back-edge centre.
                mesh.position.set(
                    keyX(entry, whiteCount),
                    black ? BLACK_H / 2 + WHITE_H * 0.1 : WHITE_H / 2,
                    black ? (WHITE_L - BLACK_L) / 2 - WHITE_L / 2 - BLACK_L / 2 - 4 * K : -WHITE_L / 2,
                );
                mesh.userData.midi = midi;
                // Wrong-note flash restore state.
                mesh.userData.origEmissive = material.emissive.getHex();
                mesh.userData.origEmissiveIntensity = material.emissiveIntensity;
                keyboardGroup.add(mesh);
                keyMeshes.set(midi, mesh);

                if (inRange) {
                    // RS+-style letter printed on the key top — dark text
                    // near the front edge of whites, light text on blacks.
                    // The glyph is a CHILD of the key mesh so it rides the
                    // depress animation (positions are key-local).
                    const glyph = new T.Mesh(
                        black ? blackGlyphGeo : whiteGlyphGeo,
                        new T.MeshBasicMaterial({
                            map: _glyphTexture(noteLetter(midi), !black),
                            transparent: true,
                            depthWrite: false,
                        }),
                    );
                    glyph.rotation.x = -Math.PI / 2;
                    glyph.position.set(
                        0,
                        black ? BLACK_H / 2 + 0.15 * K : WHITE_H / 2 + 0.15 * K,
                        black ? BLACK_L / 2 : WHITE_L - WHITE_W * 0.55,
                    );
                    mesh.add(glyph);
                }
            }

            // Glowing hit-line: a bright core bar plus two additive gradient
            // planes (a flat wash on the deck and an upright curtain) pulsed
            // gently in draw(). No postprocessing — just cheap blending.
            const lineW = totalW + 4 * WHITE_W;
            hitLine = new T.Mesh(
                new T.BoxGeometry(lineW, 1.2 * K, 1.2 * K),
                new T.MeshBasicMaterial({ color: 0xb8fff0 }),
            );
            hitLine.position.set(0, WHITE_H + 0.5 * K, hitZ);
            keyboardGroup.add(hitLine);

            const flatGlowMat = new T.MeshBasicMaterial({
                map: _glowTexture(), transparent: true, opacity: 0.85,
                blending: T.AdditiveBlending, depthWrite: false,
            });
            const flatGlow = new T.Mesh(new T.PlaneGeometry(lineW, 16 * K), flatGlowMat);
            flatGlow.rotation.x = -Math.PI / 2;
            flatGlow.position.set(0, 0.2 * K, hitZ - 5 * K);
            keyboardGroup.add(flatGlow);

            const upGlowMat = flatGlowMat.clone();
            const upGlow = new T.Mesh(new T.PlaneGeometry(lineW, 7 * K), upGlowMat);
            upGlow.position.set(0, WHITE_H + 1.5 * K, hitZ + 0.1 * K);
            keyboardGroup.add(upGlow);
            _hitGlowMats.push(flatGlowMat, upGlowMat);
        }

        function buildNoteMeshes() {
            _clearGroup(notesGroup);
            _clearNoteCaches();
            noteMeshes = [];
            const range = _notation.range;
            const { layout, whiteCount } = keyLayout(range);
            for (const note of _notation.notes) {
                const entry = layout.get(note.midi);
                if (!entry) continue;
                const len = Math.max(4 * K, note.durSec * TS);
                const w = (entry.black ? BLACK_W : WHITE_W * 0.94) * 0.9;
                // Clone per note so each can glow independently while being consumed.
                const mesh = new T.Mesh(_noteGeometry(w, len), _noteMaterial(note.midi, note.hand).clone());
                mesh.position.x = keyX(entry, whiteCount);
                mesh.position.y = (entry.black ? BLACK_H + WHITE_H : WHITE_H) + NOTE_H / 2 + 0.5 * K;
                mesh.visible = false;
                notesGroup.add(mesh);
                // Note-name label: a camera-facing sprite (readable at this low camera
                // angle, unlike a flat top decal). Lives in notesGroup as a sibling —
                // NOT a child of the note mesh — so the consumption z-clip never
                // squashes the letter. Positioned per frame in updateScene.
                const label = new T.Sprite(new T.SpriteMaterial({
                    map: _glyphTexture(noteLetter(note.midi), false),
                    transparent: true, depthWrite: false,
                }));
                label.scale.set(6.5 * K, 6.5 * K, 1);
                label.visible = false;
                notesGroup.add(label);
                noteMeshes.push({ mesh, note, len, label });
            }
        }

        // Floating bar numbers: one camera-facing sprite per measure marker,
        // parked on the left shoulder of the highway and scrolled with the
        // notes in draw().
        function buildMarkerSprites() {
            _clearGroup(markersGroup);
            _clearBarTextures();
            markerSprites = [];
            const { whiteCount } = keyLayout(_notation.range);
            const totalW = whiteCount * WHITE_W;
            for (const marker of _notation.markers) {
                const mat = new T.SpriteMaterial({
                    map: _barNumberTexture(marker.idx),
                    transparent: true,
                    depthWrite: false,
                    opacity: 0.9,
                });
                const sprite = new T.Sprite(mat);
                sprite.scale.set(16 * K, 8 * K, 1);
                sprite.position.set(-totalW / 2 - 2.2 * WHITE_W, 3 * K, 0);
                sprite.visible = false;
                markersGroup.add(sprite);
                markerSprites.push({ sprite, t: marker.t });
            }
        }

        /* ── MIDI event handlers (called by module _midiOnMessage) ───────
         *
         * Receive the RAW midi note from the device; transpose is applied
         * here and the result stored under the raw note so note-off finds
         * it even if the transpose changed in between (piano invariant).
         */

        function _handleNoteOn(rawMidi, velocity, tOverride) {
            if (rawMidi < 0 || rawMidi > 127) return;
            const played = rawMidi + _cfg.transpose;
            if (played < 0 || played > 127) return;
            _rawToPlayed.set(rawMidi, played);
            // Retrigger while the pedal is down: the key is physically held
            // again, so it's no longer merely pedal-sustained. Without this,
            // pedal-up would un-depress (and stop tracking) a key the player
            // is still holding. _heldNotes is the visual-depress set (physical
            // OR pedal-sustained); _sustainedNotes is the pedal-only subset.
            _sustainedNotes.delete(played);
            _heldNotes.add(played);
            // Key depress starts immediately on the LIVE input path —
            // feedback must not wait for hit judgment.
            if (keyMeshes.has(played)) _keyAnim.set(played, true);
            _synthNoteOn(played, velocity);   // hear the played note
            _checkHit(played, Number.isFinite(tOverride) ? tOverride : _latestTime);
        }

        function _handleNoteOff(rawMidi) {
            if (rawMidi < 0 || rawMidi > 127) return;
            const played = _rawToPlayed.get(rawMidi);
            if (played == null) return; // stray note-off (cleared state)
            _rawToPlayed.delete(rawMidi);
            if (_sustainOn) {
                _sustainedNotes.add(played);
                return;   // pedal held → keep sounding (synth released on pedal-up)
            }
            _heldNotes.delete(played);
            _synthNoteOff(played);
        }

        function _handleSustain(down) {
            if (down) {
                _sustainOn = true;
            } else {
                _sustainOn = false;
                for (const midi of _sustainedNotes) { _heldNotes.delete(midi); _synthNoteOff(midi); }
                _sustainedNotes.clear();
            }
        }

        function _releaseAllHeld() {
            _heldNotes.clear();
            _sustainedNotes.clear();
            _rawToPlayed.clear();
            _sustainOn = false;
            _synthAllOff();
        }

        /* ── Hit detection / scoring (piano _checkHit port) ───────────── */

        function _checkHit(playedMidi, t) {
            if (!_notation || !_notation.notes.length) return;
            const key = judgeHit(_notation.notes, playedMidi, t, _hitNoteKeys, HIT_TOLERANCE_S);
            const wall = performance.now();
            if (key) {
                _hitNoteKeys.add(key);
                _hits++;
                _streak++;
                if (_streak > _bestStreak) _bestStreak = _streak;
                _keyFlash.delete(playedMidi); // a hit cancels a lingering red
                _spawnFlame(playedMidi, wall);
                _ndReport(true, playedMidi, _ndBindingId);
            } else {
                _misses++;
                _streak = 0;
                if (keyMeshes.has(playedMidi)) _keyFlash.set(playedMidi, wall);
                _ndReport(false, playedMidi, _ndBindingId);
            }
        }

        function _resetScoring() {
            _hits = 0; _misses = 0; _streak = 0; _bestStreak = 0;
            _hitNoteKeys.clear();
            _missedNoteKeys.clear();
            _sweepCursor.idx = 0;
            _missFloor = null;
            _keyFlash.clear();
            // Fresh chart, fresh timing cursor — a note-on landing between
            // the new chart build and its first draw() must be judged at
            // the new run's start, not against the previous song's time.
            _latestTime = 0;
        }

        // Swept-miss callback — kept as a named function so the per-frame
        // sweep passes a stable reference (no closure allocation in draw()).
        function _onSweptMiss(note) {
            _ndReport(false, note.midi, _ndBindingId);
        }

        /* ── End-of-run stats POST (exactly once per run) ──────────────── */

        async function _finalizeRun() {
            if (_recordedThisRun) return;
            // When the note-detection domain is present, the consumer (notedetect
            // → core stats-recorder) owns stats + progression, posting/awarding
            // from our reported verdicts. Defer to it so we don't double-count
            // the play or double-award feedback points.
            if (window.slopsmith && window.slopsmith.noteDetection && window.slopsmith.noteDetection.version === 1) {
                _recordedThisRun = true;
                return;
            }
            if (!_runMeta || !_runMeta.filename) return;
            if (_hits + _misses <= 0) return; // nothing was scored this run
            _recordedThisRun = true;
            const accuracy = accuracyOf(_hits, _misses);
            const body = {
                filename: _runMeta.filename,
                arrangement: _runMeta.arrangement,
                score: scoreOf(_hits, _misses),
                accuracy,
                hits: _hits,
                misses: _misses,
                bestStreak: _bestStreak,
            };
            let resp = null;
            try {
                const r = await fetch('/api/stats', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(body),
                });
                resp = await r.json().catch(() => null);
            } catch (_) { /* offline / endpoint absent — non-fatal */ }
            // Fan the outcome out to the progression core (guarded — older
            // servers have neither the field nor the host).
            try { window.v3Progression?.notify(resp ? resp.progression : null); } catch (_) {}
        }

        /* ── Live feedback animation (no per-frame allocations) ────────── */

        function _animateFeedback(wallNow) {
            const dt = Math.min(Math.max(wallNow - _lastWallMs, 0), 100);
            _lastWallMs = wallNow;
            // Key depress: exponential spring toward the held/released
            // target angle, pivoting at the back edge (geometry origin).
            const k = 1 - Math.exp(-dt / KEY_PRESS_TAU_MS);
            for (const midi of _keyAnim.keys()) {
                const mesh = keyMeshes.get(midi);
                if (!mesh) { _keyAnim.delete(midi); continue; }
                const target = _heldNotes.has(midi) ? KEY_PRESS_ANGLE : 0;
                const next = mesh.rotation.x + (target - mesh.rotation.x) * k;
                mesh.rotation.x = next;
                if (target === 0 && Math.abs(next) < 0.001) {
                    mesh.rotation.x = 0;
                    _keyAnim.delete(midi);
                }
            }
            // Wrong-note red flash, fading back to the key's own emissive.
            for (const [midi, start] of _keyFlash) {
                const mesh = keyMeshes.get(midi);
                if (!mesh) { _keyFlash.delete(midi); continue; }
                const p = (wallNow - start) / WRONG_FLASH_MS;
                if (p >= 1) {
                    mesh.material.emissive.setHex(mesh.userData.origEmissive);
                    mesh.material.emissiveIntensity = mesh.userData.origEmissiveIntensity;
                    _keyFlash.delete(midi);
                } else {
                    mesh.material.emissive.setHex(0xff2020);
                    mesh.material.emissiveIntensity = 0.9 * (1 - p);
                }
            }
            // Flame flares: rise, widen and fade over FLAME_MS.
            for (let i = 0; i < _flamePool.length; i++) {
                const slot = _flamePool[i];
                if (slot.start < 0) continue;
                const age = (wallNow - slot.start) / FLAME_MS;
                if (age >= 1) {
                    slot.start = -1;
                    slot.sprite.visible = false;
                    continue;
                }
                const h = 14 * K * (0.6 + 0.9 * age);
                slot.sprite.scale.set(8 * K * (1 + 0.3 * age), h, 1);
                slot.sprite.position.y = slot.baseY + h / 2;
                slot.mat.opacity = 1 - age;
            }
        }

        function updateScene(now) {
            const hitZ = -WHITE_L / 2;

            // Pan the camera x to follow the active hand: a hit-line-weighted
            // centroid of the notes around `now`. Keeps a ~2-octave window
            // framed and scrolls with the melody, RS+-style, instead of
            // statically framing the whole range.
            let minX = Infinity, maxX = -Infinity;
            for (const { mesh, note } of noteMeshes) {
                const dt = note.t - now;
                if (dt < -0.4 || dt > CAM_ZOOM_AHEAD) continue;
                const x = mesh.position.x;
                if (x < minX) minX = x;
                if (x > maxX) maxX = x;
            }
            if (maxX >= minX) {
                // Centre on the span midpoint so the lowest and highest target
                // keys are equidistant and both stay in view; zoom to fit the span.
                _camTargetX = (minX + maxX) / 2;
                const span = (maxX - minX) + CAM_ZOOM_PAD;
                const tz = span / (CAM_ZOOM_BASE_KEYS * WHITE_W);
                _camTargetZoom = Math.max(CAM_ZOOM_MIN, Math.min(CAM_ZOOM_MAX, tz));
            }
            _camX += (_camTargetX - _camX) * CAM_PAN_LERP;
            _camZoom += (_camTargetZoom - _camZoom) * CAM_ZOOM_LERP;
            cam.position.set(_camX, CAM_Y * _camZoom, CAM_Z * _camZoom);
            cam.lookAt(_camX, LOOK_Y * _camZoom, LOOK_Z * _camZoom);

            for (const km of keyMeshes.values()) km.userData.glow = 0;
            for (const { mesh, note, len, label } of noteMeshes) {
                const dt = note.t - now;
                // Key approach-glow: the nearest upcoming note lights its key,
                // stronger the closer it is to the hit-line.
                if (dt >= -0.05 && dt <= KEY_GLOW_AHEAD) {
                    const km = keyMeshes.get(note.midi);
                    if (km) {
                        const p = 1 - dt / KEY_GLOW_AHEAD;
                        if (p > km.userData.glow) km.userData.glow = p;
                    }
                }
                // Note front edge arrives at the hit-line at note.t.
                const z = scrollZ(note.t, now, hitZ, TS) - len / 2;
                const frontZ = z + len / 2;
                const backZ = z - len / 2;
                const past = frontZ - hitZ;

                // Note-name label: full while approaching; once the note starts being
                // consumed, fade out over LABEL_FADE_DIST. Driven by `past` (not the
                // mesh state) so it lingers and fades even after the note is eaten.
                if (label) {
                    if (frontZ < -HIGHWAY_LEN) {
                        label.visible = false;
                    } else if (past <= 0) {
                        label.visible = true;
                        label.material.opacity = 1;
                        label.position.set(mesh.position.x, mesh.position.y + NOTE_H / 2 + 1.6 * K, z);
                    } else {
                        const op = 1 - past / LABEL_FADE_DIST;
                        if (op <= 0) {
                            label.visible = false;
                        } else {
                            label.visible = true;
                            label.material.opacity = op;
                            const rem = Math.max(0, len - past);
                            label.position.set(mesh.position.x, mesh.position.y + NOTE_H / 2 + 1.6 * K, hitZ - rem / 2);
                        }
                    }
                }

                if (frontZ < -HIGHWAY_LEN || backZ > hitZ + 20 * K) {
                    mesh.visible = false;
                    continue;
                }
                mesh.visible = true;
                // True sustain consumption: once the leading edge reaches the
                // hit-line, pin the front there and shorten the note from the front
                // as it's "eaten", while the tail keeps feeding down the runway. The
                // gem geometry has length `len`, so scale Z by remaining/len and
                // recentre on the still-visible [backZ, hitZ] segment.
                if (past <= 0) {
                    if (mesh.scale.z !== 1) mesh.scale.set(1, 1, 1);
                    mesh.position.z = z;
                    if (mesh.material.emissiveIntensity !== NOTE_EMISSIVE_BASE) {
                        mesh.material.emissiveIntensity = NOTE_EMISSIVE_BASE;
                    }
                } else {
                    const remaining = len - past;        // = hitZ - backZ, length still up the runway
                    if (remaining <= 0.02 * K) { mesh.visible = false; continue; }
                    mesh.scale.set(1, 1, remaining / len);
                    mesh.position.z = hitZ - remaining / 2;
                    // Glow as it's eaten — intensifies the more of the note is consumed.
                    const consumed = Math.min(1, past / len);
                    mesh.material.emissiveIntensity =
                        NOTE_EMISSIVE_BASE + (CONSUME_GLOW - NOTE_EMISSIVE_BASE) * (0.45 + 0.55 * consumed);
                }
            }
            // Apply the approach-glow (a wrong-note red flash owns emissive meanwhile).
            for (const [midi, km] of keyMeshes) {
                if (_keyFlash.has(midi)) continue;
                const g = km.userData.glow || 0;
                km.material.emissiveIntensity = g * g * KEY_GLOW_STRENGTH; // ease → pops near the hit-line
            }
            for (const entry of markerSprites) {
                const z = scrollZ(entry.t, now, hitZ, TS);
                if (z < -HIGHWAY_LEN || z > hitZ + 6 * K) {
                    entry.sprite.visible = false;
                    continue;
                }
                entry.sprite.visible = true;
                entry.sprite.position.z = z;
            }
            // Gentle hit-line pulse — two material opacity writes, no
            // allocations.
            const pulse = 0.72 + 0.18 * Math.sin(now * 5.0);
            for (let i = 0; i < _hitGlowMats.length; i++) _hitGlowMats[i].opacity = pulse;

            // Missed-note sweep — only while a MIDI device is connected
            // (without one, every note would count as a miss and corrupt
            // accuracy), and never retroactively across a mid-song connect.
            // Only the focused instance scores: note-ons route solely to
            // _activeInstance, so sweeping misses anywhere else would accrue
            // misses with no possible hits and corrupt that run's stats
            // (splitscreen / overlapping renderer lifetimes).
            // Gate on _midiHandle (the live wired session), NOT _midiInput: the
            // latter is set as soon as a device is picked, but the async mi.open()
            // may still be pending (slow / permission prompt), during which no
            // events can arrive — sweeping then would bank false misses. _midiHandle
            // is truthy only after a handle is opened and wired.
            if (_midiHandle && _notation && _activeInstance === instance) {
                if (_midiJustConnected) {
                    _missFloor = now;
                    _midiJustConnected = false;
                }
                const swept = sweepMissed(
                    _notation.notes, now, _hitNoteKeys, _missedNoteKeys,
                    HIT_TOLERANCE_S, _missFloor, _onSweptMiss, _sweepCursor,
                );
                if (swept) { _misses += swept; _streak = 0; }
            }
            _latestTime = now;
        }

        async function loadNotationForCurrentSong() {
            const song = window.slopsmith && window.slopsmith.currentSong;
            if (!song || !song.filename) return;
            const seq = ++_loadSeq;
            try {
                const { measures } = await fetchNotation(song.filename, song.arrangementIndex != null ? song.arrangementIndex : -1);
                if (seq !== _loadSeq || !_isReady) return; // superseded / torn down
                const notes = flattenNotation(measures);
                _notation = {
                    notes,
                    range: keyRange(notes),
                    markers: measureMarkers(measures),
                };
                buildKeyboardAndHighway();
                buildNoteMeshes();
                buildMarkerSprites();
                // Finalize the OUTGOING run before we clobber its scoring
                // state. The host may emit song:loaded for the next song
                // before the prior run's song:ended/stop (or never emit one
                // for a seamless switch); without this the previous run would
                // post zero times, or worse, post the new song's metadata.
                // _finalizeRun is a no-op when nothing was scored or it
                // already posted, so a normal end→load sequence is unaffected.
                // Not awaited: _finalizeRun latches _recordedThisRun and
                // snapshots the POST body synchronously BEFORE its `await
                // fetch`, so the reset below can't corrupt it — and a slow or
                // hung /api/stats must never block the next chart's load.
                void _finalizeRun();
                // Fresh run: scoring + once-per-run stats latch reset here.
                _resetScoring();
                _recordedThisRun = false;
                _runMeta = {
                    filename: song.filename,
                    arrangement: Number.isFinite(Number(song.arrangementIndex)) ? Number(song.arrangementIndex) : 0,
                };
                _ndOpenBindingForChart(_notation.range, seq);
                _emitDomain('renderer-ready', { providerId: 'keys_highway_3d' });
            } catch (e) {
                console.error('[Keys-Hwy3D] notation load failed:', e);
                _emitDomain('renderer-failed', { providerId: 'keys_highway_3d', reason: 'notation load failed' });
            }
        }

        // Per-song note-detection binding: close the previous one, register
        // the provider (idempotent) and open a binding scoped to this
        // chart's keys range. All guarded — degrades silently when the
        // spec-009 host is absent. `seq` is the chart-load sequence: a
        // rapid song switch can land a stale open-binding response after
        // the next chart is active, which would misattribute hit/miss
        // events and leak the live binding — so the write-back is gated on
        // the same supersession check the notation fetch uses, and a
        // superseded binding is closed instead of stored.
        async function _ndOpenBindingForChart(range, seq) {
            if (_ndBindingId) {
                _capCommand('note-detection', 'close-binding', { bindingId: _ndBindingId },
                    'Song changed — close the previous keys binding');
                _ndBindingId = null;
            }
            await _ndEnsureProvider();
            const p = await _capCommand('note-detection', 'open-binding', {
                providerId: ND_PROVIDER_ID,
                context: { arrangement: 'keys', midiLow: range.activeLow, midiHigh: range.activeHigh },
            }, 'Open a keys verify binding for the loaded chart');
            const bindingId = p && p.bindingId;
            if (!bindingId) return;
            if (seq !== _loadSeq || !_isReady) {
                _capCommand('note-detection', 'close-binding', { bindingId },
                    'Superseded by a newer chart load');
                return;
            }
            _ndBindingId = bindingId;
        }

        function applySize(w, h) {
            if (!ren || !cam || !w || !h) return;
            ren.setSize(w, h, false);
            cam.aspect = w / h;
            cam.updateProjectionMatrix();
        }

        function teardown() {
            const sm = window.slopsmith;
            if (sm && typeof sm.off === 'function') {
                if (_songHandler) sm.off('song:loaded', _songHandler);
                if (_endHandler) sm.off('song:ended', _endHandler);
                if (_stopHandler) sm.off('song:stop', _stopHandler);
            }
            _songHandler = _endHandler = _stopHandler = null;
            if (_ndBindingId) {
                _capCommand('note-detection', 'close-binding', { bindingId: _ndBindingId },
                    'Renderer torn down');
                _ndBindingId = null;
            }
            _clearGroup(notesGroup);
            _clearGroup(markersGroup);
            _clearGroup(keyboardGroup);
            _clearGroup(_flamesGroup);
            _flamePool.length = 0;
            _clearNoteCaches();
            _clearBarTextures();
            _clearFlameTextures();
            if (_glowTex) { _glowTex.dispose(); _glowTex = null; }
            _hitGlowMats.length = 0;
            if (ren) ren.dispose();
            ren = scene = cam = notesGroup = keyboardGroup = markersGroup = hitLine = null;
            _flamesGroup = null;
            noteMeshes = [];
            markerSprites = [];
            keyMeshes = new Map();
            _layoutInfo = null;
            _keyAnim.clear();
            _keyFlash.clear();
            _releaseAllHeld();
            _notation = null;
            _isReady = false;
        }

        const instance = {
            contextType: 'webgl2',

            init(canvas, _bundle) {
                if (_isReady) teardown();
                highwayCanvas = canvas;
                loadThree().then(() => {
                    if (!highwayCanvas) return; // destroyed before load resolved
                    try {
                        ren = new T.WebGLRenderer({ canvas: highwayCanvas, antialias: true, alpha: false });
                        ren.setClearColor(FOG_COLOR, 1);
                    } catch (e) {
                        console.error('[Keys-Hwy3D] WebGL2 init failed:', e);
                        _emitDomain('renderer-failed', { providerId: 'keys_highway_3d', reason: 'webgl2 init failed' });
                        return;
                    }
                    buildScene();
                    applySize(highwayCanvas.clientWidth, highwayCanvas.clientHeight);
                    _isReady = true;
                    loadNotationForCurrentSong();
                    if (window.slopsmith && typeof window.slopsmith.on === 'function') {
                        _songHandler = () => loadNotationForCurrentSong();
                        window.slopsmith.on('song:loaded', _songHandler);
                        // End-of-run stats: finalize on natural end AND on
                        // an early stop (player closed the song) — the
                        // once-per-run latch makes the pair idempotent.
                        _endHandler = () => { _finalizeRun(); };
                        _stopHandler = () => { _finalizeRun(); };
                        window.slopsmith.on('song:ended', _endHandler);
                        window.slopsmith.on('song:stop', _stopHandler);
                    }
                    // MIDI lifecycle: this instance takes focus; _midiInit
                    // is idempotent (no repeat permission prompt) and
                    // _midiActive gates the async access resolution so a
                    // destroy() before it lands can't wire a dead handler.
                    _instances.add(instance);
                    _activeInstance = instance;
                    _midiInit();
                    _midiResume();
                }).catch(() => {
                    _emitDomain('renderer-failed', { providerId: 'keys_highway_3d', reason: 'three load failed' });
                });
            },

            draw(bundle) {
                if (!_isReady || !ren || !scene || !cam) return;
                const now = (bundle && typeof bundle.currentTime === 'number') ? bundle.currentTime : 0;
                if (_notation) updateScene(now);
                _animateFeedback(performance.now());
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
                // event on its `if (!_activeInstance) return` guard.
                if (_activeInstance === instance) {
                    _activeInstance = null;
                    for (const inst of _instances) { _activeInstance = inst; break; }
                }
                if (_instances.size === 0) _midiReleaseSession();
                teardown();
                highwayCanvas = null;
            },

            // ── Module MIDI router surface (focused-instance dispatch) ──
            _handleNoteOn,
            _handleNoteOff,
            _handleSustain,
            _releaseAllHeld,

            // ── Headless test hooks (window.__keysHwTest) ───────────────
            _injectNoteOn(midi, when) {
                // Behaves like a device note-on of `midi` at song-time
                // `when` (defaults to the last drawn bundle time).
                _handleNoteOn(midi, 100, when);
            },
            _getScore() {
                return {
                    hits: _hits,
                    misses: _misses,
                    streak: _streak,
                    bestStreak: _bestStreak,
                    accuracy: accuracyOf(_hits, _misses),
                    score: scoreOf(_hits, _misses),
                };
            },
        };
        return instance;
    }

    /* ======================================================================
     *  Register
     * ====================================================================== */

    window.slopsmithViz_keys_highway_3d = createFactory;
    // Static contextType so core can make canvas-swap decisions before
    // constructing a renderer instance (and gate Auto on WebGL2).
    window.slopsmithViz_keys_highway_3d.contextType = 'webgl2';
    // Auto-select on arrangements that carry notation (sloppak-spec §5.3).
    // Predicates receive the raw song_info wire frame — snake_case field.
    // Directory name `keys_highway_3d` sorts before `piano` and `staffview`
    // so Auto prefers the 3D highway when all three match.
    window.slopsmithViz_keys_highway_3d.matchesArrangement = function (songInfo) {
        return !!(songInfo && songInfo.has_notation);
    };
    // Pure data-layer + scoring hooks for headless tests.
    window.slopsmithViz_keys_highway_3d.__test = {
        beatDurSec,
        flattenNotation,
        keyRange,
        measureMarkers,
        noteLetter,
        scrollZ,
        noteKey,
        accuracyOf,
        scoreOf,
        judgeHit,
        sweepMissed,
    };

    // Headless verification hook: lets Playwright drive synthetic note-ons
    // through the full hit-detection + feedback path and read the live
    // score without a physical MIDI device.
    window.__keysHwTest = {
        injectNoteOn(midi, when) {
            if (_activeInstance && typeof _activeInstance._injectNoteOn === 'function') {
                _activeInstance._injectNoteOn(midi, when);
            }
        },
        getScore() {
            return (_activeInstance && typeof _activeInstance._getScore === 'function')
                ? _activeInstance._getScore() : null;
        },
    };
})();
