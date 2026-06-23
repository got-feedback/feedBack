const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loadAudioEffects, diagnosticsSnapshot } = require('./audio_effects_test_harness');

function registerProvider(api, overrides = {}) {
    return api.dispatch({
        capability: 'audio-effects',
        command: 'register-provider',
        source: 'test',
        payload: {
            providerId: overrides.providerId || 'rig-builder',
            pluginId: overrides.pluginId || 'rig_builder',
            routeKey: overrides.routeKey || 'desktop-main',
            priority: overrides.priority == null ? 40 : overrides.priority,
            operations: overrides.operations || ['chain.resolve', 'segment.activate', 'stage.set-bypass', 'stage.set-parameter'],
            requests: overrides.requests || [],
            operationHandlers: overrides.operationHandlers || {
                'chain.resolve': () => ({
                    outcome: 'handled',
                    plan: {
                        schema: 'feedBack.audio_effects.chain_plan.v1',
                        planId: 'plan-1',
                        routeKey: 'desktop-main',
                        providerId: overrides.providerId || 'rig-builder',
                        stages: [
                            { stageId: 'pre-1', kind: 'nam', role: 'pre-pedal', assetRef: 'provider:nam:pre', bypassed: false },
                            { stageId: 'amp-1', kind: 'nam', role: 'amp', assetRef: 'provider:nam:amp', bypassed: false },
                            { stageId: 'cab-1', kind: 'ir', role: 'cab', assetRef: 'provider:ir:cab', bypassed: false },
                        ],
                        segments: [{ segmentId: 'ToneA', stageIds: ['pre-1', 'amp-1', 'cab-1'], stageBypass: { 'pre-1': true, 'amp-1': false } }],
                        summary: { stageCount: 3, kinds: ['nam', 'ir'], assetRefs: ['provider:nam:amp'] },
                    },
                    summary: { stageCount: 3, categoryCount: 3, assetRefs: ['provider:nam:amp'] },
                }),
                'segment.activate': () => ({ outcome: 'handled', summary: { active: true } }),
                'stage.set-bypass': () => ({ outcome: 'handled', summary: { bypassed: true } }),
                'stage.set-parameter': () => ({ outcome: 'handled', summary: { changed: true } }),
            },
        },
    });
}

test('audio-effects host registers active domain and contributes diagnostics', () => {
    const window = loadAudioEffects();
    const api = window.feedBack.capabilities;
    const pipeline = api.inspect('audio-effects');
    const diagnostics = window.feedBack.diagnostics.snapshotContributions();

    assert.equal(pipeline.review.lifecycle, 'active');
    assert.equal(pipeline.participants.some(p => p.pluginId === 'core.audio.effects' && p.roles.includes('owner')), true);
    assert.equal(diagnostics['audio-effects'].schema, 'feedBack.audio_effects.diagnostics.v1');
});

test('audio-effects runtime providers and executors are capability participants', async () => {
    const window = loadAudioEffects();
    const api = window.feedBack.capabilities;

    await registerProvider(api, {
        providerId: 'nam-tone',
        pluginId: 'nam-tone',
        routeKey: 'live-guitar',
        operations: ['chain.resolve', 'chain.inspect', 'stage.set-bypass'],
        requests: ['list-mappings', 'upsert-mapping'],
    });
    const executor = await api.dispatch({
        capability: 'audio-effects',
        command: 'register-executor',
        source: 'test',
        payload: {
            executorId: 'nam-tone-browser-wasm',
            pluginId: 'nam-tone',
            routeKey: 'live-guitar',
            providerIds: ['nam-tone'],
            supportedKinds: ['nam', 'ir'],
            operations: ['loadChainPlan'],
        },
    });
    const pipeline = api.inspect('audio-effects');
    const participant = pipeline.participants.find(item => item.pluginId === 'nam-tone');

    assert.equal(executor.outcome, 'handled');
    assert.ok(participant);
    assert.deepEqual([...participant.roles].sort(), ['executor', 'provider', 'requester']);
    assert.equal(participant.runtime, true);
    assert.equal(participant.safety, 'sensitive');
    assert.equal(participant.ownership, 'multi-provider');
    assert.deepEqual(Array.from(participant.requests), ['list-mappings', 'upsert-mapping']);
    assert.equal(participant.operations.includes('chain.resolve'), true);
    assert.equal(participant.operations.includes('executor.load-chain-plan'), true);
});

