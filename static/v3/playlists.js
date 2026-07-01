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

    // Content-dependent playlist cover: a custom uploaded cover wins; otherwise
    // the playlist's own song art — the icon when empty, one cover for a few
    // songs, a 2×2 mosaic at 4+. `art_urls` / `cover_url` come from /api/playlists.
    function playlistCoverHtml(p) {
        const box = 'w-full aspect-square rounded-lg overflow-hidden bg-fb-bg/50 mb-3';
        const img = (u, cls) => '<img src="' + esc(u) + '" alt="" class="' + cls + '" onerror="this.style.visibility=\'hidden\'">';
        if (p.cover_url) return '<div class="' + box + '">' + img(p.cover_url, 'w-full h-full object-cover') + '</div>';
        const arts = Array.isArray(p.art_urls) ? p.art_urls : [];
        if (!arts.length) {
            return '<div class="' + box + ' flex items-center justify-center text-5xl text-fb-textDim">' + (p.kind === 'album' ? '💿' : p.system_key ? '🔖' : '🎵') + '</div>';
        }
        if (arts.length < 4) return '<div class="' + box + '">' + img(arts[0], 'w-full h-full object-cover') + '</div>';
        return '<div class="' + box + ' grid grid-cols-2 grid-rows-2 gap-px">' +
            arts.slice(0, 4).map((u) => img(u, 'w-full h-full object-cover')).join('') + '</div>';
    }

    // The slot's pinned-arrangement INDEX, resolved from the stored NAME
    // against the slot's current chart (names survive rescans; an index
    // wouldn't). null = no pin / the name isn't on this chart → full song.
    function _slotArrIndex(s) {
        if (!s.arrangement || !Array.isArray(s.arrangements)) return null;
        const m = s.arrangements.find((a) => a && (a.smart_name === s.arrangement || a.name === s.arrangement));
        return (m && m.index != null) ? m.index : null;
    }

    function songRow(s, opts) {
        opts = opts || {};
        const handle = opts.draggable
            ? '<span class="cursor-grab text-fb-textDim/60 px-1" title="Drag to reorder">⠿</span>' : '';
        const tuning = s.tuning_name
            ? '<span class="ml-2 text-[0.625rem] bg-fb-mid text-black font-bold px-1.5 py-0.5 rounded-sm">' + esc(s.tuning_name) + '</span>' : '';
        // ── Curated-album slot extras (P6) — mixes/saved emit none of this ──
        // A slot plays its RESOLVED chart (data-play-fn: the pinned file, or
        // the work's current keeper when the pinned file is gone) with its
        // pinned arrangement (data-play-arr); `missing` = the whole work left
        // the library, so the row dims and loses play (denominator stays
        // honest). ▾ opens the slot editor (chart + arrangement pin).
        const isAlbum = !!opts.album;
        const missing = isAlbum && !!s.missing;
        const playFn = s.resolved_filename || s.filename;
        const arrIdx = isAlbum ? _slotArrIndex(s) : null;
        const playAttrs = isAlbum && !missing
            ? ' data-play-fn="' + esc(playFn) + '"' + (arrIdx != null ? ' data-play-arr="' + arrIdx + '"' : '')
            : '';
        const acc = (isAlbum && typeof opts.acc === 'number')
            ? '<span class="text-xs font-bold shrink-0 ' + (opts.acc >= 0.9 ? 'text-fb-good' : opts.acc >= 0.5 ? 'text-fb-mid' : 'text-fb-low') + '">' + Math.round(opts.acc * 100) + '%</span>'
            : '';
        const pin = (isAlbum && s.arrangement)
            ? '<span class="ml-2 text-[0.625rem] bg-fb-primary/20 text-fb-primary font-bold px-1.5 py-0.5 rounded-sm" title="Pinned arrangement">' + esc(s.arrangement) + '</span>' : '';
        const orphan = (isAlbum && s.resolved_from_orphan)
            ? '<span class="ml-2 text-[0.625rem] text-fb-textDim" title="The pinned chart is gone — playing this song\'s current keeper instead">(auto)</span>' : '';
        const slotBtn = (isAlbum && !missing)
            ? '<button data-slot aria-label="Choose chart / arrangement" title="Choose chart / arrangement" class="opacity-0 group-hover:opacity-100 text-fb-textDim hover:text-fb-text text-sm px-2">▾</button>' : '';
        return '<li data-fn="' + esc(s.filename) + '"' + playAttrs + (opts.draggable ? ' draggable="true"' : '') +
            ' class="flex items-center gap-3 px-3 py-2 rounded-lg hover:bg-fb-card/50 group' + (missing ? ' opacity-50' : '') + '">' +
            handle +
            '<img src="' + esc(s.art_url) + '" alt="" class="w-10 h-10 rounded object-cover bg-fb-card" onerror="this.style.visibility=\'hidden\'">' +
            '<span class="flex-1 min-w-0"><span class="block text-sm text-fb-text truncate">' + esc(s.title) + tuning + pin + orphan + '</span>' +
            '<span class="block text-xs text-fb-textDim truncate">' + (missing ? 'Missing — no version of this song is in your library' : esc(s.artist)) + '</span></span>' +
            acc +
            (missing ? '' : '<button data-v3-play aria-label="Play" class="opacity-0 group-hover:opacity-100 text-fb-primary hover:text-fb-primaryHi text-sm px-2" title="Play">▶</button>') +
            slotBtn +
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
                // Album slots override the play target (data-play-fn = the
                // orphan-resolved chart) + pass the pinned arrangement index;
                // mix/saved rows carry neither attribute and behave as before.
                const pfn = li.getAttribute('data-play-fn') || fn;
                const pa = li.getAttribute('data-play-arr');
                if (typeof window.playSong === 'function') {
                    window.playSong(encodeURIComponent(pfn), pa == null ? undefined : Number(pa));
                }
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
            '<div class="flex items-center justify-end gap-2 mb-6">' +
            // Curated album (P6): a hand-picked ORDERED set with a chosen chart
            // per track — same machinery as a playlist, kind='album'.
            '<button id="v3-pl-new-album" title="A hand-picked, ordered set of songs — your version of an album, with your chosen chart per track" class="bg-fb-card/80 hover:bg-fb-card border border-fb-border/60 text-fb-text px-4 py-2 rounded-md text-sm font-medium">💿 New album</button>' +
            '<button id="v3-pl-new" class="bg-fb-primary hover:bg-fb-primaryHi text-white px-4 py-2 rounded-md text-sm font-medium shadow-lg shadow-fb-primary/20">New playlist</button>' +
            '</div>' +
            (lists.length
                ? '<div class="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-4">' + lists.map((p) =>
                    '<button data-pl="' + p.id + '" class="text-left bg-fb-card/80 backdrop-blur rounded-xl p-4 border border-fb-border/50 hover:border-fb-primary/40 transition">' +
                    playlistCoverHtml(p) +
                    '<div class="text-sm font-medium text-fb-text truncate">' + esc(p.name) + '</div>' +
                    '<div class="text-xs text-fb-textDim">' + (p.kind === 'album' ? '💿 Album · ' : '') + p.count + ' song' + (p.count === 1 ? '' : 's') + '</div>' +
                    '</button>').join('') + '</div>'
                : '<p class="text-fb-textDim">No playlists yet. Create one to group songs.</p>') +
            '</div>';
        root.querySelector('#v3-pl-new')?.addEventListener('click', async () => {
            const name = ((await window.uiPrompt({ title: 'New Playlist', label: 'Playlist name', okLabel: 'Create', placeholder: 'My Playlist' })) || '').trim();
            if (!name) return;
            await jsend('POST', '/api/playlists', { name });
            renderPlaylists();
        });
        root.querySelector('#v3-pl-new-album')?.addEventListener('click', async () => {
            const name = ((await window.uiPrompt({ title: 'New Album', label: 'Album name', okLabel: 'Create', placeholder: 'My Album' })) || '').trim();
            if (!name) return;
            await jsend('POST', '/api/playlists', { name, kind: 'album' });
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
        const isAlbum = pl.kind === 'album';
        // Set-scoped repertoire (P6, §7.2): an album is a bounded practice SET
        // with a denominator — "N of M mastered", per-track accuracy, never one
        // album score. Same 0.9 threshold as the library meter/green badge.
        let best = {};
        if (isAlbum) best = (await jget('/api/stats/best')) || {};
        const slotAcc = (s) => best[s.resolved_filename || s.filename];
        let meter = '';
        if (isAlbum && pl.songs.length) {
            const tracks = pl.songs.filter((s) => !s.missing);
            const mastered = tracks.filter((s) => (slotAcc(s) || 0) >= 0.9).length;
            const started = tracks.filter((s) => { const b = slotAcc(s); return typeof b === 'number' && b > 0 && b < 0.9; }).length;
            const pct = tracks.length ? Math.max(0, Math.min(100, Math.round((mastered / tracks.length) * 100))) : 0;
            meter =
                '<div class="mb-6">' +
                '<div class="flex items-baseline justify-between gap-3 mb-1">' +
                '<span class="text-sm font-semibold text-fb-text">Album repertoire</span>' +
                '<span class="text-xs text-fb-textDim">' + mastered + ' of ' + tracks.length + ' mastered' +
                (started ? ' &middot; ' + started + ' in progress' : '') + '</span></div>' +
                '<div class="v3-rep-track"><div class="v3-rep-fill" style="width:' + pct + '%"></div></div>' +
                '</div>';
        }
        root.innerHTML =
            '<div class="max-w-3xl mx-auto p-6 md:p-8">' +
            '<button id="v3-pl-back" class="text-sm text-fb-textDim hover:text-fb-text mb-4">← Playlists</button>' +
            '<div class="flex items-center justify-between mb-6 gap-3">' +
            '<h2 class="text-3xl font-bold text-fb-text truncate">' + (isAlbum ? '💿 ' : '') + esc(pl.name) + '</h2>' +
            '<div class="flex gap-2 shrink-0 items-center">' +
            (pl.songs.length ? '<button id="v3-pl-playall" class="bg-fb-primary hover:bg-fb-primaryHi text-white text-sm font-medium px-4 py-2 rounded-md">▶ Play ' + (isAlbum ? 'album' : 'all') + '</button>' : '') +
            (isSystem ? '' :
                '<button id="v3-pl-cover" class="text-sm text-fb-textDim hover:text-fb-text px-2">Cover</button>' +
                (pl.cover_url ? '<button id="v3-pl-cover-rm" class="text-sm text-fb-textDim hover:text-fb-accent px-2">Remove cover</button>' : '') +
                '<button id="v3-pl-rename" class="text-sm text-fb-textDim hover:text-fb-text px-2">Rename</button>' +
                '<button id="v3-pl-delete" class="text-sm text-fb-textDim hover:text-fb-accent px-2">Delete</button>' +
                '<input type="file" id="v3-pl-cover-file" accept="image/*" class="hidden">') +
            '</div>' +
            '</div>' +
            meter +
            (pl.songs.length
                ? '<ul id="v3-pl-songs" class="space-y-1">' + pl.songs.map((s) => songRow(s, { draggable: !isSystem, album: isAlbum, acc: isAlbum ? slotAcc(s) : undefined })).join('') + '</ul>'
                : '<p class="text-fb-textDim">Empty — add songs from the library' + (isAlbum ? ' (the ⋮ menu or the batch bar\'s "Add to playlist")' : '') + '.</p>') +
            '</div>';
        root.querySelector('#v3-pl-back')?.addEventListener('click', renderPlaylists);
        // Play all: start the play-queue with this playlist's songs (auto-advances
        // track to track). Falls back to playing the first song on an older core
        // without the queue, so the button always does something. An ALBUM plays
        // each slot's resolved chart with its pinned arrangement (playQueue's
        // per-index arrangements array, #685) and skips missing works.
        root.querySelector('#v3-pl-playall')?.addEventListener('click', () => {
            const files = [], arrs = [];
            (pl.songs || []).forEach((s) => {
                if (isAlbum && s.missing) return;
                const fn = s.resolved_filename || s.filename;
                if (!fn) return;
                files.push(fn);
                const idx = isAlbum ? _slotArrIndex(s) : null;
                arrs.push(idx == null ? undefined : idx);
            });
            if (!files.length) return;
            if (window.feedBack && window.feedBack.playQueue) {
                window.feedBack.playQueue.start(files, isAlbum
                    ? { source: pl.name, arrangements: arrs }
                    : { source: pl.name });
            } else if (typeof window.playSong === 'function') window.playSong(encodeURIComponent(files[0]));
        });
        const listEl = root.querySelector('#v3-pl-songs');
        if (listEl) wireSongRows(listEl, pid, () => renderPlaylistDetail(pid));
        // Album slot editor (▾ per row): pick the slot's chart + arrangement.
        if (listEl && isAlbum) {
            listEl.querySelectorAll('li[data-fn]').forEach((li) => {
                li.querySelector('[data-slot]')?.addEventListener('click', () => {
                    const fn = li.getAttribute('data-fn');
                    const slot = (pl.songs || []).find((x) => x.filename === fn);
                    if (slot) openSlotPicker(pid, slot, () => renderPlaylistDetail(pid));
                });
            });
        }
        root.querySelector('#v3-pl-rename')?.addEventListener('click', async () => {
            const name = ((await window.uiPrompt({ title: 'Rename Playlist', label: 'Playlist name', value: pl.name, okLabel: 'Rename' })) || '').trim();
            if (!name) return;
            await jsend('PATCH', '/api/playlists/' + pid, { name });
            renderPlaylistDetail(pid);
        });
        root.querySelector('#v3-pl-delete')?.addEventListener('click', async () => {
            if (!window.confirm('Delete "' + pl.name + '"?')) return;
            await fetch('/api/playlists/' + pid, { method: 'DELETE' });
            renderPlaylists();
        });
        // Custom cover: pick an image → upload as a data URL → the playlist card
        // shows it (overriding the song-art cover). Re-render the detail so the
        // Remove-cover button appears; the grid picks up the new cover on return.
        const coverFile = root.querySelector('#v3-pl-cover-file');
        root.querySelector('#v3-pl-cover')?.addEventListener('click', () => coverFile && coverFile.click());
        coverFile?.addEventListener('change', () => {
            const f = coverFile.files && coverFile.files[0];
            if (!f) return;
            const reader = new FileReader();
            reader.onload = async (e) => {
                await jsend('POST', '/api/playlists/' + pid + '/cover', { image: e.target.result });
                renderPlaylistDetail(pid);
            };
            reader.readAsDataURL(f);
        });
        root.querySelector('#v3-pl-cover-rm')?.addEventListener('click', async () => {
            await fetch('/api/playlists/' + pid + '/cover', { method: 'DELETE' });
            renderPlaylistDetail(pid);
        });
    }

    // ── Curated-album slot editor (P6, §7.2) ─────────────────────────────────
    // Pins THIS slot's chart + arrangement. The per-slot pick is deliberately
    // independent of the work's global preferred — a rehearsed set must stay
    // the same notes even if the global keeper is re-picked later. Charts come
    // from the work-charts API; the arrangement pin is stored as a NAME (it
    // survives rescans; the index is resolved at play). A compact overlay for
    // now — unifying with the library's Charts drawer (slot-scoped mode) is a
    // follow-up once the in-flight drawer changes land.
    async function openSlotPicker(pid, slot, onChange) {
        const curFn = slot.resolved_filename || slot.filename;
        let wk = slot.work_key;
        if (!wk) {
            const w = await jget('/api/chart/' + encodeURIComponent(curFn) + '/work');
            wk = w && w.work_key;
        }
        const charts = wk ? await jget('/api/work/' + encodeURIComponent(wk) + '/charts') : null;
        const chartList = (charts && Array.isArray(charts.charts)) ? charts.charts : [];
        const radio = (name, value, checked, label, sub) =>
            '<label class="flex items-start gap-2 px-2 py-1.5 rounded hover:bg-fb-card/60 cursor-pointer">' +
            '<input type="radio" name="' + name + '" value="' + esc(value) + '"' + (checked ? ' checked' : '') + ' class="accent-fb-primary mt-0.5">' +
            '<span class="min-w-0 flex-1"><span class="block text-sm text-fb-text truncate">' + label + '</span>' +
            (sub ? '<span class="block text-[0.625rem] text-fb-textDim truncate">' + sub + '</span>' : '') +
            '</span></label>';
        // Checked = the stored pin; an orphaned slot (stored file gone from the
        // list) pre-checks the chart it currently resolves to, so Apply re-pins
        // what's actually playing.
        const slotInList = chartList.some((x) => x.filename === slot.filename);
        const chartRows = chartList.map((c) => radio(
            'slot-chart', c.filename,
            c.filename === slot.filename || (!slotInList && c.filename === curFn),
            esc(c.title) + (c.is_representative ? ' <span class="text-[0.625rem] text-fb-primary">● preferred</span>' : ''),
            esc((c.tuning_name ? c.tuning_name + ' · ' : '') + c.filename))).join('');
        const arrRows = [radio('slot-arr', '', !slot.arrangement, 'Full song <span class="text-[0.625rem] text-fb-textDim">(default)</span>', '')]
            .concat((slot.arrangements || []).map((a) => {
                const name = (a && (a.smart_name || a.name)) || '';
                if (!name) return '';
                return radio('slot-arr', name,
                    slot.arrangement === name || slot.arrangement === a.name,
                    esc(name), '');
            })).join('');
        const overlay = document.createElement('div');
        overlay.className = 'fixed inset-0 z-[200] bg-black/60 backdrop-blur-sm flex items-center justify-center p-4';
        overlay.innerHTML =
            '<div class="bg-fb-card w-full max-w-md rounded-xl border border-fb-border/60 p-5 space-y-4 max-h-[80vh] overflow-y-auto v3-scroll">' +
            '<div class="flex items-center justify-between gap-2">' +
            '<h3 class="text-lg font-semibold text-fb-text truncate">' + esc(slot.title) + '</h3>' +
            '<button type="button" data-x class="text-fb-textDim hover:text-fb-text text-xl leading-none" aria-label="Close">✕</button></div>' +
            (chartRows
                ? '<div><div class="text-xs font-semibold uppercase tracking-wider text-fb-textDim mb-1">Chart for this slot</div>' + chartRows + '</div>'
                : '') +
            '<div><div class="text-xs font-semibold uppercase tracking-wider text-fb-textDim mb-1">Arrangement</div>' + arrRows + '</div>' +
            '<div data-err class="hidden text-xs text-red-400"></div>' +
            '<div class="flex justify-end gap-2">' +
            '<button type="button" data-cancel class="text-sm text-fb-textDim hover:text-fb-text px-3 py-2">Cancel</button>' +
            '<button type="button" data-apply class="bg-fb-primary hover:bg-fb-primaryHi text-white text-sm font-medium px-5 py-2 rounded-md">Apply</button>' +
            '</div></div>';
        const onKey = (e) => { if (e.key === 'Escape') { e.preventDefault(); close(); } };
        function close() { overlay.remove(); document.removeEventListener('keydown', onKey); }
        document.addEventListener('keydown', onKey);
        overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
        overlay.querySelector('[data-x]').addEventListener('click', close);
        overlay.querySelector('[data-cancel]').addEventListener('click', close);
        overlay.querySelector('[data-apply]').addEventListener('click', async () => {
            const chart = overlay.querySelector('input[name="slot-chart"]:checked');
            const arr = overlay.querySelector('input[name="slot-arr"]:checked');
            const body = {};
            if (chart && chart.value && chart.value !== slot.filename) body.chart_filename = chart.value;
            if (arr) {
                const v = arr.value || null;
                if (v !== (slot.arrangement || null)) body.arrangement = v;
            }
            if (Object.keys(body).length) {
                // jsend → null on a non-2xx (e.g. swap-to-other-work rejected, or
                // the resolved target duplicates another slot's pin). Surfacing it
                // and keeping the picker open beats silently closing "as saved".
                const res = await jsend('PATCH', '/api/playlists/' + pid + '/songs/' + encodeURIComponent(slot.filename), body);
                if (!res) {
                    const err = overlay.querySelector('[data-err]');
                    if (err) { err.textContent = 'Could not update this slot.'; err.classList.remove('hidden'); }
                    return;   // keep the picker open — not a success
                }
            }
            close();
            onChange();
        });
        document.body.appendChild(overlay);
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
