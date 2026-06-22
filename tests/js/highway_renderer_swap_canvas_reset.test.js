// Source-level guard for the renderer-swap canvas reset.
//
// Both 3D visualizations are webgl2 renderers, but they paint to
// different surfaces: the 3D *drum* highway renders directly onto the
// shared #highway canvas, while the 3D *guitar* highway renders into its
// own `.h3d-wrap` sibling overlay and never touches #highway. Switching
// drum -> guitar is webgl2 -> webgl2, so the context-type check alone
// never replaced the canvas — the last drum frame stayed painted on
// #highway and bled through the gap the guitar overlay does not cover.
//
// The fix replaces the underlying <canvas> on ANY swap to a different
// renderer instance (not just on a context-type change) so the incoming
// renderer always starts over a blank surface. These checks lock in the
// wiring; the createHighway closure owns a WebGL lifecycle too heavy to
// reproduce in a vm sandbox.

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

test('_setRenderer captures the outgoing renderer before overwriting it', () => {
    const src = fs.readFileSync(highwayJs, 'utf8');
    const fn = extractBlock(src, 'function _setRenderer(r)');
    // prev must be captured BEFORE _destroyCurrentIfInited and the
    // `_renderer = next` assignment, otherwise the swap detection below
    // would always compare next against itself.
    const prevIdx = fn.search(/const\s+prev\s*=\s*_renderer/);
    const destroyIdx = fn.search(/_destroyCurrentIfInited\(\)/);
    const assignIdx = fn.search(/^\s*_renderer\s*=\s*next\s*;/m);
    assert.ok(prevIdx !== -1, 'must capture `const prev = _renderer`');
    assert.ok(destroyIdx !== -1, 'must call _destroyCurrentIfInited');
    assert.ok(assignIdx !== -1, 'must assign `_renderer = next`');
    assert.ok(prevIdx < destroyIdx, 'prev must be captured before _destroyCurrentIfInited');
    assert.ok(prevIdx < assignIdx, 'prev must be captured before `_renderer = next`');
});

test('_setRenderer replaces the canvas on a context-type change OR a viz change', () => {
    const src = fs.readFileSync(highwayJs, 'utf8');
    const fn = extractBlock(src, 'function _setRenderer(r)');
    // The replace guard must fire on EITHER a context-type change OR a
    // swap to a different visualization. A regression that drops the
    // viz-change clause would let a stale frame bleed through.
    assert.match(
        fn,
        /const\s+_vizChanged\s*=\s*prev\s*&&\s*_rendererVizKey\(next\)\s*!==\s*_rendererVizKey\(prev\)/,
        '_vizChanged must compare _rendererVizKey(next) vs _rendererVizKey(prev), guarded by prev',
    );
    assert.match(
        fn,
        /if\s*\(\s*nextType\s*!==\s*_currentCanvasContextType\s*\|\|\s*_vizChanged\s*\)\s*\{\s*_replaceCanvas\(nextType\)/,
        'replace guard must be `nextType !== _currentCanvasContextType || _vizChanged`',
    );
});

test('_rendererVizKey keys on the viz id, not object identity (avoids churn on same-viz re-install)', () => {
    const src = fs.readFileSync(highwayJs, 'utf8');
    const fn = extractBlock(src, 'function _rendererVizKey(r)');
    // Default renderer keys on its singleton; custom renderers key on the
    // viz picker id (pluginId/source) stamped by app.js's _tagVizRenderer,
    // falling back to the object reference only when untagged.
    assert.match(fn, /r\s*===\s*_defaultRenderer/, 'default renderer must key on its own singleton');
    assert.match(fn, /r\.pluginId\s*\|\|\s*r\.source/, 'custom renderers must key on pluginId/source (the viz id)');
});

test('_setRenderer skips the extra replace on first install (prev === null)', () => {
    const src = fs.readFileSync(highwayJs, 'utf8');
    const fn = extractBlock(src, 'function _setRenderer(r)');
    // The `prev &&` guard avoids a needless swap on the very first install
    // (prev === null) where there is no prior frame to clear.
    assert.match(fn, /_vizChanged\s*=\s*prev\s*&&/, 'must short-circuit _vizChanged when prev is null');
});
