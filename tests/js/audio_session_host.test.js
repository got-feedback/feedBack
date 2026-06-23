const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loadAudioSession, diagnosticsSnapshot, makeInputProvider, makeMonitoringProvider } = require('./audio_session_test_harness');

test('audio session host registers active core domains and contributes diagnostics', () => {
    const window = loadAudioSession();
    const api = window.feedBack.capabilities;
    const diagnostics = window.feedBack.diagnostics.snapshotContributions();

    for (const domain of ['audio-mix', 'audio-input', 'audio-monitoring']) {
        const pipeline = api.inspect(domain);
        assert.equal(pipeline.review.lifecycle, 'active');
        assert.equal(pipeline.participants.some(p => p.pluginId === 'core.audio.session' && p.roles.includes('owner')), true);
    }
    const stemsPipeline = api.inspect('stems');
    assert.equal(stemsPipeline.review.lifecycle, 'active');
    assert.equal(stemsPipeline.participants.some(p => p.pluginId === 'core.audio.session' && p.roles.includes('coordinator') && !p.roles.includes('owner')), true);
    assert.equal(diagnostics['audio-session'].schema, 'feedBack.audio_session.diagnostics.v1');
});

test('audio session lifecycle and snapshots redact source identity with per-snapshot pseudonyms', () => {
    const window = loadAudioSession();
    const audioSession = window.feedBack.audioSession;

    audioSession.startSession({ sessionId: 'main:/Users/example/DLC/song.archive', songKey: '/Users/example/DLC/song.archive', songFormat: 'archive' });
    audioSession.setRoute({ routeKind: 'html5', availability: 'available', deviceLabel: 'Scarlett 2i2 Serial 1234' });
    audioSession.registerInputSource({ sourceId: 'mic-raw-id', logicalSourceKey: 'browser:instrument:primary', providerId: 'browser', kind: 'instrument', channelCount: 2, availability: 'available', label: 'Scarlett 2i2 Serial 1234' });

    const snapshot = audioSession.snapshot();
    const encoded = JSON.stringify(snapshot);
    assert.equal(snapshot.session.songFormat, 'archive');
    assert.match(snapshot.domains['audio-input'].sources[0].diagnosticsPseudonym, /^source-\d{2}$/);
    assert.equal(encoded.includes('Scarlett'), false);
    assert.equal(encoded.includes('/Users/example'), false);
});

test('audio-input diagnostics redact source ids labels handles and bounded reasons', async () => {
    const window = loadAudioSession();
    const api = window.feedBack.capabilities;

    await api.dispatch({
        capability: 'audio-input',
        command: 'register-source',
        source: 'secret_plugin',
        payload: {
            sourceId: 'Built-in Microphone Serial ABC123',
            logicalSourceKey: 'secret:instrument:primary',
            providerId: 'secret_plugin',
            kind: 'instrument',
            label: 'Built-in Microphone Serial ABC123',
            availability: 'available',
            reason: 'Path /Users/barlind/private/project token=abc123 should be redacted',
            channelSummary: { channelCount: 2, channelShape: 'stereo', supports: ['mono', 'stereo'] },
            operations: ['source.open'],
            operationHandlers: {
                'source.open': () => ({ outcome: 'handled', mediaStream: { secret: true }, audioNode: { secret: true } }),
            },
        },
    });
    await api.dispatch({ capability: 'audio-input', command: 'select-source', source: 'user', payload: { logicalSourceKey: 'secret:instrument:primary' } });
    await api.dispatch({ capability: 'audio-input', command: 'open-source', source: 'note_detect', payload: { requesterId: 'note_detect', requiredChannelShape: 'mono' } });

    const encoded = JSON.stringify(diagnosticsSnapshot(window));
    assert.equal(encoded.includes('Built-in Microphone'), false);
    assert.equal(encoded.includes('ABC123'), false);
    assert.equal(encoded.includes('/Users/barlind'), false);
    assert.equal(encoded.includes('token=abc123'), false);
    assert.equal(encoded.includes('mediaStream'), false);
    assert.equal(encoded.includes('audioNode'), false);
    assert.match(encoded, /source-\d+/);
});

