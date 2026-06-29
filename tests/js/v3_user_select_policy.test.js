// Guards the v3 text-selection policy (static/v3/v3.css + static/v3/index.html):
// the UI defaults to non-selectable so accidental chrome selection can't look
// broken, while form fields, plugin screens, and core content opt back in. A
// future global reset clobbering the rule — or the content containers losing
// their .fb-selectable opt-in — should fail here.
//
// Source-level only — same strategy as the other tests/js/ files.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..', '..');
// Strip block comments so the policy's own explanatory prose (which quotes the
// `* { user-select:none }` anti-pattern as a warning) can't trip the assertions.
const css = fs.readFileSync(path.join(root, 'static', 'v3', 'v3.css'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '');
const html = fs.readFileSync(path.join(root, 'static', 'v3', 'index.html'), 'utf8');

test('v3 defaults to non-selectable on html (not a universal `*` rule)', () => {
    assert.match(css, /html\s*\{[^}]*user-select:\s*none/,
        'html must default user-select: none');
    // The `* { user-select: none }` anti-pattern breaks input carets / IME — must not exist.
    assert.doesNotMatch(css, /\*\s*\{[^}]*user-select:\s*none/,
        'must NOT use a universal `*` user-select:none rule');
});

test('form fields are always re-enabled (caret / IME safe)', () => {
    assert.match(
        css,
        /input,\s*textarea,\s*select[\s\S]*?contenteditable[\s\S]*?user-select:\s*text/,
        'input/textarea/select/[contenteditable] must be re-enabled to user-select: text',
    );
});

test('plugin screen subtree stays selectable by inheritance (no `*`, respects plugin opt-outs)', () => {
    assert.match(
        css,
        /\.screen\[id\^="plugin-"\]\s*\{[^}]*user-select:\s*text/,
        'plugin screens must be re-enabled so plugin content is not silently un-copyable',
    );
    assert.doesNotMatch(
        css,
        /\.screen\[id\^="plugin-"\]\s*\*/,
        'the plugin carve must NOT use `*` (would override a plugin\'s own non-select chrome)',
    );
});

// The rule that re-enables selection on copyable content. Find the single
// declaration block whose body sets `user-select: text`, then assert each
// required selector is one of its selectors — order/format independent.
const selectableRule = (css.match(/([^{}]*)\{[^}]*user-select:\s*text[^}]*\}/g) || [])
    .join('\n');

test('core content opts back in via .fb-selectable (element + descendants)', () => {
    assert.match(selectableRule, /\.fb-selectable\b/, '.fb-selectable must set user-select: text');
    assert.match(selectableRule, /\.fb-selectable\s*\*/, '...and its descendants (.fb-selectable *)');
});

test('focused copyable surfaces (modals/toasts/scan banner) opt back in', () => {
    // The PR\'s a11y guardrail keeps copyable text selectable "incl. in
    // modals/toasts" — these carry errors / IDs / paths the user copies.
    assert.match(selectableRule, /\.feedBack-modal\b/, 'modals (.feedBack-modal) must be selectable');
    assert.match(selectableRule, /\[role="dialog"\]/, 'dialogs ([role="dialog"]) must be selectable');
    assert.match(selectableRule, /#fb-notify-stack\b/, 'toasts (#fb-notify-stack) must be selectable');
    assert.match(selectableRule, /#scan-banner\b/, 'the scan banner (#scan-banner) must be selectable');
});

// Match a class="" attribute that contains ALL given tokens in any order.
const hasClasses = (...tokens) => new RegExp(
    'class="' + tokens.map((t) => '(?=[^"]*\\b' + t + '\\b)').join('') + '[^"]*"');

test('the Settings panel and now-playing metadata carry .fb-selectable', () => {
    assert.match(html, hasClasses('fb-settings', 'fb-selectable'),
        'the Settings panel must opt back in (paths / version / diagnostics / About)');
    assert.match(html, hasClasses('fb-selectable', 'pointer-events-auto'),
        'the now-playing metadata must opt back in AND re-enable pointer-events '
        + '(its #player-hud parent is pointer-events-none, which would block mouse selection)');
});
