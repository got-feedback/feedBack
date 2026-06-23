const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loadAudioSession } = require('./audio_session_test_harness');

test('audio-mix commands inspect register and unregister participants', async () => {
    const window = loadAudioSession();
    const api = window.feedBack.capabilities;
    const events = [];
    window.feedBack.on('audio-mix:participant-registered', event => events.push(event.detail.payload.participantId));

    const registered = await api.dispatch({
        capability: 'audio-mix',
        command: 'register-participant',
        source: 'test',
        payload: {
            participantId: 'plugin.delay',
            ownerPluginId: 'delay_plugin',
            label: 'Delay Return',
            kind: 'plugin',
            fader: { id: 'wet', label: 'Wet', min: 0, max: 1, step: 0.01, defaultValue: 0.5, currentValue: 0.6 },
            operations: ['fader.get-value', 'fader.set-value'],
        },
    });
    const inspected = await api.dispatch({ capability: 'audio-mix', command: 'inspect', source: 'test' });
    const removed = await api.dispatch({ capability: 'audio-mix', command: 'unregister-participant', source: 'test', payload: { participantId: 'plugin.delay' } });

    assert.equal(registered.status, 'applied');
    assert.equal(registered.payload.participantId, 'plugin.delay');
    assert.equal(inspected.payload.participants.some(p => p.participantId === 'plugin.delay'), true);
    assert.equal(events.includes('plugin.delay'), true);
    assert.equal(removed.status, 'applied');
    assert.equal(window.feedBack.audioSession.snapshot().domains['audio-mix'].participants.some(p => p.participantId === 'plugin.delay'), false);
});

test('audio-mix registration reports incompatible participants explicitly', async () => {
    const window = loadAudioSession();
    const result = await window.feedBack.capabilities.dispatch({
        capability: 'audio-mix',
        command: 'register-participant',
        source: 'test',
        payload: { participantId: 'future.plugin', version: 2 },
    });

    assert.equal(result.status, 'incompatible-version');
    assert.equal(result.outcome, 'incompatible-version');
    assert.equal(window.feedBack.audioSession.snapshot().recentOutcomes.at(-1).outcome, 'incompatible-version');
});

test('audio-mix lists required participant kinds and commits provider fader values', async () => {
    const window = loadAudioSession();
    const api = window.feedBack.capabilities;
    const audioSession = window.feedBack.audioSession;
    audioSession.startSession({ sessionId: 'main:test-song', songKey: 'test-song', songFormat: 'sloppak' });

    let pluginValue = 0.25;
    for (const [participantId, kind] of [
        ['core.song', 'song'],
        ['plugin.delay', 'plugin'],
        ['stems.master', 'stem'],
        ['monitoring.input', 'monitoring'],
        ['preview.player', 'preview'],
    ]) {
        const isPlugin = participantId === 'plugin.delay';
        await api.dispatch({
            capability: 'audio-mix',
            command: 'register-participant',
            source: 'test',
            payload: {
                participantId,
                ownerPluginId: participantId.split('.')[0],
                label: kind,
                kind,
                fader: { id: 'volume', label: `${kind} volume`, min: 0, max: 1, step: 0.05, defaultValue: 0.5, currentValue: isPlugin ? pluginValue : 0.5 },
                operations: ['fader.get-value', 'fader.set-value'],
                operationHandlers: isPlugin ? {
                    'fader.get-value': () => pluginValue,
                    'fader.set-value': value => { pluginValue = Math.round(value * 10) / 10; return { committedValue: pluginValue }; },
                } : {},
            },
        });
    }

    const listed = await api.dispatch({ capability: 'audio-mix', command: 'list-faders', source: 'test' });
    const read = await api.dispatch({ capability: 'audio-mix', command: 'get-fader-value', source: 'test', payload: { participantId: 'plugin.delay', faderId: 'volume' } });
    const started = Date.now();
    const written = await api.dispatch({ capability: 'audio-mix', command: 'set-fader-value', source: 'test', payload: { participantId: 'plugin.delay', faderId: 'volume', value: 0.76 } });
    const latency = Date.now() - started;
    const clamped = await api.dispatch({ capability: 'audio-mix', command: 'set-fader-value', source: 'test', payload: { participantId: 'plugin.delay', faderId: 'volume', value: 5 } });

    assert.equal(listed.status, 'applied');
    for (const kind of ['song', 'plugin', 'stem', 'monitoring', 'preview']) assert.equal(listed.payload.requiredKinds[kind], true, kind);
    assert.equal(read.payload.committedValue, 0.25);
    assert.equal(written.payload.requestedValue, 0.76);
    assert.equal(written.payload.committedValue, 0.8);
    assert.equal(latency < 500, true, `committed display latency ${latency}ms`);
    assert.equal(clamped.payload.normalizedValue, 1);
    assert.equal(clamped.payload.committedValue, 1);
});

