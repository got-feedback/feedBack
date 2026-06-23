'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const venueScene = require('../../static/v3/venue-scene-3d.js');
const venueViz = require('../../static/v3/venue-viz.js');
const pov = require('../../static/v3/venue-instrument-pov.js');
const APP_JS = path.join(__dirname, '..', '..', 'static', 'app.js');
const H3D_JS = path.join(__dirname, '..', '..', 'plugins', 'highway_3d', 'screen.js');
const INDEX_HTML = path.join(__dirname, '..', '..', 'static', 'v3', 'index.html');
const ASSET_DIR = path.join(__dirname, '..', '..', 'static', 'assets', 'venue', 'themes', 'small-club');

test('small-club venue scene asset files exist', () => {
    assert.ok(fs.existsSync(path.join(ASSET_DIR, 'manifest.json')));
    assert.ok(fs.existsSync(path.join(ASSET_DIR, 'bg-plate.png')));
    const manifest = JSON.parse(fs.readFileSync(path.join(ASSET_DIR, 'manifest.json'), 'utf8'));
    assert.equal(manifest.id, 'small-club');
    assert.equal(manifest.name, 'Small Club');
    assert.equal(manifest.type, 'generated-original');
    assert.equal(manifest.version, 10);
    assert.equal(manifest.assets.bgPlate, 'bg-plate.webp');
    assert.equal(manifest.assets.fallbackBgPlate, 'bg-plate.png');
    assert.equal(manifest.instrumentPlates.guitar.png, 'guitar-pov-bg.png');
    assert.equal(manifest.instrumentPlates.bass.webp, 'bass-pov-bg.webp');
    assert.equal(manifest.instrumentPlates.drums.png, 'drums-pov-bg.png');
    assert.equal(manifest.instrumentPlates.piano.png, 'piano-pov-bg.png');
    assert.equal(manifest.instrumentPlates.vocals.png, 'vocals-pov-bg.png');
    assert.equal(manifest.instrumentPlates.vocals.webp, 'vocals-pov-bg.webp');
    for (const optionalVocals of ['vocals-pov-bg.png', 'vocals-pov-bg.webp']) {
        const vocalsPath = path.join(ASSET_DIR, optionalVocals);
        if (fs.existsSync(vocalsPath)) {
            const st = fs.statSync(vocalsPath);
            assert.ok(st.isFile() && st.size > 0, `${optionalVocals} must be a non-empty file when installed`);
        }
    }
});

test('crowd SVG uses connected head-and-shoulder silhouettes', () => {
    const svg = fs.readFileSync(path.join(ASSET_DIR, 'crowd-silhouette.svg'), 'utf8');
    assert.match(svg, /crowd-silhouette/);
    assert.match(svg, /id="crowd-front-row"/);
    assert.match(svg, /id="crowd-rear-row"/);
    assert.match(svg, /class="crowd-hand"/);
    assert.doesNotMatch(svg, /<ellipse[^>]*rx=/);
    assert.doesNotMatch(svg, /class="crowd-arm"/);
    assert.doesNotMatch(svg, /class="crowd-person"/);
});

test('backdrop SVG includes club stage elements', () => {
    const svg = fs.readFileSync(path.join(ASSET_DIR, 'venue-backdrop.svg'), 'utf8');
    assert.match(svg, /id="stage-curtain"/);
    assert.match(svg, /class="speaker-stack"/);
    assert.match(svg, /id="stage-platform"/);
    assert.match(svg, /id="lighting-truss"/);
    assert.match(svg, /id="side-wall-left"/);
    assert.match(svg, /id="side-wall-right"/);
});

test('stage lights SVG uses beam shapes not soft circles', () => {
    const svg = fs.readFileSync(path.join(ASSET_DIR, 'stage-lights.svg'), 'utf8');
    assert.match(svg, /spot-beam/);
    assert.match(svg, /id="spot-beam-center"/);
    assert.doesNotMatch(svg, /<ellipse[^>]*rx=/);
});

