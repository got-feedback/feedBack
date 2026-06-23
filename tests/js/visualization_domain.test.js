const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createWindow, ROOT } = require('./capabilities_test_harness');

const CAPABILITIES_JS = path.join(ROOT, 'static', 'capabilities.js');
const VISUALIZATION_JS = path.join(ROOT, 'static', 'capabilities', 'visualization.js');

function loadVisualization(options = {}) {
    const window = createWindow(options);
    const context = vm.createContext(window);
    vm.runInContext(fs.readFileSync(CAPABILITIES_JS, 'utf8'), context, { filename: CAPABILITIES_JS });
    vm.runInContext(fs.readFileSync(VISUALIZATION_JS, 'utf8'), context, { filename: VISUALIZATION_JS });
    return window;
}

function captureEvents(api, eventNames) {
    const events = [];
    for (const name of eventNames) {
        api.subscribe(name, (detail) => events.push(detail));
    }
    return events;
}

test('visualization domain registers an active provider-coordinator owner', () => {
    const window = loadVisualization();
    const api = window.feedBack.capabilities;
    const pipeline = api.inspect('visualization');
    assert.ok(pipeline, 'visualization pipeline exists');
    const owner = (pipeline.participants || []).find(p => p.pluginId === 'core.visualization');
    assert.ok(owner, 'core.visualization owner registered');
    assert.ok(owner.roles.includes('owner'));
    assert.deepEqual(
        [...owner.commands].sort(),
        ['clear-renderer', 'inspect', 'list-providers', 'select-renderer'],
    );
    assert.equal(window.feedBack.vizDomain.version, 1);
});

test('visualization is no longer a reserved future domain', async () => {
    const window = loadVisualization();
    const api = window.feedBack.capabilities;
    const result = await api.dispatch({ capability: 'visualization', command: 'inspect', source: 'test' });
    assert.equal(result.outcome, 'handled');
    assert.equal(result.payload.current, 'default');
});

test('refreshProviders registers participants with factory metadata', () => {
    const window = loadVisualization();
    const api = window.feedBack.capabilities;
    const highway3d = () => ({});
    highway3d.contextType = 'webgl2';
    highway3d.matchesArrangement = () => true;
    window.feedBackViz_highway_3d = highway3d;
    window.feedBackViz_piano = () => ({});

    window.feedBack.vizDomain.refreshProviders([
        { id: 'highway_3d', label: '3D Highway' },
        { id: 'piano', label: 'Piano' },
        { id: 'auto', label: 'Auto' },          // built-ins are skipped
        { id: 'default', label: 'Classic' },
    ]);

    const pipeline = api.inspect('visualization');
    const ids = (pipeline.participants || []).map(p => p.pluginId).sort();
    assert.ok(ids.includes('highway_3d') && ids.includes('piano'));
    assert.ok(!ids.includes('auto') && !ids.includes('default'));

    const snapshot = window.feedBack.vizDomain.snapshot();
    const h3d = snapshot.providers.find(p => p.id === 'highway_3d');
    assert.equal(h3d.contextType, 'webgl2');
    assert.equal(h3d.claims, true);
    const piano = snapshot.providers.find(p => p.id === 'piano');
    assert.equal(piano.contextType, '2d');
    assert.equal(piano.claims, false);
});

