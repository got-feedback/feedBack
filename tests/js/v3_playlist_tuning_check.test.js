// The playlist tuning check (static/v3/playlists.js).
//
// A bass-playing tester built playlists grouped BY TUNING so a practice run
// needs no retune, using a library filter that only ever looked at the guitar
// tuning. Those playlists still hold songs he can't play without stopping. The
// check flags them; it must never quietly edit the playlist, and — the part
// that decides whether he trusts it — it must not call a song "wrong tuning"
// when it simply couldn't work the song out.
//
// The real functions are lifted out of playlists.js and run in a vm (the module
// is a browser IIFE with no export surface, and there is no jsdom here). No
// re-implementation: if the source changes, these tests run the changed code.

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const PL_JS = path.join(__dirname, '..', '..', 'static', 'v3', 'playlists.js');
const TUNING_JS = path.join(__dirname, '..', '..', 'static', 'js', 'tuning-display.js');
const TUNER_JS = path.join(__dirname, '..', '..', 'plugins', 'tuner', 'screen.js');

const PL_SRC = fs.readFileSync(PL_JS, 'utf8');

function extractBlock(src, startMarker) {
    const start = src.indexOf(startMarker);
    if (start === -1) throw new Error(`extractBlock: '${startMarker}' not found`);
    const openBrace = src.indexOf('{', start);
    let depth = 1;
    let i = openBrace + 1;
    while (i < src.length && depth > 0) {
        const ch = src[i];
        if (ch === '{') depth++;
        else if (ch === '}') depth--;
        i++;
    }
    if (depth !== 0) throw new Error(`extractBlock: unbalanced braces after '${startMarker}'`);
    return src.slice(start, i);
}

// The REAL offset parser the checker calls through window.parseRawTuningOffsets.
function loadParseRawTuningOffsets() {
    const body = fs.readFileSync(TUNING_JS, 'utf8').replace(/^export /gm, '');
    const sandbox = { window: { feedBack: {} }, exports: {} };
    vm.createContext(sandbox);
    vm.runInContext(body + '\nexports.parseRawTuningOffsets = parseRawTuningOffsets;', sandbox);
    return sandbox.exports.parseRawTuningOffsets;
}

// Build a sandbox holding the real checker functions, over a caller-supplied
// window (so each test controls the host capabilities and the coverage stub
// boundary). `coverage` stands in for the tuner plugin's coverageReport — a
// genuinely external collaborator, not the subject under test; the contract
// test at the bottom pins its report shape so these fixtures can't drift.
function loadChecker(opts) {
    opts = opts || {};
    const calls = [];
    const window = {
        parseRawTuningOffsets: loadParseRawTuningOffsets(),
        feedBack: opts.noWorkingTuning ? {} : { workingTuning: { get: () => ({ instrument: 'bass' }) } },
        _tunerAutoOpen: opts.noCoverage ? undefined : {
            coverageReport: async (info) => {
                calls.push(info);
                if (opts.coverage) return opts.coverage(info);
                throw new Error('no coverage fixture supplied');
            },
        },
    };
    const sandbox = { window, exports: {} };
    vm.createContext(sandbox);
    vm.runInContext(
        extractBlock(PL_SRC, 'function rowTuningForCheck(') + '\n'
        + extractBlock(PL_SRC, 'function tuningStateFromReport(') + '\n'
        + extractBlock(PL_SRC, 'async function checkPlaylistTuning(') + '\n'
        + extractBlock(PL_SRC, 'function tuningSummaryHtml(') + '\n'
        + 'exports.rowTuningForCheck = rowTuningForCheck;\n'
        + 'exports.tuningStateFromReport = tuningStateFromReport;\n'
        + 'exports.checkPlaylistTuning = checkPlaylistTuning;\n'
        + 'exports.tuningSummaryHtml = tuningSummaryHtml;\n',
        sandbox
    );
    return { ...sandbox.exports, calls };
}