test('unregistering a provider drops its role/operations and clearing all removes the participant', async () => {
    const window = loadAudioEffects();
    const api = window.feedBack.capabilities;

    await registerProvider(api, {
        providerId: 'nam-tone',
        pluginId: 'nam-tone',
        routeKey: 'live-guitar',
        operations: ['chain.resolve', 'chain.inspect', 'stage.set-bypass'],
        requests: ['list-mappings'],
    });
    await api.dispatch({
        capability: 'audio-effects',
        command: 'register-executor',
        source: 'test',
        payload: {
            executorId: 'nam-tone-browser-wasm',
            pluginId: 'nam-tone',
            routeKey: 'live-guitar',
            providerIds: ['nam-tone'],
            supportedKinds: ['nam', 'ir'],
            operations: ['loadChainPlan'],
        },
    });

    // Unregister only the provider; the executor for the same plugin remains.
    await api.dispatch({
        capability: 'audio-effects',
        command: 'unregister-provider',
        source: 'test',
        payload: { providerId: 'nam-tone', pluginId: 'nam-tone' },
    });

    const afterProvider = api.inspect('audio-effects').participants.find(item => item.pluginId === 'nam-tone');
    assert.ok(afterProvider, 'participant should survive while the executor is still registered');
    // The merge-only registry would otherwise keep the stale provider role/operations/requests.
    assert.deepEqual([...afterProvider.roles].sort(), ['executor']);
    assert.equal(afterProvider.operations.includes('chain.resolve'), false);
    assert.equal(afterProvider.operations.includes('chain.inspect'), false);
    assert.equal(afterProvider.operations.includes('executor.load-chain-plan'), true);
    assert.deepEqual(Array.from(afterProvider.requests), []);

    // Removing the last executor must remove the participant entirely.
    await api.dispatch({
        capability: 'audio-effects',
        command: 'unregister-executor',
        source: 'test',
        payload: { executorId: 'nam-tone-browser-wasm', pluginId: 'nam-tone' },
    });
    const afterAll = api.inspect('audio-effects').participants.find(item => item.pluginId === 'nam-tone');
    assert.equal(afterAll, undefined, 'participant should be removed once no providers or executors remain');
});

test('host runtime overlay preserves a plugin-declared audio-effects manifest entry', async () => {
    const window = loadAudioEffects();
    const api = window.feedBack.capabilities;

    // The plugin declares its own audio-effects participancy in its manifest before any runtime
    // registration goes through the host.
    api.registerParticipant('rig_builder', {
        'audio-effects': {
            roles: ['observer'],
            operations: ['chain.inspect'],
            description: 'Manifest-declared audio-effects observer.',
        },
    });

    await registerProvider(api, { providerId: 'rig-builder', pluginId: 'rig_builder', routeKey: 'desktop-main' });

    const withProvider = api.inspect('audio-effects').participants.find(item => item.pluginId === 'rig_builder');
    assert.ok(withProvider);
    // Manifest role/operation survive alongside the host-added provider overlay.
    assert.equal(withProvider.roles.includes('observer'), true, 'manifest role must survive host sync');
    assert.equal(withProvider.roles.includes('provider'), true);
    assert.equal(withProvider.operations.includes('chain.inspect'), true);

    // Unregistering the runtime provider must leave the manifest declaration intact, not wipe it.
    await api.dispatch({
        capability: 'audio-effects',
        command: 'unregister-provider',
        source: 'test',
        payload: { providerId: 'rig-builder', pluginId: 'rig_builder' },
    });
    const afterProvider = api.inspect('audio-effects').participants.find(item => item.pluginId === 'rig_builder');
    assert.ok(afterProvider, 'manifest-declared participant must remain after the host overlay is removed');
    assert.deepEqual([...afterProvider.roles].sort(), ['observer']);
    assert.equal(afterProvider.operations.includes('chain.inspect'), true);
    assert.equal(afterProvider.roles.includes('provider'), false, 'stale host role must be cleared');
});

test('select-chain requires user action and records selected provider', async () => {
    const window = loadAudioEffects();
    const api = window.feedBack.capabilities;
    await registerProvider(api);

    const denied = await api.dispatch({ capability: 'audio-effects', command: 'select-chain', source: 'test', payload: { routeKey: 'desktop-main' } });
    const selected = await api.dispatch({ capability: 'audio-effects', command: 'select-chain', source: 'test', payload: { routeKey: 'desktop-main', authorization: 'user-action', requesterId: 'spoofed-plugin' } });
    const route = await api.dispatch({ capability: 'audio-effects', command: 'inspect-route', source: 'test', payload: { routeKey: 'desktop-main' } });

    assert.equal(denied.outcome, 'user-action-required');
    assert.equal(selected.outcome, 'handled');
    assert.equal(selected.payload.route.providerId, 'rig-builder');
    assert.equal(route.payload.route.state, 'selected');
    assert.equal(JSON.stringify(diagnosticsSnapshot(window)).includes('spoofed-plugin'), false);
});

test('resolve-plan calls selected provider and returns constrained plan without storing raw payload in diagnostics', async () => {
    const window = loadAudioEffects();
    const api = window.feedBack.capabilities;
    await registerProvider(api);
    await api.dispatch({ capability: 'audio-effects', command: 'select-chain', source: 'test', payload: { routeKey: 'desktop-main', authorization: 'user-action' } });

    const resolved = await api.dispatch({ capability: 'audio-effects', command: 'resolve-plan', source: 'nam_tone', payload: { routeKey: 'desktop-main', target: { settingsKey: 'settings-v1-abc1234' } } });
    const snapshot = diagnosticsSnapshot(window);
    const encoded = JSON.stringify(snapshot);

    assert.equal(resolved.outcome, 'handled');
    assert.equal(resolved.payload.plan.schema, 'feedBack.audio_effects.chain_plan.v1');
    assert.equal(resolved.payload.plan.stages.length, 3);
    assert.deepEqual(JSON.parse(JSON.stringify(resolved.payload.plan.segments[0].stageBypass)), { 'pre-1': true, 'amp-1': false });
    assert.equal(snapshot.routes[0].state, 'resolved');
    assert.equal(snapshot.routes[0].activePlanId, 'plan-1');
    assert.equal(encoded.includes('provider:nam:amp'), false);
    assert.equal(encoded.includes('assetRef'), false);
    assert.equal(encoded.includes('categoryCount'), false);
});

