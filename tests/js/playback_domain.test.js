const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loadPlayback, captureEvents, dispatch, makeTarget, makeAdapter, diagnosticsSnapshot } = require('./playback_test_harness');
const { loadCapabilities } = require('./capabilities_test_harness');

test('playback reports no-owner no-handler and unsupported command outcomes explicitly', async () => {
    const noOwnerWindow = loadCapabilities();
    const noOwner = await noOwnerWindow.feedBack.capabilities.dispatch({ capability: 'playback', command: 'inspect', requester: 'test' });
    assert.equal(noOwner.status, 'no-owner');

    const noHandlerWindow = loadCapabilities();
    noHandlerWindow.feedBack.capabilities.registerOwner('playback', { pluginId: 'test-owner', commands: ['inspect'], events: [] });
    const noHandler = await noHandlerWindow.feedBack.capabilities.dispatch({ capability: 'playback', command: 'inspect', requester: 'test' });
    assert.equal(noHandler.status, 'no-handler');

    const unsupportedWindow = loadPlayback();
    const unsupported = await dispatch(unsupportedWindow, 'teleport', { requesterId: 'test' });
    assert.equal(unsupported.status, 'unsupported-command');
});

test('playback registers as an active core owner', async () => {
    const window = loadPlayback();
    const snapshot = window.feedBack.capabilities.snapshotDiagnostics();
    const playback = snapshot.pipelines.find(pipeline => pipeline.name === 'playback');

    assert.ok(playback, 'playback pipeline exists');
    assert.equal(playback.review.lifecycle, 'active');
    assert.ok(playback.participants.some(participant => participant.pluginId === 'core.playback' && participant.roles.includes('owner')));
    assert.ok(playback.participants[0].commands.includes('start'));
    assert.ok(playback.participants[0].events.includes('seeked'));
});

test('start requires a target and explicit user authorization for fresh audible playback', async () => {
    const window = loadPlayback();

    const missing = await dispatch(window, 'start', { requesterId: 'plugin.practice', authorization: 'user-action' });
    assert.equal(missing.status, 'no-target');

    const noGesture = await dispatch(window, 'start', { requesterId: 'plugin.practice', target: makeTarget() });
    assert.equal(noGesture.status, 'user-action-required');

    const adapter = makeAdapter();
    window.feedBack.playback.registerTransportAdapter(adapter);
    const events = captureEvents(window, 'playback:ready');
    const result = await dispatch(window, 'start', { requesterId: 'core.player.controls', authorization: 'user-action', target: makeTarget() });

    assert.equal(result.status, 'ready');
    assert.ok(adapter.calls.some(call => call[0] === 'start'));
    assert.equal(events.length, 1);
    const state = diagnosticsSnapshot(window).state;
    assert.equal(state.state, 'ready');
    assert.equal(state.target.targetId.startsWith('target-'), true);
    assert.match(state.target.settingsKey, /^settings-v1-[a-z0-9]{7}$/);
    assert.equal(events[0].payload.target.settingsKey, state.target.settingsKey);
});

test('settings key is stable across arrangements while target id remains arrangement scoped', async () => {
    const window = loadPlayback();
    window.feedBack.playback.registerTransportAdapter(makeAdapter());
    const base = makeTarget({ filename: '/Users/example/DLC/Artist - Song_p.archive', arrangement: 'Lead', arrangementIndex: 0 });

    await dispatch(window, 'start', { requesterId: 'core.player.controls', authorization: 'user-action', target: base });
    const leadTarget = diagnosticsSnapshot(window).state.target;
    await dispatch(window, 'start', { requesterId: 'core.player.controls', authorization: 'user-action', target: { ...base, arrangement: 'Bass', arrangementIndex: 1 } });
    const bassTarget = diagnosticsSnapshot(window).state.target;

    assert.match(leadTarget.settingsKey, /^settings-v1-[a-z0-9]{7}$/);
    assert.equal(bassTarget.settingsKey, leadTarget.settingsKey);
    assert.notEqual(bassTarget.targetId, leadTarget.targetId);
});

test('unsafe caller-supplied settings keys are hashed before exposure', async () => {
    const window = loadPlayback();
    window.feedBack.playback.registerTransportAdapter(makeAdapter());

    await dispatch(window, 'start', {
        requesterId: 'core.player.controls',
        authorization: 'user-action',
        target: makeTarget({ settingsKey: 'settings-private-song-name' }),
    });
    const encoded = JSON.stringify(diagnosticsSnapshot(window));

    assert.match(diagnosticsSnapshot(window).state.target.settingsKey, /^settings-v1-[a-z0-9]{7}$/);
    assert.doesNotMatch(encoded, /private-song-name/);
});

