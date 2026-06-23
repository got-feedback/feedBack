const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createWindow, ROOT } = require('./capabilities_test_harness');

const CAPABILITIES_JS = path.join(ROOT, 'static', 'capabilities.js');
const NOTE_DETECTION_JS = path.join(ROOT, 'static', 'capabilities', 'note-detection.js');

function loadNoteDetection(options = {}) {
    const window = createWindow(options);
    const context = vm.createContext(window);
    vm.runInContext(fs.readFileSync(CAPABILITIES_JS, 'utf8'), context, { filename: CAPABILITIES_JS });
    vm.runInContext(fs.readFileSync(NOTE_DETECTION_JS, 'utf8'), context, { filename: NOTE_DETECTION_JS });
    return window;
}

function captureEvents(api, eventNames) {
    const events = [];
    for (const name of eventNames) {
        api.subscribe(name, (detail) => events.push(detail));
    }
    return events;
}

async function registerMidiProvider(api) {
    return api.dispatch({
        capability: 'note-detection', command: 'register-provider',
        source: 'keys_highway_3d',
        payload: { providerId: 'keys-midi', label: 'Keys MIDI', kind: 'midi', primitives: ['verify.target'] },
    });
}

test('note-detection domain registers an active sensitive provider-coordinator', () => {
    const window = loadNoteDetection();
    const api = window.feedBack.capabilities;
    const pipeline = api.inspect('note-detection');
    assert.ok(pipeline, 'note-detection pipeline exists');
    const owner = (pipeline.participants || []).find(p => p.pluginId === 'core.note-detection');
    assert.ok(owner, 'core.note-detection owner registered');
    assert.equal(owner.safety, 'sensitive');
    assert.ok(owner.commands.includes('open-binding'));
    assert.equal(window.feedBack.noteDetection.version, 1);
});

test('open-binding without a provider reports unavailable, never a silent verdict', async () => {
    const window = loadNoteDetection();
    const api = window.feedBack.capabilities;
    const result = await api.dispatch({
        capability: 'note-detection', command: 'open-binding',
        source: 'keys_highway_3d', payload: { context: { arrangement: 'keys' } },
    });
    assert.equal(result.outcome, 'unavailable');
    assert.match(result.reason, /No note-detection provider/);
});

test('provider registration + binding lifecycle with per-binding context', async () => {
    const window = loadNoteDetection();
    const api = window.feedBack.capabilities;
    const events = captureEvents(api, [
        'note-detection:provider-registered',
        'note-detection:binding-opened',
        'note-detection:binding-closed',
        'note-detection:target-changed',
    ]);

    const reg = await registerMidiProvider(api);
    assert.equal(reg.outcome, 'handled');
    assert.ok(api.inspect('note-detection').participants.some(p => p.pluginId === 'keys_highway_3d'));

    const open = await api.dispatch({
        capability: 'note-detection', command: 'open-binding',
        source: 'keys_highway_3d',
        payload: { providerId: 'keys-midi', context: { arrangement: 'keys', midiLow: 21, midiHigh: 108, capo: 0 } },
    });
    assert.equal(open.outcome, 'handled');
    const bindingId = open.payload.bindingId;
    assert.ok(bindingId);
    const binding = open.payload.bindings.find(b => b.id === bindingId);
    assert.equal(binding.context.arrangement, 'keys');
    assert.equal(binding.context.midiLow, 21);

    const target = await api.dispatch({
        capability: 'note-detection', command: 'set-target',
        source: 'keys_highway_3d',
        payload: { bindingId, notes: [{ midi: 60 }, { midi: 64 }, { midi: 67 }] },
    });
    assert.equal(target.outcome, 'handled');
    assert.equal(target.payload.targetSize, 3);

    const close = await api.dispatch({
        capability: 'note-detection', command: 'close-binding',
        source: 'keys_highway_3d', payload: { bindingId },
    });
    assert.equal(close.outcome, 'handled');

    const names = events.map(e => e.event);
    assert.ok(names.includes('provider-registered'));
    assert.ok(names.includes('binding-opened'));
    assert.ok(names.includes('target-changed'));
    assert.ok(names.includes('binding-closed'));
});

