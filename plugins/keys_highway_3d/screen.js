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
// keyboard, per-key Synthesia-style PITCH-CLASS colors (hand is only a
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

    // Per-pitch-class colors (Synthesia convention observed in the RS+
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
    // at full brightness, left hand slightly darkened — color stays the
    // pitch class.
    const HAND_BRIGHTNESS = { rh: 1.0, lh: 0.72 };

    // Selectable note-color palettes. Index = midi % 12, same contract as
    // PITCH_CLASS_COLORS — which stays byte-identical as the 'classic'
    // entry, so anyone who never touches the setting sees the stock look.
    // Two palette families:
    //   per-pitch  — every pitch class gets its own hue (classic/vivid/pastel)
    //   two-tone   — naturals share one hue, sharps a darker shade of it, so
    //                a dark gem always telegraphs "black key coming"
    //                (emerald/ice)
    const NOTE_PALETTES = {
        classic: PITCH_CLASS_COLORS,
        emerald: [
            0x3fe25f, // C  — bright green (naturals)
            0x17863a, // C# — dark green (sharps)
            0x3fe25f, // D
            0x17863a, // D#
            0x3fe25f, // E
            0x3fe25f, // F
            0x17863a, // F#
            0x3fe25f, // G
            0x17863a, // G#
            0x3fe25f, // A
            0x17863a, // A#
            0x3fe25f, // B
        ],
        vivid: [
            0xff2020, // C
            0xd45a10, // C#
            0xffe000, // D
            0xb8c010, // D#
            0x1e6aff, // E
            0x9fd0e8, // F
            0x2fae7e, // F#
            0x20e050, // G
            0xa89a20, // G#
            0xff8a00, // A
            0xd05888, // A#
            0xd040ff, // B
        ],
        pastel: [
            0xff9a9a, // C
            0xd0a078, // C#
            0xffe9a0, // D
            0xcfd08a, // D#
            0x9ec0ff, // E
            0xc8dde8, // F
            0x9ecfba, // F#
            0x9fe8b0, // G
            0xcfc79a, // G#
            0xffc890, // A
            0xd8a8ba, // A#
            0xe0b0ff, // B
        ],
        ice: [
            0x58c8ff, // C  — bright ice blue (naturals)
            0x2a6a9a, // C# — deep blue (sharps)
            0x58c8ff, // D
            0x2a6a9a, // D#
            0x58c8ff, // E
            0x58c8ff, // F
            0x2a6a9a, // F#
            0x58c8ff, // G
            0x2a6a9a, // G#
            0x58c8ff, // A
            0x2a6a9a, // A#
            0x58c8ff, // B
        ],
    };

    // Octave-based color scheme ('octaves'): every octave gets a distinct
    // hue that steps like a rainbow (clear, uniform sections — NOT a smooth
    // blend — so each octave is uniquely identifiable, but neighbouring
    // octaves stay close so the change isn't jarring). Loops if a song runs
    // past the table. Within an octave, sharps/flats take a darker shade of
    // the same hue — the same two-tone idea as 'emerald'. Octave index =
    // floor(midi/12) - 1 (so C1..B1 = octave 1). The three keys below C1
    // (A0/A#0/B0 = octave 0) and anything lower get a distinct cool slate so
    // the very bottom of the board reads apart from the red start.
    const OCTAVE_HUES = [
        0xe23a3a, // oct 1 (C1–B1)  red
        0xe2803a, // oct 2          orange
        0xe0c73a, // oct 3          yellow
        0x5fc23a, // oct 4          green
        0x3ac2a0, // oct 5          teal
        0x3a86e2, // oct 6          blue
        0x6a4ae2, // oct 7          indigo
        0xc23ae2, // oct 8 (C8)     magenta
    ];
    const OCTAVE_SUBC1_HUE = 0x8090a0;  // A0/A#0/B0 and below — cool slate
    const OCTAVE_SHARP_DARKEN = 0.5;    // sharps render at 50% of the octave hue
    function _darkenHex(hex, f) {
        const r = Math.round(((hex >> 16) & 0xff) * f);
        const g = Math.round(((hex >> 8) & 0xff) * f);
        const b = Math.round((hex & 0xff) * f);
        return (r << 16) | (g << 8) | b;
    }
    function _isBlackPc(midi) {
        return [1, 3, 6, 8, 10].indexOf(((midi % 12) + 12) % 12) !== -1;
    }
    // Which way a sharp leans to even out the naturals: toward the EDGE
    // natural next to it. +1 = up (toward the higher natural), −1 = down, 0 =
    // centred. C#/F# sit below an inner natural so they lean down to C/F;
    // D#/A# lean up to E/B; G# has an inner natural on both sides, so it can't
    // lean and stays put.
    function _sharpLeanDir(pc) {
        if (pc === 1 || pc === 6) return -1;   // C#, F#
        if (pc === 3 || pc === 10) return 1;   // D#, A#
        return 0;                              // G#
    }
    // Floor span [left,right] of a key's lane in the FLAT (piano-shaped)
    // layout, in world units, given the key's centre x (`cx`). Pure/isolated
    // on purpose — this ONE function defines the layout, so a variant is a
    // one-function swap. Zero-overlap tiling: a white lane is trimmed by
    // `sharpHalf` wherever it meets a sharp, and the sharp fills that gap. Each
    // sharp is nudged `shift` toward the edge natural beside it (see
    // _sharpLeanDir), which steals a sliver from that edge natural and widens
    // the squeezed inner natural — at shift = sharpHalf/3 the C-D-E-F-B
    // naturals come out equal. Lanes still tile edge-to-edge (no overlap, no
    // gap). With `gaps`, each B→C octave boundary opens an extra `octGap`
    // divider by shaving half of it off the B and the C (naturals only).
    // `range`, when given, gates the trim to a neighbouring sharp that is
    // itself inside `range.activeLow..range.activeHigh`. A white key at the
    // active-range boundary (see the `midi < range.activeLow ||
    // midi > range.activeHigh` skip around the lane-strip loop) may sit next
    // to a sharp pitch-class that falls just outside the active range — that
    // sharp's lane is never drawn, so trimming the white key's edge for it
    // leaves a dark, unfilled sliver. Gating on range keeps that edge full
    // while leaving the normal (fully in-range) zero-overlap tiling intact.
    // Callers that don't pass `range` (e.g. the unit tests exercising raw
    // tiling geometry) keep the unconditional trim.
    function laneSpanFlat(midi, black, cx, dims, gaps, range) {
        const { whiteW, sharpHalf, shift, octGap } = dims;
        if (black) {
            const c = cx + _sharpLeanDir(((midi % 12) + 12) % 12) * shift;
            return { left: c - sharpHalf, right: c + sharpHalf };
        }
        const neighborActive = (m) => !range || (m >= range.activeLow && m <= range.activeHigh);
        // White: each side that meets a sharp is trimmed to that (leaned) sharp's
        // near edge; a side that meets another white keeps the half-slot edge.
        let left = cx - whiteW / 2;
        let right = cx + whiteW / 2;
        if (_isBlackPc(midi - 1) && neighborActive(midi - 1)) {
            const bc = (cx - whiteW / 2) + _sharpLeanDir(((midi - 1) % 12 + 12) % 12) * shift;
            left = bc + sharpHalf;
        }
        if (_isBlackPc(midi + 1) && neighborActive(midi + 1)) {
            const bc = (cx + whiteW / 2) + _sharpLeanDir(((midi + 1) % 12 + 12) % 12) * shift;
            right = bc - sharpHalf;
        }
        const pc = ((midi % 12) + 12) % 12;
        if (gaps) {
            if (pc === 11) right -= octGap / 2; // B: gap on its right (→ C)
            if (pc === 0) left += octGap / 2;   // C: gap on its left (← B)
        }
        return { left, right };
    }
    // 'realistic' layout span: every bar sized to the physical key it lands on.
    // Naturals are the same full width (2·natHalf) centred on the key; sharps are
    // the full black-key width (2·sharpHalf) at their standard half-slot, which
    // makes them overlap — the caller draws sharps on top. A natural therefore
    // always renders full and is only covered where a sharp note actually
    // coincides in time. `gaps` widens the B→C divider (naturals only).
    function laneSpanReal(midi, black, cx, dims, gaps) {
        const half = black ? dims.sharpHalf : dims.natHalf;
        let left = cx - half, right = cx + half;
        if (gaps && !black) {
            const pc = ((midi % 12) + 12) % 12;
            if (pc === 11) right -= dims.octGap / 2;
            if (pc === 0) left += dims.octGap / 2;
        }
        return { left, right };
    }
    // Color (24-bit int) for a midi note under the octave scheme: hue by
    // octave, darker for sharps. Pure (no THREE) so it is unit-testable.
    function octaveNoteColor(midi) {
        const oct = Math.floor(midi / 12) - 1;      // C1..B1 => 1
        let hex = (oct <= 0)
            ? OCTAVE_SUBC1_HUE
            : OCTAVE_HUES[(oct - 1) % OCTAVE_HUES.length];
        if (_isBlackPc(midi)) hex = _darkenHex(hex, OCTAVE_SHARP_DARKEN);
        return hex;
    }
    // Every valid palette id: the 12-entry pitch-class tables PLUS the
    // procedural 'octaves' scheme (which is not a 12-array, so it lives
    // outside NOTE_PALETTES and is validated through this list).
    const PALETTE_IDS = [...Object.keys(NOTE_PALETTES), 'octaves'];

    // Note block cross-section height and bevel (world units). The bevel
    // turns the flat slabs into glossy gem-like blocks that catch the light
    // on their edges — the RS+ reference look.
    const NOTE_H = 4 * K;
    const NOTE_BEVEL = 0.55 * K;
    // Resting note glow. Raised from the original 0.08 in the hit-FX parity
    // pass — combined with the vibrancy-driven opacity it fixes the
    // washed-out, semi-transparent look the note gems had.
    const NOTE_EMISSIVE_BASE = 0.22;
    const CONSUME_GLOW = 5.0;          // peak glow as a note is eaten at the hit-line
    const LABEL_FADE_DIST = 80 * K;    // note-name fades out over this distance past the hit-line (~0.6s)
    // Gem vertical gradient (bottom shade → top highlight), baked per-vertex into
    // the note geometry so a block reads as a lit 3D gem instead of a flat fill —
    // same approach as the bundled guitar highway_3d (`gNoteGrad`). The ramp is
    // greyscale so one geometry serves every pitch-class color; the material
    // multiplies its color by it via vertexColors.
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
                    return { id: String(obj.id || ''), name: String(obj.name || ''), key: String(obj.key || '') };
                }
            }
        } catch (_) {}
        return null;
    }

    function _writeSavedPick(id, name, key) {
        _writeStore(STORE_KEYS.midiPick, JSON.stringify({ id: id || '', name: name || '', key: key || '' }));
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
        // Prefer the globally-unique logicalSourceKey, then the legacy bare
        // sourceId, then case-insensitive name (Chrome on Linux regenerates ids
        // per page load), then first non-loopback.
        let target = null;
        if (saved && saved.key) target = inputs.find(i => i.key === saved.key) || null;
        if (!target && saved && saved.id) target = inputs.find(i => i.id === saved.id) || null;
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
            const hasSavedPick = !!(saved && (saved.key || saved.id || saved.name));
            if (!allowFallback && hasSavedPick) return;
            target = inputs.find(i => !_MIDI_BLOCKLIST_RE.test(i.name || '')) || inputs[0];
        }
        _midiConnect(target.id, target.name, target.key);
    }

    async function _midiConnect(id, name, key) {
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
        // `id` may be a logicalSourceKey (new host calls) or a legacy sourceId.
        const src = id
            ? (_midiSources().find(s => s.key === id) || _midiSources().find(s => s.id === id))
            : null;
        _midiConnect(src ? src.id : (id || ''), src ? src.name : '', src ? src.key : '');
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

    // Classify a hit's timing against its matched chart note. delta =
    // note.t - now: positive → struck before the note crossed the line
    // (EARLY), negative → after (LATE); the inner 40% of the hit window
    // reads as on-time. PORTED FROM drum_highway_3d (same proportions as
    // highway_3d's timing verdicts) — keep in sync.
    function _classifyTiming(delta, tol) {
        if (!Number.isFinite(delta) || !Number.isFinite(tol)) return 'OK';
        if (Math.abs(delta) <= tol * 0.4) return 'OK';
        return delta > 0 ? 'EARLY' : 'LATE';
    }

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
    // `keys3d_bg_*` localStorage prefix; later parity PRs (sparks, themes,
    // background styles, score FX) extend this object with their own keys.
    // Everything defaults ON — the settings screen is the opt-out.
    const FX_DEFAULTS = {
        bloom: true,
        sparks: true,     // pooled hit-spark bursts at the struck key
        timingFx: true,   // early/late/on-time coloring of the sparks
        streakFx: true,   // consecutive-hit escalation (bigger bursts)
        hitFx: 0.7,       // 0–1 master intensity for the hit-line kick
        vibrancy: 0.85,   // note-gem opacity + lane-guide strength
        cinematic: true,  // rebalanced lighting (dimmer ambient, stronger key)
        glow: 0.5,        // 0–1 emissive multiplier (0.5 = the stock look)
        scoreFx: true,    // 2D overlay: +N pops, combo rings, streak-break wash
        bgIntensity: 0.5, // background-ambience density/strength
        bgReactive: true, // background reacts to the audio analyser
        // Highway-layout options (apply on the next chart build via init()'s
        // fx re-read). The sharp LAYOUT is a separate string setting
        // (keys3d_bg_sharpMode); these two are the booleans.
        octaveGaps: true,      // ON: wider divider gap at each B→C octave boundary
        laneOpacity: 0.0,      // 0–1: lane-color strength. 0 (default) = dark floor +
        //                        block guide lines (E→F, B→C); 1 = full colored lanes; crossfades.
        octaveContrast: 0.5,   // 0–1: how strongly the B→C octave line stands out. It
        //                        auto-darkens with lane opacity and brightens as it fades.
        // Camera base-rig fine-tune. These shift the BASE vantage point the
        // auto-pan/zoom follow-motion is built on (they multiply/offset the
        // active CAM_PRESET before the per-frame pan + dolly), so the camera
        // still tracks the notes — just from a nudged height/distance/tilt.
        camHeight: 1.0,   // ×preset camera height (higher = more overhead)
        camDist: 1.0,     // ×preset camera distance (larger = further back)
        camTilt: 0.0,     // aim offset up(+)/down(−); 0 = neutral — the tuned overhead aim lives in CAM_PRESETS.overhead, so this fine-tune only nudges from a preset (and Classic + tilt 0 == the historical rig)
    };
    // Numeric FX keys clamp to a declared [min, max]; keys absent from this
    // table keep the historical 0–1 slider range. The camera fine-tune knobs
    // are multipliers/offsets centred on 1 (or 0), so they need headroom and a
    // floor a 0–1 range couldn't express.
    const FX_RANGES = {
        camHeight: [0.4, 2.2],
        camDist: [0.4, 2.2],
        camTilt: [-1.0, 1.0],
    };
    function _fxClamp(key, n) {
        const r = FX_RANGES[key] || [0, 1];
        return Math.min(r[1], Math.max(r[0], n));
    }
    const FX_LS_PREFIX = 'keys3d_bg_';
    // Theme id lives OUTSIDE FX_DEFAULTS (string, not bool/number) — its own
    // localStorage key + validation against BG_THEMES.
    const FX_LS_THEME = 'keys3d_bg_theme';
    // Background-ambience style — string-valued like the theme, so it gets
    // its own validated key + setter rather than an FX_DEFAULTS slot.
    // butterchurn/image/video from the guitar are deliberately out of scope.
    const BG_STYLE_IDS = ['off', 'particles', 'lights', 'geometric'];
    const FX_LS_STYLE = 'keys3d_bg_style';
    function readBgStyleSetting() {
        try {
            const id = localStorage.getItem(FX_LS_STYLE);
            if (id && BG_STYLE_IDS.indexOf(id) !== -1) return id;
        } catch (_) {}
        return 'particles';
    }
    window.keys3dSetBgStyle = function (id) {
        if (BG_STYLE_IDS.indexOf(id) === -1) return;
        try { localStorage.setItem(FX_LS_STYLE, id); } catch (_) {}
        try {
            window.dispatchEvent(new CustomEvent('keys3d:settings', { detail: { bgStyle: id } }));
        } catch (_) { /* dispatch unavailable — persisted value applies next init */ }
    };

    /* ======================================================================
     *  Audio analyser bridge — module singletons, shared across instances.
     *  PORTED FROM highway_3d _bgGetAnalyser/_bgReadBands via
     *  drum_highway_3d (keep in sync; the guitar's diagnostics plumbing is
     *  dropped).
     * ====================================================================== */
    const BG_FREQ_BINS = 128;
    const BG_ZERO_BANDS = { bass: 0, mid: 0, treble: 0 };
    let _bgAudio = null;       // {ctx, analyser, freq, source} | {failed, permanent}
    let _bgAudioCore = null;   // remembered core tap (one-shot per element)
    let _bgAudioFailedAt = 0;
    const _BG_AUDIO_RETRY_MS = 1000;
    function _bgGetAnalyser() {
        // Prefer the stems plugin's side-chain analyser: on sloppaks the
        // #audio element is a silent virtual transport. Per-song node —
        // cache keyed on identity so a song switch re-adopts automatically.
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
        // drum highway — the guitar is a port-back candidate) adopts it
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
            console.warn('[Keys-Hwy3D] failed to set up audio analyser:', e);
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
    // One pick drives clear/fog + the highway floor + the lane-edge rails;
    // pitch-class note/key colors are identity and never themed.
    //   clear/fog — background gradient anchor + distance fog
    //   board     — the highway floor plane
    //   laneDim   — the thin lane-edge rails (lane itself is pitch-colored)
    const BG_THEMES = {
        // 'default' is THIS plugin's original palette (fog 0x1a1a2e, floor
        // 0x141422, rail 0x2a2a3e) — byte-identical for anyone who never
        // touches the setting. Every OTHER id matches the guitar's table.
        default:    { clear: 0x1a1a2e, fog: 0x1a1a2e, board: 0x141422, laneDim: 0x2a2a3e },
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
    window.keys3dSetTheme = function (id) {
        if (!BG_THEMES[id]) return;
        try { localStorage.setItem(FX_LS_THEME, id); } catch (_) {}
        try {
            window.dispatchEvent(new CustomEvent('keys3d:settings', { detail: { theme: id } }));
        } catch (_) { /* dispatch unavailable — persisted value applies next init */ }
    };

    // Note-color palette id — string-valued like the theme, so it gets its
    // own validated key + setter rather than an FX_DEFAULTS slot.
    const FX_LS_PALETTE = 'keys3d_bg_palette';
    function readPaletteSetting() {
        try {
            const id = localStorage.getItem(FX_LS_PALETTE);
            if (id && PALETTE_IDS.indexOf(id) !== -1) return id;
        } catch (_) {}
        // Default: the octave scheme (each octave its own color, darker
        // sharps) — the plug-and-play piano look. Emerald/classic/etc. remain
        // selectable.
        return 'octaves';
    }
    window.keys3dSetPalette = function (id) {
        if (PALETTE_IDS.indexOf(id) === -1) return;
        try { localStorage.setItem(FX_LS_PALETTE, id); } catch (_) {}
        try {
            window.dispatchEvent(new CustomEvent('keys3d:settings', { detail: { palette: id } }));
        } catch (_) { /* dispatch unavailable — persisted value applies next init */ }
    };

    // Sharp-display layout id — string-valued (3-way), its own validated key +
    // setter. 'floating' = the original raised-plane sharps with white-only
    // lanes; 'flat' = every note on one plane with piano-shaped tiled lanes
    // (sharps leaned to even the naturals); 'realistic'
    // = one plane with note bars sized like the physical keys (full naturals,
    // full sharps overlapping on top). Geometry-time — applied on the next chart
    // build via init()'s re-read.
    const FX_LS_SHARPMODE = 'keys3d_bg_sharpMode';
    const SHARP_MODES = ['floating', 'flat', 'realistic'];
    function readSharpModeSetting() {
        try {
            const id = localStorage.getItem(FX_LS_SHARPMODE);
            if (id && SHARP_MODES.indexOf(id) !== -1) return id;
        } catch (_) {}
        return 'realistic'; // default layout: physical-key-sized bars on one plane
    }
    window.keys3dSetSharpMode = function (id) {
        if (SHARP_MODES.indexOf(id) === -1) return;
        try { localStorage.setItem(FX_LS_SHARPMODE, id); } catch (_) {}
        try {
            window.dispatchEvent(new CustomEvent('keys3d:settings', { detail: { sharpMode: id } }));
        } catch (_) { /* dispatch unavailable — persisted value applies next init */ }
    };

    // Camera-rig presets. 'classic' is the original low, near-telephoto rig
    // (numerically identical to the historical constants, so 'classic' with the
    // neutral camTilt default reproduces the exact stock framing). y/z/lookY/lookZ
    // are in pre-K world units — the instance multiplies by K at the use sites,
    // same as the old constants did. Zoom scales position AND look-at every
    // frame, so all presets inherit the adaptive dolly behaviour unchanged.
    // Each preset carries its OWN tuned aim in lookY: 'overhead' bakes in the
    // plug-and-play downward tilt (the −0.6 × CAM_TILT_UNITS = −33 that used to
    // ship as the camTilt default) so the default look is unchanged while
    // camTilt now defaults to 0 (a neutral nudge from whatever preset is picked).
    const CAM_PRESETS = {
        classic:  { fov: 40, y: 46,  z: 112, lookY: 8,   lookZ: -165 },
        elevated: { fov: 44, y: 78,  z: 118, lookY: 4,   lookZ: -150 },
        overhead: { fov: 48, y: 118, z: 74,  lookY: -33, lookZ: -115 },
    };
    // Camera preset id — string-valued like the theme, so it gets its own
    // validated key + setter rather than an FX_DEFAULTS slot.
    const FX_LS_CAMERA = 'keys3d_bg_camera';
    function readCameraSetting() {
        try {
            const id = localStorage.getItem(FX_LS_CAMERA);
            if (id && CAM_PRESETS[id]) return id;
        } catch (_) {}
        // Default: the overhead reading rig — its lookY already carries the
        // tuned downward aim, so with the neutral camTilt default it gives the
        // plug-and-play piano view out of the box. Others selectable ('classic'
        // + neutral tilt = the exact historical rig).
        return 'overhead';
    }
    window.keys3dSetCamera = function (id) {
        if (!CAM_PRESETS[id]) return;
        try { localStorage.setItem(FX_LS_CAMERA, id); } catch (_) {}
        try {
            window.dispatchEvent(new CustomEvent('keys3d:settings', { detail: { camera: id } }));
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
                    // Numeric FX keys clamp to their declared range
                    // (default 0-1) so a corrupt/foreign write can't
                    // overdrive opacities or the geometry multipliers.
                    if (Number.isFinite(n)) fx[k] = _fxClamp(k, n);
                }
            }
        } catch (_) { /* localStorage unavailable — use defaults */ }
        return fx;
    }

    // Single setter for every FX key — settings.html calls
    // window.keys3dSetFx('bloom', checked). Coerces to the default's type so
    // a slider string can't poison a boolean toggle.
    window.keys3dSetFx = function (key, value) {
        if (!(key in FX_DEFAULTS)) return;
        let v;
        if (typeof FX_DEFAULTS[key] === 'boolean') {
            // Same accepted representations as readFxSettings so the
            // setter/reader round-trip is consistent ('0'/'false' → false).
            v = value === true || value === 1 || value === '1' || value === 'true';
        } else {
            v = Number(value);
            if (!Number.isFinite(v)) return;
            v = _fxClamp(key, v);   // declared range, default 0-1
        }
        try {
            localStorage.setItem(FX_LS_PREFIX + key, typeof v === 'boolean' ? (v ? '1' : '0') : String(v));
        } catch (_) {}
        try {
            window.dispatchEvent(new CustomEvent('keys3d:settings', { detail: { fx: { [key]: v } } }));
        } catch (_) { /* dispatch unavailable — persisted value applies next init */ }
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
        const inputs = _midiSources();   // carries .key (logicalSourceKey), unlike _midiListInputs()
        if (idx == null || idx >= inputs.length) {
            return { outcome: 'failed', reason: 'MIDI input source is no longer present' };
        }
        _midiConnect(inputs[idx].id, inputs[idx].name, inputs[idx].key);
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

        // ── Visual FX state (guitar-highway parity) ─────────────────────
        let fx = readFxSettings();      // live snapshot, mutated by 'keys3d:settings'
        let _fxHandler = null;
        let _fxThemeHandler = null;
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
        // DOM HUD (combo / accuracy / best streak — drum_highway_3d pattern).
        let _hudEl = null;
        let _hudParentOrigPosition = null;

        // Hit-FX state. Sparks are PORTED FROM highway_3d (keep in sync);
        // pool 96 — keys hits also fire a flame sprite, so sparks are the
        // accent, not the whole show.
        const _SPARK_N = 96;
        let _sparkPts = null, _sparkPos = null, _sparkCol = null, _sparkVel = null, _sparkLife = null;
        let _fxLastWall = 0;       // wall clock for FX integration
        let _hitGlowKick = 0;      // hit-line brightness kick, decays exp(-t*6)
        const _laneGuideMats = []; // lane guide materials (vibrancy slider)

        // Theme/material handles (built by buildScene/buildKeyboardAndHighway;
        // _applyTheme / _applyCinematic / the glow slider retune them live).
        let _theme = readThemeSetting();
        let _palette = readPaletteSetting();
        let _sharpMode = readSharpModeSetting(); // 'floating' | 'flat' | 'realistic'
        let ambLight = null, dirLight = null;
        let _floorMat = null;
        const _railMats = [];      // lane-edge rail materials (theme laneDim)
        let _envRT = null;         // PMREM render target backing scene.environment
        let _bgTex = null;         // vertical-gradient background texture

        // Background ambience (PORTED FROM highway_3d BG_STYLES subset via
        // drum_highway_3d — keep in sync).
        let _bgStyle = readBgStyleSetting();
        let bgGroup = null;
        let _bgState = null;

        // Score-FX overlay (2D canvas sibling; drum_highway_3d pattern).
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
        let _scoreRingMs = -1e9;
        let _scoreBreakMs = -1e9;
        let _probe = null;

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

        function _paletteColor(pc) {
            return (NOTE_PALETTES[_palette] || PITCH_CLASS_COLORS)[pc];
        }

        // Base color (24-bit int, no hand dimming) for a midi note under the
        // active palette — the octave scheme is procedural, every other
        // palette is a 12-entry pitch-class table.
        function _noteHex(midi) {
            if (_palette === 'octaves') return octaveNoteColor(midi);
            return _paletteColor(((midi % 12) + 12) % 12);
        }

        function noteColor(midi, hand) {
            const base = new T.Color(_noteHex(midi));
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
        // 'flat' piano-shaped-lane geometry (see laneSpanFlat). Zero-overlap tiling:
        // white lanes are trimmed by FLAT_SHARP_HALF where they meet a sharp and
        // the sharp fills the gap, so nothing overlaps. To keep the naturals
        // even, each sharp is nudged FLAT_SHARP_SHIFT toward the EDGE natural
        // beside it (C#→C, D#→E, F#→F, A#→B; G# stays centred, no edge to lean
        // on) — that steals a sliver from the edge natural and hands it to the
        // squeezed inner natural. At shift = sharpHalf/3 the C-D-E-F-B naturals
        // come out exactly equal; G/A land a hair smaller (G# can't lean). The
        // sharps ride the same flat plane (no lift — they never overlap a
        // natural). OCT_GAP is the extra divider opened at each octave boundary
        // when the octaveGaps option is on.
        const FLAT_SHARP_HALF = 2.2 * K;                 // sharp half-width (4.4K wide)
        const FLAT_SHARP_SHIFT = FLAT_SHARP_HALF / 3;    // sharp lean that evens the naturals
        const OCT_GAP = 0.9 * K;
        const LANE_DIMS_FLAT = {
            whiteW: WHITE_W, sharpHalf: FLAT_SHARP_HALF, shift: FLAT_SHARP_SHIFT, octGap: OCT_GAP,
        };
        // 'realistic' layout (laneSpanReal): every note bar is the size of the
        // physical key it lands on — naturals the full white-key width (always
        // rendered full, only occluded where a sharp note actually overlaps in
        // time) and sharps the full black-key width at their standard positions,
        // drawn on top with a hair of REAL_SHARP_LIFT (anti z-fight).
        const REAL_NAT_HALF = WHITE_W * 0.47;   // natural bar ≈ physical white key (~11.3K)
        const REAL_SHARP_HALF = BLACK_W / 2;    // sharp bar = physical black key (6.4K)
        const REAL_SHARP_LIFT = 0.3 * K;
        const LANE_DIMS_REAL = { natHalf: REAL_NAT_HALF, sharpHalf: REAL_SHARP_HALF, octGap: OCT_GAP };
        // Lane span for the active non-floating sharp mode. `range`
        // (activeLow/activeHigh) is optional and only consulted by the flat
        // layout, to gate the boundary-key edge trim (see laneSpanFlat).
        const _flatMode = () => _sharpMode === 'flat' || _sharpMode === 'realistic';
        function laneSpanFor(midi, black, cx, gaps, range) {
            return _sharpMode === 'realistic'
                ? laneSpanReal(midi, black, cx, LANE_DIMS_REAL, gaps)
                : laneSpanFlat(midi, black, cx, LANE_DIMS_FLAT, gaps, range);
        }

        // Camera — the default 'classic' preset is a low, near-telephoto rig
        // (RS+-style): a narrow FOV from low and back gives a deep receding
        // runway and frames ~2 octaves instead of cramming the whole note
        // range full-width. The x position pans to follow the active notes
        // (see updateScene), so wide pieces stay zoomed in on the played hand
        // rather than shrinking every key. The rig numbers now come from the
        // user-selectable CAM_PRESETS table; switching applies live because
        // position/lookAt are re-derived every frame.
        let _camPreset = CAM_PRESETS[readCameraSetting()] || CAM_PRESETS.classic;
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
        // Full-swing of the camTilt aim offset (pre-K units) at slider ±1.
        const CAM_TILT_UNITS = 55;

        // Base rig with the live fine-tune knobs applied — height/distance
        // multiply the preset, tilt offsets the aim height. Returns the
        // effective {y, z, lookY, lookZ} in pre-K units; the caller scales by
        // K and the auto-zoom. Keeps the pan/dolly follow-motion intact —
        // these only move the vantage point it orbits around. Writes into a
        // reusable object (returned live) so the per-frame camera update stays
        // allocation-free — the callers read it synchronously and never retain
        // it, so a single shared instance is safe.
        const _rigOut = { y: 0, z: 0, lookY: 0, lookZ: 0 };
        function _rig() {
            _rigOut.y = _camPreset.y * fx.camHeight;
            _rigOut.z = _camPreset.z * fx.camDist;
            _rigOut.lookY = _camPreset.lookY + fx.camTilt * CAM_TILT_UNITS;
            _rigOut.lookZ = _camPreset.lookZ;
            return _rigOut;
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
        // Per-key approach glow: a key lights in its pitch-class color ONLY while a
        // note is heading for it, ramping up the closer that note gets to the hit-line.
        const KEY_GLOW_AHEAD = 2.0;      // seconds before the hit-line a key starts to light
        const KEY_GLOW_STRENGTH = 1.15;  // peak emissive intensity (note at the hit-line)

        function keyX(layoutEntry, whiteCount) {
            return (layoutEntry.slot - (whiteCount - 1) / 2) * WHITE_W;
        }

        /* -- background ambience (PORTED FROM highway_3d BG_STYLES subset
         *    via drum_highway_3d — keep formulas in sync) -- */
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
                    const palette = settings.palette || [0xa0c0ff];
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

        function _bgMountStyle() {
            if (!scene || !T) return;
            if (!bgGroup) {
                bgGroup = new T.Group();
                scene.add(bgGroup);
            }
            if (_bgState && _bgState._style && BG_STYLES[_bgState._style]) {
                try { BG_STYLES[_bgState._style].teardown(_bgState.s); } catch (_) {}
            }
            const style = BG_STYLES[_bgStyle] || BG_STYLES.off;
            let s = null;
            try {
                s = style.build(bgGroup, { intensity: Math.min(1, Math.max(0, fx.bgIntensity)), palette: PITCH_CLASS_COLORS });
            } catch (e) {
                console.warn('[Keys-Hwy3D] bg style build failed', e);
                s = null;
            }
            _bgState = { _style: _bgStyle, s };
        }
        function _bgTeardownStyle() {
            if (_bgState && _bgState._style && BG_STYLES[_bgState._style]) {
                try { BG_STYLES[_bgState._style].teardown(_bgState.s); } catch (_) {}
            }
            _bgState = null;
            bgGroup = null;
        }

        /* -- score-FX overlay (drum_highway_3d pattern — keep in sync) -- */
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
            _fxCanvas.className = 'keys-h3d-fx';
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
        function _scoreSpawnPop(midi) {
            if (!_layoutInfo) return;
            const entry = _layoutInfo.layout.get(midi);
            if (!entry) return;
            const nowMs = performance.now();
            for (const pop of _scorePops) {
                if (pop.active) continue;
                pop.active = true;
                pop.x = keyX(entry, _layoutInfo.whiteCount);
                pop.z = -WHITE_L / 2;
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
        function _scoreOnHit(midi) {
            if (!fx.scoreFx) return;
            const nowMs = performance.now();
            _scoreSpawnPop(midi);
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
            if (!anyPop && !anyBurst && ringAge >= 600 && breakAge >= 350) {
                if (_fxCanvas._dirty) { _fxCtx.clearRect(0, 0, W, H); _fxCanvas._dirty = false; }
                return;
            }
            _fxCanvas._dirty = true;
            if (!_probe) _probe = new T.Vector3();
            const ctx = _fxCtx;
            ctx.clearRect(0, 0, W, H);
            ctx.save();
            if (breakAge < 350) {
                ctx.fillStyle = '#ef4444';
                ctx.globalAlpha = 0.10 * (1 - breakAge / 350);
                ctx.fillRect(0, 0, W, H);
                ctx.globalAlpha = 1;
            }
            let cx = W / 2, cy = H * 0.72, centerOk = false;
            _probe.set(0, WHITE_H + 0.5 * K, -WHITE_L / 2);
            _probe.project(cam);
            if (_probe.z >= -1 && _probe.z <= 1) {
                cx = (_probe.x * 0.5 + 0.5) * W;
                cy = (-_probe.y * 0.5 + 0.5) * H;
                centerOk = true;
            }
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
            if (anyPop) {
                ctx.textAlign = 'center';
                ctx.textBaseline = 'middle';
                for (const pop of _scorePops) {
                    if (!pop.active) continue;
                    const age = nowMs - pop.bornMs;
                    if (age >= 800) { pop.active = false; continue; }
                    _probe.set(pop.x, WHITE_H + 2 * K, pop.z);
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

        // Emissive multiplier from the Glow slider — 0.5 is neutral (the
        // stock look), so `base * _glowMul()` leaves defaults byte-identical.
        function _glowMul() {
            return Math.min(1, Math.max(0, fx.glow)) * 2;
        }

        // Cinematic lighting: dimmer ambient + stronger key light. Off = the
        // plugin's pre-parity values.
        function _applyCinematic() {
            if (!ambLight || !dirLight) return;
            ambLight.intensity = fx.cinematic ? 0.55 : 0.75;
            dirLight.intensity = fx.cinematic ? 1.3 : 1.1;
        }

        // Procedural "studio" environment for image-based lighting — the
        // anti-plastic core: the clearcoat note gems and the piano-black
        // keys need something to reflect. PORTED FROM drum_highway_3d
        // _makeStudioEnv — keep in sync. Returns the PMREM RT or null.
        function _makeStudioEnv(ThreeLib, renderer) {
            if (!renderer) return null;
            try {
                const envScene = new ThreeLib.Scene();
                const own = [];
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
                // Deliberate delta from drum_highway_3d: the strips run at
                // a third of the drum scene's intensity — this scene is
                // dominated by a WHITE keyboard and a sheened floor, and the
                // drum-strength strips overexpose it into a milky bloom
                // flood (screenshot-verified). The blacks' glints survive.
                strip(60, 8, 0xdfe8ff, 6, 0, 45, 0, Math.PI / 2, 0);       // overhead key
                strip(30, 50, 0xffd9a8, 2.5, -48, 5, 0, 0, Math.PI / 2);   // warm left wall
                strip(30, 50, 0x9fd8ff, 2.5, 48, 5, 0, 0, -Math.PI / 2);   // cool right wall
                const pmrem = new ThreeLib.PMREMGenerator(renderer);
                const rt = pmrem.fromScene(envScene, 0.04);
                pmrem.dispose();
                for (const r of own) r.dispose();
                return rt;
            } catch (e) {
                console.warn('[Keys-Hwy3D] studio env failed (continuing without IBL)', e);
                return null;
            }
        }

        function _disposeEnv() {
            if (_envRT) { try { _envRT.dispose(); } catch (_) {} _envRT = null; }
            if (_bgTex) { try { _bgTex.dispose(); } catch (_) {} _bgTex = null; }
        }

        // Vertical-gradient background: lighter above the horizon, the theme
        // clear at the midline, darker toward the keyboard — depth the flat
        // clear color never had. sRGB-tagged so the composer's output
        // transform reads it correctly.
        function _makeBgTexture(clearHex) {
            const cnv = document.createElement('canvas');
            cnv.width = 2; cnv.height = 256;
            const ctx = cnv.getContext('2d');
            const c = new T.Color(clearHex);
            const top = c.clone().lerp(new T.Color(0xffffff), 0.10);
            const bottom = c.clone().multiplyScalar(0.55);
            const grad = ctx.createLinearGradient(0, 0, 0, 256);
            grad.addColorStop(0, '#' + top.getHexString());
            grad.addColorStop(0.55, '#' + c.getHexString());
            grad.addColorStop(1, '#' + bottom.getHexString());
            ctx.fillStyle = grad;
            ctx.fillRect(0, 0, 2, 256);
            const tex = new T.CanvasTexture(cnv);
            tex.colorSpace = T.SRGBColorSpace;
            return tex;
        }

        // Apply the active theme to the live scene. Pitch-class note/key
        // colors are identity — themes own the scene, not the notes.
        function _applyTheme() {
            const c = _bgThemeColors(_theme);
            if (scene) {
                if (_bgTex) { try { _bgTex.dispose(); } catch (_) {} }
                _bgTex = _makeBgTexture(c.clear);
                scene.background = _bgTex;
                if (scene.fog) scene.fog.color.setHex(c.fog);
            }
            if (ren) ren.setClearColor(c.clear, 1);
            if (_floorMat) _floorMat.color.setHex(c.board);
            for (const m of _railMats) m.color.setHex(c.laneDim != null ? c.laneDim : 0x2a2a3e);
        }

        function buildScene() {
            scene = new T.Scene();
            // Theme-driven gradient background (an explicit scene.background
            // is also what keeps the composer's ACES output from washing out
            // a bare clear color) + matching fog.
            const themeCols = _bgThemeColors(_theme);
            _bgTex = _makeBgTexture(themeCols.clear);
            scene.background = _bgTex;
            scene.fog = new T.Fog(themeCols.fog, FOG_START, FOG_END);
            if (ren) ren.setClearColor(themeCols.clear, 1);

            // Studio environment map — image-based lighting for the
            // clearcoat gems / piano-black keys. Renderer-bound; disposed in
            // teardown via _disposeEnv.
            _envRT = _makeStudioEnv(T, ren);
            if (_envRT) scene.environment = _envRT.texture;

            cam = new T.PerspectiveCamera(_camPreset.fov, 1, 0.1, 2000 * K);
            _camX = 0; _camTargetX = 0; _camZoom = 1; _camTargetZoom = 1;
            { const r = _rig(); cam.position.set(0, r.y * K, r.z * K); cam.lookAt(0, r.lookY * K, r.lookZ * K); }

            ambLight = new T.AmbientLight(0xffffff, 0.75);
            dirLight = new T.DirectionalLight(0xffffff, 1.1);
            dirLight.position.set(60 * K, 200 * K, 80 * K);
            scene.add(ambLight, dirLight);
            _applyCinematic();

            keyboardGroup = new T.Group();
            notesGroup = new T.Group();
            markersGroup = new T.Group();
            _flamesGroup = new T.Group();
            scene.add(keyboardGroup, notesGroup, markersGroup, _flamesGroup);
            _buildFlamePool();

            // Hit sparks (PORTED FROM highway_3d): pooled additive Points
            // cloud, burst at the struck key, integrated in draw(). Same
            // coordinate space as the flames (keyX / hit-line z).
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

            // Background ambience behind everything (renderOrder -1).
            _bgMountStyle();
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
            // Bake a vertical brightness ramp into vertex colors (bottom shade →
            // top highlight) so the gem reads 3D; the material multiplies its
            // pitch-class color by this (vertexColors).
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

        // Glossy note material, cached per resolved color. Keying by the
        // final color int (hand brightness already baked in by noteColor)
        // works for every palette — including 'octaves', where two notes of
        // the same pitch class in different octaves are DIFFERENT colors and
        // must not share a material (a pitch-class key would collide them).
        function _noteMaterial(midi, hand) {
            const col = noteColor(midi, hand);
            const key = col.getHex();
            let mat = _noteMatCache.get(key);
            if (mat) return mat;
            // MeshPhysicalMaterial with a clearcoat: lacquered glass-gem
            // look — a sharp coat highlight over a colored body, lit by the
            // studio env map. This is the "not plastic" ask: the old matte
            // MeshStandard (roughness 0.78, no envMap) had a dead surface.
            // (~20-30% more fragment cost than MeshStandard on note pixels;
            // acceptable — notes cover a modest screen fraction and all
            // share one shader program.)
            mat = new T.MeshPhysicalMaterial({
                color: col,
                vertexColors: true,         // multiply color by the baked gem ramp
                emissive: col,
                emissiveIntensity: NOTE_EMISSIVE_BASE * _glowMul(),
                roughness: 0.32,
                metalness: 0.0,
                clearcoat: 1.0,
                clearcoatRoughness: 0.18,
                envMapIntensity: 0.9,
                transparent: true,
                // Vibrancy-driven: 0.72 (airy, keys clearly visible through
                // the gems) → 0.94 (solid, saturated). The old fixed 0.8
                // read washed-out against the dim floor.
                opacity: _noteOpacity(),
            });
            _noteMatCache.set(key, mat);
            return mat;
        }

        function _noteOpacity() {
            return 0.72 + 0.22 * Math.min(1, Math.max(0, fx.vibrancy));
        }
        function _laneGuideOpacity() {
            // Vibrancy sets the ceiling (much brighter than the old subtle
            // 0.10–0.22 range); the laneOpacity slider then scales 0 → ceiling.
            const vib = 0.32 + 0.52 * Math.min(1, Math.max(0, fx.vibrancy)); // ~0.32..0.84
            return vib * Math.min(1, Math.max(0, fx.laneOpacity));
        }

        // Live vibrancy slider: retint everything already built — the
        // per-note clones, the material cache (future clones), and the lane
        // guides — without a chart rebuild.
        function _applyVibrancy() {
            const op = _noteOpacity();
            for (const m of _noteMatCache.values()) m.opacity = op;
            for (const nm of noteMeshes) {
                if (nm.mesh && nm.mesh.material) nm.mesh.material.opacity = op;
            }
            const lop = _laneGuideOpacity();
            for (const m of _laneGuideMats) m.opacity = lop;
        }

        // Live palette switch: recolor everything already built — cached
        // note materials (future clones), per-note clones, key emissives
        // (incl. the wrong-flash restore state), lane guides — and drop the
        // pitch-class flame textures so the next spawn bakes the new hues.
        // Same no-rebuild approach as _applyVibrancy.
        function _applyPalette() {
            // The base-material cache is keyed by resolved color, so old
            // entries are simply stale under a new palette — drop them and let
            // the next build re-cache. The live per-note clones below are
            // retinted directly from each note's midi (palette-correct).
            for (const m of _noteMatCache.values()) m.dispose();
            _noteMatCache.clear();
            for (const nm of noteMeshes) {
                if (!nm.mesh || !nm.mesh.material) continue;
                const col = noteColor(nm.note.midi, nm.note.hand);
                nm.mesh.material.color.copy(col);
                nm.mesh.material.emissive.copy(col);
            }
            for (const [midi, km] of keyMeshes) {
                const col = noteColor(midi, 'rh');
                km.material.emissive.copy(col);
                km.userData.origEmissive = col.getHex();
            }
            for (const m of _laneGuideMats) {
                if (m.userData.midi != null) m.color.copy(noteColor(m.userData.midi, 'rh'));
            }
            _clearFlameTextures();
            // Re-arm the pool so no slot keeps rendering a disposed texture
            // (a flame mid-flight briefly re-tints — next spawn sets its
            // true pitch texture).
            for (const s of _flamePool) s.mat.map = _flameTexture(0);
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

        // Vertical flame texture for hit flares / held-key halos: white-hot
        // base fading up into the note's color, with a horizontal falloff.
        // Cached per resolved color (bounded — 12 for pitch-class palettes,
        // up to ~one-per-octave for 'octaves'), so a flare always matches the
        // struck note's color whatever the palette.
        function _flameTexture(midi) {
            const c = _noteHex(midi);
            let tex = _flameTexCache.get(c);
            if (tex) return tex;
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
            _flameTexCache.set(c, tex);
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

        // Hit sparks (PORTED FROM highway_3d _sparkBurst/_sparkUpdate — keep
        // in sync): pooled additive Points; a timing-colored burst fires at
        // the struck key alongside the flame sprite.
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

        // Timing → color (PORTED FROM highway_3d _timingHex — keep in sync).
        function _timingHex(ts) {
            if (!fx.timingFx || !ts || ts === 'OK') return 0x22ff88;
            if (ts === 'EARLY') return 0x35d6ff;
            if (ts === 'LATE')  return 0xffb84d;
            return 0x22ff88;
        }

        function _spawnSparks(midi, ts) {
            if (!fx.sparks || !_sparkPts || !_layoutInfo) return;
            const entry = _layoutInfo.layout.get(midi);
            if (!entry) return;
            let count = 8;
            if (fx.streakFx) count += Math.round(8 * Math.min(1, _streak / 16));
            const y = (entry.black ? BLACK_H + WHITE_H * 0.6 : WHITE_H) + 1 * K;
            _sparkBurst(keyX(entry, _layoutInfo.whiteCount), y, -WHITE_L / 2, _timingHex(ts), count);
        }

        function _spawnFlame(midi, wallNow) {
            if (!_layoutInfo || !_flamePool.length) return;
            const entry = _layoutInfo.layout.get(midi);
            if (!entry) return;
            const slot = _flamePool[_flameIdx];
            _flameIdx = (_flameIdx + 1) % _flamePool.length;
            slot.mat.map = _flameTexture(midi);
            slot.start = wallNow;
            slot.baseY = entry.black ? BLACK_H + WHITE_H * 0.6 : WHITE_H;
            slot.sprite.position.x = keyX(entry, _layoutInfo.whiteCount);
            slot.sprite.position.z = -WHITE_L / 2; // at the hit-line
            slot.sprite.visible = true;
        }

        function buildKeyboardAndHighway() {
            _clearGroup(keyboardGroup);
            _hitGlowMats.length = 0;
            _laneGuideMats.length = 0;
            _railMats.length = 0;
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
            _floorMat = new T.MeshStandardMaterial({
                color: _bgThemeColors(_theme).board,
                // Stage-floor sheen (was matte 0.9): the env strips give the
                // deck a soft reflection lane without mirroring the notes.
                roughness: 0.55,
                metalness: 0.15,
                envMapIntensity: 0.25,
            });
            const floor = new T.Mesh(
                new T.PlaneGeometry(floorW, HIGHWAY_LEN),
                _floorMat,
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

            // Lane guides: a faint color strip running up the runway from each
            // active key, in that key's pitch-class color. A falling note shares
            // its target key's color, so the player can trace it straight down
            // its lane to the right key even when it sits near the frame edge.
            //
            // The lanes sit at the NOTES' travel height (coplanar), not on the
            // deck. The camera looks down the y–z plane, so a note elevated above
            // an on-floor lane projects to a different screen column (parallax) —
            // putting the lane at the note's y makes the note ride exactly in its
            // lane, perfectly aligned with the lane and its key.
            const guideLen = HIGHWAY_LEN - WHITE_L;
            const laneY = WHITE_H + NOTE_H / 2 + 0.5 * K; // == white-note travel height
            const gaps = fx.octaveGaps;
            const floating = _sharpMode === 'floating';
            const t = Math.min(1, Math.max(0, fx.laneOpacity));       // lane-color opacity
            const octC = Math.min(1, Math.max(0, fx.octaveContrast)); // 0..1 line-contrast
            const themeLaneDim = (() => { const c = _bgThemeColors(_theme); return c.laneDim != null ? c.laneDim : 0x2a2a3e; })();
            // A vertical guide line running the full runway at world x (skips
            // near-transparent lines so the crossfade never builds dead meshes).
            const addLine = (x, color, opacity, wpx, trackTheme) => {
                if (opacity < 0.02) return;
                const m = new T.MeshBasicMaterial({ color, transparent: true, opacity, depthWrite: false });
                if (trackTheme) _railMats.push(m); // theme retint tracks these; fixed guides stay put
                const line = new T.Mesh(new T.PlaneGeometry(wpx, guideLen), m);
                line.rotation.x = -Math.PI / 2;
                line.position.set(x, laneY + 0.06 * K, hitZ - guideLen / 2);
                keyboardGroup.add(line);
            };
            for (const [midi, entry] of layout) {
                if (midi < range.activeLow || midi > range.activeHigh) continue;
                // Floating: white-only lanes (blacks float, lane-less). Flat/
                // realistic: every key gets a piano-shaped lane.
                if (entry.black && floating) continue;
                // Lane footprint per mode.
                let left, right, stripY = laneY;
                if (floating) {
                    const cx = keyX(entry, whiteCount);
                    left = cx - WHITE_W / 2; right = cx + WHITE_W / 2;
                    if (gaps) {
                        const pc = ((midi % 12) + 12) % 12;
                        if (pc === 11) right -= OCT_GAP / 2; // B → C boundary
                        if (pc === 0) left += OCT_GAP / 2;
                    }
                } else {
                    const span = laneSpanFor(midi, entry.black, keyX(entry, whiteCount), gaps, range);
                    left = span.left; right = span.right;
                    if (_sharpMode === 'realistic' && entry.black) stripY = laneY + REAL_SHARP_LIFT;
                }
                const center = (left + right) / 2;
                // Colored lane strip + a subtle per-lane separator — fade in with
                // lane opacity. (As lanes fade, the block/octave lines below take
                // over as the guide.)
                if (t > 0.02) {
                    // Floating keeps the historical 0.84-wide white strip; the
                    // piano-shaped lanes inset a touch for a dark separator.
                    const stripW = floating ? (right - left) - WHITE_W * 0.16 : (right - left) * 0.9;
                    const gmat = new T.MeshBasicMaterial({
                        color: noteColor(midi, 'rh'), transparent: true,
                        opacity: _laneGuideOpacity(), depthWrite: false, // includes lane opacity
                    });
                    gmat.userData.midi = midi; // palette retint needs the lane's pitch
                    _laneGuideMats.push(gmat);
                    const strip = new T.Mesh(new T.PlaneGeometry(stripW, guideLen), gmat);
                    strip.rotation.x = -Math.PI / 2;
                    strip.position.set(center, stripY, hitZ - guideLen / 2);
                    keyboardGroup.add(strip);
                    // Per-lane separator, fading with the strips. Skip realistic
                    // sharps (they overlap the white columns).
                    if (!(entry.black && _sharpMode === 'realistic')) {
                        addLine(left, themeLaneDim, 0.5 * t, 0.6 * K, true);
                    }
                }
            }
            // Structural divider lines: ONE per "block" boundary — E→F and B→C —
            // so each block of keys (C-D-E, F-G-A-B) is bounded, not every lane.
            // They crossfade IN as the lanes fade OUT. The B→C octave line is a
            // dark layer (reads over bright lanes, scales with lane opacity) plus
            // a bright layer (reads over the dark floor, scales with the inverse),
            // so it auto-shifts dark→bright as you fade lanes; octaveContrast
            // scales the whole thing.
            for (let midi = range.activeLow; midi <= range.activeHigh; midi++) {
                const pc = ((midi % 12) + 12) % 12;
                const isEF = pc === 4;   // E → F block boundary
                const isBC = pc === 11;  // B → C octave boundary
                if (!isEF && !isBC) continue;
                const boundaryX = keyX(layout.get(midi), whiteCount) + WHITE_W / 2;
                if (isBC) {
                    addLine(boundaryX, 0x05060a, octC * 0.92 * t, 1.1 * K, false);              // dark, over lanes
                    addLine(boundaryX, 0xd8dcec, (0.42 + octC * 0.5) * (1 - t), 1.1 * K, false); // bright, over floor
                } else {
                    // E→F block divider — a guide that appears as the lanes fade.
                    addLine(boundaryX, 0x6a6a7a, 0.5 * (1 - t), 0.8 * K, false);
                }
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
                    // Pitch-class color preset on emissive but OFF at rest — the key
                    // is neutral until a note approaches, when updateScene ramps the
                    // intensity up by proximity.
                    emissive: noteColor(midi, 'rh'),
                    emissiveIntensity: 0,
                    // Anti-plastic: glossy piano black with visible strip
                    // reflections; whites keep a subtle ivory sheen (they're
                    // already near-white — env light saturates them fast).
                    roughness: black ? 0.22 : 0.42,
                    envMapIntensity: black ? 1.3 : 0.3,
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
                // Non-floating layouts: notes ride the naturals' plane and take
                // their piano-shaped lane's width/centre. Floating (default):
                // original elevated sharps, key-centred bars.
                let w, x, y;
                if (_flatMode()) {
                    const span = laneSpanFor(
                        note.midi, entry.black, keyX(entry, whiteCount), fx.octaveGaps, range);
                    // 'realistic' bars are full (physical-key size); 'flat' bars are
                    // inset a touch for a dark separator in the tight tiling.
                    const inset = _sharpMode === 'realistic' ? 1.0 : 0.9;
                    w = (span.right - span.left) * inset;
                    x = (span.left + span.right) / 2;
                    // Coplanar; in 'realistic' the sharps ride a hair proud so they
                    // draw over the naturals they overlap without z-fighting.
                    const lift = (_sharpMode === 'realistic' && entry.black) ? REAL_SHARP_LIFT : 0;
                    y = WHITE_H + NOTE_H / 2 + 0.5 * K + lift;
                } else {
                    w = (entry.black ? BLACK_W : WHITE_W * 0.94) * 0.9;
                    x = keyX(entry, whiteCount);
                    y = (entry.black ? BLACK_H + WHITE_H : WHITE_H) + NOTE_H / 2 + 0.5 * K;
                }
                // Clone per note so each can glow independently while being consumed.
                const mesh = new T.Mesh(_noteGeometry(w, len), _noteMaterial(note.midi, note.hand).clone());
                mesh.position.x = x;
                mesh.position.y = y;
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
                // Timing verdict: noteKey() serializes the matched note's t
                // as its prefix ("<t.toFixed(3)>|<midi>"), so parseFloat
                // recovers it without changing judgeHit's tested contract.
                const ts = _classifyTiming(parseFloat(key) - t, HIT_TOLERANCE_S);
                _spawnSparks(playedMidi, ts);
                // Brief hit-line brightness kick (decays exp(-t*6) in draw).
                _hitGlowKick = 1;
                _scoreOnHit(playedMidi);
                _ndReport(true, playedMidi, _ndBindingId);
            } else {
                const prevStreak = _streak;
                _misses++;
                _streak = 0;
                _scoreOnBreak(prevStreak);
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
            _scoreOnBreak(_streak);   // called before the caller zeroes it
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
            // Rest emissive with the Glow slider applied — computed once so
            // the per-note '!==' guards stay effective at any glow value.
            const _restEmissive = NOTE_EMISSIVE_BASE * _glowMul();
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
            {
                const r = _rig();
                let _cx = _camX, _cy = r.y * K * _camZoom, _cz = r.z * K * _camZoom;
                let _lx = _camX, _ly = r.lookY * K * _camZoom, _lz = r.lookZ * K * _camZoom;
                // Camera Director free-cam offsets (per-panel-aware), layered on top
                // of the auto-framing so pan/zoom-follow still works. Dolly/height/
                // orbit act on the camera-from-target vector; pan/pitch shift the
                // look target. NaN-safe; null/disabled bridge → stock.
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
                    if (mesh.material.emissiveIntensity !== _restEmissive) {
                        mesh.material.emissiveIntensity = _restEmissive;
                    }
                } else {
                    const remaining = len - past;        // = hitZ - backZ, length still up the runway
                    if (remaining <= 0.02 * K) { mesh.visible = false; continue; }
                    mesh.scale.set(1, 1, remaining / len);
                    mesh.position.z = hitZ - remaining / 2;
                    // Glow as it's eaten — intensifies the more of the note is consumed.
                    const consumed = Math.min(1, past / len);
                    mesh.material.emissiveIntensity =
                        (NOTE_EMISSIVE_BASE + (CONSUME_GLOW - NOTE_EMISSIVE_BASE) * (0.45 + 0.55 * consumed)) * _glowMul();
                }
            }
            // Apply the approach-glow (a wrong-note red flash owns emissive meanwhile).
            for (const [midi, km] of keyMeshes) {
                if (_keyFlash.has(midi)) continue;
                const g = km.userData.glow || 0;
                km.material.emissiveIntensity = g * g * KEY_GLOW_STRENGTH * _glowMul(); // ease → pops near the hit-line
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
            // allocations. With bloom active the additive planes accumulate
            // into an HDR target and the UnrealBloomPass amplifies them —
            // full-strength they flood the whole keyboard white — so damp
            // the pulse on that path; the composer's glow makes up the
            // difference.
            // Must mirror draw()'s composer gate exactly (incl. the
            // splitscreen checks) — damping on the direct-render path would
            // leave the hit line visibly dimmer.
            const glowScale = (_bloomGateOk() && _composer) ? 0.45 : 1;
            // Base pulse + the per-hit brightness kick (decayed in draw()'s
            // wall-clock FX step, scaled by the Hit feedback slider).
            const pulse = Math.min(1,
                (0.72 + 0.18 * Math.sin(now * 5.0) + 0.5 * _hitGlowKick * fx.hitFx) * glowScale);
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

        // The one condition under which the bloom composer path may render:
        // enabled, single instance of this viz, and no host splitscreen
        // (mixed splits with another renderer included). updateScene's
        // hit-line damping and draw()'s render tail must agree on this.
        function _bloomGateOk() {
            return fx.bloom && _instances.size === 1 && !_ssActive();
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
                } catch (e) { console.warn('[Keys-Hwy3D] bloom init failed', e); _composer = null; }
            }).catch((e) => console.warn('[Keys-Hwy3D] bloom modules failed', e));
            return null;
        }

        // Drop the composer + its render targets (teardown path). Nulling
        // _bloomLoad lets _bloomEnsure rebuild lazily on a later init.
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

        /* ── HUD overlay (combo / accuracy / streak — drum_highway_3d pattern) ── */
        function _injectHud() {
            if (_hudEl || !highwayCanvas) return;
            const parent = highwayCanvas.parentElement;
            if (!parent) return;
            // Position the parent relative so the absolute HUD anchors to the
            // canvas. Read-only check first so we don't clobber an existing
            // position the host page set.
            const cur = parent.style.position || getComputedStyle(parent).position;
            if (cur === 'static' || !cur) {
                _hudParentOrigPosition = parent.style.position;
                parent.style.position = 'relative';
            }
            _hudEl = document.createElement('div');
            _hudEl.className = 'keys-h3d-hud';
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
            // Only meaningful while a wired MIDI session can score — same
            // gate as the miss sweep. Without one, show nothing rather than
            // a frozen 0× combo.
            if (!_midiHandle) {
                if (_hudEl.innerHTML) _hudEl.innerHTML = '';
                return;
            }
            const total = _hits + _misses;
            const pct = total ? Math.round((_hits / total) * 100) : 0;
            const comboColor = _streak >= 30 ? '#fde047' :
                               _streak >= 10 ? '#86efac' : '#cbd5e1';
            _hudEl.innerHTML =
                `<div style="color:${comboColor};font-weight:600;font-size:18px">${_streak}× combo</div>` +
                `<div>${_hits}/${total} (${pct}%)</div>` +
                (_bestStreak ? `<div style="color:#94a3b8;font-size:11px">best ${_bestStreak}</div>` : '');
        }

        function applySize(w, h) {
            if (!ren || !cam || !w || !h) return;
            // Splitscreen: cap the base DPR harder (1.25 vs 2, mirroring
            // highway_3d) so two panels don't double the fill cost. Checks
            // the host split state (covers a mixed split with another
            // renderer) plus our own instance count (covers multi-instance
            // without host state). Before this PR no setPixelRatio was ever
            // called — HiDPI displays rendered at CSS resolution and looked
            // soft/aliased.
            const baseDPR = (_ssActive() || _instances.size > 1)
                ? Math.min(window.devicePixelRatio || 1, 1.25)
                : Math.min(window.devicePixelRatio || 1, 2);
            ren.setPixelRatio(_renderScale * baseDPR);
            ren.setSize(w, h, false);
            if (_composer) {
                // EffectComposer snapshots the renderer's pixelRatio — it must
                // be told about both ratio and box changes or bloom renders at
                // the wrong resolution.
                _composer.setPixelRatio(ren.getPixelRatio());
                _composer.setSize(w, h);
                _bloomW = w; _bloomH = h;
            }
            cam.aspect = w / h;
            cam.updateProjectionMatrix();
            // Record the logical size actually framed for, so the draw()
            // drift check can tell when the live canvas box has moved away
            // from it (PORTED FROM highway_3d).
            _appliedW = w; _appliedH = h;
            _sizeFxCanvas();
        }

        function teardown() {
            _bloomDispose();
            // HUD cleanup lives here (not only destroy): init() re-runs
            // teardown() for renderer re-initialization, possibly against a
            // different canvas — a stale _hudEl would both linger in the old
            // parent and make the next _injectHud() an early-return no-op.
            _removeHud();
            if (_fxHandler) {
                window.removeEventListener('keys3d:settings', _fxHandler);
                _fxHandler = null;
            }
            if (_fxThemeHandler) {
                window.removeEventListener('keys3d:settings', _fxThemeHandler);
                _fxThemeHandler = null;
            }
            _disposeEnv();
            _bgTeardownStyle();
            _removeFxCanvas();
            _railMats.length = 0;
            ambLight = dirLight = _floorMat = null;
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
            if (_sparkPts) {
                try { _sparkPts.geometry.dispose(); _sparkPts.material.dispose(); } catch (_) {}
                _sparkPts = null;
                _sparkPos = _sparkCol = _sparkVel = _sparkLife = null;
            }
            _laneGuideMats.length = 0;   // owned + disposed with keyboardGroup
            _hitGlowKick = 0;
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
                fx = readFxSettings();
                // Persisted string settings refresh here too — a palette,
                // camera, theme or background style saved while no instance was
                // listening (e.g. changed on the Settings screen, where the live
                // viz is torn down) must not come up stale on a later init().
                _palette = readPaletteSetting();
                _sharpMode = readSharpModeSetting();
                _camPreset = CAM_PRESETS[readCameraSetting()] || CAM_PRESETS.classic;
                _theme = readThemeSetting();
                _bgStyle = readBgStyleSetting();
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
                    _fxHandler = (ev) => {
                        const d = ev && ev.detail;
                        if (!d || !d.fx) return;
                        // FX toggles are consumed per-frame in draw() — no
                        // rebuild needed; the composer stays cached while off.
                        for (const k of Object.keys(d.fx)) {
                            if (k in FX_DEFAULTS) fx[k] = d.fx[k];
                        }
                        // Vibrancy is baked into built materials — retint
                        // the live scene without a chart rebuild.
                        if ('vibrancy' in d.fx) _applyVibrancy();
                        if ('cinematic' in d.fx) _applyCinematic();
                        if ('bgIntensity' in d.fx) _bgMountStyle();
                        if ('glow' in d.fx) {
                            // Material emissive bases are also per-frame
                            // (updateScene) — only the cached/cloned rest
                            // values need a nudge here.
                            const base = NOTE_EMISSIVE_BASE * _glowMul();
                            for (const m of _noteMatCache.values()) m.emissiveIntensity = base;
                        }
                    };
                    _fxThemeHandler = (ev) => {
                        const d = ev && ev.detail;
                        if (d && d.theme && BG_THEMES[d.theme]) {
                            _theme = d.theme;
                            _applyTheme();
                        }
                        if (d && d.bgStyle && BG_STYLE_IDS.indexOf(d.bgStyle) !== -1) {
                            _bgStyle = d.bgStyle;
                            _bgMountStyle();
                        }
                        if (d && d.palette && PALETTE_IDS.indexOf(d.palette) !== -1) {
                            _palette = d.palette;
                            _applyPalette();
                        }
                        if (d && d.sharpMode && SHARP_MODES.indexOf(d.sharpMode) !== -1) {
                            // Geometry-time — takes effect on the next chart build.
                            _sharpMode = d.sharpMode;
                        }
                        if (d && d.camera && CAM_PRESETS[d.camera]) {
                            _camPreset = CAM_PRESETS[d.camera];
                            // Position/lookAt re-derive next frame; only the
                            // projection needs an explicit poke.
                            if (cam) {
                                cam.fov = _camPreset.fov;
                                cam.updateProjectionMatrix();
                            }
                        }
                    };
                    window.addEventListener('keys3d:settings', _fxThemeHandler);
                    window.addEventListener('keys3d:settings', _fxHandler);
                    _injectHud();
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
                    // Re-apply size now that this instance is counted in
                    // _instances: the applySize above ran before the add, so
                    // its splitscreen DPR check (size > 1) undercounted — the
                    // second panel of a splitscreen mount would otherwise keep
                    // full 2x DPR until some later resize. The already-mounted
                    // panel is corrected by the host's own layout resize when
                    // the split activates (panels change box size).
                    if (_instances.size > 1 || _ssActive()) {
                        applySize(highwayCanvas.clientWidth, highwayCanvas.clientHeight);
                    }
                    _midiInit();
                    _midiResume();
                }).catch(() => {
                    _emitDomain('renderer-failed', { providerId: 'keys_highway_3d', reason: 'three load failed' });
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
                const now = (bundle && typeof bundle.currentTime === 'number') ? bundle.currentTime : 0;
                if (_notation) updateScene(now);
                _animateFeedback(performance.now());
                // Wall-clock FX step (sparks, hit-line kick decay) —
                // decoupled from song time so effects settle while paused.
                {
                    const nowMs = performance.now();
                    const fdt = _fxLastWall === 0 ? 1 / 60 : Math.min(0.05, (nowMs - _fxLastWall) / 1000);
                    _fxLastWall = nowMs;
                    _sparkUpdate(fdt);
                    if (_hitGlowKick > 0.001) _hitGlowKick *= Math.exp(-fdt * 6);
                    else if (_hitGlowKick !== 0) _hitGlowKick = 0;
                    // Background ambience: advance the active style with the
                    // audio bands (zeros when reactivity is off).
                    if (_bgState && _bgState.s && BG_STYLES[_bgState._style]) {
                        const bands = fx.bgReactive ? _bgReadBands() : BG_ZERO_BANDS;
                        try {
                            BG_STYLES[_bgState._style].update(_bgState.s, bands, fdt, nowMs / 1000);
                        } catch (_) { /* visual-only */ }
                    }
                }
                _refreshHud();
                if (fx.scoreFx) { _ensureFxCanvas(); _drawScoreFx(); }
                else if (_fxCtx && _fxCanvas && _fxCanvas._dirty) {
                    _fxCtx.clearRect(0, 0, _fxCanvas.width, _fxCanvas.height);
                    _fxCanvas._dirty = false;
                }
                // Bloom path (PORTED FROM highway_3d): composer + ACES tone
                // mapping when enabled and single-instance; direct render
                // otherwise (including the frames while addons stream in).
                const comp = _bloomGateOk() ? _bloomEnsure() : null;
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
                // event on its `if (!_activeInstance) return` guard.
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
    // slopsmith→feedBack rename: host viz picker looks up `window.feedBackViz_<id>`.
    window.feedBackViz_keys_highway_3d = window.slopsmithViz_keys_highway_3d;
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
        readFxSettings,
        readThemeSetting,
        readBgStyleSetting,
        readPaletteSetting,
        readCameraSetting,
        readSharpModeSetting,
        SHARP_MODES,
        _bgThemeColors,
        BG_THEMES,
        BG_STYLE_IDS,
        NOTE_PALETTES,
        PITCH_CLASS_COLORS,
        PALETTE_IDS,
        OCTAVE_HUES,
        octaveNoteColor,
        _isBlackPc,
        laneSpanFlat,
        laneSpanReal,
        CAM_PRESETS,
        FX_DEFAULTS,
        FX_RANGES,
        _classifyTiming,
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
