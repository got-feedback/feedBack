/*
 * fee[dB]ack v0.3.0 — Playlists + Saved for Later screens.
 *
 * Vanilla JS (constitution P-II). Core REST (/api/playlists, /api/saved/*),
 * no capability domain. Renders #v3-playlists (list + detail with drag-
 * reorder) and #v3-saved (the reserved system playlist). Exposes
 * window.v3Saved.toggle(filename) for the "Save for later" affordance on song
 * cards/rows (used by the library/dashboard).
 */
(function () {
    'use strict';
    const sm = window.feedBack;

    const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => (
        { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

    // Return null (don't throw) on a network/connection failure so a fetch
    // rejection can't abort rendering — matches the "degrades gracefully"
    // contract and the other v3 modules' jget/jsend.
    async function jget(u) { try { const r = await fetch(u); return r.ok ? r.json() : null; } catch (e) { return null; } }
    async function jsend(method, u, body) {
        try {
            const r = await fetch(u, {
                method, headers: { 'Content-Type': 'application/json' },
                body: body == null ? undefined : JSON.stringify(body),
            });
            return r.ok ? r.json() : null;
        } catch (e) { return null; }
    }

    function songRow(s, opts) {
        opts = opts || {};
        const handle = opts.draggable
            ? '<span class="cursor-grab text-fb-textDim/60 px-1" title="Drag to reorder">⠿</span>' : '';
        const tuning = s.tuning_name
            ? '<span class="ml-2 text-[10px] bg-fb-mid text-black font-bold px-1.5 py-0.5 rounded-sm">' + esc(s.tuning_name) + '</span>' : '';
        return '<li data-fn="' + esc(s.filename) + '"' + (opts.draggable ? ' draggable="true"' : '') +
            ' class="flex items-center gap-3 px-3 py-2 rounded-lg hover:bg-fb-card/50 group">' +
            handle +
            '<img src="' + esc(s.art_url) + '" alt="" class="w-10 h-10 rounded object-cover bg-fb-card" onerror="this.style.visibility=\'hidden\'">' +
            '<span class="flex-1 min-w-0"><span class="block text-sm text-fb-text truncate">' + esc(s.title) + tuning + '</span>' +
            '<span class="block text-xs text-fb-textDim truncate">' + esc(s.artist) + '</span></span>' +
            '<button data-v3-play aria-label="Play" class="opacity-0 group-hover:opacity-100 text-fb-primary hover:text-fb-primaryHi text-sm px-2" title="Play">▶</button>' +
            '<button data-remove aria-label="Remove from playlist" class="opacity-0 group-hover:opacity-100 text-fb-textDim hover:text-fb-accent text-sm px-2" title="Remove">✕</button>' +
            '</li>';
    }

    function wireSongRows(listEl, pid, onChange) {
        listEl.querySelectorAll('li[data-fn]').forEach((li) => {
            const fn = li.getAttribute('data-fn');
            li.querySelector('[data-v3-play]')?.addEventListener('click', () => {
                // playSong decodeURIComponent()s its arg for the highway WS, so
                // pass an encoded filename (like the rest of v3) — a raw name
                // with %/#/?/ in it would otherwise misroute or throw.
                if (typeof window.playSong === 'function') window.playSong(encodeURIComponent(fn));
            });
            li.querySelector('[data-remove]')?.addEventListener('click', async () => {
                await fetch('/api/playlists/' + pid + '/songs/' + encodeURIComponent(fn), { method: 'DELETE' });
                onChange();
            });
        });
        // Drag-reorder.
        let dragEl = null;
        listEl.querySelectorAll('li[draggable="true"]').forEach((li) => {
            li.addEventListener('dragstart', () => { dragEl = li; li.classList.add('opacity-50'); });
            li.addEventListener('dragend', () => { li.classList.remove('opacity-50'); });
            li.addEventListener('dragover', (e) => {
                e.preventDefault();
                if (!dragEl || dragEl === li) return;
                const rect = li.getBoundingClientRect();
                const after = (e.clientY - rect.top) > rect.height / 2;
                li.parentNode.insertBefore(dragEl, after ? li.nextSibling : li);
            });
            li.addEventListener('drop', async (e) => {
                e.preventDefault();
                const order = Array.from(listEl.querySelectorAll('li[data-fn]')).map((x) => x.getAttribute('data-fn'));
                await jsend('POST', '/api/playlists/' + pid + '/reorder', { order });
                // Re-sync from the server: if /reorder was rejected (concurrent
                // change) or the request failed, the optimistic DOM order would
                // otherwise diverge from what was actually persisted.
                onChange();
            });
        });
    }

    // ── #v3-playlists ─────────────────────────────────────────────────────--
    async function renderPlaylists() {
        const root = document.getElementById('v3-playlists');
        if (!root) return;
        const lists = (await jget('/api/playlists')) || [];
        root.innerHTML =
            '<div class="max-w-5xl mx-auto px-6 md:px-8 pb-8">' +
            '<div class="flex items-center justify-end mb-6">' +
            '<button id="v3-pl-new" class="bg-fb-primary hover:bg-fb-primaryHi text-white px-4 py-2 rounded-md text-sm font-medium shadow-lg shadow-fb-primary/20">New playlist</button>' +
            '</div>' +
            (lists.length
                ? '<div class="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-4">' + lists.map((p) =>
                    '<button data-pl="' + p.id + '" class="text-left bg-fb-card/80 backdrop-blur rounded-xl p-4 border border-fb-border/50 hover:border-fb-primary/40 transition">' +
                    '<div class="w-full aspect-square rounded-lg bg-fb-bg/50 mb-3 flex items-center justify-center text-fb-textDim">' +
                    (p.system_key ? '🔖' : '🎵') + '</div>' +
                    '<div class="text-sm font-medium text-fb-text truncate">' + esc(p.name) + '</div>' +
                    '<div class="text-xs text-fb-textDim">' + p.count + ' song' + (p.count === 1 ? '' : 's') + '</div>' +
                    '</button>').join('') + '</div>'
                : '<p class="text-fb-textDim">No playlists yet. Create one to group songs.</p>') +
            '</div>';
        root.querySelector('#v3-pl-new')?.addEventListener('click', async () => {
            const name = (window.prompt('Playlist name?') || '').trim();
            if (!name) return;
            await jsend('POST', '/api/playlists', { name });
            renderPlaylists();
        });
        root.querySelectorAll('[data-pl]').forEach((b) =>
            b.addEventListener('click', () => renderPlaylistDetail(parseInt(b.getAttribute('data-pl'), 10))));
    }

    async function renderPlaylistDetail(pid) {
        const root = document.getElementById('v3-playlists');
        if (!root) return;
        const pl = await jget('/api/playlists/' + pid);
        if (!pl) { renderPlaylists(); return; }
        const isSystem = !!pl.system_key;
        root.innerHTML =
            '<div class="max-w-3xl mx-auto p-6 md:p-8">' +
            '<button id="v3-pl-back" class="text-sm text-fb-textDim hover:text-fb-text mb-4">← Playlists</button>' +
            '<div class="flex items-center justify-between mb-6 gap-3">' +
            '<h2 class="text-3xl font-bold text-fb-text truncate">' + esc(pl.name) + '</h2>' +
            (isSystem ? '' :
                '<div class="flex gap-2 shrink-0">' +
                '<button id="v3-pl-rename" class="text-sm text-fb-textDim hover:text-fb-text px-2">Rename</button>' +
                '<button id="v3-pl-delete" class="text-sm text-fb-textDim hover:text-fb-accent px-2">Delete</button></div>') +
            '</div>' +
            (pl.songs.length
                ? '<ul id="v3-pl-songs" class="space-y-1">' + pl.songs.map((s) => songRow(s, { draggable: !isSystem })).join('') + '</ul>'
                : '<p class="text-fb-textDim">Empty — add songs from the library.</p>') +
            '</div>';
        root.querySelector('#v3-pl-back')?.addEventListener('click', renderPlaylists);
        const listEl = root.querySelector('#v3-pl-songs');
        if (listEl) wireSongRows(listEl, pid, () => renderPlaylistDetail(pid));
        root.querySelector('#v3-pl-rename')?.addEventListener('click', async () => {
            const name = (window.prompt('Rename playlist', pl.name) || '').trim();
            if (!name) return;
            await jsend('PATCH', '/api/playlists/' + pid, { name });
            renderPlaylistDetail(pid);
        });
        root.querySelector('#v3-pl-delete')?.addEventListener('click', async () => {
            if (!window.confirm('Delete "' + pl.name + '"?')) return;
            await fetch('/api/playlists/' + pid, { method: 'DELETE' });
            renderPlaylists();
        });
    }

    // ── #v3-saved ─────────────────────────────────────────────────────────--
    async function renderSaved() {
        const root = document.getElementById('v3-saved');
        if (!root) return;
        const lists = (await jget('/api/playlists')) || [];
        const saved = lists.find((p) => p.system_key === 'saved_for_later');
        const pl = saved ? await jget('/api/playlists/' + saved.id) : null;
        root.innerHTML =
            '<div class="max-w-3xl mx-auto px-6 md:px-8 pb-8">' +
            (pl && pl.songs.length
                ? '<ul id="v3-saved-songs" class="space-y-1">' + pl.songs.map((s) => songRow(s, {})).join('') + '</ul>'
                : '<p class="text-fb-textDim">Nothing saved yet. Use “Save for later” on a song to add it here.</p>') +
            '</div>';
        const listEl = root.querySelector('#v3-saved-songs');
        if (listEl && pl) wireSongRows(listEl, pl.id, renderSaved);
    }

    // ── Public: Save-for-later toggle for song cards/rows ─────────────────--
    window.v3Saved = {
        toggle: async function (filename) {
            const res = await jsend('POST', '/api/saved/toggle', { filename });
            return res ? res.saved : null;
        },
    };
    window.v3Playlists = { refresh: renderPlaylists, refreshSaved: renderSaved };

    // Lazy-render when these screens are shown (data can change between visits).
    if (sm && typeof sm.on === 'function') {
        sm.on('screen:changed', (e) => {
            const id = e && e.detail && e.detail.id;
            if (id === 'v3-playlists') renderPlaylists();
            else if (id === 'v3-saved') renderSaved();
        });
    }
    function boot() { renderPlaylists(); renderSaved(); }
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot, { once: true });
    else boot();
})();
