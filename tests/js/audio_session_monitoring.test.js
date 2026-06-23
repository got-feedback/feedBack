const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loadAudioSession, captureEvents, makeInputProvider, makeMonitoringProvider, storageEntries } = require('./audio_session_test_harness');

async function installInput(api, overrides = {}) {
    const input = makeInputProvider({
        providerId: 'desktop_input',
        sourceId: 'desktop-source',
        logicalSourceKey: 'desktop:instrument:primary',
        channelSummary: { channelCount: 2, channelShape: 'stereo', supports: ['mono', 'stereo'] },
        ...overrides,
    });
    await api.dispatch({ capability: 'audio-input', command: 'register-source', source: 'desktop_input', payload: input.source });
    await api.dispatch({ capability: 'audio-input', command: 'select-source', source: 'user', payload: { logicalSourceKey: input.source.logicalSourceKey } });
    return input;
}

async function installMonitoring(api, overrides = {}) {
    const monitoring = makeMonitoringProvider({ providerId: 'desktop_monitor', logicalMonitoringKey: 'desktop:monitor:main', safeLabel: 'Desktop Monitor', ...overrides });
    await api.dispatch({ capability: 'audio-monitoring', command: 'register-provider', source: monitoring.provider.providerId, payload: monitoring.provider });
    return monitoring;
}

test('audio-monitoring starts and stops through selected provider and source', async () => {
    const window = loadAudioSession();
    const api = window.feedBack.capabilities;
    const startedEvents = captureEvents(window, 'audio-monitoring:monitoring-started');
    const stoppedEvents = captureEvents(window, 'audio-monitoring:monitoring-stopped');
    const input = await installInput(api);
    const monitoring = await installMonitoring(api);

    const active = await api.dispatch({ capability: 'audio-monitoring', command: 'start', source: 'user', payload: { requesterId: 'user', authorization: 'user-action', requiredChannelShape: 'mono' } });
    const stopped = await api.dispatch({ capability: 'audio-monitoring', command: 'stop', source: 'user', payload: { requesterId: 'user', monitoringId: active.payload.monitoringId } });
    const snapshot = window.feedBack.audioSession.snapshot().domains['audio-monitoring'];

    assert.equal(active.outcome, 'handled');
    assert.equal(active.payload.state, 'active');
    assert.equal(active.payload.sourceRef.logicalSourceKey, 'desktop:instrument:primary');
    assert.equal(stopped.outcome, 'stopped');
    assert.equal(startedEvents.length, 1);
    assert.equal(stoppedEvents.length, 1);
    assert.deepEqual(monitoring.calls.map(call => call[0]), ['monitoring.start', 'monitoring.stop']);
    assert.deepEqual(input.calls.map(call => call[0]), ['source.open']);
    assert.equal(snapshot.sessions.some(session => session.state === 'stopped'), true);
});

test('audio-monitoring redacts circular provider payloads without overflowing', async () => {
    const window = loadAudioSession();
    const api = window.feedBack.capabilities;
    const circular = { directMonitor: { state: 'muted' }, latencySummary: { bucket: 'low' } };
    circular.self = circular;
    await installInput(api);
    await installMonitoring(api, {
        operationHandlers: {
            'monitoring.start': () => ({ outcome: 'handled', status: 'active', payload: circular }),
        },
    });

    const active = await api.dispatch({ capability: 'audio-monitoring', command: 'start', source: 'user', payload: { requesterId: 'user', authorization: 'user-action', requiredChannelShape: 'mono' } });
    const snapshot = window.feedBack.audioSession.snapshot().domains['audio-monitoring'];

    assert.equal(active.outcome, 'handled');
    assert.equal(snapshot.sessions[0].state, 'active');
});

test('audio-monitoring snapshots redact session identifiers and source refs', async () => {
    const window = loadAudioSession();
    const api = window.feedBack.capabilities;
    await installInput(api);
    await installMonitoring(api);

    const active = await api.dispatch({ capability: 'audio-monitoring', command: 'start', source: 'user', payload: { requesterId: 'user', authorization: 'user-action', requiredChannelShape: 'mono' } });
    const snapshot = window.feedBack.audioSession.snapshot().domains['audio-monitoring'];
    const session = snapshot.sessions[0];
    const encoded = JSON.stringify(snapshot);

    assert.equal(active.outcome, 'handled');
    assert.notEqual(session.monitoringId, active.payload.monitoringId);
    assert.notEqual(session.sessionKey, active.payload.sessionKey);
    assert.equal(session.sessionKey.includes('::'), false);
    assert.equal(encoded.includes('desktop-source'), false);
});

