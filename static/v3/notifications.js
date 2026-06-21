/*
 * fee[dB]ack v0.3.0 — achievement notifications (toasts).
 *
 * A small, reusable toast surface (window.fbNotify) plus the progression wiring
 * that turns progression:* lifecycle events into fancy in-app notifications:
 *
 *   quest-progressed  → subtle "Quest advanced — N/M"
 *   quest-completed   → celebratory "Quest Complete! +N dB"
 *   path-progressed   → subtle "{Path}: challenge done — N/M to Level X"
 *   path-level-up     → celebratory "{Path} reached Level X!"
 *   rank-changed (up) → celebratory "Mastery Rank X!"
 *
 * Vanilla JS, no framework (constitution P-II). Animation + accent colors are
 * inline styles so the prebuilt Tailwind stylesheet needs no new utilities.
 * Self-contained: it subscribes through window.slopsmith.on, degrading to a
 * no-op when the bus or DOM isn't present (SSR/headless safety, P15).
 */
(function () {
    'use strict';

    const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => (
        { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

    function container() {
        let host = document.getElementById('fb-notify-stack');
        if (!host) {
            host = document.createElement('div');
            host.id = 'fb-notify-stack';
            // Bottom-right stack, newest on top; clicks pass through the gaps.
            host.className = 'fixed bottom-4 right-4 z-[120] flex flex-col gap-2 items-end pointer-events-none';
            host.style.maxWidth = 'min(24rem, calc(100vw - 2rem))';
            document.body.appendChild(host);
        }
        return host;
    }

    // opts: { title, message, icon, accent, reward, big, durationMs }
    function show(opts) {
        opts = opts || {};
        if (typeof document === 'undefined' || !document.body) return null;
        const host = container();
        const accent = opts.accent || '#3B82F6';
        const big = !!opts.big;

        const card = document.createElement('div');
        card.className = 'pointer-events-auto bg-fb-card border border-fb-border/60 rounded-xl shadow-xl ' +
            'flex items-center gap-3 ' + (big ? 'px-4 py-3' : 'px-3 py-2');
        card.style.borderLeft = '4px solid ' + accent;
        card.style.opacity = '0';
        card.style.transform = 'translateY(12px)';
        card.style.transition = 'transform .35s cubic-bezier(.2,.8,.2,1), opacity .35s';

        const iconSize = big ? 'w-10 h-10 text-xl' : 'w-8 h-8 text-base';
        const icon = '<span class="' + iconSize + ' shrink-0 rounded-lg inline-flex items-center justify-center" ' +
            'style="background-color:' + accent + '22">' + esc(opts.icon || '⭐') + '</span>';

        const reward = (opts.reward != null && Number(opts.reward) > 0)
            ? '<span class="block text-xs font-semibold text-fb-gold mt-0.5">+' +
              Number(opts.reward).toLocaleString() + ' dB</span>'
            : '';
        const body = '<span class="min-w-0 flex-1">' +
            '<span class="block ' + (big ? 'text-sm font-bold' : 'text-xs font-semibold') +
            ' text-fb-text truncate">' + esc(opts.title || '') + '</span>' +
            (opts.message ? '<span class="block text-xs text-fb-textDim truncate">' + esc(opts.message) + '</span>' : '') +
            reward + '</span>';

        card.innerHTML = icon + body;
        host.insertBefore(card, host.firstChild);   // newest on top of the stack

        // Animate in on the next frame (double rAF so the initial style applies).
        requestAnimationFrame(() => requestAnimationFrame(() => {
            card.style.opacity = '1';
            card.style.transform = 'translateY(0)';
        }));

        const dur = opts.durationMs || (big ? 5200 : 3200);
        const dismiss = () => {
            if (card._done) return;
            card._done = true;
            clearTimeout(card._t);
            card.style.opacity = '0';
            card.style.transform = 'translateY(8px)';
            setTimeout(() => { try { card.remove(); } catch (e) { /* already gone */ } }, 360);
        };
        card.addEventListener('click', dismiss);
        card._t = setTimeout(dismiss, dur);
        return card;
    }

    function clear() {
        const host = document.getElementById('fb-notify-stack');
        if (host) host.innerHTML = '';
    }

    window.fbNotify = { show: show, clear: clear };

    // ── Progression wiring ────────────────────────────────────────────────────
    const sm = window.slopsmith;
    if (!sm || typeof sm.on !== 'function') return;   // no bus → toasts API still usable

    const periodLabel = (p) => (p === 'weekly' ? 'Weekly Quest' : p === 'daily' ? 'Daily Quest' : 'Quest');
    const pathName = (id, fallback) => {
        const prog = (window.v3Progression && window.v3Progression.get()) || null;
        const hit = ((prog && prog.paths) || []).find((p) => p && p.id === id);
        return (hit && hit.name) || fallback || 'Path';
    };

    // The bus delivers a CustomEvent; the progression payload is e.detail
    // (matches every other window.slopsmith.on consumer, e.g. progress.js).
    sm.on('progression:quest-progressed', (e) => {
        const q = e && e.detail;
        if (!q) return;
        fbNotify.show({
            icon: '🎯', accent: '#3B82F6',
            title: periodLabel(q.period_type) + ' advanced',
            message: (q.title ? q.title + ' — ' : '') + q.count + '/' + q.target,
        });
    });

    sm.on('progression:quest-completed', (e) => {
        const q = e && e.detail;
        if (!q) return;
        fbNotify.show({
            big: true, icon: '🏆', accent: '#FACC15',
            title: periodLabel(q.period_type) + ' complete!',
            message: q.title || '', reward: q.reward_db,
        });
    });

    sm.on('progression:path-progressed', (e) => {
        const p = e && e.detail;
        if (!p) return;
        fbNotify.show({
            icon: '🎸', accent: '#22C55E',
            title: (p.name || 'Path') + ' progress',
            message: 'Challenge done — ' + p.completed + '/' + p.required + ' to Level ' + p.next_level,
        });
    });

    sm.on('progression:path-level-up', (e) => {
        const l = e && e.detail;
        if (!l) return;
        fbNotify.show({
            big: true, icon: '⭐', accent: '#F97316',
            title: pathName(l.path_id) + ' — Level ' + l.new_level + '!',
            message: 'Instrument path leveled up',
        });
    });

    sm.on('progression:rank-changed', (e) => {
        const r = e && e.detail;
        // Celebrate rank-UPs only (a per-source reset can lower it).
        if (!r || !(Number(r.to) > Number(r.from))) return;
        fbNotify.show({
            big: true, icon: '🏅', accent: '#A855F7',
            title: 'Mastery Rank ' + r.to + '!',
            message: 'Your overall rank went up',
        });
    });
})();
