/*
 * fee[dB]ack v0.3.0 — Progress screen (spec 010).
 *
 * Mastery Rank hero, per-path challenge checklists ("x of y to level up"),
 * the calibration challenge card, add-a-path tiles, daily/weekly quests with
 * reset countdowns, and the Decibels balance with a shop link. State comes
 * from window.v3Progression (progression-core.js); re-renders on
 * `progression:updated` and on screen activation.
 *
 * Vanilla JS, no framework (constitution P-II).
 */
(function () {
    'use strict';
    const sm = window.feedBack;
    const SCREEN_ID = 'v3-progress';

    const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => (
        { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

    const fmtDb = (n) => Number(n || 0).toLocaleString() + ' dB';

    function resetsIn(iso) {
        const t = new Date(iso).getTime();
        if (!Number.isFinite(t)) return '';
        let mins = Math.max(0, Math.round((t - Date.now()) / 60000));
        const days = Math.floor(mins / 1440); mins -= days * 1440;
        const hours = Math.floor(mins / 60); mins -= hours * 60;
        if (days > 0) return 'resets in ' + days + 'd ' + hours + 'h';
        if (hours > 0) return 'resets in ' + hours + 'h ' + mins + 'm';
        return 'resets in ' + mins + 'm';
    }

    function progressBar(count, target, done) {
        const pct = target > 0 ? Math.min(100, Math.round((count / target) * 100)) : 0;
        return '<div class="w-full h-1.5 rounded-full bg-black/40 overflow-hidden">' +
            '<span class="block h-full ' + (done ? 'bg-fb-good' : 'bg-fb-primary') + '" style="width:' + pct + '%"></span></div>';
    }

    const checkIcon = '<svg class="w-5 h-5 text-fb-good shrink-0" fill="none" stroke="currentColor" stroke-width="2.5" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M5 13l4 4L19 7"/></svg>';

    function challengeRow(c) {
        return '<div class="flex items-start gap-3 py-2">' +
            (c.completed
                ? checkIcon
                : '<span class="w-5 h-5 rounded-full border-2 border-fb-border shrink-0 mt-0.5"></span>') +
            '<div class="flex-1 min-w-0">' +
            '<div class="flex items-baseline justify-between gap-2">' +
            '<span class="text-sm font-medium ' + (c.completed ? 'text-fb-textDim line-through' : 'text-fb-text') + '">' + esc(c.title) + '</span>' +
            '<span class="text-xs text-fb-textDim shrink-0">' + c.count + '/' + c.target + '</span></div>' +
            '<p class="text-xs text-fb-textDim mt-0.5">' + esc(c.description) + '</p>' +
            (c.completed ? '' : '<div class="mt-1.5">' + progressBar(c.count, c.target, false) + '</div>') +
            '</div></div>';
    }

    function pathCard(p) {
        let body;
        if (p.next) {
            const remaining = Math.max(0, p.next.required - p.next.completed);
            body = '<p class="text-xs text-fb-textDim mb-1">Level ' + p.next.level + ' — complete ' +
                '<span class="text-fb-text font-semibold">' + remaining + '</span> more challenge' + (remaining === 1 ? '' : 's') +
                ' (' + p.next.completed + ' of ' + p.next.required + ' done)</p>' +
                '<div class="divide-y divide-fb-border/30">' + p.next.challenges.map(challengeRow).join('') + '</div>';
        } else {
            body = '<p class="text-sm text-fb-gold font-semibold mt-1">Path mastered — max level reached!</p>';
        }
        return '<div class="bg-fb-card/80 backdrop-blur rounded-xl p-5 border border-fb-border/50">' +
            '<div class="flex items-center justify-between mb-3">' +
            '<h3 class="text-lg font-bold text-fb-text">' + esc(p.name) + '</h3>' +
            '<span class="text-sm font-semibold text-fb-primary">Level ' + p.level + '<span class="text-fb-textDim font-normal"> / ' + p.max_level + '</span></span>' +
            '</div>' + body + '</div>';
    }

    function questRow(q) {
        return '<div class="flex items-start gap-3 py-2">' +
            (q.completed
                ? checkIcon
                : '<span class="w-5 h-5 rounded-full border-2 border-fb-border shrink-0 mt-0.5"></span>') +
            '<div class="flex-1 min-w-0">' +
            '<div class="flex items-baseline justify-between gap-2">' +
            '<span class="text-sm font-medium ' + (q.completed ? 'text-fb-textDim line-through' : 'text-fb-text') + '">' + esc(q.title) + '</span>' +
            '<span class="text-xs font-semibold text-fb-gold shrink-0">+' + Number(q.reward_db || 0).toLocaleString() + ' dB</span></div>' +
            '<p class="text-xs text-fb-textDim mt-0.5">' + esc(q.description) + ' <span class="text-fb-textDim/70">(' + q.count + '/' + q.target + ')</span></p>' +
            (q.completed ? '' : '<div class="mt-1.5">' + progressBar(q.count, q.target, false) + '</div>') +
            '</div></div>';
    }

    function questCard(title, block) {
        if (!block) return '';
        const rows = (block.quests || []).map(questRow).join('') ||
            '<p class="text-sm text-fb-textDim py-2">No quests available.</p>';
        return '<div class="bg-fb-card/80 backdrop-blur rounded-xl p-5 border border-fb-border/50">' +
            '<div class="flex items-center justify-between mb-1">' +
            '<h3 class="text-lg font-bold text-fb-text">' + title + '</h3>' +
            '<span class="text-xs text-fb-textDim">' + esc(resetsIn(block.resets_at)) + '</span></div>' +
            '<div class="divide-y divide-fb-border/30">' + rows + '</div></div>';
    }

    function calibrationCard(onboarding) {
        if (!onboarding || onboarding.calibration_status === 'completed') return '';
        const pending = onboarding.calibration_status === 'pending';
        return '<div class="bg-fb-card/80 backdrop-blur rounded-xl p-5 border ' +
            (pending ? 'border-fb-primary/50' : 'border-fb-border/50') + '">' +
            '<div class="flex items-center justify-between gap-3 flex-wrap">' +
            '<div class="min-w-0">' +
            '<h3 class="text-lg font-bold text-fb-text">Calibration challenge</h3>' +
            '<p class="text-sm text-fb-textDim mt-1">Play the <span class="text-fb-text">fee[dB]ack Diagnostic</span> with note detection and finish at ' +
            '<span class="text-fb-text font-semibold">100% accuracy</span>' +
            (pending ? ' to reach Mastery Rank 1.' : ' to prove your setup (you skipped this — rank already granted).') + '</p></div>' +
            '<div class="flex items-center gap-2 shrink-0">' +
            '<button type="button" data-prog-calibrate class="bg-fb-primary hover:bg-fb-primaryHi text-white text-sm font-medium px-4 py-2 rounded-md transition-colors">Play it now</button>' +
            (pending ? '<button type="button" data-prog-skip class="text-sm text-fb-textDim hover:text-fb-text px-3 py-2">Skip for now</button>' : '') +
            '</div></div></div>';
    }

    function addPathCard(available) {
        if (!available || !available.length) return '';
        return '<div class="bg-fb-card/80 backdrop-blur rounded-xl p-5 border border-fb-border/50 border-dashed">' +
            '<h3 class="text-sm font-semibold text-fb-textDim uppercase tracking-wider mb-3">Start a new path</h3>' +
            '<div class="flex flex-wrap gap-2">' +
            available.map((p) =>
                '<button type="button" data-prog-add-path="' + esc(p.id) + '" ' +
                'class="bg-fb-bg/40 hover:bg-fb-card border border-fb-border/50 hover:border-fb-primary/50 text-fb-text text-sm font-medium px-4 py-2 rounded-lg transition-colors">+ ' + esc(p.name) + '</button>'
            ).join('') + '</div></div>';
    }

    function render() {
        const root = document.getElementById(SCREEN_ID);
        if (!root) return;
        const st = window.v3Progression && window.v3Progression.get();
        if (!st) {
            root.innerHTML = '<div class="max-w-5xl mx-auto p-6 md:p-8"><p class="text-sm text-fb-textDim">Loading progress…</p></div>';
            return;
        }
        const wallet = st.wallet || { balance: 0, lifetime_db: 0 };
        root.innerHTML =
            '<div class="max-w-5xl mx-auto p-6 md:p-8 space-y-6">' +
            // Hero: rank + wallet
            '<div class="bg-fb-card/80 backdrop-blur rounded-xl p-6 border border-fb-border/50 flex flex-col sm:flex-row items-center gap-6">' +
            '<div class="text-center sm:text-left flex-1">' +
            '<div class="text-xs uppercase tracking-wider text-fb-textDim">Mastery Rank</div>' +
            '<div class="text-6xl font-extrabold text-fb-text leading-none mt-1">' + st.mastery_rank + '</div>' +
            '<p class="text-xs text-fb-textDim mt-2">Onboarding' +
            ((st.onboarding || {}).calibration_status === 'pending' ? ' (0)' : ' (1)') +
            (st.paths || []).map((p) => ' + ' + esc(p.name) + ' (' + p.level + ')').join('') + '</p></div>' +
            '<div class="text-center sm:text-right">' +
            '<div class="text-xs uppercase tracking-wider text-fb-textDim">Decibels</div>' +
            '<div class="text-3xl font-bold text-fb-gold mt-1">' + fmtDb(wallet.balance) + '</div>' +
            '<div class="text-xs text-fb-textDim mt-1">' + fmtDb(wallet.lifetime_db) + ' earned lifetime</div>' +
            '<button type="button" data-prog-shop class="mt-2 text-sm text-fb-primary hover:text-fb-primaryHi font-medium">Open Unlockables →</button>' +
            '</div></div>' +
            calibrationCard(st.onboarding) +
            // Paths
            ((st.paths || []).length
                ? '<div class="grid md:grid-cols-2 gap-4">' + st.paths.map(pathCard).join('') + '</div>'
                : '<div class="bg-fb-card/80 rounded-xl p-5 border border-fb-border/50"><p class="text-sm text-fb-textDim">Pick an instrument path below to start earning Mastery Rank.</p></div>') +
            addPathCard(st.available_paths) +
            // Quests
            '<div class="grid md:grid-cols-2 gap-4">' +
            questCard('Daily quests', (st.quests || {}).daily) +
            questCard('Weekly quests', (st.quests || {}).weekly) +
            '</div></div>';

        const shopBtn = root.querySelector('[data-prog-shop]');
        if (shopBtn) shopBtn.addEventListener('click', () => window.showScreen && window.showScreen('v3-shop'));
        const cal = root.querySelector('[data-prog-calibrate]');
        if (cal) cal.addEventListener('click', () => {
            const fn = (st.onboarding || {}).diagnostic_filename;
            if (fn && typeof window.playSong === 'function') window.playSong(fn);
        });
        const skip = root.querySelector('[data-prog-skip]');
        if (skip) skip.addEventListener('click', async () => {
            try {
                const res = await fetch('/api/progression/onboarding', {
                    method: 'POST', headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ action: 'skip' }),
                });
                if (res.ok) window.v3Progression && window.v3Progression.refresh();
            } catch (e) { /* offline */ }
        });
        root.querySelectorAll('[data-prog-add-path]').forEach((b) => {
            b.addEventListener('click', async () => {
                b.disabled = true;
                try {
                    await fetch('/api/progression/paths', {
                        method: 'POST', headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ add: [b.getAttribute('data-prog-add-path')] }),
                    });
                } catch (e) { /* offline */ }
                window.v3Progression && window.v3Progression.refresh();
            });
        });
    }

    function launchDiagnostic(onboarding) {
        const fn = (onboarding || {}).diagnostic_filename;
        if (fn && typeof window.playSong === 'function') window.playSong(fn);
    }

    function priorCalibrationStatus(detail) {
        // Honor an explicit prior_calibration_status even when it is null (the
        // emitter always includes it). Truthiness would treat null as "missing"
        // and fall back to the cached state, which may already have flipped to
        // 'completed' in racey delivery paths — suppressing the success overlay.
        if (detail && Object.prototype.hasOwnProperty.call(detail, 'prior_calibration_status')) {
            return detail.prior_calibration_status;
        }
        const st = (window.v3Progression && window.v3Progression.get()) || {};
        return (st.onboarding || {}).calibration_status;
    }

    // ── Calibration success prompt ───────────────────────────────────────────
    // Fired when progression reports calibration_completed (100% diagnostic).
    // Reads prior onboarding status before async refresh lands so pending vs
    // skipped copy stays accurate.
    function showCalibrationSuccess(detail) {
        if (document.getElementById('v3-calibration-success')) return;
        document.getElementById('v3-calibration-retry')?.remove();
        const prior = priorCalibrationStatus(detail || {});
        if (prior === 'completed') return;

        const pending = prior === 'pending';
        const skipped = prior === 'skipped';
        let body;
        if (pending) {
            body = 'You finished Basic Guitar Diagnostic at <span class="text-fb-text font-semibold">100% accuracy</span>. Mastery Rank 1 is ready.';
        } else if (skipped) {
            body = 'You finished Basic Guitar Diagnostic at <span class="text-fb-text font-semibold">100% accuracy</span>. Your input and note detection setup is verified.';
        } else {
            body = 'You finished Basic Guitar Diagnostic at <span class="text-fb-text font-semibold">100% accuracy</span>. Your setup is verified.';
        }

        const st = (window.v3Progression && window.v3Progression.get()) || {};
        const onboarding = st.onboarding || {};

        const overlay = document.createElement('div');
        overlay.id = 'v3-calibration-success';
        overlay.className = 'fixed inset-0 z-[200] bg-black/60 backdrop-blur-sm flex items-center justify-center p-4';
        overlay.innerHTML =
            '<div class="bg-fb-card rounded-xl border border-fb-border/50 w-full max-w-md p-6 space-y-4 text-center">' +
            '<div class="text-4xl text-fb-good">✓</div>' +
            '<h3 class="text-xl font-bold text-fb-text">Setup verified!</h3>' +
            '<p class="text-sm text-fb-textDim">' + body + '</p>' +
            '<div class="flex items-center justify-center gap-3 flex-wrap">' +
            '<button type="button" data-cal-success-continue class="bg-fb-primary hover:bg-fb-primaryHi text-white text-sm font-medium px-5 py-2 rounded-md transition-colors">Continue</button>' +
            (skipped ? '<button type="button" data-cal-success-replay class="text-sm text-fb-textDim hover:text-fb-text px-3 py-2">Play again</button>' : '') +
            '</div></div>';
        document.body.appendChild(overlay);

        overlay.querySelector('[data-cal-success-continue]').addEventListener('click', () => overlay.remove());
        const replay = overlay.querySelector('[data-cal-success-replay]');
        if (replay) replay.addEventListener('click', () => {
            overlay.remove();
            launchDiagnostic(onboarding);
        });
    }

    // ── Calibration retry prompt ─────────────────────────────────────────────
    // Fired by stats-recorder when the diagnostic sloppak finished scored but
    // below 100% (and calibration isn't completed yet): offer another go, and
    // — while calibration is still pending — the skip-to-Rank-1 escape hatch.
    function showCalibrationRetry(detail) {
        document.getElementById('v3-calibration-retry')?.remove();
        document.getElementById('v3-calibration-success')?.remove();
        const st = (window.v3Progression && window.v3Progression.get()) || {};
        const onboarding = st.onboarding || {};
        if (onboarding.calibration_status === 'completed') return; // raced a 100% run
        const pending = onboarding.calibration_status === 'pending';
        const pct = Math.max(0, Math.min(100, Math.round((detail.accuracy || 0) * 100)));

        const overlay = document.createElement('div');
        overlay.id = 'v3-calibration-retry';
        overlay.className = 'fixed inset-0 z-[200] bg-black/60 backdrop-blur-sm flex items-center justify-center p-4';
        overlay.innerHTML =
            '<div class="bg-fb-card rounded-xl border border-fb-border/50 w-full max-w-md p-6 space-y-4 text-center">' +
            '<div class="text-4xl">🎯</div>' +
            '<h3 class="text-xl font-bold text-fb-text">' + (pct >= 90 ? 'So close!' : 'Calibration not passed') + '</h3>' +
            '<p class="text-sm text-fb-textDim">You finished the calibration run at ' +
            '<span class="text-fb-text font-semibold">' + pct + '%</span> — it takes ' +
            '<span class="text-fb-text font-semibold">100%</span> to complete' +
            (pending ? ' and reach Mastery Rank 1' : '') + '. Want another go?</p>' +
            '<div class="flex items-center justify-center gap-3 flex-wrap">' +
            '<button type="button" data-cal-retry class="bg-fb-primary hover:bg-fb-primaryHi text-white text-sm font-medium px-5 py-2 rounded-md transition-colors">Try again</button>' +
            (pending ? '<button type="button" data-cal-skip class="text-sm text-fb-textDim hover:text-fb-text px-3 py-2">Skip — take Rank 1</button>' : '') +
            '<button type="button" data-cal-close class="text-sm text-fb-textDim hover:text-fb-text px-3 py-2">Not now</button>' +
            '</div></div>';
        document.body.appendChild(overlay);

        overlay.querySelector('[data-cal-retry]').addEventListener('click', () => {
            overlay.remove();
            launchDiagnostic(onboarding);
        });
        const skip = overlay.querySelector('[data-cal-skip]');
        if (skip) skip.addEventListener('click', async () => {
            skip.disabled = true;
            try {
                await fetch('/api/progression/onboarding', {
                    method: 'POST', headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ action: 'skip' }),
                });
            } catch (e) { /* offline — still skippable from the Progress screen */ }
            overlay.remove();
            window.v3Progression && window.v3Progression.refresh();
        });
        overlay.querySelector('[data-cal-close]').addEventListener('click', () => overlay.remove());
    }

    function boot() {
        render();
        if (sm && typeof sm.on === 'function') {
            sm.on('progression:updated', render);
            sm.on('progression:calibration-attempt', (e) => showCalibrationRetry((e && e.detail) || {}));
            sm.on('progression:calibration-completed', (e) => {
                showCalibrationSuccess((e && e.detail) || {});
            });
            sm.on('screen:changed', (e) => {
                if (e && e.detail && e.detail.id === SCREEN_ID) {
                    window.v3Progression && window.v3Progression.refresh();
                    render();
                }
            });
        }
    }
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', boot, { once: true });
    } else {
        boot();
    }
})();