test('concurrent bindings keep independent contexts (FR-003)', async () => {
    const window = loadNoteDetection();
    const api = window.feedBack.capabilities;
    await registerMidiProvider(api);
    const a = await api.dispatch({
        capability: 'note-detection', command: 'open-binding',
        source: 'highway', payload: { context: { arrangement: 'guitar', stringCount: 6, capo: 2 } },
    });
    const b = await api.dispatch({
        capability: 'note-detection', command: 'open-binding',
        source: 'slopscale', payload: { context: { arrangement: 'bass', stringCount: 4, capo: 0 } },
    });
    const snapshot = window.feedBack.noteDetection.snapshot();
    const ctxA = snapshot.bindings.find(x => x.id === a.payload.bindingId).context;
    const ctxB = snapshot.bindings.find(x => x.id === b.payload.bindingId).context;
    assert.equal(ctxA.arrangement, 'guitar');
    assert.equal(ctxA.capo, 2);
    assert.equal(ctxB.arrangement, 'bass');
    assert.equal(ctxB.capo, 0);
});

test('unregistering a provider closes its bindings and flips availability', async () => {
    const window = loadNoteDetection();
    const api = window.feedBack.capabilities;
    const events = captureEvents(api, ['note-detection:availability-changed', 'note-detection:binding-closed']);
    await registerMidiProvider(api);
    const openResult = await api.dispatch({ capability: 'note-detection', command: 'open-binding', source: 'keys_highway_3d', payload: {} });
    assert.equal(openResult.outcome, 'handled');
    assert.equal(window.feedBack.noteDetection.snapshot().bindings.length, 1);
    const result = await api.dispatch({
        capability: 'note-detection', command: 'unregister-provider',
        source: 'keys_highway_3d', payload: { providerId: 'keys-midi' },
    });
    assert.equal(result.outcome, 'handled');
    assert.equal(window.feedBack.noteDetection.snapshot().bindings.length, 0);
    const availability = events.filter(e => e.event === 'availability-changed').map(e => e.payload.available);
    assert.deepEqual(JSON.parse(JSON.stringify(availability)), [true, false]);
    assert.ok(events.some(e => e.event === 'binding-closed' && e.payload.reason === 'provider-unregistered'));
    // Runtime participant must be removed from the pipeline so inspect() no
    // longer lists the provider as active after it unregisters.
    const participants = api.inspect('note-detection').participants || [];
    assert.ok(!participants.some(p => p.pluginId === 'keys_highway_3d' && (p.roles || []).includes('provider')),
        'provider participant should be removed from the pipeline on unregister');
});

test('hit/miss reports flow as observability events with bounded fields', () => {
    const window = loadNoteDetection();
    const api = window.feedBack.capabilities;
    const events = captureEvents(api, ['note-detection:hit', 'note-detection:miss']);
    window.feedBack.noteDetection.reportHit({ bindingId: 'ndb-1', providerId: 'keys-midi', midi: 64, hit: true, secretDevice: 'Yamaha P-125' });
    window.feedBack.noteDetection.reportMiss({ bindingId: 'ndb-1', providerId: 'keys-midi', midi: 65, hit: false });
    assert.equal(events.length, 2);
    assert.equal(events[0].payload.midi, 64);
    // Unknown fields are dropped — payloads stay bounded and device-label free.
    assert.equal(events[0].payload.secretDevice, undefined);
    assert.equal(events[1].event, 'miss');
});

test('diagnostics contribution is redaction-safe', async () => {
    const window = loadNoteDetection();
    const api = window.feedBack.capabilities;
    await registerMidiProvider(api);
    await api.dispatch({
        capability: 'note-detection', command: 'open-binding',
        source: 'keys_highway_3d', payload: { context: { arrangement: 'keys', deviceLabel: 'Yamaha P-125' } },
    });
    window.feedBack.noteDetection.reportHit({ bindingId: 'ndb-1', midi: 60, hit: true });
    const contribution = window.__diagnosticsContributions.get('note-detection-capability');
    assert.equal(contribution.schema, 'feedBack.note_detection_capability.v1');
    const serialized = JSON.stringify(contribution);
    assert.ok(!/Yamaha|deviceLabel|filename|\.sloppak|\.archive/i.test(serialized), serialized);
});

test('legacy setNoteStateProvider surface is wrapped and accounted', () => {
    const window = loadNoteDetection();
    const api = window.feedBack.capabilities;
    // Simulate highway.js arriving after the host, then the notedetect
    // plugin installing its chart-coupled provider.
    let installed = null;
    window.highway = { setNoteStateProvider(fn) { installed = fn; } };
    window.feedBack.emit('song:loaded', {});
    const provider = () => ({ state: 'hit' });
    window.highway.setNoteStateProvider(provider);
    assert.equal(installed, provider, 'legacy behavior preserved');
    const shims = api.snapshotDiagnostics().compatibilityShims
        .filter(s => s.capability === 'note-detection');
    assert.equal(shims.length, 1);
    assert.equal(shims[0].shimId, 'note-detection:highway.setNoteStateProvider');
    assert.equal(shims[0].status, 'used');
    assert.ok(shims[0].hitCount >= 1);
});

