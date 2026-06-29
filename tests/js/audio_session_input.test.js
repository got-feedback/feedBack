const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loadAudioSession, captureEvents, makeInputProvider, makeMonitoringProvider } = require('./audio_session_test_harness');

async function registerSource(api, payload = {}) {
    return api.dispatch({
        capability: 'audio-input',
        command: 'register-source',
        source: payload.providerId || 'test',
        payload: {
            sourceId: 'source-raw-id-12345',
            logicalSourceKey: 'test:instrument:primary',
            providerId: 'test_provider',
            kind: 'instrument',
            safeLabel: 'Input 1',
            channelSummary: { channelCount: 2, channelShape: 'stereo', supports: ['mono', 'stereo'] },
            operations: ['source.open', 'source.close'],
            operationHandlers: {
                'source.open': () => ({ outcome: 'handled', status: 'open', mediaStream: { secret: true } }),
                'source.close': () => ({ outcome: 'handled', status: 'closed', nativeHandle: { secret: true } }),
            },
            ...payload,
        },
    });
}

test('audio-input requires sourceId providerId and logicalSourceKey', async () => {
    const window = loadAudioSession();
    const api = window.feedBack.capabilities;

    const missingSource = await api.dispatch({ capability: 'audio-input', command: 'register-source', source: 'test', payload: { providerId: 'test', logicalSourceKey: 'test:key' } });
    const missingProvider = await api.dispatch({ capability: 'audio-input', command: 'register-source', source: 'test', payload: { sourceId: 'source-1', logicalSourceKey: 'test:key' } });
    const missingLogical = await api.dispatch({ capability: 'audio-input', command: 'register-source', source: 'test', payload: { sourceId: 'source-1', providerId: 'test' } });
    const incompatible = await api.dispatch({ capability: 'audio-input', command: 'register-source', source: 'test', payload: { sourceId: 'source-1', providerId: 'test', logicalSourceKey: 'test:key', version: 99 } });

    assert.equal(missingSource.outcome, 'failed');
    assert.equal(missingProvider.outcome, 'failed');
    assert.equal(missingLogical.outcome, 'failed');
    assert.equal(incompatible.outcome, 'incompatible-version');
});

test('audio-input registration list inspect select and snapshots pseudonymize source identity', async () => {
    const window = loadAudioSession();
    const api = window.feedBack.capabilities;
    const registeredEvents = captureEvents(window, 'audio-input:source-registered');
    const selectedEvents = captureEvents(window, 'audio-input:source-selected');

    const registered = await registerSource(api, { label: 'Scarlett 2i2 Serial 987654' });
    const listed = await api.dispatch({ capability: 'audio-input', command: 'list-sources', source: 'note_detect' });
    const inspected = await api.dispatch({ capability: 'audio-input', command: 'inspect', source: 'note_detect' });
    const selected = await api.dispatch({ capability: 'audio-input', command: 'select-source', source: 'note_detect', payload: { logicalSourceKey: 'test:instrument:primary' } });
    const missing = await api.dispatch({ capability: 'audio-input', command: 'select-source', source: 'note_detect', payload: { sourceId: 'missing-device' } });

    assert.equal(registered.status, 'applied');
    assert.equal(listed.payload.sources.length, 1);
    assert.equal(inspected.payload.totalSources, 1);
    assert.equal(selected.status, 'applied');
    assert.equal(selected.payload.logicalSourceKey, 'test:instrument:primary');
    assert.equal(missing.outcome, 'degraded');
    assert.match(registered.payload.sourceId, /^source-\d+$/);
    assert.match(selected.payload.sourceId, /^source-\d+$/);
    assert.equal(registeredEvents.length, 1);
    assert.equal(selectedEvents.length, 1);

    const encoded = JSON.stringify(window.feedBack.audioSession.snapshot().domains['audio-input']);
    assert.equal(encoded.includes('source-raw-id-12345'), false);
    assert.equal(encoded.includes('Scarlett'), false);
    assert.equal(encoded.includes('987654'), false);
});

test('audio-input pseudonyms are per-bundle: distinct within a snapshot, never leak raw identity', () => {
    const window = loadAudioSession();
    const audioSession = window.feedBack.audioSession;

    audioSession.registerInputSource({ sourceId: 'mic-A', providerId: 'note_detect', logicalSourceKey: 'note_detect:mic-a', label: '/Users/me/My Songs/mic A' });
    audioSession.registerInputSource({ sourceId: 'mic-B', providerId: 'note_detect', logicalSourceKey: 'note_detect:mic-b', label: 'device B' });

    const inputDomain = audioSession.snapshot().domains['audio-input'];
    const pseudonyms = inputDomain.sources.map(source => source.diagnosticsPseudonym);

    // Per-bundle pseudonyms are distinct within one snapshot (spec FR-011/SC-005).
    assert.equal(new Set(pseudonyms).size, pseudonyms.length);
    for (const pseudonym of pseudonyms) assert.match(pseudonym, /^source-\d+$/);

    // Raw source ids/labels never leak into diagnostics.
    const encoded = JSON.stringify(inputDomain);
    assert.equal(encoded.includes('mic-A'), false);
    assert.equal(encoded.includes('/Users/me'), false);
});

test('audio-input degraded select and unknown unregister never leak the raw source id', () => {
    const window = loadAudioSession();
    const audioSession = window.feedBack.audioSession;

    const degraded = audioSession.selectInputSource('/Users/me/secret-device', 'note_detect');
    const removed = audioSession.unregisterInputSource('/Users/me/secret-device');

    assert.equal(degraded.outcome, 'degraded');
    assert.match(degraded.payload.sourceId, /^source-\d+$/);
    assert.equal(removed.outcome, 'no-handler');
    assert.match(removed.payload.sourceId, /^source-\d+$/);

    const encoded = JSON.stringify({ degraded, removed, snapshot: audioSession.snapshot() });
    assert.equal(encoded.includes('/Users/me'), false);
    assert.equal(encoded.includes('secret-device'), false);
});

