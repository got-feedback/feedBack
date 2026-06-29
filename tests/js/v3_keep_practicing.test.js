// Pins the practice-aware library home in static/v3/songs.js:
//   - a "Repertoire" progress meter (mastered / total library songs), and
//   - a "Keep practicing" shelf (recently played, not yet mastered).
// Both reuse existing data (/api/stats/best already in state.accuracy, and
// /api/stats/recent) and are shown only on the unfiltered grid front door.
//
// Source-level only — same strategy as tests/js/v3_az_rail.test.js.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const SONGS_JS = path.join(__dirname, '..', '..', 'static', 'v3', 'songs.js');
const src = fs.readFileSync(SONGS_JS, 'utf8');

test('repertoire uses the same mastery threshold as the green accuracy badge', () => {
    assert.match(src, /const\s+MASTERY_ACCURACY\s*=\s*0\.9/);
    assert.match(
        src,
        /function\s+_repertoireCounts[\s\S]*?v\s*>=\s*MASTERY_ACCURACY\s*\)\s*mastered\+\+;\s*else\s+learning\+\+/,
        'repertoire counts must bucket scored songs into mastered/learning at MASTERY_ACCURACY',
    );
});

test('the home is the unfiltered grid front door (gated off search/filter/select)', () => {
    assert.match(
        src,
        /function\s+libHomeVisible[\s\S]*?state\.view === 'grid'[\s\S]*?!state\.selectMode[\s\S]*?!state\.q[\s\S]*?activeFilterCount\(\)\s*===\s*0/,
        'libHomeVisible must require grid view, no select mode, no search, no active filters',
    );
});

test('the shelf is recently-played, not-yet-mastered songs', () => {
    assert.match(src, /\/api\/stats\/recent\?limit=/);
    assert.match(
        src,
        /best_accuracy === 'number'\s*&&\s*r\.best_accuracy\s*<\s*MASTERY_ACCURACY/,
        'the shelf must filter recents to scored-but-below-mastery songs',
    );
});

test('the repertoire denominator is the unfiltered library total', () => {
    assert.match(src, /\/api\/library\/stats\?provider='/);
    assert.match(src, /total_songs\s*\?\?\s*stats\.total/);
    assert.match(src, /Math\.round\(\(mastered\s*\/\s*total\)\s*\*\s*100\)/);
});

test('the home + #v3-lib-home host are wired into render and reload', () => {
    assert.match(src, /id="v3-lib-home"/, 'render() must include the #v3-lib-home host');
    assert.match(src, /function reload\s*\([\s\S]*?updateLibraryHome\(\)/,
        'reload() must refresh/toggle the home');
    assert.match(src, /function applyScoreRefresh[\s\S]*?renderLibraryHome\(\)/,
        'a new score must refresh the meter + shelf');
});

test('shelf cards play the song on click', () => {
    assert.match(
        src,
        /querySelectorAll\('\.v3-kp-card'\)[\s\S]*?window\.playSong\(enc\(fn\)/,
        'a shelf card click must call window.playSong with the recents filename',
    );
});
