// Lightweight contract tests for v3 Progress calibration retry/success modals.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { ROOT } = require('./capabilities_test_harness');

const PROGRESS_JS = path.join(ROOT, 'static', 'v3', 'progress.js');

function createProgressWindow(progressionState) {
    class CustomEvent {
        constructor(type, init = {}) {
            this.type = type;
            this.detail = init.detail;
        }
    }

    const listeners = new Map();
    const byId = new Map();

    function wireElement(el) {
        if (el.id) byId.set(el.id, el);
        el.querySelector = (sel) => {
            const m = sel.match(/^\[data-([^\]]+)\]$/);
            if (!m) return null;
            const attr = `data-${m[1]}`;
            const walk = (node) => {
                if (node.getAttribute && node.getAttribute(attr) != null) return node;
                for (const child of (node.children || [])) {
                    const hit = walk(child);
                    if (hit) return hit;
                }
                return null;
            };
            return walk(el);
        };
        el.querySelectorAll = (sel) => {
            const one = el.querySelector(sel);
            return one ? [one] : [];
        };
        el.addEventListener = (type, handler) => {
            const list = el.__handlers || (el.__handlers = {});
            (list[type] || (list[type] = [])).push(handler);
        };
        el.remove = () => {
            if (el.id) byId.delete(el.id);
            const idx = bodyChildren.indexOf(el);
            if (idx !== -1) bodyChildren.splice(idx, 1);
        };
        return el;
    }

    const bodyChildren = [];
    const body = wireElement({
        id: '',
        tagName: 'BODY',
        children: bodyChildren,
        appendChild(child) {
            wireElement(child);
            bodyChildren.push(child);
            child.parentNode = body;
            return child;
        },
    });

    const window = {
        console,
        CustomEvent,
        setTimeout,
        clearTimeout,
        performance: { now: () => Date.now() },
        document: {
            readyState: 'complete',
            body,
            getElementById(id) { return byId.get(id) || null; },
            createElement(tag) {
                const el = {
                    id: '',
                    tagName: String(tag || '').toUpperCase(),
                    children: [],
                    _html: '',
                    className: '',
                };
                Object.defineProperty(el, 'innerHTML', {
                    get() { return el._html; },
                    set(html) {
                        el._html = html;
                        el.children.length = 0;
                        const btnRe = /<button[^>]*data-([^=\s]+)[^>]*>/g;
                        let m;
                        while ((m = btnRe.exec(html))) {
                            const attr = m[1];
                            const btn = wireElement({
                                tagName: 'BUTTON',
                                getAttribute(name) {
                                    if (name === `data-${attr}`) return '';
                                    return null;
                                },
                                addEventListener(type, handler) {
                                    const list = this.__handlers || (this.__handlers = {});
                                    (list[type] || (list[type] = [])).push(handler);
                                },
                                click() {
                                    for (const h of (this.__handlers || {}).click || []) h();
                                },
                                disabled: false,
                            });
                            el.children.push(btn);
                        }
                    },
                    appendChild(child) {
                        wireElement(child);
                        el.children.push(child);
                        return child;
                    },
                });
                return wireElement(el);
            },
            addEventListener(type, handler) {
                const list = listeners.get(type) || [];
                list.push(handler);
                listeners.set(type, list);
            },
        },
        v3Progression: {
            get() { return progressionState; },
            refresh() { return Promise.resolve(progressionState); },
        },
        playSong() {},
        feedBack: {
            on(type, handler) {
                const list = listeners.get(type) || [];
                list.push(handler);
                listeners.set(type, list);
            },
            emit(type, detail) {
                for (const handler of (listeners.get(type) || []).slice()) {
                    handler({ detail });
                }
            },
        },
        showScreen() {},
        __listeners: listeners,
        __byId: byId,
        __bodyChildren: bodyChildren,
    };
    window.window = window;
    window.globalThis = window;

    const progressRoot = window.document.createElement('div');
    progressRoot.id = 'v3-progress';
    window.document.body.appendChild(progressRoot);

    const context = vm.createContext(window);
    vm.runInContext(fs.readFileSync(PROGRESS_JS, 'utf8'), context, { filename: PROGRESS_JS });
    return window;
}

test('progression:calibration-attempt with 0.92 shows retry overlay and So close!', () => {
    const win = createProgressWindow({
        mastery_rank: 0,
        onboarding: {
            calibration_status: 'pending',
            diagnostic_filename: 'diagnostics-builtin/feedBack-diagnostic-basic-guitar.sloppak',
        },
        paths: [],
        wallet: { balance: 0, lifetime_db: 0 },
        quests: {},
    });

    win.feedBack.emit('progression:calibration-attempt', { accuracy: 0.92 });

    const overlay = win.document.getElementById('v3-calibration-retry');
    assert.ok(overlay, 'retry overlay should exist');
    assert.match(overlay.innerHTML, /So close!/);
    assert.match(overlay.innerHTML, /92%/);
    assert.equal(win.document.getElementById('v3-calibration-success'), null);
});

test('progression:calibration-completed shows success overlay and Setup verified!', () => {
    const win = createProgressWindow({
        mastery_rank: 0,
        onboarding: {
            calibration_status: 'pending',
            diagnostic_filename: 'diagnostics-builtin/feedBack-diagnostic-basic-guitar.sloppak',
        },
        paths: [],
        wallet: { balance: 0, lifetime_db: 0 },
        quests: {},
    });

    win.feedBack.emit('progression:calibration-completed', {});

    const overlay = win.document.getElementById('v3-calibration-success');
    assert.ok(overlay, 'success overlay should exist');
    assert.match(overlay.innerHTML, /Setup verified!/);
    assert.match(overlay.innerHTML, /Mastery Rank 1 is ready/);
    assert.equal(win.document.getElementById('v3-calibration-retry'), null);
});

test('success overlay for skipped state does not claim rank-up', () => {
    const win = createProgressWindow({
        mastery_rank: 1,
        onboarding: {
            calibration_status: 'skipped',
            diagnostic_filename: 'diagnostics-builtin/feedBack-diagnostic-basic-guitar.sloppak',
        },
        paths: [],
        wallet: { balance: 0, lifetime_db: 0 },
        quests: {},
    });

    win.feedBack.emit('progression:calibration-completed', {});

    const overlay = win.document.getElementById('v3-calibration-success');
    assert.ok(overlay);
    assert.match(overlay.innerHTML, /Your input and note detection setup is verified/);
    assert.doesNotMatch(overlay.innerHTML, /Mastery Rank 1/);
    assert.match(overlay.innerHTML, /Play again/);
});

test('calibration-completed does not stack duplicate success overlays', () => {
    const win = createProgressWindow({
        mastery_rank: 1,
        onboarding: {
            calibration_status: 'skipped',
            diagnostic_filename: 'diagnostics-builtin/feedBack-diagnostic-basic-guitar.sloppak',
        },
        paths: [],
        wallet: { balance: 0, lifetime_db: 0 },
        quests: {},
    });

    win.feedBack.emit('progression:calibration-completed', {});
    win.feedBack.emit('progression:calibration-completed', {});

    const overlays = win.__bodyChildren.filter((el) => el.id === 'v3-calibration-success');
    assert.equal(overlays.length, 1);
});