// Report shapes exactly as plugins/tuner/screen.js documents and returns them.
const REPORT_COVERED = { covered: true, retune: [], reference: false, cantCover: false };
const REPORT_RETUNE = { covered: false, retune: [{ from: 'E', to: 'D' }], reference: false, cantCover: false };
const REPORT_REFERENCE = { covered: false, retune: [], reference: true, cantCover: false };
const REPORT_CANT_COVER = { covered: false, retune: [], reference: false, cantCover: true };
// The "I couldn't work it out" report — the tuner's `none` bail-out. Byte-for-byte
// a not-covered report with no reason attached.
const REPORT_UNKNOWN = { covered: false, retune: [], reference: false, cantCover: false };

// The checker runs inside the vm, so the arrays it returns belong to another
// realm and would fail deepStrictEqual's prototype check. Copy into host arrays.
const plain = (a) => Array.from(a);

const song = (over) => Object.assign(
    { filename: 'a.sloppak', title: 'A', tuning_name: 'E Standard', tuning_offsets: '0 0 0 0 0 0', bass_only: false },
    over
);

// ── The unknown-vs-mismatch distinction ─────────────────────────────────────

test('a covered report is a match', () => {
    const { tuningStateFromReport } = loadChecker();
    assert.equal(tuningStateFromReport(REPORT_COVERED), 'match');
});

test('a not-covered report WITH a reason is a mismatch', () => {
    const { tuningStateFromReport } = loadChecker();
    assert.equal(tuningStateFromReport(REPORT_RETUNE), 'mismatch');
    assert.equal(tuningStateFromReport(REPORT_REFERENCE), 'mismatch');
    assert.equal(tuningStateFromReport(REPORT_CANT_COVER), 'mismatch');
});

test('a not-covered report with NO reason is unknown, not a mismatch', () => {
    // This is the whole trust argument. The tuner returns this identical shape
    // when settings/tuner data are missing. Treating it as "wrong tuning" (which
    // the library grid's chip decorator does) would put a false ⚠ on songs that
    // are perfectly playable, on a playlist the user curated by hand.
    const { tuningStateFromReport } = loadChecker();
    assert.equal(tuningStateFromReport(REPORT_UNKNOWN), 'unknown');
});

test('a null/absent report is unknown', () => {
    const { tuningStateFromReport } = loadChecker();
    assert.equal(tuningStateFromReport(null), 'unknown');
    assert.equal(tuningStateFromReport(undefined), 'unknown');
});

// ── Round-tripping a whole playlist ─────────────────────────────────────────

test('each song is scored and reported in playlist order', async () => {
    const byFile = {
        'match.sloppak': REPORT_COVERED,
        'bad.sloppak': REPORT_RETUNE,
        'huh.sloppak': REPORT_UNKNOWN,
    };
    const songs = [
        song({ filename: 'match.sloppak', title: 'Match' }),
        song({ filename: 'bad.sloppak', title: 'Bad', tuning_offsets: '-2 -2 -2 -2 -2 -2' }),
        song({ filename: 'huh.sloppak', title: 'Huh', tuning_offsets: '-1 0 0 0 0 0' }),
    ];
    // Resolve the fixture from the offsets the checker actually passed, so the
    // mapping can't silently drift out of playlist order.
    const byOffsets = new Map(songs.map((s) => [s.tuning_offsets.replace(/\s+/g, ','), byFile[s.filename]]));
    const checker = loadChecker({ coverage: async (info) => byOffsets.get(info.tuning.join(',')) });
    const out = await checker.checkPlaylistTuning(songs);
    assert.deepEqual(plain(out.map((r) => r.state)), ['match', 'mismatch', 'unknown']);
    assert.deepEqual(plain(out.map((r) => r.song.filename)), songs.map((s) => s.filename));
});

