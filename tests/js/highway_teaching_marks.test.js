// Behavioural tests for the teaching-marks (§6.2.2) render helpers:
// teachingFingerLabel / teachingDegreeLabel (both highways) and
// strumGroupBuckets (2D, drives the strum bracket). All pure, so we extract
// the function source by brace-matching and eval it in isolation — same
// pattern as highway_bend_curve.test.js.

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

// R3c: the PURE geometry/label primitives were carved out of highway.js into
// static/js/highway-geometry.js. Same bodies, byte-for-byte — only the file moved.
const fingerLabel2D = loadFn('static/js/highway-geometry.js', 'teachingFingerLabel');
const degreeLabel2D = loadFn('static/js/highway-geometry.js', 'teachingDegreeLabel');
const fingerLabel3D = loadFn('plugins/highway_3d/screen.js', 'teachingFingerLabel');
const degreeLabel3D = loadFn('plugins/highway_3d/screen.js', 'teachingDegreeLabel');
const strumGroupBuckets = loadFn('static/highway.js', 'strumGroupBuckets');

// ── teachingFingerLabel (fg) ─────────────────────────────────────────────────

for (const [name, fn] of [['2D', fingerLabel2D], ['3D', fingerLabel3D]]) {
    test(`teachingFingerLabel (${name}) maps 0->T, 1..4->digit, else ''`, () => {
        assert.equal(fn(0), 'T');     // thumb
        assert.equal(fn(1), '1');
        assert.equal(fn(4), '4');     // pinky
        assert.equal(fn(-1), '');     // unset
        assert.equal(fn(5), '');      // out of range
        assert.equal(fn(1.5), '');    // non-integer
        assert.equal(fn(undefined), '');
        assert.equal(fn(null), '');
    });
}

// ── teachingDegreeLabel (sd) ─────────────────────────────────────────────────

for (const [name, fn] of [['2D', degreeLabel2D], ['3D', degreeLabel3D]]) {
    test(`teachingDegreeLabel (${name}) shows 0..11, else ''`, () => {
        assert.equal(fn(0), '0');     // tonic
        assert.equal(fn(7), '7');     // fifth
        assert.equal(fn(11), '11');
        assert.equal(fn(-1), '');     // unset
        assert.equal(fn(12), '');     // out of range
        assert.equal(fn(3.2), '');    // non-integer
        assert.equal(fn(undefined), '');
    });
}

// ── strumGroupBuckets (ch) ───────────────────────────────────────────────────

test('strumGroupBuckets groups notes sharing a ch >= 0, dropping lone notes', () => {
    const items = [
        { id: 'a', ch: 5 },
        { id: 'b', ch: -1 },   // ungrouped
        { id: 'c', ch: 5 },
        { id: 'd', ch: 7 },    // lone group (only one member) -> dropped
        { id: 'e', ch: 5 },
    ];
    const groups = strumGroupBuckets(items);
    assert.equal(groups.length, 1);
    assert.deepEqual(groups[0].map(n => n.id), ['a', 'c', 'e']);
});

test('strumGroupBuckets preserves first-seen group order and handles multiple groups', () => {
    const items = [
        { id: 'a', ch: 2 }, { id: 'b', ch: 9 },
        { id: 'c', ch: 2 }, { id: 'd', ch: 9 },
    ];
    const groups = strumGroupBuckets(items);
    assert.deepEqual(groups.map(g => g.map(n => n.id)), [['a', 'c'], ['b', 'd']]);
});

test('strumGroupBuckets ignores non-integer / negative ch and bad input', () => {
    assert.deepEqual(strumGroupBuckets([{ ch: -1 }, { ch: 1.5 }, { ch: null }, {}]), []);
    assert.deepEqual(strumGroupBuckets([]), []);
    assert.deepEqual(strumGroupBuckets(null), []);
});
