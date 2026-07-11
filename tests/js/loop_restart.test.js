// Verify static/app.js emits `loop:restart` exactly once when the A-B
// loop wraps, with the documented payload shape. Plugins (notedetect's
// drill-mode score capture) consume this contract.
//
// The test does not load the full app.js into a DOM — it extracts just
// the `startCountIn` function source via brace-matching and evaluates it
// in a vm sandbox with stubbed dependencies. This trades coverage of the
// surrounding script for isolation: a failure here points at the wrap
// path, not at unrelated DOM coupling.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const APP_JS = path.join(__dirname, '..', '..', 'static', 'app.js');

// Pull a function body by declaration prefix (e.g. `async function startCountIn`)
// and brace-matching to the closing brace. Skips an optional `( ... )` param
// list so `startCountIn(opts = {})` and `startCountIn()` both match the same
// prefix. Brittle by design: rename/restructure fails loudly, not silently.
function extractFunction(src, signature) {
    const start = src.indexOf(signature);
    if (start === -1) throw new Error(`extractFunction: '${signature}' not found in app.js`);
    let scan = start + signature.length;
    if (src[scan] === '(') {
        let parenDepth = 1;
        scan++;
        while (scan < src.length && parenDepth > 0) {
            const ch = src[scan];
            if (ch === '(') parenDepth++;
            else if (ch === ')') parenDepth--;
            scan++;
        }
    }
    const openBrace = src.indexOf('{', scan);
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

function buildSandbox() {
    const emitCalls = [];
    const sandbox = {
        // Globals the function reads/writes via closure. Declared as `var`
        // in the eval prelude so they attach to the sandbox.
        loopA: 10,
        loopB: 20,
        _countingIn: false,
        // isPlaying / lastAudioTime moved onto the shared player-state container
        // (static/js/player-state.js) so a carved module can WRITE them — an imported
        // binding is read-only. Same values, same assertions, one indirection.
        S: { isPlaying: false, lastAudioTime: 0 },

        // Browser-ish globals.
        performance: { now: () => Date.now() },
        // requestAnimationFrame: skip to t >= 1 in one tick so the rewind
        // animation completes synchronously and we reach the `_audioSeek`
        // continuation immediately.
        requestAnimationFrame(fn) {
            // Fire with `now` far enough in the future that
            // (now - rewindStart) / rewindDuration >= 1.
            queueMicrotask(() => fn(Date.now() + 10_000));
        },
        // setTimeout: swallow. beginCount schedules ticks via setTimeout;
        // we don't need them to fire — the emit happens before beginCount.
        setTimeout: () => 0,

        // Stubbed feedBack DOM dependencies.
        audio: { pause() {} },
        jucePlayer: { pause: () => Promise.resolve(), play: () => Promise.resolve(true) },
        highway: { setTime() {}, getBPM: () => 120 },

        // Stubbed app.js helpers.
        // Resolve with the real shape `{ completed, from, to }` so
        // startCountIn's loop-wrap callback sees completed=true and uses
        // r.to for highway.setTime / lastAudioTime.
        _audioSeek: (s) => Promise.resolve({ completed: true, from: 20, to: s }),
        playClick: () => {},
        showCountOverlay: () => {},
        hideCountOverlay: () => {},

        // Stubbed DOM access. Anything querying for a button just gets a
        // permissive object that ignores writes.
        document: {
            getElementById: () => ({
                textContent: '',
                className: '',
                classList: { add() {}, remove() {}, toggle() {} },
            }),
        },

        // Spy: records every emit call so the test can assert.
        window: {
            feedBack: {
                emit(event, detail) { emitCalls.push({ event, detail }); },
                isPlaying: false,
            },
            _juceMode: false,
        },

        // Capture for assertions.
        __emitCalls: emitCalls,
        queueMicrotask,
    };
    vm.createContext(sandbox);
    return sandbox;
}

test('loop:restart fires once when wrap path runs', async () => {
    const src = fs.readFileSync(APP_JS, 'utf8');
    const startCountInSrc = extractFunction(src, 'async function startCountIn');

    // Sanity check: the change under test is present at all. Catches
    // accidental revert before we even run the behavior assertion.
    assert.match(
        startCountInSrc,
        /window\.feedBack\.emit\(\s*['"]loop:restart['"]/,
        'startCountIn is missing the loop:restart emit',
    );

    const sandbox = buildSandbox();
    // Re-declare the closure-scoped lets as vars so the function can read
    // them from the sandbox global, then define the function in-context.
    const prelude = `
        var loopA = ${sandbox.loopA};
        var loopB = ${sandbox.loopB};
        var _countingIn = false;
        var _countInGen = 0;
        var _countInTimer = null;
        var _countInRaf = 0;
        var S = { isPlaying: false, lastAudioTime: 0 };
        ${startCountInSrc}
        globalThis.__startCountIn = startCountIn;
    `;
    vm.runInContext(prelude, sandbox);

    await sandbox.__startCountIn();
    // Allow the queued requestAnimationFrame microtask + the _audioSeek
    // promise chain to settle. Two awaits is enough: rAF microtask -> rewind
    // completion -> _audioSeek().then() -> emit.
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));

    const restarts = sandbox.__emitCalls.filter((c) => c.event === 'loop:restart');
    assert.equal(restarts.length, 1, `expected 1 loop:restart emit, got ${restarts.length}`);
    // Field-wise assertion: deepStrictEqual fails across vm-context object
    // realms because Object.prototype identities differ even when contents
    // match. Compare values, not prototype graphs.
    const detail = restarts[0].detail;
    assert.equal(detail.loopA, 10);
    assert.equal(detail.loopB, 20);
    assert.equal(detail.time, 10);
    assert.equal(Object.keys(detail).length, 3, `unexpected extra keys in detail: ${Object.keys(detail)}`);
});

test('loop:restart aborts when seek lands far from loopA (JUCE rollback)', async () => {
    // Regression: if jucePlayer.seek rolls back (currentTime stays put),
    // _audioSeek resolves with completed:true but r.to !== loopA. The
    // wrap handler must abort instead of running beginCount on the wrong
    // position and emitting a misleading loop:restart.
    const src = fs.readFileSync(APP_JS, 'utf8');
    const startCountInSrc = extractFunction(src, 'async function startCountIn');

    const sandbox = buildSandbox();
    // Override _audioSeek to mimic JUCE rollback: completed but to=from,
    // far from the requested loopA (10).
    sandbox._audioSeek = (s) => Promise.resolve({ completed: true, from: 20, to: 20 });
    const prelude = `
        var loopA = ${sandbox.loopA};
        var loopB = ${sandbox.loopB};
        var _countingIn = false;
        var _countInGen = 0;
        var _countInTimer = null;
        var _countInRaf = 0;
        var S = { isPlaying: false, lastAudioTime: 0 };
        ${startCountInSrc}
        globalThis.__startCountIn = startCountIn;
        globalThis.__getCountingIn = () => _countingIn;
    `;
    vm.runInContext(prelude, sandbox);

    await sandbox.__startCountIn();
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));

    const restarts = sandbox.__emitCalls.filter((c) => c.event === 'loop:restart');
    assert.equal(restarts.length, 0, 'rollback must not emit loop:restart');
    assert.equal(sandbox.__getCountingIn(), false, '_countingIn must be cleared on abort');
});