test('audio-monitoring reports no provider unavailable degraded denied failed user action and reload boundaries', async () => {
    const window = loadAudioSession();
    const api = window.feedBack.capabilities;
    const degradedEvents = captureEvents(window, 'audio-monitoring:monitoring-degraded');
    const deniedEvents = captureEvents(window, 'audio-monitoring:monitoring-denied');
    const unavailableEvents = captureEvents(window, 'audio-monitoring:monitoring-unavailable');
    const failedEvents = captureEvents(window, 'audio-monitoring:monitoring-failed');
    const userActionEvents = captureEvents(window, 'audio-monitoring:monitoring-user-action-required');
    await installInput(api);

    const noProvider = await api.dispatch({ capability: 'audio-monitoring', command: 'start', source: 'user', payload: { requesterId: 'user', authorization: 'user-action' } });
    const unavailableProvider = await installMonitoring(api, { providerId: 'unavailable_monitor', logicalMonitoringKey: 'unavailable:main', availability: 'unavailable', operations: ['monitoring.start'] });
    const unavailable = await api.dispatch({ capability: 'audio-monitoring', command: 'start', source: 'user', payload: { providerId: unavailableProvider.provider.providerId, requesterId: 'user', authorization: 'user-action' } });
    await api.dispatch({ capability: 'audio-monitoring', command: 'unregister-provider', source: 'test', payload: { providerId: unavailableProvider.provider.providerId } });

    const degradedProvider = await installMonitoring(api, { providerId: 'degraded_monitor', logicalMonitoringKey: 'degraded:main', startResult: { outcome: 'degraded', status: 'degraded', reason: 'high latency', summary: { latencySummary: { bucket: 'high' } } } });
    const degraded = await api.dispatch({ capability: 'audio-monitoring', command: 'start', source: 'user', payload: { providerId: degradedProvider.provider.providerId, requesterId: 'user', authorization: 'user-action' } });
    await api.dispatch({ capability: 'audio-monitoring', command: 'unregister-provider', source: 'test', payload: { providerId: degradedProvider.provider.providerId } });

    const deniedProvider = await installMonitoring(api, { providerId: 'denied_monitor', logicalMonitoringKey: 'denied:main', startResult: { outcome: 'denied', status: 'denied', reason: 'permission denied' } });
    const denied = await api.dispatch({ capability: 'audio-monitoring', command: 'start', source: 'user', payload: { providerId: deniedProvider.provider.providerId, requesterId: 'user', authorization: 'user-action' } });
    await api.dispatch({ capability: 'audio-monitoring', command: 'unregister-provider', source: 'test', payload: { providerId: deniedProvider.provider.providerId } });

    const failedProvider = await installMonitoring(api, { providerId: 'failed_monitor', logicalMonitoringKey: 'failed:main', operationHandlers: { 'monitoring.start': () => { throw new Error('boom'); } } });
    const failed = await api.dispatch({ capability: 'audio-monitoring', command: 'start', source: 'user', payload: { providerId: failedProvider.provider.providerId, requesterId: 'user', authorization: 'user-action' } });
    const background = await api.dispatch({ capability: 'audio-monitoring', command: 'start', source: 'note_detect', payload: { providerId: failedProvider.provider.providerId, requesterId: 'note_detect', authorization: 'background' } });
    const activeProvider = await installMonitoring(api, { providerId: 'active_monitor', logicalMonitoringKey: 'active:main' });
    const activeBeforeSwitch = await api.dispatch({ capability: 'audio-monitoring', command: 'start', source: 'user', payload: { providerId: activeProvider.provider.providerId, requesterId: 'user', authorization: 'user-action' } });

    assert.equal(noProvider.outcome, 'no-owner');
    assert.equal(unavailable.outcome, 'unavailable');
    assert.equal(degraded.outcome, 'degraded');
    assert.equal(denied.outcome, 'denied');
    assert.equal(failed.outcome, 'failed');
    assert.equal(background.outcome, 'user-action-required');
    assert.equal(degradedEvents.length >= 1, true);
    assert.equal(deniedEvents.length >= 1, true);
    // user-action-required must surface as its own event, not as a 'monitoring-denied' permission signal.
    assert.equal(userActionEvents.length >= 1, true);
    assert.equal(deniedEvents.some(detail => detail && detail.requesterId === 'note_detect'), false);
    assert.equal(unavailableEvents.length >= 1, true);
    assert.equal(failedEvents.length >= 1, true);
    assert.equal(activeBeforeSwitch.outcome, 'handled');

    window.feedBack.audioSession.startSession({ sessionId: 'main:next-song' });
    const afterSongSwitch = window.feedBack.audioSession.snapshot().domains['audio-monitoring'];
    assert.equal(afterSongSwitch.sessions.some(session => session.state === 'active'), true);

    const restoredWindow = loadAudioSession({ storage: storageEntries(window) });
    const restored = restoredWindow.feedBack.audioSession.snapshot().domains['audio-monitoring'];
    assert.equal(restored.sessions.length, 0);
});

test('audio-monitoring provider registration is idempotent and selected provider is deterministic', async () => {
    const window = loadAudioSession();
    const api = window.feedBack.capabilities;
    await installInput(api);
    const legacy = await installMonitoring(api, { providerId: 'legacy_monitor', logicalMonitoringKey: 'shared:monitor', sourceMode: 'compatibility', compatibilitySource: 'legacy.monitor' });
    const native = await installMonitoring(api, { providerId: 'native_monitor', logicalMonitoringKey: 'shared:monitor', sourceMode: 'native', safeLabel: 'Native Monitor' });
    await api.dispatch({ capability: 'audio-monitoring', command: 'register-provider', source: 'native_monitor', payload: { ...native.provider, availability: 'pending' } });

    const listed = await api.dispatch({ capability: 'audio-monitoring', command: 'list-providers', source: 'test' });
    const snapshot = window.feedBack.audioSession.snapshot().domains['audio-monitoring'];
    assert.equal(listed.payload.providers.length, 1);
    assert.equal(listed.payload.providers[0].providerId, 'native_monitor');
    assert.equal(snapshot.providers.some(provider => provider.providerId === 'legacy_monitor' && provider.supersededBy), true);

    await installMonitoring(api, { providerId: 'browser_monitor', logicalMonitoringKey: 'browser:monitor' });
    const selectionRequired = await api.dispatch({ capability: 'audio-monitoring', command: 'start', source: 'user', payload: { requesterId: 'user', authorization: 'user-action' } });
    assert.equal(selectionRequired.outcome, 'provider-selection-required');

    const selected = await api.dispatch({ capability: 'audio-monitoring', command: 'select-provider', source: 'user', payload: { providerId: 'native_monitor' } });
    assert.equal(selected.outcome, 'handled');
    assert.equal(selected.payload.logicalMonitoringKey, 'shared:monitor');
    assert.equal(legacy.calls.length, 0);
});

