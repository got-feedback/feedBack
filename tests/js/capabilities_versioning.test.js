const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { loadCapabilities, ROOT } = require('./capabilities_test_harness');

test('unsupported capability-pipelines versions are incompatible and do not execute handlers', async () => {
    const window = loadCapabilities();
    const api = window.feedBack.capabilities;
    const fixture = JSON.parse(fs.readFileSync(path.join(ROOT, 'tests', 'fixtures', 'plugin_capabilities', 'unsupported_capability_version.json'), 'utf8'));
    let invoked = false;
    fixture.capabilities.stems.handlers = { mute: () => { invoked = true; return { outcome: 'handled' }; } };
    fixture.capabilities.stems.runtime = true;

    api.registerParticipants([fixture]);
    const result = await api.dispatch({ capability: 'stems', command: 'mute', source: 'test' });
    const snapshot = api.snapshotDiagnostics();

    assert.equal(invoked, false);
    assert.equal(result.status, 'incompatible-version');
    assert.equal(result.outcome, 'incompatible-version');
    assert.equal(snapshot.unsupportedVersions.some(entry => entry.pluginId === 'future_capabilities'), true);
    assert.equal(snapshot.participants.find(p => p.pluginId === 'future_capabilities').availability, 'incompatible');
});