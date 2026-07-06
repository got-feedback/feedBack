// Contract test: 3D Highway WebGL context-loss recovery.
//
// Switching the active window / alt-tabbing (especially on Windows) can trigger
// a GPU context reset. Without a handler the lost WebGL context escalates into a
// render-process crash. The renderer owns its own WebGL canvas + heavy Three.js
// lifecycle (too much to construct in a vm sandbox), so — like the other
// highway_* source-contract tests here — this pins the wiring at the source
// level: the loss must be preventDefault()'d (so the browser restores it), draw
// must bail while lost, and the listeners must be torn down.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const SCREEN_JS = path.join(__dirname, '..', '..', 'plugins', 'highway_3d', 'screen.js');
const src = fs.readFileSync(SCREEN_JS, 'utf8');

test('binds webglcontextlost + webglcontextrestored on the renderer canvas', () => {
    assert.match(src, /ren\.domElement\.addEventListener\(\s*['"]webglcontextlost['"]/,
        'must listen for webglcontextlost on ren.domElement (the WebGL canvas)');
    assert.match(src, /ren\.domElement\.addEventListener\(\s*['"]webglcontextrestored['"]/,
        'must listen for webglcontextrestored on ren.domElement');
});

test('the context-lost handler preventDefaults and pauses drawing', () => {
    // Without preventDefault() the browser will not attempt to restore the
    // context and the loss can escalate to a renderer crash.
    const m = src.match(/_onCtxLost\s*=\s*\(e\)\s*=>\s*\{[\s\S]*?\};/);
    assert.ok(m, '_onCtxLost handler must exist');
    assert.match(m[0], /preventDefault\(\)/, 'context-lost handler must call preventDefault()');
    assert.match(m[0], /_ctxLost\s*=\s*true/, 'context-lost handler must set _ctxLost = true');
});

test('draw() early-returns while the context is lost', () => {
    assert.match(src, /draw\(bundle\)\s*\{[\s\S]*?if\s*\(_ctxLost\)\s*return;/,
        'draw() must bail while _ctxLost is set so no GL work runs on a dead context');
});

test('teardown removes the context-loss listeners', () => {
    assert.match(src, /removeEventListener\(\s*['"]webglcontextlost['"]/,
        'teardown must remove the webglcontextlost listener');
    assert.match(src, /removeEventListener\(\s*['"]webglcontextrestored['"]/,
        'teardown must remove the webglcontextrestored listener');
});