test('resolve-plan rejects raw file paths and records fallback state', async () => {
    const window = loadAudioEffects();
    const api = window.feedBack.capabilities;
    await registerProvider(api, {
        operationHandlers: {
            'chain.resolve': () => ({
                outcome: 'handled',
                plan: {
                    schema: 'feedBack.audio_effects.chain_plan.v1',
                    planId: 'bad-plan',
                    routeKey: 'desktop-main',
                    providerId: 'rig-builder',
                    stages: [{ stageId: 'amp', kind: 'nam', role: 'amp', assetRef: '/Users/example/private/amp.nam' }],
                },
            }),
        },
    });

    const resolved = await api.dispatch({ capability: 'audio-effects', command: 'resolve-plan', source: 'nam_tone', payload: { routeKey: 'desktop-main' } });
    const route = await api.dispatch({ capability: 'audio-effects', command: 'inspect-route', source: 'test', payload: { routeKey: 'desktop-main' } });
    const encoded = JSON.stringify(diagnosticsSnapshot(window));

    assert.equal(resolved.outcome, 'failed');
    assert.match(resolved.reason, /invalid/i);
    assert.equal(route.payload.route.state, 'fallback');
    assert.equal(encoded.includes('/Users/example'), false);
    assert.equal(encoded.includes('amp.nam'), false);
});

test('load-plan calls trusted executor with provider-private assets without diagnostic leakage', async () => {
    const window = loadAudioEffects();
    const api = window.feedBack.capabilities;
    let executorRequest = null;
    window.feedBackDesktop = {
        audioEffects: {
            loadChainPlan(request) {
                executorRequest = request;
                return { outcome: 'handled', status: 'loaded', payload: { slotsLoaded: 1 } };
            },
        },
    };
    await registerProvider(api, {
        operationHandlers: {
            'chain.resolve': () => ({
                outcome: 'handled',
                plan: {
                    schema: 'feedBack.audio_effects.chain_plan.v1',
                    planId: 'private-plan',
                    routeKey: 'desktop-main',
                    providerId: 'rig-builder',
                    stages: [{ stageId: 'amp', kind: 'nam', role: 'amp', assetRef: 'provider:asset:amp' }],
                },
                assets: {
                    'provider:asset:amp': { kind: 'nam', path: '/Users/example/private/amp.nam', stateBase64: 'secret-state' },
                },
                summary: { stageCount: 1 },
            }),
        },
    });

    const loaded = await api.dispatch({
        capability: 'audio-effects',
        command: 'load-plan',
        source: 'nam_tone',
        payload: {
            routeKey: 'desktop-main',
            authorization: 'playback-session',
            target: { presetRef: 'safe-ref' },
            options: { preloadMute: { targetGain: 4, holdMs: 25 }, gains: { input: 8, chain: 4 }, startAudio: true },
        },
    });
    const snapshot = diagnosticsSnapshot(window);
    const encoded = JSON.stringify(snapshot);

    assert.equal(loaded.outcome, 'handled');
    assert.equal(executorRequest.authorization, 'playback-session');
    assert.equal(executorRequest.plan.planId, 'private-plan');
    assert.equal(executorRequest.assets['provider:asset:amp'].path, '/Users/example/private/amp.nam');
    assert.deepEqual(JSON.parse(JSON.stringify(executorRequest.options)), { preloadMute: { enabled: true, dryDuringLoad: true, targetGain: 4, holdMs: 25 }, gains: { input: 8, chain: 4 }, startAudio: true });
    assert.equal(snapshot.routes[0].state, 'loaded');
    assert.equal(encoded.includes('/Users/example'), false);
    assert.equal(encoded.includes('secret-state'), false);
    assert.equal(encoded.includes('provider:asset:amp'), false);
});

test('route gain and release delegate to the selected executor', async () => {
    const window = loadAudioEffects();
    const api = window.feedBack.capabilities;
    const calls = [];
    window.feedBackDesktop = {
        audioEffects: {
            loadChainPlan() { calls.push(['load']); return { outcome: 'handled', status: 'loaded', payload: { slotsLoaded: 1 } }; },
            setRouteGain(request) { calls.push(['gain', request.gains]); return { outcome: 'handled', payload: { gains: request.gains } }; },
            releaseRoute(request) { calls.push(['release', request.routeKey]); return { outcome: 'handled', payload: { released: true } }; },
        },
    };
    await registerProvider(api);
    const loaded = await api.dispatch({ capability: 'audio-effects', command: 'load-plan', source: 'test', payload: { routeKey: 'desktop-main', authorization: 'playback-session' } });
    const gained = await window.feedBack.audioEffects.setRouteGain({ routeKey: 'desktop-main', authorization: 'playback-session', gains: { input: 3, chain: 2 } });
    const released = await window.feedBack.audioEffects.releaseRoute({ routeKey: 'desktop-main', authorization: 'playback-session' });
    const inspected = await window.feedBack.audioEffects.inspectRoute({ routeKey: 'desktop-main' });

    assert.equal(loaded.outcome, 'handled');
    assert.equal(gained.outcome, 'handled');
    assert.equal(released.outcome, 'handled');
    assert.equal(inspected.payload.route, null);
    assert.deepEqual(JSON.parse(JSON.stringify(calls)), [['load'], ['gain', { input: 3, chain: 2 }], ['release', 'desktop-main']]);
});