test('audio-monitoring shares compatible sessions and stops provider after final requester', async () => {
    const window = loadAudioSession();
    const api = window.feedBack.capabilities;
    await installInput(api);
    const monitoring = await installMonitoring(api);

    const first = await api.dispatch({ capability: 'audio-monitoring', command: 'start', source: 'user', payload: { requesterId: 'user', authorization: 'user-action', requiredChannelShape: 'mono' } });
    const second = await api.dispatch({ capability: 'audio-monitoring', command: 'start', source: 'note_detect', payload: { requesterId: 'note_detect', authorization: 'background', requiredChannelShape: 'mono' } });
    const stopFirst = await api.dispatch({ capability: 'audio-monitoring', command: 'stop', source: 'user', payload: { requesterId: 'note_detect', monitoringId: first.payload.monitoringId } });
    const stopSecond = await api.dispatch({ capability: 'audio-monitoring', command: 'stop', source: 'note_detect', payload: { requesterId: 'note_detect', monitoringId: second.payload.monitoringId } });

    assert.equal(first.outcome, 'handled');
    assert.equal(second.outcome, 'handled');
    assert.equal(first.payload.monitoringId, second.payload.monitoringId);
    assert.equal(stopFirst.payload.state, 'active');
    assert.equal(stopFirst.payload.requesters.map(item => item.requesterId).join(','), 'note_detect');
    assert.equal(stopSecond.outcome, 'stopped');
    assert.deepEqual(monitoring.calls.map(call => call[0]), ['monitoring.start', 'monitoring.stop']);

    const activeAgain = await api.dispatch({ capability: 'audio-monitoring', command: 'start', source: 'user', payload: { requesterId: 'user', authorization: 'user-action', requiredChannelShape: 'mono' } });
    await api.dispatch({ capability: 'audio-monitoring', command: 'unregister-provider', source: 'system', payload: { providerId: monitoring.provider.providerId } });
    const afterDisappear = window.feedBack.audioSession.snapshot().domains['audio-monitoring'];
    assert.equal(activeAgain.outcome, 'handled');
    assert.equal(afterDisappear.sessions.some(session => session.state === 'orphaned'), true);
});

test('audio-monitoring owner can retry a stop after a transient provider stop failure', async () => {
    const window = loadAudioSession();
    const api = window.feedBack.capabilities;
    await installInput(api);
    let stopCalls = 0;
    await installMonitoring(api, {
        operationHandlers: {
            'monitoring.stop': () => {
                stopCalls += 1;
                if (stopCalls === 1) return { outcome: 'failed', reason: 'transient stop failure' };
                return { outcome: 'handled', status: 'stopped' };
            },
        },
    });

    const active = await api.dispatch({ capability: 'audio-monitoring', command: 'start', source: 'user', payload: { authorization: 'user-action', requiredChannelShape: 'mono' } });
    const stopFails = await api.dispatch({ capability: 'audio-monitoring', command: 'stop', source: 'user', payload: { monitoringId: active.payload.monitoringId } });
    // The failed final stop emptied the requester list before the provider confirmed; the original
    // owner must still be able to retry rather than being locked out as a non-owner.
    const stopRetry = await api.dispatch({ capability: 'audio-monitoring', command: 'stop', source: 'user', payload: { monitoringId: active.payload.monitoringId } });

    assert.equal(active.outcome, 'handled');
    assert.equal(stopFails.outcome, 'failed');
    assert.equal(stopRetry.outcome, 'stopped');
    assert.equal(stopCalls, 2);
});

test('audio-monitoring surfaces a provider denial reason even when a direct-monitor conflict is present', async () => {
    const window = loadAudioSession();
    const api = window.feedBack.capabilities;
    await installInput(api);
    await installMonitoring(api, { startResult: { outcome: 'handled', status: 'denied', reason: 'microphone permission blocked' } });

    await api.dispatch({ capability: 'audio-monitoring', command: 'set-direct-monitor', source: 'user', payload: { state: 'unmuted' } });
    // Provider reports a terminal denial while the request also carries a conflicting direct-monitor
    // requirement; the terminal provider reason must win, not the conflict message.
    const denied = await api.dispatch({ capability: 'audio-monitoring', command: 'start', source: 'user', payload: { authorization: 'user-action', requiredChannelShape: 'mono', directMonitorRequirement: 'muted' } });

    assert.equal(denied.outcome, 'denied');
    assert.match(denied.reason, /permission blocked/i);
    assert.equal(/conflict/i.test(denied.reason || ''), false);
});

