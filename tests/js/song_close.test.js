// Verify closeCurrentSong() exits via origin-aware showScreen without
// restart, seek, playSong reload, or direct audio mutation.
//
// Same isolation strategy as song_restart.test.js — extract the function
// from app.js by brace-matching and run it in a vm sandbox.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const { extractFunction } = require('./test_utils');

const APP_JS = path.join(__dirname, '..', '..', 'static', 'app.js');

function buildSandbox({ playerOriginScreen = 'home' } = {}) {
    const sandbox = {
        _playerOriginScreen: playerOriginScreen,
        __showScreenCalls: [],
        __restartCalls: 0,
        __seekCalls: 0,
        __playSongCalls: 0,
        __clearLoopCalls: 0,
        __audioCurrentTimeSets: [],
        audio: {
            _t: 42,
            get currentTime() { return sandbox.audio._t; },
            set currentTime(v) { sandbox.__audioCurrentTimeSets.push(v); sandbox.audio._t = v; },
        },
    };
    vm.createContext(sandbox);
    return sandbox;
}

function loadClose(sandbox, src) {
    const closeSrc = extractFunction(src, 'function closeCurrentSong(');
    const code = `
        var _playerOriginScreen = ${JSON.stringify(sandbox._playerOriginScreen)};
        globalThis.__showScreenCalls = [];
        globalThis.__restartCalls = 0;
        globalThis.__seekCalls = 0;
        globalThis.__playSongCalls = 0;
        globalThis.__clearLoopCalls = 0;
        globalThis.__audioCurrentTimeSets = [];
        var audio = {
            _t: 42,
            get currentTime() { return this._t; },
            set currentTime(v) { globalThis.__audioCurrentTimeSets.push(v); this._t = v; }
        };
        function showScreen(id) {
            globalThis.__showScreenCalls.push(id);
            return Promise.resolve();
        }
        function restartCurrentSong() { globalThis.__restartCalls++; }
        async function _audioSeek() { globalThis.__seekCalls++; }
        function playSong() { globalThis.__playSongCalls++; }
        function clearLoop() { globalThis.__clearLoopCalls++; }
        ${closeSrc}
        globalThis.__closeCurrentSong = closeCurrentSong;
    `;
    vm.runInContext(code, sandbox);
}

test('closeCurrentSong is exported on window and window.feedBack', () => {
    const src = fs.readFileSync(APP_JS, 'utf8');
    assert.match(src, /window\.closeCurrentSong\s*=\s*closeCurrentSong/);
    assert.match(src, /window\.feedBack\.closeCurrentSong\s*=\s*closeCurrentSong/);
});

test('closeCurrentSong uses _playerOriginScreen when set', async () => {
    const src = fs.readFileSync(APP_JS, 'utf8');
    const sandbox = buildSandbox({ playerOriginScreen: 'favorites' });
    loadClose(sandbox, src);
    await sandbox.__closeCurrentSong();
    assert.equal(sandbox.__showScreenCalls.length, 1);
    assert.equal(sandbox.__showScreenCalls[0], 'favorites');
    assert.equal(sandbox.__restartCalls, 0);
    assert.equal(sandbox.__seekCalls, 0);
    assert.equal(sandbox.__playSongCalls, 0);
    assert.equal(sandbox.__clearLoopCalls, 0);
    assert.equal(sandbox.__audioCurrentTimeSets.length, 0);
});

test('closeCurrentSong falls back to home when origin missing', async () => {
    const src = fs.readFileSync(APP_JS, 'utf8');
    const sandbox = buildSandbox({ playerOriginScreen: null });
    loadClose(sandbox, src);
    await sandbox.__closeCurrentSong();
    assert.equal(sandbox.__showScreenCalls.length, 1);
    assert.equal(sandbox.__showScreenCalls[0], 'home');
});

test('closeCurrentSong falls back to home when origin is empty string', async () => {
    const src = fs.readFileSync(APP_JS, 'utf8');
    const sandbox = buildSandbox({ playerOriginScreen: '' });
    loadClose(sandbox, src);
    await sandbox.__closeCurrentSong();
    assert.equal(sandbox.__showScreenCalls.length, 1);
    assert.equal(sandbox.__showScreenCalls[0], 'home');
});