test('provider unregister clears route plan and executor state', async () => {
    const window = loadAudioEffects();
    const api = window.feedBack.capabilities;
    window.feedBackDesktop = {
        audioEffects: {
            loadChainPlan() { return { outcome: 'handled', status: 'loaded', payload: { slotsLoaded: 1 } }; },
        },
    };
    await registerProvider(api);
    const loaded = await api.dispatch({
        capability: 'audio-effects',
        command: 'load-plan',
        source: 'nam_tone',
        payload: { routeKey: 'desktop-main', authorization: 'playback-session' },
    });
    assert.equal(loaded.outcome, 'handled');

    const unregistered = await api.dispatch({
        capability: 'audio-effects',
        command: 'unregister-provider',
        source: 'rig_builder',
        payload: { pluginId: 'rig_builder', providerId: 'rig-builder' },
    });
    const route = await api.dispatch({ capability: 'audio-effects', command: 'inspect-route', source: 'test', payload: { routeKey: 'desktop-main' } });

    assert.equal(unregistered.outcome, 'handled');
    assert.equal(route.payload.route.state, 'provider-unavailable');
    assert.equal(route.payload.route.activePlanId, '');
    assert.equal(route.payload.route.activeSegmentId, '');
    assert.equal(route.payload.route.executorId, '');
    assert.equal(JSON.stringify(route.payload.route.planSummary), '{}');
});

test('registry caps still allow provider and executor refreshes', async () => {
    const window = loadAudioEffects();
    const api = window.feedBack.capabilities;
    for (let i = 0; i < 50; i++) {
        const result = await registerProvider(api, { providerId: `provider-${i}`, pluginId: `plugin-${i}` });
        assert.equal(result.outcome, 'handled');
    }
    const newProvider = await registerProvider(api, { providerId: 'provider-overflow', pluginId: 'plugin-overflow' });
    const refreshedProvider = await registerProvider(api, { providerId: 'provider-0', pluginId: 'plugin-0', priority: 99 });
    assert.equal(newProvider.outcome, 'failed');
    assert.equal(refreshedProvider.outcome, 'handled');
    assert.equal(refreshedProvider.payload.provider.priority, 99);

    for (let i = 0; i < 20; i++) {
        const result = await api.dispatch({
            capability: 'audio-effects',
            command: 'register-executor',
            source: 'test',
            payload: { executorId: `executor-${i}`, pluginId: `executor-plugin-${i}`, routeKey: 'desktop-main', supportedKinds: ['nam'] },
        });
        assert.equal(result.outcome, 'handled');
    }
    const newExecutor = await api.dispatch({
        capability: 'audio-effects',
        command: 'register-executor',
        source: 'test',
        payload: { executorId: 'executor-overflow', pluginId: 'executor-plugin-overflow', routeKey: 'desktop-main' },
    });
    const refreshedExecutor = await api.dispatch({
        capability: 'audio-effects',
        command: 'register-executor',
        source: 'test',
        payload: { executorId: 'executor-0', pluginId: 'executor-plugin-0', routeKey: 'desktop-main', priority: 77, supportedKinds: ['ir'] },
    });
    assert.equal(newExecutor.outcome, 'failed');
    assert.equal(refreshedExecutor.outcome, 'handled');
    assert.equal(refreshedExecutor.payload.executor.priority, 77);
    assert.equal(JSON.stringify(refreshedExecutor.payload.executor.supportedKinds), '["ir"]');
});

test('route restore preserves loaded state when an executor remains active', async () => {
    const window = loadAudioEffects();
    const api = window.feedBack.capabilities;
    window.feedBackDesktop = {
        audioEffects: {
            loadChainPlan() { return { outcome: 'handled', status: 'loaded', payload: { slotsLoaded: 1 } }; },
        },
    };
    await registerProvider(api);
    const loaded = await api.dispatch({ capability: 'audio-effects', command: 'load-plan', source: 'nam_tone', payload: { routeKey: 'desktop-main', authorization: 'playback-session' } });
    const bypassed = await api.dispatch({ capability: 'audio-effects', command: 'bypass', source: 'test', payload: { routeKey: 'desktop-main', authorization: 'user-action' } });
    const restored = await api.dispatch({ capability: 'audio-effects', command: 'restore', source: 'test', payload: { routeKey: 'desktop-main', authorization: 'user-action' } });

    assert.equal(loaded.payload.route.state, 'loaded');
    assert.equal(bypassed.payload.route.state, 'bypassed');
    assert.equal(restored.payload.route.state, 'loaded');
    assert.equal(restored.payload.route.executorId, loaded.payload.route.executorId);
});

