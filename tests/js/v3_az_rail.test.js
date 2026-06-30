// Pins the v3 Songs A–Z jump rail wiring in static/v3/songs.js.
//
// The rail lets a user jump the library grid to artists/titles starting with a
// letter (Plex/Radarr/iOS-contacts pattern). With the windowed grid (#636 item 3
// stage 2) the jump seeks DIRECTLY: the sort_letters song-counts give the first
// card's absolute index (cumulative of prior buckets), which converts to a
// scrollTop — no page-through. The rail only offers letters the server reports
// present for the active sort+filter (so a tap always lands on a real card). It
// is shown only for the grid view + alphabetical (artist/title) sorts.
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

test('jumpToLetter seeks directly via sort_letters cumulative (no page-through)', () => {
    // The cumulative-count seek: sum the song-counts of buckets ordered before
    // the target to get its first row's absolute index.
    assert.match(src, /function\s+_letterStartIndex\s*\(letter\)/,
        'jumpToLetter must derive the target index from sort_letters counts');
    assert.match(
        src,
        /async function\s+jumpToLetter[\s\S]*?_letterStartIndex\(letter\)[\s\S]*?scrollTo/,
        'jumpToLetter must compute the target index then scrollTo (no _loadNextAwait page-through)',
    );
    // It pre-fetches the destination window so cards are ready when the scroll lands.
    assert.match(src, /async function\s+jumpToLetter[\s\S]*?ensureWindow\(/,
        'jumpToLetter must pre-fetch the destination window before scrolling');
    // The old forward-paging helper is gone (the seek is O(1)).
    assert.doesNotMatch(src, /_loadNextAwait/,
        'the page-through helper must be removed under the windowed grid');
    // A token still guards overlapping jumps (drag scrubbing) — newest wins.
    assert.match(src, /_jumpToken\s*!==\s*myToken/);
});

test('the rail supports pointer drag-scrub + keyboard arrows', () => {
    assert.match(src, /addEventListener\('pointerdown'/);
    assert.match(src, /addEventListener\('pointermove'/);
    assert.match(src, /ArrowUp'[\s\S]*?ArrowDown'|ArrowDown'[\s\S]*?ArrowUp'/,
        'arrow keys must move between present letters');
});

test('pointer taps are driven by pointerdown, not the retarget-prone click', () => {
    // A tap must seek on pointerdown (pointer capture retargets the follow-up
    // click to the rail, so resolving a letter from click is unreliable — taps
    // would no-op, "clicked O, nothing happened").
    assert.match(src, /addEventListener\('pointerdown'[\s\S]*?seekToY\(/,
        'pointerdown must seek immediately so a tap lands without a move');
    // The click handler must ignore pointer-driven clicks (detail >= 1) and only
    // handle keyboard Enter/Space activation (synthesized click has detail === 0).
    assert.match(src, /addEventListener\('click'[\s\S]*?e\.detail\s*!==\s*0/,
        'the rail click handler must guard on e.detail === 0 (keyboard only)');
});

test('drag scrubs seek instantly while taps/keys seek smoothly', () => {
    assert.match(src, /async function\s+jumpToLetter\s*\(\s*letter\s*,\s*smooth/,
        'jumpToLetter must take a smooth flag');
    assert.match(src, /behavior:\s*smooth\s*\?\s*'smooth'\s*:\s*'auto'/,
        'jumpToLetter must scroll instantly during a drag, smoothly on a tap');
    // pointermove scrubs with smooth=false so RELEASE lands on the let-go letter.
    assert.match(src, /addEventListener\('pointermove'[\s\S]*?seekToY\([^;]*?,\s*false\)/,
        'pointermove must seek with smooth=false (precise drag tracking)');
});
