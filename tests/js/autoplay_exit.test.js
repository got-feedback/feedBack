// Verify the autoplay & auto-exit option's pure decision helpers in app.js:
//   - _autoplayExitEnabled()  (localStorage; absence = enabled)
//   - _resolvePlayerOrigin()  (one-shot override → launch screen → 'home')
//
// Same isolation strategy as song_close.test.js — extract the function from
// app.js by brace-matching and run it in a vm sandbox with stubbed deps.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const { extractFunction } = require('./test_utils');

const APP_JS = path.join(__dirname, '..', '..', 'static', 'app.js');
const SRC = fs.readFileSync(APP_JS, 'utf8');

function runEnabled(stored) {
    const fnSrc = extractFunction(SRC, 'function _autoplayExitEnabled(');
    const sandbox = {
        localStorage: {
            getItem: () => {
                if (stored === '__throw__') throw new Error('private mode');
                return stored;
            },
        },
    };
    vm.createContext(sandbox);
    vm.runInContext(fnSrc + '\nglobalThis.__r = _autoplayExitEnabled();', sandbox);
    return sandbox.__r;
}

// Fake element honoring the bits _resultsOverlayVisible() inspects.
function el({ id = '', hidden = false, visible = true } = {}) {
    return {
        id,
        classList: { contains: (c) => c === 'hidden' && hidden },
        getClientRects: () => (visible ? [{}] : []),
    };
}

function runOverlay(nodes) {
    const fnSrc = extractFunction(SRC, 'function _resultsOverlayVisible(');
    const sandbox = { document: { querySelectorAll: () => nodes } };
    vm.createContext(sandbox);
    vm.runInContext(fnSrc + '\nglobalThis.__r = _resultsOverlayVisible();', sandbox);
    return sandbox.__r;
}

function runResolve({ override = null, screens = [], active = null } = {}) {
    const fnSrc = extractFunction(SRC, 'function _resolvePlayerOrigin(');
    const sandbox = {
        window: { feedBack: { _nextReturnScreen: override } },
        document: {
            getElementById: (id) => (screens.includes(id) ? { id } : null),
            querySelector: () => (active ? { id: active } : null),
        },
    };
    vm.createContext(sandbox);
    vm.runInContext(fnSrc + '\nglobalThis.__r = _resolvePlayerOrigin();', sandbox);
    return { result: sandbox.__r, override: sandbox.window.feedBack._nextReturnScreen };
}

// holdAutoExit() + _clearAutoExit() share module state; assemble them in one
// sandbox to exercise the generation guard on the returned release handle.
function buildHoldSandbox() {
    const clearSrc = extractFunction(SRC, 'function _clearAutoExit(');
    const holdSrc = extractFunction(SRC, 'window.feedBack.holdAutoExit = function ()');
    const sandbox = { __closeCount: 0 };
    sandbox.window = { feedBack: {}, closeCurrentSong: () => { sandbox.__closeCount++; } };
    vm.createContext(sandbox);
    vm.runInContext(`
        var _autoExitTimer = null;
        var _autoExitHeld = false;
        var _autoExitGen = 0;
        function clearTimeout() {}
        ${clearSrc}
        ${holdSrc}
        globalThis.__clearAutoExit = _clearAutoExit;
        globalThis.__hold = window.feedBack.holdAutoExit;
    `, sandbox);
    return sandbox;
}

test('hold release navigates once while the generation is current', () => {
    const sb = buildHoldSandbox();
    const release = sb.__hold();
    release();
    assert.equal(sb.__closeCount, 1);
    release(); // idempotent
    assert.equal(sb.__closeCount, 1);
});

test('a stale hold release no-ops after the session moves on', () => {
    const sb = buildHoldSandbox();
    const release = sb.__hold();
    sb.__clearAutoExit(); // new playSong / song:ended bumps the generation
    release();
    assert.equal(sb.__closeCount, 0, 'stale release must not navigate');
});

// ── _autoplayExitEnabled ──────────────────────────────────────────────
test('autoplayExit defaults ON when the key is absent', () => {
    assert.equal(runEnabled(null), true);
});

test('autoplayExit is OFF only for the explicit "0"', () => {
    assert.equal(runEnabled('0'), false);
    assert.equal(runEnabled('1'), true);
    assert.equal(runEnabled('anything'), true);
});

test('autoplayExit falls back to ON when localStorage throws', () => {
    assert.equal(runEnabled('__throw__'), true);
});

// ── _resultsOverlayVisible ────────────────────────────────────────────
test('no overlays → not visible', () => {
    assert.equal(runOverlay([]), false);
});

test('a visible modal overlay defers auto-exit', () => {
    assert.equal(runOverlay([el({ id: 'mg-summary' })]), true);
});

test('a hidden (.hidden) overlay does not defer', () => {
    assert.equal(runOverlay([el({ id: 'mg-summary', hidden: true })]), false);
});

test('a display:none overlay (no client rects) does not defer', () => {
    assert.equal(runOverlay([el({ id: 'mg-summary', visible: false })]), false);
});

test('the player screen itself never counts as a results overlay', () => {
    assert.equal(runOverlay([el({ id: 'player' })]), false);
});

test('mixed: ignores player + hidden, honors a visible results overlay', () => {
    assert.equal(runOverlay([
        el({ id: 'player' }),
        el({ id: 'stale', hidden: true }),
        el({ id: 'score-card' }),
    ]), true);
});

// ── _resolvePlayerOrigin ──────────────────────────────────────────────
test('one-shot override wins and is consumed when its screen exists', () => {
    const { result, override } = runResolve({
        override: 'v3-lessons', screens: ['v3-lessons', 'plugin-tutorials'], active: 'plugin-tutorials',
    });
    assert.equal(result, 'v3-lessons');
    assert.equal(override, null); // consumed, even though it won
});

test('override is ignored (and still consumed) when its screen is missing', () => {
    const { result, override } = runResolve({
        override: 'ghost-screen', screens: ['favorites'], active: 'favorites',
    });
    assert.equal(result, 'favorites');
    assert.equal(override, null);
});

test('remembers the real launch screen', () => {
    assert.equal(runResolve({ screens: ['v3-lessons'], active: 'v3-lessons' }).result, 'v3-lessons');
    assert.equal(runResolve({ screens: ['favorites'], active: 'favorites' }).result, 'favorites');
});

test('dashboard launches (classic home + v3-home) return to the Songs list', () => {
    assert.equal(runResolve({ screens: ['home', 'v3-songs'], active: 'home' }).result, 'v3-songs');
    assert.equal(runResolve({ screens: ['v3-home', 'v3-songs'], active: 'v3-home' }).result, 'v3-songs');
});

test('v3-home falls back to itself when there is no Songs list (defensive)', () => {
    assert.equal(runResolve({ screens: ['v3-home'], active: 'v3-home' }).result, 'v3-home');
});

test('classic v2 (no #v3-songs) keeps home', () => {
    assert.equal(runResolve({ screens: ['home'], active: 'home' }).result, 'home');
});

test('player / unknown / no active screen fall back to home', () => {
    assert.equal(runResolve({ screens: ['player'], active: 'player' }).result, 'home');
    assert.equal(runResolve({ screens: [], active: 'plugin-x' }).result, 'home');
    assert.equal(runResolve({ screens: [], active: null }).result, 'home');
});