test('load-plan uses a registered compatible executor when Desktop is unavailable', async () => {
    const window = loadAudioEffects();
    const api = window.feedBack.capabilities;
    let executorRequest = null;
    await registerProvider(api, {
        providerId: 'nam-tone',
        pluginId: 'nam_tone',
        operationHandlers: {
            'chain.resolve': request => ({
                outcome: 'handled',
                plan: {
                    schema: 'feedBack.audio_effects.chain_plan.v1',
                    planId: 'browser-plan',
                    routeKey: request.routeKey,
                    providerId: 'nam-tone',
                    stages: [{ stageId: 'amp', kind: 'nam', role: 'amp', assetRef: 'provider:asset:browser-amp' }],
                },
                assets: {
                    'provider:asset:browser-amp': { kind: 'nam', browserFile: 'clean.json', path: '/Users/example/private/clean.nam' },
                },
                summary: { stageCount: 1 },
            }),
        },
    });
    await api.dispatch({
        capability: 'audio-effects',
        command: 'register-executor',
        source: 'nam_tone',
        payload: {
            executorId: 'nam-tone-browser-wasm',
            pluginId: 'nam_tone',
            routeKey: 'desktop-main',
            sourceMode: 'browser',
            providerIds: ['nam-tone'],
            operations: ['loadChainPlan'],
            loadChainPlan(request) {
                executorRequest = request;
                return { outcome: 'handled', status: 'loaded', payload: { engineMode: 'wasm', slotsLoaded: 1 } };
            },
        },
    });

    const loaded = await api.dispatch({
        capability: 'audio-effects',
        command: 'load-plan',
        source: 'nam_tone',
        payload: { routeKey: 'desktop-main', authorization: 'playback-session', target: { presetId: 42 } },
    });
    const snapshot = diagnosticsSnapshot(window);
    const encoded = JSON.stringify(snapshot);

    assert.equal(loaded.outcome, 'handled');
    assert.equal(loaded.payload.executor.executorId, 'nam-tone-browser-wasm');
    assert.equal(executorRequest.target.presetId, 42);
    assert.equal(executorRequest.assets['provider:asset:browser-amp'].browserFile, 'clean.json');
    assert.equal(snapshot.routes[0].state, 'loaded');
    assert.equal(snapshot.routes[0].executorId, 'nam-tone-browser-wasm');
    assert.equal(snapshot.executors.some(executor => executor.executorId === 'nam-tone-browser-wasm' && executor.sourceMode === 'browser'), true);
    assert.equal(encoded.includes('/Users/example'), false);
    assert.equal(encoded.includes('clean.nam'), false);
    assert.equal(encoded.includes('provider:asset:browser-amp'), false);
});

test('load-plan redacts circular executor payloads without overflowing', async () => {
    const window = loadAudioEffects();
    const api = window.feedBack.capabilities;
    const circular = { loaded: true };
    circular.self = circular;
    await registerProvider(api);
    await api.dispatch({
        capability: 'audio-effects',
        command: 'register-executor',
        source: 'test',
        payload: {
            executorId: 'cycle-executor',
            pluginId: 'cycle_executor',
            routeKey: 'desktop-main',
            providerIds: ['rig-builder'],
            operations: ['loadChainPlan'],
            loadChainPlan() {
                return { outcome: 'handled', status: 'loaded', payload: circular };
            },
        },
    });

    const loaded = await api.dispatch({
        capability: 'audio-effects',
        command: 'load-plan',
        source: 'test',
        payload: { routeKey: 'desktop-main', executorId: 'cycle-executor', authorization: 'playback-session' },
    });

    assert.equal(loaded.outcome, 'handled');
    assert.equal(loaded.payload.result.self, '[circular]');
    assert.doesNotThrow(() => diagnosticsSnapshot(window));
});

test('load-plan does not use an executor registered for a different provider', async () => {
    const window = loadAudioEffects();
    const api = window.feedBack.capabilities;
    await registerProvider(api, {
        providerId: 'rig-builder',
        pluginId: 'rig_builder',
        operationHandlers: {
            'chain.resolve': () => ({
                outcome: 'handled',
                plan: {
                    schema: 'feedBack.audio_effects.chain_plan.v1',
                    planId: 'rig-plan',
                    routeKey: 'desktop-main',
                    providerId: 'rig-builder',
                    stages: [{ stageId: 'amp', kind: 'nam', role: 'amp', assetRef: 'provider:asset:rig-amp' }],
                },
                assets: { 'provider:asset:rig-amp': { kind: 'nam', path: '/Users/example/private/rig.nam' } },
            }),
        },
    });
    await api.dispatch({
        capability: 'audio-effects',
        command: 'register-executor',
        source: 'nam_tone',
        payload: {
            executorId: 'nam-tone-browser-wasm',
            pluginId: 'nam_tone',
            providerIds: ['nam-tone'],
            loadChainPlan() { return { outcome: 'handled' }; },
        },
    });

    const loaded = await api.dispatch({
        capability: 'audio-effects',
        command: 'load-plan',
        source: 'rig_builder',
        payload: { routeKey: 'desktop-main', providerId: 'rig-builder', authorization: 'playback-session' },
    });
    const encoded = JSON.stringify(diagnosticsSnapshot(window));

    assert.equal(loaded.outcome, 'unavailable');
    assert.match(loaded.reason, /No compatible/);
    assert.equal(encoded.includes('/Users/example'), false);
    assert.equal(encoded.includes('rig.nam'), false);
});

