const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loadAudioSession } = require('./audio_session_test_harness');

test('stem owner claim restore orphan and manual override lifecycle is recorded', async () => {
    const window = loadAudioSession();
    const api = window.feedBack.capabilities;
    const audioSession = window.feedBack.audioSession;

    const noOwner = await api.dispatch({ capability: 'stems', command: 'mute', source: 'nam_tone', payload: { stemIds: ['guitar'] } });
    assert.equal(noOwner.outcome, 'no-owner');

    audioSession.registerStemOwner({ ownerId: 'stems.plugin', stemIds: ['guitar', 'bass'], stemStates: { guitar: { muted: false } } });
    const muted = await api.dispatch({ capability: 'stems', command: 'mute', source: 'nam_tone', payload: { claimId: 'nam.amp-active', stemIds: ['guitar'] } });
    assert.equal(muted.status, 'applied');
    assert.equal(muted.payload.state, 'active');
    assert.equal(api.snapshotDiagnostics().activeClaims.some(claim => claim.claimId === 'nam.amp-active'), true);

    const override = audioSession.recordStemManualOverride({ stemIds: ['guitar'], requester: 'user' });
    assert.equal(override.overriddenClaims.length, 1);
    assert.equal(audioSession.snapshot().domains.stems.claims[0].state, 'overridden');

    const restored = await api.dispatch({ capability: 'stems', command: 'restore', source: 'nam_tone', payload: { claimId: 'nam.amp-active' } });
    assert.equal(restored.outcome, 'overridden');
});

test('audio session coordinates stems without replacing the active stems owner', () => {
    const window = loadAudioSession();
    const api = window.feedBack.capabilities;
    const audioSession = window.feedBack.audioSession;

    let stemsPipeline = api.inspect('stems');
    let coordinator = stemsPipeline.participants.find(entry => entry.pluginId === 'core.audio.session');
    assert.equal(coordinator.roles.includes('coordinator'), true);
    assert.equal(coordinator.roles.includes('owner'), false);

    audioSession.registerStemOwner({ ownerId: 'stems.plugin', stemIds: ['guitar'] });
    stemsPipeline = api.inspect('stems');
    coordinator = stemsPipeline.participants.find(entry => entry.pluginId === 'core.audio.session');
    const provider = stemsPipeline.participants.find(entry => entry.pluginId === 'stems.plugin');

    assert.equal(coordinator.roles.includes('owner'), false);
    assert.equal(provider.roles.includes('provider'), true);
    assert.equal(audioSession.snapshot().domains.stems.owner.ownerId, 'stems.plugin');
});

test('stem automation claims become orphaned when owner disappears', () => {
    const window = loadAudioSession();
    const api = window.feedBack.capabilities;
    const audioSession = window.feedBack.audioSession;
    const unavailableEvents = [];
    api.subscribe('stems:owner-unavailable', detail => unavailableEvents.push(detail));

    audioSession.registerStemOwner({ ownerId: 'stems.plugin', stemIds: ['guitar'] });
    audioSession.muteStems({ claimId: 'claim-one', requester: 'nam_tone', stemIds: ['guitar'] });
    audioSession.registerStemOwner({ ownerId: 'stems.plugin', availability: 'disabled', stemIds: ['guitar'] });

    const claim = audioSession.snapshot().domains.stems.claims.find(entry => entry.claimId === 'claim-one');
    assert.equal(claim.state, 'orphaned');
    assert.equal(unavailableEvents.length, 1);
    assert.equal(unavailableEvents[0].payload.availability, 'disabled');
});