test('audio-input shares compatible open sessions and closes provider after last release', async () => {
    const window = loadAudioSession();
    const api = window.feedBack.capabilities;
    const calls = [];

    await api.dispatch({
        capability: 'audio-input',
        command: 'register-source',
        source: 'provider',
        payload: {
            sourceId: 'shared-source',
            logicalSourceKey: 'shared:instrument:primary',
            providerId: 'provider',
            kind: 'instrument',
            safeLabel: 'Shared Input',
            channelSummary: { channelCount: 2, channelShape: 'stereo', supports: ['mono', 'stereo'] },
            operations: ['source.open', 'source.close'],
            operationHandlers: {
                'source.open': request => { calls.push(['open', request.requesterId]); return { outcome: 'handled' }; },
                'source.close': request => { calls.push(['close', request.openSessionId]); return { outcome: 'handled' }; },
            },
        },
    });
    await api.dispatch({ capability: 'audio-input', command: 'select-source', source: 'user', payload: { logicalSourceKey: 'shared:instrument:primary' } });

    const first = await api.dispatch({ capability: 'audio-input', command: 'open-source', source: 'note_detect', payload: { requesterId: 'note_detect', requiredChannelShape: 'mono' } });
    const second = await api.dispatch({ capability: 'audio-input', command: 'open-source', source: 'practice_overlay', payload: { requesterId: 'practice_overlay', requiredChannelShape: 'mono' } });
    const closeFirst = await api.dispatch({ capability: 'audio-input', command: 'close-source', source: 'note_detect', payload: { requesterId: 'note_detect', openSessionId: first.payload.openSessionId } });
    const closeSecond = await api.dispatch({ capability: 'audio-input', command: 'close-source', source: 'practice_overlay', payload: { requesterId: 'practice_overlay', openSessionId: second.payload.openSessionId } });

    assert.equal(first.outcome, 'handled');
    assert.equal(second.outcome, 'handled');
    assert.equal(first.payload.openSessionId, second.payload.openSessionId);
    assert.equal(closeFirst.payload.state, 'open');
    assert.equal(closeSecond.payload.state, 'closed');
    assert.deepEqual(calls.map(call => call[0]), ['open', 'close']);
});

test('audio diagnostics record bounded runtime outcomes and domain statuses', () => {
    const window = loadAudioSession();
    const audioSession = window.feedBack.audioSession;

    for (let i = 0; i < 120; i += 1) {
        audioSession.recordOutcome({ domain: 'audio-input', operation: 'select-source', participantId: 'test', outcome: 'degraded', status: 'unavailable', reason: `missing-${i}` });
    }

    const snapshot = audioSession.snapshot();
    assert.equal(snapshot.recentOutcomes.length, 100);
    assert.equal(snapshot.recentOutcomes.at(-1).status, 'unavailable');
    assert.equal(snapshot.recentOutcomes.at(-1).outcome, 'degraded');
});

test('disabled missing incompatible unsupported and timeout paths are diagnosable', async () => {
    const window = loadAudioSession();
    const api = window.feedBack.capabilities;
    const audioSession = window.feedBack.audioSession;

    audioSession.registerMixParticipant({ participantId: 'disabled-fader', availability: 'disabled' });
    assert.equal(audioSession.snapshot().domains['audio-mix'].participants[0].availability, 'disabled');

    const missingOwner = await api.dispatch({ capability: 'stems', command: 'inspect', source: 'test' });
    assert.equal(missingOwner.outcome, 'no-owner');

    const incompatible = await api.dispatch({ capability: 'audio-mix', command: 'register-participant', source: 'test', payload: { participantId: 'bad', version: 2 } });
    assert.equal(incompatible.outcome, 'incompatible-version');

    const unsupported = await api.dispatch({ capability: 'audio-mix', command: 'not-a-command', source: 'test' });
    assert.equal(unsupported.outcome, 'unsupported-command');

    api.registerParticipant('slow_audio_probe', {
        'audio-mix': {
            roles: ['provider'],
            commands: ['slow-probe'],
            runtime: true,
            handlers: { 'slow-probe': () => new Promise(resolve => setTimeout(() => resolve({ outcome: 'handled' }), 20)) },
        },
    });
    const timedOut = await api.command('audio-mix', 'slow-probe', { requester: 'test', timeoutMs: 1 });
    assert.equal(timedOut.outcome, 'failed');
    assert.match(timedOut.reason, /timed out/i);
});

test('audio-mix diagnostics include faders routes analysers bridge hits and redacted outcomes', async () => {
    const window = loadAudioSession();
    const api = window.feedBack.capabilities;
    const audioSession = window.feedBack.audioSession;
    audioSession.startSession({ sessionId: 'main:/Users/example/DLC/song.archive', songKey: '/Users/example/DLC/song.archive' });
    audioSession.setRoute({ routeKind: 'desktop', availability: 'degraded', deviceLabel: 'Secret Studio Output', fallbackReason: 'fallback token=abc123 at /Users/example/device' });
    audioSession.setAnalyser({ source: 'plugin', availability: 'available', participantId: 'plugin.visualizer', reason: 'ok', rawFft: [1, 2, 3] });
    audioSession.recordBridgeHit({ domain: 'audio-mix', bridgeId: 'audio-mix.fader-registry', legacySurface: 'registerFader', participantId: 'legacy.delay', outcome: 'failed', reason: 'password=abc path /Users/example/plugin' });

    await api.dispatch({
        capability: 'audio-mix',
        command: 'register-participant',
        source: 'test',
        payload: {
            participantId: 'plugin.delay',
            ownerPluginId: 'delay',
            label: 'Delay',
            kind: 'plugin',
            sourceMode: 'native',
            fader: { id: 'wet', label: 'Wet', min: 0, max: 1, step: 0.1, defaultValue: 0.5, currentValue: 0.5 },
            operations: ['fader.get-value', 'fader.set-value'],
            operationHandlers: { 'fader.set-value': () => { throw new Error('failed near /Users/example/secret token=abc'); } },
        },
    });
    const failed = await api.dispatch({ capability: 'audio-mix', command: 'set-fader-value', source: 'test', payload: { participantId: 'plugin.delay', faderId: 'wet', value: 0.7 } });
    const route = await api.dispatch({ capability: 'audio-mix', command: 'inspect-route', source: 'test' });
    const analyser = await api.dispatch({ capability: 'audio-mix', command: 'inspect-analyser', source: 'test' });
    const snapshot = audioSession.snapshot();
    const encoded = JSON.stringify(snapshot);

    assert.equal(failed.outcome, 'failed');
    assert.equal(route.payload.routeKind, 'desktop');
    assert.equal(analyser.payload.source, 'plugin');
    assert.equal(snapshot.domains['audio-mix'].faders.some(fader => fader.participantId === 'plugin.delay' && fader.sourceMode === 'native'), true);
    assert.equal(snapshot.domains['audio-mix'].bridges.some(bridge => bridge.bridgeId === 'audio-mix.fader-registry' && bridge.outcome === 'failed'), true);
    assert.equal(snapshot.recentOutcomes.some(outcome => outcome.operation === 'set-fader-value' && outcome.faderId === 'wet' && outcome.outcome === 'failed'), true);
    assert.equal(encoded.includes('rawFft'), false);
    assert.equal(encoded.includes('Secret Studio Output'), false);
    assert.equal(encoded.includes('/Users/example'), false);
    assert.equal(encoded.includes('token=abc'), false);
    assert.equal(encoded.includes('password=abc'), false);
});

