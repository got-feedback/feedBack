// Verify static/highway.js handles the `handshapes` WebSocket message:
// accumulates incoming chunks, time-sorts on `ready`, and exposes the
// result on the renderer bundle. The 3D arpeggio frame / chord rails
// pipeline consumes that bundle; if accumulation or sort drifts, those
// visuals silently render wrong (out-of-order frames, missing hints).
//
// Same source-level guard strategy as the other tests/js/ files —
// extract the relevant case body and assert the wiring.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const HIGHWAY_JS = path.join(__dirname, '..', '..', 'static', 'highway.js');

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

test('handshapes WS case accumulates incoming chunks into handShapes', () => {
    // Server streams handshapes in chunks; the case must concat rather
    // than replace so multi-chunk sources don't silently truncate.
    const src = fs.readFileSync(HIGHWAY_JS, 'utf8');
    const block = getCaseBlock(src, 'handshapes');
    assert.match(
        block,
        /hwState\.handShapes\s*=\s*hwState\.handShapes\.concat\(\s*msg\.data\s*\)/,
        'handshapes case must concat msg.data into the handShapes accumulator',
    );
});

test('ready case time-sorts handShapes before rendering', () => {
    // Out-of-order chunks would otherwise leave handShapes interleaved,
    // breaking the binary-search lookups the 3D renderer does when
    // probing arpeggio coverage for a chord at time t.
    const src = fs.readFileSync(HIGHWAY_JS, 'utf8');
    const block = getCaseBlock(src, 'ready');
    assert.match(
        block,
        /handShapes\.sort\(\s*\(\s*a\s*,\s*b\s*\)\s*=>\s*a\.start_time\s*-\s*b\.start_time\s*\)/,
        'ready case must sort handShapes by start_time so the renderer can rely on ordering',
    );
});

test('bundle exposes handShapes to renderers with flat-list fallback', () => {
    // Renderers (highway_3d in particular) read `bundle.handShapes`; if
    // the bundle key gets renamed or dropped, the 3D arp-frame pipeline
    // goes dark without a runtime error. The current shape is a ternary
    // that picks `_filteredHandShapes` when phrase data carries any and
    // falls back to the flat `handShapes` list otherwise (DLC pattern).
    // Pin both sides of the ternary so accidentally dropping the
    // fallback branch fails the test.
    const src = fs.readFileSync(HIGHWAY_JS, 'utf8');
    assert.match(
        src,
        /\bhandShapes\s*[:=]\s*\([^)]*hwState\._filteredHandShapes[^)]*\)\s*\?\s*hwState\._filteredHandShapes\s*:\s*hwState\.handShapes\b/,
        'bundle must expose handShapes with the _filteredHandShapes-vs-handShapes ternary fallback',
    );
});
