const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loadJobs, dispatch, makeProvider, enqueuePayload, diagnosticsSnapshot, diagnosticsContributions } = require('./jobs_test_harness');

test('jobs domain is active and registers the core provider coordinator owner', async () => {
    const window = loadJobs();
    const snapshot = window.slopsmith.capabilities.snapshotDiagnostics();
    const jobs = snapshot.pipelines.find(pipeline => pipeline.name === 'jobs');

    assert.ok(jobs);
    assert.equal(jobs.review.lifecycle, 'active');
    assert.equal(jobs.review.tone, 'clean');
    assert.ok(jobs.participants.some(participant => participant.pluginId === 'core.jobs' && participant.kind === 'provider-coordinator' && participant.safety === 'privileged'));

    const result = await dispatch(window, 'list-providers');
    assert.equal(result.status, 'applied');
    assert.equal(result.payload.providers.length, 0);
});

test('provider registration exposes safe metadata and rejects incompatible versions', async () => {
    const window = loadJobs();
    const { provider } = makeProvider({ providerId: 'provider.cache', label: 'Cache Builder', jobTypes: ['cache-build'] });

    const registered = await dispatch(window, 'register-provider', { provider });
    assert.equal(registered.status, 'applied');
    assert.equal(registered.payload.provider.providerId, 'provider.cache');
    assert.deepEqual(Array.from(registered.payload.provider.jobTypes), ['cache-build']);

    const incompatible = await dispatch(window, 'register-provider', { provider: { ...provider, providerId: 'provider.old', version: 2, safeReason: 'requires runtime v2' } });
    assert.equal(incompatible.status, 'incompatible-version');
    assert.equal(incompatible.payload.provider.availability, 'incompatible');
});

test('privileged enqueue requires approval before provider work starts', async () => {
    const window = loadJobs();
    const { calls, provider } = makeProvider();
    await dispatch(window, 'register-provider', { provider });

    const result = await dispatch(window, 'enqueue', enqueuePayload({ authorization: 'background' }));

    assert.equal(result.status, 'user-action-required');
    assert.equal(calls.length, 0);
    assert.equal(diagnosticsSnapshot(window).jobs.active.length, 0);
    assert.equal(diagnosticsContributions(window).jobs.schema, 'slopsmith.jobs.diagnostics.v1');
});

test('approved continuation enqueue matches the stored approval scope key', async () => {
    const window = loadJobs();
    const { calls, provider } = makeProvider({ capacity: { maxRunning: 2, maxQueued: 10 } });
    await dispatch(window, 'register-provider', { provider });
    const request = enqueuePayload({ target: { path: '/Users/example/DLC/Song A.sloppak' }, inputs: { token: 'secret-a' }, logicalJobKey: '' });
    const first = await dispatch(window, 'enqueue', request);
    const approvalScopeKey = window.slopsmith.jobs._test.jobs.get(first.payload.job.jobId).approvalScopeKey;

    const rejected = await dispatch(window, 'enqueue', { ...request, authorization: 'approved-continuation', approvalScopeKey: `${approvalScopeKey}-mismatch` });
    const continued = await dispatch(window, 'enqueue', { ...request, authorization: 'approved-continuation', approvalScopeKey });

    assert.equal(rejected.status, 'blocked');
    assert.equal(rejected.outcome, 'denied');
    assert.equal(continued.status, 'applied');
    assert.equal(calls.length, 2);
});

test('approved enqueue queues and starts with redaction-safe public job fields', async () => {
    const window = loadJobs();
    const { calls, provider } = makeProvider({ capacity: { maxRunning: 1, maxQueued: 10 } });
    await dispatch(window, 'register-provider', { provider });

    const result = await dispatch(window, 'enqueue', enqueuePayload({ target: { path: '/Users/example/DLC/Secret.sloppak' }, inputs: { token: 'secret', safeFingerprint: 'fingerprint-1' } }));
    const job = result.payload.job;

    assert.equal(result.status, 'applied');
    assert.equal(job.state, 'running');
    assert.equal(job.targetRef.startsWith('target-'), true);
    assert.equal(job.inputFingerprint, 'fingerprint-1');
    assert.equal(calls.length, 1);
    assert.doesNotMatch(JSON.stringify(diagnosticsSnapshot(window)), /Secret\.sloppak|token|secret/);
});