test('audio-monitoring normalizes an unsafe provider id before storing it', async () => {
    const window = loadAudioSession();
    const api = window.feedBack.capabilities;
    await installInput(api);

    await api.dispatch({ capability: 'audio-monitoring', command: 'register-provider', source: 'evil', payload: { providerId: '/Users/secret token=abcdef0123456789 monitor', logicalMonitoringKey: 'evil:main', operations: ['monitoring.start'], operationHandlers: { 'monitoring.start': () => ({ outcome: 'handled', status: 'active' }) } } });
    const snapshot = window.feedBack.audioSession.snapshot().domains['audio-monitoring'];
    const provider = snapshot.providers[0];

    // The surfaced providerId must be redacted + charset-restricted, never the raw path/token.
    assert.equal(JSON.stringify(snapshot).includes('token=abcdef0123456789'), false);
    assert.equal(provider.providerId.includes('/'), false);
    assert.equal(provider.providerId.includes(' '), false);
});

test('audio-monitoring bounds caller-supplied identifiers reflected back in error reasons', async () => {
    const window = loadAudioSession();
    const api = window.feedBack.capabilities;
    await installInput(api);
    const evil = '/Users/secret/private token=supersecretvalue123 ' + 'x'.repeat(400);

    const stop = await api.dispatch({ capability: 'audio-monitoring', command: 'stop', source: 'user', payload: { monitoringId: evil } });
    const select = await api.dispatch({ capability: 'audio-monitoring', command: 'select-provider', source: 'user', payload: { providerId: evil } });
    const unregister = await api.dispatch({ capability: 'audio-monitoring', command: 'unregister-provider', source: 'user', payload: { providerId: evil } });

    assert.equal(stop.outcome, 'no-handler');
    assert.equal(select.outcome, 'unavailable');
    assert.equal(unregister.outcome, 'no-handler');
    // Reflected identifiers must be bounded (no raw token, length-capped) before being returned.
    assert.equal(stop.payload.monitoringId.length <= 240, true);
    assert.equal(select.payload.logicalMonitoringKey.length <= 240, true);
    assert.equal(unregister.payload.providerId.length <= 240, true);
    for (const result of [stop, select, unregister]) {
        assert.equal(JSON.stringify(result).includes('token=supersecretvalue123'), false);
    }
});

test('audio-monitoring attaching to a shared session honors a conflicting direct-monitor requirement', async () => {
    const window = loadAudioSession();
    const api = window.feedBack.capabilities;
    await installInput(api);
    await installMonitoring(api);

    await api.dispatch({ capability: 'audio-monitoring', command: 'set-direct-monitor', source: 'user', payload: { state: 'unmuted' } });
    const first = await api.dispatch({ capability: 'audio-monitoring', command: 'start', source: 'user', payload: { authorization: 'user-action', requiredChannelShape: 'mono' } });
    const attach = await api.dispatch({ capability: 'audio-monitoring', command: 'start', source: 'note_detect', payload: { authorization: 'user-action', requiredChannelShape: 'mono', directMonitorRequirement: 'muted' } });

    assert.equal(first.outcome, 'handled');
    // Same shared session, but the conflicting requirement must surface as degraded with an annotation.
    assert.equal(attach.payload.monitoringId, first.payload.monitoringId);
    assert.equal(attach.outcome, 'degraded');
    const requester = attach.payload.requesters.find(item => item.requesterId === 'note_detect');
    assert.equal(requester.status, 'degraded');
});

test('audio-monitoring start never lets a caller inject raw sourceRef fields', async () => {
    const window = loadAudioSession();
    const api = window.feedBack.capabilities;
    await installInput(api);
    await installMonitoring(api);

    const first = await api.dispatch({ capability: 'audio-monitoring', command: 'start', source: 'user', payload: { authorization: 'user-action', requiredChannelShape: 'mono' } });
    const realOpenId = first.payload.sourceRef.openSessionId;
    assert.match(realOpenId, /^input-open-\d+$/);
    // A caller passing a tracked openSessionId alongside an injected raw sourceId must not get that raw
    // value into the monitoring session/response — the sourceRef is derived only from openInputSource.
    const injected = await api.dispatch({ capability: 'audio-monitoring', command: 'start', source: 'note_detect', payload: { authorization: 'user-action', requiredChannelShape: 'mono', sourceRef: { openSessionId: realOpenId, sourceId: 'EVIL-/Users/secret-token-abc123' } } });

    assert.equal(first.outcome, 'handled');
    assert.equal(JSON.stringify(injected.payload).includes('EVIL'), false);
    assert.equal(JSON.stringify(injected.payload).includes('secret-token'), false);
});

test('audio-monitoring start treats a void provider result as failed', async () => {
    const window = loadAudioSession();
    const api = window.feedBack.capabilities;
    await installInput(api);
    await installMonitoring(api, { providerId: 'void_monitor', logicalMonitoringKey: 'void:main', operationHandlers: { 'monitoring.start': () => undefined } });

    const started = await api.dispatch({ capability: 'audio-monitoring', command: 'start', source: 'user', payload: { providerId: 'void_monitor', authorization: 'user-action', requiredChannelShape: 'mono' } });

    // A provider that returns nothing from monitoring.start must not be reported as active.
    assert.equal(started.outcome, 'failed');
});

