// Player-chrome background control.
//
// The control mounts a Background picker (style / Reactive / Intensity) into
// the player's Plugin Controls popover so the background can be changed
// mid-song. Two things about it are easy to get wrong and invisible when they
// are:
//
//   * It is REFCOUNTED. Several renderer instances can be live at once (a
//     splitscreen host creates one per panel), but the settings it writes are
//     global — N controls would be N ways to set one value, and a leaked
//     refcount pins a dead control in the UI. The multi-instance behaviour is
//     exercised here with stubbed instances; it is NOT verified against a real
//     splitscreen session, whose visualizer does not currently work.
//   * It GREYS OUT controls the active style ignores. Not every background
//     style reads `intensity`, and none of them read audio bands under
//     Butterchurn, so a live-looking knob that does nothing is a real bug.
//
// screen.js is a single ~16k-line IIFE, so the control cannot be imported. The
// self-contained `_pc*` block is sliced out of the real source and evaluated
// with its few collaborators stubbed (BG_STYLE_IDS, _bgReadSetting,
// _bgSubscribe/_bgUnsubscribe). The slice markers are asserted before use: move
// or rename the block and this fails loudly rather than testing nothing.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const SCREEN_JS = path.join(__dirname, '..', 'screen.js');
const START = '    const _PC_LABELS = {';
const END_CRLF = '    /* ======================================================================\r\n     *  Factory';
const END_LF = '    /* ======================================================================\n     *  Factory';

// What each style is expected to consume, derived by reading the BG_STYLES
// bodies in screen.js — deliberately NOT read from the plugin's own _PC_USES
// table, which would only assert that the table equals itself.
//   intensity: true  => the style's build() reads settings.intensity
//   reactive:  true  => the style's update() dereferences its `bands` argument
// 'butterchurn' is not a BG_STYLES entry at all (mount falls through to
// BG_STYLES.off) and drives its own audio tap, so both are false.
const EXPECTED_USES = {
    off: { intensity: false, reactive: false },
    particles: { intensity: true, reactive: true },
    silhouettes: { intensity: true, reactive: true },
    lights: { intensity: true, reactive: true },
    geometric: { intensity: true, reactive: true },
    image: { intensity: true, reactive: false },
    video: { intensity: false, reactive: false },
    butterchurn: { intensity: false, reactive: false },
};

const BG_STYLE_IDS = ['off', 'particles', 'silhouettes', 'lights', 'geometric', 'butterchurn', 'image', 'video'];

// Minimal DOM: only what the control touches.
function makeDom() {
    class El {
        constructor(tag) {
            this.tagName = String(tag).toUpperCase();
            this.children = [];
            this.parentNode = null;
            this.listeners = {};
            this.style = { cssText: '' };
            this.disabled = false;
            this._on = false;
        }
        appendChild(c) { c.parentNode = this; this.children.push(c); return c; }
        removeChild(c) {
            const i = this.children.indexOf(c);
            if (i >= 0) this.children.splice(i, 1);
            c.parentNode = null;
            return c;
        }
        addEventListener(t, fn) { (this.listeners[t] || (this.listeners[t] = [])).push(fn); }
        setAttribute(k, v) { this[k] = v; }
        get isConnected() {
            let n = this;
            while (n.parentNode) n = n.parentNode;
            return n === root;
        }
        querySelector(sel) {
            const m = /^option\[value="(.+)"\]$/.exec(sel);
            const want = m ? m[1] : null;
            const walk = (n) => {
                for (const c of n.children) {
                    if (want != null && c.tagName === 'OPTION' && c.value === want) return c;
                    const r = walk(c);
                    if (r) return r;
                }
                return null;
            };
            return walk(this);
        }
        fire(type) { (this.listeners[type] || []).forEach((fn) => fn()); }
    }
    const root = new El('root');
    const slot = new El('div');
    root.appendChild(slot);
    return { El, root, slot };
}

