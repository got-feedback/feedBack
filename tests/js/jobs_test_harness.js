const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createWindow, ROOT } = require('./capabilities_test_harness');

const CAPABILITIES_JS = path.join(ROOT, 'static', 'capabilities.js');
const JOBS_JS = path.join(ROOT, 'static', 'capabilities', 'jobs.js');
const INSPECTOR_JS = path.join(ROOT, 'plugins', 'capability_inspector', 'screen.js');

function loadJobs(options = {}) {
    const window = createWindow(options);
    const context = vm.createContext(window);
    vm.runInContext(fs.readFileSync(CAPABILITIES_JS, 'utf8'), context, { filename: CAPABILITIES_JS });
    vm.runInContext(fs.readFileSync(JOBS_JS, 'utf8'), context, { filename: JOBS_JS });
    window.__vmContext = context;
    return window;
}

function loadInspector(window) {
    vm.runInContext(fs.readFileSync(INSPECTOR_JS, 'utf8'), window.__vmContext, { filename: INSPECTOR_JS });
    return window;
}

function captureEvents(window, capability = 'jobs') {
    const events = [];
    window.slopsmith.on('capability:event', event => {
        if (event.detail && event.detail.capability === capability) events.push(event.detail);
    });
    return events;
}

function diagnosticsSnapshot(window) {
    return window.slopsmith.jobs.snapshot();
}

function diagnosticsContributions(window) {
    return Object.fromEntries(window.__diagnosticsContributions || new Map());
}

function storageEntries(window) {
    return Object.fromEntries(window.__storage || new Map());
}

async function dispatch(window, command, payload = {}, requester = 'test') {
    return window.slopsmith.capabilities.dispatch({ capability: 'jobs', command, args: payload, requester });
}

function makeProvider(overrides = {}) {
    const calls = [];
    const providerId = overrides.providerId || 'provider.jobs';
    const handlers = overrides.operationHandlers || {};
    const provider = {
        providerId,
        pluginId: overrides.pluginId || providerId,
        label: overrides.label || 'Jobs Provider',
        jobTypes: overrides.jobTypes || ['transcode'],
        actions: overrides.actions || ['enqueue', 'inspect', 'cancel', 'pause', 'resume', 'retry', 'recover'],
        availability: overrides.availability || 'available',
        capacity: overrides.capacity || { maxRunning: 1, maxQueued: 10 },
        recoverySupport: overrides.recoverySupport || { queued: true, running: true, paused: true },
        version: overrides.version || 1,
        safeReason: overrides.safeReason,
        operationHandlers: {
            'job.enqueue': request => {
                calls.push(['job.enqueue', request]);
                return handlers['job.enqueue'] ? handlers['job.enqueue'](request) : { outcome: 'handled' };
            },
            'job.cancel': request => {
                calls.push(['job.cancel', request]);
                return handlers['job.cancel'] ? handlers['job.cancel'](request) : { outcome: 'handled' };
            },
            'job.pause': request => {
                calls.push(['job.pause', request]);
                return handlers['job.pause'] ? handlers['job.pause'](request) : { outcome: 'handled' };
            },
            'job.resume': request => {
                calls.push(['job.resume', request]);
                return handlers['job.resume'] ? handlers['job.resume'](request) : { outcome: 'handled' };
            },
            'job.retry': request => {
                calls.push(['job.retry', request]);
                return handlers['job.retry'] ? handlers['job.retry'](request) : { outcome: 'handled' };
            },
            'job.recover': request => {
                calls.push(['job.recover', request]);
                return handlers['job.recover'] ? handlers['job.recover'](request) : { outcome: 'handled', state: overrides.recoveredState || 'queued' };
            },
            ...handlers,
        },
    };
    return { calls, provider };
}

function enqueuePayload(overrides = {}) {
    return {
        jobType: overrides.jobType || 'transcode',
        requester: overrides.requester || 'plugin.requester',
        authorization: overrides.authorization || 'user-action',
        priority: overrides.priority || 'user-approved-interactive',
        target: overrides.target || { targetRef: 'song-1' },
        inputs: overrides.inputs || { safeFingerprint: 'input-1' },
        safeLabel: overrides.safeLabel || 'Build playable cache',
        logicalJobKey: overrides.logicalJobKey,
        providerId: overrides.providerId,
        privileged: overrides.privileged,
        approvalScopeKey: overrides.approvalScopeKey,
    };
}

function installInspectorDom(window) {
    const elements = new Map();
    function element(id) {
        const item = {
            id,
            value: '',
            textContent: '',
            innerHTML: '',
            className: '',
            dataset: {},
            style: {},
            classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
            addEventListener() {},
            removeEventListener() {},
            querySelectorAll() { return []; },
            querySelector() { return null; },
            closest() { return null; },
            getBoundingClientRect() { return { width: 1000, height: 400, left: 0, top: 0 }; },
            appendChild(child) { return child; },
        };
        elements.set(id, item);
        return item;
    }
    element('capability-inspector-filter');
    element('capability-inspector-content');
    element('capability-inspector-empty');
    element('capability-inspector-summary');
    element('capability-inspector-refresh');
    window.document.readyState = 'complete';
    window.document.getElementById = id => elements.get(id) || null;
    window.document.querySelectorAll = () => [];
    window.document.addEventListener = () => {};
    window.document.createElement = () => element(`created-${elements.size}`);
    window.requestAnimationFrame = callback => callback();
    return elements;
}

module.exports = {
    ROOT,
    loadJobs,
    loadInspector,
    captureEvents,
    diagnosticsSnapshot,
    diagnosticsContributions,
    storageEntries,
    dispatch,
    makeProvider,
    enqueuePayload,
    installInspectorDom,
};