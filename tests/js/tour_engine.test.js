// Source-level guards for the consolidated tour menu (feedBack#272).
// The engine lives in a DOMContentLoaded handler that wires window.feedBack,
// localStorage, and Shepherd — too much browser surface to reproduce cleanly
// in a vm sandbox. These checks lock in the contract (viz relevance gating,
// complete-vs-cancel semantics, waitFor validation, focus management,
// dedup, etc.) instead, so regressions land as failed assertions rather
// than silently-broken UX.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const tourJs = path.join(__dirname, '..', '..', 'static', 'tour-engine.js');
const SRC = fs.readFileSync(tourJs, 'utf8');

function extractBlock(src, signature) {
    const start = src.indexOf(signature);
    assert.ok(start !== -1, `signature '${signature}' not found`);
    const openBrace = src.indexOf('{', start);
    assert.ok(openBrace !== -1, `opening brace after '${signature}' not found`);
    let depth = 1;
    let i = openBrace + 1;
    while (i < src.length && depth > 0) {
        const ch = src[i];
        if (ch === '{') depth++;
        else if (ch === '}') depth--;
        i++;
    }
    assert.ok(depth === 0, `unbalanced braces after '${signature}'`);
    return src.slice(start, i);
}

test('viz tours on player are gated on the currently active viz', () => {
    const fn = extractBlock(SRC, 'function _isRelevant(pluginId, screenId, activeVizId)');
    // Gate must check is_viz on player, not just screen membership.
    assert.match(fn, /meta\.is_viz/, '_isRelevant must read meta.is_viz');
    assert.match(fn, /screenId\s*===\s*'player'/, '_isRelevant must gate the viz check on the player screen');
    assert.match(fn, /activeVizId\s*===\s*pluginId/, '_isRelevant must compare activeVizId to pluginId');
});

test('_relevantPlugins computes the active viz id once per refresh', () => {
    const fn = extractBlock(SRC, 'function _relevantPlugins(screenId)');
    // _currentVizPluginId must be called exactly once at the top, not
    // inside the per-plugin filter callback.
    const callMatches = fn.match(/_currentVizPluginId\(\)/g) || [];
    assert.equal(callMatches.length, 1, '_currentVizPluginId() must be called exactly once per refresh');
    // And gated on the player screen — no need to evaluate matchesArrangement
    // for irrelevant screens.
    assert.match(fn, /screenId\s*===\s*'player'/, 'active viz lookup must be gated on the player screen');
});

