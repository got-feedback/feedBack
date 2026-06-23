'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const venueViz = require('../../static/v3/venue-viz.js');
const venue = require('../../static/v3/venue-mood-fx.js');
const APP_JS = path.join(__dirname, '..', '..', 'static', 'app.js');
const INDEX_HTML = path.join(__dirname, '..', '..', 'static', 'v3', 'index.html');
const V3_CSS = path.join(__dirname, '..', '..', 'static', 'v3', 'v3.css');

test('venue-viz constants and renderer mapping', () => {
    assert.equal(venueViz.VENUE_VIZ_ID, 'venue');
    assert.equal(venueViz.RENDERER_VIZ_ID, 'highway_3d');
    assert.equal(venueViz.isVenueVisualization('venue'), true);
    assert.equal(venueViz.isVenueVisualization('highway_3d'), false);
    assert.equal(venueViz.resolveRendererVizId('venue'), 'highway_3d');
    assert.equal(venueViz.resolveRendererVizId('default'), 'default');
});

test('setSelectedVizId preserves venue while renderer maps to highway_3d', () => {
    class El {
        constructor() { this.className = 'hidden'; this.id = ''; }
        classList = {
            add: (c) => { if (!this.className.includes(c)) this.className += (this.className ? ' ' : '') + c; },
            remove: (c) => { this.className = this.className.split(/\s+/).filter((x) => x && x !== c).join(' '); },
            toggle: (c, force) => {
                const has = this.className.split(/\s+/).includes(c);
                const on = force === undefined ? !has : !!force;
                if (on && !has) this.classList.add(c);
                else if (!on && has) this.classList.remove(c);
            },
            contains: (c) => this.className.split(/\s+/).includes(c),
        };
    }
    const player = new El();
    player.id = 'player';
    const badge = new El();
    badge.id = 'v3-venue-mode-badge';
    const wash = new El();
    wash.id = 'v3-venue-scene-wash';
    const picker = new El();
    picker.id = 'viz-picker';
    picker.value = 'venue';
    const storage = new Map([['vizSelection', 'venue']]);
    const origDocument = global.document;
    global.document = {
        getElementById(id) {
            if (id === 'player') return player;
            if (id === 'v3-venue-mode-badge') return badge;
            if (id === 'v3-venue-scene-wash') return wash;
            if (id === 'viz-picker') return picker;
            return null;
        },
    };
    global.localStorage = {
        getItem(k) { return storage.has(k) ? storage.get(k) : null; },
        setItem(k, v) { storage.set(k, String(v)); },
    };
    try {
        venueViz.setSelectedVizId('venue');
        venueViz.notifyRendererInstalled('highway_3d');
        assert.equal(venueViz.getSelectedVizId(), 'venue');
        assert.equal(venueViz.resolveRendererVizId(venueViz.getSelectedVizId()), 'highway_3d');
        assert.match(player.className, /is-venue-visualization/);
        // V2: DOM placeholder badge never shown during Venue mode
        assert.equal(badge.className.includes('hidden'), true);
        assert.equal(wash.className.includes('hidden'), true);

        venueViz.setSelectedVizId('highway_3d');
        venueViz.notifyRendererInstalled('highway_3d');
        assert.equal(venueViz.getSelectedVizId(), 'highway_3d');
        assert.equal(player.className.includes('is-venue-visualization'), false);
        assert.match(badge.className, /hidden/);
    } finally {
        global.document = origDocument;
        delete global.localStorage;
        venueViz.setSelectedVizId(null);
        venueViz.notifyRendererInstalled(null);
    }
});

test('getState reports venue active with separate renderer id', () => {
    class El {
        constructor() { this.className = 'is-venue-visualization'; }
        classList = {
            contains: (c) => this.className.split(/\s+/).includes(c),
        };
    }
    const player = new El();
    const picker = { value: 'venue' };
    const storage = new Map([['vizSelection', 'venue']]);
    const origDocument = global.document;
    global.document = {
        getElementById(id) {
            if (id === 'player') return player;
            if (id === 'viz-picker') return picker;
            return null;
        },
    };
    global.localStorage = {
        getItem(k) { return storage.has(k) ? storage.get(k) : null; },
        setItem(k, v) { storage.set(k, String(v)); },
    };
    try {
        venueViz.setSelectedVizId('venue');
        venueViz.notifyRendererInstalled('highway_3d');
        const st = venueViz.getState();
        assert.equal(st.selectedViz, 'venue');
        assert.equal(st.storedVizSelection, 'venue');
        assert.equal(st.activeRendererId, 'highway_3d');
        assert.equal(st.isVenueVisualization, true);
        assert.equal(st.playerHasVenueClass, true);
        assert.equal(st.hasVenueMoodApi, false);
    } finally {
        global.document = origDocument;
        delete global.localStorage;
        venueViz.setSelectedVizId(null);
        venueViz.notifyRendererInstalled(null);
    }
});