test('a song with no usable tuning data is unknown WITHOUT consulting coverage', async () => {
    // Adversarial payloads: empty, whitespace, a non-numeric name with no
    // offsets, and a garbage offsets string. None of these can be scored, and
    // asking coverage about them would invite a bogus not-covered → false ⚠.
    const checker = loadChecker({ coverage: async () => REPORT_RETUNE });
    const out = await checker.checkPlaylistTuning([
        song({ filename: 'a', tuning_offsets: '', tuning_name: '' }),
        song({ filename: 'b', tuning_offsets: '   ', tuning_name: '   ' }),
        song({ filename: 'c', tuning_offsets: '', tuning_name: 'E Standard' }),
        song({ filename: 'd', tuning_offsets: 'not offsets', tuning_name: 'x' }),
        song({ filename: 'e', tuning_offsets: null, tuning_name: null }),
    ]);
    assert.deepEqual(plain(out.map((r) => r.state)), ['unknown', 'unknown', 'unknown', 'unknown', 'unknown']);
    assert.equal(checker.calls.length, 0, 'coverage must not be asked about unscoreable rows');
});

test('a coverage call that throws degrades to unknown, not mismatch', async () => {
    const checker = loadChecker({ coverage: async () => { throw new Error('tuner exploded'); } });
    const out = await checker.checkPlaylistTuning([song({})]);
    assert.deepEqual(plain(out.map((r) => r.state)), ['unknown']);
});

test('a bass-only chart is scored against bass base pitches', async () => {
    // Otherwise a 4-string bass tuning read as guitar can false-match — the
    // cross-instrument confusion this whole feature exists to undo.
    const checker = loadChecker({ coverage: async () => REPORT_COVERED });
    await checker.checkPlaylistTuning([
        song({ filename: 'bass', tuning_offsets: '0 0 0 0', bass_only: true }),
        song({ filename: 'gtr', tuning_offsets: '0 0 0 0 0 0', bass_only: false }),
    ]);
    assert.deepEqual(checker.calls.map((c) => c.arrangement), ['Bass', 'Lead']);
    assert.deepEqual(checker.calls.map((c) => c.stringCount), [4, 6]);
});

test('the check stays silent when the host exposes no tuning perspective', async () => {
    // No working-tuning capability, or no tuner coverage → null, and the caller
    // renders the playlist exactly as before. Guessing "guitar" here would
    // reproduce the original bug in a new place.
    for (const opts of [{ noWorkingTuning: true }, { noCoverage: true }]) {
        const checker = loadChecker(Object.assign({ coverage: async () => REPORT_COVERED }, opts));
        assert.equal(await checker.checkPlaylistTuning([song({})]), null);
    }
});

test('an empty playlist yields an empty result, not a crash', async () => {
    const checker = loadChecker({ coverage: async () => REPORT_COVERED });
    assert.deepEqual(plain(await checker.checkPlaylistTuning([])), []);
    assert.deepEqual(plain(await checker.checkPlaylistTuning(null)), []);
});

// ── The summary ─────────────────────────────────────────────────────────────

