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

// A gig/album/playlist queue must survive a playSong wrapper that drops the
// options object.
//
// The queue tells playSong "don't clear the queue I'm driving" via
// options.fromQueue. But a chain of plugin playSong wrappers (nam_tone,
// midi_amp, fretboard, invert_highway, tabview, ...) forward only
// (filename, arrangement) and silently drop the 3rd arg. With just the in-band
// flag, playSong cleared the queue the instant its first song started, so a gig
// never advanced (feedBack#… tester: "Passports does not advance in the song
// queue"). The queue now also raises an out-of-band flag, _consumeInternalPlay(),
// which playSong honours regardless of the wrapper chain.

// The real clear-guard from session.js, driven against the queue.
function clearGuard(win, options) {
    const pq = win.feedBack && win.feedBack.playQueue;
    const queueDriven = (options && options.fromQueue)
        || (pq && typeof pq._consumeInternalPlay === 'function' && pq._consumeInternalPlay());
    if (!queueDriven && pq) pq.clear();
}

test('the queue survives a playSong that drops the options arg', () => {
    const { q } = makeQueue();
    // Rebind the queue's window.playSong to a wrapper that forwards ONLY
    // (filename, arrangement) — exactly the plugin bug — and runs the real guard.
    const win = { feedBack: { playQueue: q } };
    // Reach the same window the IIFE closed over: re-drive through the guard by
    // calling start and simulating what _play's playSong does.
    // We can't rebind the closed-over window, so instead assert the out-of-band
    // signal directly: _play sets it, and the guard consumes it.
    q.start(['a.sloppak', 'b.sloppak', 'c.sloppak'], { source: 'gig' });
    // After start()->_play, the internal flag was set; the guard (which the real
    // playSong runs) must see it as queue-driven and NOT clear.
    win.feedBack.playQueue = q;
    clearGuard(win, undefined /* wrapper dropped options */);
    assert.strictEqual(q.active(), true, 'a dropped options arg must not clear the queue');
    assert.strictEqual(q.remaining(), 2, 'the queue must still have its remaining tracks');
});

test('_consumeInternalPlay is one-shot — a later MANUAL play still clears', () => {
    const { q } = makeQueue();
    q.start(['a.sloppak', 'b.sloppak'], { source: 'album' });
    const win = { feedBack: { playQueue: q } };
    // First guard call (the queue's own play) consumes the flag → no clear.
    clearGuard(win, undefined);
    assert.strictEqual(q.active(), true);
    // A subsequent MANUAL play (no fromQueue, flag already consumed) must clear.
    clearGuard(win, undefined);
    assert.strictEqual(q.active(), false, 'a manual play after the queue play must abandon the queue');
});

test('fromQueue in options still works on its own (in-band path)', () => {
    const { q } = makeQueue();
    q.start(['a.sloppak', 'b.sloppak'], { source: 'gig' });
    // consume the internal flag first so ONLY options.fromQueue is under test
    q._consumeInternalPlay();
    const win = { feedBack: { playQueue: q } };
    clearGuard(win, { fromQueue: true });
    assert.strictEqual(q.active(), true, 'options.fromQueue alone must still keep the queue');
});

// isContinuation(): true for song 2..N of a set, false for the first song / a
// standalone play. The venue uses it to fly in once on arrival, then carry the
// room between songs instead of replaying the arrival flyover every track
// (tester: "it showed the flyover intro again" on a gig's second song).
test('isContinuation is false on the first song, true after advancing', () => {
    const { q } = makeQueue();
    assert.strictEqual(q.isContinuation(), false, 'idle queue is not a continuation');
    q.start(['a.sloppak', 'b.sloppak', 'c.sloppak'], { source: 'gig' });
    assert.strictEqual(q.isContinuation(), false, 'the FIRST song of a set is an arrival, not a continuation');
    q.advance();
    assert.strictEqual(q.isContinuation(), true, 'song 2 is a continuation — no re-flyover');
    q.advance();
    assert.strictEqual(q.isContinuation(), true, 'song 3 too');
    q.clear();
    assert.strictEqual(q.isContinuation(), false, 'a cleared queue is not a continuation');
});
