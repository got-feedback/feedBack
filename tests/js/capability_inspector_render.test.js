const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..', '..');
const INSPECTOR_JS = path.join(ROOT, 'plugins', 'capability_inspector', 'screen.js');

function makeElement(id) {
    const element = {
        id,
        innerHTML: '',
        textContent: '',
        value: '',
        dataset: {},
        children: [],
        listeners: {},
        classList: {
            values: new Set(),
            add(name) { this.values.add(name); },
            remove(name) { this.values.delete(name); },
            contains(name) { return this.values.has(name); },
        },
        appendChild(child) { this.children.push(child); return child; },
        addEventListener(type, handler) { this.listeners[type] = handler; },
    };
    return element;
}

function loadInspector(snapshot, options = {}) {
    class CustomEvent {
        constructor(type, init = {}) {
            this.type = type;
            this.detail = init.detail;
        }
    }

    const listeners = new Map();
    const elements = new Map([
        ['capability-inspector-filter', makeElement('capability-inspector-filter')],
        ['capability-inspector-content', makeElement('capability-inspector-content')],
        ['capability-inspector-empty', makeElement('capability-inspector-empty')],
        ['capability-inspector-summary', makeElement('capability-inspector-summary')],
        ['capability-inspector-refresh', makeElement('capability-inspector-refresh')],
    ]);
    const window = {
        console,
        CustomEvent,
        setTimeout(callback) { callback(); return 1; },
        clearTimeout() {},
        addEventListener(type, handler) {
            const list = listeners.get(type) || [];
            list.push(handler);
            listeners.set(type, list);
        },
        dispatchEvent(event) {
            for (const handler of (listeners.get(event.type) || []).slice()) handler(event);
            return true;
        },
        slopsmith: {
            capabilities: {
                snapshotDiagnostics: () => (typeof snapshot === 'function' ? snapshot() : snapshot),
            },
            playback: options.playbackSnapshot ? {
                snapshot: () => options.playbackSnapshot,
            } : undefined,
            jobs: options.jobsSnapshot ? {
                snapshot: () => options.jobsSnapshot,
            } : undefined,
        },
        navigator: { clipboard: { writeText: async () => {} } },
        document: {
            readyState: 'complete',
            getElementById(id) { return elements.get(id) || null; },
            createElement(tagName) { return makeElement(tagName); },
            addEventListener() {},
        },
    };
    window.window = window;
    window.globalThis = window;
    window.__listeners = listeners;
    const context = vm.createContext(window);
    vm.runInContext(fs.readFileSync(INSPECTOR_JS, 'utf8'), context, { filename: INSPECTOR_JS });
    return { window, elements };
}

test('capability inspector renders playback session route loop bridges and outcomes', () => {
    const snapshot = {
        pipelines: [{ name: 'playback', review: { lifecycle: 'active', label: 'Active contract', tone: 'clean', summary: 'Core playback facade.' }, participants: [{ pluginId: 'core', roles: ['owner'], commands: ['inspect'], events: ['ready'], runtime: true, availability: 'available' }], conflicts: [] }],
        participants: [{ pluginId: 'core' }],
        compatibilityShims: [],
        expectedCompatibilityShims: [],
    };
    const playbackSnapshot = {
        schema: 'slopsmith.playback.diagnostics.v1',
        state: {
            sessionId: 'playback-1',
            state: 'playing',
            target: { targetId: 'target-abc', localDisplay: { title: 'Song', artist: 'Artist', arrangement: 'Lead' } },
            media: { currentTime: 12.5, duration: 90, route: { routeKind: 'browser-media', state: 'active' }, loop: { enabled: true, startTime: 10, endTime: 20, state: 'active' } },
            route: { routeKind: 'browser-media', state: 'active', safeReason: 'browser media route active' },
            loop: { enabled: true, startTime: 10, endTime: 20, state: 'active' },
        },
        participants: [{ requesterId: 'plugin.practice' }, { observerId: 'plugin.hud' }],
        bridges: [{ bridgeId: 'playback.window-play-song', hitCount: 2 }],
        history: { current: { recentOutcomes: [{ operation: 'seek', status: 'completed' }], lifecycleEvents: [{ event: 'playback:seeked', state: 'playing' }] } },
    };
    const { elements } = loadInspector(snapshot, { playbackSnapshot });
    const content = elements.get('capability-inspector-content').innerHTML;

    assert.match(content, /data-playback-support/);
    assert.match(content, /Session: playback-1/);
    assert.match(content, /Target: Song - Artist/);
    assert.match(content, /Route: browser-media \(active\)/);
    assert.match(content, /playback\.window-play-song:2/);
    assert.match(content, /seek:completed/);
});

test('capability inspector renders jobs support state and active domain graph', () => {
    const snapshot = {
        pipelines: [{ name: 'jobs', review: { lifecycle: 'active', label: 'Active contract', tone: 'clean', summary: 'Jobs control plane.' }, participants: [{ pluginId: 'core.jobs', kind: 'provider-coordinator', roles: ['owner'], commands: ['enqueue', 'list', 'inspect'], operations: ['job.enqueue'], events: ['queued', 'completed'], runtime: true, availability: 'available', ownership: 'multi-provider', safety: 'privileged' }], conflicts: [] }],
        participants: [{ pluginId: 'core.jobs' }],
        compatibilityShims: [],
        expectedCompatibilityShims: [],
    };
    const jobsSnapshot = {
        schema: 'slopsmith.jobs.diagnostics.v1',
        providers: [{ providerId: 'provider.cache', label: 'Cache Builder', availability: 'available', jobTypes: ['cache-build'] }],
        selectedProviders: [{ jobType: 'cache-build', providerId: 'provider.cache', source: 'user-selected' }],
        jobs: {
            active: [{ jobId: 'job-1', safeLabel: 'Build cache', providerId: 'provider.cache', state: 'running', progress: { percent: 42 } }],
            queued: [{ jobId: 'job-2', safeLabel: 'Later cache', providerId: 'provider.cache', priority: 'background-maintenance' }],
            paused: [],
            recentTerminal: [{ jobId: 'job-0', safeLabel: 'Old cache', providerId: 'provider.cache', state: 'completed', terminalOutcome: { status: 'completed' } }],
        },
        outcomes: [{ operation: 'enqueue', status: 'queued' }, { operation: 'complete', status: 'completed' }],
        bridgeHits: [{ bridgeId: 'jobs.legacy-plugin-queue', operation: 'enqueue', diagnosticsOnly: true }],
    };
    const { elements } = loadInspector(snapshot, { jobsSnapshot });
    const content = elements.get('capability-inspector-content').innerHTML;
    const filter = elements.get('capability-inspector-filter').innerHTML;

    assert.match(content, /data-jobs-support/);
    assert.match(content, /Providers: Cache Builder:available:cache-build/);
    assert.match(content, /Selected: cache-build:provider.cache:user-selected/);
    assert.match(content, /Active: Build cache:provider.cache:42%/);
    assert.match(content, /Queued: Later cache:provider.cache:background-maintenance/);
    assert.match(content, /Bridges: jobs.legacy-plugin-queue:enqueue:diagnostics-only/);
    assert.match(content, /Outcomes: enqueue:queued, complete:completed/);
    assert.match(content, /data-domain-graph="jobs"/);
    assert.match(filter, /jobs/);
});

