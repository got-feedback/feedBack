/*
 * fee[dB]ack v0.3.0 — player profile: first-run onboarding overlay, the topbar
 * profile badge, and the #v3-profile screen.
 *
 * Vanilla JS (constitution P-II). Reads /api/profile + /api/profile/progress
 * (one call for the whole badge). Degrades gracefully when stats endpoints
 * (prompt 14) aren't present yet. window.v3Onboarding is defined synchronously
 * so the shell boot (shell.js) can call it regardless of script order.
 */
(function () {
    'use strict';

    let _profile = null;     // {display_name, avatar_url, player_hash, onboarded}
    let _progress = null;    // {level, xp, xp_in_level, xp_to_next, current_streak, best_streak}

    const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => (
        { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

    function avatarImg(url, sizeCls, shape) {
        shape = shape || 'rounded-full';
        if (url) {
            return '<img src="' + esc(url) + '" alt="" class="' + sizeCls + ' ' + shape +
                ' object-cover bg-fb-card border border-fb-border/50">';
        }
        // Neutral fallback glyph.
        return '<span class="' + sizeCls + ' ' + shape + ' bg-fb-card border border-fb-border/50 ' +
            'inline-flex items-center justify-center text-fb-textDim">' +
            '<svg class="w-1/2 h-1/2" fill="none" stroke="currentColor" stroke-width="1.8" viewBox="0 0 24 24">' +
            '<path stroke-linecap="round" stroke-linejoin="round" d="M12 12a4 4 0 100-8 4 4 0 000 8zm-7 8a7 7 0 0114 0"/></svg></span>';
    }

    // ── API ──────────────────────────────────────────────────────────────────
    async function fetchProfile() {
        try { const r = await fetch('/api/profile'); if (r.ok) _profile = await r.json(); } catch (e) { /* P15 */ }
        return _profile;
    }
    async function fetchProgress() {
        try { const r = await fetch('/api/profile/progress'); if (r.ok) _progress = await r.json(); } catch (e) { /* P15 */ }
        return _progress;
    }

    // ── Topbar profile badge ───────────────────────────────────────────────--
    function renderBadge() {
        const host = document.getElementById('v3-badge-profile');
        if (!host) return;
        if (!_profile || !_profile.onboarded) { host.innerHTML = ''; return; }
        const p = _progress || { current_streak: 0 };
        // Progression (spec 010): the badge shows Mastery Rank + Decibels.
        // Layout still matches the Google Stitch "Profile Card Component"
        // (dark rounded card, white avatar tile, flame + "N DAYS"), but the
        // 6-bar equalizer now meters CURRENT CHALLENGE-SET progress (completed
        // challenges across all paths' active sets / required total) and the
        // big number is the Mastery Rank, with the spendable dB balance beside.
        const prog = (window.v3Progression && window.v3Progression.get()) || null;
        const rank = prog ? prog.mastery_rank : 0;
        const balance = prog && prog.wallet ? prog.wallet.balance : 0;
        let challengesDone = 0, challengesRequired = 0;
        ((prog && prog.paths) || []).forEach((path) => {
            if (path.next) {
                challengesDone += Math.min(path.next.completed, path.next.required);
                challengesRequired += path.next.required;
            }
        });
        const flame = '<svg class="w-5 h-5 text-[#FF4B4B]" fill="currentColor" viewBox="0 0 24 24" aria-hidden="true">' +
            '<path d="M17.557 9.414c.18-.73.242-1.501.183-2.29-.325-4.374-4.507-7.124-7.592-7.124-3.085 0-4.27 2.112-3.288 3.876.983 1.764 1.446 3.828.623 5.462-.76.712-1.503.73-2.146 1.054-1.288.65-2.112 1.954-2.112 3.414 0 4.418 3.582 8 8 8s8-3.582 8-8c0-1.85-.63-3.551-1.668-4.892zm-7.411 11.586c-2.209 0-4-1.791-4-4 0-1.398 1.065-2.201 1.065-2.201.272.775 1.015 1.327 1.885 1.327 1.105 0 2-.895 2-2s-.895-2-2-2c-.372 0-.719.102-1.018.277.29-.533.72-1.002 1.258-1.332 1.303-.801 2.94-.8 4.243.001 1.316.809 1.972 2.33 1.972 3.927 0 3.314-2.686 6-6 6z"/></svg>';
        const HEIGHTS = ['h-2', 'h-4', 'h-8', 'h-6', 'h-10', 'h-12'];
        const FILL = ['#3B82F6', '#22C55E', '#FACC15', '#F97316', '#D1D5DB', '#22C55E'];
        const filled = challengesRequired > 0
            ? Math.max(0, Math.min(6, Math.round((challengesDone / challengesRequired) * 6))) : 0;
        const bars = HEIGHTS.map((h, i) =>
            '<div class="w-2 ' + h + ' rounded-sm" style="background-color:' + (i < filled ? FILL[i] : '#3f3f46') + '"></div>').join('');
        host.innerHTML =
            '<button type="button" data-v3-open-profile class="bg-fb-card border border-fb-border/50 text-white rounded-2xl flex items-center gap-3 p-2 pr-3 shadow-lg ' +
            'hover:ring-1 hover:ring-fb-primary/40 transition" title="Profile">' +
            '<div data-v3-avatar-tile class="bg-white w-12 h-12 rounded-xl overflow-hidden flex items-center justify-center shrink-0">' +
            (_profile.avatar_url
                ? '<img alt="User Avatar" src="' + esc(_profile.avatar_url) + '" class="w-full h-full object-cover object-center" onerror="this.style.visibility=\'hidden\'">'
                : '<svg class="w-2/3 h-2/3 text-gray-400" fill="none" stroke="currentColor" stroke-width="1.8" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M12 12a4 4 0 100-8 4 4 0 000 8zm-7 8a7 7 0 0114 0"/></svg>') +
            '</div>' +
            '<div class="flex flex-col justify-between py-0.5">' +
            '<div class="flex items-center gap-1.5 mb-1">' + flame +
            '<span class="text-base font-extrabold tracking-tight leading-none">' + (p.current_streak || 0) + ' DAYS</span></div>' +
            '<div class="flex items-end gap-2">' +
            '<div class="flex flex-col leading-none">' +
            '<span class="text-gray-400 text-[10px] font-medium">Rank:</span>' +
            '<span class="text-xl font-bold leading-none">' + rank + '</span></div>' +
            '<div class="flex items-end gap-1">' + bars + '</div>' +
            '<span class="text-[10px] font-semibold text-fb-gold leading-none">' + Number(balance).toLocaleString() + ' dB</span>' +
            '</div></div></button>';
        // Equipped avatar frame (spec 010 cosmetics).
        if (window.v3Theme && typeof window.v3Theme.applyFrame === 'function') {
            window.v3Theme.applyFrame(host.querySelector('[data-v3-avatar-tile]'));
        }
        const btn = host.querySelector('[data-v3-open-profile]');
        if (btn) btn.addEventListener('click', () => window.showScreen && window.showScreen('v3-profile'));
    }

    // ── Profile screen (#v3-profile) ────────────────────────────────────────-
    function renderProfileScreen() {
        const root = document.getElementById('v3-profile');
        if (!root) return;
        const p = _progress || { current_streak: 0, best_streak: 0 };
        const name = (_profile && _profile.display_name) || 'Player';
        // Progression (spec 010): the profile header shows Mastery Rank,
        // per-path levels, and Decibels (balance + lifetime) — the old
        // XP-level meter is replaced by the rank/challenge system.
        const prog = (window.v3Progression && window.v3Progression.get()) || null;
        const rank = prog ? prog.mastery_rank : 0;
        const wallet = (prog && prog.wallet) || { balance: 0, lifetime_db: 0 };
        const pathChips = ((prog && prog.paths) || []).map((path) =>
            '<span class="inline-flex items-center gap-1 bg-fb-bg/40 border border-fb-border/50 rounded-full px-3 py-1 text-xs text-fb-text">' +
            esc(path.name) + ' <span class="text-fb-primary font-semibold">Lv ' + path.level + '</span></span>').join(' ');
        root.innerHTML =
            '<div class="max-w-4xl mx-auto p-6 md:p-8 space-y-6">' +
            // Header card
            '<div class="bg-fb-card/80 backdrop-blur rounded-xl p-6 border border-fb-border/50 flex flex-col sm:flex-row items-center gap-6">' +
            '<span data-v3-avatar-frame class="inline-block rounded-full">' +
            avatarImg(_profile && _profile.avatar_url, 'w-24 h-24') + '</span>' +
            '<div class="flex-1 w-full text-center sm:text-left">' +
            '<h2 class="text-3xl font-bold text-fb-text">' + esc(name) + '</h2>' +
            '<div class="mt-2 flex items-center justify-center sm:justify-start gap-4 text-sm text-fb-textDim flex-wrap">' +
            '<span class="text-fb-text font-semibold">Mastery Rank ' + rank + '</span>' +
            '<span class="text-fb-gold font-semibold">' + Number(wallet.balance).toLocaleString() + ' dB</span>' +
            '<span>' + Number(wallet.lifetime_db).toLocaleString() + ' dB lifetime</span>' +
            '<span class="text-fb-accent">🔥 ' + (p.current_streak || 0) + '-day streak</span>' +
            '<span>Best: ' + (p.best_streak || 0) + '</span></div>' +
            (pathChips ? '<div class="mt-3 flex items-center justify-center sm:justify-start gap-2 flex-wrap">' + pathChips + '</div>' : '') +
            '<div class="mt-4 flex items-center justify-center sm:justify-start gap-4">' +
            '<button type="button" data-v3-edit-profile class="text-sm text-fb-primary hover:text-fb-primaryHi">Edit name &amp; avatar</button>' +
            '<button type="button" data-v3-open-progress class="text-sm text-fb-primary hover:text-fb-primaryHi">View challenges &amp; quests →</button>' +
            '</div></div></div>' +
            // Per-song bests — top scored songs from /api/stats/top, filled by
            // renderBests() after innerHTML is set. The placeholder text shows
            // during load and when nothing's been scored yet.
            '<div class="bg-fb-card/80 backdrop-blur rounded-xl p-6 border border-fb-border/50">' +
            '<h3 class="text-lg font-bold text-fb-text mb-2">Your best scores</h3>' +
            '<div id="v3-profile-bests" class="text-sm text-fb-textDim">Play a song to start tracking your accuracy and best scores.</div>' +
            '</div>' +
            (_profile && _profile.player_hash
                ? '<p class="text-center text-[10px] uppercase tracking-wider text-fb-textDim/60">player id ' + esc(_profile.player_hash.slice(0, 12)) + '</p>'
                : '') +
            '</div>';
        const edit = root.querySelector('[data-v3-edit-profile]');
        if (edit) edit.addEventListener('click', () => show(_profile, { editing: true }));
        const openProgress = root.querySelector('[data-v3-open-progress]');
        if (openProgress) openProgress.addEventListener('click', () => window.showScreen && window.showScreen('v3-progress'));
        if (window.v3Theme && typeof window.v3Theme.applyFrame === 'function') {
            window.v3Theme.applyFrame(root.querySelector('[data-v3-avatar-frame]'));
        }
        renderBests();
    }

    // Fill the "Your best scores" panel from /api/stats/top (top scored songs,
    // best first). Leaves the placeholder text in place on error / no scores so
    // a fresh profile still reads sensibly. Accuracy is 0–1 (matches the library
    // grid + dashboard badges).
    async function renderBests() {
        const host = document.getElementById('v3-profile-bests');
        if (!host) return;
        let rows = [];
        try { const r = await fetch('/api/stats/top?limit=5'); if (r.ok) rows = await r.json(); } catch (e) { /* P15 — keep placeholder */ }
        if (!Array.isArray(rows) || !rows.length) return;   // keep the placeholder text
        const accColor = (a) => (a >= 0.9 ? 'text-fb-good' : a >= 0.5 ? 'text-fb-mid' : 'text-fb-low');
        host.innerHTML =
            '<ol class="space-y-2">' + rows.map((s, i) => {
                const acc = Number(s.best_accuracy) || 0;
                const pct = Math.round(acc * 100);
                const score = Number(s.best_score) || 0;
                return '<li data-fn="' + esc(s.filename) + '" class="flex items-center gap-3 cursor-pointer rounded-md px-2 py-1.5 hover:bg-fb-card transition">' +
                    '<span class="w-5 text-center text-fb-textDim font-semibold shrink-0">' + (i + 1) + '</span>' +
                    '<span class="flex-1 min-w-0">' +
                    '<span class="block text-fb-text truncate">' + esc(s.title || s.filename) + '</span>' +
                    (s.artist ? '<span class="block text-xs text-fb-textDim truncate">' + esc(s.artist) + '</span>' : '') +
                    '</span>' +
                    '<span class="shrink-0 text-right">' +
                    '<span class="block font-bold ' + accColor(acc) + '">' + pct + '%</span>' +
                    '<span class="block text-xs text-fb-textDim">' + score.toLocaleString() + ' pts</span>' +
                    '</span></li>';
            }).join('') + '</ol>';
        // Click a row to play that song (default arrangement).
        host.querySelectorAll('[data-fn]').forEach((li) => {
            li.addEventListener('click', () => {
                const fn = li.getAttribute('data-fn');
                if (fn && typeof window.playSong === 'function') window.playSong(encodeURIComponent(fn));
            });
        });
    }

    // ── First-run onboarding (and edit) overlay ───────────────────────────────
    // First-run is a 3-step flow (spec 010): 1) name + avatar, 2) pick one or
    // more instrument paths, 3) the calibration challenge offer (play the
    // diagnostic sloppak at 100% — or skip and reach Mastery Rank 1 anyway).
    // The profile POST always lands before the step-3 choice so onboarded=1 is
    // never blocked by the calibration decision. Editing keeps the single form.
    // Run the input-device setup wizard (the input_setup plugin's
    // `input-calibration` domain) for the chosen instrument paths — BETWEEN path
    // selection and the calibration challenge — so the diagnostic runs against a
    // calibrated input. Capability-idiomatic: dispatch `run` (fire-and-launch)
    // and await the `calibration-done` event. Degrades gracefully when the
    // plugin/runtime is absent so onboarding can never be stranded.
    // Wait (bounded) for the bundled input_setup plugin to finish registering
    // its input-calibration owner. Plugins load asynchronously, so onboarding
    // can reach this step before the plugin is ready — without this wait the
    // mandatory wizard is skipped by a load-order race (it dispatches, gets a
    // no-owner outcome, and falls through to the calibration challenge). The
    // public global is set at the end of the plugin's screen.js, after the
    // owner is registered, so it is a reliable readiness signal.
    function waitForInputSetup(timeoutMs) {
        const ready = () => !!(window.slopsmithInputSetup && typeof window.slopsmithInputSetup.launch === 'function');
        return new Promise((resolve) => {
            if (ready()) { resolve(true); return; }
            const t0 = Date.now();
            const iv = setInterval(() => {
                if (ready()) { clearInterval(iv); resolve(true); }
                else if (Date.now() - t0 >= timeoutMs) { clearInterval(iv); resolve(false); }
            }, 100);
        });
    }

    async function runInputSetup(paths) {
        const instruments = (Array.isArray(paths) ? paths : []).map((p) => String(p).toLowerCase());
        if (!instruments.length) return;
        // Don't let a plugin-load race skip the mandatory input-setup step.
        if (!(await waitForInputSetup(8000))) return;
        const caps = window.slopsmith && window.slopsmith.capabilities;
        if (!caps || typeof caps.command !== 'function') {
            try { await window.slopsmithInputSetup.launch(instruments); } catch (e) { /* proceed */ }
            return;
        }
        await new Promise((resolve) => {
            let settled = false;
            let unsub = null;
            const done = () => { if (settled) return; settled = true; try { unsub && unsub(); } catch (e) { /* noop */ } resolve(); };
            try { unsub = typeof caps.subscribe === 'function' ? caps.subscribe('input-calibration:calibration-done', done) : null; } catch (e) { unsub = null; }
            // `run` is fire-and-launch; completion arrives via the event above.
            // A non-handled outcome (no owner / plugin absent / error) means
            // nothing was launched, so proceed immediately.
            caps.command('input-calibration', 'run', { requester: 'onboarding', payload: { instruments } })
                .then((r) => { if (!r || r.outcome !== 'handled') done(); })
                .catch(() => done());
        });
    }

    function show(profile, opts) {
        opts = opts || {};
        const editing = !!opts.editing;
        document.getElementById('v3-onboarding')?.remove();

        const stepDots = editing ? '' :
            '<div class="flex justify-center gap-1.5 mt-3" id="v3-ob-dots">' +
            [1, 2, 3, 4].map((n) => '<span data-dot="' + n + '" class="w-2 h-2 rounded-full bg-fb-border"></span>').join('') +
            '</div>';

        const overlay = document.createElement('div');
        overlay.id = 'v3-onboarding';
        overlay.className = 'fixed inset-0 z-[200] bg-black/60 backdrop-blur-sm flex items-center justify-center p-4';
        overlay.innerHTML =
            '<div class="bg-fb-card rounded-xl border border-fb-border/50 w-full max-w-lg p-6 space-y-5">' +
            '<div class="text-center">' +
            '<div class="text-2xl">' + (window.fbBrand ? window.fbBrand.wordmarkHTML({ size: 'text-2xl' }) : 'fee[dB]ack') + '</div>' +
            '<p id="v3-ob-subtitle" class="text-sm text-fb-textDim mt-1">' + (editing ? 'Edit your player profile' : 'Set up your player profile') + '</p>' +
            stepDots + '</div>' +
            // Step 1 — name + avatar (the original form, unchanged DOM).
            '<div id="v3-ob-step1">' +
            '<div><label class="block text-xs uppercase tracking-wider text-fb-textDim mb-1">Display name</label>' +
            '<input id="v3-ob-name" type="text" maxlength="32" placeholder="Your name" ' +
            'class="w-full bg-gray-800/50 border border-gray-700 rounded-md px-3 py-2 text-sm text-fb-text ' +
            'focus:border-fb-primary focus:ring-1 focus:ring-fb-primary outline-none"></div>' +
            '<div class="mt-4"><label class="block text-xs uppercase tracking-wider text-fb-textDim mb-2">Avatar</label>' +
            '<div id="v3-ob-avatars" class="grid grid-cols-4 sm:grid-cols-6 gap-2"></div>' +
            '<div class="mt-2 flex items-center gap-3">' +
            '<button type="button" id="v3-ob-upload-btn" class="text-sm text-fb-primary hover:text-fb-primaryHi">Upload your own</button>' +
            '<input type="file" id="v3-ob-upload" accept="image/*" class="hidden">' +
            '<span id="v3-ob-preview"></span></div></div></div>' +
            // Step 2 — song directory (where the user's songs live).
            '<div id="v3-ob-step2" class="hidden">' +
            '<label class="block text-xs uppercase tracking-wider text-fb-textDim mb-2">Song directory</label>' +
            '<p class="text-sm text-fb-textDim mb-3">Choose the folder where your songs are stored. We’ll scan it to build your library. You can change this later in Settings.</p>' +
            '<div class="flex gap-2">' +
            '<input id="v3-ob-songdir" type="text" placeholder="Path to your songs folder" ' +
            'class="flex-1 bg-gray-800/50 border border-gray-700 rounded-md px-3 py-2 text-sm text-fb-text outline-none focus:border-fb-primary focus:ring-1 focus:ring-fb-primary">' +
            '<button type="button" id="v3-ob-songdir-browse" class="hidden px-3 py-2 rounded-md text-sm bg-gray-800/50 border border-gray-700 text-fb-text hover:border-fb-primary whitespace-nowrap">Browse…</button>' +
            '</div></div>' +
            // Step 3 — instrument paths (first-run only; tiles filled on entry).
            '<div id="v3-ob-step3" class="hidden">' +
            '<label class="block text-xs uppercase tracking-wider text-fb-textDim mb-2">Pick your instrument path(s)</label>' +
            '<p class="text-sm text-fb-textDim mb-3">Each path levels up by completing challenges — together they make up your Mastery Rank. You can add more later.</p>' +
            '<div id="v3-ob-paths" class="grid grid-cols-3 gap-2"></div></div>' +
            // Step 4 — calibration offer (first-run only).
            '<div id="v3-ob-step4" class="hidden">' +
            '<label class="block text-xs uppercase tracking-wider text-fb-textDim mb-2">Calibration challenge</label>' +
            '<p class="text-sm text-fb-textDim">Prove your setup: play the <span class="text-fb-text">fee[dB]ack Diagnostic</span> with note detection and finish at <span class="text-fb-text font-semibold">100% accuracy</span> to reach <span class="text-fb-text font-semibold">Mastery Rank 1</span>.</p>' +
            '<p class="text-sm text-fb-textDim mt-2">Not ready? Skip it and you’ll start at Rank 1 anyway — you can still play it later from the Progress screen.</p></div>' +
            '<p id="v3-ob-error" class="text-sm text-fb-accent hidden"></p>' +
            '<div class="flex justify-end gap-3">' +
            (editing ? '<button type="button" id="v3-ob-cancel" class="px-4 py-2 rounded-md text-sm text-fb-textDim hover:text-fb-text">Cancel</button>' : '') +
            '<button type="button" id="v3-ob-skip" class="hidden px-4 py-2 rounded-md text-sm text-fb-textDim hover:text-fb-text">Skip for now</button>' +
            '<button type="button" id="v3-ob-submit" disabled class="bg-fb-primary hover:bg-fb-primaryHi disabled:opacity-40 disabled:cursor-not-allowed text-white px-6 py-2 rounded-md font-medium shadow-lg shadow-fb-primary/20 transition-colors">' +
            (editing ? 'Save' : 'Next') + '</button></div></div>';
        document.body.appendChild(overlay);

        const nameEl = overlay.querySelector('#v3-ob-name');
        const grid = overlay.querySelector('#v3-ob-avatars');
        const submit = overlay.querySelector('#v3-ob-submit');
        const errEl = overlay.querySelector('#v3-ob-error');
        const fileEl = overlay.querySelector('#v3-ob-upload');
        const preview = overlay.querySelector('#v3-ob-preview');
        const skipBtn = overlay.querySelector('#v3-ob-skip');
        let selected = null;      // { type:'default', value } | { type:'upload', value:url }
        let step = 1;             // first-run wizard step (editing stays on 1)
        let songDir = '';         // step-2 song directory pick
        let selectedPaths = [];   // step-3 picks
        let pathsAvailable = false;      // any tiles rendered? (false → don't strand the user)
        let diagnosticFilename = null;   // from /api/progression (step-4 "Play it now")
        const songDirEl = overlay.querySelector('#v3-ob-songdir');
        const songDirBrowse = overlay.querySelector('#v3-ob-songdir-browse');

        if (editing && profile) {
            nameEl.value = profile.display_name || '';
        }

        function refreshSubmit() {
            if (editing || step === 1) {
                // First-run onboarding requires picking an avatar. When editing an
                // existing profile, a name-only change is allowed: leaving `selected`
                // null omits `avatar` from the POST, and the server keeps the current
                // one — including a custom upload that isn't in the bundled grid (so
                // Save no longer stays disabled for those).
                const haveAvatar = !!selected || (editing && profile && !!profile.avatar_url);
                submit.disabled = !(nameEl.value.trim().length >= 1 && haveAvatar);
            } else if (step === 2) {
                // Song directory — require a non-empty path to proceed; "Skip
                // for now" is available for users who'll set it later.
                submit.disabled = !songDir.trim();
            } else if (step === 3) {
                // ≥1 path required — unless none could be offered (offline /
                // empty content), where blocking would strand onboarding.
                submit.disabled = pathsAvailable && selectedPaths.length < 1;
            } else {
                submit.disabled = false;
            }
        }

        function setStep(n) {
            step = n;
            errEl.classList.add('hidden');
            for (let i = 1; i <= 4; i++) {
                overlay.querySelector('#v3-ob-step' + i).classList.toggle('hidden', i !== n);
            }
            overlay.querySelectorAll('#v3-ob-dots [data-dot]').forEach((d) => {
                d.classList.toggle('bg-fb-primary', Number(d.getAttribute('data-dot')) <= n);
                d.classList.toggle('bg-fb-border', Number(d.getAttribute('data-dot')) > n);
            });
            const subtitle = overlay.querySelector('#v3-ob-subtitle');
            if (subtitle) {
                subtitle.textContent = n === 1 ? 'Set up your player profile'
                    : n === 2 ? 'Point us at your songs'
                    : n === 3 ? 'Choose your instrument paths'
                    : 'One last thing — calibrate your setup';
            }
            submit.textContent = n === 4 ? 'Play it now' : 'Next';
            // Skip is offered on the song-directory step (configure later) and
            // the calibration challenge.
            skipBtn.classList.toggle('hidden', !(n === 2 || n === 4));
            refreshSubmit();
        }

        async function loadPathTiles() {
            const host = overlay.querySelector('#v3-ob-paths');
            let available = [];
            try {
                const r = await fetch('/api/progression');
                if (r.ok) {
                    const data = await r.json();
                    diagnosticFilename = (data.onboarding || {}).diagnostic_filename || null;
                    available = (data.available_paths || []).concat(
                        (data.paths || []).map((p) => ({ id: p.id, name: p.name })));
                }
            } catch (e) { /* offline — leave empty, Next stays disabled */ }
            pathsAvailable = available.length > 0;
            host.innerHTML = available.map((p) =>
                '<button type="button" data-ob-path="' + esc(p.id) + '" ' +
                'class="rounded-lg border border-fb-border/50 bg-fb-bg/40 px-3 py-4 text-sm font-medium text-fb-text ' +
                'hover:border-fb-primary/50 transition">' + esc(p.name) + '</button>').join('') ||
                '<p class="text-sm text-fb-textDim col-span-3">Couldn’t load instrument paths — you can pick them later on the Progress screen.</p>';
            refreshSubmit();
            host.querySelectorAll('[data-ob-path]').forEach((b) => {
                b.addEventListener('click', () => {
                    const id = b.getAttribute('data-ob-path');
                    const idx = selectedPaths.indexOf(id);
                    if (idx >= 0) selectedPaths.splice(idx, 1); else selectedPaths.push(id);
                    b.classList.toggle('ring-2', idx < 0);
                    b.classList.toggle('ring-fb-primary', idx < 0);
                    refreshSubmit();
                });
            });
        }
        nameEl.addEventListener('input', refreshSubmit);
        // Reflect the pre-filled name + existing avatar immediately so an edit
        // with no changes can still Save (button doesn't stay disabled until
        // the user touches the form).
        refreshSubmit();

        function selectTile(el, choice) {
            selected = choice;
            grid.querySelectorAll('[data-av]').forEach((t) => t.classList.remove('ring-2', 'ring-fb-primary'));
            if (el) el.classList.add('ring-2', 'ring-fb-primary');
            refreshSubmit();
        }

        // Load bundled defaults. The default avatar's stored value is its
        // bundled FILENAME (e.g. "pick.svg"), which the server validates
        // against the bundled set.
        fetch('/api/profile/avatars').then((r) => r.ok ? r.json() : []).then((list) => {
            grid.innerHTML = (list || []).map((a) =>
                '<button type="button" data-av data-name="' + esc(a.name) + '" data-url="' + esc(a.url) + '" ' +
                'class="aspect-square rounded-lg overflow-hidden bg-fb-bg/40 hover:ring-2 hover:ring-fb-primary/50 transition">' +
                '<img src="' + esc(a.url) + '" alt="' + esc(a.name) + '" class="w-full h-full object-cover"></button>').join('');
            grid.querySelectorAll('[data-av]').forEach((b) => {
                b.addEventListener('click', () => selectTile(b, { type: 'default', value: b.dataset.name }));
            });
            // Pre-select the current avatar when editing.
            if (editing && profile && profile.avatar_url) {
                const match = Array.from(grid.querySelectorAll('[data-av]')).find((b) => b.dataset.url === profile.avatar_url);
                if (match) selectTile(match, { type: 'default', value: match.dataset.name });
            }
        }).catch(() => { /* offline / server restart — leave the avatar grid empty rather than throw */ });

        // Upload handler — base64 to /api/profile/avatar (mirrors art upload).
        overlay.querySelector('#v3-ob-upload-btn').addEventListener('click', () => fileEl.click());
        fileEl.addEventListener('change', () => {
            const f = fileEl.files && fileEl.files[0];
            if (!f) return;
            if (f.size > 6 * 1024 * 1024) { showErr('Image too large (max 6 MB).'); return; }
            const reader = new FileReader();
            reader.onload = async () => {
                try {
                    const res = await fetch('/api/profile/avatar', {
                        method: 'POST', headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ image: reader.result }),
                    });
                    const body = await res.json();
                    if (!res.ok) { showErr(body.error || 'Upload failed.'); return; }
                    preview.innerHTML = '<img src="' + esc(body.url) + '" class="w-10 h-10 rounded-full object-cover inline-block align-middle">';
                    grid.querySelectorAll('[data-av]').forEach((t) => t.classList.remove('ring-2', 'ring-fb-primary'));
                    selected = { type: 'upload', value: body.url };
                    refreshSubmit();
                } catch (e) { showErr('Upload failed.'); }
            };
            reader.readAsDataURL(f);
        });

        function showErr(msg) { errEl.textContent = msg; errEl.classList.remove('hidden'); }

        if (editing) overlay.querySelector('#v3-ob-cancel')?.addEventListener('click', () => overlay.remove());

        // ── Song directory (step 2) ──────────────────────────────────────────
        if (songDirEl) {
            songDirEl.addEventListener('input', () => { songDir = songDirEl.value.trim(); refreshSubmit(); });
        }
        // Native folder picker on desktop; web users type/paste the path.
        const _desktop = window.slopsmithDesktop;
        if (songDirBrowse && _desktop && typeof _desktop.pickDirectory === 'function') {
            songDirBrowse.classList.remove('hidden');
            songDirBrowse.addEventListener('click', async () => {
                try {
                    const picked = await _desktop.pickDirectory();
                    if (picked) { songDirEl.value = picked; songDir = picked; refreshSubmit(); }
                } catch (e) { /* user cancelled / unavailable */ }
            });
        }
        // Save the song directory to settings + kick a library scan so the
        // user's songs appear. Throws (with a message) on an invalid folder.
        async function saveSongDir() {
            const dir = ((songDirEl && songDirEl.value) || '').trim();
            if (!dir) return;   // skipped — leave unconfigured (settable later)
            const res = await fetch('/api/settings', {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ dlc_dir: dir }),
            });
            // /api/settings reports an invalid folder as a 200 with an `error`
            // field (a bare dict return, not a non-2xx status), so a res.ok-only
            // check would treat the failure as success and advance without saving.
            // Inspect the body too.
            let data = null;
            try { data = await res.json(); } catch (e) { /* non-JSON body */ }
            if (!res.ok || (data && data.error)) {
                throw new Error((data && data.error) || 'That folder couldn’t be set — check the path and try again.');
            }
            // Non-fatal: scan kicks off the library build in the background.
            try { await fetch('/api/rescan', { method: 'POST' }); } catch (e) { /* best-effort */ }
        }

        async function postProfile() {
            const res = await fetch('/api/profile', {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ display_name: nameEl.value.trim(), avatar: selected || undefined }),
            });
            const body = await res.json();
            if (!res.ok) throw new Error(body.error || 'Could not save profile.');
            return body;
        }

        async function finish(finishOpts) {
            finishOpts = finishOpts || {};
            overlay.remove();
            await fetchProgress();
            if (window.v3Progression && typeof window.v3Progression.refresh === 'function') {
                await window.v3Progression.refresh();
            }
            renderBadge();
            renderProfileScreen();
            if (window.slopsmith && window.slopsmith.emit) window.slopsmith.emit('v3:profile-updated', _profile);
            // First-run only: after a genuine onboarding completion (not a
            // profile edit), kick off the one-time home tour — but NOT when we're
            // about to launch the diagnostic ("Play it now"), which navigates to
            // the player; the tour would otherwise spotlight hidden home elements
            // and steal focus. The Skip path stays on home, so it runs there.
            // The engine's seen/dismissed state keeps it once; replayable from "?".
            if (!editing && !finishOpts.launchingSong &&
                window.v3OnboardingTour && typeof window.v3OnboardingTour.startFirstRun === 'function') {
                try { window.v3OnboardingTour.startFirstRun(); } catch (e) { /* never block onboarding */ }
            }
        }

        submit.addEventListener('click', async () => {
            errEl.classList.add('hidden');
            if (editing) {
                submit.disabled = true;
                try {
                    _profile = await postProfile();
                    await finish();
                } catch (e) { showErr(e.message || 'Could not save profile.'); submit.disabled = false; }
                return;
            }
            if (step === 1) {
                setStep(2);
                setTimeout(() => { try { songDirEl && songDirEl.focus(); } catch (e) { /* noop */ } }, 50);
                return;
            }
            if (step === 2) {
                // Save the song directory + kick a library scan, then continue
                // to instrument paths. "Skip for now" leaves it unconfigured.
                submit.disabled = true;
                try {
                    await saveSongDir();
                    setStep(3);
                    loadPathTiles();
                } catch (e) { showErr(e.message || 'Could not set the song directory.'); refreshSubmit(); }
                return;
            }
            if (step === 3) {
                // Create the profile (onboarded=1) BEFORE the calibration choice
                // so closing the overlay at the challenge can never lose the profile.
                submit.disabled = true;
                try {
                    _profile = await postProfile();
                    if (selectedPaths.length) {
                        // A failed path save must NOT advance — step 3's skip
                        // requires ≥1 selected path (spec invariant) and would
                        // otherwise leave a pathless rank-1 profile.
                        const res = await fetch('/api/progression/paths', {
                            method: 'POST', headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ add: selectedPaths }),
                        });
                        if (!res.ok) {
                            let msg = 'Could not save your instrument paths — try again.';
                            try { msg = (await res.json()).error || msg; } catch (e) { /* keep default */ }
                            throw new Error(msg);
                        }
                    }
                    // New step: input-device selection + calibration, between
                    // path selection and the note-detect calibration challenge.
                    await runInputSetup(selectedPaths);
                    setStep(4);
                } catch (e) { showErr(e.message || 'Could not save profile.'); refreshSubmit(); }
                return;
            }
            // Step 4 — "Play it now": leave calibration pending (it completes
            // through the normal scored-stats path) and launch the diagnostic.
            const target = diagnosticFilename;
            await finish({ launchingSong: !!target });
            if (target && typeof window.playSong === 'function') window.playSong(target);
        });

        skipBtn.addEventListener('click', async () => {
            // Step 2 — skip the song directory (the user can set it later in
            // Settings). Proceed straight to instrument paths.
            if (step === 2) {
                setStep(3);
                loadPathTiles();
                return;
            }
            // Step 4 — skip: Mastery Rank 1 immediately, calibration stays
            // replayable from the Progress screen.
            skipBtn.disabled = true;
            try {
                const res = await fetch('/api/progression/onboarding', {
                    method: 'POST', headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ action: 'skip' }),
                });
                if (!res.ok) { skipBtn.disabled = false; return; }
            } catch (e) { /* offline — skippable later from Progress */ }
            await finish();
        });

        if (!editing) setStep(1);
        setTimeout(() => nameEl.focus(), 50);
    }

    window.v3Onboarding = { show: show };
    window.v3Profile = {
        refresh: async function () { await fetchProfile(); await fetchProgress(); renderBadge(); renderProfileScreen(); },
        get: () => _profile,
    };

    async function boot() {
        await fetchProfile();
        await fetchProgress();
        renderBadge();
        renderProfileScreen();
        // Rank / dB / frames re-render whenever progression state or equipped
        // cosmetics move (progression-core.js / theme-core.js own the fetches).
        if (window.slopsmith && typeof window.slopsmith.on === 'function') {
            window.slopsmith.on('progression:updated', () => { renderBadge(); renderProfileScreen(); });
            window.slopsmith.on('v3:cosmetics-applied', () => { renderBadge(); renderProfileScreen(); });
        }
    }
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', boot, { once: true });
    } else {
        boot();
    }
})();
