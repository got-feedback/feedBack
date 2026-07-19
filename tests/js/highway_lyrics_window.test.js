// Behavioural tests for the lyric display window (drawLyrics in
// static/js/highway-draw.js): width-based pre-splitting of long lines,
// the rolling current+upcoming window, its caps, and the live-tunable
// config reader. Extraction-by-source pattern per highway_teaching_marks.
//
// The 3D plugin (plugins/highway_3d/screen.js) carries a deliberate
// duplicate of this logic; these tests pin the canonical copy.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const SRC = fs.readFileSync(
    path.join(__dirname, '..', '..', 'static', 'js', 'highway-draw.js'), 'utf8');

function extractFn(src, name) {
    const start = src.indexOf('function ' + name);
    assert.ok(start >= 0, `function ${name} must exist`);
    const open = src.indexOf('{', start);
    let depth = 0;
    for (let i = open; i < src.length; i++) {
        if (src[i] === '{') depth++;
        else if (src[i] === '}' && --depth === 0) return { text: src.slice(start, i + 1), end: i + 1 };
    }
    throw new Error(`unbalanced braces extracting ${name}`);
}

// getLyricsDisplayCfg with its module-level state: slice from the defaults
// const through the end of the function so the real declarations come along.
function loadCfgReader(storage) {
    const constIdx = SRC.indexOf('const LYRICS_DISPLAY_DEFAULTS');
    assert.ok(constIdx >= 0);
    const fn = extractFn(SRC, 'getLyricsDisplayCfg');
    const body = SRC.slice(constIdx, fn.end).replace(/^export /gm, '');
    return new Function('localStorage', '"use strict";' + body + '\nreturn getLyricsDisplayCfg;')(storage);
}

function makeStorage(initial) {
    const store = new Map(Object.entries(initial || {}));
    return {
        getItem: (k) => (store.has(k) ? store.get(k) : null),
        setItem: (k, v) => store.set(k, String(v)),
    };
}

test('cfg reader: defaults, clamping, corrupt JSON, live re-read', () => {
    const storage = makeStorage();
    const read = loadCfgReader(storage);
    assert.deepEqual(read(), { upcomingLines: 2, lookaheadSec: 8 });

    storage.setItem('lyricsDisplay', JSON.stringify({ upcomingLines: 99, lookaheadSec: 0 }));
    assert.deepEqual(read(), { upcomingLines: 4, lookaheadSec: 1 }); // clamped

    storage.setItem('lyricsDisplay', '{not json');
    assert.deepEqual(read(), { upcomingLines: 2, lookaheadSec: 8 }); // corrupt -> defaults

    storage.setItem('lyricsDisplay', JSON.stringify({ upcomingLines: 1 }));
    assert.deepEqual(read(), { upcomingLines: 1, lookaheadSec: 8 }); // partial merges over defaults
});

// ── drawLyrics harness ───────────────────────────────────────────────────
// Deps injected: _measureLyricText (10px per char), roundRect (noop),
// getLyricsDisplayCfg (test-controlled). ctx records fillText rows.
function loadDrawLyrics(cfg) {
    const fn = extractFn(SRC, 'drawLyrics');
    return new Function(
        '_measureLyricText', 'roundRect', 'getLyricsDisplayCfg',
        '"use strict";' + fn.text + '\nreturn drawLyrics;'
    )(
        (hw, ctx, fs_, text) => text.length * 10,
        () => {},
        () => cfg
    );
}

function makeCtx() {
    const calls = [];
    return {
        calls,
        font: '', fillStyle: '', textAlign: '', textBaseline: '',
        fillText: (text, x, y) => calls.push({ text, x, y }),
        fill: () => {}, beginPath: () => {},
        measureText: (t) => ({ width: t.length * 10 }),
    };
}

function rowsDrawn(ctx) {
    return new Set(ctx.calls.map(c => c.y)).size;
}

