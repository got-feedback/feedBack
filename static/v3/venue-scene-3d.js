/*
 * fee[dB]ack v0.3.0 — Venue 3D scene bridge.
 *
 * Activates the highway_3d `venue` background style when Visualization = Venue.
 * Reacts to v3:live-performance-state for lighting mood (read-only).
 */
(function (root) {
    'use strict';

    const THEME_ID = 'small-club';
    const ASSET_BASE = '/static/assets/venue/themes/small-club/';
    const BG_PLATE = 'bg-plate.png';
    const BG_PLATE_WEBP = 'bg-plate.webp';

    let _active = false;
    let _assetsLoaded = false;
    let _loadFailed = false;
    let _lastMood = 'idle';
    let _bound = false;

    function isVenueViz() {
        if (root && root.v3VenueViz && typeof root.v3VenueViz.isVenueVisualization === 'function') {
            const sel = root.v3VenueViz.getSelectedVizId
                ? root.v3VenueViz.getSelectedVizId()
                : root.v3VenueViz.readVizSelection();
            return root.v3VenueViz.isVenueVisualization(sel);
        }
        try {
            const sel = document.getElementById('viz-picker');
            if (sel && sel.value) return String(sel.value) === 'venue';
            return localStorage.getItem('vizSelection') === 'venue';
        } catch (_) {
            return false;
        }
    }

    function h3dApi(name) {
        return root && typeof root[name] === 'function' ? root[name] : null;
    }

    function setH3dActive(on) {
        const fn = h3dApi('h3dVenueSceneSetActive');
        if (fn) fn(!!on);
    }

    function setH3dMood(state) {
        const fn = h3dApi('h3dVenueSceneSetMood');
        if (fn) fn(state);
    }

    function readH3dState() {
        const fn = h3dApi('h3dVenueSceneGetState');
        return fn ? fn() : null;
    }

    function syncPlaceholderVisibility() {
        try {
            if (root && root.v3VenueViz && typeof root.v3VenueViz.syncPlayerVizClass === 'function') {
                const id = root.v3VenueViz.getSelectedVizId
                    ? root.v3VenueViz.getSelectedVizId()
                    : root.v3VenueViz.readVizSelection();
                root.v3VenueViz.syncPlayerVizClass(id);
            }
        } catch (_) { /* visual-only */ }
        try {
            if (root && root.v3VenueMoodFx && typeof root.v3VenueMoodFx.onVenueVisualizationSelected === 'function' &&
                isVenueViz()) {
                root.v3VenueMoodFx.onVenueVisualizationSelected();
            }
        } catch (_) { /* visual-only */ }
    }

    function readArrangementSignal() {
        // Intentional karaoke/vocals signal: active arrangement name from the
        // highway WS (user selected Vocals in #arr-select). Do NOT use
        // highway.getLyricsVisible() — lyrics overlay stays on during normal
        // guitar practice and must not force vocals POV.
        try {
            const si = root.highway && typeof root.highway.getSongInfo === 'function'
                ? root.highway.getSongInfo()
                : null;
            if (si && si.arrangement) return si.arrangement;
            const cs = root.feedBack && root.feedBack.currentSong;
            if (cs && cs.arrangement) return cs.arrangement;
            if (cs && cs.arrangementSmartName) return cs.arrangementSmartName;
        } catch (_) { /* visual-only */ }
        return '';
    }

    function syncInstrumentPov() {
        const fn = h3dApi('h3dVenueSceneSetInstrumentPov');
        if (fn) fn(readArrangementSignal());
    }

    function activate() {
        if (_active) {
            syncInstrumentPov();
            syncVenueMotion();
            return;
        }
        _active = true;
        _assetsLoaded = false;
        _loadFailed = false;
        setH3dActive(true);
        setH3dMood(_lastMood);
        syncInstrumentPov();
        syncVenueMotion();
    }

    function syncVenueMotion() {
        const motionApi = root && root.v3VenueMoodFx;
        const mode = motionApi && typeof motionApi.getMotion === 'function'
            ? motionApi.getMotion()
            : 'subtle';
        const fn = h3dApi('h3dVenueSceneSetMotionMode');
        if (fn) fn(mode);
        else if (motionApi && typeof motionApi.syncMotionToRenderer === 'function') {
            motionApi.syncMotionToRenderer(mode);
        }
    }

    function deactivate() {
        if (!_active) {
            setH3dActive(false);
            return;
        }
        _active = false;
        _assetsLoaded = false;
        _loadFailed = false;
        setH3dActive(false);
        syncPlaceholderVisibility();
    }

    function syncViz(vizId) {
        const id = String(vizId || '');
        if (id === 'venue') {
            activate();
        } else {
            deactivate();
        }
    }

    function onPerformanceState(e) {
        if (!_active) return;
        const d = (e && e.detail) || {};
        const state = String(d.state || 'idle').toLowerCase();
        // v3:live-performance-state fires per note hit/miss; skip the renderer
        // push when the mood is unchanged (e.g. a run of hits all in 'fire').
        if (state === _lastMood) return;
        _lastMood = state;
        setH3dMood(state);
    }

    function onAssetsLoaded() {
        _assetsLoaded = true;
        _loadFailed = false;
        syncPlaceholderVisibility();
    }

    function onAssetsFailed() {
        _loadFailed = true;
        _assetsLoaded = false;
        syncPlaceholderVisibility();
    }

    function bindRuntime() {
        if (_bound) return;
        _bound = true;
        const sm = root && root.feedBack;
        if (sm && typeof sm.on === 'function') {
            sm.on('v3:live-performance-state', onPerformanceState);
            sm.on('song:loaded', () => {
                if (_active) syncInstrumentPov();
            });
            sm.on('arrangement:changed', () => {
                if (_active) syncInstrumentPov();
            });
            sm.on('song:arrangement-changed', () => {
                if (_active) syncInstrumentPov();
            });
            sm.on('viz:renderer:ready', () => {
                if (isVenueViz()) activate();
                else deactivate();
            });
            sm.on('viz:reverted', () => deactivate());
        }
        if (isVenueViz()) activate();
    }

    function getState() {
        const h3d = readH3dState();
        const povApi = root && root.v3VenueInstrumentPov;
        const arrangement = readArrangementSignal();
        const instrumentPov = povApi && typeof povApi.resolveVenueInstrumentPov === 'function'
            ? povApi.resolveVenueInstrumentPov(arrangement)
            : 'guitar';
        return {
            active: _active,
            themeId: THEME_ID,
            assetBase: ASSET_BASE,
            arrangement,
            instrumentPov,
            assetsLoaded: _assetsLoaded || !!(h3d && h3d.assetsLoaded),
            loadFailed: _loadFailed || !!(h3d && h3d.loadFailed),
            mood: _lastMood,
            h3dVenueState: h3d,
            isVenueViz: isVenueViz(),
        };
    }

    function shouldShowDomPlaceholder() {
        // V2: no on-screen construction badge during Venue playback.
        return false;
    }

    const api = {
        THEME_ID,
        ASSET_BASE,
        BG_PLATE,
        BG_PLATE_WEBP,
        activate,
        deactivate,
        syncViz,
        onAssetsLoaded,
        onAssetsFailed,
        onPerformanceState,
        bindRuntime,
        getState,
        syncInstrumentPov,
        syncVenueMotion,
        readArrangementSignal,
        shouldShowDomPlaceholder,
        isSceneLoaded: () => {
            if (_assetsLoaded) return true;
            const h3d = readH3dState();
            return !!(h3d && h3d.assetsLoaded);
        },
    };

    if (root) root.v3VenueScene3d = api;
    if (typeof module !== 'undefined' && module.exports) module.exports = api;

    if (typeof document !== 'undefined') {
        const boot = () => bindRuntime();
        if (document.readyState === 'loading') {
            document.addEventListener('DOMContentLoaded', boot);
        } else {
            boot();
        }
    }
}(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : null)));
