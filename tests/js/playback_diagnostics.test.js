const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loadPlayback, captureEvents, dispatch, diagnosticsSnapshot, makeTarget, makeAdapter } = require('./playback_test_harness');

test('exported diagnostics pseudonymize targets while local inspector may show display names', async () => {
    const window = loadPlayback();
    window.feedBack.playback.registerTransportAdapter(makeAdapter());
    await dispatch(window, 'start', {
        authorization: 'user-action',
        requesterId: 'core.player.controls',
        target: makeTarget({
            filename: '/Users/example/DLC/Private Artist - Private Song_p.archive',
            title: 'Private Song',
            artist: 'Private Artist',
            arrangement: 'Lead',
        }),
    });

    const exported = diagnosticsSnapshot(window);
    const local = diagnosticsSnapshot(window, { exportMode: 'local-inspector' });
    const exportedText = JSON.stringify(exported);

    assert.match(exported.state.target.targetId, /^target-/);
    assert.match(exported.state.target.settingsKey, /^settings-v1-[a-z0-9]{7}$/);
    assert.equal(exported.state.target.localDisplay, undefined);
    assert.doesNotMatch(exportedText, /Private Song/);
    assert.doesNotMatch(exportedText, /Private Artist/);
    assert.doesNotMatch(exportedText, /DLC/);
    assert.equal(local.state.target.settingsKey, exported.state.target.settingsKey);
    assert.equal(local.state.target.localDisplay.title, 'Private Song');
    assert.equal(local.state.target.localDisplay.artist, 'Private Artist');
});

test('diagnostic history is bounded for current and stopped sessions', async () => {
    const window = loadPlayback();
    window.feedBack.playback.registerTransportAdapter(makeAdapter());

    for (let index = 0; index < 7; index += 1) {
        await dispatch(window, 'start', { authorization: 'user-action', requesterId: 'core.player.controls', target: makeTarget({ filename: `song-${index}.archive`, title: `Song ${index}` }) });
        for (let seek = 0; seek < 12; seek += 1) {
            await dispatch(window, 'seek', { requesterId: 'core.player.controls', time: seek });
        }
        await dispatch(window, 'stop', { requesterId: 'core.player.controls', priority: 'user' });
    }

    const snapshot = diagnosticsSnapshot(window);
    assert.ok(snapshot.history.current.recentOutcomes.length <= 50);
    assert.ok(snapshot.history.current.lifecycleEvents.length <= 50);
    assert.ok(snapshot.history.stoppedSessions.length <= 5);
    for (const session of snapshot.history.stoppedSessions) {
        assert.ok(session.recentOutcomes.length <= 20);
        assert.ok(session.lifecycleEvents.length <= 20);
    }
});

test('diagnostics contribution is exported under playback schema', async () => {
    const window = loadPlayback();
    window.feedBack.playback.registerTransportAdapter(makeAdapter());
    await dispatch(window, 'start', { authorization: 'user-action', requesterId: 'core.player.controls', target: makeTarget() });

    const contribution = window.feedBack.diagnostics.snapshotContributions().playback;
    assert.equal(contribution.schema, 'feedBack.playback.diagnostics.v1');
    assert.equal(contribution.domain, 'playback');
    assert.equal(contribution.exportMode, 'exported');
    assert.match(contribution.state.target.settingsKey, /^settings-v1-[a-z0-9]{7}$/);
    assert.equal(contribution.state.target.localDisplay, undefined);
});

test('diagnostics redact caller-supplied route and stale session ids', async () => {
    const window = loadPlayback();
    window.feedBack.playback.registerTransportAdapter(makeAdapter());
    await dispatch(window, 'start', { authorization: 'user-action', requesterId: 'core.player.controls', target: makeTarget() });

    await dispatch(window, 'pause', { sessionId: '/Users/example/private-session?token=secret' }, 'plugin.remote');
    window.feedBack.playback.recordRouteChange({ routeId: '/Users/example/native-route?token=secret', routeKind: 'desktop-native', state: 'active', safeReason: 'ok' });

    const snapshot = diagnosticsSnapshot(window);
    const encoded = JSON.stringify(snapshot);
    const stale = snapshot.history.current.recentOutcomes.find(item => item.status === 'stale');

    assert.match(snapshot.state.route.routeId, /^route-/);
    assert.notEqual(snapshot.state.route.routeId, '/Users/example/native-route?token=secret');
    assert.match(stale.sessionId, /^playback-/);
    assert.notEqual(stale.sessionId, '/Users/example/private-session?token=secret');
    assert.doesNotMatch(encoded, /private-session|native-route|token=secret|\/Users\/example/);
});

test('diagnostics redact requester ids and raw camel-case payload keys', async () => {
    const window = loadPlayback();
    window.feedBack.playback.registerTransportAdapter(makeAdapter());
    await dispatch(window, 'start', { authorization: 'user-action', target: makeTarget() }, '/Users/example/plugin token=secret');

    const degradedEvents = captureEvents(window, 'playback:degraded');
    window.feedBack.playback.transportEvent('degraded', {
        requesterId: '/Users/example/transport token=secret',
        accessToken: 'plain-secret-token',
        nativeHandleRef: 'native-secret-handle',
        mediaStream: 'raw-stream-id',
        reason: '/Users/example/private song.archive token=secret',
        safeDetail: 'safe value',
    });
    window.feedBack.playback.recordBridgeHit({
        bridgeId: '/Users/example/bridge token=secret',
        legacySurface: 'window.playSong',
        source: '/Users/example/source token=secret',
        reason: '/Users/example/bridge path token=secret',
        nativeHandleRef: 'native-secret-handle',
    });

    const snapshot = diagnosticsSnapshot(window);
    const encoded = JSON.stringify({ snapshot, degradedEvents });

    assert.match(snapshot.state.transport.requesterId, /path/);
    assert.doesNotMatch(encoded, /plain-secret-token|native-secret-handle|raw-stream-id/);
    assert.doesNotMatch(encoded, /private song|bridge path|\/Users\/example|token=secret|source-token-secret|bridge-token-secret/);
    assert.match(encoded, /safe value/);
});
