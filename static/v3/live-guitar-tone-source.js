/*
 * fee[dB]ack v0.3.0 — live guitar tone source preference.
 *
 * Lets users who get guitar tone from external hardware (Spark LIVE, pedalboards,
 * etc.) opt out of the desktop "no internal amp loaded" monitor-mute hint.
 * Persisted in localStorage; desktop renderer reads the same key directly.
 */
(function (root) {
    'use strict';

    const KEY = 'feedBack-live-guitar-tone-source';

    const SOURCES = Object.freeze({
        INTERNAL: 'internal',
        EXTERNAL_HARDWARE: 'external_hardware',
        SPARK_CONTROL_X: 'spark_control_x',
    });

    const DEFAULT = SOURCES.INTERNAL;

    const LABELS = Object.freeze({
        [SOURCES.INTERNAL]: 'fee[dB]ack internal tone',
        [SOURCES.EXTERNAL_HARDWARE]: 'External amp / hardware pedalboard',
        [SOURCES.SPARK_CONTROL_X]: 'Spark LIVE + Spark Control X',
    });

    const HELP_TEXT =
        'Choose External/Spark if your guitar tone comes from hardware like Spark LIVE. '
        + 'fee[dB]ack will still score your playing but won\u2019t warn that no internal amp tone is loaded.';

    function normalize(value) {
        if (value === SOURCES.EXTERNAL_HARDWARE || value === SOURCES.SPARK_CONTROL_X) return value;
        return DEFAULT;
    }

    function get() {
        try { return normalize(localStorage.getItem(KEY)); } catch (_) { return DEFAULT; }
    }

    function set(value) {
        const next = normalize(value);
        try { localStorage.setItem(KEY, next); } catch (_) { /* private mode / quota */ }
        syncSelects(next);
        return next;
    }

    function shouldSuppressMonitorMuteHint(source) {
        const s = normalize(source == null ? get() : source);
        return s === SOURCES.EXTERNAL_HARDWARE || s === SOURCES.SPARK_CONTROL_X;
    }

    function syncSelects(value) {
        // Exported + required in tests; guard DOM access so set()/init() can be
        // called in a non-browser environment without throwing.
        if (typeof document === 'undefined') return;
        const v = normalize(value == null ? get() : value);
        document.querySelectorAll('[data-live-guitar-tone-source]').forEach((el) => {
            if (el && el.value !== v) el.value = v;
        });
    }

    function bindSelect(el) {
        if (!el || el.dataset.liveGuitarToneBound === '1') return;
        el.dataset.liveGuitarToneBound = '1';
        el.setAttribute('data-live-guitar-tone-source', '1');
        el.value = get();
        el.addEventListener('change', () => { set(el.value); });
    }

    function init() {
        if (typeof document === 'undefined') return;
        bindSelect(document.getElementById('setting-live-guitar-tone-source'));
        bindSelect(document.getElementById('player-live-guitar-tone-source'));
        syncSelects();
    }

    const api = {
        KEY,
        SOURCES,
        DEFAULT,
        LABELS,
        HELP_TEXT,
        get,
        set,
        normalize,
        shouldSuppressMonitorMuteHint,
        init,
    };

    if (root) root.v3LiveGuitarToneSource = api;

    if (typeof module !== 'undefined' && module.exports) {
        module.exports = api;
    }

    if (typeof document !== 'undefined') {
        if (document.readyState === 'loading') {
            document.addEventListener('DOMContentLoaded', init);
        } else {
            init();
        }
    }
}(typeof window !== 'undefined' ? window : null));
