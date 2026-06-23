// Verify song:play / song:pause / song:ended carry the enriched
// payload { time, audioT, chartT, perfNow } so plugins can anchor
// their own clocks without a follow-up highway.getTime() call.
//
// Same isolation strategy as the other plugin-API tests — extract
// `_songEventPayload` and `_audioTime` from app.js and run them in a
// vm sandbox.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const APP_JS = path.join(__dirname, '..', '..', 'static', 'app.js');

function extractFunction(src, signature) {
    const start = src.indexOf(signature);
    if (start === -1) throw new Error(`extractFunction: '${signature}' not found in app.js`);
    const openBrace = src.indexOf('{', start);
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

function buildSandbox({ juceMode = false, audioT = 12.5, chartT = 11.8, juceT } = {}) {
    // When juceT is omitted in JUCE mode, derive a value distinct from
    // audioT so the JUCE-mode test actually proves _audioTime() reads
    // from jucePlayer rather than the html5 audio element.
    const jt = juceT !== undefined ? juceT : (juceMode ? audioT + 100 : audioT);
    const sandbox = {
        audio: { currentTime: audioT },
        jucePlayer: { currentTime: jt, duration: 200 },
        window: { _juceMode: juceMode },
        highway: {
            getTime: () => chartT,
        },
        performance: { now: () => 1000.123 },
    };
    vm.createContext(sandbox);
    return sandbox;
}

function loadFunctions(sandbox, src) {
    const code = `
        ${extractFunction(src, 'function _audioTime()')}
        ${extractFunction(src, 'function _audioDuration()')}
        ${extractFunction(src, 'function _songEventPayload()')}
        globalThis.__payload = _songEventPayload;
    `;
    vm.runInContext(code, sandbox);
}

test('_songEventPayload returns { time, audioT, chartT, perfNow } (HTML5)', () => {
    const src = fs.readFileSync(APP_JS, 'utf8');
    const sandbox = buildSandbox({ juceMode: false, audioT: 12.5, chartT: 11.8 });
    loadFunctions(sandbox, src);
    const p = sandbox.__payload();
    assert.equal(p.audioT, 12.5);
    assert.equal(p.chartT, 11.8);
    assert.equal(p.perfNow, 1000.123);
    assert.equal(p.time, 12.5, 'time must be an alias for audioT');
    assert.equal(Object.keys(p).length, 4);
});

test('_songEventPayload reads from JUCE in juce mode', () => {
    const src = fs.readFileSync(APP_JS, 'utf8');
    // audioT (audio.currentTime) and juceT (jucePlayer.currentTime) are
    // distinct so the assertion proves we read from JUCE, not from the
    // html5 audio element.
    const sandbox = buildSandbox({ juceMode: true, audioT: 5, juceT: 42, chartT: 41 });
    loadFunctions(sandbox, src);
    const p = sandbox.__payload();
    assert.equal(p.audioT, 42, 'JUCE mode must read jucePlayer.currentTime, not audio.currentTime');
    assert.equal(p.time, 42);
    assert.equal(p.chartT, 41);
});

test('time and audioT are the same number (not duplicated computation)', () => {
    // Cache invariant: audioT is read once and assigned to both fields.
    // If the implementation read _audioTime() twice and the underlying
    // value drifted between reads, time !== audioT. Guard the cache.
    const src = fs.readFileSync(APP_JS, 'utf8');
    let reads = 0;
    const sandbox = {
        audio: { get currentTime() { reads++; return 5 + reads * 0.001; } },
        jucePlayer: { currentTime: 0 },
        window: { _juceMode: false },
        highway: { getTime: () => 4.9 },
        performance: { now: () => 1000 },
    };
    vm.createContext(sandbox);
    loadFunctions(sandbox, src);
    const p = sandbox.__payload();
    assert.equal(p.time, p.audioT, 'time must equal audioT');
});

test('every song:play/pause/ended emit uses _songEventPayload', () => {
    // Source-level guard: catch a future contributor adding a new emit
    // site with a literal { time: x } payload — that would silently drop
    // chartT/perfNow and break plugins that depend on the enriched shape.
    // Accepts either a direct _songEventPayload() call or a captured
    // `payload` var (used by JUCE teardown sites that snapshot before
    // jucePlayer.stop() resets _pos to 0).
    const src = fs.readFileSync(APP_JS, 'utf8');
    const lines = src.split('\n');
    // Accept aliased calls like `sm.emit(...)` (the JUCE shim caches
    // window.feedBack in `sm`) — not just literal `window.feedBack.emit`.
    const emitRe = /(?:window\.feedBack|\w+)\.emit\(\s*['"]song:(play|pause|ended)['"]/;
    const okRe = /_songEventPayload\(\)|,\s*payload\s*\)/;
    const offending = [];
    for (const line of lines) {
        if (!emitRe.test(line)) continue;
        if (!okRe.test(line)) {
            offending.push(line.trim());
        }
    }
    assert.equal(
        offending.length,
        0,
        `song:* emits not using _songEventPayload():\n${offending.join('\n')}`,
    );
});

test('there are at least 8 song:* emit sites threaded through the helper', () => {
    // Sanity-check that the helper actually got wired everywhere. If the
    // count drops, someone removed an emit (regression) or refactored an
    // event away (intentional — this test then needs updating).
    const src = fs.readFileSync(APP_JS, 'utf8');
    const matches = src.match(/(?:window\.feedBack|\w+)\.emit\(\s*['"]song:(play|pause|ended)['"][^)]*\)/g) || [];
    assert.ok(
        matches.length >= 8,
        `expected ≥8 song:* emits, found ${matches.length}`,
    );
    // Same dual-form acceptance as the per-line check: either a direct
    // _songEventPayload() call or a captured `payload` var.
    for (const m of matches) {
        assert.match(m, /_songEventPayload\(\)|,\s*payload\s*\)/, `emit not using helper: ${m}`);
    }
});
