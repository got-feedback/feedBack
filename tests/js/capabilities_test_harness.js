const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..', '..');
const CAPABILITIES_JS = path.join(ROOT, 'static', 'capabilities.js');
const LIBRARY_CAPABILITY_JS = path.join(ROOT, 'static', 'capabilities', 'library.js');

function createWindow(options = {}) {
    class CustomEvent {
        constructor(type, init = {}) {
            this.type = type;
            this.detail = init.detail;
        }
    }

    const listeners = new Map();
    const storage = new Map();
    const elements = new Map();
    const diagnosticsContributions = new Map();
    const window = {
        console,
        CustomEvent,
        setTimeout,
        clearTimeout,
        performance: { now: () => Date.now() },
        addEventListener(type, handler) {
            const list = listeners.get(type) || [];
            list.push(handler);
            listeners.set(type, list);
        },
        removeEventListener(type, handler) {
            const list = listeners.get(type) || [];
            listeners.set(type, list.filter(item => item !== handler));
        },
        dispatchEvent(event) {
            for (const handler of (listeners.get(event.type) || []).slice()) handler(event);
            return true;
        },
        localStorage: {
            getItem(key) { return storage.has(key) ? storage.get(key) : null; },
            setItem(key, value) { storage.set(String(key), String(value)); },
            removeItem(key) { storage.delete(String(key)); },
        },
        document: {
            getElementById(id) { return elements.get(id) || null; },
        },
        feedBack: {
            emit(type, detail) {
                window.dispatchEvent(new CustomEvent(type, { detail }));
            },
            diagnostics: options.diagnostics === false ? undefined : {
                contribute(id, payload) { diagnosticsContributions.set(id, payload); },
                snapshotContributions() { return Object.fromEntries(diagnosticsContributions); },
            },
        },
        __listeners: listeners,
        __storage: storage,
        __elements: elements,
        __diagnosticsContributions: diagnosticsContributions,
    };
    window.window = window;
    window.globalThis = window;
    return window;
}

function loadCapabilities(options = {}) {
    const window = createWindow(options);
    const context = vm.createContext(window);
    const source = fs.readFileSync(CAPABILITIES_JS, 'utf8');
    vm.runInContext(source, context, { filename: CAPABILITIES_JS });
    if (options.library) {
        const librarySource = fs.readFileSync(LIBRARY_CAPABILITY_JS, 'utf8');
        vm.runInContext(librarySource, context, { filename: LIBRARY_CAPABILITY_JS });
    }
    return window;
}

module.exports = { loadCapabilities, createWindow, ROOT };