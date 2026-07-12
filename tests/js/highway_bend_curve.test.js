// Behavioural tests for the per-note bend-curve (bnv, §6.2.1) render helpers:
// `bnvNormalizedPoints` (static/highway.js, 2D glyph) and `bnvSampleAt`
// (plugins/highway_3d/screen.js, 3D Y gesture). Both are pure, so we extract
// the function source by brace-matching and eval it in isolation.

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
const bnvNormalizedPoints = loadFn('static/js/highway-geometry.js', 'bnvNormalizedPoints');
const bnvSampleAt = loadFn('plugins/highway_3d/screen.js', 'bnvSampleAt');

// ── bnvNormalizedPoints (2D) ─────────────────────────────────────────────────

test('bnvNormalizedPoints normalizes t to 0..1 across the curve span (no sus)', () => {
    const pts = bnvNormalizedPoints([
        { t: 0.5, v: 0 }, { t: 1.0, v: 2 }, { t: 1.5, v: 0 }]);
    assert.deepEqual(pts, [
        { x: 0, v: 0 }, { x: 0.5, v: 2 }, { x: 1, v: 0 }]);
});

test('bnvNormalizedPoints maps t over the note sus span when given', () => {
    // A bend that completes at t=0.4 of a 0.5s note draws to x=0.8, not x=1 —
    // i.e. it stops short of the glyph's right edge (correct timing shape).
    assert.deepEqual(
        bnvNormalizedPoints([{ t: 0, v: 0 }, { t: 0.25, v: 1 }, { t: 0.4, v: 0 }], 0.5),
        [{ x: 0, v: 0 }, { x: 0.5, v: 1 }, { x: 0.8, v: 0 }]);
    // Points beyond sus clamp to 1; sus<=0 falls back to curve-span mapping.
    assert.deepEqual(bnvNormalizedPoints([{ t: 0, v: 0 }, { t: 1, v: 2 }], 0.5),
        [{ x: 0, v: 0 }, { x: 1, v: 2 }]);
    assert.deepEqual(bnvNormalizedPoints([{ t: 0, v: 0 }, { t: 1, v: 2 }], 0),
        [{ x: 0, v: 0 }, { x: 1, v: 2 }]);
});

test('bnvNormalizedPoints handles degenerate/empty input', () => {
    assert.deepEqual(bnvNormalizedPoints([]), []);
    assert.deepEqual(bnvNormalizedPoints(null), []);
    // All-same-t span collapses x to 0 (no divide-by-zero).
    assert.deepEqual(bnvNormalizedPoints([{ t: 1, v: 1 }, { t: 1, v: 2 }]),
        [{ x: 0, v: 1 }, { x: 0, v: 2 }]);
});

// ── bnvSampleAt (3D) ─────────────────────────────────────────────────────────

test('bnvSampleAt linearly interpolates between points', () => {
    const bnv = [{ t: 0, v: 0 }, { t: 1, v: 2 }];
    assert.equal(bnvSampleAt(bnv, 0.5), 1);   // midpoint
    assert.equal(bnvSampleAt(bnv, 0.25), 0.5);
});

test('bnvSampleAt clamps to the endpoints', () => {
    const bnv = [{ t: 0.2, v: 1 }, { t: 0.8, v: 3 }];
    assert.equal(bnvSampleAt(bnv, 0), 1);     // before first
    assert.equal(bnvSampleAt(bnv, 5), 3);     // after last
});

test('bnvSampleAt traces a round-trip curve up then back down', () => {
    const bnv = [{ t: 0, v: 0 }, { t: 0.5, v: 2 }, { t: 1, v: 0 }];
    assert.equal(bnvSampleAt(bnv, 0.25), 1);  // rising
    assert.equal(bnvSampleAt(bnv, 0.5), 2);   // peak
    assert.equal(bnvSampleAt(bnv, 0.75), 1);  // falling
});

test('bnvSampleAt returns 0 for an empty/invalid curve', () => {
    assert.equal(bnvSampleAt([], 0.5), 0);
    assert.equal(bnvSampleAt(null, 0.5), 0);
});

test('bnvSampleAt tolerates a zero-width segment (duplicate t)', () => {
    const bnv = [{ t: 0, v: 0 }, { t: 0.5, v: 1 }, { t: 0.5, v: 2 }, { t: 1, v: 2 }];
    assert.equal(bnvSampleAt(bnv, 0.5), 1);   // first matching segment wins
});
