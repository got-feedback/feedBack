// Behavioral harness for the host `window.feedBack.workingTuning` capability
// (static/capabilities/working-tuning.js) — the per-instrument, in-memory current
// tuning. Runs the real capability in a stubbed window (same strategy as
// midi_input_domain.test.js) with a controllable fetch, and asserts the per-instrument
// state machine: isolated guitar/bass slots, selector switch, defensive copies, the
// provenance/verification invariant, unambiguous key routing, named-tuning seeding, and
// the boot-race guard.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createWindow, ROOT } = require('./capabilities_test_harness');

const CAPABILITIES_JS = path.join(ROOT, 'static', 'capabilities.js');
const WORKING_TUNING_JS = path.join(ROOT, 'static', 'capabilities', 'working-tuning.js');

// Tuning frequency fixture at 440 Hz, enough to resolve names to offsets.
const TUNING_TABLE = {
    'guitar-6': {
        Standard: [82.41, 110.00, 146.83, 196.00, 246.94, 329.63],
        'Drop D': [73.42, 110.00, 146.83, 196.00, 246.94, 329.63],
    },
    'bass-5': {
        Standard: [30.87, 41.20, 55.00, 73.42, 98.00],
    },
};
const API_TUNINGS = { referencePitch: 440, tunings: TUNING_TABLE };

function deferred() {
    let resolve;
    const promise = new Promise((r) => { resolve = r; });
    return { promise, resolve };
}

// `routes` maps a URL to: a plain JSON value (served as {ok:true}), a thenable that
// resolves to a full response object (for deferral/races), or nothing (served {ok:false}).
function loadWorkingTuning(routes = {}) {
    const window = createWindow();
    const changes = [];
    window.fetch = function (url) {
        const entry = routes[url];
        if (entry && typeof entry.then === 'function') return entry;
        if (entry !== undefined) return Promise.resolve({ ok: true, json: () => Promise.resolve(entry) });
        return Promise.resolve({ ok: false, json: () => Promise.resolve(null) });
    };
    const context = vm.createContext(window);
    vm.runInContext(fs.readFileSync(CAPABILITIES_JS, 'utf8'), context, { filename: CAPABILITIES_JS });
    vm.runInContext(fs.readFileSync(WORKING_TUNING_JS, 'utf8'), context, { filename: WORKING_TUNING_JS });
    // capabilities.js replaces window.feedBack with an EventTarget bus — subscribe on it,
    // not on window. Attaching after load still catches the async hydration event.
    window.feedBack.on('working-tuning-changed', (ev) => changes.push(ev.detail));
    return { window, wt: window.feedBack.workingTuning, changes };
}

// Rebase a possibly-vm-realm array into this realm so deepStrictEqual compares by value,
// not by (cross-realm) Array.prototype identity.
const nums = (a) => (a == null ? a : Array.from(a));

// Drain the seed's fetch/promise chain (settings -> tunings -> hydrate).
const flush = async () => { for (let i = 0; i < 4; i++) await new Promise((r) => setImmediate(r)); };

test('registers a working-tuning exclusive-owner capability + versioned surface', () => {
    const { window, wt } = loadWorkingTuning();
    assert.equal(wt.version, 1);
    const pipeline = window.feedBack.capabilities.inspect('working-tuning');
    assert.ok(pipeline, 'working-tuning pipeline exists');
    const owner = (pipeline.participants || []).find((p) => p.pluginId === 'core.working-tuning');
    assert.ok(owner, 'core.working-tuning owner registered');
    for (const op of ['get-working-tuning', 'set-working-tuning']) {
        assert.ok(owner.operations.includes(op), `owner exposes ${op}`);
    }
});

test('get() defaults to a synchronous guitar-6 assumed seed before hydration', () => {
    const { wt } = loadWorkingTuning();
    const s = wt.get();
    assert.equal(s.instrument, 'guitar');
    assert.equal(s.stringCount, 6);
    assert.equal(s.provenance, 'assumed');
    assert.equal(s.offsets, null);
});

test('per-instrument slots are isolated; the selector surfaces the right one', async () => {
    const { wt } = loadWorkingTuning();
    await flush();
    wt.set({ offsets: [-2, 0, 0, 0, 0, 0] }, { instrument: 'guitar-6' });
    wt.set({ offsets: [0, 0, 0, 0] }, { instrument: 'bass-4' });
    assert.deepEqual(nums(wt.get('guitar-6').offsets), [-2, 0, 0, 0, 0, 0]);
    assert.deepEqual(nums(wt.get('bass-4').offsets), [0, 0, 0, 0]);
    // Selecting an instrument makes get() (no arg) return that instrument's own state.
    wt.setCurrentInstrument('guitar', 6);
    assert.deepEqual(nums(wt.get().offsets), [-2, 0, 0, 0, 0, 0]);
    wt.setCurrentInstrument('bass', 4);
    assert.deepEqual(nums(wt.get().offsets), [0, 0, 0, 0]);
});

test('defensive copies: readers and post-set callers cannot mutate live state', async () => {
    const { wt } = loadWorkingTuning();
    await flush();
    const input = [-2, -2, -2, -2, -2, -2];
    wt.set({ offsets: input }, { instrument: 'guitar-6' });
    input[0] = 99;                                   // mutate caller's array after set()
    assert.deepEqual(nums(wt.get('guitar-6').offsets), [-2, -2, -2, -2, -2, -2], 'set() stored a copy');
    const read = wt.get('guitar-6');
    read.offsets[0] = 99;                            // mutate a returned copy
    assert.deepEqual(nums(wt.get('guitar-6').offsets), [-2, -2, -2, -2, -2, -2], 'get() returned a copy');
});

