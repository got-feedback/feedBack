// ════════════════════════════════════════════════════════════════════════
// v3 tabbed settings page — behaviour layer (feat/v3-settings-tabbed)
//
// The markup (tab bar, card rows, per-tab plugin mount containers) lives
// statically in static/v3/index.html so the element ids exist before app.js's
// loadSettings() hydrates them. This module owns the *behaviour*:
//   • tab switching + active-tab persistence (localStorage 'v3-settings-tab')
//   • the per-category "Reset" button(s)
//   • the read-only Keybinds reference (from window.getAllShortcuts())
//   • empty-state notes for plugin tabs with no installed plugins
//
// It is a plain non-module script (matches the rest of static/v3/*). All
// reads are null-guarded so it no-ops gracefully on the classic v2 page (which
// ships its own settings markup and never creates #settings-tabbar).
// ════════════════════════════════════════════════════════════════════════
(function () {
    'use strict';

    var TAB_KEY = 'v3-settings-tab';
    var DEFAULT_TAB = 'gameplay';

    // Per-category reset descriptors. `server` keys are cleared via
    // POST /api/settings/reset (so the next GET falls back to defaults);
    // `local` keys are client-only localStorage prefs; `after` re-applies any
    // live-object default that won't pick itself back up from a cleared key.
    // Only tabs with a [data-reset] button in the markup need an entry — today
    // that's Gameplay; others can be added alongside a button later.
    var RESET_MAP = {
        gameplay: {
            server: ['master_difficulty', 'av_offset_ms', 'miss_penalty',
                'fail_behavior', 'countdown_before_song', 'default_arrangement'],
            local: ['lefty', 'autoplayExit', 'showUpNext', 'confirmExitSong', 'arrangementNamingMode', 'countdownBeforeSong'],
            after: function () {
                // Left-handed is held on the highway object, not re-derived
                // from localStorage on load — flip it back to the default.
                try { if (window.highway && window.highway.setLefty) window.highway.setLefty(false); } catch (_) { /* noop */ }
            },
        },
    };

    function esc(s) {
        return String(s == null ? '' : s)
            .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    }

    // ── Tab switching ────────────────────────────────────────────────────
    function knownTabs() {
        var out = [];
        document.querySelectorAll('#settings-tabbar .fb-tab').forEach(function (b) {
            if (b.dataset.tab) out.push(b.dataset.tab);
        });
        return out;
    }

    function activateTab(tab) {
        var tabs = knownTabs();
        if (tabs.indexOf(tab) === -1) tab = tabs.length ? tabs[0] : DEFAULT_TAB;
        document.querySelectorAll('#settings-tabbar .fb-tab').forEach(function (b) {
            b.classList.toggle('active', b.dataset.tab === tab);
        });
        document.querySelectorAll('#settings .fb-tabpanel').forEach(function (p) {
            p.classList.toggle('active', p.dataset.tab === tab);
        });
        try { localStorage.setItem(TAB_KEY, tab); } catch (_) { /* private mode */ }
    }

    function wireTabs() {
        var bar = document.getElementById('settings-tabbar');
        if (!bar || bar.dataset.wired === '1') return;
        bar.dataset.wired = '1';
        bar.addEventListener('click', function (e) {
            var btn = e.target.closest ? e.target.closest('.fb-tab') : null;
            if (btn && btn.dataset.tab) activateTab(btn.dataset.tab);
        });
        var saved = DEFAULT_TAB;
        try { saved = localStorage.getItem(TAB_KEY) || DEFAULT_TAB; } catch (_) { /* noop */ }
        activateTab(saved);
    }

    // ── Per-category reset ────────────────────────────────────────────────
    function wireResets() {
        document.querySelectorAll('#settings [data-reset]').forEach(function (btn) {
            if (btn.dataset.wired === '1') return;
            btn.dataset.wired = '1';
            btn.addEventListener('click', function () { resetCategory(btn.dataset.reset); });
        });
    }

    function resetCategory(cat) {
        var map = RESET_MAP[cat];
        if (!map) return;
        var confirmFn = (typeof window._confirmDialog === 'function')
            ? window._confirmDialog({
                title: 'Reset ' + cat.charAt(0).toUpperCase() + cat.slice(1) + ' Settings',
                body: '<p class="text-sm text-gray-300">Restore these settings to their defaults? This can\'t be undone.</p>',
                confirmText: 'Reset', cancelText: 'Cancel', danger: true,
            })
            : Promise.resolve(window.confirm('Reset ' + cat + ' settings to defaults?'));
        confirmFn.then(function (ok) {
            if (!ok) return;
            var done = Promise.resolve();
            if (map.server && map.server.length) {
                done = fetch('/api/settings/reset', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ keys: map.server }),
                }).catch(function () { /* best-effort */ });
            }
            done.then(function () {
                (map.local || []).forEach(function (k) {
                    try { localStorage.removeItem(k); } catch (_) { /* noop */ }
                });
                if (typeof map.after === 'function') { try { map.after(); } catch (_) { /* noop */ } }
                // Re-hydrate every control from the now-default server + local state.
                if (typeof window.loadSettings === 'function') {
                    try { window.loadSettings(); } catch (_) { /* noop */ }
                }
            });
        });
    }

    // ── Keybinds reference (read-only) ────────────────────────────────────
    var SCOPE_TITLES = {
        global: 'Global', player: 'Player', library: 'Library', settings: 'Settings',
    };
    function scopeTitle(scope) {
        if (SCOPE_TITLES[scope]) return SCOPE_TITLES[scope];
        if (scope && scope.indexOf('plugin-') === 0) return 'Plugin: ' + scope.slice(7);
        return scope || 'Other';
    }

    function renderKeybinds() {
        var host = document.getElementById('settings-keybinds');
        if (!host) return;
        var list = [];
        try { if (typeof window.getAllShortcuts === 'function') list = window.getAllShortcuts() || []; } catch (_) { list = []; }
        if (!list.length) {
            host.innerHTML = '<p class="fb-tabpanel-empty">No keyboard shortcuts are registered yet.</p>';
            return;
        }
        // Group by scope, stable scope order with anything unknown last.
        var order = ['global', 'player', 'library', 'settings'];
        var groups = {};
        list.forEach(function (s) {
            (groups[s.scope] = groups[s.scope] || []).push(s);
        });
        var scopes = Object.keys(groups).sort(function (a, b) {
            var ia = order.indexOf(a), ib = order.indexOf(b);
            if (ia === -1) ia = order.length;
            if (ib === -1) ib = order.length;
            return ia - ib || a.localeCompare(b);
        });
        var html = '';
        scopes.forEach(function (scope) {
            html += '<div class="fb-kbd-group-title">' + esc(scopeTitle(scope)) + '</div>';
            html += '<div class="fb-srows">';
            groups[scope].forEach(function (s) {
                html += '<div class="fb-srow">'
                    + '<div class="fb-srow-main"><div class="fb-srow-title">' + esc(s.description || s.combo) + '</div></div>'
                    + '<div class="fb-srow-control"><span class="fb-kbd">' + esc(s.combo) + '</span></div>'
                    + '</div>';
            });
            html += '</div>';
        });
        html += '<p class="fb-settings-note">Remapping shortcuts is not yet supported.</p>';
        host.innerHTML = html;
    }

    // ── Empty-state notes for plugin tabs ─────────────────────────────────
    function refreshEmptyStates() {
        document.querySelectorAll('#settings [data-empty-for]').forEach(function (note) {
            var target = document.getElementById(note.dataset.emptyFor);
            var empty = !target || target.children.length === 0;
            note.style.display = empty ? '' : 'none';
        });
    }

    // ── Boot + refresh on settings entry ──────────────────────────────────
    function init() {
        if (!document.getElementById('settings-tabbar')) return; // not the v3 page
        wireTabs();
        wireResets();
        renderKeybinds();
        refreshEmptyStates();
        // Safety net for plugin-panel injection ordering: tell app.js the
        // settings containers exist now (it injects plugin <details> into the
        // per-category containers). Harmless if no listener is attached.
        try { document.dispatchEvent(new CustomEvent('v3:settings-rendered')); } catch (_) { /* noop */ }
    }

    // Re-derive the dynamic bits whenever the user enters Settings: shortcuts
    // and plugin panels may have registered/mounted since the last visit.
    if (window.feedBack && typeof window.feedBack.on === 'function') {
        window.feedBack.on('screen:changed', function (e) {
            if (e && e.id === 'settings') {
                // Plugin panels (and shortcuts) may have mounted since the last
                // visit — re-derive the dynamic bits on every Settings entry.
                wireTabs(); wireResets(); renderKeybinds(); refreshEmptyStates();
            }
        });
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init, { once: true });
    } else {
        init();
    }
})();
