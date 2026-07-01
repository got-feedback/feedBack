'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const APP_JS = path.join(__dirname, '..', '..', 'static', 'app.js');
const TUNER_SCREEN_JS = path.join(__dirname, '..', '..', 'plugins', 'tuner', 'screen.js');
const TUNING_UTILS_JS = path.join(__dirname, '..', '..', 'plugins', 'tuner', 'utils', 'tuning-utils.js');

function loadTuningHelpers() {
    const src = fs.readFileSync(APP_JS, 'utf8');
    const start = src.indexOf('function isBassArrangement(');
    const endMarker = 'window.feedBack.parseRawTuningOffsets = parseRawTuningOffsets;';
    const end = src.indexOf(endMarker);
    if (start === -1 || end === -1) throw new Error('tuning helper block not found in app.js');
    const sandbox = { window: { feedBack: {} }, exports: {} };
    vm.createContext(sandbox);
    vm.runInContext(
        src.slice(start, end + endMarker.length),
        sandbox
    );
    return sandbox.window.feedBack;
}

const feedBackHelpers = loadTuningHelpers();

function createTunerSandbox(opts) {
    // Auto-open is opt-in (default off in prod). The sandbox defaults it ON so the
    // behaviour tests exercise the feature; pass { autoOpen: false } to gate it off.
    const autoOpen = !opts || opts.autoOpen !== false;
    // The player's physical instrument for the §4 coverage check (core /api/settings).
    // Absent → the endpoint reports not-ok → coverage stays conservative (can't
    // decide → don't suppress the prompt), preserving the pre-coverage behaviour.
    const playerSettings = (opts && opts.player) || null;
    const enableCalls = [];
    let playerActive = true;
    let songInfo = null;

    const sandbox = {
        console,
        Promise,
        queueMicrotask,
        setTimeout(fn) { fn(); return 0; },
        clearTimeout() {},
        fetch(url) {
            const _u = String(url);
            if (_u.includes('/api/settings')) {
                return Promise.resolve(playerSettings
                    ? { ok: true, json: () => Promise.resolve(playerSettings) }
                    : { ok: false, json: () => Promise.resolve({}) });
            }
            if (_u.includes('/config')) {
                return Promise.resolve({
                    json: () => Promise.resolve({
                        showFloatingButton: true,
                        visualizationMode: 'default',
                        audioInputMode: 'auto',
                        autoOpenOnTuningChange: autoOpen,
                        lastInstrument: 'guitar-6',
                        lastTuning: 'Standard',
                        freeTune: false,
                        disabledTunings: [],
                        customTunings: {},
                    }),
                });
            }
            return Promise.resolve({
                json: () => Promise.resolve({
                    tunings: { 'guitar-6': { Standard: [82.41, 110, 146.83, 196, 246.94, 329.63] } },
                    referencePitch: 440,
                }),
            });
        },
        localStorage: {
            getItem: () => null,
            setItem() {},
        },
        document: {
            getElementById(id) {
                if (id === 'player') {
                    return { classList: { contains: () => playerActive } };
                }
                if (id === 'v3-tuner-wrap') return null;
                return null;
            },
            querySelector() { return null; },
            createElement(tag) {
                const el = {
                    tagName: tag.toUpperCase(),
                    src: '',
                    classList: { add() {}, remove() {}, contains: () => false },
                    className: '',
                    style: {},
                    appendChild() {},
                    remove() {},
                    addEventListener() {},
                    removeEventListener() {},
                    querySelector: () => null,
                    setAttribute() {},
                    onload: null,
                    onerror: null,
                };
                if (tag === 'script') {
                    queueMicrotask(() => { if (el.onload) el.onload(); });
                }
                return el;
            },
            head: { appendChild() {} },
            body: { appendChild() {} },
            addEventListener() {},
            removeEventListener() {},
        },
        __setPlayerActive(v) { playerActive = v; },
        __setSongInfo(info) {
            songInfo = info;
            sandbox.window.feedBack.currentSong = info ? {
                filename: info.filename || 'song.sloppak',
                arrangementIndex: info.arrangement_index,
                tuning: info.tuning,
            } : null;
        },
        __enableCalls: enableCalls,
    };

    sandbox.window = sandbox;
    sandbox.window.feedBack = {
        ...feedBackHelpers,
        on() {},
        off() {},
        currentSong: null,
    };
    sandbox.window.highway = {
        getSongInfo: () => songInfo,
    };
    // _tunerUtils comes from the REAL tuning-utils.js (loaded into the sandbox
    // below) so the §4 coverage check runs real pitch math, not stubbed values.
    sandbox.window._tunerUI = () => ({
        addButton() {},
        initUI() {},
        renderInstrumentOptions() {},
        renderTuningOptions() {},
        renderStringNotes() {},
        updateSaveAsCustomVisibility() {},
        updateFreeTuneUI() {},
        updateFloatingButton() {},
        updatePlayerButton() {},
        updateFloatingButtonVisibility() {},
        updateInstrumentDisplay() {},
        positionPanel() {},
        updateUI() {},
    });
    sandbox.window._tunerAudio = {
        start: async () => {},
        stop() {},
        restart: async () => {},
    };
    sandbox.window._tunerViz_default = () => ({
        update() {},
        destroy() {},
    });

    vm.createContext(sandbox);
    vm.runInContext(fs.readFileSync(TUNING_UTILS_JS, 'utf8'), sandbox);
    vm.runInContext(fs.readFileSync(TUNER_SCREEN_JS, 'utf8'), sandbox);

    const realEnable = sandbox.window.tuner.enable.bind(sandbox.window.tuner);
    sandbox.window.tuner.enable = async (enableOpts) => {
        enableCalls.push(enableOpts || {});
        return realEnable(enableOpts);
    };

    return sandbox;
}

