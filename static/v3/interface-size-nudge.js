// v3 first-run "Interface size" nudge.
//
// The Accessibility → Interface size control is the primary discovery path, but
// the exact person who needs it — someone on a large, low-DPI display (e.g. a
// 32" 1440p panel with no OS scaling) — is the one least likely to go hunting
// for it. So, ONCE, for that specific display profile, surface a gentle,
// dismissible toast that deep-links to the control. Never fires if the user has
// already touched the setting, on smaller/high-DPI displays, or more than once.
//
// Plain non-module script; degrades to a no-op without the bus, fbNotify, or DOM.
(function () {
    'use strict';

    var SEEN_KEY = 'v3-interface-size-nudged';
    var SCALE_KEY = 'v3-interface-scale';

    function alreadyHandled() {
        try {
            return localStorage.getItem(SEEN_KEY) === '1' || localStorage.getItem(SCALE_KEY) != null;
        } catch (_) { return true; }
    }

    // The target profile: a physically large viewport rendered near 1:1 (so the
    // OS isn't already enlarging things). This is the eye-strain case.
    function isLargeLowDpiDisplay() {
        var w = window.innerWidth || 0;
        var dpr = window.devicePixelRatio || 1;
        return w >= 1800 && dpr <= 1.25;
    }

    // Don't interrupt a first-run modal (e.g. profile onboarding). If one is up,
    // leave the flag UNSET so the nudge gets another chance on a later launch.
    function aModalIsOpen() {
        var dialogs = document.querySelectorAll('[role="dialog"], .fixed.inset-0');
        for (var i = 0; i < dialogs.length; i++) {
            var el = dialogs[i];
            if (el.offsetParent !== null && el.getClientRects().length) return true;
        }
        return false;
    }

    function openSetting() {
        try {
            if (typeof window.showScreen === 'function') window.showScreen('settings');
            document.querySelectorAll('#settings-tabbar .fb-tab').forEach(function (b) {
                if (b.dataset.tab === 'accessibility') b.click();
            });
        } catch (_) { /* noop */ }
    }

    function maybeNudge() {
        if (alreadyHandled()) return;
        if (!isLargeLowDpiDisplay()) return;
        if (!window.fbNotify || typeof window.fbNotify.show !== 'function') return;
        if (aModalIsOpen()) return; // try again next launch

        try { localStorage.setItem(SEEN_KEY, '1'); } catch (_) { /* private mode */ }

        var card = window.fbNotify.show({
            title: 'Text looking small?',
            message: 'Make the menus and text larger — tap to open Interface size.',
            icon: '🔍',
            accent: '#0ea5e9',
            durationMs: 9000,
        });
        if (card && card.addEventListener) card.addEventListener('click', openSetting);
    }

    function start() {
        // Let the app settle (boot, any onboarding) before offering the nudge.
        setTimeout(maybeNudge, 4000);
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', start, { once: true });
    } else {
        start();
    }
})();