test('audio-monitoring stopAll requires explicit user action', async () => {
    const window = loadAudioSession();
    const api = window.feedBack.capabilities;
    await installInput(api);
    await installMonitoring(api);

    const active = await api.dispatch({ capability: 'audio-monitoring', command: 'start', source: 'user', payload: { authorization: 'user-action', requiredChannelShape: 'mono' } });
    // A background requester must not be able to tear down everyone's monitoring.
    const background = await api.dispatch({ capability: 'audio-monitoring', command: 'stop', source: 'note_detect', payload: { stopAll: true } });
    const mid = window.feedBack.audioSession.snapshot().domains['audio-monitoring'];
    // An explicit user action can.
    const user = await api.dispatch({ capability: 'audio-monitoring', command: 'stop', source: 'user', payload: { stopAll: true, authorization: 'user-action' } });

    assert.equal(active.outcome, 'handled');
    assert.equal(background.outcome, 'user-action-required');
    assert.equal(mid.sessions.some(session => session.state === 'active'), true);
    assert.equal(user.outcome, 'stopped');
});

test('audio-monitoring stop does not report stopped when the provider reports a terminal status', async () => {
    const window = loadAudioSession();
    const api = window.feedBack.capabilities;
    await installInput(api);
    await installMonitoring(api, { stopResult: { outcome: 'handled', status: 'failed', reason: 'device fell off the bus' } });

    const active = await api.dispatch({ capability: 'audio-monitoring', command: 'start', source: 'user', payload: { authorization: 'user-action', requiredChannelShape: 'mono' } });
    const stop = await api.dispatch({ capability: 'audio-monitoring', command: 'stop', source: 'user', payload: { monitoringId: active.payload.monitoringId } });

    assert.equal(active.outcome, 'handled');
    // Provider said handled but reported a terminal failed status — must surface failed, not stopped.
    assert.equal(stop.outcome, 'failed');
    assert.equal(stop.payload.state, 'failed');
});

test('audio-monitoring stop reports no-owner when the provider has disappeared', async () => {
    const window = loadAudioSession();
    const api = window.feedBack.capabilities;
    await installInput(api);
    const monitoring = await installMonitoring(api);

    const active = await api.dispatch({ capability: 'audio-monitoring', command: 'start', source: 'user', payload: { authorization: 'user-action', requiredChannelShape: 'mono' } });
    await api.dispatch({ capability: 'audio-monitoring', command: 'unregister-provider', source: 'system', payload: { providerId: monitoring.provider.providerId } });
    const stopped = await api.dispatch({ capability: 'audio-monitoring', command: 'stop', source: 'user', payload: { monitoringId: active.payload.monitoringId } });

    assert.equal(active.outcome, 'handled');
    // The provider is gone, so we cannot confirm the live capture stopped — orphan rather than 'stopped'.
    assert.equal(stopped.outcome, 'no-owner');
    assert.equal(stopped.payload.state, 'orphaned');
});

test('audio-monitoring stop reports unsupported-command when the provider has no stop operation', async () => {
    const window = loadAudioSession();
    const api = window.feedBack.capabilities;
    await installInput(api);
    await installMonitoring(api, { providerId: 'nostop_monitor', logicalMonitoringKey: 'nostop:main', operations: ['monitoring.start'] });

    const active = await api.dispatch({ capability: 'audio-monitoring', command: 'start', source: 'user', payload: { providerId: 'nostop_monitor', authorization: 'user-action', requiredChannelShape: 'mono' } });
    const stopped = await api.dispatch({ capability: 'audio-monitoring', command: 'stop', source: 'user', payload: { monitoringId: active.payload.monitoringId } });

    assert.equal(active.outcome, 'handled');
    // No stop operation means we must not pretend the live capture stopped.
    assert.equal(stopped.outcome, 'unsupported-command');
});

test('audio-monitoring events emit redaction-safe sessions', async () => {
    const window = loadAudioSession();
    const api = window.feedBack.capabilities;
    const startedEvents = captureEvents(window, 'audio-monitoring:monitoring-started');
    await installInput(api);
    await installMonitoring(api);

    const active = await api.dispatch({ capability: 'audio-monitoring', command: 'start', source: 'user', payload: { authorization: 'user-action', requiredChannelShape: 'mono' } });

    assert.equal(active.outcome, 'handled');
    assert.equal(startedEvents.length, 1);
    const evt = startedEvents[0];
    // Events are broadcast to all observers, so internal ids/keys and the raw sourceId must be redacted
    // (matching diagnostics) rather than emitted as a raw clone.
    assert.notEqual(evt.monitoringId, active.payload.monitoringId);
    assert.notEqual(evt.sessionKey, active.payload.sessionKey);
    assert.equal(JSON.stringify(evt).includes('desktop-source'), false);
});

test('audio-monitoring rejects a providerId collision from a different owner', async () => {
    const window = loadAudioSession();
    const api = window.feedBack.capabilities;
    await installInput(api);
    const first = makeMonitoringProvider({ providerId: 'shared_id', ownerPluginId: 'plugin_a', logicalMonitoringKey: 'a:main' });
    const second = makeMonitoringProvider({ providerId: 'shared_id', ownerPluginId: 'plugin_b', logicalMonitoringKey: 'b:main' });

    const reg1 = await api.dispatch({ capability: 'audio-monitoring', command: 'register-provider', source: 'plugin_a', payload: first.provider });
    const reg2 = await api.dispatch({ capability: 'audio-monitoring', command: 'register-provider', source: 'plugin_b', payload: second.provider });
    // The guard must also hold when the colliding registration omits ownerPluginId (no silent inherit).
    const sneaky = makeMonitoringProvider({ providerId: 'shared_id', logicalMonitoringKey: 'c:main' });
    delete sneaky.provider.ownerPluginId;
    const reg3 = await api.dispatch({ capability: 'audio-monitoring', command: 'register-provider', source: 'plugin_c', payload: sneaky.provider });
    const snapshot = window.feedBack.audioSession.snapshot().domains['audio-monitoring'];

    assert.equal(reg1.outcome, 'handled');
    assert.equal(reg2.outcome, 'failed');
    assert.equal(reg3.outcome, 'failed');
    // The original owner's provider must remain intact, not be silently overwritten.
    const provider = snapshot.providers.find(entry => entry.providerId === 'shared_id');
    assert.equal(provider.logicalMonitoringKey, 'a:main');
});