test('load-plan rejects executors that cannot support the resolved stage kinds', async () => {
    const window = loadAudioEffects();
    const api = window.feedBack.capabilities;
    let called = false;
    await registerProvider(api, {
        providerId: 'rig-builder',
        pluginId: 'rig_builder',
        operationHandlers: {
            'chain.resolve': () => ({
                outcome: 'handled',
                plan: {
                    schema: 'feedBack.audio_effects.chain_plan.v1',
                    planId: 'rig-vst-plan',
                    routeKey: 'desktop-main',
                    providerId: 'rig-builder',
                    stages: [{ stageId: 'drive', kind: 'vst', role: 'pre-pedal', assetRef: 'provider:asset:drive' }],
                },
                assets: { 'provider:asset:drive': { kind: 'vst', path: '/Users/example/private/drive.vst3' } },
            }),
        },
    });
    await api.dispatch({
        capability: 'audio-effects',
        command: 'register-executor',
        source: 'nam_tone',
        payload: {
            executorId: 'nam-only-test',
            pluginId: 'nam_tone',
            providerIds: ['rig-builder'],
            supportedKinds: ['nam', 'ir'],
            loadChainPlan() { called = true; return { outcome: 'handled' }; },
        },
    });

    const loaded = await api.dispatch({
        capability: 'audio-effects',
        command: 'load-plan',
        source: 'rig_builder',
        payload: { routeKey: 'desktop-main', providerId: 'rig-builder', authorization: 'playback-session' },
    });
    const encoded = JSON.stringify(diagnosticsSnapshot(window));

    assert.equal(loaded.outcome, 'unavailable');
    assert.match(loaded.payload.reason, /vst/);
    assert.equal(called, false);
    assert.equal(encoded.includes('/Users/example'), false);
    assert.equal(encoded.includes('drive.vst3'), false);
});

test('load-plan can fall back to a compatible provider executor when the selected provider has none', async () => {
    const window = loadAudioEffects();
    const api = window.feedBack.capabilities;
    let loadedProviderId = '';
    await registerProvider(api, {
        providerId: 'rig-builder',
        pluginId: 'rig_builder',
        priority: 40,
        operationHandlers: {
            'chain.resolve': () => ({
                outcome: 'handled',
                plan: {
                    schema: 'feedBack.audio_effects.chain_plan.v1',
                    planId: 'rig-plan',
                    routeKey: 'desktop-main',
                    providerId: 'rig-builder',
                    stages: [{ stageId: 'amp', kind: 'nam', role: 'amp', assetRef: 'provider:asset:rig-amp' }],
                },
            }),
        },
    });
    await registerProvider(api, {
        providerId: 'nam-tone',
        pluginId: 'nam_tone',
        priority: 10,
        operationHandlers: {
            'chain.resolve': () => ({
                outcome: 'handled',
                plan: {
                    schema: 'feedBack.audio_effects.chain_plan.v1',
                    planId: 'nam-plan',
                    routeKey: 'desktop-main',
                    providerId: 'nam-tone',
                    stages: [{ stageId: 'amp', kind: 'nam', role: 'amp', assetRef: 'provider:asset:nam-amp' }],
                },
                assets: { 'provider:asset:nam-amp': { kind: 'nam', browserFile: 'fallback.json' } },
            }),
        },
    });
    await api.dispatch({
        capability: 'audio-effects',
        command: 'register-executor',
        source: 'nam_tone',
        payload: {
            executorId: 'nam-tone-browser-wasm',
            pluginId: 'nam_tone',
            providerIds: ['nam-tone'],
            loadChainPlan(request) {
                loadedProviderId = request.plan.providerId;
                return { outcome: 'handled', payload: { slotsLoaded: 1 } };
            },
        },
    });

    const loaded = await api.dispatch({
        capability: 'audio-effects',
        command: 'load-plan',
        source: 'nam_tone',
        payload: { routeKey: 'desktop-main', authorization: 'playback-session', fallbackProviderId: 'nam-tone' },
    });

    assert.equal(loaded.outcome, 'handled');
    assert.equal(loaded.payload.route.providerId, 'nam-tone');
    assert.equal(loaded.payload.executor.executorId, 'nam-tone-browser-wasm');
    assert.equal(loadedProviderId, 'nam-tone');
});

