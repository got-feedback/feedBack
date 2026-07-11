'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// The tuning-display helpers were carved out of app.js into their own module (R3a).
const APP_JS = path.join(__dirname, '..', '..', 'static', 'js', 'tuning-display.js');
const HIGHWAY_JS = path.join(__dirname, '..', '..', 'static', 'highway.js');
const TUNER_UI_JS = path.join(__dirname, '..', '..', 'plugins', 'tuner', 'utils', 'ui.js');
const TUNER_SCREEN_JS = path.join(__dirname, '..', '..', 'plugins', 'tuner', 'screen.js');
const V3_HTML = path.join(__dirname, '..', '..', 'static', 'v3', 'index.html');

function loadTuningHelpers() {
    const src = fs.readFileSync(APP_JS, 'utf8');
    // The module is nothing BUT the tuning helpers now, so there is no block to
    // slice out — take it whole. `export` is stripped so the vm sandbox can still
    // evaluate it as a plain script (the window.* contract lives in app.js).
    const body = src.replace(/^export /gm, '');
    const sandbox = { window: { feedBack: {} }, exports: {} };
    vm.createContext(sandbox);
    vm.runInContext(
        body + '\n'
        + 'exports.displayTuningTargets = displayTuningTargets;\n'
        + 'exports.displayTuningTargetDetails = displayTuningTargetDetails;\n'
        + 'exports.isBassArrangement = isBassArrangement;\n'
        + 'exports.effectiveStringCount = effectiveStringCount;',
        sandbox
    );
    return sandbox.exports;
}

const { displayTuningTargets, displayTuningTargetDetails, isBassArrangement, effectiveStringCount } = loadTuningHelpers();

const LEAD_CTX = { arrangement: 'Lead', stringCount: 4, tuningName: 'Custom Tuning' };
const BASS_CTX = { arrangement: 'Bass', stringCount: 4, isBass: true, tuningName: 'Custom Tuning' };

test('effectiveStringCount: Lead with bad stringCount=4 uses six guitar strings', () => {
    assert.equal(effectiveStringCount([-2, 0, 0, 0, -2, 0], LEAD_CTX), 6);
});

test('isBassArrangement: Lead is not bass', () => {
    assert.equal(isBassArrangement({ arrangement: 'Lead' }), false);
    assert.equal(isBassArrangement({ arrangement: 'Bass' }), true);
});

test('displayTuningTargets: custom guitar uses low-to-high note names only', () => {
    const targets = displayTuningTargets([-2, 0, 0, 0, -2, -2], LEAD_CTX);
    assert.equal(targets, 'D A D G A D');
    assert.doesNotMatch(targets, /6:|5:|D2|A2|D3/);
});

test('displayTuningTargets: E Standard guitar is low-to-high notes', () => {
    const targets = displayTuningTargets([0, 0, 0, 0, 0, 0], { stringCount: 6, arrangement: 'Lead' });
    assert.equal(targets, 'E A D G B E');
});

test('displayTuningTargets: bass 4-string is low-to-high notes', () => {
    const targets = displayTuningTargets([0, 0, 0, 0], BASS_CTX);
    assert.equal(targets, 'E A D G');
});

test('displayTuningTargetDetails: includes string number and octave in titles', () => {
    const details = displayTuningTargetDetails([-2, 0, 0, 0, -2, -2], LEAD_CTX);
    assert.equal(details.length, 6);
    assert.equal(details[0].note, 'D');
    assert.equal(details[0].octaveNote, 'D2');
    assert.equal(details[0].title, '6th string: D2');
    assert.equal(details[5].title, '1st string: D4');
});

test('displayTuningTargets: missing offsets returns empty string', () => {
    assert.equal(displayTuningTargets(null), '');
    assert.equal(displayTuningTargets([]), '');
});

test('highway.js shows targets only for Custom Tuning', () => {
    const src = fs.readFileSync(HIGHWAY_JS, 'utf8');
    assert.match(src, /getElementById\('hud-tuning-targets'\)/);
    assert.match(src, /displayTuningTargets/);
    assert.match(src, /tuningLabel === 'Custom Tuning'/);
    assert.match(src, /Targets: /);
});

test('tuner string buttons show note-only labels for Current Song', () => {
    const src = fs.readFileSync(TUNER_UI_JS, 'utf8');
    assert.match(src, /function _stringButtonLabel/);
    assert.match(src, /selectedTuningName === '_current'/);
    assert.match(src, /text: note/);
    assert.match(src, /title: _stringOrdinal/);
    assert.doesNotMatch(src, /text: stringNum \+ ' ' \+ note/);
});

test('tuner panel shows visible low-to-high string order helper for Current Song', () => {
    const src = fs.readFileSync(TUNER_UI_JS, 'utf8');
    const helpBlock = src.slice(
        src.indexOf('function _syncStringOrderHelp'),
        src.indexOf('function renderStringNotes')
    );
    assert.match(src, /function _syncStringOrderHelp/);
    assert.match(src, /stringOrderHelpContainer/);
    assert.match(src, /Tune low-to-high:/);
    assert.match(src, /string → 1st string/);
    assert.match(helpBlock, /selectedTuningName === '_current'/);
    assert.doesNotMatch(helpBlock, /!state\.freeTune/);
});

test('player-active tuner placement shifts left of LIVE HUD', () => {
    const src = fs.readFileSync(TUNER_UI_JS, 'utf8');
    const playerBranch = src.slice(
        src.indexOf('if (isPlayer && playerEl)'),
        src.indexOf('if (!wrap)')
    );
    assert.match(playerBranch, /top:5rem;right:11rem/);
    assert.doesNotMatch(playerBranch, /top:5rem;right:1\.25rem/);
});

test('non-player tuner placement remains bottom-right', () => {
    const src = fs.readFileSync(TUNER_UI_JS, 'utf8');
    assert.match(src, /bottom:5rem;right:1\.25rem/);
});

test('bass Current Song helper uses 4th string to 1st string label', () => {
    const details = displayTuningTargetDetails([0, 0, 0, 0], BASS_CTX);
    assert.equal(details.length, 4);
    assert.equal(details[0].title, '4th string: E1');
    assert.equal(details[3].title, '1st string: G2');
});

test('Current Song helper hidden when no tuning targets exist', () => {
    const src = fs.readFileSync(TUNER_UI_JS, 'utf8');
    const helpBlock = src.slice(
        src.indexOf('function _syncStringOrderHelp'),
        src.indexOf('function renderStringNotes')
    );
    assert.match(helpBlock, /selectedTuning\.length > 0/);
    assert.match(helpBlock, /classList\.add\('hidden'\)/);
});

test('tuner player button calls window.tuner.toggle', () => {
    const src = fs.readFileSync(TUNER_UI_JS, 'utf8');
    assert.match(src, /btn\.id = 'btn-tuner-player'/);
    assert.match(src, /btn\.onclick = window\.tuner\.toggle/);
});
