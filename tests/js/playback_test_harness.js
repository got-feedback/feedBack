const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createWindow, ROOT } = require('./capabilities_test_harness');

const CAPABILITIES_JS = path.join(ROOT, 'static', 'capabilities.js');
const PLAYBACK_JS = path.join(ROOT, 'static', 'capabilities', 'playback.js');
const INSPECTOR_JS = path.join(ROOT, 'plugins', 'capability_inspector', 'screen.js');

function loadPlayback(options = {}) {
    const window = createWindow(options);
    const context = vm.createContext(window);
    vm.runInContext(fs.readFileSync(CAPABILITIES_JS, 'utf8'), context, { filename: CAPABILITIES_JS });
    vm.runInContext(fs.readFileSync(PLAYBACK_JS, 'utf8'), context, { filename: PLAYBACK_JS });
    window.__vmContext = context;
    return window;
}

function runBrowserScript(window, filePath) {
    vm.runInContext(fs.readFileSync(filePath, 'utf8'), window.__vmContext, { filename: filePath });
}

function loadInspector(window) {
    runBrowserScript(window, INSPECTOR_JS);
    return window;
}

function captureEvents(window, eventName) {
    const events = [];
    window.feedBack.on(eventName, event => events.push(event.detail));
    return events;
}

function diagnosticsSnapshot(window, options = {}) {
    return window.feedBack.playback.snapshot(options);
}

function dispatch(window, command, payload = {}, requester = 'test') {
    return window.feedBack.capabilities.dispatch({ capability: 'playback', command, args: payload, requester });
}

function makeTarget(overrides = {}) {
    return {
        filename: overrides.filename || '/Users/example/DLC/Secret Artist - Song_p.archive',
        title: overrides.title || 'Visible Title',
        artist: overrides.artist || 'Visible Artist',
        arrangement: overrides.arrangement || 'Lead',
        arrangementIndex: overrides.arrangementIndex ?? 0,
        format: overrides.format || 'archive',
        sourceKind: overrides.sourceKind || 'local',
        ...overrides,
    };
}

function makeAdapter(overrides = {}) {
    const calls = [];
    let currentTime = overrides.currentTime ?? 0;
    let duration = overrides.duration ?? 120;
    let isPlaying = false;
    let loop = { enabled: false, state: 'inactive' };
    let route = { routeKind: 'browser-media', state: 'active', preservedTime: true };
    const adapter = {
        calls,
        inspect() {
            calls.push(['inspect']);
            return overrides.inspectResult || { currentTime, mediaTime: currentTime, chartTime: currentTime, duration, playbackRate: 1, isPlaying, route, loop };
        },
        async start(request) {
            calls.push(['start', request]);
            isPlaying = !!overrides.startPlaying;
            if (overrides.startError) throw new Error(overrides.startError);
            return overrides.startResult || { currentTime, duration, isPlaying, route, loop };
        },
        async pause(request) {
            calls.push(['pause', request]);
            isPlaying = false;
            if (overrides.pauseError) throw new Error(overrides.pauseError);
            return overrides.pauseResult || { currentTime, duration, isPlaying, route, loop };
        },
        async resume(request) {
            calls.push(['resume', request]);
            if (overrides.resumeUnavailable) return { unavailable: true, reason: 'unavailable' };
            if (overrides.resumeError) throw new Error(overrides.resumeError);
            isPlaying = true;
            return overrides.resumeResult || { currentTime, duration, isPlaying, route, loop };
        },
        async stop(request) {
            calls.push(['stop', request]);
            isPlaying = false;
            if (overrides.stopError) throw new Error(overrides.stopError);
            return overrides.stopResult || { currentTime, duration, isPlaying, route, loop };
        },
        async seek(request) {
            calls.push(['seek', request]);
            if (overrides.seekError) throw new Error(overrides.seekError);
            if (overrides.seekResult) {
                currentTime = overrides.seekResult.to ?? overrides.seekResult.landedTime ?? currentTime;
                return overrides.seekResult;
            }
            const to = Math.max(0, Math.min(duration, Number(request.time)));
            const from = currentTime;
            currentTime = to;
            return { completed: true, from, to };
        },
        async setLoop(request) {
            calls.push(['setLoop', request]);
            if (overrides.setLoopError) throw new Error(overrides.setLoopError);
            if (overrides.setLoopResult !== undefined) return overrides.setLoopResult;
            loop = { startTime: request.startTime, endTime: request.endTime, enabled: true, state: 'active' };
            return true;
        },
        async clearLoop(request) {
            calls.push(['clearLoop', request]);
            loop = { enabled: false, state: 'cleared' };
            return true;
        },
    };
    return adapter;
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
    window.document.getElementById = id => elements.get(id) || null;
    window.document.querySelectorAll = () => [];
    window.document.addEventListener = () => {};
    window.document.createElement = () => element(`created-${elements.size}`);
    window.requestAnimationFrame = callback => callback();
    return elements;
}

module.exports = {
    ROOT,
    loadPlayback,
    loadInspector,
    captureEvents,
    diagnosticsSnapshot,
    dispatch,
    makeTarget,
    makeAdapter,
    installInspectorDom,
};