test('load-plan can fall back from a selected provider when its executor cannot load the plan', async () => {
    const window = loadAudioEffects();
    const api = window.feedBack.capabilities;
    let loadedProviderId = '';
    await registerProvider(api, {
        providerId: 'rig-builder',
        pluginId: 'rig_builder',
        priority: 40,
        operationHandlers: {
            'chain.resolve': () => ({
                outcome: 'handled',
                plan: {
                    schema: 'feedBack.audio_effects.chain_plan.v1',
                    planId: 'rig-vst-plan',
                    routeKey: 'desktop-main',
                    providerId: 'rig-builder',
                    stages: [{ stageId: 'drive', kind: 'vst', role: 'pre-pedal', assetRef: 'provider:asset:drive' }],
                },
            }),
        },
    });
    await registerProvider(api, {
        providerId: 'nam-tone',
        pluginId: 'nam_tone',
        priority: 10,
        operationHandlers: {
            'chain.resolve': () => ({
                outcome: 'handled',
                plan: {
                    schema: 'feedBack.audio_effects.chain_plan.v1',
                    planId: 'nam-plan',
                    routeKey: 'desktop-main',
                    providerId: 'nam-tone',
                    stages: [{ stageId: 'amp', kind: 'nam', role: 'amp', assetRef: 'provider:asset:nam-amp' }],
                },
                assets: { 'provider:asset:nam-amp': { kind: 'nam', browserFile: 'fallback.json' } },
            }),
        },
    });
    await api.dispatch({
        capability: 'audio-effects',
        command: 'register-executor',
        source: 'nam_tone',
        payload: {
            executorId: 'rig-nam-only',
            pluginId: 'nam_tone',
            providerIds: ['rig-builder'],
            supportedKinds: ['nam', 'ir'],
            loadChainPlan() { throw new Error('should not load VST rig plan'); },
        },
    });
    await api.dispatch({
        capability: 'audio-effects',
        command: 'register-executor',
        source: 'nam_tone',
        payload: {
            executorId: 'nam-tone-browser-wasm',
            pluginId: 'nam_tone',
            providerIds: ['nam-tone'],
            supportedKinds: ['nam', 'ir'],
            loadChainPlan(request) {
                loadedProviderId = request.plan.providerId;
                return { outcome: 'handled', payload: { slotsLoaded: 1 } };
            },
        },
    });
    await api.dispatch({ capability: 'audio-effects', command: 'select-chain', source: 'user', payload: { routeKey: 'desktop-main', providerId: 'rig-builder', authorization: 'user-action' } });

    const loaded = await api.dispatch({
        capability: 'audio-effects',
        command: 'load-plan',
        source: 'playback',
        payload: { routeKey: 'desktop-main', authorization: 'playback-session', fallbackProviderId: 'nam-tone' },
    });

    assert.equal(loaded.outcome, 'handled');
    assert.equal(loaded.payload.route.providerId, 'nam-tone');
    assert.equal(loaded.payload.executor.executorId, 'nam-tone-browser-wasm');
    assert.equal(loadedProviderId, 'nam-tone');
});

test('provider operations route stage and segment changes through selected provider', async () => {
    const window = loadAudioEffects();
    const api = window.feedBack.capabilities;
    const calls = [];
    await registerProvider(api, {
        operationHandlers: {
            'chain.resolve': () => ({
                outcome: 'handled',
                plan: {
                    schema: 'feedBack.audio_effects.chain_plan.v1',
                    planId: 'switch-plan',
                    routeKey: 'desktop-main',
                    providerId: 'rig-builder',
                    stages: [{ stageId: 'amp', kind: 'nam', role: 'amp', assetRef: 'provider:nam:amp' }],
                    segments: [{ segmentId: 'dist', stageIds: ['amp'] }],
                },
            }),
            'segment.activate': request => { calls.push(['segment.activate', request.segmentId]); return { outcome: 'handled' }; },
            'stage.set-bypass': request => { calls.push(['stage.set-bypass', request.stageId, request.bypassed]); return { outcome: 'handled' }; },
            'stage.set-parameter': request => { calls.push(['stage.set-parameter', request.stageId, request.parameterId]); return { outcome: 'handled' }; },
        },
    });
    await api.dispatch({ capability: 'audio-effects', command: 'resolve-plan', source: 'nam_tone', payload: { routeKey: 'desktop-main' } });

    const segment = await api.dispatch({ capability: 'audio-effects', command: 'activate-segment', source: 'playback', payload: { routeKey: 'desktop-main', segmentId: 'dist' } });
    const bypass = await api.dispatch({ capability: 'audio-effects', command: 'set-stage-bypass', source: 'rig_builder', payload: { routeKey: 'desktop-main', stageId: 'amp', bypassed: true } });
    const parameter = await api.dispatch({ capability: 'audio-effects', command: 'set-stage-parameter', source: 'rig_builder', payload: { routeKey: 'desktop-main', stageId: 'amp', parameterId: 'gain', value: 0.7 } });

    assert.equal(segment.outcome, 'handled');
    assert.equal(bypass.outcome, 'handled');
    assert.equal(parameter.outcome, 'handled');
    assert.deepEqual(calls, [['segment.activate', 'dist'], ['stage.set-bypass', 'amp', true], ['stage.set-parameter', 'amp', 'gain']]);
});

