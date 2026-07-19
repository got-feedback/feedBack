// Regression coverage for the first-chart-data camera bootstrap in
// plugins/highway_3d/screen.js.
//
// The event selector is pure and tested behaviourally. The renderer lifecycle
// wiring remains source-level, matching the existing highway_3d camera tests:
// constructing a full Three.js renderer in Node would test a large fake DOM/GL
// harness rather than the bootstrap contract itself.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const SCREEN_JS = path.join(__dirname, '..', '..', 'plugins', 'highway_3d', 'screen.js');
const src = fs.readFileSync(SCREEN_JS, 'utf8');

function extractFn(source, name) {
    const start = source.indexOf('function ' + name);
    assert.ok(start >= 0, `function ${name} must exist`);
    const open = source.indexOf('{', start);
    let depth = 0;
    for (let i = open; i < source.length; i++) {
        if (source[i] === '{') depth++;
        else if (source[i] === '}' && --depth === 0) return source.slice(start, i + 1);
    }
    throw new Error(`unbalanced braces extracting ${name}`);
}

function sourceBetween(startText, endText) {
    const start = src.indexOf(startText);
    assert.ok(start >= 0, `missing source anchor: ${startText}`);
    const end = src.indexOf(endText, start);
    assert.ok(end > start, `missing source end anchor: ${endText}`);
    return src.slice(start, end);
}

const hwyFirstRelevantFrettedTime = new Function(
    '"use strict";'
    + extractFn(src, 'hwyFirstRelevantFrettedTime')
    + '\nreturn hwyFirstRelevantFrettedTime;',
)();

test('long intros bootstrap from the earliest future fretted note', () => {
    const notes = [
        { t: 13.22, s: 2, f: 7 },
        { t: 15.0, s: 1, f: 4 },
    ];
    const chords = [
        { t: 14.0, notes: [{ s: 0, f: 3 }, { s: 1, f: 5 }] },
    ];
    assert.equal(hwyFirstRelevantFrettedTime(notes, chords, 0.4, 0.2, 6), 13.22);
});

test('chord-only charts bootstrap from fretted chord members', () => {
    const chords = [
        { t: 4.0, notes: [{ s: 0, f: 0 }, { s: 1, f: 0 }] },
        { t: 8.5, notes: [{ s: 0, f: 0 }, { s: 1, f: 9 }] },
    ];
    assert.equal(hwyFirstRelevantFrettedTime([], chords, 0, 0.2, 6), 8.5);
});

test('empty and all-open charts keep the default camera', () => {
    assert.equal(hwyFirstRelevantFrettedTime([], [], 0, 0.2, 6), null);
    assert.equal(hwyFirstRelevantFrettedTime(
        [{ t: 2, s: 0, f: 0 }],
        [{ t: 3, notes: [{ s: 1, f: 0 }, { s: 2, f: 0 }] }],
        0,
        0.2,
        6,
    ), null);
});

test('bootstrap ignores malformed strings but supports extended-range charts', () => {
    const notes = [
        { t: 1, s: -1, f: 4 },
        { t: 2, s: 7, f: 5 },
        { t: 3, s: 6, f: 8 },
    ];
    assert.equal(hwyFirstRelevantFrettedTime(notes, [], 0, 0.2, 6), null);
    assert.equal(hwyFirstRelevantFrettedTime(notes, [], 0, 0.2, 7), 3);
});

test('active sustains bootstrap at now and fully expired events are skipped', () => {
    const now = 10;
    assert.equal(hwyFirstRelevantFrettedTime(
        [{ t: 6, sus: 5, s: 2, f: 7 }],
        [],
        now,
        0.2,
        6,
    ), now);
    assert.equal(hwyFirstRelevantFrettedTime(
        [{ t: 6, sus: 1, s: 2, f: 7 }, { t: 15, s: 2, f: 9 }],
        [],
        now,
        0.2,
        6,
    ), 15);
});

test('recent onsets inside the behind-window bootstrap at now', () => {
    assert.equal(hwyFirstRelevantFrettedTime(
        [{ t: 9.9, s: 2, f: 7 }],
        [],
        10,
        0.2,
        6,
    ), 10);
});

