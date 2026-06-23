const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loadCapabilities } = require('./capabilities_test_harness');

function registerStemsOwner(api, calls) {
    api.registerParticipant('stems', {
        stems: {
            roles: ['owner', 'provider'],
            commands: ['mute', 'restore'],
            runtime: true,
            handlers: {
                mute: (ctx) => {
                    calls.push(['mute', ctx.payload]);
                    return { outcome: 'handled', payload: { muted: true, restoreSnapshotRef: 'snap-1' } };
                },
                restore: (ctx) => {
                    calls.push(['restore', ctx.payload]);
                    return { outcome: 'handled', payload: { restored: true } };
                },
            },
        },
    });
}

test('claim dispatch release records lifecycle and removes active claim', async () => {
    const window = loadCapabilities();
    const api = window.feedBack.capabilities;
    const calls = [];
    registerStemsOwner(api, calls);

    const cleanup = api.claim({ capability: 'stems', claimId: 'nam.amp-active', requester: 'nam_tone', target: { kind: 'guitar' } });
    let snapshot = api.snapshotDiagnostics();
    assert.equal(snapshot.activeClaims.find(c => c.claimId === 'nam.amp-active').owner, 'stems');

    const result = await api.dispatch({
        capability: 'stems', command: 'mute', source: 'nam_tone',
        claim: { claimId: 'nam.amp-active' }, args: { target: { kind: 'guitar' } },
    });
    assert.equal(result.status, 'applied');
    assert.equal(calls.length, 1);

    cleanup();
    snapshot = api.snapshotDiagnostics();
    assert.equal(snapshot.activeClaims.some(c => c.claimId === 'nam.amp-active'), false);
    assert.equal(snapshot.claimLifecycle.some(c => c.claimId === 'nam.amp-active' && c.state === 'released'), true);
    assert.equal(snapshot.claimLifecycle.find(c => c.claimId === 'nam.amp-active').restoreSnapshotRef, null);
});

test('manual override is terminal for matching active claim target', async () => {
    const window = loadCapabilities();
    const api = window.feedBack.capabilities;
    const calls = [];
    registerStemsOwner(api, calls);
    api.claim({ capability: 'stems', claimId: 'nam.amp-active', requester: 'nam_tone', target: { kind: 'guitar' } });
    api.recordUserOverride({ capability: 'stems', source: 'user', target: { kind: 'guitar' }, reason: 'Player unmuted guitar' });

    const result = await api.dispatch({
        capability: 'stems', command: 'mute', source: 'nam_tone',
        claim: { claimId: 'nam.amp-active' }, args: { target: { kind: 'guitar' } },
    });

    assert.equal(result.status, 'overridden');
    assert.equal(calls.length, 0);
    assert.match(result.reason, /user override/i);
});