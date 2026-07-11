// Guards the R0 module-migration loader change in static/js/plugin-loader.js: a migrated
// plugin (manifest scriptType:"module", surfaced as plugin.script_type) must be
// injected as <script type="module"> so its screen.js `import './src/main.js'`
// graph loads, while classic plugins stay untouched.
//
// The injection is a single line inside the large async loadPlugins() closure
// (it depends on loadedScripts, _removePluginScriptTags, and the
// _loadingPluginId completion window), so a faithful behavioural harness would
// need to stub the whole loader. Instead this asserts the *structural*
// contract in source — the guard exists, is gated (not unconditional), and sits
// inside the screen.js injection block before appendChild. The behavioural proof
// is the R0 end-to-end live-edit check (a real module plugin booting in-browser).

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const PLUGIN_LOADER_JS = path.join(__dirname, '..', '..', 'static', 'js', 'plugin-loader.js');
const src = fs.readFileSync(PLUGIN_LOADER_JS, 'utf8');

// Isolate the screen.js <script> injection block: from where its src is assigned to
// where the element is appended.
//
// Anchored on the ASSIGNMENT, not on the URL literal. The URL is built in
// _pluginScriptUrl() now (#879 — a rollback needs a fresh module URL), so the literal
// '/api/plugins/${plugin.id}/screen.js' appears FURTHER DOWN the file than the block
// that uses it, and slicing from it ran off the end of the injection block entirely.
const SRC_ASSIGN = 'script.src = _pluginScriptUrl(';
function injectionBlock() {
    const start = src.indexOf(SRC_ASSIGN);
    assert.ok(start !== -1, 'screen.js src assignment not found — loader moved?');
    const end = src.indexOf('document.body.appendChild(script)', start);
    assert.ok(end !== -1, 'appendChild(script) not found after the src assignment');
    return src.slice(start, end);
}

test('module plugins are injected as <script type="module">', () => {
    const block = injectionBlock();
    assert.match(
        block,
        /if\s*\(\s*plugin\.script_type\s*===\s*['"]module['"]\s*\)\s*script\.type\s*=\s*['"]module['"]\s*;/,
        'expected a guarded `script.type = "module"` keyed on plugin.script_type === "module"',
    );
});

test('the module type is gated, never set unconditionally', () => {
    const block = injectionBlock();
    // Every assignment of script.type in the block must be on the same line as
    // the plugin.script_type guard (i.e. no bare `script.type = 'module'`).
    for (const line of block.split('\n')) {
        if (/script\.type\s*=/.test(line)) {
            assert.match(line, /plugin\.script_type\s*===\s*['"]module['"]/,
                `unguarded script.type assignment: ${line.trim()}`);
        }
    }
});

test('the module guard sits before appendChild, after the src assignment', () => {
    const guardAt = src.indexOf('script.type = \'module\'');
    const srcAt = src.indexOf(SRC_ASSIGN);
    const appendAt = src.indexOf('document.body.appendChild(script)', srcAt);
    assert.ok(guardAt > srcAt && guardAt < appendAt,
        'the module guard must live inside the screen.js injection block');
});
