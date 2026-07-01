// Pure data-layer tests: load screen.js in a bare vm window and exercise the
// __test exports (no DOM, no WebGL, no network). Doubles as a lint that no
// module-scope code touches document/localStorage outside a try/catch —
// the vm window deliberately provides neither.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function load() {
    const window = {
        console,
        location: { protocol: 'http:', host: 'localhost' },
        slopsmith: {},
    };
    window.window = window;
    window.globalThis = window;
    const context = vm.createContext(window);
    const src = fs.readFileSync(path.join(__dirname, '..', 'screen.js'), 'utf8');
    vm.runInContext(src, context, { filename: 'screen.js' });
    return window.slopsmithViz_drum_highway_3d;
}

test('module loads in a bare vm (no DOM / localStorage at module scope)', () => {
    const factory = load();
    assert.equal(typeof factory, 'function');
    assert.equal(factory.contextType, 'webgl2');
});

test('_variantForHit: ghost > flam > bell > accent > normal precedence', () => {
    const { _variantForHit } = load().__test;
    assert.equal(_variantForHit({ g: true, f: true, v: 120 }), 'ghost');
    assert.equal(_variantForHit({ f: true, v: 120 }), 'flam');
    assert.equal(_variantForHit({ p: 'ride_bell' }), 'bell');
    assert.equal(_variantForHit({ v: 100 }), 'accent');
    assert.equal(_variantForHit({ v: 127 }), 'accent');
    assert.equal(_variantForHit({ v: 99 }), 'normal');
    // Missing velocity defaults to 100 → accent.
    assert.equal(_variantForHit({}), 'accent');
});

test('matchesArrangement: claims drum arrangements', () => {
    const matches = load().matchesArrangement;
    assert.equal(matches({ has_drum_tab: true, arrangement: 'Drums' }), true);
    assert.equal(matches({ has_drum_tab: true, arrangement: 'Drum Kit' }), true);
    assert.equal(matches({ has_drum_tab: true, arrangement: 'Percussion' }), true);
});

test('matchesArrangement: never claims without a drum tab', () => {
    const matches = load().matchesArrangement;
    assert.equal(matches(null), false);
    assert.equal(matches({}), false);
    assert.equal(matches({ arrangement: 'Drums' }), false);
});

test('matchesArrangement: steal-guard — guitar arrangements stay with highway_3d', () => {
    const matches = load().matchesArrangement;
    // Full-band pack (drum_tab present) playing a guitar-family part:
    // first-match-wins Auto order must not hand these to the drum highway.
    for (const arr of ['Lead', 'Rhythm', 'Bass', 'Combo', 'Guitar 22', 'Alt. Lead']) {
        assert.equal(matches({ has_drum_tab: true, arrangement: arr }), false, arr);
    }
    // Keys notation present → the keys/staff viz take it.
    assert.equal(matches({ has_drum_tab: true, has_notation: true, arrangement: 'Piano' }), false);
});

test('matchesArrangement: claims packs nothing more specific can render', () => {
    const matches = load().matchesArrangement;
    // Drum tab + nondescript arrangement, no notation → drummable, claim it.
    assert.equal(matches({ has_drum_tab: true, arrangement: '' }), true);
    assert.equal(matches({ has_drum_tab: true }), true);
    // Word-boundary check: "BasslineKeys"-style names don't contain a
    // guitar-family word as a whole word.
    assert.equal(matches({ has_drum_tab: true, arrangement: 'Bassline' }), true);
});

test('readFxSettings: defaults survive a localStorage-less environment', () => {
    const { readFxSettings, FX_DEFAULTS } = load().__test;
    // The vm window has no localStorage — the try/catch must eat the
    // ReferenceError and hand back pure defaults (everything ON).
    assert.deepEqual(readFxSettings(), FX_DEFAULTS);
    assert.equal(FX_DEFAULTS.bloom, true);
});

