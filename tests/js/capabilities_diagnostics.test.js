const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loadCapabilities } = require('./capabilities_test_harness');

test('diagnostics snapshots redact paths and trim recent decisions under 64 KB', async () => {
    const window = loadCapabilities();
    const api = window.slopsmith.capabilities;
    api.registerParticipant('owner', {
        stems: {
            roles: ['owner'],
            commands: ['mute'],
            runtime: true,
            handlers: { mute: () => ({ outcome: 'failed', reason: 'token=abc123 path /Users/example/secret/file.txt ' + 'x'.repeat(2000) }) },
        },
    });
    for (let i = 0; i < 120; i += 1) {
        await api.dispatch({ capability: 'stems', command: 'mute', source: 'diag-test', args: { target: { id: `target-${i}` } } });
    }
    const snapshot = api.snapshotDiagnostics();
    const encoded = JSON.stringify(snapshot);
    assert.ok(encoded.length <= 64 * 1024);
    assert.equal(encoded.includes('/Users/example'), false);
    assert.equal(encoded.includes('abc123'), false);
    assert.equal(snapshot.snapshotBytes <= 64 * 1024, true);
});

test('compatibility shim hit counts and attribution are exported', () => {
    const window = loadCapabilities();
    const api = window.slopsmith.capabilities;
    api.registerCompatibilityShim({ shimId: 'stems:legacy-window', source: 'stems', capability: 'stems', legacySurface: 'window._stemsState', status: 'active', reason: 'legacy global bridge' });
    api.registerCompatibilityShim({ shimId: 'stems:legacy-window', source: 'stems', capability: 'stems', legacySurface: 'window._stemsState', status: 'used', used: true });
    api.registerCompatibilityShim({ shimId: 'stems:legacy-window', source: 'stems', capability: 'stems', legacySurface: 'window._stemsState', status: 'used', hit: true });
    const shim = api.snapshotDiagnostics().compatibilityShims.find(entry => entry.shimId === 'stems:legacy-window');
    assert.equal(shim.source, 'stems');
    assert.equal(shim.capability, 'stems');
    assert.equal(shim.hitCount, 2);
    assert.ok(shim.lastHitAt);
});

test('diagnostics export expected compatibility shim surfaces', () => {
    const window = loadCapabilities();
    const api = window.slopsmith.capabilities;
    const expected = api.snapshotDiagnostics().expectedCompatibilityShims;

    assert.ok(Array.isArray(expected));
    assert.equal(expected.some(entry => entry.capability === 'library'), false);
    assert.equal(expected.some(entry => entry.capability === 'backend.routes'), false);
    assert.equal(expected.some(entry => entry.capability === 'playback'), false);
    assert.equal(expected.some(entry => entry.capability === 'visualization'), false);
    assert.equal(expected.some(entry => entry.capability === 'jobs'), false);
});

test('diagnostics include active playback and jobs but exclude deferred future core domains', () => {
    const window = loadCapabilities();
    const api = window.slopsmith.capabilities;
    api.registerParticipant('playback_probe', {
        playback: {
            roles: ['provider'],
            commands: ['snapshot'],
            runtime: true,
        },
    });
    api.registerParticipant('future_plugin', {
        'ui.player-panels': {
            roles: ['provider'],
            commands: ['register-contribution'],
            runtime: true,
        },
    });
    api.registerParticipants([{ id: 'future_manifest', capabilities: { jobs: { roles: ['provider'], commands: ['register'] } } }]);
    api.registerCompatibilityShim({ shimId: 'deferred:viz', source: 'highway_3d', capability: 'visualization', legacySurface: 'highway.setRenderer', status: 'used', hit: true });
    api.registerCompatibilityShim({ shimId: 'deferred:routes', source: 'legacy_routes_plugin', capability: 'backend.routes', legacySurface: 'routes', status: 'used', hit: true });
    const pipelines = api.snapshotDiagnostics().pipelines;
    const playback = pipelines.find(entry => entry.name === 'playback');
    assert.ok(playback, 'playback should be part of the active runtime graph when participants register');
    assert.equal(playback.review.lifecycle, 'active');
    const jobs = pipelines.find(entry => entry.name === 'jobs');
    assert.ok(jobs, 'jobs should be part of the active runtime graph when participants register');
    assert.equal(jobs.review.lifecycle, 'active');

    // `visualization` (cap:6 slice) and `note-detection` (spec 009 slice)
    // left this list when their domains were promoted.
    const futureDomains = [
        'ui.navigation', 'ui.plugin-screens', 'settings', 'backend.routes', 'ui.player-controls', 'ui.player-panels', 'ui.player-overlays', 'plugins', 'midi-control', 'tempo-clock',
    ];

    for (const domain of futureDomains) {
        assert.equal(pipelines.some(entry => entry.name === domain), false, `${domain} should stay out of the runtime graph`);
    }
    // visualization is active now, so its shim entries are recorded rather
    // than dropped; backend.routes stays reserved and dropped.
    assert.equal(api.snapshotDiagnostics().compatibilityShims.some(entry => entry.capability === 'visualization'), true);
    assert.equal(api.snapshotDiagnostics().compatibilityShims.some(entry => entry.capability === 'backend.routes'), false);
});