test('unknown unregister echoes the requested logicalSourceKey/providerId without pseudonymizing them', () => {
    const window = loadAudioSession();
    const audioSession = window.feedBack.audioSession;

    const removed = audioSession.unregisterInputSource({ logicalSourceKey: 'note_detect:instrument:primary', providerId: 'note_detect' });

    assert.equal(removed.outcome, 'no-handler');
    // The logical key is a redaction-safe handle — echoed back verbatim, not pseudonymized as a sourceId.
    assert.equal(removed.payload.logicalSourceKey, 'note_detect:instrument:primary');
    assert.equal(removed.payload.providerId, 'note_detect');
    assert.equal(removed.payload.sourceId, '');
    assert.equal(removed.payload.removed, false);
});

test('unregister-source uses providerId to target the right source among logical-key duplicates', () => {
    const window = loadAudioSession();
    const audioSession = window.feedBack.audioSession;

    audioSession.registerInputSource({ sourceId: 'native-x', logicalSourceKey: 'dup:disambig', providerId: 'native_p', kind: 'instrument', safeLabel: 'N' });
    audioSession.registerInputSource({ sourceId: 'compat-x', logicalSourceKey: 'dup:disambig', providerId: 'compat_p', compatibilitySource: 'legacy', kind: 'instrument', safeLabel: 'C' });

    // Without providerId, priority resolves to the native winner; the compat providerId must target compat.
    const removed = audioSession.unregisterInputSource({ logicalSourceKey: 'dup:disambig', providerId: 'compat_p' });

    assert.equal(removed.outcome, 'handled');
    assert.equal(removed.payload.providerId, 'compat_p');
    assert.equal(audioSession.snapshot().domains['audio-input'].totalSources, 1);
});

test('register-source rejects a sourceId already owned by another provider', async () => {
    const window = loadAudioSession();
    const api = window.feedBack.capabilities;

    const first = await api.dispatch({ capability: 'audio-input', command: 'register-source', source: 'prov_a', payload: { sourceId: 'shared-id', logicalSourceKey: 'a:key', providerId: 'prov_a' } });
    const collision = await api.dispatch({ capability: 'audio-input', command: 'register-source', source: 'prov_b', payload: { sourceId: 'shared-id', logicalSourceKey: 'b:key', providerId: 'prov_b' } });
    // Re-registering the same source by the same provider is still an update, not a collision.
    const update = await api.dispatch({ capability: 'audio-input', command: 'register-source', source: 'prov_a', payload: { sourceId: 'shared-id', logicalSourceKey: 'a:key', providerId: 'prov_a' } });

    assert.equal(first.outcome, 'handled');
    assert.equal(collision.outcome, 'failed');
    assert.equal(update.outcome, 'handled');
    // The original provider's source survives the rejected collision.
    const inspected = await api.dispatch({ capability: 'audio-input', command: 'inspect', source: 'test', payload: { logicalSourceKey: 'a:key' } });
    assert.equal(inspected.payload.source.providerId, 'prov_a');
});

test('register-source rejects a logicalSourceKey that is not redaction-safe', async () => {
    const window = loadAudioSession();
    const api = window.feedBack.capabilities;

    const result = await api.dispatch({ capability: 'audio-input', command: 'register-source', source: 'p', payload: { sourceId: 's1', providerId: 'p', logicalSourceKey: '/Users/me/secret token=abc123' } });

    assert.equal(result.outcome, 'failed');
    // The unsafe key must not be stored or leak into diagnostics.
    const encoded = JSON.stringify(window.feedBack.audioSession.snapshot());
    assert.equal(encoded.includes('/Users/me'), false);
    assert.equal(encoded.includes('token=abc123'), false);
});

test('enumerate denied with an unsafe providerId never leaks it into diagnostics', async () => {
    const window = loadAudioSession();
    const audioSession = window.feedBack.audioSession;

    // Missing explicit/userInitiated -> denied; the caller-supplied providerId is unsafe and is
    // recorded as the outcome participantId/providerId, so it must be bounded in the snapshot.
    const result = await audioSession.enumerateInputSources({ providerId: '/Users/me/p token=xyz789' });

    assert.equal(result.outcome, 'denied');
    const outcomes = audioSession.snapshot().recentOutcomes;
    assert.equal(outcomes.some(outcome => outcome.operation === 'source.enumerate' && outcome.outcome === 'denied'), true);
    const encoded = JSON.stringify(audioSession.snapshot());
    assert.equal(encoded.includes('/Users/me'), false);
    assert.equal(encoded.includes('token=xyz789'), false);
});

test('a malicious dispatch source is redacted before becoming a requesterId in diagnostics', async () => {
    const window = loadAudioSession();
    const api = window.feedBack.capabilities;

    await registerSource(api, { sourceId: 'req-raw', logicalSourceKey: 'test:req' });
    // The capability dispatch `source` (the requester identity) is attacker-controlled here.
    await api.dispatch({ capability: 'audio-input', command: 'select-source', source: '/Users/me/plugin token=abc123', payload: { logicalSourceKey: 'test:req' } });

    const encoded = JSON.stringify(window.feedBack.audioSession.snapshot());
    assert.equal(encoded.includes('/Users/me'), false);
    assert.equal(encoded.includes('abc123'), false);
});

test('caller-provided logical keys are bounded so a path/token cannot leak into diagnostics on a miss', () => {
    const window = loadAudioSession();
    const audioSession = window.feedBack.audioSession;

    // Untrusted callers may pass an unsafe value as a logical key; select/unregister misses must not
    // echo or record it raw into the redaction-safe diagnostics snapshot.
    const selected = audioSession.selectInputSource({ logicalSourceKey: '/Users/me/secret token=abc123' }, 'note_detect');
    const removed = audioSession.unregisterInputSource({ logicalSourceKey: '/Users/me/secret token=abc123', providerId: '/Users/me/provider' });

    assert.equal(selected.outcome, 'degraded');
    assert.equal(removed.outcome, 'no-handler');
    const encoded = JSON.stringify({ selected, removed, snapshot: audioSession.snapshot() });
    assert.equal(encoded.includes('/Users/me'), false);
    assert.equal(encoded.includes('token=abc123'), false);
});

