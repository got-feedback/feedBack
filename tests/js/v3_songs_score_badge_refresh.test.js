// Regression guard for the post-play score-badge refresh bug
// (#574 follow-up): after finishing a song, its accuracy badge on the
// Songs screen stayed stale until a full re-render (app restart / search /
// re-enter), even though stats-recorder fired `stats:recorded`.
//
// Root cause: `stats:recorded` (like `song:loading`) carries the filename
// exactly as handed to playSong — encodeURIComponent'd (see playCard) — but
// library cards key on the DECODED filename (data-fn = cardKey → localFilename)
// and /api/stats/best is server-canonicalized to that same decoded key. So the
// in-place repaint (repaintAccuracy) matched no card and silently no-oped.
//
// The fix is a `decFn` helper in static/v3/songs.js that decodes the event
// filename back into the card / state.accuracy key space before matching. This
// test extracts the REAL decFn from the shipped source (not a mirror) and proves
// the encoded event filename round-trips to the raw card key.

'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const SONGS_JS = path.join(__dirname, '..', '..', 'static', 'v3', 'songs.js');

// Brace-balanced extraction so nested braces / template strings survive.
function extractFunctionSource(src, name) {
    const sig = `function ${name}`;
    const start = src.indexOf(sig);
    assert.ok(start !== -1, `function declaration '${name}' not found in songs.js`);
    const openBrace = src.indexOf('{', start);
    assert.ok(openBrace !== -1, `opening brace after '${name}' not found`);
    let depth = 1;
    let i = openBrace + 1;
    while (i < src.length && depth > 0) {
        const ch = src[i];
        if (ch === '{') depth++;
        else if (ch === '}') depth--;
        i++;
    }
    assert.ok(depth === 0, `unbalanced braces in function '${name}'`);
    return src.slice(start, i);
}

function loadDecFn() {
    const src = fs.readFileSync(SONGS_JS, 'utf8');
    const fnSrc = extractFunctionSource(src, 'decFn');
    const sandbox = {};
    vm.createContext(sandbox);
    // decodeURIComponent is an intrinsic global in the fresh context.
    vm.runInContext(`${fnSrc}\nglobalThis.__decFn = decFn;`, sandbox);
    return sandbox.__decFn;
}

const enc = encodeURIComponent; // exactly what playCard passes to playSong

// The on-disk library filenames from the bug report's screenshots, plus a
// subfolder path (encodeURIComponent turns '/' into %2F too).
const CARD_KEYS = [
    'Black Me Out.sloppak',
    'All In Now.sloppak',
    'Dogstar - All In Now.feedpak',
    'Subdir/Song (Live).sloppak',
];

test('decFn decodes an encoded event filename back to the raw card key', () => {
    const decFn = loadDecFn();
    for (const key of CARD_KEYS) {
        const eventFilename = enc(key); // how stats:recorded carries it
        // Precondition: the encoded form does NOT equal the card key — this is
        // exactly why the un-decoded match failed and the badge stayed stale.
        assert.notEqual(eventFilename, key, `expected '${key}' to encode to something different`);
        // The fix: decoding lands back on the card / state.accuracy key.
        assert.equal(decFn(eventFilename), key, `decFn must recover the card key for '${key}'`);
    }
});

test('decFn is idempotent for already-decoded filenames (no % present)', () => {
    const decFn = loadDecFn();
    for (const key of CARD_KEYS) {
        assert.equal(decFn(key), key, `decFn must leave the already-decoded '${key}' unchanged`);
    }
});

test('decFn leaves a real literal-% filename intact rather than throwing', () => {
    const decFn = loadDecFn();
    // '%.sloppak' / '100%.sloppak' are malformed percent-escapes —
    // decodeURIComponent would throw; decFn must fall back to the original.
    for (const name of ['100%.sloppak', 'mix %.feedpak', '%zz.sloppak']) {
        assert.equal(decFn(name), name, `decFn must not corrupt/throw on '${name}'`);
    }
});

test('decFn coerces non-string / empty input to an empty string', () => {
    const decFn = loadDecFn();
    assert.equal(decFn(null), '');
    assert.equal(decFn(undefined), '');
    assert.equal(decFn(''), '');
});
