/*
 * fee[dB]ack v0.3.0 — Lessons (#v3-lessons).
 *
 * An fb-styled catalog over the external `tutorials` plugin (P25). It lists
 * lesson packs + lessons with progress and the unified level/XP/streak, and
 * the Start/Continue action deep-links into the plugin's OWN lesson view
 * (`plugin-tutorials`) which keeps the video + playSong + run/XP submission.
 * We do NOT fork lesson logic or add a second XP curve — completing a lesson
 * in the plugin posts to /api/plugins/minigames/runs → the unified core XP
 * store (P15), the same level the profile badge reads.
 *
 * Capability note (design/05 §0/§5): UI placement + plugin nav/screen are a
 * DEFERRED capability domain — consume /api/plugins + the plugin REST + the
 * legacy globals (navigate/showScreen), NOT capability dispatch. Every fetch
 * degrades gracefully (plugin absent / 404 / empty) and never blocks first
 * paint. Vanilla JS, fb-* tokens (constitution P-II).
 */
(function () {
    'use strict';
    const sm = window.feedBack;
    const PLUGIN_ID = 'tutorials';
    const API = '/api/plugins/' + PLUGIN_ID;
    const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => (
        { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    const enc = encodeURIComponent;
    const jget = async (u) => { try { const r = await fetch(u); return r.ok ? r.json() : null; } catch (e) { return null; } };

    // View state survives re-renders so returning from a plugin lesson lands
    // back on the pack the user was viewing.
    const state = { view: { kind: 'catalog' }, progress: null };

    // ── progress helpers ─────────────────────────────────────────────────---
    function lessonState(packId, lessonId) {
        const packs = (state.progress && state.progress.packs) || {};
        const pack = packs[packId] || {};
        const lessons = pack.lessons || {};
        return lessons[lessonId] || null;
    }
    function packPassedCount(pack) {
        const lessons = (pack && pack.lessons) || [];
        return lessons.reduce((n, l) => {
            const st = lessonState(pack.id, l.id);
            return n + (st && st.passed ? 1 : 0);
        }, 0);
    }
    // The "next" lesson to Start/Continue: first not-passed, else the first.
    function nextLesson(pack) {
        const lessons = (pack && pack.lessons) || [];
        if (!lessons.length) return null;
        return lessons.find((l) => { const st = lessonState(pack.id, l.id); return !(st && st.passed); }) || lessons[0];
    }

    // ── small view pieces ────────────────────────────────────────────────---
    function techChips(techs, max) {
        const arr = Array.isArray(techs) ? techs : [];
        const shown = arr.slice(0, max || 6);
        const extra = arr.length - shown.length;
        let html = shown.map((t) =>
            '<span class="text-[10px] uppercase tracking-wider text-fb-textDim bg-black/30 border border-fb-border/50 rounded px-1.5 py-0.5">' + esc(t) + '</span>').join('');
        if (extra > 0) html += '<span class="text-[10px] text-fb-textDim">+' + extra + '</span>';
        return '<div class="flex flex-wrap gap-1">' + html + '</div>';
    }
    function progressBar(passed, total) {
        const pct = total > 0 ? Math.round((passed / total) * 100) : 0;
        return '<div class="flex items-center gap-2">' +
            '<div class="flex-1 h-1.5 rounded-full bg-black/40 overflow-hidden">' +
            '<span class="block h-full bg-fb-primary" style="width:' + pct + '%"></span></div>' +
            '<span class="text-xs text-fb-textDim whitespace-nowrap">' + passed + '/' + total + '</span></div>';
    }
    // Per-lesson status: mastered ⭐, passed ✓, else best-accuracy ramp / "—".
    function lessonStatus(packId, lessonId) {
        const st = lessonState(packId, lessonId);
        if (st && st.mastered) return '<span class="text-fb-gold text-xs font-bold flex items-center gap-1">★ Mastered</span>';
        if (st && st.passed) return '<span class="text-fb-good text-xs font-bold flex items-center gap-1">✓ Passed</span>';
        if (st && st.best_accuracy != null && st.best_accuracy > 0) {
            const acc = st.best_accuracy;
            const pct = Math.round(acc * 100);
            const color = acc >= 0.9 ? 'text-fb-good' : (acc >= 0.5 ? 'text-fb-mid' : 'text-fb-low');
            return '<span class="' + color + ' text-xs font-bold">' + pct + '%</span>';
        }
        return '<span class="text-fb-textDim text-xs">Not started</span>';
    }

    // Unified rank/dB/streak strip (progression spec 010 — replaces the old
    // level/XP meter; lesson completions still earn dB via the unified store).
    function headerXp(prog) {
        const p = prog || { current_streak: 0, best_streak: 0 };
        const progression = (window.v3Progression && window.v3Progression.get()) || null;
        const rank = progression ? progression.mastery_rank : 0;
        const wallet = (progression && progression.wallet) || { balance: 0 };
        return '<div class="bg-fb-card/80 backdrop-blur rounded-xl p-4 border border-fb-border/50 mb-6">' +
            '<div class="flex items-center justify-between gap-4 text-sm text-fb-textDim">' +
            '<span class="text-fb-text font-semibold">Rank ' + rank + '</span>' +
            '<span class="text-fb-gold font-semibold">' + Number(wallet.balance || 0).toLocaleString() + ' dB</span>' +
            '<span class="text-fb-accent">🔥 ' + (p.current_streak || 0) + '-day streak</span>' +
            '<span class="hidden sm:inline">Best: ' + (p.best_streak || 0) + '</span></div></div>';
    }

    function pageWrap(inner) {
        return '<div class="max-w-5xl mx-auto px-6 md:px-8 pb-8">' + inner + '</div>';
    }
    function emptyState(title, body, ctaLabel, ctaScreen) {
        return pageWrap(
            '<h2 class="text-3xl font-bold text-fb-text mb-6">Lessons</h2>' +
            '<div class="bg-fb-card/80 backdrop-blur rounded-xl p-8 border border-fb-border/50 text-center">' +
            '<div class="text-4xl mb-3">🎓</div>' +
            '<h3 class="text-xl font-bold text-fb-text mb-1">' + esc(title) + '</h3>' +
            '<p class="text-fb-textDim text-sm">' + esc(body) + '</p>' +
            (ctaLabel ? '<button data-go="' + esc(ctaScreen) + '" class="mt-4 bg-fb-primary hover:bg-fb-primaryHi text-white px-5 py-2 rounded-md font-medium shadow-lg shadow-fb-primary/20">' + esc(ctaLabel) + '</button>' : '') +
            '</div>');
    }

    // ── catalog view ─────────────────────────────────────────────────────---
    async function renderCatalog(root, prog) {
        // /packs returns { packs: [...] }; tolerate a bare array too.
        const res = await jget(API + '/packs');
        const packs = res && Array.isArray(res.packs) ? res.packs : (Array.isArray(res) ? res : null);
        if (!packs) {
            root.innerHTML = emptyState('Lessons aren’t installed yet',
                'The Tutorials plugin isn’t active. Enable it from the Plugins page to unlock guided lessons.',
                'Open Plugins', 'v3-plugins');
            wireGo(root);
            return;
        }
        if (!packs.length) {
            root.innerHTML = pageWrap(
                '<h2 class="text-3xl font-bold text-fb-text mb-6">Lessons</h2>' + headerXp(prog) +
                '<div class="bg-fb-card/80 backdrop-blur rounded-xl p-8 border border-fb-border/50 text-center text-fb-textDim text-sm">No lesson packs installed yet.</div>');
            return;
        }
        const cards = packs.map((pk) => {
            const total = pk.lesson_count || 0;
            // Pack summaries don't carry per-lesson ids, so progress count uses
            // the progress store keyed by this pack (passed lessons we know of).
            const ps = (state.progress && state.progress.packs && state.progress.packs[pk.id]) || {};
            const passed = ps.lessons ? Object.values(ps.lessons).filter((l) => l && l.passed).length : 0;
            const cover = pk.cover_url
                ? '<img src="' + esc(pk.cover_url) + '" alt="" class="w-full h-full object-cover" onerror="this.style.visibility=\'hidden\'">'
                : '<div class="w-full h-full flex items-center justify-center text-4xl text-fb-textDim/40">🎸</div>';
            const cont = passed > 0 && passed < total;
            return '<div class="group bg-fb-card/80 backdrop-blur rounded-xl border border-fb-border/50 overflow-hidden flex flex-col">' +
                '<button data-pack="' + esc(pk.id) + '" class="relative block aspect-video bg-fb-cardMuted overflow-hidden text-left">' +
                cover + '<div class="absolute inset-0 bg-gradient-to-t from-black/70 to-transparent"></div></button>' +
                '<div class="p-4 flex flex-col flex-1 gap-3">' +
                '<button data-pack="' + esc(pk.id) + '" class="text-left">' +
                '<div class="text-fb-text font-bold truncate">' + esc(pk.title) + '</div>' +
                '<div class="text-xs text-fb-textDim truncate">' + esc(pk.author || '') + ' · ' + total + ' lesson' + (total === 1 ? '' : 's') + '</div></button>' +
                techChips(pk.techniques, 5) +
                progressBar(passed, total) +
                '<div class="flex gap-2 mt-auto pt-1">' +
                '<button data-start-pack="' + esc(pk.id) + '" class="flex-1 bg-fb-primary hover:bg-fb-primaryHi text-white text-sm px-4 py-2 rounded-md font-medium shadow-lg shadow-fb-primary/20">' + (cont ? 'Continue' : 'Start') + '</button>' +
                '<button data-pack="' + esc(pk.id) + '" class="bg-transparent border border-fb-textDim hover:border-white text-white text-sm px-4 py-2 rounded-md">View</button>' +
                '</div></div></div>';
        }).join('');

        root.innerHTML = pageWrap(
            '<h2 class="text-3xl font-bold text-fb-text mb-6">Lessons</h2>' + headerXp(prog) +
            '<div class="grid sm:grid-cols-2 lg:grid-cols-3 gap-6">' + cards + '</div>');

        root.querySelectorAll('[data-pack]').forEach((b) =>
            b.addEventListener('click', () => openPack(b.getAttribute('data-pack'))));
        root.querySelectorAll('[data-start-pack]').forEach((b) =>
            b.addEventListener('click', () => startPackById(b.getAttribute('data-start-pack'))));
    }

    // ── pack detail view ─────────────────────────────────────────────────---
    async function renderPack(root, prog, packId) {
        const pack = await jget(API + '/packs/' + enc(packId));
        if (!pack || !Array.isArray(pack.lessons)) {
            // Pack vanished (uninstalled / bad id) — fall back to the catalog.
            state.view = { kind: 'catalog' };
            return renderCatalog(root, prog);
        }
        const lessons = pack.lessons;
        const passed = packPassedCount(pack);
        const cover = pack.cover_url
            ? '<img src="' + esc(pack.cover_url) + '" alt="" class="w-full h-full object-cover" onerror="this.style.visibility=\'hidden\'">'
            : '<div class="w-full h-full flex items-center justify-center text-4xl text-fb-textDim/40">🎸</div>';
        const next = nextLesson(pack);
        const contLabel = passed > 0 && passed < lessons.length ? 'Continue' : 'Start';

        const rows = lessons.map((l, i) => {
            const thumb = l.thumb_url
                ? '<img src="' + esc(l.thumb_url) + '" alt="" class="w-full h-full object-cover" onerror="this.style.visibility=\'hidden\'">'
                : '<div class="w-full h-full flex items-center justify-center text-fb-textDim/40">' + (i + 1) + '</div>';
            const st = lessonState(packId, l.id);
            const label = st && st.passed ? 'Replay' : 'Start';
            return '<div class="flex items-center gap-4 bg-fb-card/60 border border-fb-border/50 rounded-lg p-3">' +
                '<div class="w-20 h-12 rounded bg-fb-cardMuted overflow-hidden flex-shrink-0 text-xs">' + thumb + '</div>' +
                '<div class="flex-1 min-w-0">' +
                '<div class="text-fb-text font-medium truncate">' + esc(l.title || ('Lesson ' + (i + 1))) + '</div>' +
                '<div class="mt-1">' + techChips(l.techniques, 5) + '</div></div>' +
                '<div class="flex-shrink-0 mr-2">' + lessonStatus(packId, l.id) + '</div>' +
                '<button data-lesson="' + esc(l.id) + '" class="flex-shrink-0 bg-fb-primary hover:bg-fb-primaryHi text-white text-sm px-4 py-2 rounded-md font-medium">' + label + '</button>' +
                '</div>';
        }).join('');

        root.innerHTML = pageWrap(
            '<button data-back class="text-sm text-fb-textDim hover:text-fb-text mb-4 flex items-center gap-1">&larr; All lessons</button>' +
            headerXp(prog) +
            '<div class="bg-fb-card/80 backdrop-blur rounded-xl border border-fb-border/50 overflow-hidden mb-6">' +
            '<div class="relative aspect-[3/1] bg-fb-cardMuted overflow-hidden">' + cover +
            '<div class="absolute inset-0 bg-gradient-to-t from-black/80 to-transparent"></div>' +
            '<div class="absolute bottom-0 left-0 p-5">' +
            '<h2 class="text-3xl font-bold text-fb-text">' + esc(pack.title) + '</h2>' +
            '<div class="text-sm text-fb-textDim">' + esc(pack.author || '') + '</div></div></div>' +
            '<div class="p-5 space-y-3">' + techChips(pack.techniques, 12) +
            progressBar(passed, lessons.length) +
            (next ? '<button data-lesson="' + esc(next.id) + '" class="bg-fb-primary hover:bg-fb-primaryHi text-white px-6 py-2 rounded-md font-medium shadow-lg shadow-fb-primary/20">' + contLabel + ' pack</button>' : '') +
            '</div></div>' +
            '<div class="space-y-3">' + rows + '</div>');

        root.querySelector('[data-back]')?.addEventListener('click', () => { state.view = { kind: 'catalog' }; render(); });
        root.querySelectorAll('[data-lesson]').forEach((b) =>
            b.addEventListener('click', () => launchLesson(packId, b.getAttribute('data-lesson'))));
    }

    // ── navigation into the plugin's own lesson view ─────────────────────---
    function launchLesson(packId, lessonId) {
        if (!packId || !lessonId) return;
        // When the lesson's song auto-exits (or the player is closed), return
        // to the lessons catalog to pick the next one — not the song library.
        // playSong() consumes this one-shot override even though the external
        // tutorials plugin owns the actual playSong call. The legitimate path
        // is lessons → plugin-tutorials → player; if the launch is abandoned
        // (plugin missing, deep-link fails, user backs out) the override would
        // otherwise linger and mis-route the next library song. So clear it on
        // the first navigation that leaves the launch flow (any screen other
        // than the tutorials waypoint or the player that consumes it).
        try {
            if (window.feedBack && typeof window.feedBack.setReturnScreen === 'function') {
                window.feedBack.setReturnScreen('v3-lessons');
                if (sm && typeof sm.on === 'function' && typeof sm.off === 'function') {
                    const clearStale = (e) => {
                        const id = e && e.detail && e.detail.id;
                        if (id === 'plugin-tutorials') return; // expected waypoint — keep waiting
                        // 'player' means playSong already consumed the override;
                        // anything else means the launch was abandoned.
                        if (id !== 'player' && window.feedBack._nextReturnScreen === 'v3-lessons') {
                            window.feedBack.setReturnScreen(null);
                        }
                        sm.off('screen:changed', clearStale);
                    };
                    sm.on('screen:changed', clearStale);
                }
            }
        } catch (_e) { /* non-fatal */ }
        // navigate() stores nav params AND calls showScreen(); the tutorials
        // plugin's init() reads getNavParams() to deep-link to {packId, lessonId}.
        if (sm && typeof sm.navigate === 'function') {
            sm.navigate('plugin-tutorials', { packId: packId, lessonId: lessonId });
        } else if (typeof window.showScreen === 'function') {
            // Fallback when navigate() is unavailable: stash the same nav params
            // navigate() would set so the tutorials plugin can still deep-link
            // instead of landing on the generic browse screen.
            if (sm) sm._navParams = { packId: packId, lessonId: lessonId };
            window.showScreen('plugin-tutorials');
        }
    }
    async function startPackById(packId) {
        // Fetch the manifest so we can resolve the pack's next lesson, then launch.
        const pack = await jget(API + '/packs/' + enc(packId));
        const next = pack && Array.isArray(pack.lessons) ? nextLesson(pack) : null;
        if (next) launchLesson(packId, next.id);
        else openPack(packId);
    }
    function openPack(packId) { state.view = { kind: 'pack', packId: packId }; render(); }
    function wireGo(root) {
        root.querySelectorAll('[data-go]').forEach((b) =>
            b.addEventListener('click', () => window.showScreen && window.showScreen(b.getAttribute('data-go'))));
    }

    // ── entry ────────────────────────────────────────────────────────────---
    async function render() {
        const root = document.getElementById('v3-lessons');
        if (!root) return;
        // Refresh unified progress (level/XP/streak) + per-lesson progress every
        // render so XP earned in the plugin shows when the user returns.
        const [prog, tut] = await Promise.all([
            jget('/api/profile/progress'),
            jget(API + '/progress'),
        ]);
        state.progress = tut || { packs: {} };
        if (state.view.kind === 'pack') await renderPack(root, prog, state.view.packId);
        else await renderCatalog(root, prog);
    }

    window.v3Lessons = { render: render };
    if (sm && typeof sm.on === 'function') {
        sm.on('screen:changed', (e) => { if (e && e.detail && e.detail.id === 'v3-lessons') render(); });
        sm.on('v3:profile-updated', () => { if (document.getElementById('v3-lessons')?.classList.contains('active')) render(); });
        // Refresh the header rank/dB strip when progression state changes while
        // the screen is already visible (e.g. after a minigame run on this screen).
        sm.on('progression:updated', () => { if (document.getElementById('v3-lessons')?.classList.contains('active')) render(); });
    }
})();
