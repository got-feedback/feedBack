// Guard for the content-dependent playlist cover (playlists.js). A custom
// uploaded cover wins; otherwise the playlist's song art decides: icon when
// empty, a single cover for a few songs, a 2×2 mosaic at 4+. (Rendering is DOM
// glue, so this is a source-level guard on the decision branches.)

'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const PL = fs.readFileSync(
    path.join(__dirname, '..', '..', 'static', 'v3', 'playlists.js'), 'utf8');

test('custom cover_url takes priority', () => {
    assert.match(PL, /function playlistCoverHtml\(p\)/);
    assert.match(PL, /if \(p\.cover_url\) return/);
});

test('empty → icon, <4 → single art, 4+ → 2×2 mosaic', () => {
    assert.match(PL, /if \(!arts\.length\)[\s\S]{0,160}(🔖|🎵)/);     // empty → icon
    assert.match(PL, /arts\.length < 4\) return[\s\S]{0,120}arts\[0\]/); // a few → single cover
    assert.match(PL, /grid-cols-2 grid-rows-2[\s\S]{0,120}slice\(0, 4\)/); // 4+ → mosaic
});

test('the card uses playlistCoverHtml (not the old static emoji box)', () => {
    assert.match(PL, /playlistCoverHtml\(p\)/);
});