test('unsafe caller-supplied target ids are hashed before exposure', async () => {
    const window = loadPlayback();
    window.feedBack.playback.registerTransportAdapter(makeAdapter());

    await dispatch(window, 'start', {
        requesterId: 'core.player.controls',
        authorization: 'user-action',
        target: makeTarget({ targetId: 'target-private-song-name' }),
    });
    const encoded = JSON.stringify(diagnosticsSnapshot(window));

    assert.match(diagnosticsSnapshot(window).state.target.targetId, /^target-[a-z0-9]+$/);
    assert.doesNotMatch(encoded, /private-song-name/);
});

test('dispatch requester owns playback command attribution', async () => {
    const window = loadPlayback();
    window.feedBack.playback.registerTransportAdapter(makeAdapter());

    const started = await dispatch(window, 'start', { requesterId: 'core.player.controls', authorization: 'user-action', target: makeTarget() }, 'plugin.remote');
    const paused = await dispatch(window, 'pause', { requesterId: 'core.player.controls' }, 'plugin.remote');
    const snapshot = diagnosticsSnapshot(window);
    const outcomeIds = snapshot.history.current.recentOutcomes.map(item => item.requesterId).join(',');

    assert.equal(started.status, 'ready');
    assert.equal(paused.status, 'paused');
    assert.equal(snapshot.state.transport.requesterId, 'plugin.remote');
    assert.equal(outcomeIds.includes('core.player.controls'), false);
    assert.equal(outcomeIds.includes('plugin.remote'), true);
});

test('transport commands emit ordered lifecycle events and normalize outcomes', async () => {
    const window = loadPlayback();
    const adapter = makeAdapter({ duration: 10 });
    window.feedBack.playback.registerTransportAdapter(adapter);
    const events = [];
    for (const eventName of ['playback:requested', 'playback:loading', 'playback:ready', 'playback:paused', 'playback:resumed', 'playback:seeking', 'playback:seeked', 'playback:loop-set', 'playback:loop-cleared']) {
        window.feedBack.on(eventName, event => events.push(event.type.replace('playback:', '')));
    }

    await dispatch(window, 'start', { authorization: 'user-action', requesterId: 'core.player.controls', target: makeTarget() });
    await dispatch(window, 'pause', { requesterId: 'core.player.controls', priority: 'user' });
    await dispatch(window, 'resume', { requesterId: 'core.player.controls', priority: 'user' });
    const seek = await dispatch(window, 'seek', { requesterId: 'core.player.controls', time: 999 });
    const loop = await dispatch(window, 'set-loop', { requesterId: 'core.player.controls', startTime: 2, endTime: 4 });
    const cleared = await dispatch(window, 'clear-loop', { requesterId: 'core.player.controls' });

    assert.deepEqual(events.slice(0, 3), ['requested', 'loading', 'ready']);
    assert.ok(events.indexOf('seeking') < events.indexOf('seeked'));
    assert.equal(seek.status, 'clamped');
    assert.equal(seek.payload.landedTime, 10);
    assert.equal(loop.status, 'active');
    assert.equal(cleared.status, 'cleared');
});

test('seek preserves pre-seek playback state and external seek events update state', async () => {
    const window = loadPlayback();
    window.feedBack.playback.registerTransportAdapter(makeAdapter({ startPlaying: true, seekResult: { completed: true, from: 1, to: 5 } }));
    await dispatch(window, 'start', { authorization: 'user-action', requesterId: 'core.player.controls', target: makeTarget() });

    const seek = await dispatch(window, 'seek', { requesterId: 'core.player.controls', time: 5 });
    assert.equal(seek.status, 'completed');
    assert.equal(diagnosticsSnapshot(window).state.state, 'playing');

    window.feedBack.playback.transportEvent('seeking', { requesterId: 'core.player.controls', media: { currentTime: 5 }, isPlaying: true });
    assert.equal(diagnosticsSnapshot(window).state.state, 'seeking');
    window.feedBack.playback.transportEvent('seeked', { requesterId: 'core.player.controls', media: { currentTime: 9 }, isPlaying: true });
    assert.equal(diagnosticsSnapshot(window).state.state, 'playing');
});

test('clear-loop requires an active playback session', async () => {
    const window = loadPlayback();
    window.feedBack.playback.registerTransportAdapter(makeAdapter());

    const cleared = await dispatch(window, 'clear-loop', { requesterId: 'core.player.controls' });
    assert.equal(cleared.status, 'no-target');
});

