// Source-level guards for the load-adaptive render scale (feedBack#654).
// The createHighway closure owns the rAF loop + WebGL sizing that's too
// heavy for a vm sandbox, so — like highway_visibility.test.js — these
// lock in the wiring rather than execute it.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const highwayJs = path.join(__dirname, '..', '..', 'static', 'highway.js');

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

test('highway declares adaptive-scale state with a floor', () => {
    const src = fs.readFileSync(highwayJs, 'utf8');
    assert.match(src, /let\s+_autoScale\s*=\s*1/, 'missing _autoScale multiplier');
    assert.match(src, /const\s+_AUTO_SCALE_MIN\s*=\s*0?\.25/, 'missing _AUTO_SCALE_MIN floor (0.25)');
    assert.match(src, /const\s+_DRAW_BUDGET_HI_MS\s*=\s*\d+/, 'missing high draw budget');
    assert.match(src, /const\s+_DRAW_BUDGET_LO_MS\s*=\s*\d+/, 'missing low draw budget');
});

test('_effectiveRenderScale clamps user ceiling * auto factor to [MIN, 1]', () => {
    const src = fs.readFileSync(highwayJs, 'utf8');
    const fn = extractBlock(src, 'function _effectiveRenderScale()');
    // Derives from the (sanitized) user ceiling and auto factor.
    assert.match(fn, /_renderScale/, 'effective scale must derive from the user _renderScale');
    assert.match(fn, /_autoScale/, 'effective scale must derive from the auto factor _autoScale');
    assert.match(fn, /user\s*\*\s*auto/, 'effective scale must multiply the sanitized factors');
    assert.match(fn, /_autoScaleMin/, 'must floor at the configurable _autoScaleMin');
    assert.match(fn, /Math\.min\(\s*user/, 'must cap the effective scale at the user ceiling');
});

test('min render scale floor is user-configurable + exposed on the api (#654)', () => {
    const src = fs.readFileSync(highwayJs, 'utf8');
    // Hard floor constant kept; configurable floor read from localStorage.
    assert.match(src, /let\s+_autoScaleMin\s*=/, 'missing configurable _autoScaleMin');
    assert.match(src, /localStorage\.getItem\('highwayMinRenderScale'\)/,
        'configurable floor must load from localStorage.highwayMinRenderScale');
    assert.match(src, /setMinRenderScale\(/, 'api.setMinRenderScale missing');
    assert.match(src, /getMinRenderScale\(\)\s*\{\s*return\s+_autoScaleMin/, 'api.getMinRenderScale missing');
    // Floor is clamped to the user ceiling so it can never exceed the manual cap.
    const eff = extractBlock(src, 'function _effectiveRenderScale()');
    assert.match(eff, /Math\.min\(\s*_autoScaleMin\s*,\s*user\s*\)/,
        'effective scale must clamp the floor to the user ceiling');
    // _adaptRenderScale must cap the lo bound at 1 so _autoScale stays in [_,1].
    const adapt = extractBlock(src, 'function _adaptRenderScale(');
    assert.match(adapt, /Math\.min\(\s*1\s*,\s*_autoScaleMin\s*\/\s*_renderScale\s*\)/,
        'lo bound must be capped at 1 to keep _autoScale a [0,1] multiplier');
});

test('_adaptRenderScale uses the draw budget + cooldown and re-applies via resize', () => {
    const src = fs.readFileSync(highwayJs, 'utf8');
    const fn = extractBlock(src, 'function _adaptRenderScale(');
    assert.match(fn, /_DRAW_BUDGET_HI_MS/, 'must scale down past the high budget');
    assert.match(fn, /_DRAW_BUDGET_LO_MS/, 'must scale up below the low budget');
    assert.match(fn, /_AUTO_ADJUST_COOLDOWN_MS/, 'must respect the adjust cooldown');
    assert.match(fn, /api\.resize\(\)/, 'a scale change must re-apply through api.resize()');
});

test('draw() only adapts during active playback and feeds the HUD', () => {
    const src = fs.readFileSync(highwayJs, 'utf8');
    const fn = extractBlock(src, 'function draw()');
    assert.match(fn, /if\s*\(\s*!_paused\s*\)\s*_adaptRenderScale/, 'must skip adaptation while paused');
    assert.match(fn, /_updatePerfHud\(\)/, 'must update the perf HUD each drawn frame');
});

test('bundle + canvas sizing use the effective scale, not the raw user value', () => {
    const src = fs.readFileSync(highwayJs, 'utf8');
    assert.match(src, /renderScale:\s*_effectiveRenderScale\(\)/, 'bundle.renderScale must be the effective scale');
    assert.match(src, /canvas\.width\s*=\s*Math\.round\(w\s*\*\s*_effectiveRenderScale\(\)\)/, 'canvas backing store must use effective scale');
});

test('api exposes effective scale + perf stats', () => {
    const src = fs.readFileSync(highwayJs, 'utf8');
    assert.match(src, /getEffectiveRenderScale\(\)\s*\{\s*return\s+_effectiveRenderScale\(\)/, 'api.getEffectiveRenderScale missing');
    assert.match(src, /getPerfStats\(\)\s*\{/, 'api.getPerfStats missing');
});

// Robustness fixes from the #655 Copilot review.
test('render scale is sanitized on load and effective scale guards non-finite', () => {
    const src = fs.readFileSync(highwayJs, 'utf8');
    assert.match(src, /parseFloat\(localStorage\.getItem\('renderScale'\)[\s\S]{0,160}?Number\.isFinite/,
        'render scale load must validate via Number.isFinite + clamp');
    const eff = extractBlock(src, 'function _effectiveRenderScale()');
    assert.match(eff, /Number\.isFinite/, 'effective scale must guard against non-finite inputs');
});

test('stop() tears down the perf HUD and resets per-session accumulators', () => {
    const src = fs.readFileSync(highwayJs, 'utf8');
    assert.match(src, /stop\(\)\s*\{[\s\S]{0,400}?_perfHud\.remove\(\)/,
        'stop() must remove the perf HUD so it cannot strand in the DOM');
    assert.match(src, /stop\(\)\s*\{[\s\S]{0,1200}?_autoScale\s*=\s*1/,
        'stop() must reset _autoScale so the next session starts at the manual scale');
    assert.match(src, /stop\(\)\s*\{[\s\S]{0,1200}?_lastPausedDrawAt\s*=\s*0/,
        'stop() must reset _lastPausedDrawAt so a quick stop→init has fresh paused-throttle timing');
});

test('perf HUD throttles its localStorage flag read off the hot path', () => {
    const src = fs.readFileSync(highwayJs, 'utf8');
    const fn = extractBlock(src, 'function _updatePerfHud()');
    assert.match(fn, /_hudFlagAt/, 'HUD must cache the flag and re-read on an interval, not every frame');
});
