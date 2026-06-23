// Pins 3D Highway left-handed fret ordering (feedBack#321).
// Source-level only, matching the other tests/js/ regression guards: the
// runtime path is browser/WebGL-heavy, so these tests preserve the exact
// contracts that keep the lefty geometry coherent.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..', '..');
const HIGHWAY_JS = path.join(ROOT, 'static', 'highway.js');
const SCREEN_JS = path.join(ROOT, 'plugins', 'highway_3d', 'screen.js');
const CLAUDE_MD = path.join(ROOT, 'plugins', 'highway_3d', 'CLAUDE.md');

function src(file) {
    return fs.readFileSync(file, 'utf8');
}

test('highway renderer bundles surface the core lefty flag', () => {
    assert.match(
        src(HIGHWAY_JS),
        /lefty\s*:\s*_lefty/,
        'custom renderer bundles must include lefty: _lefty',
    );
});

test('3D Highway defines lefty-aware fret-position helpers', () => {
    const screen = src(SCREEN_JS);
    assert.match(
        screen,
        /let\s+_leftyCached\s*=\s*false\s*;/,
        'renderer must cache the bundle lefty flag',
    );
    assert.match(
        screen,
        /const\s+xFret\s*=\s*f\s*=>\s*\(\s*_leftyCached\s*\?\s*-fretX\(f\)\s*:\s*fretX\(f\)\s*\)/,
        'xFret must mirror fret edges when lefty is active',
    );
    assert.match(
        screen,
        /const\s+xFretMid\s*=\s*f\s*=>\s*\(\s*_leftyCached\s*\?\s*-fretMid\(f\)\s*:\s*fretMid\(f\)\s*\)/,
        'xFretMid must mirror fret centers when lefty is active',
    );
    assert.match(
        screen,
        /const\s+boardSpanX\s*=\s*\(\s*\)\s*=>\s*\{[\s\S]*?const\s+x0\s*=\s*xFret\(0\)\s*;[\s\S]*?const\s+xN\s*=\s*xFret\(NFRETS\)\s*;[\s\S]*?min\s*:\s*Math\.min\(x0,\s*xN\)[\s\S]*?max\s*:\s*Math\.max\(x0,\s*xN\)[\s\S]*?center\s*:\s*\(x0\s*\+\s*xN\)\s*\/\s*2[\s\S]*?width\s*:\s*Math\.abs\(xN\s*-\s*x0\)/,
        'boardSpanX must derive min/max/center/width from the lefty-aware xFret helper',
    );
});

test('draw(bundle) handles lefty changes by flipping camera X state and rebuilding the board', () => {
    const screen = src(SCREEN_JS);
    assert.match(
        screen,
        /_leftyCached\s*=\s*!!bundle\.lefty\s*;/,
        'draw(bundle) must refresh _leftyCached from bundle.lefty',
    );
    assert.match(
        screen,
        /const\s+leftyChanged\s*=\s*_leftyCached\s*!==\s*_leftyForBoard\s*;/,
        'draw(bundle) must detect runtime lefty changes',
    );
    assert.match(
        screen,
        /if\s*\(\s*_invertedCached\s*!==\s*_invertedForBoard\s*\|\|\s*leftyChanged\s*\|\|\s*newNStr\s*!==\s*nStr\s*\)\s*\{[\s\S]*?if\s*\(\s*leftyChanged\s*\)\s*\{[\s\S]*?curX\s*=\s*-curX\s*;[\s\S]*?tgtX\s*=\s*-tgtX\s*;[\s\S]*?_lookaheadCamX\s*=\s*-_lookaheadCamX\s*;[\s\S]*?\}[\s\S]*?buildBoard\(\)\s*;[\s\S]*?_leftyForBoard\s*=\s*_leftyCached\s*;/,
        'lefty changes must mirror curX/tgtX/_lookaheadCamX, rebuild board geometry, and update _leftyForBoard',
    );
});

test('camera shoulder offset follows the cached lefty orientation', () => {
    assert.match(
        src(SCREEN_JS),
        // The shoulder offset now feeds the base _camX (which the opt-in
        // free-camera bridge layers on top of) before cam.position.set (#771).
        /const\s+shoulderOffset\s*=\s*\(\s*_leftyCached\s*\?\s*-1\s*:\s*1\s*\)\s*\*\s*10\s*\*\s*K\s*;[\s\S]*?_camX\s*=\s*curX\s*\+\s*shoulderOffset/,
        'camera shoulder offset must flip with _leftyCached',
    );
});

test('3D Highway documentation says the renderer consumes bundle.lefty', () => {
    const doc = src(CLAUDE_MD);
    assert.doesNotMatch(
        doc,
        /bundle\.lefty[\s\S]{0,180}renderer never reads it/,
        'CLAUDE.md must not claim the 3D renderer ignores bundle.lefty',
    );
    assert.match(
        doc,
        /bundle\.lefty[\s\S]{0,240}(?:mirrors|lefty|left-handed|left-handed)/i,
        'CLAUDE.md should document the lefty flag as part of the renderer contract',
    );
});