test('audio-monitoring distinguishes a failed state from transient unavailability', async () => {
    const window = loadAudioSession();
    const api = window.feedBack.capabilities;

    await registerSource(api);
    await api.dispatch({ capability: 'audio-input', command: 'select-source', source: 'user', payload: { logicalSourceKey: 'test:instrument:primary' } });
    const failedProvider = makeMonitoringProvider({ providerId: 'mon-failed', startResult: { outcome: 'failed', status: 'failed', reason: 'JUCE barrier failed' } });
    const unavailableProvider = makeMonitoringProvider({ providerId: 'mon-unavail', availability: 'unavailable' });
    await api.dispatch({ capability: 'audio-monitoring', command: 'register-provider', source: 'mon-failed', payload: failedProvider.provider });
    await api.dispatch({ capability: 'audio-monitoring', command: 'register-provider', source: 'mon-unavail', payload: unavailableProvider.provider });

    const failed = await api.dispatch({ capability: 'audio-monitoring', command: 'start', source: 'note_detect', payload: { providerId: 'mon-failed', requesterId: 'note_detect', authorization: 'user-action' } });
    const unavailable = await api.dispatch({ capability: 'audio-monitoring', command: 'start', source: 'note_detect', payload: { providerId: 'mon-unavail', requesterId: 'note_detect', authorization: 'user-action' } });

    assert.equal(failed.outcome, 'failed');
    assert.equal(failed.payload.state, 'failed');
    assert.equal(unavailable.outcome, 'unavailable');
    assert.equal(unavailable.payload.availability, 'unavailable');
});

test('inspect list and select do not call provider enumeration or open handlers', async () => {
    const window = loadAudioSession();
    const api = window.feedBack.capabilities;
    const provider = makeInputProvider({ providerId: 'note_detect', logicalSourceKey: 'note_detect:instrument:primary' });

    await registerSource(api, provider.source);
    await api.dispatch({ capability: 'audio-input', command: 'inspect', source: 'test' });
    await api.dispatch({ capability: 'audio-input', command: 'list-sources', source: 'test' });
    await api.dispatch({ capability: 'audio-input', command: 'select-source', source: 'test', payload: { logicalSourceKey: 'note_detect:instrument:primary' } });

    assert.deepEqual(provider.calls, []);
});

test('open-source and close-source record outcomes events and no live handles', async () => {
    const window = loadAudioSession();
    const api = window.feedBack.capabilities;
    const openedEvents = captureEvents(window, 'audio-input:source-opened');
    const closedEvents = captureEvents(window, 'audio-input:source-closed');
    const degradedEvents = captureEvents(window, 'audio-input:source-open-degraded');
    const deniedEvents = captureEvents(window, 'audio-input:permission-denied');

    await registerSource(api);
    await api.dispatch({ capability: 'audio-input', command: 'select-source', source: 'user', payload: { logicalSourceKey: 'test:instrument:primary' } });
    const open = await api.dispatch({ capability: 'audio-input', command: 'open-source', source: 'note_detect', payload: { requesterId: 'note_detect', requiredChannelShape: 'mono', purpose: 'note-detection' } });
    const close = await api.dispatch({ capability: 'audio-input', command: 'close-source', source: 'note_detect', payload: { requesterId: 'note_detect', openSessionId: open.payload.openSessionId } });

    assert.equal(open.outcome, 'handled');
    assert.equal(open.payload.state, 'open');
    assert.equal(close.outcome, 'handled');
    assert.equal(close.payload.state, 'closed');
    assert.equal(openedEvents.length, 1);
    assert.equal(closedEvents.length, 1);

    await registerSource(api, { sourceId: 'denied-source', logicalSourceKey: 'test:denied', availability: 'denied', reason: 'permission denied token=abc' });
    await api.dispatch({ capability: 'audio-input', command: 'select-source', source: 'user', payload: { logicalSourceKey: 'test:denied' } });
    const denied = await api.dispatch({ capability: 'audio-input', command: 'open-source', source: 'note_detect', payload: { requesterId: 'note_detect' } });
    assert.equal(denied.outcome, 'denied');
    assert.equal(deniedEvents.length, 1);

    await registerSource(api, { sourceId: 'mono-only', logicalSourceKey: 'test:mono', channelSummary: { channelCount: 1, channelShape: 'mono', supports: ['mono'] } });
    await api.dispatch({ capability: 'audio-input', command: 'select-source', source: 'user', payload: { logicalSourceKey: 'test:mono' } });
    const incompatible = await api.dispatch({ capability: 'audio-input', command: 'open-source', source: 'note_detect', payload: { requesterId: 'note_detect', requiredChannelShape: 'stereo' } });
    assert.equal(incompatible.outcome, 'degraded');
    assert.equal(incompatible.payload.state, 'incompatible');
    assert.equal(degradedEvents.length >= 1, true);

    const encoded = JSON.stringify(window.feedBack.audioSession.snapshot());
    assert.equal(encoded.includes('mediaStream'), false);
    assert.equal(encoded.includes('nativeHandle'), false);
    assert.equal(encoded.includes('token=abc'), false);
});

test('open-source returns the actually-bound device for read-back without leaking it into diagnostics', async () => {
    const window = loadAudioSession();
    const api = window.feedBack.capabilities;
    const openedEvents = captureEvents(window, 'audio-input:source-opened');

    await registerSource(api, {
        sourceId: 'readback-source',
        logicalSourceKey: 'test:readback',
        operationHandlers: {
            'source.open': () => ({ outcome: 'handled', status: 'open', payload: { boundType: 'CoreAudio', boundName: 'BlackHole 16ch', requestedName: 'BlackHole 16ch' } }),
            'source.close': () => ({ outcome: 'handled', status: 'closed' }),
        },
    });
    await api.dispatch({ capability: 'audio-input', command: 'select-source', source: 'user', payload: { logicalSourceKey: 'test:readback' } });
    const open = await api.dispatch({ capability: 'audio-input', command: 'open-source', source: 'note_detect', payload: { requesterId: 'note_detect', purpose: 'note-detection' } });

    // The trusted in-process caller (input_setup's confirmation gate) gets the real bound device,
    // so it can show "Now listening to: <device>" and catch a silent wrong-mic substitution.
    assert.equal(open.outcome, 'handled');
    assert.equal(open.payload.bound.type, 'CoreAudio');
    assert.equal(open.payload.bound.name, 'BlackHole 16ch');

    // ...but a raw device name is PII: it must NOT reach the emitted event or the diagnostics snapshot.
    assert.equal(openedEvents.length, 1);
    assert.equal('bound' in openedEvents[0], false);
    const encoded = JSON.stringify(window.feedBack.audioSession.snapshot());
    assert.equal(encoded.includes('BlackHole'), false);
});