// Word-timed syllables, one per word, `plus` marks authored line ends.
function syl(t, w, plus) { return { t, d: 0.4, w: plus ? w + '+' : w }; }

const H = 1000; // fontSize = max(18, 28) = 28

test('line-timed lyrics: current + upcoming context lines shown', () => {
    // Four short authored lines, 2s apart — all inside an 8s lookahead.
    const lyrics = [
        syl(10, 'one', true), syl(12, 'two', true),
        syl(14, 'three', true), syl(16, 'four', true),
    ];
    const draw = loadDrawLyrics({ upcomingLines: 2, lookaheadSec: 8 });
    const ctx = makeCtx();
    draw({ lyrics, ctx, currentTime: 10.1 }, 2000, H);
    assert.equal(rowsDrawn(ctx), 3, 'current + 2 upcoming');
    assert.deepEqual(ctx.calls.map(c => c.text), ['one', 'two', 'three']);
});

test('upcomingLines: 0 shows only the current line', () => {
    const lyrics = [syl(10, 'one', true), syl(12, 'two', true)];
    const draw = loadDrawLyrics({ upcomingLines: 0, lookaheadSec: 8 });
    const ctx = makeCtx();
    draw({ lyrics, ctx, currentTime: 10.1 }, 2000, H);
    assert.equal(rowsDrawn(ctx), 1);
    assert.deepEqual(ctx.calls.map(c => c.text), ['one']);
});

test('lookahead gates upcoming lines', () => {
    // Next line 20s away — outside an 8s lookahead.
    const lyrics = [syl(10, 'one', true), syl(30, 'far', true)];
    const draw = loadDrawLyrics({ upcomingLines: 2, lookaheadSec: 8 });
    const ctx = makeCtx();
    draw({ lyrics, ctx, currentTime: 10.1 }, 2000, H);
    assert.deepEqual(ctx.calls.map(c => c.text), ['one']);
});

test('a giant unmarked line splits into rows capped by the window', () => {
    // 40 words, no "+" anywhere, continuous timing (gaps < 4s): the old
    // renderer wrapped all of it at once. Narrow canvas (W=300 →
    // maxWidth=240) forces splits; the window must cap what is drawn at
    // 1 current + 2 upcoming rows, never the whole blob.
    const lyrics = [];
    for (let i = 0; i < 40; i++) lyrics.push(syl(10 + i * 0.5, 'word' + i, false));
    const draw = loadDrawLyrics({ upcomingLines: 2, lookaheadSec: 8 });
    const ctx = makeCtx();
    draw({ lyrics, ctx, currentTime: 10.1 }, 300, H);
    assert.ok(rowsDrawn(ctx) <= 3, `expected <=3 rows, got ${rowsDrawn(ctx)}`);
    assert.ok(ctx.calls.length < 40, 'must not draw the entire blob');
    assert.equal(ctx.calls[0].text, 'word0', 'current segment starts the window');
});

test('pre-song preview appears within lookahead, not before', () => {
    const lyrics = [syl(10, 'one', true)];
    const draw = loadDrawLyrics({ upcomingLines: 2, lookaheadSec: 8 });

    const early = makeCtx();
    draw({ lyrics, ctx: early, currentTime: 0 }, 2000, H); // 10s out > 8s
    assert.equal(early.calls.length, 0);

    const near = makeCtx();
    draw({ lyrics, ctx: near, currentTime: 3 }, 2000, H); // 7s out <= 8s
    assert.deepEqual(near.calls.map(c => c.text), ['one']);
});

test('banner hides after the last line ends with nothing upcoming', () => {
    const lyrics = [syl(10, 'one', true)];
    const draw = loadDrawLyrics({ upcomingLines: 2, lookaheadSec: 8 });
    const ctx = makeCtx();
    draw({ lyrics, ctx, currentTime: 15 }, 2000, H); // ended at 10.4, +0.5 grace
    assert.equal(ctx.calls.length, 0);
});
