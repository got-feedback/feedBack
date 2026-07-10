// Pure data-layer tests: load screen.js in a bare vm window and exercise the
// __test exports (no DOM, no WebGL, no network).
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
    return window.slopsmithViz_keys_highway_3d.__test;
}

test('beatDurSec: base, dotted, double-dotted, tuplet', () => {
    const { beatDurSec } = load();
    // 120 BPM → quarter = 0.5s
    assert.equal(beatDurSec({ dur: 4 }, 120), 0.5);
    assert.equal(beatDurSec({ dur: 2 }, 120), 1.0);
    assert.equal(beatDurSec({ dur: 8 }, 120), 0.25);
    // dotted quarter = 0.75s; double-dotted = 0.875s
    assert.equal(beatDurSec({ dur: 4, dot: 1 }, 120), 0.75);
    assert.equal(beatDurSec({ dur: 4, dot: 2 }, 120), 0.875);
    // triplet eighth: 0.25 * 2/3
    assert.ok(Math.abs(beatDurSec({ dur: 8, tu: [3, 2] }, 120) - 0.25 * 2 / 3) < 1e-9);
    // invalid → null
    assert.equal(beatDurSec({ dur: 0 }, 120), null);
    assert.equal(beatDurSec({ dur: 4 }, null), null);
});

function measure(idx, t, opts = {}) {
    return { idx, t, ...opts };
}

test('flattenNotation: basic two-hand flatten, sorted, durSec from tempo', () => {
    const { flattenNotation } = load();
    const notes = flattenNotation([
        {
            idx: 1, t: 0, tempo: 120,
            staves: {
                rh: { voices: [{ v: 1, beats: [
                    { t: 0.5, dur: 4, notes: [{ midi: 64 }] },
                    { t: 1.0, dur: 8, notes: [{ midi: 67 }] },
                ] }] },
                lh: { voices: [{ v: 1, beats: [
                    { t: 0.0, dur: 2, notes: [{ midi: 48 }] },
                ] }] },
            },
        },
    ]);
    assert.equal(notes.length, 3);
    assert.deepEqual(JSON.parse(JSON.stringify(notes.map(n => n.midi))), [48, 64, 67]); // time-sorted
    assert.equal(notes[0].hand, 'lh');
    assert.equal(notes[0].durSec, 1.0);   // half at 120
    assert.equal(notes[1].durSec, 0.5);   // quarter
    assert.equal(notes[2].durSec, 0.25);  // eighth
    assert.equal(notes[1].measureIdx, 1);
});

test('flattenNotation: tempo state carries across measures and changes apply', () => {
    const { flattenNotation } = load();
    const notes = flattenNotation([
        measure(1, 0, { tempo: 120, staves: { rh: { voices: [{ v: 1, beats: [{ t: 0, dur: 4, notes: [{ midi: 60 }] }] }] } } }),
        measure(2, 2, { staves: { rh: { voices: [{ v: 1, beats: [{ t: 2, dur: 4, notes: [{ midi: 62 }] }] }] } } }),
        measure(3, 4, { tempo: 60, staves: { rh: { voices: [{ v: 1, beats: [{ t: 4, dur: 4, notes: [{ midi: 64 }] }] }] } } }),
    ]);
    assert.equal(notes[0].durSec, 0.5); // 120 BPM
    assert.equal(notes[1].durSec, 0.5); // tempo carried
    assert.equal(notes[2].durSec, 1.0); // 60 BPM
});

test('flattenNotation: tied notes extend instead of emitting a new block', () => {
    const { flattenNotation } = load();
    const notes = flattenNotation([
        {
            idx: 1, t: 0, tempo: 120,
            staves: { rh: { voices: [{ v: 1, beats: [
                { t: 0.0, dur: 2, notes: [{ midi: 60 }] },
                { t: 1.0, dur: 2, notes: [{ midi: 60, tied: true }] },
            ] }] } },
        },
    ]);
    assert.equal(notes.length, 1);
    assert.equal(notes[0].durSec, 2.0); // half + tied half
});

test('flattenNotation: no tempo anywhere falls back to next-onset gap', () => {
    const { flattenNotation } = load();
    const notes = flattenNotation([
        {
            idx: 1, t: 0,
            staves: { rh: { voices: [{ v: 1, beats: [
                { t: 0.0, dur: 4, notes: [{ midi: 60 }] },
                { t: 0.8, dur: 4, notes: [{ midi: 62 }] },
            ] }] } },
        },
    ]);
    assert.ok(Math.abs(notes[0].durSec - 0.8) < 1e-9);
    assert.equal(notes[1].durSec, 2.0); // final-beat fallback
});