test('open-source reports no-owner no-handler unsupported failed and malformed provider data distinctly', async () => {
    const window = loadAudioSession();
    const api = window.feedBack.capabilities;

    const noOwner = await api.dispatch({ capability: 'audio-input', command: 'open-source', source: 'note_detect', payload: { requesterId: 'note_detect' } });
    assert.equal(noOwner.outcome, 'no-owner');

    await registerSource(api, { sourceId: 'no-open', logicalSourceKey: 'test:no-open', providerId: 'no_open_provider', operations: [], operationHandlers: {} });
    await api.dispatch({ capability: 'audio-input', command: 'select-source', source: 'user', payload: { logicalSourceKey: 'test:no-open' } });
    const unsupported = await api.dispatch({ capability: 'audio-input', command: 'open-source', source: 'note_detect', payload: { requesterId: 'note_detect' } });
    assert.equal(unsupported.outcome, 'unsupported-command');

    await registerSource(api, { sourceId: 'no-handler', logicalSourceKey: 'test:no-handler', providerId: 'no_handler_provider', operations: ['source.open'], operationHandlers: {} });
    await api.dispatch({ capability: 'audio-input', command: 'select-source', source: 'user', payload: { logicalSourceKey: 'test:no-handler' } });
    const noHandler = await api.dispatch({ capability: 'audio-input', command: 'open-source', source: 'note_detect', payload: { requesterId: 'note_detect' } });
    assert.equal(noHandler.outcome, 'no-handler');

    await registerSource(api, { sourceId: 'failed', logicalSourceKey: 'test:failed', providerId: 'failed_provider', operationHandlers: { 'source.open': () => { throw new Error('failed near /Users/example/source'); } } });
    await api.dispatch({ capability: 'audio-input', command: 'select-source', source: 'user', payload: { logicalSourceKey: 'test:failed' } });
    const failed = await api.dispatch({ capability: 'audio-input', command: 'open-source', source: 'note_detect', payload: { requesterId: 'note_detect' } });
    assert.equal(failed.outcome, 'failed');

    await registerSource(api, { sourceId: 'malformed', logicalSourceKey: 'test:malformed', providerId: 'malformed_provider', operationHandlers: { 'source.open': () => 'ok' } });
    await api.dispatch({ capability: 'audio-input', command: 'select-source', source: 'user', payload: { logicalSourceKey: 'test:malformed' } });
    const malformed = await api.dispatch({ capability: 'audio-input', command: 'open-source', source: 'note_detect', payload: { requesterId: 'note_detect' } });
    assert.equal(malformed.outcome, 'handled');

    const outcomes = window.feedBack.audioSession.snapshot().recentOutcomes.filter(outcome => outcome.domain === 'audio-input');
    assert.equal(outcomes.some(outcome => outcome.status === 'no-owner' || outcome.outcome === 'no-owner'), true);
    assert.equal(outcomes.some(outcome => outcome.outcome === 'unsupported-command'), true);
    assert.equal(outcomes.some(outcome => outcome.outcome === 'no-handler'), true);
    assert.equal(outcomes.some(outcome => outcome.outcome === 'failed'), true);
});

test('open-source never switches to a non-selected source addressed by raw sourceId or logical key', async () => {
    const window = loadAudioSession();
    const api = window.feedBack.capabilities;

    await registerSource(api, { sourceId: 'primary-raw', logicalSourceKey: 'test:primary' });
    await registerSource(api, { sourceId: 'other-raw', logicalSourceKey: 'test:other' });
    await api.dispatch({ capability: 'audio-input', command: 'select-source', source: 'user', payload: { logicalSourceKey: 'test:primary' } });

    const bySourceId = await api.dispatch({ capability: 'audio-input', command: 'open-source', source: 'note_detect', payload: { requesterId: 'note_detect', sourceId: 'other-raw' } });
    assert.equal(bySourceId.outcome, 'degraded');
    const byKey = await api.dispatch({ capability: 'audio-input', command: 'open-source', source: 'note_detect', payload: { requesterId: 'note_detect', logicalSourceKey: 'test:other' } });
    assert.equal(byKey.outcome, 'degraded');

    const selectedOpen = await api.dispatch({ capability: 'audio-input', command: 'open-source', source: 'note_detect', payload: { requesterId: 'note_detect' } });
    assert.equal(selectedOpen.outcome, 'handled');
    assert.equal(selectedOpen.payload.logicalSourceKey, 'test:primary');
});

test('open-source emits an open-session-shaped payload (with requester attribution) for a pre-denied source', async () => {
    const window = loadAudioSession();
    const api = window.feedBack.capabilities;
    const deniedEvents = captureEvents(window, 'audio-input:permission-denied');

    await registerSource(api, { sourceId: 'predenied-raw', logicalSourceKey: 'test:predenied', availability: 'denied', reason: 'permission denied' });
    await api.dispatch({ capability: 'audio-input', command: 'select-source', source: 'user', payload: { logicalSourceKey: 'test:predenied' } });
    const denied = await api.dispatch({ capability: 'audio-input', command: 'open-source', source: 'note_detect', payload: { requesterId: 'note_detect', purpose: 'note-detection' } });

    assert.equal(denied.outcome, 'denied');
    const payload = deniedEvents[0].payload;
    assert.ok(payload.openSessionId);
    assert.equal(payload.requesters[0].requesterId, 'note_detect');
    assert.equal(payload.requesters[0].purpose, 'note-detection');
    // Requester entries match the real open-session shape — no per-requester openedAt.
    assert.equal('openedAt' in payload.requesters[0], false);
});

