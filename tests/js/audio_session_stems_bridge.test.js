const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loadAudioSession, runBrowserScript, installMixerDom } = require('./audio_session_test_harness');

test('Stems master-volume compatibility bridge hit is attributed through audio session', async () => {
    const window = loadAudioSession();
    const calls = [];
    installMixerDom(window);
    window.feedBack.stems = { setMasterVolume(value) { calls.push(value); } };

    runBrowserScript(window, 'static/audio-mixer.js');
    await window.feedBack.audio.applySongVolume(50);

    const snapshot = window.feedBack.audioSession.snapshot();
    assert.deepEqual(calls, [0.5]);
    assert.equal(snapshot.domains.stems.bridges.some(bridge => bridge.bridgeId === 'stems.master-volume'), true);
    assert.equal(window.feedBack.capabilities.snapshotDiagnostics().compatibilityShims.some(shim => shim.shimId === 'stems.master-volume' && shim.hitCount >= 1), true);
});