test('highway_3d venue plate chain falls back to generic bg-plate', () => {
    const src = fs.readFileSync(H3D_JS, 'utf8');
    const chainFn = src.match(/function _venuePlateUrlChain\(pov\)\s*\{[\s\S]*?\n\s*\}/);
    assert.ok(chainFn, '_venuePlateUrlChain missing');
    assert.match(chainFn[0], /plate\.webp/);
    assert.match(chainFn[0], /plate\.png/);
    assert.match(chainFn[0], /VENUE_BG_PLATE_WEBP/);
    assert.match(chainFn[0], /VENUE_BG_PLATE_PNG/);
});

test('highway_3d venue style loads instrument POV plates with fallback', () => {
    const src = fs.readFileSync(H3D_JS, 'utf8');
    assert.match(src, /VENUE_SCENE_ASSET_BASE\s*=\s*'\/static\/assets\/venue\/themes\/small-club\/'/);
    assert.match(src, /VENUE_INSTRUMENT_PLATES/);
    assert.match(src, /guitar-pov-bg\.png/);
    assert.match(src, /bass-pov-bg\.png/);
    assert.match(src, /drums-pov-bg\.png/);
    assert.match(src, /piano-pov-bg\.png/);
    assert.match(src, /vocals-pov-bg\.png/);
    assert.match(src, /karaoke|vocal|vocals/);
    assert.match(src, /VENUE_BG_PLATE_PNG\s*=\s*'bg-plate\.png'/);
    assert.match(src, /VENUE_BG_PLATE_WEBP\s*=\s*'bg-plate\.webp'/);
    assert.match(src, /_venuePlateUrlChain/);
    assert.match(src, /_venueLoadPlateForPov/);
    assert.match(src, /_venueTextureCache/);
    assert.match(src, /h3dVenueSceneSetInstrumentPov/);
    assert.match(src, /venue:\s*\{/);
    assert.match(src, /h3dVenueSceneSetActive/);
    assert.match(src, /h3dVenueSceneSetMood/);
    assert.match(src, /_bgEffectiveStyleId/);
    const venueBlock = src.match(/venue:\s*\{[\s\S]*?teardown\(s\)\s*\{[\s\S]*?\},\s*\n\s*\},/);
    assert.ok(venueBlock, 'venue style block missing');
    assert.match(venueBlock[0], /_venueLoadPlateForPov/);
    assert.doesNotMatch(venueBlock[0], /venue-backdrop\.svg/);
    assert.match(src, /VENUE_HAZE_STEADY\s*=\s*0\.008/);
});

test('plain 3D image style does not load venue POV plate', () => {
    const src = fs.readFileSync(H3D_JS, 'utf8');
    const imageBlock = src.match(/image:\s*\{[\s\S]*?teardown\(s\)/);
    assert.ok(imageBlock, 'image style block missing');
    assert.doesNotMatch(imageBlock[0], /guitar-pov-bg/);
    assert.doesNotMatch(imageBlock[0], /_venueLoadPlateForPov/);
});

test('venue-scene-3d syncs instrument POV from arrangement signal', () => {
    global.h3dVenueSceneSetActive = () => {};
    global.h3dVenueSceneSetMood = () => {};
    global.h3dVenueSceneSetInstrumentPov = (input) => { global._venuePovInput = input; };
    global.h3dVenueSceneGetState = () => ({});
    global.highway = { getSongInfo: () => ({ arrangement: 'Bass' }) };
    global.v3VenueViz = venueViz;
    global.v3VenueInstrumentPov = pov;
    global.feedBack = { on() {} };
    try {
        venueScene.activate();
        assert.equal(global._venuePovInput, 'Bass');
        assert.equal(venueScene.getState().instrumentPov, 'bass');
        global.highway.getSongInfo = () => ({ arrangement: 'Drums' });
        venueScene.syncInstrumentPov();
        assert.equal(global._venuePovInput, 'Drums');
        global.highway.getSongInfo = () => ({ arrangement: 'Vocals' });
        venueScene.syncInstrumentPov();
        assert.equal(global._venuePovInput, 'Vocals');
        assert.equal(venueScene.getState().instrumentPov, 'vocals');
    } finally {
        venueScene.deactivate();
        delete global.h3dVenueSceneSetActive;
        delete global.h3dVenueSceneSetMood;
        delete global.h3dVenueSceneSetInstrumentPov;
        delete global.h3dVenueSceneGetState;
        delete global.highway;
        delete global.v3VenueViz;
        delete global.v3VenueInstrumentPov;
        delete global.feedBack;
        delete global._venuePovInput;
    }
});

test('lyrics visibility during guitar practice does not force vocals POV', () => {
    global.h3dVenueSceneSetActive = () => {};
    global.h3dVenueSceneSetMood = () => {};
    global.h3dVenueSceneSetInstrumentPov = (input) => { global._venuePovInput = input; };
    global.h3dVenueSceneGetState = () => ({});
    global.highway = {
        getSongInfo: () => ({ arrangement: 'Lead' }),
        getLyricsVisible: () => true,
    };
    global.v3VenueViz = venueViz;
    global.v3VenueInstrumentPov = pov;
    global.feedBack = { on() {} };
    try {
        venueScene.activate();
        assert.equal(global._venuePovInput, 'Lead');
        assert.equal(venueScene.getState().instrumentPov, 'guitar');
        assert.equal(pov.resolveVenueInstrumentPov(global._venuePovInput), 'guitar');
        const src = fs.readFileSync(path.join(__dirname, '..', '..', 'static', 'v3', 'venue-scene-3d.js'), 'utf8');
        const codeOnly = src.replace(/\/\/[^\n]*/g, '');
        assert.doesNotMatch(codeOnly, /\.getLyricsVisible\s*\(/);
    } finally {
        venueScene.deactivate();
        delete global.h3dVenueSceneSetActive;
        delete global.h3dVenueSceneSetMood;
        delete global.h3dVenueSceneSetInstrumentPov;
        delete global.h3dVenueSceneGetState;
        delete global.highway;
        delete global.v3VenueViz;
        delete global.v3VenueInstrumentPov;
        delete global.feedBack;
        delete global._venuePovInput;
    }
});

test('venue-scene-3d exports bg plate asset ids', () => {
    assert.equal(venueScene.BG_PLATE, 'bg-plate.png');
    assert.equal(venueScene.BG_PLATE_WEBP, 'bg-plate.webp');
    assert.equal(venueScene.ASSET_BASE, '/static/assets/venue/themes/small-club/');
});

test('app.js syncs venue 3D scene on viz changes', () => {
    const src = fs.readFileSync(APP_JS, 'utf8');
    assert.match(src, /v3VenueScene3d\.syncViz\('venue'\)/);
    assert.match(src, /v3VenueScene3d\.syncViz\(id\)/);
});

test('index.html loads venue deps before venue-scene-3d', () => {
    const html = fs.readFileSync(INDEX_HTML, 'utf8');
    const povIdx = html.indexOf('venue-instrument-pov.js');
    const vizIdx = html.indexOf('venue-viz.js');
    const sceneIdx = html.indexOf('venue-scene-3d.js');
    const moodIdx = html.indexOf('venue-mood-fx.js');
    assert.ok(povIdx !== -1 && sceneIdx !== -1);
    assert.ok(povIdx < sceneIdx);
    // venue-scene-3d's boot reads window.v3VenueMoodFx.getMotion() synchronously,
    // so venue-viz and venue-mood-fx must both load before it; otherwise first
    // paint falls back to 'subtle' and ignores a saved 'off'/'full' motion pref.
    assert.ok(vizIdx < moodIdx && moodIdx < sceneIdx);
});

test('syncViz activates only for venue visualization id', () => {
    global.h3dVenueSceneSetActive = (on) => { global._h3dActive = on; };
    global.h3dVenueSceneSetMood = (s) => { global._h3dMood = s; };
    global.h3dVenueSceneSetInstrumentPov = () => {};
    global.h3dVenueSceneGetState = () => ({ active: !!global._h3dActive, assetsLoaded: false, loadFailed: false });
    global.v3VenueViz = venueViz;
    global.v3VenueInstrumentPov = pov;
    global.feedBack = { on() {} };
    try {
        venueScene.deactivate();
        venueScene.syncViz('highway_3d');
        assert.equal(global._h3dActive, false);
        venueScene.syncViz('venue');
        assert.equal(global._h3dActive, true);
        assert.equal(venueScene.getState().active, true);
        assert.equal(venueScene.getState().themeId, 'small-club');
    } finally {
        venueScene.deactivate();
        delete global.h3dVenueSceneSetActive;
        delete global.h3dVenueSceneSetMood;
        delete global.h3dVenueSceneSetInstrumentPov;
        delete global.h3dVenueSceneGetState;
        delete global.v3VenueViz;
        delete global.v3VenueInstrumentPov;
        delete global.feedBack;
        delete global._h3dActive;
        delete global._h3dMood;
    }
});

test('shouldShowDomPlaceholder stays false so badge is not shown', () => {
    global.v3VenueViz = {
        getSelectedVizId: () => 'venue',
        isVenueVisualization: (v) => v === 'venue',
        readVizSelection: () => 'venue',
    };
    try {
        venueScene.syncViz('venue');
        assert.equal(venueScene.shouldShowDomPlaceholder(), false);
        venueScene.onAssetsLoaded();
        assert.equal(venueScene.shouldShowDomPlaceholder(), false);
    } finally {
        venueScene.deactivate();
        delete global.v3VenueViz;
    }
});

test('live performance state forwards mood to highway venue scene API', () => {
    global.h3dVenueSceneSetActive = () => {};
    global.h3dVenueSceneSetMood = (s) => { global._mood = s; };
    global.h3dVenueSceneSetInstrumentPov = () => {};
    global.h3dVenueSceneGetState = () => ({});
    global.v3VenueViz = {
        getSelectedVizId: () => 'venue',
        isVenueVisualization: () => true,
        readVizSelection: () => 'venue',
    };
    global.feedBack = { on() {} };
    try {
        venueScene.activate();
        venueScene.onPerformanceState({ detail: { state: 'fire' } });
        assert.equal(global._mood, 'fire');
        venueScene.onPerformanceState({ detail: { state: 'smoke' } });
        assert.equal(global._mood, 'smoke');
    } finally {
        venueScene.deactivate();
        delete global.h3dVenueSceneSetActive;
        delete global.h3dVenueSceneSetMood;
        delete global.h3dVenueSceneSetInstrumentPov;
        delete global.h3dVenueSceneGetState;
        delete global.v3VenueViz;
        delete global.feedBack;
        delete global._mood;
    }
});

test('venue viz still maps renderer to highway_3d', () => {
    assert.equal(venueViz.resolveRendererVizId('venue'), 'highway_3d');
    assert.equal(venueViz.isVenueVisualization('highway_3d'), false);
});

test('STRIP_OVERLAY_ENABLED remains false in venue mood fx', () => {
    const venue = require('../../static/v3/venue-mood-fx.js');
    assert.equal(venue.STRIP_OVERLAY_ENABLED, false);
});

test('highway_3d venue style exposes motion APIs and background-only motion', () => {
    const src = fs.readFileSync(H3D_JS, 'utf8');
    assert.match(src, /h3dVenueSceneSetMotionMode/);
    assert.match(src, /h3dVenueSceneGetState/);
    assert.match(src, /motionMode/);
    assert.match(src, /motionEffective/);
    assert.match(src, /motionEnabled/);
    assert.match(src, /motionIntensity/);
    assert.match(src, /_venueApplyFakeDepthMotion/);
    assert.match(src, /_venueEffectiveMotionMode/);
    assert.match(src, /_venuePrefersReducedMotion/);
    assert.match(src, /function _venueApplyFakeDepthMotion[\s\S]*?return motion;\s*\n\s*\}/);
    assert.match(src, /function _venueApplyFakeDepthMotion[\s\S]*?s\.backdrop[\s\S]*?s\.haze/);
    const venueUpdate = src.match(/venue:\s*\{[\s\S]*?update\(s, bands, dt, t\)\s*\{[\s\S]*?\},\s*\n\s*teardown/);
    assert.ok(venueUpdate, 'venue update block missing');
    assert.match(venueUpdate[0], /_venueApplyFakeDepthMotion/);
    assert.doesNotMatch(venueUpdate[0], /STRIP_OVERLAY/);
});

test('off motion mode zeros profile and venue inactive forces effective off', () => {
    const src = fs.readFileSync(H3D_JS, 'utf8');
    assert.match(src, /function _venueMotionProfile[\s\S]*breathe:\s*0,\s*parallax:\s*0/);
    assert.match(src, /function _venueEffectiveMotionMode\(\)[\s\S]*!_venueSceneOverride[\s\S]*return 'off'/);
});

test('venue-scene-3d syncs motion on activate', () => {
    global.h3dVenueSceneSetActive = () => {};
    global.h3dVenueSceneSetMood = () => {};
    global.h3dVenueSceneSetInstrumentPov = () => {};
    global.h3dVenueSceneSetMotionMode = (mode) => { global._venueMotion = mode; };
    global.h3dVenueSceneGetState = () => ({});
    global.v3VenueMoodFx = { getMotion: () => 'full' };
    global.v3VenueViz = venueViz;
    global.v3VenueInstrumentPov = pov;
    global.feedBack = { on() {} };
    try {
        venueScene.activate();
        assert.equal(global._venueMotion, 'full');
        global.v3VenueMoodFx.getMotion = () => 'off';
        venueScene.syncVenueMotion();
        assert.equal(global._venueMotion, 'off');
    } finally {
        venueScene.deactivate();
        delete global.h3dVenueSceneSetActive;
        delete global.h3dVenueSceneSetMood;
        delete global.h3dVenueSceneSetInstrumentPov;
        delete global.h3dVenueSceneSetMotionMode;
        delete global.h3dVenueSceneGetState;
        delete global.v3VenueMoodFx;
        delete global.v3VenueViz;
        delete global.v3VenueInstrumentPov;
        delete global.feedBack;
        delete global._venueMotion;
    }
});

test('full motion intensity is stronger than subtle in profile table', () => {
    const venueMood = require('../../static/v3/venue-mood-fx.js');
    assert.ok(venueMood.venueMotionIntensity('full') > venueMood.venueMotionIntensity('subtle'));
    assert.equal(venueMood.venueMotionIntensity('off'), 0);
});

test('runtime safety: motion pass does not touch scoring detection timing or audio', () => {
    const venueMood = require('../../static/v3/venue-mood-fx.js');
    const forbidden = [
        'plugins/note_detection',
        'plugins/scoring',
        'static/audio',
        'AudioEngine',
        'feedBack-desktop',
    ];
    const allowedTouched = [
        'plugins/highway_3d/screen.js',
        'static/v3/venue-mood-fx.js',
        'static/v3/venue-scene-3d.js',
        'static/v3/index.html',
    ];
    for (const rel of allowedTouched) {
        assert.ok(fs.existsSync(path.join(__dirname, '..', '..', rel)), rel);
    }
    const h3d = fs.readFileSync(H3D_JS, 'utf8');
    assert.doesNotMatch(h3d, /v3-venue-mode-badge.*remove\('hidden'\)/);
    assert.equal(venueMood.STRIP_OVERLAY_ENABLED, false);
    for (const token of forbidden) {
        assert.doesNotMatch(h3d, new RegExp(token.replace(/\//g, '\\/'), 'i'));
    }
});

test('controls z-index remains above venue scene wash in CSS', () => {
    const css = fs.readFileSync(path.join(__dirname, '..', '..', 'static', 'v3', 'v3.css'), 'utf8');
    assert.match(css, /\.v3-venue-scene-wash[\s\S]*z-index:\s*3/);
    assert.match(css, /#player \.v3-transport[\s\S]*z-index:\s*20/);
});
