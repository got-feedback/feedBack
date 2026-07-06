/*
 * fee[dB]ack v0.3.0 — first-run home tour.
 *
 * Registers a spotlight tour over the home-page cards with the shared tour
 * engine (window.feedBackTour / Shepherd) and auto-runs it once, the first
 * time the user lands on the home page after completing onboarding. It stays
 * replayable forever from the per-screen "?" tour menu (registered with
 * screens: ['v3-home']).
 *
 * Anchors (all stable, on-screen while #v3-home is active):
 *   #v3-hero               hero / Start Playing      (dashboard.js)
 *   [data-tour="continue"] continue / pick a song    (dashboard.js, 3 variants)
 *   #v3-instrument-wrap    instrument selector badge (badges.js, topbar)
 *   #v3-tuner-wrap         tuner badge               (badges.js, topbar)
 *   #v3-audio-routing      audio routing card        (dashboard.js)
 *   [data-v3-open-profile] profile badge             (profile.js, topbar)
 *   #v3-nav                left sidebar navigation    (index.html)
 */
(function () {
    'use strict';

    var TOUR_ID = 'home-onboarding';

    // Each step dims the page and spotlights one element (shape: 'spotlight').
    // waitFor blocks the step until its target exists, so the async dashboard
    // re-render kicked off by 'v3:profile-updated' can't race the first step.
    function buildSteps() {
        return [
            {
                id: 'hero', shape: 'spotlight', position: 'bottom',
                selector: '#v3-hero', waitFor: '#v3-hero',
                title: 'Welcome to fee[dB]ack',
                content: 'This is your home base. Hit Start Playing to drop straight into a song from your library.',
            },
            {
                id: 'continue', shape: 'spotlight', position: 'left',
                selector: '[data-tour="continue"]', waitFor: '[data-tour="continue"]',
                title: 'Pick up where you left off',
                content: 'Your last song resumes right here in one click. Before you’ve played anything, it’s a quick random pick to get you going.',
            },
            {
                id: 'instrument', shape: 'spotlight', position: 'bottom',
                selector: '#v3-instrument-wrap', waitFor: '#v3-instrument-wrap',
                title: 'Choose your instrument',
                content: 'Set your instrument, string count and tuning here — and if you play left-handed, flip Handedness to Left so the whole highway mirrors. The highway, tuner and scoring all adapt to this selection.',
            },
            {
                id: 'tuner', shape: 'spotlight', position: 'bottom',
                selector: '#v3-tuner-wrap', waitFor: '#v3-tuner-wrap',
                title: 'Tune up first',
                content: 'Open the tuner and match each string until the meter centers — accurate tuning means accurate scoring.',
            },
            {
                id: 'audio', shape: 'spotlight', position: 'top',
                selector: '#v3-audio-routing', waitFor: '#v3-audio-routing',
                title: 'Your signal path',
                content: 'Input → amp / NAM / IR → output, at a glance. Set up and monitor your gear from this card.',
            },
            {
                id: 'profile', shape: 'spotlight', position: 'bottom',
                selector: '[data-v3-open-profile]', waitFor: '[data-v3-open-profile]',
                title: 'Track your progress',
                content: 'Your profile, avatar and rank live here. Watch your accuracy climb and level up as you play.',
            },
            {
                id: 'nav', shape: 'spotlight', position: 'right',
                selector: '#v3-nav', waitFor: '#v3-nav',
                title: 'Find everything here',
                content: 'Browse your full library, lessons and plugins anytime. You can replay this tour from the ? button in the corner.',
            },
        ];
    }

    function register() {
        var t = window.feedBackTour;
        if (!t || typeof t.register !== 'function') return false;
        t.register(TOUR_ID, {
            name: 'Welcome tour',     // label in the "?" tour menu
            screens: ['v3-home'],     // relevant only on the home screen
            autoPrompt: false,        // we auto-run it from onboarding; no toast nag
            buildSteps: buildSteps,
        });
        return true;
    }

    // Auto-run once after a genuine onboarding completion. profile.js gates the
    // call on !editing (a profile edit must not relaunch it); we additionally
    // honour the engine's own seen/dismissed state so it never repeats and a
    // dismissal isn't nagged. Stays replayable from the "?" menu either way.
    function startFirstRun() {
        var t = window.feedBackTour;
        if (!t || typeof t.start !== 'function') return;
        try {
            if (t.hasSeen(TOUR_ID) || t.hasDismissed(TOUR_ID)) return;
        } catch (e) { /* private mode — fall through and attempt once */ }
        // Make sure the home screen is in view so the spotlight targets exist.
        if (typeof window.showScreen === 'function') {
            try { window.showScreen('v3-home'); } catch (e) { /* best-effort */ }
        }
        // Wait for the dashboard to finish (re)rendering #v3-home before
        // attaching Shepherd. Starting after a single animation frame can latch
        // onto the pre-render #v3-hero / [data-tour] nodes that the async render
        // then replaces, breaking the tour. Listen for the render-complete
        // event; fall back on a timeout in case the render already finished
        // (no event coming) or never fires.
        var started = false;
        var go = function () {
            if (started) return;
            started = true;
            try { document.removeEventListener('v3:dashboard-rendered', go); } catch (e) { /* */ }
            try { t.start(TOUR_ID); } catch (e) { /* degrade */ }
        };
        try { document.addEventListener('v3:dashboard-rendered', go, { once: true }); } catch (e) { /* */ }
        setTimeout(go, 1200);
    }

    // Onboarding paths that navigate straight to the player ("Play it now")
    // can't start the tour immediately — there is no home screen to spotlight
    // yet. Arm it to run the first time the user lands back on v3-home.
    function armPendingFirstRun() {
        var t = window.feedBackTour;
        if (!t || typeof t.start !== 'function') return;
        try {
            if (t.hasSeen(TOUR_ID) || t.hasDismissed(TOUR_ID)) return;
        } catch (e) { /* private mode — fall through */ }
        var sm = window.feedBack;
        if (!sm || typeof sm.on !== 'function') return;
        var onScreen = function (e) {
            if (!(e && e.detail && e.detail.id === 'v3-home')) return;
            try { if (typeof sm.off === 'function') sm.off('screen:changed', onScreen); } catch (_) { /* */ }
            startFirstRun();
        };
        sm.on('screen:changed', onScreen);
    }

    window.v3OnboardingTour = { startFirstRun: startFirstRun, armPendingFirstRun: armPendingFirstRun };

    // tour-engine.js assigns window.feedBackTour at script-eval time, so if it
    // is loaded before us register() succeeds immediately; otherwise retry once
    // the DOM (and the engine) are ready.
    if (!register()) {
        document.addEventListener('DOMContentLoaded', register, { once: true });
    }
})();
