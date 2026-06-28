// Guard: a song's ⋮ "More" menu offers "Add to playlist" for a single song —
// not only the select-mode checkbox + batch-bar flow. Both paths share the
// extracted addFilenamesToPlaylist() helper. (Menu/DOM wiring isn't headlessly
// unit-testable, so these are source-level guards.)

'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const SONGS = fs.readFileSync(
    path.join(__dirname, '..', '..', 'static', 'v3', 'songs.js'), 'utf8');

test('the ⋮ card menu lists an "Add to playlist" row', () => {
    assert.match(SONGS, /id:\s*'__playlist',\s*label:\s*'Add to playlist'/);
});

test('the menu row adds the single song via the shared helper', () => {
    assert.match(SONGS, /id === '__playlist'[\s\S]{0,100}addFilenamesToPlaylist\(\[song\.filename\]\)/);
});

test('batch and single-song add share addFilenamesToPlaylist()', () => {
    assert.match(SONGS, /async function addFilenamesToPlaylist\(filenames\)/);
    assert.match(SONGS, /async function batchAddToPlaylist\(\)[\s\S]{0,120}addFilenamesToPlaylist\(state\.selected\)/);
});

test('batch only finishes (clears selection) when the add succeeded, not on cancel', () => {
    // addFilenamesToPlaylist returns null on a cancelled/failed picker; the
    // batch caller must capture it and gate finishBatch() on a truthy pid, so
    // cancelling preserves the multi-select (regression guard for the
    // extract-helper refactor — previously finishBatch ran unconditionally).
    assert.match(SONGS, /const pid = await addFilenamesToPlaylist\(state\.selected\)/,
        'batch must capture the returned playlist id');
    assert.match(SONGS, /if \(pid\) finishBatch\(\)/,
        'finishBatch must be gated on a successful add (truthy pid)');
});
