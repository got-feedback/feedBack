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
    let _single = false;   // Fix-match mode: one song, no queue navigation

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

    // Fix-match (R2): the same modal for ONE song — the escape hatch for a
    // wrong (or missing) match, reachable from the card's ⋮ / right-click
    // menu. No stored candidates are required: the search panel opens
    // pre-filled, and a pick pins the match exactly like the review flow.
    function fixMatch(song) {
        if (!song || !song.filename) return;
        _lastFocus = document.activeElement;
        _single = true;
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
        renderCurrent();
        // Straight to the point: the search panel is why this mode exists.
        document.getElementById('v3-match-panel')
            ?.querySelector('[data-mr-search-toggle]')?.click();
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
        if (!_queue.length) return;
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

    function renderCurrent() {
        const panel = document.getElementById('v3-match-panel');
        if (!panel) return;
        if (!_queue.length) { renderDone(); return; }
        _idx = Math.min(_idx, _queue.length - 1);
        const song = _queue[_idx];
        if (song._sel == null) song._sel = 0;
        const sub = [song.artist, song.album, song.year, fmtDur(song.duration)].filter(Boolean).join(' · ');

        panel.innerHTML = headerHtml() +
            '<div class="p-5 space-y-4 overflow-y-auto v3-scroll">' +
            // The chart being matched
            '<div class="flex items-start gap-3">' +
            '<img data-mr-art src="' + esc(artUrl(song)) + '" alt="" loading="lazy" class="w-16 h-16 rounded-lg object-cover bg-fb-card shrink-0">' +
            '<div class="min-w-0">' +
            '<div class="text-base text-fb-text font-medium truncate">' + esc(song.title) + '</div>' +
            '<div class="text-xs text-fb-textDim truncate">' + esc(sub) + '</div>' +
            '<div class="text-xs text-fb-textDim/70 truncate" title="' + esc(song.filename) + '">' + esc(song.filename) + '</div>' +
            missingChips(song) +
            '</div></div>' +
            // Candidates (Fix-match mode arrives with none — the search panel
            // is its whole point, so the empty header is suppressed).
            ((song.candidates || []).length
                ? '<div class="space-y-1" role="radiogroup" aria-label="Candidates">' +
                '<div class="text-xs font-semibold uppercase tracking-wider text-fb-textDim">Candidates (MusicBrainz)</div>' +
                song.candidates.map((c, i) => candRowHtml(song, c, i, i === song._sel)).join('') +
                '</div>'
                : '') +
            // Search-instead panel
            '<div data-mr-search-panel class="hidden space-y-2">' +
            '<div class="flex gap-2">' +
            '<input data-mr-search-input type="text" class="flex-1 bg-gray-800/50 border border-gray-700 rounded-md px-2 py-1 text-sm text-fb-text outline-none focus:border-fb-primary" placeholder="Artist – Title">' +
            '<button data-mr-search-go class="text-sm text-fb-primary hover:text-fb-primaryHi border border-fb-primary/40 rounded-md px-3">Search</button></div>' +
            '<div data-mr-search-results class="space-y-1"></div></div>' +
            '</div>' +
            // Footer actions. Fix-match mode drops Skip (no queue) and the
            // accept button when there is nothing to accept — search-result
            // rows carry their own pick action.
            '<div class="flex items-center justify-between gap-3 p-5 pt-3 border-t border-fb-border/40 shrink-0">' +
            '<div class="flex items-center gap-3">' +
            (_single ? '' : '<button data-mr-reject class="text-sm text-fb-textDim hover:text-fb-text">Not a match</button>') +
            '<button data-mr-search-toggle class="text-sm text-fb-textDim hover:text-fb-text">Search instead…</button>' +
            '<button data-mr-identify class="text-sm text-fb-primary hover:text-fb-primaryHi" title="Fingerprint this song\'s audio to find the exact recording">Identify by audio</button></div>' +
            '<div class="flex items-center gap-2">' +
            (_single ? '' : '<button data-mr-skip class="text-sm text-fb-textDim hover:text-fb-text px-3 py-2">Skip</button>') +
            ((song.candidates || []).length ? '<button data-mr-accept class="bg-fb-primary hover:bg-fb-primaryHi text-white px-4 py-2 rounded-md text-sm">Use selected</button>' : '') +
            '</div></div>';

        wireCurrent(panel, song);
    }

    function wireCurrent(panel, song) {
        panel.querySelector('[data-mr-close]')?.addEventListener('click', closeModal);
        panel.querySelector('[data-mr-prev]')?.addEventListener('click', () => nav(-1));
        panel.querySelector('[data-mr-next]')?.addEventListener('click', () => nav(1));
        panel.querySelector('[data-mr-skip]')?.addEventListener('click', () => nav(1));
        // Art failure → flag + re-render once so the "cover art" chip shows.
        const img = panel.querySelector('[data-mr-art]');
        if (img) img.onerror = () => {
            img.style.visibility = 'hidden';
            if (!song._artMissing) { song._artMissing = true; renderCurrent(); }
        };
        panel.querySelectorAll('[data-mr-cand]').forEach((btn) => {
            btn.addEventListener('click', () => {
                song._sel = Number(btn.getAttribute('data-mr-cand'));
                renderCurrent();
            });
        });
        panel.querySelector('[data-mr-accept]')?.addEventListener('click', async () => {
            const cand = (song.candidates || [])[song._sel || 0];
            if (!cand) return;
            await post('/api/enrichment/review/' + enc(song.filename) + '/accept',
                { recording_id: cand.recording_id });
            settle(song);
        });
        panel.querySelector('[data-mr-reject]')?.addEventListener('click', async () => {
            await post('/api/enrichment/review/' + enc(song.filename) + '/reject');
            settle(song);
        });
        const sp = panel.querySelector('[data-mr-search-panel]');
        const input = panel.querySelector('[data-mr-search-input]');
        panel.querySelector('[data-mr-search-toggle]')?.addEventListener('click', () => {
            sp?.classList.toggle('hidden');
            if (sp && !sp.classList.contains('hidden') && input && !input.value) {
                input.value = [song.artist, song.title].filter(Boolean).join(' – ');
                input.focus();
            }
        });
        const go = () => runSearch(panel, song);
        panel.querySelector('[data-mr-search-go]')?.addEventListener('click', go);
        input?.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); go(); } });
        panel.querySelector('[data-mr-identify]')?.addEventListener('click', () => runIdentify(panel, song));
    }

    // Silent-on-success: the chart just leaves the queue and the next one
    // renders; the last one renders the done state. No toasts, no sounds.
    function settle(song) {
        if (_single) { closeModal(); return; }   // Fix-match: done means done
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
        // Honest states — never a fake hit.
        if (status === 412 || (body && body.needs_setup)) {
            out.innerHTML = '<p class="text-xs text-fb-textDim">Audio identification is off — enable AcoustID and add a free API key to use it.</p>';
            return;
        }
        if (status === 404) {
            out.innerHTML = "<p class=\"text-xs text-fb-textDim\">No full-mix audio to fingerprint for this song.</p>";
            return;
        }
        if (status === 503) {
            out.innerHTML = '<p class="text-xs text-fb-textDim">Audio identification is unavailable right now — try again.</p>';
            return;
        }
        const cands = (body && body.candidates) || [];
        if (!cands.length) {
            out.innerHTML = '<p class="text-xs text-fb-textDim">No fingerprint match — try text search.</p>';
            return;
        }
        out.innerHTML = '<div class="text-xs font-semibold uppercase tracking-wider text-fb-textDim mb-1">Fingerprint matches (AcoustID)</div>' +
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
        ].map(([id, key]) => [document.getElementById(id), key]).filter(([el]) => el);
        if (!toggles.length && !optInToggles.length && !sel && !btn) return;
        (async () => {
            try {
                const r = await fetch('/api/settings');
                if (r.ok) {
                    const cfg = await r.json();
                    for (const [el, key] of toggles) el.checked = cfg[key] !== false;
                    for (const [el, key] of optInToggles) el.checked = cfg[key] === true;
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
