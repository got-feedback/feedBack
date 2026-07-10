// Source-level guards for the playback-aware paused-render throttle
// (feedBack#654). The createHighway closure owns the rAF loop + WebGL
// context lifecycle that's too heavy to reproduce in a vm sandbox, so —
// like highway_visibility.test.js — these checks lock in the wiring.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const highwayJs = path.join(__dirname, '..', '..', 'static', 'highway.js');

// Brace-balanced extraction (shared shape with highway_visibility.test.js)
// so a future edit that grows the loop body doesn't get truncated.
function extractBlock(src, signature) {
    const start = src.indexOf(signature);
    assert.ok(start !== -1, `signature '${signature}' not found`);
    const openBrace = src.indexOf('{', start);
    assert.ok(openBrace !== -1, `opening brace after '${signature}' not found`);
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

test('highway declares the paused-render throttle state', () => {
    const src = fs.readFileSync(highwayJs, 'utf8');
    assert.match(src, /const\s+_PAUSED_FRAME_INTERVAL_MS\s*=\s*\d+/, 'missing _PAUSED_FRAME_INTERVAL_MS cap');
    assert.match(src, /hwState\._lastPausedDrawAt\s*=\s*0/, 'missing _lastPausedDrawAt accumulator');
});

test('draw() throttles full renders while the audio clock is stalled', () => {
    const src = fs.readFileSync(highwayJs, 'utf8');
    const fn = extractBlock(src, 'function draw()');
    // Reuse getTime()'s pause signal rather than inventing a parallel one.
    assert.match(fn, /_chartLastAdvanceAt/, 'throttle must key off _chartLastAdvanceAt (the advance timestamp)');
    assert.match(fn, /_CHART_MAX_INTERP_MS/, 'throttle must reuse the _CHART_MAX_INTERP_MS pause threshold');
    assert.match(fn, /_PAUSED_FRAME_INTERVAL_MS/, 'throttle must cap paused draws to _PAUSED_FRAME_INTERVAL_MS');
    assert.match(fn, /hwState\._lastPausedDrawAt\s*=\s*_nowP/, 'throttle must record the last paused draw time');
});

test('throttle runs after the ready gate, before bundle/draw', () => {
    const src = fs.readFileSync(highwayJs, 'utf8');
    const fn = extractBlock(src, 'function draw()');
    // Regex landmarks (not exact-string indexOf) so harmless spacing /
    // semicolon changes don't break the ordering guard — matches the
    // search-based style of the other highway source-guard tests.
    const readyIdx = fn.search(/if\s*\(\s*!hwState\.ready\s*\)\s*return;/);
    const throttleIdx = fn.search(/_PAUSED_FRAME_INTERVAL_MS/);
    const drawIdx = fn.search(/_renderer\.draw\s*\(/);
    assert.ok(readyIdx !== -1, 'ready gate not found');
    assert.ok(throttleIdx !== -1, 'throttle not found');
    assert.ok(drawIdx !== -1, '_renderer.draw call not found');
    assert.ok(readyIdx < throttleIdx, 'throttle must come after the ready gate');
    assert.ok(throttleIdx < drawIdx, 'throttle must come before the renderer draw');
});
