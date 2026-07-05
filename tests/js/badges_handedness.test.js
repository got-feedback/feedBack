// Pins the onboarding handedness control: a Right/Left choice lives in the
// instrument selector (the "Choose your instrument" onboarding step, which the
// tour spotlights BEFORE the tuner/audio-calibration steps) and writes the
// highway 'lefty' preference. Source-level, matching the other tests/js/
// browser-heavy regression guards (the runtime path is DOM/WebGL-heavy).

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..', '..');
const BADGES = fs.readFileSync(path.join(ROOT, 'static', 'v3', 'badges.js'), 'utf8');
const TOUR = fs.readFileSync(path.join(ROOT, 'static', 'v3', 'onboarding-tour.js'), 'utf8');

test('instrument selector offers a Handedness Right/Left choice', () => {
    assert.match(BADGES, /instRow\('Handedness'/, 'a Handedness row must be in the instrument menu');
    assert.match(BADGES, /pill\('hand',\s*'right'/, 'Right handedness pill');
    assert.match(BADGES, /pill\('hand',\s*'left'/, 'Left handedness pill');
});

test('clicking a handedness pill writes the lefty preference from its value', () => {
    assert.match(
        BADGES,
        /\[data-pill="hand"\][\s\S]*?_setLeftyPref\(\s*b\.getAttribute\('data-val'\)\s*===\s*'left'\s*\)/,
        'the handedness click handler sets lefty from the pill value');
});

test('_setLeftyPref prefers highway.setLefty and falls back to the lefty localStorage key', () => {
    const setter = BADGES.match(/function _setLeftyPref\(on\)\s*\{[\s\S]*?\n    \}/);
    assert.ok(setter, '_setLeftyPref must exist');
    assert.match(setter[0], /highway\.setLefty/, 'prefers highway.setLefty (flips a live highway + persists)');
    assert.match(setter[0], /localStorage\.setItem\('lefty'/, 'falls back to the lefty localStorage key the highway reads on init');
});

test('_leftyPref reads highway.getLefty with a localStorage fallback', () => {
    assert.match(
        BADGES,
        /function _leftyPref\(\)\s*\{[\s\S]*?getLefty[\s\S]*?localStorage\.getItem\('lefty'\)/,
        '_leftyPref reads the current handedness with a storage fallback');
});

test('onboarding instrument step calls out left-handed players + the Handedness control', () => {
    assert.match(TOUR, /Choose your instrument/);
    assert.match(TOUR, /left-handed/i, 'the instrument step must call out left-handed players');
    assert.match(TOUR, /Handedness/, 'and name the Handedness control');
});