test('MIDI map: open hi-hat is a first-class piece (46 → hh_open)', () => {
    const { MIDI_TO_PIECE, HIT_TOLERANCE_S } = load().__test;
    assert.equal(MIDI_TO_PIECE[46], 'hh_open');
    assert.equal(MIDI_TO_PIECE[42], 'hh_closed');
    assert.equal(MIDI_TO_PIECE[35], 'kick');
    assert.equal(MIDI_TO_PIECE[36], 'kick');
    // ±50 ms window matches the 2D drums plugin.
    assert.equal(HIT_TOLERANCE_S, 0.05);
});

test('_classifyTiming: OK band is 40% of the window, sign maps early/late', () => {
    const { _classifyTiming, HIT_TOLERANCE_S } = load().__test;
    const tol = HIT_TOLERANCE_S;         // 0.05
    assert.equal(_classifyTiming(0, tol), 'OK');
    assert.equal(_classifyTiming(tol * 0.4, tol), 'OK');    // boundary inclusive
    assert.equal(_classifyTiming(-tol * 0.4, tol), 'OK');
    // delta = note.t - now: positive → struck before the note → EARLY.
    assert.equal(_classifyTiming(tol * 0.41, tol), 'EARLY');
    assert.equal(_classifyTiming(-tol * 0.41, tol), 'LATE');
    assert.equal(_classifyTiming(tol, tol), 'EARLY');
    assert.equal(_classifyTiming(-tol, tol), 'LATE');
    // Degenerate inputs read as on-time rather than throwing.
    assert.equal(_classifyTiming(NaN, tol), 'OK');
});

test('FX defaults: hit-FX controls ship enabled', () => {
    const { FX_DEFAULTS } = load().__test;
    assert.equal(FX_DEFAULTS.sparks, true);
    assert.equal(FX_DEFAULTS.timingFx, true);
    assert.equal(FX_DEFAULTS.streakFx, true);
    assert.equal(FX_DEFAULTS.hitFx, 0.7);
});

test('themes: table ids match the guitar highway, default is the stock palette', () => {
    const { BG_THEMES, _bgThemeColors } = load().__test;
    // Same id set as highway_3d's BG_THEMES (cross-instrument consistency).
    assert.deepEqual(Object.keys(BG_THEMES), [
        'default', 'midnight', 'charcoal', 'deeppurple', 'forest', 'warmslate',
        'deepfocus', 'deepsea', 'cathode', 'cathodegreen', 'hearth',
    ]);
    // 'default' preserves THIS plugin's original look byte-for-byte.
    assert.equal(BG_THEMES.default.clear, 0x1a1a2e);
    assert.equal(BG_THEMES.default.board, 0x0a0e1a);
    assert.equal(BG_THEMES.default.lane, undefined); // stock stripes fallback
    // Unknown ids fall back to default.
    assert.equal(_bgThemeColors('nonsense'), BG_THEMES.default);
    // Every non-default theme carries a lane pair (the axis differentiator).
    for (const [id, t] of Object.entries(BG_THEMES)) {
        if (id === 'default') continue;
        assert.ok(t.lane != null && t.laneDim != null, id + ' lane pair');
        assert.equal(t.clear, t.fog, id + ' clear==fog (horizon dissolve)');
    }
});

test('readThemeSetting: defaults without localStorage; validates ids', () => {
    const { readThemeSetting } = load().__test;
    assert.equal(readThemeSetting(), 'default');
});

test('FX defaults: theme-PR controls ship enabled at stock-neutral values', () => {
    const { FX_DEFAULTS } = load().__test;
    assert.equal(FX_DEFAULTS.cinematic, true);
    assert.equal(FX_DEFAULTS.glow, 0.5);      // 0.5 = 1.0x multiplier (stock)
    assert.equal(FX_DEFAULTS.vibrancy, 0.85); // ≈ the stock 0.32 stripe base
});
