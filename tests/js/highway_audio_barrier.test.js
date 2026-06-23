// Pins the native-audio barrier ordering in static/highway.js
// (feedBack-desktop#117). The highway must await window.feedBackAudioBarrier
// before touching the JUCE backing engine, otherwise a NAM tone graph build
// that restarts the native audio device races the backing-track load.
//
// Source-level only — same strategy as the other tests/js/ files.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const HIGHWAY_JS = path.join(__dirname, '..', '..', 'static', 'highway.js');

test('highway awaits feedBackAudioBarrier before the JUCE backing path', () => {
    const src = fs.readFileSync(HIGHWAY_JS, 'utf8');
    const barrierIdx = src.indexOf('window.feedBackAudioBarrier');
    const isRunningIdx = src.indexOf('juceApi.isAudioRunning()');
    const loadIdx = src.indexOf('juceApi.loadBackingTrack');

    assert.ok(barrierIdx !== -1, 'highway must reference window.feedBackAudioBarrier');
    assert.ok(isRunningIdx !== -1, 'highway must still call juceApi.isAudioRunning()');
    assert.ok(loadIdx !== -1, 'highway must still call juceApi.loadBackingTrack');
    assert.ok(barrierIdx < isRunningIdx,
        'the barrier await must precede the isAudioRunning() check');
    assert.ok(barrierIdx < loadIdx,
        'the barrier await must precede loadBackingTrack');
});

test('the barrier await is timeout-guarded so a stuck plugin barrier cannot wedge song entry', () => {
    const src = fs.readFileSync(HIGHWAY_JS, 'utf8');
    const start = src.indexOf('window.feedBackAudioBarrier');
    assert.ok(start !== -1, 'highway must reference window.feedBackAudioBarrier');
    const region = src.slice(start, start + 600);
    // Catching rejections alone does not cover a never-settling promise — the
    // await must be raced against a local timeout.
    assert.match(region, /Promise\.race/,
        'the barrier await must be raced against a local timeout');
});
