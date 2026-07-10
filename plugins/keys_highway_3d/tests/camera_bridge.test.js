// Camera Director bridge resolver tests: per-panel select, global fallback,
// null-when-absent, throw-safety, and the splitscreen global-name alias. Loads
// screen.js in a bare vm window and exercises the __test exports (no DOM/WebGL).
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
    return { window, __test: window.slopsmithViz_keys_highway_3d.__test };
}

test('_resolveFreeCam: per-panel camera under splitscreen', () => {
    const { __test } = load();
    const c0 = {}, c1 = {};
    const ss = { panelIndexFor: (c) => (c === c0 ? 0 : 1) };
    const map = { 0: { id: 'p0' }, 1: { id: 'p1' } };
    assert.equal(__test._resolveFreeCam(c0, ss, map, { id: 'g' }).id, 'p0');
    assert.equal(__test._resolveFreeCam(c1, ss, map, { id: 'g' }).id, 'p1');
});

test('_resolveFreeCam: falls back to global when there is no panel map', () => {
    const { __test } = load();
    const g = { id: 'global' };
    assert.equal(__test._resolveFreeCam({}, { panelIndexFor: () => 0 }, null, g), g);
});

test('_resolveFreeCam: falls back to global when the panel has no map entry', () => {
    const { __test } = load();
    const g = { id: 'global' };
    const ss = { panelIndexFor: () => 3 };            // index 3 absent from map
    assert.equal(__test._resolveFreeCam({}, ss, { 0: {} }, g), g);
});

test('_resolveFreeCam: null when Camera Director is absent (no global)', () => {
    const { __test } = load();
    assert.equal(__test._resolveFreeCam({}, null, null, null), null);
    assert.equal(__test._resolveFreeCam({}, { panelIndexFor: () => 0 }, {}, undefined), null);
});

test('_resolveFreeCam: throw-safe on panelIndexFor → falls back to global', () => {
    const { __test } = load();
    const g = { id: 'global' };
    const ss = { panelIndexFor: () => { throw new Error('boom'); } };
    assert.equal(__test._resolveFreeCam({}, ss, { 0: {} }, g), g);
});

test('_resolveFreeCam: NaN/negative/float/string index → falls back to global', () => {
    const { __test } = load();
    const g = { id: 'global' };
    assert.equal(__test._resolveFreeCam({}, { panelIndexFor: () => NaN }, { 0: {} }, g), g);
    assert.equal(__test._resolveFreeCam({}, { panelIndexFor: () => -1 }, { 0: {} }, g), g);
    assert.equal(__test._resolveFreeCam({}, { panelIndexFor: () => 0.5 }, { 0: {} }, g), g);
    // A string/prototype key must not resolve an inherited property (e.g. toString).
    assert.equal(__test._resolveFreeCam({}, { panelIndexFor: () => 'toString' }, {}, g), g);
});

test('_ssApi: null when neither global set; slopsmith alias; feedBack canonical wins', () => {
    const { window, __test } = load();
    assert.equal(__test._ssApi(), null);
    const legacy = { panelIndexFor: () => 0 };
    window.slopsmithSplitscreen = legacy;
    assert.equal(__test._ssApi(), legacy);            // legacy alias picked up
    const current = { panelIndexFor: () => 1 };
    window.feedBackSplitscreen = current;
    assert.equal(__test._ssApi(), current);           // canonical name takes precedence
});