test('_currentVizPluginId reads #viz-picker before localStorage', () => {
    const fn = extractBlock(SRC, 'function _currentVizPluginId()');
    const pickerIdx = fn.search(/getElementById\(\s*['"]viz-picker['"]/);
    const lsIdx = fn.search(/localStorage\.getItem\(\s*['"]vizSelection['"]/);
    assert.ok(pickerIdx !== -1, 'must read #viz-picker');
    assert.ok(lsIdx !== -1, 'must read localStorage.vizSelection');
    assert.ok(pickerIdx < lsIdx, '#viz-picker must be consulted before localStorage (app.js treats picker as source of truth)');
});

test('tour completion → markSeen, cancel → markDismissed', () => {
    const fn = extractBlock(SRC, 'async function start(pluginId)');
    // complete handler must call _markSeen, cancel handler must call _markDismissed.
    // The two paths must not collapse into a single shared cleanup (else cancel
    // would silently mark the tour as completed, mis-labeling the badge).
    assert.match(fn, /tour\.on\(\s*['"]complete['"][\s\S]*?_markSeen\(\s*pluginId\s*\)/,
        'complete handler must _markSeen');
    assert.match(fn, /tour\.on\(\s*['"]cancel['"][\s\S]*?_markDismissed\(\s*pluginId\s*\)/,
        'cancel handler must _markDismissed (not _markSeen)');
});

test('register() ignores legacy injectTriggerInto / injectTriggerOpts with a deduped warning', () => {
    const fn = extractBlock(SRC, 'function register(pluginId, opts)');
    assert.match(fn, /'injectTriggerInto'\s+in\s+opts/, 'must detect legacy injectTriggerInto');
    assert.match(fn, /'injectTriggerOpts'\s+in\s+opts/, 'must detect legacy injectTriggerOpts');
    assert.match(fn, /_deprecationWarned\.has\(pluginId\)/, 'must check dedup Set before warning');
    assert.match(fn, /_deprecationWarned\.add\(pluginId\)/, 'must add to dedup Set so we warn once per plugin');
    assert.match(fn, /console\.warn/, 'must emit a console.warn');
    // The deprecated options must NOT be re-introduced anywhere — they were
    // explicitly dropped from _registry storage and from injectTrigger calls.
    assert.doesNotMatch(fn, /injectTriggerInto\s*:/, 'register() must not re-introduce injectTriggerInto storage');
});

test('waitFor validates string + try/catch protects querySelector', () => {
    // Find the step-mapping block that handles waitFor.
    const map = extractBlock(SRC, 'function _mapSteps(rawSteps, tourInstance)');
    assert.match(map, /typeof\s+raw\.waitFor\s*===\s*['"]string['"]/, 'must validate waitFor is a string');
    assert.match(map, /raw\.waitFor/, 'must reference raw.waitFor');
    // The selector must be probed inside a try/catch before beforeShowPromise
    // is installed — a malformed selector should warn + skip the wait, not
    // hang the tour.
    assert.match(map, /try\s*\{[^}]*document\.querySelector\(\s*sel\s*\)[^}]*\}\s*catch/,
        'must try/catch the upfront querySelector probe');
    assert.match(map, /_WAIT_FOR_TIMEOUT_MS/, 'must use the timeout constant');
});

test('_maybeShowToast guards against active tour and open popover', () => {
    const fn = extractBlock(SRC, 'function _maybeShowToast()');
    assert.match(fn, /if\s*\(_activeTour\)\s*return/, 'must early-return when a tour is running');
    assert.match(fn, /_menuPopover\.style\.display\s*!==\s*'none'/,
        'must early-return when the popover is already visible');
});

test('_updateMenuVisibility dismisses orphan toast when relevance drops to zero', () => {
    const fn = extractBlock(SRC, 'function _updateMenuVisibility()');
    // When plugins.length === 0 we hide the button AND must dismiss any
    // active toast (otherwise it'd float at the now-vacant button anchor).
    assert.match(fn, /_hideMenu\(\)[\s\S]*_dismissToast\(\)/,
        'must call _dismissToast() alongside _hideMenu() when relevance drops to zero');
    // And rebuild the open popover when relevance is still non-zero, so
    // NEW/✓ badges flip live without a close-and-reopen.
    assert.match(fn, /_rebuildMenuItems\(\)/, 'must rebuild open popover on visibility refresh');
});

test('popover has role=dialog with aria-controls wired from the trigger', () => {
    const fn = extractBlock(SRC, 'function _ensureMenu()');
    assert.match(fn, /setAttribute\(\s*['"]aria-controls['"]\s*,\s*['"]feedBack-tour-menu-popover['"]/,
        'trigger must wire aria-controls to the popover id');
    assert.match(fn, /_menuPopover\.id\s*=\s*['"]feedBack-tour-menu-popover['"]/,
        'popover must carry the matching id');
    assert.match(fn, /setAttribute\(\s*['"]role['"]\s*,\s*['"]dialog['"]/,
        'popover must use role=dialog (not the menu role we don\'t implement)');
});

test('toast Yes handler defers persistence to start() — no double-marking', () => {
    const fn = extractBlock(SRC, 'function _maybeShowToast()');
    // Find just the yesBtn click handler within the toast. We must NOT
    // see _markDismissed or _markSeen inside the Yes path — start()'s
    // own Shepherd handlers own that state transition. Calling
    // _markDismissed here would falsely flip hasDismissed() to true
    // while the tour is still running and after a successful complete.
    const yesIdx = fn.search(/yesBtn\.addEventListener/);
    const noIdx = fn.search(/noBtn\.addEventListener/);
    assert.ok(yesIdx !== -1 && noIdx !== -1, 'must find both yes and no handlers');
    const yesBlock = fn.slice(yesIdx, noIdx);
    assert.doesNotMatch(yesBlock, /_markDismissed\s*\(/,
        'Yes handler must not call _markDismissed (start() does it on cancel)');
    assert.doesNotMatch(yesBlock, /_markSeen\s*\(/,
        'Yes handler must not call _markSeen (start() does it on complete)');
});

test('_hideMenu skips focus return when the trigger button is hidden', () => {
    const fn = extractBlock(SRC, 'function _hideMenu()');
    // The refocus path must check _menuBtn.style.display !== 'none'
    // so we don't try to focus a hidden trigger (no-op, leaves focus
    // stuck on the about-to-be-hidden popover).
    assert.match(fn, /_menuBtn\.style\.display\s*!==\s*['"]none['"]/,
        '_hideMenu must skip focus return when the button itself is hidden');
});

test('_showMenu moves focus into the dialog; _hideMenu returns it to the trigger', () => {
    const show = extractBlock(SRC, 'function _showMenu()');
    assert.match(show, /\.tour-menu-item['"]?\s*\)?[\s\S]*\.focus\(\)/,
        '_showMenu must focus the first tour item');
    const hide = extractBlock(SRC, 'function _hideMenu()');
    assert.match(hide, /_menuBtn\.focus\(\)/, '_hideMenu must return focus to the trigger button');
    // The return-focus path must be gated on focus actually being inside
    // the dialog, so a programmatic _hideMenu doesn't steal focus from
    // elsewhere on the page.
    assert.match(hide, /_menuPopover\.contains\(\s*document\.activeElement\s*\)/,
        '_hideMenu must only return focus when focus was inside the dialog');
});

test('esc() actually HTML-escapes — Shepherd renders title via innerHTML', () => {
    const fn = extractBlock(SRC, 'function esc(s)');
    // The pre-existing String() coercion was a no-op; the live esc() must
    // map &<>"' to entities.
    assert.match(fn, /replace\(/, 'esc() must call replace() to escape characters');
    assert.match(SRC, /_ESC_MAP\s*=\s*\{[^}]*'&':\s*'&amp;'[^}]*'<':\s*'&lt;'[^}]*'>':\s*'&gt;'[^}]*'"':\s*'&quot;'[^}]*"'":\s*'&#39;'/,
        'must map all five HTML-significant characters');
});