test('open-source source-open-degraded uses an open-session-shaped payload when nothing is selected', async () => {
    const window = loadAudioSession();
    const api = window.feedBack.capabilities;
    const degraded = captureEvents(window, 'audio-input:source-open-degraded');

    // No source selected -> degraded; the event must share the OpenInputSessionSummary schema.
    const result = await api.dispatch({ capability: 'audio-input', command: 'open-source', source: 'note_detect', payload: { requesterId: 'note_detect', purpose: 'note-detection' } });

    assert.equal(result.outcome, 'no-owner');
    const payload = degraded[degraded.length - 1].payload;
    assert.ok(payload.openSessionId);
    assert.equal(payload.state, 'unavailable');
    assert.equal(payload.requesters[0].requesterId, 'note_detect');
    assert.equal('openedAt' in payload.requesters[0], false);
});

test('open-source reports the selected source as unavailable when no matching source is registered', async () => {
    const window = loadAudioSession();
    const api = window.feedBack.capabilities;

    await registerSource(api, { sourceId: 'gone-raw', logicalSourceKey: 'test:gone' });
    await api.dispatch({ capability: 'audio-input', command: 'select-source', source: 'user', payload: { logicalSourceKey: 'test:gone' } });
    // The provider unregisters the source while it is still the selected logical key.
    await api.dispatch({ capability: 'audio-input', command: 'unregister-source', source: 'test', payload: { logicalSourceKey: 'test:gone', providerId: 'test_provider' } });

    const open = await api.dispatch({ capability: 'audio-input', command: 'open-source', source: 'note_detect', payload: { requesterId: 'note_detect' } });

    assert.equal(open.outcome, 'degraded');
    // Distinct, accurate message — not the misleading "not the selected source".
    assert.match(open.reason, /selected input source is unavailable/i);
});

test('open-source and close-source ignore a payload requesterId so callers cannot spoof session ownership', async () => {
    const window = loadAudioSession();
    const api = window.feedBack.capabilities;

    await registerSource(api, { sourceId: 'owned-raw', logicalSourceKey: 'test:owned' });
    await api.dispatch({ capability: 'audio-input', command: 'select-source', source: 'user', payload: { logicalSourceKey: 'test:owned' } });

    // The authenticated dispatch caller is note_detect; a spoofed payload requesterId must be ignored.
    const open = await api.dispatch({ capability: 'audio-input', command: 'open-source', source: 'note_detect', payload: { requesterId: 'victim_plugin' } });
    assert.equal(open.outcome, 'handled');
    assert.equal(open.payload.requesters.some(item => item.requesterId === 'note_detect'), true);
    assert.equal(open.payload.requesters.some(item => item.requesterId === 'victim_plugin'), false);

    // A different caller spoofing note_detect's id cannot release note_detect's reference.
    const spoofClose = await api.dispatch({ capability: 'audio-input', command: 'close-source', source: 'attacker', payload: { requesterId: 'note_detect', openSessionId: open.payload.openSessionId } });
    assert.equal(spoofClose.outcome, 'handled');
    assert.equal(spoofClose.payload.state, 'open');
    assert.equal(spoofClose.payload.requesters.some(item => item.requesterId === 'note_detect'), true);
});

test('open-source and close-source propagate a provider non-handled outcome exactly', async () => {
    const window = loadAudioSession();
    const api = window.feedBack.capabilities;

    // source.open returns an explicit non-denied/failed outcome -> must propagate, not collapse to degraded.
    await registerSource(api, { sourceId: 'po-raw', logicalSourceKey: 'test:po', operationHandlers: {
        'source.open': () => ({ outcome: 'unsupported-command', reason: 'no can do' }),
        'source.close': () => ({ outcome: 'handled', status: 'closed' }),
    } });
    await api.dispatch({ capability: 'audio-input', command: 'select-source', source: 'user', payload: { logicalSourceKey: 'test:po' } });
    const openUnsupported = await api.dispatch({ capability: 'audio-input', command: 'open-source', source: 'note_detect', payload: { requesterId: 'note_detect' } });
    assert.equal(openUnsupported.outcome, 'unsupported-command');

    // source.close returns an explicit non-failed outcome -> propagate exactly.
    await registerSource(api, { sourceId: 'pc-raw', logicalSourceKey: 'test:pc', providerId: 'pc_provider', operationHandlers: {
        'source.open': () => ({ outcome: 'handled', status: 'open' }),
        'source.close': () => ({ outcome: 'unsupported-command', reason: 'nope' }),
    } });
    await api.dispatch({ capability: 'audio-input', command: 'select-source', source: 'user', payload: { logicalSourceKey: 'test:pc' } });
    const open = await api.dispatch({ capability: 'audio-input', command: 'open-source', source: 'note_detect', payload: { requesterId: 'note_detect' } });
    assert.equal(open.outcome, 'handled');
    const closeUnsupported = await api.dispatch({ capability: 'audio-input', command: 'close-source', source: 'note_detect', payload: { requesterId: 'note_detect', openSessionId: open.payload.openSessionId } });
    assert.equal(closeUnsupported.outcome, 'unsupported-command');
});

test('close-source accepts logicalKey/sourceKey aliases like the other audio-input paths', async () => {
    const window = loadAudioSession();
    const api = window.feedBack.capabilities;

    await registerSource(api, { sourceId: 'alias-raw', logicalSourceKey: 'test:alias' });
    await api.dispatch({ capability: 'audio-input', command: 'select-source', source: 'user', payload: { logicalSourceKey: 'test:alias' } });
    const open = await api.dispatch({ capability: 'audio-input', command: 'open-source', source: 'note_detect', payload: { requesterId: 'note_detect' } });
    assert.equal(open.outcome, 'handled');

    // Close by the `logicalKey` alias (no openSessionId) — must resolve the same session.
    const close = await api.dispatch({ capability: 'audio-input', command: 'close-source', source: 'note_detect', payload: { requesterId: 'note_detect', logicalKey: 'test:alias' } });
    assert.equal(close.outcome, 'handled');
    assert.equal(close.payload.state, 'closed');
});

