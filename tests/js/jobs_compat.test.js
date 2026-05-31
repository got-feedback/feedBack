const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loadJobs, dispatch, makeProvider, enqueuePayload, diagnosticsSnapshot, captureEvents } = require('./jobs_test_harness');

test('legacy bridge hits are recorded as diagnostics-only compatibility shims', async () => {
    const window = loadJobs();
    const events = captureEvents(window);
    const { provider } = makeProvider({ providerId: 'provider.bridge' });
    await dispatch(window, 'register-provider', { provider });
    const enqueued = await dispatch(window, 'enqueue', enqueuePayload({ providerId: 'provider.bridge', logicalJobKey: 'legacy-key' }));

    const result = await dispatch(window, 'record-bridge-hit', {
        bridgeId: 'jobs.legacy-plugin-queue',
        legacySurface: 'legacy-plugin-queue',
        pluginId: 'legacy_plugin',
        operation: 'enqueue',
        logicalJobKey: 'legacy-key',
        safeReason: 'legacy queue adapter used',
    });
    const runtimeSnapshot = window.slopsmith.capabilities.snapshotDiagnostics();
    const diagnostics = diagnosticsSnapshot(window);

    assert.equal(result.status, 'applied');
    assert.equal(result.payload.bridge.jobId, enqueued.payload.job.jobId);
    assert.equal(result.payload.bridge.diagnosticsOnly, true);
    assert.ok(runtimeSnapshot.compatibilityShims.some(shim => shim.capability === 'jobs' && shim.status === 'used'));
    assert.equal(diagnostics.bridgeHits.length, 1);
    assert.ok(events.some(event => event.event === 'bridge-hit'));
});

test('duplicate logical jobs are suppressed and remain tied to the active job', async () => {
    const window = loadJobs();
    const { provider } = makeProvider({ providerId: 'provider.duplicate' });
    await dispatch(window, 'register-provider', { provider });

    const first = await dispatch(window, 'enqueue', enqueuePayload({ providerId: 'provider.duplicate', logicalJobKey: 'same-job' }));
    const second = await dispatch(window, 'enqueue', enqueuePayload({ providerId: 'provider.duplicate', logicalJobKey: 'same-job' }));

    assert.equal(second.status, 'applied');
    assert.equal(second.payload.duplicate, true);
    assert.equal(second.payload.job.jobId, first.payload.job.jobId);
    assert.equal(diagnosticsSnapshot(window).jobs.active.length, 1);
});

test('unsupported provider actions return unsupported-operation instead of invoking callbacks', async () => {
    const window = loadJobs();
    const { calls, provider } = makeProvider({ providerId: 'provider.limited', actions: ['enqueue', 'inspect'] });
    await dispatch(window, 'register-provider', { provider });
    const enqueued = await dispatch(window, 'enqueue', enqueuePayload({ providerId: 'provider.limited' }));
    calls.length = 0;

    const pause = await dispatch(window, 'pause', { jobId: enqueued.payload.job.jobId });
    const retry = await dispatch(window, 'retry', { jobId: enqueued.payload.job.jobId, authorization: 'user-action' });

    assert.equal(pause.status, 'unsupported-operation');
    assert.equal(retry.status, 'stale');
    assert.equal(calls.length, 0);
});