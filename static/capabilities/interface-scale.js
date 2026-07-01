// Core interface-scale capability — the app-wide "Interface size" preference.
//
// Owns a single user setting: a multiplier applied to the ROOT font-size, so
// the rem-based v3 chrome (menus, buttons, text, spacing) scales together. This
// is the DOM lever — it deliberately does NOT touch the gameplay highway canvas
// (which is sized in device pixels, not rem), so scaling the UI never changes
// playback resolution or FPS.
//
// It is exposed as a host read/write API on `window.feedBack.scale` so surfaces
// that can't inherit `rem` — canvas / WebGL renderers such as the note-highway
// HUD or results scorecards — can read the number via `feedBack.scale.get()`
// and follow `scale:changed`. Shape mirrors the other host capabilities (a
// frozen, versioned object) and the working-tuning read-API: synchronous
// `get()`, a `set()` mutator, and a change event that also fires once on load.
//
// The visual apply ALSO runs pre-paint from a tiny inline <head> script (see
// index.html) so there is no flash-of-reflow on load; this module is the
// authoritative owner and re-applies idempotently.
(function () {
    'use strict';
    window.feedBack = window.feedBack || {};
    if (window.feedBack.scale && window.feedBack.scale.version === 1) return;

    var STORE_KEY = 'v3-interface-scale';
    var MIN = 0.85, MAX = 1.50, DEFAULT = 1.0;
    // The named presets rendered by the Settings segmented control. Kept here so
    // the control and any consumer read the ladder from one source of truth.
    var PRESETS = [
        { step: 'small', value: 0.90 },
        { step: 'medium', value: 1.00 },
        { step: 'large', value: 1.15 },
        { step: 'x-large', value: 1.30 },
    ];

    function clamp(n) {
        n = Number(n);
        if (!isFinite(n)) return DEFAULT;
        return Math.min(MAX, Math.max(MIN, n));
    }

    function stepFor(value) {
        for (var i = 0; i < PRESETS.length; i++) {
            if (Math.abs(PRESETS[i].value - value) < 0.001) return PRESETS[i].step;
        }
        return 'custom';
    }

    function read() {
        try {
            var raw = localStorage.getItem(STORE_KEY);
            if (raw == null) return DEFAULT;
            return clamp(parseFloat(raw));
        } catch (_) { return DEFAULT; }
    }

    var current = read();

    // Apply to the DOM. The lever is a RELATIVE root font-size (a percentage of
    // the user-agent base), never a px literal — so a user who raised their
    // browser/OS base font size is respected, not silently overridden. We also
    // publish the always-present `--fb-scale` token for canvas consumers and CSS.
    function apply(value) {
        var el = document.documentElement;
        if (!el) return;
        el.style.setProperty('--fb-scale', String(value));
        // Medium (1.0) clears the inline override so default rendering is
        // byte-identical to before this feature existed (zero blast radius).
        el.style.fontSize = (Math.abs(value - 1) < 0.001) ? '' : (value * 100).toFixed(2) + '%';
    }

    function persist(value) {
        try {
            if (Math.abs(value - DEFAULT) < 0.001) localStorage.removeItem(STORE_KEY);
            else localStorage.setItem(STORE_KEY, String(value));
        } catch (_) { /* private mode */ }
    }

    function announce() {
        try {
            if (typeof window.feedBack.emit === 'function') {
                window.feedBack.emit('scale:changed', { value: current, step: stepFor(current) });
            }
        } catch (_) { /* noop */ }
    }

    // Hydrate on load (idempotent with the pre-paint inline script).
    apply(current);

    window.feedBack.scale = Object.freeze({
        version: 1,
        min: MIN,
        max: MAX,
        default: DEFAULT,
        // Synchronous — valid immediately after this module parses.
        get: function () { return { value: current, step: stepFor(current) }; },
        // A copy of the preset ladder, so a UI can render it from one source.
        presets: function () {
            return PRESETS.map(function (p) { return { step: p.step, value: p.value }; });
        },
        // Set + apply + persist + announce. Pass { persist:false } for a
        // transient preview (e.g. a live slider drag) that shouldn't be written.
        set: function (value, opts) {
            var v = clamp(value);
            current = v;
            apply(v);
            if (!opts || opts.persist !== false) persist(v);
            announce();
            return current;
        },
    });

    // Announce once after the document parses, so any listener wired during page
    // load can sync without special-casing (consumers may also just call get()).
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', announce, { once: true });
    } else {
        announce();
    }
})();