test('flattenNotation: overlap clamp against next same-hand same-midi onset', () => {
    const { flattenNotation } = load();
    const notes = flattenNotation([
        {
            idx: 1, t: 0, tempo: 30, // whole note = 8s — way past the next onset
            staves: { rh: { voices: [{ v: 1, beats: [
                { t: 0.0, dur: 1, notes: [{ midi: 60 }] },
                { t: 1.0, dur: 1, notes: [{ midi: 60 }] },
            ] }] } },
        },
    ]);
    assert.equal(notes[0].durSec, 1.0); // clamped to next onset
});

test('flattenNotation: rests, malformed beats, and out-of-range midi are skipped', () => {
    const { flattenNotation } = load();
    const notes = flattenNotation([
        {
            idx: 1, t: 0, tempo: 120,
            staves: { rh: { voices: [{ v: 1, beats: [
                { t: 0.0, dur: 4, rest: true },
                { t: 0.5, dur: 4, notes: [{ midi: 200 }] },
                null,
                { t: 1.0, dur: 4, notes: [{ midi: 64 }] },
            ] }] } },
        },
    ]);
    assert.equal(notes.length, 1);
    assert.equal(notes[0].midi, 64);
});

test('keyRange pads and clamps to the 88-key piano, keeps active span explicit', () => {
    const { keyRange } = load();
    assert.deepEqual(
        JSON.parse(JSON.stringify(keyRange([{ midi: 60 }, { midi: 72 }]))),
        { low: 58, high: 74, activeLow: 60, activeHigh: 72 },
    );
    // At the clamp edges the active span still reflects the chart extremes
    // (not low+pad — that would mark A0/C8 inactive when actually played).
    assert.deepEqual(
        JSON.parse(JSON.stringify(keyRange([{ midi: 21 }, { midi: 108 }]))),
        { low: 21, high: 108, activeLow: 21, activeHigh: 108 },
    );
    const empty = keyRange([]);
    assert.ok(empty.low < 60 && empty.high > 60);
    assert.ok(empty.activeLow > empty.activeHigh, 'empty chart has an empty active span');
});

test('noteLetter maps midi to pitch-class letters', () => {
    const { noteLetter } = load();
    assert.equal(noteLetter(60), 'C');
    assert.equal(noteLetter(61), 'C#');
    assert.equal(noteLetter(69), 'A');
    assert.equal(noteLetter(71), 'B');
    assert.equal(noteLetter(72), 'C');  // octave wraps
    assert.equal(noteLetter(21), 'A');  // A0
});

test('scrollZ: events sit at hitZ exactly at their time and approach from -Z', () => {
    const { scrollZ } = load();
    const hitZ = -0.5, speed = 2.0;
    // At now === eventT the event is exactly on the hit-line.
    assert.equal(scrollZ(10, 10, hitZ, speed), hitZ);
    // 1s before its time it is `speed` units further away (towards -Z).
    assert.equal(scrollZ(10, 9, hitZ, speed), hitZ - speed);
    // After its time it has moved past the hit-line (towards +Z).
    assert.equal(scrollZ(10, 11, hitZ, speed), hitZ + speed);
    // Marker and note-front-edge maths agree by construction: a note of
    // length L positioned at scrollZ(t) - L/2 has its front edge at
    // scrollZ(t).
    const len = 0.8;
    assert.equal(scrollZ(10, 10, hitZ, speed) - len / 2 + len / 2, hitZ);
});

test('measureMarkers extracts idx/t pairs', () => {
    const { measureMarkers } = load();
    assert.deepEqual(
        JSON.parse(JSON.stringify(measureMarkers([{ idx: 1, t: 0 }, { idx: 2, t: 2.5 }, { bogus: true }]))),
        [{ idx: 1, t: 0 }, { idx: 2, t: 2.5 }],
    );
});

test('_pickMidiTarget: no plugin-local pick defers to the domain-wide selection, not "first device"', () => {
    const { _pickMidiTarget } = load();
    const inputs = [
        { id: 'a', name: 'Device A', key: 'web-midi::a' },
        { id: 'b', name: 'Device B', key: 'web-midi::b' },
    ];
    // Fresh install / never picked here — must use the Input Setup global,
    // NOT fall through to inputs[0].
    const target = _pickMidiTarget(inputs, null, 'web-midi::b', true);
    assert.equal(target.id, 'b');
});

