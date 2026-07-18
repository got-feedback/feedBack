// Source-level tests for the chart-transform staging tier in highway.js /
// highway-draw.js. Mirrors highway_filtered_notes.test.js: the createHighway
// closure is too heavy for a Node sandbox, so these lock in the wiring —
// the transformed → filtered → raw fall-through order, restage placement
// AFTER the mastery filter, and the error-isolation path.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const highwayJs = path.join(__dirname, '..', '..', 'static', 'highway.js');
const highwayDrawJs = path.join(__dirname, '..', '..', 'static', 'js', 'highway-draw.js');

function extractBlock(src, marker) {
    const start = src.indexOf(marker);
    assert.ok(start >= 0, `${marker} present`);
    const open = src.indexOf('{', start);
    assert.ok(open >= 0, `${marker} has a body`);
    let depth = 0;
    for (let i = open; i < src.length; i++) {
        if (src[i] === '{') depth += 1;
        else if (src[i] === '}') {
            depth -= 1;
            if (depth === 0) return src.slice(start, i + 1);
        }
    }
    assert.fail(`${marker} body is balanced`);
}

test('highway public API exposes the chart-transform hook', () => {
    const src = fs.readFileSync(highwayJs, 'utf8');
    assert.match(src, /setChartTransform\s*\(\s*p\s*\)\s*\{/, 'setChartTransform exists');
    assert.match(src, /getChartTransform\s*\(\s*\)\s*\{[^}]*_xfProvider/, 'getChartTransform returns the provider');
    assert.match(src, /refreshChartTransform\s*\(\s*\)\s*\{[^}]*_restageChartTransform/, 'refreshChartTransform restages');
});

test('restage runs at BOTH exits of _rebuildMasteryFilter (transform after difficulty)', () => {
    const src = fs.readFileSync(highwayJs, 'utf8');
    const fnStart = src.indexOf('function _rebuildMasteryFilter()');
    const fnEnd = src.indexOf('function _clearChartTransformStage');
    assert.ok(fnStart > -1 && fnEnd > fnStart, 'both functions present in order');
    const body = src.slice(fnStart, fnEnd);
    const calls = body.match(/_restageChartTransform\(\);/g) || [];
    assert.equal(calls.length, 2, 'restage at the early return and the normal exit');
});

test('restage consumes the difficulty-filtered arrays, not the raw chart', () => {
    const src = fs.readFileSync(highwayJs, 'utf8');
    const fn = src.slice(src.indexOf('function _restageChartTransform'), src.indexOf('// ── Public API'));
    assert.match(fn, /notes:\s*filterActive\s*\?\s*hwState\._filteredNotes\s*:\s*hwState\.notes/);
    assert.match(fn, /allNotes:\s*hwState\.notes/, 'full-difficulty views passed alongside');
});

test('a throwing provider clears the stage and emits highway:chart-transform-failed', () => {
    const src = fs.readFileSync(highwayJs, 'utf8');
    const fn = src.slice(src.indexOf('function _restageChartTransform'), src.indexOf('// ── Public API'));
    assert.match(fn, /catch\s*\(e\)\s*\{[\s\S]*highway:chart-transform-failed[\s\S]*return;/);
    assert.match(fn, /console\.error\('chart transform:', e\)/, 'raw exception stays in the local console');
    assert.doesNotMatch(fn, /reason:\s*e/, 'raw exception is not emitted');
    assert.match(fn, /^\s*_clearChartTransformStage\(\);/m, 'stage cleared before the provider runs');
});

test('bundle assembly prefers the staged transform views', () => {
    const src = fs.readFileSync(highwayJs, 'utf8');
    assert.match(src, /b\.notes = hwState\._xfNotes !== null \? hwState\._xfNotes/);
    assert.match(src, /b\.chords = hwState\._xfChords !== null \? hwState\._xfChords/);
    assert.match(src, /b\.anchors = hwState\._xfAnchors !== null \? hwState\._xfAnchors/);
    assert.match(src, /b\.chordTemplates = hwState\._xfChordTemplates !== null/);
    assert.match(src, /b\.stringCount = hwState\._xfStringCount !== null/);
    assert.match(src, /b\.tuning = hwState\._xfTuning !== null/);
    assert.match(src, /b\.capo = hwState\._xfCapo !== null/);
    assert.match(src, /b\.handShapes = hwState\._xfHandShapes !== null \? hwState\._xfHandShapes/);
    assert.match(src, /b\.centOffset = hwState\._xfCentOffset !== null/);
});

test('transform input carries the effective handShapes; output stages handShapes/centOffset', () => {
    const src = fs.readFileSync(highwayJs, 'utf8');
    const fn = src.slice(src.indexOf('function _restageChartTransform'), src.indexOf('// ── Public API'));
    assert.match(fn, /handShapes: \(hwState\._filteredHandShapes !== null && hwState\._phrasesHaveHandShapes\)/,
        'input handShapes uses the same effective selection as the bundle');
    assert.match(fn, /_sortedChartTransformArray\(out\.handShapes, 'start_time'\)/);
    assert.match(fn, /if \(Number\.isFinite\(out\.centOffset\)\) hwState\._xfCentOffset = out\.centOffset;/);
});

test('unordered provider timelines are copied and normalized for searches and anchor scans', () => {
    const highwaySrc = fs.readFileSync(highwayJs, 'utf8');
    const drawSrc = fs.readFileSync(highwayDrawJs, 'utf8');
    const snippets = [
        extractBlock(highwaySrc, 'function _clearChartTransformStage()'),
        extractBlock(highwaySrc, 'function _sortedChartTransformArray(items, key)'),
        extractBlock(highwaySrc, 'function _restageChartTransform()'),
        extractBlock(highwaySrc, 'function bsearchTime(arr, time)'),
        extractBlock(highwaySrc, 'function getAnchorAt(t)'),
        extractBlock(highwaySrc, 'function getMaxFretInWindow(t)'),
        extractBlock(drawSrc, 'export function bsearch(arr, time)').replace('export ', ''),
    ].join('\n');
    const providerOutput = {
        notes: [{ t: 9 }, { t: 1 }, { t: 5 }],
        chords: [{ t: 8 }, { t: 2 }],
        anchors: [
            { time: 10, fret: 20, width: 2 },
            { time: 0, fret: 1, width: 3 },
            { time: 5, fret: 10, width: 4 },
        ],
        allNotes: [{ t: 7 }, { t: 0 }, { t: 3 }],
        allChords: [{ t: 6 }, { t: 4 }],
        handShapes: [{ start_time: 9 }, { start_time: 1 }],
    };
    const hwState = {
        _xfProvider: { id: 'unordered', transform: () => providerOutput },
        _filteredNotes: [],
        _filteredChords: [],
        _filteredAnchors: [],
        _filteredHandShapes: [],
        _phrasesHaveHandShapes: true,
        notes: [], chords: [], anchors: [], handShapes: [], chordTemplates: [],
        stringCount: 6, songInfo: {},
    };
    const helpers = new Function('hwState', 'window', 'VISIBLE_SECONDS', `
        ${snippets}
        return { _restageChartTransform, bsearch, bsearchTime, getAnchorAt, getMaxFretInWindow };
    `)(hwState, {}, 3);

    helpers._restageChartTransform();

    assert.deepEqual(hwState._xfNotes.map(n => n.t), [1, 5, 9]);
    assert.deepEqual(hwState._xfChords.map(ch => ch.t), [2, 8]);
    assert.deepEqual(hwState._xfNotesAll.map(n => n.t), [0, 3, 7]);
    assert.deepEqual(hwState._xfChordsAll.map(ch => ch.t), [4, 6]);
    assert.deepEqual(hwState._xfAnchors.map(a => a.time), [0, 5, 10]);
    assert.deepEqual(hwState._xfHandShapes.map(h => h.start_time), [1, 9]);
    assert.deepEqual(providerOutput.notes.map(n => n.t), [9, 1, 5], 'provider output is not mutated');
    assert.equal(helpers.bsearch(hwState._xfNotes, 5), 1);
    assert.equal(helpers.bsearchTime(hwState._xfAnchors, 5), 1);
    assert.equal(helpers.getAnchorAt(6).time, 5);
    assert.equal(helpers.getMaxFretInWindow(0), 14);

    hwState._filteredNotes = null;
    hwState._filteredChords = null;
    hwState._xfProvider.transform = () => ({
        notes: [{ t: 4 }, { t: 2 }],
        chords: [{ t: 3 }, { t: 1 }],
    });
    helpers._restageChartTransform();
    assert.deepEqual(hwState._xfNotesAll.map(n => n.t), [2, 4], 'unfiltered notes still fall back');
    assert.deepEqual(hwState._xfChordsAll.map(ch => ch.t), [1, 3], 'unfiltered chords still fall back');
});

test('createHighway announces each instance via highway:created', () => {
    const src = fs.readFileSync(highwayJs, 'utf8');
    assert.match(src, /emit\('highway:created', \{ highway: api \}\)/,
        'factory emits highway:created with the api instance');
});

test('public getters fall through transformed → filtered → raw', () => {
    const src = fs.readFileSync(highwayJs, 'utf8');
    assert.match(src, /getNotes\(\)\s*\{\s*return hwState\._xfNotesAll !== null/);
    assert.match(src, /getChords\(\)\s*\{\s*return hwState\._xfChordsAll !== null/);
    assert.match(src, /getFilteredNotes\(\)\s*\{\s*if \(hwState\._xfNotes !== null\) return hwState\._xfNotes;/);
    assert.match(src, /getFilteredChords\(\)\s*\{\s*if \(hwState\._xfChords !== null\) return hwState\._xfChords;/);
    assert.match(src, /getChordTemplates\(\)\s*\{\s*return hwState\._xfChordTemplates !== null/);
    assert.match(src, /getStringCount\(\)\s*\{\s*return hwState\._xfStringCount !== null/);
});

test('anchor zoom helpers read the staged anchors first', () => {
    const src = fs.readFileSync(highwayJs, 'utf8');
    const anchorSites = src.match(/hwState\._xfAnchors !== null \? hwState\._xfAnchors\s*\n?\s*: hwState\._filteredAnchors !== null/g) || [];
    assert.ok(anchorSites.length >= 2, 'getAnchorAt and getMaxFretInWindow both staged-aware');
});

test('init and reconnect clear the stage but keep the provider', () => {
    const src = fs.readFileSync(highwayJs, 'utf8');
    const initBody = extractBlock(src, 'init(canvasEl, container)');
    const reconnectBody = extractBlock(src, 'reconnect(filename, arrangement)');
    assert.match(initBody, /_clearChartTransformStage\(\);/, 'init clears the stage');
    assert.match(reconnectBody, /_clearChartTransformStage\(\);/, 'reconnect clears the stage');
    assert.ok(!/init\([\s\S]{0,2000}_xfProvider = null/.test(src.slice(src.indexOf('const api = {'))),
        'api reset paths never drop the installed provider');
});

test('default 2D draw path prefers the staged views (drawNotes/drawChords/drawSustains)', () => {
    const src = fs.readFileSync(highwayDrawJs, 'utf8');
    const noteSites = src.match(/hwState\._xfNotes !== null \? hwState\._xfNotes/g) || [];
    assert.ok(noteSites.length >= 2, 'drawNotes and drawSustains staged-aware');
    assert.match(src, /hwState\._xfChords !== null \? hwState\._xfChords/, 'drawChords staged-aware');
});

test('highway_3d nut labels prefer the transform-aware bundle tuning/capo', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', '..', 'plugins', 'highway_3d', 'screen.js'), 'utf8');
    assert.match(src, /let tuning = bundle\.tuning \|\| \(songInfo && songInfo\.tuning\)/,
        'label derivation reads bundle.tuning first');
    assert.match(src, /let cap = bundle\.capo;/,
        'label derivation reads bundle.capo first');
    // Both cache paths must key on the same bundle-first capo the labels
    // use (songInfo stays as the fallback branch of each ternary).
    assert.match(src, /const capo =\s*\n\s*bundle && Number\.isFinite\(bundle\.capo\) \? bundle\.capo/,
        'label signature keys on bundle.capo first');
    assert.match(src, /const capo =\s*\n\s*Number\.isFinite\(bundle\.capo\) \? bundle\.capo/,
        'cheap-key fast path keys on bundle.capo first');
});

test('chord template reads route through the effective-templates helper', () => {
    const src = fs.readFileSync(highwayDrawJs, 'utf8');
    assert.match(src, /export function _effChordTemplates\(hwState\)/);
    assert.ok(!/getChordTemplateInfo\([^)]*,\s*hwState\.chordTemplates\)/.test(src),
        'no direct hwState.chordTemplates read remains at template-info call sites');
    assert.match(src, /_chordRenderCacheTemplates !== effTemplates/, 'render cache keys on effective templates');
});