test('refreshProviders surfaces declared per-instance settings in the snapshot', () => {
    const window = loadVisualization();
    const caps = window.feedBack.capabilities;
    window.feedBackViz_highway_3d = () => ({});
    window.feedBackViz_piano = () => ({});

    const settings = [
        { key: 'palette', label: 'Palette', type: 'select', default: 'default',
          options: [{ id: 'neon', label: 'Neon' }] },
        { key: 'cameraSmoothing', type: 'range', default: 0.5, min: 0, max: 1, step: 0.05 },
        // `default` is schema-unconstrained — exercise a nested object default.
        { key: 'origin', type: 'select', default: { x: 0, y: 0 } },
    ];
    // Settings flow through the generic participant model, not a side channel:
    // the provider declares them in its manifest capability, core registers +
    // normalizes them, and the host reads them back from the participant.
    caps.registerParticipant('highway_3d', { visualization: { roles: ['provider'], settings } });

    window.feedBack.vizDomain.refreshProviders([
        { id: 'highway_3d', label: '3D Highway' },
        { id: 'piano', label: 'Piano' },          // no settings declared
    ]);

    // inspect() — the generic surface — also carries the descriptors, not just
    // the visualization list-providers snapshot.
    const participant = (caps.inspect('visualization').participants || [])
        .find(p => p.pluginId === 'highway_3d');
    assert.deepEqual(JSON.parse(JSON.stringify(participant.settings)), settings);

    // inspect() returns deep clones — mutating a returned descriptor (incl. the
    // schema-unconstrained nested `default`) must not leak into registry state.
    participant.settings.find(s => s.key === 'origin').default.x = 999;
    const reread = (caps.inspect('visualization').participants || [])
        .find(p => p.pluginId === 'highway_3d');
    assert.equal(reread.settings.find(s => s.key === 'origin').default.x, 0);

    // list-providers carries the descriptors for consuming hosts; providers
    // without a declared settings list omit the field entirely.
    const snapshot = window.feedBack.vizDomain.snapshot();
    const h3d = snapshot.providers.find(p => p.id === 'highway_3d');
    // Value-equal (the host deep-clones, so compare plain values, not refs).
    assert.deepEqual(JSON.parse(JSON.stringify(h3d.settings)), settings);
    const piano = snapshot.providers.find(p => p.id === 'piano');
    assert.equal(piano.settings, undefined);

    // Descriptors are deep-frozen so a snapshot consumer can't mutate domain
    // state — including nested values under the unconstrained `default`.
    assert.ok(Object.isFrozen(h3d.settings));
    assert.ok(Object.isFrozen(h3d.settings[0]));
    assert.ok(Object.isFrozen(h3d.settings[0].options[0]));
    const origin = h3d.settings.find(s => s.key === 'origin');
    assert.ok(Object.isFrozen(origin.default));
    // Null-prototype clones — manifest-controlled keys can't pollute prototypes.
    assert.equal(Object.getPrototypeOf(h3d.settings[0]), null);

    // Ingestion is isolated too: mutating the caller's original input object
    // after registerParticipant() must not reach into registry state.
    settings.find(s => s.key === 'origin').default.x = 777;
    const afterCallerMutation = (caps.inspect('visualization').participants || [])
        .find(p => p.pluginId === 'highway_3d');
    assert.equal(afterCallerMutation.settings.find(s => s.key === 'origin').default.x, 0);
});

test('refreshProviders unregisters providers that disappeared', () => {
    const window = loadVisualization();
    const api = window.feedBack.capabilities;
    window.feedBackViz_gone = () => ({});
    window.feedBack.vizDomain.refreshProviders([{ id: 'gone', label: 'Gone' }]);
    assert.ok(api.inspect('visualization').participants.some(p => p.pluginId === 'gone'));
    window.feedBack.vizDomain.refreshProviders([]);
    assert.ok(!api.inspect('visualization').participants.some(p => p.pluginId === 'gone'));
});

test('select-renderer degrades on unknown provider and missing picker surface', async () => {
    const window = loadVisualization();
    const api = window.feedBack.capabilities;
    const unknown = await api.dispatch({
        capability: 'visualization', command: 'select-renderer',
        source: 'test', payload: { providerId: 'nope' },
    });
    assert.equal(unknown.outcome, 'degraded');
    assert.match(unknown.reason, /Unknown visualization provider/);

    window.feedBackViz_piano = () => ({});
    window.feedBack.vizDomain.refreshProviders([{ id: 'piano', label: 'Piano' }]);
    const noSurface = await api.dispatch({
        capability: 'visualization', command: 'select-renderer',
        source: 'test', payload: { providerId: 'piano' },
    });
    assert.equal(noSurface.outcome, 'degraded');
    assert.match(noSurface.reason, /selection surface unavailable/);
});