test('_pickMidiTarget: the domain-wide selection is the source of truth — it wins over a stale plugin-local pick', () => {
    const { _pickMidiTarget } = load();
    const inputs = [
        { id: 'a', name: 'Device A', key: 'web-midi::a' },
        { id: 'b', name: 'Device B', key: 'web-midi::b' },
    ];
    // A stale local pick (e.g. left by a pre-fix build's auto-connect) must
    // NOT override the device the user configured in Settings → Input Setup.
    const target = _pickMidiTarget(inputs, { id: 'a', name: 'Device A', key: 'web-midi::a' }, 'web-midi::b', true);
    assert.equal(target.id, 'b');
});

test('_pickMidiTarget: local pick is used as a fallback when no global is configured', () => {
    const { _pickMidiTarget } = load();
    const inputs = [
        { id: 'a', name: 'Device A', key: 'web-midi::a' },
        { id: 'b', name: 'Device B', key: 'web-midi::b' },
    ];
    const target = _pickMidiTarget(inputs, { id: 'a', name: 'Device A', key: 'web-midi::a' }, null, true);
    assert.equal(target.id, 'a');
});

test('_pickMidiTarget: local pick name-recovers when its logicalSourceKey went stale (id regeneration)', () => {
    const { _pickMidiTarget } = load();
    // Same physical device, new id/key across a reload; the saved key/id miss
    // but the name still matches.
    const inputs = [{ id: 'a2', name: 'Device A', key: 'web-midi::a2' }];
    const target = _pickMidiTarget(inputs, { id: 'a1', name: 'Device A', key: 'web-midi::a1' }, null, true);
    assert.equal(target.id, 'a2');
});

test('_pickMidiTarget: domain-wide selection is ignored if it names a blocklisted loopback port', () => {
    const { _pickMidiTarget } = load();
    const inputs = [
        { id: 'thru', name: 'IAC Driver Bus 1', key: 'web-midi::thru' },
        { id: 'b', name: 'Device B', key: 'web-midi::b' },
    ];
    const target = _pickMidiTarget(inputs, null, 'web-midi::thru', true);
    assert.equal(target.id, 'b'); // falls through to the first non-loopback device
});

test('_pickMidiTarget: when every present device is a loopback, connect to nothing (never a dead port)', () => {
    const { _pickMidiTarget } = load();
    const inputs = [
        { id: 'thru', name: 'MIDI Through Port-0', key: 'web-midi::thru' },
        { id: 'iac', name: 'IAC Driver Bus 1', key: 'web-midi::iac' },
    ];
    // No non-loopback device exists — must NOT fall back to inputs[0] (a port
    // that carries no input and would silently eat every note).
    const target = _pickMidiTarget(inputs, null, null, true);
    assert.equal(target, null);
});

test('_pickMidiTarget: explicit "None" opt-out still wins over any global default', () => {
    const { _pickMidiTarget } = load();
    const inputs = [{ id: 'a', name: 'Device A', key: 'web-midi::a' }];
    const target = _pickMidiTarget(inputs, { id: '', name: '' }, 'web-midi::a', true);
    assert.equal(target, null);
});

test('_pickMidiTarget: a present global wins even during hotplug recovery', () => {
    const { _pickMidiTarget } = load();
    const inputs = [{ id: 'b', name: 'Device B', key: 'web-midi::b' }];
    // The configured global device is present — reconnect to it, don't bail.
    const target = _pickMidiTarget(inputs, null, 'web-midi::b', false);
    assert.equal(target.id, 'b');
});

test('_pickMidiTarget: recovery (allowFallback=false) preserves an absent configured device instead of grabbing a random one', () => {
    const { _pickMidiTarget } = load();
    const inputs = [{ id: 'b', name: 'Device B', key: 'web-midi::b' }];
    // The configured device ('x', global) is currently unplugged; a transient
    // recovery must NOT switch to the unrelated device that is present.
    const target = _pickMidiTarget(inputs, null, 'web-midi::x', false);
    assert.equal(target, null);
});

test('_pickMidiTarget: recovery with no preference at all still allows a first-hotplug grab', () => {
    const { _pickMidiTarget } = load();
    const inputs = [{ id: 'b', name: 'Device B', key: 'web-midi::b' }];
    const target = _pickMidiTarget(inputs, null, null, false);
    assert.equal(target.id, 'b');
});
