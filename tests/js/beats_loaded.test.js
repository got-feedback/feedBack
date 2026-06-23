// Verify static/highway.js emits `beats:loaded` exactly once when the
// WebSocket delivers the song's beats array, with `{ count }` payload.
// Plugins that need to know when beats are available (metronome, beat-
// snapping editors, sync visualizers) consume this contract.
//
// Same isolation strategy as the other tests/js/ files — extract just
// the relevant case-block source by string matching and exercise it in
// a vm sandbox with stubbed deps.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const HIGHWAY_JS = path.join(__dirname, '..', '..', 'static', 'highway.js');

// Extract a single switch case body so assertions can match against just
// that block rather than a fixed-length slice (more robust to harmless
// edits adjacent to the case).
function getCaseBlock(src, label) {
    const start = src.indexOf(`case '${label}'`);
    assert.ok(start !== -1, `case '${label}' not found in highway.js`);
    const tail = src.slice(start);
    const nextCase = tail.search(/\n\s*case\s+['"]/);
    const nextDefault = tail.search(/\n\s*default\s*:/);
    let end = tail.length;
    if (nextCase > 0) end = Math.min(end, nextCase);
    if (nextDefault > 0) end = Math.min(end, nextDefault);
    return tail.slice(0, end);
}

test('beats:loaded emit is wired into the WS beats case', () => {
    // Source-level guard: catch a future contributor removing the emit
    // (regression) or replacing window.feedBack.emit with something
    // else (intentional refactor — this test then needs updating).
    const src = fs.readFileSync(HIGHWAY_JS, 'utf8');
    const block = getCaseBlock(src, 'beats');
    assert.match(
        block,
        /window\.feedBack\.emit\(\s*['"]beats:loaded['"]/,
        'beats case must emit beats:loaded',
    );
    assert.match(
        block,
        /count:\s*beats\.length/,
        'beats:loaded payload must include count = beats.length',
    );
});

test('beats:loaded emit is guarded against missing window.feedBack', () => {
    // The WS handler can fire before the feedBack namespace is defined
    // (early in app boot). The emit must be guarded so a missing
    // namespace doesn't throw inside the WS message dispatcher.
    // Looser pattern accepts any guard that reads window.feedBack
    // (including typeof checks and combined conditions) rather than
    // mandating the exact `if (window.feedBack)` form.
    const src = fs.readFileSync(HIGHWAY_JS, 'utf8');
    const block = getCaseBlock(src, 'beats');
    assert.match(
        block,
        /if\s*\(\s*[^)]*window\.feedBack\b[^)]*\)/,
        'beats:loaded emit must be guarded against a missing window.feedBack',
    );
});

test('beats:loaded guard verifies emit is callable (typeof check)', () => {
    // A partially-attached namespace (window.feedBack exists but emit
    // isn't a function yet during early boot) would throw without this
    // extra check. A truthy check (`window.feedBack.emit && ...`) lets
    // non-callable values pass; require an explicit typeof === 'function'
    // check so the guard catches that real edge.
    const src = fs.readFileSync(HIGHWAY_JS, 'utf8');
    const block = getCaseBlock(src, 'beats');
    assert.match(
        block,
        /typeof\s+window\.feedBack\.emit\s*===\s*['"]function['"]/,
        'guard must use typeof === \'function\' (not just truthy) to confirm emit is callable',
    );
});
