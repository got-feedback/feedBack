// Verify the plugin-facing loop API: setLoop / clearLoop / getLoop on
// window.feedBack, the input validation in setLoop, and the
// loadSavedLoop refactor that funnels through setLoop.
//
// Same isolation strategy as loop_restart.test.js — extract relevant
// functions by brace-matching and run them in a vm sandbox.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const APP_JS = path.join(__dirname, '..', '..', 'static', 'app.js');

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
    const seekCalls = [];
    const sectionPracticeModeCalls = [];
    const transportEvents = [];
    const sandbox = {
        seekCalls,
        sectionPracticeModeCalls,
        transportEvents,
        // Mutable state (declared as `var` in eval prelude so it lives on
        // the sandbox global and the extracted functions can read/write).
        // The actual values are set below.

        // DOM stub: every getElementById returns the same stand-in object.
        // Writes to className/textContent/classList are absorbed silently;
        // we don't assert on them here (the runtime would catch a missing
        // element, the unit test cares about loop bookkeeping).
        document: {
            getElementById: () => ({
                className: '',
                textContent: '',
                value: '',
                // _syncSavedLoopSelection iterates over <select>.options.
                // An empty option list is fine for these unit tests; the
                // sync becomes a no-op (no matching option found).
                options: [],
                classList: { add() {}, remove() {}, toggle() {} },
            }),
        },
        // _audioSeek spy — records every call so tests can assert seek
        // happened with the right target.
        // _audioSeek now resolves to { completed, from, to }; the
        // stub mimics a successful seek that lands exactly on s so
        // setLoop's off-target check passes.
        _audioSeek: (s, reason) => {
            seekCalls.push({ s, reason: reason ?? null });
            return Promise.resolve({ completed: true, from: 0, to: s });
        },
        _audioTime: () => 0,
        // updateLoopUI references formatTime for the label; we don't
        // assert on the label text in these tests, so a stub is enough.
        formatTime: (s) => String(s),
        window: {
            feedBack: {
                playback: {
                    transportEvent: (...args) => transportEvents.push(args),
                },
            },
        },
    };
    vm.createContext(sandbox);
    return sandbox;
}

function loadFunctions(sandbox, src) {
    // Pull just the loop helpers — clearLoop, setLoop, updateLoopUI
    // (called by setLoop), and the loop state vars.
    const code = `
        var loopA = null;
        var loopB = null;
        var _loopMutationGen = 0;
        var _sectionPracticeSelected = -1;
        var _sectionPracticeWholeSection = false;
        var _sectionPracticeSavedPartIndex = 0;
        function _setSectionPracticeMode(on, opts) {
            sectionPracticeModeCalls.push({ on, opts: opts || {} });
        }
        function _updateSectionPracticeHighlight(ct) {}
        ${extractFunction(src, 'function clearLoop(')}
        ${extractFunction(src, 'function _syncSavedLoopSelection()')}
        ${extractFunction(src, 'async function setLoop(')}
        ${extractFunction(src, 'function updateLoopUI()')}
        // Expose for the test runner.
        globalThis.__setLoop = setLoop;
        globalThis.__clearLoop = clearLoop;
        globalThis.__getLoop = () => ({ loopA, loopB });
    `;
    vm.runInContext(code, sandbox);
}

test('setLoop mutates loopA/loopB and seeks to A', async () => {
    const src = fs.readFileSync(APP_JS, 'utf8');
    const sandbox = buildSandbox();
    loadFunctions(sandbox, src);

    const result = await sandbox.__setLoop(5.5, 12.25);
    assert.equal(result, true, 'successful seek must resolve to true (plugin contract)');
    const { loopA, loopB } = sandbox.__getLoop();
    assert.equal(loopA, 5.5);
    assert.equal(loopB, 12.25);
    assert.equal(sandbox.seekCalls.length, 1);
    assert.equal(sandbox.seekCalls[0].s, 5.5);
});

test('setLoop returns false and leaves loopA/loopB untouched on cancelled seek', async () => {
    // Plugin-facing contract: cancelled seek (teardown gen bump) returns
    // false; the loop is NOT armed.
    const src = fs.readFileSync(APP_JS, 'utf8');
    const sandbox = buildSandbox();
    sandbox._audioSeek = () => Promise.resolve({ completed: false, from: NaN, to: NaN });
    loadFunctions(sandbox, src);

    const before = sandbox.__getLoop();
    const result = await sandbox.__setLoop(5, 10);

    assert.equal(result, false, 'cancelled seek must resolve to false');
    const after = sandbox.__getLoop();
    assert.equal(after.loopA, before.loopA, 'loopA must not be committed on cancel');
    assert.equal(after.loopB, before.loopB, 'loopB must not be committed on cancel');
});

test('setLoop returns false and leaves loopA/loopB untouched on off-target landing', async () => {
    // JUCE rollback / HTML5 clamp: completed:true but to drifts > 50ms
    // from the requested a. The loop is NOT armed.
    const src = fs.readFileSync(APP_JS, 'utf8');
    const sandbox = buildSandbox();
    sandbox._audioSeek = (s) => Promise.resolve({ completed: true, from: 0, to: s + 0.5 });
    loadFunctions(sandbox, src);

    const before = sandbox.__getLoop();
    const result = await sandbox.__setLoop(5, 10);

    assert.equal(result, false, 'off-target seek must resolve to false');
    const after = sandbox.__getLoop();
    assert.equal(after.loopA, before.loopA, 'loopA must not be committed on off-target');
    assert.equal(after.loopB, before.loopB, 'loopB must not be committed on off-target');
});