test('close-source resolves by logicalSourceKey when requiredChannelShape is omitted', async () => {
    const window = loadAudioSession();
    const api = window.feedBack.capabilities;

    // Default source is stereo; open without a channel-shape hint so the session is keyed by the
    // source's resolved shape, then close by logical key alone (requiredChannelShape is optional).
    await registerSource(api, { sourceId: 'closable-raw', logicalSourceKey: 'test:closable' });
    await api.dispatch({ capability: 'audio-input', command: 'select-source', source: 'user', payload: { logicalSourceKey: 'test:closable' } });
    const open = await api.dispatch({ capability: 'audio-input', command: 'open-source', source: 'note_detect', payload: { requesterId: 'note_detect' } });
    assert.equal(open.outcome, 'handled');

    const close = await api.dispatch({ capability: 'audio-input', command: 'close-source', source: 'note_detect', payload: { requesterId: 'note_detect', logicalSourceKey: 'test:closable' } });
    assert.equal(close.outcome, 'handled');
    assert.equal(close.payload.state, 'closed');
});

test('close-source with an explicit wrong requiredChannelShape does not close a differently-shaped session', async () => {
    const window = loadAudioSession();
    const api = window.feedBack.capabilities;

    // Default source supports mono+stereo; open as mono so the session is keyed by 'mono'.
    await registerSource(api, { sourceId: 'shaped-raw', logicalSourceKey: 'test:shaped' });
    await api.dispatch({ capability: 'audio-input', command: 'select-source', source: 'user', payload: { logicalSourceKey: 'test:shaped' } });
    const open = await api.dispatch({ capability: 'audio-input', command: 'open-source', source: 'note_detect', payload: { requesterId: 'note_detect', requiredChannelShape: 'mono' } });
    assert.equal(open.outcome, 'handled');

    // An explicit, wrong shape must NOT fall back and close the mono session.
    const wrongShape = await api.dispatch({ capability: 'audio-input', command: 'close-source', source: 'note_detect', payload: { requesterId: 'note_detect', logicalSourceKey: 'test:shaped', requiredChannelShape: 'stereo' } });
    assert.equal(wrongShape.outcome, 'no-handler');
    assert.equal(window.feedBack.audioSession.snapshot().domains['audio-input'].totalOpenSessions, 1);

    // The original session still closes via openSessionId.
    const right = await api.dispatch({ capability: 'audio-input', command: 'close-source', source: 'note_detect', payload: { requesterId: 'note_detect', openSessionId: open.payload.openSessionId } });
    assert.equal(right.outcome, 'handled');
});

test('open-source rejects a non-selected duplicate sharing the logical key, addressed by sourceId', async () => {
    const window = loadAudioSession();
    const api = window.feedBack.capabilities;

    // Native + compatibility-backed duplicate share one logical key; the native source wins.
    await registerSource(api, { sourceId: 'native-raw', logicalSourceKey: 'dup:key', providerId: 'native_provider' });
    await registerSource(api, { sourceId: 'compat-raw', logicalSourceKey: 'dup:key', providerId: 'compat_provider', compatibilitySource: 'legacy browser handoff' });
    await api.dispatch({ capability: 'audio-input', command: 'select-source', source: 'user', payload: { logicalSourceKey: 'dup:key' } });

    // Opening by the compatibility duplicate's sourceId must not switch to it.
    const wrong = await api.dispatch({ capability: 'audio-input', command: 'open-source', source: 'note_detect', payload: { requesterId: 'note_detect', sourceId: 'compat-raw' } });
    assert.equal(wrong.outcome, 'degraded');

    // The selected native winner still opens, routed to its own provider.
    const right = await api.dispatch({ capability: 'audio-input', command: 'open-source', source: 'note_detect', payload: { requesterId: 'note_detect', sourceId: 'native-raw' } });
    assert.equal(right.outcome, 'handled');
    assert.equal(right.payload.providerId, 'native_provider');
});

test('inspect resolves a raw sourceId to its source via the stable logical key', async () => {
    const window = loadAudioSession();
    const api = window.feedBack.capabilities;

    await registerSource(api, { sourceId: 'inspect-raw-id', logicalSourceKey: 'test:inspectable' });

    // The snapshot pseudonymizes sourceId, so inspect must resolve the raw provider sourceId itself.
    const byRaw = await api.dispatch({ capability: 'audio-input', command: 'inspect', source: 'test', payload: { sourceId: 'inspect-raw-id' } });
    assert.ok(byRaw.payload.source);
    assert.equal(byRaw.payload.source.logicalSourceKey, 'test:inspectable');

    const byKey = await api.dispatch({ capability: 'audio-input', command: 'inspect', source: 'test', payload: { logicalSourceKey: 'test:inspectable' } });
    assert.ok(byKey.payload.source);
    assert.equal(byKey.payload.source.logicalSourceKey, 'test:inspectable');
});

test('inspect by a shared logical key returns the native winner, not a suppressed duplicate', async () => {
    const window = loadAudioSession();
    const api = window.feedBack.capabilities;

    // Register the compatibility duplicate FIRST so a naive logicalSourceKey-only match would pick it.
    await registerSource(api, { sourceId: 'compat-first', logicalSourceKey: 'dup:inspect', providerId: 'compat_p', compatibilitySource: 'legacy' });
    await registerSource(api, { sourceId: 'native-second', logicalSourceKey: 'dup:inspect', providerId: 'native_p' });

    const inspected = await api.dispatch({ capability: 'audio-input', command: 'inspect', source: 'test', payload: { logicalSourceKey: 'dup:inspect' } });

    assert.ok(inspected.payload.source);
    assert.equal(inspected.payload.source.providerId, 'native_p');
    assert.equal(inspected.payload.source.sourceMode, 'native');
});

