const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const APP_JS = path.join(__dirname, '..', '..', 'static', 'app.js');
// SPLIT. _installPlaybackTransportAdapter stayed in app.js — it reads loopA/loopB from
// ./js/loops.js, and loops.js imports transport, so moving it would close a cycle.
// _waitForSongReady went with the rest of the seek machinery.
const TRANSPORT_JS = path.join(__dirname, '..', '..', 'static', 'js', 'transport.js');

function extractFunction(src, signature) {
    const start = src.indexOf(signature);
    if (start === -1) throw new Error(`extractFunction: '${signature}' not found in app.js`);
    const openBrace = src.indexOf('{', start);
    let depth = 1;
    let i = openBrace + 1;
    while (i < src.length && depth > 0) {
        const ch = src[i];
        if (ch === '{') depth++;
        else if (ch === '}') depth--;
        i++;
    }
    if (depth !== 0) throw new Error(`extractFunction: unbalanced braces after '${signature}'`);
    return src.slice(start, i);
}

function buildReadySandbox() {
    const listeners = new Map();
    const sandbox = {
        window: {
            feedBack: {
                on(event, fn) { listeners.set(event, fn); },
                off(event, fn) { if (listeners.get(event) === fn) listeners.delete(event); },
            },
        },
        setTimeout,
        clearTimeout,
        Promise,
        __emit(event) {
            const fn = listeners.get(event);
            if (fn) fn();
        },
    };
    vm.createContext(sandbox);
    return sandbox;
}

function loadReadyHelper(sandbox, src) {
    const code = `
        let _audioSeekGen = 10;
        ${extractFunction(src, 'function _waitForSongReady(')}
        globalThis.__waitForSongReady = _waitForSongReady;
        globalThis.__setAudioSeekGen = value => { _audioSeekGen = value; };
    `;
    vm.runInContext(code, sandbox);
}

test('_waitForSongReady rejects a ready event from a different audio generation', async () => {
    const src = fs.readFileSync(TRANSPORT_JS, 'utf8');
    const sandbox = buildReadySandbox();
    loadReadyHelper(sandbox, src);

    const stale = sandbox.__waitForSongReady(11, 1000);
    sandbox.__emit('song:ready');
    assert.equal(await stale, false);

    sandbox.__setAudioSeekGen(11);
    const current = sandbox.__waitForSongReady(11, 1000);
    sandbox.__emit('song:ready');
    assert.equal(await current, true);
});

test('playback adapter scopes startTime readiness and validates seek targets', () => {
    const src = fs.readFileSync(APP_JS, 'utf8');
    const fn = extractFunction(src, 'function _installPlaybackTransportAdapter()');

    assert.match(fn, /const expectedSeekGen\s*=\s*audioSeekGen\(\)\s*\+\s*1;/);
    assert.match(fn, /_waitForSongReady\(expectedSeekGen\)/);
    assert.match(fn, /const seconds\s*=\s*Number\(time\);/);
    assert.match(fn, /!Number\.isFinite\(seconds\)\s*\|\|\s*seconds\s*<\s*0/);
    assert.match(fn, /throw new Error\(`Invalid seek time:/);
    assert.match(fn, /return _audioSeek\(seconds, reason \|\| 'playback-command'\);/);
});

test('playback adapter suppresses duplicate HTML5 pause events before emitting canonical pause', () => {
    const src = fs.readFileSync(APP_JS, 'utf8');
    const fn = extractFunction(src, 'function _installPlaybackTransportAdapter()');

    // isPlaying moved onto the shared player-state container so a carved module can
    // WRITE it (an imported binding is read-only). window.feedBack.isPlaying — the
    // public mirror — is unchanged.
    assert.match(fn, /if \(!window\._juceMode && wasPlaying\) \{\s*S\.isPlaying = false;\s*window\.feedBack\.isPlaying = false;\s*audio\.pause\(\);\s*_markPlaybackPaused\(\);\s*\}/);
});
