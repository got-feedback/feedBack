// showScreen('home') must never land on the LEGACY library screen when v3 is present.
//
// Testers: "randomly, when moving to the library from another menu option, the library shows the
// old interface — never when a song ends."
//
// #home is the pre-v3 library screen. The v3 shell replaced it with #v3-songs, and the mapping
// DID exist — but only inside wrappers on `window.showScreen`, which fail two ways:
//
//   1. ORDER. THREE independent parties monkey-patch window.showScreen, each capturing whatever
//      is there at the time: app.js publishes the raw function, shell.js wraps it to add the
//      mapping, and the stems plugin wraps it again. Plugins load ASYNCHRONOUSLY, so the chain
//      links up in whatever order the race settles. A capture taken before shell.js installs —
//      or any re-assignment after it — silently drops the mapping. Hence "randomly".
//
//   2. THE INTERNAL CALLERS BYPASS window.showScreen ENTIRELY. closeCurrentSong and the
//      Esc-from-settings shortcut call the IMPORTED showScreen, which no wrapper ever sees.
//      Verified in a browser: the unwrapped function with 'home' lands on #home, always.
//
// "Never when a song ends" is the tell: closeCurrentSong resolves its target through
// _resolvePlayerOrigin(), which already applied the mapping — so that one path was fine.
//
// The guard now lives inside showScreen itself: one place every caller routes through.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const SESSION_JS = path.join(__dirname, '..', '..', 'static', 'js', 'session.js');
const src = () => fs.readFileSync(SESSION_JS, 'utf8');

function bodyOf(name) {
    const s = src();
    const at = s.indexOf(`export async function ${name}(`);
    assert.notEqual(at, -1, `${name} not found`);
    let depth = 0;
    for (let i = s.indexOf('{', at); i < s.length; i++) {
        if (s[i] === '{') depth++;
        else if (s[i] === '}' && --depth === 0) return s.slice(at, i + 1);
    }
    throw new Error('unbalanced');
}

test('showScreen maps the legacy #home library to #v3-songs', () => {
    const fn = bodyOf('showScreen');
    assert.match(
        fn,
        /id\s*===\s*'home'[\s\S]{0,80}getElementById\('v3-songs'\)[\s\S]{0,60}id\s*=\s*'v3-songs'/,
        "showScreen must route 'home' to 'v3-songs' ITSELF — relying on a wrapper over "
        + 'window.showScreen loses the mapping whenever a plugin wraps it first, and misses the '
        + 'module-internal callers (closeCurrentSong, Esc-from-settings) altogether',
    );
});

test('the guard runs BEFORE the screen is activated', () => {
    const fn = bodyOf('showScreen');
    const guard = fn.search(/id\s*=\s*'v3-songs'/);
    const activate = fn.indexOf('classList.add(\'active\')');
    assert.ok(guard !== -1 && activate !== -1);
    assert.ok(guard < activate,
        'the mapping must be applied before the screen is activated, or #home is shown first');
});

test('the guard is conditional on v3 actually being present', () => {
    const fn = bodyOf('showScreen');
    assert.match(fn, /getElementById\('v3-songs'\)/,
        'the mapping must check #v3-songs exists — without it there is nowhere to route to');
});

test('it does NOT redirect v3-home — the dashboard is a real screen', () => {
    // Codex [P1] on the first cut. _resolvePlayerOrigin() maps BOTH 'home' and 'v3-home' —
    // correctly, because it computes where to RETURN TO after a song, and landing on the Songs
    // list from the dashboard is right. Copying that condition into showScreen is NOT: #v3-home
    // is the v3 DASHBOARD, which the shell's Home nav, the onboarding tour and the dashboard
    // re-render listener all target. Redirecting it makes Home unreachable.
    //
    // A legacy alias is not the same thing as a return target.
    const fn = bodyOf('showScreen');
    // the condition, i.e. everything between `if (` and the `{` that opens `id = 'v3-songs'`
    const m = fn.match(/if \(([\s\S]*?)\)\s*\{\s*id = 'v3-songs';/);
    assert.ok(m, 'the legacy-home guard was not found');
    assert.doesNotMatch(m[1], /v3-home/,
        "showScreen must NOT redirect 'v3-home' — that is the dashboard, not the legacy library");
    assert.match(m[1], /id === 'home'/, "it must still redirect the legacy 'home'");
});