test('bootstrap runs once when complete chart arrays arrive', () => {
    const bootstrap = sourceBetween(
        '// ── Camera bootstrap (first chart data)',
        '            pbBeg(4);',
    );
    assert.match(
        bootstrap,
        /if\s*\(\s*!_camSnapped\s*&&\s*!_camPreScanned\s*&&\s*notes\s*&&\s*chords\s*\)/,
        'chart bootstrap must be gated to one pass after both arrays arrive',
    );
    assert.match(
        bootstrap,
        /hwyFirstRelevantFrettedTime\(\s*notes\s*,\s*chords\s*,\s*now\s*,\s*CAM_TGT_BEHIND\s*,\s*nStr\s*\)/,
        'bootstrap must select the first relevant event using the active string count',
    );
    assert.match(
        bootstrap,
        /firstFrettedTime\s*===\s*null[\s\S]*?_camSnapped\s*=\s*true/,
        'all-open/empty charts without lookahead bounds must permanently disable bootstrap work',
    );
});

test('steady and lookahead modes initialize immediately from future chart data', () => {
    const bootstrap = sourceBetween(
        '// ── Camera bootstrap (first chart data)',
        '            pbBeg(4);',
    );
    assert.match(
        bootstrap,
        /cameraMode\s*===\s*'lookahead'[\s\S]*?lookaheadBoundsNow\s*\|\|\s*firstFrettedTime\s*!==\s*null/,
        'lookahead anchor bounds must bootstrap even on an all-open chart',
    );
    assert.match(
        bootstrap,
        /lookaheadBootstrapTime\(\s*now\s*,\s*firstFrettedTime\s*\)/,
        'lookahead mode must project to the first window that reaches the phrase',
    );
    assert.match(
        bootstrap,
        /lookaheadBoundsNow\s*\?\s*now\s*:\s*lookaheadBootstrapTime/,
        'already-live anchor/note bounds must win over a projected lookahead',
    );
    assert.match(
        bootstrap,
        /Math\.max\(\s*now\s*,\s*firstFrettedTime\s*-\s*camAhead\s*\)/,
        'steady mode must sample when the first event enters its normal target window',
    );
    assert.match(
        bootstrap,
        /curX\s*=\s*tgtX\s*;[\s\S]*?curDist\s*=\s*tgtDist\s*;/,
        'the initial base position must be applied before the note draw loop',
    );
});

test('silent-intro hold hands off only when live framing is ready', () => {
    const target = sourceBetween(
        '// ── Camera target',
        '// ── Chord diagram:',
    );
    assert.match(
        target,
        /cameraMode\s*===\s*'lookahead'\s*\?\s*lookaheadBoundsNow\s*!==\s*null\s*:\s*camDistGot/,
        'lookahead and steady modes must use their own live-ready signal',
    );
    assert.match(
        target,
        /if\s*\(\s*bootstrapHoldActive\s*\)[\s\S]*?lockActive\s*=\s*prevLockActive/,
        'the bootstrap target must remain untouched while the live window is empty',
    );
    assert.match(
        target,
        /_camBootstrapMode\s*!==\s*cameraMode[\s\S]*?_camBootstrapHolding\s*=\s*false/,
        'a live camera-mode change must safely release the old-mode hold',
    );
});

test('song changes and teardown reset every bootstrap state field', () => {
    const resetAssignments = src.match(
        /_camSnapped\s*=\s*false\s*;\s*\r?\n\s*_camPreScanned\s*=\s*false\s*;\s*\r?\n\s*_camBootstrapHolding\s*=\s*false\s*;\s*\r?\n\s*_camBootstrapMode\s*=\s*null\s*;/g,
    ) || [];
    assert.equal(
        resetAssignments.length,
        2,
        'song-change and teardown paths must both reset bootstrap state',
    );
});

test('Camera Director still layers after the bootstrapped auto-framing base', () => {
    const bootstrap = sourceBetween(
        '// ── Camera bootstrap (first chart data)',
        '            pbBeg(4);',
    );
    assert.doesNotMatch(
        bootstrap,
        /_freeCam|__h3dCamCtl/,
        'bootstrap must only initialize base framing, never mutate Camera Director state',
    );

    const camUpdate = extractFn(src, 'camUpdate');
    const baseIndex = camUpdate.indexOf('curX += (tgtX - curX) * lerp');
    const directorIndex = camUpdate.indexOf('if (_freeCam && _freeCam.enabled)');
    const positionIndex = camUpdate.indexOf('cam.position.set(_camX, _camY, _camZ)');
    assert.ok(
        baseIndex >= 0 && directorIndex > baseIndex && positionIndex > directorIndex,
        'Camera Director transforms must remain layered after base framing and before camera placement',
    );
});