test('audio-monitoring session keeps openInputSessionId verbatim for cross-domain correlation', async () => {
    const window = loadAudioSession();
    const api = window.feedBack.capabilities;
    await installInput(api);
    await installMonitoring(api);

    const active = await api.dispatch({ capability: 'audio-monitoring', command: 'start', source: 'user', payload: { authorization: 'user-action', requiredChannelShape: 'mono' } });
    const session = window.feedBack.audioSession.snapshot().domains['audio-monitoring'].sessions.at(-1);

    assert.equal(active.outcome, 'handled');
    assert.match(active.payload.openInputSessionId, /^input-open-\d+$/);
    // The redacted snapshot must keep the real input-open id verbatim (not a fresh pseudonym) so it
    // still correlates with the audio-input open session inside the same diagnostics snapshot.
    assert.equal(session.openInputSessionId, active.payload.openInputSessionId);
    assert.equal(session.sourceRef.openSessionId, active.payload.openInputSessionId);
});

test('audio-monitoring status refresh tolerates a void provider result without faking active', async () => {
    const window = loadAudioSession();
    const api = window.feedBack.capabilities;
    await installInput(api);
    await installMonitoring(api, { availability: 'available', operationHandlers: { 'monitoring.status': () => undefined } });

    await api.dispatch({ capability: 'audio-monitoring', command: 'inspect', source: 'user', payload: { includeStatus: true } });
    const outcomes = window.feedBack.audioSession.snapshot().recentOutcomes.filter(entry => entry.domain === 'audio-monitoring' && entry.operation === 'status');

    // A void status reply is tolerated but must not be recorded as an 'active' session.
    assert.equal(outcomes.length >= 1, true);
    assert.equal(outcomes.every(entry => entry.status !== 'active'), true);
});

test('audio-monitoring status refresh does not leak the raw device sourceId to providers', async () => {
    const window = loadAudioSession();
    const api = window.feedBack.capabilities;
    await installInput(api);
    let statusSourceRef = null;
    await installMonitoring(api, { operationHandlers: { 'monitoring.status': (request) => { statusSourceRef = request.sourceRef; return { outcome: 'handled', status: 'active' }; } } });

    await api.dispatch({ capability: 'audio-monitoring', command: 'inspect', source: 'user', payload: { includeStatus: true } });

    assert.notEqual(statusSourceRef, null);
    // The prompt-free status request must not carry the raw device sourceId.
    assert.equal(statusSourceRef.sourceId, '');
    assert.equal(JSON.stringify(statusSourceRef).includes('desktop-source'), false);
});

test('audio-monitoring status refresh does not downgrade availability on a non-state provider reply', async () => {
    const window = loadAudioSession();
    const api = window.feedBack.capabilities;
    await installInput(api);
    await installMonitoring(api, { availability: 'available', statusResult: { outcome: 'no-handler' } });

    const inspected = await api.dispatch({ capability: 'audio-monitoring', command: 'inspect', source: 'user', payload: { includeStatus: true } });
    const provider = inspected.payload.providers.find(entry => entry.providerId === 'desktop_monitor');

    // A status handler that returns a non-state outcome (no availability) must leave the provider's
    // availability intact rather than clamping it to 'unknown'.
    assert.equal(provider.availability, 'available');
});

test('audio-monitoring re-keys active sessions on a preference change so requesters still attach', async () => {
    const window = loadAudioSession();
    const api = window.feedBack.capabilities;
    await installInput(api);
    await installMonitoring(api);

    await api.dispatch({ capability: 'audio-monitoring', command: 'set-direct-monitor', source: 'user', payload: { state: 'muted' } });
    const first = await api.dispatch({ capability: 'audio-monitoring', command: 'start', source: 'user', payload: { authorization: 'user-action', requiredChannelShape: 'mono' } });
    // User flips the preference; the active session's key must follow it.
    await api.dispatch({ capability: 'audio-monitoring', command: 'set-direct-monitor', source: 'user', payload: { state: 'unmuted' } });
    // A background requester should now attach to the existing session under the new preference,
    // rather than failing to match and being told user-action-required.
    const attach = await api.dispatch({ capability: 'audio-monitoring', command: 'start', source: 'note_detect', payload: { authorization: 'background', requiredChannelShape: 'mono' } });

    assert.equal(first.outcome, 'handled');
    assert.equal(attach.outcome, 'handled');
    assert.equal(attach.payload.monitoringId, first.payload.monitoringId);
});