const CUSTOM_GUITAR = {
    filename: 'amnesia.sloppak',
    arrangement: 'Lead',
    arrangement_index: 0,
    stringCount: 6,
    tuning: [-2, 0, 0, 0, -2, -2],
};

const E_STANDARD = {
    filename: 'standard.sloppak',
    arrangement: 'Lead',
    arrangement_index: 0,
    stringCount: 6,
    tuning: [0, 0, 0, 0, 0, 0],
};

const DROP_D = {
    filename: 'dropd.sloppak',
    arrangement: 'Lead',
    arrangement_index: 0,
    stringCount: 6,
    tuning: [-2, 0, 0, 0, 0, 0],
};

const BASS_EADG = {
    filename: 'bass.sloppak',
    arrangement: 'Bass',
    arrangement_index: 0,
    stringCount: 4,
    tuning: [0, 0, 0, 0],
};

async function ready(sandbox, song) {
    sandbox.__setSongInfo(song);
    await sandbox.window._tunerAutoOpen.maybeAutoOpenOnTuningChange();
}

test('tuning identity: same effective tuning returns same key', () => {
    const sandbox = createTunerSandbox();
    const key = sandbox.window._tunerAutoOpen.tuningIdentityKey(CUSTOM_GUITAR);
    assert.equal(key, sandbox.window._tunerAutoOpen.tuningIdentityKey({ ...CUSTOM_GUITAR }));
    assert.match(key, /^g:6:-2,0,0,0,-2,-2$/);
});

test('tuning identity: DADGAD custom vs E Standard differ', () => {
    const sandbox = createTunerSandbox();
    const custom = sandbox.window._tunerAutoOpen.tuningIdentityKey(CUSTOM_GUITAR);
    const standard = sandbox.window._tunerAutoOpen.tuningIdentityKey(E_STANDARD);
    assert.notEqual(custom, standard);
});

test('tuning identity: E Standard vs Drop D differ', () => {
    const sandbox = createTunerSandbox();
    const standard = sandbox.window._tunerAutoOpen.tuningIdentityKey(E_STANDARD);
    const dropD = sandbox.window._tunerAutoOpen.tuningIdentityKey(DROP_D);
    assert.notEqual(standard, dropD);
});

test('tuning identity: bass 4-string vs guitar 6-string differ', () => {
    const sandbox = createTunerSandbox();
    const bass = sandbox.window._tunerAutoOpen.tuningIdentityKey(BASS_EADG);
    const guitar = sandbox.window._tunerAutoOpen.tuningIdentityKey({
        ...BASS_EADG,
        arrangement: 'Lead',
        stringCount: 6,
        tuning: [0, 0, 0, 0, 0, 0],
    });
    assert.notEqual(bass, guitar);
    assert.match(bass, /^b:4:/);
    assert.match(guitar, /^g:6:/);
});

