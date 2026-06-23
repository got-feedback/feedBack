/*
 * fee[dB]ack v0.3.0 — Venue Mood FX (visual-only reactive stage/crowd).
 *
 * Phase 1: bottom CSS crowd strip is disabled until real venue scene assets
 * ship inside highway_3d. Venue visualization still maps to 3D Highway; a
 * subtle full-screen wash + hint text only.
 *
 * Subscribes to v3:live-performance-state from the Live Performance HUD.
 */
(function (root) {
    'use strict';

    const KEY = 'feedBack-venue-mood-fx';
    const MOTION_KEY = 'feedBack-venue-motion';
    const SETTINGS = Object.freeze({ OFF: 'off', SUBTLE: 'subtle', FULL: 'full' });
    const DEFAULT = SETTINGS.SUBTLE;
    const MOTION_DEFAULT = SETTINGS.SUBTLE;
    const VENUE_VIZ_ID = 'venue';
    // Bottom blob/crowd DOM strip — off until asset-based 3D venue scene lands.
    const STRIP_OVERLAY_ENABLED = false;

    function isVenueVisualizationActive(vizMode) {
        if (root && root.v3VenueViz && typeof root.v3VenueViz.isVenueVisualization === 'function') {
            return root.v3VenueViz.isVenueVisualization(vizMode);
        }
        return String(vizMode || '') === VENUE_VIZ_ID;
    }

    const MOOD_SETTING_CLASSES = ['venue-mood-off', 'venue-mood-subtle', 'venue-mood-full'];
    const MOOD_STATE_CLASSES = [
        'venue-mood-state-idle',
        'venue-mood-state-steady',
        'venue-mood-state-strong',
        'venue-mood-state-fire',
        'venue-mood-state-recovery',
        'venue-mood-state-smoke',
    ];
    const MOOD_STATE_IDS = ['idle', 'steady', 'strong', 'fire', 'recovery', 'smoke'];

    function normalizeVenueMoodSetting(value) {
        if (value === SETTINGS.OFF || value === SETTINGS.FULL) return value;
        if (value === SETTINGS.SUBTLE) return SETTINGS.SUBTLE;
        return DEFAULT;
    }

    function normalizeVenueMotionSetting(value) {
        return normalizeVenueMoodSetting(value);
    }

    function venueMotionProfile(mode) {
        const m = normalizeVenueMotionSetting(mode);
        if (m === SETTINGS.OFF) {
            return Object.freeze({
                breathe: 0, parallax: 0, hazeDrift: 0, warmthPulse: 0, shimmer: 0,
            });
        }
        if (m === SETTINGS.FULL) {
            return Object.freeze({
                breathe: 0.014, parallax: 0.010, hazeDrift: 0.020, warmthPulse: 0.028, shimmer: 0.10,
            });
        }
        return Object.freeze({
            breathe: 0.005, parallax: 0.004, hazeDrift: 0.007, warmthPulse: 0.010, shimmer: 0.04,
        });
    }

    function venueMotionIntensity(mode) {
        const profile = venueMotionProfile(mode);
        return profile.breathe + profile.parallax + profile.hazeDrift;
    }

    function prefersReducedMotion() {
        if (typeof window === 'undefined' || !window.matchMedia) return false;
        try { return window.matchMedia('(prefers-reduced-motion: reduce)').matches; } catch (_) { return false; }
    }

    function venueMoodClassForState(state) {
        const s = String(state || 'idle').toLowerCase();
        return MOOD_STATE_IDS.includes(s) ? 'venue-mood-state-' + s : 'venue-mood-state-idle';
    }

    function readVizMode() {
        try {
            if (root && root.v3VenueViz && typeof root.v3VenueViz.getSelectedVizId === 'function') {
                return String(root.v3VenueViz.getSelectedVizId());
            }
            const sel = typeof document !== 'undefined' ? document.getElementById('viz-picker') : null;
            if (sel && sel.value) return String(sel.value);
            return localStorage.getItem('vizSelection') || 'default';
        } catch (_) {
            return 'default';
        }
    }

    function isElementDisplayed(el) {
        if (!el) return false;
        try {
            if (typeof window !== 'undefined' && typeof window.getComputedStyle === 'function') {
                const style = window.getComputedStyle(el);
                if (style.display === 'none' || style.visibility === 'hidden') return false;
                if (parseFloat(style.opacity) === 0) return false;
            } else if (el.style && el.style.display === 'none') {
                return false;
            }
            return true;
        } catch (_) {
            return false;
        }
    }

    function hasVisible3dWrap() {
        try {
            if (typeof document === 'undefined') return false;
            const wraps = document.querySelectorAll('.h3d-wrap[data-h3d-primary], .h3d-wrap');
            for (let i = 0; i < wraps.length; i++) {
                if (isElementDisplayed(wraps[i])) return true;
            }
            return false;
        } catch (_) {
            return false;
        }
    }

    // Back-compat alias — only counts a wrap that is actually displayed.
    function hasActive3dWrap() {
        return hasVisible3dWrap();
    }

    function isSuppressedBy3d(setting, vizMode, has3dWrap) {
        if (normalizeVenueMoodSetting(setting) === SETTINGS.OFF) return false;
        if (isVenueVisualizationActive(vizMode)) return false;
        const viz = String(vizMode || 'default');
        if (viz === 'highway_3d') return true;
        if (viz === 'auto' && has3dWrap) return true;
        return false;
    }

    function shouldShowStripOverlay(setting, vizMode, has3dWrap, sessionActive) {
        if (!STRIP_OVERLAY_ENABLED) return false;
        if (!sessionActive) return false;
        return shouldEnableVenueMood(setting, vizMode, has3dWrap);
    }

    function shouldEnableVenueMood(setting, vizMode, has3dWrap) {
        if (normalizeVenueMoodSetting(setting) === SETTINGS.OFF) return false;
        return !isSuppressedBy3d(setting, vizMode, has3dWrap);
    }

    function get() {
        try { return normalizeVenueMoodSetting(localStorage.getItem(KEY)); } catch (_) { return DEFAULT; }
    }

    // True once the user (or a prior session) has persisted a mood preference.
    // DEFAULT is 'subtle', so get() can't distinguish "never set" from an
    // explicit 'subtle' — read the raw key to tell them apart.
    function hasStoredMoodSetting() {
        try { return localStorage.getItem(KEY) != null; } catch (_) { return false; }
    }

    function getMotion() {
        try { return normalizeVenueMotionSetting(localStorage.getItem(MOTION_KEY)); } catch (_) { return MOTION_DEFAULT; }
    }

    function set(value) {
        const next = normalizeVenueMoodSetting(value);
        try { localStorage.setItem(KEY, next); } catch (_) { /* private mode / quota */ }
        const sel = typeof document !== 'undefined' ? document.getElementById('venue-mood-fx-select') : null;
        if (sel && sel.value !== next) sel.value = next;
        return next;
    }

    function setMotion(value) {
        const next = normalizeVenueMotionSetting(value);
        try { localStorage.setItem(MOTION_KEY, next); } catch (_) { /* private mode / quota */ }
        const sel = typeof document !== 'undefined' ? document.getElementById('venue-motion-select') : null;
        if (sel && sel.value !== next) sel.value = next;
        syncMotionToRenderer(next);
        return next;
    }

    function syncMotionToRenderer(mode) {
        const next = normalizeVenueMotionSetting(mode != null ? mode : getMotion());
        const host = (typeof window !== 'undefined' && window)
            || (typeof globalThis !== 'undefined' && globalThis)
            || root;
        if (host && typeof host.h3dVenueSceneSetMotionMode === 'function') {
            host.h3dVenueSceneSetMotionMode(next);
        }
    }

    function applyClasses(player, layer, setting, state, visible) {
        if (!player || !player.classList) return;
        MOOD_SETTING_CLASSES.forEach((c) => player.classList.remove(c));
        MOOD_STATE_CLASSES.forEach((c) => player.classList.remove(c));
        player.classList.add('venue-mood-' + normalizeVenueMoodSetting(setting));
        player.classList.add(venueMoodClassForState(state));

        if (layer && layer.classList) {
            MOOD_STATE_CLASSES.forEach((c) => layer.classList.remove(c));
            layer.classList.add(venueMoodClassForState(state));
            if (visible) {
                layer.classList.remove('hidden');
                layer.setAttribute('aria-hidden', 'false');
            } else {
                layer.classList.add('hidden');
                layer.setAttribute('aria-hidden', 'true');
            }
        }
    }

    let _runtime = null;
    let _lastLoggedSetting = null;

    function bindRuntime(sm, dom) {
        if (!sm || typeof sm.on !== 'function') return null;

        const player = dom && dom.player
            ? dom.player
            : (typeof document !== 'undefined' ? document.getElementById('player') : null);
        const layer = dom && dom.layer
            ? dom.layer
            : (typeof document !== 'undefined' ? document.getElementById('v3-venue-mood-fx') : null);
        const hint3d = dom && dom.hint3d
            ? dom.hint3d
            : (typeof document !== 'undefined' ? document.getElementById('venue-mood-fx-3d-hint') : null);
        const hintVenue = dom && dom.hintVenue
            ? dom.hintVenue
            : (typeof document !== 'undefined' ? document.getElementById('venue-viz-mode-hint') : null);
        const hintFailed = dom && dom.hintFailed
            ? dom.hintFailed
            : (typeof document !== 'undefined' ? document.getElementById('venue-viz-load-failed-hint') : null);
        const badge = dom && dom.badge
            ? dom.badge
            : (typeof document !== 'undefined' ? document.getElementById('v3-venue-mode-badge') : null);
        const sceneWash = dom && dom.sceneWash
            ? dom.sceneWash
            : (typeof document !== 'undefined' ? document.getElementById('v3-venue-scene-wash') : null);

        let sessionActive = false;
        let currentState = 'idle';

        function updateVizHints(vizMode) {
            const isVenue = isVenueVisualizationActive(vizMode);
            const loadFailed = !!(root && root.v3VenueScene3d && typeof root.v3VenueScene3d.getState === 'function' &&
                root.v3VenueScene3d.getState().loadFailed);
            const sceneLoaded = !!(root && root.v3VenueScene3d && typeof root.v3VenueScene3d.isSceneLoaded === 'function' &&
                root.v3VenueScene3d.isSceneLoaded());
            if (hintVenue && hintVenue.classList) {
                if (isVenue && !loadFailed) hintVenue.classList.remove('hidden');
                else hintVenue.classList.add('hidden');
            }
            if (hintFailed && hintFailed.classList) {
                if (isVenue && loadFailed) hintFailed.classList.remove('hidden');
                else hintFailed.classList.add('hidden');
            }
            if (hint3d && hint3d.classList) {
                if (String(vizMode || '') === 'highway_3d') hint3d.classList.remove('hidden');
                else hint3d.classList.add('hidden');
            }
            if (sceneLoaded || loadFailed) syncVenuePlaceholder(vizMode);
        }

        function syncVenueVizPlayerClass(vizMode) {
            if (root && root.v3VenueViz && typeof root.v3VenueViz.syncPlayerVizClass === 'function') {
                root.v3VenueViz.syncPlayerVizClass(vizMode);
            } else if (player && player.classList) {
                const on = isVenueVisualizationActive(vizMode);
                if (typeof player.classList.toggle === 'function') {
                    player.classList.toggle('is-venue-visualization', on);
                } else if (on) {
                    player.classList.add('is-venue-visualization');
                } else {
                    player.classList.remove('is-venue-visualization');
                }
            }
        }

        function syncVenuePlaceholder(vizMode) {
            const isVenue = isVenueVisualizationActive(vizMode);
            const showDom = isVenue && !!(root && root.v3VenueScene3d &&
                typeof root.v3VenueScene3d.shouldShowDomPlaceholder === 'function' &&
                root.v3VenueScene3d.shouldShowDomPlaceholder());
            if (badge && badge.classList) {
                if (showDom) badge.classList.remove('hidden');
                else badge.classList.add('hidden');
            }
            if (sceneWash && sceneWash.classList) {
                if (showDom) sceneWash.classList.remove('hidden');
                else sceneWash.classList.add('hidden');
            }
        }

        function syncVenueSceneClass(vizMode) {
            if (!player || !player.classList) return;
            const pending = isVenueVisualizationActive(vizMode) && sessionActive && !STRIP_OVERLAY_ENABLED;
            if (typeof player.classList.toggle === 'function') {
                player.classList.toggle('venue-scene-pending', pending);
            } else if (pending) {
                player.classList.add('venue-scene-pending');
            } else {
                player.classList.remove('venue-scene-pending');
            }
        }

        function refreshVisibility() {
            const setting = get();
            const vizMode = readVizMode();
            const has3dWrap = hasVisible3dWrap();
            const enabled = shouldEnableVenueMood(setting, vizMode, has3dWrap);
            const showStrip = shouldShowStripOverlay(setting, vizMode, has3dWrap, sessionActive);
            applyClasses(player, layer, setting, currentState, showStrip);
            syncVenueVizPlayerClass(vizMode);
            syncVenueSceneClass(vizMode);
            syncVenuePlaceholder(vizMode);
            updateVizHints(vizMode);
            return showStrip;
        }

        function getState() {
            const setting = get();
            const vizMode = readVizMode();
            const has3dWrap = hasVisible3dWrap();
            const enabled = shouldEnableVenueMood(setting, vizMode, has3dWrap);
            const showStrip = shouldShowStripOverlay(setting, vizMode, has3dWrap, sessionActive);
            return {
                setting,
                vizMode,
                has3dWrap,
                enabled,
                sessionActive,
                visible: showStrip,
                stripOverlayEnabled: STRIP_OVERLAY_ENABLED,
                state: currentState,
                suppressedBy3d: isSuppressedBy3d(setting, vizMode, has3dWrap),
                isVenueVisualization: isVenueVisualizationActive(vizMode),
                venueScenePending: isVenueVisualizationActive(vizMode) && sessionActive && !STRIP_OVERLAY_ENABLED,
            };
        }

        function onPerformanceState(e) {
            const d = (e && e.detail) || {};
            if (!sessionActive) return;
            const next = d.state || 'idle';
            // This fires once per note hit/miss. When the mood state is unchanged
            // (e.g. a run of hits all in 'fire'), refreshVisibility would recompute
            // an identical result while forcing a style/layout recalc via
            // hasVisible3dWrap()'s getComputedStyle loop — so bail on no-op events.
            if (next === currentState) return;
            currentState = next;
            refreshVisibility();
        }

        function beginSession() {
            sessionActive = true;
            currentState = 'idle';
            refreshVisibility();
        }

        function endSession() {
            sessionActive = false;
            currentState = 'idle';
            refreshVisibility();
        }

        function onSettingChange(value) {
            const next = set(value);
            const st = getState();
            if (next !== _lastLoggedSetting) {
                _lastLoggedSetting = next;
                console.info('[venue-mood] setting=' + st.setting
                    + ' state=' + st.state
                    + ' suppressed=' + st.suppressedBy3d
                    + ' visible=' + st.visible);
            }
            refreshVisibility();
        }

        function bindMotionSelect() {
            const sel = typeof document !== 'undefined' ? document.getElementById('venue-motion-select') : null;
            if (!sel || sel.dataset.venueMotionBound === '1') return;
            sel.dataset.venueMotionBound = '1';
            sel.value = getMotion();
            sel.addEventListener('change', () => { setMotion(sel.value); });
            syncMotionToRenderer(sel.value);
        }

        function bindSelect() {
            const sel = typeof document !== 'undefined' ? document.getElementById('venue-mood-fx-select') : null;
            if (!sel || sel.dataset.venueMoodBound === '1') return;
            sel.dataset.venueMoodBound = '1';
            sel.value = get();
            sel.addEventListener('change', () => { onSettingChange(sel.value); });
        }

        function bindVizPicker() {
            const sel = typeof document !== 'undefined' ? document.getElementById('viz-picker') : null;
            if (!sel || sel.dataset.venueMoodVizBound === '1') return;
            sel.dataset.venueMoodVizBound = '1';
            sel.addEventListener('change', () => {
                // Default to FULL only the first time Venue is chosen; never
                // clobber a preference the user already set (incl. 'subtle'/'off').
                if (isVenueVisualizationActive(sel.value) && !hasStoredMoodSetting()) {
                    set(SETTINGS.FULL);
                }
                refreshVisibility();
            });
        }

        sm.on('v3:live-performance-state', onPerformanceState);
        sm.on('song:loading', beginSession);
        sm.on('song:arrangement-changed', () => {
            if (!sessionActive) return;
            currentState = 'idle';
            refreshVisibility();
        });
        sm.on('song:stop', endSession);
        sm.on('song:ended', endSession);
        sm.on('viz:renderer:ready', refreshVisibility);
        sm.on('viz:reverted', refreshVisibility);

        bindSelect();
        bindMotionSelect();
        applyClasses(player, layer, get(), 'idle', false);
        refreshVisibility();

        const runtime = {
            getSetting: get,
            setSetting: set,
            refreshVisibility,
            beginSession,
            endSession,
            onPerformanceState,
            onSettingChange,
            getSessionActive: () => sessionActive,
            getCurrentState: () => currentState,
            getState,
        };
        _runtime = runtime;
        return runtime;
    }

    function onVenueVisualizationSelected() {
        // Default the mood to FULL only on the first-ever Venue selection; once
        // the user has a stored preference (incl. an explicit 'subtle' or 'off')
        // re-entering Venue must not overwrite it.
        if (!hasStoredMoodSetting()) set(SETTINGS.FULL);
        if (_runtime && typeof _runtime.refreshVisibility === 'function') _runtime.refreshVisibility();
    }

    function getState() {
        if (_runtime && typeof _runtime.getState === 'function') return _runtime.getState();
        const setting = get();
        const vizMode = readVizMode();
        const has3dWrap = hasVisible3dWrap();
        const enabled = shouldEnableVenueMood(setting, vizMode, has3dWrap);
        return {
            setting,
            vizMode,
            has3dWrap,
            enabled,
            sessionActive: false,
            visible: false,
            stripOverlayEnabled: STRIP_OVERLAY_ENABLED,
            state: 'idle',
            suppressedBy3d: isSuppressedBy3d(setting, vizMode, has3dWrap),
            isVenueVisualization: isVenueVisualizationActive(vizMode),
            venueScenePending: false,
        };
    }

    const api = {
        KEY,
        MOTION_KEY,
        SETTINGS,
        DEFAULT,
        MOTION_DEFAULT,
        VENUE_VIZ_ID,
        STRIP_OVERLAY_ENABLED,
        MOOD_SETTING_CLASSES,
        MOOD_STATE_CLASSES,
        normalizeVenueMoodSetting,
        normalizeVenueMotionSetting,
        venueMotionProfile,
        venueMotionIntensity,
        prefersReducedMotion,
        venueMoodClassForState,
        readVizMode,
        isVenueVisualizationActive,
        isElementDisplayed,
        hasVisible3dWrap,
        hasActive3dWrap,
        isSuppressedBy3d,
        shouldEnableVenueMood,
        shouldShowStripOverlay,
        get,
        getMotion,
        set,
        setMotion,
        syncMotionToRenderer,
        applyClasses,
        bindRuntime,
        onVenueVisualizationSelected,
        getState,
    };

    if (root) root.v3VenueMoodFx = api;
    if (typeof module !== 'undefined' && module.exports) module.exports = api;

    if (typeof document !== 'undefined') {
        const boot = () => {
            const sm = root && root.feedBack;
            if (sm) bindRuntime(sm);
        };
        if (document.readyState === 'loading') {
            document.addEventListener('DOMContentLoaded', boot);
        } else {
            boot();
        }
    }
}(typeof window !== 'undefined' ? window : null));
