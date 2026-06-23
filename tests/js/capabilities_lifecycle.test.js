const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loadCapabilities } = require('./capabilities_test_harness');

test('capability runtime installs early feedBack event bus', () => {
    const window = loadCapabilities();
    const events = [];
    const onceEvents = [];

    window.feedBack.on('screen:changed', event => events.push(event.detail));
    window.feedBack.on('song:ready', event => onceEvents.push(event.detail), { once: true });

    window.feedBack.emit('screen:changed', { id: 'home' });
    window.feedBack.emit('song:ready', { title: 'First' });
    window.feedBack.emit('song:ready', { title: 'Second' });

    assert.deepEqual(events, [{ id: 'home' }]);
    assert.deepEqual(onceEvents, [{ title: 'First' }]);
    assert.equal(typeof window.feedBack.off, 'function');
});

test('unregistering requester releases its claims', () => {
    const window = loadCapabilities();
    const api = window.feedBack.capabilities;
    api.registerParticipant('stems', { stems: { roles: ['owner'], commands: ['mute'], handlers: { mute: () => ({ outcome: 'handled' }) }, runtime: true } });
    api.registerParticipant('nam_tone', { stems: { roles: ['requester'], commands: ['mute'], runtime: true } });
    api.claim({ capability: 'stems', claimId: 'nam.amp-active', requester: 'nam_tone' });

    api.unregisterParticipant('nam_tone');
    const snapshot = api.snapshotDiagnostics();
    assert.equal(snapshot.activeClaims.some(c => c.claimId === 'nam.amp-active'), false);
    assert.equal(snapshot.claimLifecycle.some(c => c.claimId === 'nam.amp-active' && c.state === 'released'), true);
});

test('unregistering owner or handler orphans claim and prevents dispatch', async () => {
    const window = loadCapabilities();
    const api = window.feedBack.capabilities;
    api.registerParticipant('stems', { stems: { roles: ['owner'], commands: ['mute'], handlers: { mute: () => ({ outcome: 'handled' }) }, runtime: true } });
    api.claim({ capability: 'stems', claimId: 'nam.amp-active', requester: 'nam_tone' });
    api.unregisterParticipant('stems');

    const snapshot = api.snapshotDiagnostics();
    const claim = snapshot.activeClaims.find(c => c.claimId === 'nam.amp-active');
    assert.equal(claim.state, 'orphaned');
    assert.equal(claim.nonDispatchable, true);

    const result = await api.dispatch({ capability: 'stems', command: 'mute', source: 'nam_tone', claim: { claimId: 'nam.amp-active' } });
    assert.equal(result.status, 'no-owner');
    assert.equal(result.outcome, 'no-owner');
});

test('runtime enable disable is lifecycle state rather than user override', () => {
    const window = loadCapabilities();
    const api = window.feedBack.capabilities;
    api.registerParticipant('plugin_a', { stems: { roles: ['provider'], commands: ['inspect'], runtime: true } });
    const disabled = api.setParticipantEnabled('plugin_a', 'stems', false, { requester: 'test' });
    const enabled = api.setParticipantEnabled('plugin_a', 'stems', true, { requester: 'test' });
    const snapshot = api.snapshotDiagnostics();

    assert.equal(disabled.ok, true);
    assert.equal(enabled.ok, true);
    assert.equal(snapshot.userOverrides.length, 0);
    assert.equal(snapshot.participants.find(p => p.pluginId === 'plugin_a').runtimeOverride.enabled, true);
});

test('failed no-op registrations do not block reload and rehydrate replacement', async () => {
    const window = loadCapabilities();
    const api = window.feedBack.capabilities;
    api.registerParticipant('', { stems: { roles: ['owner'] } });
    api.registerParticipant('stems', { stems: { roles: ['owner'], commands: ['mute'], handlers: { mute: () => ({ outcome: 'handled', payload: { generation: 1 } }) }, runtime: true } });
    api.unregisterParticipant('stems');
    api.registerParticipant('stems', { stems: { roles: ['owner'], commands: ['mute'], handlers: { mute: () => ({ outcome: 'handled', payload: { generation: 2 } }) }, runtime: true } });

    const result = await api.dispatch({ capability: 'stems', command: 'mute', source: 'test' });
    const participants = api.inspect('stems').participants.filter(p => p.pluginId === 'stems');

    assert.equal(participants.length, 1);
    assert.equal(result.status, 'applied');
    assert.equal(result.payload.generation, 2);
});