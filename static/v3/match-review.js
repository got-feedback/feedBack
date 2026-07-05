// Match-Review UI (P8 — library-metadata design §5/§11). A self-contained
// module: the ambient "⚑ N to review" chip lives in the songs toolbar
// (songs.js renders the element and calls the hooks below); the review MODAL,
// the per-field available/missing detail, and the Settings → Library
// "Metadata matching" card behaviour all live here.
//
// The modal reviews ONE chart at a time (the scraper-review model from
// media-server / emulation-frontend apps): the chart's current metadata —
// with explicit "Missing: …" chips — above the candidate list, each
// candidate carrying "Adds / Shows as" chips, with Skip / Not a match /
// Search instead / Use selected plus ‹ › navigation.
//
// Engagement guardrails (§11): opt-in tool-state, not a score. The chip only
// appears when there is something to review, matching is silent on success
// (no toasts, no sounds — hearing-safe), and nothing here ever writes to
// pack files; a confirmed match only improves the local display cache.
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

    // ── Ambient chip + the Settings card's status line ───────────────────────
    // songs.js renders `#v3-songs-match-review` (hidden) in its toolbar and
    // calls window.__fbMatchReviewChip() after each toolbar build; review
    // actions here re-call it. The same fetch feeds the Settings status line
    // and, while a pass is running, a quiet toolbar progress line (below).
    // Silent on failure — surfaces just stay as they are.
    let _chipBusy = false;
    let _pollTimer = null;   // 5s status poll, alive ONLY while a pass runs

    // Quiet library-visible progress (launch polish): a plain text line next
    // to the review chip while the background pass is working through the
    // queue — "Matching your library — X of Y". No toast, no sound; it simply
    // disappears when the pass finishes (hearing-safe, design §11).
    function _setProgressLine(running, states, total) {
        let el = document.getElementById('v3-songs-match-progress');
        const unscanned = states.unscanned || 0;
        if (!running || unscanned <= 0 || total <= 0) {
            if (el) el.remove();
            return;
        }
        if (!el) {
            const chip = document.getElementById('v3-songs-match-review');
            if (!chip || !chip.parentElement) return;   // songs toolbar not on screen
            el = document.createElement('span');
            el.id = 'v3-songs-match-progress';
            el.className = 'text-xs text-fb-textDim';
            chip.insertAdjacentElement('afterend', el);
        }
        el.textContent = 'Matching your library — ' + Math.max(0, total - unscanned) + ' of ' + total;
    }

    // One-time transparency toast (launch polish): the first time this
    // install is observed actually matching a real library, say plainly what
    // is contacted, where results live, and where the switch is. Wrapped like
    // app.js's fbNotify calls so a blocked localStorage / absent notifier can
    // never break the chip.
    function _announceOnce(running, total) {
        try {
            if (!running || total <= 0) return;
            if (localStorage.getItem('fb_enrich_announce_v1')) return;
            localStorage.setItem('fb_enrich_announce_v1', '1');
            window.fbNotify?.show({
                title: 'Library matching is on',
                message: 'Song info and covers come from MusicBrainz and Cover Art Archive, stored locally. Your files are never changed unless you choose to write to them. Adjust in Settings → Library.',
                icon: '📚',
            });
        } catch (_) { /* storage/notifier unavailable — skip quietly */ }
    }

    async function refreshChip() {
        if (_chipBusy) return;
        _chipBusy = true;
        try {
            const r = await fetch('/api/enrichment/status');
            if (!r.ok) return;
            const body = await r.json();
            const st = body.states || {};
            const n = st.review || 0;
            const chip = document.getElementById('v3-songs-match-review');
            if (chip) {
                chip.textContent = '⚑ ' + n + ' to review';
                chip.classList.toggle('hidden', !n);
            }
            const line = document.getElementById('enrich-status');
            if (line) {
                const parts = [
                    ((st.matched || 0) + (st.manual || 0)) + ' matched',
                    n + ' to review',
                    (st.failed || 0) + ' unmatched',
                ];
                if (st.unscanned) parts.push(st.unscanned + ' queued');
                line.textContent = (body.running ? 'Matching… · ' : '') + parts.join(' · ');
            }
            const running = !!body.running;
            const total = body.total_songs || 0;
            _setProgressLine(running, st, total);
            _announceOnce(running, total);
            // Poll only while a pass is actually running; a single guarded
            // interval, cleared the moment the pass stops (no leaks).
            if (running && !_pollTimer) {
                _pollTimer = setInterval(refreshChip, 5000);
            } else if (!running && _pollTimer) {
                clearInterval(_pollTimer);
                _pollTimer = null;
            }
        } catch (_) {
            // Offline — leave surfaces as they are, but stop any poll so a
            // dead server isn't pinged every 5s forever (the next toolbar
            // build / settings open restarts it if a pass is still running).
            if (_pollTimer) { clearInterval(_pollTimer); _pollTimer = null; }
        } finally {
            _chipBusy = false;
        }
    }

    // ── Review modal (body-appended singleton, one chart at a time) ─────────
    let _queue = [];
    let _idx = 0;
    let _lastFocus = null;
    let _single = false;   // Fix-metadata mode: one song, no queue navigation
    let _tab = 'details';  // active tab in single mode: details | cover | match

    function ensureModal() {
        let m = document.getElementById('v3-match-modal');
        if (m) return m;
        const overlay = document.createElement('div');
        overlay.id = 'v3-match-overlay';
        overlay.className = 'fixed inset-0 bg-black/60 z-40 hidden';
        overlay.addEventListener('click', closeModal);
        document.body.appendChild(overlay);
        m = document.createElement('div');
        m.id = 'v3-match-modal';
        m.className = 'fixed inset-0 z-50 hidden flex items-center justify-center p-4 pointer-events-none';
        m.innerHTML = '<div id="v3-match-panel" class="pointer-events-auto w-full max-w-2xl max-h-[85vh] bg-fb-sidebar border border-fb-border/50 rounded-xl shadow-2xl flex flex-col" role="dialog" aria-label="Match review"></div>';
        m.addEventListener('keydown', onModalKeydown);
        document.body.appendChild(m);
        return m;
    }

    function isTyping(e) {
        const t = e.target;
        return t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA');
    }

    function onModalKeydown(e) {
        if (e.key === 'Escape') { e.stopPropagation(); closeModal(); return; }
        if (e.key === 'ArrowLeft' && !isTyping(e)) { e.preventDefault(); nav(-1); return; }
        if (e.key === 'ArrowRight' && !isTyping(e)) { e.preventDefault(); nav(1); return; }
        if (e.key !== 'Tab') return;
        // Light focus trap: cycle within the panel.
        const panel = document.getElementById('v3-match-panel');
        if (!panel) return;
        const foci = panel.querySelectorAll('button, input, [tabindex="0"]');
        if (!foci.length) return;
        const first = foci[0], last = foci[foci.length - 1];
        if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
        else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    }

    function openModal() {
        _lastFocus = document.activeElement;
        _single = false;
        const m = ensureModal();
        renderLoading();
        m.classList.remove('hidden');
        document.getElementById('v3-match-overlay')?.classList.remove('hidden');
        loadQueue();
    }

    // Fix metadata (R2 → popup slice 4): the tabbed per-song editor for ONE
    // song, reachable from the card's ⋮ / right-click menu. Three tabs —
    // Details (type + lock the displayed fields), Cover art (launch the picker),
    // Match (pin a MusicBrainz identity). Opens on Details: for the obscure /
    // blank-artist packs this exists to fix, typing the right title is the tool,
    // and Match is the escape hatch when text search can surface a record.
    function fixMatch(song) {
        if (!song || !song.filename) return;
        _lastFocus = document.activeElement;
        _single = true;
        _tab = 'details';
        _queue = [{
            filename: song.filename, title: song.title || song.filename,
            artist: song.artist || '', album: song.album || '',
            year: song.year || '', duration: song.duration,
            mtime: song.mtime, candidates: [],
        }];
        _idx = 0;
        const m = ensureModal();
        m.classList.remove('hidden');
        document.getElementById('v3-match-overlay')?.classList.remove('hidden');
        renderCurrent();   // _single ⇒ renderTabbed()
    }

    function closeModal() {
        document.getElementById('v3-match-modal')?.classList.add('hidden');
        document.getElementById('v3-match-overlay')?.classList.add('hidden');
        _single = false;
        refreshChip();
        if (_lastFocus && _lastFocus.isConnected) { try { _lastFocus.focus(); } catch (_) { } }
        _lastFocus = null;
    }

    function nav(step) {
        if (_single || !_queue.length) return;   // single mode has no queue to page
        _idx = Math.min(Math.max(_idx + step, 0), _queue.length - 1);
        renderCurrent();
    }

    async function loadQueue() {
        try {
            const r = await fetch('/api/enrichment/review?limit=200');
            _queue = r.ok ? ((await r.json()).songs || []) : [];
        } catch (_) { _queue = []; }
        _idx = 0;
        renderCurrent();
    }

    function headerHtml() {
        const counter = (_queue.length && !_single)
            ? '<span class="flex items-center gap-1 text-xs text-fb-textDim">' +
            '<button data-mr-prev class="px-2 py-1 rounded hover:text-fb-text' + (_idx === 0 ? ' opacity-30' : '') + '" aria-label="Previous">‹</button>' +
            (_idx + 1) + ' of ' + _queue.length +
            '<button data-mr-next class="px-2 py-1 rounded hover:text-fb-text' + (_idx >= _queue.length - 1 ? ' opacity-30' : '') + '" aria-label="Next">›</button></span>'
            : '';
        return '<div class="flex items-center justify-between gap-3 p-5 pb-3 border-b border-fb-border/40 shrink-0">' +
            '<h3 class="text-lg font-semibold text-fb-text">' + (_single ? 'Fix match' : 'Match review') + '</h3>' + counter +
            '<button data-mr-close class="text-fb-textDim hover:text-fb-text" aria-label="Close">✕</button></div>';
    }

    function renderLoading() {
        const panel = document.getElementById('v3-match-panel');
        if (!panel) return;
        panel.innerHTML = headerHtml() +
            '<div class="p-5"><p class="text-sm text-fb-textDim">Loading…</p></div>';
        panel.querySelector('[data-mr-close]')?.addEventListener('click', closeModal);
    }

    function renderDone() {
        const panel = document.getElementById('v3-match-panel');
        if (!panel) return;
        panel.innerHTML = headerHtml() +
            '<div class="p-5 space-y-2"><p class="text-sm text-fb-text">Nothing waiting for review.</p>' +
            '<p class="text-xs text-fb-textDim">Medium-confidence matches queue here while the library is matched in the background. Matching options live in Settings → Library.</p></div>';
        panel.querySelector('[data-mr-close]')?.addEventListener('click', closeModal);
    }

    // Amber "what this chart lacks" chips. Album/year come from the library
    // row; cover art is detected from the art request failing (flagged onto
    // the song object by the <img> onerror handler, then re-rendered).
    function missingChips(song) {
        const missing = [];
        if (!String(song.album || '').trim()) missing.push('album');
        if (!String(song.year || '').trim()) missing.push('year');
        if (song._artMissing) missing.push('cover art');
        if (!missing.length) return '';
        return '<div class="flex flex-wrap items-center gap-1 pt-1">' +
            '<span class="text-xs text-fb-textDim">Missing:</span>' +
            missing.map((f) => '<span class="text-xs px-1.5 py-0.5 rounded border border-amber-400/40 text-amber-300/90 bg-amber-400/10">' + esc(f) + '</span>').join('') +
            '</div>';
    }

    // Per-candidate "what accepting this gets you": fields the chart lacks
    // that the candidate supplies, and fields whose DISPLAYED value would
    // change (never the file).
    function diffChips(song, cand) {
        const adds = [];
        const changes = [];
        const have = (v) => String(v == null ? '' : v).trim();
        const differ = (a, b) => have(a) && have(b) && have(a).toLowerCase() !== have(b).toLowerCase();
        if (have(cand.album)) { if (!have(song.album)) adds.push('album'); else if (differ(song.album, cand.album)) changes.push('album'); }
        if (have(cand.year)) { if (!have(song.year)) adds.push('year'); else if (differ(song.year, cand.year)) changes.push('year'); }
        if (cand.genres && cand.genres.length) adds.push('genres');
        if (have(cand.isrc)) adds.push('ISRC');
        if (differ(song.artist, cand.artist)) changes.push(have(song.artist) + ' → ' + have(cand.artist));
        if (differ(song.title, cand.title)) changes.push('title');
        let html = '';
        if (adds.length) html += '<span class="text-xs text-fb-good">Adds: ' + esc(adds.join(' · ')) + '</span>';
        if (changes.length) html += (html ? ' ' : '') + '<span class="text-xs text-fb-textDim">Shows as: ' + esc(changes.join(' · ')) + '</span>';
        return html ? '<span class="block truncate pt-0.5">' + html + '</span>' : '';
    }

    function candRowHtml(song, c, i, selected) {
        const meta = [c.artist, c.album, c.year, fmtDur(c.duration)].filter(Boolean).join(' · ');
        const pct = c.score != null ? Math.round(c.score * 100) + '%' : '';
        return '<button data-mr-cand="' + i + '" role="radio" aria-checked="' + (selected ? 'true' : 'false') + '" class="w-full text-left px-3 py-2 rounded-md border ' +
            (selected ? 'border-fb-primary bg-fb-primary/10' : 'border-fb-border/50 bg-gray-800/50 hover:border-fb-primary/60') + '">' +
            '<span class="flex items-baseline justify-between gap-2">' +
            '<span class="text-sm text-fb-text truncate">' + esc(c.title) + '</span>' +
            '<span class="text-xs text-fb-textDim shrink-0">' + esc(pct) + '</span></span>' +
            '<span class="block text-xs text-fb-textDim truncate">' + esc(meta) + '</span>' +
            diffChips(song, c) +
            '</button>';
    }

    // The middle content shared by the queue-review render and the single-song
    // popup's Match tab: the chart being matched, its candidate list, and the
    // "search instead" panel. Header + footer differ per surface. When there
    // are no stored candidates (a manual fix), the search panel opens pre-filled
    // — searching IS the point in that case.
    function reviewBodyHtml(song) {
        const sub = [song.artist, song.album, song.year, fmtDur(song.duration)].filter(Boolean).join(' · ');
        const noCands = !(song.candidates || []).length;
        const prefill = noCands ? [song.artist, song.title].filter(Boolean).join(' – ') : '';
        return '<div class="p-5 space-y-4 overflow-y-auto v3-scroll min-h-0">' +
            // The chart being matched
            '<div class="flex items-start gap-3">' +
            '<img data-mr-art src="' + esc(artUrl(song)) + '" alt="" loading="lazy" class="w-16 h-16 rounded-lg object-cover bg-fb-card shrink-0">' +
            '<div class="min-w-0">' +
            '<div class="text-base text-fb-text font-medium truncate">' + esc(song.title) + '</div>' +
            '<div class="text-xs text-fb-textDim truncate">' + esc(sub) + '</div>' +
            '<div class="text-xs text-fb-textDim/70 truncate" title="' + esc(song.filename) + '">' + esc(song.filename) + '</div>' +
            missingChips(song) +
            '</div></div>' +
            (noCands
                ? ''
                : '<div class="space-y-1" role="radiogroup" aria-label="Candidates">' +
                '<div class="text-xs font-semibold uppercase tracking-wider text-fb-textDim">Candidates (MusicBrainz)</div>' +
                song.candidates.map((c, i) => candRowHtml(song, c, i, i === song._sel)).join('') +
                '</div>') +
            // Search panel — hidden when candidates exist (a "Search instead…"
            // toggle reveals it); open + pre-filled when there are none.
            '<div data-mr-search-panel class="' + (noCands ? '' : 'hidden') + ' space-y-2">' +
            '<div class="flex gap-2">' +
            '<input data-mr-search-input type="text" value="' + esc(prefill) + '" class="flex-1 bg-gray-800/50 border border-gray-700 rounded-md px-2 py-1 text-sm text-fb-text outline-none focus:border-fb-primary" placeholder="Artist – Title">' +
            '<button data-mr-search-go class="text-sm text-fb-primary hover:text-fb-primaryHi border border-fb-primary/40 rounded-md px-3">Search</button></div>' +
            '<div data-mr-search-results class="space-y-1"></div></div>' +
            '</div>';
    }

    // Footer actions. Single mode drops Skip / Not-a-match (no queue); the
    // accept button only shows when there is a stored candidate to accept —
    // search-result rows carry their own pick action.
    function footerHtml(song) {
        return '<div class="flex items-center justify-between gap-3 p-5 pt-3 border-t border-fb-border/40 shrink-0">' +
            '<div class="flex items-center gap-3">' +
            (_single ? '' : '<button data-mr-reject class="text-sm text-fb-textDim hover:text-fb-text">Not a match</button>') +
            '<button data-mr-search-toggle class="text-sm text-fb-textDim hover:text-fb-text">Search instead…</button>' +
            '<button data-mr-identify class="text-sm text-fb-primary hover:text-fb-primaryHi" title="Fingerprint this song\'s audio to find the exact recording">Identify by audio</button></div>' +
            '<div class="flex items-center gap-2">' +
            (_single ? '' : '<button data-mr-skip class="text-sm text-fb-textDim hover:text-fb-text px-3 py-2">Skip</button>') +
            ((song.candidates || []).length ? '<button data-mr-accept class="bg-fb-primary hover:bg-fb-primaryHi text-white px-4 py-2 rounded-md text-sm">Use selected</button>' : '') +
            '</div></div>';
    }

    function renderCurrent() {
        const panel = document.getElementById('v3-match-panel');
        if (!panel) return;
        if (_single) { renderTabbed(); return; }   // popup: the tabbed shell
        if (!_queue.length) { renderDone(); return; }
        _idx = Math.min(_idx, _queue.length - 1);
        const song = _queue[_idx];
        if (song._sel == null) song._sel = 0;
        panel.innerHTML = headerHtml() + reviewBodyHtml(song) + footerHtml(song);
        panel.querySelector('[data-mr-close]')?.addEventListener('click', closeModal);
        panel.querySelector('[data-mr-prev]')?.addEventListener('click', () => nav(-1));
        panel.querySelector('[data-mr-next]')?.addEventListener('click', () => nav(1));
        panel.querySelector('[data-mr-skip]')?.addEventListener('click', () => nav(1));
        wireReviewBody(panel, song);
    }

    // Candidate / search / accept-reject wiring shared by the queue render and
    // the popup's Match tab. Scoped to `root` so the tabbed shell can wire just
    // its tab body — its close + tab chrome live in the header (wired once by
    // renderTabbed), so wiring here must NOT touch close/prev/next/skip.
    function wireReviewBody(root, song) {
        // Art failure → flag + re-render once so the "cover art" chip shows.
        const img = root.querySelector('[data-mr-art]');
        if (img) img.onerror = () => {
            img.style.visibility = 'hidden';
            if (!song._artMissing) { song._artMissing = true; renderCurrent(); }
        };
        root.querySelectorAll('[data-mr-cand]').forEach((btn) => {
            btn.addEventListener('click', () => {
                song._sel = Number(btn.getAttribute('data-mr-cand'));
                renderCurrent();
            });
        });
        root.querySelector('[data-mr-accept]')?.addEventListener('click', async () => {
            const cand = (song.candidates || [])[song._sel || 0];
            if (!cand) return;
            await post('/api/enrichment/review/' + enc(song.filename) + '/accept',
                { recording_id: cand.recording_id });
            settle(song);
        });
        root.querySelector('[data-mr-reject]')?.addEventListener('click', async () => {
            await post('/api/enrichment/review/' + enc(song.filename) + '/reject');
            settle(song);
        });
        const sp = root.querySelector('[data-mr-search-panel]');
        const input = root.querySelector('[data-mr-search-input]');
        root.querySelector('[data-mr-search-toggle]')?.addEventListener('click', () => {
            sp?.classList.toggle('hidden');
            if (sp && !sp.classList.contains('hidden') && input && !input.value) {
                input.value = [song.artist, song.title].filter(Boolean).join(' – ');
                input.focus();
            }
        });
        const go = () => runSearch(root, song);
        root.querySelector('[data-mr-search-go]')?.addEventListener('click', go);
        input?.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); go(); } });
        // Identify-by-audio (AcoustID, #759) renders its hits into the same
        // search-results area — scope to `root` (the tab body / panel), not the
        // out-of-scope `panel` the pre-refactor #759 wiring referenced.
        root.querySelector('[data-mr-identify]')?.addEventListener('click', () => runIdentify(root, song));
    }

    // ── Tabbed single-song popup (slice 4) ───────────────────────────────────
    // Header + tab bar, then the active tab's body. The queue-review render
    // above is untouched; this is only reached in _single mode.
    function tabHeaderHtml() {
        const tab = (id, label) =>
            '<button data-mr-tab="' + id + '" role="tab" aria-selected="' + (_tab === id ? 'true' : 'false') + '" ' +
            'class="px-3 py-2 text-sm -mb-px border-b-2 ' + (_tab === id
                ? 'border-fb-primary text-fb-text'
                : 'border-transparent text-fb-textDim hover:text-fb-text') + '">' + label + '</button>';
        return '<div class="flex items-center justify-between gap-3 px-5 pt-4 shrink-0">' +
            '<h3 class="text-lg font-semibold text-fb-text">Fix metadata</h3>' +
            '<button data-mr-close class="text-fb-textDim hover:text-fb-text" aria-label="Close">✕</button></div>' +
            '<div role="tablist" class="flex gap-1 px-4 border-b border-fb-border/40 shrink-0">' +
            tab('details', 'Details') + tab('cover', 'Cover art') + tab('match', 'Match') + '</div>';
    }

    function renderTabbed() {
        const panel = document.getElementById('v3-match-panel');
        if (!panel) return;
        const song = _queue[0];
        if (!song) { closeModal(); return; }
        panel.innerHTML = tabHeaderHtml() +
            '<div data-mr-tabbody role="tabpanel" class="flex flex-col min-h-0 flex-1 overflow-hidden"></div>';
        panel.querySelector('[data-mr-close]')?.addEventListener('click', closeModal);
        panel.querySelectorAll('[data-mr-tab]').forEach((b) => b.addEventListener('click', () => {
            const t = b.getAttribute('data-mr-tab');
            if (t !== _tab) { _tab = t; renderTabbed(); }
        }));
        const body = panel.querySelector('[data-mr-tabbody]');
        if (_tab === 'details') { renderDetailsTab(body, song); }
        else if (_tab === 'cover') { renderCoverTab(body, song); }
        else {
            body.innerHTML = reviewBodyHtml(song) + footerHtml(song);
            wireReviewBody(body, song);
            if (!(song.candidates || []).length) body.querySelector('[data-mr-search-input]')?.focus();
        }
    }

    // Details tab: type + lock the DISPLAYED fields. Values ride the reversible
    // override store (GET/PUT /api/song/{fn}/overrides) — never the pack file.
    // Each field sits on its pack value: editing above the pack makes it an
    // override ("Yours"); a lock pins it so an auto-match can't recanonicalize
    // it; revert (↺) drops back to the pack value.
    const DETAIL_FIELDS = [['title', 'Title'], ['artist', 'Artist'], ['album', 'Album'], ['year', 'Year']];

    async function renderDetailsTab(body, song) {
        body.innerHTML = '<div class="p-5"><p class="text-sm text-fb-textDim">Loading…</p></div>';
        let data = { overrides: {}, pack: {} };
        try {
            const r = await fetch('/api/song/' + enc(song.filename) + '/overrides');
            if (r.ok) data = await r.json();
        } catch (_) { /* offline — fall back to the empty baseline */ }
        if (!_single || _tab !== 'details') return;   // tab/modal changed while fetching
        const pack = data.pack || {};
        const ov = data.overrides || {};
        const st = {};
        for (const [f] of DETAIL_FIELDS) {
            const o = ov[f] || {};
            st[f] = {
                pack: pack[f] || '',
                value: (o.value != null ? o.value : (pack[f] || '')),
                locked: !!o.locked,
            };
        }
        song._detailsState = st;
        paintDetails(body, song);
    }

    function paintDetails(body, song) {
        const st = song._detailsState;
        const row = ([f, label]) => {
            const s = st[f];
            const isYours = !!(String(s.value).trim() && String(s.value).trim() !== String(s.pack).trim());
            return '<div class="space-y-1">' +
                '<div class="flex items-center justify-between">' +
                '<label class="text-xs font-semibold uppercase tracking-wider text-fb-textDim">' + esc(label) + '</label>' +
                (isYours
                    ? '<span class="text-[0.625rem] px-1.5 py-0.5 rounded bg-fb-primary/15 text-fb-primary">Yours</span>'
                    : '<span class="text-[0.625rem] px-1.5 py-0.5 rounded bg-fb-card text-fb-textDim">Pack</span>') +
                '</div>' +
                '<div class="flex items-center gap-2">' +
                '<input data-df-input="' + f + '" type="text" value="' + esc(s.value) + '" ' +
                'class="flex-1 bg-gray-800/50 border border-gray-700 rounded-md px-2 py-1.5 text-sm text-fb-text outline-none focus:border-fb-primary" ' +
                'placeholder="' + esc(s.pack || label) + '">' +
                '<button data-df-lock="' + f + '" type="button" aria-pressed="' + (s.locked ? 'true' : 'false') + '" ' +
                'title="' + (s.locked ? 'Locked — auto-match won’t change this field' : 'Lock this field against auto-match') + '" ' +
                'class="px-2 py-1.5 rounded-md border ' + (s.locked ? 'border-fb-primary text-fb-primary bg-fb-primary/10' : 'border-fb-border/50 text-fb-textDim hover:text-fb-text') + '">' +
                (s.locked ? '🔒' : '🔓') + '</button>' +
                '<button data-df-revert="' + f + '" type="button" title="Revert to the pack value" ' +
                'class="px-2 py-1.5 rounded-md border border-fb-border/50 text-fb-textDim hover:text-fb-text">↺</button>' +
                '</div></div>';
        };
        body.innerHTML =
            '<div class="p-5 space-y-4 overflow-y-auto v3-scroll min-h-0">' +
            '<div class="flex items-start gap-3">' +
            '<img src="' + esc(artUrl(song)) + '" alt="" onerror="this.style.visibility=\'hidden\'" class="w-14 h-14 rounded-lg object-cover bg-fb-card shrink-0">' +
            '<p class="text-xs text-fb-textDim pt-1">Your edits show in the library right away and are never written to the song files. Use <span class="text-fb-text">Match</span> to pull info from MusicBrainz, or lock a field to keep it.</p>' +
            '</div>' +
            DETAIL_FIELDS.map(row).join('') +
            '<p data-df-status class="text-xs h-4"></p>' +
            '</div>' +
            '<div class="flex items-center justify-end gap-2 p-5 pt-3 border-t border-fb-border/40 shrink-0">' +
            '<button data-df-save class="bg-fb-primary hover:bg-fb-primaryHi text-white px-4 py-2 rounded-md text-sm">Save</button>' +
            '</div>';
        body.querySelectorAll('[data-df-input]').forEach((inp) => {
            inp.addEventListener('input', () => { st[inp.getAttribute('data-df-input')].value = inp.value; });
        });
        body.querySelectorAll('[data-df-lock]').forEach((b) => {
            b.addEventListener('click', () => { const f = b.getAttribute('data-df-lock'); st[f].locked = !st[f].locked; paintDetails(body, song); });
        });
        body.querySelectorAll('[data-df-revert]').forEach((b) => {
            b.addEventListener('click', () => { const f = b.getAttribute('data-df-revert'); st[f].value = st[f].pack || ''; st[f].locked = false; paintDetails(body, song); });
        });
        body.querySelector('[data-df-save]')?.addEventListener('click', () => saveDetails(body, song));
    }

    async function saveDetails(body, song) {
        const st = song._detailsState;
        const overrides = {};
        for (const [f] of DETAIL_FIELDS) {
            const v = String(st[f].value || '').trim();
            const p = String(st[f].pack || '').trim();
            // Only store a value that differs from the pack; equal / blank clears
            // the override (the server drops a value-less, unlocked row).
            overrides[f] = { value: (v && v !== p) ? v : null, locked: !!st[f].locked };
        }
        const status = body.querySelector('[data-df-status]');
        const saveBtn = body.querySelector('[data-df-save]');
        if (saveBtn) saveBtn.disabled = true;
        let ok = false;
        try {
            const r = await fetch('/api/song/' + enc(song.filename) + '/overrides', {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ overrides }),
            });
            ok = r.ok;
        } catch (_) { ok = false; }
        if (saveBtn) saveBtn.disabled = false;
        if (!ok) {
            if (status) { status.className = 'text-xs h-4 text-fb-accent'; status.textContent = 'Could not save — try again.'; }
            return;
        }
        // Reflect the new effective values on the in-memory song (keeps the Match
        // tab header consistent) and repaint the library so the card shows them —
        // the grid reloads on library:changed (slice 3 overlay does the rest).
        for (const [f] of DETAIL_FIELDS) {
            const v = String(st[f].value || '').trim(); const p = String(st[f].pack || '').trim();
            song[f] = (v && v !== p) ? v : (st[f].pack || '');
        }
        try { window.feedBack?.emit('library:changed', { reason: 'override' }); } catch (_) { }
        if (status) { status.className = 'text-xs h-4 text-fb-good'; status.textContent = 'Saved.'; }
    }

    // Cover-art tab: the current art + a button that hands off to the shared
    // cover picker (image-picker.js, its own z-[200] modal). A pick there
    // refreshes every <img> for this song's art — including this thumbnail — so
    // there's nothing to wire back.
    function renderCoverTab(body, song) {
        body.innerHTML =
            '<div class="p-5 space-y-4 overflow-y-auto v3-scroll min-h-0 flex flex-col items-center text-center">' +
            '<img src="' + esc(artUrl(song)) + '" alt="" onerror="this.style.visibility=\'hidden\'" class="w-40 h-40 rounded-xl object-cover bg-fb-card">' +
            '<p class="text-sm text-fb-textDim max-w-sm">Choose from the Cover Art Archive, paste an image link, or upload your own. Your song files are never changed.</p>' +
            '<button data-cover-open class="bg-fb-primary hover:bg-fb-primaryHi text-white px-4 py-2 rounded-md text-sm">Choose cover art…</button>' +
            '</div>';
        body.querySelector('[data-cover-open]')?.addEventListener('click', () => {
            if (window.__fbOpenImagePicker) {
                window.__fbOpenImagePicker({ filename: song.filename, title: song.title || song.filename });
            }
        });
    }

    // Silent-on-success: the chart just leaves the queue and the next one
    // renders; the last one renders the done state. No toasts, no sounds.
    function settle(song) {
        if (_single) {
            // Popup Match tab: a pinned identity can change the art/canon — nudge
            // the grid to repaint (silent otherwise, like the queue flow).
            try { window.feedBack?.emit('library:changed', { reason: 'match' }); } catch (_) { }
            closeModal();
            return;
        }
        const i = _queue.indexOf(song);
        if (i >= 0) _queue.splice(i, 1);
        if (_idx >= _queue.length) _idx = Math.max(0, _queue.length - 1);
        refreshChip();
        renderCurrent();
    }

    async function runSearch(panel, song) {
        const input = panel.querySelector('[data-mr-search-input]');
        const out = panel.querySelector('[data-mr-search-results]');
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
        } catch (_) { /* falls through to the no-results line */ }
        const cands = (body && body.candidates) || [];
        if (!cands.length) {
            out.innerHTML = '<p class="text-xs text-fb-textDim">No results.</p>';
            return;
        }
        out.innerHTML = cands.map((c, i) => candRowHtml(song, c, i, false)).join('');
        out.querySelectorAll('[data-mr-cand]').forEach((btn) => {
            btn.addEventListener('click', async () => {
                const cand = cands[Number(btn.getAttribute('data-mr-cand'))];
                if (!cand) return;
                await post('/api/enrichment/review/' + enc(song.filename) + '/pick',
                    { candidate: cand });
                settle(song);
            });
        });
    }

    // "Identify by audio" — fingerprint the song's OWN master audio (AcoustID)
    // and render the hits into the same search-results area. The reliable path
    // when text search can't tell the studio take from live/comp versions.
    async function runIdentify(panel, song) {
        const out = panel.querySelector('[data-mr-search-results]');
        const sp = panel.querySelector('[data-mr-search-panel]');
        if (!out) return;
        sp?.classList.remove('hidden');   // give the results somewhere to render
        out.innerHTML = '<p class="text-xs text-fb-textDim">Fingerprinting audio…</p>';
        let body = null, status = 0;
        try {
            const r = await fetch('/api/enrichment/identify/' + enc(song.filename), { method: 'POST' });
            status = r.status;
            body = await r.json().catch(() => null);
        } catch (_) { /* falls through to the no-results line */ }
        // Honest states — never a fake hit. Each says plainly WHICH outcome this
        // is, so an empty result reads as "it ran, found nothing" (not "broken")
        // and points at the manual fallback when there's nothing to pick.
        const note = (html) => { out.innerHTML = '<p class="text-xs text-fb-textDim leading-relaxed">' + html + '</p>'; };
        const manual = _single
            ? ' Try <b class="text-fb-text">Search</b>, or just set the album in <b class="text-fb-text">Details</b> and the cover in <b class="text-fb-text">Cover art</b> by hand.'
            : ' Try <b class="text-fb-text">Search instead</b>.';
        if (status === 412 || (body && body.needs_setup)) {
            note('Audio identification is <b class="text-fb-text">off</b>. Turn it on and add a free AcoustID API key in Settings → Library to use it.');
            return;
        }
        if (status === 404) {
            note('This pack has <b class="text-fb-text">no full mix to fingerprint</b> (it\'s chart-only or stems-only).' + manual);
            return;
        }
        if (status === 503) {
            note('Could not run the fingerprint right now — the audio tool or network is unavailable. Try again in a moment.');
            return;
        }
        const cands = (body && body.candidates) || [];
        if (!cands.length) {
            note('<span class="text-fb-good">✓ Fingerprinted the audio</span> — but AcoustID has <b class="text-fb-text">no match</b> for this exact recording (common for obscure or import tracks).' + manual);
            return;
        }
        out.innerHTML = '<div class="text-xs font-semibold uppercase tracking-wider text-fb-good mb-1">✓ Fingerprint matches (AcoustID)</div>' +
            cands.map((c, i) => candRowHtml(song, c, i, false)).join('');
        out.querySelectorAll('[data-mr-cand]').forEach((btn) => {
            btn.addEventListener('click', async () => {
                const cand = cands[Number(btn.getAttribute('data-mr-cand'))];
                if (!cand) return;
                await post('/api/enrichment/review/' + enc(song.filename) + '/pick',
                    { candidate: cand });
                settle(song);
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

    // ── Settings → Library → "Metadata matching" card ────────────────────────
    // Markup lives statically in index.html (the v3 settings pattern); this
    // wires it. All null-guarded so v2 (which lacks the elements) no-ops.
    function wireSettingsCard() {
        const sel = document.getElementById('enrich-threshold');
        const order = document.getElementById('enrich-review-order');
        const btn = document.getElementById('enrich-match-now');
        // Boolean toggles, element id → settings key. enrich-enabled is the
        // master background switch; the rest are the R1 scraper options
        // (per-source + per-field auto-apply).
        const toggles = [
            ['enrich-enabled', 'enrich_enabled'],
            ['enrich-src-musicbrainz', 'enrich_src_musicbrainz'],
            ['enrich-src-caa', 'enrich_src_caa'],
            ['enrich-apply-names', 'enrich_apply_names'],
            ['enrich-apply-year', 'enrich_apply_year'],
            ['enrich-apply-genres', 'enrich_apply_genres'],
            ['enrich-apply-art', 'enrich_apply_art'],
            // Artist pages (PR-B): the page itself — local-only, default ON.
            ['artist-pages-enabled', 'artist_pages_enabled'],
        ].map(([id, key]) => [document.getElementById(id), key]).filter(([el]) => el);
        // Default-OFF toggles load with the opposite absent-key semantic
        // (checked only when explicitly true): the external-links row is
        // opt-IN per the dev-chat thread.
        const optInToggles = [
            ['artist-external-links', 'artist_external_links'],
            // Audio fingerprinting is opt-in (needs a key + fpcalc), default OFF.
            ['acoustid-enabled', 'acoustid_enabled'],
        ].map(([id, key]) => [document.getElementById(id), key]).filter(([el]) => el);
        const acoustidKeyEl = document.getElementById('acoustid-api-key');
        if (!toggles.length && !optInToggles.length && !sel && !btn) return;
        (async () => {
            try {
                const r = await fetch('/api/settings');
                if (r.ok) {
                    const cfg = await r.json();
                    for (const [el, key] of toggles) el.checked = cfg[key] !== false;
                    for (const [el, key] of optInToggles) el.checked = cfg[key] === true;
                    if (acoustidKeyEl) acoustidKeyEl.value = cfg.acoustid_api_key || '';
                    if (sel) {
                        const t = Number(cfg.enrich_auto_threshold);
                        const want = Number.isFinite(t) ? t : 0.9;
                        // Snap to the nearest offered option.
                        let best = sel.options[0];
                        for (const o of sel.options) {
                            if (Math.abs(Number(o.value) - want) < Math.abs(Number(best.value) - want)) best = o;
                        }
                        if (best) sel.value = best.value;
                    }
                    if (order) {
                        const v = String(cfg.enrich_review_order || 'missing_first');
                        order.value = ['missing_first', 'artist', 'recent'].includes(v) ? v : 'missing_first';
                    }
                }
            } catch (_) { /* leave markup defaults */ }
            refreshChip();   // also fills #enrich-status
        })();
        const save = (key, value) => post('/api/settings', { [key]: value });
        for (const [el, key] of toggles.concat(optInToggles)) {
            el.addEventListener('change', () => save(key, !!el.checked));
        }
        sel?.addEventListener('change', () => save('enrich_auto_threshold', Number(sel.value)));
        order?.addEventListener('change', () => save('enrich_review_order', order.value));
        acoustidKeyEl?.addEventListener('change', () => save('acoustid_api_key', acoustidKeyEl.value.trim()));
        btn?.addEventListener('click', async () => {
            await post('/api/enrichment/kick');
            const line = document.getElementById('enrich-status');
            if (line) line.textContent = 'Matching…';
            setTimeout(refreshChip, 1500);
        });
    }

    // Stop the 5s poll when the library screen is left — the progress line and
    // chip only live in the songs toolbar, so polling off-screen is pure waste
    // (benign but tidy). Re-entering v3-songs re-arms it: songs.js re-calls
    // window.__fbMatchReviewChip() on screen enter, and we also refresh here so
    // this stays self-contained. Same single-guarded-interval invariant as
    // refreshChip — no double-interval, cleared to null.
    function wireScreenTeardown() {
        const sm = window.feedBack;
        if (!sm || typeof sm.on !== 'function') return;
        sm.on('screen:changed', (e) => {
            const id = e && e.detail && e.detail.id;
            if (id === 'v3-songs') {
                refreshChip();   // returning while a pass runs re-arms the poll
            } else if (_pollTimer) {
                clearInterval(_pollTimer);
                _pollTimer = null;
            }
        });
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', () => {
            wireSettingsCard();
            wireScreenTeardown();
        }, { once: true });
    } else {
        wireSettingsCard();
        wireScreenTeardown();
    }

    window.__fbMatchReviewChip = refreshChip;
    window.__fbOpenMatchReview = openModal;
    window.__fbFixMatch = fixMatch;
})();
