// Pins the v3 Songs favorite-toggle colour swap in static/v3/songs.js.
//
// One shared wireCards() [data-fav] handler serves BOTH the grid card and the
// tree / "List View" row, but the two render sites use different idle colours
// (grid = text-white, tree = text-fb-textDim). The handler used to toggle a
// hardcoded text-white, so in List View it never removed text-fb-textDim — the
// heart changed glyph (♡→♥) but stayed dim and only turned red after a re-search
// re-rendered the row (reported macOS+Windows, 0.3.0, open since 06-25). Each
// button now declares its idle colour via data-fav-idle and the handler swaps
// exactly that class, so only one colour class is ever present.
//
// Source-level only — same strategy as tests/js/v3_az_rail.test.js.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const SONGS_JS = path.join(__dirname, '..', '..', 'static', 'v3', 'songs.js');
const src = fs.readFileSync(SONGS_JS, 'utf8');

test('both fav render sites declare their idle colour via data-fav-idle', () => {
    // Grid card heart idles white; the tree / List View heart idles dim.
    assert.match(src, /data-fav data-fav-idle="text-white"/,
        'the grid fav button must declare data-fav-idle="text-white"');
    assert.match(src, /data-fav data-fav-idle="text-fb-textDim"/,
        'the tree/List-View fav button must declare data-fav-idle="text-fb-textDim"');
});

test('the shared fav handler swaps the declared idle colour, not a hardcoded one', () => {
    // Reads the idle colour off the clicked button …
    assert.match(src, /getAttribute\('data-fav-idle'\)/,
        'the fav handler must read the idle colour from the button');
    // … toggles fb-accent (red) on favorite and restores the context idle colour off it.
    assert.match(src, /classList\.toggle\('text-fb-accent',\s*d\.favorite\)/);
    assert.match(src, /classList\.toggle\(\s*idle\s*,\s*!d\.favorite\s*\)/,
        'the fav handler must restore the per-context idle colour (idle), not text-white');
    // The grid-only hardcoded idle toggle that stranded text-fb-textDim is gone.
    assert.doesNotMatch(src, /classList\.toggle\('text-white',\s*!d\.favorite\)/,
        'the hardcoded text-white idle toggle must be removed');
});

test('the drawer fav-sync (_patchCardFav) swaps the declared idle colour too', () => {
    // Toggling the like from the Song Details drawer patches the rendered card's
    // heart via _patchCardFav; it must honour each heart's data-fav-idle the same
    // way the click handler does, or List-View rows keep the dim-heart bug (#654).
    assert.match(src, /function _patchCardFav[\s\S]*?getAttribute\('data-fav-idle'\)[\s\S]*?classList\.toggle\(\s*idle\s*,\s*!fav\s*\)/,
        '_patchCardFav must restore the per-context idle colour (idle), not a hardcoded text-white');
    assert.doesNotMatch(src, /classList\.toggle\('text-white',\s*!fav\)/,
        '_patchCardFav must not hardcode the text-white idle toggle');
});

test('the fav toggle keeps the in-memory song model in sync', () => {
    // So a virtualized grid recycle / tree re-render renders the new state,
    // not a stale favorite=false read from state.songsById.
    assert.match(src, /song\.favorite\s*=\s*d\.favorite/,
        'the fav handler must write the new favorite state back onto the song model');
});