test('enumerate preserves a provider-supplied safeLabel through redaction', async () => {
    const window = loadAudioSession();
    const audioSession = window.feedBack.audioSession;
    const provider = makeInputProvider({
        providerId: 'labelled',
        sourceId: 'labelled-bootstrap',
        logicalSourceKey: 'labelled:bootstrap',
        sources: [{ sourceId: 'lbl-1', logicalSourceKey: 'lbl:one', kind: 'instrument', safeLabel: 'Studio Mic' }],
    });
    audioSession.registerInputSource(provider.source);

    const enumerated = await audioSession.enumerateInputSources({ providerId: 'labelled', explicit: true, requesterId: 'settings' });

    assert.equal(enumerated.outcome, 'handled');
    const registered = enumerated.payload.sources.find(source => source.logicalSourceKey === 'lbl:one');
    assert.ok(registered);
    // The explicitly-safe label survives _safeInputValue instead of falling back to a pseudonym.
    assert.equal(registered.label, 'Studio Mic');
});

test('enumerate returns no-handler when providers exist but none support source.enumerate', async () => {
    const window = loadAudioSession();
    const audioSession = window.feedBack.audioSession;

    audioSession.registerInputSource({ sourceId: 'nohandler-raw', logicalSourceKey: 'nh:key', providerId: 'nh_provider', operations: ['source.open'], operationHandlers: { 'source.open': () => ({ outcome: 'handled', status: 'open' }) } });

    const result = await audioSession.enumerateInputSources({ providerId: 'nh_provider', explicit: true, requesterId: 'settings' });
    assert.equal(result.outcome, 'no-handler');
});

test('open-source hint mismatch echoes a pseudonymized sourceId hint without leaking the raw id', async () => {
    const window = loadAudioSession();
    const api = window.feedBack.capabilities;

    await registerSource(api, { sourceId: 'sel-raw', logicalSourceKey: 'test:sel' });
    await registerSource(api, { sourceId: 'other-raw', logicalSourceKey: 'test:other' });
    await api.dispatch({ capability: 'audio-input', command: 'select-source', source: 'user', payload: { logicalSourceKey: 'test:sel' } });

    const open = await api.dispatch({ capability: 'audio-input', command: 'open-source', source: 'note_detect', payload: { requesterId: 'note_detect', sourceId: 'other-raw' } });

    assert.equal(open.outcome, 'degraded');
    assert.match(open.payload.sourceId, /^source-\d+$/);
    const encoded = JSON.stringify({ open, snapshot: window.feedBack.audioSession.snapshot() });
    assert.equal(encoded.includes('other-raw'), false);
});

test('enumerate propagates a provider source.enumerate denial instead of empty success', async () => {
    const window = loadAudioSession();
    const audioSession = window.feedBack.audioSession;
    const provider = makeInputProvider({
        providerId: 'denier',
        sourceId: 'denier-bootstrap',
        logicalSourceKey: 'denier:bootstrap',
        operationHandlers: {
            'source.enumerate': () => ({ outcome: 'denied', reason: 'user declined microphone' }),
        },
    });
    audioSession.registerInputSource(provider.source);

    const enumerated = await audioSession.enumerateInputSources({ providerId: 'denier', explicit: true, requesterId: 'settings' });

    assert.equal(enumerated.outcome, 'denied');
    const outcomes = audioSession.snapshot().recentOutcomes;
    assert.equal(outcomes.some(outcome => outcome.operation === 'source.enumerate' && outcome.outcome === 'denied'), true);

    // A non-denied/failed explicit outcome is preserved exactly (not collapsed to degraded).
    const incompatible = makeInputProvider({
        providerId: 'oldproto',
        sourceId: 'oldproto-bootstrap',
        logicalSourceKey: 'oldproto:bootstrap',
        operationHandlers: { 'source.enumerate': () => ({ outcome: 'incompatible-version', reason: 'needs v1' }) },
    });
    audioSession.registerInputSource(incompatible.source);
    const enumeratedOld = await audioSession.enumerateInputSources({ providerId: 'oldproto', explicit: true, requesterId: 'settings' });
    assert.equal(enumeratedOld.outcome, 'incompatible-version');
});

test('enumerateInputSources returns distinct sourceId pseudonyms across sources', async () => {
    const window = loadAudioSession();
    const audioSession = window.feedBack.audioSession;
    const provider = makeInputProvider({
        providerId: 'multi_provider',
        sourceId: 'mp-bootstrap',
        logicalSourceKey: 'mp:bootstrap',
        sources: [
            { sourceId: 'mp-raw-1', logicalSourceKey: 'mp:one', kind: 'instrument', safeLabel: 'In 1' },
            { sourceId: 'mp-raw-2', logicalSourceKey: 'mp:two', kind: 'instrument', safeLabel: 'In 2' },
        ],
    });
    audioSession.registerInputSource(provider.source);
    const enumerated = await audioSession.enumerateInputSources({ providerId: 'multi_provider', explicit: true, requesterId: 'settings' });

    assert.equal(enumerated.outcome, 'handled');
    assert.equal(enumerated.payload.sources.length, 2);
    const ids = enumerated.payload.sources.map(source => source.sourceId);
    ids.forEach(id => assert.match(id, /^source-\d+$/));
    // Distinct sources must get distinct pseudonyms, not all collapse to `source-01`.
    assert.equal(new Set(ids).size, 2);
});

test('open-session ids correlate between openSessions and recentOutcomes in a snapshot', async () => {
    const window = loadAudioSession();
    const api = window.feedBack.capabilities;

    await registerSource(api, { sourceId: 'corr-raw', logicalSourceKey: 'test:corr' });
    await api.dispatch({ capability: 'audio-input', command: 'select-source', source: 'user', payload: { logicalSourceKey: 'test:corr' } });
    const open = await api.dispatch({ capability: 'audio-input', command: 'open-source', source: 'note_detect', payload: { requesterId: 'note_detect' } });
    assert.equal(open.outcome, 'handled');

    const openId = open.payload.openSessionId;
    const snap = window.feedBack.audioSession.snapshot();
    assert.equal(snap.domains['audio-input'].openSessions[0].openSessionId, openId);
    const openOutcome = snap.recentOutcomes.find(outcome => outcome.operation === 'open-source' && outcome.status === 'open' && outcome.openSessionId);
    assert.ok(openOutcome);
    // The generated input-open id is left verbatim so an outcome correlates with its open session.
    assert.equal(openOutcome.openSessionId, openId);
});

