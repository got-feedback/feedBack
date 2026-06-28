// Regression guard for "No DLC until restart": a library scan triggered from
// Settings (rescan / full rescan, e.g. right after pointing at a DLC folder)
// reloaded only the classic library — the v3 Songs grid kept its cached
// (pre-DLC, empty) state until an app restart.
//
// The fix wires a `library:changed` event (emitted by the rescan handlers in
// app.js) to a reload in static/v3/songs.js. That's DOM/event glue, not a pure
// function, so these are source-level guards that the wiring isn't dropped; the
// end-to-end behavior is verified in-app / by a browser test.

'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..', '..');
const SONGS = fs.readFileSync(path.join(root, 'static', 'v3', 'songs.js'), 'utf8');
const APP = fs.readFileSync(path.join(root, 'static', 'app.js'), 'utf8');

test('app.js emits library:changed when a Settings rescan completes', () => {
    assert.match(APP, /emit\(\s*['"]library:changed['"]/,
        'a completed rescan must broadcast library:changed for the v3 grid');
});

test('songs.js handles library:changed — reload when active, else mark dirty', () => {
    const m = SONGS.match(/sm\.on\(\s*['"]library:changed['"][\s\S]{0,500}?\}\);/);
    assert.ok(m, 'songs.js must subscribe to library:changed');
    assert.match(m[0], /reload\(\)/, 'reloads the grid when the screen is active');
    assert.match(m[0], /_libraryDirty\s*=\s*true/, 'marks dirty when off-screen');
});

test('onV3SongsScreenEnter forces a reload when the library is dirty', () => {
    const m = SONGS.match(/function onV3SongsScreenEnter\(\)[\s\S]{0,400}?\{/);
    assert.ok(m, 'onV3SongsScreenEnter present');
    // The dirty check must short-circuit to a reload before the cached-DOM
    // fast-paths get a chance to restore the stale grid.
    assert.match(SONGS, /if\s*\(_libraryDirty\)\s*\{[^}]*reload\(\)[^}]*return;/,
        'a dirty library must force a full reload on entry, ahead of any fast-path');
});
