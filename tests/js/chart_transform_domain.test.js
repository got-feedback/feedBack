const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createWindow, ROOT } = require('./capabilities_test_harness');

const CAPABILITIES_JS = path.join(ROOT, 'static', 'capabilities.js');
const CHART_TRANSFORM_JS = path.join(ROOT, 'static', 'capabilities', 'chart-transform.js');

const STORAGE_KEY = 'feedBack.chartTransform.selectedProviderId';

function makeFakeHighway() {
    const calls = { set: [], refresh: 0 };
    return {
        calls,
        setChartTransform(p) { calls.set.push(p); },
        refreshChartTransform() { calls.refresh += 1; },
        getChartTransform() { return calls.set.length ? calls.set[calls.set.length - 1] : null; },
    };
}

function loadChartTransform(options = {}) {
    const window = createWindow(options);
    // The real bus provides feedBack.on; the harness only has emit →
    // dispatchEvent. Shim `on` the same way app.js implements it so the
    // module's bus mirroring (song:ready, chart-transform-failed) is live.
    window.feedBack.on = (type, handler) => window.addEventListener(type, handler);
    if (options.highway) window.highway = options.highway;
    if (options.persistedSelection) window.localStorage.setItem(STORAGE_KEY, options.persistedSelection);
    const context = vm.createContext(window);
    vm.runInContext(fs.readFileSync(CAPABILITIES_JS, 'utf8'), context, { filename: CAPABILITIES_JS });
    vm.runInContext(fs.readFileSync(CHART_TRANSFORM_JS, 'utf8'), context, { filename: CHART_TRANSFORM_JS });
    return window;
}

function captureEvents(api, eventNames) {
    const events = [];
    for (const name of eventNames) {
        api.subscribe(name, (detail) => events.push(detail));
    }
    return events;
}

async function registerProvider(api, overrides = {}) {
    return api.dispatch({
        capability: 'chart-transform', command: 'register-provider',
        source: overrides.source || 'chart_retuner',
        payload: {
            providerId: overrides.providerId || 'chart-retuner',
            label: overrides.label || 'Chart Retuner',
            transform: overrides.transform || ((input) => ({ notes: input.notes })),
        },
    });
}

test('chart-transform domain registers a safe provider-coordinator owner', () => {
    const window = loadChartTransform();
    const api = window.feedBack.capabilities;
    const pipeline = api.inspect('chart-transform');
    assert.ok(pipeline, 'chart-transform pipeline exists');
    const owner = (pipeline.participants || []).find(p => p.pluginId === 'core.chart-transform');
    assert.ok(owner, 'core.chart-transform owner registered');
    assert.equal(owner.safety, 'safe');
    assert.ok(owner.commands.includes('select-provider'));
    assert.ok(owner.commands.includes('refresh'));
    assert.equal(window.feedBack.chartTransformDomain.version, 1);
});

test('register-provider requires a transform function', async () => {
    const window = loadChartTransform();
    const api = window.feedBack.capabilities;
    const result = await api.dispatch({
        capability: 'chart-transform', command: 'register-provider',
        source: 'chart_retuner', payload: { providerId: 'chart-retuner' },
    });
    assert.equal(result.outcome, 'degraded');
    assert.match(result.reason, /transform\(input\) function/);
});

test('register + select installs the provider on the highway and persists', async () => {
    const highway = makeFakeHighway();
    const window = loadChartTransform({ highway });
    const api = window.feedBack.capabilities;
    const events = captureEvents(api, [
        'chart-transform:provider-registered',
        'chart-transform:transform-changed',
    ]);

    const reg = await registerProvider(api);
    assert.equal(reg.outcome, 'handled');
    assert.ok(api.inspect('chart-transform').participants.some(p => p.pluginId === 'chart_retuner'));

    const sel = await api.dispatch({
        capability: 'chart-transform', command: 'select-provider',
        source: 'settings_ui', payload: { providerId: 'chart-retuner' },
    });
    assert.equal(sel.outcome, 'handled');
    assert.equal(sel.payload.active, 'chart-retuner');
    assert.equal(sel.payload.installed, true);
    assert.equal(highway.calls.set.length, 1);
    assert.equal(highway.calls.set[0].id, 'chart-retuner');
    assert.equal(typeof highway.calls.set[0].transform, 'function');
    assert.equal(window.localStorage.getItem(STORAGE_KEY), 'chart-retuner');

    const names = events.map(e => e.event);
    assert.ok(names.includes('provider-registered'));
    assert.ok(names.includes('transform-changed'));
});

