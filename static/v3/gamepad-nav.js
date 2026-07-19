// Generic gamepad menu navigation: Tab-order emulation.
//
// Every v3 screen except v3-songs (which has its own 2D grid nav) is built from
// real, natively-focusable <button>/<a> elements, so real Tab/Shift+Tab and real
// Enter/Space already work perfectly. The gap is that nothing ever calls
// .focus() on anything, and gamepad.js only ever synthesizes Arrow keydowns —
// it never sends Tab (browsers don't focus-traverse on a synthetic Tab anyway).
// This fills that gap by moving focus through the same set of elements Tab
// already visits, one step per Arrow press, treating Down/Right as "next" and
// Up/Left as "previous".
//
// Gated on !e.isTrusted so this NEVER touches real keyboard/mouse users — it
// only ever reacts to gamepad.js's synthetic events. Also bails whenever a more
// specific handler already claimed the key (songs.js's grid nav, shortcuts.js's
// legacy library arrow-nav, or the shortcuts registry's player-scope seek
// shortcuts all call preventDefault() before this listener runs, since script
// tag order puts them earlier in the document than this file).
(function () {
    'use strict';

    var FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), ' +
        'select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';
    var ARROWS = { ArrowUp: -1, ArrowLeft: -1, ArrowDown: 1, ArrowRight: 1 };
    var TEXT_INPUT_TYPES = ['text', 'search', 'email', 'url', 'tel', 'password', 'number'];

    function visible(el) {
        return el.offsetParent !== null;
    }

    function focusScopeRoot() {
        var modal = document.querySelector('[role="dialog"][aria-modal="true"], .feedBack-modal');
        if (modal && visible(modal)) return [modal];
        var nav = document.getElementById('v3-nav');
        var screen = document.querySelector('.screen.active');
        return [nav, screen].filter(Boolean);
    }

    function focusables() {
        var roots = focusScopeRoot();
        var els = [];
        roots.forEach(function (root) {
            Array.prototype.push.apply(els, root.querySelectorAll(FOCUSABLE));
        });
        return els.filter(visible);
    }

    function isTextInput(el) {
        if (!el) return false;
        if (el.tagName === 'TEXTAREA' || el.isContentEditable) return true;
        return el.tagName === 'INPUT' && TEXT_INPUT_TYPES.includes((el.type || 'text').toLowerCase());
    }

    document.addEventListener('keydown', function (e) {
        if (e.isTrusted || e.defaultPrevented) return;

        if (e.key === 'Enter' || e.key === ' ' || e.key === 'Spacebar') {
            // Chromium doesn't run the native "Enter/Space activates the focused
            // link/button" default action for untrusted synthetic keydowns, even
            // when dispatched straight at the focused element (confirmed by
            // testing) — so without this, a focused sidebar link or dashboard
            // button just sits there forever. click() works for untrusted events.
            var active = document.activeElement;
            if (active && active !== document.body && !isTextInput(active)) active.click();
            return;
        }

        if (e.key === 'Escape') {
            // Only 'player' and 'settings' have a registered Escape shortcut
            // (shortcuts.js); every other screen (v3-songs, v3-plugins,
            // v3-playlists, ...) leaves B with nothing to do — confirmed on-device,
            // players get stuck unable to leave the library or any other screen.
            // The app never pushes history entries on navigation (shell.js
            // deliberately doesn't reflect screen changes into location.hash), so
            // history.back() isn't a real "undo the last screen" — a fixed target
            // is. Prefer an existing in-screen back button if one is visible
            // (reuses each screen's own drill-down logic for free: v3-songs'
            // artist/album pages, v3-playlists' list<->detail view), else fall
            // back to the main menu, matching the direct showScreen() call the
            // settings Escape shortcut already uses.
            // querySelector alone would only ever look at the first match in
            // DOM order across all three selectors — screens stay in the DOM
            // (hidden, not removed) when you navigate away, so a hidden back
            // button from a screen you're not on can sort before the visible
            // one that actually applies. Check every match for visibility.
            var backBtns = document.querySelectorAll('[data-ap-back], [data-albums-back], #v3-pl-back');
            var backBtn = Array.prototype.find.call(backBtns, visible);
            if (backBtn) backBtn.click();
            else if (window.showScreen) window.showScreen('v3-home');
            return;
        }

        var dir = ARROWS[e.key];
        if (!dir) return;
        var els = focusables();
        if (!els.length) return;
        var idx = els.indexOf(document.activeElement);
        var next = idx === -1 ? 0 : Math.max(0, Math.min(els.length - 1, idx + dir));
        els[next].focus();
    });
})();