test('audio-monitoring does not assume direct-monitor applied without provider confirmation', async () => {
    const window = loadAudioSession();
    const api = window.feedBack.capabilities;
    await installInput(api);
    await installMonitoring(api, { directMonitorResult: { outcome: 'handled' } });

    await api.dispatch({ capability: 'audio-monitoring', command: 'start', source: 'user', payload: { authorization: 'user-action', requiredChannelShape: 'mono' } });
    const changed = await api.dispatch({ capability: 'audio-monitoring', command: 'set-direct-monitor', source: 'user', payload: { state: 'unmuted' } });
    const snapshot = window.feedBack.audioSession.snapshot().domains['audio-monitoring'];

    assert.equal(changed.outcome, 'handled');
    // The provider handled the request but did not confirm application, so applied must stay false.
    assert.equal(snapshot.sessions.at(-1).directMonitor.applied, false);
    assert.equal(snapshot.directMonitor.applied, false);
});

test('audio-monitoring direct-monitor summary preserves an unavailable control state', async () => {
    const window = loadAudioSession();
    const api = window.feedBack.capabilities;
    await installInput(api);
    await installMonitoring(api, {
        directMonitorResult: { outcome: 'handled', summary: { directMonitor: { state: 'unmuted', control: 'unavailable', applied: false, reason: 'temporarily unavailable' } } },
    });

    await api.dispatch({ capability: 'audio-monitoring', command: 'start', source: 'user', payload: { authorization: 'user-action', requiredChannelShape: 'mono' } });
    const changed = await api.dispatch({ capability: 'audio-monitoring', command: 'set-direct-monitor', source: 'user', payload: { state: 'unmuted' } });
    const snapshot = window.feedBack.audioSession.snapshot().domains['audio-monitoring'];

    // A session that reports control 'unavailable' must not be collapsed to 'unknown' in the rollup.
    assert.equal(changed.payload.directMonitor.control, 'unavailable');
    assert.equal(snapshot.directMonitor.control, 'unavailable');
    assert.equal(snapshot.directMonitor.applied, false);
});

test('audio-monitoring direct-monitor summary reflects a provider that handles but does not apply', async () => {
    const window = loadAudioSession();
    const api = window.feedBack.capabilities;
    await installInput(api);
    await installMonitoring(api, {
        directMonitorResult: { outcome: 'handled', summary: { directMonitor: { state: 'unmuted', control: 'supported', applied: false, reason: 'hardware busy' } } },
    });

    await api.dispatch({ capability: 'audio-monitoring', command: 'start', source: 'user', payload: { authorization: 'user-action', requiredChannelShape: 'mono' } });
    const changed = await api.dispatch({ capability: 'audio-monitoring', command: 'set-direct-monitor', source: 'user', payload: { state: 'unmuted' } });
    const snapshot = window.feedBack.audioSession.snapshot().domains['audio-monitoring'];

    assert.equal(changed.outcome, 'handled');
    // Provider handled the request but reported it was not applied; the domain summary must not
    // collapse that into applied:true just because the aggregate outcome was handled.
    assert.equal(changed.payload.directMonitor.applied, false);
    assert.equal(snapshot.directMonitor.applied, false);
    assert.equal(snapshot.directMonitor.control, 'supported');
    assert.equal(snapshot.sessions.at(-1).directMonitor.applied, false);
    // The provider's per-session note must survive into the domain-level summary.
    assert.match(snapshot.directMonitor.reason, /hardware busy/i);
});

test('audio-monitoring direct monitor preference is user authoritative', async () => {
    const window = loadAudioSession();
    const api = window.feedBack.capabilities;
    await installInput(api);
    const monitoring = await installMonitoring(api, { directMonitor: { state: 'muted', control: 'supported', preference: 'muted', applied: true } });

    const changed = await api.dispatch({ capability: 'audio-monitoring', command: 'set-direct-monitor', source: 'user', payload: { state: 'unmuted' } });
    const startConflict = await api.dispatch({ capability: 'audio-monitoring', command: 'start', source: 'note_detect', payload: { requesterId: 'note_detect', authorization: 'user-action', directMonitorRequirement: 'muted', requiredChannelShape: 'mono' } });
    const snapshot = window.feedBack.audioSession.snapshot().domains['audio-monitoring'];

    assert.equal(changed.outcome, 'handled');
    assert.equal(startConflict.outcome, 'degraded');
    assert.equal(startConflict.payload.directMonitor.preference, 'unmuted');
    assert.equal(snapshot.directMonitor.preference, 'unmuted');
    assert.equal(snapshot.sessions.at(-1).requesters[0].status, 'degraded');
    assert.equal(monitoring.calls.some(call => call[0] === 'monitoring.set-direct-monitor'), false);
});

test('audio-monitoring direct monitor unsupported control remains diagnosable', async () => {
    const window = loadAudioSession();
    const api = window.feedBack.capabilities;
    const changedEvents = captureEvents(window, 'audio-monitoring:direct-monitor-changed');
    await installInput(api);
    await installMonitoring(api, { providerId: 'noctl_monitor', logicalMonitoringKey: 'noctl:monitor', operations: ['monitoring.start', 'monitoring.stop'] });

    const active = await api.dispatch({ capability: 'audio-monitoring', command: 'start', source: 'user', payload: { providerId: 'noctl_monitor', requesterId: 'user', authorization: 'user-action', requiredChannelShape: 'mono' } });
    const changed = await api.dispatch({ capability: 'audio-monitoring', command: 'set-direct-monitor', source: 'user', payload: { state: 'unmuted' } });
    const snapshot = window.feedBack.audioSession.snapshot().domains['audio-monitoring'];

    assert.equal(active.outcome, 'handled');
    assert.equal(changed.outcome, 'unsupported-command');
    assert.equal(changed.payload.directMonitor.preference, 'unmuted');
    assert.equal(snapshot.sessions.at(-1).directMonitor.control, 'unsupported');
    assert.equal(changedEvents.length, 1);
});

