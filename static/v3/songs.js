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
    const btnCtrl = 'bg-gray-800/50 border border-gray-700 rounded-md px-3 py-2 text-sm text-fb-text outline-none focus:border-fb-primary';

    const state = {
        provider: 'local', view: 'grid', sort: 'artist', format: '', q: '',
        artist: '', album: '',
        filters: { arr_has: [], arr_lacks: [], stem_has: [], stem_lacks: [], lyrics: '', tunings: [] },
        page: 0, total: 0, loading: false, built: false, accuracy: {}, tuningNames: [],
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
            (f.lyrics ? 1 : 0) + f.tunings.length + (state.artist ? 1 : 0) + (state.album ? 1 : 0);
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
            },
        });
    }

    function _libraryStateHash() { return buildLibraryStateHash(state); }

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
    // Both read data we already have: state.accuracy (/api/stats/best =
    // {filename: best_accuracy}) and /api/stats/recent. A song is "in your
    // repertoire" at the same threshold the green accuracy badge uses (>= 0.9);
    // a started song below that is "in progress". This is descriptive
    // encouragement — it never gates content, decays, or nags (the goal-gradient
    // / endowed-progress idea, kept healthy).
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
    // local practice stats (state.accuracy / /api/stats/recent), so on a remote
    // provider they'd mix local numerators with a remote song total and play
    // local files while browsing a remote library. Hide it there.
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
        // recently-played rows for the shelf, fetched together.
        const [stats, recent] = await Promise.all([
            jget('/api/library/stats?provider=' + enc(state.provider)),
            jget('/api/stats/recent?limit=24'),
        ]);
        if (_homeToken !== myToken || !libHomeVisible()) {            // changed mid-fetch
            if (_homeToken === myToken) host.classList.add('hidden');
            return;
        }
        const total = (stats && (stats.total_songs ?? stats.total)) || 0;
        if (total <= 0) { host.classList.add('hidden'); return; }    // empty library
        // Shelf = recently-played, not-yet-mastered songs, newest first. Mastery
        // is per-SONG (state.accuracy = MAX best across arrangements, what the
        // green badge shows) — recents are per-(song,arrangement), so dedupe by
        // filename and gate on the song's best, keeping the shelf and its badges
        // consistent (no green-badged "keep practicing" card, no dupes).
        const acc = state.accuracy || {};
        const seen = new Set();
        const shelf = (Array.isArray(recent) ? recent : [])
            .filter((r) => {
                if (!r || seen.has(r.filename)) return false;
                const best = acc[r.filename];
                if (typeof best !== 'number' || best >= MASTERY_ACCURACY) return false;
                seen.add(r.filename);
                return true;
            })
            .slice(0, 8);

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
        // Wire shelf cards → play (mirrors playCard's local path; recents are
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
        return '<span class="absolute bottom-0 left-0 ' + c + ' text-[9px] font-bold px-1.5 py-0.5 rounded-tr-md tracking-wide">' + l + '</span>';
    }

    // Clickable arrangement chips — one <button data-arr="<index>"> per
    // arrangement. wireCards() binds the click to playCard(song, index), which
    // opens THAT arrangement in the highway via playSong(filename, index).
    // Shared by the grid card and the tree row so both views render the same
    // badges with the same click-to-open behaviour. Capped at 4 to match the
    // card layout.
    function arrChipsHtml(song) {
        return (song.arrangements || []).slice(0, 4).map((a) =>
            '<button data-arr="' + esc(a.index != null ? a.index : '') + '" title="Play ' + esc(a.name) + '" class="text-[10px] px-1.5 py-0.5 rounded bg-gray-800/60 text-fb-textDim hover:bg-fb-primary hover:text-white transition">' + esc(a.name) + '</button>').join('');
    }

    function songCard(song) {
        const fav = song.favorite;
        const key = cardKey(song);
        // In select mode the checkbox occupies top-2 left-2, so shift the
        // tuning chip right (left-9) to avoid overlapping it.
        const tuningLabel = (typeof window.displayTuningName === 'function')
            ? window.displayTuningName(song.tuning_name || song.tuning)
            : (song.tuning_name || '');
        let tuning = '';
        if (tuningLabel) {
            const rawOffsets = (typeof window.parseRawTuningOffsets === 'function')
                ? (window.parseRawTuningOffsets(song.tuning_offsets)
                    || window.parseRawTuningOffsets(song.tuning_name || song.tuning))
                : null;
            const targetNotes = (tuningLabel === 'Custom Tuning' && rawOffsets
                && typeof window.displayTuningTargets === 'function')
                ? window.displayTuningTargets(rawOffsets, { tuningName: tuningLabel })
                : '';
            const badgeTitle = targetNotes
                ? ('Custom Tuning: ' + targetNotes)
                : tuningLabel;
            const pos = 'absolute top-2 ' + (state.selectMode ? 'left-9' : 'left-2');
            if (targetNotes) {
                tuning = '<span class="' + pos + ' bg-fb-mid text-black text-[9px] font-bold px-1.5 py-0.5 rounded-sm leading-tight max-w-[5.5rem] text-center" title="' + esc(badgeTitle) + '">'
                    + esc('Custom Tuning') + '<br><span class="font-semibold tracking-wide">' + esc(targetNotes) + '</span></span>';
            } else {
                tuning = '<span class="' + pos + ' bg-fb-mid text-black text-[10px] font-bold px-1.5 py-0.5 rounded-sm" title="' + esc(badgeTitle) + '">' + esc(tuningLabel) + '</span>';
            }
        }
        // Display-only (pointer-events-none) so a click falls through to the
        // card's data-v3-play handler, which owns the toggle — avoids double-toggle.
        const checkbox = state.selectMode
            ? '<input type="checkbox" data-select class="absolute top-2 left-2 z-20 w-5 h-5 accent-fb-primary pointer-events-none"' + (state.selected.has(key) ? ' checked' : '') + '>'
            : '';
        const arrChips = arrChipsHtml(song);
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
            '<img src="' + esc(artUrl(song)) + '" alt="" loading="lazy" decoding="async" class="w-full h-full object-cover transition-transform duration-300 group-hover:scale-105" onerror="this.style.visibility=\'hidden\'">' +
            tuning + checkbox + accuracyBadge(key) + fmtBadge(song) + overlay +
            '<div class="absolute top-2 right-2 flex gap-1 opacity-0 group-hover:opacity-100 transition">' +
            inlineBtns +
            '<button data-fav title="Favorite" aria-label="Favorite" aria-pressed="' + (fav ? 'true' : 'false') + '" class="w-7 h-7 rounded-full bg-black/50 hover:bg-black/70 flex items-center justify-center text-sm ' + (fav ? 'text-fb-accent' : 'text-white') + '">' + (fav ? '♥' : '♡') + '</button>' +
            '<button data-save title="Save for later" aria-label="Save for later" class="w-7 h-7 rounded-full bg-black/50 hover:bg-black/70 flex items-center justify-center text-white text-sm">🔖</button>' +
            '<button data-menu title="More" aria-label="More actions" class="w-7 h-7 rounded-full bg-black/50 hover:bg-black/70 flex items-center justify-center text-white text-sm leading-none">⋮</button>' +
            '</div></div>' +
            '<div class="mt-1 text-sm text-fb-text truncate" title="' + esc(song.title) + '">' + esc(song.title) + '</div>' +
            '<div class="text-xs text-fb-textDim truncate">' + esc(song.artist) + '</div>' +
            // Always emit the chip row (even when empty) at a FIXED single-line
            // height — uniform card height is what makes the windowed grid's
            // absolute-position math exact (.v3-card-chips in v3.css).
            '<div class="v3-card-chips flex gap-1 mt-1">' + arrChips + '</div>' +
            '</div>';
    }

    // Per-card action menu, built from the ui.library-card-injection registry
    // (core Edit/Retune + any plugin-registered actions).
    let _closeCardMenu = null;   // tears down the currently-open card menu + its document closer
    function openCardMenu(cardEl, song, anchorBtn) {
        // Fully close any already-open menu first — removing just the DOM node
        // (as before) would orphan its document-level click closer.
        if (_closeCardMenu) _closeCardMenu();
        const reg = sm && sm.libraryCardActions;
        // Only show actions intended for the overflow menu — actions placed
        // 'inline'/'overlay' get their own affordances on the card (see songCard).
        // Undefined placement defaults to the menu.
        const items = (reg ? reg.list(song) : []).filter((a) => !a.placement || a.placement === 'menu');
        const menu = document.createElement('div');
        menu.className = 'v3-card-menu absolute top-10 right-2 z-30 min-w-[10rem] bg-fb-card border border-fb-border/60 rounded-lg shadow-xl py-1 text-sm';
        const rows = [
            { id: '__play', label: 'Play', run: () => { _saveLibraryScrollSnapshot(); window.playSong && window.playSong(enc(song.filename)); } },
            { id: '__playlist', label: 'Add to playlist' },
            ...items.map((a) => ({ id: a.id, label: a.label, destructive: a.destructive, enabled: a.enabled, plugin: a.pluginId })),
        ];
        menu.innerHTML = rows.map((r) =>
            '<button data-act="' + esc(r.id) + '" class="w-full text-left px-3 py-1.5 hover:bg-fb-card/60 ' +
            (r.enabled === false ? 'opacity-40 cursor-not-allowed ' : '') +
            (r.destructive ? 'text-fb-accent' : 'text-fb-text') + '">' + esc(r.label) +
            (r.plugin && r.plugin !== 'core' ? '<span class="text-[10px] text-fb-textDim ml-1">' + esc(r.plugin) + '</span>' : '') + '</button>').join('');
        cardEl.appendChild(menu);
        // Tear down BOTH the menu and its document-level closer together, so a
        // menu-item click doesn't leave the closer attached (it would otherwise
        // leak, retaining this menu's closures until the next document click).
        const closer = (e) => { if (!menu.contains(e.target) && e.target !== anchorBtn) closeMenu(); };
        function closeMenu() { menu.remove(); document.removeEventListener('click', closer); if (_closeCardMenu === closeMenu) _closeCardMenu = null; }
        _closeCardMenu = closeMenu;
        menu.querySelectorAll('[data-act]').forEach((b) => b.addEventListener('click', async (e) => {
            e.stopPropagation();
            const id = b.getAttribute('data-act');
            closeMenu();
            if (id === '__play') { playCard(song); return; }
            if (id === '__playlist') { await addFilenamesToPlaylist([song.filename]); return; }
            if (reg) await reg.run(id, song, { source: 'v3-songs' });
        }));
        setTimeout(() => document.addEventListener('click', closer), 0);
    }

    function wireCards(scope) {
        scope.querySelectorAll('[data-fn]').forEach((el) => {
            if (el.dataset.wired) return;   // don't double-bind on append/auto-fill
            el.dataset.wired = '1';
            const fn = el.getAttribute('data-fn');
            const song = state.songsById[fn] || { filename: fn };
            el.querySelectorAll('[data-v3-play]').forEach((pe) => pe.addEventListener('click', (e) => {
                if (state.selectMode) { e.preventDefault(); toggleSelect(fn, el); return; }
                playCard(song);   // local → play; unsynced remote → sync then play
            }));
            el.querySelector('[data-menu]')?.addEventListener('click', (e) => { e.stopPropagation(); openCardMenu(el, song, e.currentTarget); });
            el.querySelectorAll('[data-arr]').forEach((ab) => ab.addEventListener('click', (e) => {
                e.stopPropagation();
                const idx = ab.getAttribute('data-arr');
                playCard(song, idx === '' ? undefined : Number(idx));
            }));
            el.querySelector('[data-fav]')?.addEventListener('click', async (e) => {
                e.stopPropagation();
                const btn = e.currentTarget;
                try {
                    const r = await fetch('/api/favorites/toggle', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ filename: fn }) });
                    const d = await r.json();
                    btn.textContent = d.favorite ? '♥' : '♡';
                    btn.setAttribute('aria-pressed', d.favorite ? 'true' : 'false');
                    btn.classList.toggle('text-fb-accent', d.favorite);
                    btn.classList.toggle('text-white', !d.favorite);
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
            '<button data-batch="saved" class="text-sm bg-fb-card/60 hover:bg-fb-card border border-fb-border/50 text-fb-text px-3 py-1 rounded-full">Save for Later</button>' +
            '<button data-batch="clear" class="text-sm text-fb-textDim hover:text-fb-text px-2">Clear</button>';
        bar.querySelector('[data-batch="clear"]').addEventListener('click', () => { state.selected.clear(); reload(); renderBatchBar(); });
        bar.querySelector('[data-batch="saved"]').addEventListener('click', batchSave);
        bar.querySelector('[data-batch="playlist"]').addEventListener('click', batchAddToPlaylist);
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

    // Prompt for a target playlist (pick a listed number, or type a new name to
    // create it) and add the given song filenames to it. Shared by the
    // select-mode batch bar and the per-card ⋮ menu's single-song add. Returns
    // the playlist id (or null if cancelled).
    async function addFilenamesToPlaylist(filenames) {
        const fns = Array.from(filenames || []);
        if (!fns.length) return null;
        const lists = (await jget('/api/playlists')) || [];
        const choices = lists.filter((p) => !p.system_key);
        const labels = choices.map((p, i) => (i + 1) + '. ' + p.name).join('   ');
        const ans = ((await window.uiPrompt({
            title: 'Add ' + fns.length + ' song' + (fns.length === 1 ? '' : 's') + ' to a playlist',
            label: (labels ? labels + ' ' : '') + 'Type a number above, or a new playlist name:',
            okLabel: 'Add',
            placeholder: 'Number or new playlist name',
        })) || '').trim();
        if (!ans) return null;
        let pid = null;
        const num = parseInt(ans, 10);
        if (!isNaN(num) && choices[num - 1]) pid = choices[num - 1].id;
        else { const created = await jsend('POST', '/api/playlists', { name: ans }); pid = created && created.id; }
        if (!pid) return null;
        for (const fn of fns) {
            try { await fetch('/api/playlists/' + pid + '/songs', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ filename: fn }) }); } catch (e) { /* */ }
        }
        if (window.v3Playlists) { try { window.v3Playlists.refresh(); } catch (e) { /* */ } }
        return pid;
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
        const stats = await jget('/api/library/stats?' + queryParams({ sort_letters: 1 }).toString());
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
    async function jumpToLetter(letter) {
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
        main.scrollTo({ top, behavior: 'smooth' });
        requestWindowRender();
    }

    function bindRailOnce() {
        const rail = railEl();
        if (!rail || rail._bound) return;
        rail._bound = true;
        let dragging = false, moved = false, lastDrag = null;
        const letterAtY = (y) => {
            const els = rail.querySelectorAll('.v3-azrail-letter');
            if (!els.length) return null;
            for (const el of els) { const r = el.getBoundingClientRect(); if (y >= r.top && y <= r.bottom) return el; }
            return y < els[0].getBoundingClientRect().top ? els[0] : els[els.length - 1]; // clamp past ends
        };
        rail.addEventListener('click', (e) => {
            const btn = e.target.closest('.v3-azrail-letter');
            if (!btn || btn.disabled) return;
            if (moved) { moved = false; return; }   // a drag already handled it
            jumpToLetter(btn.getAttribute('data-letter'));
        });
        rail.addEventListener('pointerdown', (e) => {
            const btn = e.target.closest('.v3-azrail-letter');
            if (!btn) return;
            dragging = true; moved = false; lastDrag = null;
            try { rail.setPointerCapture(e.pointerId); } catch (_) { /* */ }
            _showBubble(btn.getAttribute('data-letter'));
        });
        rail.addEventListener('pointermove', (e) => {
            if (!dragging) return;
            const el = letterAtY(e.clientY);
            if (!el || el.disabled) return;
            moved = true;
            const L = el.getAttribute('data-letter');
            _showBubble(L);
            if (L !== lastDrag) { lastDrag = L; jumpToLetter(L); }  // only on change
        });
        const end = () => { dragging = false; _hideBubble(); };
        rail.addEventListener('pointerup', end);
        rail.addEventListener('pointercancel', end);
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
    async function loadTree() {
        const host = document.getElementById('v3-songs-tree');
        if (!host) return;
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
        host.innerHTML = artists.map((a) =>
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
                    (fl ? '<span class="text-[9px] font-bold px-1 py-0.5 rounded shrink-0 ' + (fl === 'FEEDPAK' ? 'bg-fb-primary/20 text-fb-primary' : 'bg-fb-card text-fb-textDim') + '">' + fl + '</span>' : '') +
                    accuracyBadge(k, 'tree') +
                    // Same fav / save-for-later / overflow-menu cluster as the grid
                    // card. Always shown (like the arrangement chips), not hover-
                    // revealed. wireCards() binds all three for any [data-fn].
                    '<div class="flex items-center gap-0.5 shrink-0">' +
                    '<button data-fav title="Favorite" aria-label="Favorite" aria-pressed="' + (s.favorite ? 'true' : 'false') + '" class="px-1 ' + (s.favorite ? 'text-fb-accent' : 'text-fb-textDim') + '">' + (s.favorite ? '♥' : '♡') + '</button>' +
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
            // Collections always replay against the LOCAL library, so only offer
            // "save" when browsing local with a non-empty filter set.
            (state.provider === 'local' && Object.keys(currentFilterRules()).length
                ? '<div class="pt-3 border-t border-fb-border/50"><button data-drawer-save class="w-full text-sm text-fb-primary hover:text-fb-primaryHi border border-fb-primary/40 rounded-md py-2">＋ Save as collection</button></div>'
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
        d.querySelector('[data-drawer-save]')?.addEventListener('click', saveCurrentAsCollection);
        d.querySelector('[data-drawer-close]')?.addEventListener('click', closeDrawer);
        d.querySelector('[data-drawer-clear]')?.addEventListener('click', async () => {
            state.filters = { arr_has: [], arr_lacks: [], stem_has: [], stem_lacks: [], lyrics: '', tunings: [] };
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
        const loaded = state.view === 'grid' ? loadGrid(true) : loadTree();
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
        const providers = await loadProviders();
        const [, tn] = await Promise.all([
            (async () => { state.accuracy = (await jget('/api/stats/best')) || {}; })(),
            jget('/api/library/tuning-names?provider=' + enc(state.provider)),
            loadArtistCatalog(),
        ]);
        state.tuningNames = (tn && tn.tunings) || [];

        const opt = (arr, sel) => arr.map(([v, l]) => '<option value="' + esc(v) + '"' + (v === sel ? ' selected' : '') + '>' + esc(l) + '</option>').join('');
        const provOpts = providers.map((p) => '<option value="' + esc(p.id) + '"' + (p.id === state.provider ? ' selected' : '') + '>' + esc(p.label || p.id) + '</option>').join('');
        const ctrl = btnCtrl;

        root.innerHTML =
            '<div class="max-w-7xl mx-auto px-6 md:px-8 pb-8">' +
            '<div id="v3-songs-toolbar" class="sticky z-20 -mx-6 md:-mx-8 px-6 md:px-8 py-3 mb-4 bg-fb-sidebar/95 backdrop-blur border-b border-fb-border/40">' +
            '<div class="flex flex-col md:flex-row md:items-end justify-between gap-4">' +
            '<div><p class="text-fb-textDim text-sm" id="v3-songs-count"></p></div>' +
            '<div class="flex flex-wrap gap-2">' +
            (providers.length > 1 ? '<select id="v3-songs-provider" class="' + ctrl + '">' + provOpts + '</select>' : '') +
            '<select id="v3-songs-artist" class="' + ctrl + ' max-w-[11rem]" aria-label="Artist">' + artistSelectHtml() + '</select>' +
            '<select id="v3-songs-album" class="' + ctrl + ' max-w-[11rem]" aria-label="Album"' + (state.artist ? '' : ' disabled') + '>' + albumSelectHtml() + '</select>' +
            '<div class="flex rounded-md overflow-hidden border border-gray-700"><button id="v3-songs-grid-btn" class="px-3 py-2 text-sm">▦</button><button id="v3-songs-tree-btn" class="px-3 py-2 text-sm">≣</button><button id="v3-songs-folder-btn" class="px-3 py-2 text-sm" style="display:inline-flex;align-items:center;justify-content:center;box-sizing:border-box;width:2.25rem"><svg fill="currentColor" viewBox="0 0 16 16" style="width:12px;height:12px;flex-shrink:0"><path d="M1 3.5A1.5 1.5 0 012.5 2h3.086a1.5 1.5 0 011.06.44l.915.914H13.5A1.5 1.5 0 0115 4.914V12.5a1.5 1.5 0 01-1.5 1.5h-11A1.5 1.5 0 011 12.5v-9z"/></svg></button></div>' +
            '<select id="v3-songs-sort" class="' + ctrl + '">' + opt(SORTS, state.sort) + '</select>' +
            '<select id="v3-songs-format" class="' + ctrl + '">' + opt(FORMATS, state.format) + '</select>' +
            '<button id="v3-songs-filters" class="relative ' + ctrl + ' flex items-center gap-2">Filters<span id="v3-songs-filter-count" class="hidden bg-fb-primary text-white text-xs rounded-full px-1.5">0</span></button>' +
            '<button id="v3-songs-select" class="' + ctrl + (state.selectMode ? ' bg-fb-primary text-white' : '') + '">Select</button>' +
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
        byId('v3-songs-upload').addEventListener('click', () => {
            const legacy = document.getElementById('upload-songs-file');
            // Upload targets the LOCAL library + scan; watchUploadScan refreshes
            // the grid for the local provider. Uploading while browsing a remote
            // provider won't surface the new local songs — switching the grid to
            // local on upload is a P23 remote-provider follow-up.
            if (legacy) { legacy.click(); watchUploadScan(); }
        });
        byId('v3-songs-select').addEventListener('click', () => setSelectMode(!state.selectMode));

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
            if (v === 'folder') await _ensureFolderLibrary();
            return reload();
        };
        byId('v3-songs-grid-btn').addEventListener('click', () => setView('grid'));
        byId('v3-songs-tree-btn').addEventListener('click', () => setView('tree'));
        byId('v3-songs-folder-btn').addEventListener('click', () => setView('folder'));
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
    }
})();