test('audio-mix reports invalid unavailable and timed-out fader operations', async () => {
    const window = loadAudioSession();
    const api = window.feedBack.capabilities;
    const events = [];
    window.feedBack.on('audio-mix:fader-unavailable', event => events.push(event.detail.payload.participantId));
    window.feedBack.audioSession.startSession({ sessionId: 'main:test-song' });

    await api.dispatch({
        capability: 'audio-mix',
        command: 'register-participant',
        source: 'test',
        payload: {
            participantId: 'plugin.disabled',
            ownerPluginId: 'plugin.disabled',
            label: 'Disabled',
            kind: 'plugin',
            availability: 'unavailable',
            fader: { id: 'volume', label: 'Disabled', min: 0, max: 1, step: 0.1, defaultValue: 0.5, currentValue: 0.5 },
            operations: ['fader.get-value', 'fader.set-value'],
        },
    });
    await api.dispatch({
        capability: 'audio-mix',
        command: 'register-participant',
        source: 'test',
        payload: {
            participantId: 'plugin.slow',
            ownerPluginId: 'plugin.slow',
            label: 'Slow',
            kind: 'plugin',
            fader: { id: 'volume', label: 'Slow', min: 0, max: 1, step: 0.1, defaultValue: 0.4, currentValue: 0.4 },
            operations: ['fader.get-value', 'fader.set-value'],
            operationHandlers: { 'fader.set-value': () => new Promise(() => {}) },
        },
    });

    const invalid = await api.dispatch({ capability: 'audio-mix', command: 'set-fader-value', source: 'test', payload: { participantId: 'plugin.slow', faderId: 'volume', value: 'loud' } });
    const unavailable = await api.dispatch({ capability: 'audio-mix', command: 'set-fader-value', source: 'test', payload: { participantId: 'plugin.disabled', faderId: 'volume', value: 0.8 } });
    const started = Date.now();
    const timedOut = await api.dispatch({ capability: 'audio-mix', command: 'set-fader-value', source: 'test', payload: { participantId: 'plugin.slow', faderId: 'volume', value: 0.8 } });
    const elapsed = Date.now() - started;

    assert.equal(invalid.outcome, 'denied');
    assert.equal(unavailable.outcome, 'degraded');
    assert.equal(events.includes('plugin.disabled'), true);
    assert.equal(timedOut.outcome, 'failed');
    assert.equal(timedOut.payload.timedOut, true);
    assert.equal(timedOut.payload.committedValue, 0.4);
    assert.equal(elapsed >= 1900 && elapsed < 2600, true, `timeout elapsed ${elapsed}ms`);
});

test('audio-mix keeps pre-session participants pending then attaches them on session start', async () => {
    const window = loadAudioSession();
    const api = window.feedBack.capabilities;

    await api.dispatch({
        capability: 'audio-mix',
        command: 'register-participant',
        source: 'test',
        payload: {
            participantId: 'plugin.presession',
            ownerPluginId: 'plugin.presession',
            label: 'Pre-session',
            kind: 'plugin',
            fader: { id: 'volume', label: 'Pre-session', min: 0, max: 1, step: 0.1, defaultValue: 0.3, currentValue: 0.3 },
            operations: ['fader.get-value', 'fader.set-value'],
        },
    });
    const pending = await api.dispatch({ capability: 'audio-mix', command: 'list-faders', source: 'test' });
    window.feedBack.audioSession.startSession({ sessionId: 'main:next-song' });
    const active = await api.dispatch({ capability: 'audio-mix', command: 'list-faders', source: 'test' });

    assert.equal(pending.payload.faders.find(fader => fader.participantId === 'plugin.presession').availability, 'pending');
    assert.equal(active.payload.faders.find(fader => fader.participantId === 'plugin.presession').availability, 'available');
});

