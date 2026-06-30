// Pins the wide-pane horizontal-FOV-hold ("Hor+") framing in
// plugins/highway_3d/screen.js.
//
// What it guards: ultra-wide panes (top/bottom 2-player split → full-width /
// half-height → ~32:9) used to render the neck as a thin central sliver because
// THREE's PerspectiveCamera fov is VERTICAL and was locked at 70°, ballooning
// the horizontal cone past 130°. The fix lets camUpdate lower the effective
// vertical fov as the pane widens (holding the horizontal cone ~constant) so the
// neck fills the pane. It is gated behind window.__h3dAspectTune (default off →
// byte-for-byte the prior behaviour) for live A/B comparison.
//
// A refactor that re-hardcodes the camera fov, drops the change-guarded cam.fov
// write, stops caching the pane aspect, or removes the no-op-at-startAspect
// guarantee would silently regress the feature (or worse, change normal-pane
// framing). These are source-level pins — same strategy as the other
// tests/js/ files (no DOM / WebGL in CI).

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const SCREEN_JS = path.join(__dirname, '..', '..', 'plugins', 'highway_3d', 'screen.js');
const src = fs.readFileSync(SCREEN_JS, 'utf8');

// ── Constants ────────────────────────────────────────────────────────────────

test('BASE_VFOV is a named constant (not a literal in the camera ctor)', () => {
    assert.match(
        src,
        /const\s+BASE_VFOV\s*=\s*70\s*;/,
        'BASE_VFOV must be declared as a constant',
    );
});