test('select-provider with an unknown id degrades', async () => {
    const window = loadChartTransform();
    const api = window.feedBack.capabilities;
    const result = await api.dispatch({
        capability: 'chart-transform', command: 'select-provider',
        source: 'settings_ui', payload: { providerId: 'nope' },
    });
    assert.equal(result.outcome, 'degraded');
    assert.match(result.reason, /Unknown chart-transform provider/);
});

test('selection without a highway is kept and installed on song:ready', async () => {
    const window = loadChartTransform();
    const api = window.feedBack.capabilities;
    await registerProvider(api);
    const sel = await api.dispatch({
        capability: 'chart-transform', command: 'select-provider',
        source: 'settings_ui', payload: { providerId: 'chart-retuner' },
    });
    assert.equal(sel.outcome, 'handled');
    assert.equal(sel.payload.installed, false, 'no highway yet');

    const highway = makeFakeHighway();
    window.highway = highway;
    window.feedBack.emit('song:ready', {});
    assert.equal(highway.calls.set.length, 1);
    assert.equal(highway.calls.set[0].id, 'chart-retuner');
    assert.equal(window.feedBack.chartTransformDomain.snapshot().installed, true);
});

test('a persisted selection restores when its provider registers', async () => {
    const highway = makeFakeHighway();
    const window = loadChartTransform({ highway, persistedSelection: 'chart-retuner' });
    const api = window.feedBack.capabilities;
    await registerProvider(api);
    const snapshot = window.feedBack.chartTransformDomain.snapshot();
    assert.equal(snapshot.active, 'chart-retuner');
    assert.equal(snapshot.activeSource, 'restore-selection');
    assert.equal(highway.calls.set.length, 1);
});

test('unregister is registrant-only and detaches the active provider', async () => {
    const highway = makeFakeHighway();
    const window = loadChartTransform({ highway });
    const api = window.feedBack.capabilities;
    await registerProvider(api);
    await api.dispatch({
        capability: 'chart-transform', command: 'select-provider',
        source: 'settings_ui', payload: { providerId: 'chart-retuner' },
    });

    const denied = await api.dispatch({
        capability: 'chart-transform', command: 'unregister-provider',
        source: 'someone_else', payload: { providerId: 'chart-retuner' },
    });
    assert.equal(denied.outcome, 'degraded');
    assert.match(denied.reason, /original registrant/);

    const ok = await api.dispatch({
        capability: 'chart-transform', command: 'unregister-provider',
        source: 'chart_retuner', payload: { providerId: 'chart-retuner' },
    });
    assert.equal(ok.outcome, 'handled');
    const snapshot = window.feedBack.chartTransformDomain.snapshot();
    assert.equal(snapshot.active, null);
    assert.equal(snapshot.providers.length, 0);
    // Detach = a trailing setChartTransform(null) on the highway.
    assert.equal(highway.calls.set[highway.calls.set.length - 1], null);
    // Persisted selection survives so re-registration re-activates.
    assert.equal(window.localStorage.getItem(STORAGE_KEY), 'chart-retuner');
});

test('unregister keeps a participant while another provider still references it', async () => {
    const window = loadChartTransform();
    const api = window.feedBack.capabilities;
    await registerProvider(api, { providerId: 'guitar-retuner' });
    await registerProvider(api, { providerId: 'bass-retuner' });

    await api.dispatch({
        capability: 'chart-transform', command: 'unregister-provider',
        source: 'chart_retuner', payload: { providerId: 'guitar-retuner' },
    });

    const participant = api.inspect('chart-transform').participants
        .find(p => p.pluginId === 'chart_retuner');
    assert.ok(participant, 'the shared participant remains registered');
    assert.deepEqual(
        Array.from(window.feedBack.chartTransformDomain.snapshot().providers, p => p.id),
        ['bass-retuner'],
    );

    await api.dispatch({
        capability: 'chart-transform', command: 'unregister-provider',
        source: 'chart_retuner', payload: { providerId: 'bass-retuner' },
    });
    assert.ok(!api.inspect('chart-transform').participants
        .some(p => p.pluginId === 'chart_retuner'), 'the final removal unregisters the participant');
});

test('clear-provider clears the highway hook and the persisted selection', async () => {
    const highway = makeFakeHighway();
    const window = loadChartTransform({ highway });
    const api = window.feedBack.capabilities;
    await registerProvider(api);
    await api.dispatch({
        capability: 'chart-transform', command: 'select-provider',
        source: 'settings_ui', payload: { providerId: 'chart-retuner' },
    });
    const result = await api.dispatch({
        capability: 'chart-transform', command: 'clear-provider', source: 'settings_ui',
    });
    assert.equal(result.outcome, 'handled');
    assert.equal(highway.calls.set[highway.calls.set.length - 1], null);
    assert.equal(window.localStorage.getItem(STORAGE_KEY), null);
});