test('provider-private enqueue payload reaches only the provider callback', async () => {
    const window = loadJobs();
    let privatePayload = null;
    const { provider } = makeProvider({
        operationHandlers: {
            'job.enqueue': request => {
                privatePayload = request.providerPayload;
                return { outcome: 'handled' };
            },
        },
    });
    await dispatch(window, 'register-provider', { provider });

    const result = await dispatch(window, 'enqueue', enqueuePayload({
        providerPayload: { filename: '/Users/example/DLC/Secret Song.sloppak', token: 'abc123' },
        target: { safeRef: 'target-secret-song' },
        inputs: { safeFingerprint: 'input-secret-song' },
    }));

    assert.equal(result.status, 'applied');
    assert.deepEqual(privatePayload, { filename: '/Users/example/DLC/Secret Song.sloppak', token: 'abc123' });
    assert.doesNotMatch(JSON.stringify(result.payload.job), /Secret Song|abc123|filename/);
    assert.doesNotMatch(JSON.stringify(diagnosticsSnapshot(window)), /Secret Song|abc123|filename/);
});

test('adopted provider-owned jobs do not invoke enqueue handlers', async () => {
    const window = loadJobs();
    const { calls, provider } = makeProvider({ providerId: 'provider.backend', capacity: { maxRunning: 1, maxQueued: 10 } });
    await dispatch(window, 'register-provider', { provider });

    const adopted = await dispatch(window, 'adopt', enqueuePayload({
        providerId: 'provider.backend',
        jobId: 'backend-job-1',
        state: 'queued',
        logicalJobKey: 'legacy-backend-job-1',
        safeLabel: 'Convert existing backend row',
    }));
    const native = await dispatch(window, 'enqueue', enqueuePayload({ providerId: 'provider.backend', logicalJobKey: 'native-after-adopt' }));

    assert.equal(adopted.status, 'applied');
    assert.equal(adopted.payload.job.externallyManaged, true);
    assert.equal(adopted.payload.job.state, 'queued');
    assert.equal(native.status, 'applied');
    assert.equal(native.payload.job.state, 'running');
    assert.equal(calls.length, 1);
    assert.equal(calls[0][1].job.jobId, native.payload.job.jobId);
});

test('provider can report a running job as cancelled', async () => {
    const window = loadJobs();
    const { provider } = makeProvider({ providerId: 'provider.cancelled' });
    await dispatch(window, 'register-provider', { provider });
    const enqueued = await dispatch(window, 'enqueue', enqueuePayload({ providerId: provider.providerId }));

    const result = window.slopsmith.jobs.cancelled(provider.providerId, enqueued.payload.job.jobId, { safeReason: 'User stopped backend conversion' });
    const snapshot = diagnosticsSnapshot(window);

    assert.equal(result.outcome, 'cancelled');
    assert.equal(snapshot.jobs.active.length, 0);
    assert.equal(snapshot.jobs.recentTerminal[0].state, 'cancelled');
    assert.equal(snapshot.jobs.recentTerminal[0].terminalOutcome.category, 'cancellation');
});

test('list and inspect are prompt-free and do not invoke provider callbacks', async () => {
    const window = loadJobs();
    const { calls, provider } = makeProvider();
    await dispatch(window, 'register-provider', { provider });
    const enqueued = await dispatch(window, 'enqueue', enqueuePayload());
    calls.length = 0;

    const listed = await dispatch(window, 'list');
    const inspected = await dispatch(window, 'inspect', { jobId: enqueued.payload.job.jobId });

    assert.equal(listed.status, 'applied');
    assert.equal(inspected.status, 'applied');
    assert.equal(listed.payload.jobs.length, 1);
    assert.equal(inspected.payload.job.jobId, enqueued.payload.job.jobId);
    assert.equal(calls.length, 0);
});