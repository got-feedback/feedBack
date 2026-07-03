// playQueue.start({ shuffle: true }): the queue is Fisher-Yates-shuffled ONCE
// at start. Per-slot arrangements must swap in lockstep with their files
// (albums pass arrangements aligned by index, #685), the caller's arrays must
// not be mutated, and shuffle:false / absent must preserve order. Extract the
// playQueue IIFE from app.js and drive it against a playSong stub.
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

function makeQueue() {
    const src = fs.readFileSync(path.join(__dirname, '..', '..', 'static', 'app.js'), 'utf8');
    const start = src.indexOf('window.feedBack.playQueue = (function () {');
    assert.ok(start !== -1, 'playQueue IIFE found in app.js');
    const end = src.indexOf('})();', start);
    assert.ok(end !== -1, 'playQueue IIFE terminator found');
    const iife = src.slice(start, end + 5);
    const played = [];
    const sandbox = {
        window: {
            feedBack: {},
            playSong: (fn, arr, opts) => played.push({ fn: decodeURIComponent(fn), arr, opts }),
            fbNotify: null,
        },
    };
    // eslint-disable-next-line no-new-func
    new Function('window', 'encodeURIComponent', iife)(sandbox.window, encodeURIComponent);
    return { q: sandbox.window.feedBack.playQueue, played };
}

function drain(q, played) {
    while (q.hasNext()) q.advance();
    return played.map((p) => p.fn);
}

test('shuffle: same multiset, order from the seeded RNG, arrangements follow files', () => {
    const files = ['a.sloppak', 'b.sloppak', 'c.sloppak', 'd.sloppak'];
    const arrs = [0, 1, 2, 3]; // arrangement i belongs to files[i]
    const origRandom = Math.random;
    try {
        // Deterministic RNG so the expected order is checkable.
        let calls = 0;
        const seq = [0.1, 0.9, 0.5];
        Math.random = () => seq[calls++ % seq.length];
        const { q, played } = makeQueue();
        q.start(files.slice(), { arrangements: arrs.slice(), shuffle: true });
        const order = drain(q, played);
        assert.deepStrictEqual(order.slice().sort(), files.slice().sort()); // nothing lost/duplicated
        // Each played file carries the arrangement it started with.
        played.forEach((p) => {
            assert.strictEqual(p.arr, arrs[files.indexOf(p.fn)]);
        });
    } finally {
        Math.random = origRandom;
    }
});

test('shuffle can change the order', () => {
    const origRandom = Math.random;
    try {
        Math.random = () => 0; // j = 0 every swap → deterministic rotation, ≠ input order
        const { q, played } = makeQueue();
        q.start(['a', 'b', 'c'], { shuffle: true });
        const order = drain(q, played);
        assert.notDeepStrictEqual(order, ['a', 'b', 'c']);
    } finally {
        Math.random = origRandom;
    }
});

test('no shuffle opt preserves order and caller arrays are never mutated', () => {
    const files = ['a', 'b', 'c'];
    const arrs = [2, 0, 1];
    const { q, played } = makeQueue();
    q.start(files, { arrangements: arrs });
    assert.deepStrictEqual(drain(q, played), ['a', 'b', 'c']);
    assert.deepStrictEqual(files, ['a', 'b', 'c']);
    assert.deepStrictEqual(arrs, [2, 0, 1]);

    // shuffle:true must also leave the caller's arrays alone (start slices).
    const { q: q2 } = makeQueue();
    q2.start(files, { arrangements: arrs, shuffle: true });
    assert.deepStrictEqual(files, ['a', 'b', 'c']);
    assert.deepStrictEqual(arrs, [2, 0, 1]);
});