function load({ store: initialStore } = {}) {
    const src = fs.readFileSync(SCREEN_JS, 'utf8');
    const start = src.indexOf(START);
    assert.notEqual(start, -1, 'could not find the _PC_LABELS marker in screen.js');
    let end = src.indexOf(END_CRLF);
    if (end === -1) end = src.indexOf(END_LF);
    assert.notEqual(end, -1, 'could not find the Factory banner marker in screen.js');
    assert.ok(end > start, 'slice markers found out of order in screen.js');
    const block = src.slice(start, end);

    const dom = makeDom();
    const store = Object.assign({
        style: 'particles',
        reactive: true,
        intensity: 0.5,
        customImageDataUrl: '',
        customVideoName: '',
    }, initialStore);

    const listeners = new Set();
    const emit = (key) => { for (const fn of listeners) fn(key); };
    const writes = [];
    const timers = [];

    const sandbox = {
        console,
        BG_STYLE_IDS,
        _bgReadSetting: (_panelKey, key) => store[key],
        _bgSubscribe: (fn) => listeners.add(fn),
        _bgUnsubscribe: (fn) => listeners.delete(fn),
        setTimeout: (fn) => { timers.push(fn); return timers.length; },
        clearTimeout: () => {},
        document: {
            createElement: (t) => new dom.El(t),
            // The Settings-panel mirror looks these up; absent here so it no-ops.
            getElementById: () => null,
        },
        window: {
            feedBack: { ui: { playerControlSlot: () => dom.slot } },
            h3dBgSetStyle: (v) => { writes.push(['style', v]); store.style = v; emit('style'); },
            h3dBgSetReactive: (v) => { writes.push(['reactive', v]); store.reactive = v; emit('reactive'); },
            h3dBgSetIntensity: (v) => { writes.push(['intensity', v]); store.intensity = v; emit('intensity'); },
        },
    };
    sandbox.globalThis = sandbox;

    const api = vm.runInNewContext(
        block
        + '\n({ _pcAcquire, _pcRelease,'
        + '   get el() { return _pcEl; },'
        + '   get sel() { return _pcSel; },'
        + '   get react() { return _pcReactive; },'
        + '   get intens() { return _pcIntensity; },'
        + '   get refs() { return _pcRefs; } })',
        sandbox,
    );
    return { api, dom, store, emit, writes, timers, sandbox, listenerCount: () => listeners.size };
}

test('mounts one control into the player-control slot', () => {
    const { api, dom } = load();
    api._pcAcquire();
    assert.equal(dom.slot.children.length, 1);
    assert.ok(api.sel, 'style dropdown was not created');
    assert.equal(api.sel.children.length, BG_STYLE_IDS.length, 'one option per style');
});

test('multiple renderer instances share a single control', () => {
    const { api, dom } = load();
    api._pcAcquire();
    api._pcAcquire();
    api._pcAcquire();
    api._pcAcquire();
    assert.equal(dom.slot.children.length, 1, 'four instances must not mount four controls');
    assert.equal(api.refs, 4);

    api._pcRelease();
    api._pcRelease();
    api._pcRelease();
    assert.equal(dom.slot.children.length, 1, 'still held by the last instance');
    api._pcRelease();
    assert.equal(dom.slot.children.length, 0, 'last release must unmount');
    assert.equal(api.el, null);
});

test('teardown unsubscribes from the settings bus', () => {
    const ctl = load();
    ctl.api._pcAcquire();
    assert.equal(ctl.listenerCount(), 1);
    ctl.api._pcRelease();
    assert.equal(ctl.listenerCount(), 0, 'listener leaked after unmount');
});

test('tracks changes made from the Settings page', () => {
    const { api, store, emit } = load();
    api._pcAcquire();
    store.style = 'lights';
    emit('style');
    assert.equal(api.sel.value, 'lights');
});

