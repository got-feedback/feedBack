// Verify restartCurrentSong() uses the canonical _audioSeek / togglePlay /
// startCountIn paths without clearing loops or reloading the song.
//
// Same isolation strategy as song_seek.test.js — extract the function from
// app.js by brace-matching and run it in a vm sandbox with stubbed deps.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const { extractFunction } = require('./test_utils');

const APP_JS = path.join(__dirname, '..', '..', 'static', 'app.js');
const V3_HTML = path.join(__dirname, '..', '..', 'static', 'v3', 'index.html');
const V2_HTML = path.join(__dirname, '..', '..', 'static', 'index.html');

function buildSandbox({ loopA = null, loopB = null, isPlaying = false } = {}) {
    const sandbox = {
        loopA,
        loopB,
        isPlaying,
        __cancelCountInCalls: 0,
        __seekCalls: [],
        __startCountInCalls: [],
        __togglePlayCalls: 0,
        __clearLoopCalls: 0,
        window: {
            feedBack: {
                getLoop() {
                    return { loopA: sandbox.loopA, loopB: sandbox.loopB };
                },
            },
        },
        __audioSeek(s, reason) {
            sandbox.__seekCalls.push({ s, reason });
            return Promise.resolve({ completed: true, from: 30, to: s });
        },
        __startCountIn(opts) {
            sandbox.__startCountInCalls.push(opts);
            return Promise.resolve();
        },
        __togglePlay() {
            sandbox.__togglePlayCalls++;
            sandbox.isPlaying = true;
            return Promise.resolve();
        },
    };
    vm.createContext(sandbox);
    return sandbox;
}

function loadRestart(sandbox, src, { audioSeekImpl } = {}) {
    const restartSrc = extractFunction(src, 'async function restartCurrentSong(');
    const code = `
        var isPlaying = ${sandbox.isPlaying};
        function _cancelCountIn() { __cancelCountInCalls++; }
        async function _audioSeek(s, reason) {
            return (${audioSeekImpl || '__audioSeek'})(s, reason);
        }
        async function startCountIn(opts) { return __startCountIn(opts); }
        async function togglePlay() { return __togglePlay(); }
        function clearLoop() { __clearLoopCalls++; }
        ${restartSrc}
        globalThis.__restartCurrentSong = restartCurrentSong;
    `;
    vm.runInContext(code, sandbox);
}

test('restartCurrentSong is exported on window and window.feedBack', () => {
    const src = fs.readFileSync(APP_JS, 'utf8');
    assert.match(src, /window\.restartCurrentSong\s*=\s*restartCurrentSong/);
    assert.match(src, /window\.feedBack\.restartCurrentSong\s*=\s*restartCurrentSong/);
});

test('no loop: seeks to 0 with song-restart and starts playback when stopped', async () => {
    const src = fs.readFileSync(APP_JS, 'utf8');
    const sandbox = buildSandbox({ isPlaying: false });
    loadRestart(sandbox, src);

    const ok = await sandbox.__restartCurrentSong();
    assert.equal(ok, true);
    assert.equal(sandbox.__cancelCountInCalls, 1);
    assert.equal(sandbox.__seekCalls.length, 1);
    assert.equal(sandbox.__seekCalls[0].s, 0);
    assert.equal(sandbox.__seekCalls[0].reason, 'song-restart');
    assert.equal(sandbox.__togglePlayCalls, 1);
    assert.equal(sandbox.__startCountInCalls.length, 0);
    assert.equal(sandbox.__clearLoopCalls, 0);
});

test('already playing, no loop: seeks to 0 and does not toggle play', async () => {
    const src = fs.readFileSync(APP_JS, 'utf8');
    const sandbox = buildSandbox({ isPlaying: true });
    loadRestart(sandbox, src);

    const ok = await sandbox.__restartCurrentSong();
    assert.equal(ok, true);
    assert.equal(sandbox.__seekCalls[0].s, 0);
    assert.equal(sandbox.__togglePlayCalls, 0);
    assert.equal(sandbox.__clearLoopCalls, 0);
});

test('loop armed: seeks to loopA, preserves loop, re-enters via startCountIn immediate', async () => {
    const src = fs.readFileSync(APP_JS, 'utf8');
    const sandbox = buildSandbox({ loopA: 12.5, loopB: 48, isPlaying: false });
    loadRestart(sandbox, src);

    const ok = await sandbox.__restartCurrentSong();
    assert.equal(ok, true);
    assert.equal(sandbox.__seekCalls.length, 1);
    assert.equal(sandbox.__seekCalls[0].s, 12.5);
    assert.equal(sandbox.__seekCalls[0].reason, 'song-restart');
    assert.equal(sandbox.__startCountInCalls.length, 1);
    assert.equal(sandbox.__startCountInCalls[0].immediate, true);
    assert.equal(sandbox.__togglePlayCalls, 0);
    assert.equal(sandbox.__clearLoopCalls, 0);
    assert.equal(sandbox.loopB, 48, 'loopB must be preserved');
});

test('failed/incomplete seek: does not start playback or count-in', async () => {
    const src = fs.readFileSync(APP_JS, 'utf8');
    const sandbox = buildSandbox({ isPlaying: false });
    loadRestart(sandbox, src, {
        audioSeekImpl: '(s, reason) => Promise.resolve({ completed: false, from: NaN, to: NaN })',
    });

    const ok = await sandbox.__restartCurrentSong();
    assert.equal(ok, false);
    assert.equal(sandbox.__togglePlayCalls, 0);
    assert.equal(sandbox.__startCountInCalls.length, 0);
});

test('V3 transport restart button exists with correct attributes', () => {
    const html = fs.readFileSync(V3_HTML, 'utf8');
    assert.match(html, /v3-transport-mid[\s\S]*onclick="restartCurrentSong\(\)"/);
    assert.match(html, /title="Restart song"/);
    assert.match(html, /aria-label="Restart song"/);
});

test('V2 transport restart button exists with correct attributes', () => {
    const html = fs.readFileSync(V2_HTML, 'utf8');
    assert.match(html, /#player-controls|player-controls[\s\S]*onclick="restartCurrentSong\(\)"/);
    assert.match(html, /title="Restart song"/);
    assert.match(html, /aria-label="Restart song"/);
});
