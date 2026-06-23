/*
 * fee[dB]ack v0.3.0 — live performance HUD (read-only overlay).
 *
 * Mirrors stats-recorder tallies from note:hit / note:miss events without
 * writing back to scoring. Visual state thresholds are UI-only.
 */
(function (root) {
    'use strict';

    const STATE_CLASSES = ['is-idle', 'is-fire', 'is-strong', 'is-steady', 'is-recovery', 'is-smoke'];

    const STATE_META = Object.freeze({
        idle: { label: 'Waiting for notes', icon: '' },
        fire: { label: 'Hot streak', icon: '\uD83D\uDD25' },
        strong: { label: 'Locked in', icon: '\u2728' },
        steady: { label: 'Solid run', icon: '\uD83D\uDC4D' },
        recovery: { label: 'Recovering', icon: '\uD83D\uDCAA' },
        smoke: { label: 'Shake it off', icon: '\uD83D\uDCA8' },
    });

    function accuracyPct(hits, misses) {
        const judged = hits + misses;
        if (judged <= 0) return null;
        return Math.round((hits / Math.max(1, judged)) * 100);
    }

    function calculateLivePerformanceState({ hits = 0, misses = 0, streak = 0, bestStreak = 0 } = {}) {
        const h = Math.max(0, Number(hits) || 0);
        const m = Math.max(0, Number(misses) || 0);
        const s = Math.max(0, Number(streak) || 0);
        const best = Math.max(0, Number(bestStreak) || 0);
        const judged = h + m;
        const pct = accuracyPct(h, m);

        let state = 'idle';
        if (judged === 0) {
            state = 'idle';
        } else if (pct >= 90 && s >= 10) {
            state = 'fire';
        } else if (pct >= 85) {
            state = 'strong';
        } else if (pct >= 70) {
            state = 'steady';
        } else if (pct >= 50) {
            state = 'recovery';
        } else {
            state = 'smoke';
        }

        const meta = STATE_META[state] || STATE_META.idle;
        return {
            hits: h,
            misses: m,
            streak: s,
            bestStreak: best,
            judged,
            accuracyPct: pct,
            state,
            stateLabel: meta.label,
            stateIcon: meta.icon,
        };
    }

    function formatPercentText(stats) {
        if (!stats || stats.judged === 0 || stats.accuracyPct == null) return '\u2014';
        return String(stats.accuracyPct) + '%';
    }

    function formatHitsText(stats) {
        if (!stats || stats.judged === 0) return 'Waiting for notes';
        return 'Hits ' + stats.hits + ' / ' + stats.judged;
    }

    function formatStreakText(stats) {
        if (!stats) return 'Streak 0';
        return 'Streak ' + stats.streak;
    }

    function formatStateText(stats) {
        if (!stats || stats.judged === 0) return '';
        const icon = stats.stateIcon ? stats.stateIcon + ' ' : '';
        return icon + stats.stateLabel;
    }

    function applyHudClasses(el, state) {
        if (!el || !el.classList) return;
        STATE_CLASSES.forEach((cls) => el.classList.remove(cls));
        if (state) el.classList.add('is-' + state);
    }

    function renderHudDom(els, stats) {
        if (!els) return stats;
        const s = stats || calculateLivePerformanceState();
        if (els.root) applyHudClasses(els.root, s.state);
        if (els.percent) els.percent.textContent = formatPercentText(s);
        if (els.hits) els.hits.textContent = formatHitsText(s);
        if (els.streak) els.streak.textContent = formatStreakText(s);
        if (els.state) {
            els.state.textContent = formatStateText(s);
            if (els.state.setAttribute) {
                els.state.setAttribute('aria-hidden', s.judged === 0 ? 'true' : 'false');
            }
        }
        return s;
    }

    function createCounters() {
        return { hits: 0, misses: 0, streak: 0, bestStreak: 0 };
    }

    function bindRuntime(sm, domEls) {
        if (!sm || typeof sm.on !== 'function') return null;

        let active = false;
        // Stay hidden until the first judged note actually arrives. note:hit /
        // note:miss are emitted only by the notedetect plugin, so users without
        // detection (or with it off) would otherwise see a permanent
        // "Waiting for notes" overlay for the whole song.
        let revealed = false;
        let counters = createCounters();
        const els = domEls || {
            root: typeof document !== 'undefined' ? document.getElementById('v3-live-performance-hud') : null,
            percent: typeof document !== 'undefined' ? document.getElementById('v3-live-performance-percent') : null,
            hits: typeof document !== 'undefined' ? document.getElementById('v3-live-performance-hits') : null,
            streak: typeof document !== 'undefined' ? document.getElementById('v3-live-performance-streak') : null,
            state: typeof document !== 'undefined' ? document.getElementById('v3-live-performance-state') : null,
        };

        function setVisible(show) {
            if (!els.root) return;
            if (show) els.root.classList.remove('hidden');
            else els.root.classList.add('hidden');
        }

        function resetCounters() {
            counters = createCounters();
        }

        function currentStats() {
            return calculateLivePerformanceState(counters);
        }

        function paint() {
            const stats = renderHudDom(els, currentStats());
            try {
                if (sm && typeof sm.emit === 'function') {
                    sm.emit('v3:live-performance-state', {
                        hits: stats.hits,
                        misses: stats.misses,
                        judged: stats.judged,
                        streak: stats.streak,
                        bestStreak: stats.bestStreak,
                        accuracyPct: stats.accuracyPct,
                        state: stats.state,
                    });
                }
            } catch (_) { /* venue mood and other observers must never break HUD */ }
        }

        function reveal() {
            if (!active || revealed) return;
            revealed = true;
            setVisible(true);
        }

        function showSession() {
            active = true;
            revealed = false;
            resetCounters();
            // Primed but hidden — reveal() on the first note:hit/note:miss.
            setVisible(false);
            paint();
        }

        function hideSession() {
            active = false;
            revealed = false;
            resetCounters();
            setVisible(false);
            paint();
        }

        function onHit() {
            if (!active) return;
            reveal();
            counters.hits++;
            counters.streak++;
            if (counters.streak > counters.bestStreak) counters.bestStreak = counters.streak;
            paint();
        }

        function onMiss() {
            if (!active) return;
            reveal();
            counters.misses++;
            counters.streak = 0;
            paint();
        }

        sm.on('song:loading', () => { showSession(); });
        sm.on('song:arrangement-changed', () => {
            if (!active) return;
            resetCounters();
            paint();
        });
        sm.on('song:stop', () => { hideSession(); });
        sm.on('song:ended', () => { hideSession(); });
        sm.on('note:hit', onHit);
        sm.on('note:miss', onMiss);

        return {
            getCounters: () => ({ ...counters }),
            getStats: currentStats,
            isActive: () => active,
            showSession,
            hideSession,
            onHit,
            onMiss,
            paint,
            els,
        };
    }

    const api = {
        STATE_CLASSES,
        STATE_META,
        accuracyPct,
        calculateLivePerformanceState,
        formatPercentText,
        formatHitsText,
        formatStreakText,
        formatStateText,
        applyHudClasses,
        renderHudDom,
        bindRuntime,
    };

    if (root) root.v3LivePerformanceHud = api;
    if (typeof module !== 'undefined' && module.exports) module.exports = api;

    if (typeof document !== 'undefined') {
        const boot = () => {
            const sm = root && root.feedBack;
            if (sm) bindRuntime(sm);
        };
        if (document.readyState === 'loading') {
            document.addEventListener('DOMContentLoaded', boot);
        } else {
            boot();
        }
    }
}(typeof window !== 'undefined' ? window : null));
