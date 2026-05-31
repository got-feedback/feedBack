const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loadJobs, dispatch, makeProvider, enqueuePayload, captureEvents, diagnosticsSnapshot } = require('./jobs_test_harness');

test('multiple providers require explicit selection before scheduling', async () => {
    const window = loadJobs();
    await dispatch(window, 'register-provider', { provider: makeProvider({ providerId: 'provider.a' }).provider });
    await dispatch(window, 'register-provider', { provider: makeProvider({ providerId: 'provider.b' }).provider });

    const blocked = await dispatch(window, 'enqueue', enqueuePayload());
    assert.equal(blocked.status, 'provider-selection-required');

    window.slopsmith.jobs.setSelectedProvider('transcode', 'provider.b');
    const enqueued = await dispatch(window, 'enqueue', enqueuePayload({ logicalJobKey: 'selected-job' }));
    assert.equal(enqueued.status, 'applied');
    assert.equal(enqueued.payload.job.providerId, 'provider.b');
});

test('provider capacity starts one job and keeps the rest queued in priority order', async () => {
    const window = loadJobs();
    const { provider } = makeProvider({ capacity: { maxRunning: 1, maxQueued: 10 } });
    await dispatch(window, 'register-provider', { provider });

    const first = await dispatch(window, 'enqueue', enqueuePayload({ logicalJobKey: 'first', priority: 'background-maintenance' }));
    const second = await dispatch(window, 'enqueue', enqueuePayload({ logicalJobKey: 'second', priority: 'background-maintenance', safeLabel: 'Second' }));
    const third = await dispatch(window, 'enqueue', enqueuePayload({ logicalJobKey: 'third', priority: 'user-approved-interactive', safeLabel: 'Third' }));

    assert.equal(first.payload.job.state, 'running');
    assert.equal(second.payload.job.state, 'queued');
    assert.equal(third.payload.job.state, 'queued');

    window.slopsmith.jobs.complete(provider.providerId, first.payload.job.jobId, { resultSummary: 'done' });
    const snapshot = diagnosticsSnapshot(window);
    assert.equal(snapshot.jobs.active.length, 1);
    assert.equal(snapshot.jobs.active[0].safeLabel, 'Third');
});

test('progress, completion, and terminal retention are reflected in events and diagnostics', async () => {
    const window = loadJobs();
    const events = captureEvents(window);
    const { provider } = makeProvider();
    await dispatch(window, 'register-provider', { provider });
    const enqueued = await dispatch(window, 'enqueue', enqueuePayload());

    window.slopsmith.jobs.updateProgress(provider.providerId, enqueued.payload.job.jobId, { percent: 33, step: 'convert', message: 'Converting safely' });
    window.slopsmith.jobs.complete(provider.providerId, enqueued.payload.job.jobId, { resultSummary: 'Cache ready' });
    const snapshot = diagnosticsSnapshot(window);

    assert.equal(snapshot.jobs.active.length, 0);
    assert.equal(snapshot.jobs.recentTerminal.length, 1);
    assert.equal(snapshot.jobs.recentTerminal[0].terminalOutcome.status, 'completed');
    assert.ok(snapshot.jobs.recentTerminal[0].history.some(entry => entry.kind === 'progress'));
    assert.ok(events.some(event => event.event === 'progress'));
    assert.ok(events.some(event => event.event === 'completed'));
});

test('cancel, pause, resume, retry, and stale transitions use canonical outcomes', async () => {
    const window = loadJobs();
    const { provider } = makeProvider({ capacity: { maxRunning: 1, maxQueued: 10 } });
    await dispatch(window, 'register-provider', { provider });
    const enqueued = await dispatch(window, 'enqueue', enqueuePayload({ logicalJobKey: 'control-job' }));
    const jobId = enqueued.payload.job.jobId;

    assert.equal((await dispatch(window, 'pause', { jobId })).status, 'applied');
    assert.equal((await dispatch(window, 'resume', { jobId })).status, 'applied');
    assert.equal((await dispatch(window, 'pause', { jobId })).status, 'applied');
    assert.equal((await dispatch(window, 'cancel', { jobId })).status, 'applied');
    window.slopsmith.jobs.fail(provider.providerId, jobId, { category: 'provider-failure', safeReason: 'retryable failure', retryable: true });
    assert.equal((await dispatch(window, 'retry', { jobId, authorization: 'user-action' })).status, 'retry-started');
    assert.equal((await dispatch(window, 'retry', { jobId, authorization: 'user-action' })).status, 'stale');
});