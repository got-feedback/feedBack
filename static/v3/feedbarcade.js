/*
 * fee[dB]ack v0.3.0 — FeedBarcade (#v3-feedbarcade), v3-native minigames hub.
 *
 * A vanilla-JS reskin of the bundled `minigames` plugin's screen into the fb-*
 * design (constitution P-II). It REUSES the minigames backend + the
 * window.feedBackMinigames SDK — it does not fork scoring/run logic and adds
 * no second XP curve. XP stays unified through the core store (P15): the header
 * reads /api/profile/progress (the same data the topbar profile badge shows),
 * while per-game bests + cross-game unlocks come from the minigames /profile.
 *
 * UI placement is a DEFERRED capability domain (design/05): we use the legacy
 * plugin loader + /api/plugins/minigames/* routes, NOT capability dispatch.
 * Launch delegates to feedBackMinigames.start(gameId), which mounts the
 * plugin's own #mg-stage overlay (eagerly injected at boot) — so this screen
 * never needs to visit the legacy #plugin-minigames hub.
 */
(function () {
    'use strict';

    const SCREEN_ID = 'v3-feedbarcade';
    const sm = window.feedBack;
    const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => (
        { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    const enc = encodeURIComponent;

    let _progress = null;   // /api/profile/progress  → header level/xp/streak
    let _mgProfile = null;  // /api/plugins/minigames/profile → per_game + unlocks
    let _registry = null;   // /api/plugins/minigames/registry → installed minigames

    // Stage-visibility tracking for the refresh-after-run observer.
    let _observer = null;
    let _stageWasVisible = false;
    let _refreshTimer = null;

    function sdk() { return window.feedBackMinigames || null; }
    function registeredList() {
        const s = sdk();
        try { return (s && typeof s.listRegistered === 'function') ? s.listRegistered() : []; }
        catch (e) { return []; }
    }

    // ── API ────────────────────────────────────────────────────────────────--
    async function jget(url) { try { const r = await fetch(url); return r.ok ? r.json() : null; } catch (e) { return null; } }

    async function fetchProgress() { _progress = await jget('/api/profile/progress'); }
    async function fetchMgProfile() {
        const s = sdk();
        if (s && typeof s.getProfile === 'function') {
            try { _mgProfile = await s.getProfile(); return; } catch (e) { /* fall through */ }
        }
        _mgProfile = await jget('/api/plugins/minigames/profile');
    }
    async function fetchRegistry() { _registry = await jget('/api/plugins/minigames/registry'); }

    async function load() {
        await Promise.all([fetchProgress(), fetchMgProfile(), fetchRegistry()]);
    }

    // ── Toast (non-blocking, self-contained) ──────────────────────────────────
    function toast(msg) {
        let host = document.getElementById('v3-fb-toast');
        if (!host) {
            host = document.createElement('div');
            host.id = 'v3-fb-toast';
            host.className = 'fixed bottom-6 left-1/2 -translate-x-1/2 z-[120] bg-fb-card text-fb-text ' +
                'border border-fb-border/60 rounded-lg px-4 py-2 text-sm shadow-xl';
            document.body.appendChild(host);
        }
        host.textContent = msg;
        host.classList.remove('hidden');
        clearTimeout(host._t);
        host._t = setTimeout(() => host.classList.add('hidden'), 3000);
    }

    // ── Render: header ────────────────────────────────────────────────────────
    function headerHTML() {
        const p = _progress || { current_streak: 0, best_streak: 0 };
        // Progression (spec 010): rounds earn Decibels (dB) and advance
        // minigame challenges/quests — the old XP level meter is gone.
        const prog = (window.v3Progression && window.v3Progression.get()) || null;
        const rank = prog ? prog.mastery_rank : 0;
        const wallet = (prog && prog.wallet) || { balance: 0 };
        return '<div class="bg-fb-card/80 backdrop-blur rounded-xl p-6 border border-fb-border/50">' +
            '<div class="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">' +
            '<div>' +
            '<h2 class="text-3xl font-bold text-fb-text">FeedBarcade</h2>' +
            '<p class="text-sm text-fb-textDim mt-1">Standalone games that share your guitar input — rounds earn Decibels (dB) and count toward challenges and quests.</p>' +
            '</div>' +
            '<div class="flex items-center gap-4 text-sm text-fb-textDim">' +
            '<span class="text-fb-text font-semibold">Rank ' + rank + '</span>' +
            '<span class="text-fb-gold font-semibold">' + Number(wallet.balance || 0).toLocaleString() + ' dB</span>' +
            '<span class="text-fb-accent">🔥 ' + (p.current_streak || 0) + '-day streak</span>' +
            '</div></div>' +
            '</div>';
    }

    // ── Render: a single game tile (song-card pattern) ────────────────────────
    function gameTile(m) {
        const id = m.plugin_id;
        const spec = registeredList().find((g) => g.id === id) || null;
        const launchable = !!spec;
        const title = m.title || (spec && spec.title) || id;
        const tagline = m.tagline || (spec && spec.tagline) || '';
        const stats = (_mgProfile && _mgProfile.totals && _mgProfile.totals.per_game && _mgProfile.totals.per_game[id]) || {};
        const best = Number(stats.best_score) || 0;
        const runs = Number(stats.runs) || 0;
        const art = m.thumbnail
            ? '<img src="/api/plugins/' + enc(id) + '/assets/' + enc(m.thumbnail) + '" alt="" ' +
              'class="w-full h-full object-cover transition-transform duration-300 group-hover:scale-105" ' +
              'onerror="this.style.display=\'none\';this.nextElementSibling.classList.remove(\'hidden\')">' +
              '<div class="hidden absolute inset-0 flex items-center justify-center text-5xl">🎮</div>'
            : '<div class="absolute inset-0 flex items-center justify-center text-5xl">🎮</div>';
        const playOverlay = launchable
            ? '<div class="absolute inset-0 flex items-center justify-center opacity-0 group-hover:opacity-100 transition bg-black/40">' +
              '<span class="px-4 py-2 rounded-full bg-fb-primary hover:bg-fb-primaryHi text-white text-sm font-semibold shadow-lg">▶ Play</span></div>'
            : '<div class="absolute inset-0 flex items-center justify-center bg-black/50 text-xs text-fb-textDim text-center px-3">Loading… reload if this persists</div>';
        // Launchable tiles use a real <button> so the play surface is keyboard-
        // focusable and announced as a control; non-launchable (loading) tiles
        // stay a plain div.
        const surfaceOpen = launchable
            ? '<button type="button" data-mg-play aria-label="Play ' + esc(title) + '" class="relative aspect-square w-full block p-0 border-0 rounded-lg overflow-hidden bg-fb-card cursor-pointer">'
            : '<div class="relative aspect-square rounded-lg overflow-hidden bg-fb-card">';
        const surfaceClose = launchable ? '</button>' : '</div>';
        return '<div class="group relative" data-mg-game="' + esc(id) + '">' +
            surfaceOpen +
            art + playOverlay +
            surfaceClose +
            '<div class="mt-1 text-sm text-fb-text truncate" title="' + esc(title) + '">' + esc(title) + '</div>' +
            (tagline ? '<div class="text-xs text-fb-textDim truncate" title="' + esc(tagline) + '">' + esc(tagline) + '</div>' : '') +
            '<div class="mt-1 flex items-center justify-between text-xs text-fb-textDim">' +
            '<span>Runs <b class="text-fb-text">' + runs + '</b></span>' +
            '<span>Best <b class="text-fb-text">' + best + '</b></span>' +
            '</div></div>';
    }

    // ── Render: grid / empty state ────────────────────────────────────────────
    function gridHTML() {
        const games = (_registry && Array.isArray(_registry.minigames)) ? _registry.minigames : [];
        if (!games.length) {
            return '<div class="bg-fb-card/80 backdrop-blur rounded-xl p-10 border border-fb-border/50 text-center">' +
                '<div class="text-5xl mb-3">🎮</div>' +
                '<p class="text-fb-text font-semibold">No minigames installed</p>' +
                '<p class="text-sm text-fb-textDim mt-1">Install a minigame plugin to start playing.</p>' +
                '<button type="button" data-fb-plugins class="mt-4 text-sm text-fb-primary hover:text-fb-primaryHi">Browse plugins →</button>' +
                '</div>';
        }
        return '<div class="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-4">' +
            games.map(gameTile).join('') + '</div>';
    }

    // ── Render: cross-game unlocks ────────────────────────────────────────────
    function unlocksHTML() {
        const unlocks = (_mgProfile && Array.isArray(_mgProfile.unlocks)) ? _mgProfile.unlocks : [];
        if (!unlocks.length) return '';
        // Map a game id → display title from the registry, for nicer labels.
        const titleById = {};
        ((_registry && _registry.minigames) || []).forEach((m) => { titleById[m.plugin_id] = m.title || m.plugin_id; });
        const chips = unlocks.map((u) => {
            const sepIndex = String(u).indexOf(':');
            const gid = sepIndex >= 0 ? u.slice(0, sepIndex) : '';
            const name = sepIndex >= 0 ? u.slice(sepIndex + 1) : u;
            const game = titleById[gid] || gid;
            return '<span class="inline-flex items-center gap-1.5 rounded-full bg-fb-bg/50 border border-fb-border/50 px-3 py-1 text-xs text-fb-text">' +
                '<span class="text-fb-gold">★</span>' + esc(name) +
                (game ? '<span class="text-fb-textDim">· ' + esc(game) + '</span>' : '') + '</span>';
        }).join('');
        return '<div class="bg-fb-card/80 backdrop-blur rounded-xl p-6 border border-fb-border/50">' +
            '<h3 class="text-lg font-bold text-fb-text mb-3">Unlocks</h3>' +
            '<div class="flex flex-wrap gap-2">' + chips + '</div></div>';
    }

    // ── Render: createNoteDetector hint (non-blocking) ─────────────────────────
    function noteDetectHintHTML() {
        if (typeof window.createNoteDetector === 'function') return '';
        return '<div class="bg-fb-card/60 border border-fb-border/40 rounded-lg px-4 py-2 text-xs text-fb-textDim">' +
            'Some minigames score your playing and need the Note Detector plugin. They still run without it.' +
            '</div>';
    }

    function render() {
        const root = document.getElementById(SCREEN_ID);
        if (!root) return;
        root.innerHTML =
            '<div class="max-w-6xl mx-auto p-6 md:p-8 space-y-6">' +
            headerHTML() +
            noteDetectHintHTML() +
            gridHTML() +
            unlocksHTML() +
            '</div>';
        wire(root);
    }

    // ── Wiring ────────────────────────────────────────────────────────────────
    function wire(scope) {
        scope.querySelector('[data-fb-plugins]')?.addEventListener('click', () => {
            if (typeof window.showScreen === 'function') window.showScreen('v3-plugins');
        });
        scope.querySelectorAll('[data-mg-game]').forEach((card) => {
            const id = card.getAttribute('data-mg-game');
            card.querySelector('[data-mg-play]')?.addEventListener('click', () => launch(id));
        });
    }

    // The minigames plugin defines its run overlays (#mg-stage / #mg-picker /
    // #mg-summary) INSIDE its hub screen container (#plugin-minigames). When a
    // game is launched from this v3 screen, that hub screen is the inactive
    // `.screen` (display:none), so the fixed overlays — though their own
    // `hidden` class is cleared by the SDK — sit under a display:none ancestor
    // and never paint. Relocate them to <body>: they're `position:fixed` and
    // the SDK only ever reaches them via getElementById, so this is safe and
    // idempotent, and a run is now visible no matter which screen is active.
    // (The legacy hub still works — fixed overlays render the same at <body>.)
    function portalOverlays() {
        ['mg-stage', 'mg-picker', 'mg-summary'].forEach((id) => {
            const el = document.getElementById(id);
            if (el && el.parentElement !== document.body) document.body.appendChild(el);
        });
    }

    async function launch(id) {
        const s = sdk();
        if (!s || typeof s.start !== 'function') { toast('Minigames are still loading — try again in a moment.'); return; }
        if (!registeredList().some((g) => g.id === id)) { toast('This minigame is not ready yet. Reload the page if it persists.'); return; }
        if (!document.getElementById('mg-stage')) { toast('Minigame stage not ready yet.'); return; }
        portalOverlays();
        try { await s.start(id); } catch (e) { console.warn('[feedbarcade] launch failed:', e); }
    }

    // ── Refresh-after-run ──────────────────────────────────────────────────────
    // The SDK emits no public run-complete event, but both end() and
    // teardownActiveSession() re-add `hidden` to #mg-stage. Observe that and
    // refresh on the visible→hidden edge so the header XP and per-game bests
    // update in place after a run. refresh() is idempotent + cheap.
    const refresh = async function () { await load(); render(); };

    function stageVisible(stage) { return !!stage && !stage.classList.contains('hidden'); }
    function ensureStageObserver() {
        if (_observer) return;
        const stage = document.getElementById('mg-stage');
        if (!stage) return;   // plugin not mounted yet; retry on ready/screen-change
        portalOverlays();     // hoist overlays out of the (hidden) hub screen
        _stageWasVisible = stageVisible(stage);
        _observer = new MutationObserver(() => {
            const vis = stageVisible(stage);
            if (_stageWasVisible && !vis) {
                clearTimeout(_refreshTimer);
                _refreshTimer = setTimeout(refresh, 150);   // coalesce end() + summary close
            }
            _stageWasVisible = vis;
        });
        _observer.observe(stage, { attributes: true, attributeFilter: ['class'] });
    }

    // ── Public API + boot ──────────────────────────────────────────────────────
    window.v3Feedbarcade = { refresh };

    async function boot() {
        // Refresh progression state before the first render so headerHTML() shows
        // the correct rank/dB instead of the Rank 0 / 0 dB cold-load fallback.
        if (window.v3Progression && typeof window.v3Progression.refresh === 'function') {
            try { await window.v3Progression.refresh(); } catch (e) { /* proceed with cached state */ }
        }
        await load();
        render();
        ensureStageObserver();
        if (sm && typeof sm.on === 'function') {
            sm.on('screen:changed', (e) => {
                if (e && e.detail && e.detail.id === SCREEN_ID) { ensureStageObserver(); refresh(); }
            });
        }
        // The minigames plugin publishes its SDK + injects #mg-stage at boot and
        // fires this once ready; re-render so late-registered specs appear and
        // the stage observer attaches.
        window.addEventListener('feedBack-minigames-ready', () => { ensureStageObserver(); refresh(); });
    }
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', boot, { once: true });
    } else {
        boot();
    }
})();
