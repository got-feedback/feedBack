// Verify `countInBeats(startT)` in static/js/count-in.js sizes the count-in
// to the song's own bar rather than a hardcoded four clicks.
//
// Two behaviours are under test:
//   1. Meter — a 3/4 song gets three clicks, not four.
//   2. Pickup (anacrusis) — a first bar shorter than the meter shortens the
//      count so the pickup enters on its real beat (1-beat pickup in 4/4 →
//      "1 2 3", music on 4). A full four there puts the pickup where the
//      downbeat belongs and the player comes in a beat late all song.
//
// The meter is read from the song_timeline beats (`window.highway.getBeats()`,
// `measure >= 0` on downbeats) because that is the only meter data the
// frontend holds — the `time_signatures` map is streamed to plugins, not
// stored here.
//
// Same extraction approach as loop_restart.test.js: pull the function source
// out of the module and evaluate it in a vm sandbox with a stubbed highway,
// rather than loading the ESM module and its DOM-coupled imports.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const COUNT_IN_JS = path.join(__dirname, '..', '..', 'static', 'js', 'count-in.js');

// Brace-match the function body out of the source. Brittle by design:
// a rename fails loudly here rather than silently skipping coverage.
function extractFunction(src, signature) {
    const start = src.indexOf(signature);
    if (start === -1) throw new Error(`extractFunction: '${signature}' not found`);
    const openBrace = src.indexOf('{', start + signature.length);
    let depth = 1;
    let i = openBrace + 1;
    while (i < src.length && depth > 0) {
        const ch = src[i];
        if (ch === '{') depth++;
        else if (ch === '}') depth--;
        i++;
    }
    if (depth !== 0) throw new Error(`extractFunction: unbalanced braces after '${signature}'`);
    return src.slice(start, i);
}

const src = fs.readFileSync(COUNT_IN_JS, 'utf8');
// Drop the `export` keyword so the body evaluates as a plain declaration.
const fnSrc = extractFunction(src, 'export function countInBeats')
    .replace(/^export\s+/, '');

// `beats` is the song_timeline shape: {time, measure}, measure >= 0 only on
// downbeats. `getBeats` may also be absent entirely (pre-chart / minigame).
function load(beats) {
    const sandbox = {
        window: beats === undefined
            ? { highway: {} }
            : { highway: { getBeats: () => beats } },
    };
    vm.createContext(sandbox);
    vm.runInContext(`${fnSrc}; globalThis.__fn = countInBeats;`, sandbox);
    return sandbox.__fn;
}

// Build a beats array: `bars` full bars of `beatsPerBar`, optionally preceded
// by a pickup of `pickup` beats. One beat per 0.5 s throughout.
function makeBeats({ beatsPerBar = 4, bars = 4, pickup = 0 } = {}) {
    const out = [];
    let t = 0;
    let measure = 0;
    if (pickup > 0) {
        for (let i = 0; i < pickup; i++) {
            out.push({ time: t, measure: i === 0 ? measure : -1 });
            t += 0.5;
        }
        measure++;
    }
    for (let b = 0; b < bars; b++) {
        for (let i = 0; i < beatsPerBar; i++) {
            out.push({ time: t, measure: i === 0 ? measure : -1 });
            t += 0.5;
        }
        measure++;
    }
    return out;
}

// ── Meter ────────────────────────────────────────────────────────────────

test('countInBeats counts a full bar in 4/4', () => {
    const countInBeats = load(makeBeats({ beatsPerBar: 4 }));
    assert.equal(countInBeats(0), 4);
});

test('countInBeats counts three in 3/4 (was hardcoded four)', () => {
    const countInBeats = load(makeBeats({ beatsPerBar: 3 }));
    assert.equal(countInBeats(0), 3);
});

test('countInBeats counts six in 6/8', () => {
    const countInBeats = load(makeBeats({ beatsPerBar: 6 }));
    assert.equal(countInBeats(0), 6);
});

// ── Pickup (anacrusis) ───────────────────────────────────────────────────

