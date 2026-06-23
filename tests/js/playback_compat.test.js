const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { loadPlayback, captureEvents, diagnosticsSnapshot, makeTarget, dispatch, makeAdapter, ROOT } = require('./playback_test_harness');
const { loadCapabilities } = require('./capabilities_test_harness');

test('requester and observer registration is idempotent and visible in diagnostics', async () => {
    const window = loadPlayback();
    await dispatch(window, 'register-requester', { requesterId: 'plugin.practice', kind: 'plugin', requests: ['pause'] });
    await dispatch(window, 'register-requester', { requesterId: 'plugin.practice', kind: 'plugin', requests: ['seek'], status: 'available' });
    await dispatch(window, 'register-observer', { observerId: 'plugin.hud', observes: ['ready', 'seeked'] });

    const participants = diagnosticsSnapshot(window).participants;
    assert.equal(participants.filter(item => item.requesterId === 'plugin.practice').length, 1);
    assert.equal(participants.filter(item => item.observerId === 'plugin.hud').length, 1);
});

test('plugin fresh starts require user action and incompatible playback participants do not execute', async () => {
    const window = loadPlayback();
    const denied = await dispatch(window, 'start', { requesterId: 'plugin.remote', target: makeTarget() });
    assert.equal(denied.status, 'user-action-required');

    const incompatibleWindow = loadCapabilities();
    const fixture = JSON.parse(fs.readFileSync(path.join(ROOT, 'tests', 'fixtures', 'plugin_capabilities', 'unsupported_capability_version.json'), 'utf8'));
    fixture.id = 'future_playback';
    fixture.capabilities = { playback: { roles: ['owner'], commands: ['inspect'], runtime: true, version: 999, handlers: { inspect: () => ({ outcome: 'handled' }) } } };
    incompatibleWindow.feedBack.capabilities.registerParticipants([fixture]);
    const result = await incompatibleWindow.feedBack.capabilities.dispatch({ capability: 'playback', command: 'inspect', requester: 'test' });
    assert.equal(result.status, 'incompatible-version');
});

test('same-priority latest controls remain non-stale while user-priority commands deny background automation', async () => {
    const window = loadPlayback();
    window.feedBack.playback.registerTransportAdapter(makeAdapter());
    await dispatch(window, 'start', { authorization: 'user-action', requesterId: 'core.player.controls', target: makeTarget() });
    const firstPause = await dispatch(window, 'pause', { requesterId: 'plugin.a', priority: 'normal' });
    const normalResume = await dispatch(window, 'resume', { requesterId: 'plugin.b', priority: 'normal' });
    await dispatch(window, 'pause', { requesterId: 'core.player.controls', priority: 'user' });
    const blockedResume = await dispatch(window, 'resume', { requesterId: 'plugin.b', priority: 'normal' });

    assert.equal(firstPause.status, 'paused');
    assert.equal(normalResume.status, 'playing');
    assert.equal(blockedResume.status, 'denied');
});

test('legacy bridge hits are attributed to playback compatibility shims', () => {
    const window = loadPlayback();
    const bridgeEvents = captureEvents(window, 'playback:bridge-hit');

    window.feedBack.playback.recordBridgeHit({
        bridgeId: 'playback.window-play-song',
        legacySurface: 'window.playSong',
        source: 'core.app',
        reason: 'legacy playSong entry point used',
    });

    const playback = diagnosticsSnapshot(window);
    const runtime = window.feedBack.capabilities.snapshotDiagnostics();
    const shim = runtime.compatibilityShims.find(item => item.capability === 'playback' && item.legacySurface === 'window.playSong');

    assert.equal(bridgeEvents.length, 1);
    assert.equal(playback.bridges[0].bridgeId, 'playback.window-play-song');
    assert.equal(playback.bridges[0].hitCount, 1);
    assert.ok(shim);
    assert.equal(shim.hitCount, 1);
});

test('legacy song events update playback state without exposing raw filenames', () => {
    const window = loadPlayback();
    window.feedBack.emit('song:loading', { filename: '/Users/example/Secret Folder/Artist - Song_p.archive', arrangement: 0 });
    window.feedBack.emit('song:loaded', makeTarget({ filename: '/Users/example/Secret Folder/Artist - Song_p.archive' }));
    window.feedBack.emit('song:play', { time: 4, audioT: 4, chartT: 4 });
    window.feedBack.emit('song:seek', { from: 4, to: 12, reason: 'seek-by' });

    const playback = diagnosticsSnapshot(window);
    const encoded = JSON.stringify(playback);

    assert.equal(playback.state.state, 'playing');
    assert.equal(playback.state.media.currentTime, 12);
    assert.match(playback.state.target.settingsKey, /^settings-v1-[a-z0-9]{7}$/);
    assert.ok(playback.bridges.some(bridge => bridge.bridgeId === 'playback.song-events'));
    assert.doesNotMatch(encoded, /Secret Folder/);
    assert.doesNotMatch(encoded, /Artist - Song_p\.archive/);
});

test('route changes are captured as redaction-safe playback lifecycle events', () => {
    const window = loadPlayback();
    const changing = captureEvents(window, 'playback:route-changing');
    const changed = captureEvents(window, 'playback:route-changed');

    window.feedBack.playback.recordRouteChange({ routeKind: 'desktop-native', state: 'switching', preservedTime: true, safeReason: 'desktop engine active' });
    window.feedBack.playback.recordRouteChange({ routeKind: 'desktop-native', state: 'active', preservedTime: true, safeReason: 'desktop route active' });

    const playback = diagnosticsSnapshot(window);
    assert.equal(changing.length, 1);
    assert.equal(changed.length, 1);
    assert.equal(playback.state.route.routeKind, 'desktop-native');
    assert.equal(playback.state.route.state, 'active');
    assert.equal(playback.state.route.preservedTime, true);
});
