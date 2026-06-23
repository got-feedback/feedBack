(function () {
    'use strict';

    var PLUGIN_ID = 'app_tour_settings';
    var SCREENS = ['settings'];

    function _register() {
        try {
            window.feedBackTour.register(PLUGIN_ID, { screens: SCREENS });
        } catch (e) {
            console.warn('[app_tour_settings] register failed', e);
        }
    }

    if (window.feedBackTour && typeof window.feedBackTour.register === 'function') {
        _register();
    } else {
        var deadline = performance.now() + 5000;
        var pollId = setInterval(function () {
            if (window.feedBackTour && typeof window.feedBackTour.register === 'function') {
                clearInterval(pollId);
                _register();
            } else if (performance.now() > deadline) {
                clearInterval(pollId);
            }
        }, 100);
    }

    // ── Layout nudge ──────────────────────────────────────────────────────
    // Tuner plugin parks a FAB at `fixed bottom-5 right-5` on every screen;
    // tour engine's ? button sits at bottom:12px right:12px — same corner.
    // Nudge the tour UI up when the settings screen is active.
    var NUDGE_CLASS = 'app-tour-settings-nudge';
    var STYLE_ID = 'app-tour-settings-nudge-style';

    function _ensureStyle() {
        if (document.getElementById(STYLE_ID)) return;
        var s = document.createElement('style');
        s.id = STYLE_ID;
        s.textContent =
            'body.' + NUDGE_CLASS + ' .feedBack-tour-menu-btn { bottom: 68px; }' +
            'body.' + NUDGE_CLASS + ' .feedBack-tour-menu-popover { bottom: 112px; }' +
            'body.' + NUDGE_CLASS + ' .feedBack-tour-prompt { bottom: 112px; }';
        document.head.appendChild(s);
    }

    function _applyNudge(screenId) {
        if (!document.body) return;
        document.body.classList.toggle(NUDGE_CLASS, screenId === 'settings');
    }

    function _initNudge() {
        _ensureStyle();
        var active = document.querySelector('.screen.active');
        _applyNudge(active ? active.id : null);
        if (window.feedBack && typeof window.feedBack.on === 'function') {
            window.feedBack.on('screen:changed', function (ev) {
                _applyNudge(ev && ev.detail && ev.detail.id);
            });
        }
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', _initNudge, { once: true });
    } else {
        _initNudge();
    }
})();
