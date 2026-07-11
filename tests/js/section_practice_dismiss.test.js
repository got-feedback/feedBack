// Guards the Section Practice popover's outside-click dismiss in static/app.js
// (_installSectionPracticeDismiss). The v3 player-rail icon buttons call
// e.stopPropagation() in their click handler (static/v3/player-chrome.js
// wireRail), so a BUBBLE-phase document dismiss never fires when the user clicks
// a different rail icon (Plugins, Audio, …) — leaving the Practice popover
// stranded open under the newly-opened one (feedBack#638). The dismiss must bind
// in the CAPTURE phase (runs before the target's stopPropagation can swallow it).
// Esc must stay bubble-phase so it doesn't reorder ahead of the player's
// Escape-to-exit handling. A revert to bubble-phase should fail here.
//
// Source-level only — same strategy as the other tests/js/ files.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

// _installSectionPracticeDismiss was carved out of app.js into its own module (R3a).
const src = fs.readFileSync(path.join(__dirname, '..', '..', 'static', 'js', 'section-practice.js'), 'utf8');
const m = src.match(/function _installSectionPracticeDismiss\s*\(\)\s*\{[\s\S]*?\n\}/);
assert.ok(m, '_installSectionPracticeDismiss() not found in static/js/section-practice.js');
const body = m[0];

test('the outside-click dismiss binds in the CAPTURE phase', () => {
    assert.match(
        body,
        /addEventListener\(\s*['"]click['"][\s\S]*?,\s*true\s*\)/,
        'the click dismiss must pass the capture flag (`, true`) so a rail icon\'s '
        + 'stopPropagation() cannot swallow it',
    );
});

test('only the click listener is capture (Escape keydown stays bubble-phase)', () => {
    // Exactly one capture binding in the installer — the click. The keydown
    // (Escape) listener must NOT be capture.
    const captureBinds = body.match(/,\s*true\s*\)/g) || [];
    assert.equal(captureBinds.length, 1, 'expected exactly one capture-phase binding (the click)');
});

test('the dismiss ignores clicks inside the control (no self-close)', () => {
    assert.match(body, /section-practice-control/, 'must scope to #section-practice-control');
    assert.match(body, /ctrl\s*&&\s*ctrl\.contains\(e\.target\)\)\s*return/,
        'a click inside the control (incl. the pill) must not dismiss the popover');
});
