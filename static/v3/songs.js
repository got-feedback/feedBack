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
    ];
    const FORMATS = [['', 'All formats'], ['sloppak', 'Feedpak'], ['loose', 'Folder']];
    const ARRANGEMENTS = ['Lead', 'Rhythm', 'Bass', 'Combo', 'Vocals'];
    const STEMS = ['guitar', 'bass', 'drums', 'vocals', 'other'];
    const PAGE_SIZE = 24;
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
    };

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
        const snap = {
            hash: _libraryStateHash(),
            scrollTop: main ? main.scrollTop : 0,
            view: state.view,
            page: state.page,
            loadedCount: loadedCount(),
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

    function _gridDomIntact() {
        const grid = document.getElementById('v3-songs-grid');
        return !!grid && loadedCount() > 0;
    }

    function _treeDomIntact() {
        const tree = document.getElementById('v3-songs-tree');
        if (!tree) return false;
        return !!(tree.querySelector('[data-fn]') || tree.querySelector('details'));
    }

    // Resolve once no grid fetch is in flight. loadGrid early-returns while
    // state.loading is set, so paging without waiting would silently skip a
    // page (it bumps state.page but the fetch no-ops). Bounded so a wedged
    // load can't hang the restore forever.
    async function _waitForGridIdle(maxMs) {
        const cap = (maxMs == null ? 8000 : maxMs);
        let waited = 0;
        while (state.loading && waited < cap) {
            await new Promise((r) => setTimeout(r, 16));
            waited += 16;
        }
    }

    async function _ensureGridPagesThrough(targetPage) {
        const goal = Math.max(0, Number(targetPage) || 0);
        // The initial page-0 load (or an auto-fill) may still be settling; wait
        // for the real state.total before deciding how far to page, otherwise a
        // total of 0 exits the loop immediately and the depth never restores.
        await _waitForGridIdle();
        while (state.page < goal && loadedCount() < state.total) {
            if (state.loading) { await _waitForGridIdle(); continue; }
            state.page++;
            await loadGrid(false);
        }
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
            const color = acc >= 0.9 ? 'text-fb-good' : acc >= 0.5 ? 'text-fb-mid' : 'text-fb-low';
            return '<span class="fb-acc-badge text-xs font-bold ' + color + '">' + pct + '%</span>';
        }
        const color = acc >= 0.9 ? 'bg-fb-good' : (acc >= 0.5 ? 'bg-fb-mid' : 'bg-fb-low');
        const text = acc >= 0.5 && acc < 0.9 ? 'text-black' : 'text-white';
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
        return '<div class="group relative" data-fn="' + esc(key) + '" data-library-song="' + esc(songId(song)) + '" data-library-provider="' + esc(state.provider) + '">' +
            '<div class="relative aspect-square rounded-lg overflow-hidden bg-fb-card cursor-pointer" data-v3-play>' +
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
            (arrChips ? '<div class="flex flex-wrap gap-1 mt-1">' + arrChips + '</div>' : '') +
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

    // ── Grid (paged + infinite scroll) ─────────────────────────────────────--
    async function loadGrid(reset) {
        // A reset requested mid-fetch (provider/sort/filter/search change) must
        // not be dropped — remember it and re-run once the in-flight load
        // returns, otherwise the stale response repopulates the grid.
        if (state.loading) { if (reset) state.pendingReset = true; return; }
        const grid = document.getElementById('v3-songs-grid');
        if (!grid) return;
        // A reset wipes the grid (and any open card menu's DOM); close the menu
        // first so its document-level click closer doesn't leak.
        if (reset) { if (_closeCardMenu) _closeCardMenu(); state.page = 0; state.total = 0; grid.innerHTML = ''; }
        state.loading = true;
        const data = await jget('/api/library?' + queryParams({ page: state.page, size: PAGE_SIZE }).toString());
        state.loading = false;
        if (state.pendingReset) { state.pendingReset = false; return loadGrid(true); }
        if (!data) return;
        state.total = data.total || 0;
        (data.songs || []).forEach((s) => { state.songsById[cardKey(s)] = s; grid.insertAdjacentHTML('beforeend', songCard(s)); });
        wireCards(grid);
        const countEl = document.getElementById('v3-songs-count');
        if (countEl) countEl.textContent = state.total + ' song' + (state.total === 1 ? '' : 's');
        const loaded = grid.querySelectorAll('[data-fn]').length;
        const sentinel = document.getElementById('v3-songs-sentinel');
        if (sentinel) sentinel.style.display = loaded < state.total ? 'block' : 'none';
        // Auto-fill: if the grid doesn't yet overflow the scroller, keep loading
        // (so a short first page still becomes scrollable without user action).
        maybeFill();
    }

    function loadedCount() { return document.querySelectorAll('#v3-songs-grid [data-fn]').length; }

    // The scroll listener lives on the SHARED #v3-main container, so guard every
    // paging entry point on the Songs screen actually being active — otherwise
    // scrolling another screen would keep fetching /api/library into the hidden
    // grid after Songs has been visited once.
    function songsActive() { const el = document.getElementById('v3-songs'); return !!el && el.classList.contains('active'); }

    function loadNext() {
        if (state.loading || state.view !== 'grid' || !songsActive()) return;
        if (loadedCount() < state.total) { state.page++; loadGrid(false); }
    }

    function maybeFill() {
        const main = document.getElementById('v3-main');
        if (!main || state.view !== 'grid' || state.loading || !songsActive()) return;
        // Not tall enough to scroll yet, and more remain → pull the next page.
        if (main.scrollHeight <= main.clientHeight + 80 && loadedCount() < state.total) loadNext();
    }

    // Robust infinite scroll: a scroll listener on the real scroll container
    // (#v3-main), bound once. Avoids the IntersectionObserver "already in view
    // at observe-time" race that stuck the grid on page 0.
    function bindScroll() {
        const main = document.getElementById('v3-main');
        if (!main || state.scrollBound) return;
        state.scrollBound = true;
        main.addEventListener('scroll', () => {
            if (state.view !== 'grid' || state.loading) return;
            if (main.scrollTop + main.clientHeight >= main.scrollHeight - 600) loadNext();
        }, { passive: true });
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
        // Keep a handle on the load so callers (notably the scroll restore on
        // screen re-entry) can await page-0 actually landing before paging
        // deeper. The visibility/scroll resets below stay synchronous.
        document.getElementById('v3-songs-grid')?.classList.toggle('hidden', state.view !== 'grid');
        document.getElementById('v3-songs-tree')?.classList.toggle('hidden', state.view !== 'tree');
        document.getElementById('lib-folder-tree')?.classList.toggle('hidden', state.view !== 'folder');
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
            '<div id="v3-songs-grid" class="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-6 gap-4"></div>' +
            '<div id="v3-songs-tree" class="hidden"></div>' +
            '<div id="lib-folder-controls" style="display:none"></div>' +
            '<div id="lib-folder-tree" class="space-y-1 hidden"></div>' +
            '<div id="v3-songs-sentinel" class="h-8"></div>' +
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
                if ((snap.page || 0) > state.page || (snap.loadedCount || 0) > loadedCount()) {
                    await _ensureGridPagesThrough(snap.page || 0);
                }
                document.getElementById('v3-songs-grid')?.classList.toggle('hidden', false);
                document.getElementById('v3-songs-tree')?.classList.toggle('hidden', true);
                syncChromeFromState();
                _applyMainScrollTop(snap.scrollTop || 0);
                _clearLibraryScrollSnapshot();
                return;
            }
            if (state.view === 'tree' && _treeDomIntact()) {
                document.getElementById('v3-songs-grid')?.classList.toggle('hidden', true);
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
            document.getElementById('v3-songs-grid')?.classList.toggle('hidden', state.view !== 'grid');
            document.getElementById('v3-songs-tree')?.classList.toggle('hidden', state.view !== 'tree');
            document.getElementById('lib-folder-tree')?.classList.toggle('hidden', state.view !== 'folder');
            { const _fc = document.getElementById('lib-folder-controls'); if (_fc) _fc.style.display = state.view === 'folder' ? 'flex' : 'none'; }
            return;
        }

        const snapToRestore = hashMatch ? snap : null;
        if (snap && !hashMatch) _clearLibraryScrollSnapshot();
        await render();
        if (snapToRestore && snapToRestore.hash === _libraryStateHash()) {
            if (state.view === 'grid') await _ensureGridPagesThrough(snapToRestore.page || 0);
            _applyMainScrollTop(snapToRestore.scrollTop || 0);
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