test('audio-monitoring diagnostics redact provider source session handles and private payloads', async () => {
    const window = loadAudioSession();
    const api = window.feedBack.capabilities;
    const input = makeInputProvider({
        providerId: 'secret_input',
        sourceId: 'USB Interface Hardware ABC1234',
        logicalSourceKey: 'secret:instrument:primary',
        label: 'USB Interface Hardware ABC1234',
        channelSummary: { channelCount: 2, channelShape: 'stereo', supports: ['mono', 'stereo'] },
        openResult: { outcome: 'handled', status: 'open', mediaStream: { raw: true }, audioNode: { raw: true }, samples: [1, 2, 3] },
    });
    const monitoring = makeMonitoringProvider({
        providerId: 'secret_monitor',
        logicalMonitoringKey: 'secret:monitor:primary',
        safeLabel: 'Secret Monitor Serial 9988',
        startResult: {
            outcome: 'handled',
            status: 'active',
            summary: {
                directMonitor: { state: 'muted', control: 'supported', preference: 'muted', applied: true, reason: 'path /Users/barlind/private token=abc123 waveform raw-audio' },
                latencySummary: { bucket: 'low', minMs: 2, maxMs: 6, rawBuffer: [1, 2, 3] },
                mediaStream: { secret: true },
                nativeHandle: { secret: true },
            },
        },
    });

    await api.dispatch({ capability: 'audio-input', command: 'register-source', source: input.source.providerId, payload: input.source });
    await api.dispatch({ capability: 'audio-input', command: 'select-source', source: 'user', payload: { logicalSourceKey: input.source.logicalSourceKey } });
    const providerPayload = { ...monitoring.provider, privatePayload: { password: 'abc123' }, rawAudioBuffer: [1, 2, 3], nativeHandle: { secret: true }, label: 'Secret Monitor Serial 9988' };
    delete providerPayload.safeLabel;
    await api.dispatch({ capability: 'audio-monitoring', command: 'register-provider', source: monitoring.provider.providerId, payload: providerPayload });
    const started = await api.dispatch({ capability: 'audio-monitoring', command: 'start', source: 'user', payload: { requesterId: 'user', authorization: 'user-action', requiredChannelShape: 'mono' } });
    window.feedBack.audioSession.recordOutcome({ domain: 'audio-monitoring', operation: 'start', participantId: 'secret_monitor', providerId: 'secret_monitor', monitoringId: started.payload.monitoringId, sourceId: 'USB Interface Hardware ABC1234', openSessionId: 'open raw id 1234', requesterId: 'user', outcome: 'failed', status: 'timeout', reason: 'failed at /Users/barlind/private secret=abc123' });

    const snapshot = diagnosticsSnapshot(window);
    const encoded = JSON.stringify(snapshot);

    assert.equal(started.outcome, 'handled');
    assert.equal(encoded.includes('USB Interface'), false);
    assert.equal(encoded.includes('ABC1234'), false);
    assert.equal(encoded.includes('Secret Monitor Serial'), false);
    assert.equal(encoded.includes('/Users/barlind'), false);
    assert.equal(encoded.includes('token=abc123'), false);
    assert.equal(encoded.includes('secret=abc123'), false);
    assert.equal(encoded.includes('rawAudioBuffer'), false);
    assert.equal(encoded.includes('rawBuffer'), false);
    assert.equal(encoded.includes('samples'), false);
    assert.equal(encoded.includes('waveform'), false);
    assert.equal(encoded.includes('mediaStream'), false);
    assert.equal(encoded.includes('audioNode'), false);
    assert.equal(encoded.includes('nativeHandle'), false);
    assert.match(encoded, /monitoring-\d+/);
    assert.match(encoded, /source-\d+/);
});