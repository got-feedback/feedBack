// Source-level guard for the 3D Highway overlay fully covering #highway.
//
// The `.h3d-wrap` overlay is anchored to top:0/left:0/right:0 of its offset
// parent, which only lines up with #highway when the canvas sits at the
// parent's origin. The v3 player can place chrome above the canvas, shifting
// the wrap up so its lower edge falls short of #highway and exposes a strip
// of the canvas (the reported gap). applySize() must pin the wrap to the
// canvas's actual offset box so it stays flush. createHighway's WebGL
// lifecycle is too heavy for a vm sandbox, so this locks in the wiring.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const screenJs = path.join(__dirname, '..', '..', 'plugins', 'highway_3d', 'screen.js');

function extractBlock(src, signature) {
    const start = src.indexOf(signature);
    assert.ok(start !== -1, `signature '${signature}' not found`);
    const openBrace = src.indexOf('{', start);
    let depth = 1;
    let i = openBrace + 1;
    while (i < src.length && depth > 0) {
        const ch = src[i];
        if (ch === '{') depth++;
        else if (ch === '}') depth--;
        i++;
    }
    assert.ok(depth === 0, `unbalanced braces after '${signature}'`);
    return src.slice(start, i);
}

test('applySize pins the .h3d-wrap overlay to the highway canvas rect box', () => {
    const src = fs.readFileSync(screenJs, 'utf8');
    const fn = extractBlock(src, 'function applySize(w, h)');
    // Guarded on a laid-out canvas so we never pin to a zero box.
    assert.match(
        fn,
        /highwayCanvas\s*&&\s*highwayCanvas\.offsetWidth\s*>\s*0\s*&&\s*highwayCanvas\.offsetHeight\s*>\s*0/,
        'must guard the pin on a laid-out canvas (offsetWidth/Height > 0)',
    );
    // Size/position must come from getBoundingClientRect (fractional, matches
    // ren.setSize), NOT integer offset* props which round and reopen the strip.
    assert.match(fn, /highwayCanvas\.getBoundingClientRect\(\)/, 'must measure the canvas via getBoundingClientRect');
    assert.doesNotMatch(fn, /wrap\.style\.width\s*=\s*highwayCanvas\.offsetWidth/, 'must NOT size to integer offsetWidth');
    assert.doesNotMatch(fn, /wrap\.style\.height\s*=\s*highwayCanvas\.offsetHeight/, 'must NOT size to integer offsetHeight');
    // Width/height set from the rect; position is parent-relative (padding edge).
    assert.match(fn, /wrap\.style\.width\s*=\s*_cr\.width/, 'must size width to the canvas rect width');
    assert.match(fn, /wrap\.style\.height\s*=\s*_cr\.height/, 'must size height to the canvas rect height');
    assert.match(fn, /wrap\.style\.top\s*=\s*\(\s*_cr\.top\s*-\s*_pr\.top\s*-\s*_pbTop\s*\)/, 'top must be canvas rect relative to the containing block padding edge');
    assert.match(fn, /wrap\.style\.left\s*=\s*\(\s*_cr\.left\s*-\s*_pr\.left\s*-\s*_pbLeft\s*\)/, 'left must be canvas rect relative to the containing block padding edge');
    assert.match(fn, /clientTop/, 'must strip the parent border via clientTop');
    // right:0 must be released so the explicit width takes effect.
    assert.match(fn, /wrap\.style\.right\s*=\s*['"]auto['"]/, "must release right:0 (set 'auto') when pinning width");
});

test('applySize fallback resets the static anchor and the computed height', () => {
    const src = fs.readFileSync(screenJs, 'utf8');
    const fn = extractBlock(src, 'function applySize(w, h)');
    // The not-laid-out fallback must clear any stale pin styles (a prior pin
    // leaves top/left/right:auto/width set) back to the original
    // top:0;left:0;right:0;width:auto anchor, or the wrap reappears at a
    // stale horizontal position after a panel hide/show.
    const fallback = fn.slice(fn.indexOf('} else {'));
    assert.match(fallback, /wrap\.style\.top\s*=\s*['"]0['"]/, 'fallback must reset top:0');
    assert.match(fallback, /wrap\.style\.left\s*=\s*['"]0['"]/, 'fallback must reset left:0');
    assert.match(fallback, /wrap\.style\.right\s*=\s*['"]0['"]/, 'fallback must reset right:0');
    assert.match(fallback, /wrap\.style\.width\s*=\s*['"]auto['"]/, 'fallback must reset width:auto');
    assert.match(fallback, /wrap\.style\.height\s*=\s*h\s*\+\s*['"]px['"]/, 'fallback must keep the computed height');
});

test('applySize records whether the overlay pin was applied (_wrapPinned)', () => {
    const src = fs.readFileSync(screenJs, 'utf8');
    const fn = extractBlock(src, 'function applySize(w, h)');
    // Pin path sets the flag true; the not-laid-out fallback sets it false
    // so the rAF loop knows the pin is still pending.
    assert.match(fn, /_wrapPinned\s*=\s*true/, 'pin path must set _wrapPinned = true');
    assert.match(fn, /_wrapPinned\s*=\s*false/, 'fallback path must set _wrapPinned = false');
});

test('the rAF loop re-pins the overlay once the canvas lays out (Codex P1)', () => {
    // When init() pins via the parent-panel fallback (offset box still 0) and
    // the canvas later lays out to the SAME logical size, neither size-drift
    // branch fires. A dedicated branch must re-run applySize so the overlay
    // gets pinned to the now-real canvas box instead of leaving the exposed
    // strip the fix was meant to close.
    const src = fs.readFileSync(screenJs, 'utf8');
    assert.match(
        src,
        /else if\s*\(\s*!_wrapPinned\s*&&\s*box\.w\s*>\s*0\s*&&\s*box\.h\s*>\s*0\s*&&\s*highwayCanvas\.offsetWidth\s*>\s*0\s*&&\s*highwayCanvas\.offsetHeight\s*>\s*0\s*\)\s*\{\s*[\s\S]*?applySize\(\s*box\.w\s*,\s*box\.h\s*\)\s*;/,
        'must re-pin via applySize when !_wrapPinned and the canvas has laid out',
    );
});
