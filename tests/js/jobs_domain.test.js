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