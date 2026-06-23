// Source-level guards for the pool().warm() helper added in
// feedBack#226 — locks in:
//   1. The factory exposes .warm() (so future refactors don't quietly
//      remove the boardInit pre-allocation strategy).
//   2. warm() coerces its argument via `cap | 0` + `Math.max(0, …)` so a
//      non-finite or negative input can't spin a while-loop until OOM.
//
// Like the other highway_3d tests in this directory, this pattern-matches
// the source rather than executing it — the createHighway() closure owns
// canvas + WebGL lifecycle that's too heavy for a vm sandbox.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const SCREEN_JS = path.join(__dirname, '..', '..', 'plugins', 'highway_3d', 'screen.js');

// Brace-balanced extraction so warm() / coercion checks scope to the
// `function pool(...)` body (matching the helper shape used in
// highway_note_state.test.js). Without scoping, a future helper named
// `warm(cap)` elsewhere in the file would satisfy these guards while
// the pool factory's contract was silently broken.
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

test('pool factory exposes warm(cap)', () => {
    const src = fs.readFileSync(SCREEN_JS, 'utf8');
    // The pool() factory's return object must include a `warm(cap)`
    // method. Scope the match to the factory body so an unrelated
    // future `warm(cap)` helper elsewhere in the file can't satisfy
    // this guard.
    const poolBody = extractBlock(src, 'function pool(parent, mk)');
    assert.match(poolBody, /\bwarm\s*\(\s*cap\s*\)\s*\{/, 'pool factory must expose warm(cap)');
});

test('pool.warm coerces cap to a non-negative integer', () => {
    const src = fs.readFileSync(SCREEN_JS, 'utf8');
    // Same scoping discipline as above — the coercion must live
    // inside the pool factory's warm() body, not anywhere else.
    const poolBody = extractBlock(src, 'function pool(parent, mk)');
    assert.match(
        poolBody,
        /warm\s*\(\s*cap\s*\)\s*\{[\s\S]*?Math\.max\(\s*0\s*,\s*cap\s*\|\s*0\s*\)/,
        'pool.warm must guard against non-finite / negative cap via Math.max(0, cap | 0)'
    );
});

test('warm() is called at boardInit with renderer-scoped cap constants', () => {
    const src = fs.readFileSync(SCREEN_JS, 'utf8');
    // The note / chord / lane / beat cap constants live inside the
    // boardInit/initScene path (renderer-instance scope, not module
    // scope); each must exist as a const and drive at least one .warm()
    // call site.
    for (const cap of ['_WARM_NOTE', '_WARM_CHORD', '_WARM_LANE', '_WARM_BEAT']) {
        assert.match(src, new RegExp(`const ${cap}\\s*=`), `${cap} const must exist`);
        assert.match(src, new RegExp(`\\.warm\\(\\s*${cap}\\b`), `${cap} must drive at least one .warm() call`);
    }
});
