// playQueue.peekNext() (queue-advance UX): consumers that render "Up next"
// (the results card's countdown strip) need to know WHAT follows without
// reaching into queue internals. Extract the playQueue IIFE from app.js and
// drive it against a playSong stub.
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
            playSong: (fn, arr, opts) => played.push({ fn, arr, opts }),
            fbNotify: null,
        },
        encodeURIComponent,
    };
    // eslint-disable-next-line no-new-func
    new Function('window', 'encodeURIComponent', iife)(sandbox.window, encodeURIComponent);
    return { q: sandbox.window.feedBack.playQueue, played };
}

test('peekNext exposes the following track without mutating the queue', () => {
    const { q, played } = makeQueue();
    assert.strictEqual(q.peekNext(), null);              // idle queue → null
    q.start(['a.sloppak', 'b.sloppak', 'c.sloppak'], { source: 'My list' });
    assert.deepStrictEqual(q.peekNext(), { filename: 'b.sloppak', index: 1, total: 3 });
    assert.deepStrictEqual(q.peekNext(), { filename: 'b.sloppak', index: 1, total: 3 }); // pure
    assert.strictEqual(played.length, 1);                // peeking never plays
    q.advance();
    assert.deepStrictEqual(q.peekNext(), { filename: 'c.sloppak', index: 2, total: 3 });
    q.advance();
    assert.strictEqual(q.peekNext(), null);              // last track → nothing next
    assert.strictEqual(q.remaining(), 0);
});

test('peekNext is null after clear', () => {
    const { q } = makeQueue();
    q.start(['a.sloppak', 'b.sloppak']);
    q.clear();
    assert.strictEqual(q.peekNext(), null);
});
