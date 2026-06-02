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

test('provider queue capacity rejects excess queued work before creating a job', async () => {
    const window = loadJobs();
    const { provider } = makeProvider({ capacity: { maxRunning: 1, maxQueued: 1 } });
    await dispatch(window, 'register-provider', { provider });

    const running = await dispatch(window, 'enqueue', enqueuePayload({ logicalJobKey: 'capacity-running' }));
    const queued = await dispatch(window, 'enqueue', enqueuePayload({ logicalJobKey: 'capacity-queued' }));
    const rejected = await dispatch(window, 'enqueue', enqueuePayload({ logicalJobKey: 'capacity-rejected' }));
    const snapshot = diagnosticsSnapshot(window);

    assert.equal(running.status, 'applied');
    assert.equal(queued.status, 'queued');
    assert.equal(rejected.status, 'unavailable');
    assert.equal(snapshot.jobs.active.length, 1);
    assert.equal(snapshot.jobs.queued.length, 1);
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

test('provider enqueue exceptions fail safely without leaking private details', async () => {
    const window = loadJobs();
    const { provider } = makeProvider({
        operationHandlers: {
            'job.enqueue': () => { throw new Error('failed near /Users/example/private/song.sloppak token=abc123'); },
        },
    });
    await dispatch(window, 'register-provider', { provider });

    const result = await dispatch(window, 'enqueue', enqueuePayload({ logicalJobKey: 'throws-on-start' }));
    const snapshot = diagnosticsSnapshot(window);

    assert.equal(result.status, 'error');
    assert.equal(result.outcome, 'failed');
    assert.equal(snapshot.jobs.active.length, 0);
    assert.equal(snapshot.jobs.recentTerminal[0].terminalOutcome.category, 'provider-failure');
    assert.doesNotMatch(JSON.stringify(snapshot), /Users\/example|song\.sloppak|abc123/);
});

test('provider enqueue failed results become terminal failures', async () => {
    const window = loadJobs();
    const { provider } = makeProvider({
        operationHandlers: {
            'job.enqueue': () => ({ outcome: 'failed', category: 'external-dependency', safeReason: 'tool failed near /Users/example/private/cache.bin' }),
        },
    });
    await dispatch(window, 'register-provider', { provider });

    const result = await dispatch(window, 'enqueue', enqueuePayload({ logicalJobKey: 'failed-result' }));
    const snapshot = diagnosticsSnapshot(window);

    assert.equal(result.status, 'error');
    assert.equal(result.outcome, 'failed');
    assert.equal(snapshot.jobs.recentTerminal[0].terminalOutcome.category, 'external-dependency');
    assert.doesNotMatch(JSON.stringify(snapshot), /Users\/example|cache\.bin/);
});

test('async provider enqueue rejections become terminal provider failures', async () => {
    const window = loadJobs();
    const { provider } = makeProvider({
        operationHandlers: {
            'job.enqueue': () => Promise.reject(new Error('secret path /Users/example/private/cache.bin')),
        },
    });
    await dispatch(window, 'register-provider', { provider });

    const result = await dispatch(window, 'enqueue', enqueuePayload({ logicalJobKey: 'rejects-after-start' }));
    await Promise.resolve();
    await Promise.resolve();
    const snapshot = diagnosticsSnapshot(window);

    assert.equal(result.status, 'applied');
    assert.equal(snapshot.jobs.active.length, 0);
    assert.equal(snapshot.jobs.recentTerminal[0].terminalOutcome.category, 'provider-failure');
    assert.doesNotMatch(JSON.stringify(snapshot), /Users\/example|cache\.bin/);
});

test('retry accepts approved continuation using the stored scope key', async () => {
    const window = loadJobs();
    const { provider } = makeProvider({ providerId: 'provider.retry-continuation' });
    await dispatch(window, 'register-provider', { provider });
    const enqueued = await dispatch(window, 'enqueue', enqueuePayload({ providerId: provider.providerId, logicalJobKey: 'retry-continuation' }));
    const jobId = enqueued.payload.job.jobId;
    const approvalScopeKey = window.slopsmith.jobs._test.jobs.get(jobId).approvalScopeKey;

    window.slopsmith.jobs.fail(provider.providerId, jobId, { category: 'provider-failure', safeReason: 'retryable failure', retryable: true });
    const rejected = await dispatch(window, 'retry', { jobId, authorization: 'approved-continuation', approvalScopeKey: `${approvalScopeKey}-mismatch` });
    const retried = await dispatch(window, 'retry', { jobId, authorization: 'approved-continuation', approvalScopeKey });

    assert.equal(rejected.status, 'blocked');
    assert.equal(rejected.outcome, 'denied');
    assert.equal(retried.status, 'retry-started');
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