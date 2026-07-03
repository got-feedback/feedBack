/*
 * fee[dB]ack v0.3.0 — Songs / Library (#v3-songs), native rebuild.
 *
 * A vanilla-JS library browser over the existing /api/library* endpoints:
 * provider selector (via the `library` capability, not DOM scraping), grid +
 * tree views, sort, format filter, a tri-state filter drawer (arrangements /
 * stems / lyrics / tunings), search (driven by the topbar), infinite scroll,
 * fb song cards with accuracy badges (song_stats), favorite + save-for-later,
 * and upload. Reuses window.playSong for playback (design/05: library is an
 * active capability domain; everything else stays on the documented globals).
 */
(function () {
    'use strict';
    const sm = window.feedBack;
    const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => (
        { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    const enc = encodeURIComponent;
    // Inverse of `enc` for matching a played song's filename back to a library
    // card. The `stats:recorded` event (like `song:loading`) carries the
    // filename exactly as it was handed to `playSong` — i.e. encodeURIComponent'd
    // (see `playCard`, and the highway WS which decodeURIComponent's it). But
    // cards key on the DECODED library filename (`cardKey` → `localFilename`),
    // and `/api/stats/best` is server-canonicalized to that same decoded key, so
    // an encoded filename matches no card and the post-play badge repaint silently
    // no-ops. Decode to land in the card/`state.accuracy` key space. Idempotent
    // for already-decoded names (no '%'); on malformed input falls back to the
    // original so a real filename containing a literal '%' is never corrupted.
    function decFn(fn) {
        if (typeof fn !== 'string' || fn.indexOf('%') === -1) return fn || '';
        try { return decodeURIComponent(fn); } catch (_) { return fn; }
    }

    const SORTS = [
        ['artist', 'Artist A–Z'], ['artist-desc', 'Artist Z–A'],
        ['title', 'Title A–Z'], ['title-desc', 'Title Z–A'],
        ['recent', 'Recently Added'], ['year-desc', 'Year (newest)'],
        ['year', 'Year (oldest)'], ['tuning', 'Tuning'],
        // Mastery = best accuracy across arrangements (song_stats); unscored songs
        // sort last either way. Ascending surfaces what needs work; never default.
        ['mastery', 'Needs practice first'], ['mastery-desc', 'Most mastered first'],
    ];
    const FORMATS = [['', 'All formats'], ['sloppak', 'Feedpak'], ['loose', 'Folder']];
    const ARRANGEMENTS = ['Lead', 'Rhythm', 'Bass', 'Combo', 'Vocals'];
    const STEMS = ['guitar', 'bass', 'drums', 'vocals', 'other'];
    const PAGE_SIZE = 24;
    // Extra rows rendered above/below the viewport so a fast scroll doesn't flash
    // blank before the next window render lands.
    const OVERSCAN_ROWS = 2;
    const SCROLL_STATE_KEY = 'v3:songs-scroll-state';
    // Persisted "how I'm looking" prefs (sort / format / view / drawer filters).
    // The tester ask: "most users pick one sort and leave it" + remember filters.
    // The search query and the artist/album drill-down are navigational, so they
    // are deliberately NOT persisted; cold start stays the neutral Artist A–Z.
    const PREFS_KEY = 'v3:songs-prefs';
    const btnCtrl = 'bg-gray-800/50 border border-gray-700 rounded-md px-3 py-2 text-sm text-fb-text outline-none focus:border-fb-primary';

    const state = {
        provider: 'local', view: 'grid', sort: 'artist', format: '', q: '',
        artist: '', album: '',
        grouping: true,     // one card per song (multi-chart grouping); persisted

        filters: { arr_has: [], arr_lacks: [], stem_has: [], stem_lacks: [], lyrics: '', tunings: [], mastery: [], match: [], genre: [] },
        page: 0, total: 0, loading: false, built: false, accuracy: {}, tuningNames: [], genres: [],
        artistCatalog: [], renderedHash: '',
        scrollBound: false,
        songsById: {}, selectMode: false, selected: new Set(),
        railLetters: null, railLettersAreSongCounts: false, railJumping: false,
        // ── Windowed (virtualized) grid, stage 2 of #636 item 3 ──
        // state.songs is a SPARSE array indexed by absolute library position
        // (0..total-1); only the fetched pages are populated and only the visible
        // window ± overscan is ever in the DOM. The sizer element gives the
        // scrollbar the full-library geometry. See renderWindow / ensureWindow.
        songs: [],            // sparse: absoluteIndex → song row
        pageCursors: {},      // pageIndex → next_cursor (keyset forward fast-path)
        keysetOk: false,      // did page 0 return a non-null cursor (local + keyset sort)?
        pageProms: {},        // pageIndex → in-flight fetch promise (de-dupe + await)
        epoch: 0,             // bumped on every reset; a stale in-flight fetch checks it
        geom: null,           // { cols, rowH, gap } measured from the live grid
        winRange: null,       // { start, end } last rendered, to skip redundant renders
        renderedSelectMode: null, // the selectMode the current window was rendered under
        gridResizeBound: false,
    };

    // ── A–Z jump rail ───────────────────────────────────────────────────────
    // Ordered buckets shown on the rail: '#' (non-alphabetic) first, then A–Z.
    const RAIL_BUCKETS = ['#'].concat('ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split(''));
    // The rail only makes sense for the alphabetical sorts; for recent/year/
    // tuning a letter jump is meaningless, so it's hidden. Returns the column
    // the active sort keys on ('artist' | 'title') or null when not alphabetical.
    function railSortColumn() {
        if (state.sort === 'artist' || state.sort === 'artist-desc') return 'artist';
        if (state.sort === 'title' || state.sort === 'title-desc') return 'title';
        return null;
    }
    // The bucket a song falls in for the active sort: first char of the sort
    // column, uppercased; anything non-A–Z (digits, symbols, accents, blank)
    // buckets under '#'. Mirrors the server's letter grouping in query_stats —
    // which keys on raw SUBSTR(col, 1, 1) with no trim, and the grid ORDER BY
    // is likewise raw, so we must NOT trim here either: a leading-space title
    // sorts (and buckets) under '#' on both sides, keeping the rail consistent.
    function songBucket(song) {
        const col = railSortColumn();
        if (!col) return '';
        const raw = String((col === 'title' ? song.title : song.artist) || '');
        const ch = raw.charAt(0).toUpperCase();
        return (ch >= 'A' && ch <= 'Z') ? ch : '#';
    }

    function activeFilterCount() {
        const f = state.filters;
        return f.arr_has.length + f.arr_lacks.length + f.stem_has.length + f.stem_lacks.length +
            (f.lyrics ? 1 : 0) + f.tunings.length + (f.mastery ? f.mastery.length : 0) +
            (f.match ? f.match.length : 0) + (f.genre ? f.genre.length : 0) +
            (state.artist ? 1 : 0) + (state.album ? 1 : 0);
    }

    function _getV3MainScroller() { return document.getElementById('v3-main'); }

    function buildLibraryStateHash(st) {
        const f = (st && st.filters) || {};
        return JSON.stringify({
            view: st.view || 'grid',
            q: st.q || '',
            sort: st.sort || 'artist',
            provider: st.provider || 'local',
            format: st.format || '',
            artist: st.artist || '',
            album: st.album || '',
            filters: {
                arr_has: [...(f.arr_has || [])].sort(),
                arr_lacks: [...(f.arr_lacks || [])].sort(),
                stem_has: [...(f.stem_has || [])].sort(),
                stem_lacks: [...(f.stem_lacks || [])].sort(),
                lyrics: f.lyrics || '',
                tunings: [...(f.tunings || [])].sort(),
                mastery: [...(f.mastery || [])].sort(),
                match: [...(f.match || [])].sort(),
                genre: [...(f.genre || [])].sort(),
            },
        });
    }

    function _libraryStateHash() { return buildLibraryStateHash(state); }

    // Restore the persisted view prefs once per page load, before the first
    // toolbar build so the selects render with the saved values. Every value is
    // validated against its known option list, so a stale/removed setting can
    // never wedge the UI — it just falls back to the default.
    let _prefsRestored = false;
    function applySavedPrefs() {
        let saved;
        try { saved = JSON.parse(localStorage.getItem(PREFS_KEY)); } catch (_) { return; }
        if (!saved || typeof saved !== 'object') return;
        if (SORTS.some(([v]) => v === saved.sort)) state.sort = saved.sort;
        if (FORMATS.some(([v]) => v === saved.format)) state.format = saved.format;
        if (saved.view === 'grid' || saved.view === 'tree' || saved.view === 'folder' || saved.view === 'albums') state.view = saved.view;
        if (typeof saved.grouping === 'boolean') state.grouping = saved.grouping;
        const f = saved.filters;
        if (f && typeof f === 'object') {
            const arr = (x) => (Array.isArray(x) ? x.slice() : []);
            // mastery + match are session-only facets (deliberately not
            // persisted), but the restored object must still CARRY the keys —
            // the filter drawer indexes f.mastery/f.match unconditionally, so
            // dropping them here breaks the drawer for anyone with saved prefs.
            state.filters = {
                arr_has: arr(f.arr_has), arr_lacks: arr(f.arr_lacks),
                stem_has: arr(f.stem_has), stem_lacks: arr(f.stem_lacks),
                lyrics: f.lyrics || '', tunings: arr(f.tunings),
                mastery: [], match: [],
            };
        }
    }
    // Persist the current view prefs (best-effort; storage may be full/disabled).
    // Called from reload(), which every sort/format/filter/view change funnels
    // through — so this is the single write point.
    function saveLibraryPrefs() {
        try {
            const f = state.filters;
            localStorage.setItem(PREFS_KEY, JSON.stringify({
                sort: state.sort, format: state.format, view: state.view,
                grouping: state.grouping !== false,
                filters: {
                    arr_has: [...f.arr_has], arr_lacks: [...f.arr_lacks],
                    stem_has: [...f.stem_has], stem_lacks: [...f.stem_lacks],
                    lyrics: f.lyrics || '', tunings: [...f.tunings],
                },
            }));
        } catch (_) { /* best-effort */ }
    }

    function _saveLibraryScrollSnapshot() {
        const main = _getV3MainScroller();
        // Geometry is now stable (the sizer reserves the full scroll height
        // regardless of how many cards are actually in the DOM), so the scroll
        // position alone is enough to restore — no page-depth bookkeeping.
        const snap = {
            hash: _libraryStateHash(),
            scrollTop: main ? main.scrollTop : 0,
            view: state.view,
        };
        try { sessionStorage.setItem(SCROLL_STATE_KEY, JSON.stringify(snap)); } catch (e) { /* quota / private mode */ }
    }

    function _readLibraryScrollSnapshot() {
        try {
            const raw = sessionStorage.getItem(SCROLL_STATE_KEY);
            if (!raw) return null;
            const snap = JSON.parse(raw);
            return (snap && typeof snap === 'object') ? snap : null;
        } catch (e) { return null; }
    }

    function _clearLibraryScrollSnapshot() {
        try { sessionStorage.removeItem(SCROLL_STATE_KEY); } catch (e) { /* */ }
    }

    function _applyMainScrollTop(scrollTop) {
        const main = _getV3MainScroller();
        if (!main) return;
        const top = Math.max(0, Number(scrollTop) || 0);
        const apply = () => { main.scrollTop = top; };
        apply();
        requestAnimationFrame(apply);
        setTimeout(apply, 0);
    }

    // The windowed grid keeps only a slice of cards in the DOM, so "intact" can no
    // longer mean "has cards" — it means the grid + sizer chrome exist and page 0
    // is loaded (state.total known, first rows present), so renderWindow() can
    // repaint the right slice at any scroll position.
    function _gridDomIntact() {
        const grid = document.getElementById('v3-songs-grid');
        const sizer = document.getElementById('v3-songs-gridsizer');
        return !!grid && !!sizer && state.total > 0 && state.songs[0] !== undefined;
    }

    function _treeDomIntact() {
        const tree = document.getElementById('v3-songs-tree');
        if (!tree) return false;
        return !!(tree.querySelector('[data-fn]') || tree.querySelector('details'));
    }

    // ── Multi-chart grouping (P5c, design §7.1) ─────────────────────────────
    // The grid queries with group=1 so charts of the same work collapse to ONE
    // card — the representative (preferred/auto-pick) chart — with rows carrying
    // chart_count + work_key from the materialized work_display read-model
    // (P5a/P5b). group must ride BOTH the page fetch and the rail's stats fetch
    // so page, total and sort_letters all count works identically — a
    // works-vs-charts mismatch would break the rail's cumulative-seek math and
    // the sizer geometry. Grouping is default-ON per the design, with a
    // persisted toggle in the filter drawer (P5e) — OFF falls back to today's
    // one-card-per-chart. Only the local provider implements group=; smart
    // collections and remote providers ignore it and stay flat (their rows
    // then carry no chart_count, so no ⚑ chips render).
    function groupingActive() { return state.grouping !== false; }

    function queryParams(extra, opts) {
        const f = state.filters;
        const skipArtistAlbum = opts && opts.catalog;
        const p = new URLSearchParams();
        p.set('provider', state.provider);
        p.set('sort', state.sort);
        if (state.format) p.set('format', state.format);
        if (state.q) p.set('q', state.q);
        if (!skipArtistAlbum && state.artist) p.set('artist', state.artist);
        if (!skipArtistAlbum && state.album) p.set('album', state.album);
        if (f.arr_has.length) p.set('arrangements_has', f.arr_has.join(','));
        if (f.arr_lacks.length) p.set('arrangements_lacks', f.arr_lacks.join(','));
        if (f.stem_has.length) p.set('stems_has', f.stem_has.join(','));
        if (f.stem_lacks.length) p.set('stems_lacks', f.stem_lacks.join(','));
        if (f.lyrics) p.set('has_lyrics', f.lyrics);
        if (f.tunings.length) p.set('tunings', f.tunings.join(','));
        if (f.mastery && f.mastery.length) p.set('mastery', f.mastery.join(','));
        if (f.match && f.match.length) p.set('match', f.match.join(','));
        if (f.genre && f.genre.length) p.set('genre', f.genre.join(','));
        Object.entries(extra || {}).forEach(([k, v]) => p.set(k, v));
        return p;
    }

    // The active filter set as a smart-collection rule object (raw query-param
    // format the backend stores). Mirrors queryParams' filter fields, minus
    // provider/page/size. Empty object → nothing worth saving as a collection.
    function currentFilterRules() {
        const f = state.filters, r = {};
        if (state.q) r.q = state.q;
        if (state.format) r.format = state.format;
        if (state.artist) r.artist = state.artist;
        if (state.album) r.album = state.album;
        if (f.arr_has.length) r.arrangements_has = f.arr_has.join(',');
        if (f.arr_lacks.length) r.arrangements_lacks = f.arr_lacks.join(',');
        if (f.stem_has.length) r.stems_has = f.stem_has.join(',');
        if (f.stem_lacks.length) r.stems_lacks = f.stem_lacks.join(',');
        if (f.lyrics) r.has_lyrics = f.lyrics;
        if (f.tunings.length) r.tunings = f.tunings.join(',');
        if (state.sort && state.sort !== 'artist') r.sort = state.sort;
        return r;
    }

    // Save the current filter set as a smart collection (a saved live query that
    // shows up as a source in the picker). #636 item 2.
    async function saveCurrentAsCollection() {
        const rules = currentFilterRules();
        if (!Object.keys(rules).length) return;
        const name = ((await window.uiPrompt({
            title: 'Save as collection',
            label: 'A live view of the current filters, in the source picker.',
            okLabel: 'Save',
            placeholder: 'Collection name',
        })) || '').trim();
        if (!name) return;
        try {
            const res = await fetch('/api/collections', {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ name, rules }),
            });
            if (!res.ok) return;
            const col = (await res.json()).collection;
            closeDrawer();
            if (col && col.id != null) state.provider = 'collection:' + col.id;
            await render();   // rebuilds the toolbar (provider picker now lists + selects it)
        } catch (e) { /* offline / aborted — leave the drawer as-is */ }
    }

    function albumsForArtist(name) {
        const a = (state.artistCatalog || []).find((x) => x.name === name);
        return a ? (a.albums || []) : [];
    }

    function _chromeIntact() {
        return !!(document.getElementById('v3-songs-filters') &&
            document.getElementById('v3-songs-artist') &&
            document.getElementById('v3-songs-grid'));
    }

    function artistSelectHtml() {
        const opts = ['<option value="">All artists</option>']
            .concat((state.artistCatalog || []).map((a) =>
                '<option value="' + esc(a.name) + '"' + (a.name === state.artist ? ' selected' : '') + '>' + esc(a.name) + '</option>'));
        return opts.join('');
    }

    function albumSelectHtml() {
        if (!state.artist) {
            return '<option value="">Choose artist first</option>';
        }
        const albums = albumsForArtist(state.artist);
        const opts = ['<option value="">All albums</option>']
            .concat(albums.map((n) =>
                '<option value="' + esc(n) + '"' + (n === state.album ? ' selected' : '') + '>' + esc(n) + '</option>'));
        return opts.join('');
    }

    function refreshArtistAlbumSelects() {
        const artistEl = document.getElementById('v3-songs-artist');
        const albumEl = document.getElementById('v3-songs-album');
        if (artistEl) artistEl.innerHTML = artistSelectHtml();
        if (albumEl) {
            albumEl.innerHTML = albumSelectHtml();
            albumEl.disabled = !state.artist;
        }
    }

    function syncChromeFromState() {
        const map = {
            'v3-songs-provider': state.provider,
            'v3-songs-sort': state.sort,
            'v3-songs-format': state.format,
        };
        Object.entries(map).forEach(([id, val]) => {
            const el = document.getElementById(id);
            if (el && el.value !== val) el.value = val;
        });
        refreshArtistAlbumSelects();
        const gridBtn = document.getElementById('v3-songs-grid-btn');
        const treeBtn = document.getElementById('v3-songs-tree-btn');
        if (gridBtn) gridBtn.className = 'px-3 py-2 text-sm ' + (state.view === 'grid' ? 'bg-fb-primary text-white' : 'text-fb-textDim');
        if (treeBtn) treeBtn.className = 'px-3 py-2 text-sm ' + (state.view === 'tree' ? 'bg-fb-primary text-white' : 'text-fb-textDim');
        const folderBtn = document.getElementById('v3-songs-folder-btn');
        if (folderBtn) folderBtn.className = 'px-3 py-2 text-sm ' + (state.view === 'folder' ? 'bg-fb-primary text-white' : 'text-fb-textDim');
        // Select button tracks state.selectMode — the screen-leave teardown clears
        // select mode, so a cached-DOM re-entry must re-style the button (and the
        // window re-renders without checkboxes via renderWindow's selectMode check).
        const selBtn = document.getElementById('v3-songs-select');
        if (selBtn) selBtn.className = btnCtrl + (state.selectMode ? ' bg-fb-primary text-white' : '');
        updateFilterBadge();
    }

    async function loadArtistCatalog() {
        const artists = [];
        let page = 0, total = Infinity;
        while (artists.length < total) {
            const data = await jget('/api/library/artists?' + queryParams({ size: 100, page }, { catalog: true }).toString());
            if (!data || !Array.isArray(data.artists)) break;
            artists.push(...data.artists);
            total = (data.total_artists != null) ? data.total_artists : artists.length;
            if (!data.artists.length || page > 1000) break;
            page++;
        }
        state.artistCatalog = artists.map((a) => ({
            name: a.name,
            albums: (a.albums || []).map((al) => al.name),
        }));
        if (state.artist && !state.artistCatalog.some((a) => a.name === state.artist)) {
            state.artist = '';
            state.album = '';
        } else if (state.album && !albumsForArtist(state.artist).includes(state.album)) {
            state.album = '';
        }
        return state.artistCatalog;
    }

    function resetScrollToTop() {
        _clearLibraryScrollSnapshot();
        _applyMainScrollTop(0);
    }

    function setArtist(value) {
        state.artist = value || '';
        if (state.album && !albumsForArtist(state.artist).includes(state.album)) state.album = '';
        resetScrollToTop();
        refreshArtistAlbumSelects();
        reload();
    }

    function setAlbum(value) {
        if (!state.artist) { state.album = ''; return; }
        state.album = value || '';
        resetScrollToTop();
        reload();
    }

    async function jget(url) { try { const r = await fetch(url); return r.ok ? r.json() : null; } catch (e) { return null; } }

    // ── Provider-aware song helpers ────────────────────────────────────────
    // Remote library providers (feedBack-plugin-remote-library-*) expose songs
    // by provider-owned id with their own art/sync/play flow. Reuse the legacy
    // app.js globals (the shared engine) so v3 behaves identically for remote
    // providers instead of assuming every row is a local file. All degrade to
    // the local path when the helpers/providers aren't present.
    function songId(s) {
        return (window._librarySongId ? window._librarySongId(s) : (s.filename || '')) || '';
    }
    function localFilename(s) {
        return window._libraryLocalFilename ? window._libraryLocalFilename(s, state.provider) : (s.filename || '');
    }
    // Stable per-card key: the local filename when present (local song, or a
    // synced remote one), else the provider song id.
    function cardKey(s) { return localFilename(s) || songId(s); }

    function artUrl(song) {
        if (window._librarySongArtUrl) return window._librarySongArtUrl(song, state.provider);
        const v = song.mtime ? ('?v=' + Math.floor(song.mtime)) : '';
        return song.filename ? '/api/song/' + enc(song.filename) + '/art' + v : '';
    }

    // Play a card: local (or already-synced remote) → playSong the local file;
    // an unsynced remote song → sync it first, then play when ready.
    function playCard(song, arrIdx) {
        if (!song) return;
        _saveLibraryScrollSnapshot();
        const lf = localFilename(song);
        if (lf) { if (window.playSong) window.playSong(enc(lf), arrIdx); return; }
        const sid = songId(song);
        if (window.syncLibrarySong && sid) window.syncLibrarySong(state.provider, sid, { playWhenReady: true });
    }

    // Accuracy badge markup. `variant` is 'grid' (overlay pill on the card art,
    // default) or 'tree' (inline percentage in the list row). Both carry the
    // .fb-acc-badge class so a post-play refresh (repaintAccuracy) can find and
    // replace them in place without re-rendering the whole list.
    function accuracyBadge(filename, variant) {
        const acc = state.accuracy[filename];
        if (acc == null) return '';
        const pct = Math.round(acc * 100);
        if (variant === 'tree') {
            const color = acc >= MASTERY_ACCURACY ? 'text-fb-good' : acc >= 0.5 ? 'text-fb-mid' : 'text-fb-low';
            return '<span class="fb-acc-badge text-xs font-bold ' + color + '">' + pct + '%</span>';
        }
        const color = acc >= MASTERY_ACCURACY ? 'bg-fb-good' : (acc >= 0.5 ? 'bg-fb-mid' : 'bg-fb-low');
        const text = acc >= 0.5 && acc < MASTERY_ACCURACY ? 'text-black' : 'text-white';
        return '<span class="fb-acc-badge absolute bottom-0 right-0 ' + color + '/90 ' + text + ' px-2 py-0.5 rounded-tl-md text-xs font-bold flex items-center gap-1">' +
            '<svg class="w-3 h-3" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="4"/></svg>' + pct + '%</span>';
    }

    // After a song is scored, the badge for that card is stale until the next
    // full render(). Refresh state.accuracy from the server and patch the badge
    // of any currently-rendered card/row in place (grid + tree). `_dirtyScores`
    // tracks filenames scored while the library was off-screen, applied on enter.
    const _dirtyScores = new Set();

    // Set when a library scan / DLC-folder change happened while this screen was
    // off (or showing a stale, e.g. pre-DLC empty, grid). The grid's cached DOM /
    // snapshot would otherwise survive a sidebar return, so we force a full
    // re-fetch on the next entry. (feedBack — "No DLC until restart".)
    let _libraryDirty = false;

    function repaintAccuracy(key) {
        const apply = (el, variant) => {
            if (el.getAttribute('data-fn') !== key) return;
            const old = el.querySelector('.fb-acc-badge');
            const html = accuracyBadge(key, variant);
            if (variant === 'grid') {
                const art = el.querySelector('[data-v3-play]');
                if (!art) return;
                if (old) old.remove();
                if (html) art.insertAdjacentHTML('beforeend', html);
            } else if (old) {
                if (html) old.outerHTML = html; else old.remove();
            } else if (html) {
                // No prior badge in this row — insert before the favorite button
                // so it keeps its slot (after the format chip).
                const fav = el.querySelector('[data-fav]');
                if (fav) fav.insertAdjacentHTML('beforebegin', html);
                else el.insertAdjacentHTML('beforeend', html);
            }
        };
        document.querySelectorAll('#v3-songs-grid [data-fn]').forEach((el) => apply(el, 'grid'));
        document.querySelectorAll('#v3-songs-tree [data-fn]').forEach((el) => apply(el, 'tree'));
    }

    async function applyScoreRefresh() {
        if (!_dirtyScores.size) return;
        const fresh = await jget('/api/stats/best');
        // Fetch failed — keep the entries dirty so the next trigger (or screen
        // enter) retries rather than silently dropping the badge update.
        if (!fresh) return;
        state.accuracy = fresh;
        const keys = Array.from(_dirtyScores);
        _dirtyScores.clear();
        keys.forEach(repaintAccuracy);
        // A new score shifts the repertoire meter + the keep-practicing shelf.
        renderLibraryHome();
    }

    // ── Practice-aware library home (repertoire meter + "Keep practicing") ─────
    // The meter reads state.accuracy (/api/stats/best = {filename: best_accuracy});
    // the shelf reads the growth-edge recommender (/api/library/practice-suggestions,
    // P3). A song is "in your repertoire" at the same threshold the green accuracy
    // badge uses (>= 0.9); a started song below that is "in progress". This is
    // descriptive encouragement — it never gates content, decays, or nags (the
    // goal-gradient / endowed-progress idea, kept healthy).
    const MASTERY_ACCURACY = 0.9;

    function _repertoireCounts() {
        let mastered = 0, learning = 0;
        for (const v of Object.values(state.accuracy || {})) {
            if (typeof v !== 'number') continue;
            if (v >= MASTERY_ACCURACY) mastered++; else learning++;
        }
        return { mastered, learning };
    }

    // The home block is the unfiltered "front door": shown on the grid view when
    // the user isn't running a focused query (search / filter) or selecting.
    // Local provider only — the meter's mastered count and the shelf both read
    // local practice stats (state.accuracy / the practice-suggestions endpoint),
    // so on a remote provider they'd mix local numerators with a remote song total
    // and play local files while browsing a remote library. Hide it there.
    function libHomeVisible() {
        return state.view === 'grid' && state.provider === 'local'
            && !state.selectMode && !state.q && activeFilterCount() === 0;
    }

    let _homeToken = 0;
    async function renderLibraryHome() {
        const host = document.getElementById('v3-lib-home');
        if (!host) return;
        if (!libHomeVisible()) { host.classList.add('hidden'); return; }
        // A newer render (view/filter/score change) supersedes this one so a
        // slow response can't repaint a home the grid already moved past.
        const myToken = ++_homeToken;
        // Unfiltered library size for the meter denominator (the grid's
        // state.total tracks the active filter; the meter is library-wide) +
        // the growth-edge "practice next" shelf rows, fetched together.
        const [stats, suggestions] = await Promise.all([
            jget('/api/library/stats?provider=' + enc(state.provider)),
            jget('/api/library/practice-suggestions?limit=8'),
        ]);
        if (_homeToken !== myToken || !libHomeVisible()) {            // changed mid-fetch
            if (_homeToken === myToken) host.classList.add('hidden');
            return;
        }
        const total = (stats && (stats.total_songs ?? stats.total)) || 0;
        if (total <= 0) { host.classList.add('hidden'); return; }    // empty library
        // Shelf = the growth-edge recommender (P3): attempted-but-not-mastered
        // songs ordered by difficulty-appropriateness × mastery-proximity, so it
        // points at the version worth practicing next rather than just the most
        // recent. The server already gates (not-mastered) + aggregates per song,
        // so the rows are the shelf as-is; each row's `arrangement` is the one
        // closest to mastery (what a click should open).
        const shelf = Array.isArray(suggestions) ? suggestions : [];

        const { mastered, learning } = _repertoireCounts();
        const pct = Math.max(0, Math.min(100, Math.round((mastered / total) * 100)));
        const meter =
            '<div class="v3-rep-meter">' +
              '<div class="flex items-baseline justify-between gap-3 mb-1">' +
                '<span class="text-sm font-semibold text-fb-text">Repertoire</span>' +
                '<span class="text-xs text-fb-textDim">' + mastered + ' of ' + total + ' song' + (total === 1 ? '' : 's') +
                  (learning ? ' &middot; ' + learning + ' in progress' : '') + '</span>' +
              '</div>' +
              '<div class="v3-rep-track"><div class="v3-rep-fill" style="width:' + pct + '%"></div></div>' +
            '</div>';

        let shelfHtml = '';
        if (shelf.length) {
            const cards = shelf.map((r) =>
                '<button class="v3-kp-card group text-left" data-kp="' + esc(r.filename) + '" data-arr="' + esc(r.arrangement != null ? r.arrangement : '') + '" title="' + esc(r.title) + '">' +
                '<div class="relative aspect-square rounded-lg overflow-hidden bg-fb-card">' +
                '<img src="' + esc(r.art_url) + '" alt="" loading="lazy" decoding="async" class="w-full h-full object-cover transition-transform duration-300 group-hover:scale-105" onerror="this.style.visibility=\'hidden\'">' +
                accuracyBadge(r.filename) +
                '</div>' +
                '<div class="mt-1 text-sm text-fb-text truncate">' + esc(r.title) + '</div>' +
                '<div class="text-xs text-fb-textDim truncate">' + esc(r.artist) + '</div>' +
                '</button>').join('');
            shelfHtml =
                '<section class="v3-kp-shelf mt-4">' +
                '<h3 class="text-sm font-semibold text-fb-text mb-2">Keep practicing</h3>' +
                '<div class="v3-kp-row">' + cards + '</div>' +
                '</section>';
        }

        host.innerHTML = meter + shelfHtml;
        host.classList.remove('hidden');
        // The home block sits above the grid sizer, so its height shifts where the
        // window maps in scroll space — repaint the window once it's laid out.
        if (state.view === 'grid') requestWindowRender();
        // Wire shelf cards → play (mirrors playCard's local path; suggestions are
        // always local-library rows, so no provider sync is needed).
        host.querySelectorAll('.v3-kp-card').forEach((btn) => btn.addEventListener('click', () => {
            const fn = btn.getAttribute('data-kp');
            const arr = btn.getAttribute('data-arr');
            if (!fn || !window.playSong) return;
            _saveLibraryScrollSnapshot();
            window.playSong(enc(fn), arr === '' ? undefined : Number(arr));
        }));
    }

    // Toggle/refresh the home block on view/sort/filter/search changes.
    function updateLibraryHome() {
        const host = document.getElementById('v3-lib-home');
        if (!host) return;
        if (!libHomeVisible()) { host.classList.add('hidden'); return; }
        renderLibraryHome();
    }

    // Source format of a song — prefer the server's `format` field, fall back
    // to the filename extension. Returns '' for unknown.
    function fmtLabel(song) {
        let f = (song.format || '').toLowerCase();
        if (!f) {
            const fn = (song.filename || '').toLowerCase();
            f = (fn.endsWith('.feedpak') || fn.endsWith('.sloppak')) ? 'sloppak' : '';
        }
        return f === 'sloppak' ? 'FEEDPAK' : f === 'loose' ? 'FOLDER' : '';
    }
    // Corner badge for art-based cards (sloppak accented, others muted).
    function fmtBadge(song) {
        const l = fmtLabel(song);
        if (!l) return '';
        const c = l === 'FEEDPAK' ? 'bg-fb-primary text-white' : 'bg-black/70 text-fb-textDim';
        return '<span class="absolute bottom-0 left-0 ' + c + ' text-[0.5625rem] font-bold px-1.5 py-0.5 rounded-tr-md tracking-wide">' + l + '</span>';
    }

    // Personal-layer badges (P2): a difficulty pip + a tag count, painted from the
    // row payload P1 embeds (song.user_difficulty / song.tags). Sits at top-right
    // and fades on hover so it yields to the action buttons that share that corner.
    // Returns '' when the song has neither, so an un-annotated card is byte-for-byte
    // what it was before P2 (keeps the windowed grid's height math untouched).
    function personalBadges(song) {
        const d = song.user_difficulty;
        const tags = song.tags || [];
        if (d == null && !tags.length) return '';
        let out = '<div class="absolute top-2 right-2 flex gap-1 opacity-100 group-hover:opacity-0 transition pointer-events-none">';
        if (d != null) out += '<span class="bg-black/60 text-white text-[0.625rem] font-bold px-1.5 py-0.5 rounded" title="Your difficulty: ' + esc(DIFF_LABELS[d] || d) + '">◆' + esc(d) + '</span>';
        if (tags.length) out += '<span class="bg-black/60 text-white text-[0.625rem] font-bold px-1.5 py-0.5 rounded" title="Tags: ' + esc(tags.join(', ')) + '">🏷' + tags.length + '</span>';
        return out + '</div>';
    }

    // Clickable arrangement chips — one <button data-arr="<index>"> per
    // arrangement. wireCards() binds the click to playCard(song, index), which
    // opens THAT arrangement in the highway via playSong(filename, index).
    // Shared by the grid card and the tree row so both views render the same
    // badges with the same click-to-open behaviour. Capped at 4 to match the
    // card layout.
    function arrChipsHtml(song) {
        return (song.arrangements || []).slice(0, 4).map((a) =>
            '<button data-arr="' + esc(a.index != null ? a.index : '') + '" title="Play ' + esc(a.name) + '" class="text-[0.625rem] px-1.5 py-0.5 rounded bg-gray-800/60 text-fb-textDim hover:bg-fb-primary hover:text-white transition">' + esc(a.name) + '</button>').join('');
    }

    // ⚑ multi-chart chip (P5c, design §7.1): the persistent "other versions
    // exist" cue on a grouped card. Rendered ONLY when the grouped query says
    // this card stands for 2+ charts of one work (chart_count = work_display
    // group_size, P5a) — a single-chart card emits nothing, so its markup stays
    // byte-identical to an ungrouped card. First in the chip row + shrink-0 so
    // the overflow-hidden row clips arrangement chips before it ever clips the
    // cue. Clicking it opens the Charts drawer (see wireCards).
    function chartsChipHtml(song) {
        const n = song.chart_count;
        if (!(n >= 2) || !song.work_key) return '';
        return '<button data-charts="' + esc(song.work_key) + '" title="' + n + ' charts of this song" aria-label="' + n + ' charts of this song" class="shrink-0 text-[0.625rem] px-1.5 py-0.5 rounded bg-fb-primary/15 text-fb-primary border border-fb-primary/40 hover:bg-fb-primary hover:text-white transition">⚑ ' + n + ' charts</button>';
    }

    // ── Tuning-match flags (working-tuning PR 6) ───────────────────────────────
    // Colour each song's tuning chip by whether your CURRENT working tuning covers
    // it: green = play it now, amber = needs a retune. Uses the tuner plugin's
    // coverage check (async) + the host workingTuning state — BOTH feature-detected,
    // so without them the chips render exactly as before. Decoration runs AFTER the
    // (sync) window paint so scrolling stays snappy; a token cancels a superseded pass.
    let _tuningDecorToken = 0;
    function _applyChipMatch(chip, stateName) {
        chip.classList.remove('bg-fb-mid', 'bg-emerald-500', 'bg-amber-400');
        chip.classList.add(stateName === 'match' ? 'bg-emerald-500'
            : stateName === 'retune' ? 'bg-amber-400' : 'bg-fb-mid');
        if (!chip.dataset.baseTitle) chip.dataset.baseTitle = chip.getAttribute('title') || '';
        chip.setAttribute('title', chip.dataset.baseTitle + (stateName === 'match'
            ? ' — matches your tuning' : stateName === 'retune' ? ' — needs a retune' : ''));
    }
    async function decorateTuningChips(grid) {
        if (!grid) return;
        const cov = window._tunerAutoOpen && window._tunerAutoOpen.coverageReport;
        const hasWT = window.feedBack && window.feedBack.workingTuning
            && typeof window.feedBack.workingTuning.get === 'function';
        if (typeof cov !== 'function' || !hasWT) return;   // feature-detect → no flags
        const token = ++_tuningDecorToken;
        const chips = grid.querySelectorAll('[data-tuning-chip][data-tuning-offsets]');
        for (const chip of chips) {
            const offs = chip.getAttribute('data-tuning-offsets').split(',').map(Number);
            if (!offs.length || offs.some((n) => !isFinite(n))) continue;
            // Pass the instrument so coverage uses the right base pitches (bass vs guitar).
            const arrangement = chip.dataset.tuningBass === '1' ? 'Bass' : 'Lead';
            let rep = null;
            try { rep = await cov({ tuning: offs, stringCount: offs.length, arrangement: arrangement }); } catch (_) { rep = null; }
            if (token !== _tuningDecorToken) return;   // superseded by a re-paint / tuning change
            if (rep) _applyChipMatch(chip, rep.covered ? 'match' : 'retune');
        }
    }

    function songCard(song) {
        const fav = song.favorite;
        const key = cardKey(song);
        // §7.1 display-chart switch (P5e): under a chart-intrinsic filter the
        // server may attach `display_chart` — the member that MATCHES the
        // filter when the representative doesn't. The card SHOWS and PLAYS
        // that chart, while the row identity (sort keys, data-fn, the
        // accuracy/heart anchor = the preferred chart) stays the rep's.
        const shown = song.display_chart ? Object.assign({}, song, song.display_chart) : song;
        // In select mode the checkbox occupies top-2 left-2, so shift the
        // tuning chip right (left-9) to avoid overlapping it.
        const tuningLabel = (typeof window.displayTuningName === 'function')
            ? window.displayTuningName(shown.tuning_name || shown.tuning)
            : (shown.tuning_name || '');
        let tuning = '';
        if (tuningLabel) {
            const rawOffsets = (typeof window.parseRawTuningOffsets === 'function')
                ? (window.parseRawTuningOffsets(shown.tuning_offsets)
                    || window.parseRawTuningOffsets(shown.tuning_name || shown.tuning))
                : null;
            const targetNotes = (tuningLabel === 'Custom Tuning' && rawOffsets
                && typeof window.displayTuningTargets === 'function')
                ? window.displayTuningTargets(rawOffsets, { tuningName: tuningLabel })
                : '';
            const badgeTitle = targetNotes
                ? ('Custom Tuning: ' + targetNotes)
                : tuningLabel;
            const pos = 'absolute top-2 ' + (state.selectMode ? 'left-9' : 'left-2');
            // Tag the chip with its offsets so decorateTuningChips() can colour it
            // green (matches your current tuning) / amber (needs a retune) after paint.
            // Also flag a bass-only song (every arrangement is a bass part) so coverage
            // scores its bass tuning against the bass base pitches, not guitar — otherwise
            // a 4-string bass tuning read as guitar can false-match a guitar player.
            const chipArrs = shown.arrangements || [];
            const chipIsBass = chipArrs.length > 0
                && chipArrs.every((a) => /\bbass\b/i.test((a && a.name) || ''));
            const matchAttr = (rawOffsets && rawOffsets.length)
                ? ' data-tuning-chip data-tuning-offsets="' + esc(rawOffsets.join(',')) + '"'
                    + (chipIsBass ? ' data-tuning-bass="1"' : '') : '';
            if (targetNotes) {
                tuning = '<span class="' + pos + ' bg-fb-mid text-black text-[0.5625rem] font-bold px-1.5 py-0.5 rounded-sm leading-tight max-w-[5.5rem] text-center"' + matchAttr + ' title="' + esc(badgeTitle) + '">'
                    + esc('Custom Tuning') + '<br><span class="font-semibold tracking-wide">' + esc(targetNotes) + '</span></span>';
            } else {
                tuning = '<span class="' + pos + ' bg-fb-mid text-black text-[0.625rem] font-bold px-1.5 py-0.5 rounded-sm"' + matchAttr + ' title="' + esc(badgeTitle) + '">' + esc(tuningLabel) + '</span>';
            }
        }
        // Display-only (pointer-events-none) so a click falls through to the
        // card's data-v3-play handler, which owns the toggle — avoids double-toggle.
        const checkbox = state.selectMode
            ? '<input type="checkbox" data-select class="absolute top-2 left-2 z-20 w-5 h-5 accent-fb-primary pointer-events-none"' + (state.selected.has(key) ? ' checked' : '') + '>'
            : '';
        const arrChips = arrChipsHtml(shown);
        const chartsChip = chartsChipHtml(song);
        // Plugin-contributed card actions placed 'inline' (in the hover action
        // row) or 'overlay' (centered over the art). Menu-placed actions live in
        // the ⋮ menu (openCardMenu); rendering these here means plugins using
        // those placements are no longer silently dropped. No bundled action
        // uses them, so for the stock library both strings are empty — the card
        // renders exactly as before.
        const reg = sm && sm.libraryCardActions;
        const acts = (reg && typeof reg.list === 'function') ? reg.list(song) : [];
        const actBtn = (a) =>
            '<button data-act-card="' + esc(a.id) + '" title="' + esc(a.label || a.id) + '" aria-label="' + esc(a.label || a.id) + '"' +
            (a.enabled === false ? ' disabled' : '') +
            ' class="px-2 h-7 min-w-[1.75rem] rounded-full bg-black/55 hover:bg-black/75 flex items-center justify-center text-xs leading-none ' +
            (a.enabled === false ? 'opacity-40 cursor-not-allowed ' : '') +
            (a.destructive ? 'text-fb-accent' : 'text-white') + '">' + esc(a.icon || a.label || '•') + '</button>';
        const inlineBtns = acts.filter((a) => a.placement === 'inline').map(actBtn).join('');
        const overlayActs = acts.filter((a) => a.placement === 'overlay');
        const overlay = overlayActs.length
            ? '<div class="absolute inset-0 flex items-center justify-center opacity-0 group-hover:opacity-100 transition pointer-events-none"><div class="flex flex-wrap gap-1 justify-center max-w-[90%] pointer-events-auto">' + overlayActs.map(actBtn).join('') + '</div></div>'
            : '';
        // Recycled cards re-render from state, so a selected card must paint its
        // ring on initial markup (toggleSelect only adds it to a live node).
        const selRing = state.selected.has(key) ? ' ring-2 ring-fb-primary' : '';
        return '<div class="group relative" data-fn="' + esc(key) + '" data-letter="' + esc(songBucket(song)) + '" data-library-song="' + esc(songId(song)) + '" data-library-provider="' + esc(state.provider) + '">' +
            '<div class="relative aspect-square rounded-lg overflow-hidden bg-fb-card cursor-pointer' + selRing + '" data-v3-play>' +
            '<img src="' + esc(artUrl(shown)) + '" alt="" loading="lazy" decoding="async" class="w-full h-full object-cover transition-transform duration-300 group-hover:scale-105" onerror="this.style.visibility=\'hidden\'">' +
            tuning + checkbox + accuracyBadge(key) + fmtBadge(shown) + personalBadges(song) + overlay +
            '<div class="absolute top-2 right-2 flex gap-1 opacity-0 group-hover:opacity-100 transition">' +
            inlineBtns +
            '<button data-fav data-fav-idle="text-white" title="Favorite" aria-label="Favorite" aria-pressed="' + (fav ? 'true' : 'false') + '" class="w-7 h-7 rounded-full bg-black/50 hover:bg-black/70 flex items-center justify-center text-sm ' + (fav ? 'text-fb-accent' : 'text-white') + '">' + (fav ? '♥' : '♡') + '</button>' +
            '<button data-save title="Save for later" aria-label="Save for later" class="w-7 h-7 rounded-full bg-black/50 hover:bg-black/70 flex items-center justify-center text-white text-sm">🔖</button>' +
            '<button data-menu title="More" aria-label="More actions" class="w-7 h-7 rounded-full bg-black/50 hover:bg-black/70 flex items-center justify-center text-white text-sm leading-none">⋮</button>' +
            '</div></div>' +
            '<div class="mt-1 text-sm text-fb-text truncate" title="' + esc(shown.title) + '">' + esc(shown.title) + '</div>' +
            '<div class="text-xs text-fb-textDim truncate">' + esc(song.artist) + '</div>' +
            // Always emit the chip row (even when empty) at a FIXED single-line
            // height — uniform card height is what makes the windowed grid's
            // absolute-position math exact (.v3-card-chips in v3.css).
            '<div class="v3-card-chips flex gap-1 mt-1">' + chartsChip + arrChips + '</div>' +
            '</div>';
    }

    // Per-card action menu, built from the ui.library-card-injection registry
    // (core Edit/Retune + any plugin-registered actions).
    let _closeCardMenu = null;   // tears down the currently-open card menu + its document closer
    function openCardMenu(cardEl, song, anchorBtn, pos) {
        // Fully close any already-open menu first — removing just the DOM node
        // (as before) would orphan its document-level click closer.
        if (_closeCardMenu) _closeCardMenu();
        const reg = sm && sm.libraryCardActions;
        // Only show actions intended for the overflow menu — actions placed
        // 'inline'/'overlay' get their own affordances on the card (see songCard).
        // Undefined placement defaults to the menu.
        const items = (reg ? reg.list(song) : []).filter((a) => !a.placement || a.placement === 'menu');
        const menu = document.createElement('div');
        // pos (right-click) positions the menu at the pointer via `fixed`;
        // the ⋮ button keeps the absolute top-right anchor.
        menu.className = 'v3-card-menu z-30 min-w-[10rem] bg-fb-card border border-fb-border/60 rounded-lg shadow-xl py-1 text-sm ' + (pos ? 'fixed' : 'absolute top-10 right-2');
        // Multi-chart entries (P5d): a grouped grid row carries chart_count +
        // work_key (P5a annotation), so the menu knows inline whether this card
        // stands for versions. Local library only — the work API is local.
        const canCharts = state.provider === 'local' && song.work_key && song.chart_count >= 2;
        // Play follows the DISPLAYED chart (see wireCards) — under an intrinsic
        // filter that's the matching member, not the representative.
        const playTarget = song.display_chart ? Object.assign({}, song, song.display_chart) : song;
        const rows = [
            { id: '__play', label: 'Play', run: () => { _saveLibraryScrollSnapshot(); window.playSong && window.playSong(enc(playTarget.filename)); } },
            ...(canCharts ? [
                { id: '__charts', label: 'Charts (' + song.chart_count + ')…' },
                { id: '__playver', label: 'Play version ▸' },
            ] : []),
            // Undo for the drawer's "Split out" (P5e) — a split chart is its
            // own singleton card (no ⚑ chip), so this is its only way back.
            ...(state.provider === 'local' && song.is_split
                ? [{ id: '__unsplit', label: 'Rejoin other versions' }] : []),
            { id: '__playlist', label: 'Add to playlist' },
            { id: '__save', label: 'Save for later' },
            ...items.map((a) => ({ id: a.id, label: a.label, destructive: a.destructive, enabled: a.enabled, plugin: a.pluginId })),
            // Metadata + file actions (R2) — local library only (they all
            // address the local DB / filesystem). Both openers (⋮ and
            // right-click) share this list, so parity is structural.
            ...(state.provider === 'local' && song.filename ? [
                { id: '__fixmatch', label: 'Fix match…' },
                { id: '__cover', label: 'Change cover…' },
                { id: '__refreshmeta', label: 'Refresh metadata' },
                { id: '__getinfo', label: 'Get info…' },
                { id: '__remove', label: 'Remove from library', destructive: true },
            ] : []),
        ];
        menu.innerHTML = rows.map((r) =>
            '<button data-act="' + esc(r.id) + '" class="w-full text-left px-3 py-1.5 hover:bg-fb-card/60 ' +
            (r.enabled === false ? 'opacity-40 cursor-not-allowed ' : '') +
            (r.destructive ? 'text-fb-accent' : 'text-fb-text') + '">' + esc(r.label) +
            (r.plugin && r.plugin !== 'core' ? '<span class="text-[0.625rem] text-fb-textDim ml-1">' + esc(r.plugin) + '</span>' : '') + '</button>').join('');
        if (pos) {
            // Right-click: position the menu at the pointer (fixed, viewport-
            // relative), clamped so it never spills off the right/bottom edge.
            document.body.appendChild(menu);
            const x = Math.min(pos.x, window.innerWidth - menu.offsetWidth - 8);
            const y = Math.min(pos.y, window.innerHeight - menu.offsetHeight - 8);
            menu.style.left = Math.max(8, x) + 'px';
            menu.style.top = Math.max(8, y) + 'px';
        } else {
            cardEl.appendChild(menu);
        }
        // Tear down BOTH the menu and its document-level closer together, so a
        // menu-item click doesn't leave the closer attached (it would otherwise
        // leak, retaining this menu's closures until the next document click).
        const closer = (e) => { if (!menu.contains(e.target) && e.target !== anchorBtn) closeMenu(); };
        function closeMenu() { menu.remove(); document.removeEventListener('click', closer); if (_closeCardMenu === closeMenu) _closeCardMenu = null; }
        _closeCardMenu = closeMenu;
        menu.querySelectorAll('[data-act]').forEach((b) => b.addEventListener('click', async (e) => {
            e.stopPropagation();
            const id = b.getAttribute('data-act');
            // 'Play version ▸' swaps THIS menu's rows for the work's charts —
            // it must expand in place, so it's the one entry that doesn't close.
            if (id === '__playver') { await _expandPlayVersions(menu, song, closeMenu); return; }
            closeMenu();
            if (id === '__play') { playCard(playTarget); return; }
            if (id === '__charts') { openChartsDrawer(song.work_key, song); return; }
            if (id === '__unsplit') {
                if (await jsend('POST', '/api/chart/' + enc(song.filename) + '/unsplit')) _groupChanged();
                return;
            }
            if (id === '__playlist') { await addFilenamesToPlaylist([song.filename]); return; }
            if (id === '__save') { if (window.v3Saved) await window.v3Saved.toggle(song.filename); return; }
            // Per-chart metadata actions follow the DISPLAYED chart (playTarget),
            // like Play — under an intrinsic filter that's the matching member,
            // not the group representative. (__remove stays on `song`: it needs
            // the group's work_key/chart_count and pre-ticks the shown chart.)
            if (id === '__fixmatch') { if (window.__fbFixMatch) window.__fbFixMatch(playTarget); return; }
            if (id === '__cover') {
                if (window.__fbOpenImagePicker) window.__fbOpenImagePicker({ filename: playTarget.filename, title: playTarget.title || playTarget.filename });
                return;
            }
            if (id === '__refreshmeta') {
                // Silent on success (hearing-safe, like the rest of the match
                // layer) — the re-match trickles in through the normal pass.
                await jsend('POST', '/api/enrichment/refresh/' + enc(playTarget.filename));
                return;
            }
            if (id === '__getinfo') { openGetInfo(playTarget); return; }
            if (id === '__remove') { await removeSongsFlow(song); return; }
            if (reg) await reg.run(id, song, { source: 'v3-songs' });
        }));
        // Tree rows ride the (ungrouped) artists endpoint, so they don't carry
        // chart_count/work_key — resolve the work lazily and slot a
        // "Charts (N)…" entry into the still-open menu when versions exist.
        // Grid rows already carry both (chart_count defined ⇒ no fetch).
        if (state.provider === 'local' && song.chart_count === undefined && song.filename) {
            jget('/api/chart/' + enc(song.filename) + '/work').then((w) => {
                if (!w || !menu.isConnected) return;
                const addEntry = (label, run) => {
                    const b = document.createElement('button');
                    b.className = 'w-full text-left px-3 py-1.5 hover:bg-fb-card/60 text-fb-text';
                    b.textContent = label;
                    b.addEventListener('click', (e) => { e.stopPropagation(); closeMenu(); run(); });
                    menu.appendChild(b);
                };
                if (w.chart_count >= 2 && w.work_key) {
                    addEntry('Charts (' + w.chart_count + ')…', () => openChartsDrawer(w.work_key, song));
                }
                if (w.is_split) {
                    addEntry('Rejoin other versions', async () => {
                        if (await jsend('POST', '/api/chart/' + enc(song.filename) + '/unsplit')) _groupChanged();
                    });
                }
            });
        }
        setTimeout(() => document.addEventListener('click', closer), 0);
    }

    // 'Play version ▸' (P5d): swap the ⋮ menu's rows for the work's charts;
    // picking one plays that chart directly. A one-off alternate play — the
    // keeper/headline doesn't move (stats record to the played chart's own
    // filename), which is the design's "casual try ≠ deliberate adopt".
    async function _expandPlayVersions(menu, song, closeMenu) {
        const data = await jget('/api/work/' + enc(song.work_key) + '/charts');
        if (!data || !Array.isArray(data.charts) || !data.charts.length || !menu.isConnected) return;
        menu.innerHTML = data.charts.map((c) => {
            const tl = (typeof window.displayTuningName === 'function')
                ? window.displayTuningName(c.tuning_name || c.tuning) : (c.tuning_name || '');
            return '<button data-ver="' + esc(c.filename) + '" title="' + esc(c.filename) + '" class="w-full text-left px-3 py-1.5 hover:bg-fb-card/60 text-fb-text">' +
                (c.is_representative ? '<span class="text-fb-primary">●</span> ' : '') + esc(c.title) +
                (tl ? '<span class="text-[0.625rem] text-fb-textDim ml-1">' + esc(tl) + '</span>' : '') +
                '</button>';
        }).join('');
        menu.querySelectorAll('[data-ver]').forEach((vb) => vb.addEventListener('click', (e) => {
            e.stopPropagation();
            const fn = vb.getAttribute('data-ver');
            closeMenu();
            _saveLibraryScrollSnapshot();
            if (window.playSong) window.playSong(enc(fn));
        }));
    }

    // ── Remove from library (R2) ───────────────────────────────────────────--
    // On a single-chart song: confirm + delete, as the Details drawer does.
    // On a multi-chart work: "remove the song" is ambiguous — a grouped card
    // stands for several files — so an interstitial lists EVERY version for
    // select/multi-select and deletes exactly what the user picked, one file
    // or the whole set.
    async function removeSongsFlow(song) {
        let wk = song.work_key, count = song.chart_count;
        if (count === undefined && song.filename) {
            // Flat-mode grid / tree rows don't carry the group annotation.
            const w = await jget('/api/chart/' + enc(song.filename) + '/work');
            if (w) { wk = w.work_key; count = w.chart_count; }
        }
        if (wk && count >= 2) {
            const data = await jget('/api/work/' + enc(wk) + '/charts');
            const charts = (data && data.charts) || [];
            if (charts.length >= 2) { openVersionRemoveModal(song, charts); return; }
        }
        if (!(await _confirmRemove(song.title || song.filename, 1))) return;
        await _deleteFiles([song.filename]);
    }

    async function _confirmRemove(label, n) {
        const what = n === 1 ? '"' + label + '"' : n + ' versions of "' + label + '"';
        if (typeof window.uiConfirm === 'function') {
            return window.uiConfirm({
                title: 'Remove from library?',
                html: 'Remove ' + esc(what) + ' from your library?' +
                    '<p class="text-xs text-red-400/90 mt-2">This permanently deletes the file' + (n === 1 ? '' : 's') + ' from disk. This cannot be undone.</p>',
                confirmText: 'Remove', cancelText: 'Cancel', danger: true,
            });
        }
        return window.confirm('Remove ' + what + ' from your library? This deletes the file' + (n === 1 ? '' : 's') + ' from disk.');
    }

    async function _deleteFiles(files) {
        for (const fn of files) {
            try { await fetch('/api/song/' + enc(fn), { method: 'DELETE' }); } catch (_) { /* keep going */ }
        }
        try { _groupChanged(); } catch (_) { try { reload(); } catch (_) { /* */ } }
    }

    // The multi-version interstitial: a centred modal (the Tidy-up idiom)
    // listing all charts of the work with checkboxes — the card's own chart
    // pre-checked — so "delete" does exactly what the user means, whether
    // that's one file or the batch.
    function openVersionRemoveModal(song, charts) {
        const sel = new Set([song.display_chart ? song.display_chart.filename : song.filename]);
        const overlay = document.createElement('div');
        overlay.className = 'fixed inset-0 z-[200] bg-black/60 backdrop-blur-sm flex items-center justify-center p-4';
        const onKey = (e) => { if (e.key === 'Escape') { e.preventDefault(); done(); } };
        function done() { overlay.remove(); document.removeEventListener('keydown', onKey); }
        document.addEventListener('keydown', onKey);
        overlay.addEventListener('click', (e) => { if (e.target === overlay) done(); });
        document.body.appendChild(overlay);

        function render() {
            const rows = charts.map((c) => {
                const tl = (typeof window.displayTuningName === 'function')
                    ? window.displayTuningName(c.tuning_name || c.tuning) : (c.tuning_name || '');
                const meta = [tl, (c.arrangements || []).map((a) => a.name).join('/'), c.format]
                    .filter(Boolean).join(' · ');
                return '<label class="flex items-start gap-2 px-2 py-1.5 rounded hover:bg-fb-card/50 cursor-pointer">' +
                    '<input type="checkbox" data-rm="' + esc(c.filename) + '"' + (sel.has(c.filename) ? ' checked' : '') + ' class="w-4 h-4 mt-0.5 accent-fb-primary shrink-0">' +
                    '<span class="min-w-0"><span class="block text-sm text-fb-text truncate">' + esc(c.title) +
                    (c.is_representative ? ' <span class="text-fb-primary">●</span>' : '') + '</span>' +
                    (meta ? '<span class="block text-xs text-fb-textDim truncate">' + esc(meta) + '</span>' : '') +
                    '<span class="block text-xs text-fb-textDim/70 truncate fb-selectable">' + esc(c.filename) + '</span></span></label>';
            }).join('');
            const n = sel.size;
            overlay.innerHTML =
                '<div class="bg-fb-sidebar border border-fb-border/60 rounded-2xl w-full max-w-md shadow-2xl max-h-[85vh] flex flex-col">' +
                '<div class="p-5 pb-3"><h3 class="text-base font-semibold text-fb-text">Remove versions of “' + esc(song.title || '') + '”</h3>' +
                '<p class="text-xs text-fb-textDim mt-1">This song has ' + charts.length + ' charts. Tick the ones to remove — files are deleted from disk and this cannot be undone.</p></div>' +
                '<div class="px-3 overflow-y-auto v3-scroll flex-1 min-h-[6rem]">' + rows + '</div>' +
                '<div class="p-5 pt-3 flex items-center justify-between gap-3">' +
                '<button data-rm-cancel class="text-sm px-4 py-2 bg-fb-card/60 hover:bg-fb-card border border-fb-border/50 rounded-xl text-fb-text">Cancel</button>' +
                '<button data-rm-go ' + (n ? '' : 'disabled') + ' class="text-sm px-4 py-2 rounded-xl ' + (n ? 'bg-red-900/60 hover:bg-red-900/80 text-red-100' : 'bg-fb-card/50 text-fb-textDim cursor-not-allowed') + '">Remove selected (' + n + ')</button>' +
                '</div></div>';
            overlay.querySelectorAll('[data-rm]').forEach((cb) => cb.addEventListener('change', () => {
                const fn = cb.getAttribute('data-rm');
                if (cb.checked) sel.add(fn); else sel.delete(fn);
                render();
            }));
            overlay.querySelector('[data-rm-cancel]')?.addEventListener('click', done);
            overlay.querySelector('[data-rm-go]')?.addEventListener('click', async () => {
                if (!sel.size) return;
                done();
                await _deleteFiles([...sel]);
            });
        }
        render();
    }

    // ── Get info (R2) ──────────────────────────────────────────────────────--
    // File location + pack contents + the match verdict, from
    // GET /api/chart/{fn}/fileinfo. Paths and identity values are rendered
    // with .fb-selectable so they stay copyable under the v3 no-select default.
    function _fmtBytes(n) {
        if (!Number.isFinite(n)) return '';
        const u = ['B', 'KB', 'MB', 'GB'];
        let i = 0;
        while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
        return (i ? n.toFixed(1) : n) + ' ' + u[i];
    }

    async function openGetInfo(song) {
        const info = await jget('/api/chart/' + enc(song.filename) + '/fileinfo');
        if (!info) return;
        const overlay = document.createElement('div');
        overlay.className = 'fixed inset-0 z-[200] bg-black/60 backdrop-blur-sm flex items-center justify-center p-4';
        const onKey = (e) => { if (e.key === 'Escape') { e.preventDefault(); done(); } };
        function done() { overlay.remove(); document.removeEventListener('keydown', onKey); }
        document.addEventListener('keydown', onKey);
        overlay.addEventListener('click', (e) => { if (e.target === overlay) done(); });

        const row = (label, value, selectable) => value
            ? '<div class="flex gap-3 py-1"><span class="text-xs text-fb-textDim w-24 shrink-0 pt-0.5">' + label + '</span>' +
            '<span class="text-sm text-fb-text min-w-0 break-all' + (selectable ? ' fb-selectable' : '') + '">' + esc(value) + '</span></div>'
            : '';
        const m = info.manifest || {};
        const ident = m.identity || {};
        const identLine = Object.keys(ident).map((k) =>
            k + ': ' + (Array.isArray(ident[k]) ? ident[k].join(', ') : ident[k])).join(' · ');
        const match = info.match || {};
        const matchLine = match.match_state === 'manual' ? 'Pinned by you'
            : match.match_state === 'matched' ? ('Matched (' + (match.match_source || 'auto') +
                (match.match_score != null ? ', ' + Math.round(match.match_score * 100) + '%' : '') + ')')
            : match.match_state === 'review' ? 'Waiting for review'
            : match.match_state === 'failed' ? 'Not matched'
            : 'Not scanned yet';
        const contents = [
            (m.arrangements || []).length ? (m.arrangements.length + ' arrangement' + (m.arrangements.length === 1 ? '' : 's') + ' (' + m.arrangements.join(', ') + ')') : '',
            (m.stems || []).length ? ('stems: ' + m.stems.join(', ')) : '',
            m.has_cover ? 'cover art' : 'no cover art',
            m.has_lyrics ? 'lyrics' : '',
        ].filter(Boolean).join(' · ');

        overlay.innerHTML =
            '<div class="bg-fb-sidebar border border-fb-border/60 rounded-2xl w-full max-w-lg shadow-2xl max-h-[85vh] flex flex-col">' +
            '<div class="p-5 pb-3 flex items-center justify-between gap-3">' +
            '<h3 class="text-base font-semibold text-fb-text truncate">' + esc(song.title || info.filename) + '</h3>' +
            '<button data-gi-x aria-label="Close" class="text-fb-textDim hover:text-fb-text text-xl leading-none shrink-0">✕</button></div>' +
            '<div class="px-5 pb-5 overflow-y-auto v3-scroll space-y-1">' +
            row('Location', info.path, true) +
            row('Folder', info.folder, true) +
            row('Format', info.format === 'sloppak' ? 'Feedpak' : info.format) +
            row('Size', _fmtBytes(info.size)) +
            row('Modified', info.mtime ? new Date(info.mtime * 1000).toLocaleString() : '') +
            (info.manifest ? (
                '<div class="pt-2 mt-2 border-t border-fb-border/50"></div>' +
                row('Contents', contents) +
                row('Authors', (m.authors || []).filter(Boolean).join(', ')) +
                row('Identity', identLine || 'no identity keys authored', !!identLine)
            ) : '') +
            '<div class="pt-2 mt-2 border-t border-fb-border/50"></div>' +
            row('Match', matchLine) +
            (match.canon_artist ? row('Canonical', [match.canon_artist, match.canon_title, match.canon_album, match.canon_year].filter(Boolean).join(' — '), true) : '') +
            '</div></div>';
        document.body.appendChild(overlay);
        overlay.querySelector('[data-gi-x]')?.addEventListener('click', done);
    }

    // ── Charts drawer (P5d, design §7.1 UX-2/3) ────────────────────────────────
    // The single deep-management surface for a work's charts. A body-appended
    // slide-in panel (the filter-drawer idiom; body-appended like the playlist
    // picker so it opens from any view) listing every chart of the work as a
    // radiogroup — the checked row is the keeper the grid card plays. Clicking
    // an unchecked row (or Enter/Space on it) = Set as preferred, one tap;
    // "Reset to auto pick" appears when the keeper is your explicit pick.
    // Writes go through the work-charts API and the drawer re-renders from the
    // response (there's no server-side library event bus — the drawer is its
    // own refresh); the grid re-fetches because the representative may have
    // flipped. Global mode only — the slot-scoped (curated-album) mode is P6;
    // the per-row Split escape hatch is P5e.
    let _chartsPrevFocus = null;   // focus to restore when the drawer closes

    function _chartsDrawerEls() {
        let ov = document.getElementById('v3-charts-overlay');
        let dr = document.getElementById('v3-charts-drawer');
        if (!ov) {
            ov = document.createElement('div');
            ov.id = 'v3-charts-overlay';
            ov.className = 'fixed inset-0 bg-black/50 z-40 hidden';
            ov.addEventListener('click', closeChartsDrawer);
            document.body.appendChild(ov);
        }
        if (!dr) {
            dr = document.createElement('aside');
            dr.id = 'v3-charts-drawer';
            dr.className = 'fixed top-0 right-0 h-full w-full sm:w-96 bg-fb-sidebar border-l border-fb-border/50 z-50 transform translate-x-full transition-transform duration-200 overflow-y-auto v3-scroll';
            dr.setAttribute('role', 'dialog');
            dr.setAttribute('aria-modal', 'true');
            dr.setAttribute('aria-label', 'Charts of this song');
            // a11y: Escape closes; Tab is trapped inside the open drawer
            // (aria-modal alone doesn't trap for keyboard users); ArrowUp/Down
            // move focus between the chart rows (focus only — selection stays
            // on Enter/Space, since a native-radio "arrow = select" would fire
            // a preferred write on every keystroke).
            dr.addEventListener('keydown', (e) => {
                if (e.key === 'Escape') { e.preventDefault(); closeChartsDrawer(); return; }
                if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
                    const rows = [...dr.querySelectorAll('[role="radio"]')];
                    if (!rows.length) return;
                    const i = rows.indexOf(document.activeElement);
                    if (i === -1) return;
                    e.preventDefault();
                    rows[(i + (e.key === 'ArrowDown' ? 1 : rows.length - 1)) % rows.length].focus();
                    return;
                }
                if (e.key !== 'Tab') return;
                const foci = dr.querySelectorAll('button, [tabindex]:not([tabindex="-1"])');
                if (!foci.length) return;
                const first = foci[0], last = foci[foci.length - 1];
                if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
                else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
            });
            document.body.appendChild(dr);
        }
        return { ov: ov, dr: dr };
    }

    // One chart row. `checked` = the current keeper (pref or auto-pick). The
    // filename line is deliberate: duplicate charts usually share title/artist,
    // so the pack filename is often the only human-readable distinguisher.
    function _chartRowHtml(c, data) {
        const checked = c.is_representative;
        const prefLabel = checked
            ? (data.preferred_source === 'user' ? 'Preferred — your pick' : 'Preferred (auto)')
            : '';
        const tuningLabel = (typeof window.displayTuningName === 'function')
            ? window.displayTuningName(c.tuning_name || c.tuning)
            : (c.tuning_name || '');
        const meta = [fmtLabel(c), tuningLabel,
            (c.arrangements || []).map((a) => a.name).join('/'),
            c.year ? String(c.year) : '']
            .filter(Boolean).join(' · ');
        const acc = (typeof c.best_accuracy === 'number')
            ? '<span class="font-bold ' + (c.best_accuracy >= MASTERY_ACCURACY ? 'text-fb-good' : c.best_accuracy >= 0.5 ? 'text-fb-mid' : 'text-fb-low') + '">' + Math.round(c.best_accuracy * 100) + '%</span>'
            : '<span class="text-fb-textDim/60">not played</span>';
        return '<div role="radio" aria-checked="' + (checked ? 'true' : 'false') + '" tabindex="0" data-ch="' + esc(c.filename) + '"' +
            ' title="' + (checked ? esc(prefLabel) : 'Make this the preferred chart') + '"' +
            ' class="border rounded-lg p-3 cursor-pointer transition ' + (checked ? 'border-fb-primary/60 bg-fb-primary/5' : 'border-fb-border/40 hover:border-fb-border') + '">' +
            '<div class="flex items-start justify-between gap-2">' +
              '<div class="min-w-0">' +
                '<div class="text-sm text-fb-text truncate" title="' + esc(c.title) + '">' + esc(c.title) + '</div>' +
                '<div class="text-xs text-fb-textDim truncate">' + esc(meta) + ' · ' + acc + '</div>' +
                '<div class="text-[0.625rem] text-fb-textDim/60 truncate" title="' + esc(c.filename) + '">' + esc(c.filename) + '</div>' +
                (prefLabel ? '<div class="text-[0.625rem] font-semibold text-fb-primary mt-0.5">' + esc(prefLabel) + '</div>' : '') +
              '</div>' +
              '<button data-ch-play title="Play this chart" aria-label="Play this chart" class="shrink-0 w-8 h-8 rounded-full bg-fb-primary hover:bg-fb-primaryHi text-white text-sm leading-none">▶</button>' +
            '</div>' +
            '<div class="flex gap-2 mt-2">' +
              '<button data-ch-pl class="text-xs px-2 py-1 rounded border border-fb-border/50 text-fb-textDim hover:text-fb-text">＋ Playlist</button>' +
              // Split escape hatch (P5e, §7.1): "these aren't the same song".
              // Only offered while the work still has 2+ charts — splitting the
              // last member is meaningless. Undo lives in the split-out card's
              // ⋮ menu ("Rejoin other versions").
              (data.count >= 2
                ? '<button data-ch-split title="These aren\'t the same song — give this chart its own card" class="text-xs px-2 py-1 rounded border border-fb-border/50 text-fb-textDim hover:text-fb-accent hover:border-fb-accent/50">Split out</button>'
                : '') +
            '</div>' +
            '</div>';
    }

    // A preferred/auto flip can change which chart the grid's card stands for —
    // re-fetch the grid in place (scroll preserved; renderWindow refills from
    // the current scrollTop). The tree lists every chart flat, so it's
    // unaffected; rare curate action, so a full re-fetch is fine.
    function _groupChanged() {
        if (state.view === 'grid' && groupingActive()) loadGrid(true);
    }

    function _renderChartsDrawer(data, opts) {
        const els = _chartsDrawerEls();
        const dr = els.dr;
        const head = data.charts.find((c) => c.is_representative) || data.charts[0];
        // Mastery-anchor heads-up (§7.1): shown once, ambiently, right after a
        // switch — the headline may drop because history stays with each chart
        // (motor mastery is arrangement-specific). Text only, no toast/sound.
        const switchNote = (opts && opts.switched)
            ? '<div class="text-[0.6875rem] text-fb-primary/90 border border-fb-primary/30 rounded-md px-2 py-1.5">Practice history stays with each chart — your new pick starts from its own stats.</div>'
            : '';
        dr.innerHTML =
            '<div class="p-5 space-y-4">' +
              '<div class="flex items-start justify-between gap-2">' +
                '<div class="min-w-0">' +
                  '<h3 class="text-lg font-semibold text-fb-text truncate" title="' + esc(head.title) + '">' + esc(head.title) + '</h3>' +
                  '<div class="text-xs text-fb-textDim truncate">' + esc(head.artist) + ' · ' + data.count + ' chart' + (data.count === 1 ? '' : 's') + '</div>' +
                '</div>' +
                '<button data-charts-close aria-label="Close" class="text-fb-textDim hover:text-fb-text text-xl leading-none">✕</button>' +
              '</div>' +
              switchNote +
              '<div role="radiogroup" aria-label="Charts of this song" class="space-y-2">' +
                data.charts.map((c) => _chartRowHtml(c, data)).join('') +
              '</div>' +
              (data.preferred_source === 'user'
                ? '<button data-charts-auto class="w-full text-sm text-fb-textDim hover:text-fb-text border border-fb-border/50 rounded-md py-2">Reset to auto pick</button>'
                : '<div class="text-[0.6875rem] text-fb-textDim">Auto pick sticks with a chart you\'ve practised; otherwise most complete → newest. Tap a chart to pin your keeper.</div>') +
            '</div>';

        dr.querySelector('[data-charts-close]').addEventListener('click', closeChartsDrawer);
        dr.querySelector('[data-charts-auto]')?.addEventListener('click', async () => {
            const fresh = await jsend('DELETE', '/api/work/' + enc(data.work_key) + '/preferred');
            if (!fresh) return;
            _renderChartsDrawer(fresh);
            _groupChanged();
            dr.querySelector('[role="radio"][aria-checked="true"]')?.focus();
        });
        dr.querySelectorAll('[data-ch]').forEach((row) => {
            const fn = row.getAttribute('data-ch');
            const setPreferred = async () => {
                if (row.getAttribute('aria-checked') === 'true') return;   // already the keeper
                const fresh = await jsend('PUT', '/api/work/' + enc(data.work_key) + '/preferred', { filename: fn });
                if (!fresh) return;
                _renderChartsDrawer(fresh, { switched: true });
                _groupChanged();
                dr.querySelector('[role="radio"][aria-checked="true"]')?.focus();
            };
            row.addEventListener('click', setPreferred);
            row.addEventListener('keydown', (e) => {
                if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setPreferred(); }
            });
            row.querySelector('[data-ch-play]')?.addEventListener('click', (e) => {
                e.stopPropagation();
                closeChartsDrawer();
                _saveLibraryScrollSnapshot();
                if (window.playSong) window.playSong(enc(fn));
            });
            row.querySelector('[data-ch-pl]')?.addEventListener('click', (e) => {
                e.stopPropagation();
                addFilenamesToPlaylist([fn]);
            });
            row.querySelector('[data-ch-split]')?.addEventListener('click', async (e) => {
                e.stopPropagation();
                const ok = await jsend('POST', '/api/chart/' + enc(fn) + '/split');
                if (!ok) return;
                _groupChanged();
                // Re-read the ORIGINAL work — the split chart is gone from it
                // (now its own card in the grid; its ⋮ menu offers the rejoin).
                const fresh = await jget('/api/work/' + enc(data.work_key) + '/charts');
                if (fresh && Array.isArray(fresh.charts) && fresh.charts.length) _renderChartsDrawer(fresh);
                else closeChartsDrawer();
            });
        });
    }

    async function openChartsDrawer(workKey, _song) {
        if (!workKey) return;
        const data = await jget('/api/work/' + enc(workKey) + '/charts');
        if (!data || !Array.isArray(data.charts) || !data.charts.length) return;
        const els = _chartsDrawerEls();
        _chartsPrevFocus = document.activeElement;
        _renderChartsDrawer(data);
        els.ov.classList.remove('hidden');
        els.dr.classList.remove('translate-x-full');
        els.dr.querySelector('[role="radio"][aria-checked="true"]')?.focus();
    }

    function closeChartsDrawer() {
        document.getElementById('v3-charts-overlay')?.classList.add('hidden');
        document.getElementById('v3-charts-drawer')?.classList.add('translate-x-full');
        if (_chartsPrevFocus && typeof _chartsPrevFocus.focus === 'function' && _chartsPrevFocus.isConnected) {
            _chartsPrevFocus.focus();
        }
        _chartsPrevFocus = null;
    }

    // Global opener — the ⚑ chip routes through this, and other views/plugins
    // (P2's details drawer, dashboards) can open the drawer without reaching
    // into this module.
    window.__fbOpenChartsDrawer = openChartsDrawer;

    function wireCards(scope) {
        scope.querySelectorAll('[data-fn]').forEach((el) => {
            if (el.dataset.wired) return;   // don't double-bind on append/auto-fill
            el.dataset.wired = '1';
            const fn = el.getAttribute('data-fn');
            const song = state.songsById[fn] || { filename: fn };
            // §7.1: when a chart-intrinsic filter attached a display_chart,
            // the card SHOWS that member — so play actions target it too
            // (its arrangement indices match the rendered chips). Identity
            // actions (heart/save/playlist/menu registry) stay on the rep row.
            const playTarget = song.display_chart ? Object.assign({}, song, song.display_chart) : song;
            el.querySelectorAll('[data-v3-play]').forEach((pe) => pe.addEventListener('click', (e) => {
                if (state.selectMode) { e.preventDefault(); toggleSelect(fn, el); return; }
                playCard(playTarget);   // local → play; unsynced remote → sync then play
            }));
            el.querySelector('[data-menu]')?.addEventListener('click', (e) => { e.stopPropagation(); openCardMenu(el, song, e.currentTarget); });
            // Native right-click opens the same overflow menu at the pointer.
            el.addEventListener('contextmenu', (e) => { e.preventDefault(); openCardMenu(el, song, null, { x: e.clientX, y: e.clientY }); });
            el.querySelectorAll('[data-arr]').forEach((ab) => ab.addEventListener('click', (e) => {
                e.stopPropagation();
                const idx = ab.getAttribute('data-arr');
                playCard(playTarget, idx === '' ? undefined : Number(idx));
            }));
            // ⚑ charts chip → the Charts drawer (P5d). Never a card play — the
            // chip row sits outside [data-v3-play]; stopPropagation is
            // belt-and-braces.
            el.querySelector('[data-charts]')?.addEventListener('click', (e) => {
                e.stopPropagation();
                openChartsDrawer(e.currentTarget.getAttribute('data-charts'), song);
            });
            el.querySelector('[data-fav]')?.addEventListener('click', async (e) => {
                e.stopPropagation();
                const btn = e.currentTarget;
                try {
                    const r = await fetch('/api/favorites/toggle', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ filename: fn }) });
                    const d = await r.json();
                    btn.textContent = d.favorite ? '♥' : '♡';
                    btn.setAttribute('aria-pressed', d.favorite ? 'true' : 'false');
                    // Swap exactly the idle colour this button was rendered with
                    // (grid = text-white, tree/List view = text-fb-textDim). The old
                    // hardcoded text-white toggle never removed the list view's
                    // text-fb-textDim, so the heart changed glyph but stayed dim
                    // (never turned red) until a re-search re-rendered the row.
                    const idle = btn.getAttribute('data-fav-idle') || 'text-white';
                    btn.classList.toggle('text-fb-accent', d.favorite);
                    btn.classList.toggle(idle, !d.favorite);
                    song.favorite = d.favorite;   // keep the model in sync for a re-render/recycle
                } catch (err) { /* */ }
            });
            el.querySelector('[data-save]')?.addEventListener('click', async (e) => {
                e.stopPropagation();
                if (window.v3Saved) { const saved = await window.v3Saved.toggle(fn); e.currentTarget.classList.toggle('text-fb-primary', !!saved); }
            });
            // Inline/overlay plugin card actions → run via the shared registry.
            el.querySelectorAll('[data-act-card]').forEach((ab) => ab.addEventListener('click', async (e) => {
                e.stopPropagation();
                const reg = sm && sm.libraryCardActions;
                if (reg) await reg.run(ab.getAttribute('data-act-card'), song, { source: 'v3-songs' });
            }));
        });
    }

    // ── Multi-select + batch actions ──────────────────────────────────────--
    function toggleSelect(fn, el) {
        if (state.selected.has(fn)) state.selected.delete(fn); else state.selected.add(fn);
        const on = state.selected.has(fn);
        const cb = el.querySelector('[data-select]'); if (cb) cb.checked = on;
        el.querySelector('[data-v3-play]')?.classList.toggle('ring-2', on);
        el.querySelector('[data-v3-play]')?.classList.toggle('ring-fb-primary', on);
        renderBatchBar();
    }

    function setSelectMode(on) {
        state.selectMode = on;
        if (!on) state.selected.clear();
        const btn = document.getElementById('v3-songs-select');
        if (btn) btn.className = btnCtrl + (on ? ' bg-fb-primary text-white' : '');
        reload();           // re-render cards with/without checkboxes
        renderBatchBar();
    }

    function renderBatchBar() {
        let bar = document.getElementById('v3-songs-batch');
        if (!state.selectMode || state.selected.size === 0) { if (bar) bar.remove(); return; }
        if (!bar) {
            bar = document.createElement('div');
            bar.id = 'v3-songs-batch';
            bar.className = 'fixed bottom-4 left-1/2 -translate-x-1/2 z-40 flex items-center gap-3 bg-fb-card border border-fb-border/60 rounded-full shadow-xl px-4 py-2';
            document.body.appendChild(bar);
        }
        bar.innerHTML =
            '<span class="text-sm text-fb-text">' + state.selected.size + ' selected</span>' +
            '<button data-batch="playlist" class="text-sm bg-fb-primary hover:bg-fb-primaryHi text-white px-3 py-1 rounded-full">Add to playlist</button>' +
            '<button data-batch="details" class="text-sm bg-fb-card/60 hover:bg-fb-card border border-fb-border/50 text-fb-text px-3 py-1 rounded-full">Edit details</button>' +
            '<button data-batch="saved" class="text-sm bg-fb-card/60 hover:bg-fb-card border border-fb-border/50 text-fb-text px-3 py-1 rounded-full">Save for Later</button>' +
            '<button data-batch="clear" class="text-sm text-fb-textDim hover:text-fb-text px-2">Clear</button>';
        bar.querySelector('[data-batch="clear"]').addEventListener('click', () => { state.selected.clear(); reload(); renderBatchBar(); });
        bar.querySelector('[data-batch="saved"]').addEventListener('click', batchSave);
        bar.querySelector('[data-batch="playlist"]').addEventListener('click', batchAddToPlaylist);
        bar.querySelector('[data-batch="details"]').addEventListener('click', openBulkEdit);
    }

    async function batchSave() {
        const lists = (await jget('/api/playlists')) || [];
        const saved = lists.find((p) => p.system_key === 'saved_for_later');
        let present = new Set();
        if (saved) { const pl = await jget('/api/playlists/' + saved.id); present = new Set(((pl && pl.songs) || []).map((s) => s.filename)); }
        // Additive: only toggle (add) songs not already saved.
        for (const fn of state.selected) {
            if (!present.has(fn)) {
                try { await fetch('/api/saved/toggle', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ filename: fn }) }); } catch (e) { /* */ }
            }
        }
        finishBatch();
    }

    // Modern "Add to playlist" picker - replaces the old run-on numbered prompt
    // ("1. Foo  2. Bar ...", which didn't scale past a couple of playlists). Shows a
    // checkbox list of playlists with membership PRE-CHECK (a song already in a
    // playlist shows checked; a multi-song selection shows the indeterminate box
    // when only some are in), an inline "New playlist" row, and a search box once
    // the list is long. Toggling a row adds/removes the given songs via the
    // existing REST; only rows the user actually TOUCHED are changed. Resolves
    // true if any change was applied, else null (cancelled / no-op). Shared by the
    // per-card more-menu and the select-mode batch bar.
    function openPlaylistPicker(fns) {
        return new Promise((resolve) => { (async () => {
            const lists = ((await jget('/api/playlists')) || []).filter((p) => !p.system_key);
            // Pre-check membership: fetch each playlist's songs once (playlists are
            // few, and this is a one-off on open, not a hot path). ALL selected in
            // -> checked; SOME -> indeterminate.
            const counts = await Promise.all(lists.map(async (p) => {
                const pl = await jget('/api/playlists/' + p.id);
                const has = new Set(((pl && pl.songs) || []).map((s) => s.filename));
                return fns.reduce((n, fn) => n + (has.has(fn) ? 1 : 0), 0);
            }));
            const rows = lists.map((p, i) => ({
                id: p.id, name: p.name, count: p.count || 0,
                initial: counts[i] === fns.length ? 'all' : (counts[i] > 0 ? 'some' : 'none'),
                checked: counts[i] === fns.length, touched: false,
            }));

            const overlay = document.createElement('div');
            overlay.className = 'fixed inset-0 z-[200] bg-black/60 backdrop-blur-sm flex items-center justify-center p-4';
            let query = '';
            const onKey = (e) => { if (e.key === 'Escape') { e.preventDefault(); done(null); } };
            function done(applied) { overlay.remove(); document.removeEventListener('keydown', onKey); resolve(applied || null); }
            document.addEventListener('keydown', onKey);
            overlay.addEventListener('click', (e) => { if (e.target === overlay) done(null); });

            const boxFor = (r) => r.touched ? (r.checked ? '☑' : '☐')
                : (r.initial === 'all' ? '☑' : r.initial === 'some' ? '▣' : '☐');
            function rowHtml(r) {
                return '<button type="button" data-pl="' + esc(String(r.id)) + '" class="w-full flex items-center gap-3 px-3 py-2 rounded-md hover:bg-white/5 text-left">' +
                    '<span class="text-lg leading-none w-5 text-fb-primary">' + boxFor(r) + '</span>' +
                    '<span class="flex-1 truncate text-sm text-fb-text">' + esc(r.name) + '</span>' +
                    '<span class="text-xs text-fb-textDim">' + (r.count || 0) + '</span></button>';
            }
            function listHtml() {
                const q = query.trim().toLowerCase();
                const shown = q ? rows.filter((r) => r.name.toLowerCase().includes(q)) : rows;
                if (!shown.length) return '<p class="text-sm text-fb-textDim text-center py-6">' + (rows.length ? 'No matches.' : 'No playlists yet - create one above.') + '</p>';
                return shown.map(rowHtml).join('');
            }
            function bindRows() {
                overlay.querySelectorAll('[data-pl]').forEach((b) => b.addEventListener('click', () => {
                    const r = rows.find((x) => String(x.id) === b.getAttribute('data-pl'));
                    if (!r) return;
                    r.touched = true; r.checked = !r.checked;
                    repaintList();
                }));
            }
            function repaintList() { const el = overlay.querySelector('[data-list]'); if (el) { el.innerHTML = listHtml(); bindRows(); } }
            async function createNew() {
                const inp = overlay.querySelector('[data-new]');
                const name = ((inp && inp.value) || '').trim();
                if (!name) return;
                const created = await jsend('POST', '/api/playlists', { name });
                if (created && created.id) {
                    rows.unshift({ id: created.id, name: created.name || name, count: 0, initial: 'none', checked: true, touched: true });
                    query = ''; paint();
                    overlay.querySelector('[data-new]')?.focus();
                }
            }
            async function apply() {
                // Act only where the final state differs from what's already stored.
                const acts = rows.filter((r) => r.touched && ((r.checked && r.initial !== 'all') || (!r.checked && r.initial !== 'none')));
                for (const r of acts) {
                    for (const fn of fns) {
                        try {
                            if (r.checked) await fetch('/api/playlists/' + r.id + '/songs', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ filename: fn }) });
                            else await fetch('/api/playlists/' + r.id + '/songs/' + encodeURIComponent(fn), { method: 'DELETE' });
                        } catch (e) { /* */ }
                    }
                }
                if (window.v3Playlists) { try { window.v3Playlists.refresh(); } catch (e) { /* */ } }
                if (acts.length && window.fbNotify) {
                    try { window.fbNotify.show({ title: 'Playlists updated', message: 'Updated ' + acts.length + ' playlist' + (acts.length === 1 ? '' : 's'), icon: '🎵' }); } catch (e) { /* */ }
                }
                done(acts.length ? true : null);
            }
            function paint() {
                overlay.innerHTML =
                    '<div class="bg-fb-card rounded-xl border border-fb-border/50 w-full max-w-md p-5 space-y-4" role="dialog" aria-label="Add to playlist">' +
                    '<div class="flex items-center justify-between"><h3 class="text-lg font-semibold text-fb-text">Add ' + fns.length + ' song' + (fns.length === 1 ? '' : 's') + ' to playlist</h3>' +
                    '<button type="button" data-x class="text-fb-textDim hover:text-fb-text text-xl leading-none">✕</button></div>' +
                    '<div class="flex gap-2"><input data-new type="text" placeholder="+ New playlist name" class="' + btnCtrl + ' flex-1"><button type="button" data-create class="bg-fb-card/60 hover:bg-fb-card border border-fb-border/50 text-fb-text px-3 rounded-md text-sm">Create</button></div>' +
                    (rows.length > 8 ? '<input data-search type="text" placeholder="Search playlists..." class="' + btnCtrl + ' w-full" value="' + esc(query) + '">' : '') +
                    '<div data-list class="max-h-72 overflow-y-auto v3-scroll -mx-1 px-1">' + listHtml() + '</div>' +
                    '<div class="flex justify-end"><button type="button" data-done class="bg-fb-primary hover:bg-fb-primaryHi text-white text-sm font-medium px-5 py-2 rounded-md">Done</button></div>' +
                    '</div>';
                overlay.querySelector('[data-x]').addEventListener('click', () => done(null));
                overlay.querySelector('[data-done]').addEventListener('click', apply);
                overlay.querySelector('[data-create]').addEventListener('click', createNew);
                overlay.querySelector('[data-new]').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); createNew(); } });
                const s = overlay.querySelector('[data-search]');
                if (s) s.addEventListener('input', (e) => { query = e.target.value; repaintList(); });
                bindRows();
            }

            document.body.appendChild(overlay);
            paint();
            (overlay.querySelector('[data-search]') || overlay.querySelector('[data-new]'))?.focus();
        })(); });
    }

    // Open the picker for the given song filenames. Shared by the select-mode
    // batch bar and the per-card more-menu. Resolves truthy if a change was applied.
    async function addFilenamesToPlaylist(filenames) {
        const fns = Array.from(filenames || []);
        if (!fns.length) return null;
        return openPlaylistPicker(fns);
    }

    async function batchAddToPlaylist() {
        const pid = await addFilenamesToPlaylist(state.selected);
        // Only tear down the multi-select when the add actually happened. A
        // cancelled or failed picker returns null — preserve the selection (and
        // skip the reload) so the user can retry, matching the pre-refactor
        // behaviour where !ans / !pid returned early before finishBatch().
        if (pid) finishBatch();
    }

    function finishBatch() {
        state.selected.clear();
        if (window.v3Playlists) { try { window.v3Playlists.refresh(); window.v3Playlists.refreshSaved(); } catch (e) { /* */ } }
        reload(); renderBatchBar();
    }

    // Bulk personal-meta editor (P2) — apply-to-all over the current selection via
    // the batch endpoint (one request). Additive + mixed-state safe: difficulty
    // defaults to "Leave" (each song keeps its own value); tags ADD/REMOVE rather
    // than replace, so a bulk action never silently wipes per-song data. Notes are
    // inherently per-song, so they're deliberately not bulk-editable.
    function openBulkEdit() {
        const fns = [...state.selected];
        if (!fns.length) return;
        // Tags present across the selection (from the embedded row payload) → one-tap
        // removable chips, no extra fetch.
        const present = new Set();
        fns.forEach((fn) => ((state.songsById[fn] && state.songsById[fn].tags) || []).forEach((t) => present.add(t)));
        const bulk = { diff: 'keep', add: [], remove: new Set() };
        const norm = (raw) => String(raw || '').trim().toLowerCase().replace(/\s+/g, ' ').slice(0, 60);

        const overlay = document.createElement('div');
        overlay.className = 'fixed inset-0 z-[200] bg-black/60 backdrop-blur-sm flex items-center justify-center p-4';
        const onKey = (e) => { if (e.key === 'Escape') { e.preventDefault(); done(); } };
        function done() { overlay.remove(); document.removeEventListener('keydown', onKey); }
        document.addEventListener('keydown', onKey);
        overlay.addEventListener('click', (e) => { if (e.target === overlay) done(); });
        document.body.appendChild(overlay);

        function render() {
            const diffBtn = (val, label) =>
                '<button data-bd="' + val + '" class="px-2 h-8 rounded-md text-sm border ' +
                (String(bulk.diff) === String(val) ? 'bg-fb-primary text-white border-fb-primary' : 'bg-gray-800/50 text-fb-textDim border-gray-700 hover:text-fb-text') + '">' + label + '</button>';
            const addChips = bulk.add.map((t) => '<span class="inline-flex items-center gap-1 bg-fb-primary/20 text-fb-text border border-fb-primary/40 text-xs px-2 py-0.5 rounded-full">' + esc(t) +
                '<button data-badd-rm="' + esc(t) + '" aria-label="Remove ' + esc(t) + '" class="text-fb-textDim hover:text-fb-accent leading-none">×</button></span>').join('');
            const rmChips = [...present].sort((a, b) => a.localeCompare(b)).map((t) =>
                '<button data-brm="' + esc(t) + '" class="text-xs px-2 py-0.5 rounded-full border ' +
                (bulk.remove.has(t) ? 'bg-fb-low/30 text-fb-low border-fb-low/40 line-through' : 'bg-gray-800/50 text-fb-textDim border-gray-700 hover:text-fb-text') + '">' + esc(t) + '</button>').join('');
            const nothing = bulk.diff === 'keep' && !bulk.add.length && !bulk.remove.size;
            overlay.innerHTML =
                '<div class="bg-fb-sidebar border border-fb-border/60 rounded-2xl w-full max-w-sm shadow-2xl max-h-[85vh] overflow-y-auto v3-scroll">' +
                '<div class="p-5 space-y-4">' +
                '<div class="flex items-center justify-between"><h3 class="text-base font-semibold text-fb-text">Edit ' + fns.length + ' songs</h3>' +
                '<button data-bulk-x aria-label="Close" class="text-fb-textDim hover:text-fb-text text-xl leading-none">✕</button></div>' +

                '<div><div class="text-xs text-fb-textDim mb-1">Difficulty (for you)</div>' +
                '<div class="flex flex-wrap gap-1 items-center">' + diffBtn('keep', 'Leave') + diffBtn(1, '1') + diffBtn(2, '2') + diffBtn(3, '3') + diffBtn(4, '4') + diffBtn(5, '5') + diffBtn('clear', 'Clear') + '</div>' +
                '<div class="text-[0.6875rem] text-fb-textDim mt-1">"Leave" keeps each song&#39;s own value; a number or Clear applies to all ' + fns.length + '.</div></div>' +

                '<div><div class="text-xs text-fb-textDim mb-1">Add tags to all</div>' +
                '<div class="flex flex-wrap gap-1 mb-2">' + (addChips || '<span class="text-xs text-fb-textDim">None</span>') + '</div>' +
                '<div class="flex gap-1"><input type="text" data-badd-input placeholder="Add a tag…" class="flex-1 bg-fb-card border border-fb-border/60 rounded-lg px-3 py-1.5 text-sm text-fb-text outline-none focus:border-fb-primary/60">' +
                '<button data-badd-btn class="text-sm px-3 rounded-lg bg-fb-card/60 border border-fb-border/50 text-fb-text hover:bg-fb-card">Add</button></div></div>' +

                (present.size ? '<div><div class="text-xs text-fb-textDim mb-1">Remove tags (present in the selection)</div><div class="flex flex-wrap gap-1">' + rmChips + '</div></div>' : '') +

                '<div class="flex gap-2 pt-1"><button data-bulk-apply ' + (nothing ? 'disabled' : '') + ' class="flex-1 px-4 py-2 rounded-xl text-sm font-semibold ' +
                (nothing ? 'bg-fb-card/50 text-fb-textDim cursor-not-allowed' : 'bg-fb-primary hover:bg-fb-primaryHi text-white') + '">Apply</button>' +
                '<button data-bulk-x class="px-4 py-2 bg-fb-card/60 hover:bg-fb-card border border-fb-border/50 rounded-xl text-sm text-fb-text">Cancel</button></div>' +
                '</div></div>';

            overlay.querySelectorAll('[data-bulk-x]').forEach((b) => b.addEventListener('click', done));
            overlay.querySelectorAll('[data-bd]').forEach((b) => b.addEventListener('click', () => { bulk.diff = b.getAttribute('data-bd'); render(); }));
            overlay.querySelectorAll('[data-badd-rm]').forEach((b) => b.addEventListener('click', () => { const t = b.getAttribute('data-badd-rm'); const i = bulk.add.indexOf(t); if (i >= 0) bulk.add.splice(i, 1); render(); }));
            overlay.querySelectorAll('[data-brm]').forEach((b) => b.addEventListener('click', () => { const t = b.getAttribute('data-brm'); if (bulk.remove.has(t)) bulk.remove.delete(t); else bulk.remove.add(t); render(); }));
            const addInput = overlay.querySelector('[data-badd-input]');
            const addTag = () => { const t = norm(addInput && addInput.value); if (t && !bulk.add.includes(t)) { bulk.add.push(t); render(); overlay.querySelector('[data-badd-input]')?.focus(); } };
            overlay.querySelector('[data-badd-btn]')?.addEventListener('click', addTag);
            addInput?.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); addTag(); } });
            overlay.querySelector('[data-bulk-apply]')?.addEventListener('click', applyBulk);
        }

        async function applyBulk() {
            const body = { filenames: fns };
            if (bulk.diff === 'clear') body.set_difficulty = null;
            else if (bulk.diff !== 'keep') body.set_difficulty = Number(bulk.diff);
            if (bulk.add.length) body.add_tags = bulk.add;
            if (bulk.remove.size) body.remove_tags = [...bulk.remove];
            if (!('set_difficulty' in body) && !body.add_tags && !body.remove_tags) { done(); return; }
            // jsend returns null on HTTP error / network failure — don't tear down the
            // selection or reload as if it worked. Surface the failure and let the user retry.
            const res = await jsend('POST', '/api/songs/user-meta/batch', body);
            if (!res) {
                if (window.fbNotify) { try { window.fbNotify.show({ title: 'Bulk edit failed', message: 'Could not save your changes. Please try again.', icon: '⚠️', accent: '#EF4444' }); } catch (e) { /* */ } }
                return;
            }
            done();
            finishBatch();
        }

        render();
        overlay.querySelector('[data-badd-input]')?.focus();
    }

    async function jsend(method, url, body) {
        try { const r = await fetch(url, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }); return r.ok ? r.json() : null; } catch (e) { return null; }
    }

    // ── Grid (windowed / recycled — #636 item 3 stage 2) ───────────────────--
    // Only the visible cards (± OVERSCAN_ROWS) live in the DOM; a sizer element
    // sized to the FULL library gives the scrollbar its geometry. state.songs is
    // a sparse array indexed by absolute position; ensureWindow() fetches the
    // pages a window needs (keyset forward fast-path, else OFFSET random-access),
    // and renderWindow() paints the slice the current scrollTop maps to.

    // Live count of cards actually in the DOM — bounded under windowing, so it's
    // the bounded-DOM invariant the tests assert (NOT a "loaded so far" signal).
    function loadedCount() { return document.querySelectorAll('#v3-songs-grid [data-fn]').length; }

    // The scroll listener lives on the SHARED #v3-main container, so guard every
    // render entry point on the Songs screen actually being active — otherwise
    // scrolling another screen would keep rendering into the hidden grid after
    // Songs has been visited once.
    function songsActive() { const el = document.getElementById('v3-songs'); return !!el && el.classList.contains('active'); }

    function _gridEl() { return document.getElementById('v3-songs-grid'); }
    function _sizerEl() { return document.getElementById('v3-songs-gridsizer'); }

    // Measure columns + row pitch from the LIVE grid: cols from the computed
    // grid-template-columns (tracks resolve to explicit pixel sizes), rowH from a
    // rendered card's box + the grid row-gap. Cards are uniform height (aspect-
    // square art + truncated text + the fixed-height .v3-card-chips row), so one
    // measured card sizes every row. Falls back to a coarse estimate until the
    // first card exists, then re-measures.
    function measureGeom() {
        const grid = _gridEl();
        if (!grid) return state.geom || { cols: 2, rowH: 240, gap: 16 };
        const cs = getComputedStyle(grid);
        const tracks = (cs.gridTemplateColumns || '').trim();
        const cols = (tracks && tracks !== 'none')
            ? Math.max(1, tracks.split(/\s+/).length)
            : (state.geom ? state.geom.cols : 2);
        const gap = parseFloat(cs.rowGap) || 0;
        let rowH = state.geom && state.geom.rowH;
        const card = grid.querySelector('[data-fn]') || grid.querySelector('.v3-card-skel');
        if (card) { const h = card.getBoundingClientRect().height; if (h > 0) rowH = h + gap; }
        if (!rowH || rowH <= 0) rowH = 240 + gap;   // estimate until a card is measured
        state.geom = { cols, rowH, gap };
        return state.geom;
    }

    // The sizer's top edge measured in the scroller's content coordinate space
    // (accounts for the practice-home block above it, sticky toolbar, etc.).
    function _sizerTopInScroller(main, sizer) {
        return sizer.getBoundingClientRect().top - main.getBoundingClientRect().top + main.scrollTop;
    }

    function _windowHasHoles(start, end) {
        for (let i = start; i < end; i++) if (state.songs[i] === undefined) return true;
        return false;
    }

    // A placeholder card with the SAME vertical structure (and therefore height)
    // as a real card, shown only if a window's fetch hasn't landed yet. No
    // [data-fn] → wireCards / repaintAccuracy skip it.
    function _skeletonCard() {
        return '<div class="v3-card-skel" aria-hidden="true">' +
            '<div class="relative aspect-square rounded-lg overflow-hidden bg-fb-card animate-pulse"></div>' +
            '<div class="mt-1 text-sm text-transparent truncate">·</div>' +
            '<div class="text-xs text-transparent truncate">·</div>' +
            '<div class="v3-card-chips flex gap-1 mt-1"></div>' +
            '</div>';
    }

    function _renderCardsRange(start, end) {
        let html = '';
        for (let i = start; i < end; i++) {
            const s = state.songs[i];
            html += s ? songCard(s) : _skeletonCard();
        }
        return html;
    }

    // Fetch a single OFFSET page into the sparse store. Uses the stage-1 keyset
    // cursor when the previous page is already loaded (cheap forward scroll);
    // otherwise OFFSET page= for random access (jumps, restore, non-keyset
    // providers). Records the returned next_cursor so a later contiguous page can
    // chain off it. Returns a promise that callers AWAIT (so ensureWindow never
    // returns with a hole still in flight); concurrent requests for the same page
    // share the one promise. An `epoch` captured at launch guards against a reset
    // (provider/sort/filter change) landing mid-fetch and writing stale rows into
    // the new dataset.
    function _loadPage(p) {
        if (p < 0 || state.songs[p * PAGE_SIZE] !== undefined) return Promise.resolve();
        if (state.pageProms[p]) return state.pageProms[p];
        const epoch = state.epoch;
        const prom = (async () => {
            const extra = { size: PAGE_SIZE };
            if (groupingActive()) extra.group = 1;
            const prevCursor = state.keysetOk ? state.pageCursors[p - 1] : null;
            if (prevCursor) extra.after = prevCursor; else extra.page = p;
            const data = await jget('/api/library?' + queryParams(extra).toString());
            if (state.epoch !== epoch || !data) return;   // reset mid-fetch → discard stale
            state.total = data.total || 0;
            if (typeof data.next_cursor !== 'undefined') {
                state.pageCursors[p] = data.next_cursor;
                if (p === 0) state.keysetOk = !!data.next_cursor;
            }
            const base = p * PAGE_SIZE;
            (data.songs || []).forEach((s, i) => {
                state.songs[base + i] = s;
                state.songsById[cardKey(s)] = s;
            });
        })();
        state.pageProms[p] = prom;
        prom.finally(() => { if (state.pageProms[p] === prom) delete state.pageProms[p]; });
        return prom;
    }

    // Ensure every absolute index in [start, end) is loaded (fetch — or await an
    // in-flight fetch of — the covering pages). Pages resolve in order so the
    // keyset fast-path can chain off the previous page's cursor.
    async function ensureWindow(start, end) {
        if (end <= start) return;
        const p0 = Math.floor(start / PAGE_SIZE);
        const p1 = Math.floor((end - 1) / PAGE_SIZE);
        for (let p = p0; p <= p1; p++) {
            if (state.songs[p * PAGE_SIZE] === undefined) await _loadPage(p);
        }
    }

    let _winRAF = 0;
    function requestWindowRender() {
        if (_winRAF) return;
        _winRAF = requestAnimationFrame(() => { _winRAF = 0; renderWindow(); });
    }

    // Paint the slice of cards the current scrollTop maps to. Sizes the sizer to
    // the full library, computes the visible row range (± overscan), fetches any
    // missing pages, then swaps the grid's innerHTML to just that slice. A token
    // guards against an out-of-order fetch repainting a window the user scrolled
    // past.
    let _winToken = 0;
    async function renderWindow() {
        if (state.view !== 'grid' || !songsActive()) return;
        const grid = _gridEl(), sizer = _sizerEl(), main = document.getElementById('v3-main');
        if (!grid || !sizer || !main) return;
        const { cols, rowH } = measureGeom();
        const total = state.total || 0;
        const rows = Math.ceil(total / Math.max(1, cols));
        sizer.style.height = (rows * rowH) + 'px';
        if (total === 0) {
            grid.innerHTML = ''; grid.style.top = '0px';
            state.winRange = { start: 0, end: 0 };
            return;
        }
        const sizerTop = _sizerTopInScroller(main, sizer);
        const viewTop = Math.max(0, main.scrollTop - sizerTop);
        const viewBottom = viewTop + main.clientHeight;
        const firstRow = Math.max(0, Math.floor(viewTop / rowH) - OVERSCAN_ROWS);
        const lastRow = Math.min(rows - 1, Math.ceil(viewBottom / rowH) + OVERSCAN_ROWS);
        const start = firstRow * cols;
        const end = Math.min(total, (lastRow + 1) * cols);
        // Re-render when the range changed, a card is missing, OR select mode
        // toggled since the window was last painted (so checkboxes/rings on cached
        // cards track state — e.g. after leaving Songs in select mode and back).
        const same = state.winRange && state.winRange.start === start && state.winRange.end === end
            && state.renderedSelectMode === state.selectMode;
        if (same && !_windowHasHoles(start, end)) return;
        const myToken = ++_winToken;
        if (_windowHasHoles(start, end)) {
            await ensureWindow(start, end);
            if (_winToken !== myToken || state.view !== 'grid') return;   // superseded
        }
        if (_closeCardMenu) _closeCardMenu();   // its DOM is about to be replaced
        grid.style.top = (firstRow * rowH) + 'px';
        grid.innerHTML = _renderCardsRange(start, end);
        wireCards(grid);
        decorateTuningChips(grid);   // colour tuning chips by working-tuning match (async, feature-detected)
        state.winRange = { start, end };
        state.renderedSelectMode = state.selectMode;
        if (sm && typeof sm.emit === 'function') {
            try { sm.emit('v3:library-window-rendered', { start, end, total }); } catch (e) { /* */ }
        }
    }

    // Reset/initial load of the grid. Clears the sparse store, fetches page 0
    // (which establishes state.total + whether the keyset fast-path is available),
    // then renders the window twice — the first render lays a real card so the
    // second can measure the true row height and settle the window size.
    async function loadGrid(reset) {
        // A reset requested mid-fetch (provider/sort/filter/search change) must
        // not be dropped — remember it and re-run once the in-flight load returns.
        if (state.loading) { if (reset) state.pendingReset = true; return; }
        const grid = _gridEl();
        if (!grid) return;
        if (reset) {
            if (_closeCardMenu) _closeCardMenu();
            state.epoch++;            // invalidate any in-flight page fetch from the old query
            state.songs = [];
            state.pageCursors = {};
            state.pageProms = {};
            state.keysetOk = false;
            state.winRange = null;
            state.renderedSelectMode = null;
            state.geom = null;
            state.total = 0;
            grid.innerHTML = '';
            grid.style.top = '0px';
            const sizer = _sizerEl();
            if (sizer) sizer.style.height = '0px';
        }
        state.loading = true;
        await _loadPage(0);
        state.loading = false;
        if (state.pendingReset) { state.pendingReset = false; return loadGrid(true); }
        const countEl = document.getElementById('v3-songs-count');
        if (countEl) countEl.textContent = state.total + ' song' + (state.total === 1 ? '' : 's');
        // The sentinel no longer drives loading (the sizer reserves full height);
        // keep the node for coexistence but it has no visible role.
        const sentinel = document.getElementById('v3-songs-sentinel');
        if (sentinel) sentinel.style.display = 'none';
        await renderWindow();   // first paint (rowH from estimate)
        await renderWindow();   // re-measure rowH from a real card, settle the window
    }

    // A scroll on #v3-main re-renders the window (rAF-coalesced). No more
    // near-bottom paging trigger — the visible range alone decides what's shown.
    function bindScroll() {
        const main = document.getElementById('v3-main');
        if (!main || state.scrollBound) return;
        state.scrollBound = true;
        main.addEventListener('scroll', () => {
            if (state.view !== 'grid') return;
            requestWindowRender();
        }, { passive: true });
    }

    // Re-measure + re-render when the scroller's WIDTH changes (column count and
    // the aspect-square art height both track width). Height-only changes just
    // need a re-render to widen/narrow the visible window.
    function bindGridResize() {
        if (state.gridResizeBound) return;
        const main = document.getElementById('v3-main');
        if (!main || typeof ResizeObserver !== 'function') return;
        state.gridResizeBound = true;
        let lastW = main.clientWidth;
        new ResizeObserver(() => {
            if (state.view !== 'grid') return;
            const w = main.clientWidth;
            if (w !== lastW) { lastW = w; state.geom = null; }   // force re-measure
            requestWindowRender();
        }).observe(main);
    }

    // ── A–Z jump rail interaction ─────────────────────────────────────────────
    // With the windowed grid the rail seeks DIRECTLY: sort_letters gives the
    // per-bucket song counts, so the first card of a letter is at the cumulative
    // count of the buckets before it — convert that index to a scrollTop and let
    // the scroll handler render+fetch the destination window (O(1), no page-
    // through). The rail only offers letters the server reports present for the
    // active sort+filter, so a tap always lands on a real card. (A legacy provider
    // lacking sort_letters falls back to a bounded forward scan.)
    function railEl() { return document.getElementById('v3-songs-azrail'); }
    function railBubbleEl() { return document.getElementById('v3-songs-azbubble'); }
    function railVisible() { return state.view === 'grid' && !!railSortColumn(); }

    let _railToken = 0;
    async function refreshRail() {
        const rail = railEl();
        if (!rail) return;
        if (!railVisible()) { rail.classList.add('hidden'); railBubbleEl()?.classList.add('hidden'); return; }
        const col = railSortColumn();
        // A newer refresh (sort/filter/search/provider change) supersedes this
        // one — a slow stats response must not repaint a rail the grid moved on.
        const myToken = ++_railToken;
        // Present letters for the active sort+filter (filter-synced; counts
        // songs). `sort_letters=1` opts into the active-sort breakdown so the
        // dashboard / v2 tree (which read only `letters`) skip the extra query.
        // group must MATCH the grid's page fetches (see groupingActive) so the
        // rail's per-letter counts sum to the same works total the sizer uses.
        const railParams = { sort_letters: 1 };
        if (groupingActive()) railParams.group = 1;
        const stats = await jget('/api/library/stats?' + queryParams(railParams).toString());
        if (_railToken !== myToken || !railVisible()) {                 // changed mid-fetch
            if (_railToken === myToken) rail.classList.add('hidden');
            return;
        }
        // Prefer the active-sort breakdown. `letters` is the artist distinct-
        // count, so it only matches the cards on an artist sort; a legacy/third-
        // party provider that predates `sort_letters` returns none, in which
        // case a title sort would advertise wrong letters — hide the rail then.
        let letters = stats && stats.sort_letters;
        // sort_letters counts SONGS per bucket of the active sort column — exactly
        // the cumulative the windowed jump needs to seek to a row index. The
        // `letters` fallback is a distinct-ARTIST count (legacy provider without
        // sort_letters, artist sort only), which can't drive a precise seek — flag
        // it so jumpToLetter does a bounded scan instead of trusting the math.
        const songCounts = !!(stats && stats.sort_letters);
        if (!letters) {
            if (col === 'artist') letters = (stats && stats.letters) || {};
            else { rail.classList.add('hidden'); railBubbleEl()?.classList.add('hidden'); return; }
        }
        state.railLetters = letters;
        state.railLettersAreSongCounts = songCounts;
        // No present letters (empty or fully-filtered grid) → nothing to jump
        // to; hide the rail instead of rendering a column of disabled buttons.
        if (!Object.keys(letters).length) { rail.classList.add('hidden'); railBubbleEl()?.classList.add('hidden'); return; }
        const desc = state.sort.endsWith('-desc');
        const order = desc ? RAIL_BUCKETS.slice().reverse() : RAIL_BUCKETS;
        // Roving tabindex: only the first present letter is in the tab order;
        // the rest are reached with the arrow keys (see bindRailOnce). Avoids
        // dumping up to 27 tab stops into the page.
        let firstPresent = true;
        rail.innerHTML = order.map((L) => {
            const n = letters[L] || 0;
            const present = n > 0;
            const tabbable = present && firstPresent;
            if (tabbable) firstPresent = false;
            const name = L === '#' ? 'non-alphabetical' : L;
            return '<button type="button" class="v3-azrail-letter" data-letter="' + esc(L) + '"'
                + (present ? '' : ' disabled') + ' tabindex="' + (tabbable ? '0' : '-1') + '"'
                + ' aria-label="Jump to ' + esc(name) + (present ? ', ' + n + ' song' + (n === 1 ? '' : 's') : ' (none)') + '">'
                + esc(L) + '</button>';
        }).join('');
        rail.classList.remove('hidden');
        bindRailOnce();
    }

    function _setRailActive(letter) {
        railEl()?.querySelectorAll('.v3-azrail-letter').forEach((b) => {
            b.classList.toggle('is-active', b.getAttribute('data-letter') === letter);
        });
    }
    function _showBubble(letter) { const b = railBubbleEl(); if (b) { b.textContent = letter; b.classList.remove('hidden'); } }
    function _hideBubble() { railBubbleEl()?.classList.add('hidden'); }

    // The absolute index of the first card in a bucket, from the sort_letters
    // song-counts: sum the counts of every bucket ordered before it. O(1) — no
    // page-through. Returns null when we don't have true song-counts (the legacy
    // distinct-artist fallback), so the caller can scan instead.
    function _letterStartIndex(letter) {
        if (!state.railLettersAreSongCounts) return null;
        const letters = state.railLetters || {};
        const desc = state.sort.endsWith('-desc');
        const order = desc ? RAIL_BUCKETS.slice().reverse() : RAIL_BUCKETS;
        let idx = 0;
        for (const b of order) { if (b === letter) return idx; idx += (letters[b] || 0); }
        return idx;
    }

    // Fallback for providers without sort_letters: walk the sparse store forward
    // (fetching pages as needed, bounded by total) until a card's bucket matches.
    async function _scanForLetter(letter, token) {
        const total = state.total || 0;
        for (let i = 0; i < total; i++) {
            if (state.songs[i] === undefined) {
                await ensureWindow(i, Math.min(total, i + PAGE_SIZE));
                if (_jumpToken !== token) return null;
            }
            const s = state.songs[i];
            if (s && songBucket(s) === letter) return i;
        }
        return null;
    }

    let _jumpToken = 0;
    // `smooth` animates the scroll (a discrete tap / keyboard jump). A drag-scrub
    // passes `false` so each step snaps INSTANTLY: stacked smooth animations over
    // the windowed grid lag and settle imprecisely, which is why a drag used to
    // land somewhere other than the let-go letter.
    async function jumpToLetter(letter, smooth = true) {
        const grid = _gridEl(), sizer = _sizerEl(), main = document.getElementById('v3-main');
        if (!grid || !sizer || !main || state.view !== 'grid' || !letter) return;
        _setRailActive(letter);
        const myToken = ++_jumpToken;   // a newer jump supersedes this one
        const { cols, rowH } = measureGeom();
        let targetIndex = _letterStartIndex(letter);
        if (targetIndex == null) {
            targetIndex = await _scanForLetter(letter, myToken);
            if (_jumpToken !== myToken) return;
            if (targetIndex == null) return;   // letter not present
        }
        const total = state.total || 0;
        if (targetIndex >= total) targetIndex = Math.max(0, total - 1);
        const targetRow = Math.floor(targetIndex / Math.max(1, cols));
        // Pre-fetch the destination window so cards are present when the smooth
        // scroll arrives (avoids a flash of skeletons at the landing row).
        await ensureWindow(targetIndex, Math.min(total, targetIndex + cols * (OVERSCAN_ROWS * 2 + 4)));
        if (_jumpToken !== myToken || state.view !== 'grid') return;
        const sizerTop = _sizerTopInScroller(main, sizer);
        const toolbar = document.getElementById('v3-songs-toolbar');
        const pad = (toolbar ? toolbar.offsetHeight : 0) + 12; // clear the sticky toolbar
        const top = Math.max(0, sizerTop + targetRow * rowH - pad);
        main.scrollTo({ top, behavior: smooth ? 'smooth' : 'auto' });
        requestWindowRender();
    }

    function bindRailOnce() {
        const rail = railEl();
        if (!rail || rail._bound) return;
        rail._bound = true;
        let dragging = false, lastDrag = null, railBtns = [];
        // Resolve the letter button under a viewport-Y from the per-drag cached
        // list (avoids a querySelectorAll per pointermove), clamping past the
        // top/bottom so a scrub off the ends still seeks the first/last letter.
        const letterAtY = (y) => {
            if (!railBtns.length) return null;
            for (const el of railBtns) { const r = el.getBoundingClientRect(); if (y >= r.top && y <= r.bottom) return el; }
            return y < railBtns[0].getBoundingClientRect().top ? railBtns[0] : railBtns[railBtns.length - 1];
        };
        // Seek to the letter under `y`. `smooth` on the initial press (a tap);
        // instant during the scrub so the grid tracks the finger and RELEASE
        // lands exactly on the let-go letter.
        const seekToY = (y, smooth) => {
            const el = letterAtY(y);
            if (!el || el.disabled) return;
            const L = el.getAttribute('data-letter');
            _showBubble(L);
            if (L !== lastDrag) { lastDrag = L; jumpToLetter(L, smooth); }
        };
        rail.addEventListener('pointerdown', (e) => {
            if (e.button !== 0 || e.isPrimary === false) return;  // primary tap only; ignore right/middle-click + secondary touches
            const btn = e.target.closest('.v3-azrail-letter');
            if (!btn) return;
            railBtns = [...rail.querySelectorAll('.v3-azrail-letter')];
            dragging = true; lastDrag = null;
            // Capture so a vertical scrub keeps seeking even if the pointer drifts
            // off the thin rail horizontally.
            try { rail.setPointerCapture(e.pointerId); } catch (_) { /* */ }
            // Drive the jump from here, NOT from the click event: pointer capture
            // retargets the follow-up click to the rail (never a letter), so a
            // captured tap's click can't resolve a letter and used to no-op
            // ("clicked O, nothing happened"). preventDefault() suppresses the
            // text-selection / focus-scroll default; we re-focus below for kbd.
            e.preventDefault();
            try { btn.focus({ preventScroll: true }); } catch (_) { /* */ }
            seekToY(e.clientY, true);   // jump on press → a tap lands immediately
        });
        rail.addEventListener('pointermove', (e) => {
            if (!dragging) return;
            seekToY(e.clientY, false);  // instant tracking during the scrub
        });
        const end = () => { dragging = false; railBtns = []; _hideBubble(); };
        rail.addEventListener('pointerup', end);
        rail.addEventListener('pointercancel', end);
        // Keyboard activation only. A pointer-driven click (detail >= 1) is
        // retargeted to the rail by pointer capture and can't resolve a letter,
        // so the pointer path owns taps; act here only on Enter/Space, whose
        // synthesized click has detail === 0.
        rail.addEventListener('click', (e) => {
            if (e.detail !== 0) return;
            const btn = e.target.closest('.v3-azrail-letter');
            if (!btn || btn.disabled) return;
            jumpToLetter(btn.getAttribute('data-letter'));
        });
        rail.addEventListener('keydown', (e) => {
            if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;
            const btns = [...rail.querySelectorAll('.v3-azrail-letter:not([disabled])')];
            const i = btns.indexOf(document.activeElement);
            if (i < 0) return;
            e.preventDefault();
            const next = btns[i + (e.key === 'ArrowDown' ? 1 : -1)];
            if (next) {
                btns[i].setAttribute('tabindex', '-1');   // roving tabindex follows focus
                next.setAttribute('tabindex', '0');
                next.focus();
                jumpToLetter(next.getAttribute('data-letter'));
            }
        });
    }

    // Pin the sticky toolbar directly beneath the sticky topbar. Both live in
    // the #v3-main scroller, so without an explicit offset they share top:0 and
    // the toolbar covers the topbar's song search. The topbar has two responsive
    // rows, so its height is measured (and re-measured on resize) instead of
    // hard-coded.
    function positionToolbar() {
        const topbar = document.getElementById('v3-topbar');
        const bar = document.getElementById('v3-songs-toolbar');
        if (!topbar || !bar) return;
        bar.style.top = topbar.offsetHeight + 'px';
    }
    function bindToolbarReflow() {
        if (state.resizeBound) return;
        const topbar = document.getElementById('v3-topbar');
        if (!topbar) return;
        state.resizeBound = true;
        // Observe the topbar itself: its height changes with viewport width AND
        // when the song search is toggled in/out on screen changes. ResizeObserver
        // fires once on observe(), so this also fixes up the initial position
        // regardless of render() vs syncActive() ordering.
        if (typeof ResizeObserver === 'function') {
            new ResizeObserver(positionToolbar).observe(topbar);
        } else {
            window.addEventListener('resize', positionToolbar, { passive: true });
        }
    }

    // ── Tree ────────────────────────────────────────────────────────────────
    // ── Albums (album-condensed browse; consumes /api/library/albums) ─────────
    // Album cards -> click -> a track list (reusing /api/library?artist=&album=)
    // with Play-album (feeds the play-queue). Respects the active drawer filters.
    async function loadAlbums() {
        const host = document.getElementById('v3-songs-albums');
        if (!host) return;
        host.innerHTML = '<p class="text-fb-textDim text-sm">Loading…</p>';
        const data = await jget('/api/library/albums?' + queryParams().toString());
        const albums = (data && data.albums) || [];
        if (!albums.length) { host.innerHTML = '<p class="text-fb-textDim text-sm py-8 text-center">No albums match.</p>'; return; }
        host.innerHTML =
            '<div class="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-6 gap-4">' +
            albums.map((a, i) =>
                '<button data-album="' + i + '" class="group text-left">' +
                '<div class="aspect-square rounded-lg overflow-hidden bg-fb-card mb-2">' +
                (a.cover ? '<img src="' + esc(artUrl({ filename: a.cover })) + '" alt="" loading="lazy" decoding="async" class="w-full h-full object-cover transition-transform duration-300 group-hover:scale-105" onerror="this.style.visibility=\'hidden\'">' : '') +
                '</div>' +
                '<div class="text-sm text-fb-text truncate">' + esc(a.album) + '</div>' +
                '<div class="text-xs text-fb-textDim truncate">' + esc(a.artist) + ' · ' + (a.count || 0) + ' track' + (a.count === 1 ? '' : 's') + '</div>' +
                '</button>').join('') + '</div>';
        host.querySelectorAll('[data-album]').forEach((b) => b.addEventListener('click', () => {
            const a = albums[Number(b.getAttribute('data-album'))];
            if (a) openAlbum(a);
        }));
    }
    async function openAlbum(a) {
        const host = document.getElementById('v3-songs-albums');
        if (!host) return;
        host.innerHTML = '<p class="text-fb-textDim text-sm">Loading…</p>';
        // Honour the active drawer filters (like the album grid) but pin THIS
        // album's artist/album and force track order — so the track list and
        // Play-album never include songs the user filtered out.
        const p = queryParams({ artist: a.artist, album: a.album, size: '300', sort: 'track' }, { catalog: true });
        const data = await jget('/api/library?' + p.toString());
        const songs = (data && data.songs) || [];
        host.innerHTML =
            '<button data-albums-back class="text-sm text-fb-textDim hover:text-fb-text mb-4">← Albums</button>' +
            '<div class="flex items-center justify-between gap-3 mb-4">' +
            '<div class="min-w-0"><h2 class="text-2xl font-bold text-fb-text truncate">' + esc(a.album) + '</h2>' +
            '<p class="text-sm text-fb-textDim truncate">' + esc(a.artist) + ' · ' + songs.length + ' track' + (songs.length === 1 ? '' : 's') + '</p></div>' +
            (songs.length ? '<button data-album-playall class="bg-fb-primary hover:bg-fb-primaryHi text-white text-sm font-medium px-4 py-2 rounded-md shrink-0">▶ Play album</button>' : '') +
            '</div>' +
            '<ul class="space-y-1">' + songs.map((s, i) =>
                '<li><button data-album-track="' + i + '" class="w-full flex items-center gap-3 px-3 py-2 rounded-md hover:bg-white/5 text-left">' +
                '<span class="text-xs text-fb-textDim w-6 text-right">' + (i + 1) + '</span>' +
                '<span class="flex-1 truncate text-sm text-fb-text">' + esc(s.title || s.filename) + '</span></button></li>').join('') + '</ul>';
        host.querySelector('[data-albums-back]')?.addEventListener('click', () => loadAlbums());
        host.querySelector('[data-album-playall]')?.addEventListener('click', () => {
            const files = songs.map((s) => s.filename).filter(Boolean);
            if (!files.length) return;
            if (window.feedBack && window.feedBack.playQueue) window.feedBack.playQueue.start(files, { source: a.album });
            else if (typeof window.playSong === 'function') window.playSong(enc(files[0]));
        });
        host.querySelectorAll('[data-album-track]').forEach((b) => b.addEventListener('click', () => {
            const s = songs[Number(b.getAttribute('data-album-track'))];
            if (s && window.playSong) window.playSong(enc(s.filename));
        }));
    }

    async function loadTree() {
        const host = document.getElementById('v3-songs-tree');
        if (!host) return;
        // The list view always groups artist -> album (query_artists has no
        // free sort) — when the picked sort is something else, say so instead
        // of silently ignoring it ("why does the sort do nothing here?").
        const _treeSortNote = railSortColumn() === 'artist' ? ''
            : '<p class="text-xs text-fb-textDim mb-3">List view groups by artist — the selected sort applies to the card grid.</p>';
        // Capture expanded groups BEFORE the "Loading…" wipe below, so a reload
        // (e.g. toggling select mode) restores them instead of collapsing all.
        const openArtists = new Set(
            [...host.querySelectorAll('details[open]')].map((d) => d.getAttribute('data-artist')));
        host.innerHTML = '<p class="text-fb-textDim text-sm">Loading…</p>';
        // Page through ALL artists — the endpoint clamps size to 100, so a
        // single request would silently truncate libraries with >100 artists.
        const artists = [];
        let page = 0, total = Infinity;
        while (artists.length < total) {
            const data = await jget('/api/library/artists?' + queryParams({ size: 100, page }).toString());
            if (!data || !Array.isArray(data.artists)) break;
            artists.push(...data.artists);
            total = (data.total_artists != null) ? data.total_artists : artists.length;
            if (!data.artists.length || page > 1000) break;   // safety: no progress / runaway guard
            page++;
        }
        if (!artists.length) { host.innerHTML = '<p class="text-fb-textDim text-sm">Nothing here.</p>'; return; }
        artists.forEach((a) => (a.albums || []).forEach((al) => (al.songs || []).forEach((s) => { state.songsById[cardKey(s)] = s; })));
        host.innerHTML = _treeSortNote + artists.map((a) =>
            '<details data-artist="' + esc(a.name) + '"' + (openArtists.has(a.name) ? ' open' : '') + ' class="border-b border-fb-border/40"><summary class="cursor-pointer py-2 text-fb-text flex items-center justify-between">' +
            '<span>' + esc(a.name) + '</span><span class="text-xs text-fb-textDim">' + esc(a.song_count) + '</span></summary>' +
            '<div class="pl-3 pb-2 space-y-2">' + (a.albums || []).map((al) =>
                '<div><div class="text-xs uppercase tracking-wider text-fb-textDim/70 mt-2 mb-1">' + esc(al.name || 'Unknown') + '</div>' +
                (al.songs || []).map((s) => {
                    const k = cardKey(s); const fl = fmtLabel(s); const chips = arrChipsHtml(s); const sel = state.selected.has(k);
                    // Display-only checkbox (pointer-events-none); the row's
                    // capture-phase select handler (render()) owns the toggle.
                    const checkbox = state.selectMode
                        ? '<input type="checkbox" data-select class="shrink-0 w-5 h-5 accent-fb-primary pointer-events-none"' + (sel ? ' checked' : '') + '>'
                        : '';
                    return (
                    '<div class="relative flex items-center gap-2 py-1 group" data-fn="' + esc(k) + '" data-library-song="' + esc(songId(s)) + '" data-library-provider="' + esc(state.provider) + '">' +
                    checkbox +
                    '<img src="' + esc(artUrl(s)) + '" alt="" loading="lazy" decoding="async" class="w-8 h-8 rounded object-cover bg-fb-card cursor-pointer' + (sel ? ' ring-2 ring-fb-primary' : '') + '" data-v3-play onerror="this.style.visibility=\'hidden\'">' +
                    '<span class="flex-1 min-w-0 cursor-pointer" data-v3-play><span class="block text-sm text-fb-text truncate">' + esc(s.title) + '</span></span>' +
                    (chips ? '<span class="hidden sm:flex items-center gap-1 shrink-0">' + chips + '</span>' : '') +
                    (fl ? '<span class="text-[0.5625rem] font-bold px-1 py-0.5 rounded shrink-0 ' + (fl === 'FEEDPAK' ? 'bg-fb-primary/20 text-fb-primary' : 'bg-fb-card text-fb-textDim') + '">' + fl + '</span>' : '') +
                    accuracyBadge(k, 'tree') +
                    // Same fav / save-for-later / overflow-menu cluster as the grid
                    // card. Always shown (like the arrangement chips), not hover-
                    // revealed. wireCards() binds all three for any [data-fn].
                    '<div class="flex items-center gap-0.5 shrink-0">' +
                    '<button data-fav data-fav-idle="text-fb-textDim" title="Favorite" aria-label="Favorite" aria-pressed="' + (s.favorite ? 'true' : 'false') + '" class="px-1 ' + (s.favorite ? 'text-fb-accent' : 'text-fb-textDim') + '">' + (s.favorite ? '♥' : '♡') + '</button>' +
                    '<button data-save title="Save for later" aria-label="Save for later" class="px-1 text-fb-textDim hover:text-fb-text">🔖</button>' +
                    '<button data-menu title="More" aria-label="More actions" class="px-1 text-fb-textDim hover:text-fb-text leading-none">⋮</button>' +
                    '</div>' +
                    '</div>'); }).join('') + '</div>').join('') + '</div></details>').join('');
        wireCards(host);
    }

    // ── Filter drawer ─────────────────────────────────────────────────────--
    function triState(list_has, list_lacks, value) {
        if (list_has.includes(value)) return 'has';
        if (list_lacks.includes(value)) return 'lacks';
        return 'any';
    }
    function cycleTri(hasArr, lacksArr, value) {
        const s = triState(hasArr, lacksArr, value);
        const rm = (a) => { const i = a.indexOf(value); if (i >= 0) a.splice(i, 1); };
        rm(hasArr); rm(lacksArr);
        if (s === 'any') hasArr.push(value);
        else if (s === 'has') lacksArr.push(value);
        // 'lacks' → cycles back to any (already removed)
    }
    function triPill(group, value, label, st) {
        const cls = st === 'has' ? 'bg-fb-good/30 text-fb-good border-fb-good/40'
            : st === 'lacks' ? 'bg-fb-low/30 text-fb-low border-fb-low/40'
                : 'bg-gray-800/50 text-fb-textDim border-gray-700';
        const mark = st === 'has' ? '✓ ' : st === 'lacks' ? '✕ ' : '';
        return '<button data-tri="' + group + '" data-val="' + esc(value) + '" class="px-2 py-1 rounded-md text-xs border ' + cls + '">' + mark + esc(label) + '</button>';
    }
    function renderDrawer() {
        const d = document.getElementById('v3-songs-drawer');
        if (!d) return;
        const f = state.filters;
        d.innerHTML =
            '<div class="p-5 space-y-5">' +
            '<div class="flex items-center justify-between"><h3 class="text-lg font-semibold text-fb-text">Filters</h3>' +
            '<button data-drawer-close class="text-fb-textDim hover:text-fb-text">✕</button></div>' +
            section('Arrangements', ARRANGEMENTS.map((a) => triPill('arr', a, a, triState(f.arr_has, f.arr_lacks, a))).join('')) +
            section('Stems (sloppak)', STEMS.map((s) => triPill('stem', s, s, triState(f.stem_has, f.stem_lacks, s))).join('')) +
            section('Lyrics', ['', '1', '0'].map((v) => '<button data-lyrics="' + v + '" class="px-2 py-1 rounded-md text-xs border ' + (f.lyrics === v ? 'bg-fb-primary text-white border-fb-primary' : 'bg-gray-800/50 text-fb-textDim border-gray-700') + '">' + (v === '' ? 'Any' : v === '1' ? 'Has lyrics' : 'No lyrics') + '</button>').join('')) +
            // Progress (mastery bands) — multi-select; server filters via song_stats.
            section('Progress', [['mastered', 'Mastered'], ['in_progress', 'In progress'], ['not_started', 'Not started']].map((it) => '<button data-mastery="' + it[0] + '" class="px-2 py-1 rounded-md text-xs border ' + (f.mastery.includes(it[0]) ? 'bg-fb-primary text-white border-fb-primary' : 'bg-gray-800/50 text-fb-textDim border-gray-700') + '">' + it[1] + '</button>').join('')) +
            // Match (P8) — the song's metadata-match lifecycle state, a triage
            // facet for the enrichment layer. Session-only, like Progress.
            section('Match', [['review', 'To review'], ['matched', 'Matched'], ['unmatched', 'Unmatched'], ['pending', 'Not scanned']].map((it) => '<button data-match="' + it[0] + '" class="px-2 py-1 rounded-md text-xs border ' + (f.match.includes(it[0]) ? 'bg-fb-primary text-white border-fb-primary' : 'bg-gray-800/50 text-fb-textDim border-gray-700') + '">' + it[1] + '</button>').join('')) +
            // Genre facet — dynamic list from /api/library/genres (primary genre).
            (state.genres && state.genres.length ? section('Genre', state.genres.map((g) => '<button data-genre="' + esc(g) + '" class="px-2 py-1 rounded-md text-xs border ' + (f.genre.includes(g) ? 'bg-fb-primary text-white border-fb-primary' : 'bg-gray-800/50 text-fb-textDim border-gray-700') + '">' + esc(g) + '</button>').join('')) : '') +
            section('Tuning', (state.tuningNames || []).map((t) => {
                // Filter on the server's grouping key (raw offsets for customs)
                // so two "Custom Tuning" entries are distinct; show their target
                // notes in the label so they're distinguishable.
                const val = t.key || t.name;
                let label = t.name;
                if (t.name === 'Custom Tuning' && t.offsets
                    && typeof window.parseRawTuningOffsets === 'function'
                    && typeof window.displayTuningTargets === 'function') {
                    const offs = window.parseRawTuningOffsets(t.offsets);
                    const notes = offs ? window.displayTuningTargets(offs, { tuningName: t.name }) : '';
                    if (notes) label = 'Custom · ' + notes;
                }
                return triPill('tuning', val, label + ' (' + t.count + ')', f.tunings.includes(val) ? 'has' : 'any');
            }).join('') || '<span class="text-xs text-fb-textDim">No tunings</span>') +
            // Multi-chart grouping toggle (P5e) — a VIEW mode, not a filter
            // (never counted in the badge, never saved into collection rules).
            // Local provider only: it's the one that implements group=.
            (state.provider === 'local'
                ? section('Grouping', '<button data-grouping class="px-2 py-1 rounded-md text-xs border ' +
                    (state.grouping !== false ? 'bg-fb-primary text-white border-fb-primary' : 'bg-gray-800/50 text-fb-textDim border-gray-700') +
                    '" title="Collapse charts of the same song to one card (the ⚑ chip lists the versions)">' +
                    (state.grouping !== false ? '✓ ' : '') + 'One card per song</button>')
                : '') +
            // Collections always replay against the LOCAL library, so only offer
            // "save" when browsing local with a non-empty filter set.
            (state.provider === 'local' && Object.keys(currentFilterRules()).length
                ? '<div class="pt-3 border-t border-fb-border/50"><button data-drawer-save class="w-full text-sm text-fb-primary hover:text-fb-primaryHi border border-fb-primary/40 rounded-md py-2">＋ Save as collection</button></div>'
                : '') +
            // Artist canonicalization (P4) — local library only (aliases apply to
            // the local catalog). Opens the Tidy-up modal to merge "ACDC"/"AC/DC".
            (state.provider === 'local'
                ? '<div class="pt-3 border-t border-fb-border/50"><button data-drawer-tidy class="w-full text-sm text-fb-textDim hover:text-fb-text border border-fb-border/50 rounded-md py-2">Tidy up artists…</button></div>'
                : '') +
            '<div class="flex justify-between pt-3 border-t border-fb-border/50"><button data-drawer-clear class="text-sm text-fb-textDim hover:text-fb-text">Clear all</button>' +
            '<button data-drawer-apply class="bg-fb-primary hover:bg-fb-primaryHi text-white px-4 py-2 rounded-md text-sm">Done</button></div></div>';

        d.querySelectorAll('[data-tri]').forEach((b) => b.addEventListener('click', () => {
            const g = b.getAttribute('data-tri'), v = b.getAttribute('data-val');
            if (g === 'arr') cycleTri(f.arr_has, f.arr_lacks, v);
            else if (g === 'stem') cycleTri(f.stem_has, f.stem_lacks, v);
            else if (g === 'tuning') { const i = f.tunings.indexOf(v); if (i >= 0) f.tunings.splice(i, 1); else f.tunings.push(v); }
            renderDrawer();
        }));
        d.querySelectorAll('[data-lyrics]').forEach((b) => b.addEventListener('click', () => { f.lyrics = b.getAttribute('data-lyrics'); renderDrawer(); }));
        d.querySelectorAll('[data-mastery]').forEach((b) => b.addEventListener('click', () => { const v = b.getAttribute('data-mastery'); const i = f.mastery.indexOf(v); if (i >= 0) f.mastery.splice(i, 1); else f.mastery.push(v); renderDrawer(); }));
        d.querySelector('[data-grouping]')?.addEventListener('click', () => {
            state.grouping = !(state.grouping !== false);
            renderDrawer();
            reload();     // re-fetches grid + rail with/without group=1, saves prefs
        });
        d.querySelectorAll('[data-match]').forEach((b) => b.addEventListener('click', () => { const v = b.getAttribute('data-match'); const i = f.match.indexOf(v); if (i >= 0) f.match.splice(i, 1); else f.match.push(v); renderDrawer(); }));
        d.querySelectorAll('[data-genre]').forEach((b) => b.addEventListener('click', () => { const v = b.getAttribute('data-genre'); const i = f.genre.indexOf(v); if (i >= 0) f.genre.splice(i, 1); else f.genre.push(v); renderDrawer(); }));
        d.querySelector('[data-drawer-save]')?.addEventListener('click', saveCurrentAsCollection);
        d.querySelector('[data-drawer-tidy]')?.addEventListener('click', openArtistTidyUp);
        d.querySelector('[data-drawer-close]')?.addEventListener('click', closeDrawer);
        d.querySelector('[data-drawer-clear]')?.addEventListener('click', async () => {
            state.filters = { arr_has: [], arr_lacks: [], stem_has: [], stem_lacks: [], lyrics: '', tunings: [], mastery: [], match: [], genre: [] };
            state.artist = '';
            state.album = '';
            renderDrawer();
            await loadArtistCatalog();
            refreshArtistAlbumSelects();
            reload();
        });
        d.querySelector('[data-drawer-apply]')?.addEventListener('click', async () => {
            closeDrawer();
            await loadArtistCatalog();
            refreshArtistAlbumSelects();
            reload();
        });
    }
    function section(label, inner) {
        return '<div><div class="text-xs font-semibold uppercase tracking-wider text-fb-textDim mb-2">' + label + '</div><div class="flex flex-wrap gap-1">' + inner + '</div></div>';
    }
    function openDrawer() { renderDrawer(); document.getElementById('v3-songs-drawer')?.classList.remove('translate-x-full'); document.getElementById('v3-songs-overlay')?.classList.remove('hidden'); }
    function closeDrawer() { document.getElementById('v3-songs-drawer')?.classList.add('translate-x-full'); document.getElementById('v3-songs-overlay')?.classList.add('hidden'); updateFilterBadge(); }
    function updateFilterBadge() { const b = document.getElementById('v3-songs-filter-count'); if (b) { const n = activeFilterCount(); b.textContent = n; b.classList.toggle('hidden', n === 0); } }

    // ── Song Details drawer (P2) ───────────────────────────────────────────--
    // Evolves the legacy edit-metadata modal into a v3 slide-in drawer that
    // unifies catalog identity (writes back into the feedpak FILE), the personal
    // practice layer (difficulty / tags / notes — local, never shared), the like
    // heart, and remove-from-library. Reuses the filter-drawer slide idiom
    // (fixed-right panel + overlay + translate-x-full) but is built on demand and
    // body-appended, so it opens from any card context. The Charts drawer (P5d)
    // reuses this pattern.
    const DIFF_LABELS = ['', 'Very easy', 'Easy', 'Medium', 'Hard', 'Very hard'];
    let _detailsEls = null;   // {overlay, drawer, opener, onKey} while open

    function closeDetails() {
        if (!_detailsEls) return;
        const { overlay, drawer, opener, onKey } = _detailsEls;
        _detailsEls = null;
        document.removeEventListener('keydown', onKey);
        drawer.classList.add('translate-x-full');
        overlay.classList.add('opacity-0');
        setTimeout(() => { drawer.remove(); overlay.remove(); }, 200);
        if (opener && document.body.contains(opener)) { try { opener.focus({ preventScroll: true }); } catch (_) { /* */ } }
    }

    async function openDetails(song) {
        if (!song || !song.filename) return;
        closeDetails();
        const fn = song.filename;
        const opener = document.activeElement;
        // Notes aren't in the grid row payload; difficulty/tags are, but re-read
        // for authority (another tab / a bulk edit may have changed them).
        let meta = { user_difficulty: (song.user_difficulty != null ? song.user_difficulty : null), notes: '', tags: song.tags || [] };
        try { const r = await fetch('/api/song/' + enc(fn) + '/user-meta'); if (r.ok) meta = await r.json(); } catch (_) { /* offline → row data */ }
        let vocab = [];
        try { const r = await fetch('/api/tags'); if (r.ok) vocab = (await r.json()).tags || []; } catch (_) { /* */ }
        if (_detailsEls) closeDetails();   // a concurrent open resolved first

        const st = {
            t: song.title || '', a: song.artist || '', al: song.album || '', y: song.year != null ? String(song.year) : '',
            diff: (meta.user_difficulty != null ? meta.user_difficulty : null),
            notes: meta.notes || '', tags: (meta.tags || []).slice(),
            fav: !!song.favorite, artDataUrl: null,
            gap: null, gapSel: null,   // gap-fill (R4a): preview state + selected keys
        };

        const overlay = document.createElement('div');
        overlay.className = 'fixed inset-0 bg-black/50 z-[60] opacity-0 transition-opacity duration-200';
        const drawer = document.createElement('aside');
        drawer.id = 'v3-song-details-drawer';
        drawer.className = 'fixed top-0 right-0 h-full w-full sm:w-[26rem] bg-fb-sidebar border-l border-fb-border/50 z-[61] transform translate-x-full transition-transform duration-200 overflow-y-auto v3-scroll';
        drawer.setAttribute('role', 'dialog');
        drawer.setAttribute('aria-modal', 'true');
        drawer.setAttribute('aria-label', 'Song details');
        document.body.appendChild(overlay);
        document.body.appendChild(drawer);

        const onKey = (e) => { if (e.key === 'Escape') { e.preventDefault(); closeDetails(); } };
        document.addEventListener('keydown', onKey);
        overlay.addEventListener('click', closeDetails);
        _detailsEls = { overlay, drawer, opener, onKey };

        const render = () => { drawer.innerHTML = detailsHtml(song, st, vocab); wireDetails(drawer, song, st, vocab, render); };
        render();
        requestAnimationFrame(() => { drawer.classList.remove('translate-x-full'); overlay.classList.remove('opacity-0'); });
        if (window._trapFocusInModal) { try { window._trapFocusInModal(drawer); } catch (_) { /* */ } }
        const first = drawer.querySelector('#det-title');
        if (first) { try { first.focus({ preventScroll: true }); const n = first.value.length; first.setSelectionRange(n, n); } catch (_) { /* */ } }
    }

    // Gap-fill (R4a) block inside the drawer's Identity section: preview →
    // per-key confirm → written. Adds ABSENT keys only; the server re-checks
    // under its io lock, so this UI can never replace an author-set value.
    const GAP_KEY_LABELS = { album: 'Album', year: 'Year', genres: 'Genres', mbid: 'MusicBrainz ID', isrc: 'ISRC' };
    function gapFillHtml(st) {
        const g = st.gap;
        if (!g) return '<button data-gapfill-check class="text-xs text-fb-textDim hover:text-fb-text">Write missing info to file…</button>';
        if (g.loading) return '<div class="text-xs text-fb-textDim">Checking the file…</div>';
        if (g.written) {
            const names = Object.keys(g.written).map((k) => GAP_KEY_LABELS[k] || k).join(', ');
            return '<div class="text-xs text-fb-text">✓ Added to file: ' + esc(names) + '</div>';
        }
        if (!g.eligible) {
            const why = {
                'not-sloppak': 'Only feedpak songs can be written to.',
                'no-match': 'No confirmed match yet — nothing verified to write.',
                'review': 'This song’s match is waiting for review — confirm it first.',
                'nothing-missing': 'Nothing missing — the file already has all of this.',
            }[g.reason] || 'Could not check the file. Try again.';
            return '<div class="text-xs text-fb-textDim">' + esc(why) + '</div>';
        }
        const rows = (g.missing || []).map((m) => {
            const val = Array.isArray(m.value) ? m.value.join(', ') : String(m.value);
            return '<label class="flex items-center gap-2 text-sm text-fb-text">' +
                '<input type="checkbox" data-gapfill-key="' + esc(m.key) + '"' + (st.gapSel && st.gapSel.has(m.key) ? ' checked' : '') + '>' +
                '<span class="text-fb-textDim shrink-0">' + esc(GAP_KEY_LABELS[m.key] || m.key) + '</span>' +
                '<span class="truncate" title="' + esc(val) + '">' + esc(val) + '</span></label>';
        }).join('');
        return '<div class="space-y-2">' +
            '<div class="text-xs font-semibold uppercase tracking-wider text-fb-textDim">Write to file</div>' + rows +
            '<div class="text-[0.6875rem] text-fb-textDim">Only adds what’s missing — nothing already in the file is changed. A backup (.bak) is kept beside the file.</div>' +
            '<div class="flex gap-2"><button data-gapfill-write class="bg-fb-primary hover:bg-fb-primaryHi text-white px-3 py-1.5 rounded-lg text-xs font-semibold">Write to file</button>' +
            '<button data-gapfill-cancel class="px-3 py-1.5 bg-fb-card/60 hover:bg-fb-card border border-fb-border/50 rounded-lg text-xs text-fb-text">Cancel</button></div></div>';
    }

    function detailsHtml(song, st, vocab) {
        const art = st.artDataUrl || artUrl(song);
        const diffBtns = [1, 2, 3, 4, 5].map((n) =>
            '<button data-diff="' + n + '" aria-pressed="' + (st.diff === n ? 'true' : 'false') + '" class="w-8 h-8 rounded-md text-sm font-bold border ' +
            (st.diff === n ? 'bg-fb-primary text-white border-fb-primary' : 'bg-gray-800/50 text-fb-textDim border-gray-700 hover:text-fb-text') + '">' + n + '</button>').join('');
        const applied = new Set(st.tags);
        const tagChips = st.tags.length
            ? st.tags.map((t) => '<span class="inline-flex items-center gap-1 bg-fb-primary/20 text-fb-text border border-fb-primary/40 text-xs px-2 py-0.5 rounded-full">' + esc(t) +
                '<button data-tag-rm="' + esc(t) + '" aria-label="Remove tag ' + esc(t) + '" class="text-fb-textDim hover:text-fb-accent leading-none">×</button></span>').join('')
            : '<span class="text-xs text-fb-textDim">No tags yet</span>';
        const suggest = (vocab || []).filter((v) => !applied.has(v.tag)).slice(0, 8).map((v) =>
            '<button data-tag-add="' + esc(v.tag) + '" class="text-[0.6875rem] px-2 py-0.5 rounded-full bg-gray-800/60 text-fb-textDim hover:bg-fb-primary hover:text-white transition">' + esc(v.tag) + '</button>').join('');
        const field = (id, label, val) =>
            '<div><label for="' + id + '" class="text-xs text-fb-textDim mb-1 block">' + label + '</label>' +
            '<input type="text" id="' + id + '" value="' + esc(val) + '" class="w-full bg-fb-card border border-fb-border/60 rounded-lg px-3 py-2 text-sm text-fb-text outline-none focus:border-fb-primary/60"></div>';
        return '<div class="p-5 space-y-5">' +
            '<div class="flex items-center justify-between"><h3 class="text-lg font-semibold text-fb-text">Song details</h3>' +
            '<button data-det-close aria-label="Close" class="text-fb-textDim hover:text-fb-text text-xl leading-none">✕</button></div>' +

            '<div class="flex items-center gap-3">' +
            '<div class="relative group cursor-pointer shrink-0" data-det-art title="Change album art">' +
            '<img src="' + esc(art) + '" alt="" class="w-16 h-16 rounded-lg object-cover bg-fb-card" id="det-art-preview" onerror="this.style.visibility=\'hidden\'">' +
            '<div class="absolute inset-0 bg-black/50 rounded-lg flex items-center justify-center opacity-0 group-hover:opacity-100 transition text-[0.625rem] text-white">Change</div>' +
            '<input type="file" accept="image/*" id="det-art-file" class="hidden"></div>' +
            '<div class="min-w-0"><div class="text-sm text-fb-text truncate" title="' + esc(song.title || song.filename) + '">' + esc(song.title || song.filename) + '</div>' +
            '<div class="mt-1"><button data-det-fav class="text-xs ' + (st.fav ? 'text-fb-accent' : 'text-fb-textDim hover:text-fb-text') + '">' + (st.fav ? '♥ Liked' : '♡ Like') + '</button>' +
            '<span class="text-[0.625rem] text-fb-textDim ml-1">a like, not a rating</span></div></div></div>' +

            // Identity — writes back into the feedpak FILE
            '<div class="space-y-3"><div class="flex items-center gap-2"><div class="text-xs font-semibold uppercase tracking-wider text-fb-textDim">Identity</div>' +
            '<span class="text-[0.625rem] px-1.5 py-0.5 rounded-full bg-gray-800/70 text-fb-textDim border border-gray-700" title="These came from the song&#39;s feedpak. Editing them writes back to the file.">From pack</span></div>' +
            field('det-title', 'Title', st.t) + field('det-artist', 'Artist', st.a) + field('det-album', 'Album', st.al) +
            '<div><label for="det-year" class="text-xs text-fb-textDim mb-1 block">Year</label><input type="text" inputmode="numeric" id="det-year" value="' + esc(st.y) + '" placeholder="e.g. 2024" class="w-full bg-fb-card border border-fb-border/60 rounded-lg px-3 py-2 text-sm text-fb-text outline-none focus:border-fb-primary/60"></div>' +
            '<div data-det-gapfill>' + gapFillHtml(st) + '</div></div>' +

            // Personal practice layer — local, never shared
            '<div class="space-y-3 pt-1"><div class="text-xs font-semibold uppercase tracking-wider text-fb-textDim">Your practice <span class="normal-case font-normal text-fb-textDim/70">· stays on this device</span></div>' +
            '<div><div class="flex items-center justify-between mb-1"><label class="text-xs text-fb-textDim">Difficulty (for you)</label>' +
            '<button data-diff-clear class="text-[0.6875rem] text-fb-textDim hover:text-fb-text ' + (st.diff == null ? 'invisible' : '') + '">Clear</button></div>' +
            '<div class="flex gap-1 items-center">' + diffBtns + '<span class="text-xs text-fb-textDim ml-2">' + esc(st.diff ? DIFF_LABELS[st.diff] : 'Not set') + '</span></div></div>' +
            '<div><label for="det-tag-input" class="text-xs text-fb-textDim mb-1 block">Tags</label>' +
            '<div class="flex flex-wrap gap-1 mb-2" data-det-tags>' + tagChips + '</div>' +
            '<div class="flex gap-1"><input type="text" id="det-tag-input" placeholder="Add a tag…" class="flex-1 bg-fb-card border border-fb-border/60 rounded-lg px-3 py-1.5 text-sm text-fb-text outline-none focus:border-fb-primary/60">' +
            '<button data-tag-addbtn class="text-sm px-3 rounded-lg bg-fb-card/60 border border-fb-border/50 text-fb-text hover:bg-fb-card">Add</button></div>' +
            (suggest ? '<div class="flex flex-wrap gap-1 mt-2">' + suggest + '</div>' : '') + '</div>' +
            '<div><label for="det-notes" class="text-xs text-fb-textDim mb-1 block">Notes</label>' +
            '<textarea id="det-notes" rows="3" class="w-full bg-fb-card border border-fb-border/60 rounded-lg px-3 py-2 text-sm text-fb-text outline-none focus:border-fb-primary/60 resize-none" placeholder="Private practice notes…">' + esc(st.notes) + '</textarea></div></div>' +

            '<div class="flex gap-3 pt-1"><button data-det-save class="flex-1 bg-fb-primary hover:bg-fb-primaryHi text-white px-4 py-2 rounded-xl text-sm font-semibold">Save</button>' +
            '<button data-det-close class="px-4 py-2 bg-fb-card/60 hover:bg-fb-card border border-fb-border/50 rounded-xl text-sm text-fb-text">Cancel</button></div>' +
            '<div class="pt-3 border-t border-fb-border/50"><button data-det-remove class="w-full px-4 py-2 bg-fb-low/15 hover:bg-fb-low/30 border border-fb-low/40 rounded-xl text-sm text-fb-low">Remove from library</button></div>' +
            '</div>';
    }

    function wireDetails(drawer, song, st, vocab, render) {
        const $ = (s) => drawer.querySelector(s);
        drawer.querySelectorAll('[data-det-close]').forEach((b) => b.addEventListener('click', closeDetails));
        // Catalog inputs update state without a re-render (keep caret / focus).
        const bindInput = (id, key) => { const el = $('#' + id); if (el) el.addEventListener('input', () => { st[key] = el.value; }); };
        bindInput('det-title', 't'); bindInput('det-artist', 'a'); bindInput('det-album', 'al'); bindInput('det-year', 'y');
        const notes = $('#det-notes'); if (notes) notes.addEventListener('input', () => { st.notes = notes.value; });

        drawer.querySelectorAll('[data-diff]').forEach((b) => b.addEventListener('click', () => {
            const n = Number(b.getAttribute('data-diff'));
            st.diff = (st.diff === n ? null : n);   // click the active one to unset
            render();
        }));
        $('[data-diff-clear]')?.addEventListener('click', () => { st.diff = null; render(); });

        drawer.querySelectorAll('[data-tag-rm]').forEach((b) => b.addEventListener('click', () => {
            const t = b.getAttribute('data-tag-rm'); const i = st.tags.indexOf(t); if (i >= 0) st.tags.splice(i, 1); render();
        }));
        drawer.querySelectorAll('[data-tag-add]').forEach((b) => b.addEventListener('click', () => { if (addDetailTag(st, b.getAttribute('data-tag-add'))) render(); }));
        const addFromInput = () => { const el = $('#det-tag-input'); if (!el) return; if (addDetailTag(st, el.value)) { render(); drawer.querySelector('#det-tag-input')?.focus(); } };
        $('[data-tag-addbtn]')?.addEventListener('click', addFromInput);
        $('#det-tag-input')?.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); addFromInput(); } });

        const artWrap = $('[data-det-art]'); const artFile = $('#det-art-file');
        if (artWrap && artFile) {
            // Art click opens the cover PICKER (PR-C) — the old direct file
            // dialog lives on inside it as the Upload tile. The picker applies
            // immediately (its own routes + refresh), so it bypasses the
            // drawer's Save; the file-input path below stays as the fallback
            // when image-picker.js isn't loaded.
            artWrap.addEventListener('click', () => {
                if (window.__fbOpenImagePicker) {
                    window.__fbOpenImagePicker({ filename: song.filename, title: song.title || song.filename });
                } else {
                    artFile.click();
                }
            });
            artFile.addEventListener('change', () => {
                const f = artFile.files && artFile.files[0]; if (!f) return;
                const rd = new FileReader();
                rd.onload = (e) => { st.artDataUrl = e.target.result; const img = $('#det-art-preview'); if (img) { img.src = st.artDataUrl; img.style.visibility = 'visible'; } };
                rd.readAsDataURL(f);
            });
        }

        $('[data-det-fav]')?.addEventListener('click', async (e) => {
            try {
                const r = await fetch('/api/favorites/toggle', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ filename: song.filename }) });
                const d = await r.json(); st.fav = !!d.favorite;
                const btn = e.currentTarget; btn.textContent = st.fav ? '♥ Liked' : '♡ Like';
                btn.classList.toggle('text-fb-accent', st.fav); btn.classList.toggle('text-fb-textDim', !st.fav);
                _patchCardFav(song.filename, st.fav);
            } catch (_) { /* */ }
        });

        $('[data-det-save]')?.addEventListener('click', () => saveDetails(song, st));
        $('[data-det-remove]')?.addEventListener('click', () => removeFromLibrary(song));

        // Gap-fill (R4a): user-initiated write of CONFIRMED missing info into
        // the pack file. The server recomputes proposals under its io lock, so
        // a key that gained an author value since the preview is skipped.
        $('[data-gapfill-check]')?.addEventListener('click', async () => {
            st.gap = { loading: true }; render();
            let d = null;
            try { const r = await fetch('/api/song/' + enc(song.filename) + '/gap-fill'); if (r.ok) d = await r.json(); } catch (_) { /* offline */ }
            st.gap = d || { eligible: false, reason: 'error' };
            st.gapSel = new Set(((d && d.missing) || []).map((m) => m.key));
            render();
        });
        drawer.querySelectorAll('[data-gapfill-key]').forEach((cb) => cb.addEventListener('change', () => {
            const k = cb.getAttribute('data-gapfill-key');
            if (!st.gapSel) st.gapSel = new Set();
            if (cb.checked) st.gapSel.add(k); else st.gapSel.delete(k);
        }));
        $('[data-gapfill-cancel]')?.addEventListener('click', () => { st.gap = null; render(); });
        $('[data-gapfill-write]')?.addEventListener('click', async () => {
            const keys = st.gapSel ? Array.from(st.gapSel) : [];
            if (!keys.length) return;
            let d = null, ok = false;
            try {
                const r = await fetch('/api/song/' + enc(song.filename) + '/gap-fill', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ keys }) });
                ok = r.ok; d = await r.json();
            } catch (_) { /* offline */ }
            if (!ok || !d || !d.written) {
                if (window.fbNotify) { try { window.fbNotify.show({ title: 'Write failed', message: 'Could not write to the file. Please try again.', icon: '⚠️', accent: '#EF4444' }); } catch (e) { /* */ } }
                st.gap = null; render(); return;
            }
            // Reflect what landed in the open drawer (and keep saveDetails'
            // changed-detection honest by updating both sides), then refresh
            // the grid quietly.
            if (d.written.album != null) { st.al = String(d.written.album); song.album = st.al; }
            if (d.written.year != null) { st.y = String(d.written.year); song.year = d.written.year; }
            st.gap = { written: d.written }; render();
            try { reload(); } catch (_) { /* not on the songs grid */ }
        });
    }

    // Normalize + append a tag to the drawer's working set (mirrors the server's
    // _normalize_tag). Returns whether it was actually added (new + non-blank).
    function addDetailTag(st, raw) {
        const t = String(raw || '').trim().toLowerCase().replace(/\s+/g, ' ').slice(0, 60);
        if (!t || st.tags.includes(t)) return false;
        st.tags.push(t); st.tags.sort((a, b) => a.localeCompare(b)); return true;
    }

    // Keep a rendered card's heart in sync when the drawer toggles the like (the
    // heart is instant, not part of Save — matches the on-card heart).
    function _patchCardFav(fn, fav) {
        const sel = (window.CSS && CSS.escape) ? CSS.escape(fn) : fn;
        document.querySelectorAll('[data-fn="' + sel + '"] [data-fav]').forEach((btn) => {
            btn.textContent = fav ? '♥' : '♡';
            btn.setAttribute('aria-pressed', fav ? 'true' : 'false');
            // Swap exactly the idle colour this heart was rendered with (grid =
            // text-white, tree/List view = text-fb-textDim) — mirrors wireCards.
            // A hardcoded text-white toggle would leave List-View rows' text-fb-textDim
            // in place, so the heart changed glyph but stayed dim (never turned red).
            const idle = btn.getAttribute('data-fav-idle') || 'text-white';
            btn.classList.toggle('text-fb-accent', fav); btn.classList.toggle(idle, !fav);
        });
    }

    async function saveDetails(song, st) {
        const fn = song.filename;
        const catChanged = st.t.trim() !== (song.title || '') || st.a.trim() !== (song.artist || '')
            || st.al.trim() !== (song.album || '') || String(st.y).trim() !== (song.year != null ? String(song.year) : '');
        const ops = [];
        if (catChanged) ops.push(fetch('/api/song/' + enc(fn) + '/meta', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title: st.t.trim(), artist: st.a.trim(), album: st.al.trim(), year: String(st.y).trim() }) }));
        ops.push(fetch('/api/song/' + enc(fn) + '/user-meta', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ user_difficulty: st.diff, notes: st.notes, tags: st.tags }) }));
        if (st.artDataUrl) ops.push(fetch('/api/song/' + enc(fn) + '/art/upload', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ image: st.artDataUrl }) }));
        // Fire the writes concurrently but know each outcome — a failed write must not
        // look like a save. allSettled keeps partial results; treat a rejection OR a
        // non-ok HTTP response as failure and keep the drawer open so the user can retry.
        const results = await Promise.allSettled(ops);
        const failed = results.some((r) => r.status === 'rejected' || (r.value && r.value.ok === false));
        if (failed) {
            if (window.fbNotify) { try { window.fbNotify.show({ title: 'Save failed', message: 'Could not save your changes. Please try again.', icon: '⚠️', accent: '#EF4444' }); } catch (e) { /* */ } }
            return;
        }
        closeDetails();
        try { reload(); } catch (_) { /* not on the songs grid */ }
    }

    async function removeFromLibrary(song) {
        const title = song.title || song.filename;
        let ok;
        if (window._confirmDialog) {
            ok = await window._confirmDialog({
                title: 'Remove from library?',
                body: '<p class="text-sm text-gray-300">Remove <span class="font-semibold text-white">' + esc(title) + '</span> from your library?</p>' +
                    '<p class="text-xs text-red-400/90 mt-2">This permanently deletes the file from disk. This cannot be undone.</p>',
                confirmText: 'Remove', cancelText: 'Cancel', danger: true,
            });
        } else { ok = window.confirm('Remove "' + title + '" from your library? This deletes the file from disk.'); }
        if (!ok) return;
        try { const r = await fetch('/api/song/' + enc(song.filename), { method: 'DELETE' }); if (!r.ok) return; } catch (_) { return; }
        closeDetails();
        try { reload(); } catch (_) { /* */ }
    }

    // Expose the opener so the core `edit-metadata` card action opens this drawer
    // (it falls back to the legacy modal where this isn't defined).
    window.__fbOpenSongDetails = openDetails;

    // ── Artist Tidy-up (P4) ────────────────────────────────────────────────--
    // Merge messy artist variants ("ACDC" + "AC/DC") into one canonical name.
    // Aliases apply AT DISPLAY only (no file rewrite); the dropdown/tree/grid pick
    // up the change on the next load. Self-contained centered modal.
    function openArtistTidyUp() {
        const st = { raw: [], aliases: [], sel: new Set(), query: '', mergeInto: '', mergeTouched: false, busy: false };

        const overlay = document.createElement('div');
        overlay.className = 'fixed inset-0 z-[200] bg-black/60 backdrop-blur-sm flex items-center justify-center p-4';
        const onKey = (e) => { if (e.key === 'Escape') { e.preventDefault(); done(); } };
        function done() { overlay.remove(); document.removeEventListener('keydown', onKey); }
        document.addEventListener('keydown', onKey);
        overlay.addEventListener('click', (e) => { if (e.target === overlay) done(); });
        document.body.appendChild(overlay);

        async function refresh() {
            const [raw, aliases] = await Promise.all([jget('/api/artists/raw'), jget('/api/artist-aliases')]);
            st.raw = (raw && raw.artists) || [];
            st.aliases = (aliases && aliases.aliases) || [];
            render();
        }

        // Default canonical = the highest-count selected variant (the one most of
        // your library already uses), unless the user typed their own.
        function defaultCanonical() {
            let best = '', bestC = -1;
            st.raw.forEach((a) => { if (st.sel.has(a.name) && a.count > bestC) { bestC = a.count; best = a.name; } });
            return best;
        }

        function render() {
            if (!st.mergeTouched) st.mergeInto = defaultCanonical();
            const q = st.query.trim().toLowerCase();
            const list = st.raw.filter((a) => !q || (a.name || '').toLowerCase().includes(q));
            const rows = list.map((a) => {
                const checked = st.sel.has(a.name) ? ' checked' : '';
                const mapped = (a.canonical && a.canonical.toLowerCase() !== (a.name || '').toLowerCase())
                    ? '<span class="text-[0.6875rem] text-fb-primary ml-1">→ ' + esc(a.canonical) + '</span>' : '';
                return '<label class="flex items-center gap-2 px-2 py-1 rounded hover:bg-fb-card/50 cursor-pointer">' +
                    '<input type="checkbox" data-tidy-sel="' + esc(a.name) + '"' + checked + ' class="w-4 h-4 accent-fb-primary shrink-0">' +
                    '<span class="text-sm text-fb-text truncate flex-1">' + esc(a.name) + mapped + '</span>' +
                    '<span class="text-xs text-fb-textDim shrink-0">' + a.count + '</span></label>';
            }).join('') || '<div class="text-xs text-fb-textDim px-2 py-3">No artists</div>';

            const canReady = st.mergeInto.trim() && st.sel.size && !st.busy;
            const mergeBar = st.sel.size
                ? '<div class="pt-2 mt-2 border-t border-fb-border/50 space-y-2">' +
                  '<div class="text-xs text-fb-textDim">' + st.sel.size + ' selected — merge into:</div>' +
                  '<div class="flex gap-1"><input type="text" data-tidy-canon value="' + esc(st.mergeInto) + '" placeholder="Canonical name" class="flex-1 bg-fb-card border border-fb-border/60 rounded-lg px-3 py-1.5 text-sm text-fb-text outline-none focus:border-fb-primary/60">' +
                  '<button data-tidy-merge ' + (canReady ? '' : 'disabled') + ' class="text-sm px-3 rounded-lg ' + (canReady ? 'bg-fb-primary hover:bg-fb-primaryHi text-white' : 'bg-fb-card/50 text-fb-textDim cursor-not-allowed') + '">Merge</button></div></div>'
                : '';

            const aliasRows = st.aliases.length
                ? st.aliases.map((al) => '<div class="flex items-center gap-2 px-2 py-1 text-sm"><span class="text-fb-textDim truncate flex-1">' + esc(al.raw_name) + ' <span class="text-fb-textDim/60">→</span> ' + esc(al.canonical_name) + '</span>' +
                    '<button data-tidy-unmerge="' + esc(al.raw_name) + '" class="text-xs text-fb-textDim hover:text-fb-accent shrink-0">un-merge</button></div>').join('')
                : '<div class="text-xs text-fb-textDim px-2 py-2">No merges yet</div>';

            overlay.innerHTML =
                '<div class="bg-fb-sidebar border border-fb-border/60 rounded-2xl w-full max-w-md shadow-2xl max-h-[85vh] flex flex-col">' +
                '<div class="p-5 pb-3 flex items-center justify-between"><h3 class="text-base font-semibold text-fb-text">Tidy up artists</h3>' +
                '<button data-tidy-x aria-label="Close" class="text-fb-textDim hover:text-fb-text text-xl leading-none">✕</button></div>' +
                '<div class="px-5"><input type="text" data-tidy-search value="' + esc(st.query) + '" placeholder="Search artists…" class="w-full bg-fb-card border border-fb-border/60 rounded-lg px-3 py-1.5 text-sm text-fb-text outline-none focus:border-fb-primary/60 mb-1"></div>' +
                '<div class="px-3 overflow-y-auto v3-scroll flex-1 min-h-[6rem]">' + rows + '</div>' +
                '<div class="px-5">' + mergeBar + '</div>' +
                '<div class="px-5 pt-2"><div class="text-xs font-semibold uppercase tracking-wider text-fb-textDim mb-1">Current merges</div><div class="max-h-32 overflow-y-auto v3-scroll">' + aliasRows + '</div></div>' +
                '<div class="p-5 pt-3 flex justify-end"><button data-tidy-x class="text-sm px-4 py-2 bg-fb-card/60 hover:bg-fb-card border border-fb-border/50 rounded-xl text-fb-text">Done</button></div>' +
                '</div>';

            overlay.querySelectorAll('[data-tidy-x]').forEach((b) => b.addEventListener('click', done));
            const search = overlay.querySelector('[data-tidy-search]');
            if (search) search.addEventListener('input', () => { st.query = search.value; render(); const s = overlay.querySelector('[data-tidy-search]'); if (s) { s.focus(); const n = s.value.length; try { s.setSelectionRange(n, n); } catch (_) { /* */ } } });
            overlay.querySelectorAll('[data-tidy-sel]').forEach((cb) => cb.addEventListener('change', () => {
                const n = cb.getAttribute('data-tidy-sel');
                if (cb.checked) st.sel.add(n); else st.sel.delete(n);
                render();
            }));
            const canon = overlay.querySelector('[data-tidy-canon]');
            if (canon) canon.addEventListener('input', () => {
                st.mergeInto = canon.value; st.mergeTouched = true;
                const btn = overlay.querySelector('[data-tidy-merge]');
                if (btn) btn.disabled = !(st.mergeInto.trim() && st.sel.size && !st.busy);
            });
            overlay.querySelector('[data-tidy-merge]')?.addEventListener('click', doMerge);
            overlay.querySelectorAll('[data-tidy-unmerge]').forEach((b) => b.addEventListener('click', () => doUnmerge(b.getAttribute('data-tidy-unmerge'))));
        }

        async function doMerge() {
            const canonical = st.mergeInto.trim();
            if (!canonical || !st.sel.size || st.busy) return;
            st.busy = true;
            await jsend('POST', '/api/artist-aliases/merge', { raw_names: [...st.sel], canonical_name: canonical });
            st.sel.clear(); st.mergeTouched = false; st.busy = false;
            await afterChange();
        }

        async function doUnmerge(raw) {
            if (!raw) return;
            try { await fetch('/api/artist-aliases/' + enc(raw), { method: 'DELETE' }); } catch (_) { /* */ }
            await afterChange();
        }

        async function afterChange() {
            await refresh();
            // Reflect canonical names in the toolbar dropdown + grid immediately.
            try { await loadArtistCatalog(); refreshArtistAlbumSelects(); reload(); } catch (_) { /* not on the songs grid */ }
        }

        refresh();
    }

    // The host loads the Folder Library plugin's screen.js at startup (defining
    // window.folderLibrary). If it isn't present yet, inject it once; the
    // plugin's IIFEs are idempotent so a redundant evaluation is a no-op. The
    // promise is memoised so concurrent folder-view switches don't double-inject.
    let _flLoadPromise = null;
    function _ensureFolderLibrary() {
        if (window.folderLibrary) return Promise.resolve();
        if (_flLoadPromise) return _flLoadPromise;
        _flLoadPromise = new Promise((resolve, reject) => {
            const s = document.createElement('script');
            s.src = '/api/plugins/folder_library/screen.js';
            s.onload = () => resolve();
            s.onerror = () => { _flLoadPromise = null; reject(new Error('Failed to load Folder Library')); };
            document.head.appendChild(s);
        });
        return _flLoadPromise;
    }

    function reload() {
        _clearLibraryScrollSnapshot();
        // Record the state this fetch reflects so a later sidebar return can
        // tell whether the grid is stale (e.g. an off-screen search changed
        // state.q) and needs a refresh rather than a scroll-preserving no-op.
        state.renderedHash = _libraryStateHash();
        saveLibraryPrefs();
        updateFilterBadge();
        // A sort/filter/search/view change rebuilds the grid from page 0, so any
        // in-flight letter jump is now paging through a dataset that's about to
        // be discarded — supersede it so it can't scroll the rebuilt grid.
        _jumpToken++;
        // Keep a handle on the load so callers (notably the scroll restore on
        // screen re-entry) can await page-0 actually landing before paging
        // deeper. The visibility/scroll resets below stay synchronous.
        // Hide the SIZER (not the inner grid) for non-grid views, so its reserved
        // scroll height collapses and the tree/folder content sits at the top.
        document.getElementById('v3-songs-gridsizer')?.classList.toggle('hidden', state.view !== 'grid');
        document.getElementById('v3-songs-tree')?.classList.toggle('hidden', state.view !== 'tree');
        document.getElementById('lib-folder-tree')?.classList.toggle('hidden', state.view !== 'folder');
        document.getElementById('v3-songs-albums')?.classList.toggle('hidden', state.view !== 'albums');
        // Refresh the A–Z jump rail (shows only for the grid + alphabetical
        // sorts; hides itself otherwise). Independent of the grid load.
        refreshRail();
        // Refresh the practice-aware home (repertoire meter + keep-practicing
        // shelf); hides itself when searching/filtering/selecting or off-grid.
        updateLibraryHome();
        { const _fc = document.getElementById('lib-folder-controls'); if (_fc) _fc.style.display = state.view === 'folder' ? 'flex' : 'none'; }
        if (state.view === 'folder') {
            _applyMainScrollTop(0);
            return _ensureFolderLibrary().then(() => window.folderLibrary?.load());
        }
        const loaded = state.view === 'grid' ? loadGrid(true) : state.view === 'albums' ? loadAlbums() : loadTree();
        _applyMainScrollTop(0);
        return loaded;
    }

    // ── Chrome ────────────────────────────────────────────────────────────--
    async function loadProviders() {
        try {
            const lp = sm && sm.libraryProviders;
            // refresh() re-fetches /api/library/providers so REMOTE providers
            // (registered by feedBack-plugin-remote-library-*) appear — list()
            // returns only the capability's initial local-only snapshot.
            const fn = lp && (typeof lp.refresh === 'function' ? lp.refresh : (typeof lp.list === 'function' ? lp.list : null));
            if (fn) {
                const snap = await fn.call(lp);
                if (snap && Array.isArray(snap.providers)) {
                    state.provider = snap.current || (snap.providers[0] && snap.providers[0].id) || 'local';
                    return snap.providers;
                }
            }
        } catch (e) { /* */ }
        const data = await jget('/api/library/providers');
        return (data && data.providers) || [{ id: 'local', label: 'My Library' }];
    }

    async function render() {
        const root = document.getElementById('v3-songs');
        if (!root) return;
        // A full re-render (filter/scan refresh) replaces the DOM the card menu
        // anchored to; dismiss any open menu first so it can't float orphaned.
        if (_closeCardMenu) _closeCardMenu();
        // Restore last-used sort/format/view/filters once, before building the
        // toolbar so its selects reflect the saved choice (default: Artist A–Z).
        if (!_prefsRestored) { applySavedPrefs(); _prefsRestored = true; }
        const providers = await loadProviders();
        const [, tn] = await Promise.all([
            (async () => { state.accuracy = (await jget('/api/stats/best')) || {}; })(),
            jget('/api/library/tuning-names?provider=' + enc(state.provider)),
            loadArtistCatalog(),
        ]);
        state.tuningNames = (tn && tn.tunings) || [];
        try { const _g = await jget('/api/library/genres?provider=' + enc(state.provider)); state.genres = (_g && _g.genres) || []; } catch (e) { state.genres = []; }

        const opt = (arr, sel) => arr.map(([v, l]) => '<option value="' + esc(v) + '"' + (v === sel ? ' selected' : '') + '>' + esc(l) + '</option>').join('');
        const provOpts = providers.map((p) => '<option value="' + esc(p.id) + '"' + (p.id === state.provider ? ' selected' : '') + '>' + esc(p.label || p.id) + '</option>').join('');
        const ctrl = btnCtrl;

        root.innerHTML =
            '<div class="max-w-7xl mx-auto px-6 md:px-8 pb-8">' +
            '<div id="v3-songs-toolbar" class="sticky z-20 -mx-6 md:-mx-8 px-6 md:px-8 py-3 mb-4 bg-fb-sidebar/95 backdrop-blur border-b border-fb-border/40">' +
            '<div class="flex flex-col md:flex-row md:items-end justify-between gap-4">' +
            // The match-review chip is ambient tool-state (design §11): only
            // rendered when matches are waiting, silent otherwise. Populated +
            // shown by match-review.js (window.__fbMatchReviewChip), which
            // also owns the drawer the click opens.
            '<div class="flex items-baseline gap-3"><p class="text-fb-textDim text-sm" id="v3-songs-count"></p>' +
            '<button id="v3-songs-match-review" class="hidden text-xs text-fb-primary hover:text-fb-primaryHi border border-fb-primary/40 rounded-full px-2.5 py-0.5"></button></div>' +
            '<div class="flex flex-wrap gap-2">' +
            (providers.length > 1 ? '<select id="v3-songs-provider" class="' + ctrl + '">' + provOpts + '</select>' : '') +
            '<select id="v3-songs-artist" class="' + ctrl + ' max-w-[11rem]" aria-label="Artist">' + artistSelectHtml() + '</select>' +
            '<select id="v3-songs-album" class="' + ctrl + ' max-w-[11rem]" aria-label="Album"' + (state.artist ? '' : ' disabled') + '>' + albumSelectHtml() + '</select>' +
            '<div class="flex rounded-md overflow-hidden border border-gray-700"><button id="v3-songs-grid-btn" class="px-3 py-2 text-sm">▦</button><button id="v3-songs-tree-btn" class="px-3 py-2 text-sm">≣</button><button id="v3-songs-albums-btn" title="Albums" class="px-3 py-2 text-sm">💿</button><button id="v3-songs-folder-btn" class="px-3 py-2 text-sm" style="display:inline-flex;align-items:center;justify-content:center;box-sizing:border-box;width:2.25rem"><svg fill="currentColor" viewBox="0 0 16 16" style="width:12px;height:12px;flex-shrink:0"><path d="M1 3.5A1.5 1.5 0 012.5 2h3.086a1.5 1.5 0 011.06.44l.915.914H13.5A1.5 1.5 0 0115 4.914V12.5a1.5 1.5 0 01-1.5 1.5h-11A1.5 1.5 0 011 12.5v-9z"/></svg></button></div>' +
            '<select id="v3-songs-sort" class="' + ctrl + '">' + opt(SORTS, state.sort) + '</select>' +
            '<select id="v3-songs-format" class="' + ctrl + '">' + opt(FORMATS, state.format) + '</select>' +
            '<button id="v3-songs-filters" class="relative ' + ctrl + ' flex items-center gap-2">Filters<span id="v3-songs-filter-count" class="hidden bg-fb-primary text-white text-xs rounded-full px-1.5">0</span></button>' +
            '<button id="v3-songs-select" class="' + ctrl + (state.selectMode ? ' bg-fb-primary text-white' : '') + '">Select</button>' +
            '<button id="v3-songs-refresh" title="Refresh library (scan for new songs)" class="' + ctrl + '">⟳ Refresh</button>' +
            '<button id="v3-songs-upload" class="' + ctrl + '">Upload</button>' +
            '</div></div></div>' +
            // Practice-aware library home: a repertoire progress meter + a
            // "Keep practicing" shelf of started-but-not-mastered songs. Shown
            // only on the grid view when not searching/filtering/selecting
            // (renderLibraryHome + updateLibraryHome). Empty/absent → collapses.
            '<div id="v3-lib-home" class="hidden mb-5"></div>' +
            // Windowed grid: the sizer reserves the full-library scroll height;
            // #v3-songs-grid is absolutely positioned inside it and holds only the
            // visible window's cards (.v3-grid-window in v3.css).
            '<div id="v3-songs-gridsizer" class="relative">' +
            '<div id="v3-songs-grid" class="v3-grid-window grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-6 gap-4"></div>' +
            '</div>' +
            '<div id="v3-songs-tree" class="hidden"></div>' +
            '<div id="v3-songs-albums" class="hidden"></div>' +
            '<div id="lib-folder-controls" style="display:none"></div>' +
            '<div id="lib-folder-tree" class="space-y-1 hidden"></div>' +
            '<div id="v3-songs-sentinel" class="h-8"></div>' +
            // A–Z jump rail (grid + alphabetical sorts only; populated by
            // refreshRail). The bubble shows the current letter while dragging.
            '<nav id="v3-songs-azrail" class="v3-azrail hidden" aria-label="Jump to letter"></nav>' +
            '<div id="v3-songs-azbubble" class="v3-azbubble hidden" aria-hidden="true"></div>' +
            // Filter drawer + overlay
            '<div id="v3-songs-overlay" class="fixed inset-0 bg-black/50 z-40 hidden"></div>' +
            '<aside id="v3-songs-drawer" class="fixed top-0 right-0 h-full w-full sm:w-96 bg-fb-sidebar border-l border-fb-border/50 z-50 transform translate-x-full transition-transform duration-200 overflow-y-auto v3-scroll"></aside>' +
            '</div>';

        // Wire toolbar.
        const byId = (id) => document.getElementById(id);
        byId('v3-songs-provider')?.addEventListener('change', async (e) => {
            state.provider = e.target.value;
            state.artist = '';
            state.album = '';
            try { sm.libraryProviders && await sm.libraryProviders.select(state.provider); } catch (err) { /* */ }
            await loadArtistCatalog();
            refreshArtistAlbumSelects();
            reload();
        });
        byId('v3-songs-artist')?.addEventListener('change', (e) => setArtist(e.target.value));
        byId('v3-songs-album')?.addEventListener('change', (e) => setAlbum(e.target.value));
        byId('v3-songs-sort').addEventListener('change', (e) => { state.sort = e.target.value; reload(); });
        byId('v3-songs-format').addEventListener('change', async (e) => {
            state.format = e.target.value;
            await loadArtistCatalog();
            refreshArtistAlbumSelects();
            reload();
        });
        byId('v3-songs-filters').addEventListener('click', openDrawer);
        byId('v3-songs-overlay').addEventListener('click', closeDrawer);
        // Match-review chip: feature-detected (match-review.js owns the
        // drawer + the count; absent → the chip just stays hidden).
        byId('v3-songs-match-review')?.addEventListener('click', () => { if (window.__fbOpenMatchReview) window.__fbOpenMatchReview(); });
        if (window.__fbMatchReviewChip) window.__fbMatchReviewChip();
        byId('v3-songs-upload').addEventListener('click', () => {
            const legacy = document.getElementById('upload-songs-file');
            // Upload targets the LOCAL library + scan; watchUploadScan refreshes
            // the grid for the local provider. Uploading while browsing a remote
            // provider won't surface the new local songs — switching the grid to
            // local on upload is a P23 remote-provider follow-up.
            if (legacy) { legacy.click(); watchUploadScan(); }
        });
        byId('v3-songs-select').addEventListener('click', () => setSelectMode(!state.selectMode));
        byId('v3-songs-refresh')?.addEventListener('click', refreshLibrary);
        // Reflect a scan already in progress (Settings button or a background
        // pass) on the Refresh button, so its state isn't just tied to clicks here.
        (async () => {
            try {
                const r = await fetch('/api/scan-status');
                const sd = r.ok ? await r.json() : null;
                if (sd && sd.running) { _setRefreshState(sd); _watchScan({ announce: false }); }
            } catch (e) { /* */ }
        })();

        // Bulletproof multi-select: in select mode, a capture-phase click on the
        // grid toggles the card and STOPS the event, so nothing (a per-card
        // handler, a stray/legacy listener, an arrangement chip) can start
        // playback. Fixes "checkbox click opens the song / access-denied".
        const gridEl = byId('v3-songs-grid');
        if (gridEl) gridEl.addEventListener('click', (e) => {
            if (!state.selectMode) return;
            const card = e.target.closest('[data-fn]');
            if (!card || !gridEl.contains(card)) return;
            e.preventDefault();
            e.stopImmediatePropagation();
            toggleSelect(card.getAttribute('data-fn'), card);
        }, true);

        // Same bulletproof guard for the list/tree view. Without it, clicking a
        // song row (or its arrangement chip) in select mode falls through to the
        // per-card play handler and starts playback instead of selecting. The
        // <summary> group headers sit OUTSIDE any [data-fn], so closest() is null
        // for them and their native expand/collapse is left untouched.
        const treeEl = byId('v3-songs-tree');
        if (treeEl) treeEl.addEventListener('click', (e) => {
            if (!state.selectMode) return;
            const card = e.target.closest('[data-fn]');
            if (!card || !treeEl.contains(card)) return;
            e.preventDefault();
            e.stopImmediatePropagation();
            toggleSelect(card.getAttribute('data-fn'), card);
        }, true);
        const setView = async (v) => {
            state.view = v;
            byId('v3-songs-grid-btn').className = 'px-3 py-2 text-sm ' + (v === 'grid' ? 'bg-fb-primary text-white' : 'text-fb-textDim');
            byId('v3-songs-tree-btn').className = 'px-3 py-2 text-sm ' + (v === 'tree' ? 'bg-fb-primary text-white' : 'text-fb-textDim');
            byId('v3-songs-folder-btn').className = 'px-3 py-2 text-sm ' + (v === 'folder' ? 'bg-fb-primary text-white' : 'text-fb-textDim');
            { const ab = byId('v3-songs-albums-btn'); if (ab) ab.className = 'px-3 py-2 text-sm ' + (v === 'albums' ? 'bg-fb-primary text-white' : 'text-fb-textDim'); }
            if (v === 'folder') await _ensureFolderLibrary();
            return reload();
        };
        byId('v3-songs-grid-btn').addEventListener('click', () => setView('grid'));
        byId('v3-songs-tree-btn').addEventListener('click', () => setView('tree'));
        byId('v3-songs-folder-btn').addEventListener('click', () => setView('folder'));
        byId('v3-songs-albums-btn')?.addEventListener('click', () => setView('albums'));
        // Await the initial load so a caller awaiting render() (the scroll
        // restore on screen re-entry) sees a populated grid + real state.total
        // before it tries to page deeper.
        await setView(state.view);
        bindScroll();
        bindGridResize();
        positionToolbar();
        bindToolbarReflow();
        updateFilterBadge();
        state.built = true;
    }

    async function onV3SongsScreenEnter() {
        // A library scan / DLC-folder change marked the grid stale — re-fetch
        // from scratch instead of restoring a cached (possibly empty, pre-DLC)
        // snapshot. Must win over every fast-path below.
        if (_libraryDirty) { _libraryDirty = false; await reload(); return; }
        // Pull in any scores recorded while the library was off-screen (the usual
        // play→return flow) before the fast-paths below restore the cached DOM,
        // so the just-played song's badge is current. The full render() path
        // re-fetches accuracy itself, so this is a no-op cost there.
        await applyScoreRefresh();
        const snap = _readLibraryScrollSnapshot();
        const hashMatch = !!(snap && snap.hash === _libraryStateHash());
        const domReady = state.built && !!document.getElementById('v3-songs-grid');
        const chromeOk = _chromeIntact();
        const viewOk = state.view === (snap && snap.view ? snap.view : state.view);

        if (snap && hashMatch && domReady && chromeOk && viewOk) {
            if (state.view === 'grid' && _gridDomIntact()) {
                // Geometry is stable (the sizer still holds the full height from
                // the prior session), so restore is just: restore scrollTop, then
                // repaint the window that maps to it. No more page-through.
                document.getElementById('v3-songs-gridsizer')?.classList.toggle('hidden', false);
                document.getElementById('v3-songs-tree')?.classList.toggle('hidden', true);
                syncChromeFromState();
                updateLibraryHome();   // select-mode clear on leave re-shows the home block
                _applyMainScrollTop(snap.scrollTop || 0);
                requestWindowRender();
                _clearLibraryScrollSnapshot();
                return;
            }
            if (state.view === 'tree' && _treeDomIntact()) {
                document.getElementById('v3-songs-gridsizer')?.classList.toggle('hidden', true);
                document.getElementById('v3-songs-tree')?.classList.toggle('hidden', false);
                syncChromeFromState();
                _applyMainScrollTop(snap.scrollTop || 0);
                _clearLibraryScrollSnapshot();
                return;
            }
        }

        // Sidebar return without a player snapshot — keep grid, refresh chrome.
        if (!snap && domReady && chromeOk && state.built) {
            syncChromeFromState();
            // If state drifted while we were away (notably an off-screen topbar
            // search updating state.q), the persisted grid is stale — refetch
            // instead of silently showing the old results. Unchanged state keeps
            // the scroll-preserving no-op.
            if (state.renderedHash !== _libraryStateHash()) { reload(); return; }
            document.getElementById('v3-songs-gridsizer')?.classList.toggle('hidden', state.view !== 'grid');
            document.getElementById('v3-songs-tree')?.classList.toggle('hidden', state.view !== 'tree');
            document.getElementById('lib-folder-tree')?.classList.toggle('hidden', state.view !== 'folder');
            { const _fc = document.getElementById('lib-folder-controls'); if (_fc) _fc.style.display = state.view === 'folder' ? 'flex' : 'none'; }
            updateLibraryHome();   // select-mode clear on leave re-shows the home block
            // Re-render in case the viewport resized while we were away (column
            // count / row height may have changed) or select mode was cleared.
            if (state.view === 'grid') requestWindowRender();
            return;
        }

        const snapToRestore = hashMatch ? snap : null;
        if (snap && !hashMatch) _clearLibraryScrollSnapshot();
        await render();
        if (snapToRestore && snapToRestore.hash === _libraryStateHash()) {
            // render() built + sized the sizer at scrollTop 0; move to the saved
            // position and let the scroll handler repaint that window.
            _applyMainScrollTop(snapToRestore.scrollTop || 0);
            if (state.view === 'grid') requestWindowRender();
        }
        _clearLibraryScrollSnapshot();
    }

    // After an upload click-through (which reuses the legacy uploader +
    // background scan), poll /api/scan-status and reload the v3 grid once the
    // scan we triggered finishes — the legacy uploader only refreshes the
    // legacy screens, so without this newly-uploaded songs wouldn't appear in
    // v3 until a manual refresh. Bounded so a no-op upload can't poll forever.
    let _uploadScanTimer = null;
    // ── Library refresh (rescan) from the Songs toolbar ───────────────────────
    // The tester ask: a media-server-style "I dropped files in my folder, hit
    // refresh" button, with live progress. Reuses the SAME machinery the Settings
    // Rescan buttons drive (/api/rescan + /api/scan-status) and emits
    // library:changed so the grid reloads. A scan already running (Settings or a
    // background pass) is reflected on the button too.
    let _refreshPoll = null;
    function _setRefreshState(sd) {
        const btn = document.getElementById('v3-songs-refresh');
        if (!btn) return;
        if (sd && sd.running) {
            // Determinate count only exists in the 'scanning' stage; 'listing' is
            // indeterminate (total 0), so show a plain "Scanning…" then.
            const det = (sd.stage === 'scanning' && sd.total) ? ' ' + sd.done + '/' + sd.total : '';
            btn.textContent = '⟳ Scanning' + det + '…';
            btn.disabled = true;
            btn.classList.add('opacity-70');
            const pct = sd.total ? Math.round((sd.done / sd.total) * 100) + '% · ' : '';
            btn.title = 'Scanning new/changed songs… ' + pct + (sd.current || '');
        } else {
            btn.textContent = '⟳ Refresh';
            btn.disabled = false;
            btn.classList.remove('opacity-70');
            btn.title = 'Refresh library (scan for new songs)';
        }
    }
    // Show a completion toast (reuses the shared fbNotify surface), suppressed
    // while in a song. Honest + never-punishing copy: shows the "N added / M
    // removed" delta from the scan when there is one, else "up to date".
    function _scanCompleteToast(sd) {
        if (document.querySelector('.screen.active') && document.querySelector('.screen.active').id === 'player') return;
        if (!window.fbNotify) return;
        const added = (sd && sd.added) || 0, removed = (sd && sd.removed) || 0;
        let msg;
        if (sd && sd.error) msg = 'Scan finished with an error';
        else if (added || removed) {
            const parts = [];
            if (added) parts.push(added + ' song' + (added === 1 ? '' : 's') + ' added');
            if (removed) parts.push(removed + ' removed');
            msg = parts.join(' · ');
        } else msg = 'Your library is up to date';
        try { window.fbNotify.show({ title: 'Library scan complete', message: msg, icon: '🔄', accent: '#22C55E' }); } catch (e) { /* */ }
    }
    // Poll scan-status until the scan finishes, driving the button state. On
    // completion, emit library:changed (grid reloads via the listener below) and,
    // for a user-initiated refresh (announce), show the toast. announce:false is
    // used when we only attached to a scan we didn't start.
    function _watchScan(opts) {
        if (_refreshPoll) return;
        const announce = !opts || opts.announce !== false;
        let sawRunning = false, ticks = 0;
        _refreshPoll = setInterval(async () => {
            ticks++;
            let sd = null;
            try { const r = await fetch('/api/scan-status'); if (r.ok) sd = await r.json(); } catch (e) { /* */ }
            _setRefreshState(sd);
            if (sd && sd.running) sawRunning = true;
            // A user-initiated refresh that never saw a running scan = nothing to
            // do (already up to date); give prompt feedback instead of waiting.
            const noopDone = announce && !sawRunning && ticks >= 3;
            if ((sawRunning && sd && !sd.running) || noopDone || ticks >= 180) {
                clearInterval(_refreshPoll); _refreshPoll = null;
                _setRefreshState(null);
                const hasDelta = sd && (((sd.added || 0) > 0) || ((sd.removed || 0) > 0));
                if (sawRunning && window.feedBack) { try { window.feedBack.emit('library:changed', { reason: 'rescan', added: (sd && sd.added) || 0, removed: (sd && sd.removed) || 0 }); } catch (e) { /* */ } }
                // A user-initiated refresh always confirms; a scan we only attached
                // to (background / Settings) toasts just when it changed something,
                // so a periodic no-op pass stays silent.
                if (announce || hasDelta) _scanCompleteToast(sd);
            }
        }, 1000);
    }
    async function refreshLibrary() {
        if (_refreshPoll) return;                 // a scan is already in progress
        try { await fetch('/api/rescan', { method: 'POST' }); } catch (e) { /* */ }
        _watchScan({ announce: true });
    }

    function watchUploadScan() {
        if (_uploadScanTimer) clearInterval(_uploadScanTimer);
        let sawRunning = false, ticks = 0;
        _uploadScanTimer = setInterval(async () => {
            ticks++;
            let sd = null;
            try { const r = await fetch('/api/scan-status'); if (r.ok) sd = await r.json(); } catch (e) { /* */ }
            if (sd && sd.running) sawRunning = true;
            if ((sawRunning && sd && !sd.running) || ticks >= 90) {
                clearInterval(_uploadScanTimer); _uploadScanTimer = null;
                if (sawRunning) reload();
            }
        }, 1000);
    }

    // Topbar search drives this screen.
    async function search(q) {
        state.q = q || '';
        if (songsActive()) {
            await loadArtistCatalog();
            refreshArtistAlbumSelects();
            reload();
        } else if (window.showScreen) {
            window.showScreen('v3-songs');
        }
    }

    window.v3Songs = {
        render: render,
        reload: reload,
        search: search,
        setQuery: (q) => { state.q = q || ''; },
        getSort: () => state.sort,
        getArtist: () => state.artist,
        getAlbum: () => state.album,
        // The grid is windowed: only a slice of cards is in the DOM at any time.
        // A plugin that decorates cards should read THIS (not a global
        // querySelectorAll that assumes every card is present) and re-run on each
        // `v3:library-window-rendered` event rather than once at load.
        visibleCards: () => document.querySelectorAll('#v3-songs-grid [data-fn]'),
        filterParams: () => {
            const f = state.filters;
            const p = new URLSearchParams();
            if (f.arr_has.length)   p.set('arrangements_has',   f.arr_has.join(','));
            if (f.arr_lacks.length) p.set('arrangements_lacks', f.arr_lacks.join(','));
            if (f.stem_has.length)  p.set('stems_has',          f.stem_has.join(','));
            if (f.stem_lacks.length) p.set('stems_lacks',       f.stem_lacks.join(','));
            if (f.lyrics)           p.set('has_lyrics',         f.lyrics);
            if (f.tunings.length)   p.set('tunings',            f.tunings.join(','));
            return p.toString();
        },
        _scrollHelpers: {
            SCROLL_STATE_KEY,
            buildLibraryStateHash,
            readSnapshot: _readLibraryScrollSnapshot,
            clearSnapshot: _clearLibraryScrollSnapshot,
        },
    };

    if (sm && typeof sm.on === 'function') {
        sm.on('screen:changed', (e) => {
            const id = e && e.detail && e.detail.id;
            if (id === 'v3-songs') { onV3SongsScreenEnter(); return; }
            // Leaving Songs: tear down select mode + the body-mounted batch bar,
            // so an active multi-selection doesn't leave a floating bar (and
            // stale selection) visible on unrelated screens.
            if (state.selectMode || state.selected.size) {
                state.selectMode = false;
                state.selected.clear();
                const bar = document.getElementById('v3-songs-batch');
                if (bar) bar.remove();
            }
        });
        // stats-recorder POSTs the score asynchronously and emits this once the
        // server has the new best — that's the correct moment to refresh the
        // badge (song:stop fires before the POST resolves, so it's too early).
        // If the library is visible right now, repaint immediately; otherwise
        // mark it dirty and onV3SongsScreenEnter applies it on return.
        sm.on('stats:recorded', (e) => {
            // Decode to the library-card key space — the event carries the
            // encodeURIComponent'd filename, but cards (data-fn) and
            // state.accuracy key on the decoded library filename. Without this
            // the repaint below (and applyScoreRefresh's repaintAccuracy) match
            // no card, so a just-earned score stays invisible until a full
            // render() (restart / search / re-enter), which is this bug.
            const fn = decFn(e && e.detail && e.detail.filename);
            if (!fn) return;
            _dirtyScores.add(fn);
            // Only repaint now if the library is the active screen; otherwise
            // leave it dirty for onV3SongsScreenEnter (applyScoreRefresh clears
            // the set, so repainting against a hidden grid would drop the update).
            const active = document.querySelector('.screen.active');
            if (active && active.id === 'v3-songs') applyScoreRefresh();
        });
        // A library scan (rescan / full rescan from Settings, or a DLC-folder
        // change) can add or remove songs while this grid is cached — the
        // Settings rescan only refreshed the classic library, so the v3 grid
        // stayed on its pre-scan (e.g. empty, pre-DLC) state until an app
        // restart. Reload now if we're showing; otherwise mark dirty so the next
        // entry re-fetches instead of restoring the stale snapshot.
        sm.on('library:changed', () => {
            const active = document.querySelector('.screen.active');
            if (active && active.id === 'v3-songs') { _libraryDirty = false; reload(); }
            else _libraryDirty = true;
        });
        // Your live tuning changed (retune / instrument swap / reset) → re-colour the
        // visible tuning chips against the new tuning. Cheap: re-decorates in place,
        // no re-fetch or re-paint. No-op off the Songs grid or without the capability.
        sm.on('working-tuning-changed', () => {
            if (typeof songsActive === 'function' && !songsActive()) return;
            if (state.view !== 'grid') return;
            decorateTuningChips(_gridEl());
        });
    }
})();