test('unsupported binding/provider ids degrade with bounded reasons (FR-008)', async () => {
    const window = loadNoteDetection();
    const api = window.feedBack.capabilities;
    await registerMidiProvider(api);
    const badProvider = await api.dispatch({
        capability: 'note-detection', command: 'open-binding',
        source: 'x', payload: { providerId: 'nope' },
    });
    assert.equal(badProvider.outcome, 'degraded');
    const badBinding = await api.dispatch({
        capability: 'note-detection', command: 'set-target',
        source: 'x', payload: { bindingId: 'ndb-999', notes: [] },
    });
    assert.equal(badBinding.outcome, 'degraded');
});

test('_contextSummary whitelists arrangement kind — unknown values are dropped', async () => {
    const window = loadNoteDetection();
    const api = window.feedBack.capabilities;
    await registerMidiProvider(api);
    // Known arrangement kinds pass through.
    const open = await api.dispatch({
        capability: 'note-detection', command: 'open-binding',
        source: 'caller', payload: { context: { arrangement: 'keys', stringCount: 6 } },
    });
    assert.equal(open.outcome, 'handled');
    const snap = window.feedBack.noteDetection.snapshot();
    const ctx = snap.bindings.find(b => b.id === open.payload.bindingId).context;
    assert.equal(ctx.arrangement, 'keys');

    // Arbitrary string must not appear in context summary.
    const open2 = await api.dispatch({
        capability: 'note-detection', command: 'open-binding',
        source: 'caller', payload: { context: { arrangement: '/Users/victim/song.archive' } },
    });
    assert.equal(open2.outcome, 'handled');
    const snap2 = window.feedBack.noteDetection.snapshot();
    const ctx2 = snap2.bindings.find(b => b.id === open2.payload.bindingId).context;
    assert.equal(ctx2.arrangement, undefined, 'path-bearing arrangement must be dropped');
});

test('snapshot primitives are deep-copied — caller cannot mutate provider internals', async () => {
    const window = loadNoteDetection();
    const api = window.feedBack.capabilities;
    await registerMidiProvider(api);
    const snap1 = window.feedBack.noteDetection.snapshot();
    const providerEntry = snap1.providers.find(p => p.id === 'keys-midi');
    assert.ok(Array.isArray(providerEntry.primitives));
    // Mutate the copy — must not affect subsequent snapshots.
    providerEntry.primitives.push('injected');
    const snap2 = window.feedBack.noteDetection.snapshot();
    const providerEntry2 = snap2.providers.find(p => p.id === 'keys-midi');
    assert.ok(!providerEntry2.primitives.includes('injected'), 'live primitives must not be mutated via snapshot');
});

test('close-binding and set-target enforce requester ownership', async () => {
    const window = loadNoteDetection();
    const api = window.feedBack.capabilities;
    await registerMidiProvider(api);
    const open = await api.dispatch({
        capability: 'note-detection', command: 'open-binding',
        source: 'owner-plugin', payload: {},
    });
    const bindingId = open.payload.bindingId;

    // A different requester must not close the binding.
    const stealClose = await api.dispatch({
        capability: 'note-detection', command: 'close-binding',
        source: 'other-plugin', payload: { bindingId },
    });
    assert.equal(stealClose.outcome, 'degraded', 'non-owner close must be rejected');

    // A different requester must not retarget the binding.
    const stealTarget = await api.dispatch({
        capability: 'note-detection', command: 'set-target',
        source: 'other-plugin', payload: { bindingId, notes: [{ midi: 60 }] },
    });
    assert.equal(stealTarget.outcome, 'degraded', 'non-owner set-target must be rejected');

    // The binding must still exist and be closeable by the original owner.
    const ownerClose = await api.dispatch({
        capability: 'note-detection', command: 'close-binding',
        source: 'owner-plugin', payload: { bindingId },
    });
    assert.equal(ownerClose.outcome, 'handled');
});