test('countInBeats shortens the count by a 1-beat pickup in 4/4', () => {
    const countInBeats = load(makeBeats({ beatsPerBar: 4, pickup: 1 }));
    assert.equal(countInBeats(0), 3, 'counts 1-2-3 so the pickup lands on 4');
});

test('countInBeats shortens the count by a 2-beat pickup in 4/4', () => {
    const countInBeats = load(makeBeats({ beatsPerBar: 4, pickup: 2 }));
    assert.equal(countInBeats(0), 2);
});

test('countInBeats handles a pickup in 3/4', () => {
    const countInBeats = load(makeBeats({ beatsPerBar: 3, pickup: 1 }));
    assert.equal(countInBeats(0), 2);
});

test('countInBeats finds the meter when the song is only a pickup plus one bar', () => {
    // Gap counts tie (one 1-beat gap, one 4-beat gap) — the longer bar is the
    // meter, so this must be 3 rather than 0.
    const countInBeats = load(makeBeats({ beatsPerBar: 4, bars: 1, pickup: 1 }));
    assert.equal(countInBeats(0), 3);
});

// ── Resuming somewhere other than the song top ───────────────────────────

test('countInBeats counts a full bar at a mid-song downbeat, pickup notwithstanding', () => {
    const beats = makeBeats({ beatsPerBar: 4, pickup: 1 });
    const countInBeats = load(beats);
    // Index 5 is the downbeat of the second full bar (1 pickup + 4 beats).
    assert.equal(beats[5].measure >= 0, true, 'fixture sanity: index 5 is a downbeat');
    assert.equal(countInBeats(beats[5].time), 4);
});

test('countInBeats counts a mid-song meter change by that bar, not as a pickup', () => {
    // 4/4 throughout, except one 3-beat bar at index 8. Treating a short bar
    // anywhere but the song's first as a pickup would count a single click.
    const beats = [];
    let t = 0;
    const push = (n, measure) => {
        for (let i = 0; i < n; i++) { beats.push({ time: t, measure: i === 0 ? measure : -1 }); t += 0.5; }
    };
    push(4, 0); push(4, 1); push(3, 2); push(4, 3); push(4, 4);
    const countInBeats = load(beats);
    assert.equal(beats[8].measure, 2, 'fixture sanity: index 8 opens the 3-beat bar');
    assert.equal(countInBeats(beats[8].time), 3, 'counts the short bar itself');
    assert.equal(countInBeats(0), 4, 'the 4/4 opening is unaffected');
});

test('countInBeats counts a full bar when resuming mid-bar', () => {
    const beats = makeBeats({ beatsPerBar: 4 });
    const countInBeats = load(beats);
    assert.equal(countInBeats(beats[2].time), 4);   // third beat of bar 1
});

test('countInBeats tolerates a start time slightly past the beat (seek slop)', () => {
    const countInBeats = load(makeBeats({ beatsPerBar: 4, pickup: 1 }));
    assert.equal(countInBeats(0.02), 3);
});

// ── Fallbacks ────────────────────────────────────────────────────────────

test('countInBeats falls back to four without a beats array', () => {
    assert.equal(load(undefined)(0), 4, 'no getBeats (pre-chart / minigame)');
    assert.equal(load([])(0), 4, 'empty beats');
    assert.equal(load(null)(0), 4, 'null beats');
});

test('countInBeats falls back to four when beats carry no downbeat labels', () => {
    const beats = [0, 0.5, 1.0, 1.5, 2.0].map(time => ({ time, measure: -1 }));
    assert.equal(load(beats)(0), 4);
});

test('countInBeats falls back to four with only one downbeat', () => {
    const beats = [
        { time: 0, measure: 0 },
        { time: 0.5, measure: -1 },
        { time: 1.0, measure: -1 },
    ];
    assert.equal(load(beats)(0), 4);
});

test('countInBeats counts a full bar past the last beat', () => {
    const beats = makeBeats({ beatsPerBar: 3 });
    assert.equal(load(beats)(9999), 3);
});