test('the camera is constructed with BASE_VFOV, not a bare 70', () => {
    assert.match(
        src,
        /new\s+T\.PerspectiveCamera\(\s*BASE_VFOV\s*,/,
        'PerspectiveCamera must take BASE_VFOV as its vertical fov',
    );
});

test('the Hor+ start-aspect and min-vfov defaults exist', () => {
    assert.match(src, /const\s+HORPLUS_START_ASPECT\s*=\s*16\s*\/\s*9\s*;/,
        'HORPLUS_START_ASPECT must default to 16/9 (no-op at/under the reference aspect)');
    assert.match(src, /const\s+HORPLUS_MIN_VFOV\s*=\s*\d+\s*;/,
        'HORPLUS_MIN_VFOV floor must be declared');
});

// ── effectiveVfov: no-op guarantees ──────────────────────────────────────────

test('effectiveVfov returns the base fov when the bridge is off/absent', () => {
    // The disabled / malformed-input guard returns `base` before any Hor+ math,
    // so normal panes are unaffected when __h3dAspectTune is missing or off.
    assert.match(
        src,
        /function\s+effectiveVfov\s*\(\s*aspect\s*,\s*tune\s*\)\s*\{[\s\S]*?if\s*\(\s*!tune\s*\|\|\s*!tune\.enabled[\s\S]*?return\s+base\s*;/,
        'effectiveVfov must short-circuit to the base fov when disabled',
    );
});

test('effectiveVfov is a no-op at/under the start aspect', () => {
    assert.match(
        src,
        /if\s*\(\s*aspect\s*<=\s*start\s*\)\s*return\s+base\s*;/,
        'effectiveVfov must return base when aspect <= start (no-op for normal/2x2 panes)',
    );
});

// ── shipped defaults: off + coherent ─────────────────────────────────────────
// The "default off → byte-for-byte prior behaviour" contract only holds if the
// shipped _ASPECT_DEFAULTS actually ship disabled with a base that matches the
// camera's constructed fov. A previous revision shipped enabled:true with
// baseVfov:30 (and blend:0), which forced every pane's fov to 30/36 and
// silently re-framed normal single-player panes. These pin against that.

test('_ASPECT_DEFAULTS ships disabled (no-op out of the box)', () => {
    assert.match(
        src,
        /const\s+_ASPECT_DEFAULTS\s*=\s*\{[\s\S]*?\benabled\s*:\s*false\b/,
        '_ASPECT_DEFAULTS.enabled must default to false so the feature is opt-in',
    );
});

test('the default base fov matches BASE_VFOV (enabling is still a no-op on normal panes)', () => {
    // baseVfov === BASE_VFOV means even with the feature ON, a <=startAspect pane
    // returns the unchanged 70° — the effect is confined to genuinely wide panes.
    assert.match(
        src,
        /const\s+_ASPECT_DEFAULTS\s*=\s*\{[\s\S]*?\bbaseVfov\s*:\s*BASE_VFOV\b/,
        '_ASPECT_DEFAULTS.baseVfov must default to BASE_VFOV, not a divergent literal',
    );
});

test('the default blend engages the hold and the floor sits below the base', () => {
    // blend:1 means turning the feature on actually holds the horizontal cone
    // (blend:0 would collapse effectiveVfov back to base = feature inert), and
    // minVfovDeg:HORPLUS_MIN_VFOV keeps the floor below baseVfov (a real floor,
    // not one that clamps the base upward).
    assert.match(
        src,
        /const\s+_ASPECT_DEFAULTS\s*=\s*\{[\s\S]*?\bblend\s*:\s*1\b/,
        '_ASPECT_DEFAULTS.blend must default to 1 so the Hor+ hold actually applies when enabled',
    );
    assert.match(
        src,
        /const\s+_ASPECT_DEFAULTS\s*=\s*\{[\s\S]*?\bminVfovDeg\s*:\s*HORPLUS_MIN_VFOV\b/,
        '_ASPECT_DEFAULTS.minVfovDeg must default to HORPLUS_MIN_VFOV (a floor below baseVfov)',
    );
});

// ── camUpdate: change-guarded fov write + cached aspect ───────────────────────

test('applySize caches the pane aspect for camUpdate', () => {
    assert.match(
        src,
        /_paneAspect\s*=\s*cam\.aspect\s*;/,
        'applySize must cache cam.aspect into _paneAspect',
    );
});

test('camUpdate reads the live tune bridge and respects splitOnly', () => {
    assert.match(
        src,
        /const\s+_aspTune\s*=\s*_aspectTune\(\)\s*;[\s\S]*?_aspTune\.splitOnly\s*&&\s*!_ssActive\(\)/,
        'camUpdate must read the bridge via _aspectTune() and gate splitOnly on _ssActive()',
    );
});

test('the tune bridge seeds from localStorage (persisted sessions apply on load)', () => {
    assert.match(
        src,
        /function\s+_aspectTune\s*\(\)[\s\S]*?localStorage\.getItem\(\s*_ASPECT_LS\s*\)/,
        '_aspectTune() must seed the bridge from localStorage',
    );
});

test('a floating tuner panel is built and toggled with the A/B state', () => {
    assert.match(src, /function\s+_ensureAspectPanel\s*\(\)/,
        '_ensureAspectPanel() must exist to build the live panel');
    assert.match(src, /function\s+_setAspectPanelVisible\s*\(/,
        '_setAspectPanelVisible() must show/hide the panel with the feature');
});

test('camUpdate only writes cam.fov when it actually changes', () => {
    // Guarding the write avoids a per-frame updateProjectionMatrix on a steady
    // pane and keeps the disabled path free.
    assert.match(
        src,
        /Math\.abs\(\s*_vfov\s*-\s*cam\.fov\s*\)\s*>\s*1e-4[\s\S]*?cam\.fov\s*=\s*_vfov\s*;[\s\S]*?cam\.updateProjectionMatrix\(\)/,
        'camUpdate must guard the cam.fov write behind a change check',
    );
});

// ── A/B toggle + lifecycle reset ──────────────────────────────────────────────

test('an A/B toggle shortcut flips the tune enabled flag', () => {
    assert.match(
        src,
        /registerShortcut\(\{[\s\S]*?const\s+t\s*=\s*_aspectTune\(\)\s*;[\s\S]*?t\.enabled\s*=\s*!\s*t\.enabled/,
        'a registerShortcut handler must toggle the bridge enabled flag',
    );
});

test('destroy() resets the pane aspect and restores the base fov', () => {
    assert.match(src, /_paneAspect\s*=\s*0\s*;/,
        'destroy() must reset _paneAspect to 0');
    assert.match(
        src,
        /cam\.fov\s*!==\s*BASE_VFOV[\s\S]*?cam\.fov\s*=\s*BASE_VFOV\s*;\s*cam\.updateProjectionMatrix\(\)/,
        'destroy() must restore cam.fov to BASE_VFOV for instance reuse',
    );
});
