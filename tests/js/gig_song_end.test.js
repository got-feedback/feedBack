// A gig is a SET, not a run of unrelated songs.
//
// Reported from a live gig: the player finished the first song and had to sit
// through the per-song results popup before the next one would start, and then
// wait again while that song was extracted from its feedpak zip.
//
// This file covers the CORE half — career pre-extracts the whole setlist before
// the first note. The other half (note_detect must not show its per-song summary
// inside a gig) lives in the note_detect plugin repo, which is not part of this
// checkout: plugins/*/ is gitignored here and note_detect ships from
// feedBack-plugin-notedetect. A test reading it from core would pass on a dev
// box (where the plugin happens to be bundled) and fail in CI, which is worse
// than no test.
//
// The pre-extraction is tested for REAL behaviour — actually unpacking zips — in
// tests/plugins/career/test_routes.py. These are the wiring guards around it.

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..', '..');
const CAREER = fs.readFileSync(path.join(ROOT, 'plugins', 'career', 'screen.js'), 'utf8');
const CAREER_ROUTES = fs.readFileSync(path.join(ROOT, 'plugins', 'career', 'routes.py'), 'utf8');

function extractBlock(src, signature) {
    const start = src.indexOf(signature);
    assert.ok(start !== -1, `signature '${signature}' not found`);
    const openBrace = src.indexOf('{', start);
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

test('startGig extracts the whole setlist before starting the queue', () => {
    const fn = extractBlock(CAREER, 'async function startGig(');
    const prepIdx = fn.search(/await\s+prepareGigSongs\s*\(/);
    const startIdx = fn.search(/q\.start\s*\(/);
    assert.ok(prepIdx !== -1, 'startGig must pre-extract the set');
    assert.ok(startIdx !== -1, 'q.start not found');
    assert.ok(prepIdx < startIdx,
        'the set must be unpacked BEFORE the queue starts — otherwise the player ' +
        'waits between songs, which is the bug');
});

test('the stage is only borrowed once the set is ready', () => {
    const fn = extractBlock(CAREER, 'async function startGig(');
    const prepIdx = fn.search(/await\s+prepareGigSongs\s*\(/);
    const stageIdx = fn.search(/VENUE_OVERRIDE_KEY/);
    assert.ok(prepIdx < stageIdx,
        'a gig cancelled while unpacking must not leave the venue/viz overwritten');
    assert.match(fn, /_ppGigProposal\s*!==\s*prop/,
        'a proposal dismissed while unpacking must not then start a gig');
});

test('pre-extraction never blocks the gig from starting', () => {
    const fn = extractBlock(CAREER, 'async function prepareGigSongs(');
    assert.match(fn, /catch\s*\(/,
        'a failed prepare must fall through to the old lazy extraction, not abort the gig');
});

test('the prepare route degrades instead of failing', () => {
    assert.match(CAREER_ROUTES, /def prepare_gig/, 'prepare route missing');
    assert.match(CAREER_ROUTES, /context\.get\(\s*["']get_dlc_dir["']\s*\)/,
        'a host without the library resolvers must degrade, not 500 — pre-extraction ' +
        'is an optimisation and can never be why a gig will not start');
});