test('capability inspector renders shims inside their capability domain', () => {
    const snapshot = {
        pipelines: [
            { name: 'library', review: { lifecycle: 'active', label: 'Active contract', tone: 'clean', summary: 'Current library surface.' }, participants: [
                { pluginId: 'core', roles: ['owner'], commands: ['list-providers', 'refresh-providers', 'get-current', 'select-provider', 'sync-song', 'inspect'], operations: ['query-page', 'query-artists', 'query-stats', 'tuning-names', 'get-art', 'sync-song'], events: ['providers-refreshed', 'source-changed', 'song-sync-started', 'song-sync-succeeded', 'song-sync-failed'], description: 'Owns the library provider registry and dispatches source selection, browsing, and song sync commands.', runtime: true, availability: 'available', ownership: 'multi-provider', safety: 'safe' },
                { pluginId: 'local', roles: ['provider'], operations: ['query-page', 'query-artists', 'query-stats', 'tuning-names', 'get-art'], events: ['providers-refreshed', 'source-changed'], runtime: true, availability: 'available', ownership: 'multi-provider', safety: 'safe', providerPolicy: { providerId: 'local', kind: 'local', default: true } },
                { pluginId: 'remote_library_client', roles: ['provider'], operations: ['query-page', 'query-artists', 'query-stats', 'tuning-names', 'get-art', 'sync-song'], events: ['providers-refreshed', 'source-changed', 'song-sync-started', 'song-sync-succeeded', 'song-sync-failed'], runtime: true, availability: 'available', ownership: 'multi-provider', safety: 'safe', providerPolicy: { providerId: 'remote:client', kind: 'remote', ownerPluginId: 'remote_library_client' } },
                { pluginId: 'remote_library_server', roles: ['requester', 'observer'], commands: ['list-providers', 'get-current', 'inspect'], events: ['providers-refreshed', 'source-changed'], description: 'Wraps the local library source for direct remote-library clients.', runtime: false, availability: 'available', ownership: 'requester-only', safety: 'safe' },
            ], conflicts: [] },
            { name: 'custom.practice', review: { lifecycle: 'plugin-defined', label: 'Plugin-defined', tone: 'info', summary: 'Plugin-specific practice surface.' }, participants: [{ pluginId: 'practice_hud', roles: ['observer'], commands: [], runtime: true, availability: 'available', ownership: 'observer-only', safety: 'safe' }], conflicts: [] },
            { name: 'backend.routes', review: { lifecycle: 'future-expansion', label: 'Future expansion', tone: 'warning', summary: 'Backend route bridge.' }, participants: [{ pluginId: 'core', roles: ['owner'], commands: ['inspect'], runtime: true, availability: 'available', ownership: 'multi-provider', safety: 'privileged' }], conflicts: [] },
            { name: 'playback', review: { lifecycle: 'active', label: 'Active contract', tone: 'clean', summary: 'Core playback facade.' }, participants: [
                { pluginId: 'core', roles: ['owner', 'provider'], commands: ['play', 'pause', 'seek', 'snapshot'], events: ['song:ready', 'song:seek', 'beats:loaded', 'arrangement:changed'], description: 'Owns player transport commands and lifecycle events.', runtime: true, availability: 'available', ownership: 'exclusive-owner', safety: 'safe' },
                { pluginId: 'plugin_1', roles: ['observer'], commands: [], events: ['song:ready', 'beats:loaded'], runtime: true, availability: 'available', ownership: 'exclusive-owner', safety: 'safe' },
                { pluginId: 'plugin_2', roles: ['requester'], commands: ['play'], events: ['song:ready', 'arrangement:changed'], runtime: true, availability: 'available', ownership: 'exclusive-owner', safety: 'safe' },
                { pluginId: 'plugin_3', roles: ['participant'], commands: ['pause', 'seek'], events: ['song:seek'], runtime: true, availability: 'available', ownership: 'exclusive-owner', safety: 'safe' },
            ], conflicts: [] },
            { name: 'audio-effects', review: { lifecycle: 'active', label: 'Active contract', tone: 'clean', summary: 'Core audio-effects facade.' }, participants: [
                { pluginId: 'core.audio.effects', roles: ['owner'], commands: ['register-provider', 'register-executor', 'resolve-plan', 'load-plan', 'inspect'], events: ['provider-registered', 'executor-registered'], description: 'Owns the provider and executor registry.', runtime: true, availability: 'available', ownership: 'multi-provider', safety: 'sensitive' },
                { pluginId: 'nam-tone', roles: ['provider', 'executor'], operations: ['chain.resolve', 'executor.load-chain-plan'], events: ['plan-resolved'], description: 'Provides NAM fallback plans and browser execution.', runtime: true, availability: 'available', ownership: 'multi-provider', safety: 'sensitive' },
            ], conflicts: [] },
            { name: 'diagnostics', review: { lifecycle: 'diagnostic', label: 'Snapshot surface', tone: 'info', summary: 'Read-only diagnostics snapshot/export facade for support bundles and the Capability Inspector.' }, participants: [
                { pluginId: 'core', roles: ['owner', 'provider'], commands: ['snapshot'], events: [], description: 'Provides read-only capability snapshots for support bundles and the Capability Inspector.', runtime: true, availability: 'available', ownership: 'diagnostic-only', safety: 'diagnostic-only' },
                { pluginId: 'capability_inspector', roles: ['requester'], commands: ['snapshot'], events: [], runtime: true, availability: 'available', ownership: 'diagnostic-only', safety: 'diagnostic-only' },
            ], conflicts: [] },
            { name: 'pipeline', review: { lifecycle: 'diagnostic', label: 'Graph controls', tone: 'info', summary: 'Capability graph operations: resolve, inspect, validate, and enable or disable participants.' }, participants: [
                { pluginId: 'core', roles: ['owner', 'provider'], commands: ['resolve', 'inspect', 'validate', 'participant.set-enabled'], events: ['resolved', 'runtime.validated', 'participant.state-changed'], description: 'Owns capability graph inspection, validation, resolution, and participant enablement commands.', runtime: true, availability: 'available', ownership: 'diagnostic-only', safety: 'diagnostic-only' },
                { pluginId: 'capability_inspector', roles: ['requester', 'observer'], commands: ['inspect', 'validate'], events: ['runtime.validated', 'participant.state-changed'], runtime: true, availability: 'available', ownership: 'diagnostic-only', safety: 'diagnostic-only' },
            ], conflicts: [] },
        ],
        participants: [{ pluginId: 'core' }, { pluginId: 'remote_library_client' }, { pluginId: 'remote_library_server' }],
        compatibilityShims: [
            {
                shimId: 'remote_library_client:register_library_provider:library:remote:client',
                source: 'remote_library_client',
                capability: 'library',
                legacySurface: 'register_library_provider',
                status: 'used',
                hitCount: 3,
                providerId: 'remote:client',
                reason: 'legacy backend register_library_provider() registered provider',
                lastHitAt: '2026-05-24T00:00:00.000Z',
            },
            {
                shimId: 'runtime:library:refresh:window.slopsmith.libraryProviders.refresh',
                source: 'window.slopsmith.libraryProviders.refresh',
                capability: 'library',
                legacySurface: 'refresh',
                status: 'used',
                hitCount: 1,
                reason: 'Legacy library provider refresh invoked',
                lastHitAt: '2026-05-24T00:01:00.000Z',
            },
        ],
        expectedCompatibilityShims: [
            {
                capability: 'library',
                legacySurface: 'register_library_provider',
                reason: 'legacy backend provider registration becomes a library participant',
            },
            {
                capability: 'library',
                legacySurface: 'refresh',
                reason: 'legacy library provider client refresh calls are counted as library.refresh command use',
            },
        ],
    };
    const { window, elements } = loadInspector(snapshot);
    const content = elements.get('capability-inspector-content').innerHTML;
    const summary = elements.get('capability-inspector-summary').innerHTML;
    const filterElement = elements.get('capability-inspector-filter');
    const filter = filterElement.innerHTML;

    assert.match(summary, /Domains/);
    assert.match(summary, /Participants/);
    assert.match(summary, /data-summary-dashboard/);
    assert.match(summary, /<span class="text-\[11px\] uppercase tracking-wide text-gray-500" data-summary-label>Shim hit<\/span>\s*<span class="text-lg font-semibold text-white" data-summary-value>1<\/span>/);
    assert.doesNotMatch(summary, />Shim hits<\/span>\s*<span class="text-lg font-semibold text-white" data-summary-value>4<\/span>/);
    assert.doesNotMatch(summary, /Legacy listeners/);
    assert.match(summary, /data-summary-card="status" data-tone="clean"/);
    assert.match(summary, /<span data-summary-status-value data-tone="clean">Clean<\/span>/);
    assert.match(filter, /<optgroup label="Application and Library">/);
    assert.match(filter, /<optgroup label="Player and Audio Runtime">/);
    assert.match(filter, /<optgroup label="Plugin-defined Domains">/);
    assert.match(filter, /<optgroup label="Capability Runtime">/);
    assert.ok(filter.indexOf('ui.navigation') === -1);
    assert.ok(filter.indexOf('library') < filter.indexOf('playback'));
    assert.ok(filter.indexOf('playback') < filter.indexOf('audio-effects'));
    assert.ok(filter.indexOf('audio-effects') < filter.indexOf('custom.practice'));
    assert.ok(filter.indexOf('playback') < filter.indexOf('custom.practice'));
    assert.ok(filter.indexOf('custom.practice') < filter.indexOf('diagnostics'));
    assert.ok(filter.indexOf('backend.routes') === -1);
    assert.doesNotMatch(content, /Domain group/);
    assert.match(content, /<div class="h-4" aria-hidden="true"><\/div>/);
    assert.doesNotMatch(content, /Capability relationship map/);
    assert.doesNotMatch(content, /data-capability-link=/);
    assert.match(content, /data-domain-graph="library" data-domain-graph-expanded="false"/);
    assert.match(content, /title="library domain" aria-label="library domain" role="img">[\s\S]*?<path d="M12 7v14"/);
    assert.match(content, /<button type="button" data-toggle-domain="library"[^>]*title="Expand library domain graph"[^>]*>[^]*?<span class="min-w-0 break-all font-bold">library<\/span>/);
    assert.doesNotMatch(content, /Domain: <span/);
    assert.match(content, /title="4 participants" aria-label="4 participants" role="img"/);
    assert.doesNotMatch(content, /2 Participants/);
    assert.doesNotMatch(content, /1 Capability/);
    assert.doesNotMatch(content, /Observed links/);
    assert.doesNotMatch(content, /Shimmed link/);
    assert.match(content, /title="Domain status: Clean" aria-label="Domain status: Clean" role="img"/);
    assert.match(content, /Application and Library/);
    assert.match(content, /Player and Audio Runtime/);
    assert.match(content, /Plugin-defined Domains/);
    assert.match(content, /Capability Runtime/);
    assert.match(content, /title="pipeline domain" aria-label="pipeline domain" role="img">[\s\S]*?<path d="M22 12h-4l-3 7L9 5l-3 7H2"/);
    assert.doesNotMatch(content, /title="pipeline domain" aria-label="pipeline domain" role="img">[\s\S]*?<circle cx="6" cy="6" r="3"/);
    assert.ok(content.indexOf('library') < content.indexOf('playback'));
    assert.ok(content.indexOf('playback') < content.indexOf('audio-effects'));
    assert.ok(content.indexOf('audio-effects') < content.indexOf('custom.practice'));
    assert.ok(content.indexOf('playback') < content.indexOf('custom.practice'));
    assert.match(content, /data-domain-graph="audio-effects" data-domain-graph-expanded="false"/);
    assert.ok(content.indexOf('custom.practice') < content.indexOf('diagnostics'));
    assert.doesNotMatch(content, /backend\.routes/);
    assert.doesNotMatch(content, /Review scope/);
    assert.doesNotMatch(content, /Snapshot surface/);
    assert.doesNotMatch(content, /Graph controls/);
    assert.match(content, /library/);
    assert.match(content, /data-toggle-domain="library"/);
    assert.match(content, /title="Expand library domain graph"/);
    assert.match(content, /aria-expanded="false"/);
    assert.doesNotMatch(content, /id="capability-domain-library-graph-frame"/);
    assert.doesNotMatch(content, /Domain summary/);

    window.__slopsmithCapabilityInspector.expandedDomains = { library: true, playback: true, 'custom.practice': true };
    window.__slopsmithCapabilityInspector.render();
    const expandedContent = elements.get('capability-inspector-content').innerHTML;

    assert.match(expandedContent, /aria-expanded="true"/);
    assert.match(expandedContent, /data-domain-graph="library" data-domain-graph-expanded="true"/);
    assert.match(expandedContent, /title="Collapse library domain graph"/);
    assert.match(expandedContent, /data-domain-graph="library"[\s\S]*title="1 shimmed link"/);
    assert.doesNotMatch(expandedContent, /Domain summary/);
    assert.match(expandedContent, /title="Domain status: Clean"/);
    assert.match(expandedContent, /id="capability-domain-library-graph-frame"/);
    assert.match(expandedContent, /id="capability-domain-library-graph-cy"/);
    assert.match(expandedContent, /id="capability-domain-library-graph-fallback"/);
    assert.match(expandedContent, /data-domain-provider-card="true"/);
    assert.doesNotMatch(expandedContent, /Review scope/);
    assert.match(expandedContent, /data-domain-owner-name="core"/);
    assert.match(expandedContent, /data-domain-owner-name="core"[\s\S]*data-origin-icon="core"[^>]*title="Core owner"/);
    assert.match(expandedContent, /data-domain-owner-name="core"[\s\S]*data-origin-icon="core"[^>]*title="Core owner"[\s\S]*<path d="M12 2\.8 21 8\.1v8\.8L12 22l-9-5\.1V8\.1L12 2\.8z"/);
    assert.match(expandedContent, /data-domain-owner-name="core"[\s\S]*data-origin-icon="core"[^>]*title="Core owner"[\s\S]*<circle cx="12" cy="12\.2" r="3\.4"/);
    assert.match(expandedContent, /data-domain-provider-card="true"[\s\S]*data-domain-owner-name="core"[\s\S]*data-graph-provider-group="operation"[\s\S]*data-graph-provider-group="command"[\s\S]*data-graph-provider-group="event"[\s\S]*data-domain-owner-description="core"[\s\S]*Owns the library provider registry and dispatches source selection, browsing, and song sync commands\./);
    assert.match(expandedContent, /data-domain-graph="library"[\s\S]*data-domain-owner-name="core"[\s\S]*<div class="min-w-0 truncate text-lg font-semibold text-white">core<\/div>[\s\S]*<div class="flex shrink-0 items-center justify-end gap-1">[\s\S]*data-role-icon="owner"[^>]*title="Owner"[\s\S]*data-origin-icon="core"[^>]*title="Core owner"[\s\S]*data-role-icon="provider-coordinator"[^>]*title="Provider coordinator"/);
    assert.doesNotMatch(expandedContent, /data-domain-owner-name="local"/);
    assert.doesNotMatch(expandedContent, /data-domain-owner-name="remote_library_client"/);
    assert.match(expandedContent, /data-domain-participant-card="local"/);
    assert.match(expandedContent, /title="Provider: local" aria-label="Provider: local" role="img"/);
    assert.match(expandedContent, /data-domain-participant-card="local"[\s\S]*data-origin-icon="core"[^>]*title="Core provider"/);
    assert.match(expandedContent, /data-domain-participant-card="local"[\s\S]*data-origin-icon="core"[^>]*title="Core provider"[\s\S]*<path d="M12 2\.8 21 8\.1v8\.8L12 22l-9-5\.1V8\.1L12 2\.8z"/);
    assert.match(expandedContent, /data-domain-participant-card="local"[\s\S]*data-origin-icon="core"[^>]*title="Core provider"[\s\S]*<circle cx="12" cy="12\.2" r="3\.4"/);
    assert.match(expandedContent, /data-domain-participant-card="remote_library_client"/);
    assert.match(expandedContent, /data-domain-participant-card="remote_library_client"[^>]*title="Plugin: remote_library_client \| Roles: provider \| Provider: remote:client \| Registration: runtime \| Availability: available \| Safety: safe"/);
    assert.match(expandedContent, /data-domain-participant-card="remote_library_client"[\s\S]*data-origin-icon="non-core"[^>]*title="Non-core provider"/);
    assert.match(expandedContent, /title="Provider: remote:client" aria-label="Provider: remote:client" role="img"/);
    assert.match(expandedContent, /data-domain-participant-card="remote_library_server"[^>]*title="Plugin: remote_library_server \| Roles: requester, observer \| Registration: manifest \| Availability: available \| Safety: safe"/);
    assert.match(expandedContent, /data-domain-participant-card="remote_library_server"[\s\S]*data-origin-icon="non-core"[^>]*title="Non-core participant"/);
    assert.doesNotMatch(expandedContent, /data-domain-participant-card="remote_library_server"[\s\S]*Provider: remote_library_server/);
    assert.match(expandedContent, /data-link-kind="observed"[^>]*>query-page<\/span>/);
    assert.match(expandedContent, /data-link-kind="observed" data-link-flow="provider-operation" data-link-participant="local">query-page<\/span>/);
    assert.match(expandedContent, /data-link-kind="observed" data-link-flow="provider-event" data-link-participant="local">providers-refreshed<\/span>/);
    assert.match(expandedContent, /data-link-kind="observed" data-link-flow="provider-operation" data-link-participant="remote_library_client">sync-song<\/span>/);
    assert.match(expandedContent, /data-link-kind="observed" data-link-flow="provider-event" data-link-participant="remote_library_client">song-sync-succeeded<\/span>/);
    assert.match(expandedContent, /data-link-kind="observed" data-link-flow="command" data-link-participant="remote_library_server">list-providers<\/span>/);
    assert.match(expandedContent, /data-link-kind="observed" data-link-flow="event" data-link-participant="remote_library_server">source-changed<\/span>/);
    assert.doesNotMatch(expandedContent, /data-link-flow="provider-command" data-link-participant="remote_library_server"/);
    assert.doesNotMatch(expandedContent, /data-link-flow="provider-command" data-link-participant="local"/);
    assert.doesNotMatch(expandedContent, /data-link-flow="provider-event" data-link-participant="remote_library_server"/);
    assert.match(expandedContent, /data-domain-participant-card="local"[\s\S]*data-endpoint-icon="operation" data-endpoint-flow="provider-operation" data-graph-participant-port="0:operation:query-page"/);
    assert.match(expandedContent, /data-domain-participant-card="local"[\s\S]*data-endpoint-icon="event" data-endpoint-flow="provider-event" data-graph-participant-port="0:event:providers-refreshed"/);
    assert.ok(expandedContent.indexOf('data-domain-participant-card="remote_library_server"') < expandedContent.indexOf('data-graph-participant-group="2:command"'));
    assert.ok(expandedContent.indexOf('data-graph-provider-group="operation"') < expandedContent.indexOf('data-graph-provider-group="command"'));
    assert.match(expandedContent, /Operation link/);
    assert.match(expandedContent, /Provider operation link/);
    assert.match(expandedContent, /Provider event link/);
    assert.match(expandedContent, /data-link-kind="shimmed"[^>]*>refresh<\/span>/);
    assert.doesNotMatch(expandedContent, /data-link-kind="shimmed"[^>]*>list<\/span>/);
    assert.doesNotMatch(expandedContent, /No command, operation, or event usage declared/);
    assert.doesNotMatch(expandedContent, /data-domain-participant-card="practice_hud"/);
    assert.match(expandedContent, /data-domain-graph="playback" data-domain-graph-expanded="true"/);
    assert.match(expandedContent, /data-domain-participant-card="plugin_3"/);
    assert.doesNotMatch(expandedContent, /Capability usage/);
    assert.doesNotMatch(expandedContent, /Compatibility shims/);
    assert.doesNotMatch(expandedContent, /Expected legacy surfaces/);
    assert.doesNotMatch(expandedContent, /data-copy-surface=/);

    filterElement.value = 'playback';
    window.__slopsmithCapabilityInspector.render();
    const selectedContent = elements.get('capability-inspector-content').innerHTML;

    assert.match(selectedContent, /data-domain-graph="playback"/);
    assert.match(selectedContent, /title="playback domain" aria-label="playback domain" role="img">[\s\S]*?<circle cx="12" cy="12" r="10"/);
    assert.match(selectedContent, /id="capability-domain-playback-graph-cy"/);
    assert.match(selectedContent, /id="capability-domain-playback-graph-fallback"/);
    assert.match(selectedContent, /lg:flex lg:items-stretch lg:justify-between lg:gap-16 xl:gap-24/);
    assert.match(selectedContent, /lg:w-96 lg:max-w-96 lg:flex-none" data-domain-provider-card="true"/);
    assert.match(selectedContent, /lg:w-96 lg:max-w-96 lg:flex-none" data-domain-participant-lane="true"/);
    assert.match(selectedContent, /<h3 class="text-lg font-semibold text-white"><span class="font-bold">playback<\/span><\/h3>/);
    assert.doesNotMatch(selectedContent, /Domain: <span/);
    assert.doesNotMatch(selectedContent, /data-toggle-domain="playback"/);
    assert.match(selectedContent, /title="3 participants" aria-label="3 participants" role="img"/);
    assert.doesNotMatch(selectedContent, /3 Participants/);
    assert.doesNotMatch(selectedContent, /Owner \/ provider/);
    assert.match(selectedContent, /Commands/);
    assert.match(selectedContent, /Events/);
    assert.match(selectedContent, /play/);
    assert.match(selectedContent, /pause/);
    assert.match(selectedContent, /seek/);
    assert.match(selectedContent, /snapshot/);
    assert.match(selectedContent, /song:ready/);
    assert.match(selectedContent, /song:seek/);
    assert.match(selectedContent, /beats:loaded/);
    assert.match(selectedContent, /arrangement:changed/);
    assert.match(selectedContent, /plugin_1/);
    assert.match(selectedContent, /plugin_2/);
    assert.match(selectedContent, /plugin_3/);
    assert.match(selectedContent, /id="capability-domain-playback-graph-frame"/);
    assert.match(selectedContent, /data-graph-lanes="playback"/);
    assert.match(selectedContent, /data-graph-provider-group="command"/);
    assert.match(selectedContent, /data-graph-provider-group="event"/);
    assert.match(selectedContent, /data-graph-provider-group="command" data-graph-group-collapsed="false" data-graph-focus-kind="provider-group" data-graph-focus-type="command"/);
    assert.match(selectedContent, /data-graph-focus-kind="provider-group" data-graph-focus-type="command" data-graph-provider-focus="group"/);
    assert.match(selectedContent, /data-toggle-graph-group="playback\|provider\|all\|command"/);
    assert.match(selectedContent, /data-toggle-graph-group="playback\|provider\|all\|event"/);
    assert.match(selectedContent, /data-graph-capability-port="command:play"/);
    assert.match(selectedContent, /data-graph-capability-port="event:song:ready"/);
    assert.match(selectedContent, /data-graph-focus-kind="provider-endpoint" data-graph-focus-type="command" data-graph-focus-label="play" data-graph-provider-focus="endpoint"/);
    assert.match(selectedContent, /relative flex min-h-5 min-w-0 items-center justify-end pr-0 text-right/);
    assert.doesNotMatch(selectedContent, /data-capability-node="command:play" data-graph-focus-kind/);
    assert.match(selectedContent, /<span class="min-w-0 truncate" data-graph-focus-kind="provider-endpoint" data-graph-focus-type="command" data-graph-focus-label="play" data-graph-provider-focus="endpoint">play<\/span><span class="absolute -right-\[1\.4375rem\] top-1\/2 -translate-y-1\/2" data-graph-focus-kind="provider-endpoint" data-graph-focus-type="command" data-graph-focus-label="play" data-graph-provider-focus="endpoint"><span class="inline-block[^\"]*" data-endpoint-icon="command" data-endpoint-flow="command" data-graph-capability-port="command:play"/);
    assert.match(selectedContent, /<span class="min-w-0 truncate" data-graph-focus-kind="provider-endpoint" data-graph-focus-type="event" data-graph-focus-label="song:ready" data-graph-provider-focus="endpoint">song:ready<\/span><span class="absolute -right-\[1\.4375rem\] top-1\/2 -translate-y-1\/2" data-graph-focus-kind="provider-endpoint" data-graph-focus-type="event" data-graph-focus-label="song:ready" data-graph-provider-focus="endpoint"><span class="inline-block[^\"]*" data-endpoint-icon="event" data-endpoint-flow="event" data-graph-capability-port="event:song:ready"/);
    assert.doesNotMatch(selectedContent, /grid content-center gap-3 px-1/);
    assert.doesNotMatch(selectedContent, /start or resume playback|song is ready to play/);
    assert.match(selectedContent, /data-graph-hover-participant="2"/);
    assert.match(selectedContent, /title="Availability: available" aria-label="Availability: available" role="img"/);
    assert.doesNotMatch(selectedContent, /Review scope/);
    assert.match(selectedContent, /data-domain-owner-name="core"[\s\S]*<div class="min-w-0 truncate text-lg font-semibold text-white">core<\/div>[\s\S]*<div class="flex shrink-0 items-center justify-end gap-1">[\s\S]*data-role-icon="owner"[^>]*title="Owner"[\s\S]*data-origin-icon="core"[^>]*title="Core owner"[\s\S]*data-role-icon="provider"[^>]*title="Capability provider"/);
    assert.match(selectedContent, /data-domain-owner-name="core"[\s\S]*data-origin-icon="core"[^>]*title="Core owner"/);
    assert.match(selectedContent, /data-domain-provider-card="true"[\s\S]*data-domain-owner-name="core"[\s\S]*data-graph-provider-group="command"[\s\S]*data-graph-provider-group="event"[\s\S]*data-domain-owner-description="core"[\s\S]*Owns player transport commands and lifecycle events\./);
    assert.doesNotMatch(selectedContent, /data-domain-participant-card="core"/);
    assert.match(selectedContent, /data-domain-participant-card="plugin_1"[^>]*title="Plugin: plugin_1 \| Roles: observer \| Registration: runtime \| Availability: available \| Safety: safe"/);
    assert.match(selectedContent, /data-domain-participant-card="plugin_1"[\s\S]*data-origin-icon="non-core"[^>]*title="Non-core participant"/);
    assert.match(selectedContent, /data-domain-participant-card="plugin_2"[\s\S]*data-origin-icon="non-core"[^>]*title="Non-core participant"/);
    assert.doesNotMatch(selectedContent, /data-role-icon="observer"/);
    assert.doesNotMatch(selectedContent, /data-role-icon="requester"/);
    assert.match(selectedContent, /data-domain-participant-card="plugin_3"[\s\S]*?<div class="flex items-center gap-3">[\s\S]*?<div class="min-w-0 flex-1 truncate text-lg font-semibold text-white">plugin_3<\/div>[\s\S]*?<div class="flex shrink-0 items-center justify-end gap-1">[\s\S]*?<span class="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded border bg-emerald-500\/10 text-emerald-300 border-emerald-700\/60" title="Availability: available"/);
    assert.doesNotMatch(selectedContent, /title="Availability: available"[^>]*>[\s\S]*?<span>available<\/span><\/span>/);
    assert.match(selectedContent, /data-domain-participant-card="plugin_3"[\s\S]*?<div class="mt-3 grid gap-3 border-t border-gray-800\/70 pt-3">/);
    assert.doesNotMatch(selectedContent, /<span class="bg-purple-500\/15 text-purple-200 border border-purple-500\/30 px-2 py-1 rounded text-xs leading-none">participant<\/span>/);
    assert.match(selectedContent, /data-graph-participant-group="2:command"/);
    assert.match(selectedContent, /data-graph-participant-group="2:event"/);
    assert.match(selectedContent, /data-graph-participant-group="2:event" data-graph-group-collapsed="false" data-graph-focus-kind="participant-group" data-graph-focus-participant-index="2" data-graph-focus-type="event"/);
    assert.match(selectedContent, /data-graph-focus-kind="participant-group" data-graph-focus-participant-index="2" data-graph-focus-type="event"/);
    assert.match(selectedContent, /data-toggle-graph-group="playback\|participant\|2\|event"/);
    assert.match(selectedContent, /data-graph-participant-port="2:event:song:seek"/);
    assert.match(selectedContent, /data-graph-focus-kind="participant-endpoint" data-graph-focus-participant-index="2" data-graph-focus-type="event" data-graph-focus-label="song:seek"/);
    assert.match(selectedContent, /relative flex min-h-5 min-w-0 items-center pl-0 text-sm/);
    assert.doesNotMatch(selectedContent, /relative flex min-h-5 min-w-0 items-center pl-0 text-sm text-gray-300" data-graph-focus-kind/);
    assert.match(selectedContent, /class="absolute -left-\[1\.4375rem\] top-1\/2 -translate-y-1\/2" data-graph-focus-kind="participant-endpoint" data-graph-focus-participant-index="2" data-graph-focus-type="event" data-graph-focus-label="song:seek"><span class="inline-block[^\"]*" data-endpoint-icon="event" data-endpoint-flow="event" data-graph-participant-port="2:event:song:seek"/);
    assert.match(selectedContent, /<span class="min-w-0 truncate" data-graph-focus-kind="participant-endpoint" data-graph-focus-participant-index="2" data-graph-focus-type="event" data-graph-focus-label="song:seek">song:seek<\/span>/);
    assert.match(selectedContent, /data-endpoint-icon="event" data-endpoint-flow="event" data-graph-participant-port="0:event:song:ready"/);
    assert.match(selectedContent, /data-endpoint-icon="event" data-endpoint-flow="event" data-graph-participant-port="2:event:song:seek"/);
    assert.match(selectedContent, /Command link/);
    assert.match(selectedContent, /Event link/);
    assert.match(selectedContent, /data-link-kind="observed"/);
    assert.doesNotMatch(selectedContent, /data-link-kind="shimmed"/);
    assert.doesNotMatch(selectedContent, /<svg class="pointer-events-none absolute inset-0 hidden h-full w-full lg:block"/);
    assert.match(selectedContent, /title="8 observed links" aria-label="8 observed links" role="img"/);
    assert.match(selectedContent, /title="0 shimmed links" aria-label="0 shimmed links" role="img"/);
    assert.match(selectedContent, /Show:/);
    assert.match(selectedContent, /class="flex flex-wrap items-center justify-end gap-2" data-domain-graph-filter-row="playback"/);
    assert.ok(selectedContent.indexOf('data-domain-graph-filter-row="playback"') < selectedContent.indexOf('>Legend</span>'));
    assert.match(selectedContent, /class="flex flex-wrap items-center gap-4 border-t border-gray-800 pt-2"/);
    assert.match(selectedContent, /data-domain-graph-filter="all"/);
    assert.match(selectedContent, />All<\/button>/);
    assert.match(selectedContent, />Operations<\/button>/);
    assert.ok(selectedContent.indexOf('>Operations<\/button>') < selectedContent.indexOf('>Commands<\/button>'));
    assert.ok(selectedContent.indexOf('data-legend-icon="operation"') < selectedContent.indexOf('data-legend-icon="command"'));
    assert.doesNotMatch(selectedContent, /Domain group/);

    window.__slopsmithCapabilityInspector.graphCollapsedGroups = {
        'playback|provider|all|command': true,
        'playback|participant|2|event': true,
    };
    window.__slopsmithCapabilityInspector.render();
    const collapsedGroupContent = elements.get('capability-inspector-content').innerHTML;
    assert.match(collapsedGroupContent, /data-graph-group-collapsed="true"/);
    assert.match(collapsedGroupContent, /data-graph-capability-port="group:command"/);
    assert.doesNotMatch(collapsedGroupContent, /data-graph-capability-port="command:play"/);
    assert.match(collapsedGroupContent, /data-graph-participant-port="2:group:event"/);
    assert.doesNotMatch(collapsedGroupContent, /data-graph-participant-port="2:event:song:seek"/);
    const collapsedParticipantButton = collapsedGroupContent.match(/<button type="button" data-toggle-graph-group="playback\|participant\|2\|event"[\s\S]*?<\/button>/)[0];
    assert.match(collapsedParticipantButton, /<span class="min-w-0 truncate">Events<\/span>/);
    assert.doesNotMatch(collapsedParticipantButton, /<svg class="h-3\.5 w-3\.5/);
    assert.doesNotMatch(collapsedParticipantButton, /<path d="m9 6 6 6-6 6"\/>/);

    window.__slopsmithCapabilityInspector.graphCollapsedGroups = {};
    window.__slopsmithCapabilityInspector.render();

    filterElement.value = 'library';
    window.__slopsmithCapabilityInspector.domainGraphFilter = 'operations';
    window.__slopsmithCapabilityInspector.render();
    const operationsOnlyContent = elements.get('capability-inspector-content').innerHTML;
    assert.match(operationsOnlyContent, /aria-pressed="true" class="rounded border px-2 py-1 transition bg-purple-500\/40 text-white border-purple-400\/40">Operations/);
    assert.match(operationsOnlyContent, /data-capability-node="operation:query-page"/);
    assert.match(operationsOnlyContent, /data-link-kind="observed" data-link-flow="provider-operation" data-link-participant="local">query-page<\/span>/);
    assert.doesNotMatch(operationsOnlyContent, /data-capability-node="command:list-providers"/);
    assert.doesNotMatch(operationsOnlyContent, /data-capability-node="event:providers-refreshed"/);

    filterElement.value = 'playback';
    window.__slopsmithCapabilityInspector.domainGraphFilter = 'events';
    window.__slopsmithCapabilityInspector.render();
    const eventsOnlyContent = elements.get('capability-inspector-content').innerHTML;
    assert.match(eventsOnlyContent, /aria-pressed="true" class="rounded border px-2 py-1 transition bg-purple-500\/40 text-white border-purple-400\/40">Events/);
    assert.match(eventsOnlyContent, /data-capability-node="event:song:ready"/);
    assert.doesNotMatch(eventsOnlyContent, /data-capability-node="command:play"/);

    filterElement.value = 'library';
    window.__slopsmithCapabilityInspector.domainGraphFilter = 'shimmed';
    window.__slopsmithCapabilityInspector.render();
    const shimmedOnlyContent = elements.get('capability-inspector-content').innerHTML;
    assert.match(shimmedOnlyContent, /data-link-kind="shimmed"/);
    assert.doesNotMatch(shimmedOnlyContent, /data-link-kind="observed"/);
    assert.match(shimmedOnlyContent, /title="4 participants" aria-label="4 participants" role="img"/);

    filterElement.value = '';
    window.__slopsmithCapabilityInspector.expandedDomains = {};
    window.__slopsmithCapabilityInspector.domainGraphFilter = 'all';
    window.__slopsmithCapabilityInspector.render();
    const collapsedFilteredContent = elements.get('capability-inspector-content').innerHTML;
    assert.match(collapsedFilteredContent, /data-domain-graph="playback" data-domain-graph-expanded="false"[\s\S]*?title="3 participants" aria-label="3 participants" role="img"/);
});

test('capability inspector drops stale future-domain filter options', () => {
    const snapshot = {
        pipelines: [
            { name: 'library', review: { lifecycle: 'active', label: 'Active contract', tone: 'clean', summary: 'Library surface.' }, participants: [], conflicts: [] },
            { name: 'ui.player-panels', review: { lifecycle: 'future-expansion', label: 'Future expansion', tone: 'warning', summary: 'Stale future domain.' }, participants: [], conflicts: [] },
        ],
        participants: [],
        compatibilityShims: [],
        expectedCompatibilityShims: [],
    };
    const { window, elements } = loadInspector(snapshot);
    const filter = elements.get('capability-inspector-filter');

    filter.innerHTML += '<option value="ui.player-panels">ui.player-panels</option>';
    filter.value = 'ui.player-panels';
    window.__slopsmithCapabilityInspector.render();

    assert.equal(filter.value, '');
    assert.doesNotMatch(filter.innerHTML, /ui\.player-panels/);
    assert.match(elements.get('capability-inspector-content').innerHTML, /library/);
    assert.doesNotMatch(elements.get('capability-inspector-content').innerHTML, /ui\.player-panels/);
});

test('capability inspector refreshes collapsed counts after runtime capability changes', () => {
    let currentSnapshot = {
        pipelines: [
            { name: 'library', review: { lifecycle: 'active', label: 'Active contract', tone: 'clean', summary: 'Library surface.' }, participants: [
                { pluginId: 'core', roles: ['owner'], commands: ['refresh', 'select'], events: [], runtime: true, availability: 'available', ownership: 'multi-provider', safety: 'safe' },
            ], conflicts: [] },
        ],
        participants: [{ pluginId: 'core' }],
        compatibilityShims: [],
        expectedCompatibilityShims: [],
    };
    const { window, elements } = loadInspector(() => currentSnapshot);
    assert.match(elements.get('capability-inspector-content').innerHTML, /data-domain-graph="library" data-domain-graph-expanded="false"[\s\S]*?title="0 participants"/);

    currentSnapshot = {
        ...currentSnapshot,
        participants: [{ pluginId: 'core' }, { pluginId: 'window.slopsmith.libraryProviders.refresh' }, { pluginId: 'remote_library_client' }],
        compatibilityShims: [
            { shimId: 'runtime:library:refresh:window.slopsmith.libraryProviders.refresh', source: 'window.slopsmith.libraryProviders.refresh', capability: 'library', legacySurface: 'refresh', status: 'used', hitCount: 1 },
            { shimId: 'runtime:library:select:remote_library_client', source: 'remote_library_client', capability: 'library', legacySurface: 'select', status: 'used', hitCount: 1 },
        ],
        expectedCompatibilityShims: [
            { capability: 'library', legacySurface: 'refresh', reason: 'legacy library provider client refresh calls are counted as library.refresh command use' },
            { capability: 'library', legacySurface: 'select', reason: 'legacy library provider selector calls are counted as library.select command use' },
        ],
    };
    window.dispatchEvent(new window.CustomEvent('slopsmith:capabilities:changed'));

    const refreshedContent = elements.get('capability-inspector-content').innerHTML;
    assert.match(refreshedContent, /data-domain-graph="library" data-domain-graph-expanded="false"[\s\S]*?title="2 participants"/);
    assert.match(refreshedContent, /title="2 shimmed links"/);
});

test('capability inspector links library legacy command surfaces to canonical endpoints', () => {
    const snapshot = {
        pipelines: [
            { name: 'library', review: { lifecycle: 'active', label: 'Active contract', tone: 'clean', summary: 'Library surface.' }, participants: [
                { pluginId: 'core', roles: ['owner'], commands: ['list', 'refresh', 'select', 'sync-song'], events: [], runtime: true, availability: 'available', ownership: 'multi-provider', safety: 'safe' },
            ], conflicts: [] },
        ],
        participants: [{ pluginId: 'core' }],
        compatibilityShims: [
            { shimId: 'runtime:library:refresh:window.slopsmith.libraryProviders.refresh', source: 'window.slopsmith.libraryProviders.refresh', capability: 'library', legacySurface: 'refresh', status: 'used', hitCount: 1 },
            { shimId: 'runtime:library:select:remote_library_client', source: 'remote_library_client', capability: 'library', legacySurface: 'select', status: 'used', hitCount: 1 },
            { shimId: 'runtime:library:sync-song:remote_library_client', source: 'remote_library_client', capability: 'library', legacySurface: 'sync-song', status: 'used', hitCount: 1 },
        ],
        expectedCompatibilityShims: [
            { capability: 'library', legacySurface: 'refresh', reason: 'legacy library provider client refresh calls are counted as library.refresh command use' },
            { capability: 'library', legacySurface: 'select', reason: 'legacy library provider selector calls are counted as library.select command use' },
            { capability: 'library', legacySurface: 'sync-song', reason: 'legacy library provider sync calls are counted as library.sync-song command use' },
        ],
    };
    const { window, elements } = loadInspector(snapshot);
    const filter = elements.get('capability-inspector-filter');

    filter.value = 'library';
    window.__slopsmithCapabilityInspector.render();
    const libraryContent = elements.get('capability-inspector-content').innerHTML;
    assert.match(libraryContent, /data-domain-participant-card="window\.slopsmith\.libraryProviders\.refresh"/);
    assert.match(libraryContent, /data-domain-participant-card="remote_library_client"/);
    assert.match(libraryContent, /data-link-kind="shimmed"[^>]*>refresh<\/span>/);
    assert.match(libraryContent, /data-link-kind="shimmed"[^>]*>select<\/span>/);
    assert.match(libraryContent, /data-link-kind="shimmed"[^>]*>sync-song<\/span>/);
    assert.match(libraryContent, /title="2 participants"/);
});

test('capability inspector clears provider hover without a graph hover target', () => {
    const snapshot = {
        pipelines: [
            { name: 'library', review: { lifecycle: 'active', label: 'Active contract', tone: 'clean', summary: 'Library surface.' }, participants: [
                { pluginId: 'core', roles: ['owner'], commands: [], events: ['providers-refreshed'], runtime: true, availability: 'available', ownership: 'multi-provider', safety: 'safe' },
            ], conflicts: [] },
        ],
        participants: [{ pluginId: 'core' }],
        compatibilityShims: [],
        expectedCompatibilityShims: [],
    };
    const { elements, window } = loadInspector(snapshot);
    const focusElement = { dataset: { graphFocusKind: 'provider-group', graphFocusType: 'event' }, contains: () => false };
    focusElement.closest = selector => selector.includes('data-graph-focus-kind') ? focusElement : null;
    const target = { dataset: { graphProviderFocus: 'group' }, style: {} };
    window.document.querySelectorAll = selector => selector === '[data-domain-graph-frame]'
        ? [{ querySelectorAll: frameSelector => (frameSelector === '[data-graph-provider-focus]' ? [target] : []) }]
        : [];

    assert.doesNotThrow(() => {
        elements.get('capability-inspector-content').listeners.mouseout({ target: focusElement, relatedTarget: null });
    });
});

test('selected domain participant count includes shim-only graph participants', () => {
    const snapshot = {
        pipelines: [
            { name: 'library', review: { lifecycle: 'active', label: 'Active contract', tone: 'clean', summary: 'Library surface.' }, participants: [
                { pluginId: 'core', roles: ['owner'], commands: ['refresh', 'select'], events: [], runtime: true, availability: 'available', ownership: 'multi-provider', safety: 'safe' },
            ], conflicts: [] },
        ],
        participants: [{ pluginId: 'core' }],
        compatibilityShims: [
            { shimId: 'runtime:library:refresh:window.slopsmith.libraryProviders.refresh', source: 'window.slopsmith.libraryProviders.refresh', capability: 'library', legacySurface: 'refresh', status: 'used', hitCount: 1 },
            { shimId: 'runtime:library:select:remote_library_client', source: 'remote_library_client', capability: 'library', legacySurface: 'select', status: 'used', hitCount: 1 },
        ],
        expectedCompatibilityShims: [],
    };
    const { window, elements } = loadInspector(snapshot);
    const filter = elements.get('capability-inspector-filter');
    filter.value = 'library';
    window.__slopsmithCapabilityInspector.render();
    const selectedContent = elements.get('capability-inspector-content').innerHTML;

    assert.match(selectedContent, /title="2 participants"/);
    assert.doesNotMatch(selectedContent, /2 Participants/);
    assert.match(selectedContent, /data-domain-participant-card="window\.slopsmith\.libraryProviders\.refresh"/);
    assert.match(selectedContent, /data-domain-participant-card="remote_library_client"/);
});

test('capability inspector renders audio-mix fader diagnostics from audio-session snapshot', () => {
    const snapshot = {
        pipelines: [
            { name: 'audio-mix', review: { lifecycle: 'active', label: 'Active contract', tone: 'clean', summary: 'Audio mix surface.' }, participants: [
                { pluginId: 'core.audio.session', roles: ['owner'], commands: ['list-faders', 'set-fader-value'], operations: ['fader.get-value', 'fader.set-value'], events: ['fader-value-changed', 'fader-unavailable'], runtime: true, availability: 'available', ownership: 'multi-provider', safety: 'safe' },
            ], conflicts: [] },
        ],
        participants: [{ pluginId: 'core.audio.session' }],
        compatibilityShims: [],
        expectedCompatibilityShims: [],
    };
    const { window, elements } = loadInspector(snapshot);
    window.slopsmith.audioSession = {
        snapshot: () => ({
            schema: 'slopsmith.audio_session.diagnostics.v1',
            session: { route: { routeKind: 'desktop', availability: 'degraded' }, analyser: { source: 'plugin', availability: 'available' } },
            domains: {
                'audio-mix': {
                    participants: [{ participantId: 'plugin.delay', label: 'Delay', sourceMode: 'native' }],
                    faders: [
                        { participantId: 'plugin.delay', label: 'Delay Wet', faderId: 'wet', availability: 'available', sourceMode: 'native' },
                        { participantId: 'fader.legacy', label: 'Legacy Gain', faderId: 'gain', availability: 'disabled', sourceMode: 'compatibility', lastRejectedValue: 0.8 },
                    ],
                    route: { routeKind: 'desktop', availability: 'degraded' },
                    analyser: { source: 'plugin', availability: 'available' },
                    bridges: [{ bridgeId: 'audio-mix.fader-registry', outcome: 'overridden', reason: 'overshadowed', hitCount: 1 }],
                },
                'audio-input': { sources: [], totalSources: 0 },
                'audio-monitoring': { sessions: [], totalSessions: 0 },
                stems: { owner: null, claims: [], bridges: [] },
            },
            recentOutcomes: [{ domain: 'audio-mix', operation: 'set-fader-value', participantId: 'fader.legacy', faderId: 'gain', outcome: 'failed', status: 'timeout' }],
        }),
    };

    window.__slopsmithCapabilityInspector.render();
    const content = elements.get('capability-inspector-content').innerHTML;

    assert.match(content, /data-audio-session-support/);
    assert.match(content, /Faders: Delay Wet:available:native, Legacy Gain:disabled:compatibility:failed/);
    assert.match(content, /Analyser: plugin \(available\)/);
    assert.match(content, /audio-mix\.fader-registry:overridden \(overshadowed\)/);
    assert.match(content, /Failures: audio-mix:set-fader-value:gain:timeout/);
});

test('capability inspector renders audio-input sources selection sessions bridges and failures', () => {
    const snapshot = {
        pipelines: [
            { name: 'audio-input', review: { lifecycle: 'active', label: 'Active contract', tone: 'clean', summary: 'Audio input surface.' }, participants: [
                { pluginId: 'core.audio.session', roles: ['owner'], commands: ['list-sources', 'open-source', 'close-source'], operations: ['source.enumerate', 'source.open', 'source.close'], events: ['source-opened', 'source-closed'], runtime: true, availability: 'available', ownership: 'multi-provider', safety: 'sensitive' },
            ], conflicts: [] },
        ],
        participants: [{ pluginId: 'core.audio.session' }],
        compatibilityShims: [],
        expectedCompatibilityShims: [],
    };
    const { window, elements } = loadInspector(snapshot);
    window.slopsmith.audioSession = {
        snapshot: () => ({
            schema: 'slopsmith.audio_session.diagnostics.v1',
            session: { route: { routeKind: 'html5', availability: 'available' }, analyser: { source: 'none', availability: 'unavailable' } },
            domains: {
                'audio-mix': { participants: [], faders: [], route: { routeKind: 'html5', availability: 'available' }, analyser: { source: 'none', availability: 'unavailable' }, bridges: [] },
                'audio-input': {
                    sources: [
                        { sourceId: 'source-01', logicalSourceKey: 'native:instrument:primary', providerId: 'native', label: 'Input 1', availability: 'available', sourceMode: 'native', channelSummary: { channelShape: 'mono' } },
                        { sourceId: 'source-02', logicalSourceKey: 'legacy:instrument:primary', providerId: 'legacy', label: 'Legacy Input', availability: 'available', sourceMode: 'compatibility', channelSummary: { channelShape: 'stereo' }, supersededBy: 'source-01' },
                    ],
                    selected: { logicalSourceKey: 'native:instrument:primary', availability: 'available', restoreStatus: 'available' },
                    openSessions: [{ openSessionId: 'input-open-01', channelShape: 'mono', state: 'open', requesters: [{ requesterId: 'note_detect' }] }],
                    totalSources: 2,
                    totalOpenSessions: 1,
                    bridges: [{ bridgeId: 'audio-input.legacy-source', status: 'overshadowed', outcome: 'overridden', hitCount: 1 }],
                },
                'audio-monitoring': { sessions: [], totalSessions: 0 },
                stems: { owner: null, claims: [], bridges: [] },
            },
            recentOutcomes: [{ domain: 'audio-input', operation: 'open-source', sourceId: 'source-03', outcome: 'denied', status: 'denied' }],
        }),
    };

    window.__slopsmithCapabilityInspector.render();
    const content = elements.get('capability-inspector-content').innerHTML;

    assert.match(content, /Input: Input 1:available:mono:native, Legacy Input:available:stereo:compatibility:superseded/);
    assert.match(content, /Selected input: native:instrument:primary:available:available/);
    assert.match(content, /Open input: input-open-01:mono:open:note_detect/);
    assert.match(content, /Input bridges: audio-input\.legacy-source:overshadowed/);
    assert.match(content, /Failures: audio-input:open-source:source-03:denied/);
});

test('capability inspector renders audio-monitoring providers sessions direct monitor bridges and failures', () => {
    const snapshot = {
        pipelines: [
            { name: 'audio-monitoring', review: { lifecycle: 'active', label: 'Active contract', tone: 'clean', summary: 'Audio monitoring surface.' }, participants: [
                { pluginId: 'core.audio.session', roles: ['owner'], commands: ['list-providers', 'select-provider', 'start', 'stop', 'set-direct-monitor'], operations: ['monitoring.start', 'monitoring.stop', 'monitoring.status'], events: ['monitoring-started', 'direct-monitor-changed'], runtime: true, availability: 'available', ownership: 'multi-provider', safety: 'sensitive' },
            ], conflicts: [] },
        ],
        participants: [{ pluginId: 'core.audio.session' }],
        compatibilityShims: [],
        expectedCompatibilityShims: [],
    };
    const { window, elements } = loadInspector(snapshot);
    window.slopsmith.audioSession = {
        snapshot: () => ({
            schema: 'slopsmith.audio_session.diagnostics.v1',
            session: { route: { routeKind: 'desktop', availability: 'available' }, analyser: { source: 'plugin', availability: 'available' } },
            domains: {
                'audio-mix': { participants: [], faders: [], route: { routeKind: 'desktop', availability: 'available' }, analyser: { source: 'plugin', availability: 'available' }, bridges: [] },
                'audio-input': { sources: [], totalSources: 0, openSessions: [], totalOpenSessions: 0, bridges: [] },
                'audio-monitoring': {
                    providers: [
                        { providerId: 'native_monitor', logicalMonitoringKey: 'native:monitor:main', label: 'Native Monitor', availability: 'available', sourceMode: 'native' },
                        { providerId: 'legacy_monitor', logicalMonitoringKey: 'native:monitor:main', label: 'Legacy Monitor', availability: 'available', sourceMode: 'compatibility', supersededBy: 'native_monitor' },
                    ],
                    selectedProvider: { providerId: 'native_monitor', logicalMonitoringKey: 'native:monitor:main', availability: 'available' },
                    sessions: [
                        { monitoringId: 'monitoring-01', state: 'active', sourceRef: { logicalSourceKey: 'native:instrument:primary' }, requesters: [{ requesterId: 'user' }, { requesterId: 'note_detect' }], directMonitor: { preference: 'muted', control: 'supported', applied: true } },
                        { monitoringId: 'monitoring-02', state: 'failed', sourceRef: { logicalSourceKey: 'native:instrument:primary' }, requesters: [{ requesterId: 'practice_overlay' }], directMonitor: { preference: 'unmuted', control: 'unsupported', applied: false } },
                    ],
                    totalProviders: 2,
                    totalSessions: 2,
                    directMonitor: { preference: 'muted', control: 'supported', applied: true },
                    bridges: [{ bridgeId: 'audio-monitoring.audio-barrier', status: 'overshadowed', outcome: 'overridden', hitCount: 2 }],
                },
                stems: { owner: null, claims: [], bridges: [] },
            },
            recentOutcomes: [
                { domain: 'audio-monitoring', operation: 'start', monitoringId: 'monitoring-02', requesterId: 'practice_overlay', outcome: 'failed', status: 'timeout' },
                { domain: 'audio-monitoring', operation: 'start', requesterId: 'note_detect', outcome: 'provider-selection-required', status: 'provider-selection-required' },
            ],
        }),
    };

    window.__slopsmithCapabilityInspector.render();
    const content = elements.get('capability-inspector-content').innerHTML;

    assert.match(content, /Monitoring providers: Native Monitor:available:native, Legacy Monitor:available:compatibility:superseded/);
    assert.match(content, /Selected monitoring: native:monitor:main:available:native_monitor/);
    assert.match(content, /Monitoring: monitoring-01:active:user\+note_detect:native:instrument:primary, monitoring-02:failed:practice_overlay:native:instrument:primary/);
    assert.match(content, /Direct monitor: muted:supported:applied/);
    assert.match(content, /Monitoring bridges: audio-monitoring\.audio-barrier:overshadowed/);
    assert.match(content, /Failures: audio-monitoring:start:monitoring-02:timeout, audio-monitoring:start:note_detect:provider-selection-required/);
});