test('mapping helpers call core mapping API with provider-tagged payloads', async () => {
    const window = loadAudioEffects();
    const api = window.feedBack.capabilities;
    const calls = [];
    window.fetch = async (url, options = {}) => {
        calls.push({ url: String(url), options });
        return {
            ok: true,
            status: 200,
            async json() {
                if (String(url).includes('/activate')) {
                    return { ok: true, mapping: { id: 7, provider_id: 'rig-builder', active: true } };
                }
                if ((options.method || 'GET') === 'DELETE') {
                    return { ok: true, cleared: true };
                }
                if ((options.method || 'GET') === 'POST') {
                    return { ok: true, mapping: { id: 7, song_key: 'settings-v1-song', tone_key: 'Dist', provider_id: 'rig-builder', provider_ref: 'chain:99', active: true } };
                }
                return { mappings: [{ id: 7, song_key: 'settings-v1-song', tone_key: 'Dist', provider_id: 'rig-builder', provider_ref: 'chain:99', active: true }] };
            },
        };
    };

    const saved = await window.feedBack.audioEffects.upsertMapping({
        song_key: 'settings-v1-song',
        filename: 'Artist - Song_p.archive',
        tone_key: 'Dist',
        provider_id: 'rig-builder',
        provider_ref: 'chain:99',
        active: true,
    });
    const listed = await api.dispatch({
        capability: 'audio-effects',
        command: 'list-mappings',
        source: 'rig_builder',
        payload: { song_key: 'settings-v1-song', provider_id: 'rig-builder' },
    });
    const activated = await window.feedBack.audioEffects.activateMapping({ mappingId: 7, providerId: 'rig-builder' });
    const cleared = await window.feedBack.audioEffects.clearActiveMapping({ songKey: 'settings-v1-song', toneKey: 'Dist' });

    assert.equal(saved.outcome, 'handled');
    assert.equal(saved.payload.mapping.provider_ref, 'chain:99');
    assert.equal(listed.outcome, 'handled');
    assert.equal(listed.payload.mappings[0].provider_id, 'rig-builder');
    assert.equal(activated.payload.mapping.active, true);
    assert.equal(cleared.payload.cleared, true);
    assert.equal(calls[0].url, '/api/audio-effects/mappings');
    assert.equal(JSON.parse(calls[0].options.body).provider_id, 'rig-builder');
    assert.match(calls[1].url, /song_key=settings-v1-song/);
    assert.match(calls[1].url, /provider_id=rig-builder/);
    assert.equal(calls[2].url, '/api/audio-effects/mappings/7/activate');
    assert.match(calls[3].url, /\/api\/audio-effects\/active-mapping\?/);
});

test('mapping helpers forward present falsey fields to the server instead of swallowing them', async () => {
    const window = loadAudioEffects();
    const calls = [];
    window.fetch = async (url, options = {}) => {
        calls.push({ url: String(url), options });
        return { ok: true, status: 200, async json() { return { ok: true }; } };
    };

    // A falsey non-string provider_id must reach the server (which rejects it) rather than being
    // coerced to '' client-side, which would become a silent unscoped activate.
    await window.feedBack.audioEffects.activateMapping({ mappingId: 7, providerId: false });
    assert.equal(JSON.parse(calls[0].options.body).provider_id, false);

    // A present falsey query filter is forwarded (stringified) rather than dropped.
    await window.feedBack.audioEffects.listMappings({ provider_id: 0 });
    assert.match(calls[1].url, /provider_id=0/);

    // An omitted filter stays omitted (no spurious empty filter).
    await window.feedBack.audioEffects.listMappings({});
    assert.equal(calls[2].url, '/api/audio-effects/mappings');
});

test('bridge hits are safe and diagnosable', async () => {
    const window = loadAudioEffects();
    const api = window.feedBack.capabilities;

    const result = await api.dispatch({
        capability: 'audio-effects',
        command: 'record-bridge-hit',
        source: 'rig_builder',
        payload: {
            routeKey: 'desktop-main',
            bridgeId: 'audio-effects.legacy-nam-routing',
            pluginId: 'rig_builder',
            legacySurface: 'fetch /Users/example/song.archive token=abc123',
        },
    });
    const dbResult = await api.dispatch({
        capability: 'audio-effects',
        command: 'record-bridge-hit',
        source: 'nam_tone',
        payload: {
            routeKey: 'desktop-main',
            bridgeId: 'audio-effects.legacy-tone-db',
            pluginId: 'nam_tone',
            legacySurface: 'nam_tone.db tone_mappings /Users/example/nam_tone.db',
        },
    });
    const nativeResult = await api.dispatch({
        capability: 'audio-effects',
        command: 'record-bridge-hit',
        source: 'nam_tone',
        payload: {
            routeKey: 'desktop-main',
            bridgeId: 'audio-effects.legacy-native-load',
            pluginId: 'nam_tone',
            legacySurface: 'window.feedBackDesktop.audio.loadPreset /Users/example/model.nam',
        },
    });
    const encoded = JSON.stringify(diagnosticsSnapshot(window));

    assert.equal(result.outcome, 'handled');
    assert.equal(dbResult.outcome, 'handled');
    assert.equal(nativeResult.outcome, 'handled');
    const sharedShim = window.feedBack.capabilities.snapshotDiagnostics().compatibilityShims.find(entry => entry.shimId === 'audio-effects.legacy-nam-routing');
    assert.equal(sharedShim.status, 'used');
    assert.equal(sharedShim.hitCount >= 1, true);
    assert.equal(encoded.includes('audio-effects.legacy-nam-routing'), true);
    assert.equal(encoded.includes('audio-effects.legacy-tone-db'), true);
    assert.equal(encoded.includes('audio-effects.legacy-native-load'), true);
    assert.equal(encoded.includes('/Users/example'), false);
    assert.equal(encoded.includes('token=abc123'), false);
});
