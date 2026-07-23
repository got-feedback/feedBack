'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

function makeFeedBack() {
    const handlers = new Map();
    return {
        on(event, fn) {
            const list = handlers.get(event) || [];
            list.push(fn);
            handlers.set(event, list);
        },
        emit(event, detail) {
            (handlers.get(event) || []).forEach((fn) => fn({ detail }));
        },
        capabilities: { snapshotDiagnostics: () => ({}) },
    };
}

function setup() {
    const posts = [];
    const origFetch = global.fetch;
    global.fetch = async (url, opts) => {
        if (url === '/api/stats') {
            posts.push(JSON.parse(opts.body));
        }
        return { ok: true, json: async () => ({}) };
    };
    const fb = makeFeedBack();
    global.window = { feedBack: fb };
    require('../../static/v3/stats-recorder.js');
    return { posts, fb, cleanup: () => { global.fetch = origFetch; delete global.window; } };
}

test('stats-recorder corrects arrangement from song:loaded', () => {
    const { posts, fb, cleanup } = setup();

    // Scenario 1: instrument routing picks a different arrangement (e.g. bass)
    fb.emit('song:loading', { filename: 'song.archive', arrangement: null });
    fb.emit('song:loaded', {
        filename: 'song.archive', arrangement: 'Bass',
        arrangementIndex: 2,
        arrangements: [{ name: 'Lead' }, { name: 'Rhythm' }, { name: 'Bass' }],
    });
    fb.emit('song:pause', { time: 30 });
    assert.equal(posts.length, 1, 'scenario 1: should have posted stats');
    assert.equal(posts[0].arrangement, 2, 'scenario 1: arrangement should be the server-chosen index (2)');

    // Scenario 2: arrangementIndex 0 is kept (guitar lead is correct)
    fb.emit('song:loading', { filename: 'song2.archive', arrangement: null });
    fb.emit('song:loaded', {
        filename: 'song2.archive', arrangement: 'Lead',
        arrangementIndex: 0,
    });
    fb.emit('song:pause', { time: 10 });
    assert.equal(posts.length, 2, 'scenario 2: should have posted stats');
    assert.equal(posts[1].arrangement, 0, 'scenario 2: should keep arrangement 0 when server selected it');

    // Scenario 3: explicit arrangement is preserved
    fb.emit('song:loading', { filename: 'song3.archive', arrangement: 0 });
    fb.emit('song:loaded', {
        filename: 'song3.archive', arrangement: 'Lead',
        arrangementIndex: 0,
    });
    fb.emit('song:pause', { time: 10 });
    assert.equal(posts.length, 3, 'scenario 3: should have posted stats');
    assert.equal(posts[2].arrangement, 0, 'scenario 3: explicit arrangement 0 preserved');

    cleanup();
});
