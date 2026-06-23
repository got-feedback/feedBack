'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const APP_JS = path.join(__dirname, '..', '..', 'static', 'app.js');
const HIGHWAY_JS = path.join(__dirname, '..', '..', 'static', 'highway.js');
const V3_HTML = path.join(__dirname, '..', '..', 'static', 'v3', 'index.html');
const V2_HTML = path.join(__dirname, '..', '..', 'static', 'index.html');

function extractBlock(src, startMarker) {
    const start = src.indexOf(startMarker);
    if (start === -1) throw new Error(`extractBlock: '${startMarker}' not found`);
    const openBrace = src.indexOf('{', start);
    let depth = 1;
    let i = openBrace + 1;
    while (i < src.length && depth > 0) {
        const ch = src[i];
        if (ch === '{') depth++;
        else if (ch === '}') depth--;
        i++;
    }
    if (depth !== 0) throw new Error(`extractBlock: unbalanced braces after '${startMarker}'`);
    return src.slice(start, i);
}

function loadTuningDisplayHelpers() {
    const src = fs.readFileSync(APP_JS, 'utf8');
    const block = [
        extractBlock(src, 'function _looksLikeRawTuningOffsets('),
        extractBlock(src, 'function _tuningNameFromOffsets('),
        extractBlock(src, 'function parseRawTuningOffsets('),
        extractBlock(src, 'function displayTuningName('),
    ].join('\n');
    const sandbox = { window: { feedBack: {} }, exports: {} };
    vm.createContext(sandbox);
    vm.runInContext(block + '\nexports.displayTuningName = displayTuningName;', sandbox);
    return sandbox.exports;
}

const TUNER_UI_JS = path.join(__dirname, '..', '..', 'plugins', 'tuner', 'utils', 'ui.js');

const { displayTuningName } = loadTuningDisplayHelpers();

test('displayTuningName passes through known labels', () => {
    assert.equal(displayTuningName('E Standard'), 'E Standard');
    assert.equal(displayTuningName('Drop D'), 'Drop D');
    assert.equal(displayTuningName('Eb Standard'), 'Eb Standard');
});

test('displayTuningName sanitizes raw offset strings to Custom Tuning', () => {
    assert.equal(displayTuningName('-2000-2'), 'Custom Tuning');
    assert.equal(displayTuningName('-2 0 0 0 -2'), 'Custom Tuning');
    assert.equal(displayTuningName('-3,-1,0,1,2,3'), 'Custom Tuning');
});

test('displayTuningName names a known raw offset string (feedBack#867)', () => {
    // Now that the API serves raw offsets, a known tuning passed as a raw
    // string must resolve to its real name, not collapse to Custom Tuning.
    assert.equal(displayTuningName('-1 -1 -1 -1 -1 -1'), 'Eb Standard');
    assert.equal(displayTuningName('-2 0 0 0 0 0'), 'Drop D');
    assert.equal(displayTuningName('-2,0,0,0,-2,0'), 'DADGAD');
    // Genuinely custom offsets still read Custom Tuning.
    assert.equal(displayTuningName('-2 0 0 0 -2 1'), 'Custom Tuning');
});

test('displayTuningName recognizes 4/5-string uniform standard (feedBack#867)', () => {
    // A normal 4-string bass [0,0,0,0] must not fall through to Custom Tuning.
    assert.equal(displayTuningName(null, [0, 0, 0, 0]), 'E Standard');
    assert.equal(displayTuningName(null, [-2, -2, -2, -2]), 'D Standard');
    assert.equal(displayTuningName('0 0 0 0'), 'E Standard');
});

test('displayTuningName derives readable names from offsets when value missing', () => {
    assert.equal(displayTuningName(null, [0, 0, 0, 0, 0, 0]), 'E Standard');
    assert.equal(displayTuningName('', [0, 0, 0, 0, 0, 0]), 'E Standard');
    assert.equal(displayTuningName(undefined, [-2, 0, 0, 0, 0, 0]), 'Drop D');
});

test('displayTuningName returns Custom Tuning for unknown offsets', () => {
    assert.equal(displayTuningName(null, [-2, 0, 0, 0, -2]), 'Custom Tuning');
    assert.equal(displayTuningName('-2 0 0 0 -2', [-2, 0, 0, 0, -2]), 'Custom Tuning');
});

test('displayTuningName returns empty when nothing usable', () => {
    assert.equal(displayTuningName(''), '');
    assert.equal(displayTuningName(null), '');
    assert.equal(displayTuningName('Unknown'), '');
    assert.equal(displayTuningName(null, []), '');
});

test('V3 index.html defines hud-tuning', () => {
    const html = fs.readFileSync(V3_HTML, 'utf8');
    assert.match(html, /id="hud-tuning"/);
});

test('V2 index.html defines hud-tuning', () => {
    const html = fs.readFileSync(V2_HTML, 'utf8');
    assert.match(html, /id="hud-tuning"/);
});

test('highway.js updates hud-tuning from song_info tuning offsets', () => {
    const src = fs.readFileSync(HIGHWAY_JS, 'utf8');
    assert.match(src, /getElementById\('hud-tuning'\)/);
    assert.match(src, /displayTuningName\(null, msg\.tuning\)/);
    assert.match(src, /Tuning: /);
});

test('V3 index.html defines hud-tuning-targets', () => {
    const html = fs.readFileSync(V3_HTML, 'utf8');
    assert.match(html, /id="hud-tuning-targets"/);
});