test('server-reported shim hit counts are not inflated by refresh registration', () => {
    const window = loadCapabilities();
    const api = window.slopsmith.capabilities;
    const shim = {
        shimId: 'stems:legacy-window',
        source: 'stems',
        capability: 'stems',
        legacySurface: 'window._stemsState',
        status: 'used',
        hitCount: 1,
    };
    api.registerCompatibilityShim(shim);
    api.registerCompatibilityShim(shim);
    const exported = api.snapshotDiagnostics().compatibilityShims.find(entry => entry.shimId === shim.shimId);
    assert.equal(exported.hitCount, 1);
    assert.equal(exported.source, 'stems');
    assert.ok(exported.lastHitAt);
});

test('recordLegacyHit preserves non-library shim attribution', () => {
    const window = loadCapabilities();
    const api = window.slopsmith.capabilities;
    const first = api.recordLegacyHit({
        capability: 'stems',
        legacySurface: 'window._stemsState',
        source: 'legacy-stems',
    });
    api.registerCompatibilityShim({
        shimId: first.shimId,
        source: 'legacy-stems',
        capability: 'stems',
        legacySurface: 'window._stemsState',
        status: 'active',
    });

    const exported = api.snapshotDiagnostics().compatibilityShims.find(entry => entry.shimId === first.shimId);
    assert.equal(exported.status, 'used');
    assert.equal(exported.hitCount, 1);
    assert.equal(exported.source, 'legacy-stems');
});

test('recordLegacyHit counts runtime use and preserves used status across active refreshes', () => {
    const window = loadCapabilities();
    const api = window.slopsmith.capabilities;
    const first = api.recordLegacyHit({
        capability: 'stems',
        legacySurface: 'window._stemsState',
        source: 'legacy-event-bus',
        reason: 'legacy event emitted',
    });
    api.registerCompatibilityShim({
        shimId: first.shimId,
        source: 'legacy-event-bus',
        capability: 'stems',
        legacySurface: 'window._stemsState',
        status: 'active',
        reason: 'static metadata refresh',
    });
    api.recordLegacyHit({
        capability: 'stems',
        legacySurface: 'window._stemsState',
        source: 'legacy-event-bus',
        reason: 'legacy event emitted again',
    });

    const exported = api.snapshotDiagnostics().compatibilityShims.find(entry => entry.shimId === first.shimId);
    assert.equal(exported.status, 'used');
    assert.equal(exported.hitCount, 2);
    assert.equal(exported.capability, 'stems');
    assert.equal(exported.legacySurface, 'window._stemsState');
    assert.ok(exported.lastHitAt);
});

test('capability diagnostics emit a changed event after runtime updates', async () => {
    const window = loadCapabilities();
    const api = window.slopsmith.capabilities;
    let changes = 0;
    window.addEventListener('slopsmith:capabilities:changed', () => { changes += 1; });

    api.recordLegacyHit({
        capability: 'stems',
        legacySurface: 'window._stemsState',
        source: 'legacy-event-listener',
    });
    await new Promise(resolve => setTimeout(resolve, 10));

    assert.ok(changes >= 1);
});