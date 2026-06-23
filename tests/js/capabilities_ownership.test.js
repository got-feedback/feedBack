const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loadCapabilities } = require('./capabilities_test_harness');

test('exclusive duplicate owners report conflict and degrade dispatch', async () => {
    const window = loadCapabilities();
    const api = window.feedBack.capabilities;
    api.registerParticipant('owner_a', { stems: { roles: ['owner'], commands: ['mute'], handlers: { mute: () => ({ outcome: 'handled' }) }, runtime: true } });
    api.registerParticipant('owner_b', { stems: { roles: ['owner'], commands: ['mute'], handlers: { mute: () => ({ outcome: 'handled' }) }, runtime: true } });

    const inspection = api.inspect('stems');
    const result = await api.dispatch({ capability: 'stems', command: 'mute', source: 'test' });

    assert.equal(inspection.conflicts.some(c => c.type === 'duplicate-owner'), true);
    assert.equal(result.status, 'no-handler');
    assert.match(result.reason, /multiple owners|duplicate-owner|degraded/i);
});

test('no-owner no-handler and unsupported-command outcomes are explicit', async () => {
    const window = loadCapabilities();
    const api = window.feedBack.capabilities;
    let result = await api.dispatch({ capability: 'missing-domain', command: 'mute', source: 'test' });
    assert.equal(result.status, 'no-owner');
    assert.equal(result.outcome, 'no-owner');

    api.registerParticipant('stems', { stems: { roles: ['owner'], commands: ['mute'], runtime: true } });
    result = await api.dispatch({ capability: 'stems', command: 'unknown', source: 'test' });
    assert.equal(result.status, 'unsupported-command');
    assert.equal(result.outcome, 'unsupported-command');

    result = await api.dispatch({ capability: 'stems', command: 'mute', source: 'test' });
    assert.equal(result.status, 'no-handler');
    assert.equal(result.outcome, 'no-handler');
});