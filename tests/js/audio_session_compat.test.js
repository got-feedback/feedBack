const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loadAudioSession, runBrowserScript, installMixerDom, makeInputProvider, makeMonitoringProvider } = require('./audio_session_test_harness');

function installAnalyserDom(window) {
    const audio = { addEventListener() {} };
    window.document.getElementById = id => (id === 'audio' ? audio : null);
    window.document.createElement = () => ({ getContext: () => null, style: {}, addEventListener() {}, setAttribute() {} });
    window.document.addEventListener = () => {};
    window.document.removeEventListener = () => {};
    window.Image = class Image {};
    window.URL = { createObjectURL: () => 'blob:test', revokeObjectURL() {} };
    window.Blob = class Blob {};
    window.AudioContext = class AudioContext {
        constructor() { this.state = 'running'; this.destination = {}; }
        createMediaElementSource() { return { connect() {} }; }
        createAnalyser() { return { context: this, frequencyBinCount: 128, fftSize: 0, connect() {}, getByteFrequencyData(data) { data.fill(1); } }; }
        resume() { return Promise.resolve(); }
        close() { return Promise.resolve(); }
    };
}

test('legacy fader API remains compatible while bridge hits are attributed', async () => {
    const window = loadAudioSession();
    installMixerDom(window);
    runBrowserScript(window, 'static/audio-mixer.js');

    let volume = 0.5;
    window.feedBack.audio.registerFader({
        id: 'plugin.delay',
        label: 'Delay',
        min: 0,
        max: 1,
        step: 0.1,
        defaultValue: 0.5,
        getValue: () => volume,
        setValue: value => { volume = value; },
    });

    const snapshot = window.feedBack.audioSession.snapshot();
    assert.equal(window.feedBack.audio.getFaders().some(fader => fader.id === 'plugin.delay'), true);
    assert.equal(snapshot.domains['audio-mix'].participants.some(participant => participant.participantId === 'fader.plugin.delay'), true);
    assert.equal(snapshot.domains['audio-mix'].bridges.some(bridge => bridge.bridgeId === 'audio-mix.fader-registry'), true);
});

test('legacy analyser fallback records bridge status without losing analyser output', () => {
    const window = loadAudioSession();
    installAnalyserDom(window);
    runBrowserScript(window, 'plugins/highway_3d/screen.js');

    const analyser = window.feedBackViz_highway_3d.__test.getAnalyserForBridgeTest();
    const bands = window.feedBackViz_highway_3d.__test.readBandsForBridgeTest();
    const bridge = window.feedBack.audioSession.snapshot().domains['audio-mix'].bridges.find(entry => entry.bridgeId === 'audio-mix.analyser');

    assert.equal(analyser.source, 'core');
    assert.equal(bands.bass > 0, true);
    assert.equal(bridge.outcome, 'handled');
});

test('barrier and input compatibility surfaces are visible in diagnostics', () => {
    const window = loadAudioSession();
    const audioSession = window.feedBack.audioSession;

    audioSession.recordBridgeHit({ domain: 'audio-monitoring', bridgeId: 'audio-monitoring.audio-barrier', legacySurface: 'window.feedBackAudioBarrier', participantId: 'note_detect', outcome: 'degraded', reason: 'timeout' });
    audioSession.recordBridgeHit({ domain: 'audio-input', bridgeId: 'audio-input.legacy-source', legacySurface: 'navigator.mediaDevices.getUserMedia', participantId: 'note_detect', outcome: 'denied', reason: 'permission denied' });

    const snapshot = audioSession.snapshot();
    assert.equal(snapshot.domains['audio-monitoring'].bridges.some(bridge => bridge.bridgeId === 'audio-monitoring.audio-barrier' && bridge.outcome === 'degraded'), true);
    assert.equal(snapshot.domains['audio-input'].bridges.some(bridge => bridge.bridgeId === 'audio-input.legacy-source' && bridge.outcome === 'denied'), true);
});