test('the summary counts mismatches against the playlist total', () => {
    const { tuningSummaryHtml } = loadChecker();
    const results = [
        { state: 'mismatch' }, { state: 'mismatch' }, { state: 'mismatch' },
        ...Array(21).fill({ state: 'match' }),
    ];
    const html = tuningSummaryHtml(results);
    assert.match(html, /<strong>3<\/strong> of 24 songs aren't in your tuning/);
});

test('unknowns are reported separately from mismatches and never counted as them', () => {
    const { tuningSummaryHtml } = loadChecker();
    const html = tuningSummaryHtml([{ state: 'mismatch' }, { state: 'unknown' }, { state: 'match' }]);
    assert.match(html, /<strong>1<\/strong> of 3 songs aren't in your tuning/);
    assert.match(html, /1 couldn't be checked/);
    assert.match(html, /left alone/);
});

test('an all-unknown playlist makes no mismatch claim and offers no removal', () => {
    const { tuningSummaryHtml } = loadChecker();
    const html = tuningSummaryHtml([{ state: 'unknown' }, { state: 'unknown' }]);
    assert.doesNotMatch(html, /aren't in your tuning/);
    assert.doesNotMatch(html, /v3-pl-tune-remove/);
    assert.match(html, /2 couldn't be checked/);
});

test('a clean playlist offers no filter and no removal button', () => {
    const { tuningSummaryHtml } = loadChecker();
    const html = tuningSummaryHtml([{ state: 'match' }, { state: 'match' }]);
    assert.match(html, /All 2 songs are in your tuning/);
    assert.doesNotMatch(html, /v3-pl-tune-only/);
    assert.doesNotMatch(html, /v3-pl-tune-remove/);
});

test('an empty playlist renders no summary at all', () => {
    const { tuningSummaryHtml } = loadChecker();
    assert.equal(tuningSummaryHtml([]), '');
});

// ── Read-only / explicit-action guarantees (source-level) ───────────────────

test('the check itself never mutates the playlist', () => {
    // checkPlaylistTuning and its helpers must contain no write verbs. The only
    // DELETE in the module's tuning path is inside the confirmed removal.
    const fns = ['function rowTuningForCheck(', 'function tuningStateFromReport(',
        'async function checkPlaylistTuning(', 'function tuningSummaryHtml('];
    for (const marker of fns) {
        const body = extractBlock(PL_SRC, marker);
        assert.doesNotMatch(body, /DELETE|jsend\(|method:/,
            marker + ' must not mutate the playlist');
    }
});

test('bulk removal names every song and is confirmed before any DELETE', () => {
    const body = extractBlock(PL_SRC, 'async function applyTuningCheck(');
    // The confirm is built from the doomed titles, each escaped. The row markup
    // moved from <li> to a bulleted <div> so the confirm needs no Tailwind class
    // the committed CSS lacks — what matters is that every song is named and
    // escaped, not which element wraps it.
    assert.match(body, /doomed\.map\(\(s\) => '<(?:li|div)>[^']*' \+ esc\(s\.title \|\| s\.filename\)/);
    // … it is awaited, and an early return happens before the delete loop.
    const confirmAt = body.indexOf('uiConfirm');
    const bailAt = body.indexOf('if (!ok) return;');
    const deleteAt = body.indexOf("method: 'DELETE'");
    assert.ok(confirmAt > -1 && bailAt > confirmAt && deleteAt > bailAt,
        'DELETE must come after an awaited confirm and its bail-out');
    // And it says the songs survive in the library — the "reversible-feeling" ask.
    assert.match(body, /stay in your library/);
});

test('removal targets only mismatches — never unknowns', () => {
    const body = extractBlock(PL_SRC, 'async function applyTuningCheck(');
    assert.match(body, /results\.filter\(\(r\) => r\.state === 'mismatch'\)\.map\(\(r\) => r\.song\)/);
    assert.doesNotMatch(body, /doomed[\s\S]{0,200}'unknown'/);
});

test('unknown is styled distinctly from mismatch', () => {
    const body = extractBlock(PL_SRC, 'function paintTuningChip(');
    // Mismatch is amber; unknown is the neutral chip, dimmed — not amber.
    assert.match(body, /state === 'mismatch' \? 'bg-amber-400'/);
    assert.match(body, /state === 'unknown'\) chip\.classList\.add\('opacity-60'\)/);
    // …and both carry a text marker, so the states never rest on colour alone.
    assert.match(body, /state === 'mismatch' \? ' ⚠' : state === 'unknown' \? ' \?'/);
});

// ── Collaborator contract ───────────────────────────────────────────────────

test('the tuner coverage report still carries the fields the states are read from', () => {
    // If the tuner plugin drops `retune`/`reference`/`cantCover`, every mismatch
    // silently degrades to "unknown" and the feature goes quiet. Pin the shape
    // the fixtures above rely on.
    const tuner = fs.readFileSync(TUNER_JS, 'utf8');
    const body = extractBlock(tuner, 'async function _computeCoverageReport(');
    for (const field of ['covered', 'retune', 'reference', 'cantCover']) {
        assert.match(body, new RegExp(field), `coverage report must still carry ${field}`);
    }
    assert.match(body, /const none = \{ covered: false, retune: \[\], reference: false, cantCover: false \}/,
        'the no-data bail-out must stay a reasonless not-covered report — that is what "unknown" detects');
});
