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


// R3c: highway.js is being carved into modules, so its source is no longer ONE file. Read the
// whole set. Re-pinning these assertions at whichever file currently holds a constant just
// means they break again on the next carve — and worse, a source-shape assertion that silently
// stops finding its target is indistinguishable from one that passes.
function highwaySources() {
    const root = path.join(__dirname, '..', '..');
    const jsDir = path.join(root, 'static', 'js');
    const parts = [fs.readFileSync(path.join(root, 'static', 'highway.js'), 'utf8')];
    for (const f of fs.readdirSync(jsDir).sort()) {
        if (f.startsWith('highway-') && f.endsWith('.js')) {
            parts.push(fs.readFileSync(path.join(jsDir, f), 'utf8'));
        }
    }
    return parts.join('\n');
}

test('highway declares the paused-render throttle state', () => {
    const src = highwaySources();
    assert.match(src, /(?:export\s+)?const\s+_PAUSED_FRAME_INTERVAL_MS\s*=\s*\d+/, 'missing _PAUSED_FRAME_INTERVAL_MS cap');
    assert.match(src, /hwState\._lastPausedDrawAt\s*=\s*0/, 'missing _lastPausedDrawAt accumulator');
});

test('draw() throttles full renders while the audio clock is stalled', () => {
    const src = highwaySources();
    const fn = extractBlock(src, 'function draw()');
    // Reuse getTime()'s pause signal rather than inventing a parallel one.
    assert.match(fn, /_chartLastAdvanceAt/, 'throttle must key off _chartLastAdvanceAt (the advance timestamp)');
    assert.match(fn, /_CHART_MAX_INTERP_MS/, 'throttle must reuse the _CHART_MAX_INTERP_MS pause threshold');
    assert.match(fn, /_PAUSED_FRAME_INTERVAL_MS/, 'throttle must cap paused draws to _PAUSED_FRAME_INTERVAL_MS');
    assert.match(fn, /hwState\._lastPausedDrawAt\s*=\s*_nowP/, 'throttle must record the last paused draw time');
});

test('throttle runs after the ready gate, before bundle/draw', () => {
    const src = highwaySources();
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

// ── The throttle must not starve a renderer that animates on its own clock ──
//
// The throttle assumes a paused chart is a still picture, so re-rendering it is
// waste. That stopped being true when the venue landed: the 3D highway draws the
// venue's VIDEO backdrop and its reactive crowd into the same canvas as the
// notes, so capping paused frames capped the whole room — pausing the song
// dropped the venue to ~10 fps ("everything around the highway drops fps").
//
// Renderers now opt out via an optional needsContinuousFrames(). Absent or
// throwing must mean false, so every other renderer keeps the throttle.

test('paused throttle defers to a renderer that needs continuous frames', () => {
    const src = highwaySources();
    const fn = extractBlock(src, 'function draw()');
    assert.match(fn, /_rendererNeedsContinuousFrames\s*\(\s*\)/,
        'the paused throttle must consult the renderer capability');
    // The capability must GATE the early-return, not merely be called near it:
    // the throttle only applies when the renderer does NOT need every frame.
    assert.match(
        fn,
        /!\s*_rendererNeedsContinuousFrames\s*\(\s*\)[\s\S]{0,160}_PAUSED_FRAME_INTERVAL_MS[\s\S]{0,40}return;/,
        'throttle must be skipped when the renderer needs continuous frames',
    );
});

test('the capability probe fails closed (absent / non-function / throwing)', () => {
    const src = highwaySources();
    const fn = extractBlock(src, 'function _rendererNeedsContinuousFrames()');
    assert.match(fn, /typeof\s+r\.needsContinuousFrames\s*!==\s*'function'[\s\S]{0,40}return false/,
        'a renderer without the method must keep the throttle');
    assert.match(fn, /catch[\s\S]{0,40}return false/,
        'a throwing renderer must keep the throttle, not crash the draw loop');
    assert.match(fn, /===\s*true/,
        'only an explicit true opts out — a truthy accident must not disable the throttle');
});

test('3D highway claims continuous frames only while a crowd video is rolling', () => {
    const h3d = fs.readFileSync(
        path.join(__dirname, '..', '..', 'plugins', 'highway_3d', 'screen.js'), 'utf8');
    const fn = extractBlock(h3d, 'needsContinuousFrames()');
    assert.match(fn, /_venueCrowdVideos/, 'must key off the actual crowd video elements');
    assert.match(fn, /\.paused/, 'a paused video is a still frame — throttle should still apply');
    // With no venue pack (the common case) the paused scene really is static and
    // the GPU saving must survive: the method has to be able to return false.
    assert.match(fn, /return false;/, 'must fall through to false with no live video');
});
