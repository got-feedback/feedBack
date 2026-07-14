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
    const NO_VENUE = '__none__';
    const PREV_VIZ_KEY = 'feedBack-career-prev-viz';
    const POLL_MS = 2000;

    // Passports (the badge-journey layer; see routes.py — badges are computed
    // server-side, this file only renders and relays).
    const PP_SEEN_KEY = 'feedBack-career-badges-seen';
    const PP_INST_KEY = 'feedBack-career-instrument';
    const PP_TAB_KEY = 'feedBack-career-tab';
    const PP_LABELS = { guitar: 'Guitar', bass: 'Bass', keys: 'Keys', drums: 'Drums' };
    const PP_BROCHURE_ART = ['🎸', '🎷', '🎹', '🥁', '🎺', '🎻', '🎤', '🪕'];

    let _state = null;
    let _pollTimer = 0;
    let _appliedManifestVenue = null;
    let _manifestReqGen = 0; // invalidates in-flight manifest fetches
    let _prevUnlockedIds = null;
    let _pp = null;              // last /passports view
    let _ppRelayTimer = 0;
    let _ppBook = null;          // {inst, gkey} of the open spread
    let _ppReturnFocus = null;   // element to refocus when the book closes
    let _ppCeremonyQueue = [];   // badges awaiting their ceremony overlay
    let _ppCeremonyActive = false;
    let _ppBootstrapped = false;
    let _ppNotified = {};        // badges chimed this session (slam still pending)
    let _ppGigProposal = null;   // the booking poster's proposal, while open
    let _ppGigRun = null;        // {songs, venue_id, genre, genre_key, instrument, idx} mid-set

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
        let override = null;
        try { override = localStorage.getItem(VENUE_OVERRIDE_KEY); } catch (_) { /* ok */ }
        if (override !== NO_VENUE) {
            venue = unlocked.find((v) => v.id === override && v.installed) || null;
            if (!venue) venue = lastOf(unlocked.filter((v) => v.installed));
        }
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
            const active = localStorage.getItem(VENUE_OVERRIDE_KEY) === v.id;
            const main = active
                ? `<button data-career-unselect="1" class="career-btn career-btn-ghost">Leave venue</button>`
                : `<button data-career-play="${esc(v.id)}" class="career-btn career-btn-primary">Play here</button>`;
            const remove = v.bundled
                ? ''
                : `<button data-career-delete="${esc(v.id)}" class="career-btn career-btn-ghost">Remove pack</button>`;
            action = `<div class="flex items-center gap-2">
                ${main}
                ${remove}
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
        refreshPassports(); // independent fetch; failures don't touch venues
    }

    // ── Passports ─────────────────────────────────────────────────────────

    function lsGet(k) { try { return localStorage.getItem(k); } catch (_) { return null; } }
    function lsSet(k, v) { try { localStorage.setItem(k, v); } catch (_) { /* ok */ } }

    function ppLabel(inst) {
        return PP_LABELS[inst] || (inst.charAt(0).toUpperCase() + inst.slice(1));
    }

    function ppKey(genre) {
        return String(genre || '').trim().replace(/\s+/g, ' ').toLowerCase();
    }

    function ppHash(seed) {
        let h = 0;
        for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) | 0;
        return h;
    }

    // Deterministic per-key jitter (sin-hash): stamps and stubs land slightly
    // askew, the same way on every visit.
    function ppJitter(seed, range) {
        return (Math.abs(Math.sin(ppHash(seed))) * 2 - 1) * range;
    }

    function sfx(name) {
        try {
            const a = new Audio(`${API}/assets/sfx/${name}.mp3`);
            a.volume = 0.45;
            a.play().catch(() => { /* autoplay policy — silent is fine */ });
        } catch (_) { /* no Audio — fine */ }
    }

    function showCareerTab(tab) {
        lsSet(PP_TAB_KEY, tab);
        const venues = $('career-tab-venues');
        const pp = $('career-tab-passports');
        if (!venues || !pp) return;
        venues.classList.toggle('hidden', tab !== 'venues');
        pp.classList.toggle('hidden', tab !== 'passports');
        document.querySelectorAll('#plugin-career .career-tab').forEach((b) => {
            const active = b.dataset.careerTab === tab;
            b.classList.toggle('active', active);
            b.setAttribute('aria-selected', active ? 'true' : 'false');
        });
    }

    function activeInstrument() {
        const list = (_pp && _pp.config && _pp.config.instruments) || [];
        const saved = lsGet(PP_INST_KEY);
        if (saved && list.includes(saved)) return saved;
        const committed = list.find((i) => ((_pp.instruments || {})[i] || {}).committed_at);
        return committed || list[0] || 'guitar';
    }

    function seenBadges() {
        try {
            const seen = JSON.parse(lsGet(PP_SEEN_KEY) || '{}');
            // Guard non-object JSON (a stray "null" or array) — a broken
            // stored value must not throw on every passport refresh.
            return seen && typeof seen === 'object' && !Array.isArray(seen) ? seen : {};
        } catch (_) { return {}; }
    }

    // Bronze keeps the legacy un-suffixed id, so badges seen before the Gold
    // tier existed stay seen; gold is a distinct moment with its own id.
    function badgeId(inst, gkey, tier) { return inst + '/' + gkey + (tier === 'gold' ? '@gold' : ''); }

    function markBadgeSeen(inst, gkey, tier) {
        const seen = seenBadges();
        seen[badgeId(inst, gkey, tier)] = 1;
        // A gold slam covers the bronze moment too — never queue both.
        if (tier === 'gold') seen[badgeId(inst, gkey)] = 1;
        lsSet(PP_SEEN_KEY, JSON.stringify(seen));
    }

    // New badge → chime + notification + the venue ceremony, once per
    // session; the stamp SLAM plays when the passport is next opened (and
    // only then is the badge marked seen, so a pending slam survives a
    // reload).
    function detectNewBadges(view) {
        const seen = seenBadges();
        for (const inst of Object.keys(view.instruments || {})) {
            for (const p of (view.instruments[inst].passports || [])) {
                if (p.badge !== 'earned' && p.badge !== 'gold') continue;
                const gold = p.badge === 'gold';
                const id = badgeId(inst, p.genre_key, p.badge);
                if (seen[id] || _ppNotified[id]) continue;
                _ppNotified[id] = true;
                sfx('chime');
                if (window.fbNotify && typeof window.fbNotify.show === 'function') {
                    window.fbNotify.show({
                        big: true, icon: gold ? '🏅' : '🛂', accent: gold ? '#d9a253' : '#b45309',
                        title: gold ? 'Gold — a verified improv!' : 'Badge earned!',
                        message: gold
                            ? `${p.genre} — your ${ppLabel(inst)} badge turns gold.`
                            : `${p.genre} — Bronze, ready to stamp into your ${ppLabel(inst)} passport.`,
                    });
                }
                badgeCeremony(inst, p);
            }
        }
    }

    function reducedMotion() {
        try { return window.matchMedia('(prefers-reduced-motion: reduce)').matches; } catch (_) { return false; }
    }

    // The badge moment: the crowd erupts first (if a venue pack is live —
    // badges land post-stats:recorded while the player is still on screen),
    // then a body-level overlay. It CANNOT live in #pp-overlay: #plugin-career
    // is display:none during playback.
    function badgeCeremony(inst, p) {
        // Reduced motion: the chime + fbNotify already delivered the news —
        // no overlay, and no app-initiated crowd eruption either.
        if (reducedMotion()) return;
        const crowd = window.v3VenueCrowd;
        if (crowd && typeof crowd.celebrate === 'function') {
            try { crowd.celebrate(); } catch (_) { /* crowd layer optional */ }
        }
        if (!document.body || typeof document.createElement !== 'function') return;
        // Several badges can land in one refresh (first load, drill-snapshot
        // bootstrap): queue the ceremonies and play them back to back.
        _ppCeremonyQueue.push({ inst, p });
        if (!_ppCeremonyActive) setTimeout(drainCeremonies, 300);
    }

    function drainCeremonies() {
        if (_ppCeremonyActive) return;
        const queued = _ppCeremonyQueue.shift();
        if (!queued) return;
        _ppCeremonyActive = true;
        showCeremonyOverlay(queued.inst, queued.p, () => {
            _ppCeremonyActive = false;
            setTimeout(drainCeremonies, 250);
        });
    }

    function showCeremonyOverlay(inst, p, done) {
        const el = document.createElement('div');
        el.id = 'pp-ceremony';
        el.className = 'pp-ceremony-overlay';
        el.innerHTML = `
            <canvas class="pp-confetti"></canvas>
            <div class="pp-ceremony-card">
                <div class="pp-stamp pp-stamp-page pp-ceremony-stamp${p.badge === 'gold' ? ' pp-stamp-gold' : ''}" style="--pp-rot:${ppJitter(p.genre_key, 7).toFixed(1)}deg">
                    <span class="pp-stamp-genre">${esc(p.genre.toUpperCase())}</span>
                    <span class="pp-stamp-tier">${p.badge === 'gold' ? 'GOLD' : 'BRONZE'}</span>
                </div>
                <div class="pp-ceremony-title">${p.badge === 'gold' ? 'Gold — a verified improv' : 'Badge earned'}</div>
                <div class="pp-ceremony-sub">${esc(p.genre)} — ${esc(ppLabel(inst))} passport</div>
            </div>`;
        let timer = 0;
        let closed = false;
        const dismiss = () => {
            if (closed) return;
            closed = true;
            clearTimeout(timer);
            el.classList.add('pp-ceremony-out');
            setTimeout(() => { el.remove(); done(); }, 350);
        };
        el.addEventListener('click', dismiss);
        document.body.appendChild(el);
        timer = setTimeout(dismiss, 4200);
        confettiBurst(el.querySelector('.pp-confetti'));
    }

    function confettiBurst(canvas) {
        if (!canvas || typeof canvas.getContext !== 'function') return;
        const ctx = canvas.getContext('2d');
        if (!ctx) return;
        canvas.width = canvas.clientWidth;
        canvas.height = canvas.clientHeight;
        const colors = ['#d9a253', '#b45309', '#facc15', '#06b6d4', '#e5e7eb'];
        const parts = Array.from({ length: 42 }, () => ({
            x: canvas.width / 2 + (Math.random() - 0.5) * 90,
            y: canvas.height * 0.42,
            vx: (Math.random() - 0.5) * 9,
            vy: -(4 + Math.random() * 7),
            rot: Math.random() * Math.PI,
            vr: (Math.random() - 0.5) * 0.3,
            w: 5 + Math.random() * 5,
            h: 3 + Math.random() * 4,
            c: colors[(Math.random() * colors.length) | 0],
        }));
        let frames = 0;
        (function tick() {
            if (!canvas.isConnected || frames++ > 240) return;
            ctx.clearRect(0, 0, canvas.width, canvas.height);
            for (const q of parts) {
                q.x += q.vx; q.y += q.vy; q.vy += 0.18; q.rot += q.vr;
                ctx.save();
                ctx.translate(q.x, q.y);
                ctx.rotate(q.rot);
                ctx.fillStyle = q.c;
                ctx.fillRect(-q.w / 2, -q.h / 2, q.w, q.h);
                ctx.restore();
            }
            requestAnimationFrame(tick);
        }());
    }

    // Relay the Virtuoso drill snapshot (localStorage doc, not the thin bus
    // payload) to the server intake, debounced across event bursts.
    function relayDrillState() {
        clearTimeout(_ppRelayTimer);
        _ppRelayTimer = setTimeout(() => {
            let snap = null;
            try { snap = JSON.parse(lsGet('virtuoso.progress') || 'null'); } catch (_) { /* corrupt */ }
            if (!snap || typeof snap !== 'object' || !snap.byNode || typeof snap.byNode !== 'object') return;
            fetch(`${API}/drill-state`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    mode: snap.mode, xp: snap.xp, byNode: snap.byNode,
                    ...(snap.goldImprov && typeof snap.goldImprov === 'object' && !Array.isArray(snap.goldImprov)
                        ? { goldImprov: snap.goldImprov } : {}),
                }),
            }).then(() => refreshPassports()).catch(() => { /* next event retries */ });
        }, 1500);
    }

    async function refreshPassports() {
        let view;
        try {
            const res = await fetch(`${API}/passports`);
            if (!res.ok) return;
            view = await res.json();
        } catch (_) { return; }
        _pp = view;
        detectNewBadges(view);
        renderPassports();
        renderProfileWall();
        renderDashCard();
        if (!_ppBootstrapped) {
            _ppBootstrapped = true;
            // Sync the local drill snapshot once per session — drill progress
            // made before the career plugin existed (or a relay POST that
            // failed) must not deny a gated badge until the next virtuoso
            // event happens to fire. Tiny payload, single-user app.
            relayDrillState();
        }
    }

    // Honest hours odometer (Stage 5 post-cap). Below a minute of history
    // there is nothing meaningful to show.
    function fmtHours(seconds) {
        const s = Number(seconds) || 0;
        if (s < 60) return '';
        if (s < 3600) return `${Math.round(s / 60)} min`;
        return `${(s / 3600).toFixed(1).replace(/\.0$/, '')} h`;
    }

    function ppCoverHTML(inst, p) {
        const rot = ppJitter(inst + p.genre_key, 1.6).toFixed(2);
        const earned = p.badge === 'earned' || p.badge === 'gold';
        const stamp = earned
            ? `<span class="pp-stamp pp-stamp-mini${p.badge === 'gold' ? ' pp-stamp-gold' : ''}" style="--pp-rot:${ppJitter(p.genre_key, 8).toFixed(1)}deg">${p.badge === 'gold' ? 'GOLD' : 'BRONZE'}</span>`
            : '';
        const stubs = p.qualifying_count === 1 ? '1 stub' : `${p.qualifying_count} stubs`;
        const hours = fmtHours(p.seconds_total);
        // Earned covers are trading cards: rotation moves into a CSS var so
        // the pointer-tracked tilt transform can compose with it.
        const style = earned
            ? `--pp-cover-rot:${rot}deg` : `transform:rotate(${rot}deg)`;
        return `<button class="pp-cover${earned ? ' pp-tilt' : ''} pp-leather-${esc(inst)}" data-pp-open="${esc(p.genre_key)}" style="${style}">
            <span class="pp-cover-title">${esc(p.genre.toUpperCase())}</span>
            <span class="pp-cover-inst">${esc(ppLabel(inst))} passport</span>
            ${stamp}
            <span class="pp-cover-sub">${stubs}${hours ? ` · ${hours}` : ''}</span>
        </button>`;
    }

    // Practice invitations: which stamps are closest, and what would bring
    // them home. Invitations only — no meters, no obligations.

    // Floor, never round: 74.9% must not display as the already-met "75%".
    function pct(frac) { return Math.floor((Number(frac) || 0) * 100); }

    function ppNeed(p) {
        return Math.max(0, ((p.requirement || {}).songs || 0) - (p.qualifying_count || 0));
    }

    // The one blocker phrase — shared by the Closest-stamps strip and the
    // passport book's invite line so they can never contradict each other.
    function ppAskHTML(p, withHint) {
        const req = p.requirement || {};
        const need = ppNeed(p);
        const starGl = '★'.repeat(req.min_stars || 0);
        if (need > 0) {
            const near = withHint ? (p.nearest || [])[0] : null;
            const hint = near
                ? ` · nearest: <em>${esc(near.title)}</em> at ${pct(near.best_accuracy)}%`
                : '';
            return `${need === 1 ? `one more ${starGl} song` : `${need} more ${starGl} songs`}${hint}`;
        }
        const labels = ((_pp && _pp.config) || {}).drill_labels || {};
        const drills = p.drills || {};
        const pending = (drills.required || []).filter((n) => !(drills.cleared || []).includes(n));
        return `clear ${pending.map((n) => esc(labels[n] || n)).join(', ') || 'the genre drill'} in Virtuoso`;
    }

    function closestLineHTML(p) {
        return `<button class="pp-closest-row" data-pp-open="${esc(p.genre_key)}">
            <span class="pp-closest-genre">${esc(p.genre)}</span>
            <span class="pp-closest-ask">${ppAskHTML(p, true)}</span>
        </button>`;
    }

    function renderClosest(inst, data) {
        const host = $('pp-closest');
        if (!host) return;
        const candidates = (data.passports || [])
            .filter((p) => p.badge === 'in_progress')
            .sort((a, b) => ppNeed(a) - ppNeed(b))
            .slice(0, 3);
        if (!candidates.length) { host.innerHTML = ''; return; }
        host.innerHTML = `<div class="pp-closest">
            <div class="pp-closest-head">Closest stamps</div>
            ${candidates.map(closestLineHTML).join('')}
        </div>`;
    }

    function renderShelf(inst, data) {
        const shelf = $('pp-shelf');
        if (!shelf) return;
        if (!data.committed_at) {
            shelf.innerHTML = `<div class="pp-commit-card">
                <div class="pp-commit-cover pp-leather-${esc(inst)}">
                    <span class="pp-cover-title">${esc(ppLabel(inst).toUpperCase())}</span>
                    <span class="pp-cover-inst">passport</span>
                </div>
                <div>
                    <div class="text-sm text-gray-200 font-medium mb-1">Pick up the ${esc(ppLabel(inst).toLowerCase())}.</div>
                    <div class="text-xs text-gray-400 mb-2">Press your seal to commit — then choose a genre below and go deep.</div>
                    <button class="career-btn career-btn-primary" data-pp-commit="${esc(inst)}">Press the seal</button>
                </div>
            </div>`;
            return;
        }
        const books = (data.passports || []).map((p) => ppCoverHTML(inst, p)).join('');
        shelf.innerHTML = books ||
            '<div class="text-xs text-gray-500">Your shelf is ready — open your first genre passport below.</div>';
    }

    function renderRack(inst, data) {
        const rack = $('pp-rack');
        if (!rack || !_pp) return;
        const openedKeys = new Set((data.passports || []).map((p) => p.genre_key));
        const genres = (_pp.genres || []).filter((g) => !openedKeys.has(g.genre_key));
        if (!genres.length) {
            rack.innerHTML = '<div class="text-xs text-gray-500">No further genres in your library yet — new songs bring new brochures.</div>';
            return;
        }
        rack.innerHTML = genres.map((g) => {
            const art = PP_BROCHURE_ART[Math.abs(ppHash(g.genre_key)) % PP_BROCHURE_ART.length];
            return `<button class="pp-brochure" data-pp-genre="${esc(g.genre)}">
                <span class="pp-brochure-art" aria-hidden="true">${art}</span>
                <span class="pp-brochure-name">${esc(g.genre)}</span>
                <span class="pp-brochure-sub">${g.songs_in_library === 1 ? '1 song' : `${g.songs_in_library} songs`} in your library</span>
            </button>`;
        }).join('');
    }

    function renderPassports() {
        const host = $('pp-instruments');
        if (!host || !_pp) return;
        const inst = activeInstrument();
        const data = (_pp.instruments || {})[inst] || { passports: [] };
        host.innerHTML = ((_pp.config || {}).instruments || []).map((i) => {
            const d = (_pp.instruments || {})[i] || {};
            const earned = (d.passports || []).filter((p) => p.badge === 'earned' || p.badge === 'gold').length;
            const committed = !!d.committed_at;
            return `<button class="pp-inst${i === inst ? ' active' : ''}${committed ? '' : ' uncommitted'}" data-pp-inst="${esc(i)}">
                ${esc(ppLabel(i))}${earned ? ` <span class="pp-inst-badges">⚡${earned}</span>` : ''}${committed ? '' : ' <span class="pp-inst-plus">+</span>'}
            </button>`;
        }).join('');
        renderClosest(inst, data);
        renderShelf(inst, data);
        renderRack(inst, data);
    }

    function ppStubHTML(s) {
        const date = (s.last_played_at || '').slice(0, 10);
        return `<div class="pp-stub" style="transform:rotate(${ppJitter(s.filename, 1.2).toFixed(2)}deg)">
            <span class="pp-stub-stars">${'★'.repeat(s.stars)}</span>
            <span class="pp-stub-title">${esc(s.title)}</span>
            ${s.artist ? `<span class="pp-stub-artist">${esc(s.artist)}</span>` : ''}
            <span class="pp-stub-meta">${date ? `${esc(date)} · ` : ''}best ${(s.best_accuracy * 100).toFixed(0)}%</span>
        </div>`;
    }

    // Emerging-stamp ink: how much of the ghost stamp has "carved in".
    // Song progress toward the bar only — the invite line stays the words.
    function ppFillFraction(p) {
        if (!p || p.badge !== 'in_progress') return 0;
        const need = Number((p.requirement || {}).songs) || 0;
        if (need <= 0) return 0;
        return Math.max(0, Math.min(1, (p.qualifying_count || 0) / need));
    }

    function ppBookHTML(inst, p, pendingSlam) {
        const req = p.requirement || {};
        const starGl = '★'.repeat(req.min_stars || 0);
        const reqNodes = (p.drills || {}).required || [];
        const clearedNodes = new Set((p.drills || {}).cleared || []);
        const labels = ((_pp && _pp.config) || {}).drill_labels || {};
        // The invite names what actually blocks the stamp — same shared
        // phrase as the Closest-stamps strip, so they can't contradict.
        const invite = `${ppAskHTML(p, false)} mints this stamp.`;
        let badgeArea = '';
        if (p.badge === 'shown_not_judged') {
            badgeArea = `<div class="pp-snj">Shown, not judged — your ${esc(ppLabel(inst).toLowerCase())} repertoire speaks for itself.</div>`;
        } else if (p.badge === 'earned' || p.badge === 'gold') {
            const gold = p.badge === 'gold';
            badgeArea = `<div class="pp-stamp pp-stamp-page${pendingSlam ? ' pp-stamp-hidden' : ' pp-tilt'}${gold ? ' pp-stamp-gold' : ''}" style="--pp-rot:${ppJitter(p.genre_key, 7).toFixed(1)}deg">
                <span class="pp-stamp-genre">${esc(p.genre.toUpperCase())}</span>
                <span class="pp-stamp-tier">${gold ? 'GOLD' : 'BRONZE'}</span>
            </div>
            ${gold
        ? '<div class="pp-gold-foil" aria-hidden="true">GOLD</div><div class="pp-gold-note">A verified improv — the comb heard it live.</div>'
        : '<div class="pp-gold-note">Gold rung: improvise over this style in a Virtuoso jam — verified, not self-reported.</div>'}
            <div class="pp-card-actions">
                <button class="career-btn career-btn-ghost" data-pp-card="save">Save card</button>
                <button class="career-btn career-btn-ghost" data-pp-card="copy">Copy card</button>
            </div>`;
        } else {
            const fill = (ppFillFraction(p) * 100).toFixed(0);
            badgeArea = `<div class="pp-stamp pp-stamp-page pp-stamp-ghost" style="--pp-rot:${ppJitter(p.genre_key, 7).toFixed(1)}deg; --pp-fill:${fill}%">
                <span class="pp-stamp-genre">${esc(p.genre.toUpperCase())}</span>
                <span class="pp-stamp-tier">BRONZE</span>
            </div>
            <div class="pp-invite">${invite.charAt(0).toUpperCase()}${invite.slice(1)}</div>`;
        }
        const hours = fmtHours(p.seconds_total);
        const odometer = hours
            ? `<div class="pp-hours">${hours} in ${esc(p.genre)}</div>` : '';
        let drills = '';
        if (reqNodes.length) {
            drills = `<div class="pp-drills">${reqNodes.map((n) =>
                `<div class="pp-drill${clearedNodes.has(n) ? ' cleared' : ''}">${clearedNodes.has(n) ? '✓' : '○'} ${esc(labels[n] || n)}</div>`).join('')}</div>`;
        }
        // Graded instruments collect stubs at the badge bar; shown-not-judged
        // instruments have no bar — every played genre song is repertoire.
        const stubs = p.badge === 'shown_not_judged'
            ? (p.songs || [])
            : (p.songs || []).filter((s) => s.qualifies);
        const emptyLine = p.badge === 'shown_not_judged'
            ? `Play ${esc(p.genre)} songs to fill this page.`
            : `Play ${esc(p.genre)} songs at ${starGl} to collect ticket stubs.`;
        const stubsHTML = stubs.length ? stubs.map(ppStubHTML).join('')
            : `<div class="pp-stub-empty">${emptyLine}</div>`;
        // Bring-these-up: nearest-to-the-bar songs (graded, unearned only —
        // an earned page is memorabilia, not homework).
        let nearest = '';
        if (p.badge === 'in_progress' && (p.nearest || []).length) {
            nearest = `<div class="pp-nearest">
                <div class="pp-nearest-head">Bring these up</div>
                ${p.nearest.map((s) =>
                    `<div class="pp-nearest-row"><em>${esc(s.title)}</em> — best ${pct(s.best_accuracy)}%, ${starGl} at ${pct(s.bar_at)}%</div>`).join('')}
            </div>`;
        }
        let gigLog = '';
        if ((p.gigs || []).length) {
            gigLog = `<div class="pp-giglog">
                <div class="pp-giglog-head">Gigs played</div>
                ${p.gigs.slice(0, 6).map((g) =>
                    `<div class="pp-giglog-row">${esc((g.at || '').slice(0, 10))} · ${esc(_venueName(g.venue_id))}${g.encore ? ' · <b>encore</b>' : ''}</div>`).join('')}
            </div>`;
        }
        return `<div class="pp-book-wrap" data-pp-close-bg="1" role="dialog" aria-modal="true" aria-label="${esc(p.genre)} ${esc(ppLabel(inst))} passport">
            <div class="pp-book">
                <div class="pp-page pp-page-left">
                    <div class="pp-page-head">${esc(p.genre)} — ${esc(ppLabel(inst))}</div>
                    ${badgeArea}${odometer}${drills}
                    <button class="career-btn career-btn-primary pp-gig-book" data-pp-gig="${esc(p.genre_key)}">Book a gig</button>
                </div>
                <div class="pp-page pp-page-right">
                    <div class="pp-page-head">Ticket stubs</div>
                    <div class="pp-stubs">${stubsHTML}${nearest}${gigLog}</div>
                </div>
                <div class="pp-book-cover pp-leather-${esc(inst)}">
                    <span class="pp-cover-title">${esc(p.genre.toUpperCase())}</span>
                    <span class="pp-cover-inst">${esc(ppLabel(inst))} passport</span>
                </div>
                <button class="pp-book-close" data-pp-close="1" aria-label="Close">✕</button>
            </div>
        </div>`;
    }

    function openBook(inst, gkey) {
        if (!_pp) return;
        const p = (((_pp.instruments || {})[inst] || {}).passports || [])
            .find((x) => x.genre_key === gkey);
        const overlay = $('pp-overlay');
        if (!p || !overlay) return;
        _ppBook = { inst, gkey };
        _ppReturnFocus = document.activeElement;
        const pending = (p.badge === 'earned' || p.badge === 'gold')
            && !seenBadges()[badgeId(inst, gkey, p.badge)];
        overlay.innerHTML = ppBookHTML(inst, p, pending);
        overlay.classList.remove('hidden');
        const close = overlay.querySelector('.pp-book-close');
        if (close) close.focus();
        sfx('page');
        // Double rAF so the cover's closed state paints before the transition.
        requestAnimationFrame(() => requestAnimationFrame(() => {
            const book = overlay.querySelector('.pp-book');
            if (book) book.classList.add('open');
        }));
        if (pending) {
            setTimeout(() => {
                if (!_ppBook || _ppBook.gkey !== gkey || _ppBook.inst !== inst) return;
                const stamp = overlay.querySelector('.pp-stamp-page');
                const book = overlay.querySelector('.pp-book');
                if (!stamp) return;
                stamp.classList.remove('pp-stamp-hidden');
                stamp.classList.add('pp-slam');
                stamp.classList.add('pp-tilt'); // freshly slammed = trading card too
                if (book) book.classList.add('pp-shake');
                sfx('stamp');
                markBadgeSeen(inst, gkey, p.badge);
                renderPassports(); // the shelf cover gains its mini-stamp
            }, 950);
        }
    }

    function closeBook() {
        _ppBook = null;
        _ppGigProposal = null;   // a dismissed poster is a dismissed booking
        const overlay = $('pp-overlay');
        if (overlay) { overlay.classList.add('hidden'); overlay.innerHTML = ''; }
        if (_ppReturnFocus && typeof _ppReturnFocus.focus === 'function' &&
            document.contains(_ppReturnFocus)) {
            _ppReturnFocus.focus();
        }
        _ppReturnFocus = null;
    }

    function commitInstrument(inst, after) {
        fetch(`${API}/passports/commit`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ instrument: inst }),
        }).then(() => refreshPassports())
            .then(() => { if (after) after(); })
            .catch(() => { /* server restarting; user retries */ });
    }

    // Stage 0 — the wax seal. Purely theatrical: the overlay plays the press,
    // the POST commits, the shelf re-renders committed.
    function sealCeremony(inst, after) {
        const overlay = $('pp-overlay');
        if (!overlay) { commitInstrument(inst, after); return; }
        overlay.innerHTML = `<div class="pp-book-wrap">
            <div class="pp-commit-cover pp-ceremony pp-leather-${esc(inst)}">
                <span class="pp-cover-title">${esc(ppLabel(inst).toUpperCase())}</span>
                <span class="pp-cover-inst">passport</span>
                <span class="pp-wax"><span>${esc(ppLabel(inst).charAt(0))}</span></span>
            </div>
        </div>`;
        overlay.classList.remove('hidden');
        setTimeout(() => sfx('seal'), 450);
        setTimeout(() => {
            overlay.classList.add('hidden');
            overlay.innerHTML = '';
            commitInstrument(inst, after);
        }, 1500);
    }

    // ── Trading-card tilt (earned artifacts only) ─────────────────────────
    let _tiltRaf = 0;
    let _tiltEl = null;

    function tiltAllowed() {
        try {
            return window.matchMedia('(hover: hover)').matches &&
                !window.matchMedia('(prefers-reduced-motion: reduce)').matches;
        } catch (_) { return false; }
    }

    function resetTilt(el) {
        if (!el) return;
        el.style.removeProperty('--pp-tilt-x');
        el.style.removeProperty('--pp-tilt-y');
        el.style.removeProperty('--pp-glint-x');
    }

    function onTiltMove(e) {
        if (!tiltAllowed()) return;
        const card = e.target && e.target.closest ? e.target.closest('.pp-tilt') : null;
        if (_tiltEl && _tiltEl !== card) { resetTilt(_tiltEl); _tiltEl = null; }
        if (!card) return;
        _tiltEl = card;
        if (_tiltRaf) return;
        const x = e.clientX;
        const y = e.clientY;
        _tiltRaf = requestAnimationFrame(() => {
            _tiltRaf = 0;
            const r = card.getBoundingClientRect();
            if (!r.width || !r.height) return;
            const px = (x - r.left) / r.width;
            const py = (y - r.top) / r.height;
            card.style.setProperty('--pp-tilt-x', `${((0.5 - py) * 10).toFixed(2)}deg`);
            card.style.setProperty('--pp-tilt-y', `${((px - 0.5) * 12).toFixed(2)}deg`);
            card.style.setProperty('--pp-glint-x', `${(px * 100).toFixed(1)}%`);
        });
    }

    function onTiltLeave() {
        // Cancel any queued frame: it closes over the departed card and would
        // re-apply tilt vars after the pointer has left.
        if (_tiltRaf) { cancelAnimationFrame(_tiltRaf); _tiltRaf = 0; }
        if (_tiltEl) { resetTilt(_tiltEl); _tiltEl = null; }
    }

    // ── Shareable passport card (canvas → PNG, save or clipboard) ─────────
    // Keep in sync with the .pp-leather-* gradients in assets/career.css —
    // canvas can't consume a CSS class, so the pairs live twice on purpose.
    const PP_LEATHER_HEX = {
        guitar: ['#5c2321', '#401412'],
        bass: ['#1f3252', '#131f36'],
        keys: ['#1e4034', '#122a21'],
        drums: ['#3f3f46', '#26262b'],
    };

    function drawPassportCard(inst, p) {
        const W = 480;
        const H = 640;
        const canvas = document.createElement('canvas');
        canvas.width = W;
        canvas.height = H;
        const ctx = canvas.getContext('2d');
        const [c1, c2] = PP_LEATHER_HEX[inst] || PP_LEATHER_HEX.guitar;
        const bg = ctx.createLinearGradient(0, 0, W, H);
        bg.addColorStop(0, c1);
        bg.addColorStop(1, c2);
        ctx.fillStyle = bg;
        ctx.fillRect(0, 0, W, H);
        // Emboss frame
        ctx.strokeStyle = 'rgba(240,226,195,0.35)';
        ctx.lineWidth = 3;
        ctx.strokeRect(18, 18, W - 36, H - 36);
        // Genre title
        ctx.fillStyle = 'rgba(240,226,195,0.95)';
        ctx.textAlign = 'center';
        ctx.font = '700 34px Georgia, serif';
        ctx.fillText(p.genre.toUpperCase(), W / 2, 92, W - 80);
        ctx.font = '400 15px Georgia, serif';
        ctx.fillStyle = 'rgba(240,226,195,0.55)';
        ctx.fillText(`${ppLabel(inst).toUpperCase()} PASSPORT`, W / 2, 122);
        // Stamp ring
        const gold = p.badge === 'gold';
        const ink = gold ? '#d9a253' : '#b06a2a';
        const cy = 330;
        ctx.strokeStyle = ink;
        ctx.lineWidth = 6;
        ctx.beginPath();
        ctx.arc(W / 2, cy, 118, 0, Math.PI * 2);
        ctx.stroke();
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc(W / 2, cy, 106, 0, Math.PI * 2);
        ctx.stroke();
        ctx.fillStyle = ink;
        ctx.font = '800 26px Georgia, serif';
        ctx.fillText(p.genre.toUpperCase(), W / 2, cy - 6, 190);
        ctx.font = '600 16px Georgia, serif';
        ctx.fillText(gold ? 'G O L D' : 'B R O N Z E', W / 2, cy + 28);
        // Facts
        const stubCount = (p.songs || []).filter((sng) => sng.qualifies).length;
        const hours = fmtHours(p.seconds_total);
        ctx.fillStyle = 'rgba(240,226,195,0.75)';
        ctx.font = '400 17px Georgia, serif';
        ctx.fillText(`${stubCount} ticket stub${stubCount === 1 ? '' : 's'}${hours ? ` · ${hours} played` : ''}`, W / 2, 512);
        ctx.fillStyle = 'rgba(240,226,195,0.4)';
        ctx.font = '400 13px Georgia, serif';
        ctx.fillText('fee[dB]ack · career passport', W / 2, H - 44);
        return canvas;
    }

    // One export path for every canvas artifact: copy (with download
    // fallback + notice) or save, failures audible.
    function exportCanvasPng(canvas, filename, mode, noun) {
        canvas.toBlob(async (blob) => {
            const fail = (why) => {
                if (window.fbNotify) window.fbNotify.show({ icon: '⚠️', title: `${noun} export failed`, message: why });
            };
            if (!blob) { fail('The canvas produced no image.'); return; }
            try {
                const io = await import('/static/js/blob-io.js');
                if (mode === 'copy') {
                    const ok = await io.copyImageBlob(blob);
                    if (ok) {
                        if (window.fbNotify) window.fbNotify.show({ icon: '📋', title: `${noun} copied`, message: 'Paste it anywhere.' });
                        return;
                    }
                    if (window.fbNotify) window.fbNotify.show({ icon: '💾', title: 'Clipboard unavailable', message: `Saved the ${noun.toLowerCase()} instead.` });
                }
                io.downloadBlob(blob, filename);
            } catch (e) { fail('Export helper unavailable.'); }
        }, 'image/png');
    }

    function exportPassportCard(mode) {
        if (!_ppBook || !_pp) return;
        const { inst, gkey } = _ppBook;
        const p = (((_pp.instruments || {})[inst] || {}).passports || [])
            .find((x) => x.genre_key === gkey);
        if (!p) return;
        const canvas = drawPassportCard(inst, p);
        exportCanvasPng(canvas, `passport-${inst}-${gkey.replace(/[^a-z0-9-]+/g, '-')}.png`, mode, 'Card');
    }

    // ── Career surfaces outside the plugin screen ─────────────────────────
    // Profile passport wall + the home-page career card. Both inject into
    // core-owned mounts announced by v3:profile-rendered /
    // v3:dashboard-rendered (the achievements seam). Absent-not-empty: with
    // no committed instrument they render nothing and the dashboard keeps
    // its built-in fallback stat.

    function careerTotals() {
        if (!_pp) return null;
        let badges = 0;
        let seconds = 0;
        let gigs = 0;
        const walls = [];
        for (const inst of (_pp.config || {}).instruments || []) {
            const d = (_pp.instruments || {})[inst];
            // A commitment with no opened passport isn't a wall yet — the
            // external surfaces (profile, home card) stay ABSENT until a
            // passport exists (absent-not-empty).
            if (!d || !d.committed_at || !(d.passports || []).length) continue;
            const earned = (d.passports || []).filter((p) => p.badge === 'earned' || p.badge === 'gold');
            badges += earned.length;
            seconds += (d.passports || []).reduce((t, p) => t + (p.seconds_total || 0), 0);
            gigs += d.gig_count || 0;
            walls.push({ inst, earned, opened: d.passports.length });
        }
        if (!walls.length) return null;
        return { badges, seconds, gigs, walls };
    }

    function closestAskHTML() {
        if (!_pp) return '';
        let best = null;
        for (const inst of (_pp.config || {}).instruments || []) {
            for (const p of (((_pp.instruments || {})[inst] || {}).passports || [])) {
                if (p.badge !== 'in_progress') continue;
                const need = Math.max(0, ((p.requirement || {}).songs || 0) - p.qualifying_count);
                if (!best || need < best.need) best = { p, need };
            }
        }
        if (!best) return '';
        const starGl = '★'.repeat((best.p.requirement || {}).min_stars || 0);
        if (best.need > 0) {
            return `${esc(best.p.genre)} — ${best.need === 1 ? `one more ${starGl} song` : `${best.need} more ${starGl} songs`}`;
        }
        return `${esc(best.p.genre)} — one drill away`;
    }

    function renderProfileWall() {
        const mount = document.getElementById('v3-profile-passports-mount');
        if (!mount) return;
        const totals = careerTotals();
        if (!totals) { mount.innerHTML = ''; return; }
        const shelves = totals.walls.map(({ inst, earned, opened }) => {
            const covers = earned.map((p) =>
                `<button class="pp-wall-cover pp-leather-${esc(inst)}" data-pp-wall-inst="${esc(inst)}" data-pp-wall-gkey="${esc(p.genre_key)}" title="${esc(p.genre)}">
                    <span>${esc(p.genre.toUpperCase())}</span>
                    <em>${p.badge === 'gold' ? 'GOLD' : 'BRONZE'}</em>
                </button>`).join('');
            const line = earned.length
                ? covers
                : `<span class="pp-wall-none">${opened} passport${opened === 1 ? '' : 's'} open — first stamp pending</span>`;
            return `<div class="pp-wall-shelf"><span class="pp-wall-inst">${esc(ppLabel(inst))}</span>${line}</div>`;
        }).join('');
        const hours = fmtHours(totals.seconds);
        mount.innerHTML = `<div class="bg-fb-card/80 backdrop-blur rounded-lg p-4 border border-fb-border/50 pp-wall">
            <div class="pp-wall-head">
                <span>Passport wall</span>
                <span class="pp-wall-meta">${totals.badges} badge${totals.badges === 1 ? '' : 's'}${hours ? ` · ${hours} played` : ''}${totals.gigs ? ` · ${totals.gigs} gig${totals.gigs === 1 ? '' : 's'}` : ''}</span>
            </div>
            ${shelves}
            <button class="pp-wall-link" data-pp-wall-career="1">Open career →</button>
        </div>`;
        if (!mount.dataset.ppWired) {
            mount.dataset.ppWired = '1';
            mount.addEventListener('click', onWallClick);
        }
    }

    function onWallClick(e) {
        const open = e.target.closest('[data-pp-wall-inst]');
        if (open) {
            // Two attributes, not a '/'-joined pair: a genre key may itself
            // contain '/' ("drum/bass") and must round-trip intact.
            const inst = open.dataset.ppWallInst;
            const gkey = open.dataset.ppWallGkey;
            lsSet(PP_INST_KEY, inst);
            if (window.showScreen) window.showScreen('plugin-career');
            showCareerTab('passports');
            renderPassports();
            openBook(inst, gkey);
            return;
        }
        if (e.target.closest('[data-pp-wall-career]')) {
            if (window.showScreen) window.showScreen('plugin-career');
            showCareerTab('passports');
        }
    }

    function renderDashCard() {
        const slot = document.getElementById('v3-dash-career-slot');
        if (!slot) return;
        const totals = careerTotals();
        if (!totals) return; // keep core's fallback stat card
        const hours = fmtHours(totals.seconds);
        const ask = closestAskHTML();
        slot.innerHTML = `<button class="pp-dash-card" data-pp-wall-career="1">
            <span class="pp-dash-shine" aria-hidden="true"></span>
            <span class="pp-dash-head">Career</span>
            <span class="pp-dash-badges">${'⚡'.repeat(Math.min(totals.badges, 5))}<b>${totals.badges}</b> badge${totals.badges === 1 ? '' : 's'}</span>
            <span class="pp-dash-meta">${hours ? `${hours} played` : 'the stage is set'}${totals.gigs ? ` · ${totals.gigs} gig${totals.gigs === 1 ? '' : 's'}` : ''}</span>
            ${ask ? `<span class="pp-dash-ask">closest: ${ask}</span>` : ''}
        </button>`;
        if (!slot.dataset.ppWired) {
            slot.dataset.ppWired = '1';
            slot.addEventListener('click', onWallClick);
        }
    }

    // ── Gigs: booking poster → set runner → summary ──────────────────────

    function _venueName(venueId) {
        const v = (_state && _state.venues || []).find((x) => x.id === venueId);
        return v ? v.name : (venueId || 'the stage');
    }

    function gigPosterHTML(prop) {
        const bill = prop.songs.map((s, i) =>
            `<div class="pp-poster-line"><span>${i + 1}.</span> ${esc(s.title)}${s.artist ? ` <em>${esc(s.artist)}</em>` : ''}</div>`).join('');
        return `<div class="pp-book-wrap" data-pp-close-bg="1" role="dialog" aria-modal="true" aria-label="Gig poster">
            <div class="pp-poster">
                <div class="pp-poster-venue">${esc(prop.venue_name || 'The stage')}</div>
                <div class="pp-poster-presents">presents</div>
                <div class="pp-poster-title">${esc(prop.genre.toUpperCase())} NIGHT</div>
                <div class="pp-poster-inst">${esc(ppLabel(prop.instrument))} · tonight</div>
                <div class="pp-poster-bill">${bill}</div>
                <div class="pp-poster-actions">
                    <button class="career-btn career-btn-primary" data-pp-gig-play="1">Play the gig</button>
                    <button class="career-btn career-btn-ghost" data-pp-gig-reroll="1">Re-roll</button>
                    <button class="career-btn career-btn-ghost" data-pp-poster="save">Save</button>
                    <button class="career-btn career-btn-ghost" data-pp-poster="copy">Copy</button>
                </div>
                <button class="pp-book-close" data-pp-close="1" aria-label="Close">✕</button>
            </div>
        </div>`;
    }

    async function bookGig(gkey) {
        if (!_pp) return;
        const inst = activeInstrument();
        const p = (((_pp.instruments || {})[inst] || {}).passports || [])
            .find((x) => x.genre_key === gkey);
        if (!p) return;
        try {
            const res = await fetch(`${API}/gigs/propose`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ instrument: inst, genre: p.genre }),
            });
            if (!res.ok) return;
            _ppGigProposal = await res.json();
        } catch (_) { return; }
        const overlay = $('pp-overlay');
        if (!overlay) return;
        _ppBook = null; // the poster replaces the book in the overlay
        overlay.innerHTML = gigPosterHTML(_ppGigProposal);
        overlay.classList.remove('hidden');
        sfx('page');
    }

    // Unpack the whole set before the first note.
    //
    // A feedpak is a zip, and the first play of one pays for its extraction. In
    // a set that cost landed BETWEEN songs: the player finished a number and
    // then sat there waiting for the next one to unpack, mid-gig. The setlist is
    // known up front, so warm it all while the poster is still on screen.
    //
    // Best-effort by design: a library that won't pre-extract must not stop the
    // gig from starting — the play itself surfaces the error the same way it
    // does outside a gig. Slow is better than blocked.
    async function prepareGigSongs(prop, btn) {
        const label = btn && btn.textContent;
        if (btn) { btn.disabled = true; btn.textContent = 'Preparing set…'; }
        try {
            await fetch(`${API}/gigs/prepare`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ songs: prop.songs.map((s) => s.filename) }),
            });
        } catch (_) { /* start anyway — first play will extract as it always did */ }
        if (btn) { btn.disabled = false; if (label) btn.textContent = label; }
    }

    async function startGig(btn) {
        const prop = _ppGigProposal;
        const q = window.feedBack && window.feedBack.playQueue;
        if (!prop || !q || typeof q.start !== 'function' || typeof window.playSong !== 'function') return;

        // Extract the setlist BEFORE the stage is borrowed and the queue starts,
        // so a failure here leaves nothing half-applied to unwind.
        await prepareGigSongs(prop, btn);
        // The poster's Play could have been cancelled while we were unpacking.
        if (_ppGigProposal !== prop) return;

        // The gig BORROWS the stage: stash whatever venue/viz the user had so
        // the set ending gives it back (unlike "Play here", which is an
        // explicit persistent choice on the venue card).
        let restore = null;
        if (prop.venue_id) {
            // Capture the restore snapshot BEFORE any write: if a later write
            // (or setViz) throws, the stage must still be returnable.
            try {
                restore = {
                    venue: localStorage.getItem(VENUE_OVERRIDE_KEY),
                    viz: localStorage.getItem('vizSelection'),
                };
            } catch (_) { restore = null; }
            try {
                localStorage.setItem(VENUE_OVERRIDE_KEY, prop.venue_id);
                localStorage.setItem('vizSelection', 'venue');
                if (typeof window.setViz === 'function') window.setViz('venue');
            } catch (_) { /* viz optional — restore stays intact */ }
        }
        _appliedManifestVenue = null;
        _ppGigRun = {
            songs: prop.songs,
            venue_id: prop.venue_id,
            genre: prop.genre,
            genre_key: prop.genre_key,
            instrument: prop.instrument,
            idx: 0,
            restore,
        };
        closeBook();
        _ppGigProposal = null;
        // RAW filenames: the queue itself encodes for playSong — pre-encoding
        // double-encodes and breaks loading + the stats/gig filename join.
        if (!q.start(prop.songs.map((s) => s.filename), { source: 'gig' })) {
            _ppGigRun = null;
            return;
        }
        renderGigStrip();
    }

    function restoreGigStage(run) {
        const r = run && run.restore;
        if (!r) return;
        try {
            if (r.venue == null) localStorage.removeItem(VENUE_OVERRIDE_KEY);
            else localStorage.setItem(VENUE_OVERRIDE_KEY, r.venue);
            if (r.viz && r.viz !== 'venue') {
                localStorage.setItem('vizSelection', r.viz);
                if (typeof window.setViz === 'function') window.setViz(r.viz);
            }
        } catch (_) { /* best effort */ }
        _appliedManifestVenue = null;
    }

    function renderGigStrip() {
        if (!_ppGigRun || !document.body || typeof document.createElement !== 'function') return;
        let strip = document.getElementById('pp-gig-strip');
        if (!strip) {
            strip = document.createElement('div');
            strip.id = 'pp-gig-strip';
            strip.className = 'pp-gig-strip';
            document.body.appendChild(strip);
        }
        const run = _ppGigRun;
        const next = run.songs[run.idx + 1];
        strip.innerHTML = `<b>GIG</b> · ${esc(run.genre)} at ${esc(_venueName(run.venue_id))} · set ${Math.min(run.idx + 1, run.songs.length)}/${run.songs.length}${next ? ` — next: <em>${esc(next.title)}</em>` : ' — closer!'}`;
    }

    function removeGigStrip() {
        const strip = document.getElementById('pp-gig-strip');
        if (strip) strip.remove();
    }

    function abandonGig() {
        // No fail state: an abandoned set logs nothing and says nothing.
        const run = _ppGigRun;
        _ppGigRun = null;
        removeGigStrip();
        restoreGigStage(run);
    }

    function completeGig() {
        const run = _ppGigRun;
        _ppGigRun = null;
        removeGigStrip();
        restoreGigStage(run);
        // The final song's own stats POST races this moment (both ride
        // song:ended): wait for its stats:recorded — or a short timeout, since
        // an UNSCORED play never emits one — so /gigs reads the set's real
        // accuracies, not last week's.
        const lastFile = run.songs[run.songs.length - 1].filename;
        const sm = window.feedBack;
        let done = false;
        const proceed = () => {
            if (done) return;
            done = true;
            if (sm && typeof sm.off === 'function') { try { sm.off('stats:recorded', onRec); } catch (_) { /* ok */ } }
            postGig(run);
        };
        const onRec = (e) => {
            const d = (e && e.detail) || {};
            if (d.filename === lastFile) proceed();
        };
        if (sm && typeof sm.on === 'function') sm.on('stats:recorded', onRec);
        setTimeout(proceed, 3500);
    }

    async function postGig(run) {
        let gig = null;
        try {
            const res = await fetch(`${API}/gigs`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    instrument: run.instrument,
                    genre: run.genre,
                    venue_id: run.venue_id,
                    songs: run.songs.map((s) => s.filename),
                }),
            });
            if (res.ok) gig = (await res.json()).gig;
        } catch (_) { /* summary still shows, unlogged */ }
        showGigSummary(run, gig);
        refreshPassports();
    }

    function showGigSummary(run, gig) {
        if (!document.body || typeof document.createElement !== 'function') return;
        const entries = (gig && gig.songs) || run.songs.map((s) => ({ filename: s.filename, title: s.title, accuracy: null }));
        const encore = !!(gig && gig.encore);
        if (encore && !reducedMotion()) {
            const crowd = window.v3VenueCrowd;
            if (crowd && typeof crowd.celebrate === 'function') {
                try { crowd.celebrate(); } catch (_) { /* optional */ }
            }
        }
        const el = document.createElement('div');
        el.id = 'pp-gig-summary';
        el.className = 'pp-ceremony-overlay';
        el.innerHTML = `<canvas class="pp-confetti"></canvas>
            <div class="pp-poster pp-poster-summary">
                <div class="pp-poster-venue">${esc(_venueName(run.venue_id))}</div>
                <div class="pp-poster-title">${esc(run.genre.toUpperCase())} NIGHT</div>
                <div class="pp-poster-inst">${encore ? 'ENCORE! ' : ''}the set, as played</div>
                <div class="pp-poster-bill">${entries.map((s, i) =>
                    `<div class="pp-poster-line"><span>${i + 1}.</span> ${esc(s.title)}${s.accuracy != null ? ` <b>${Math.floor(s.accuracy * 100)}%</b>` : ''}</div>`).join('')}</div>
                <div class="pp-poster-actions">
                    <button class="career-btn career-btn-ghost" data-pp-poster="save">Save poster</button>
                    <button class="career-btn career-btn-ghost" data-pp-poster="copy">Copy poster</button>
                    <button class="career-btn career-btn-primary" data-pp-gig-done="1">Done</button>
                </div>
            </div>`;
        el.addEventListener('click', (e) => {
            if (e.target === el || e.target.closest('[data-pp-gig-done]')) {
                el.remove();
            } else if (e.target.closest('[data-pp-poster]')) {
                exportGigPoster(e.target.closest('[data-pp-poster]').dataset.ppPoster,
                    { ...run, encore, entries });
            }
        });
        document.body.appendChild(el);
        if (encore && !reducedMotion()) confettiBurst(el.querySelector('.pp-confetti'));
    }

    function drawGigPoster(data) {
        const W = 480;
        const H = 640;
        const canvas = document.createElement('canvas');
        canvas.width = W;
        canvas.height = H;
        const ctx = canvas.getContext('2d');
        const bg = ctx.createLinearGradient(0, 0, 0, H);
        bg.addColorStop(0, '#141019');
        bg.addColorStop(1, '#241318');
        ctx.fillStyle = bg;
        ctx.fillRect(0, 0, W, H);
        ctx.strokeStyle = 'rgba(217,162,83,0.5)';
        ctx.lineWidth = 3;
        ctx.strokeRect(16, 16, W - 32, H - 32);
        ctx.textAlign = 'center';
        ctx.fillStyle = 'rgba(240,226,195,0.65)';
        ctx.font = '400 18px Georgia, serif';
        ctx.fillText(_venueName(data.venue_id), W / 2, 76, W - 80);
        ctx.font = '400 12px Georgia, serif';
        ctx.fillText('P R E S E N T S', W / 2, 102);
        ctx.fillStyle = '#d9a253';
        ctx.font = '800 40px Georgia, serif';
        ctx.fillText(`${data.genre.toUpperCase()}`, W / 2, 160, W - 60);
        ctx.font = '800 26px Georgia, serif';
        ctx.fillText('NIGHT', W / 2, 194);
        if (data.encore) {
            ctx.fillStyle = '#f3d179';
            ctx.font = '700 16px Georgia, serif';
            ctx.fillText('— E N C O R E —', W / 2, 226);
        }
        ctx.fillStyle = 'rgba(240,226,195,0.85)';
        ctx.font = '400 18px Georgia, serif';
        const entries = data.entries || data.songs || [];
        entries.slice(0, 6).forEach((sng, i) => {
            const acc = sng.accuracy != null ? `  ·  ${Math.floor(sng.accuracy * 100)}%` : '';
            ctx.fillText(`${sng.title}${acc}`, W / 2, 290 + i * 44, W - 80);
        });
        ctx.fillStyle = 'rgba(240,226,195,0.4)';
        ctx.font = '400 13px Georgia, serif';
        ctx.fillText(`${ppLabel(data.instrument || 'guitar')} · fee[dB]ack career`, W / 2, H - 42);
        return canvas;
    }

    function exportGigPoster(mode, data) {
        exportCanvasPng(drawGigPoster(data),
            `gig-${(data.genre_key || 'set').replace(/[^a-z0-9-]+/g, '-')}.png`, mode, 'Poster');
    }

    // Queue lifecycle: advance the strip per song; complete or abandon.
    function onGigSongLoading() {
        if (!_ppGigRun) return;
        renderGigStrip();
    }

    function onGigSongEnded() {
        if (!_ppGigRun) return;
        const q = window.feedBack && window.feedBack.playQueue;
        if (!q || typeof q.remaining !== 'function') return;
        // Only OUR live queue counts: remaining()===0 is also true for a
        // cleared/foreign queue (a manual play silently clears the gig queue,
        // and that unrelated song's end must not log a gig).
        if (q.source && q.source() !== 'gig') { abandonGig(); return; }
        if (!q.remaining()) {
            if (q.active && q.active()) completeGig();
            else abandonGig();
            return;
        }
        _ppGigRun.idx = Math.min(_ppGigRun.idx + 1, _ppGigRun.songs.length - 1);
        renderGigStrip();
    }

    function onGigSongStop() {
        // A deliberate quit mid-set (Escape clears the queue) abandons the
        // gig — but the LAST song's teardown also fires song:stop after
        // song:ended, so only abandon while songs genuinely remain.
        if (!_ppGigRun) return;
        const q = window.feedBack && window.feedBack.playQueue;
        const active = q && typeof q.active === 'function' ? q.active() : false;
        if (!active) abandonGig();
    }

    function openGenre(inst, genre) {
        fetch(`${API}/passports/open`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ instrument: inst, genre }),
        }).then((res) => { if (!res.ok) throw new Error('open ' + res.status); })
            .then(() => refreshPassports())
            .then(() => openBook(inst, ppKey(genre)))
            .catch(() => { /* validation/restart; rack stays */ });
    }

    function onClick(e) {
        const tabBtn = e.target.closest('[data-career-tab]');
        const instBtn = e.target.closest('[data-pp-inst]');
        const commitBtn = e.target.closest('[data-pp-commit]');
        const coverBtn = e.target.closest('[data-pp-open]');
        const brochureBtn = e.target.closest('[data-pp-genre]');
        if (tabBtn) {
            showCareerTab(tabBtn.dataset.careerTab);
            return;
        }
        if (instBtn) {
            lsSet(PP_INST_KEY, instBtn.dataset.ppInst);
            renderPassports();
            return;
        }
        if (commitBtn) {
            sealCeremony(commitBtn.dataset.ppCommit);
            return;
        }
        if (coverBtn) {
            openBook(activeInstrument(), coverBtn.dataset.ppOpen);
            return;
        }
        if (brochureBtn) {
            const inst = activeInstrument();
            const genre = brochureBtn.dataset.ppGenre;
            const committed = _pp && ((_pp.instruments || {})[inst] || {}).committed_at;
            // Opening your first passport on an instrument IS the commitment —
            // the seal ceremony runs first, then the passport opens.
            if (committed) openGenre(inst, genre);
            else sealCeremony(inst, () => openGenre(inst, genre));
            return;
        }
        if (e.target.closest('[data-pp-close]') ||
            (e.target.dataset && e.target.dataset.ppCloseBg)) {
            closeBook();
            return;
        }
        const gigBtn = e.target.closest('[data-pp-gig]');
        if (gigBtn) { bookGig(gigBtn.dataset.ppGig); return; }
        if (e.target.closest('[data-pp-gig-play]')) { startGig(e.target.closest('[data-pp-gig-play]')); return; }
        if (e.target.closest('[data-pp-gig-reroll]')) {
            if (_ppGigProposal) bookGig(_ppGigProposal.genre_key);
            return;
        }
        const posterBtn = e.target.closest('[data-pp-poster]');
        if (posterBtn && _ppGigProposal) {
            exportGigPoster(posterBtn.dataset.ppPoster, _ppGigProposal);
            return;
        }
        const cardBtn = e.target.closest('[data-pp-card]');
        if (cardBtn) {
            exportPassportCard(cardBtn.dataset.ppCard);
            return;
        }
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
            try {
                localStorage.setItem(VENUE_OVERRIDE_KEY, playBtn.dataset.careerPlay);
                // Selecting a venue makes the Venue visualization the default;
                // remember what the user had so Leave venue can restore it.
                const cur = localStorage.getItem('vizSelection');
                if (cur && cur !== 'venue') localStorage.setItem(PREV_VIZ_KEY, cur);
                localStorage.setItem('vizSelection', 'venue');
                if (typeof window.setViz === 'function') window.setViz('venue');
            } catch (_) { /* ok */ }
            _appliedManifestVenue = null; // force manifest re-push
            refresh();
        } else if (e.target.closest('[data-career-unselect]')) {
            try {
                localStorage.setItem(VENUE_OVERRIDE_KEY, NO_VENUE);
                const prev = localStorage.getItem(PREV_VIZ_KEY);
                if (prev) {
                    localStorage.setItem('vizSelection', prev);
                    if (typeof window.setViz === 'function') window.setViz(prev);
                }
            } catch (_) { /* ok */ }
            // keep _appliedManifestVenue: pushCrowdManifest clears the crowd
            // manifest precisely by seeing it is still set with no venue left
            refresh();
        }
    }

    function boot() {
        const screen = document.getElementById('plugin-career');
        if (screen) {
            screen.addEventListener('click', onClick);
            screen.addEventListener('pointermove', onTiltMove);
            screen.addEventListener('pointerleave', onTiltLeave);
        }
        const sm = window.feedBack;
        if (sm && typeof sm.on === 'function') {
            // New song stats can add stars → thresholds may cross mid-session.
            sm.on('stats:recorded', () => refresh());
            // Gig runner lifecycle (no-ops when no gig is live).
            sm.on('song:loading', onGigSongLoading);
            sm.on('song:ended', onGigSongEnded);
            sm.on('song:stop', onGigSongStop);
            // Virtuoso's progress emits are the drill-state relay trigger; the
            // payload is a thin delta, so the relay reads the full localStorage
            // snapshot instead (see relayDrillState).
            sm.on('virtuoso:progress', relayDrillState);
        }
        showCareerTab(lsGet(PP_TAB_KEY) === 'passports' ? 'passports' : 'venues');
        document.addEventListener('keydown', (e) => {
            if (e.key !== 'Escape') return;
            const overlay = $('pp-overlay');
            if (_ppBook || (overlay && !overlay.classList.contains('hidden'))) closeBook();
        });
        // Core re-renders profile/dashboard shells (innerHTML wipe) and
        // announces the fresh mount points — same seam achievements uses.
        document.addEventListener('v3:profile-rendered', renderProfileWall);
        document.addEventListener('v3:dashboard-rendered', renderDashCard);
        refresh();
    }

    // Test seam (bare-vm harness, see plugins/career/tests/): pure helpers +
    // the badge-diff logic; nothing here touches the DOM.
    window.__careerPassportTest = {
        ppKey, ppJitter, ppLabel, detectNewBadges, seenBadges, markBadgeSeen,
        fmtHours, ppFillFraction, careerTotals, closestAskHTML,
        onGigSongEnded, onGigSongStop,
        setGigRun(r) { _ppGigRun = r; },
        getGigRun() { return _ppGigRun; },
        setView(v) { _pp = v; },
    };

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', boot);
    } else {
        boot();
    }
}());