test('a legacy bridge hit with unsafe fields never leaks a path/token into diagnostics', () => {
    const window = loadAudioSession();
    const audioSession = window.feedBack.audioSession;

    audioSession.recordBridgeHit({
        domain: 'audio-input',
        legacySurface: '/Users/me/legacy token=brk1',
        participantId: '/Users/me/who token=brk2',
        logicalSourceKey: '/Users/me/key token=brk3',
        outcome: 'degraded',
        reason: 'legacy handoff',
    });

    const encoded = JSON.stringify(audioSession.snapshot());
    assert.equal(encoded.includes('/Users/me'), false);
    assert.equal(encoded.includes('token=brk1'), false);
    assert.equal(encoded.includes('token=brk2'), false);
    assert.equal(encoded.includes('token=brk3'), false);
});

test('audio-input explicit enumeration registers provider sources without list prompting', async () => {
    const window = loadAudioSession();
    const api = window.feedBack.capabilities;
    const provider = makeInputProvider({
        providerId: 'desktop_audio',
        sourceId: 'bootstrap-source',
        logicalSourceKey: 'desktop:bootstrap',
        sources: [
            { sourceId: 'desktop-source-2', logicalSourceKey: 'desktop:instrument:secondary', kind: 'instrument', safeLabel: 'Desktop Input 2', channelSummary: { channelCount: 1, channelShape: 'mono', supports: ['mono'] } },
        ],
    });

    await api.dispatch({ capability: 'audio-input', command: 'register-source', source: 'desktop_audio', payload: provider.source });
    const listed = await api.dispatch({ capability: 'audio-input', command: 'list-sources', source: 'test' });
    assert.equal(listed.payload.sources.some(source => source.logicalSourceKey === 'desktop:instrument:secondary'), false);
    assert.deepEqual(provider.calls, []);

    const enumerated = await window.feedBack.audioSession.enumerateInputSources({ providerId: 'desktop_audio', explicit: true, requesterId: 'settings' });
    const after = await api.dispatch({ capability: 'audio-input', command: 'list-sources', source: 'test' });

    assert.equal(enumerated.outcome, 'handled');
    assert.equal(provider.calls.length, 1);
    assert.equal(provider.calls[0][0], 'source.enumerate');
    assert.equal(after.payload.sources.some(source => source.logicalSourceKey === 'desktop:instrument:secondary'), true);
});

test('audio-input native source wins over compatibility-backed duplicate', async () => {
    const window = loadAudioSession();
    const api = window.feedBack.capabilities;

    await api.dispatch({
        capability: 'audio-input',
        command: 'register-source',
        source: 'legacy_input',
        payload: {
            sourceId: 'legacy-raw-source',
            logicalSourceKey: 'shared:instrument:primary',
            providerId: 'legacy_input',
            kind: 'instrument',
            safeLabel: 'Legacy Input',
            sourceMode: 'compatibility',
            compatibilitySource: 'navigator.mediaDevices.getUserMedia',
            channelSummary: { channelCount: 1, channelShape: 'mono', supports: ['mono'] },
        },
    });
    await api.dispatch({
        capability: 'audio-input',
        command: 'register-source',
        source: 'native_input',
        payload: {
            sourceId: 'native-raw-source',
            logicalSourceKey: 'shared:instrument:primary',
            providerId: 'native_input',
            kind: 'instrument',
            safeLabel: 'Native Input',
            sourceMode: 'native',
            channelSummary: { channelCount: 1, channelShape: 'mono', supports: ['mono'] },
        },
    });

    const listed = await api.dispatch({ capability: 'audio-input', command: 'list-sources', source: 'test' });
    const snapshot = window.feedBack.audioSession.snapshot().domains['audio-input'];

    assert.equal(listed.payload.sources.length, 1);
    assert.equal(listed.payload.sources[0].providerId, 'native_input');
    assert.equal(snapshot.sources.some(source => source.providerId === 'legacy_input' && source.supersededBy), true);
    assert.equal(snapshot.bridges.some(bridge => bridge.bridgeId === 'audio-input.legacy-source' && bridge.status === 'overshadowed'), true);
});

