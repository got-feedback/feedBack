// Pins the auto-reframe-on-layout-drift behaviour ported into the drum and
// keys 3D highway renderers from plugins/highway_3d/screen.js.
//
// Bug it guards against: under splitscreen the host resizes each panel's
// canvas but overrides hw.resize and never calls renderer.resize(). The
// guitar/bass highway_3d self-detects this in draw(); the drum and keys
// highways originally only re-framed when the host called resize(w,h), so
// their panels did NOT resize when the app went fullscreen — they stayed
// framed for the pre-fullscreen size while the guitar/bass panels adapted.
//
// The fix ports highway_3d's per-frame drift check into both draw() loops:
// compare the live canvas backing store (canvas.width/height) AND the CSS box
// (clientWidth/Height) against the last applied logical size, re-running
// applySize() on either drift. A refactor that drops this check, stops
// recording _appliedW/_appliedH, or reverts to resize()-only sizing would
// silently bring the fullscreen-split bug back.
//
// Source-level only — same strategy as highway_3d_resize_reframe.test.js.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const PLUGINS = path.join(__dirname, '..', '..', 'plugins');
const CASES = [
    { name: 'drum_highway_3d', file: path.join(PLUGINS, 'drum_highway_3d', 'screen.js') },
    { name: 'keys_highway_3d', file: path.join(PLUGINS, 'keys_highway_3d', 'screen.js') },
];

for (const { name, file } of CASES) {
    const src = fs.readFileSync(file, 'utf8');

    test(`${name}: applied-size tracking is declared as instance state`, () => {
        assert.match(
            src,
            /let\s+_appliedW\s*=\s*0\s*,\s*_appliedH\s*=\s*0\s*;/,
            '_appliedW / _appliedH must be declared as per-instance state',
        );
        assert.match(
            src,
            /let\s+_lastHwW\s*=\s*0\s*,\s*_lastHwH\s*=\s*0\s*;/,
            '_lastHwW / _lastHwH must be declared as per-instance state',
        );
    });

    test(`${name}: applySize records the logical w/h it applied`, () => {
        assert.match(
            src,
            /_appliedW\s*=\s*[wW]\s*;\s*_appliedH\s*=\s*[hH]\s*;/,
            'applySize must record _appliedW / _appliedH',
        );
    });

    test(`${name}: draw() preserves the backing-store drift branch (splitscreen path)`, () => {
        assert.match(
            src,
            /const\s+_bsChanged\s*=\s*highwayCanvas\.width\s*!==\s*_lastHwW\s*\|\|\s*highwayCanvas\.height\s*!==\s*_lastHwH\s*;/,
            'the backing-store (canvas.width/height) comparison must run every frame',
        );
        assert.match(
            src,
            /if\s*\(\s*_bsChanged\s*\)\s*\{\s*_lastHwW\s*=\s*highwayCanvas\.width\s*;\s*_lastHwH\s*=\s*highwayCanvas\.height\s*;[\s\S]*?applySize\(\s*_bw\s*,\s*_bh\s*\)\s*;/,
            'the backing-store drift branch must re-apply',
        );
    });

    test(`${name}: draw() re-applies on CSS-box drift without a backing-store change`, () => {
        assert.match(
            src,
            /else if\s*\(\s*_bw\s*>\s*0\s*&&\s*_bh\s*>\s*0\s*&&\s*\(\s*Math\.abs\(\s*_bw\s*-\s*_appliedW\s*\)\s*>\s*1\s*\|\|\s*Math\.abs\(\s*_bh\s*-\s*_appliedH\s*\)\s*>\s*1\s*\)\s*\)\s*\{\s*applySize\(\s*_bw\s*,\s*_bh\s*\)\s*;/,
            'draw() must re-apply when the live box drifts >1px from _appliedW/_appliedH',
        );
    });

    test(`${name}: destroy() resets the applied-size tracking`, () => {
        assert.match(
            src,
            /_lastHwW\s*=\s*0\s*;\s*_lastHwH\s*=\s*0\s*;\s*_appliedW\s*=\s*0\s*;\s*_appliedH\s*=\s*0\s*;/,
            'destroy() must reset the drift-tracking state to 0',
        );
    });
}
