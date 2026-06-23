const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createWindow, ROOT } = require('./capabilities_test_harness');

const CAPABILITIES_JS = path.join(ROOT, 'static', 'capabilities.js');
const AUDIO_SESSION_JS = path.join(ROOT, 'static', 'capabilities', 'audio-session.js');
const AUDIO_MIXER_JS = path.join(ROOT, 'static', 'audio-mixer.js');

function loadAudioSession(options = {}) {
    const window = createWindow(options);
    const context = vm.createContext(window);
    vm.runInContext(fs.readFileSync(CAPABILITIES_JS, 'utf8'), context, { filename: CAPABILITIES_JS });
    vm.runInContext(fs.readFileSync(AUDIO_SESSION_JS, 'utf8'), context, { filename: AUDIO_SESSION_JS });
    window.__vmContext = context;
    return window;
}

function runBrowserScript(window, relativePath) {
    const filePath = path.join(ROOT, relativePath);
    vm.runInContext(fs.readFileSync(filePath, 'utf8'), window.__vmContext, { filename: filePath });
}

function captureEvents(window, eventName) {
    const events = [];
    window.feedBack.on(eventName, event => events.push(event.detail));
    return events;
}

function diagnosticsSnapshot(window) {
    return window.feedBack.audioSession.snapshot();
}

function storageEntries(window) {
    return Object.fromEntries(window.__storage || new Map());
}

function makeInputProvider(overrides = {}) {
    const calls = [];
    const sources = overrides.sources || [];
    return {
        calls,
        source: {
            sourceId: overrides.sourceId || 'provider-source-1',
            logicalSourceKey: overrides.logicalSourceKey || 'provider:input:primary',
            providerId: overrides.providerId || 'provider',
            ownerPluginId: overrides.ownerPluginId || overrides.providerId || 'provider',
            kind: overrides.kind || 'instrument',
            safeLabel: overrides.safeLabel || 'Input 1',
            availability: overrides.availability || 'available',
            channelSummary: overrides.channelSummary || { channelCount: 2, channelShape: 'stereo', supports: ['mono', 'stereo'] },
            sourceMode: overrides.sourceMode || 'native',
            operations: overrides.operations || ['source.enumerate', 'source.open', 'source.close'],
            operationHandlers: {
                'source.enumerate': request => { calls.push(['source.enumerate', request]); return { sources }; },
                'source.open': request => { calls.push(['source.open', request]); return overrides.openResult || { outcome: 'handled', status: 'open' }; },
                'source.close': request => { calls.push(['source.close', request]); return overrides.closeResult || { outcome: 'handled', status: 'closed' }; },
                ...(overrides.operationHandlers || {}),
            },
        },
    };
}

function makeMonitoringProvider(overrides = {}) {
    const calls = [];
    const providerId = overrides.providerId || 'monitoring-provider';
    const logicalMonitoringKey = overrides.logicalMonitoringKey || `${providerId}:main`;
    const operations = overrides.operations || ['monitoring.start', 'monitoring.stop', 'monitoring.status', 'monitoring.set-direct-monitor'];
    const defaultHandlers = {
        'monitoring.start': request => {
            calls.push(['monitoring.start', request]);
            return overrides.startResult || { outcome: 'handled', status: 'active', summary: { directMonitor: overrides.directMonitor || { state: 'muted', control: 'supported', preference: 'muted', applied: true }, latencySummary: overrides.latencySummary || { bucket: 'low' } } };
        },
        'monitoring.stop': request => {
            calls.push(['monitoring.stop', request]);
            return overrides.stopResult || { outcome: 'handled', status: 'stopped' };
        },
        'monitoring.status': request => {
            calls.push(['monitoring.status', request]);
            return overrides.statusResult || { outcome: 'handled', status: 'active', summary: { availability: 'available', directMonitor: overrides.directMonitor || { state: 'muted', control: 'supported', preference: 'muted', applied: true }, latencySummary: overrides.latencySummary || { bucket: 'low' } } };
        },
        'monitoring.set-direct-monitor': request => {
            calls.push(['monitoring.set-direct-monitor', request]);
            return overrides.directMonitorResult || { outcome: 'handled', status: 'active', summary: { directMonitor: { state: request.state, control: 'supported', preference: request.state, applied: true } } };
        },
    };
    const operationHandlers = {};
    for (const operation of operations) {
        if (defaultHandlers[operation]) operationHandlers[operation] = defaultHandlers[operation];
    }
    Object.assign(operationHandlers, overrides.operationHandlers || {});
    return {
        calls,
        provider: {
            providerId,
            ownerPluginId: overrides.ownerPluginId || providerId,
            logicalMonitoringKey,
            safeLabel: overrides.safeLabel || 'Monitoring Provider',
            availability: overrides.availability || 'available',
            sourceMode: overrides.sourceMode || 'native',
            compatibilitySource: overrides.compatibilitySource || '',
            operations,
            directMonitor: overrides.directMonitor || { state: 'muted', control: 'supported', preference: 'muted', applied: true },
            latencySummary: overrides.latencySummary || { bucket: 'low' },
            operationHandlers,
        },
    };
}

function installDeterministicTimers(window) {
    const timers = [];
    let nextId = 1;
    window.setTimeout = (callback, delay = 0) => {
        const id = nextId;
        nextId += 1;
        timers.push({ id, callback, delay, cleared: false });
        return id;
    };
    window.clearTimeout = id => {
        const timer = timers.find(item => item.id === id);
        if (timer) timer.cleared = true;
    };
    window.__runTimers = (minimumDelay = 0) => {
        for (const timer of timers.slice()) {
            if (timer.cleared || timer.delay < minimumDelay) continue;
            timer.cleared = true;
            timer.callback();
        }
    };
    return timers;
}

function makeElement(tagName) {
    return {
        tagName,
        className: '',
        textContent: '',
        value: '',
        innerHTML: '',
        disabled: false,
        title: '',
        style: {},
        children: [],
        listeners: {},
        classList: {
            values: new Set(),
            add(name) { this.values.add(name); },
            remove(name) { this.values.delete(name); },
            contains(name) { return this.values.has(name); },
        },
        setAttribute(name, value) { this[name] = String(value); },
        appendChild(child) { this.children.push(child); return child; },
        addEventListener(type, handler) { this.listeners[type] = handler; },
        contains() { return false; },
        focus() {},
    };
}

function installMixerDom(window) {
    const elements = new Map();
    const audio = { volume: 0, src: '', load() {} };
    const button = makeElement('button');
    const popover = makeElement('div');
    elements.set('audio', audio);
    elements.set('btn-mixer', button);
    elements.set('mixer-popover', popover);
    window.Event = class Event { constructor(type) { this.type = type; } };
    window.document.readyState = 'complete';
    window.document.getElementById = id => elements.get(id) || null;
    window.document.addEventListener = () => {};
    window.document.removeEventListener = () => {};
    window.document.createElement = makeElement;
    return { elements, audio, button, popover };
}

function loadAudioMixer(window) {
    runBrowserScript(window, path.relative(ROOT, AUDIO_MIXER_JS));
    return window.feedBack.audio;
}

module.exports = {
    loadAudioSession,
    runBrowserScript,
    captureEvents,
    diagnosticsSnapshot,
    storageEntries,
    makeInputProvider,
    makeMonitoringProvider,
    installDeterministicTimers,
    installMixerDom,
    loadAudioMixer,
    ROOT,
};
