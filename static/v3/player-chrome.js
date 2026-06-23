/*
 * fee[dB]ack v0.3.0 — P22 player chrome.
 *
 * Drives the v3 player overlay (static/v3/index.html #player): the Up-Next
 * section pill, the hover-reveal left icon rail + its feature popovers, the
 * auto-hiding bottom transport, and the speed-level visual (bars + chevrons).
 *
 * Design contract: the actual controls are the SAME legacy elements/handlers
 * (ids unchanged), just relocated into rail popovers — so app.js/highway.js
 * keep populating and reacting to them unmodified. This module only adds
 * presentation behavior (open/close, reveal/hide, mirror state). It runs only
 * while #player is the active screen.
 */
(function () {
    'use strict';

    const $ = (id) => document.getElementById(id);
    const player = () => $('player');
    const now = () => (window.performance && performance.now ? performance.now() : (window.__pcNow = (window.__pcNow || 0) + 16));

    const IDLE_MS = 2500;     // transport hides after this much pointer stillness
    const UPNEXT_MS = 160;    // throttle the Up-Next recompute (~6 Hz)

    let rafId = null, running = false;
    let lastMove = 0, lastUpNext = 0;
    let openPop = null;       // { btn, pop }

    // ── v3 UI signal + plugin-control slot API ───────────────────────────────
    // Lets plugins detect v3 (window.feedBack.uiVersion === 'v3') and mount
    // controls into a stable slot instead of the auto-hiding transport.
    window.feedBack = window.feedBack || {};
    window.feedBack.uiVersion = 'v3';
    window.feedBack.ui = window.feedBack.ui || {};
    window.feedBack.ui.version = 'v3';
    window.feedBack.ui.playerControlSlot = function () { return $('v3-plugin-controls-slot'); };

    // ── Plugin-control re-homing shim ────────────────────────────────────────
    // Legacy plugins inject controls into #player-controls (now an auto-hiding
    // minimal transport, often via a now-deleted separator anchor). Move any
    // non-native child into the always-reachable Plugins rail popover. Moving a
    // node preserves its identity + listeners, so the plugin's own toggle logic
    // keeps working.
    function updatePluginSlotState() {
        const slot = $('v3-plugin-controls-slot');
        if (!slot) return;
        // Count only controls that are actually shown — plugins inject hidden
        // gear/settings panels (display:none / .hidden) too, which shouldn't
        // inflate the badge.
        const n = Array.prototype.filter.call(slot.children, (el) =>
            el.nodeType === 1 &&
            !el.hasAttribute('hidden') &&
            !(el.classList && el.classList.contains('hidden')) &&
            (el.style ? el.style.display !== 'none' : true)).length;
        const empty = $('v3-plugin-slot-empty');
        if (empty) empty.style.display = n ? 'none' : '';
        const badge = $('v3-plugin-count');
        if (badge) {
            if (n) { badge.textContent = String(n); badge.hidden = false; }
            else { badge.hidden = true; }
        }
    }
    function rehomePluginControls() {
        const bar = $('player-controls');
        const slot = $('v3-plugin-controls-slot');
        if (!bar || !slot) return;
        // Snapshot children first — appendChild mutates the live list.
        Array.prototype.slice.call(bar.children).forEach((el) => {
            if (el.nodeType !== 1 || el.hasAttribute('data-v3-native')) return;
            slot.appendChild(el);   // move (identity + listeners preserved)
        });
        updatePluginSlotState();
    }
    function installRehomeObserver() {
        const bar = $('player-controls');
        if (!bar || bar.dataset.pcRehome) return;
        bar.dataset.pcRehome = '1';
        rehomePluginControls();   // initial sweep
        // Only addedNodes matter; our own moves are removals from the bar and
        // never re-trigger a move, so there's no loop.
        try {
            new MutationObserver((muts) => {
                if (muts.some((m) => m.addedNodes && m.addedNodes.length)) rehomePluginControls();
            }).observe(bar, { childList: true });
        } catch (e) { /* MutationObserver always present in target browsers */ }
        // Also watch the slot itself: v3-aware plugins mount controls straight
        // into it (bypassing #player-controls), and plugins show/hide their own
        // controls — both must refresh the badge/empty state.
        const slot = $('v3-plugin-controls-slot');
        if (slot) {
            try {
                new MutationObserver(updatePluginSlotState).observe(slot, {
                    childList: true, subtree: true, attributes: true,
                    attributeFilter: ['class', 'style', 'hidden'],
                });
            } catch (e) { /* non-fatal */ }
        }
    }

    // ── Rail popovers ───────────────────────────────────────────────────────
    function setPopOpenFlag(on) {
        const p = player();
        if (p) p.classList.toggle('pop-open', !!on);
    }
    function closePop() {
        if (!openPop) return;
        if (openPop.pop) openPop.pop.classList.add('hidden');
        if (openPop.btn) {
            openPop.btn.setAttribute('aria-expanded', 'false');
            openPop.btn.classList.remove('is-active');
        }
        openPop = null;
        setPopOpenFlag(false);
    }
    function openPopFor(btn) {
        const key = btn.getAttribute('data-rail');
        const pop = $('v3-rail-pop-' + key);
        if (!pop) return;
        if (openPop && openPop.pop === pop) { closePop(); return; }   // toggle
        closePop();
        pop.classList.remove('hidden');
        btn.setAttribute('aria-expanded', 'true');
        btn.classList.add('is-active');
        openPop = { btn: btn, pop: pop };
        setPopOpenFlag(true);
        // Lazily mount the P18 audio-routing widget the first time it's shown.
        if (key === 'audio' && window.v3AudioRouting && typeof window.v3AudioRouting.render === 'function') {
            try { window.v3AudioRouting.render($('v3-rail-audio-routing')); } catch (e) { /* non-fatal */ }
        }
    }

    // Reflect the real highway lyrics state onto the Mic rail icon (lyrics
    // default ON and persist in localStorage, so click-parity would desync).
    function syncLyricsIcon() {
        const rail = $('v3-player-rail');
        const lyr = rail && rail.querySelector('[data-rail-action="lyrics"]');
        if (!lyr) return;
        const on = (window.highway && typeof highway.getLyricsVisible === 'function')
            ? highway.getLyricsVisible()
            : lyr.classList.contains('is-active');
        lyr.classList.toggle('is-active', !!on);
        lyr.setAttribute('aria-pressed', on ? 'true' : 'false');
    }
    function wireRail() {
        const rail = $('v3-player-rail');
        if (!rail || rail.dataset.pcWired) return;
        rail.dataset.pcWired = '1';
        rail.querySelectorAll('[data-rail]').forEach((b) =>
            b.addEventListener('click', (e) => { e.stopPropagation(); openPopFor(b); }));
        // Mic icon: a direct lyrics toggle (clicks the hidden canonical button so
        // highway.toggleLyrics() + any label logic runs), mirroring on/off state.
        const lyr = rail.querySelector('[data-rail-action="lyrics"]');
        if (lyr) lyr.addEventListener('click', (e) => {
            e.stopPropagation();
            const real = $('btn-lyrics');
            if (real) real.click();   // runs highway.toggleLyrics() via its onclick
            else if (window.highway && typeof highway.toggleLyrics === 'function') highway.toggleLyrics();
            syncLyricsIcon();          // reflect the ACTUAL toggled state, not click parity
        });
        // Click-outside + Esc close (bound once; harmless when no popover open).
        if (!window.__pcGlobalClose) {
            window.__pcGlobalClose = true;
            document.addEventListener('click', (e) => {
                if (!openPop) return;
                if (openPop.pop.contains(e.target) || openPop.btn.contains(e.target)) return;
                closePop();
            });
            document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closePop(); });
        }
    }

    // ── Up Next pill ─────────────────────────────────────────────────────────
    function updateUpNext() {
        const pill = $('v3-upnext');
        if (!pill) return;
        const hw = window.highway;
        const secs = (hw && typeof hw.getSections === 'function') ? hw.getSections() : null;
        const t = (hw && typeof hw.getTime === 'function') ? hw.getTime() : null;
        if (!Array.isArray(secs) || !secs.length || t == null || isNaN(t)) { pill.classList.add('hidden'); return; }
        let next = null;
        for (let i = 0; i < secs.length; i++) {
            if (typeof secs[i].time === 'number' && secs[i].time > t + 0.05) { next = secs[i]; break; }
        }
        if (!next) { pill.classList.add('hidden'); return; }
        const dt = Math.max(0, next.time - t);
        const nm = $('v3-upnext-name'), eta = $('v3-upnext-eta');
        if (nm) nm.textContent = next.name || '—';
        if (eta) eta.textContent = 'in ' + dt.toFixed(1) + 's';
        pill.classList.remove('hidden');
    }

    // ── Speed visual (bars + chevrons reflect #speed-slider) ──────────────────
    function updateSpeedViz() {
        const s = $('speed-slider');
        if (!s) return;
        const min = parseFloat(s.min) || 25, max = parseFloat(s.max) || 150;
        const frac = Math.min(1, Math.max(0, (parseFloat(s.value) - min) / (max - min)));
        const bars = document.querySelectorAll('#player-controls .v3-speed-bars i');
        const onBars = Math.round(frac * bars.length);
        bars.forEach((b, i) => b.classList.toggle('on', i < onBars));
        const chev = document.querySelectorAll('#player-controls .v3-chevrons i');
        const onChev = Math.round(frac * chev.length);
        chev.forEach((c, i) => c.classList.toggle('on', i < onChev));
    }

    // ── Auto-hide transport ───────────────────────────────────────────────────
    function revealChrome() {
        const p = player();
        if (!p) return;
        p.classList.add('chrome-active');
        p.classList.remove('chrome-idle');
        lastMove = now();
    }
    function tickIdle() {
        const p = player();
        if (!p) return;
        const playBtn = $('btn-play');
        const playing = playBtn && playBtn.getAttribute('aria-pressed') === 'true';
        const controls = $('player-controls');
        const overControls = controls && typeof controls.matches === 'function' && controls.matches(':hover');
        // Keep the transport up while paused, hovering it, or a popover is open.
        if (openPop || overControls || !playing) { lastMove = now(); return; }
        if (now() - lastMove > IDLE_MS) {
            p.classList.remove('chrome-active');
            p.classList.add('chrome-idle');
        }
    }

    // ── rAF loop ──────────────────────────────────────────────────────────────
    function loop() {
        const t = now();
        if (t - lastUpNext >= UPNEXT_MS) {
            lastUpNext = t;
            updateUpNext();
            // Re-sync the lyrics icon so programmatic highway.setLyricsVisible()
            // (e.g. from lyrics_karaoke) isn't left stale; cheap + idempotent.
            syncLyricsIcon();
        }
        tickIdle();
        rafId = requestAnimationFrame(loop);
    }

    // ── Lifecycle ───────────────────────────────────────────────────────────--
    function start() {
        if (running) return;
        const p = player();
        if (!p) return;
        running = true;
        wireRail();
        p.addEventListener('mousemove', revealChrome);
        p.addEventListener('touchstart', revealChrome, { passive: true });
        const s = $('speed-slider');
        if (s && !s.dataset.pcVizWired) { s.dataset.pcVizWired = '1'; s.addEventListener('input', updateSpeedViz); }
        updateSpeedViz();
        syncLyricsIcon();
        rehomePluginControls();   // sweep controls a plugin injected before/at player open
        revealChrome();
        if (!rafId) loop();
    }
    function stop() {
        if (!running) return;
        running = false;
        if (rafId) { cancelAnimationFrame(rafId); rafId = null; }
        const p = player();
        if (p) {
            p.removeEventListener('mousemove', revealChrome);
            p.removeEventListener('touchstart', revealChrome);
            p.classList.remove('chrome-active', 'chrome-idle');
        }
        closePop();
    }
    function syncActivation() {
        const p = player();
        if (!p) return;
        if (p.classList.contains('active')) start(); else stop();
    }
    function init() {
        const p = player();
        if (!p) return;
        installRehomeObserver();   // always on, so plugin injections are caught whenever they happen
        try {
            new MutationObserver(syncActivation).observe(p, { attributes: true, attributeFilter: ['class'] });
        } catch (e) { /* MutationObserver always present in target browsers */ }
        syncActivation();
    }

    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
    else init();
})();
