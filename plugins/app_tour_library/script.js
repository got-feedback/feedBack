(function () {
    'use strict';

    // Override the engine's default `['player']` screens list for non-has_screen
    // plugins — this tour is for the Home/Library screen, not the player.
    var PLUGIN_ID = 'app_tour_library';
    var SCREENS = ['home'];

    var PROVIDER_STEP = {
        id: 'library-provider',
        selector: '#lib-provider',
        title: 'Choose a library',
        content: 'Use this menu to switch between your local library and any connected remote libraries. FeedBack remembers the last library you picked.',
        shape: 'spotlight',
        position: 'bottom',
        waitFor: '#lib-provider'
    };

    async function _loadDefaultSteps() {
        try {
            var resp = await fetch('/api/plugins/' + encodeURIComponent(PLUGIN_ID) + '/tour.json');
            if (!resp.ok) return [];
            var data = await resp.json();
            return Array.isArray(data.tour) ? data.tour : [];
        } catch (e) {
            console.warn('[app_tour_library] failed to load tour steps', e);
            return [];
        }
    }

    function _isBrowsableProvider(provider) {
        return !!provider && Array.isArray(provider.capabilities) && provider.capabilities.indexOf('library.read') !== -1;
    }

    async function _hasMultipleProviders() {
        try {
            var resp = await fetch('/api/library/providers');
            if (!resp.ok) return false;
            var data = await resp.json();
            var providers = Array.isArray(data.providers) ? data.providers.filter(_isBrowsableProvider) : [];
            return providers.length > 1;
        } catch (e) {
            console.warn('[app_tour_library] failed to load library providers', e);
            return false;
        }
    }

    async function _buildSteps() {
        var steps = await _loadDefaultSteps();
        if (!steps.length || !(await _hasMultipleProviders())) return steps;

        var insertAt = steps.findIndex(function (step) { return step && step.id === 'search'; });
        var nextSteps = steps.slice();
        nextSteps.splice(insertAt === -1 ? 1 : insertAt + 1, 0, PROVIDER_STEP);
        return nextSteps;
    }

    function _register() {
        try {
            window.feedBackTour.register(PLUGIN_ID, { screens: SCREENS, buildSteps: _buildSteps });
        } catch (e) {
            console.warn('[app_tour_library] register failed', e);
        }
    }

    if (window.feedBackTour && typeof window.feedBackTour.register === 'function') {
        _register();
    } else {
        // Engine inits on DOMContentLoaded after fetching /api/plugins. Plugin
        // scripts can load before or after that handler runs, so poll briefly.
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
    // The Tuner plugin parks a FAB at `fixed bottom-5 right-5` (≈ bottom:20px,
    // right:20px, ~40px tall) on every screen. The tour engine's ? button sits
    // at bottom:12px right:12px — same corner. On the home screen they overlap
    // exactly. Scope a nudge to the home screen only so we don't move the
    // button on screens where the home tour isn't relevant anyway.
    var NUDGE_CLASS = 'app-tour-library-nudge';
    var STYLE_ID = 'app-tour-library-nudge-style';

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
        document.body.classList.toggle(NUDGE_CLASS, screenId === 'home');
    }

    function _initNudge() {
        _ensureStyle();
        // Prime from whichever screen is already active.
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
