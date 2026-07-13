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

    function badgeId(inst, gkey) { return inst + '/' + gkey; }

    function markBadgeSeen(inst, gkey) {
        const seen = seenBadges();
        seen[badgeId(inst, gkey)] = 1;
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
                const id = badgeId(inst, p.genre_key);
                if (p.badge !== 'earned' || seen[id] || _ppNotified[id]) continue;
                _ppNotified[id] = true;
                sfx('chime');
                if (window.fbNotify && typeof window.fbNotify.show === 'function') {
                    window.fbNotify.show({
                        big: true, icon: '🛂', accent: '#b45309',
                        title: 'Badge earned!',
                        message: `${p.genre} — Bronze, ready to stamp into your ${ppLabel(inst)} passport.`,
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
                <div class="pp-stamp pp-stamp-page pp-ceremony-stamp" style="--pp-rot:${ppJitter(p.genre_key, 7).toFixed(1)}deg">
                    <span class="pp-stamp-genre">${esc(p.genre.toUpperCase())}</span>
                    <span class="pp-stamp-tier">BRONZE</span>
                </div>
                <div class="pp-ceremony-title">Badge earned</div>
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
                body: JSON.stringify({ mode: snap.mode, xp: snap.xp, byNode: snap.byNode }),
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
        if (!_ppBootstrapped) {
            _ppBootstrapped = true;
            // First run on this browser: seed the server with the local drill
            // snapshot if it has never received one.
            if (!(view.drill_state || {}).received_at) relayDrillState();
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
        const stamp = p.badge === 'earned'
            ? `<span class="pp-stamp pp-stamp-mini" style="--pp-rot:${ppJitter(p.genre_key, 8).toFixed(1)}deg">BRONZE</span>`
            : '';
        const stubs = p.qualifying_count === 1 ? '1 stub' : `${p.qualifying_count} stubs`;
        const hours = fmtHours(p.seconds_total);
        return `<button class="pp-cover pp-leather-${esc(inst)}" data-pp-open="${esc(p.genre_key)}" style="transform:rotate(${rot}deg)">
            <span class="pp-cover-title">${esc(p.genre.toUpperCase())}</span>
            <span class="pp-cover-inst">${esc(ppLabel(inst))} passport</span>
            ${stamp}
            <span class="pp-cover-sub">${stubs}${hours ? ` · ${hours}` : ''}</span>
        </button>`;
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
            const earned = (d.passports || []).filter((p) => p.badge === 'earned').length;
            const committed = !!d.committed_at;
            return `<button class="pp-inst${i === inst ? ' active' : ''}${committed ? '' : ' uncommitted'}" data-pp-inst="${esc(i)}">
                ${esc(ppLabel(i))}${earned ? ` <span class="pp-inst-badges">⚡${earned}</span>` : ''}${committed ? '' : ' <span class="pp-inst-plus">+</span>'}
            </button>`;
        }).join('');
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

    function ppBookHTML(inst, p, pendingSlam) {
        const req = p.requirement || {};
        const need = Math.max(0, (req.songs || 0) - p.qualifying_count);
        const starGl = '★'.repeat(req.min_stars || 0);
        let badgeArea = '';
        if (p.badge === 'shown_not_judged') {
            badgeArea = `<div class="pp-snj">Shown, not judged — your ${esc(ppLabel(inst).toLowerCase())} repertoire speaks for itself.</div>`;
        } else if (p.badge === 'earned') {
            badgeArea = `<div class="pp-stamp pp-stamp-page${pendingSlam ? ' pp-stamp-hidden' : ''}" style="--pp-rot:${ppJitter(p.genre_key, 7).toFixed(1)}deg">
                <span class="pp-stamp-genre">${esc(p.genre.toUpperCase())}</span>
                <span class="pp-stamp-tier">BRONZE</span>
            </div>
            <div class="pp-gold-note">Gold rung coming — improvise it, verified.</div>`;
        } else {
            badgeArea = `<div class="pp-stamp pp-stamp-page pp-stamp-ghost" style="--pp-rot:${ppJitter(p.genre_key, 7).toFixed(1)}deg">
                <span class="pp-stamp-genre">${esc(p.genre.toUpperCase())}</span>
                <span class="pp-stamp-tier">BRONZE</span>
            </div>
            <div class="pp-invite">${need === 1 ? `One more ${starGl} song mints this stamp.` : `${need} more ${starGl} songs mint this stamp.`}</div>`;
        }
        const hours = fmtHours(p.seconds_total);
        const odometer = hours
            ? `<div class="pp-hours">${hours} in ${esc(p.genre)}</div>` : '';
        let drills = '';
        const reqNodes = (p.drills || {}).required || [];
        if (reqNodes.length) {
            const cleared = new Set((p.drills || {}).cleared || []);
            drills = `<div class="pp-drills">${reqNodes.map((n) =>
                `<div class="pp-drill${cleared.has(n) ? ' cleared' : ''}">${cleared.has(n) ? '✓' : '○'} ${esc(n)}</div>`).join('')}</div>`;
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
        return `<div class="pp-book-wrap" data-pp-close-bg="1" role="dialog" aria-modal="true" aria-label="${esc(p.genre)} ${esc(ppLabel(inst))} passport">
            <div class="pp-book">
                <div class="pp-page pp-page-left">
                    <div class="pp-page-head">${esc(p.genre)} — ${esc(ppLabel(inst))}</div>
                    ${badgeArea}${odometer}${drills}
                </div>
                <div class="pp-page pp-page-right">
                    <div class="pp-page-head">Ticket stubs</div>
                    <div class="pp-stubs">${stubsHTML}</div>
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
        const pending = p.badge === 'earned' && !seenBadges()[badgeId(inst, gkey)];
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
                if (book) book.classList.add('pp-shake');
                sfx('stamp');
                markBadgeSeen(inst, gkey);
                renderPassports(); // the shelf cover gains its mini-stamp
            }, 950);
        }
    }

    function closeBook() {
        _ppBook = null;
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
        if (screen) screen.addEventListener('click', onClick);
        const sm = window.feedBack;
        if (sm && typeof sm.on === 'function') {
            // New song stats can add stars → thresholds may cross mid-session.
            sm.on('stats:recorded', () => refresh());
            // Virtuoso's progress emits are the drill-state relay trigger; the
            // payload is a thin delta, so the relay reads the full localStorage
            // snapshot instead (see relayDrillState).
            sm.on('virtuoso:progress', relayDrillState);
        }
        showCareerTab(lsGet(PP_TAB_KEY) === 'passports' ? 'passports' : 'venues');
        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape' && _ppBook) closeBook();
        });
        refresh();
    }

    // Test seam (bare-vm harness, see plugins/career/tests/): pure helpers +
    // the badge-diff logic; nothing here touches the DOM.
    window.__careerPassportTest = {
        ppKey, ppJitter, ppLabel, detectNewBadges, seenBadges, markBadgeSeen,
        fmtHours,
    };

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', boot);
    } else {
        boot();
    }
}());