test('ended transport events and seek failure/rollback outcomes are distinguishable', async () => {
    const window = loadPlayback();
    window.feedBack.playback.registerTransportAdapter(makeAdapter({ seekResult: { completed: true, from: 5, to: 4.5 } }));
    await dispatch(window, 'start', { authorization: 'user-action', requesterId: 'core.player.controls', target: makeTarget() });
    const rolledBack = await dispatch(window, 'seek', { requesterId: 'core.player.controls', time: 8 });
    assert.equal(rolledBack.status, 'rolled-back');

    const failedWindow = loadPlayback();
    failedWindow.feedBack.playback.registerTransportAdapter(makeAdapter({ seekError: 'seek failed' }));
    await dispatch(failedWindow, 'start', { authorization: 'user-action', requesterId: 'core.player.controls', target: makeTarget() });
    const failed = await dispatch(failedWindow, 'seek', { requesterId: 'core.player.controls', time: 3 });
    assert.equal(failed.status, 'failed');
    assert.equal(failed.outcome, 'failed');
    assert.equal(diagnosticsSnapshot(failedWindow).state.state, 'paused');

    const unsupportedWindow = loadPlayback();
    unsupportedWindow.feedBack.playback.registerTransportAdapter({ inspect: () => ({ currentTime: 0, duration: 120, isPlaying: true }), start: () => ({ currentTime: 0, duration: 120, isPlaying: true }) });
    await dispatch(unsupportedWindow, 'start', { authorization: 'user-action', requesterId: 'core.player.controls', target: makeTarget() });
    const unsupported = await dispatch(unsupportedWindow, 'seek', { requesterId: 'core.player.controls', time: 3 });
    assert.equal(unsupported.status, 'unsupported-command');
    assert.equal(diagnosticsSnapshot(unsupportedWindow).state.state, 'playing');

    const malformedWindow = loadPlayback();
    malformedWindow.feedBack.playback.registerTransportAdapter(makeAdapter({ seekResult: { completed: true, from: 2, to: NaN } }));
    await dispatch(malformedWindow, 'start', { authorization: 'user-action', requesterId: 'core.player.controls', target: makeTarget() });
    const malformed = await dispatch(malformedWindow, 'seek', { requesterId: 'core.player.controls', time: 6 });
    assert.equal(malformed.status, 'failed');
    assert.match(malformed.reason, /malformed seek result/i);

    window.feedBack.playback.transportEvent('ended', { requesterId: 'core.player.controls', currentTime: 120 });
    assert.equal(diagnosticsSnapshot(window).state.state, 'ended');
});

test('invalid loop boundaries do not mutate an active loop', async () => {
    const window = loadPlayback();
    window.feedBack.playback.registerTransportAdapter(makeAdapter());
    await dispatch(window, 'start', { authorization: 'user-action', requesterId: 'core.player.controls', target: makeTarget() });
    await dispatch(window, 'set-loop', { requesterId: 'core.player.controls', startTime: 2, endTime: 4 });

    const rejected = await dispatch(window, 'set-loop', { requesterId: 'core.player.controls', startTime: 8, endTime: 4 });
    const loop = diagnosticsSnapshot(window).state.loop;

    assert.equal(rejected.status, 'rejected');
    assert.equal(loop.state, 'active');
    assert.equal(loop.startTime, 2);
    assert.equal(loop.endTime, 4);
});

test('normal resume is denied after a user-priority pause until a user action resumes', async () => {
    const window = loadPlayback();
    window.feedBack.playback.registerTransportAdapter(makeAdapter());
    await dispatch(window, 'start', { authorization: 'user-action', requesterId: 'core.player.controls', target: makeTarget() });
    await dispatch(window, 'pause', { requesterId: 'core.player.controls', priority: 'user' });

    const blocked = await dispatch(window, 'resume', { requesterId: 'plugin.remote', priority: 'normal' });
    assert.equal(blocked.status, 'denied');

    const accepted = await dispatch(window, 'resume', { requesterId: 'core.player.controls', priority: 'user' });
    assert.equal(accepted.status, 'playing');
});

test('stale and cancelled operations are reported distinctly', async () => {
    const window = loadPlayback();
    window.feedBack.playback.registerTransportAdapter(makeAdapter({ seekResult: { completed: false, from: 2, to: NaN } }));
    await dispatch(window, 'start', { authorization: 'user-action', requesterId: 'core.player.controls', target: makeTarget() });
    const sessionId = diagnosticsSnapshot(window).state.sessionId;

    const stale = await dispatch(window, 'pause', { requesterId: 'plugin.remote', sessionId: `${sessionId}-old` });
    const cancelled = await dispatch(window, 'seek', { requesterId: 'core.player.controls', time: 8 });

    assert.equal(stale.status, 'stale');
    assert.equal(cancelled.status, 'cancelled');
});
