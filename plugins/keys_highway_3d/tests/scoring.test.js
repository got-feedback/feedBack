// Pure MIDI-scoring tests: load screen.js in a bare vm window and exercise
// the __test exports (no DOM, no WebGL, no MIDI device, no network).
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

const TOL = 0.10;

test('accuracyOf/scoreOf mirror the notedetect stats formula', () => {
    const { accuracyOf, scoreOf } = load();
    // accuracy = hits / max(1, hits + misses)
    assert.equal(accuracyOf(0, 0), 0);
    assert.equal(accuracyOf(10, 0), 1);
    assert.equal(accuracyOf(3, 1), 0.75);
    // score = round(hits * 100 * accuracy)
    assert.equal(scoreOf(0, 0), 0);
    assert.equal(scoreOf(10, 0), 1000);
    assert.equal(scoreOf(3, 1), Math.round(3 * 100 * 0.75));
    // Monotonic in accuracy at fixed hits.
    assert.ok(scoreOf(5, 0) > scoreOf(5, 5));
});

test('judgeHit: exact note inside ±0.10 s window hits; outside misses', () => {
    const { judgeHit } = load();
    const notes = [
        { midi: 60, t: 1.0 },
        { midi: 64, t: 1.0 },
        { midi: 62, t: 2.0 },
    ];
    const hitKeys = new Set();
    // On time.
    assert.equal(judgeHit(notes, 60, 1.0, hitKeys, TOL), '1.000|60');
    // Near the edge of the window (the exact ±0.10 boundary is float-
    // representation dependent, same as the piano plugin).
    assert.equal(judgeHit(notes, 62, 2.099, hitKeys, TOL), '2.000|62');
    assert.equal(judgeHit(notes, 64, 0.901, hitKeys, TOL), '1.000|64');
    // Just outside the window.
    assert.equal(judgeHit(notes, 60, 1.11, hitKeys, TOL), null);
    // Wrong note — nothing at that midi anywhere near.
    assert.equal(judgeHit(notes, 65, 1.0, hitKeys, TOL), null);
});

test('judgeHit: dedupes by t|midi — a chart note can only be hit once', () => {
    const { judgeHit } = load();
    const notes = [{ midi: 60, t: 1.0 }, { midi: 60, t: 1.15 }];
    const hitKeys = new Set();
    const first = judgeHit(notes, 60, 1.02, hitKeys, TOL);
    assert.equal(first, '1.000|60');
    hitKeys.add(first);
    // Second strike near the same time falls through to the NEXT un-hit
    // chart note at the same midi (double-stop repeats).
    const second = judgeHit(notes, 60, 1.06, hitKeys, TOL);
    assert.equal(second, '1.150|60');
    hitKeys.add(second);
    // Third strike: both consumed → wrong note.
    assert.equal(judgeHit(notes, 60, 1.1, hitKeys, TOL), null);
});

test('judgeHit: empty/absent chart never judges', () => {
    const { judgeHit } = load();
    assert.equal(judgeHit([], 60, 1.0, new Set(), TOL), null);
    assert.equal(judgeHit(null, 60, 1.0, new Set(), TOL), null);
});

test('sweepMissed: marks elapsed unhit notes once, respects hit + floor', () => {
    const { sweepMissed, noteKey } = load();
    const notes = [
        { midi: 60, t: 1.0 },
        { midi: 62, t: 1.5 },
        { midi: 64, t: 5.0 },
    ];
    const hitKeys = new Set([noteKey(1.0, 60)]); // 60@1.0 was hit
    const missedKeys = new Set();
    const missed = [];
    // At t=2.0 the windows for 1.0 and 1.5 have elapsed; 5.0 is pending.
    const n1 = sweepMissed(notes, 2.0, hitKeys, missedKeys, TOL, null, n => missed.push(n.midi));
    assert.equal(n1, 1);
    assert.deepEqual(missed, [62]);
    assert.ok(missedKeys.has(noteKey(1.5, 62)));
    // Sweeping again counts nothing new (idempotent per note).
    assert.equal(sweepMissed(notes, 2.1, hitKeys, missedKeys, TOL, null), 0);
    // Floor: a device connected at t=6 must not retro-miss the 5.0 note.
    const hk2 = new Set(), mk2 = new Set();
    assert.equal(sweepMissed(notes, 6.0, hk2, mk2, TOL, 6.0), 0);
});

test('sweepMissed: a note exactly at the connect floor is not retro-missed', () => {
    // Off-by-one guard: floor is the connect instant; a note whose onset
    // equals it (device connected exactly as the onset passed) must be
    // excluded, not swept. Floor comparison is `<=`, not `<`.
    const { sweepMissed } = load();
    const notes = [{ midi: 60, t: 5.0 }, { midi: 62, t: 6.0 }];
    const missedKeys = new Set();
    const missed = [];
    const n = sweepMissed(notes, 7.0, new Set(), missedKeys, TOL, 5.0,
        m => missed.push(m.midi));
    assert.equal(n, 1);
    assert.deepEqual(missed, [62]);
});

test('sweepMissed: a long frame stall cannot let elapsed notes slip past', () => {
    const { sweepMissed } = load();
    const notes = [{ midi: 60, t: 1.0 }, { midi: 62, t: 3.0 }];
    const missedKeys = new Set();
    // The previous sweep ran at t≈0; the next runs 10 s later (backgrounded
    // tab / render hitch). Both elapsed notes must still be counted.
    assert.equal(sweepMissed(notes, 10.0, new Set(), missedKeys, TOL, null), 2);
});

test('sweepMissed: cursor advances monotonically and never recounts', () => {
    const { sweepMissed } = load();
    const notes = [
        { midi: 60, t: 1.0 },
        { midi: 62, t: 2.0 },
        { midi: 64, t: 9.0 },
    ];
    const hitKeys = new Set(), missedKeys = new Set();
    const cursor = { idx: 0 };
    assert.equal(sweepMissed(notes, 1.5, hitKeys, missedKeys, TOL, null, null, cursor), 1);
    assert.equal(cursor.idx, 1);
    // Stall to t=8: the 2.0 note is counted exactly once from the cursor.
    assert.equal(sweepMissed(notes, 8.0, hitKeys, missedKeys, TOL, null, null, cursor), 1);
    assert.equal(cursor.idx, 2);
    // Seek BACKWARDS: the cursor does not rewind, nothing is recounted.
    assert.equal(sweepMissed(notes, 1.5, hitKeys, missedKeys, TOL, null, null, cursor), 0);
    // The cursor still advances past pre-floor notes without counting them.
    const c2 = { idx: 0 };
    const mk2 = new Set();
    assert.equal(sweepMissed(notes, 8.0, new Set(), mk2, TOL, 5.0, null, c2), 0);
    assert.equal(c2.idx, 2);
});

test('noteKey quantises time to ms so float drift cannot double-count', () => {
    const { noteKey } = load();
    assert.equal(noteKey(1.0004, 60), noteKey(1.0001, 60));
    assert.notEqual(noteKey(1.002, 60), noteKey(1.0001, 60));
    assert.notEqual(noteKey(1.0, 60), noteKey(1.0, 61));
});
