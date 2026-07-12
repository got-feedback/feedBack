/*
 * Career plugin — venue progression UI + crowd-manifest push.
 *
 * Reads /api/plugins/career/state (stars from song_stats, per-venue
 * unlock/install/download status), renders the career screen, and pushes the
 * active venue's pack manifest into the crowd video layer
 * (window.v3VenueCrowd, shipped with the venue crowd PR) whenever it changes.
 * Everything degrades: no crowd layer → screen still works; no packs → the
 * venue scene keeps its static plate.
 */
(function () {
    'use strict';

    const API = '/api/plugins/career';
    const VENUE_OVERRIDE_KEY = 'feedBack-career-venue';
    const POLL_MS = 2000;

    let _state = null;
    let _pollTimer = 0;
    let _appliedManifestVenue = null;
    let _manifestReqGen = 0; // invalidates in-flight manifest fetches
    let _prevUnlockedIds = null;

    function $(id) { return document.getElementById(id); }

    function esc(s) {
        return String(s == null ? '' : s).replace(/[&<>"']/g,
            (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    }

    async function fetchState() {
        const res = await fetch(API + '/state');
        if (!res.ok) throw new Error('career state ' + res.status);
        return res.json();
    }

    function lastOf(arr) { return arr.length ? arr[arr.length - 1] : null; }

    // Active pack = localStorage override when unlocked+installed, else the
    // highest unlocked+installed tier; none → clear the crowd manifest.
    async function pushCrowdManifest(state) {
        const crowd = window.v3VenueCrowd;
        if (!crowd || typeof crowd.setManifest !== 'function') return;
        // Any newer invocation (delete, venue switch, fresher state) must win
        // over a manifest fetch still in flight from this one.
        const gen = ++_manifestReqGen;
        const unlocked = state.venues.filter((v) => v.unlocked);
        let venue = null;
        try {
            const override = localStorage.getItem(VENUE_OVERRIDE_KEY);
            venue = unlocked.find((v) => v.id === override && v.installed) || null;
        } catch (_) { /* ok */ }
        if (!venue) venue = lastOf(unlocked.filter((v) => v.installed));
        if (!venue) {
            if (_appliedManifestVenue !== null) {
                _appliedManifestVenue = null;
                crowd.setManifest(null);
            }
            return;
        }
        if (venue.id === _appliedManifestVenue) return;
        try {
            const res = await fetch(`${API}/venues/${venue.id}/manifest.json`);
            if (gen !== _manifestReqGen || !res.ok) return;
            const manifest = await res.json();
            if (gen !== _manifestReqGen) return;
            manifest.base = `${API}/venues/${venue.id}/`;
            _appliedManifestVenue = venue.id;
            crowd.setManifest(manifest);
        } catch (_) { /* pack half-installed; next refresh retries */ }
    }

    function venueCardHTML(v, state) {
        const locked = !v.unlocked;
        const dl = v.download || { status: 'idle' };
        const pct = dl.bytes_total > 0
            ? Math.round((dl.bytes_done / dl.bytes_total) * 100) : 0;
        let action = '';
        if (locked) {
            action = `<div class="text-xs text-gray-500">Unlocks at ${v.star_threshold} ★ — ${Math.max(0, v.star_threshold - state.stars_total)} to go</div>`;
        } else if (dl.status === 'running') {
            action = `<div class="career-bar-track mb-1" style="height:0.375rem"><div class="career-bar-fill" style="width:${pct}%"></div></div>
                <div class="text-xs text-gray-400">Downloading… ${pct}%</div>`;
        } else if (v.installed) {
            action = `<div class="flex items-center gap-2">
                <button data-career-play="${esc(v.id)}" class="career-btn career-btn-primary">Play here</button>
                <button data-career-delete="${esc(v.id)}" class="career-btn career-btn-ghost">Remove pack</button>
            </div>`;
        } else if (v.has_pack) {
            const err = dl.status === 'error'
                ? `<div class="text-xs text-amber-400 mb-1">${esc(dl.error || 'Download failed')} — try again</div>` : '';
            action = `${err}<button data-career-download="${esc(v.id)}" class="career-btn career-btn-primary">Download venue pack</button>`;
        } else {
            action = '<div class="text-xs text-gray-500">Venue pack coming soon — plays with the standard stage for now</div>';
        }
        // Mirror pushCrowdManifest(): an override only counts while the pack
        // is installed — after a removal the badge must not claim a venue the
        // crowd layer can't use.
        const isActive = !locked && v.installed &&
            localStorage.getItem(VENUE_OVERRIDE_KEY) === v.id;
        return `<div class="rounded-xl border ${locked ? 'border-gray-800 opacity-60' : 'border-gray-700'} bg-dark-700/40 p-4 flex flex-col gap-2">
            <div class="flex items-center justify-between">
                <div class="font-semibold text-white">${esc(v.name)}${isActive ? ' <span class="text-cyan-400 text-xs">● playing here</span>' : ''}</div>
                <div class="text-xs text-gray-400">${v.star_threshold} ★</div>
            </div>
            <div class="text-xs text-gray-400 flex-1">${esc(v.description)}</div>
            ${action}
        </div>`;
    }

    function starGlyphs(n) {
        let out = '';
        for (let i = 0; i < 3; i++) {
            out += `<span class="${i < n ? 'on' : 'off'}">★</span>`;
        }
        return out;
    }

    function renderStars(state) {
        const list = $('career-star-list');
        const summary = $('career-star-summary');
        if (!list || !summary) return;
        const detail = state.star_detail || [];
        const tiers = [0, 0, 0, 0];
        for (const r of detail) tiers[r.stars]++;
        summary.textContent =
            `${tiers[3]}× 3★ · ${tiers[2]}× 2★ · ${tiers[1]}× 1★ · ${tiers[0]} unstarred`;
        if (!detail.length) {
            list.innerHTML = '<div class="text-xs text-gray-500">Play songs to start collecting stars — 60% accuracy earns the first one.</div>';
            return;
        }
        list.innerHTML = detail.map((r) => {
            let hint = 'maxed';
            let close = '';
            if (r.next_star_at != null) {
                const gap = Math.max(0, r.next_star_at - r.best_accuracy) * 100;
                hint = `${gap.toFixed(0)}% to next ★`;
                if (gap <= 5) close = ' close';
            }
            return `<div class="career-star-row">
                <span class="stars">${starGlyphs(r.stars)}</span>
                <span class="song">${esc(r.title)}${r.artist ? ` <span class="artist">— ${esc(r.artist)}</span>` : ''}</span>
                <span class="hint${close}">best ${(r.best_accuracy * 100).toFixed(0)}% · ${hint}</span>
            </div>`;
        }).join('');
    }

    function render(state) {
        const host = $('career-venues');
        if (!host) return;
        $('career-stars-summary').textContent = `★ ${state.stars_total} total`;
        const next = state.venues.find((v) => !v.unlocked);
        const bar = $('career-progress-bar');
        const label = $('career-progress-label');
        if (next) {
            const prevThreshold = state.venues
                .filter((v) => v.unlocked)
                .reduce((m, v) => Math.max(m, v.star_threshold), 0);
            const span = Math.max(1, next.star_threshold - prevThreshold);
            const into = Math.max(0, state.stars_total - prevThreshold);
            bar.style.width = Math.min(100, Math.round((into / span) * 100)) + '%';
            label.textContent = `${state.stars_total} / ${next.star_threshold} ★ to unlock ${next.name}`;
        } else {
            bar.style.width = '100%';
            label.textContent = 'All venues unlocked — enjoy the arena.';
        }
        host.innerHTML = state.venues.map((v) => venueCardHTML(v, state)).join('');
        renderStars(state);
    }

    function schedulePoll(state) {
        clearTimeout(_pollTimer);
        if (state.venues.some((v) => (v.download || {}).status === 'running')) {
            _pollTimer = setTimeout(refresh, POLL_MS);
        }
    }

    function announceUnlocks(state) {
        const unlocked = state.venues.filter((v) => v.unlocked).map((v) => v.id);
        if (_prevUnlockedIds) {
            for (const v of state.venues) {
                if (v.unlocked && !_prevUnlockedIds.includes(v.id)) {
                    const sm = window.feedBack;
                    if (sm && typeof sm.emit === 'function') {
                        sm.emit('career:venue-unlocked', { id: v.id, name: v.name });
                    }
                    if (window.fbNotify && typeof window.fbNotify.show === 'function') {
                        window.fbNotify.show({
                            big: true, icon: '🎤', accent: '#06B6D4',
                            title: 'New venue unlocked!',
                            message: `${v.name} — your crowd just got bigger.`,
                        });
                    }
                }
            }
        }
        _prevUnlockedIds = unlocked;
    }

    async function refresh() {
        let state;
        try {
            state = await fetchState();
        } catch (_) {
            return; // server restarting; next trigger retries
        }
        _state = state;
        announceUnlocks(state);
        render(state);
        schedulePoll(state);
        pushCrowdManifest(state);
    }

    function onClick(e) {
        const dlBtn = e.target.closest('[data-career-download]');
        const delBtn = e.target.closest('[data-career-delete]');
        const playBtn = e.target.closest('[data-career-play]');
        if (dlBtn) {
            fetch(`${API}/packs/${dlBtn.dataset.careerDownload}/download`, { method: 'POST' })
                .then(refresh);
        } else if (delBtn) {
            // Do NOT null _appliedManifestVenue here: pushCrowdManifest()
            // clears/replaces the crowd manifest precisely by seeing that the
            // applied venue is no longer among the installed ones.
            fetch(`${API}/packs/${delBtn.dataset.careerDelete}`, { method: 'DELETE' })
                .then(refresh);
        } else if (playBtn) {
            try { localStorage.setItem(VENUE_OVERRIDE_KEY, playBtn.dataset.careerPlay); } catch (_) { /* ok */ }
            _appliedManifestVenue = null; // force manifest re-push
            refresh();
        }
    }

    function boot() {
        const screen = document.getElementById('plugin-career');
        if (screen) screen.addEventListener('click', onClick);
        const sm = window.feedBack;
        if (sm && typeof sm.on === 'function') {
            // New song stats can add stars → thresholds may cross mid-session.
            sm.on('stats:recorded', () => refresh());
        }
        refresh();
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', boot);
    } else {
        boot();
    }
}());
