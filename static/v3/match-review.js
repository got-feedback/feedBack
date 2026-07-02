// Match-Review UI (P8 — library-metadata design §5/§11). A self-contained
// module: the ambient "⚑ N to review" chip lives in the songs toolbar (songs.js
// renders the element and calls the hooks below), everything else — the
// review drawer, accept / not-a-match / search-and-pick — lives here.
//
// Engagement guardrails (§11): this is opt-in tool-state, not a score. The
// chip only appears when there is something to review, matching is silent on
// success (no toasts, no sounds — hearing-safe), and nothing here ever writes
// to pack files; a confirmed match only improves the local display cache.
(function () {
    'use strict';

    const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => (
        { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    const enc = encodeURIComponent;

    function artUrl(song) {
        const v = song.mtime ? ('?v=' + Math.floor(song.mtime)) : '';
        return '/api/song/' + enc(song.filename) + '/art' + v;
    }

    function fmtDur(sec) {
        if (!sec && sec !== 0) return '';
        const s = Math.max(0, Math.round(sec));
        return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
    }

    // ── Ambient chip ─────────────────────────────────────────────────────────
    // songs.js renders `#v3-songs-match-review` (hidden) in its toolbar and
    // calls window.__fbMatchReviewChip() after each toolbar build; review
    // actions in the drawer re-call it. Silent on failure — the chip simply
    // stays hidden when the endpoint is unreachable.
    let _chipBusy = false;
    async function refreshChip() {
        const chip = document.getElementById('v3-songs-match-review');
        if (!chip || _chipBusy) return;
        _chipBusy = true;
        try {
            const r = await fetch('/api/enrichment/status');
            if (!r.ok) return;
            const n = ((await r.json()).states || {}).review || 0;
            chip.textContent = '⚑ ' + n + ' to review';
            chip.classList.toggle('hidden', !n);
        } catch (_) { /* offline — leave hidden */ } finally {
            _chipBusy = false;
        }
    }

    // ── Drawer (body-appended singleton, filter-drawer slide idiom) ─────────
    let _lastFocus = null;

    function ensureDrawer() {
        let d = document.getElementById('v3-match-drawer');
        if (d) return d;
        const overlay = document.createElement('div');
        overlay.id = 'v3-match-overlay';
        overlay.className = 'fixed inset-0 bg-black/50 z-40 hidden';
        overlay.addEventListener('click', closeDrawer);
        document.body.appendChild(overlay);
        d = document.createElement('aside');
        d.id = 'v3-match-drawer';
        d.className = 'fixed top-0 right-0 h-full w-full sm:w-96 bg-fb-sidebar border-l border-fb-border/50 z-50 transform translate-x-full transition-transform duration-200 overflow-y-auto v3-scroll';
        d.setAttribute('role', 'dialog');
        d.setAttribute('aria-label', 'Match review');
        d.addEventListener('keydown', (e) => {
            if (e.key === 'Escape') { e.stopPropagation(); closeDrawer(); return; }
            if (e.key !== 'Tab') return;
            // Light focus trap: cycle within the drawer.
            const foci = d.querySelectorAll('button, input, [tabindex="0"]');
            if (!foci.length) return;
            const first = foci[0], last = foci[foci.length - 1];
            if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
            else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
        });
        document.body.appendChild(d);
        return d;
    }

    function openDrawer() {
        _lastFocus = document.activeElement;
        const d = ensureDrawer();
        renderLoading(d);
        d.classList.remove('translate-x-full');
        document.getElementById('v3-match-overlay')?.classList.remove('hidden');
        loadQueue();
    }

    function closeDrawer() {
        document.getElementById('v3-match-drawer')?.classList.add('translate-x-full');
        document.getElementById('v3-match-overlay')?.classList.add('hidden');
        refreshChip();
        if (_lastFocus && _lastFocus.isConnected) { try { _lastFocus.focus(); } catch (_) { } }
        _lastFocus = null;
    }

    function headerHtml() {
        return '<div class="flex items-center justify-between">' +
            '<h3 class="text-lg font-semibold text-fb-text">Match review</h3>' +
            '<button data-mr-close class="text-fb-textDim hover:text-fb-text" aria-label="Close">✕</button></div>' +
            '<p class="text-xs text-fb-textDim mt-1">These charts matched MusicBrainz with medium confidence. ' +
            'Confirm the right recording — it only improves names, art and grouping. Nothing is written to your files.</p>';
    }

    function renderLoading(d) {
        d.innerHTML = '<div class="p-5 space-y-4">' + headerHtml() +
            '<p class="text-sm text-fb-textDim">Loading…</p></div>';
        d.querySelector('[data-mr-close]')?.addEventListener('click', closeDrawer);
    }

    async function loadQueue() {
        const d = document.getElementById('v3-match-drawer');
        if (!d) return;
        let songs = [];
        try {
            const r = await fetch('/api/enrichment/review?limit=200');
            if (r.ok) songs = (await r.json()).songs || [];
        } catch (_) { /* render the empty state below */ }
        renderQueue(d, songs);
    }

    function candRowHtml(c, i) {
        const meta = [c.artist, c.album, c.year, fmtDur(c.duration)].filter(Boolean).join(' · ');
        const pct = c.score != null ? Math.round(c.score * 100) + '%' : '';
        return '<button data-mr-cand="' + i + '" class="w-full text-left px-3 py-2 rounded-md border border-fb-border/50 bg-gray-800/50 hover:border-fb-primary group">' +
            '<span class="flex items-baseline justify-between gap-2">' +
            '<span class="text-sm text-fb-text truncate">' + esc(c.title) + '</span>' +
            '<span class="text-xs text-fb-textDim shrink-0">' + esc(pct) + '</span></span>' +
            '<span class="block text-xs text-fb-textDim truncate">' + esc(meta) + '</span>' +
            '<span class="block text-xs text-fb-primary opacity-0 group-hover:opacity-100">Use this match</span>' +
            '</button>';
    }

    function songBlockHtml(s, idx) {
        const sub = [s.artist, s.album, s.year].filter(Boolean).join(' · ');
        return '<div data-mr-song="' + idx + '" class="border border-fb-border/50 rounded-lg p-3 space-y-2">' +
            '<div class="flex items-center gap-3">' +
            '<img src="' + esc(artUrl(s)) + '" alt="" loading="lazy" class="w-10 h-10 rounded object-cover bg-fb-card" onerror="this.style.visibility=\'hidden\'">' +
            '<div class="min-w-0"><div class="text-sm text-fb-text truncate">' + esc(s.title) + '</div>' +
            '<div class="text-xs text-fb-textDim truncate">' + esc(sub) + '</div></div></div>' +
            '<div class="space-y-1">' + (s.candidates || []).map(candRowHtml).join('') + '</div>' +
            '<div class="flex items-center gap-3 pt-1">' +
            '<button data-mr-reject class="text-xs text-fb-textDim hover:text-fb-text">Not a match</button>' +
            '<button data-mr-search-toggle class="text-xs text-fb-textDim hover:text-fb-text">Search instead…</button></div>' +
            '<div data-mr-search-panel class="hidden space-y-2">' +
            '<div class="flex gap-2">' +
            '<input data-mr-search-input type="text" class="flex-1 bg-gray-800/50 border border-gray-700 rounded-md px-2 py-1 text-sm text-fb-text outline-none focus:border-fb-primary" placeholder="Artist – Title">' +
            '<button data-mr-search-go class="text-sm text-fb-primary hover:text-fb-primaryHi border border-fb-primary/40 rounded-md px-3">Search</button></div>' +
            '<div data-mr-search-results class="space-y-1"></div></div>' +
            '</div>';
    }

    function renderQueue(d, songs) {
        _queue = songs;
        if (!songs.length) {
            d.innerHTML = '<div class="p-5 space-y-4">' + headerHtml() +
                '<p class="text-sm text-fb-textDim">Nothing waiting for review.</p></div>';
            d.querySelector('[data-mr-close]')?.addEventListener('click', closeDrawer);
            return;
        }
        d.innerHTML = '<div class="p-5 space-y-4">' + headerHtml() +
            songs.map(songBlockHtml).join('') + '</div>';
        d.querySelector('[data-mr-close]')?.addEventListener('click', closeDrawer);
        d.querySelectorAll('[data-mr-song]').forEach((block) => wireSongBlock(block));
        (d.querySelector('button') || d).focus?.();
    }

    let _queue = [];

    function wireSongBlock(block) {
        const song = _queue[Number(block.getAttribute('data-mr-song'))];
        if (!song) return;
        block.querySelectorAll('[data-mr-cand]').forEach((btn) => {
            btn.addEventListener('click', async () => {
                const cand = (song.candidates || [])[Number(btn.getAttribute('data-mr-cand'))];
                if (!cand) return;
                await post('/api/enrichment/review/' + enc(song.filename) + '/accept',
                    { recording_id: cand.recording_id });
                removeBlock(block);
            });
        });
        block.querySelector('[data-mr-reject]')?.addEventListener('click', async () => {
            await post('/api/enrichment/review/' + enc(song.filename) + '/reject');
            removeBlock(block);
        });
        const panel = block.querySelector('[data-mr-search-panel]');
        const input = block.querySelector('[data-mr-search-input]');
        block.querySelector('[data-mr-search-toggle]')?.addEventListener('click', () => {
            panel?.classList.toggle('hidden');
            if (panel && !panel.classList.contains('hidden') && input && !input.value) {
                input.value = [song.artist, song.title].filter(Boolean).join(' – ');
                input.focus();
            }
        });
        const go = () => runSearch(block, song);
        block.querySelector('[data-mr-search-go]')?.addEventListener('click', go);
        input?.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); go(); } });
    }

    async function runSearch(block, song) {
        const input = block.querySelector('[data-mr-search-input]');
        const out = block.querySelector('[data-mr-search-results]');
        if (!input || !out) return;
        const qRaw = input.value.trim();
        if (!qRaw) return;
        // "Artist – Title" splits on the first dash; a plain phrase searches
        // as a title, which MusicBrainz handles well enough.
        const m = qRaw.split(/\s+[–—-]\s+/);
        const artist = m.length > 1 ? m[0] : '';
        const title = m.length > 1 ? m.slice(1).join(' - ') : qRaw;
        out.innerHTML = '<p class="text-xs text-fb-textDim">Searching…</p>';
        let body = null;
        try {
            const r = await fetch('/api/enrichment/search?artist=' + enc(artist) +
                '&title=' + enc(title) + '&filename=' + enc(song.filename));
            if (r.status === 503) {
                out.innerHTML = '<p class="text-xs text-fb-textDim">MusicBrainz is unavailable — try again later.</p>';
                return;
            }
            if (r.ok) body = await r.json();
        } catch (_) { /* falls through to the error line below */ }
        const cands = (body && body.candidates) || [];
        if (!cands.length) {
            out.innerHTML = '<p class="text-xs text-fb-textDim">No results.</p>';
            return;
        }
        out.innerHTML = cands.map(candRowHtml).join('');
        out.querySelectorAll('[data-mr-cand]').forEach((btn) => {
            btn.addEventListener('click', async () => {
                const cand = cands[Number(btn.getAttribute('data-mr-cand'))];
                if (!cand) return;
                await post('/api/enrichment/review/' + enc(song.filename) + '/pick',
                    { candidate: cand });
                removeBlock(block);
            });
        });
    }

    async function post(url, payload) {
        try {
            await fetch(url, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload || {}),
            });
        } catch (_) { /* offline — the row simply stays queued */ }
    }

    // Silent-on-success: the block just leaves the queue; when it was the
    // last one the empty state renders. No toasts, no sounds.
    function removeBlock(block) {
        const d = document.getElementById('v3-match-drawer');
        block.remove();
        refreshChip();
        if (d && !d.querySelector('[data-mr-song]')) renderQueue(d, []);
    }

    window.__fbMatchReviewChip = refreshChip;
    window.__fbOpenMatchReview = openDrawer;
})();