test('select-renderer and clear-renderer delegate to the app picker', async () => {
    const window = loadVisualization();
    const api = window.feedBack.capabilities;
    const calls = [];
    window.setViz = (id) => calls.push(id);
    window.feedBackViz_piano = () => ({});
    window.feedBack.vizDomain.refreshProviders([{ id: 'piano', label: 'Piano' }]);

    const select = await api.dispatch({
        capability: 'visualization', command: 'select-renderer',
        source: 'test', payload: { providerId: 'piano' },
    });
    assert.equal(select.outcome, 'handled');
    assert.equal(select.payload.selected, 'piano');

    const clear = await api.dispatch({ capability: 'visualization', command: 'clear-renderer', source: 'test' });
    assert.equal(clear.outcome, 'handled');
    assert.deepEqual(calls, ['piano', 'default']);
});

test('renderer change and failure are emitted as domain events', () => {
    const window = loadVisualization();
    const api = window.feedBack.capabilities;
    const events = captureEvents(api, [
        'visualization:renderer-changed',
        'visualization:renderer-failed',
    ]);

    window.feedBack.vizDomain.notifyRendererChanged('highway_3d', 'auto-match');
    window.feedBack.vizDomain.notifyRendererChanged('highway_3d', 'auto-match'); // same id — no event
    window.feedBack.vizDomain.notifyRendererFailed('highway_3d', 'init threw');

    const changed = events.filter(e => e.event === 'renderer-changed');
    assert.equal(changed.length, 1);
    assert.equal(changed[0].payload.from, 'default');
    assert.equal(changed[0].payload.to, 'highway_3d');
    assert.equal(changed[0].payload.source, 'auto-match');

    const failed = events.filter(e => e.event === 'renderer-failed');
    assert.equal(failed.length, 1);
    assert.equal(failed[0].payload.providerId, 'highway_3d');
});

test('legacy shim accounting appears in the diagnostics snapshot', () => {
    const window = loadVisualization();
    const api = window.feedBack.capabilities;
    window.feedBackViz_piano = () => ({});
    window.feedBack.vizDomain.refreshProviders([{ id: 'piano', label: 'Piano' }]);

    const snapshot = api.snapshotDiagnostics();
    const shims = (snapshot.compatibilityShims || []).filter(s => s.capability === 'visualization');
    // JSON round-trip: vm-context arrays have foreign prototypes, which
    // assert.deepEqual (strict) rejects on reference identity.
    const ids = JSON.parse(JSON.stringify(shims.map(s => s.shimId).sort()));
    assert.deepEqual(ids, [
        'visualization:type-visualization-manifest',
        'visualization:window.feedBackViz_*',
    ]);
    const windowShim = shims.find(s => s.shimId === 'visualization:window.feedBackViz_*');
    assert.equal(windowShim.status, 'used');
    assert.ok(windowShim.hitCount >= 1);
});

test('diagnostics contribution is redaction-safe (no song identity)', () => {
    const window = loadVisualization();
    window.feedBack.vizDomain.noteAutoMatch('piano', true);
    window.feedBack.vizDomain.notifyRendererFailed('piano', 'draw threw');
    const contribution = window.__diagnosticsContributions.get('visualization-capability');
    assert.equal(contribution.schema, 'feedBack.visualization_capability.v1');
    const serialized = JSON.stringify(contribution);
    assert.ok(!/filename|title|artist|\.sloppak|\.archive/i.test(serialized), serialized);
    assert.deepEqual(
        JSON.parse(JSON.stringify(contribution.lastAutoMatch)),
        { resolved: 'piano', matched: true },
    );
});

test('a still-reserved future domain rejects dispatch', async () => {
    // note-detection was promoted by the spec-009 slice; backend.routes is
    // the canary that the reserved list still guards unpromoted domains.
    const window = loadVisualization();
    const api = window.feedBack.capabilities;
    const result = await api.dispatch({ capability: 'backend.routes', command: 'inspect', source: 'test' });
    assert.notEqual(result.outcome, 'handled');
});
