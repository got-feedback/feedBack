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
// 'butterchurn' is a mode, not a BG_STYLES fog-scenery entry: _bcSyncMode
// owns its controller and drives its own audio tap + canvas opacity (only
// the fog-scenery half falls through to BG_STYLES.off), so both are false.
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
        removeAttribute(k) { delete this[k]; }
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

    const bus = {};
    const listeners = new Set();
    const emit = (key) => { for (const fn of listeners) fn(key); };
    const writes = [];
    const timers = [];

    const sandbox = {
        console,
        BG_STYLE_IDS,
        // Module-scope in screen.js; the _pc* block reads it to resolve the
        // effective style under the Venue override. Tests flip it via
        // sandbox._venueSceneOverride and fire the 'venueScene' bus key.
        _venueSceneOverride: false,
        _bgReadSetting: (_panelKey, key) => store[key],
        _bgReadGlobal: (key) => store[key],
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
            feedBack: {
                uiVersion: 'v3',   // _pcSlot gates on this (docs/plugin-v3-ui.md)
                ui: { playerControlSlot: () => dom.slot },
                // The real bus is an EventTarget wrapper exposing on/off. Modelled
                // here so the screen:changed subscription — and its removal — are
                // observable.
                on: (ev, fn) => { (bus[ev] || (bus[ev] = [])).push(fn); },
                off: (ev, fn) => {
                    const l = bus[ev];
                    if (!l) return;
                    const i = l.indexOf(fn);
                    if (i >= 0) l.splice(i, 1);
                },
            },
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
        + '   get reason() { return _pcReason; },'
        + '   get refs() { return _pcRefs; } })',
        sandbox,
    );
    const fireScreenChanged = () => (bus['screen:changed'] || []).slice().forEach((fn) => fn());
    const screenHooks = () => (bus['screen:changed'] || []).length;
    return { api, dom, store, emit, writes, timers, sandbox, listenerCount: () => listeners.size, fireScreenChanged, screenHooks };
}

// Slice the real _bgReadSetting + _bgReadGlobal out of screen.js and run them
// against a localStorage stub. The main suite stubs both helpers identically,
// so it can't tell the #2 refactor from a no-op; this one proves the actual
// helper bodies differ where they must: _bgReadGlobal ignores a per-panel
// override that _bgReadSetting(panelKey, ...) still honours.
test('_bgReadGlobal reads the global slot, ignoring per-panel overrides', () => {
    const src = fs.readFileSync(SCREEN_JS, 'utf8');
    const rgStart = src.indexOf('    function _bgReadSetting(panelKey, key) {');
    const rgEnd = src.indexOf('    // Shared "stored string -> bool" coercion');
    assert.ok(rgStart !== -1 && rgEnd > rgStart, 'could not slice the read helpers');
    const block = src.slice(rgStart, rgEnd);

    const storage = new Map();
    const sandbox = {
        localStorage: { getItem: (k) => (storage.has(k) ? storage.get(k) : null) },
        _bgCoerce: (_key, v) => v,           // identity: we test key resolution, not coercion
        _bgMemFallback: Object.create(null),
        BG_DEFAULTS: { style: 'particles' },
    };
    sandbox.globalThis = sandbox;
    const api = vm.runInNewContext(block + '\n({ _bgReadSetting, _bgReadGlobal, _bgMemFallback })', sandbox);

    storage.set('h3d_bg_style', 'lights');            // global
    storage.set('h3d_bg_panel3_style', 'geometric');  // a per-panel override

    // The renderer, reading with a panel key, honours the per-panel override...
    assert.equal(api._bgReadSetting('panel3', 'style'), 'geometric');
    // ...but the shared control's global read must NOT see it - this is the
    // whole point of #2 (previously _bgReadSetting(null, ...) relied on
    // 'h3d_bg_null_style' never existing).
    assert.equal(api._bgReadGlobal('style'), 'lights');

    // In-memory staged value wins over the persisted global (matches
    // _bgReadSetting's precedence).
    api._bgMemFallback.style = 'aurora';
    assert.equal(api._bgReadGlobal('style'), 'aurora');
    delete api._bgMemFallback.style;

    // Nothing stored -> BG_DEFAULTS.
    assert.equal(api._bgReadGlobal('style'), 'lights');
    storage.delete('h3d_bg_style');
    assert.equal(api._bgReadGlobal('style'), 'particles');
});

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

