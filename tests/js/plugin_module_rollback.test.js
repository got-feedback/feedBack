// #879 — a plugin ROLLBACK must actually re-evaluate a module plugin.
//
// ES modules are evaluated once per URL per document. Re-inserting a
// <script type="module"> whose src the module map has already seen fires `load` but
// does NOT re-run the body — so rolling back to a version already evaluated this
// session left the OLD module live while the loader recorded success.
//
// The fix puts a generation token in the PATH (/api/plugins/x/g/7/screen.js), not the
// query, because a relative specifier resolves against the base URL with the query
// DROPPED — so './src/main.js' would otherwise keep resolving to the same cached URL
// and the plugin's actual code would never re-run.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const { extractFunction } = require('./test_utils');
const LOADER = path.join(__dirname, '..', '..', 'static', 'js', 'plugin-loader.js');

function makeUrlBuilder() {
    const src = fs.readFileSync(LOADER, 'utf8');
    const sandbox = { _evaluatedModules: new Set(), _moduleReloadSeq: 0 };
    vm.createContext(sandbox);
    vm.runInContext(`
        ${extractFunction(src, 'function _pluginScriptUrl(')}
        globalThis.url = _pluginScriptUrl;
    `, sandbox);
    return sandbox.url;
}

const MOD = { id: 'editor', script_type: 'module' };
const CLASSIC = { id: 'legacy', script_type: 'classic' };

test('a module plugin first load uses the stable ?v= URL (ETag/304 stays intact)', () => {
    const url = makeUrlBuilder();
    assert.equal(url(MOD, '1.0.0', '?v=1.0.0'), '/api/plugins/editor/screen.js?v=1.0.0');
});

// An UPGRADE has to bust the graph too, and this is the part #879 got wrong. It says
// "upgrades are fine — a new version yields a new URL". True of screen.js; FALSE of the
// plugin. Driving a real browser through install -> upgrade -> rollback and counting
// evaluations of src/main.js gives ONE: the upgrade re-runs the one-line screen.js shim
// at its new ?v= URL, the shim imports './src/main.js', that resolves to the SAME url,
// and the module map hands back the already-evaluated old module. So the key here is the
// plugin ID, not id@version — every re-load of a module plugin needs a fresh path.
test('an UPGRADE also gets a fresh /g/<n>/ path — a new ?v= does NOT reach the graph', () => {
    const url = makeUrlBuilder();
    url(MOD, '1.0.0', '?v=1.0.0');
    assert.equal(url(MOD, '1.1.0', '?v=1.1.0'), '/api/plugins/editor/g/1/screen.js?v=1.1.0');
});

test('a ROLLBACK to an already-evaluated version gets a fresh /g/<n>/ PATH', () => {
    const url = makeUrlBuilder();
    url(MOD, '1.0.0', '?v=1.0.0');                        // installed
    url(MOD, '1.1.0', '?v=1.1.0');                        // upgraded   -> /g/1/
    const back = url(MOD, '1.0.0', '?v=1.0.0');           // rolled back -> /g/2/
    assert.equal(back, '/api/plugins/editor/g/2/screen.js?v=1.0.0');

    // The token must be in the PATH so a relative import INHERITS it — the whole point.
    // A query token is dropped by URL resolution and never reaches src/main.js.
    const resolved = new URL('./src/main.js', `http://h${back}`).pathname;
    assert.equal(resolved, '/api/plugins/editor/g/2/src/main.js',
        'the token must reach the module GRAPH, not just the entry point');
});

test('every re-load gets a distinct URL (no reuse across a bounce)', () => {
    const url = makeUrlBuilder();
    url(MOD, '1.0.0', '?v=1.0.0');
    const seen = new Set();
    for (const v of ['1.1.0', '1.0.0', '1.1.0', '1.0.0']) seen.add(url(MOD, v, `?v=${v}`));
    assert.equal(seen.size, 4, 'each re-load must be a URL the module map has never seen');
});

test('classic-script plugins are untouched — they always re-run on re-insert', () => {
    const url = makeUrlBuilder();
    const first = url(CLASSIC, '1.0.0', '?v=1.0.0');
    url(CLASSIC, '1.1.0', '?v=1.1.0');
    const back = url(CLASSIC, '1.0.0', '?v=1.0.0');
    assert.equal(first, '/api/plugins/legacy/screen.js?v=1.0.0');
    assert.equal(back, first, 'a classic script needs no cache-busting and must not get a /g/ path');
});