test('startSession closes open input sessions from the previous session before replacing it', async () => {
    const window = loadAudioSession();
    const api = window.feedBack.capabilities;
    const audioSession = window.feedBack.audioSession;
    let providerClosed = 0;

    await registerSource(api, {
        sourceId: 'restart-raw',
        logicalSourceKey: 'test:restart',
        operationHandlers: {
            'source.open': () => ({ outcome: 'handled', status: 'open' }),
            'source.close': () => { providerClosed += 1; return { outcome: 'handled', status: 'closed' }; },
        },
    });
    await api.dispatch({ capability: 'audio-input', command: 'select-source', source: 'user', payload: { logicalSourceKey: 'test:restart' } });
    const open = await api.dispatch({ capability: 'audio-input', command: 'open-source', source: 'note_detect', payload: { requesterId: 'note_detect' } });
    assert.equal(open.outcome, 'handled');

    // A direct song-switch startSession() (no stopSession first) must still release provider capture.
    audioSession.startSession({ sessionId: 'main:next-song' });
    await new Promise(resolve => setImmediate(resolve));

    assert.equal(providerClosed, 1);
    assert.equal(audioSession.snapshot().domains['audio-input'].totalOpenSessions, 0);
});

test('a persisted selected-source key that is not redaction-safe is ignored on restore', () => {
    const window = loadAudioSession();

    // Simulate a tampered/mutated localStorage entry.
    window.localStorage.setItem('feedBack.audioInput.selectedLogicalSourceKey', '/Users/me/evil token=zzz999');
    const snap = window.feedBack.audioSession.startSession({ sessionId: 'main:restore-test' });

    assert.equal(snap.domains['audio-input'].selected, null);
    const encoded = JSON.stringify(snap);
    assert.equal(encoded.includes('/Users/me'), false);
    assert.equal(encoded.includes('token=zzz999'), false);
});

test('stopSession closes open input sessions and notifies providers', async () => {
    const window = loadAudioSession();
    const api = window.feedBack.capabilities;
    const audioSession = window.feedBack.audioSession;
    const closedEvents = captureEvents(window, 'audio-input:source-closed');
    let providerClosed = 0;

    await registerSource(api, {
        sourceId: 'live-raw',
        logicalSourceKey: 'test:live',
        operationHandlers: {
            'source.open': () => ({ outcome: 'handled', status: 'open' }),
            'source.close': () => { providerClosed += 1; return { outcome: 'handled', status: 'closed' }; },
        },
    });
    await api.dispatch({ capability: 'audio-input', command: 'select-source', source: 'user', payload: { logicalSourceKey: 'test:live' } });
    const open = await api.dispatch({ capability: 'audio-input', command: 'open-source', source: 'note_detect', payload: { requesterId: 'note_detect' } });
    assert.equal(open.outcome, 'handled');
    assert.equal(audioSession.snapshot().domains['audio-input'].totalOpenSessions, 1);

    audioSession.stopSession('song switch');
    await new Promise(resolve => setImmediate(resolve));

    assert.equal(audioSession.snapshot().domains['audio-input'].totalOpenSessions, 0);
    assert.equal(closedEvents.length >= 1, true);
    assert.equal(providerClosed, 1);
});

test('startSession keeps the in-memory selection when persistence has failed, ignoring stale storage', async () => {
    const window = loadAudioSession();
    const api = window.feedBack.capabilities;

    // Seed storage with a stale key, then make subsequent writes fail.
    window.localStorage.setItem('feedBack.audioInput.selectedLogicalSourceKey', 'stale:old-input');
    window.localStorage.setItem = () => { throw new Error('quota'); };

    await registerSource(api, { sourceId: 'current-raw', logicalSourceKey: 'current:input' });
    await api.dispatch({ capability: 'audio-input', command: 'select-source', source: 'user', payload: { logicalSourceKey: 'current:input' } });
    assert.equal(window.feedBack.audioSession.snapshot().domains['audio-input'].storageStatus, 'failed');

    const snap = window.feedBack.audioSession.startSession({ sessionId: 'main:after-fail' });

    // Must keep the in-memory 'current:input', not revert to the stale storage key.
    assert.equal(snap.domains['audio-input'].selected.logicalSourceKey, 'current:input');
    assert.equal(snap.domains['audio-input'].storageStatus, 'failed');
});

test('selected source persistence restore and storage-unavailable fallback are stable', async () => {
    const window = loadAudioSession();
    const api = window.feedBack.capabilities;

    await registerSource(api, { sourceId: 'persisted-source', logicalSourceKey: 'persisted:input' });
    await api.dispatch({ capability: 'audio-input', command: 'select-source', source: 'user', payload: { logicalSourceKey: 'persisted:input' } });
    const afterStart = window.feedBack.audioSession.startSession({ sessionId: 'main:next-song' });
    assert.equal(afterStart.domains['audio-input'].selected.logicalSourceKey, 'persisted:input');
    assert.equal(afterStart.domains['audio-input'].selected.restoreStatus, 'restored');

    const noStorageWindow = loadAudioSession();
    noStorageWindow.localStorage.setItem = () => { throw new Error('blocked'); };
    const noStorageApi = noStorageWindow.feedBack.capabilities;
    await registerSource(noStorageApi, { sourceId: 'session-source', logicalSourceKey: 'session:input' });
    await noStorageApi.dispatch({ capability: 'audio-input', command: 'select-source', source: 'user', payload: { logicalSourceKey: 'session:input' } });
    const noStorageSnapshot = noStorageWindow.feedBack.audioSession.startSession({ sessionId: 'main:no-storage-song' });
    assert.equal(noStorageSnapshot.domains['audio-input'].storageStatus, 'failed');
    assert.equal(noStorageSnapshot.domains['audio-input'].selected.logicalSourceKey, 'session:input');
});