test('verification invariant: verified <=> we hold verifiedStrings', async () => {
    const { wt } = loadWorkingTuning();
    await flush();
    // A complete verified bundle stamps verified + a timestamp.
    let s = wt.set({ offsets: [0, 0, 0, 0, 0, 0], verifiedStrings: [1, 1, 1, 1, 1, 1] },
        { instrument: 'guitar-6', provenance: 'verified' });
    assert.equal(s.provenance, 'verified');
    assert.deepEqual(nums(s.verifiedStrings), [1, 1, 1, 1, 1, 1]);
    assert.equal(typeof s.verifiedAt, 'number');

    // Claiming verified on a tuning change WITHOUT fresh strings is impossible — it
    // fails toward assumed and drops the metadata (no "verified with null strings").
    s = wt.set({ offsets: [-2, 0, 0, 0, 0, 0] }, { instrument: 'guitar-6', provenance: 'verified' });
    assert.equal(s.provenance, 'assumed');
    assert.equal(s.verifiedStrings, null);
    assert.equal(s.verifiedAt, null);

    // verified always carries a real timestamp — an explicit verifiedAt:null is stamped now.
    s = wt.set({ verifiedStrings: [1, 1, 1, 1, 1, 1], verifiedAt: null },
        { instrument: 'guitar-6', provenance: 'verified' });
    assert.equal(s.provenance, 'verified');
    assert.equal(typeof s.verifiedAt, 'number');
});

test('a tuning change invalidates a prior verification', async () => {
    const { wt } = loadWorkingTuning();
    await flush();
    wt.set({ offsets: [0, 0, 0, 0, 0, 0], verifiedStrings: [1, 1, 1, 1, 1, 1] },
        { instrument: 'guitar-6', provenance: 'verified' });
    const s = wt.set({ offsets: [-2, 0, 0, 0, 0, 0] }, { instrument: 'guitar-6' });
    assert.equal(s.provenance, 'assumed');
    assert.equal(s.verifiedStrings, null);
    assert.equal(s.verifiedAt, null);
});

test('bare-instrument writes target the current selection, not a hard-coded default', async () => {
    const { wt } = loadWorkingTuning();
    await flush();
    wt.setCurrentInstrument('bass', 5);              // a 5-string bass is selected
    // A bare instrument string must write bass-5, not bass-4.
    wt.set({ offsets: [0, 0, 0, 0, 0] }, { instrument: 'bass' });
    assert.deepEqual(nums(wt.get('bass-5').offsets), [0, 0, 0, 0, 0]);
    assert.equal(wt.get('bass-4').offsets, null, 'bass-4 slot untouched');
    // A bare stringCount (no instrument) applies to the selected instrument.
    const s = wt.set({ stringCount: 5, offsets: [-1, -1, -1, -1, -1] });
    assert.equal(s.instrument, 'bass');
    assert.equal(s.stringCount, 5);
});

test('seed resolves a NAMED tuning to offsets via /api/tunings', async () => {
    const { wt, changes } = loadWorkingTuning({
        '/api/settings': { instrument: 'guitar', string_count: 6, tuning: 'Drop D', reference_pitch: 440 },
        '/api/tunings': API_TUNINGS,
    });
    await flush();
    const s = wt.get('guitar-6');
    assert.deepEqual(nums(s.offsets), [-2, 0, 0, 0, 0, 0], 'Drop D resolved to a -2 low string');
    assert.equal(s.source, 'settings');
    assert.equal(s.provenance, 'assumed');
    // Hydration emitted once, carrying the seeded instrument.
    const hydrations = changes.filter((c) => c.instrument === 'guitar');
    assert.ok(hydrations.length >= 1, 'a working-tuning-changed fired for the seeded instrument');
});

test('seed accepts an offsets-list tuning directly', async () => {
    const { wt } = loadWorkingTuning({
        '/api/settings': { instrument: 'bass', string_count: 4, tuning: [-2, 0, 0, 0] },
    });
    await flush();
    assert.deepEqual(nums(wt.get('bass-4').offsets), [-2, 0, 0, 0]);
});

test('boot race: an explicit set() before settings resolve is not clobbered by the seed', async () => {
    const settings = deferred();
    const { wt } = loadWorkingTuning({
        '/api/settings': settings.promise,           // held open
        '/api/tunings': API_TUNINGS,
    });
    // A consumer writes before the seed lands.
    wt.set({ offsets: [-5, -5, -5, -5, -5, -5] }, { instrument: 'guitar-6' });
    // Now the seed resolves with a DIFFERENT tuning.
    settings.resolve({ ok: true, json: () => Promise.resolve({ instrument: 'guitar', string_count: 6, tuning: 'Drop D' }) });
    await flush();
    assert.deepEqual(nums(wt.get('guitar-6').offsets), [-5, -5, -5, -5, -5, -5], 'explicit write survived the seed');
});

test('resetToDefault clears a slot back to its baseline and emits', async () => {
    const { wt, changes } = loadWorkingTuning();
    await flush();
    wt.set({ offsets: [-2, -2, -2, -2, -2, -2] }, { instrument: 'guitar-6', provenance: 'verified', verifiedStrings: [1, 1, 1, 1, 1, 1] });
    const before = changes.length;
    const s = wt.resetToDefault('guitar-6');
    assert.equal(s.offsets, null);
    assert.equal(s.provenance, 'assumed');
    assert.equal(s.verifiedStrings, null);
    assert.ok(changes.length > before, 'reset emitted working-tuning-changed');
});