test('audio-monitoring distinguishes failure outcomes and prompt-free status inspection', async () => {
    const window = loadAudioSession();
    const api = window.feedBack.capabilities;
    const input = await installInput(api, { channelSummary: { channelCount: 1, channelShape: 'mono', supports: ['mono'] } });
    const monitoring = await installMonitoring(api);

    const inspect = await api.dispatch({ capability: 'audio-monitoring', command: 'inspect', source: 'support', payload: { includeStatus: true } });
    const unsupportedCommand = await api.dispatch({ capability: 'audio-monitoring', command: 'not-real', source: 'support' });
    const unsupportedProvider = await installMonitoring(api, { providerId: 'unsupported_monitor', logicalMonitoringKey: 'unsupported:main', operations: ['monitoring.status'] });
    const unsupported = await api.dispatch({ capability: 'audio-monitoring', command: 'start', source: 'user', payload: { providerId: unsupportedProvider.provider.providerId, requesterId: 'user', authorization: 'user-action', requiredChannelShape: 'mono' } });
    const incompatible = await api.dispatch({ capability: 'audio-monitoring', command: 'start', source: 'user', payload: { providerId: monitoring.provider.providerId, requesterId: 'user', authorization: 'user-action', requiredChannelShape: 'stereo' } });
    const badVersion = await api.dispatch({ capability: 'audio-monitoring', command: 'register-provider', source: 'bad', payload: { providerId: 'bad-monitor', version: 2 } });
    const missingStop = await api.dispatch({ capability: 'audio-monitoring', command: 'stop', source: 'support', payload: { monitoringId: 'missing-monitor' } });
    const timeoutProvider = await installMonitoring(api, { providerId: 'timeout_monitor', logicalMonitoringKey: 'timeout:main', operationHandlers: { 'monitoring.start': () => new Promise(resolve => setTimeout(() => resolve({ outcome: 'handled' }), 2100)) } });
    const timedOut = await api.dispatch({ capability: 'audio-monitoring', command: 'start', source: 'user', payload: { providerId: timeoutProvider.provider.providerId, requesterId: 'user', authorization: 'user-action', requiredChannelShape: 'mono' } });
    const malformedProvider = await installMonitoring(api, { providerId: 'malformed_monitor', logicalMonitoringKey: 'malformed:main', operationHandlers: { 'monitoring.start': () => 'not-object' } });
    const malformed = await api.dispatch({ capability: 'audio-monitoring', command: 'start', source: 'user', payload: { providerId: malformedProvider.provider.providerId, requesterId: 'user', authorization: 'user-action', requiredChannelShape: 'mono' } });

    assert.equal(inspect.outcome, 'handled');
    assert.equal(unsupportedCommand.outcome, 'unsupported-command');
    assert.equal(unsupported.outcome, 'unsupported-command');
    assert.equal(incompatible.outcome, 'incompatible');
    assert.equal(badVersion.outcome, 'incompatible-version');
    assert.equal(missingStop.outcome, 'no-handler');
    assert.equal(timedOut.outcome, 'failed');
    assert.match(timedOut.reason, /timed out/i);
    assert.equal(malformed.outcome, 'failed');
    assert.deepEqual(input.calls.map(call => call[0]), ['source.open']);
    assert.equal(monitoring.calls.some(call => call[0] === 'monitoring.status'), true);
    assert.equal(monitoring.calls.some(call => call[0] === 'monitoring.start'), false);

    const outcomes = window.feedBack.audioSession.snapshot().recentOutcomes.filter(entry => entry.domain === 'audio-monitoring');
    for (const outcome of ['handled', 'unsupported-command', 'incompatible', 'incompatible-version', 'no-handler']) {
        assert.equal(outcomes.some(entry => entry.outcome === outcome), true, `missing outcome ${outcome}`);
    }
});

test('audio-session diagnostics remain bounded during frequent input monitoring updates', async () => {
    const window = loadAudioSession();
    const api = window.feedBack.capabilities;
    for (let index = 0; index < 80; index += 1) {
        await api.dispatch({ capability: 'audio-input', command: 'register-source', source: 'bench', payload: { sourceId: `source-${index}`, logicalSourceKey: `bench:source:${index}`, providerId: 'bench', safeLabel: `/Users/example/private-${index}`, channelSummary: { channelCount: 1, channelShape: 'mono', supports: ['mono'] }, operations: ['source.open'], operationHandlers: { 'source.open': () => ({ outcome: 'handled' }) } } });
        await api.dispatch({ capability: 'audio-monitoring', command: 'register-provider', source: 'bench', payload: { providerId: `monitor-${index}`, logicalMonitoringKey: `bench:monitor:${index}`, operations: ['monitoring.start'], operationHandlers: { 'monitoring.start': () => ({ outcome: 'handled', status: 'active' }) } } });
    }
    const snapshot = window.feedBack.audioSession.snapshot();
    const encoded = JSON.stringify(snapshot);
    assert.equal(snapshot.recentOutcomes.length <= 100, true);
    assert.equal(encoded.length < 96 * 1024, true);
    assert.equal(encoded.includes('/Users/example'), false);
});