test('setLoop coerces string inputs (parseFloat-style)', async () => {
    // loadSavedLoop passes parseFloat(dataset.start) — but the dataset
    // values may already be strings. Number() coercion in setLoop must
    // accept finite numeric strings.
    const src = fs.readFileSync(APP_JS, 'utf8');
    const sandbox = buildSandbox();
    loadFunctions(sandbox, src);

    await sandbox.__setLoop('3.0', '7.0');
    const { loopA, loopB } = sandbox.__getLoop();
    assert.equal(loopA, 3);
    assert.equal(loopB, 7);
});

test('setLoop rejects non-finite inputs', async () => {
    const src = fs.readFileSync(APP_JS, 'utf8');
    const sandbox = buildSandbox();
    loadFunctions(sandbox, src);

    await assert.rejects(() => sandbox.__setLoop(NaN, 5), /finite a and b/);
    await assert.rejects(() => sandbox.__setLoop(1, Infinity), /finite a and b/);
    await assert.rejects(() => sandbox.__setLoop('abc', 5), /finite a and b/);
});

test('setLoop rejects b <= a', async () => {
    const src = fs.readFileSync(APP_JS, 'utf8');
    const sandbox = buildSandbox();
    loadFunctions(sandbox, src);

    await assert.rejects(() => sandbox.__setLoop(10, 10), /b > a/);
    await assert.rejects(() => sandbox.__setLoop(10, 5), /b > a/);
});

test('clearLoop resets loopA/loopB to null', async () => {
    const src = fs.readFileSync(APP_JS, 'utf8');
    const sandbox = buildSandbox();
    loadFunctions(sandbox, src);

    await sandbox.__setLoop(5, 10);
    sandbox.__clearLoop();
    const { loopA, loopB } = sandbox.__getLoop();
    assert.equal(loopA, null);
    assert.equal(loopB, null);
    assert.equal(sandbox.sectionPracticeModeCalls.length, 1);
    assert.equal(sandbox.sectionPracticeModeCalls[0].on, false);
    // Field-wise: vm-context objects break deepStrictEqual across realms.
    assert.equal(sandbox.sectionPracticeModeCalls[0].opts.skipClearLoop, true);
});

test('loop helpers emit transport snapshots by default and can suppress adapter echoes', async () => {
    const src = fs.readFileSync(APP_JS, 'utf8');
    const sandbox = buildSandbox();
    loadFunctions(sandbox, src);

    await sandbox.__setLoop(5, 10);
    sandbox.__clearLoop();

    assert.equal(sandbox.transportEvents.length, 2);
    assert.equal(sandbox.transportEvents[0][0], 'loop-set');
    assert.equal(JSON.stringify(sandbox.transportEvents[0][1].loop), JSON.stringify({ startTime: 5, endTime: 10, enabled: true, state: 'active' }));
    assert.equal(sandbox.transportEvents[1][0], 'loop-cleared');
    assert.equal(JSON.stringify(sandbox.transportEvents[1][1].loop), JSON.stringify({ enabled: false, state: 'inactive' }));

    sandbox.transportEvents.length = 0;
    await sandbox.__setLoop(7, 11, { emitTransportEvent: false });
    sandbox.__clearLoop({ emitTransportEvent: false });
    assert.equal(sandbox.transportEvents.length, 0);
});

test('window.feedBack API surface declares setLoop/clearLoop/getLoop', () => {
    // Source-level assertion: the plugin-facing namespace must expose
    // these three methods. Catches a future contributor moving them or
    // renaming silently.
    const src = fs.readFileSync(APP_JS, 'utf8');
    // Find the feedBack Object.assign block and check method presence.
    const m = src.match(/window\.feedBack\s*=\s*Object\.assign\(_feedBackBus,\s*\{([\s\S]*?)\}\);\s*if \(_feedBackExisting/);
    assert.ok(m, 'feedBack Object.assign block not found');
    const block = m[1];
    assert.match(block, /setLoop\s*\(/, 'setLoop method missing from feedBack API');
    assert.match(block, /clearLoop\s*\(/, 'clearLoop method missing from feedBack API');
    assert.match(block, /getLoop\s*\(/, 'getLoop method missing from feedBack API');
});

test('loadSavedLoop funnels through setLoop (no duplicated UI mutation)', () => {
    // After the refactor, the dropdown path must call setLoop rather than
    // re-implementing the loopA/loopB assignment. Catches a future drift
    // where someone "fixes" loadSavedLoop and forgets to keep setLoop in
    // sync.
    const src = fs.readFileSync(APP_JS, 'utf8');
    const fn = extractFunction(src, 'async function loadSavedLoop(');
    assert.match(fn, /await\s+setLoop\(/, 'loadSavedLoop must call setLoop');
    // The pre-refactor body assigned loopA = parseFloat(...) directly;
    // ensure that pattern is gone.
    assert.doesNotMatch(
        fn,
        /loopA\s*=\s*parseFloat/,
        'loadSavedLoop still has the pre-refactor loopA = parseFloat assignment',
    );
});
