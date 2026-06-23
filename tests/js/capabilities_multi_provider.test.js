const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loadCapabilities } = require('./capabilities_test_harness');

test('multi-provider participants use deterministic order without duplicate-owner conflict', async () => {
    const window = loadCapabilities();
    const api = window.feedBack.capabilities;
    const calls = [];
    api.registerParticipant('provider_b', { 'shared-viz': { roles: ['owner', 'provider'], ownership: 'multi-provider', commands: ['register-provider'], order: { after: ['provider_a'] }, handlers: { 'register-provider': () => { calls.push('b'); return { outcome: 'passed' }; } }, runtime: true } });
    api.registerParticipant('provider_a', { 'shared-viz': { roles: ['owner', 'provider'], ownership: 'multi-provider', commands: ['register-provider'], handlers: { 'register-provider': () => { calls.push('a'); return { outcome: 'handled' }; } }, runtime: true } });

    const inspection = api.inspect('shared-viz');
    const result = await api.dispatch({ capability: 'shared-viz', command: 'register-provider', source: 'test' });

    assert.equal(inspection.conflicts.some(c => c.type === 'duplicate-owner'), false);
    assert.equal(JSON.stringify(inspection.order.slice(-2)), JSON.stringify(['provider_a', 'provider_b']));
    assert.equal(result.status, 'applied');
    assert.equal(calls[0], 'a');
});