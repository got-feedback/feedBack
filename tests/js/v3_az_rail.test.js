// Pins the v3 Songs A–Z jump rail wiring in static/v3/songs.js.
//
// The rail lets a user jump the library grid to artists/titles starting with a
// letter (Plex/Radarr/iOS-contacts pattern). Because the grid is forward-only,
// server-paged infinite scroll, the jump pages through to the target card then
// scrolls — and the rail only offers letters the server reports present for the
// active sort+filter (so a tap always terminates at a real card). It is shown
// only for the grid view + alphabetical (artist/title) sorts.
//
// Source-level only — same strategy as tests/js/highway_3d_camera_framing.test.js.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const SONGS_JS = path.join(__dirname, '..', '..', 'static', 'v3', 'songs.js');
const src = fs.readFileSync(SONGS_JS, 'utf8');

test('the rail is context-gated to grid view + alphabetical sorts', () => {
    // railSortColumn returns the active alpha column or null (recent/year/tuning).
    assert.match(src, /function\s+railSortColumn\s*\(\)/);
    assert.match(src, /state\.sort === 'artist'[\s\S]*?return 'artist'/);
    assert.match(src, /state\.sort === 'title'[\s\S]*?return 'title'/);
    assert.match(
        src,
        /function\s+railVisible\s*\(\)\s*\{\s*return\s+state\.view === 'grid'\s*&&\s*!!railSortColumn\(\)/,
        'the rail must be visible only for the grid view + an alphabetical sort',
    );
});

test('cards carry a data-letter bucket and non-A–Z buckets under #', () => {
    assert.match(src, /data-letter="'\s*\+\s*esc\(songBucket\(song\)\)/,
        'each card must tag its sort-letter bucket via songBucket(song)');
    assert.match(
        src,
        /function\s+songBucket[\s\S]*?\(ch >= 'A' && ch <= 'Z'\)\s*\?\s*ch\s*:\s*'#'/,
        'songBucket must bucket non-A–Z first chars under "#"',
    );
});

test('refreshRail reads present letters from the stats endpoint (sort-aware)', () => {
    assert.match(src, /\/api\/library\/stats\?'\s*\+\s*queryParams/,
        'refreshRail must query /api/library/stats with the active filter params');
    // Opts into the active-sort breakdown so non-rail callers skip the scan.
    assert.match(src, /queryParams\(\{\s*sort_letters:\s*1\s*\}\)/,
        'refreshRail must request the sort_letters breakdown');
    assert.match(src, /letters\s*=\s*stats\s*&&\s*stats\.sort_letters/,
        'refreshRail must prefer the active-sort breakdown (sort_letters)');
    // The legacy artist `letters` is only a valid fallback for an artist sort;
    // a title sort with no sort_letters hides the rail rather than mislabel it.
    assert.match(src, /col === 'artist'[\s\S]*?stats\.letters/,
        'refreshRail must only fall back to letters for an artist sort');
    // Absent letters are disabled (non-interactive), not just dimmed.
    assert.match(src, /present\s*\?\s*''\s*:\s*' disabled'/);
});

test('reload() refreshes the rail', () => {
    assert.match(src, /function reload\s*\([\s\S]*?refreshRail\(\)/,
        'reload() must call refreshRail() so the rail tracks filter/sort/view changes');
});

test('the rail + drag bubble are rendered in the Songs markup', () => {
    assert.match(src, /id="v3-songs-azrail"[\s\S]*?aria-label="Jump to letter"/);
    assert.match(src, /id="v3-songs-azbubble"/);
});

test('jumpToLetter pages through to the target then scrolls (load-through)', () => {
    // Forward-paging helper used to load rows up to the target letter.
    assert.match(src, /async function\s+_loadNextAwait\s*\(\)/);
    assert.match(
        src,
        /async function\s+jumpToLetter[\s\S]*?_loadNextAwait\(\)[\s\S]*?(scrollTo|scrollIntoView)/,
        'jumpToLetter must page forward (_loadNextAwait) then scroll to the target card',
    );
    // A token guards against overlapping jumps (drag scrubbing) — newest wins.
    assert.match(src, /_jumpToken\s*===\s*myToken/);
});

test('the rail supports pointer drag-scrub + keyboard arrows', () => {
    assert.match(src, /addEventListener\('pointerdown'/);
    assert.match(src, /addEventListener\('pointermove'/);
    assert.match(src, /ArrowUp'[\s\S]*?ArrowDown'|ArrowDown'[\s\S]*?ArrowUp'/,
        'arrow keys must move between present letters');
});