test('binds the screen hook on a retry when the bus was not ready at acquire', () => {
    const ctl = load();
    // Cold load: on a fresh page the renderer can init before the event bus is
    // wired AND before the rail popover exists. Simulate both being absent.
    const savedOn = ctl.sandbox.window.feedBack.on;
    const savedUi = ctl.sandbox.window.feedBack.ui;
    delete ctl.sandbox.window.feedBack.on;
    ctl.sandbox.window.feedBack.ui = {};   // no playerControlSlot -> mount fails

    ctl.api._pcAcquire();
    assert.equal(ctl.screenHooks(), 0, 'nothing to bind to yet');
    assert.equal(ctl.api.el, null, 'no slot yet, so nothing mounted');

    // Bus + slot come online; the retry tick must bind the hook, not only mount.
    ctl.sandbox.window.feedBack.on = savedOn;
    ctl.sandbox.window.feedBack.ui = savedUi;
    ctl.timers.shift()();   // run one retry tick

    assert.equal(ctl.screenHooks(), 1, 'the retry tick failed to bind the screen hook');
    assert.ok(ctl.api.el, 'and it should have mounted too');
    ctl.api._pcRelease();
});

test('the last release unbinds the screen:changed hook', () => {
    const ctl = load();
    ctl.api._pcAcquire();
    assert.equal(ctl.screenHooks(), 1, 'acquire should subscribe once');

    ctl.api._pcAcquire();
    ctl.api._pcRelease();
    assert.equal(ctl.screenHooks(), 1, 'a partial release must keep the hook');

    ctl.api._pcRelease();
    assert.equal(ctl.screenHooks(), 0, 'the hook outlived the control');

    // And re-acquiring must re-subscribe exactly once, not zero times (the
    // bind is guarded on _pcScreenHook, so failing to null it would leave the
    // control permanently deaf to chrome rebuilds).
    ctl.api._pcAcquire();
    assert.equal(ctl.screenHooks(), 1, 're-acquire did not re-subscribe');
    ctl.api._pcRelease();
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

test('a non-v3 host mounts nothing (uiVersion gate)', () => {
    const ctl = load();
    ctl.sandbox.window.feedBack.uiVersion = 'v2';   // pre-v3 shell
    ctl.api._pcAcquire();
    assert.equal(ctl.api.el, null, 'must not mount when uiVersion is not v3');
    assert.equal(ctl.dom.slot.children.length, 0);
    // Retry loop must still terminate rather than spin.
    let guard = 0;
    while (ctl.timers.length && guard++ < 100) ctl.timers.shift()();
    assert.ok(guard < 100, 'retry loop did not terminate');
    ctl.api._pcRelease();
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

test('exposes state and reasons to assistive tech', () => {
    const ctl = load({ store: { style: 'image', reactive: true } });   // image: reactive inert
    ctl.api._pcAcquire();

    // The reason live-region must be a REAL mounted element with the id the
    // controls reference - not a dangling pointer. Assert resolution, not a
    // literal (a wrong id in code would still equal the literal).
    const reason = ctl.api.reason;
    assert.ok(reason, 'the reason span was not created');
    assert.equal(reason.id, 'h3d-pc-reason');
    assert.equal(reason.parentNode, ctl.api.el, 'the reason span must be mounted in the control');

    // aria-pressed: a toggle button must expose its state. image greys
    // Reactive, so not-pressed AND disabled, and it points at the reason.
    assert.equal(ctl.api.react['aria-pressed'], 'false', 'greyed toggle is not pressed');
    assert.equal(ctl.api.react['aria-disabled'], 'true');
    // Pointer must resolve to the actual span's id (kills a wrong-id mutation),
    // and the span must carry the current reason text (kills a never-set-text
    // mutation).
    assert.equal(ctl.api.react['aria-describedby'], reason.id, 'inert control must reference the reason span');
    assert.equal(reason.textContent, 'This background does not react to audio', 'reason text must match the style');
    assert.equal(ctl.api.intens['aria-describedby'], undefined, 'an ENABLED control carries no reason');

    // The intensity describe path: a style where INTENSITY is inert.
    ctl.store.style = 'video'; ctl.emit('style');
    assert.equal(ctl.api.intens.disabled, true, 'precondition: video greys intensity');
    assert.equal(ctl.api.intens['aria-describedby'], reason.id, 'inert intensity must reference the reason');
    assert.equal(reason.textContent, 'The video plays as-is - nothing to adjust here');

    // Both enabled: describedby drops, aria-pressed follows the value.
    ctl.store.style = 'particles'; ctl.store.reactive = true; ctl.emit('style');
    assert.equal(ctl.api.react['aria-describedby'], undefined, 'enabled control drops the reason');
    assert.equal(ctl.api.intens['aria-describedby'], undefined);
    assert.equal(ctl.api.react['aria-pressed'], 'true', 'reactive on for particles');
    ctl.store.reactive = false; ctl.emit('reactive');
    assert.equal(ctl.api.react['aria-pressed'], 'false', 'aria-pressed follows the value');

    // Accessible names on the non-label controls.
    assert.equal(ctl.api.sel['aria-label'], 'Background style');
    assert.equal(ctl.api.intens['aria-label'], 'Background intensity');
    ctl.api._pcRelease();
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

test('the Venue override greys the whole Background group', () => {
    const ctl = load({ store: { style: 'particles' } });   // a style that uses both
    ctl.api._pcAcquire();
    assert.equal(ctl.api.intens.disabled, false, 'precondition: both enabled off-venue');
    assert.equal(ctl.api.react.disabled, false);

    // Venue turns on: the effective style is now 'venue', which uses neither.
    // The transition arrives on the settings bus as the 'venueScene' key.
    ctl.sandbox._venueSceneOverride = true;
    ctl.emit('venueScene');
    assert.equal(ctl.api.intens.disabled, true, 'intensity should grey under Venue');
    assert.equal(ctl.api.react.disabled, true, 'reactive should grey under Venue');
    assert.equal(ctl.api.sel.disabled, true, 'the dropdown should be inert under Venue too');
    assert.match(ctl.api.intens.title, /venue/i, 'reason should mention Venue');
    // All three inert controls point at the reason under Venue (kills a
    // 'describe reactive only' regression on the select/intensity paths).
    const vReason = ctl.api.reason.id;
    assert.equal(ctl.api.sel['aria-describedby'], vReason, 'select must reference the reason under Venue');
    assert.equal(ctl.api.intens['aria-describedby'], vReason, 'intensity must reference the reason under Venue');
    assert.equal(ctl.api.react['aria-describedby'], vReason, 'reactive must reference the reason under Venue');
    assert.match(ctl.api.reason.textContent, /venue/i, 'the reason span carries the Venue text');

    // The dropdown still shows the stored style (venue has no option), but
    // selecting must not write while it's inert.
    assert.equal(ctl.api.sel.value, 'particles');
    const before = ctl.writes.length;
    ctl.api.sel.value = 'lights';
    ctl.api.sel.fire('change');
    assert.equal(ctl.writes.length, before, 'a disabled dropdown must not write');

    // Venue off: controls come back per the stored style.
    ctl.sandbox._venueSceneOverride = false;
    ctl.emit('venueScene');
    assert.equal(ctl.api.intens.disabled, false, 'intensity re-enables when Venue exits');
    assert.equal(ctl.api.react.disabled, false);
    assert.equal(ctl.api.sel.disabled, false, 'the dropdown re-enables when Venue exits');
    assert.equal(ctl.api.sel.title, 'Background style', 'the base tooltip must come back, not blank');
    assert.equal(ctl.api.sel['aria-describedby'], undefined, 'select drops the reason off-Venue');
    assert.equal(ctl.api.intens['aria-describedby'], undefined, 'intensity drops the reason off-Venue');
    ctl.api._pcRelease();
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

// A native-disabled <button>/<input> fires no pointer events, so its own
// `title` never shows on hover. The reason must therefore also sit on the
// non-disabled wrapper, and the disabled control must let the hover fall
// through (pointer-events:none) — otherwise the "says why on hover" feature is
// dead in the browser while these tests pass on the swallowed control title.
test('the greyed-out reason reaches a hoverable wrapper', () => {
    const { api, store, emit } = load();
    api._pcAcquire();
    store.style = 'video';           // uses neither setting
    emit('style');

    assert.match(api.react.parentNode.title, /nothing to adjust/i,
        'reactive reason must be on the wrapper, not only the disabled pill');
    assert.equal(api.react.style.pointerEvents, 'none',
        'disabled pill must pass hover through to its wrapper');

    assert.match(api.intens.parentNode.title, /nothing to adjust/i,
        'intensity reason must be on the wrapper, not only the disabled slider');
    assert.equal(api.intens.style.pointerEvents, 'none',
        'disabled slider must pass hover through to its wrapper');

    // ...and an enabled style clears the wrapper so the control's own title wins.
    store.style = 'particles';
    emit('style');
    assert.equal(api.react.parentNode.title, '');
    assert.equal(api.intens.parentNode.title, '');
    assert.equal(api.intens.style.pointerEvents, '');
});
