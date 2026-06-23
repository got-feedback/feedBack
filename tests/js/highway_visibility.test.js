// Source-level guards for the visibility-aware rAF skip and the
// highway:visibility event (feedBack#246). The createHighway closure
// owns the canvas + WebGL context lifecycle that's too heavy to
// reproduce in a vm sandbox — these checks lock in the wiring instead.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const highwayJs = path.join(__dirname, '..', '..', 'static', 'highway.js');
const highway3dJs = path.join(__dirname, '..', '..', 'plugins', 'highway_3d', 'screen.js');

// Brace-balanced extraction so a future method that grows guards or
// nested blocks doesn't get truncated by a naive `[^}]*\}` regex.
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

test('highway declares visibility state (_visibleOverride + _lastVisible)', () => {
    const src = fs.readFileSync(highwayJs, 'utf8');
    assert.match(src, /let\s+_visibleOverride\s*=\s*null/, 'missing _visibleOverride (override sentinel)');
    assert.match(src, /let\s+_lastVisible\s*=\s*null/, 'missing _lastVisible (last-emitted state)');
});

test('_isHighwayVisible respects _visibleOverride and falls back to offsetParent', () => {
    const src = fs.readFileSync(highwayJs, 'utf8');
    const fn = extractBlock(src, 'function _isHighwayVisible()');
    assert.match(fn, /_visibleOverride\s*!==\s*null/, 'must check the override before the DOM');
    assert.match(fn, /canvas\.offsetParent\s*!==\s*null/, 'DOM fallback must use offsetParent !== null');
});