test('audio-mix registration is idempotent and song switching keeps known participants without stale route', async () => {
    const window = loadAudioSession();
    const audioSession = window.feedBack.audioSession;
    audioSession.startSession({ sessionId: 'main:first-song', songKey: 'first-song' });
    audioSession.setRoute({ routeKind: 'stems', availability: 'available' });

    for (let i = 0; i < 3; i += 1) {
        audioSession.registerMixParticipant({
            participantId: 'plugin.rehydrated',
            ownerPluginId: 'plugin.rehydrated',
            label: 'Rehydrated',
            kind: 'plugin',
            fader: { id: 'volume', label: 'Rehydrated', min: 0, max: 1, step: 0.1, defaultValue: 0.5, currentValue: 0.5 + i * 0.1 },
            operations: ['fader.get-value', 'fader.set-value'],
        });
    }
    const beforeStop = await window.feedBack.capabilities.dispatch({ capability: 'audio-mix', command: 'list-faders', source: 'test' });
    audioSession.stopSession('song switch');
    const stopped = audioSession.snapshot();
    audioSession.startSession({ sessionId: 'main:second-song', songKey: 'second-song' });
    const afterStart = await window.feedBack.capabilities.dispatch({ capability: 'audio-mix', command: 'list-faders', source: 'test' });

    assert.equal(beforeStop.payload.faders.filter(fader => fader.participantId === 'plugin.rehydrated').length, 1);
    assert.equal(stopped.domains['audio-mix'].route.availability, 'unavailable');
    assert.equal(afterStart.payload.faders.filter(fader => fader.participantId === 'plugin.rehydrated').length, 1);
    assert.equal(afterStart.payload.faders.find(fader => fader.participantId === 'plugin.rehydrated').availability, 'available');
});
test('re-registering a mix participant without handlers preserves the existing set-fader-value handler', async () => {
    // Regression for the song-volume mixer no-op: _applySongVolume() runs on
    // every song load and re-registers core.song WITHOUT get/set handlers.
    // registerMixParticipant replaces the participant, so before the fix this
    // wiped the fader.set-value handler installed at init — the mixer slider
    // then moved visually but never applied the volume (archive and sloppak).
    const window = loadAudioSession();
    const audioSession = window.feedBack.audioSession;
    audioSession.startSession({ sessionId: 'main:test-song', songKey: 'test-song', songFormat: 'sloppak' });

    const applied = [];
    // Initial registration WITH handlers (mirrors _registerSongFader()).
    audioSession.registerMixParticipant({
        participantId: 'core.song',
        ownerPluginId: 'core',
        label: 'Song',
        kind: 'song',
        sourceMode: 'core',
        fader: { id: 'song', label: 'Song', unit: '%', min: 0, max: 100, step: 1, defaultValue: 80, currentValue: 80 },
        operations: ['fader.get-value', 'fader.set-value'],
        operationHandlers: {
            'fader.get-value': () => 80,
            'fader.set-value': (value) => { applied.push(value); return value; },
        },
    });

    // Re-registration WITHOUT handlers (mirrors _applySongVolume()'s spec).
    audioSession.registerMixParticipant({
        participantId: 'core.song',
        ownerPluginId: 'core',
        label: 'Song',
        kind: 'song',
        sourceMode: 'core',
        fader: { id: 'song', label: 'Song', unit: '%', min: 0, max: 100, step: 1, defaultValue: 80, currentValue: 55 },
    });

    const result = await audioSession.setFaderValue({ participantId: 'core.song', faderId: 'song', value: 42 });

    assert.equal(result.outcome, 'handled');
    assert.equal(result.payload.committedValue, 42);
    // The handler must still have been invoked — the actual volume was applied,
    // not silently swallowed by a dropped handler.
    assert.deepEqual(applied, [42]);
});