test('count-in cancellation token bails delayed callbacks (rewindStep + tick)', () => {
    // Source-level assertion: the gen-capture pattern is in place so
    // teardown can interrupt an in-flight count-in. Behavioral simulation
    // of timer cancellation is out of scope for the static extractor; this
    // verifies the contract is wired into the source.
    const src = fs.readFileSync(APP_JS, 'utf8');
    const fn = extractFunction(src, 'async function startCountIn');
    // Captures gen at entry
    assert.match(fn, /const gen = _countInGen/, 'startCountIn must capture _countInGen at entry');
    // Each delayed callback bails on mismatch
    const guards = [...fn.matchAll(/if \(gen !== _countInGen\) return/g)];
    assert.ok(guards.length >= 4, `expected ≥4 gen-mismatch bails, found ${guards.length}`);
    // RAF and timer handles tracked so _cancelCountIn can cancel them
    assert.match(fn, /_countInRaf = requestAnimationFrame/, 'rewindStep must store its RAF handle in _countInRaf');
    assert.match(fn, /_countInTimer = setTimeout/, 'tick scheduling must store its timer in _countInTimer');
});

test('loop:restart fires after highway.setTime, before beginCount', () => {
    // Source-order assertion on the A-B wrap path only. Section-practice
    // `opts.immediate` also emits loop:restart but is a separate entry path;
    // the wrap handler lives inside the `_audioSeek(loopA, 'loop-wrap')` then.
    const src = fs.readFileSync(APP_JS, 'utf8');
    const fn = extractFunction(src, 'async function startCountIn');
    const wrapMarker = "_audioSeek(loopA, 'loop-wrap')";
    const wrapStart = fn.indexOf(wrapMarker);
    assert.ok(wrapStart !== -1, 'loop-wrap _audioSeek call not found in startCountIn');
    const wrapSlice = fn.slice(wrapStart);

    const setTimeMatches = [...wrapSlice.matchAll(/highway\.setTime\(\s*[^)]+\)/g)];
    const setTimeIdx = setTimeMatches.length
        ? wrapStart + setTimeMatches[setTimeMatches.length - 1].index
        : -1;
    const emitRel = wrapSlice.search(/window\.feedBack\.emit\(\s*['"]loop:restart['"]/);
    const emitIdx = emitRel === -1 ? -1 : wrapStart + emitRel;
    const afterEmit = emitIdx === -1 ? '' : fn.slice(emitIdx);
    const beginCallMatch = afterEmit.match(/(?<!function\s)\bbeginCount\s*\(/);
    const beginCallIdx = beginCallMatch ? emitIdx + beginCallMatch.index : -1;

    assert.ok(setTimeIdx !== -1, 'post-seek highway.setTime not found on wrap path');
    assert.ok(emitIdx !== -1, 'loop:restart emit not found on wrap path');
    assert.ok(beginCallIdx !== -1, 'beginCount() call not found after wrap emit');
    assert.ok(setTimeIdx < emitIdx, 'wrap emit must come after highway.setTime');
    assert.ok(emitIdx < beginCallIdx, 'wrap emit must come before beginCount()');
});
