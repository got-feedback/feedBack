// v3 Settings → Accessibility: keeps the "Interface size" control in sync with
// the host `feedBack.scale` capability. The buttons/slider WRITE via inline
// `feedBack.scale.set(...)`; this module only REFLECTS current state (active
// preset, slider position, % readout) so the control mirrors the live value on
// load, on every change, and each time Settings is opened.
//
// Plain non-module script, matching the rest of static/v3/*. Null-guarded so it
// no-ops on the classic v2 page (which has no Accessibility panel).
(function () {
    'use strict';

    function sync(state) {
        if (!state) {
            var cap = window.feedBack && window.feedBack.scale;
            state = cap && typeof cap.get === 'function' ? cap.get() : null;
        }
        if (!state) return;

        var seg = document.getElementById('setting-interface-size');
        if (seg) {
            seg.querySelectorAll('.fb-seg-btn').forEach(function (b) {
                var on = Math.abs(parseFloat(b.dataset.scale) - state.value) < 0.001;
                b.classList.toggle('active', on);
                b.setAttribute('aria-pressed', on ? 'true' : 'false');
            });
        }
        var slider = document.getElementById('setting-interface-size-slider');
        if (slider && document.activeElement !== slider) {
            slider.value = String(Math.round(state.value * 100));
        }
        var val = document.getElementById('setting-interface-size-val');
        if (val) val.textContent = String(Math.round(state.value * 100));
    }

    if (window.feedBack && typeof window.feedBack.on === 'function') {
        // Fires on every set() and once on load. The bus delivers a CustomEvent,
        // so we ignore the arg and read the authoritative value via sync() → get().
        window.feedBack.on('scale:changed', function () { sync(); });
        // Re-sync when the user opens Settings (the panel may have re-rendered).
        window.feedBack.on('screen:changed', function (e) {
            var id = e && (e.detail ? e.detail.id : e.id);
            if (id === 'settings') sync();
        });
    }
    // Settings markup is static, but re-sync when settings.js signals it wired.
    document.addEventListener('v3:settings-rendered', function () { sync(); });

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', function () { sync(); }, { once: true });
    } else {
        sync();
    }

    window.feedBackInterfaceSize = { sync: sync };
})();
