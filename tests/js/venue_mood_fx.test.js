'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const venue = require('../../static/v3/venue-mood-fx.js');
const INDEX_HTML = path.join(__dirname, '..', '..', 'static', 'v3', 'index.html');
const V3_CSS = path.join(__dirname, '..', '..', 'static', 'v3', 'v3.css');

test('normalizeVenueMoodSetting preserves off/subtle/full and defaults invalid', () => {
    assert.equal(venue.normalizeVenueMoodSetting('off'), 'off');
    assert.equal(venue.normalizeVenueMoodSetting('subtle'), 'subtle');
    assert.equal(venue.normalizeVenueMoodSetting('full'), 'full');
    assert.equal(venue.normalizeVenueMoodSetting('bogus'), 'subtle');
    assert.equal(venue.normalizeVenueMoodSetting(undefined), 'subtle');
});

test('venueMoodClassForState maps performance states', () => {
    assert.equal(venue.venueMoodClassForState('fire'), 'venue-mood-state-fire');
    assert.equal(venue.venueMoodClassForState('smoke'), 'venue-mood-state-smoke');
    assert.equal(venue.venueMoodClassForState('unknown'), 'venue-mood-state-idle');
});

test('setting persistence key is feedBack-venue-mood-fx', () => {
    assert.equal(venue.KEY, 'feedBack-venue-mood-fx');
});

test('venue motion setting key is feedBack-venue-motion', () => {
    assert.equal(venue.MOTION_KEY, 'feedBack-venue-motion');
    assert.equal(venue.MOTION_DEFAULT, 'subtle');
});

test('normalizeVenueMotionSetting preserves off/subtle/full and defaults invalid', () => {
    assert.equal(venue.normalizeVenueMotionSetting('off'), 'off');
    assert.equal(venue.normalizeVenueMotionSetting('subtle'), 'subtle');
    assert.equal(venue.normalizeVenueMotionSetting('full'), 'full');
    assert.equal(venue.normalizeVenueMotionSetting('bogus'), 'subtle');
    assert.equal(venue.normalizeVenueMotionSetting(undefined), 'subtle');
});

test('venueMotionProfile returns zero motion for off and bounded nonzero for subtle/full', () => {
    const off = venue.venueMotionProfile('off');
    assert.equal(off.breathe, 0);
    assert.equal(off.parallax, 0);
    assert.equal(off.hazeDrift, 0);
    assert.equal(off.warmthPulse, 0);
    assert.equal(off.shimmer, 0);
    assert.equal(venue.venueMotionIntensity('off'), 0);

    const subtle = venue.venueMotionProfile('subtle');
    const full = venue.venueMotionProfile('full');
    assert.ok(subtle.breathe > 0 && subtle.breathe < 0.02);
    assert.ok(subtle.parallax > 0 && subtle.parallax < 0.02);
    assert.ok(subtle.hazeDrift > 0 && subtle.hazeDrift < 0.05);
    assert.ok(venue.venueMotionIntensity('subtle') > 0);
    assert.ok(venue.venueMotionIntensity('subtle') < 0.05);

    assert.ok(full.breathe > subtle.breathe);
    assert.ok(full.parallax > subtle.parallax);
    assert.ok(full.hazeDrift > subtle.hazeDrift);
    assert.ok(venue.venueMotionIntensity('full') > venue.venueMotionIntensity('subtle'));
    assert.ok(venue.venueMotionIntensity('full') < 0.1);
});

test('prefersReducedMotion is a boolean helper', () => {
    assert.equal(typeof venue.prefersReducedMotion(), 'boolean');
});

test('index.html contains venue motion select separate from mood fx', () => {
    const html = fs.readFileSync(INDEX_HTML, 'utf8');
    assert.match(html, /id="venue-motion-select"/);
    assert.match(html, /Venue Motion/);
    assert.match(html, /id="venue-mood-fx-select"/);
    assert.match(html, /Venue Motion adds subtle background parallax only/);
});

test('STRIP_OVERLAY_ENABLED is false until real venue scene assets ship', () => {
    assert.equal(venue.STRIP_OVERLAY_ENABLED, false);
});