test('register-provider rejects cross-owner re-registration', async () => {
    const window = loadNoteDetection();
    const api = window.feedBack.capabilities;
    // First registration by plugin-a.
    const first = await api.dispatch({
        capability: 'note-detection', command: 'register-provider',
        source: 'plugin-a',
        payload: { providerId: 'shared-provider', label: 'Shared', kind: 'js', primitives: [] },
    });
    assert.equal(first.outcome, 'handled');

    // A different participant must not overwrite the same providerId.
    const steal = await api.dispatch({
        capability: 'note-detection', command: 'register-provider',
        source: 'plugin-b',
        payload: { providerId: 'shared-provider', label: 'Hijacked', kind: 'js', primitives: [] },
    });
    assert.equal(steal.outcome, 'degraded', 'cross-owner re-registration must be rejected');

    // The original owner may still update its own registration.
    const refresh = await api.dispatch({
        capability: 'note-detection', command: 'register-provider',
        source: 'plugin-a',
        payload: { providerId: 'shared-provider', label: 'Refreshed', kind: 'js', primitives: [] },
    });
    assert.equal(refresh.outcome, 'handled', 'owner may refresh its own registration');
});

test('unregister-provider rejects cross-owner unregister', async () => {
    const window = loadNoteDetection();
    const api = window.feedBack.capabilities;
    await registerMidiProvider(api);

    // A different participant must not unregister a provider it does not own.
    const steal = await api.dispatch({
        capability: 'note-detection', command: 'unregister-provider',
        source: 'other-plugin', payload: { providerId: 'keys-midi' },
    });
    assert.equal(steal.outcome, 'degraded', 'cross-owner unregister must be rejected');

    // Provider must still be present after the failed cross-owner attempt.
    const snap = window.feedBack.noteDetection.snapshot();
    assert.ok(snap.providers.some(p => p.id === 'keys-midi'), 'provider must survive cross-owner unregister attempt');

    // The original owner can still unregister.
    const ownerUnreg = await api.dispatch({
        capability: 'note-detection', command: 'unregister-provider',
        source: 'keys_highway_3d', payload: { providerId: 'keys-midi' },
    });
    assert.equal(ownerUnreg.outcome, 'handled', 'owner must be able to unregister its own provider');
});

test('availability-changed fires only on 0→1 and 1→0 transitions', async () => {
    const window = loadNoteDetection();
    const api = window.feedBack.capabilities;
    const events = captureEvents(api, ['note-detection:availability-changed']);

    // First registration: 0→1, should emit.
    await registerMidiProvider(api);
    // Second registration of a different provider by same owner: already available, must NOT emit.
    await api.dispatch({
        capability: 'note-detection', command: 'register-provider',
        source: 'plugin-b',
        payload: { providerId: 'engine-provider', label: 'Engine', kind: 'engine', primitives: [] },
    });
    // Unregister first provider: still one left, must NOT emit.
    await api.dispatch({
        capability: 'note-detection', command: 'unregister-provider',
        source: 'keys_highway_3d', payload: { providerId: 'keys-midi' },
    });
    // Unregister last provider: 1→0, should emit false.
    await api.dispatch({
        capability: 'note-detection', command: 'unregister-provider',
        source: 'plugin-b', payload: { providerId: 'engine-provider' },
    });

    const available = events.map(e => e.payload.available);
    assert.deepEqual(JSON.parse(JSON.stringify(available)), [true, false],
        'only the 0→1 and final 1→0 transitions should emit availability-changed');
});

test('unregistering one of two providers from the same participant keeps participant in the pipeline', async () => {
    const window = loadNoteDetection();
    const api = window.feedBack.capabilities;

    // One plugin registers two providers under the same participantId.
    await api.dispatch({
        capability: 'note-detection', command: 'register-provider',
        source: 'multi-plugin',
        payload: { providerId: 'multi-provider-a', label: 'A', kind: 'js', primitives: [] },
    });
    await api.dispatch({
        capability: 'note-detection', command: 'register-provider',
        source: 'multi-plugin',
        payload: { providerId: 'multi-provider-b', label: 'B', kind: 'js', primitives: [] },
    });

    // Unregister one provider — the participant must remain in the pipeline
    // because the second provider from the same plugin still exists.
    const unreg = await api.dispatch({
        capability: 'note-detection', command: 'unregister-provider',
        source: 'multi-plugin', payload: { providerId: 'multi-provider-a' },
    });
    assert.equal(unreg.outcome, 'handled');

    const snap = window.feedBack.noteDetection.snapshot();
    assert.ok(!snap.providers.some(p => p.id === 'multi-provider-a'), 'provider-a must be removed');
    assert.ok(snap.providers.some(p => p.id === 'multi-provider-b'), 'provider-b must still be present');
    const participants = api.inspect('note-detection').participants || [];
    assert.ok(participants.some(p => p.pluginId === 'multi-plugin'),
        'multi-plugin participant must remain in pipeline while it still has a live provider');
});