test('tuning identity: missing tuning returns null', () => {
    const sandbox = createTunerSandbox();
    assert.equal(sandbox.window._tunerAutoOpen.tuningIdentityKey(null), null);
    assert.equal(sandbox.window._tunerAutoOpen.tuningIdentityKey({ tuning: [] }), null);
});

test('first song load sets lastTuningKey but does not auto-open', async () => {
    const sandbox = createTunerSandbox();
    sandbox.window._tunerAutoOpen.resetState();
    await ready(sandbox, E_STANDARD);
    assert.equal(sandbox.__enableCalls.length, 0);
    assert.equal(sandbox.window._tunerAutoOpen.getState().lastTuningKey, 'g:6:0,0,0,0,0,0');
});

test('custom tuning then E Standard triggers one auto-open', async () => {
    const sandbox = createTunerSandbox();
    sandbox.window._tunerAutoOpen.resetState();
    await ready(sandbox, CUSTOM_GUITAR);
    await ready(sandbox, E_STANDARD);
    assert.equal(sandbox.__enableCalls.length, 1);
});

test('E Standard then Drop D triggers one auto-open', async () => {
    const sandbox = createTunerSandbox();
    sandbox.window._tunerAutoOpen.resetState();
    await ready(sandbox, E_STANDARD);
    await ready(sandbox, DROP_D);
    assert.equal(sandbox.__enableCalls.length, 1);
});

test('same tuning twice does not auto-open', async () => {
    const sandbox = createTunerSandbox();
    sandbox.window._tunerAutoOpen.resetState();
    await ready(sandbox, E_STANDARD);
    await ready(sandbox, { ...E_STANDARD, filename: 'other.sloppak' });
    assert.equal(sandbox.__enableCalls.length, 0);
});

test('duplicate song:ready for same tuning does not auto-open repeatedly', async () => {
    const sandbox = createTunerSandbox();
    sandbox.window._tunerAutoOpen.resetState();
    await ready(sandbox, CUSTOM_GUITAR);
    await ready(sandbox, E_STANDARD);
    await ready(sandbox, E_STANDARD);
    assert.equal(sandbox.__enableCalls.length, 1);
});

test('if tuner already enabled, no duplicate enable call', async () => {
    const sandbox = createTunerSandbox();
    sandbox.window._tunerAutoOpen.resetState();
    await ready(sandbox, CUSTOM_GUITAR);
    sandbox.window._tunerAutoOpen.setEnabledForTests(true);
    const before = sandbox.__enableCalls.length;
    await ready(sandbox, E_STANDARD);
    assert.equal(sandbox.__enableCalls.length, before);
});

test('user dismiss prevents reopen for same session', async () => {
    const sandbox = createTunerSandbox();
    sandbox.window._tunerAutoOpen.resetState();
    await ready(sandbox, CUSTOM_GUITAR);
    await ready(sandbox, { ...E_STANDARD, filename: 'amnesia.sloppak', arrangement_index: 0 });
    assert.equal(sandbox.__enableCalls.length, 1);
    sandbox.window._tunerAutoOpen.setEnabledForTests(true);
    sandbox.window.tuner.disable();
    await ready(sandbox, { ...DROP_D, filename: 'amnesia.sloppak', arrangement_index: 0 });
    assert.equal(sandbox.__enableCalls.length, 1);
});

test('song:loading clears dismiss state for next load', async () => {
    const sandbox = createTunerSandbox();
    sandbox.window._tunerAutoOpen.resetState();
    await ready(sandbox, CUSTOM_GUITAR);
    await ready(sandbox, E_STANDARD);
    sandbox.window.tuner.disable();
    sandbox.window._tunerAutoOpen.onSongLoading();
    await ready(sandbox, DROP_D);
    assert.equal(sandbox.__enableCalls.length, 2);
});

test('auto-open is gated off when the setting is disabled (opt-in)', async () => {
    const sandbox = createTunerSandbox({ autoOpen: false });
    sandbox.window._tunerAutoOpen.resetState();
    await ready(sandbox, CUSTOM_GUITAR);
    await ready(sandbox, E_STANDARD);   // a real tuning change, but the setting is off
    assert.equal(sandbox.__enableCalls.length, 0);
});