test('index.html loads venue-viz and venue-mood-fx before venue-scene-3d', () => {
    const html = fs.readFileSync(INDEX_HTML, 'utf8');
    const vizIdx = html.indexOf('venue-viz.js');
    const sceneIdx = html.indexOf('venue-scene-3d.js');
    const moodIdx = html.indexOf('venue-mood-fx.js');
    // scene-3d's boot reads v3VenueMoodFx.getMotion() synchronously, so both
    // venue-viz and venue-mood-fx must be defined before scene-3d loads.
    assert.ok(vizIdx !== -1 && sceneIdx !== -1 && moodIdx !== -1 && vizIdx < moodIdx && moodIdx < sceneIdx);
});

test('index.html contains in-player venue placeholder markup', () => {
    const html = fs.readFileSync(INDEX_HTML, 'utf8');
    assert.match(html, /id="v3-venue-mode-badge"/);
    assert.match(html, /Venue mode — 3D scene assets coming next/);
    assert.match(html, /id="v3-venue-scene-wash"/);
});

test('app.js adds Venue visualization option and adapter', () => {
    const src = fs.readFileSync(APP_JS, 'utf8');
    assert.match(src, /function _ensureVenueVizOption/);
    assert.match(src, /opt\.value = 'venue'/);
    assert.match(src, /opt\.textContent = 'Venue'/);
    assert.match(src, /if \(id === 'venue'\)/);
    assert.match(src, /feedBackViz_highway_3d/);
    assert.match(src, /localStorage\.setItem\('vizSelection', 'venue'\)/);
    assert.match(src, /_installVizRenderer\(venueRenderer, 'highway_3d'\)/);
    assert.match(src, /onVenueVisualizationSelected/);
    assert.match(src, /setSelectedVizId/);
    assert.match(src, /notifyRendererInstalled/);
    assert.match(src, /v3VenueScene3d\.syncViz/);
});

test('venue mood enables for venue visualization, not plain 3D', () => {
    assert.equal(venue.shouldEnableVenueMood('full', 'venue', true), true);
    assert.equal(venue.isSuppressedBy3d('full', 'venue', true), false);
    assert.equal(venue.shouldEnableVenueMood('full', 'highway_3d', false), false);
    assert.equal(venue.isVenueVisualizationActive('venue'), true);
});

test('onVenueVisualizationSelected defaults mood to full only on first selection', () => {
    const storage = new Map();
    global.localStorage = {
        getItem(k) { return storage.has(k) ? storage.get(k) : null; },
        setItem(k, v) { storage.set(k, String(v)); },
        removeItem(k) { storage.delete(k); },
    };
    try {
        // No stored preference yet → default the mood to FULL.
        storage.delete('feedBack-venue-mood-fx');
        venue.onVenueVisualizationSelected();
        assert.equal(venue.get(), 'full');
        // An explicit 'subtle' choice must be preserved, not clobbered to full.
        storage.set('feedBack-venue-mood-fx', 'subtle');
        venue.onVenueVisualizationSelected();
        assert.equal(venue.get(), 'subtle');
        // 'off' likewise preserved.
        storage.set('feedBack-venue-mood-fx', 'off');
        venue.onVenueVisualizationSelected();
        assert.equal(venue.get(), 'off');
    } finally {
        delete global.localStorage;
    }
});

test('CSS defines visible venue placeholder above canvas', () => {
    const css = fs.readFileSync(V3_CSS, 'utf8');
    assert.match(css, /\.v3-venue-mode-badge/);
    assert.match(css, /\.v3-venue-scene-wash/);
    assert.match(css, /z-index:\s*18/);
    assert.match(css, /pointer-events:\s*none/);
    assert.match(css, /#player\.is-venue-visualization\.venue-scene-pending::before/);
    assert.match(css, /\.venue-mood-fx[\s\S]*display:\s*none/);
});

test('builtin viz options remain in index.html', () => {
    const html = fs.readFileSync(INDEX_HTML, 'utf8');
    assert.match(html, /value="auto"/);
    assert.match(html, /Classic 2D Highway/);
    assert.match(html, /_populateVizPicker/);
});

test('venue mood source documents strip overlay disabled', () => {
    const source = fs.readFileSync(path.join(__dirname, '..', '..', 'static', 'v3', 'venue-mood-fx.js'), 'utf8');
    assert.match(source, /STRIP_OVERLAY_ENABLED\s*=\s*false/);
    assert.match(source, /shouldShowStripOverlay/);
    assert.match(source, /v3-venue-mode-badge/);
});

test('app.js preserves plugin viz population for drum/tab/piano highways', () => {
    const src = fs.readFileSync(APP_JS, 'utf8');
    assert.match(src, /p\.type === 'visualization'/);
    assert.match(src, /feedBackViz_/);
    assert.match(src, /BUILTIN_OPT_VALUES/);
});

test('venue option remains distinct from highway_3d in app adapter', () => {
    const src = fs.readFileSync(APP_JS, 'utf8');
    assert.match(src, /if \(id === 'venue'\)/);
    assert.doesNotMatch(src, /if \(id === 'venue'\)[\s\S]{0,400}sel\.value = 'highway_3d'/);
});
