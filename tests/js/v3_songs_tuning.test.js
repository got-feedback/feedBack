'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const SONGS_JS = path.join(__dirname, '..', '..', 'static', 'v3', 'songs.js');
// The tuning-display helpers were carved out of app.js into their own module (R3a).
const APP_JS = path.join(__dirname, '..', '..', 'static', 'js', 'tuning-display.js');

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
        + 'exports.displayTuningName = displayTuningName;\n'
        + 'exports.displayTuningTargets = displayTuningTargets;\n'
        + 'exports.parseRawTuningOffsets = parseRawTuningOffsets;',
        sandbox
    );
    return sandbox.exports;
}

function renderSongCardBadge(song, helpers) {
    const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => (
        { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    const tuningLabel = helpers.displayTuningName(song.tuning_name || song.tuning);
    if (!tuningLabel) return '';
    const rawOffsets = helpers.parseRawTuningOffsets(song.tuning_offsets)
        || helpers.parseRawTuningOffsets(song.tuning_name || song.tuning);
    const targetNotes = (tuningLabel === 'Custom Tuning' && rawOffsets)
        ? helpers.displayTuningTargets(rawOffsets, { tuningName: tuningLabel })
        : '';
    if (targetNotes) {
        return '<span class="absolute top-2 left-2 bg-fb-mid text-black text-[9px] font-bold px-1.5 py-0.5 rounded-sm leading-tight max-w-[5.5rem] text-center">'
            + esc('Custom Tuning') + '<br><span class="font-semibold tracking-wide">' + esc(targetNotes) + '</span></span>';
    }
    return '<span class="absolute top-2 left-2 bg-fb-mid text-black text-[10px] font-bold px-1.5 py-0.5 rounded-sm">' + esc(tuningLabel) + '</span>';
}

const helpers = loadTuningHelpers();

test('v3 songs.js uses display helpers for album-art tuning badge', () => {
    const src = fs.readFileSync(SONGS_JS, 'utf8');
    // The card renderer's row variable was renamed song → shown when grouped
    // cards landed (the badge reads the representative chart); accept either.
    assert.match(src, /displayTuningName\((?:song|shown)\.tuning_name \|\| (?:song|shown)\.tuning\)/);
    assert.match(src, /displayTuningTargets/);
    assert.match(src, /parseRawTuningOffsets/);
});

test('raw offset tuning_name does not appear in rendered card HTML', () => {
    const html = renderSongCardBadge({ tuning_name: '-2 0 0 0 -2' }, helpers);
    assert.doesNotMatch(html, /-2 0 0 0 -2/);
    assert.match(html, /Custom Tuning/);
});

test('custom tuning card shows low-to-high note sequence when offsets available', () => {
    const html = renderSongCardBadge({
        tuning_name: 'Custom Tuning',
        tuning_offsets: [-2, 0, 0, 0, -2, -2],
    }, helpers);
    assert.match(html, /Custom Tuning/);
    assert.match(html, /D A D G A D/);
    assert.doesNotMatch(html, /6:|D2|5th/);
});

test('known tuning appears unchanged in card HTML', () => {
    const html = renderSongCardBadge({ tuning_name: 'E Standard' }, helpers);
    assert.match(html, /E Standard/);
    assert.doesNotMatch(html, /<br>/);
});

test('missing tuning hides badge', () => {
    const html = renderSongCardBadge({ tuning_name: '' }, helpers);
    assert.equal(html, '');
});