test('refresh re-runs the installed transform', async () => {
    const highway = makeFakeHighway();
    const window = loadChartTransform({ highway });
    const api = window.feedBack.capabilities;
    await registerProvider(api);
    await api.dispatch({
        capability: 'chart-transform', command: 'select-provider',
        source: 'settings_ui', payload: { providerId: 'chart-retuner' },
    });
    const result = await api.dispatch({ capability: 'chart-transform', command: 'refresh', source: 'chart_retuner' });
    assert.equal(result.outcome, 'handled');
    assert.equal(result.payload.refreshed, true);
    assert.equal(highway.calls.refresh, 1);
});

test('announced highway instances (splitscreen panels) get the active transform', async () => {
    const primary = makeFakeHighway();
    const window = loadChartTransform({ highway: primary });
    const api = window.feedBack.capabilities;
    await registerProvider(api);
    await api.dispatch({
        capability: 'chart-transform', command: 'select-provider',
        source: 'settings_ui', payload: { providerId: 'chart-retuner' },
    });
    assert.equal(window.feedBack.chartTransformDomain.snapshot().surfaces, 1);

    // A splitscreen panel announces its own createHighway() instance.
    const panel = makeFakeHighway();
    window.feedBack.emit('highway:created', { highway: panel });
    assert.equal(panel.calls.set.length, 1, 'panel receives the active transform');
    assert.equal(panel.calls.set[0].id, 'chart-retuner');
    assert.equal(window.feedBack.chartTransformDomain.snapshot().surfaces, 2);

    // Refresh reaches every surface.
    await api.dispatch({ capability: 'chart-transform', command: 'refresh', source: 'chart_retuner' });
    assert.equal(primary.calls.refresh, 1);
    assert.equal(panel.calls.refresh, 1);

    // Clearing detaches every surface.
    await api.dispatch({ capability: 'chart-transform', command: 'clear-provider', source: 'settings_ui' });
    assert.equal(primary.calls.set[primary.calls.set.length - 1], null);
    assert.equal(panel.calls.set[panel.calls.set.length - 1], null);
});

test('a panel announced before any selection installs on later select', async () => {
    const window = loadChartTransform();
    const api = window.feedBack.capabilities;
    const panel = makeFakeHighway();
    window.feedBack.emit('highway:created', { highway: panel });
    await registerProvider(api);
    const sel = await api.dispatch({
        capability: 'chart-transform', command: 'select-provider',
        source: 'settings_ui', payload: { providerId: 'chart-retuner' },
    });
    assert.equal(sel.outcome, 'handled');
    assert.equal(panel.calls.set.length, 1);
    assert.equal(panel.calls.set[0].id, 'chart-retuner');
});

test('highway failure events expose a fixed public reason', async () => {
    const highway = makeFakeHighway();
    const window = loadChartTransform({ highway });
    const api = window.feedBack.capabilities;
    const events = captureEvents(api, ['chart-transform:transform-failed']);
    await registerProvider(api);
    await api.dispatch({
        capability: 'chart-transform', command: 'select-provider',
        source: 'settings_ui', payload: { providerId: 'chart-retuner' },
    });

    window.feedBack.emit('highway:chart-transform-failed', {
        id: 'chart-retuner',
        reason: 'token=secret https://example.test/private chart={notes:[...]}',
    });

    const snapshot = window.feedBack.chartTransformDomain.snapshot();
    assert.equal(snapshot.lastFailure.providerId, 'chart-retuner');
    assert.equal(snapshot.lastFailure.reason, 'Chart transform provider failed');
    assert.equal(events.length, 1);
    assert.equal(events[0].payload.reason, 'Chart transform provider failed');
});

test('diagnostics contribution carries the schema and no song identity fields', async () => {
    const window = loadChartTransform();
    const api = window.feedBack.capabilities;
    await registerProvider(api);
    const contributions = window.feedBack.diagnostics.snapshotContributions();
    const diag = contributions['chart-transform-capability'];
    assert.ok(diag, 'diagnostics contributed');
    assert.equal(diag.schema, 'feedBack.chart_transform.diagnostics.v1');
    const flat = JSON.stringify(diag);
    assert.ok(!/filename|title|artist|arrangement/.test(flat), 'no song identity in diagnostics');
});