test('shouldShowStripOverlay is false while strip overlay is disabled', () => {
    assert.equal(venue.shouldShowStripOverlay('full', 'venue', true, true), false);
    assert.equal(venue.shouldShowStripOverlay('full', 'default', false, true), false);
});
test('shouldEnableVenueMood respects off and highway_3d', () => {
    assert.equal(venue.shouldEnableVenueMood('off', 'default', false), false);
    assert.equal(venue.shouldEnableVenueMood('subtle', 'highway_3d', false), false);
    assert.equal(venue.shouldEnableVenueMood('full', 'default', false), true);
    assert.equal(venue.shouldEnableVenueMood('full', 'venue', true), true);
    assert.equal(venue.shouldEnableVenueMood('subtle', 'auto', true), false);
    assert.equal(venue.shouldEnableVenueMood('subtle', 'auto', false), true);
});

test('isSuppressedBy3d only when plain 3D viz is active', () => {
    assert.equal(venue.isSuppressedBy3d('full', 'highway_3d', false), true);
    assert.equal(venue.isSuppressedBy3d('full', 'venue', true), false);
    assert.equal(venue.isSuppressedBy3d('full', 'default', true), false);
    assert.equal(venue.isSuppressedBy3d('off', 'highway_3d', false), false);
});

test('isElementDisplayed ignores display:none overlays', () => {
    assert.equal(venue.isElementDisplayed({ style: { display: 'none' } }), false);
    assert.equal(venue.isElementDisplayed({ style: { display: 'block' } }), true);
    assert.equal(venue.isElementDisplayed(null), false);
});

test('auto mode stays enabled when stale hidden 3D wrap exists in DOM', () => {
    assert.equal(venue.shouldEnableVenueMood('full', 'auto', false), true);
    assert.equal(venue.shouldEnableVenueMood('full', 'auto', true), false);
});

test('index.html contains venue markup and script order', () => {
    const html = fs.readFileSync(INDEX_HTML, 'utf8');
    assert.match(html, /id="v3-venue-mood-fx"/);
    assert.match(html, /class="venue-mood-lights"/);
    assert.match(html, /class="venue-mood-crowd"/);
    assert.match(html, /class="venue-mood-haze"/);
    assert.match(html, /id="venue-mood-fx-select"/);
    assert.match(html, /id="venue-motion-select"/);
    assert.match(html, /id="venue-viz-mode-hint"/);
    assert.match(html, /id="venue-mood-fx-3d-hint"/);
    assert.match(html, /id="v3-venue-mode-badge"/);
    assert.match(html, /id="v3-venue-scene-wash"/);
    assert.match(html, /venue-viz\.js/);
    const hudIdx = html.indexOf('live-performance-hud.js');
    const venueIdx = html.indexOf('venue-mood-fx.js');
    assert.ok(hudIdx !== -1 && venueIdx !== -1 && venueIdx > hudIdx);
});