test('audio-monitoring native provider wins over legacy compatibility provider and overshadows its compatibility bridge', async () => {
    const window = loadAudioSession();
    const api = window.feedBack.capabilities;
    const legacy = makeMonitoringProvider({
        providerId: 'legacy_monitor',
        logicalMonitoringKey: 'shared:monitor:primary',
        sourceMode: 'compatibility',
        compatibilitySource: 'audio-monitoring.audio-barrier',
    });
    const native = makeMonitoringProvider({
        providerId: 'native_monitor',
        logicalMonitoringKey: 'shared:monitor:primary',
        sourceMode: 'native',
    });

    await api.dispatch({ capability: 'audio-monitoring', command: 'register-provider', source: 'legacy_monitor', payload: legacy.provider });
    await api.dispatch({ capability: 'audio-monitoring', command: 'register-provider', source: 'native_monitor', payload: native.provider });

    const listed = await api.dispatch({ capability: 'audio-monitoring', command: 'list-providers', source: 'test' });
    const snapshot = window.feedBack.audioSession.snapshot().domains['audio-monitoring'];

    // The compatibility bridge below is the one the registration/supersession path actually produces;
    // asserting only on it (not on manually pre-seeded bridge hits) keeps this test honest if the
    // compatibility layer ever stops overshadowing superseded providers.
    assert.equal(listed.payload.providers.length, 1);
    assert.equal(listed.payload.providers[0].providerId, 'native_monitor');
    assert.equal(snapshot.providers.some(provider => provider.providerId === 'legacy_monitor' && provider.supersededBy), true);
    assert.equal(snapshot.bridges.some(bridge => bridge.bridgeId === 'audio-monitoring.audio-barrier' && bridge.status === 'overshadowed'), true);
});

test('legacy registerFader callbacks are usable through audio-mix get and set operations', async () => {
    const window = loadAudioSession();
    installMixerDom(window);
    runBrowserScript(window, 'static/audio-mixer.js');
    window.feedBack.audioSession.startSession({ sessionId: 'main:test-song' });

    let gain = 0.35;
    window.feedBack.audio.registerFader({
        id: 'plugin.gain',
        label: 'Plugin Gain',
        min: 0,
        max: 1,
        step: 0.05,
        defaultValue: 0.35,
        getValue: () => gain,
        setValue: value => { gain = Math.min(0.9, value); return gain; },
    });

    const api = window.feedBack.capabilities;
    const listed = await api.dispatch({ capability: 'audio-mix', command: 'list-faders', source: 'test' });
    const read = await api.dispatch({ capability: 'audio-mix', command: 'get-fader-value', source: 'test', payload: { participantId: 'fader.plugin.gain', faderId: 'plugin.gain' } });
    const written = await api.dispatch({ capability: 'audio-mix', command: 'set-fader-value', source: 'test', payload: { participantId: 'fader.plugin.gain', faderId: 'plugin.gain', value: 1 } });

    assert.equal(listed.payload.faders.some(fader => fader.participantId === 'fader.plugin.gain' && fader.sourceMode === 'compatibility'), true);
    assert.equal(read.payload.committedValue, 0.35);
    assert.equal(written.payload.committedValue, 0.9);
    assert.equal(gain, 0.9);

    window.feedBack.audio.unregisterFader('plugin.gain');
    assert.equal(window.feedBack.audio.getFaders().some(fader => fader.id === 'plugin.gain'), false);
    assert.equal(window.feedBack.audioSession.snapshot().domains['audio-mix'].participants.some(participant => participant.participantId === 'fader.plugin.gain'), false);
});