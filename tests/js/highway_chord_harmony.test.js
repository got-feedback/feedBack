// Behavioural tests for the chord harmony-annotation render helper
// chordHarmonyLabels (§6.3.1 / §6.6), shared by the 2D and 3D highways.
// Pure, so we extract the function source by brace-matching and eval it in
// isolation — same pattern as highway_teaching_marks.test.js.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

function extractFn(src, name) {
    const start = src.indexOf('function ' + name);
    assert.ok(start >= 0, `function ${name} must exist`);
    const open = src.indexOf('{', start);
    let depth = 0;
    for (let i = open; i < src.length; i++) {
        if (src[i] === '{') depth++;
        else if (src[i] === '}' && --depth === 0) return src.slice(start, i + 1);
    }
    throw new Error(`unbalanced braces extracting ${name}`);
}

function loadFn(file, name) {
    const src = fs.readFileSync(path.join(__dirname, '..', '..', file), 'utf8');
    return new Function('"use strict";' + extractFn(src, name) + `\nreturn ${name};`)();
}

const labels2D = loadFn('static/highway.js', 'chordHarmonyLabels');
const labels3D = loadFn('plugins/highway_3d/screen.js', 'chordHarmonyLabels');

for (const [name, fn] of [['2D', labels2D], ['3D', labels3D]]) {
    test(`chordHarmonyLabels (${name}) surfaces rn + voicing + caged + guideTones`, () => {
        assert.deepEqual(fn({ rn: 'ii7', q: 'm7', deg: 2 }, 'open', 'E', [4, 10]),
            { rn: 'ii7', voicing: 'open', caged: 'CAGED: E', guideTones: 'gt 4,10' });
    });

    test(`chordHarmonyLabels (${name}) trims whitespace`, () => {
        assert.deepEqual(fn({ rn: '  V7 ' }, '  drop2 ', '  G  ', []),
            { rn: 'V7', voicing: 'drop2', caged: 'CAGED: G', guideTones: '' });
    });

    test(`chordHarmonyLabels (${name}) empties absent / malformed inputs`, () => {
        assert.deepEqual(fn(null, undefined),
            { rn: '', voicing: '', caged: '', guideTones: '' });
        assert.deepEqual(fn({}, ''),
            { rn: '', voicing: '', caged: '', guideTones: '' });
        assert.deepEqual(fn({ rn: 7 }, 7),   // non-string
            { rn: '', voicing: '', caged: '', guideTones: '' });
        assert.deepEqual(fn(undefined, 'shell'),
            { rn: '', voicing: 'shell', caged: '', guideTones: '' });
        assert.deepEqual(fn({ rn: 'vi' }, null),
            { rn: 'vi', voicing: '', caged: '', guideTones: '' });
    });

    test(`chordHarmonyLabels (${name}) rejects invalid caged enum`, () => {
        assert.equal(fn(null, null, 'X').caged, '');        // not a CAGED letter
        assert.equal(fn(null, null, 'e').caged, '');        // lower-case rejected
        assert.equal(fn(null, null, 7).caged, '');          // non-string
        assert.equal(fn(null, null, ['E']).caged, '');      // non-string
        assert.equal(fn(null, null, 'C').caged, 'CAGED: C');
    });

    test(`chordHarmonyLabels (${name}) filters out-of-range / non-int guide tones`, () => {
        assert.equal(fn(null, null, '', [12, -1, 3, 'x', 10]).guideTones, 'gt 3,10');
        assert.equal(fn(null, null, '', [0, 11]).guideTones, 'gt 0,11');  // boundaries kept
        assert.equal(fn(null, null, '', []).guideTones, '');
        assert.equal(fn(null, null, '', '4,10').guideTones, '');          // non-array
        assert.equal(fn(null, null, '', [12, -1]).guideTones, '');        // all dropped
    });
}