test('CSS disables bottom strip and keeps transport above overlays', () => {
    const css = fs.readFileSync(V3_CSS, 'utf8');
    assert.match(css, /\.venue-mood-fx[\s\S]*display:\s*none/);
    assert.match(css, /\.venue-mood-fx[\s\S]*pointer-events:\s*none/);
    assert.match(css, /\.v3-venue-scene-wash[\s\S]*z-index:\s*3/);
    assert.match(css, /\.v3-venue-mode-badge[\s\S]*z-index:\s*18/);
    assert.match(css, /#player \.v3-transport[\s\S]*z-index:\s*20/);
});

test('CSS includes reduced-motion rule for venue animations', () => {
    const css = fs.readFileSync(V3_CSS, 'utf8');
    assert.match(css, /@media \(prefers-reduced-motion: reduce\)[\s\S]*\.venue-mood-fx/);
});

test('off setting hides venue layer via applyClasses', () => {
    class El {
        constructor() { this.className = ''; this.attrs = {}; }
        classList = {
            add: (c) => { if (!this.className.includes(c)) this.className += (this.className ? ' ' : '') + c; },
            remove: (c) => { this.className = this.className.split(/\s+/).filter((x) => x && x !== c).join(' '); },
        };
        setAttribute(k, v) { this.attrs[k] = String(v); }
    }
    const player = new El();
    const layer = new El();
    layer.classList.add('hidden');
    venue.applyClasses(player, layer, 'off', 'fire', false);
    assert.match(player.className, /venue-mood-off/);
    assert.match(player.className, /venue-mood-state-fire/);
    assert.match(layer.className, /hidden/);
});

test('applyClasses can still unhide layer when strip overlay is explicitly enabled', () => {
    class El {
        constructor() { this.className = ''; this.attrs = {}; }
        classList = {
            add: (c) => { if (!this.className.includes(c)) this.className += (this.className ? ' ' : '') + c; },
            remove: (c) => { this.className = this.className.split(/\s+/).filter((x) => x && x !== c).join(' '); },
        };
        setAttribute(k, v) { this.attrs[k] = String(v); }
    }
    const player = new El();
    const layer = new El();
    layer.classList.add('hidden');
    venue.applyClasses(player, layer, 'full', 'idle', true);
    assert.match(player.className, /venue-mood-full/);
    assert.equal(layer.className.includes('hidden'), false);
});

test('event integration still applies mood state classes without showing strip', () => {
    class El {
        constructor() { this.className = ''; this.attrs = {}; }
        classList = {
            add: (c) => { if (!this.className.includes(c)) this.className += (this.className ? ' ' : '') + c; },
            remove: (c) => { this.className = this.className.split(/\s+/).filter((x) => x && x !== c).join(' '); },
        };
        setAttribute(k, v) { this.attrs[k] = String(v); }
    }

    const listeners = new Map();
    const sm = {
        on(event, fn) {
            const list = listeners.get(event) || [];
            list.push(fn);
            listeners.set(event, list);
        },
        emit(event, detail) {
            (listeners.get(event) || []).forEach((fn) => fn({ detail }));
        },
    };

    const player = new El();
    const layer = new El();
    const runtime = venue.bindRuntime(sm, { player, layer });
    runtime.beginSession();

    sm.emit('v3:live-performance-state', {
        hits: 95,
        misses: 5,
        judged: 100,
        streak: 12,
        bestStreak: 12,
        accuracyPct: 95,
        state: 'fire',
    });

    assert.match(player.className, /venue-mood-state-fire/);
    assert.match(layer.className, /venue-mood-state-fire/);
    assert.equal(layer.className.includes('hidden'), true);
    assert.equal(runtime.getCurrentState(), 'fire');
});

test('smoke state applies smoke classes on layer', () => {
    class El {
        constructor() { this.className = ''; this.attrs = {}; }
        classList = {
            add: (c) => { if (!this.className.includes(c)) this.className += (this.className ? ' ' : '') + c; },
            remove: (c) => { this.className = this.className.split(/\s+/).filter((x) => x && x !== c).join(' '); },
        };
        setAttribute(k, v) { this.attrs[k] = String(v); }
    }
    const listeners = new Map();
    const sm = {
        on(event, fn) {
            const list = listeners.get(event) || [];
            list.push(fn);
            listeners.set(event, list);
        },
        emit(event, detail) {
            (listeners.get(event) || []).forEach((fn) => fn({ detail }));
        },
    };
    const player = new El();
    const layer = new El();
    const runtime = venue.bindRuntime(sm, { player, layer });
    runtime.beginSession();
    sm.emit('v3:live-performance-state', { state: 'smoke', hits: 1, misses: 9, judged: 10, streak: 0, bestStreak: 0, accuracyPct: 10 });
    assert.match(player.className, /venue-mood-state-smoke/);
    assert.match(layer.className, /venue-mood-state-smoke/);
});

test('3D suppression clears when viz mode returns to default or venue', () => {
    assert.equal(venue.shouldEnableVenueMood('full', 'highway_3d', false), false);
    assert.equal(venue.shouldEnableVenueMood('full', 'default', false), true);
    assert.equal(venue.shouldEnableVenueMood('full', 'venue', true), true);
    assert.equal(venue.shouldEnableVenueMood('full', 'auto', false), true);
});

test('venue visualization session hides strip and marks scene pending', () => {
    class El {
        constructor() { this.className = ''; this.attrs = {}; this.value = 'venue'; this.dataset = {}; }
        classList = {
            add: (c) => { if (!this.className.includes(c)) this.className += (this.className ? ' ' : '') + c; },
            remove: (c) => { this.className = this.className.split(/\s+/).filter((x) => x && x !== c).join(' '); },
            toggle: (c, force) => {
                const has = this.className.split(/\s+/).includes(c);
                const on = force === undefined ? !has : !!force;
                if (on && !has) this.classList.add(c);
                else if (!on && has) this.classList.remove(c);
            },
        };
        setAttribute(k, v) { this.attrs[k] = String(v); }
        addEventListener() {}
    }
    const listeners = new Map();
    const sm = {
        on(event, fn) {
            const list = listeners.get(event) || [];
            list.push(fn);
            listeners.set(event, list);
        },
        emit(event, detail) {
            (listeners.get(event) || []).forEach((fn) => fn({ detail }));
        },
    };
    const player = new El();
    const layer = new El();
    const hintVenue = new El();
    hintVenue.classList.add('hidden');
    const hint3d = new El();
    hint3d.classList.add('hidden');
    const badge = new El();
    badge.classList.add('hidden');
    const sceneWash = new El();
    sceneWash.classList.add('hidden');
    const vizPicker = new El();
    vizPicker.value = 'venue';
    const storage = new Map([['feedBack-venue-mood-fx', 'full']]);
    const origDocument = global.document;
    global.document = {
        getElementById(id) {
            if (id === 'viz-picker') return vizPicker;
            if (id === 'venue-mood-fx-select') return null;
            return null;
        },
        querySelectorAll() {
            return [{ style: { display: 'block' } }];
        },
    };
    global.localStorage = {
        getItem(k) { return storage.has(k) ? storage.get(k) : null; },
        setItem(k, v) { storage.set(k, String(v)); },
    };
    try {
        const runtime = venue.bindRuntime(sm, { player, layer, hintVenue, hint3d, badge, sceneWash });
        runtime.beginSession();
        const st = runtime.getState();
        assert.equal(st.isVenueVisualization, true);
        assert.equal(st.visible, false);
        assert.equal(st.venueScenePending, true);
        assert.equal(layer.className.includes('hidden'), true);
        assert.match(player.className, /is-venue-visualization/);
        assert.match(player.className, /venue-scene-pending/);
        assert.equal(hintVenue.className.includes('hidden'), false);
        // V2: no DOM placeholder badge during Venue playback
        assert.equal(badge.className.includes('hidden'), true);
        assert.equal(sceneWash.className.includes('hidden'), true);
    } finally {
        global.document = origDocument;
        delete global.localStorage;
    }
});

test('plain 3D highway does not show venue placeholder', () => {
    class El {
        constructor() { this.className = 'hidden'; this.value = 'highway_3d'; this.dataset = {}; }
        classList = {
            add: (c) => { if (!this.className.includes(c)) this.className += (this.className ? ' ' : '') + c; },
            remove: (c) => { this.className = this.className.split(/\s+/).filter((x) => x && x !== c).join(' '); },
            toggle: (c, force) => {
                const has = this.className.split(/\s+/).includes(c);
                const on = force === undefined ? !has : !!force;
                if (on && !has) this.classList.add(c);
                else if (!on && has) this.classList.remove(c);
            },
        };
        setAttribute() {}
        addEventListener() {}
    }
    const listeners = new Map();
    const sm = {
        on(event, fn) {
            const list = listeners.get(event) || [];
            list.push(fn);
            listeners.set(event, list);
        },
    };
    const player = new El();
    const layer = new El();
    const badge = new El();
    badge.classList.add('hidden');
    const sceneWash = new El();
    sceneWash.classList.add('hidden');
    const vizPicker = new El();
    vizPicker.value = 'highway_3d';
    const origDocument = global.document;
    global.document = {
        getElementById(id) {
            if (id === 'viz-picker') return vizPicker;
            return null;
        },
        querySelectorAll() { return []; },
    };
    global.localStorage = {
        getItem() { return 'full'; },
        setItem() {},
    };
    try {
        const runtime = venue.bindRuntime(sm, { player, layer, badge, sceneWash });
        runtime.refreshVisibility();
        assert.equal(player.className.includes('is-venue-visualization'), false);
        assert.match(badge.className, /hidden/);
        assert.match(sceneWash.className, /hidden/);
        assert.equal(runtime.getState().isVenueVisualization, false);
    } finally {
        global.document = origDocument;
        delete global.localStorage;
    }
});

test('runtime listens for viz renderer events to refresh visibility', () => {
    const source = fs.readFileSync(path.join(__dirname, '..', '..', 'static', 'v3', 'venue-mood-fx.js'), 'utf8');
    assert.match(source, /sm\.on\('viz:renderer:ready', refreshVisibility\)/);
    assert.match(source, /sm\.on\('viz:reverted', refreshVisibility\)/);
});

test('window.v3VenueMoodFx exposes getState with venue flag', () => {
    assert.equal(typeof venue.getState, 'function');
    const st = venue.getState();
    assert.equal(typeof st.setting, 'string');
    assert.equal(typeof st.enabled, 'boolean');
    assert.equal(typeof st.suppressedBy3d, 'boolean');
    assert.equal(typeof st.isVenueVisualization, 'boolean');
});

test('setMotion persists feedBack-venue-motion and syncs renderer', () => {
    const storage = new Map();
    let synced = null;
    global.localStorage = {
        getItem(k) { return storage.has(k) ? storage.get(k) : null; },
        setItem(k, v) { storage.set(k, String(v)); },
    };
    globalThis.h3dVenueSceneSetMotionMode = (mode) => { synced = mode; };
    const origDocument = global.document;
    global.document = { getElementById: () => null };
    try {
        assert.equal(venue.setMotion('full'), 'full');
        assert.equal(storage.get('feedBack-venue-motion'), 'full');
        assert.equal(synced, 'full');
        assert.equal(venue.setMotion('nope'), 'subtle');
        assert.equal(synced, 'subtle');
    } finally {
        global.document = origDocument;
        delete global.localStorage;
        delete globalThis.h3dVenueSceneSetMotionMode;
    }
});

test('bindRuntime wires venue motion select', () => {
    class El {
        constructor() { this.className = ''; this.attrs = {}; this.value = ''; this.dataset = {}; }
        classList = {
            add: (c) => { if (!this.className.includes(c)) this.className += (this.className ? ' ' : '') + c; },
            remove: (c) => { this.className = this.className.split(/\s+/).filter((x) => x && x !== c).join(' '); },
        };
        setAttribute() {}
        addEventListener(_ev, fn) { this._fn = fn; }
    }
    const listeners = new Map();
    const sm = { on(event, fn) {
        const list = listeners.get(event) || [];
        list.push(fn);
        listeners.set(event, list);
    } };
    const motionSel = new El();
    const origDocument = global.document;
    let synced = null;
    globalThis.h3dVenueSceneSetMotionMode = (mode) => { synced = mode; };
    global.localStorage = {
        getItem(k) { return k === 'feedBack-venue-motion' ? 'subtle' : null; },
        setItem() {},
    };
    global.document = {
        getElementById(id) {
            if (id === 'venue-motion-select') return motionSel;
            if (id === 'venue-mood-fx-select') return null;
            return null;
        },
        querySelectorAll() { return []; },
    };
    try {
        venue.bindRuntime(sm, { player: new El(), layer: new El() });
        assert.equal(motionSel.dataset.venueMotionBound, '1');
        assert.equal(motionSel.value, 'subtle');
        assert.equal(synced, 'subtle');
        motionSel.value = 'off';
        motionSel._fn();
        assert.equal(synced, 'off');
    } finally {
        global.document = origDocument;
        delete global.localStorage;
        delete globalThis.h3dVenueSceneSetMotionMode;
    }
});

test('song stop ends session and hides venue layer', () => {
    class El {
        constructor() { this.className = ''; this.attrs = {}; }
        classList = {
            add: (c) => { if (!this.className.includes(c)) this.className += (this.className ? ' ' : '') + c; },
            remove: (c) => { this.className = this.className.split(/\s+/).filter((x) => x && x !== c).join(' '); },
        };
        setAttribute(k, v) { this.attrs[k] = String(v); }
    }

    const listeners = new Map();
    const sm = {
        on(event, fn) {
            const list = listeners.get(event) || [];
            list.push(fn);
            listeners.set(event, list);
        },
    };

    const player = new El();
    const layer = new El();
    const runtime = venue.bindRuntime(sm, { player, layer });
    runtime.beginSession();
    assert.equal(runtime.getSessionActive(), true);

    runtime.endSession();
    assert.equal(runtime.getSessionActive(), false);
    assert.match(layer.className, /hidden/);
});
