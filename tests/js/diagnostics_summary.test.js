const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createWindow, ROOT } = require('./capabilities_test_harness');

function loadDiagnostics() {
    const window = createWindow();
    // diagnostics.js short-circuits if window.feedBack.diagnostics already
    // exists (idempotent guard); the harness stubs it, so clear it first.
    window.feedBack.diagnostics = undefined;
    window.navigator = { userAgent: 'test' };
    const context = vm.createContext(window);
    const source = fs.readFileSync(path.join(ROOT, 'static', 'diagnostics.js'), 'utf8');
    vm.runInContext(source, context, { filename: 'diagnostics.js' });
    return window;
}

test('summarizeRuntimeDomains counts actual UI contributions, not the {declared,legacy} wrapper keys', () => {
    const { summarizeRuntimeDomains } = loadDiagnostics().feedBack.diagnostics;
    const snapshot = {
        plugins: [
            {
                // Normalized backend shape: two declared regions (3 entries
                // total) + two legacy entries = 5, NOT 2 (the wrapper keys).
                ui_contributions: {
                    declared: {
                        'ui.navigation': [{ id: 'a' }, { id: 'b' }],
                        'settings': [{ id: 'c' }],
                    },
                    legacy: [
                        { region: 'ui.navigation', legacy_source: 'nav' },
                        { region: 'settings', legacy_source: 'settings' },
                    ],
                },
                runtime_domains: { library: {}, playback: {} },
            },
            {
                ui_contributions: { declared: {}, legacy: [] },
                runtime_domains: {},
            },
        ],
    };
    const summary = summarizeRuntimeDomains(snapshot);
    assert.equal(summary.plugin_count, 2);
    assert.equal(summary.ui_contribution_count, 5);
    assert.equal(summary.runtime_domain_count, 2);
});

test('summarizeRuntimeDomains tolerates a flat region→contributions map', () => {
    const { summarizeRuntimeDomains } = loadDiagnostics().feedBack.diagnostics;
    const summary = summarizeRuntimeDomains({
        plugins: [{ ui_contributions: { 'ui.navigation': [{ id: 'a' }, { id: 'b' }] } }],
    });
    assert.equal(summary.ui_contribution_count, 2);
});

test('summarizeRuntimeDomains counts only array region values (malformed values are ignored)', () => {
    const { summarizeRuntimeDomains } = loadDiagnostics().feedBack.diagnostics;
    // Non-array region values (a stray object/string from a malformed payload)
    // must not inflate the count — only the two real array entries count.
    const declaredSummary = summarizeRuntimeDomains({
        plugins: [{ ui_contributions: { declared: { good: [{ id: 'a' }, { id: 'b' }], bad: { id: 'x' }, alsoBad: 'nope' }, legacy: [] } }],
    });
    assert.equal(declaredSummary.ui_contribution_count, 2);
    const flatSummary = summarizeRuntimeDomains({
        plugins: [{ ui_contributions: { good: [{ id: 'a' }], bad: { id: 'x' } } }],
    });
    assert.equal(flatSummary.ui_contribution_count, 1);
});
