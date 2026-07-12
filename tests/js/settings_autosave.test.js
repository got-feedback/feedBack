// Verify the Settings-dropdown autosave path in static/js/settings.js:
// persistSetting() must funnel one-field POSTs through a single chain so
// they hit the server one at a time, in call order, and a failed save
// must not poison the chain for later saves.
//
// Same isolation strategy as loop_api.test.js — extract the relevant
// functions by brace-matching and run them in a vm sandbox with a
// controllable fetch stub.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// R3d: settings was carved out of app.js into its own module. Bodies unchanged — only the file
// moved. It went cleanly because the WRITERS came with it: _defaultArrangement was the one
// binding written from outside the cluster, by saveSettings and pinCurrentArrangementDefault,
// which are themselves settings functions. Widening the slice to include them left zero outside
// writes, so no state container was needed.
const APP_JS = path.join(__dirname, '..', '..', 'static', 'js', 'settings.js');

function extractFunction(src, signature) {
    const start = src.indexOf(signature);
    if (start === -1) throw new Error(`extractFunction: '${signature}' not found in settings.js`);
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

// Drain enough microtask hops for the promise chain (persistSetting →
// _settingSaveChain.then → _postSetting → await fetch → await resp.json)
// to settle. vm-sandbox promises share the host V8 microtask queue, so
// awaiting here advances them too.
async function flush() {
    for (let i = 0; i < 30; i++) await Promise.resolve();
}

function buildSandbox() {
    // Every fetch() call parks here as { body, resolve, reject } so the
    // test controls exactly when each request settles.
    const pending = [];
    const status = { textContent: '' };
    const sandbox = {
        pending,
        status,
        document: {
            getElementById: () => status,
        },
        fetch: (url, opts) => new Promise((resolve, reject) => {
            pending.push({ body: JSON.parse(opts.body), resolve, reject });
        }),
    };
    vm.createContext(sandbox);
    return sandbox;
}

function loadFunctions(sandbox, src) {
    const code = `
        var _settingSaveChain = Promise.resolve();
        ${extractFunction(src, 'function persistSetting(')}
        ${extractFunction(src, 'async function _postSetting(')}
        globalThis.__persistSetting = persistSetting;
    `;
    vm.runInContext(code, sandbox);
}

// Resolve a parked fetch as a successful /api/settings response.
function ok(entry, message = 'Settings saved') {
    entry.resolve({ json: async () => ({ message }) });
}

test('persistSetting sends one POST at a time, in call order', async () => {
    const src = fs.readFileSync(APP_JS, 'utf8');
    const sandbox = buildSandbox();
    loadFunctions(sandbox, src);

    sandbox.__persistSetting('default_arrangement', 'Lead');
    sandbox.__persistSetting('demucs_server_url', 'http://example:7865');
    await flush();

    // The second POST must not be in flight until the first resolves.
    assert.equal(sandbox.pending.length, 1, 'only the first POST should be in flight');
    assert.deepEqual(sandbox.pending[0].body, { default_arrangement: 'Lead' });

    ok(sandbox.pending[0]);
    await flush();

    assert.equal(sandbox.pending.length, 2, 'second POST runs after the first settles');
    assert.deepEqual(sandbox.pending[1].body, { demucs_server_url: 'http://example:7865' });

    ok(sandbox.pending[1]);
    await flush();
});

test('a failed save does not block later saves on the chain', async () => {
    const src = fs.readFileSync(APP_JS, 'utf8');
    const sandbox = buildSandbox();
    loadFunctions(sandbox, src);

    sandbox.__persistSetting('default_arrangement', 'Bass');
    sandbox.__persistSetting('demucs_server_url', 'http://example:9000');
    await flush();

    assert.equal(sandbox.pending.length, 1);
    // First request fails outright (network error).
    sandbox.pending[0].reject(new Error('network down'));
    await flush();

    assert.equal(sandbox.pending.length, 2, 'second save still proceeds after the first fails');
    assert.deepEqual(sandbox.pending[1].body, { demucs_server_url: 'http://example:9000' });
    assert.match(sandbox.status.textContent, /Save failed/, 'failure surfaces in the status line');

    ok(sandbox.pending[1]);
    await flush();
    assert.equal(sandbox.status.textContent, 'Settings saved', 'later save still reports success');
});