test('custom media options stay disabled until something is uploaded', () => {
    const { api, store, emit } = load();
    api._pcAcquire();
    assert.equal(api.sel.querySelector('option[value="image"]').disabled, true);
    store.customImageDataUrl = 'data:image/png;base64,AAAA';
    emit('customImageDataUrl');
    assert.equal(api.sel.querySelector('option[value="image"]').disabled, false);
    assert.equal(api.sel.querySelector('option[value="video"]').disabled, true, 'video is independent');
});

test('re-mounts into a fresh slot when the player chrome is rebuilt', () => {
    const { api, dom, sandbox, listenerCount } = load();
    api._pcAcquire();
    const first = api.el;

    dom.root.removeChild(dom.slot);
    const fresh = new dom.El('div');
    dom.root.appendChild(fresh);
    sandbox.window.feedBack.ui.playerControlSlot = () => fresh;

    api._pcAcquire();
    assert.equal(fresh.children.length, 1, 'did not remount into the new slot');
    assert.notEqual(api.el, first, 'stale node was reused');
    assert.equal(listenerCount(), 1, 'remount must not double-subscribe');
});

test('a host with no player-control slot mounts nothing and does not throw', () => {
    const { api, dom, sandbox, timers } = load();
    sandbox.window.feedBack.ui = {};
    api._pcAcquire();
    assert.equal(api.el, null);
    assert.equal(dom.slot.children.length, 0);

    let guard = 0;
    while (timers.length && guard++ < 100) timers.shift()();
    assert.ok(guard < 100, 'retry loop did not terminate');
});

test('intensity writes once on release, not on every drag step', () => {
    const { api, writes } = load();
    api._pcAcquire();
    for (const v of ['0.10', '0.20', '0.30', '0.40', '0.50']) {
        api.intens.value = v;
        api.intens.fire('input');
    }
    assert.equal(writes.filter((w) => w[0] === 'intensity').length, 0,
        'dragging must not write — every write rebuilds the background scene');
    api.intens.fire('change');
    assert.equal(writes.filter((w) => w[0] === 'intensity').length, 1,
        'releasing must write exactly once');
});

test('the dropdown and Reactive pill drive the real setters', () => {
    const { api, store, writes } = load();
    api._pcAcquire();
    api.sel.value = 'geometric';
    api.sel.fire('change');
    assert.equal(store.style, 'geometric');

    const before = store.reactive;
    api.react.fire('click');
    assert.equal(store.reactive, !before, 'Reactive pill must toggle');
    assert.ok(writes.some((w) => w[0] === 'reactive'));
});

test('greys out exactly the controls each style ignores', () => {
    const { api, store, emit } = load();
    api._pcAcquire();
    for (const [style, want] of Object.entries(EXPECTED_USES)) {
        store.style = style;
        emit('style');
        assert.equal(!api.intens.disabled, want.intensity, `${style}: intensity enabled-ness`);
        assert.equal(!api.react.disabled, want.reactive, `${style}: reactive enabled-ness`);
    }
});

test('an unknown style enables both controls (fails open)', () => {
    const { api, store, emit } = load();
    api._pcAcquire();
    store.style = 'some_future_style';
    emit('style');
    assert.equal(api.intens.disabled, false);
    assert.equal(api.react.disabled, false);
});

test('greyed-out controls cannot reach the setters', () => {
    const { api, store, emit, writes } = load();
    api._pcAcquire();
    store.style = 'video';           // uses neither setting
    emit('style');
    const before = writes.length;
    api.intens.fire('change');
    api.react.fire('click');
    assert.equal(writes.length, before, 'an inert control must not write');
});

test('greyed-out controls explain themselves on hover', () => {
    const { api, store, emit } = load();
    api._pcAcquire();
    store.style = 'butterchurn';
    emit('style');
    assert.match(api.react.title, /butterchurn/i);
    assert.match(api.intens.title, /butterchurn/i);
});