test('auto-open enables in persist mode (passes { auto: true })', async () => {
    const sandbox = createTunerSandbox();
    sandbox.window._tunerAutoOpen.resetState();
    await ready(sandbox, CUSTOM_GUITAR);
    await ready(sandbox, E_STANDARD);
    assert.equal(sandbox.__enableCalls.length, 1);
    assert.equal(sandbox.__enableCalls[0].auto, true);
});

test('persist: an auto-opened tuner is not torn down by autoplay / stray clicks', () => {
    const screenSrc = fs.readFileSync(TUNER_SCREEN_JS, 'utf8');
    const uiSrc = fs.readFileSync(
        path.join(__dirname, '..', '..', 'plugins', 'tuner', 'utils', 'ui.js'), 'utf8');
    // The gate is opt-in on the server config flag.
    assert.match(screenSrc, /autoOpenOnTuningChange/);
    // enable() records whether this was an auto-open …
    assert.match(screenSrc, /_state\.autoOpened\s*=\s*auto/);
    // … the outside-click dismiss is armed only for a manual open …
    assert.match(screenSrc, /if \(!auto\)[\s\S]*?addEventListener\('click'/);
    // … and the autoplay song:play closer ignores an auto-opened tuner (the flash fix).
    assert.match(uiSrc, /state\.enabled && !state\.autoOpened/);
});

test('screen.js registers song:loading and song:ready auto-open listeners at boot', () => {
    const src = fs.readFileSync(TUNER_SCREEN_JS, 'utf8');
    assert.match(src, /function _installAutoOpenListeners/);
    assert.match(src, /window\.feedBack\.on\('song:loading', _onAutoOpenSongLoading\)/);
    assert.match(src, /window\.feedBack\.on\('song:ready', _onAutoOpenSongReady\)/);
    assert.match(src, /function _tuningIdentityKey/);
    assert.doesNotMatch(src, /restartCurrentSong/);
});

// ── §4 instrument-coverage (E1.5) ──────────────────────────────────────────
// Player physical instruments (core /api/settings shape: instrument/string_count/
// tuning offsets/reference_pitch).
const PLAYER_GUITAR_8_FS = { instrument: 'guitar', string_count: 8, tuning: [0, 0, 0, 0, 0, 0, 0, 0], reference_pitch: 440 }; // F# standard
const PLAYER_GUITAR_6 = { instrument: 'guitar', string_count: 6, tuning: [0, 0, 0, 0, 0, 0], reference_pitch: 440 };          // E standard
const SONG_7B = { filename: '7b.sloppak', arrangement: 'Lead', arrangement_index: 0, stringCount: 7, tuning: [0, 0, 0, 0, 0, 0, 0] };           // B standard 7
const SONG_DROP_A7 = { filename: 'dropa7.sloppak', arrangement: 'Lead', arrangement_index: 0, stringCount: 7, tuning: [-2, 0, 0, 0, 0, 0, 0] }; // Drop A 7

test('coverage: an 8-string F# player is NOT prompted for a covered 6-/7-string standard song', async () => {
    const sandbox = createTunerSandbox({ player: PLAYER_GUITAR_8_FS });
    sandbox.window._tunerAutoOpen.resetState();
    await ready(sandbox, DROP_D);        // first song → sets lastTuningKey, no open
    await ready(sandbox, E_STANDARD);    // 6-E lives on the 8-string's top 6 → suppressed
    assert.equal(sandbox.__enableCalls.length, 0);
    await ready(sandbox, SONG_7B);       // 7-B lives on the 8-string's top 7 → suppressed
    assert.equal(sandbox.__enableCalls.length, 0);
});

test('coverage: a Drop-A 7-string song STILL prompts the 8-string F# player (dropped string absent)', async () => {
    const sandbox = createTunerSandbox({ player: PLAYER_GUITAR_8_FS });
    sandbox.window._tunerAutoOpen.resetState();
    await ready(sandbox, E_STANDARD);    // first → no open
    await ready(sandbox, SONG_DROP_A7);  // needs an open A1; the 8-string has F#1/B1, not A1 → prompt
    assert.equal(sandbox.__enableCalls.length, 1);
});

test('coverage: a 6-string-standard player IS prompted for Drop D', async () => {
    const sandbox = createTunerSandbox({ player: PLAYER_GUITAR_6 });
    sandbox.window._tunerAutoOpen.resetState();
    await ready(sandbox, E_STANDARD);    // first → no open
    await ready(sandbox, DROP_D);        // low E must drop to D → not covered → prompt
    assert.equal(sandbox.__enableCalls.length, 1);
});

test('coverage: a reference-pitch mismatch (A432 player vs A440 song) prompts even when the shape matches', async () => {
    const sandbox = createTunerSandbox({ player: { ...PLAYER_GUITAR_6, reference_pitch: 432 } });
    sandbox.window._tunerAutoOpen.resetState();
    await ready(sandbox, DROP_D);        // first → no open
    await ready(sandbox, E_STANDARD);    // shape matches, but the whole instrument is ~32¢ flat → prompt
    assert.equal(sandbox.__enableCalls.length, 1);
});

test('coverage: covered/uncovered is decided by contiguous pitch alignment (direct)', async () => {
    const sandbox = createTunerSandbox({ player: PLAYER_GUITAR_8_FS });
    const cover = (song) => sandbox.window._tunerAutoOpen.coveredByPlayerInstrument(song);
    assert.equal(await cover(E_STANDARD), true);     // 6-E is a run inside 8-string F#
    assert.equal(await cover(SONG_7B), true);        // 7-B is a run inside 8-string F#
    assert.equal(await cover(SONG_DROP_A7), false);  // Drop-A's low A1 isn't an open string on it
});

test('coverage: with no declared instrument it stays conservative (prompts as before)', async () => {
    const sandbox = createTunerSandbox();   // no /api/settings instrument
    sandbox.window._tunerAutoOpen.resetState();
    await ready(sandbox, CUSTOM_GUITAR);
    await ready(sandbox, E_STANDARD);
    assert.equal(sandbox.__enableCalls.length, 1);
});

// ── §4 coverage report + badge cue (E1.6) ──────────────────────────────────
test('coverage report names the string(s) to retune', async () => {
    // Note: report objects come from the vm sandbox realm, so compare fields, not
    // deepStrictEqual (which checks prototype identity across realms).
    const sandbox = createTunerSandbox({ player: PLAYER_GUITAR_8_FS });
    const rep = (s) => sandbox.window._tunerAutoOpen.coverageReport(s);
    const covered = await rep(E_STANDARD);
    assert.equal(covered.covered, true);
    assert.equal(covered.retune.length, 0);
    assert.equal(covered.reference, false);
    const dropA = await rep(SONG_DROP_A7);
    assert.equal(dropA.covered, false);
    assert.equal(dropA.retune.length, 1);
    assert.equal(dropA.retune[0].from, 'B');   // the user's exact case → "retune B → A"
    assert.equal(dropA.retune[0].to, 'A');
});

test('coverage report flags a whole-instrument reference mismatch', async () => {
    const sandbox = createTunerSandbox({ player: { ...PLAYER_GUITAR_6, reference_pitch: 432 } });
    const rep = await sandbox.window._tunerAutoOpen.coverageReport(E_STANDARD);
    assert.equal(rep.covered, false);
    assert.equal(rep.reference, true);
});

test('the tuner badge surfaces a passive coverage cue (badges.js)', () => {
    const badgesSrc = fs.readFileSync(
        path.join(__dirname, '..', '..', 'static', 'v3', 'badges.js'), 'utf8');
    // Recomputes via the tuner plugin's coverageReport on song:ready …
    assert.match(badgesSrc, /api\.coverageReport/);
    assert.match(badgesSrc, /sm\.on\('song:ready'/);
    // … and shows an advisory ring + tooltip naming the retune (it never auto-opens).
    assert.match(badgesSrc, /function _applyCoverageCue/);
    assert.match(badgesSrc, /report\.retune/);
    assert.match(badgesSrc, /boxShadow/);
});

test('auto-open does not require app.js changes', () => {
    const appSrc = fs.readFileSync(APP_JS, 'utf8');
    assert.doesNotMatch(appSrc, /_tunerAutoOpen|maybeAutoOpenOnTuningChange/);
});

// ── PR 3: per-instrument live working tuning (the both-directions fix) ──────
test('coverage reads the live per-instrument working tuning, so it prompts BOTH directions', async () => {
    // GUITAR-6 selected; the player's LIVE working tuning is Drop-D (they retuned).
    const sandbox = createTunerSandbox({ player: { instrument: 'guitar', string_count: 6, tuning: 'Standard' } });
    sandbox.window.feedBack.workingTuning = {
        get: () => ({ offsets: [-2, 0, 0, 0, 0, 0], stringCount: 6, instrument: 'guitar', referencePitch: 440 }),
        set() {},
    };
    const rep = (s) => sandbox.window._tunerAutoOpen.coverageReport(s);
    // The Drop-D song now MATCHES the live tuning → covered (no prompt).
    assert.equal((await rep(DROP_D)).covered, true);
    // An E-standard song NO LONGER matches (the player is in Drop-D) → not covered →
    // prompts to tune the low string back UP to E. The old static-profile logic missed
    // this "coming back" direction entirely.
    const estd = await rep(E_STANDARD);
    assert.equal(estd.covered, false);
    assert.equal(estd.retune.length, 1);
    assert.equal(estd.retune[0].from, 'D');   // player low string is D…
    assert.equal(estd.retune[0].to, 'E');     // …song wants E → "tune D → E" (up)
});

// Wire a set-capturing workingTuning stub, then run a coverage read so the tuner caches
// the selected-instrument identity (publish is synchronous and writes to that cached
// slot — an auto-open always runs coverage first, so this mirrors real ordering).
async function _primeSets(sandbox, get = () => ({ offsets: null })) {
    const sets = [];
    sandbox.window.feedBack.workingTuning = { get, set: (state, opts) => sets.push({ state, opts }) };
    await sandbox.window._tunerAutoOpen.playerTuning();
    return sets;
}

test('clearing the auto-opened tuner publishes the song tuning to the right instrument slot', async () => {
    const sandbox = createTunerSandbox({ player: { instrument: 'guitar', string_count: 6, tuning: 'Standard' } });
    const sets = await _primeSets(sandbox);
    sandbox.window._tunerAutoOpen.publishWorkingTuning(DROP_D);
    assert.equal(sets.length, 1);
    assert.deepEqual(sets[0].state.offsets, [-2, 0, 0, 0, 0, 0]);   // the song's tuning
    assert.equal(sets[0].state.instrument, 'guitar');
    assert.equal(sets[0].opts.instrument, 'guitar-6');             // targets the guitar slot
    assert.equal(sets[0].opts.provenance, 'assumed');              // a guess, not mic-verified
});

test('publish targets the SELECTED instrument slot, not a song-derived one (string-count mismatch)', async () => {
    // A 5-string bass is selected; the cleared song is a 4-string bass chart. The publish
    // must land in bass-5 (what coverage reads), NOT bass-4 (where it would be stranded).
    const sandbox = createTunerSandbox({ player: { instrument: 'bass', string_count: 5, tuning: 'Standard' } });
    const sets = await _primeSets(sandbox);
    sandbox.window._tunerAutoOpen.publishWorkingTuning(BASS_EADG);
    assert.equal(sets.length, 1);
    assert.equal(sets[0].opts.instrument, 'bass-5');   // the selected instrument's slot
    assert.equal(sets[0].state.instrument, 'bass');
});

test('publish skips a cross-instrument chart (bass arrangement while guitar is selected)', async () => {
    // Guitar selected, but the player manually opened the Bass arrangement and cleared.
    // That is not evidence the guitar was retuned — do not pollute either slot.
    const sandbox = createTunerSandbox({ player: { instrument: 'guitar', string_count: 6, tuning: 'Standard' } });
    const sets = await _primeSets(sandbox);
    sandbox.window._tunerAutoOpen.publishWorkingTuning(BASS_EADG);
    assert.equal(sets.length, 0);
});

test('publish carries the player reference pitch so the slot is self-consistent', async () => {
    const sandbox = createTunerSandbox({ player: { instrument: 'guitar', string_count: 6, tuning: 'Standard', reference_pitch: 432 } });
    const sets = await _primeSets(sandbox);
    sandbox.window._tunerAutoOpen.publishWorkingTuning(DROP_D);
    assert.equal(sets.length, 1);
    assert.equal(sets[0].state.referencePitch, 432);
});

test('publish skips when the instrument could not be confidently resolved (settings unreadable)', async () => {
    // No player settings → /api/settings reports not-ok → we never cached a confident
    // selection, so publish must NOT write to a guessed default slot.
    const sandbox = createTunerSandbox();   // no player
    const sets = await _primeSets(sandbox);
    sandbox.window._tunerAutoOpen.publishWorkingTuning(DROP_D);
    assert.equal(sets.length, 0);
});