test('_emitVisibilityIfChanged is transition-only (no per-frame spam)', () => {
    const src = fs.readFileSync(highwayJs, 'utf8');
    const fn = extractBlock(src, 'function _emitVisibilityIfChanged()');
    // Must short-circuit when the current state equals the cached one.
    assert.match(fn, /v\s*===\s*_lastVisible/, 'must compare current vs _lastVisible and bail when equal');
    // Must update the cache and emit the event with the documented payload shape.
    assert.match(fn, /_lastVisible\s*=\s*v/, 'must update _lastVisible after a transition');
    assert.match(
        fn,
        /window\.feedBack\.emit\(\s*['"]highway:visibility['"][\s\S]*?visible:\s*v[\s\S]*?canvas/,
        'must emit highway:visibility with { visible, canvas }',
    );
});

test('rAF draw() loop calls _emitVisibilityIfChanged and skips when hidden', () => {
    const src = fs.readFileSync(highwayJs, 'utf8');
    const fn = extractBlock(src, 'function draw()');
    assert.match(fn, /_emitVisibilityIfChanged\(\)/, 'rAF draw() must call _emitVisibilityIfChanged each tick');
    // Ordering: emit → skip-when-hidden → ready gate → renderer.draw.
    // The emit must run BEFORE the !ready bail so visibility
    // transitions during loading/reconnect windows still propagate.
    const emitIdx = fn.search(/_emitVisibilityIfChanged\(\)/);
    const skipIdx = fn.search(/if\s*\(\s*!_rendering\s*\)\s*return/);
    const readyIdx = fn.search(/if\s*\(\s*!ready\s*\)\s*return/);
    const drawIdx = fn.search(/_renderer\.draw\(/);
    assert.ok(emitIdx !== -1 && skipIdx !== -1 && readyIdx !== -1 && drawIdx !== -1, 'all four landmarks must be present');
    assert.ok(emitIdx < readyIdx, 'emit must run BEFORE the !ready gate (transitions during loading must still fire)');
    assert.ok(skipIdx < readyIdx, 'skip-when-hidden must short-circuit before the ready gate');
    assert.ok(readyIdx < drawIdx, 'ready gate must run before renderer.draw');
});

test('draw() keeps an active custom renderer painting through an override-hide (feedBack#819)', () => {
    // The `_rendering` decision must distinguish a renderer-set override-hide
    // (setVisible(false) — canvas occluded by an opaque overlay, but the
    // active custom renderer still paints its own surface, e.g. Tab View's
    // DOM) from genuine off-screen (offsetParent === null). An active custom
    // renderer keeps getting draw() ONLY while still in layout; the default
    // 2D renderer and the genuine off-screen case still bail.
    const src = fs.readFileSync(highwayJs, 'utf8');
    const fn = extractBlock(src, 'function draw()');
    // Single render decision drives both the perf-HUD reset and the gate.
    assert.match(fn, /let\s+_rendering\s*=\s*_lastVisible/, 'must derive a single _rendering decision from _lastVisible');
    // Assert the exact boolean RELATIONSHIP, not just the tokens (CodeRabbit):
    // the exemption must AND together override-hide, an active custom renderer,
    // and the canvas still in layout. A weakened guard (e.g. `||`, or a dropped
    // offsetParent clause) must fail this — that's the regression being fixed.
    assert.match(
        fn,
        /!_rendering\s*&&\s*_visibleOverride\s*===\s*false\s*&&\s*_renderer\s*!==\s*_defaultRenderer\s*&&\s*canvas\s*&&\s*canvas\.offsetParent\s*!==\s*null/,
        'exemption must AND override-hide + active custom renderer + canvas-in-layout (genuine off-screen still pauses, #246)',
    );
    // Both the HUD reset and the gate key off _rendering, not _lastVisible,
    // so the HUD doesn\'t churn while the custom renderer is actually drawing.
    assert.match(fn, /_perfHud\s*&&\s*\(\s*!_rendering/, 'perf-HUD reset must key off _rendering, not _lastVisible');
    assert.match(fn, /if\s*\(\s*!_rendering\s*\)\s*return/, 'the draw gate must bail on !_rendering');
});

test('api.isVisible() exposes a snapshot for late subscribers', () => {
    // The event is transition-only, so renderers that bind after the
    // initial frame need a way to sync. isVisible() returns the same
    // value _isHighwayVisible() would return on the next tick.
    const src = fs.readFileSync(highwayJs, 'utf8');
    const fn = extractBlock(src, 'isVisible()');
    assert.match(fn, /return\s+_isHighwayVisible\(\)/, 'isVisible() must return _isHighwayVisible()');
});

test('canvas-replace resets _lastVisible so the new canvas re-emits', () => {
    // _lastVisible is per-canvas-lifecycle: a fresh canvas could
    // be in a different displayed state than the one it replaced.
    // Without the reset, _emitVisibilityIfChanged would suppress
    // the first transition on the new canvas.
    const src = fs.readFileSync(highwayJs, 'utf8');
    const fn = extractBlock(src, 'function _replaceCanvas(newType)');
    assert.match(fn, /_lastVisible\s*=\s*null/, '_replaceCanvas must reset _lastVisible so the new canvas re-emits');
});

test('api.setVisible accepts bool / null and re-emits inline', () => {
    const src = fs.readFileSync(highwayJs, 'utf8');
    const fn = extractBlock(src, 'setVisible(v)');
    // null/undefined → clears the override
    assert.match(fn, /v\s*===\s*null\s*\|\|\s*v\s*===\s*undefined/, 'null/undefined must clear the override');
    // Non-null → coerce to boolean
    assert.match(fn, /_visibleOverride\s*=.*\?\s*null\s*:\s*!!v/, 'non-null must coerce to !!v');
    // Re-evaluate immediately so the transition fires on the call, not the next rAF.
    assert.match(fn, /_emitVisibilityIfChanged\(\)/, 'setVisible must call _emitVisibilityIfChanged inline');
});

test('3D Highway subscribes to highway:visibility and toggles wrap on hide', () => {
    const src = fs.readFileSync(highway3dJs, 'utf8');
    // Scope to lifecycle blocks so unrelated / commented mentions
    // elsewhere in screen.js can't cause false positives.
    const initSceneBlock = extractBlock(src, 'function initScene()');
    const teardownBlock = extractBlock(src, 'function teardown()');

    // Listener registration with the documented event name (in init).
    assert.match(
        initSceneBlock,
        /window\.feedBack\.on\(\s*['"]highway:visibility['"]/,
        'initScene must subscribe to highway:visibility',
    );
    // Handler filters by canvas identity so splitscreen panels don't
    // hide each other's overlays — every instance receives every event
    // on the shared feedBack bus, so this gate is essential.
    assert.match(
        initSceneBlock,
        /e\.detail\.canvas\s*!==\s*highwayCanvas/,
        'handler must filter on event.detail.canvas !== highwayCanvas (splitscreen-safe)',
    );
    // Handler toggles wrap.style.display based on visible === false.
    assert.match(
        initSceneBlock,
        /wrap\.style\.display\s*=\s*v\s*===\s*false\s*\?\s*['"]none['"]\s*:\s*['"]['"]/,
        'handler must hide the wrap when visible === false',
    );
    // Initial-sync on bind so renderers that mount while the canvas
    // is already hidden (e.g. plugin loaded mid-splitscreen) don't
    // leave the wrap stuck in the wrong state.
    assert.match(
        initSceneBlock,
        /highwayCanvas\.offsetParent\s*!==\s*null/,
        'initScene must compute initial visibility from local highwayCanvas (splitscreen-safe)',
    );
    // Subscribes to highway:canvas-replaced so the identity gate
    // (event.detail.canvas === highwayCanvas) survives core's
    // context-type-driven canvas swap. Per CLAUDE.md plugin contract.
    assert.match(
        initSceneBlock,
        /window\.feedBack\.on\(\s*['"]highway:canvas-replaced['"]/,
        'initScene must track canvas swaps so the visibility gate keeps matching',
    );
    assert.match(
        initSceneBlock,
        /highwayCanvas\s*=\s*e\.detail\.newCanvas/,
        'canvas-replaced handler must update the local highwayCanvas reference',
    );
    // Teardown unbinds both listeners.
    assert.match(
        teardownBlock,
        /window\.feedBack\.off\(\s*['"]highway:visibility['"]/,
        'teardown must unbind highway:visibility',
    );
    assert.match(
        teardownBlock,
        /window\.feedBack\.off\(\s*['"]highway:canvas-replaced['"]/,
        'teardown must unbind highway:canvas-replaced',
    );
});
